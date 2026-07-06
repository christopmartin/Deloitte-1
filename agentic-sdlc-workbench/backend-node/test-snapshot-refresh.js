// test-snapshot-refresh.js — regression test for #85 (stale snapshot on hash-advance).
//
// When a `changed` artifact reconciles to no_change, the sync advances source_hash so the
// next cycle is tier-0 "unchanged" — but it used to advance ONLY the hash: the stored
// last-seen ServiceNow body (source_fluent, the Tier-3 "as built" snapshot) and the
// generic twin's provenance kept their creation-time state. Result: the hash claimed a
// currency the snapshot didn't have — a lie to any consumer treating source_fluent /
// the twin as "last-synced SN state" (Build Spec sections, the future 3-way merge base).
//
// Covers: hash-advance refreshes source_fluent on the L1 row (script body for logic
// artifacts, salient JSON otherwise; old snapshot kept when capture has no salient),
// keeps the twin asdlc_sn_artifact row's source_hash/source_fluent in lockstep, and the
// next sync classifies tier-0 unchanged.
//
// Run:  node test-snapshot-refresh.js   (from backend-node/)
'use strict';
const path = require('path');
const os   = require('os');

process.env.ASDLC_DB_PATH = path.join(os.tmpdir(), `asdlc_snap_${Date.now()}.db`);
process.env.PORT = String(8700 + Math.floor(Math.random() * 600));
process.env.ANTHROPIC_API_KEY = '';   // stub mode — reconcile answers no_change → hash-advance path

const base = __dirname;
require(path.join(base, 'server.js'));
const { db, generateId } = require(path.join(base, 'db'));
const { hashArtifact } = require(path.join(base, 'agent', 'sn-capture'));

const BASEURL = `http://127.0.0.1:${process.env.PORT}/api/v1`;
const HEADERS = { 'Content-Type': 'application/json', 'X-User-ID': 'test-snap' };
const SCOPE = 'x_test_snap';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { console.log('  ok  -', m); pass++; } else { console.error('  FAIL-', m); fail++; } };
function done(code) { try { db.close(); } catch { /* ignore */ } process.exit(code); }

async function post(p, body) {
  const r = await fetch(BASEURL + p, { method: 'POST', headers: HEADERS, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`POST ${p} -> ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

async function main() {
  await new Promise(r => setTimeout(r, 900));   // let app.listen bind

  const client = db.prepare('SELECT client_id FROM asdlc_client LIMIT 1').get();
  const pid = generateId();
  db.prepare(`INSERT INTO asdlc_project (project_id, client_id, project_name, project_code, servicenow_scope, servicenow_instance, confidence_threshold, sn_last_synced_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(pid, client.client_id, 'Snapshot Refresh Test', 'SNAP', SCOPE, 'https://example.service-now.com', 0.75, '2026-07-01 12:00:00');

  // Tool: SN changed (stale hash), reconcile (stub) → no_change → hash-advance path.
  const toolSalient = { name: 'Snap Tool', type: 'action', description: 'sn changed this description' };
  const toolArt = { source_table: 'sn_aia_tool', design_type: 'tool', source_sys_id: 'sysSNAP1', name: 'Snap Tool',
                    salient: toolSalient, hash: hashArtifact(toolSalient) };
  const toolId = generateId();
  db.prepare(`INSERT INTO asdlc_tool (tool_id, project_id, name, contract, source_system, source_sys_id, source_table, source_hash, source_fluent, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(toolId, pid, 'Snap Tool', '{"text":"rich"}', 'servicenow', 'sysSNAP1', 'sn_aia_tool', 'STALEHASH', 'OLD_SNAPSHOT_BODY',
         '2026-06-20 10:00:00', '2026-06-25 10:00:00');   // untouched since last sync — no both-side floor

  // Its generic twin (same sys_id) with equally stale provenance.
  const twinId = generateId();
  db.prepare(`INSERT INTO asdlc_sn_artifact (sn_artifact_id, project_id, sn_metadata_type, name, payload, source_sys_id, source_table, source_hash, source_fluent, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(twinId, pid, 'tool', 'Snap Tool', '{"name":"Snap Tool"}', 'sysSNAP1', 'sn_aia_tool', 'STALEHASH', 'OLD_TWIN_BODY',
         '2026-06-20 10:00:00', '2026-06-25 10:00:00');

  // Business-logic artifact whose salient carries a SCRIPT — snapshot must be the script body.
  const blSalient = { name: 'Snap Rule', collection: 'incident', when: 'before', script: 'if (current.state == 6) { gs.info("closed"); }' };
  const blArt = { source_table: 'sys_script', design_type: 'business_rule', source_sys_id: 'sysSNAP2', name: 'Snap Rule',
                  salient: blSalient, hash: hashArtifact(blSalient) };
  const blId = generateId();
  db.prepare(`INSERT INTO asdlc_business_logic (business_logic_id, project_id, name, logic_type, source_system, source_sys_id, source_table, source_hash, source_fluent, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(blId, pid, 'Snap Rule', 'business_rule', 'servicenow', 'sysSNAP2', 'sys_script', 'STALEHASH', 'OLD_SCRIPT',
         '2026-06-20 10:00:00', '2026-06-25 10:00:00');

  console.log('\n--- hash-advance refreshes the last-seen SN snapshot ---');
  const run = await post(`/projects/${pid}/servicenow/sync`, { artifacts: [toolArt, blArt], threshold: 0 });
  assert(run.result.hash_advanced === 2, 'both changed→no_change rows hash-advanced');

  const tool = db.prepare('SELECT source_hash, source_fluent FROM asdlc_tool WHERE tool_id = ?').get(toolId);
  assert(tool.source_hash === toolArt.hash, 'tool source_hash advanced');
  assert(tool.source_fluent === JSON.stringify(toolSalient),
         'tool source_fluent refreshed to the CURRENT captured salient (was OLD_SNAPSHOT_BODY)');

  const bl = db.prepare('SELECT source_hash, source_fluent FROM asdlc_business_logic WHERE business_logic_id = ?').get(blId);
  assert(bl.source_hash === blArt.hash, 'business-rule source_hash advanced');
  assert(bl.source_fluent === blSalient.script, 'logic snapshot is the real SCRIPT body (Tier-3 "as built")');

  const twin = db.prepare('SELECT source_hash, source_fluent FROM asdlc_sn_artifact WHERE sn_artifact_id = ?').get(twinId);
  assert(twin.source_hash === toolArt.hash, 'generic twin source_hash kept in lockstep with the L1 row');
  assert(twin.source_fluent === JSON.stringify(toolSalient), 'generic twin snapshot refreshed too');

  // Next sync: tier-0 unchanged (hash persistence still works after the wider UPDATE).
  const run2 = await post(`/projects/${pid}/servicenow/sync`, { artifacts: [toolArt, blArt], threshold: 0 });
  assert(run2.plan.classified_summary.unchanged === 2 && run2.plan.classified_summary.changed === 0,
         're-sync of identical capture: both rows tier-0 unchanged');
  assert(run2.result.hash_advanced === 0, 'no repeat hash-advance (idempotent)');

  // Null-safety: an artifact with NO salient must keep the previous snapshot (never blank it).
  console.log('\n--- capture without salient keeps the old snapshot ---');
  const bareArt = { source_table: 'sn_aia_tool', design_type: 'tool', source_sys_id: 'sysSNAP3', name: 'Bare Tool',
                    salient: null, hash: 'BAREHASH_NEW' };
  const bareId = generateId();
  db.prepare(`INSERT INTO asdlc_tool (tool_id, project_id, name, source_system, source_sys_id, source_table, source_hash, source_fluent, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(bareId, pid, 'Bare Tool', 'servicenow', 'sysSNAP3', 'sn_aia_tool', 'STALEHASH', 'PRECIOUS_OLD_BODY',
         '2026-06-20 10:00:00', '2026-06-25 10:00:00');
  await post(`/projects/${pid}/servicenow/sync`, { artifacts: [toolArt, blArt, bareArt], threshold: 0 });
  const bare = db.prepare('SELECT source_hash, source_fluent FROM asdlc_tool WHERE tool_id = ?').get(bareId);
  assert(bare.source_hash === 'BAREHASH_NEW', 'salient-less artifact still hash-advances');
  assert(bare.source_fluent === 'PRECIOUS_OLD_BODY', 'salient-less capture NEVER blanks the stored snapshot (COALESCE guard)');

  console.log(`\n=== test-snapshot-refresh: ${pass} passed, ${fail} failed ===`);
  done(fail ? 1 : 0);
}

main().catch(err => { console.error('FATAL', err); done(1); });
