// agent/rasic-deriver.js
//
// AI-powered RASIC matrix inference for materialized workflows.
//
// PROBLEM IT SOLVES
// -----------------
// After a change packet is applied and the swimlane-deriver has created participants
// and set owner_participant_id on each step, the asdlc_workflow_step_rasic table
// is still empty — cells show only dots in the RASIC matrix UI. R/A/S/I/C codes
// require human knowledge about accountability that the ingestion pipeline cannot
// derive deterministically from actor_role strings alone.
//
// WHAT THIS DOES
// --------------
// For one materialized workflow (participants + step owners already set by
// swimlane-deriver), makes a single thoughtful Claude call with the COMPLETE step
// and participant context — purposes, authority levels, inputs/outputs, step types,
// preconditions — and has Claude assign R/A/S/I/C codes via tool calls. Results are
// written to asdlc_workflow_step_rasic.
//
// MODEL
// -----
// Defaults to claude-sonnet-4-6 (balanced). Configurable to claude-opus-4-8 (with
// extended thinking) via Admin panel (rasic_deriver_model setting) or env var
// CLAUDE_RASIC_DERIVER_MODEL. Sonnet is sufficient for most workflows; use Opus
// when RASIC accuracy is critical (high-risk workflows, audit environments).
//
// SAFETY
// ------
// Idempotent: skips entirely if the workflow already has ANY rasic rows (preserves
// all manual edits). INSERT OR IGNORE prevents duplicates on concurrent runs.
// Never throws — all errors are logged and the caller receives {skipped, cellsCreated:0}.
//
'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { db, generateId } = require('../db');
const aiConfig = require('./ai-config');
const { withWiki } = require('./wiki-context');

let _client;
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}
function hasKey() {
  const k = process.env.ANTHROPIC_API_KEY;
  return !!k && k.trim() !== '' && k !== 'paste-your-anthropic-key-here' && k !== 'your_anthropic_api_key_here';
}
function tryParse(v) { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } }
function fmt(v) {
  if (!v) return null;
  const p = tryParse(v);
  if (typeof p === 'string') return p || null;
  if (Array.isArray(p)) return p.length ? p.map(i => (typeof i === 'string' ? i : JSON.stringify(i))).join('; ') : null;
  return JSON.stringify(p);
}

// ── Tool definition ──────────────────────────────────────────────────────────
const RASIC_TOOL = {
  name: 'assign_rasic_codes',
  description:
    'Assign one or more RASIC codes to a step × participant pair. ' +
    'Call once per (step_name, participant_name) combination that should have a code. ' +
    'Skip pairs where the participant has no meaningful role in that step — blank is correct and preferred over noise.',
  input_schema: {
    type: 'object',
    properties: {
      step_name:        { type: 'string', description: 'Exact name of the workflow step as provided in the context.' },
      participant_name: { type: 'string', description: 'Exact display name of the participant column as provided in the context.' },
      codes: {
        type: 'array',
        items: { type: 'string', enum: ['R', 'A', 'S', 'I', 'C'] },
        description: 'One or more RASIC codes for this step × participant pair.',
        minItems: 1,
      },
      reasoning: { type: 'string', description: 'One sentence explaining why these codes apply — used for audit trail.' },
    },
    required: ['step_name', 'participant_name', 'codes', 'reasoning'],
  },
};

// ── Prompt builder ───────────────────────────────────────────────────────────
function buildSystemPrompt(wf, steps, participants) {
  const lines = [
    `You are an expert business-process analyst and RASIC accountability consultant.`,
    `Your task: analyse the following workflow and assign precise R/A/S/I/C codes to the`,
    `RASIC matrix. Call assign_rasic_codes once for every (step, participant) pair that`,
    `should have a code. Leave pairs blank when the participant has no meaningful role.`,
    ``,
    `## RASIC definitions`,
    `  R — Responsible: performs the work / executes the step.`,
    `  A — Accountable: owns the outcome; escalation point; signs off. EXACTLY ONE per step.`,
    `  S — Supported: assists execution with resources or action (does real work, not just advice).`,
    `  I — Informed: notified of outcome or progress but takes no action in the step.`,
    `  C — Consulted: provides expert input BEFORE or DURING the step; two-way communication.`,
    ``,
    `## Accountability rules`,
    `  - Every step MUST have exactly ONE A. If you are unsure, assign A to the most senior`,
    `    human or orchestrator with authority over the step's outcome.`,
    `  - The step's designated owner (marked "Owner" below) is the default R. Override only`,
    `    if another participant clearly executes the work.`,
    `  - Approval/Decision steps: the human approver or coordinator gets A; executor gets R.`,
    `  - Agents with authority_level "Execute (autonomous)" → R for their own steps.`,
    `  - Agents with authority_level "Advisory-only" → S or C, not R.`,
    `  - Orchestrator/System participants → I or C by default; R only if they literally execute.`,
    `  - C = engaged BEFORE the step completes. I = notified AFTER. Never confuse the two.`,
    `  - Do NOT assign every participant a code on every step — sparse is accurate.`,
    ``,
  ];

  // Workflow header
  const triggerDesc = fmt(wf.trigger_def);
  const decisions   = fmt(wf.decisions);
  const handoffs    = fmt(wf.handoffs);
  lines.push(...[
    `## Workflow: "${wf.name}"`,
    wf.risk_tier  ? `  Risk tier: ${wf.risk_tier}` : null,
    wf.sla_hours  ? `  End-to-end SLA: ${wf.sla_hours}h` : null,
    triggerDesc   ? `  Trigger: ${triggerDesc}` : null,
    decisions     ? `  Key decisions: ${decisions}` : null,
    handoffs      ? `  Handoffs: ${handoffs}` : null,
    ``,
  ].filter(Boolean));

  // Participants
  lines.push(`## Participants (RASIC columns)`);
  for (const p of participants) {
    const label     = p.rasic_column_display_name || p.agent_name || p.human_role_name || p.participant_type;
    const purpose   = p.purpose_in_workflow;
    const authority = p.authority_level;
    const inputs    = fmt(p.inputs_required);
    const outputs   = fmt(p.outputs_produced);
    const supModel  = p.supervision_model;

    lines.push(`  - "${label}" | type: ${p.participant_type}${authority ? ` | authority: ${authority}` : ''}`);
    if (purpose)   lines.push(`    Purpose in workflow: ${purpose}`);
    if (inputs)    lines.push(`    Inputs consumed: ${inputs}`);
    if (outputs)   lines.push(`    Outputs produced: ${outputs}`);
    if (supModel)  lines.push(`    Agent supervision model: ${supModel}`);
  }
  lines.push(``);

  // Steps
  lines.push(`## Steps (RASIC rows)`);
  // Build a participant lookup for resolving owner_participant_id → display name
  const pById = new Map(participants.map(p => [
    p.workflow_participant_id,
    p.rasic_column_display_name || p.agent_name || p.human_role_name || p.participant_type,
  ]));

  for (const s of steps) {
    const ownerLabel = s.owner_participant_id ? pById.get(s.owner_participant_id) : null;
    lines.push(`  Step ${s.step_number}: "${s.name}" [${s.step_type || 'Activity'}]${ownerLabel ? `  ← Owner: ${ownerLabel}` : ''}`);
    if (s.step_purpose)      lines.push(`    Purpose: ${s.step_purpose}`);
    if (s.preconditions)     lines.push(`    Preconditions: ${fmt(s.preconditions)}`);
    const inp = fmt(s.inputs);
    const out = fmt(s.outputs);
    if (inp)                 lines.push(`    Inputs: ${inp}`);
    if (out)                 lines.push(`    Outputs: ${out}`);
    if (s.evidence_captured) lines.push(`    Evidence captured: ${fmt(s.evidence_captured)}`);
    if (s.sla_hours)         lines.push(`    Step SLA: ${s.sla_hours}h`);
  }
  lines.push(``);
  lines.push(`Now call assign_rasic_codes for each step × participant pair that warrants a code.`);

  return lines.filter(l => l !== null).join('\n');
}

// ── Name resolution (fuzzy, case-insensitive) ─────────────────────────────────
function resolveStep(stepName, steps) {
  const n = String(stepName || '').toLowerCase().trim();
  return steps.find(s => String(s.name || '').toLowerCase().trim() === n) || null;
}

function resolveParticipant(participantName, participants) {
  const n = String(participantName || '').toLowerCase().trim();
  return participants.find(p => {
    const label = (p.rasic_column_display_name || p.agent_name || p.human_role_name || p.participant_type || '').toLowerCase().trim();
    return label === n;
  }) || null;
}

// ── Stub (no API key) ─────────────────────────────────────────────────────────
// Assigns R to the step owner only so the matrix is not completely empty in dev.
function stubRasic(steps, participants) {
  const assignments = [];
  for (const s of steps) {
    if (!s.owner_participant_id) continue;
    const p = participants.find(x => x.workflow_participant_id === s.owner_participant_id);
    if (p) assignments.push({ step: s, participant: p, codes: ['R'], reasoning: 'stub: step owner' });
  }
  return assignments;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Infer and write RASIC codes for one materialized workflow.
 * Should be called AFTER deriveSwimlane() so participants + owner_participant_id exist.
 *
 * @param {string} workflowId
 * @param {string} projectId
 * @param {string} uid  — written as created_by on new rows
 * @returns {Promise<{workflowId, cellsCreated, skipped, model}>}
 */
async function inferRasicMatrix(workflowId, projectId, uid) {
  try {
    // ── Guard: skip if any RASIC rows already exist for this workflow ──────────
    const already = db.prepare(`
      SELECT 1 FROM asdlc_workflow_step_rasic r
      JOIN asdlc_workflow_step s ON s.workflow_step_id = r.workflow_step_id
      WHERE s.workflow_id = ? LIMIT 1
    `).get(workflowId);
    if (already) {
      console.log(`[rasic-deriver] workflow ${workflowId} already has RASIC rows — skipping`);
      return { workflowId, cellsCreated: 0, skipped: true, model: 'n/a' };
    }

    // ── Load workflow ──────────────────────────────────────────────────────────
    const wf = db.prepare(`
      SELECT name, trigger_def, handoffs, decisions, fallback_paths, risk_tier, sla_hours
      FROM asdlc_workflow WHERE workflow_id = ?
    `).get(workflowId);
    if (!wf) return { workflowId, cellsCreated: 0, skipped: true, model: 'n/a' };

    // ── Load steps ─────────────────────────────────────────────────────────────
    const steps = db.prepare(`
      SELECT workflow_step_id, step_number, name, step_type, step_purpose,
             preconditions, inputs, outputs, evidence_captured, sla_hours,
             owner_participant_id
      FROM asdlc_workflow_step
      WHERE workflow_id = ?
        AND COALESCE(lifecycle_status, '') NOT IN ('retired', 'deleted')
      ORDER BY step_number
    `).all(workflowId);
    if (!steps.length) return { workflowId, cellsCreated: 0, skipped: true, model: 'n/a' };

    // ── Load participants ──────────────────────────────────────────────────────
    const participants = db.prepare(`
      SELECT p.workflow_participant_id, p.participant_type, p.authority_level,
             p.purpose_in_workflow, p.inputs_required, p.outputs_produced,
             p.rasic_column_display_name, p.human_role_name,
             a.name AS agent_name, a.supervision_model
      FROM asdlc_workflow_participant p
      LEFT JOIN asdlc_agent_spec a ON a.agent_spec_id = p.agent_spec_id
      WHERE p.workflow_id = ?
        AND p.include_in_rasic != 0
        AND COALESCE(p.lifecycle_status, '') NOT IN ('retired', 'deleted')
      ORDER BY p.rasic_column_order
    `).all(workflowId);
    if (!participants.length) return { workflowId, cellsCreated: 0, skipped: true, model: 'n/a' };

    let systemPrompt = buildSystemPrompt(wf, steps, participants);
    // Append platform-scoped AI Guidance (house rules) so RASIC honours the same rules
    // the extractor does (e.g. ServiceNow accountability conventions).
    const rasicGuidance = aiConfig.getActiveBestPractices(
      ['workflow', 'workflow_step', 'agent_spec'], aiConfig.getProjectPlatform(projectId));
    if (rasicGuidance.length) {
      systemPrompt += '\n\n## House rules / platform guidance (FOLLOW THESE)\n' +
        rasicGuidance.map(b => `  - ${b.title ? b.title + ': ' : ''}${b.rule_text}`).join('\n');
    }

    // ── Stub path (no API key) ─────────────────────────────────────────────────
    if (!hasKey()) {
      const assignments = stubRasic(steps, participants);
      let cellsCreated = 0;
      for (const { step, participant, codes } of assignments) {
        for (const code of codes) {
          const id = generateId();
          db.prepare(`
            INSERT OR IGNORE INTO asdlc_workflow_step_rasic
              (rasic_id, workflow_step_id, workflow_participant_id, project_id, code, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
          `).run(id, step.workflow_step_id, participant.workflow_participant_id, projectId, code, uid || 'rasic-deriver');
          cellsCreated++;
        }
      }
      console.log(`[rasic-deriver] stub: wrote ${cellsCreated} R-only cells for workflow ${workflowId}`);
      return { workflowId, cellsCreated, skipped: false, model: 'stub' };
    }

    // ── Claude call ────────────────────────────────────────────────────────────
    const model    = aiConfig.resolveModel('rasic_deriver');
    const thinkCfg = aiConfig.getThinkingConfig('rasic_deriver');
    let maxTokens  = Math.max(aiConfig.getMaxTokens(), 8192);
    if (thinkCfg?.thinking?.budget_tokens) {
      if (maxTokens <= thinkCfg.thinking.budget_tokens) maxTokens = thinkCfg.thinking.budget_tokens + 1024;
    }

    console.log(`[rasic-deriver] calling model ${model}${thinkCfg ? ' +thinking' : ''} for workflow ${workflowId} (${steps.length} steps × ${participants.length} participants)`);

    const req = {
      model,
      max_tokens: maxTokens,
      system: withWiki(systemPrompt),
      tools: [RASIC_TOOL],
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: `Assign RASIC codes for all ${steps.length} steps of the "${wf.name}" workflow.` }],
    };
    if (thinkCfg) {
      req.thinking = thinkCfg.thinking;
      if (thinkCfg.outputConfig) req.output_config = thinkCfg.outputConfig;
    }

    // Single-turn call — RASIC assignment needs no multi-turn loop
    const response = await getClient().messages.create(req);

    aiConfig.logUsage({
      projectId,
      source:   'rasic_infer',
      refId:    workflowId,
      model,
      round:    1,
      usage:    response.usage,
    });
    aiConfig.logToolCalls('rasic_derive', (response.content || []).filter(b => b.type === 'tool_use'));

    const toolUses = (response.content || []).filter(b => b.type === 'tool_use' && b.name === 'assign_rasic_codes');
    console.log(`[rasic-deriver] received ${toolUses.length} assign_rasic_codes calls for workflow ${workflowId}`);

    // ── Write results ──────────────────────────────────────────────────────────
    let cellsCreated = 0;
    let namesMissed  = 0;
    const insertRasic = db.prepare(`
      INSERT OR IGNORE INTO asdlc_workflow_step_rasic
        (rasic_id, workflow_step_id, workflow_participant_id, project_id, code, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `);

    for (const tu of toolUses) {
      const { step_name, participant_name, codes, reasoning } = tu.input || {};
      if (!step_name || !participant_name || !Array.isArray(codes) || !codes.length) continue;

      const step = resolveStep(step_name, steps);
      const part = resolveParticipant(participant_name, participants);

      if (!step || !part) {
        console.warn(`[rasic-deriver] name miss — step: "${step_name}" (${step ? 'ok' : 'NOT FOUND'}), participant: "${participant_name}" (${part ? 'ok' : 'NOT FOUND'})`);
        namesMissed++;
        continue;
      }

      const validCodes = codes.filter(c => ['R', 'A', 'S', 'I', 'C'].includes(c));
      for (const code of validCodes) {
        insertRasic.run(
          generateId(),
          step.workflow_step_id,
          part.workflow_participant_id,
          projectId,
          code,
          uid || 'rasic-deriver',
        );
        cellsCreated++;
      }

      if (reasoning) {
        console.log(`[rasic-deriver]   ${step_name} × ${participant_name} → [${validCodes.join(',')}] — ${reasoning}`);
      }
    }

    if (namesMissed) console.warn(`[rasic-deriver] ${namesMissed} name(s) could not be resolved — partial RASIC matrix`);
    console.log(`[rasic-deriver] wrote ${cellsCreated} RASIC cell(s) for workflow ${workflowId} (${wf.name})`);

    return { workflowId, cellsCreated, skipped: false, model };

  } catch (err) {
    console.error(`[rasic-deriver] inference failed for workflow ${workflowId} (non-fatal):`, err.message);
    return { workflowId, cellsCreated: 0, skipped: false, error: err.message, model: 'error' };
  }
}

module.exports = { inferRasicMatrix };
