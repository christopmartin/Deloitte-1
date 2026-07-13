// test-best-practice-classification.js
// ─────────────────────────────────────────────────────────────────────────────
// 3-way extraction classification (Extracted / AI Suggestion / Best-Practice Match).
// Covers the hard-verification gate (agent/ai-config.js's applyBestPracticeGate),
// getActiveBestPractices exposing the citable slug, and quality-check.js's
// categorization of AI-invented structural entities. Temp DB; no network, no AI.
//
// Run:  node test-best-practice-classification.js   (from backend-node/)
'use strict';
const path = require('path');
const os = require('os');
process.env.ASDLC_DB_PATH = path.join(os.tmpdir(), `asdlc_bpclass_${Date.now()}.db`);
process.env.PORT = String(8900 + Math.floor(Math.random() * 600));
process.env.ANTHROPIC_API_KEY = '';

const base = __dirname;
require(path.join(base, 'server.js')); // seeds the default client, matching test-promote-guard.js
const { db, generateId } = require(path.join(base, 'db'));
const aiConfig = require(path.join(base, 'agent/ai-config'));
const qualityCheck = require(path.join(base, 'agent/quality-check'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  -', m); } else { fail++; console.error('  FAIL-', m); } };
const done = (code) => { try { db.close(); } catch {} process.exit(code); };

function mkProject() {
  const client = db.prepare('SELECT client_id FROM asdlc_client LIMIT 1').get();
  const pid = generateId();
  db.prepare(`INSERT INTO asdlc_project (project_id, client_id, project_name, project_code, confidence_threshold) VALUES (?,?,?,?,0.75)`)
    .run(pid, client.client_id, 'BP Classification Test', 'BPCLASS');
  return pid;
}
function mkDoc(pid) {
  const id = generateId();
  db.prepare(`INSERT INTO asdlc_ingest_document (ingest_id, project_id, document_title, ingest_status) VALUES (?,?,?, 'staged')`)
    .run(id, pid, 'Doc ' + id.slice(0, 6));
  return id;
}
function mkBestPractice(slug, title, scope) {
  const id = generateId();
  db.prepare(`INSERT INTO asdlc_best_practice (best_practice_id, slug, scope, title, rule_text, is_active, sort_order) VALUES (?,?,?,?,?,1,0)`)
    .run(id, slug, scope || 'global', title, 'rule text for ' + title);
  return id;
}
function mkExtraction(ing, type, data, status, confidence) {
  db.prepare(`INSERT INTO asdlc_ingest_extraction (extraction_id, ingest_id, entity_type, entity_data, confidence, status, round, created_at)
              VALUES (?,?,?,?,?,?,1,datetime('now'))`).run(generateId(), ing, type, JSON.stringify(data), confidence, status);
}

(async () => {
  // ── Part 1: applyBestPracticeGate (pure helper) ────────────────────────────
  console.log('--- Part 1: applyBestPracticeGate ---');
  const bp = [{ slug: 'BP-100', title: 'Test Rule', best_practice_id: 'uuid-1' }];

  const matched = aiConfig.applyBestPracticeGate({ name: 'X', system_generated: true, best_practice_ref: 'BP-100' }, bp);
  ok(matched.best_practice_ref === 'BP-100', 'real matching slug is kept');
  ok(matched.best_practice_title === 'Test Rule', "matched row's real title is stamped in");

  const hallucinated = aiConfig.applyBestPracticeGate({ name: 'Y', system_generated: true, best_practice_ref: 'BP-999' }, bp);
  ok(hallucinated.best_practice_ref === undefined, 'unknown/hallucinated slug is dropped, not trusted');
  ok(hallucinated.best_practice_title === undefined, 'no title stamped when the ref did not match');
  ok(hallucinated.name === 'Y', 'the rest of entityData survives the drop untouched');

  const blank = { name: 'Z', system_generated: true };
  const passthrough = aiConfig.applyBestPracticeGate(blank, bp);
  ok(passthrough.best_practice_ref === undefined, 'a missing best_practice_ref is a no-op');
  ok(passthrough !== blank || Object.keys(passthrough).length === Object.keys(blank).length,
     'no-op path does not corrupt the object');

  const original = { name: 'W', best_practice_ref: 'BP-999' };
  aiConfig.applyBestPracticeGate(original, bp);
  ok(original.best_practice_ref === 'BP-999', 'the gate never mutates its input — original object is untouched');

  // ── Part 2: getActiveBestPractices exposes the citable slug ────────────────
  console.log('\n--- Part 2: getActiveBestPractices exposes slug ---');
  mkBestPractice('BP-101', 'Triage assistant guidance', 'global');
  const active = aiConfig.getActiveBestPractices([], 'any');
  const found = active.find(r => r.slug === 'BP-101');
  ok(!!found, 'getActiveBestPractices returns the new slug field');
  ok(found && found.title === 'Triage assistant guidance', 'title still comes through alongside the slug');

  // ── Part 3: quality-check.js categorization (pure, via exported runChecks) ──
  console.log('\n--- Part 3: runChecks categorization ---');
  const items = [
    { id: 'e1', type: 'agent_spec', confidence: 0.6, data: {
        name: 'Request Triage Assistant', system_generated: true, conflict_classification: 'net_new',
        best_practice_ref: 'BP-101', best_practice_title: 'Triage assistant guidance',
      } },
    { id: 'e2', type: 'agent_spec', confidence: 0.6, data: {
        name: 'Escalation Bot', system_generated: true, conflict_classification: 'net_new',
      } },
    { id: 'e3', type: 'agent_spec', confidence: 0.9, data: {
        name: 'Normal Extracted Agent', system_generated: false, conflict_classification: 'net_new',
      } },
  ];
  const { findings } = qualityCheck.runChecks(items);
  const invented = findings.filter(f => f.category === 'ai_invented_structure');
  ok(invented.length === 2, `exactly 2 ai_invented_structure findings for 3 items (got ${invented.length})`);

  const matchFinding = invented.find(f => f.entities[0].extraction_id === 'e1');
  ok(matchFinding && matchFinding.match_category === 'best_practice_match', 'matched item categorized as best_practice_match');
  ok(matchFinding && matchFinding.title.startsWith('Best-Practice Match:'), 'title names the category');
  ok(matchFinding && matchFinding.detail.includes('Triage assistant guidance'), 'detail names the matched rule by title');

  const suggestionFinding = invented.find(f => f.entities[0].extraction_id === 'e2');
  ok(suggestionFinding && suggestionFinding.match_category === 'ai_suggestion', 'unmatched invented item categorized as ai_suggestion');
  ok(suggestionFinding && suggestionFinding.title.startsWith('AI Suggestion:'), 'title names the category');

  ok(!invented.some(f => f.entities[0].extraction_id === 'e3'), 'a normal (non-invented) extraction raises no finding — unchanged from today');

  // ── Part 4: DB-backed end-to-end via runQualityCheck ────────────────────────
  console.log('\n--- Part 4: DB-backed runQualityCheck ---');
  const pid = mkProject();
  const ing = mkDoc(pid);
  mkBestPractice('BP-102', 'Standard routing queue rule', 'workflow');
  mkExtraction(ing, 'agent_spec', {
    name: 'Live-Seeded Assistant', system_generated: true, conflict_classification: 'net_new',
    best_practice_ref: 'BP-102', best_practice_title: 'Standard routing queue rule',
  }, 'staged', 0.6);
  const report = qualityCheck.runQualityCheck(db, ing);
  const liveFinding = report.findings.find(f => f.category === 'ai_invented_structure');
  ok(!!liveFinding, 'DB-backed check produces the finding');
  ok(liveFinding && liveFinding.match_category === 'best_practice_match', 'DB-backed finding categorized as best_practice_match');
  ok(liveFinding && liveFinding.detail.includes('Standard routing queue rule'), 'DB-backed finding names the rule from real entity_data JSON');

  console.log(`\n${pass} passed, ${fail} failed`);
  done(fail ? 1 : 0);
})();
