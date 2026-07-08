// agent/sn-direct-map.js
// ─────────────────────────────────────────────────────────────────────────────
// DETERMINISTIC direct field-mapping for ServiceNow record types whose Level-1
// design schema is (near-)literal ServiceNow data — no AI interpretation required.
//
// WHY: the Opus reverse-engineer step costs ~9s / ~$0.05 PER RECORD and is the
// import time/cost driver (backlog #101). But change detection and conflict
// resolution are 100% deterministic (raw-field hash + sys_mod_count + raw
// source_fluent snapshot — they never read the AI narrative), and round-trip
// identity rides source_sys_id. So for record types whose fields are a direct copy
// of ServiceNow data, the AI narrative buys nothing for fidelity or conflict — it
// is human-comprehension only. This module produces the SAME `entity_data` shape the
// forward `extract_*` tools emit, straight from the raw capture, with ZERO AI.
//
// Scope (the rich SN_CATALOG types that hit — or stub through — reverseEngineerOne):
//   • catalog_item, data_model, form_design, rest_message, connection_alias
//       → full direct field-copy (Part A). Soft narrative fields (purpose;
//         form_design's `behavior_notes` on the FORM row itself) are intentionally
//         left blank — not needed for fidelity or conflict, confirmed by the
//         round-trip fidelity assessment. form_design's sections/mandatory_fields/
//         readonly_fields ARE literal ServiceNow data (sys_ui_form_section /
//         sys_ui_element / sys_ui_policy_action) and are captured deterministically
//         (#105) — only a plain-English behavior summary would need AI.
//   • business_logic (sys_script / _client / _include / sys_ui_action, ~60% of a
//       typical scope) → deterministic name + logic_type ONLY; the plain-English
//       narrative (plain_english / when_runs / conditions) is left BLANK and is
//       filled ON REQUEST via the "Explain with AI" action (Part B). The raw script
//       is preserved in source_fluent regardless (drift + redeploy don't need AI).
//
// Genuinely interpretive types (agent_spec / use_case / tool — Now Assist) and the
// header-only workflow (sys_hub_flow, gap #66) are NOT handled here — they keep the
// Opus path.
//
// This module is intentionally dependency-free (predicates + plain object builders)
// so `sn-reverse-engineer.js` can require it without a cycle; the envelope wrapping
// (buildInferred) happens in the caller.
'use strict';

// SN source table → the registry design/entity type used to materialize it.
// NOTE rest_message/connection_alias are NOT in sn-reverse-engineer's SN_TABLE_TO_TYPE,
// so today they resolve to 'other' → stub (a thin name-only skeleton). Direct-mapping
// them here is a pure fidelity gain (real captured fields) at zero AI cost.
const DET_TABLE_TO_TYPE = {
  sc_cat_item: 'catalog_item',
  sys_db_object: 'data_model',
  sys_ui_form: 'form_design',
  sys_ui_policy: 'form_design',
  sys_rest_message: 'rest_message',
  sys_alias: 'connection_alias',
  sys_script: 'business_logic',
  sys_script_client: 'business_logic',
  sys_script_include: 'business_logic',
  sys_ui_action: 'business_logic',
};

const LOGIC_TYPE = {
  sys_script: 'business_rule', sys_script_client: 'client_script',
  sys_script_include: 'script_include', sys_ui_action: 'ui_action',
};

// A record type is "deterministic" (bypasses the Opus reverse-engineer call) iff its
// SN source table is in the map above. Used by sn-reverse-engineer (short-circuit) and
// sn-sync (route changed records around the Opus reconcile/review too).
function isDeterministicTable(sourceTable) {
  return !!DET_TABLE_TO_TYPE[sourceTable];
}
function isBusinessLogicTable(sourceTable) {
  return !!LOGIC_TYPE[sourceTable];
}

// ── helpers ──────────────────────────────────────────────────────────────────
function nz(v) { return (v === undefined || v === null || v === '') ? undefined : v; }
function childrenOf(artifact, childTable) {
  return (artifact && Array.isArray(artifact._children) ? artifact._children : [])
    .filter(c => c && c.source_table === childTable)
    .sort((a, b) => (a.child_order ?? 0) - (b.child_order ?? 0));
}

// ── per-table entity_data builders (shape MUST match the forward extract_* tool) ──
function catalogItem(a) {
  const s = a.salient || {};
  const variables = childrenOf(a, 'item_option_new').map(c => {
    const p = c.payload || c.salient || {};
    return {
      label: p.question_text || p.name || c.name || '(unnamed)',
      type_business: nz(p.type),          // raw SN type code — best-effort, still faithful
      mandatory: p.mandatory === 'true' || p.mandatory === true || p.mandatory === '1',
      help: nz(p.help_text),
    };
  });
  return {
    name: s.name || a.name,
    short_description: nz(s.short_description),
    category: nz(s.category),             // display value (captured with sysparm_display_value)
    workflow_name: nz(s.workflow),        // fulfillment flow → resolves the workflow parentLink
    ...(variables.length ? { variables } : {}),
    // who_can_order / delivery_time have no clean single-field SN source → left blank
  };
}

function dataModel(a) {
  const s = a.salient || {};
  const fields = childrenOf(a, 'sys_dictionary').map(c => {
    const p = c.payload || c.salient || {};
    return {
      label: p.column_label || p.element || c.name || '(unnamed)',
      type_business: nz(p.internal_type),
      mandatory: p.mandatory === 'true' || p.mandatory === true || p.mandatory === '1',
      references: nz(p.reference),
    };
  });
  return {
    name: s.label || s.name || a.name,    // business label preferred
    physical_name: nz(s.name),            // the actual SN table name
    extends_table: nz(s.super_class),
    ...(fields.length ? { fields } : {}),
    // purpose (soft narrative) intentionally left blank
  };
}

// True-ish helper for ServiceNow's string/boolean-mixed choice flags ('true'/'1'/true).
function truthy(v) { return v === true || v === 'true' || v === '1'; }
// UI Policy Action's target-field column name isn't confirmed from a live schema probe
// (instance auth wasn't available) — check the plausible candidates defensively rather
// than hard-coding a guess that could silently capture nothing.
function actionFieldName(p) { return p.field || p.field_name || p.element || undefined; }

function formDesign(a) {
  const s = a.salient || {};
  if (a.source_table === 'sys_ui_policy') {
    // A UI policy captured as its own form_design row: fold its linked policy-action
    // children into real mandatory/read-only field lists instead of leaving them blank.
    const actions = childrenOf(a, 'sys_ui_policy_action').map(c => c.payload || c.salient || {});
    const mandatory_fields = [...new Set(actions.filter(p => truthy(p.mandatory)).map(actionFieldName).filter(Boolean))];
    const readonly_fields = [...new Set(actions.filter(p => truthy(p.read_only) || truthy(p.disabled) || truthy(p.readonly)).map(actionFieldName).filter(Boolean))];
    const behavior_notes = [s.short_description, nz(s.conditions) && `when: ${s.conditions}`].filter(Boolean).join(' — ');
    return {
      name: s.short_description || a.name,
      ...(mandatory_fields.length ? { mandatory_fields } : {}),
      ...(readonly_fields.length ? { readonly_fields } : {}),
      ...(behavior_notes ? { behavior_notes } : {}),
    };
    // behavior_notes here is a factual composite (short_description + raw condition), not
    // an AI narrative — a plain-English rewrite is still an "Explain with AI" candidate.
  }
  // sys_ui_form: fold section-join children (with their dot-walked caption) and each
  // section's element children into the sections[] shape extract_form_design expects.
  const sections = childrenOf(a, 'sys_ui_form_section').map(sec => {
    const p = sec.payload || sec.salient || {};
    const section_label = p['sys_ui_section.caption'] || p['sys_ui_section.name'] || undefined;
    const fields = childrenOf(sec, 'sys_ui_element').map(el => actionFieldName(el.payload || el.salient || {})).filter(Boolean);
    return { ...(section_label ? { section_label } : {}), ...(fields.length ? { fields } : {}) };
  }).filter(sec => sec.section_label || sec.fields);
  return {
    name: s.name || a.name,
    view_name: nz(s.view),
    ...(sections.length ? { sections } : {}),
  };
}

function restMessage(a) {
  const s = a.salient || {};
  return {
    integration_type: 'rest_message',
    name: s.name || a.name,
    description: nz(s.description),
    endpoint: nz(s.rest_endpoint),
    auth_type: nz(s.authentication_type),
    // functions (sys_rest_message_fn children) not captured today → blank
  };
}

function connectionAlias(a) {
  const s = a.salient || {};
  return {
    integration_type: 'connection_alias',
    name: s.name || a.name,
    description: nz(s.description),
    connection_type: nz(s.connection_type),
    // alias_type not cleanly derivable from a single field → blank
  };
}

function businessLogic(a) {
  // DELIBERATELY narrative-free: name + logic_type only. plain_english / when_runs /
  // conditions are left blank and filled ON REQUEST ("Explain with AI"). The raw
  // script rides source_fluent (set deterministically downstream), so drift detection
  // and redeploy are unaffected.
  return { name: a.name, logic_type: LOGIC_TYPE[a.source_table] || 'business_rule' };
}

const BUILDERS = {
  sc_cat_item: catalogItem,
  sys_db_object: dataModel,
  sys_ui_form: formDesign,
  sys_ui_policy: formDesign,
  sys_rest_message: restMessage,
  sys_alias: connectionAlias,
  sys_script: businessLogic,
  sys_script_client: businessLogic,
  sys_script_include: businessLogic,
  sys_ui_action: businessLogic,
};

/**
 * Build a deterministic { designType, entity_data } for a captured artifact whose type
 * is direct-mappable, or null if the type is not deterministic (→ keep the Opus path).
 * entity_data matches the forward extract_<designType> tool's output keys, so the caller
 * can wrap it with the existing `buildInferred` and the downstream materializer is unchanged.
 */
function directMapArtifact(artifact) {
  if (!artifact || !artifact.source_table) return null;
  const designType = DET_TABLE_TO_TYPE[artifact.source_table];
  const build = BUILDERS[artifact.source_table];
  if (!designType || !build) return null;
  return { designType, entity_data: build(artifact) };
}

module.exports = {
  DET_TABLE_TO_TYPE,
  isDeterministicTable,
  isBusinessLogicTable,
  directMapArtifact,
};
