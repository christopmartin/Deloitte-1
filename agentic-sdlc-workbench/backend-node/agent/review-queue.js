// agent/review-queue.js
//
// Debounced, coalesced trigger for the quality reviewer on Edit-Modal saves.
//
// Goal: never block a save, and never spend a Claude call per keystroke-save.
//   - maybeEnqueueReview() gates on material-field changes (cosmetic-only edits
//     are skipped entirely), then schedules a per-entity debounce timer.
//   - Re-editing the same entity resets its timer, so a burst of rapid edits
//     collapses into ONE review once the edits settle.
//   - When the timer fires, reviewEntity() + applyFindings() run out-of-band;
//     findings land in asdlc_exception (detected_by='quality-reviewer') and
//     surface in the existing Exceptions panel. Failures are swallowed.
//
'use strict';

const { db } = require('../db');

// Debounce window (ms). Override with REVIEW_DEBOUNCE_MS for tests / tuning.
const DEBOUNCE_MS = (() => {
  const v = parseInt(process.env.REVIEW_DEBOUNCE_MS, 10);
  return Number.isFinite(v) && v >= 0 ? v : 45000;
})();

// Fields whose change should NOT, on its own, trigger an AI review — identity,
// ownership, and bookkeeping fields that can't introduce a design conflict.
// Anything NOT in this set is treated as material.
const COSMETIC_FIELDS = new Set([
  'owner', 'maintenance_owner', 'name', 'title', 'slug', 'source', 'status',
  'primary_success_metric', 'epic_or_feature_id', 'baseline_cost_annual_usd',
  'runs_per_period', 'change_note',
]);

// Map an edit-route entity label to the quality-reviewer's entityType.
const ENTITY_TYPE_MAP = {
  use_case: 'use_case',
  workflow: 'workflow',
  workflow_step: 'workflow_step',
  agent: 'agent_spec',
  agent_spec: 'agent_spec',
  tool: 'tool',
  functional_req: 'functional_req',
  nonfunctional_req: 'nonfunctional_req',
};

/** True if at least one changed field is material (not purely cosmetic). */
function materialChanged(changedFields) {
  const fields = Array.isArray(changedFields) ? changedFields : Object.keys(changedFields || {});
  return fields.some(f => !COSMETIC_FIELDS.has(f));
}

const _timers = new Map();  // key → timeout handle

function _runReview(projectId, entityType, entityId) {
  // Lazy-require to avoid a load-time cycle (server → review-queue → reviewer).
  try {
    const { reviewEntity, applyFindings } = require('./quality-reviewer');
    Promise.resolve(reviewEntity({ projectId, entityType, entityId, db }))
      .then(result => {
        try { applyFindings(db, projectId, entityType, entityId, result.findings || []); }
        catch (e) { console.error('[review-queue] applyFindings failed:', e.message); }
      })
      .catch(err => console.error('[review-queue] reviewEntity failed:', err.message));
  } catch (err) {
    console.error('[review-queue] could not start review:', err.message);
  }
}

/**
 * Gate + schedule a review for one edited entity. Returns whether a review was
 * (re)scheduled — callers may surface this to the UI ("AI review queued").
 * Fire-and-forget; never throws into the request path.
 * @param {{projectId:string, entityType:string, entityId:string, changedFields:(string[]|object)}} o
 */
function maybeEnqueueReview(o) {
  try {
    const entityType = ENTITY_TYPE_MAP[o.entityType];
    if (!entityType || !o.projectId || !o.entityId) return false;
    if (!materialChanged(o.changedFields)) return false;

    const key = `${o.projectId}|${entityType}|${o.entityId}`;
    if (_timers.has(key)) clearTimeout(_timers.get(key));
    const handle = setTimeout(() => {
      _timers.delete(key);
      _runReview(o.projectId, entityType, o.entityId);
    }, DEBOUNCE_MS);
    if (typeof handle.unref === 'function') handle.unref();  // don't keep the process alive
    _timers.set(key, handle);
    return true;
  } catch (err) {
    console.error('[review-queue] maybeEnqueueReview failed:', err.message);
    return false;
  }
}

module.exports = {
  maybeEnqueueReview,
  materialChanged,
  DEBOUNCE_MS,
  COSMETIC_FIELDS,
  ENTITY_TYPE_MAP,
  _internal: { _runReview, _timers },
};
