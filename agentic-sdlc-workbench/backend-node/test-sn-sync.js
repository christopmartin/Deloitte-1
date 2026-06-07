// test-sn-sync.js — Phase F (sync orchestrator + GATE) test.
// Two parts, both fully offline (no ANTHROPIC_API_KEY → the 3 Opus agents stub):
//   1. gateProposal() decision matrix — the pure non-destructive/confidence/mode gate.
//   2. End-to-end over the real POST /projects/:id/servicenow/sync endpoint, driven
//      with pre-supplied `artifacts` (skips the live REST capture). Asserts: safe
//      additive `new` auto-creates with source_hash stored; a high threshold routes the
//      same change to a pending_review HITL packet instead; a `changed`→no_change row
//      gets its source_hash advanced (so the NEXT sync sees it as tier-0 unchanged);
//      an unchanged artifact is skipped; and ?dry_run=1 writes nothing.
//
// Run:  node test-sn-sync.js   (from backend-node/)
'use strict';
const path = require('path');
const os   = require('os');

process.env.ASDLC_DB_PATH = path.join(os.tmpdir(), `asdlc_snsync_${Date.now()}.db`);
process.env.PORT = String(8700 + Math.floor(Math.random() * 600));
process.env.ANTHROPIC_API_KEY = '';   // stub mode — deterministic + free

const base = __dirname;
require(path.join(base, 'server.js'));                        // boots + seeds + listens
const { db, generateId } = require(path.join(base, 'db'));
const { hashArtifact } = require(path.join(base, 'agent', 'sn-capture'));
const snSync = require(path.join(base, 'agent', 'sn-sync'));
const registry = require(path.join(base, 'agent', 'entity-registry'));

const BASEURL = `http://127.0.0.1:${process.env.PORT}/api/v1`;
const HEADERS = { 'Content-Type': 'application/json', 'X-User-ID': 'test-sn-sync' };
const SCOPE = 'x_test_sync';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { console.log('  ok  -', m); pass++; } else { console.error('  FAIL-', m); fail++; } };
function done(code) { try { db.close(); } catch { /* ignore */ } process.exit(code); }

async function post(p, body) {
  const r = await fetch(BASEURL + p, { method: 'POST', headers: HEADERS, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`POST ${p} -> ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

// Build a captureScope-shaped artifact for a tool.
function toolArtifact(sysId, name, desc) {
  const salient = { name, type: 'action', description: desc };
  return { source_table: 'sn_aia_tool', design_type: 'tool', source_sys_id: sysId, name, salient, hash: hashArtifact(salient) };
}

function testGateMatrix() {
  console.log('\n--- Part 1: gateProposal() decision matrix ---');
  const g = (cls, proposal, review, opts) => snSync.gateProposal({ classification: cls, proposal, review }, opts);
  const T = { mode: 'additive_hitl', threshold: 0.75 };

  // Safe additive create, approved, confident → auto.
  let d = g('new', { action: 'create', destructive: false }, { verdict: 'approve', destructive_confirmed: false, final_confidence: 0.9 }, T);
  assert(d.target === 'auto' && d.auto_apply, 'create · approve · conf≥thr · non-destructive → auto');

  // Destructive → HITL even if approved/confident.
  d = g('changed', { action: 'enrich', destructive: true }, { verdict: 'approve', destructive_confirmed: false, final_confidence: 0.95 }, T);
  assert(d.target === 'hitl' && !d.auto_apply, 'destructive proposal → HITL (hard floor)');

  // destructive_confirmed by reviewer → HITL.
  d = g('changed', { action: 'enrich', destructive: false, field_changes: [{ field: 'contract', change_kind: 'fill_blank' }] },
        { verdict: 'approve', destructive_confirmed: true, final_confidence: 0.95 }, T);
  assert(d.target === 'hitl', 'reviewer destructive_confirmed → HITL');

  // Verdict not approve → HITL.
  d = g('changed', { action: 'enrich', destructive: false }, { verdict: 'downgrade_to_hitl', final_confidence: 0.95 }, T);
  assert(d.target === 'hitl', 'verdict != approve → HITL');

  // Below threshold → HITL.
  d = g('new', { action: 'create', destructive: false }, { verdict: 'approve', destructive_confirmed: false, final_confidence: 0.5 }, T);
  assert(d.target === 'hitl' && /confidence/.test(d.reason), 'confidence < threshold → HITL');

  // enrich with append (touches populated content) → HITL even though non-destructive+approved.
  d = g('changed', { action: 'enrich', destructive: false, field_changes: [{ field: 'inputs', change_kind: 'append' }] },
        { verdict: 'approve', destructive_confirmed: false, final_confidence: 0.95 }, T);
  assert(d.target === 'hitl' && /append/.test(d.reason), 'enrich w/ append → HITL (only fill_blank auto-applies)');

  // enrich all fill_blank → auto.
  d = g('changed', { action: 'enrich', destructive: false, field_changes: [{ field: 'cost_impact', change_kind: 'fill_blank' }] },
        { verdict: 'approve', destructive_confirmed: false, final_confidence: 0.9 }, T);
  assert(d.target === 'auto', 'enrich w/ only fill_blank → auto');

  // review_all forces HITL even for a perfectly safe additive change.
  d = g('new', { action: 'create', destructive: false }, { verdict: 'approve', destructive_confirmed: false, final_confidence: 0.99 },
        { mode: 'review_all', threshold: 0.5 });
  assert(d.target === 'hitl' && /review_all/.test(d.reason), 'mode=review_all → everything HITL');

  // drift never auto-applies (and never deletes).
  d = g('drift', { action: 'flag_drift', destructive: false }, { verdict: 'approve', final_confidence: 1 }, { mode: 'confidence_gate', threshold: 0 });
  assert(d.target === 'hitl' && /drift/.test(d.reason), 'drift → HITL flag, never auto-applied/deleted');

  // no_change → nothing to do.
  d = g('changed', { action: 'no_change', destructive: false }, { verdict: 'approve', final_confidence: 0.9 }, T);
  assert(d.target === 'none', 'no_change → none (nothing to record)');

  // confidence_gate auto-applies a safe change at/above threshold.
  d = g('new', { action: 'create', destructive: false }, { verdict: 'approve', destructive_confirmed: false, final_confidence: 0.8 },
        { mode: 'confidence_gate', threshold: 0.8 });
  assert(d.target === 'auto', 'confidence_gate · conf==threshold → auto');
}

async function main() {
  await new Promise(r => setTimeout(r, 900));   // let app.listen bind

  // Registry fix: source_hash is materializable (so apply can store it) but stays out
  // of the model-facing tool schema.
  console.log('\n--- Registry: source_hash provenance ---');
  assert(registry.byEntityType.tool.fieldMap.source_hash &&
         registry.byEntityType.tool.fieldMap.source_hash.col === 'source_hash',
         'tool.fieldMap maps source_hash → column (materializer can store it)');
  assert(!registry.buildApiTools().find(t => t.name === 'extract_tool').input_schema.properties.source_hash,
         'source_hash is NOT in the model-facing extract_tool schema');

  testGateMatrix();

  console.log('\n--- Part 2: /servicenow/sync end-to-end (stub mode) ---');
  // SN-linked project (uses a seeded client).
  const client = db.prepare('SELECT client_id FROM asdlc_client LIMIT 1').get();
  const pid = generateId();
  db.prepare(`INSERT INTO asdlc_project (project_id, client_id, project_name, project_code, servicenow_scope, servicenow_instance, confidence_threshold)
              VALUES (?,?,?,?,?,?,?)`).run(pid, client.client_id, 'SN Sync Test', 'SNSYNC', SCOPE, 'https://example.service-now.com', 0.75);

  // Existing tool that will be 'changed' (stale hash) and one that will be 'unchanged'.
  const chgArt = toolArtifact('sysCHG', 'Existing Tool', 'updated description from ServiceNow');
  const unchArt = toolArtifact('sysUNCH', 'Stable Tool', 'unchanged description');
  const chgId = generateId(), unchId = generateId();
  db.prepare(`INSERT INTO asdlc_tool (tool_id, project_id, name, contract, source_system, source_sys_id, source_table, source_hash)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(chgId, pid, 'Existing Tool', '{"text":"rich existing contract"}', 'servicenow', 'sysCHG', 'sn_aia_tool', 'STALEHASH');
  db.prepare(`INSERT INTO asdlc_tool (tool_id, project_id, name, contract, source_system, source_sys_id, source_table, source_hash)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(unchId, pid, 'Stable Tool', '{"text":"stable"}', 'servicenow', 'sysUNCH', 'sn_aia_tool', unchArt.hash);

  const newArt = toolArtifact('sysNEW', 'Brand New Tool', 'a net-new tool only in ServiceNow');
  const artifacts = [newArt, chgArt, unchArt];

  // Dry run first — must write nothing.
  const cpsBefore = db.prepare('SELECT COUNT(*) c FROM asdlc_change_packet WHERE project_id=?').get(pid).c;
  const dry = await post(`/projects/${pid}/servicenow/sync?dry_run=1`, { artifacts, threshold: 0 });
  assert(dry.dry_run === true && Array.isArray(dry.plan.items), 'dry_run returns a plan');
  assert(dry.plan.classified_summary.new === 1 && dry.plan.classified_summary.changed === 1 && dry.plan.classified_summary.unchanged === 1,
         'classification: 1 new / 1 changed / 1 unchanged');
  assert(db.prepare('SELECT COUNT(*) c FROM asdlc_change_packet WHERE project_id=?').get(pid).c === cpsBefore, 'dry_run created no change packets');

  // Real run, threshold 0 → the safe `new` create auto-applies.
  const run1 = await post(`/projects/${pid}/servicenow/sync`, { artifacts, threshold: 0 });
  assert(run1.result.auto_cp && run1.result.auto_cp.item_count === 1, 'auto packet has the 1 new tool');
  assert(run1.result.auto_cp.apply_result.applied === 1, 'auto packet applied 1 create');
  assert(!run1.result.hitl_cp, 'no HITL packet at threshold 0 (new→auto, changed→no_change, unchanged→skip)');

  const newRow = db.prepare("SELECT * FROM asdlc_tool WHERE project_id=? AND source_sys_id='sysNEW'").get(pid);
  assert(newRow && newRow.name === 'Brand New Tool', 'new tool materialized');
  assert(newRow && newRow.source_hash === newArt.hash, 'new tool stored source_hash (re-sync will detect unchanged)');
  assert(newRow && newRow.source_system === 'servicenow', 'new tool tagged source_system=servicenow');

  const chgRow = db.prepare('SELECT source_hash FROM asdlc_tool WHERE tool_id=?').get(chgId);
  assert(chgRow.source_hash === chgArt.hash, 'changed→no_change row advanced source_hash from STALEHASH to current');
  assert(run1.result.hash_advanced === 1, 'reported 1 hash advance');

  const unchRow = db.prepare('SELECT source_hash, version FROM asdlc_tool WHERE tool_id=?').get(unchId);
  assert(unchRow.source_hash === unchArt.hash, 'unchanged row untouched (hash already current)');

  // Re-run the SAME capture — now everything should be tier-0 unchanged (cost tier proven).
  const run2 = await post(`/projects/${pid}/servicenow/sync`, { artifacts, threshold: 0 });
  assert(!run2.result.auto_cp && !run2.result.hitl_cp, 're-sync of identical capture: nothing to apply');
  assert(run2.plan.classified_summary.unchanged === 3 && run2.plan.classified_summary.new === 0 && run2.plan.classified_summary.changed === 0,
         're-sync: all 3 now classify as unchanged (source_hash persisted)');

  // High threshold routes a fresh net-new change to HITL instead of auto-applying.
  // Sync the FULL capture (so the already-synced tools stay tier-0 unchanged, not drift)
  // plus one new tool.
  const newArt2 = toolArtifact('sysNEW2', 'Another New Tool', 'second net-new tool');
  const run3 = await post(`/projects/${pid}/servicenow/sync`, { artifacts: [newArt, chgArt, unchArt, newArt2], threshold: 0.99 });
  assert(run3.result.hitl_cp && run3.result.hitl_cp.item_count === 1, 'threshold 0.99 → new change routed to HITL packet (others unchanged)');
  assert(!run3.result.auto_cp, 'nothing auto-applied above threshold');
  const hitlCp = db.prepare('SELECT status FROM asdlc_change_packet WHERE change_packet_id=?').get(run3.result.hitl_cp.change_packet_id);
  assert(hitlCp.status === 'pending_review', 'HITL packet is pending_review (awaits human)');
  assert(!db.prepare("SELECT 1 FROM asdlc_tool WHERE project_id=? AND source_sys_id='sysNEW2'").get(pid), 'HITL new tool NOT materialized yet');

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  done(fail ? 1 : 0);
}

main().catch(e => { console.error('TEST ERROR', e); done(1); });
