// test-baseline-restore.js — regression test for #88 (baseline restore endpoint).
//
// Baselines snapshot the full design at lock time (#61) and compare works, but there was
// no way BACK — versioning stopped one step short of recovery. POST /baselines/:id/restore
// closes the loop non-destructively: it diffs the snapshot against the live design and
// creates a reviewable Change Packet of `.restore` items (applied column-verbatim on
// approval — no field-transform double-wrapping); records missing/added since the baseline
// are reported for the human, never auto-recreated or auto-retired.
//
// Run:  node test-baseline-restore.js   (from backend-node/)
'use strict';
const path = require('path');
const os   = require('os');

process.env.ASDLC_DB_PATH = path.join(os.tmpdir(), `asdlc_restore_${Date.now()}.db`);
process.env.PORT = String(8700 + Math.floor(Math.random() * 600));
process.env.ANTHROPIC_API_KEY = '';

const base = __dirname;
require(path.join(base, 'server.js'));
const { db, generateId } = require(path.join(base, 'db'));

const BASEURL = `http://127.0.0.1:${process.env.PORT}/api/v1`;
const HEADERS = { 'Content-Type': 'application/json', 'X-User-ID': 'test-restore' };

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { console.log('  ok  -', m); pass++; } else { console.error('  FAIL-', m); fail++; } };
function done(code) { try { db.close(); } catch { /* ignore */ } process.exit(code); }

async function call(method, p, body) {
  const r = await fetch(BASEURL + p, { method, headers: HEADERS, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, j };
}

async function main() {
  await new Promise(r => setTimeout(r, 900));

  const client = db.prepare('SELECT client_id FROM asdlc_client LIMIT 1').get();
  const pid = generateId();
  db.prepare(`INSERT INTO asdlc_project (project_id, client_id, project_name, project_code) VALUES (?,?,?,?)`)
    .run(pid, client.client_id, 'Restore Test', 'RST');
  const toolId = generateId();
  db.prepare(`INSERT INTO asdlc_tool (tool_id, project_id, name, contract, cost_impact) VALUES (?,?,?,?,?)`)
    .run(toolId, pid, 'Restore Tool', '{"text":"baseline contract v1"}', 'low');

  // Create + lock a baseline (lock takes the snapshot).
  let r = await call('POST', '/baselines', { project_id: pid, baseline_name: 'Golden v1' });
  const baselineId = r.j.baseline_id;
  assert(r.status === 201 && baselineId, 'baseline created');
  r = await call('POST', `/baselines/${baselineId}/lock`, {});
  assert(r.ok && r.j.record_count >= 1, `lock snapshotted the design (${r.j.record_count} records)`);

  // Drift the design after the baseline: mutate the tool + add a brand-new tool.
  db.prepare(`UPDATE asdlc_tool SET contract='{"text":"drifted v2"}', cost_impact='high', updated_at=datetime('now') WHERE tool_id=?`).run(toolId);
  const newToolId = generateId();
  db.prepare(`INSERT INTO asdlc_tool (tool_id, project_id, name, contract) VALUES (?,?,?,?)`)
    .run(newToolId, pid, 'Post-Baseline Tool', '{"text":"new since baseline"}');

  console.log('\n--- dry run: plan only, no writes ---');
  const cpsBefore = db.prepare('SELECT COUNT(*) c FROM asdlc_change_packet WHERE project_id=?').get(pid).c;
  r = await call('POST', `/baselines/${baselineId}/restore?dry_run=1`);
  assert(r.ok && r.j.dry_run === true, 'dry run returns a plan');
  assert(r.j.plan.restore_updates === 1, 'plan: exactly the drifted tool needs restoring');
  const upd = r.j.plan.updates[0];
  assert(upd.entity_id === toolId && upd.cols.contract && upd.cols.cost_impact, 'plan lists the drifted columns (contract + cost_impact)');
  assert(r.j.plan.added_since_baseline.some(a => a.entity_id === newToolId), 'post-baseline record REPORTED as added (never auto-retired)');
  assert(db.prepare('SELECT COUNT(*) c FROM asdlc_change_packet WHERE project_id=?').get(pid).c === cpsBefore, 'dry run wrote nothing');

  console.log('\n--- real run: restore-as-CP, applied only on approval ---');
  r = await call('POST', `/baselines/${baselineId}/restore`);
  assert(r.status === 201 && r.j.change_packet && r.j.item_count === 1, 'restore packet created (pending_review, 1 item)');
  const cpId = r.j.change_packet.change_packet_id;
  let tool = db.prepare('SELECT contract, cost_impact FROM asdlc_tool WHERE tool_id=?').get(toolId);
  assert(tool.contract === '{"text":"drifted v2"}', 'design untouched until a human approves');

  r = await call('POST', `/change-packets/${cpId}/approve`, {});
  assert(r.ok, `whole-CP approve → ${r.status}`);
  tool = db.prepare('SELECT contract, cost_impact FROM asdlc_tool WHERE tool_id=?').get(toolId);
  assert(tool.contract === '{"text":"baseline contract v1"}',
         'contract restored VERBATIM (no field-transform double-wrap)');
  assert(tool.cost_impact === 'low', 'cost_impact restored');
  const survivor = db.prepare('SELECT name FROM asdlc_tool WHERE tool_id=?').get(newToolId);
  assert(survivor && survivor.name === 'Post-Baseline Tool', 'post-baseline record untouched (restore is not a purge)');
  const audit = db.prepare("SELECT COUNT(*) c FROM asdlc_audit_log WHERE record_id=? AND operation='RESTORE'").get(toolId).c;
  assert(audit === 1, 'restore audited as RESTORE');

  console.log('\n--- idempotency + guards ---');
  r = await call('POST', `/baselines/${baselineId}/restore?dry_run=1`);
  assert(r.j.plan.restore_updates === 0, 'after apply, a re-run plan shows nothing left to restore');
  r = await call('POST', `/baselines/${baselineId}/restore`);
  assert(r.ok && r.j.dry_run === true && r.j.plan.restore_updates === 0, 'real run with nothing to restore creates NO packet');
  const unlocked = await call('POST', '/baselines', { project_id: pid, baseline_name: 'Unlocked' });
  r = await call('POST', `/baselines/${unlocked.j.baseline_id}/restore`);
  assert(r.status === 409, 'unlocked baseline (no snapshot) → 409');

  console.log(`\n=== test-baseline-restore: ${pass} passed, ${fail} failed ===`);
  done(fail ? 1 : 0);
}

main().catch(err => { console.error('FATAL', err); done(1); });
