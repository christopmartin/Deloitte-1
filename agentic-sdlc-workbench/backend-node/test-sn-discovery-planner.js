// test-sn-discovery-planner.js — requirements-driven ServiceNow discovery planner.
//
// Covers:
//   - stub planDiscovery() deterministic shape (direct + related via the reference graph)
//   - buildPlanUserMessage() renders requirements + inventory + reference edges
//   - buildDiscoveryInventory() merges census + sweep + custom tables, drops zero-record rows
//   - readReferenceGraph() parses sys_dictionary reference rows into edges; best-effort on failure
//   - captureScope(): a slice naming a table OUTSIDE the curated/generic/child surfaces is still
//     fetched generically (decision #2); a whole-scope (no slice) capture is UNCHANGED
//   - HTTP: GET discovery-plan, approve -> writes the import-profile slice via the SAME path
//     the manual grid uses, and the full generate->persist pipeline (mocked global fetch, stub AI)
//
// Run:  node test-sn-discovery-planner.js   (from backend-node/)
'use strict';
const path = require('path');
const os = require('os');

process.env.ASDLC_DB_PATH = path.join(os.tmpdir(), `asdlc_discplan_${Date.now()}.db`);
process.env.PORT = String(8900 + Math.floor(Math.random() * 400));
process.env.ANTHROPIC_API_KEY = '';

// Mock global fetch BEFORE requiring server.js — the discovery-plan generate endpoint has no
// artifacts-injection escape hatch (unlike the sync endpoints), so every live-ServiceNow read
// it makes (checkConnection, sweepScopeMetadata, listCustomDataTables, readReferenceGraph) falls
// through to the global fetch. mockRoutes.current is swapped per-test-section.
const mockRoutes = { current: null };
const realFetch = global.fetch;   // preserved for the test's OWN calls to the local test server
global.fetch = async (url, opts) => {
  const handler = mockRoutes.current;
  if (handler) {
    const r = handler(String(url), opts);
    if (r) return r;
  }
  return { ok: false, status: 0, json: async () => null, headers: { get: () => null } };
};

const base = __dirname;
require(path.join(base, 'server.js'));
const { db, generateId } = require(path.join(base, 'db'));
const cap = require(path.join(base, 'agent', 'sn-capture'));
const planner = require(path.join(base, 'agent', 'sn-discovery-planner'));

const BASEURL = `http://127.0.0.1:${process.env.PORT}/api/v1`;
const HEADERS = { 'Content-Type': 'application/json', 'X-User-ID': 'test-discplan' };

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  -', m); } else { fail++; console.error('  FAIL-', m); } };
function done(code) { try { db.close(); } catch { /* ignore */ } process.exit(code); }
async function post(p, body) { const r = await realFetch(BASEURL + p, { method: 'POST', headers: HEADERS, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; }
async function get(p) { const r = await realFetch(BASEURL + p, { headers: HEADERS }); return { status: r.status, body: await r.json().catch(() => ({})) }; }

function makeProject(scope) {
  const cid = generateId();
  db.prepare("INSERT INTO asdlc_client (client_id,client_name,client_code) VALUES (?,?,?)").run(cid, 'Client', cid.slice(0, 8));
  const pid = generateId();
  db.prepare(`INSERT INTO asdlc_project (project_id, client_id, project_name, project_code, servicenow_scope, servicenow_instance, confidence_threshold)
              VALUES (?,?,?,?,?,?,?)`)
    .run(pid, cid, 'DiscPlan', `DP-${Date.now().toString(36).slice(-5)}${Math.floor(Math.random() * 1000)}`, scope, 'https://example.service-now.com', 0.75);
  return pid;
}

(async () => {
  // ── Part 1: stub planDiscovery() — deterministic, offline ───────────────────
  console.log('--- Part 1: stub plan shape ---');
  const inventory = {
    scope: 'x_test',
    tables: [
      { table: 'sc_cat_item', kind: 'curated-rich', design_type: 'catalog_item', records: 4 },
      // generic (not curated-rich) with records — only reachable via the reference graph below,
      // isolating the "related" path from the "direct" one.
      { table: 'sys_hub_flow', kind: 'generic', design_type: 'workflow', records: 1 },
      { table: 'item_option_new', kind: 'generic', design_type: null, records: 6 },
      { table: 'sys_script', kind: 'curated-rich', design_type: 'business_logic', records: 0 },   // zero records
    ],
    edges: [{ from_table: 'sc_cat_item', field: 'workflow', to_table: 'sys_hub_flow', label: 'Workflow' }],
  };
  const { plan: stub, stub: isStub } = await planner.planDiscovery({ requirements: [], inventory, scope: 'x_test' }, {});
  ok(isStub === true, 'no API key -> stub:true');
  ok(stub.include.some(i => i.table === 'sc_cat_item' && i.relation === 'direct'), 'stub includes curated table with records (direct)');
  ok(stub.include.some(i => i.table === 'sys_hub_flow' && i.relation === 'related' && i.related_to === 'sc_cat_item'), 'stub includes referenced table (related, related_to set)');
  ok(!stub.include.some(i => i.table === 'sys_script'), 'stub excludes a zero-record curated table');
  ok(!stub.include.some(i => i.table === 'item_option_new'), 'stub does not seed a direct inclusion from a generic table');

  // ── Part 2: buildPlanUserMessage() renders requirements + inventory + edges ──
  console.log('\n--- Part 2: prompt rendering ---');
  const msg = planner.buildPlanUserMessage({
    requirements: [{ req_type: 'functional', slug: 'FR-001', text: 'Users can order the laptop catalog item' }],
    inventory, scope: 'x_test',
  });
  ok(msg.includes('FR-001') && msg.includes('laptop catalog item'), 'prompt includes requirement text');
  ok(msg.includes('sc_cat_item') && msg.includes('curated-rich'), 'prompt includes an inventory table line');
  ok(msg.includes('sc_cat_item.workflow -> sys_hub_flow'), 'prompt includes the reference-graph edge');

  // ── Part 3: buildDiscoveryInventory() merge logic ────────────────────────────
  console.log('\n--- Part 3: buildDiscoveryInventory ---');
  const report = {
    scope_reports: [{ scope: 'x_test', surfaces: [
      { table: 'sc_cat_item', wbDesignType: 'catalog_item', present: true, count: 4 },
      { table: 'sys_script', wbDesignType: 'business_logic', present: true, count: 0 },
    ] }],
  };
  const sweep = { available: true, byClass: { sys_security_acl: 12, sc_cat_item: 4 } };
  const customTables = [{ table: 'x_acme_incident_extra', label: 'Incident Extra', records: 9 }];
  const inv2 = planner.buildDiscoveryInventory({ report, sweep, customTables, edges: [], scope: 'x_test' });
  ok(inv2.tables.some(t => t.table === 'sc_cat_item' && t.kind === 'curated-rich'), 'census surface included as curated-rich');
  ok(!inv2.tables.some(t => t.table === 'sys_script'), 'zero-record census surface dropped');
  ok(inv2.tables.some(t => t.table === 'sys_security_acl' && t.kind === 'generic'), 'sweep class (not already curated) included as generic');
  ok(inv2.tables.filter(t => t.table === 'sc_cat_item').length === 1, 'sweep does not duplicate an already-curated table');
  ok(inv2.tables.some(t => t.table === 'x_acme_incident_extra' && t.kind === 'generic' && t.records === 9), 'custom sys_db_object table included as generic with its count');

  // ── Part 4: readReferenceGraph() — parses sys_dictionary + best-effort on failure ─
  console.log('\n--- Part 4: readReferenceGraph ---');
  const dictRows = [
    { name: 'sc_cat_item', element: 'workflow', reference: 'sys_hub_flow', column_label: 'Workflow' },
    { name: 'sc_cat_item', element: 'category', reference: 'sc_category', column_label: 'Category' },
  ];
  const mockDictFetch = async () => ({ ok: true, status: 200, json: async () => ({ result: dictRows }) });
  const graph = await cap.readReferenceGraph({ instance: 'https://t', user: 'u', pw: 'p', fetchImpl: mockDictFetch, tables: ['sc_cat_item'] });
  ok(graph.available === true && graph.edges.length === 2, 'readReferenceGraph parses reference rows into edges');
  ok(graph.edges.some(e => e.from_table === 'sc_cat_item' && e.to_table === 'sys_hub_flow'), 'edge shape is correct');

  const emptyGraph = await cap.readReferenceGraph({ instance: 'https://t', user: 'u', pw: 'p', tables: [] });
  ok(emptyGraph.available === true && emptyGraph.edges.length === 0, 'no candidate tables -> empty, available graph (no I/O)');

  const failFetch = async () => { throw new Error('network down'); };
  const failedGraph = await cap.readReferenceGraph({ instance: 'https://t', user: 'u', pw: 'p', fetchImpl: failFetch, tables: ['sc_cat_item'] });
  ok(failedGraph.available === false && failedGraph.edges.length === 0, 'a fetch failure degrades to an empty, unavailable graph — never throws');

  // ── Part 5: captureScope() — extra slice surface (decision #2) ──────────────
  console.log('\n--- Part 5: extra-slice-surface capture ---');
  const CUSTOM_TABLE = 'x_acme_incident_extra';
  const queried = new Set();
  function mockCaptureFetch(url) {
    const tbl = (url.match(/\/api\/now\/table\/([^?]+)/) || [])[1];
    queried.add(tbl);
    let all = [];
    if (tbl === CUSTOM_TABLE) all = [{ sys_id: 'X1', name: 'Row 1', priority: '2' }, { sys_id: 'X2', name: 'Row 2', priority: '3' }];
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ result: all }) });
  }
  const withExtra = await cap.captureScope({ scope: 'x', instance: 'https://t', user: 'u', pw: 'p', fetchImpl: mockCaptureFetch, slice: { include_surfaces: [CUSTOM_TABLE] } });
  ok(queried.has(CUSTOM_TABLE), 'a slice-named table outside SN_SURFACES/genericSurfaces/CHILD_SURFACES IS queried');
  const extraArts = withExtra.filter(a => a.source_table === CUSTOM_TABLE && !a.__error);
  ok(extraArts.length === 2, 'both rows of the extra custom table are captured');
  ok(extraArts.every(a => a.generic === true && a.tier === 'C'), 'extra-surface rows are generic Tier-C artifacts (existing substrate, no new materializer)');

  queried.clear();
  await cap.captureScope({ scope: 'x', instance: 'https://t', user: 'u', pw: 'p', fetchImpl: mockCaptureFetch, slice: null });
  ok(!queried.has(CUSTOM_TABLE), 'whole-scope (no slice) capture is UNCHANGED — never probes an arbitrary table name');

  // ── Part 6: HTTP — approve maps a draft plan to the import-profile slice ────
  console.log('\n--- Part 6: HTTP approve ---');
  const pid = makeProject('x_test_http');
  const planId = generateId();
  db.prepare(`INSERT INTO asdlc_sn_discovery_plan (plan_id, project_id, scope, status, plan_json, created_by, updated_at)
              VALUES (?,?,?, 'draft', ?, ?, datetime('now'))`)
    .run(planId, pid, 'x_test_http', JSON.stringify({
      include: [
        { table: 'sc_cat_item', relation: 'direct', rationale: 'FR-001', mapped_requirement_slugs: ['FR-001'], confidence: 0.9 },
        { table: 'sys_hub_flow', relation: 'related', related_to: 'sc_cat_item', rationale: 'fulfillment', confidence: 0.7, record_filter: 'active=true' },
      ], exclude: [{ table: 'sys_script', reason: 'not referenced by any requirement' }], notes: 'test plan',
    }), 'tester');

  const missing = await post(`/projects/${pid}/servicenow/discovery-plan/nope/approve`, {});
  ok(missing.status === 404, 'approving an unknown plan_id -> 404');

  const approved = await post(`/projects/${pid}/servicenow/discovery-plan/${planId}/approve`, {});
  ok(approved.status === 200, `approve succeeds (got ${approved.status}: ${JSON.stringify(approved.body)})`);
  ok(approved.body.status === 'approved', 'plan status flips to approved');
  ok((approved.body.profile.include_surfaces || []).sort().join(',') === 'sc_cat_item,sys_hub_flow', "approved profile.include_surfaces = the plan's included tables");
  ok(approved.body.profile.record_filters && approved.body.profile.record_filters.sys_hub_flow === 'active=true', "a per-table record_filter from the plan folds into the slice's record_filters");

  const savedProfile = db.prepare('SELECT sn_import_profile_json FROM asdlc_project WHERE project_id=?').get(pid);
  ok(!!savedProfile.sn_import_profile_json, 'the SAME import-profile column the manual grid writes is now populated');

  // ── Part 7: HTTP — GET returns the latest plan ───────────────────────────────
  console.log('\n--- Part 7: HTTP get ---');
  const got = await get(`/projects/${pid}/servicenow/discovery-plan`);
  ok(got.status === 200 && got.body.plan_id === planId, 'GET returns the latest plan for the project');
  ok(got.body.plan && got.body.plan.include.length === 2, 'plan_json is parsed back into an object');

  const noPlan = await get(`/projects/${generateId()}/servicenow/discovery-plan`);
  ok(noPlan.status === 200 && noPlan.body.plan === null, 'a project with no plans yet returns {plan:null}');

  // ── Part 8: HTTP — generate end-to-end (mocked network, stub AI) ─────────────
  console.log('\n--- Part 8: HTTP generate (mocked network) ---');
  const pid2 = makeProject('x_test_gen');
  const asrId = generateId();
  db.prepare(`INSERT INTO asdlc_sn_assessment (assessment_id, project_id, status, report_json, created_at)
              VALUES (?,?, 'complete', ?, datetime('now'))`)
    .run(asrId, pid2, JSON.stringify({ scope_reports: [{ scope: 'x_test_gen', surfaces: [{ table: 'sc_cat_item', wbDesignType: 'catalog_item', present: true, count: 3 }] }] }));

  mockRoutes.current = (url) => {
    if (url.includes('/api/now/table/sys_properties')) return { ok: true, status: 200, json: async () => ({ result: [{ sys_id: '1' }] }), headers: { get: () => null } };
    if (url.includes('/api/now/table/sys_metadata')) return { ok: true, status: 200, json: async () => ({ result: [{ sys_id: 'M1', sys_class_name: 'sc_cat_item' }] }), headers: { get: () => null } };
    return { ok: true, status: 200, json: async () => ({ result: [] }), headers: { get: () => null } };
  };

  const gen = await post(`/projects/${pid2}/servicenow/discovery-plan`, { instance: 'https://example.service-now.com', user: 'u', pw: 'p' });
  ok(gen.status === 200, `generate succeeds (got ${gen.status}: ${JSON.stringify(gen.body)})`);
  ok(gen.body._stub === true, 'generate ran in stub AI mode (no ANTHROPIC_API_KEY)');
  ok(gen.body.plan && Array.isArray(gen.body.plan.include), 'generate returns a plan with an include[] array');
  ok(gen.body.status === 'draft', 'a freshly generated plan is draft, not approved');
  mockRoutes.current = null;

  const pid3 = makeProject('x_test_noassess');
  const noAssess = await post(`/projects/${pid3}/servicenow/discovery-plan`, { instance: 'https://example.service-now.com', user: 'u', pw: 'p' });
  ok(noAssess.status === 409, 'generating without a completed assessment first -> 409, not a silent empty plan');

  console.log(`\n${pass} passed, ${fail} failed`);
  done(fail ? 1 : 0);
})().catch(err => { console.error('FATAL', err); done(1); });
