// agent/sn-discovery-planner.js
// ─────────────────────────────────────────────────────────────────────────────
// Requirements-driven ServiceNow discovery planner.
//
// Replaces the human's manual "tick which surfaces to import" step with an AI planner:
// reads the project's requirements plus the target scope's REAL inventory (assessment
// census + a whole-scope sys_metadata sweep + sys_db_object table names, each flagged
// curated-rich vs generic, with a reference-relationship graph read from THIS instance's
// data dictionary) and proposes a FOCUSED import slice — which tables to pull and why,
// tied to specific requirements, PLUS related/supporting tables needed to make the
// design whole. A human reviews/approves the plan before anything is captured.
//
// One AI call, structurally cloned from sn-reverse-engineer.js's reverseEngineerOne —
// same client, model resolution, wiki injection, and usage logging.
//
// Stub mode (no ANTHROPIC_API_KEY): deterministic — every curated table with records>0
// is included (relation 'direct'), plus any table it references in the graph that isn't
// already included (relation 'related'), all at confidence 0.5. Keeps the pipeline
// testable offline / for free, same convention as the reverse-engineer stub.
'use strict';
const Anthropic = require('@anthropic-ai/sdk');
const aiConfig = require('./ai-config');
const { withWiki } = require('./wiki-context');

let _client;
function getClient() {
  if (_client !== undefined) return _client;
  _client = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
  return _client;
}

// ── Static, cache-friendly system guidance (byte-identical across all calls) ──
const PLANNER_SYSTEM_PROMPT = [
  'You are a senior ServiceNow solution architect deciding WHICH ServiceNow tables to import into a',
  'design tool (the Workbench), given a set of business requirements and the REAL inventory of a',
  'target ServiceNow application scope.',
  '',
  'Your job has two parts:',
  ' 1. DIRECT — for each requirement, identify which table(s) it is actually about (e.g. a requirement',
  '    about "the incident approval catalog item" points at a specific sc_cat_item-backed surface).',
  ' 2. RELATED — ServiceNow records rarely stand alone. Using both (a) the reference-relationship graph',
  '    below (this instance\'s REAL foreign-key-style references between tables) and (b) your knowledge',
  '    of how ServiceNow standardly structures records (a catalog item has variables and a fulfillment',
  '    workflow; a table has columns; a business rule runs against a table; a flow has action steps),',
  '    identify SUPPORTING tables needed to make the imported design whole — even when no requirement',
  '    names them directly. Tag these relation="related" with related_to naming the table that pulled',
  '    them in.',
  '',
  'Be focused, not exhaustive: only include a table when a requirement needs it (direct) or a direct',
  'inclusion genuinely depends on it for a complete picture (related). Do not include tables with zero',
  'records. Do not include ServiceNow system/audit plumbing tables. If a requirement does not map to',
  'anything in the inventory, say so in notes rather than guessing.',
  '',
  'Clarifications vs notes: use `clarifications` ONLY for a genuine fork you are not confident enough',
  'to resolve alone — a real ambiguity where a human\'s answer would change which table(s) you pick.',
  'These become real questions the human answers before you get another look. Use `notes` for caveats',
  'that do not need an answer (e.g. a requirement that maps to nothing in the inventory). Most plans',
  'should raise zero clarifications — reserve them for cases that actually warrant a human decision.',
  '',
  'Call the emit_import_plan tool exactly once with your analysis. Do not write a prose reply.',
].join('\n');

// ── Single structured-output tool the model calls with its plan ───────────────
const EMIT_TOOL = {
  name: 'emit_import_plan',
  description: 'Emit the proposed focused import plan for this ServiceNow scope. Call exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      include: {
        type: 'array',
        description: 'Tables to import.',
        items: {
          type: 'object',
          properties: {
            table: { type: 'string', description: 'Exact ServiceNow table name from the inventory' },
            design_type_if_curated: { type: ['string', 'null'], description: 'The inventory\'s design_type for this table, if it is curated-rich; null for a generic table' },
            relation: { type: 'string', enum: ['direct', 'related'], description: '"direct" if a requirement names/needs this table; "related" if pulled in only to complete the picture' },
            related_to: { type: ['string', 'null'], description: 'For relation="related", the table that depends on this one; null for "direct"' },
            rationale: { type: 'string', description: 'Why this table is needed, in plain language' },
            mapped_requirement_slugs: { type: 'array', items: { type: 'string' }, description: 'Requirement slugs (e.g. FR-003) this table serves; empty for a purely related/supporting table' },
            confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Honest confidence (0-1) that this table belongs in the import' },
            record_filter: { type: 'string', description: 'Optional encoded ServiceNow query fragment to narrow this surface further (leave empty to import all in-scope records)' },
          },
          required: ['table', 'relation', 'rationale', 'confidence'],
        },
      },
      exclude: {
        type: 'array',
        description: 'Notable tables from the inventory deliberately left out, with why.',
        items: {
          type: 'object',
          properties: {
            table: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['table', 'reason'],
        },
      },
      notes: { type: 'string', description: 'Any caveats — e.g. a requirement that maps to nothing in the inventory' },
      clarifications: {
        type: 'array',
        description: 'Genuine ambiguities you were not confident enough to resolve alone. Empty if your plan above is your confident best answer.',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The question to ask the human' },
            context: { type: 'string', description: 'Why this is ambiguous / what would resolve it' },
            related_tables: { type: 'array', items: { type: 'string' }, description: 'The table(s) this question concerns' },
          },
          required: ['question'],
        },
      },
    },
    required: ['include'],
  },
};

/** Render one inventory table row for the prompt. */
function inventoryLine(t) {
  const kind = t.kind === 'generic' ? 'generic' : 'curated-rich';
  const dt = t.design_type ? ` design_type=${t.design_type}` : '';
  const recs = (t.records == null) ? 'records=?' : `records=${t.records}`;
  return `  - ${t.table} | ${kind}${dt} | ${recs}`;
}

/** Render the reference-graph edges for one table (its own references + who references it). */
function referenceLines(table, edges) {
  const out = (edges || []).filter(e => e.from_table === table)
    .map(e => `      ${table}.${e.field} -> ${e.to_table}`);
  const inbound = (edges || []).filter(e => e.to_table === table)
    .map(e => `      ${e.from_table}.${e.field} -> ${table}`);
  return [...out, ...inbound];
}

function buildPlanUserMessage({ requirements, inventory, scope, pastDiscoveryQA }) {
  const lines = [`ServiceNow scope: ${scope || '(unspecified)'}`, ''];
  lines.push(`Requirements (${(requirements || []).length}):`);
  if (!requirements || !requirements.length) {
    lines.push('  (none recorded for this project yet)');
  } else {
    for (const r of requirements) lines.push(`  - [${r.req_type === 'nonfunctional' ? 'NFR' : 'FR'}] ${r.slug}: ${r.text}`);
  }
  lines.push('');
  const tables = (inventory && inventory.tables) || [];
  lines.push(`Scope inventory (${tables.length} table(s) with records):`);
  for (const t of tables) {
    lines.push(inventoryLine(t));
    const refs = referenceLines(t.table, inventory && inventory.edges);
    if (refs.length) lines.push(...refs);
  }
  if (!tables.length) lines.push('  (no tables with records found in this scope)');
  // Placed in the (per-call-varying) user message, not the byte-identical, cache-tagged
  // system prompt — a prior clarification round's answers, if any, refine this call's plan.
  if (Array.isArray(pastDiscoveryQA) && pastDiscoveryQA.length) {
    lines.push('', `A human already answered ${pastDiscoveryQA.length} of your prior clarifying question(s) — use these answers:`);
    for (const qa of pastDiscoveryQA) lines.push(`  - Q: ${qa.question}\n    A: ${qa.answer}`);
  }
  lines.push('', 'Identify the focused import plan and call emit_import_plan.');
  return lines.join('\n');
}

/**
 * Merge the assessment census (curated-rich tables + record counts), the whole-scope
 * sys_metadata sweep (generic classes not already curated), and any custom business-data
 * tables (sys_db_object rows outside the curated catalog) into ONE inventory the planner
 * reasons over. Pure — all I/O happens before this is called. Zero-record tables are
 * dropped (nothing to import). `edges` (from readReferenceGraph) is attached as-is.
 * @param {{report:object, sweep:object, customTables:Array, edges:Array, scope:string}} opts
 * @returns {{scope:string|null, tables:Array, edges:Array}}
 */
function buildDiscoveryInventory({ report, sweep, customTables, edges, scope } = {}) {
  const tables = [];
  const seen = new Set();
  const scopeReports = (report && report.scope_reports) || [];
  const scopeReport = scopeReports.find(sr => sr.scope === scope) || scopeReports[0] || null;
  for (const s of (scopeReport && scopeReport.surfaces) || []) {
    if (!s.present || !s.count) continue;
    tables.push({ table: s.table, kind: 'curated-rich', design_type: s.wbDesignType || null, records: s.count });
    seen.add(s.table);
  }
  if (sweep && sweep.available) {
    for (const [cls, count] of Object.entries(sweep.byClass || {})) {
      if (!count || seen.has(cls)) continue;
      tables.push({ table: cls, kind: 'generic', design_type: null, records: count });
      seen.add(cls);
    }
  }
  for (const t of (customTables || [])) {
    if (!t || !t.table || seen.has(t.table)) continue;
    tables.push({ table: t.table, kind: 'generic', design_type: null, records: t.records, label: t.label || null });
    seen.add(t.table);
  }
  return { scope: scope || null, tables, edges: Array.isArray(edges) ? edges : [] };
}

/** Deterministic offline plan — every curated table with records, plus its direct references. */
function stubPlan({ inventory }) {
  const tables = (inventory && inventory.tables) || [];
  const edges = (inventory && inventory.edges) || [];
  const included = new Set();
  const include = [];
  for (const t of tables) {
    if (t.kind !== 'curated-rich' || !t.records) continue;
    included.add(t.table);
    include.push({
      table: t.table, design_type_if_curated: t.design_type || null,
      relation: 'direct', related_to: null,
      rationale: '[stub] curated surface with records in scope',
      mapped_requirement_slugs: [], confidence: 0.5,
    });
  }
  for (const t of [...included]) {
    for (const e of edges) {
      if (e.from_table !== t || included.has(e.to_table)) continue;
      const target = tables.find(x => x.table === e.to_table);
      if (!target || !target.records) continue;
      included.add(e.to_table);
      include.push({
        table: e.to_table, design_type_if_curated: target.design_type || null,
        relation: 'related', related_to: t,
        rationale: `[stub] referenced by ${t}.${e.field}`,
        mapped_requirement_slugs: [], confidence: 0.5,
      });
    }
  }
  return { include, exclude: [], notes: '[stub — no ANTHROPIC_API_KEY; offline deterministic plan]', clarifications: [], _stub: true };
}

/**
 * Generate a requirements-driven import plan for one ServiceNow scope.
 * @param {{requirements:Array, inventory:object, scope:string}} input
 * @param {object} ctx {projectId}
 * @returns {Promise<{plan:object, usage?:object, model?:string, stub?:boolean}>}
 */
async function planDiscovery(input, ctx = {}) {
  const client = getClient();
  if (!client) return { plan: stubPlan(input), stub: true };

  const model = aiConfig.resolveModel('discovery_planner');
  const thinkCfg = aiConfig.getThinkingConfig('discovery_planner');
  const maxTokens = Math.max(aiConfig.getMaxTokens(), 12000);

  const guidance = aiConfig.getActiveBestPractices([], aiConfig.getProjectPlatform(ctx.projectId));
  const systemBlocks = [{ type: 'text', text: PLANNER_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }];
  if (guidance.length) {
    systemBlocks.push({ type: 'text', text:
      'House rules / platform guidance (FOLLOW THESE):\n' +
      guidance.map(b => `  - ${b.title ? b.title + ': ' : ''}${b.rule_text}`).join('\n') });
  }

  const req = {
    model,
    max_tokens: maxTokens,
    system: withWiki(systemBlocks),
    tools: [EMIT_TOOL],
    // The API rejects a forced tool_choice while extended thinking is enabled — same
    // convention as sn-reverse-engineer.js.
    tool_choice: thinkCfg ? { type: 'auto' } : { type: 'tool', name: EMIT_TOOL.name },
    messages: [{ role: 'user', content: buildPlanUserMessage(input) }],
  };
  if (thinkCfg) { req.thinking = thinkCfg.thinking; if (thinkCfg.outputConfig) req.output_config = thinkCfg.outputConfig; }

  const resp = await client.messages.create(req);
  aiConfig.logUsage({ projectId: ctx.projectId, source: 'sn_discovery_planner', refId: input.scope || null, model, usage: resp.usage });
  aiConfig.logToolCalls('sn_discovery_planner', (resp.content || []).filter(b => b.type === 'tool_use'));

  const tu = (resp.content || []).find(b => b.type === 'tool_use' && b.name === EMIT_TOOL.name);
  const plan = tu ? { include: tu.input.include || [], exclude: tu.input.exclude || [], notes: tu.input.notes || '', clarifications: tu.input.clarifications || [] }
                  : { ...stubPlan(input), notes: 'model did not call emit_import_plan — deterministic fallback used', _unparsed: true };
  return { plan, usage: resp.usage, model };
}

module.exports = { planDiscovery, buildPlanUserMessage, buildDiscoveryInventory, stubPlan, EMIT_TOOL, PLANNER_SYSTEM_PROMPT };
