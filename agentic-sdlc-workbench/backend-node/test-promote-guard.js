// test-promote-guard.js — promote orphan-guard.
// Reproduces the bug where a high-confidence parent (use_case) flagged needs_clarification was
// silently dropped from promote, orphaning its workflow/step/agent subtree. Asserts the guard:
//   1. pulls a high-confidence needs_clarification REQUIRED parent into the promotion (subtree
//      materializes, no orphan), and
//   2. hard-blocks (409) when a required parent is genuinely unresolved (missing / low-confidence).
//
// Run:  node test-promote-guard.js   (from backend-node/)
'use strict';
const path = require('path');
const os = require('os');
process.env.ASDLC_DB_PATH = path.join(os.tmpdir(), `asdlc_promoteguard_${Date.now()}.db`);
process.env.PORT = String(8900 + Math.floor(Math.random() * 600));
process.env.ANTHROPIC_API_KEY = '';

const base = __dirname;
require(path.join(base, 'server.js'));
const { db, generateId } = require(path.join(base, 'db'));
const BASEURL = `http://127.0.0.1:${process.env.PORT}/api/v1`;
const HEADERS = { 'Content-Type': 'application/json', 'X-User-ID': 'test-guard' };

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { console.log('  ok  -', m); pass++; } else { console.error('  FAIL-', m); fail++; } };
function done(code) { try { db.close(); } catch {} process.exit(code); }
async function post(p, body) {
  const r = await fetch(BASEURL + p, { method: 'POST', headers: HEADERS, body: JSON.stringify(body || {}) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
function mkDoc(pid) {
  const id = generateId();
  db.prepare(`INSERT INTO asdlc_ingest_document (ingest_id, project_id, document_title, ingest_status) VALUES (?,?,?, 'staged')`).run(id, pid, 'Doc ' + id.slice(0, 6));
  return id;
}
function mkExtraction(ing, type, data, status, confidence) {
  db.prepare(`INSERT INTO asdlc_ingest_extraction (extraction_id, ingest_id, entity_type, entity_data, confidence, status, round, created_at)
              VALUES (?,?,?,?,?,?,1,datetime('now'))`).run(generateId(), ing, type, JSON.stringify(data), confidence, status);
}

async function main() {
  await new Promise(r => setTimeout(r, 900));
  const client = db.prepare('SELECT client_id FROM asdlc_client LIMIT 1').get();
  const pid = generateId();
  db.prepare(`INSERT INTO asdlc_project (project_id, client_id, project_name, project_code, confidence_threshold) VALUES (?,?,?,?,0.75)`)
    .run(pid, client.client_id, 'Promote Guard Test', 'PGUARD');

  // ── Scenario 1: high-confidence use_case stuck in needs_clarification, referenced by a staged workflow ──
  console.log('\n--- Scenario 1: high-conf needs_clarification parent is pulled in ---');
  const ing1 = mkDoc(pid);
  mkExtraction(ing1, 'use_case', { title: 'Onboarding UC', summary: 's', business_objective: 'b' }, 'needs_clarification', 0.9);
  mkExtraction(ing1, 'workflow', { name: 'Onboarding WF', use_case_title: 'Onboarding UC', trigger: { description: 'starts' } }, 'staged', 0.9);
  const r1 = await post(`/ingest-documents/${ing1}/promote`);
  assert(r1.status === 200, `promote succeeds (got ${r1.status})`);
  const cp1 = r1.json.change_packets && r1.json.change_packets[0];
  assert(cp1 && cp1.item_count === 2, `CP has BOTH workflow + pulled-in use_case (item_count=${cp1 && cp1.item_count})`);
  assert(cp1 && cp1.by_type && cp1.by_type.use_case === 1, 'use_case was pulled into the promotion');
  const ucStatus = db.prepare("SELECT status FROM asdlc_ingest_extraction WHERE ingest_id=? AND entity_type='use_case'").get(ing1).status;
  assert(ucStatus === 'promoted', 'pulled-in use_case extraction marked promoted');

  // ── Scenario 2: required parent genuinely missing → hard block, no half-apply ──
  console.log('\n--- Scenario 2: genuine orphan hard-blocks ---');
  const ing2 = mkDoc(pid);
  mkExtraction(ing2, 'workflow', { name: 'Ghost WF', use_case_title: 'Nonexistent UC', trigger: { description: 'x' } }, 'staged', 0.9);
  const cpsBefore = db.prepare('SELECT COUNT(*) c FROM asdlc_change_packet WHERE project_id=?').get(pid).c;
  const r2 = await post(`/ingest-documents/${ing2}/promote`);
  assert(r2.status === 409, `promote blocked with 409 (got ${r2.status})`);
  assert(Array.isArray(r2.json.orphans) && r2.json.orphans.some(o => o.requires === 'use_case' && o.parent_name === 'Nonexistent UC'), 'orphan report names the missing use_case parent');
  assert(db.prepare('SELECT COUNT(*) c FROM asdlc_change_packet WHERE project_id=?').get(pid).c === cpsBefore, 'no change packet created on block (no half-apply)');

  // ── Scenario 3: low-confidence needs_clarification parent is NOT pulled in (blocks) ──
  console.log('\n--- Scenario 3: low-confidence parent is not auto-pulled (blocks) ---');
  const ing3 = mkDoc(pid);
  mkExtraction(ing3, 'use_case', { title: 'Shaky UC', summary: 's' }, 'needs_clarification', 0.4);
  mkExtraction(ing3, 'workflow', { name: 'Dependent WF', use_case_title: 'Shaky UC', trigger: { description: 'x' } }, 'staged', 0.9);
  const r3 = await post(`/ingest-documents/${ing3}/promote`);
  assert(r3.status === 409, `low-confidence parent blocks (got ${r3.status})`);
  assert(r3.json.orphans && r3.json.orphans[0].parent_status === 'needs_clarification', 'orphan report shows parent_status=needs_clarification');

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  done(fail ? 1 : 0);
}
main().catch(e => { console.error('TEST ERROR', e); done(1); });
