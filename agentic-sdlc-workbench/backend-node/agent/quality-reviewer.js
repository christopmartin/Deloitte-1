// agent/quality-reviewer.js
//
// Feature #9 — Independent quality auditor for the Design Repository.
//
// Two entry points:
//   reviewEntity({ projectId, entityType, entityId, db }) → judge ONE entity
//     + its immediate neighbors (parent + siblings).
//   reviewApplication({ projectId, db }) → judge the whole Application.
//
// Both return { findings, model, source } where source ∈ { 'claude','stub' }.
// `applyFindings(db, projectId, entityType, entityId, findings)` upserts the
// findings into asdlc_exception with detected_by='quality-reviewer' and
// closes any prior-open findings on this entity that the new review didn't
// repeat (i.e. they were fixed).
//
// When ANTHROPIC_API_KEY is missing, a deterministic stub reviewer runs
// instead of Claude so local dev still works.
'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { randomUUID } = require('node:crypto');
const { REQUIRED_BY_MODE, requiredFieldsForMode } = require('./required-by-mode');

// ── Anthropic client (lazy) ───────────────────────────────────────────────────
let _client;
function getClient() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set in .env');
    }
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

const aiConfig   = require('./ai-config');
const MAX_TOKENS = 2048;

const CATEGORIES = ['missing', 'incomplete', 'inconsistent', 'conflicting'];
const SEVERITIES = ['low', 'med', 'high'];

function hasKey() {
  const k = process.env.ANTHROPIC_API_KEY;
  return !!k && k.trim() !== '' && k !== 'paste-your-anthropic-key-here' && k !== 'your_anthropic_api_key_here';
}

// ── Entity loaders ────────────────────────────────────────────────────────────
// All loaders return plain objects with JSON fields parsed.

function tryParse(s) {
  if (s == null) return null;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return s; }
}

function inflateJsonCols(row, cols) {
  if (!row) return row;
  for (const c of cols) {
    if (row[c] != null) row[c] = tryParse(row[c]);
  }
  return row;
}

function loadAgent(db, agentId) {
  const row = db.prepare(
    `SELECT * FROM asdlc_agent_spec WHERE agent_spec_id = ?`
  ).get(agentId);
  if (!row) return null;
  return inflateJsonCols(row, [
    'goals', 'done_criteria', 'design_risks', 'memory_strategy', 'cost_model',
    'post_release_validation',
  ]);
}

function loadUseCase(db, ucId) {
  const row = db.prepare(
    `SELECT * FROM asdlc_use_case WHERE use_case_id = ?`
  ).get(ucId);
  if (!row) return null;
  return inflateJsonCols(row, [
    'success_criteria', 'constraints_list', 'volume_assumptions',
  ]);
}

function loadWorkflow(db, wfId) {
  const row = db.prepare(
    `SELECT * FROM asdlc_workflow WHERE workflow_id = ?`
  ).get(wfId);
  if (!row) return null;
  return inflateJsonCols(row, [
    'trigger_def', 'fallback_paths', 'handoffs',
  ]);
}

function loadTool(db, toolId) {
  const row = db.prepare(
    `SELECT * FROM asdlc_tool WHERE tool_id = ?`
  ).get(toolId);
  return row || null;
}

function loadFunctionalReq(db, frId) {
  const row = db.prepare(`SELECT * FROM asdlc_functional_req WHERE fr_id = ?`).get(frId);
  if (!row) return null;
  return inflateJsonCols(row, ['actors', 'acceptance_criteria', 'dependencies']);
}

function loadNonfunctionalReq(db, nfrId) {
  const row = db.prepare(`SELECT * FROM asdlc_nonfunctional_req WHERE nfr_id = ?`).get(nfrId);
  if (!row) return null;
  return inflateJsonCols(row, ['dependencies']);
}

function loadWorkflowStep(db, stepId) {
  const row = db.prepare(`SELECT * FROM asdlc_workflow_step WHERE workflow_step_id = ?`).get(stepId);
  if (!row) return null;
  return inflateJsonCols(row, ['inputs', 'outputs', 'decisions_list']);
}

// ── Neighbor loaders (one hop) ────────────────────────────────────────────────
function loadAgentNeighbors(db, agent) {
  // Linked use cases (M:N)
  const useCases = db.prepare(
    `SELECT uc.* FROM asdlc_use_case uc
       JOIN asdlc_agent_use_case auc ON auc.use_case_id = uc.use_case_id
      WHERE auc.agent_spec_id = ?`
  ).all(agent.agent_spec_id).map(r => inflateJsonCols(r, ['success_criteria','constraints_list']));

  // Sibling agents on the same use cases
  const ucIds = useCases.map(u => u.use_case_id);
  let siblings = [];
  if (ucIds.length) {
    const placeholders = ucIds.map(() => '?').join(',');
    siblings = db.prepare(
      `SELECT DISTINCT a.agent_spec_id, a.name, a.scope, a.supervision_model
         FROM asdlc_agent_spec a
         JOIN asdlc_agent_use_case auc ON auc.agent_spec_id = a.agent_spec_id
        WHERE auc.use_case_id IN (${placeholders})
          AND a.agent_spec_id != ?`
    ).all(...ucIds, agent.agent_spec_id);
  }

  // Tools bound to this agent
  const tools = db.prepare(
    `SELECT t.* FROM asdlc_tool t
       JOIN asdlc_agent_tool at ON at.tool_id = t.tool_id
      WHERE at.agent_spec_id = ?`
  ).all(agent.agent_spec_id);

  return { use_cases: useCases, sibling_agents: siblings, tools };
}

function loadUseCaseNeighbors(db, uc) {
  const workflows = db.prepare(
    `SELECT * FROM asdlc_workflow WHERE use_case_id = ?`
  ).all(uc.use_case_id).map(r => inflateJsonCols(r, ['trigger_def']));

  const agents = db.prepare(
    `SELECT a.agent_spec_id, a.name, a.scope, a.supervision_model
       FROM asdlc_agent_spec a
       JOIN asdlc_agent_use_case auc ON auc.agent_spec_id = a.agent_spec_id
      WHERE auc.use_case_id = ?`
  ).all(uc.use_case_id);

  return { workflows, agents };
}

function loadWorkflowNeighbors(db, wf) {
  const useCase = wf.use_case_id ? loadUseCase(db, wf.use_case_id) : null;
  const steps = db.prepare(
    `SELECT workflow_step_id, step_number, name, step_type, step_purpose
       FROM asdlc_workflow_step WHERE workflow_id = ? ORDER BY step_number`
  ).all(wf.workflow_id);
  return { use_case: useCase, steps };
}

function loadToolNeighbors(db, tool) {
  const consumers = db.prepare(
    `SELECT a.agent_spec_id, a.name FROM asdlc_agent_spec a
       JOIN asdlc_agent_tool at ON at.agent_spec_id = a.agent_spec_id
      WHERE at.tool_id = ?`
  ).all(tool.tool_id);
  return { consuming_agents: consumers };
}

// ── Traceability-link helpers (asdlc_requirement_link) ────────────────────────
// The reviewer normalizes 'agent' → 'agent_spec' to match the link table enum.
function normalizeLinkEntityType(entityType) {
  return entityType === 'agent' ? 'agent_spec' : entityType;
}

const LINK_REQ_TABLE = {
  functional:    { table: 'asdlc_functional_req',    idCol: 'fr_id' },
  nonfunctional: { table: 'asdlc_nonfunctional_req', idCol: 'nfr_id' },
};

// Requirements that an element implements — feeds Tier-B (element-vs-requirement)
// conflict detection when reviewing a derived element.
function loadRequirementsForEntity(db, entityType, entityId) {
  const links = db.prepare(
    `SELECT req_type, req_id, status FROM asdlc_requirement_link
      WHERE entity_type = ? AND entity_id = ? AND lifecycle_status = 'active' AND status != 'rejected'`
  ).all(normalizeLinkEntityType(entityType), entityId);
  const out = [];
  for (const l of links) {
    const m = LINK_REQ_TABLE[l.req_type];
    if (!m) continue;
    const r = db.prepare(`SELECT slug, title, description FROM ${m.table} WHERE ${m.idCol} = ?`).get(l.req_id);
    if (r) out.push({ slug: r.slug, title: r.title, description: r.description, req_type: l.req_type, link_status: l.status });
  }
  return out;
}

// Elements that implement a requirement — feeds Tier-B when reviewing a requirement.
function loadEntitiesForRequirement(db, reqType, reqId) {
  const links = db.prepare(
    `SELECT entity_type, entity_id, status FROM asdlc_requirement_link
      WHERE req_type = ? AND req_id = ? AND lifecycle_status = 'active' AND status != 'rejected'`
  ).all(reqType, reqId);
  const META = {
    use_case:      { table: 'asdlc_use_case',      idCol: 'use_case_id',      label: 'title' },
    workflow:      { table: 'asdlc_workflow',      idCol: 'workflow_id',      label: 'name'  },
    workflow_step: { table: 'asdlc_workflow_step', idCol: 'workflow_step_id', label: 'name'  },
    agent_spec:    { table: 'asdlc_agent_spec',    idCol: 'agent_spec_id',    label: 'name'  },
    tool:          { table: 'asdlc_tool',          idCol: 'tool_id',          label: 'name'  },
  };
  const out = [];
  for (const l of links) {
    const m = META[l.entity_type];
    if (!m) continue;
    const r = db.prepare(`SELECT slug, ${m.label} AS label FROM ${m.table} WHERE ${m.idCol} = ?`).get(l.entity_id);
    if (r) out.push({ entity_type: l.entity_type, slug: r.slug, name: r.label, link_status: l.status });
  }
  return out;
}

// Sibling requirements (same use case if set, else same project, capped) — the
// substrate for requirement↔requirement (Tier-A) conflict detection.
function loadSiblingRequirements(db, projectId, useCaseId, excludeReqId) {
  const scopeClause = useCaseId ? 'use_case_id = ?' : 'project_id = ?';
  const scopeVal = useCaseId || projectId;
  const frs = db.prepare(
    `SELECT slug, title, description FROM asdlc_functional_req
      WHERE ${scopeClause} AND project_id = ? AND status != 'deleted' AND fr_id != ? LIMIT 40`
  ).all(scopeVal, projectId, excludeReqId || '');
  const nfrs = db.prepare(
    `SELECT slug, title, measurable_target FROM asdlc_nonfunctional_req
      WHERE ${scopeClause} AND project_id = ? AND status != 'deleted' AND nfr_id != ? LIMIT 40`
  ).all(scopeVal, projectId, excludeReqId || '');
  return { functional: frs, nonfunctional: nfrs };
}

function lightUseCase(db, ucId) {
  return db.prepare(
    `SELECT use_case_id, slug, title, summary, supervision_model FROM asdlc_use_case WHERE use_case_id = ?`
  ).get(ucId) || null;
}

function loadFunctionalReqNeighbors(db, fr) {
  return {
    use_case: fr.use_case_id ? lightUseCase(db, fr.use_case_id) : null,
    sibling_requirements: loadSiblingRequirements(db, fr.project_id, fr.use_case_id, fr.fr_id),
    implemented_by: loadEntitiesForRequirement(db, 'functional', fr.fr_id),
  };
}

function loadNonfunctionalReqNeighbors(db, nfr) {
  return {
    use_case: nfr.use_case_id ? lightUseCase(db, nfr.use_case_id) : null,
    sibling_requirements: loadSiblingRequirements(db, nfr.project_id, nfr.use_case_id, nfr.nfr_id),
    implemented_by: loadEntitiesForRequirement(db, 'nonfunctional', nfr.nfr_id),
  };
}

function loadWorkflowStepNeighbors(db, step) {
  const workflow = db.prepare(
    `SELECT workflow_id, slug, name, use_case_id FROM asdlc_workflow WHERE workflow_id = ?`
  ).get(step.workflow_id) || null;
  const siblings = db.prepare(
    `SELECT workflow_step_id, step_number, name, step_type FROM asdlc_workflow_step
      WHERE workflow_id = ? AND workflow_step_id != ? ORDER BY step_number`
  ).all(step.workflow_id, step.workflow_step_id);
  return {
    workflow,
    sibling_steps: siblings,
    implements_requirements: loadRequirementsForEntity(db, 'workflow_step', step.workflow_step_id),
  };
}

// Dispatcher
function loadEntityWithNeighbors(db, entityType, entityId) {
  switch (entityType) {
    case 'agent':
    case 'agent_spec': {
      const entity = loadAgent(db, entityId);
      if (!entity) return null;
      const neighbors = loadAgentNeighbors(db, entity);
      neighbors.implements_requirements = loadRequirementsForEntity(db, 'agent_spec', entityId);
      return { entity, neighbors };
    }
    case 'use_case': {
      const entity = loadUseCase(db, entityId);
      if (!entity) return null;
      const neighbors = loadUseCaseNeighbors(db, entity);
      neighbors.implements_requirements = loadRequirementsForEntity(db, 'use_case', entityId);
      return { entity, neighbors };
    }
    case 'workflow': {
      const entity = loadWorkflow(db, entityId);
      if (!entity) return null;
      const neighbors = loadWorkflowNeighbors(db, entity);
      neighbors.implements_requirements = loadRequirementsForEntity(db, 'workflow', entityId);
      return { entity, neighbors };
    }
    case 'tool': {
      const entity = loadTool(db, entityId);
      if (!entity) return null;
      const neighbors = loadToolNeighbors(db, entity);
      neighbors.implements_requirements = loadRequirementsForEntity(db, 'tool', entityId);
      return { entity, neighbors };
    }
    case 'functional_req': {
      const entity = loadFunctionalReq(db, entityId);
      if (!entity) return null;
      return { entity, neighbors: loadFunctionalReqNeighbors(db, entity) };
    }
    case 'nonfunctional_req': {
      const entity = loadNonfunctionalReq(db, entityId);
      if (!entity) return null;
      return { entity, neighbors: loadNonfunctionalReqNeighbors(db, entity) };
    }
    case 'workflow_step': {
      const entity = loadWorkflowStep(db, entityId);
      if (!entity) return null;
      return { entity, neighbors: loadWorkflowStepNeighbors(db, entity) };
    }
    default:
      return null;
  }
}

const REQUIREMENT_TYPES = new Set(['functional_req', 'nonfunctional_req']);

// ── Field-emptiness heuristics ────────────────────────────────────────────────
function isEmpty(val) {
  if (val == null) return true;
  if (typeof val === 'string') return val.trim() === '';
  if (Array.isArray(val)) return val.length === 0;
  if (typeof val === 'object') return Object.keys(val).length === 0;
  return false;
}

function readField(entity, fieldPath) {
  // Supports dotted paths like 'volume_assumptions.monthly_requests'
  if (!fieldPath.includes('.')) return entity[fieldPath];
  return fieldPath.split('.').reduce(
    (acc, k) => (acc && typeof acc === 'object' ? acc[k] : undefined),
    entity
  );
}

// ── Stub reviewer ─────────────────────────────────────────────────────────────
// Deterministic, rule-based. Used when no API key is configured.
function stubReview(entityType, entity /* , neighbors */) {
  const findings = [];
  const mode = entity.supervision_model || null;
  const rbmType = (entityType === 'agent_spec') ? 'agent' : entityType;
  const requiredFields = requiredFieldsForMode(rbmType, mode);

  for (const f of requiredFields) {
    const v = readField(entity, f);
    if (isEmpty(v)) {
      findings.push({
        severity: 'high',
        category: 'missing',
        field_name: f,
        description: `Required field "${f}" is empty for supervision mode "${mode || 'default'}".`,
        suggested_action: `Provide a value for ${f}.`,
      });
    }
  }

  // String-length heuristics — these only run when the field is present.
  if (entityType === 'agent' || entityType === 'agent_spec') {
    if (typeof entity.instructions === 'string' &&
        entity.instructions.trim() !== '' &&
        entity.instructions.trim().length < 100) {
      findings.push({
        severity: 'med',
        category: 'incomplete',
        field_name: 'instructions',
        description: 'Prompt is very short (<100 chars). Likely missing role, scope, tools, or operating rules.',
        suggested_action: 'Expand the prompt to cover Role, Scope, Tools, Done criteria, and Operating rules.',
      });
    }
    if (Array.isArray(entity.goals) && entity.goals.length === 1 && typeof entity.goals[0] === 'string' && entity.goals[0].length < 20) {
      findings.push({
        severity: 'low',
        category: 'incomplete',
        field_name: 'goals',
        description: 'Only one short goal listed — agent objectives may not be sufficiently specified.',
        suggested_action: 'Add measurable goals that describe successful outcomes.',
      });
    }
  }

  if (entityType === 'use_case') {
    if (typeof entity.summary === 'string' && entity.summary.trim().length < 40) {
      findings.push({
        severity: 'low',
        category: 'incomplete',
        field_name: 'summary',
        description: 'Use case summary is very short — may not convey the business context.',
        suggested_action: 'Rewrite the summary to describe the problem, the user, and the value.',
      });
    }
  }

  // Requirements: objective gaps only — never judge the requirement's intrinsic
  // "quality" or intent. (Conflict/inconsistency detection needs the AI reviewer.)
  if (entityType === 'functional_req') {
    if (isEmpty(entity.description)) {
      findings.push({ severity: 'high', category: 'missing', field_name: 'description',
        description: 'Functional requirement has no description — the need it states is not captured.',
        suggested_action: 'Describe what the system must do to fulfil this requirement.' });
    }
    if (isEmpty(entity.acceptance_criteria)) {
      findings.push({ severity: 'med', category: 'incomplete', field_name: 'acceptance_criteria',
        description: 'No acceptance criteria — the requirement cannot be objectively verified.',
        suggested_action: 'Add at least one verifiable acceptance criterion.' });
    }
  }
  if (entityType === 'nonfunctional_req') {
    if (isEmpty(entity.measurable_target)) {
      findings.push({ severity: 'high', category: 'missing', field_name: 'measurable_target',
        description: 'Non-functional requirement has no measurable target — it cannot be verified.',
        suggested_action: 'Add a concrete, measurable target (e.g. "p95 < 2s", "99.9% uptime").' });
    }
    if (isEmpty(entity.verification_method)) {
      findings.push({ severity: 'low', category: 'incomplete', field_name: 'verification_method',
        description: 'No verification method specified for this NFR.',
        suggested_action: 'State how the target will be verified — load test, audit, etc.' });
    }
  }
  if (entityType === 'workflow_step') {
    if (isEmpty(entity.actor_role)) {
      findings.push({ severity: 'med', category: 'missing', field_name: 'actor_role',
        description: 'Workflow step has no actor/role responsible for executing it.',
        suggested_action: 'Assign the role or system that performs this step.' });
    }
  }

  return findings;
}

// ── Claude reviewer ───────────────────────────────────────────────────────────
function buildClaudeReviewPrompt(entityType, entity, neighbors, opts = {}) {
  const mode = entity.supervision_model || (neighbors?.use_case?.supervision_model) || 'Supervised HITL';
  const rbmType = (entityType === 'agent_spec') ? 'agent' : entityType;
  const required = requiredFieldsForMode(rbmType, mode);

  const parts = [];
  parts.push(`You are an **independent quality auditor** reviewing one entity from a Design Repository for an agentic application. You have NO knowledge of what the original author was trying to achieve and you should NOT trust their intent — judge the artifact on its own merits.

Your job is to find issues in **exactly four categories**:
- **missing** — a required field is empty or absent.
- **incomplete** — content is present but doesn't fully address what the field is supposed to specify (e.g. a one-sentence prompt; a goal that isn't measurable; ambiguous wording).
- **inconsistent** — the same concept is named or defined differently across this entity and its neighbors.
- **conflicting** — two statements (inside this entity, or across this entity and its neighbors) directly contradict each other.

Output strictly as JSON in this exact shape (no Markdown, no prose, no preamble):
{
  "findings": [
    { "severity": "low|med|high", "category": "missing|incomplete|inconsistent|conflicting",
      "field_name": "field_key_or_null", "description": "...",
      "suggested_action": "..." }
  ]
}

If you find nothing, return { "findings": [] }. Do not invent issues to fill space. Be specific — refer to the actual field names and values you saw.`);

  parts.push('');
  parts.push(`# Entity under review: ${entityType.replace('_',' ')}`);
  parts.push('```json');
  parts.push(JSON.stringify(entity, null, 2));
  parts.push('```');
  parts.push('');
  parts.push(`# Methodology: required fields for supervision mode "${mode}"`);
  parts.push(required.length
    ? required.map(f => `- ${f}`).join('\n')
    : '_(no required fields known for this entity type)_');
  parts.push('');
  parts.push(`# Immediate neighbors (for fit / consistency / conflict checks)`);
  parts.push('```json');
  parts.push(JSON.stringify(neighbors || {}, null, 2));
  parts.push('```');

  if (Array.isArray(opts.bestPractices) && opts.bestPractices.length) {
    parts.push('');
    parts.push('# Design best practices / house rules (JUDGE THE ENTITY AGAINST THESE)');
    parts.push(opts.bestPractices.map(bp => `- ${bp.title ? bp.title + ': ' : ''}${bp.rule_text}`).join('\n'));
  }

  if (opts.extraGuidance) {
    parts.push('');
    parts.push(opts.extraGuidance);
  }

  return parts.join('\n');
}

// Requirements are statements of NEED, not derived artifacts — so we judge them
// only for conflicts/inconsistencies with their neighbors and for objective gaps.
// We deliberately do NOT critique a requirement's intrinsic "quality" or intent.
function buildRequirementReviewPrompt(entityType, entity, neighbors) {
  const label = entityType === 'nonfunctional_req' ? 'non-functional requirement' : 'functional requirement';
  const parts = [];
  parts.push(`You are an **independent requirements auditor** reviewing one ${label} from a Design Repository. A requirement states a NEED — do NOT judge whether the need is "good", "worth doing", or well-written prose. Do NOT invent missing fields beyond the objective ones listed below.

Find issues in these categories ONLY:
- **conflicting** — this requirement directly contradicts a sibling requirement, or contradicts a design element that is supposed to implement it (see neighbors).
- **inconsistent** — this requirement uses a term, value, or definition that disagrees with how a sibling requirement or an implementing element uses it.
- **missing** — ONLY for objectively required fields: a functional requirement with no description or no acceptance_criteria; a non-functional requirement with no measurable_target.

Output strictly as JSON (no Markdown, no prose):
{
  "findings": [
    { "severity": "low|med|high", "category": "conflicting|inconsistent|missing",
      "field_name": "field_key_or_null", "description": "...", "suggested_action": "..." }
  ]
}
If you find nothing, return { "findings": [] }. Be specific — name the sibling requirement slug or implementing element slug that conflicts.`);

  parts.push('');
  parts.push(`# Requirement under review`);
  parts.push('```json');
  parts.push(JSON.stringify(entity, null, 2));
  parts.push('```');
  parts.push('');
  parts.push(`# Neighbors — sibling requirements (Tier-A conflicts) and implementing design elements (Tier-B conflicts)`);
  parts.push('```json');
  parts.push(JSON.stringify(neighbors || {}, null, 2));
  parts.push('```');
  return parts.join('\n');
}

function extractFindings(rawText) {
  // Try to find a JSON object in the response. Be forgiving of code fences.
  let text = (rawText || '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  // Find the first { ... } block
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return [];
  const slice = text.slice(start, end + 1);
  let parsed;
  try { parsed = JSON.parse(slice); }
  catch { return []; }
  const arr = Array.isArray(parsed.findings) ? parsed.findings : [];
  return arr.filter(f => f && typeof f === 'object').map(f => ({
    severity:        SEVERITIES.includes(f.severity) ? f.severity : 'med',
    category:        CATEGORIES.includes(f.category) ? f.category : 'incomplete',
    field_name:      (typeof f.field_name === 'string' && f.field_name.trim() !== '') ? f.field_name.trim() : null,
    description:     String(f.description || '').trim(),
    suggested_action:String(f.suggested_action || '').trim(),
  })).filter(f => f.description !== '');
}

async function claudeReview(entityType, entity, neighbors, opts = {}) {
  const client = getClient();
  const model = aiConfig.resolveModel('quality_reviewer');

  let userPrompt;
  if (REQUIREMENT_TYPES.has(entityType)) {
    // Requirements: conflict + objective-gap mode (no best-practice quality judgment).
    userPrompt = buildRequirementReviewPrompt(entityType, entity, neighbors);
  } else {
    // Derived elements: full validity review against design best practices.
    const scopes = [entityType];
    if (entityType === 'agent' || entityType === 'agent_spec') { scopes.push('agent', 'agent_spec'); }
    const bestPractices = aiConfig.getActiveBestPractices(scopes);
    userPrompt = buildClaudeReviewPrompt(entityType, entity, neighbors, { ...opts, bestPractices });
  }

  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: userPrompt }],
  });
  // Cost parity with the ingest pipeline — best-effort, never throws.
  aiConfig.logUsage({ projectId: opts.projectId, source: 'quality_review', refId: opts.refId, model, usage: response.usage });
  const text = (response.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');
  return extractFindings(text);
}

// ── Public: review one entity ────────────────────────────────────────────────
/**
 * Review one entity + its immediate neighbors.
 * @returns {Promise<{ findings:Array, model:string, source:'claude'|'stub' }>}
 */
async function reviewEntity({ projectId, entityType, entityId, db }) {
  const loaded = loadEntityWithNeighbors(db, entityType, entityId);
  if (!loaded) {
    return { findings: [], model: 'n/a', source: 'stub', error: 'entity not found' };
  }
  const { entity, neighbors } = loaded;

  if (!hasKey()) {
    return { findings: stubReview(entityType, entity, neighbors), model: 'stub', source: 'stub' };
  }
  try {
    const findings = await claudeReview(entityType, entity, neighbors, { projectId, refId: entityId });
    return { findings, model: aiConfig.resolveModel('quality_reviewer'), source: 'claude' };
  } catch (err) {
    console.error('[quality-reviewer] Claude call failed, falling back to stub:', err.message);
    return { findings: stubReview(entityType, entity, neighbors), model: 'stub', source: 'stub', error: err.message };
  }
}

// ── Public: review whole Application ─────────────────────────────────────────
/**
 * Review every Tier-1 entity in the Application. Runs the same per-entity
 * loop above; one Claude call per entity. Returns combined results.
 */
async function reviewApplication({ projectId, db }) {
  const targets = [];
  for (const r of db.prepare(`SELECT use_case_id FROM asdlc_use_case WHERE project_id = ?`).all(projectId)) {
    targets.push({ entityType: 'use_case', entityId: r.use_case_id });
  }
  for (const r of db.prepare(`SELECT workflow_id FROM asdlc_workflow WHERE project_id = ?`).all(projectId)) {
    targets.push({ entityType: 'workflow', entityId: r.workflow_id });
  }
  for (const r of db.prepare(`SELECT agent_spec_id FROM asdlc_agent_spec WHERE project_id = ?`).all(projectId)) {
    targets.push({ entityType: 'agent', entityId: r.agent_spec_id });
  }
  for (const r of db.prepare(`SELECT tool_id FROM asdlc_tool WHERE project_id = ?`).all(projectId)) {
    targets.push({ entityType: 'tool', entityId: r.tool_id });
  }
  // Requirements + workflow steps — previously never audited by any path.
  for (const r of db.prepare(`SELECT fr_id FROM asdlc_functional_req WHERE project_id = ? AND status != 'deleted'`).all(projectId)) {
    targets.push({ entityType: 'functional_req', entityId: r.fr_id });
  }
  for (const r of db.prepare(`SELECT nfr_id FROM asdlc_nonfunctional_req WHERE project_id = ? AND status != 'deleted'`).all(projectId)) {
    targets.push({ entityType: 'nonfunctional_req', entityId: r.nfr_id });
  }
  for (const r of db.prepare(`SELECT workflow_step_id FROM asdlc_workflow_step WHERE project_id = ? AND (lifecycle_status IS NULL OR lifecycle_status != 'retired')`).all(projectId)) {
    targets.push({ entityType: 'workflow_step', entityId: r.workflow_step_id });
  }

  const allFindings = [];
  const byEntity = [];
  let sourceSeen = 'stub';
  let modelSeen = 'stub';

  for (const t of targets) {
    const res = await reviewEntity({ projectId, entityType: t.entityType, entityId: t.entityId, db });
    if (res.source === 'claude') { sourceSeen = 'claude'; modelSeen = res.model; }
    // Apply right away so dedupe works correctly across the whole sweep
    applyFindings(db, projectId, t.entityType, t.entityId, res.findings);
    allFindings.push(...res.findings.map(f => ({ ...f, entity_type: t.entityType, entity_id: t.entityId })));
    byEntity.push({ entity_type: t.entityType, entity_id: t.entityId, count: res.findings.length });
  }

  const bySeverity = { low: 0, med: 0, high: 0 };
  for (const f of allFindings) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;

  return { findings: allFindings, by_entity: byEntity, by_severity: bySeverity, model: modelSeen, source: sourceSeen };
}

// ── Upsert + stale-close findings ────────────────────────────────────────────
/**
 * Persist findings for one (entity, project). Upserts by
 * (project, entity, field, category, status=open, detected_by='quality-reviewer')
 * and marks any prior open finding on this entity that's NOT in the new set
 * as resolved="auto: fixed in re-review".
 *
 * @returns {{ inserted:number, updated:number, resolved:number }}
 */
function applyFindings(db, projectId, entityType, entityId, findings) {
  const now = new Date().toISOString();
  let inserted = 0, updated = 0, resolved = 0;

  // 1) Load existing open quality-reviewer findings for this entity
  const existing = db.prepare(
    `SELECT exception_id, field_name, finding_category
       FROM asdlc_exception
      WHERE project_id = ?
        AND related_entity_id = ?
        AND detected_by = 'quality-reviewer'
        AND status = 'open'`
  ).all(projectId, entityId);

  // Build a lookup key → exception_id of existing open findings
  const keyOf = (f, c) => `${f || ''}::${c}`;
  const existingMap = new Map();
  for (const ex of existing) existingMap.set(keyOf(ex.field_name, ex.finding_category), ex.exception_id);

  // Track which existing rows we touched (so we can resolve the rest)
  const touched = new Set();

  const upsertFind = db.prepare(`SELECT exception_id FROM asdlc_exception
     WHERE project_id = ?
       AND related_entity_id = ?
       AND COALESCE(field_name,'') = COALESCE(?, '')
       AND finding_category = ?
       AND detected_by = 'quality-reviewer'
       AND status = 'open'
     LIMIT 1`);

  const upsertUpd = db.prepare(`UPDATE asdlc_exception
       SET description = ?, severity = ?, suggested_action = ?, updated_at = ?
     WHERE exception_id = ?`);

  const upsertIns = db.prepare(`INSERT INTO asdlc_exception
       (exception_id, project_id, exception_type, severity, description,
        related_entity_type, related_entity_id, suggested_action, status,
        detected_by, field_name, finding_category,
        created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', 'quality-reviewer', ?, ?, 'quality-reviewer', ?, ?)`);

  for (const f of findings) {
    const hit = upsertFind.get(projectId, entityId, f.field_name || null, f.category);
    if (hit) {
      upsertUpd.run(f.description, f.severity, f.suggested_action || null, now, hit.exception_id);
      touched.add(hit.exception_id);
      updated++;
    } else {
      const id = randomUUID();
      upsertIns.run(
        id,
        projectId,
        f.category,             // exception_type mirrors category for legacy filtering
        f.severity,
        f.description,
        entityType,
        entityId,
        f.suggested_action || null,
        f.field_name || null,
        f.category,
        now,
        now
      );
      touched.add(id);
      inserted++;
    }
  }

  // 2) Any existing open finding NOT touched this round = fixed; mark resolved
  const resolveStmt = db.prepare(`UPDATE asdlc_exception
       SET status = 'resolved',
           resolution_summary = 'auto: fixed in re-review',
           updated_at = ?
     WHERE exception_id = ?`);
  for (const ex of existing) {
    if (!touched.has(ex.exception_id)) {
      resolveStmt.run(now, ex.exception_id);
      resolved++;
    }
  }

  return { inserted, updated, resolved };
}

module.exports = {
  reviewEntity,
  reviewApplication,
  applyFindings,
  // exported for tests / debugging
  _internal: { stubReview, loadEntityWithNeighbors, extractFindings },
};
