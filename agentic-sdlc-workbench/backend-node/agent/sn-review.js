// agent/sn-review.js
// ─────────────────────────────────────────────────────────────────────────────
// Phase E — the INDEPENDENT REVIEWER (third Opus reasoning role).
//
// Audits each reconciliation proposal from Phase D, in a FRESH context with an
// adversarial framing ("assume the proposal may be wrong"). It exists to catch the
// reconciler's mistakes — most importantly a change that would modify/shrink/blank
// populated Workbench content but slipped through mislabeled as safe. The reviewer
// can only make the decision SAFER: approve (genuinely additive + well-supported),
// downgrade_to_hitl (any doubt, or any touch of populated content), or reject
// (hallucinated/unsupported). It can never make a conflict auto-applyable.
//
// Only `changed` proposals get the adversarial Opus pass (where the risk is);
// `new`/`drift` pass through (deterministic, low risk) — the cost tiering. Cached
// static prefix + adaptive thinking. Stub mode when no ANTHROPIC_API_KEY.
'use strict';
const Anthropic = require('@anthropic-ai/sdk');
const aiConfig = require('./ai-config');
const { withWiki } = require('./wiki-context');
const { loadCanonical, canonicalForPrompt, editContextLines } = require('./sn-reconcile');

let _client;
function getClient() {
  if (_client !== undefined) return _client;
  _client = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
  return _client;
}

const SYSTEM_PROMPT = [
  'You are an INDEPENDENT, adversarial reviewer. Another agent produced a proposal for merging a design',
  'reverse-engineered from a (lossy, narrower) ServiceNow app into a canonical Workbench record. Assume the',
  'proposal MAY BE WRONG. Your job is to protect the Workbench design and catch the reconciler\'s mistakes.',
  '',
  'Priorities, in order:',
  ' 1. PROTECT POPULATED CONTENT. If ANY proposed change would modify, shrink, or blank a Workbench field that',
  '    already has content, but the proposal is NOT marked destructive (or action is not "conflict"), that is a',
  '    CRITICAL miss. Set destructive_confirmed=true and verdict=downgrade_to_hitl. A purely additive change into',
  '    an EMPTY field (fill_blank) or an append of new list items is acceptable.',
  ' 2. CATCH HALLUCINATIONS. If a proposed value is not actually supported by the ServiceNow inference, flag it',
  '    (issues) and reject or downgrade.',
  ' 3. CATCH MISCLASSIFICATION. e.g. an "enrich" that is really a "conflict"; a confidence that is too high for',
  '    how sparse/ambiguous the evidence is.',
  '',
  'You may only make the decision SAFER — never upgrade a conflict into an auto-applyable change.',
  ' - approve            : every change is genuinely additive (fill_blank/append), well-supported, and no populated content is altered.',
  ' - downgrade_to_hitl  : any doubt, any touch of populated content, or any uncertainty — a human must decide.',
  ' - reject             : the proposal is clearly wrong, hallucinated, or unsupported.',
  '',
  'Set final_confidence (0–1) honestly. List concrete problems in `issues`. Call emit_review exactly once.',
].join('\n');

const EMIT_TOOL = {
  name: 'emit_review',
  description: 'Emit the independent adversarial review of a reconciliation proposal. Call exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      verdict:               { type: 'string', enum: ['approve', 'downgrade_to_hitl', 'reject'] },
      destructive_confirmed: { type: 'boolean', description: 'true if the proposal does in fact modify/shrink/blank populated Workbench content' },
      final_confidence:      { type: 'number', minimum: 0, maximum: 1 },
      issues:                { type: 'array', items: { type: 'string' }, description: 'Concrete problems found (empty if none)' },
      note:                  { type: 'string' },
    },
    required: ['verdict', 'final_confidence'],
  },
};

function stubReview(item) {
  const d = !!(item.proposal && item.proposal.destructive);
  return { verdict: d ? 'downgrade_to_hitl' : 'approve', destructive_confirmed: d,
    final_confidence: (item.proposal && item.proposal.confidence) ?? 0.5, issues: [], note: '[stub] offline', _stub: true };
}

async function reviewChanged(item, ctx) {
  const client = getClient();
  if (!client) return stubReview(item);
  const canonical = (item.wb_table && item.wb_id) ? loadCanonical(item.wb_table, item.wb_id) : null;
  const model = aiConfig.resolveModel('reconcile_reviewer');
  const thinkCfg = aiConfig.getThinkingConfig('reconcile_reviewer');
  const maxTokens = Math.max(aiConfig.getMaxTokens(), 12000);
  const userMsg = [
    'EXISTING Workbench record (the content you must protect):',
    JSON.stringify(canonicalForPrompt(canonical), null, 2),
    ...editContextLines(item),
    '',
    'ServiceNow-inferred candidate:',
    JSON.stringify(item.inferred || {}, null, 2),
    '',
    'Reconciler proposal to audit:',
    JSON.stringify(item.proposal || {}, null, 2),
    '',
    'Audit it adversarially and call emit_review.',
  ].join('\n');
  // Platform-scoped AI Guidance as a SEPARATE uncached system block (keeps SYSTEM_PROMPT cacheable).
  const guidance = aiConfig.getActiveBestPractices(
    item.inferred && item.inferred.design_type ? [item.inferred.design_type] : [],
    aiConfig.getProjectPlatform(ctx.projectId));
  const systemBlocks = [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }];
  if (guidance.length) {
    systemBlocks.push({ type: 'text', text:
      'House rules / platform guidance (apply when auditing):\n' +
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
  aiConfig.logUsage({ projectId: ctx.projectId, source: 'sn_reconcile_review', refId: item.source_sys_id, model, usage: resp.usage });
  aiConfig.logToolCalls('sn_reconcile_review', (resp.content || []).filter(b => b.type === 'tool_use'));
  const tu = (resp.content || []).find(b => b.type === 'tool_use' && b.name === 'emit_review');
  const review = tu ? tu.input : { verdict: 'downgrade_to_hitl', destructive_confirmed: true, final_confidence: 0.2, issues: ['reviewer did not call the tool'], note: '' };
  return { ...review, usage: resp.usage };
}

/**
 * Augment each proposal with an independent `review`. Only `changed` gets the Opus pass.
 *
 * Cooperative cancel (ctx.cancelToken) gates ONLY the about-to-start Opus call (the
 * 'changed' branch) — it must NOT also drop the free, already-decided non-'changed' items
 * (e.g. a 'new' proposal whose reverseEngineer call already completed and was already paid
 * for in an earlier stage). The same cancelToken object is shared across every stage of one
 * run, so by the time review() executes it may already be true from reverseEngineer having
 * been cancelled earlier — checking it unconditionally at the top of this loop would silently
 * discard that already-completed, cost-free work instead of merely refusing to spend MORE.
 * A cancelled 'changed' item is skipped (not pushed to `out`) — it re-surfaces next sync.
 */
async function review(proposals, ctx = {}) {
  const out = [];
  const changedTotal = proposals.filter(p => p.classification === 'changed').length;
  let changedDone = 0;
  for (const p of proposals) {
    let rv;
    if (p.classification === 'changed') {
      if (ctx.cancelToken && ctx.cancelToken.cancelled) continue;   // skip only this Opus call; keep processing free items
      rv = await reviewChanged(p, ctx);
      changedDone++;
      if (ctx.onProgress) ctx.onProgress({ stage: 'review', current: changedDone, total: changedTotal });
    } else {
      rv = { verdict: 'approve', destructive_confirmed: false, final_confidence: (p.proposal && p.proposal.confidence) ?? 0.6, issues: [], note: `${p.classification} — low-risk, not adversarially reviewed` };
    }
    out.push({ ...p, review: rv });
  }
  return out;
}

module.exports = { review, reviewChanged, SYSTEM_PROMPT, EMIT_TOOL };
