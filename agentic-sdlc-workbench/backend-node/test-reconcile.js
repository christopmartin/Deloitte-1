// test-reconcile.js — Phase D plumbing test (offline stub mode).
'use strict';
const path = require('path');
const os = require('os');
process.env.ASDLC_DB_PATH = path.join(os.tmpdir(), `asdlc_rc_${Date.now()}.db`);
process.env.ANTHROPIC_API_KEY = '';

const { db, generateId } = require('./db');
const rec = require('./agent/sn-reconcile');

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { console.log('  ok  -', m); pass++; } else { console.error('  FAIL-', m); fail++; } };
const done = (code) => { try { db.close(); } catch {} process.exit(code); };

const pid = generateId();
db.prepare("INSERT INTO asdlc_client (client_id,client_name,client_code) VALUES (?,?,?)").run('c1', 'C', 'C1');
db.prepare("INSERT INTO asdlc_project (project_id,client_id,project_name,project_code) VALUES (?,?,?,?)").run(pid, 'c1', 'P', 'P1');
const toolId = generateId();
db.prepare("INSERT INTO asdlc_tool (tool_id,project_id,name,contract,source_system,source_sys_id,source_table) VALUES (?,?,?,?,?,?,?)")
  .run(toolId, pid, 'Invoice Search Lookup', '{"text":"Rich existing contract with lots of detail"}', 'servicenow', 'sysT', 'sn_aia_tool');

(async () => {
  console.log('--- Phase D: reconcile (stub mode) ---');
  const input = {
    changed: [{ source_sys_id: 'sysT', wb_table: 'asdlc_tool', wb_id: toolId, inferred: { design_type: 'tool', name: 'Invoice Search Lookup', purpose: 'lookup invoices', confidence: 0.7 } }],
    new:     [{ source_sys_id: 'sysNEW', inferred: { design_type: 'tool', name: 'Supplier Master Lookup', purpose: 'resolve supplier', confidence: 0.72 } }],
    drift:   [{ source_sys_id: 'sysD', wb_table: 'asdlc_tool', wb_id: 'gone-id', name: 'Retired Tool' }],
  };
  const out = await rec.reconcile(input, {});
  assert(out.length === 3, 'all three buckets produced proposals');
  const ch = out.find(p => p.classification === 'changed');
  const nw = out.find(p => p.classification === 'new');
  const dr = out.find(p => p.classification === 'drift');
  assert(ch && ch.proposal.action === 'no_change' && ch.proposal._stub, 'changed → stub no_change (offline)');
  assert(ch && ch.proposal.destructive === false, 'changed proposal is non-destructive');
  assert(nw && nw.proposal.action === 'create' && nw.proposal.name === 'Supplier Master Lookup', 'new → create proposal');
  assert(dr && dr.proposal.action === 'flag_drift' && dr.proposal.destructive === false, 'drift → flag_drift, never delete');
  assert(rec.SYSTEM_PROMPT.includes('NON-DESTRUCTIVE') && rec.EMIT_TOOL.name === 'emit_reconciliation', 'non-destructive rule in cached prefix; emit tool present');

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  done(fail ? 1 : 0);
})().catch(e => { console.error('TEST ERROR', e); done(1); });
