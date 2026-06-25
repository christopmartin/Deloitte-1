/**
 * modules/design_review.js — Agent Design Report
 *
 * Human-readable, printable report of agent design content
 * aligned to a selected application.  Start scope: Agents.
 */
import { apiFetch, el, escHtml, getCurrentProjectId, navigate, setDrillDown, consumeDrillDown, showToast, loadCatalog } from '../app.js';

// ─── config-driven design-entity catalog (backend = single source of truth) ────
// Populated in render() from /design-entity-catalog. Merged into EDIT_CONFIGS /
// REPORT_META / SCOPES / detectTypeKey / DATA_KEY_MAP so new Tier-A entities are
// viewable + editable with NO per-entity frontend code. Hardcoded entries always win.
let _catalog = [];
function registerCatalog(catalog) {
  _catalog = catalog || [];
  for (const c of _catalog) {
    if (!EDIT_CONFIGS[c.entity_type]) {
      EDIT_CONFIGS[c.entity_type] = {
        endpoint: (pid, eid) => `/projects/${pid}/${c.rest_path}/${eid}`,
        createEndpoint: (pid) => `/projects/${pid}/${c.rest_path}`,
        idKey: c.id_key, nameKey: c.name_key, label: c.label,
        fields: c.fields || [], _dynamic: true, _entityType: c.entity_type,
      };
    }
    if (!REPORT_META[c.scope_id]) {
      REPORT_META[c.scope_id] = { title: `${c.label}s`, noun: c.label.toLowerCase() };
    }
  }
}
function catalogByScope(scopeId) { return _catalog.find(c => c.scope_id === scopeId) || null; }

// ─── module-level state ───────────────────────────────────────────────────────
let _docDrawer = null;
let _docDrawerIngestId = null;
let _currentProjectId  = null;  // set in loadReport; used by edit buttons
let _currentReportArea = null;  // reference to area DOM node for reload
let _exceptionsByEntity = {};   // Phase 2 data-quality: { entityType: { entityId: [exception,...] } }
let _qualityPanel = null;       // Feature #9: findings panel container
let _currentScope = null;       // set in loadReport; used to refresh panels

// ─── Required-By-Mode matrix (Phase 5, Decision #8 Option B) ─────────────────
// Methodology guidance — no enforcement. Codes: R=Required, C=Conditional, O=Optional.
// Keyed by entity type → field key → supervision mode → code.
// Modes match the agreed 3-value enum from Decision #2.
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
    // Workflows have no supervision_model column; matrix shown side-by-side for reference.
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
const RBM_CODE_META = {
  R: { label: 'Required',    color: '#d32f2f', bg: '#ffebee' },
  C: { label: 'Conditional', color: '#e65100', bg: '#fff3e0' },
  O: { label: 'Optional',    color: '#2e7d32', bg: '#e8f5e9' },
};

// ─── edit configuration (data-driven, easy to extend) ────────────────────────
const EDIT_CONFIGS = {
  use_case: {
    endpoint: (pid, eid) => `/projects/${pid}/use-cases/${eid}`,
    idKey:    'use_case_id',
    nameKey:  'title',
    label:    'Use Case',
    fields: [
      { key: 'title',                    label: 'Title',                                   type: 'text'      },
      { key: 'summary',                  label: 'Summary',                                 type: 'textarea'  },
      { key: 'business_objective',       label: 'Business Objective',                      type: 'textarea'  },
      { key: 'expected_value',           label: 'Expected Value',                          type: 'textarea'  },
      { key: 'success_criteria',         label: 'Success Criteria (one per line)',         type: 'json-list' },
      { key: 'constraints_list',         label: 'Constraints (one per line)',              type: 'json-list' },
      // Phase 1 (Decisions #2, #6, #7, #17)
      { key: 'supervision_model',        label: 'Supervision Model',                       type: 'select',
        options: ['Advisory-only', 'Supervised HITL', 'Autonomous'] },
      { key: 'risk_tier',                label: 'Risk Tier',                               type: 'select',
        options: ['High', 'Medium', 'Low'] },
      { key: 'owner',                    label: 'Owner',                                   type: 'text'      },
      { key: 'primary_success_metric',   label: 'Primary Success Metric (e.g. AHT: 12 min → 4 min)', type: 'text' },
      { key: 'baseline_cost_annual_usd', label: 'Baseline Cost / Year (USD)',              type: 'number', step: '1000', min: 0 },
      // Volume assumptions — structured sub-form; see also workflow.runs_per_period (cost driver)
      { key: 'volume_assumptions.monthly_requests', label: 'Volume — Monthly Requests',    type: 'number', step: '1', min: 0 },
      { key: 'volume_assumptions.peak_concurrency', label: 'Volume — Peak Concurrency',    type: 'number', step: '1', min: 0 },
      { key: 'volume_assumptions.peak_period',      label: 'Volume — Peak Period (e.g. "Mon 9-11am")', type: 'text' },
      { key: 'volume_assumptions.notes',            label: 'Volume — Notes / Other Assumptions',       type: 'textarea' },
      // epic_or_feature_id deferred from UI (Decision #4: kept in DB, hidden in UI)
      { key: 'readiness',                label: 'Readiness',                               type: 'select',
        options: ['draft', 'in_review', 'approved', 'rejected'] },
    ],
  },
  // ── ServiceNow round-trip: Level-1 design types ──
  data_model: {
    endpoint: (pid, eid) => `/projects/${pid}/data-models/${eid}`,
    idKey: 'data_model_id', nameKey: 'name', label: 'Data Model',
    fields: [
      { key: 'name',          label: 'Name',                  type: 'text'     },
      { key: 'purpose',       label: 'Purpose',               type: 'textarea' },
      { key: 'physical_name', label: 'ServiceNow Table Name', type: 'text'     },
      { key: 'extends_table', label: 'Extends Table',         type: 'text'     },
    ],
  },
  form_design: {
    endpoint: (pid, eid) => `/projects/${pid}/form-designs/${eid}`,
    idKey: 'form_design_id', nameKey: 'name', label: 'Form Design',
    fields: [
      { key: 'name',             label: 'Name',                            type: 'text'      },
      { key: 'view_name',        label: 'View',                            type: 'text'      },
      { key: 'mandatory_fields', label: 'Mandatory Fields (one per line)', type: 'json-list' },
      { key: 'readonly_fields',  label: 'Read-only Fields (one per line)', type: 'json-list' },
      { key: 'behavior_notes',   label: 'Behavior Notes',                  type: 'textarea'  },
    ],
  },
  business_logic: {
    endpoint: (pid, eid) => `/projects/${pid}/business-logic/${eid}`,
    idKey: 'business_logic_id', nameKey: 'name', label: 'Implementation Artifacts',
    fields: [
      { key: 'logic_type',    label: 'Type', type: 'select',
        options: ['business_rule', 'client_script', 'script_include', 'ui_action', 'scheduled_job', 'ui_policy'] },
      { key: 'name',          label: 'Name',                         type: 'text'     },
      { key: 'plain_english', label: 'What it does (plain English)', type: 'textarea' },
      { key: 'when_runs',     label: 'When it runs',                 type: 'text'     },
      { key: 'conditions',    label: 'Conditions',                   type: 'textarea' },
      { key: 'run_order',     label: 'Order',                        type: 'number'   },
    ],
  },
  catalog_item: {
    endpoint: (pid, eid) => `/projects/${pid}/catalog-items/${eid}`,
    idKey: 'catalog_item_id', nameKey: 'name', label: 'Catalog Item',
    fields: [
      { key: 'name',              label: 'Name',             type: 'text'     },
      { key: 'short_description', label: 'Short Description', type: 'textarea' },
      { key: 'category',          label: 'Category',         type: 'text'     },
      { key: 'who_can_order',     label: 'Who Can Order',    type: 'text'     },
      { key: 'delivery_time',     label: 'Delivery Time',    type: 'text'     },
    ],
  },
  integration: {
    endpoint: (pid, eid) => `/projects/${pid}/integrations/${eid}`,
    idKey: 'integration_id', nameKey: 'name', label: 'Integration',
    fields: [
      { key: 'name',            label: 'Name',            type: 'text'     },
      { key: 'description',     label: 'Description',     type: 'textarea' },
      { key: 'endpoint',        label: 'Endpoint',        type: 'text'     },
      { key: 'auth_type',       label: 'Auth Type',       type: 'select',
        options: ['noAuthentication', 'basic', 'oauth2'] },
      { key: 'alias_type',      label: 'Alias Type',      type: 'select',
        options: ['connection', 'credential'] },
      { key: 'connection_type', label: 'Connection Type', type: 'select',
        options: ['httpConnection', 'jdbcConnection', 'basicConnection', 'jmsConnection'] },
      { key: 'notes',           label: 'Notes',           type: 'textarea' },
    ],
  },
  workflow: {
    endpoint: (pid, eid) => `/projects/${pid}/workflows/${eid}`,
    idKey:    'workflow_id',
    nameKey:  'name',
    label:    'Workflow',
    fields: [
      { key: 'name',                       label: 'Name',                          type: 'text'      },
      { key: 'sla_hours',                  label: 'SLA Target (hours)',            type: 'number'    },
      { key: 'readiness',                  label: 'Readiness',                     type: 'select',
        options: ['draft', 'in_review', 'approved'] },
      // Phase 1 (Decisions #12, #17)
      { key: 'risk_tier',                  label: 'Risk Tier',                     type: 'select',
        options: ['High', 'Medium', 'Low'] },
      { key: 'runs_per_period',            label: 'Runs / Period (volume for cost calc)', type: 'number', step: '1', min: 0 },
      // Structured sub-form for trigger (API name) / trigger_def (DB column — see payloadAlias)
      { key: 'trigger.description',        label: 'Trigger — Description',         type: 'textarea' },
      { key: 'trigger.type',               label: 'Trigger — Type',                type: 'select',
        options: ['Manual', 'Record-based trigger', 'Now Assist Panel', 'UI Action', 'Automated/async', 'Timed'] },
      { key: 'trigger.system',             label: 'Trigger — System',              type: 'text'     },
      { key: 'trigger.event_name',         label: 'Trigger — Event Name',          type: 'text'     },
      { key: 'trigger.schedule',           label: 'Trigger — Schedule',            type: 'text'     },
      { key: 'fallback_paths',             label: 'Fallback Paths (one per line)', type: 'json-list' },
      // handoffs deferred — requires per-row editor (complex array of interaction objects)
    ],
    // API exposes the JSON column `trigger_def` as `trigger` on reads; rename on write.
    payloadAlias: { trigger: 'trigger_def' },
  },
  agent: {
    endpoint: (pid, eid) => `/projects/${pid}/agent-specs/${eid}`,
    idKey:    'agent_spec_id',
    nameKey:  'name',
    label:    'Agent',
    fields: [
      { key: 'name',                       label: 'Name',                                   type: 'text'      },
      { key: 'scope',                      label: 'Scope',                                  type: 'textarea'  },
      { key: 'instructions',               label: 'Prompt',                                 type: 'textarea', rows: 16,
        placeholder: "Full system prompt that controls this agent's behaviour. Use the \"✨ Draft Prompt\" button on the agent card to generate a starting point." },
      { key: 'goals',                      label: 'Goals (one per line)',                   type: 'json-list' },
      { key: 'done_criteria',              label: 'Done Criteria (one per line)',           type: 'json-list' },
      // Phase 1 additions (Decisions #2, #16, #17, #18)
      { key: 'supervision_model',          label: 'Supervision Model',                      type: 'select',
        options: ['Advisory-only', 'Supervised HITL', 'Autonomous'] },
      { key: 'orchestration_strategy',     label: 'Orchestration Strategy',                 type: 'select',
        options: ['Base Planner', 'ReActive Planner', 'Batch Planner'] },
      { key: 'maintenance_owner',          label: 'Maintenance Owner',                      type: 'text'      },
      { key: 'latency_target',             label: 'Latency Target (e.g. "p95 < 5s")',       type: 'text'      },
      { key: 'post_release_validation',    label: 'Post-Release Validation',                type: 'textarea'  },
      { key: 'cost_model',                 label: 'Cost Model',                             type: 'select',
        options: ['none', 'servicenow_now_assist'] },
      // Structured sub-form for run_as_model (stored as JSON object)
      { key: 'run_as_model.model_type',    label: 'Model Type',                             type: 'text'      },
      { key: 'run_as_model.trust_level',   label: 'Trust Level (1–5)',                      type: 'number',
        step: '1', min: 1, max: 5 },
      { key: 'run_as_model.rationale',     label: 'Model Rationale',                        type: 'textarea'  },
      { key: 'memory_strategy',            label: 'Memory Strategy',                        type: 'text'      },
      { key: 'design_risks',               label: 'Design Risks & Mitigations (one per line)', type: 'json-list' },
    ],
  },
  tool: {
    endpoint: (pid, eid) => `/projects/${pid}/tools/${eid}`,
    idKey:    'tool_id',
    nameKey:  'name',
    label:    'Tool',
    fields: [
      { key: 'name',                       label: 'Name',                type: 'text'     },
      { key: 'execution_mode',             label: 'Execution Mode',      type: 'select',
        options: ['synchronous', 'asynchronous', 'background'] },
      { key: 'cost_impact',                label: 'Cost Impact',         type: 'text'     },
      // Phase 1 (Decision #14)
      { key: 'dev_status',                 label: 'Dev Status',          type: 'select',
        options: ['Existing', 'To be built'] },
      // Structured sub-form for access_requirements (stored as JSON object)
      { key: 'access_requirements.role_required',       label: 'Role Required',        type: 'text'     },
      { key: 'access_requirements.data_classification', label: 'Data Classification',  type: 'text'     },
      { key: 'access_requirements.contains_pii',        label: 'Contains PII',         type: 'text'     },
      { key: 'access_requirements.rate_limit_per_min',  label: 'Rate Limit / Min',     type: 'text'     },
      // Structured sub-form for contract (stored as JSON object)
      { key: 'contract_description',       label: 'Description',         type: 'textarea' },
      { key: 'contract.endpoint_type',     label: 'Endpoint Type',       type: 'text'     },
      { key: 'contract.auth_method',       label: 'Auth Method',         type: 'text'     },
      { key: 'contract.base_url',          label: 'Base URL',            type: 'text'     },
      { key: 'boundaries',                 label: 'Boundaries (one per line)', type: 'json-list' },
    ],
  },
  workflow_step: {
    endpoint:  (pid, eid, parentId) => `/projects/${pid}/workflows/${parentId}/steps/${eid}`,
    idKey:     'workflow_step_id',
    parentKey: 'workflow_id',
    nameKey:   'name',
    label:     'Process Step',
    fields: [
      { key: 'name',              label: 'Step Name',                            type: 'text'      },
      { key: 'actor_role',        label: 'Actor / Role',                         type: 'text'      },
      { key: 'sla_hours',         label: 'SLA (hours)',                          type: 'number', step: '0.5', min: 0 },
      { key: 'decisions',         label: 'Key Decisions (one per line)',         type: 'json-list' },
      // Phase 1 (Decision #12)
      { key: 'step_type',         label: 'Step Type',                            type: 'select',
        options: ['Start', 'Activity', 'Decision', 'Approval', 'Notification', 'Wait', 'End'] },
      { key: 'step_purpose',      label: 'Step Purpose',                         type: 'textarea'  },
      { key: 'preconditions',     label: 'Preconditions / Entry Checks',         type: 'textarea'  },
      { key: 'evidence_captured', label: 'Evidence Captured (decision log)',     type: 'textarea'  },
    ],
    // server returns 'decisions'; DB column is 'decisions_list' — rename on write
    payloadAlias: { decisions: 'decisions_list' },
  },
  functional_req: {
    endpoint: (pid, eid) => `/projects/${pid}/functional-reqs/${eid}`,
    idKey:   'fr_id',
    nameKey: 'title',
    label:   'Functional Requirement',
    fields: [
      { key: 'title',               label: 'Title',                                    type: 'text'      },
      { key: 'description',         label: 'Description',                              type: 'textarea'  },
      { key: 'actors',              label: 'Actors (one per line)',                    type: 'json-list' },
      { key: 'preconditions',       label: 'Preconditions',                            type: 'textarea'  },
      { key: 'postconditions',      label: 'Postconditions',                           type: 'textarea'  },
      { key: 'priority',            label: 'Priority',                                 type: 'select',
        options: ['must_have', 'should_have', 'could_have', 'wont_have'] },
      { key: 'acceptance_criteria', label: 'Acceptance Criteria (one per line)',       type: 'json-list' },
      { key: 'dependencies',        label: 'Dependencies — FR/NFR slugs (one per line)', type: 'json-list' },
      { key: 'source',              label: 'Source',                                   type: 'text'      },
      { key: 'status',              label: 'Status',                                   type: 'select',
        options: ['draft', 'approved', 'implemented', 'verified', 'deleted'] },
    ],
  },
  nonfunctional_req: {
    endpoint: (pid, eid) => `/projects/${pid}/nonfunctional-reqs/${eid}`,
    idKey:   'nfr_id',
    nameKey: 'title',
    label:   'Non-Functional Requirement',
    fields: [
      { key: 'title',               label: 'Title',                                    type: 'text'      },
      { key: 'category',            label: 'Category (e.g. Performance, Security)',    type: 'text'      },
      { key: 'description',         label: 'Description',                              type: 'textarea'  },
      { key: 'measurable_target',   label: 'Measurable Target (e.g. p95 < 2s)',        type: 'text'      },
      { key: 'verification_method', label: 'Verification Method',                      type: 'textarea'  },
      { key: 'priority',            label: 'Priority',                                 type: 'select',
        options: ['must_have', 'should_have', 'could_have', 'wont_have'] },
      { key: 'dependencies',        label: 'Dependencies — FR/NFR slugs (one per line)', type: 'json-list' },
      { key: 'source',              label: 'Source',                                   type: 'text'      },
      { key: 'status',              label: 'Status',                                   type: 'select',
        options: ['draft', 'approved', 'implemented', 'verified', 'deleted'] },
    ],
  },
};

// ─── entry point ────────────────────────────────────────────────────────────

export async function render(container) {
  container.innerHTML = '';
  injectStyles();

  container.appendChild(el('div', { className: 'module-header' },
    el('h2', {}, 'Design Review'),
    el('p', { className: 'purpose-text' },
      'Human-readable view of agent design content by application — for review, sign-off, and stakeholder communication.')
  ));

  // ── controls bar ──────────────────────────────────────────────
  // No local project selector — the global application dropdown at the top of
  // the shell re-renders this module via navigate() whenever it changes.
  const bar = el('div', { className: 'dr-controls' });

  const scopeNav = el('div', { className: 'dr-scope-nav' });
  const auditAllBtn = el('button', {
    className: 'btn btn-ghost btn-sm',
    title: 'Run quality review on every entity in this Application'
  }, '🔎 Audit full Application');
  const printBtn = el('button', { className: 'btn btn-ghost btn-sm dr-print-btn' }, '🖨 Print / Save PDF');
  printBtn.addEventListener('click', () => window.print());

  const reportBtn = el('button', { className: 'btn btn-ghost btn-sm', title: 'Open a complete, print-ready design report in a new tab' }, '📄 Full Design Report');
  reportBtn.addEventListener('click', () => {
    const pid = getCurrentProjectId();
    if (!pid) { showToast('Choose an application first.', 'warning'); return; }
    window.open(`/api/v1/projects/${pid}/design-review-report`, '_blank');
  });

  bar.appendChild(scopeNav);
  bar.appendChild(auditAllBtn);
  bar.appendChild(printBtn);
  bar.appendChild(reportBtn);
  container.appendChild(bar);

  // ── findings panel (Feature #9) ───────────────────────────────
  // Lives above the report area so it's tab-independent.
  // Change history is no longer front-and-center — it opens in a modal
  // from the "🕘 Change history" button in the Supporting Evidence group.
  const qualityPanel = el('div', { className: 'dr-quality-panel' });
  container.appendChild(qualityPanel);

  // ── report area ───────────────────────────────────────────────
  const reportArea = el('div', { id: 'dr-report-area' });
  container.appendChild(reportArea);

  // ── 🔎 Audit full Application handler ─────────────────────────
  auditAllBtn.addEventListener('click', async () => {
    const pid = getCurrentProjectId();
    if (!pid) { showToast('Choose an application first.', 'warning'); return; }
    if (!confirm('Audit every entity in this Application? This may take 30s+ on a live API key.')) return;
    auditAllBtn.disabled = true;
    const orig = auditAllBtn.textContent;
    auditAllBtn.textContent = '⏳ Auditing…';
    try {
      const result = await apiFetch(`/projects/${pid}/quality-review/full`, {
        method: 'POST', body: JSON.stringify({}),
      });
      const sev = result.by_severity || {};
      const total = (result.findings || []).length;
      showToast(`Audit complete — ${total} findings (high:${sev.high||0} med:${sev.med||0} low:${sev.low||0})`,
        result.source === 'claude' ? 'success' : 'info');
      // reload everything so badges + panels reflect new findings
      if (_currentReportArea && _currentScope) {
        await loadReport(_currentReportArea, pid, _currentScope);
      }
      await renderQualityPanel(qualityPanel, pid);
    } catch (err) {
      showToast('Audit failed: ' + err.message, 'error');
    } finally {
      auditAllBtn.disabled = false;
      auditAllBtn.textContent = orig;
    }
  });

  // Stash the panel on the module so loadReport can refresh it
  _qualityPanel = qualityPanel;

  // ── Config-driven catalog: load once, merge into the entity registries. Fail-soft
  //    (returns [] on error) so the hardcoded tabs below always render. ──────────
  try { registerCatalog(await loadCatalog()); } catch { /* degrade to hardcoded */ }

  // ── build scope tabs (hardcoded + catalog-driven, grouped) ──────────────
  const SCOPES = [
    { id: 'relationships',  label: 'Relationships',   group: 'design'   },
    { id: 'requirements',   label: 'Requirements',    group: 'design'   },
    { id: 'use-cases',      label: 'Use Cases',       group: 'design'   },
    { id: 'workflows',      label: 'Workflows',       group: 'design'   },
    { id: 'agents',         label: 'Agents',          group: 'design'   },
    { id: 'tools',          label: 'Tools',           group: 'design'   },
    { id: 'data-models',    label: 'Data Model',      group: 'design'   },
    { id: 'form-designs',   label: 'Forms',           group: 'design'   },
    { id: 'business-logic', label: 'Impl. Artifacts',  group: 'design'   },
    { id: 'catalog-items',  label: 'Catalog Items',   group: 'design'   },
    // Catalog-driven tabs (grouped after the hardcoded design entities, before evidence).
    // _catalog is ordered information×3 then logic×2, so groups stay contiguous for the nav loop.
    ..._catalog.map(c => ({ id: c.scope_id, label: c.label, group: c.group || 'design' })),
    { id: 'guardrails',     label: 'Guardrails',      group: 'evidence' },
    { id: 'data-sources',   label: 'Data Sources',    group: 'evidence' },
    { id: 'test-scenarios', label: 'Test Scenarios',  group: 'evidence' },
    { id: 'user-stories',   label: 'User Stories',    group: 'evidence' },
    { id: 'governance',     label: 'Governance',      group: 'evidence' },
  ];
  const GROUP_LABELS = { design: 'Design Entities', information: 'Information Layer', logic: 'Business Logic (NL)', process: 'Process & SLAs', configuration: 'Platform Configuration', ux: 'User Experience', integration: 'Integration', evidence: 'Supporting Evidence' };
  let activeScope = 'relationships';

  // Check for pending drill-down scope override
  const pendingDD = consumeDrillDown();
  if (pendingDD && SCOPES.some(s => s.id === pendingDD.scope)) {
    activeScope = pendingDD.scope;
  }

  let currentGroup = null;
  SCOPES.forEach(s => {
    if (s.group !== currentGroup) {
      currentGroup = s.group;
      const groupWrap = el('div', { className: 'dr-scope-group' });
      groupWrap.appendChild(el('div', { className: 'dr-scope-group-label' }, GROUP_LABELS[s.group]));
      const btnRow = el('div', { className: 'dr-scope-btn-row' });
      groupWrap.appendChild(btnRow);
      groupWrap.dataset.group = s.group;
      scopeNav.appendChild(groupWrap);
    }
    const btnRow = scopeNav.querySelector(`[data-group="${s.group}"] .dr-scope-btn-row`);
    const btn = el('button', {
      className: 'dr-scope-btn' + (s.id === activeScope ? ' active' : ''),
      'data-scope': s.id
    }, s.label);
    btn.addEventListener('click', () => {
      document.querySelectorAll('.dr-scope-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeScope = s.id;
      const pid = getCurrentProjectId();
      if (pid) loadReport(reportArea, pid, activeScope);
    });
    btnRow.appendChild(btn);
  });

  // ── 🕘 Change history button (Supporting Evidence group) ──────
  // Project-wide change log lives behind a button (opens a modal) rather
  // than front-and-center on the page.
  const evidenceRow = scopeNav.querySelector('[data-group="evidence"] .dr-scope-btn-row');
  if (evidenceRow) {
    const histBtn = el('button', {
      className: 'dr-scope-btn dr-history-btn',
      title: 'View the change history for this application',
      type: 'button',
    }, '🕘 Change history');
    histBtn.addEventListener('click', () => {
      const pid = getCurrentProjectId();
      if (!pid) { showToast('Choose an application first.', 'warning'); return; }
      openCpHistoryModal(pid);
    });
    evidenceRow.appendChild(histBtn);
  }

  // ── initial load — driven by the global application selector ──
  const activeId = getCurrentProjectId();
  if (activeId) {
    await loadReport(reportArea, activeId, activeScope);
    // Scroll to drill-down anchor if set
    if (pendingDD && pendingDD.anchor) {
      setTimeout(() => scrollToAnchor(pendingDD.anchor), 150);
    }
  } else {
    reportArea.innerHTML = '<div class="empty-state" style="margin-top:40px"><div class="empty-state-icon">📋</div><h3>No application selected</h3><p>Choose an application from the dropdown at the top of the page.</p></div>';
  }

  // ── delegated drill-down listener ─────────────────────────────
  reportArea.addEventListener('click', async e => {
    const btn = e.target.closest('[data-drill-scope]');
    const pid = getCurrentProjectId();
    if (!btn || !pid) return;
    const scope  = btn.dataset.drillScope;
    const anchor = btn.dataset.drillAnchor || '';
    // Switch tab
    document.querySelectorAll('.dr-scope-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.scope === scope);
    });
    activeScope = scope;
    await loadReport(reportArea, pid, scope);
    if (anchor) setTimeout(() => scrollToAnchor(anchor), 150);
  });
}

// ─── data loading ────────────────────────────────────────────────────────────

async function loadReport(area, projectId, scope) {
  _currentProjectId  = projectId;
  _currentReportArea = area;
  _currentScope      = scope;
  area.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><span>Building report…</span></div>';
  try {
    // Fetch report + slug map + open exceptions in parallel
    const [data, slugMap, exceptions] = await Promise.all([
      apiFetch(`/projects/${projectId}/design-report/${scope}`),
      apiFetch(`/projects/${projectId}/slug-map`).catch(() => ({})),
      apiFetch(`/exceptions?project_id=${projectId}`).catch(() => []),
    ]);
    _exceptionsByEntity = indexExceptions(exceptions);
    area.innerHTML = '';
    area.appendChild(buildReport(data));
    // Apply slug autolinking AFTER the DOM is built. Walks text nodes and
    // turns slug patterns (UC-###, WF-###, etc.) into drill-down links.
    applySlugLinks(area, slugMap);
    // Feature #9: refresh tab-independent findings panel
    if (_qualityPanel)   renderQualityPanel(_qualityPanel, projectId).catch(err => console.warn('quality panel:', err));
  } catch (err) {
    area.innerHTML = `<div class="error-state"><strong>Error:</strong> ${escHtml(err.message)}</div>`;
  }
}

// ─── Phase 2 Data-Quality: open-exception index + inline badges ──────────────
// Surfaces records flagged in the asdlc_exception table directly on the Design
// Review cards (and as a summary banner). Reuses the existing Validation
// module's data — no new schema or storage.

function indexExceptions(exceptions) {
  const idx = {};
  for (const e of (exceptions || [])) {
    if ((e.status && e.status !== 'open') || e.lifecycle_status === 'deleted') continue;
    const t = e.related_entity_type;
    const id = e.related_entity_id;
    if (!t || !id) continue;
    if (!idx[t]) idx[t] = {};
    if (!idx[t][id]) idx[t][id] = [];
    idx[t][id].push(e);
  }
  return idx;
}

function getExceptions(entityType, entityId) {
  return _exceptionsByEntity[entityType]?.[entityId] || [];
}

/** Returns a small clickable badge if the entity has ≥1 open exception, else null. */
function dataIssueBadge(entityType, entityId) {
  const list = getExceptions(entityType, entityId);
  if (!list.length) return null;
  const maxSev = list.some(e => e.severity === 'high') ? 'high'
              : list.some(e => e.severity === 'med')  ? 'med'  : 'low';
  const sevClass = { high: 'di-high', med: 'di-med', low: 'di-low' }[maxSev];
  // Feature #9: differentiate AI-detected findings from manual exceptions
  const anyAI    = list.some(e => e.detected_by === 'quality-reviewer');
  const allAI    = anyAI && list.every(e => e.detected_by === 'quality-reviewer');
  const icon     = allAI ? '✨' : (anyAI ? '⚠✨' : '⚠');
  const titleSrc = allAI ? ' (AI auditor)' : (anyAI ? ' (mixed: manual + AI)' : '');
  const btn = el('button', {
    className: `data-issue-badge ${sevClass}`,
    title: `${list.length} open data ${list.length === 1 ? 'issue' : 'issues'}${titleSrc} — click to view`,
    type: 'button',
  });
  btn.innerHTML = `<span class="di-icon">${icon}</span> ${list.length}`;
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggleIssuePopover(btn, list);
  });
  return btn;
}

/** Floating popover anchored to the badge, listing the exception details. */
function toggleIssuePopover(anchor, list) {
  // Close any open popovers first
  document.querySelectorAll('.data-issue-popover').forEach(p => p.remove());
  if (anchor.dataset.popoverOpen === '1') {
    anchor.dataset.popoverOpen = '';
    return;
  }
  anchor.dataset.popoverOpen = '1';

  const pop = document.createElement('div');
  pop.className = 'data-issue-popover';

  // Header
  const h = document.createElement('div');
  h.className = 'di-popover-header';
  h.textContent = `⚠ ${list.length} open data ${list.length === 1 ? 'issue' : 'issues'}`;
  pop.appendChild(h);

  // List
  const ul = document.createElement('ul');
  ul.className = 'di-popover-list';
  list.forEach(e => {
    const li = document.createElement('li');
    li.className = 'di-popover-item';
    const sev = (e.severity || 'low').toLowerCase();
    li.innerHTML = `
      <div class="di-popover-row">
        <span class="di-sev di-sev-${sev}">${sev}</span>
        <span class="di-type">${escHtml(e.exception_type || 'issue')}</span>
      </div>
      <div class="di-desc">${escHtml(e.description || '(no description)')}</div>
      ${e.suggested_action ? `<div class="di-suggest"><em>Suggested:</em> ${escHtml(e.suggested_action)}</div>` : ''}
    `;
    ul.appendChild(li);
  });
  pop.appendChild(ul);

  // Footer
  const footer = document.createElement('div');
  footer.className = 'di-popover-footer';
  const openBtn = document.createElement('button');
  openBtn.className = 'btn btn-sm btn-primary';
  openBtn.textContent = 'Open Validation module →';
  openBtn.addEventListener('click', () => {
    const validationNav = document.querySelector('[data-module="validation"]');
    if (validationNav) validationNav.click();
    pop.remove();
    anchor.dataset.popoverOpen = '';
  });
  footer.appendChild(openBtn);
  pop.appendChild(footer);

  // Position next to the anchor
  const r = anchor.getBoundingClientRect();
  pop.style.position = 'absolute';
  pop.style.top  = `${window.scrollY + r.bottom + 6}px`;
  pop.style.left = `${window.scrollX + Math.max(8, r.left)}px`;
  document.body.appendChild(pop);

  // Close on outside click
  const closeHandler = (evt) => {
    if (!pop.contains(evt.target) && evt.target !== anchor) {
      pop.remove();
      anchor.dataset.popoverOpen = '';
      document.removeEventListener('click', closeHandler);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler), 0);
}

/** Project-wide summary banner. Renders only if any open exceptions exist. */
function buildDataIssuesSummary() {
  let total = 0, byType = {}, bySev = { high: 0, med: 0, low: 0 };
  for (const t in _exceptionsByEntity) {
    for (const id in _exceptionsByEntity[t]) {
      _exceptionsByEntity[t][id].forEach(e => {
        total++;
        byType[t] = (byType[t] || 0) + 1;
        bySev[e.severity || 'low'] = (bySev[e.severity || 'low'] || 0) + 1;
      });
    }
  }
  if (total === 0) return null;

  const banner = el('div', { className: 'data-issues-banner' });
  banner.appendChild(el('span', { className: 'dib-icon' }, '⚠'));
  const text = el('span', { className: 'dib-text' });
  const sevPills = [];
  if (bySev.high) sevPills.push(`<span class="di-sev di-sev-high">${bySev.high} high</span>`);
  if (bySev.med)  sevPills.push(`<span class="di-sev di-sev-med">${bySev.med} med</span>`);
  if (bySev.low)  sevPills.push(`<span class="di-sev di-sev-low">${bySev.low} low</span>`);
  text.innerHTML = `<strong>${total} open data ${total === 1 ? 'issue' : 'issues'}</strong> in this application &nbsp; ${sevPills.join(' ')}`;
  banner.appendChild(text);

  const link = el('button', { className: 'dib-link', type: 'button' }, 'Open Validation →');
  link.addEventListener('click', () => {
    const validationNav = document.querySelector('[data-module="validation"]');
    if (validationNav) validationNav.click();
  });
  banner.appendChild(link);
  return banner;
}

// ─── Slug autolinker (Phase 5, Decision #1 Q5) ───────────────────────────────
// Scans rendered text nodes inside `root` for slug patterns
// (UC-###, WF-###, AG-###, T-###, S-###, AC-###, TC-###, US-###, P-###, PATH-###)
// and replaces each match with a clickable span that triggers the existing
// data-drill-scope navigation handler. Only links slugs that resolve in
// the project's slug-map; bare patterns are left as plain text.
const SLUG_PATTERN = /\b(?:UC|WF|AG|T|US|S|AC|TC|P|PATH)-\d{3,}\b/g;
const SLUG_SKIP_TAGS = new Set(['INPUT','TEXTAREA','BUTTON','A','SELECT','SCRIPT','STYLE','OPTION','LABEL']);

function applySlugLinks(root, slugMap) {
  if (!root || !slugMap || typeof slugMap !== 'object') return;
  if (Object.keys(slugMap).length === 0) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const txt = node.nodeValue;
      if (!txt || txt.length < 4) return NodeFilter.FILTER_SKIP;
      SLUG_PATTERN.lastIndex = 0;
      if (!SLUG_PATTERN.test(txt)) return NodeFilter.FILTER_SKIP;
      // Skip nodes inside form controls or already-linked elements
      let p = node.parentNode;
      while (p && p !== root) {
        if (p.tagName && SLUG_SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (p.dataset && p.dataset.drillScope != null) return NodeFilter.FILTER_REJECT;
        if (p.classList && p.classList.contains('slug-link')) return NodeFilter.FILTER_REJECT;
        p = p.parentNode;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const targets = [];
  let n;
  while ((n = walker.nextNode())) targets.push(n);

  targets.forEach(node => {
    const txt = node.nodeValue;
    SLUG_PATTERN.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let cursor = 0;
    let m;
    let madeLink = false;
    while ((m = SLUG_PATTERN.exec(txt)) !== null) {
      const slug = m[0];
      const entry = slugMap[slug];
      if (!entry) continue; // unresolved — leave inline
      if (m.index > cursor) {
        frag.appendChild(document.createTextNode(txt.substring(cursor, m.index)));
      }
      const link = document.createElement('span');
      link.className = 'slug-link';
      link.textContent = slug;
      link.setAttribute('data-drill-scope',  entry.scope);
      link.setAttribute('data-drill-anchor', entry.entity_id ? `dr-entity-${entry.entity_id}` : '');
      link.setAttribute('title', entry.label || slug);
      frag.appendChild(link);
      cursor = m.index + slug.length;
      madeLink = true;
    }
    if (!madeLink) return;
    if (cursor < txt.length) frag.appendChild(document.createTextNode(txt.substring(cursor)));
    node.parentNode.replaceChild(frag, node);
  });
}
// _currentScope is now declared at module top (Feature #9)

// ─── report renderer ─────────────────────────────────────────────────────────

const REPORT_META = {
  agents:            { title: 'Agent Design Report',       noun: 'agent'             },
  workflows:         { title: 'Workflow Design Report',    noun: 'workflow'          },
  tools:             { title: 'Tool Specifications',       noun: 'tool'              },
  'use-cases':       { title: 'Use Case Inventory',        noun: 'use case'          },
  guardrails:        { title: 'Guardrails',                noun: 'guardrail'         },
  'data-sources':    { title: 'Data Sources',              noun: 'data source'       },
  'test-scenarios':  { title: 'Test Scenarios',            noun: 'test scenario'     },
  'user-stories':    { title: 'User Stories',              noun: 'user story'        },
  governance:        { title: 'Governance Controls',       noun: 'governance control'},
  relationships:     { title: 'Entity Relationship Map',   noun: 'relationship'      },
  requirements:    { title: 'Requirements',          noun: 'requirement'     },
  'data-models':    { title: 'Data Model',            noun: 'table'        },
  'form-designs':   { title: 'Form Designs',          noun: 'form'         },
  'business-logic': { title: 'Implementation Artifacts (Tier C)', noun: 'artifact' },
  'catalog-items':  { title: 'Catalog Items',         noun: 'catalog item' },
  'integrations':   { title: 'Integrations',          noun: 'integration'  },
};

function detectTypeKey(data) {
  // Relationships is uniquely identified by `relationships` and its payload also carries
  // supplementary data_models/catalog_items/integrations — so it MUST be checked first,
  // else a project with 0 data models falls through to an empty "data-models" state.
  if (data.relationships)     return 'relationships';
  if (data.agents)            return 'agents';
  if (data.workflows)         return 'workflows';
  if (data.tools)             return 'tools';
  if (data.use_cases)         return 'use-cases';
  if (data.data_models)       return 'data-models';
  if (data.form_designs)      return 'form-designs';
  if (data.business_logic)    return 'business-logic';
  if (data.catalog_items)     return 'catalog-items';
  if (data.integrations)      return 'integrations';
  if (data.guardrails)        return 'guardrails';
  if (data.data_sources)      return 'data-sources';
  if (data.test_scenarios)    return 'test-scenarios';
  if (data.user_stories)      return 'user-stories';
  if (data.governance_controls) return 'governance';
  if (data.functional_reqs !== undefined || data.nonfunctional_reqs !== undefined) return 'requirements';
  // Catalog-driven entities (checked after all hardcoded shapes so they never shadow them).
  for (const c of _catalog) if (data[c.data_key] !== undefined) return c.scope_id;
  return 'agents';
}

function buildReport(data) {
  const { project, generated_at } = data;

  // Detect content type from response shape
  const typeKey = detectTypeKey(data);
  const meta    = REPORT_META[typeKey] || { title: 'Design Report', noun: 'item' };

  // Count items for header (not applicable to relationships)
  const DATA_KEY_MAP = {
    'use-cases':      'use_cases',
    'data-sources':   'data_sources',
    'test-scenarios': 'test_scenarios',
    'user-stories':   'user_stories',
    'governance':     'governance_controls',
    'requirements':   'requirements',
    'data-models':    'data_models',
    'form-designs':   'form_designs',
    'business-logic': 'business_logic',
    'catalog-items':  'catalog_items',
    'integrations':   'integrations',
  };
  for (const c of _catalog) DATA_KEY_MAP[c.scope_id] = c.data_key;   // catalog-driven scope → data key
  const dataKey = DATA_KEY_MAP[typeKey] || typeKey;
  const items = data[dataKey] || [];

  const wrap = el('div', { className: 'dr-report', id: 'dr-printable' });

  // ── shared report header ───────────────────────────────────────
  const hdr = el('div', { className: 'dr-report-header' });
  hdr.appendChild(el('div', { className: 'dr-report-title' }, meta.title));
  const metaRow = el('div', { className: 'dr-report-meta' });
  metaRow.appendChild(el('span', { className: 'dr-meta-app' },
    project.client_name ? `${project.client_name} · ${project.project_name}` : project.project_name));
  metaRow.appendChild(el('span', { className: 'dr-meta-sep' }, '·'));
  metaRow.appendChild(el('span', {}, `Code: ${project.project_code || '—'}`));
  metaRow.appendChild(el('span', { className: 'dr-meta-sep' }, '·'));
  metaRow.appendChild(el('span', {}, `Stage: ${capitalise(project.stage || '—')}`));
  metaRow.appendChild(el('span', { className: 'dr-meta-sep' }, '·'));
  metaRow.appendChild(el('span', { className: 'dr-meta-date' }, `Generated ${formatTs(generated_at)}`));
  hdr.appendChild(metaRow);
  // Count for non-relationship views
  const displayCount = typeKey === 'relationships'
    ? null
    : Array.isArray(items) ? items.length : null;
  if (displayCount != null && displayCount > 0) {
    hdr.appendChild(el('div', { style: { marginTop: '6px', fontSize: '13px', color: 'rgba(255,255,255,0.65)' } },
      `${displayCount} ${meta.noun}${displayCount !== 1 ? 's' : ''} in this application`));
  }
  wrap.appendChild(hdr);

  // ── Phase 2: data-issues summary banner (renders only if any exist) ──
  const issuesBanner = buildDataIssuesSummary();
  if (issuesBanner) wrap.appendChild(issuesBanner);

  // ── empty state (not for relationships, requirements, or catalog-driven entities,
  //    which render their own empty state with an "+ Add" affordance) ──────────────
  const isCatalogScope = _catalog.some(c => c.scope_id === typeKey);
  const skipEmptyGuard = typeKey === 'relationships' || typeKey === 'requirements' || isCatalogScope;
  if (!skipEmptyGuard && !Array.isArray(items)) {
    wrap.appendChild(el('div', { className: 'empty-state', style: { margin: '40px 0' } },
      el('p', {}, `No ${meta.noun}s found for this application.`)));
    return wrap;
  }
  if (!skipEmptyGuard && items.length === 0) {
    wrap.appendChild(el('div', { className: 'empty-state', style: { margin: '40px 0' } },
      el('p', {}, `No ${meta.noun}s found for this application.`)));
    return wrap;
  }

  // ── dispatch to the right renderer ────────────────────────────
  if (data.agents) {
    data.agents.forEach((agent, idx) => {
      if (idx > 0) wrap.appendChild(el('div', { className: 'dr-page-break' }));
      const sec = buildAgentSection(agent);
      sec.id = `dr-entity-${agent.agent_spec_id || agent.name || idx}`;
      wrap.appendChild(sec);
    });
  } else if (data.workflows) {
    data.workflows.forEach((wf, idx) => {
      if (idx > 0) wrap.appendChild(el('div', { className: 'dr-page-break' }));
      const sec = buildWorkflowSection(wf);
      sec.id = `dr-entity-${wf.workflow_id || wf.name || idx}`;
      wrap.appendChild(sec);
    });
  } else if (data.tools) {
    wrap.appendChild(buildToolsSection(data.tools));
  } else if (data.use_cases) {
    data.use_cases.forEach((uc, idx) => {
      if (idx > 0) wrap.appendChild(el('div', { className: 'dr-page-break' }));
      const sec = buildUseCaseSection(uc);
      sec.id = `dr-entity-${uc.use_case_id || idx}`;
      wrap.appendChild(sec);
    });
  } else if (data.guardrails) {
    wrap.appendChild(buildGuardrailsSection(data.guardrails, data.ingest_document));
  } else if (data.data_sources) {
    wrap.appendChild(buildDataSourcesSection(data.data_sources, data.ingest_document));
  } else if (data.test_scenarios) {
    wrap.appendChild(buildTestScenariosSection(data.test_scenarios, data.ingest_document));
  } else if (data.user_stories) {
    wrap.appendChild(buildUserStoriesSection(data.user_stories, data.ingest_document));
  } else if (data.governance_controls) {
    wrap.appendChild(buildGovernanceSection(data.governance_controls, data.ingest_document));
  } else if (data.relationships) {
    // Check for relationships first — this response now includes data_models/catalog_items/integrations
    // as supplementary data; those individual-tab checks below must not fire for this combined response.
    wrap.appendChild(buildRelationshipsSection(data.relationships, data.functional_reqs || [], data.nonfunctional_reqs || [], data.use_case_map || {}, data.data_models || [], data.catalog_items || [], data.integrations || [], data.tier_a_entities || {}));
  } else if (data.data_models) {
    wrap.appendChild(buildDataModelsSection(data.data_models));
  } else if (data.form_designs) {
    wrap.appendChild(buildFormDesignsSection(data.form_designs));
  } else if (data.business_logic) {
    wrap.appendChild(buildBusinessLogicSection(data.business_logic));
  } else if (data.catalog_items) {
    wrap.appendChild(buildCatalogItemsSection(data.catalog_items));
  } else if (data.integrations) {
    wrap.appendChild(buildIntegrationsSection(data.integrations));
  } else if (data.functional_reqs !== undefined || data.nonfunctional_reqs !== undefined) {
    wrap.appendChild(buildRequirementsSection(data.functional_reqs || [], data.nonfunctional_reqs || [], data.use_case_map || {}));
  } else {
    // Catalog-driven generic fallback — one renderer for every config-defined entity.
    const c = _catalog.find(cc => Array.isArray(data[cc.data_key]));
    if (c) wrap.appendChild(buildGenericDesignSection(data[c.data_key], c));
  }

  return wrap;
}

// ─── Generic, config-driven section renderer ─────────────────────────────────
// Renders any catalog entity from its field metadata. Reuses rtHeader (slug + status
// pill + Edit button → versioning/CP/audit for free), subSection, kvRow. For NL-rule
// entities it also shows a status badge and a gap/reverse-engineer banner.
function buildGenericDesignSection(items, cfg) {
  const wrap = el('div', { className: 'dr-agent' });
  const isNlRule = cfg.entity_type === 'nl_business_rule' || cfg.entity_type === 'nl_validation_rule';

  // Toolbar: author a new one (+ gap-prompting for NL rules).
  const toolbar = el('div', { style: 'display:flex;gap:8px;align-items:center;margin:0 0 12px 0;flex-wrap:wrap' });
  const addBtn = el('button', { className: 'btn btn-secondary', style: 'font-size:13px' }, `+ Add ${cfg.label}`);
  addBtn.addEventListener('click', () => openCreateModal(cfg.entity_type));
  toolbar.appendChild(addBtn);
  wrap.appendChild(toolbar);
  if (isNlRule) appendNlGapBanner(wrap, cfg);

  if (!items.length) {
    wrap.appendChild(el('div', { className: 'empty-state', style: 'margin:24px 0' },
      el('p', {}, `No ${cfg.label.toLowerCase()}s yet — use “+ Add ${cfg.label}”${isNlRule ? ' or reverse-engineer one from a captured script' : ''}.`)));
    return wrap;
  }

  items.forEach((row, idx) => {
    if (idx > 0) wrap.appendChild(el('div', { className: 'dr-page-break' }));
    const section = el('div', { className: 'dr-agent' });
    section.id = `dr-entity-${row[cfg.id_key] || idx}`;
    rtHeader(section, cfg.entity_type, row);
    if (isNlRule && row.status) {
      const hdr = section.querySelector('.dr-agent-header > div:last-child');
      if (hdr) hdr.insertBefore(nlRuleStatusBadge(row.status), hdr.firstChild);
    }
    const s = subSection('Overview');
    const grid = el('div', { className: 'dr-kv-grid' });
    const childKey = cfg.children && cfg.children.key;
    for (const f of cfg.fields) {
      if (f.key === cfg.name_key || f.key === 'name') continue;
      if (f.key === 'status') continue;          // shown as a header badge for NL rules
      if (childKey && f.key === childKey) continue;  // rendered as a sub-table below
      let v = row[f.key];
      if (f.type === 'json-list') v = asArray(v).join(', ');
      else if (f.type === 'select' && typeof v === 'string') v = capitalise(v);
      kvRow(grid, f.label.replace(/ \(one per line\)$/, ''), v == null || v === '' ? null : v);
    }
    s.appendChild(grid);
    section.appendChild(s);
    // Nested child collection → sub-table (mirrors the data-model fields table).
    if (cfg.children) {
      const rows = asArray(row[cfg.children.key]);
      const cs = subSection(`${cfg.children.label} (${rows.length})`);
      if (rows.length) {
        const tbl = el('table', { className: 'dr-table' });
        tbl.appendChild(el('thead', {}, el('tr', {}, ...cfg.children.columns.map(c => el('th', {}, c.label)))));
        const tb = el('tbody');
        rows.forEach(r => tb.appendChild(el('tr', {}, ...cfg.children.columns.map(c => {
          const cv = r[c.key];
          return el('td', { style: { fontSize: '12px' } }, cv == null || cv === '' ? '—' : (typeof cv === 'string' ? cv : JSON.stringify(cv)));
        }))));
        tbl.appendChild(tb);
        cs.appendChild(tbl);
      } else {
        cs.appendChild(el('div', { style: 'color:var(--text-muted);font-style:italic;font-size:12px' }, `— (no ${cfg.children.label.toLowerCase()} recorded)`));
      }
      section.appendChild(cs);
    }
    wrap.appendChild(section);
  });
  return wrap;
}

function nlRuleStatusBadge(status) {
  const map = {
    authored:           { label: 'Authored',           bg: '#e3f2fd', color: '#1565c0' },
    reverse_engineered: { label: '✨ Reverse-engineered', bg: '#f3e5f5', color: '#6a1b9a' },
    needs_review:       { label: 'Needs Review',        bg: '#fff3e0', color: '#e65100' },
  };
  const m = map[status] || { label: status || '—', bg: '#eceff1', color: '#455a64' };
  return el('span', { style: `display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;background:${m.bg};color:${m.color}` }, m.label);
}

// Gap-prompting banner for NL-rule tabs: surfaces tables with no documented rule and
// captured scripts not yet reverse-engineered, each with a one-click action.
function appendNlGapBanner(wrap, cfg) {
  const banner = el('div', { style: 'margin:0 0 14px 0;padding:12px 14px;background:var(--surface-alt,#f8fafc);border:1px solid var(--border,#e2e8f0);border-radius:8px;font-size:13px' });
  banner.appendChild(el('div', { style: 'font-weight:600;margin-bottom:6px' }, '🧭 Coverage gaps'));
  const body = el('div', {}, el('span', { style: 'color:var(--text-muted,#64748b)' }, 'Checking…'));
  banner.appendChild(body);
  wrap.appendChild(banner);

  apiFetch(`/projects/${_currentProjectId}/nl-rules/gaps`).then(g => {
    body.innerHTML = '';
    const tables  = g.tables_without_rules || [];
    const scripts = g.scripts_not_reverse_engineered || [];
    if (!tables.length && !scripts.length) {
      body.appendChild(el('span', { style: 'color:#2e7d32' }, '✓ Every data model has a documented rule and all captured scripts have been reverse-engineered.'));
      return;
    }
    if (tables.length) {
      const row = el('div', { style: 'margin-bottom:6px' },
        el('span', {}, `${tables.length} data model${tables.length === 1 ? '' : 's'} with no documented rule: `));
      tables.slice(0, 8).forEach(t => {
        const b = el('button', { className: 'btn btn-ghost', style: 'font-size:12px;margin:2px 4px 2px 0' }, `+ ${t.name}`);
        b.addEventListener('click', () => openCreateModal(cfg.entity_type, { linked_table: t.name }));
        row.appendChild(b);
      });
      body.appendChild(row);
    }
    if (scripts.length) {
      const row = el('div', {},
        el('span', {}, `${scripts.length} captured script${scripts.length === 1 ? '' : 's'} not yet reverse-engineered: `));
      scripts.slice(0, 8).forEach(s => {
        const b = el('button', { className: 'btn btn-ghost', style: 'font-size:12px;margin:2px 4px 2px 0' }, `✨ ${s.name}`);
        b.addEventListener('click', () => reverseEngineerNlRuleFromScript(s.sn_artifact_id, cfg.entity_type));
        row.appendChild(b);
      });
      body.appendChild(row);
    }
  }).catch(() => { body.innerHTML = ''; body.appendChild(el('span', { style: 'color:var(--text-muted,#64748b)' }, 'Gap check unavailable.')); });
}

async function reverseEngineerNlRuleFromScript(artifactId, entityType) {
  showToast('Reverse-engineering rule from script…', 'info');
  try {
    const kind = entityType === 'nl_validation_rule' ? 'validation' : 'business';
    const r = await apiFetch(`/projects/${_currentProjectId}/nl-rules/reverse-engineer`, {
      method: 'POST', body: JSON.stringify({ artifact_id: artifactId, rule_kind: kind }),
    });
    showToast(`Candidate rule created (${r.slug}) — review & confirm.`, 'success');
    const pid = getCurrentProjectId();
    if (pid && _currentReportArea) loadReport(_currentReportArea, pid, _currentScope);
  } catch (err) {
    showToast('Reverse-engineering failed: ' + err.message, 'error');
  }
}

// ─── requirements section ────────────────────────────────────────────────────

function buildRequirementsSection(frs, nfrs, useCaseMap) {
  const wrap = el('div', { className: 'dr-requirements' });

  const priorityLabel = { must_have: 'Must Have', should_have: 'Should Have', could_have: 'Could Have', wont_have: "Won't Have" };
  const statusLabel   = { draft: 'Draft', approved: 'Approved', implemented: 'Implemented', verified: 'Verified', deleted: 'Deleted' };
  const statusColor   = { draft: '#78909c', approved: '#1976d2', implemented: '#388e3c', verified: '#6a1b9a', deleted: '#b71c1c' };

  function reqStatusPill(status) {
    const pill = el('span', { className: 'dr-status-pill' });
    pill.textContent = statusLabel[status] || status || '—';
    pill.style.cssText = `background:${statusColor[status] || '#ccc'};color:#fff;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:600;white-space:nowrap`;
    return pill;
  }

  function ucLink(row) {
    if (!row.use_case_id) {
      const badge = el('span');
      badge.innerHTML = '<span style="color:#e65100;font-weight:600;font-size:11px">⚠ Orphan — no Use Case</span>';
      return badge;
    }
    const uc = useCaseMap[row.use_case_id] || {};
    return el('span', {}, `${uc.slug || ''}${uc.slug && uc.title ? ' · ' : ''}${uc.title || row.use_case_id}`);
  }

  function buildReqTable(reqs, idField, extraCols, entityType) {
    if (!reqs || reqs.length === 0) {
      return el('div', { className: 'empty-state', style: { margin: '12px 0' } }, 'None defined yet.');
    }
    const tbl = el('table', { className: 'dr-table' });
    const head = el('thead');
    const hRow = el('tr');
    ['ID', 'Title', 'Priority', 'Use Case', ...extraCols.map(c => c.label), 'Status', ''].forEach(h => {
      hRow.appendChild(el('th', {}, h));
    });
    head.appendChild(hRow);
    tbl.appendChild(head);

    const body = el('tbody');
    reqs.forEach(req => {
      const tr = el('tr');
      const slugCell = el('td');
      slugCell.appendChild(el('span', { className: 'dr-slug-badge' }, req.slug || '—'));
      tr.appendChild(slugCell);

      const titleCell = el('td');
      titleCell.appendChild(el('strong', {}, escHtml(req.title)));
      const reqSg = aiSuggestedBadge(req);
      if (reqSg) { titleCell.appendChild(document.createTextNode(' ')); titleCell.appendChild(reqSg); }
      if (req.description) {
        titleCell.appendChild(el('div', { style: { fontSize: '12px', color: '#555', marginTop: '3px' } }, escHtml(req.description)));
      }
      tr.appendChild(titleCell);

      const priCell = el('td', { style: { whiteSpace: 'nowrap', fontSize: '12px' } },
        priorityLabel[req.priority] || req.priority || '—');
      tr.appendChild(priCell);

      const ucCell = el('td', { style: { fontSize: '12px' } });
      ucCell.appendChild(ucLink(req));
      tr.appendChild(ucCell);

      extraCols.forEach(col => {
        const val = req[col.field];
        const cell = el('td', { style: { fontSize: '12px' } });
        if (Array.isArray(val) && val.length > 0) {
          cell.textContent = val.join(', ');
        } else if (val && typeof val === 'string') {
          cell.textContent = val;
        } else {
          cell.textContent = '—';
        }
        tr.appendChild(cell);
      });

      const statCell = el('td');
      statCell.appendChild(reqStatusPill(req.status));
      tr.appendChild(statCell);

      const editCell = el('td', { style: { whiteSpace: 'nowrap' } });
      const editBtn = buildEditBtn(entityType, req);
      if (editBtn) editCell.appendChild(editBtn);
      tr.appendChild(editCell);

      body.appendChild(tr);
    });
    tbl.appendChild(body);
    return tbl;
  }

  // ── Orphan summary ─────────────────────────────────────────────
  const orphanFRs  = frs.filter(r => r.is_orphan);
  const orphanNFRs = nfrs.filter(r => r.is_orphan);
  const totalOrphans = orphanFRs.length + orphanNFRs.length;
  if (totalOrphans > 0) {
    const banner = el('div', {
      style: 'background:#fff3e0;border:1px solid #ffb300;border-radius:6px;padding:10px 14px;margin-bottom:16px;font-size:13px'
    });
    banner.innerHTML = `<strong style="color:#e65100">⚠ ${totalOrphans} orphan requirement${totalOrphans !== 1 ? 's' : ''}</strong> — not yet traced to a Use Case (${orphanFRs.length} FR, ${orphanNFRs.length} NFR). Assign a <code>use_case_id</code> to resolve.`;
    wrap.appendChild(banner);
  }

  // ── Functional Requirements ────────────────────────────────────
  const frSection = el('div', { className: 'dr-section', style: { marginBottom: '32px' } });
  const frHdr = el('div', { className: 'dr-section-header' });
  frHdr.appendChild(el('span', { className: 'dr-section-title' }, `Functional Requirements (${frs.length})`));
  frSection.appendChild(frHdr);
  frSection.appendChild(buildReqTable(frs, 'fr_id', [
    { field: 'actors',              label: 'Actors' },
    { field: 'acceptance_criteria', label: 'Acceptance Criteria' },
    { field: 'source',              label: 'Source' },
  ], 'functional_req'));
  wrap.appendChild(frSection);

  // ── Non-Functional Requirements ────────────────────────────────
  const nfrSection = el('div', { className: 'dr-section' });
  const nfrHdr = el('div', { className: 'dr-section-header' });
  nfrHdr.appendChild(el('span', { className: 'dr-section-title' }, `Non-Functional Requirements (${nfrs.length})`));
  nfrSection.appendChild(nfrHdr);
  nfrSection.appendChild(buildReqTable(nfrs, 'nfr_id', [
    { field: 'category',            label: 'Category' },
    { field: 'measurable_target',   label: 'Target' },
    { field: 'verification_method', label: 'Verification' },
    { field: 'source',              label: 'Source' },
  ], 'nonfunctional_req'));
  wrap.appendChild(nfrSection);

  return wrap;
}

// ─── agent section ───────────────────────────────────────────────────────────

function buildAgentSection(agent) {
  const section = el('div', { className: 'dr-agent' });
  // reload helper — re-renders the full design-report after a CRUD operation
  const reload = () => {
    if (_currentReportArea && _currentProjectId && _currentScope)
      loadReport(_currentReportArea, _currentProjectId, _currentScope);
  };

  // ── agent heading ─────────────────────────────────────────────
  const agentHdr = el('div', { className: 'dr-agent-header' });
  const agentNameEl = el('div', { className: 'dr-agent-name' });
  const agentSlug = slugBadge(agent.slug);
  if (agentSlug) agentNameEl.appendChild(agentSlug);
  agentNameEl.appendChild(document.createTextNode(agent.name));
  const agentIssue = dataIssueBadge('agent_spec', agent.agent_spec_id);
  if (agentIssue) agentNameEl.appendChild(agentIssue);
  agentHdr.appendChild(agentNameEl);
  agentHdr.appendChild(statusPill(agent.lifecycle_status));
  const agentSg = aiSuggestedBadge(agent); if (agentSg) agentHdr.appendChild(agentSg);
  // Phase 4: agent cost chip
  const agentCostChip = costChip(agent.agent_cost_per_period, 'month', 'Projected AI cost per month (steps owned by this agent)');
  if (agentCostChip) agentHdr.appendChild(agentCostChip);
  const editBtn = buildEditBtn('agent', agent);
  if (editBtn) agentHdr.appendChild(editBtn);
  agentHdr.appendChild(buildAuditBtn('agent', agent.agent_spec_id, reload));

  // ── Draft Prompt button (card-level, not buried in edit modal) ──
  const draftPromptBtn = el('button', { className: 'dr-edit-btn',
    title: 'Use Claude to draft a starting system prompt for this agent' }, '✨ Draft Prompt');
  draftPromptBtn.addEventListener('click', async e => {
    e.stopPropagation();
    draftPromptBtn.disabled = true;
    draftPromptBtn.textContent = '⏳ Drafting…';
    try {
      const result = await apiFetch(
        `/projects/${_currentProjectId}/agent-specs/${agent.agent_spec_id}/draft-prompt`,
        { method: 'POST', body: JSON.stringify({}) }
      );
      openDraftPromptModal(agent, result, reload);
    } catch (err) {
      showToast('Draft failed: ' + err.message, 'error');
    } finally {
      draftPromptBtn.disabled = false;
      draftPromptBtn.textContent = '✨ Draft Prompt';
    }
  });
  agentHdr.appendChild(draftPromptBtn);

  section.appendChild(agentHdr);

  // ── breadcrumb: linked use cases + workflow ──────────────────
  const crumbItems = [];
  // Phase 3: use_cases is now an array from the M:N join table
  (agent.use_cases || []).forEach(uc => {
    crumbItems.push({
      prefix: 'UC', name: uc.title || uc.slug || '—',
      scope: 'use-cases', anchorId: `dr-entity-${uc.use_case_id}`,
    });
  });
  if (agent.workflow && agent.workflow.workflow_id) {
    crumbItems.push({
      prefix: 'Workflow', name: agent.workflow.name || '—',
      scope: 'workflows', anchorId: `dr-entity-${agent.workflow.workflow_id}`,
    });
  }
  const crumb = buildBreadcrumb(crumbItems);
  if (crumb) section.appendChild(crumb);

  // ── scope ─────────────────────────────────────────────────────
  if (agent.scope) {
    const s = subSection('Scope');
    s.appendChild(el('p', { className: 'dr-prose' }, agent.scope));
    section.appendChild(s);
  }

  // ── prompt ────────────────────────────────────────────────────
  // Always render the Prompt section — even when empty — so the field never
  // looks "missing". When blank, show an empty-state pointing at Draft Prompt / Edit.
  {
    const s = subSection('Prompt');
    if (agent.instructions && String(agent.instructions).trim()) {
      s.appendChild(el('p', { className: 'dr-prose', style: 'white-space:pre-wrap' }, agent.instructions));
    } else {
      s.appendChild(el('p', { className: 'dr-prose', style: 'font-style:italic;opacity:0.7' },
        'No prompt yet. Use the ✨ Draft Prompt button above to generate one, or Edit to write it. New agents from ingest are drafted automatically.'));
    }
    section.appendChild(s);
  }

  // ── goals + done criteria (side by side) ──────────────────────
  const goalsArr = asArray(agent.goals);
  const doneArr  = asArray(agent.done_criteria);
  if (goalsArr.length || doneArr.length) {
    const row = el('div', { className: 'dr-two-col' });
    if (goalsArr.length) {
      const g = subSection('Goals');
      g.appendChild(el('ol', { className: 'dr-numbered-list' },
        ...goalsArr.map((goal, idx) => {
          const li = el('li', {});
          li.appendChild(el('span', {}, goal));
          li.appendChild(buildItemEditBtn(() => openItemModal('Edit Goal',
            [{ key: 'text', label: 'Goal', type: 'textarea', rows: 3 }],
            { text: goal },
            async upd => {
              const arr = [...goalsArr]; arr[idx] = upd.text;
              await saveArrayField('agent', agent.agent_spec_id, 'goals', arr);
            })));
          return li;
        })));
      row.appendChild(g);
    }
    if (doneArr.length) {
      const d = subSection('Done When');
      d.appendChild(el('ul', { className: 'dr-bullet-list' },
        ...doneArr.map((dc, idx) => {
          const li = el('li', {});
          li.appendChild(el('span', {}, dc));
          li.appendChild(buildItemEditBtn(() => openItemModal('Edit Done Criterion',
            [{ key: 'text', label: 'Criterion', type: 'textarea', rows: 3 }],
            { text: dc },
            async upd => {
              const arr = [...doneArr]; arr[idx] = upd.text;
              await saveArrayField('agent', agent.agent_spec_id, 'done_criteria', arr);
            })));
          return li;
        })));
      row.appendChild(d);
    }
    section.appendChild(row);
  }

  // ── inputs / outputs ──────────────────────────────────────────
  // Read-only here — structured editor TODO (agent inputs/outputs maps)
  const inputsObj  = agent.inputs  || {};
  const outputsObj = agent.outputs || {};
  if (Object.keys(inputsObj).length || Object.keys(outputsObj).length) {
    const row = el('div', { className: 'dr-two-col' });

    if (Object.keys(inputsObj).length) {
      const s = subSection('Inputs');
      s.appendChild(ioTable(inputsObj));
      row.appendChild(s);
    }
    if (Object.keys(outputsObj).length) {
      const s = subSection('Outputs');
      s.appendChild(ioTable(outputsObj));
      row.appendChild(s);
    }
    section.appendChild(row);
  }

  // ── Phase 1 operational metadata — always rendered ──────────────
  {
    const s = subSection('Operational Metadata');
    const grid = el('div', { className: 'dr-kv-grid dr-kv-compact' });
    kvRow(grid, 'Supervision Model',       agent.supervision_model);
    kvRow(grid, 'Orchestration Strategy',  agent.orchestration_strategy);
    kvRow(grid, 'Maintenance Owner',       agent.maintenance_owner);
    kvRow(grid, 'Latency Target',          agent.latency_target);
    // cost_model: only treat 'none' as the literal sentinel, otherwise render value
    kvRow(grid, 'Cost Model',              (agent.cost_model && agent.cost_model !== 'none') ? agent.cost_model : null);
    kvRow(grid, 'Post-Release Validation', agent.post_release_validation);
    s.appendChild(grid);
    section.appendChild(s);
  }

  // ── run configuration — always rendered ───────────────────────
  {
    const rm = agent.run_as_model || {};
    const s = subSection('Run Configuration');
    const grid = el('div', { className: 'dr-kv-grid dr-kv-compact' });
    kvRow(grid, 'Model Type',     rm.model_type ? capitalise(rm.model_type) : null);
    kvRow(grid, 'Trust Level',    rm.trust_level != null ? trustPips(rm.trust_level) : null);
    kvRow(grid, 'Model Rationale', rm.rationale);
    kvRow(grid, 'Memory Strategy', agent.memory_strategy);
    s.appendChild(grid);
    section.appendChild(s);
  }

  // ── design risks — always rendered ────────────────────────────
  const risks = asArray(agent.design_risks);
  {
    const s = subSection('Design Risks & Mitigations');
    if (risks.length === 0) {
      s.appendChild(el('div', { style: 'color:var(--text-muted);font-style:italic;font-size:12px' },
        '— (none recorded yet)'));
      section.appendChild(s);
    }
  }
  if (risks.length) {
    const s = subSection('Design Risks & Mitigations');
    const list = el('div', { className: 'dr-risk-list' });
    risks.forEach((r, i) => {
      const text = typeof r === 'string' ? r : JSON.stringify(r);
      const dashIdx = text.indexOf(' — mitigation:');
      const riskText   = dashIdx > -1 ? text.slice(0, dashIdx) : text;
      const mitigation = dashIdx > -1 ? text.slice(dashIdx + ' — mitigation:'.length).trim() : '';
      const risk = el('div', { className: 'dr-risk-item' });
      risk.appendChild(el('span', { className: 'dr-risk-num' }, String(i + 1)));
      const inner = el('div', { style: { flex: '1' } });
      inner.appendChild(el('div', { className: 'dr-risk-text' }, riskText));
      if (mitigation) inner.appendChild(el('div', { className: 'dr-risk-mit' }, `Mitigation: ${mitigation}`));
      risk.appendChild(inner);
      risk.appendChild(buildItemEditBtn(() => openItemModal('Edit Design Risk',
        [{ key: 'risk', label: 'Risk', type: 'textarea', rows: 2 },
         { key: 'mitigation', label: 'Mitigation (optional)', type: 'textarea', rows: 2 }],
        { risk: riskText, mitigation },
        async upd => {
          const newText = upd.mitigation.trim()
            ? `${upd.risk.trim()} — mitigation: ${upd.mitigation.trim()}`
            : upd.risk.trim();
          const arr = [...risks]; arr[i] = newText;
          await saveArrayField('agent', agent.agent_spec_id, 'design_risks', arr);
        })));
      list.appendChild(risk);
    });
    s.appendChild(list);
    section.appendChild(s);
  }

  // ── Phase 3: linked use cases (M:N) ──────────────────────────
  {
    const ucLinks = agent.use_cases || [];
    const s = subSection('Linked Use Cases');
    const titleRow = el('div', { className: 'dr-subsection-title-row' });
    titleRow.appendChild(el('span', {}, `${ucLinks.length} linked`));
    const addBtn = el('button', { className: 'dr-row-add-btn', title: 'Link a Use Case' }, '＋ Link');
    addBtn.addEventListener('click', () => openAgentUCModal(agent));
    titleRow.appendChild(addBtn);
    s.appendChild(titleRow);

    if (ucLinks.length) {
      const tbl = el('table', { className: 'dr-compact-table', style: { width: '100%' } });
      tbl.innerHTML = '<thead><tr><th>Slug</th><th>Use Case</th><th>Business Value</th><th style="width:48px"></th></tr></thead>';
      const tbody = el('tbody');
      ucLinks.forEach(uc => {
        const tr = el('tr');
        tr.appendChild(el('td', {}, el('span', { className: 'dr-slug-badge' }, uc.slug || '—')));
        const titleTd = el('td', {});
        const link = el('a', {
          href: '#', className: 'dr-breadcrumb-link',
          title: `Go to ${uc.title}`,
          'data-scope': 'use-cases', 'data-anchor': `dr-entity-${uc.use_case_id}`
        }, uc.title || '—');
        link.addEventListener('click', e => {
          e.preventDefault();
          const scope = link.getAttribute('data-scope');
          const anchor = link.getAttribute('data-anchor');
          import('./app.js').then(m => m.navigateTo && m.navigateTo(scope, anchor))
            .catch(() => document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth' }));
        });
        titleTd.appendChild(link);
        tr.appendChild(titleTd);
        tr.appendChild(el('td', { style: { fontSize: '11px', color: 'var(--color-text-muted)' } }, uc.business_value || ''));
        const actTd = el('td', { style: { textAlign: 'right' } });
        const delBtn = el('button', { className: 'dr-delete-btn', title: 'Unlink this use case' }, '✕');
        delBtn.addEventListener('click', async () => {
          if (!confirm(`Unlink "${uc.title}" from this agent?`)) return;
          const { apiFetch } = await import('./app.js');
          const r = await apiFetch(`/projects/${agent.project_id}/agents/${agent.agent_spec_id}/use-cases/${uc.agent_use_case_id}`, { method: 'DELETE' });
          if (r?.deleted) { const { showToast } = await import('./app.js'); showToast('Use case unlinked'); reload(); }
        });
        actTd.appendChild(delBtn);
        tr.appendChild(actTd);
        tbody.appendChild(tr);
      });
      tbl.appendChild(tbody);
      s.appendChild(tbl);
    } else {
      s.appendChild(el('p', { className: 'dr-empty-note' }, 'No use cases linked yet. Click ＋ Link to associate this agent with a use case.'));
    }
    section.appendChild(s);
  }

  // ── Phase 3: tool bindings ────────────────────────────────────
  {
    const bindings = agent.tool_bindings || [];
    const s = subSection('Tool Bindings');
    const titleRow = el('div', { className: 'dr-subsection-title-row' });
    titleRow.appendChild(el('span', {}, `${bindings.length} bound`));
    const addBtn = el('button', { className: 'dr-row-add-btn', title: 'Bind a tool to this agent' }, '＋ Bind');
    addBtn.addEventListener('click', () => openAgentToolModal(agent));
    titleRow.appendChild(addBtn);
    s.appendChild(titleRow);

    if (bindings.length) {
      const tbl = el('table', { className: 'dr-compact-table', style: { width: '100%' } });
      tbl.innerHTML = '<thead><tr><th>Tool</th><th>Purpose</th><th style="width:100px">Execution</th><th style="width:90px">Supervision</th><th style="width:72px"></th></tr></thead>';
      const tbody = el('tbody');
      bindings.forEach(b => {
        const tr = el('tr');
        const nameTd = el('td', {});
        if (b.tool_slug) nameTd.appendChild(el('span', { className: 'dr-slug-badge' }, b.tool_slug));
        nameTd.appendChild(document.createTextNode(' ' + (b.tool_name || '—')));
        const bindingSg = aiSuggestedBadge({ system_generated: b.tool_system_generated });
        if (bindingSg) { nameTd.appendChild(document.createTextNode(' ')); nameTd.appendChild(bindingSg); }
        tr.appendChild(nameTd);
        tr.appendChild(el('td', { style: { fontSize: '12px' } }, b.purpose || ''));
        tr.appendChild(el('td', { style: { fontSize: '11px' } }, b.tool_execution_mode || ''));
        tr.appendChild(el('td', { style: { fontSize: '11px' } }, b.binding_supervision_model || ''));
        const actTd = el('td', { style: { textAlign: 'right' } });
        const eb = el('button', { className: 'dr-row-icon-btn', title: 'Edit binding' }, '✏️');
        eb.addEventListener('click', () => openAgentToolModal(agent, b));
        const db2 = el('button', { className: 'dr-delete-btn', title: 'Remove binding', style: { marginLeft: '4px' } }, '✕');
        db2.addEventListener('click', async () => {
          if (!confirm(`Remove "${b.tool_name}" binding?`)) return;
          const { apiFetch } = await import('./app.js');
          const r = await apiFetch(`/projects/${agent.project_id}/agents/${agent.agent_spec_id}/tools/${b.agent_tool_id}`, { method: 'DELETE' });
          if (r?.deleted) { const { showToast } = await import('./app.js'); showToast('Tool binding removed'); reload(); }
        });
        actTd.appendChild(eb); actTd.appendChild(db2);
        tr.appendChild(actTd);
        tbody.appendChild(tr);
      });
      tbl.appendChild(tbody);
      s.appendChild(tbl);
    } else {
      s.appendChild(el('p', { className: 'dr-empty-note' }, 'No tools bound yet. Click ＋ Bind to add a tool.'));
    }
    section.appendChild(s);
  }

  return section;
}

// ─── workflow block ──────────────────────────────────────────────────────────

function buildWorkflowBlock(wf) {
  const s = subSection(`Workflow: ${wf.name}`, wf.workflow_id ? {
    scope: 'workflows',
    anchorId: `dr-entity-${wf.workflow_id}`,
    label: 'Open on Workflows tab →',
  } : null);

  // Trigger + SLA meta
  const trigger = wf.trigger || {};
  const meta = el('div', { className: 'dr-kv-grid dr-kv-compact', style: { marginBottom: '16px' } });
  if (trigger.description) kvRow(meta, 'Trigger', trigger.description);
  if (trigger.system)       kvRow(meta, 'System',  trigger.system);
  if (wf.sla_hours != null) {
    const slaLabel = wf.sla_hours < 0.1
      ? `${Math.round(wf.sla_hours * 60)} min`
      : `${wf.sla_hours} hr`;
    kvRow(meta, 'SLA Target', slaLabel);
  }
  s.appendChild(meta);

  // Steps table
  if (wf.steps?.length) {
    s.appendChild(el('div', { className: 'dr-subsection-label' }, `Steps (${wf.steps.length})`));
    const tbl = el('table', { className: 'dr-table' });
    tbl.innerHTML = '<thead><tr><th style="width:36px">#</th><th>Step Name</th><th>Actor / Role</th><th style="width:60px">SLA</th><th>Key Decisions</th></tr></thead>';
    const tbody = el('tbody');
    wf.steps.forEach(step => {
      const decisions = asArray(step.decisions);
      tbody.appendChild(el('tr', {},
        el('td', { className: 'dr-step-num' }, String(step.step_number)),
        el('td', { className: 'dr-step-name' }, step.name || '—'),
        el('td', { style: { fontSize: '12px', color: 'var(--color-text-muted)' } },
          step.actor_role || '—'),
        el('td', { style: { fontSize: '12px', textAlign: 'center', color: 'var(--color-text-muted)' } },
          step.sla_hours != null ? `${step.sla_hours < 0.1 ? Math.round(step.sla_hours * 60) + 'm' : step.sla_hours + 'h'}` : '—'),
        el('td', { style: { fontSize: '12px' } },
          decisions.length
            ? el('ul', { className: 'dr-micro-list' }, ...decisions.map(d => el('li', {}, typeof d === 'string' ? d : JSON.stringify(d))))
            : el('span', { className: 'dr-muted' }, '—'))
      ));
    });
    tbl.appendChild(tbody);
    s.appendChild(tbl);
  }

  // HITL gates
  if (wf.hitl_gates?.length) {
    s.appendChild(el('div', { className: 'dr-subsection-label', style: { marginTop: '16px' } },
      `Human-in-the-Loop Gates (${wf.hitl_gates.length})`));
    const tbl = el('table', { className: 'dr-table' });
    tbl.innerHTML = '<thead><tr><th>Type</th><th>Criteria</th><th>Reviewer Role</th><th>SLA</th><th>Handoff</th></tr></thead>';
    const tbody = el('tbody');
    wf.hitl_gates.forEach(h => {
      tbody.appendChild(el('tr', {},
        el('td', {}, h.gate_type ? el('span', { className: `tag tag-${h.gate_type === 'exception' ? 'warn' : 'info'}` }, capitalise(h.gate_type)) : el('span', { className: 'dr-muted' }, '—')),
        el('td', { style: { fontSize: '12px' } }, h.criteria || '—'),
        el('td', { style: { fontSize: '12px' } }, h.owner_role || '—'),
        el('td', { style: { fontSize: '12px' } }, h.sla || '—'),
        el('td', { style: { fontSize: '12px' } }, h.handoff_mechanism || '—')
      ));
    });
    tbl.appendChild(tbody);
    s.appendChild(tbl);
  }

  return s;
}

// ─── tools block ─────────────────────────────────────────────────────────────

function buildToolsBlock(tools) {
  const s = subSection(`Tools (${tools.length})`, { scope: 'tools', label: 'Open on Tools tab →' });
  const grid = el('div', { className: 'dr-tool-grid' });

  tools.forEach(tool => {
    const card = el('div', { className: 'dr-tool-card' });

    // Tool header
    const cardHdr = el('div', { className: 'dr-tool-card-header' });
    if (tool.tool_id) {
      const nameLink = drillLink(tool.name, 'tools', `dr-entity-${tool.tool_id}`);
      nameLink.classList.add('dr-tool-name');
      cardHdr.appendChild(nameLink);
    } else {
      cardHdr.appendChild(el('span', { className: 'dr-tool-name' }, tool.name));
    }
    if (tool.execution_mode) {
      cardHdr.appendChild(el('span', { className: 'tag tag-info', style: { fontSize: '10px' } },
        capitalise(tool.execution_mode)));
    }
    card.appendChild(cardHdr);

    // Description from contract
    if (tool.contract) {
      card.appendChild(el('p', { className: 'dr-tool-desc' }, tool.contract));
    }

    // Inputs / Outputs side by side
    const ioRow = el('div', { className: 'dr-tool-io' });

    const inputKeys = Object.keys(tool.inputs || {});
    if (inputKeys.length) {
      const box = el('div', { className: 'dr-tool-io-box' });
      box.appendChild(el('div', { className: 'dr-io-label' }, 'Inputs'));
      box.appendChild(ioTable(tool.inputs));
      ioRow.appendChild(box);
    }

    const outputKeys = Object.keys(tool.outputs || {});
    if (outputKeys.length) {
      const box = el('div', { className: 'dr-tool-io-box' });
      box.appendChild(el('div', { className: 'dr-io-label' }, 'Outputs'));
      box.appendChild(ioTable(tool.outputs));
      ioRow.appendChild(box);
    }

    if (inputKeys.length || outputKeys.length) card.appendChild(ioRow);

    // Access & errors
    const errArr = asArray(tool.errors);
    if (tool.access_requirements || errArr.length) {
      const footer = el('div', { className: 'dr-tool-footer' });
      if (tool.access_requirements) {
        footer.appendChild(el('div', { style: { fontSize: '11px' } },
          el('strong', {}, 'Access: '), tool.access_requirements));
      }
      if (errArr.length) {
        const errText = errArr.map(e => typeof e === 'string' ? e : (e.type || JSON.stringify(e))).join(' · ');
        footer.appendChild(el('div', { style: { fontSize: '11px', color: '#b45309', marginTop: '4px' } },
          el('strong', {}, 'Error types: '), errText));
      }
      card.appendChild(footer);
    }

    grid.appendChild(card);
  });

  s.appendChild(grid);
  return s;
}

// ─── guardrails block ────────────────────────────────────────────────────────

function buildGuardrailsBlock(guardrails, ingestDoc = null) {
  const s = subSection(`Guardrails (${guardrails.length})`,
    { scope: 'guardrails', label: 'Open on Guardrails tab →' });
  const list = el('div', { className: 'dr-guardrail-list' });

  guardrails.forEach((g, i) => {
    const id    = g.guardrail_id || g.id || `G${i + 1}`;
    const name  = g.name || '';
    const desc  = g.description || (typeof g === 'string' ? g : '');
    const level = g.enforcement_level || '';

    const item = el('div', { className: 'dr-guardrail-item' });
    const itemHdr = el('div', { className: 'dr-guardrail-header' });
    itemHdr.appendChild(el('span', { className: 'dr-guardrail-id' }, id));
    if (name) itemHdr.appendChild(el('span', { className: 'dr-guardrail-name' }, name));
    if (level) {
      itemHdr.appendChild(el('span', {
        className: `dr-guardrail-badge ${level === 'hard' ? 'badge-hard' : 'badge-soft'}`
      }, capitalise(level)));
    }
    const fb = docFindBtn(name || id, ingestDoc);
    if (fb) itemHdr.appendChild(fb);
    item.appendChild(itemHdr);
    if (desc) item.appendChild(el('p', { className: 'dr-guardrail-desc' }, desc));
    list.appendChild(item);
  });

  s.appendChild(list);
  return s;
}

// ─── data sources block ──────────────────────────────────────────────────────

function buildDataSourcesBlock(sources, ingestDoc = null) {
  const s = subSection(`Data Sources (${sources.length})`,
    { scope: 'data-sources', label: 'Open on Data Sources tab →' });
  const tbl = el('table', { className: 'dr-table' });
  const srcTh = ingestDoc ? '<th style="width:62px"></th>' : '';
  tbl.innerHTML = `<thead><tr><th>System</th><th>Type</th><th>Access</th><th>Owner</th><th>Description</th>${srcTh}</tr></thead>`;
  const tbody = el('tbody');

  sources.forEach(ds => {
    // Prefer source_system (ExxonMobil extraction field) over generic fallbacks
    const name   = ds.source_system || ds.system_name || ds.name || ds.source_name || '—';
    const type   = ds.source_type || ds.type || '—';
    const access = ds.access_rule?.mode || ds.access_mode || ds.access_type || ds.access || '—';
    const owner  = ds.data_owner || ds.owner || '—';
    const desc   = ds.table_or_document || ds.description || ds.summary || '';

    const nameCell = el('td', { style: { fontWeight: '600', whiteSpace: 'nowrap' } }, name);
    const dsSg = aiSuggestedBadge(ds);
    if (dsSg) { nameCell.appendChild(document.createTextNode(' ')); nameCell.appendChild(dsSg); }
    const row = el('tr', {},
      nameCell,
      el('td', {}, type !== '—' ? el('span', { className: 'tag tag-info', style: { fontSize: '10px' } }, capitalise(type)) : el('span', { className: 'dr-muted' }, '—')),
      el('td', { style: { fontSize: '12px', color: 'var(--color-text-muted)' } }, access),
      el('td', { style: { fontSize: '12px' } }, owner),
      el('td', { style: { fontSize: '12px', maxWidth: '300px' } }, desc)
    );
    if (ingestDoc) {
      const fb = docFindBtn(name !== '—' ? name : null, ingestDoc);
      row.appendChild(el('td', { style: { textAlign: 'center', verticalAlign: 'middle', padding: '4px 6px' } },
        ...(fb ? [fb] : [])));
    }
    tbody.appendChild(row);
  });

  tbl.appendChild(tbody);
  s.appendChild(tbl);
  return s;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function subSection(title, drill) {
  const s = el('div', { className: 'dr-subsection' });
  const titleEl = el('div', { className: 'dr-subsection-title' }, title);
  if (drill && drill.scope) {
    titleEl.appendChild(drillLink(drill.label || 'Open →', drill.scope, drill.anchorId || ''));
  }
  s.appendChild(titleEl);
  return s;
}

function kvRow(grid, label, value) {
  const row = el('div', { className: 'dr-kv-row' });
  row.appendChild(el('div', { className: 'dr-kv-key' }, label));
  const valCell = el('div', { className: 'dr-kv-val' });
  // Treat null / undefined / empty-string as "not set" — render a muted placeholder
  // so the field is still visible on the read-only card. Numeric 0 stays as "0".
  if (value === null || value === undefined || value === '') {
    valCell.appendChild(el('span', { className: 'dr-kv-empty',
      style: 'color:var(--text-muted);font-style:italic;font-size:12px' }, '—'));
  } else if (typeof value === 'string' || typeof value === 'number') {
    valCell.textContent = String(value);
  } else {
    valCell.appendChild(value);
  }
  row.appendChild(valCell);
  grid.appendChild(row);
}

function ioTable(obj) {
  if (!obj || typeof obj !== 'object') return el('span', { className: 'dr-muted' }, '—');
  const tbl = el('table', { className: 'dr-io-table' });
  Object.entries(obj).forEach(([key, desc]) => {
    tbl.appendChild(el('tr', {},
      el('td', { className: 'dr-io-key' }, key),
      el('td', { className: 'dr-io-desc' }, typeof desc === 'string' ? desc : JSON.stringify(desc))
    ));
  });
  return tbl;
}

function statusPill(status) {
  const map = { draft: 'muted', active: 'success', deprecated: 'warn', deleted: 'error' };
  return el('span', { className: `tag tag-${map[status] || 'muted'}` }, capitalise(status || 'unknown'));
}

/**
 * Phase 1: Slug badge — small monospace tag rendered before entity names.
 * Returns null when slug is missing so callers can skip appending cleanly.
 */
function slugBadge(slug) {
  if (!slug) return null;
  return el('span', { className: 'dr-slug-badge', title: 'Methodology ID (per project)' }, slug);
}

// "✨ AI-suggested" badge — entities the AI Agent proposed in Suggestive mode
// (system_generated=1) that a human has not yet vetted. Same visual language as the
// Change-Packet review badge. Returns null for human/document-evidenced rows.
function aiSuggestedBadge(row) {
  if (!row || !(row.system_generated === 1 || row.system_generated === true)) return null;
  return el('span', {
    className: 'tag',
    title: 'Proposed by the AI Agent in Suggestive mode — review and confirm or remove.',
    style: 'font-size:10px;background:#ede9fe;color:#6d28d9;border:1px solid #ddd6fe',
  }, '✨ AI-suggested');
}

// Phase 5: visibility scope indicator for tools (and any future cross-project entity).
// Colors picked to be distinct at a glance: project=neutral, global=green-tinted,
// organization=blue, program=purple. Icon prefix reinforces hierarchy.
function scopeBadge(scope) {
  const META = {
    PROJECT:      { label: 'Project',  icon: '◧',  bg: '#eceff1', color: '#455a64',
                    tip: 'Project-scoped — visible only in this project' },
    GLOBAL:       { label: 'Global',   icon: '🌐', bg: '#e8f5e9', color: '#2e7d32',
                    tip: 'Globally visible — available to every project' },
    ORGANIZATION: { label: 'Org',      icon: '🏢', bg: '#e3f2fd', color: '#1565c0',
                    tip: 'Organization-scoped — shared within this organization' },
    PROGRAM:      { label: 'Program',  icon: '🎯', bg: '#f3e5f5', color: '#7b1fa2',
                    tip: 'Program-scoped — shared within this program' },
  };
  const m = META[scope] || META.PROJECT;
  return el('span', {
    className: 'tag',
    title: m.tip,
    style: `background:${m.bg};color:${m.color};font-size:11px;font-weight:500;` +
           `padding:2px 8px;border-radius:10px;display:inline-flex;align-items:center;gap:4px`
  }, m.icon, ' ', m.label);
}

function trustPips(level) {
  const wrap = el('span', { style: { display: 'inline-flex', gap: '3px', alignItems: 'center' } });
  for (let i = 1; i <= 5; i++) {
    wrap.appendChild(el('span', {
      style: {
        width: '10px', height: '10px', borderRadius: '50%',
        background: i <= level ? 'var(--color-accent)' : 'var(--color-border)',
        display: 'inline-block'
      }
    }));
  }
  wrap.appendChild(el('span', { style: { marginLeft: '6px', fontSize: '12px', color: 'var(--color-text-muted)' } },
    `${level} / 5`));
  return wrap;
}

function asArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try { const p = JSON.parse(val); return Array.isArray(p) ? p : [val]; }
    catch { return [val]; }
  }
  return [val];
}

function capitalise(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).replace(/_/g, ' ');
}

// ─── Phase 4: cost formatting ─────────────────────────────────────────────────
function fmtCost(val) {
  if (!val || val <= 0) return null;
  if (val < 100) return '$' + val.toFixed(2);
  if (val < 10000) return '$' + Math.round(val).toLocaleString();
  return '$' + Math.round(val).toLocaleString();
}

function costChip(val, period, title) {
  const fmt = fmtCost(val);
  if (!fmt) return null;
  const chip = el('span', { className: 'tag', title: title || 'Projected cost',
    style: 'background:var(--info-bg,#e8f4fd);color:var(--info-text,#1565c0);font-family:monospace;font-size:11px' },
    `~${fmt}/${period || 'month'}`);
  return chip;
}

function formatTs(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

// ─── workflow section ────────────────────────────────────────────────────────

function buildWorkflowSection(wf) {
  const section = el('div', { className: 'dr-agent' });

  // ── workflow header ───────────────────────────────────────────
  const hdr = el('div', { className: 'dr-agent-header' });
  const wfNameEl = el('div', { className: 'dr-agent-name' });
  const wfSlug = slugBadge(wf.slug);
  if (wfSlug) wfNameEl.appendChild(wfSlug);
  wfNameEl.appendChild(document.createTextNode(wf.name));
  const wfIssue = dataIssueBadge('workflow', wf.workflow_id);
  if (wfIssue) wfNameEl.appendChild(wfIssue);
  hdr.appendChild(wfNameEl);
  const badges = el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } });
  badges.appendChild(statusPill(wf.lifecycle_status));
  const wfSg = aiSuggestedBadge(wf); if (wfSg) badges.appendChild(wfSg);
  if (wf.readiness && wf.readiness !== 'draft') {
    badges.appendChild(el('span', { className: 'tag tag-info' }, capitalise(wf.readiness)));
  }
  // Phase 4: workflow cost chip
  const wfCostChip = costChip(wf.workflow_cost_per_period, 'month', 'Projected AI cost per month');
  if (wfCostChip) badges.appendChild(wfCostChip);
  if (wf.runs_per_period != null) {
    badges.appendChild(el('span', { className: 'tag', title: 'Runs per planning period',
      style: 'font-size:11px' }, `${wf.runs_per_period} runs/period`));
  }
  // Swimlane button
  const swimlaneBtn = el('button', {
    className: 'btn btn-sm btn-secondary',
    title: 'Generate swimlane diagram (PNG download)',
    style: 'display:flex;align-items:center;gap:4px;font-size:12px;padding:3px 10px;',
  }, '⧉ Swimlane');
  let _swimlaneLoading = false;
  swimlaneBtn.addEventListener('click', async () => {
    if (_swimlaneLoading) return;
    _swimlaneLoading = true;
    swimlaneBtn.textContent = '⟳ Generating…';
    swimlaneBtn.disabled = true;
    try {
      const url = `/api/v1/projects/${_currentProjectId}/workflows/${wf.workflow_id}/swimlane`;
      const res  = await fetch(url);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        alert(`Swimlane error: ${err.error || res.statusText}`);
        return;
      }
      const blob   = await res.blob();
      const slug   = wf.slug || 'workflow';
      const link   = document.createElement('a');
      link.href     = URL.createObjectURL(blob);
      link.download = `swimlane-${slug}.svg`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (err) {
      alert(`Swimlane generation failed: ${err.message}`);
    } finally {
      _swimlaneLoading = false;
      swimlaneBtn.textContent = '⧉ Swimlane';
      swimlaneBtn.disabled = false;
    }
  });
  badges.appendChild(swimlaneBtn);

  const wfEditBtn = buildEditBtn('workflow', wf);
  if (wfEditBtn) badges.appendChild(wfEditBtn);
  badges.appendChild(buildAuditBtn('workflow', wf.workflow_id,
    () => { if (_currentReportArea && _currentProjectId && _currentScope) loadReport(_currentReportArea, _currentProjectId, _currentScope); }));
  hdr.appendChild(badges);
  section.appendChild(hdr);

  // ── breadcrumb: parent use case ───────────────────────────────
  if (wf.use_case && wf.use_case.use_case_id) {
    const crumb = buildBreadcrumb([
      { prefix: 'Use Case', name: wf.use_case.title || '—',
        scope: 'use-cases', anchorId: `dr-entity-${wf.use_case.use_case_id}` },
    ]);
    if (crumb) section.appendChild(crumb);
  }

  // ── trigger + SLA — always render every editable field ────────
  const trigger = wf.trigger || {};
  const trig = subSection('Trigger & SLA');
  const grid = el('div', { className: 'dr-kv-grid dr-kv-compact' });
  kvRow(grid, 'Description',   trigger.description);
  kvRow(grid, 'Trigger Type',  trigger.type ? capitalise(trigger.type) : null);
  kvRow(grid, 'Source System', trigger.system);
  kvRow(grid, 'Event Name',    trigger.event_name ? el('code', { className: 'dr-code' }, trigger.event_name) : null);
  kvRow(grid, 'Schedule',      trigger.schedule);
  kvRow(grid, 'SLA Target',    wf.sla_hours != null
    ? (wf.sla_hours < 0.1 ? `${Math.round(wf.sla_hours * 60)} min` : `${wf.sla_hours} hr`)
    : null);
  kvRow(grid, 'Risk Tier', wf.risk_tier
    ? el('span', { className: `tag tag-${wf.risk_tier === 'High' ? 'error' : wf.risk_tier === 'Medium' ? 'warn' : 'success'}` }, wf.risk_tier)
    : null);
  kvRow(grid, 'Runs / Period', wf.runs_per_period != null ? String(wf.runs_per_period) : null);
  trig.appendChild(grid);
  section.appendChild(trig);

  // ── process steps ─────────────────────────────────────────────
  if (wf.steps?.length) {
    const s = subSection(`Process Steps (${wf.steps.length})`);
    const flow = el('div', { className: 'dr-step-flow' });
    wf.steps.forEach((step, i) => {
      flow.appendChild(buildStepCard(step));
      if (i < wf.steps.length - 1) {
        flow.appendChild(el('div', { className: 'dr-step-connector' }, '↓'));
      }
    });
    s.appendChild(flow);
    section.appendChild(s);
  }

  // ── HITL gates ────────────────────────────────────────────────
  // Read-only here — structured editor TODO (workflow hitl_gates)
  if (wf.hitl_gates?.length) {
    const s = subSection(`Human-in-the-Loop Gates (${wf.hitl_gates.length})`);
    wf.hitl_gates.forEach(h => {
      const card = el('div', { className: 'dr-hitl-card' });
      const chdr = el('div', { className: 'dr-hitl-header' });
      if (h.gate_type) chdr.appendChild(el('span', { className: `tag tag-${h.gate_type === 'exception' ? 'warn' : 'info'}` }, capitalise(h.gate_type)));
      if (h.owner_role) chdr.appendChild(el('span', { style: { fontSize: '13px', fontWeight: '600' } }, `Reviewer: ${h.owner_role}`));
      if (h.sla)        chdr.appendChild(el('span', { style: { fontSize: '12px', color: 'var(--color-text-muted)' } }, `SLA: ${h.sla}`));
      card.appendChild(chdr);
      if (h.criteria) card.appendChild(el('p', { className: 'dr-prose', style: { marginTop: '8px', fontSize: '13px' } }, h.criteria));
      if (h.handoff_mechanism) card.appendChild(el('div', { style: { marginTop: '6px', fontSize: '12px', color: 'var(--color-text-secondary)' } }, el('strong', {}, 'Handoff: '), h.handoff_mechanism));
      s.appendChild(card);
    });
    section.appendChild(s);
  }

  // ── handoff interactions ──────────────────────────────────────
  const handoffs = asArray(wf.handoffs);
  if (handoffs.length) {
    const s = subSection(`Handoff Interactions (${handoffs.length})`);
    const tbl = el('table', { className: 'dr-table' });
    tbl.innerHTML = '<thead><tr><th>ID</th><th>From</th><th>To</th><th>Trigger Condition</th><th>Pattern</th><th>On Success</th></tr></thead>';
    const tbody = el('tbody');
    handoffs.forEach(h => {
      if (typeof h !== 'object') return;
      tbody.appendChild(el('tr', {},
        el('td', { style: { fontFamily: 'monospace', fontSize: '11px' } }, h.interaction_id || '—'),
        el('td', { style: { fontSize: '12px', fontWeight: '600' } }, h.from || '—'),
        el('td', { style: { fontSize: '12px', fontWeight: '600' } }, h.to || '—'),
        el('td', { style: { fontSize: '12px' } }, h.trigger_condition || '—'),
        el('td', {}, h.execution_pattern
          ? el('span', { className: 'tag tag-info', style: { fontSize: '10px' } }, capitalise(h.execution_pattern))
          : el('span', {}, '—')),
        el('td', { style: { fontSize: '12px' } }, h.on_success || '—')
      ));
    });
    tbl.appendChild(tbody);
    s.appendChild(tbl);
    section.appendChild(s);
  }

  // ── fallback paths ────────────────────────────────────────────
  const fallbacks = asArray(wf.fallback_paths);
  if (fallbacks.length) {
    const s = subSection('Fallback Paths');
    s.appendChild(el('ul', { className: 'dr-bullet-list' },
      ...fallbacks.map(f => el('li', {}, typeof f === 'string' ? f : JSON.stringify(f)))));
    section.appendChild(s);
  }

  // ── Phase 2: Participants Register (editable) ─────────────────
  {
    const participants = wf.participants || [];
    const ps = el('div', { className: 'dr-subsection' });
    const psHdr = el('div', { className: 'dr-subsection-title dr-subsection-title-row' });
    psHdr.appendChild(el('span', {}, `Participants (${participants.length})`));
    const addPartBtn = el('button', { className: 'dr-row-add-btn', title: 'Add participant' }, '＋ Add');
    addPartBtn.addEventListener('click', () => openParticipantModal(wf));
    psHdr.appendChild(addPartBtn);
    ps.appendChild(psHdr);
    if (participants.length) {
      const typeColor = { 'Orchestrator Agent': 'info', 'Specialist Agent': 'success', 'Human Role': 'muted', 'Human Coordinator': 'warn' };
      const tbl = el('table', { className: 'dr-table' });
      tbl.innerHTML = '<thead><tr><th style="width:56px">ID</th><th style="width:120px">Type</th><th>Name / Role</th><th style="width:120px">Authority</th><th style="width:110px">Handoff</th><th>Purpose</th><th style="width:48px"></th></tr></thead>';
      const tbody = el('tbody');
      participants.forEach(p => {
        const displayName = participantLabel(p);
        const actCell = el('td', { style: { textAlign: 'right' } });
        const eb = el('button', { className: 'dr-row-icon-btn', title: 'Edit participant' }, '✏️');
        eb.addEventListener('click', () => openParticipantModal(wf, p));
        actCell.appendChild(eb);
        tbody.appendChild(el('tr', {},
          el('td', { style: { fontFamily: 'monospace', fontSize: '11px', color: 'var(--color-accent)' } }, p.slug || '—'),
          el('td', {}, el('span', { className: `tag tag-${typeColor[p.participant_type] || 'muted'}`, style: { fontSize: '10px' } }, p.participant_type)),
          el('td', { style: { fontWeight: '600', fontSize: '13px' } }, displayName),
          el('td', { style: { fontSize: '12px' } }, p.authority_level || '—'),
          el('td', { style: { fontSize: '12px' } }, p.handoff_method || '—'),
          el('td', { style: { fontSize: '12px', color: 'var(--color-text-secondary)' } }, p.purpose_in_workflow || '—'),
          actCell
        ));
      });
      tbl.appendChild(tbody);
      ps.appendChild(tbl);
    } else {
      ps.appendChild(el('p', { style: { color: 'var(--color-text-muted)', fontSize: '12px', margin: '6px 0 0' } },
        'No participants yet — click ＋ Add to define who is involved in this workflow.'));
    }
    section.appendChild(ps);
  }

  // ── Phase 2: RASIC Matrix (editable cells) ────────────────────
  {
    const rasicByStep = wf.rasic_by_step || {};
    const rasicParticipants = (wf.participants || []).filter(p => p.include_in_rasic !== 0);
    const allSteps = wf.steps || [];
    if (rasicParticipants.length && allSteps.length) {
      const rs = subSection('RASIC Matrix');
      const hint = el('div', { style: { fontSize: '11px', color: 'var(--color-text-muted)', marginBottom: '8px' } },
        'Click any cell to toggle R / A / S / I / C codes for that step × participant combination.');
      rs.appendChild(hint);
      const tbl = el('table', { className: 'dr-table dr-rasic-table' });
      const thead = el('thead');
      const hrow = el('tr');
      hrow.appendChild(el('th', { style: { minWidth: '150px' } }, 'Step'));
      rasicParticipants.forEach(p => {
        const label = participantLabel(p, true);
        hrow.appendChild(el('th', { style: { textAlign: 'center', fontSize: '11px', minWidth: '80px' } }, label));
      });
      thead.appendChild(hrow);
      tbl.appendChild(thead);
      const tbody = el('tbody');
      allSteps.forEach(step => {
        const tr = el('tr');
        tr.appendChild(el('td', { style: { fontSize: '12px', fontWeight: '600' } },
          `${step.step_number}. ${step.name}`));
        const stepRasic = rasicByStep[step.workflow_step_id] || {};
        rasicParticipants.forEach(p => {
          const entries = stepRasic[p.workflow_participant_id] || [];
          const codes = entries.map(e => (typeof e === 'string' ? e : e.code)).sort().join('');
          const td = el('td', {
            className: 'dr-rasic-cell',
            title: `Click to edit ${step.name} × ${participantLabel(p)}`,
            style: { textAlign: 'center', fontFamily: 'monospace', fontWeight: '700', fontSize: '13px',
                     cursor: 'pointer',
                     color: codes ? 'var(--color-accent)' : 'var(--color-text-muted)' }
          }, codes || '·');
          td.addEventListener('click', e => {
            e.stopPropagation();
            openRasicPopover(td, wf, step, p, entries);
          });
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      tbl.appendChild(tbody);
      rs.appendChild(tbl);
      section.appendChild(rs);
    }
  }

  // ── Phase 2: Workflow Paths (editable) ────────────────────────
  {
    const paths = wf.paths || [];
    const ps2 = el('div', { className: 'dr-subsection' });
    const ps2Hdr = el('div', { className: 'dr-subsection-title dr-subsection-title-row' });
    ps2Hdr.appendChild(el('span', {}, `Paths (${paths.length})`));
    const addPathBtn = el('button', { className: 'dr-row-add-btn', title: 'Add path' }, '＋ Add');
    addPathBtn.addEventListener('click', () => openPathModal(wf));
    ps2Hdr.appendChild(addPathBtn);
    ps2.appendChild(ps2Hdr);
    if (paths.length) {
      const tbl = el('table', { className: 'dr-table' });
      tbl.innerHTML = '<thead><tr><th style="width:60px">ID</th><th>From</th><th>To</th><th style="width:100px">Label</th><th>Condition</th><th style="width:56px">Default</th><th style="width:48px"></th></tr></thead>';
      const tbody = el('tbody');
      paths.forEach(p => {
        const fromLabel = p.from_step_number != null ? `${p.from_step_number}. ${p.from_step_name}` : p.from_step_id;
        const toLabel   = p.to_step_number   != null ? `${p.to_step_number}. ${p.to_step_name}`   : p.to_step_id;
        const actCell = el('td', { style: { textAlign: 'right' } });
        const eb = el('button', { className: 'dr-row-icon-btn', title: 'Edit path' }, '✏️');
        eb.addEventListener('click', () => openPathModal(wf, p));
        actCell.appendChild(eb);
        tbody.appendChild(el('tr', {},
          el('td', { style: { fontFamily: 'monospace', fontSize: '11px', color: 'var(--color-accent)' } }, p.slug || '—'),
          el('td', { style: { fontSize: '12px' } }, fromLabel),
          el('td', { style: { fontSize: '12px' } }, toLabel),
          el('td', { style: { fontSize: '12px', fontWeight: '600' } }, p.branch_label || '—'),
          el('td', { style: { fontSize: '12px', color: 'var(--color-text-secondary)' } }, p.branch_condition || '—'),
          el('td', { style: { textAlign: 'center' } }, p.is_default_path ? el('span', { className: 'tag tag-success', style: { fontSize: '10px' } }, '✓') : '—'),
          actCell
        ));
      });
      tbl.appendChild(tbody);
      ps2.appendChild(tbl);
    } else {
      ps2.appendChild(el('p', { style: { color: 'var(--color-text-muted)', fontSize: '12px', margin: '6px 0 0' } },
        'No paths yet — click ＋ Add to define step-to-step routing.'));
    }
    section.appendChild(ps2);
  }

  return section;
}

// ─── step card ───────────────────────────────────────────────────────────────

function buildStepCard(step) {
  const card = el('div', { className: 'dr-step-card' });

  // header row
  const hdr = el('div', { className: 'dr-step-card-header' });
  hdr.appendChild(el('span', { className: 'dr-step-number' }, String(step.step_number)));
  const nameEl = el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flex: '1', minWidth: 0 } });
  const stepSlug = slugBadge(step.slug);
  if (stepSlug) nameEl.appendChild(stepSlug);
  nameEl.appendChild(el('span', { className: 'dr-step-card-name' }, step.name || '—'));
  const stepIssue = dataIssueBadge('workflow_step', step.workflow_step_id);
  if (stepIssue) nameEl.appendChild(stepIssue);
  const stepSg = aiSuggestedBadge(step); if (stepSg) nameEl.appendChild(stepSg);
  hdr.appendChild(nameEl);
  const metaChips = el('div', { className: 'dr-step-card-meta' });
  // Phase 1: step_type chip
  if (step.step_type) {
    const typeColor = { Start: 'success', End: 'error', Decision: 'warn', Approval: 'warn',
                        Activity: 'info', Notification: 'muted', Wait: 'muted' }[step.step_type] || 'muted';
    metaChips.appendChild(el('span', { className: `tag tag-${typeColor}`, style: { fontSize: '10px' } }, step.step_type));
  }
  if (step.actor_role) metaChips.appendChild(el('span', { className: 'tag tag-muted', style: { fontSize: '10px' } }, step.actor_role));
  if (step.sla_hours != null) {
    const sl = step.sla_hours < 0.1
      ? `${Math.round(step.sla_hours * 60)}m`
      : `${step.sla_hours}h`;
    metaChips.appendChild(el('span', { style: { fontSize: '11px', color: 'var(--color-text-muted)' } }, `SLA: ${sl}`));
  }
  if (step.hitl_gate) metaChips.appendChild(el('span', { className: 'tag tag-warn', style: { fontSize: '10px' } }, '⚡ HITL'));
  const stepEditBtn = step.workflow_step_id ? buildEditBtn('workflow_step', step) : null;
  if (stepEditBtn) metaChips.appendChild(stepEditBtn);
  hdr.appendChild(metaChips);
  card.appendChild(hdr);

  // Phase 1: step_purpose / preconditions / evidence_captured — always rendered
  {
    const meta = el('div', { className: 'dr-kv-grid dr-kv-compact', style: { margin: '6px 0 2px' } });
    kvRow(meta, 'Purpose',       step.step_purpose);
    kvRow(meta, 'Preconditions', step.preconditions);
    kvRow(meta, 'Evidence',      step.evidence_captured);
    card.appendChild(meta);
  }

  // inputs / outputs
  const inputKeys  = Object.keys(step.inputs  || {});
  const outputKeys = Object.keys(step.outputs || {});
  if (inputKeys.length || outputKeys.length) {
    const ioRow = el('div', { className: 'dr-tool-io' });
    if (inputKeys.length) {
      const box = el('div', { className: 'dr-tool-io-box' });
      box.appendChild(el('div', { className: 'dr-io-label' }, 'Inputs'));
      box.appendChild(ioTable(step.inputs));
      ioRow.appendChild(box);
    }
    if (outputKeys.length) {
      const box = el('div', { className: 'dr-tool-io-box' });
      box.appendChild(el('div', { className: 'dr-io-label' }, 'Outputs'));
      box.appendChild(ioTable(step.outputs));
      ioRow.appendChild(box);
    }
    card.appendChild(ioRow);
  }

  // decisions
  const decisions = asArray(step.decisions);
  if (decisions.length) {
    const dec = el('div', { className: 'dr-step-decisions' });
    dec.appendChild(el('div', { className: 'dr-io-label' }, 'Key Decisions'));
    dec.appendChild(el('ul', { className: 'dr-micro-list' },
      ...decisions.map(d => el('li', {}, typeof d === 'string' ? d : JSON.stringify(d)))));
    card.appendChild(dec);
  }

  // Phase 4: cost bindings display
  const bindings = step.cost_bindings || [];
  if (bindings.length > 0) {
    const cbSec = el('div', { style: 'margin-top:8px;border-top:1px solid var(--border-subtle,#e5e7eb);padding-top:6px' });
    cbSec.appendChild(el('div', { className: 'dr-io-label' }, '💰 Cost Bindings'));
    const cbTable = el('table', { style: 'width:100%;font-size:11px;border-collapse:collapse' });
    const cbHead = el('thead');
    cbHead.appendChild(el('tr', { style: 'color:var(--text-muted);' },
      el('th', { style: 'text-align:left;padding:2px 4px' }, 'Skill'),
      el('th', { style: 'text-align:right;padding:2px 4px' }, 'Qty'),
      el('th', { style: 'text-align:right;padding:2px 4px' }, 'Branch'),
      el('th', { style: 'text-align:right;padding:2px 4px' }, 'Assists/Unit'),
      el('th', { style: 'text-align:right;padding:2px 4px' }, ''),
    ));
    cbTable.appendChild(cbHead);
    const cbBody = el('tbody');
    bindings.forEach(b => {
      const tr = el('tr');
      const aiBadge = b.ai_generated ? el('span', { title: b.ai_reasoning || 'AI-generated',
        style: 'font-size:9px;background:var(--info-bg,#e8f4fd);color:var(--info-text,#1565c0);padding:1px 4px;border-radius:3px;margin-left:4px' }, 'AI') : null;
      const nameTd = el('td', { style: 'padding:2px 4px' }, b.skill_name);
      if (aiBadge) nameTd.appendChild(aiBadge);
      tr.appendChild(nameTd);
      tr.appendChild(el('td', { style: 'text-align:right;padding:2px 4px;font-family:monospace' }, String(b.qty_per_run)));
      tr.appendChild(el('td', { style: 'text-align:right;padding:2px 4px;color:var(--text-muted)' },
        b.branch_probability != null ? (b.branch_probability * 100).toFixed(0) + '%' : '100%'));
      tr.appendChild(el('td', { style: 'text-align:right;padding:2px 4px;font-family:monospace' }, String(b.assists_per_unit)));
      // Remove button
      const rmBtn = el('button', { className: 'btn-icon', title: 'Remove binding', style: 'font-size:10px;padding:1px 4px' }, '✕');
      rmBtn.addEventListener('click', async () => {
        rmBtn.disabled = true;
        try {
          const pid = _currentProjectId;
          await apiFetch(`/projects/${pid}/steps/${step.workflow_step_id}/cost-bindings/${b.binding_id}`,
            { method: 'DELETE' });
          // Remove row
          tr.remove();
        } catch (err) {
          const { showToast } = await import('../app.js');
          showToast('Remove failed: ' + err.message, 'error');
          rmBtn.disabled = false;
        }
      });
      tr.appendChild(el('td', { style: 'padding:2px 4px' }, rmBtn));
      cbBody.appendChild(tr);
    });
    cbTable.appendChild(cbBody);
    // Show step cost total if available
    if (step.step_cost_per_period > 0) {
      const totalRow = el('tr', { style: 'border-top:1px solid var(--border-subtle,#e5e7eb);font-weight:600' },
        el('td', { colSpan: 4, style: 'padding:3px 4px;text-align:right' }, 'Step cost/period:'),
        el('td', { style: 'padding:3px 4px;text-align:right;font-family:monospace;color:var(--info-text,#1565c0)' },
          fmtCost(step.step_cost_per_period) || '—')
      );
      cbBody.appendChild(totalRow);
    }
    cbSec.appendChild(cbTable);
    card.appendChild(cbSec);
  }

  return card;
}

// ─── test scenarios + user stories ──────────────────────────────────────────

function buildTestScenariosBlock(scenarios) {
  const s = subSection(`Test Scenarios (${scenarios.length})`,
    { scope: 'test-scenarios', label: 'Open on Test Scenarios tab →' });
  const typeColors = { behavioral: 'info', security: 'warn', edge_case: 'muted', failure: 'error', performance: 'muted' };
  const tbl = el('table', { className: 'dr-table' });
  tbl.innerHTML = '<thead><tr><th style="width:55px">ID</th><th style="width:105px">Type</th><th>Description</th></tr></thead>';
  const tbody = el('tbody');
  scenarios.forEach(sc => {
    const id   = sc.scenario_id_ref || sc.id || '—';
    const type = (sc.scenario_type || sc.type || '—').replace(/_/g, ' ');
    tbody.appendChild(el('tr', {},
      el('td', { style: { fontFamily: 'monospace', fontSize: '11px', fontWeight: '700', color: 'var(--color-accent)', verticalAlign: 'top' } }, id),
      el('td', { style: { verticalAlign: 'top' } },
        el('span', { className: `tag tag-${typeColors[sc.scenario_type] || 'muted'}`, style: { fontSize: '10px' } }, capitalise(type))),
      el('td', { style: { fontSize: '12px' } }, sc.description || sc.title || '—')
    ));
  });
  tbl.appendChild(tbody);
  s.appendChild(tbl);
  return s;
}

function buildUserStoriesBlock(stories) {
  const s = subSection(`User Stories (${stories.length})`,
    { scope: 'user-stories', label: 'Open on User Stories tab →' });
  const tbl = el('table', { className: 'dr-table' });
  tbl.innerHTML = '<thead><tr><th style="width:70px">ID</th><th style="width:90px">Type</th><th>Title</th><th>Description</th></tr></thead>';
  const tbody = el('tbody');
  stories.forEach(us => {
    const id    = us.story_id_ref || us.id || '—';
    const type  = us.story_type || '—';
    const title = us.title || '—';
    const desc  = us.description || '—';
    const sprintLabel = us.sprint ? el('div', { style: { fontSize: '10px', color: 'var(--color-text-muted)', fontFamily: 'sans-serif', marginTop: '2px' } }, `Sprint ${us.sprint}`) : null;
    const idCell = el('div', {}, el('span', { style: { fontFamily: 'monospace', fontSize: '11px', fontWeight: '700', color: 'var(--color-accent)' } }, id));
    if (sprintLabel) idCell.appendChild(sprintLabel);
    tbody.appendChild(el('tr', {},
      el('td', { style: { verticalAlign: 'top' } }, idCell),
      el('td', { style: { verticalAlign: 'top' } },
        el('span', { className: 'tag tag-info', style: { fontSize: '10px' } }, capitalise(type))),
      el('td', { style: { fontSize: '13px', fontWeight: '600', verticalAlign: 'top' } }, title),
      el('td', { style: { fontSize: '12px', verticalAlign: 'top' } }, desc)
    ));
  });
  tbl.appendChild(tbody);
  s.appendChild(tbl);
  return s;
}

// ─── tools section ───────────────────────────────────────────────────────────

function buildToolsSection(tools) {
  const wrap = el('div');

  tools.forEach((tool, i) => {
    if (i > 0) wrap.appendChild(el('div', { className: 'dr-page-break' }));

    const section = el('div', { className: 'dr-agent' });
    if (tool.tool_id) section.id = `dr-entity-${tool.tool_id}`;

    // ── tool header ───────────────────────────────────────────
    const hdr = el('div', { className: 'dr-agent-header' });
    const nameEl = el('div', { className: 'dr-agent-name' });
    const toolSlug = slugBadge(tool.slug);
    if (toolSlug) nameEl.appendChild(toolSlug);
    nameEl.appendChild(el('code', { className: 'dr-tool-name-code' }, tool.name));
    const toolIssue = dataIssueBadge('tool', tool.tool_id);
    if (toolIssue) nameEl.appendChild(toolIssue);
    hdr.appendChild(nameEl);
    const badges = el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } });
    const toolSg = aiSuggestedBadge(tool); if (toolSg) badges.appendChild(toolSg);
    if (tool.execution_mode) badges.appendChild(el('span', { className: 'tag tag-info' }, capitalise(tool.execution_mode)));
    badges.appendChild(scopeBadge(tool.visibility_scope));
    if (tool.dev_status) badges.appendChild(el('span', { className: 'tag tag-muted' }, tool.dev_status));
    badges.appendChild(statusPill(tool.lifecycle_status));
    const toolEditBtn = buildEditBtn('tool', tool);
    if (toolEditBtn) badges.appendChild(toolEditBtn);
    badges.appendChild(buildAuditBtn('tool', tool.tool_id,
      () => { if (_currentReportArea && _currentProjectId && _currentScope) loadReport(_currentReportArea, _currentProjectId, _currentScope); }));
    hdr.appendChild(badges);
    section.appendChild(hdr);

    // ── breadcrumb: parent agents (many-to-many) ──────────────
    if (tool.used_by_agents?.length) {
      const items = tool.used_by_agents.map(a => ({
        name: a.name,
        scope: 'agents',
        anchorId: a.agent_spec_id ? `dr-entity-${a.agent_spec_id}` : null,
      }));
      // First item gets the "Used by:" prefix; rest are bare names.
      items[0].prefix = 'Used by';
      const crumb = buildBreadcrumb(items);
      if (crumb) section.appendChild(crumb);
    }

    // ── contract / description — always rendered ──────────────
    const contract = (typeof tool.contract === 'object' && tool.contract) ? tool.contract : {};
    const contractStr = (typeof tool.contract === 'string') ? tool.contract : '';
    const description = contract.description || contractStr;
    {
      const s = subSection('Description');
      if (description) {
        s.appendChild(el('p', { className: 'dr-prose' }, description));
      } else {
        s.appendChild(el('p', { className: 'dr-prose',
          style: 'color:var(--text-muted);font-style:italic;font-size:12px' }, '—'));
      }
      const grid = el('div', { className: 'dr-kv-grid dr-kv-compact', style: { marginTop: '10px' } });
      kvRow(grid, 'Endpoint Type', contract.endpoint_type ? capitalise(contract.endpoint_type) : null);
      kvRow(grid, 'Auth Method',   contract.auth_method);
      kvRow(grid, 'Base URL',      contract.base_url ? el('code', { className: 'dr-code' }, contract.base_url) : null);
      s.appendChild(grid);
      section.appendChild(s);
    }

    // ── inputs / outputs ──────────────────────────────────────
    // Read-only here — structured editor TODO (tool inputs/outputs maps)
    const inputKeys  = Object.keys(tool.inputs  || {});
    const outputKeys = Object.keys(tool.outputs || {});
    if (inputKeys.length || outputKeys.length) {
      const row = el('div', { className: 'dr-two-col' });
      if (inputKeys.length) {
        const s = subSection('Inputs');
        s.appendChild(ioTable(tool.inputs));
        row.appendChild(s);
      }
      if (outputKeys.length) {
        const s = subSection('Outputs');
        s.appendChild(ioTable(tool.outputs));
        row.appendChild(s);
      }
      section.appendChild(row);
    }

    // ── error handling ────────────────────────────────────────
    // Read-only here — structured editor TODO (tool errors with handling/mitigation per row)
    const errors = asArray(tool.errors);
    if (errors.length) {
      const s = subSection('Error Handling');
      const list = el('div', { className: 'dr-risk-list' });
      errors.forEach((e, idx) => {
        const errObj = (typeof e === 'object' && e) ? e : { type: String(e) };
        const item = el('div', { className: 'dr-risk-item' });
        item.appendChild(el('span', { className: 'dr-risk-num' }, String(idx + 1)));
        const inner = el('div', { style: { flex: '1' } });
        inner.appendChild(el('div', { className: 'dr-risk-text' },
          errObj.type || errObj.error || errObj.name || JSON.stringify(e)));
        if (errObj.handling || errObj.description || errObj.mitigation) {
          inner.appendChild(el('div', { className: 'dr-risk-mit' },
            errObj.handling || errObj.description || errObj.mitigation));
        }
        item.appendChild(inner);
        item.appendChild(buildItemEditBtn(() => openItemModal('Edit Error Handler',
          [{ key: 'type',        label: 'Error Type',   type: 'text'     },
           { key: 'description', label: 'Description',  type: 'textarea', rows: 2 },
           { key: 'handling',    label: 'Handling',     type: 'textarea', rows: 2 }],
          { type: errObj.type || '', description: errObj.description || '', handling: errObj.handling || errObj.mitigation || '' },
          async upd => {
            const arr = [...errors];
            arr[idx] = { ...errObj, type: upd.type, description: upd.description, handling: upd.handling };
            await saveArrayField('tool', tool.tool_id, 'errors', arr);
          })));
        list.appendChild(item);
      });
      s.appendChild(list);
      section.appendChild(s);
    }

    // ── integration requirements — always rendered ────────────
    const boundaries = asArray(tool.boundaries);
    {
      const s = subSection('Integration Requirements');
      const grid = el('div', { className: 'dr-kv-grid dr-kv-compact' });
      // Access requirements: nested grid when object, scalar otherwise
      const ar = tool.access_requirements;
      if (ar && typeof ar === 'object') {
        const LABELS = {
          role_required: 'Role Required', data_classification: 'Data Classification',
          contains_pii: 'Contains PII', rate_limit_per_min: 'Rate Limit / Min'
        };
        const arGrid = el('div', { className: 'dr-kv-grid dr-kv-compact' });
        // Always render the four expected keys; arbitrary extras after
        const expectedKeys = ['role_required','data_classification','contains_pii','rate_limit_per_min'];
        expectedKeys.forEach(k => kvRow(arGrid, LABELS[k] || k, ar[k] == null ? null : String(ar[k])));
        Object.entries(ar).forEach(([k, v]) => {
          if (expectedKeys.includes(k)) return;
          kvRow(arGrid, LABELS[k] || k.replace(/_/g, ' '), v == null ? null : String(v));
        });
        kvRow(grid, 'Access', arGrid);
      } else {
        kvRow(grid, 'Access', ar || null);
      }
      kvRow(grid, 'Cost Impact', tool.cost_impact);
      kvRow(grid, 'Boundaries', boundaries.length
        ? el('ul', { className: 'dr-bullet-list' },
            ...boundaries.map(b => el('li', {}, typeof b === 'string' ? b : JSON.stringify(b))))
        : null);
      s.appendChild(grid);
      section.appendChild(s);
    }

    wrap.appendChild(section);
  });

  return wrap;
}

// ─── provenance banner ───────────────────────────────────────────────────────

function provenanceBanner(ingestDoc) {
  if (!ingestDoc) return null;
  const title = ingestDoc.document_title || ingestDoc.title || ingestDoc.file_name || `Ingest ${ingestDoc.ingest_id?.slice(0,8)}`;
  const viewBtn = el('button', { className: 'dr-doc-view-btn' }, '📄 View source doc');
  viewBtn.addEventListener('click', () => openDocViewer(ingestDoc, null));
  return el('div', { className: 'dr-provenance' },
    el('span', { className: 'dr-provenance-label' }, 'Source:'),
    el('span', { className: 'dr-provenance-title' }, title),
    viewBtn
  );
}

// ─── document viewer (slide-in drawer) ──────────────────────────────────────

/** Open (or reuse) the source-document drawer and optionally pre-search a term. */
async function openDocViewer(ingestDoc, searchTerm) {
  if (!ingestDoc?.ingest_id) return;

  const drawer = _docDrawer || createDocDrawer();

  // Update header title
  const titleEl = drawer.querySelector('.dr-doc-drawer-title');
  if (titleEl) titleEl.textContent =
    ingestDoc.document_title || ingestDoc.title || ingestDoc.file_name || 'Source Document';

  // Show drawer + overlay
  drawer.classList.add('open');
  const overlay = document.getElementById('dr-doc-overlay');
  if (overlay) overlay.classList.add('open');

  // Pre-fill search box
  const searchInput = drawer.querySelector('.dr-doc-search');
  const matchCount  = drawer.querySelector('.dr-doc-match-count');
  searchInput.value = searchTerm || '';
  matchCount.textContent = '';

  const contentArea = drawer.querySelector('#dr-doc-content-area');

  // If same document already loaded, just rerun search
  if (_docDrawerIngestId === ingestDoc.ingest_id) {
    if (searchTerm) setTimeout(() => performSearch(searchTerm, matchCount), 60);
    return;
  }

  // Load new document content
  _docDrawerIngestId = ingestDoc.ingest_id;
  contentArea.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><span>Loading document…</span></div>';

  try {
    const data = await apiFetch(`/ingest-documents/${ingestDoc.ingest_id}/content`);
    contentArea.innerHTML = `<div class="dr-doc-md">${renderMarkdown(data.content || '')}</div>`;
    if (searchTerm) setTimeout(() => performSearch(searchTerm, matchCount), 60);
  } catch (err) {
    contentArea.innerHTML = `<div class="error-state"><strong>Could not load document:</strong> ${escHtml(err.message)}</div>`;
  }
}

function closeDocDrawer() {
  if (_docDrawer) _docDrawer.classList.remove('open');
  const overlay = document.getElementById('dr-doc-overlay');
  if (overlay) overlay.classList.remove('open');
}

function createDocDrawer() {
  // Overlay — click to close
  if (!document.getElementById('dr-doc-overlay')) {
    const overlay = document.createElement('div');
    overlay.id = 'dr-doc-overlay';
    overlay.className = 'dr-doc-overlay';
    overlay.addEventListener('click', closeDocDrawer);
    document.body.appendChild(overlay);
  }

  // Reuse existing drawer if already in DOM
  if (document.getElementById('dr-doc-drawer')) {
    _docDrawer = document.getElementById('dr-doc-drawer');
    return _docDrawer;
  }

  const drawer = document.createElement('aside');
  drawer.id  = 'dr-doc-drawer';
  drawer.className = 'dr-doc-drawer';

  // ── Header ────────────────────────────────────────────────────
  const hdr = el('div', { className: 'dr-doc-drawer-header' });
  hdr.appendChild(el('div', { className: 'dr-doc-drawer-title' }, 'Source Document'));
  const closeBtn = el('button', { className: 'dr-doc-close', title: 'Close (Esc)' }, '✕');
  closeBtn.addEventListener('click', closeDocDrawer);
  hdr.appendChild(closeBtn);
  drawer.appendChild(hdr);

  // ── Search bar ────────────────────────────────────────────────
  const searchBar  = el('div', { className: 'dr-doc-search-bar' });
  const searchInput = el('input', { className: 'dr-doc-search', type: 'text', placeholder: 'Search in document…' });
  const matchCount = el('span', { className: 'dr-doc-match-count' });
  const clearBtn   = el('button', { className: 'dr-doc-search-clear', title: 'Clear' }, '✕');
  searchBar.appendChild(searchInput);
  searchBar.appendChild(matchCount);
  searchBar.appendChild(clearBtn);
  drawer.appendChild(searchBar);

  // ── Content area ──────────────────────────────────────────────
  const contentArea = el('div', { className: 'dr-doc-content', id: 'dr-doc-content-area' });
  contentArea.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><span>Loading…</span></div>';
  drawer.appendChild(contentArea);

  document.body.appendChild(drawer);
  _docDrawer = drawer;

  // Wire search input (debounced)
  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => performSearch(searchInput.value, matchCount), 220);
  });
  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    performSearch('', matchCount);
    searchInput.focus();
  });

  // ESC closes the drawer
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && _docDrawer?.classList.contains('open')) closeDocDrawer();
  });

  return drawer;
}

/** Run a text search in the loaded document and highlight matches. */
function performSearch(term, matchCountEl) {
  const contentArea = document.getElementById('dr-doc-content-area');
  if (!contentArea) return;

  // Remove previous highlights
  contentArea.querySelectorAll('mark.dr-doc-highlight').forEach(mark => {
    mark.parentNode.replaceChild(document.createTextNode(mark.textContent), mark);
  });
  contentArea.normalize();

  if (!term || !term.trim()) {
    if (matchCountEl) matchCountEl.textContent = '';
    return;
  }

  const count = applyHighlight(contentArea, term.trim());
  if (matchCountEl) {
    matchCountEl.textContent = count === 0 ? 'No matches' : `${count} match${count !== 1 ? 'es' : ''}`;
    matchCountEl.style.color = count === 0 ? 'var(--color-text-muted)' : '#1e40af';
  }

  // Scroll first match into view
  const first = contentArea.querySelector('mark.dr-doc-highlight');
  if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** Walk text nodes in container and wrap all occurrences of term in <mark>. */
function applyHighlight(container, term) {
  if (!term) return 0;
  const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  let count = 0;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  let node;
  while ((node = walker.nextNode())) nodes.push(node);

  for (const textNode of nodes) {
    const text = textNode.textContent;
    if (!pattern.test(text)) { pattern.lastIndex = 0; continue; }
    pattern.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0, m;
    while ((m = pattern.exec(text)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const mark = document.createElement('mark');
      mark.className = 'dr-doc-highlight';
      mark.textContent = m[0];
      frag.appendChild(mark);
      count++;
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    textNode.parentNode.replaceChild(frag, textNode);
  }
  return count;
}

/** Minimal Markdown → HTML renderer (handles headings, lists, tables, bold, italic, code). */
function renderMarkdown(text) {
  if (!text) return '';
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function inline(s) {
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
    return s;
  }

  const lines = text.split('\n');
  let html = '';
  let inUL = false, inOL = false, inTable = false, inCodeBlock = false, codeAccum = '';

  function closeUL()    { if (inUL) { html += '</ul>'; inUL = false; } }
  function closeOL()    { if (inOL) { html += '</ol>'; inOL = false; } }
  function closeList()  { closeUL(); closeOL(); }
  function closeTable() { if (inTable) { html += '</tbody></table>'; inTable = false; } }
  function closeAll()   { closeList(); closeTable(); }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code block
    if (line.trim().startsWith('```')) {
      if (!inCodeBlock) {
        closeAll();
        inCodeBlock = true;
        codeAccum = '';
      } else {
        html += `<pre><code>${esc(codeAccum)}</code></pre>`;
        inCodeBlock = false;
        codeAccum = '';
      }
      continue;
    }
    if (inCodeBlock) { codeAccum += (codeAccum ? '\n' : '') + line; continue; }

    // Blank line
    if (!line.trim()) { closeAll(); continue; }

    // ATX headings (must check #### before ### etc.)
    const hm = line.match(/^(#{1,4})\s+(.+)/);
    if (hm) {
      closeAll();
      const lvl = hm[1].length;
      html += `<h${lvl}>${inline(hm[2])}</h${lvl}>`;
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}\s*$/.test(line.trim())) { closeAll(); html += '<hr>'; continue; }

    // Table row
    if (line.trim().startsWith('|') && line.includes('|', 1)) {
      closeList();
      // Separator row — skip
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      if (!inTable) {
        html += '<table class="dr-md-table"><thead><tr>';
        cells.forEach(c => { html += `<th>${inline(c)}</th>`; });
        html += '</tr></thead><tbody>';
        inTable = true;
      } else {
        html += '<tr>';
        cells.forEach(c => { html += `<td>${inline(c)}</td>`; });
        html += '</tr>';
      }
      continue;
    }

    // Unordered list
    const ulM = line.match(/^(\s*)[-*+]\s+(.+)/);
    if (ulM) {
      closeOL(); closeTable();
      if (!inUL) { html += '<ul>'; inUL = true; }
      html += `<li>${inline(ulM[2])}</li>`;
      continue;
    }

    // Ordered list
    const olM = line.match(/^(\s*)\d+[.)]\s+(.+)/);
    if (olM) {
      closeUL(); closeTable();
      if (!inOL) { html += '<ol>'; inOL = true; }
      html += `<li>${inline(olM[2])}</li>`;
      continue;
    }

    // Blockquote (treat as italicised paragraph)
    const bq = line.match(/^>\s*(.*)/);
    if (bq) { closeAll(); html += `<blockquote><p>${inline(bq[1])}</p></blockquote>`; continue; }

    // Normal paragraph line
    closeList(); closeTable();
    html += `<p>${inline(line)}</p>`;
  }

  closeAll();
  return html;
}

/** Return a small "Find in source" button, or null if no ingestDoc. */
function docFindBtn(searchTerm, ingestDoc) {
  if (!ingestDoc || !searchTerm) return null;
  const btn = el('button', { className: 'dr-doc-find-btn', title: 'Find this in the source document' }, '🔍 Find');
  btn.addEventListener('click', e => { e.stopPropagation(); openDocViewer(ingestDoc, searchTerm); });
  return btn;
}

// ─── use case section ────────────────────────────────────────────────────────

function buildUseCaseSection(uc) {
  const section = el('div', { className: 'dr-agent' });

  const hdr = el('div', { className: 'dr-agent-header' });
  const ucNameEl = el('div', { className: 'dr-agent-name' });
  const ucSlug = slugBadge(uc.slug);
  if (ucSlug) ucNameEl.appendChild(ucSlug);
  ucNameEl.appendChild(document.createTextNode(uc.title));
  const ucIssue = dataIssueBadge('use_case', uc.use_case_id);
  if (ucIssue) ucNameEl.appendChild(ucIssue);
  hdr.appendChild(ucNameEl);
  const badges = el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } });
  badges.appendChild(statusPill(uc.lifecycle_status));
  const ucSg = aiSuggestedBadge(uc); if (ucSg) badges.appendChild(ucSg);
  if (uc.readiness) badges.appendChild(el('span', { className: 'tag tag-info' }, capitalise(uc.readiness)));
  if (uc.risk_tier) {
    const riskColor = uc.risk_tier === 'High' ? 'error' : uc.risk_tier === 'Medium' ? 'warn' : 'success';
    badges.appendChild(el('span', { className: `tag tag-${riskColor}`, title: 'Risk tier' }, `Risk: ${uc.risk_tier}`));
  }
  // Phase 4: cost chip
  const ucCostChip = costChip(uc.uc_cost_per_period, 'month', 'Projected AI cost per month');
  if (ucCostChip) badges.appendChild(ucCostChip);
  if (uc.roi_ratio != null && uc.roi_ratio > 0) {
    badges.appendChild(el('span', { className: 'tag', title: 'ROI ratio (baseline ÷ projected annual cost)',
      style: 'background:var(--success-bg,#e8f5e9);color:var(--success-text,#2e7d32);font-size:11px' },
      `ROI ~${uc.roi_ratio.toFixed(1)}×`));
  }
  // Phase 4: "Estimate Costs (AI)" moved to the dedicated Costs module (left nav).
  const ucEditBtn = buildEditBtn('use_case', uc);
  if (ucEditBtn) badges.appendChild(ucEditBtn);
  badges.appendChild(buildAuditBtn('use_case', uc.use_case_id,
    () => { if (_currentReportArea && _currentProjectId && _currentScope) loadReport(_currentReportArea, _currentProjectId, _currentScope); }));
  hdr.appendChild(badges);
  section.appendChild(hdr);

  // Key metadata — ALWAYS render every editable field, even when empty.
  // Empty / null / undefined values render as a muted '—' (handled by kvRow).
  // This keeps the read-only card field-for-field aligned with the edit modal.
  const s = subSection('Overview');
  const grid = el('div', { className: 'dr-kv-grid' });
  kvRow(grid, 'Summary',                uc.summary);
  kvRow(grid, 'Business Objective',     uc.business_objective);
  kvRow(grid, 'Expected Value',         uc.expected_value);
  kvRow(grid, 'Primary Success Metric', uc.primary_success_metric);
  kvRow(grid, 'Supervision Model',      uc.supervision_model);
  kvRow(grid, 'Risk Tier',              uc.risk_tier);
  kvRow(grid, 'Owner',                  uc.owner);
  kvRow(grid, 'Baseline Cost / Year',
    uc.baseline_cost_annual_usd != null ? `$${Number(uc.baseline_cost_annual_usd).toLocaleString()}` : null);
  s.appendChild(grid);
  section.appendChild(s);

  // Success criteria — always show section; placeholder when empty
  const criteria = asArray(uc.success_criteria);
  const sc = subSection('Success Criteria');
  if (criteria.length) {
    sc.appendChild(el('ol', { className: 'dr-numbered-list' },
      ...criteria.map(c => el('li', {}, typeof c === 'string' ? c : JSON.stringify(c)))));
  } else {
    sc.appendChild(el('div', { style: 'color:var(--text-muted);font-style:italic;font-size:12px' },
      '— (none recorded yet)'));
  }
  section.appendChild(sc);

  // Constraints — always show section; placeholder when empty
  const constraints = asArray(uc.constraints_list);
  const con = subSection('Constraints');
  if (constraints.length) {
    con.appendChild(el('ul', { className: 'dr-bullet-list' },
      ...constraints.map(c => el('li', {}, typeof c === 'string' ? c : JSON.stringify(c)))));
  } else {
    con.appendChild(el('div', { style: 'color:var(--text-muted);font-style:italic;font-size:12px' },
      '— (none recorded yet)'));
  }
  section.appendChild(con);

  // Volume assumptions — always show the 4 structured sub-fields the edit modal
  // exposes (monthly_requests, peak_concurrency, peak_period, notes), regardless
  // of which keys are present in the JSON. Extra keys (legacy/free-form) render
  // after the standard four.
  const vol = (uc.volume_assumptions && typeof uc.volume_assumptions === 'object' && !Array.isArray(uc.volume_assumptions))
    ? uc.volume_assumptions : {};
  const vs = subSection('Volume Assumptions');
  const vg = el('div', { className: 'dr-kv-grid dr-kv-compact' });
  const standardKeys = ['monthly_requests', 'peak_concurrency', 'peak_period', 'notes'];
  const labelFor = {
    monthly_requests: 'Monthly Requests',
    peak_concurrency: 'Peak Concurrency',
    peak_period:      'Peak Period',
    notes:            'Notes',
  };
  standardKeys.forEach(k => kvRow(vg, labelFor[k], vol[k] == null ? null : String(vol[k])));
  // Surface any extra keys the user may have stored
  Object.entries(vol).forEach(([k, v]) => {
    if (!standardKeys.includes(k)) kvRow(vg, capitalise(k), String(v));
  });
  vs.appendChild(vg);
  section.appendChild(vs);

  // Related entity counts with drill links
  const footer = el('div', { className: 'dr-uc-meta' });
  if (uc.workflow_count > 0) {
    footer.appendChild(drillLink(
      `${uc.workflow_count} workflow${uc.workflow_count !== 1 ? 's' : ''}`,
      'workflows', `dr-entity-${uc.use_case_id}`
    ));
  }
  if (uc.agent_count > 0) {
    footer.appendChild(drillLink(
      `${uc.agent_count} agent${uc.agent_count !== 1 ? 's' : ''}`,
      'agents', `dr-entity-${uc.use_case_id}`
    ));
  }
  if (footer.children.length) section.appendChild(footer);

  return section;
}

// ─── extraction scope sections ───────────────────────────────────────────────

function buildGuardrailsSection(items, ingestDoc) {
  const wrap = el('div', { className: 'dr-agent' });
  const banner = provenanceBanner(ingestDoc);
  if (banner) wrap.appendChild(banner);
  wrap.appendChild(buildGuardrailsBlock(items, ingestDoc));
  return wrap;
}

function buildDataSourcesSection(items, ingestDoc) {
  const wrap = el('div', { className: 'dr-agent' });
  const banner = provenanceBanner(ingestDoc);
  if (banner) wrap.appendChild(banner);
  wrap.appendChild(buildDataSourcesBlock(items, ingestDoc));
  return wrap;
}

function buildTestScenariosSection(items, ingestDoc) {
  const wrap = el('div', { className: 'dr-agent' });
  const banner = provenanceBanner(ingestDoc);
  if (banner) wrap.appendChild(banner);

  // Full-width table with expected_output column
  const s = subSection(`Test Scenarios (${items.length})`);
  const typeColors = { behavioral: 'info', security: 'warn', edge_case: 'muted', failure: 'error', performance: 'muted' };
  const tbl = el('table', { className: 'dr-table' });
  tbl.innerHTML = '<thead><tr><th style="width:80px">ID</th><th style="width:115px">Type</th><th>Description</th><th>Expected Output</th></tr></thead>';
  const tbody = el('tbody');
  items.forEach(sc => {
    const id   = sc.scenario_id_ref || sc.id || '—';
    const type = (sc.scenario_type || sc.type || '—').replace(/_/g, ' ');
    const searchTerm = sc.description ? sc.description.split(' ').slice(0, 7).join(' ') : (id !== '—' ? id : null);
    const idCell = el('td', { style: { verticalAlign: 'top', padding: '8px 10px' } });
    idCell.appendChild(el('span', { style: { fontFamily: 'monospace', fontSize: '11px', fontWeight: '700', color: 'var(--color-accent)', display: 'block' } }, id));
    const fb = docFindBtn(searchTerm, ingestDoc);
    if (fb) idCell.appendChild(fb);
    tbody.appendChild(el('tr', {},
      idCell,
      el('td', { style: { verticalAlign: 'top' } },
        el('span', { className: `tag tag-${typeColors[sc.scenario_type] || 'muted'}`, style: { fontSize: '10px' } }, capitalise(type))),
      el('td', { style: { fontSize: '12px', verticalAlign: 'top' } }, sc.description || sc.title || '—'),
      el('td', { style: { fontSize: '12px', verticalAlign: 'top', color: 'var(--color-text-secondary)' } },
        sc.expected_output || sc.expected_result || '—')
    ));
  });
  tbl.appendChild(tbody);
  s.appendChild(tbl);
  wrap.appendChild(s);
  return wrap;
}

function buildUserStoriesSection(items, ingestDoc) {
  const wrap = el('div', { className: 'dr-agent' });
  const banner = provenanceBanner(ingestDoc);
  if (banner) wrap.appendChild(banner);

  // Group by sprint
  const bySprint = {};
  items.forEach(us => {
    const sprint = us.sprint || 'Unassigned';
    if (!bySprint[sprint]) bySprint[sprint] = [];
    bySprint[sprint].push(us);
  });

  Object.entries(bySprint).forEach(([sprint, stories]) => {
    const s = subSection(sprint === 'Unassigned' ? `User Stories (${stories.length})` : `Sprint ${sprint} — ${stories.length} stories`);
    const tbl = el('table', { className: 'dr-table' });
    tbl.innerHTML = '<thead><tr><th style="width:80px">ID</th><th style="width:100px">Type</th><th>Title</th><th>Description</th><th>Acceptance Criteria</th></tr></thead>';
    const tbody = el('tbody');
    stories.forEach(us => {
      const id    = us.story_id_ref || us.id || '—';
      const type  = us.story_type || '—';
      const title = us.title || '—';
      const desc  = us.description || '—';
      const ac    = us.acceptance_criteria || '—';
      const searchTerm = (title !== '—' ? title : null) || (id !== '—' ? id : null);
      const idCell = el('td', { style: { verticalAlign: 'top', padding: '8px 10px' } });
      idCell.appendChild(el('span', { style: { fontFamily: 'monospace', fontSize: '11px', fontWeight: '700', color: 'var(--color-accent)', display: 'block' } }, id));
      const fb = docFindBtn(searchTerm, ingestDoc);
      if (fb) idCell.appendChild(fb);
      tbody.appendChild(el('tr', {},
        idCell,
        el('td', { style: { verticalAlign: 'top' } },
          el('span', { className: 'tag tag-info', style: { fontSize: '10px' } }, capitalise(type))),
        el('td', { style: { fontSize: '13px', fontWeight: '600', verticalAlign: 'top' } }, title),
        el('td', { style: { fontSize: '12px', verticalAlign: 'top' } }, desc),
        el('td', { style: { fontSize: '12px', verticalAlign: 'top', color: 'var(--color-text-secondary)' } }, ac)
      ));
    });
    tbl.appendChild(tbody);
    s.appendChild(tbl);
    wrap.appendChild(s);
  });

  return wrap;
}

function buildGovernanceSection(items, ingestDoc) {
  const wrap = el('div', { className: 'dr-agent' });
  const banner = provenanceBanner(ingestDoc);
  if (banner) wrap.appendChild(banner);

  const s = subSection(`Governance Controls (${items.length})`);
  const list = el('div', { className: 'dr-guardrail-list' });

  items.forEach((g, i) => {
    const id    = g.governance_id_ref || g.id || `GV${i + 1}`;
    const name  = g.control_name || g.name || '';
    const desc  = g.control_description || g.description || '';
    const risk  = g.risk_classification || g.risk_level || '';
    const approvalsRequired = g.approvals_required;

    const item = el('div', { className: 'dr-guardrail-item' });
    const itemHdr = el('div', { className: 'dr-guardrail-header' });
    itemHdr.appendChild(el('span', { className: 'dr-guardrail-id' }, id));
    if (name) itemHdr.appendChild(el('span', { className: 'dr-guardrail-name' }, name));
    if (risk) {
      const riskVariant = { high: 'danger', critical: 'danger', medium: 'warn', low: 'muted' }[risk.toLowerCase()] || 'info';
      itemHdr.appendChild(el('span', { className: `tag tag-${riskVariant}`, style: { fontSize: '10px' } }, capitalise(risk)));
    }
    if (approvalsRequired != null) {
      itemHdr.appendChild(el('span', { className: 'tag tag-muted', style: { fontSize: '10px' } },
        `${approvalsRequired} approval${approvalsRequired !== 1 ? 's' : ''} required`));
    }
    const gFb = docFindBtn(name || id, ingestDoc);
    if (gFb) itemHdr.appendChild(gFb);
    item.appendChild(itemHdr);
    if (desc) item.appendChild(el('p', { className: 'dr-guardrail-desc' }, desc));

    // Additional governance fields
    const extras = ['compliance_framework', 'owner_role', 'review_frequency'].filter(k => g[k]);
    if (extras.length) {
      const extGrid = el('div', { className: 'dr-kv-grid dr-kv-compact', style: { marginTop: '6px' } });
      if (g.compliance_framework) kvRow(extGrid, 'Framework', g.compliance_framework);
      if (g.owner_role)           kvRow(extGrid, 'Owner Role', g.owner_role);
      if (g.review_frequency)     kvRow(extGrid, 'Review', g.review_frequency);
      item.appendChild(extGrid);
    }

    list.appendChild(item);
  });

  s.appendChild(list);
  wrap.appendChild(s);
  return wrap;
}

// ─── relationships section ───────────────────────────────────────────────────

/**
 * Miller-columns layout for navigating Use Case → Workflow → Agent → Tool.
 * Click an item in column N to fill column N+1 with that item's children.
 * Each item also has a "→" drill link that switches to the entity's own tab.
 */
// ─── ServiceNow round-trip: Level-1 design renderers ─────────────────────────
// Read the materialized design (data model / forms / business logic / catalog)
// at a business altitude. Level-2 provenance (source_*) is intentionally not shown.
function rtHeader(section, entityType, obj) {
  const hdr = el('div', { className: 'dr-agent-header' });
  const nameEl = el('div', { className: 'dr-agent-name' });
  const sb = slugBadge(obj.slug);
  if (sb) nameEl.appendChild(sb);
  nameEl.appendChild(document.createTextNode(obj.name || '(unnamed)'));
  hdr.appendChild(nameEl);
  const badges = el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } });
  badges.appendChild(statusPill(obj.lifecycle_status));
  const editBtn = buildEditBtn(entityType, obj);
  if (editBtn) badges.appendChild(editBtn);
  hdr.appendChild(badges);
  section.appendChild(hdr);
}

function buildDataModelsSection(items) {
  const wrap = el('div', { className: 'dr-agent' });
  items.forEach((dm, idx) => {
    if (idx > 0) wrap.appendChild(el('div', { className: 'dr-page-break' }));
    const section = el('div', { className: 'dr-agent' });
    section.id = `dr-entity-${dm.data_model_id || idx}`;
    rtHeader(section, 'data_model', dm);
    const s = subSection('Overview');
    const grid = el('div', { className: 'dr-kv-grid' });
    kvRow(grid, 'Purpose', dm.purpose);
    kvRow(grid, 'ServiceNow Table', dm.physical_name);
    kvRow(grid, 'Extends', dm.extends_table);
    kvRow(grid, 'Audited', dm.audited ? 'Yes' : 'No');
    s.appendChild(grid);
    section.appendChild(s);
    const fields = asArray(dm.fields);
    const fs = subSection(`Fields (${fields.length})`);
    if (fields.length) {
      const tbl = el('table', { className: 'dr-table' });
      tbl.innerHTML = '<thead><tr><th>Field</th><th>Meaning</th><th style="width:110px">Type</th><th style="width:80px">Required</th><th>Choices / Ref</th></tr></thead>';
      const tb = el('tbody');
      fields.forEach(f => {
        tb.appendChild(el('tr', {},
          el('td', { style: { fontWeight: '600' } }, f.label || '—'),
          el('td', { style: { fontSize: '12px' } }, f.meaning || '—'),
          el('td', {}, f.type_business || '—'),
          el('td', {}, f.mandatory ? 'Yes' : 'No'),
          el('td', { style: { fontSize: '12px' } },
            Array.isArray(f.choices) && f.choices.length ? f.choices.join(', ') : (f.references ? `→ ${f.references}` : '—'))
        ));
      });
      tbl.appendChild(tb);
      fs.appendChild(tbl);
    } else {
      fs.appendChild(el('div', { style: 'color:var(--text-muted);font-style:italic;font-size:12px' }, '— (no fields recorded)'));
    }
    section.appendChild(fs);
    const rels = asArray(dm.relationships);
    if (rels.length) {
      const rsec = subSection(`Relationships (${rels.length})`);
      rsec.appendChild(el('ul', { className: 'dr-numbered-list' },
        ...rels.map(r => el('li', {}, `${r.kind || 'related'} → ${r.target || '?'}${r.description ? ' — ' + r.description : ''}`))));
      section.appendChild(rsec);
    }
    wrap.appendChild(section);
  });
  return wrap;
}

function buildFormDesignsSection(items) {
  const wrap = el('div', { className: 'dr-agent' });
  items.forEach((fd, idx) => {
    if (idx > 0) wrap.appendChild(el('div', { className: 'dr-page-break' }));
    const section = el('div', { className: 'dr-agent' });
    section.id = `dr-entity-${fd.form_design_id || idx}`;
    rtHeader(section, 'form_design', fd);
    const s = subSection('Overview');
    const grid = el('div', { className: 'dr-kv-grid' });
    kvRow(grid, 'View', fd.view_name);
    kvRow(grid, 'Mandatory Fields', asArray(fd.mandatory_fields).join(', '));
    kvRow(grid, 'Read-only Fields', asArray(fd.readonly_fields).join(', '));
    kvRow(grid, 'Behavior', fd.behavior_notes);
    s.appendChild(grid);
    section.appendChild(s);
    const secs = asArray(fd.sections);
    const ss = subSection(`Sections (${secs.length})`);
    if (secs.length) {
      const tbl = el('table', { className: 'dr-table' });
      tbl.innerHTML = '<thead><tr><th style="width:200px">Section</th><th>Fields</th><th style="width:80px">Columns</th></tr></thead>';
      const tb = el('tbody');
      secs.forEach(sec => {
        tb.appendChild(el('tr', {},
          el('td', { style: { fontWeight: '600' } }, sec.section_label || '—'),
          el('td', { style: { fontSize: '12px' } }, Array.isArray(sec.fields) ? sec.fields.join(', ') : '—'),
          el('td', {}, sec.columns != null ? String(sec.columns) : '—')
        ));
      });
      tbl.appendChild(tb);
      ss.appendChild(tbl);
    } else {
      ss.appendChild(el('div', { style: 'color:var(--text-muted);font-style:italic;font-size:12px' }, '— (no sections recorded)'));
    }
    section.appendChild(ss);
    const rls = asArray(fd.related_lists);
    if (rls.length) {
      const rsec = subSection(`Related Lists (${rls.length})`);
      rsec.appendChild(el('ul', { className: 'dr-numbered-list' },
        ...rls.map(r => el('li', {}, `${r.label || r.table || '—'}${r.table && r.label ? ' (' + r.table + ')' : ''}`))));
      section.appendChild(rsec);
    }
    wrap.appendChild(section);
  });
  return wrap;
}

function buildBusinessLogicSection(items) {
  const wrap = el('div', { className: 'dr-agent' });
  const TYPE_LABEL = { business_rule: 'Business Rule', client_script: 'Client Script', script_include: 'Script Include', ui_action: 'UI Action', scheduled_job: 'Scheduled Job', ui_policy: 'UI Policy' };
  items.forEach((bl, idx) => {
    if (idx > 0) wrap.appendChild(el('div', { className: 'dr-page-break' }));
    const section = el('div', { className: 'dr-agent' });
    section.id = `dr-entity-${bl.business_logic_id || idx}`;
    const hdr = el('div', { className: 'dr-agent-header' });
    const nameEl = el('div', { className: 'dr-agent-name' });
    const sb = slugBadge(bl.slug);
    if (sb) nameEl.appendChild(sb);
    nameEl.appendChild(document.createTextNode(bl.name || '(unnamed)'));
    hdr.appendChild(nameEl);
    const badges = el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } });
    badges.appendChild(el('span', { className: 'tag tag-info', style: { fontSize: '10px' } }, TYPE_LABEL[bl.logic_type] || bl.logic_type || '—'));
    badges.appendChild(statusPill(bl.lifecycle_status));
    const editBtn = buildEditBtn('business_logic', bl);
    if (editBtn) badges.appendChild(editBtn);
    hdr.appendChild(badges);
    section.appendChild(hdr);
    const s = subSection('Overview');
    const grid = el('div', { className: 'dr-kv-grid' });
    kvRow(grid, 'What it does', bl.plain_english);
    kvRow(grid, 'When it runs', bl.when_runs);
    kvRow(grid, 'Conditions', bl.conditions);
    kvRow(grid, 'Order', bl.run_order != null ? String(bl.run_order) : null);
    s.appendChild(grid);
    section.appendChild(s);
    wrap.appendChild(section);
  });
  return wrap;
}

function buildCatalogItemsSection(items) {
  const wrap = el('div', { className: 'dr-agent' });
  items.forEach((ci, idx) => {
    if (idx > 0) wrap.appendChild(el('div', { className: 'dr-page-break' }));
    const section = el('div', { className: 'dr-agent' });
    section.id = `dr-entity-${ci.catalog_item_id || idx}`;
    rtHeader(section, 'catalog_item', ci);
    const s = subSection('Overview');
    const grid = el('div', { className: 'dr-kv-grid' });
    kvRow(grid, 'Short Description', ci.short_description);
    kvRow(grid, 'Category', ci.category);
    kvRow(grid, 'Who Can Order', ci.who_can_order);
    kvRow(grid, 'Delivery Time', ci.delivery_time);
    s.appendChild(grid);
    section.appendChild(s);
    const vars = asArray(ci.variables);
    const vs = subSection(`Variables (${vars.length})`);
    if (vars.length) {
      const tbl = el('table', { className: 'dr-table' });
      tbl.innerHTML = '<thead><tr><th>Question</th><th style="width:110px">Type</th><th style="width:80px">Required</th><th>Choices / Help</th></tr></thead>';
      const tb = el('tbody');
      vars.forEach(v => {
        tb.appendChild(el('tr', {},
          el('td', { style: { fontWeight: '600' } }, v.label || '—'),
          el('td', {}, v.type_business || '—'),
          el('td', {}, v.mandatory ? 'Yes' : 'No'),
          el('td', { style: { fontSize: '12px' } },
            Array.isArray(v.choices) && v.choices.length ? v.choices.join(', ') : (v.help || '—'))
        ));
      });
      tbl.appendChild(tb);
      vs.appendChild(tbl);
    } else {
      vs.appendChild(el('div', { style: 'color:var(--text-muted);font-style:italic;font-size:12px' }, '— (no variables recorded)'));
    }
    section.appendChild(vs);
    wrap.appendChild(section);
  });
  return wrap;
}

function buildIntegrationsSection(items) {
  const TYPE_LABEL = { rest_message: 'REST Message', connection_alias: 'Connection Alias' };
  const AUTH_LABEL = { noAuthentication: 'None', basic: 'Basic', oauth2: 'OAuth 2.0' };
  const wrap = el('div', { className: 'dr-agent' });
  items.forEach((intg, idx) => {
    if (idx > 0) wrap.appendChild(el('div', { className: 'dr-page-break' }));
    const section = el('div', { className: 'dr-agent' });
    section.id = `dr-entity-${intg.integration_id || idx}`;
    const hdr = el('div', { className: 'dr-agent-header' });
    const nameEl = el('div', { className: 'dr-agent-name' });
    const sb = slugBadge(intg.slug);
    if (sb) nameEl.appendChild(sb);
    nameEl.appendChild(document.createTextNode(intg.name || '(unnamed)'));
    hdr.appendChild(nameEl);
    const badges = el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } });
    badges.appendChild(el('span', { className: 'tag tag-info', style: { fontSize: '10px' } }, TYPE_LABEL[intg.integration_type] || intg.integration_type || '—'));
    badges.appendChild(statusPill(intg.lifecycle_status));
    const editBtn = buildEditBtn('integration', intg);
    if (editBtn) badges.appendChild(editBtn);
    hdr.appendChild(badges);
    section.appendChild(hdr);
    if (intg.integration_type === 'rest_message') {
      const s = subSection('Overview');
      const grid = el('div', { className: 'dr-kv-grid' });
      kvRow(grid, 'Description', intg.description);
      kvRow(grid, 'Endpoint', intg.endpoint);
      kvRow(grid, 'Authentication', AUTH_LABEL[intg.auth_type] || intg.auth_type);
      kvRow(grid, 'Notes', intg.notes);
      s.appendChild(grid);
      section.appendChild(s);
      const fns = asArray(intg.functions);
      const fs = subSection(`HTTP Functions (${fns.length})`);
      if (fns.length) {
        const tbl = el('table', { className: 'dr-table' });
        tbl.innerHTML = '<thead><tr><th style="width:80px">Method</th><th>Name</th><th>Endpoint</th></tr></thead>';
        const tb = el('tbody');
        fns.forEach(fn => {
          tb.appendChild(el('tr', {},
            el('td', {}, el('code', {}, fn.http_method || '—')),
            el('td', { style: { fontWeight: '600' } }, fn.name || '—'),
            el('td', { style: { fontSize: '12px' } }, fn.endpoint || '(base)')
          ));
        });
        tbl.appendChild(tb);
        fs.appendChild(tbl);
      } else {
        fs.appendChild(el('div', { style: 'color:var(--text-muted);font-style:italic;font-size:12px' }, '— (no functions recorded)'));
      }
      section.appendChild(fs);
    } else {
      const s = subSection('Overview');
      const grid = el('div', { className: 'dr-kv-grid' });
      kvRow(grid, 'Description', intg.description);
      kvRow(grid, 'Alias Type', intg.alias_type);
      kvRow(grid, 'Connection Type', intg.connection_type);
      kvRow(grid, 'Notes', intg.notes);
      s.appendChild(grid);
      section.appendChild(s);
    }
    wrap.appendChild(section);
  });
  return wrap;
}

function buildRelationshipsSection(relationships, functionalReqs = [], nonfunctionalReqs = [], useCaseMap = {}, dataMdls = [], catalogItems = [], integrations = [], tierAEntities = {}) {
  const wrap = el('div', { className: 'dr-agent' });

  const { use_cases = [], orphaned_workflows = [], tools_are_project_wide = false } = relationships;

  const hasWorkflowLayer = use_cases.length > 0 || orphaned_workflows.length > 0;
  const hasPlatformLayer = dataMdls.length > 0;
  const hasIntegLayer    = catalogItems.length > 0 || integrations.length > 0;

  if (!hasWorkflowLayer && !hasPlatformLayer && !hasIntegLayer) {
    wrap.appendChild(el('div', { className: 'empty-state', style: { margin: '20px 0' } },
      el('p', {}, 'No relationships found for this application.')));
    return wrap;
  }

  wrap.appendChild(el('p', { className: 'purpose-text', style: { marginBottom: '14px' } },
    'Click an item to see what it contains. Use the arrow link to jump to the entity\'s detail tab.'));

  // ── Section 1: Workflow Design ─────────────────────────────────
  if (hasWorkflowLayer) {
    wrap.appendChild(el('div', { className: 'dr-section-header', style: { marginBottom: '12px' } },
      el('span', { className: 'dr-section-title' }, 'Workflow Design')));

    const mc = el('div', { className: 'dr-mc' });
    const col1 = buildMcColumn('Use Cases');
    const col2 = buildMcColumn('Workflows');
    const col3 = buildMcColumn('Agents');
    const col4 = buildMcColumn(tools_are_project_wide ? 'Tools (project-wide)' : 'Tools');
    mc.appendChild(col1.wrap);
    mc.appendChild(col2.wrap);
    mc.appendChild(col3.wrap);
    mc.appendChild(col4.wrap);
    wrap.appendChild(mc);

    // Build the UC list for the miller, appending an orphan pseudo-entry when needed.
    const ORPHAN_ID = '__orphaned__';
    const ucListForMiller = [...use_cases];
    if (orphaned_workflows.length > 0) {
      ucListForMiller.push({
        use_case_id: ORPHAN_ID,
        title: 'No Use Case',
        readiness: null,
        workflows: orphaned_workflows,
        _isOrphan: true,
      });
    }

    let selUC = null, selWF = null, selAG = null;

    function renderCol1() {
      col1.body.innerHTML = '';
      ucListForMiller.forEach(uc => {
        const wfCount = uc.workflows?.length || 0;
        const item = mcItem(
          uc._isOrphan ? '⚠ No Use Case' : uc.title,
          uc._isOrphan ? null : 'use-cases',
          uc._isOrphan ? null : `dr-entity-${uc.use_case_id}`,
          {
            active: selUC && selUC.use_case_id === uc.use_case_id,
            secondary: wfCount ? `${wfCount} workflow${wfCount !== 1 ? 's' : ''}` : 'no workflows',
            onSelect: () => { selUC = uc; selWF = null; selAG = null; renderAll(); },
          });
        if (uc._isOrphan) item.style.cssText += ';border-top:1px solid var(--border,#e0e0e0);margin-top:4px;padding-top:4px;';
        col1.body.appendChild(item);
      });
    }
    function renderCol2() {
      col2.body.innerHTML = '';
      if (!selUC) { col2.body.appendChild(emptyHint('Select a use case →')); return; }
      const wfs = selUC.workflows || [];
      if (!wfs.length) { col2.body.appendChild(emptyHint('No workflows linked')); return; }
      wfs.forEach(wf => {
        col2.body.appendChild(mcItem(wf.name, 'workflows', `dr-entity-${wf.workflow_id}`, {
          active: selWF && selWF.workflow_id === wf.workflow_id,
          secondary: `${wf.step_count || 0} step${(wf.step_count || 0) !== 1 ? 's' : ''}`,
          onSelect: () => { selWF = wf; selAG = null; renderAll(); },
        }));
      });
    }
    function renderCol3() {
      col3.body.innerHTML = '';
      if (!selWF) { col3.body.appendChild(emptyHint('Select a workflow →')); return; }
      const ags = selWF.agents || [];
      if (!ags.length) { col3.body.appendChild(emptyHint('No agents linked')); return; }
      ags.forEach(ag => {
        col3.body.appendChild(mcItem(ag.name, 'agents', `dr-entity-${ag.agent_spec_id}`, {
          active: selAG && selAG.agent_spec_id === ag.agent_spec_id,
          onSelect: () => { selAG = ag; renderAll(); },
        }));
      });
    }
    function renderCol4() {
      col4.body.innerHTML = '';
      if (!selAG) { col4.body.appendChild(emptyHint('Select an agent →')); return; }
      const tools = selAG.tools || [];
      if (!tools.length) { col4.body.appendChild(emptyHint('No tools linked')); return; }
      if (tools_are_project_wide) {
        col4.body.appendChild(el('div', { className: 'dr-mc-note' },
          'Agent-tool relationships are not yet captured — showing all project tools.'));
      }
      tools.forEach(t => {
        col4.body.appendChild(mcItem(t.name, 'tools', `dr-entity-${t.tool_id}`, {
          secondary: t.execution_mode ? capitalise(t.execution_mode) : '',
        }));
      });
    }
    function renderAll() { renderCol1(); renderCol2(); renderCol3(); renderCol4(); }

    // Auto-select first UC with workflows, fall back to first UC.
    selUC = ucListForMiller.find(uc => uc.workflows?.length) || ucListForMiller[0] || null;
    if (selUC?.workflows?.length) selWF = selUC.workflows[0];
    if (selWF?.agents?.length)    selAG = selWF.agents[0];
    renderAll();
  }

  // ── Section 2: Platform Design (Data Models) ───────────────────
  if (hasPlatformLayer) {
    const pdWrap = el('div', { style: { marginTop: '32px' } });
    pdWrap.appendChild(el('div', { className: 'dr-section-header', style: { marginBottom: '12px' } },
      el('span', { className: 'dr-section-title' }, 'Platform Design')));

    const mc2    = el('div', { className: 'dr-mc' });
    const dmCol  = buildMcColumn('Data Models');
    const chCol  = buildMcColumn('Forms & Impl. Artifacts');
    const detCol = buildMcColumn('Details');
    mc2.appendChild(dmCol.wrap);
    mc2.appendChild(chCol.wrap);
    mc2.appendChild(detCol.wrap);
    pdWrap.appendChild(mc2);
    wrap.appendChild(pdWrap);

    let selDM = null, selChild = null;

    const toChildShape = (f, type) => type === 'form'
      ? { ...f, _type: 'form',  _id: f.form_design_id,    _label: f.name, _secondary: f.view_name || 'Form' }
      : { ...f, _type: 'logic', _id: f.business_logic_id, _label: f.name, _secondary: (f.logic_type || 'logic').replace(/_/g, ' ') };

    function renderDmCol() {
      dmCol.body.innerHTML = '';
      dataMdls.forEach(dm => {
        const childCount = (dm.forms?.length || 0) + (dm.logic?.length || 0);
        dmCol.body.appendChild(mcItem(dm.name, 'data-models', `dr-entity-${dm.data_model_id}`, {
          active: selDM && selDM.data_model_id === dm.data_model_id,
          secondary: dm.physical_name || (childCount ? `${childCount} child${childCount !== 1 ? 'ren' : ''}` : ''),
          onSelect: () => { selDM = dm; selChild = null; renderDmAll(); },
        }));
      });
    }
    function renderChCol() {
      chCol.body.innerHTML = '';
      if (!selDM) { chCol.body.appendChild(emptyHint('Select a data model →')); return; }
      const children = [
        ...(selDM.forms || []).map(f => toChildShape(f, 'form')),
        ...(selDM.logic || []).map(l => toChildShape(l, 'logic')),
      ];
      if (!children.length) { chCol.body.appendChild(emptyHint('No forms or logic')); return; }
      children.forEach(c => {
        const scope = c._type === 'form' ? 'form-designs' : 'business-logic';
        chCol.body.appendChild(mcItem(c._label, scope, `dr-entity-${c._id}`, {
          active: selChild && selChild._id === c._id,
          secondary: c._secondary,
          onSelect: () => { selChild = c; renderDmAll(); },
        }));
      });
    }
    function renderDetCol() {
      detCol.body.innerHTML = '';
      if (!selChild) { detCol.body.appendChild(emptyHint('Select a form or logic item →')); return; }
      const lines = [];
      if (selChild._type === 'form' && selChild.view_name)       lines.push({ label: 'View',        val: selChild.view_name });
      if (selChild._type === 'logic' && selChild.logic_type)     lines.push({ label: 'Type',        val: selChild.logic_type.replace(/_/g, ' ') });
      if (selChild._type === 'logic' && selChild.plain_english)  lines.push({ label: 'What it does', val: selChild.plain_english });
      if (!lines.length) { detCol.body.appendChild(emptyHint('No details available')); return; }
      lines.forEach(({ label, val }) => {
        const row = el('div', { style: 'padding:6px 10px;border-bottom:1px solid var(--border,#e0e0e0);font-size:12px' });
        row.appendChild(el('div', { style: 'color:#888;font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px' }, label));
        row.appendChild(el('div', {}, val));
        detCol.body.appendChild(row);
      });
    }
    function renderDmAll() { renderDmCol(); renderChCol(); renderDetCol(); }

    selDM = dataMdls[0] || null;
    if (selDM) {
      const allChildren = [...(selDM.forms || []).map(f => toChildShape(f, 'form')), ...(selDM.logic || []).map(l => toChildShape(l, 'logic'))];
      selChild = allChildren[0] || null;
    }
    renderDmAll();
  }

  // ── Section 3: Integrations ────────────────────────────────────
  if (hasIntegLayer) {
    const intWrap = el('div', { style: { marginTop: '32px' } });
    intWrap.appendChild(el('div', { className: 'dr-section-header', style: { marginBottom: '12px' } },
      el('span', { className: 'dr-section-title' }, 'Integrations')));

    const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px' });

    if (catalogItems.length > 0) {
      const col = el('div');
      col.appendChild(el('div', { style: 'font-weight:600;font-size:13px;color:#444;margin-bottom:8px' }, `Catalog Items (${catalogItems.length})`));
      catalogItems.forEach(ci => {
        const card = el('div', { style: 'border:1px solid var(--border,#e0e0e0);border-radius:6px;padding:8px 10px;margin-bottom:6px;font-size:12px' });
        const titleRow = el('div', { style: 'display:flex;align-items:center;gap:6px;margin-bottom:3px' });
        titleRow.appendChild(drillLink(ci.name, 'catalog-items', `dr-entity-${ci.catalog_item_id}`));
        if (ci.category) titleRow.appendChild(el('span', { style: 'color:#888;font-size:11px' }, ci.category));
        card.appendChild(titleRow);
        if (ci.short_description) card.appendChild(el('div', { style: 'color:#666;font-size:11px;margin-bottom:3px' }, ci.short_description));
        if (ci.workflow_name) card.appendChild(el('div', { style: 'font-size:11px;color:#1565c0' }, `→ Workflow: ${ci.workflow_name}`));
        col.appendChild(card);
      });
      grid.appendChild(col);
    }

    if (integrations.length > 0) {
      const restItems  = integrations.filter(i => i.integration_type === 'rest_message');
      const aliasItems = integrations.filter(i => i.integration_type === 'connection_alias');
      const PILL_META  = {
        rest_message:     { label: 'REST',  bg: '#e8f5e9', fg: '#2e7d32' },
        connection_alias: { label: 'ALIAS', bg: '#f3e5f5', fg: '#6a1b9a' },
      };
      [[restItems, 'REST Messages'], [aliasItems, 'Connection Aliases']].forEach(([items, groupLabel]) => {
        if (!items.length) return;
        const col = el('div');
        col.appendChild(el('div', { style: 'font-weight:600;font-size:13px;color:#444;margin-bottom:8px' }, `${groupLabel} (${items.length})`));
        items.forEach(intg => {
          const meta = PILL_META[intg.integration_type] || {};
          const card = el('div', { style: 'border:1px solid var(--border,#e0e0e0);border-radius:6px;padding:8px 10px;margin-bottom:6px;font-size:12px' });
          const titleRow = el('div', { style: 'display:flex;align-items:center;gap:6px;margin-bottom:3px' });
          titleRow.appendChild(el('span', { style: `background:${meta.bg};color:${meta.fg};border-radius:4px;padding:0 5px;font-size:10px;font-weight:600` }, meta.label));
          titleRow.appendChild(el('span', { style: 'font-weight:500' }, intg.name));
          card.appendChild(titleRow);
          if (intg.endpoint)        card.appendChild(el('div', { style: 'color:#888;font-size:11px;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, intg.endpoint));
          if (intg.alias_type || intg.connection_type) card.appendChild(el('div', { style: 'color:#666;font-size:11px' }, intg.alias_type || intg.connection_type));
          if (intg.description)     card.appendChild(el('div', { style: 'color:#666;font-size:11px;margin-top:2px' }, intg.description));
          col.appendChild(card);
        });
        grid.appendChild(col);
      });
    }

    intWrap.appendChild(grid);
    wrap.appendChild(intWrap);
  }

  // ── Section 4: Requirements traceability ──────────────────────
  if (functionalReqs.length > 0 || nonfunctionalReqs.length > 0) {
    const reqDiv = el('div', { style: { marginTop: '32px' } });
    reqDiv.appendChild(el('div', { className: 'dr-section-header', style: { marginBottom: '12px' } },
      el('span', { className: 'dr-section-title' }, 'Requirements')));

    const priorityLabel = { must_have: 'Must Have', should_have: 'Should Have', could_have: 'Could Have', wont_have: "Won't Have" };
    const statusColor   = { draft: '#78909c', approved: '#1976d2', implemented: '#388e3c', verified: '#6a1b9a' };

    const orphanCount = [...functionalReqs, ...nonfunctionalReqs].filter(r => !r.use_case_id).length;
    if (orphanCount > 0) {
      const banner = el('div', { style: 'background:#fff3e0;border:1px solid #ffb300;border-radius:6px;padding:8px 12px;margin-bottom:12px;font-size:12px' });
      banner.innerHTML = `<strong style="color:#e65100">⚠ ${orphanCount} orphan requirement${orphanCount !== 1 ? 's' : ''}</strong> not yet traced to a Use Case.`;
      reqDiv.appendChild(banner);
    }

    function reqSummaryTable(reqs, label) {
      if (!reqs.length) return;
      const sec = el('div', { style: { marginBottom: '20px' } });
      sec.appendChild(el('div', { style: { fontWeight: '600', fontSize: '13px', marginBottom: '6px', color: '#444' } }, `${label} (${reqs.length})`));
      const tbl = el('table', { className: 'dr-compact-table', style: { width: '100%' } });
      const hRow = el('tr');
      ['ID', 'Title', 'Priority', 'Use Case', 'Status'].forEach(h => hRow.appendChild(el('th', {}, h)));
      tbl.appendChild(el('thead', {}, hRow));
      const tbody = el('tbody');
      reqs.forEach(r => {
        const uc = useCaseMap[r.use_case_id] || {};
        const pill = el('span');
        pill.textContent = r.status || 'draft';
        pill.style.cssText = `background:${statusColor[r.status] || '#ccc'};color:#fff;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:600`;
        const statusCell = el('td');
        statusCell.appendChild(pill);
        const tr = el('tr');
        tr.appendChild(el('td', {}, el('span', { className: 'dr-slug-badge' }, r.slug || '—')));
        tr.appendChild(el('td', {}, escHtml(r.title)));
        tr.appendChild(el('td', { style: { fontSize: '11px', whiteSpace: 'nowrap' } }, priorityLabel[r.priority] || r.priority || '—'));
        const ucTd = el('td', { style: { fontSize: '11px' } });
        ucTd.textContent = r.use_case_id ? `${uc.slug || ''}${uc.slug && uc.title ? ' · ' : ''}${uc.title || r.use_case_id}` : '⚠ Orphan';
        if (!r.use_case_id) ucTd.style.color = '#e65100';
        tr.appendChild(ucTd);
        tr.appendChild(statusCell);
        tbody.appendChild(tr);
      });
      tbl.appendChild(tbody);
      sec.appendChild(tbl);
      reqDiv.appendChild(sec);
    }

    reqSummaryTable(functionalReqs, 'Functional Requirements');
    reqSummaryTable(nonfunctionalReqs, 'Non-Functional Requirements');
    wrap.appendChild(reqDiv);
  }

  // ── Section 5: Tier-A Design (config-driven entities) ──────────
  // Self-populating 3-column Miller: Group → Entities → Details. Driven entirely by
  // the relationships endpoint's tier_a_entities map, so new entities appear by config.
  const tierAKeys = Object.keys(tierAEntities);
  if (tierAKeys.length) {
    const GROUP_LABELS = { information: 'Information Layer', logic: 'Business Logic (NL)', process: 'Process & SLAs', configuration: 'Platform Configuration', ux: 'User Experience', integration: 'Integration' };
    // Group entity-types by their display group.
    const byGroup = {};
    for (const dk of tierAKeys) {
      const ent = tierAEntities[dk];
      (byGroup[ent.group] ||= []).push(ent);
    }
    const groupKeys = Object.keys(byGroup);

    const taWrap = el('div', { style: { marginTop: '32px' } });
    taWrap.appendChild(el('div', { className: 'dr-section-header', style: { marginBottom: '12px' } },
      el('span', { className: 'dr-section-title' }, 'Tier-A Design')));

    const mc = el('div', { className: 'dr-mc' });
    const grpCol = buildMcColumn('Category');
    const entCol = buildMcColumn('Entities');
    const detCol = buildMcColumn('Details');
    mc.appendChild(grpCol.wrap); mc.appendChild(entCol.wrap); mc.appendChild(detCol.wrap);
    taWrap.appendChild(mc);
    wrap.appendChild(taWrap);

    let selGroup = null, selRow = null, selEnt = null;

    function renderGrp() {
      grpCol.body.innerHTML = '';
      groupKeys.forEach(g => {
        const count = byGroup[g].reduce((n, e) => n + e.rows.length, 0);
        grpCol.body.appendChild(mcItem(GROUP_LABELS[g] || g, null, null, {
          active: selGroup === g, secondary: `${count} item${count !== 1 ? 's' : ''}`,
          onSelect: () => { selGroup = g; selRow = null; selEnt = null; renderAll(); },
        }));
      });
    }
    function renderEnt() {
      entCol.body.innerHTML = '';
      if (!selGroup) { entCol.body.appendChild(emptyHint('Select a category →')); return; }
      const ents = byGroup[selGroup];
      let any = false;
      ents.forEach(ent => {
        ent.rows.forEach(r => {
          any = true;
          entCol.body.appendChild(mcItem(`${ent.label}: ${r.name}`, ent.scope_id, `dr-entity-${r.id}`, {
            active: selRow && selRow.id === r.id,
            secondary: r.slug || r.secondary || '',
            onSelect: () => { selRow = r; selEnt = ent; renderAll(); },
          }));
        });
      });
      if (!any) entCol.body.appendChild(emptyHint('No entities'));
    }
    function renderDet() {
      detCol.body.innerHTML = '';
      if (!selRow) { detCol.body.appendChild(emptyHint('Select an entity →')); return; }
      const lines = [
        { label: 'Type', val: selEnt.label },
        { label: 'Slug', val: selRow.slug || '—' },
        { label: 'Name', val: selRow.name },
      ];
      if (selRow.secondary) lines.push({ label: 'Summary', val: selRow.secondary });
      lines.forEach(({ label, val }) => {
        const row = el('div', { style: 'padding:6px 10px;border-bottom:1px solid var(--border,#e0e0e0);font-size:12px' });
        row.appendChild(el('div', { style: 'color:#888;font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px' }, label));
        row.appendChild(el('div', {}, val));
        detCol.body.appendChild(row);
      });
      const dl = drillLink('Open on its tab →', selEnt.scope_id, `dr-entity-${selRow.id}`);
      dl.style.cssText = 'margin:8px 10px;font-size:12px';
      detCol.body.appendChild(dl);
    }
    function renderAll() { renderGrp(); renderEnt(); renderDet(); }

    selGroup = groupKeys[0] || null;
    if (selGroup) { const first = byGroup[selGroup][0]; selEnt = first; selRow = first.rows[0] || null; }
    renderAll();
  }

  return wrap;
}

function buildMcColumn(title) {
  const wrap = el('div', { className: 'dr-mc-col' });
  wrap.appendChild(el('div', { className: 'dr-mc-col-title' }, title));
  const body = el('div', { className: 'dr-mc-col-body' });
  wrap.appendChild(body);
  return { wrap, body };
}

function mcItem(label, scope, anchorId, opts = {}) {
  const item = el('div', { className: 'dr-mc-item' + (opts.active ? ' dr-mc-item-active' : '') });
  const left = el('div', { className: 'dr-mc-item-left' });
  const name = el('button', { className: 'dr-mc-item-name', type: 'button' }, label);
  if (opts.onSelect) name.addEventListener('click', opts.onSelect);
  left.appendChild(name);
  if (opts.secondary) {
    left.appendChild(el('div', { className: 'dr-mc-item-secondary' }, opts.secondary));
  }
  item.appendChild(left);
  if (scope && anchorId) {
    const dl = drillLink('→', scope, anchorId);
    dl.classList.add('dr-mc-item-drill');
    dl.title = `Open on ${scope.replace(/-/g, ' ')} tab`;
    item.appendChild(dl);
  }
  return item;
}

function emptyHint(text) {
  return el('div', { className: 'dr-mc-empty' }, text);
}

// ─── drill-down helpers ──────────────────────────────────────────────────────

function drillLink(label, scope, anchorId) {
  const btn = el('button', {
    className: 'dr-drill-link',
    'data-drill-scope': scope,
    'data-drill-anchor': anchorId || '',
  }, label);
  return btn;
}

function scrollToAnchor(id) {
  const el2 = document.getElementById(id);
  if (el2) el2.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ─── breadcrumb helper ───────────────────────────────────────────────────────

/**
 * Render a thin one-line breadcrumb of drill links above an entity card.
 * `items` is an array of { prefix, name, scope, anchorId }. Items without a
 * scope render as plain text (no link).
 */
function buildBreadcrumb(items) {
  if (!items || !items.length) return null;
  const bar = el('div', { className: 'dr-breadcrumb' });
  items.forEach((it, i) => {
    if (i > 0) bar.appendChild(el('span', { className: 'dr-breadcrumb-sep' }, '·'));
    if (it.prefix) bar.appendChild(el('span', { className: 'dr-breadcrumb-prefix' }, `${it.prefix}:`));
    if (it.scope && it.anchorId) {
      bar.appendChild(drillLink(`${it.name} →`, it.scope, it.anchorId));
    } else {
      bar.appendChild(el('span', { className: 'dr-breadcrumb-name' }, it.name));
    }
  });
  return bar;
}

// ─── inline edit helpers ─────────────────────────────────────────────────────

/** Shallow-merge `edits` onto `base` for sub-keys only; non-object values overwrite. */
function deepMerge(base, edits) {
  const out = { ...(base || {}) };
  Object.entries(edits || {}).forEach(([k, v]) => {
    if (v && typeof v === 'object' && !Array.isArray(v)
        && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  });
  return out;
}

/**
 * Open a lightweight modal to edit a single item within a JSON array column.
 * fields: [{key, label, type ('text'|'textarea'), rows?}]
 * initialData: { key: value, ... }
 * onSave: async (updatedData) => void  — responsible for the PUT + toast
 */
function openItemModal(title, fields, initialData, onSave) {
  const overlay = el('div', { className: 'dr-edit-overlay' });
  const modal   = el('div', { className: 'dr-edit-modal', style: { maxWidth: '480px' } });

  const hdr = el('div', { className: 'dr-edit-header' });
  hdr.appendChild(el('div', { className: 'dr-edit-title' }, title));
  const closeBtn = el('button', { className: 'dr-edit-close', 'aria-label': 'Close' }, '×');
  hdr.appendChild(closeBtn);
  modal.appendChild(hdr);

  const body   = el('div', { className: 'dr-edit-body' });
  const inputs = {};
  fields.forEach(f => {
    const grp = el('div', { className: 'dr-edit-field-group' });
    grp.appendChild(el('label', { className: 'dr-edit-label' }, f.label));
    let inp;
    if (f.type === 'textarea') {
      inp = el('textarea', { className: 'dr-edit-input dr-edit-textarea', rows: String(f.rows || 3) });
      inp.value = initialData[f.key] != null ? String(initialData[f.key]) : '';
    } else {
      inp = el('input', { type: 'text', className: 'dr-edit-input dr-edit-text' });
      inp.value = initialData[f.key] != null ? String(initialData[f.key]) : '';
    }
    inputs[f.key] = inp;
    grp.appendChild(inp);
    body.appendChild(grp);
  });
  modal.appendChild(body);

  const errorArea = el('div', { className: 'dr-edit-error', style: { display: 'none' } });
  modal.appendChild(errorArea);

  const footer    = el('div', { className: 'dr-edit-footer' });
  const cancelBtn = el('button', { className: 'btn btn-ghost' }, 'Cancel');
  const saveBtn   = el('button', { className: 'btn btn-primary' }, 'Save');
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);
  modal.appendChild(footer);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('dr-edit-overlay--visible'));

  const close = () => { overlay.classList.remove('dr-edit-overlay--visible'); setTimeout(() => overlay.remove(), 200); };
  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    errorArea.style.display = 'none';
    const updated = {};
    fields.forEach(f => { updated[f.key] = inputs[f.key].value.trim(); });
    try {
      await onSave(updated);
      close();
    } catch (err) {
      errorArea.textContent = `Save failed: ${err.message}`;
      errorArea.style.display = 'block';
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  });
}

/**
 * Build a small ✏️ button for child-array items (goals, done criteria, errors, etc.)
 */
function buildItemEditBtn(onClick) {
  const btn = el('button', { className: 'dr-item-edit-btn', title: 'Edit this item' }, '✏️');
  btn.addEventListener('click', e => { e.stopPropagation(); onClick(); });
  return btn;
}

/**
 * Save an updated array field back to a parent entity via PUT, then reload.
 */
async function saveArrayField(entityType, entityId, fieldName, newArray) {
  const cfg = EDIT_CONFIGS[entityType];
  const result = await apiFetch(cfg.endpoint(_currentProjectId, entityId), {
    method: 'PUT',
    body: JSON.stringify({ [fieldName]: newArray }),
  });
  const { showToast } = await import('../app.js');
  const cpCode = result._cp?.cpCode;
  showToast(cpCode ? `✓ Saved — Change Packet ${cpCode} created` : '✓ Saved (no changes)', 'success');
  if (_currentReportArea && _currentProjectId && _currentScope) {
    await loadReport(_currentReportArea, _currentProjectId, _currentScope);
  }
}

// ─── Phase 2 edit helpers ────────────────────────────────────────────────────

const RASIC_LABELS = { R: 'Responsible', A: 'Accountable', S: 'Supportive', I: 'Informed', C: 'Consulted' };

/** Returns the display name for a participant, prefixing AI agents with "Ag: " */
function participantLabel(p, useRasicOverride = false) {
  const isAgent = p.participant_type && p.participant_type.includes('Agent');
  const base = (useRasicOverride && p.rasic_column_display_name)
    ? p.rasic_column_display_name
    : (p.agent_name || p.human_role_name || p.swimlane_display_name || p.slug || '—');
  return isAgent ? `Ag: ${base}` : base;
}

function _p2Overlay() {
  const ov = el('div', { className: 'dr-edit-overlay' });
  const mo = el('div', { className: 'dr-edit-modal', role: 'dialog', 'aria-modal': 'true' });
  ov.appendChild(mo);
  document.body.appendChild(ov);
  return { ov, mo };
}

function _p2Header(mo, title, subtitle) {
  const mhdr = el('div', { className: 'dr-edit-modal-header' });
  mhdr.appendChild(el('div', { className: 'dr-edit-modal-title' }, title));
  if (subtitle) mhdr.appendChild(el('div', { className: 'dr-edit-modal-subtitle' }, subtitle));
  const closeBtn = el('button', { className: 'dr-edit-close', title: 'Close' }, '✕');
  mhdr.appendChild(closeBtn);
  mo.appendChild(mhdr);
  mo.appendChild(el('div', { className: 'dr-edit-banner' },
    el('span', { className: 'dr-edit-banner-icon' }, 'ℹ️'), 'Changes are saved immediately.'));
  return closeBtn;
}

function _p2Close(ov, closeBtn, overlay) {
  const close = () => ov.remove();
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });
  return close;
}

async function _p2Reload() {
  const { showToast } = await import('../app.js');
  return showToast;
}

async function openParticipantModal(wf, participant = null) {
  const isEdit = !!participant;
  const pid = _currentProjectId;
  const wfId = wf.workflow_id;

  // Fetch agents in project for dropdown
  let agents = [];
  try { const d = await apiFetch(`/projects/${pid}/design-report/agents`); agents = d || []; } catch {}

  const { ov, mo } = _p2Overlay();
  const closeBtn = _p2Header(mo, isEdit ? 'Edit Participant' : 'Add Participant', wf.name);
  const closeModal = _p2Close(ov, closeBtn, ov);

  const body = el('div', { className: 'dr-edit-body' });

  // participant_type
  const typeSelect = el('select', { className: 'dr-edit-input dr-edit-select' });
  ['Orchestrator Agent', 'Specialist Agent', 'Human Role', 'Human Coordinator'].forEach(t =>
    typeSelect.appendChild(el('option', { value: t }, t)));
  if (participant?.participant_type) typeSelect.value = participant.participant_type;

  // agent_spec_id (agents only)
  const agentSelect = el('select', { className: 'dr-edit-input dr-edit-select' });
  agentSelect.appendChild(el('option', { value: '' }, '— select agent —'));
  agents.forEach(a => agentSelect.appendChild(el('option', { value: a.agent_spec_id }, `${a.slug || ''} ${a.name}`.trim())));
  if (participant?.agent_spec_id) agentSelect.value = participant.agent_spec_id;

  // human_role_name (humans only)
  const roleInput = el('input', { type: 'text', className: 'dr-edit-input dr-edit-text', placeholder: 'e.g. IT Fulfiller' });
  if (participant?.human_role_name) roleInput.value = participant.human_role_name;

  const agentGrp = el('div', { className: 'dr-edit-field-group' });
  agentGrp.appendChild(el('label', { className: 'dr-edit-label' }, 'Agent Spec'));
  agentGrp.appendChild(agentSelect);
  const roleGrp = el('div', { className: 'dr-edit-field-group' });
  roleGrp.appendChild(el('label', { className: 'dr-edit-label' }, 'Human Role Name'));
  roleGrp.appendChild(roleInput);

  const updateVis = () => {
    const isAgent = typeSelect.value.includes('Agent');
    agentGrp.style.display = isAgent ? '' : 'none';
    roleGrp.style.display  = isAgent ? 'none' : '';
  };
  typeSelect.addEventListener('change', updateVis);

  const typeGrp = el('div', { className: 'dr-edit-field-group' });
  typeGrp.appendChild(el('label', { className: 'dr-edit-label' }, 'Participant Type'));
  typeGrp.appendChild(typeSelect);
  body.appendChild(typeGrp);
  body.appendChild(agentGrp);
  body.appendChild(roleGrp);
  updateVis();

  // purpose
  const purposeArea = el('textarea', { className: 'dr-edit-input dr-edit-textarea', rows: '3', placeholder: 'Purpose in this workflow' });
  if (participant?.purpose_in_workflow) purposeArea.value = participant.purpose_in_workflow;
  const purGrp = el('div', { className: 'dr-edit-field-group' });
  purGrp.appendChild(el('label', { className: 'dr-edit-label' }, 'Purpose in Workflow'));
  purGrp.appendChild(purposeArea);
  body.appendChild(purGrp);

  // authority_level
  const authSelect = el('select', { className: 'dr-edit-input dr-edit-select' });
  ['', 'Advise only', 'Draft only', 'Execute (human)', 'Execute (gated)', 'Execute (autonomous)']
    .forEach(v => authSelect.appendChild(el('option', { value: v }, v || '— authority level —')));
  if (participant?.authority_level) authSelect.value = participant.authority_level;
  const authGrp = el('div', { className: 'dr-edit-field-group' });
  authGrp.appendChild(el('label', { className: 'dr-edit-label' }, 'Authority Level'));
  authGrp.appendChild(authSelect);
  body.appendChild(authGrp);

  // handoff_method
  const handoffSelect = el('select', { className: 'dr-edit-input dr-edit-select' });
  ['', 'Task creation', 'Assignment', 'Comment', 'Panel response', 'Notification', 'Other']
    .forEach(v => handoffSelect.appendChild(el('option', { value: v }, v || '— handoff method —')));
  if (participant?.handoff_method) handoffSelect.value = participant.handoff_method;
  const handoffGrp = el('div', { className: 'dr-edit-field-group' });
  handoffGrp.appendChild(el('label', { className: 'dr-edit-label' }, 'Handoff Method'));
  handoffGrp.appendChild(handoffSelect);
  body.appendChild(handoffGrp);

  // swimlane_display_name + lane_order (side by side)
  const laneRow = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 80px', gap: '10px' } });
  const laneNameInput = el('input', { type: 'text', className: 'dr-edit-input dr-edit-text', placeholder: 'Swimlane label' });
  if (participant?.swimlane_display_name) laneNameInput.value = participant.swimlane_display_name;
  const laneOrderInput = el('input', { type: 'number', className: 'dr-edit-input dr-edit-text', min: '1', step: '1', placeholder: '#' });
  if (participant?.lane_order != null) laneOrderInput.value = String(participant.lane_order);
  const laneNameGrp = el('div', { className: 'dr-edit-field-group' });
  laneNameGrp.appendChild(el('label', { className: 'dr-edit-label' }, 'Swimlane Label'));
  laneNameGrp.appendChild(laneNameInput);
  const laneOrderGrp = el('div', { className: 'dr-edit-field-group' });
  laneOrderGrp.appendChild(el('label', { className: 'dr-edit-label' }, 'Order'));
  laneOrderGrp.appendChild(laneOrderInput);
  laneRow.appendChild(laneNameGrp);
  laneRow.appendChild(laneOrderGrp);
  body.appendChild(laneRow);

  // include_in_rasic checkbox
  const rasicChkWrap = el('div', { className: 'dr-edit-field-group dr-edit-checkbox-row' });
  const rasicChk = el('input', { type: 'checkbox', id: 'p2-rasic-chk' });
  rasicChk.checked = participant ? participant.include_in_rasic !== 0 : true;
  rasicChkWrap.appendChild(rasicChk);
  rasicChkWrap.appendChild(el('label', { for: 'p2-rasic-chk', className: 'dr-edit-label' }, 'Include in RASIC matrix'));
  body.appendChild(rasicChkWrap);

  mo.appendChild(body);

  const errorArea = el('div', { className: 'dr-edit-error', style: { display: 'none' } });
  mo.appendChild(errorArea);

  const footer = el('div', { className: 'dr-edit-footer' });
  if (isEdit) {
    const delBtn = el('button', { className: 'btn btn-ghost dr-delete-btn' }, 'Delete');
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Delete participant ${participant.slug || participant.workflow_participant_id}?`)) return;
      try {
        await apiFetch(`/projects/${pid}/workflows/${wfId}/participants/${participant.workflow_participant_id}`,
          { method: 'DELETE' });
        closeModal();
        (await _p2Reload())('Participant deleted', 'success');
        if (_currentReportArea && pid && _currentScope) await loadReport(_currentReportArea, pid, _currentScope);
      } catch (err) { errorArea.textContent = `Delete failed: ${err.message}`; errorArea.style.display = 'block'; }
    });
    footer.appendChild(delBtn);
  }
  const cancelBtn = el('button', { className: 'btn btn-ghost' }, 'Cancel');
  const saveBtn   = el('button', { className: 'btn btn-primary' }, isEdit ? 'Save Changes' : 'Add Participant');
  cancelBtn.addEventListener('click', closeModal);
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);
  mo.appendChild(footer);
  setTimeout(() => { const f = mo.querySelector('input,textarea,select'); if (f) f.focus(); }, 60);

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; errorArea.style.display = 'none';
    const isAgentType = typeSelect.value.includes('Agent');
    const payload = {
      participant_type:       typeSelect.value,
      agent_spec_id:          isAgentType ? (agentSelect.value || null) : null,
      human_role_name:        isAgentType ? null : (roleInput.value.trim() || null),
      purpose_in_workflow:    purposeArea.value.trim() || null,
      authority_level:        authSelect.value || null,
      handoff_method:         handoffSelect.value || null,
      swimlane_display_name:  laneNameInput.value.trim() || null,
      lane_order:             laneOrderInput.value ? parseInt(laneOrderInput.value, 10) : null,
      include_in_rasic:       rasicChk.checked ? 1 : 0,
    };
    try {
      const url = isEdit
        ? `/projects/${pid}/workflows/${wfId}/participants/${participant.workflow_participant_id}`
        : `/projects/${pid}/workflows/${wfId}/participants`;
      await apiFetch(url, { method: isEdit ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      closeModal();
      (await _p2Reload())(isEdit ? '✓ Participant updated' : '✓ Participant added', 'success');
      if (_currentReportArea && pid && _currentScope) await loadReport(_currentReportArea, pid, _currentScope);
    } catch (err) {
      errorArea.textContent = `Save failed: ${err.message}`;
      errorArea.style.display = 'block';
      saveBtn.disabled = false; saveBtn.textContent = isEdit ? 'Save Changes' : 'Add Participant';
    }
  });
}

async function openPathModal(wf, path = null) {
  const isEdit = !!path;
  const pid = _currentProjectId;
  const wfId = wf.workflow_id;
  const steps = wf.steps || [];

  const { ov, mo } = _p2Overlay();
  const closeBtn = _p2Header(mo, isEdit ? 'Edit Path' : 'Add Path', wf.name);
  const closeModal = _p2Close(ov, closeBtn, ov);

  const body = el('div', { className: 'dr-edit-body' });

  const mkStepSelect = (label, currentId) => {
    const sel = el('select', { className: 'dr-edit-input dr-edit-select' });
    sel.appendChild(el('option', { value: '' }, '— select step —'));
    steps.forEach(s => sel.appendChild(el('option', { value: s.workflow_step_id },
      `${s.step_number}. ${s.name}`)));
    if (currentId) sel.value = currentId;
    const grp = el('div', { className: 'dr-edit-field-group' });
    grp.appendChild(el('label', { className: 'dr-edit-label' }, label));
    grp.appendChild(sel);
    body.appendChild(grp);
    return sel;
  };

  const fromSelect = mkStepSelect('From Step', path?.from_step_id);
  const toSelect   = mkStepSelect('To Step',   path?.to_step_id);

  const labelInput = el('input', { type: 'text', className: 'dr-edit-input dr-edit-text', placeholder: 'e.g. SAP lookup needed' });
  if (path?.branch_label) labelInput.value = path.branch_label;
  const labelGrp = el('div', { className: 'dr-edit-field-group' });
  labelGrp.appendChild(el('label', { className: 'dr-edit-label' }, 'Branch Label'));
  labelGrp.appendChild(labelInput);
  body.appendChild(labelGrp);

  const condArea = el('textarea', { className: 'dr-edit-input dr-edit-textarea', rows: '2',
    placeholder: 'e.g. invoice_status IN (blocked, on-hold)' });
  if (path?.branch_condition) condArea.value = path.branch_condition;
  const condGrp = el('div', { className: 'dr-edit-field-group' });
  condGrp.appendChild(el('label', { className: 'dr-edit-label' }, 'Branch Condition'));
  condGrp.appendChild(condArea);
  body.appendChild(condGrp);

  const defaultChkWrap = el('div', { className: 'dr-edit-field-group dr-edit-checkbox-row' });
  const defaultChk = el('input', { type: 'checkbox', id: 'p2-default-chk' });
  defaultChk.checked = path ? !!path.is_default_path : false;
  defaultChkWrap.appendChild(defaultChk);
  defaultChkWrap.appendChild(el('label', { for: 'p2-default-chk', className: 'dr-edit-label' }, 'Default path'));
  body.appendChild(defaultChkWrap);

  const notesArea = el('textarea', { className: 'dr-edit-input dr-edit-textarea', rows: '2' });
  if (path?.notes) notesArea.value = path.notes;
  const notesGrp = el('div', { className: 'dr-edit-field-group' });
  notesGrp.appendChild(el('label', { className: 'dr-edit-label' }, 'Notes'));
  notesGrp.appendChild(notesArea);
  body.appendChild(notesGrp);

  mo.appendChild(body);
  const errorArea = el('div', { className: 'dr-edit-error', style: { display: 'none' } });
  mo.appendChild(errorArea);

  const footer = el('div', { className: 'dr-edit-footer' });
  if (isEdit) {
    const delBtn = el('button', { className: 'btn btn-ghost dr-delete-btn' }, 'Delete');
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Delete path ${path.slug || path.workflow_path_id}?`)) return;
      try {
        await apiFetch(`/projects/${pid}/workflows/${wfId}/paths/${path.workflow_path_id}`,
          { method: 'DELETE' });
        closeModal();
        (await _p2Reload())('Path deleted', 'success');
        if (_currentReportArea && pid && _currentScope) await loadReport(_currentReportArea, pid, _currentScope);
      } catch (err) { errorArea.textContent = `Delete failed: ${err.message}`; errorArea.style.display = 'block'; }
    });
    footer.appendChild(delBtn);
  }
  const cancelBtn = el('button', { className: 'btn btn-ghost' }, 'Cancel');
  const saveBtn   = el('button', { className: 'btn btn-primary' }, isEdit ? 'Save Changes' : 'Add Path');
  cancelBtn.addEventListener('click', closeModal);
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);
  mo.appendChild(footer);
  setTimeout(() => { const f = mo.querySelector('input,textarea,select'); if (f) f.focus(); }, 60);

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; errorArea.style.display = 'none';
    const payload = {
      from_step_id:     fromSelect.value || null,
      to_step_id:       toSelect.value   || null,
      branch_label:     labelInput.value.trim() || null,
      branch_condition: condArea.value.trim()   || null,
      is_default_path:  defaultChk.checked ? 1 : 0,
      notes:            notesArea.value.trim()  || null,
    };
    try {
      const url = isEdit
        ? `/projects/${pid}/workflows/${wfId}/paths/${path.workflow_path_id}`
        : `/projects/${pid}/workflows/${wfId}/paths`;
      await apiFetch(url, { method: isEdit ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      closeModal();
      (await _p2Reload())(isEdit ? '✓ Path updated' : '✓ Path added', 'success');
      if (_currentReportArea && pid && _currentScope) await loadReport(_currentReportArea, pid, _currentScope);
    } catch (err) {
      errorArea.textContent = `Save failed: ${err.message}`;
      errorArea.style.display = 'block';
      saveBtn.disabled = false; saveBtn.textContent = isEdit ? 'Save Changes' : 'Add Path';
    }
  });
}

// ─── Phase 3: agent ↔ use-case link modal ───────────────────────────────────

async function openAgentUCModal(agent) {
  const pid = _currentProjectId || agent.project_id;
  const { apiFetch } = await import('./app.js');

  // Fetch all UCs for this project to populate the dropdown
  const allUcs = await apiFetch(`/projects/${pid}/design-report/use-cases`)
    .then(r => r?.use_cases || []).catch(() => []);
  const linked = new Set((agent.use_cases || []).map(u => u.use_case_id));
  const available = allUcs.filter(u => !linked.has(u.use_case_id));

  const { ov, mo } = _p2Overlay();
  const closeBtn = _p2Header(mo, 'Link Use Case', agent.name);
  const close = _p2Close(ov, closeBtn, ov);

  if (!available.length) {
    mo.appendChild(el('p', { style: { padding: '16px', color: 'var(--color-text-muted)' } },
      'All use cases in this project are already linked to this agent.'));
    document.body.appendChild(ov);
    return;
  }

  const form = el('div', { className: 'dr-edit-form' });

  // UC select
  const ucSel = el('select', { style: { width: '100%', marginBottom: '12px' } });
  ucSel.appendChild(el('option', { value: '' }, '— select a use case —'));
  available.forEach(u => ucSel.appendChild(el('option', { value: u.use_case_id }, `${u.slug || ''} ${u.title}`)));
  form.appendChild(el('label', { className: 'dr-edit-label' }, 'Use Case'));
  form.appendChild(ucSel);

  // Business value
  const bvInput = el('textarea', { className: 'dr-edit-textarea', rows: 2, placeholder: 'e.g. Reduces AHT from 12 min → 4 min' });
  form.appendChild(el('label', { className: 'dr-edit-label' }, 'Business Value (optional)'));
  form.appendChild(bvInput);

  const errorArea = el('div', { className: 'dr-edit-error', style: { display: 'none' } });
  form.appendChild(errorArea);

  const saveBtn = el('button', { className: 'dr-edit-save-btn' }, 'Link Use Case');
  const cancelBtn = el('button', { className: 'dr-edit-cancel-btn' }, 'Cancel');
  cancelBtn.addEventListener('click', close);

  const btns = el('div', { className: 'dr-edit-btn-row' });
  btns.appendChild(saveBtn); btns.appendChild(cancelBtn);
  form.appendChild(btns);
  mo.appendChild(form);
  document.body.appendChild(ov);
  ucSel.focus();

  saveBtn.addEventListener('click', async () => {
    if (!ucSel.value) { errorArea.textContent = 'Please select a use case.'; errorArea.style.display = 'block'; return; }
    saveBtn.disabled = true; saveBtn.textContent = 'Linking…';
    try {
      await apiFetch(`/projects/${pid}/agents/${agent.agent_spec_id}/use-cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ use_case_id: ucSel.value, business_value: bvInput.value.trim() || null })
      });
      close();
      (await _p2Reload())('✓ Use case linked', 'success');
      if (_currentReportArea && pid && _currentScope) await loadReport(_currentReportArea, pid, _currentScope);
    } catch (err) {
      errorArea.textContent = `Failed: ${err.message}`; errorArea.style.display = 'block';
      saveBtn.disabled = false; saveBtn.textContent = 'Link Use Case';
    }
  });
}

// ─── Phase 3: agent ↔ tool binding modal ────────────────────────────────────

async function openAgentToolModal(agent, binding = null) {
  const pid = _currentProjectId || agent.project_id;
  const isEdit = !!binding;
  const { apiFetch } = await import('./app.js');

  // Fetch project tools for the dropdown
  const allTools = await apiFetch(`/projects/${pid}/tools`).then(r => Array.isArray(r) ? r : []).catch(() => []);
  const bound = new Set((agent.tool_bindings || []).map(b => b.tool_id));
  const available = isEdit ? allTools : allTools.filter(t => !bound.has(t.tool_id));

  const { ov, mo } = _p2Overlay();
  const closeBtn = _p2Header(mo, isEdit ? 'Edit Tool Binding' : 'Bind Tool', agent.name);
  const close = _p2Close(ov, closeBtn, ov);

  if (!isEdit && !available.length) {
    mo.appendChild(el('p', { style: { padding: '16px', color: 'var(--color-text-muted)' } },
      'All project tools are already bound to this agent.'));
    document.body.appendChild(ov);
    return;
  }

  const form = el('div', { className: 'dr-edit-form' });

  // Tool select (read-only in edit mode)
  if (!isEdit) {
    const toolSel = el('select', { style: { width: '100%', marginBottom: '12px' } });
    toolSel.id = '_agToolSel';
    toolSel.appendChild(el('option', { value: '' }, '— select a tool —'));
    available.forEach(t => toolSel.appendChild(el('option', { value: t.tool_id }, `${t.slug || ''} ${t.name}`)));
    form.appendChild(el('label', { className: 'dr-edit-label' }, 'Tool'));
    form.appendChild(toolSel);
  } else {
    form.appendChild(el('label', { className: 'dr-edit-label' }, 'Tool'));
    const toolBadge = el('div', { style: { marginBottom: '12px', fontWeight: '600' } },
      `${binding.tool_slug || ''} ${binding.tool_name}`);
    form.appendChild(toolBadge);
  }

  // Purpose
  const purposeInput = el('textarea', { className: 'dr-edit-textarea', rows: 2,
    placeholder: 'What does this tool do for this specific agent?' });
  if (isEdit && binding.purpose) purposeInput.value = binding.purpose;
  form.appendChild(el('label', { className: 'dr-edit-label' }, 'Purpose'));
  form.appendChild(purposeInput);

  // Fallback behavior
  const fallbackInput = el('input', { className: 'dr-edit-input', type: 'text',
    placeholder: 'What happens if the tool call fails?' });
  if (isEdit && binding.fallback_behavior) fallbackInput.value = binding.fallback_behavior;
  form.appendChild(el('label', { className: 'dr-edit-label' }, 'Fallback Behavior (optional)'));
  form.appendChild(fallbackInput);

  // Supervision model
  const supSel = el('select', { className: 'dr-edit-select' });
  [['', '— not set —'], ['Supervised', 'Supervised'], ['Autonomous', 'Autonomous']]
    .forEach(([v, l]) => { const o = el('option', { value: v }, l); if (isEdit && binding.binding_supervision_model === v) o.selected = true; supSel.appendChild(o); });
  form.appendChild(el('label', { className: 'dr-edit-label' }, 'Supervision Model'));
  form.appendChild(supSel);

  // Execution mode
  const execSel = el('select', { className: 'dr-edit-select' });
  [['', '— not set —'], ['Autonomous', 'Autonomous'], ['Human-permission required', 'Human-permission required']]
    .forEach(([v, l]) => { const o = el('option', { value: v }, l); if (isEdit && binding.tool_execution_mode === v) o.selected = true; execSel.appendChild(o); });
  form.appendChild(el('label', { className: 'dr-edit-label' }, 'Execution Mode'));
  form.appendChild(execSel);

  const errorArea = el('div', { className: 'dr-edit-error', style: { display: 'none' } });
  form.appendChild(errorArea);

  const saveLabel = isEdit ? 'Save Changes' : 'Bind Tool';
  const saveBtn = el('button', { className: 'dr-edit-save-btn' }, saveLabel);
  const cancelBtn = el('button', { className: 'dr-edit-cancel-btn' }, 'Cancel');
  cancelBtn.addEventListener('click', close);
  const btns = el('div', { className: 'dr-edit-btn-row' });
  btns.appendChild(saveBtn); btns.appendChild(cancelBtn);
  form.appendChild(btns);
  mo.appendChild(form);
  document.body.appendChild(ov);

  saveBtn.addEventListener('click', async () => {
    const toolSel = document.getElementById('_agToolSel');
    if (!isEdit && toolSel && !toolSel.value) {
      errorArea.textContent = 'Please select a tool.'; errorArea.style.display = 'block'; return;
    }
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    try {
      const body = {
        purpose: purposeInput.value.trim() || null,
        fallback_behavior: fallbackInput.value.trim() || null,
        binding_supervision_model: supSel.value || null,
        tool_execution_mode: execSel.value || null
      };
      if (!isEdit) body.tool_id = toolSel.value;

      const url = isEdit
        ? `/projects/${pid}/agents/${agent.agent_spec_id}/tools/${binding.agent_tool_id}`
        : `/projects/${pid}/agents/${agent.agent_spec_id}/tools`;
      await apiFetch(url, { method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      close();
      (await _p2Reload())(isEdit ? '✓ Binding updated' : '✓ Tool bound', 'success');
      if (_currentReportArea && pid && _currentScope) await loadReport(_currentReportArea, pid, _currentScope);
    } catch (err) {
      errorArea.textContent = `Failed: ${err.message}`; errorArea.style.display = 'block';
      saveBtn.disabled = false; saveBtn.textContent = saveLabel;
    }
  });
}

function openRasicPopover(anchorEl, wf, step, participant, entries) {
  // entries: [{code, rasic_id}] for this (step × participant) pair
  const pid = _currentProjectId;
  const wfId = wf.workflow_id;

  // Remove any existing popover
  document.querySelectorAll('.dr-rasic-popover').forEach(p => p.remove());

  const pop = el('div', { className: 'dr-rasic-popover' });
  const title = el('div', { className: 'dr-rasic-popover-title' },
    `${step.step_number}. ${step.name} × ${participantLabel(participant)}`);
  pop.appendChild(title);

  // Live entries array (mutated by check/uncheck)
  let liveEntries = [...entries];

  const refreshCell = () => {
    const codes = liveEntries.map(e => e.code).sort().join('');
    anchorEl.textContent = codes || '·';
    anchorEl.style.color = codes ? 'var(--color-accent)' : 'var(--color-text-muted)';
  };

  ['R', 'A', 'S', 'I', 'C'].forEach(code => {
    const row = el('div', { className: 'dr-rasic-popover-row' });
    const chkId = `rasic-${step.workflow_step_id}-${participant.workflow_participant_id}-${code}`;
    const chk = el('input', { type: 'checkbox', id: chkId });
    chk.checked = liveEntries.some(e => e.code === code);
    const lbl = el('label', { for: chkId }, `${code} — ${RASIC_LABELS[code] || code}`);
    row.appendChild(chk);
    row.appendChild(lbl);

    chk.addEventListener('change', async () => {
      chk.disabled = true;
      try {
        if (chk.checked) {
          const result = await apiFetch(
            `/projects/${pid}/workflows/${wfId}/steps/${step.workflow_step_id}/rasic`,
            { method: 'POST', body: JSON.stringify({ workflow_participant_id: participant.workflow_participant_id, code }) }
          );
          liveEntries.push({ code, rasic_id: result.rasic_id });
        } else {
          const entry = liveEntries.find(e => e.code === code);
          if (entry?.rasic_id) {
            await apiFetch(
              `/projects/${pid}/workflows/${wfId}/steps/${step.workflow_step_id}/rasic/${entry.rasic_id}`,
              { method: 'DELETE' }
            );
            liveEntries = liveEntries.filter(e => e.code !== code);
          }
        }
        refreshCell();
      } catch (err) {
        chk.checked = !chk.checked; // revert on error
        console.error('[rasic toggle]', err);
      } finally {
        chk.disabled = false;
      }
    });
    pop.appendChild(row);
  });

  // Position popover near anchor cell
  const rect = anchorEl.getBoundingClientRect();
  pop.style.position = 'fixed';
  pop.style.top  = `${rect.bottom + 4}px`;
  pop.style.left = `${Math.max(4, rect.left - 60)}px`;
  document.body.appendChild(pop);

  // Close when clicking outside
  const onOutside = e => {
    if (!pop.contains(e.target) && e.target !== anchorEl) {
      pop.remove();
      document.removeEventListener('mousedown', onOutside);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', onOutside), 10);
}

/** Returns a small "Edit" button for Tier-1 entity headers. */
function buildEditBtn(entityType, entity) {
  const cfg = EDIT_CONFIGS[entityType];
  if (!cfg) return null;
  const btn = el('button', { className: 'dr-edit-btn', title: `Edit ${cfg.label}` }, '✏️ Edit');
  btn.addEventListener('click', e => {
    e.stopPropagation();
    openEditModal(entityType, entity);
  });
  return btn;
}

/**
 * Show the AI-drafted prompt in a review modal so the user can edit before saving.
 * result = { draft, model, source } from POST /agent-specs/:id/draft-prompt
 */
function openDraftPromptModal(agent, result, onSaved) {
  const overlay = el('div', { className: 'dr-edit-overlay' });
  const modal   = el('div', { className: 'dr-edit-modal', style: 'max-width:680px' });

  // ── header ──
  const hdr = el('div', { className: 'dr-edit-header' });
  hdr.appendChild(el('h3', { className: 'dr-edit-title' }, `Draft Prompt — ${agent.name}`));
  const closeBtn = el('button', { className: 'dr-edit-close', title: 'Cancel' }, '×');
  closeBtn.addEventListener('click', () => overlay.remove());
  hdr.appendChild(closeBtn);
  modal.appendChild(hdr);

  // ── source badge ──
  const srcLine = el('div', { style: 'margin-bottom:10px;font-size:12px' });
  if (result.source === 'claude') {
    srcLine.appendChild(el('span', {
      className: 'badge badge-success',
      style: 'margin-right:6px'
    }, `Drafted by ${result.model}`));
    srcLine.appendChild(document.createTextNode('Review and edit before saving.'));
  } else {
    srcLine.appendChild(el('span', {
      className: 'badge badge-warn',
      style: 'margin-right:6px'
    }, 'Stub draft (no API key)'));
    srcLine.appendChild(document.createTextNode('Set ANTHROPIC_API_KEY for Claude-generated drafts. Edit below and save.'));
  }
  modal.appendChild(srcLine);

  // ── editable textarea ──
  const ta = el('textarea', {
    className: 'dr-edit-input dr-edit-textarea',
    rows: '18',
    style: 'width:100%;font-family:monospace;font-size:13px'
  });
  ta.value = result.draft || '';
  modal.appendChild(ta);

  // ── footer ──
  const footer = el('div', { style: 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px' });
  const cancelBtn = el('button', { className: 'btn btn-secondary' }, 'Cancel');
  cancelBtn.addEventListener('click', () => overlay.remove());
  const saveBtn = el('button', { className: 'btn btn-primary' }, 'Save Prompt');
  saveBtn.addEventListener('click', async () => {
    const text = ta.value.trim();
    if (!text) { showToast('Prompt is empty — nothing saved.', 'warning'); return; }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      await apiFetch(`/projects/${_currentProjectId}/agent-specs/${agent.agent_spec_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instructions: text })
      });
      showToast('Prompt saved', 'success');
      overlay.remove();
      if (onSaved) onSaved();
    } catch (err) {
      showToast('Save failed: ' + err.message, 'error');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Prompt';
    }
  });
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);
  modal.appendChild(footer);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  // Close on backdrop click
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) overlay.remove(); });
}

/**
 * Open a modal to CREATE a new config-driven design entity (PO-authoring).
 * Thin sibling of openEditModal: renders cfg.fields, POSTs to createEndpoint,
 * shows the auto-approved CP code, and reloads. `seed` pre-fills fields.
 */
function openCreateModal(entityType, seed = {}) {
  const cfg = EDIT_CONFIGS[entityType];
  if (!cfg || !cfg.createEndpoint || !_currentProjectId) {
    showToast('Authoring is not available for this entity.', 'warning');
    return;
  }
  const overlay = el('div', { className: 'dr-edit-overlay' });
  const modal   = el('div', { className: 'dr-edit-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': `New ${cfg.label}` });
  const mhdr = el('div', { className: 'dr-edit-modal-header' });
  mhdr.appendChild(el('div', { className: 'dr-edit-modal-title' }, `New ${cfg.label}`));
  const closeBtn = el('button', { className: 'dr-edit-close', title: 'Close' }, '✕');
  mhdr.appendChild(closeBtn);
  modal.appendChild(mhdr);
  modal.appendChild(el('div', { className: 'dr-edit-banner' },
    el('span', { className: 'dr-edit-banner-icon' }, 'ℹ️'),
    'Saved as an auto-approved Change Packet with a full audit trail.'));

  const body = el('div', { className: 'dr-edit-body' });
  const inputs = {};
  cfg.fields.forEach(field => {
    if (field.key === 'status') return;   // status is system-managed (authored on create)
    const group = el('div', { className: 'dr-edit-field-group' });
    group.appendChild(el('label', { className: 'dr-edit-label' }, field.label));
    let input;
    const seedVal = seed[field.key];
    if (field.type === 'textarea' || field.type === 'json-list') {
      input = el('textarea', { className: 'dr-edit-input dr-edit-textarea', rows: '4' });
      if (seedVal != null) input.value = Array.isArray(seedVal) ? seedVal.join('\n') : String(seedVal);
      if (field.type === 'json-list') input.dataset.fieldType = 'json-list';
    } else if (field.type === 'json') {
      input = el('textarea', { className: 'dr-edit-input dr-edit-textarea dr-edit-json', rows: '6', spellcheck: 'false' });
      input.value = seedVal != null ? (typeof seedVal === 'string' ? seedVal : JSON.stringify(seedVal, null, 2)) : '';
      if (field.help) {} // keep simple
      input.placeholder = '[ { ... } ]';
    } else if (field.type === 'select') {
      input = el('select', { className: 'dr-edit-input dr-edit-select' });
      (field.options || []).forEach(opt => input.appendChild(el('option', { value: opt }, opt.replace(/_/g, ' '))));
      if (seedVal != null) input.value = String(seedVal);
    } else if (field.type === 'number') {
      input = el('input', { type: 'number', className: 'dr-edit-input dr-edit-text', step: String(field.step ?? '1') });
      if (seedVal != null) input.value = String(seedVal);
    } else {
      input = el('input', { type: 'text', className: 'dr-edit-input dr-edit-text' });
      if (seedVal != null) input.value = String(seedVal);
    }
    inputs[field.key] = input;
    group.appendChild(input);
    body.appendChild(group);
  });
  modal.appendChild(body);

  const errorArea = el('div', { className: 'dr-edit-error', style: { display: 'none' } });
  modal.appendChild(errorArea);
  const footer = el('div', { className: 'dr-edit-footer' });
  const cancelBtn = el('button', { className: 'btn btn-ghost' }, 'Cancel');
  const saveBtn   = el('button', { className: 'btn btn-primary' }, `Create ${cfg.label}`);
  footer.appendChild(cancelBtn); footer.appendChild(saveBtn);
  modal.appendChild(footer);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  setTimeout(() => { const f = modal.querySelector('input,textarea,select'); if (f) f.focus(); }, 60);

  const close = () => overlay.remove();
  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  saveBtn.addEventListener('click', async () => {
    const payload = {};
    let createParseError = null;
    cfg.fields.forEach(field => {
      const inp = inputs[field.key]; if (!inp) return;
      if (field.type === 'json-list') payload[field.key] = inp.value.split('\n').map(l => l.trim()).filter(Boolean);
      else if (field.type === 'json') {
        const txt = inp.value.trim();
        if (txt === '') payload[field.key] = [];
        else { try { payload[field.key] = JSON.parse(txt); } catch (e) { createParseError = `${field.label}: invalid JSON — ${e.message}`; } }
      }
      else if (field.type === 'number') { const v = inp.value.trim(); payload[field.key] = v === '' ? null : parseFloat(v); }
      else payload[field.key] = inp.value;
    });
    if (createParseError) { errorArea.textContent = createParseError; errorArea.style.display = 'block'; return; }
    const nameKey = cfg.nameKey || 'name';
    if (!String(payload[nameKey] || payload.name || '').trim()) {
      errorArea.textContent = 'Name is required.'; errorArea.style.display = 'block'; return;
    }
    saveBtn.disabled = true; saveBtn.textContent = 'Creating…';
    try {
      const result = await apiFetch(cfg.createEndpoint(_currentProjectId), { method: 'POST', body: JSON.stringify(payload) });
      showToast(`${cfg.label} created${result._cp?.cpCode ? ` — ${result._cp.cpCode}` : ''}`, 'success');
      close();
      const pid = getCurrentProjectId();
      if (pid && _currentReportArea) loadReport(_currentReportArea, pid, _currentScope);
    } catch (err) {
      errorArea.textContent = 'Create failed: ' + err.message; errorArea.style.display = 'block';
      saveBtn.disabled = false; saveBtn.textContent = `Create ${cfg.label}`;
    }
  });
}

/**
 * Open a modal to edit a Tier-1 entity inline.
 * On save, calls the PUT endpoint, creates an auto-approved CP, and reloads.
 */
function openEditModal(entityType, entity) {
  const cfg = EDIT_CONFIGS[entityType];
  if (!cfg || !_currentProjectId) return;

  const entityId   = entity[cfg.idKey];
  const entityName = entity[cfg.nameKey] || entityId;

  // ── build overlay ─────────────────────────────────────────────
  const overlay = el('div', { className: 'dr-edit-overlay' });
  const modal   = el('div', { className: 'dr-edit-modal', role: 'dialog',
    'aria-modal': 'true', 'aria-label': `Edit ${cfg.label}` });

  // Header
  const mhdr = el('div', { className: 'dr-edit-modal-header' });
  mhdr.appendChild(el('div', { className: 'dr-edit-modal-title' }, `Edit ${cfg.label}`));
  mhdr.appendChild(el('div', { className: 'dr-edit-modal-subtitle' }, entityName));
  const closeBtn = el('button', { className: 'dr-edit-close', title: 'Close' }, '✕');
  mhdr.appendChild(closeBtn);
  modal.appendChild(mhdr);

  // Info banner
  modal.appendChild(el('div', { className: 'dr-edit-banner' },
    el('span', { className: 'dr-edit-banner-icon' }, 'ℹ️'),
    'Changes are saved immediately as an auto-approved Change Packet with a full audit trail.'
  ));

  // Body — form fields
  const body   = el('div', { className: 'dr-edit-body' });
  const inputs = {}; // key → input element

  // Resolve a field's current value from the entity, supporting:
  //  - dot-paths into nested objects (e.g. "run_as_model.model_type")
  //  - legacy alias "contract_description" → entity.contract(.description)
  const getFieldValue = (key) => {
    if (key === 'contract_description') {
      return typeof entity.contract === 'object' && entity.contract
        ? (entity.contract.description || '')
        : (entity.contract || '');
    }
    if (key.includes('.')) {
      return key.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), entity);
    }
    return entity[key];
  };

  cfg.fields.forEach(field => {
    const group = el('div', { className: 'dr-edit-field-group' });
    group.appendChild(el('label', { className: 'dr-edit-label' }, field.label));
    if (field.help) {
      group.appendChild(el('div', { className: 'dr-edit-help' }, field.help));
    }

    let input;
    const raw = getFieldValue(field.key);

    if (field.type === 'textarea') {
      input = el('textarea', { className: 'dr-edit-input dr-edit-textarea',
        rows: String(field.rows || 4) });
      if (field.placeholder) input.placeholder = field.placeholder;
      input.value = typeof raw === 'string' ? raw : (raw != null ? String(raw) : '');

    } else if (field.type === 'json-list') {
      input = el('textarea', { className: 'dr-edit-input dr-edit-textarea', rows: '4' });
      const arr = Array.isArray(raw) ? raw
        : (typeof raw === 'string' ? (() => { try { const p = JSON.parse(raw); return Array.isArray(p) ? p : [raw]; } catch { return raw ? [raw] : []; } })()
        : []);
      input.value = arr.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join('\n');
      input.dataset.fieldType = 'json-list';
    } else if (field.type === 'json-raw' || field.type === 'json') {
      input = el('textarea', { className: 'dr-edit-input dr-edit-textarea dr-edit-json',
        rows: String(field.rows || 8), spellcheck: 'false' });
      input.value = raw == null ? ''
        : (typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2));
      input.dataset.fieldType = 'json-raw';
    } else if (field.type === 'select') {
      input = el('select', { className: 'dr-edit-input dr-edit-select' });
      (field.options || []).forEach(opt => {
        const o = el('option', { value: opt }, opt.replace(/_/g, ' '));
        input.appendChild(o);
      });
      input.value = typeof raw === 'string' ? raw : String(raw ?? '');
    } else if (field.type === 'number') {
      input = el('input', { type: 'number', className: 'dr-edit-input dr-edit-text',
        step: String(field.step ?? '0.5'),
        min:  field.min != null ? String(field.min) : '0' });
      if (field.max != null) input.max = String(field.max);
      input.value = raw != null ? String(raw) : '';
    } else {
      // text (default)
      input = el('input', { type: 'text', className: 'dr-edit-input dr-edit-text' });
      input.value = raw != null ? String(raw) : '';
    }

    inputs[field.key] = input;
    group.appendChild(input);
    body.appendChild(group);
  });

  // ── Methodology Guidance panel (Phase 5, Decision #8) ───────────────────
  // Read-only guidance — no save blocking. Shows the Required-By-Mode matrix
  // filtered to the currently selected supervision_model (or full matrix for
  // entities like workflow that don't carry a mode).
  const guidancePanel = buildRequiredByModePanel(entityType, cfg, getFieldValue('supervision_model'));
  if (guidancePanel) {
    body.appendChild(guidancePanel);
    // Reactive: if the form has a supervision_model select, re-render the
    // panel each time the user changes the mode.
    const modeInput = inputs['supervision_model'];
    if (modeInput) {
      modeInput.addEventListener('change', () => {
        const newPanel = buildRequiredByModePanel(entityType, cfg, modeInput.value);
        if (newPanel) guidancePanel.replaceWith(newPanel);
      });
    }
  }

  modal.appendChild(body);

  // ── Requirements traceability (FR / NFR) ──────────────────────────────────
  // If the entity being edited is a functional or non-functional requirement and
  // has ac_count / tc_count returned by the enriched GET endpoint, show a quick
  // link to the Testing module so the reviewer can navigate directly to the ACs
  // and TCs that trace back to this requirement.
  if ((entityType === 'functional_req' || entityType === 'nonfunctional_req') &&
      (entity.ac_count > 0 || entity.tc_count > 0)) {
    const traceLink = el('div', {
      style: 'margin:0 0 12px 0;padding:10px 14px;background:var(--surface-alt,#f8fafc);' +
             'border:1px solid var(--border,#e2e8f0);border-radius:8px;display:flex;' +
             'align-items:center;gap:10px;font-size:13px;'
    });
    const counts = [];
    if (entity.ac_count > 0) counts.push(`${entity.ac_count} acceptance criteri${entity.ac_count === 1 ? 'on' : 'a'}`);
    if (entity.tc_count  > 0) counts.push(`${entity.tc_count} test case${entity.tc_count === 1 ? '' : 's'}`);
    traceLink.appendChild(el('span', { style: 'color:var(--text-muted,#64748b)' },
      `Linked in Testing: ${counts.join(' · ')}`));
    const viewBtn = el('a', { style: 'margin-left:auto;font-size:12px;font-weight:600;color:var(--accent,#2563eb);cursor:pointer;text-decoration:none;white-space:nowrap' },
      '→ View in Testing');
    viewBtn.addEventListener('click', () => {
      overlay.remove();
      document.querySelector('[data-module="testing"]')?.click();
    });
    traceLink.appendChild(viewBtn);
    modal.appendChild(traceLink);
  }

  // ── Requirement ↔ element traceability links ──────────────────────────────
  // Shown for requirements (their implementers) and for derived elements (the
  // requirements they implement). AI-proposed links are confirmable/editable here.
  if (['functional_req','nonfunctional_req','use_case','workflow','workflow_step','agent','tool'].includes(entityType)) {
    const tracePanel = el('div', { className: 'dr-trace-panel', style: 'margin:0 0 12px 0;' });
    modal.appendChild(tracePanel);
    renderTraceabilityPanel(tracePanel, entityType, entityId, _currentProjectId).catch(() => {});
  }

  // Error area
  const errorArea = el('div', { className: 'dr-edit-error', style: { display: 'none' } });
  modal.appendChild(errorArea);

  // Footer buttons
  const footer  = el('div', { className: 'dr-edit-footer' });
  const cancelBtn = el('button', { className: 'btn btn-ghost' }, 'Cancel');
  const saveBtn   = el('button', { className: 'btn btn-primary' }, 'Save Changes');
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);
  modal.appendChild(footer);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  // Focus first input
  setTimeout(() => { const first = modal.querySelector('input,textarea,select'); if (first) first.focus(); }, 60);

  // ── close helpers ──────────────────────────────────────────────
  const closeModal = () => overlay.remove();
  closeBtn.addEventListener('click', closeModal);
  cancelBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
  document.addEventListener('keydown', function escHandler(e) {
    if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', escHandler); }
  });

  // ── save handler ───────────────────────────────────────────────
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled  = true;
    saveBtn.textContent = 'Saving…';
    errorArea.style.display = 'none';

    const payload = {};
    // Nested-key staging: top-level key → object of edits, so we can merge with
    // existing entity values before sending (preserves untouched sub-keys).
    const nested = {};
    let parseError = null;

    cfg.fields.forEach(field => {
      const inp = inputs[field.key];
      if (!inp) return;

      let value;
      if (field.type === 'json-list') {
        value = inp.value.split('\n').map(l => l.trim()).filter(Boolean);
      } else if (field.type === 'json-raw' || field.type === 'json') {
        const txt = inp.value.trim();
        if (txt === '') { value = field.type === 'json' ? [] : null; }
        else {
          try { value = JSON.parse(txt); }
          catch (e) { parseError = `${field.label}: invalid JSON — ${e.message}`; return; }
        }
      } else if (field.type === 'number') {
        const v = inp.value.trim();
        value = v === '' ? null : parseFloat(v);
      } else {
        value = inp.value;
      }

      if (field.key.includes('.')) {
        // Dot-path: stash into the nested bucket under the top-level key.
        const parts  = field.key.split('.');
        const top    = parts[0];
        const rest   = parts.slice(1);
        if (!nested[top]) nested[top] = {};
        let cursor = nested[top];
        for (let i = 0; i < rest.length - 1; i++) {
          if (!cursor[rest[i]] || typeof cursor[rest[i]] !== 'object') cursor[rest[i]] = {};
          cursor = cursor[rest[i]];
        }
        cursor[rest[rest.length - 1]] = value;
      } else if (field.key === 'contract_description') {
        // Legacy alias: merge into contract object's description.
        if (!nested.contract) nested.contract = {};
        nested.contract.description = value;
      } else {
        payload[field.key] = value;
      }
    });

    if (parseError) {
      errorArea.textContent = parseError;
      errorArea.style.display = 'block';
      saveBtn.disabled  = false;
      saveBtn.textContent = 'Save Changes';
      return;
    }

    // Merge each nested bucket with the existing entity's value so we send a
    // complete object back (server replaces the whole JSON column).
    Object.entries(nested).forEach(([top, edits]) => {
      const existing = entity[top];
      const base = (existing && typeof existing === 'object' && !Array.isArray(existing))
        ? existing : {};
      payload[top] = deepMerge(base, edits);
    });

    // Rename payload keys per payloadAlias (e.g. API `trigger` → DB column `trigger_def`).
    if (cfg.payloadAlias) {
      Object.entries(cfg.payloadAlias).forEach(([from, to]) => {
        if (Object.prototype.hasOwnProperty.call(payload, from)) {
          payload[to] = payload[from];
          delete payload[from];
        }
      });
    }

    try {
      const parentId = cfg.parentKey ? entity[cfg.parentKey] : undefined;
      const result = await apiFetch(cfg.endpoint(_currentProjectId, entityId, parentId), {
        method: 'PUT',
        body: JSON.stringify(payload),
      });

      const cpCode = result._cp?.cpCode;
      closeModal();

      // Show success toast using app.js showToast
      const { showToast } = await import('../app.js');
      const reviewNote = result._review_queued ? ' · AI review queued' : '';
      showToast(
        cpCode
          ? `✓ ${cfg.label} saved — Change Packet ${cpCode} created${reviewNote}`
          : `✓ ${cfg.label} saved (no changes detected)`,
        'success'
      );

      // Reload the current report view
      if (_currentReportArea && _currentProjectId && _currentScope) {
        await loadReport(_currentReportArea, _currentProjectId, _currentScope);
      }
    } catch (err) {
      errorArea.textContent = `Save failed: ${err.message}`;
      errorArea.style.display = 'block';
      saveBtn.disabled  = false;
      saveBtn.textContent = 'Save Changes';
    }
  });
}

// ─── Requirement ↔ element traceability panel ──────────────────────────────
// Renders the links for the entity being edited and lets the reviewer confirm /
// reject AI-proposed links, remove links, and add new ones. Used for both
// requirements (their implementing elements) and derived elements (the
// requirements they implement). Backed by /api/v1/projects/:id/requirement-links.
const TRACE_REQ_TYPE_OF = { functional_req: 'functional', nonfunctional_req: 'nonfunctional' };
const TRACE_LINK_ENTITY_TYPE = { agent: 'agent_spec' }; // route label → link enum

function traceStatusBadge(status) {
  const colors = {
    proposed:  'background:#fef3c7;color:#92400e',
    confirmed: 'background:#dcfce7;color:#166534',
    rejected:  'background:#fee2e2;color:#991b1b',
  };
  return el('span', {
    style: `font-size:10px;font-weight:700;text-transform:uppercase;padding:2px 6px;border-radius:4px;${colors[status] || ''}`,
  }, status);
}

async function renderTraceabilityPanel(container, entityType, entityId, pid) {
  if (!pid || !entityId) return;
  const isReq = !!TRACE_REQ_TYPE_OF[entityType];
  const linkEntityType = TRACE_LINK_ENTITY_TYPE[entityType] || entityType;

  const heading = isReq ? 'Implemented by (traceability)' : 'Implements requirements (traceability)';
  const wrap = el('div', {
    style: 'padding:10px 14px;background:var(--surface-alt,#f8fafc);border:1px solid var(--border,#e2e8f0);border-radius:8px;font-size:13px;',
  });
  wrap.appendChild(el('div', { style: 'font-weight:600;margin-bottom:8px;color:var(--text,#1e293b)' }, heading));
  const list = el('div', { style: 'display:flex;flex-direction:column;gap:6px;' });
  wrap.appendChild(list);
  container.appendChild(wrap);

  const query = isReq
    ? `req_type=${TRACE_REQ_TYPE_OF[entityType]}&req_id=${encodeURIComponent(entityId)}`
    : `entity_type=${encodeURIComponent(linkEntityType)}&entity_id=${encodeURIComponent(entityId)}`;

  async function reload() {
    list.textContent = '';
    let links = [];
    try { links = await apiFetch(`/projects/${pid}/requirement-links?${query}&include_rejected=1`); } catch { /* ignore */ }
    if (!links || links.length === 0) {
      list.appendChild(el('div', { style: 'color:var(--text-muted,#64748b);font-style:italic' }, 'No links yet.'));
    }
    for (const link of (links || [])) {
      const row = el('div', { style: 'display:flex;align-items:center;gap:8px;' });
      const label = isReq
        ? `${link.entity_slug || '?'} · ${link.entity_label || link.entity_type}`
        : `${link.req_slug || '?'} · ${link.req_title || ''}`;
      row.appendChild(el('span', { style: 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, label));
      if (link.source === 'agent_ingest') row.appendChild(el('span', { style: 'font-size:10px;color:#64748b' }, '🤖'));
      row.appendChild(traceStatusBadge(link.status));

      const mkBtn = (txt, title, onClick) => {
        const b = el('button', { className: 'btn btn-ghost', style: 'font-size:11px;padding:2px 8px;', title }, txt);
        b.addEventListener('click', async () => {
          b.disabled = true;
          try { await onClick(); await reload(); }
          catch (err) { showToast('Link update failed: ' + err.message, 'error'); b.disabled = false; }
        });
        return b;
      };
      if (link.status === 'proposed') {
        row.appendChild(mkBtn('✓', 'Confirm link', () =>
          apiFetch(`/projects/${pid}/requirement-links/${link.link_id}`, { method: 'PUT', body: JSON.stringify({ status: 'confirmed' }) })));
        row.appendChild(mkBtn('✕', 'Reject link', () =>
          apiFetch(`/projects/${pid}/requirement-links/${link.link_id}`, { method: 'PUT', body: JSON.stringify({ status: 'rejected' }) })));
      }
      row.appendChild(mkBtn('🗑', 'Remove link', () =>
        apiFetch(`/projects/${pid}/requirement-links/${link.link_id}`, { method: 'DELETE' })));
      list.appendChild(row);
    }
  }

  // ── Add-link control ──────────────────────────────────────────────────────
  const addRow = el('div', { style: 'display:flex;gap:6px;margin-top:10px;align-items:center;' });
  const targetSel = el('select', { className: 'form-select', style: 'flex:1;font-size:12px;padding:4px;' });
  targetSel.appendChild(el('option', { value: '' }, 'Add a link…'));
  const addBtn = el('button', { className: 'btn btn-ghost', style: 'font-size:12px;padding:4px 10px;' }, '+ Add');
  addRow.appendChild(targetSel);
  addRow.appendChild(addBtn);
  wrap.appendChild(addRow);

  // Populate candidate targets.
  try {
    if (isReq) {
      // Requirement → elements: workflows, agents, tools.
      const [wfs, agents, tools] = await Promise.all([
        apiFetch(`/projects/${pid}/workflows`).catch(() => []),
        apiFetch(`/projects/${pid}/agent-specs`).catch(() => []),
        apiFetch(`/projects/${pid}/tools`).catch(() => []),
      ]);
      const addOpts = (rows, type, idKey, nameKey) => (rows || []).forEach(r =>
        targetSel.appendChild(el('option', { value: `${type}:${r[idKey]}` }, `${r.slug || ''} ${r[nameKey] || ''} (${type})`)));
      addOpts(wfs, 'workflow', 'workflow_id', 'name');
      addOpts(agents, 'agent_spec', 'agent_spec_id', 'name');
      addOpts(tools, 'tool', 'tool_id', 'name');
    } else {
      // Element → requirements: FR + NFR.
      const [frs, nfrs] = await Promise.all([
        apiFetch(`/projects/${pid}/functional-reqs`).catch(() => []),
        apiFetch(`/projects/${pid}/nonfunctional-reqs`).catch(() => []),
      ]);
      (frs || []).forEach(r => targetSel.appendChild(el('option', { value: `functional:${r.fr_id}` }, `${r.slug || ''} ${r.title || ''} (FR)`)));
      (nfrs || []).forEach(r => targetSel.appendChild(el('option', { value: `nonfunctional:${r.nfr_id}` }, `${r.slug || ''} ${r.title || ''} (NFR)`)));
    }
  } catch { /* candidate population is best-effort */ }

  addBtn.addEventListener('click', async () => {
    const val = targetSel.value;
    if (!val) return;
    const [type, id] = val.split(/:(.+)/);
    addBtn.disabled = true;
    try {
      const bodyObj = isReq
        ? { req_type: TRACE_REQ_TYPE_OF[entityType], req_id: entityId, entity_type: type, entity_id: id, status: 'confirmed', source: 'manual' }
        : { req_type: type, req_id: id, entity_type: linkEntityType, entity_id: entityId, status: 'confirmed', source: 'manual' };
      await apiFetch(`/projects/${pid}/requirement-links`, { method: 'POST', body: JSON.stringify(bodyObj) });
      targetSel.value = '';
      await reload();
    } catch (err) {
      showToast('Add link failed: ' + err.message, 'error');
    } finally {
      addBtn.disabled = false;
    }
  });

  await reload();
}

// ─── Required-By-Mode guidance panel (Phase 5) ─────────────────────────────
// Returns a collapsible <details> element listing each field with its R/C/O
// code per the methodology matrix. If the entity has a supervision_model
// (UC, Agent), the panel is filtered to that mode. For Workflow, all three
// modes are shown side-by-side as reference.
function buildRequiredByModePanel(entityType, cfg, currentMode) {
  const matrix = REQUIRED_BY_MODE[entityType];
  if (!matrix) return null;

  // Decide layout: filtered (1 column) for entities with a mode, comparison
  // (3 columns) for entities without one.
  const HAS_MODE_ENTITIES = new Set(['use_case', 'agent']);
  const showAllModes = !HAS_MODE_ENTITIES.has(entityType);
  const modes = ['Advisory-only', 'Supervised HITL', 'Autonomous'];
  const filterMode = HAS_MODE_ENTITIES.has(entityType)
    ? (modes.includes(currentMode) ? currentMode : 'Supervised HITL')
    : null;

  const wrap = el('details', { className: 'dr-rbm-panel', style:
    'margin-top:18px;padding:10px 14px;background:var(--surface-secondary,#f7f9fb);' +
    'border:1px solid var(--border);border-radius:6px' });

  const summary = el('summary', { style:
    'cursor:pointer;font-weight:600;font-size:13px;color:var(--text);' +
    'list-style-position:outside;padding:2px 0' });
  summary.appendChild(document.createTextNode('Methodology Guidance — Required by Supervision Mode'));
  if (filterMode) {
    summary.appendChild(el('span', { style:
      'margin-left:10px;font-weight:400;font-size:11px;color:var(--text-muted)' },
      `(showing: ${filterMode})`));
  }
  wrap.appendChild(summary);

  wrap.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);margin:6px 0 10px' },
    'Read-only guidance. Workbench does not enforce these requirements — they reflect ' +
    'the methodology\'s recommended completeness gate before promotion to higher autonomy. ',
    el('strong', {}, 'R'), ' = Required, ',
    el('strong', {}, 'C'), ' = Conditional, ',
    el('strong', {}, 'O'), ' = Optional.'
  ));

  const tbl = el('table', { style: 'width:100%;font-size:12px;border-collapse:collapse' });
  const thead = el('thead');
  const headRow = el('tr', {},
    el('th', { style: 'text-align:left;padding:4px 6px;border-bottom:1px solid var(--border);font-weight:600' }, 'Field')
  );
  if (showAllModes) {
    modes.forEach(m => {
      headRow.appendChild(el('th', { style: 'text-align:center;padding:4px 6px;border-bottom:1px solid var(--border);font-weight:600;width:120px' }, m));
    });
  } else {
    headRow.appendChild(el('th', { style: 'text-align:center;padding:4px 6px;border-bottom:1px solid var(--border);font-weight:600;width:90px' }, 'Status'));
  }
  thead.appendChild(headRow);
  tbl.appendChild(thead);

  const tbody = el('tbody');
  // Use cfg.fields order so the panel matches the form layout. Fall back to
  // matrix order for any field not in cfg (rare).
  const orderedKeys = cfg.fields.map(f => f.key)
    .filter(k => matrix[k])
    .concat(Object.keys(matrix).filter(k => !cfg.fields.some(f => f.key === k)));
  const fieldLabels = Object.fromEntries(cfg.fields.map(f => [f.key, f.label]));

  let rCount = 0, cCount = 0;
  orderedKeys.forEach(fieldKey => {
    const tr = el('tr');
    const labelCell = el('td', { style: 'padding:4px 6px;border-bottom:1px solid var(--surface);color:var(--text)' },
      fieldLabels[fieldKey] || fieldKey);
    tr.appendChild(labelCell);

    if (showAllModes) {
      modes.forEach(m => {
        const code = matrix[fieldKey][m] || '—';
        tr.appendChild(rbmCodeCell(code));
      });
    } else {
      const code = matrix[fieldKey][filterMode] || '—';
      tr.appendChild(rbmCodeCell(code));
      if (code === 'R') rCount++;
      else if (code === 'C') cCount++;
    }
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody);
  wrap.appendChild(tbl);

  if (filterMode) {
    wrap.appendChild(el('div', { style: 'margin-top:8px;font-size:11px;color:var(--text-muted)' },
      `For ${filterMode} mode: ${rCount} required, ${cCount} conditional.`));
  }

  return wrap;
}

function rbmCodeCell(code) {
  const meta = RBM_CODE_META[code];
  const td = el('td', { style:
    'text-align:center;padding:4px 6px;border-bottom:1px solid var(--surface)' });
  if (!meta) {
    td.textContent = '—';
    td.style.color = 'var(--text-muted)';
    return td;
  }
  const chip = el('span', { style:
    `display:inline-block;width:22px;line-height:18px;border-radius:3px;` +
    `font-weight:700;font-size:11px;background:${meta.bg};color:${meta.color}`,
    title: meta.label }, code);
  td.appendChild(chip);
  return td;
}

// ─── print + module styles ──────────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById('dr-styles')) return;
  const style = document.createElement('style');
  style.id = 'dr-styles';
  style.textContent = `
/* ── controls bar ─────────────────────────────────────────── */
.dr-controls {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 0 16px;
  flex-wrap: wrap;
}
.dr-scope-nav { display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-start; }
.dr-scope-group { display: flex; flex-direction: column; gap: 4px; }
.dr-scope-group-label {
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1.2px;
  color: var(--color-text-muted);
  padding-left: 2px;
}
.dr-scope-btn-row { display: flex; gap: 3px; }
.dr-scope-btn {
  padding: 5px 12px;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  color: var(--color-text-secondary);
  transition: all .15s;
  white-space: nowrap;
}
.dr-scope-btn.active {
  background: var(--color-accent);
  color: #fff;
  border-color: var(--color-accent);
}
.dr-print-btn { margin-left: auto; }

/* Change-history button sits in the Supporting Evidence row but is an action,
   not a scope tab — set it apart with a dashed border and muted look. */
.dr-history-btn {
  border-style: dashed;
  color: var(--color-text-secondary);
  margin-left: 8px;
}
.dr-history-btn:hover {
  border-color: var(--color-accent);
  color: var(--color-accent);
}

/* ── miller columns (Relationships tab) ──────────────────── */
.dr-mc {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-top: 8px;
}
.dr-mc-col {
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-surface);
  display: flex;
  flex-direction: column;
  min-height: 360px;
  max-height: 60vh;
  overflow: hidden;
}
.dr-mc-col-title {
  padding: 8px 12px;
  background: var(--color-bg);
  border-bottom: 1px solid var(--color-border);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: var(--color-text-secondary);
  flex-shrink: 0;
}
.dr-mc-col-body {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}
.dr-mc-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 7px 8px;
  border-radius: 5px;
  margin-bottom: 2px;
  cursor: default;
  border: 1px solid transparent;
}
.dr-mc-item:hover { background: var(--color-bg); }
.dr-mc-item-active {
  background: var(--color-accent-light);
  border-color: var(--color-accent);
}
.dr-mc-item-left {
  flex: 1;
  min-width: 0;
}
.dr-mc-item-name {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  text-align: left;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-primary);
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dr-mc-item-name:hover { color: var(--color-accent); }
.dr-mc-item-secondary {
  font-size: 11px;
  color: var(--color-text-muted);
  margin-top: 2px;
}
.dr-mc-item-drill {
  font-size: 16px;
  text-decoration: none;
  padding: 2px 6px;
  border-radius: 4px;
  flex-shrink: 0;
}
.dr-mc-item-drill:hover { background: var(--color-accent); color: white; }
.dr-mc-empty {
  padding: 24px 12px;
  text-align: center;
  font-size: 12px;
  color: var(--color-text-faint);
  font-style: italic;
}
.dr-mc-note {
  padding: 8px 10px;
  margin-bottom: 8px;
  font-size: 11px;
  background: #fef3c7;
  color: #92400e;
  border-radius: 4px;
  border: 1px solid #fcd34d;
}

/* ── breadcrumb ──────────────────────────────────────────── */
.dr-breadcrumb {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  margin: 0 0 14px 0;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  font-size: 12px;
}
.dr-breadcrumb-prefix {
  color: var(--color-text-muted);
  font-weight: 600;
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0.5px;
}
.dr-breadcrumb-name { color: var(--color-text-primary); }
.dr-breadcrumb-sep  { color: var(--color-text-faint); }

/* ── drill links ─────────────────────────────────────────── */
.dr-drill-link {
  background: none;
  border: none;
  padding: 0;
  color: var(--color-accent);
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
  display: inline-block;
}
.dr-drill-link:hover { opacity: .75; }

/* ── use case meta footer ────────────────────────────────── */
.dr-uc-meta {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
  padding-top: 12px;
  margin-top: 4px;
  border-top: 1px solid var(--color-border);
}

/* ── provenance banner ───────────────────────────────────── */
.dr-provenance {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  background: #eff6ff;
  border-bottom: 1px solid #bfdbfe;
  font-size: 12px;
}
.dr-provenance-label { color: var(--color-text-muted); font-weight: 600; }
.dr-provenance-title { color: #1e40af; font-weight: 600; }

/* ── relationship tree ───────────────────────────────────── */
.dr-rel-tree {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 8px 0;
}
.dr-rel-uc-node {
  border: 1px solid var(--color-border);
  border-radius: 8px;
  overflow: hidden;
  border-left: 4px solid var(--color-accent);
}
.dr-rel-uc-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: var(--color-bg);
  flex-wrap: wrap;
}
.dr-rel-uc-title { font-weight: 700; font-size: 14px; flex: 1; }
.dr-rel-wf-node {
  padding: 10px 14px 10px 24px;
  border-top: 1px solid var(--color-border);
  background: var(--color-surface);
  border-left: 3px solid #bfdbfe;
  margin-left: 20px;
}
.dr-rel-wf-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.dr-rel-wf-name { font-weight: 600; font-size: 13px; flex: 1; }
.dr-rel-chips {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}
.dr-rel-chip-label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: .6px;
  color: var(--color-text-muted);
  min-width: 80px;
}
.dr-rel-chip { font-size: 11px !important; }
.dr-rel-no-wf {
  padding: 8px 14px;
  font-size: 12px;
  color: var(--color-text-muted);
  font-style: italic;
  border-top: 1px solid var(--color-border);
}
.dr-rel-tool-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg);
}

/* ── report container ────────────────────────────────────── */
.dr-report {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  overflow: hidden;
}

/* ── report header ───────────────────────────────────────── */
.dr-report-header {
  padding: 20px 28px 16px;
  border-bottom: 2px solid var(--color-accent);
  background: linear-gradient(135deg, #1e3a5f 0%, #1a4272 100%);
  color: #fff;
}
.dr-report-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  opacity: .7;
  margin-bottom: 6px;
}
.dr-report-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.dr-meta-app {
  font-size: 18px;
  font-weight: 700;
  color: #fff;
}
.dr-meta-sep { opacity: .4; }
.dr-meta-date { opacity: .65; font-size: 12px; margin-left: 4px; }

/* ── page break ──────────────────────────────────────────── */
.dr-page-break {
  height: 0;
  border-top: 2px dashed var(--color-border);
  margin: 8px 0;
}

/* ── agent section ───────────────────────────────────────── */
.dr-agent { padding: 24px 28px; }
.dr-agent + .dr-agent {
  border-top: 1px solid var(--color-border);
}
.dr-agent-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--color-border);
}
.dr-agent-name {
  font-size: 20px;
  font-weight: 700;
  color: var(--color-text-primary);
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10px;
}

/* Phase 1: slug badge (UC-001, WF-014, etc.) */
.dr-slug-badge {
  display: inline-flex;
  align-items: center;
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  font-size: 11px;
  font-weight: 600;
  color: #475569;
  background: #f1f5f9;
  border: 1px solid #cbd5e1;
  border-radius: 4px;
  padding: 2px 6px;
  letter-spacing: 0.3px;
  flex-shrink: 0;
}

/* ── subsection ──────────────────────────────────────────── */
.dr-subsection {
  margin-bottom: 20px;
}
.dr-subsection-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: var(--color-accent);
  margin-bottom: 8px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--color-border);
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.dr-subsection-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: .8px;
  color: var(--color-text-muted);
  margin-bottom: 6px;
}

/* ── two-column layout ───────────────────────────────────── */
.dr-two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-bottom: 20px;
}

/* ── key-value grid ──────────────────────────────────────── */
.dr-kv-grid { display: flex; flex-direction: column; gap: 6px; }
.dr-kv-row { display: grid; grid-template-columns: 140px 1fr; gap: 8px; align-items: start; }
.dr-kv-compact .dr-kv-row { grid-template-columns: 120px 1fr; }
.dr-kv-key {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
  padding-top: 1px;
}
.dr-kv-val { font-size: 13px; color: var(--color-text-primary); }

/* ── prose ───────────────────────────────────────────────── */
.dr-prose {
  font-size: 13px;
  line-height: 1.65;
  color: var(--color-text-primary);
  white-space: pre-wrap;
  margin: 0;
}

/* ── lists ───────────────────────────────────────────────── */
.dr-bullet-list, .dr-numbered-list {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--color-text-primary);
}
.dr-micro-list {
  margin: 0;
  padding-left: 14px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--color-text-secondary);
}
.dr-muted { color: var(--color-text-muted); font-style: italic; font-size: 12px; }

/* ── I/O table ───────────────────────────────────────────── */
.dr-io-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.dr-io-key {
  padding: 3px 10px 3px 0;
  font-weight: 600;
  white-space: nowrap;
  vertical-align: top;
  color: var(--color-text-secondary);
  width: 1px;
}
.dr-io-desc {
  padding: 3px 0;
  color: var(--color-text-primary);
  vertical-align: top;
}
.dr-io-label {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .8px;
  color: var(--color-text-muted);
  margin-bottom: 4px;
}

/* ── data table ──────────────────────────────────────────── */
.dr-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.dr-table thead th {
  padding: 7px 10px;
  background: var(--color-bg);
  border-bottom: 1px solid var(--color-border);
  text-align: left;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: .6px;
}
.dr-table tbody td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--color-border);
  vertical-align: top;
}
.dr-table tbody tr:last-child td { border-bottom: none; }
.dr-step-num {
  font-weight: 700;
  color: var(--color-accent);
  font-size: 13px;
  text-align: center;
}
.dr-step-name { font-weight: 600; }

/* ── tool cards ──────────────────────────────────────────── */
.dr-tool-grid { display: flex; flex-direction: column; gap: 12px; }
.dr-tool-card {
  border: 1px solid var(--color-border);
  border-radius: 8px;
  overflow: hidden;
}
.dr-tool-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: var(--color-bg);
  border-bottom: 1px solid var(--color-border);
}
.dr-tool-name { font-weight: 700; font-size: 13px; font-family: monospace; flex: 1; }
.dr-tool-desc {
  margin: 0;
  padding: 8px 14px;
  font-size: 12px;
  color: var(--color-text-secondary);
  border-bottom: 1px solid var(--color-border);
  line-height: 1.5;
}
.dr-tool-io {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0;
}
.dr-tool-io-box {
  padding: 10px 14px;
  border-right: 1px solid var(--color-border);
}
.dr-tool-io-box:last-child { border-right: none; }
.dr-tool-footer {
  padding: 8px 14px;
  background: #fffbeb;
  border-top: 1px solid var(--color-border);
}

/* ── guardrails ──────────────────────────────────────────── */
.dr-guardrail-list { display: flex; flex-direction: column; gap: 8px; }
.dr-guardrail-item {
  padding: 10px 14px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  border-left: 3px solid var(--color-accent);
  background: var(--color-bg);
}
.dr-guardrail-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.dr-guardrail-id { font-weight: 700; font-size: 12px; font-family: monospace; color: var(--color-accent); }
.dr-guardrail-name { font-weight: 600; font-size: 13px; flex: 1; }
.dr-guardrail-desc { margin: 0; font-size: 13px; color: var(--color-text-primary); line-height: 1.5; }
.dr-guardrail-badge {
  font-size: 10px;
  font-weight: 700;
  padding: 2px 7px;
  border-radius: 10px;
  text-transform: uppercase;
  letter-spacing: .5px;
}
.badge-hard { background: #fee2e2; color: #991b1b; }
.badge-soft { background: #fef3c7; color: #92400e; }

/* ── risks ───────────────────────────────────────────────── */
.dr-risk-list { display: flex; flex-direction: column; gap: 8px; }
.dr-risk-item { display: flex; gap: 10px; align-items: start; }
.dr-risk-num {
  min-width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #fee2e2;
  color: #991b1b;
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 1px;
}
.dr-risk-text { font-size: 13px; color: var(--color-text-primary); }
.dr-risk-mit { font-size: 12px; color: #065f46; margin-top: 3px; padding-left: 10px; border-left: 2px solid #34d399; }

/* ── step flow ───────────────────────────────────────────── */
.dr-step-flow { display: flex; flex-direction: column; align-items: stretch; gap: 0; }
.dr-step-connector {
  text-align: center;
  font-size: 16px;
  color: var(--color-text-muted);
  padding: 3px 0;
  line-height: 1;
  user-select: none;
}
.dr-step-card {
  border: 1px solid var(--color-border);
  border-radius: 8px;
  overflow: hidden;
  border-left: 3px solid var(--color-accent);
}
.dr-step-card-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: var(--color-bg);
  border-bottom: 1px solid var(--color-border);
  flex-wrap: wrap;
}
.dr-step-number {
  min-width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--color-accent);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.dr-step-card-name { font-weight: 700; font-size: 14px; flex: 1; }
.dr-step-card-meta {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-left: auto;
  flex-wrap: wrap;
}
/* ── item-level edit button (goals, errors, risks, etc.) ── */
.dr-item-edit-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 12px;
  opacity: 0;
  padding: 2px 4px;
  border-radius: 4px;
  transition: opacity 0.15s;
  flex-shrink: 0;
}
.dr-risk-item:hover .dr-item-edit-btn,
.dr-numbered-list li:hover .dr-item-edit-btn,
.dr-bullet-list li:hover .dr-item-edit-btn {
  opacity: 1;
}
.dr-numbered-list li,
.dr-bullet-list li { display: flex; align-items: flex-start; gap: 4px; }
.dr-numbered-list li span,
.dr-bullet-list li span { flex: 1; }
.dr-risk-item { position: relative; }
.dr-risk-item .dr-item-edit-btn { position: absolute; top: 6px; right: 6px; }

.dr-step-decisions {
  padding: 8px 14px;
  background: #fefce8;
  border-top: 1px solid #fef08a;
}

/* ── HITL card ───────────────────────────────────────────── */
.dr-hitl-card {
  border: 1px solid #f59e0b;
  border-radius: 8px;
  padding: 12px 16px;
  background: #fffbeb;
  margin-bottom: 10px;
}
.dr-hitl-card:last-child { margin-bottom: 0; }
.dr-hitl-header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

/* ── tool name heading ───────────────────────────────────── */
.dr-tool-name-code {
  font-family: monospace;
  font-size: 18px;
  font-weight: 700;
  color: var(--color-text-primary);
}

/* ── inline code ─────────────────────────────────────────── */
.dr-code {
  font-family: monospace;
  font-size: 12px;
  background: var(--color-bg);
  padding: 2px 6px;
  border-radius: 3px;
  border: 1px solid var(--color-border);
  word-break: break-all;
}

/* ── source doc view/find buttons ────────────────────────── */
.dr-doc-view-btn {
  margin-left: auto;
  padding: 4px 10px;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 5px;
  color: #1e40af;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
}
.dr-doc-view-btn:hover { background: #dbeafe; }

.dr-doc-find-btn {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px 7px;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 4px;
  color: #1e40af;
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  margin-top: 4px;
}
.dr-doc-find-btn:hover { background: #dbeafe; }

/* ── source document drawer ──────────────────────────────── */
.dr-doc-overlay {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.32);
  z-index: 999;
}
.dr-doc-overlay.open { display: block; }

.dr-doc-drawer {
  position: fixed;
  top: 0;
  right: 0;
  height: 100vh;
  width: 560px;
  max-width: 90vw;
  background: var(--color-surface);
  border-left: 1px solid var(--color-border);
  box-shadow: -4px 0 28px rgba(0,0,0,0.16);
  z-index: 1000;
  display: flex;
  flex-direction: column;
  transform: translateX(100%);
  transition: transform .24s ease;
}
.dr-doc-drawer.open { transform: translateX(0); }

.dr-doc-drawer-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 16px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg);
  flex-shrink: 0;
}
.dr-doc-drawer-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--color-text-primary);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dr-doc-close {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 14px;
  color: var(--color-text-muted);
  padding: 4px 6px;
  border-radius: 4px;
  flex-shrink: 0;
  line-height: 1;
}
.dr-doc-close:hover { background: var(--color-border); color: var(--color-text-primary); }

.dr-doc-search-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
  flex-shrink: 0;
}
.dr-doc-search {
  flex: 1;
  padding: 5px 8px;
  border: 1px solid var(--color-border);
  border-radius: 5px;
  font-size: 12px;
  background: var(--color-bg);
  color: var(--color-text-primary);
  outline: none;
}
.dr-doc-search:focus { border-color: var(--color-accent); }
.dr-doc-match-count {
  font-size: 11px;
  color: var(--color-text-muted);
  white-space: nowrap;
  min-width: 68px;
  text-align: right;
}
.dr-doc-search-clear {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 12px;
  color: var(--color-text-muted);
  padding: 3px 6px;
  border-radius: 4px;
  line-height: 1;
}
.dr-doc-search-clear:hover { background: var(--color-border); color: var(--color-text-primary); }

.dr-doc-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px 40px;
}

/* rendered markdown */
.dr-doc-md h1 { font-size: 19px; font-weight: 700; margin: 4px 0 12px; color: var(--color-text-primary); border-bottom: 2px solid var(--color-border); padding-bottom: 7px; }
.dr-doc-md h2 { font-size: 16px; font-weight: 700; margin: 20px 0 8px; color: var(--color-text-primary); border-bottom: 1px solid var(--color-border); padding-bottom: 5px; }
.dr-doc-md h3 { font-size: 14px; font-weight: 700; margin: 16px 0 5px; color: var(--color-accent); }
.dr-doc-md h4 { font-size: 13px; font-weight: 700; margin: 12px 0 4px; color: var(--color-text-secondary); }
.dr-doc-md p  { font-size: 13px; line-height: 1.65; margin: 3px 0 7px; color: var(--color-text-primary); }
.dr-doc-md ul, .dr-doc-md ol { font-size: 13px; padding-left: 20px; margin: 3px 0 8px; }
.dr-doc-md li { line-height: 1.6; margin: 2px 0; }
.dr-doc-md code { font-family: monospace; font-size: 12px; background: #f0f4f8; padding: 1px 4px; border-radius: 3px; color: #be185d; }
.dr-doc-md pre { background: #f8fafc; border: 1px solid var(--color-border); border-radius: 6px; padding: 12px; overflow-x: auto; margin: 8px 0; }
.dr-doc-md pre code { background: none; padding: 0; color: var(--color-text-primary); font-size: 12px; }
.dr-doc-md hr { border: none; border-top: 1px solid var(--color-border); margin: 14px 0; }
.dr-doc-md strong { font-weight: 700; }
.dr-doc-md em { font-style: italic; }
.dr-doc-md blockquote { border-left: 3px solid var(--color-accent); margin: 6px 0; padding: 4px 12px; background: #f0f4ff; border-radius: 0 4px 4px 0; }
.dr-doc-md blockquote p { margin: 0; color: var(--color-text-secondary); }
.dr-doc-md table.dr-md-table { border-collapse: collapse; width: 100%; font-size: 12px; margin: 8px 0 12px; }
.dr-doc-md table.dr-md-table th { background: var(--color-bg); border: 1px solid var(--color-border); padding: 5px 8px; text-align: left; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: var(--color-text-muted); }
.dr-doc-md table.dr-md-table td { border: 1px solid var(--color-border); padding: 5px 8px; }

/* search highlight */
mark.dr-doc-highlight {
  background: #fde68a;
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}

/* ── Phase 2 row controls ────────────────────────────────── */
.dr-subsection-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.dr-row-add-btn {
  padding: 3px 9px;
  font-size: 11px;
  font-weight: 600;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 5px;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all .15s;
}
.dr-row-add-btn:hover { background: var(--color-accent); color: #fff; border-color: var(--color-accent); }
.dr-row-icon-btn {
  padding: 2px 5px;
  font-size: 11px;
  background: none;
  border: none;
  cursor: pointer;
  opacity: .5;
  transition: opacity .15s;
}
.dr-row-icon-btn:hover { opacity: 1; }
.dr-rasic-cell { transition: background .1s; border-radius: 4px; }
.dr-rasic-cell:hover { background: var(--color-surface-raised, #f0f4ff); }

/* ── RASIC popover ───────────────────────────────────────── */
.dr-rasic-popover {
  position: fixed;
  z-index: 9999;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0,0,0,.18);
  padding: 10px 14px 12px;
  min-width: 200px;
}
.dr-rasic-popover-title {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .8px;
  color: var(--color-text-muted);
  margin-bottom: 8px;
  line-height: 1.3;
}
.dr-rasic-popover-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 12px;
  cursor: pointer;
}
.dr-rasic-popover-row label { cursor: pointer; flex: 1; }
.dr-rasic-popover-row input[type=checkbox] { cursor: pointer; }

/* ── delete button in modals ─────────────────────────────── */
.dr-delete-btn { color: var(--color-error, #c0392b) !important; margin-right: auto; }
.dr-edit-checkbox-row { flex-direction: row !important; gap: 8px; align-items: center; }
.dr-edit-checkbox-row label { margin: 0; }

/* ── Phase 3: agent card tables ──────────────────────────── */
.dr-compact-table { border-collapse: collapse; font-size: 12px; }
.dr-compact-table th, .dr-compact-table td { padding: 4px 8px; border-bottom: 1px solid var(--color-border); text-align: left; }
.dr-compact-table th { font-weight: 600; font-size: 11px; color: var(--color-text-muted); background: var(--color-surface); }
.dr-compact-table tr:last-child td { border-bottom: none; }
.dr-empty-note { font-size: 12px; color: var(--color-text-muted); font-style: italic; padding: 8px 0; margin: 0; }

/* ── edit button ─────────────────────────────────────────── */
.dr-edit-btn {
  padding: 4px 10px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 5px;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary);
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition: all .15s;
}
.dr-edit-btn:hover {
  background: var(--color-accent);
  color: #fff;
  border-color: var(--color-accent);
}

/* ── edit modal overlay ──────────────────────────────────── */
.dr-edit-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.42);
  z-index: 1100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.dr-edit-modal {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.28);
  width: 560px;
  max-width: 100%;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.dr-edit-modal-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg);
  flex-shrink: 0;
}
.dr-edit-modal-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--color-text-primary);
  flex: 1;
}
.dr-edit-modal-subtitle {
  font-size: 12px;
  color: var(--color-text-muted);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dr-edit-close {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 14px;
  color: var(--color-text-muted);
  padding: 4px 6px;
  border-radius: 4px;
  line-height: 1;
  flex-shrink: 0;
}
.dr-edit-close:hover { background: var(--color-border); color: var(--color-text-primary); }

.dr-edit-banner {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 20px;
  background: #eff6ff;
  border-bottom: 1px solid #bfdbfe;
  font-size: 12px;
  color: #1e40af;
  flex-shrink: 0;
}
.dr-edit-banner-icon { font-size: 14px; }

.dr-edit-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.dr-edit-field-group { display: flex; flex-direction: column; gap: 5px; }
.dr-edit-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
  letter-spacing: .3px;
}
.dr-edit-input {
  width: 100%;
  box-sizing: border-box;
  padding: 7px 10px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  font-size: 13px;
  color: var(--color-text-primary);
  background: var(--color-bg);
  outline: none;
  font-family: inherit;
  transition: border-color .15s;
}
.dr-edit-input:focus { border-color: var(--color-accent); }
.dr-edit-textarea { resize: vertical; min-height: 72px; line-height: 1.5; }
.dr-edit-select { cursor: pointer; }
.dr-edit-json {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.dr-edit-help {
  font-size: 11px;
  color: var(--color-text-muted);
  margin-top: -2px;
  margin-bottom: 2px;
}

.dr-edit-error {
  margin: 0 20px;
  padding: 9px 12px;
  background: #fee2e2;
  border: 1px solid #fca5a5;
  border-radius: 6px;
  font-size: 12px;
  color: #991b1b;
  flex-shrink: 0;
}

.dr-edit-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 12px 20px;
  border-top: 1px solid var(--color-border);
  background: var(--color-bg);
  flex-shrink: 0;
}

/* ── print ───────────────────────────────────────────────── */
@media print {
  .sidebar, .app-topbar, .module-header, .dr-controls { display: none !important; }
  .main-content { padding: 0 !important; overflow: visible !important; }
  .dr-report { border: none !important; border-radius: 0 !important; }
  .dr-page-break { page-break-after: always; border: none !important; height: 0 !important; }
  .dr-tool-card, .dr-guardrail-item { break-inside: avoid; }
  .dr-agent { break-inside: avoid-page; }
  .dr-doc-drawer, .dr-doc-overlay, .dr-edit-btn { display: none !important; }
  a { color: inherit !important; text-decoration: none !important; }
}

/* Feature #9 — Quality reviewer + CP audit-trail panels */
.dr-quality-panel, .dr-cp-panel { margin: 12px 0; }
.dr-panel-card {
  border: 1px solid var(--border, #ddd);
  border-radius: 6px;
  background: var(--surface, #fff);
}
.dr-panel-head {
  display:flex; align-items:center; gap:10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border, #eee);
  font-weight: 600;
  cursor: pointer;
  user-select: none;
}
.dr-panel-head:hover { background: var(--surface-secondary, #fafafa); }
.dr-panel-head .dr-chev { transition: transform 0.15s ease; }
.dr-panel-collapsed .dr-panel-head .dr-chev { transform: rotate(-90deg); }
.dr-panel-collapsed .dr-panel-body { display: none; }
.dr-panel-body { padding: 10px 14px; }
.dr-panel-count {
  margin-left: auto;
  font-size: 12px; color: var(--text-muted, #666);
}
.dr-finding-row, .dr-cp-row {
  display: grid; align-items: center; gap: 8px;
  padding: 6px 0;
  border-bottom: 1px dashed var(--border, #eee);
}
.dr-finding-row { grid-template-columns: 70px 100px 1fr auto; }
.dr-cp-row { grid-template-columns: 160px 1fr auto; cursor: pointer; }
.dr-cp-row:hover { background: var(--surface-secondary, #fafafa); }
.dr-finding-row:last-child, .dr-cp-row:last-child { border-bottom: none; }
.dr-finding-cat, .dr-finding-sev {
  display:inline-block; padding: 2px 6px; border-radius: 4px;
  font-size: 11px; font-weight: 600;
}
.dr-finding-cat.missing      { background:#ffebee; color:#c62828; }
.dr-finding-cat.incomplete   { background:#fff3e0; color:#e65100; }
.dr-finding-cat.inconsistent { background:#fff8e1; color:#a16400; }
.dr-finding-cat.conflicting  { background:#fce4ec; color:#ad1457; }
.dr-finding-sev.high { background:#ffebee; color:#c62828; }
.dr-finding-sev.med  { background:#fff3e0; color:#e65100; }
.dr-finding-sev.low  { background:#e8f5e9; color:#2e7d32; }
.dr-finding-meta {
  font-size: 11px; color: var(--text-muted, #666); margin-top: 2px;
}
.dr-filter-row {
  display:flex; gap: 6px; flex-wrap: wrap;
  margin-bottom: 8px;
  font-size: 12px;
}
.dr-filter-chip {
  padding: 3px 8px;
  border: 1px solid var(--border, #ddd);
  border-radius: 12px;
  background: var(--surface, #fff);
  cursor: pointer;
}
.dr-filter-chip.active { background: var(--primary, #1976d2); color: #fff; border-color: transparent; }
.dr-cp-search {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--border, #ddd);
  border-radius: 4px;
  margin-bottom: 8px;
  font-size: 13px;
}
  `;
  document.head.appendChild(style);
}

// ─── Feature #9: Per-card Audit button ──────────────────────────────────────
function buildAuditBtn(entityType, entityId, reload) {
  const btn = el('button', {
    className: 'dr-edit-btn',
    title: 'Audit this entity (quality review by AI auditor)',
    type: 'button',
  }, '✨ Audit');
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!_currentProjectId) { showToast('No application selected.', 'warning'); return; }
    btn.disabled = true;
    btn.textContent = '⏳ Auditing…';
    try {
      const result = await apiFetch(
        `/projects/${_currentProjectId}/quality-review/entity/${entityType}/${entityId}`,
        { method: 'POST', body: JSON.stringify({}) }
      );
      const n = (result.findings || []).length;
      const src = result.source === 'claude' ? 'Claude' : 'stub';
      showToast(`Audit complete — ${n} finding${n === 1 ? '' : 's'} (${src})`,
        result.source === 'claude' ? 'success' : 'info');
      if (reload) reload();
      if (_qualityPanel && _currentProjectId)   await renderQualityPanel(_qualityPanel, _currentProjectId);
    } catch (err) {
      showToast('Audit failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '✨ Audit';
    }
  });
  return btn;
}

// ─── Feature #9: Quality findings panel ─────────────────────────────────────
// Renders into `container`. Tracks its own filter state on the DOM node.
async function renderQualityPanel(container, projectId) {
  container.innerHTML = '';
  if (!projectId) return;
  // Filter state stashed on the node so re-renders preserve it
  const filterState = container._filter ||= { category: null, includeResolved: false };

  const card = el('div', { className: 'dr-panel-card' });
  if (container._collapsed) card.classList.add('dr-panel-collapsed');

  const head = el('div', { className: 'dr-panel-head' });
  head.appendChild(el('span', { className: 'dr-chev' }, '▾'));
  head.appendChild(el('span', {}, 'Quality findings'));
  const countEl = el('span', { className: 'dr-panel-count' }, '…');
  head.appendChild(countEl);
  head.addEventListener('click', () => {
    container._collapsed = !card.classList.toggle('dr-panel-collapsed') ? false : true;
  });
  card.appendChild(head);

  const body = el('div', { className: 'dr-panel-body' });
  card.appendChild(body);
  container.appendChild(card);

  // Filter chips
  const filterRow = el('div', { className: 'dr-filter-row' });
  body.appendChild(filterRow);

  const list = el('div');
  body.appendChild(list);

  async function reload() {
    list.innerHTML = '<div style="color:#666;font-size:12px">Loading…</div>';
    const params = new URLSearchParams({
      project_id: projectId,
      detected_by: 'quality-reviewer',
    });
    if (!filterState.includeResolved) params.append('status', 'open');
    if (filterState.category) params.append('finding_category', filterState.category);
    let rows = [];
    try {
      rows = await apiFetch(`/exceptions?${params.toString()}`);
    } catch (err) {
      list.innerHTML = `<div style="color:#c62828;font-size:12px">Failed to load: ${escHtml(err.message)}</div>`;
      countEl.textContent = '—';
      return;
    }
    countEl.textContent = `${rows.length} ${filterState.includeResolved ? 'total' : 'open'}`;
    list.innerHTML = '';
    if (rows.length === 0) {
      list.appendChild(el('div', { style: 'color:#666;font-size:12px;padding:10px 0' },
        'No quality findings. Use the ✨ Audit buttons to run a review.'));
      return;
    }
    // Group by entity for compactness
    const byEntity = {};
    for (const r of rows) {
      const key = `${r.related_entity_type}/${r.related_entity_id}`;
      (byEntity[key] ||= { type: r.related_entity_type, id: r.related_entity_id, rows: [] }).rows.push(r);
    }
    for (const k of Object.keys(byEntity)) {
      const grp = byEntity[k];
      const grpHdr = el('div', { style: 'font-weight:600;font-size:12px;margin:10px 0 4px;color:var(--text-muted,#666)' },
        `${grp.type.replace('_',' ')} · ${grp.id}`);
      list.appendChild(grpHdr);
      for (const r of grp.rows) {
        const row = el('div', { className: 'dr-finding-row' });
        row.appendChild(el('span', { className: `dr-finding-sev ${r.severity}` }, r.severity.toUpperCase()));
        row.appendChild(el('span', { className: `dr-finding-cat ${r.finding_category || 'incomplete'}` },
          (r.finding_category || 'incomplete').toUpperCase()));
        const middle = el('div');
        middle.appendChild(el('div', {}, r.description || '(no description)'));
        const meta = el('div', { className: 'dr-finding-meta' });
        if (r.field_name) meta.appendChild(el('span', {}, `field: ${r.field_name}`));
        if (r.suggested_action) {
          if (r.field_name) meta.appendChild(document.createTextNode(' · '));
          meta.appendChild(el('span', {}, `→ ${r.suggested_action}`));
        }
        if (meta.childNodes.length) middle.appendChild(meta);
        row.appendChild(middle);
        const actions = el('div', { style: 'display:flex;gap:4px' });
        if (r.status === 'open') {
          const resolveBtn = el('button', { className: 'btn btn-sm btn-ghost', title: 'Mark resolved' }, 'Resolve');
          resolveBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await apiFetch(`/exceptions/${r.exception_id}`, {
              method: 'PUT',
              body: JSON.stringify({ status: 'resolved', resolution_summary: 'Resolved manually' })
            });
            await reload();
          });
          actions.appendChild(resolveBtn);
          const dismissBtn = el('button', { className: 'btn btn-sm btn-ghost', title: 'Dismiss (won\'t fix)' }, 'Dismiss');
          dismissBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await apiFetch(`/exceptions/${r.exception_id}`, {
              method: 'PUT',
              body: JSON.stringify({ status: 'deferred', resolution_summary: 'Dismissed' })
            });
            await reload();
          });
          actions.appendChild(dismissBtn);
        } else {
          actions.appendChild(el('span', { style: 'font-size:11px;color:var(--text-muted,#666)' }, r.status));
        }
        row.appendChild(actions);
        list.appendChild(row);
      }
    }
  }

  // Build filter chips (after reload is defined so handlers close over it)
  const cats = ['missing', 'incomplete', 'inconsistent', 'conflicting'];
  const allChip = el('button', { className: 'dr-filter-chip' + (filterState.category ? '' : ' active') }, 'All categories');
  allChip.addEventListener('click', () => { filterState.category = null; renderQualityPanel(container, projectId); });
  filterRow.appendChild(allChip);
  for (const c of cats) {
    const chip = el('button', { className: 'dr-filter-chip' + (filterState.category === c ? ' active' : '') }, c);
    chip.addEventListener('click', () => { filterState.category = c; renderQualityPanel(container, projectId); });
    filterRow.appendChild(chip);
  }
  const resolvedChip = el('button', { className: 'dr-filter-chip' + (filterState.includeResolved ? ' active' : '') }, 'Include resolved');
  resolvedChip.addEventListener('click', () => { filterState.includeResolved = !filterState.includeResolved; renderQualityPanel(container, projectId); });
  filterRow.appendChild(resolvedChip);

  await reload();
}

// ─── Change history modal ───────────────────────────────────────────────────
// Opened from the "🕘 Change history" button in the Supporting Evidence group.
// Hosts the change-history panel in an overlay so it stays out of the way.
function openCpHistoryModal(projectId) {
  const overlay = el('div', { className: 'dr-edit-overlay' });
  const modal = el('div', { className: 'dr-edit-modal', style: 'max-width:780px' });
  const hdr = el('div', { className: 'dr-edit-header' });
  hdr.appendChild(el('h3', { className: 'dr-edit-title' }, 'Change history'));
  const closeBtn = el('button', { className: 'dr-edit-close' }, '×');
  closeBtn.addEventListener('click', () => overlay.remove());
  hdr.appendChild(closeBtn);
  modal.appendChild(hdr);

  const panel = el('div', { className: 'dr-cp-panel' });
  modal.appendChild(panel);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) overlay.remove(); });

  renderCpHistoryPanel(panel, projectId).catch(err => {
    panel.innerHTML = `<div style="color:#c62828;font-size:12px">Failed to load: ${escHtml(err.message)}</div>`;
  });
}

// ─── Feature #9: Change history panel ───────────────────────────────────────
async function renderCpHistoryPanel(container, projectId) {
  container.innerHTML = '';
  if (!projectId) return;
  const state = container._state ||= { q: '', offset: 0, limit: 20, rows: [] };

  const card = el('div', { className: 'dr-panel-card' });
  if (container._collapsed) card.classList.add('dr-panel-collapsed');
  const head = el('div', { className: 'dr-panel-head' });
  head.appendChild(el('span', { className: 'dr-chev' }, '▾'));
  head.appendChild(el('span', {}, 'Change history'));
  const countEl = el('span', { className: 'dr-panel-count' }, '…');
  head.appendChild(countEl);
  head.addEventListener('click', () => {
    container._collapsed = !card.classList.toggle('dr-panel-collapsed') ? false : true;
  });
  card.appendChild(head);
  const body = el('div', { className: 'dr-panel-body' });
  card.appendChild(body);
  container.appendChild(card);

  const searchInput = el('input', { type: 'text', className: 'dr-cp-search',
    placeholder: 'Search by summary or entity slug…', value: state.q });
  body.appendChild(searchInput);
  const list = el('div');
  body.appendChild(list);
  const loadMoreBtn = el('button', { className: 'btn btn-sm btn-ghost', style: 'margin-top:8px;width:100%' }, 'Load older');
  body.appendChild(loadMoreBtn);

  async function loadPage(reset = false) {
    if (reset) { state.offset = 0; state.rows = []; }
    const params = new URLSearchParams({
      limit: String(state.limit),
      offset: String(state.offset),
    });
    if (state.q) params.append('q', state.q);
    let rows = [];
    try {
      rows = await apiFetch(`/projects/${projectId}/change-packets?${params.toString()}`);
    } catch (err) {
      list.innerHTML = `<div style="color:#c62828;font-size:12px">Failed to load: ${escHtml(err.message)}</div>`;
      return;
    }
    state.rows.push(...rows);
    state.offset += rows.length;
    countEl.textContent = `${state.rows.length} CP${state.rows.length === 1 ? '' : 's'}`;
    if (reset) list.innerHTML = '';
    if (state.rows.length === 0) {
      list.appendChild(el('div', { style: 'color:#666;font-size:12px;padding:10px 0' },
        'No change packets yet. Edit an entity to create one.'));
      loadMoreBtn.style.display = 'none';
      return;
    }
    for (const cp of rows) {
      const row = el('div', { className: 'dr-cp-row' });
      const ts = cp.created_at ? new Date(cp.created_at).toLocaleString() : '—';
      row.appendChild(el('span', { style: 'font-family:monospace;font-size:11px;color:var(--text-muted,#666)' }, ts));
      const mid = el('div');
      mid.appendChild(el('div', { style: 'font-size:13px' }, cp.summary || cp.packet_code || cp.change_packet_id));
      if (cp.packet_code) mid.appendChild(el('div', { style: 'font-size:10px;color:var(--text-muted,#666);font-family:monospace' }, cp.packet_code));
      row.appendChild(mid);
      const chip = el('span', { className: 'dr-finding-cat incomplete' },
        `${cp.entity_count || (cp.items || []).length} ${(cp.entity_count || (cp.items || []).length) === 1 ? 'entity' : 'entities'}`);
      row.appendChild(chip);
      row.addEventListener('click', () => openCpDetailModal(cp.change_packet_id));
      list.appendChild(row);
    }
    loadMoreBtn.style.display = rows.length < state.limit ? 'none' : '';
  }

  let searchTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = searchInput.value.trim();
      loadPage(true);
    }, 250);
  });
  loadMoreBtn.addEventListener('click', () => loadPage(false));

  await loadPage(true);
}

// ─── CP detail modal ────────────────────────────────────────────────────────
async function openCpDetailModal(cpId) {
  let cp;
  try {
    cp = await apiFetch(`/change-packets/${cpId}`);
  } catch (err) {
    showToast('Failed to load CP: ' + err.message, 'error');
    return;
  }
  const overlay = el('div', { className: 'dr-edit-overlay' });
  const modal = el('div', { className: 'dr-edit-modal', style: 'max-width:780px' });
  const hdr = el('div', { className: 'dr-edit-header' });
  hdr.appendChild(el('h3', { className: 'dr-edit-title' }, `Change Packet — ${cp.packet_code || cp.change_packet_id}`));
  const closeBtn = el('button', { className: 'dr-edit-close' }, '×');
  closeBtn.addEventListener('click', () => overlay.remove());
  hdr.appendChild(closeBtn);
  modal.appendChild(hdr);

  modal.appendChild(el('div', { style: 'margin-bottom:8px' }, cp.summary || ''));
  const meta = el('div', { style: 'font-size:11px;color:var(--text-muted,#666);margin-bottom:12px' });
  meta.appendChild(document.createTextNode(`status: ${cp.status} · `));
  meta.appendChild(document.createTextNode(`created: ${cp.created_at ? new Date(cp.created_at).toLocaleString() : '—'}`));
  modal.appendChild(meta);

  const items = cp.items || [];
  if (items.length === 0) {
    modal.appendChild(el('div', { style: 'color:#666' }, 'No items in this change packet.'));
  } else {
    const table = el('table', { className: 'dr-compact-table', style: 'width:100%;font-size:12px' });
    const thead = el('thead');
    thead.appendChild(el('tr', {},
      el('th', {}, 'Entity'),
      el('th', {}, 'Field'),
      el('th', {}, 'Before'),
      el('th', {}, 'After'),
    ));
    table.appendChild(thead);
    const tbody = el('tbody');
    for (const it of items) {
      const tr = el('tr');
      tr.appendChild(el('td', {}, `${it.entity_type} · ${it.entity_id}`));
      tr.appendChild(el('td', { style: 'font-family:monospace' }, it.field_path));
      tr.appendChild(el('td', { style: 'max-width:200px;overflow:hidden;text-overflow:ellipsis' },
        truncateStr(it.old_value, 80)));
      tr.appendChild(el('td', { style: 'max-width:200px;overflow:hidden;text-overflow:ellipsis' },
        truncateStr(it.new_value, 80)));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    modal.appendChild(table);
  }

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) overlay.remove(); });
}

function truncateStr(s, n) {
  if (s == null) return '';
  const str = typeof s === 'string' ? s : String(s);
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}
