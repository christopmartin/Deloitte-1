// agent/sn-type-registry.js
// ─────────────────────────────────────────────────────────────────────────────
// Read-side ACCESSOR/RESOLVER over the SDK capability registry (asdlc_sn_type_registry).
//
// This module deliberately does NOT hard-code the type list — that snapshot is
// derived from the installed SDK by agent/sn-capability-sync.js. Here we only resolve
// a captured ServiceNow surface (by SN table or metadata type) to its deploy contract,
// and answer the questions the capture / materialize / deploy pipeline asks:
//
//   resolveType(tableOrType) → the registry row, or the Tier-C generic default
//   deployStrategyFor(entry, override) → 'typed' | 'record' | 'override' for an artifact row
//   childTypesOf(snType) → the sub-element types (columns, variables, …) of a parent
//   capabilityStatus()  → installed-SDK vs. registry-snapshot drift (refresh hint)
//
// A small in-memory cache is loaded once and cleared by refresh() (which
// sn-capability-sync calls after a re-scan), so per-artifact resolution in tight
// capture loops stays cheap.
'use strict';
const { db } = require('../db');

// The generic Record() fallback contract for anything the SDK catalog doesn't know.
// Guarantees every artifact is representable + deployable even with zero registry coverage.
const TIER_C_DEFAULT = Object.freeze({ tier: 'C', deploy_strategy: 'record', fluent_api_name: null });

let _byType = null;     // Map sn_metadata_type -> row
let _byTable = null;    // Map source_table -> row (first wins on collisions)
let _children = null;   // Map parent_type -> [rows]
let _seedAttempted = false;

function load() {
  if (_byType) return;
  _byType = new Map(); _byTable = new Map(); _children = new Map();
  let rows = [];
  try { rows = db.prepare('SELECT * FROM asdlc_sn_type_registry').all(); }
  catch { rows = []; }   // table not migrated yet — resolver degrades to Tier-C default
  // One-time lazy seed: a fresh DB has the (empty) table from schema.sql but no rows.
  // Populate it from the checked-in baseline JSON so types resolve even when the SDK
  // isn't installed; a later syncCapabilities() refreshes against the live SDK. Guarded
  // to a single attempt per process and never fatal (Tier-C default covers any failure).
  if (!rows.length && !_seedAttempted) {
    _seedAttempted = true;
    try { require('./sn-capability-sync').seedFromBaseline(); rows = db.prepare('SELECT * FROM asdlc_sn_type_registry').all(); }
    catch { /* no baseline / no table — resolver still works via the Tier-C default */ }
  }
  for (const r of rows) {
    _byType.set(r.sn_metadata_type, r);
    if (r.source_table && !_byTable.has(r.source_table)) _byTable.set(r.source_table, r);
    if (r.parent_type) {
      if (!_children.has(r.parent_type)) _children.set(r.parent_type, []);
      _children.get(r.parent_type).push(r);
    }
  }
}

/** Clear the cache so the next resolve reflects a fresh capability sync. */
function refresh() { _byType = _byTable = _children = null; }

/** Slugify an unknown SN table into a stable metadata-type key for the Tier-C default. */
function typeKeyForTable(table) {
  return String(table || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

/**
 * Resolve a captured surface to its deploy contract. Accepts either an SN source table
 * (e.g. 'sys_security_acl') or an sn_metadata_type (e.g. 'acl'). Never throws: an
 * unknown surface returns the Tier-C generic Record() default so capture/deploy always
 * has a path. Includes a `known` flag so callers can tell catalog hits from the fallback.
 */
function resolveType(tableOrType) {
  load();
  const key = String(tableOrType || '').trim();
  let row = _byType.get(key) || _byTable.get(key) || null;
  if (row) {
    // Backward safety: a 'typed' row with no resolvable constructor (e.g. the installed
    // SDK is older than the snapshot) must fall back to Record() rather than emit an
    // API the local SDK lacks.
    const deploy_strategy = (row.deploy_strategy === 'typed' && !row.fluent_api_name) ? 'record' : row.deploy_strategy;
    return { ...row, deploy_strategy, known: true };
  }
  // Unknown to the catalog → generic Record() fallback keyed off the table name.
  const looksLikeTable = /_/.test(key) || /^(sys|sn|sc|sp|dl|par|cmdb|wf|core)_/.test(key);
  return {
    sn_metadata_type: looksLikeTable ? typeKeyForTable(key) : key || 'unknown',
    source_table: looksLikeTable ? key : null,
    explain_topic: null, projected_entity_type: null, parent_type: null, child_role: null,
    fluent_api_name: null, ...TIER_C_DEFAULT, known: false,
  };
}

/**
 * The deploy_strategy to STORE on an artifact row, folding in whether it carries
 * $override fields. 'typed' constructors can always take a trailing .override({…}),
 * so they stay 'typed'; a generic Record() that needs extra fields becomes 'override'.
 */
function deployStrategyFor(entry, overrideFields) {
  const base = (entry && entry.deploy_strategy) || 'record';
  const hasOverride = overrideFields && Object.keys(overrideFields).length > 0;
  if (base === 'typed') return 'typed';
  return hasOverride ? 'override' : 'record';
}

/** Sub-element types (e.g. columns of a table, variables of a catalog item) of a parent type. */
function childTypesOf(snType) {
  load();
  return (_children.get(snType) || []).slice();
}

/** Look up a single registry row by metadata type (null if unknown). */
function getType(snMetadataType) {
  load();
  return _byType.get(String(snMetadataType || '')) || null;
}

/** All registry rows (a shallow copy). */
function allTypes() {
  load();
  return Array.from(_byType.values());
}

/**
 * Compare the installed SDK version to the version the registry snapshot was scanned
 * from. A mismatch is a soft signal ("capability refresh recommended"), never a failure.
 * @param {string|null} installedVersion  pass the detected SDK version (see sn-capability-sync)
 */
function capabilityStatus(installedVersion) {
  load();
  const rows = Array.from(_byType.values());
  const snapshot = rows.length ? rows[0].sdk_version : null;
  const stale = !!(installedVersion && snapshot && installedVersion !== snapshot);
  return { types: rows.length, snapshotVersion: snapshot, installedVersion: installedVersion || null, refreshRecommended: stale || rows.length === 0 };
}

module.exports = {
  resolveType, deployStrategyFor, childTypesOf, getType, allTypes, capabilityStatus, refresh,
  TIER_C_DEFAULT,
};
