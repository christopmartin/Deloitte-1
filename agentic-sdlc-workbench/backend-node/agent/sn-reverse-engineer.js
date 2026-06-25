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
const registry = require('./entity-registry');
const { withWiki } = require('./wiki-context');

let _client;
function getClient() {
  if (_client !== undefined) return _client;
  _client = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
  return _client;
}

const DESIGN_TYPES = ['data_model', 'form_design', 'business_logic', 'catalog_item', 'agent_spec', 'tool', 'workflow', 'use_case', 'dashboard', 'report', 'kpi', 'sla_definition', 'email_notification', 'user_group', 'catalog_category', 'choice_set', 'service_portal', 'workspace', 'variable_set', 'inbound_rest_api', 'other'];

// ServiceNow source table → Workbench design type. We reverse-engineer by reusing the SAME
// forward extract_* tool for that type, so a round-tripped design reaches the same Level-1
// richness a BRD-authored one does (one shared L1 contract for both directions).
const SN_TABLE_TO_TYPE = {
  sn_aia_agent: 'agent_spec', sn_aia_usecase: 'use_case', sn_aia_tool: 'tool',
  sys_db_object: 'data_model', sys_ui_form: 'form_design', sys_ui_policy: 'form_design',
  sc_cat_item: 'catalog_item', sys_hub_flow: 'workflow',
  sys_script: 'business_logic', sys_script_client: 'business_logic',
  sys_script_include: 'business_logic', sys_ui_action: 'business_logic',
  // Config-driven Information Layer entities (reverse-engineer via the same forward extract_* tool)
  par_dashboard: 'dashboard', sys_report: 'report', pa_indicator: 'kpi',
  // Wave 2 flat config entities
  contract_sla: 'sla_definition', sysevent_email_action: 'email_notification',
  sys_user_group: 'user_group', sc_category: 'catalog_category', sys_choice: 'choice_set',
  // Wave 3 nested entities
  sp_portal: 'service_portal', sys_ux_page_registry: 'workspace',
  item_option_new_set: 'variable_set', sys_ws_definition: 'inbound_rest_api',
};
// For business_logic, the SN table also tells us the logic_type deterministically.
const SN_TABLE_TO_LOGIC_TYPE = {
  sys_script: 'business_rule', sys_script_client: 'client_script',
  sys_script_include: 'script_include', sys_ui_action: 'ui_action',
};

// Forward extraction tools indexed by name (L2 provenance already stripped by buildApiTools).
let _forwardToolsByName = null;
function forwardTool(designType) {
  if (!_forwardToolsByName) {
    _forwardToolsByName = {};
    for (const t of registry.buildApiTools()) _forwardToolsByName[t.name] = t;
  }
  return _forwardToolsByName[`extract_${designType}`] || null;
}

// Prompt for the forward-tool reverse path: infer the FULL Level-1 design from the artifact.
const REVERSE_SYSTEM_PROMPT = [
  'You are reverse-engineering ONE artifact from a live ServiceNow application into the Workbench\'s',
  'business-level (Level-1) design. Call the provided extract_* tool exactly once and fill EVERY field the',
  'artifact actually evidences — e.g. a table\'s columns → data_model.fields; a form\'s layout → form_design.sections;',
  'a script\'s logic → business_logic.plain_english / when_runs / conditions; a tool\'s signature → inputs / outputs / errors.',
  'Infer ONLY what the implementation supports — never fabricate detail not evidenced by the artifact. ServiceNow is a',
  'lossy, narrower view, so leaving a field empty when the artifact does not evidence it is correct. Set confidence (0–1)',
  'honestly. Do NOT emit any source_* / provenance fields — those are set deterministically. Do not write a prose reply.',
].join('\n');

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

// Minimal per-type Level-1 entity_data — used by the offline stub and as a floor. Mirrors the
// historic thin mapping so behaviour is unchanged without an API key.
function stubEntityData(designType, name, purpose, behavior, artifact) {
  const desc = [purpose, behavior].filter(Boolean).join('\n\n') || name;
  switch (designType) {
    case 'use_case':       return { title: name, summary: purpose || name, business_objective: behavior };
    case 'workflow':       return { name, trigger: { description: behavior || purpose || 'See ServiceNow source' } };
    case 'agent_spec':     return { name, scope: purpose || name, instructions: behavior };
    case 'tool':           return { name, contract: desc };
    case 'data_model':     return { name, purpose: desc };
    case 'form_design':    return { name, behavior_notes: desc };
    case 'business_logic': return { name, logic_type: SN_TABLE_TO_LOGIC_TYPE[artifact.source_table] || 'business_rule', plain_english: desc };
    case 'catalog_item':   return { name, short_description: purpose || name };
    default:               return null;
  }
}

// Offline deterministic skeleton (no API key) — keeps the pipeline testable for free.
function stubInference(artifact) {
  const designType = SN_TABLE_TO_TYPE[artifact.source_table] || 'other';
  const name = artifact.name || '(unnamed)';
  const purpose = `[stub] inferred from ${artifact.source_table || 'unknown'} "${name}"`;
  const behavior = '[stub — no ANTHROPIC_API_KEY; offline skeleton]';
  return {
    design_type: designType, name, purpose, behavior,
    key_details: Object.keys(artifact.salient || {}), relates_to: [],
    confidence: 0.5, rationale: '[stub] deterministic offline inference', _stub: true,
    entity_data: stubEntityData(designType, name, purpose, behavior, artifact),
  };
}

// Convert a forward extract_* tool's output into the inferred envelope (kept for reconcile / review /
// materiality) PLUS the rich `entity_data` that materializes the Level-1 record. Strips meta + any
// provenance the model shouldn't set; derives business_logic.logic_type from the SN source table.
function buildInferred(designType, input, artifact) {
  const entity_data = { ...input };
  for (const k of ['operation', 'target_slug', 'conflict_classification', 'conflict_rationale',
    'confidence', 'confidence_notes', 'system_generated', 'implements_requirements',
    'source_system', 'source_sys_id', 'source_table', 'source_scope', 'source_fluent', 'source_hash']) {
    delete entity_data[k];
  }
  if (designType === 'business_logic' && !entity_data.logic_type) {
    entity_data.logic_type = SN_TABLE_TO_LOGIC_TYPE[artifact.source_table] || 'business_rule';
  }
  const name = entity_data.name || entity_data.title || entity_data.source_name || entity_data.rule_name || artifact.name || '(unnamed)';
  const trig = entity_data.trigger && typeof entity_data.trigger === 'object' ? entity_data.trigger : {};
  return {
    design_type: designType,
    name,
    purpose: entity_data.summary || entity_data.purpose || entity_data.scope || entity_data.short_description || name,
    behavior: entity_data.plain_english || entity_data.behavior_notes || entity_data.description || entity_data.instructions || trig.description || '',
    key_details: Array.isArray(entity_data.fields) ? entity_data.fields.map(f => f.label || f).filter(Boolean).slice(0, 12)
      : Array.isArray(entity_data.variables) ? entity_data.variables.map(v => v.label || v).filter(Boolean).slice(0, 12)
      : [],
    relates_to: [],
    confidence: typeof input.confidence === 'number' ? input.confidence : 0.7,
    rationale: input.confidence_notes || '',
    entity_data,
  };
}

function parseFallback(resp) {
  const text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const m = text && text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
  return { design_type: 'other', name: '(unparsed)', purpose: text.slice(0, 200), confidence: 0.2, rationale: 'model did not call the tool', _unparsed: true };
}

/** Reverse-engineer ONE artifact → { source_sys_id, inferred, usage?, stub? }.
 *  Reuses the forward extract_<type> tool so the inferred design carries the FULL Level-1 field
 *  set (not a 1–2 field skeleton). Falls back to the offline stub with no API key / unknown type. */
async function reverseEngineerOne(artifact, ctx = {}) {
  const client = getClient();
  const designType = SN_TABLE_TO_TYPE[artifact.source_table] || 'other';
  const tool = designType !== 'other' ? forwardTool(designType) : null;
  if (!client || !tool) return { source_sys_id: artifact.source_sys_id, inferred: stubInference(artifact), stub: !client };

  const model = aiConfig.resolveModel('reverse_engineer');
  const thinkCfg = aiConfig.getThinkingConfig('reverse_engineer');
  const maxTokens = Math.max(aiConfig.getMaxTokens(), 12000); // headroom for adaptive thinking; < 16k so no streaming needed

  // Platform-scoped AI Guidance, injected as a SEPARATE uncached system block so the
  // byte-identical REVERSE_SYSTEM_PROMPT above stays prompt-cacheable across calls.
  const guidance = aiConfig.getActiveBestPractices([designType], aiConfig.getProjectPlatform(ctx.projectId));
  const systemBlocks = [{ type: 'text', text: REVERSE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }];
  if (guidance.length) {
    systemBlocks.push({ type: 'text', text:
      'House rules / platform guidance (FOLLOW THESE):\n' +
      guidance.map(b => `  - ${b.title ? b.title + ': ' : ''}${b.rule_text}`).join('\n') });
  }

  const req = {
    model,
    max_tokens: maxTokens,
    system: withWiki(systemBlocks),
    tools: [tool],
    // The API rejects a forced tool_choice while extended thinking is enabled
    // ("Thinking may not be enabled when tool_choice forces tool use"). When thinking
    // is on we use 'auto' (the single tool + prompt still reliably elicits the call,
    // same as the reconcile/review stages); when off we force the tool for a
    // guaranteed structured emit.
    tool_choice: thinkCfg ? { type: 'auto' } : { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content: userMessageFor(artifact) }],
  };
  if (thinkCfg) { req.thinking = thinkCfg.thinking; if (thinkCfg.outputConfig) req.output_config = thinkCfg.outputConfig; }

  const resp = await client.messages.create(req);
  aiConfig.logUsage({ projectId: ctx.projectId, source: 'sn_reverse_engineer', refId: artifact.source_sys_id, model, usage: resp.usage });
  aiConfig.logToolCalls('sn_reverse_engineer', (resp.content || []).filter(b => b.type === 'tool_use'));

  const tu = (resp.content || []).find(b => b.type === 'tool_use' && b.name === tool.name);
  const inferred = tu ? buildInferred(designType, tu.input, artifact) : stubInference(artifact);
  return { source_sys_id: artifact.source_sys_id, inferred, usage: resp.usage, model };
}

/** Reverse-engineer many artifacts (sequential so the cache warms on call 1, then reads). */
async function reverseEngineer(artifacts, ctx = {}) {
  const results = [];
  for (const a of artifacts) results.push(await reverseEngineerOne(a, ctx));
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// NL-rule reverse engineering (Workbench differentiator)
// Reads an implementation script (sys_script business rule, or similar) and emits a
// PLAIN-ENGLISH candidate rule for PO review — never code. Reuses the same client /
// model / wiki / logging machinery; a focused tool + prompt are the only differences.
// ─────────────────────────────────────────────────────────────────────────────
const NL_RULE_TOOL = {
  name: 'emit_nl_rule',
  description: 'Emit ONE plain-English rule that captures the business intent of the implementation. Never restate code.',
  input_schema: {
    type: 'object',
    properties: {
      name:         { type: 'string', description: 'Short descriptive name for the rule' },
      rule_text:    { type: 'string', description: 'The rule in plain English, e.g. "When an invoice exceeds £10,000 it must be approved by a manager before payment." No code, no field/API names unless essential.' },
      linked_table: { type: 'string', description: 'Business label or table the rule applies to, if evident' },
      linked_field: { type: 'string', description: 'Field the rule concerns, for a validation rule, if evident' },
      rationale:    { type: 'string', description: 'Why this rule exists / what the code is enforcing' },
      confidence:   { type: 'number', minimum: 0, maximum: 1, description: 'Honest confidence (0–1) that this captures the true intent' },
    },
    required: ['name', 'rule_text', 'confidence'],
  },
};

const NL_RULE_SYSTEM_PROMPT = [
  'You are reverse-engineering a ServiceNow implementation artifact (typically a business rule script)',
  'into ONE plain-English business rule a non-technical product owner would recognise and could have',
  'authored before any code existed. Read the script/config and state the POLICY it enforces — the',
  '"when X then Y" intent — NOT a line-by-line summary and NOT any code. If the script only touches',
  'system/audit plumbing (timestamps, logging, sys_updated) with no business policy, say so in rationale',
  'and set a low confidence. Call emit_nl_rule exactly once. Do not write a prose reply.',
].join('\n');

/** Reverse-engineer ONE script artifact → a candidate NL rule object (or a stub offline).
 *  @param artifact { source_table, source_sys_id, name, salient } — salient should carry the script + context.
 *  @returns { source_sys_id, rule: { name, rule_text, linked_table?, linked_field?, rationale?, confidence }, usage?, stub? } */
async function reverseEngineerNlRule(artifact, ctx = {}) {
  const client = getClient();
  if (!client) {
    return {
      source_sys_id: artifact.source_sys_id,
      stub: true,
      rule: {
        name: `[stub] ${artifact.name || 'rule'}`,
        rule_text: `[stub — no ANTHROPIC_API_KEY] Intent inferred from ${artifact.source_table || 'script'} "${artifact.name || ''}".`,
        rationale: '[stub] deterministic offline inference',
        confidence: 0.5,
      },
    };
  }

  const model = aiConfig.resolveModel('reverse_engineer');
  const thinkCfg = aiConfig.getThinkingConfig('reverse_engineer');
  const maxTokens = Math.max(aiConfig.getMaxTokens(), 12000);

  const guidance = aiConfig.getActiveBestPractices(['business_logic'], aiConfig.getProjectPlatform(ctx.projectId));
  const systemBlocks = [{ type: 'text', text: NL_RULE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }];
  if (guidance.length) {
    systemBlocks.push({ type: 'text', text:
      'House rules / platform guidance (FOLLOW THESE):\n' +
      guidance.map(b => `  - ${b.title ? b.title + ': ' : ''}${b.rule_text}`).join('\n') });
  }

  const req = {
    model,
    max_tokens: maxTokens,
    system: withWiki(systemBlocks),
    tools: [NL_RULE_TOOL],
    tool_choice: thinkCfg ? { type: 'auto' } : { type: 'tool', name: NL_RULE_TOOL.name },
    messages: [{ role: 'user', content: userMessageFor(artifact) }],
  };
  if (thinkCfg) { req.thinking = thinkCfg.thinking; if (thinkCfg.outputConfig) req.output_config = thinkCfg.outputConfig; }

  const resp = await client.messages.create(req);
  aiConfig.logUsage({ projectId: ctx.projectId, source: 'sn_reverse_engineer_nl_rule', refId: artifact.source_sys_id, model, usage: resp.usage });
  aiConfig.logToolCalls('sn_reverse_engineer_nl_rule', (resp.content || []).filter(b => b.type === 'tool_use'));

  const tu = (resp.content || []).find(b => b.type === 'tool_use' && b.name === NL_RULE_TOOL.name);
  const input = tu ? tu.input : parseFallback(resp);
  const rule = {
    name: input.name || artifact.name || '(unnamed rule)',
    rule_text: input.rule_text || '',
    linked_table: input.linked_table || '',
    linked_field: input.linked_field || '',
    rationale: input.rationale || '',
    confidence: typeof input.confidence === 'number' ? input.confidence : 0.6,
  };
  return { source_sys_id: artifact.source_sys_id, rule, usage: resp.usage, model };
}

module.exports = { reverseEngineer, reverseEngineerOne, reverseEngineerNlRule, buildInferred, stubInference, SN_TABLE_TO_TYPE, SN_TABLE_TO_LOGIC_TYPE, SYSTEM_PROMPT, EMIT_TOOL, NL_RULE_TOOL, DESIGN_TYPES };
