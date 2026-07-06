// test-ai-config.js — model registry + role config resolution test (fully offline).
// Covers: registry load + custom overlay (merge/remove/malformed), resolveModel
// chain incl. unknown-model fallback, legacy thinking-budget compat (numeric AND
// the literal effort-string the old UI saved), the `<role>_thinking_effort` key,
// per-style thinking emission (adaptive / always_on / explicit_off / budget),
// effort clamping, estimateCost + missing-pricing behavior, the legacy
// AVAILABLE_MODELS/MODEL_PRICING getters, and the GET/PUT /settings/ai + /usage
// HTTP surface (validation block, 400s, pricing_missing_models).
//
// Run:  node test-ai-config.js   (from backend-node/)
'use strict';
const path = require('path');
const os   = require('os');

process.env.ASDLC_DB_PATH = path.join(os.tmpdir(), `asdlc_aicfg_${Date.now()}.db`);
process.env.PORT = String(8700 + Math.floor(Math.random() * 600));
process.env.ANTHROPIC_API_KEY = '';   // stub mode — deterministic + free

const base = __dirname;
require(path.join(base, 'server.js'));                        // boots + seeds + listens (also runs boot validation)
const { db } = require(path.join(base, 'db'));
const aiConfig = require(path.join(base, 'agent', 'ai-config'));

const BASEURL = `http://127.0.0.1:${process.env.PORT}/api/v1`;
const HEADERS = { 'Content-Type': 'application/json', 'X-User-ID': 'test-ai-config' };

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { console.log('  ok  -', m); pass++; } else { console.error('  FAIL-', m); fail++; } };
function done(code) { try { db.close(); } catch { /* ignore */ } process.exit(code); }

function setKV(k, v) {
  db.prepare(`INSERT INTO asdlc_app_setting (setting_key, setting_value, updated_by, updated_at)
              VALUES (?,?,?,datetime('now'))
              ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value, updated_at=excluded.updated_at`)
    .run(k, String(v), 'test');
}
function delKV(...keys) {
  for (const k of keys) db.prepare('DELETE FROM asdlc_app_setting WHERE setting_key = ?').run(k);
}

function testRegistry() {
  console.log('\n--- Part 1: registry + resolution ---');
  const reg = aiConfig.getRegistry();
  assert(reg.length >= 6, `registry loads from model-registry.json (${reg.length} models)`);
  assert(reg.some(m => m.id === 'claude-fable-5') && reg.some(m => m.id === 'claude-sonnet-5'),
         'registry includes the Claude 5 family (fable-5 + sonnet-5)');
  assert(aiConfig.getDefaultEntry().id === 'claude-sonnet-4-6', 'default fallback entry = claude-sonnet-4-6');

  // Role defaults unchanged (fresh install byte-compat)
  assert(aiConfig.resolveModel('extraction') === 'claude-sonnet-4-6', 'extraction default → sonnet-4-6');
  assert(aiConfig.resolveModel('reverse_engineer') === 'claude-opus-4-8', 'reverse_engineer default → opus-4-8');
  assert(aiConfig.resolveModel('req_linker') === 'claude-haiku-4-5-20251001', 'req_linker default → haiku-4-5');

  // DB setting wins
  setKV('extraction_model', 'claude-sonnet-5');
  assert(aiConfig.resolveModel('extraction') === 'claude-sonnet-5', 'DB setting overrides default (live reload)');
  delKV('extraction_model');

  // Unknown model → loud fallback to the registry default, surfaced by validation
  setKV('reconciler_model', 'claude-bogus-9');
  assert(aiConfig.resolveModel('reconciler') === 'claude-sonnet-4-6', 'unknown configured model falls back to the default entry');
  const v = aiConfig.validateAiConfig();
  assert(v.ok === false && v.issues.some(i => i.role === 'reconciler' && i.level === 'error'),
         'validateAiConfig flags the unknown model as an error');
  delKV('reconciler_model');
  assert(aiConfig.validateAiConfig().ok === true, 'validation clean again after fixing the setting');
}

function testThinking() {
  console.log('\n--- Part 2: thinking effort (legacy compat + new key + styles) ---');

  // Defaults: SN reasoning roles think at high; extraction is off.
  let cfg = aiConfig.getThinkingConfig('reverse_engineer');
  assert(cfg && cfg.thinking.type === 'adaptive' && cfg.outputConfig.effort === 'high',
         'reverse_engineer default → adaptive + effort high (unchanged behavior)');
  assert(aiConfig.getThinkingConfig('extraction') === null, 'extraction default → thinking off (null)');

  // Legacy pair: numeric budget mapping unchanged
  setKV('extraction_thinking_enabled', 'true');
  setKV('extraction_thinking_budget', '2000');
  cfg = aiConfig.getThinkingConfig('extraction');
  assert(cfg && cfg.outputConfig.effort === 'low', 'legacy numeric budget 2000 → low');
  // Legacy bug fix: the old admin UI saved the effort WORD, which parseInt() broke.
  setKV('extraction_thinking_budget', 'high');
  cfg = aiConfig.getThinkingConfig('extraction');
  assert(cfg && cfg.outputConfig.effort === 'high', "legacy budget string 'high' now maps to high (was NaN→medium)");
  setKV('extraction_thinking_budget', 'garbage-42x');
  cfg = aiConfig.getThinkingConfig('extraction');
  assert(cfg && cfg.outputConfig.effort === 'medium', 'legacy junk budget → medium (todays effective behavior)');
  delKV('extraction_thinking_enabled', 'extraction_thinking_budget');

  // New effort key is authoritative over the legacy pair
  setKV('reverse_engineer_thinking_effort', 'off');
  assert(aiConfig.getThinkingConfig('reverse_engineer') === null, "effort 'off' beats legacy enabled default");
  setKV('reverse_engineer_thinking_effort', 'max');
  cfg = aiConfig.getThinkingConfig('reverse_engineer');
  assert(cfg && cfg.outputConfig.effort === 'max', "effort 'max' honored on opus-4-8");
  delKV('reverse_engineer_thinking_effort');

  // Clamping: sonnet-4-6 has no xhigh → clamps down to high
  setKV('reconciler_model', 'claude-sonnet-4-6');
  setKV('reconciler_thinking_effort', 'xhigh');
  cfg = aiConfig.getThinkingConfig('reconciler');
  assert(cfg && cfg.outputConfig.effort === 'high', 'xhigh on sonnet-4-6 clamps to high (per registry efforts)');
  delKV('reconciler_model', 'reconciler_thinking_effort');

  // always_on (fable-5): thinking on → explicit adaptive; off → omit (null)
  setKV('synthesis_model', 'claude-fable-5');
  cfg = aiConfig.getThinkingConfig('synthesis');   // synthesis legacy default = enabled/8000
  assert(cfg && cfg.thinking.type === 'adaptive' && cfg.outputConfig.effort === 'high',
         'fable-5 + thinking on → explicit adaptive + effort');
  setKV('synthesis_thinking_effort', 'off');
  assert(aiConfig.getThinkingConfig('synthesis') === null,
         'fable-5 + off → param omitted (thinking cannot be disabled; no invalid disabled sent)');
  delKV('synthesis_model', 'synthesis_thinking_effort');

  // explicit_off (sonnet-5): thinking off must SEND disabled (omitting runs adaptive)
  setKV('prompt_drafter_model', 'claude-sonnet-5');
  cfg = aiConfig.getThinkingConfig('prompt_drafter');   // prompt_drafter default = off
  assert(cfg && cfg.thinking.type === 'disabled' && cfg.outputConfig === null,
         'sonnet-5 + off → explicit {type:disabled} (adaptive is its API default)');
  delKV('prompt_drafter_model');

  // budget style (haiku): valid budget_tokens shape, capped below max_tokens — the
  // old code emitted an invalid output_config.effort shape here.
  setKV('quality_reviewer_model', 'claude-haiku-4-5-20251001');
  setKV('quality_reviewer_thinking_effort', 'high');
  cfg = aiConfig.getThinkingConfig('quality_reviewer');
  const maxTok = aiConfig.getMaxTokens();
  assert(cfg && cfg.thinking.type === 'enabled' && Number.isInteger(cfg.thinking.budget_tokens),
         'haiku + thinking → budget_tokens shape (no effort param)');
  assert(cfg.outputConfig === null, 'haiku thinking carries no outputConfig.effort (API would 400)');
  assert(cfg.thinking.budget_tokens >= 1024 && cfg.thinking.budget_tokens <= maxTok - 1024,
         `haiku budget capped below max_tokens (${cfg.thinking.budget_tokens} ≤ ${maxTok - 1024})`);
  delKV('quality_reviewer_model', 'quality_reviewer_thinking_effort');
}

function testRegistryOverlay() {
  console.log('\n--- Part 3: model_registry_custom overlay ---');
  setKV('model_registry_custom', JSON.stringify([
    { id: 'claude-test-x', display: 'Test X', family: 'Test', tier: 'fast', status: 'active',
      thinking_style: 'adaptive', efforts: ['low', 'high'], pricing: { in: 2, out: 4, cacheRead: 0.2 } },
    { id: 'claude-opus-4-7', remove: true },
    { id: 'claude-opus-4-8', pricing: { in: 6, out: 30, cacheRead: 0.6 } },   // partial override
  ]));
  let reg = aiConfig.getRegistry();
  assert(reg.some(m => m.id === 'claude-test-x'), 'overlay appends a brand-new model (no code change)');
  assert(!reg.some(m => m.id === 'claude-opus-4-7'), 'overlay remove:true hides a built-in entry');
  const opus = reg.find(m => m.id === 'claude-opus-4-8');
  assert(opus.pricing.in === 6 && opus.display === 'Claude Opus 4.8',
         'overlay shallow-merges over the built-in entry (pricing overridden, display kept)');
  const cost = aiConfig.estimateCost('claude-test-x', { input_tokens: 1e6, output_tokens: 1e6 });
  assert(Math.abs(cost - 6) < 1e-9, 'estimateCost uses overlay pricing ($2 in + $4 out = $6)');

  // Malformed overlay never breaks resolution
  setKV('model_registry_custom', '{not json[');
  reg = aiConfig.getRegistry();
  assert(reg.some(m => m.id === 'claude-opus-4-7'), 'malformed overlay is ignored — built-in registry intact');
  assert(aiConfig.validateAiConfig().issues.some(i => /model_registry_custom/.test(i.message) && i.level === 'warn'),
         'malformed overlay surfaces as a validation warning');
  assert(aiConfig.resolveModel('extraction') === 'claude-sonnet-4-6', 'resolveModel unaffected by broken overlay');
  delKV('model_registry_custom');
}

function testCost() {
  console.log('\n--- Part 4: cost + legacy exports ---');
  const c = aiConfig.estimateCost('claude-opus-4-8', { input_tokens: 1e6, output_tokens: 1e6 });
  assert(Math.abs(c - 30) < 1e-9, 'estimateCost opus-4-8: $5 in + $25 out = $30 per 1M+1M');
  assert(aiConfig.estimateCost('claude-unpriced-model', { input_tokens: 100 }) === null,
         'unknown model → cost null (warned once, not thrown)');
  assert(aiConfig.MODEL_PRICING['claude-opus-4-8'].in === 5, 'legacy MODEL_PRICING getter (sn-assess.js compat)');
  assert(aiConfig.AVAILABLE_MODELS.some(m => m.id === 'claude-fable-5' && /Fable/.test(m.label)),
         'legacy AVAILABLE_MODELS getter derives from the registry');
  // logUsage records tokens even without pricing (feeds the /usage pricing_missing check)
  aiConfig.logUsage({ projectId: null, source: 'test_ai_config', model: 'claude-unpriced-model',
                      usage: { input_tokens: 123, output_tokens: 45 } });
  const row = db.prepare("SELECT * FROM asdlc_ai_usage WHERE model = 'claude-unpriced-model'").get();
  assert(row && row.input_tokens === 123 && row.cost_usd === null, 'logUsage stores tokens with cost_usd NULL when unpriced');
}

async function testHttp() {
  console.log('\n--- Part 5: HTTP surface ---');
  let r = await fetch(`${BASEURL}/settings/ai`, { headers: HEADERS });
  let j = await r.json();
  const roleKeys = (j.roles || []).map(role => `${role}_model`);
  assert(j.roles && j.roles.length === 11, 'GET /settings/ai lists all 11 roles');
  assert(roleKeys.every(k => k in j.settings), 'settings carry a model for every role (incl. SN reasoning + synthesis + cost_estimate)');
  assert(j.settings.reverse_engineer_thinking_effort === 'high', 'effective effort exposed per role');
  assert(j.validation && j.validation.ok === true, 'validation block present and clean');
  assert((j.available_models || []).every(m => m.family), 'available_models carry registry metadata (family)');
  assert(Array.isArray(j.effort_levels) && j.effort_levels.includes('xhigh'), 'effort_levels include xhigh');

  // PUT round-trip for a previously-unsettable role
  r = await fetch(`${BASEURL}/settings/ai`, { method: 'PUT', headers: HEADERS,
    body: JSON.stringify({ reconciler_model: 'claude-sonnet-5', reconciler_thinking_effort: 'xhigh' }) });
  j = await r.json();
  assert(r.ok && j.ok, 'PUT accepts reconciler_model + effort (was blocked by the old allow-list)');
  assert(aiConfig.resolveModel('reconciler') === 'claude-sonnet-5', 'PUT took effect live (no restart)');
  const cfg = aiConfig.getThinkingConfig('reconciler');
  assert(cfg && cfg.outputConfig.effort === 'xhigh', 'xhigh honored on sonnet-5');
  await fetch(`${BASEURL}/settings/ai`, { method: 'PUT', headers: HEADERS,
    body: JSON.stringify({ reconciler_model: 'claude-opus-4-8', reconciler_thinking_effort: 'high' }) });

  // Rejections
  r = await fetch(`${BASEURL}/settings/ai`, { method: 'PUT', headers: HEADERS,
    body: JSON.stringify({ extraction_model: 'claude-made-up' }) });
  assert(r.status === 400, 'PUT unknown model → 400');
  r = await fetch(`${BASEURL}/settings/ai`, { method: 'PUT', headers: HEADERS,
    body: JSON.stringify({ extraction_thinking_effort: 'ultra' }) });
  assert(r.status === 400, 'PUT invalid effort → 400');
  r = await fetch(`${BASEURL}/settings/ai`, { method: 'PUT', headers: HEADERS,
    body: JSON.stringify({ model_registry_custom: '[{"display":"no id"}]' }) });
  assert(r.status === 400, 'PUT registry overlay without id → 400');
  r = await fetch(`${BASEURL}/settings/ai`, { method: 'PUT', headers: HEADERS,
    body: JSON.stringify({ model_registry_custom: '' }) });
  assert(r.ok, 'PUT empty registry overlay (clear) → 200');

  // /usage flags unpriced models (row inserted in Part 4)
  r = await fetch(`${BASEURL}/usage?limit=10`, { headers: HEADERS });
  j = await r.json();
  assert((j.totals.pricing_missing_models || []).includes('claude-unpriced-model'),
         '/usage totals list models with usage but no pricing');
  const um = (j.by_model || []).find(m => m.model === 'claude-unpriced-model');
  assert(um && um.has_pricing === false, '/usage by_model rows carry has_pricing');
}

async function main() {
  await new Promise(r => setTimeout(r, 900));   // let app.listen bind
  testRegistry();
  testThinking();
  testRegistryOverlay();
  testCost();
  await testHttp();
  console.log(`\n=== test-ai-config: ${pass} passed, ${fail} failed ===`);
  done(fail ? 1 : 0);
}

main().catch(err => { console.error('FATAL', err); done(1); });
