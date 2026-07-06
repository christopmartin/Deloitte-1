// test-both-side-edit.js — regression test for #84 (deterministic both-side-edit detection).
//
// Change detection compared only the SN hash against the stored source_hash and never
// asked whether the WORKBENCH record was edited since the last sync — so when both sides
// diverged, the merge decision fell entirely to the AI without the one deterministic fact
// that matters (a deliberately-cleared WB field looked identical to a never-filled one,
// and a "safe" fill_blank could silently resurrect it).
//
// Covers: classifyArtifacts computes wb_edited_since_sync from updated_at vs
// sn_last_synced_at (sync's own writes land before markSynced, so they never count);
// gateProposal forces both-side-changed items to HITL before any AI-based auto-grant
// (no_change/hash-advance still allowed); genericDecision applies the same floor to
// generic-artifact auto-refresh; the flags + reasons flow end-to-end through
// POST /servicenow/sync; and never-synced projects are unaffected.
//
// Run:  node test-both-side-edit.js   (from backend-node/)
'use strict';
const path = require('path');
const os   = require('os');

process.env.ASDLC_DB_PATH = path.join(os.tmpdir(), `asdlc_bse_${Date.now()}.db`);
process.env.PORT = String(8700 + Math.floor(Math.random() * 600));
process.env.ANTHROPIC_API_KEY = '';   // stub mode — deterministic + free

const base = __dirname;
require(path.join(base, 'server.js'));
const { db, generateId } = require(path.join(base, 'db'));
const { hashArtifact, classifyArtifacts } = require(path.join(base, 'agent', 'sn-capture'));
const snSync = require(path.join(base, 'agent', 'sn-sync'));
const { editContextLines } = require(path.join(base, 'agent', 'sn-reconcile'));

const BASEURL = `http://127.0.0.1:${process.env.PORT}/api/v1`;
const HEADERS = { 'Content-Type': 'application/json', 'X-User-ID': 'test-bse' };
const SCOPE = 'x_test_bse';
const LAST_SYNC = '2026-07-01 12:00:00';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { console.log('  ok  -', m); pass++; } else { console.error('  FAIL-', m); fail++; } };
function done(code) { try { db.close(); } catch { /* ignore */ } process.exit(code); }

function toolArtifact(sysId, name, desc, extra = {}) {
  const salient = { name, type: 'action', description: desc };
  return { source_table: 'sn_aia_tool', design_type: 'tool', source_sys_id: sysId, name, salient, hash: hashArtifact(salient), ...extra };
}

function makeProject(code, lastSync) {
  const client = db.prepare('SELECT client_id FROM asdlc_client LIMIT 1').get();
  const pid = generateId();
  db.prepare(`INSERT INTO asdlc_project (project_id, client_id, project_name, project_code, servicenow_scope, servicenow_instance, confidence_threshold, sn_last_synced_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(pid, client.client_id, `BSE ${code}`, code, SCOPE, 'https://example.service-now.com', 0.75, lastSync);
  return pid;
}

function insertTool(pid, sysId, name, updatedAt) {
  const id = generateId();
  db.prepare(`INSERT INTO asdlc_tool (tool_id, project_id, name, contract, source_system, source_sys_id, source_table, source_hash, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, pid, name, '{"text":"rich"}', 'servicenow', sysId, 'sn_aia_tool', 'STALEHASH', '2026-06-20 10:00:00', updatedAt);
  return id;
}

async function post(p, body) {
  const r = await fetch(BASEURL + p, { method: 'POST', headers: HEADERS, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`POST ${p} -> ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

function testClassify() {
  console.log('\n--- Part 1: classifyArtifacts computes wb_edited_since_sync ---');
  const pid = makeProject('BSE1', LAST_SYNC);
  insertTool(pid, 'sysED', 'Edited Tool', '2026-07-02 09:00:00');   // AFTER last sync — human edit
  insertTool(pid, 'sysCL', 'Clean Tool',  '2026-06-30 08:00:00');   // BEFORE last sync

  const arts = [toolArtifact('sysED', 'Edited Tool', 'sn moved'), toolArtifact('sysCL', 'Clean Tool', 'sn moved too')];
  const cls = classifyArtifacts(arts, pid);
  assert(cls.changed.length === 2, 'both stale-hash rows classify as changed');
  const ed = cls.changed.find(c => c.source_sys_id === 'sysED');
  const cl = cls.changed.find(c => c.source_sys_id === 'sysCL');
  assert(ed && ed.wb_edited_since_sync === true, 'WB row edited after last sync → wb_edited_since_sync = true');
  assert(ed.wb_updated_at === '2026-07-02 09:00:00' && ed.sn_last_synced_at === LAST_SYNC, 'timestamps carried for the human explanation');
  assert(cl && cl.wb_edited_since_sync === false, 'WB row untouched since last sync → flag false');
  assert(cls.summary.both_side_edits === 1, 'summary counts both-side edits');

  // Never-synced project: no baseline → never flags (first import must not force HITL storms)
  const pid2 = makeProject('BSE2', null);
  insertTool(pid2, 'sysNV', 'NeverSynced Tool', '2026-07-02 09:00:00');
  const cls2 = classifyArtifacts([toolArtifact('sysNV', 'NeverSynced Tool', 'x')], pid2);
  assert(cls2.changed.length === 1 && cls2.changed[0].wb_edited_since_sync === false,
         'never-synced project (sn_last_synced_at NULL) → flag stays false');
}

function testGate() {
  console.log('\n--- Part 2: gate floors (rich + generic) ---');
  const safeProposal = { action: 'enrich', destructive: false, field_changes: [{ field: 'cost_impact', change_kind: 'fill_blank' }] };
  const cleanReview  = { verdict: 'approve', destructive_confirmed: false, final_confidence: 0.95 };
  const T = { mode: 'additive_hitl', threshold: 0.75 };

  let d = snSync.gateProposal({ classification: 'changed', wb_edited_since_sync: true, wb_updated_at: '2026-07-02 09:00:00', proposal: safeProposal, review: cleanReview }, T);
  assert(d.target === 'hitl' && /both sides changed/.test(d.reason),
         'both-side-edited + perfectly safe fill_blank → HITL (was auto — the resurrection hazard)');

  d = snSync.gateProposal({ classification: 'changed', wb_edited_since_sync: false, proposal: safeProposal, review: cleanReview }, T);
  assert(d.target === 'auto', 'same safe change WITHOUT the flag still auto-applies (no behavior change)');

  d = snSync.gateProposal({ classification: 'changed', wb_edited_since_sync: true, proposal: safeProposal, review: cleanReview }, { mode: 'confidence_gate', threshold: 0 });
  assert(d.target === 'hitl', 'floor holds under confidence_gate mode too');

  d = snSync.gateProposal({ classification: 'changed', wb_edited_since_sync: true, proposal: { action: 'no_change', destructive: false }, review: cleanReview }, T);
  assert(d.target === 'none', 'no_change still → none (hash advance allowed; nothing is written)');

  d = snSync.gateProposal({ classification: 'new', proposal: { action: 'create', destructive: false }, review: cleanReview }, T);
  assert(d.target === 'auto', 'net-new creates unaffected (no WB row to have edited)');

  // Generic artifacts: the deterministic auto-refresh gets the same floor.
  let g = require(path.join(base, 'agent', 'sn-sync'));
  // genericDecision isn't exported — exercise it through buildGenericPlan via runSyncPlan below;
  // here assert through the gate-equivalent: a changed generic item in the e2e plan (Part 3).
  assert(true, '(generic floor asserted end-to-end in Part 3)');

  // Prompt context helper: states the fact in plain language, both directions.
  const linesEdited = editContextLines({ sn_last_synced_at: LAST_SYNC, wb_updated_at: '2026-07-02 09:00:00', wb_edited_since_sync: true }).join('\n');
  assert(/WAS EDITED after the last ServiceNow sync/.test(linesEdited) && /deliberate/i.test(linesEdited),
         'reconciler/reviewer prompt context states the edit + deliberate-clearing warning');
  const linesClean = editContextLines({ sn_last_synced_at: LAST_SYNC, wb_edited_since_sync: false }).join('\n');
  assert(/NOT been edited since/.test(linesClean), 'clean records get the "difference originates in ServiceNow" fact');
  assert(editContextLines({ wb_edited_since_sync: false }).length === 0, 'never-synced → no edit-history claim is made');
}

async function testEndToEnd() {
  console.log('\n--- Part 3: /servicenow/sync end-to-end (stub mode) ---');
  const pid = makeProject('BSE3', LAST_SYNC);
  insertTool(pid, 'sysED3', 'Edited Rich Tool', '2026-07-02 09:00:00');

  // Generic artifact whose Workbench copy was edited after the last sync.
  const genId = generateId();
  db.prepare(`INSERT INTO asdlc_sn_artifact (sn_artifact_id, project_id, sn_metadata_type, name, payload, source_sys_id, source_table, source_hash, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(genId, pid, 'property', 'x_test.prop', '{"name":"x_test.prop","value":"wb-edited-value"}', 'sysGEN3', 'sys_properties', 'STALEHASH', '2026-06-20 10:00:00', '2026-07-02 10:00:00');
  const genArt = {
    generic: true, source_table: 'sys_properties', design_type: 'property', sn_metadata_type: 'property',
    source_sys_id: 'sysGEN3', name: 'x_test.prop',
    salient: { name: 'x_test.prop', value: 'sn-changed-value' }, hash: 'NEWGENHASH',
  };

  const richArt = toolArtifact('sysED3', 'Edited Rich Tool', 'sn changed this too');

  const dry = await post(`/projects/${pid}/servicenow/sync?dry_run=1`, { artifacts: [richArt, genArt], threshold: 0 });
  const items = dry.plan.items || dry.plan.planned || [];
  assert(dry.plan.classified_summary.both_side_edits === 2, 'classified summary reports 2 both-side edits');

  const genItem = items.find(i => i.source_sys_id === 'sysGEN3');
  assert(genItem && genItem.decision.target === 'hitl' && /both sides changed/.test(genItem.decision.reason),
         'WB-edited generic artifact → HITL instead of silent auto-refresh (Phase-4b edits protected)');

  const richItem = items.find(i => i.source_sys_id === 'sysED3');
  assert(richItem && richItem.wb_edited_since_sync === true, 'rich changed item carries the flag through reconcile+review to the plan');
  // (stub reconciler answers no_change → target none; with a real key any non-no_change action would floor to HITL)

  // Real run: the generic conflict must land in the HITL packet, not auto-apply.
  const run = await post(`/projects/${pid}/servicenow/sync`, { artifacts: [richArt, genArt], threshold: 0 });
  assert(run.result.hitl_cp && run.result.hitl_cp.item_count >= 1, 'HITL packet created for the both-side-edited generic artifact');
  const genRow = db.prepare('SELECT payload, source_hash FROM asdlc_sn_artifact WHERE sn_artifact_id = ?').get(genId);
  assert(genRow.payload.includes('wb-edited-value'), 'Workbench-edited payload NOT clobbered by the sync');
  assert(genRow.source_hash === 'STALEHASH', 'hash NOT advanced for the unresolved conflict (re-surfaces until a human decides)');
}

async function main() {
  await new Promise(r => setTimeout(r, 900));   // let app.listen bind
  testClassify();
  testGate();
  await testEndToEnd();
  console.log(`\n=== test-both-side-edit: ${pass} passed, ${fail} failed ===`);
  done(fail ? 1 : 0);
}

main().catch(err => { console.error('FATAL', err); done(1); });
