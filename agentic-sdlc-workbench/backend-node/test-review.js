// test-review.js — Phase E plumbing test (offline stub mode).
'use strict';
const path = require('path');
const os = require('os');
process.env.ASDLC_DB_PATH = path.join(os.tmpdir(), `asdlc_rv_${Date.now()}.db`);
process.env.ANTHROPIC_API_KEY = '';

const { db } = require('./db');
const rv = require('./agent/sn-review');

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { console.log('  ok  -', m); pass++; } else { console.error('  FAIL-', m); fail++; } };
const done = (code) => { try { db.close(); } catch {} process.exit(code); };

(async () => {
  console.log('--- Phase E: independent review (stub mode) ---');
  const proposals = [
    { classification: 'changed', source_sys_id: 's1', wb_table: 'asdlc_tool', wb_id: 'id1', proposal: { action: 'conflict', destructive: true, confidence: 0.8 } },
    { classification: 'changed', source_sys_id: 's2', wb_table: 'asdlc_tool', wb_id: 'id2', proposal: { action: 'enrich', destructive: false, confidence: 0.9 } },
    { classification: 'new', source_sys_id: 's3', proposal: { action: 'create', confidence: 0.7 } },
  ];
  const out = await rv.review(proposals, {});
  assert(out.length === 3, 'all proposals reviewed');
  const r1 = out[0].review, r2 = out[1].review, r3 = out[2].review;
  assert(r1.verdict === 'downgrade_to_hitl' && r1.destructive_confirmed === true, 'destructive proposal → downgrade_to_hitl + destructive_confirmed');
  assert(r2.verdict === 'approve' && r2.destructive_confirmed === false, 'non-destructive changed → approve');
  assert(r3.verdict === 'approve' && /low-risk/.test(r3.note || ''), 'new → pass-through approve (not adversarially reviewed)');
  assert(out.every(p => p.review && typeof p.review.final_confidence === 'number'), 'every proposal carries a review with final_confidence');
  assert(rv.SYSTEM_PROMPT.includes('adversarial') && rv.EMIT_TOOL.name === 'emit_review', 'adversarial framing in cached prefix; emit tool present');

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  done(fail ? 1 : 0);
})().catch(e => { console.error('TEST ERROR', e); done(1); });
