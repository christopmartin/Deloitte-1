// test-keys-manifest.js — regression test for #87 (deploy identity / keys.ts seed manifest).
//
// The SDK's keys.ts is the source of truth for record identity: a Now.ID key that already
// maps to a sys_id is updated in place; a fresh key MINTS A NEW sys_id — so a deployer who
// isn't handed the known slug→sys_id mappings creates duplicates that the next inbound
// sync imports as "new". The Workbench knows those mappings for every synced record; the
// exports now emit them as a seed manifest (human table + machine-readable JSON + the
// key-stability invariants), in BOTH the SN Delta export and the full Build Spec.
//
// Run:  node test-keys-manifest.js   (from backend-node/)
'use strict';
const path = require('path');
const os   = require('os');

process.env.ASDLC_DB_PATH = path.join(os.tmpdir(), `asdlc_keys_${Date.now()}.db`);
process.env.PORT = String(8700 + Math.floor(Math.random() * 600));
process.env.ANTHROPIC_API_KEY = '';

const base = __dirname;
require(path.join(base, 'server.js'));
const { db, generateId } = require(path.join(base, 'db'));

const BASEURL = `http://127.0.0.1:${process.env.PORT}/api/v1`;

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { console.log('  ok  -', m); pass++; } else { console.error('  FAIL-', m); fail++; } };
function done(code) { try { db.close(); } catch { /* ignore */ } process.exit(code); }

async function getText(p) {
  const r = await fetch(BASEURL + p, { headers: { 'X-User-ID': 'test-keys' } });
  const text = await r.text();
  if (!r.ok) throw new Error(`GET ${p} -> ${r.status} ${text.slice(0, 200)}`);
  return text;
}

function makeProject(code) {
  const client = db.prepare('SELECT client_id FROM asdlc_client LIMIT 1').get();
  const pid = generateId();
  db.prepare(`INSERT INTO asdlc_project (project_id, client_id, project_name, project_code, servicenow_scope, servicenow_instance)
              VALUES (?,?,?,?,?,?)`)
    .run(pid, client.client_id, `Keys ${code}`, code, 'x_test_keys', 'https://example.service-now.com');
  return pid;
}

async function main() {
  await new Promise(r => setTimeout(r, 900));

  const pid = makeProject('KEYS1');
  const key8 = pid.slice(0, 8);
  db.prepare(`INSERT INTO asdlc_tool (tool_id, project_id, name, slug, source_system, source_sys_id, source_table)
              VALUES (?,?,?,?,?,?,?)`)
    .run(generateId(), pid, 'Linked Tool', 'T-901', 'servicenow', 'abc123def456', 'sn_aia_tool');
  const ucId = generateId();
  db.prepare(`INSERT INTO asdlc_use_case (use_case_id, project_id, title, slug) VALUES (?,?,?,?)`)
    .run(ucId, pid, 'Keys UC', 'UC-901');
  db.prepare(`INSERT INTO asdlc_agent_spec (agent_spec_id, use_case_id, project_id, name, slug, source_system, source_sys_id, source_table)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(generateId(), ucId, pid, 'Linked Agent', 'AG-901', 'servicenow', 'fed654cba321', 'sn_aia_agent');

  console.log('\n--- SN Delta export carries the keys.ts seed manifest ---');
  const delta = await getText(`/projects/${pid}/servicenow/delta-export`);
  assert(delta.includes('Deploy Identity — keys.ts Seed Manifest'), 'manifest section present in the delta export');
  assert(delta.includes(`wb-${key8}-t-901`), 'Now.ID key derived from project prefix + lowercase slug');
  assert(delta.includes('abc123def456') && delta.includes('fed654cba321'), 'known sys_ids listed for both linked records');
  assert(/Never rename a key once deployed/.test(delta), 'key-stability invariant stated (rename = orphaned record)');

  const jsonMatch = delta.match(/```json\n([\s\S]*?)\n```/);
  assert(!!jsonMatch, 'machine-readable JSON block present');
  if (jsonMatch) {
    const seed = JSON.parse(jsonMatch[1]);
    const tool = seed.find(e => e.slug === 'T-901');
    assert(tool && tool.key === `wb-${key8}-t-901` && tool.sys_id === 'abc123def456' && tool.table === 'sn_aia_tool',
           'JSON seed entry carries {key, slug, table, sys_id} for scripting keys.ts');
  }

  console.log('\n--- Full Build Spec carries it too ---');
  const spec = await getText(`/projects/${pid}/build-export`);
  assert(spec.includes('Deploy Identity — keys.ts Seed Manifest'), 'manifest section present in the full Build Spec');
  assert(spec.includes(`wb-${key8}-ag-901`), 'agent key present in the Build Spec manifest');

  console.log('\n--- Never-deployed project gets the create-path guidance ---');
  const pid2 = makeProject('KEYS2');
  const delta2 = await getText(`/projects/${pid2}/servicenow/delta-export`);
  assert(delta2.includes('Deploy Identity — keys.ts Seed Manifest'), 'manifest section still present');
  assert(/every deploy below is a CREATE/i.test(delta2), 'no-linked-records case states the create-path rule instead of an empty table');

  console.log(`\n=== test-keys-manifest: ${pass} passed, ${fail} failed ===`);
  done(fail ? 1 : 0);
}

main().catch(err => { console.error('FATAL', err); done(1); });
