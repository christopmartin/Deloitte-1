// test-slice-ingest.js
// ─────────────────────────────────────────────────────────────────────────────
// Slice-scoped ingest (Part A) + generic field-level 3-way merge (Part B/R7).
// Temp DB; capture uses a mock fetch; no network, no AI.
'use strict';
const path = require('path');
const os = require('os');
process.env.ASDLC_DB_PATH = path.join(os.tmpdir(), `asdlc_slice_${Date.now()}.db`);
process.env.ANTHROPIC_API_KEY = '';

const { db, generateId } = require('./db');
const cap = require('./agent/sn-capture');
const snSync = require('./agent/sn-sync');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  -', m); } else { fail++; console.error('  FAIL-', m); } };
const done = (code) => { try { db.close(); } catch {} process.exit(code); };

(async () => {
  // ── Part 1: slice helpers (pure) ────────────────────────────────────────────
  console.log('--- Part 1: slice helpers ---');
  ok(cap.normalizeSlice(null) === null, 'normalizeSlice(null) → null (whole scope)');
  ok(cap.normalizeSlice({ include_surfaces: [] }) === null, 'empty include_surfaces → null (whole scope)');
  const ns = cap.normalizeSlice({ include_surfaces: ['sc_cat_item'], per_surface_cap: 5 });
  ok(ns && ns.surfaces.has('sc_cat_item') && ns.cap === 5, 'normalizeSlice parses surfaces + cap');

  const expanded = cap.expandSliceSurfaces({ include_surfaces: ['sc_cat_item'] });
  ok(expanded.has('sc_cat_item') && expanded.has('item_option_new'), 'expandSliceSurfaces adds child table (item_option_new) of an included parent');

  ok(cap.sliceQuery('myscope', 'sc_cat_item', null) === 'sys_scope.scope=myscope^ORDERBYsys_id', 'sliceQuery: whole-scope query when no slice');
  ok(cap.sliceQuery('myscope', 'sc_cat_item', { include_surfaces: ['sc_cat_item'], record_filters: { sc_cat_item: 'active=true' } })
       === 'sys_scope.scope=myscope^active=true^ORDERBYsys_id', 'sliceQuery: ANDs a (future) record filter when present');
  const mq = cap.sliceMetadataQuery('myscope', { include_surfaces: ['sc_cat_item'] });
  ok(mq.includes('sys_class_nameIN') && mq.includes('sc_cat_item') && mq.includes('item_option_new'),
     'sliceMetadataQuery bounds the sweep to the slice classes');

  // ── Part 2: captureScope bounds surfaces + honors a per-surface cap ──────────
  console.log('\n--- Part 2: bounded capture ---');
  const queried = new Set();
  const PARENT = 'CAT1';
  function mockFetch(url) {
    const tbl = (url.match(/\/api\/now\/table\/([^?]+)/) || [])[1];
    const query = decodeURIComponent((url.match(/sysparm_query=([^&]+)/) || [])[1] || '');
    const limit = parseInt((url.match(/sysparm_limit=(\d+)/) || [])[1] || '0', 10);
    const offset = parseInt((url.match(/sysparm_offset=(\d+)/) || [])[1] || '0', 10);
    queried.add(tbl);
    let all = [];
    if (tbl === 'sc_cat_item') {
      all = [{ sys_id: 'C1', name: 'Item 1' }, { sys_id: 'C2', name: 'Item 2' }, { sys_id: 'C3', name: 'Item 3' }];
    } else if (tbl === 'item_option_new' && query.includes('cat_item=')) {
      all = [{ sys_id: 'V1', cat_item: 'C1', question_text: 'Q1', order: '100' }];
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ result: all.slice(offset, offset + (limit || all.length)) }) });
  }

  const arts = await cap.captureScope({ scope: 'x', instance: 'https://t', user: 'u', pw: 'p', fetchImpl: mockFetch, slice: { include_surfaces: ['sc_cat_item'] } });
  ok(queried.has('sc_cat_item'), 'in-slice surface (sc_cat_item) IS queried');
  ok(queried.has('item_option_new'), 'child of an in-slice parent (item_option_new) IS queried');
  // #108 follow-up: sc_req_item is now ALSO a CHILD_SURFACES entry of sc_cat_item (catalog
  // fulfillment work records), so it is queried too (it just returns 0 rows here, since this
  // mock doesn't stub it) — sc_task (child of sc_req_item) is never queried because it has
  // zero parents to iterate when sc_req_item returns no rows.
  ok(queried.has('sc_req_item'), 'sc_req_item (child of the in-slice sc_cat_item) IS queried');
  ok(!queried.has('sys_script') && !queried.has('sn_aia_agent'), 'out-of-slice surfaces are NOT queried');
  ok(queried.size === 3, `ONLY the slice surfaces were touched (got ${queried.size}: ${[...queried].join(', ')})`);
  ok(arts.filter(a => a.source_table === 'sc_cat_item' && !a.__warn && !a.__error).length === 3, 'all 3 in-slice records captured');

  queried.clear();
  const capped = await cap.captureScope({ scope: 'x', instance: 'https://t', user: 'u', pw: 'p', fetchImpl: mockFetch, slice: { include_surfaces: ['sc_cat_item'], per_surface_cap: 1 } });
  ok(capped.filter(a => a.source_table === 'sc_cat_item' && !a.__warn && !a.__error).length === 1, 'per_surface_cap truncates the surface to 1 record (no PARTIAL warning)');
  ok(!capped.some(a => a.__warn), 'intentional cap does NOT raise a PARTIAL warning');

  // ── Part 3: drift candidacy is bounded to the slice ─────────────────────────
  console.log('\n--- Part 3: slice-bounded drift ---');
  db.prepare("INSERT INTO asdlc_client (client_id,client_name,client_code) VALUES (?,?,?)").run('c1', 'Client', 'C1');
  const pid = generateId();
  db.prepare("INSERT INTO asdlc_project (project_id,client_id,project_name,project_code) VALUES (?,?,?,?)").run(pid, 'c1', 'Proj', 'P1');
  // Two WB rows carrying provenance; neither appears in the (empty) capture → both are drift
  // candidates. Drift candidacy keys on source_table: only 'sc_cat_item' is in the slice.
  const insTool = (name, sysId, srcTable) => db.prepare(
    "INSERT INTO asdlc_tool (tool_id,project_id,name,source_system,source_sys_id,source_table,source_hash) VALUES (?,?,?,?,?,?,?)"
  ).run(generateId(), pid, name, 'servicenow', sysId, srcTable, 'h');
  insTool('In-slice row', 'IN-SLICE', 'sc_cat_item');
  insTool('Out-of-slice row', 'OUT-SLICE', 'sn_aia_tool');

  const sliceSurfaces = cap.expandSliceSurfaces({ include_surfaces: ['sc_cat_item'] });
  const bounded = cap.classifyArtifacts([], pid, { sliceSurfaces });
  ok(bounded.drift.some(d => d.source_sys_id === 'IN-SLICE'), 'in-slice WB row IS a drift candidate');
  ok(!bounded.drift.some(d => d.source_sys_id === 'OUT-SLICE'), 'out-of-slice WB row is NOT flagged drift (would be a false delete)');

  const unbounded = cap.classifyArtifacts([], pid, {});
  ok(unbounded.drift.some(d => d.source_sys_id === 'IN-SLICE') && unbounded.drift.some(d => d.source_sys_id === 'OUT-SLICE'),
     'without a slice, both rows are drift (unchanged legacy behavior)');

  // ── Part 4: generic field-level 3-way merge (R7) via runSyncPlan ────────────
  console.log('\n--- Part 4: generic field-level merge (R7) ---');
  db.prepare("UPDATE asdlc_project SET sn_last_synced_at='2000-01-01 00:00:00' WHERE project_id=?").run(pid);
  const insArtifact = (sysId, name, base, wb, hash) => db.prepare(
    `INSERT INTO asdlc_sn_artifact (sn_artifact_id, project_id, sn_metadata_type, tier, name, payload,
       source_system, source_sys_id, source_table, source_fluent, source_hash, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?, '2030-01-01 00:00:00')`
  ).run(generateId(), pid, 'acl', 'C', name, JSON.stringify(wb), 'servicenow', sysId, 'sys_security_acl', JSON.stringify(base), hash);

  // GEN1: no conflict — WB edited field b, ServiceNow edited field a.
  insArtifact('GEN1', 'ACL One', { a: '1', b: '2' }, { a: '1', b: '2edited' }, 'OLD1');
  // GEN2: conflict — both sides changed field a to different values.
  insArtifact('GEN2', 'ACL Two', { a: '1' }, { a: 'wbval' }, 'OLD2');

  const mkArt = (sysId, snPayload, hash) => ({
    source_table: 'sys_security_acl', sn_metadata_type: 'acl', design_type: 'acl', tier: 'C',
    generic: true, source_sys_id: sysId, name: 'ACL', salient: snPayload, payload: snPayload, hash,
  });
  const artifacts = [
    mkArt('GEN1', { a: '1new', b: '2' }, 'NEW1'),   // SN moved a
    mkArt('GEN2', { a: 'snval' }, 'NEW2'),          // SN moved a (conflict with WB)
  ];

  const plan = await snSync.runSyncPlan({ projectId: pid, scope: 'x', artifacts, mode: 'additive_hitl' }, { projectId: pid });
  const g1 = plan.planned.find(p => p.source_sys_id === 'GEN1');
  const g2 = plan.planned.find(p => p.source_sys_id === 'GEN2');

  ok(g1 && g1.decision.target === 'auto', 'GEN1 (disjoint edits) auto-applies — no whole-record HITL veto');
  ok(g1 && g1.generic_record && g1.generic_record.payload.a === '1new' && g1.generic_record.payload.b === '2edited',
     'GEN1 merged payload = SN-only field applied (a) + Workbench edit kept (b)');
  ok(g1 && g1.field_classification && g1.field_classification.sn_only === 1 && g1.field_classification.wb_only === 1,
     'GEN1 field classification: 1 sn_only + 1 wb_only, 0 both_changed');

  ok(g2 && g2.decision.target === 'hitl', 'GEN2 (both sides changed field a) → human review');
  ok(g2 && /both sides changed/.test(g2.decision.reason) && /\ba\b/.test(g2.decision.reason), 'GEN2 HITL reason names the conflicting field (a)');

  console.log(`\n=== test-slice-ingest: ${pass} passed, ${fail} failed ===`);
  done(fail ? 1 : 0);
})();
