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
  best_practice_ref: {
    type: 'string',
    description: 'ONLY when system_generated=true AND one specific rule in the "Best practices / house ' +
      'rules" section is the reason you added this entity: the EXACT [BP-xxx] slug shown next to that ' +
      'rule. Copy it character-for-character — never invent one, never use a title instead of the slug. ' +
      'Leave blank for anything the document states, and for system_generated=true items that are your ' +
      'own architectural judgment rather than a citation of one specific listed rule.',
  },
  clarification_ref: {
    type: 'string',
    description: 'During a clarification round ONLY: echo back EXACTLY the ref token shown next to this ' +
      'item in the "[ref: ...]" prefix, so the system updates the existing staged row instead of creating ' +
      'a duplicate — even if you refine the name/title. Leave empty on the first round and for brand-new items.',
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
      best_practice_ref: { col: 'best_practice_ref' },
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
      best_practice_ref:   { col: 'best_practice_ref' },
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
      best_practice_ref:  { col: 'best_practice_ref' },
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
      best_practice_ref: { col: 'best_practice_ref' },
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
      best_practice_ref: { col: 'best_practice_ref' },
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
      best_practice_ref: { col: 'best_practice_ref' },
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
      best_practice_ref:   { col: 'best_practice_ref' },
    },
    parentLinks: [],
  },

  // ── Acceptance Criteria (order 60 — after user_story at 51, requires UC/US parent) ──
  // Kept in the Testing module. AI only extracts AC when a Use Case can be named.
  // `staticColumns` are injected by mtCreate alongside the fieldMap columns.
  // `req_slug` links the AC back to the FR or NFR it satisfies (loose FK via slug).
  // ORDER NOTE: must be > 51 (user_story) so that when a CP contains both AC and US
  // items, user_story rows exist in idMap before acceptance_criterion tries to resolve
  // its parent_id. Previously order:7 caused 11 orphaned ACs in the DB.
  {
    entity_type: 'acceptance_criterion',
    order: 60,
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

  {
    entity_type: 'rest_message',
    order: 13,
    materializable: true,
    summarizable: true,
    table: 'asdlc_integration',
    pk: 'integration_id',
    slugPrefix: 'RST',
    nameKeys: ['name'],
    tool: {
      name: 'extract_rest_message',
      description: 'Extract an outbound HTTP integration (REST Message) — a service the app calls, its base URL, authentication type, and HTTP operations. Maps to asdlc_integration with integration_type=rest_message. SDK v4.8+: deployable via RestMessage() Fluent API.',
      properties: {
        integration_type: { type: 'string', enum: ['rest_message'], description: 'Always rest_message for this tool' },
        name:             { type: 'string', description: 'Display name of the REST Message, e.g. "SAP Invoice API"' },
        description:      { type: 'string', description: 'Purpose of this integration' },
        endpoint:         { type: 'string', description: 'Base URL of the service' },
        auth_type:        { type: 'string', enum: ['noAuthentication','basic','oauth2'], description: 'Authentication type' },
        functions: {
          type: 'array',
          description: 'HTTP operations defined on this REST Message',
          items: { type: 'object', properties: {
            name:        { type: 'string' },
            http_method: { type: 'string', enum: ['GET','POST','PUT','PATCH','DELETE'] },
            endpoint:    { type: 'string', description: 'URL override for this function if different from base' },
          } },
        },
        notes: { type: 'string', description: 'Additional notes or context' },
        ...PROVENANCE_FIELDS,
      },
      required: ['name', 'integration_type'],
    },
    fieldMap: {
      integration_type: { col: 'integration_type' },
      name:             { col: 'name' },
      description:      { col: 'description' },
      endpoint:         { col: 'endpoint' },
      auth_type:        { col: 'auth_type' },
      functions:        { col: 'functions', json: true },
      notes:            { col: 'notes' },
      ...PROVENANCE_FIELDMAP,
    },
    parentLinks: [],
  },

  {
    entity_type: 'connection_alias',
    order: 14,
    materializable: true,
    summarizable: true,
    table: 'asdlc_integration',
    pk: 'integration_id',
    slugPrefix: 'ALI',
    nameKeys: ['name'],
    tool: {
      name: 'extract_connection_alias',
      description: 'Extract a Connection & Credential Alias — a named handle that integrations use to reference a connection/credential pair without hard-coding instance-specific values. Maps to asdlc_integration with integration_type=connection_alias. SDK v4.8+: deployable via Alias() Fluent API.',
      properties: {
        integration_type: { type: 'string', enum: ['connection_alias'], description: 'Always connection_alias for this tool' },
        name:             { type: 'string', description: 'Display name of the alias, e.g. "SAP Connection"' },
        description:      { type: 'string', description: 'Purpose of this connection alias' },
        alias_type:       { type: 'string', enum: ['connection','credential'], description: 'Whether it holds a connection+credential pair or credential only' },
        connection_type:  { type: 'string', enum: ['httpConnection','jdbcConnection','basicConnection','jmsConnection'], description: 'Underlying connection protocol' },
        notes:            { type: 'string', description: 'Additional notes or context' },
        ...PROVENANCE_FIELDS,
      },
      required: ['name', 'integration_type'],
    },
    fieldMap: {
      integration_type: { col: 'integration_type' },
      name:             { col: 'name' },
      description:      { col: 'description' },
      alias_type:       { col: 'alias_type' },
      connection_type:  { col: 'connection_type' },
      notes:            { col: 'notes' },
      ...PROVENANCE_FIELDMAP,
    },
    parentLinks: [],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CONFIG-DRIVEN Tier-A design entities (2026-06-25). Each carries a `display`
  // block — the single declaration that projects to RT_DESIGN (auto CRUD + audit),
  // the build spec, the /design-entity-catalog endpoint (frontend renders generically),
  // and Deployment Guidance. Adding another Tier-A entity = one entry like these + one
  // table. `display.fields[].type` is constrained to the edit-modal vocabulary
  // (text|textarea|number|select|json-list|json); json-list ⇄ fieldMap json:true.
  // ═══════════════════════════════════════════════════════════════════════════
  {
    entity_type: 'dashboard',
    order: 15,
    materializable: true,
    summarizable: true,
    table: 'asdlc_dashboard',
    pk: 'dashboard_id',
    slugPrefix: 'DASH',
    nameKeys: ['name'],
    display: {
      scope_id: 'dashboards', data_key: 'dashboards', label: 'Dashboard', group: 'information',
      sdk_deployable: true, source_table: 'par_dashboard',
      id_key: 'dashboard_id', name_key: 'name', rest_path: 'dashboards',
      fields: [
        { key: 'name',     label: 'Name',                   type: 'text' },
        { key: 'purpose',  label: 'Purpose',                type: 'textarea' },
        { key: 'audience', label: 'Audience',               type: 'text' },
        { key: 'widgets',  label: 'Widgets (one per line)', type: 'json-list' },
        { key: 'refresh',  label: 'Refresh Cadence',        type: 'select', options: ['realtime','hourly','daily','weekly','monthly'] },
      ],
    },
    tool: {
      name: 'extract_dashboard',
      description: 'Extract a dashboard — a curated set of visualizations/widgets for a defined audience. Design intent only (what it shows + for whom), not the implementation. Maps to asdlc_dashboard (ServiceNow par_dashboard).',
      properties: {
        name:     { type: 'string', description: 'Name of the dashboard' },
        purpose:  { type: 'string', description: 'What decisions or questions this dashboard supports' },
        audience: { type: 'string', description: 'Who uses it — role(s) or team(s)' },
        widgets:  { type: 'array', items: { type: 'string' }, description: 'The visualizations/widgets shown, one per entry (business description)' },
        refresh:  { type: 'string', description: 'How fresh the data must be: realtime, hourly, daily, weekly, monthly' },
        ...PROVENANCE_FIELDS,
      },
      required: ['name'],
    },
    fieldMap: {
      name:     { col: 'name' },
      purpose:  { col: 'purpose' },
      audience: { col: 'audience' },
      widgets:  { col: 'widgets', json: true },
      refresh:  { col: 'refresh' },
      ...PROVENANCE_FIELDMAP,
    },
    parentLinks: [],
  },

  {
    entity_type: 'report',
    order: 16,
    materializable: true,
    summarizable: true,
    table: 'asdlc_report',
    pk: 'report_id',
    slugPrefix: 'RPT',
    nameKeys: ['name'],
    display: {
      scope_id: 'reports', data_key: 'reports', label: 'Report', group: 'information',
      sdk_deployable: false, source_table: 'sys_report',
      id_key: 'report_id', name_key: 'name', rest_path: 'reports',
      fields: [
        { key: 'name',           label: 'Name',                   type: 'text' },
        { key: 'purpose',        label: 'Purpose',                type: 'textarea' },
        { key: 'reported_table', label: 'Source Table',           type: 'text' },
        { key: 'report_columns', label: 'Columns (one per line)', type: 'json-list' },
        { key: 'filters',        label: 'Filters / Conditions',   type: 'textarea' },
        { key: 'format',         label: 'Format',                 type: 'select', options: ['list','bar','pie','line','pivot','single_score','calendar','map'] },
      ],
    },
    tool: {
      name: 'extract_report',
      description: 'Extract a report — a saved view over a table with chosen columns, filters and a presentation format. Design intent only. Maps to asdlc_report (ServiceNow sys_report). NOT deployable via now-sdk — requires Update Set or manual config.',
      properties: {
        name:           { type: 'string', description: 'Name of the report' },
        purpose:        { type: 'string', description: 'What question this report answers' },
        reported_table: { type: 'string', description: 'Business label or table name the report runs against' },
        report_columns: { type: 'array', items: { type: 'string' }, description: 'Columns/fields displayed, one per entry' },
        filters:        { type: 'string', description: 'Filter conditions in plain English' },
        format:         { type: 'string', description: 'Presentation: list, bar, pie, line, pivot, single_score, calendar, map' },
        ...PROVENANCE_FIELDS,
      },
      required: ['name'],
    },
    fieldMap: {
      name:           { col: 'name' },
      purpose:        { col: 'purpose' },
      reported_table: { col: 'reported_table' },
      report_columns: { col: 'report_columns', json: true },
      filters:        { col: 'filters' },
      format:         { col: 'format' },
      ...PROVENANCE_FIELDMAP,
    },
    parentLinks: [],
  },

  {
    entity_type: 'kpi',
    order: 17,
    materializable: true,
    summarizable: true,
    table: 'asdlc_kpi',
    pk: 'kpi_id',
    slugPrefix: 'KPI',
    nameKeys: ['name'],
    display: {
      scope_id: 'kpis', data_key: 'kpis', label: 'KPI', group: 'information',
      sdk_deployable: false, source_table: 'pa_indicator',
      id_key: 'kpi_id', name_key: 'name', rest_path: 'kpis',
      fields: [
        { key: 'name',        label: 'Name',        type: 'text' },
        { key: 'metric',      label: 'Metric',      type: 'textarea' },
        { key: 'unit',        label: 'Unit',        type: 'text' },
        { key: 'target',      label: 'Target',      type: 'text' },
        { key: 'direction',   label: 'Direction',   type: 'select', options: ['increase','decrease','maintain'] },
        { key: 'frequency',   label: 'Frequency',   type: 'select', options: ['realtime','daily','weekly','monthly','quarterly'] },
        { key: 'data_source', label: 'Data Source', type: 'text' },
      ],
    },
    tool: {
      name: 'extract_kpi',
      description: 'Extract a KPI / Performance Analytics indicator — a measurable metric with a target and direction. Design intent only. Maps to asdlc_kpi (ServiceNow pa_indicator). NOT deployable via now-sdk — requires manual config.',
      properties: {
        name:        { type: 'string', description: 'Name of the KPI/indicator' },
        metric:      { type: 'string', description: 'What is being measured, in business terms' },
        unit:        { type: 'string', description: 'Unit of measure — %, count, hours, GBP, score, etc.' },
        target:      { type: 'string', description: 'Target value or threshold' },
        direction:   { type: 'string', description: 'Whether good means increase, decrease, or maintain' },
        frequency:   { type: 'string', description: 'Measurement cadence: realtime, daily, weekly, monthly, quarterly' },
        data_source: { type: 'string', description: 'Where the underlying data comes from (table/source)' },
        ...PROVENANCE_FIELDS,
      },
      required: ['name'],
    },
    fieldMap: {
      name:        { col: 'name' },
      metric:      { col: 'metric' },
      unit:        { col: 'unit' },
      target:      { col: 'target' },
      direction:   { col: 'direction' },
      frequency:   { col: 'frequency' },
      data_source: { col: 'data_source' },
      ...PROVENANCE_FIELDMAP,
    },
    parentLinks: [],
  },

  // ── NL rules (Workbench-native differentiator). Two entity types share ONE table
  //    (asdlc_nl_rule), discriminated by rule_kind via staticColumns. PO-authored AND
  //    AI-reverse-engineered from sys_script (status='reverse_engineered'). Plain English
  //    only — never code. sdk_deployable:false (they drive code, they are not code).
  {
    entity_type: 'nl_business_rule',
    order: 18,
    materializable: true,
    summarizable: true,
    staticColumns: { rule_kind: 'business' },
    table: 'asdlc_nl_rule',
    pk: 'nl_rule_id',
    slugPrefix: 'NLR',
    nameKeys: ['name'],
    display: {
      scope_id: 'nl-business-rules', data_key: 'nl_business_rules', label: 'NL Business Rule', group: 'logic',
      sdk_deployable: false, source_table: null,
      id_key: 'nl_rule_id', name_key: 'name', rest_path: 'nl-business-rules',
      fields: [
        { key: 'name',            label: 'Name',                 type: 'text' },
        { key: 'rule_text',       label: 'Rule (plain English)', type: 'textarea' },
        { key: 'linked_table',    label: 'Applies to Table',     type: 'text' },
        { key: 'linked_workflow', label: 'Related Workflow',     type: 'text' },
        { key: 'status',          label: 'Status',               type: 'select', options: ['authored','reverse_engineered','needs_review'] },
        { key: 'rationale',       label: 'Rationale',            type: 'textarea' },
      ],
    },
    tool: {
      name: 'extract_nl_business_rule',
      description: 'Extract a business rule stated in PLAIN ENGLISH (not code) — a "when X then Y" policy the system must enforce. Maps to asdlc_nl_rule (rule_kind=business). Capture the intent; do not write or restate any script.',
      properties: {
        name:            { type: 'string', description: 'Short name for the rule' },
        rule_text:       { type: 'string', description: 'The full rule in plain English, e.g. "When an invoice exceeds £10,000 it must be approved by a manager before payment."' },
        linked_table:    { type: 'string', description: 'Business label or table name the rule applies to, if stated' },
        linked_workflow: { type: 'string', description: 'Workflow/process this rule governs, if stated' },
        rationale:       { type: 'string', description: 'Why the rule exists (policy/regulation/business reason)' },
        ...PROVENANCE_FIELDS,
      },
      required: ['name', 'rule_text'],
    },
    fieldMap: {
      name:            { col: 'name' },
      rule_text:       { col: 'rule_text' },
      linked_table:    { col: 'linked_table' },
      linked_workflow: { col: 'linked_workflow' },
      status:          { col: 'status' },
      rationale:       { col: 'rationale' },
      ...PROVENANCE_FIELDMAP,
    },
    parentLinks: [],
  },

  {
    entity_type: 'nl_validation_rule',
    order: 19,
    materializable: true,
    summarizable: true,
    staticColumns: { rule_kind: 'validation' },
    table: 'asdlc_nl_rule',
    pk: 'nl_rule_id',
    slugPrefix: 'NLR',
    nameKeys: ['name'],
    display: {
      scope_id: 'nl-validation-rules', data_key: 'nl_validation_rules', label: 'NL Validation Rule', group: 'logic',
      sdk_deployable: false, source_table: null,
      id_key: 'nl_rule_id', name_key: 'name', rest_path: 'nl-validation-rules',
      fields: [
        { key: 'name',         label: 'Name',                       type: 'text' },
        { key: 'rule_text',    label: 'Validation (plain English)', type: 'textarea' },
        { key: 'linked_table', label: 'Table',                      type: 'text' },
        { key: 'linked_field', label: 'Field',                      type: 'text' },
        { key: 'status',       label: 'Status',                     type: 'select', options: ['authored','reverse_engineered','needs_review'] },
        { key: 'rationale',    label: 'Rationale',                  type: 'textarea' },
      ],
    },
    tool: {
      name: 'extract_nl_validation_rule',
      description: 'Extract a field/data validation rule stated in PLAIN ENGLISH — a constraint on what values are allowed. Maps to asdlc_nl_rule (rule_kind=validation). Capture the intent; never write code.',
      properties: {
        name:         { type: 'string', description: 'Short name for the validation' },
        rule_text:    { type: 'string', description: 'The validation in plain English, e.g. "Start date must be before end date."' },
        linked_table: { type: 'string', description: 'Business label or table name, if stated' },
        linked_field: { type: 'string', description: 'Field the validation applies to, if stated' },
        rationale:    { type: 'string', description: 'Why the validation exists' },
        ...PROVENANCE_FIELDS,
      },
      required: ['name', 'rule_text'],
    },
    fieldMap: {
      name:         { col: 'name' },
      rule_text:    { col: 'rule_text' },
      linked_table: { col: 'linked_table' },
      linked_field: { col: 'linked_field' },
      status:       { col: 'status' },
      rationale:    { col: 'rationale' },
      ...PROVENANCE_FIELDMAP,
    },
    parentLinks: [],
  },

  // ── Wave 2 (2026-06-25): five flat config-driven Tier-A entities. Same engine as
  //    above — one display block + one table each. Process & SLAs + Platform Config. ─
  {
    entity_type: 'sla_definition',
    order: 20,
    materializable: true,
    summarizable: true,
    table: 'asdlc_sla_definition',
    pk: 'sla_definition_id',
    slugPrefix: 'SLA',
    nameKeys: ['name'],
    display: {
      scope_id: 'sla-definitions', data_key: 'sla_definitions', label: 'SLA Definition', group: 'process',
      sdk_deployable: true, source_table: 'contract_sla',
      id_key: 'sla_definition_id', name_key: 'name', rest_path: 'sla-definitions',
      fields: [
        { key: 'name',            label: 'Name',                       type: 'text' },
        { key: 'applies_to',      label: 'Applies To (table/records)', type: 'text' },
        { key: 'sla_type',        label: 'Type',                       type: 'select', options: ['response','resolution','custom'] },
        { key: 'target',          label: 'Target (e.g. 4 business hours)', type: 'text' },
        { key: 'start_condition', label: 'Start Condition',            type: 'textarea' },
        { key: 'stop_condition',  label: 'Stop Condition',             type: 'textarea' },
        { key: 'schedule',        label: 'Schedule (e.g. 8x5)',        type: 'text' },
      ],
    },
    tool: {
      name: 'extract_sla_definition',
      description: 'Extract an SLA definition — a measurable service-level commitment (response/resolution target, start/stop conditions, schedule). Maps to asdlc_sla_definition (ServiceNow contract_sla).',
      properties: {
        name:            { type: 'string', description: 'Name of the SLA' },
        applies_to:      { type: 'string', description: 'Table or records this SLA governs' },
        sla_type:        { type: 'string', description: 'response, resolution, or custom' },
        target:          { type: 'string', description: 'The commitment, e.g. "Resolve within 4 business hours"' },
        start_condition: { type: 'string', description: 'When the SLA clock starts, in plain English' },
        stop_condition:  { type: 'string', description: 'When the SLA clock stops, in plain English' },
        schedule:        { type: 'string', description: 'Schedule the SLA runs against, e.g. "8x5 business hours"' },
        ...PROVENANCE_FIELDS,
      },
      required: ['name'],
    },
    fieldMap: {
      name:            { col: 'name' },
      applies_to:      { col: 'applies_to' },
      sla_type:        { col: 'sla_type' },
      target:          { col: 'target' },
      start_condition: { col: 'start_condition' },
      stop_condition:  { col: 'stop_condition' },
      schedule:        { col: 'schedule' },
      ...PROVENANCE_FIELDMAP,
    },
    parentLinks: [],
  },

  {
    entity_type: 'email_notification',
    order: 21,
    materializable: true,
    summarizable: true,
    table: 'asdlc_email_notification',
    pk: 'email_notification_id',
    slugPrefix: 'NOTIF',
    nameKeys: ['name'],
    display: {
      scope_id: 'email-notifications', data_key: 'email_notifications', label: 'Email Notification', group: 'configuration',
      sdk_deployable: true, source_table: 'sysevent_email_action',
      id_key: 'email_notification_id', name_key: 'name', rest_path: 'email-notifications',
      fields: [
        { key: 'name',          label: 'Name',                     type: 'text' },
        { key: 'trigger_event', label: 'Trigger (when it sends)',  type: 'textarea' },
        { key: 'recipients',    label: 'Recipients',               type: 'text' },
        { key: 'applies_to',    label: 'Applies To (table)',       type: 'text' },
        { key: 'subject',       label: 'Subject',                  type: 'text' },
        { key: 'body_summary',  label: 'Message (plain English)',  type: 'textarea' },
      ],
    },
    tool: {
      name: 'extract_email_notification',
      description: 'Extract an email notification — when it fires, who receives it, and what it says. Maps to asdlc_email_notification (ServiceNow sysevent_email_action).',
      properties: {
        name:          { type: 'string', description: 'Name of the notification' },
        trigger_event: { type: 'string', description: 'Event/condition that triggers it, in plain English' },
        recipients:    { type: 'string', description: 'Who receives it (roles, users, fields)' },
        applies_to:    { type: 'string', description: 'Table/record type it relates to' },
        subject:       { type: 'string', description: 'Email subject line' },
        body_summary:  { type: 'string', description: 'What the message communicates, in plain English' },
        ...PROVENANCE_FIELDS,
      },
      required: ['name'],
    },
    fieldMap: {
      name:          { col: 'name' },
      trigger_event: { col: 'trigger_event' },
      recipients:    { col: 'recipients' },
      applies_to:    { col: 'applies_to' },
      subject:       { col: 'subject' },
      body_summary:  { col: 'body_summary' },
      ...PROVENANCE_FIELDMAP,
    },
    parentLinks: [],
  },

  {
    entity_type: 'user_group',
    order: 22,
    materializable: true,
    summarizable: true,
    table: 'asdlc_user_group',
    pk: 'user_group_id',
    slugPrefix: 'GRP',
    nameKeys: ['name'],
    display: {
      scope_id: 'user-groups', data_key: 'user_groups', label: 'User Group', group: 'configuration',
      sdk_deployable: false, source_table: 'sys_user_group',
      id_key: 'user_group_id', name_key: 'name', rest_path: 'user-groups',
      fields: [
        { key: 'name',          label: 'Name',                          type: 'text' },
        { key: 'purpose',       label: 'Purpose',                       type: 'textarea' },
        { key: 'members',       label: 'Members (who belongs)',         type: 'text' },
        { key: 'roles_granted', label: 'Roles Granted (one per line)',  type: 'json-list' },
        { key: 'manager',       label: 'Manager',                       type: 'text' },
      ],
    },
    tool: {
      name: 'extract_user_group',
      description: 'Extract a user group — a named collection of users that grants roles and routes work. Maps to asdlc_user_group (ServiceNow sys_user_group). NOT now-sdk deployable.',
      properties: {
        name:          { type: 'string', description: 'Name of the group' },
        purpose:       { type: 'string', description: 'What the group is for' },
        members:       { type: 'string', description: 'Who belongs (roles, teams, named people)' },
        roles_granted: { type: 'array', items: { type: 'string' }, description: 'Roles this group grants, one per entry' },
        manager:       { type: 'string', description: 'Group manager/owner' },
        ...PROVENANCE_FIELDS,
      },
      required: ['name'],
    },
    fieldMap: {
      name:          { col: 'name' },
      purpose:       { col: 'purpose' },
      members:       { col: 'members' },
      roles_granted: { col: 'roles_granted', json: true },
      manager:       { col: 'manager' },
      ...PROVENANCE_FIELDMAP,
    },
    parentLinks: [],
  },

  {
    entity_type: 'catalog_category',
    order: 23,
    materializable: true,
    summarizable: true,
    table: 'asdlc_catalog_category',
    pk: 'catalog_category_id',
    slugPrefix: 'CATG',
    nameKeys: ['name'],
    display: {
      scope_id: 'catalog-categories', data_key: 'catalog_categories', label: 'Catalog Category', group: 'configuration',
      sdk_deployable: false, source_table: 'sc_category',
      id_key: 'catalog_category_id', name_key: 'name', rest_path: 'catalog-categories',
      fields: [
        { key: 'name',            label: 'Name',             type: 'text' },
        { key: 'description',     label: 'Description',      type: 'textarea' },
        { key: 'catalog',         label: 'Catalog',          type: 'text' },
        { key: 'parent_category', label: 'Parent Category',  type: 'text' },
      ],
    },
    tool: {
      name: 'extract_catalog_category',
      description: 'Extract a Service Catalog category — how catalog items are grouped for browsing. Maps to asdlc_catalog_category (ServiceNow sc_category). NOT now-sdk deployable.',
      properties: {
        name:            { type: 'string', description: 'Category name' },
        description:     { type: 'string', description: 'What this category contains' },
        catalog:         { type: 'string', description: 'Which catalog it belongs to' },
        parent_category: { type: 'string', description: 'Parent category, if nested' },
        ...PROVENANCE_FIELDS,
      },
      required: ['name'],
    },
    fieldMap: {
      name:            { col: 'name' },
      description:     { col: 'description' },
      catalog:         { col: 'catalog' },
      parent_category: { col: 'parent_category' },
      ...PROVENANCE_FIELDMAP,
    },
    parentLinks: [],
  },

  {
    entity_type: 'choice_set',
    order: 24,
    materializable: true,
    summarizable: true,
    table: 'asdlc_choice_set',
    pk: 'choice_set_id',
    slugPrefix: 'CHO',
    nameKeys: ['name'],
    display: {
      scope_id: 'choice-sets', data_key: 'choice_sets', label: 'Choice Set', group: 'configuration',
      sdk_deployable: false, source_table: 'sys_choice',
      id_key: 'choice_set_id', name_key: 'name', rest_path: 'choice-sets',
      fields: [
        { key: 'name',          label: 'Name / Field Label',       type: 'text' },
        { key: 'applies_to',    label: 'Applies To (table.field)', type: 'text' },
        { key: 'choices',       label: 'Values (one per line)',    type: 'json-list' },
        { key: 'default_value', label: 'Default Value',            type: 'text' },
      ],
    },
    tool: {
      name: 'extract_choice_set',
      description: 'Extract a choice/picklist value set — the allowed values for a field. Maps to asdlc_choice_set (ServiceNow sys_choice). NOT now-sdk deployable.',
      properties: {
        name:          { type: 'string', description: 'Choice set name or the field it applies to' },
        applies_to:    { type: 'string', description: 'Table.field this choice set governs' },
        choices:       { type: 'array', items: { type: 'string' }, description: 'Allowed values, one per entry' },
        default_value: { type: 'string', description: 'Default value, if any' },
        ...PROVENANCE_FIELDS,
      },
      required: ['name'],
    },
    fieldMap: {
      name:          { col: 'name' },
      applies_to:    { col: 'applies_to' },
      choices:       { col: 'choices', json: true },
      default_value: { col: 'default_value' },
      ...PROVENANCE_FIELDMAP,
    },
    parentLinks: [],
  },

  // ── Wave 3 (2026-06-25): four NESTED config-driven Tier-A entities. Each carries a
  //    `display.children` descriptor — a JSON-array field rendered as a sub-table (same
  //    pattern as data_model.fields / catalog_item.variables). All SDK-deployable. ─────
  {
    entity_type: 'service_portal',
    order: 25,
    materializable: true,
    summarizable: true,
    table: 'asdlc_service_portal',
    pk: 'service_portal_id',
    slugPrefix: 'PORTAL',
    nameKeys: ['name'],
    display: {
      scope_id: 'service-portals', data_key: 'service_portals', label: 'Service Portal', group: 'ux',
      sdk_deployable: true, source_table: 'sp_portal',
      id_key: 'service_portal_id', name_key: 'name', rest_path: 'service-portals',
      fields: [
        { key: 'name',     label: 'Name',     type: 'text' },
        { key: 'title',    label: 'Title',    type: 'text' },
        { key: 'homepage', label: 'Homepage', type: 'text' },
        { key: 'theme',    label: 'Theme',    type: 'text' },
        { key: 'purpose',  label: 'Purpose',  type: 'textarea' },
        { key: 'pages',    label: 'Pages',    type: 'json' },
      ],
      children: { key: 'pages', label: 'Pages', columns: [
        { key: 'title', label: 'Title' }, { key: 'route', label: 'Route' }, { key: 'purpose', label: 'Purpose' },
      ] },
    },
    tool: {
      name: 'extract_service_portal',
      description: 'Extract a Service Portal — a public/employee-facing portal, its theme, homepage, and its pages. Maps to asdlc_service_portal (ServiceNow sp_portal).',
      properties: {
        name:     { type: 'string', description: 'Internal name of the portal' },
        title:    { type: 'string', description: 'Display title shown to users' },
        homepage: { type: 'string', description: 'Landing page / homepage route' },
        theme:    { type: 'string', description: 'Theme / branding' },
        purpose:  { type: 'string', description: 'What the portal is for and who uses it' },
        pages:    { type: 'array', description: 'Pages in the portal', items: { type: 'object', properties: {
          title:   { type: 'string', description: 'Page title' },
          route:   { type: 'string', description: 'URL route / id' },
          purpose: { type: 'string', description: 'What the page shows' },
        } } },
        ...PROVENANCE_FIELDS,
      },
      required: ['name'],
    },
    fieldMap: {
      name:     { col: 'name' },
      title:    { col: 'title' },
      homepage: { col: 'homepage' },
      theme:    { col: 'theme' },
      purpose:  { col: 'purpose' },
      pages:    { col: 'pages', json: true },
      ...PROVENANCE_FIELDMAP,
    },
    parentLinks: [],
  },

  {
    entity_type: 'workspace',
    order: 26,
    materializable: true,
    summarizable: true,
    table: 'asdlc_workspace',
    pk: 'workspace_id',
    slugPrefix: 'WS',
    nameKeys: ['name'],
    display: {
      scope_id: 'workspaces', data_key: 'workspaces', label: 'Workspace', group: 'ux',
      sdk_deployable: true, source_table: 'sys_ux_page_registry',
      id_key: 'workspace_id', name_key: 'name', rest_path: 'workspaces',
      fields: [
        { key: 'name',          label: 'Name',                 type: 'text' },
        { key: 'purpose',       label: 'Purpose',              type: 'textarea' },
        { key: 'primary_table', label: 'Primary Table',        type: 'text' },
        { key: 'lists',         label: 'Lists / Tabs',         type: 'json' },
      ],
      children: { key: 'lists', label: 'Lists / Tabs', columns: [
        { key: 'name', label: 'Name' }, { key: 'table', label: 'Table' }, { key: 'purpose', label: 'Purpose' },
      ] },
    },
    tool: {
      name: 'extract_workspace',
      description: 'Extract a Next Experience workspace — an agent/fulfiller working surface, its primary table, and the lists/tabs it presents. Maps to asdlc_workspace (ServiceNow sys_ux_page_registry).',
      properties: {
        name:          { type: 'string', description: 'Workspace name' },
        purpose:       { type: 'string', description: 'Who uses it and for what' },
        primary_table: { type: 'string', description: 'Main table the workspace operates on' },
        lists:         { type: 'array', description: 'Lists/tabs shown', items: { type: 'object', properties: {
          name:    { type: 'string', description: 'List/tab name' },
          table:   { type: 'string', description: 'Table it shows' },
          purpose: { type: 'string', description: 'What it is for' },
        } } },
        ...PROVENANCE_FIELDS,
      },
      required: ['name'],
    },
    fieldMap: {
      name:          { col: 'name' },
      purpose:       { col: 'purpose' },
      primary_table: { col: 'primary_table' },
      lists:         { col: 'lists', json: true },
      ...PROVENANCE_FIELDMAP,
    },
    parentLinks: [],
  },

  {
    entity_type: 'variable_set',
    order: 27,
    materializable: true,
    summarizable: true,
    table: 'asdlc_variable_set',
    pk: 'variable_set_id',
    slugPrefix: 'VSET',
    nameKeys: ['name'],
    display: {
      scope_id: 'variable-sets', data_key: 'variable_sets', label: 'Variable Set', group: 'ux',
      sdk_deployable: true, source_table: 'item_option_new_set',
      id_key: 'variable_set_id', name_key: 'name', rest_path: 'variable-sets',
      fields: [
        { key: 'name',       label: 'Name',                       type: 'text' },
        { key: 'purpose',    label: 'Purpose',                    type: 'textarea' },
        { key: 'applies_to', label: 'Used By (catalog items)',    type: 'text' },
        { key: 'variables',  label: 'Variables',                  type: 'json' },
      ],
      children: { key: 'variables', label: 'Variables', columns: [
        { key: 'label', label: 'Label' }, { key: 'type', label: 'Type' }, { key: 'mandatory', label: 'Mandatory' },
      ] },
    },
    tool: {
      name: 'extract_variable_set',
      description: 'Extract a reusable Variable Set — a named group of catalog variables shared across catalog items. Maps to asdlc_variable_set (ServiceNow item_option_new_set).',
      properties: {
        name:       { type: 'string', description: 'Variable set name' },
        purpose:    { type: 'string', description: 'What the set captures and why it is reusable' },
        applies_to: { type: 'string', description: 'Catalog items / record producers that use this set' },
        variables:  { type: 'array', description: 'The variables in the set', items: { type: 'object', properties: {
          label:     { type: 'string', description: 'Variable label' },
          type:      { type: 'string', description: 'text, choice, reference, date, yes/no, etc.' },
          mandatory: { type: 'boolean', description: 'Whether it is required' },
        } } },
        ...PROVENANCE_FIELDS,
      },
      required: ['name'],
    },
    fieldMap: {
      name:       { col: 'name' },
      purpose:    { col: 'purpose' },
      applies_to: { col: 'applies_to' },
      variables:  { col: 'variables', json: true },
      ...PROVENANCE_FIELDMAP,
    },
    parentLinks: [],
  },

  {
    entity_type: 'inbound_rest_api',
    order: 28,
    materializable: true,
    summarizable: true,
    table: 'asdlc_inbound_rest_api',
    pk: 'inbound_rest_api_id',
    slugPrefix: 'API',
    nameKeys: ['name'],
    display: {
      scope_id: 'inbound-rest-apis', data_key: 'inbound_rest_apis', label: 'Inbound REST API', group: 'integration',
      sdk_deployable: true, source_table: 'sys_ws_definition',
      id_key: 'inbound_rest_api_id', name_key: 'name', rest_path: 'inbound-rest-apis',
      fields: [
        { key: 'name',      label: 'Name',                  type: 'text' },
        { key: 'base_path', label: 'Base Path',             type: 'text' },
        { key: 'auth',      label: 'Authentication',        type: 'text' },
        { key: 'purpose',   label: 'Purpose',               type: 'textarea' },
        { key: 'resources', label: 'Resources',             type: 'json' },
      ],
      children: { key: 'resources', label: 'Resources', columns: [
        { key: 'name', label: 'Name' }, { key: 'method', label: 'Method' }, { key: 'path', label: 'Path' }, { key: 'purpose', label: 'Purpose' },
      ] },
    },
    tool: {
      name: 'extract_inbound_rest_api',
      description: 'Extract a Scripted REST API the app EXPOSES — its base path, auth, and resource operations. Maps to asdlc_inbound_rest_api (ServiceNow sys_ws_definition). Distinct from rest_message (an OUTBOUND call the app makes).',
      properties: {
        name:      { type: 'string', description: 'API name' },
        base_path: { type: 'string', description: 'Base API path, e.g. /api/x_app/orders' },
        auth:      { type: 'string', description: 'How callers authenticate' },
        purpose:   { type: 'string', description: 'What the API is for and who calls it' },
        resources: { type: 'array', description: 'Resource operations exposed', items: { type: 'object', properties: {
          name:    { type: 'string', description: 'Resource/operation name' },
          method:  { type: 'string', description: 'HTTP method (GET/POST/PUT/PATCH/DELETE)' },
          path:    { type: 'string', description: 'Relative path' },
          purpose: { type: 'string', description: 'What it does' },
        } } },
        ...PROVENANCE_FIELDS,
      },
      required: ['name'],
    },
    fieldMap: {
      name:      { col: 'name' },
      base_path: { col: 'base_path' },
      auth:      { col: 'auth' },
      purpose:   { col: 'purpose' },
      resources: { col: 'resources', json: true },
      ...PROVENANCE_FIELDMAP,
    },
    parentLinks: [],
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
      best_practice_ref:   { col: 'best_practice_ref' },
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
  // ── test_scenario (legacy alias, order 55 — non-materializable) ─────────────
  // Pre-2026 entity type name, superseded by test_case. 18 CPI rows exist with
  // this type; they are intentionally captured as supporting evidence (no table).
  // Registering explicitly so the apply handler logs a clean label instead of
  // treating it as an unknown type.
  {
    entity_type: 'test_scenario',
    order: 55, materializable: false, summarizable: false,
    nameKeys: ['title'],
    tool: {
      name: 'extract_test_scenario',
      description: 'Legacy alias for test_case (pre-2026). Do not use in new extractions.',
      properties: {
        title: { type: 'string', description: 'Scenario title' },
      },
      required: ['title'],
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

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG-DRIVEN DESIGN-ENTITY PROJECTIONS (2026-06-25)
// A registry entry that carries a `display` block is the single declaration that
// projects to: RT_DESIGN (auto CRUD + audit), the build spec, the frontend catalog,
// and Deployment Guidance. These helpers derive each projection from that one block.
// ─────────────────────────────────────────────────────────────────────────────

/** Registry entries that carry a display block AND have a real table. */
function entitiesWithDisplay() {
  return REGISTRY.filter(e => e.display && e.materializable && e.table);
}

/** Derive an RT_DESIGN spec ({table,pk,key,entity_type,json,allowed,enums}) from a
 *  display-bearing entry, so server.js auto-generates list/get/PUT + audit CP for it. */
function rtDesignSpec(e) {
  const colOf   = (k) => (e.fieldMap[k] && e.fieldMap[k].col) || k;
  const json    = Object.values(e.fieldMap).filter(m => m.json).map(m => m.col);
  const allowed = e.display.fields.map(f => colOf(f.key));
  const enums   = {};
  for (const f of e.display.fields) {
    if (f.type === 'select' && Array.isArray(f.options)) enums[colOf(f.key)] = f.options;
  }
  return { table: e.table, pk: e.pk, key: e.display.data_key, entity_type: e.entity_type, json, allowed, enums };
}

/** Frontend-facing catalog projection: everything design_review.js needs to render
 *  and edit a new entity generically (no kebab/snake guessing — emitted explicitly). */
function designEntityCatalog() {
  return entitiesWithDisplay().map(e => ({
    scope_id:       e.display.scope_id,
    data_key:       e.display.data_key,
    entity_type:    e.entity_type,
    label:          e.display.label,
    group:          e.display.group || 'design',
    sdk_deployable: !!e.display.sdk_deployable,
    source_table:   e.display.source_table || null,
    id_key:         e.display.id_key || e.pk,
    name_key:       e.display.name_key || 'name',
    rest_path:      e.display.rest_path || e.display.scope_id,
    fields:         e.display.fields.map(f => ({ key: f.key, label: f.label, type: f.type, options: f.options || undefined })),
    // Nested child collection (a JSON-array field rendered as a sub-table), if any.
    children:       e.display.children || null,
  }));
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
  entitiesWithDisplay,
  rtDesignSpec,
  designEntityCatalog,
};
