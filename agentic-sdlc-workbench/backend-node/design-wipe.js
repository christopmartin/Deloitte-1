// design-wipe.js
//
// Shared logic for wiping a project's design data, scoped by project_id, in
// FK-safe order. Used by both wipe-project.js (CLI, full wipe including
// documents) and the Administration > Data Maintenance UI (server.js, with
// an option to keep the Document Catalog for re-ingestion).
//
// Tables intentionally preserved (never touched by this module):
//   asdlc_project, asdlc_project_member, asdlc_project_agent_setting
//   asdlc_audit_log  (compliance record — never wiped)
//   asdlc_app_setting, asdlc_best_practice  (global config)
//   asdlc_sn_type_registry  (GLOBAL SDK capability snapshot — not per-project)
//   asdlc_sn_assessment, asdlc_sn_catalog_run  (read-only history; re-seeds the import profile)
//
// Maintenance: every asdlc_* table that carries a project_id column and holds
// design data (not setup/config) must be listed below. If you add such a
// table to schema.sql, add it here too — do not rely on this file's own
// history as proof it's complete; diff against schema.sql.

'use strict';

const { db } = require('./db');

function ph(arr) { return arr.map(() => '?').join(','); }

// Junction / binding tables (deleted by project_id).
const JUNCTION_TABLES = [
  'asdlc_workflow_step_rasic', 'asdlc_workflow_step_cost_binding',
  'asdlc_agent_use_case', 'asdlc_agent_tool',
  'asdlc_workflow_participant', 'asdlc_workflow_path',
  'asdlc_requirement_link', 'asdlc_requirement_change_log',
];

// Core design entities (deleted by project_id). Includes the platform-table
// entities (business rules/logic, user groups, choice sets, portals,
// workspaces, variable sets, inbound REST APIs, dashboards, reports, KPIs,
// SLAs, notifications, NL rules, discovery plans, outbound integrations)
// that a 2026-07-13 audit found missing from the original wipe list.
const CORE_DESIGN_TABLES = [
  'asdlc_acceptance_criterion', 'asdlc_test_case', 'asdlc_user_story',
  'asdlc_nonfunctional_req', 'asdlc_functional_req',
  'asdlc_workflow_step', 'asdlc_workflow', 'asdlc_hitl_gate',
  'asdlc_agent_spec', 'asdlc_tool', 'asdlc_use_case',
  'asdlc_data_model', 'asdlc_form_design', 'asdlc_business_logic',
  'asdlc_catalog_item', 'asdlc_guardrail', 'asdlc_data_source',
  'asdlc_integration',
  'asdlc_dashboard', 'asdlc_report', 'asdlc_kpi', 'asdlc_nl_rule',
  'asdlc_sla_definition', 'asdlc_email_notification', 'asdlc_user_group',
  'asdlc_catalog_category', 'asdlc_choice_set', 'asdlc_service_portal',
  'asdlc_workspace', 'asdlc_variable_set', 'asdlc_inbound_rest_api',
  'asdlc_sn_discovery_plan',
];

// Support / process tables (deleted by project_id).
const SUPPORT_TABLES = ['asdlc_exception', 'asdlc_knowledge_article', 'asdlc_ingest_feedback'];

// ServiceNow round-trip substrate (#81 — else a re-ingest orphans/duplicates them).
// The GLOBAL asdlc_sn_type_registry is intentionally NOT wiped (SDK snapshot, not per-project).
const SN_SUBSTRATE_TABLES = ['asdlc_sn_artifact', 'asdlc_sn_change_signal'];

// L1 twin tables that back-link to a generic asdlc_sn_artifact row (#81), nulled
// after deletes so no row points at a removed artifact. asdlc_integration is NOT
// in this list — it is itself deleted (see CORE_DESIGN_TABLES above), not preserved.
const SN_BACKLINK_TABLES = ['asdlc_data_model', 'asdlc_form_design', 'asdlc_business_logic', 'asdlc_catalog_item'];

/**
 * Build the ordered delete plan for a project's design data.
 * @param {string} pid
 * @param {{keepDocuments?: boolean}} opts - when true, asdlc_ingest_document
 *   rows are kept (their stale extraction/clarification children are still
 *   cleared, and the document is reset to a re-ingestable state).
 */
function buildWipePlan(pid, { keepDocuments = false } = {}) {
  const ingestIds   = db.prepare('SELECT ingest_id          FROM asdlc_ingest_document WHERE project_id=?').all(pid).map(r => r.ingest_id);
  const cpIds       = db.prepare('SELECT change_packet_id   FROM asdlc_change_packet   WHERE project_id=?').all(pid).map(r => r.change_packet_id);
  const baselineIds = db.prepare('SELECT baseline_id        FROM asdlc_baseline        WHERE project_id=?').all(pid).map(r => r.baseline_id);
  const evIds       = db.prepare('SELECT evidence_source_id FROM asdlc_evidence_source WHERE project_id=?').all(pid).map(r => r.evidence_source_id);

  const deletes = [
    // FK children without their own project_id
    ...(ingestIds.length ? [
      { label: 'asdlc_ingest_clarification', sql: `DELETE FROM asdlc_ingest_clarification WHERE ingest_id IN (${ph(ingestIds)})`, params: ingestIds },
      { label: 'asdlc_ingest_extraction',    sql: `DELETE FROM asdlc_ingest_extraction    WHERE ingest_id IN (${ph(ingestIds)})`, params: ingestIds },
    ] : []),
    ...(cpIds.length ? [
      { label: 'asdlc_change_packet_item', sql: `DELETE FROM asdlc_change_packet_item WHERE change_packet_id IN (${ph(cpIds)})`, params: cpIds },
    ] : []),
    ...(baselineIds.length ? [
      { label: 'asdlc_baseline_item', sql: `DELETE FROM asdlc_baseline_item WHERE baseline_id IN (${ph(baselineIds)})`, params: baselineIds },
    ] : []),
    ...(evIds.length ? [
      { label: 'asdlc_source_reference', sql: `DELETE FROM asdlc_source_reference WHERE evidence_source_id IN (${ph(evIds)})`, params: evIds },
    ] : []),
    // Junction / binding tables
    ...JUNCTION_TABLES.map(t => ({ label: t, sql: `DELETE FROM ${t} WHERE project_id=?`, params: [pid] })),
    // Core design entities
    ...CORE_DESIGN_TABLES.map(t => ({ label: t, sql: `DELETE FROM ${t} WHERE project_id=?`, params: [pid] })),
    // Support / process tables
    ...SUPPORT_TABLES.map(t => ({ label: t, sql: `DELETE FROM ${t} WHERE project_id=?`, params: [pid] })),
    // Parent tables (after their FK children are gone)
    { label: 'asdlc_evidence_source', sql: 'DELETE FROM asdlc_evidence_source WHERE project_id=?', params: [pid] },
    { label: 'asdlc_report_export',   sql: 'DELETE FROM asdlc_report_export WHERE project_id=?',   params: [pid] },
    { label: 'asdlc_baseline',        sql: 'DELETE FROM asdlc_baseline WHERE project_id=?',         params: [pid] },
    { label: 'asdlc_change_packet',   sql: 'DELETE FROM asdlc_change_packet WHERE project_id=?',    params: [pid] },
    ...(keepDocuments ? [] : [
      { label: 'asdlc_ingest_document', sql: 'DELETE FROM asdlc_ingest_document WHERE project_id=?', params: [pid] },
    ]),
    { label: 'asdlc_ai_usage', sql: 'DELETE FROM asdlc_ai_usage WHERE project_id=?', params: [pid] },
    // ServiceNow round-trip substrate
    ...SN_SUBSTRATE_TABLES.map(t => ({ label: t, sql: `DELETE FROM ${t} WHERE project_id=?`, params: [pid] })),
  ];

  const postUpdates = [
    ...SN_BACKLINK_TABLES.map(t => ({
      label: `${t}.sn_artifact_id (nulled)`,
      sql: `UPDATE ${t} SET sn_artifact_id=NULL WHERE project_id=? AND sn_artifact_id IS NOT NULL`,
      params: [pid],
    })),
    ...(keepDocuments ? [{
      label: 'asdlc_ingest_document (reset to staged)',
      sql: `UPDATE asdlc_ingest_document SET ingest_status='staged', change_packets_generated=0, processing_notes=NULL, updated_at=datetime('now') WHERE project_id=?`,
      params: [pid],
    }] : []),
  ];

  return { deletes, postUpdates };
}

/** Count-preview pass — same rows the wipe would delete, without deleting them. */
function previewWipe(pid, opts) {
  const { deletes } = buildWipePlan(pid, opts);
  let total = 0;
  const rows = [];
  for (const { label, sql, params } of deletes) {
    try {
      const countSql = sql.replace(/^DELETE FROM (\S+)\b/, 'SELECT COUNT(*) AS c FROM $1');
      const { c } = db.prepare(countSql).get(...params);
      if (c > 0) { rows.push({ label, count: c }); total += c; }
    } catch { /* table doesn't exist in this DB version — skip */ }
  }
  return { rows, total };
}

/** Runs the wipe in a transaction. Throws only on a transaction-level failure. */
function executeWipe(pid, opts) {
  const { deletes, postUpdates } = buildWipePlan(pid, opts);
  const counts = {};
  const warnings = [];

  db.prepare('PRAGMA foreign_keys = OFF').run();
  db.prepare('BEGIN').run();
  try {
    for (const { label, sql, params } of deletes) {
      try {
        const { changes } = db.prepare(sql).run(...params);
        if (changes > 0) counts[label] = changes;
      } catch (e) {
        if (!e.message.includes('no such table')) warnings.push(`${label}: ${e.message}`);
      }
    }
    for (const { label, sql, params } of postUpdates) {
      try {
        const { changes } = db.prepare(sql).run(...params);
        if (changes > 0) counts[label] = changes;
      } catch (e) {
        if (!e.message.includes('no such table') && !e.message.includes('no such column')) warnings.push(`${label}: ${e.message}`);
      }
    }
    db.prepare('COMMIT').run();
  } catch (err) {
    db.prepare('ROLLBACK').run();
    db.prepare('PRAGMA foreign_keys = ON').run();
    throw err;
  }
  db.prepare('PRAGMA foreign_keys = ON').run();

  const orphans = db.prepare('PRAGMA foreign_key_check').all();
  const total = Object.values(counts).reduce((s, n) => s + n, 0);

  return {
    counts,
    total,
    warnings,
    fkClean: orphans.length === 0,
    orphanTables: [...new Set(orphans.map(r => r.table))],
  };
}

module.exports = { buildWipePlan, previewWipe, executeWipe };
