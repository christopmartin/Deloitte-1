// test-roundtrip-inbound.js
// Deterministic end-to-end test of the INBOUND ServiceNow round-trip pipeline.
// No LLM: boots the server in-process (which seeds sample data), creates a
// Fluent ingest document via the adapter, inserts staged extractions for the
// four new design types (simulating extractor output), then drives the REAL
// /promote + /approve HTTP endpoints and asserts the rows materialize with
// provenance, slugs and resolved parent FKs. Also verifies the update path
// (re-ingest → operation:update → no duplicate, version bump).
//
// Run:  ASDLC_DB_PATH set automatically;  node test-roundtrip-inbound.js
'use strict';
const path = require('path');
const os   = require('os');

// Isolated DB + random port MUST be set before requiring server.js.
process.env.ASDLC_DB_PATH = path.join(os.tmpdir(), `asdlc_rt_${Date.now()}.db`);
process.env.PORT = String(8100 + Math.floor(Math.random() * 600));
process.env.ANTHROPIC_API_KEY = ''; // keep deterministic/offline (post-approve test-gen runs in stub mode)

const base = __dirname;
require(path.join(base, 'server.js'));                       // boots + seeds + listens
const { db, generateId } = require(path.join(base, 'db'));   // same cached instance the server uses
const fluentIngest = require(path.join(base, 'agent', 'fluent-ingest'));

const BASEURL = `http://127.0.0.1:${process.env.PORT}/api/v1`;
const HEADERS = { 'Content-Type': 'application/json', 'X-User-ID': 'test-roundtrip' };
const SCOPE   = 'x_dnllp_airport_ca';

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { console.log('  ok  -', msg); pass++; } else { console.error('  FAIL-', msg); fail++; } };
// Close the sqlite handle before exiting so process.exit() doesn't race libuv
// handle teardown (Windows UV_HANDLE_CLOSING assert).
function done(code) { try { db.close(); } catch { /* ignore */ } process.exit(code); }

function staged(ingestId, entity_type, entity_data) {
  db.prepare(`INSERT INTO asdlc_ingest_extraction
      (extraction_id, ingest_id, entity_type, entity_data, confidence, status, round, created_at)
      VALUES (?,?,?,?,?, 'staged', 1, datetime('now'))`)
    .run(generateId(), ingestId, entity_type, JSON.stringify(entity_data), 0.95);
}
async function post(url) {
  const r = await fetch(url, { method: 'POST', headers: HEADERS, body: '{}' });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${url} -> ${r.status} ${JSON.stringify(body)}`);
  return body;
}

async function main() {
  await new Promise(r => setTimeout(r, 900));   // let app.listen bind

  const project = db.prepare("SELECT project_id, project_name FROM asdlc_project ORDER BY created_at LIMIT 1").get();
  if (!project) throw new Error('no seeded project found');
  const pid = project.project_id;
  console.log(`\n=== Using project "${project.project_name}" (${pid}) ===`);

  // 1) Adapter builds raw_text from the sample Fluent + creates the ingest doc.
  const ing = fluentIngest.ingestFluentDir({
    projectId: pid, dir: path.join(base, 'fixtures'), scope: SCOPE, title: 'x_dnllp_airport_ca (Fluent)',
  });
  console.log(`Created fluent ingest doc ${ing.ingest_id} from ${ing.files.length} file(s); raw_text ${ing.fluentText.length} chars`);
  assert(ing.files.length >= 1, 'adapter read the sample Fluent fixture');
  const docRow = db.prepare("SELECT document_type FROM asdlc_ingest_document WHERE ingest_id=?").get(ing.ingest_id);
  assert(docRow && docRow.document_type === 'fluent', "ingest doc has document_type='fluent'");

  // 2) Insert staged extractions (what the extractor would produce for the 4 new types).
  staged(ing.ingest_id, 'data_model', {
    name: 'Flight', purpose: 'A scheduled flight at the airport', physical_name: 'x_dnllp_airport_ca_flight', extends_table: 'task',
    fields: [
      { label: 'Flight Number', meaning: 'IATA flight code', type_business: 'text', mandatory: true },
      { label: 'Status', meaning: 'Operational status', type_business: 'choice', mandatory: true, choices: ['Scheduled', 'Boarding', 'Departed', 'Delayed', 'Cancelled'] },
    ],
    relationships: [{ kind: 'reference', target: 'Gate', description: 'Assigned departure gate' }],
    audited: true,
    source_table: 'sys_db_object', source_sys_id: 'a1b2c3d4flight000000000000000001', source_scope: SCOPE,
    source_fluent: 'export const x_dnllp_airport_ca_flight = Table({ ... })',
    operation: 'create', confidence: 0.95,
  });
  staged(ing.ingest_id, 'form_design', {
    name: 'Flight Default Form', data_model_name: 'Flight', view_name: 'Default',
    sections: [{ section_label: 'Flight Details', fields: ['Flight Number', 'Status', 'Gate'], columns: 2 }],
    related_lists: [{ label: 'Passengers', table: 'passenger' }],
    mandatory_fields: ['Flight Number'], readonly_fields: [],
    behavior_notes: 'Cancellation reason becomes mandatory when Status = Cancelled',
    source_table: 'sys_ui_form', source_sys_id: 'a1b2c3d4form0000000000000000001', source_scope: SCOPE,
    source_fluent: 'export const flight_default_form = Form({ ... })',
    operation: 'create', confidence: 0.95,
  });
  staged(ing.ingest_id, 'business_logic', {
    name: 'Notify gate agent on delay', logic_type: 'business_rule', data_model_name: 'Flight',
    plain_english: 'When a flight becomes delayed, post a work note and notify the assigned gate agent',
    when_runs: 'after a Flight is updated', conditions: 'Status changes to Delayed', run_order: 100,
    source_table: 'sys_script', source_sys_id: 'a1b2c3d4br000000000000000000001', source_scope: SCOPE,
    source_fluent: 'export const notify_gate_agent_on_delay = BusinessRule({ ... })',
    operation: 'create', confidence: 0.95,
  });
  staged(ing.ingest_id, 'catalog_item', {
    name: 'Report a Gate Issue', short_description: 'Report a problem at a gate', category: 'Airport Operations',
    variables: [
      { label: 'Gate', type_business: 'reference', mandatory: true },
      { label: 'Issue Type', type_business: 'choice', mandatory: true, choices: ['Cleaning', 'Equipment', 'Safety'] },
    ],
    who_can_order: 'Gate Agents', delivery_time: '4 hours',
    source_table: 'sc_cat_item', source_sys_id: 'a1b2c3d4cat00000000000000000001', source_scope: SCOPE,
    source_fluent: 'export const report_gate_issue = CatalogItem({ ... })',
    operation: 'create', confidence: 0.95,
  });

  // 3) Promote → 4) Approve (real materializer).
  const promo = await post(`${BASEURL}/ingest-documents/${ing.ingest_id}/promote`);
  const cp = promo.change_packets[0];
  console.log(`Promoted ${cp.packet_code}: ${cp.item_count} items, by_type=${JSON.stringify(cp.by_type)}`);
  const appr = await post(`${BASEURL}/change-packets/${cp.change_packet_id}/approve`);
  console.log(`Approved. apply_result=${JSON.stringify(appr.apply_result || appr.applyResult || {})}`);

  // 5) Assert materialization.
  console.log('\n--- Assertions: create ---');
  const dm = db.prepare("SELECT * FROM asdlc_data_model WHERE project_id=? AND name='Flight'").get(pid);
  assert(!!dm, 'data_model "Flight" materialized');
  assert(dm && /^DM-\d+$/.test(dm.slug || ''), `data_model slug assigned (${dm && dm.slug})`);
  assert(dm && dm.source_sys_id === 'a1b2c3d4flight000000000000000001', 'data_model carried source_sys_id (Level-2 identity)');
  assert(dm && dm.source_table === 'sys_db_object', 'data_model carried source_table');
  assert(dm && (() => { try { return JSON.parse(dm.fields).length === 2; } catch { return false; } })(), 'data_model.fields JSON stored (2 fields)');
  assert(dm && dm.audited === 1, 'data_model.audited boolean coerced to 1');

  const fd = db.prepare("SELECT * FROM asdlc_form_design WHERE project_id=? AND name='Flight Default Form'").get(pid);
  assert(!!fd, 'form_design materialized');
  assert(fd && dm && fd.data_model_id === dm.data_model_id, 'form_design.data_model_id FK resolved to the data_model (same packet)');
  assert(fd && fd.source_sys_id === 'a1b2c3d4form0000000000000000001', 'form_design carried provenance');
  assert(fd && /^FORM-\d+$/.test(fd.slug || ''), `form_design slug assigned (${fd && fd.slug})`);

  const bl = db.prepare("SELECT * FROM asdlc_business_logic WHERE project_id=? AND name LIKE 'Notify gate agent%'").get(pid);
  assert(!!bl, 'business_logic materialized');
  assert(bl && bl.logic_type === 'business_rule', 'business_logic.logic_type stored');
  assert(bl && dm && bl.data_model_id === dm.data_model_id, 'business_logic.data_model_id FK resolved');
  assert(bl && /^BL-\d+$/.test(bl.slug || ''), `business_logic slug assigned (${bl && bl.slug})`);

  const cat = db.prepare("SELECT * FROM asdlc_catalog_item WHERE project_id=? AND name='Report a Gate Issue'").get(pid);
  assert(!!cat, 'catalog_item materialized');
  assert(cat && (() => { try { return JSON.parse(cat.variables).length === 2; } catch { return false; } })(), 'catalog_item.variables JSON stored (2 vars)');
  assert(cat && /^CAT-\d+$/.test(cat.slug || ''), `catalog_item slug assigned (${cat && cat.slug})`);

  // 6) Update path: re-ingest the data_model as an update; expect no duplicate + version bump.
  console.log('\n--- Assertions: update / no-duplicate ---');
  const ing2 = fluentIngest.createFluentIngestDocument({ projectId: pid, title: 'x_dnllp_airport_ca (re-extract)', fluentText: ing.fluentText });
  staged(ing2.ingest_id, 'data_model', {
    name: 'Flight', purpose: 'A scheduled flight at the airport (updated purpose)', physical_name: 'x_dnllp_airport_ca_flight', extends_table: 'task',
    fields: [{ label: 'Flight Number', meaning: 'IATA flight code', type_business: 'text', mandatory: true }],
    audited: true,
    source_table: 'sys_db_object', source_sys_id: 'a1b2c3d4flight000000000000000001', source_scope: SCOPE,
    source_fluent: 'export const x_dnllp_airport_ca_flight = Table({ ...updated... })',
    operation: 'update', target_slug: dm.slug, confidence: 0.95,
  });
  const promo2 = await post(`${BASEURL}/ingest-documents/${ing2.ingest_id}/promote`);
  await post(`${BASEURL}/change-packets/${promo2.change_packets[0].change_packet_id}/approve`);

  const dmCount = db.prepare("SELECT COUNT(*) c FROM asdlc_data_model WHERE project_id=? AND name='Flight'").get(pid).c;
  const dm2 = db.prepare("SELECT * FROM asdlc_data_model WHERE data_model_id=?").get(dm.data_model_id);
  assert(dmCount === 1, `no duplicate data_model after update (count=${dmCount})`);
  assert(dm2 && /updated/.test(dm2.purpose || ''), 'data_model updated in place');
  assert(dm2 && dm2.version === 2, `data_model version bumped (version=${dm2 && dm2.version})`);

  // 7) New API routes: design-report list, GET single, PUT edit, enum guard.
  console.log('\n--- Assertions: API routes ---');
  const rep = await (await fetch(`${BASEURL}/projects/${pid}/design-report/data-models`, { headers: HEADERS })).json();
  const repFlight = (rep.data_models || []).find(d => d.name === 'Flight');
  assert(!!repFlight, 'GET design-report/data-models returns Flight');
  assert(repFlight && Array.isArray(repFlight.fields), 'design-report parses fields JSON to array');
  const one = await (await fetch(`${BASEURL}/projects/${pid}/data-models/${dm.data_model_id}`, { headers: HEADERS })).json();
  assert(one && one.data_model_id === dm.data_model_id, 'GET single data-model');
  assert(one && !!one.source_sys_id, 'GET single exposes Level-2 provenance for tooling');
  const putRes = await fetch(`${BASEURL}/projects/${pid}/data-models/${dm.data_model_id}`,
    { method: 'PUT', headers: HEADERS, body: JSON.stringify({ purpose: 'edited via API' }) });
  const putBody = await putRes.json();
  assert(putRes.ok && putBody.purpose === 'edited via API', 'PUT data-model updates purpose');
  const dm3 = db.prepare("SELECT * FROM asdlc_data_model WHERE data_model_id=?").get(dm.data_model_id);
  assert(dm3 && dm3.purpose === 'edited via API' && dm3.version === 3, `PUT bumped version (now ${dm3 && dm3.version})`);
  const blPut = await fetch(`${BASEURL}/projects/${pid}/business-logic/${bl.business_logic_id}`,
    { method: 'PUT', headers: HEADERS, body: JSON.stringify({ logic_type: 'not_a_type' }) });
  assert(blPut.status === 400, 'PUT business-logic rejects invalid logic_type enum');

  // ── Round 2: reuse-type provenance (agent/tool) + sys_id coalescing ──
  console.log('\n--- Assertions: reuse-type provenance + sync ---');
  const AGENT_SYSID = 'aiagent00000000000000000000001';
  const ingA = fluentIngest.createFluentIngestDocument({ projectId: pid, title: 'SN agent pull', fluentText: 'agent fluent' });
  staged(ingA.ingest_id, 'agent_spec', {
    name: 'Invoice Status Lookup Assistant', use_case_title: 'Order Operations Automation',
    scope: 'Retrieve invoice/PO status and post a work note', instructions: 'Use internal AP terminology.',
    goals: ['Retrieve invoice status', 'Post work note'],
    source_table: 'sn_aia_agent', source_sys_id: AGENT_SYSID, source_scope: 'x_dnllp_p1',
    source_fluent: 'export const agent = AiAgent({ ... })', operation: 'create', confidence: 0.95,
  });
  staged(ingA.ingest_id, 'tool', {
    name: 'Invoice Search Lookup', contract: 'Search invoices by PO/number', inputs: ['po_number'], outputs: ['invoice'],
    source_table: 'sn_aia_tool', source_sys_id: 'aiatool0000000000000000000001', source_scope: 'x_dnllp_p1',
    source_fluent: 'tool def', operation: 'create', confidence: 0.95,
  });
  const promoA = await post(`${BASEURL}/ingest-documents/${ingA.ingest_id}/promote`);
  await post(`${BASEURL}/change-packets/${promoA.change_packets[0].change_packet_id}/approve`);
  const agent = db.prepare("SELECT * FROM asdlc_agent_spec WHERE source_sys_id=?").get(AGENT_SYSID);
  assert(!!agent, 'agent_spec materialized from ServiceNow');
  assert(agent && agent.source_sys_id === AGENT_SYSID, 'agent_spec carries source_sys_id (reuse-type provenance)');
  const toolRow = db.prepare("SELECT * FROM asdlc_tool WHERE source_sys_id='aiatool0000000000000000000001'").get();
  assert(!!toolRow && !!toolRow.source_sys_id, 'tool carries source_sys_id (reuse-type provenance)');

  // Re-pull the SAME agent, renamed, as operation:create → sys_id coalescing must UPDATE, not duplicate.
  const ingB = fluentIngest.createFluentIngestDocument({ projectId: pid, title: 'SN agent re-pull', fluentText: 'agent fluent v2' });
  staged(ingB.ingest_id, 'agent_spec', {
    name: 'Invoice Status Assistant (renamed)', use_case_title: 'Order Operations Automation',
    scope: 'Retrieve invoice/PO status and post a work note',
    source_table: 'sn_aia_agent', source_sys_id: AGENT_SYSID, source_scope: 'x_dnllp_p1',
    source_fluent: 'export const agent = AiAgent({ ...renamed... })', operation: 'create', confidence: 0.95,
  });
  const promoB = await post(`${BASEURL}/ingest-documents/${ingB.ingest_id}/promote`);
  await post(`${BASEURL}/change-packets/${promoB.change_packets[0].change_packet_id}/approve`);
  const agCount = db.prepare("SELECT COUNT(*) c FROM asdlc_agent_spec WHERE source_sys_id=?").get(AGENT_SYSID).c;
  const agAfter = db.prepare("SELECT * FROM asdlc_agent_spec WHERE source_sys_id=?").get(AGENT_SYSID);
  assert(agCount === 1, `no duplicate agent on re-pull (sys_id coalescing); count=${agCount}`);
  assert(agAfter && /renamed/.test(agAfter.name || ''), 'agent updated in place via sys_id (survives rename)');

  // ── Round 2: Application link / resolve / sync ──
  console.log('\n--- Assertions: application link ---');
  const cid = db.prepare("SELECT client_id FROM asdlc_client LIMIT 1").get().client_id;
  const newProj = await (await fetch(`${BASEURL}/projects`, { method: 'POST', headers: HEADERS,
    body: JSON.stringify({ client_id: cid, project_name: 'ExxonMobil Invoice Lookup', project_code: 'SN-x_dnllp_p1',
      servicenow_scope: 'x_dnllp_p1', servicenow_sys_app_id: 'b9c3fc870aa5463c9ec9fee91b1fe9d7' }) })).json();
  assert(newProj.servicenow_sys_app_id === 'b9c3fc870aa5463c9ec9fee91b1fe9d7', 'POST /projects stores the ServiceNow link');
  const resolved = await (await fetch(`${BASEURL}/servicenow/resolve-project?sys_app_id=b9c3fc870aa5463c9ec9fee91b1fe9d7`, { headers: HEADERS })).json();
  assert(resolved.project && resolved.project.project_id === newProj.project_id, 'resolve-project returns the linked Application');
  const r1 = fluentIngest.resolveOrCreateProject({ sysAppId: 'sysapp-test-xyz', scope: 'x_dnllp_test', name: 'Test SN App' });
  const r2 = fluentIngest.resolveOrCreateProject({ sysAppId: 'sysapp-test-xyz', scope: 'x_dnllp_test', name: 'Test SN App' });
  assert(r1.created && !r2.created && r1.project_id === r2.project_id, 'resolveOrCreateProject is idempotent on sys_app id');
  fluentIngest.markSynced(r1.project_id);
  const synced = db.prepare("SELECT sn_last_synced_at FROM asdlc_project WHERE project_id=?").get(r1.project_id);
  assert(synced && !!synced.sn_last_synced_at, 'markSynced stamps sn_last_synced_at');

  // ── Phase A: non-destructive sync guard + apply-mode setting ──
  console.log('\n--- Assertions: non-destructive guard + apply-mode ---');
  const toolBefore = db.prepare("SELECT contract FROM asdlc_tool WHERE source_sys_id='aiatool0000000000000000000001'").get();
  const ingG = fluentIngest.createFluentIngestDocument({ projectId: pid, title: 'SN re-pull (lossy tool)', fluentText: 'tool fluent v2' });
  staged(ingG.ingest_id, 'tool', {
    name: 'Invoice Search Lookup', contract: '',   // blank — a lossy SN value that must NOT clobber the populated WB contract
    source_table: 'sn_aia_tool', source_sys_id: 'aiatool0000000000000000000001', source_scope: 'x_dnllp_p1',
    operation: 'create', confidence: 0.95,
  });
  const promoG = await post(`${BASEURL}/ingest-documents/${ingG.ingest_id}/promote`);
  await post(`${BASEURL}/change-packets/${promoG.change_packets[0].change_packet_id}/approve`);
  const toolAfter = db.prepare("SELECT contract FROM asdlc_tool WHERE source_sys_id='aiatool0000000000000000000001'").get();
  assert(toolAfter.contract === toolBefore.contract && /Search invoices/.test(toolAfter.contract || ''), 'non-destructive guard: blank SN contract did NOT overwrite the populated WB contract');
  const noteRow = db.prepare("SELECT cpi.rationale r FROM asdlc_change_packet_item cpi JOIN asdlc_change_packet cp ON cp.change_packet_id=cpi.change_packet_id WHERE cp.ingest_id=?").get(ingG.ingest_id);
  assert(noteRow && /non-destructive/.test(noteRow.r || ''), 'protected field recorded on the change packet item');

  const mGet = await (await fetch(`${BASEURL}/settings/sn-sync-apply-mode`, { headers: HEADERS })).json();
  assert(mGet.mode === 'additive_hitl', `apply-mode defaults to additive_hitl (got ${mGet.mode})`);
  const mPut = await (await fetch(`${BASEURL}/settings/sn-sync-apply-mode`, { method: 'PUT', headers: HEADERS, body: JSON.stringify({ mode: 'confidence_gate' }) })).json();
  assert(mPut.mode === 'confidence_gate', 'apply-mode can switch to confidence_gate');
  const mBad = await fetch(`${BASEURL}/settings/sn-sync-apply-mode`, { method: 'PUT', headers: HEADERS, body: JSON.stringify({ mode: 'bogus' }) });
  assert(mBad.status === 400, 'apply-mode rejects an invalid value');

  // 8) Build Export: new sections present + Level-2 provenance carried for regeneration.
  console.log('\n--- Assertions: build export ---');
  const expRes = await fetch(`${BASEURL}/projects/${pid}/build-export?sections=data_models,form_designs,business_logic,catalog_items`, { headers: HEADERS });
  const md = await expRes.text();
  assert(expRes.ok, 'build-export responded ok');
  assert(/## ServiceNow Data Model/.test(md), 'build spec has Data Model section');
  assert(/## ServiceNow Business Logic/.test(md), 'build spec has Business Logic section');
  assert(md.includes('a1b2c3d4flight000000000000000001'), 'build spec carries Level-2 source_sys_id (round-trip identity)');
  assert(/Fluent \(Level-2 construct\)/.test(md), 'build spec embeds Fluent provenance for regeneration');

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  done(fail ? 1 : 0);
}

main().catch(err => { console.error('\nTEST ERROR:', err); done(1); });
