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

/**
 * Fetch ALL rows of a Table API query, paging by sysparm_offset until a short page
 * (or the safety ceiling) is reached. `baseUrl` must already carry the query
 * (sysparm_query/fields/etc.) but NOT sysparm_limit/sysparm_offset. A stable
 * `^ORDERBYsys_id` in the query is assumed by callers so offsets don't skip/dupe.
 * @returns {Promise<{rows:Array, capped:boolean}>}
 * @throws {Error} on HTTP !ok ("HTTP <status>") or transport failure — the caller
 *   turns it into the same per-surface __error entry it always produced.
 */
async function fetchAllRows(f, baseUrl, headers) {
  const limit = pageSize();
  const ceiling = maxRows();
  const rows = [];
  let offset = 0;
  for (;;) {
    const r = await f(`${baseUrl}&sysparm_limit=${limit}&sysparm_offset=${offset}`, { headers });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const page = ((await r.json()) || {}).result || [];
    rows.push(...page);
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
// COVERAGE NOTE (P2): the SDK capability registry models exactly two parent/child
// taxonomies — `table → columns` and `catalogitem → variables` (the 81 child rows in the
// baseline). Both instance-level relationships are captured here. Other surfaces (e.g.
// forms) are NOT modelled as parent/child by the SDK, so we do not speculatively scrape
// their sub-tables; add a row here only when the SDK gains a real child taxonomy for it.
const CHILD_SURFACES = [
  { childTable: 'sys_dictionary',           parentTable: 'sys_db_object', role: 'column',
    parentKey: 'name',  filter: p => `name=${p.name}^elementISNOTEMPTY`, nameField: 'element',       orderField: null },
  { childTable: 'sys_hub_action_instance',  parentTable: 'sys_hub_flow',  role: 'action',
    parentKey: 'sysId', filter: p => `flow=${p.sysId}`,                   nameField: 'display_text',  orderField: 'order' },
  // Catalog item variables (item_option_new.cat_item = catalog item sys_id). The deployable
  // parent ref (cat_item) stays in the payload; order drives child_order.
  { childTable: 'item_option_new',          parentTable: 'sc_cat_item',   role: 'variable',
    parentKey: 'sysId', filter: p => `cat_item=${p.sysId}`,               nameField: 'question_text', orderField: 'order' },
];

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
async function captureScope({ scope, instance, user, pw, fetchImpl }) {
  const f = makeFetch(fetchImpl);
  const auth = 'Basic ' + Buffer.from(`${user}:${pw}`).toString('base64');
  const base = normalizeInstanceUrl(instance);
  const headers = { Authorization: auth, Accept: 'application/json' };
  const artifacts = [];
  for (const s of SN_SURFACES) {
    const fields = ['sys_id', ...s.fields].join(',');
    const baseUrl = `${base}/api/now/table/${s.table}?sysparm_query=${encodeURIComponent('sys_scope.scope=' + scope + '^ORDERBYsys_id')}&sysparm_fields=${encodeURIComponent(fields)}&sysparm_display_value=true&sysparm_exclude_reference_link=true`;
    let rows = [];
    try {
      const out = await fetchAllRows(f, baseUrl, headers);
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
    const baseUrl = `${base}/api/now/table/${s.table}?sysparm_query=${encodeURIComponent('sys_scope.scope=' + scope + '^ORDERBYsys_id')}&sysparm_exclude_reference_link=true`;
    let rows = [];
    try {
      const out = await fetchAllRows(f, baseUrl, headers);
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
    for (const parent of (parentsByTable[cs.parentTable] || [])) {
      if (cs.parentKey === 'name' && !parent.name) continue;
      const baseUrl = `${base}/api/now/table/${cs.childTable}?sysparm_query=${encodeURIComponent(cs.filter(parent) + '^ORDERBYsys_id')}&sysparm_exclude_reference_link=true`;
      let rows = [];
      try {
        const out = await fetchAllRows(f, baseUrl, headers);
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
  }
  return artifacts;
}

/** Find the Workbench record for a ServiceNow sys_id within a project (across provenance tables). */
function findWbBySysId(projectId, sysId) {
  for (const t of WB_PROVENANCE_TABLES) {
    let row;
    try {
      row = db.prepare(
        `SELECT ${t.pk} AS id, ${t.nameCol} AS name, source_hash, source_sys_id, updated_at AS wb_updated_at
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
        `SELECT ${t.pk} AS id, ${t.nameCol} AS name, source_hash, source_sys_id, slug, updated_at AS wb_updated_at
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
function classifyArtifacts(artifacts, projectId) {
  const res = { unchanged: [], changed: [], new: [], drift: [], errors: [], warnings: [] };
  const seen = new Set();
  // Both-side-edit detection (#84): the one deterministic fact the reconciler can't infer.
  // A Workbench row whose updated_at is AFTER the project's last sync was touched by a
  // human (sync writes always land BEFORE markSynced() advances sn_last_synced_at), so a
  // simultaneous ServiceNow change means BOTH sides diverged from the last-synced state.
  let lastSync = null;
  try {
    const p = db.prepare('SELECT sn_last_synced_at FROM asdlc_project WHERE project_id = ?').get(projectId);
    lastSync = (p && p.sn_last_synced_at) || null;
  } catch { /* project row unavailable — treat as never-synced */ }
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
      res.changed.push({
        ...a, wb_id: wb.id, wb_table: wb.table, prev_hash: wb.source_hash || null,
        wb_updated_at: wb.wb_updated_at || null,
        sn_last_synced_at: lastSync,
        wb_edited_since_sync: !!(lastSync && wb.wb_updated_at && wb.wb_updated_at > lastSync),
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
        `SELECT ${t.pk} AS id, ${t.nameCol} AS name, source_sys_id FROM ${t.table}
         WHERE project_id = ? AND source_sys_id IS NOT NULL
           AND (lifecycle_status IS NULL OR lifecycle_status != 'retired')`
      ).all(projectId);
    } catch { continue; }
    for (const r of rows) if (!seen.has(r.source_sys_id) && !driftSeen.has(r.source_sys_id)) {
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
  };
  return res;
}

module.exports = { SN_SURFACES, WB_PROVENANCE_TABLES, hashArtifact, captureScope, fetchAllRows, findWbBySysId, findWbBySlug, parseWbTag, classifyArtifacts, makeFetch };
