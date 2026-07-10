// agent/sn-capture.js
// ─────────────────────────────────────────────────────────────────────────────
// ServiceNow round-trip — Phase B: full-scope capture + deterministic pre-diff (tier-0).
//
// captureScope()   — live, read-only REST pull of ALL design surfaces for a scope.
// hashArtifact()   — stable content hash of an artifact's salient fields.
// classifyArtifacts() — PURE, testable: classify captured artifacts against the linked
//                    Workbench project as unchanged / changed / new / drift, matching by
//                    source_sys_id and comparing source_hash. Only changed/new/ambiguous
//                    items need the expensive Opus reasoning (Phases C–E); unchanged items
//                    skip the LLM entirely (the cost tier-0); drift is flagged, NEVER deleted.
'use strict';
const crypto = require('crypto');
const { db } = require('../db');
// SN metadata surfaces we capture, sourced from the shared target-table catalog
// (sn-catalog.js) so capture and assessment stay in lockstep. Missing tables on an
// instance are skipped. Covers AI-agent apps + data-centric apps.
const { SN_SURFACES, normalizeInstanceUrl } = require('./sn-catalog');
const reg = require('./sn-type-registry');
const { snFieldDelta } = require('./three-way-merge');

// Pure-audit/system columns dropped from a generic artifact payload (noise, not design).
const PAYLOAD_NOISE = new Set([
  'sys_id', 'sys_created_on', 'sys_created_by', 'sys_updated_on', 'sys_updated_by',
  'sys_mod_count', 'sys_tags', 'sys_domain', 'sys_domain_path', 'sys_class_name',
  'sys_scope', 'sys_package', 'sys_policy', 'sys_update_name', 'sys_overrides',
  'sys_customer_update', 'sys_replace_on_upgrade', 'sys_name',
]);
const REAL_TABLE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

// ── TLS / proxy helper ───────────────────────────────────────────────────────
// Corporate networks that do SSL inspection present a self-signed cert chain that
// Node.js (which uses its own CA bundle, not the OS store) rejects with
// SELF_SIGNED_CERT_IN_CHAIN. Set SN_INSECURE_TLS=true in .env to bypass; uses
// undici's native Agent (built into Node 18+) so no extra package is needed.
// The proper fix is NODE_EXTRA_CA_CERTS pointing to the corporate root CA PEM.
function makeFetch(fetchImpl) {
  if (fetchImpl) return fetchImpl;
  if (process.env.SN_INSECURE_TLS === 'true') {
    try {
      const { Agent } = require('undici');
      const agent = new Agent({ connect: { rejectUnauthorized: false } });
      return (url, opts = {}) => fetch(url, { ...opts, dispatcher: agent });
    } catch { /* undici unavailable — fall through */ }
  }
  return fetch;
}

// ── Pagination (P1) ──────────────────────────────────────────────────────────
// Every Table API GET is capped at one page; the old single-shot `sysparm_limit=1000`
// SILENTLY DROPPED the 1001st row, so a large scope imported looking complete. We now
// page on `sysparm_offset` until a short page signals the end. Read from env at CALL time
// (not module load) so tests can dial these down. `maxRows` is a runaway/OOM ceiling —
// crossing it is surfaced as a per-surface __warn (the import is then knowingly partial),
// NEVER swallowed.
const pageSize = () => Math.max(1, parseInt(process.env.SN_CAPTURE_PAGE_SIZE || '1000', 10) || 1000);
const maxRows  = () => Math.max(1, parseInt(process.env.SN_CAPTURE_MAX_ROWS  || '50000', 10) || 50000);

// ── Bounded reference-resolution (#108 follow-up, §2b) ──────────────────────────────
// For a table that is REFERENCED (e.g. sc_task.assignment_group) rather than owned/child-of
// anything captured, resolve ONLY the specific records actually seen — never the whole
// target table, which would have no natural blast-radius limit. Adding a pair here is a
// deliberate code change (an explicit, reviewable allow-list), never a generic "any
// reference field" scan. Self-bounding: it can only ever resolve what capture already,
// causally, pulled in — and a hard ceiling (SN_REF_RESOLVE_MAX_IDS) on top of that.
// KNOWN LIMITATION (accepted, not fixed here): the sys_metadata completeness sweep is
// itself scope-filtered, so a resolved row here (not scope-owned by the app) may be
// mislabeled "vanished" by drift disambiguation later — never destructive, just a
// misleading label.
const REFERENCE_RESOLUTIONS = [
  { sourceTable: 'sc_task', field: 'assignment_group', targetTable: 'sys_user_group', role: 'assignment_group' },
];
const refResolveMaxIds = () => Math.max(1, parseInt(process.env.SN_REF_RESOLVE_MAX_IDS || '200', 10) || 200);

// ── Open-ended platform-wide capture (#108 follow-up, §3): an explicit, separately-
// triggered escalation — tables the planner named from its OWN knowledge (no natural
// scoping, no curated field list, no prior validation), never silently blended into a
// normal plan. `slice.platform_wide_surfaces` (orthogonal to `include_surfaces`) is the
// only path into this list. Deliberately different from every capture pass above: NO
// scope filter at all (sidesteps the unresolved "does a scope-filtered query error on a
// table with no sys_scope field" risk rather than gambling on it), a hard LOW row cap,
// most-recently-updated-first ordering for a representative sample, and no recursive
// child capture. `SN_OPEN_ENDED_ROW_CAP` is independent of, and always lower than, the
// project's normal per_surface_cap.
const openEndedRowCap = () => Math.max(1, parseInt(process.env.SN_OPEN_ENDED_ROW_CAP || '30', 10) || 30);

/** Extract the (optional) open-ended/platform-wide table list from a raw slice object. */
function openEndedTables(slice) {
  return (slice && Array.isArray(slice.platform_wide_surfaces))
    ? slice.platform_wide_surfaces.filter(t => typeof t === 'string' && t)
    : [];
}

/**
 * Fetch ALL rows of a Table API query, paging by sysparm_offset until a short page
 * (or the safety ceiling) is reached. `baseUrl` must already carry the query
 * (sysparm_query/fields/etc.) but NOT sysparm_limit/sysparm_offset. A stable
 * `^ORDERBYsys_id` in the query is assumed by callers so offsets don't skip/dupe.
 * @returns {Promise<{rows:Array, capped:boolean}>}
 * @throws {Error} on HTTP !ok ("HTTP <status>") or transport failure — the caller
 *   turns it into the same per-surface __error entry it always produced.
 */
async function fetchAllRows(f, baseUrl, headers, cap) {
  const limit = pageSize();
  const ceiling = maxRows();
  const wantCap = (cap != null && Number.isFinite(Number(cap)) && Number(cap) > 0) ? Number(cap) : null;
  const rows = [];
  let offset = 0;
  for (;;) {
    const r = await f(`${baseUrl}&sysparm_limit=${limit}&sysparm_offset=${offset}`, { headers });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const page = ((await r.json()) || {}).result || [];
    rows.push(...page);
    // Intentional per-surface slice cap reached — a deliberate bound, NOT a partial-import warning.
    if (wantCap && rows.length >= wantCap) return { rows: rows.slice(0, wantCap), capped: false };
    if (page.length < limit) return { rows, capped: false };   // last (short) page → done
    if (rows.length >= ceiling) return { rows, capped: true };  // safety ceiling hit → partial
    offset += limit;
  }
}

/**
 * Tier-B/C capture surfaces, sourced from the SDK capability registry: real top-level
 * tables that have NO rich Tier-A Level-1 mapping and are NOT column/variable sub-elements
 * (those are captured under their parent, never as standalone surfaces). These are the
 * long-tail artifacts dropped today (ACLs, roles, SLAs, properties, ATF tests, …).
 */
function genericSurfaces() {
  const catalogTables = new Set(SN_SURFACES.map(s => s.table));
  const seen = new Set();
  const out = [];
  for (const t of reg.allTypes()) {
    if (!t.source_table || t.tier === 'A' || t.parent_type) continue;     // skip Tier-A + child subtypes
    if (catalogTables.has(t.source_table) || seen.has(t.source_table)) continue;
    if (!REAL_TABLE.test(t.source_table)) continue;                        // exclude bogus column-derived "tables"
    seen.add(t.source_table);
    out.push({ table: t.source_table, sn_metadata_type: t.sn_metadata_type, tier: t.tier });
  }
  return out;
}

// Recursive CHILD surfaces (Phase 2 follow-up): sub-elements with their own sys_id that
// belong to a captured parent. Each becomes a generic child artifact linked via
// parent_source_sys_id (→ parent_artifact_id at materialize time) so it round-trips and
// drifts independently. `parentKey` selects how the child query references the parent:
// columns key off the parent table NAME (sys_dictionary.name = table name); flow actions
// and catalog variables key off the parent SYS_ID.
//
// COVERAGE NOTE (P2, extended for form fidelity — #105): the SDK capability registry models
// `table → columns` and `catalogitem → variables`. Forms are a genuine THIRD taxonomy, just a
// two-level one (form → form_section join row → elements), added here directly since sections
// and mandatory/read-only behavior are literal ServiceNow data, not narrative — see BACKLOG #103's
// research note that `form_design`'s only soft field is `behavior_notes`.
//
// Two ways a row's parent list is built:
//   parentKey: 'sysId'|'name'  — the DEFAULT: parent list comes from that table's OWN top-level
//     captured artifacts (source_sys_id / salient.name), as before.
//   parentKeyField: '<field>' — a CHAINED (2nd-level) surface: the parent list is derived from
//     an EARLIER CHILD_SURFACES entry's OWN captured rows, using a field captured on THOSE rows
//     as the query key (queryKey) while still attaching new children under the parent ROW's own
//     sys_id (sysId) — so `sys_ui_element` rows nest under the `sys_ui_form_section` row that named
//     their section, even though the section's sys_id (not the join row's) is what the query filters
//     on. Requires the referenced parentTable to appear EARLIER in this array (single forward pass).
//   fields: '<sysparm_fields>' — optional explicit field list (supports dot-walks, e.g.
//     'sys_ui_section.caption') so a single query can inline a related record's field without a
//     separate table hop.
const CHILD_SURFACES = [
  { childTable: 'sys_dictionary',           parentTable: 'sys_db_object', role: 'column',
    parentKey: 'name',  filter: p => `name=${p.name}^elementISNOTEMPTY`, nameField: 'element',       orderField: null },
  { childTable: 'sys_hub_action_instance',  parentTable: 'sys_hub_flow',  role: 'action',
    parentKey: 'sysId', filter: p => `flow=${p.sysId}`,                   nameField: 'display_text',  orderField: 'order' },
  // Catalog item variables (item_option_new.cat_item = catalog item sys_id). The deployable
  // parent ref (cat_item) stays in the payload; order drives child_order.
  { childTable: 'item_option_new',          parentTable: 'sc_cat_item',   role: 'variable',
    parentKey: 'sysId', filter: p => `cat_item=${p.sysId}`,               nameField: 'question_text', orderField: 'order' },
  // Catalog fulfillment work records (#108 follow-up — "reach" gap): a catalog item's actual
  // work happens on the Requested Item and its Catalog Tasks, both standard Task-based tables,
  // never a new custom table. sc_task is a 3rd-level chain — its parentTable (sc_req_item) is
  // itself a CHILD_SURFACES entry, so it only resolves via the parentsByTable staleness fix
  // (rows captured by an EARLIER entry are appended into the snapshot after that entry runs).
  { childTable: 'sc_req_item',              parentTable: 'sc_cat_item',   role: 'request_item',
    parentKey: 'sysId', filter: p => `cat_item=${p.sysId}`,               nameField: 'number',        orderField: null },
  { childTable: 'sc_task',                  parentTable: 'sc_req_item',   role: 'catalog_task',
    parentKey: 'sysId', filter: p => `request_item=${p.sysId}`,           nameField: 'number',        orderField: null },
  // Form sections: one row per (form, section) join. The section's own caption/name is
  // dot-walked onto the SAME row so no separate sys_ui_section fetch is needed.
  { childTable: 'sys_ui_form_section',      parentTable: 'sys_ui_form',   role: 'form_section',
    parentKey: 'sysId', filter: p => `sys_ui_form=${p.sysId}`,            nameField: null,            orderField: 'position',
    fields: 'sys_id,sys_ui_form,sys_ui_section,sys_ui_section.caption,sys_ui_section.name,position' },
  // Fields shown within each section — chained off the sys_ui_section value captured above.
  { childTable: 'sys_ui_element',           parentTable: 'sys_ui_form_section', role: 'form_element',
    parentKeyField: 'sys_ui_section',       filter: p => `sys_ui_section=${p.queryKey}`, nameField: 'element', orderField: 'position' },
  // UI-policy actions: which fields a policy makes mandatory/read-only/visible.
  { childTable: 'sys_ui_policy_action',     parentTable: 'sys_ui_policy', role: 'policy_action',
    parentKey: 'sysId', filter: p => `ui_policy=${p.sysId}`,              nameField: 'field',         orderField: null },
];

// ── Slice: bound an ingest to a SUBSET of a scope (surface/type selection now, a future
// record-level filter later). A slice is the runtime form of the project's saved import
// profile: { include_surfaces: string[], per_surface_cap?: number|null, record_filters?:
// {table: encodedQuery} }. null / empty include_surfaces ⇒ the WHOLE scope (legacy).
function normalizeSlice(slice) {
  if (!slice) return null;
  const surfaces = Array.isArray(slice.include_surfaces) ? slice.include_surfaces.filter(Boolean) : [];
  // A platform_wide-only slice (no normal include_surfaces) must NOT collapse to null —
  // null means "whole scope" everywhere below, which would defeat the entire point of the
  // open-ended throttle by silently running every OTHER curated/generic pass unbounded.
  const hasPlatformWide = Array.isArray(slice.platform_wide_surfaces) && slice.platform_wide_surfaces.some(Boolean);
  if (!surfaces.length && !hasPlatformWide) return null;   // nothing selected at all ⇒ treat as whole-scope
  const capRaw = slice.per_surface_cap;
  const cap = (capRaw != null && Number.isFinite(Number(capRaw)) && Number(capRaw) > 0) ? Number(capRaw) : null;
  const filters = (slice.record_filters && typeof slice.record_filters === 'object') ? slice.record_filters : {};
  return { surfaces: new Set(surfaces), cap, filters };
}

/**
 * Expand a slice's surface allowlist to also include the CHILD tables of any included parent,
 * so selecting sc_cat_item also captures (and does NOT drift-flag) its item_option_new
 * variables. Returns a Set of table names, or null for a whole-scope (unbounded) ingest.
 */
function expandSliceSurfaces(slice) {
  const s = normalizeSlice(slice);
  if (!s) return null;
  const out = new Set(s.surfaces);
  for (const cs of CHILD_SURFACES) if (out.has(cs.parentTable)) out.add(cs.childTable);
  return out;
}

/**
 * Build the per-surface capture query: scope filter, an OPTIONAL record filter (dormant until
 * record_filters is populated — the surface-only slice leaves it empty), then the stable
 * ORDERBYsys_id key the offset pager relies on. Whole-scope when slice is null.
 */
function sliceQuery(scope, surface, slice) {
  const s = normalizeSlice(slice);
  let q = 'sys_scope.scope=' + scope;
  const extra = s && s.filters && s.filters[surface];
  if (extra) q += '^' + String(extra).replace(/^\^+/, '');
  return q + '^ORDERBYsys_id';
}

/** The sys_metadata completeness sweep, bounded to the slice's classes (whole-scope otherwise). */
function sliceMetadataQuery(scope, slice) {
  const allow = expandSliceSurfaces(slice);
  let q = 'sys_scope.scope=' + scope;
  if (allow && allow.size) q += '^sys_class_nameIN' + [...allow].join(',');
  return q + '^ORDERBYsys_id';
}

// Workbench tables that carry Level-2 provenance (where SN-sourced records live).
const WB_PROVENANCE_TABLES = [
  { table: 'asdlc_use_case',       pk: 'use_case_id',       type: 'use_case',       nameCol: 'title' },
  { table: 'asdlc_agent_spec',     pk: 'agent_spec_id',     type: 'agent_spec',     nameCol: 'name' },
  { table: 'asdlc_tool',           pk: 'tool_id',           type: 'tool',           nameCol: 'name' },
  { table: 'asdlc_workflow',       pk: 'workflow_id',       type: 'workflow',       nameCol: 'name' },
  { table: 'asdlc_workflow_step',  pk: 'workflow_step_id',  type: 'workflow_step',  nameCol: 'name' },
  { table: 'asdlc_data_model',     pk: 'data_model_id',     type: 'data_model',     nameCol: 'name' },
  { table: 'asdlc_form_design',    pk: 'form_design_id',    type: 'form_design',    nameCol: 'name' },
  { table: 'asdlc_business_logic', pk: 'business_logic_id', type: 'business_logic', nameCol: 'name' },
  { table: 'asdlc_catalog_item',   pk: 'catalog_item_id',   type: 'catalog_item',   nameCol: 'name' },
  { table: 'asdlc_integration',    pk: 'integration_id',    type: 'integration',     nameCol: 'name' },
  // Generic substrate — MUST stay LAST. For Tier-A surfaces a captured sys_id matches its
  // rich Level-1 projection first (preserving the existing reconcile path); only the long
  // tail (Tier B/C, no L1 twin) resolves here. This single entry makes findWbBySysId /
  // findWbBySlug / classifyArtifacts / drift detection cover generic artifacts for free.
  // (Phase 2: once L1 rows are back-linked to artifact twins, de-dup the double drift entry.)
  { table: 'asdlc_sn_artifact',    pk: 'sn_artifact_id',    type: 'sn_artifact',    nameCol: 'name' },
];

/** Stable 32-char content hash of an artifact's salient fields. */
function hashArtifact(salient) {
  return crypto.createHash('sha256').update(JSON.stringify(salient || {})).digest('hex').slice(0, 32);
}

/**
 * Live read-only capture of every design surface in a ServiceNow scope.
 * @returns {Promise<Array>} artifacts [{source_table, design_type, source_sys_id, name, salient, hash}] (+ {__error} entries)
 */
async function captureScope({ scope, instance, user, pw, fetchImpl, slice }) {
  const f = makeFetch(fetchImpl);
  const auth = 'Basic ' + Buffer.from(`${user}:${pw}`).toString('base64');
  const base = normalizeInstanceUrl(instance);
  const headers = { Authorization: auth, Accept: 'application/json' };
  const artifacts = [];
  // Slice bounding (surface allowlist + optional per-surface cap). null ⇒ whole scope.
  const allow = expandSliceSurfaces(slice);   // Set of tables, or null
  const sliceCap = (normalizeSlice(slice) || {}).cap || null;
  for (const s of SN_SURFACES) {
    if (allow && !allow.has(s.table)) continue;   // outside the selected slice
    const fields = ['sys_id', ...s.fields].join(',');
    const baseUrl = `${base}/api/now/table/${s.table}?sysparm_query=${encodeURIComponent(sliceQuery(scope, s.table, slice))}&sysparm_fields=${encodeURIComponent(fields)}&sysparm_display_value=true&sysparm_exclude_reference_link=true`;
    let rows = [];
    try {
      const out = await fetchAllRows(f, baseUrl, headers, sliceCap);
      rows = out.rows;
      if (out.capped) artifacts.push({ __warn: `${s.table} -> capped at ${maxRows()} rows; import is PARTIAL for this surface (raise SN_CAPTURE_MAX_ROWS)` });
    } catch (e) { artifacts.push({ __error: `${s.table} -> ${e.message}` }); continue; }
    for (const row of rows) {
      const salient = {};
      for (const fld of s.fields) salient[fld] = row[fld];
      artifacts.push({
        source_table: s.table, design_type: s.type, source_sys_id: row.sys_id,
        name: row[s.fields[0]] || row.name || '(unnamed)', salient, hash: hashArtifact(salient),
      });
    }
  }

  // ── Tier-B/C GENERIC capture (Phase 2): the long tail dropped today ──────────
  // Pull the full RAW field payload (no display_value → deployable values, e.g. real
  // reference sys_ids) for every registry-known surface without a rich Tier-A mapping.
  // Each becomes a generic artifact (design_type = sn_metadata_type, generic:true);
  // nothing is dropped. Errors per table are tolerated (skipped), exactly like above.
  for (const s of genericSurfaces()) {
    if (allow && !allow.has(s.table)) continue;   // outside the selected slice
    const baseUrl = `${base}/api/now/table/${s.table}?sysparm_query=${encodeURIComponent(sliceQuery(scope, s.table, slice))}&sysparm_exclude_reference_link=true`;
    let rows = [];
    try {
      const out = await fetchAllRows(f, baseUrl, headers, sliceCap);
      rows = out.rows;
      if (out.capped) artifacts.push({ __warn: `${s.table} -> capped at ${maxRows()} rows; import is PARTIAL for this surface (raise SN_CAPTURE_MAX_ROWS)` });
    } catch (e) { artifacts.push({ __error: `${s.table} -> ${e.message}` }); continue; }
    for (const row of rows) {
      const payload = {};
      for (const [k, v] of Object.entries(row)) {
        if (PAYLOAD_NOISE.has(k)) continue;
        if (v === '' || v == null) continue;
        payload[k] = v;
      }
      artifacts.push({
        source_table: s.table, design_type: s.sn_metadata_type, sn_metadata_type: s.sn_metadata_type,
        tier: s.tier, generic: true, source_sys_id: row.sys_id,
        name: row.name || row.short_description || row.label || payload.name || '(unnamed)',
        salient: payload, payload, hash: hashArtifact(payload),
      });
    }
  }

  // ── Extra SLICE surfaces (discovery planner, decision #2) ────────────────────
  // A slice only FILTERS the three static iteration sources above — it never adds a name.
  // A planner (or a human) may name a table that is present in the scope but NOT in
  // SN_SURFACES / genericSurfaces() / CHILD_SURFACES (typically a custom business-data
  // table). This is the one place a slice-named table gets fetched anyway: same generic
  // Table API pull, stored as a generic (Tier-C) artifact via the existing substrate — no
  // new materializer. Guarded entirely on `allow`, so a whole-scope (unsliced) capture is
  // byte-for-byte unchanged.
  if (allow) {
    const alreadyIterated = new Set([
      ...SN_SURFACES.map(s => s.table),
      ...genericSurfaces().map(s => s.table),
      ...CHILD_SURFACES.map(cs => cs.childTable),
    ]);
    const extraSurfaces = [...allow].filter(t => !alreadyIterated.has(t));
    for (const table of extraSurfaces) {
      const baseUrl = `${base}/api/now/table/${table}?sysparm_query=${encodeURIComponent(sliceQuery(scope, table, slice))}&sysparm_exclude_reference_link=true`;
      let rows = [];
      try {
        const out = await fetchAllRows(f, baseUrl, headers, sliceCap);
        rows = out.rows;
        if (out.capped) artifacts.push({ __warn: `${table} -> capped at ${maxRows()} rows; import is PARTIAL for this surface (raise SN_CAPTURE_MAX_ROWS)` });
      } catch (e) { artifacts.push({ __error: `${table} -> ${e.message}` }); continue; }
      const entry = reg.resolveType(table);
      for (const row of rows) {
        const payload = {};
        for (const [k, v] of Object.entries(row)) {
          if (PAYLOAD_NOISE.has(k)) continue;
          if (v === '' || v == null) continue;
          payload[k] = v;
        }
        artifacts.push({
          source_table: table, design_type: entry.sn_metadata_type, sn_metadata_type: entry.sn_metadata_type,
          tier: entry.tier || 'C', generic: true, source_sys_id: row.sys_id,
          name: row.name || row.short_description || row.label || payload.name || '(unnamed)',
          salient: payload, payload, hash: hashArtifact(payload),
        });
      }
    }
  }

  // ── Recursive CHILD capture: columns under tables, actions under flows ───────
  // Link each child to its captured parent (by table name or flow sys_id) so it
  // materializes under parent_artifact_id and round-trips with its own sys_id.
  const parentsByTable = {};
  for (const art of artifacts) {
    if (art.__error || !art.source_sys_id) continue;
    (parentsByTable[art.source_table] = parentsByTable[art.source_table] || [])
      .push({ sysId: art.source_sys_id, name: (art.salient && art.salient.name) || art.name });
  }
  for (const cs of CHILD_SURFACES) {
    if (allow && !allow.has(cs.childTable)) continue;   // child not in the slice (its parent wasn't selected)
    // Chained (2nd-level) surface: derive the parent list from an earlier CHILD_SURFACES pass's
    // OWN captured rows — queryKey is the field value the query filters on, sysId is that row's
    // own identity (so children still attach under the row that named them, e.g. the section join
    // row), NOT the referenced record's sys_id.
    const parents = cs.parentKeyField
      ? artifacts.filter(a => !a.__error && a.source_table === cs.parentTable && a.source_sys_id && a.payload && a.payload[cs.parentKeyField])
          .map(a => ({ sysId: a.source_sys_id, queryKey: a.payload[cs.parentKeyField] }))
      : (parentsByTable[cs.parentTable] || []);
    const beforeThisEntry = artifacts.length;
    for (const parent of parents) {
      if (cs.parentKey === 'name' && !parent.name) continue;
      const fieldsParam = cs.fields ? `&sysparm_fields=${encodeURIComponent(cs.fields)}` : '';
      const baseUrl = `${base}/api/now/table/${cs.childTable}?sysparm_query=${encodeURIComponent(cs.filter(parent) + '^ORDERBYsys_id')}${fieldsParam}&sysparm_exclude_reference_link=true`;
      let rows = [];
      try {
        const out = await fetchAllRows(f, baseUrl, headers, sliceCap);
        rows = out.rows;
        if (out.capped) artifacts.push({ __warn: `${cs.childTable} (parent ${parent.name || parent.sysId}) -> capped at ${maxRows()} rows; import is PARTIAL (raise SN_CAPTURE_MAX_ROWS)` });
      } catch (e) { artifacts.push({ __error: `${cs.childTable} -> ${e.message}` }); continue; }
      for (const row of rows) {
        const payload = {};
        for (const [k, v] of Object.entries(row)) {
          if (PAYLOAD_NOISE.has(k)) continue;
          if (v === '' || v == null) continue;
          payload[k] = v;
        }
        const ord = cs.orderField ? Number(row[cs.orderField]) : NaN;
        artifacts.push({
          source_table: cs.childTable, design_type: cs.role, sn_metadata_type: cs.role, tier: 'C',
          generic: true, source_sys_id: row.sys_id, parent_source_sys_id: parent.sysId,
          child_role: cs.role, child_order: Number.isFinite(ord) ? ord : null,
          name: row[cs.nameField] || payload.name || '(unnamed)',
          salient: payload, payload, hash: hashArtifact(payload),
        });
      }
    }
    // Staleness fix: make THIS entry's own freshly-captured rows visible as PARENTS to a
    // LATER CHILD_SURFACES entry naming cs.childTable as ITS parentTable (a 3rd-level chain,
    // e.g. sc_task under sc_req_item) — parentsByTable above is a once-built snapshot that
    // never otherwise sees rows this very loop adds.
    for (let i = beforeThisEntry; i < artifacts.length; i++) {
      const art = artifacts[i];
      if (art.__error || !art.source_sys_id) continue;
      (parentsByTable[art.source_table] = parentsByTable[art.source_table] || [])
        .push({ sysId: art.source_sys_id, name: (art.salient && art.salient.name) || art.name });
    }
  }

  // ── Bounded reference-resolution: resolve SPECIFIC referenced records only ──────────
  // Runs after CHILD_SURFACES so a chained source like sc_task has already been captured.
  // Resolved rows are plain top-level generic artifacts (no parent_source_sys_id) — they
  // are REFERENCED, not owned/child-of anything in this capture.
  for (const rr of REFERENCE_RESOLUTIONS) {
    if (allow && !allow.has(rr.sourceTable)) continue;   // source table itself out of the slice
    const ids = new Set();
    for (const art of artifacts) {
      if (art.__error || art.source_table !== rr.sourceTable) continue;
      const v = art.payload && art.payload[rr.field];
      if (v && typeof v === 'string') ids.add(v);
    }
    if (!ids.size) continue;
    const cap = refResolveMaxIds();
    const idList = [...ids].slice(0, cap);
    if (ids.size > cap) artifacts.push({ __warn: `${rr.targetTable} reference resolution -> capped at ${cap} distinct ${rr.sourceTable}.${rr.field} value(s) (raise SN_REF_RESOLVE_MAX_IDS)` });
    const baseUrl = `${base}/api/now/table/${rr.targetTable}?sysparm_query=${encodeURIComponent('sys_idIN' + idList.join(','))}&sysparm_exclude_reference_link=true`;
    let rows = [];
    try {
      const out = await fetchAllRows(f, baseUrl, headers, null);
      rows = out.rows;
    } catch (e) { artifacts.push({ __error: `${rr.targetTable} (referenced by ${rr.sourceTable}.${rr.field}) -> ${e.message}` }); continue; }
    for (const row of rows) {
      const payload = {};
      for (const [k, v] of Object.entries(row)) {
        if (PAYLOAD_NOISE.has(k)) continue;
        if (v === '' || v == null) continue;
        payload[k] = v;
      }
      artifacts.push({
        source_table: rr.targetTable, design_type: rr.role, sn_metadata_type: rr.role, tier: 'C',
        generic: true, resolved_reference: true, source_sys_id: row.sys_id,
        name: row.name || payload.name || '(unnamed)',
        salient: payload, payload, hash: hashArtifact(payload),
      });
    }
  }

  // ── Open-ended platform-wide capture: its own dedicated pass, not folded into the ────
  // extra-slice-surface pass above (which always applies the scope filter) — avoids any
  // collision with a §2a CHILD_SURFACES entry of the same table name, and keeps the
  // "no scope filter" behavior isolated to exactly this opt-in path.
  for (const table of openEndedTables(slice)) {
    if (!REAL_TABLE.test(table)) { artifacts.push({ __warn: `${table} -> skipped (not a valid ServiceNow table name)` }); continue; }
    const cap = openEndedRowCap();
    const baseUrl = `${base}/api/now/table/${table}?sysparm_query=${encodeURIComponent('ORDERBYDESCsys_updated_on')}&sysparm_exclude_reference_link=true`;
    let rows = [];
    try {
      const out = await fetchAllRows(f, baseUrl, headers, cap);
      rows = out.rows;
    } catch (e) { artifacts.push({ __error: `${table} (platform-wide) -> ${e.message}` }); continue; }
    for (const row of rows) {
      const payload = {};
      for (const [k, v] of Object.entries(row)) {
        if (PAYLOAD_NOISE.has(k)) continue;
        if (v === '' || v == null) continue;
        payload[k] = v;
      }
      artifacts.push({
        source_table: table, design_type: 'platform_wide', sn_metadata_type: 'platform_wide', tier: 'C',
        generic: true, platform_wide: true, source_sys_id: row.sys_id,
        name: row.name || row.short_description || row.label || payload.name || '(unnamed)',
        salient: payload, payload, hash: hashArtifact(payload),
      });
    }
  }

  // Attach captured children to their parent artifact as a NON-salient `_children` list
  // (added AFTER hashing, so identity/change-detection are untouched). The deterministic
  // direct-map reads this to fold a table's columns / a catalog item's variables into the
  // parent's Level-1 record instead of leaving those columns blank/AI-guessed.
  const childrenByParent = {};
  for (const art of artifacts) {
    if (art.__error || !art.parent_source_sys_id) continue;
    (childrenByParent[art.parent_source_sys_id] = childrenByParent[art.parent_source_sys_id] || []).push(art);
  }
  for (const art of artifacts) {
    if (art.__error || !art.source_sys_id) continue;
    const kids = childrenByParent[art.source_sys_id];
    if (kids && kids.length) art._children = kids;
  }
  return artifacts;
}

// ── #86 part (a): sys_metadata completeness backbone (read-only, no schema change) ──────
// ServiceNow keeps ONE registry — sys_metadata — of every application-file record in a
// scope (all business rules, ACLs, ATF steps, flow-action wiring, UI sections, docs, …).
// The curated `SN_SURFACES`/`genericSurfaces` capture reads ~24 hand-listed tables; a live
// probe of the MIM pilot found 705 records across ~40 classes, so the capture is blind to
// whole categories. A single scope-filtered sweep of sys_metadata is the authority for:
//   (1) blind-spot classes the curated surfaces never read (completeness gap, per-class);
//   (2) disambiguating WB-side drift — a Workbench record whose sys_id is absent from the
//       capture is either truly deleted upstream (also absent from the sweep) or merely under
//       a class we don't monitor (present in the sweep). Only the sweep can tell them apart.
// Storing per-record change signals (sys_mod_count/sys_updated_on) to skip payload downloads
// is #86 part (b) — it needs new provenance columns and is intentionally NOT done here.
const SWEEP_FIELDS = [
  'sys_id', 'sys_class_name', 'sys_name', 'sys_update_name',
  'sys_updated_on', 'sys_updated_by', 'sys_mod_count',
];

/**
 * One read-only sweep of `sys_metadata` for a scope — the authoritative inventory of every
 * application file. BEST-EFFORT: any failure (e.g. the sync user lacks read on sys_metadata)
 * degrades to `{available:false, error}` and NEVER breaks the sync. Paged via fetchAllRows.
 * @returns {Promise<{available:boolean, capped:boolean, total:number, bySysId:Map, byClass:object, error?:string}>}
 */
/** Build a sweep object ({available, bySysId:Map, byClass, total}) from raw sys_metadata rows. */
function buildSweep(rows) {
  const bySysId = new Map();
  const byClass = {};
  for (const r of (rows || [])) {
    if (!r || !r.sys_id) continue;
    bySysId.set(r.sys_id, r);
    const c = r.sys_class_name || '(unknown)';
    byClass[c] = (byClass[c] || 0) + 1;
  }
  return { available: true, capped: false, total: bySysId.size, bySysId, byClass };
}

/**
 * Normalize an injected sweep into a sweep object with a real Map. Accepts a ready sweep
 * (Map preserved), a raw rows array, or {rows:[...]} — the last two are how a sweep survives
 * JSON (a Map does not), so tests/dry-runs can inject one over HTTP. null passes through.
 */
function normalizeSweep(s) {
  if (!s) return null;
  if (s.bySysId instanceof Map) return s;
  if (Array.isArray(s)) return buildSweep(s);
  if (Array.isArray(s.rows)) return buildSweep(s.rows);
  return s;
}

async function sweepScopeMetadata({ scope, instance, user, pw, fetchImpl, slice }) {
  try {
    const f = makeFetch(fetchImpl);
    const auth = 'Basic ' + Buffer.from(`${user}:${pw}`).toString('base64');
    const base = normalizeInstanceUrl(instance);
    const headers = { Authorization: auth, Accept: 'application/json' };
    // Bound the completeness sweep to the SAME slice as the capture, so a slice ingest
    // measures completeness against the slice — not the entire (possibly huge) scope.
    const q = sliceMetadataQuery(scope, slice);
    const baseUrl = `${base}/api/now/table/sys_metadata?sysparm_query=${encodeURIComponent(q)}&sysparm_fields=${encodeURIComponent(SWEEP_FIELDS.join(','))}&sysparm_exclude_reference_link=true`;
    const { rows, capped } = await fetchAllRows(f, baseUrl, headers);
    const sweep = buildSweep(rows);
    sweep.capped = capped;
    return sweep;
  } catch (e) {
    return { available: false, error: e.message, capped: false, total: 0, bySysId: new Map(), byClass: {} };
  }
}

// Bound how many candidate tables a single readReferenceGraph call will query the
// dictionary for — a runaway/OOM + read-latency ceiling, not a design limit.
const REF_GRAPH_TABLE_CAP = Math.max(1, parseInt(process.env.SN_REF_GRAPH_TABLE_CAP || '150', 10) || 150);

/**
 * Read-only reference-relationship graph (discovery planner, decision #4): for the given
 * candidate tables, read `sys_dictionary` rows where a field is a table reference, to learn
 * which OTHER tables each one points at. This is what grounds "related record types" in
 * THIS instance's real schema rather than generic ServiceNow structural knowledge alone.
 * Bounded by a table cap; BEST-EFFORT — any failure (unreadable dictionary, bad creds)
 * degrades to an empty, unavailable graph and never breaks planning.
 * @param {{scope,instance,user,pw,fetchImpl,tables:string[],cap?:number}} opts
 * @returns {Promise<{edges:Array<{from_table,field,to_table,label}>, available:boolean, error?:string}>}
 */
async function readReferenceGraph({ instance, user, pw, fetchImpl, tables, cap } = {}) {
  const wantCap = (cap != null && Number.isFinite(Number(cap)) && Number(cap) > 0) ? Number(cap) : REF_GRAPH_TABLE_CAP;
  const list = Array.from(new Set((tables || []).filter(Boolean))).slice(0, wantCap);
  if (!list.length) return { edges: [], available: true };
  try {
    const f = makeFetch(fetchImpl);
    const auth = 'Basic ' + Buffer.from(`${user}:${pw}`).toString('base64');
    const base = normalizeInstanceUrl(instance);
    const headers = { Authorization: auth, Accept: 'application/json' };
    const q = `nameIN${list.join(',')}^internal_type=reference^referenceISNOTEMPTY^ORDERBYsys_id`;
    const fields = 'name,element,reference,column_label';
    const baseUrl = `${base}/api/now/table/sys_dictionary?sysparm_query=${encodeURIComponent(q)}&sysparm_fields=${encodeURIComponent(fields)}&sysparm_display_value=false&sysparm_exclude_reference_link=true`;
    const { rows } = await fetchAllRows(f, baseUrl, headers, null);
    const edges = [];
    for (const r of rows) {
      if (!r.name || !r.element || !r.reference) continue;
      edges.push({ from_table: r.name, field: r.element, to_table: r.reference, label: r.column_label || r.element });
    }
    return { edges, available: true };
  } catch (e) {
    return { edges: [], available: false, error: e.message };
  }
}

/**
 * PURE completeness analysis: the sys_metadata sweep vs what the curated capture returned
 * and what the Workbench already tracks. No I/O, no mutation of the sweep. Annotates each
 * `classified.drift` item with `exists_in_sn` (informational only — does NOT change gating;
 * drift is already never auto-deleted). `sampleCap` bounds the per-report row samples.
 */
function analyzeCompleteness(sweep, classified, opts = {}) {
  if (!sweep || !sweep.available) {
    return { available: false, reason: (sweep && sweep.error) || 'sys_metadata sweep unavailable' };
  }
  const sampleCap = opts.sampleCap || 50;
  // sys_ids the curated capture actually returned (rich + generic + children all carry one).
  const captured = new Set();
  for (const a of [...classified.unchanged, ...classified.changed, ...classified.new]) {
    if (a.source_sys_id) captured.add(a.source_sys_id);
  }
  // Blind spots: records the scope registry lists that the capture never returned.
  const uncapturedByClass = {};
  const uncaptured_sample = [];
  for (const [sysId, row] of sweep.bySysId) {
    if (captured.has(sysId)) continue;
    const cls = row.sys_class_name || '(unknown)';
    uncapturedByClass[cls] = (uncapturedByClass[cls] || 0) + 1;
    if (uncaptured_sample.length < sampleCap) {
      uncaptured_sample.push({
        sys_id: sysId, sys_class_name: cls, name: row.sys_name || null,
        updated_on: row.sys_updated_on || null, updated_by: row.sys_updated_by || null,
      });
    }
  }
  const uncaptured_count = Object.values(uncapturedByClass).reduce((a, b) => a + b, 0);
  // Disambiguate WB-side drift with the authoritative sweep.
  const vanished = [], present_uncaptured = [];
  for (const d of classified.drift) {
    const hit = sweep.bySysId.get(d.source_sys_id);
    d.exists_in_sn = !!hit;   // informational annotation; gating unchanged
    const rec = {
      source_sys_id: d.source_sys_id, name: d.name, wb_table: d.wb_table, wb_type: d.wb_type,
      sys_class_name: hit ? (hit.sys_class_name || null) : null,
    };
    (hit ? present_uncaptured : vanished).push(rec);
  }
  // Class coverage — resolve each captured sys_id's class via the authoritative sweep.
  const capturedClasses = new Set();
  for (const sysId of captured) {
    const row = sweep.bySysId.get(sysId);
    if (row && row.sys_class_name) capturedClasses.add(row.sys_class_name);
  }
  const classes_in_scope = Object.entries(sweep.byClass)
    .map(([sys_class_name, count]) => ({ sys_class_name, count, captured: capturedClasses.has(sys_class_name) }))
    .sort((a, b) => b.count - a.count);
  const uncaptured_by_class = Object.entries(uncapturedByClass)
    .map(([sys_class_name, count]) => ({ sys_class_name, count }))
    .sort((a, b) => b.count - a.count);
  return {
    available: true,
    capped: !!sweep.capped,
    total_in_scope: sweep.total,
    class_count: classes_in_scope.length,
    captured_class_count: capturedClasses.size,
    classes_in_scope,
    uncaptured_count,
    uncaptured_by_class,
    uncaptured_sample,
    vanished,
    present_uncaptured,
  };
}

// ── #86 part (b): per-record change signals (needs the asdlc_sn_change_signal table) ────
// Read the last-synced sys_metadata signals for a project as a Map(sys_id → row). Tolerates
// the table being absent (pre-migration DB) → empty Map, so classify degrades to part-(a)
// behavior rather than throwing.
function readChangeSignals(projectId) {
  const m = new Map();
  if (!projectId) return m;
  try {
    const rows = db.prepare(
      'SELECT source_sys_id, sys_class_name, sys_mod_count, sys_updated_on, sys_updated_by FROM asdlc_sn_change_signal WHERE project_id = ?'
    ).all(projectId);
    for (const r of rows) m.set(r.source_sys_id, r);
  } catch { /* table absent — no stored signals */ }
  return m;
}

/**
 * Upsert the change signals for every swept record (called on a successful non-dry-run sync,
 * NEVER on dry-run). `signals` is a plain array of {source_sys_id, sys_class_name,
 * sys_mod_count, sys_updated_on, sys_updated_by}. Returns rows written. Best-effort — a
 * failure is logged, not thrown (signals are an optimization, not correctness-critical).
 */
function persistChangeSignals(projectId, signals) {
  if (!projectId || !Array.isArray(signals) || !signals.length) return 0;
  const up = db.prepare(`
    INSERT INTO asdlc_sn_change_signal
      (project_id, source_sys_id, sys_class_name, sys_mod_count, sys_updated_on, sys_updated_by, first_seen_at, last_seen_at)
    VALUES (?,?,?,?,?,?,datetime('now'),datetime('now'))
    ON CONFLICT(project_id, source_sys_id) DO UPDATE SET
      sys_class_name = excluded.sys_class_name,
      sys_mod_count  = excluded.sys_mod_count,
      sys_updated_on = excluded.sys_updated_on,
      sys_updated_by = excluded.sys_updated_by,
      last_seen_at   = datetime('now')`);
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const s of signals) {
      if (!s || !s.source_sys_id) continue;
      const modRaw = s.sys_mod_count;
      const mod = (modRaw === null || modRaw === undefined || modRaw === '') ? null : parseInt(modRaw, 10);
      up.run(projectId, s.source_sys_id, s.sys_class_name || null,
        Number.isFinite(mod) ? mod : null, s.sys_updated_on || null, s.sys_updated_by || null);
      n++;
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    console.error('[sn-capture] persistChangeSignals', e.message);
    return 0;
  }
  return n;
}

/** Flatten a metadata sweep into the compact signal-row array persistChangeSignals expects. */
function sweepSignals(sweep) {
  if (!sweep || !sweep.available || !sweep.bySysId) return [];
  const out = [];
  for (const [sysId, r] of sweep.bySysId) {
    out.push({
      source_sys_id: sysId, sys_class_name: r.sys_class_name || null,
      sys_mod_count: r.sys_mod_count, sys_updated_on: r.sys_updated_on || null,
      sys_updated_by: r.sys_updated_by || null,
    });
  }
  return out;
}

/** Find the Workbench record for a ServiceNow sys_id within a project (across provenance tables). */
function findWbBySysId(projectId, sysId) {
  for (const t of WB_PROVENANCE_TABLES) {
    let row;
    try {
      row = db.prepare(
        `SELECT ${t.pk} AS id, ${t.nameCol} AS name, source_hash, source_fluent, source_sys_id, updated_at AS wb_updated_at
         FROM ${t.table} WHERE source_sys_id = ? AND project_id = ?
           AND (lifecycle_status IS NULL OR lifecycle_status != 'retired') LIMIT 1`
      ).get(sysId, projectId);
    } catch { continue; }   // table without provenance/columns — skip
    if (row) return { ...row, table: t.table, type: t.type };
  }
  return null;
}

/**
 * Parse a Workbench identity tag embedded in a captured artifact's description. This is the durable
 * round-trip key written into ServiceNow at deploy time — it survives renames (the CMTest- prefix /
 * snake_case touch `name`, not the tagged description).
 *
 * Two forms are accepted:
 *   - Qualified (globally unique across instances/scopes): "[[wb:<project_id>/AG-001]]"
 *   - Bare (project-local, legacy): "[[wb:AG-001]]"
 * Slugs are only unique PER PROJECT, so the qualified form is required to be unambiguous when one
 * ServiceNow instance hosts apps from more than one Workbench project. Returns
 * { projectId|null, slug } or null.
 */
function parseWbTag(salient) {
  const text = (salient && salient.description) || '';
  // Qualified first: project id (anything up to the '/') then the slug.
  let m = /\[\[wb:([^/\]]+)\/([A-Z]+-\d+)\]\]/.exec(text);
  if (m) return { projectId: m[1], slug: m[2] };
  // Bare fallback: slug only.
  m = /\[\[wb:([A-Z]+-\d+)\]\]/.exec(text);
  if (m) return { projectId: null, slug: m[1] };
  return null;
}

/** Find the Workbench record for a per-project slug (round-trip self-heal fallback). */
function findWbBySlug(projectId, slug) {
  if (!slug) return null;
  for (const t of WB_PROVENANCE_TABLES) {
    let row;
    try {
      row = db.prepare(
        `SELECT ${t.pk} AS id, ${t.nameCol} AS name, source_hash, source_fluent, source_sys_id, slug, updated_at AS wb_updated_at
         FROM ${t.table} WHERE slug = ? AND project_id = ?
           AND (lifecycle_status IS NULL OR lifecycle_status != 'retired') LIMIT 1`
      ).get(slug, projectId);
    } catch { continue; }   // table without slug/provenance columns — skip
    if (row) return { ...row, table: t.table, type: t.type };
  }
  return null;
}

/**
 * Deterministic pre-diff (no LLM). Classify captured SN artifacts against the linked
 * Workbench project. Only `changed` + `new` (+ later `ambiguous`) need Opus; `unchanged`
 * skip the LLM; `drift` (in Workbench, absent from SN) is flagged and NEVER deleted.
 */
function classifyArtifacts(artifacts, projectId, opts = {}) {
  const res = { unchanged: [], changed: [], new: [], drift: [], errors: [], warnings: [] };
  const seen = new Set();
  // Slice bounding (#A3): under a bounded ingest, only Workbench rows whose source_table is
  // IN the slice are drift candidates — otherwise every out-of-slice row would falsely read as
  // "deleted upstream". null ⇒ whole-scope (all provenance rows are candidates, legacy).
  const sliceSurfaces = (opts.sliceSurfaces instanceof Set && opts.sliceSurfaces.size) ? opts.sliceSurfaces : null;
  // Both-side-edit detection (#84): the one deterministic fact the reconciler can't infer.
  // A Workbench row whose updated_at is AFTER the project's last sync was touched by a
  // human (sync writes always land BEFORE markSynced() advances sn_last_synced_at), so a
  // simultaneous ServiceNow change means BOTH sides diverged from the last-synced state.
  let lastSync = null;
  try {
    const p = db.prepare('SELECT sn_last_synced_at FROM asdlc_project WHERE project_id = ?').get(projectId);
    lastSync = (p && p.sn_last_synced_at) || null;
  } catch { /* project row unavailable — treat as never-synced */ }
  // #86 part (b): the live sweep gives each record's CURRENT sys_mod_count / who / when;
  // stored signals give the value AS OF the last sync. When both exist and the counter is
  // UNMOVED, the ServiceNow record demonstrably was not written since we last saw it — so a
  // content-hash difference is our OWN salient-formula drift, not a real change. Flagging it
  // `sn_unmoved` lets the plan refresh the stored hash without spending Opus (prevents a
  // capture-logic change from mass-reclassifying the whole scope as "changed").
  const swBy = (opts.sweep && opts.sweep.available && opts.sweep.bySysId) ? opts.sweep.bySysId : null;
  const storedSig = readChangeSignals(projectId);
  const surface_counts = {};   // per-surface CAPTURED count (completeness signal)
  for (const a of artifacts) {
    if (a.__error) { res.errors.push(a.__error); continue; }
    if (a.__warn)  { res.warnings.push(a.__warn); continue; }
    if (a.source_table) surface_counts[a.source_table] = (surface_counts[a.source_table] || 0) + 1;
    seen.add(a.source_sys_id);
    // Match by sys_id first; if the row was deployed-from-Workbench but never had its sys_id
    // registered, fall back to the embedded identity tag so it reconciles instead of duplicating.
    let wb = findWbBySysId(projectId, a.source_sys_id);
    if (!wb) {
      const tag = parseWbTag(a.salient);
      // A qualified tag must name THIS project; a tag for another project belongs to a different
      // design and must NOT be folded in here. Slugs are only unique per project. A bare (legacy)
      // tag is matched within the syncing project on a best-effort basis.
      if (tag && (!tag.projectId || tag.projectId === projectId)) wb = findWbBySlug(projectId, tag.slug);
    }
    if (!wb) { res.new.push(a); continue; }
    if (wb.source_hash && wb.source_hash === a.hash) {
      res.unchanged.push({ ...a, wb_id: wb.id, wb_table: wb.table });
    } else {
      const cur = swBy ? swBy.get(a.source_sys_id) : null;
      const prevSig = storedSig.get(a.source_sys_id);
      const curMod  = (cur && cur.sys_mod_count != null && cur.sys_mod_count !== '') ? Number(cur.sys_mod_count) : null;
      const prevMod = (prevSig && prevSig.sys_mod_count != null) ? Number(prevSig.sys_mod_count) : null;
      const snUnmoved = (curMod !== null && prevMod !== null && curMod === prevMod);
      // R7: deterministic SN-SIDE field delta (base source_fluent vs current salient — both
      // ServiceNow-shaped, always sound). Names WHICH ServiceNow fields moved since the last
      // sync so the reconciler prompt / conflict story can be specific, and so a generic
      // artifact can be merged field-by-field downstream. Context only — no gating change here.
      const delta = snFieldDelta(wb.source_fluent, a.salient);
      res.changed.push({
        ...a, wb_id: wb.id, wb_table: wb.table, prev_hash: wb.source_hash || null,
        base_snapshot: wb.source_fluent || null,
        wb_updated_at: wb.wb_updated_at || null,
        sn_last_synced_at: lastSync,
        wb_edited_since_sync: !!(lastSync && wb.wb_updated_at && wb.wb_updated_at > lastSync),
        sn_mod_count: curMod,
        sn_prev_mod_count: prevMod,
        sn_updated_on: cur ? (cur.sys_updated_on || null) : null,
        sn_updated_by: cur ? (cur.sys_updated_by || null) : null,
        sn_unmoved: snUnmoved,
        sn_changed_fields: delta.available ? delta.changed : null,
      });
    }
  }
  // Drift: Workbench records carrying a source_sys_id that this capture did NOT return.
  // NEVER a delete — a lossy/partial SN view must not erase Workbench design. Flag only.
  // A sys_id may live in BOTH an L1 table and its generic asdlc_sn_artifact twin; report
  // each drifted sys_id ONCE, preferring the business/L1 table (asdlc_sn_artifact is last
  // in WB_PROVENANCE_TABLES, so the rich row wins).
  const driftSeen = new Set();
  for (const t of WB_PROVENANCE_TABLES) {
    let rows = [];
    try {
      rows = db.prepare(
        `SELECT ${t.pk} AS id, ${t.nameCol} AS name, source_sys_id, source_table FROM ${t.table}
         WHERE project_id = ? AND source_sys_id IS NOT NULL
           AND (lifecycle_status IS NULL OR lifecycle_status != 'retired')`
      ).all(projectId);
    } catch { continue; }
    for (const r of rows) if (!seen.has(r.source_sys_id) && !driftSeen.has(r.source_sys_id)) {
      // Under a slice, a row is only a drift candidate if its surface was actually captured.
      // A row with no source_table is skipped when slicing (we can't confirm it's in-scope).
      if (sliceSurfaces && (!r.source_table || !sliceSurfaces.has(r.source_table))) continue;
      driftSeen.add(r.source_sys_id);
      res.drift.push({ wb_table: t.table, wb_type: t.type, wb_id: r.id, name: r.name, source_sys_id: r.source_sys_id });
    }
  }
  res.surface_counts = surface_counts;
  res.summary = {
    unchanged: res.unchanged.length, changed: res.changed.length,
    new: res.new.length, drift: res.drift.length, errors: res.errors.length,
    warnings: res.warnings.length,
    both_side_edits: res.changed.filter(c => c.wb_edited_since_sync).length,
    sn_unmoved: res.changed.filter(c => c.sn_unmoved).length,
  };
  return res;
}

module.exports = { SN_SURFACES, WB_PROVENANCE_TABLES, CHILD_SURFACES, REFERENCE_RESOLUTIONS, hashArtifact, captureScope, fetchAllRows, findWbBySysId, findWbBySlug, parseWbTag, classifyArtifacts, makeFetch, sweepScopeMetadata, buildSweep, normalizeSweep, analyzeCompleteness, readChangeSignals, persistChangeSignals, sweepSignals, normalizeSlice, expandSliceSurfaces, sliceQuery, sliceMetadataQuery, readReferenceGraph, genericSurfaces, openEndedTables, REAL_TABLE };
