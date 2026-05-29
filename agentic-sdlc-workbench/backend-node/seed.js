// seed.js — Idempotent demo data for Agentic SDLC Workbench
// Uses INSERT OR IGNORE so safe to re-run. Delete asdlc.db for a full clean slate.
'use strict';

const { db } = require('./db');
const crypto = require('crypto');

function ins(sql, rows) {
  const stmt = db.prepare(sql);
  db.exec('BEGIN');
  try {
    for (const r of rows) stmt.run(...r);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function run(sql, params = []) {
  db.prepare(sql).run(...params);
}

function seed() {

  // ── Fixed IDs (every FK reference uses these constants) ──────────────────
  const C1  = '22222222-0000-0000-0000-000000000001'; // ACME Corp
  const C2  = '22222222-0000-0000-0000-000000000002'; // BetaCo
  const C3  = '22222222-0000-0000-0000-000000000003'; // Gamma Ltd

  const U1  = '11111111-0000-0000-0000-000000000001'; // Chris H.
  const U2  = '11111111-0000-0000-0000-000000000002'; // Priya R.
  const U3  = '11111111-0000-0000-0000-000000000003'; // Sam O.
  const U4  = '11111111-0000-0000-0000-000000000004'; // Jordan K.
  const U5  = '11111111-0000-0000-0000-000000000005'; // Nia W.
  const U6  = '11111111-0000-0000-0000-000000000006'; // Chris M.

  const P1  = '33333333-0000-0000-0000-000000000001'; // ACME Pilot 1
  const P2  = '33333333-0000-0000-0000-000000000002'; // ACME Wave 2
  const P3  = '33333333-0000-0000-0000-000000000003'; // BetaCo Greenfield
  const P4  = '33333333-0000-0000-0000-000000000004'; // Gamma Modernization
  const P5  = '33333333-0000-0000-0000-000000000005'; // BetaCo Phase 2
  const P6  = '33333333-0000-0000-0000-000000000006'; // ACME Innovation Lab
  const P7  = '33333333-0000-0000-0000-000000000007'; // Gamma Analytics Hub

  // Project members for P1 (ACME Pilot 1)
  const M1  = '44444444-0000-0000-0000-000000000001'; // Chris H. on P1
  const M2  = '44444444-0000-0000-0000-000000000002'; // Priya R. on P1
  const M3  = '44444444-0000-0000-0000-000000000003'; // Sam O. on P1
  const M4  = '44444444-0000-0000-0000-000000000004'; // Jordan K. on P1

  // Agent catalog
  const AG1 = '55555555-0000-0000-0000-000000000001'; // orchestrator
  const AG2 = '55555555-0000-0000-0000-000000000002'; // intake
  const AG3 = '55555555-0000-0000-0000-000000000003'; // change_intake
  const AG4 = '55555555-0000-0000-0000-000000000004'; // process
  const AG5 = '55555555-0000-0000-0000-000000000005'; // workflow_design
  const AG6 = '55555555-0000-0000-0000-000000000006'; // agent_architect
  const AG7 = '55555555-0000-0000-0000-000000000007'; // cost
  const AG8 = '55555555-0000-0000-0000-000000000008'; // testing
  const AG9 = '55555555-0000-0000-0000-000000000009'; // validation
  const AG10= '55555555-0000-0000-0000-000000000010'; // governance
  const AG11= '55555555-0000-0000-0000-000000000011'; // story
  const AG12= '55555555-0000-0000-0000-000000000012'; // reviewer

  // Project agent settings for P1
  const PS1 = '66666666-0000-0000-0000-000000000001';
  const PS2 = '66666666-0000-0000-0000-000000000002';
  const PS3 = '66666666-0000-0000-0000-000000000003';
  const PS4 = '66666666-0000-0000-0000-000000000004';
  const PS5 = '66666666-0000-0000-0000-000000000005';
  const PS6 = '66666666-0000-0000-0000-000000000006';
  const PS7 = '66666666-0000-0000-0000-000000000007';
  const PS8 = '66666666-0000-0000-0000-000000000008';
  const PS9 = '66666666-0000-0000-0000-000000000009';
  const PS10= '66666666-0000-0000-0000-000000000010';
  const PS11= '66666666-0000-0000-0000-000000000011';
  const PS12= '66666666-0000-0000-0000-000000000012';

  // Use cases (all under P1)
  const UC1 = '77777777-0000-0000-0000-000000000001'; // Order Operations Automation
  const UC2 = '77777777-0000-0000-0000-000000000002'; // Customer Notification Engine
  const UC3 = '77777777-0000-0000-0000-000000000003'; // Returns & Refunds Processing

  // Workflows
  const WF1 = '88888888-0000-0000-0000-000000000001'; // WF-014 Held Order Triage  (UC1)
  const WF2 = '88888888-0000-0000-0000-000000000002'; // WF-015 Customer Notification (UC2)
  const WF3 = '88888888-0000-0000-0000-000000000003'; // WF-016 Returns Processing  (UC3)

  // Workflow steps  (WF1 = 5 steps, WF2 = 4 steps, WF3 = 4 steps)
  const WS1 = '99999999-0000-0000-0000-000000000001';
  const WS2 = '99999999-0000-0000-0000-000000000002';
  const WS3 = '99999999-0000-0000-0000-000000000003';
  const WS4 = '99999999-0000-0000-0000-000000000004';
  const WS5 = '99999999-0000-0000-0000-000000000005';
  const WS6 = '99999999-0000-0000-0000-000000000006';
  const WS7 = '99999999-0000-0000-0000-000000000007';
  const WS8 = '99999999-0000-0000-0000-000000000008';
  const WS9 = '99999999-0000-0000-0000-000000000009';
  const WS10= '99999999-0000-0000-0000-000000000010';
  const WS11= '99999999-0000-0000-0000-000000000011';
  const WS12= '99999999-0000-0000-0000-000000000012';
  const WS13= '99999999-0000-0000-0000-000000000013';

  // HITL gates
  const HG1 = 'h1111111-0000-0000-0000-000000000001'; // HITL-P-22 WF1 Step 4
  const HG2 = 'h1111111-0000-0000-0000-000000000002'; // HITL-P-23 WF1 escalation
  const HG3 = 'h1111111-0000-0000-0000-000000000003'; // HITL-P-24 WF2 Step 2
  const HG4 = 'h1111111-0000-0000-0000-000000000004'; // HITL-P-15 WF3 Step 3

  // Agent specs
  const AS1 = 'a2222222-0000-0000-0000-000000000001'; // Held Order Triage Agent
  const AS2 = 'a2222222-0000-0000-0000-000000000002'; // Customer Notification Agent
  const AS3 = 'a2222222-0000-0000-0000-000000000003'; // Returns Assessment Agent

  // Tools
  const TL1 = 't3333333-0000-0000-0000-000000000001'; // OMS Order API
  const TL2 = 't3333333-0000-0000-0000-000000000002'; // ServiceNow Case API
  const TL3 = 't3333333-0000-0000-0000-000000000003'; // Transactional Email API
  const TL4 = 't3333333-0000-0000-0000-000000000004'; // JIRA MCP
  const TL5 = 't3333333-0000-0000-0000-000000000005'; // Returns Portal API

  // Knowledge articles
  const KA1 = 'hhhhhhhh-0000-0000-0000-000000000001';
  const KA2 = 'hhhhhhhh-0000-0000-0000-000000000002';
  const KA3 = 'hhhhhhhh-0000-0000-0000-000000000003';
  const KA4 = 'hhhhhhhh-0000-0000-0000-000000000004';

  // Reusable Design Library entries (PROGRAM / ORGANIZATION / GLOBAL scope)
  const LIB1  = 'hhhhhhhh-0000-0000-0000-00000000010a';
  const LIB2  = 'hhhhhhhh-0000-0000-0000-00000000010b';
  const LIB3  = 'hhhhhhhh-0000-0000-0000-00000000010c';
  const LIB4  = 'hhhhhhhh-0000-0000-0000-00000000010d';
  const LIB5  = 'hhhhhhhh-0000-0000-0000-00000000010e';
  const LIB6  = 'hhhhhhhh-0000-0000-0000-00000000010f';
  const LIB7  = 'hhhhhhhh-0000-0000-0000-000000000110';
  const LIB8  = 'hhhhhhhh-0000-0000-0000-000000000111';
  const LIB9  = 'hhhhhhhh-0000-0000-0000-000000000112';
  const LIB10 = 'hhhhhhhh-0000-0000-0000-000000000113';
  const LIB11 = 'hhhhhhhh-0000-0000-0000-000000000114';
  const LIB12 = 'hhhhhhhh-0000-0000-0000-000000000115';

  // Evidence sources
  const EV1 = 'aaaaaaaa-0000-0000-0000-000000000001';
  const EV2 = 'aaaaaaaa-0000-0000-0000-000000000002';
  const EV3 = 'aaaaaaaa-0000-0000-0000-000000000003';
  const EV4 = 'aaaaaaaa-0000-0000-0000-000000000004';
  const EV5 = 'aaaaaaaa-0000-0000-0000-000000000005';
  const EV6 = 'aaaaaaaa-0000-0000-0000-000000000006';
  const EV7 = 'aaaaaaaa-0000-0000-0000-000000000007';
  const EV8 = 'aaaaaaaa-0000-0000-0000-000000000008';

  // Source references
  const SR1 = 'bbbbbbbb-0000-0000-0000-000000000001';
  const SR2 = 'bbbbbbbb-0000-0000-0000-000000000002';
  const SR3 = 'bbbbbbbb-0000-0000-0000-000000000003';
  const SR4 = 'bbbbbbbb-0000-0000-0000-000000000004';
  const SR5 = 'bbbbbbbb-0000-0000-0000-000000000005';
  const SR6 = 'bbbbbbbb-0000-0000-0000-000000000006';
  const SR7 = 'bbbbbbbb-0000-0000-0000-000000000007';
  const SR8 = 'bbbbbbbb-0000-0000-0000-000000000008';
  const SR9 = 'bbbbbbbb-0000-0000-0000-000000000009';
  const SR10= 'bbbbbbbb-0000-0000-0000-000000000010';
  const SR11= 'bbbbbbbb-0000-0000-0000-000000000011';
  const SR12= 'bbbbbbbb-0000-0000-0000-000000000012';

  // Change packets
  const CP1 = 'cccccccc-0000-0000-0000-000000000001';
  const CP2 = 'cccccccc-0000-0000-0000-000000000002';
  const CP3 = 'cccccccc-0000-0000-0000-000000000003';
  const CP4 = 'cccccccc-0000-0000-0000-000000000004';
  const CP5 = 'cccccccc-0000-0000-0000-000000000005';
  const CP6 = 'cccccccc-0000-0000-0000-000000000006';
  const CP7 = 'cccccccc-0000-0000-0000-000000000007';

  // Change packet items
  const CPI1 = 'dddddddd-0000-0000-0000-000000000001';
  const CPI2 = 'dddddddd-0000-0000-0000-000000000002';
  const CPI3 = 'dddddddd-0000-0000-0000-000000000003';
  const CPI4 = 'dddddddd-0000-0000-0000-000000000004';
  const CPI5 = 'dddddddd-0000-0000-0000-000000000005';
  const CPI6 = 'dddddddd-0000-0000-0000-000000000006';
  const CPI7 = 'dddddddd-0000-0000-0000-000000000007';
  const CPI8 = 'dddddddd-0000-0000-0000-000000000008';
  const CPI9 = 'dddddddd-0000-0000-0000-000000000009';
  const CPI10= 'dddddddd-0000-0000-0000-000000000010';
  const CPI11= 'dddddddd-0000-0000-0000-000000000011';
  const CPI12= 'dddddddd-0000-0000-0000-000000000012';

  // Baselines
  const BL1 = 'eeeeeeee-0000-0000-0000-000000000001'; // Draft Design  (locked)
  const BL2 = 'eeeeeeee-0000-0000-0000-000000000002'; // Build Baseline (locked)
  const BL3 = 'eeeeeeee-0000-0000-0000-000000000003'; // Pilot Baseline (current draft)
  const BL4 = 'eeeeeeee-0000-0000-0000-000000000004'; // Production Baseline (future)

  // Baseline items
  const BI1 = 'i5555555-0000-0000-0000-000000000001';
  const BI2 = 'i5555555-0000-0000-0000-000000000002';
  const BI3 = 'i5555555-0000-0000-0000-000000000003';
  const BI4 = 'i5555555-0000-0000-0000-000000000004';
  const BI5 = 'i5555555-0000-0000-0000-000000000005';
  const BI6 = 'i5555555-0000-0000-0000-000000000006';
  const BI7 = 'i5555555-0000-0000-0000-000000000007';
  const BI8 = 'i5555555-0000-0000-0000-000000000008';
  const BI9 = 'i5555555-0000-0000-0000-000000000009';
  const BI10= 'i5555555-0000-0000-0000-000000000010';
  const BI11= 'i5555555-0000-0000-0000-000000000011';
  const BI12= 'i5555555-0000-0000-0000-000000000012';

  // Exceptions
  const EX1 = 'ffffffff-0000-0000-0000-000000000001';
  const EX2 = 'ffffffff-0000-0000-0000-000000000002';
  const EX3 = 'ffffffff-0000-0000-0000-000000000003';
  const EX4 = 'ffffffff-0000-0000-0000-000000000004';
  const EX5 = 'ffffffff-0000-0000-0000-000000000005';
  const EX6 = 'ffffffff-0000-0000-0000-000000000006';
  const EX7 = 'ffffffff-0000-0000-0000-000000000007';

  // Report exports
  const RE1 = 'gggggggg-0000-0000-0000-000000000001';
  const RE2 = 'gggggggg-0000-0000-0000-000000000002';
  const RE3 = 'gggggggg-0000-0000-0000-000000000003';

  // ── 1. USERS ─────────────────────────────────────────────────────────────
  ins(`INSERT OR IGNORE INTO asdlc_user (user_id, display_name, email, role) VALUES (?,?,?,?)`, [
    [U1, 'Chris H.',  'chris.h@internal.example',  'methodology_owner'],
    [U2, 'Priya R.',  'priya.r@internal.example',  'reviewer'],
    [U3, 'Sam O.',    'sam.o@internal.example',    'functional_owner'],
    [U4, 'Jordan K.', 'jordan.k@internal.example', 'technical'],
    [U5, 'Nia W.',    'nia.w@internal.example',    'governance'],
    [U6, 'Chris M.',  'chris.m@internal.example',  'methodology_owner'],
  ]);

  // Disable FK enforcement for the duration of the seed. The historical insert
  // order has child-before-parent quirks (e.g. workflow_participant inserts before
  // agent_spec). On a fresh / post-cleanup DB those FK refs trip. We turn FKs back
  // on at the end and run a foreign_key_check to catch any genuine orphans.
  db.exec('PRAGMA foreign_keys = OFF');

  // ── 2. CLIENTS ───────────────────────────────────────────────────────────
  // BetaCo + Gamma were demo throwaways; cleanup removed them. Only seed real clients.
  ins(`INSERT OR IGNORE INTO asdlc_client (client_id, client_name, client_code) VALUES (?,?,?)`, [
    [C1, 'ACME Corp', 'ACME'],
  ]);

  // ── 3. PROJECTS ──────────────────────────────────────────────────────────
  // Only one ACME project. The 6 placeholder projects (Wave 2, Greenfield,
  // Modernization, Phase 2, Innovation Lab, Analytics Hub, ServiceNow IT Ops)
  // were demo noise and have been removed.
  // Per-application cost params: ACME pilot plans monthly, no entitlement,
  // default Now Assist pricing. All cost params (pricing + planning + entitlement)
  // are per-Application.
  ins(`INSERT OR IGNORE INTO asdlc_project
    (project_id, client_id, project_name, project_code, stage,
     planning_period, periods_per_year, entitlement_enabled, annual_included_assists,
     cost_per_assist, overage_rate, cost_per_assist_expansion)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
    [P1, C1, 'Operations Pilot', 'ACME-P1', 'build',
     'Monthly', 12, 0, null,
     0.015, null, null],
  ]);

  // ── 4. PROJECT MEMBERS ───────────────────────────────────────────────────
  ins(`INSERT OR IGNORE INTO asdlc_project_member
    (project_member_id, project_id, user_id, display_name, member_role, can_approve, hitl_role)
    VALUES (?,?,?,?,?,?,?)`, [
    // P1 — ACME Operations Pilot (only project; full team)
    [M1, P1, U1, 'Chris H.',  'methodology_owner', 1, 'owner'],
    [M2, P1, U2, 'Priya R.',  'reviewer',          1, 'approver'],
    [M3, P1, U3, 'Sam O.',    'functional_owner',  0, 'exception_handler'],
    [M4, P1, U4, 'Jordan K.', 'technical',         0, null],
  ]);

  // ── 5. AGENT CATALOG ─────────────────────────────────────────────────────
  ins(`INSERT OR IGNORE INTO asdlc_agent_catalog
    (workbench_agent_id, agent_type, agent_name, purpose, default_trust_level) VALUES (?,?,?,?,?)`, [
    [AG1,  'orchestrator',    'Orchestrator',          'Orchestrates all agent activities',       3],
    [AG2,  'intake',          'Intake Agent',          'Handles initial project intake',          2],
    [AG3,  'change_intake',   'Change Intake Agent',   'Processes change requests',               2],
    [AG4,  'process',         'Process Agent',         'Maps and analyses business processes',    3],
    [AG5,  'workflow_design', 'Workflow Design Agent', 'Designs workflow structures',             3],
    [AG6,  'agent_architect', 'Agent Architect',       'Designs agent architectures',             3],
    [AG7,  'cost',            'Cost Agent',            'Analyses cost implications',              1],
    [AG8,  'testing',         'Testing Agent',         'Generates and runs test plans',           3],
    [AG9,  'validation',      'Validation Agent',      'Validates design artefacts',              4],
    [AG10, 'governance',      'Governance Agent',      'Applies governance controls',             2],
    [AG11, 'story',           'Story Agent',           'Generates user stories',                  3],
    [AG12, 'reviewer',        'Reviewer Agent',        'Performs automated design review',        2],
  ]);

  // ── 6. PROJECT AGENT SETTINGS (P1 only) ──────────────────────────────────
  ins(`INSERT OR IGNORE INTO asdlc_project_agent_setting
    (project_agent_setting_id, project_id, workbench_agent_id, trust_level, enabled) VALUES (?,?,?,?,?)`, [
    [PS1,  P1, AG1,  3, 1],
    [PS2,  P1, AG2,  2, 1],
    [PS3,  P1, AG3,  2, 1],
    [PS4,  P1, AG4,  3, 1],
    [PS5,  P1, AG5,  3, 1],
    [PS6,  P1, AG6,  3, 1],
    [PS7,  P1, AG7,  1, 0],
    [PS8,  P1, AG8,  3, 1],
    [PS9,  P1, AG9,  4, 1],
    [PS10, P1, AG10, 2, 0],
    [PS11, P1, AG11, 3, 1],
    [PS12, P1, AG12, 2, 1],
  ]);

  // ── 7. USE CASES ─────────────────────────────────────────────────────────
  ins(`INSERT OR IGNORE INTO asdlc_use_case
    (use_case_id, project_id, title, summary, business_objective, expected_value,
     users, urgency, readiness, lifecycle_status) VALUES (?,?,?,?,?,?,?,?,?,?)`, [
    [UC1, P1,
      'Order Operations Automation',
      'Automate detection, classification, and resolution of held orders to reduce handling time and improve SLA compliance.',
      'Reduce order hold resolution time from 48h average to under 8h.',
      'Estimated $420k annual saving from reduced manual handling; 18% improvement in SLA compliance.',
      'Order operations team, customer service agents, team leads',
      'high', 'approved', 'active'],
    [UC2, P1,
      'Customer Notification Engine',
      'Proactively notify customers of order status changes using AI-generated, brand-approved messaging.',
      'Reduce inbound CS call volume by 25% through proactive status updates.',
      'Estimated 1,200 fewer calls per month; CSAT target +0.4 pts.',
      'Customer service team, customers, CS supervisors',
      'med', 'in_review', 'active'],
    [UC3, P1,
      'Returns & Refunds Processing',
      'Streamline returns intake, eligibility assessment, and refund authorisation using AI-assisted decisioning.',
      'Reduce returns processing cycle from 5 days to under 48 hours.',
      'Estimated 30% reduction in returns handling cost; improved NPS on returns experience.',
      'Returns team, customer service, finance approvers',
      'low', 'draft', 'draft'],
  ]);

  // ── 7b. UC JSON fields — success_criteria / constraints / volume ─────────
  // The base INSERT above can't carry these JSON columns (column-count limit);
  // populate them here so ACME UC cards show full content instead of empty
  // sections. Only writes when the column is still at its default empty value.
  run(`UPDATE asdlc_use_case SET
        success_criteria = CASE WHEN success_criteria IN ('[]','') OR success_criteria IS NULL
          THEN ? ELSE success_criteria END,
        constraints_list = CASE WHEN constraints_list IN ('[]','') OR constraints_list IS NULL
          THEN ? ELSE constraints_list END,
        volume_assumptions = CASE WHEN volume_assumptions IN ('{}','') OR volume_assumptions IS NULL
          THEN ? ELSE volume_assumptions END,
        updated_at = datetime('now')
       WHERE use_case_id = ?`,
    [JSON.stringify([
      'Triage agent assigns held-order tickets to the correct queue at >=90% accuracy on a 100-ticket validation set',
      'Average hold-resolution time across pilot drops below 8 hours within 30 days of go-live',
      'Auto-resolution rate >=70% for held orders meeting policy criteria',
      'Zero unauthorised customer contact: all outbound messaging goes through approved templates only',
    ]), JSON.stringify([
      'Agent writes only to ServiceNow case + Work Notes; never to customer-facing comments',
      'No PII (PAN, SSN, bank account) is permitted in Work Note output',
      'Manager approval required before any refund authorisation > $500',
      'Pilot scoped to North America fulfilment region only',
    ]), JSON.stringify({
      monthly_requests: 500,
      peak_concurrency: 8,
      peak_period: 'Mon-Tue 8-11am Pacific',
      notes: 'Volume estimate covers the held-order subset of OMS events; ~3% of total order volume.',
    }), UC1]);

  run(`UPDATE asdlc_use_case SET
        success_criteria = CASE WHEN success_criteria IN ('[]','') OR success_criteria IS NULL
          THEN ? ELSE success_criteria END,
        constraints_list = CASE WHEN constraints_list IN ('[]','') OR constraints_list IS NULL
          THEN ? ELSE constraints_list END,
        volume_assumptions = CASE WHEN volume_assumptions IN ('{}','') OR volume_assumptions IS NULL
          THEN ? ELSE volume_assumptions END,
        updated_at = datetime('now')
       WHERE use_case_id = ?`,
    [JSON.stringify([
      'Customer status emails sent within 5 minutes of the underlying OMS state change',
      'Notification copy passes brand-style check on a 50-message rolling sample (no profanity, internal codes, or PII)',
      'Inbound CS contact volume on tracked statuses falls >=25% vs the pre-pilot baseline at 60 days',
      'Customer opt-out is respected within one OMS replication cycle (<= 15 min)',
    ]), JSON.stringify([
      'Only customers with notification_opt_in=true are messaged',
      'Email template variants must be approved by Brand before activation',
      'No outbound SMS in this pilot (email only)',
    ]), JSON.stringify({
      monthly_requests: 2000,
      peak_concurrency: 25,
      peak_period: 'Wed 2-4pm Pacific (status-change spike after warehouse batch)',
      notes: 'Volume scales with total order volume; assume 12% growth quarter-over-quarter.',
    }), UC2]);

  run(`UPDATE asdlc_use_case SET
        success_criteria = CASE WHEN success_criteria IN ('[]','') OR success_criteria IS NULL
          THEN ? ELSE success_criteria END,
        constraints_list = CASE WHEN constraints_list IN ('[]','') OR constraints_list IS NULL
          THEN ? ELSE constraints_list END,
        volume_assumptions = CASE WHEN volume_assumptions IN ('{}','') OR volume_assumptions IS NULL
          THEN ? ELSE volume_assumptions END,
        updated_at = datetime('now')
       WHERE use_case_id = ?`,
    [JSON.stringify([
      'Returns decisions include a complete audit trail (decision, reasoning, fixture references) accessible from the ticket',
      'Refund auto-authorisation rate >=80% for cases meeting policy criteria over a 60-day pilot',
      'Returns processing cycle drops below 48 hours on the in-scope SKUs',
      'Zero refunds authorised for cases that fail policy checks',
    ]), JSON.stringify([
      'Refunds > $2,000 always escalate to a human finance approver',
      'Out-of-warranty returns auto-rejected with templated explanation',
      'Inventory restocking flags are read-only; agent does not modify inventory state',
    ]), JSON.stringify({
      monthly_requests: 300,
      peak_concurrency: 5,
      peak_period: 'Mon 10am-12pm Pacific (post-weekend submission backlog)',
      notes: 'Returns volume is seasonal: assume 2.5x peak in Nov-Dec.',
    }), UC3]);

  // ── 8. WORKFLOWS ─────────────────────────────────────────────────────────
  ins(`INSERT OR IGNORE INTO asdlc_workflow
    (workflow_id, use_case_id, project_id, name, trigger_def, readiness, lifecycle_status)
    VALUES (?,?,?,?,?,?,?)`, [
    [WF1, UC1, P1,
      'WF-014: Held Order Triage',
      '{"event":"order.status.held","system":"OMS","debounce_seconds":60}',
      'approved', 'active'],
    [WF2, UC2, P1,
      'WF-015: Customer Status Notification',
      '{"event":"order.status.changed","system":"OMS","filter":"customer_opt_in=true"}',
      'in_review', 'draft'],
    [WF3, UC3, P1,
      'WF-016: Returns & Refund Processing',
      '{"event":"return.request.created","system":"returns_portal","sla_hours":48}',
      'draft', 'draft'],
  ]);

  // ── 9. HITL GATES (inserted before steps so steps can ref them) ───────────
  // workflow_step_id set to null here; updated below after steps are inserted
  ins(`INSERT OR IGNORE INTO asdlc_hitl_gate
    (hitl_gate_id, workflow_id, workflow_step_id, project_id,
     gate_type, criteria, owner_role, sla, handoff_mechanism, lifecycle_status)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, [
    [HG1, WF1, null, P1,
      'approval',
      'Order hold value > $1,000 OR customer_tier = Premium OR hold_reason = fraud_suspected',
      'team_lead', '24 hours',
      'ServiceNow task assignment via Case API', 'active'],
    [HG2, WF1, null, P1,
      'escalation',
      'Order hold unresolved for > 72 hours OR escalation_flag = true',
      'ops_manager', '4 hours',
      'Escalation email + Slack alert to on-call manager', 'active'],
    [HG3, WF2, null, P1,
      'review',
      'Notification contains refund_amount > $500 OR message_type = service_failure',
      'cs_supervisor', '2 hours',
      'Draft review queue in CS portal', 'active'],
    [HG4, WF3, null, P1,
      'approval',
      'Return value > $200 OR order_age_days > 30 OR return_reason = damaged_in_transit',
      'returns_manager', '8 hours',
      'Returns portal approval workflow', 'active'],
  ]);

  // ── 10. WORKFLOW STEPS ────────────────────────────────────────────────────
  // WF1 — Held Order Triage (5 steps)
  ins(`INSERT OR IGNORE INTO asdlc_workflow_step
    (workflow_step_id, workflow_id, project_id, step_number, name,
     actor_role, owner_member_id, raci, inputs, outputs, sla_hours, hitl_gate_id, lifecycle_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    [WS1, WF1, P1, 1, 'Detect held order',
      'System', null,
      '{"responsible":"System","accountable":"'+M3+'","informed":"'+M4+'"}',
      '["OMS event stream"]',
      '["hold_event payload with order_id, hold_reason, hold_timestamp"]',
      null, null, 'active'],
    [WS2, WF1, P1, 2, 'Classify hold reason',
      'AI Agent', M3,
      '{"responsible":"'+AS1+'","accountable":"'+M3+'","consulted":"'+M4+'"}',
      '["hold_event payload","last_90_days_hold_history","classification_taxonomy_v3"]',
      '["hold_classification","confidence_score","recommended_action"]',
      1, null, 'active'],
    [WS3, WF1, P1, 3, 'Route to team',
      'Orchestrator', M4,
      '{"responsible":"Orchestrator","accountable":"'+M4+'","informed":"'+M1+'"}',
      '["hold_classification","confidence_score"]',
      '["routing_decision","task_assignment_id","assigned_team"]',
      null, null, 'active'],
    [WS4, WF1, P1, 4, 'Human review & decision',
      'Human', M2,
      '{"accountable":"'+M2+'","responsible":"'+M3+'","consulted":"'+M4+'","informed":"'+M1+'"}',
      '["task_assignment","hold_details","recommended_action","evidence_links"]',
      '["resolution_decision","resolution_notes","applied_at"]',
      24, HG1, 'active'],
    [WS5, WF1, P1, 5, 'Apply resolution',
      'System', M3,
      '{"responsible":"System","accountable":"'+M3+'","informed":"'+M1+'"}',
      '["resolution_decision","order_id"]',
      '["order_status_update","audit_record","customer_notification_trigger"]',
      null, null, 'active'],
  ]);

  // WF2 — Customer Status Notification (4 steps)
  ins(`INSERT OR IGNORE INTO asdlc_workflow_step
    (workflow_step_id, workflow_id, project_id, step_number, name,
     actor_role, owner_member_id, raci, inputs, outputs, sla_hours, hitl_gate_id, lifecycle_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    [WS6, WF2, P1, 1, 'Detect order status change',
      'System', M3,
      '{"responsible":"System","accountable":"'+M3+'"}',
      '["OMS event stream","customer_opt_in_list"]',
      '["status_change_event with order_id, new_status, customer_id"]',
      null, null, 'draft'],
    [WS7, WF2, P1, 2, 'Draft customer notification',
      'AI Agent', M3,
      '{"responsible":"'+AS2+'","accountable":"'+M3+'","consulted":"'+M2+'"}',
      '["status_change_event","customer_profile","approved_template_library"]',
      '["draft_notification","template_id","personalisation_flags","requires_review_flag"]',
      1, HG3, 'draft'],
    [WS8, WF2, P1, 3, 'Send notification',
      'System', M3,
      '{"responsible":"System","accountable":"'+M3+'","informed":"'+M1+'"}',
      '["approved_notification","customer_contact_preferences"]',
      '["sent_message_id","delivery_channel","delivery_timestamp"]',
      null, null, 'draft'],
    [WS9, WF2, P1, 4, 'Log delivery outcome',
      'System', M4,
      '{"responsible":"System","accountable":"'+M4+'"}',
      '["delivery_receipt","sent_message_id"]',
      '["delivery_log_entry","bounce_flag","open_rate_update"]',
      null, null, 'draft'],
  ]);

  // WF3 — Returns & Refund Processing (4 steps)
  ins(`INSERT OR IGNORE INTO asdlc_workflow_step
    (workflow_step_id, workflow_id, project_id, step_number, name,
     actor_role, owner_member_id, raci, inputs, outputs, sla_hours, hitl_gate_id, lifecycle_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    [WS10, WF3, P1, 1, 'Receive return request',
      'System', M3,
      '{"responsible":"System","accountable":"'+M3+'"}',
      '["returns_portal webhook event"]',
      '["return_request_record with return_id, order_id, reason, item_details"]',
      null, null, 'draft'],
    [WS11, WF3, P1, 2, 'Assess return eligibility',
      'AI Agent', M3,
      '{"responsible":"'+AS3+'","accountable":"'+M3+'","consulted":"'+M1+'"}',
      '["return_request_record","full_order_history","returns_policy_v2_4"]',
      '["eligibility_decision","confidence_score","policy_citations","escalation_flag"]',
      2, null, 'draft'],
    [WS12, WF3, P1, 3, 'Authorise return',
      'Human', M3,
      '{"accountable":"'+M3+'","responsible":"'+M3+'","informed":"'+M2+'"}',
      '["eligibility_decision","return_request_record","policy_citations"]',
      '["authorisation_decision","authorisation_notes","authorised_refund_amount"]',
      8, HG4, 'draft'],
    [WS13, WF3, P1, 4, 'Process refund',
      'System', M4,
      '{"responsible":"System","accountable":"'+M4+'","informed":"'+M3+'"}',
      '["authorisation_decision","order_id","customer_payment_details"]',
      '["refund_transaction_id","refund_status","confirmation_email_trigger"]',
      null, null, 'draft'],
  ]);

  // ── 11. Update HITL gates with their workflow_step_id now steps exist ─────
  run(`UPDATE asdlc_hitl_gate SET workflow_step_id = ? WHERE hitl_gate_id = ? AND workflow_step_id IS NULL`, [WS4, HG1]);
  run(`UPDATE asdlc_hitl_gate SET workflow_step_id = ? WHERE hitl_gate_id = ? AND workflow_step_id IS NULL`, [WS7, HG3]);
  run(`UPDATE asdlc_hitl_gate SET workflow_step_id = ? WHERE hitl_gate_id = ? AND workflow_step_id IS NULL`, [WS12, HG4]);

  // ── 11b. WORKFLOW PARTICIPANTS (Phase 2) ──────────────────────────────────
  // Fixed IDs for participants
  const WP1  = 'wp111111-0000-0000-0000-000000000001'; // WF1: OMS System
  const WP2  = 'wp111111-0000-0000-0000-000000000002'; // WF1: Held Order Triage Agent
  const WP3  = 'wp111111-0000-0000-0000-000000000003'; // WF1: Operations Manager (Sam O.)
  const WP4  = 'wp111111-0000-0000-0000-000000000004'; // WF1: Team Lead / Reviewer (Priya R.)
  const WP5  = 'wp111111-0000-0000-0000-000000000005'; // WF2: OMS System
  const WP6  = 'wp111111-0000-0000-0000-000000000006'; // WF2: Customer Notification Agent
  const WP7  = 'wp111111-0000-0000-0000-000000000007'; // WF2: CS Supervisor
  const WP8  = 'wp111111-0000-0000-0000-000000000008'; // WF3: Returns Portal System
  const WP9  = 'wp111111-0000-0000-0000-000000000009'; // WF3: Returns Assessment Agent
  const WP10 = 'wp111111-0000-0000-0000-000000000010'; // WF3: Returns Manager

  ins(`INSERT OR IGNORE INTO asdlc_workflow_participant
    (workflow_participant_id, workflow_id, project_id, slug,
     participant_type, agent_spec_id, human_role_name,
     purpose_in_workflow, authority_level, handoff_method,
     swimlane_display_name, lane_order, include_in_rasic, rasic_column_order,
     lifecycle_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    // WF1 — Held Order Triage
    [WP1, WF1, P1, 'P-001', 'Orchestrator Agent', null, 'Oracle Retail OMS',
      'Detects held order events from the OMS event stream and applies resolved decisions',
      'Execute (autonomous)', 'Notification',
      'Oracle Retail OMS', 1, 1, 1, 'active'],
    [WP2, WF1, P1, 'P-002', 'Specialist Agent', AS1, null,
      'Classifies hold reason using taxonomy and produces routing decision with confidence score',
      'Execute (gated)', 'Task creation',
      'Triage Agent', 2, 1, 2, 'active'],
    [WP3, WF1, P1, 'P-003', 'Human Role', null, 'Operations Manager',
      'Business accountability for hold resolution; handles exceptions and policy queries',
      'Execute (human)', 'Assignment',
      'Ops Manager', 3, 1, 3, 'active'],
    [WP4, WF1, P1, 'P-004', 'Human Coordinator', null, 'Team Lead (Reviewer)',
      'Final decision-maker for high-value or premium customer holds above HITL-P-22 threshold',
      'Execute (gated)', 'Assignment',
      'Team Lead', 4, 1, 4, 'active'],
    // WF2 — Customer Notification
    [WP5, WF2, P1, 'P-005', 'Orchestrator Agent', null, 'Oracle Retail OMS',
      'Detects order status changes and triggers the notification workflow',
      'Execute (autonomous)', 'Notification',
      'Oracle Retail OMS', 1, 1, 1, 'active'],
    [WP6, WF2, P1, 'P-006', 'Specialist Agent', AS2, null,
      'Drafts personalised customer notifications from approved template library',
      'Execute (gated)', 'Task creation',
      'Notification Agent', 2, 1, 2, 'active'],
    [WP7, WF2, P1, 'P-007', 'Human Coordinator', null, 'CS Supervisor',
      'Reviews notifications before send when refund > $500 or service failure message type',
      'Execute (gated)', 'Panel response',
      'CS Supervisor', 3, 1, 3, 'active'],
    // WF3 — Returns & Refund Processing
    [WP8, WF3, P1, 'P-008', 'Orchestrator Agent', null, 'Oracle Retail Returns Management',
      'Receives return requests via webhook and processes approved refund transactions',
      'Execute (autonomous)', 'Notification',
      'Oracle Retail Returns Management', 1, 1, 1, 'active'],
    [WP9, WF3, P1, 'P-009', 'Specialist Agent', AS3, null,
      'Evaluates return eligibility against policy v2.4 with cited clause references',
      'Execute (gated)', 'Task creation',
      'Returns Agent', 2, 1, 2, 'active'],
    [WP10, WF3, P1, 'P-010', 'Human Coordinator', null, 'Returns Manager',
      'Approves or rejects returns meeting HITL-P-15 criteria (value > $200, age > 30 days)',
      'Execute (gated)', 'Panel response',
      'Returns Manager', 3, 1, 3, 'active'],
  ]);

  // ── 11c. RASIC assignments (Phase 2) ─────────────────────────────────────
  const rasicRows = [
    // WF1 Step 1 — Detect held order
    ['rs111111-0001', WS1, WP1, P1, 'R'], // OMS System: Responsible
    ['rs111111-0002', WS1, WP3, P1, 'A'], // Ops Manager: Accountable
    ['rs111111-0003', WS1, WP3, P1, 'I'], // Ops Manager: Informed (double-coded cell)
    // WF1 Step 2 — Classify hold reason
    ['rs111111-0004', WS2, WP2, P1, 'R'], // Triage Agent: Responsible
    ['rs111111-0005', WS2, WP3, P1, 'A'], // Ops Manager: Accountable
    ['rs111111-0006', WS2, WP4, P1, 'C'], // Team Lead: Consulted (HITL trigger decision)
    // WF1 Step 3 — Route to team
    ['rs111111-0007', WS3, WP1, P1, 'R'], // OMS/Orchestrator: Responsible for routing
    ['rs111111-0008', WS3, WP3, P1, 'A'], // Ops Manager: Accountable
    ['rs111111-0009', WS3, WP4, P1, 'I'], // Team Lead: Informed
    // WF1 Step 4 — Human review & decision
    ['rs111111-0010', WS4, WP4, P1, 'R'], // Team Lead: Responsible
    ['rs111111-0011', WS4, WP4, P1, 'A'], // Team Lead: Accountable
    ['rs111111-0012', WS4, WP3, P1, 'C'], // Ops Manager: Consulted
    // WF1 Step 5 — Apply resolution
    ['rs111111-0013', WS5, WP1, P1, 'R'], // OMS System: Responsible
    ['rs111111-0014', WS5, WP3, P1, 'A'], // Ops Manager: Accountable
    // WF2 Step 1 — Detect status change
    ['rs111111-0015', WS6, WP5, P1, 'R'], // OMS System: Responsible
    ['rs111111-0016', WS6, WP3, P1, 'A'], // (reuse WP3 as shared Ops Manager proxy — close enough for demo)
    // WF2 Step 2 — Draft notification
    ['rs111111-0017', WS7, WP6, P1, 'R'], // Notification Agent: Responsible
    ['rs111111-0018', WS7, WP5, P1, 'A'], // OMS System (owner): Accountable
    ['rs111111-0019', WS7, WP7, P1, 'C'], // CS Supervisor: Consulted
    // WF2 Step 3 — Send notification
    ['rs111111-0020', WS8, WP5, P1, 'R'], // OMS System: Responsible
    ['rs111111-0021', WS8, WP5, P1, 'A'], // OMS System: Accountable
    // WF2 Step 4 — Log delivery
    ['rs111111-0022', WS9, WP5, P1, 'R'],
    // WF3 Step 1 — Receive return request
    ['rs111111-0023', WS10, WP8, P1, 'R'],
    ['rs111111-0024', WS10, WP10, P1, 'A'],
    // WF3 Step 2 — Assess eligibility
    ['rs111111-0025', WS11, WP9, P1, 'R'],
    ['rs111111-0026', WS11, WP10, P1, 'A'],
    ['rs111111-0027', WS11, WP10, P1, 'C'],
    // WF3 Step 3 — Authorise return
    ['rs111111-0028', WS12, WP10, P1, 'R'],
    ['rs111111-0029', WS12, WP10, P1, 'A'],
    // WF3 Step 4 — Process refund
    ['rs111111-0030', WS13, WP8, P1, 'R'],
    ['rs111111-0031', WS13, WP10, P1, 'A'],
  ];
  ins(`INSERT OR IGNORE INTO asdlc_workflow_step_rasic
    (rasic_id, workflow_step_id, workflow_participant_id, project_id, code)
    VALUES (?,?,?,?,?)`, rasicRows);

  // ── 11d. WORKFLOW PATHS (Phase 2) ─────────────────────────────────────────
  ins(`INSERT OR IGNORE INTO asdlc_workflow_path
    (workflow_path_id, workflow_id, project_id, slug,
     from_step_id, to_step_id, branch_label, branch_condition, is_default_path)
    VALUES (?,?,?,?,?,?,?,?,?)`, [
    // WF1 — Held Order Triage (branching at steps 2 and 3)
    ['pth11111-0001', WF1, P1, 'PATH-001', WS1, WS2, 'Hold detected', null, 1],
    ['pth11111-0002', WF1, P1, 'PATH-002', WS2, WS3, 'Auto-route', 'confidence >= 0.75', 1],
    ['pth11111-0003', WF1, P1, 'PATH-003', WS2, WS4, 'Escalate for review', 'confidence < 0.75', 0],
    ['pth11111-0004', WF1, P1, 'PATH-004', WS3, WS5, 'Auto-resolve', 'standard hold, confidence >= 0.75', 1],
    ['pth11111-0005', WF1, P1, 'PATH-005', WS3, WS4, 'HITL required', 'hold_value > $1,000 OR customer_tier = Premium', 0],
    ['pth11111-0006', WF1, P1, 'PATH-006', WS4, WS5, 'Resolution approved', null, 1],
    // WF2 — Customer Notification (linear)
    ['pth11111-0007', WF2, P1, 'PATH-007', WS6, WS7, 'Status changed', null, 1],
    ['pth11111-0008', WF2, P1, 'PATH-008', WS7, WS8, 'Notification approved', 'review passed or not required', 1],
    ['pth11111-0009', WF2, P1, 'PATH-009', WS8, WS9, 'Sent', null, 1],
    // WF3 — Returns (linear with one branch on eligibility)
    ['pth11111-0010', WF3, P1, 'PATH-010', WS10, WS11, 'Request received', null, 1],
    ['pth11111-0011', WF3, P1, 'PATH-011', WS11, WS12, 'Eligible — needs authorisation', 'eligibility_decision = approved OR escalate', 1],
    ['pth11111-0012', WF3, P1, 'PATH-012', WS12, WS13, 'Authorised', 'authorisation_decision = approved', 1],
  ]);

  // ── 11e. Update steps with owner_participant_id now participants exist ────
  run(`UPDATE asdlc_workflow_step SET owner_participant_id = ? WHERE workflow_step_id = ? AND owner_participant_id IS NULL`, [WP1, WS1]);
  run(`UPDATE asdlc_workflow_step SET owner_participant_id = ? WHERE workflow_step_id = ? AND owner_participant_id IS NULL`, [WP2, WS2]);
  run(`UPDATE asdlc_workflow_step SET owner_participant_id = ? WHERE workflow_step_id = ? AND owner_participant_id IS NULL`, [WP1, WS3]);
  run(`UPDATE asdlc_workflow_step SET owner_participant_id = ? WHERE workflow_step_id = ? AND owner_participant_id IS NULL`, [WP4, WS4]);
  run(`UPDATE asdlc_workflow_step SET owner_participant_id = ? WHERE workflow_step_id = ? AND owner_participant_id IS NULL`, [WP1, WS5]);
  run(`UPDATE asdlc_workflow_step SET owner_participant_id = ? WHERE workflow_step_id = ? AND owner_participant_id IS NULL`, [WP5, WS6]);
  run(`UPDATE asdlc_workflow_step SET owner_participant_id = ? WHERE workflow_step_id = ? AND owner_participant_id IS NULL`, [WP6, WS7]);
  run(`UPDATE asdlc_workflow_step SET owner_participant_id = ? WHERE workflow_step_id = ? AND owner_participant_id IS NULL`, [WP5, WS8]);
  run(`UPDATE asdlc_workflow_step SET owner_participant_id = ? WHERE workflow_step_id = ? AND owner_participant_id IS NULL`, [WP5, WS9]);
  run(`UPDATE asdlc_workflow_step SET owner_participant_id = ? WHERE workflow_step_id = ? AND owner_participant_id IS NULL`, [WP8, WS10]);
  run(`UPDATE asdlc_workflow_step SET owner_participant_id = ? WHERE workflow_step_id = ? AND owner_participant_id IS NULL`, [WP9, WS11]);
  run(`UPDATE asdlc_workflow_step SET owner_participant_id = ? WHERE workflow_step_id = ? AND owner_participant_id IS NULL`, [WP10, WS12]);
  run(`UPDATE asdlc_workflow_step SET owner_participant_id = ? WHERE workflow_step_id = ? AND owner_participant_id IS NULL`, [WP8, WS13]);

  // Rename ACME system-lane participants to specific product names (no generic "OMS System" / "Returns Portal")
  run(`UPDATE asdlc_workflow_participant
       SET swimlane_display_name = 'Oracle Retail OMS', human_role_name = 'Oracle Retail OMS',
           updated_at = datetime('now')
       WHERE workflow_participant_id IN (?, ?)
         AND (swimlane_display_name = 'OMS System' OR human_role_name = 'OMS System')`, [WP1, WP5]);
  run(`UPDATE asdlc_workflow_participant
       SET swimlane_display_name = 'Oracle Retail Returns Management',
           human_role_name = 'Oracle Retail Returns Management',
           updated_at = datetime('now')
       WHERE workflow_participant_id = ?
         AND (swimlane_display_name = 'Returns Portal' OR human_role_name = 'Returns Portal')`, [WP8]);

  // ── 12. AGENT SPECS ───────────────────────────────────────────────────────
  ins(`INSERT OR IGNORE INTO asdlc_agent_spec
    (agent_spec_id, use_case_id, workflow_id, project_id, name,
     scope, instructions, goals, done_criteria, inputs, outputs, lifecycle_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
    [AS1, UC1, WF1, P1,
      'Held Order Triage Agent',
      'Classifies incoming held orders by hold reason and routes them to the appropriate resolution team. Operates on WF-014 Steps 2–3.',
      'You are a triage agent for ACME order operations. Analyse held order data and classify the hold reason using the provided classification taxonomy and 90-day hold history. Assign a confidence score. If confidence < 0.75, set requires_human_review = true.',
      '["Classify hold_reason to taxonomy enum with confidence >= 0.75","Produce routing_decision within 60 seconds of receiving event","Set hitl_gate trigger when hold_value > $1,000 or customer_tier = Premium"]',
      '["hold_classification field set to valid taxonomy value","confidence_score populated","routing_decision produced","hitl_gate triggered when criteria met"]',
      '{"hold_event":"OMS held order event payload","hold_history":"last 90 days aggregated hold data","taxonomy":"hold_reason classification taxonomy v3"}',
      '{"hold_classification":"string — taxonomy enum value","confidence_score":"float 0.0–1.0","routing_decision":"team identifier string","recommended_action":"string","requires_human_review":"boolean"}',
      'active'],
    [AS2, UC2, WF2, P1,
      'Customer Notification Agent',
      'Generates personalised customer notifications for order status changes. Operates on WF-015 Step 2.',
      'You are a customer communication agent for ACME. Generate clear, brand-consistent order status notifications. Always select from the approved template library. Personalise using customer tier and order history. Flag for HITL review when refund_amount > $500 or message_type = service_failure.',
      '["Select correct template_id from approved library","Populate all personalisation_fields","Set requires_review = true when refund_amount > $500 or service_failure"]',
      '["template_id selected from approved list","draft_notification passes brand tone check","personalisation_flags populated","requires_review correctly set"]',
      '{"status_event":"order status change event","customer_profile":"tier, history, contact preferences","template_library":"approved notification template library"}',
      '{"draft_notification":"formatted message body string","template_id":"string","personalisation_flags":"object","requires_review":"boolean","estimated_send_cost":"float"}',
      'draft'],
    [AS3, UC3, WF3, P1,
      'Returns Assessment Agent',
      'Evaluates return requests against the current returns policy to produce eligibility decisions with cited policy references. Operates on WF-016 Step 2.',
      'You are a returns eligibility agent for ACME. Evaluate each return request against returns policy v2.4. Always cite specific policy clauses for your decision. Flag escalation_flag = true for any case meeting HITL-P-15 criteria (value > $200, age > 30 days, damaged_in_transit).',
      '["Produce eligibility_decision as enum: approved|rejected|escalate","Provide at least one policy_citation for every decision","Set escalation_flag = true when HITL-P-15 criteria are met"]',
      '["eligibility_decision set","minimum one policy_citation provided","HITL-P-15 cases correctly flagged","confidence_score >= 0.70 OR escalation_flag set"]',
      '{"return_request":"return portal request object","order_history":"full order record including delivery dates","policy":"returns policy document v2.4"}',
      '{"eligibility_decision":"enum: approved|rejected|escalate","confidence_score":"float 0.0–1.0","policy_citations":"array of clause reference strings","notes":"string","escalation_flag":"boolean"}',
      'draft'],
  ]);

  // ── 13. TOOLS ─────────────────────────────────────────────────────────────
  ins(`INSERT OR IGNORE INTO asdlc_tool
    (tool_id, project_id, name, contract, inputs, outputs,
     execution_mode, cost_impact, visibility_scope, lifecycle_status)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, [
    [TL1, P1, 'OMS Order API',
      '{"endpoint":"https://oms.internal/api/v2","auth":"Bearer token","rate_limit":"100 req/min","timeout_ms":5000}',
      '{"order_id":"string — required","action":"enum: get|update|hold|release","payload":"object — optional"}',
      '{"order":"full order object","status":"current status string","updated_at":"ISO8601 timestamp"}',
      'sync', 'low', 'PROJECT', 'active'],
    [TL2, P1, 'ServiceNow Case API',
      '{"endpoint":"https://acme.service-now.com/api/now/table","auth":"Basic","rate_limit":"50 req/min","timeout_ms":8000}',
      '{"table":"string — e.g. incident","action":"enum: create|update|get|close","data":"object with field values"}',
      '{"sys_id":"ServiceNow record ID","state":"record state string","number":"case number e.g. INC0012345"}',
      'sync', 'low', 'PROJECT', 'active'],
    [TL3, P1, 'Transactional Email API',
      '{"provider":"SendGrid","endpoint":"https://api.sendgrid.com/v3/mail/send","auth":"API key","rate_limit":"500 req/min"}',
      '{"to":"recipient email string","template_id":"SendGrid template ID","dynamic_data":"personalisation object","from":"sender address"}',
      '{"message_id":"SendGrid message ID","status":"enum: accepted|failed","queued_at":"ISO8601 timestamp"}',
      'async', 'med', 'PROJECT', 'active'],
    [TL4, P1, 'JIRA MCP',
      '{"server":"https://acme.atlassian.net","auth":"OAuth2","project_key":"OPS","rate_limit":"30 req/min"}',
      '{"action":"enum: create|update|search|transition","issue_type":"string","fields":"JIRA field object","jql":"string — for search"}',
      '{"issue_key":"JIRA issue key e.g. OPS-1234","id":"internal issue ID","self":"issue URL","transition_result":"string"}',
      'sync', 'low', 'PROJECT', 'active'],
    [TL5, P1, 'Returns Portal API',
      '{"endpoint":"https://returns.acme.internal/api/v1","auth":"Bearer token","rate_limit":"30 req/min","timeout_ms":10000}',
      '{"return_id":"string — required","action":"enum: get|approve|reject|process_refund","notes":"string — optional"}',
      '{"return":"full return object","refund_transaction_id":"string — populated on process_refund","status":"current return status"}',
      'sync', 'high', 'PROJECT', 'active'],
  ]);

  // ── 13b. PHASE 3 — AGENT ↔ USE CASE links (ACME) ─────────────────────────
  ins(`INSERT OR IGNORE INTO asdlc_agent_use_case
    (agent_use_case_id, agent_spec_id, use_case_id, project_id, business_value)
    VALUES (?,?,?,?,?)`, [
    ['auc-acme-001', AS1, UC1, P1, 'Reduces manual triage time by ~60 min/day; targets AHT: 18 min → 4 min'],
    ['auc-acme-002', AS2, UC2, P1, 'Cuts notification lag from avg 4 h to < 5 min; improves CSAT on delayed orders'],
    ['auc-acme-003', AS3, UC3, P1, 'Automates ~80% of returns eligibility decisions; reduces returns processing cost'],
    // Phase 3 M:N example: AS2 (Customer Notification Agent) also supports UC1
    // by sending "your held order is resolved" messages once the Triage Agent
    // completes. Demonstrates one agent across two use cases.
    ['auc-acme-004', AS2, UC1, P1, 'Resolution-notification path for UC1: emails the customer once a held order clears, closing the loop with the same notification stack used in UC2.'],
  ]);

  // ── 13c. PHASE 3 — AGENT ↔ TOOL bindings (ACME) ──────────────────────────
  ins(`INSERT OR IGNORE INTO asdlc_agent_tool
    (agent_tool_id, agent_spec_id, tool_id, project_id, purpose,
     binding_supervision_model, tool_execution_mode)
    VALUES (?,?,?,?,?,?,?)`, [
    // AS1 (Held Order Triage) ← OMS Order API + ServiceNow Case API
    ['at-acme-001', AS1, TL1, P1, 'Fetch order status, hold reason, and line items for triage classification', 'Autonomous', 'Autonomous'],
    ['at-acme-002', AS1, TL2, P1, 'Create or update the triage case record in ServiceNow', 'Supervised', 'Human-permission required'],
    // AS2 (Customer Notification) ← Transactional Email API + ServiceNow Case API
    // AS2 also serves UC1 (notify customers when held orders resolve) → M:N example
    // (see auc-acme-004 below). Same tool bindings cover both use cases.
    ['at-acme-003', AS2, TL3, P1, 'Send approved customer notification via the transactional email provider', 'Supervised', 'Human-permission required'],
    ['at-acme-004', AS2, TL2, P1, 'Read order case data to populate notification personalisation fields', 'Autonomous', 'Autonomous'],
    // AS3 (Returns Assessment) ← Returns Portal API + OMS Order API
    ['at-acme-005', AS3, TL5, P1, 'Submit the final eligibility decision and notes to the returns portal', 'Supervised', 'Human-permission required'],
    ['at-acme-006', AS3, TL1, P1, 'Retrieve order history and delivery records to support eligibility checks', 'Autonomous', 'Autonomous'],
  ]);

  // ── 14. KNOWLEDGE ARTICLES ────────────────────────────────────────────────
  ins(`INSERT OR IGNORE INTO asdlc_knowledge_article
    (knowledge_article_id, project_id, title, body, trigger_text,
     linked_use_case_id, linked_workflow_id, approved_by, approved_at,
     next_review_date, visibility_scope, lifecycle_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
    [KA1, P1,
      'How to escalate a held order',
      'When an order is held for more than 24 hours without resolution, a team lead must be notified immediately.\n\nEscalation triggers:\n1. Hold value > $1,000\n2. Customer tier = Premium\n3. hold_reason = fraud_suspected\n4. Hold unresolved for > 72 hours\n\nProcess: Use the ServiceNow escalation template OPS-ESC-001. Assign to the on-call team lead via the Case API. Set priority = 2 (High). Include the order_id, hold_reason, hold_duration, and customer_tier in the case description.',
      'order held escalate team lead notify urgent',
      UC1, WF1, M1, '2026-03-15', '2026-07-01', 'PROJECT', 'active'],
    [KA2, P1,
      'Order SLA Policy and Escalation Thresholds',
      'ACME Order Processing SLA Policy (effective 2026-01-01):\n\nResolution targets by customer tier:\n- Standard: 48h target, 72h breach\n- Business: 24h target, 36h breach\n- Premium: 12h target, 24h breach\n\nHigh-value orders (> $1,000): Apply Premium-tier SLA regardless of customer tier.\n\nSLA clock: Starts from first hold detection timestamp in OMS. Paused during scheduled maintenance windows.\n\nEscalation procedure:\n- 80% of SLA threshold: Auto-alert team lead via ServiceNow\n- 100% breach: Auto-escalate to ops manager; JIRA OPS ticket created automatically\n- 150% breach: Escalate to VP Operations; customer proactive contact required within 1 hour',
      'SLA order resolution threshold escalation policy timer breach',
      UC1, WF1, M1, '2026-03-20', '2026-09-01', 'PROJECT', 'active'],
    [KA3, P1,
      'Customer Notification Templates and Guidelines',
      'Approved notification templates (SendGrid template IDs):\n- ORDER_STATUS_001 — Order despatched (template: d-abc001)\n- ORDER_STATUS_002 — Order delayed (template: d-abc002)\n- ORDER_STATUS_003 — Order held: generic (template: d-abc003)\n- ORDER_STATUS_004 — Refund initiated (template: d-abc004)\n\nBrand guidelines:\n- Use customer first name only (not full name)\n- Do not expose internal hold_reason codes in customer-facing text\n- Refund notifications (ORDER_STATUS_004) require CS supervisor approval before sending\n- Maximum SMS length: 160 characters; email: no limit\n- Language: Plain English, friendly tone, no jargon\n\nApproval required: Any notification containing refund_amount > $500 must pass HITL-P-24 (CS supervisor review) before dispatch.',
      'notification template customer order status email SMS brand',
      UC2, WF2, M2, '2026-04-05', '2026-08-01', 'PROJECT', 'active'],
    [KA4, P1,
      'Returns Eligibility Criteria',
      'ACME Returns Policy v2.4 (effective 2026-01-01):\n\nStandard eligibility (ALL criteria must be met):\n1. Return requested within 30 days of confirmed delivery\n2. Item in original packaging (or reasonable equivalent)\n3. Item is not a digital product, software licence, or personalised item\n\nHigh-value returns (refund > $200): Require returns manager authorisation via HITL-P-15.\n\nAge exceptions:\n- Damaged in transit: Always eligible regardless of age. Photo evidence required. Attach to return portal record.\n- Manufacturing defect: Eligible up to 12 months. Customer provides description; agent may request photo evidence.\n\nPolicy exceptions (outside standard criteria): Must be escalated to returns manager with written justification. Agent must set eligibility_decision = escalate and populate notes with justification.\n\nPolicy document: returns_policy_v2_4.pdf (SharePoint: Operations > Returns)',
      'returns eligibility refund policy criteria authorisation age limit',
      UC3, WF3, M1, '2026-04-10', '2026-10-01', 'PROJECT', 'active'],

    // ── Reusable Design Library entries — cross-application patterns ──────
    // GLOBAL = applicable enterprise-wide; ORGANIZATION = within one business line;
    // PROGRAM = within one delivery program.
    [LIB1, null,
      'Pattern: Confidence-Threshold Gating for Auto-Action',
      'Standard pattern for any agent that takes action without human review.\n\nGate logic: Only auto-action when classifier confidence ≥ threshold (default 0.80, tunable per use case post-pilot).\n\nBelow threshold → exit silently OR route to HITL gate. Never partial-action.\n\nRecord classifier confidence and threshold in every audit row. Threshold changes require a Change Packet + governance sign-off.\n\nUse this pattern when: any agent classifies inbound work before deciding to act. Especially relevant for ticket-routing, intent classification, and document categorisation agents.',
      'confidence threshold gating auto-action classifier HITL pattern',
      null, null, null, null, '2027-01-01', 'GLOBAL', 'active'],
    [LIB2, null,
      'Pattern: HITL Gate for High-Trust Decisions',
      'When an agent\'s decision has irreversible business impact (refund, contract change, customer-visible action), route through a HITL gate before action.\n\nDesign elements:\n1. Gate type: approval (hard block) vs exception (soft escalate)\n2. Owner role: explicit role, not a name\n3. SLA: max wait time before auto-escalate (typical: 4h business hours)\n4. Handoff mechanism: how the gate item reaches the reviewer (queue, ticket, message)\n5. On-timeout behaviour: fallback to alternate reviewer OR auto-route to manager\n\nDo not use HITL gates for: low-value reversible decisions (e.g. tagging, suggested-text); information-only outputs that humans read but don\'t act on automatically.',
      'HITL human-in-the-loop gate approval high-trust decision',
      null, null, null, null, '2027-01-01', 'GLOBAL', 'active'],
    [LIB3, null,
      'Template: PII Redaction Guardrail',
      'Standard guardrail spec for any agent that processes customer-facing content.\n\nEnforcement level: hard.\n\nScope: All agent outputs that may be surfaced to a customer or external party (emails, notifications, ticket replies, exported reports).\n\nRedaction list (default):\n- Social Security / Tax IDs\n- Full credit card numbers (mask all but last 4)\n- Internal employee IDs\n- Internal system error codes / stack traces\n- Internal cost / margin data\n\nImplementation: pre-publish hook on agent output. Block + alert on violation.\n\nReview frequency: quarterly with infosec.',
      'PII redaction guardrail privacy customer-facing template',
      null, null, null, null, '2026-12-15', 'GLOBAL', 'active'],
    [LIB4, null,
      'Standard: Audit Row Required Fields',
      'Every agent action that mutates external state MUST emit an audit row with the following minimum fields:\n\n- agent_spec_id\n- run_id (UUID per invocation)\n- timestamp_utc\n- input_hash (SHA-256 of input payload)\n- output_hash (SHA-256 of output payload)\n- model_id + model_version + temperature\n- classifier_confidence (if applicable)\n- guardrails_passed (list of guardrail_ids)\n- decision (action_taken | exited_silent | escalated_hitl)\n- hitl_gate_id (if escalated)\n- correlation_id (for tracing across multi-agent flows)\n\nRetention: 7 years for regulated workflows; 2 years otherwise.\n\nStorage: append-only; immutable; signed batches every 24h.',
      'audit log standard required fields compliance retention',
      null, null, null, null, '2027-03-01', 'GLOBAL', 'active'],
    [LIB5, null,
      'Pattern: Idempotent Tool Calls via Correlation Key',
      'Any tool call that mutates external state should be idempotent — re-running with the same correlation_key must produce the same end state, never duplicate the action.\n\nImplementation:\n1. Caller generates a correlation_key (UUID + entity_id + action_type).\n2. Tool checks correlation_key against a 30-day idempotency cache before acting.\n3. If hit: return the cached result, do not re-execute.\n4. If miss: execute, store result + correlation_key in cache.\n\nWhy: Agent retries on transient failures must not double-charge, double-email, double-update.\n\nApplies to: any tool with execution_mode = synchronous AND side_effects = true.',
      'idempotent correlation key tool retry pattern',
      null, null, null, null, '2027-02-01', 'ORGANIZATION', 'active'],
    [LIB6, null,
      'Template: Tool Contract for External REST API',
      'When wrapping an external REST API as an agent tool, the contract must specify:\n\n- endpoint_type: rest\n- base_url + path template\n- auth_method: oauth2 | api_key | mtls | service_account\n- request_schema (JSON Schema)\n- response_schema (JSON Schema)\n- timeout_ms (default 10000, max 60000)\n- retry_policy: { max_attempts, backoff_ms, retry_on: [5xx, network] }\n- rate_limit: { rpm, burst }\n- error_taxonomy: list of expected error types + agent handling for each\n- pii_in_request: bool (drives logging redaction)\n- cost_per_call_usd (estimated, for cost tracking)\n\nKeep contract version-pinned. External API changes are not implicit — require a Change Packet to upgrade.',
      'tool contract REST API external integration template',
      null, null, null, null, '2027-01-15', 'ORGANIZATION', 'active'],
    [LIB7, null,
      'Standard: Agent Model Selection Rationale',
      'Every Agent spec must document its model selection rationale. The run_as_model.rationale field is required at design review sign-off.\n\nRationale should cover:\n1. Why this model tier (frontier vs. small) — driven by task complexity and cost.\n2. Why this trust level (1–5) — driven by reversibility and business impact.\n3. Why this temperature setting — deterministic for classification, creative for drafting.\n4. Fallback model (if primary unavailable) and downgrade behaviour.\n\nReview annually OR on model deprecation OR on cost target changes.\n\nExample: "Sonnet 4.6 chosen for invoice status synthesis. Task requires reading multiple structured sources and producing a templated note. Lower tier (Haiku) tested and failed on multi-source synthesis. Trust level 3 because output is internal-only (not customer-facing). Temperature 0.2 for deterministic output."',
      'model selection rationale standard agent design review',
      null, null, null, null, '2026-12-01', 'ORGANIZATION', 'active'],
    [LIB8, null,
      'Pattern: Silent Exit for Low-Confidence Classification',
      'When an agent\'s job starts with classifying inbound work, define explicit "out-of-scope" behaviour.\n\nDefault pattern: silent exit — agent posts no output, no work note, no audit-visible action other than the classifier confidence log. The original ticket/case proceeds through the legacy path untouched.\n\nWhy silent: avoids polluting the human queue with "I don\'t know" notes; avoids appearing in metrics as a failed run.\n\nWhen NOT to use silent: high-risk domains where unclassified inputs need explicit escalation (fraud, safety, compliance).\n\nThreshold tuning: start at 0.80 confidence; instrument both true-positives and false-positives in the first 30 days; adjust post-pilot.',
      'silent exit low confidence classification pattern',
      null, null, null, null, '2027-04-01', 'ORGANIZATION', 'active'],
    [LIB9, null,
      'Template: Test Case Skeleton (Unit / Integration)',
      'Standard structure for agent and workflow test cases.\n\nMinimum fields per test case:\n- title: short imperative phrase\n- scope: agent | workflow | tool | use_case\n- test_action: what triggers the test (input event + agent invocation)\n- test_input: concrete input payload OR named fixture\n- expected_result: observable outputs + side effects + audit signature\n- pass_criteria: what makes this test green vs red\n- type: happy_path | edge_case | negative | regression\n\nHappy path: golden input → golden output.\nEdge cases: boundary values, malformed inputs, partial data, race conditions.\nNegative: explicitly blocked inputs (PII leak, prohibited content, etc.).\nRegression: anchor to a fixed past bug; rerun on every release.',
      'test case template skeleton unit integration QA',
      null, null, null, null, '2027-01-01', 'PROGRAM', 'active'],
    [LIB10, null,
      'Pattern: Multi-Agent Handoff via Structured Message',
      'When two agents must hand off work mid-workflow, use a structured handoff message rather than free-text.\n\nMessage shape:\n{\n  interaction_id: uuid,\n  from: agent_spec_id,\n  to: agent_spec_id | role,\n  trigger_condition: predicate ("score < 0.7", "category == refund"),\n  payload: { ... typed fields ... },\n  execution_pattern: sync | async | fire_and_forget,\n  on_success: ack_template_id,\n  on_failure: fallback_workflow_id\n}\n\nBenefits: traceable; replayable; easier to test in isolation.\n\nAnti-pattern: passing free-text "instructions" between agents — brittle, hard to audit, prone to instruction injection.',
      'multi-agent handoff structured message pattern',
      null, null, null, null, '2027-03-01', 'PROGRAM', 'active'],
    [LIB11, null,
      'Governance Control: Production Promotion Gate',
      'Before any agent runs in production:\n\nRequired sign-offs (recorded as approved Change Packets):\n1. Product Owner — accepts the user-facing acceptance criteria.\n2. Tech Lead — accepts the agent spec, tools, and integration design.\n3. InfoSec — accepts the guardrails and data-source access pattern.\n4. Compliance — accepts the audit log fields and retention policy.\n5. Operations — accepts the runbook + on-call handover.\n\nAdditional requirements:\n- All test cases marked happy_path + at least 1 edge_case must be green.\n- No open critical design risks without explicit accepted-risk Change Packet.\n- Baseline locked + versioned.\n\nApply this gate at the project Stage = Production transition.',
      'governance production promotion gate sign-off control',
      null, null, null, null, '2027-06-01', 'GLOBAL', 'active'],
    [LIB12, null,
      'Pattern: Cost Budget per Agent Run',
      'Define an explicit cost ceiling per agent invocation. Reject or escalate runs that would exceed it.\n\nImplementation:\n1. Pre-flight: estimate tokens based on input size and instruction length.\n2. Compare estimate × model_cost_per_token vs configured ceiling.\n3. Over ceiling → exit + alert; do not process.\n4. Track actual cost in audit row; alert on > 20% delta vs estimate.\n\nDefault ceilings (per invocation):\n- Internal-facing low-stakes: $0.05\n- Internal-facing high-stakes: $0.25\n- Customer-facing: $0.50\n\nReview ceilings quarterly with finance + the agent owner.',
      'cost budget ceiling agent run pattern finance',
      null, null, null, null, '2027-02-15', 'ORGANIZATION', 'active'],
  ]);

  // ── 13d. PHASE 4 DEMO FEATURES (ACME) ─────────────────────────────────────
  // Three additions that exercise downstream capabilities end-to-end:
  //  (i)   A Decision step + branching path in WF1 (S3 'Route to team' now branches:
  //         a) auto-route to standard queue, or b) escalate via Approval to manager).
  //         The path rows already exist (PATH-001..PATH-006); we just retype S3.
  //  (ii)  Cost bindings on WF1 so the Costs module has ACME data — including one
  //         binding on S1 (owned by WP1 'OMS System', a non-agent participant) so
  //         the 'Non-Agentic Costs' bucket has real ACME content too.
  //  (iii) A baseline_cost on UC1 so the ROI display works.

  // (i) Retype S3 to Decision (the branching origin)
  run(`UPDATE asdlc_workflow_step SET step_type = 'Decision', updated_at = datetime('now')
       WHERE workflow_step_id = ?`, [WS3]);

  // (ii) ACME cost bindings — light coverage of WF1 only
  ins(`INSERT OR IGNORE INTO asdlc_workflow_step_cost_binding
    (binding_id, workflow_step_id, project_id, skill_name, qty_per_run,
     branch_probability, ai_generated, ai_reasoning)
    VALUES (?,?,?,?,?,?,?,?)`, [
    // S1 (Detect held order) — owned by OMS System (non-agent participant). Models
    // the platform-side Now Assist consumption that triggers the workflow.
    ['cb-acme-001', WS1, P1, 'Knowledge graph query', 1, null, 0,
      'Platform-side trigger lookup against the OMS event store. Non-agentic step — keeps the Non-Agentic Costs bucket populated.'],
    // S2 (Classify hold reason) — owned by the Triage Agent
    ['cb-acme-002', WS2, P1, 'Incident assist', 1, null, 0,
      'Triage agent reads the held-order ticket and classifies the hold reason. Incident assist is the right ITSM skill for ticket-grounded classification.'],
    // S3 (Decision: Route to team) — agent reasoning over classification output
    ['cb-acme-003', WS3, P1, 'Summarization (of any type)', 1, null, 0,
      'Agent summarises the classification + customer tier + value to select the routing target. Lightweight summarization.'],
    // S4 (Apply auto-resolution if eligible) — covers ~70% of runs
    ['cb-acme-004', WS4, P1, 'Subflows and actions', 1, 0.7, 0,
      'Auto-resolution path: IntegrationHub subflow applies the standard remediation. Branch probability ~70% (the auto-resolvable cases).'],
    // S5 (Final action / case closure)
    ['cb-acme-005', WS5, P1, 'Refine records', 1, null, 0,
      'Updates the ServiceNow case record with the resolution outcome.'],
  ]);

  // (iii) Set runs_per_period on WF1 and baseline on UC1 so cost + ROI display
  run(`UPDATE asdlc_workflow SET runs_per_period = COALESCE(runs_per_period, 500),
       updated_at = datetime('now') WHERE workflow_id = ?`, [WF1]);
  run(`UPDATE asdlc_use_case SET baseline_cost_annual_usd = COALESCE(baseline_cost_annual_usd, 420000),
       supervision_model = COALESCE(supervision_model, 'Supervised HITL'),
       updated_at = datetime('now') WHERE use_case_id = ?`, [UC1]);

  // ── 14b. ACCEPTANCE CRITERIA — Agentic Invoice Lookup (ExxonMobil) ─────────
  // References real entity IDs in the EXX-P1 project.
  const EXX_PROJ = 'EE000000-0000-0000-0000-000000000010';
  const EXX_UC   = 'EE000000-0000-0000-0000-000000000040';
  const EXX_WF   = 'EE000000-0000-0000-0000-000000000050';
  const EXX_AG   = 'EE000000-0000-0000-0000-000000000080';
  const EXX_T1   = 'EE000000-0000-0000-0000-000000000091'; // invoice_search_lookup
  const EXX_T2   = 'EE000000-0000-0000-0000-000000000092'; // sap_invoice_detail
  const EXX_T3   = 'EE000000-0000-0000-0000-000000000093'; // ticket_work_note_post
  const EXX_T4   = 'EE000000-0000-0000-0000-000000000094'; // supplier_master_lookup

  // ExxonMobil step ID shorthands
  const EXX_S1 = 'EE000000-0000-0000-0000-000000000061'; // S-001 Ticket Read & Classification
  const EXX_S2 = 'EE000000-0000-0000-0000-000000000062'; // S-002 Identifier Extraction & Typing
  const EXX_S3 = 'EE000000-0000-0000-0000-000000000063'; // S-003 Invoice Search Lookup
  const EXX_S4 = 'EE000000-0000-0000-0000-000000000064'; // S-004 SAP Detail Lookup (conditional)
  const EXX_S5 = 'EE000000-0000-0000-0000-000000000065'; // S-005 Synthesis & Sensitivity Check
  const EXX_S6 = 'EE000000-0000-0000-0000-000000000066'; // S-006 Post Work Note

  // ── 14b-phase2. WORKFLOW PARTICIPANTS — Agentic Invoice Lookup ────────────
  const EWP1 = 'wp222222-0000-0000-0000-000000000001'; // ServiceNow Platform (Orchestrator)
  const EWP2 = 'wp222222-0000-0000-0000-000000000002'; // Invoice Status Lookup Assistant (Specialist)
  const EWP3 = 'wp222222-0000-0000-0000-000000000003'; // IT Fulfiller (Human Role)
  const EWP4 = 'wp222222-0000-0000-0000-000000000004'; // Workbench Admin (Human Coordinator)

  ins(`INSERT OR IGNORE INTO asdlc_workflow_participant
    (workflow_participant_id, workflow_id, project_id, slug,
     participant_type, agent_spec_id, human_role_name,
     purpose_in_workflow, authority_level, handoff_method,
     swimlane_display_name, lane_order, include_in_rasic, rasic_column_order,
     lifecycle_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    [EWP1, EXX_WF, EXX_PROJ, 'P-001', 'Orchestrator Agent', null, 'ServiceNow',
      'Invokes the agent via Now Assist panel on ticket creation; receives the completed work note',
      'Execute (autonomous)', 'Notification',
      'ServiceNow', 1, 1, 1, 'active'],
    [EWP2, EXX_WF, EXX_PROJ, 'P-002', 'Specialist Agent', EXX_AG, null,
      'Executes all six workflow steps — classification, identifier extraction, search, SAP lookup, synthesis, and work note posting',
      'Execute (gated)', 'Task creation',
      'Invoice Agent', 2, 1, 2, 'active'],
    [EWP3, EXX_WF, EXX_PROJ, 'P-003', 'Human Role', null, 'IT Fulfiller',
      'Downstream consumer of the work note; reviews findings and responds to the requester',
      'Advise only', 'Notification',
      'IT Fulfiller', 3, 1, 3, 'active'],
    [EWP4, EXX_WF, EXX_PROJ, 'P-004', 'Human Coordinator', null, 'Workbench Admin',
      'Exception handler — invoked by the HITL gate on agent crash, repeated tool failure, or sensitivity-check failure',
      'Execute (human)', 'Assignment',
      'Admin', 4, 1, 4, 'active'],
  ]);

  // ── 14b-phase2c. RASIC assignments — Agentic Invoice Lookup ──────────────
  ins(`INSERT OR IGNORE INTO asdlc_workflow_step_rasic
    (rasic_id, workflow_step_id, workflow_participant_id, project_id, code)
    VALUES (?,?,?,?,?)`, [
    // S-001 — Ticket Read & Classification
    ['rs222222-0001', EXX_S1, EWP2, EXX_PROJ, 'R'], // Invoice Agent: Responsible
    ['rs222222-0002', EXX_S1, EWP1, EXX_PROJ, 'A'], // Platform: Accountable
    // S-002 — Identifier Extraction & Typing
    ['rs222222-0003', EXX_S2, EWP2, EXX_PROJ, 'R'],
    ['rs222222-0004', EXX_S2, EWP1, EXX_PROJ, 'A'],
    // S-003 — Invoice Search Lookup
    ['rs222222-0005', EXX_S3, EWP2, EXX_PROJ, 'R'],
    ['rs222222-0006', EXX_S3, EWP1, EXX_PROJ, 'A'],
    // S-004 — SAP Detail Lookup (conditional branch)
    ['rs222222-0007', EXX_S4, EWP2, EXX_PROJ, 'R'],
    ['rs222222-0008', EXX_S4, EWP1, EXX_PROJ, 'A'],
    // S-005 — Synthesis & Sensitivity Check
    ['rs222222-0009', EXX_S5, EWP2, EXX_PROJ, 'R'],
    ['rs222222-0010', EXX_S5, EWP1, EXX_PROJ, 'A'],
    ['rs222222-0011', EXX_S5, EWP4, EXX_PROJ, 'C'], // Admin: Consulted (sensitivity exception path)
    // S-006 — Post Work Note
    ['rs222222-0012', EXX_S6, EWP2, EXX_PROJ, 'R'],
    ['rs222222-0013', EXX_S6, EWP1, EXX_PROJ, 'A'],
    ['rs222222-0014', EXX_S6, EWP3, EXX_PROJ, 'I'], // IT Fulfiller: Informed (receives work note)
  ]);

  // ── 14b-phase2d. WORKFLOW PATHS — Agentic Invoice Lookup ─────────────────
  ins(`INSERT OR IGNORE INTO asdlc_workflow_path
    (workflow_path_id, workflow_id, project_id, slug,
     from_step_id, to_step_id, branch_label, branch_condition, is_default_path)
    VALUES (?,?,?,?,?,?,?,?,?)`, [
    ['pth22222-0001', EXX_WF, EXX_PROJ, 'PATH-001', EXX_S1, EXX_S2, 'Classified', 'classifier_confidence >= 0.80', 1],
    ['pth22222-0002', EXX_WF, EXX_PROJ, 'PATH-002', EXX_S2, EXX_S3, 'Identifiers extracted', null, 1],
    ['pth22222-0003', EXX_WF, EXX_PROJ, 'PATH-003', EXX_S3, EXX_S4, 'SAP lookup needed', 'invoice_status IN (blocked, on-hold)', 0],
    ['pth22222-0004', EXX_WF, EXX_PROJ, 'PATH-004', EXX_S3, EXX_S5, 'No SAP needed', 'invoice_status NOT IN (blocked, on-hold)', 1],
    ['pth22222-0005', EXX_WF, EXX_PROJ, 'PATH-005', EXX_S4, EXX_S5, 'SAP detail retrieved', null, 1],
    ['pth22222-0006', EXX_WF, EXX_PROJ, 'PATH-006', EXX_S5, EXX_S6, 'Sensitivity check passed', 'no_sensitive_content OR content_redacted', 1],
  ]);

  // ── 14b-phase2e. Step owner_participant_id — Agentic Invoice Lookup ───────
  run(`UPDATE asdlc_workflow_step SET owner_participant_id = ? WHERE workflow_step_id = ? AND owner_participant_id IS NULL`, [EWP1, EXX_S1]);
  run(`UPDATE asdlc_workflow_step SET owner_participant_id = ? WHERE workflow_step_id = ? AND owner_participant_id IS NULL`, [EWP2, EXX_S2]);
  run(`UPDATE asdlc_workflow_step SET owner_participant_id = ? WHERE workflow_step_id = ? AND owner_participant_id IS NULL`, [EWP2, EXX_S3]);
  run(`UPDATE asdlc_workflow_step SET owner_participant_id = ? WHERE workflow_step_id = ? AND owner_participant_id IS NULL`, [EWP2, EXX_S4]);
  run(`UPDATE asdlc_workflow_step SET owner_participant_id = ? WHERE workflow_step_id = ? AND owner_participant_id IS NULL`, [EWP2, EXX_S5]);
  run(`UPDATE asdlc_workflow_step SET owner_participant_id = ? WHERE workflow_step_id = ? AND owner_participant_id IS NULL`, [EWP2, EXX_S6]);

  // ── 14b-phase2f. SWIMLANE COMPLETENESS — add Requester, SAP, IT Fulfiller review ──
  // Goal: BPMN-style swimlane shows the *full* request lifecycle, including the
  // upstream human Requester, the downstream IT Fulfiller review, and SAP as
  // its own system lane (currently SAP was only mentioned in a step *name*).
  const EWP5     = 'wp222222-0000-0000-0000-000000000005'; // Requester (Human Role)
  const EWP6     = 'wp222222-0000-0000-0000-000000000006'; // SAP (External System)
  const EXX_S0   = 'EE000000-0000-0000-0000-000000000060'; // S-000 Submit invoice status request (Requester)
  const EXX_S_SAP = 'EE000000-0000-0000-0000-000000000067'; // S-007 SAP returns invoice record
  const EXX_S_END = 'EE000000-0000-0000-0000-000000000068'; // S-008 Review work note & resolve ticket (IT Fulfiller)

  // New participants
  ins(`INSERT OR IGNORE INTO asdlc_workflow_participant
    (workflow_participant_id, workflow_id, project_id, slug,
     participant_type, agent_spec_id, human_role_name,
     purpose_in_workflow, authority_level, handoff_method,
     swimlane_display_name, lane_order, include_in_rasic, rasic_column_order,
     lifecycle_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    [EWP5, EXX_WF, EXX_PROJ, 'P-005', 'Human Role', null, 'Requester',
      'End-user employee who submits an invoice status request via a Service Request ticket',
      'Advise only', 'Task creation',
      'Requester', 0, 1, 0, 'active'],
    [EWP6, EXX_WF, EXX_PROJ, 'P-006', 'Orchestrator Agent', null, 'SAP ERP',
      'External system of record for invoice and PO detail; responds to IntegrationHub lookup calls',
      'Execute (autonomous)', 'Other',
      'SAP', 5, 0, 5, 'active'],
  ]);

  // New steps
  ins(`INSERT OR IGNORE INTO asdlc_workflow_step
    (workflow_step_id, workflow_id, project_id, slug, step_number, name,
     step_type, step_purpose, owner_participant_id,
     inputs, outputs, decisions_list, lifecycle_status, is_end_step)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    [EXX_S0, EXX_WF, EXX_PROJ, 'S-000', 0, 'Submit invoice status request',
      'Start', 'Requester opens a Service Request asking for the status of a specific invoice or PO',
      EWP5,
      '["Requester identity","Free-text question with invoice/PO identifiers"]',
      '["Service Request ticket created in ServiceNow"]',
      '[]', 'draft', 0],
    [EXX_S_SAP, EXX_WF, EXX_PROJ, 'S-007', 45, 'PO / invoice detail lookup',
      'Activity', 'SAP returns full invoice or PO record (status, amount, posting date, supplier) in response to IntegrationHub call',
      EWP6,
      '["Identifier (invoice_id / PO_id)","Tenant + auth context from IntegrationHub"]',
      '["Full invoice/PO record","Lookup latency"]',
      '[]', 'draft', 0],
    [EXX_S_END, EXX_WF, EXX_PROJ, 'S-008', 99, 'Review work note & resolve ticket',
      'End', 'IT Fulfiller reads the agent-posted work note, validates accuracy, and resolves or escalates the ticket',
      EWP3,
      '["Work note content posted by Invoice Agent","Original ticket context"]',
      '["Ticket state set to Resolved (or escalated)","Optional feedback to requester"]',
      '[]', 'draft', 1],
  ]);

  // Rename P-001's display name from generic "Platform" to "ServiceNow"
  run(`UPDATE asdlc_workflow_participant
       SET swimlane_display_name = 'ServiceNow', human_role_name = 'ServiceNow',
           updated_at = datetime('now')
       WHERE workflow_participant_id = ?
         AND (swimlane_display_name = 'Platform' OR human_role_name = 'ServiceNow Platform')`, [EWP1]);

  // Update existing steps: S-001 is no longer the Start (Requester step is), S-006 is no longer End (IT Fulfiller review is)
  run(`UPDATE asdlc_workflow_step
       SET step_type = 'Activity', updated_at = datetime('now')
       WHERE workflow_step_id = ? AND step_type = 'Start'`, [EXX_S1]);
  run(`UPDATE asdlc_workflow_step
       SET step_type = 'Activity', is_end_step = 0, updated_at = datetime('now')
       WHERE workflow_step_id = ? AND step_type = 'End'`, [EXX_S6]);

  // New paths: tie requester / SAP / IT Fulfiller into the existing flow
  ins(`INSERT OR IGNORE INTO asdlc_workflow_path
    (workflow_path_id, workflow_id, project_id, slug,
     from_step_id, to_step_id, branch_label, branch_condition, is_default_path)
    VALUES (?,?,?,?,?,?,?,?,?)`, [
    ['pth22222-0007', EXX_WF, EXX_PROJ, 'PATH-007', EXX_S0,    EXX_S1,    'Ticket created',           null, 1],
    ['pth22222-0008', EXX_WF, EXX_PROJ, 'PATH-008', EXX_S4,    EXX_S_SAP, 'Call SAP via IntegrationHub', null, 1],
    ['pth22222-0009', EXX_WF, EXX_PROJ, 'PATH-009', EXX_S_SAP, EXX_S5,    'SAP detail returned',      null, 1],
    ['pth22222-0010', EXX_WF, EXX_PROJ, 'PATH-010', EXX_S6,    EXX_S_END, 'Work note posted',         null, 1],
  ]);

  // Remove the obsolete direct path S-004 → S-005 (now goes via SAP)
  run(`DELETE FROM asdlc_workflow_path WHERE workflow_path_id = 'pth22222-0005'`);

  // ── Phase 3 — AGENT ↔ USE CASE + TOOL bindings (ExxonMobil) ─────────────
  ins(`INSERT OR IGNORE INTO asdlc_agent_use_case
    (agent_use_case_id, agent_spec_id, use_case_id, project_id, business_value)
    VALUES (?,?,?,?,?)`, [
    ['auc-exx-001', EXX_AG, EXX_UC, EXX_PROJ, 'Reduces invoice lookup time from ~8 min manual to < 30 s; targets 100+ tickets/day throughput'],
  ]);

  ins(`INSERT OR IGNORE INTO asdlc_agent_tool
    (agent_tool_id, agent_spec_id, tool_id, project_id, purpose,
     binding_supervision_model, tool_execution_mode)
    VALUES (?,?,?,?,?,?,?)`, [
    ['at-exx-001', EXX_AG, EXX_T1, EXX_PROJ, 'Search ServiceNow for invoice and PO records matching extracted identifiers', 'Autonomous', 'Autonomous'],
    ['at-exx-002', EXX_AG, EXX_T2, EXX_PROJ, 'Retrieve full invoice detail from SAP when status is blocked or on-hold', 'Autonomous', 'Autonomous'],
    ['at-exx-003', EXX_AG, EXX_T3, EXX_PROJ, 'Post the synthesised Work Note back to the originating Service Request ticket', 'Supervised', 'Human-permission required'],
    ['at-exx-004', EXX_AG, EXX_T4, EXX_PROJ, 'Resolve supplier name from master data when identifier extraction yields a supplier reference', 'Autonomous', 'Autonomous'],
  ]);

  ins(`INSERT OR IGNORE INTO asdlc_acceptance_criterion
    (acceptance_criterion_id, project_id, parent_type, parent_id, text, source, status)
    VALUES (?,?,?,?,?,?,?)`, [
    // Use Case-level AC (PO sign-off)
    ['ee000000-ac00-0000-0000-000000000001', EXX_PROJ, 'use_case', EXX_UC,
     'When a Service Request ticket of category "invoice status" is created, the agent must produce a Work Note on the ticket within 90 seconds OR exit silently.',
     'generated', 'draft'],
    ['ee000000-ac00-0000-0000-000000000002', EXX_PROJ, 'use_case', EXX_UC,
     'The agent must classify ticket scope at confidence ≥ 0.80 before taking any action; below threshold it exits silently with no Work Note posted.',
     'generated', 'draft'],
    ['ee000000-ac00-0000-0000-000000000003', EXX_PROJ, 'use_case', EXX_UC,
     'Every Work Note must explicitly list which identifiers (PO / invoice / supplier) were used and which were attempted but not found.',
     'generated', 'draft'],
    ['ee000000-ac00-0000-0000-000000000004', EXX_PROJ, 'use_case', EXX_UC,
     'When sensitivity check flags content (e.g. embedded supplier banking detail), the relevant text must be redacted from the Work Note before posting.',
     'generated', 'draft'],
    ['ee000000-ac00-0000-0000-000000000005', EXX_PROJ, 'use_case', EXX_UC,
     'Every agent run must produce an audit log entry containing input_hash, output_hash, classifier_confidence, tools_called, and timestamps.',
     'generated', 'draft'],
    ['ee000000-ac00-0000-0000-000000000006', EXX_PROJ, 'use_case', EXX_UC,
     'The agent must never write to customer-visible fields, send outbound communication, or modify invoice/payment data — read-only on source systems, write-only to the originating ticket\'s Work Notes field.',
     'generated', 'approved'],
    ['ee000000-ac00-0000-0000-000000000007', EXX_PROJ, 'use_case', EXX_UC,
     'Fulfiller satisfaction (post-pilot survey) must average ≥ 4 / 5 and time-to-respond on invoice-status tickets must improve ≥ 25% vs the pre-pilot baseline.',
     'generated', 'draft'],

    // User Story-level AC (more granular, attached by story_id_ref)
    ['ee000000-ac01-0000-0000-000000000010', EXX_PROJ, 'user_story', 'US1',
     'Given a new Service Request with category = "invoice_status", the agent is invoked within 5 seconds of ticket creation.',
     'generated', 'draft'],
    ['ee000000-ac01-0000-0000-000000000011', EXX_PROJ, 'user_story', 'US2',
     'Given a ticket with classifier_confidence < 0.80, no Work Note is posted and the run is logged with decision = exited_silent.',
     'generated', 'draft'],
    ['ee000000-ac01-0000-0000-000000000012', EXX_PROJ, 'user_story', 'US2',
     'Given a ticket with classifier_confidence ≥ 0.80, the agent proceeds to identifier extraction.',
     'generated', 'draft'],
    ['ee000000-ac01-0000-0000-000000000013', EXX_PROJ, 'user_story', 'US3',
     'Every extracted identifier must be tagged with its type (PO / invoice_number / supplier_name) and a confidence score.',
     'generated', 'draft'],
    ['ee000000-ac01-0000-0000-000000000014', EXX_PROJ, 'user_story', 'US4',
     'When Invoice Search returns a result for any extracted identifier, its payment_status, due_date, and last_action_date must appear in the Work Note.',
     'generated', 'draft'],
    ['ee000000-ac01-0000-0000-000000000015', EXX_PROJ, 'user_story', 'US5',
     'SAP detail is only called when Invoice Search shows status = blocked / on-hold; otherwise SAP is not called.',
     'generated', 'draft'],
    ['ee000000-ac01-0000-0000-000000000016', EXX_PROJ, 'user_story', 'US6',
     'The Work Note must follow the approved template: Source summary → Identifiers used → Findings → Items not found → Timestamps.',
     'generated', 'draft'],
    ['ee000000-ac01-0000-0000-000000000017', EXX_PROJ, 'user_story', 'US7',
     'When sensitivity check identifies banking detail in the synthesized note, the affected substring is replaced with "[redacted: banking]" before posting.',
     'generated', 'draft'],
    ['ee000000-ac01-0000-0000-000000000018', EXX_PROJ, 'user_story', 'US8',
     'The Work Note is posted via the ticket_work_note_post tool only — no other write surface is used.',
     'generated', 'draft'],
    ['ee000000-ac01-0000-0000-000000000019', EXX_PROJ, 'user_story', 'US10',
     'A regression test pack must run automatically on every prompt change or tool contract change; merge is blocked on red.',
     'generated', 'draft'],
    ['ee000000-ac01-0000-0000-000000000020', EXX_PROJ, 'user_story', 'US11',
     'A weekly report must surface fulfiller satisfaction trend and any > 5% drift in classification accuracy.',
     'generated', 'draft'],
  ]);

  // ── 14c. TEST CASES — Agentic Invoice Lookup (ExxonMobil) ──────────────────
  ins(`INSERT OR IGNORE INTO asdlc_test_case
    (test_case_id, project_id, scope, scope_entity_id, title, test_action, test_input,
     expected_result, case_type, source, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [

    // ─── USE CASE (integration) ──────────────────────────────────────────
    ['ee000000-tc00-0000-0000-000000000101', EXX_PROJ, 'use_case', EXX_UC,
     'Happy path: in-scope ticket with all identifiers resolvable',
     'Create a Service Request with category=invoice_status. Description contains PO #4500012345 and invoice #INV-99821. Wait for the agent to run.',
     'Ticket: category=invoice_status, description="Customer asking about invoice INV-99821 against PO 4500012345 — status please". Supplier name absent.',
     'Within 90s: Work Note appears on the ticket listing PO + invoice, payment_status from Invoice Search, no SAP call (status not blocked), no redaction. Audit row: classifier_confidence ≥ 0.80, decision=action_taken, tools=[invoice_search_lookup, ticket_work_note_post].',
     'happy_path', 'generated', 'draft'],

    ['ee000000-tc00-0000-0000-000000000102', EXX_PROJ, 'use_case', EXX_UC,
     'Edge: blocked invoice triggers conditional SAP detail call',
     'Submit an in-scope ticket where Invoice Search returns payment_status=blocked for the extracted invoice. Wait for the agent to run.',
     'Ticket asking about invoice INV-77001. Invoice Search response: { payment_status: "blocked", block_reason_code: "Z3" }.',
     'Work Note posted containing both Invoice Search summary AND SAP detail (block reason expansion). Audit row tools list includes sap_invoice_detail. Decision=action_taken.',
     'edge_case', 'generated', 'draft'],

    ['ee000000-tc00-0000-0000-000000000103', EXX_PROJ, 'use_case', EXX_UC,
     'Negative: out-of-scope ticket exits silently',
     'Create a Service Request with category=password_reset. Description mentions an invoice in passing but the primary intent is unrelated.',
     'Ticket: category=password_reset, description="Cannot log in to vendor portal to check my invoice — please reset". classifier_confidence expected < 0.80.',
     'No Work Note posted. No outbound communication. Audit row exists with decision=exited_silent and classifier_confidence logged.',
     'negative', 'generated', 'draft'],

    ['ee000000-tc00-0000-0000-000000000104', EXX_PROJ, 'use_case', EXX_UC,
     'Edge: only supplier name provided; reverse lookup via Supplier Master',
     'Ticket text contains supplier name but no PO or invoice number. Wait for the agent to run.',
     'Ticket description: "Status of recent invoices from Acme Industrial Supplies Inc?"',
     'Work Note posted summarising recent invoices for the matched supplier (via supplier_master_lookup → invoice_search_lookup). Items not found section explicitly lists "no PO / invoice number supplied".',
     'edge_case', 'generated', 'draft'],

    ['ee000000-tc00-0000-0000-000000000105', EXX_PROJ, 'use_case', EXX_UC,
     'Negative: SAP unavailable should not block partial findings',
     'Trigger an in-scope ticket where invoice is blocked but SAP detail call times out.',
     'invoice_search_lookup returns blocked status; sap_invoice_detail tool returns 504 Gateway Timeout twice (after retry).',
     'Work Note still posted containing Invoice Search findings. "Items not found" section explicitly notes SAP detail could not be retrieved. Run does NOT escalate to the exception HITL gate (single SAP failure, not two consecutive agent failures).',
     'negative', 'generated', 'draft'],

    ['ee000000-tc00-0000-0000-000000000106', EXX_PROJ, 'use_case', EXX_UC,
     'Edge: sensitivity check redacts banking detail',
     'Trigger an in-scope ticket where the synthesized note draft includes supplier IBAN or bank account number from SAP response.',
     'SAP response embeds bank_account="DE89370400440532013000" in the supplier master object passed through.',
     'Work Note posted with bank account substring replaced by "[redacted: banking]". Audit row: sensitivity_flagged=true, redactions=[bank_account].',
     'edge_case', 'generated', 'draft'],

    ['ee000000-tc00-0000-0000-000000000107', EXX_PROJ, 'use_case', EXX_UC,
     'Negative: two consecutive sensitivity failures escalate to HITL',
     'Force two consecutive runs where sensitivity check raises an unparseable error.',
     'Mock sensitivity service to return malformed JSON twice in a row for two different in-scope tickets.',
     'Second failed run posts an exception ticket to the workbench-admin queue (per HITL gate). No Work Note is posted on the failing runs. Auditor sees the chain in the audit log.',
     'negative', 'generated', 'draft'],

    // ─── WORKFLOW ────────────────────────────────────────────────────────
    ['ee000000-tc00-0000-0000-000000000201', EXX_PROJ, 'workflow', EXX_WF,
     'Step 1 → Step 2 handoff fires when category matches',
     'Invoke the workflow with a ticket whose category=invoice_status. Inspect step transitions.',
     'Ticket payload routed into Step 1 (Ticket Read & Classification).',
     'Step 2 (Identifier Extraction & Typing) is invoked with the classified ticket. Handoff message carries classifier_confidence and ticket_id. No skip to Step 3.',
     'happy_path', 'generated', 'draft'],

    ['ee000000-tc00-0000-0000-000000000202', EXX_PROJ, 'workflow', EXX_WF,
     'Step 4 conditional SAP call only fires when blocked',
     'Run the workflow twice: once with Invoice Search status=paid, once with status=blocked.',
     'Two ticket payloads with identical structure differing only in invoice_search_lookup response status.',
     'Run 1 (paid): Step 4 (SAP Detail Lookup) is skipped, flow goes directly to Step 5. Run 2 (blocked): Step 4 is invoked.',
     'happy_path', 'generated', 'draft'],

    ['ee000000-tc00-0000-0000-000000000203', EXX_PROJ, 'workflow', EXX_WF,
     'Step ordering: synthesis runs after all source lookups complete',
     'Run the workflow with a ticket requiring both Invoice Search and SAP lookups.',
     'Blocked invoice; both tool responses successful.',
     'Step 5 (Synthesis & Sensitivity Check) does not start until both Step 3 and Step 4 have returned. No partial synthesis on missing data.',
     'happy_path', 'generated', 'draft'],

    ['ee000000-tc00-0000-0000-000000000204', EXX_PROJ, 'workflow', EXX_WF,
     'Exception HITL gate fires after two consecutive agent crashes',
     'Force two consecutive workflow runs to crash mid-Step 5 (e.g. throw a fatal error from sensitivity check).',
     'Two back-to-back invocations with controlled fatal failure in sensitivity step.',
     'Second crash escalates to the exception HITL gate (owner_role = workbench admin / methodology owner). First crash alone does not escalate.',
     'negative', 'generated', 'draft'],

    ['ee000000-tc00-0000-0000-000000000205', EXX_PROJ, 'workflow', EXX_WF,
     'Step 6 only posts if Step 5 produced a valid note',
     'Run the workflow with conditions that cause Step 5 to abort (e.g. unrecoverable redaction failure).',
     'Step 5 returns synthesis_result = null with reason="redaction_unrecoverable".',
     'Step 6 (Post Work Note) is NOT invoked. The ticket Work Notes field remains untouched. Audit row records the failure point.',
     'negative', 'generated', 'draft'],

    // ─── AGENT (unit) — Invoice Status Lookup Assistant ──────────────────
    ['ee000000-tc00-0000-0000-000000000301', EXX_PROJ, 'agent', EXX_AG,
     'Classifies clearly in-scope ticket above threshold',
     'Pass the agent a ticket payload with clear invoice-status intent. Read the classifier confidence.',
     'Ticket description: "What is the status of invoice INV-99821?" Category: invoice_status.',
     'Classifier emits confidence ≥ 0.80 for scope=invoice_status. Agent proceeds to identifier extraction.',
     'happy_path', 'generated', 'draft'],

    ['ee000000-tc00-0000-0000-000000000302', EXX_PROJ, 'agent', EXX_AG,
     'Exits silently on ambiguous ticket below threshold',
     'Pass the agent a ticket whose body conflates invoice status with another procurement topic.',
     'Ticket description: "Need a new vendor onboarded — also where is invoice INV-001?" Expect mixed-intent confidence < 0.80.',
     'Agent returns decision=exited_silent. No tool calls. Audit row written with classifier_confidence and decision.',
     'edge_case', 'generated', 'draft'],

    ['ee000000-tc00-0000-0000-000000000303', EXX_PROJ, 'agent', EXX_AG,
     'Extracts and types all three identifier kinds',
     'Pass a ticket containing one PO number, one invoice number, and one supplier name in the description.',
     'Description: "Status update needed on PO 4500099001 / invoice INV-44021 for Acme Industrial Supplies Inc."',
     'Extracted identifiers list contains three entries, each with type ∈ {PO, invoice_number, supplier_name} and a confidence score. No type mis-assignments.',
     'happy_path', 'generated', 'draft'],

    ['ee000000-tc00-0000-0000-000000000304', EXX_PROJ, 'agent', EXX_AG,
     'Handles ticket with no extractable identifiers',
     'Pass an in-scope ticket whose body provides no PO, invoice, or supplier name (just "where is my invoice?").',
     'Description: "Where is my invoice? It\'s been weeks." Classifier confidence ≥ 0.80.',
     'Work Note posted. "Identifiers used" section is empty. "Items not found" explicitly lists PO + invoice + supplier as missing. No tool calls to Invoice Search / SAP since nothing to look up.',
     'edge_case', 'generated', 'draft'],

    ['ee000000-tc00-0000-0000-000000000305', EXX_PROJ, 'agent', EXX_AG,
     'Never writes to customer-visible fields',
     'Run the agent against any in-scope ticket. Inspect all field writes performed by the run.',
     'Any successful in-scope ticket invocation.',
     'Only field written is the originating ticket\'s Work Notes. No comment, no outbound email, no customer-visible status update touched.',
     'negative', 'generated', 'approved'],

    ['ee000000-tc00-0000-0000-000000000306', EXX_PROJ, 'agent', EXX_AG,
     'Regression: previously-fixed mis-classification of credit memo tickets',
     'Replay a captured fixture of a "credit memo issued?" ticket that previously misclassified as invoice_status.',
     'Fixture: ticket-fixture-credit-memo-01.json (previously classified at 0.91 confidence as invoice_status — incorrect).',
     'Classifier now returns confidence < 0.80 OR classifies as a separate scope. Agent exits silently.',
     'regression', 'generated', 'draft'],

    // ─── TOOL: invoice_search_lookup ─────────────────────────────────────
    ['ee000000-tc00-0000-0000-000000000401', EXX_PROJ, 'tool', EXX_T1,
     'Contract: lookup by invoice number returns payment_status',
     'Call invoice_search_lookup with a known invoice number.',
     'Input: { invoice_number: "INV-99821" }',
     'Response 200 with shape: { invoice_number, payment_status ∈ {paid|pending|blocked|on-hold}, due_date, last_action_date, last_action_by }. All fields populated for paid invoices.',
     'happy_path', 'generated', 'draft'],

    ['ee000000-tc00-0000-0000-000000000402', EXX_PROJ, 'tool', EXX_T1,
     'Contract: lookup by unknown invoice returns explicit not-found',
     'Call invoice_search_lookup with an invoice number that does not exist.',
     'Input: { invoice_number: "INV-DOES-NOT-EXIST" }',
     'Response with status="not_found" (not a 500). Agent caller can distinguish from system error.',
     'negative', 'generated', 'draft'],

    // ─── TOOL: sap_invoice_detail ────────────────────────────────────────
    ['ee000000-tc00-0000-0000-000000000403', EXX_PROJ, 'tool', EXX_T2,
     'Contract: returns block_reason expansion for blocked invoice',
     'Call sap_invoice_detail with an invoice known to be blocked in Invoice Search.',
     'Input: { invoice_number: "INV-77001" }',
     'Response: { block_reason_code, block_reason_text (human readable), blocked_since_date }. Read-only — no mutation observed in SAP audit.',
     'happy_path', 'generated', 'draft'],

    ['ee000000-tc00-0000-0000-000000000404', EXX_PROJ, 'tool', EXX_T2,
     'Idempotency: repeated identical calls return identical results',
     'Call sap_invoice_detail twice with the same correlation_key within 30 minutes.',
     'Same input payload + correlation_key on both calls.',
     'Both responses are byte-identical. Only one SAP-side audit trail event recorded. Second call hits the idempotency cache.',
     'happy_path', 'generated', 'draft'],

    // ─── TOOL: ticket_work_note_post ─────────────────────────────────────
    ['ee000000-tc00-0000-0000-000000000405', EXX_PROJ, 'tool', EXX_T3,
     'Contract: posts to Work Notes only; cannot write Description',
     'Call ticket_work_note_post with a payload that attempts to set the ticket Description field.',
     'Input: { ticket_id: "INC0012345", work_note: "test", description: "should be ignored" }',
     'Response 200. Ticket Description field is unchanged. Work Notes field contains the new note. Tool contract enforces scope.',
     'negative', 'generated', 'approved'],

    ['ee000000-tc00-0000-0000-000000000406', EXX_PROJ, 'tool', EXX_T3,
     'Contract: rejects work notes exceeding size cap',
     'Call ticket_work_note_post with a 50 KB work_note payload.',
     'Input: { ticket_id: "INC0012345", work_note: "<50KB string>" }',
     'Response 400 with error_code="work_note_too_large". Agent caller can downgrade to truncated summary.',
     'edge_case', 'generated', 'draft'],

    // ─── TOOL: supplier_master_lookup ────────────────────────────────────
    ['ee000000-tc00-0000-0000-000000000407', EXX_PROJ, 'tool', EXX_T4,
     'Contract: fuzzy supplier name returns ranked matches',
     'Call supplier_master_lookup with a partial supplier name with a known typo.',
     'Input: { supplier_name: "Acme Industial Supplies" }  (note: "Industial" typo)',
     'Response: ranked list of supplier records with match_confidence scores. Top match resolves to "Acme Industrial Supplies Inc" with confidence ≥ 0.85.',
     'edge_case', 'generated', 'draft'],

    ['ee000000-tc00-0000-0000-000000000408', EXX_PROJ, 'tool', EXX_T4,
     'Contract: read-only — no supplier record mutations',
     'Call supplier_master_lookup with any input. Inspect supplier master audit for mutations.',
     'Any valid lookup request.',
     'Zero write/update events recorded in supplier master audit for the invocation\'s correlation_key.',
     'negative', 'generated', 'approved'],
  ]);

  // ── 15. EVIDENCE SOURCES ──────────────────────────────────────────────────
  ins(`INSERT OR IGNORE INTO asdlc_evidence_source
    (evidence_source_id, project_id, source_title, source_type,
     source_datetime, uploaded_by, validation_status, notes, lifecycle_status)
    VALUES (?,?,?,?,?,?,?,?,?)`, [
    [EV1, P1, 'SME interview · Order ops · 2026-04-22',
      'transcript',         '2026-04-22', U3, 'validated',
      '14 field-level notes; covers hold reasons, SLA expectations, escalation paths, Step 4 owner change', 'active'],
    [EV2, P1, 'Marked-up Q1 design report',
      'report_markup',      '2026-03-28', U2, 'validated',
      '32 correction notes; covers RACI updates, step ownership, SLA table corrections', 'active'],
    [EV3, P1, 'Corrected Workflow Step Map (Excel)',
      'corrected_template', '2026-04-15', U3, 'unverified',
      'Submitted by Sam O. post-interview; step owner and SLA corrections flagged for verification', 'active'],
    [EV4, P1, 'How to escalate a held order (KA-001)',
      'ka',                 '2026-03-15', U1, 'validated',
      'Existing KA used as supporting evidence for escalation HITL criteria', 'active'],
    [EV5, P1, 'Production signal: avg handle time +18% (Q1 2026)',
      'production_signal',  '2026-04-30', U4, 'conflicting',
      'Conflicts with Q1 design baseline assumption of 12% improvement; raises urgency for UC1', 'active'],
    [EV6, P1, 'Owner walkthrough recording · 7 min',
      'voice_note',         '2026-04-22', U3, 'draft',
      'Audio recording of Sam O. walking through corrected step map; transcript pending', 'active'],
    [EV7, P1, 'Customer satisfaction survey Q1 2026',
      'report_markup',      '2026-04-01', U2, 'validated',
      'NPS data; supports notification use case (UC2) business case; proactive notification cited as top request', 'active'],
    [EV8, P1, 'Returns team process review session · 2026-04-25',
      'transcript',         '2026-04-25', U3, 'validated',
      '9 field-level notes; covers returns eligibility edge cases, policy exceptions, HITL thresholds', 'active'],
  ]);

  // ── 16. SOURCE REFERENCES ─────────────────────────────────────────────────
  ins(`INSERT OR IGNORE INTO asdlc_source_reference
    (source_reference_id, evidence_source_id, reference_label,
     timestamp_or_location, confidence, summary)
    VALUES (?,?,?,?,?,?)`, [
    // EV1 — SME interview T-118
    [SR1,  EV1, 'T-118 §3.2 — Step 4 owner discussion',
      '00:12:34', 'high',
      'Sam O. confirms Step 4 owner should change to Priya R. following post-reorg reporting change'],
    [SR2,  EV1, 'T-118 §4.1 — SLA requirements',
      '00:28:15', 'high',
      'Human review SLA confirmed as 24 hours; corrects 48h in design doc'],
    [SR3,  EV1, 'T-118 §4.3 — Escalation threshold',
      '00:31:50', 'high',
      'Escalation after 72 hours unresolved confirmed by ops manager present in session'],
    // EV2 — Marked-up Q1 design report R-044
    [SR4,  EV2, 'R-044 p.7 — RACI annotation',
      'p.7', 'medium',
      'Reviewer crossed out Sam O. as accountable for Step 4; annotated Priya R.'],
    [SR5,  EV2, 'R-044 p.12 — SLA table correction',
      'p.12', 'high',
      'Corrected SLA table: Step 4 = 24h (was 48h); Step 2 = 1h (was 2h)'],
    // EV3 — Corrected step map
    [SR6,  EV3, 'Excel "Corrected Steps" — row 4 owner',
      'Sheet1 row 4 col C', 'medium',
      'owner_member_id changed from Sam O. to Priya R. — consistent with T-118'],
    [SR7,  EV3, 'Excel "Corrected Steps" — row 2 SLA',
      'Sheet1 row 2 col F', 'low',
      'Step 2 SLA changed from 2h to 1h — low confidence; needs verification against T-118'],
    // EV4 — KA citation
    [SR8,  EV4, 'KA-001 §2 — Escalation thresholds',
      'Section 2', 'high',
      'Policy confirms $1,000 value threshold and Premium tier as HITL-P-22 escalation triggers'],
    // EV5 — Production signal
    [SR9,  EV5, 'Q1 handle time data — Chart 3',
      'Chart 3 p.4', 'medium',
      'Handle time 18% above Q4 baseline; contradicts design assumption of 12% improvement trend'],
    // EV7 — CSAT survey
    [SR10, EV7, 'CSAT Q1 2026 — Notification section p.4',
      'p.4', 'high',
      'Customers who received proactive notifications scored NPS +0.6 vs control group'],
    // EV8 — Returns session
    [SR11, EV8, 'Returns session §1 — Eligibility rules',
      '00:08:20', 'high',
      'Returns manager confirms 30-day and $200 thresholds match current policy v2.4'],
    [SR12, EV8, 'Returns session §2 — Edge cases',
      '00:22:45', 'medium',
      'Damaged in transit always eligible regardless of age; photo evidence requirement confirmed'],
  ]);

  // ── 17. CHANGE PACKETS ────────────────────────────────────────────────────
  ins(`INSERT OR IGNORE INTO asdlc_change_packet
    (change_packet_id, project_id, packet_code, status, summary,
     source_evidence_id, risk_level, conflict_classification,
     baseline_impacting, validation_status,
     approver_member_id, approval_timestamp, decision_notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    [CP1, P1, 'CP-2041', 'pending',
      'Update Step 4 owner and SLA in WF-014',
      EV1, 'high', 'net_new', 1, 'passed', null, null, null],
    [CP2, P1, 'CP-2040', 'pending',
      'Add pre-trigger validation rule to KA-001 (escalation)',
      EV4, 'low',  'net_new', 0, 'passed', null, null, null],
    [CP3, P1, 'CP-2039', 'pending',
      'Conflict: HITL-P-22 and HITL-P-15 approval thresholds overlap on fraud_suspected',
      EV1, 'high', 'conflict', 0, 'failed', null, null, null],
    [CP4, P1, 'CP-2038', 'pending',
      'Add JIRA MCP tool and update Triage Agent instructions',
      null, 'med',  'net_new', 0, 'passed', null, null, null],
    [CP5, P1, 'CP-2037', 'pending',
      'Reduce Notification Agent max_tokens to meet $0.02/notification budget',
      EV7, 'low',  'net_new', 0, 'passed', null, null, null],
    [CP6, P1, 'CP-2036', 'approved',
      'Update WF-014 trigger debounce from 30s to 60s for OMS v3 compatibility',
      null, 'med', 'net_new', 0, 'passed', M2, '2026-04-17T14:32:00', 'OMS v3 confirmed in staging — safe to apply'],
    [CP7, P1, 'CP-2035', 'rejected',
      'Proposal: remove fallback path from WF-014 to simplify routing',
      null, 'high', 'net_new', 0, 'passed', M1, '2026-04-10T09:15:00', 'Rejected — fallback path required for unclassified hold_reasons; risk too high'],
  ]);

  // ── 18. CHANGE PACKET ITEMS ───────────────────────────────────────────────
  ins(`INSERT OR IGNORE INTO asdlc_change_packet_item
    (change_packet_item_id, change_packet_id, entity_type, entity_id,
     field_path, old_value, new_value, rationale)
    VALUES (?,?,?,?,?,?,?,?)`, [

    // CP-2041: WF-014 Step 4 owner + SLA + RACI (3 items)
    [CPI1, CP1, 'workflow_step', WS4, 'owner_member_id',
      M3,
      M2,
      'Post-reorg: Priya R. (Reviewer) now owns Step 4 per T-118 §3.2'],
    [CPI2, CP1, 'workflow_step', WS4, 'sla_hours',
      '48',
      '24',
      'SLA corrected per T-118 §4.1 and R-044 p.12; 24h aligns with current team capacity'],
    [CPI3, CP1, 'workflow_step', WS4, 'raci',
      '{"accountable":"'+M3+'","responsible":"'+M3+'"}',
      '{"accountable":"'+M2+'","responsible":"'+M3+'","consulted":"'+M4+'","informed":"'+M1+'"}',
      'RACI updated to reflect ownership change and add Jordan K. as consulted per R-044 p.7'],

    // CP-2040: KA-001 body and review date (2 items)
    [CPI4, CP2, 'knowledge_article', KA1, 'body',
      'When an order is held for more than 24 hours without resolution, a team lead must be notified immediately.',
      'When an order is held for more than 24 hours without resolution, a team lead must be notified immediately. Pre-trigger validation: confirm order is not already in escalated state (escalation_flag != true) before sending HITL trigger to avoid duplicate tasks.',
      'Prevents duplicate HITL triggers for orders already in escalated state'],
    [CPI5, CP2, 'knowledge_article', KA1, 'next_review_date',
      null,
      '2026-07-01',
      'Establish quarterly review cadence for active operational KAs'],

    // CP-2039: HITL criteria conflict (2 items)
    [CPI6, CP3, 'hitl_gate', HG1, 'criteria',
      'Order hold value > $1,000 OR customer_tier = Premium',
      'Order hold value > $1,000 OR customer_tier = Premium OR hold_reason = fraud_suspected',
      'HITL-P-22 requires fraud_suspected trigger per security review — conflicts with HITL-P-15 overlap'],
    [CPI7, CP3, 'hitl_gate', HG4, 'criteria',
      'Return value > $200 OR order_age_days > 30',
      'Return value > $200 OR order_age_days > 30 OR return_reason = damaged_in_transit',
      'HITL-P-15 needs damaged_in_transit added — creates overlap with HITL-P-22 on fraud routing; requires alignment'],

    // CP-2038: New JIRA MCP tool + agent spec update (2 items)
    [CPI8, CP4, 'tool', TL4, 'lifecycle_status',
      null,
      'active',
      'JIRA MCP approved for P1 scope; enables automated OPS ticket creation on escalation'],
    [CPI9, CP4, 'agent_spec', AS1, 'instructions',
      'You are a triage agent for ACME order operations. Analyse held order data and classify the hold reason using the provided classification taxonomy and 90-day hold history.',
      'You are a triage agent for ACME order operations. Analyse held order data and classify the hold reason using the provided classification taxonomy and 90-day hold history. When escalation is required, use the JIRA MCP tool to create an OPS ticket with priority mapped from hold_classification severity.',
      'Add JIRA MCP usage instructions to Triage Agent for escalation ticket creation'],

    // CP-2037: Notification Agent cost control (1 item)
    [CPI10, CP5, 'agent_spec', AS2, 'run_as_model',
      '{"model":"claude-haiku-4-5","max_tokens":1024,"temperature":0.3}',
      '{"model":"claude-haiku-4-5","max_tokens":512,"temperature":0.3}',
      'Reduce max_tokens 1024→512 to stay within $0.02/notification cost ceiling; tested: 512 tokens sufficient for all approved templates'],

    // CP-2036: WF-014 trigger debounce update (approved)
    [CPI11, CP6, 'workflow', WF1, 'trigger_def',
      '{"event":"order.status.held","system":"OMS","debounce_seconds":30}',
      '{"event":"order.status.held","system":"OMS","debounce_seconds":60}',
      'OMS v3 introduces 60s event debounce; 30s setting causes duplicate triggers in staging'],

    // CP-2035: Remove fallback path (rejected)
    [CPI12, CP7, 'workflow', WF1, 'fallback_paths',
      '[{"condition":"classification_confidence < 0.50","action":"route_to_manual_queue","sla_hours":4}]',
      '[]',
      'Proposed removal of manual-queue fallback to simplify routing — REJECTED: no fallback leaves unclassified orders stranded'],
  ]);

  // ── 19. BASELINES (self-ref parent — insert in order BL1→BL4) ────────────
  ins(`INSERT OR IGNORE INTO asdlc_baseline
    (baseline_id, project_id, baseline_type, baseline_name, baseline_version,
     baseline_status, locked_at, locked_by_member_id, parent_baseline_id,
     created_from_change_packet_id, record_count, field_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
    [BL1, P1, 'draft',      'Draft Design',        'v0.1',
      'approved', '2026-04-01', M1, null,  null, 287, 2841],
    [BL2, P1, 'build',      'Build Baseline',      'v1.0',
      'approved', '2026-04-18', M1, BL1,  CP6,  371, 3703],
    [BL3, P1, 'pilot',      'Pilot Baseline',      'v1.1',
      'draft',    null,         null, BL2, null, 418, 3907],
    [BL4, P1, 'production', 'Production Baseline', 'v2.0',
      'draft',    null,         null, BL3, null,   0,    0],
  ]);

  // ── 20. BASELINE ITEMS (Build Baseline v1.0 snapshot) ────────────────────
  // Captures state of key records at the Build lock point
  ins(`INSERT OR IGNORE INTO asdlc_baseline_item
    (baseline_item_id, baseline_id, entity_type, entity_id, field_path, snapshot_value)
    VALUES (?,?,?,?,?,?)`, [
    // WF-014 workflow snapshot
    [BI1,  BL2, 'workflow', WF1, 'name',        '"WF-014: Held Order Triage"'],
    [BI2,  BL2, 'workflow', WF1, 'readiness',   '"approved"'],
    [BI3,  BL2, 'workflow', WF1, 'trigger_def', '{"event":"order.status.held","system":"OMS","debounce_seconds":30}'],
    // WF-014 Step 4 snapshot at build lock (BEFORE CP-2041 is applied)
    [BI4,  BL2, 'workflow_step', WS4, 'owner_member_id', '"'+M3+'"'],
    [BI5,  BL2, 'workflow_step', WS4, 'sla_hours',       '48'],
    [BI6,  BL2, 'workflow_step', WS4, 'raci',
      '{"accountable":"'+M3+'","responsible":"'+M3+'"}'],
    // HITL-P-22 snapshot at build lock (BEFORE CP-2039 criteria change)
    [BI7,  BL2, 'hitl_gate', HG1, 'criteria',
      '"Order hold value > $1,000 OR customer_tier = Premium"'],
    [BI8,  BL2, 'hitl_gate', HG1, 'sla', '"24 hours"'],
    // UC1 snapshot
    [BI9,  BL2, 'use_case', UC1, 'readiness',        '"approved"'],
    [BI10, BL2, 'use_case', UC1, 'lifecycle_status', '"active"'],
    // OMS Order API snapshot
    [BI11, BL2, 'tool', TL1, 'name',           '"OMS Order API"'],
    [BI12, BL2, 'tool', TL1, 'execution_mode', '"sync"'],
  ]);

  // ── 21. EXCEPTIONS ────────────────────────────────────────────────────────
  ins(`INSERT OR IGNORE INTO asdlc_exception
    (exception_id, project_id, exception_type, severity, description,
     related_entity_type, related_entity_id, suggested_action,
     assigned_member_id, status, change_packet_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
    [EX1, P1, 'conflict', 'high',
      'HITL-P-22 (held order) and HITL-P-15 (returns) prescribe overlapping approval thresholds — fraud_suspected orders could trigger both gates, creating ambiguous routing.',
      'hitl_gate', HG1,
      'Review CP-2039 and align HITL criteria before next baseline lock. Consider a precedence rule: HITL-P-22 takes priority when hold_reason = fraud_suspected.',
      M1, 'open', CP3],
    [EX2, P1, 'failed_validation', 'high',
      'WF-014 Step 3 (Route to team) — owner_member_id is null. Agent cannot produce an auditable routing decision without an accountable owner reference.',
      'workflow_step', WS3,
      'Assign Jordan K. (technical) or Sam O. as owner for Step 3. Create a CP to record the change.',
      M2, 'open', null],
    [EX3, P1, 'low_confidence', 'med',
      'Story Agent produced user stories for KA-001 with confidence score 0.42 — below the 0.60 acceptance threshold. Stories may not accurately reflect the escalation process.',
      'knowledge_article', KA1,
      'Human reviewer (Priya R.) to verify and correct user story mapping. Consider adding more evidence source citations to KA-001.',
      M2, 'open', null],
    [EX4, P1, 'missing_evidence', 'med',
      'WF-014 (Held Order Triage) has no direct transcript or corrected-template evidence linked to the workflow record itself — all citations are routed through KA-001 only.',
      'workflow', WF1,
      'Create source_reference entries linking T-118 (EV1) directly to WF-014 via the workflow entity. Use the Evidence Registry to add these links.',
      M3, 'open', null],
    [EX5, P1, 'governance_sensitive', 'high',
      'WF-015 (Customer Notification) processes customer PII (name, email, order history) in the notification payload. No governance control has been added for WF-015 prior to pilot.',
      'workflow', WF2,
      'Add PII governance control for WF-015. Assign Nia W. (governance) as reviewer. Enable Governance Agent (currently disabled in Trust Console) for this workflow.',
      M1, 'in_review', null],
    [EX6, P1, 'missing_owner', 'med',
      'WF-014 Step 2 (Classify hold reason) has no functional owner. AI Agent steps require an accountable human owner for exception handling and audit trail.',
      'workflow_step', WS2,
      'Assign Sam O. (functional_owner) as owner for Step 2. Raise a CP if this changes the locked baseline.',
      M3, 'open', null],
    [EX7, P1, 'baseline_impacting', 'high',
      'CP-2041 proposes changes to owner_member_id and sla_hours on WF-014 Step 4 — both fields are locked in Build Baseline v1.0. Applying this CP will require a baseline update.',
      'workflow_step', WS4,
      'Approve CP-2041 to apply changes and trigger a Pilot Baseline update. Or reject to maintain Build Baseline values and close this exception.',
      M1, 'in_review', CP1],
  ]);

  // ── 22. REPORT EXPORTS ────────────────────────────────────────────────────
  ins(`INSERT OR IGNORE INTO asdlc_report_export
    (report_export_id, project_id, report_type, format, audience,
     generated_at, title, baseline_id, generated_by_member_id)
    VALUES (?,?,?,?,?,?,?,?,?)`, [
    [RE1, P1, 'excel_review_pack',   'XLSX', 'reviewer',
      '2026-05-03', 'ACME Pilot 1 · Pilot review pack', BL3, M2],
    [RE2, P1, 'consolidated_design', 'DOCX', 'client_steerco',
      '2026-04-28', 'ACME Pilot 1 · Consolidated design report', BL2, M1],
    [RE3, P1, 'baseline_comparison', 'DOCX', 'internal_qa',
      '2026-04-18', 'ACME Pilot 1 · Build → Pilot baseline diff', BL2, M2],
  ]);

  // ── 23. INGEST DOCUMENTS ─────────────────────────────────────────────────
  const ID1 = 'dddddddd-0000-0000-0000-000000000001';
  const ID2 = 'dddddddd-0000-0000-0000-000000000002';
  const ID3 = 'dddddddd-0000-0000-0000-000000000003';
  const ID4 = 'dddddddd-0000-0000-0000-000000000004';
  const ID5 = 'dddddddd-0000-0000-0000-000000000005';

  ins(`INSERT OR IGNORE INTO asdlc_ingest_document
    (ingest_id, project_id, document_title, file_name, file_type, document_type,
     description, ingest_status, uploaded_by, uploaded_at, processing_notes, change_packets_generated)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
    [ID1, P1, 'ACME Pilot 1 — Requirements Workshop Transcript', 'T-118_workshop_transcript.docx', 'docx', 'interview_transcript',
      'Full transcript of the 2-hour requirements workshop with ACME operations team on 2026-04-15.',
      'complete', U1, '2026-04-15 14:32:00',
      'Extracted 22 requirements, 3 process segments, and 5 workflow steps. Generated CP-2037 through CP-2041.', 5],
    [ID2, P1, 'ACME Pilot 1 — AS-IS Process Map v2', 'ACME_ASIS_Process_v2.xlsx', 'xlsx', 'process_map',
      'Excel process map covering the order management workflow, provided by ACME IT.',
      'complete', U2, '2026-04-18 09:15:00',
      'Mapped 4 workflow segments and 14 workflow steps. Identified 2 exceptions and 1 missing owner.', 2],
    [ID3, P1, 'SLA & Governance Policy Document', 'SIG-77_governance_policy.pdf', 'pdf', 'policy_document',
      'ServiceNow governance and SLA policy document from ACME IT security team.',
      'review_required', U3, '2026-04-22 11:00:00',
      'Extracted 6 guardrail rules and 3 governance controls. 2 items flagged for human review — SLA values conflict with existing baseline.', 1],
    [ID4, P1, 'Vendor Integration Spec — VN-12', 'VN-12_integration_spec.pdf', 'pdf', 'technical_spec',
      'Third-party vendor API specification for the payment gateway integration.',
      'processing', U1, '2026-05-06 08:45:00',
      null, 0],
    // ID5 was previously scoped to P2 (Wave 2) — that project was demo noise and
    // has been removed. Reattach to P1 so the doc-history sample on ACME stays
    // meaningful and the FK stays clean.
    [ID5, P1, 'ACME — Future Scope Brief (Phase 2 candidate)', 'ACME_FutureScope_brief.docx', 'docx', 'requirements_doc',
      'Initial scope brief for a candidate Phase 2 expansion covering fulfilment and returns. Pending intake review.',
      'pending', U2, '2026-05-07 10:00:00',
      null, 0],
  ]);

  // ── 24. EXXONMOBIL INGEST DOCUMENT + EXTRACTIONS ─────────────────────────
  const EXX_INGEST = 'eeeeeeee-0000-0000-0000-000000000001';

  ins(`INSERT OR IGNORE INTO asdlc_ingest_document
    (ingest_id, project_id, document_title, file_name, file_type, document_type,
     description, ingest_status, uploaded_by, uploaded_at, processing_notes, change_packets_generated)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
    [EXX_INGEST, EXX_PROJ,
      'Agentic Invoice Lookup — Design & Requirements Package',
      'EXX_Invoice_Lookup_Design_v1.docx', 'docx', 'requirements_doc',
      'Full design package for the Invoice Status Lookup & Work Note Generation workflow, including guardrails, data sources, user stories, and test scenarios.',
      'complete', U1, '2026-04-10 09:00:00',
      'Extracted 6 guardrails, 4 data sources, 11 user stories, 8 test scenarios.', 12],
  ]);

  // Helper to build an extraction_id from a short suffix
  const EX = suffix => `eeeeeeee-ex00-0000-0000-${suffix}`;

  // ── Guardrails ────────────────────────────────────────────────────────────
  ins(`INSERT OR IGNORE INTO asdlc_ingest_extraction
    (extraction_id, ingest_id, entity_type, entity_data, confidence, status)
    VALUES (?,?,?,?,?,?)`, [
    [EX('00000000001'), EXX_INGEST, 'guardrail', JSON.stringify({
      guardrail_id: 'GR-001', name: 'PII Data Masking',
      enforcement_level: 'hard',
      description: 'Agent must not expose full supplier banking details, full PAN, or SSN in any ServiceNow Work Note. Flagged fields must be replaced with [redacted] before posting.',
    }), 0.95, 'staged'],
    [EX('00000000002'), EXX_INGEST, 'guardrail', JSON.stringify({
      guardrail_id: 'GR-002', name: 'Confidence Threshold Gate',
      enforcement_level: 'hard',
      description: 'If the ML classifier returns confidence < 0.80 the agent must exit silently — no Work Note posted, run logged with decision = exited_silent.',
    }), 0.97, 'staged'],
    [EX('00000000003'), EXX_INGEST, 'guardrail', JSON.stringify({
      guardrail_id: 'GR-003', name: 'Read-Only API Enforcement',
      enforcement_level: 'hard',
      description: 'Agent may only invoke read-only API operations. No write, update, delete, or patch calls are permitted via any registered tool.',
    }), 0.99, 'staged'],
    [EX('00000000004'), EXX_INGEST, 'guardrail', JSON.stringify({
      guardrail_id: 'GR-004', name: 'Sensitivity Scan Before Post',
      enforcement_level: 'hard',
      description: 'All synthesized Work Note text must pass the sensitivity scanner before the ticket_work_note_post tool is called. A second scanner failure halts the run and raises an internal flag.',
    }), 0.96, 'staged'],
    [EX('00000000005'), EXX_INGEST, 'guardrail', JSON.stringify({
      guardrail_id: 'GR-005', name: 'Tool Call Retry Limit',
      enforcement_level: 'soft',
      description: 'Maximum 2 retry attempts per tool call. On third consecutive failure, the agent falls back to posting a partial Work Note and logs the error for human review.',
    }), 0.92, 'staged'],
    [EX('00000000006'), EXX_INGEST, 'guardrail', JSON.stringify({
      guardrail_id: 'GR-006', name: 'LLM Token Budget',
      enforcement_level: 'soft',
      description: 'Context window usage must remain below 80% of the model limit. Non-critical fields (extended SAP narrative) are truncated first if the limit is approached.',
    }), 0.88, 'staged'],
  ]);

  // ── Data Sources ──────────────────────────────────────────────────────────
  ins(`INSERT OR IGNORE INTO asdlc_ingest_extraction
    (extraction_id, ingest_id, entity_type, entity_data, confidence, status)
    VALUES (?,?,?,?,?,?)`, [
    [EX('00000000101'), EXX_INGEST, 'data_source', JSON.stringify({
      source_system: 'Invoice Search API',
      source_type: 'REST API',
      access_rule: { mode: 'read-only' },
      data_owner: 'AP Systems Team',
      table_or_document: 'IntegrationHub REST spoke; returns payment_status, due_date, last_action_date, invoice_amount, and matched_identifier for each query.',
    }), 0.96, 'staged'],
    [EX('00000000102'), EXX_INGEST, 'data_source', JSON.stringify({
      source_system: 'SAP Invoice Detail API',
      source_type: 'REST API',
      access_rule: { mode: 'read-only' },
      data_owner: 'ERP Integration Team',
      table_or_document: 'MuleSoft-brokered SAP integration. Called only when Invoice Search returns status = blocked or on-hold. Returns hold_reason, approver, and expected_release_date.',
    }), 0.94, 'staged'],
    [EX('00000000103'), EXX_INGEST, 'data_source', JSON.stringify({
      source_system: 'ServiceNow Ticket Record',
      source_type: 'Platform Native',
      access_rule: { mode: 'read/write' },
      data_owner: 'Service Management Team',
      table_or_document: 'Source of all trigger data (short_description, description, category, caller). Also the write target for Work Note posting via the ticket_work_note_post tool.',
    }), 0.99, 'staged'],
    [EX('00000000104'), EXX_INGEST, 'data_source', JSON.stringify({
      source_system: 'ServiceNow ML Classifier',
      source_type: 'ML Inference',
      access_rule: { mode: 'read-only' },
      data_owner: 'AI Centre of Excellence',
      table_or_document: 'ServiceNow NLU solution that classifies ticket category and returns confidence score. Invoked at workflow start; result drives the confidence threshold gate (GR-002).',
    }), 0.91, 'staged'],
  ]);

  // ── Test Scenarios ────────────────────────────────────────────────────────
  ins(`INSERT OR IGNORE INTO asdlc_ingest_extraction
    (extraction_id, ingest_id, entity_type, entity_data, confidence, status)
    VALUES (?,?,?,?,?,?)`, [
    [EX('00000000201'), EXX_INGEST, 'test_scenario', JSON.stringify({
      scenario_id_ref: 'TS-001', scenario_type: 'behavioral',
      description: 'Standard invoice inquiry: ticket created with valid PO number → agent classifies (confidence ≥ 0.80), looks up invoice, and posts a complete, templated Work Note within 30 seconds.',
    }), 0.95, 'staged'],
    [EX('00000000202'), EXX_INGEST, 'test_scenario', JSON.stringify({
      scenario_id_ref: 'TS-002', scenario_type: 'edge_case',
      description: 'Multi-identifier ticket: short_description contains a PO number AND an invoice number. Agent must extract and search both, deduplicate results, and report all findings in a single Work Note.',
    }), 0.92, 'staged'],
    [EX('00000000203'), EXX_INGEST, 'test_scenario', JSON.stringify({
      scenario_id_ref: 'TS-003', scenario_type: 'failure',
      description: 'Invoice Search API returns 503. Agent posts a partial Work Note indicating data was unavailable, logs the tool failure, and does not retry within the same run.',
    }), 0.93, 'staged'],
    [EX('00000000204'), EXX_INGEST, 'test_scenario', JSON.stringify({
      scenario_id_ref: 'TS-004', scenario_type: 'security',
      description: 'Work Note content verified to contain no supplier banking details, full PAN, or SSN beyond approved fields. Sensitivity scanner intercept confirmed for injected PII in test data.',
    }), 0.97, 'staged'],
    [EX('00000000205'), EXX_INGEST, 'test_scenario', JSON.stringify({
      scenario_id_ref: 'TS-005', scenario_type: 'behavioral',
      description: 'Low-confidence ticket (classifier returns 0.72): agent exits silently, no Work Note posted, run log records decision = exited_silent with confidence score.',
    }), 0.96, 'staged'],
    [EX('00000000206'), EXX_INGEST, 'test_scenario', JSON.stringify({
      scenario_id_ref: 'TS-006', scenario_type: 'edge_case',
      description: 'Supplier-name-only ticket (no PO or invoice number): agent searches by supplier name, Invoice Search returns 3 matches. Multi-match handling selected and all results summarised.',
    }), 0.90, 'staged'],
    [EX('00000000207'), EXX_INGEST, 'test_scenario', JSON.stringify({
      scenario_id_ref: 'TS-007', scenario_type: 'behavioral',
      description: 'Blocked invoice: Invoice Search returns status = blocked. SAP Detail API is called and hold_reason + approver appear in the Work Note. For a paid invoice, SAP is NOT called.',
    }), 0.94, 'staged'],
    [EX('00000000208'), EXX_INGEST, 'test_scenario', JSON.stringify({
      scenario_id_ref: 'TS-008', scenario_type: 'performance',
      description: 'End-to-end latency for a standard single-invoice ticket (Invoice Search only, no SAP call) must be ≤ 30 seconds at p95 across 50 concurrent runs under simulated peak load.',
    }), 0.89, 'staged'],
  ]);

  // ── User Stories ──────────────────────────────────────────────────────────
  ins(`INSERT OR IGNORE INTO asdlc_ingest_extraction
    (extraction_id, ingest_id, entity_type, entity_data, confidence, status)
    VALUES (?,?,?,?,?,?)`, [
    [EX('00000000301'), EXX_INGEST, 'user_story', JSON.stringify({
      story_id_ref: 'US1', story_type: 'functional', sprint: 1,
      title: 'Ticket Intake & Classification',
      description: 'As the AP team, I want the agent to automatically detect invoice-related Service Requests and classify them so that only relevant tickets trigger the lookup workflow.',
    }), 0.97, 'staged'],
    [EX('00000000302'), EXX_INGEST, 'user_story', JSON.stringify({
      story_id_ref: 'US2', story_type: 'functional', sprint: 1,
      title: 'Confidence Threshold Check',
      description: 'As the AP team, I want the agent to exit silently when classifier confidence is below 0.80 so that ambiguous tickets are not acted on without human review.',
    }), 0.96, 'staged'],
    [EX('00000000303'), EXX_INGEST, 'user_story', JSON.stringify({
      story_id_ref: 'US3', story_type: 'functional', sprint: 1,
      title: 'Identifier Extraction',
      description: 'As the AP team, I want the agent to extract all relevant identifiers (PO number, invoice number, supplier name) from the ticket text so that the correct invoice records can be located.',
    }), 0.95, 'staged'],
    [EX('00000000304'), EXX_INGEST, 'user_story', JSON.stringify({
      story_id_ref: 'US4', story_type: 'functional', sprint: 1,
      title: 'Invoice Status Lookup',
      description: 'As the AP team, I want the agent to query the Invoice Search API for each extracted identifier and retrieve current payment status, due date, and last action so that the Work Note contains accurate information.',
    }), 0.97, 'staged'],
    [EX('00000000305'), EXX_INGEST, 'user_story', JSON.stringify({
      story_id_ref: 'US5', story_type: 'functional', sprint: 2,
      title: 'SAP Detail Retrieval',
      description: 'As the AP team, I want SAP details fetched only for blocked or on-hold invoices so that unnecessary SAP API calls are avoided and hold reasons are surfaced when relevant.',
    }), 0.94, 'staged'],
    [EX('00000000306'), EXX_INGEST, 'user_story', JSON.stringify({
      story_id_ref: 'US6', story_type: 'functional', sprint: 2,
      title: 'Work Note Generation',
      description: 'As the fulfiller, I want a structured Work Note posted to the ticket that follows the approved template (summary → identifiers → findings → not found → timestamps) so that I can act on it immediately.',
    }), 0.96, 'staged'],
    [EX('00000000307'), EXX_INGEST, 'user_story', JSON.stringify({
      story_id_ref: 'US7', story_type: 'compliance', sprint: 2,
      title: 'Sensitivity Review & Redaction',
      description: 'As the data privacy officer, I want all Work Note content scanned for PII before posting so that banking details, PANs, and SSNs are never exposed in ServiceNow.',
    }), 0.98, 'staged'],
    [EX('00000000308'), EXX_INGEST, 'user_story', JSON.stringify({
      story_id_ref: 'US8', story_type: 'functional', sprint: 2,
      title: 'Work Note Posting',
      description: 'As the fulfiller, I want the Work Note posted directly to the source ticket via the approved tool so that the record of the agent action is immediately visible in ServiceNow.',
    }), 0.95, 'staged'],
    [EX('00000000309'), EXX_INGEST, 'user_story', JSON.stringify({
      story_id_ref: 'US9', story_type: 'edge_case', sprint: 2,
      title: 'Multi-Match Handling',
      description: 'As the AP team, I want the agent to gracefully handle multi-match results from Invoice Search by summarising all candidates in the Work Note so that the fulfiller can identify the correct invoice.',
    }), 0.91, 'staged'],
    [EX('00000000310'), EXX_INGEST, 'user_story', JSON.stringify({
      story_id_ref: 'US10', story_type: 'resilience', sprint: 3,
      title: 'Error Fallback & Logging',
      description: 'As the operations team, I want the agent to post a partial Work Note and log a structured error record when a tool call fails so that no ticket is silently dropped and the failure is visible for review.',
    }), 0.93, 'staged'],
    [EX('00000000311'), EXX_INGEST, 'user_story', JSON.stringify({
      story_id_ref: 'US11', story_type: 'observability', sprint: 3,
      title: 'Audit Logging',
      description: 'As the audit team, I want every agent run to produce a structured audit record (inputs, outputs, tool calls, decision points, timestamps) so that the full run can be reconstructed for compliance review.',
    }), 0.94, 'staged'],
  ]);

  // ── REQUIREMENTS — reverse-engineered from ExxonMobil user stories & guardrails ──
  // Functional Requirements (1:1 with the 11 ingested user stories above).
  // Non-Functional Requirements derived from guardrails + use-case acceptance criteria
  // (UC ACs at lines 1163-1184) + success metrics. All traced to EXX_UC and EXX_INGEST.
  const FR_ACTORS = JSON.stringify(['Invoice Agent', 'Requester', 'IT Fulfiller']);
  const REQ_SOURCE_FR  = 'ExxonMobil intake doc — user stories US1-US11';
  const REQ_SOURCE_NFR = 'ExxonMobil intake doc — guardrails GR-001..GR-006 + use-case ACs';

  ins(`INSERT OR IGNORE INTO asdlc_functional_req
    (fr_id, project_id, use_case_id, ingest_id, slug, title, description,
     actors, preconditions, postconditions, priority, acceptance_criteria,
     dependencies, source, status, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    [EX('00000000401'), EXX_PROJ, EXX_UC, EXX_INGEST, 'FR-001',
      'Detect & classify invoice-related Service Requests',
      'Agent must detect invoice-related ServiceNow Service Requests and classify them so that only relevant tickets trigger the lookup workflow.',
      FR_ACTORS,
      'A new ServiceNow Service Request has been submitted in scope of the AP queue.',
      'Ticket is tagged with classifier verdict (in_scope | out_of_scope) and confidence score; downstream steps only fire when in_scope.',
      'must_have',
      JSON.stringify(['In-scope invoice tickets are classified with confidence ≥ 0.80', 'Out-of-scope tickets exit silently with no Work Note']),
      JSON.stringify([]),
      REQ_SOURCE_FR, 'approved', 'seed'],
    [EX('00000000402'), EXX_PROJ, EXX_UC, EXX_INGEST, 'FR-002',
      'Exit silently below 0.80 classifier confidence',
      'Agent must exit silently when classifier confidence is below 0.80 so that ambiguous tickets are not acted on without human review.',
      FR_ACTORS,
      'Classifier has produced a confidence score for the ticket.',
      'No Work Note posted; run logged with decision = exited_silent.',
      'must_have',
      JSON.stringify(['Confidence < 0.80 results in no agent action visible in ServiceNow', 'Decision and confidence value captured in audit log']),
      JSON.stringify(['NFR-002']),
      REQ_SOURCE_FR, 'approved', 'seed'],
    [EX('00000000403'), EXX_PROJ, EXX_UC, EXX_INGEST, 'FR-003',
      'Extract PO / invoice / supplier identifiers from ticket text',
      'Agent must extract all relevant identifiers (PO number, invoice number, supplier name) from ticket text so that the correct invoice records can be located.',
      FR_ACTORS,
      'Ticket has been classified in_scope.',
      'Structured identifier list (typed: po | invoice | supplier) is attached to the run context.',
      'must_have',
      JSON.stringify(['All three identifier kinds are typed when present', 'Tickets with no extractable identifiers route to multi-match / fallback handling']),
      JSON.stringify([]),
      REQ_SOURCE_FR, 'approved', 'seed'],
    [EX('00000000404'), EXX_PROJ, EXX_UC, EXX_INGEST, 'FR-004',
      'Query Invoice Search for payment status per identifier',
      'Agent must query the Invoice Search API for each extracted identifier and retrieve payment status, due date, and last action.',
      FR_ACTORS,
      'Identifiers have been extracted by FR-003.',
      'Per-identifier payment status, due date and last action are captured in the run context.',
      'must_have',
      JSON.stringify(['Each extracted identifier produces a status row or an explicit not-found row', 'Tool is invoked read-only per NFR-004']),
      JSON.stringify(['FR-003']),
      REQ_SOURCE_FR, 'approved', 'seed'],
    [EX('00000000405'), EXX_PROJ, EXX_UC, EXX_INGEST, 'FR-005',
      'Conditional SAP detail retrieval for blocked invoices only',
      'Agent must fetch SAP details only for blocked or on-hold invoices, to avoid unnecessary API calls and surface hold reasons when relevant.',
      FR_ACTORS,
      'Invoice Search returned at least one invoice in a blocked or on-hold state.',
      'SAP block_reason and related fields are appended to the matching invoice record.',
      'must_have',
      JSON.stringify(['SAP detail tool is NOT called for invoices in non-blocked states', 'block_reason is included in the Work Note when present']),
      JSON.stringify(['FR-004']),
      REQ_SOURCE_FR, 'approved', 'seed'],
    [EX('00000000406'), EXX_PROJ, EXX_UC, EXX_INGEST, 'FR-006',
      'Generate Work Note from approved template',
      'Agent must produce a structured Work Note following the approved template (summary → identifiers used / not found → findings → timestamps).',
      FR_ACTORS,
      'All invoice lookups (and SAP detail if applicable) have completed.',
      'A draft Work Note string is available, ready for sensitivity scanning.',
      'must_have',
      JSON.stringify(['Work Note lists which identifiers were used and which were not found', 'Template ordering is enforced']),
      JSON.stringify(['FR-004','NFR-001']),
      REQ_SOURCE_FR, 'approved', 'seed'],
    [EX('00000000407'), EXX_PROJ, EXX_UC, EXX_INGEST, 'FR-007',
      'Scan & redact PII before posting',
      'All Work Note content must be scanned for PII before posting; banking details, PANs, and SSNs must never be exposed in ServiceNow.',
      FR_ACTORS,
      'A draft Work Note has been generated by FR-006.',
      'Sensitive fields are replaced with [redacted] or the run is halted on repeated sensitivity failure.',
      'must_have',
      JSON.stringify(['Zero leaked banking / PAN / SSN values in posted Work Notes', 'Two consecutive sensitivity failures escalate to HITL']),
      JSON.stringify(['NFR-003']),
      REQ_SOURCE_FR, 'approved', 'seed'],
    [EX('00000000408'), EXX_PROJ, EXX_UC, EXX_INGEST, 'FR-008',
      'Post Work Note to source ticket via approved tool',
      'Agent must post the Work Note directly to the source ticket via the approved ticket_work_note_post tool so that the record of the agent action is immediately visible in ServiceNow.',
      FR_ACTORS,
      'Sensitivity check has passed for the Work Note.',
      'Work Note is visible on the source ticket; agent run is marked complete.',
      'must_have',
      JSON.stringify(['Work Note is posted only to Work Notes field — never Description or customer-visible fields', 'Posted Work Note matches the approved Work Note content byte-for-byte']),
      JSON.stringify(['FR-007','NFR-004']),
      REQ_SOURCE_FR, 'approved', 'seed'],
    [EX('00000000409'), EXX_PROJ, EXX_UC, EXX_INGEST, 'FR-009',
      'Handle multi-match Invoice Search results',
      'Agent must gracefully handle multi-match results from Invoice Search by summarising all candidates in the Work Note so that the fulfiller can identify the correct invoice.',
      FR_ACTORS,
      'Invoice Search returned more than one candidate for an identifier.',
      'Work Note contains a ranked candidate list with enough disambiguation to choose.',
      'should_have',
      JSON.stringify(['When >1 candidate is returned, all candidates are listed', 'Top match is flagged but never auto-selected without fulfiller review']),
      JSON.stringify(['FR-004']),
      REQ_SOURCE_FR, 'approved', 'seed'],
    [EX('00000000410'), EXX_PROJ, EXX_UC, EXX_INGEST, 'FR-010',
      'Partial Work Note + structured error on tool failure',
      'Agent must post a partial Work Note and log a structured error record when a tool call fails so that no ticket is silently dropped and the failure is visible for review.',
      FR_ACTORS,
      'A tool call has failed after the configured retry budget (per NFR-006).',
      'Partial Work Note is posted; structured error event is emitted for ops review.',
      'should_have',
      JSON.stringify(['No ticket is silently dropped on tool failure', 'Error record includes tool name, attempt count, and last error message']),
      JSON.stringify(['NFR-006']),
      REQ_SOURCE_FR, 'approved', 'seed'],
    [EX('00000000411'), EXX_PROJ, EXX_UC, EXX_INGEST, 'FR-011',
      'Emit structured audit record per agent run',
      'Every agent run must produce a structured audit record (inputs, outputs, tool calls, decision points, timestamps) so that the full run can be reconstructed for compliance review.',
      FR_ACTORS,
      'An agent run has started.',
      'A complete audit record exists in the audit store for the run, regardless of outcome (posted / silent / error).',
      'must_have',
      JSON.stringify(['100% of agent runs produce an audit record', 'Audit record includes input_hash, output_hash, classifier_confidence, tools_called, timestamps']),
      JSON.stringify(['NFR-005']),
      REQ_SOURCE_FR, 'approved', 'seed'],
  ]);

  ins(`INSERT OR IGNORE INTO asdlc_nonfunctional_req
    (nfr_id, project_id, use_case_id, ingest_id, slug, title, category,
     description, measurable_target, verification_method, priority,
     dependencies, source, status, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    [EX('00000000501'), EXX_PROJ, EXX_UC, EXX_INGEST, 'NFR-001',
      'Work Note latency', 'Performance',
      'The agent must produce a posted Work Note within an upper-bound latency, or exit silently — fulfillers should never be left waiting on an agent run.',
      'Work Note posted within 90 seconds p95 from ticket pickup, or run exits silently.',
      'Synthetic load test against TS-001 happy-path scenario; p95 latency tracked in observability dashboard.',
      'must_have', JSON.stringify([]),
      REQ_SOURCE_NFR, 'approved', 'seed'],
    [EX('00000000502'), EXX_PROJ, EXX_UC, EXX_INGEST, 'NFR-002',
      'Classifier confidence floor', 'Accuracy/Quality',
      'The agent must only act on tickets where classifier confidence meets the agreed floor; below that, it must exit silently rather than risk a wrong action.',
      'Classifier confidence ≥ 0.80 to act; below threshold → silent exit, no Work Note posted.',
      'Test scenarios TS-013 / TS-014 verify above/below threshold behaviour; production confidence histogram reviewed weekly.',
      'must_have', JSON.stringify([]),
      REQ_SOURCE_NFR, 'approved', 'seed'],
    [EX('00000000503'), EXX_PROJ, EXX_UC, EXX_INGEST, 'NFR-003',
      'PII redaction completeness', 'Security/Privacy',
      'Sensitive identifiers (banking detail, PAN, SSN) must never appear in a posted Work Note.',
      'Zero PII leaks in posted Work Notes; sensitivity scanner pre-post pass rate = 100%.',
      'Sensitivity scanner unit tests + TS-006 redaction scenario + production audit log scan for leaked patterns.',
      'must_have', JSON.stringify([]),
      REQ_SOURCE_NFR, 'approved', 'seed'],
    [EX('00000000504'), EXX_PROJ, EXX_UC, EXX_INGEST, 'NFR-004',
      'Source-system read-only access', 'Security',
      'Agent must only invoke read-only API operations on source systems (ServiceNow read APIs, SAP, Supplier Master). Writes are limited to the originating ticket Work Note.',
      'Zero write / update / delete / patch calls against source-system APIs; write surface limited to Work Notes field of the originating ticket.',
      'Tool contract tests TS-023 / TS-026 + static review of registered tool surfaces.',
      'must_have', JSON.stringify([]),
      REQ_SOURCE_NFR, 'approved', 'seed'],
    [EX('00000000505'), EXX_PROJ, EXX_UC, EXX_INGEST, 'NFR-005',
      'Auditability of agent runs', 'Compliance/Observability',
      'Every agent run must emit a structured, immutable audit record sufficient to reconstruct the decision after the fact.',
      '100% of runs emit an audit record containing input_hash, output_hash, classifier_confidence, tools_called[], and per-step timestamps.',
      'Daily audit log integrity check + sample reconstruction of 20 random runs per month by compliance.',
      'must_have', JSON.stringify([]),
      REQ_SOURCE_NFR, 'approved', 'seed'],
    [EX('00000000506'), EXX_PROJ, EXX_UC, EXX_INGEST, 'NFR-006',
      'Tool-call resilience', 'Reliability',
      'Tool call failures must be bounded by a retry budget and fall back to a partial Work Note rather than dropping the ticket.',
      '≤ 2 retries per tool call; 3rd consecutive failure → partial Work Note posted + structured error logged; no silent drops.',
      'Failure-injection tests TS-005 / TS-011 + retry-budget unit tests on each registered tool.',
      'must_have', JSON.stringify([]),
      REQ_SOURCE_NFR, 'approved', 'seed'],
    [EX('00000000507'), EXX_PROJ, EXX_UC, EXX_INGEST, 'NFR-007',
      'LLM context budget', 'Performance',
      'Agent context window usage must stay below model limits; non-critical fields are truncated first when nearing budget.',
      'Token usage < 80% of model context limit on 99% of runs; extended SAP narrative truncated first when needed.',
      'Per-run token telemetry tracked in observability; weekly outlier review.',
      'should_have', JSON.stringify([]),
      REQ_SOURCE_NFR, 'approved', 'seed'],
    [EX('00000000508'), EXX_PROJ, EXX_UC, EXX_INGEST, 'NFR-008',
      'Time-to-respond improvement', 'Business Outcome',
      'Deployment must produce a measurable improvement in fulfiller time-to-respond on invoice-status tickets and acceptable fulfiller satisfaction.',
      '≥ 25% reduction in time-to-respond vs pre-agent baseline; fulfiller CSAT ≥ 4 / 5.',
      'A/B comparison against pre-deployment baseline window; quarterly fulfiller survey.',
      'must_have', JSON.stringify([]),
      REQ_SOURCE_NFR, 'approved', 'seed'],
  ]);

  // Change-log: one Added entry per FR + NFR, so the Design Report shows real history.
  const REQ_LOG_NOTE = 'Reverse-engineered from ExxonMobil ingest user stories + guardrails (demo seed)';
  const reqLogRows = [];
  for (let i = 1; i <= 11; i++) {
    const fr = EX('00000000' + (400 + i));
    const log = EX('00000000' + (600 + i));
    reqLogRows.push([log, 'functional', fr, EXX_PROJ, 'Added', REQ_LOG_NOTE, 'seed']);
  }
  for (let i = 1; i <= 8; i++) {
    const nfr = EX('00000000' + (500 + i));
    const log = EX('00000000' + (620 + i));
    reqLogRows.push([log, 'nonfunctional', nfr, EXX_PROJ, 'Added', REQ_LOG_NOTE, 'seed']);
  }
  ins(`INSERT OR IGNORE INTO asdlc_requirement_change_log
    (log_id, req_type, req_id, project_id, action, note, changed_by)
    VALUES (?,?,?,?,?,?,?)`, reqLogRows);

  // ── PHASE 4: Rate card + cost assumption ─────────────────────────────────
  // 132 real Now Assist skills extracted from Now_Assist_Workflow_Cost_Calculator_v2.xlsx
  // Agentic workflow categories: small=25, medium=50, large=150 assists
  const RATE_CARD_SKILLS = [
    {"skill_name":"Acceptance criteria generation","description":"One request to generate acceptance criteria for a story based on context and template.","assists_per_unit":10,"category":"SPM"},
    {"skill_name":"Activity response generation","description":"One activity (work notes or comments) response generation request (including those invoked via UI or workspace configuration).","assists_per_unit":5,"category":"General"},
    {"skill_name":"AI filter generation","description":"One request to generate a query string that can be used to filter data in a table.","assists_per_unit":1,"category":"General"},
    {"skill_name":"AI gateway call","description":"One call and response between an MCP Client registered with AI Gateway to a 3P MCP Server, using the AI Gateway.","assists_per_unit":1,"category":"Integration"},
    {"skill_name":"Alert investigation","description":"One invocation from an Alert (in any interface spanning all incidents related to the alert).","assists_per_unit":1,"category":"ITSM"},
    {"skill_name":"Analysis exploration","description":"One response to user's question in Explorer based on any of the following: An open Question, pre- defined questions/follow-ups, re-generation of an answer, addition of visualization/list to exploration.","assists_per_unit":10,"category":"General"},
    {"skill_name":"App generation","description":"One application generated (including metadata","assists_per_unit":2500,"category":"SPM"},
    {"skill_name":"App summary generation","description":"One app summary generation request triggered by user.","assists_per_unit":5,"category":"SPM"},
    {"skill_name":"Approval recommendation","description":"One request to generate an approval recommendation.","assists_per_unit":1,"category":"SPM"},
    {"skill_name":"Architectural decision record summarization","description":"One summarization request (including those invoked via UI or workspace configuration) interface or channel.","assists_per_unit":5,"category":"General"},
    {"skill_name":"Article optimization","description":"One call to run article optimization prompts and generate findings related to article quality on all knowledge articles across the instance.","assists_per_unit":1000,"category":"Knowledge"},
    {"skill_name":"Attachment summarization","description":"Provides contextually relevant data from transcribed JPEG and PNG attachments on all incidents.","assists_per_unit":5,"category":"General"},
    {"skill_name":"Automated prompt optimization","description":"One end-to-end automated prompt optimization execution.","assists_per_unit":1500,"category":"General"},
    {"skill_name":"Build Agent call","description":"One single user-initiate tool call made to the Building Agent.","assists_per_unit":25,"category":"Integration"},
    {"skill_name":"Business Application Insights","description":"One request to understand context and insights about a business application.","assists_per_unit":1,"category":"SPM"},
    {"skill_name":"Case summarization for approvals","description":"One request to summarize HR case requiring an approval to help approvers quickly understand the full context.","assists_per_unit":1,"category":"SPM"},
    {"skill_name":"Catalog item generation","description":"One Service Catalog item generation request triggered by user.","assists_per_unit":250,"category":"SPM"},
    {"skill_name":"Change risk explanation","description":"One request Change risk explanation request (including those invoked via UI or workspace configuration).","assists_per_unit":1,"category":"ITSM"},
    {"skill_name":"Chat reply recommendations","description":"One chat response recommendation request (including those invoked via UI or workspace configuration).","assists_per_unit":5,"category":"UX"},
    {"skill_name":"Chat summarization / Call summarization","description":"One chat or call summarization request (including those invoked via workflow button or workspace configuration).","assists_per_unit":1,"category":"UX"},
    {"skill_name":"CI summarization","description":"One summarization request for a CI record.","assists_per_unit":1,"category":"General"},
    {"skill_name":"Client script summarization","description":"One client script explanation requested by the user.","assists_per_unit":5,"category":"Development"},
    {"skill_name":"Code autocomplete","description":"One code autocomplete suggestion accepted by the user.","assists_per_unit":5,"category":"Development"},
    {"skill_name":"Code edits","description":"One code edit request accepted by the user.","assists_per_unit":5,"category":"Development"},
    {"skill_name":"Code explain / summarize","description":"One code explanation or summary requested by the user.","assists_per_unit":5,"category":"Development"},
    {"skill_name":"Code generation","description":"One code generation request triggered by user (including requests generated from comment, or function completion).","assists_per_unit":5,"category":"Development"},
    {"skill_name":"Common control objective creation","description":"One request to generate a standardized common control objective based on similar control objectives detected by system.","assists_per_unit":25,"category":"General"},
    {"skill_name":"Contract analysis","description":"One contract analysis request.","assists_per_unit":50,"category":"Procurement"},
    {"skill_name":"Contract metadata extraction","description":"One contract metadata extraction request.","assists_per_unit":20,"category":"Document"},
    {"skill_name":"Control objective impact analyzer","description":"One request to identify the impacted control objectives (associated to citation) based on a change in Citation details.","assists_per_unit":5,"category":"General"},
    {"skill_name":"Correlation insights","description":"One request (including those involved via workflow button or workspace configuration).","assists_per_unit":5,"category":"General"},
    {"skill_name":"Customer summarization for approvals","description":"One request to summarize HR case requiring approval to help approvers quickly understand the full context.","assists_per_unit":1,"category":"SPM"},
    {"skill_name":"Data binding generation","description":"User chooses to Accept formula presented to them after requesting, via utterance, to have formulas and data bindings automatically configured in UI Builder.","assists_per_unit":5,"category":"Development"},
    {"skill_name":"Data visualization generation","description":"One generation of analytics data visualization.","assists_per_unit":10,"category":"General"},
    {"skill_name":"Diagram change analysis","description":"One request to generate a comparison between two EA diagrams","assists_per_unit":10,"category":"ITSM"},
    {"skill_name":"Document extraction (fields)","description":"One document field extraction request (up to 25 pre-defined fields per request).","assists_per_unit":10,"category":"Document"},
    {"skill_name":"Document extraction (tables)","description":"One document table extraction request (up to 10 pre-defined table columns per request).","assists_per_unit":10,"category":"Document"},
    {"skill_name":"Document Q&A","description":"One document Q&A request (up to 15 pre-defined questions per request).","assists_per_unit":10,"category":"Document"},
    {"skill_name":"Document summarization","description":"One doc summarization request (including those invoked via UI or workspace configuration)","assists_per_unit":5,"category":"Document"},
    {"skill_name":"Email mass communication","description":"One email generation for mass communication (including those invoked via UI or workspace configuration).","assists_per_unit":5,"category":"General"},
    {"skill_name":"Email response","description":"One email response recommendation request (including those invoked via UI or workspace configuration).","assists_per_unit":5,"category":"General"},
    {"skill_name":"ERP data query skill","description":"One generation of a structured mapping from a custom prompt to the relevant ERP/SAP technical objects required to fulfill the user's data request.","assists_per_unit":500,"category":"General"},
    {"skill_name":"ERP generic prompt","description":"One conversation in the Now Assist panel around querying the ERP standard database tables for data and transactional records using natural language.","assists_per_unit":5,"category":"General"},
    {"skill_name":"ESG document extraction (fields)","description":"One Metric document filed extraction request (up to 25 pre-defined fields per request)","assists_per_unit":25,"category":"Document"},
    {"skill_name":"ESG document extraction (tables)","description":"Invoice details extraction tagged to one Metric document extraction request (up to 25 pre-defined fields per request).","assists_per_unit":25,"category":"Document"},
    {"skill_name":"Event generation","description":"One event configuration request accepted by the user.","assists_per_unit":5,"category":"General"},
    {"skill_name":"Experience (UI) generation","description":"One experience generated; assists counted after the user has saved the outcome.","assists_per_unit":1000,"category":"General"},
    {"skill_name":"Exploration summarization","description":"One summarization request to create an exploration summary in Explorer.","assists_per_unit":10,"category":"General"},
    {"skill_name":"Feedback summarization","description":"One summarization request invoked via workspace.","assists_per_unit":10,"category":"General"},
    {"skill_name":"Field encryption decryption key access","description":"One request to understand user(s) that have access to a specific encryption key.","assists_per_unit":5,"category":"General"},
    {"skill_name":"Filter sample generation","description":"One generation of sample phrases for a semantic filter.","assists_per_unit":1,"category":"General"},
    {"skill_name":"Flow generation (using images)","description":"One flow generation call (including previews) triggered by user to generate a flow from text using Now LLM.","assists_per_unit":500,"category":"Flow"},
    {"skill_name":"Flow recommendation","description":"One accepted flow recommendation.","assists_per_unit":10,"category":"Flow"},
    {"skill_name":"Flow summarization","description":"One flow summary requested by the user.","assists_per_unit":5,"category":"Flow"},
    {"skill_name":"Growth plan generation","description":"One flow generation call triggered by a user.","assists_per_unit":5,"category":"General"},
    {"skill_name":"Identify duplicate articles","description":"Generate a list of the duplicate articles across the instance.","assists_per_unit":500,"category":"Knowledge"},
    {"skill_name":"Incident assist","description":"One request to look up incident related information including follow up requests.","assists_per_unit":5,"category":"ITSM"},
    {"skill_name":"Invoice data extraction","description":"One invoice data extraction request, extracting relevant fields from the invoice document.","assists_per_unit":20,"category":"Document"},
    {"skill_name":"Journey generation","description":"One flow call triggered by a user to generate a journey from text.","assists_per_unit":10,"category":"General"},
    {"skill_name":"Journey summarization for managers","description":"One summarization request for a single employee journey.","assists_per_unit":1,"category":"General"},
    {"skill_name":"KM open prompt discovery","description":"One article create or update request using custom instructions.","assists_per_unit":10,"category":"General"},
    {"skill_name":"Knowledge article generation","description":"One knowledge article generation request, including knowledge articles generated in any interface or channel.","assists_per_unit":10,"category":"Knowledge"},
    {"skill_name":"Knowledge gaps detection","description":"One request to generate clusters of the cases without relevant knowledge content across the instance.","assists_per_unit":750,"category":"Knowledge"},
    {"skill_name":"Knowledge graph query","description":"One call to Knowledge Graph as part of a custom skill or script.","assists_per_unit":1,"category":"Knowledge"},
    {"skill_name":"LEAP action reducer","description":"One resolution steps generation request on a group of records (up to 10 records per request).","assists_per_unit":25,"category":"General"},
    {"skill_name":"Manage duplicate CIs","description":"One multi-turn conversation to remediate tasks, create new templates, and/or conduct root cause analysis on tasks.","assists_per_unit":5,"category":"General"},
    {"skill_name":"Matter summarization","description":"One summarization request (including those invoked via workflow button or workspace configuration).","assists_per_unit":1,"category":"General"},
    {"skill_name":"MCP server call","description":"One call using NOW MCP Server","assists_per_unit":1,"category":"Integration"},
    {"skill_name":"Mobile card generation","description":"Create a mobile card using context provided by the user as well as context from the mobile experience the card is being added to.","assists_per_unit":10,"category":"General"},
    {"skill_name":"Multi-context synthesized answer generation","description":"One answer generated.","assists_per_unit":1,"category":"General"},
    {"skill_name":"Multi-record summarization","description":"One summarization request (including those invoked via workflow button, workspace).","assists_per_unit":1,"category":"General"},
    {"skill_name":"Multi-turn catalog ordering","description":"One end-to-end catalog order.","assists_per_unit":10,"category":"SPM"},
    {"skill_name":"Now Assist panel conversation","description":"One conversation in Now Assist panel. Conversation ends on the earlier of 1 hour of inactivity or change in intent.","assists_per_unit":5,"category":"UX"},
    {"skill_name":"Now Assist Q&A genius results (Search Q&A)","description":"One answer card produced in AI Search results.","assists_per_unit":1,"category":"General"},
    {"skill_name":"Now Assist Virtual Agent topics","description":"One end-to-end Virtual Agent topic execution.","assists_per_unit":10,"category":"General"},
    {"skill_name":"Order summarization for order capture / fulfillment","description":"One summarization request.","assists_per_unit":1,"category":"General"},
    {"skill_name":"Outcome summarization","description":"One outcome summarization requested by the user.","assists_per_unit":1,"category":"General"},
    {"skill_name":"Persona assistant","description":"One request to generate a comprehensive employee summarization and facilitate follow up.","assists_per_unit":10,"category":"General"},
    {"skill_name":"Platform navigation","description":"One navigation request via any interface or channel.","assists_per_unit":1,"category":"General"},
    {"skill_name":"Playbook generation","description":"One playbook generation call triggered by user to generate a playbook from text.","assists_per_unit":2500,"category":"General"},
    {"skill_name":"Playbook generation using images","description":"One playbook generation call to generate a playbook from text or an image.","assists_per_unit":2500,"category":"General"},
    {"skill_name":"Playbook recommendations","description":"One accepted recommendation.","assists_per_unit":10,"category":"General"},
    {"skill_name":"Post-incident analysis","description":"One post-incident analysis (including root cause analysis, impact assessment, and lessons learned) generated during the flow of closing the security incident.","assists_per_unit":1,"category":"ITSM"},
    {"skill_name":"Process inefficiency highlights analysis","description":"One highlight request for identifying the most impactful outliers related to process inefficiency.","assists_per_unit":50,"category":"General"},
    {"skill_name":"Procurement case summarization","description":"One procurement case summarization request (including those invoked via workflow button, workspace configuration, interface, or channel).","assists_per_unit":1,"category":"General"},
    {"skill_name":"Project insights generation","description":"One project summarization request in project workspace.","assists_per_unit":10,"category":"General"},
    {"skill_name":"Purchase order line mapping","description":"One invoice mapping request, mapping invoice line items to purchase order lines.","assists_per_unit":10,"category":"SPM"},
    {"skill_name":"Recommendation of similar control objectives","description":"One request to deduplicate list of similar control objectives.","assists_per_unit":50,"category":"General"},
    {"skill_name":"Recommended actions – SAM / SecOps","description":"One request to generate recommended resolution steps.","assists_per_unit":5,"category":"General"},
    {"skill_name":"Refine records","description":"One content refine request (elaborate/shorten) triggered by the user via UI.","assists_per_unit":1,"category":"General"},
    {"skill_name":"Regex generation","description":"One accepted Regex pattern by the user.","assists_per_unit":5,"category":"General"},
    {"skill_name":"Regulatory alert impacted citations","description":"One request to recommend citations with improved accuracy; impacted due to regulatory alert powered by NowLLM and Advanced AI Search/RAG.","assists_per_unit":20,"category":"ITSM"},
    {"skill_name":"Regulatory alert impacted control objectives","description":"One request to recommend control objectives with improved accuracy; impacted due to regulatory alert powered by NowLLM and Advanced AI Search/RAG.","assists_per_unit":20,"category":"ITSM"},
    {"skill_name":"Regulatory alert impacted policies","description":"One request to recommend policies with improved accuracy; impacted due to regulatory alert powered by NowLLM and Advanced AI Search/RAG.","assists_per_unit":20,"category":"ITSM"},
    {"skill_name":"Regulatory alert summarization","description":"One request to summarize an incoming regulatory alert into a concise readable format powered by NowLLM.","assists_per_unit":1,"category":"ITSM"},
    {"skill_name":"Regulatory mapping with AI [controls recommendation]","description":"One request to recommend controls with improved accuracy and precision; impacted due to regulatory alert powered by NowLLM and Advanced AI Search/RAG.","assists_per_unit":20,"category":"SPM"},
    {"skill_name":"Request and requested item summarization for approvals","description":"One request to summarize ITSM request or requested item requiring an approval to help approvers quickly understand the full context.","assists_per_unit":1,"category":"SPM"},
    {"skill_name":"Resolution note / Security Incident resolution notes generation","description":"One resolution note generation request (including those invoked via workflow button or workspace configuration).","assists_per_unit":1,"category":"ITSM"},
    {"skill_name":"Resume skill extraction","description":"One request triggered by a user to extract skills from a resume.","assists_per_unit":10,"category":"Document"},
    {"skill_name":"Risk assessment summarization","description":"One risk assessment summarization request (including those invoked via workflow button, workspace configuration, interface, or channel).","assists_per_unit":1,"category":"General"},
    {"skill_name":"Risk event summarization","description":"One request to summarize risk event requested to help users quickly understand the full context of the risk event record.","assists_per_unit":1,"category":"General"},
    {"skill_name":"RPA bot generation","description":"One RPA bot generation call (including previews) triggered by user to generate an RPA flow from text.","assists_per_unit":500,"category":"General"},
    {"skill_name":"SaaS user resolution","description":"One call to analyze subscription data from incoming SaaS integrations and autonomously create User Resolution Rules.","assists_per_unit":1000,"category":"General"},
    {"skill_name":"Schedule data discovery job","description":"One request to schedule a data discovery job.","assists_per_unit":5,"category":"General"},
    {"skill_name":"Security incident quality analysis","description":"One request to generate the quality report of a Security Incident against preconfigured natural language rules.","assists_per_unit":1,"category":"ITSM"},
    {"skill_name":"SEM insights","description":"One request to generate top insights on Security Exposure Management (SEM) dashboards.","assists_per_unit":1,"category":"General"},
    {"skill_name":"Sentiment analysis (case, incident, HR)","description":"One sentiment call triggered either on record page load or schedule job.","assists_per_unit":1,"category":"ITSM"},
    {"skill_name":"Sentiment analysis dashboard generation","description":"One request to generate sentiment analysis insights.","assists_per_unit":10,"category":"General"},
    {"skill_name":"Sentiment analysis on Case","description":"Analyze the sentiment on a Case and get ad hoc updates per its progress.","assists_per_unit":1,"category":"General"},
    {"skill_name":"Service Bridge map generation","description":"Generate a remote task definition map for Service Bridge via a UI action.","assists_per_unit":500,"category":"General"},
    {"skill_name":"Service Graph Connector diagnosis","description":"One request to diagnose issues with any Service graph connector.","assists_per_unit":1,"category":"General"},
    {"skill_name":"Service recommendation for interactions","description":"One request to identify a recommended service definition mapped to a case type.","assists_per_unit":1,"category":"General"},
    {"skill_name":"ServiceNow Lens","description":"One call triggered by a user to read, understand, and respond to visual data and forms or preview the extracted information.","assists_per_unit":30,"category":"General"},
    {"skill_name":"Skill Kit / custom call","description":"One call to an LLM from a custom feature (skill) using Generative AI Controller.","assists_per_unit":1,"category":"General"},
    {"skill_name":"SPC setup connector","description":"One invocation by providing API documentation link via UI to generate API connector request.","assists_per_unit":10,"category":"General"},
    {"skill_name":"Spoke generation","description":"A single action generated inside of a new spoke or existing spoke.","assists_per_unit":500,"category":"General"},
    {"skill_name":"Subflows and actions","description":"One end-to-end conversational flow execution.","assists_per_unit":10,"category":"Flow"},
    {"skill_name":"Suggested steps","description":"One request to generate suggested steps for resolution of an incident or case.","assists_per_unit":25,"category":"General"},
    {"skill_name":"Summarization (of any type)","description":"One summarization request (including those invoked via workflow button, workspace configuration, interface, or channel).","assists_per_unit":1,"category":"General"},
    {"skill_name":"Synthetic data generation","description":"One synthetic data record generated through Now Assist Data Kit.","assists_per_unit":1,"category":"General"},
    {"skill_name":"Target generation","description":"One request to generate a target for a goal based on the input text and goal information.","assists_per_unit":5,"category":"General"},
    {"skill_name":"Task generation","description":"One multi-turn conversation for generating tasks from Docs content.","assists_per_unit":5,"category":"General"},
    {"skill_name":"Test case generation (Text-to-test)","description":"One test case generation request.","assists_per_unit":50,"category":"SPM"},
    {"skill_name":"Trending topics dashboard generation","description":"One request to generate insights on trending topics.","assists_per_unit":10,"category":"General"},
    {"skill_name":"Voice agent conversation","description":"One phone conversation with a Voice Agent.","assists_per_unit":50,"category":"General"},
    {"skill_name":"Work notes analysis","description":"One work notes analysis request.","assists_per_unit":250,"category":"General"},
    {"skill_name":"Work notes analysis for small transitions","description":"One work notes analysis request (for records less than 25).","assists_per_unit":100,"category":"General"},
    {"skill_name":"Workplace insights","description":"One request to generate the Workplace insights on the dashboard.","assists_per_unit":10,"category":"General"},
    {"skill_name":"Write planning items","description":"Write planning item introduces quick actions to refine text, accelerate planning item creation while enhancing quality.","assists_per_unit":1,"category":"General"},
    {"skill_name":"Agentic workflow – small","description":"Execution of a small agentic workflow (Less than 4 actions) by an AI agent team or Agent. An agentic workflow begins when an orchestrator agent initiates activity, and ends on workflow completion, 20 actions, or 1 hour of inactivity. 1 Action = 1 Tool Invocation.","assists_per_unit":25,"category":"Agentic"},
    {"skill_name":"Agentic workflow – medium","description":"Execution of a medium agentic workflow (5-8 actions) by an AI agent team or Agent. An agentic workflow begins when an orchestrator agent initiates activity, and ends on workflow completion, 20 actions, or 1 hour of inactivity. 1 Action = 1 Tool Invocation.","assists_per_unit":50,"category":"Agentic"},
    {"skill_name":"Agentic workflow – large","description":"Execution of a large agentic workflow (9-20 actions) by an AI agent team or Agent. An agentic workflow begins when an orchestrator agent initiates activity, and ends on workflow completion, 20 actions, or 1 hour of inactivity. Any actions beyond the first 20 will be counted in a new agentic workflow. 1 Action = 1 Tool Invocation.","assists_per_unit":150,"category":"Agentic"},
  ];

  for (const skill of RATE_CARD_SKILLS) {
    ins(`INSERT OR IGNORE INTO asdlc_assist_rate_card
      (skill_id, skill_name, category, assists_per_unit, description)
      VALUES (?,?,?,?,?)`,
      [[crypto.randomUUID(), skill.skill_name, skill.category, skill.assists_per_unit, skill.description || '']]);
  }

  // Legacy global cost_assumption row — retained only as a fallback for projects
  // that haven't been backfilled. All authoritative cost params now live on
  // asdlc_project (per-Application).
  ins(`INSERT OR IGNORE INTO asdlc_cost_assumption
    (cost_assumption_id, cost_per_assist, overage_rate)
    VALUES (?,?,?)`,
    [['cost-assumption-global', 0.015, null]]);

  // ── ACME demo testing data (Phase 5 backfill): user stories, ACs, TCs ──
  // Minimal but sufficient for the Testing module to render content on ACME.
  // Uses INSERT OR IGNORE keyed by fixed UUIDs for idempotency.
  const ACME_INGEST = '33333333-1111-0000-0000-000000000001';
  ins(`INSERT OR IGNORE INTO asdlc_ingest_document
    (ingest_id, project_id, document_title, file_name, file_type, document_type,
     description, ingest_status, uploaded_by, uploaded_at, processing_notes, change_packets_generated)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
    [ACME_INGEST, P1,
      'ACME Pilot 1 — Backlog Package',
      'ACME_Pilot1_Backlog.docx', 'docx', 'requirements_doc',
      'Initial backlog: held-order triage, customer notification, returns processing.',
      'complete', U1, '2026-03-15 09:00:00',
      'Extracted 3 user stories across 3 use cases.', 3],
  ]);

  ins(`INSERT OR IGNORE INTO asdlc_ingest_extraction
    (extraction_id, ingest_id, entity_type, entity_data, confidence, status)
    VALUES (?,?,?,?,?,?)`, [
    ['33333333-2200-0000-0000-000000000001', ACME_INGEST, 'user_story', JSON.stringify({
      story_id_ref:'US1', story_type:'functional', sprint:1,
      title:'Held-order classification accuracy',
      description:'As an order ops analyst, I want the triage agent to classify held orders correctly so I can trust its routing recommendations.'
    }), 0.95, 'staged'],
    ['33333333-2200-0000-0000-000000000002', ACME_INGEST, 'user_story', JSON.stringify({
      story_id_ref:'US2', story_type:'functional', sprint:1,
      title:'Email notification deliverability',
      description:'As a customer, I want to receive accurate status emails so I know what is happening with my order.'
    }), 0.93, 'staged'],
    ['33333333-2200-0000-0000-000000000003', ACME_INGEST, 'user_story', JSON.stringify({
      story_id_ref:'US3', story_type:'compliance', sprint:2,
      title:'Returns eligibility audit trail',
      description:'As a finance approver, I want a full audit trail of returns decisions so refunds can be defended in audit.'
    }), 0.92, 'staged'],
  ]);

  ins(`INSERT OR IGNORE INTO asdlc_acceptance_criterion
    (acceptance_criterion_id, project_id, parent_type, parent_id, text, source, status)
    VALUES (?,?,?,?,?,?,?)`, [
    ['ac-acme-001', P1, 'use_case', UC1, 'Triage agent assigns held-order tickets to the correct queue at ≥ 90% accuracy on a 100-ticket validation set.', 'generated', 'approved'],
    ['ac-acme-002', P1, 'use_case', UC1, 'Average hold-resolution time across pilot drops below 8 hours within 30 days of go-live.',                                'generated', 'approved'],
    ['ac-acme-003', P1, 'use_case', UC2, 'Customer notification emails for status changes are sent within 5 minutes of the underlying OMS event.',                  'generated', 'approved'],
    ['ac-acme-004', P1, 'use_case', UC2, 'Notification content passes brand-style check (no profanity, no internal codes) on a 50-message sample.',                  'generated', 'draft'],
    ['ac-acme-005', P1, 'use_case', UC3, 'Returns decisions include a complete audit trail (decision, reasoning, fixture references) accessible from the ticket.',  'generated', 'approved'],
    ['ac-acme-006', P1, 'use_case', UC3, 'Refund auto-authorisation rate ≥ 80% on cases meeting the policy criteria after a 60-day pilot.',                          'generated', 'draft'],
  ]);

  ins(`INSERT OR IGNORE INTO asdlc_test_case
    (test_case_id, project_id, scope, scope_entity_id, title, test_action, test_input, expected_result, case_type, source, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
    ['tc-acme-001', P1, 'agent', AS1,
      'Held order with valid customer hold → routes to CS queue',
      'Submit a held order where customer_hold=true.',
      'Fixture: order-fixture-customer-hold.json',
      'Agent classifies as customer_hold and routes to the CS triage queue.', 'happy_path', 'generated', 'approved'],
    ['tc-acme-002', P1, 'agent', AS1,
      'Held order with conflicting flags → escalates to HITL',
      'Submit a held order where multiple hold reasons are set (credit_hold + inventory_hold).',
      'Fixture: order-fixture-ambiguous.json',
      'Agent confidence < 0.80, posts an escalation ticket; no auto-routing occurs.', 'edge_case', 'generated', 'approved'],
    ['tc-acme-003', P1, 'workflow', '88888888-0000-0000-0000-000000000001',
      'WF-014 end-to-end: held → triaged → notified',
      'Trigger order.status.held event for an in-scope SKU.',
      'OMS test event: customer_id=DEMO-001, order_id=ORD-99001.',
      'Workflow completes within SLA; case created in ServiceNow; status note posted; notification sent.', 'happy_path', 'generated', 'approved'],
    ['tc-acme-004', P1, 'agent', AS2,
      'Notification agent — opt-out customer is skipped',
      'Trigger a status change for a customer with notification_opt_in=false.',
      'Fixture: customer-fixture-optout.json',
      'No email is sent; audit log records the suppression with reason "opt-out".', 'negative', 'generated', 'approved'],
    ['tc-acme-005', P1, 'agent', AS3,
      'Returns agent — high-value return triggers HITL',
      'Submit a return with refund_amount > $2,000.',
      'Fixture: return-fixture-highvalue.json',
      'Agent flags for human approval; no auto-authorisation. Audit log captures the threshold breach.', 'edge_case', 'generated', 'approved'],
    ['tc-acme-006', P1, 'tool', 'd0000000-0000-0000-0000-000000000003',
      'Transactional Email API — bounce path',
      'Submit a notification call against a mailbox that bounces.',
      'Fixture: email-bounce-stub.json',
      'Tool returns delivery_status=bounced; workflow records exception; no retry storm.', 'negative', 'generated', 'approved'],
  ]);

  // Re-enable FK enforcement and verify nothing was orphaned by the seed run.
  db.exec('PRAGMA foreign_keys = ON');
  const orphans = db.prepare('PRAGMA foreign_key_check').all();
  if (orphans.length > 0) {
    console.error('[seed] FK integrity issue — '+orphans.length+' orphan ref(s):');
    for (const o of orphans.slice(0, 5)) console.error('  ', o);
  }
  console.log('[seed] Seed complete.');
}

module.exports = { seed };
