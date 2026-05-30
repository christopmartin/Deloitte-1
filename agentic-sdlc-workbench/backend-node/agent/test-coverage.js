// agent/test-coverage.js
//
// AI inference of test-case → requirement traceability.
//
//   inferTestLinks({ projectId, db }) → { suggestions, model, source, usage }
//
// `suggestions` is an array of { test_case_id, requirement_slugs:[...] }. The
// caller merges the slugs into asdlc_test_case.requirement_ids. Used by
// POST /test-coverage/infer to seed links for test cases that have none (and to
// enrich partially-linked ones). Matches the requirement_refs the extractor
// already emits, but for test cases created before linking existed or added by hand.
//
// No API key → no-op stub (returns no suggestions) so local dev still works.
'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const aiConfig = require('./ai-config');

const MAX_TOKENS = 4096;

let _client;
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}
function hasKey() {
  const k = process.env.ANTHROPIC_API_KEY;
  return !!k && k.trim() !== '' && k !== 'paste-your-anthropic-key-here' && k !== 'your_anthropic_api_key_here';
}

function parseIds(v) {
  if (Array.isArray(v)) return v;
  try { return JSON.parse(v || '[]'); } catch { return []; }
}

function loadInventory(db, projectId, onlyUnlinked) {
  const frs = db.prepare(
    "SELECT slug, title, description FROM asdlc_functional_req WHERE project_id=? AND status!='deleted' AND slug IS NOT NULL"
  ).all(projectId);
  const nfrs = db.prepare(
    "SELECT slug, title, measurable_target FROM asdlc_nonfunctional_req WHERE project_id=? AND status!='deleted' AND slug IS NOT NULL"
  ).all(projectId);
  let tcs = db.prepare(
    "SELECT test_case_id, title, test_action, expected_result, case_type, requirement_ids FROM asdlc_test_case WHERE project_id=? AND lifecycle_status='active'"
  ).all(projectId);
  if (onlyUnlinked) tcs = tcs.filter(t => parseIds(t.requirement_ids).length === 0);
  return { frs, nfrs, tcs };
}

function buildPrompt(inv) {
  const reqLines = [
    ...inv.frs.map(r => `  ${r.slug} — ${r.title}: ${String(r.description || '').slice(0, 180)}`),
    ...inv.nfrs.map(r => `  ${r.slug} — ${r.title} [target: ${r.measurable_target || 'n/a'}]`),
  ].join('\n');
  const tcLines = inv.tcs.map(t =>
    `  ${t.test_case_id} [${t.case_type}] — ${t.title}: action="${String(t.test_action || '').slice(0, 120)}" expected="${String(t.expected_result || '').slice(0, 120)}"`
  ).join('\n');

  return `You are a test-traceability analyst. Below are the REQUIREMENTS (FR/NFR) and the TEST CASES of one application. For each test case, identify which requirement(s) it validates.

Only assert a link when the test clearly exercises what the requirement specifies. A test may validate several requirements, or none (omit it then). Precision matters more than coverage.

Output STRICTLY as JSON (no prose, no markdown):
{
  "suggestions": [
    { "test_case_id": "<id from the list>", "requirement_slugs": ["FR-003","NFR-001"] }
  ]
}
requirement_slugs must be slugs that appear in the REQUIREMENTS list.

# REQUIREMENTS
${reqLines || '  (none)'}

# TEST CASES
${tcLines || '  (none)'}`;
}

function extractSuggestions(rawText, validTcIds) {
  let text = (rawText || '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return [];
  let parsed;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { return []; }
  const arr = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
  return arr
    .filter(s => s && typeof s === 'object' && s.test_case_id && Array.isArray(s.requirement_slugs))
    .filter(s => validTcIds.has(s.test_case_id))
    .map(s => ({
      test_case_id: s.test_case_id,
      requirement_slugs: s.requirement_slugs.map(x => String(x).trim()).filter(Boolean),
    }))
    .filter(s => s.requirement_slugs.length > 0);
}

/** Infer test→requirement links for a project. Never throws. */
async function inferTestLinks({ projectId, db, onlyUnlinked = true }) {
  const inv = loadInventory(db, projectId, onlyUnlinked);
  if ((inv.frs.length + inv.nfrs.length) === 0 || inv.tcs.length === 0) {
    return { suggestions: [], model: 'n/a', source: 'stub' };
  }
  if (!hasKey()) {
    return { suggestions: [], model: 'stub', source: 'stub' };
  }
  try {
    const model = aiConfig.resolveModel('quality_reviewer');
    const validTcIds = new Set(inv.tcs.map(t => t.test_case_id));
    const response = await getClient().messages.create({
      model,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: buildPrompt(inv) }],
    });
    const txt = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    aiConfig.logUsage({ projectId, source: 'test_coverage_infer', refId: projectId, model, usage: response.usage });
    return { suggestions: extractSuggestions(txt, validTcIds), model, source: 'claude', usage: response.usage };
  } catch (err) {
    console.error('[test-coverage] inference failed:', err.message);
    return { suggestions: [], model: 'stub', source: 'stub', error: err.message };
  }
}

module.exports = { inferTestLinks, _internal: { loadInventory, buildPrompt, extractSuggestions, parseIds } };
