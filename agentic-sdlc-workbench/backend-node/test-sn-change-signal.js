// test-sn-change-signal.js — regression test for #86 part (b): per-record change signals.
//
// Change detection compared only the content hash (our salient-field selection) against the
// stored source_hash. So a code change to WHICH fields we hash would flip EVERY record to
// "changed" in one cycle — a mass re-classify that burns Opus and floods the review queue —
// and a conflict could never say WHO changed a record or WHEN.
//
// Part (b) stores each record's ServiceNow sys_mod_count / sys_updated_on / sys_updated_by
// (from the sys_metadata sweep) in asdlc_sn_change_signal on every successful sync. Next
// sync, classifyArtifacts flags a hash-changed record whose mod_count is UNMOVED as
// `sn_unmoved` (capture-formula drift, not a real change) and carries who/when for the human.
//
// Covers: persist/read round-trip + upsert; classify sets sn_unmoved only when the stored
// counter equals the live one (and never on first sync / no signal); runSyncPlan routes
// sn_unmoved rich + generic items to a deterministic no_change (no Opus) and the apply path
// refreshes their hash so the next cycle is tier-0; signals are persisted on apply but NOT on
// dry-run; who/when reaches the reconciler prompt + the Change Packet rationale.
//
// Run:  node test-sn-change-signal.js   (from backend-node/)
'use strict';
const path = require('path');
const os   = require('os');

process.env.ASDLC_DB_PATH = path.join(os.tmpdir(), `asdlc_sig_${Date.now()}.db`);
process.env.PORT = String(8700 + Math.floor(Math.random() * 600));
process.env.ANTHROPIC_API_KEY = '';   // stub mode — deterministic + free

const base = __dirname;
require(path.join(base, 'server.js'));
const { db, generateId } = require(path.join(base, 'db'));
const { hashArtifact, classifyArtifacts, readChangeSignals, persistChangeSignals, sweepSignals } = require(path.join(base, 'agent', 'sn-capture'));
const snSync = require(path.join(base, 'agent', 'sn-sync'));
const { editContextLines } = require(path.join(base, 'agent', 'sn-reconcile'));

const BASEURL = `http://127.0.0.1:${process.env.PORT}/api/v1`;
const HEADERS = { 'Content-Type': 'application/json', 'X-User-ID': 'test-sig' };
const SCOPE = 'x_test_sig';
const LAST_SYNC = '2026-07-01 12:00:00';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { console.log('  ok  -', m); pass++; } else { console.error('  FAIL-', m); fail++; } };
function done(code) { try { db.close(); } catch { /* ignore */ } process.exit(code); }

function fakeSweep(rows) {
  const bySysId = new Map();
  const byClass = {};
  for (const r of rows) { bySysId.set(r.sys_id, r); const c = r.sys_class_name || '(unknown)'; byClass[c] = (byClass[c] || 0) + 1; }
  return { available: true, capped: false, total: bySysId.size, bySysId, byClass };
}

function makeProject(code, lastSync) {
  const client = db.prepare('SELECT client_id FROM asdlc_client LIMIT 1').get();
  const pid = generateId();
  db.prepare(`INSERT INTO asdlc_project (project_id, client_id, project_name, project_code, servicenow_scope, servicenow_instance, confidence_threshold, sn_last_synced_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(pid, client.client_id, `SIG ${code}`, code, SCOPE, 'https://example.service-now.com', 0.75, lastSync);
  return pid;
}

function insertTool(pid, sysId, name, srcHash, updatedAt) {
  const id = generateId();
  db.prepare(`INSERT INTO asdlc_tool (tool_id, project_id, name, contract, source_system, source_sys_id, source_table, source_hash, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, pid, name, '{"text":"x"}', 'servicenow', sysId, 'sn_aia_tool', srcHash, '2026-06-20 10:00:00', updatedAt || '2026-06-20 10:00:00');
  return id;
}

function toolArtifact(sysId, name, desc) {
  const salient = { name, type: 'action', description: desc || 'd' };
  return { source_table: 'sn_aia_tool', design_type: 'tool', source_sys_id: sysId, name, salient, hash: hashArtifact(salient) };
}

async function post(p, body) {
  const r = await fetch(BASEURL + p, { method: 'POST', headers: HEADERS, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`POST ${p} -> ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

// ── Part 1: persist / read / upsert ──────────────────────────────────────────
function testPersistRead() {
  console.log('\n--- Part 1: persist / read change signals ---');
  const pid = makeProject('SIG1', LAST_SYNC);
  const sweep = fakeSweep([
    { sys_id: 'S1', sys_class_name: 'sn_aia_tool', sys_mod_count: '5', sys_updated_on: '2026-06-30 08:00:00', sys_updated_by: 'alice' },
    { sys_id: 'S2', sys_class_name: 'sys_script', sys_mod_count: '12', sys_updated_on: '2026-06-29 08:00:00', sys_updated_by: 'bob' },
  ]);
  const n = persistChangeSignals(pid, sweepSignals(sweep));
  assert(n === 2, 'persistChangeSignals writes one row per swept record');

  const m = readChangeSignals(pid);
  assert(m.size === 2 && Number(m.get('S1').sys_mod_count) === 5 && m.get('S1').sys_updated_by === 'alice', 'readChangeSignals returns stored mod_count + author');

  // Upsert: same sys_id with a higher counter overwrites (never duplicates).
  const sweep2 = fakeSweep([{ sys_id: 'S1', sys_class_name: 'sn_aia_tool', sys_mod_count: '6', sys_updated_on: '2026-07-02 09:00:00', sys_updated_by: 'carol' }]);
  persistChangeSignals(pid, sweepSignals(sweep2));
  const m2 = readChangeSignals(pid);
  assert(m2.size === 2 && Number(m2.get('S1').sys_mod_count) === 6 && m2.get('S1').sys_updated_by === 'carol', 'upsert advances the stored counter/author for an existing sys_id');

  assert(persistChangeSignals(pid, []) === 0 && persistChangeSignals(pid, null) === 0, 'empty/no signals is a safe no-op');
  assert(readChangeSignals('no-such-project').size === 0, 'unknown project → empty signal map');
}

// ── Part 2: classify sets sn_unmoved from stored vs live counter ──────────────
function testClassifyUnmoved() {
  console.log('\n--- Part 2: classify sn_unmoved detection ---');
  const pid = makeProject('SIG2', LAST_SYNC);
  // Two tools with a STALE stored hash → both are hash-"changed".
  insertTool(pid, 'UNMOVED', 'Unmoved Tool', 'STALEHASH');
  insertTool(pid, 'MOVED',   'Moved Tool',   'STALEHASH');
  // Stored signals from the "last sync": both at mod_count 3.
  persistChangeSignals(pid, [
    { source_sys_id: 'UNMOVED', sys_class_name: 'sn_aia_tool', sys_mod_count: 3, sys_updated_on: '2026-06-30', sys_updated_by: 'alice' },
    { source_sys_id: 'MOVED',   sys_class_name: 'sn_aia_tool', sys_mod_count: 3, sys_updated_on: '2026-06-30', sys_updated_by: 'alice' },
  ]);
  // Live sweep: UNMOVED still 3 (SN not written — hash diff is our formula), MOVED now 4.
  const sweep = fakeSweep([
    { sys_id: 'UNMOVED', sys_class_name: 'sn_aia_tool', sys_mod_count: '3', sys_updated_on: '2026-06-30', sys_updated_by: 'alice' },
    { sys_id: 'MOVED',   sys_class_name: 'sn_aia_tool', sys_mod_count: '4', sys_updated_on: '2026-07-02 09:00:00', sys_updated_by: 'dave' },
  ]);
  const cls = classifyArtifacts([toolArtifact('UNMOVED', 'Unmoved Tool'), toolArtifact('MOVED', 'Moved Tool')], pid, { sweep });
  const u = cls.changed.find(c => c.source_sys_id === 'UNMOVED');
  const mv = cls.changed.find(c => c.source_sys_id === 'MOVED');
  assert(u && u.sn_unmoved === true, 'stored counter == live counter → sn_unmoved = true (capture-formula drift)');
  assert(mv && mv.sn_unmoved === false, 'stored counter != live counter → sn_unmoved = false (real SN change)');
  assert(mv.sn_updated_by === 'dave' && mv.sn_updated_on === '2026-07-02 09:00:00', 'who/when carried onto the changed item');
  assert(cls.summary.sn_unmoved === 1, 'classify summary counts sn_unmoved');

  // No sweep → never flags (part-(a)-only / offline behavior preserved).
  const clsNo = classifyArtifacts([toolArtifact('UNMOVED', 'Unmoved Tool')], pid);
  assert(clsNo.changed[0].sn_unmoved === false, 'no sweep supplied → sn_unmoved stays false');

  // First sync (no stored signal) → never flags, even with a live counter.
  const pid2 = makeProject('SIG2b', null);
  insertTool(pid2, 'FRESH', 'Fresh Tool', 'STALEHASH');
  const sweep2 = fakeSweep([{ sys_id: 'FRESH', sys_class_name: 'sn_aia_tool', sys_mod_count: '9' }]);
  const cls2 = classifyArtifacts([toolArtifact('FRESH', 'Fresh Tool')], pid2, { sweep: sweep2 });
  assert(cls2.changed[0].sn_unmoved === false, 'no stored signal (first sync) → sn_unmoved false — nothing suppressed');
}

// ── Part 3: prompt context surfaces who/when ─────────────────────────────────
function testPromptContext() {
  console.log('\n--- Part 3: reconciler prompt who/when ---');
  const lines = editContextLines({ sn_last_synced_at: LAST_SYNC, wb_edited_since_sync: false, sn_updated_by: 'dave', sn_updated_on: '2026-07-02', sn_mod_count: 4 }).join('\n');
  assert(/last modified by dave on 2026-07-02/.test(lines) && /modification #4/.test(lines), 'prompt states who/when + mod count');
  const none = editContextLines({ sn_last_synced_at: LAST_SYNC, wb_edited_since_sync: false }).join('\n');
  assert(!/last modified by/.test(none), 'no who/when line when signals are absent');
}

// ── Part 4: runSyncPlan routes sn_unmoved to no_change (rich + generic) ───────
async function testRunSyncPlan() {
  console.log('\n--- Part 4: runSyncPlan sn_unmoved routing ---');
  const pid = makeProject('SIG4', LAST_SYNC);
  insertTool(pid, 'RICHU', 'Rich Unmoved', 'STALEHASH');
  const genId = generateId();
  db.prepare(`INSERT INTO asdlc_sn_artifact (sn_artifact_id, project_id, sn_metadata_type, name, payload, source_sys_id, source_table, source_hash, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(genId, pid, 'property', 'x.prop', '{"name":"x.prop","value":"v"}', 'GENU', 'sys_properties', 'STALEHASH', '2026-06-20', '2026-06-20');
  persistChangeSignals(pid, [
    { source_sys_id: 'RICHU', sys_mod_count: 2, sys_updated_by: 'alice', sys_updated_on: '2026-06-30' },
    { source_sys_id: 'GENU',  sys_mod_count: 7, sys_updated_by: 'alice', sys_updated_on: '2026-06-30' },
  ]);
  const sweep = fakeSweep([
    { sys_id: 'RICHU', sys_class_name: 'sn_aia_tool',   sys_mod_count: '2' },   // unmoved
    { sys_id: 'GENU',  sys_class_name: 'sys_properties', sys_mod_count: '7' },  // unmoved
  ]);
  const richArt = toolArtifact('RICHU', 'Rich Unmoved', 'formula-changed body');
  const genArt = { generic: true, source_table: 'sys_properties', design_type: 'property', sn_metadata_type: 'property',
    source_sys_id: 'GENU', name: 'x.prop', salient: { name: 'x.prop', value: 'v', extra: 'newfield' }, payload: { name: 'x.prop', value: 'v', extra: 'newfield' }, hash: 'NEWGENHASH' };

  const plan = await snSync.runSyncPlan(
    { projectId: pid, scope: SCOPE, artifacts: [richArt, genArt], metadataSweep: sweep, mode: 'additive_hitl', threshold: 0 },
    { projectId: pid }
  );
  assert(plan.summary.sn_unmoved === 2, 'both unmoved items counted in summary');
  const richPl = plan.planned.find(p => p.source_sys_id === 'RICHU');
  const genPl  = plan.planned.find(p => p.source_sys_id === 'GENU');
  assert(richPl && richPl.decision.target === 'none' && richPl.sn_unmoved, 'rich unmoved → deterministic no_change (no Opus)');
  assert(genPl && genPl.decision.target === 'none' && genPl.sn_unmoved, 'generic unmoved → deterministic no_change');
  assert(plan.warnings.some(w => /UNMOVED ServiceNow modification counter/.test(w)), 'a warning explains the capture-formula-drift suppression');
}

// ── Part 5: end-to-end apply refreshes hash + persists signals; dry-run does not ─
async function testEndToEnd() {
  console.log('\n--- Part 5: /servicenow/sync apply (hash refresh + persist) ---');
  const pid = makeProject('SIG5', LAST_SYNC);
  insertTool(pid, 'E2ER', 'E2E Rich', 'STALEHASH');
  const genId = generateId();
  db.prepare(`INSERT INTO asdlc_sn_artifact (sn_artifact_id, project_id, sn_metadata_type, name, payload, source_sys_id, source_table, source_hash, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(genId, pid, 'property', 'y.prop', '{"name":"y.prop","value":"v"}', 'E2EG', 'sys_properties', 'STALEHASH', '2026-06-20', '2026-06-20');
  persistChangeSignals(pid, [
    { source_sys_id: 'E2ER', sys_mod_count: 1 },
    { source_sys_id: 'E2EG', sys_mod_count: 1 },
  ]);
  const richArt = toolArtifact('E2ER', 'E2E Rich', 'formula body');
  const genArt = { generic: true, source_table: 'sys_properties', design_type: 'property', sn_metadata_type: 'property',
    source_sys_id: 'E2EG', name: 'y.prop', salient: { name: 'y.prop', value: 'v', extra: 'z' }, payload: { name: 'y.prop', value: 'v', extra: 'z' }, hash: 'NEWHASH2' };
  // Inject the sweep as a plain rows array (survives JSON; the endpoint rebuilds the Map).
  const body = { artifacts: [richArt, genArt], metadataSweep: [
    { sys_id: 'E2ER', sys_class_name: 'sn_aia_tool',   sys_mod_count: '1' },
    { sys_id: 'E2EG', sys_class_name: 'sys_properties', sys_mod_count: '1' },
  ] };

  // Dry-run: nothing persisted, nothing re-hashed.
  await post(`/projects/${pid}/servicenow/sync?dry_run=1`, body);
  const richAfterDry = db.prepare('SELECT source_hash FROM asdlc_tool WHERE source_sys_id=? AND project_id=?').get('E2ER', pid);
  assert(richAfterDry.source_hash === 'STALEHASH', 'dry-run does NOT refresh the hash');

  // Apply: unmoved items re-hashed, signals persisted, no CP created for them.
  const run = await post(`/projects/${pid}/servicenow/sync`, body);
  const richAfter = db.prepare('SELECT source_hash FROM asdlc_tool WHERE source_sys_id=? AND project_id=?').get('E2ER', pid);
  const genAfter  = db.prepare('SELECT source_hash, payload FROM asdlc_sn_artifact WHERE sn_artifact_id=?').get(genId);
  assert(richAfter.source_hash === richArt.hash, 'apply refreshes the RICH unmoved hash → tier-0 next cycle');
  assert(genAfter.source_hash === 'NEWHASH2' && genAfter.payload.includes('extra'), 'apply refreshes the GENERIC unmoved hash + snapshot');
  assert(run.result.hash_advanced >= 2, 'both unmoved records counted in hash_advanced');
  assert(!run.result.auto_cp && !run.result.hitl_cp, 'no Change Packet created for records that did not actually move in ServiceNow');
  assert(run.result.signals_recorded >= 2, 'signals persisted on apply');
}

async function main() {
  await new Promise(r => setTimeout(r, 900));   // let app.listen bind
  testPersistRead();
  testClassifyUnmoved();
  testPromptContext();
  await testRunSyncPlan();
  await testEndToEnd();
  console.log(`\n=== test-sn-change-signal: ${pass} passed, ${fail} failed ===`);
  done(fail ? 1 : 0);
}

main().catch(err => { console.error('FATAL', err); done(1); });
