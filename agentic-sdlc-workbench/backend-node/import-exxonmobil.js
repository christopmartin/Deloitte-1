// import-exxonmobil.js
//
// Direct DB import for the ExxonMobil Agentic Invoice Lookup Phase 1 design.
// Reads the pre-extracted workbench_extraction.json and writes all entities
// directly into the SQLite database — no Anthropic API key required.
//
// Usage:  node import-exxonmobil.js
// Safe to re-run — fully idempotent via INSERT OR IGNORE + check-before-insert.
//
'use strict';

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { db, generateId } = require('./db');

// ── Source file ───────────────────────────────────────────────────────────────
const EXTRACTION_FILE = path.join(
  'C:\\Users\\christopmartin\\Downloads\\files',
  'exxonmobil_invoice_lookup_workbench_extraction.json'
);
const MD_FILE = path.join(
  'C:\\Users\\christopmartin\\Downloads\\files',
  'exxonmobil_invoice_lookup_phase1_design.md'
);

if (!fs.existsSync(EXTRACTION_FILE)) {
  console.error(`[import] ERROR: Extraction file not found:\n  ${EXTRACTION_FILE}`);
  process.exit(1);
}

const ex = JSON.parse(fs.readFileSync(EXTRACTION_FILE, 'utf8'));

// ── Fixed IDs ─────────────────────────────────────────────────────────────────
// EE-prefixed — safe alongside existing seed data (ACME/BetaCo/Gamma use 11/22/33... prefix)
const C_EXXON   = 'EE000000-0000-0000-0000-000000000001'; // ExxonMobil client
const P_EXX     = 'EE000000-0000-0000-0000-000000000010'; // Agentic Invoice Lookup project
const MBR_CHRIS = 'EE000000-0000-0000-0000-000000000015'; // Chris H. as project member
const EV_ID     = 'EE000000-0000-0000-0000-000000000020'; // evidence source
const INGEST_ID = 'EE000000-0000-0000-0000-000000000030'; // ingest document record
const UC_ID     = 'EE000000-0000-0000-0000-000000000040'; // use case
const WF_ID     = 'EE000000-0000-0000-0000-000000000050'; // workflow
const STEP_IDS  = [1,2,3,4,5,6].map(n => `EE000000-0000-0000-0000-00000000006${n}`);
const HITL_ID   = 'EE000000-0000-0000-0000-000000000070'; // hitl gate
const AGNT_ID   = 'EE000000-0000-0000-0000-000000000080'; // agent spec
const TOOL_IDS  = [1,2,3,4].map(n => `EE000000-0000-0000-0000-00000000009${n}`);
const CP_IDS    = ['A1','A2','A3','A4','A5','A6','A7','A8','A9','AA']
                    .map(n => `EE000000-0000-0000-0000-0000000000${n}`);

const U1 = '11111111-0000-0000-0000-000000000001'; // Chris H. (from seed.js)

// ── Utilities ─────────────────────────────────────────────────────────────────
const log = msg  => console.log(`[import] ${msg}`);
const j   = val  => JSON.stringify(val ?? null);
const now = ()   => new Date().toISOString();

/** INSERT OR IGNORE — returns true if row was newly created */
function ior(sql, ...params) {
  return db.prepare(sql).run(...params).changes > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — Client + Project + Member
// ─────────────────────────────────────────────────────────────────────────────
log('── Step 1: Client / Project / Member ──────────────────────────');

const clientCreated = ior(`
  INSERT OR IGNORE INTO asdlc_client
    (client_id, client_name, client_code, created_by, updated_by)
  VALUES (?,?,?,?,?)
`, C_EXXON, 'ExxonMobil', 'EXXON', U1, U1);
log(`ExxonMobil client ............. ${clientCreated ? 'CREATED' : 'already exists'}`);

const projectCreated = ior(`
  INSERT OR IGNORE INTO asdlc_project
    (project_id, client_id, project_name, project_code, stage,
     confidence_threshold, created_by, updated_by)
  VALUES (?,?,?,?,?,?,?,?)
`, P_EXX, C_EXXON, 'Agentic Invoice Lookup', 'EXX-P1', 'build', 0.80, U1, U1);
log(`Project "Agentic Invoice Lookup" ${projectCreated ? 'CREATED' : 'already exists'}`);

const memberCreated = ior(`
  INSERT OR IGNORE INTO asdlc_project_member
    (project_member_id, project_id, user_id, display_name, member_role, can_approve)
  VALUES (?,?,?,?,?,?)
`, MBR_CHRIS, P_EXX, U1, 'Chris H.', 'methodology_owner', 1);
log(`Project member Chris H. ....... ${memberCreated ? 'CREATED' : 'already exists'}`);

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — Evidence Source
// ─────────────────────────────────────────────────────────────────────────────
log('── Step 2: Evidence Source ─────────────────────────────────────');

const evSrc = ex.evidence_source;
const evCreated = ior(`
  INSERT OR IGNORE INTO asdlc_evidence_source
    (evidence_source_id, project_id, source_title, source_type, source_url,
     source_datetime, ingestion_status, validation_status, notes,
     created_by, updated_by)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)
`,
  EV_ID, P_EXX,
  evSrc.source_title,
  evSrc.source_type    || 'document',
  evSrc.source_url     || '',
  evSrc.source_datetime || now(),
  evSrc.ingestion_status  || 'ingested',
  evSrc.validation_status || 'unverified',
  evSrc.notes || null,
  U1, U1
);
log(`Evidence source ............... ${evCreated ? 'CREATED' : 'already exists'}`);

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — Ingest Document
// ─────────────────────────────────────────────────────────────────────────────
log('── Step 3: Ingest Document ─────────────────────────────────────');

const ingestCreated = ior(`
  INSERT OR IGNORE INTO asdlc_ingest_document
    (ingest_id, project_id, document_title, file_name, file_type, document_type,
     description, ingest_status, uploaded_by, file_path,
     uploaded_at, created_at, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'),datetime('now'))
`,
  INGEST_ID, P_EXX,
  'ExxonMobil Invoice Lookup Phase 1 Design',
  'exxonmobil_invoice_lookup_phase1_design.md',
  'md',
  'design_document',
  'Phase 1 design document. Extracted via use-case-discovery skill May 2026. Directly imported — no extraction agent loop required.',
  'staged',
  U1,
  MD_FILE
);
log(`Ingest document ............... ${ingestCreated ? 'CREATED' : 'already exists'}`);

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4 — Structured entity tables (dedicated tables exist in schema)
// Dependency order: use_case → workflow → steps/hitl_gate → agent_spec → tools
// ─────────────────────────────────────────────────────────────────────────────
log('── Step 4: Structured Entities ─────────────────────────────────');

// ── Use Case ──
const uc = ex.use_case;
const ucCreated = ior(`
  INSERT OR IGNORE INTO asdlc_use_case
    (use_case_id, project_id, title, summary, business_objective, expected_value,
     users, volume_assumptions, urgency, success_criteria, constraints_list,
     supervision_model, next_step, readiness, created_by, updated_by)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`,
  UC_ID, P_EXX,
  uc.title,
  uc.summary,
  uc.business_objective,
  uc.expected_value,
  uc.users,
  j(uc.volume_assumptions),
  uc.urgency,
  j(uc.success_criteria),
  j(uc.constraints),           // JSON key is "constraints"; column is "constraints_list"
  uc.supervision_model || 'Assisted',
  uc.next_step || null,
  uc.readiness || 'ready_for_requirements',
  U1, U1
);
log(`Use case ...................... ${ucCreated ? 'CREATED' : 'already exists'}`);

// ── Workflow ──
const wf = ex.workflow;
const wfCreated = ior(`
  INSERT OR IGNORE INTO asdlc_workflow
    (workflow_id, use_case_id, project_id, name, trigger_def,
     handoffs, decisions, fallback_paths, readiness, created_by, updated_by)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)
`,
  WF_ID, UC_ID, P_EXX,
  wf.name,
  j(wf.trigger),               // JSON key is "trigger"; column is "trigger_def"
  j(wf.handoffs),
  j(wf.decisions),
  j(wf.fallback_paths),
  wf.readiness || 'draft',
  U1, U1
);
log(`Workflow ...................... ${wfCreated ? 'CREATED' : 'already exists'}`);

// ── Workflow Steps (6) ──
let stepsCreated = 0;
for (let i = 0; i < ex.workflow_steps.length && i < STEP_IDS.length; i++) {
  const s = ex.workflow_steps[i];
  const created = ior(`
    INSERT OR IGNORE INTO asdlc_workflow_step
      (workflow_step_id, workflow_id, project_id, step_number, name, actor_role,
       inputs, outputs, decisions_list, sla_hours, created_by, updated_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `,
    STEP_IDS[i], WF_ID, P_EXX,
    s.step_number,
    s.name,
    s.actor_role || '',
    j(s.inputs   || []),
    j(s.outputs  || []),
    j(s.decisions || []),       // JSON key is "decisions"; column is "decisions_list"
    s.sla_hours  || null,
    U1, U1
  );
  if (created) stepsCreated++;
}
log(`Workflow steps (6) ............ ${stepsCreated} CREATED, ${6 - stepsCreated} already existed`);

// ── HITL Gate ──
const hg = ex.hitl_gates[0];
const hitlCreated = ior(`
  INSERT OR IGNORE INTO asdlc_hitl_gate
    (hitl_gate_id, workflow_id, project_id, gate_type, criteria,
     owner_role, sla, handoff_mechanism, created_by, updated_by)
  VALUES (?,?,?,?,?,?,?,?,?,?)
`,
  HITL_ID, WF_ID, P_EXX,
  hg.gate_type,
  hg.criteria,
  hg.owner_role,
  hg.sla,
  hg.handoff_mechanism || '',
  U1, U1
);
log(`HITL gate ..................... ${hitlCreated ? 'CREATED' : 'already exists'}`);

// ── Agent Spec ──
const ag = ex.agent_specs[0];
const agentCreated = ior(`
  INSERT OR IGNORE INTO asdlc_agent_spec
    (agent_spec_id, use_case_id, workflow_id, project_id, name, scope,
     instructions, goals, done_criteria, inputs, outputs,
     run_as_model, memory_strategy, design_risks, created_by, updated_by)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`,
  AGNT_ID, UC_ID, WF_ID, P_EXX,
  ag.name,
  ag.scope,
  ag.instructions,
  j(ag.goals        || []),
  j(ag.done_criteria || []),
  j(ag.inputs       || {}),
  j(ag.outputs      || {}),
  j(ag.run_as_model || {}),
  ag.memory_strategy || null,
  j(ag.design_risks || []),
  U1, U1
);
log(`Agent spec .................... ${agentCreated ? 'CREATED' : 'already exists'}`);

// ── Tools (4) ──
let toolsCreated = 0;
for (let i = 0; i < ex.tools.length && i < TOOL_IDS.length; i++) {
  const t = ex.tools[i];
  const created = ior(`
    INSERT OR IGNORE INTO asdlc_tool
      (tool_id, project_id, name, contract, inputs, outputs, errors,
       access_requirements, execution_mode, cost_impact, boundaries,
       created_by, updated_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `,
    TOOL_IDS[i], P_EXX,
    t.name,
    j(t.contract           || {}),
    j(t.inputs             || {}),
    j(t.outputs            || {}),
    j(t.errors             || []),
    j(t.access_requirements || {}),
    t.execution_mode || 'sync',
    t.cost_impact    || null,
    j(t.boundaries   || []),
    U1, U1
  );
  if (created) toolsCreated++;
}
log(`Tools (4) ..................... ${toolsCreated} CREATED, ${4 - toolsCreated} already existed`);

// ─────────────────────────────────────────────────────────────────────────────
// STEP 5 — Entities without dedicated tables → asdlc_ingest_extraction
// These entity types have no dedicated schema tables in the current build.
// Stored as staged extractions; Change Packets queue them for human review.
//
// Idempotency: if extraction rows already exist for this ingest_id, read
// their IDs back instead of re-inserting (avoids duplicates on re-runs).
// ─────────────────────────────────────────────────────────────────────────────
log('── Step 5: Extraction Rows (no dedicated table) ────────────────');

const extractionGroups = [
  { type: 'guardrail',          items: ex.guardrails          || [] },
  { type: 'data_source',        items: ex.data_sources        || [] },
  { type: 'test_scenario',      items: ex.test_scenarios      || [] },
  { type: 'governance_control', items: ex.governance_controls || [] },
  { type: 'user_story',         items: ex.user_stories        || [] },
  { type: 'cost_estimate',      items: ex.cost_estimate ? [ex.cost_estimate] : [] },
];

const extractionIdsByType = {};
let totalExtractions = 0;

// Check if any extractions already exist for this ingest document
const existingRows = db.prepare(
  'SELECT extraction_id, entity_type FROM asdlc_ingest_extraction WHERE ingest_id = ? ORDER BY rowid'
).all(INGEST_ID);

if (existingRows.length > 0) {
  // Read back existing IDs grouped by type
  for (const row of existingRows) {
    if (!extractionIdsByType[row.entity_type]) extractionIdsByType[row.entity_type] = [];
    extractionIdsByType[row.entity_type].push(row.extraction_id);
  }
  totalExtractions = existingRows.length;
  log(`Extractions ................... ${totalExtractions} rows already exist — reading back IDs`);
} else {
  // First run — insert all extraction rows
  for (const { type, items } of extractionGroups) {
    const ids = [];
    for (const item of items) {
      const eid = generateId();
      db.prepare(`
        INSERT INTO asdlc_ingest_extraction
          (extraction_id, ingest_id, entity_type, entity_data, confidence, status, round)
        VALUES (?,?,?,?,?,?,?)
      `).run(eid, INGEST_ID, type, j(item), 1.0, 'staged', 1);
      ids.push(eid);
      totalExtractions++;
    }
    extractionIdsByType[type] = ids;
  }
  const counts = extractionGroups
    .filter(g => g.items.length > 0)
    .map(g => `${g.items.length} ${g.type}`)
    .join(', ');
  log(`Extractions ................... ${totalExtractions} CREATED (${counts})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 6 — Change Packets (10) + Items
// One packet per entity group. Items link to the entity IDs.
// Idempotency: skip item insertion if the packet already has items.
// ─────────────────────────────────────────────────────────────────────────────
log('── Step 6: Change Packets ──────────────────────────────────────');

const cpDefs = [
  {
    id:    CP_IDS[0],
    code:  'CP-EXX-001',
    summary: 'Use Case: Invoice Status Lookup Assistant for Fulfillers',
    items: [{ type: 'use_case', id: UC_ID, data: j(uc) }],
  },
  {
    id:    CP_IDS[1],
    code:  'CP-EXX-002',
    summary: 'Workflow: Invoice Status Lookup & Work Note Posting (incl. 6 steps)',
    items: [
      { type: 'workflow', id: WF_ID, data: j(wf) },
      ...ex.workflow_steps.map((s, i) => ({ type: 'workflow_step', id: STEP_IDS[i], data: j(s) })),
    ],
  },
  {
    id:    CP_IDS[2],
    code:  'CP-EXX-003',
    summary: 'HITL Gate: Exception Gate (agent-internal errors only)',
    items: [{ type: 'hitl_gate', id: HITL_ID, data: j(hg) }],
  },
  {
    id:    CP_IDS[3],
    code:  'CP-EXX-004',
    summary: 'Agent Spec: Invoice Status Lookup Assistant',
    items: [{ type: 'agent_spec', id: AGNT_ID, data: j(ag) }],
  },
  {
    id:    CP_IDS[4],
    code:  'CP-EXX-005',
    summary: 'Tools (4): invoice_search_lookup, sap_invoice_detail, ticket_work_note_post, supplier_master_lookup',
    items: ex.tools.map((t, i) => ({ type: 'tool', id: TOOL_IDS[i], data: j(t) })),
  },
  {
    id:    CP_IDS[5],
    code:  'CP-EXX-006',
    summary: 'Guardrails (10): G1–G10',
    items: (extractionIdsByType['guardrail'] || []).map((eid, i) => ({
      type: 'guardrail', id: eid, data: j((ex.guardrails || [])[i]),
    })),
  },
  {
    id:    CP_IDS[6],
    code:  'CP-EXX-007',
    summary: 'Data Sources (5): DS1–DS5',
    items: (extractionIdsByType['data_source'] || []).map((eid, i) => ({
      type: 'data_source', id: eid, data: j((ex.data_sources || [])[i]),
    })),
  },
  {
    id:    CP_IDS[7],
    code:  'CP-EXX-008',
    summary: 'Test Scenarios (18): TS1–TS18',
    items: (extractionIdsByType['test_scenario'] || []).map((eid, i) => ({
      type: 'test_scenario', id: eid, data: j((ex.test_scenarios || [])[i]),
    })),
  },
  {
    id:    CP_IDS[8],
    code:  'CP-EXX-009',
    summary: 'Governance Controls (6): GC1–GC6',
    items: (extractionIdsByType['governance_control'] || []).map((eid, i) => ({
      type: 'governance_control', id: eid, data: j((ex.governance_controls || [])[i]),
    })),
  },
  {
    id:    CP_IDS[9],
    code:  'CP-EXX-010',
    summary: 'User Stories (11): US1–US11',
    items: (extractionIdsByType['user_story'] || []).map((eid, i) => ({
      type: 'user_story', id: eid, data: j((ex.user_stories || [])[i]),
    })),
  },
];

let cpCreated   = 0;
let cpiTotal    = 0;
let cpiInserted = 0;

for (const cp of cpDefs) {
  const created = ior(`
    INSERT OR IGNORE INTO asdlc_change_packet
      (change_packet_id, project_id, packet_code, summary, source_evidence_id,
       conflict_classification, risk_level, created_by, updated_by)
    VALUES (?,?,?,?,?,?,?,?,?)
  `,
    cp.id, P_EXX, cp.code, cp.summary, EV_ID,
    'net_new', 'med', U1, U1
  );
  if (created) cpCreated++;

  // Only insert items if this packet has none yet (idempotent guard)
  const existingItemCount = db.prepare(
    'SELECT COUNT(*) AS c FROM asdlc_change_packet_item WHERE change_packet_id = ?'
  ).get(cp.id).c;

  if (existingItemCount === 0) {
    for (const item of cp.items) {
      if (!item.id) continue; // skip if extraction ID not found
      db.prepare(`
        INSERT INTO asdlc_change_packet_item
          (change_packet_item_id, change_packet_id, entity_type, entity_id,
           field_path, old_value, new_value)
        VALUES (?,?,?,?,'initial_import',NULL,?)
      `).run(generateId(), cp.id, item.type, item.id, item.data || '{}');
      cpiInserted++;
    }
  }
  cpiTotal += cp.items.length;
}
log(`Change packets ................ ${cpCreated} CREATED, ${cpDefs.length - cpCreated} already existed`);
log(`Change packet items ........... ${cpiInserted} inserted (${cpiTotal} total defined)`);

// ─────────────────────────────────────────────────────────────────────────────
// STEP 7 — Open-item Exceptions (6 unresolved flags → asdlc_exception)
// Idempotency: skip if exceptions already exist for this project
// ─────────────────────────────────────────────────────────────────────────────
log('── Step 7: Open Exceptions ─────────────────────────────────────');

const openFlags = (ex.extraction_flags || []).filter(f => !f._resolved);

const existingExcCount = db.prepare(
  'SELECT COUNT(*) AS c FROM asdlc_exception WHERE project_id = ?'
).get(P_EXX).c;

let excCreated = 0;

if (existingExcCount > 0) {
  log(`Exceptions .................... ${existingExcCount} already exist — skipping`);
} else {
  for (const flag of openFlags) {
    // Map entity_type to a relevant entity ID we actually have
    const relatedId =
      flag.entity_type === 'use_case'           ? UC_ID    :
      flag.entity_type === 'agent_spec'         ? AGNT_ID  :
      flag.entity_type === 'workflow'           ? WF_ID    :
      flag.entity_type === 'governance_control' ? P_EXX    :
      flag.entity_type === 'cost_estimate'      ? INGEST_ID :
      INGEST_ID;

    db.prepare(`
      INSERT INTO asdlc_exception
        (exception_id, project_id, exception_type, severity, description,
         related_entity_type, related_entity_id, suggested_action, status,
         created_by, updated_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      generateId(), P_EXX,
      flag.flag_type === 'assumption' ? 'assumption' : 'missing_evidence',
      'low',
      flag.description,
      flag.entity_type || 'general',
      relatedId,
      flag.suggested_action || null,
      'open',
      U1, U1
    );
    excCreated++;
  }
  log(`Exceptions .................... ${excCreated} CREATED`);
}

// ─────────────────────────────────────────────────────────────────────────────
// DONE
// ─────────────────────────────────────────────────────────────────────────────
console.log('');
log('✓  ExxonMobil import complete.');
log(`   Client  : ExxonMobil            (${C_EXXON})`);
log(`   Project : Agentic Invoice Lookup (${P_EXX})`);
log(`   Entities: 1 use_case, 1 workflow, 6 workflow_steps, 1 hitl_gate, 1 agent_spec, 4 tools`);
log(`   Extractions : ${totalExtractions} rows staged`);
log(`   Change Packets : ${cpDefs.length} pending (CP-EXX-001 through CP-EXX-010)`);
log(`   Open exceptions: ${openFlags.length}`);
console.log('');
log('Open the Workbench at http://localhost:8000 and select "Agentic Invoice Lookup" to begin review.');
