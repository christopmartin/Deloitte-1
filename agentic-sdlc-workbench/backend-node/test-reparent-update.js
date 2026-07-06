// test-reparent-update.js — regression test: re-parenting via a change-packet UPDATE.
//
// Bug: applying an `update` mapped only fieldMap columns, so a changed parent reference
// (e.g. agent_spec.workflow_name → workflow_id) was silently dropped — the FK kept
// pointing at the old parent. This broke workflow merges: the reattach never moved the
// agent, so the old (duplicate) workflow could not be deleted ("has 1 dependent
// agent_spec — not deleted"). The fix re-resolves parent links the update supplies.
//
// Drives the real apply path over HTTP (whole-CP approve), stub mode.
// Run:  node test-reparent-update.js   (from backend-node/)
'use strict';
const path = require('path');
const os = require('os');

process.env.ASDLC_DB_PATH = path.join(os.tmpdir(), `asdlc_reparent_${Date.now()}.db`);
process.env.PORT = String(8300 + Math.floor(Math.random() * 600));
process.env.ANTHROPIC_API_KEY = '';   // stub mode

const base = __dirname;
require(path.join(base, 'server.js'));
const { db, generateId } = require(path.join(base, 'db'));

const BASEURL = `http://127.0.0.1:${process.env.PORT}/api/v1`;
const HEADERS = { 'Content-Type': 'application/json', 'X-User-ID': 'test-reparent' };

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { console.log('  ok  -', m); pass++; } else { console.error('  FAIL-', m); fail++; } };
const done = (code) => { try { db.close(); } catch { /* ignore */ } process.exit(code); };

// ── fixture: one use case, two workflows (survivor + duplicate), an agent on the duplicate ──
function makeFixture(label) {
  const project = db.prepare('SELECT project_id FROM asdlc_project LIMIT 1').get();
  const pid = project.project_id;
  const ucId = generateId();
  db.prepare("INSERT INTO asdlc_use_case (use_case_id,project_id,slug,title) VALUES (?,?,?,?)")
    .run(ucId, pid, `UC-RP-${label}`, `Reparent UC ${label}`);
  const survivorId = generateId(), dupId = generateId();
  db.prepare("INSERT INTO asdlc_workflow (workflow_id,project_id,use_case_id,slug,name) VALUES (?,?,?,?,?)")
    .run(survivorId, pid, ucId, `WF-RP-${label}A`, `Reparent Survivor Workflow ${label}`);
  db.prepare("INSERT INTO asdlc_workflow (workflow_id,project_id,use_case_id,slug,name) VALUES (?,?,?,?,?)")
    .run(dupId, pid, ucId, `WF-RP-${label}B`, `Reparent Duplicate Workflow ${label}`);
  const agentId = generateId();
  db.prepare("INSERT INTO asdlc_agent_spec (agent_spec_id,project_id,use_case_id,workflow_id,slug,name) VALUES (?,?,?,?,?,?)")
    .run(agentId, pid, ucId, dupId, `AG-RP-${label}`, `Reparent Triage Agent ${label}`);

  const cpId = generateId();
  db.prepare("INSERT INTO asdlc_change_packet (change_packet_id,project_id,packet_code,status,summary) VALUES (?,?,?,?,?)")
    .run(cpId, pid, `CP-RP-${label}`, 'pending_review', `Reparent agent to survivor (${label})`);
  const itemId = generateId();
  const newValue = { operation: 'update', target_slug: `AG-RP-${label}`, name: `Reparent Triage Agent ${label}`,
    // the reattach: name the SURVIVOR workflow instead of the duplicate it currently points at
    workflow_name: `Reparent Survivor Workflow ${label}` };
  db.prepare("INSERT INTO asdlc_change_packet_item (change_packet_item_id,change_packet_id,entity_type,entity_id,operation,field_path,new_value,rationale) VALUES (?,?,?,?,?,?,?,?)")
    .run(itemId, cpId, 'agent_spec', agentId, 'update', 'agent_spec.update', JSON.stringify(newValue), 'reattach to survivor workflow');
  return { pid, ucId, survivorId, dupId, agentId, cpId, itemId };
}

const agentRow = (id) => db.prepare('SELECT * FROM asdlc_agent_spec WHERE agent_spec_id=?').get(id);

async function main() {
  await new Promise(r => setTimeout(r, 900));   // let app.listen bind

  // ── Scenario A: update supplies a new workflow_name → FK must move to the survivor ──
  console.log('\n--- A: reattach agent to survivor workflow via CP update ---');
  const A = makeFixture('A');
  assert(agentRow(A.agentId).workflow_id === A.dupId, 'precondition: agent starts on the duplicate workflow');
  let r = await fetch(`${BASEURL}/change-packets/${A.cpId}/approve`, { method: 'POST', headers: HEADERS, body: '{}' });
  assert(r.ok, `POST /change-packets/:id/approve → ${r.status}`);
  assert(agentRow(A.agentId).workflow_id === A.survivorId, 'agent workflow_id RE-POINTED to the survivor (was silently dropped before the fix)');

  // ── Scenario B: update that does NOT mention the parent must leave the FK untouched ──
  console.log('\n--- B: update without a parent name leaves the FK unchanged ---');
  const B = makeFixture('B');
  const beforeWf = agentRow(B.agentId).workflow_id;
  db.prepare("UPDATE asdlc_change_packet_item SET new_value=? WHERE change_packet_item_id=?")
    .run(JSON.stringify({ operation: 'update', target_slug: `AG-RP-B`, name: 'Renamed Only' }), B.itemId);
  r = await fetch(`${BASEURL}/change-packets/${B.cpId}/approve`, { method: 'POST', headers: HEADERS, body: '{}' });
  assert(r.ok, `POST approve (rename only) → ${r.status}`);
  const rowB = agentRow(B.agentId);
  assert(rowB.name === 'Renamed Only', 'scalar field update still applied');
  assert(rowB.workflow_id === beforeWf, 'FK untouched when the update does not supply a parent name (no over-eager reparenting)');

  console.log(`\n=== test-reparent-update: ${pass} passed, ${fail} failed ===`);
  done(fail ? 1 : 0);
}

main().catch(err => { console.error('FATAL', err); done(1); });
