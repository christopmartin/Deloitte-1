// test-materiality.js — reverse-path business-logic MATERIALITY gate test.
// Fully offline (no ANTHROPIC_API_KEY → the Opus agents stub). Drives the real
// POST /projects/:id/servicenow/sync endpoint with pre-supplied business-logic
// artifacts and asserts the materiality buckets.
//
// UPDATED for #103 (deterministic capture): business logic is now captured
// deterministically (direct-map, no AI) and — per the "a design entry per rule" decision —
// ALWAYS materializes; the Stage-2 significance/confidence heuristic no longer suppresses it.
// What still holds:
//   - business_rule / script_include / client_script / ui_action → ALWAYS elevated
//     (deterministic capture; narrative blank until "Explain with AI")
//   - data_model (not business-logic)         → ALWAYS elevated
//   - materiality_disallow_types=['client_script'] → both client scripts skipped
//     PRE-inference (skipped_disallowed) — Stage 1 remains the category-exclusion lever
//   - materiality_min_confidence no longer drops deterministic business logic (there is no
//     AI confidence to gate on — the capture is a faithful copy)
//
// Run:  node test-materiality.js   (from backend-node/)
'use strict';
const path = require('path');
const os   = require('os');

process.env.ASDLC_DB_PATH = path.join(os.tmpdir(), `asdlc_materiality_${Date.now()}.db`);
process.env.PORT = String(8800 + Math.floor(Math.random() * 600));
process.env.ANTHROPIC_API_KEY = '';   // stub mode — deterministic + free

const base = __dirname;
require(path.join(base, 'server.js'));
const { db, generateId } = require(path.join(base, 'db'));
const { hashArtifact } = require(path.join(base, 'agent', 'sn-capture'));

const BASEURL = `http://127.0.0.1:${process.env.PORT}/api/v1`;
const HEADERS = { 'Content-Type': 'application/json', 'X-User-ID': 'test-materiality' };
const SCOPE = 'x_test_materiality';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { console.log('  ok  -', m); pass++; } else { console.error('  FAIL-', m); fail++; } };
function done(code) { try { db.close(); } catch { /* ignore */ } process.exit(code); }

async function post(p, body) {
  const r = await fetch(BASEURL + p, { method: 'POST', headers: HEADERS, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`POST ${p} -> ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

function art(table, design_type, sysId, name, salient) {
  return { source_table: table, design_type, source_sys_id: sysId, name, salient, hash: hashArtifact(salient) };
}

// Capture-shaped artifacts (salient fields mirror sn-capture SN_SURFACES).
const businessRule = art('sys_script', 'business_rule', 'sysBR', 'Set Adoption Status',
  { name: 'Set Adoption Status', collection: 'x_adopt_adoption', when: 'before',
    condition: 'current.status.changes()', script: '(function(){ current.status = "Pending"; })();' });
const scriptInclude = art('sys_script_include', 'script_include', 'sysSI', 'AdoptionUtils',
  { name: 'AdoptionUtils', script: 'var AdoptionUtils = Class.create(); AdoptionUtils.prototype = {};' });
const trivialCS = art('sys_script_client', 'client_script', 'sysCS1', 'Set Default Region',
  { name: 'Set Default Region', table: 'x_adopt_adoption', type: 'onLoad',
    script: 'g_form.setValue("region", "west");' });
const longBody = 'function onChange(control, oldValue, newValue, isLoading){ '.padEnd(520, 'x') + ' }';
const significantCS = art('sys_script_client', 'client_script', 'sysCS2', 'Validate Return Date',
  { name: 'Validate Return Date', table: 'x_adopt_adoption', type: 'onChange', script: longBody });
const dataModel = art('sys_db_object', 'data_model', 'sysDM', 'Adoption',
  { name: 'x_adopt_adoption', label: 'Adoption', super_class: '' });

const ARTIFACTS = [businessRule, scriptInclude, trivialCS, significantCS, dataModel];

async function main() {
  await new Promise(r => setTimeout(r, 900));

  const client = db.prepare('SELECT client_id FROM asdlc_client LIMIT 1').get();
  const pid = generateId();
  db.prepare(`INSERT INTO asdlc_project (project_id, client_id, project_name, project_code, servicenow_scope, servicenow_instance, confidence_threshold)
              VALUES (?,?,?,?,?,?,?)`)
    .run(pid, client.client_id, 'Materiality Test', 'MATTEST', SCOPE, 'https://example.service-now.com', 0.75);

  const names = b => b.map(x => x.name).sort();

  // ── Run A: default (deterministic capture — every rule materializes, #103) ──
  console.log('\n--- Run A: deterministic capture (a design entry per rule) ---');
  const a = await post(`/projects/${pid}/servicenow/sync?dry_run=1`, { artifacts: ARTIFACTS, threshold: 0 });
  const mA = a.plan.materiality;
  assert(!!mA, 'plan exposes a materiality block');
  assert(mA.elevated === 5, `all 5 elevate — BR, SI, both CS, DM (deterministic capture, no significance drop) — got ${mA.elevated}`);
  assert(mA.captured_not_elevated.length === 0, 'nothing captured_not_elevated — the significance heuristic no longer suppresses deterministic business logic');
  assert(mA.skipped_disallowed.length === 0, 'nothing skipped (no disallow types configured)');
  assert(a.plan.summary.elevated_new === 5 && a.plan.summary.captured_not_elevated === 0,
    'summary carries elevated_new + captured_not_elevated counts');

  // ── Run B: disallow client_script entirely (Stage 1, pre-inference) ──
  console.log('\n--- Run B: materiality_disallow_types = ["client_script"] ---');
  db.prepare('UPDATE asdlc_project SET materiality_disallow_types = ? WHERE project_id = ?')
    .run(JSON.stringify(['client_script']), pid);
  const b = await post(`/projects/${pid}/servicenow/sync?dry_run=1`, { artifacts: ARTIFACTS, threshold: 0 });
  const mB = b.plan.materiality;
  assert(mB.skipped_disallowed.length === 2 && JSON.stringify(names(mB.skipped_disallowed)) === JSON.stringify(['Set Default Region', 'Validate Return Date']),
    'both client scripts skipped PRE-inference (disallowed type)');
  assert(mB.elevated === 3, `3 elevated (BR, SI, DM) — got ${mB.elevated}`);
  assert(mB.captured_not_elevated.length === 0, 'no Stage-2 drops (client scripts never reached inference)');

  // ── Run C: min_confidence no longer suppresses deterministic business logic ──
  console.log('\n--- Run C: materiality_min_confidence = 0.9 (moot for deterministic capture) ---');
  db.prepare('UPDATE asdlc_project SET materiality_disallow_types = ?, materiality_min_confidence = ? WHERE project_id = ?')
    .run('[]', 0.9, pid);
  const c = await post(`/projects/${pid}/servicenow/sync?dry_run=1`, { artifacts: ARTIFACTS, threshold: 0 });
  const mC = c.plan.materiality;
  assert(mC.config.min_confidence === 0.9, 'materiality config min_confidence reflected (0.9)');
  assert(mC.captured_not_elevated.length === 0, 'no confidence drops — a deterministic field-copy has no AI confidence to gate on');
  assert(mC.elevated === 5, `all 5 still elevate despite min_confidence 0.9 — got ${mC.elevated}`);

  // ── Run D: real apply (not dry) — every rule materializes; business_logic holds Tier-3 body ──
  console.log('\n--- Run D: deterministic apply — entry per rule + Tier-3 source_fluent ---');
  db.prepare('UPDATE asdlc_project SET materiality_min_confidence = NULL WHERE project_id = ?').run(pid);
  await post(`/projects/${pid}/servicenow/sync`, { artifacts: ARTIFACTS, threshold: 0 });
  const blRow = db.prepare("SELECT name, plain_english, source_sys_id, source_fluent FROM asdlc_business_logic WHERE project_id=? AND source_sys_id='sysBR'").get(pid);
  assert(!!blRow, 'business_rule elevated into asdlc_business_logic');
  assert(blRow.source_sys_id === 'sysBR', 'elevated row carries source_sys_id (Tier-3 identity)');
  assert(blRow.source_fluent && /current\.status/.test(blRow.source_fluent), 'elevated row holds the real script body in source_fluent (Tier-3 instantiation)');
  assert(!blRow.plain_english, 'deterministic capture leaves the plain-English narrative BLANK (until "Explain with AI")');
  const trivialRow = db.prepare("SELECT plain_english FROM asdlc_business_logic WHERE project_id=? AND source_sys_id='sysCS1'").get(pid);
  assert(!!trivialRow, 'trivial client_script NOW becomes a Level-1 row too (a design entry per rule, #103)');
  assert(!trivialRow.plain_english, 'trivial client_script row also has a blank narrative');

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  done(fail ? 1 : 0);
}

main().catch(e => { console.error('TEST ERROR', e); done(1); });
