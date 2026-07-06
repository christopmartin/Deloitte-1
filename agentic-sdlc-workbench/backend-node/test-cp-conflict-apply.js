// test-cp-conflict-apply.js — regression test for BACKLOG #62:
// "ServiceNow-conflict approval silently drops the accepted value."
//
// HITL sync items stash SN-proposed conflict values under entity_data._sn_proposed
// (not a fieldMap key), so approving used to write NOTHING for exactly those fields:
//   (a) whole-CP Approve: applyChangePacket called mtUpdate with no forceCols →
//       the shrink guard dropped the (often shorter) SN value → old value survived
//       while the approval reported success;
//   (b) per-item approve WITHOUT explicit field_overrides (accept-as-is): same drop.
// The fix promotes _sn_proposed into real fields on approval and force-applies them
// (the same shrink-guard exception used for reviewer-typed overrides), persisting
// the merged new_value on the item for audit truth.
//
// Also asserts the non-destructive guard is UNCHANGED for fields that were NOT
// proposed/ratified (a shorter plain value still gets protected).
//
// Run:  node test-cp-conflict-apply.js   (from backend-node/)
'use strict';
const path = require('path');
const os   = require('os');

process.env.ASDLC_DB_PATH = path.join(os.tmpdir(), `asdlc_cpconf_${Date.now()}.db`);
process.env.PORT = String(8700 + Math.floor(Math.random() * 600));
process.env.ANTHROPIC_API_KEY = '';   // stub mode

const base = __dirname;
require(path.join(base, 'server.js'));
const { db, generateId } = require(path.join(base, 'db'));

const BASEURL = `http://127.0.0.1:${process.env.PORT}/api/v1`;
const HEADERS = { 'Content-Type': 'application/json', 'X-User-ID': 'test-cp-conflict' };

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { console.log('  ok  -', m); pass++; } else { console.error('  FAIL-', m); fail++; } };
function done(code) { try { db.close(); } catch { /* ignore */ } process.exit(code); }

const RICH_CONTRACT = 'Rich original contract: detailed request/response schema, SLAs, retry policy, auth model, and usage constraints preserved by the Workbench design.';
const SN_CONTRACT   = 'SN-proposed shorter contract (human ratified)';   // strictly shorter → old code silently dropped it

function makeFixture(label) {
  const project = db.prepare('SELECT project_id FROM asdlc_project LIMIT 1').get();
  const toolId = generateId();
  db.prepare(`INSERT INTO asdlc_tool (tool_id, project_id, name, contract, cost_impact, source_system, source_sys_id, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,datetime('now'),datetime('now'))`)
    .run(toolId, project.project_id, `Conflict Fixture Tool ${label}`, RICH_CONTRACT, '', 'servicenow', `sysid_${label}`);
  const cpId = generateId();
  db.prepare(`INSERT INTO asdlc_change_packet (change_packet_id, project_id, packet_code, status, summary, conflict_classification)
              VALUES (?,?,?,?,?,?)`)
    .run(cpId, project.project_id, `CP-TEST-${label}`, 'pending_review', `SN sync HITL conflicts (${label})`, 'modifies_existing');
  const itemId = generateId();
  const entityData = {
    source_system: 'servicenow',
    source_sys_id: `sysid_${label}`,
    name: 'Shrunk',                                  // shorter, NOT proposed/ratified → guard must still protect
    _sn_proposed: {
      contract: SN_CONTRACT,                         // shorter than the populated WB value → needs force
      cost_impact: '1 assist per call',              // fills an empty field
      not_a_real_key: 'ignored',                     // unknown keys must be dropped, not written
    },
  };
  db.prepare(`INSERT INTO asdlc_change_packet_item (change_packet_item_id, change_packet_id, entity_type, entity_id, operation, field_path, new_value, rationale)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(itemId, cpId, 'tool', toolId, 'update', 'tool.update', JSON.stringify(entityData),
         '[SN sync · conflict] needs human: contract (modify)');
  return { toolId, cpId, itemId };
}

function toolRow(id) { return db.prepare('SELECT * FROM asdlc_tool WHERE tool_id = ?').get(id); }
// tool.contract has a registry transform that wraps plain strings as {"text": ...} — unwrap for comparison.
function contractText(v) { try { const p = JSON.parse(v); return (p && p.text) || v; } catch { return v; } }
function itemRow(id) { return db.prepare('SELECT * FROM asdlc_change_packet_item WHERE change_packet_item_id = ?').get(id); }

async function main() {
  await new Promise(r => setTimeout(r, 900));   // let app.listen bind

  // ── Scenario A: whole-CP Approve (the button that silently dropped values) ──
  console.log('\n--- A: whole-CP approve applies _sn_proposed values ---');
  const A = makeFixture('A');
  let r = await fetch(`${BASEURL}/change-packets/${A.cpId}/approve`, { method: 'POST', headers: HEADERS, body: '{}' });
  assert(r.ok, `POST /change-packets/:id/approve → ${r.status}`);
  let tool = toolRow(A.toolId);
  assert(contractText(tool.contract) === SN_CONTRACT, 'ratified SN contract APPLIED despite being shorter (forced through shrink guard)');
  assert(tool.cost_impact === '1 assist per call', 'ratified SN cost_impact applied into the empty field');
  assert(tool.name === `Conflict Fixture Tool A`, 'non-ratified shorter name still PROTECTED by the non-destructive guard');
  assert(!('not_a_real_key' in tool), 'unknown proposed key ignored (not written anywhere)');
  let item = itemRow(A.itemId);
  assert(!String(item.new_value).includes('_sn_proposed'), 'item new_value merged — _sn_proposed cleared (audit truth)');
  assert(/accepted on approval/.test(item.item_decision_notes || ''), 'decision note records the acceptance');
  assert(item.applied_at, 'item marked applied');

  // ── Scenario B: per-item approve WITHOUT overrides (accept-as-is) ──────────
  console.log('\n--- B: per-item approve (no overrides) applies remaining _sn_proposed ---');
  const B = makeFixture('B');
  r = await fetch(`${BASEURL}/change-packet-items/${B.itemId}/approve`, { method: 'POST', headers: HEADERS, body: '{}' });
  assert(r.ok, `POST /change-packet-items/:id/approve → ${r.status}`);
  tool = toolRow(B.toolId);
  assert(contractText(tool.contract) === SN_CONTRACT, 'accept-as-is applies the proposed contract (was silently dropped)');
  assert(tool.cost_impact === '1 assist per call', 'accept-as-is fills the proposed cost_impact');
  assert(tool.name === `Conflict Fixture Tool B`, 'guard still protects the non-ratified name');

  // ── Scenario C: per-item approve WITH an override beats the SN proposal ────
  console.log('\n--- C: reviewer override wins over the SN proposal ---');
  const C = makeFixture('C');
  r = await fetch(`${BASEURL}/change-packet-items/${C.itemId}/approve`, {
    method: 'POST', headers: HEADERS,
    body: JSON.stringify({ field_overrides: { contract: 'Reviewer-edited contract wins' } }),
  });
  assert(r.ok, `POST per-item approve with field_overrides → ${r.status}`);
  tool = toolRow(C.toolId);
  assert(contractText(tool.contract) === 'Reviewer-edited contract wins', 'explicit reviewer override applied verbatim');
  assert(tool.cost_impact === '1 assist per call', 'remaining (non-overridden) SN proposal still applied');

  console.log(`\n=== test-cp-conflict-apply: ${pass} passed, ${fail} failed ===`);
  done(fail ? 1 : 0);
}

main().catch(err => { console.error('FATAL', err); done(1); });
