// agent/entity-registry.js
//
// SINGLE SOURCE OF TRUTH for the design-entity types the Workbench understands.
// Everything that needs to know "what entity types exist and how they map to
// tables" reads from here:
//   - claude-processor.js   builds the Claude extraction tools + tool→entity map
//   - claude-processor.js   builds the "existing design" summary for conflict detection
//   - server.js  /promote   resolves target slugs + records create/update/delete items
//   - server.js  applyChangePacket()  materializes approved items into the real tables
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW TO ADD A NEW DESIGN TYPE (e.g. form/screen design, data design, report design)
// ─────────────────────────────────────────────────────────────────────────────
//   1. Add the real table to schema.sql AND a `CREATE TABLE IF NOT EXISTS …`
//      migration in db.js (so existing DBs get it). Give it the standard
//      columns: <pk>, project_id, slug, name, …, created_by/at, updated_by/at,
//      version, lifecycle_status.
//   2. Add ONE entry to REGISTRY below with: entity_type, tool def, table, pk,
//      slugPrefix, order, nameKeys, fieldMap, parentLinks, materializable:true.
//   3. (Optional) add a slug index + backfill spec in db.js.
//   That's it — extraction, promotion, conflict detection and materialization
//   all pick the new type up automatically. No edits to claude-processor.js,
//   /promote, or applyChangePacket() are needed.
//
// `materializable:false` types (guardrail, user_story, data_source, …) are still
// extracted and promoted as Change-Packet items for human review, but have no
// destination table yet, so the materializer skips them cleanly.
//
'use strict';

// ── Common fields merged into EVERY extraction tool ───────────────────────────
// These drive conflict detection (create vs update vs delete) and honest
// self-assessment. They live in entity_data JSON but are NEVER written as columns
// (they are not in any fieldMap), so they ride along for the UI/audit only.
const COMMON_TOOL_FIELDS = {
  operation: {
    type: 'string',
    enum: ['create', 'update', 'delete'],
    description: 'create = a brand-new entity; update = change an EXISTING one (set target_slug); ' +
      'delete = remove an EXISTING one (set target_slug). Defaults to create.',
  },
  target_slug: {
    type: 'string',
    description: 'The slug of the existing entity to update or delete (e.g. UC-003, WF-014). ' +
      'REQUIRED when operation is update or delete. Leave empty for create. ' +
      'Must be a slug shown in the "existing design" list — never invent one.',
  },
  conflict_classification: {
    type: 'string',
    enum: ['net_new', 'modifies_existing', 'deletes_existing'],
    description: 'How this relates to the existing design.',
  },
  conflict_rationale: {
    type: 'string',
    description: 'One sentence: why this is net-new vs a modification/deletion of an existing entity.',
  },
  confidence: {
    type: 'number', minimum: 0, maximum: 1,
    description: 'Your confidence in this extraction (0–1).',
  },
  confidence_notes: {
    type: 'string',
    description: 'What you are uncertain about, if anything.',
  },
  system_generated: {
    type: 'boolean',
    description: 'Set TRUE only when you INFERRED this entity as a best-practice or clearly-implied ' +
      'addition that is NOT explicitly stated in the document (suggestive mode), so a human can ' +
      'review / keep / delete it. Leave false or omit for anything the document actually states.',
  },
};

// Optional traceability field merged into the DERIVED-entity tools (workflow,
// workflow_step, agent_spec, tool). Names the FR/NFR slugs the entity implements
// so /promote can materialize requirement→element links for conflict detection.
// It is NOT in any fieldMap, so it rides in entity_data only (never a column).
const IMPLEMENTS_REQ_FIELD = {
  type: 'array',
  items: { type: 'string' },
  description: 'FR/NFR slugs from the "existing design" list that this entity implements or ' +
    'satisfies, e.g. ["FR-003","NFR-001"]. Only use slugs shown in the existing design — ' +
    'never invent one. These become traceability links used for requirement-vs-design conflict detection.',
};

// Meta keys present in entity_data that must NEVER be written to entity columns.
// Includes implements_requirements (traceability hint, materialized as links, not a column).
const META_KEYS = [...Object.keys(COMMON_TOOL_FIELDS), 'implements_requirements'];

// ── Value transforms for materialization ──────────────────────────────────────
const j = (v, fallback) => JSON.stringify(v === undefined || v === null ? fallback : v);
// Columns that expect a JSON OBJECT but the tool may emit a plain string.
const wrapText  = (v) => j(typeof v === 'string' ? { text: v }  : v, {});
const wrapModel = (v) => j(typeof v === 'string' ? { model: v } : v, {});
// node:sqlite cannot bind a JS boolean — coerce to 0/1 for INTEGER columns.
const boolInt   = (v) => (v === true || v === 'true' || v === 1 || v === '1' ? 1 : 0);

// ── ServiceNow round-trip: Level-2 provenance ────────────────────────────────
// Hidden construct/identity metadata carried on each ServiceNow-sourced design
// record so it can be regenerated & redeployed. Merged into the design tools'
// properties + fieldMap so they materialize into real (hidden) columns.
// NOTE (v1): the model copies these verbatim from per-construct provenance
// headers the Fluent ingest adapter emits. A future hardening pass should have
// the adapter attach source_sys_id deterministically (from keys.ts) rather than
// relying on the model — sys_id is the round-trip identity key and must be exact.
const PROVENANCE_FIELDS = {
  source_sys_id: { type: 'string', description: 'ServiceNow sys_id of the source record. Copy VERBATIM from the "source_sys_id:" line in the provenance header above this construct. Never invent or guess one.' },
  source_table:  { type: 'string', description: 'Originating ServiceNow metadata table (e.g. sys_db_object, sys_script, sys_ui_form, sc_cat_item). Copy verbatim from the "source_table:" line in the provenance header.' },
  source_scope:  { type: 'string', description: 'Application scope, e.g. x_dnllp_airport_ca. Copy verbatim from the "source_scope:" line in the provenance header.' },
  source_fluent: { type: 'string', description: 'The raw Fluent code snippet for this exact record, copied verbatim from the source.' },
};
const PROVENANCE_FIELDMAP = {
  source_system: { col: 'source_system' },  // deterministic-only (e.g. 'servicenow'); never model-emitted
  source_sys_id: { col: 'source_sys_id' },
  source_table:  { col: 'source_table' },
  source_scope:  { col: 'source_scope' },
  source_fluent: { col: 'source_fluent' },
  // source_hash is set DETERMINISTICALLY by the sync engine (Phase F) — the content
  // hash of the captured ServiceNow artifact — so a later sync's tier-0 pre-diff can
  // detect "unchanged" and skip the LLM. It is intentionally absent from
  // PROVENANCE_FIELDS (the model-facing schema), so it is never model-emitted; it only
  // needs a fieldMap entry so deterministic injection into entity_data materializes it.
  source_hash:   { col: 'source_hash' },
};

// ─────────────────────────────────────────────────────────────────────────────
// THE REGISTRY
// `order` = materialization order (parents before children, FK-safe).
// `fieldMap` keys are entity_data keys; only listed keys are written to columns.
//   { col, json?:bool, transform?:fn, enumMap?:{} }
// `parentLinks` resolve NOT-NULL/optional FKs: the AI names the parent, we resolve
//   it to a real id (same-packet first, then existing DB rows).
// `nameKeys` derive the entity's display name + the in-packet id-map key.
// ─────────────────────────────────────────────────────────────────────────────
const REGISTRY = [

  // ── Requirements (order 0 — materialize BEFORE design entities) ───────────────
  // FR and NFR are the source of truth; use cases / workflows are derived from them.
  // `injectsIngestId:true` tells the /promote endpoint to stamp the source document's
  // ingest_id into entity_data so the materializer writes it to the ingest_id column.
  {
    entity_type: 'functional_req',
    order: 0,
    materializable: true,
    summarizable: true,       // include in existing-design summary so AI can detect updates
    injectsIngestId: true,    // /promote injects doc.ingest_id before storing new_value
    statusCol: 'status',      // uses 'status' not 'lifecycle_status' — must match buildExistingDesignSummary
    table: 'asdlc_functional_req',
    pk: 'fr_id',
    slugPrefix: 'FR',
    nameKeys: ['title'],
    tool: {
      name: 'extract_functional_req',
      description: 'Extract a functional requirement — an explicit user need, system capability, or ' +
        'business rule the system must fulfil. Maps to asdlc_functional_req. ' +
        'Extract BEFORE extracting use cases and workflows — requirements are the source.',
      properties: {
        title:           { type: 'string',  description: 'Short declarative title, e.g. "Invoice retrieval must support multi-company lookup"' },
        description:     { type: 'string',  description: 'Full plain-English description of what the system must do' },
        actors:          { type: 'array',   items: { type: 'string' }, description: 'Roles, teams, or systems that interact with this requirement' },
        preconditions:   { type: 'string',  description: 'What must be true before this requirement can be exercised' },
        postconditions:  { type: 'string',  description: 'What is guaranteed to be true after successful fulfilment' },
        priority:        { type: 'string',  enum: ['must_have','should_have','could_have','wont_have'], description: 'MoSCoW priority' },
        source:          { type: 'string',  description: 'Citation — person name, meeting date, document section, etc.' },
        use_case_title:  { type: 'string',  description: 'Title of the Use Case this requirement belongs to. ALWAYS populate this when a use case is identifiable — it is used to link the requirement to the correct use case and prevents orphaned records.' },
        dependencies:    { type: 'array',   items: { type: 'string' }, description: 'FR or NFR slugs this requirement depends on, e.g. ["FR-002","NFR-001"]' },
      },
      required: ['title', 'description'],
    },
    fieldMap: {
      title:          { col: 'title' },
      description:    { col: 'description' },
      actors:         { col: 'actors', json: true },
      preconditions:  { col: 'preconditions' },
      postconditions: { col: 'postconditions' },
      priority:       { col: 'priority' },
      source:         { col: 'source' },
      dependencies:     { col: 'dependencies', json: true },
      ingest_id:        { col: 'ingest_id' },   // populated at promote time, not by AI
      system_generated: { col: 'system_generated', transform: boolInt },
    },
    parentLinks: [
      { col: 'use_case_id', parentType: 'use_case', nameKeyInData: 'use_case_title', required: false, tryFallback: true },
    ],
  },

  {
    entity_type: 'nonfunctional_req',
    order: 0,
    materializable: true,
    summarizable: true,
    injectsIngestId: true,
    statusCol: 'status',      // uses 'status' not 'lifecycle_status' — must match buildExistingDesignSummary
    table: 'asdlc_nonfunctional_req',
    pk: 'nfr_id',
    slugPrefix: 'NFR',
    nameKeys: ['title'],
    tool: {
      name: 'extract_nonfunctional_req',
      description: 'Extract a non-functional requirement — a quality attribute or constraint such as ' +
        'performance, security, scalability, availability, or compliance. ' +
        'Must include a measurable target so the requirement can be verified. Maps to asdlc_nonfunctional_req.',
      properties: {
        title:               { type: 'string', description: 'Short declarative title, e.g. "Invoice API p95 response < 2 s"' },
        category:            { type: 'string', description: 'Type of NFR: Performance, Security, Scalability, Availability, Compliance, Usability, etc.' },
        description:         { type: 'string', description: 'Full description of the quality constraint or attribute' },
        measurable_target:   { type: 'string', description: 'Concrete, measurable target, e.g. "p95 latency < 2 s", "99.9% uptime/month"' },
        verification_method: { type: 'string', description: 'How this NFR will be verified — load test, audit, penetration test, etc.' },
        priority:            { type: 'string', enum: ['must_have','should_have','could_have','wont_have'], description: 'MoSCoW priority' },
        source:              { type: 'string', description: 'Citation — person name, meeting date, document section, etc.' },
        use_case_title:      { type: 'string', description: 'Title of the Use Case this NFR constrains. ALWAYS populate this when a use case is identifiable — it is used to link the NFR to the correct use case and prevents orphaned records.' },
        dependencies:        { type: 'array',  items: { type: 'string' }, description: 'FR or NFR slugs this requirement depends on' },
      },
      required: ['title', 'category', 'description', 'measurable_target'],
    },
    fieldMap: {
      title:               { col: 'title' },
      category:            { col: 'category' },
      description:         { col: 'description' },
      measurable_target:   { col: 'measurable_target' },
      verification_method: { col: 'verification_method' },
      priority:            { col: 'priority' },
      source:              { col: 'source' },
      dependencies:        { col: 'dependencies', json: true },
      ingest_id:           { col: 'ingest_id' },
      system_generated:    { col: 'system_generated', transform: boolInt },
    },
    parentLinks: [
      { col: 'use_case_id', parentType: 'use_case', nameKeyInData: 'use_case_title', required: false, tryFallback: true },
    ],
  },

  {
    entity_type: 'use_case',
    order: 1,
    materializable: true,
    summarizable: true,
    table: 'asdlc_use_case',
    pk: 'use_case_id',
    slugPrefix: 'UC',
    nameKeys: ['title'],
    tool: {
      name: 'extract_use_case',
      description: 'Extract a use case identified in the document. Maps to asdlc_use_case.',
      properties: {
        title:              { type: 'string', description: 'Short descriptive title of the use case' },
        summary:            { type: 'string', description: 'Brief summary of what this use case achieves' },
        business_objective: { type: 'string', description: 'The business objective this use case serves' },
        expected_value:     { type: 'string', description: 'Expected value — cost saving, time saving, quality improvement' },
        users:              { type: 'string', description: 'Who uses this — roles, teams, or systems' },
        success_criteria:   { type: 'array', items: { type: 'string' }, description: 'Measurable success criteria' },
        constraints_list:   { type: 'array', items: { type: 'string' }, description: 'Known constraints or limitations' },
        supervision_model:  { type: 'string', enum: ['Assisted', 'Automated', 'Human-led'], description: 'Level of human supervision required' },
        urgency:            { type: 'string', description: 'Business urgency or priority' },
        owner:              { type: 'string', description: 'Business owner accountable for this use case — a role or named person' },
        primary_success_metric: { type: 'string', description: 'The single headline KPI that proves this use case succeeded (e.g. "intake-to-welcome cycle time")' },
        risk_tier:          { type: 'string', enum: ['High', 'Medium', 'Low'], description: 'Overall risk tier of automating this use case' },
        volume_assumptions: { type: 'object', description: 'Expected volumes for cost / SLA sizing (e.g. monthly_requests, peak_concurrency, peak_period, notes)' },
        readiness:          { type: 'string', description: 'Design readiness — e.g. not_ready, in_progress, ready' },
        baseline_cost_annual_usd: { type: 'number', description: 'Current annual cost of the manual / as-is process, for ROI comparison' },
      },
      required: ['title', 'summary'],
    },
    fieldMap: {
      title:              { col: 'title' },
      summary:            { col: 'summary' },
      business_objective: { col: 'business_objective' },
      expected_value:     { col: 'expected_value' },
      users:              { col: 'users' },
      urgency:            { col: 'urgency' },
      owner:              { col: 'owner' },
      primary_success_metric: { col: 'primary_success_metric' },
      risk_tier:          { col: 'risk_tier' },
      success_criteria:   { col: 'success_criteria', json: true },
      constraints_list:   { col: 'constraints_list', json: true },
      volume_assumptions: { col: 'volume_assumptions', json: true },
      readiness:          { col: 'readiness' },
      baseline_cost_annual_usd: { col: 'baseline_cost_annual_usd' },
      supervision_model:  { col: 'supervision_model',
        enumMap: { Assisted: 'Supervised HITL', Automated: 'Autonomous', 'Human-led': 'Advisory-only' } },
      system_generated:   { col: 'system_generated', transform: boolInt },
    },
    parentLinks: [],
  },

  {
    entity_type: 'workflow',
    order: 2,
    materializable: true,
    summarizable: true,
    table: 'asdlc_workflow',
    pk: 'workflow_id',
    slugPrefix: 'WF',
    nameKeys: ['name'],
    tool: {
      name: 'extract_workflow',
      description: 'Extract a workflow — a named sequence of steps that accomplishes a goal. Maps to asdlc_workflow.',
      properties: {
        name:           { type: 'string', description: 'Name of the workflow' },
        use_case_title: { type: 'string', description: 'Title of the use case this workflow belongs to (for linking). Use an existing use case title when applicable.' },
        trigger:        { type: 'object', description: 'What starts this workflow, as structured fields.',
          properties: {
            description: { type: 'string', description: 'Plain-English description of what starts the workflow' },
            type:        { type: 'string', enum: ['Manual', 'Record-based trigger', 'Now Assist Panel', 'UI Action', 'Automated/async', 'Timed'], description: 'Kind of trigger' },
            system:      { type: 'string', description: 'Source system that fires the trigger, if any' },
            event_name:  { type: 'string', description: 'The specific event / record change / condition that fires it' },
            schedule:    { type: 'string', description: 'Schedule for timed triggers (e.g. "nightly at 02:00")' },
          } },
        handoffs:       { type: 'array', items: { type: 'string' }, description: 'Hand-off points where work moves between roles or systems' },
        decisions:      { type: 'array', items: { type: 'string' }, description: 'Key decision points in the workflow' },
        fallback_paths: { type: 'array', items: { type: 'string' }, description: 'Alternative paths when the happy path fails or branches' },
        risk_tier:      { type: 'string', enum: ['High', 'Medium', 'Low'], description: 'Risk tier of automating this workflow' },
        sla_hours:      { type: 'number', description: 'Target maximum hours for the whole workflow to complete end-to-end' },
        runs_per_period:{ type: 'number', description: 'Expected executions per planning period (for volume / cost sizing)' },
        readiness:      { type: 'string', description: 'Design readiness — e.g. draft, in_progress, ready' },
        implements_requirements: IMPLEMENTS_REQ_FIELD,
      },
      required: ['name', 'trigger'],
    },
    fieldMap: {
      name:           { col: 'name' },
      trigger:        { col: 'trigger_def', json: true },
      handoffs:       { col: 'handoffs', json: true },
      decisions:      { col: 'decisions', json: true },
      fallback_paths: { col: 'fallback_paths', json: true },
      risk_tier:      { col: 'risk_tier' },
      sla_hours:      { col: 'sla_hours' },
      runs_per_period:{ col: 'runs_per_period' },
      readiness:      { col: 'readiness' },
      system_generated: { col: 'system_generated', transform: boolInt },
    },
    parentLinks: [
      { col: 'use_case_id', parentType: 'use_case', nameKeyInData: 'use_case_title', required: true },
    ],
  },

  {
    entity_type: 'workflow_step',
    order: 3,
    materializable: true,
    summarizable: false,
    table: 'asdlc_workflow_step',
    pk: 'workflow_step_id',
    slugPrefix: 'S',
    nameKeys: ['name'],
    tool: {
      name: 'extract_workflow_step',
      description: 'Extract a single step within a workflow. Call once per step. Maps to asdlc_workflow_step.',
      properties: {
        name:           { type: 'string',  description: 'Name of the step' },
        step_number:    { type: 'integer', description: 'Sequence number within the workflow (1, 2, 3…)' },
        workflow_name:  { type: 'string',  description: 'Name of the parent workflow this step belongs to' },
        actor_role:     { type: 'string',  description: 'Role or system responsible for executing this step' },
        sla_hours:      { type: 'number',  description: 'Maximum hours allowed to complete this step' },
        inputs:         { type: 'array',   items: { type: 'string' }, description: 'Inputs required to begin this step' },
        outputs:        { type: 'array',   items: { type: 'string' }, description: 'Outputs produced when this step completes' },
        decisions_list: { type: 'array',   items: { type: 'string' }, description: 'Decisions made at this step' },
        step_type:      { type: 'string',  enum: ['Start', 'Activity', 'Decision', 'Approval', 'Notification', 'Wait', 'End'], description: 'Kind of step' },
        step_purpose:   { type: 'string',  description: 'What this step achieves, beyond its name (the why)' },
        preconditions:  { type: 'string',  description: 'What must be true before this step can begin' },
        evidence_captured: { type: 'string', description: 'What is logged/captured at this step for audit — decisions, approvals, timestamps' },
        implements_requirements: IMPLEMENTS_REQ_FIELD,
      },
      required: ['name', 'step_number'],
    },
    fieldMap: {
      name:           { col: 'name' },
      step_number:    { col: 'step_number' },
      actor_role:     { col: 'actor_role' },
      sla_hours:      { col: 'sla_hours' },
      inputs:         { col: 'inputs', json: true },
      outputs:        { col: 'outputs', json: true },
      decisions_list: { col: 'decisions_list', json: true },
      step_type:      { col: 'step_type' },
      step_purpose:   { col: 'step_purpose' },
      preconditions:  { col: 'preconditions' },
      evidence_captured: { col: 'evidence_captured' },
      system_generated: { col: 'system_generated', transform: boolInt },
    },
    parentLinks: [
      { col: 'workflow_id', parentType: 'workflow', nameKeyInData: 'workflow_name', required: true },
    ],
  },

  {
    entity_type: 'hitl_gate',
    order: 4,
    materializable: true,
    summarizable: false,
    table: 'asdlc_hitl_gate',
    pk: 'hitl_gate_id',
    slugPrefix: null,                 // hitl_gate has no slug column
    nameKeys: ['gate_name'],
    tool: {
      name: 'extract_hitl_gate',
      description: 'Extract a Human-in-the-Loop gate — a point where a human must review, approve, or decide before the workflow continues. Maps to asdlc_hitl_gate.',
      properties: {
        gate_name:         { type: 'string', description: 'Name of this HITL gate' },
        workflow_name:     { type: 'string', description: 'Name of the workflow this gate belongs to' },
        gate_type:         { type: 'string', enum: ['approval', 'review', 'escalation', 'sign-off', 'other'], description: 'Type of human intervention required' },
        criteria:          { type: 'string', description: 'What the human is reviewing or deciding — the question they must answer' },
        owner_role:        { type: 'string', description: 'Role responsible for responding at this gate' },
        sla:               { type: 'string', description: 'Time allowed for the human to respond (e.g. "4 hours", "1 business day")' },
        handoff_mechanism: { type: 'string', description: 'How the work reaches the human — notification, queue, dashboard, email' },
      },
      required: ['gate_name', 'criteria', 'owner_role'],
    },
    fieldMap: {
      gate_type:         { col: 'gate_type' },
      criteria:          { col: 'criteria' },
      owner_role:        { col: 'owner_role' },
      sla:               { col: 'sla' },
      handoff_mechanism: { col: 'handoff_mechanism' },
    },
    parentLinks: [
      { col: 'workflow_id', parentType: 'workflow', nameKeyInData: 'workflow_name', required: true },
    ],
  },

  {
    entity_type: 'agent_spec',
    order: 5,
    materializable: true,
    summarizable: true,
    table: 'asdlc_agent_spec',
    pk: 'agent_spec_id',
    slugPrefix: 'AG',
    nameKeys: ['name'],
    tool: {
      name: 'extract_agent_spec',
      description: 'Extract an AI agent specification — a named agent with a defined role in the workflow. Maps to asdlc_agent_spec.',
      properties: {
        name:             { type: 'string', description: 'Name of the agent' },
        use_case_title:   { type: 'string', description: 'Title of the use case this agent serves (for linking). Use an existing use case title when applicable.' },
        workflow_name:    { type: 'string', description: 'Name of the workflow this agent operates in, if any' },
        scope:            { type: 'string', description: 'What this agent is responsible for — its domain and boundaries' },
        instructions:     { type: 'string', description: 'Key operating rules or instructions for this agent' },
        goals:            { type: 'array',  items: { type: 'string' }, description: 'Goals this agent must achieve' },
        done_criteria:    { type: 'array',  items: { type: 'string' }, description: 'How to determine when this agent has successfully completed its task' },
        memory_strategy:  { type: 'string', description: 'How this agent retains context — none, session, or persistent' },
        design_risks:     { type: 'array',  items: { type: 'string' }, description: 'Known risks or failure modes in this agent\'s design' },
        model_preference: { type: 'string', description: 'Preferred AI model (e.g. claude-sonnet, claude-opus)' },
        inputs:           { type: 'object', description: 'Inputs the agent consumes (entities, fields, signals it reads)' },
        outputs:          { type: 'object', description: 'Outputs the agent produces (records, decisions, messages it writes)' },
        supervision_model:{ type: 'string', enum: ['Advisory-only', 'Supervised HITL', 'Autonomous'], description: 'Human-oversight level for this agent' },
        orchestration_strategy: { type: 'string', enum: ['Base Planner', 'ReActive Planner', 'Batch Planner'], description: 'How the agent plans / sequences its work' },
        maintenance_owner:{ type: 'string', description: 'Who owns ongoing maintenance of this agent (role or team)' },
        latency_target:   { type: 'string', description: 'Performance target, e.g. "p95 < 5s"' },
        post_release_validation: { type: 'string', description: 'How the agent is validated after release — evals, monitoring, sampling' },
        cost_model:       { type: 'string', enum: ['none', 'servicenow_now_assist'], description: 'Cost model for this agent' },
        implements_requirements: IMPLEMENTS_REQ_FIELD,
      },
      required: ['name', 'scope'],
    },
    fieldMap: {
      name:             { col: 'name' },
      scope:            { col: 'scope' },
      instructions:     { col: 'instructions' },
      goals:            { col: 'goals', json: true },
      done_criteria:    { col: 'done_criteria', json: true },
      memory_strategy:  { col: 'memory_strategy' },
      design_risks:     { col: 'design_risks', json: true },
      model_preference: { col: 'run_as_model', transform: wrapModel },
      inputs:           { col: 'inputs', json: true },
      outputs:          { col: 'outputs', json: true },
      supervision_model:{ col: 'supervision_model' },
      orchestration_strategy: { col: 'orchestration_strategy' },
      maintenance_owner:{ col: 'maintenance_owner' },
      latency_target:   { col: 'latency_target' },
      post_release_validation: { col: 'post_release_validation' },
      cost_model:       { col: 'cost_model' },
      system_generated: { col: 'system_generated', transform: boolInt },
    },
    parentLinks: [
      { col: 'use_case_id', parentType: 'use_case', nameKeyInData: 'use_case_title', required: true },
      { col: 'workflow_id', parentType: 'workflow', nameKeyInData: 'workflow_name', required: false },
    ],
  },

  {
    entity_type: 'tool',
    order: 6,
    materializable: true,
    summarizable: true,
    table: 'asdlc_tool',
    pk: 'tool_id',
    slugPrefix: 'T',
    nameKeys: ['name'],
    tool: {
      name: 'extract_tool',
      description: 'Extract a tool / integration that an agent uses — an API, function, query, or external capability. Maps to asdlc_tool.',
      properties: {
        name:                { type: 'string', description: 'Name of the tool' },
        contract:            { type: 'string', description: 'What the tool does — its purpose and contract' },
        inputs:              { type: 'array',  items: { type: 'string' }, description: 'Inputs the tool accepts' },
        outputs:             { type: 'array',  items: { type: 'string' }, description: 'Outputs the tool returns' },
        errors:              { type: 'array',  items: { type: 'string' }, description: 'Error conditions the tool may return, as short snake_case identifiers (e.g. not_found, timeout, unauthorized, source_unavailable). Prefer system-neutral names — if a system is renamed, rename its error codes to match.' },
        access_requirements: {
          type: 'object',
          description: 'Auth / permission / data-handling requirements for the tool.',
          properties: {
            role_required:       { type: 'string',  description: 'Roles, permissions, or service accounts needed to call the tool' },
            data_classification: { type: 'string',  description: 'Data sensitivity, e.g. public / internal / confidential / restricted' },
            contains_pii:        { type: 'boolean', description: 'Whether the tool handles personally identifiable information' },
            rate_limit_per_min:  { type: 'number',  description: 'Max calls per minute; omit if none' },
          },
        },
        cost_impact:         { type: 'string', description: 'Cost note for one invocation, e.g. "1 action + 1 IntegrationHub transaction"' },
        boundaries:          { type: 'array',  items: { type: 'string' }, description: 'Limits / boundaries on what the tool may do' },
        execution_mode:      { type: 'string', enum: ['sync', 'async'], description: 'Whether the tool runs synchronously or asynchronously' },
        dev_status:          { type: 'string', enum: ['Existing', 'To be built'], description: 'Whether the tool already exists or must be built' },
        implements_requirements: IMPLEMENTS_REQ_FIELD,
      },
      required: ['name'],
    },
    fieldMap: {
      name:                { col: 'name' },
      contract:            { col: 'contract', transform: wrapText },
      inputs:              { col: 'inputs', json: true },
      outputs:             { col: 'outputs', json: true },
      errors:              { col: 'errors', json: true },
      access_requirements: { col: 'access_requirements', json: true },
      cost_impact:         { col: 'cost_impact' },
      boundaries:          { col: 'boundaries', json: true },
      execution_mode:      { col: 'execution_mode' },
      dev_status:          { col: 'dev_status' },
      system_generated:    { col: 'system_generated', transform: boolInt },
    },
    parentLinks: [],
  },

  // ── Acceptance Criteria (order 7 — after design entities, requires UC parent) ──
  // Kept in the Testing module. AI only extracts AC when a Use Case can be named.
  // `staticColumns` are injected by mtCreate alongside the fieldMap columns.
  // `req_slug` links the AC back to the FR or NFR it satisfies (loose FK via slug).
  {
    entity_type: 'acceptance_criterion',
    order: 7,
    materializable: true,
    summarizable: false,          // too many to enumerate in the existing-design context
    staticColumns: { parent_type: 'use_case', source: 'generated' },
    table: 'asdlc_acceptance_criterion',
    pk: 'acceptance_criterion_id',
    slugPrefix: 'AC',
    nameKeys: ['text'],
    tool: {
      name: 'extract_acceptance_criterion',
      description: 'Extract one acceptance criterion — a single verifiable condition that confirms a ' +
        'requirement or use case is met. Use Given/When/Then format where possible. ' +
        'ONLY extract when you can name the parent Use Case. If no UC is identifiable, ' +
        'raise a clarification instead of guessing. Maps to asdlc_acceptance_criterion.',
      properties: {
        text:           { type: 'string', description: 'The criterion text, ideally in Given/When/Then form. One criterion per call.' },
        use_case_title: { type: 'string', description: 'Title of the Use Case this AC verifies — must match a UC being extracted or already in the design' },
        req_slug:       { type: 'string', description: 'FR-### or NFR-### slug this AC satisfies, e.g. "FR-003". Leave blank if no specific requirement is identified.' },
        case_type_hint: { type: 'string', enum: ['happy_path','edge_case','negative','regression'], description: 'Scenario type — informational only, used when generating linked test cases' },
      },
      required: ['text', 'use_case_title'],
    },
    fieldMap: {
      text:     { col: 'text' },
      req_slug: { col: 'req_slug' },
    },
    parentLinks: [
      // Resolves use_case_title → parent_id (the use_case_id UUID).
      // parent_type is always 'use_case' — set via staticColumns above.
      { col: 'parent_id', parentType: 'use_case', nameKeyInData: 'use_case_title', required: true },
    ],
  },

  // ── Test Cases (order 8 — after AC, requires a scope entity) ─────────────────
  // `scopeResolution:true` triggers special scope-conditional parent lookup in mtCreate.
  // `requirement_refs` maps to the existing `requirement_ids` JSON column.
  {
    entity_type: 'test_case',
    order: 8,
    materializable: true,
    summarizable: false,
    staticColumns: { source: 'generated' },
    scopeResolution: true,    // mtCreate handles scope-conditional parent lookup
    table: 'asdlc_test_case',
    pk: 'test_case_id',
    slugPrefix: 'TC',
    nameKeys: ['title'],
    tool: {
      name: 'extract_test_case',
      description: 'Extract one test case — a single scenario that validates system behaviour. ' +
        'Link it to the Use Case, Workflow, Agent, or Tool being tested via scope + scope_entity_name. ' +
        'Include the FR/NFR slugs it validates in requirement_refs. Maps to asdlc_test_case.',
      properties: {
        title:             { type: 'string', description: 'Short descriptive title of the test case' },
        test_action:       { type: 'string', description: 'What the tester or system does — the action being tested' },
        test_input:        { type: 'string', description: 'Input data, state, or preconditions for this test' },
        expected_result:   { type: 'string', description: 'What the correct outcome is — what success looks like' },
        case_type:         { type: 'string', enum: ['happy_path','edge_case','negative','regression'], description: 'Type of scenario' },
        scope:             { type: 'string', enum: ['use_case','workflow','agent','tool'], description: 'The level at which this test operates' },
        scope_entity_name: { type: 'string', description: 'Exact name of the entity being tested (use case title, workflow name, agent name, or tool name)' },
        requirement_refs:  { type: 'array',  items: { type: 'string' }, description: 'FR and NFR slugs this test validates, e.g. ["FR-003","NFR-001"]. Use slugs from the existing design or from this extraction.' },
      },
      required: ['title', 'test_action', 'expected_result', 'scope', 'scope_entity_name'],
    },
    fieldMap: {
      title:           { col: 'title' },
      test_action:     { col: 'test_action' },
      test_input:      { col: 'test_input' },
      expected_result: { col: 'expected_result' },
      case_type:       { col: 'case_type' },
      scope:           { col: 'scope' },
      requirement_refs:{ col: 'requirement_ids', json: true },
    },
    parentLinks: [],     // scope_entity_id resolved via scopeResolution path in mtCreate
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // ServiceNow round-trip: Level-1 design types (orders 9–12).
  // Populated by ingesting a ServiceNow app's transformed Fluent source.
  // data_model is the parent of form_design / business_logic, so it materializes
  // first (lower order). Each carries hidden Level-2 provenance columns.
  // ═══════════════════════════════════════════════════════════════════════════
  {
    entity_type: 'data_model',
    order: 9,
    materializable: true,
    summarizable: true,
    table: 'asdlc_data_model',
    pk: 'data_model_id',
    slugPrefix: 'DM',
    nameKeys: ['name'],
    tool: {
      name: 'extract_data_model',
      description: 'Extract a ServiceNow data model — one database table and its fields, described at a business level. Maps to asdlc_data_model.',
      properties: {
        name:          { type: 'string', description: 'Business label for the table, e.g. "Flight"' },
        purpose:       { type: 'string', description: 'What business object this table represents and why it exists' },
        physical_name: { type: 'string', description: 'ServiceNow table name, e.g. x_dnllp_airport_ca_flight (copy from the construct if shown)' },
        extends_table: { type: 'string', description: 'Parent table it extends (e.g. task), if any' },
        fields: {
          type: 'array',
          description: 'The columns, described for a business reader',
          items: { type: 'object', properties: {
            label:         { type: 'string',  description: 'Business label of the field' },
            meaning:       { type: 'string',  description: 'What the field captures, in business terms' },
            type_business: { type: 'string',  description: 'Business-friendly type: text, number, date, choice, reference, true/false, etc.' },
            mandatory:     { type: 'boolean', description: 'Whether the field is required' },
            choices:       { type: 'array', items: { type: 'string' }, description: 'Choice values, if a choice field' },
            references:    { type: 'string',  description: 'For a reference field, the table it points to' },
          } },
        },
        relationships: {
          type: 'array',
          description: 'Relationships to other tables',
          items: { type: 'object', properties: {
            kind:        { type: 'string', description: 'reference / extends / one-to-many / many-to-many' },
            target:      { type: 'string', description: 'The related table (business label)' },
            description: { type: 'string', description: 'What the relationship means' },
          } },
        },
        audited:       { type: 'boolean', description: 'Whether record changes are audited' },
        ...PROVENANCE_FIELDS,
      },
      required: ['name'],
    },
    fieldMap: {
      name:          { col: 'name' },
      purpose:       { col: 'purpose' },
      physical_name: { col: 'physical_name' },
      extends_table: { col: 'extends_table' },
      fields:        { col: 'fields', json: true },
      relationships: { col: 'relationships', json: true },
      audited:       { col: 'audited', transform: boolInt },
      ...PROVENANCE_FIELDMAP,
    },
    parentLinks: [],
  },

  {
    entity_type: 'form_design',
    order: 10,
    materializable: true,
    summarizable: true,
    table: 'asdlc_form_design',
    pk: 'form_design_id',
    slugPrefix: 'FORM',
    nameKeys: ['name'],
    tool: {
      name: 'extract_form_design',
      description: 'Extract a ServiceNow form/view design — how a record is laid out on screen, including section layout and dynamic behavior. Maps to asdlc_form_design.',
      properties: {
        name:            { type: 'string', description: 'Name of the form/view' },
        data_model_name: { type: 'string', description: 'Business label of the table this form is for (links to a data model)' },
        view_name:       { type: 'string', description: 'Which view — Default, Mobile, etc.' },
        sections: {
          type: 'array',
          description: 'Form sections in order',
          items: { type: 'object', properties: {
            section_label: { type: 'string',  description: 'Section heading' },
            fields:        { type: 'array', items: { type: 'string' }, description: 'Field labels shown in this section, in order' },
            columns:       { type: 'integer', description: 'Number of columns in the section layout' },
          } },
        },
        related_lists: {
          type: 'array',
          description: 'Related lists shown on the form',
          items: { type: 'object', properties: {
            label: { type: 'string' }, table: { type: 'string' },
          } },
        },
        mandatory_fields: { type: 'array', items: { type: 'string' }, description: 'Field labels that are mandatory on this form' },
        readonly_fields:  { type: 'array', items: { type: 'string' }, description: 'Field labels that are read-only on this form' },
        behavior_notes:   { type: 'string', description: 'UI-policy / dynamic behavior in plain English (e.g. "Cancellation reason becomes mandatory when Status = Cancelled")' },
        ...PROVENANCE_FIELDS,
      },
      required: ['name'],
    },
    fieldMap: {
      name:             { col: 'name' },
      view_name:        { col: 'view_name' },
      sections:         { col: 'sections', json: true },
      related_lists:    { col: 'related_lists', json: true },
      mandatory_fields: { col: 'mandatory_fields', json: true },
      readonly_fields:  { col: 'readonly_fields', json: true },
      behavior_notes:   { col: 'behavior_notes' },
      ...PROVENANCE_FIELDMAP,
    },
    parentLinks: [
      { col: 'data_model_id', parentType: 'data_model', nameKeyInData: 'data_model_name', required: false },
    ],
  },

  {
    entity_type: 'business_logic',
    order: 11,
    materializable: true,
    summarizable: true,
    table: 'asdlc_business_logic',
    pk: 'business_logic_id',
    slugPrefix: 'BL',
    nameKeys: ['name'],
    tool: {
      name: 'extract_business_logic',
      description: 'Extract a piece of business logic — a business rule, client script, script include, UI action, scheduled job, or UI policy — described in plain English. The actual script body stays in provenance, not a Level-1 field. Maps to asdlc_business_logic.',
      properties: {
        name:            { type: 'string', description: 'Name of the logic artifact' },
        logic_type:      { type: 'string', enum: ['business_rule','client_script','script_include','ui_action','scheduled_job','ui_policy'], description: 'Kind of logic' },
        data_model_name: { type: 'string', description: 'Business label of the table this logic runs on, if any' },
        plain_english:   { type: 'string', description: 'What this logic does, in plain business language' },
        when_runs:       { type: 'string', description: 'When it runs (e.g. "after a Flight record is updated", "when the form loads")' },
        conditions:      { type: 'string', description: 'The condition under which it applies, in business terms' },
        run_order:       { type: 'integer', description: 'Execution order, if relevant' },
        requirement_refs:{ type: 'array', items: { type: 'string' }, description: 'FR/NFR slugs from the "existing design" list that this logic implements or elaborates, e.g. ["FR-003","NFR-001"]. Only use slugs shown in the existing design — never invent one. Traceability references, not duplicated design. Optional.' },
        ...PROVENANCE_FIELDS,
      },
      required: ['name', 'logic_type'],
    },
    fieldMap: {
      name:          { col: 'name' },
      logic_type:    { col: 'logic_type' },
      plain_english: { col: 'plain_english' },
      when_runs:     { col: 'when_runs' },
      conditions:    { col: 'conditions' },
      run_order:     { col: 'run_order' },
      requirement_refs: { col: 'requirement_refs', json: true },
      ...PROVENANCE_FIELDMAP,
    },
    parentLinks: [
      { col: 'data_model_id', parentType: 'data_model', nameKeyInData: 'data_model_name', required: false },
    ],
  },

  {
    entity_type: 'catalog_item',
    order: 12,
    materializable: true,
    summarizable: true,
    table: 'asdlc_catalog_item',
    pk: 'catalog_item_id',
    slugPrefix: 'CAT',
    nameKeys: ['name'],
    tool: {
      name: 'extract_catalog_item',
      description: 'Extract a Service Catalog item or record producer — something users can request, its variables, and how it is fulfilled. Maps to asdlc_catalog_item.',
      properties: {
        name:              { type: 'string', description: 'Name of the catalog item' },
        short_description: { type: 'string', description: 'Short description shown to requesters' },
        category:          { type: 'string', description: 'Catalog category' },
        workflow_name:     { type: 'string', description: 'Name of the workflow/flow that fulfills this request, if any' },
        variables: {
          type: 'array',
          description: 'The questions/variables the requester fills in',
          items: { type: 'object', properties: {
            label:         { type: 'string' },
            type_business: { type: 'string',  description: 'text, choice, reference, date, yes/no, etc.' },
            mandatory:     { type: 'boolean' },
            choices:       { type: 'array', items: { type: 'string' } },
            help:          { type: 'string',  description: 'Help text shown to the requester' },
          } },
        },
        who_can_order:     { type: 'string', description: 'Roles or groups who can order this item' },
        delivery_time:     { type: 'string', description: 'Expected delivery / fulfillment time' },
        ...PROVENANCE_FIELDS,
      },
      required: ['name'],
    },
    fieldMap: {
      name:              { col: 'name' },
      short_description: { col: 'short_description' },
      category:          { col: 'category' },
      variables:         { col: 'variables', json: true },
      who_can_order:     { col: 'who_can_order' },
      delivery_time:     { col: 'delivery_time' },
      ...PROVENANCE_FIELDMAP,
    },
    parentLinks: [
      { col: 'workflow_id', parentType: 'workflow', nameKeyInData: 'workflow_name', required: false },
    ],
  },

  // ── Types WITHOUT a dedicated table (v1): extracted + promoted for review, but
  //    not materialized. Add a table + flip materializable to wire them in later.
  {
    entity_type: 'guardrail',
    order: 50, materializable: true, summarizable: false, injectsIngestId: true,
    table: 'asdlc_guardrail',
    pk: 'guardrail_id',
    slugPrefix: 'GR',
    nameKeys: ['rule_name'],
    tool: {
      name: 'extract_guardrail',
      description: 'Extract a guardrail — a rule, constraint, limit, or boundary on agent behaviour.',
      properties: {
        rule_name:           { type: 'string', description: 'Short name for this guardrail' },
        rule_text:           { type: 'string', description: 'Full plain-English statement of the rule' },
        severity:            { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'How severe a breach would be' },
        applies_to:          { type: 'string', description: 'What entity type or process this guardrail constrains' },
        threshold_value:     { type: 'string', description: 'Numeric or categorical threshold that triggers this rule' },
        threshold_unit:      { type: 'string', description: 'Unit of the threshold — GBP, items, hours, score, etc.' },
        regulatory_reference:{ type: 'string', description: 'Regulation or policy this derives from, if any' },
        action_if_triggered: { type: 'string', enum: ['block', 'escalate', 'flag', 'log', 'halt'], description: 'What happens when triggered' },
      },
      required: ['rule_name', 'rule_text', 'severity'],
    },
    fieldMap: {
      rule_name:            { col: 'rule_name' },
      rule_text:            { col: 'rule_text' },
      severity:             { col: 'severity' },
      applies_to:           { col: 'applies_to' },
      threshold_value:      { col: 'threshold_value' },
      threshold_unit:       { col: 'threshold_unit' },
      regulatory_reference: { col: 'regulatory_reference' },
      action_if_triggered:  { col: 'action_if_triggered' },
      ingest_id:            { col: 'ingest_id' },
    },
    parentLinks: [],
  },
  {
    entity_type: 'user_story',
    order: 51, materializable: true, summarizable: false, injectsIngestId: true,
    table: 'asdlc_user_story',
    pk: 'user_story_id',
    slugPrefix: 'US',
    nameKeys: ['role', 'want'],
    tool: {
      name: 'extract_user_story',
      description: 'Extract a user story in Role / Want / So-That format. A user story is an ' +
        'organizational/backlog lens — capture its narrative and which requirements it is realized by. ' +
        'The actual design (the testable conditions) lives in acceptance criteria and requirements, not here.',
      properties: {
        role:                { type: 'string', description: 'The type of user — their role or title' },
        want:                { type: 'string', description: 'What this user wants the system to do' },
        so_that:             { type: 'string', description: 'The business reason — why they want it' },
        acceptance_criteria: { type: 'array',  items: { type: 'string' }, description: 'Testable conditions for completion (captured for reference; the canonical home is the acceptance-criterion entities)' },
        priority:            { type: 'string', enum: ['must-have', 'should-have', 'could-have'], description: 'Priority' },
        requirement_refs:    { type: 'array',  items: { type: 'string' }, description: 'FR/NFR slugs from the "existing design" list that this story is realized by, e.g. ["FR-003","NFR-001"]. Only use slugs shown in the existing design — never invent one. Traceability references, not duplicated design.' },
      },
      required: ['role', 'want', 'so_that'],
    },
    // NOTE: acceptance_criteria is intentionally NOT in fieldMap — it rides in the
    // extraction JSON / Build Spec but is never materialized (no duplication; the
    // canonical home is asdlc_acceptance_criterion).
    fieldMap: {
      role:             { col: 'role' },
      want:             { col: 'want' },
      so_that:          { col: 'so_that' },
      priority:         { col: 'priority' },
      requirement_refs: { col: 'requirement_refs', json: true },
      ingest_id:        { col: 'ingest_id' },
    },
    parentLinks: [],
  },
  {
    entity_type: 'data_source',
    order: 52, materializable: true, summarizable: false, injectsIngestId: true,
    table: 'asdlc_data_source',
    pk: 'data_source_id',
    slugPrefix: 'DS',
    nameKeys: ['source_name'],
    tool: {
      name: 'extract_data_source',
      description: 'Extract a data source — any system, database, API, file store, or service an agent reads from or writes to.',
      properties: {
        source_name:        { type: 'string',  description: 'Name of the system or data source' },
        source_type:        { type: 'string',  enum: ['api', 'database', 'file', 'service', 'queue', 'other'], description: 'Type of data source' },
        description:        { type: 'string',  description: 'What this source contains and what it is used for' },
        access_type:        { type: 'string',  enum: ['read', 'write', 'read-write'], description: 'Whether agents read, write, or both' },
        access_requirements:{ type: 'array',   items: { type: 'string' }, description: 'Authentication, permission, or licensing requirements' },
        contains_pii:       { type: 'boolean', description: 'Does this source contain personal or sensitive data?' },
        rate_limits:        { type: 'string',  description: 'API rate limits or quota constraints if known' },
      },
      required: ['source_name', 'source_type'],
    },
    fieldMap: {
      source_name:         { col: 'source_name' },
      source_type:         { col: 'source_type' },
      description:         { col: 'description' },
      access_type:         { col: 'access_type' },
      access_requirements: { col: 'access_requirements', json: true },
      contains_pii:        { col: 'contains_pii', transform: boolInt },
      rate_limits:         { col: 'rate_limits' },
      ingest_id:           { col: 'ingest_id' },
      system_generated:    { col: 'system_generated', transform: boolInt },
    },
    parentLinks: [],
  },
  {
    entity_type: 'process_segment',
    order: 53, materializable: false, summarizable: false,
    nameKeys: ['segment_name'],
    tool: {
      name: 'extract_process_segment',
      description: 'Extract a process segment — a named phase or stage within the overall process (commonly used for as-is analysis).',
      properties: {
        segment_name:   { type: 'string',  description: 'Name of the process segment' },
        description:    { type: 'string',  description: 'What happens in this segment' },
        swim_lane:      { type: 'string',  description: 'Department, team, or system boundary that owns this segment' },
        sequence_order: { type: 'integer', description: 'Position of this segment in the overall process' },
      },
      required: ['segment_name'],
    },
  },
  {
    entity_type: 'governance_control',
    order: 54, materializable: false, summarizable: false,
    nameKeys: ['control_name'],
    tool: {
      name: 'extract_governance_control',
      description: 'Extract a governance control — a recurring review, audit, or oversight mechanism.',
      properties: {
        control_name:     { type: 'string', description: 'Name of the governance control' },
        description:      { type: 'string', description: 'What this control does and why it exists' },
        frequency:        { type: 'string', description: 'How often — daily, weekly, monthly, quarterly, annually' },
        owner_role:       { type: 'string', description: 'Role responsible for this control' },
        evidence_required:{ type: 'string', description: 'Evidence that must be produced to demonstrate this control was performed' },
      },
      required: ['control_name'],
    },
  },
];

// ── ServiceNow round-trip (Round 2): attach Level-2 provenance to the REUSED
// design types so agents/workflows/tools extracted from ServiceNow also carry
// sys_id identity. Done here (not inline) to keep it in one place; fields are
// optional and clearly SN-only, so transcript ingestion is unaffected.
for (const et of ['use_case', 'agent_spec', 'tool', 'workflow', 'workflow_step']) {
  const e = REGISTRY.find(r => r.entity_type === et);
  if (!e) continue;
  e.tool.properties = { ...e.tool.properties, ...PROVENANCE_FIELDS };
  e.fieldMap = { ...e.fieldMap, ...PROVENANCE_FIELDMAP };
}

// ── Derived lookups ───────────────────────────────────────────────────────────
const byEntityType = {};
const byToolName    = {};
for (const e of REGISTRY) {
  byEntityType[e.entity_type] = e;
  byToolName[e.tool.name]     = e;
}

/** Reverse map: parentType → [ { childType, col } ] — used to block deletes with live children. */
const childrenOf = {};
for (const e of REGISTRY) {
  for (const link of (e.parentLinks || [])) {
    (childrenOf[link.parentType] ||= []).push({ childType: e.entity_type, table: e.table, col: link.col });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Build the full Claude API tool definitions (entity tools + merged common fields).
 *  Level-2 provenance (source_sys_id, source_table, source_scope, source_fluent) is
 *  intentionally STRIPPED from the schema sent to the model. It is set DETERMINISTICALLY
 *  by the sync engine (matched to the captured ServiceNow artifact) — never copied by
 *  the model, which produced false sys_id links (e.g. a synthesized workflow inheriting
 *  a use case's sys_id). fieldMap keeps the provenance columns so deterministic injection
 *  into entity_data still materializes them. */
const PROVENANCE_KEYS = Object.keys(PROVENANCE_FIELDS);
function buildApiTools() {
  return REGISTRY.map(e => {
    const properties = { ...e.tool.properties, ...COMMON_TOOL_FIELDS };
    for (const k of PROVENANCE_KEYS) delete properties[k];   // provenance is deterministic, never model-emitted
    return {
      name: e.tool.name,
      description: e.tool.description,
      input_schema: {
        type: 'object',
        properties,
        required: [...(e.tool.required || []), 'confidence'],
      },
    };
  });
}

/** Map of extraction tool name → entity_type. */
function toolToEntity() {
  const m = {};
  for (const e of REGISTRY) m[e.tool.name] = e.entity_type;
  return m;
}

/** Derive a human/idMap name for an entity_data blob given its type. */
function entityName(entityType, data) {
  const e = byEntityType[entityType];
  if (!e || !data) return null;
  const parts = (e.nameKeys || []).map(k => data[k]).filter(Boolean);
  return parts.length ? parts.join(' :: ') : null;
}

module.exports = {
  REGISTRY,
  COMMON_TOOL_FIELDS,
  META_KEYS,
  byEntityType,
  byToolName,
  childrenOf,
  buildApiTools,
  toolToEntity,
  entityName,
};
