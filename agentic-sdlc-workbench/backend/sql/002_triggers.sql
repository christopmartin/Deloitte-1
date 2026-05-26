-- =============================================================================
-- Agentic SDLC Workbench — Audit Triggers
-- =============================================================================

-- Generic audit function — called by per-table triggers
CREATE OR REPLACE FUNCTION asdlc_audit_fn()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_record_id UUID;
    v_changed_by UUID;
    v_old_data   JSONB;
    v_new_data   JSONB;
BEGIN
    v_changed_by := NULLIF(current_setting('app.current_user_id', true), '')::UUID;

    IF (TG_OP = 'DELETE') THEN
        v_record_id := (row_to_json(OLD) ->> (TG_TABLE_NAME::text || '_id'))::UUID;
        v_old_data  := to_jsonb(OLD);
        v_new_data  := NULL;
    ELSIF (TG_OP = 'INSERT') THEN
        v_record_id := (row_to_json(NEW) ->> (TG_TABLE_NAME::text || '_id'))::UUID;
        v_old_data  := NULL;
        v_new_data  := to_jsonb(NEW);
    ELSE
        v_record_id := (row_to_json(NEW) ->> (TG_TABLE_NAME::text || '_id'))::UUID;
        v_old_data  := to_jsonb(OLD);
        v_new_data  := to_jsonb(NEW);
    END IF;

    INSERT INTO asdlc_audit_log (table_name, record_id, operation, old_data, new_data, changed_by)
    VALUES (TG_TABLE_NAME, v_record_id, TG_OP, v_old_data, v_new_data, v_changed_by);

    RETURN NULL;
END;
$$;

-- updated_at auto-update function
CREATE OR REPLACE FUNCTION asdlc_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

-- Macro to create audit + updated_at triggers for a table
-- Called individually for each table below

-- asdlc_client
DROP TRIGGER IF EXISTS trg_audit_asdlc_client ON asdlc_client;
CREATE TRIGGER trg_audit_asdlc_client
    AFTER INSERT OR UPDATE OR DELETE ON asdlc_client
    FOR EACH ROW EXECUTE FUNCTION asdlc_audit_fn();

DROP TRIGGER IF EXISTS trg_updated_at_asdlc_client ON asdlc_client;
CREATE TRIGGER trg_updated_at_asdlc_client
    BEFORE UPDATE ON asdlc_client
    FOR EACH ROW EXECUTE FUNCTION asdlc_set_updated_at();

-- asdlc_project
DROP TRIGGER IF EXISTS trg_audit_asdlc_project ON asdlc_project;
CREATE TRIGGER trg_audit_asdlc_project
    AFTER INSERT OR UPDATE OR DELETE ON asdlc_project
    FOR EACH ROW EXECUTE FUNCTION asdlc_audit_fn();

DROP TRIGGER IF EXISTS trg_updated_at_asdlc_project ON asdlc_project;
CREATE TRIGGER trg_updated_at_asdlc_project
    BEFORE UPDATE ON asdlc_project
    FOR EACH ROW EXECUTE FUNCTION asdlc_set_updated_at();

-- asdlc_project_member
DROP TRIGGER IF EXISTS trg_audit_asdlc_project_member ON asdlc_project_member;
CREATE TRIGGER trg_audit_asdlc_project_member
    AFTER INSERT OR UPDATE OR DELETE ON asdlc_project_member
    FOR EACH ROW EXECUTE FUNCTION asdlc_audit_fn();

-- asdlc_project_agent_setting
DROP TRIGGER IF EXISTS trg_audit_asdlc_project_agent_setting ON asdlc_project_agent_setting;
CREATE TRIGGER trg_audit_asdlc_project_agent_setting
    AFTER INSERT OR UPDATE OR DELETE ON asdlc_project_agent_setting
    FOR EACH ROW EXECUTE FUNCTION asdlc_audit_fn();

DROP TRIGGER IF EXISTS trg_updated_at_asdlc_project_agent_setting ON asdlc_project_agent_setting;
CREATE TRIGGER trg_updated_at_asdlc_project_agent_setting
    BEFORE UPDATE ON asdlc_project_agent_setting
    FOR EACH ROW EXECUTE FUNCTION asdlc_set_updated_at();

-- asdlc_use_case
DROP TRIGGER IF EXISTS trg_audit_asdlc_use_case ON asdlc_use_case;
CREATE TRIGGER trg_audit_asdlc_use_case
    AFTER INSERT OR UPDATE OR DELETE ON asdlc_use_case
    FOR EACH ROW EXECUTE FUNCTION asdlc_audit_fn();

DROP TRIGGER IF EXISTS trg_updated_at_asdlc_use_case ON asdlc_use_case;
CREATE TRIGGER trg_updated_at_asdlc_use_case
    BEFORE UPDATE ON asdlc_use_case
    FOR EACH ROW EXECUTE FUNCTION asdlc_set_updated_at();

-- asdlc_workflow
DROP TRIGGER IF EXISTS trg_audit_asdlc_workflow ON asdlc_workflow;
CREATE TRIGGER trg_audit_asdlc_workflow
    AFTER INSERT OR UPDATE OR DELETE ON asdlc_workflow
    FOR EACH ROW EXECUTE FUNCTION asdlc_audit_fn();

DROP TRIGGER IF EXISTS trg_updated_at_asdlc_workflow ON asdlc_workflow;
CREATE TRIGGER trg_updated_at_asdlc_workflow
    BEFORE UPDATE ON asdlc_workflow
    FOR EACH ROW EXECUTE FUNCTION asdlc_set_updated_at();

-- asdlc_workflow_step
DROP TRIGGER IF EXISTS trg_audit_asdlc_workflow_step ON asdlc_workflow_step;
CREATE TRIGGER trg_audit_asdlc_workflow_step
    AFTER INSERT OR UPDATE OR DELETE ON asdlc_workflow_step
    FOR EACH ROW EXECUTE FUNCTION asdlc_audit_fn();

DROP TRIGGER IF EXISTS trg_updated_at_asdlc_workflow_step ON asdlc_workflow_step;
CREATE TRIGGER trg_updated_at_asdlc_workflow_step
    BEFORE UPDATE ON asdlc_workflow_step
    FOR EACH ROW EXECUTE FUNCTION asdlc_set_updated_at();

-- asdlc_hitl_gate
DROP TRIGGER IF EXISTS trg_audit_asdlc_hitl_gate ON asdlc_hitl_gate;
CREATE TRIGGER trg_audit_asdlc_hitl_gate
    AFTER INSERT OR UPDATE OR DELETE ON asdlc_hitl_gate
    FOR EACH ROW EXECUTE FUNCTION asdlc_audit_fn();

-- asdlc_agent_spec
DROP TRIGGER IF EXISTS trg_audit_asdlc_agent_spec ON asdlc_agent_spec;
CREATE TRIGGER trg_audit_asdlc_agent_spec
    AFTER INSERT OR UPDATE OR DELETE ON asdlc_agent_spec
    FOR EACH ROW EXECUTE FUNCTION asdlc_audit_fn();

DROP TRIGGER IF EXISTS trg_updated_at_asdlc_agent_spec ON asdlc_agent_spec;
CREATE TRIGGER trg_updated_at_asdlc_agent_spec
    BEFORE UPDATE ON asdlc_agent_spec
    FOR EACH ROW EXECUTE FUNCTION asdlc_set_updated_at();

-- asdlc_tool
DROP TRIGGER IF EXISTS trg_audit_asdlc_tool ON asdlc_tool;
CREATE TRIGGER trg_audit_asdlc_tool
    AFTER INSERT OR UPDATE OR DELETE ON asdlc_tool
    FOR EACH ROW EXECUTE FUNCTION asdlc_audit_fn();

DROP TRIGGER IF EXISTS trg_updated_at_asdlc_tool ON asdlc_tool;
CREATE TRIGGER trg_updated_at_asdlc_tool
    BEFORE UPDATE ON asdlc_tool
    FOR EACH ROW EXECUTE FUNCTION asdlc_set_updated_at();

-- asdlc_knowledge_article
DROP TRIGGER IF EXISTS trg_audit_asdlc_knowledge_article ON asdlc_knowledge_article;
CREATE TRIGGER trg_audit_asdlc_knowledge_article
    AFTER INSERT OR UPDATE OR DELETE ON asdlc_knowledge_article
    FOR EACH ROW EXECUTE FUNCTION asdlc_audit_fn();

DROP TRIGGER IF EXISTS trg_updated_at_asdlc_knowledge_article ON asdlc_knowledge_article;
CREATE TRIGGER trg_updated_at_asdlc_knowledge_article
    BEFORE UPDATE ON asdlc_knowledge_article
    FOR EACH ROW EXECUTE FUNCTION asdlc_set_updated_at();

-- asdlc_evidence_source
DROP TRIGGER IF EXISTS trg_audit_asdlc_evidence_source ON asdlc_evidence_source;
CREATE TRIGGER trg_audit_asdlc_evidence_source
    AFTER INSERT OR UPDATE OR DELETE ON asdlc_evidence_source
    FOR EACH ROW EXECUTE FUNCTION asdlc_audit_fn();

DROP TRIGGER IF EXISTS trg_updated_at_asdlc_evidence_source ON asdlc_evidence_source;
CREATE TRIGGER trg_updated_at_asdlc_evidence_source
    BEFORE UPDATE ON asdlc_evidence_source
    FOR EACH ROW EXECUTE FUNCTION asdlc_set_updated_at();

-- asdlc_change_packet
DROP TRIGGER IF EXISTS trg_audit_asdlc_change_packet ON asdlc_change_packet;
CREATE TRIGGER trg_audit_asdlc_change_packet
    AFTER INSERT OR UPDATE OR DELETE ON asdlc_change_packet
    FOR EACH ROW EXECUTE FUNCTION asdlc_audit_fn();

DROP TRIGGER IF EXISTS trg_updated_at_asdlc_change_packet ON asdlc_change_packet;
CREATE TRIGGER trg_updated_at_asdlc_change_packet
    BEFORE UPDATE ON asdlc_change_packet
    FOR EACH ROW EXECUTE FUNCTION asdlc_set_updated_at();

-- asdlc_exception
DROP TRIGGER IF EXISTS trg_audit_asdlc_exception ON asdlc_exception;
CREATE TRIGGER trg_audit_asdlc_exception
    AFTER INSERT OR UPDATE OR DELETE ON asdlc_exception
    FOR EACH ROW EXECUTE FUNCTION asdlc_audit_fn();

DROP TRIGGER IF EXISTS trg_updated_at_asdlc_exception ON asdlc_exception;
CREATE TRIGGER trg_updated_at_asdlc_exception
    BEFORE UPDATE ON asdlc_exception
    FOR EACH ROW EXECUTE FUNCTION asdlc_set_updated_at();

-- asdlc_baseline
DROP TRIGGER IF EXISTS trg_audit_asdlc_baseline ON asdlc_baseline;
CREATE TRIGGER trg_audit_asdlc_baseline
    AFTER INSERT OR UPDATE OR DELETE ON asdlc_baseline
    FOR EACH ROW EXECUTE FUNCTION asdlc_audit_fn();

DROP TRIGGER IF EXISTS trg_updated_at_asdlc_baseline ON asdlc_baseline;
CREATE TRIGGER trg_updated_at_asdlc_baseline
    BEFORE UPDATE ON asdlc_baseline
    FOR EACH ROW EXECUTE FUNCTION asdlc_set_updated_at();

-- asdlc_report_export
DROP TRIGGER IF EXISTS trg_audit_asdlc_report_export ON asdlc_report_export;
CREATE TRIGGER trg_audit_asdlc_report_export
    AFTER INSERT OR UPDATE OR DELETE ON asdlc_report_export
    FOR EACH ROW EXECUTE FUNCTION asdlc_audit_fn();

DROP TRIGGER IF EXISTS trg_updated_at_asdlc_report_export ON asdlc_report_export;
CREATE TRIGGER trg_updated_at_asdlc_report_export
    BEFORE UPDATE ON asdlc_report_export
    FOR EACH ROW EXECUTE FUNCTION asdlc_set_updated_at();
