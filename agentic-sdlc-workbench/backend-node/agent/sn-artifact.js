// agent/sn-artifact.js
// ─────────────────────────────────────────────────────────────────────────────
// The deterministic CAPTURED-ARTIFACT → GENERIC-ARTIFACT-RECORD transform.
//
// For Tier-B/C surfaces (anything without a rich Level-1 business mapping) we do NOT
// run the Opus reverse-engineer/reconcile/review stages — the generic artifact is a
// faithful, deterministic snapshot of the ServiceNow record, keyed by its SDK metadata
// type and carrying full Level-2 provenance. This is the function that kills the old
// `design_type:'other'` black hole: nothing captured is ever dropped — it becomes a row
// in asdlc_sn_artifact, always deployable via the resolved Fluent constructor or the
// generic Record() fallback.
//
// PURE + exported (no DB writes) so it is offline-testable. The materializer
// (server.js mtCreateArtifact) consumes the record; parent_source_sys_id is resolved
// to parent_artifact_id at materialize time.
'use strict';
const reg = require('./sn-type-registry');

// Provenance / system keys must never live inside the payload (they are columns).
const NON_PAYLOAD_KEYS = new Set([
  'sys_id', 'source_sys_id', 'source_system', 'source_table', 'source_scope',
  'source_fluent', 'source_hash', 'sdk_version',
]);

/**
 * Build a generic artifact record from one captured ServiceNow artifact.
 * Accepts the shape produced by sn-capture (`{source_table, design_type, source_sys_id,
 * name, salient|payload, hash, parent_source_sys_id?, child_role?, child_order?}`).
 *
 * @param {object} artifact  captured artifact
 * @param {object} [opts]    {scope, sdkVersion, sourceFluent}
 * @returns {object} a record ready for the generic materializer (see asdlc_sn_artifact)
 */
function buildArtifactRecord(artifact, opts = {}) {
  const a = artifact || {};
  const entry = reg.resolveType(a.source_table || a.sn_metadata_type || a.design_type);

  // The full captured field map is the round-trip body. $override splitting (typed-API
  // vs unknown fields) is a deploy-time concern (Phase 3) once we know the constructor's
  // known field set — at capture time everything lives in payload, override_fields empty.
  const src = a.payload || a.salient || {};
  const payload = {};
  for (const [k, v] of Object.entries(src)) {
    if (NON_PAYLOAD_KEYS.has(k)) continue;
    if (v === undefined) continue;
    payload[k] = v;
  }
  const override_fields = {};

  return {
    sn_metadata_type: entry.sn_metadata_type,
    fluent_api_name: entry.fluent_api_name || null,
    deploy_strategy: reg.deployStrategyFor(entry, override_fields),
    tier: entry.tier,
    name: a.name || payload.name || payload.label || '(unnamed)',
    payload,
    override_fields,
    projected_entity_type: entry.projected_entity_type || null,
    // Resolved to parent_artifact_id at materialize time (via the run's artifactIdMap
    // or a DB lookup by source_sys_id). child_role falls back to the registry's role.
    parent_source_sys_id: a.parent_source_sys_id || null,
    child_role: a.child_role || entry.child_role || null,
    child_order: (a.child_order != null) ? a.child_order : null,
    // ── Level-2 provenance ──
    source_system: 'servicenow',
    source_sys_id: a.source_sys_id || null,
    source_table: a.source_table || entry.source_table || null,
    source_scope: opts.scope || null,
    source_fluent: opts.sourceFluent || a.source_fluent || null,
    source_hash: a.hash || a.source_hash || null,
    sdk_version: opts.sdkVersion || null,
  };
}

/**
 * True when a captured surface should take the GENERIC path (Tier B/C) rather than the
 * rich Level-1 business path (Tier A). Tier-A surfaces still flow through the existing
 * reverse-engineer→reconcile→review pipeline and project onto their L1 table.
 */
function isGenericSurface(tableOrType) {
  const entry = reg.resolveType(tableOrType);
  return entry.tier !== 'A';
}

module.exports = { buildArtifactRecord, isGenericSurface, NON_PAYLOAD_KEYS };
