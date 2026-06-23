// test-child-capture.js
// ─────────────────────────────────────────────────────────────────────────────
// P2 regression: captureScope() must capture catalog-item VARIABLES (item_option_new)
// as child artifacts linked to their parent catalog item — the SDK-grounded parent/child
// taxonomy added in P2 (alongside the existing table→column and flow→action surfaces).
// Mock fetch only; no network/DB writes.
'use strict';
process.env.ANTHROPIC_API_KEY = '';
const { captureScope } = require('./agent/sn-capture');

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log('  ok  -', msg); } else { failed++; console.log('  FAIL-', msg); } };

const PARENT_SYS = 'CAT123';
function mockFetch(url) {
  const tbl   = (url.match(/\/api\/now\/table\/([^?]+)/) || [])[1];
  const limit  = parseInt((url.match(/sysparm_limit=(\d+)/)  || [])[1] || '0', 10);
  const offset = parseInt((url.match(/sysparm_offset=(\d+)/) || [])[1] || '0', 10);
  const query = decodeURIComponent((url.match(/sysparm_query=([^&]+)/) || [])[1] || '');
  let all = [];
  if (tbl === 'sc_cat_item') {
    all = [{ sys_id: PARENT_SYS, name: 'Order a Laptop', short_description: 'Laptop request' }];
  } else if (tbl === 'item_option_new' && query.includes('cat_item=' + PARENT_SYS)) {
    all = [
      { sys_id: 'VAR1', cat_item: PARENT_SYS, name: 'model',         question_text: 'Laptop model',          type: '6', order: '100' },
      { sys_id: 'VAR2', cat_item: PARENT_SYS, name: 'justification', question_text: 'Business justification', type: '2', order: '200' },
      { sys_id: 'VAR3', cat_item: PARENT_SYS, name: 'urgent',        question_text: 'Urgent?',                type: '7', order: '300' },
    ];
  }
  const result = all.slice(offset, offset + (limit || all.length));
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ result }) });
}

(async () => {
  console.log('--- catalog item → variable child capture ---');
  const arts = await captureScope({ scope: 'x', instance: 'https://t', user: 'u', pw: 'p', fetchImpl: mockFetch });

  const parent = arts.find(a => a.source_table === 'sc_cat_item');
  ok(parent && parent.source_sys_id === PARENT_SYS, 'catalog item parent captured');

  const vars = arts.filter(a => a.source_table === 'item_option_new' && !a.__error && !a.__warn);
  console.log('  captured variables:', vars.length);
  ok(vars.length === 3, 'all 3 catalog variables captured as child artifacts');
  ok(vars.every(v => v.child_role === 'variable'), 'child_role = variable');
  ok(vars.every(v => v.parent_source_sys_id === PARENT_SYS), 'each variable linked to the parent catalog item sys_id');
  ok(vars.every(v => v.generic === true), 'variables captured on the generic substrate');

  const orders = vars.map(v => v.child_order);
  ok(orders.includes(100) && orders.includes(200) && orders.includes(300), 'child_order preserved from the order field');
  ok(vars.some(v => v.name === 'Laptop model'), 'variable name taken from question_text');

  const v1 = vars.find(v => v.source_sys_id === 'VAR1');
  ok(v1.payload && v1.payload.cat_item === PARENT_SYS && !('sys_id' in v1.payload),
     'payload keeps the deployable cat_item FK, drops sys_id audit noise');

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
})();
