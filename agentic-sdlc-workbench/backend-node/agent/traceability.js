// agent/traceability.js
//
// AI inference of requirement → design-element traceability links.
//
//   inferLinks({ projectId, db }) → { links, model, source, usage }
//
// `links` is an array of { req_slug, entity_type, entity_slug, confidence,
// rationale }. The caller resolves slugs to ids and inserts proposed rows into
// asdlc_requirement_link. Used by the POST /traceability/infer backfill endpoint
// to seed links for designs that predate AI-populated linking (or where the
// ingest pass couldn't resolve a slug).
//
// When ANTHROPIC_API_KEY is missing, a no-op stub runs (returns no links) so
// local dev still works without spending tokens.
'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const aiConfig = require('./ai-config');

const MAX_TOKENS = 4096;
const ENTITY_TYPES = ['workflow', 'workflow_step', 'agent_spec', 'tool'];

let _client;
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}
function hasKey() {
  const k = process.env.ANTHROPIC_API_KEY;
  return !!k && k.trim() !== '' && k !== 'paste-your-anthropic-key-here' && k !== 'your_anthropic_api_key_here';
}

// ── Load a compact inventory of requirements + derived elements ────────────────
function loadInventory(db, projectId) {
  const frs = db.prepare(
    "SELECT slug, title, description FROM asdlc_functional_req WHERE project_id=? AND status!='deleted' AND slug IS NOT NULL"
  ).all(projectId);
  const nfrs = db.prepare(
    "SELECT slug, title, description, measurable_target FROM asdlc_nonfunctional_req WHERE project_id=? AND status!='deleted' AND slug IS NOT NULL"
  ).all(projectId);
  const workflows = db.prepare(
    "SELECT slug, name FROM asdlc_workflow WHERE project_id=? AND (lifecycle_status IS NULL OR lifecycle_status!='retired') AND slug IS NOT NULL"
  ).all(projectId);
  const steps = db.prepare(
    "SELECT slug, name FROM asdlc_workflow_step WHERE project_id=? AND (lifecycle_status IS NULL OR lifecycle_status!='retired') AND slug IS NOT NULL"
  ).all(projectId);
  const agents = db.prepare(
    "SELECT slug, name, scope FROM asdlc_agent_spec WHERE project_id=? AND (lifecycle_status IS NULL OR lifecycle_status!='retired') AND slug IS NOT NULL"
  ).all(projectId);
  const tools = db.prepare(
    "SELECT slug, name FROM asdlc_tool WHERE project_id=? AND (lifecycle_status IS NULL OR lifecycle_status!='retired') AND slug IS NOT NULL"
  ).all(projectId);
  return { frs, nfrs, workflows, steps, agents, tools };
}

function buildPrompt(inv) {
  const reqLines = [
    ...inv.frs.map(r => `  ${r.slug} (functional) — ${r.title}: ${String(r.description || '').slice(0, 200)}`),
    ...inv.nfrs.map(r => `  ${r.slug} (nonfunctional) — ${r.title} [target: ${r.measurable_target || 'n/a'}]: ${String(r.description || '').slice(0, 160)}`),
  ].join('\n');
  const elemLines = [
    ...inv.workflows.map(e => `  ${e.slug} (workflow) — ${e.name}`),
    ...inv.steps.map(e => `  ${e.slug} (workflow_step) — ${e.name}`),
    ...inv.agents.map(e => `  ${e.slug} (agent_spec) — ${e.name}: ${String(e.scope || '').slice(0, 120)}`),
    ...inv.tools.map(e => `  ${e.slug} (tool) — ${e.name}`),
  ].join('\n');

  return `You are a requirements-traceability analyst. Below are the REQUIREMENTS (FR/NFR) and the DESIGN ELEMENTS (workflows, workflow steps, agents, tools) of one application. Identify which design element **implements or satisfies** which requirement.

Only assert a link when the element clearly contributes to fulfilling the requirement. Do NOT link everything to everything — precision matters more than coverage. If you are unsure, omit the link.

Output STRICTLY as JSON (no prose, no markdown):
{
  "links": [
    { "req_slug": "FR-003", "entity_type": "agent_spec", "entity_slug": "AG-002",
      "confidence": 0.0, "rationale": "one short sentence" }
  ]
}
entity_type must be one of: ${ENTITY_TYPES.join(', ')}. req_slug and entity_slug must be slugs that appear below.

# REQUIREMENTS
${reqLines || '  (none)'}

# DESIGN ELEMENTS
${elemLines || '  (none)'}`;
}

function extractLinks(rawText) {
  let text = (rawText || '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return [];
  let parsed;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { return []; }
  const arr = Array.isArray(parsed.links) ? parsed.links : [];
  return arr
    .filter(l => l && typeof l === 'object' && l.req_slug && l.entity_slug && ENTITY_TYPES.includes(l.entity_type))
    .map(l => ({
      req_slug: String(l.req_slug).trim(),
      entity_type: l.entity_type,
      entity_slug: String(l.entity_slug).trim(),
      confidence: (typeof l.confidence === 'number') ? l.confidence : null,
      rationale: String(l.rationale || '').trim(),
    }));
}

/** Infer traceability links for a whole project. Never throws. */
async function inferLinks({ projectId, db }) {
  const inv = loadInventory(db, projectId);
  const reqCount = inv.frs.length + inv.nfrs.length;
  const elemCount = inv.workflows.length + inv.steps.length + inv.agents.length + inv.tools.length;
  if (reqCount === 0 || elemCount === 0) {
    return { links: [], model: 'n/a', source: 'stub' };
  }
  if (!hasKey()) {
    return { links: [], model: 'stub', source: 'stub' };
  }
  try {
    const model = aiConfig.resolveModel('quality_reviewer');
    const response = await getClient().messages.create({
      model,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: buildPrompt(inv) }],
    });
    const text = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    aiConfig.logUsage({ projectId, source: 'traceability_infer', refId: projectId, model, usage: response.usage });
    return { links: extractLinks(text), model, source: 'claude', usage: response.usage };
  } catch (err) {
    console.error('[traceability] inference failed:', err.message);
    return { links: [], model: 'stub', source: 'stub', error: err.message };
  }
}

module.exports = { inferLinks, _internal: { loadInventory, buildPrompt, extractLinks } };
