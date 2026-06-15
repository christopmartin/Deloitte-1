// agent/sn-reconcile.js
// ─────────────────────────────────────────────────────────────────────────────
// Phase D — the RECONCILER (second Opus reasoning role).
//
// Takes the reverse-engineered candidate design (Phase C) for each captured
// artifact, plus the deterministic tier-0 classification (Phase B), and decides
// — NON-DESTRUCTIVELY — what should change in the canonical Workbench design:
//
//   changed → load the FULL canonical Workbench record and ask Opus to reconcile
//             the (lossy) ServiceNow inference against it. Opus proposes only
//             additive / fill-blank / append changes as safe; anything that would
//             modify or shrink populated content is marked destructive (→ HITL).
//   new     → deterministic "create" proposal (net-new in ServiceNow).
//   drift   → deterministic "flag_drift" (in Workbench, absent from SN) — NEVER a delete.
//
// HARD RULE (matches the Phase-A guard): never propose blanking/shrinking populated
// Workbench fields. ServiceNow is the lossy/narrower side; the Workbench record is
// the source of truth for richness. The reconciler PROPOSES + classifies + flags;
// the gate (Phase F) decides apply-vs-HITL. Opus is spent only on `changed` items
// (where judgment is needed); new/drift are deterministic (the cost tiering).
//
// Cached static prefix (methodology + tool schema) + adaptive thinking. Stub mode
// when no ANTHROPIC_API_KEY.
'use strict';
const Anthropic = require('@anthropic-ai/sdk');
const aiConfig = require('./ai-config');
const { withWiki } = require('./wiki-context');
const { db } = require('../db');
const { WB_PROVENANCE_TABLES } = require('./sn-capture');

const PK_BY_TABLE = {};
WB_PROVENANCE_TABLES.forEach(t => { PK_BY_TABLE[t.table] = t.pk; });

let _client;
function getClient() {
  if (_client !== undefined) return _client;
  _client = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
  return _client;
}

const SYSTEM_PROMPT = [
  'You are reconciling a design that was REVERSE-ENGINEERED from a live ServiceNow app against the',
  'EXISTING canonical record in a Workbench design repository. You decide what (if anything) should change',
  'in the Workbench — non-destructively.',
  '',
  'Critical context:',
  ' - ServiceNow is a LOSSY, NARROWER view. The Workbench record is the source of truth for richness — it',
  '   often contains detail (prose, steps, fields, related elements) that never made it into ServiceNow.',
  ' - Therefore "the ServiceNow inference is shorter/has less" is EXPECTED and is NOT a reason to change anything.',
  '',
  'HARD RULE — NON-DESTRUCTIVE. You must NEVER propose blanking or shrinking a populated Workbench field, and',
  'you must NEVER propose deleting anything. If ServiceNow genuinely changed something that conflicts with or',
  'would overwrite populated Workbench content, classify it as a CONFLICT for human review — do not silently apply it.',
  '',
  'Classify the reconciliation with `action`:',
  ' - no_change : the ServiceNow inference is consistent with the Workbench record (or merely a lossy subset). Nothing to do.',
  ' - enrich    : ServiceNow contributes genuinely NEW information that is purely additive — filling an EMPTY Workbench',
  '               field (change_kind=fill_blank) or appending new items to a list (change_kind=append). Safe to apply.',
  ' - conflict  : ServiceNow contradicts the Workbench, OR a change would modify/shrink a populated field',
  '               (change_kind=modify). Requires human review. Set destructive=true.',
  '',
  'For every proposed field change include change_kind (fill_blank | append | modify). Set top-level `destructive`',
  'to true if ANY change_kind is modify (or would otherwise reduce populated content). Calibrate `confidence` (0–1)',
  'honestly — lower it when the inference is sparse or the match is uncertain.',
  '',
  'Call emit_reconciliation exactly once. Do not write a prose reply.',
].join('\n');

const EMIT_TOOL = {
  name: 'emit_reconciliation',
  description: 'Emit the non-destructive reconciliation decision for one ServiceNow-vs-Workbench element. Call exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      action:     { type: 'string', enum: ['no_change', 'enrich', 'conflict'] },
      field_changes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            field:       { type: 'string' },
            change_kind: { type: 'string', enum: ['fill_blank', 'append', 'modify'] },
            proposed:    { type: 'string', description: 'Proposed new/added value, summarized' },
            rationale:   { type: 'string' },
          },
          required: ['field', 'change_kind'],
        },
      },
      destructive: { type: 'boolean', description: 'true if ANY change would modify or shrink populated Workbench content' },
      confidence:  { type: 'number', minimum: 0, maximum: 1 },
      rationale:   { type: 'string' },
    },
    required: ['action', 'destructive', 'confidence'],
  },
};

const HIDDEN_COLS = ['source_system', 'source_sys_id', 'source_table', 'source_scope', 'source_fluent', 'source_hash',
  'created_by', 'created_at', 'updated_by', 'updated_at', 'version', 'visibility_scope', 'project_id', 'lifecycle_status'];

function loadCanonical(wbTable, wbId) {
  const pk = PK_BY_TABLE[wbTable];
  if (!pk) return null;
  try { return db.prepare(`SELECT * FROM ${wbTable} WHERE ${pk} = ?`).get(wbId) || null; } catch { return null; }
}
function canonicalForPrompt(row) {
  if (!row) return {};
  const o = { ...row };
  for (const k of HIDDEN_COLS) delete o[k];
  return o;
}

function stubProposal(item) {
  return {
    source_sys_id: item.source_sys_id, wb_table: item.wb_table, wb_id: item.wb_id, classification: 'changed',
    proposal: { action: 'no_change', destructive: false, confidence: 0.5, field_changes: [], rationale: '[stub] offline — no reconciliation performed', _stub: true },
  };
}

async function reconcileChanged(item, ctx) {
  const client = getClient();
  const canonical = loadCanonical(item.wb_table, item.wb_id);
  if (!client) return stubProposal(item);

  const model = aiConfig.resolveModel('reconciler');
  const thinkCfg = aiConfig.getThinkingConfig('reconciler');
  const maxTokens = Math.max(aiConfig.getMaxTokens(), 12000);
  const userMsg = [
    'EXISTING Workbench record (canonical — may be richer than ServiceNow):',
    JSON.stringify(canonicalForPrompt(canonical), null, 2),
    '',
    'INFERRED from the current ServiceNow artifact (Phase C reverse-engineering):',
    JSON.stringify(item.inferred || {}, null, 2),
    '',
    'Decide the non-destructive reconciliation and call emit_reconciliation.',
  ].join('\n');

  // Platform-scoped AI Guidance as a SEPARATE uncached system block (keeps SYSTEM_PROMPT cacheable).
  const guidance = aiConfig.getActiveBestPractices(
    item.inferred && item.inferred.design_type ? [item.inferred.design_type] : [],
    aiConfig.getProjectPlatform(ctx.projectId));
  const systemBlocks = [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }];
  if (guidance.length) {
    systemBlocks.push({ type: 'text', text:
      'House rules / platform guidance (FOLLOW THESE):\n' +
      guidance.map(b => `  - ${b.title ? b.title + ': ' : ''}${b.rule_text}`).join('\n') });
  }
  const req = {
    model, max_tokens: maxTokens,
    system: withWiki(systemBlocks),
    tools: [EMIT_TOOL], tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: userMsg }],
  };
  if (thinkCfg) { req.thinking = thinkCfg.thinking; if (thinkCfg.outputConfig) req.output_config = thinkCfg.outputConfig; }

  const resp = await client.messages.create(req);
  aiConfig.logUsage({ projectId: ctx.projectId, source: 'sn_reconcile', refId: item.source_sys_id, model, usage: resp.usage });
  const tu = (resp.content || []).find(b => b.type === 'tool_use' && b.name === 'emit_reconciliation');
  const proposal = tu ? tu.input : { action: 'conflict', destructive: true, confidence: 0.2, field_changes: [], rationale: 'model did not call the tool' };
  // Safety net: never let a non-destructive action carry a modify change.
  if ((proposal.field_changes || []).some(c => c.change_kind === 'modify')) { proposal.destructive = true; if (proposal.action !== 'conflict') proposal.action = 'conflict'; }
  return { source_sys_id: item.source_sys_id, wb_table: item.wb_table, wb_id: item.wb_id, classification: 'changed', inferred: item.inferred || {}, proposal, usage: resp.usage, model };
}

function reconcileNew(item) {
  const inf = item.inferred || {};
  return {
    source_sys_id: item.source_sys_id, classification: 'new', inferred: inf,
    proposal: { action: 'create', design_type: inf.design_type, name: inf.name, confidence: inf.confidence ?? 0.6, destructive: false,
      rationale: 'Net-new in ServiceNow; not present in the Workbench design.' },
  };
}
function reconcileDrift(d) {
  return {
    source_sys_id: d.source_sys_id, wb_table: d.wb_table, wb_id: d.wb_id, classification: 'drift', inferred: d.inferred || {},
    proposal: { action: 'flag_drift', destructive: false, confidence: 1, name: d.name,
      rationale: 'Present in the Workbench, absent from this ServiceNow capture — flagged for human awareness, NEVER auto-deleted.' },
  };
}

/**
 * Reconcile classified+inferred items into non-destructive proposals.
 * @param {{changed?:Array, new?:Array, drift?:Array}} input — `changed`/`new` items carry {source_sys_id, inferred, wb_table?, wb_id?}
 */
async function reconcile(input = {}, ctx = {}) {
  const proposals = [];
  for (const it of (input.changed || [])) proposals.push(await reconcileChanged(it, ctx));
  for (const it of (input.new || [])) proposals.push(reconcileNew(it));
  for (const d of (input.drift || [])) proposals.push(reconcileDrift(d));
  return proposals;
}

module.exports = { reconcile, reconcileChanged, SYSTEM_PROMPT, EMIT_TOOL, loadCanonical, canonicalForPrompt };
