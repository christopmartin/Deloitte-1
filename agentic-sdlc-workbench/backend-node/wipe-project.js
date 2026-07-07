#!/usr/bin/env node
// wipe-project.js
//
// Removes all design data for a given project so it can be re-ingested from
// scratch.  The project row itself and its configuration (members, AI settings)
// are preserved.
//
// Usage:
//   node wipe-project.js                       ← lists all projects + IDs
//   node wipe-project.js <project_id>          ← shows count preview, prompts YES
//   node wipe-project.js <project_id> --yes    ← skips confirmation prompt
//
// Tables wiped (in FK-safe order):
//   FK-children without project_id (deleted via parent ID lists):
//     asdlc_ingest_clarification, asdlc_ingest_extraction
//     asdlc_change_packet_item
//     asdlc_baseline_item
//     asdlc_source_reference
//   Junction / binding tables (deleted by project_id):
//     asdlc_workflow_step_rasic, asdlc_workflow_step_cost_binding
//     asdlc_agent_use_case, asdlc_agent_tool
//     asdlc_workflow_participant, asdlc_workflow_path
//     asdlc_requirement_link
//   Core design entities (deleted by project_id):
//     asdlc_acceptance_criterion, asdlc_test_case, asdlc_user_story
//     asdlc_nonfunctional_req, asdlc_functional_req
//     asdlc_workflow_step, asdlc_workflow, asdlc_hitl_gate
//     asdlc_agent_spec, asdlc_tool, asdlc_use_case
//     asdlc_data_model, asdlc_form_design, asdlc_business_logic
//     asdlc_catalog_item, asdlc_guardrail, asdlc_data_source
//     asdlc_governance_control
//   Support / process tables (deleted by project_id):
//     asdlc_exception, asdlc_knowledge_article
//     asdlc_ingest_feedback, asdlc_requirement_change_log
//   Parent tables (deleted by project_id, after children):
//     asdlc_evidence_source (after asdlc_source_reference)
//     asdlc_report_export
//     asdlc_baseline (after asdlc_baseline_item)
//     asdlc_change_packet (after asdlc_change_packet_item)
//     asdlc_ingest_document (after clarifications/extractions)
//     asdlc_ai_usage
//   ServiceNow round-trip substrate (#81 — else a re-ingest orphans/duplicates them):
//     asdlc_sn_artifact         (generic artifact substrate)
//     asdlc_sn_change_signal    (per-record sys_mod_count baselines)
//   + the sn_artifact_id back-links on the L1 twin tables are nulled.
//
// Tables intentionally preserved:
//   asdlc_project, asdlc_project_member, asdlc_project_agent_setting
//   asdlc_audit_log  (compliance record — never wiped)
//   asdlc_app_setting, asdlc_best_practice  (global config)
//   asdlc_sn_type_registry  (GLOBAL SDK capability snapshot — not per-project)
//   asdlc_sn_assessment, asdlc_sn_catalog_run  (read-only history; re-seeds the import profile)

'use strict';

const { db } = require('./db');

const pid     = process.argv[2];
const skipYes = process.argv.includes('--yes');

if (!pid) {
  const projects = db.prepare(
    'SELECT project_id, project_name, project_code FROM asdlc_project ORDER BY created_at'
  ).all();
  console.log('\nAvailable projects:\n');
  projects.forEach(p =>
    console.log(`  ${p.project_id}  ${p.project_name} (${p.project_code})`)
  );
  console.log('\nUsage: node wipe-project.js <project_id> [--yes]\n');
  process.exit(0);
}

const project = db.prepare(
  'SELECT project_id, project_name FROM asdlc_project WHERE project_id=?'
).get(pid);
if (!project) {
  console.error(`No project found with id: ${pid}`);
  process.exit(1);
}

db.prepare('PRAGMA foreign_keys = OFF').run();

function ph(arr) { return arr.map(() => '?').join(','); }

// ── Collect parent ID lists (needed for FK-child tables) ─────────────────────
const ingestIds   = db.prepare('SELECT ingest_id          FROM asdlc_ingest_document WHERE project_id=?').all(pid).map(r => r.ingest_id);
const cpIds       = db.prepare('SELECT change_packet_id   FROM asdlc_change_packet   WHERE project_id=?').all(pid).map(r => r.change_packet_id);
const baselineIds = db.prepare('SELECT baseline_id        FROM asdlc_baseline        WHERE project_id=?').all(pid).map(r => r.baseline_id);
const evIds       = db.prepare('SELECT evidence_source_id FROM asdlc_evidence_source WHERE project_id=?').all(pid).map(r => r.evidence_source_id);

// ── Build delete list in dependency order ─────────────────────────────────────
const deletes = [
  // FK children without project_id
  ...(ingestIds.length ? [
    { label: 'asdlc_ingest_clarification', sql: `DELETE FROM asdlc_ingest_clarification WHERE ingest_id IN (${ph(ingestIds)})`,    params: ingestIds },
    { label: 'asdlc_ingest_extraction',    sql: `DELETE FROM asdlc_ingest_extraction    WHERE ingest_id IN (${ph(ingestIds)})`,    params: ingestIds },
  ] : []),
  ...(cpIds.length ? [
    { label: 'asdlc_change_packet_item',   sql: `DELETE FROM asdlc_change_packet_item   WHERE change_packet_id IN (${ph(cpIds)})`, params: cpIds },
  ] : []),
  ...(baselineIds.length ? [
    { label: 'asdlc_baseline_item',        sql: `DELETE FROM asdlc_baseline_item        WHERE baseline_id IN (${ph(baselineIds)})`, params: baselineIds },
  ] : []),
  ...(evIds.length ? [
    { label: 'asdlc_source_reference',     sql: `DELETE FROM asdlc_source_reference     WHERE evidence_source_id IN (${ph(evIds)})`, params: evIds },
  ] : []),
  // Junction / binding tables
  ...[ 'asdlc_workflow_step_rasic', 'asdlc_workflow_step_cost_binding',
       'asdlc_agent_use_case', 'asdlc_agent_tool',
       'asdlc_workflow_participant', 'asdlc_workflow_path',
       'asdlc_requirement_link', 'asdlc_requirement_change_log',
  ].map(t => ({ label: t, sql: `DELETE FROM ${t} WHERE project_id=?`, params: [pid] })),
  // Core design entities
  ...[ 'asdlc_acceptance_criterion', 'asdlc_test_case', 'asdlc_user_story',
       'asdlc_nonfunctional_req', 'asdlc_functional_req',
       'asdlc_workflow_step', 'asdlc_workflow', 'asdlc_hitl_gate',
       'asdlc_agent_spec', 'asdlc_tool', 'asdlc_use_case',
       'asdlc_data_model', 'asdlc_form_design', 'asdlc_business_logic',
       'asdlc_catalog_item', 'asdlc_guardrail', 'asdlc_data_source',
  ].map(t => ({ label: t, sql: `DELETE FROM ${t} WHERE project_id=?`, params: [pid] })),
  // Support / process tables
  ...[ 'asdlc_exception', 'asdlc_knowledge_article',
       'asdlc_ingest_feedback',
  ].map(t => ({ label: t, sql: `DELETE FROM ${t} WHERE project_id=?`, params: [pid] })),
  // Parent tables (after their FK children are gone)
  ...[ 'asdlc_evidence_source', 'asdlc_report_export', 'asdlc_baseline',
       'asdlc_change_packet', 'asdlc_ingest_document', 'asdlc_ai_usage',
  ].map(t => ({ label: t, sql: `DELETE FROM ${t} WHERE project_id=?`, params: [pid] })),
  // ServiceNow round-trip substrate (#81): clear so a wipe-and-re-ingest doesn't orphan or
  // duplicate generic artifacts, nor carry stale change-signal baselines. The GLOBAL
  // asdlc_sn_type_registry is intentionally NOT wiped (SDK snapshot, not per-project).
  ...[ 'asdlc_sn_artifact', 'asdlc_sn_change_signal',
  ].map(t => ({ label: t, sql: `DELETE FROM ${t} WHERE project_id=?`, params: [pid] })),
];

// L1 twin tables that back-link to a now-deleted generic artifact (#81). Nulled after the
// deletes so no row points at a removed asdlc_sn_artifact (esp. asdlc_integration, which is
// not itself wiped). foreign_keys is OFF during the wipe, so order is not a concern.
const SN_BACKLINK_TABLES = ['asdlc_data_model', 'asdlc_form_design', 'asdlc_business_logic', 'asdlc_catalog_item', 'asdlc_integration'];

// ── Count preview ─────────────────────────────────────────────────────────────
let totalRows = 0;
const preview = [];
for (const { label, sql, params } of deletes) {
  try {
    const countSql = sql.replace(/^DELETE FROM (\S+)\b/, 'SELECT COUNT(*) AS c FROM $1');
    const { c } = db.prepare(countSql).get(...params);
    if (c > 0) { preview.push({ label, c }); totalRows += c; }
  } catch { /* table doesn't exist in this DB version — skip */ }
}

if (totalRows === 0) {
  console.log(`\n"${project.project_name}" has no design data — nothing to wipe.\n`);
  db.prepare('PRAGMA foreign_keys = ON').run();
  process.exit(0);
}

console.log(`\nWill delete from "${project.project_name}" (${pid}):\n`);
preview.forEach(({ label, c }) => console.log(`  ${String(c).padStart(5)}  ${label}`));
console.log(`\n  ${'─'.repeat(30)}`);
console.log(`  ${String(totalRows).padStart(5)}  total rows\n`);

// ── Confirm ───────────────────────────────────────────────────────────────────
function doWipe() {
  const counts = {};
  db.prepare('BEGIN').run();
  try {
    for (const { label, sql, params } of deletes) {
      try {
        const { changes } = db.prepare(sql).run(...params);
        if (changes > 0) counts[label] = changes;
      } catch (e) {
        if (!e.message.includes('no such table')) console.warn(`  [warn] ${label}: ${e.message}`);
      }
    }
    // Null the sn_artifact_id back-links on the L1 twin tables (#81).
    for (const t of SN_BACKLINK_TABLES) {
      try {
        const { changes } = db.prepare(`UPDATE ${t} SET sn_artifact_id=NULL WHERE project_id=? AND sn_artifact_id IS NOT NULL`).run(pid);
        if (changes > 0) counts[`${t}.sn_artifact_id (nulled)`] = changes;
      } catch (e) {
        if (!e.message.includes('no such table') && !e.message.includes('no such column')) console.warn(`  [warn] ${t}.sn_artifact_id: ${e.message}`);
      }
    }
    db.prepare('COMMIT').run();
  } catch (err) {
    db.prepare('ROLLBACK').run();
    db.prepare('PRAGMA foreign_keys = ON').run();
    console.error('\nRolled back — no changes made:', err.message);
    process.exit(1);
  }

  db.prepare('PRAGMA foreign_keys = ON').run();

  const orphans = db.prepare('PRAGMA foreign_key_check').all();
  const deleted = Object.values(counts).reduce((s, n) => s + n, 0);

  console.log('Deleted:');
  Object.entries(counts).forEach(([t, n]) => console.log(`  ${String(n).padStart(5)}  ${t}`));
  console.log(`\n  ${'─'.repeat(30)}`);
  console.log(`  ${String(deleted).padStart(5)}  total\n`);

  if (orphans.length === 0) {
    console.log('FK integrity: CLEAN ✓');
  } else {
    const tables = [...new Set(orphans.map(r => r.table))];
    console.warn(`⚠  FK integrity: ${orphans.length} orphan(s) remain in: ${tables.join(', ')}`);
  }

  console.log(`\nDone — "${project.project_name}" is ready for fresh ingest.\n`);
}

if (skipYes) {
  doWipe();
} else {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('  Type YES to confirm wipe (anything else aborts): ', answer => {
    rl.close();
    if (answer.trim() === 'YES') {
      doWipe();
    } else {
      db.prepare('PRAGMA foreign_keys = ON').run();
      console.log('\nAborted — no changes made.\n');
    }
  });
}
