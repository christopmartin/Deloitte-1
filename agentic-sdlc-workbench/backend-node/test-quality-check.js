// test-quality-check.js — regression test for the requirement-duplicate promote-time
// warning added 2026-07-14 (checkRequirementDuplicates), a non-destructive safety net
// alongside the sn-overlap-check.js fixes for the "duplicate requirement across ingest
// rounds" bug (see test-sn-overlap-check.js Part 6 for the sibling in-batch collapse).
//
// Covers, via the pure runChecks(items) entry point (no DB needed):
//   (1) a near-duplicate functional_req pair (reworded restatement) is flagged, warn-only.
//   (2) two legitimately different functional_reqs sharing some vocabulary are NOT flagged
//       — proves the threshold doesn't misfire on merely-related-but-distinct requirements.
//   (3) a near-duplicate nonfunctional_req pair (incl. measurable_target text) is flagged.
//
// Run:  node test-quality-check.js   (from backend-node/)
'use strict';
const path = require('path');
const os   = require('os');

process.env.ASDLC_DB_PATH = path.join(os.tmpdir(), `asdlc_qualitycheck_${Date.now()}.db`);
process.env.PORT = String(8700 + Math.floor(Math.random() * 600));
process.env.ANTHROPIC_API_KEY = '';   // stub mode — no live AI calls

const base = __dirname;
require(path.join(base, 'server.js'));
const { db } = require(path.join(base, 'db'));
const { runChecks } = require(path.join(base, 'agent', 'quality-check'));

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { console.log('  ok  -', m); pass++; } else { console.error('  FAIL-', m); fail++; } };
function done(code) { try { db.close(); } catch { /* ignore */ } process.exit(code); }

function fr(id, title, description) {
  return { id, type: 'functional_req', confidence: 0.9, data: { title, description } };
}
function nfr(id, title, description, measurable_target) {
  return { id, type: 'nonfunctional_req', confidence: 0.9, data: { title, description, measurable_target } };
}

function dupFindings(findings) { return findings.filter(f => f.category === 'duplicate_requirement'); }

function testNearDuplicateFrFlagged() {
  console.log('\n--- Part 1: near-duplicate functional_req pair is flagged (warn) ---');
  const items = [
    fr('a', 'Provide a general purpose request catalog item',
      'A catch-all request form for employees to submit any kind of request.'),
    fr('b', 'Provide a general-purpose catch-all request form',
      'Employees can submit any kind of request through it.'),
  ];
  const { findings } = runChecks(items);
  const dups = dupFindings(findings);
  assert(dups.length === 1, 'exactly one duplicate_requirement finding for the near-duplicate pair');
  assert(dups[0] && dups[0].severity === 'warn', 'finding is warn-only, never block');
  assert(dups[0] && dups[0].entities.some(e => e.extraction_id === 'a') && dups[0].entities.some(e => e.extraction_id === 'b'),
    'finding references both extraction_ids');
}

function testDistinctFrsNotFlagged() {
  console.log('\n--- Part 2: legitimately different FRs sharing vocabulary are NOT flagged ---');
  const items = [
    fr('c', 'Provide a general purpose request catalog item',
      'A catch-all request form for employees to submit any kind of request.'),
    fr('d', 'Route requests to Level 1 Triage',
      'Route requests to Level 1 Triage for initial handling and prioritization.'),
  ];
  const { findings } = runChecks(items);
  assert(dupFindings(findings).length === 0, 'no duplicate_requirement finding — the tight threshold does not misfire on merely-related requirements');
}

function testNearDuplicateNfrFlagged() {
  console.log('\n--- Part 3: near-duplicate nonfunctional_req pair (incl. measurable_target) is flagged ---');
  const items = [
    nfr('e', 'Requests must be triaged quickly',
      'The system should route new requests to a fulfillment team within a short time window.',
      'Triage routing completes within 5 minutes of submission.'),
    nfr('f', 'Requests must be routed quickly',
      'The system should route new requests to a fulfillment team within a short window.',
      'Triage routing completes within 5 minutes of submission.'),
  ];
  const { findings } = runChecks(items);
  const dups = dupFindings(findings);
  assert(dups.length === 1, 'exactly one duplicate_requirement finding for the near-duplicate NFR pair');
}

(async () => {
  try {
    testNearDuplicateFrFlagged();
    testDistinctFrsNotFlagged();
    testNearDuplicateNfrFlagged();
  } catch (err) {
    console.error('FATAL:', err);
    fail++;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  done(fail ? 1 : 0);
})();
