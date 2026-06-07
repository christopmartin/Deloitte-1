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

// SN metadata tables we capture, with the salient fields used for hashing/identity.
// (Covers AI-agent apps + data-centric apps; missing tables on an instance are skipped.)
const SN_SURFACES = [
  { table: 'sn_aia_agent',       type: 'agent',          fields: ['name', 'role', 'description', 'instructions'] },
  { table: 'sn_aia_usecase',     type: 'use_case',       fields: ['name', 'description'] },
  { table: 'sn_aia_tool',        type: 'tool',           fields: ['name', 'type', 'description'] },
  { table: 'sys_db_object',      type: 'data_model',     fields: ['name', 'label', 'super_class'] },
  { table: 'sys_script',         type: 'business_rule',  fields: ['name', 'collection', 'when', 'condition', 'script'] },
  { table: 'sys_script_client',  type: 'client_script',  fields: ['name', 'table', 'type', 'script'] },
  { table: 'sys_script_include', type: 'script_include', fields: ['name', 'script'] },
  { table: 'sys_ui_action',      type: 'ui_action',      fields: ['name', 'table', 'script'] },
  { table: 'sys_ui_policy',      type: 'ui_policy',      fields: ['short_description', 'table'] },
  { table: 'sys_ui_form',        type: 'form',           fields: ['name', 'view'] },
  { table: 'sc_cat_item',        type: 'catalog_item',   fields: ['name', 'short_description'] },
  { table: 'sys_hub_flow',       type: 'flow',           fields: ['name'] },
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
  const base = instance.replace(/\/$/, '');
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
    const wb = findWbBySysId(projectId, a.source_sys_id);
    if (!wb) { res.new.push(a); continue; }
    if (wb.source_hash && wb.source_hash === a.hash) {
      res.unchanged.push({ ...a, wb_id: wb.id, wb_table: wb.table });
    } else {
      res.changed.push({ ...a, wb_id: wb.id, wb_table: wb.table, prev_hash: wb.source_hash || null });
    }
  }
  // Drift: Workbench records carrying a source_sys_id that this capture did NOT return.
  // NEVER a delete — a lossy/partial SN view must not erase Workbench design. Flag only.
  for (const t of WB_PROVENANCE_TABLES) {
    let rows = [];
    try {
      rows = db.prepare(
        `SELECT ${t.pk} AS id, ${t.nameCol} AS name, source_sys_id FROM ${t.table}
         WHERE project_id = ? AND source_sys_id IS NOT NULL
           AND (lifecycle_status IS NULL OR lifecycle_status != 'retired')`
      ).all(projectId);
    } catch { continue; }
    for (const r of rows) if (!seen.has(r.source_sys_id)) {
      res.drift.push({ wb_table: t.table, wb_type: t.type, wb_id: r.id, name: r.name, source_sys_id: r.source_sys_id });
    }
  }
  res.summary = {
    unchanged: res.unchanged.length, changed: res.changed.length,
    new: res.new.length, drift: res.drift.length, errors: res.errors.length,
  };
  return res;
}

module.exports = { SN_SURFACES, WB_PROVENANCE_TABLES, hashArtifact, captureScope, findWbBySysId, classifyArtifacts };
