// agent/sn-sync.js
// ─────────────────────────────────────────────────────────────────────────────
// Phase F — the SYNC ORCHESTRATOR + GATE.
//
// Chains the whole ServiceNow→Workbench reconciliation pipeline into one runner and
// decides, per proposal, whether a change is safe to apply automatically or must go
// to a human (HITL):
//
//   captureScope (B)        live read-only pull of every design surface in a scope
//   classifyArtifacts (B)   deterministic tier-0 pre-diff → unchanged/changed/new/drift
//   reverseEngineer (C)     Opus: implementation → inferred functional design  (changed+new only)
//   reconcile (D)           Opus: non-destructive proposals vs the canonical Workbench record
//   review (E)              Opus, adversarial: catches destructive/hallucinated proposals
//   GATE (F)                ↓ this module ↓
//
// THE GATE (the whole point of Phase F). A proposal auto-applies ONLY when it is
// unambiguously safe AND the apply mode permits it:
//   - reviewer verdict === 'approve'                      (E said it's good)
//   - NOT destructive and NOT destructive_confirmed      (the hard non-destructive floor)
//   - final_confidence >= the project's confidence_threshold
//   - the change is purely ADDITIVE (a net-new create, or an enrich that only FILLS
//     EMPTY fields) — an enrich that appends to / modifies populated content goes to HITL
//   - apply mode is not 'review_all'
// Everything else (conflict, drift, low confidence, append/modify, mode=review_all)
// becomes a 'pending_review' Change Packet for a human. drift NEVER auto-applies and
// is NEVER a delete — it is a flag for human awareness only.
//
// This module is a PURE PLANNER: it performs the pipeline and returns a structured,
// reviewable plan but makes NO database writes. server.js consumes the plan to build
// the auto-apply + HITL Change Packets (reusing the existing materializer, which now
// stores source_hash so the next sync's tier-0 detects "unchanged"). Keeping it pure
// makes it offline-testable in stub mode exactly like Phases C–E.
'use strict';
const { db, getSetting } = require('../db');
const { captureScope, classifyArtifacts, WB_PROVENANCE_TABLES } = require('./sn-capture');
const { reverseEngineer } = require('./sn-reverse-engineer');
const { reconcile } = require('./sn-reconcile');
const { review } = require('./sn-review');

// wb table → Workbench entity_type (the registry key the materializer uses).
const TYPE_BY_WB_TABLE = {};
WB_PROVENANCE_TABLES.forEach(t => { TYPE_BY_WB_TABLE[t.table] = t.type; });

const DEFAULT_THRESHOLD = 0.75;          // mirrors asdlc_project.confidence_threshold default
const ADDITIVE_ACTIONS = new Set(['create', 'enrich']);

/** Resolve the per-project confidence threshold (falls back to the schema default). */
function resolveProjectThreshold(projectId) {
  try {
    const row = db.prepare('SELECT confidence_threshold FROM asdlc_project WHERE project_id = ?').get(projectId);
    const v = row && row.confidence_threshold;
    return (typeof v === 'number' && v >= 0 && v <= 1) ? v : DEFAULT_THRESHOLD;
  } catch { return DEFAULT_THRESHOLD; }
}

// ── Reverse-path business-logic MATERIALITY ──────────────────────────────────
// Reverse-engineering a live ServiceNow app, not every captured script deserves a
// first-class Level-1 design row. A mature app has hundreds of trivial client scripts /
// UI policies; elevating all of them buries the real design. The gate below decides, per
// NEW artifact, whether it becomes a design row ("elevated") or is captured-but-not-
// elevated. It governs ONLY business-logic artifacts; tables, forms, agents, tools, use
// cases, catalog items always elevate. `changed` artifacts already have a Workbench row
// (the elevate decision was made on a prior sync), so they bypass the gate.
//
// Capture-level design_type for logic: business_rule | client_script | script_include |
// ui_action (sys_script / sys_script_client / sys_script_include / sys_ui_action).
const MATERIALITY_LOGIC_TYPES = new Set(['business_rule', 'client_script', 'script_include', 'ui_action']);

/** Per-project materiality config: min confidence (null → project threshold) + disallowed capture types. */
function resolveMaterialityConfig(projectId) {
  try {
    const row = db.prepare(
      'SELECT materiality_min_confidence AS minc, materiality_disallow_types AS dis FROM asdlc_project WHERE project_id = ?'
    ).get(projectId);
    let disallowTypes = [];
    if (row && row.dis) { try { disallowTypes = JSON.parse(row.dis) || []; } catch { disallowTypes = []; } }
    const minConfidence = (row && typeof row.minc === 'number') ? row.minc : null;
    return { minConfidence, disallowTypes };
  } catch { return { minConfidence: null, disallowTypes: [] }; }
}

/** Heuristic: does this captured logic artifact carry real conditional / business behaviour? */
function isSignificant(snType, artifact, inferred) {
  const inf = inferred || {};
  const text = [inf.behavior, inf.purpose, inf.rationale, ...(inf.key_details || [])]
    .filter(Boolean).join(' ').toLowerCase();
  if (/\b(when|if |condition|mandator|requir|calculat|comput|validat|reject|approv|abort|prevent|block|notif|email|assign|escalat|insert|create|update|delete|status|state|integrat|sla|due|overdue|threshold|restrict|enforce)\b/.test(text)) return true;
  const salient = artifact.salient || {};
  const script = typeof salient.script === 'string' ? salient.script : '';
  if (script.replace(/\s+/g, '').length > 400) return true;   // non-trivial body
  if (salient.condition || salient.when) return true;          // explicit business-rule trigger/condition
  return false;
}

/**
 * Materiality decision for ONE captured artifact + its inference. Governs business-logic
 * only — every other design type always elevates. Returns { elevate, reason }.
 */
function passesMaterialityGate(artifact, inferred, cfg = {}, fallbackThreshold = DEFAULT_THRESHOLD) {
  const snType = artifact && artifact.design_type;
  if (!MATERIALITY_LOGIC_TYPES.has(snType)) return { elevate: true, reason: 'not business-logic — always elevated' };

  // Server-side logic (business rules + script includes) is presumed material.
  if (snType === 'business_rule' || snType === 'script_include') {
    return { elevate: true, reason: `${snType} — server-side logic, presumed material` };
  }
  // client_script / ui_action: material only when it carries real conditional/business behaviour.
  if (!isSignificant(snType, artifact, inferred)) {
    return { elevate: false, reason: `${snType} appears cosmetic / default-setting (no conditional or business effect)` };
  }
  const minConf = (typeof cfg.minConfidence === 'number') ? cfg.minConfidence : fallbackThreshold;
  const conf = (inferred && typeof inferred.confidence === 'number') ? inferred.confidence : 0;
  if (conf < minConf) {
    return { elevate: false, reason: `${snType} significant but inference confidence ${conf.toFixed(2)} < materiality min ${minConf.toFixed(2)}` };
  }
  return { elevate: true, reason: `${snType} — significant behaviour, confidence ${conf.toFixed(2)} ≥ ${minConf.toFixed(2)}` };
}

/** Compact report row for a non-elevated / skipped artifact. */
function matReport(a, classification, reason, inferred) {
  return {
    source_sys_id: a.source_sys_id,
    name: (inferred && inferred.name) || a.name || '(unnamed)',
    design_type: a.design_type,
    classification,
    reason,
  };
}

/**
 * Decide whether ONE reviewed proposal may auto-apply, or must go to HITL.
 * Pure + deterministic — the gate. Returns:
 *   { target: 'auto'|'hitl'|'none', auto_apply: bool, reason: string }
 * 'none' = there is genuinely nothing to do (action no_change) — no CP item at all.
 *
 * @param {object} reviewed  one item from review(): {classification, proposal, review}
 * @param {object} opts      {mode, threshold}
 */
function gateProposal(reviewed, opts = {}) {
  const mode = opts.mode || 'additive_hitl';
  const threshold = (typeof opts.threshold === 'number') ? opts.threshold : DEFAULT_THRESHOLD;
  const p = reviewed.proposal || {};
  const r = reviewed.review || {};
  const cls = reviewed.classification;

  // Drift: present in the Workbench, absent from this capture. Never a write, never a
  // delete — surfaced for human awareness only (a lossy/partial SN view must not erase
  // Workbench design).
  if (cls === 'drift') {
    return { target: 'hitl', auto_apply: false, reason: 'drift — in Workbench, absent from ServiceNow; flagged for human awareness, never auto-applied/deleted' };
  }

  // Nothing to do.
  if (p.action === 'no_change') {
    return { target: 'none', auto_apply: false, reason: 'no change required (ServiceNow is a lossy subset of the Workbench record)' };
  }

  // review_all: a human signs off on every change, even purely-additive ones.
  if (mode === 'review_all') {
    return { target: 'hitl', auto_apply: false, reason: 'apply mode = review_all — every change requires human review' };
  }

  // ── Hard non-destructive floor (applies under ALL non-review_all modes) ──
  if (r.verdict !== 'approve') {
    return { target: 'hitl', auto_apply: false, reason: `reviewer verdict = ${r.verdict || 'unknown'} — human review required` };
  }
  if (p.destructive || r.destructive_confirmed) {
    return { target: 'hitl', auto_apply: false, reason: 'destructive — would modify/shrink/blank populated Workbench content' };
  }
  const conf = (typeof r.final_confidence === 'number') ? r.final_confidence : 0;
  if (conf < threshold) {
    return { target: 'hitl', auto_apply: false, reason: `confidence ${conf.toFixed(2)} < threshold ${threshold} — human review required` };
  }

  // ── Additivity gate ──
  // An enrich is only auto-safe when EVERY field change merely fills an EMPTY field.
  // append/modify touch populated content (modify is already forced destructive
  // upstream; append could mis-merge a populated list) → route to a human.
  if (p.action === 'enrich') {
    const nonFill = (p.field_changes || []).filter(c => c.change_kind !== 'fill_blank');
    if (nonFill.length) {
      return { target: 'hitl', auto_apply: false, reason: `enrich contains ${nonFill.map(c => c.change_kind).join('/')} — human applies to avoid mis-merging populated content` };
    }
  }
  // additive_hitl: only purely-additive actions auto-apply. confidence_gate: any
  // non-destructive change that clears the confidence bar auto-applies (currently the
  // same set, since only create/enrich are non-destructive — but kept distinct so a
  // future "safe modify" category can ride confidence_gate without loosening additive_hitl).
  if (mode === 'additive_hitl' && !ADDITIVE_ACTIONS.has(p.action)) {
    return { target: 'hitl', auto_apply: false, reason: `apply mode = additive_hitl — action "${p.action}" is not purely additive` };
  }

  return { target: 'auto', auto_apply: true, reason: `approved, non-destructive, confidence ${conf.toFixed(2)} ≥ ${threshold}` };
}

/** Roll up the gated plan into headline counts for the UI / logs. */
function summarize(planned, classified) {
  const s = { unchanged: classified.unchanged.length, auto: 0, hitl: 0, no_change: 0,
    by_classification: { changed: 0, new: 0, drift: 0 }, capture_errors: classified.errors.length };
  for (const pl of planned) {
    s.by_classification[pl.classification] = (s.by_classification[pl.classification] || 0) + 1;
    if (pl.decision.target === 'auto') s.auto++;
    else if (pl.decision.target === 'hitl') s.hitl++;
    else s.no_change++;
  }
  return s;
}

/**
 * Run the full sync pipeline for one ServiceNow-linked project and return a gated PLAN.
 * Makes NO database writes (pure planner). Pass `artifacts` to skip the live capture
 * (used by offline tests and dry-runs).
 *
 * @param {object} opts {projectId, scope, instance, user, pw, fetchImpl?, artifacts?, mode?, threshold?}
 * @param {object} ctx  {projectId} forwarded to the Opus stages for usage logging
 * @returns {Promise<object>} { project_id, scope, mode, threshold, classified_summary,
 *                              unchanged, planned[], errors, summary }
 */
async function runSyncPlan(opts = {}, ctx = {}) {
  const { projectId, scope } = opts;
  const mode = opts.mode || getSetting('sn_sync_apply_mode', 'additive_hitl');
  const threshold = (typeof opts.threshold === 'number') ? opts.threshold : resolveProjectThreshold(projectId);
  const logCtx = { projectId, ...ctx };

  // 1. Capture every design surface (or use pre-supplied artifacts for tests/dry-runs).
  const artifacts = opts.artifacts ||
    await captureScope({ scope, instance: opts.instance, user: opts.user, pw: opts.pw, fetchImpl: opts.fetchImpl });

  // 2. Deterministic tier-0 classification against the linked project.
  const classified = classifyArtifacts(artifacts, projectId);

  // 3. Reverse-engineer ONLY changed + new (the cost tier — unchanged skip the LLM).
  //    MATERIALITY (NEW only): Stage 1 drops disallowed capture types BEFORE inference
  //    (saves the expensive Opus call); Stage 2 drops immaterial business-logic AFTER
  //    inference (needs the inferred behaviour/confidence). `changed` artifacts already
  //    have a Workbench row, so they bypass materiality.
  const matCfg = resolveMaterialityConfig(projectId);
  const disallow = new Set(matCfg.disallowTypes || []);
  const skipped_disallowed = [];
  const newAllowed = [];
  for (const a of classified.new) {
    if (disallow.has(a.design_type)) skipped_disallowed.push(matReport(a, 'new', `capture type "${a.design_type}" is in materiality_disallow_types`));
    else newAllowed.push(a);
  }

  const toInfer = [...classified.changed, ...newAllowed];
  const inferences = await reverseEngineer(toInfer, logCtx);
  const inferBySysId = {};
  for (const inf of inferences) inferBySysId[inf.source_sys_id] = inf.inferred;

  // Stage 2: significance/confidence gate on NEW business-logic.
  const captured_not_elevated = [];
  const elevatedNew = [];
  for (const a of newAllowed) {
    const inferred = inferBySysId[a.source_sys_id];
    const m = passesMaterialityGate(a, inferred, matCfg, threshold);
    if (m.elevate) elevatedNew.push(a);
    else captured_not_elevated.push(matReport(a, 'new', m.reason, inferred));
  }

  const changedWithInf = classified.changed.map(a => ({ ...a, inferred: inferBySysId[a.source_sys_id] }));
  const newWithInf     = elevatedNew.map(a => ({ ...a, inferred: inferBySysId[a.source_sys_id] }));

  // 4. Reconcile (non-destructive proposals). 5. Independent adversarial review.
  const proposals = await reconcile({ changed: changedWithInf, new: newWithInf, drift: classified.drift }, logCtx);
  const reviewed  = await review(proposals, logCtx);

  // 6. Gate each reviewed proposal; carry the captured artifact (hash/salient) for materialization.
  const artBySysId = {};
  for (const a of artifacts) if (a.source_sys_id) artBySysId[a.source_sys_id] = a;
  const infItemBySysId = {};
  for (const it of [...changedWithInf, ...newWithInf]) infItemBySysId[it.source_sys_id] = it.inferred;

  const planned = reviewed.map(rv => ({
    ...rv,
    inferred: infItemBySysId[rv.source_sys_id] || rv.inferred || null,
    artifact: artBySysId[rv.source_sys_id] || null,
    decision: gateProposal(rv, { mode, threshold }),
  }));

  const summary = summarize(planned, classified);
  summary.elevated_new = newWithInf.length;
  summary.captured_not_elevated = captured_not_elevated.length;
  summary.skipped_disallowed = skipped_disallowed.length;

  return {
    project_id: projectId, scope, mode, threshold,
    classified_summary: classified.summary,
    unchanged: classified.unchanged,
    planned,
    errors: classified.errors,
    materiality: {
      elevated: newWithInf.length,
      captured_not_elevated,
      skipped_disallowed,
      config: { min_confidence: matCfg.minConfidence, disallow_types: matCfg.disallowTypes },
    },
    summary,
  };
}

module.exports = {
  runSyncPlan,
  gateProposal,
  resolveProjectThreshold,
  resolveMaterialityConfig,
  passesMaterialityGate,
  isSignificant,
  summarize,
  TYPE_BY_WB_TABLE,
  MATERIALITY_LOGIC_TYPES,
  DEFAULT_THRESHOLD,
};
