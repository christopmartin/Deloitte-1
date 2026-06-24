// test-capture-pagination.js
// ─────────────────────────────────────────────────────────────────────────────
// P1 regression: captureScope() must page through ALL rows of a surface, not stop
// at the old single-shot sysparm_limit=1000. Uses a mock fetch (no network/DB writes)
// that serves a target table in pages keyed off sysparm_offset/sysparm_limit.
'use strict';
process.env.ANTHROPIC_API_KEY = '';            // stay offline
const { captureScope, classifyArtifacts } = require('./agent/sn-capture');

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log('  ok  -', msg); } else { failed++; console.log('  FAIL-', msg); } };

// Mock fetch: TARGET table returns `total` synthetic rows, paged by the URL's
// sysparm_offset/sysparm_limit; every other table returns an empty result set.
function makeMockFetch(targetTable, total) {
  return async function (url) {
    const tbl    = (url.match(/\/api\/now\/table\/([^?]+)/) || [])[1];
    const limit  = parseInt((url.match(/sysparm_limit=(\d+)/)  || [])[1] || '0', 10);
    const offset = parseInt((url.match(/sysparm_offset=(\d+)/) || [])[1] || '0', 10);
    const result = [];
    if (tbl === targetTable) {
      for (let i = offset; i < Math.min(offset + limit, total); i++) {
        result.push({ sys_id: 'SYS' + i, name: 'agent_' + i, role: 'r', description: 'd', instructions: 'x' });
      }
    }
    return { ok: true, status: 200, json: async () => ({ result }) };
  };
}

const CONN = { scope: 'x', instance: 'https://t', user: 'u', pw: 'p' };

(async () => {
  console.log('--- pagination captures ALL rows (no silent 1000 truncation) ---');
  process.env.SN_CAPTURE_PAGE_SIZE = '100';   // small pages so multi-page paging is exercised
  delete process.env.SN_CAPTURE_MAX_ROWS;
  const TOTAL = 2500;                          // well past the old 1000 ceiling and one page
  const arts = await captureScope({ ...CONN, fetchImpl: makeMockFetch('sn_aia_agent', TOTAL) });
  const agents = arts.filter(a => !a.__error && !a.__warn && a.source_table === 'sn_aia_agent');
  console.log('  captured agents:', agents.length);
  ok(agents.length === TOTAL, `captured all ${TOTAL} rows across pages (got ${agents.length}) — old code stopped at 1000`);
  ok(agents.length > 1000, 'captured count exceeds the old single-page 1000 cap');
  ok(new Set(agents.map(a => a.source_sys_id)).size === TOTAL, 'no duplicate / skipped rows across page boundaries');
  ok(arts.filter(a => a.__error).length === 0, 'no surface errors');

  console.log('--- safety ceiling: a capped surface emits a __warn (never silent) ---');
  process.env.SN_CAPTURE_PAGE_SIZE = '100';
  process.env.SN_CAPTURE_MAX_ROWS  = '300';
  const arts2  = await captureScope({ ...CONN, fetchImpl: makeMockFetch('sn_aia_agent', 1000) });
  const warns  = arts2.filter(a => a.__warn).map(w => w.__warn);
  console.log('  warnings:', JSON.stringify(warns));
  ok(warns.some(w => /capped/.test(w) && /sn_aia_agent/.test(w)), 'capped surface surfaced a __warn naming the table');
  const agents2 = arts2.filter(a => !a.__error && !a.__warn && a.source_table === 'sn_aia_agent');
  ok(agents2.length >= 300 && agents2.length < 1000, `capped capture is PARTIAL (${agents2.length} rows, ceiling 300), not silently complete`);

  console.log('--- classifyArtifacts surfaces warnings + per-surface counts ---');
  const cls = classifyArtifacts(arts2, 'no-such-project');
  ok((cls.warnings || []).length >= 1, 'classify collected the capture warning(s)');
  ok(cls.summary.warnings >= 1, 'summary.warnings reflects the count');
  ok(cls.surface_counts && cls.surface_counts['sn_aia_agent'] === agents2.length, 'surface_counts reports per-surface captured count');
  ok(!cls.new.some(a => a.__warn) && !cls.changed.some(a => a.__warn), '__warn markers never classified as artifacts');

  console.log('--- generic (Tier-B/C) surface multi-page pagination ---');
  process.env.SN_CAPTURE_PAGE_SIZE = '100';
  delete process.env.SN_CAPTURE_MAX_ROWS;
  const GEN_TOTAL = 1500;
  const arts3 = await captureScope({ ...CONN, fetchImpl: makeMockFetch('sys_security_acl', GEN_TOTAL) });
  const genArts = arts3.filter(a => !a.__error && !a.__warn && a.source_table === 'sys_security_acl');
  console.log('  captured sys_security_acl:', genArts.length);
  ok(genArts.length === GEN_TOTAL, `generic surface: captured all ${GEN_TOTAL} rows across pages (got ${genArts.length})`);
  ok(new Set(genArts.map(a => a.source_sys_id)).size === GEN_TOTAL, 'generic surface: no duplicate / skipped rows across page boundaries');

  console.log('--- child surface multi-page pagination (sys_dictionary > 1 page of columns) ---');
  process.env.SN_CAPTURE_PAGE_SIZE = '100';
  delete process.env.SN_CAPTURE_MAX_ROWS;
  const PARENT_SYS_ID = 'TABLE_SYS_001';
  const PARENT_NAME   = 'x_myapp_tbl';
  const CHILD_TOTAL   = 250;
  function makeChildMockFetch() {
    return async function(url) {
      const tbl    = (url.match(/\/api\/now\/table\/([^?]+)/) || [])[1];
      const limit  = parseInt((url.match(/sysparm_limit=(\d+)/)  || [])[1] || '0', 10);
      const offset = parseInt((url.match(/sysparm_offset=(\d+)/) || [])[1] || '0', 10);
      const query  = decodeURIComponent((url.match(/sysparm_query=([^&]+)/) || [])[1] || '');
      let all = [];
      if (tbl === 'sys_db_object') {
        all = [{ sys_id: PARENT_SYS_ID, name: PARENT_NAME, label: 'My App Table', super_class: '' }];
      } else if (tbl === 'sys_dictionary' && query.includes('name=' + PARENT_NAME)) {
        for (let i = 0; i < CHILD_TOTAL; i++) all.push({ sys_id: 'COL' + i, element: 'col_' + i });
      }
      const result = all.slice(offset, offset + (limit || all.length));
      return { ok: true, status: 200, json: async () => ({ result }) };
    };
  }
  const arts4 = await captureScope({ ...CONN, fetchImpl: makeChildMockFetch() });
  const cols = arts4.filter(a => !a.__error && !a.__warn && a.source_table === 'sys_dictionary');
  console.log('  captured sys_dictionary (columns):', cols.length);
  ok(cols.length === CHILD_TOTAL, `child pagination: captured all ${CHILD_TOTAL} columns across multiple pages (got ${cols.length})`);
  ok(cols.every(c => c.parent_source_sys_id === PARENT_SYS_ID), 'child pagination: all children linked to correct parent_source_sys_id');
  ok(new Set(cols.map(c => c.source_sys_id)).size === CHILD_TOTAL, 'child pagination: no duplicate / skipped child rows across page boundaries');

  delete process.env.SN_CAPTURE_PAGE_SIZE;
  delete process.env.SN_CAPTURE_MAX_ROWS;
  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
})();
