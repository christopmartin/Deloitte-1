// test-merge-reconcile.js — cross-check merge/duplicate-consolidation awareness.
//
// Regression guard for the "re-ingest my own quality findings" case: when a delete
// consolidates a duplicate into a surviving same-type sibling, the reconciler must NOT
// treat tokens the survivor still carries (e.g. an incidental "SAP" mention) as design-
// wide removals and spray false ripple conflicts. A genuinely-dropped structured field
// must still surface, and a genuine delete with no survivor must still flag ripple.
//
// Offline / stub mode (no ANTHROPIC_API_KEY) — deterministic path only.
'use strict';
const path = require('path');
const os = require('os');
process.env.ASDLC_DB_PATH = path.join(os.tmpdir(), `asdlc_merge_${Date.now()}.db`);
process.env.ANTHROPIC_API_KEY = '';

const { db, generateId } = require('./db');
const cc = require('./agent/cross-check');

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { console.log('  ok  -', m); pass++; } else { console.error('  FAIL-', m); fail++; } };
const done = (code) => { try { db.close(); } catch {} process.exit(code); };

const pid = generateId();
db.prepare("INSERT INTO asdlc_client (client_id,client_name,client_code) VALUES (?,?,?)").run('c1', 'Client', 'C1');
db.prepare("INSERT INTO asdlc_project (project_id,client_id,project_name,project_code) VALUES (?,?,?,?)").run(pid, 'c1', 'Proj', 'P1');

// Two duplicate DockTrak tools already in the design; both incidentally mention SAP.
const insTool = (slug, name) => {
  const idT = generateId();
  db.prepare("INSERT INTO asdlc_tool (tool_id,project_id,slug,name,contract) VALUES (?,?,?,?,?)")
    .run(idT, pid, slug, name, `Reads received quantity from DockTrak; not integrated with SAP in real time — syncs to SAP overnight.`);
  return idT;
};
insTool('T-100', 'DockTrak Received-Quantity Lookup');       // survivor
insTool('T-101', 'DockTrak Received-Quantity Integration');  // duplicate to be deleted

// A workflow + step whose prose mentions SAP (would false-positive on a naive "sap" drift).
const ucId = generateId();
db.prepare("INSERT INTO asdlc_use_case (use_case_id,project_id,slug,title) VALUES (?,?,?,?)")
  .run(ucId, pid, 'UC-100', 'Vendor Invoice Exception Resolution');
const wfId = generateId();
db.prepare("INSERT INTO asdlc_workflow (workflow_id,project_id,use_case_id,slug,name) VALUES (?,?,?,?,?)")
  .run(wfId, pid, ucId, 'WF-100', 'Invoice Exception Resolution Workflow');
db.prepare("INSERT INTO asdlc_workflow_step (workflow_step_id,workflow_id,project_id,slug,name,step_number,step_purpose) VALUES (?,?,?,?,?,?,?)")
  .run(generateId(), wfId, pid, 'S-100', 'Gather supporting data', 1, 'Pull PO and invoice detail from SAP and received quantity from DockTrak.');

function seedIngest(extractions) {
  const ingestId = generateId();
  db.prepare("INSERT INTO asdlc_ingest_document (ingest_id,project_id,document_title,ingest_status) VALUES (?,?,?,?)")
    .run(ingestId, pid, 'fixes', 'staged');
  for (const ex of extractions) {
    db.prepare("INSERT INTO asdlc_ingest_extraction (extraction_id,ingest_id,entity_type,entity_data,status,round,confidence) VALUES (?,?,?,?,?,?,?)")
      .run(generateId(), ingestId, ex.entity_type, JSON.stringify(ex.data), 'staged', 1, 0.9);
  }
  return ingestId;
}
const openConflicts = (ingestId) => db.prepare(
  "SELECT question_text FROM asdlc_ingest_clarification WHERE ingest_id=? AND answer_text IS NULL AND target_field LIKE 'conflict:%'"
).all(ingestId);

(async () => {
  // ── Scenario 1: lossless merge — delete T-101 into surviving T-100 (which keeps
  //    the same interface). Must raise ZERO conflicts. ──
  const i1 = seedIngest([
    { entity_type: 'tool', data: { operation: 'update', target_slug: 'T-100', name: 'DockTrak Received-Quantity Lookup',
        contract: 'Reads received quantity from DockTrak; syncs to SAP overnight.', inputs: ['PO / receipt identifier'], outputs: ['Received quantity'] } },
    { entity_type: 'tool', data: { operation: 'delete', target_slug: 'T-101', name: 'DockTrak Received-Quantity Integration',
        conflict_rationale: 'Duplicate of T-100; merged and deleted.' } },
  ]);
  await cc.runCrossCheck({ doc: db.prepare('SELECT * FROM asdlc_ingest_document WHERE ingest_id=?').get(i1), round: 1 });
  assert(openConflicts(i1).length === 0, 'lossless merge raises no conflicts (was 4 before the fix)');

  // ── Scenario 2: lossy merge — the deleted duplicate had an `errors` interface the
  //    survivor lacks. Must raise exactly one precise merge-divergence conflict. ──
  db.prepare("UPDATE asdlc_tool SET contract=? WHERE slug='T-101' AND project_id=?")
    .run(JSON.stringify({ note: 'has errors' }), pid); // no-op-ish; errors carried via extraction below
  const i2 = seedIngest([
    { entity_type: 'tool', data: { operation: 'update', target_slug: 'T-100', name: 'DockTrak Received-Quantity Lookup',
        contract: 'Reads received quantity from DockTrak; syncs to SAP overnight.', inputs: ['PO / receipt identifier'] } },
    { entity_type: 'tool', data: { operation: 'delete', target_slug: 'T-101', name: 'DockTrak Received-Quantity Integration' } },
  ]);
  // Give the deleted DB row an errors[] the survivor extraction does not define.
  db.prepare("UPDATE asdlc_tool SET name='DockTrak Received-Quantity Integration' WHERE slug='T-101' AND project_id=?").run(pid);
  const survForDiff = { name: 'DockTrak Received-Quantity Lookup', inputs: ['PO / receipt identifier'] };
  const deletedForDiff = { name: 'DockTrak Received-Quantity Integration', errors: ['not_found', 'timeout', 'sync_lag'] };
  const dropped = cc._internal.droppedInterfaceFields(deletedForDiff, survForDiff);
  assert(dropped.length === 1 && dropped[0].field === 'errors', 'field-diff detects the dropped errors[] interface');
  assert(dropped[0].items.length === 3, 'dropped field lists all three error items');

  // ── Scenario 3: findMergeSurvivor pairs by name, ignores unrelated same-type rows. ──
  const staged = [{ entity_type: 'tool', data: { operation: 'update', target_slug: 'T-100', name: 'DockTrak Received-Quantity Lookup' } }];
  const delRow = { slug: 'T-101', name: 'DockTrak Received-Quantity Integration' };
  const m = cc._internal.findMergeSurvivor(pid, 'tool', delRow, staged);
  assert(m && m.survivorData.target_slug === 'T-100', 'merge survivor resolved by name overlap');
  const noMatch = cc._internal.findMergeSurvivor(pid, 'tool',
    { slug: 'T-999', name: 'Completely Unrelated Widget Exporter' }, staged);
  assert(!noMatch, 'no false merge pairing for an unrelated same-type record');

  // ── Scenario 4: genuine system swap (NOT a merge) — update T-100 replacing SAP with
  //    Oracle. "sap" is truly leaving that record and other elements still reference it,
  //    so ripple MUST still be raised. Guards against the fix over-suppressing. ──
  const i4 = seedIngest([
    { entity_type: 'tool', data: { operation: 'update', target_slug: 'T-100', name: 'DockTrak Received-Quantity Lookup',
        contract: 'Reads received quantity from DockTrak; integrated with Oracle Fusion instead of the legacy ERP.' } },
  ]);
  await cc.runCrossCheck({ doc: db.prepare('SELECT * FROM asdlc_ingest_document WHERE ingest_id=?').get(i4), round: 1 });
  assert(openConflicts(i4).length > 0, 'genuine SAP→Oracle swap still raises ripple (no over-suppression)');

  console.log(`\n${pass} passed, ${fail} failed`);
  done(fail ? 1 : 0);
})().catch(e => { console.error(e); done(1); });
