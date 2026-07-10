// test-child-capture.js
// ─────────────────────────────────────────────────────────────────────────────
// P2 regression: captureScope() must capture catalog-item VARIABLES (item_option_new)
// as child artifacts linked to their parent catalog item — the SDK-grounded parent/child
// taxonomy added in P2 (alongside the existing table→column and flow→action surfaces).
//
// #108 follow-up additions:
//   Part 2 — a 3-level child chain (sc_cat_item -> sc_req_item -> sc_task), which only
//     resolves correctly once the parentsByTable staleness bug is fixed (parentsByTable
//     must see rows CHILD_SURFACES itself captured earlier in the SAME pass). Run in the
//     SAME captureScope() call as Part 1, so Part 1's assertions double as the regression
//     guard that the fix left the existing 1-level case byte-for-byte unaffected.
//   Part 3 — bounded reference-resolution (sc_task.assignment_group -> sys_user_group):
//     resolves only the SPECIFIC groups referenced, never the whole table; zero sc_task
//     rows -> zero resolver calls.
//   Part 4 — the open-ended/platform-wide throttle: row cap, most-recent-first ordering,
//     no scope filter, no child recursion, and REAL_TABLE validation of an unsafe name.
//
// Mock fetch only; no network/DB writes.
'use strict';
process.env.ANTHROPIC_API_KEY = '';
const { captureScope } = require('./agent/sn-capture');

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log('  ok  -', msg); } else { failed++; console.log('  FAIL-', msg); } };

const PARENT_SYS = 'CAT123';
const REQ_SYS = 'REQ1';
const GROUP_A = 'GRP-A', GROUP_B = 'GRP-B', GROUP_UNREFERENCED = 'GRP-UNUSED';

// 45 platform-wide mock rows, PRE-SORTED most-recent-first (as ServiceNow's own
// ORDERBYDESCsys_updated_on would return them) — the mock does no sorting of its own;
// it just returns them in this order so the test can assert the capture code preserved it.
const CI_ROWS = Array.from({ length: 45 }, (_, i) => ({
  sys_id: `CI${String(i + 1).padStart(3, '0')}`,
  name: `Service CI ${i + 1}`,
  sys_updated_on: `2026-07-${String(45 - i).padStart(2, '0')} 00:00:00`,
}));

const calls = [];   // {table, query} log, reset between captureScope() calls below

function mockFetch(url) {
  const tbl    = decodeURIComponent((url.match(/\/api\/now\/table\/([^?]+)/) || [])[1] || '');
  const limit  = parseInt((url.match(/sysparm_limit=(\d+)/)  || [])[1] || '0', 10);
  const offset = parseInt((url.match(/sysparm_offset=(\d+)/) || [])[1] || '0', 10);
  const query  = decodeURIComponent((url.match(/sysparm_query=([^&]+)/) || [])[1] || '');
  calls.push({ table: tbl, query, url });

  let all = [];
  if (tbl === 'sc_cat_item' && query.includes('sys_scope.scope=x')) {
    all = [{ sys_id: PARENT_SYS, name: 'Order a Laptop', short_description: 'Laptop request' }];
  } else if (tbl === 'item_option_new' && query.includes('cat_item=' + PARENT_SYS)) {
    all = [
      { sys_id: 'VAR1', cat_item: PARENT_SYS, name: 'model',         question_text: 'Laptop model',          type: '6', order: '100' },
      { sys_id: 'VAR2', cat_item: PARENT_SYS, name: 'justification', question_text: 'Business justification', type: '2', order: '200' },
      { sys_id: 'VAR3', cat_item: PARENT_SYS, name: 'urgent',        question_text: 'Urgent?',                type: '7', order: '300' },
    ];
  } else if (tbl === 'sc_req_item' && query.includes('cat_item=' + PARENT_SYS)) {
    all = [{ sys_id: REQ_SYS, cat_item: PARENT_SYS, number: 'RITM0010001' }];
  } else if (tbl === 'sc_task' && query.includes('request_item=' + REQ_SYS)) {
    all = [
      { sys_id: 'TASK1', request_item: REQ_SYS, number: 'SCTASK0010001', assignment_group: GROUP_A },
      { sys_id: 'TASK2', request_item: REQ_SYS, number: 'SCTASK0010002', assignment_group: GROUP_B },
    ];
  } else if (tbl === 'sys_user_group') {
    // Enforce the sys_idIN filter in the mock itself — a hypothetical regression that
    // fetched the whole table would show up here as 3 rows instead of exactly 2.
    const m = /^sys_idIN(.+)$/.exec(query);
    const wanted = m ? new Set(m[1].split(',')) : null;
    const ALL_GROUPS = [
      { sys_id: GROUP_A, name: 'Level 1 Triage' },
      { sys_id: GROUP_B, name: 'Level 2 Support' },
      { sys_id: GROUP_UNREFERENCED, name: 'Never referenced' },
    ];
    all = wanted ? ALL_GROUPS.filter(g => wanted.has(g.sys_id)) : [];
  } else if (tbl === 'cmdb_ci_service') {
    all = CI_ROWS;
  }
  const result = all.slice(offset, offset + (limit || all.length));
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ result }) });
}

(async () => {
  console.log('--- catalog item -> variable -> request_item -> task child capture (+ reference resolution) ---');
  const arts = await captureScope({ scope: 'x', instance: 'https://t', user: 'u', pw: 'p', fetchImpl: mockFetch });

  const parent = arts.find(a => a.source_table === 'sc_cat_item');
  ok(parent && parent.source_sys_id === PARENT_SYS, 'catalog item parent captured');

  // ── Part 1 (regression guard): item_option_new unaffected by the parentsByTable fix ──
  const vars = arts.filter(a => a.source_table === 'item_option_new' && !a.__error && !a.__warn);
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

  // ── Part 2: 3-level chain — sc_cat_item -> sc_req_item -> sc_task ────────────────────
  const reqItems = arts.filter(a => a.source_table === 'sc_req_item' && !a.__error && !a.__warn);
  ok(reqItems.length === 1 && reqItems[0].source_sys_id === REQ_SYS, 'sc_req_item captured');
  ok(reqItems[0].parent_source_sys_id === PARENT_SYS, 'sc_req_item linked to its sc_cat_item parent (level 1->2)');

  const tasks = arts.filter(a => a.source_table === 'sc_task' && !a.__error && !a.__warn);
  ok(tasks.length === 2, 'both sc_task rows captured');
  ok(tasks.every(t => t.parent_source_sys_id === REQ_SYS),
     '3rd-level chain: sc_task linked to the sc_req_item parent (proves the parentsByTable staleness fix — ' +
     'this only works if rows sc_req_item itself just captured are visible as parents to the LATER sc_task entry)');
  ok(tasks.every(t => t.child_role === 'catalog_task'), 'child_role = catalog_task');

  // ── Part 3: bounded reference-resolution — sc_task.assignment_group -> sys_user_group ──
  const groups = arts.filter(a => a.source_table === 'sys_user_group' && !a.__error && !a.__warn);
  ok(groups.length === 2, 'exactly the 2 REFERENCED groups resolved (never the whole 3-row table)');
  ok(groups.every(g => g.resolved_reference === true), 'resolved rows flagged resolved_reference:true');
  ok(!groups.some(g => g.source_sys_id === GROUP_UNREFERENCED), 'the unreferenced 3rd group was never pulled in');
  ok(!groups.some(g => g.parent_source_sys_id), 'resolved rows carry no parent_source_sys_id — referenced, not owned/child-of');

  console.log('\n--- zero sc_task rows -> zero reference-resolver calls ---');
  calls.length = 0;
  const emptyArts = await captureScope({ scope: 'none', instance: 'https://t', user: 'u', pw: 'p', fetchImpl: mockFetch });
  ok(!emptyArts.some(a => a.source_table === 'sys_user_group'), 'no sys_user_group rows when no sc_task rows exist');
  ok(!calls.some(c => c.table === 'sys_user_group'), 'sys_user_group was never even fetched — the resolver short-circuits on zero referenced ids');

  // ── Part 4: open-ended/platform-wide throttle ────────────────────────────────────────
  console.log('\n--- open-ended platform-wide capture: row cap, ordering, no scope filter ---');
  calls.length = 0;
  const oeArts = await captureScope({
    scope: 'x', instance: 'https://t', user: 'u', pw: 'p', fetchImpl: mockFetch,
    slice: { platform_wide_surfaces: ['cmdb_ci_service'] },
  });
  const ciArts = oeArts.filter(a => a.source_table === 'cmdb_ci_service' && !a.__error && !a.__warn);
  ok(ciArts.length === 30, `capped at exactly 30 rows out of 45 (got ${ciArts.length})`);
  ok(ciArts.every(a => a.platform_wide === true), 'every row flagged platform_wide:true');
  ok(ciArts[0].source_sys_id === 'CI001' && ciArts[29].source_sys_id === 'CI030',
     'most-recent-first sample preserved (first 30 of the pre-sorted-desc fixture)');
  const ciCall = calls.find(c => c.table === 'cmdb_ci_service');
  ok(!!ciCall, 'cmdb_ci_service was actually queried');
  ok(ciCall.query.includes('ORDERBYDESCsys_updated_on'), 'query orders most-recently-updated first');
  ok(!ciCall.query.includes('sys_scope'), 'NO scope filter in the constructed query (deliberately sidesteps the unresolved scope-field risk)');
  ok(!oeArts.some(a => ['sys_dictionary', 'item_option_new', 'sc_req_item', 'sc_task', 'sys_ui_form_section', 'sys_ui_element', 'sys_ui_policy_action'].includes(a.source_table)),
     'no recursive child capture attempted under the open-ended table, and the normal CHILD_SURFACES cascade did not run at all for this platform_wide-only slice');
  ok(!oeArts.some(a => a.source_table === 'sc_cat_item'), 'a platform_wide-only slice does NOT silently fall back to whole-scope capture of everything else');

  console.log('\n--- open-ended: an unsafe/invalid table name is skipped, never fetched ---');
  calls.length = 0;
  const badArts = await captureScope({
    scope: 'x', instance: 'https://t', user: 'u', pw: 'p', fetchImpl: mockFetch,
    slice: { platform_wide_surfaces: ['DROP TABLE users;--'] },
  });
  ok(badArts.some(a => a.__warn && a.__warn.includes('not a valid ServiceNow table name')), 'unsafe table name produces a __warn, not a crash');
  ok(!calls.some(c => c.table.includes('DROP')), 'the unsafe table name was never actually fetched');

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
})();
