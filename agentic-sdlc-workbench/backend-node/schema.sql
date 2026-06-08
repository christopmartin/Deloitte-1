-- PGlite-compatible schema for Agentic SDLC Workbench
-- Uses TEXT for UUIDs (PGlite gen_random_uuid compatibility)
-- Uses TEXT for ENUM-like columns (PGlite compatibility)
-- Skips RLS (enforced at application layer for prototype)
-- Skips complex triggers (auditing done in JS middleware)

-- ============================================================
-- WORKSPACE & ACCESS
-- ============================================================

CREATE TABLE IF NOT EXISTS asdlc_user (
    user_id         TEXT PRIMARY KEY,
    display_name    TEXT NOT NULL,
    email           TEXT NOT NULL UNIQUE,
    role            TEXT NOT NULL DEFAULT 'other',
    active          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS asdlc_client (
    client_id               TEXT PRIMARY KEY,
    client_name             TEXT NOT NULL,
    client_code             TEXT NOT NULL UNIQUE,
    default_visibility_scope TEXT NOT NULL DEFAULT 'PROJECT',
    notes                   TEXT,
    lifecycle_status        TEXT NOT NULL DEFAULT 'active',
    created_by              TEXT,
    created_at              TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by              TEXT,
    updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
    version                 INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS asdlc_project (
    project_id                      TEXT PRIMARY KEY,
    client_id                       TEXT NOT NULL REFERENCES asdlc_client(client_id),
    project_name                    TEXT NOT NULL,
    project_code                    TEXT NOT NULL,
    stage                           TEXT NOT NULL DEFAULT 'draft',
    uses_pilot_baseline             INTEGER NOT NULL DEFAULT 1,
    inherit_from_project_id         TEXT,
    default_human_approval_required INTEGER NOT NULL DEFAULT 1,
    confidence_threshold            REAL    NOT NULL DEFAULT 0.75,
    repository_access_model         TEXT NOT NULL DEFAULT 'INTERNAL_ONLY',
    -- ── Per-application cost params ──────────────────────────────────────────
    -- Pricing + planning + entitlement all per-Application (each customer/app
    -- negotiates its own price sheet & plan with ServiceNow). The legacy global
    -- asdlc_cost_assumption row is kept for backward-compat reads but is no
    -- longer authoritative; the API resolves cost params from these columns.
    cost_per_assist                 REAL NOT NULL DEFAULT 0.015,
    overage_rate                    REAL,
    cost_per_assist_expansion       REAL,    -- Expansion Pack rate, stored for future calc
    planning_period                 TEXT NOT NULL DEFAULT 'Monthly'
        CHECK (planning_period IN ('Weekly','Monthly','Quarterly','Annual')),
    periods_per_year                REAL NOT NULL DEFAULT 12,
    entitlement_enabled             INTEGER NOT NULL DEFAULT 0,
    annual_included_assists         REAL,
    visibility_scope                TEXT NOT NULL DEFAULT 'PROJECT',
    lifecycle_status                TEXT NOT NULL DEFAULT 'active',
    created_by                      TEXT,
    created_at                      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by                      TEXT,
    updated_at                      TEXT NOT NULL DEFAULT (datetime('now')),
    version                         INTEGER NOT NULL DEFAULT 1,
    UNIQUE(client_id, project_code)
);

CREATE TABLE IF NOT EXISTS asdlc_project_member (
    project_member_id   TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL REFERENCES asdlc_project(project_id),
    user_id             TEXT NOT NULL REFERENCES asdlc_user(user_id),
    display_name        TEXT NOT NULL,
    member_role         TEXT NOT NULL DEFAULT 'other',
    can_approve         INTEGER NOT NULL DEFAULT 0,
    hitl_role           TEXT,
    active              INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, user_id)
);

CREATE TABLE IF NOT EXISTS asdlc_agent_catalog (
    workbench_agent_id  TEXT PRIMARY KEY,
    agent_type          TEXT NOT NULL UNIQUE,
    agent_name          TEXT NOT NULL,
    purpose             TEXT NOT NULL,
    default_trust_level INTEGER NOT NULL DEFAULT 2,
    hitl_tags           TEXT NOT NULL DEFAULT '[]',
    version             TEXT NOT NULL DEFAULT '1.0',
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS asdlc_project_agent_setting (
    project_agent_setting_id    TEXT PRIMARY KEY,
    project_id                  TEXT NOT NULL REFERENCES asdlc_project(project_id),
    workbench_agent_id          TEXT NOT NULL REFERENCES asdlc_agent_catalog(workbench_agent_id),
    trust_level                 INTEGER NOT NULL DEFAULT 2,
    enabled                     INTEGER NOT NULL DEFAULT 1,
    allowed_actions             TEXT,
    requires_human_approval     INTEGER NOT NULL DEFAULT 1,
    notes                       TEXT,
    created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, workbench_agent_id)
);

-- ============================================================
-- DESIGN CONTENT
-- ============================================================

CREATE TABLE IF NOT EXISTS asdlc_use_case (
    use_case_id              TEXT PRIMARY KEY,
    project_id               TEXT REFERENCES asdlc_project(project_id),
    slug                     TEXT,                                 -- Phase 1: UC-### per project
    title                    TEXT NOT NULL,
    summary                  TEXT NOT NULL DEFAULT '',
    business_objective       TEXT NOT NULL DEFAULT '',
    expected_value           TEXT NOT NULL DEFAULT '',
    users                    TEXT NOT NULL DEFAULT '',
    volume_assumptions       TEXT NOT NULL DEFAULT '{}',
    urgency                  TEXT,
    success_criteria         TEXT NOT NULL DEFAULT '[]',
    constraints_list         TEXT NOT NULL DEFAULT '[]',
    supervision_model        TEXT NOT NULL DEFAULT 'Supervised HITL',  -- Decision #2: 3-value Agent enum
    next_step                TEXT,
    readiness                TEXT NOT NULL DEFAULT 'not_ready',
    -- ── Phase 1 additions ─────────────────────────────────────────────
    risk_tier                TEXT CHECK (risk_tier IS NULL OR risk_tier IN ('High','Medium','Low')),
    owner                    TEXT,                                  -- Decision #6: free text business owner
    primary_success_metric   TEXT,                                  -- Decision #7: single headline KPI
    epic_or_feature_id       TEXT,                                  -- Decision #4: portfolio link, UI-hidden
    baseline_cost_annual_usd REAL,                                  -- Decision #17: for ROI computation
    visibility_scope         TEXT NOT NULL DEFAULT 'PROJECT',
    lifecycle_status         TEXT NOT NULL DEFAULT 'draft',
    created_by               TEXT,
    created_at               TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by               TEXT,
    updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
    version                  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS asdlc_workflow (
    workflow_id         TEXT PRIMARY KEY,
    use_case_id         TEXT NOT NULL REFERENCES asdlc_use_case(use_case_id),
    project_id          TEXT REFERENCES asdlc_project(project_id),
    slug                TEXT,                                       -- Phase 1: WF-### per project
    name                TEXT NOT NULL,
    trigger_def         TEXT NOT NULL DEFAULT '{}',
    handoffs            TEXT NOT NULL DEFAULT '[]',
    decisions           TEXT NOT NULL DEFAULT '[]',
    fallback_paths      TEXT NOT NULL DEFAULT '[]',
    sla_hours           REAL,
    readiness           TEXT NOT NULL DEFAULT 'draft',
    -- ── Phase 1 additions ─────────────────────────────────────────────
    risk_tier           TEXT CHECK (risk_tier IS NULL OR risk_tier IN ('High','Medium','Low')),
    runs_per_period     REAL,                                       -- Decision #17: volume for cost calc
    visibility_scope    TEXT NOT NULL DEFAULT 'PROJECT',
    lifecycle_status    TEXT NOT NULL DEFAULT 'draft',
    created_by          TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by          TEXT,
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    version             INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS asdlc_workflow_step (
    workflow_step_id    TEXT PRIMARY KEY,
    workflow_id         TEXT NOT NULL REFERENCES asdlc_workflow(workflow_id),
    project_id          TEXT REFERENCES asdlc_project(project_id),
    slug                TEXT,                                       -- Phase 1: S-### per project
    step_number         INTEGER NOT NULL,
    name                TEXT NOT NULL,
    actor_role          TEXT NOT NULL DEFAULT '',                   -- Deprecated by Decision #12; remains until Phase 2 owner_participant_id ships
    owner_member_id     TEXT REFERENCES asdlc_project_member(project_member_id),
    raci                TEXT,                                       -- Deprecated by Decision #10; replaced by asdlc_workflow_step_rasic in Phase 2
    inputs              TEXT NOT NULL DEFAULT '[]',
    outputs             TEXT NOT NULL DEFAULT '[]',
    decisions_list      TEXT NOT NULL DEFAULT '[]',
    hitl_gate_id        TEXT,
    sla_hours           INTEGER,
    -- ── Phase 1 additions (Decision #12) ──────────────────────────────
    step_type           TEXT CHECK (step_type IS NULL OR step_type IN ('Start','Activity','Decision','Approval','Notification','Wait','End')),
    step_purpose        TEXT,                                       -- What the step achieves (separate from name)
    preconditions       TEXT,                                       -- Entry checks
    evidence_captured   TEXT,                                       -- Decision log / audit evidence
    is_end_step         INTEGER NOT NULL DEFAULT 0,                 -- Convenience flag, derivable from step_type
    visibility_scope    TEXT NOT NULL DEFAULT 'PROJECT',
    lifecycle_status    TEXT NOT NULL DEFAULT 'draft',
    created_by          TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by          TEXT,
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    version             INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS asdlc_hitl_gate (
    hitl_gate_id        TEXT PRIMARY KEY,
    workflow_id         TEXT NOT NULL REFERENCES asdlc_workflow(workflow_id),
    workflow_step_id    TEXT,
    project_id          TEXT REFERENCES asdlc_project(project_id),
    gate_type           TEXT NOT NULL DEFAULT 'approval',
    criteria            TEXT NOT NULL DEFAULT '',
    owner_role          TEXT NOT NULL DEFAULT '',
    sla                 TEXT NOT NULL DEFAULT '',
    handoff_mechanism   TEXT NOT NULL DEFAULT '',
    visibility_scope    TEXT NOT NULL DEFAULT 'PROJECT',
    lifecycle_status    TEXT NOT NULL DEFAULT 'active',
    created_by          TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by          TEXT,
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    version             INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS asdlc_agent_spec (
    agent_spec_id           TEXT PRIMARY KEY,
    use_case_id             TEXT NOT NULL REFERENCES asdlc_use_case(use_case_id),  -- TODO Phase 3: replace with asdlc_agent_use_case M:N join (Decision #15)
    workflow_id             TEXT REFERENCES asdlc_workflow(workflow_id),
    project_id              TEXT REFERENCES asdlc_project(project_id),
    slug                    TEXT,                                   -- Phase 1: AG-### per project
    name                    TEXT NOT NULL,
    scope                   TEXT NOT NULL DEFAULT '',
    instructions            TEXT NOT NULL DEFAULT '',
    goals                   TEXT NOT NULL DEFAULT '[]',
    done_criteria           TEXT NOT NULL DEFAULT '[]',
    inputs                  TEXT NOT NULL DEFAULT '{}',
    outputs                 TEXT NOT NULL DEFAULT '{}',
    run_as_model            TEXT NOT NULL DEFAULT '{}',
    memory_strategy         TEXT,
    design_risks            TEXT NOT NULL DEFAULT '[]',
    -- ── Phase 1 additions (Decisions #2, #16, #17, #18) ───────────────
    supervision_model       TEXT CHECK (supervision_model IS NULL OR supervision_model IN ('Advisory-only','Supervised HITL','Autonomous')),
    maintenance_owner       TEXT,                                   -- Decision #16: engineering accountability
    orchestration_strategy  TEXT CHECK (orchestration_strategy IS NULL OR orchestration_strategy IN ('Base Planner','ReActive Planner','Batch Planner')),
    latency_target          TEXT,                                   -- Decision #18: free text, e.g. "p95 < 5s"
    post_release_validation TEXT,                                   -- Decision #18: post-deploy checks
    cost_model              TEXT NOT NULL DEFAULT 'none',           -- Decision #17: 'none' or 'servicenow_now_assist'
    visibility_scope        TEXT NOT NULL DEFAULT 'PROJECT',
    lifecycle_status        TEXT NOT NULL DEFAULT 'draft',
    created_by              TEXT,
    created_at              TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by              TEXT,
    updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
    version                 INTEGER NOT NULL DEFAULT 1
);

-- ── Phase 3: Agent ↔ Use Case M:N (Decision #15) ────────────────────────────
CREATE TABLE IF NOT EXISTS asdlc_agent_use_case (
    agent_use_case_id   TEXT PRIMARY KEY,
    agent_spec_id       TEXT NOT NULL REFERENCES asdlc_agent_spec(agent_spec_id),
    use_case_id         TEXT NOT NULL REFERENCES asdlc_use_case(use_case_id),
    project_id          TEXT REFERENCES asdlc_project(project_id),
    business_value      TEXT,
    notes               TEXT,
    created_by          TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by          TEXT,
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(agent_spec_id, use_case_id)
);

-- ── Phase 3: Agent ↔ Tool M:N bindings (Decision #14) ──────────────────────
CREATE TABLE IF NOT EXISTS asdlc_agent_tool (
    agent_tool_id               TEXT PRIMARY KEY,
    agent_spec_id               TEXT NOT NULL REFERENCES asdlc_agent_spec(agent_spec_id),
    tool_id                     TEXT NOT NULL REFERENCES asdlc_tool(tool_id),
    project_id                  TEXT REFERENCES asdlc_project(project_id),
    purpose                     TEXT,
    fallback_behavior           TEXT,
    binding_supervision_model   TEXT CHECK (binding_supervision_model IS NULL OR binding_supervision_model IN ('Supervised','Autonomous')),
    tool_execution_mode         TEXT CHECK (tool_execution_mode IS NULL OR tool_execution_mode IN ('Autonomous','Human-permission required')),
    linked_user_story_refs      TEXT,
    details                     TEXT,
    created_by                  TEXT,
    created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by                  TEXT,
    updated_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(agent_spec_id, tool_id)
);

-- ── Phase 4: Now Assist skill rate card (Decision #17) ──────────────────────
CREATE TABLE IF NOT EXISTS asdlc_assist_rate_card (
    skill_id         TEXT PRIMARY KEY,
    skill_name       TEXT NOT NULL UNIQUE,
    category         TEXT NOT NULL DEFAULT '',
    assists_per_unit REAL NOT NULL DEFAULT 1.0,
    description      TEXT,
    source_note      TEXT,
    effective_date   TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Phase 4: Global cost assumptions singleton (one row globally) ────────────
CREATE TABLE IF NOT EXISTS asdlc_cost_assumption (
    cost_assumption_id      TEXT PRIMARY KEY,
    cost_per_assist         REAL NOT NULL DEFAULT 0.015,
    planning_period         TEXT NOT NULL DEFAULT 'Monthly'
        CHECK (planning_period IN ('Weekly','Monthly','Quarterly','Annual')),
    periods_per_year        REAL NOT NULL DEFAULT 12,
    entitlement_enabled     INTEGER NOT NULL DEFAULT 0,
    annual_included_assists REAL,
    overage_rate            REAL,
    updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by              TEXT
);

-- ── Phase 4: AI-generated (user-overridable) per-step skill bindings ─────────
CREATE TABLE IF NOT EXISTS asdlc_workflow_step_cost_binding (
    binding_id         TEXT PRIMARY KEY,
    workflow_step_id   TEXT NOT NULL REFERENCES asdlc_workflow_step(workflow_step_id),
    project_id         TEXT REFERENCES asdlc_project(project_id),
    skill_name         TEXT NOT NULL REFERENCES asdlc_assist_rate_card(skill_name),
    qty_per_run        REAL NOT NULL DEFAULT 1.0,
    branch_probability REAL CHECK (branch_probability IS NULL OR
                       (branch_probability >= 0 AND branch_probability <= 1)),
    ai_generated       INTEGER NOT NULL DEFAULT 1,
    ai_reasoning       TEXT,
    notes              TEXT,
    created_by         TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by         TEXT,
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(workflow_step_id, skill_name)
);

CREATE TABLE IF NOT EXISTS asdlc_tool (
    tool_id             TEXT PRIMARY KEY,
    project_id          TEXT REFERENCES asdlc_project(project_id),  -- nullable: GLOBAL/ORGANIZATION/PROGRAM tools have NULL (Decision #14)
    slug                TEXT,                                       -- Phase 1: T-### per project
    name                TEXT NOT NULL,
    contract            TEXT NOT NULL DEFAULT '{}',
    inputs              TEXT NOT NULL DEFAULT '{}',
    outputs             TEXT NOT NULL DEFAULT '{}',
    errors              TEXT NOT NULL DEFAULT '[]',
    access_requirements TEXT NOT NULL DEFAULT '{}',
    execution_mode      TEXT NOT NULL DEFAULT 'sync',
    cost_impact         TEXT,
    boundaries          TEXT NOT NULL DEFAULT '[]',
    -- ── Phase 1 additions (Decision #14) ──────────────────────────────
    dev_status          TEXT CHECK (dev_status IS NULL OR dev_status IN ('Existing','To be built')),
    visibility_scope    TEXT NOT NULL DEFAULT 'PROJECT',            -- PROJECT | GLOBAL | ORGANIZATION | PROGRAM
    lifecycle_status    TEXT NOT NULL DEFAULT 'active',
    created_by          TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by          TEXT,
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    version             INTEGER NOT NULL DEFAULT 1
);

-- ═══════════════════════════════════════════════════════════════════════════
-- ServiceNow round-trip: Level-1 design tables (business/functional altitude).
-- Populated by ingesting a ServiceNow app's transformed Fluent source. Each
-- carries hidden Level-2 "provenance" columns (source_*) = the construct/Fluent
-- representation + sys_id identity needed to regenerate & redeploy. Provenance
-- columns are NEVER surfaced to non-technical Level-1 editors.
-- ═══════════════════════════════════════════════════════════════════════════

-- DB schema/design — one row per ServiceNow table (sys_db_object + dictionary).
CREATE TABLE IF NOT EXISTS asdlc_data_model (
    data_model_id    TEXT PRIMARY KEY,
    project_id       TEXT REFERENCES asdlc_project(project_id),
    slug             TEXT,                          -- DM-### per project
    name             TEXT NOT NULL,                 -- business label for the table
    purpose          TEXT,                          -- what business object it represents
    physical_name    TEXT,                          -- ServiceNow table name, e.g. x_dnllp_airport_ca_flight
    extends_table    TEXT,                          -- parent table (e.g. task), if extended
    fields           TEXT NOT NULL DEFAULT '[]',    -- JSON [{label, meaning, type_business, mandatory, choices?, references?}]
    relationships    TEXT NOT NULL DEFAULT '[]',    -- JSON [{kind, target, description}]
    audited          INTEGER NOT NULL DEFAULT 0,
    -- ── Level-2 provenance (hidden) ──
    source_system    TEXT NOT NULL DEFAULT 'servicenow',
    source_sys_id    TEXT,
    source_table     TEXT,
    source_scope     TEXT,
    source_fluent    TEXT,
    source_hash      TEXT,
    visibility_scope TEXT NOT NULL DEFAULT 'PROJECT',
    lifecycle_status TEXT NOT NULL DEFAULT 'active',
    created_by       TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by       TEXT,
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    version          INTEGER NOT NULL DEFAULT 1
);

-- Form & view layout + UI-policy behavior — one row per form/view.
CREATE TABLE IF NOT EXISTS asdlc_form_design (
    form_design_id   TEXT PRIMARY KEY,
    project_id       TEXT REFERENCES asdlc_project(project_id),
    data_model_id    TEXT REFERENCES asdlc_data_model(data_model_id),  -- table this form is for
    slug             TEXT,                          -- FORM-### per project
    name             TEXT NOT NULL,
    view_name        TEXT,                          -- Default / Mobile / etc.
    sections         TEXT NOT NULL DEFAULT '[]',    -- JSON [{section_label, fields:[], columns}]
    related_lists    TEXT NOT NULL DEFAULT '[]',    -- JSON [{label, table}]
    mandatory_fields TEXT NOT NULL DEFAULT '[]',    -- JSON array of field labels
    readonly_fields  TEXT NOT NULL DEFAULT '[]',    -- JSON array of field labels
    behavior_notes   TEXT,                          -- UI-policy behavior in plain English
    -- ── Level-2 provenance (hidden) ──
    source_system    TEXT NOT NULL DEFAULT 'servicenow',
    source_sys_id    TEXT,
    source_table     TEXT,
    source_scope     TEXT,
    source_fluent    TEXT,
    source_hash      TEXT,
    visibility_scope TEXT NOT NULL DEFAULT 'PROJECT',
    lifecycle_status TEXT NOT NULL DEFAULT 'active',
    created_by       TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by       TEXT,
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    version          INTEGER NOT NULL DEFAULT 1
);

-- Business logic — one row per server/client logic artifact, in plain English.
-- The actual script body lives in source_fluent (provenance), never as a Level-1 field.
CREATE TABLE IF NOT EXISTS asdlc_business_logic (
    business_logic_id TEXT PRIMARY KEY,
    project_id        TEXT REFERENCES asdlc_project(project_id),
    data_model_id     TEXT REFERENCES asdlc_data_model(data_model_id),  -- table it runs on (nullable)
    slug              TEXT,                         -- BL-### per project
    name              TEXT NOT NULL,
    logic_type        TEXT NOT NULL DEFAULT 'business_rule'
        CHECK (logic_type IN ('business_rule','client_script','script_include','ui_action','scheduled_job','ui_policy')),
    plain_english     TEXT,                         -- what it does, in business terms
    when_runs         TEXT,                         -- trigger in business terms (e.g. "after a flight is updated")
    conditions        TEXT,                         -- when it applies
    run_order         INTEGER,
    -- ── Level-2 provenance (hidden) ──
    source_system     TEXT NOT NULL DEFAULT 'servicenow',
    source_sys_id     TEXT,
    source_table      TEXT,
    source_scope      TEXT,
    source_fluent     TEXT,
    source_hash       TEXT,
    visibility_scope  TEXT NOT NULL DEFAULT 'PROJECT',
    lifecycle_status  TEXT NOT NULL DEFAULT 'active',
    created_by        TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by        TEXT,
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    version           INTEGER NOT NULL DEFAULT 1
);

-- Catalog item / record producer — one row per catalog item.
CREATE TABLE IF NOT EXISTS asdlc_catalog_item (
    catalog_item_id   TEXT PRIMARY KEY,
    project_id        TEXT REFERENCES asdlc_project(project_id),
    workflow_id       TEXT REFERENCES asdlc_workflow(workflow_id),  -- fulfillment workflow (nullable)
    slug              TEXT,                         -- CAT-### per project
    name              TEXT NOT NULL,
    short_description TEXT,
    category          TEXT,
    variables         TEXT NOT NULL DEFAULT '[]',   -- JSON [{label, type_business, mandatory, choices?, help}]
    who_can_order     TEXT,                         -- roles / groups
    delivery_time     TEXT,
    -- ── Level-2 provenance (hidden) ──
    source_system     TEXT NOT NULL DEFAULT 'servicenow',
    source_sys_id     TEXT,
    source_table      TEXT,
    source_scope      TEXT,
    source_fluent     TEXT,
    source_hash       TEXT,
    visibility_scope  TEXT NOT NULL DEFAULT 'PROJECT',
    lifecycle_status  TEXT NOT NULL DEFAULT 'active',
    created_by        TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by        TEXT,
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    version           INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_data_model_project   ON asdlc_data_model(project_id);
CREATE INDEX IF NOT EXISTS idx_form_design_project  ON asdlc_form_design(project_id);
CREATE INDEX IF NOT EXISTS idx_form_design_dm       ON asdlc_form_design(data_model_id);
CREATE INDEX IF NOT EXISTS idx_biz_logic_project    ON asdlc_business_logic(project_id);
CREATE INDEX IF NOT EXISTS idx_biz_logic_dm         ON asdlc_business_logic(data_model_id);
CREATE INDEX IF NOT EXISTS idx_catalog_item_project ON asdlc_catalog_item(project_id);
-- Provenance lookup (round-trip identity / drift detection) by source_sys_id.
CREATE INDEX IF NOT EXISTS idx_data_model_sysid     ON asdlc_data_model(source_sys_id);
CREATE INDEX IF NOT EXISTS idx_form_design_sysid    ON asdlc_form_design(source_sys_id);
CREATE INDEX IF NOT EXISTS idx_biz_logic_sysid      ON asdlc_business_logic(source_sys_id);
CREATE INDEX IF NOT EXISTS idx_catalog_item_sysid   ON asdlc_catalog_item(source_sys_id);

CREATE TABLE IF NOT EXISTS asdlc_knowledge_article (
    knowledge_article_id TEXT PRIMARY KEY,
    project_id          TEXT REFERENCES asdlc_project(project_id),
    title               TEXT NOT NULL,
    body                TEXT NOT NULL DEFAULT '',
    trigger_text        TEXT,
    linked_use_case_id  TEXT REFERENCES asdlc_use_case(use_case_id),
    linked_workflow_id  TEXT REFERENCES asdlc_workflow(workflow_id),
    approved_by         TEXT REFERENCES asdlc_project_member(project_member_id),
    approved_at         TEXT,
    next_review_date    TEXT,
    visibility_scope    TEXT NOT NULL DEFAULT 'PROJECT',
    lifecycle_status    TEXT NOT NULL DEFAULT 'draft',
    created_by          TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by          TEXT,
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    version             INTEGER NOT NULL DEFAULT 1
);

-- ============================================================
-- FIELD TRUTH & EVIDENCE
-- ============================================================

CREATE TABLE IF NOT EXISTS asdlc_evidence_source (
    evidence_source_id  TEXT PRIMARY KEY,
    project_id          TEXT REFERENCES asdlc_project(project_id),
    source_title        TEXT NOT NULL,
    source_type         TEXT NOT NULL DEFAULT 'document',
    source_url          TEXT NOT NULL DEFAULT '',
    source_datetime     TEXT NOT NULL DEFAULT (datetime('now')),
    uploaded_by         TEXT REFERENCES asdlc_user(user_id),
    ingestion_status    TEXT NOT NULL DEFAULT 'new',
    validation_status   TEXT NOT NULL DEFAULT 'draft',
    transcript_text     TEXT,
    notes               TEXT,
    visibility_scope    TEXT NOT NULL DEFAULT 'PROJECT',
    lifecycle_status    TEXT NOT NULL DEFAULT 'active',
    created_by          TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by          TEXT,
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    version             INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS asdlc_source_reference (
    source_reference_id     TEXT PRIMARY KEY,
    evidence_source_id      TEXT NOT NULL REFERENCES asdlc_evidence_source(evidence_source_id),
    reference_label         TEXT NOT NULL,
    timestamp_or_location   TEXT,
    reference_url           TEXT,
    summary                 TEXT,
    confidence              TEXT NOT NULL DEFAULT 'medium',
    source_datetime         TEXT,
    created_at              TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- CHANGE & VALIDATION
-- ============================================================

CREATE TABLE IF NOT EXISTS asdlc_change_packet (
    change_packet_id        TEXT PRIMARY KEY,
    project_id              TEXT REFERENCES asdlc_project(project_id),
    packet_code             TEXT NOT NULL UNIQUE,
    status                  TEXT NOT NULL DEFAULT 'pending',
    summary                 TEXT NOT NULL DEFAULT '',
    source_evidence_id      TEXT REFERENCES asdlc_evidence_source(evidence_source_id),
    source_timestamp        TEXT NOT NULL DEFAULT (datetime('now')),
    conflict_classification TEXT NOT NULL DEFAULT 'net_new',
    risk_level              TEXT NOT NULL DEFAULT 'med',
    recommended_action      TEXT NOT NULL DEFAULT 'review',
    baseline_impacting      INTEGER NOT NULL DEFAULT 0,
    validation_status       TEXT NOT NULL DEFAULT 'passed',
    authoring_agent_run_id  TEXT,
    approver_member_id      TEXT REFERENCES asdlc_project_member(project_member_id),
    approval_timestamp      TEXT,
    decision_notes          TEXT,
    visibility_scope        TEXT NOT NULL DEFAULT 'PROJECT',
    lifecycle_status        TEXT NOT NULL DEFAULT 'active',
    created_by              TEXT,
    created_at              TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by              TEXT,
    updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
    version                 INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS asdlc_change_packet_item (
    change_packet_item_id   TEXT PRIMARY KEY,
    change_packet_id        TEXT NOT NULL REFERENCES asdlc_change_packet(change_packet_id),
    entity_type             TEXT NOT NULL,
    entity_id               TEXT NOT NULL,
    operation               TEXT NOT NULL DEFAULT 'create',  -- 'create' | 'update' | 'delete'
    field_path              TEXT NOT NULL,
    old_value               TEXT,
    new_value               TEXT NOT NULL,
    rationale               TEXT,
    applied_at              TEXT,
    created_at              TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS asdlc_exception (
    exception_id            TEXT PRIMARY KEY,
    project_id              TEXT REFERENCES asdlc_project(project_id),
    exception_type          TEXT NOT NULL DEFAULT 'other',
    severity                TEXT NOT NULL DEFAULT 'med',
    description             TEXT NOT NULL DEFAULT '',
    related_entity_type     TEXT NOT NULL DEFAULT '',
    related_entity_id       TEXT NOT NULL,
    suggested_action        TEXT,
    assigned_member_id      TEXT REFERENCES asdlc_project_member(project_member_id),
    status                  TEXT NOT NULL DEFAULT 'open',
    resolution_summary      TEXT,
    raised_by_agent_run_id  TEXT,
    change_packet_id        TEXT REFERENCES asdlc_change_packet(change_packet_id),
    -- Feature #9: quality-reviewer attribution + category
    detected_by             TEXT NOT NULL DEFAULT 'manual',     -- 'manual' | 'quality-reviewer'
    field_name              TEXT,                                -- nullable; field-level findings
    finding_category        TEXT,                                -- 'missing'|'incomplete'|'inconsistent'|'conflicting'
    visibility_scope        TEXT NOT NULL DEFAULT 'PROJECT',
    lifecycle_status        TEXT NOT NULL DEFAULT 'active',
    created_by              TEXT,
    created_at              TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by              TEXT,
    updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
    version                 INTEGER NOT NULL DEFAULT 1
);

-- Feature #9: dedupe lookup for quality-reviewer upserts
-- NOTE: index creation is handled in db.js MIGRATIONS so existing databases
-- get the index created AFTER the ALTER TABLE adds the field_name / finding_category
-- columns. Adding it here would fail on first boot against a legacy DB.

-- ============================================================
-- BASELINES & REPORTING
-- ============================================================

CREATE TABLE IF NOT EXISTS asdlc_baseline (
    baseline_id                     TEXT PRIMARY KEY,
    project_id                      TEXT NOT NULL REFERENCES asdlc_project(project_id),
    baseline_type                   TEXT NOT NULL DEFAULT 'draft',
    baseline_name                   TEXT NOT NULL,
    baseline_version                TEXT,
    baseline_status                 TEXT NOT NULL DEFAULT 'draft',
    summary_of_changes              TEXT,
    parent_baseline_id              TEXT REFERENCES asdlc_baseline(baseline_id),
    created_from_change_packet_id   TEXT REFERENCES asdlc_change_packet(change_packet_id),
    locked_at                       TEXT,
    locked_by_member_id             TEXT REFERENCES asdlc_project_member(project_member_id),
    record_count                    INTEGER DEFAULT 0,
    field_count                     INTEGER DEFAULT 0,
    visibility_scope                TEXT NOT NULL DEFAULT 'PROJECT',
    lifecycle_status                TEXT NOT NULL DEFAULT 'active',
    created_by                      TEXT,
    created_at                      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by                      TEXT,
    updated_at                      TEXT NOT NULL DEFAULT (datetime('now')),
    version                         INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS asdlc_baseline_item (
    baseline_item_id    TEXT PRIMARY KEY,
    baseline_id         TEXT NOT NULL REFERENCES asdlc_baseline(baseline_id),
    entity_type         TEXT NOT NULL,
    entity_id           TEXT NOT NULL,
    field_path          TEXT,
    snapshot_value      TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS asdlc_report_export (
    report_export_id            TEXT PRIMARY KEY,
    project_id                  TEXT REFERENCES asdlc_project(project_id),
    report_type                 TEXT NOT NULL DEFAULT 'consolidated_design',
    baseline_id                 TEXT REFERENCES asdlc_baseline(baseline_id),
    file_url                    TEXT NOT NULL DEFAULT '',
    format                      TEXT NOT NULL DEFAULT 'docx',
    audience                    TEXT NOT NULL DEFAULT 'reviewer',
    client_visible              INTEGER NOT NULL DEFAULT 0,
    generated_by_agent_run_id   TEXT,
    generated_by_member_id      TEXT REFERENCES asdlc_project_member(project_member_id),
    generated_at                TEXT NOT NULL DEFAULT (datetime('now')),
    title                       TEXT NOT NULL DEFAULT '',
    visibility_scope            TEXT NOT NULL DEFAULT 'PROJECT',
    lifecycle_status            TEXT NOT NULL DEFAULT 'active',
    created_by                  TEXT,
    created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by                  TEXT,
    updated_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    version                     INTEGER NOT NULL DEFAULT 1
);

-- ============================================================
-- AGENT EXTRACTION STAGING
-- ============================================================

CREATE TABLE IF NOT EXISTS asdlc_ingest_extraction (
    extraction_id   TEXT PRIMARY KEY,
    ingest_id       TEXT NOT NULL REFERENCES asdlc_ingest_document(ingest_id),
    entity_type     TEXT NOT NULL,
    entity_data     TEXT NOT NULL,          -- JSON
    confidence      REAL NOT NULL DEFAULT 0.0,
    status          TEXT NOT NULL DEFAULT 'staged',  -- staged | needs_clarification | promoted | rejected
    round           INTEGER NOT NULL DEFAULT 1,
    source_location TEXT,                            -- nullable JSON: { page, section, line, char_offset }
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS asdlc_ingest_clarification (
    clarification_id    TEXT PRIMARY KEY,
    ingest_id           TEXT NOT NULL REFERENCES asdlc_ingest_document(ingest_id),
    round               INTEGER NOT NULL DEFAULT 1,
    question_text       TEXT NOT NULL,
    context_snippet     TEXT,
    target_entity_type  TEXT,
    target_field        TEXT,
    answer_text         TEXT,
    answered_at         TEXT,
    answered_by         TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_extraction_ingest ON asdlc_ingest_extraction(ingest_id);
CREATE INDEX IF NOT EXISTS idx_clarif_ingest     ON asdlc_ingest_clarification(ingest_id);

-- ============================================================
-- DOCUMENT INGESTION
-- ============================================================

CREATE TABLE IF NOT EXISTS asdlc_ingest_document (
    ingest_id           TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL REFERENCES asdlc_project(project_id),
    document_title      TEXT NOT NULL,
    file_name           TEXT,
    file_type           TEXT,
    document_type       TEXT NOT NULL DEFAULT 'other',
    description         TEXT,
    ingest_status       TEXT NOT NULL DEFAULT 'pending',
    uploaded_by         TEXT REFERENCES asdlc_user(user_id),
    uploaded_at         TEXT NOT NULL DEFAULT (datetime('now')),
    file_path           TEXT,
    raw_text            TEXT,
    processing_notes    TEXT,
    change_packets_generated INTEGER NOT NULL DEFAULT 0,
    -- Soft-cancel / archive (reversible; never hard-deleted)
    lifecycle_status    TEXT NOT NULL DEFAULT 'active',   -- active | cancelled
    cancelled_at        TEXT,
    cancelled_by        TEXT REFERENCES asdlc_user(user_id),
    cancel_reason       TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ingest_project ON asdlc_ingest_document(project_id);
CREATE INDEX IF NOT EXISTS idx_ingest_status ON asdlc_ingest_document(ingest_status);
-- idx_ingest_lifecycle is created in db.js MIGRATIONS, after the lifecycle_status
-- column is added — on an existing DB the column does not exist at schema-exec time.

-- ============================================================
-- AI CONFIG, USAGE, BEST PRACTICES, LEARNING FEEDBACK
-- ============================================================

-- Global, workbench-wide key/value settings (model selection, thinking, tokens).
-- Resolved by getSetting(): table value → env var → hardcoded default.
CREATE TABLE IF NOT EXISTS asdlc_app_setting (
    setting_key   TEXT PRIMARY KEY,
    setting_value TEXT,
    updated_by    TEXT,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per AI API run — token usage + computed cost.
CREATE TABLE IF NOT EXISTS asdlc_ai_usage (
    usage_id              TEXT PRIMARY KEY,
    project_id            TEXT,
    source                TEXT NOT NULL DEFAULT 'ingest_extraction', -- ingest_extraction | quality_review | build_review
    ref_id                TEXT,                                       -- e.g. ingest_id
    model                 TEXT,
    round                 INTEGER,
    input_tokens          INTEGER NOT NULL DEFAULT 0,
    output_tokens         INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd              REAL,
    created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_project ON asdlc_ai_usage(project_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_source  ON asdlc_ai_usage(source);

-- Human-authored, global house rules injected into the extraction prompt.
CREATE TABLE IF NOT EXISTS asdlc_best_practice (
    best_practice_id TEXT PRIMARY KEY,
    scope            TEXT NOT NULL DEFAULT 'global',   -- 'global' | <entity_type>
    title            TEXT NOT NULL,
    rule_text        TEXT NOT NULL DEFAULT '',
    is_active        INTEGER NOT NULL DEFAULT 1,
    sort_order       INTEGER NOT NULL DEFAULT 0,
    source           TEXT NOT NULL DEFAULT 'manual',   -- 'manual' | 'from_correction'
    created_by       TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by       TEXT,
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Learning loop: proposed-vs-approved signal captured during CP review.
CREATE TABLE IF NOT EXISTS asdlc_ingest_feedback (
    feedback_id      TEXT PRIMARY KEY,
    project_id       TEXT,
    ingest_id        TEXT,
    extraction_id    TEXT,
    change_packet_id TEXT,
    entity_type      TEXT,
    model            TEXT,
    confidence       REAL,
    outcome          TEXT NOT NULL,        -- accepted_asis | accepted_edited | rejected
    proposed_value   TEXT,
    final_value      TEXT,
    reviewer_id      TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_feedback_project ON asdlc_ingest_feedback(project_id);

-- ============================================================
-- AUDIT LOG
-- ============================================================

CREATE TABLE IF NOT EXISTS asdlc_audit_log (
    audit_id        TEXT PRIMARY KEY,
    table_name      TEXT NOT NULL,
    record_id       TEXT NOT NULL,
    operation       TEXT NOT NULL,
    old_data        TEXT,
    new_data        TEXT,
    changed_by      TEXT,
    changed_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- ACCEPTANCE CRITERIA & TEST CASES
-- ============================================================

-- Acceptance criteria are attached to either a Use Case or a User Story.
-- parent_id is stored as a free string (no FK) and validated by the API layer —
-- it may be a use_case_id or (now that user stories materialize) a user_story_id.
CREATE TABLE IF NOT EXISTS asdlc_acceptance_criterion (
    acceptance_criterion_id TEXT PRIMARY KEY,
    project_id              TEXT NOT NULL REFERENCES asdlc_project(project_id),
    slug                    TEXT,                                  -- Phase 1: AC-### per project
    parent_type             TEXT NOT NULL,            -- 'use_case' | 'user_story'
    parent_id               TEXT NOT NULL,            -- use_case_id OR user_story story_id_ref
    req_slug                TEXT,                     -- FR-### or NFR-### this AC satisfies (loose FK via slug)
    text                    TEXT NOT NULL,
    source                  TEXT NOT NULL DEFAULT 'user_added',  -- 'generated' | 'user_added' | 'user_edited'
    status                  TEXT NOT NULL DEFAULT 'draft',       -- 'draft' | 'approved' | 'rejected'
    lifecycle_status        TEXT NOT NULL DEFAULT 'active',
    created_by              TEXT,
    created_at              TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by              TEXT,
    updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
    version                 INTEGER NOT NULL DEFAULT 1
);

-- ── Core design elements materialized from BRD ingest ──────────────────────────
-- Guardrails (behavioural constraints) and data sources (integration surface) are
-- first-class design elements — they carry information held nowhere else. No CHECK
-- constraints on enum-like columns so unexpected model output can never crash
-- materialization (the materializer writes whatever the extractor emitted).

CREATE TABLE IF NOT EXISTS asdlc_guardrail (
    guardrail_id         TEXT PRIMARY KEY,
    project_id           TEXT REFERENCES asdlc_project(project_id),
    ingest_id            TEXT REFERENCES asdlc_ingest_document(ingest_id),
    slug                 TEXT,                        -- GR-### per project
    rule_name            TEXT NOT NULL,
    rule_text            TEXT NOT NULL DEFAULT '',
    severity             TEXT NOT NULL DEFAULT 'medium',   -- critical|high|medium|low (not enforced)
    applies_to           TEXT,
    threshold_value      TEXT,
    threshold_unit       TEXT,
    regulatory_reference TEXT,
    action_if_triggered  TEXT,                        -- block|escalate|flag|log|halt (not enforced)
    visibility_scope     TEXT NOT NULL DEFAULT 'PROJECT',
    lifecycle_status     TEXT NOT NULL DEFAULT 'active',
    created_by           TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by           TEXT,
    updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
    version              INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS asdlc_data_source (
    data_source_id      TEXT PRIMARY KEY,
    project_id          TEXT REFERENCES asdlc_project(project_id),
    ingest_id           TEXT REFERENCES asdlc_ingest_document(ingest_id),
    slug                TEXT,                         -- DS-### per project
    source_name         TEXT NOT NULL,
    source_type         TEXT NOT NULL DEFAULT 'other',  -- api|database|file|service|queue|other (not enforced)
    description         TEXT NOT NULL DEFAULT '',
    access_type         TEXT,                         -- read|write|read-write (not enforced)
    access_requirements TEXT NOT NULL DEFAULT '[]',   -- JSON array of strings
    contains_pii        INTEGER NOT NULL DEFAULT 0,
    rate_limits         TEXT,
    visibility_scope    TEXT NOT NULL DEFAULT 'PROJECT',
    lifecycle_status    TEXT NOT NULL DEFAULT 'active',
    created_by          TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by          TEXT,
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    version             INTEGER NOT NULL DEFAULT 1
);

-- User stories are a backlog/planning lens, NOT a carrier of unique design data
-- (role/want/so_that/priority are already first-class on FR/use_case; acceptance
-- criteria live in asdlc_acceptance_criterion). This is a THIN traceability home:
-- the narrative + requirement_refs (FR/NFR slugs the story is realized by). It
-- deliberately stores NO acceptance-criteria content (no duplication).
CREATE TABLE IF NOT EXISTS asdlc_user_story (
    user_story_id    TEXT PRIMARY KEY,
    project_id       TEXT REFERENCES asdlc_project(project_id),
    ingest_id        TEXT REFERENCES asdlc_ingest_document(ingest_id),
    slug             TEXT,                            -- US-### per project
    role             TEXT NOT NULL DEFAULT '',
    want             TEXT NOT NULL DEFAULT '',
    so_that          TEXT NOT NULL DEFAULT '',
    priority         TEXT,                            -- must-have|should-have|could-have (not enforced)
    requirement_refs TEXT NOT NULL DEFAULT '[]',      -- JSON array of FR/NFR slugs (traceability, not duplicated design)
    visibility_scope TEXT NOT NULL DEFAULT 'PROJECT',
    lifecycle_status TEXT NOT NULL DEFAULT 'active',
    created_by       TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by       TEXT,
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    version          INTEGER NOT NULL DEFAULT 1
);

-- Test cases at one of four scopes: agent (unit), workflow, tool (unit),
-- use_case (integration). scope_entity_id references the matching entity's PK.
CREATE TABLE IF NOT EXISTS asdlc_test_case (
    test_case_id        TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL REFERENCES asdlc_project(project_id),
    slug                TEXT,                                      -- Phase 1: TC-### per project
    scope               TEXT NOT NULL,                -- 'agent' | 'workflow' | 'tool' | 'use_case'
    scope_entity_id     TEXT NOT NULL,
    title               TEXT NOT NULL,
    test_action         TEXT NOT NULL DEFAULT '',
    test_input          TEXT NOT NULL DEFAULT '',
    expected_result     TEXT NOT NULL DEFAULT '',
    case_type           TEXT NOT NULL DEFAULT 'happy_path', -- 'happy_path' | 'edge_case' | 'negative' | 'regression'
    source              TEXT NOT NULL DEFAULT 'user_added',
    status              TEXT NOT NULL DEFAULT 'draft',
    lifecycle_status    TEXT NOT NULL DEFAULT 'active',
    created_by          TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by          TEXT,
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    version             INTEGER NOT NULL DEFAULT 1
);

-- ============================================================
-- WORKFLOW PARTICIPANTS, RASIC, PATHS  (Phase 2)
-- ============================================================

-- Unified register of every human role and AI agent that participates
-- in a workflow. One row per participant per workflow.
CREATE TABLE IF NOT EXISTS asdlc_workflow_participant (
    workflow_participant_id TEXT PRIMARY KEY,
    workflow_id             TEXT NOT NULL REFERENCES asdlc_workflow(workflow_id),
    project_id              TEXT REFERENCES asdlc_project(project_id),
    slug                    TEXT,                    -- P-### per project
    participant_type        TEXT NOT NULL CHECK (participant_type IN ('Orchestrator Agent','Specialist Agent','Human Role','Human Coordinator')),
    agent_spec_id           TEXT REFERENCES asdlc_agent_spec(agent_spec_id),   -- set when type is Agent
    human_role_name         TEXT,                    -- set when type is Human
    purpose_in_workflow     TEXT,
    authority_level         TEXT CHECK (authority_level IS NULL OR authority_level IN ('Advise only','Draft only','Execute (human)','Execute (gated)','Execute (autonomous)')),
    handoff_method          TEXT CHECK (handoff_method IS NULL OR handoff_method IN ('Task creation','Assignment','Comment','Panel response','Notification','Other')),
    inputs_required         TEXT,
    outputs_produced        TEXT,
    swimlane_display_name   TEXT,
    lane_order              INTEGER,
    include_in_swimlane     INTEGER NOT NULL DEFAULT 1,
    include_in_rasic        INTEGER NOT NULL DEFAULT 1,
    rasic_column_display_name TEXT,
    rasic_column_order      INTEGER,
    engagement_channel      TEXT,
    notes                   TEXT,
    visibility_scope        TEXT NOT NULL DEFAULT 'PROJECT',
    lifecycle_status        TEXT NOT NULL DEFAULT 'active',
    created_by              TEXT,
    created_at              TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by              TEXT,
    updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
    version                 INTEGER NOT NULL DEFAULT 1
);

-- Structured M:N RASIC assignments: step × participant → code(s).
-- Multiple rows allowed per (step, participant) — one per code.
CREATE TABLE IF NOT EXISTS asdlc_workflow_step_rasic (
    rasic_id                TEXT PRIMARY KEY,
    workflow_step_id        TEXT NOT NULL REFERENCES asdlc_workflow_step(workflow_step_id),
    workflow_participant_id TEXT NOT NULL REFERENCES asdlc_workflow_participant(workflow_participant_id),
    project_id              TEXT REFERENCES asdlc_project(project_id),
    code                    TEXT NOT NULL CHECK (code IN ('R','A','S','C','I')),
    created_by              TEXT,
    created_at              TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by              TEXT,
    updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(workflow_step_id, workflow_participant_id, code)
);

-- Explicit step-to-step routing with branching support.
CREATE TABLE IF NOT EXISTS asdlc_workflow_path (
    workflow_path_id        TEXT PRIMARY KEY,
    workflow_id             TEXT NOT NULL REFERENCES asdlc_workflow(workflow_id),
    project_id              TEXT REFERENCES asdlc_project(project_id),
    slug                    TEXT,                    -- PATH-### per project
    from_step_id            TEXT NOT NULL REFERENCES asdlc_workflow_step(workflow_step_id),
    to_step_id              TEXT NOT NULL REFERENCES asdlc_workflow_step(workflow_step_id),
    branch_label            TEXT,
    branch_condition        TEXT,
    is_default_path         INTEGER NOT NULL DEFAULT 0,
    notes                   TEXT,
    created_by              TEXT,
    created_at              TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by              TEXT,
    updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
    version                 INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_wp_workflow    ON asdlc_workflow_participant(workflow_id);
CREATE INDEX IF NOT EXISTS idx_rasic_step     ON asdlc_workflow_step_rasic(workflow_step_id);
CREATE INDEX IF NOT EXISTS idx_rasic_part     ON asdlc_workflow_step_rasic(workflow_participant_id);
CREATE INDEX IF NOT EXISTS idx_path_workflow  ON asdlc_workflow_path(workflow_id);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_ac_project_parent ON asdlc_acceptance_criterion(project_id, parent_type, parent_id);
CREATE INDEX IF NOT EXISTS idx_tc_project_scope  ON asdlc_test_case(project_id, scope, scope_entity_id);

-- ============================================================
-- REQUIREMENTS (Functional & Non-Functional)
-- ============================================================

-- Functional requirements — populated by LLM from ingested source docs.
-- use_case_id is nullable; a NULL use_case_id means the requirement is orphaned
-- (not yet traced to a use case). status defaults to 'draft' for human review.
CREATE TABLE IF NOT EXISTS asdlc_functional_req (
    fr_id               TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL REFERENCES asdlc_project(project_id),
    use_case_id         TEXT REFERENCES asdlc_use_case(use_case_id),
    ingest_id           TEXT REFERENCES asdlc_ingest_document(ingest_id),
    slug                TEXT,                        -- FR-001 per project
    title               TEXT NOT NULL,
    description         TEXT NOT NULL DEFAULT '',
    actors              TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
    preconditions       TEXT NOT NULL DEFAULT '',
    postconditions      TEXT NOT NULL DEFAULT '',
    priority            TEXT NOT NULL DEFAULT 'must_have'
        CHECK (priority IN ('must_have','should_have','could_have','wont_have')),
    acceptance_criteria TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
    dependencies        TEXT NOT NULL DEFAULT '[]',  -- JSON array of FR/NFR slugs
    source              TEXT NOT NULL DEFAULT '',    -- person name or meeting + date
    status              TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','approved','implemented','verified','deleted')),
    deleted_at          TEXT,
    created_by          TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by          TEXT,
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    version             INTEGER NOT NULL DEFAULT 1
);

-- Non-functional requirements — same LLM population pattern.
CREATE TABLE IF NOT EXISTS asdlc_nonfunctional_req (
    nfr_id              TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL REFERENCES asdlc_project(project_id),
    use_case_id         TEXT REFERENCES asdlc_use_case(use_case_id),
    ingest_id           TEXT REFERENCES asdlc_ingest_document(ingest_id),
    slug                TEXT,                        -- NFR-001 per project
    title               TEXT NOT NULL,
    category            TEXT NOT NULL DEFAULT '',    -- Performance, Security, Scalability, etc.
    description         TEXT NOT NULL DEFAULT '',
    measurable_target   TEXT NOT NULL DEFAULT '',    -- e.g. "p95 < 2s", "99.9% uptime"
    verification_method TEXT NOT NULL DEFAULT '',
    priority            TEXT NOT NULL DEFAULT 'must_have'
        CHECK (priority IN ('must_have','should_have','could_have','wont_have')),
    dependencies        TEXT NOT NULL DEFAULT '[]',  -- JSON array of FR/NFR slugs
    source              TEXT NOT NULL DEFAULT '',
    status              TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','approved','implemented','verified','deleted')),
    deleted_at          TEXT,
    created_by          TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by          TEXT,
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    version             INTEGER NOT NULL DEFAULT 1
);

-- Change log for requirements — child records, one row per change event.
-- Covers both functional and nonfunctional requirements via req_type discriminator.
CREATE TABLE IF NOT EXISTS asdlc_requirement_change_log (
    log_id      TEXT PRIMARY KEY,
    req_type    TEXT NOT NULL CHECK (req_type IN ('functional','nonfunctional')),
    req_id      TEXT NOT NULL,   -- fr_id or nfr_id
    project_id  TEXT NOT NULL REFERENCES asdlc_project(project_id),
    action      TEXT NOT NULL CHECK (action IN ('Added','Modified','Deleted')),
    note        TEXT NOT NULL DEFAULT '',
    changed_by  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Requirement → design-element traceability links. Enables multi-level conflict
-- detection (requirement vs the agents/workflows/tools/steps that implement it).
-- Soft-FK pattern (like asdlc_requirement_change_log): req_id and entity_id are
-- stored as plain values, not FK constraints, because the target table varies.
-- Links are AI-proposed during ingest (status='proposed') and human-confirmed /
-- edited afterward; manual links default to 'confirmed'.
CREATE TABLE IF NOT EXISTS asdlc_requirement_link (
    link_id         TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES asdlc_project(project_id),
    req_type        TEXT NOT NULL CHECK (req_type IN ('functional','nonfunctional')),
    req_id          TEXT NOT NULL,   -- fr_id or nfr_id
    entity_type     TEXT NOT NULL
        CHECK (entity_type IN ('use_case','workflow','workflow_step','agent_spec','tool')),
    entity_id       TEXT NOT NULL,   -- soft ref into the target table
    relationship    TEXT NOT NULL DEFAULT 'implements',
    confidence      REAL,            -- 0..1 for AI-proposed links; NULL for manual
    status          TEXT NOT NULL DEFAULT 'proposed'
        CHECK (status IN ('proposed','confirmed','rejected')),
    source          TEXT NOT NULL DEFAULT 'manual'
        CHECK (source IN ('agent_ingest','manual')),
    lifecycle_status TEXT NOT NULL DEFAULT 'active',
    created_by      TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by      TEXT,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    version         INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_fr_project    ON asdlc_functional_req(project_id);
CREATE INDEX IF NOT EXISTS idx_fr_uc         ON asdlc_functional_req(use_case_id);
CREATE INDEX IF NOT EXISTS idx_nfr_project   ON asdlc_nonfunctional_req(project_id);
CREATE INDEX IF NOT EXISTS idx_nfr_uc        ON asdlc_nonfunctional_req(use_case_id);
CREATE INDEX IF NOT EXISTS idx_reqlog_req    ON asdlc_requirement_change_log(req_type, req_id);
CREATE INDEX IF NOT EXISTS idx_reqlink_req    ON asdlc_requirement_link(project_id, req_type, req_id);
CREATE INDEX IF NOT EXISTS idx_reqlink_entity ON asdlc_requirement_link(project_id, entity_type, entity_id);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_project_client ON asdlc_project(client_id);
CREATE INDEX IF NOT EXISTS idx_pm_project ON asdlc_project_member(project_id);
CREATE INDEX IF NOT EXISTS idx_pm_user ON asdlc_project_member(user_id);
CREATE INDEX IF NOT EXISTS idx_uc_project ON asdlc_use_case(project_id);
CREATE INDEX IF NOT EXISTS idx_cp_project ON asdlc_change_packet(project_id);
CREATE INDEX IF NOT EXISTS idx_cp_status ON asdlc_change_packet(status);
CREATE INDEX IF NOT EXISTS idx_cpi_cp ON asdlc_change_packet_item(change_packet_id);
CREATE INDEX IF NOT EXISTS idx_exc_project ON asdlc_exception(project_id);
CREATE INDEX IF NOT EXISTS idx_exc_status ON asdlc_exception(status);
CREATE INDEX IF NOT EXISTS idx_bl_project ON asdlc_baseline(project_id);
CREATE INDEX IF NOT EXISTS idx_ev_project ON asdlc_evidence_source(project_id);
CREATE INDEX IF NOT EXISTS idx_audit_table ON asdlc_audit_log(table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_audit_time ON asdlc_audit_log(changed_at);
