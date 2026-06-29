// agent/sn-instance-catalog.js
// ─────────────────────────────────────────────────────────────────────────────
// ServiceNow round-trip — whole-instance AWARENESS catalog (read-only, identity-only).
//
// captureScope() deep-captures ONE scope with full payloads (to edit logical design).
// This module does the COMPLEMENT: a lightweight CROSS-SCOPE sweep of identity fields
// only (sys_id, name, scope, 1-2 discriminators — NO scripts, NO descriptions, NO
// payloads). It gives the deployer + the Workbench "what already exists on this
// instance" awareness so we can (a) warn the deployer before a name collision, and
// (b) surface records created directly on the instance (cross-scope net-new).
//
// HYBRID FILTER (volume control): surfaces whose names are globally/instance-unique
// (tables, roles, widget ids) are swept fully (scopeMode 'instance'); per-scope-unique
// surfaces are filtered to sys_scope.scope!=global (scopeMode 'custom') so the ~100K+
// OOTB rows (sys_security_acl alone is 30K-80K+) don't drown the real collision targets.
//
// ACL CAVEAT: the Table API silently ACL-filters rows the connecting account can't read
// (200 with fewer rows, never 403). So this catalog is "the instance as this account
// sees it" — collision ABSENCE and "vanished" drift are ADVISORY, never authoritative.
'use strict';

const { db } = require('../db');
const { fetchAllRows, WB_PROVENANCE_TABLES, makeFetch } = require('./sn-capture');
const { normalizeInstanceUrl } = require('./sn-catalog');

// ── Catalog surfaces ─────────────────────────────────────────────────────────
// Each: { table, fields:[discriminators beyond name], scopeMode:'instance'|'custom',
//         nameField } . sys_id + nameField are always captured.
//   instance → no scope filter (globally/instance-unique names)
//   custom   → sys_scope.scope!=global  (per-scope-unique; OOTB global noise dropped)
const CATALOG_SURFACES = [
  // Scope backbone — every entry references a scope.
  { table: 'sys_scope',            nameField: 'scope', fields: ['name', 'vendor', 'version'], scopeMode: 'instance' },
  // Schema (highest-value pair).
  { table: 'sys_db_object',        nameField: 'name',  fields: ['label', 'super_class'],                 scopeMode: 'instance' },
  { table: 'sys_dictionary',       nameField: 'name',  fields: ['element', 'internal_type', 'reference'], scopeMode: 'custom' },
  // Business logic.
  { table: 'sys_script',           nameField: 'name',  fields: ['collection', 'when'], scopeMode: 'custom' },
  { table: 'sys_script_include',   nameField: 'name',  fields: [],                     scopeMode: 'custom' },
  { table: 'sys_script_client',    nameField: 'name',  fields: ['table', 'type'],      scopeMode: 'custom' },
  { table: 'sys_ui_action',        nameField: 'name',  fields: ['table'],              scopeMode: 'custom' },
  { table: 'sys_ui_policy',        nameField: 'short_description', fields: ['table'],   scopeMode: 'custom' },
  // Automation + events.
  { table: 'sys_hub_flow',         nameField: 'name',  fields: [],                     scopeMode: 'custom' },
  { table: 'sysauto_script',       nameField: 'name',  fields: [],                     scopeMode: 'custom' },
  { table: 'sysevent_email_action',nameField: 'name',  fields: [],                     scopeMode: 'custom' },
  // Security + access.
  { table: 'sys_security_acl',     nameField: 'name',  fields: ['operation'],          scopeMode: 'custom' },
  { table: 'sys_user_role',        nameField: 'name',  fields: ['suffix'],             scopeMode: 'instance' },
  { table: 'user_criteria',        nameField: 'name',  fields: [],                     scopeMode: 'custom' },
  // Service catalog.
  { table: 'sc_cat_item',          nameField: 'name',  fields: ['category'],           scopeMode: 'custom' },
  { table: 'item_option_new_set',  nameField: 'name',  fields: [],                     scopeMode: 'custom' },
  // AI artifacts (primary use case).
  { table: 'sn_aia_agent',         nameField: 'name',  fields: ['role'],               scopeMode: 'custom' },
  { table: 'sn_aia_tool',          nameField: 'name',  fields: ['type'],               scopeMode: 'custom' },
  { table: 'sn_aia_usecase',       nameField: 'name',  fields: [],                     scopeMode: 'custom' },
  // Integration.
  { table: 'sys_rest_message',     nameField: 'name',  fields: ['rest_endpoint'],      scopeMode: 'custom' },
  { table: 'sys_alias',            nameField: 'name',  fields: ['type'],               scopeMode: 'custom' },
  // UI + portal.
  { table: 'sp_widget',            nameField: 'name',  fields: ['id'],                 scopeMode: 'instance' },
  { table: 'sys_ux_page_registry', nameField: 'name',  fields: [],                     scopeMode: 'custom' },
  { table: 'sys_ui_page',          nameField: 'name',  fields: [],                     scopeMode: 'custom' },
];

// Maps a Workbench design entity_type → the SN surface(s) whose namespace it would
// collide in, and whether that namespace is instance-unique (any-scope match = hard
// collision) vs per-scope (only a same-scope match is a hard collision). `nameKey`
// names the WB column to match against the SN record name (default 'name'); data_model
// collides on its PHYSICAL table name, not its business label.
const DESIGN_SURFACE_MAP = {
  agent_spec:     { surfaces: ['sn_aia_agent'],    instanceUnique: false },
  tool:           { surfaces: ['sn_aia_tool'],     instanceUnique: false },
  use_case:       { surfaces: ['sn_aia_usecase'],  instanceUnique: false },
  workflow:       { surfaces: ['sys_hub_flow'],    instanceUnique: false },
  data_model:     { surfaces: ['sys_db_object'],   instanceUnique: true,  nameKey: 'physical_name' },
  business_logic: { surfaces: ['sys_script', 'sys_script_include'], instanceUnique: false },
  catalog_item:   { surfaces: ['sc_cat_item'],     instanceUnique: false },
  integration:    { surfaces: ['sys_rest_message'],instanceUnique: false },
};

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

/**
 * Cross-scope, identity-only sweep of the live instance. Read-only. No AI, no payloads.
 * Mirrors captureScope's per-surface error/cap tolerance: a surface that errors is
 * skipped (recorded in warnings), a capped surface is recorded so completeness is never
 * silently assumed.
 * @param {{instance,user,pw,fetchImpl?}} opts
 * @returns {Promise<{surfaces:Object, warnings:string[], capped_surfaces:string[], captured_at:string, instance_url:string, capturing_user:string}>}
 */
async function captureInstanceCatalog({ instance, user, pw, fetchImpl } = {}) {
  if (!instance || !user || !pw) throw new Error('instance, user and pw are required');
  const f = makeFetch(fetchImpl);
  const auth = 'Basic ' + Buffer.from(`${user}:${pw}`).toString('base64');
  const base = normalizeInstanceUrl(instance);
  const headers = { Authorization: auth, Accept: 'application/json' };

  const surfaces = {};
  const warnings = [];
  const capped_surfaces = [];

  for (const s of CATALOG_SURFACES) {
    // Identity fields only. nameField first so the entry's `name` is reliable.
    const fieldSet = ['sys_id', s.nameField, ...s.fields].filter((v, i, a) => v && a.indexOf(v) === i);
    // Stable order is REQUIRED for offset pagination (fetchAllRows assumes ^ORDERBYsys_id).
    const scopeClause = s.scopeMode === 'custom' ? 'sys_scope.scope!=global^' : '';
    const query = `${scopeClause}ORDERBYsys_id`;
    const baseUrl = `${base}/api/now/table/${s.table}`
      + `?sysparm_query=${encodeURIComponent(query)}`
      + `&sysparm_fields=${encodeURIComponent([...fieldSet, 'sys_scope.scope'].join(','))}`
      + `&sysparm_display_value=true&sysparm_exclude_reference_link=true`;
    let rows = [];
    try {
      const out = await fetchAllRows(f, baseUrl, headers);
      rows = out.rows;
      if (out.capped) {
        capped_surfaces.push(s.table);
        warnings.push(`${s.table} -> capped; catalog is PARTIAL for this surface (raise SN_CAPTURE_MAX_ROWS)`);
      }
    } catch (e) {
      // 400/403/404 = table not visible to this account (missing role, ACL, or not
      // provisioned) — treat as empty, same as ACL-silent-filtering on rows.
      if (/HTTP (400|403|404)\b/.test(e.message)) {
        surfaces[s.table] = [];
        continue;
      }
      const cause = e.cause ? ` (${e.cause.code || e.cause.message || String(e.cause)})` : '';
      console.warn(`[sn-catalog] surface error ${s.table}:`, e.message + cause);
      warnings.push(`${s.table} -> ${e.message}${cause}`);
      surfaces[s.table] = [];
      continue;
    }
    surfaces[s.table] = rows.map((row) => {
      const entry = {
        sys_id: row.sys_id,
        name: row[s.nameField] || row.name || '(unnamed)',
        scope: row['sys_scope.scope'] || row.sys_scope || null,
      };
      for (const fld of s.fields) if (row[fld] != null && row[fld] !== '') entry[fld] = row[fld];
      return entry;
    });
  }

  return {
    surfaces,
    warnings,
    capped_surfaces,
    captured_at: new Date().toISOString(),
    instance_url: base,
    capturing_user: user,
  };
}

/** Per-surface counts + total for a captured catalog (the always-returned summary). */
function summarizeCatalog(catalog) {
  const surface_counts = {};
  let total_entries = 0;
  for (const [t, rows] of Object.entries(catalog.surfaces || {})) {
    surface_counts[t] = rows.length;
    total_entries += rows.length;
  }
  return {
    surface_counts,
    total_entries,
    captured_at: catalog.captured_at,
    capped_surfaces: catalog.capped_surfaces || [],
    warnings: catalog.warnings || [],
  };
}

/**
 * PURE. Compute name collisions between what the Workbench is about to CREATE and what
 * already exists on the instance.
 * @param {object} catalog  { surfaces: { table: [{sys_id,name,scope}] } }
 * @param {Array}  deployTargets  [{ kind, name, slug, surfaces:[snTable], scope, instanceUnique }]
 *   ONLY entities the Workbench will CREATE (no source_sys_id) — a tracked PATCH is not a collision.
 * @returns {Array} [{ deploy_kind, name, surface, existing_name, scope, sys_id, same_scope, hard }]
 *   `hard` = a real collision (instance-unique any-scope, OR per-scope same-scope).
 */
function computeCollisions(catalog, deployTargets) {
  const surfaces = (catalog && catalog.surfaces) || {};
  const hits = [];
  for (const t of deployTargets || []) {
    const target = norm(t.name);
    if (!target) continue;
    for (const snTable of (t.surfaces || [])) {
      for (const entry of (surfaces[snTable] || [])) {
        if (norm(entry.name) !== target) continue;
        const same_scope = !!(t.scope && entry.scope && norm(entry.scope) === norm(t.scope));
        hits.push({
          deploy_kind: t.kind, name: t.name, surface: snTable,
          existing_name: entry.name, scope: entry.scope || null, sys_id: entry.sys_id,
          same_scope, hard: !!t.instanceUnique || same_scope,
        });
      }
    }
  }
  return hits;
}

/**
 * Existence drift from a catalog snapshot vs the project's Workbench provenance rows.
 * Reads the WB provenance tables (like classifyArtifacts). Cross-scope presence lets us
 * tell "moved" (sys_id still on the instance, different scope) from "vanished" (absent).
 *   vanished  — WB row's source_sys_id NOT in the catalog at all (ADVISORY; could be
 *               ACL-hidden or deleted — never act on this).
 *   moved     — WB row's source_sys_id present, but under a different scope than source_scope.
 *   untracked — catalog entries in the project's target scope whose sys_id is unknown to WB
 *               (net-new created directly on the instance → inbound HITL candidates).
 * @param {string} projectId
 * @param {object} catalog
 * @param {{projectScope?:string}} opts
 */
function detectExistenceDrift(projectId, catalog, opts = {}) {
  const surfaces = (catalog && catalog.surfaces) || {};
  // sys_id -> scope (first seen). Globally unique, so one map across all surfaces is fine.
  const catalogById = new Map();
  for (const rows of Object.values(surfaces)) {
    for (const e of rows) if (e.sys_id && !catalogById.has(e.sys_id)) catalogById.set(e.sys_id, e.scope || null);
  }

  const vanished = [], moved = [];
  const wbSysIds = new Set();
  for (const t of WB_PROVENANCE_TABLES) {
    let rows = [];
    try {
      rows = db.prepare(
        `SELECT ${t.pk} AS id, ${t.nameCol} AS name, source_sys_id, source_scope FROM ${t.table}
         WHERE project_id = ? AND source_sys_id IS NOT NULL
           AND (lifecycle_status IS NULL OR lifecycle_status != 'retired')`
      ).all(projectId);
    } catch { continue; }   // table without provenance columns — skip
    for (const r of rows) {
      wbSysIds.add(r.source_sys_id);
      if (!catalogById.has(r.source_sys_id)) {
        vanished.push({ wb_table: t.table, wb_type: t.type, wb_id: r.id, name: r.name, source_sys_id: r.source_sys_id });
      } else {
        const liveScope = catalogById.get(r.source_sys_id);
        if (r.source_scope && liveScope && norm(liveScope) !== norm(r.source_scope)) {
          moved.push({ wb_table: t.table, wb_type: t.type, wb_id: r.id, name: r.name,
            source_sys_id: r.source_sys_id, from_scope: r.source_scope, to_scope: liveScope });
        }
      }
    }
  }

  // Untracked net-new: catalog entries in the project's target scope unknown to WB.
  const projectScope = opts.projectScope ? norm(opts.projectScope) : null;
  const untracked = [];
  if (projectScope) {
    for (const [table, rows] of Object.entries(surfaces)) {
      for (const e of rows) {
        if (!e.sys_id || wbSysIds.has(e.sys_id)) continue;
        if (norm(e.scope) !== projectScope) continue;
        untracked.push({ surface: table, sys_id: e.sys_id, name: e.name, scope: e.scope });
      }
    }
  }

  return { vanished, moved, untracked };
}

module.exports = {
  CATALOG_SURFACES,
  DESIGN_SURFACE_MAP,
  captureInstanceCatalog,
  summarizeCatalog,
  computeCollisions,
  detectExistenceDrift,
};
