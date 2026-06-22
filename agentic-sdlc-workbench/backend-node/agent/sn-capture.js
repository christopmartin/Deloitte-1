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
  const f = fetchImpl || fetch;
  const auth = 'Basic ' + Buffer.from(`${user}:${pw}`).toString('base64');
  const base = normalizeInstanceUrl(instance);
  const artifacts = [];
  for (const s of SN_SURFACES) {
    const fields = ['sys_id', ...s.fields].join(',');
    const u = `${base}/api/now/table/${s.table}?sysparm_query=${encodeURIComponent('sys_scope.scope=' + scope)}&sysparm_fields=${encodeURIComponent(fields)}&sysparm_display_value=true&sysparm_exclude_reference_link=true&sysparm_limit=1000`;
    let rows = [];
    try {
      const r = await f(u, { headers: { Authorization: auth, Accept: 'application/json' } });
      if (!r.ok) { artifacts.push({ __error: `${s.table} -> HTTP ${r.status}` }); continue; }
      rows = (await r.json()).result || [];
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
  return artifacts;
}

/** Find the Workbench record for a ServiceNow sys_id within a project (across provenance tables). */
function findWbBySysId(projectId, sysId) {
  for (const t of WB_PROVENANCE_TABLES) {
    let row;
    try {
      row = db.prepare(
        `SELECT ${t.pk} AS id, ${t.nameCol} AS name, source_hash, source_sys_id
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
        `SELECT ${t.pk} AS id, ${t.nameCol} AS name, source_hash, source_sys_id, slug
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
  const res = { unchanged: [], changed: [], new: [], drift: [], errors: [] };
  const seen = new Set();
  for (const a of artifacts) {
    if (a.__error) { res.errors.push(a.__error); continue; }
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
      res.changed.push({ ...a, wb_id: wb.id, wb_table: wb.table, prev_hash: wb.source_hash || null });
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
  res.summary = {
    unchanged: res.unchanged.length, changed: res.changed.length,
    new: res.new.length, drift: res.drift.length, errors: res.errors.length,
  };
  return res;
}

module.exports = { SN_SURFACES, WB_PROVENANCE_TABLES, hashArtifact, captureScope, findWbBySysId, findWbBySlug, parseWbTag, classifyArtifacts };
