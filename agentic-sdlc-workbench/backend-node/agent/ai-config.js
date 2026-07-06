// agent/ai-config.js
//
// Central resolution of AI model/role config, token pricing, usage logging, and
// best-practice fetching. Backed by global settings (asdlc_app_setting) with env
// var + hardcoded fallbacks so the existing CLAUDE_*_MODEL env vars keep working.
//
// Model choices are DATA, not code: the selectable models (ids, display names,
// pricing, thinking behavior) live in model-registry.json, extendable at runtime
// via the 'model_registry_custom' setting (JSON array merged over the file by id).
// Adding a new Claude family = a registry entry, never a call-site edit.
//
'use strict';

const { db, generateId, getSetting } = require('../db');

// ── Model registry (file defaults + optional DB overlay) ─────────────────────
const FILE_REGISTRY = require('./model-registry.json');

// The 11 AI roles ("slots") — every Claude call site resolves through one of these.
const ROLES = [
  'extraction', 'synthesis', 'quality_reviewer', 'prompt_drafter', 'build_review',
  'req_linker', 'rasic_deriver', 'cost_estimate',
  'reverse_engineer', 'reconciler', 'reconcile_reviewer',
];

// Roles whose pipelines actually consume getThinkingConfig() (effort applies).
const THINKING_ROLES = ['extraction', 'synthesis', 'rasic_deriver', 'reverse_engineer', 'reconciler', 'reconcile_reviewer'];

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Tracks whether the last model_registry_custom parse failed (surfaced in validation).
let registryCustomError = null;
const warnedOnce = new Set();
function warnOnce(key, msg) {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  console.error(msg);
}

/**
 * The merged model registry: model-registry.json entries overlaid (by id) with the
 * 'model_registry_custom' setting — a JSON array of partial entries. DB fields win;
 * unmatched ids append; {"id": X, "remove": true} hides an entry. A malformed
 * overlay NEVER breaks resolution — it is ignored with a warning.
 * @returns {Array<object>}
 */
function getRegistry() {
  const byId = new Map();
  for (const m of (FILE_REGISTRY.models || [])) byId.set(m.id, { ...m });
  const raw = getSetting('model_registry_custom', '');
  registryCustomError = null;
  if (raw && String(raw).trim()) {
    try {
      const overlay = JSON.parse(raw);
      if (!Array.isArray(overlay)) throw new Error('must be a JSON array');
      for (const e of overlay) {
        if (!e || typeof e.id !== 'string' || !e.id) continue;
        if (e.remove === true) { byId.delete(e.id); continue; }
        byId.set(e.id, { ...(byId.get(e.id) || {}), ...e });
      }
    } catch (err) {
      registryCustomError = err.message;
      warnOnce('registry_custom', `[ai-config] model_registry_custom is invalid (${err.message}) — using built-in registry only`);
    }
  }
  return [...byId.values()];
}

/** Look up one registry entry by model id. @returns {object|null} */
function getRegistryEntry(modelId) {
  if (!modelId) return null;
  return getRegistry().find(m => m.id === modelId) || null;
}

/** The registry's designated fallback entry (default:true, else DEFAULT_MODEL, else first usable). */
function getDefaultEntry() {
  const reg = getRegistry();
  return reg.find(m => m.default === true && m.status !== 'retired')
      || reg.find(m => m.id === DEFAULT_MODEL && m.status !== 'retired')
      || reg.find(m => m.status !== 'retired')
      || reg[0]
      || { id: DEFAULT_MODEL };
}

const ROLE_ENV = {
  extraction:         'CLAUDE_EXTRACTION_MODEL',
  quality_reviewer:   'CLAUDE_QUALITY_REVIEWER_MODEL',
  prompt_drafter:     'CLAUDE_PROMPT_DRAFTER_MODEL',
  build_review:       'CLAUDE_BUILD_REVIEW_MODEL',
  req_linker:         'CLAUDE_REQ_LINKER_MODEL',
  rasic_deriver:      'CLAUDE_RASIC_DERIVER_MODEL',   // RASIC matrix inference; Sonnet default, Opus configurable
  synthesis:          'CLAUDE_SYNTHESIS_MODEL',       // Opus design-synthesis/enrichment pass (Phase 1)
  cost_estimate:      'CLAUDE_COST_ESTIMATE_MODEL',
  reverse_engineer:   'CLAUDE_REVERSE_ENGINEER_MODEL',
  reconciler:         'CLAUDE_RECONCILER_MODEL',
  reconcile_reviewer: 'CLAUDE_RECONCILE_REVIEWER_MODEL',
};
const DEFAULT_MODEL = 'claude-sonnet-4-6';

// ── ServiceNow reconciliation roles (Phase C–E) ──────────────────────────────
// These do the heavy reverse-engineering / reconciliation / review reasoning, so
// they default to Opus + extended thinking ON. All still admin-overridable via
// asdlc_app_setting (`<role>_model`, `<role>_thinking_effort`, and the legacy
// `<role>_thinking_enabled` / `<role>_thinking_budget` pair).
const ROLE_DEFAULTS = {
  reverse_engineer:   'claude-opus-4-8',
  reconciler:         'claude-opus-4-8',
  reconcile_reviewer: 'claude-opus-4-8',
  req_linker:         'claude-haiku-4-5-20251001',   // lightweight inference; fast + cheap
  synthesis:          'claude-opus-4-8',             // bold design-synthesis/enrichment pass (Phase 1) — most capable
  cost_estimate:      'claude-opus-4-8',             // Now Assist cost estimation; reasoning-heavy → Opus default, admin-overridable
  // rasic_deriver intentionally omitted → falls through to DEFAULT_MODEL (Sonnet).
  // Set rasic_deriver_model in Admin or CLAUDE_RASIC_DERIVER_MODEL env var for Opus.
};
const ROLE_THINKING_DEFAULT = { reverse_engineer: 'true', reconciler: 'true', reconcile_reviewer: 'true', synthesis: 'true' };
const ROLE_THINKING_BUDGET  = { reverse_engineer: '8000', reconciler: '8000', reconcile_reviewer: '8000', synthesis: '8000' }; // ≥8000 → effort 'high'

/**
 * Resolve the model for a role: setting `<role>_model` → env var → per-role default
 * → global default. An id that is unknown to the registry (or retired) resolves to
 * the registry's default entry with a loud once-per-key console.error — never a
 * silent wrong model, never a crash at the API boundary.
 */
function resolveModel(role) {
  const configured = getSetting(`${role}_model`, ROLE_DEFAULTS[role] || DEFAULT_MODEL, ROLE_ENV[role]);
  const entry = getRegistryEntry(configured);
  if (entry && entry.status !== 'retired') return configured;
  const fallback = getDefaultEntry().id;
  warnOnce(`resolve:${role}:${configured}`,
    `[ai-config] ERROR: role "${role}" is configured with ${entry ? 'RETIRED' : 'UNKNOWN'} model "${configured}" — falling back to "${fallback}". ` +
    `Fix it in Admin ▸ AI Settings or add the model to the registry.`);
  return fallback;
}

/** Max output tokens (global setting, default 8192). */
function getMaxTokens() {
  const v = parseInt(getSetting('max_tokens', '8192'), 10);
  return Number.isFinite(v) && v > 0 ? v : 8192;
}

/** Max agentic loops per extraction run (global setting, default 20). */
function getMaxExtractionLoops() {
  const v = parseInt(getSetting('max_extraction_loops', '20'), 10);
  return Number.isFinite(v) && v >= 1 ? v : 20;
}

/**
 * Resolve the thinking effort for a role. Precedence:
 *   1. `<role>_thinking_effort` setting ('off' | low|medium|high|xhigh|max) — authoritative;
 *   2. legacy pair: `<role>_thinking_enabled` (default per ROLE_THINKING_DEFAULT) +
 *      `<role>_thinking_budget` (numeric <4000→low <8000→medium else high; an effort
 *      string maps to itself; junk → medium);
 *   3. off.
 * @returns {string|null} effort level, or null = thinking off
 */
function resolveEffort(role) {
  const explicit = String(getSetting(`${role}_thinking_effort`, '') || '').trim().toLowerCase();
  if (explicit === 'off') return null;
  if (EFFORT_LEVELS.includes(explicit)) return explicit;
  // (an invalid non-empty value falls through to legacy — flagged by validateAiConfig)
  const enabled = String(getSetting(`${role}_thinking_enabled`, ROLE_THINKING_DEFAULT[role] || 'false')) === 'true';
  if (!enabled) return null;
  const rawBudget = String(getSetting(`${role}_thinking_budget`, ROLE_THINKING_BUDGET[role] || '4000')).trim().toLowerCase();
  if (EFFORT_LEVELS.includes(rawBudget)) return rawBudget;  // legacy UI stored the effort word
  const n = parseInt(rawBudget, 10);
  if (!Number.isFinite(n)) return 'medium';
  return n < 4000 ? 'low' : n < 8000 ? 'medium' : 'high';
}

/** Clamp a requested effort to what the model supports (highest supported ≤ requested, else lowest). */
function clampEffort(effort, entry) {
  const supported = entry && Array.isArray(entry.efforts) && entry.efforts.length ? entry.efforts : EFFORT_LEVELS;
  if (supported.includes(effort)) return effort;
  const reqIdx = EFFORT_LEVELS.indexOf(effort);
  for (let i = reqIdx; i >= 0; i--) if (supported.includes(EFFORT_LEVELS[i])) return EFFORT_LEVELS[i];
  return supported[0];
}

/**
 * Extended-thinking config for a role, shaped per the model's registry thinking_style:
 *   adaptive / always_on → { thinking:{type:'adaptive'}, outputConfig:{effort} }
 *   budget (Haiku, 3.x)  → { thinking:{type:'enabled', budget_tokens}, outputConfig:null }
 * Off → null (param omitted), EXCEPT models flagged explicit_off (thinking runs by
 * default there, e.g. Sonnet 5) → { thinking:{type:'disabled'}, outputConfig:null }.
 * The caller must spread both onto the API request (existing call-site contract).
 */
function getThinkingConfig(role = 'extraction') {
  const model = resolveModel(role);
  const entry = getRegistryEntry(model);
  // Unknown family fallback: infer style from the id so new models need data, not code.
  const style = entry ? (entry.thinking_style || 'adaptive')
                      : (/^claude-[a-z]+-([4-9]|\d\d)[-.]/.test(model) ? 'adaptive' : 'budget');
  const effort = resolveEffort(role);

  if (!effort) {
    if (style === 'adaptive' && entry && entry.explicit_off === true) {
      // Thinking runs by default on this model — "off" must be sent explicitly.
      return { thinking: { type: 'disabled' }, outputConfig: null };
    }
    return null; // omit the param (always_on models think anyway; classic models stay off)
  }

  if (style === 'budget') {
    // budget_tokens must stay below max_tokens (claude-processor bumps its own
    // maxTokens; other call sites don't, so cap defensively here).
    const map = { low: 2000, medium: 4000, high: 8000, xhigh: 12000, max: 16000 };
    let budget = map[effort] || 4000;
    budget = Math.max(1024, Math.min(budget, getMaxTokens() - 1024));
    return { thinking: { type: 'enabled', budget_tokens: budget }, outputConfig: null };
  }

  // adaptive + always_on (explicit {type:'adaptive'} is documented-accepted on always-on models)
  return { thinking: { type: 'adaptive' }, outputConfig: { effort: clampEffort(effort, entry) } };
}

/**
 * Validate the effective AI configuration against the registry. Never throws.
 * Levels: error (unknown/retired model — fallback applies), warn (deprecated model,
 * missing pricing, invalid effort value, broken registry overlay), info (legacy
 * model, clamped effort).
 * @returns {{ok:boolean, checked_at:string, model_count:number, issues:Array}}
 */
function validateAiConfig() {
  const issues = [];
  let registry = [];
  try {
    registry = getRegistry();
    if (registryCustomError) {
      issues.push({ role: null, level: 'warn', message: `model_registry_custom setting is invalid (${registryCustomError}) — using the built-in registry only` });
    }
    for (const role of ROLES) {
      const configured = getSetting(`${role}_model`, ROLE_DEFAULTS[role] || DEFAULT_MODEL, ROLE_ENV[role]);
      const entry = registry.find(m => m.id === configured) || null;
      const resolved = resolveModel(role);
      if (!entry) {
        issues.push({ role, configured, resolved, level: 'error', message: `Unknown model "${configured}" — falling back to "${resolved}"` });
      } else if (entry.status === 'retired') {
        issues.push({ role, configured, resolved, level: 'error', message: `Model "${configured}" is retired — falling back to "${resolved}"` });
      } else {
        if (entry.status === 'deprecated') issues.push({ role, configured, resolved, level: 'warn', message: `Model "${configured}" is deprecated — plan a migration (still honored as configured)` });
        else if (entry.status === 'legacy') issues.push({ role, configured, resolved, level: 'info', message: `Model "${configured}" is a legacy entry — a newer model in this family exists` });
        if (!entry.pricing || typeof entry.pricing.in !== 'number') {
          issues.push({ role, configured, resolved, level: 'warn', message: `No pricing configured for "${configured}" — cost tracking will record tokens but no dollar cost` });
        }
      }
      const explicit = String(getSetting(`${role}_thinking_effort`, '') || '').trim().toLowerCase();
      if (explicit && explicit !== 'off' && !EFFORT_LEVELS.includes(explicit)) {
        issues.push({ role, configured, resolved, level: 'warn', message: `Invalid thinking effort "${explicit}" — ignored (legacy/default behavior applies)` });
      } else if (explicit && explicit !== 'off' && entry && entry.thinking_style !== 'budget'
                 && Array.isArray(entry.efforts) && entry.efforts.length && !entry.efforts.includes(explicit)) {
        issues.push({ role, configured, resolved, level: 'info', message: `Effort "${explicit}" not supported by "${configured}" — clamped to "${clampEffort(explicit, entry)}"` });
      }
    }
  } catch (err) {
    issues.push({ role: null, level: 'error', message: `validation itself failed: ${err.message}` });
  }
  return {
    ok: !issues.some(i => i.level === 'error'),
    checked_at: new Date().toISOString(),
    model_count: registry.length,
    issues,
  };
}

// ── Cost estimation (pricing rides the registry — swap a model, keep the math) ─
const warnedPricing = new Set();

/** Compute an estimated USD cost from an Anthropic usage object. Missing pricing → null + one-time warn. */
function estimateCost(model, usage) {
  const entry = getRegistryEntry(model);
  const p = entry && entry.pricing;
  if (!p || typeof p.in !== 'number' || !usage) {
    if (model && usage && !warnedPricing.has(model)) {
      warnedPricing.add(model);
      console.warn(`[ai-config] no pricing for model "${model}" — usage recorded with cost_usd = NULL (add pricing to the model registry)`);
    }
    return null;
  }
  const inTok    = (usage.input_tokens || 0);
  const outTok   = (usage.output_tokens || 0);
  const cacheR   = (usage.cache_read_input_tokens || 0);
  const cacheW   = (usage.cache_creation_input_tokens || 0);
  const cacheReadRate = typeof p.cacheRead === 'number' ? p.cacheRead : p.in * 0.1;
  return (
    (inTok  * p.in)          / 1e6 +
    (outTok * p.out)         / 1e6 +
    (cacheR * cacheReadRate) / 1e6 +
    (cacheW * p.in * 1.25)   / 1e6
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
 * Record every tool invoked by Claude in one API run. Never throws.
 * @param {string} source  e.g. 'ingest_extraction' | 'sn_reconcile'
 * @param {Array}  toolUses  response.content blocks with type === 'tool_use'
 */
function logToolCalls(source, toolUses) {
  if (!toolUses || !toolUses.length) return;
  try {
    const stmt = db.prepare(
      `INSERT INTO asdlc_tool_call_log (call_id, source, tool_name, created_at)
       VALUES (?, ?, ?, datetime('now'))`
    );
    for (const tu of toolUses) stmt.run(generateId(), source, tu.name);
  } catch (err) {
    console.error('[ai-config] logToolCalls failed:', err.message);
  }
}

/**
 * Active best-practice rules to inject into a prompt. Returns rules that pass BOTH
 * gates: (1) scope — global, or scoped to one of the given entity types; and
 * (2) platform — platform-agnostic ('any'/NULL), or matching the context platform.
 * When no platform is given, only platform-agnostic rules apply (don't leak
 * platform-specific rules into unrelated work). Never throws.
 * @param {string[]} [entityScopes]
 * @param {string|null} [platform]  e.g. 'servicenow' | 'generic'
 */
function getActiveBestPractices(entityScopes = [], platform = null) {
  try {
    // Only inject rules (practice_type='rule') into prompts — not standing questions.
    const rows = db.prepare(
      "SELECT title, rule_text, scope, platform FROM asdlc_best_practice WHERE is_active = 1 AND (practice_type IS NULL OR practice_type = 'rule') ORDER BY sort_order, created_at"
    ).all();
    return rows.filter(r => {
      const scopeOk = r.scope === 'global' || entityScopes.includes(r.scope);
      if (!scopeOk) return false;
      const rulePlat = r.platform || 'any';
      if (rulePlat === 'any') return true;
      return platform != null && rulePlat === platform;
    });
  } catch {
    return [];
  }
}

/**
 * Resolve an application's target platform (e.g. 'servicenow' | 'generic').
 * Falls back to 'servicenow' (the app's primary platform, matching the column
 * default) when the project is unknown. Never throws.
 * @param {string} projectId
 * @returns {string}
 */
function getProjectPlatform(projectId) {
  try {
    if (!projectId) return 'servicenow';
    const row = db.prepare('SELECT target_platform FROM asdlc_project WHERE project_id = ?').get(projectId);
    return (row && row.target_platform) || 'servicenow';
  } catch {
    return 'servicenow';
  }
}

module.exports = {
  ROLES,
  THINKING_ROLES,
  EFFORT_LEVELS,
  getRegistry,
  getRegistryEntry,
  getDefaultEntry,
  validateAiConfig,
  resolveModel,
  resolveEffort,
  getMaxTokens,
  getMaxExtractionLoops,
  getThinkingConfig,
  estimateCost,
  logUsage,
  logToolCalls,
  getActiveBestPractices,
  getProjectPlatform,
};

// ── Legacy exports (registry-derived getters; keep sn-assess.js + old callers working) ─
Object.defineProperty(module.exports, 'AVAILABLE_MODELS', {
  enumerable: true,
  get() {
    return getRegistry()
      .filter(m => m.status !== 'retired')
      .map(m => ({ id: m.id, label: m.display || m.id }));
  },
});
Object.defineProperty(module.exports, 'MODEL_PRICING', {
  enumerable: true,
  get() {
    const out = {};
    for (const m of getRegistry()) if (m.pricing) out[m.id] = m.pricing;
    return out;
  },
});
