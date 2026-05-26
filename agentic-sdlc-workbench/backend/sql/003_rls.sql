-- =============================================================================
-- Agentic SDLC Workbench — Row-Level Security Policies
-- =============================================================================
-- The application sets:  SET LOCAL app.current_user_id = '<uuid>';
-- at the start of each transaction via middleware.
-- asdlc_app role (owner) bypasses RLS for migrations and seeding.
-- =============================================================================

-- Helper: get the current app user ID safely
CREATE OR REPLACE FUNCTION asdlc_current_user_id()
RETURNS UUID LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN NULLIF(current_setting('app.current_user_id', true), '')::UUID;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$;

-- ---- asdlc_project ----
ALTER TABLE asdlc_project ENABLE ROW LEVEL SECURITY;
ALTER TABLE asdlc_project FORCE ROW LEVEL SECURITY;

CREATE POLICY project_select ON asdlc_project FOR SELECT
    USING (
        project_id IN (
            SELECT project_id FROM asdlc_project_member
            WHERE user_id = asdlc_current_user_id() AND active = TRUE
        )
        OR asdlc_current_user_id() IN (
            SELECT user_id FROM asdlc_user WHERE role = 'admin'
        )
    );

CREATE POLICY project_modify ON asdlc_project FOR ALL
    USING (
        project_id IN (
            SELECT pm.project_id FROM asdlc_project_member pm
            WHERE pm.user_id = asdlc_current_user_id()
              AND pm.member_role IN ('methodology_owner', 'technical')
              AND pm.active = TRUE
        )
        OR asdlc_current_user_id() IN (
            SELECT user_id FROM asdlc_user WHERE role = 'admin'
        )
    );

-- ---- asdlc_project_member ----
ALTER TABLE asdlc_project_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE asdlc_project_member FORCE ROW LEVEL SECURITY;

CREATE POLICY pm_select ON asdlc_project_member FOR SELECT
    USING (
        project_id IN (
            SELECT project_id FROM asdlc_project_member
            WHERE user_id = asdlc_current_user_id() AND active = TRUE
        )
        OR asdlc_current_user_id() IN (
            SELECT user_id FROM asdlc_user WHERE role = 'admin'
        )
    );

CREATE POLICY pm_modify ON asdlc_project_member FOR ALL
    USING (
        asdlc_current_user_id() IN (
            SELECT user_id FROM asdlc_user WHERE role IN ('admin', 'methodology_owner')
        )
    );

-- ---- asdlc_project_agent_setting ----
ALTER TABLE asdlc_project_agent_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE asdlc_project_agent_setting FORCE ROW LEVEL SECURITY;

CREATE POLICY pas_select ON asdlc_project_agent_setting FOR SELECT
    USING (
        project_id IN (
            SELECT project_id FROM asdlc_project_member
            WHERE user_id = asdlc_current_user_id() AND active = TRUE
        )
        OR asdlc_current_user_id() IN (
            SELECT user_id FROM asdlc_user WHERE role = 'admin'
        )
    );

CREATE POLICY pas_modify ON asdlc_project_agent_setting FOR ALL
    USING (
        project_id IN (
            SELECT pm.project_id FROM asdlc_project_member pm
            WHERE pm.user_id = asdlc_current_user_id()
              AND pm.member_role IN ('methodology_owner', 'technical')
              AND pm.active = TRUE
        )
        OR asdlc_current_user_id() IN (
            SELECT user_id FROM asdlc_user WHERE role = 'admin'
        )
    );

-- ---- Design content tables (use_case, workflow, etc.) ----
-- These all use the same project_id pattern + ALL_CLIENTS visibility passthrough

CREATE OR REPLACE FUNCTION asdlc_project_or_global_access(p_project_id UUID, p_scope visibility_scope_t)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
BEGIN
    IF p_scope = 'ALL_CLIENTS' THEN RETURN TRUE; END IF;
    RETURN p_project_id IN (
        SELECT project_id FROM asdlc_project_member
        WHERE user_id = asdlc_current_user_id() AND active = TRUE
    ) OR asdlc_current_user_id() IN (
        SELECT user_id FROM asdlc_user WHERE role = 'admin'
    );
END;
$$;

ALTER TABLE asdlc_use_case ENABLE ROW LEVEL SECURITY;
ALTER TABLE asdlc_use_case FORCE ROW LEVEL SECURITY;
CREATE POLICY uc_access ON asdlc_use_case FOR ALL
    USING (asdlc_project_or_global_access(project_id, visibility_scope));

ALTER TABLE asdlc_process_segment ENABLE ROW LEVEL SECURITY;
ALTER TABLE asdlc_process_segment FORCE ROW LEVEL SECURITY;
CREATE POLICY ps_access ON asdlc_process_segment FOR ALL
    USING (asdlc_project_or_global_access(project_id, visibility_scope));

ALTER TABLE asdlc_workflow ENABLE ROW LEVEL SECURITY;
ALTER TABLE asdlc_workflow FORCE ROW LEVEL SECURITY;
CREATE POLICY wf_access ON asdlc_workflow FOR ALL
    USING (asdlc_project_or_global_access(project_id, visibility_scope));

ALTER TABLE asdlc_workflow_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE asdlc_workflow_step FORCE ROW LEVEL SECURITY;
CREATE POLICY wfs_access ON asdlc_workflow_step FOR ALL
    USING (asdlc_project_or_global_access(project_id, visibility_scope));

ALTER TABLE asdlc_hitl_gate ENABLE ROW LEVEL SECURITY;
ALTER TABLE asdlc_hitl_gate FORCE ROW LEVEL SECURITY;
CREATE POLICY hg_access ON asdlc_hitl_gate FOR ALL
    USING (asdlc_project_or_global_access(project_id, visibility_scope));

ALTER TABLE asdlc_agent_spec ENABLE ROW LEVEL SECURITY;
ALTER TABLE asdlc_agent_spec FORCE ROW LEVEL SECURITY;
CREATE POLICY as_access ON asdlc_agent_spec FOR ALL
    USING (asdlc_project_or_global_access(project_id, visibility_scope));

ALTER TABLE asdlc_tool ENABLE ROW LEVEL SECURITY;
ALTER TABLE asdlc_tool FORCE ROW LEVEL SECURITY;
CREATE POLICY tool_access ON asdlc_tool FOR ALL
    USING (asdlc_project_or_global_access(project_id, visibility_scope));

ALTER TABLE asdlc_agent_tool ENABLE ROW LEVEL SECURITY;
ALTER TABLE asdlc_agent_tool FORCE ROW LEVEL SECURITY;
CREATE POLICY at_access ON asdlc_agent_tool FOR ALL
    USING (asdlc_project_or_global_access(project_id, visibility_scope));

ALTER TABLE asdlc_data_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE asdlc_data_source FORCE ROW LEVEL SECURITY;
CREATE POLICY ds_access ON asdlc_data_source FOR ALL
    USING (asdlc_project_or_global_access(project_id, visibility_scope));

ALTER TABLE asdlc_guardrail ENABLE ROW LEVEL SECURITY;
ALTER TABLE asdlc_guardrail FORCE ROW LEVEL SECURITY;
CREATE POLICY gr_access ON asdlc_guardrail FOR ALL
    USING (asdlc_project_or_global_access(project_id, visibility_scope));

ALTER TABLE asdlc_test_scenario ENABLE ROW LEVEL SECURITY;
ALTER TABLE asdlc_test_scenario FORCE ROW LEVEL SECURITY;
CREATE POLICY ts_access ON asdlc_test_scenario FOR ALL
    USING (asdlc_project_or_global_access(project_id, visibility_scope));

ALTER TABLE asdlc_cost_estimate ENABLE ROW LEVEL SECURITY;
ALTER TABLE asdlc_cost_estimate FORCE ROW LEVEL SECURITY;
CREATE POLICY ce_access ON asdlc_cost_estimate FOR ALL
    USING (asdlc_project_or_global_access(project_id, visibility_scope));

ALTER TABLE asdlc_governance_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE asdlc_governance_control FORCE ROW LEVEL SECURITY;
CREATE POLICY gc_access ON asdlc_governance_control FOR ALL
    USING (asdlc_project_or_global_access(project_id, visibility_scope));

ALTER TABLE asdlc_user_story ENABLE ROW LEVEL SECURITY;
ALTER TABLE asdlc_user_story FORCE ROW LEVEL SECURITY;
CREATE POLICY us_access ON asdlc_user_story FOR ALL
    USING (asdlc_project_or_global_access(project_id, visibility_scope));

ALTER TABLE asdlc_knowledge_article ENABLE ROW LEVEL SECURITY;
ALTER TABLE asdlc_knowledge_article FORCE ROW LEVEL SECURITY;
CREATE POLICY ka_access ON asdlc_knowledge_article FOR ALL
    USING (asdlc_project_or_global_access(project_id, visibility_scope));

ALTER TABLE asdlc_evidence_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE asdlc_evidence_source FORCE ROW LEVEL SECURITY;
CREATE POLICY ev_access ON asdlc_evidence_source FOR ALL
    USING (asdlc_project_or_global_access(project_id, visibility_scope));

ALTER TABLE asdlc_change_packet ENABLE ROW LEVEL SECURITY;
ALTER TABLE asdlc_change_packet FORCE ROW LEVEL SECURITY;
CREATE POLICY cp_access ON asdlc_change_packet FOR ALL
    USING (asdlc_project_or_global_access(project_id, visibility_scope));

ALTER TABLE asdlc_exception ENABLE ROW LEVEL SECURITY;
ALTER TABLE asdlc_exception FORCE ROW LEVEL SECURITY;
CREATE POLICY exc_access ON asdlc_exception FOR ALL
    USING (asdlc_project_or_global_access(project_id, visibility_scope));

ALTER TABLE asdlc_baseline ENABLE ROW LEVEL SECURITY;
ALTER TABLE asdlc_baseline FORCE ROW LEVEL SECURITY;
CREATE POLICY bl_access ON asdlc_baseline FOR ALL
    USING (asdlc_project_or_global_access(project_id, visibility_scope));

ALTER TABLE asdlc_report_export ENABLE ROW LEVEL SECURITY;
ALTER TABLE asdlc_report_export FORCE ROW LEVEL SECURITY;
CREATE POLICY re_access ON asdlc_report_export FOR ALL
    USING (asdlc_project_or_global_access(project_id, visibility_scope));

-- Tables with no RLS (global / admin-only):
--   asdlc_user          — open read, admin-only write (enforced in app layer)
--   asdlc_client        — open read
--   asdlc_agent_catalog — global catalog, open read
--   asdlc_audit_log     — append-only, open read filtered in app layer
--   asdlc_source_reference, asdlc_change_packet_item, asdlc_baseline_item
--       — access controlled via parent record + app layer
