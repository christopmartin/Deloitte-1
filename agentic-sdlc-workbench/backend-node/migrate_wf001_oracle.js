/**
 * migrate_wf001_oracle.js — Plan step A (WF-001 reconciliation)
 *
 * 1. Propagate the SAP→Oracle rename that the ingest CP applied only to tool T-002,
 *    to the elements that still say "SAP" for the CURRENT-DETAIL lookup:
 *      participant P-006, step S-004 name, step S-007 purpose, path labels, UC-001 summary.
 *    Leaves the genuinely-SAP payment-history elements (T-005, data source, S-009 name) alone.
 * 2. Give S-009 owners: new AI-agent lane (Payment Projection Agent, owns S-009) AND a
 *    SAP system lane (owns a new system-side step S-010 it reads from) — mirrors the
 *    existing agent(S-004)→system(S-007) pattern so both lanes render.
 * 3. Wire S-009/S-010 into the flow (no longer orphan) and fix the S-009 step_number=4 collision.
 *
 * Idempotent: re-running detects already-applied changes and skips them.
 * Transactional: all-or-nothing. Writes asdlc_audit_log rows for traceability.
 */
'use strict';
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const path = require('path');

const db = new DatabaseSync(process.env.ASDLC_DB_PATH || path.join(__dirname, 'asdlc.db'));
const ACTOR = '11111111-0000-0000-0000-000000000001'; // system/admin user used in seed

const PID   = 'EE000000-0000-0000-0000-000000000010';
const WF    = 'EE000000-0000-0000-0000-000000000050';
const P006  = 'wp222222-0000-0000-0000-000000000006'; // current "SAP" lane → Oracle
const S004  = 'EE000000-0000-0000-0000-000000000064';
const S007  = 'EE000000-0000-0000-0000-000000000067';
const S005  = 'EE000000-0000-0000-0000-000000000065';
const S009  = '314135fb-502e-49d2-8106-bedfe038345b';
const AG002 = 'd6ab2a66-a167-4e4e-8a0e-5993dd6b4b1f'; // Invoice Payment Date Projection Agent
const PATH009 = 'pth22222-0009';

function audit(table, recordId, op, oldData, newData) {
  db.prepare(`INSERT INTO asdlc_audit_log (audit_id, table_name, record_id, operation, old_data, new_data, changed_by, changed_at)
              VALUES (?,?,?,?,?,?,?,datetime('now'))`)
    .run(randomUUID(), table, recordId, op, oldData ? JSON.stringify(oldData) : null,
         newData ? JSON.stringify(newData) : null, ACTOR);
}
const log = [];
function note(msg) { log.push(msg); }

db.exec('BEGIN');
try {
  // ── 1. SAP→Oracle on current-detail elements ────────────────────────────────
  // 1a. Participant P-006: SAP → Oracle
  {
    const p = db.prepare('SELECT swimlane_display_name d, human_role_name r FROM asdlc_workflow_participant WHERE workflow_participant_id=?').get(P006);
    if (p && (p.d === 'SAP' || /SAP/.test(p.r || ''))) {
      db.prepare(`UPDATE asdlc_workflow_participant SET swimlane_display_name='Oracle', human_role_name='Oracle ERP', updated_by=?, updated_at=datetime('now') WHERE workflow_participant_id=?`).run(ACTOR, P006);
      audit('asdlc_workflow_participant', P006, 'UPDATE', p, { d: 'Oracle', r: 'Oracle ERP' });
      note('P-006 renamed SAP → Oracle');
    } else note('P-006 already Oracle (skipped)');
  }
  // 1b. Step S-004 name
  {
    const s = db.prepare('SELECT name FROM asdlc_workflow_step WHERE workflow_step_id=?').get(S004);
    if (s && /SAP/.test(s.name)) {
      const nn = s.name.replace(/SAP/g, 'Oracle');
      db.prepare(`UPDATE asdlc_workflow_step SET name=?, updated_by=?, updated_at=datetime('now') WHERE workflow_step_id=?`).run(nn, ACTOR, S004);
      audit('asdlc_workflow_step', S004, 'UPDATE', { name: s.name }, { name: nn });
      note(`S-004 name: "${s.name}" → "${nn}"`);
    } else note('S-004 name already Oracle (skipped)');
  }
  // 1c. Step S-007 purpose
  {
    const s = db.prepare('SELECT step_purpose FROM asdlc_workflow_step WHERE workflow_step_id=?').get(S007);
    if (s && /SAP/.test(s.step_purpose || '')) {
      const np = s.step_purpose.replace(/SAP/g, 'Oracle');
      db.prepare(`UPDATE asdlc_workflow_step SET step_purpose=?, updated_by=?, updated_at=datetime('now') WHERE workflow_step_id=?`).run(np, ACTOR, S007);
      audit('asdlc_workflow_step', S007, 'UPDATE', { step_purpose: s.step_purpose }, { step_purpose: np });
      note('S-007 purpose SAP → Oracle');
    } else note('S-007 purpose already Oracle (skipped)');
  }
  // 1d. Path labels (current-detail branch only)
  for (const [slug, from, to] of [
    ['PATH-003', 'SAP lookup needed', 'Oracle lookup needed'],
    ['PATH-004', 'No SAP needed', 'No Oracle needed'],
    ['PATH-008', 'Call SAP via IntegrationHub', 'Call Oracle via IntegrationHub'],
    ['PATH-009', 'SAP detail returned', 'Oracle detail returned'],
  ]) {
    const row = db.prepare('SELECT workflow_path_id id, branch_label b FROM asdlc_workflow_path WHERE workflow_id=? AND slug=?').get(WF, slug);
    if (row && row.b === from) {
      db.prepare(`UPDATE asdlc_workflow_path SET branch_label=?, updated_by=?, updated_at=datetime('now') WHERE workflow_path_id=?`).run(to, ACTOR, row.id);
      audit('asdlc_workflow_path', row.id, 'UPDATE', { branch_label: from }, { branch_label: to });
      note(`${slug} label: "${from}" → "${to}"`);
    } else note(`${slug} label already updated/absent (skipped)`);
  }
  // 1e. UC-001 summary: first "SAP via IntegrationHub" (current detail) → Oracle. Keep "SAP payment-history".
  {
    const uc = db.prepare("SELECT use_case_id id, summary FROM asdlc_use_case WHERE project_id=? AND slug='UC-001'").get(PID);
    if (uc && /Invoice Search and SAP via IntegrationHub/.test(uc.summary)) {
      const ns = uc.summary.replace('Invoice Search and SAP via IntegrationHub', 'Invoice Search and Oracle via IntegrationHub');
      db.prepare(`UPDATE asdlc_use_case SET summary=?, updated_by=?, updated_at=datetime('now') WHERE use_case_id=?`).run(ns, ACTOR, uc.id);
      audit('asdlc_use_case', uc.id, 'UPDATE', { summary: uc.summary }, { summary: ns });
      note('UC-001 summary: current-detail SAP → Oracle (payment-history SAP kept)');
    } else note('UC-001 summary already updated (skipped)');
  }

  // ── 2. New participant lanes ─────────────────────────────────────────────────
  // 2a. Payment Projection Agent (AI agent lane) — owns S-009
  let pProj = db.prepare("SELECT workflow_participant_id id FROM asdlc_workflow_participant WHERE workflow_id=? AND slug='P-007'").get(WF);
  if (!pProj) {
    const id = randomUUID();
    db.prepare(`INSERT INTO asdlc_workflow_participant
      (workflow_participant_id, workflow_id, project_id, slug, participant_type, agent_spec_id,
       human_role_name, swimlane_display_name, lane_order, include_in_swimlane, include_in_rasic,
       purpose_in_workflow, created_by, updated_by)
      VALUES (?,?,?,?,?,?,?,?,?,1,1,?,?,?)`).run(
      id, WF, PID, 'P-007', 'Specialist Agent', AG002, null, 'Payment Projection Agent', 6,
      'Projects the estimated invoice payment date from SAP payment history; called by the Invoice Agent.',
      ACTOR, ACTOR);
    audit('asdlc_workflow_participant', id, 'INSERT', null, { slug: 'P-007', display: 'Payment Projection Agent' });
    pProj = { id };
    note('Created participant P-007 Payment Projection Agent (AI agent)');
  } else note('P-007 already exists (skipped)');

  // 2b. SAP (system lane) — owns the new system-side step S-010
  let pSap = db.prepare("SELECT workflow_participant_id id FROM asdlc_workflow_participant WHERE workflow_id=? AND slug='P-008'").get(WF);
  if (!pSap) {
    const id = randomUUID();
    db.prepare(`INSERT INTO asdlc_workflow_participant
      (workflow_participant_id, workflow_id, project_id, slug, participant_type, agent_spec_id,
       human_role_name, swimlane_display_name, lane_order, include_in_swimlane, include_in_rasic,
       purpose_in_workflow, created_by, updated_by)
      VALUES (?,?,?,?,?,?,?,?,?,1,1,?,?,?)`).run(
      id, WF, PID, 'P-008', 'Orchestrator Agent', null, 'SAP ERP', 'SAP', 7,
      'System of record for ~12 months of historical invoice payment dates, read for payment-date projection.',
      ACTOR, ACTOR);
    audit('asdlc_workflow_participant', id, 'INSERT', null, { slug: 'P-008', display: 'SAP' });
    pSap = { id };
    note('Created participant P-008 SAP (system, payment history)');
  } else note('P-008 already exists (skipped)');

  // ── 3. Owner for S-009 + fix step_number collision ──────────────────────────
  {
    const s = db.prepare('SELECT owner_participant_id o, step_number n FROM asdlc_workflow_step WHERE workflow_step_id=?').get(S009);
    if (s && (s.o == null || s.n === 4)) {
      db.prepare(`UPDATE asdlc_workflow_step SET owner_participant_id=?, step_number=46, updated_by=?, updated_at=datetime('now') WHERE workflow_step_id=?`).run(pProj.id, ACTOR, S009);
      audit('asdlc_workflow_step', S009, 'UPDATE', { owner_participant_id: s.o, step_number: s.n }, { owner_participant_id: pProj.id, step_number: 46 });
      note('S-009 owner = Payment Projection Agent; step_number 4 → 46 (collision fixed)');
    } else note('S-009 already owned/renumbered (skipped)');
  }

  // ── 4. New system-side step S-010 (SAP payment-history lookup), owned by SAP lane ──
  let s010 = db.prepare("SELECT workflow_step_id id FROM asdlc_workflow_step WHERE workflow_id=? AND slug='S-010'").get(WF);
  if (!s010) {
    const id = randomUUID();
    db.prepare(`INSERT INTO asdlc_workflow_step
      (workflow_step_id, workflow_id, project_id, slug, step_number, name, step_type, step_purpose,
       owner_participant_id, actor_role, inputs, outputs, lifecycle_status, is_end_step, created_by, updated_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`).run(
      id, WF, PID, 'S-010', 47, 'Retrieve SAP invoice payment history (12 mo)', 'Activity',
      'SAP returns up to 12 months of historical invoice-to-payment durations for the supplier/company, used to project the estimated payment date.',
      pSap.id, 'SAP ERP',
      JSON.stringify(['Supplier/company identifier', 'Lookback window (≤12 months)']),
      JSON.stringify(['Historical invoices with actual payment dates', 'Processing-duration distribution']),
      'draft', ACTOR, ACTOR);
    audit('asdlc_workflow_step', id, 'INSERT', null, { slug: 'S-010', name: 'Retrieve SAP invoice payment history (12 mo)' });
    s010 = { id };
    note('Created step S-010 Retrieve SAP invoice payment history (SAP lane)');
  } else note('S-010 already exists (skipped)');

  // ── 5. Wire the flow: S-007 → S-009 → S-010 → S-005 (was S-007 → S-005) ──────
  {
    const p9 = db.prepare('SELECT to_step_id t FROM asdlc_workflow_path WHERE workflow_path_id=?').get(PATH009);
    if (p9 && p9.t === S005) {
      db.prepare(`UPDATE asdlc_workflow_path SET to_step_id=?, updated_by=?, updated_at=datetime('now') WHERE workflow_path_id=?`).run(S009, ACTOR, PATH009);
      audit('asdlc_workflow_path', PATH009, 'UPDATE', { to_step_id: S005 }, { to_step_id: S009 });
      note('PATH-009 rerouted: S-007 → S-009 (was S-007 → S-005)');
    } else note('PATH-009 already rerouted (skipped)');
  }
  function addPath(slug, from, to, label) {
    const ex = db.prepare('SELECT 1 FROM asdlc_workflow_path WHERE workflow_id=? AND slug=?').get(WF, slug);
    if (ex) { note(`${slug} already exists (skipped)`); return; }
    const id = randomUUID();
    db.prepare(`INSERT INTO asdlc_workflow_path
      (workflow_path_id, workflow_id, project_id, slug, from_step_id, to_step_id, branch_label, is_default_path, created_by, updated_by)
      VALUES (?,?,?,?,?,?,?,1,?,?)`).run(id, WF, PID, slug, from, to, label, ACTOR, ACTOR);
    audit('asdlc_workflow_path', id, 'INSERT', null, { slug, from, to, branch_label: label });
    note(`Added ${slug}: ${label}`);
  }
  addPath('PATH-011', S009, s010.id, 'Call SAP payment history');
  addPath('PATH-012', s010.id, S005, 'Payment history returned');

  db.exec('COMMIT');
  console.log('✅ Migration committed.\n' + log.map(l => '  • ' + l).join('\n'));
} catch (err) {
  db.exec('ROLLBACK');
  console.error('❌ Rolled back:', err.message);
  process.exitCode = 1;
}
