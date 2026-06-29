// test-instance-catalog.js — SN Instance Catalog (whole-instance awareness) test.
// Fully offline (no ANTHROPIC_API_KEY → Opus stubs; no live SN → mock fetchImpl).
//
// Part 1 (pure): captureInstanceCatalog hybrid filter + query rules; computeCollisions;
//                detectExistenceDrift (vanished / moved / untracked).
// Part 2 (endpoints): catalog/latest (?full gate), catalog/drift, POST catalog 202.
// Part 3 (R1 self-heal): a Workbench-authored CREATE re-captured by its [[wb:…]] tag
//                gets source_sys_id back-filled by /sync (no duplicate); name-only match
//                does NOT auto-register (guard).
//
// Run:  node test-instance-catalog.js   (from backend-node/)
'use strict';
const path = require('path');
const os   = require('os');

process.env.ASDLC_DB_PATH = path.join(os.tmpdir(), `asdlc_catalog_${Date.now()}.db`);
process.env.PORT = String(9300 + Math.floor(Math.random() * 500));
process.env.ANTHROPIC_API_KEY = '';   // stub mode — deterministic + free

const base = __dirname;
require(path.join(base, 'server.js'));                        // boots + seeds + listens
const { db, generateId } = require(path.join(base, 'db'));
const { hashArtifact } = require(path.join(base, 'agent', 'sn-capture'));
const cat = require(path.join(base, 'agent', 'sn-instance-catalog'));

const BASEURL = `http://127.0.0.1:${process.env.PORT}/api/v1`;
const HEADERS = { 'Content-Type': 'application/json', 'X-User-ID': 'test-catalog' };

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { console.log('  ok  -', m); pass++; } else { console.error('  FAIL-', m); fail++; } };
function done(code) { try { db.close(); } catch { /* ignore */ } process.exit(code); }

async function get(p)  { const r = await fetch(BASEURL + p, { headers: HEADERS }); const j = await r.json().catch(() => ({})); return { status: r.status, j }; }
async function post(p, body) { const r = await fetch(BASEURL + p, { method: 'POST', headers: HEADERS, body: JSON.stringify(body || {}) }); const j = await r.json().catch(() => ({})); return { status: r.status, j }; }

// ── Part 1a: captureInstanceCatalog with a mock fetchImpl ─────────────────────
async function testCapture() {
  console.log('\n--- Part 1a: captureInstanceCatalog (hybrid filter + query rules) ---');
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const tableMatch = /\/api\/now\/table\/([a-z0-9_]+)\?/.exec(url);
    const table = tableMatch ? tableMatch[1] : '';
    let result = [];
    if (table === 'sys_db_object') result = [{ sys_id: 't1', name: 'x_app_thing', label: 'Thing', super_class: 'task', 'sys_scope.scope': 'x_app' }];
    else if (table === 'sn_aia_agent') result = [{ sys_id: 'a1', name: 'Triage Agent', role: 'analyst', 'sys_scope.scope': 'x_app' }];
    return { ok: true, status: 200, json: async () => ({ result }) };
  };
  const out = await cat.captureInstanceCatalog({ instance: 'dev123.service-now.com', user: 'u', pw: 'p', fetchImpl });

  const agentUrl = decodeURIComponent(urls.find(u => /\/sn_aia_agent\?/.test(u)) || '');
  const tableUrl = decodeURIComponent(urls.find(u => /\/sys_db_object\?/.test(u)) || '');
  assert(/ORDERBYsys_id/.test(agentUrl), 'every query carries ^ORDERBYsys_id (stable pagination)');
  assert(/sysparm_display_value=true/.test(agentUrl), 'queries set display_value=true (readable discriminators)');
  assert(agentUrl.includes('sys_scope.scope!=global'), 'custom surface (sn_aia_agent) filters scope!=global');
  assert(tableUrl && !tableUrl.includes('scope!=global'), 'instance surface (sys_db_object) is NOT scope-filtered');

  const agents = out.surfaces.sn_aia_agent || [];
  assert(agents.length === 1 && agents[0].sys_id === 'a1' && agents[0].name === 'Triage Agent' && agents[0].scope === 'x_app' && agents[0].role === 'analyst',
    'entry shaped {sys_id,name,scope,+discriminators}');
  assert(out.capturing_user === 'u' && typeof out.captured_at === 'string', 'catalog stamps capturing_user + captured_at');

  const summary = cat.summarizeCatalog(out);
  assert(summary.surface_counts.sn_aia_agent === 1 && summary.total_entries >= 2, 'summarizeCatalog rolls up per-surface counts');
}

// ── Part 1b: computeCollisions ────────────────────────────────────────────────
function testCollisions() {
  console.log('\n--- Part 1b: computeCollisions ---');
  const catalog = { surfaces: {
    sn_aia_agent: [{ sys_id: 'a1', name: 'Triage Agent', scope: 'x_app' }, { sys_id: 'a2', name: 'Other Agent', scope: 'x_other' }],
    sys_db_object: [{ sys_id: 't1', name: 'x_app_inc', scope: 'x_app' }],
  }};
  // Same-scope per-scope-unique → hard.
  let c = cat.computeCollisions(catalog, [{ kind: 'agent_spec', name: 'Triage Agent', surfaces: ['sn_aia_agent'], scope: 'x_app', instanceUnique: false }]);
  assert(c.length === 1 && c[0].hard && c[0].same_scope, 'per-scope same-scope name match → hard collision');
  // Other-scope per-scope-unique → soft (informational).
  c = cat.computeCollisions(catalog, [{ kind: 'agent_spec', name: 'Other Agent', surfaces: ['sn_aia_agent'], scope: 'x_app', instanceUnique: false }]);
  assert(c.length === 1 && !c[0].hard && !c[0].same_scope, 'per-scope OTHER-scope match → soft (not hard)');
  // instanceUnique any-scope → hard (table name).
  c = cat.computeCollisions(catalog, [{ kind: 'data_model', name: 'x_app_inc', surfaces: ['sys_db_object'], scope: 'x_zzz', instanceUnique: true }]);
  assert(c.length === 1 && c[0].hard, 'instance-unique surface → any-scope match is hard');
  // No match → no collision.
  c = cat.computeCollisions(catalog, [{ kind: 'agent_spec', name: 'Brand New', surfaces: ['sn_aia_agent'], scope: 'x_app', instanceUnique: false }]);
  assert(c.length === 0, 'no name match → no collision');
}

// ── Part 1c: detectExistenceDrift ─────────────────────────────────────────────
function testDrift() {
  console.log('\n--- Part 1c: detectExistenceDrift (vanished / moved / untracked) ---');
  const client = db.prepare('SELECT client_id FROM asdlc_client LIMIT 1').get();
  const pid = generateId();
  db.prepare(`INSERT INTO asdlc_project (project_id, client_id, project_name, project_code, servicenow_scope)
              VALUES (?,?,?,?,?)`).run(pid, client.client_id, 'Drift Test', 'DRIFT', 'x_app');
  const mkTool = (sysId, name, scope) => db.prepare(
    `INSERT INTO asdlc_tool (tool_id, project_id, name, source_system, source_sys_id, source_table, source_scope) VALUES (?,?,?,?,?,?,?)`
  ).run(generateId(), pid, name, 'servicenow', sysId, 'sn_aia_tool', scope);
  mkTool('sysLIVE', 'Live Tool', 'x_app');
  mkTool('sysGONE', 'Gone Tool', 'x_app');
  mkTool('sysMOVED', 'Moved Tool', 'x_app');

  const catalog = { surfaces: { sn_aia_tool: [
    { sys_id: 'sysLIVE',   name: 'Live Tool',    scope: 'x_app' },
    { sys_id: 'sysMOVED',  name: 'Moved Tool',   scope: 'x_other' },
    { sys_id: 'sysNETNEW', name: 'Net New Tool', scope: 'x_app' },
  ] } };
  const d = cat.detectExistenceDrift(pid, catalog, { projectScope: 'x_app' });
  assert(d.vanished.some(v => v.source_sys_id === 'sysGONE') && !d.vanished.some(v => v.source_sys_id === 'sysLIVE'),
    'vanished = WB sys_id absent from catalog (sysGONE), present ones excluded');
  assert(d.moved.some(m => m.source_sys_id === 'sysMOVED' && m.from_scope === 'x_app' && m.to_scope === 'x_other'),
    'moved = present under a different scope (sysMOVED x_app→x_other), not flagged vanished');
  assert(!d.vanished.some(v => v.source_sys_id === 'sysMOVED'), 'moved record is NOT also reported vanished');
  assert(d.untracked.some(u => u.sys_id === 'sysNETNEW') && !d.untracked.some(u => u.sys_id === 'sysLIVE'),
    'untracked = catalog entry in project scope unknown to WB (sysNETNEW net-new)');
  return pid;
}

// ── Part 2: endpoints (latest ?full gate, drift, POST 202) ────────────────────
async function testEndpoints(driftPid) {
  console.log('\n--- Part 2: catalog endpoints ---');
  // Seed a completed catalog run directly (POST does a LIVE capture we can't mock here).
  const crid = generateId();
  const catalog = { captured_at: '2026-06-24T00:00:00.000Z', instance_url: 'https://dev.service-now.com',
    capturing_user: 'svc', surfaces: { sn_aia_tool: [
      { sys_id: 'sysLIVE', name: 'Live Tool', scope: 'x_app' },
      { sys_id: 'sysNETNEW', name: 'Net New Tool', scope: 'x_app' },
    ] }, warnings: [] };
  const summary = cat.summarizeCatalog(catalog);
  db.prepare(`INSERT INTO asdlc_sn_catalog_run (catalog_run_id, project_id, instance_url, capturing_user, status, catalog_json, summary_json)
              VALUES (?,?,?,?,'complete',?,?)`).run(crid, driftPid, catalog.instance_url, 'svc', JSON.stringify(catalog), JSON.stringify(summary));

  let r = await get(`/projects/${driftPid}/servicenow/catalog/latest`);
  assert(r.status === 200 && r.j.summary && r.j.summary.total_entries === 2, 'GET latest returns summary');
  assert(r.j.catalog === undefined, 'GET latest WITHOUT ?full=1 omits the heavy catalog_json');
  r = await get(`/projects/${driftPid}/servicenow/catalog/latest?full=1`);
  assert(r.status === 200 && r.j.catalog && r.j.catalog.surfaces, 'GET latest?full=1 includes the full catalog');

  r = await get(`/projects/${driftPid}/servicenow/catalog/drift`);
  assert(r.status === 200 && r.j.untracked.some(u => u.sys_id === 'sysNETNEW'), 'GET drift surfaces untracked net-new');
  assert(r.j.vanished.some(v => v.source_sys_id === 'sysGONE'), 'GET drift surfaces vanished');
  assert(typeof r.j.caveat === 'string' && /ACL/.test(r.j.caveat), 'GET drift carries the ACL completeness caveat');

  // POST catalog → 202 + a row created (background capture will fail on a bogus instance).
  const linkClient = db.prepare('SELECT client_id FROM asdlc_client LIMIT 1').get();
  const pid2 = generateId();
  db.prepare(`INSERT INTO asdlc_project (project_id, client_id, project_name, project_code, servicenow_instance, sn_user, sn_password_enc)
              VALUES (?,?,?,?,?,?,?)`).run(pid2, linkClient.client_id, 'Cat POST', 'CATPOST', 'https://bogus.example.invalid', 'u', 'enc');
  const pr = await post(`/projects/${pid2}/servicenow/catalog`, { instance: 'https://bogus.example.invalid', user: 'u', pw: 'p' });
  assert(pr.status === 202 && pr.j.catalog_run_id && pr.j.status === 'running', 'POST catalog → 202 running');
  const row = db.prepare('SELECT status FROM asdlc_sn_catalog_run WHERE catalog_run_id=?').get(pr.j.catalog_run_id);
  assert(!!row, 'POST catalog created a run row');
}

// ── Part 3: R1 link self-heal via /servicenow/sync ────────────────────────────
async function testSelfHeal() {
  console.log('\n--- Part 3: R1 link self-heal (no-duplicate) ---');
  const client = db.prepare('SELECT client_id FROM asdlc_client LIMIT 1').get();
  const pid = generateId();
  const SCOPE = 'x_heal';
  db.prepare(`INSERT INTO asdlc_project (project_id, client_id, project_name, project_code, servicenow_scope, servicenow_instance, confidence_threshold)
              VALUES (?,?,?,?,?,?,?)`).run(pid, client.client_id, 'Heal Test', 'HEAL', SCOPE, 'https://example.service-now.com', 0.75);

  // A Workbench-AUTHORED tool: has a slug, NO source_sys_id. It was "deployed" — the
  // captured record carries the [[wb:pid/slug]] tag and a real sys_id. source_hash is set
  // to the captured hash so it classifies UNCHANGED (the common, no-CP case).
  const healId = generateId();
  const salient = { name: 'Deployed Tool', type: 'action', description: `Does a thing [[wb:${pid}/T-901]]` };
  const h = hashArtifact(salient);
  db.prepare(`INSERT INTO asdlc_tool (tool_id, project_id, name, slug, contract, source_system, source_hash)
              VALUES (?,?,?,?,?,?,?)`).run(healId, pid, 'Deployed Tool', 'T-901', '{"text":"c"}', 'workbench', h);
  const deployedArt = { source_table: 'sn_aia_tool', design_type: 'tool', source_sys_id: 'sysHEAL999', name: 'Deployed Tool', salient, hash: h };

  // A name-only lookalike (guard): same NAME as a WB tool but no tag → must NOT auto-register.
  const guardId = generateId();
  db.prepare(`INSERT INTO asdlc_tool (tool_id, project_id, name, slug, contract, source_system) VALUES (?,?,?,?,?,?)`)
    .run(guardId, pid, 'Guard Tool', 'T-902', '{"text":"g"}', 'workbench');
  const guardSalient = { name: 'Guard Tool', type: 'action', description: 'no tag here' };
  const guardArt = { source_table: 'sn_aia_tool', design_type: 'tool', source_sys_id: 'sysGUARD000', name: 'Guard Tool', salient: guardSalient, hash: hashArtifact(guardSalient) };

  const r = await fetch(`${BASEURL}/projects/${pid}/servicenow/sync`, {
    method: 'POST', headers: HEADERS, body: JSON.stringify({ artifacts: [deployedArt, guardArt], threshold: 0 }),
  });
  const j = await r.json().catch(() => ({}));
  assert(r.ok, 'sync ran');
  assert(j.result && j.result.links_healed >= 1, `sync self-healed the tag-matched link (links_healed=${j.result && j.result.links_healed})`);

  const healed = db.prepare('SELECT source_sys_id FROM asdlc_tool WHERE tool_id=?').get(healId);
  assert(healed.source_sys_id === 'sysHEAL999', 'tag-matched WB row back-filled source_sys_id (next delta = PATCH, no duplicate)');

  const guard = db.prepare('SELECT source_sys_id FROM asdlc_tool WHERE tool_id=?').get(guardId);
  assert(!guard.source_sys_id, 'name-only lookalike was NOT auto-registered (guard holds — only qualified tag heals)');
}

// ── Part 4: Build Spec "## Instance Context" injection (collision in the spec) ─
async function testBuildSpecInjection() {
  console.log('\n--- Part 4: Build Spec Instance Context injection ---');
  const client = db.prepare('SELECT client_id FROM asdlc_client LIMIT 1').get();
  const pid = generateId();
  db.prepare(`INSERT INTO asdlc_project (project_id, client_id, project_name, project_code, servicenow_scope)
              VALUES (?,?,?,?,?)`).run(pid, client.client_id, 'Spec Test', 'SPEC', 'x_spec');
  // A CREATE (no source_sys_id) named the same as an existing instance record.
  const ucId = generateId();
  db.prepare(`INSERT INTO asdlc_use_case (use_case_id, project_id, title) VALUES (?,?,?)`).run(ucId, pid, 'Spec UC');
  db.prepare(`INSERT INTO asdlc_agent_spec (agent_spec_id, project_id, use_case_id, name, slug) VALUES (?,?,?,?,?)`)
    .run(generateId(), pid, ucId, 'Triage Agent', 'AG-001');
  const catalog = { captured_at: '2026-06-24T00:00:00.000Z', capturing_user: 'svc',
    surfaces: { sn_aia_agent: [{ sys_id: 'sysAG', name: 'Triage Agent', scope: 'x_spec', role: 'analyst' }] }, warnings: [] };
  db.prepare(`INSERT INTO asdlc_sn_catalog_run (catalog_run_id, project_id, instance_url, capturing_user, status, catalog_json, summary_json)
              VALUES (?,?,?,?,'complete',?,?)`)
    .run(generateId(), pid, 'https://x', 'svc', JSON.stringify(catalog), JSON.stringify(cat.summarizeCatalog(catalog)));

  const r = await fetch(`${BASEURL}/projects/${pid}/build-export`, { headers: HEADERS });
  const md = await r.text();
  assert(r.ok && md.includes('## Instance Context'), 'build-export emits ## Instance Context section');
  assert(/Name collisions/.test(md) && md.includes('Triage Agent'), 'collision for a same-name CREATE is surfaced in the spec');
  assert(md.includes('Completeness caveat'), 'spec carries the ACL completeness caveat');

  // No-catalog project → the explanatory note, not a crash.
  const pid2 = generateId();
  db.prepare(`INSERT INTO asdlc_project (project_id, client_id, project_name, project_code, servicenow_scope)
              VALUES (?,?,?,?,?)`).run(pid2, client.client_id, 'No Cat', 'NOCAT', 'x_nocat');
  const r2 = await fetch(`${BASEURL}/projects/${pid2}/build-export`, { headers: HEADERS });
  const md2 = await r2.text();
  assert(r2.ok && /No instance catalog has been captured/.test(md2), 'no-catalog project shows the "run a catalog" note (no crash)');
}

async function main() {
  await new Promise(r => setTimeout(r, 900));   // let app.listen bind
  await testCapture();
  testCollisions();
  const driftPid = testDrift();
  await testEndpoints(driftPid);
  await testSelfHeal();
  await testBuildSpecInjection();
  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  done(fail ? 1 : 0);
}

main().catch(e => { console.error('TEST ERROR', e); done(1); });
