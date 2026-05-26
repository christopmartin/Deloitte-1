// agent/claude-processor.js
//
// Real Claude extraction engine — replaces stub-processor.js.
// Uses Anthropic API with tool use (function calling) to extract structured
// design entities from ingested documents and stage them for human review.
//
// Same public interface as stub-processor:
//   async processDocument(ingestId)
//   → { extractions_staged, clarifications_raised, round, new_status, threshold }
//
'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const fs        = require('fs');
const path      = require('path');
const { db, generateId } = require('../db');

// ── Anthropic client (lazy) ───────────────────────────────────────────────────
let _client;
function getClient() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set in .env');
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

// ── Schema loaded once at startup ─────────────────────────────────────────────
const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');

// ── Model config ──────────────────────────────────────────────────────────────
const MODEL         = process.env.CLAUDE_EXTRACTION_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS    = 8192;
const MAX_API_LOOPS = 10;   // safety cap on the tool-call agentic loop

// ─────────────────────────────────────────────────────────────────────────────
// TOOL DEFINITIONS
// Each tool maps directly to a Workbench entity type.
// Parameters mirror the schema columns.
// confidence (0–1) is REQUIRED on every extraction tool — forces honest self-assessment.
// ─────────────────────────────────────────────────────────────────────────────
const EXTRACTION_TOOLS = [
  {
    name: 'extract_use_case',
    description: 'Extract a use case identified in the document. Maps to asdlc_use_case.',
    input_schema: {
      type: 'object',
      properties: {
        title:             { type: 'string',  description: 'Short descriptive title of the use case' },
        summary:           { type: 'string',  description: 'Brief summary of what this use case achieves' },
        business_objective:{ type: 'string',  description: 'The business objective this use case serves' },
        expected_value:    { type: 'string',  description: 'Expected value — cost saving, time saving, quality improvement' },
        users:             { type: 'string',  description: 'Who uses this — roles, teams, or systems' },
        success_criteria:  { type: 'array',   items: { type: 'string' }, description: 'Measurable success criteria' },
        constraints_list:  { type: 'array',   items: { type: 'string' }, description: 'Known constraints or limitations' },
        supervision_model: { type: 'string',  enum: ['Assisted', 'Automated', 'Human-led'], description: 'Level of human supervision required' },
        urgency:           { type: 'string',  description: 'Business urgency or priority' },
        confidence:        { type: 'number',  minimum: 0, maximum: 1, description: 'Your confidence in this extraction (0–1)' },
        confidence_notes:  { type: 'string',  description: 'What you are uncertain about, if anything' },
      },
      required: ['title', 'summary', 'confidence'],
    },
  },
  {
    name: 'extract_workflow',
    description: 'Extract a workflow — a named sequence of steps that accomplishes a goal. Maps to asdlc_workflow.',
    input_schema: {
      type: 'object',
      properties: {
        name:          { type: 'string', description: 'Name of the workflow' },
        trigger:       { type: 'string', description: 'What starts this workflow — event, schedule, human action, or system call' },
        handoffs:      { type: 'array',  items: { type: 'string' }, description: 'Hand-off points where work moves between roles or systems' },
        decisions:     { type: 'array',  items: { type: 'string' }, description: 'Key decision points in the workflow' },
        fallback_paths:{ type: 'array',  items: { type: 'string' }, description: 'Alternative paths when the happy path fails or branches' },
        confidence:    { type: 'number', minimum: 0, maximum: 1, description: 'Your confidence in this extraction (0–1)' },
        confidence_notes: { type: 'string', description: 'What you are uncertain about, if anything' },
      },
      required: ['name', 'trigger', 'confidence'],
    },
  },
  {
    name: 'extract_workflow_step',
    description: 'Extract a single step within a workflow. Call once per step. Maps to asdlc_workflow_step.',
    input_schema: {
      type: 'object',
      properties: {
        name:          { type: 'string',  description: 'Name of the step' },
        step_number:   { type: 'integer', description: 'Sequence number within the workflow (1, 2, 3…)' },
        workflow_name: { type: 'string',  description: 'Name of the parent workflow this step belongs to' },
        actor_role:    { type: 'string',  description: 'Role or system responsible for executing this step' },
        sla_hours:     { type: 'number',  description: 'Maximum hours allowed to complete this step' },
        inputs:        { type: 'array',   items: { type: 'string' }, description: 'Inputs required to begin this step' },
        outputs:       { type: 'array',   items: { type: 'string' }, description: 'Outputs produced when this step completes' },
        decisions_list:{ type: 'array',   items: { type: 'string' }, description: 'Decisions made at this step' },
        confidence:    { type: 'number',  minimum: 0, maximum: 1, description: 'Your confidence in this extraction (0–1)' },
        confidence_notes: { type: 'string', description: 'What you are uncertain about, if anything' },
      },
      required: ['name', 'step_number', 'confidence'],
    },
  },
  {
    name: 'extract_hitl_gate',
    description: 'Extract a Human-in-the-Loop gate — a point where a human must review, approve, or decide before the workflow continues. Maps to asdlc_hitl_gate.',
    input_schema: {
      type: 'object',
      properties: {
        gate_name:         { type: 'string', description: 'Name of this HITL gate' },
        workflow_name:     { type: 'string', description: 'Name of the workflow this gate belongs to' },
        gate_type:         { type: 'string', enum: ['approval', 'review', 'escalation', 'sign-off', 'other'], description: 'Type of human intervention required' },
        criteria:          { type: 'string', description: 'What the human is reviewing or deciding — the question they must answer' },
        owner_role:        { type: 'string', description: 'Role responsible for responding at this gate' },
        sla:               { type: 'string', description: 'Time allowed for the human to respond (e.g. "4 hours", "1 business day")' },
        handoff_mechanism: { type: 'string', description: 'How the work reaches the human — notification, queue, dashboard, email' },
        trigger_condition: { type: 'string', description: 'When this gate fires — always, on threshold breach, on exception flag' },
        confidence:        { type: 'number', minimum: 0, maximum: 1, description: 'Your confidence in this extraction (0–1)' },
        confidence_notes:  { type: 'string', description: 'What you are uncertain about, if anything' },
      },
      required: ['gate_name', 'criteria', 'owner_role', 'confidence'],
    },
  },
  {
    name: 'extract_agent_spec',
    description: 'Extract an AI agent specification — a named agent with a defined role in the workflow. Maps to asdlc_agent_spec.',
    input_schema: {
      type: 'object',
      properties: {
        name:            { type: 'string', description: 'Name of the agent' },
        scope:           { type: 'string', description: 'What this agent is responsible for — its domain and boundaries' },
        instructions:    { type: 'string', description: 'Key operating rules or instructions for this agent' },
        goals:           { type: 'array',  items: { type: 'string' }, description: 'Goals this agent must achieve' },
        done_criteria:   { type: 'array',  items: { type: 'string' }, description: 'How to determine when this agent has successfully completed its task' },
        memory_strategy: { type: 'string', description: 'How this agent retains context — none, session, or persistent' },
        design_risks:    { type: 'array',  items: { type: 'string' }, description: 'Known risks or failure modes in this agent\'s design' },
        model_preference:{ type: 'string', description: 'Preferred AI model (e.g. claude-sonnet, claude-opus)' },
        confidence:      { type: 'number', minimum: 0, maximum: 1, description: 'Your confidence in this extraction (0–1)' },
        confidence_notes:{ type: 'string', description: 'What you are uncertain about, if anything' },
      },
      required: ['name', 'scope', 'confidence'],
    },
  },
  {
    name: 'extract_guardrail',
    description: 'Extract a guardrail — a rule, constraint, limit, or boundary on agent behaviour. Not stored in its own table; promoted to a Change Packet for human approval.',
    input_schema: {
      type: 'object',
      properties: {
        rule_name:           { type: 'string', description: 'Short name for this guardrail' },
        rule_text:           { type: 'string', description: 'Full plain-English statement of the rule' },
        severity:            { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'How severe a breach of this rule would be' },
        applies_to:          { type: 'string', description: 'What entity type or process this guardrail constrains' },
        threshold_value:     { type: 'string', description: 'Numeric or categorical threshold that triggers this rule (e.g. "10000", "> 7")' },
        threshold_unit:      { type: 'string', description: 'Unit of the threshold — GBP, items, hours, score, etc.' },
        regulatory_reference:{ type: 'string', description: 'Regulation or policy this guardrail derives from, if any' },
        action_if_triggered: { type: 'string', enum: ['block', 'escalate', 'flag', 'log', 'halt'], description: 'What should happen when this rule is triggered' },
        confidence:          { type: 'number', minimum: 0, maximum: 1, description: 'Your confidence in this extraction (0–1)' },
        confidence_notes:    { type: 'string', description: 'What you are uncertain about, if anything' },
      },
      required: ['rule_name', 'rule_text', 'severity', 'confidence'],
    },
  },
  {
    name: 'extract_user_story',
    description: 'Extract a user story in Role / Want / So-That format.',
    input_schema: {
      type: 'object',
      properties: {
        role:                { type: 'string', description: 'The type of user — their role or title' },
        want:                { type: 'string', description: 'What this user wants the system to do' },
        so_that:             { type: 'string', description: 'The business reason — why they want it' },
        acceptance_criteria: { type: 'array',  items: { type: 'string' }, description: 'Testable conditions that must be met for this story to be complete' },
        priority:            { type: 'string', enum: ['must-have', 'should-have', 'could-have'], description: 'Priority of this story' },
        confidence:          { type: 'number', minimum: 0, maximum: 1, description: 'Your confidence in this extraction (0–1)' },
        confidence_notes:    { type: 'string', description: 'What you are uncertain about, if anything' },
      },
      required: ['role', 'want', 'so_that', 'confidence'],
    },
  },
  {
    name: 'extract_data_source',
    description: 'Extract a data source — any system, database, API, file store, or service that an agent reads from or writes to.',
    input_schema: {
      type: 'object',
      properties: {
        source_name:        { type: 'string',  description: 'Name of the system or data source' },
        source_type:        { type: 'string',  enum: ['api', 'database', 'file', 'service', 'queue', 'other'], description: 'Type of data source' },
        description:        { type: 'string',  description: 'What this source contains and what it is used for' },
        access_type:        { type: 'string',  enum: ['read', 'write', 'read-write'], description: 'Whether agents read, write, or both' },
        access_requirements:{ type: 'array',   items: { type: 'string' }, description: 'Authentication, permission, or licensing requirements' },
        contains_pii:       { type: 'boolean', description: 'Does this source contain personal or sensitive data?' },
        rate_limits:        { type: 'string',  description: 'API rate limits or quota constraints if known' },
        confidence:         { type: 'number',  minimum: 0, maximum: 1, description: 'Your confidence in this extraction (0–1)' },
        confidence_notes:   { type: 'string',  description: 'What you are uncertain about, if anything' },
      },
      required: ['source_name', 'source_type', 'confidence'],
    },
  },
  {
    name: 'extract_process_segment',
    description: 'Extract a process segment — a named phase or stage within the overall process (commonly used for as-is analysis).',
    input_schema: {
      type: 'object',
      properties: {
        segment_name:   { type: 'string',  description: 'Name of the process segment' },
        description:    { type: 'string',  description: 'What happens in this segment' },
        swim_lane:      { type: 'string',  description: 'Department, team, or system boundary that owns this segment' },
        sequence_order: { type: 'integer', description: 'Position of this segment in the overall process' },
        confidence:     { type: 'number',  minimum: 0, maximum: 1, description: 'Your confidence in this extraction (0–1)' },
        confidence_notes:{ type: 'string', description: 'What you are uncertain about, if anything' },
      },
      required: ['segment_name', 'confidence'],
    },
  },
  {
    name: 'extract_governance_control',
    description: 'Extract a governance control — a recurring review, audit, or oversight mechanism.',
    input_schema: {
      type: 'object',
      properties: {
        control_name:     { type: 'string', description: 'Name of the governance control' },
        description:      { type: 'string', description: 'What this control does and why it exists' },
        frequency:        { type: 'string', description: 'How often — daily, weekly, monthly, quarterly, annually' },
        owner_role:       { type: 'string', description: 'Role responsible for this control' },
        evidence_required:{ type: 'string', description: 'Evidence that must be produced to demonstrate this control was performed' },
        confidence:       { type: 'number', minimum: 0, maximum: 1, description: 'Your confidence in this extraction (0–1)' },
        confidence_notes: { type: 'string', description: 'What you are uncertain about, if anything' },
      },
      required: ['control_name', 'confidence'],
    },
  },
  {
    name: 'raise_clarification',
    description: [
      'Raise a clarification question when you cannot determine a field with sufficient confidence.',
      'Use this alongside the extraction tool — extract your best guess AND raise the question.',
      'Do NOT use this for things that can be reasonably inferred from the document.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        question_text:      { type: 'string', description: 'The specific, answerable question to ask the user' },
        target_entity_type: { type: 'string', description: 'The entity type this question is about' },
        target_field:       { type: 'string', description: 'The specific field you need clarification on' },
        context_snippet:    { type: 'string', description: 'A short quote or context from the document that prompted this question' },
        why_uncertain:      { type: 'string', description: 'Why the document does not make this clear' },
      },
      required: ['question_text', 'target_entity_type', 'target_field'],
    },
  },
];

// ── tool name → entity_type ───────────────────────────────────────────────────
const TOOL_TO_ENTITY = {
  extract_use_case:           'use_case',
  extract_workflow:           'workflow',
  extract_workflow_step:      'workflow_step',
  extract_hitl_gate:          'hitl_gate',
  extract_agent_spec:         'agent_spec',
  extract_guardrail:          'guardrail',
  extract_user_story:         'user_story',
  extract_data_source:        'data_source',
  extract_process_segment:    'process_segment',
  extract_governance_control: 'governance_control',
};

// ── DB helpers ────────────────────────────────────────────────────────────────
function getCurrentRound(ingestId) {
  const row = db.prepare(
    'SELECT MAX(round) AS r FROM asdlc_ingest_clarification WHERE ingest_id = ?'
  ).get(ingestId);
  return (row?.r ?? 0) + 1;
}

function getAnsweredClarifications(ingestId) {
  return db.prepare(
    'SELECT * FROM asdlc_ingest_clarification WHERE ingest_id = ? AND answer_text IS NOT NULL ORDER BY round, created_at'
  ).all(ingestId);
}

/** Upsert an extraction row — match on entity_type + primary name field to avoid duplicates on re-runs. */
function upsertExtraction(ingestId, entityType, entityData, confidence, status, round) {
  const keyValue =
    entityData.title        || entityData.name      || entityData.rule_name  ||
    entityData.gate_name    || entityData.segment_name || entityData.source_name ||
    entityData.control_name ||
    (entityData.role && entityData.want ? `${entityData.role}::${entityData.want}` : null);

  let existingId = null;

  if (keyValue) {
    const rows = db.prepare(
      "SELECT extraction_id, entity_data FROM asdlc_ingest_extraction WHERE ingest_id=? AND entity_type=?"
    ).all(ingestId, entityType);

    for (const row of rows) {
      try {
        const d = JSON.parse(row.entity_data);
        const k =
          d.title        || d.name      || d.rule_name  ||
          d.gate_name    || d.segment_name || d.source_name ||
          d.control_name ||
          (d.role && d.want ? `${d.role}::${d.want}` : null);
        if (k === keyValue) { existingId = row.extraction_id; break; }
      } catch { /* skip unparseable rows */ }
    }
  }

  if (existingId) {
    db.prepare(
      "UPDATE asdlc_ingest_extraction SET entity_data=?, confidence=?, status=?, round=? WHERE extraction_id=?"
    ).run(JSON.stringify(entityData), confidence, status, round, existingId);
    return existingId;
  }

  const id = generateId();
  db.prepare(`
    INSERT INTO asdlc_ingest_extraction
      (extraction_id, ingest_id, entity_type, entity_data, confidence, status, round, created_at)
    VALUES (?,?,?,?,?,?,?,datetime('now'))
  `).run(id, ingestId, entityType, JSON.stringify(entityData), confidence, status, round);
  return id;
}

/** Write a clarification question — skip if an open question already exists for the same field. */
function writeClarification(ingestId, round, q) {
  const already = db.prepare(
    "SELECT 1 FROM asdlc_ingest_clarification WHERE ingest_id=? AND target_entity_type=? AND target_field=? AND answer_text IS NULL"
  ).get(ingestId, q.target_entity_type || 'general', q.target_field || 'general');
  if (already) return false;

  db.prepare(`
    INSERT INTO asdlc_ingest_clarification
      (clarification_id, ingest_id, round, question_text, context_snippet,
       target_entity_type, target_field, created_at)
    VALUES (?,?,?,?,?,?,?,datetime('now'))
  `).run(
    generateId(), ingestId, round,
    q.question_text,
    (q.context_snippet || q.why_uncertain || '').slice(0, 500),
    q.target_entity_type || 'general',
    q.target_field        || 'general'
  );
  return true;
}

// ── Prompt builders ───────────────────────────────────────────────────────────
function buildSystemPrompt(doc, threshold, answeredClarifications) {
  const lines = [
    `You are an expert requirements extraction agent for an Agentic AI Software Development Lifecycle (SDLC) Workbench.`,
    ``,
    `Your job: read the document and call the appropriate extraction tool for EVERY design entity you find.`,
    `Call tools repeatedly — one call per entity. Do not combine multiple entities into one tool call.`,
    ``,
    `## Confidence rules`,
    `- confidence is on a 0–1 scale and is REQUIRED on every extraction tool call.`,
    `- If confidence >= ${threshold}: extract it. It will be staged for human review.`,
    `- If confidence < ${threshold}: STILL extract it (with your best guess), AND call raise_clarification`,
    `  with a specific answerable question targeting the uncertain field.`,
    `- Be honest. Overconfidence creates bad data. It is better to ask than to guess wrong.`,
    `- Confidence means: how certain are you the extracted FIELD VALUES are accurate — not just that the entity exists.`,
    ``,
    `## What to extract`,
    `  use_case          — any business objective or automation goal`,
    `  workflow          — any named process or sequence of steps`,
    `  workflow_step     — each individual step within a workflow (one tool call per step)`,
    `  hitl_gate         — any point where a human must review, approve, or decide`,
    `  agent_spec        — any AI agent described or clearly implied`,
    `  guardrail         — any rule, constraint, limit, or boundary on agent behaviour`,
    `  user_story        — any requirement stated from a user's perspective`,
    `  data_source       — any system, database, API, or data store mentioned`,
    `  process_segment   — named phases or stages (as-is or to-be analysis)`,
    `  governance_control — any recurring audit, review, or oversight mechanism`,
    ``,
    `## What NOT to do`,
    `  - Do not invent entities not present or clearly implied in the document`,
    `  - Do not extract the same entity twice`,
    `  - Do not raise clarification questions for things you can reasonably infer`,
    `  - Do not stop early — read the entire document before concluding`,
    ``,
    `## Document context`,
    `  Application : ${doc.project_name || 'Unknown'}`,
    `  Document type: ${doc.document_type}`,
    `  Title        : ${doc.document_title}`,
    `  Description  : ${doc.description || 'None provided'}`,
    `  Confidence threshold for this application: ${threshold}`,
  ];

  if (answeredClarifications && answeredClarifications.length > 0) {
    lines.push(
      ``,
      `## Clarification answers (use these to improve low-confidence extractions)`,
      ...answeredClarifications.map(a =>
        `  [Round ${a.round} | ${a.target_entity_type}.${a.target_field}]\n  Q: ${a.question_text}\n  A: ${a.answer_text}`
      ),
      ``,
      `Focus on re-extracting items that had low confidence in previous rounds.`,
      `Do NOT re-extract items that were already confidently staged.`
    );
  }

  lines.push(
    ``,
    `## Workbench database schema`,
    `Use the column names below as a guide for what fields to populate in each tool call.`,
    ``,
    SCHEMA_SQL
  );

  return lines.join('\n');
}

function buildUserMessage(doc, round, threshold) {
  if (round === 1) {
    return (
      `Please analyse the following document and extract all design entities.\n\n` +
      `---\n\n${doc.raw_text}`
    );
  }

  // Subsequent rounds — only re-process items that need clarification
  const uncertain = db.prepare(
    "SELECT entity_type, entity_data, confidence FROM asdlc_ingest_extraction WHERE ingest_id=? AND status='needs_clarification'"
  ).all(doc.ingest_id);

  const summary = uncertain.map(u => {
    const d = JSON.parse(u.entity_data);
    const name = d.title || d.name || d.rule_name || d.gate_name || d.segment_name || u.entity_type;
    return `  - ${u.entity_type}: "${name}" (previous confidence ${Math.round(u.confidence * 100)}%)`;
  }).join('\n');

  return [
    `Clarification answers have been provided (see system prompt).`,
    ``,
    `The following items were previously below the ${threshold} confidence threshold:`,
    summary || '  (none — re-analysing full document)',
    ``,
    `Please re-extract ONLY these items, using the clarification answers to improve accuracy.`,
    `Do not re-extract items that were already staged (above threshold).`,
    ``,
    `Original document for reference:\n---\n${doc.raw_text}`,
  ].join('\n');
}

// ── Agentic extraction loop ───────────────────────────────────────────────────
async function runExtractionLoop(systemPrompt, userMessage) {
  const client = getClient();
  const allToolUses = [];
  let messages = [{ role: 'user', content: userMessage }];
  let loops = 0;

  while (loops < MAX_API_LOOPS) {
    loops++;

    const response = await client.messages.create({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system:     systemPrompt,
      tools:      EXTRACTION_TOOLS,
      tool_choice:{ type: 'auto' },
      messages,
    });

    const toolUses = response.content.filter(b => b.type === 'tool_use');

    console.log(
      `[claude-processor] Loop ${loops} — stop_reason: ${response.stop_reason}, ` +
      `tool_uses this turn: ${toolUses.length}, total so far: ${allToolUses.length + toolUses.length}`
    );

    allToolUses.push(...toolUses);

    // Done when Claude signals end_turn or produces no tool calls
    if (response.stop_reason === 'end_turn' || toolUses.length === 0) break;

    // Build tool results (one per tool_use) and continue the conversation
    const toolResults = toolUses.map(tu => ({
      type:        'tool_result',
      tool_use_id: tu.id,
      content:     'Recorded.',
    }));

    messages = [
      ...messages,
      { role: 'assistant', content: response.content },
      { role: 'user',      content: toolResults },
    ];
  }

  if (loops >= MAX_API_LOOPS) {
    console.warn(`[claude-processor] Hit MAX_API_LOOPS (${MAX_API_LOOPS}) — extraction may be incomplete`);
  }

  return allToolUses;
}

// ── Main entry point ──────────────────────────────────────────────────────────
/**
 * Process an ingest document with the Claude extraction engine.
 * @param {string} ingestId
 * @returns {Promise<{ extractions_staged, clarifications_raised, round, new_status, threshold }>}
 */
async function processDocument(ingestId) {
  // Load doc + project config in one query
  const doc = db.prepare(`
    SELECT d.*, p.project_name, p.confidence_threshold
    FROM asdlc_ingest_document d
    LEFT JOIN asdlc_project p ON p.project_id = d.project_id
    WHERE d.ingest_id = ?
  `).get(ingestId);

  if (!doc) throw new Error(`Ingest document ${ingestId} not found`);
  if (!doc.raw_text) throw new Error('No raw_text found — run text extraction first via the /process endpoint');

  const threshold            = doc.confidence_threshold ?? 0.75;
  const round                = getCurrentRound(ingestId);
  const answeredClarifications = round > 1 ? getAnsweredClarifications(ingestId) : [];

  console.log(`[claude-processor] Starting — ingest ${ingestId}, round ${round}, threshold ${threshold}, model ${MODEL}`);

  // Mark as processing
  db.prepare("UPDATE asdlc_ingest_document SET ingest_status='processing', updated_at=datetime('now') WHERE ingest_id=?")
    .run(ingestId);

  // ── Call Claude ────────────────────────────────────────────────────────────
  let allToolUses;
  try {
    allToolUses = await runExtractionLoop(
      buildSystemPrompt(doc, threshold, answeredClarifications),
      buildUserMessage(doc, round, threshold)
    );
  } catch (err) {
    console.error('[claude-processor] API error:', err.message);
    db.prepare(
      "UPDATE asdlc_ingest_document SET ingest_status='failed', processing_notes=?, updated_at=datetime('now') WHERE ingest_id=?"
    ).run(`Claude API error: ${err.message}`, ingestId);
    throw err;
  }

  // ── Process tool call results ──────────────────────────────────────────────
  let staged     = 0;
  let clarified  = 0;

  for (const { name, input } of allToolUses) {

    // ── Clarification question ────────────────────────────────────────────
    if (name === 'raise_clarification') {
      if (writeClarification(ingestId, round, input)) clarified++;
      continue;
    }

    const entityType = TOOL_TO_ENTITY[name];
    if (!entityType) {
      console.warn(`[claude-processor] Unknown tool name: ${name} — skipping`);
      continue;
    }

    // Strip meta fields before storing entity_data
    const { confidence = 0, confidence_notes, ...entityData } = input;
    const status = confidence >= threshold ? 'staged' : 'needs_clarification';

    upsertExtraction(ingestId, entityType, entityData, confidence, status, round);

    if (status === 'staged') {
      staged++;
    } else if (confidence_notes) {
      // Claude signalled uncertainty but didn't raise a question — auto-generate one
      const autoRaised = writeClarification(ingestId, round, {
        question_text:      `The "${entityData.name || entityData.title || entityData.rule_name || entityType}" extraction has low confidence (${Math.round(confidence * 100)}%). ${confidence_notes} Can you provide more detail?`,
        target_entity_type: entityType,
        target_field:       'general',
        context_snippet:    confidence_notes,
      });
      if (autoRaised) clarified++;
    }
  }

  // ── Determine final document status ───────────────────────────────────────
  const openQ = db.prepare(
    "SELECT COUNT(*) AS c FROM asdlc_ingest_clarification WHERE ingest_id=? AND answer_text IS NULL"
  ).get(ingestId).c;

  const newStatus = openQ > 0 ? 'review_required' : 'staged';

  db.prepare(
    "UPDATE asdlc_ingest_document SET ingest_status=?, updated_at=datetime('now') WHERE ingest_id=?"
  ).run(newStatus, ingestId);

  console.log(
    `[claude-processor] Complete — staged: ${staged}, clarifications: ${clarified}, ` +
    `open questions: ${openQ}, status: ${newStatus}`
  );

  return { extractions_staged: staged, clarifications_raised: clarified, round, new_status: newStatus, threshold };
}

module.exports = { processDocument };
