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
const fs = require('fs');
require(path.join(base, 'server.js'));
const { db, generateId } = require(path.join(base, 'db'));
const cap = require(path.join(base, 'agent', 'sn-capture'));
const planner = require(path.join(base, 'agent', 'sn-discovery-planner'));
const crossCheck = require(path.join(base, 'agent', 'cross-check'));

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
function makeIngestDoc(pid) {
  const iid = generateId();
  db.prepare(`INSERT INTO asdlc_ingest_document (ingest_id, project_id, document_title, ingest_status) VALUES (?,?,?, 'staged')`)
    .run(iid, pid, 'Test Doc');
  return iid;
}
function stageExtraction(ingestId, entityType, data, status) {
  const eid = generateId();
  db.prepare(`INSERT INTO asdlc_ingest_extraction (extraction_id, ingest_id, entity_type, entity_data, confidence, status, round, created_at)
              VALUES (?,?,?,?,?,?,1,datetime('now'))`)
    .run(eid, ingestId, entityType, JSON.stringify(data), 0.8, status || 'staged');
  return eid;
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

  // ── Part 6: loadDocumentRequirements() — document-scoped, pre-promote ───────
  console.log('\n--- Part 6: loadDocumentRequirements ---');
  const pidReq = makeProject('x_test_req');
  const iidReq = makeIngestDoc(pidReq);
  stageExtraction(iidReq, 'functional_req', { title: 'Order laptop', description: 'Users order a laptop.' }, 'staged');
  stageExtraction(iidReq, 'functional_req', { title: 'Track order', description: 'Users track fulfillment.' }, 'needs_clarification');
  stageExtraction(iidReq, 'nonfunctional_req', { title: 'Fast fulfillment', description: 'Must be quick.', measurable_target: '< 3 days' }, 'staged');
  stageExtraction(iidReq, 'functional_req', { title: 'Rejected one', description: 'Should not appear.' }, 'rejected');
  stageExtraction(iidReq, 'functional_req', { title: 'Already promoted', description: 'Should not appear either.' }, 'promoted');

  const docReqs = crossCheck.loadDocumentRequirements(iidReq);
  ok(docReqs.length === 3, `returns only staged/needs_clarification FR+NFR (got ${docReqs.length})`);
  ok(docReqs.filter(r => r.req_type === 'functional').every(r => /^FR-draft-\d+$/.test(r.slug)), 'FR rows get a synthesized FR-draft-N ref, not a real slug');
  ok(docReqs.find(r => r.req_type === 'nonfunctional').slug === 'NFR-draft-1', 'NFR rows get their own independent NFR-draft-N counter');
  ok(docReqs.every(r => r.draft === true), 'every row is flagged draft:true');
  ok(docReqs.find(r => r.title === 'Track order').text.includes('Users track fulfillment'), 'text mirrors what loadRequirements builds from title+description');
  ok(!docReqs.some(r => r.title === 'Rejected one' || r.title === 'Already promoted'), 'rejected/promoted extractions are excluded');

  const docReqsAgain = crossCheck.loadDocumentRequirements(iidReq);
  ok(JSON.stringify(docReqsAgain.map(r => r.slug)) === JSON.stringify(docReqs.map(r => r.slug)), 'draft refs are stable across a re-run that adds nothing new');

  // ── Part 7: discovery: clarification helpers ─────────────────────────────────
  console.log('\n--- Part 7: discovery clarification helpers ---');
  const iidDisc = makeIngestDoc(pidReq);
  ok(crossCheck.getNextDiscoveryRound(iidDisc) === 1, 'first discovery round is 1 (no rows yet)');

  const wrote1 = crossCheck.writeDiscoveryClarification(iidDisc, 1, { question: 'Which workflow?', context: 'ambiguous', related_tables: ['sys_hub_flow'] });
  ok(wrote1 === true, 'first discovery clarification on a table is written');
  const wrote2 = crossCheck.writeDiscoveryClarification(iidDisc, 1, { question: 'Which workflow? (again)', related_tables: ['sys_hub_flow'] });
  ok(wrote2 === false, 'a second, still-unanswered question about the SAME table is deduped (not duplicated)');
  const wroteOther = crossCheck.writeDiscoveryClarification(iidDisc, 1, { question: 'Which catalog category?', related_tables: ['sc_category'] });
  ok(wroteOther === true, 'a question about a DIFFERENT table is not deduped');

  ok(crossCheck.getAnsweredDiscoveryClarifications(iidDisc).length === 0, 'nothing answered yet');
  const openDiscRow = db.prepare("SELECT clarification_id FROM asdlc_ingest_clarification WHERE ingest_id=? AND target_field='discovery:sys_hub_flow'").get(iidDisc);
  db.prepare("UPDATE asdlc_ingest_clarification SET answer_text='Use WF-1', answered_at=datetime('now'), answered_by='tester' WHERE clarification_id=?").run(openDiscRow.clarification_id);
  const answered = crossCheck.getAnsweredDiscoveryClarifications(iidDisc);
  ok(answered.length === 1 && answered[0].answer_text === 'Use WF-1', 'getAnsweredDiscoveryClarifications returns only answered discovery: rows');
  ok(crossCheck.getNextDiscoveryRound(iidDisc) === 2, 'next round increments past the highest existing discovery round');

  // ── Part 8: four-file open-question-count fix (regression guard) ────────────
  console.log('\n--- Part 8: open-question-count fix ---');
  for (const f of ['agent/processor.js', 'agent/claude-processor.js', 'agent/stub-processor.js', 'run-live-extract.js']) {
    const src = fs.readFileSync(path.join(base, f), 'utf8');
    ok(/answer_text IS NULL AND target_field NOT LIKE/.test(src), `${f} excludes discovery: rows from its open-question count`);
  }

  // ── Part 9: HTTP — approve maps a draft plan to the import-profile slice ────
  console.log('\n--- Part 9: HTTP approve ---');
  const pid = makeProject('x_test_http');
  const iid = makeIngestDoc(pid);
  const planId = generateId();
  db.prepare(`INSERT INTO asdlc_sn_discovery_plan (plan_id, project_id, ingest_id, scope, status, plan_json, created_by, updated_at)
              VALUES (?,?,?,?, 'draft', ?, ?, datetime('now'))`)
    .run(planId, pid, iid, 'x_test_http', JSON.stringify({
      include: [
        { table: 'sc_cat_item', relation: 'direct', rationale: 'FR-draft-1', mapped_requirement_slugs: ['FR-draft-1'], confidence: 0.9 },
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

  // ── Part 10: HTTP — GET now requires ingest_id, scoped per document ─────────
  console.log('\n--- Part 10: HTTP get (ingest_id-scoped) ---');
  const noIngestParam = await get(`/projects/${pid}/servicenow/discovery-plan`);
  ok(noIngestParam.status === 400, 'GET without ?ingest_id= -> 400');

  const got = await get(`/projects/${pid}/servicenow/discovery-plan?ingest_id=${iid}`);
  ok(got.status === 200 && got.body.plan_id === planId, 'GET ?ingest_id= returns the latest plan for that document');
  ok(got.body.plan && got.body.plan.include.length === 2, 'plan_json is parsed back into an object');

  const otherIid = makeIngestDoc(pid);
  const noPlan = await get(`/projects/${pid}/servicenow/discovery-plan?ingest_id=${otherIid}`);
  ok(noPlan.status === 200 && noPlan.body.plan === null, 'a DIFFERENT document with no plan yet returns {plan:null} — never sees another document\'s plan');

  // ── Part 11: HTTP — generate requires ingest_id ──────────────────────────────
  console.log('\n--- Part 11: HTTP generate — ingest_id validation ---');
  const noIngestBody = await post(`/projects/${pid}/servicenow/discovery-plan`, {});
  ok(noIngestBody.status === 400, 'generate without ingest_id -> 400');
  const badIngest = await post(`/projects/${pid}/servicenow/discovery-plan`, { ingest_id: 'nope' });
  ok(badIngest.status === 404, 'generate with an ingest_id not in this project -> 404');

  // ── Part 12: HTTP — generate reuses an existing assessment that covers the scope ──
  console.log('\n--- Part 12: HTTP generate — reuse existing assessment ---');
  const pid2 = makeProject('x_test_gen');
  const iid2 = makeIngestDoc(pid2);
  stageExtraction(iid2, 'functional_req', { title: 'Order laptop', description: 'From the catalog.' }, 'staged');
  const asrId = generateId();
  db.prepare(`INSERT INTO asdlc_sn_assessment (assessment_id, project_id, status, report_json, created_at)
              VALUES (?,?, 'complete', ?, datetime('now'))`)
    .run(asrId, pid2, JSON.stringify({ scope_reports: [{ scope: 'x_test_gen', surfaces: [{ table: 'sc_cat_item', wbDesignType: 'catalog_item', present: true, count: 3 }] }] }));

  mockRoutes.current = (url) => {
    if (url.includes('/api/now/table/sys_properties')) return { ok: true, status: 200, json: async () => ({ result: [{ sys_id: '1' }] }), headers: { get: () => null } };
    if (url.includes('/api/now/table/sys_metadata')) return { ok: true, status: 200, json: async () => ({ result: [{ sys_id: 'M1', sys_class_name: 'sc_cat_item' }] }), headers: { get: () => null } };
    return { ok: true, status: 200, json: async () => ({ result: [] }), headers: { get: () => null } };
  };

  const gen = await post(`/projects/${pid2}/servicenow/discovery-plan`, { ingest_id: iid2, instance: 'https://example.service-now.com', user: 'u', pw: 'p' });
  ok(gen.status === 200, `generate succeeds (got ${gen.status}: ${JSON.stringify(gen.body)})`);
  ok(gen.body._stub === true, 'generate ran in stub AI mode (no ANTHROPIC_API_KEY)');
  ok(gen.body.plan && Array.isArray(gen.body.plan.include), 'generate returns a plan with an include[] array');
  ok(gen.body.status === 'draft', 'a freshly generated plan is draft, not approved');
  ok(gen.body.assessment_auto_run === false, 'an existing assessment covering the scope is reused, not re-run');
  const assessCountAfter = db.prepare('SELECT COUNT(*) c FROM asdlc_sn_assessment WHERE project_id=?').get(pid2).c;
  ok(assessCountAfter === 1, 'no NEW assessment row was created when an existing one already covers the scope');
  mockRoutes.current = null;

  // ── Part 13: HTTP — generate AUTO-RUNS an assessment when none covers the scope ──
  console.log('\n--- Part 13: HTTP generate — automatic assessment ---');
  const pid3 = makeProject('x_test_noassess');
  const iid3 = makeIngestDoc(pid3);
  stageExtraction(iid3, 'functional_req', { title: 'Order laptop', description: 'From the catalog.' }, 'staged');

  mockRoutes.current = (url) => {
    if (url.includes('/api/now/table/sys_properties')) return { ok: true, status: 200, json: async () => ({ result: [{ sys_id: '1' }] }), headers: { get: () => null } };
    if (url.includes('/api/now/stats/sc_cat_item')) return { ok: true, status: 200, json: async () => ({ result: { stats: { count: '3' } } }), headers: { get: () => null } };
    if (url.includes('/api/now/table/sys_metadata')) return { ok: true, status: 200, json: async () => ({ result: [{ sys_id: 'M1', sys_class_name: 'sc_cat_item' }] }), headers: { get: () => null } };
    return { ok: true, status: 200, json: async () => ({ result: [] }), headers: { get: () => null } };
  };

  const autoGen = await post(`/projects/${pid3}/servicenow/discovery-plan`, { ingest_id: iid3, instance: 'https://example.service-now.com', user: 'u', pw: 'p' });
  ok(autoGen.status === 200, `generate succeeds via auto-assessment, not a silent empty plan or a 409 (got ${autoGen.status}: ${JSON.stringify(autoGen.body)})`);
  ok(autoGen.body.assessment_auto_run === true, 'response flags that the assessment was run automatically');
  const newAssessment = db.prepare("SELECT status FROM asdlc_sn_assessment WHERE project_id=? AND status='complete'").get(pid3);
  ok(!!newAssessment, 'a real, persisted, complete assessment row now exists for this project — same as a manual scan would leave behind');
  mockRoutes.current = null;

  // ── Part 14: HTTP — generate surfaces a clear error when auto-assessment fails ──
  console.log('\n--- Part 14: HTTP generate — auto-assessment failure ---');
  const pid4 = makeProject('x_test_badcreds');
  const iid4 = makeIngestDoc(pid4);
  stageExtraction(iid4, 'functional_req', { title: 'Order laptop', description: 'From the catalog.' }, 'staged');
  mockRoutes.current = (url) => {
    if (url.includes('/api/now/table/sys_properties')) return { ok: false, status: 401, json: async () => null, headers: { get: () => null } };
    return { ok: true, status: 200, json: async () => ({ result: [] }), headers: { get: () => null } };
  };
  const badAuth = await post(`/projects/${pid4}/servicenow/discovery-plan`, { ingest_id: iid4, instance: 'https://example.service-now.com', user: 'u', pw: 'p' });
  ok(badAuth.status === 502, `bad credentials fail loudly (got ${badAuth.status}: ${JSON.stringify(badAuth.body)}) — never a silent empty plan`);
  mockRoutes.current = null;

  // ── Part 15: HTTP — discovery-answer endpoint, discovery:-only guard ─────────
  console.log('\n--- Part 15: HTTP discovery-answer endpoint ---');
  const iid5 = makeIngestDoc(pid);
  const discCid = generateId();
  db.prepare(`INSERT INTO asdlc_ingest_clarification (clarification_id, ingest_id, round, question_text, target_entity_type, target_field, created_at)
              VALUES (?,?,1,?,?,?,datetime('now'))`).run(discCid, iid5, 'Which table?', 'sn_discovery_plan', 'discovery:sc_cat_item');
  const conflictCid = generateId();
  db.prepare(`INSERT INTO asdlc_ingest_clarification (clarification_id, ingest_id, round, question_text, target_entity_type, target_field, created_at)
              VALUES (?,?,1,?,?,?,datetime('now'))`).run(conflictCid, iid5, 'Real conflict?', 'design', 'conflict:title');

  const answerRes = await post(`/projects/${pid}/servicenow/discovery-plan/clarifications/answer`, {
    ingest_id: iid5, answers: { [discCid]: 'Use sc_cat_item', [conflictCid]: 'Trying to sneak this through' },
  });
  ok(answerRes.status === 200, `discovery-answer succeeds (got ${answerRes.status})`);
  ok(answerRes.body.answered === 1, 'only the discovery: row is reported as answered, even though 2 answers were submitted');

  const rows = db.prepare('SELECT clarification_id, answer_text FROM asdlc_ingest_clarification WHERE ingest_id=?').all(iid5);
  ok(rows.find(r => r.clarification_id === discCid).answer_text === 'Use sc_cat_item', 'the discovery: row WAS answered');
  ok(rows.find(r => r.clarification_id === conflictCid).answer_text === null, "the conflict: row was NOT answered — this endpoint can never bypass a real clarification's normal side effects");

  // ── Part 16: entityScopes fix — planner is no longer blind to entity-scoped house rules ──
  console.log('\n--- Part 16: entityScopes fix ---');
  const { SN_CATALOG } = require(path.join(base, 'agent', 'sn-catalog'));
  const realTypes = [...new Set(SN_CATALOG.map(c => c.wbDesignType))].sort();
  ok(Array.isArray(planner.DISCOVERY_ENTITY_SCOPES) && planner.DISCOVERY_ENTITY_SCOPES.length === 9,
     `DISCOVERY_ENTITY_SCOPES has all 9 real wbDesignType values (got ${planner.DISCOVERY_ENTITY_SCOPES.length})`);
  ok(JSON.stringify([...planner.DISCOVERY_ENTITY_SCOPES].sort()) === JSON.stringify(realTypes),
     'DISCOVERY_ENTITY_SCOPES matches SN_CATALOG\'s actual wbDesignType set exactly (was hardcoded [] before #108 follow-up)');

  // ── Part 17: open_ended threading — persisted at generation time ────────────────────
  console.log('\n--- Part 17: HTTP generate — open_ended threading ---');
  const pid5 = makeProject('x_test_openended');
  const iid6 = makeIngestDoc(pid5);
  stageExtraction(iid6, 'functional_req', { title: 'Triage queue', description: 'Route to Level 1 Triage.' }, 'staged');
  const asrId5 = generateId();
  db.prepare(`INSERT INTO asdlc_sn_assessment (assessment_id, project_id, status, report_json, created_at)
              VALUES (?,?, 'complete', ?, datetime('now'))`)
    .run(asrId5, pid5, JSON.stringify({ scope_reports: [{ scope: 'x_test_openended', surfaces: [{ table: 'sc_cat_item', wbDesignType: 'catalog_item', present: true, count: 3 }] }] }));
  mockRoutes.current = (url) => {
    if (url.includes('/api/now/table/sys_properties')) return { ok: true, status: 200, json: async () => ({ result: [{ sys_id: '1' }] }), headers: { get: () => null } };
    return { ok: true, status: 200, json: async () => ({ result: [] }), headers: { get: () => null } };
  };
  const oeGen = await post(`/projects/${pid5}/servicenow/discovery-plan`, { ingest_id: iid6, open_ended: true, instance: 'https://example.service-now.com', user: 'u', pw: 'p' });
  ok(oeGen.status === 200, `open_ended generate succeeds (got ${oeGen.status}: ${JSON.stringify(oeGen.body)})`);
  ok(oeGen.body.open_ended === 1 || oeGen.body.open_ended === true, 'response reflects open_ended persisted on the plan row');
  const oeRow = db.prepare('SELECT open_ended FROM asdlc_sn_discovery_plan WHERE plan_id=?').get(oeGen.body.plan_id);
  ok(!!oeRow && Number(oeRow.open_ended) === 1, 'open_ended=1 is persisted in the DB at generation time, independent of what the (stub) AI returned');

  const normalGen = await post(`/projects/${pid5}/servicenow/discovery-plan`, { ingest_id: iid6, instance: 'https://example.service-now.com', user: 'u', pw: 'p' });
  const normalRow = db.prepare('SELECT open_ended FROM asdlc_sn_discovery_plan WHERE plan_id=?').get(normalGen.body.plan_id);
  ok(!!normalRow && Number(normalRow.open_ended) === 0, 'a normal (non-open_ended) generate call persists open_ended=0');
  mockRoutes.current = null;

  // ── Part 18: approve — the hallucination-defense gate ────────────────────────────────
  console.log('\n--- Part 18: HTTP approve — hallucination-defense gate on platform_wide ---');
  const planPlanJson = JSON.stringify({
    include: [
      { table: 'sc_cat_item', relation: 'direct', rationale: 'FR-draft-1', mapped_requirement_slugs: [], confidence: 0.9 },
      { table: 'cmdb_ci_service', relation: 'direct', rationale: 'hallucinated or genuine platform-wide pick', confidence: 0.6, platform_wide: true },
    ], exclude: [], notes: 'platform_wide gate test',
  });

  // A normal-mode plan (open_ended=0) carrying a platform_wide:true item — must be DROPPED,
  // never folded into include_surfaces OR platform_wide_surfaces.
  const normalPlanId = generateId();
  db.prepare(`INSERT INTO asdlc_sn_discovery_plan (plan_id, project_id, ingest_id, scope, status, plan_json, open_ended, created_by, updated_at)
              VALUES (?,?,?,?, 'draft', ?, 0, ?, datetime('now'))`)
    .run(normalPlanId, pid, iid, 'x_test_http', planPlanJson, 'tester');
  const normalApprove = await post(`/projects/${pid}/servicenow/discovery-plan/${normalPlanId}/approve`, {});
  ok(normalApprove.status === 200, `approve of the normal-mode plan succeeds (got ${normalApprove.status}: ${JSON.stringify(normalApprove.body)})`);
  ok((normalApprove.body.profile.include_surfaces || []).join(',') === 'sc_cat_item', 'only the NON-platform_wide item made it into include_surfaces');
  ok(!(normalApprove.body.profile.platform_wide_surfaces || []).length, 'the platform_wide:true item was dropped entirely — never trusted outside an open_ended plan');

  // The SAME plan_json, but the plan row itself IS persisted open_ended=1 — now the
  // platform_wide item is honored, routed to platform_wide_surfaces (not include_surfaces).
  const oePlanId = generateId();
  db.prepare(`INSERT INTO asdlc_sn_discovery_plan (plan_id, project_id, ingest_id, scope, status, plan_json, open_ended, created_by, updated_at)
              VALUES (?,?,?,?, 'draft', ?, 1, ?, datetime('now'))`)
    .run(oePlanId, pid, iid, 'x_test_http', planPlanJson, 'tester');
  const oeApprove = await post(`/projects/${pid}/servicenow/discovery-plan/${oePlanId}/approve`, {});
  ok(oeApprove.status === 200, `approve of the open_ended plan succeeds (got ${oeApprove.status}: ${JSON.stringify(oeApprove.body)})`);
  ok((oeApprove.body.profile.include_surfaces || []).join(',') === 'sc_cat_item', 'the normal item still lands in include_surfaces');
  ok((oeApprove.body.profile.platform_wide_surfaces || []).join(',') === 'cmdb_ci_service', 'on an open_ended plan, the platform_wide item is honored and routed to platform_wide_surfaces');

  console.log(`\n${pass} passed, ${fail} failed`);
  done(fail ? 1 : 0);
})().catch(err => { console.error('FATAL', err); done(1); });
