// test-reverse-l1.js — Phase 2 (reverse L1 parity) unit checks.
// Verifies the reverse-engineer reuses the forward L1 contract: buildInferred() turns a forward
// extract_* tool's output into a rich entity_data (parity with BRD-authored designs), strips
// provenance/meta, derives business_logic.logic_type from the SN source table, and keeps the
// envelope (design_type/name/purpose/confidence) the reconcile/review/materiality stages rely on.
//
// Run:  node test-reverse-l1.js   (from backend-node/)
'use strict';
const re = require('./agent/sn-reverse-engineer');

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { console.log('  ok  -', m); pass++; } else { console.error('  FAIL-', m); fail++; } };

console.log('\n--- buildInferred: rich data_model (parity) ---');
const dm = re.buildInferred('data_model',
  { name: 'Adoption', purpose: 'Stores adoptions', fields: [{ label: 'Email' }, { label: 'Status' }],
    confidence: 0.82, source_sys_id: 'SHOULD_BE_STRIPPED', operation: 'create' },
  { source_table: 'sys_db_object', name: 'x_adopt_adoption' });
assert(dm.design_type === 'data_model', 'design_type carried');
assert(Array.isArray(dm.entity_data.fields) && dm.entity_data.fields.length === 2, 'entity_data.fields[] preserved (rich L1)');
assert(dm.entity_data.source_sys_id === undefined && dm.entity_data.operation === undefined, 'provenance + meta stripped from entity_data');
assert(dm.confidence === 0.82, 'confidence lifted into envelope');
assert(/Stores adoptions/.test(dm.purpose), 'envelope purpose populated (for reconcile/review)');
assert(dm.key_details.includes('Email'), 'key_details summarizes field labels');

console.log('\n--- buildInferred: business_logic logic_type derived from source_table ---');
const bl1 = re.buildInferred('business_logic', { name: 'Set Status', plain_english: 'sets status' }, { source_table: 'sys_script_client' });
assert(bl1.entity_data.logic_type === 'client_script', 'sys_script_client → client_script');
const bl2 = re.buildInferred('business_logic', { name: 'Calc', plain_english: 'x' }, { source_table: 'sys_script' });
assert(bl2.entity_data.logic_type === 'business_rule', 'sys_script → business_rule');
const bl3 = re.buildInferred('business_logic', { name: 'Inc', plain_english: 'x' }, { source_table: 'sys_script_include' });
assert(bl3.entity_data.logic_type === 'script_include', 'sys_script_include → script_include');
const bl4 = re.buildInferred('business_logic', { name: 'Act', plain_english: 'x', logic_type: 'ui_action' }, { source_table: 'sys_ui_action' });
assert(bl4.entity_data.logic_type === 'ui_action', 'model-provided logic_type respected');

console.log('\n--- buildInferred: tool keeps inputs/outputs/errors (parity) ---');
const tool = re.buildInferred('tool',
  { name: 'CRM Create', contract: 'create customer', inputs: ['name', 'email'], outputs: ['crm_id'], errors: ['timeout'] },
  { source_table: 'sn_aia_tool' });
assert(Array.isArray(tool.entity_data.inputs) && tool.entity_data.outputs && tool.entity_data.errors, 'tool inputs/outputs/errors preserved');

console.log('\n--- SN table → type map ---');
assert(re.SN_TABLE_TO_TYPE.sys_ui_form === 'form_design' && re.SN_TABLE_TO_TYPE.sys_ui_policy === 'form_design', 'forms + UI policies → form_design');
assert(re.SN_TABLE_TO_TYPE.sys_hub_flow === 'workflow' && re.SN_TABLE_TO_TYPE.sc_cat_item === 'catalog_item', 'flow→workflow, catalog→catalog_item');

console.log('\n--- stubInference carries entity_data (offline parity floor) ---');
const stub = re.stubInference({ source_table: 'sn_aia_tool', name: 'Stub Tool', salient: {} });
assert(stub.design_type === 'tool' && stub.entity_data && stub.entity_data.name === 'Stub Tool', 'stub produces typed entity_data');
const stubWf = re.stubInference({ source_table: 'sys_hub_flow', name: 'Flow', salient: {} });
assert(stubWf.entity_data.trigger && typeof stubWf.entity_data.trigger === 'object', 'stub workflow trigger is a structured object');

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
