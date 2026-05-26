-- =============================================================================
-- Agentic SDLC Workbench — Seed Data (MVP 1 Demo)
-- Matches wireframe examples from the UI specification.
-- All inserts use ON CONFLICT DO NOTHING for idempotency.
-- =============================================================================

-- ---- Users ----
INSERT INTO asdlc_user (user_id, display_name, email, role, active) VALUES
  ('11111111-0000-0000-0000-000000000001', 'Chris H.',  'chris.h@internal.example',  'methodology_owner', TRUE),
  ('11111111-0000-0000-0000-000000000002', 'Priya R.',  'priya.r@internal.example',  'reviewer',          TRUE),
  ('11111111-0000-0000-0000-000000000003', 'Sam O.',    'sam.o@internal.example',    'functional_owner',  TRUE),
  ('11111111-0000-0000-0000-000000000004', 'Jordan K.', 'jordan.k@internal.example', 'technical',         TRUE),
  ('11111111-0000-0000-0000-000000000005', 'Nia W.',    'nia.w@internal.example',    'governance',        TRUE)
ON CONFLICT (email) DO NOTHING;

-- ---- Clients ----
INSERT INTO asdlc_client (client_id, client_name, client_code, default_visibility_scope, lifecycle_status, created_by) VALUES
  ('22222222-0000-0000-0000-000000000001', 'ACME Corp',  'ACME',   'PROJECT', 'active', '11111111-0000-0000-0000-000000000001'),
  ('22222222-0000-0000-0000-000000000002', 'BetaCo',     'BETA',   'PROJECT', 'active', '11111111-0000-0000-0000-000000000001'),
  ('22222222-0000-0000-0000-000000000003', 'Gamma Ltd',  'GAMMA',  'PROJECT', 'active', '11111111-0000-0000-0000-000000000001')
ON CONFLICT (client_code) DO NOTHING;

-- ---- Projects ----
INSERT INTO asdlc_project (project_id, client_id, project_name, project_code, stage, uses_pilot_baseline, lifecycle_status, created_by) VALUES
  ('33333333-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000001', 'Pilot 1',        'ACME-P1',    'build',      TRUE,  'active', '11111111-0000-0000-0000-000000000001'),
  ('33333333-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000001', 'Wave 2',         'ACME-W2',    'draft',      TRUE,  'active', '11111111-0000-0000-0000-000000000001'),
  ('33333333-0000-0000-0000-000000000003', '22222222-0000-0000-0000-000000000002', 'Greenfield',     'BETA-GF',    'production', FALSE, 'active', '11111111-0000-0000-0000-000000000001'),
  ('33333333-0000-0000-0000-000000000004', '22222222-0000-0000-0000-000000000003', 'Modernization',  'GAMMA-MOD',  'pilot',      TRUE,  'active', '11111111-0000-0000-0000-000000000001'),
  ('33333333-0000-0000-0000-000000000005', '22222222-0000-0000-0000-000000000002', 'Phase 2',        'BETA-P2',    'draft',      TRUE,  'active', '11111111-0000-0000-0000-000000000001'),
  ('33333333-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000001', 'Innovation Lab', 'ACME-IL',    'draft',      FALSE, 'active', '11111111-0000-0000-0000-000000000001'),
  ('33333333-0000-0000-0000-000000000007', '22222222-0000-0000-0000-000000000003', 'Analytics Hub',  'GAMMA-AH',   'build',      TRUE,  'active', '11111111-0000-0000-0000-000000000001')
ON CONFLICT (client_id, project_code) DO NOTHING;

-- ---- Project Members ----
INSERT INTO asdlc_project_member (project_member_id, project_id, user_id, display_name, member_role, can_approve, hitl_role, active) VALUES
  -- ACME Pilot 1
  ('44444444-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 'Chris H.',  'methodology_owner', TRUE,  'owner',             TRUE),
  ('44444444-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000002', 'Priya R.',  'reviewer',          TRUE,  'approver',          TRUE),
  ('44444444-0000-0000-0000-000000000003', '33333333-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000003', 'Sam O.',    'functional_owner',  FALSE, 'exception_handler', TRUE),
  ('44444444-0000-0000-0000-000000000004', '33333333-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000004', 'Jordan K.', 'technical',         FALSE, NULL,                TRUE),
  -- ACME Wave 2
  ('44444444-0000-0000-0000-000000000005', '33333333-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', 'Chris H.',  'methodology_owner', TRUE,  'owner',    TRUE),
  ('44444444-0000-0000-0000-000000000006', '33333333-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000002', 'Priya R.',  'reviewer',          TRUE,  'approver', TRUE),
  -- BetaCo Greenfield
  ('44444444-0000-0000-0000-000000000007', '33333333-0000-0000-0000-000000000003', '11111111-0000-0000-0000-000000000001', 'Chris H.',  'methodology_owner', TRUE,  'owner',    TRUE),
  ('44444444-0000-0000-0000-000000000008', '33333333-0000-0000-0000-000000000003', '11111111-0000-0000-0000-000000000002', 'Priya R.',  'reviewer',          TRUE,  'approver', TRUE),
  -- Gamma Modernization
  ('44444444-0000-0000-0000-000000000009', '33333333-0000-0000-0000-000000000004', '11111111-0000-0000-0000-000000000001', 'Chris H.',  'methodology_owner', TRUE,  'owner',    TRUE),
  ('44444444-0000-0000-0000-000000000010', '33333333-0000-0000-0000-000000000004', '11111111-0000-0000-0000-000000000005', 'Nia W.',    'governance',        FALSE, NULL,       TRUE),
  -- BetaCo Phase 2
  ('44444444-0000-0000-0000-000000000011', '33333333-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', 'Chris H.',  'methodology_owner', TRUE,  'owner',    TRUE),
  -- ACME Innovation Lab
  ('44444444-0000-0000-0000-000000000012', '33333333-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001', 'Chris H.',  'methodology_owner', TRUE,  'owner',    TRUE),
  -- Gamma Analytics Hub
  ('44444444-0000-0000-0000-000000000013', '33333333-0000-0000-0000-000000000007', '11111111-0000-0000-0000-000000000001', 'Chris H.',  'methodology_owner', TRUE,  'owner',    TRUE),
  ('44444444-0000-0000-0000-000000000014', '33333333-0000-0000-0000-000000000007', '11111111-0000-0000-0000-000000000003', 'Sam O.',    'functional_owner',  FALSE, NULL,       TRUE)
ON CONFLICT (project_id, user_id) DO NOTHING;

-- ---- Agent Catalog ----
INSERT INTO asdlc_agent_catalog (workbench_agent_id, agent_type, agent_name, purpose, default_trust_level, hitl_tags, version) VALUES
  ('55555555-0000-0000-0000-000000000001', 'orchestrator',     'Orchestrator',                  'Routes work, applies approved Change Packets, manages readiness and agent sequencing.',                          3, ARRAY['approver','owner'],             '1.0'),
  ('55555555-0000-0000-0000-000000000002', 'intake',           'Intake Agent',                  'Creates initial structured use case data from stakeholder requests.',                                           2, ARRAY['approver'],                     '1.0'),
  ('55555555-0000-0000-0000-000000000003', 'change_intake',    'Change Intake Agent',           'Assesses new inputs as net-new, replacement, conflict, correction, or enhancement.',                           2, ARRAY['approver'],                     '1.0'),
  ('55555555-0000-0000-0000-000000000004', 'process',          'Process Agent',                 'Determines whether process redesign is needed and drafts process impact.',                                      3, ARRAY['approver','exception_handler'], '1.0'),
  ('55555555-0000-0000-0000-000000000005', 'workflow_design',  'Workflow Design Agent',         'Creates workflow steps, triggers, HITL gates, fallback paths.',                                                 3, ARRAY['approver'],                     '1.0'),
  ('55555555-0000-0000-0000-000000000006', 'agent_architect',  'Agent Architect',               'Creates designed-solution agent specs, tool contracts, guardrails, context strategy.',                          3, ARRAY['approver'],                     '1.0'),
  ('55555555-0000-0000-0000-000000000007', 'cost',             'Cost Agent',                    'Estimates and monitors Assist/token/action consumption and cost variance.',                                      1, ARRAY['approver'],                     '1.0'),
  ('55555555-0000-0000-0000-000000000008', 'testing',          'Testing Agent',                 'Creates and maintains test scenarios and regression packs.',                                                     3, ARRAY['approver'],                     '1.0'),
  ('55555555-0000-0000-0000-000000000009', 'validation',       'Validation Agent',              'Checks source-to-field accuracy and flags failed validation.',                                                   4, ARRAY['exception_handler'],            '1.0'),
  ('55555555-0000-0000-0000-000000000010', 'governance',       'Governance Agent',              'Creates governance readiness, controls, and approval evidence.',                                                 2, ARRAY['approver','exception_handler'], '1.0'),
  ('55555555-0000-0000-0000-000000000011', 'story',            'Story Agent',                   'Creates user stories and acceptance criteria from approved design data.',                                        3, ARRAY['approver'],                     '1.0'),
  ('55555555-0000-0000-0000-000000000012', 'reviewer',         'Reviewer Agent',                'Checks completeness, consistency, traceability, and readiness.',                                                 2, ARRAY['approver','exception_handler'], '1.0')
ON CONFLICT (agent_type) DO NOTHING;

-- ---- Project Agent Settings for ACME Pilot 1 (matching wireframe) ----
INSERT INTO asdlc_project_agent_setting (project_agent_setting_id, project_id, workbench_agent_id, trust_level, enabled, requires_human_approval) VALUES
  ('66666666-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000001', 3, TRUE,  FALSE),  -- Orchestrator
  ('66666666-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000002', 2, TRUE,  TRUE),   -- Intake
  ('66666666-0000-0000-0000-000000000003', '33333333-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000003', 2, TRUE,  TRUE),   -- Change Intake
  ('66666666-0000-0000-0000-000000000004', '33333333-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000004', 3, TRUE,  TRUE),   -- Process
  ('66666666-0000-0000-0000-000000000005', '33333333-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 3, TRUE,  TRUE),   -- Workflow Design
  ('66666666-0000-0000-0000-000000000006', '33333333-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000006', 3, TRUE,  TRUE),   -- Agent Architect
  ('66666666-0000-0000-0000-000000000007', '33333333-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000007', 1, FALSE, TRUE),   -- Cost (disabled)
  ('66666666-0000-0000-0000-000000000008', '33333333-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000008', 3, TRUE,  TRUE),   -- Testing
  ('66666666-0000-0000-0000-000000000009', '33333333-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000009', 4, TRUE,  FALSE),  -- Validation
  ('66666666-0000-0000-0000-000000000010', '33333333-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000010', 2, FALSE, TRUE),   -- Governance (disabled)
  ('66666666-0000-0000-0000-000000000011', '33333333-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000011', 3, TRUE,  TRUE),   -- Story
  ('66666666-0000-0000-0000-000000000012', '33333333-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000012', 2, TRUE,  TRUE)    -- Reviewer
ON CONFLICT (project_id, workbench_agent_id) DO NOTHING;

-- ---- Use Cases ----
INSERT INTO asdlc_use_case (use_case_id, project_id, title, summary, business_objective, supervision_model, readiness, visibility_scope, lifecycle_status, created_by) VALUES
  ('77777777-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000001',
   'Order Operations Automation',
   'Automate held order review and escalation using AI-assisted triage and routing.',
   'Reduce average handle time for held orders by 40% while maintaining SLA compliance.',
   'Supervised', 'ready_for_requirements', 'PROJECT', 'active', '11111111-0000-0000-0000-000000000001'),
  ('77777777-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000001',
   'Customer Notification Engine',
   'Proactive outbound notifications for order status changes with personalization.',
   'Reduce inbound WISMO calls by 30%.',
   'Assisted', 'not_ready', 'PROJECT', 'draft', '11111111-0000-0000-0000-000000000001')
ON CONFLICT DO NOTHING;

-- ---- Workflows ----
INSERT INTO asdlc_workflow (workflow_id, use_case_id, project_id, name, trigger, readiness, visibility_scope, lifecycle_status, created_by) VALUES
  ('88888888-0000-0000-0000-000000000001', '77777777-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000001',
   'WF-014: Held Order Triage',
   '{"type": "event", "source": "OMS", "condition": "order_status = HELD"}',
   'approved', 'PROJECT', 'active', '11111111-0000-0000-0000-000000000001')
ON CONFLICT DO NOTHING;

-- ---- Workflow Steps ----
INSERT INTO asdlc_workflow_step (workflow_step_id, workflow_id, project_id, step_number, name, actor_role, owner_member_id, sla_hours, visibility_scope, lifecycle_status, created_by) VALUES
  ('99999999-0000-0000-0000-000000000001', '88888888-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000001', 1, 'Detect held order',       'System',          NULL,                                        NULL, 'PROJECT', 'active', '11111111-0000-0000-0000-000000000001'),
  ('99999999-0000-0000-0000-000000000002', '88888888-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000001', 2, 'Classify hold reason',    'AI Agent',        NULL,                                        NULL, 'PROJECT', 'active', '11111111-0000-0000-0000-000000000001'),
  ('99999999-0000-0000-0000-000000000003', '88888888-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000001', 3, 'Route to team',           'Orchestrator',    NULL,                                        NULL, 'PROJECT', 'active', '11111111-0000-0000-0000-000000000001'),
  ('99999999-0000-0000-0000-000000000004', '88888888-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000001', 4, 'Human review & decision', 'Functional Owner','44444444-0000-0000-0000-000000000002',  24,   'PROJECT', 'active', '11111111-0000-0000-0000-000000000001'),
  ('99999999-0000-0000-0000-000000000005', '88888888-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000001', 5, 'Apply resolution',        'System',          NULL,                                        NULL, 'PROJECT', 'active', '11111111-0000-0000-0000-000000000001')
ON CONFLICT DO NOTHING;

-- ---- Evidence Sources ----
INSERT INTO asdlc_evidence_source (evidence_source_id, project_id, source_title, source_type, source_url, source_datetime, uploaded_by, ingestion_status, validation_status, notes, visibility_scope, lifecycle_status, created_by) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000001',
   'SME interview · Order ops · 2026-04-22', 'transcript',
   '/uploads/T-118-sme-interview.txt', '2026-04-22 14:30:00+00',
   '11111111-0000-0000-0000-000000000002', 'ingested', 'validated',
   'Full transcript of order operations SME session. 14 field values extracted.',
   'PROJECT', 'active', '11111111-0000-0000-0000-000000000001'),
  ('aaaaaaaa-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000001',
   'Marked-up Q1 design report', 'report_markup',
   '/uploads/R-044-q1-design-markup.docx', '2026-04-15 09:00:00+00',
   '11111111-0000-0000-0000-000000000002', 'ingested', 'validated',
   '32 field values extracted from reviewer markup.',
   'PROJECT', 'active', '11111111-0000-0000-0000-000000000001'),
  ('aaaaaaaa-0000-0000-0000-000000000003', '33333333-0000-0000-0000-000000000001',
   'Corrected Workflow Step Map (Excel)', 'corrected_template',
   '/uploads/TPL-009-workflow-step-map.xlsx', '2026-04-10 11:00:00+00',
   '11111111-0000-0000-0000-000000000003', 'ingested', 'unverified',
   '61 field values extracted. Needs verification against transcript.',
   'PROJECT', 'active', '11111111-0000-0000-0000-000000000001'),
  ('aaaaaaaa-0000-0000-0000-000000000004', '33333333-0000-0000-0000-000000000001',
   'How to escalate a held order', 'ka',
   '/kb/KA-3001', '2026-04-08 08:00:00+00',
   '11111111-0000-0000-0000-000000000001', 'ingested', 'validated',
   '4 field values linked. Story Agent drafted from this KA.',
   'PROJECT', 'active', '11111111-0000-0000-0000-000000000001'),
  ('aaaaaaaa-0000-0000-0000-000000000005', '33333333-0000-0000-0000-000000000001',
   'Production: avg handle time +18%', 'production_signal',
   '/signals/SIG-77', '2026-05-03 06:00:00+00',
   '11111111-0000-0000-0000-000000000004', 'ingested', 'conflicting',
   'Signal conflicts with SLA reduction target in CP-2041.',
   'PROJECT', 'active', '11111111-0000-0000-0000-000000000001'),
  ('aaaaaaaa-0000-0000-0000-000000000006', '33333333-0000-0000-0000-000000000001',
   'Owner walkthrough · 7 min', 'voice_note',
   '/uploads/VN-12-owner-walkthrough.m4a', '2026-05-01 10:15:00+00',
   '11111111-0000-0000-0000-000000000003', 'ingested', 'draft',
   '9 field values extracted. Under Intake Agent review.',
   'PROJECT', 'active', '11111111-0000-0000-0000-000000000001')
ON CONFLICT DO NOTHING;

-- ---- Source References ----
INSERT INTO asdlc_source_reference (source_reference_id, evidence_source_id, reference_label, timestamp_or_location, summary, confidence, source_datetime) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'T-118 §3.2 Step owner discussion', '14:42', 'SME confirms Priya R. should own step 4 review gate', 'high', '2026-04-22 14:42:00+00'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
   'T-118 §4.1 SLA requirements',      '22:15', 'SME states 24-hour turnaround required for held orders', 'high', '2026-04-22 14:52:00+00'),
  ('bbbbbbbb-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000002',
   'R-044 p.7 RACI note',              'p.7',   'Reviewer markup aligns accountable role with step 4 owner', 'medium', '2026-04-15 09:15:00+00')
ON CONFLICT DO NOTHING;

-- ---- Change Packets ----
INSERT INTO asdlc_change_packet (change_packet_id, project_id, packet_code, status, summary, source_evidence_id, source_timestamp, conflict_classification, risk_level, recommended_action, baseline_impacting, validation_status, visibility_scope, lifecycle_status, created_by) VALUES
  ('cccccccc-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000001',
   'CP-2041', 'pending',
   'Update Step 4 owner in WF-014',
   'aaaaaaaa-0000-0000-0000-000000000001', '2026-04-22 14:42:00+00',
   'replacing', 'high', 'approve', TRUE, 'passed',
   'PROJECT', 'active', '11111111-0000-0000-0000-000000000001'),
  ('cccccccc-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000001',
   'CP-2040', 'pending',
   'Add validation rule to KA-3001',
   'aaaaaaaa-0000-0000-0000-000000000004', '2026-04-08 08:00:00+00',
   'net_new', 'low', 'approve', FALSE, 'passed',
   'PROJECT', 'active', '11111111-0000-0000-0000-000000000002'),
  ('cccccccc-0000-0000-0000-000000000003', '33333333-0000-0000-0000-000000000001',
   'CP-2039', 'pending',
   'Conflict: HITL-P-22 vs P-15',
   NULL, '2026-05-04 09:58:00+00',
   'conflict', 'high', 'review', TRUE, 'failed',
   'PROJECT', 'active', '11111111-0000-0000-0000-000000000001'),
  ('cccccccc-0000-0000-0000-000000000004', '33333333-0000-0000-0000-000000000001',
   'CP-2038', 'pending',
   'New tool spec: jira-mcp',
   NULL, '2026-05-03 14:00:00+00',
   'net_new', 'med', 'approve', FALSE, 'passed',
   'PROJECT', 'active', '11111111-0000-0000-0000-000000000001'),
  ('cccccccc-0000-0000-0000-000000000005', '33333333-0000-0000-0000-000000000001',
   'CP-2037', 'pending',
   'Cost threshold update',
   NULL, '2026-05-02 11:30:00+00',
   'replacing', 'low', 'approve', FALSE, 'passed',
   'PROJECT', 'active', '11111111-0000-0000-0000-000000000001'),
  -- Approved & rejected examples
  ('cccccccc-0000-0000-0000-000000000006', '33333333-0000-0000-0000-000000000001',
   'CP-2036', 'approved',
   'Workflow trigger update for OMS v3',
   'aaaaaaaa-0000-0000-0000-000000000002', '2026-04-28 10:00:00+00',
   'replacing', 'med', 'approve', FALSE, 'passed',
   'PROJECT', 'active', '11111111-0000-0000-0000-000000000001'),
  ('cccccccc-0000-0000-0000-000000000007', '33333333-0000-0000-0000-000000000001',
   'CP-2035', 'rejected',
   'Remove fallback path from WF-014',
   'aaaaaaaa-0000-0000-0000-000000000003', '2026-04-25 15:00:00+00',
   'replacing', 'high', 'reject', TRUE, 'passed',
   'PROJECT', 'active', '11111111-0000-0000-0000-000000000001')
ON CONFLICT (packet_code) DO NOTHING;

-- ---- Change Packet Items ----
INSERT INTO asdlc_change_packet_item (change_packet_item_id, change_packet_id, entity_type, entity_id, field_path, old_value, new_value, rationale) VALUES
  -- CP-2041: 3 field changes
  ('dddddddd-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001',
   'workflow_step', '99999999-0000-0000-0000-000000000004', 'owner_member_id',
   '"44444444-0000-0000-0000-000000000003"', '"44444444-0000-0000-0000-000000000002"',
   'SME T-118 confirms Priya R. should be the functional reviewer for this gate, not Sam O.'),
  ('dddddddd-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000001',
   'workflow_step', '99999999-0000-0000-0000-000000000004', 'sla_hours',
   '48', '24',
   'T-118 §4.1: SME states 24h turnaround. Original 48h was a placeholder.'),
  ('dddddddd-0000-0000-0000-000000000003', 'cccccccc-0000-0000-0000-000000000001',
   'workflow_step', '99999999-0000-0000-0000-000000000004', 'raci',
   '{"accountable": "Sam O."}', '{"accountable": "Priya R.", "responsible": "Sam O."}',
   'RACI update to reflect new accountable owner per T-118 discussion.')
ON CONFLICT DO NOTHING;

-- ---- Baselines ----
INSERT INTO asdlc_baseline (baseline_id, project_id, baseline_type, baseline_name, baseline_status, summary_of_changes, locked_at, locked_by_member_id, record_count, field_count, visibility_scope, lifecycle_status, created_by) VALUES
  ('eeeeeeee-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000001',
   'draft', 'Draft Design', 'approved',
   'Initial design baseline. 12 use cases, 8 workflows defined.',
   '2026-04-01 16:00:00+00', '44444444-0000-0000-0000-000000000001',
   287, 2841, 'PROJECT', 'active', '11111111-0000-0000-0000-000000000001'),
  ('eeeeeeee-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000001',
   'build', 'Build Baseline', 'approved',
   'Build baseline. Added agent specs, tool contracts, test scenarios.',
   '2026-04-18 17:00:00+00', '44444444-0000-0000-0000-000000000001',
   371, 3703, 'PROJECT', 'active', '11111111-0000-0000-0000-000000000001'),
  ('eeeeeeee-0000-0000-0000-000000000003', '33333333-0000-0000-0000-000000000001',
   'pilot', 'Pilot Baseline', 'draft',
   'Pilot baseline in progress. 23 open change packets.',
   NULL, NULL,
   418, 3907, 'PROJECT', 'active', '11111111-0000-0000-0000-000000000001'),
  ('eeeeeeee-0000-0000-0000-000000000004', '33333333-0000-0000-0000-000000000001',
   'production', 'Production Baseline', 'draft',
   NULL, NULL, NULL,
   0, 0, 'PROJECT', 'active', '11111111-0000-0000-0000-000000000001')
ON CONFLICT DO NOTHING;

-- ---- Exceptions ----
INSERT INTO asdlc_exception (exception_id, project_id, exception_type, severity, description, related_entity_type, related_entity_id, suggested_action, status, visibility_scope, lifecycle_status, created_by) VALUES
  ('ffffffff-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000001',
   'conflict', 'high',
   'Two HITL patterns prescribe contradictory approval rules — P-22 requires sign-off before baseline lock; P-15 allows reviewer concur to substitute.',
   'hitl_gate', '99999999-0000-0000-0000-000000000004',
   'Pick one pattern or merge into a single approval rule.', 'open',
   'PROJECT', 'active', '11111111-0000-0000-0000-000000000001'),
  ('ffffffff-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000001',
   'failed_validation', 'high',
   'Step has no owner reference. Validation Agent rule OWNER-001 failed.',
   'workflow_step', '99999999-0000-0000-0000-000000000003',
   'Assign a project member as step owner.', 'open',
   'PROJECT', 'active', '11111111-0000-0000-0000-000000000002'),
  ('ffffffff-0000-0000-0000-000000000003', '33333333-0000-0000-0000-000000000001',
   'low_confidence', 'med',
   'Story Agent confidence 0.42 — KA body may not accurately reflect current process.',
   'knowledge_article', '77777777-0000-0000-0000-000000000001',
   'Human edit or re-source from updated transcript.', 'open',
   'PROJECT', 'active', '11111111-0000-0000-0000-000000000001'),
  ('ffffffff-0000-0000-0000-000000000004', '33333333-0000-0000-0000-000000000001',
   'missing_evidence', 'med',
   'No transcript or template citation found for RACI entries.',
   'workflow', '88888888-0000-0000-0000-000000000001',
   'Provide a source document or transcript.', 'open',
   'PROJECT', 'active', '11111111-0000-0000-0000-000000000001'),
  ('ffffffff-0000-0000-0000-000000000005', '33333333-0000-0000-0000-000000000001',
   'governance_sensitive', 'high',
   'Governance control touches access boundary — requires Governance Agent review before approval.',
   'workflow', '88888888-0000-0000-0000-000000000001',
   'Route to Governance review.', 'open',
   'PROJECT', 'active', '11111111-0000-0000-0000-000000000001'),
  ('ffffffff-0000-0000-0000-000000000006', '33333333-0000-0000-0000-000000000001',
   'missing_owner', 'med',
   'Workflow step has no assigned functional owner.',
   'workflow_step', '99999999-0000-0000-0000-000000000002',
   'Assign an owner from project members.', 'open',
   'PROJECT', 'active', '11111111-0000-0000-0000-000000000001'),
  ('ffffffff-0000-0000-0000-000000000007', '33333333-0000-0000-0000-000000000001',
   'baseline_impacting', 'high',
   'Change Packet CP-2041 will modify a field locked in the Build Baseline.',
   'workflow_step', '99999999-0000-0000-0000-000000000004',
   'Review baseline impact before approving CP-2041.', 'in_review',
   'PROJECT', 'active', '11111111-0000-0000-0000-000000000001')
ON CONFLICT DO NOTHING;

-- ---- Report Exports ----
INSERT INTO asdlc_report_export (report_export_id, project_id, report_type, baseline_id, file_url, format, audience, client_visible, generated_by_member_id, generated_at, title, visibility_scope, lifecycle_status, created_by) VALUES
  ('gggggggg-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000001',
   'excel_review_pack', 'eeeeeeee-0000-0000-0000-000000000003',
   '/exports/ACME-P1-pilot-review-pack-2026-05-03.xlsx',
   'xlsx', 'reviewer', FALSE, '44444444-0000-0000-0000-000000000001',
   '2026-05-03 14:00:00+00', 'ACME Pilot 1 · Pilot review pack',
   'PROJECT', 'active', '11111111-0000-0000-0000-000000000001'),
  ('gggggggg-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000001',
   'consolidated_design', 'eeeeeeee-0000-0000-0000-000000000003',
   '/exports/ACME-P1-consolidated-design-2026-04-28.docx',
   'docx', 'client_steerco', TRUE, '44444444-0000-0000-0000-000000000001',
   '2026-04-28 09:00:00+00', 'ACME Pilot 1 · Consolidated design report',
   'PROJECT', 'active', '11111111-0000-0000-0000-000000000001'),
  ('gggggggg-0000-0000-0000-000000000003', '33333333-0000-0000-0000-000000000001',
   'baseline_comparison', NULL,
   '/exports/ACME-P1-build-to-pilot-diff-2026-04-18.docx',
   'docx', 'internal_qa', FALSE, '44444444-0000-0000-0000-000000000001',
   '2026-04-18 17:30:00+00', 'ACME Pilot 1 · Build → Pilot baseline diff',
   'PROJECT', 'active', '11111111-0000-0000-0000-000000000001')
ON CONFLICT DO NOTHING;

-- ---- Knowledge Articles ----
INSERT INTO asdlc_knowledge_article (knowledge_article_id, project_id, title, body, trigger, linked_use_case_id, approved_by, approved_at, next_review_date, visibility_scope, lifecycle_status, created_by) VALUES
  ('hhhhhhhh-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000001',
   'How to escalate a held order',
   'This article describes the escalation process for held orders in the OMS. When an order is held for more than 24 hours without resolution, it must be escalated to the senior operations team.',
   'When agents encounter a held order exceeding SLA or requiring senior review.',
   '77777777-0000-0000-0000-000000000001',
   '44444444-0000-0000-0000-000000000002', '2026-04-10 10:00:00+00',
   '2026-10-10', 'PROJECT', 'active', '11111111-0000-0000-0000-000000000001')
ON CONFLICT DO NOTHING;
