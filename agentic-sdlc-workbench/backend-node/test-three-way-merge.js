// test-three-way-merge.js
// ─────────────────────────────────────────────────────────────────────────────
// R7 — pure unit tests for the deterministic per-field 3-way classifier
// (agent/three-way-merge.js). No DB, no network, no AI.
'use strict';
const { classifyFields, snFieldDelta, mergeSafe, parseBase, summarize } = require('./agent/three-way-merge');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  -', m); } else { fail++; console.error('  FAIL-', m); } };

console.log('--- parseBase: shapes ---');
ok(parseBase(null).form === 'empty' && parseBase('').form === 'empty', 'null / empty base → form=empty');
ok(parseBase({ a: 1 }).form === 'json', 'object base → form=json');
ok(parseBase('{"a":"1"}').form === 'json', 'JSON string base → form=json');
ok(parseBase('function onBefore(){}').form === 'body', 'raw script body → form=body (single logical field)');

console.log('\n--- classifyFields: the four buckets ---');
{
  const base = { a: '1', b: '2', c: '3' };
  const wb   = { a: '1', b: '2edited', c: '3' };   // WB moved b
  const sn   = { a: '1new', b: '2', c: '3' };      // SN moved a
  const fc = classifyFields(base, wb, sn);
  ok(fc.available, 'available with an object base');
  ok(fc.fields.a.kind === 'sn_only', 'a: SN moved, WB did not → sn_only');
  ok(fc.fields.b.kind === 'wb_only', 'b: WB moved, SN did not → wb_only');
  ok(fc.fields.c.kind === 'unchanged', 'c: neither moved → unchanged');
  ok(fc.summary.sn_only === 1 && fc.summary.wb_only === 1 && fc.summary.unchanged === 1 && fc.summary.both_changed === 0, 'summary counts correct');
  ok(fc.summary.has_both_changed === false, 'no conflict flagged');
}

console.log('\n--- classifyFields: conflict + agreement ---');
{
  const base = { a: '1' };
  const conflict = classifyFields(base, { a: 'wbval' }, { a: 'snval' });
  ok(conflict.fields.a.kind === 'both_changed', 'both sides moved to DIFFERENT values → both_changed');
  ok(conflict.summary.has_both_changed === true, 'conflict flagged');
  const agree = classifyFields(base, { a: 'same' }, { a: 'same' });
  ok(agree.fields.a.kind === 'unchanged', 'both sides moved to the SAME value → unchanged (no conflict)');
}

console.log('\n--- classifyFields: deliberate-clear (fill_blank-resurrection fix) ---');
{
  // base had a value, the Workbench user CLEARED it, ServiceNow still holds the old value.
  const base = { note: 'original' };
  const wb   = { note: '' };            // deliberately cleared
  const sn   = { note: 'original' };    // SN unchanged (== base)
  const fc = classifyFields(base, wb, sn);
  ok(fc.fields.note.kind === 'wb_only', 'cleared field is wb_only (SN did not move) — NOT a fill_blank');
  const merged = mergeSafe(wb, fc);
  ok(merged.note === '' || merged.note === undefined, 'mergeSafe KEEPS the cleared field — the old SN value is never resurrected');
}

console.log('\n--- classifyFields: new SN field is applied by mergeSafe ---');
{
  const base = { a: '1' };
  const wb   = { a: '1' };
  const sn   = { a: '1', b: 'brand new from SN' };   // SN added b
  const fc = classifyFields(base, wb, sn);
  ok(fc.fields.b.kind === 'sn_only', 'a field only ServiceNow has (absent from base+WB) → sn_only');
  const merged = mergeSafe(wb, fc);
  ok(merged.b === 'brand new from SN' && merged.a === '1', 'mergeSafe applies the new SN field, keeps WB fields');
}

console.log('\n--- classifyFields: script-body form (whole-body compare) ---');
{
  const base = 'function f(){ return 1; }';
  const fcSame = classifyFields(base, base, base, { bodyField: 'script' });
  ok(fcSame.form === 'body' && fcSame.fields.script.kind === 'unchanged', 'identical body → unchanged (single script field)');
  const fcSn = classifyFields(base, base, 'function f(){ return 2; }');
  ok(fcSn.fields.script.kind === 'sn_only', 'SN changed the body, WB did not → sn_only');
}

console.log('\n--- classifyFields: unavailable base → caller falls back ---');
{
  const fc = classifyFields(null, { a: '1' }, { a: '2' });
  ok(fc.available === false, 'no base snapshot → available:false (record-level floor used instead)');
  ok(summarize(null).available === false, 'summarize(null) → available:false');
}

console.log('\n--- snFieldDelta: which SN fields moved since base ---');
{
  const base = { a: '1', b: '2' };
  const cur  = { a: '1', b: '2CHANGED', c: '3ADDED' };
  const d = snFieldDelta(base, cur);
  ok(d.available && d.changed.includes('b') && d.changed.includes('c') && !d.changed.includes('a'), 'delta names only the moved/added SN fields (b, c) — not the unchanged a');
  const dBody = snFieldDelta('body v1', 'body v2', { bodyField: 'script' });
  ok(dBody.available && dBody.changed.includes('script'), 'body-form delta reports the script field when the body changed');
  ok(snFieldDelta(null, { a: 1 }).available === false, 'no base → delta unavailable');
}

console.log(`\n=== test-three-way-merge: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
