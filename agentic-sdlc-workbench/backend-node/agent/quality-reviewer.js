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

const MODEL      = process.env.CLAUDE_QUALITY_REVIEWER_MODEL || 'claude-sonnet-4-6';
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

// Dispatcher
function loadEntityWithNeighbors(db, entityType, entityId) {
  switch (entityType) {
    case 'agent':
    case 'agent_spec': {
      const entity = loadAgent(db, entityId);
      if (!entity) return null;
      return { entity, neighbors: loadAgentNeighbors(db, entity) };
    }
    case 'use_case': {
      const entity = loadUseCase(db, entityId);
      if (!entity) return null;
      return { entity, neighbors: loadUseCaseNeighbors(db, entity) };
    }
    case 'workflow': {
      const entity = loadWorkflow(db, entityId);
      if (!entity) return null;
      return { entity, neighbors: loadWorkflowNeighbors(db, entity) };
    }
    case 'tool': {
      const entity = loadTool(db, entityId);
      if (!entity) return null;
      return { entity, neighbors: loadToolNeighbors(db, entity) };
    }
    default:
      return null;
  }
}

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

  if (opts.extraGuidance) {
    parts.push('');
    parts.push(opts.extraGuidance);
  }

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

async function claudeReview(entityType, entity, neighbors, opts) {
  const client = getClient();
  const userPrompt = buildClaudeReviewPrompt(entityType, entity, neighbors, opts);
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: userPrompt }],
  });
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
    const findings = await claudeReview(entityType, entity, neighbors);
    return { findings, model: MODEL, source: 'claude' };
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
