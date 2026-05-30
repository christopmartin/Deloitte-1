// agent/test-generator.js
//
// AI generation of test cases for a design entity (use_case | workflow | agent | tool).
//
//   generateTestCases({ projectId, scope, entityId, db }) → { tests, model, source }
//
// `tests` is an array of { title, test_action, test_input, expected_result,
// case_type, requirement_refs }. The caller inserts them as draft test cases.
// Used (a) automatically at materialize time for newly-created testable entities
// and (b) on demand from the Testing UI to fill coverage gaps (e.g. an agent that
// was ingested without any test scenarios in its source document).
//
// The ingest pipeline only EXTRACTS tests a document describes; this SYNTHESIZES
// coverage for an entity that has none. No API key → a small deterministic
// skeleton (happy + negative) so the flow still works in local dev.
'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const aiConfig = require('./ai-config');

const MAX_TOKENS = 4096;
const CASE_TYPES = ['happy_path', 'edge_case', 'negative', 'regression', 'performance'];

// scope value (test_case.scope) → table + id + display columns.
const SCOPE_META = {
  use_case: { table: 'asdlc_use_case',   idCol: 'use_case_id',   linkType: 'use_case',
              cols: ['title', 'summary', 'business_objective', 'success_criteria', 'constraints_list'] },
  workflow: { table: 'asdlc_workflow',   idCol: 'workflow_id',   linkType: 'workflow',
              cols: ['name', 'trigger_def', 'fallback_paths', 'use_case_id'] },
  agent:    { table: 'asdlc_agent_spec', idCol: 'agent_spec_id', linkType: 'agent_spec',
              cols: ['name', 'scope', 'instructions', 'goals', 'done_criteria', 'design_risks', 'use_case_id'] },
  tool:     { table: 'asdlc_tool',       idCol: 'tool_id',       linkType: 'tool',
              cols: ['name', 'contract', 'errors', 'boundaries', 'access_requirements'] },
};

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

// Load the entity (selected columns) + a candidate requirement list to link to.
function loadContext(db, projectId, scope, entityId) {
  const meta = SCOPE_META[scope];
  if (!meta) return null;
  const row = db.prepare(`SELECT ${meta.cols.join(', ')} FROM ${meta.table} WHERE ${meta.idCol} = ? AND project_id = ?`).get(entityId, projectId);
  if (!row) return null;
  for (const c of meta.cols) row[c] = tryParse(row[c]);

  // Candidate requirements: those linked to this entity (asdlc_requirement_link),
  // plus any requirement on the same use case (so generated tests can cite slugs).
  const reqSlugs = new Map(); // slug → {slug,title}
  const addReq = (table, idCol, ids) => {
    for (const id of ids) {
      const r = db.prepare(`SELECT slug, title FROM ${table} WHERE ${idCol} = ?`).get(id);
      if (r && r.slug) reqSlugs.set(r.slug, { slug: r.slug, title: r.title });
    }
  };
  const links = db.prepare(
    "SELECT req_type, req_id FROM asdlc_requirement_link WHERE entity_type=? AND entity_id=? AND lifecycle_status='active' AND status!='rejected'"
  ).all(meta.linkType, entityId);
  addReq('asdlc_functional_req', 'fr_id', links.filter(l => l.req_type === 'functional').map(l => l.req_id));
  addReq('asdlc_nonfunctional_req', 'nfr_id', links.filter(l => l.req_type === 'nonfunctional').map(l => l.req_id));

  const ucId = row.use_case_id || (scope === 'use_case' ? entityId : null);
  if (ucId) {
    for (const r of db.prepare("SELECT slug, title FROM asdlc_functional_req WHERE use_case_id=? AND status!='deleted' AND slug IS NOT NULL").all(ucId)) reqSlugs.set(r.slug, r);
    for (const r of db.prepare("SELECT slug, title FROM asdlc_nonfunctional_req WHERE use_case_id=? AND status!='deleted' AND slug IS NOT NULL").all(ucId)) reqSlugs.set(r.slug, r);
  }
  return { entity: row, requirements: [...reqSlugs.values()] };
}

function buildPrompt(scope, ctx) {
  const reqLines = ctx.requirements.length
    ? ctx.requirements.map(r => `  ${r.slug} — ${r.title}`).join('\n')
    : '  (none linked yet — leave requirement_refs empty)';
  return `You are a QA engineer designing test coverage for one ${scope.replace('_', ' ')} in an agentic application. Produce a focused set of test cases that together give meaningful coverage across scenario types.

Cover these case types where they make sense: happy_path, edge_case, negative (and regression/performance only if clearly warranted). Aim for 4–6 test cases total — at least one happy_path, one edge_case, and one negative. Each test must be concrete and verifiable (specific action, input, and expected result). Do not invent capabilities the entity does not have.

For each test, set requirement_refs to the slugs (from the list below) that the test validates; use an empty array if none apply.

Output STRICTLY as JSON (no prose, no markdown):
{
  "tests": [
    { "title": "...", "test_action": "...", "test_input": "...", "expected_result": "...",
      "case_type": "happy_path|edge_case|negative|regression|performance", "requirement_refs": ["FR-001"] }
  ]
}

# ${scope.toUpperCase()} UNDER TEST
${JSON.stringify(ctx.entity, null, 2)}

# REQUIREMENTS THIS ENTITY RELATES TO (cite slugs in requirement_refs)
${reqLines}`;
}

function extractTests(rawText) {
  let text = (rawText || '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return [];
  let parsed;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { return []; }
  const arr = Array.isArray(parsed.tests) ? parsed.tests : [];
  return arr
    .filter(t => t && typeof t === 'object' && t.title)
    .map(t => ({
      title: String(t.title).trim(),
      test_action: String(t.test_action || '').trim(),
      test_input: String(t.test_input || '').trim(),
      expected_result: String(t.expected_result || '').trim(),
      case_type: CASE_TYPES.includes(t.case_type) ? t.case_type : 'happy_path',
      requirement_refs: Array.isArray(t.requirement_refs) ? t.requirement_refs.map(s => String(s).trim()).filter(Boolean) : [],
    }))
    .filter(t => t.title);
}

// Deterministic skeleton when no API key — keeps the materialize flow working.
function stubTests(scope, ctx) {
  const name = ctx.entity.name || ctx.entity.title || scope;
  return [
    { title: `Happy path — ${name} performs its primary function`, test_action: `Exercise the main success path of ${name}.`, test_input: 'Valid, in-scope input.', expected_result: 'Produces the expected successful outcome.', case_type: 'happy_path', requirement_refs: [] },
    { title: `Negative — ${name} handles invalid input`, test_action: `Provide malformed or out-of-scope input to ${name}.`, test_input: 'Invalid or unexpected input.', expected_result: 'Fails safely with a clear error / no incorrect action.', case_type: 'negative', requirement_refs: [] },
  ];
}

/** Generate test cases for one entity. Never throws. */
async function generateTestCases({ projectId, scope, entityId, db }) {
  const ctx = loadContext(db, projectId, scope, entityId);
  if (!ctx) return { tests: [], model: 'n/a', source: 'stub', error: 'entity not found' };
  if (!hasKey()) return { tests: stubTests(scope, ctx), model: 'stub', source: 'stub' };
  try {
    const model = aiConfig.resolveModel('quality_reviewer');
    const response = await getClient().messages.create({
      model, max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: buildPrompt(scope, ctx) }],
    });
    const txt = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    aiConfig.logUsage({ projectId, source: 'test_generate', refId: entityId, model, usage: response.usage });
    const tests = extractTests(txt);
    return { tests: tests.length ? tests : stubTests(scope, ctx), model, source: 'claude', usage: response.usage };
  } catch (err) {
    console.error('[test-generator] generation failed:', err.message);
    return { tests: stubTests(scope, ctx), model: 'stub', source: 'stub', error: err.message };
  }
}

module.exports = { generateTestCases, SCOPE_META, _internal: { loadContext, buildPrompt, extractTests, stubTests } };
