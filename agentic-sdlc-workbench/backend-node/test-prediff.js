// test-prediff.js — Phase B: deterministic pre-diff (classifyArtifacts) unit test.
// Pure logic, temp DB, no server, no ServiceNow. Verifies unchanged/changed/new/drift.
'use strict';
const path = require('path');
const os = require('os');
process.env.ASDLC_DB_PATH = path.join(os.tmpdir(), `asdlc_pd_${Date.now()}.db`);

const { db, generateId } = require('./db');
const cap = require('./agent/sn-capture');

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { console.log('  ok  -', m); pass++; } else { console.error('  FAIL-', m); fail++; } };
const done = (code) => { try { db.close(); } catch {} process.exit(code); };

// ── fixtures: a project with three SN-sourced tools ──
const pid = generateId();
db.prepare("INSERT INTO asdlc_client (client_id,client_name,client_code) VALUES (?,?,?)").run('c1', 'Client', 'C1');
db.prepare("INSERT INTO asdlc_project (project_id,client_id,project_name,project_code) VALUES (?,?,?,?)").run(pid, 'c1', 'Proj', 'P1');
const insTool = (name, sysId, hash) => db.prepare(
  "INSERT INTO asdlc_tool (tool_id,project_id,name,source_system,source_sys_id,source_table,source_hash) VALUES (?,?,?,?,?,?,?)"
).run(generateId(), pid, name, 'servicenow', sysId, 'sn_aia_tool', hash);

const salientA = { name: 'Tool A', type: 'rest', description: 'Looks up A' };
const salientB = { name: 'Tool B', type: 'rest', description: 'Looks up B (changed in SN)' };
insTool('Tool A', 'sys-A', cap.hashArtifact(salientA));   // WB hash == capture hash  → UNCHANGED
insTool('Tool B', 'sys-B', 'OLDHASH');                     // WB hash != capture hash  → CHANGED
insTool('Tool C', 'sys-C', cap.hashArtifact({ x: 1 }));    // not in capture           → DRIFT

const artifacts = [
  { source_table: 'sn_aia_tool', design_type: 'tool', source_sys_id: 'sys-A', name: 'Tool A', salient: salientA, hash: cap.hashArtifact(salientA) },
  { source_table: 'sn_aia_tool', design_type: 'tool', source_sys_id: 'sys-B', name: 'Tool B', salient: salientB, hash: cap.hashArtifact(salientB) },
  { source_table: 'sn_aia_tool', design_type: 'tool', source_sys_id: 'sys-NEW', name: 'Tool New', salient: { name: 'Tool New' }, hash: cap.hashArtifact({ name: 'Tool New' }) },
];

console.log('--- Phase B: deterministic pre-diff ---');
assert(cap.hashArtifact(salientA) === cap.hashArtifact(salientA), 'hashArtifact is deterministic');
const r = cap.classifyArtifacts(artifacts, pid);
console.log('  summary:', JSON.stringify(r.summary));
assert(r.summary.unchanged === 1 && r.unchanged[0].source_sys_id === 'sys-A', 'unchanged: matching sys_id + hash skips the LLM (sys-A)');
assert(r.summary.changed === 1 && r.changed[0].source_sys_id === 'sys-B' && r.changed[0].prev_hash === 'OLDHASH', 'changed: matching sys_id, differing hash (sys-B)');
assert(r.summary.new === 1 && r.new[0].source_sys_id === 'sys-NEW', 'new: unknown sys_id (sys-NEW)');
assert(r.summary.drift === 1 && r.drift[0].source_sys_id === 'sys-C', 'drift: WB record absent from SN capture (sys-C) — flagged, never deleted');
assert(r.changed[0].wb_id && r.changed[0].wb_table === 'asdlc_tool', 'changed item carries the resolved WB target (id + table)');

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
done(fail ? 1 : 0);
