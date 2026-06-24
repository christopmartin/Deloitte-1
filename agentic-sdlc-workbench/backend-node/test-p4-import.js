// test-p4-import.js — P4: from-scratch import + re-import safety + dry-run pre-flight.
// Fully offline (no ANTHROPIC_API_KEY → the Opus stages stub). Drives the real
// POST /projects/:id/servicenow/sync endpoint with pre-supplied `artifacts`.
//
// Proves:
//   1. Dry-run returns a human pre-flight summary with correct new/design/artifact counts.
//   2. A WHOLLY-EMPTY project imports completely: a Tier-A design row (tool) lands with
//      provenance AND Tier-C platform artifacts (ACL, role) land in asdlc_sn_artifact.
//   3. Re-importing the SAME capture is idempotent — everything classifies unchanged, with
//      NO duplicate rows and NO overwrite (the non-destructive re-sync guarantee).
//
// Run:  node test-p4-import.js   (from backend-node/)
'use strict';
const path = require('path');
const os   = require('os');

process.env.ASDLC_DB_PATH = path.join(os.tmpdir(), `asdlc_p4_${Date.now()}.db`);
process.env.PORT = String(9400 + Math.floor(Math.random() * 500));
process.env.ANTHROPIC_API_KEY = '';

const base = __dirname;
require(path.join(base, 'server.js'));
const { db, generateId } = require(path.join(base, 'db'));
const { hashArtifact } = require(path.join(base, 'agent', 'sn-capture'));

const BASEURL = `http://127.0.0.1:${process.env.PORT}/api/v1`;
const HEADERS = { 'Content-Type': 'application/json', 'X-User-ID': 'test-p4' };
const SCOPE = 'x_test_p4';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { console.log('  ok  -', m); pass++; } else { console.error('  FAIL-', m); fail++; } };
function done(code) { try { db.close(); } catch { /* ignore */ } process.exit(code); }

async function post(p, body) {
  const r = await fetch(BASEURL + p, { method: 'POST', headers: HEADERS, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`POST ${p} -> ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

function toolArtifact(sysId, name, desc) {
  const salient = { name, type: 'action', description: desc };
  return { source_table: 'sn_aia_tool', design_type: 'tool', source_sys_id: sysId, name, salient, hash: hashArtifact(salient) };
}
// Tier-C generic (platform) artifact — no rich L1 mapping; lands in asdlc_sn_artifact.
function genericArtifact(table, type, sysId, name, fields) {
  const payload = { name, ...(fields || {}) };
  return { source_table: table, design_type: type, sn_metadata_type: type, tier: 'C', generic: true,
           source_sys_id: sysId, name, salient: payload, payload, hash: hashArtifact(payload) };
}

async function main() {
  await new Promise(r => setTimeout(r, 900));   // let app.listen bind

  // A WHOLLY-EMPTY ServiceNow-linked project (no design rows yet).
  const client = db.prepare('SELECT client_id FROM asdlc_client LIMIT 1').get();
  const pid = generateId();
  db.prepare(`INSERT INTO asdlc_project (project_id, client_id, project_name, project_code, servicenow_scope, servicenow_instance, confidence_threshold)
              VALUES (?,?,?,?,?,?,?)`).run(pid, client.client_id, 'P4 Import Test', 'P4IMP', SCOPE, 'https://example.service-now.com', 0.75);

  const tool = toolArtifact('sysTOOL', 'Invoice Lookup', 'a net-new tool only in ServiceNow');
  const acl  = genericArtifact('sys_security_acl', 'acl',       'sysACL',  'incident.read', { operation: 'read' });
  const role = genericArtifact('sys_user_role',    'role',      'sysROLE', 'x_app.admin',   { description: 'app admin' });
  const artifacts = [tool, acl, role];

  console.log('\n--- 1. Dry-run pre-flight summary ---');
  const cpsBefore = db.prepare('SELECT COUNT(*) c FROM asdlc_change_packet WHERE project_id=?').get(pid).c;
  const dry = await post(`/projects/${pid}/servicenow/sync?dry_run=1`, { artifacts, threshold: 0 });
  const pf = dry.plan && dry.plan.preflight;
  console.log('  preflight:', pf && pf.text);
  assert(dry.dry_run === true && pf, 'dry-run returns a preflight summary');
  assert(pf.new === 3, 'preflight: 3 net-new items');
  assert(pf.new_design === 1 && pf.new_artifacts === 2, 'preflight splits 1 design (tool) vs 2 platform artifacts (acl, role)');
  assert(pf.conflicts_to_review === 0, 'preflight: 0 conflicts to review (all safe additive)');
  assert(typeof pf.text === 'string' && /new/.test(pf.text), 'preflight has a human-readable text line');
  assert(db.prepare('SELECT COUNT(*) c FROM asdlc_change_packet WHERE project_id=?').get(pid).c === cpsBefore, 'dry-run wrote nothing');

  console.log('\n--- 2. From-scratch import (empty → complete) ---');
  const run1 = await post(`/projects/${pid}/servicenow/sync`, { artifacts, threshold: 0 });
  assert(run1.result.auto_cp && run1.result.auto_cp.apply_result.applied >= 3, 'auto packet applied all 3 net-new items');

  const toolRow = db.prepare("SELECT * FROM asdlc_tool WHERE project_id=? AND source_sys_id='sysTOOL'").get(pid);
  assert(toolRow && toolRow.name === 'Invoice Lookup', 'Tier-A design row (tool) materialized');
  assert(toolRow && toolRow.source_hash === tool.hash && toolRow.source_system === 'servicenow', 'tool stamped with provenance (sys_id hash + source_system)');

  const arts = db.prepare("SELECT source_sys_id, source_hash, source_table, sn_metadata_type FROM asdlc_sn_artifact WHERE project_id=? ORDER BY source_sys_id").all(pid);
  console.log('  generic artifacts materialized:', arts.length);
  assert(arts.length === 2, 'both Tier-C platform artifacts landed in asdlc_sn_artifact (no twin for non-Tier-A tool)');
  const aclRow = arts.find(a => a.source_sys_id === 'sysACL');
  assert(aclRow && aclRow.source_hash === acl.hash && aclRow.source_table === 'sys_security_acl', 'ACL artifact carries source_sys_id hash + source_table provenance');
  assert(arts.every(a => a.source_hash), 'every platform artifact stored its source_hash (re-sync will detect unchanged)');

  console.log('\n--- 3. Re-import is idempotent (no overwrite, no duplicates) ---');
  const artCountBefore = db.prepare('SELECT COUNT(*) c FROM asdlc_sn_artifact WHERE project_id=?').get(pid).c;
  const toolCountBefore = db.prepare('SELECT COUNT(*) c FROM asdlc_tool WHERE project_id=?').get(pid).c;
  const run2 = await post(`/projects/${pid}/servicenow/sync`, { artifacts, threshold: 0 });
  assert(!run2.result.auto_cp && !run2.result.hitl_cp, 're-sync of identical capture: nothing to apply');
  assert(run2.plan.classified_summary.unchanged === 3 && run2.plan.classified_summary.new === 0,
         're-sync: all 3 classify as unchanged (source_hash persisted across Tier-A + Tier-C)');
  assert(db.prepare('SELECT COUNT(*) c FROM asdlc_sn_artifact WHERE project_id=?').get(pid).c === artCountBefore, 'no duplicate platform artifacts on re-import');
  assert(db.prepare('SELECT COUNT(*) c FROM asdlc_tool WHERE project_id=?').get(pid).c === toolCountBefore, 'no duplicate design rows on re-import');
  assert(run2.plan.preflight.unchanged === 3, 'preflight on re-sync reports 3 unchanged (skipped)');

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  done(fail ? 1 : 0);
}

main().catch(e => { console.error('TEST ERROR', e); done(1); });
