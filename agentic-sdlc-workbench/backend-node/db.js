// db.js — SQLite database initialisation for Agentic SDLC Workbench
// Uses the built-in node:sqlite module (Node >= 22.5)
'use strict';

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');

// DB path is overridable via ASDLC_DB_PATH (used for isolated tests); defaults to the app DB.
const DB_PATH = process.env.ASDLC_DB_PATH || path.join(__dirname, 'asdlc.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

const db = new DatabaseSync(DB_PATH);

// Performance pragmas (node:sqlite uses exec for pragmas)
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

// Execute schema — all statements are IF NOT EXISTS so safe to run on every start
const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
db.exec(schema);

// ─── Schema migrations ──────────────────────────────────────────────────────
// ALTER TABLE is not idempotent in SQLite, so we attempt each and silently
// ignore "duplicate column" errors.
const MIGRATIONS = [
  // ── Pre-Phase-1 (legacy migrations) ────────────────────────────────────
  "ALTER TABLE asdlc_project ADD COLUMN confidence_threshold REAL NOT NULL DEFAULT 0.75",
  "ALTER TABLE asdlc_ingest_document ADD COLUMN file_path TEXT",
  "ALTER TABLE asdlc_ingest_document ADD COLUMN raw_text TEXT",
  "ALTER TABLE asdlc_ingest_extraction ADD COLUMN source_location TEXT",
  "ALTER TABLE asdlc_project ADD COLUMN version_string TEXT NOT NULL DEFAULT '1.0.0'",
  "ALTER TABLE asdlc_workflow ADD COLUMN sla_hours REAL",

  // ── Phase 1: Slug columns (Decision #1) ────────────────────────────────
  // Tier 1: UC, WF, AG, T. User stories already live in extraction JSON.
  "ALTER TABLE asdlc_use_case             ADD COLUMN slug TEXT",
  "ALTER TABLE asdlc_workflow             ADD COLUMN slug TEXT",
  "ALTER TABLE asdlc_agent_spec           ADD COLUMN slug TEXT",
  "ALTER TABLE asdlc_tool                 ADD COLUMN slug TEXT",
  // Tier 2: Step, AC, TC.
  "ALTER TABLE asdlc_workflow_step        ADD COLUMN slug TEXT",
  "ALTER TABLE asdlc_acceptance_criterion ADD COLUMN slug TEXT",
  "ALTER TABLE asdlc_test_case            ADD COLUMN slug TEXT",

  // ── Phase 1: Use Case additions (Decisions #2, #4, #6, #7, #17) ────────
  "ALTER TABLE asdlc_use_case ADD COLUMN risk_tier TEXT CHECK (risk_tier IS NULL OR risk_tier IN ('High','Medium','Low'))",
  "ALTER TABLE asdlc_use_case ADD COLUMN owner TEXT",
  "ALTER TABLE asdlc_use_case ADD COLUMN primary_success_metric TEXT",
  "ALTER TABLE asdlc_use_case ADD COLUMN epic_or_feature_id TEXT",
  "ALTER TABLE asdlc_use_case ADD COLUMN baseline_cost_annual_usd REAL",

  // ── Phase 1: Workflow additions (Decisions #12, #17) ───────────────────
  "ALTER TABLE asdlc_workflow ADD COLUMN risk_tier TEXT CHECK (risk_tier IS NULL OR risk_tier IN ('High','Medium','Low'))",
  "ALTER TABLE asdlc_workflow ADD COLUMN runs_per_period REAL",

  // ── Phase 1: Workflow Step additions (Decision #12) ────────────────────
  "ALTER TABLE asdlc_workflow_step ADD COLUMN step_type TEXT CHECK (step_type IS NULL OR step_type IN ('Start','Activity','Decision','Approval','Notification','Wait','End'))",
  "ALTER TABLE asdlc_workflow_step ADD COLUMN step_purpose TEXT",
  "ALTER TABLE asdlc_workflow_step ADD COLUMN preconditions TEXT",
  "ALTER TABLE asdlc_workflow_step ADD COLUMN evidence_captured TEXT",
  "ALTER TABLE asdlc_workflow_step ADD COLUMN is_end_step INTEGER NOT NULL DEFAULT 0",

  // ── Phase 1: Agent Spec additions (Decisions #2, #16, #17, #18) ────────
  // NOTE: supervision_model exists on asdlc_use_case but NOT on asdlc_agent_spec yet.
  // This adds it to agent_spec with a CHECK constraint matching Decision #2's 3-value enum.
  "ALTER TABLE asdlc_agent_spec ADD COLUMN supervision_model TEXT CHECK (supervision_model IS NULL OR supervision_model IN ('Advisory-only','Supervised HITL','Autonomous'))",
  "ALTER TABLE asdlc_agent_spec ADD COLUMN maintenance_owner TEXT",
  "ALTER TABLE asdlc_agent_spec ADD COLUMN orchestration_strategy TEXT CHECK (orchestration_strategy IS NULL OR orchestration_strategy IN ('Base Planner','ReActive Planner','Batch Planner'))",
  "ALTER TABLE asdlc_agent_spec ADD COLUMN latency_target TEXT",
  "ALTER TABLE asdlc_agent_spec ADD COLUMN post_release_validation TEXT",
  "ALTER TABLE asdlc_agent_spec ADD COLUMN cost_model TEXT NOT NULL DEFAULT 'none'",

  // ── Phase 1: Tool additions (Decision #14) ─────────────────────────────
  "ALTER TABLE asdlc_tool ADD COLUMN dev_status TEXT CHECK (dev_status IS NULL OR dev_status IN ('Existing','To be built'))",

  // ── Phase 2: Workflow step owner participant FK (Decision #12) ────────────
  "ALTER TABLE asdlc_workflow_step ADD COLUMN owner_participant_id TEXT",

  // ── Per-application cost params ────────────────────────────────────────────
  // All cost params (pricing + planning + entitlement) are per-Application —
  // each customer/app negotiates its own price sheet and plan with ServiceNow.
  // The legacy global asdlc_cost_assumption row is retained for backward-compat
  // reads but is no longer authoritative.
  "ALTER TABLE asdlc_project ADD COLUMN planning_period TEXT NOT NULL DEFAULT 'Monthly' CHECK (planning_period IN ('Weekly','Monthly','Quarterly','Annual'))",
  "ALTER TABLE asdlc_project ADD COLUMN periods_per_year REAL NOT NULL DEFAULT 12",
  "ALTER TABLE asdlc_project ADD COLUMN entitlement_enabled INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE asdlc_project ADD COLUMN annual_included_assists REAL",
  "ALTER TABLE asdlc_project ADD COLUMN cost_per_assist REAL NOT NULL DEFAULT 0.015",
  "ALTER TABLE asdlc_project ADD COLUMN overage_rate REAL",
  "ALTER TABLE asdlc_project ADD COLUMN cost_per_assist_expansion REAL",
  // Feature #9 — quality-reviewer attribution + category + dedupe index
  "ALTER TABLE asdlc_exception ADD COLUMN detected_by TEXT NOT NULL DEFAULT 'manual'",
  "ALTER TABLE asdlc_exception ADD COLUMN field_name TEXT",
  "ALTER TABLE asdlc_exception ADD COLUMN finding_category TEXT",
  "CREATE INDEX IF NOT EXISTS idx_exception_dedupe ON asdlc_exception(project_id, related_entity_id, field_name, finding_category, status)",
  // Requirements management
  "ALTER TABLE asdlc_test_case ADD COLUMN requirement_ids TEXT NOT NULL DEFAULT '[]'",
  // AI ingestion pipeline: create/update/delete operation on change-packet items
  "ALTER TABLE asdlc_change_packet_item ADD COLUMN operation TEXT NOT NULL DEFAULT 'create'",
  // Requirements-first ingestion: AC req_slug traceability link
  "ALTER TABLE asdlc_acceptance_criterion ADD COLUMN req_slug TEXT",

  // Ingest document soft-cancel / archive (reversible; never hard-deleted)
  "ALTER TABLE asdlc_ingest_document ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'active'",
  "ALTER TABLE asdlc_ingest_document ADD COLUMN cancelled_at TEXT",
  "ALTER TABLE asdlc_ingest_document ADD COLUMN cancelled_by TEXT",
  "ALTER TABLE asdlc_ingest_document ADD COLUMN cancel_reason TEXT",
  // Index must come AFTER the column is added (runs post-schema-exec, so it is
  // safe on both fresh and existing databases).
  "CREATE INDEX IF NOT EXISTS idx_ingest_lifecycle ON asdlc_ingest_document(lifecycle_status)",
];
for (const migration of MIGRATIONS) {
  try { db.exec(migration); } catch { /* column already exists — safe to ignore */ }
}

// ─── Phase 1 unique indexes for slug (project_id, slug) ─────────────────────
// SQLite's UNIQUE treats NULLs as distinct, so this catches dup slugs only when
// slug IS NOT NULL (which is what we want during backfill + going forward).
const SLUG_INDEXES = [
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_uc_slug   ON asdlc_use_case(project_id, slug)              WHERE slug IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_wf_slug   ON asdlc_workflow(project_id, slug)              WHERE slug IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_ag_slug   ON asdlc_agent_spec(project_id, slug)            WHERE slug IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_slug ON asdlc_tool(project_id, slug)                  WHERE slug IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_step_slug ON asdlc_workflow_step(project_id, slug)         WHERE slug IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_ac_slug   ON asdlc_acceptance_criterion(project_id, slug)  WHERE slug IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_tc_slug   ON asdlc_test_case(project_id, slug)             WHERE slug IS NOT NULL",
  // Phase 2
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_wp_slug   ON asdlc_workflow_participant(project_id, slug)  WHERE slug IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_path_slug ON asdlc_workflow_path(project_id, slug)         WHERE slug IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_fr_slug  ON asdlc_functional_req(project_id, slug)   WHERE slug IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_nfr_slug ON asdlc_nonfunctional_req(project_id, slug) WHERE slug IS NOT NULL",
];
for (const idx of SLUG_INDEXES) {
  try { db.exec(idx); } catch (err) { console.error('[db] slug index failed:', err.message); }
}

// ─── Phase 1 data migrations ────────────────────────────────────────────────
// Decision #2: migrate UC supervision_model 'Assisted' → 'Supervised HITL'.
// Run before any backfill so the 3-value enum is canonical.
const DATA_MIGRATIONS = [
  "UPDATE asdlc_use_case SET supervision_model = 'Supervised HITL' WHERE supervision_model = 'Assisted'",
];
for (const dm of DATA_MIGRATIONS) {
  try { db.exec(dm); } catch (err) { console.error('[db] data migration failed:', err.message); }
}

// ─── Phase 1 slug backfill ──────────────────────────────────────────────────
// For each Tier-1/Tier-2 table, assign slugs to any rows that don't have one
// yet. Numbering is per-project, sequential by created_at. Idempotent — only
// touches rows where slug IS NULL.
const SLUG_TABLES = [
  { table: 'asdlc_use_case',             pk: 'use_case_id',             prefix: 'UC'   },
  { table: 'asdlc_workflow',             pk: 'workflow_id',             prefix: 'WF'   },
  { table: 'asdlc_agent_spec',           pk: 'agent_spec_id',           prefix: 'AG'   },
  { table: 'asdlc_tool',                 pk: 'tool_id',                 prefix: 'T'    },
  { table: 'asdlc_workflow_step',        pk: 'workflow_step_id',        prefix: 'S'    },
  { table: 'asdlc_acceptance_criterion', pk: 'acceptance_criterion_id', prefix: 'AC'   },
  { table: 'asdlc_test_case',            pk: 'test_case_id',            prefix: 'TC'   },
  // Phase 2
  { table: 'asdlc_workflow_participant', pk: 'workflow_participant_id', prefix: 'P'    },
  { table: 'asdlc_workflow_path',        pk: 'workflow_path_id',        prefix: 'PATH' },
  { table: 'asdlc_functional_req',    pk: 'fr_id',   prefix: 'FR'  },
  { table: 'asdlc_nonfunctional_req', pk: 'nfr_id',  prefix: 'NFR' },
];

function backfillSlugsFor(tableSpec) {
  const { table, pk, prefix } = tableSpec;
  // Rows missing slug, in project + chronological order
  const rows = db.prepare(
    `SELECT ${pk} AS row_id, project_id FROM ${table} WHERE slug IS NULL ORDER BY project_id, created_at`
  ).all();
  if (rows.length === 0) return;

  const updateStmt = db.prepare(`UPDATE ${table} SET slug = ? WHERE ${pk} = ?`);
  // Group by project (or "__GLOBAL__" for null project_id rows)
  const byProject = {};
  for (const r of rows) {
    const key = r.project_id || '__GLOBAL__';
    if (!byProject[key]) byProject[key] = [];
    byProject[key].push(r.row_id);
  }

  for (const [pkey, ids] of Object.entries(byProject)) {
    const projectId = pkey === '__GLOBAL__' ? null : pkey;
    let nextNum = nextSlugNumber(table, prefix, projectId);
    for (const rowId of ids) {
      const slug = `${prefix}-${String(nextNum).padStart(3, '0')}`;
      try {
        updateStmt.run(slug, rowId);
        nextNum++;
      } catch (err) {
        console.error(`[db] slug backfill ${table}:${rowId} failed:`, err.message);
      }
    }
  }
}

/**
 * Compute the next sequential slug NUMBER (just the integer suffix) for a
 * given (table, prefix, project_id). Used by both backfill and by INSERT
 * paths in server.js.
 *
 * @param {string} table       e.g. 'asdlc_use_case'
 * @param {string} prefix      e.g. 'UC'
 * @param {string|null} projectId   null for cross-project entities (e.g. global tools)
 * @returns {number}
 */
function nextSlugNumber(table, prefix, projectId) {
  const sql = projectId
    ? `SELECT MAX(CAST(SUBSTR(slug, INSTR(slug, '-') + 1) AS INTEGER)) AS max_num
       FROM ${table}
       WHERE slug IS NOT NULL AND slug LIKE ? AND project_id = ?`
    : `SELECT MAX(CAST(SUBSTR(slug, INSTR(slug, '-') + 1) AS INTEGER)) AS max_num
       FROM ${table}
       WHERE slug IS NOT NULL AND slug LIKE ? AND project_id IS NULL`;
  const params = projectId ? [`${prefix}-%`, projectId] : [`${prefix}-%`];
  const row = db.prepare(sql).get(...params);
  return (row.max_num || 0) + 1;
}

/**
 * Compute the next slug STRING (prefix + zero-padded number) for a given
 * (table, prefix, project_id). Used at INSERT time by server.js endpoints.
 *
 * @returns {string} e.g. "UC-014"
 */
function nextSlug(table, prefix, projectId) {
  const num = nextSlugNumber(table, prefix, projectId);
  return `${prefix}-${String(num).padStart(3, '0')}`;
}

// Run backfill on startup (idempotent)
for (const spec of SLUG_TABLES) {
  try { backfillSlugsFor(spec); } catch (err) {
    console.error(`[db] slug backfill failed for ${spec.table}:`, err.message);
  }
}

// ─── Phase 3 backfill: asdlc_agent_use_case from existing use_case_id FKs ──
// For every agent_spec row that has a use_case_id, ensure a matching row in
// the join table exists. INSERT OR IGNORE — fully idempotent.
try {
  const agents = db.prepare(
    'SELECT agent_spec_id, use_case_id, project_id FROM asdlc_agent_spec WHERE use_case_id IS NOT NULL'
  ).all();
  const insAUC = db.prepare(`
    INSERT OR IGNORE INTO asdlc_agent_use_case
      (agent_use_case_id, agent_spec_id, use_case_id, project_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
  `);
  for (const a of agents) {
    insAUC.run(crypto.randomUUID(), a.agent_spec_id, a.use_case_id, a.project_id);
  }
} catch (err) {
  console.error('[db] agent_use_case backfill failed:', err.message);
}

// ─── Phase 4 data migration: normalize asdlc_use_case.volume_assumptions keys ──
// Legacy seed used { monthly, note, ... }; new editor writes
// { monthly_requests, notes, ... }. Rename legacy keys to the new schema so the
// UC card and edit form don't show duplicate fields. Idempotent — only touches
// rows that still carry the legacy keys.
try {
  const ucs = db.prepare("SELECT use_case_id, volume_assumptions FROM asdlc_use_case").all();
  const upd = db.prepare(`UPDATE asdlc_use_case SET volume_assumptions = ?,
                          updated_at = datetime('now') WHERE use_case_id = ?`);
  for (const uc of ucs) {
    let vol;
    try { vol = JSON.parse(uc.volume_assumptions || '{}'); } catch { continue; }
    if (typeof vol !== 'object' || vol === null || Array.isArray(vol)) continue;
    let changed = false;
    if (vol.monthly !== undefined) {
      if (vol.monthly_requests === undefined) vol.monthly_requests = vol.monthly;
      delete vol.monthly; changed = true;
    }
    if (vol.note !== undefined) {
      if (vol.notes === undefined) vol.notes = vol.note;
      delete vol.note; changed = true;
    }
    if (changed) upd.run(JSON.stringify(vol), uc.use_case_id);
  }
} catch (err) {
  console.error('[db] volume_assumptions normalization failed:', err.message);
}

// ─── Phase 5 seed enrichment: backfill Phase 1 methodology fields where null ──
// Adds risk_tier, owner, primary_success_metric, baseline_cost_annual_usd to
// ACME UCs; risk_tier + runs_per_period + step_type to ACME workflows/steps;
// supervision_model + orchestration_strategy + maintenance_owner + latency_target
// + post_release_validation to every agent that doesn't have them; dev_status
// to every tool that doesn't have it. All updates are idempotent (WHERE col IS NULL).
try {
  // ── UC fields (ACME projects use 33333333-… prefix) ─────────────────────
  const acmeUcs = {
    'Order Operations Automation':       { rt: 'High',   owner: 'Order Operations Lead',  metric: 'Hold resolution: 48h → <8h',          baseline: 420000 },
    'Customer Notification Engine':      { rt: 'Medium', owner: 'CS Operations Manager',  metric: 'Inbound calls: -25%; CSAT +0.4 pts',  baseline: 180000 },
    'Returns & Refunds Processing':      { rt: 'Medium', owner: 'Returns Operations Lead',metric: 'Returns cycle: 5d → <48h',            baseline: 220000 },
  };
  for (const [title, v] of Object.entries(acmeUcs)) {
    db.prepare(`UPDATE asdlc_use_case SET risk_tier = COALESCE(risk_tier, ?), owner = COALESCE(owner, ?),
                primary_success_metric = COALESCE(primary_success_metric, ?),
                baseline_cost_annual_usd = COALESCE(baseline_cost_annual_usd, ?),
                supervision_model = COALESCE(supervision_model, 'Supervised HITL'),
                updated_at = datetime('now')
                WHERE title = ? AND (risk_tier IS NULL OR owner IS NULL OR primary_success_metric IS NULL OR baseline_cost_annual_usd IS NULL OR supervision_model IS NULL)`)
      .run(v.rt, v.owner, v.metric, v.baseline, title);
  }

  // ── Workflow fields ─────────────────────────────────────────────────────
  const wfDefaults = [
    { name: 'WF-014: Held Order Triage',           rt: 'High',   rpp: 500 },
    { name: 'WF-015: Customer Status Notification', rt: 'Medium', rpp: 2000 },
    { name: 'WF-016: Returns & Refund Processing', rt: 'Medium', rpp: 300 },
  ];
  for (const w of wfDefaults) {
    db.prepare(`UPDATE asdlc_workflow
                SET risk_tier = COALESCE(risk_tier, ?), runs_per_period = COALESCE(runs_per_period, ?),
                    updated_at = datetime('now')
                WHERE name = ? AND (risk_tier IS NULL OR runs_per_period IS NULL)`)
      .run(w.rt, w.rpp, w.name);
  }

  // ── Step fields: first step → Start, last step → End, others → Activity ─
  const wfRows = db.prepare(`SELECT workflow_id FROM asdlc_workflow`).all();
  for (const wf of wfRows) {
    const steps = db.prepare(`SELECT workflow_step_id, step_number FROM asdlc_workflow_step
                              WHERE workflow_id = ? ORDER BY step_number`).all(wf.workflow_id);
    if (steps.length === 0) continue;
    for (let i = 0; i < steps.length; i++) {
      let type;
      if (i === 0) type = 'Start';
      else if (i === steps.length - 1) type = 'End';
      else type = 'Activity';
      db.prepare(`UPDATE asdlc_workflow_step
                  SET step_type   = COALESCE(step_type, ?),
                      is_end_step = ?,
                      updated_at  = datetime('now')
                  WHERE workflow_step_id = ? AND (step_type IS NULL OR is_end_step != ?)`)
        .run(type, type === 'End' ? 1 : 0, steps[i].workflow_step_id, type === 'End' ? 1 : 0);
    }
  }

  // ── Agent fields ───────────────────────────────────────────────────────
  db.prepare(`UPDATE asdlc_agent_spec
              SET supervision_model       = COALESCE(supervision_model,       'Supervised HITL'),
                  orchestration_strategy  = COALESCE(orchestration_strategy,  'Base Planner'),
                  maintenance_owner       = COALESCE(maintenance_owner,       'AI Platform Team'),
                  latency_target          = COALESCE(latency_target,          'p95 < 5s'),
                  post_release_validation = COALESCE(post_release_validation,
                      'Verify tool calls succeed against staging fixtures; confirm Work Note output matches schema; review audit log entries for first 50 production runs.'),
                  updated_at = datetime('now')
              WHERE supervision_model IS NULL OR orchestration_strategy IS NULL OR maintenance_owner IS NULL
                 OR latency_target IS NULL OR post_release_validation IS NULL`).run();

  // ── Tool dev_status ────────────────────────────────────────────────────
  db.prepare(`UPDATE asdlc_tool SET dev_status = COALESCE(dev_status, 'Existing'), updated_at = datetime('now')
              WHERE dev_status IS NULL`).run();
} catch (err) {
  console.error('[db] Phase 5 seed enrichment failed:', err.message);
}

// ─── Per-application cost params backfill ───────────────────────────────────
// When the global asdlc_cost_assumption is split into per-Application columns
// (planning + entitlement + pricing), copy the existing global row's values
// onto every project so behaviour is unchanged on first start after the split.
// Idempotent — only updates projects that still carry the ALTER-TABLE defaults
// AND only when a global row actually exists.
try {
  const globalAssumption = db.prepare(
    `SELECT planning_period, periods_per_year, entitlement_enabled, annual_included_assists,
            cost_per_assist, overage_rate
     FROM asdlc_cost_assumption LIMIT 1`
  ).get();
  if (globalAssumption) {
    // Planning + entitlement backfill (only rows that still carry the ALTER defaults).
    db.prepare(`
      UPDATE asdlc_project
         SET planning_period         = ?,
             periods_per_year        = ?,
             entitlement_enabled     = ?,
             annual_included_assists = ?,
             updated_at              = datetime('now')
       WHERE planning_period = 'Monthly'
         AND periods_per_year = 12
         AND entitlement_enabled = 0
         AND annual_included_assists IS NULL
    `).run(
      globalAssumption.planning_period,
      globalAssumption.periods_per_year,
      globalAssumption.entitlement_enabled,
      globalAssumption.annual_included_assists
    );

    // Pricing backfill (cost_per_assist + overage_rate). The ALTER default for
    // cost_per_assist is 0.015 and overage_rate defaults to NULL — treat that
    // pair as "never set" and overwrite with the prior global values.
    if (globalAssumption.cost_per_assist != null) {
      db.prepare(`
        UPDATE asdlc_project
           SET cost_per_assist = ?,
               overage_rate    = COALESCE(overage_rate, ?),
               updated_at      = datetime('now')
         WHERE cost_per_assist = 0.015 AND overage_rate IS NULL
      `).run(globalAssumption.cost_per_assist, globalAssumption.overage_rate);
    }
  }
} catch (err) {
  console.error('[db] per-app cost params backfill failed:', err.message);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Generate a new UUID v4
 * @returns {string}
 */
function generateId() {
  return crypto.randomUUID();
}

/**
 * Read a global app setting. Resolution order: asdlc_app_setting row →
 * environment variable (envVar) → hardcoded fallback.
 * @param {string} key       setting_key in asdlc_app_setting
 * @param {*} fallback       value if neither table nor env provides one
 * @param {string} [envVar]  optional env var name to consult before fallback
 * @returns {string|*}
 */
function getSetting(key, fallback, envVar) {
  try {
    const row = db.prepare('SELECT setting_value FROM asdlc_app_setting WHERE setting_key = ?').get(key);
    if (row && row.setting_value !== null && row.setting_value !== undefined && row.setting_value !== '') {
      return row.setting_value;
    }
  } catch { /* table may not exist on a very old DB — fall through */ }
  if (envVar && process.env[envVar]) return process.env[envVar];
  return fallback;
}

/** Upsert a global app setting. */
function setSetting(key, value, userId) {
  db.prepare(`
    INSERT INTO asdlc_app_setting (setting_key, setting_value, updated_by, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(setting_key) DO UPDATE SET
      setting_value = excluded.setting_value,
      updated_by    = excluded.updated_by,
      updated_at    = datetime('now')
  `).run(key, value === null || value === undefined ? null : String(value), userId || null);
}

/**
 * Write an audit log entry.
 * @param {string} tableName   - DB table that was changed
 * @param {string} recordId    - Primary key value of the changed row
 * @param {string} operation   - 'INSERT' | 'UPDATE' | 'DELETE'
 * @param {object|null} oldData
 * @param {object|null} newData
 * @param {string|null} userId - From X-User-ID header
 */
function auditLog(tableName, recordId, operation, oldData, newData, userId) {
  try {
    db.prepare(`
      INSERT INTO asdlc_audit_log
        (audit_id, table_name, record_id, operation, old_data, new_data, changed_by, changed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      generateId(),
      tableName,
      recordId,
      operation,
      oldData ? JSON.stringify(oldData) : null,
      newData ? JSON.stringify(newData) : null,
      userId || null
    );
  } catch (err) {
    // Audit failures must never crash the main request
    console.error('[auditLog] Failed to write audit entry:', err.message);
  }
}

module.exports = { db, generateId, auditLog, nextSlug, getSetting, setSetting };
