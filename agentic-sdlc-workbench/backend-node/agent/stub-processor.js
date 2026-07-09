// agent/stub-processor.js
// Simulates Claude AI extraction without live API calls.
// Generates plausible, contextually appropriate extractions and clarifying questions
// based on document metadata (type, title).  Swap for real-claude-processor.js
// once the Anthropic API key is available.
'use strict';

const { db, generateId } = require('../db');

// ── Helpers ──────────────────────────────────────────────────────────────────

function getThreshold(projectId) {
  const row = db.prepare('SELECT confidence_threshold FROM asdlc_project WHERE project_id = ?').get(projectId);
  return row?.confidence_threshold ?? 0.75;
}

function getCurrentRound(ingestId) {
  const row = db.prepare(
    'SELECT MAX(round) AS r FROM asdlc_ingest_clarification WHERE ingest_id = ?'
  ).get(ingestId);
  return (row?.r ?? 0) + 1;
}

function getAnsweredFields(ingestId) {
  // Returns a Set of "entityType:targetField" strings that have been answered
  const rows = db.prepare(
    'SELECT target_entity_type, target_field FROM asdlc_ingest_clarification WHERE ingest_id = ? AND answer_text IS NOT NULL'
  ).all(ingestId);
  return new Set(rows.map(r => `${r.target_entity_type}:${r.target_field}`));
}

// Derive a short context label from the document title
function titleContext(title) {
  return (title || '')
    .split(/[\s—\-]+/)
    .filter(w => w.length > 3 && !/^(pilot|wave|phase|part|section|v\d)$/i.test(w))
    .slice(0, 3)
    .join(' ') || 'Application';
}

// ── Extraction templates per document_type ────────────────────────────────────
// Each item: { entity_type, base_confidence, entity_data, question?, question_field? }
// question/question_field present only on items that are ambiguous by nature.

function buildTemplates(doc) {
  const ctx = titleContext(doc.document_title);

  const TEMPLATES = {

    interview_transcript: [
      { entity_type: 'use_case', base_confidence: 0.93, entity_data: {
        use_case_name: `${ctx} — Automated Processing`,
        description: `End-to-end automation of ${ctx} operations identified in workshop transcript.`,
        actors: ['Operations Manager', 'System Agent', 'Customer'],
        goals: ['Reduce manual effort', 'Improve accuracy', 'Shorten cycle time'],
      }},
      { entity_type: 'workflow', base_confidence: 0.88, entity_data: {
        workflow_name: `${ctx} Intake & Routing`,
        description: `Primary intake workflow for ${ctx} requests.`,
        trigger: 'New request received via system',
        owner_role: 'Operations Manager',
      }},
      { entity_type: 'workflow_step', base_confidence: 0.91, entity_data: {
        step_name: 'Receive & validate request',
        step_order: 1,
        owner_role: 'Validation Agent',
        sla_hours: 1,
        description: 'Agent validates completeness and format of the incoming request.',
      }},
      { entity_type: 'workflow_step', base_confidence: 0.85, entity_data: {
        step_name: 'Eligibility assessment',
        step_order: 2,
        owner_role: 'Assessment Agent',
        sla_hours: 2,
        description: 'Check customer and request eligibility against defined rules.',
      }},
      { entity_type: 'workflow_step', base_confidence: 0.59, entity_data: {
        step_name: 'Route to fulfilment team',
        step_order: 3,
        owner_role: null,
        sla_hours: null,
        description: 'Route validated request to the appropriate team for action.',
      }, question: 'Which fulfilment teams exist and what criteria determine routing (e.g. region, product type, value threshold)?', question_field: 'routing_criteria' },
      { entity_type: 'guardrail', base_confidence: 0.83, entity_data: {
        rule_name: 'High-value approval gate',
        rule_text: 'All requests exceeding the defined value threshold require manager approval before routing.',
        severity: 'high',
        applies_to: 'workflow_step:Route to fulfilment team',
      }},
      { entity_type: 'user_story', base_confidence: 0.66, entity_data: {
        role: 'Operations Manager',
        want: 'real-time visibility into request status across all stages',
        so_that: 'I can intervene when SLAs are at risk',
        acceptance_criteria: null,
      }, question: 'What does "real-time" mean here — live dashboard refresh, email alerts, or both? What is the SLA breach notification threshold (minutes)?', question_field: 'acceptance_criteria' },
      { entity_type: 'hitl_gate', base_confidence: 0.80, entity_data: {
        gate_name: 'Exception escalation review',
        description: 'Human review required for all flagged exceptions before processing continues.',
        trigger_condition: 'Exception flag raised by agent',
        required_role: 'Senior Reviewer',
      }},
    ],

    process_map: [
      { entity_type: 'process_segment', base_confidence: 0.94, entity_data: {
        segment_name: `${ctx} — Initiation`,
        description: 'Opening phase: request received, initial checks performed.',
        swim_lane: 'Customer',
        sequence_order: 1,
      }},
      { entity_type: 'process_segment', base_confidence: 0.91, entity_data: {
        segment_name: `${ctx} — Processing`,
        description: 'Core processing phase: validation, assessment, and decision.',
        swim_lane: 'Operations',
        sequence_order: 2,
      }},
      { entity_type: 'workflow', base_confidence: 0.87, entity_data: {
        workflow_name: `${ctx} Core Process`,
        description: 'As-is process flow extracted from process map.',
        trigger: 'Customer submission',
        owner_role: 'Process Owner',
      }},
      { entity_type: 'workflow_step', base_confidence: 0.90, entity_data: {
        step_name: 'Submit request',
        step_order: 1,
        owner_role: 'Customer',
        sla_hours: null,
      }},
      { entity_type: 'workflow_step', base_confidence: 0.84, entity_data: {
        step_name: 'Initial triage',
        step_order: 2,
        owner_role: 'Triage Agent',
        sla_hours: 4,
      }},
      { entity_type: 'workflow_step', base_confidence: 0.61, entity_data: {
        step_name: 'Manual review',
        step_order: 3,
        owner_role: null,
        sla_hours: null,
      }, question: 'Who is responsible for the manual review step — which team or role? What is the expected turnaround SLA (hours)?', question_field: 'owner_role' },
      { entity_type: 'hitl_gate', base_confidence: 0.82, entity_data: {
        gate_name: 'Exception review checkpoint',
        description: 'Human review required for all flagged exceptions before processing continues.',
        trigger_condition: 'Exception flag raised by agent',
        required_role: 'Senior Reviewer',
      }},
    ],

    policy_document: [
      { entity_type: 'guardrail', base_confidence: 0.95, entity_data: {
        rule_name: 'Access control requirement',
        rule_text: 'All agent actions must be performed under a named service account with auditable permissions.',
        severity: 'high',
        applies_to: 'agent_spec',
      }},
      { entity_type: 'guardrail', base_confidence: 0.92, entity_data: {
        rule_name: 'Data minimisation',
        rule_text: 'Agents may only access and retain data strictly necessary for the task in scope.',
        severity: 'high',
        applies_to: 'agent_spec',
      }},
      { entity_type: 'guardrail', base_confidence: 0.88, entity_data: {
        rule_name: 'Audit trail requirement',
        rule_text: 'Every agent decision and action must be logged with timestamp, user context, and outcome.',
        severity: 'high',
        applies_to: 'workflow',
      }},
      { entity_type: 'guardrail', base_confidence: 0.71, entity_data: {
        rule_name: 'SLA escalation rule',
        rule_text: 'Unresolved items exceeding the SLA threshold must be automatically escalated.',
        severity: 'medium',
        sla_hours: null,
      }, question: 'What is the specific SLA threshold (hours) that triggers automatic escalation? Is this uniform across all workflow types?', question_field: 'sla_hours' },
      { entity_type: 'governance_control', base_confidence: 0.89, entity_data: {
        control_name: 'Quarterly AI agent audit',
        description: 'All AI agent configurations and trust levels must be reviewed quarterly.',
        frequency: 'quarterly',
        owner_role: 'Methodology Owner',
      }},
      { entity_type: 'guardrail', base_confidence: 0.64, entity_data: {
        rule_name: 'Regulatory compliance check',
        rule_text: 'Agent outputs must be validated against applicable regulatory frameworks before commitment.',
        severity: 'high',
        frameworks: null,
      }, question: 'Which specific regulatory frameworks apply (e.g. GDPR, FCA, SOX)? Please list them in order of priority.', question_field: 'frameworks' },
    ],

    requirements_doc: [
      { entity_type: 'use_case', base_confidence: 0.92, entity_data: {
        use_case_name: `${ctx} — Core Automation`,
        description: `Primary automation use case extracted from requirements document.`,
        actors: ['Business User', 'AI Agent', 'System'],
        goals: ['Automate manual steps', 'Enforce policy compliance'],
      }},
      { entity_type: 'user_story', base_confidence: 0.90, entity_data: {
        role: 'Business User',
        want: 'submit requests through a single unified interface',
        so_that: 'I do not need to switch between multiple systems',
        acceptance_criteria: 'Single sign-on; all request types available from one screen',
      }},
      { entity_type: 'user_story', base_confidence: 0.86, entity_data: {
        role: 'Operations Manager',
        want: 'configurable approval thresholds',
        so_that: 'high-risk items always receive human review',
        acceptance_criteria: 'Threshold configurable per request type; default values documented',
      }},
      { entity_type: 'user_story', base_confidence: 0.63, entity_data: {
        role: 'Compliance Officer',
        want: 'automated compliance checks at each workflow stage',
        so_that: 'regulatory requirements are met without manual intervention',
        acceptance_criteria: null,
      }, question: 'Which specific regulatory frameworks apply? List the compliance checks required at each stage and the evidence required to pass each check.', question_field: 'acceptance_criteria' },
      { entity_type: 'workflow', base_confidence: 0.84, entity_data: {
        workflow_name: `${ctx} Submission Workflow`,
        description: 'End-to-end submission and processing workflow.',
        trigger: 'User initiates submission',
        owner_role: 'Business Process Owner',
      }},
      { entity_type: 'guardrail', base_confidence: 0.77, entity_data: {
        rule_name: 'Approval threshold control',
        rule_text: 'Items above the defined risk threshold must be approved by a named manager before processing.',
        severity: 'high',
        threshold_value: null,
      }, question: 'What is the risk threshold value (e.g. £5,000, risk_score > 7)? Is it the same for all request types?', question_field: 'threshold_value' },
    ],

    technical_spec: [
      { entity_type: 'data_source', base_confidence: 0.93, entity_data: {
        source_name: `${ctx} Core API`,
        source_type: 'api',
        description: 'Primary REST API for data retrieval and transaction processing.',
        access_requirements: ['OAuth 2.0', 'TLS 1.2+'],
      }},
      { entity_type: 'data_source', base_confidence: 0.89, entity_data: {
        source_name: 'Customer Master Database',
        source_type: 'database',
        description: 'Read-only access to customer profile and eligibility data.',
        access_requirements: ['Read-only service account', 'Row-level security enforced'],
      }},
      { entity_type: 'agent_spec', base_confidence: 0.85, entity_data: {
        agent_name: `${ctx} Integration Agent`,
        description: 'Agent responsible for API integration and data transformation.',
        model: 'claude-sonnet',
        boundaries: ['No write access to production DB', 'Must log all API calls'],
      }},
      { entity_type: 'guardrail', base_confidence: 0.70, entity_data: {
        rule_name: 'Rate limiting compliance',
        rule_text: 'Agent must respect API rate limits and implement exponential backoff on 429 responses.',
        severity: 'medium',
        rate_limit_rpm: null,
      }, question: 'What are the API rate limits (requests per minute and per hour)? Is there a separate sandbox endpoint for development/testing?', question_field: 'rate_limit_rpm' },
    ],

    as_is_analysis: [
      { entity_type: 'process_segment', base_confidence: 0.91, entity_data: {
        segment_name: `${ctx} — Current State`,
        description: 'As-is process segment identified from analysis document.',
        swim_lane: 'Operations',
        sequence_order: 1,
      }},
      { entity_type: 'workflow', base_confidence: 0.87, entity_data: {
        workflow_name: `${ctx} As-Is Workflow`,
        description: 'Current-state workflow prior to AI augmentation.',
        trigger: 'Manual initiation by staff',
        owner_role: 'Team Lead',
      }},
      { entity_type: 'workflow_step', base_confidence: 0.82, entity_data: {
        step_name: 'Manual data entry',
        step_order: 1,
        owner_role: 'Data Entry Clerk',
        sla_hours: 24,
        description: 'Staff manually key data from source documents.',
      }},
      { entity_type: 'workflow_step', base_confidence: 0.79, entity_data: {
        step_name: 'Supervisor sign-off',
        step_order: 2,
        owner_role: 'Supervisor',
        sla_hours: 8,
      }},
      { entity_type: 'user_story', base_confidence: 0.68, entity_data: {
        role: 'Data Entry Clerk',
        want: 'automated pre-population of standard fields',
        so_that: 'I spend less time on routine data entry',
        acceptance_criteria: null,
      }, question: 'Which fields are candidates for automated pre-population? What source systems hold this data?', question_field: 'acceptance_criteria' },
    ],

    test_plan: [
      { entity_type: 'guardrail', base_confidence: 0.88, entity_data: {
        rule_name: 'Test coverage requirement',
        rule_text: 'All agent decision paths must have corresponding test scenarios with defined pass/fail criteria.',
        severity: 'high',
        applies_to: 'agent_spec',
      }},
      { entity_type: 'guardrail', base_confidence: 0.82, entity_data: {
        rule_name: 'Regression test gate',
        rule_text: 'No agent configuration change may be deployed without passing the full regression test suite.',
        severity: 'high',
        applies_to: 'workflow',
      }},
      { entity_type: 'hitl_gate', base_confidence: 0.85, entity_data: {
        gate_name: 'UAT sign-off gate',
        description: 'User acceptance testing sign-off required before any workflow moves to production.',
        trigger_condition: 'Workflow configuration change promoted to production baseline',
        required_role: 'Functional Owner',
      }},
      { entity_type: 'user_story', base_confidence: 0.72, entity_data: {
        role: 'QA Lead',
        want: 'automated test execution after every change packet approval',
        so_that: 'regression issues are caught before they reach production',
        acceptance_criteria: null,
      }, question: 'What test framework and tooling is in scope? What is the expected test execution time budget?', question_field: 'acceptance_criteria' },
    ],
  };

  // Fallback for unmapped document types
  const fallback = [
    { entity_type: 'use_case', base_confidence: 0.80, entity_data: {
      use_case_name: `${ctx} — Extracted Use Case`,
      description: `Use case extracted from ${doc.document_type || 'other'} document.`,
      actors: ['User', 'System'],
    }},
    { entity_type: 'user_story', base_confidence: 0.65, entity_data: {
      role: 'User',
      want: 'complete the core task efficiently',
      so_that: 'business objectives are met',
      acceptance_criteria: null,
    }, question: 'Can you describe the specific business objectives and success criteria for this use case in more detail?', question_field: 'acceptance_criteria' },
  ];

  return TEMPLATES[doc.document_type] || fallback;
}

// ── Main processor ────────────────────────────────────────────────────────────

/**
 * Process an ingest document (stub mode).
 * @param {string} ingestId
 * @returns {{ extractions_staged: number, clarifications_raised: number, round: number, new_status: string }}
 */
function processDocument(ingestId) {
  const doc = db.prepare('SELECT * FROM asdlc_ingest_document WHERE ingest_id = ?').get(ingestId);
  if (!doc) throw new Error(`Ingest document ${ingestId} not found`);

  // ── STUB vs REAL ──────────────────────────────────────────────────────────────
  // doc.raw_text contains the full extracted document text (set by the /process
  // endpoint before calling here).  When swapping to the real Claude processor,
  // pass doc.raw_text directly to the Anthropic API prompt.
  // Stub mode: ignores raw_text, uses document_type template instead.
  if (doc.raw_text) {
    console.log(`[stub-processor] raw_text available (${doc.raw_text.length} chars) — using template mode (swap for real Claude to use content)`);
  } else {
    console.log(`[stub-processor] no raw_text — running template-based extraction for doc type: ${doc.document_type}`);
  }

  const threshold  = getThreshold(doc.project_id);
  const round      = getCurrentRound(ingestId);
  const answered   = getAnsweredFields(ingestId);

  // Mark as processing
  db.prepare("UPDATE asdlc_ingest_document SET ingest_status='processing', updated_at=datetime('now') WHERE ingest_id=?").run(ingestId);

  const templates = buildTemplates(doc);

  // Each clarification round boosts the confidence of previously-questioned items
  // as the agent now has the user's answers to work with.
  const boost = round > 1 ? Math.min(0.20 * (round - 1), 0.35) : 0;

  let staged = 0;
  let clarified = 0;

  for (const tpl of templates) {
    const isQuestionItem = Boolean(tpl.question);
    const alreadyAnswered = isQuestionItem && answered.has(`${tpl.entity_type}:${tpl.question_field}`);

    // Raise confidence if this was previously answered
    const confidence = isQuestionItem && (alreadyAnswered || round > 1)
      ? Math.min(0.99, tpl.base_confidence + boost)
      : tpl.base_confidence;

    const status = confidence >= threshold ? 'staged' : 'needs_clarification';

    // Insert extraction (only once per question_field + entity_type combo)
    // Re-runs update the confidence but don't duplicate rows
    const existing = db.prepare(
      "SELECT extraction_id FROM asdlc_ingest_extraction WHERE ingest_id=? AND entity_type=? AND json_extract(entity_data,'$.step_name') IS json_extract(?,'$.step_name') AND json_extract(entity_data,'$.use_case_name') IS json_extract(?,'$.use_case_name') AND json_extract(entity_data,'$.rule_name') IS json_extract(?,'$.rule_name')"
    ).get(ingestId, tpl.entity_type, JSON.stringify(tpl.entity_data), JSON.stringify(tpl.entity_data), JSON.stringify(tpl.entity_data));

    if (existing) {
      // Update confidence and status on re-run
      db.prepare("UPDATE asdlc_ingest_extraction SET confidence=?, status=? WHERE extraction_id=?")
        .run(confidence, status, existing.extraction_id);
    } else {
      db.prepare(`
        INSERT INTO asdlc_ingest_extraction
          (extraction_id, ingest_id, entity_type, entity_data, confidence, status, round, created_at)
        VALUES (?,?,?,?,?,?,?,datetime('now'))
      `).run(generateId(), ingestId, tpl.entity_type, JSON.stringify(tpl.entity_data), confidence, status, round);
    }

    if (status === 'staged') staged++;

    // Raise a clarification if this item is below threshold and not yet asked
    if (isQuestionItem && status === 'needs_clarification' && !alreadyAnswered) {
      const alreadyAsked = db.prepare(
        "SELECT 1 FROM asdlc_ingest_clarification WHERE ingest_id=? AND target_entity_type=? AND target_field=? AND answer_text IS NULL"
      ).get(ingestId, tpl.entity_type, tpl.question_field);

      if (!alreadyAsked) {
        db.prepare(`
          INSERT INTO asdlc_ingest_clarification
            (clarification_id, ingest_id, round, question_text, context_snippet,
             target_entity_type, target_field, created_at)
          VALUES (?,?,?,?,?,?,?,datetime('now'))
        `).run(
          generateId(), ingestId, round, tpl.question,
          JSON.stringify(tpl.entity_data).slice(0, 250),
          tpl.entity_type, tpl.question_field
        );
        clarified++;
      }
    }
  }

  // Determine final status. Excludes discovery: rows (ServiceNow discovery-plan
  // ambiguities) — those are advisory-only and live in their own mini-form, never
  // this document's real Q&A loop.
  const { DISCOVERY_PREFIX } = require('./cross-check');
  const openQ = db.prepare(
    "SELECT COUNT(*) AS c FROM asdlc_ingest_clarification WHERE ingest_id=? AND answer_text IS NULL AND target_field NOT LIKE ?"
  ).get(ingestId, `${DISCOVERY_PREFIX}%`).c;

  const newStatus = openQ > 0 ? 'review_required' : 'staged';

  db.prepare("UPDATE asdlc_ingest_document SET ingest_status=?, updated_at=datetime('now') WHERE ingest_id=?")
    .run(newStatus, ingestId);

  return { extractions_staged: staged, clarifications_raised: clarified, round, new_status: newStatus, threshold };
}

module.exports = { processDocument };
