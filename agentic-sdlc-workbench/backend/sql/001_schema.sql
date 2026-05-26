-- =============================================================================
-- Agentic SDLC Workbench — MVP 1 Schema
-- PostgreSQL 16
-- =============================================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- ENUM TYPES
-- =============================================================================

DO $$ BEGIN
  CREATE TYPE visibility_scope_t AS ENUM ('PROJECT', 'CLIENT', 'ALL_CLIENTS');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE lifecycle_status_t AS ENUM ('draft', 'active', 'under_review', 'deprecated', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE user_role_t AS ENUM ('admin', 'methodology_owner', 'reviewer', 'functional_owner', 'technical', 'governance', 'qa', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE project_stage_t AS ENUM ('draft', 'build', 'pilot', 'production', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE member_role_t AS ENUM ('methodology_owner', 'reviewer', 'functional_owner', 'technical', 'governance', 'qa', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hitl_role_t AS ENUM ('approver', 'exception_handler', 'owner');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE agent_type_t AS ENUM ('orchestrator', 'intake', 'change_intake', 'process', 'workflow_design', 'agent_architect', 'cost', 'testing', 'validation', 'governance', 'story', 'reviewer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE supervision_model_t AS ENUM ('Manual', 'Assisted', 'Supervised', 'Autonomous');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE readiness_t AS ENUM ('not_ready', 'ready_for_requirements', 'ready_for_redesign');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE workflow_readiness_t AS ENUM ('draft', 'review', 'approved');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE execution_mode_t AS ENUM ('sync', 'async', 'batch');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE data_sensitivity_t AS ENUM ('public', 'internal', 'confidential', 'restricted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE guardrail_type_t AS ENUM ('must_do', 'must_not_do', 'refusal', 'escalation', 'policy', 'data_protection');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hitl_gate_type_t AS ENUM ('approval', 'review', 'exception');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE test_scenario_type_t AS ENUM ('behavioral', 'edge_case', 'red_team', 'cost', 'performance', 'regression', 'monitoring');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE test_run_result_t AS ENUM ('pass', 'fail', 'not_run');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE cost_band_t AS ENUM ('low', 'med', 'high');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE risk_classification_t AS ENUM ('low', 'medium', 'high', 'critical');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE user_story_type_t AS ENUM ('deterministic', 'prompt', 'skill', 'tool', 'trigger', 'memory', 'test', 'governance');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE source_type_t AS ENUM ('transcript', 'document', 'report_markup', 'corrected_template', 'voice_note', 'ka', 'test_result', 'production_signal', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ingestion_status_t AS ENUM ('new', 'ingested', 'failed', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE evidence_validation_t AS ENUM ('validated', 'unverified', 'conflicting', 'draft');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE confidence_t AS ENUM ('high', 'medium', 'low', 'unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE cp_status_t AS ENUM ('pending', 'approved', 'rejected', 'sent_back', 'split');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE conflict_class_t AS ENUM ('conflict', 'net_new', 'replacing', 'no_impact');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE risk_level_t AS ENUM ('low', 'med', 'high');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE recommended_action_t AS ENUM ('approve', 'reject', 'split', 'send_back', 'review');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE cp_validation_t AS ENUM ('passed', 'failed', 'low_confidence');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE exception_type_t AS ENUM ('conflict', 'failed_validation', 'low_confidence', 'missing_owner', 'missing_evidence', 'governance_sensitive', 'baseline_impacting', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE exception_status_t AS ENUM ('open', 'in_review', 'resolved', 'deferred', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE baseline_type_t AS ENUM ('draft', 'build', 'pilot', 'production', 'post_prod_revision');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE baseline_status_t AS ENUM ('draft', 'approved', 'superseded', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE report_type_t AS ENUM ('consolidated_design', 'template_specific', 'excel_review_pack', 'governance_packet', 'baseline_comparison', 'change_summary', 'traceability', 'exceptions');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE report_format_t AS ENUM ('docx', 'pdf', 'xlsx', 'html');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE report_audience_t AS ENUM ('client_steerco', 'reviewer', 'internal_qa', 'governance');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================================================
-- LAYER 1: WORKSPACE & ACCESS
-- =============================================================================

CREATE TABLE IF NOT EXISTS asdlc_user (
    user_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name    TEXT NOT NULL,
    email           TEXT NOT NULL UNIQUE,
    role            user_role_t NOT NULL DEFAULT 'other',
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS asdlc_client (
    client_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_name             TEXT NOT NULL,
    client_code             TEXT NOT NULL UNIQUE,
    default_visibility_scope visibility_scope_t NOT NULL DEFAULT 'PROJECT',
    notes                   TEXT,
    lifecycle_status        lifecycle_status_t NOT NULL DEFAULT 'active',
    created_by              UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by              UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version                 INT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS asdlc_project (
    project_id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id                       UUID NOT NULL REFERENCES asdlc_client(client_id) ON DELETE RESTRICT,
    project_name                    TEXT NOT NULL,
    project_code                    TEXT NOT NULL,
    stage                           project_stage_t NOT NULL DEFAULT 'draft',
    uses_pilot_baseline             BOOLEAN NOT NULL DEFAULT TRUE,
    inherit_from_project_id         UUID REFERENCES asdlc_project(project_id) ON DELETE RESTRICT,
    default_human_approval_required BOOLEAN NOT NULL DEFAULT TRUE,
    repository_access_model         TEXT NOT NULL DEFAULT 'INTERNAL_ONLY',
    visibility_scope                visibility_scope_t NOT NULL DEFAULT 'PROJECT',
    lifecycle_status                lifecycle_status_t NOT NULL DEFAULT 'active',
    created_by                      UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by                      UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version                         INT NOT NULL DEFAULT 1,
    UNIQUE(client_id, project_code)
);

CREATE TABLE IF NOT EXISTS asdlc_project_member (
    project_member_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          UUID NOT NULL REFERENCES asdlc_project(project_id) ON DELETE RESTRICT,
    user_id             UUID NOT NULL REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    display_name        TEXT NOT NULL,
    member_role         member_role_t NOT NULL DEFAULT 'other',
    can_approve         BOOLEAN NOT NULL DEFAULT FALSE,
    hitl_role           hitl_role_t,
    active              BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, user_id)
);

CREATE TABLE IF NOT EXISTS asdlc_agent_catalog (
    workbench_agent_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_type          agent_type_t NOT NULL UNIQUE,
    agent_name          TEXT NOT NULL,
    purpose             TEXT NOT NULL,
    default_trust_level INT NOT NULL DEFAULT 2 CHECK (default_trust_level BETWEEN 1 AND 5),
    hitl_tags           TEXT[] NOT NULL DEFAULT '{}',
    version             TEXT NOT NULL DEFAULT '1.0',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS asdlc_project_agent_setting (
    project_agent_setting_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id                  UUID NOT NULL REFERENCES asdlc_project(project_id) ON DELETE RESTRICT,
    workbench_agent_id          UUID NOT NULL REFERENCES asdlc_agent_catalog(workbench_agent_id) ON DELETE RESTRICT,
    trust_level                 INT NOT NULL DEFAULT 2 CHECK (trust_level BETWEEN 1 AND 5),
    enabled                     BOOLEAN NOT NULL DEFAULT TRUE,
    allowed_actions             JSONB,
    requires_human_approval     BOOLEAN NOT NULL DEFAULT TRUE,
    notes                       TEXT,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, workbench_agent_id)
);

-- =============================================================================
-- LAYER 2: DESIGN CONTENT
-- =============================================================================

CREATE TABLE IF NOT EXISTS asdlc_use_case (
    use_case_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          UUID REFERENCES asdlc_project(project_id) ON DELETE RESTRICT,
    title               TEXT NOT NULL,
    summary             TEXT NOT NULL DEFAULT '',
    business_objective  TEXT NOT NULL DEFAULT '',
    expected_value      TEXT NOT NULL DEFAULT '',
    users               TEXT NOT NULL DEFAULT '',
    volume_assumptions  JSONB NOT NULL DEFAULT '{}',
    urgency             TEXT,
    success_criteria    TEXT[] NOT NULL DEFAULT '{}',
    constraints         TEXT[] NOT NULL DEFAULT '{}',
    supervision_model   supervision_model_t NOT NULL DEFAULT 'Assisted',
    next_step           TEXT,
    readiness           readiness_t NOT NULL DEFAULT 'not_ready',
    visibility_scope    visibility_scope_t NOT NULL DEFAULT 'PROJECT',
    lifecycle_status    lifecycle_status_t NOT NULL DEFAULT 'draft',
    created_by          UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by          UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version             INT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS asdlc_process_segment (
    process_segment_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    use_case_id             UUID NOT NULL REFERENCES asdlc_use_case(use_case_id) ON DELETE RESTRICT,
    project_id              UUID REFERENCES asdlc_project(project_id) ON DELETE RESTRICT,
    scope_statement         TEXT NOT NULL DEFAULT '',
    as_is_summary           TEXT,
    to_be_summary           TEXT,
    hitl_gate_candidates    TEXT[] NOT NULL DEFAULT '{}',
    process_risks           TEXT[] NOT NULL DEFAULT '{}',
    role_change_assessment  TEXT,
    redesign_required       BOOLEAN NOT NULL DEFAULT FALSE,
    visibility_scope        visibility_scope_t NOT NULL DEFAULT 'PROJECT',
    lifecycle_status        lifecycle_status_t NOT NULL DEFAULT 'draft',
    created_by              UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by              UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version                 INT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS asdlc_workflow (
    workflow_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    use_case_id         UUID NOT NULL REFERENCES asdlc_use_case(use_case_id) ON DELETE RESTRICT,
    project_id          UUID REFERENCES asdlc_project(project_id) ON DELETE RESTRICT,
    name                TEXT NOT NULL,
    trigger             JSONB NOT NULL DEFAULT '{}',
    handoffs            JSONB NOT NULL DEFAULT '[]',
    decisions           JSONB NOT NULL DEFAULT '[]',
    fallback_paths      JSONB NOT NULL DEFAULT '[]',
    workflow_data_needs UUID[],
    readiness           workflow_readiness_t NOT NULL DEFAULT 'draft',
    visibility_scope    visibility_scope_t NOT NULL DEFAULT 'PROJECT',
    lifecycle_status    lifecycle_status_t NOT NULL DEFAULT 'draft',
    created_by          UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by          UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version             INT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS asdlc_workflow_step (
    workflow_step_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id         UUID NOT NULL REFERENCES asdlc_workflow(workflow_id) ON DELETE RESTRICT,
    project_id          UUID REFERENCES asdlc_project(project_id) ON DELETE RESTRICT,
    step_number         INT NOT NULL,
    name                TEXT NOT NULL,
    actor_role          TEXT NOT NULL DEFAULT '',
    owner_member_id     UUID REFERENCES asdlc_project_member(project_member_id) ON DELETE RESTRICT,
    raci                JSONB,
    inputs              JSONB NOT NULL DEFAULT '[]',
    outputs             JSONB NOT NULL DEFAULT '[]',
    decisions           JSONB NOT NULL DEFAULT '[]',
    hitl_gate_id        UUID,
    sla_hours           INT,
    visibility_scope    visibility_scope_t NOT NULL DEFAULT 'PROJECT',
    lifecycle_status    lifecycle_status_t NOT NULL DEFAULT 'draft',
    created_by          UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by          UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version             INT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS asdlc_hitl_gate (
    hitl_gate_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id         UUID NOT NULL REFERENCES asdlc_workflow(workflow_id) ON DELETE RESTRICT,
    workflow_step_id    UUID REFERENCES asdlc_workflow_step(workflow_step_id) ON DELETE RESTRICT,
    project_id          UUID REFERENCES asdlc_project(project_id) ON DELETE RESTRICT,
    gate_type           hitl_gate_type_t NOT NULL DEFAULT 'approval',
    criteria            TEXT NOT NULL DEFAULT '',
    owner_role          TEXT NOT NULL DEFAULT '',
    sla                 TEXT NOT NULL DEFAULT '',
    handoff_mechanism   TEXT NOT NULL DEFAULT '',
    visibility_scope    visibility_scope_t NOT NULL DEFAULT 'PROJECT',
    lifecycle_status    lifecycle_status_t NOT NULL DEFAULT 'active',
    created_by          UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by          UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version             INT NOT NULL DEFAULT 1
);

-- Add FK from workflow_step back to hitl_gate (deferred to avoid circular dependency)
ALTER TABLE asdlc_workflow_step
    ADD CONSTRAINT IF NOT EXISTS fk_ws_hitl_gate
    FOREIGN KEY (hitl_gate_id) REFERENCES asdlc_hitl_gate(hitl_gate_id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS asdlc_agent_spec (
    agent_spec_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    use_case_id         UUID NOT NULL REFERENCES asdlc_use_case(use_case_id) ON DELETE RESTRICT,
    workflow_id         UUID REFERENCES asdlc_workflow(workflow_id) ON DELETE RESTRICT,
    project_id          UUID REFERENCES asdlc_project(project_id) ON DELETE RESTRICT,
    name                TEXT NOT NULL,
    scope               TEXT NOT NULL DEFAULT '',
    instructions        TEXT NOT NULL DEFAULT '',
    goals               TEXT[] NOT NULL DEFAULT '{}',
    done_criteria       TEXT[] NOT NULL DEFAULT '{}',
    inputs              JSONB NOT NULL DEFAULT '{}',
    outputs             JSONB NOT NULL DEFAULT '{}',
    run_as_model        JSONB NOT NULL DEFAULT '{}',
    memory_strategy     JSONB,
    design_risks        TEXT[] NOT NULL DEFAULT '{}',
    visibility_scope    visibility_scope_t NOT NULL DEFAULT 'PROJECT',
    lifecycle_status    lifecycle_status_t NOT NULL DEFAULT 'draft',
    created_by          UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by          UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version             INT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS asdlc_tool (
    tool_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          UUID REFERENCES asdlc_project(project_id) ON DELETE RESTRICT,
    name                TEXT NOT NULL,
    contract            JSONB NOT NULL DEFAULT '{}',
    inputs              JSONB NOT NULL DEFAULT '{}',
    outputs             JSONB NOT NULL DEFAULT '{}',
    errors              JSONB NOT NULL DEFAULT '[]',
    access_requirements JSONB NOT NULL DEFAULT '{}',
    execution_mode      execution_mode_t NOT NULL DEFAULT 'sync',
    cost_impact         JSONB,
    boundaries          TEXT[] NOT NULL DEFAULT '{}',
    visibility_scope    visibility_scope_t NOT NULL DEFAULT 'PROJECT',
    lifecycle_status    lifecycle_status_t NOT NULL DEFAULT 'active',
    created_by          UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by          UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version             INT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS asdlc_agent_tool (
    agent_tool_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_spec_id       UUID NOT NULL REFERENCES asdlc_agent_spec(agent_spec_id) ON DELETE RESTRICT,
    tool_id             UUID NOT NULL REFERENCES asdlc_tool(tool_id) ON DELETE RESTRICT,
    project_id          UUID REFERENCES asdlc_project(project_id) ON DELETE RESTRICT,
    expected_call_count INT,
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(agent_spec_id, tool_id)
);

CREATE TABLE IF NOT EXISTS asdlc_data_source (
    data_source_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          UUID REFERENCES asdlc_project(project_id) ON DELETE RESTRICT,
    source_system       TEXT NOT NULL,
    table_or_document   TEXT NOT NULL DEFAULT '',
    fields              JSONB NOT NULL DEFAULT '[]',
    owner_member_id     UUID REFERENCES asdlc_project_member(project_member_id) ON DELETE RESTRICT,
    sensitivity         data_sensitivity_t NOT NULL DEFAULT 'internal',
    freshness           TEXT NOT NULL DEFAULT '',
    access_rule         JSONB NOT NULL DEFAULT '{}',
    classification_ref  TEXT,
    visibility_scope    visibility_scope_t NOT NULL DEFAULT 'PROJECT',
    lifecycle_status    lifecycle_status_t NOT NULL DEFAULT 'active',
    created_by          UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by          UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version             INT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS asdlc_guardrail (
    guardrail_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          UUID REFERENCES asdlc_project(project_id) ON DELETE RESTRICT,
    guardrail_type      guardrail_type_t NOT NULL DEFAULT 'policy',
    description         TEXT NOT NULL DEFAULT '',
    policy_reference    TEXT,
    agent_spec_id       UUID REFERENCES asdlc_agent_spec(agent_spec_id) ON DELETE RESTRICT,
    severity            TEXT,
    visibility_scope    visibility_scope_t NOT NULL DEFAULT 'PROJECT',
    lifecycle_status    lifecycle_status_t NOT NULL DEFAULT 'active',
    created_by          UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by          UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version             INT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS asdlc_test_scenario (
    test_scenario_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          UUID REFERENCES asdlc_project(project_id) ON DELETE RESTRICT,
    scenario_type       test_scenario_type_t NOT NULL DEFAULT 'behavioral',
    description         TEXT NOT NULL DEFAULT '',
    inputs              JSONB NOT NULL DEFAULT '{}',
    expected_outputs    JSONB NOT NULL DEFAULT '{}',
    pass_criteria       TEXT[] NOT NULL DEFAULT '{}',
    linked_entity_type  TEXT NOT NULL DEFAULT 'use_case',
    linked_entity_id    UUID NOT NULL,
    evidence_required   TEXT[] NOT NULL DEFAULT '{}',
    last_run_result     test_run_result_t DEFAULT 'not_run',
    visibility_scope    visibility_scope_t NOT NULL DEFAULT 'PROJECT',
    lifecycle_status    lifecycle_status_t NOT NULL DEFAULT 'active',
    created_by          UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by          UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version             INT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS asdlc_cost_estimate (
    cost_estimate_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          UUID REFERENCES asdlc_project(project_id) ON DELETE RESTRICT,
    scope_type          TEXT NOT NULL DEFAULT 'use_case',
    scope_id            UUID NOT NULL,
    expected_actions    INT NOT NULL DEFAULT 0,
    expected_assists    INT NOT NULL DEFAULT 0,
    expected_tokens     INT NOT NULL DEFAULT 0,
    volume_assumption   JSONB NOT NULL DEFAULT '{}',
    cost_band           cost_band_t NOT NULL DEFAULT 'med',
    per_execution_cost  NUMERIC(12,4) NOT NULL DEFAULT 0,
    annual_run_cost     NUMERIC(14,4) NOT NULL DEFAULT 0,
    actuals             JSONB,
    variance_pct        NUMERIC(8,4),
    visibility_scope    visibility_scope_t NOT NULL DEFAULT 'PROJECT',
    lifecycle_status    lifecycle_status_t NOT NULL DEFAULT 'active',
    created_by          UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by          UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version             INT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS asdlc_governance_control (
    governance_control_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id              UUID REFERENCES asdlc_project(project_id) ON DELETE RESTRICT,
    risk_classification     risk_classification_t NOT NULL DEFAULT 'medium',
    control_description     TEXT NOT NULL DEFAULT '',
    scope_type              TEXT NOT NULL DEFAULT 'use_case',
    scope_id                UUID NOT NULL,
    approvals_required      JSONB NOT NULL DEFAULT '[]',
    audit_requirements      TEXT[] NOT NULL DEFAULT '{}',
    monitoring_requirements TEXT[] NOT NULL DEFAULT '{}',
    recertification_date    DATE,
    ai_asset_registration   TEXT,
    visibility_scope        visibility_scope_t NOT NULL DEFAULT 'PROJECT',
    lifecycle_status        lifecycle_status_t NOT NULL DEFAULT 'active',
    created_by              UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by              UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version                 INT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS asdlc_user_story (
    user_story_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id              UUID REFERENCES asdlc_project(project_id) ON DELETE RESTRICT,
    story_type              user_story_type_t NOT NULL DEFAULT 'deterministic',
    title                   TEXT NOT NULL,
    description             TEXT NOT NULL DEFAULT '',
    acceptance_criteria     TEXT[] NOT NULL DEFAULT '{}',
    definition_of_ready     JSONB NOT NULL DEFAULT '{}',
    linked_use_case_id      UUID REFERENCES asdlc_use_case(use_case_id) ON DELETE RESTRICT,
    linked_workflow_id      UUID REFERENCES asdlc_workflow(workflow_id) ON DELETE RESTRICT,
    linked_agent_spec_id    UUID REFERENCES asdlc_agent_spec(agent_spec_id) ON DELETE RESTRICT,
    suggested_sprint        TEXT,
    visibility_scope        visibility_scope_t NOT NULL DEFAULT 'PROJECT',
    lifecycle_status        lifecycle_status_t NOT NULL DEFAULT 'draft',
    created_by              UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by              UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version                 INT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS asdlc_knowledge_article (
    knowledge_article_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id              UUID REFERENCES asdlc_project(project_id) ON DELETE RESTRICT,
    title                   TEXT NOT NULL,
    body                    TEXT NOT NULL DEFAULT '',
    trigger                 TEXT,
    linked_use_case_id      UUID REFERENCES asdlc_use_case(use_case_id) ON DELETE RESTRICT,
    linked_workflow_id      UUID REFERENCES asdlc_workflow(workflow_id) ON DELETE RESTRICT,
    approved_by             UUID REFERENCES asdlc_project_member(project_member_id) ON DELETE RESTRICT,
    approved_at             TIMESTAMPTZ,
    next_review_date        DATE,
    visibility_scope        visibility_scope_t NOT NULL DEFAULT 'PROJECT',
    lifecycle_status        lifecycle_status_t NOT NULL DEFAULT 'draft',
    created_by              UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by              UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version                 INT NOT NULL DEFAULT 1
);

-- =============================================================================
-- LAYER 3: FIELD TRUTH & EVIDENCE
-- =============================================================================

CREATE TABLE IF NOT EXISTS asdlc_evidence_source (
    evidence_source_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          UUID REFERENCES asdlc_project(project_id) ON DELETE RESTRICT,
    source_title        TEXT NOT NULL,
    source_type         source_type_t NOT NULL DEFAULT 'document',
    source_url          TEXT NOT NULL DEFAULT '',
    source_datetime     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    uploaded_by         UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    ingestion_status    ingestion_status_t NOT NULL DEFAULT 'new',
    validation_status   evidence_validation_t NOT NULL DEFAULT 'draft',
    transcript_text     TEXT,
    notes               TEXT,
    visibility_scope    visibility_scope_t NOT NULL DEFAULT 'PROJECT',
    lifecycle_status    lifecycle_status_t NOT NULL DEFAULT 'active',
    created_by          UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by          UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version             INT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS asdlc_source_reference (
    source_reference_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evidence_source_id      UUID NOT NULL REFERENCES asdlc_evidence_source(evidence_source_id) ON DELETE RESTRICT,
    reference_label         TEXT NOT NULL,
    timestamp_or_location   TEXT,
    reference_url           TEXT,
    summary                 TEXT,
    confidence              confidence_t NOT NULL DEFAULT 'medium',
    source_datetime         TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- LAYER 4: CHANGE & VALIDATION
-- =============================================================================

CREATE TABLE IF NOT EXISTS asdlc_change_packet (
    change_packet_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id              UUID REFERENCES asdlc_project(project_id) ON DELETE RESTRICT,
    packet_code             TEXT NOT NULL UNIQUE,
    status                  cp_status_t NOT NULL DEFAULT 'pending',
    summary                 TEXT NOT NULL DEFAULT '',
    source_evidence_id      UUID REFERENCES asdlc_evidence_source(evidence_source_id) ON DELETE RESTRICT,
    source_timestamp        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    conflict_classification conflict_class_t NOT NULL DEFAULT 'net_new',
    risk_level              risk_level_t NOT NULL DEFAULT 'med',
    recommended_action      recommended_action_t NOT NULL DEFAULT 'review',
    baseline_impacting      BOOLEAN NOT NULL DEFAULT FALSE,
    validation_status       cp_validation_t NOT NULL DEFAULT 'passed',
    authoring_agent_run_id  UUID,
    approver_member_id      UUID REFERENCES asdlc_project_member(project_member_id) ON DELETE RESTRICT,
    approval_timestamp      TIMESTAMPTZ,
    decision_notes          TEXT,
    design_summary_report_id UUID,
    visibility_scope        visibility_scope_t NOT NULL DEFAULT 'PROJECT',
    lifecycle_status        lifecycle_status_t NOT NULL DEFAULT 'active',
    created_by              UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by              UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version                 INT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS asdlc_change_packet_item (
    change_packet_item_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    change_packet_id        UUID NOT NULL REFERENCES asdlc_change_packet(change_packet_id) ON DELETE RESTRICT,
    entity_type             TEXT NOT NULL,
    entity_id               UUID NOT NULL,
    field_path              TEXT NOT NULL,
    old_value               JSONB,
    new_value               JSONB NOT NULL,
    rationale               TEXT,
    applied_at              TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS asdlc_exception (
    exception_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id              UUID REFERENCES asdlc_project(project_id) ON DELETE RESTRICT,
    exception_type          exception_type_t NOT NULL DEFAULT 'other',
    severity                risk_level_t NOT NULL DEFAULT 'med',
    description             TEXT NOT NULL DEFAULT '',
    related_entity_type     TEXT NOT NULL DEFAULT '',
    related_entity_id       UUID NOT NULL,
    suggested_action        TEXT,
    assigned_member_id      UUID REFERENCES asdlc_project_member(project_member_id) ON DELETE RESTRICT,
    status                  exception_status_t NOT NULL DEFAULT 'open',
    resolution_summary      TEXT,
    raised_by_agent_run_id  UUID,
    change_packet_id        UUID REFERENCES asdlc_change_packet(change_packet_id) ON DELETE RESTRICT,
    visibility_scope        visibility_scope_t NOT NULL DEFAULT 'PROJECT',
    lifecycle_status        lifecycle_status_t NOT NULL DEFAULT 'active',
    created_by              UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by              UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version                 INT NOT NULL DEFAULT 1
);

-- =============================================================================
-- LAYER 5: BASELINES & REPORTING
-- =============================================================================

CREATE TABLE IF NOT EXISTS asdlc_baseline (
    baseline_id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id                      UUID NOT NULL REFERENCES asdlc_project(project_id) ON DELETE RESTRICT,
    baseline_type                   baseline_type_t NOT NULL DEFAULT 'draft',
    baseline_name                   TEXT NOT NULL,
    baseline_version                TEXT,
    baseline_status                 baseline_status_t NOT NULL DEFAULT 'draft',
    summary_of_changes              TEXT,
    parent_baseline_id              UUID REFERENCES asdlc_baseline(baseline_id) ON DELETE RESTRICT,
    created_from_change_packet_id   UUID REFERENCES asdlc_change_packet(change_packet_id) ON DELETE RESTRICT,
    locked_at                       TIMESTAMPTZ,
    locked_by_member_id             UUID REFERENCES asdlc_project_member(project_member_id) ON DELETE RESTRICT,
    record_count                    INT DEFAULT 0,
    field_count                     INT DEFAULT 0,
    visibility_scope                visibility_scope_t NOT NULL DEFAULT 'PROJECT',
    lifecycle_status                lifecycle_status_t NOT NULL DEFAULT 'active',
    created_by                      UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by                      UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version                         INT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS asdlc_baseline_item (
    baseline_item_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    baseline_id         UUID NOT NULL REFERENCES asdlc_baseline(baseline_id) ON DELETE RESTRICT,
    entity_type         TEXT NOT NULL,
    entity_id           UUID NOT NULL,
    field_path          TEXT,
    snapshot_value      JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS asdlc_report_export (
    report_export_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id                  UUID REFERENCES asdlc_project(project_id) ON DELETE RESTRICT,
    report_type                 report_type_t NOT NULL DEFAULT 'consolidated_design',
    baseline_id                 UUID REFERENCES asdlc_baseline(baseline_id) ON DELETE RESTRICT,
    file_url                    TEXT NOT NULL DEFAULT '',
    format                      report_format_t NOT NULL DEFAULT 'docx',
    audience                    report_audience_t NOT NULL DEFAULT 'reviewer',
    client_visible              BOOLEAN NOT NULL DEFAULT FALSE,
    generated_by_agent_run_id   UUID,
    generated_by_member_id      UUID REFERENCES asdlc_project_member(project_member_id) ON DELETE RESTRICT,
    generated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    title                       TEXT NOT NULL DEFAULT '',
    visibility_scope            visibility_scope_t NOT NULL DEFAULT 'PROJECT',
    lifecycle_status            lifecycle_status_t NOT NULL DEFAULT 'active',
    created_by                  UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by                  UUID REFERENCES asdlc_user(user_id) ON DELETE RESTRICT,
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version                     INT NOT NULL DEFAULT 1
);

-- =============================================================================
-- AUDIT LOG (trigger-populated)
-- =============================================================================

CREATE TABLE IF NOT EXISTS asdlc_audit_log (
    audit_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    table_name      TEXT NOT NULL,
    record_id       UUID NOT NULL,
    operation       TEXT NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
    old_data        JSONB,
    new_data        JSONB,
    changed_by      UUID,
    changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- INDEXES
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_project_client ON asdlc_project(client_id);
CREATE INDEX IF NOT EXISTS idx_project_member_project ON asdlc_project_member(project_id);
CREATE INDEX IF NOT EXISTS idx_project_member_user ON asdlc_project_member(user_id);
CREATE INDEX IF NOT EXISTS idx_pas_project ON asdlc_project_agent_setting(project_id);

CREATE INDEX IF NOT EXISTS idx_use_case_project ON asdlc_use_case(project_id);
CREATE INDEX IF NOT EXISTS idx_workflow_use_case ON asdlc_workflow(use_case_id);
CREATE INDEX IF NOT EXISTS idx_workflow_step_workflow ON asdlc_workflow_step(workflow_id);
CREATE INDEX IF NOT EXISTS idx_hitl_gate_workflow ON asdlc_hitl_gate(workflow_id);
CREATE INDEX IF NOT EXISTS idx_agent_spec_use_case ON asdlc_agent_spec(use_case_id);
CREATE INDEX IF NOT EXISTS idx_evidence_project ON asdlc_evidence_source(project_id);
CREATE INDEX IF NOT EXISTS idx_evidence_type ON asdlc_evidence_source(source_type);

CREATE INDEX IF NOT EXISTS idx_cp_project ON asdlc_change_packet(project_id);
CREATE INDEX IF NOT EXISTS idx_cp_status ON asdlc_change_packet(status);
CREATE INDEX IF NOT EXISTS idx_cp_risk ON asdlc_change_packet(risk_level);
CREATE INDEX IF NOT EXISTS idx_cpi_cp ON asdlc_change_packet_item(change_packet_id);
CREATE INDEX IF NOT EXISTS idx_cpi_entity ON asdlc_change_packet_item(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_exception_project ON asdlc_exception(project_id);
CREATE INDEX IF NOT EXISTS idx_exception_status ON asdlc_exception(status);
CREATE INDEX IF NOT EXISTS idx_exception_type ON asdlc_exception(exception_type);

CREATE INDEX IF NOT EXISTS idx_baseline_project ON asdlc_baseline(project_id);
CREATE INDEX IF NOT EXISTS idx_baseline_item_baseline ON asdlc_baseline_item(baseline_id);
CREATE INDEX IF NOT EXISTS idx_baseline_item_entity ON asdlc_baseline_item(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_report_project ON asdlc_report_export(project_id);

CREATE INDEX IF NOT EXISTS idx_audit_table_record ON asdlc_audit_log(table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_audit_changed_at ON asdlc_audit_log(changed_at DESC);
