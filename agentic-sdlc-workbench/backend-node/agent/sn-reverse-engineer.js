// agent/sn-reverse-engineer.js
// ─────────────────────────────────────────────────────────────────────────────
// Phase C — the REVERSE-ENGINEERING agent (first of the three Opus reasoning roles).
//
// Reads a single ServiceNow implementation artifact (an agent, a business rule's
// script, a flow, a table, etc.) and INFERS the functional design intent it
// represents, in business terms — what capability it implements, how it behaves,
// what it relates to. Output is a structured "candidate design" that Phase D
// (reconcile) then compares against the canonical Workbench design.
//
// Claude Opus 4.x + adaptive extended thinking (this is deliberate inference, the
// task thinking is built for). The large static guidance + the output-tool schema
// are IDENTICAL across every per-artifact call, so they carry a `cache_control`
// breakpoint — after the first call, subsequent artifacts read the cached prefix
// (~0.1× cost) instead of re-billing it. Verified via usage.cache_read_input_tokens
// (ai-config.logUsage records it). Provenance is never emitted by the model.
//
// Stub mode (no ANTHROPIC_API_KEY): returns a deterministic skeleton so the
// plumbing is testable offline / for free.
'use strict';
const Anthropic = require('@anthropic-ai/sdk');
const aiConfig = require('./ai-config');

let _client;
function getClient() {
  if (_client !== undefined) return _client;
  _client = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
  return _client;
}

const DESIGN_TYPES = ['data_model', 'form_design', 'business_logic', 'catalog_item', 'agent_spec', 'tool', 'workflow', 'use_case', 'other'];

// ── Static, cache-friendly system guidance (byte-identical across all calls) ──
const SYSTEM_PROMPT = [
  'You are a senior ServiceNow + business-analysis expert performing REVERSE ENGINEERING.',
  'You are given ONE artifact extracted from a live ServiceNow application — it may be an AI agent,',
  'a business rule (with its script), a client script, a script include, a UI action, a UI policy, a',
  'form/view, a catalog item, a flow, or a database table with its columns.',
  '',
  'Your job: read the IMPLEMENTATION and infer the FUNCTIONAL DESIGN it represents — i.e. translate',
  'low-level configuration/code UP into the business intent a non-technical stakeholder would recognise.',
  'Explain what business capability it serves, what it does in plain English, when it runs/applies, and',
  'which other artifacts it depends on or relates to. For scripts, state the business rule the code',
  'encodes (e.g. "when a flight becomes Delayed, notify the assigned gate agent"), not a line-by-line summary.',
  '',
  'This feeds a downstream reconciliation step that merges your inference into a richer canonical design,',
  'NON-DESTRUCTIVELY. Two consequences for you:',
  ' 1. ServiceNow is a LOSSY, narrower view than the canonical design. Do NOT assume the artifact is the',
  '    whole story — infer only what the implementation actually supports. Never fabricate detail that is',
  '    not evidenced by the artifact.',
  ' 2. Calibrate `confidence` honestly (0–1). High (>0.85) only when the artifact unambiguously implies the',
  '    inference; lower it when you are guessing intent from sparse config, ambiguous names, or partial code.',
  '    Put what you are unsure about in `rationale`.',
  '',
  'Map the artifact to the closest Workbench design type:',
  ' - data_model      : a database table + its fields (sys_db_object / dictionary)',
  ' - form_design     : a form/view layout or UI policy behaviour (sys_ui_form / sys_ui_policy)',
  ' - business_logic  : server/client logic — business rule, client script, script include, UI action, scheduled job',
  ' - catalog_item    : a Service Catalog item / record producer',
  ' - agent_spec      : an AI agent (sn_aia_agent) — its role, instructions, guardrails',
  ' - tool            : a capability/integration an agent or process calls',
  ' - workflow        : a flow / multi-step process (sys_hub_flow)',
  ' - use_case        : a business use case / objective the app serves',
  ' - other           : none of the above',
  '',
  'Call the emit_inferred_design tool exactly once with your analysis. Do not write a prose reply.',
].join('\n');

// ── Single structured-output tool the model calls with its inference ──────────
const EMIT_TOOL = {
  name: 'emit_inferred_design',
  description: 'Emit the inferred functional design for the given ServiceNow artifact. Call exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      design_type: { type: 'string', enum: DESIGN_TYPES, description: 'Closest Workbench design type for this artifact' },
      name:        { type: 'string', description: 'Business-facing name for the inferred design element' },
      purpose:     { type: 'string', description: 'The business capability / intent this implements, in business terms' },
      behavior:    { type: 'string', description: 'What it does, in plain English (for logic: when it runs + what it does)' },
      key_details: { type: 'array', items: { type: 'string' }, description: 'Salient business-level details (fields, variables, conditions, steps)' },
      relates_to:  { type: 'array', items: { type: 'string' }, description: 'Names of other artifacts this depends on or relates to' },
      confidence:  { type: 'number', minimum: 0, maximum: 1, description: 'Honest confidence in this inference (0–1)' },
      rationale:   { type: 'string', description: 'Why this classification/inference, and what you are uncertain about' },
    },
    required: ['design_type', 'name', 'purpose', 'confidence'],
  },
};

function userMessageFor(artifact) {
  const lines = [
    `ServiceNow artifact to reverse-engineer:`,
    `- source table: ${artifact.source_table || '(unknown)'}`,
    `- name: ${artifact.name || '(unnamed)'}`,
  ];
  const salient = artifact.salient || {};
  for (const [k, v] of Object.entries(salient)) {
    if (v == null || v === '') continue;
    lines.push(`- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  if (artifact.source_fluent) lines.push(`\nFluent source:\n${artifact.source_fluent}`);
  lines.push('\nInfer the functional design and call emit_inferred_design.');
  return lines.join('\n');
}

// Offline deterministic skeleton (no API key) — keeps the pipeline testable for free.
function stubInference(artifact) {
  const map = { sys_aia_agent: 'agent_spec', sn_aia_agent: 'agent_spec', sn_aia_tool: 'tool', sn_aia_usecase: 'use_case',
    sys_db_object: 'data_model', sys_ui_form: 'form_design', sc_cat_item: 'catalog_item', sys_hub_flow: 'workflow',
    sys_script: 'business_logic', sys_script_client: 'business_logic', sys_script_include: 'business_logic' };
  return {
    design_type: map[artifact.source_table] || 'other',
    name: artifact.name || '(unnamed)',
    purpose: `[stub] inferred from ${artifact.source_table || 'unknown'} "${artifact.name || ''}"`,
    behavior: '[stub — no ANTHROPIC_API_KEY; offline skeleton]',
    key_details: Object.keys(artifact.salient || {}),
    relates_to: [],
    confidence: 0.5,
    rationale: '[stub] deterministic offline inference',
    _stub: true,
  };
}

function parseFallback(resp) {
  const text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const m = text && text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
  return { design_type: 'other', name: '(unparsed)', purpose: text.slice(0, 200), confidence: 0.2, rationale: 'model did not call the tool', _unparsed: true };
}

/** Reverse-engineer ONE artifact → { source_sys_id, inferred, usage?, stub? }. */
async function reverseEngineerOne(artifact, ctx = {}) {
  const client = getClient();
  if (!client) return { source_sys_id: artifact.source_sys_id, inferred: stubInference(artifact), stub: true };

  const model = aiConfig.resolveModel('reverse_engineer');
  const thinkCfg = aiConfig.getThinkingConfig('reverse_engineer');
  const maxTokens = Math.max(aiConfig.getMaxTokens(), 12000); // headroom for adaptive thinking; < 16k so no streaming needed

  const req = {
    model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }], // cached prefix (tools render before system → both cached)
    tools: [EMIT_TOOL],
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: userMessageFor(artifact) }],
  };
  if (thinkCfg) { req.thinking = thinkCfg.thinking; if (thinkCfg.outputConfig) req.output_config = thinkCfg.outputConfig; }

  const resp = await client.messages.create(req);
  aiConfig.logUsage({ projectId: ctx.projectId, source: 'sn_reverse_engineer', refId: artifact.source_sys_id, model, usage: resp.usage });

  const tu = (resp.content || []).find(b => b.type === 'tool_use' && b.name === 'emit_inferred_design');
  const inferred = tu ? tu.input : parseFallback(resp);
  return { source_sys_id: artifact.source_sys_id, inferred, usage: resp.usage, model };
}

/** Reverse-engineer many artifacts (sequential so the cache warms on call 1, then reads). */
async function reverseEngineer(artifacts, ctx = {}) {
  const results = [];
  for (const a of artifacts) results.push(await reverseEngineerOne(a, ctx));
  return results;
}

module.exports = { reverseEngineer, reverseEngineerOne, SYSTEM_PROMPT, EMIT_TOOL, DESIGN_TYPES };
