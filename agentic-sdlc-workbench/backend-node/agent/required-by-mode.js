/**
 * required-by-mode.js — Methodology guidance matrix (backend copy)
 *
 * IMPORTANT: This is a verbatim mirror of REQUIRED_BY_MODE in
 *   frontend/modules/design_review.js (around line 20).
 * If you edit one, edit both. The matrix is small and rarely changes; we
 * accept the duplication to keep the frontend self-contained and avoid
 * adding a build step for a shared module.
 *
 * Codes: R=Required, C=Conditional, O=Optional.
 * Keyed by: entity_type → field_key → supervision_mode → code.
 * Modes match the 3-value enum: 'Advisory-only' | 'Supervised HITL' | 'Autonomous'.
 *
 * Used by quality-reviewer.js to decide which fields are *required* for the
 * entity's current supervision_model, and to surface "missing" findings when
 * required fields are blank.
 */

const REQUIRED_BY_MODE = {
  use_case: {
    title:                                  { 'Advisory-only': 'R', 'Supervised HITL': 'R', 'Autonomous': 'R' },
    summary:                                { 'Advisory-only': 'R', 'Supervised HITL': 'R', 'Autonomous': 'R' },
    business_objective:                     { 'Advisory-only': 'R', 'Supervised HITL': 'R', 'Autonomous': 'R' },
    expected_value:                         { 'Advisory-only': 'C', 'Supervised HITL': 'C', 'Autonomous': 'R' },
    success_criteria:                       { 'Advisory-only': 'R', 'Supervised HITL': 'R', 'Autonomous': 'R' },
    constraints_list:                       { 'Advisory-only': 'O', 'Supervised HITL': 'C', 'Autonomous': 'R' },
    supervision_model:                      { 'Advisory-only': 'R', 'Supervised HITL': 'R', 'Autonomous': 'R' },
    risk_tier:                              { 'Advisory-only': 'C', 'Supervised HITL': 'R', 'Autonomous': 'R' },
    owner:                                  { 'Advisory-only': 'R', 'Supervised HITL': 'R', 'Autonomous': 'R' },
    primary_success_metric:                 { 'Advisory-only': 'C', 'Supervised HITL': 'R', 'Autonomous': 'R' },
    baseline_cost_annual_usd:               { 'Advisory-only': 'O', 'Supervised HITL': 'C', 'Autonomous': 'R' },
    'volume_assumptions.monthly_requests':  { 'Advisory-only': 'C', 'Supervised HITL': 'R', 'Autonomous': 'R' },
    'volume_assumptions.peak_concurrency':  { 'Advisory-only': 'O', 'Supervised HITL': 'C', 'Autonomous': 'C' },
    readiness:                              { 'Advisory-only': 'R', 'Supervised HITL': 'R', 'Autonomous': 'R' },
  },
  agent: {
    name:                    { 'Advisory-only': 'R', 'Supervised HITL': 'R', 'Autonomous': 'R' },
    scope:                   { 'Advisory-only': 'R', 'Supervised HITL': 'R', 'Autonomous': 'R' },
    instructions:            { 'Advisory-only': 'R', 'Supervised HITL': 'R', 'Autonomous': 'R' },
    goals:                   { 'Advisory-only': 'R', 'Supervised HITL': 'R', 'Autonomous': 'R' },
    done_criteria:           { 'Advisory-only': 'C', 'Supervised HITL': 'R', 'Autonomous': 'R' },
    supervision_model:       { 'Advisory-only': 'R', 'Supervised HITL': 'R', 'Autonomous': 'R' },
    orchestration_strategy:  { 'Advisory-only': 'C', 'Supervised HITL': 'C', 'Autonomous': 'R' },
    maintenance_owner:       { 'Advisory-only': 'C', 'Supervised HITL': 'R', 'Autonomous': 'R' },
    latency_target:          { 'Advisory-only': 'O', 'Supervised HITL': 'C', 'Autonomous': 'R' },
    post_release_validation: { 'Advisory-only': 'C', 'Supervised HITL': 'R', 'Autonomous': 'R' },
    design_risks:            { 'Advisory-only': 'C', 'Supervised HITL': 'R', 'Autonomous': 'R' },
    memory_strategy:         { 'Advisory-only': 'O', 'Supervised HITL': 'C', 'Autonomous': 'R' },
    cost_model:              { 'Advisory-only': 'O', 'Supervised HITL': 'C', 'Autonomous': 'R' },
  },
  workflow: {
    // Workflows have no supervision_model column; the reviewer defaults to
    // the linked use case's mode (or 'Supervised HITL' if none).
    name:              { 'Advisory-only': 'R', 'Supervised HITL': 'R', 'Autonomous': 'R' },
    'trigger.type':    { 'Advisory-only': 'R', 'Supervised HITL': 'R', 'Autonomous': 'R' },
    'trigger.system':  { 'Advisory-only': 'C', 'Supervised HITL': 'R', 'Autonomous': 'R' },
    risk_tier:         { 'Advisory-only': 'C', 'Supervised HITL': 'R', 'Autonomous': 'R' },
    runs_per_period:   { 'Advisory-only': 'C', 'Supervised HITL': 'R', 'Autonomous': 'R' },
    sla_hours:         { 'Advisory-only': 'O', 'Supervised HITL': 'C', 'Autonomous': 'R' },
    fallback_paths:    { 'Advisory-only': 'C', 'Supervised HITL': 'R', 'Autonomous': 'R' },
    readiness:         { 'Advisory-only': 'R', 'Supervised HITL': 'R', 'Autonomous': 'R' },
  },
};

/**
 * Return all fields rated R (Required) for the given entity type and mode.
 * Used by the stub reviewer + by the live reviewer's grounded-context block.
 */
function requiredFieldsForMode(entityType, supervisionMode) {
  const entityMatrix = REQUIRED_BY_MODE[entityType];
  if (!entityMatrix) return [];
  const mode = supervisionMode || 'Supervised HITL';  // safe default
  const out = [];
  for (const [field, modes] of Object.entries(entityMatrix)) {
    if (modes[mode] === 'R') out.push(field);
  }
  return out;
}

module.exports = { REQUIRED_BY_MODE, requiredFieldsForMode };
