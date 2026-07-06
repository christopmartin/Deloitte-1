// test-sn-completeness.js — regression test for #86 part (a): the sys_metadata
// completeness backbone (read-only sweep, NO schema change).
//
// The curated capture reads ~24 hand-listed surfaces; ServiceNow keeps ONE registry
// (sys_metadata) of every application file in a scope. A single scope-filtered sweep is
// the authority for (1) blind-spot classes the curated surfaces never read and (2) telling
// a record truly deleted upstream apart from one that merely lives under an unmonitored
// class. Part (b) — storing per-record change signals to pre-filter payload downloads —
// needs new provenance columns and is intentionally NOT covered here.
//
// Covers: sweepScopeMetadata parses rows into bySysId/byClass and is best-effort (an HTTP
// failure degrades to available:false, never throws); analyzeCompleteness is pure — computes
// blind spots per class, excludes captured sys_ids, marks class coverage, disambiguates
// WB-side drift into vanished vs present_uncaptured and annotates drift.exists_in_sn without
// changing gating; runSyncPlan attaches completeness + emits human-readable warnings; and a
// pre-supplied-artifacts run with no injected sweep degrades cleanly (available:false).
//
// Run:  node test-sn-completeness.js   (from backend-node/)
'use strict';
const path = require('path');
const os   = require('os');

process.env.ASDLC_DB_PATH = path.join(os.tmpdir(), `asdlc_cmpl_${Date.now()}.db`);
process.env.PORT = String(8700 + Math.floor(Math.random() * 600));
process.env.ANTHROPIC_API_KEY = '';   // stub mode — deterministic + free

const base = __dirname;
require(path.join(base, 'server.js'));
const { db, generateId } = require(path.join(base, 'db'));
const { hashArtifact, classifyArtifacts, sweepScopeMetadata, analyzeCompleteness } = require(path.join(base, 'agent', 'sn-capture'));
const snSync = require(path.join(base, 'agent', 'sn-sync'));

const BASEURL = `http://127.0.0.1:${process.env.PORT}/api/v1`;
const HEADERS = { 'Content-Type': 'application/json', 'X-User-ID': 'test-cmpl' };
const SCOPE = 'x_test_cmpl';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { console.log('  ok  -', m); pass++; } else { console.error('  FAIL-', m); fail++; } };
function done(code) { try { db.close(); } catch { /* ignore */ } process.exit(code); }

// Build a sweep object shaped exactly like sweepScopeMetadata's success return.
function fakeSweep(rows, { capped = false } = {}) {
  const bySysId = new Map();
  const byClass = {};
  for (const r of rows) {
    bySysId.set(r.sys_id, r);
    const c = r.sys_class_name || '(unknown)';
    byClass[c] = (byClass[c] || 0) + 1;
  }
  return { available: true, capped, total: bySysId.size, bySysId, byClass };
}

function makeProject(code) {
  const client = db.prepare('SELECT client_id FROM asdlc_client LIMIT 1').get();
  const pid = generateId();
  db.prepare(`INSERT INTO asdlc_project (project_id, client_id, project_name, project_code, servicenow_scope, servicenow_instance, confidence_threshold)
              VALUES (?,?,?,?,?,?,?)`)
    .run(pid, client.client_id, `CMPL ${code}`, code, SCOPE, 'https://example.service-now.com', 0.75);
  return pid;
}

function insertTool(pid, sysId, name, srcHash) {
  const id = generateId();
  db.prepare(`INSERT INTO asdlc_tool (tool_id, project_id, name, contract, source_system, source_sys_id, source_table, source_hash, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`)
    .run(id, pid, name, '{"text":"x"}', 'servicenow', sysId, 'sn_aia_tool', srcHash);
  return id;
}

function toolArtifact(sysId, name) {
  const salient = { name, type: 'action', description: 'd' };
  return { source_table: 'sn_aia_tool', design_type: 'tool', source_sys_id: sysId, name, salient, hash: hashArtifact(salient) };
}

// ── Part 1: analyzeCompleteness (pure) ───────────────────────────────────────
function testAnalyzePure() {
  console.log('\n--- Part 1: analyzeCompleteness (pure) ---');

  // Unavailable sweep short-circuits.
  const un = analyzeCompleteness({ available: false, error: 'no read on sys_metadata' }, { unchanged: [], changed: [], new: [], drift: [] });
  assert(un.available === false && /no read/.test(un.reason), 'unavailable sweep → available:false with reason');

  const classified = {
    unchanged: [{ source_sys_id: 'CAP1' }],
    changed:   [{ source_sys_id: 'CAP2' }],
    new:       [],
    drift: [
      { source_sys_id: 'GONE', name: 'Deleted Upstream', wb_table: 'asdlc_tool', wb_type: 'tool' },
      { source_sys_id: 'HIDDEN', name: 'Under Unmonitored Class', wb_table: 'asdlc_tool', wb_type: 'tool' },
    ],
  };
  const sweep = fakeSweep([
    { sys_id: 'CAP1', sys_class_name: 'sn_aia_tool', sys_name: 'Cap One' },
    { sys_id: 'CAP2', sys_class_name: 'sn_aia_tool', sys_name: 'Cap Two' },
    { sys_id: 'HIDDEN', sys_class_name: 'sys_documentation', sys_name: 'Doc row' },
    { sys_id: 'BLIND1', sys_class_name: 'sys_atf_step', sys_name: 'ATF step 1', sys_updated_on: '2026-07-01', sys_updated_by: 'admin' },
    { sys_id: 'BLIND2', sys_class_name: 'sys_atf_step', sys_name: 'ATF step 2' },
    { sys_id: 'BLIND3', sys_class_name: 'sys_report', sys_name: 'A report' },
  ]);
  const r = analyzeCompleteness(sweep, classified);

  assert(r.available === true && r.total_in_scope === 6, 'reports total in-scope from the sweep');
  // Blind spots: everything in the sweep NOT captured (CAP1/CAP2 are captured; HIDDEN is drift, not captured either).
  assert(r.uncaptured_count === 4, 'uncaptured_count excludes the 2 captured sys_ids');
  const atf = r.uncaptured_by_class.find(c => c.sys_class_name === 'sys_atf_step');
  assert(atf && atf.count === 2, 'blind spots grouped by class (sys_atf_step: 2)');
  assert(r.uncaptured_by_class[0].count >= r.uncaptured_by_class[r.uncaptured_by_class.length - 1].count, 'blind-spot classes sorted by count desc');
  const sample = r.uncaptured_sample.find(s => s.sys_id === 'BLIND1');
  assert(sample && sample.updated_by === 'admin' && sample.name === 'ATF step 1', 'sample carries name/updated_by for the human report');

  // Class coverage flags which classes the capture actually reached.
  const toolClass = r.classes_in_scope.find(c => c.sys_class_name === 'sn_aia_tool');
  const docClass  = r.classes_in_scope.find(c => c.sys_class_name === 'sys_documentation');
  assert(toolClass && toolClass.captured === true, 'sn_aia_tool marked captured (both its records were pulled)');
  assert(docClass && docClass.captured === false, 'sys_documentation marked NOT captured (blind spot class)');

  // Drift disambiguation via the authoritative sweep.
  assert(r.vanished.length === 1 && r.vanished[0].source_sys_id === 'GONE', 'drift absent from sweep → vanished (confirmed deleted upstream)');
  assert(r.present_uncaptured.length === 1 && r.present_uncaptured[0].source_sys_id === 'HIDDEN', 'drift present in sweep → present_uncaptured (exists, just unmonitored)');
  assert(r.present_uncaptured[0].sys_class_name === 'sys_documentation', 'present_uncaptured carries the real SN class');
  assert(classified.drift.find(d => d.source_sys_id === 'GONE').exists_in_sn === false, 'drift item annotated exists_in_sn=false (informational)');
  assert(classified.drift.find(d => d.source_sys_id === 'HIDDEN').exists_in_sn === true, 'drift item annotated exists_in_sn=true');

  // sampleCap bounds the sample.
  const many = fakeSweep(Array.from({ length: 10 }, (_, i) => ({ sys_id: `X${i}`, sys_class_name: 'sys_atf_step' })));
  const capped = analyzeCompleteness(many, { unchanged: [], changed: [], new: [], drift: [] }, { sampleCap: 3 });
  assert(capped.uncaptured_count === 10 && capped.uncaptured_sample.length === 3, 'sampleCap bounds uncaptured_sample without losing the count');
}

// ── Part 2: sweepScopeMetadata (mocked fetch) ────────────────────────────────
async function testSweep() {
  console.log('\n--- Part 2: sweepScopeMetadata (mocked fetch) ---');

  const rows = [
    { sys_id: 'A', sys_class_name: 'sys_script', sys_name: 'BR1' },
    { sys_id: 'B', sys_class_name: 'sys_script', sys_name: 'BR2' },
    { sys_id: 'C', sys_class_name: 'sys_security_acl', sys_name: 'ACL1' },
    { sys_id: '',  sys_class_name: 'sys_junk' },   // rows without a sys_id are ignored
  ];
  let seenUrl = null;
  const okFetch = async (url) => {
    seenUrl = url;
    // Single short page ends pagination (default page size 1000).
    return { ok: true, status: 200, json: async () => ({ result: rows }) };
  };
  const s = await sweepScopeMetadata({ scope: SCOPE, instance: 'https://x.service-now.com', user: 'u', pw: 'p', fetchImpl: okFetch });
  assert(s.available === true && s.total === 3, 'parses rows into bySysId, ignoring the id-less row');
  assert(s.byClass.sys_script === 2 && s.byClass.sys_security_acl === 1, 'byClass tallies per sys_class_name');
  assert(/table\/sys_metadata/.test(seenUrl) && /sys_scope.scope%3D/.test(seenUrl), 'queries sys_metadata filtered by scope');
  assert(/sysparm_fields=/.test(seenUrl) && /sys_mod_count/.test(decodeURIComponent(seenUrl)), 'requests the change-signal fields');

  // Best-effort: an HTTP error becomes available:false, never throws.
  const errFetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
  const e = await sweepScopeMetadata({ scope: SCOPE, instance: 'https://x.service-now.com', user: 'u', pw: 'p', fetchImpl: errFetch });
  assert(e.available === false && /403/.test(e.error) && e.bySysId instanceof Map, 'sweep failure degrades to available:false (never breaks sync)');
}

// ── Part 3: runSyncPlan wiring (injected sweep + degradation) ─────────────────
async function testRunSyncPlan() {
  console.log('\n--- Part 3: runSyncPlan wiring ---');
  const pid = makeProject('CMPL3');
  // Captured + unchanged: WB tool whose stored hash matches the artifact.
  const capArt = toolArtifact('CAPX', 'Captured Tool');
  insertTool(pid, 'CAPX', 'Captured Tool', capArt.hash);
  // Drift: a WB tool with a sys_id the capture won't return this run.
  insertTool(pid, 'DRIFTX', 'Drifted Tool', 'SOMEHASH');

  const sweep = fakeSweep([
    { sys_id: 'CAPX', sys_class_name: 'sn_aia_tool', sys_name: 'Captured Tool' },
    // DRIFTX intentionally ABSENT → confirmed vanished upstream.
    { sys_id: 'BLINDA', sys_class_name: 'sys_atf_step', sys_name: 'ATF a' },
    { sys_id: 'BLINDB', sys_class_name: 'sys_atf_step', sys_name: 'ATF b' },
    { sys_id: 'BLINDC', sys_class_name: 'sys_documentation', sys_name: 'Doc a' },
  ]);

  const plan = await snSync.runSyncPlan(
    { projectId: pid, scope: SCOPE, artifacts: [capArt], metadataSweep: sweep, mode: 'additive_hitl' },
    { projectId: pid }
  );
  assert(plan.completeness && plan.completeness.available === true, 'plan carries the completeness block');
  assert(plan.completeness.uncaptured_count === 3, 'completeness counts the 3 blind-spot records');
  assert(plan.completeness.vanished.some(v => v.source_sys_id === 'DRIFTX'), 'the drifted WB record is classified vanished (confirmed deleted)');
  assert(plan.warnings.some(w => /completeness/.test(w) && /sys_atf_step/.test(w)), 'a blind-spot warning names the top uncaptured class');
  assert(plan.warnings.some(w => /absent from the full scope inventory/.test(w)), 'a vanished-record warning is emitted');

  // Degradation: pre-supplied artifacts with NO injected sweep → no live call, clean report.
  const plan2 = await snSync.runSyncPlan(
    { projectId: pid, scope: SCOPE, artifacts: [capArt], mode: 'additive_hitl' },
    { projectId: pid }
  );
  assert(plan2.completeness && plan2.completeness.available === false, 'no sweep + pre-supplied artifacts → completeness available:false (no crash)');
  assert(!plan2.warnings.some(w => /completeness/.test(w)), 'no completeness warnings when the sweep is unavailable');
}

// ── Part 4: HTTP planView surfaces completeness ──────────────────────────────
async function testEndpoint() {
  console.log('\n--- Part 4: /servicenow/sync planView ---');
  const pid = makeProject('CMPL4');
  const capArt = toolArtifact('CAPY', 'Endpoint Tool');
  insertTool(pid, 'CAPY', 'Endpoint Tool', capArt.hash);
  // The endpoint can't inject a sweep (no live creds in stub), so completeness degrades to
  // available:false — the assertion is that the key is present & serialized in planView.
  const r = await fetch(`${BASEURL}/projects/${pid}/servicenow/sync?dry_run=1`, {
    method: 'POST', headers: HEADERS, body: JSON.stringify({ artifacts: [capArt] }),
  });
  const j = await r.json();
  assert(r.ok, 'dry-run sync responds 200');
  assert(Object.prototype.hasOwnProperty.call(j.plan, 'completeness'), 'planView exposes the completeness field');
  assert(j.plan.completeness && j.plan.completeness.available === false, 'completeness present (available:false without live creds)');
}

async function main() {
  await new Promise(r => setTimeout(r, 900));   // let app.listen bind
  testAnalyzePure();
  await testSweep();
  await testRunSyncPlan();
  await testEndpoint();
  console.log(`\n=== test-sn-completeness: ${pass} passed, ${fail} failed ===`);
  done(fail ? 1 : 0);
}

main().catch(err => { console.error('FATAL', err); done(1); });
