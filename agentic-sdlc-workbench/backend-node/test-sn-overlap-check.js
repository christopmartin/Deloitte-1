// test-sn-overlap-check.js — regression test for BACKLOG #114:
// "ServiceNow overlap check — flag a possible existing duplicate when a new
// requirement is staged, before it can be promoted."
//
// Covers:
//   (1) pure helpers (_internal): tokenize / wordHit / extractKeywords / rankCandidates /
//       resolveSnConnection.
//   (2) checkServiceNowOverlap no-op paths: no ServiceNow connection configured on the
//       project (zero cost, zero network); connection present but no ANTHROPIC_API_KEY —
//       the retrieval step still runs (mocked fetch), but zero AI spend and nothing is
//       raised. Same "no key -> no-op" convention as agent/req-linker.js.
//   (3) writeSnOverlapClarification + the extended hasOpenConflicts gate: blocks promote
//       exactly like a real conflict:, is unaffected by fyi:/discovery: rows, and unblocks
//       once answered.
//   (4) dedup: a requirement that already has an open sn_overlap: clarification is skipped
//       entirely — the live ServiceNow lookup is never even attempted for it.
//
// Run:  node test-sn-overlap-check.js   (from backend-node/)
'use strict';
const path = require('path');
const os   = require('os');

process.env.ASDLC_DB_PATH = path.join(os.tmpdir(), `asdlc_snoverlap_${Date.now()}.db`);
process.env.PORT = String(8700 + Math.floor(Math.random() * 600));
process.env.ANTHROPIC_API_KEY = '';   // stub mode — no live AI calls

const base = __dirname;
require(path.join(base, 'server.js'));
const { db, generateId } = require(path.join(base, 'db'));
const cc = require(path.join(base, 'agent', 'cross-check'));
const { checkServiceNowOverlap, _internal } = require(path.join(base, 'agent', 'sn-overlap-check'));

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { console.log('  ok  -', m); pass++; } else { console.error('  FAIL-', m); fail++; } };
function done(code) { try { db.close(); } catch { /* ignore */ } process.exit(code); }

function makeDoc(projectId, { withReq = true } = {}) {
  const ingestId = generateId();
  db.prepare(`INSERT INTO asdlc_ingest_document (ingest_id, project_id, document_title) VALUES (?,?,?)`)
    .run(ingestId, projectId, 'Overlap Test Doc');
  if (withReq) {
    db.prepare(`INSERT INTO asdlc_ingest_extraction (extraction_id, ingest_id, entity_type, entity_data, status)
                VALUES (?,?,?,?,?)`)
      .run(generateId(), ingestId, 'functional_req',
        JSON.stringify({ title: 'Laptop request', description: 'Employees need a way to request a new laptop from IT.' }),
        'staged');
  }
  return ingestId;
}

function setSnConnection(projectId) {
  db.prepare(`UPDATE asdlc_project SET servicenow_scope=?, servicenow_instance=?, sn_user=?, sn_password_enc=? WHERE project_id=?`)
    .run('x_overlap_test', 'https://overlap-test.service-now.com', 'testuser', 'testpw', projectId);
}

async function testPureHelpers() {
  console.log('\n--- Part 1: pure helpers ---');
  const { tokenize, wordHit, extractKeywords, rankCandidates, resolveSnConnection } = _internal;

  assert(JSON.stringify(tokenize('Request a New Laptop!')) === JSON.stringify(['request', 'laptop']),
    'tokenize lowercases, splits, drops stopwords/short tokens');
  assert(wordHit('Employees need a laptop', 'laptop') === true, 'wordHit finds a whole-word match');
  assert(wordHit('Employees need a laptops', 'laptop') === false, 'wordHit requires a word boundary (no partial match)');

  const kws = extractKeywords([{ text: 'laptop request laptop form' }, { text: 'laptop approval workflow' }]);
  assert(kws[0] === 'laptop', 'extractKeywords ranks the most frequent token first');

  const ranked = rankCandidates(
    [{ table: 'sc_cat_item', name: 'Laptop Request', sys_id: '1' }, { table: 'sc_cat_item', name: 'Printer Setup', sys_id: '2' }],
    [{ text: 'Employees need to request a new laptop' }]
  );
  assert(ranked.length === 1 && ranked[0].sys_id === '1', 'rankCandidates keeps only the name-overlapping candidate');

  assert(resolveSnConnection({}) === null, 'resolveSnConnection returns null with no connection fields');
  assert(resolveSnConnection({ servicenow_scope: 'x_test', servicenow_instance: 'https://x.service-now.com', sn_user: 'u', sn_password_enc: 'p' }) !== null,
    'resolveSnConnection resolves a fully-populated project');
}

async function testNoOpPaths() {
  console.log('\n--- Part 2: no-op / zero-cost paths ---');
  const project = db.prepare('SELECT project_id FROM asdlc_project LIMIT 1').get();

  // (a) No ServiceNow connection at all on the project yet.
  const ingestA = makeDoc(project.project_id);
  const resA = await checkServiceNowOverlap({ doc: { project_id: project.project_id }, ingestId: ingestA, round: 1 });
  assert(resA.checked === 0 && resA.raised === 0, 'no SN connection on the project -> immediate no-op');

  // (b) SN connection present, no API key -> retrieval runs, zero AI spend, nothing raised.
  setSnConnection(project.project_id);

  const ingestB = makeDoc(project.project_id);
  let fetchCalls = 0;
  const mockFetch = async (url) => {
    fetchCalls++;
    const table = (/table\/(\w+)/.exec(url) || [])[1] || '';
    if (table === 'sc_cat_item') {
      return { ok: true, status: 200, json: async () => ({ result: [{ sys_id: 'cand1', name: 'Laptop Request', category: 'Hardware' }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ result: [] }) };
  };
  const resB = await checkServiceNowOverlap({ doc: { project_id: project.project_id }, ingestId: ingestB, round: 1, fetchImpl: mockFetch });
  assert(fetchCalls === 5, 'searches exactly the 5 curated tables (sc_cat_item, sn_aia_agent/tool/usecase, sys_hub_flow)');
  assert(resB.checked === 1 && resB.raised === 0, 'a plausible candidate is found, but no API key -> zero AI spend, nothing raised');

  const usage = db.prepare("SELECT COUNT(*) c FROM asdlc_ai_usage WHERE source='sn_overlap_check'").get().c;
  assert(usage === 0, 'no usage row logged when the AI step never runs');
}

async function testClarificationGate() {
  console.log('\n--- Part 3: writeSnOverlapClarification + hasOpenConflicts gate ---');
  const project = db.prepare('SELECT project_id FROM asdlc_project LIMIT 1').get();
  const ingestId = makeDoc(project.project_id, { withReq: false });

  assert(cc.hasOpenConflicts(ingestId) === false, 'no open conflicts on a fresh document');

  const wrote = cc.writeSnOverlapClarification(ingestId, 1, {
    requirementRef: 'FR-draft-1', entityType: 'functional_req',
    question: 'A ServiceNow "Laptop Request" (sc_cat_item) may already cover this requirement.',
    context: 'Candidate: sc_cat_item "Laptop Request" (sys_id cand1).',
  });
  assert(wrote === true, 'writeSnOverlapClarification writes a new row');
  assert(cc.hasOpenConflicts(ingestId) === true, 'an open sn_overlap: row now blocks promote, same as a real conflict');

  const dup = cc.writeSnOverlapClarification(ingestId, 1, {
    requirementRef: 'FR-draft-1', entityType: 'functional_req', question: 'dup attempt', context: '',
  });
  assert(dup === false, 'a second write for the same still-open requirement ref is deduped');

  const row = db.prepare("SELECT clarification_id FROM asdlc_ingest_clarification WHERE ingest_id=? AND target_field='sn_overlap:FR-draft-1'").get(ingestId);
  db.prepare("UPDATE asdlc_ingest_clarification SET answer_text='Confirmed different, proceed.', answered_at=datetime('now') WHERE clarification_id=?").run(row.clarification_id);
  assert(cc.hasOpenConflicts(ingestId) === false, 'answering the sn_overlap: row unblocks promote again');

  // fyi:/discovery: rows must NOT trip the gate — regression safety on the OR-extension.
  const ingestId2 = makeDoc(project.project_id, { withReq: false });
  cc.writeDiscoveryClarification(ingestId2, 1, { question: 'table ambiguity?', context: '', related_tables: ['sc_cat_item'] });
  assert(cc.hasOpenConflicts(ingestId2) === false, 'an open discovery: row alone does not block promote');
}

async function testDedupSkipsAlreadyOpen() {
  console.log('\n--- Part 4: an already-flagged requirement is skipped entirely ---');
  const project = db.prepare('SELECT project_id FROM asdlc_project LIMIT 1').get();
  const ingestId = makeDoc(project.project_id); // one staged FR -> synthesizes ref 'FR-draft-1'
  cc.writeSnOverlapClarification(ingestId, 1, { requirementRef: 'FR-draft-1', entityType: 'functional_req', question: 'q', context: '' });

  setSnConnection(project.project_id);

  let fetchCalls = 0;
  const mockFetch = async () => { fetchCalls++; return { ok: true, status: 200, json: async () => ({ result: [] }) }; };
  const res = await checkServiceNowOverlap({ doc: { project_id: project.project_id }, ingestId, round: 1, fetchImpl: mockFetch });
  assert(fetchCalls === 0, 'the only staged requirement already has an open sn_overlap: clarification -> live lookup never attempted');
  assert(res.checked === 0 && res.raised === 0, 'reports nothing to check');
}

(async () => {
  try {
    await testPureHelpers();
    await testNoOpPaths();
    await testClarificationGate();
    await testDedupSkipsAlreadyOpen();
  } catch (err) {
    console.error('FATAL:', err);
    fail++;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  done(fail ? 1 : 0);
})();
