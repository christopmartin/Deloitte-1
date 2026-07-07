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

  // Ingest cross-check: per-project ripple-scan scope ('project' = whole design,
  // 'workflow' = restrict the workflow-bound corpus to connected workflows).
  "ALTER TABLE asdlc_project ADD COLUMN ripple_scan_scope TEXT NOT NULL DEFAULT 'project'",
  // Backlog #2 — link a change packet back to its originating ingest document so
  // Send Back can route the reviewer's reason back as a clarification and re-run extraction.
  "ALTER TABLE asdlc_change_packet ADD COLUMN ingest_id TEXT",
  // Plan D — post-apply consistency check on a change packet: 'clean' | 'flagged' | null
  // (not yet run), with the residual-reference findings JSON for the CP/dashboard banner.
  "ALTER TABLE asdlc_change_packet ADD COLUMN post_apply_status TEXT",
  "ALTER TABLE asdlc_change_packet ADD COLUMN post_apply_findings TEXT",
  // Ingest document soft-cancel / archive (reversible; never hard-deleted)
  "ALTER TABLE asdlc_ingest_document ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'active'",
  "ALTER TABLE asdlc_ingest_document ADD COLUMN cancelled_at TEXT",
  "ALTER TABLE asdlc_ingest_document ADD COLUMN cancelled_by TEXT",
  "ALTER TABLE asdlc_ingest_document ADD COLUMN cancel_reason TEXT",
  // Index must come AFTER the column is added (runs post-schema-exec, so it is
  // safe on both fresh and existing databases).
  "CREATE INDEX IF NOT EXISTS idx_ingest_lifecycle ON asdlc_ingest_document(lifecycle_status)",

  // ── ServiceNow round-trip (Round 2): Level-2 provenance on the REUSED design
  // types so ServiceNow-extracted agents/workflows/tools also carry sys_id
  // identity. Nullable, no default — existing (transcript-sourced) rows stay NULL
  // (= not ServiceNow-sourced). SN-sourced records are identified by source_sys_id.
  "ALTER TABLE asdlc_agent_spec    ADD COLUMN source_system TEXT",
  "ALTER TABLE asdlc_agent_spec    ADD COLUMN source_sys_id TEXT",
  "ALTER TABLE asdlc_agent_spec    ADD COLUMN source_table  TEXT",
  "ALTER TABLE asdlc_agent_spec    ADD COLUMN source_scope  TEXT",
  "ALTER TABLE asdlc_agent_spec    ADD COLUMN source_fluent TEXT",
  "ALTER TABLE asdlc_agent_spec    ADD COLUMN source_hash   TEXT",
  "ALTER TABLE asdlc_tool          ADD COLUMN source_system TEXT",
  "ALTER TABLE asdlc_tool          ADD COLUMN source_sys_id TEXT",
  "ALTER TABLE asdlc_tool          ADD COLUMN source_table  TEXT",
  "ALTER TABLE asdlc_tool          ADD COLUMN source_scope  TEXT",
  "ALTER TABLE asdlc_tool          ADD COLUMN source_fluent TEXT",
  "ALTER TABLE asdlc_tool          ADD COLUMN source_hash   TEXT",
  "ALTER TABLE asdlc_workflow      ADD COLUMN source_system TEXT",
  "ALTER TABLE asdlc_workflow      ADD COLUMN source_sys_id TEXT",
  "ALTER TABLE asdlc_workflow      ADD COLUMN source_table  TEXT",
  "ALTER TABLE asdlc_workflow      ADD COLUMN source_scope  TEXT",
  "ALTER TABLE asdlc_workflow      ADD COLUMN source_fluent TEXT",
  "ALTER TABLE asdlc_workflow      ADD COLUMN source_hash   TEXT",
  "ALTER TABLE asdlc_workflow_step ADD COLUMN source_system TEXT",
  "ALTER TABLE asdlc_workflow_step ADD COLUMN source_sys_id TEXT",
  "ALTER TABLE asdlc_workflow_step ADD COLUMN source_table  TEXT",
  "ALTER TABLE asdlc_workflow_step ADD COLUMN source_scope  TEXT",
  "ALTER TABLE asdlc_workflow_step ADD COLUMN source_fluent TEXT",
  "ALTER TABLE asdlc_workflow_step ADD COLUMN source_hash   TEXT",
  // use_case is a ServiceNow-synced reuse type too (sn_aia_usecase). Without provenance
  // it could not be matched on re-sync and was re-created as a duplicate every sync.
  "ALTER TABLE asdlc_use_case      ADD COLUMN source_system TEXT",
  "ALTER TABLE asdlc_use_case      ADD COLUMN source_sys_id TEXT",
  "ALTER TABLE asdlc_use_case      ADD COLUMN source_table  TEXT",
  "ALTER TABLE asdlc_use_case      ADD COLUMN source_scope  TEXT",
  "ALTER TABLE asdlc_use_case      ADD COLUMN source_fluent TEXT",
  "ALTER TABLE asdlc_use_case      ADD COLUMN source_hash   TEXT",
  "CREATE INDEX IF NOT EXISTS idx_agent_sysid ON asdlc_agent_spec(source_sys_id)",
  "CREATE INDEX IF NOT EXISTS idx_tool_sysid  ON asdlc_tool(source_sys_id)",
  "CREATE INDEX IF NOT EXISTS idx_wf_sysid    ON asdlc_workflow(source_sys_id)",
  "CREATE INDEX IF NOT EXISTS idx_step_sysid  ON asdlc_workflow_step(source_sys_id)",
  "CREATE INDEX IF NOT EXISTS idx_usecase_sysid ON asdlc_use_case(source_sys_id)",

  // ── Per-item decisions on change packets ─────────────────────────────────────
  // Product owners can individually approve or reject CP items (rather than only
  // approving/rejecting the whole packet at once). 'pending' = no decision yet
  // (= Keep on List). Applied items also get item_status='approved'.
  "ALTER TABLE asdlc_change_packet_item ADD COLUMN item_status TEXT NOT NULL DEFAULT 'pending'",
  "ALTER TABLE asdlc_change_packet_item ADD COLUMN item_decision_notes TEXT",
  "ALTER TABLE asdlc_change_packet_item ADD COLUMN item_decided_by TEXT",
  "ALTER TABLE asdlc_change_packet_item ADD COLUMN item_decided_at TEXT",

  // ── Change-packet origin (ServiceNow round-trip Phase 2 OUTBOUND) ────────────
  // Distinguishes CPs that came FROM ServiceNow (inbound sync) from Workbench-authored
  // CPs (manual edits, document ingestion). The outbound SN delta export must NEVER
  // push inbound-origin CPs back to ServiceNow — that content originated in SN, so
  // pushing it back is a redundant/destructive round-trip. NULL = Workbench-origin
  // (outbound-eligible); 'sn_inbound' = came from a ServiceNow sync (excluded outbound).
  "ALTER TABLE asdlc_change_packet ADD COLUMN cp_origin TEXT",
  // One-time idempotent backfill for CPs created before this column existed. A CP is
  // inbound-origin if its summary is the deterministic 'SN to WB synch …' label OR any
  // of its items carry the deterministic '[SN sync ·' rationale prefix (set by the sync
  // orchestrator for drift/new/changed items). Runs every boot but only ever touches
  // still-NULL rows matching those signals, so it converges and is safe to re-run.
  "UPDATE asdlc_change_packet SET cp_origin = 'sn_inbound' " +
    "WHERE cp_origin IS NULL AND (" +
    "summary LIKE 'SN to WB synch%' " +
    "OR change_packet_id IN (SELECT DISTINCT change_packet_id FROM asdlc_change_packet_item WHERE rationale LIKE '[SN sync %'))",

  // ── ServiceNow round-trip (Round 2): Application ↔ ServiceNow app link on the
  // project, so a Workbench Application can be created/linked to a scoped app and
  // re-synced. sn_last_synced_at is stamped after each successful extraction ingest.
  "ALTER TABLE asdlc_project ADD COLUMN servicenow_scope TEXT",
  "ALTER TABLE asdlc_project ADD COLUMN servicenow_sys_app_id TEXT",
  "ALTER TABLE asdlc_project ADD COLUMN servicenow_instance TEXT",
  "ALTER TABLE asdlc_project ADD COLUMN sn_last_synced_at TEXT",
  "CREATE INDEX IF NOT EXISTS idx_project_sn_sysapp ON asdlc_project(servicenow_sys_app_id)",

  // ── Core design elements (feat/core-design-elements) ─────────────────────────
  // business_logic gains a thin FR/NFR traceability link (the "how" elaborates the
  // "what"), mirroring asdlc_user_story.requirement_refs. JSON slug array; optional.
  "ALTER TABLE asdlc_business_logic ADD COLUMN requirement_refs TEXT NOT NULL DEFAULT '[]'",
  // Reverse-path materiality config (per Application). When reverse-engineering a live
  // ServiceNow app, only logic that clears these bars becomes a Level-1 design row; the
  // rest is captured-but-not-elevated. min_confidence falls back to confidence_threshold
  // when NULL; disallow_types is a JSON array of logic_types to skip before inference.
  "ALTER TABLE asdlc_project ADD COLUMN materiality_min_confidence REAL",
  "ALTER TABLE asdlc_project ADD COLUMN materiality_disallow_types TEXT NOT NULL DEFAULT '[]'",

  // ── DB audit fix: ingest_feedback source_agent column ────────────────────────
  // reviewer_id was overloaded — real user UUIDs mixed with system-agent labels
  // like 'sn-extract' and 'sn-sync-live'. New column holds the agent label so
  // reviewer_id is a clean FK to asdlc_user. Backfill handled in DATA_MIGRATIONS.
  "ALTER TABLE asdlc_ingest_feedback ADD COLUMN source_agent TEXT",

  // ── Faithful↔Suggestive ingest dial (WS1) ────────────────────────────────────
  // Per-ingest AI mode: faithful (transcribe only) | balanced (fill implied empty
  // fields) | suggestive (also propose best-practice / implied net-new elements,
  // flagged system_generated). Net-new INFERRED entities carry system_generated=1
  // on the design table so the Design Review can distinguish AI-suggested rows.
  "ALTER TABLE asdlc_ingest_document ADD COLUMN enrichment_level TEXT NOT NULL DEFAULT 'faithful'",
  "ALTER TABLE asdlc_nonfunctional_req ADD COLUMN system_generated INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE asdlc_use_case          ADD COLUMN system_generated INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE asdlc_workflow           ADD COLUMN system_generated INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE asdlc_workflow_step      ADD COLUMN system_generated INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE asdlc_tool               ADD COLUMN system_generated INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE asdlc_data_source        ADD COLUMN system_generated INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE asdlc_agent_spec         ADD COLUMN system_generated INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE asdlc_functional_req     ADD COLUMN system_generated INTEGER NOT NULL DEFAULT 0",

  // ── Standing cost questions: extend best_practice with practice_type ──────────
  // 'rule' = existing extraction rule injected into AI prompts
  // 'question' = standing question surfaced to product owners during ingest review
  "ALTER TABLE asdlc_best_practice ADD COLUMN practice_type TEXT NOT NULL DEFAULT 'rule'",

  // ── Platform tagging: scope AI Guidance + ingest to a target platform ────────
  // target_platform = the application's default platform; a per-document `platform`
  // overrides it; best-practice `platform` ('any' = applies regardless) lets a rule
  // apply only to matching work. 'any'/'servicenow' defaults keep all pre-existing
  // rules and projects working without reconfiguration.
  "ALTER TABLE asdlc_project          ADD COLUMN target_platform TEXT NOT NULL DEFAULT 'servicenow'",
  "ALTER TABLE asdlc_ingest_document  ADD COLUMN platform TEXT",
  "ALTER TABLE asdlc_best_practice    ADD COLUMN platform TEXT NOT NULL DEFAULT 'any'",

  // ── Per-project ServiceNow credentials ───────────────────────────────────────
  // Credentials are per-project so each Application can target a different SN
  // instance with its own login. sn_password_enc is AES-256-GCM encrypted by
  // crypto-util.js using ASDLC_ENCRYPT_KEY; sn_user is stored in plaintext.
  // Absent = fall back to SN_USER / SN_PASSWORD environment variables.
  "ALTER TABLE asdlc_project ADD COLUMN sn_user TEXT",
  "ALTER TABLE asdlc_project ADD COLUMN sn_password_enc TEXT",

  // ── ServiceNow instance assessment / fit analysis (Phase 0, read-only) ────────
  // One row per assessment run. report_json holds the full fit analysis (version,
  // capability matrix, scope census, coverage map, volume/cost, capacity verdict,
  // recommended import profile). status: running|complete|failed. History kept.
  `CREATE TABLE IF NOT EXISTS asdlc_sn_assessment (
     assessment_id TEXT PRIMARY KEY,
     project_id    TEXT REFERENCES asdlc_project(project_id),
     instance_url  TEXT,
     scopes_json   TEXT NOT NULL DEFAULT '[]',
     status        TEXT NOT NULL DEFAULT 'running',
     report_json   TEXT,
     summary       TEXT,
     error         TEXT,
     created_by    TEXT,
     created_at    TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  "CREATE INDEX IF NOT EXISTS idx_sn_assessment_project ON asdlc_sn_assessment(project_id, created_at)",

  // ── ServiceNow whole-instance catalog (read-only awareness sweep) ─────────────
  // One row per cross-scope identity-only sweep. catalog_json holds the full snapshot
  // ({surfaces:{table:[{sys_id,name,scope,…}]}, warnings}); summary_json the per-surface
  // counts (always returned; catalog_json gated behind ?full=1). capturing_user records
  // WHO swept it (ACL-completeness context). status: running|complete|failed. History kept.
  `CREATE TABLE IF NOT EXISTS asdlc_sn_catalog_run (
     catalog_run_id TEXT PRIMARY KEY,
     project_id     TEXT REFERENCES asdlc_project(project_id),
     instance_url   TEXT,
     capturing_user TEXT,
     status         TEXT NOT NULL DEFAULT 'running',
     catalog_json   TEXT,
     summary_json   TEXT,
     error          TEXT,
     created_by     TEXT,
     created_at     TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  "CREATE INDEX IF NOT EXISTS idx_sn_catalog_project ON asdlc_sn_catalog_run(project_id, created_at)",

  // ── Materialize core design elements from BRD ingest ─────────────────────────
  // Guardrails + data sources become first-class design rows; user stories get a
  // thin traceability home (narrative + requirement_refs slugs, no duplicated AC
  // content). Mirrors the CREATE TABLEs in schema.sql so existing DBs get them too.
  // No CHECK constraints on enum columns — never crash materialization on model output.
  `CREATE TABLE IF NOT EXISTS asdlc_guardrail (
     guardrail_id TEXT PRIMARY KEY,
     project_id TEXT REFERENCES asdlc_project(project_id),
     ingest_id TEXT REFERENCES asdlc_ingest_document(ingest_id),
     slug TEXT,
     rule_name TEXT NOT NULL,
     rule_text TEXT NOT NULL DEFAULT '',
     severity TEXT NOT NULL DEFAULT 'medium',
     applies_to TEXT,
     threshold_value TEXT,
     threshold_unit TEXT,
     regulatory_reference TEXT,
     action_if_triggered TEXT,
     visibility_scope TEXT NOT NULL DEFAULT 'PROJECT',
     lifecycle_status TEXT NOT NULL DEFAULT 'active',
     created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_by TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
     version INTEGER NOT NULL DEFAULT 1
   )`,
  `CREATE TABLE IF NOT EXISTS asdlc_data_source (
     data_source_id TEXT PRIMARY KEY,
     project_id TEXT REFERENCES asdlc_project(project_id),
     ingest_id TEXT REFERENCES asdlc_ingest_document(ingest_id),
     slug TEXT,
     source_name TEXT NOT NULL,
     source_type TEXT NOT NULL DEFAULT 'other',
     description TEXT NOT NULL DEFAULT '',
     access_type TEXT,
     access_requirements TEXT NOT NULL DEFAULT '[]',
     contains_pii INTEGER NOT NULL DEFAULT 0,
     rate_limits TEXT,
     visibility_scope TEXT NOT NULL DEFAULT 'PROJECT',
     lifecycle_status TEXT NOT NULL DEFAULT 'active',
     created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_by TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
     version INTEGER NOT NULL DEFAULT 1
   )`,
  `CREATE TABLE IF NOT EXISTS asdlc_user_story (
     user_story_id TEXT PRIMARY KEY,
     project_id TEXT REFERENCES asdlc_project(project_id),
     ingest_id TEXT REFERENCES asdlc_ingest_document(ingest_id),
     slug TEXT,
     role TEXT NOT NULL DEFAULT '',
     want TEXT NOT NULL DEFAULT '',
     so_that TEXT NOT NULL DEFAULT '',
     priority TEXT,
     requirement_refs TEXT NOT NULL DEFAULT '[]',
     visibility_scope TEXT NOT NULL DEFAULT 'PROJECT',
     lifecycle_status TEXT NOT NULL DEFAULT 'active',
     created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_by TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
     version INTEGER NOT NULL DEFAULT 1
   )`,
  // ── Config-driven Tier-A design entities (Information Layer + NL rules) ───────
  // Mirror the CREATE TABLEs in schema.sql so existing DBs get them too. No CHECK
  // constraints on enum columns — never crash materialization on model output.
  `CREATE TABLE IF NOT EXISTS asdlc_dashboard (
     dashboard_id TEXT PRIMARY KEY,
     project_id TEXT REFERENCES asdlc_project(project_id),
     slug TEXT, name TEXT NOT NULL, purpose TEXT, audience TEXT,
     widgets TEXT NOT NULL DEFAULT '[]', refresh TEXT,
     source_system TEXT NOT NULL DEFAULT 'servicenow',
     source_sys_id TEXT, source_table TEXT, source_scope TEXT, source_fluent TEXT, source_hash TEXT,
     visibility_scope TEXT NOT NULL DEFAULT 'PROJECT', lifecycle_status TEXT NOT NULL DEFAULT 'active',
     created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_by TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')), version INTEGER NOT NULL DEFAULT 1
   )`,
  `CREATE TABLE IF NOT EXISTS asdlc_report (
     report_id TEXT PRIMARY KEY,
     project_id TEXT REFERENCES asdlc_project(project_id),
     slug TEXT, name TEXT NOT NULL, purpose TEXT, reported_table TEXT,
     report_columns TEXT NOT NULL DEFAULT '[]', filters TEXT, format TEXT,
     source_system TEXT NOT NULL DEFAULT 'servicenow',
     source_sys_id TEXT, source_table TEXT, source_scope TEXT, source_fluent TEXT, source_hash TEXT,
     visibility_scope TEXT NOT NULL DEFAULT 'PROJECT', lifecycle_status TEXT NOT NULL DEFAULT 'active',
     created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_by TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')), version INTEGER NOT NULL DEFAULT 1
   )`,
  `CREATE TABLE IF NOT EXISTS asdlc_kpi (
     kpi_id TEXT PRIMARY KEY,
     project_id TEXT REFERENCES asdlc_project(project_id),
     slug TEXT, name TEXT NOT NULL, metric TEXT, unit TEXT, target TEXT,
     direction TEXT, frequency TEXT, data_source TEXT,
     source_system TEXT NOT NULL DEFAULT 'servicenow',
     source_sys_id TEXT, source_table TEXT, source_scope TEXT, source_fluent TEXT, source_hash TEXT,
     visibility_scope TEXT NOT NULL DEFAULT 'PROJECT', lifecycle_status TEXT NOT NULL DEFAULT 'active',
     created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_by TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')), version INTEGER NOT NULL DEFAULT 1
   )`,
  `CREATE TABLE IF NOT EXISTS asdlc_nl_rule (
     nl_rule_id TEXT PRIMARY KEY,
     project_id TEXT REFERENCES asdlc_project(project_id),
     slug TEXT, rule_kind TEXT NOT NULL DEFAULT 'business', name TEXT NOT NULL,
     rule_text TEXT, linked_table TEXT, linked_field TEXT, linked_workflow TEXT,
     status TEXT NOT NULL DEFAULT 'authored', rationale TEXT, confidence REAL,
     source_system TEXT NOT NULL DEFAULT 'workbench',
     source_sys_id TEXT, source_table TEXT, source_scope TEXT, source_fluent TEXT, source_hash TEXT,
     visibility_scope TEXT NOT NULL DEFAULT 'PROJECT', lifecycle_status TEXT NOT NULL DEFAULT 'active',
     created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_by TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')), version INTEGER NOT NULL DEFAULT 1
   )`,
  `CREATE TABLE IF NOT EXISTS asdlc_sla_definition (
     sla_definition_id TEXT PRIMARY KEY,
     project_id TEXT REFERENCES asdlc_project(project_id),
     slug TEXT, name TEXT NOT NULL,
     applies_to TEXT, sla_type TEXT, target TEXT, start_condition TEXT, stop_condition TEXT, schedule TEXT,
     source_system TEXT NOT NULL DEFAULT 'servicenow',
     source_sys_id TEXT, source_table TEXT, source_scope TEXT, source_fluent TEXT, source_hash TEXT,
     visibility_scope TEXT NOT NULL DEFAULT 'PROJECT', lifecycle_status TEXT NOT NULL DEFAULT 'active',
     created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_by TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')), version INTEGER NOT NULL DEFAULT 1
   )`,
  `CREATE TABLE IF NOT EXISTS asdlc_email_notification (
     email_notification_id TEXT PRIMARY KEY,
     project_id TEXT REFERENCES asdlc_project(project_id),
     slug TEXT, name TEXT NOT NULL,
     trigger_event TEXT, recipients TEXT, applies_to TEXT, subject TEXT, body_summary TEXT,
     source_system TEXT NOT NULL DEFAULT 'servicenow',
     source_sys_id TEXT, source_table TEXT, source_scope TEXT, source_fluent TEXT, source_hash TEXT,
     visibility_scope TEXT NOT NULL DEFAULT 'PROJECT', lifecycle_status TEXT NOT NULL DEFAULT 'active',
     created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_by TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')), version INTEGER NOT NULL DEFAULT 1
   )`,
  `CREATE TABLE IF NOT EXISTS asdlc_user_group (
     user_group_id TEXT PRIMARY KEY,
     project_id TEXT REFERENCES asdlc_project(project_id),
     slug TEXT, name TEXT NOT NULL,
     purpose TEXT, members TEXT, roles_granted TEXT NOT NULL DEFAULT '[]', manager TEXT,
     source_system TEXT NOT NULL DEFAULT 'servicenow',
     source_sys_id TEXT, source_table TEXT, source_scope TEXT, source_fluent TEXT, source_hash TEXT,
     visibility_scope TEXT NOT NULL DEFAULT 'PROJECT', lifecycle_status TEXT NOT NULL DEFAULT 'active',
     created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_by TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')), version INTEGER NOT NULL DEFAULT 1
   )`,
  `CREATE TABLE IF NOT EXISTS asdlc_catalog_category (
     catalog_category_id TEXT PRIMARY KEY,
     project_id TEXT REFERENCES asdlc_project(project_id),
     slug TEXT, name TEXT NOT NULL,
     description TEXT, catalog TEXT, parent_category TEXT,
     source_system TEXT NOT NULL DEFAULT 'servicenow',
     source_sys_id TEXT, source_table TEXT, source_scope TEXT, source_fluent TEXT, source_hash TEXT,
     visibility_scope TEXT NOT NULL DEFAULT 'PROJECT', lifecycle_status TEXT NOT NULL DEFAULT 'active',
     created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_by TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')), version INTEGER NOT NULL DEFAULT 1
   )`,
  `CREATE TABLE IF NOT EXISTS asdlc_choice_set (
     choice_set_id TEXT PRIMARY KEY,
     project_id TEXT REFERENCES asdlc_project(project_id),
     slug TEXT, name TEXT NOT NULL,
     applies_to TEXT, choices TEXT NOT NULL DEFAULT '[]', default_value TEXT,
     source_system TEXT NOT NULL DEFAULT 'servicenow',
     source_sys_id TEXT, source_table TEXT, source_scope TEXT, source_fluent TEXT, source_hash TEXT,
     visibility_scope TEXT NOT NULL DEFAULT 'PROJECT', lifecycle_status TEXT NOT NULL DEFAULT 'active',
     created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_by TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')), version INTEGER NOT NULL DEFAULT 1
   )`,
  // Wave 3 nested entities (children stored as JSON arrays)
  `CREATE TABLE IF NOT EXISTS asdlc_service_portal (
     service_portal_id TEXT PRIMARY KEY,
     project_id TEXT REFERENCES asdlc_project(project_id),
     slug TEXT, name TEXT NOT NULL, title TEXT, homepage TEXT, theme TEXT, purpose TEXT,
     pages TEXT NOT NULL DEFAULT '[]',
     source_system TEXT NOT NULL DEFAULT 'servicenow',
     source_sys_id TEXT, source_table TEXT, source_scope TEXT, source_fluent TEXT, source_hash TEXT,
     visibility_scope TEXT NOT NULL DEFAULT 'PROJECT', lifecycle_status TEXT NOT NULL DEFAULT 'active',
     created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_by TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')), version INTEGER NOT NULL DEFAULT 1
   )`,
  `CREATE TABLE IF NOT EXISTS asdlc_workspace (
     workspace_id TEXT PRIMARY KEY,
     project_id TEXT REFERENCES asdlc_project(project_id),
     slug TEXT, name TEXT NOT NULL, purpose TEXT, primary_table TEXT,
     lists TEXT NOT NULL DEFAULT '[]',
     source_system TEXT NOT NULL DEFAULT 'servicenow',
     source_sys_id TEXT, source_table TEXT, source_scope TEXT, source_fluent TEXT, source_hash TEXT,
     visibility_scope TEXT NOT NULL DEFAULT 'PROJECT', lifecycle_status TEXT NOT NULL DEFAULT 'active',
     created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_by TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')), version INTEGER NOT NULL DEFAULT 1
   )`,
  `CREATE TABLE IF NOT EXISTS asdlc_variable_set (
     variable_set_id TEXT PRIMARY KEY,
     project_id TEXT REFERENCES asdlc_project(project_id),
     slug TEXT, name TEXT NOT NULL, purpose TEXT, applies_to TEXT,
     variables TEXT NOT NULL DEFAULT '[]',
     source_system TEXT NOT NULL DEFAULT 'servicenow',
     source_sys_id TEXT, source_table TEXT, source_scope TEXT, source_fluent TEXT, source_hash TEXT,
     visibility_scope TEXT NOT NULL DEFAULT 'PROJECT', lifecycle_status TEXT NOT NULL DEFAULT 'active',
     created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_by TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')), version INTEGER NOT NULL DEFAULT 1
   )`,
  `CREATE TABLE IF NOT EXISTS asdlc_inbound_rest_api (
     inbound_rest_api_id TEXT PRIMARY KEY,
     project_id TEXT REFERENCES asdlc_project(project_id),
     slug TEXT, name TEXT NOT NULL, base_path TEXT, auth TEXT, purpose TEXT,
     resources TEXT NOT NULL DEFAULT '[]',
     source_system TEXT NOT NULL DEFAULT 'servicenow',
     source_sys_id TEXT, source_table TEXT, source_scope TEXT, source_fluent TEXT, source_hash TEXT,
     visibility_scope TEXT NOT NULL DEFAULT 'PROJECT', lifecycle_status TEXT NOT NULL DEFAULT 'active',
     created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_by TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')), version INTEGER NOT NULL DEFAULT 1
   )`,

  // Tool-call audit log
  `CREATE TABLE IF NOT EXISTS asdlc_tool_call_log (
     call_id TEXT PRIMARY KEY, source TEXT NOT NULL, tool_name TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_tool_call_source ON asdlc_tool_call_log(source, created_at)`,

  // ── Generic SN artifact substrate (back-link from L1 projections) ────────────
  // Each Level-1 SN-technical row that surfaces a generic artifact carries a nullable
  // FK to it. Existing rows stay NULL (= no generic twin yet); the Phase-2 backfill
  // creates one artifact per provenance-bearing L1 row and sets this. The tables
  // asdlc_sn_artifact + asdlc_sn_type_registry themselves are created in schema.sql
  // (IF NOT EXISTS, so safe on fresh + existing DBs).
  "ALTER TABLE asdlc_data_model     ADD COLUMN sn_artifact_id TEXT",
  "ALTER TABLE asdlc_form_design    ADD COLUMN sn_artifact_id TEXT",
  "ALTER TABLE asdlc_business_logic ADD COLUMN sn_artifact_id TEXT",
  "ALTER TABLE asdlc_catalog_item   ADD COLUMN sn_artifact_id TEXT",
  "ALTER TABLE asdlc_integration    ADD COLUMN sn_artifact_id TEXT",

  // ── Slice-scoped ingest: one editable "import profile" per project ────────────
  // Bounds an ingest to a SLICE of a scope instead of the whole scope. Stored as JSON:
  //   { scope, include_types[], include_surfaces[], per_surface_cap|null, record_filters{} }
  // include_surfaces (SN tables) is the operative field the capture reads; record_filters is
  // reserved for a future record-level narrowing (encoded query per surface) and unused today.
  // NULL / absent = capture the WHOLE scope (unchanged legacy behavior).
  "ALTER TABLE asdlc_project ADD COLUMN sn_import_profile_json TEXT",

  // ── Build Spec export stamping ────────────────────────────────────────────────
  // Track when a Build Spec was last generated so the delta-export mode knows
  // which entity rows to include (only those updated after the last export timestamp).
  "ALTER TABLE asdlc_project ADD COLUMN last_build_spec_generated_at TEXT",
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
  // ServiceNow round-trip: Level-1 design tables
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_slug   ON asdlc_data_model(project_id, slug)      WHERE slug IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_form_slug ON asdlc_form_design(project_id, slug)     WHERE slug IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_bl_slug   ON asdlc_business_logic(project_id, slug)  WHERE slug IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_cat_slug  ON asdlc_catalog_item(project_id, slug)    WHERE slug IS NOT NULL",
  // Materialized BRD design elements
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_gr_slug  ON asdlc_guardrail(project_id, slug)    WHERE slug IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_ds_slug  ON asdlc_data_source(project_id, slug)  WHERE slug IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_us_slug  ON asdlc_user_story(project_id, slug)   WHERE slug IS NOT NULL",
  // Config-driven Tier-A entities (Information Layer + NL rules)
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_dash_slug ON asdlc_dashboard(project_id, slug)   WHERE slug IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_rpt_slug  ON asdlc_report(project_id, slug)      WHERE slug IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_kpi_slug  ON asdlc_kpi(project_id, slug)         WHERE slug IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_nlr_slug  ON asdlc_nl_rule(project_id, slug)     WHERE slug IS NOT NULL",
  // Wave 2 flat config entities
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_sla_slug   ON asdlc_sla_definition(project_id, slug)    WHERE slug IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_slug ON asdlc_email_notification(project_id, slug) WHERE slug IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_grp_slug   ON asdlc_user_group(project_id, slug)        WHERE slug IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_catg_slug  ON asdlc_catalog_category(project_id, slug)  WHERE slug IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_cho_slug   ON asdlc_choice_set(project_id, slug)        WHERE slug IS NOT NULL",
  // Wave 3 nested entities
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_slug ON asdlc_service_portal(project_id, slug)   WHERE slug IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_ws_slug2    ON asdlc_workspace(project_id, slug)        WHERE slug IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_vset_slug   ON asdlc_variable_set(project_id, slug)     WHERE slug IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_api_slug    ON asdlc_inbound_rest_api(project_id, slug) WHERE slug IS NOT NULL",
];
for (const idx of SLUG_INDEXES) {
  try { db.exec(idx); } catch (err) { console.error('[db] slug index failed:', err.message); }
}

// ─── Phase 1 data migrations ────────────────────────────────────────────────
// Decision #2: migrate UC supervision_model 'Assisted' → 'Supervised HITL'.
// Run before any backfill so the 3-value enum is canonical.
const DATA_MIGRATIONS = [
  "UPDATE asdlc_use_case SET supervision_model = 'Supervised HITL' WHERE supervision_model = 'Assisted'",

  // ── DB audit fixes (2026-06-09) ──────────────────────────────────────────
  // Fix 3a: move system-agent labels out of reviewer_id into source_agent
  `UPDATE asdlc_ingest_feedback
   SET source_agent = reviewer_id, reviewer_id = NULL
   WHERE reviewer_id NOT IN (SELECT user_id FROM asdlc_user)
     AND reviewer_id IS NOT NULL`,

  // Fix 3b: null orphaned extraction_id values (extractions deleted by send-back flow)
  `UPDATE asdlc_ingest_feedback
   SET extraction_id = NULL
   WHERE extraction_id IS NOT NULL
     AND extraction_id NOT IN (SELECT extraction_id FROM asdlc_ingest_extraction)`,

  // Fix 4: delete placeholder ai_usage rows from dev/test seeding
  `DELETE FROM asdlc_ai_usage WHERE project_id IN ('proj-a','proj-b','proj-c')`,

  // Fix 5b: normalize 'agent' → 'agent_spec' in test_case.scope and exception.related_entity_type
  `UPDATE asdlc_test_case SET scope = 'agent_spec' WHERE scope = 'agent'`,
  `UPDATE asdlc_exception SET related_entity_type = 'agent_spec' WHERE related_entity_type = 'agent'`,

  // Fix 1a: reset stuck CPI applied_at — items marked 'supporting evidence' when their
  // entity type was not yet materializable; registry has since made them materializable,
  // so the items need to be re-processed. Call POST /repair-stuck-cpis after deploy.
  `UPDATE asdlc_change_packet_item
   SET applied_at = NULL,
       rationale  = TRIM(REPLACE(COALESCE(rationale,''), '[captured as supporting evidence — no design table for this type]', ''))
   WHERE applied_at IS NOT NULL
     AND entity_type IN ('guardrail','data_source','business_logic','catalog_item','data_model','form_design')
     AND rationale LIKE '%no design table for this type%'`,

  // Fix 2b: mark acceptance criteria whose user_story parent never materialised as orphaned
  `UPDATE asdlc_acceptance_criterion
   SET lifecycle_status = 'orphaned'
   WHERE parent_type = 'user_story'
     AND parent_id NOT IN (SELECT user_story_id FROM asdlc_user_story)`,

  // Fix 6: delete the retired duplicate 'Supplier Master Lookup' tool (T-004, created earlier)
  `DELETE FROM asdlc_tool WHERE tool_id = '57934861-1e84-401c-a545-71deb9519965'`,
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
  // ServiceNow round-trip: Level-1 design tables
  { table: 'asdlc_data_model',        pk: 'data_model_id',     prefix: 'DM'   },
  { table: 'asdlc_form_design',       pk: 'form_design_id',    prefix: 'FORM' },
  { table: 'asdlc_business_logic',    pk: 'business_logic_id', prefix: 'BL'   },
  { table: 'asdlc_catalog_item',      pk: 'catalog_item_id',   prefix: 'CAT'  },
  // Materialized BRD design elements
  { table: 'asdlc_guardrail',         pk: 'guardrail_id',      prefix: 'GR'   },
  { table: 'asdlc_data_source',       pk: 'data_source_id',    prefix: 'DS'   },
  { table: 'asdlc_user_story',        pk: 'user_story_id',     prefix: 'US'   },
  // Config-driven Tier-A entities (Information Layer + NL rules)
  { table: 'asdlc_dashboard',         pk: 'dashboard_id',      prefix: 'DASH' },
  { table: 'asdlc_report',            pk: 'report_id',         prefix: 'RPT'  },
  { table: 'asdlc_kpi',               pk: 'kpi_id',            prefix: 'KPI'  },
  { table: 'asdlc_nl_rule',           pk: 'nl_rule_id',        prefix: 'NLR'  },
  { table: 'asdlc_sla_definition',    pk: 'sla_definition_id', prefix: 'SLA'  },
  { table: 'asdlc_email_notification',pk: 'email_notification_id', prefix: 'NOTIF' },
  { table: 'asdlc_user_group',        pk: 'user_group_id',     prefix: 'GRP'  },
  { table: 'asdlc_catalog_category',  pk: 'catalog_category_id', prefix: 'CATG' },
  { table: 'asdlc_choice_set',        pk: 'choice_set_id',     prefix: 'CHO'  },
  { table: 'asdlc_service_portal',    pk: 'service_portal_id', prefix: 'PORTAL' },
  { table: 'asdlc_workspace',         pk: 'workspace_id',      prefix: 'WS'   },
  { table: 'asdlc_variable_set',      pk: 'variable_set_id',   prefix: 'VSET' },
  { table: 'asdlc_inbound_rest_api',  pk: 'inbound_rest_api_id', prefix: 'API' },
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

// ─── Standing Questions seed ─────────────────────────────────────────────────
// Pre-seed two project-scoped cost clarification questions. Check by title so
// this block is idempotent on every server start.
try {
  const existing1 = db.prepare("SELECT 1 FROM asdlc_best_practice WHERE title='Workflow run volume'").get();
  if (!existing1) {
    db.prepare(`
      INSERT INTO asdlc_best_practice
        (best_practice_id, scope, title, rule_text, practice_type, is_active, sort_order, source, created_at, updated_at)
      VALUES (?,?,?,?,?,1,?,?,datetime('now'),datetime('now'))
    `).run(
      crypto.randomUUID(),
      'workflow',
      'Workflow run volume',
      "Approximately how many times per planning period will workflows in this application run? (Required for AI cost projection — enter a number, e.g. '50')",
      'question',
      10,
      'system'
    );
    console.log('[db] seeded standing question: Workflow run volume');
  }

  const existing2 = db.prepare("SELECT 1 FROM asdlc_best_practice WHERE title='Agent cost model'").get();
  if (!existing2) {
    db.prepare(`
      INSERT INTO asdlc_best_practice
        (best_practice_id, scope, title, rule_text, practice_type, is_active, sort_order, source, created_at, updated_at)
      VALUES (?,?,?,?,?,1,?,?,datetime('now'),datetime('now'))
    `).run(
      crypto.randomUUID(),
      'agent_spec',
      'Agent cost model',
      "Should the agents in this application use ServiceNow Now Assist for cost tracking? Answer 'yes' to enable cost projection on all agents, or 'no' if a different billing model applies.",
      'question',
      20,
      'system'
    );
    console.log('[db] seeded standing question: Agent cost model');
  }
} catch (err) {
  console.error('[db] standing questions seed failed:', err.message);
}

// ─── ServiceNow design-heuristic rules seed ──────────────────────────────────
// Seed an EDITABLE starter set of platform='servicenow' house rules so ingest is
// ServiceNow-aware out of the box (the AI Guidance tab consumes these on every
// platform=servicenow ingest). Idempotent + curation-safe: only seeds when NO
// system-authored ServiceNow rule exists yet, so user edits/deletions survive restart.
try {
  const snSeeded = db.prepare("SELECT 1 FROM asdlc_best_practice WHERE platform='servicenow' AND source='system' LIMIT 1").get();
  if (!snSeeded) {
    const SN_RULES = [
      ['global', 'ServiceNow: intake → Catalog Item',
       'On ServiceNow, model every user-facing request or intake as a Service Catalog Item or Record Producer with typed variables, and link it to the workflow that fulfils the request.'],
      ['global', 'ServiceNow: data change → Business Rule',
       'Represent server-side data mutations and side-effects-on-save as Business Rules (before/after/async) on the relevant table; record the table and the trigger condition.'],
      ['global', 'ServiceNow: field behaviour → UI Policy',
       'Represent dynamic field behaviour (show/hide, mandatory, read-only) as a UI Policy on the form — not as free-text process steps.'],
      ['global', 'ServiceNow: access control → ACL',
       'Represent record/field access restrictions as ACLs (table/field, operation, role or condition), captured as a guardrail or governance control rather than prose.'],
      ['global', 'ServiceNow: integration → IntegrationHub / REST',
       'Model each external integration as an IntegrationHub spoke or scripted REST step, captured as a tool with its inputs, outputs, and authentication / access requirements.'],
      ['global', 'ServiceNow: work record → extend Task',
       'When a record represents trackable / assignable work, model it as extending the Task table (sys_task) and inheriting its state model unless told otherwise.'],
      ['global', 'ServiceNow: user alert → Notification record',
       'Represent user notifications as Notification records triggered by a named event or condition — not as ad-hoc workflow steps.'],
      ['global', 'ServiceNow: orchestration → Flow Designer',
       'Model multi-step orchestration and approvals as Flow Designer flows / subflows with an explicit trigger, stages, and approval actions; surface approvals as HITL gates.'],
    ];
    const insSn = db.prepare(`
      INSERT INTO asdlc_best_practice
        (best_practice_id, scope, platform, title, rule_text, practice_type, is_active, sort_order, source, created_at, updated_at)
      VALUES (?,?, 'servicenow', ?,?, 'rule', 1, ?, 'system', datetime('now'), datetime('now'))
    `);
    SN_RULES.forEach((r, i) => insSn.run(crypto.randomUUID(), r[0], r[1], r[2], 100 + i));
    console.log(`[db] seeded ${SN_RULES.length} ServiceNow design-heuristic rules (platform=servicenow)`);
  }
} catch (err) {
  console.error('[db] ServiceNow design rules seed failed:', err.message);
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
