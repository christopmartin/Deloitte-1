// agent/ai-config.js
//
// Central resolution of AI model/role config, token pricing, usage logging, and
// best-practice fetching. Backed by global settings (asdlc_app_setting) with env
// var + hardcoded fallbacks so the existing CLAUDE_*_MODEL env vars keep working.
//
'use strict';

const { db, generateId, getSetting } = require('../db');

// ── Model catalog (shown in the Admin AI Settings dropdowns) ──────────────────
const AVAILABLE_MODELS = [
  { id: 'claude-opus-4-8',           label: 'Claude Opus 4.8 (most capable)' },
  { id: 'claude-opus-4-7',           label: 'Claude Opus 4.7' },
  { id: 'claude-sonnet-4-6',         label: 'Claude Sonnet 4.6 (balanced)' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (fast/cheap)' },
];

// ── Approximate USD pricing per 1M tokens (informational cost estimate) ───────
// input / output / cache-read. Unknown models → null cost (tokens still recorded).
const MODEL_PRICING = {
  'claude-opus-4-8':           { in: 15, out: 75, cacheRead: 1.5 },
  'claude-opus-4-7':           { in: 15, out: 75, cacheRead: 1.5 },
  'claude-sonnet-4-6':         { in: 3,  out: 15, cacheRead: 0.3 },
  'claude-haiku-4-5-20251001': { in: 1,  out: 5,  cacheRead: 0.1 },
};

const ROLE_ENV = {
  extraction:       'CLAUDE_EXTRACTION_MODEL',
  quality_reviewer: 'CLAUDE_QUALITY_REVIEWER_MODEL',
  prompt_drafter:   'CLAUDE_PROMPT_DRAFTER_MODEL',
  build_review:     'CLAUDE_BUILD_REVIEW_MODEL',
};
const DEFAULT_MODEL = 'claude-sonnet-4-6';

// ── ServiceNow reconciliation roles (Phase C–E) ──────────────────────────────
// These do the heavy reverse-engineering / reconciliation / review reasoning, so
// they default to Opus + extended thinking ON. All still admin-overridable via
// asdlc_app_setting (`<role>_model`, `<role>_thinking_enabled`, `<role>_thinking_budget`).
const ROLE_DEFAULTS = {
  reverse_engineer:   'claude-opus-4-8',
  reconciler:         'claude-opus-4-8',
  reconcile_reviewer: 'claude-opus-4-8',
};
const ROLE_THINKING_DEFAULT = { reverse_engineer: 'true', reconciler: 'true', reconcile_reviewer: 'true' };
const ROLE_THINKING_BUDGET  = { reverse_engineer: '8000', reconciler: '8000', reconcile_reviewer: '8000' }; // ≥8000 → effort 'high'

/** Resolve the model for a role: setting `<role>_model` → env var → per-role default → global default. */
function resolveModel(role) {
  return getSetting(`${role}_model`, ROLE_DEFAULTS[role] || DEFAULT_MODEL, ROLE_ENV[role]);
}

/** Max output tokens (global setting, default 8192). */
function getMaxTokens() {
  const v = parseInt(getSetting('max_tokens', '8192'), 10);
  return Number.isFinite(v) && v > 0 ? v : 8192;
}

/**
 * Extended-thinking config for a role.
 * Returns null when disabled, otherwise an object shaped for the model generation:
 *   Claude 3.x → { thinking: { type:'enabled', budget_tokens }, outputConfig: null }
 *   Claude 4.x → { thinking: { type:'adaptive' }, outputConfig: { effort:'high' } }
 * The caller must spread both onto the API request.
 */
function getThinkingConfig(role = 'extraction') {
  const enabled = String(getSetting(`${role}_thinking_enabled`, ROLE_THINKING_DEFAULT[role] || 'false')) === 'true';
  if (!enabled) return null;
  const model = resolveModel(role);
  // Claude 4 models: 'claude-opus-4-*', 'claude-sonnet-4-*', 'claude-haiku-4-*'
  const isClaude4 = /^claude-[a-z]+-4[-.]/.test(model);
  if (isClaude4) {
    // Map budget tiers to effort levels: <4k→low, <8k→medium, else high
    let budget = parseInt(getSetting(`${role}_thinking_budget`, ROLE_THINKING_BUDGET[role] || '4000'), 10);
    if (!Number.isFinite(budget) || budget < 1024) budget = 4000;
    const effort = budget < 4000 ? 'low' : budget < 8000 ? 'medium' : 'high';
    return { thinking: { type: 'adaptive' }, outputConfig: { effort } };
  }
  // Claude 3.x
  let budget = parseInt(getSetting(`${role}_thinking_budget`, '4000'), 10);
  if (!Number.isFinite(budget) || budget < 1024) budget = 4000;
  return { thinking: { type: 'enabled', budget_tokens: budget }, outputConfig: null };
}

/** Compute an estimated USD cost from an Anthropic usage object. */
function estimateCost(model, usage) {
  const p = MODEL_PRICING[model];
  if (!p || !usage) return null;
  const inTok    = (usage.input_tokens || 0);
  const outTok   = (usage.output_tokens || 0);
  const cacheR   = (usage.cache_read_input_tokens || 0);
  const cacheW   = (usage.cache_creation_input_tokens || 0);
  return (
    (inTok  * p.in)        / 1e6 +
    (outTok * p.out)       / 1e6 +
    (cacheR * p.cacheRead) / 1e6 +
    (cacheW * p.in * 1.25) / 1e6
  );
}

/**
 * Record one AI run's token usage. Never throws.
 * @param {object} o {projectId, source, refId, model, round, usage}
 */
function logUsage(o) {
  try {
    const u = o.usage || {};
    const cost = estimateCost(o.model, u);
    db.prepare(`
      INSERT INTO asdlc_ai_usage
        (usage_id, project_id, source, ref_id, model, round,
         input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
         cost_usd, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
    `).run(
      generateId(), o.projectId || null, o.source || 'unknown', o.refId || null,
      o.model || null, o.round ?? null,
      u.input_tokens || 0, u.output_tokens || 0,
      u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0,
      cost
    );
    return cost;
  } catch (err) {
    console.error('[ai-config] logUsage failed:', err.message);
    return null;
  }
}

/**
 * Active best-practice rules to inject into a prompt. Returns global rules plus
 * any whose scope matches one of the given entity types. Never throws.
 * @param {string[]} [entityScopes]
 */
function getActiveBestPractices(entityScopes = []) {
  try {
    const rows = db.prepare(
      "SELECT title, rule_text, scope FROM asdlc_best_practice WHERE is_active = 1 ORDER BY sort_order, created_at"
    ).all();
    return rows.filter(r => r.scope === 'global' || entityScopes.includes(r.scope));
  } catch {
    return [];
  }
}

module.exports = {
  AVAILABLE_MODELS,
  MODEL_PRICING,
  resolveModel,
  getMaxTokens,
  getThinkingConfig,
  estimateCost,
  logUsage,
  getActiveBestPractices,
};
