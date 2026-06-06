// test-reverse-engineer.js — Phase C plumbing test (offline stub mode, free/deterministic).
'use strict';
const path = require('path');
const os = require('os');
process.env.ASDLC_DB_PATH = path.join(os.tmpdir(), `asdlc_re_${Date.now()}.db`); // don't touch the live DB
process.env.ANTHROPIC_API_KEY = '';                                              // force stub mode

const re = require('./agent/sn-reverse-engineer');

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { console.log('  ok  -', m); pass++; } else { console.error('  FAIL-', m); fail++; } };

(async () => {
  const artifacts = [
    { source_table: 'sn_aia_agent', source_sys_id: 'a1', name: 'Invoice Status Lookup Assistant', salient: { role: 'Retrieve invoice status', description: 'Reads SR tickets, queries SAP, posts a work note' } },
    { source_table: 'sys_script', source_sys_id: 'b2', name: 'Notify gate agent on delay', salient: { collection: 'flight', when: 'after', condition: 'status changes to delayed', script: 'gs.eventQueue(...)' } },
    { source_table: 'sys_db_object', source_sys_id: 'c3', name: 'Flight', salient: { label: 'Flight', super_class: 'task' } },
  ];
  console.log('--- Phase C: reverse-engineer (stub mode) ---');
  const out = await re.reverseEngineer(artifacts, {});
  assert(out.length === 3, 'all artifacts processed');
  assert(out.every(o => o.stub === true), 'stub mode engaged (no API key)');
  assert(out[0].inferred.design_type === 'agent_spec', 'sn_aia_agent → agent_spec');
  assert(out[1].inferred.design_type === 'business_logic', 'sys_script → business_logic');
  assert(out[2].inferred.design_type === 'data_model', 'sys_db_object → data_model');
  assert(out.every(o => o.inferred.name && typeof o.inferred.confidence === 'number' && o.inferred.purpose), 'required inferred fields present');
  assert(out.every(o => o.source_sys_id), 'each result carries its source_sys_id');
  assert(re.SYSTEM_PROMPT.length > 800 && re.EMIT_TOOL.name === 'emit_inferred_design', 'static cache-prefix (system + tool) is substantial');

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST ERROR', e); process.exit(1); });
