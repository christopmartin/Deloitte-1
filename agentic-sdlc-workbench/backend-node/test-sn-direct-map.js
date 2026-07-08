// test-sn-direct-map.js — deterministic ServiceNow capture + on-request narration
// (#101/#102/#103). Verifies that record types whose Level-1 schema is a direct copy of
// ServiceNow data bypass the Opus reverse-engineer/reconcile/review path entirely, while
// change detection / conflict resolution / round-trip identity are unchanged, and that
// business-logic narration is available on request ("Explain with AI").
//
// Run:  node test-sn-direct-map.js   (from backend-node/)
'use strict';
const path = require('path');
const os   = require('os');

process.env.ASDLC_DB_PATH = path.join(os.tmpdir(), `asdlc_dmap_${Date.now()}.db`);
process.env.PORT = String(8700 + Math.floor(Math.random() * 600));
process.env.ANTHROPIC_API_KEY = '';   // stub mode — deterministic + free

const base = __dirname;
require(path.join(base, 'server.js'));
const { db, generateId } = require(path.join(base, 'db'));
const { hashArtifact } = require(path.join(base, 'agent', 'sn-capture'));
const dmap = require(path.join(base, 'agent', 'sn-direct-map'));
const re   = require(path.join(base, 'agent', 'sn-reverse-engineer'));
const snSync = require(path.join(base, 'agent', 'sn-sync'));

const BASEURL = `http://127.0.0.1:${process.env.PORT}/api/v1`;
const HEADERS = { 'Content-Type': 'application/json', 'X-User-ID': 'test-dmap' };
const SCOPE = 'x_test_dmap';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { console.log('  ok  -', m); pass++; } else { console.error('  FAIL-', m); fail++; } };
function done(code) { try { db.close(); } catch { /* ignore */ } process.exit(code); }

function makeProject(lastSync) {
  const client = db.prepare('SELECT client_id FROM asdlc_client LIMIT 1').get();
  const pid = generateId();
  db.prepare(`INSERT INTO asdlc_project (project_id, client_id, project_name, project_code, servicenow_scope, servicenow_instance, confidence_threshold, sn_last_synced_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(pid, client.client_id, 'DMAP', `DMAP-${Date.now().toString(36).slice(-4)}`, SCOPE, 'https://example.service-now.com', 0.75, lastSync || null);
  return pid;
}

// Build a captured artifact (Tier-A rich shape) with optional attached children.
function art(source_table, sysId, name, salient, children) {
  const a = { source_table, source_sys_id: sysId, name, salient, hash: hashArtifact(salient) };
  if (children) a._children = children;
  return a;
}
function child(source_table, order, payload) {
  return { source_table, generic: true, child_order: order, source_sys_id: generateId(), payload, salient: payload };
}

(async () => {
  // ── 1. directMapArtifact: correct shape per type; null for interpretive types ──
  console.log('--- 1. direct-map builders ---');
  const cat = dmap.directMapArtifact(art('sc_cat_item', 'c1', 'Order Laptop',
    { name: 'Order Laptop', short_description: 'Request a laptop', category: 'Hardware', workflow: 'Laptop Fulfillment' },
    [ child('item_option_new', 0, { question_text: 'Model', type: '6', mandatory: 'true', help_text: 'Pick one' }),
      child('item_option_new', 1, { question_text: 'Justification' }) ]));
  assert(cat && cat.designType === 'catalog_item', 'sc_cat_item → catalog_item');
  assert(cat.entity_data.category === 'Hardware' && cat.entity_data.workflow_name === 'Laptop Fulfillment', 'catalog: category + fulfillment workflow copied');
  assert(Array.isArray(cat.entity_data.variables) && cat.entity_data.variables.length === 2 && cat.entity_data.variables[0].label === 'Model',
    'catalog: variables joined from item_option_new children (not blank/guessed)');

  const dm = dmap.directMapArtifact(art('sys_db_object', 'd1', 'x_app_flight',
    { name: 'x_app_flight', label: 'Flight', super_class: 'task' },
    [ child('sys_dictionary', 0, { element: 'status', column_label: 'Status', internal_type: 'choice' }) ]));
  assert(dm.entity_data.name === 'Flight' && dm.entity_data.physical_name === 'x_app_flight' && dm.entity_data.extends_table === 'task', 'data_model: label/physical/extends copied');
  assert(dm.entity_data.fields.length === 1 && dm.entity_data.fields[0].label === 'Status', 'data_model: columns joined from sys_dictionary children');

  const bl = dmap.directMapArtifact(art('sys_script', 'b1', 'Set Priority', { name: 'Set Priority', script: 'gs.log(1)' }));
  assert(bl.designType === 'business_logic' && bl.entity_data.logic_type === 'business_rule', 'sys_script → business_logic + logic_type');
  assert(bl.entity_data.plain_english === undefined && bl.entity_data.when_runs === undefined, 'business_logic: narrative fields NOT set (blank until Explain)');

  const rest = dmap.directMapArtifact(art('sys_rest_message', 'r1', 'SAP API', { name: 'SAP API', rest_endpoint: 'https://sap', authentication_type: 'oauth2', description: 'SAP' }));
  assert(rest.designType === 'rest_message' && rest.entity_data.endpoint === 'https://sap' && rest.entity_data.auth_type === 'oauth2', 'sys_rest_message → rest_message (endpoint/auth copied)');

  assert(dmap.directMapArtifact(art('sn_aia_agent', 'g1', 'Triage', { role: 'x' })) === null, 'interpretive type (agent) → null (keeps AI path)');
  assert(dmap.isDeterministicTable('sys_script') && dmap.isDeterministicTable('sc_cat_item') && !dmap.isDeterministicTable('sn_aia_agent'), 'isDeterministicTable predicate');

  // #105: form sections/elements + UI-policy mandatory/read-only, previously always blank.
  const sec0 = child('sys_ui_form_section', 0, { 'sys_ui_section.caption': 'Details', position: 0 });
  sec0._children = [
    child('sys_ui_element', 0, { element: 'short_description' }),
    child('sys_ui_element', 1, { element: 'priority' }),
  ];
  const sec1 = child('sys_ui_form_section', 1, { 'sys_ui_section.caption': 'Notes', position: 1 });
  sec1._children = [ child('sys_ui_element', 0, { element: 'comments' }) ];
  const form = dmap.directMapArtifact(art('sys_ui_form', 'f1', 'incident', { name: 'incident', view: 'Default view' }, [sec0, sec1]));
  assert(form.designType === 'form_design' && form.entity_data.view_name === 'Default view', 'sys_ui_form → form_design (view copied)');
  assert(Array.isArray(form.entity_data.sections) && form.entity_data.sections.length === 2, 'form: sections joined from sys_ui_form_section children');
  assert(form.entity_data.sections[0].section_label === 'Details' && form.entity_data.sections[0].fields.join(',') === 'short_description,priority',
    'form: section label + field list (not blank/guessed)');

  const pa0 = child('sys_ui_policy_action', 0, { field: 'cancellation_reason', mandatory: 'true' });
  const pa1 = child('sys_ui_policy_action', 1, { field: 'assigned_to', disabled: 'true' });
  const pol = dmap.directMapArtifact(art('sys_ui_policy', 'p1', 'Cancel flow', { short_description: 'Cancel flow', table: 'incident', conditions: 'state=7' }, [pa0, pa1]));
  assert(pol.designType === 'form_design', 'sys_ui_policy → form_design');
  assert(pol.entity_data.mandatory_fields.join(',') === 'cancellation_reason', 'ui_policy: mandatory_fields from policy actions');
  assert(pol.entity_data.readonly_fields.join(',') === 'assigned_to', 'ui_policy: readonly_fields from policy actions');
  assert(pol.entity_data.behavior_notes.includes('state=7'), 'ui_policy: behavior_notes includes the raw condition (factual, not AI-guessed)');

  // ── 2. reverseEngineerOne short-circuit (stub mode, no key): det → deterministic, no stub ──
  console.log('--- 2. reverse-engineer short-circuit ---');
  const rDet = await re.reverseEngineerOne(art('sys_script', 'b2', 'Notify', { name: 'Notify', script: 'x'.repeat(500) }), {});
  assert(rDet.deterministic === true && !rDet.stub, 'business_logic → deterministic (no AI/stub) even with no API key');
  const rCat = await re.reverseEngineerOne(cat._art || art('sc_cat_item', 'c2', 'Item', { name: 'Item', short_description: 'd' }), {});
  assert(rCat.deterministic === true, 'catalog_item → deterministic');
  const rAgent = await re.reverseEngineerOne(art('sn_aia_agent', 'g2', 'Triage', { role: 'triage', description: 'd' }), {});
  assert(rAgent.stub === true && !rAgent.deterministic, 'agent → stub in no-key mode (would call AI with a key)');
  const rForce = await re.reverseEngineerOne(art('sys_script', 'b3', 'X', { name: 'X', script: 'y' }), {}, { forceAi: true });
  assert(!rForce.deterministic, 'forceAi bypasses the deterministic short-circuit (→ AI/stub path)');

  // ── 3. runSyncPlan end-to-end (pre-supplied artifacts, stub mode): NEW records ──
  //     The rich direct-map result (variables/fields populated, narrative blank) is proof the
  //     direct-map path ran, NOT the thin stub (stub can't produce children joins).
  console.log('--- 3. runSyncPlan: new deterministic records ---');
  const pid = makeProject();
  const artifacts = [
    art('sc_cat_item', 'C100', 'Order Monitor', { name: 'Order Monitor', short_description: 'A monitor', category: 'Hardware' },
      [ child('item_option_new', 0, { question_text: 'Size' }) ]),
    art('sys_script', 'B100', 'Escalate SLA', { name: 'Escalate SLA', script: 'gs.log("x")' }),
    art('sn_aia_agent', 'G100', 'Router', { role: 'route', description: 'routes' }),
  ];
  const plan = await snSync.runSyncPlan({ projectId: pid, scope: SCOPE, artifacts, mode: 'additive_hitl' });
  const byId = {}; for (const p of plan.planned) byId[p.source_sys_id] = p;
  const catPl = byId['C100'], blPl = byId['B100'], agPl = byId['G100'];
  assert(catPl && catPl.classification === 'new' && catPl.decision.target === 'auto', 'new catalog_item → auto-apply create');
  assert(catPl.inferred.entity_data.variables && catPl.inferred.entity_data.variables.length === 1, 'new catalog_item carries joined variables (direct-map ran, not stub)');
  assert(blPl && blPl.classification === 'new' && blPl.decision.target === 'auto', 'new business_logic → auto-apply (materializes a blank-narrative entry per rule)');
  assert(!blPl.inferred.entity_data.plain_english, 'new business_logic narrative is BLANK');
  assert(agPl && agPl.classification === 'new', 'interpretive agent still planned (via stub in no-key mode)');

  // ── 4. runSyncPlan: CHANGED deterministic record takes the deterministic path (no reconcile Opus) ──
  console.log('--- 4. runSyncPlan: changed deterministic record ---');
  const pid2 = makeProject('2026-07-01 12:00:00');
  const blId = generateId();
  db.prepare(`INSERT INTO asdlc_business_logic (business_logic_id, project_id, slug, name, logic_type, source_system, source_sys_id, source_table, source_scope, source_fluent, source_hash, created_by, updated_by, updated_at)
              VALUES (?,?,?,?,?, 'servicenow', ?, 'sys_script', ?, ?, ?, 'seed','seed','2026-06-01 09:00:00')`)
    .run(blId, pid2, 'BL-1', 'Escalate SLA', 'business_rule', 'B200', SCOPE, 'gs.log("old")', 'HASH_OLD');
  const changedArt = art('sys_script', 'B200', 'Escalate SLA', { name: 'Escalate SLA', script: 'gs.log("NEW")' });   // script changed → new hash
  const plan2 = await snSync.runSyncPlan({ projectId: pid2, scope: SCOPE, artifacts: [changedArt], mode: 'additive_hitl' });
  const chg = plan2.planned.find(p => p.source_sys_id === 'B200');
  assert(chg && chg.classification === 'changed' && chg.deterministic === true, 'changed business_logic → deterministic plan (no Opus reconcile/review)');
  assert(chg.proposal.action === 'no_change', 'changed business_logic where only the script moved → no L1 field change (hash/source_fluent refresh at apply; narrative untouched)');

  // ── 5. "Explain with AI" endpoint narrates one record on request ──
  console.log('--- 5. Explain-with-AI endpoint ---');
  const r = await fetch(`${BASEURL}/projects/${pid2}/design/business-logic/${blId}/explain`, { method: 'POST', headers: HEADERS });
  const body = await r.json();
  assert(r.status === 200, 'POST .../explain returns 200');
  assert(typeof body.plain_english === 'string' && body.plain_english.length > 0, 'narrative populated after explain (stub text in no-key mode)');
  assert(body._stub === true, 'flagged _stub in no-key mode (real narration needs ANTHROPIC_API_KEY)');
  assert(body._cp && body._cp.cpCode, 'an auto-approved Change Packet records the narration');
  const reRow = db.prepare('SELECT plain_english FROM asdlc_business_logic WHERE business_logic_id = ?').get(blId);
  assert(reRow.plain_english && reRow.plain_english.length > 0, 'narrative persisted to the row');

  console.log(`\n=== test-sn-direct-map: ${pass} passed, ${fail} failed ===`);
  done(fail ? 1 : 0);
})().catch(e => { console.error('TEST ERROR', e); done(1); });
