// agent/sn-catalog.js
// ─────────────────────────────────────────────────────────────────────────────
// Single source of truth for the ServiceNow target-table catalog.
//
// Both the read-only ASSESSMENT (sn-assess.js — what to probe + count) and the
// EXTRACTION capture (sn-capture.js — what to pull) read this catalog. Supporting a
// new instance shape, plugin, or platform version is purely additive here: add a row.
//
// Each entry declares:
//   table            SN metadata table name (the capability/feature probe target)
//   captureType      the design_type tag stamped on captured artifacts (sn-capture
//                    behavior — DO NOT rename; classify/hash/reconcile key on it)
//   wbDesignType     the Workbench design entity this surface maps to (coverage map)
//   mappingStatus    'mapped' | 'partial' | 'unmapped' — how well the Workbench can
//                    represent this surface today (drives the fit/coverage report)
//   partialIntent    for 'partial' rows only: 'by-intent' (lossy on purpose — this is
//                    ServiceNow-owned implementation we only summarise; partial is
//                    CORRECT) vs 'gap' (a fidelity gap to close because the Workbench is
//                    the authoring surface). Decisions confirmed 2026-06-15.
//   fields           salient fields captured + hashed for identity/change-detection
//   complexityWeight relative reverse-engineer effort per record (cost estimate)
//   featureNote      human-readable note about the plugin/feature this surface implies
'use strict';

const SN_CATALOG = [
  { table: 'sn_aia_agent',       captureType: 'agent',          wbDesignType: 'agent_spec',     mappingStatus: 'mapped',
    fields: ['name', 'role', 'description', 'instructions'], complexityWeight: 1.5,
    featureNote: 'AI Agents (Now Assist) — sn_aia_* plugin' },
  { table: 'sn_aia_usecase',     captureType: 'use_case',       wbDesignType: 'use_case',       mappingStatus: 'mapped',
    fields: ['name', 'description'], complexityWeight: 1,
    featureNote: 'AI Agents use cases' },
  { table: 'sn_aia_tool',        captureType: 'tool',           wbDesignType: 'tool',           mappingStatus: 'mapped',
    fields: ['name', 'type', 'description'], complexityWeight: 1,
    featureNote: 'AI Agents tools' },
  { table: 'sys_db_object',      captureType: 'data_model',     wbDesignType: 'data_model',     mappingStatus: 'mapped',
    fields: ['name', 'label', 'super_class'], complexityWeight: 2,
    featureNote: 'Tables/data models (column detail via sys_dictionary)' },
  // ── Tier C — implementation code. Captured for drift detection; NOT design intent. ────
  // These demoted from Tier A (2026-06-25): edit directly in ServiceNow, not via Build Spec.
  { table: 'sys_script',         captureType: 'business_rule',  wbDesignType: 'business_logic', mappingStatus: 'mapped',   tier: 'C',
    fields: ['name', 'collection', 'when', 'condition', 'script'], complexityWeight: 1.5,
    featureNote: 'Server-side business rules — implementation code; captured for drift, not design intent' },
  { table: 'sys_script_client',  captureType: 'client_script',  wbDesignType: 'business_logic', mappingStatus: 'partial',  tier: 'C', partialIntent: 'by-intent',
    fields: ['name', 'table', 'type', 'script'], complexityWeight: 1,
    featureNote: 'Client scripts — implementation code; business intent captured, cosmetic ones dropped by materiality' },
  { table: 'sys_script_include', captureType: 'script_include', wbDesignType: 'business_logic', mappingStatus: 'mapped',   tier: 'C',
    fields: ['name', 'script'], complexityWeight: 1.5,
    featureNote: 'Script includes (reusable server logic) — implementation code; captured for drift' },
  { table: 'sys_ui_action',      captureType: 'ui_action',      wbDesignType: 'business_logic', mappingStatus: 'partial',  tier: 'C', partialIntent: 'by-intent',
    fields: ['name', 'table', 'script'], complexityWeight: 1,
    featureNote: 'UI actions — implementation code; business intent captured, cosmetic ones dropped by materiality' },
  { table: 'sys_ui_policy',      captureType: 'ui_policy',      wbDesignType: 'form_design',    mappingStatus: 'partial',  tier: 'C', partialIntent: 'by-intent',
    fields: ['short_description', 'table'], complexityWeight: 1,
    featureNote: 'UI policies — form behaviour authored in ServiceNow; captured for drift, not design intent' },
  { table: 'sys_ui_form',        captureType: 'form',           wbDesignType: 'form_design',    mappingStatus: 'mapped',
    fields: ['name', 'view'], complexityWeight: 1,
    featureNote: 'Forms / views' },
  { table: 'sc_cat_item',        captureType: 'catalog_item',   wbDesignType: 'catalog_item',   mappingStatus: 'mapped',
    fields: ['name', 'short_description'], complexityWeight: 1,
    featureNote: 'Service catalog items' },
  { table: 'sys_hub_flow',       captureType: 'flow',           wbDesignType: 'workflow',       mappingStatus: 'partial', partialIntent: 'gap',
    fields: ['name'], complexityWeight: 2,
    featureNote: 'Flow Designer flows — header only today; step capture planned so swimlanes/RASIC auto-derive (fidelity gap to close)' },
  { table: 'sys_rest_message',   captureType: 'rest_message',   wbDesignType: 'integration',    mappingStatus: 'mapped',
    fields: ['name', 'rest_endpoint', 'authentication_type', 'description'], complexityWeight: 1,
    featureNote: 'Outbound HTTP integrations (REST Message). SDK v4.8+: deployable via RestMessage() Fluent API.' },
  { table: 'sys_alias',          captureType: 'connection_alias', wbDesignType: 'integration',  mappingStatus: 'mapped',
    fields: ['name', 'type', 'connection_type', 'description'], complexityWeight: 0.5,
    featureNote: 'Connection & Credential Aliases — named handles for integration credentials. SDK v4.8+: deployable via Alias() Fluent API.' },
];

// Complexity-only probes — counted to estimate import VOLUME, not captured directly.
// `parent` documents which catalog surface drives the count (for the report copy).
const SN_COMPLEXITY_PROBES = [
  { table: 'sys_hub_action_instance', parent: 'sys_hub_flow',  label: 'Flow action steps',
    note: 'Workflow steps per flow — drives the workflow_step materialisation volume' },
  { table: 'sys_dictionary',          parent: 'sys_db_object', label: 'Table columns',
    note: 'Field definitions across captured tables — drives data_model field volume' },
];

// Back-compat shape for sn-capture.js: [{ table, type, fields }].
// Sourced from the catalog so the capture surface list stays in lockstep.
const SN_SURFACES = SN_CATALOG.map(c => ({ table: c.table, type: c.captureType, fields: c.fields }));

// Normalize a user-entered instance URL into a fetchable base: trim, drop trailing
// slashes, and prepend https:// when the scheme is missing (a common entry mistake —
// fetch() throws "Failed to parse URL" on a scheme-less host).
function normalizeInstanceUrl(instance) {
  let base = String(instance || '').trim().replace(/\/+$/, '');
  if (base && !/^https?:\/\//i.test(base)) base = 'https://' + base;
  return base;
}

// Set of SN tables demoted to Tier C (implementation artifacts, not design intent).
// Used by Build Spec renderer and frontend to classify captured rows.
const SN_TIER_C_TABLES = new Set(SN_CATALOG.filter(e => e.tier === 'C').map(e => e.table));

module.exports = { SN_CATALOG, SN_COMPLEXITY_PROBES, SN_SURFACES, SN_TIER_C_TABLES, normalizeInstanceUrl };
