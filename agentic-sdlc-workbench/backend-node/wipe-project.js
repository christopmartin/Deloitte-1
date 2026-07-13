#!/usr/bin/env node
// wipe-project.js
//
// Removes all design data for a given project so it can be re-ingested from
// scratch, including its uploaded documents (Document Catalog). The project
// row itself and its configuration (members, AI settings) are preserved.
//
// To keep the Document Catalog while wiping only the design data derived from
// it, use the Administration > Data Maintenance page in the app instead —
// it calls the same underlying logic (./design-wipe.js) with keepDocuments:true.
//
// Usage:
//   node wipe-project.js                       ← lists all projects + IDs
//   node wipe-project.js <project_id>          ← shows count preview, prompts YES
//   node wipe-project.js <project_id> --yes    ← skips confirmation prompt
//
// See design-wipe.js for the full list of tables wiped and preserved.

'use strict';

const { db } = require('./db');
const { previewWipe, executeWipe } = require('./design-wipe');

const pid     = process.argv[2];
const skipYes = process.argv.includes('--yes');

if (!pid) {
  const projects = db.prepare(
    'SELECT project_id, project_name, project_code FROM asdlc_project ORDER BY created_at'
  ).all();
  console.log('\nAvailable projects:\n');
  projects.forEach(p =>
    console.log(`  ${p.project_id}  ${p.project_name} (${p.project_code})`)
  );
  console.log('\nUsage: node wipe-project.js <project_id> [--yes]\n');
  process.exit(0);
}

const project = db.prepare(
  'SELECT project_id, project_name FROM asdlc_project WHERE project_id=?'
).get(pid);
if (!project) {
  console.error(`No project found with id: ${pid}`);
  process.exit(1);
}

const { rows: preview, total: totalRows } = previewWipe(pid, { keepDocuments: false });

if (totalRows === 0) {
  console.log(`\n"${project.project_name}" has no design data — nothing to wipe.\n`);
  process.exit(0);
}

console.log(`\nWill delete from "${project.project_name}" (${pid}):\n`);
preview.forEach(({ label, count }) => console.log(`  ${String(count).padStart(5)}  ${label}`));
console.log(`\n  ${'─'.repeat(30)}`);
console.log(`  ${String(totalRows).padStart(5)}  total rows\n`);

function doWipe() {
  let result;
  try {
    result = executeWipe(pid, { keepDocuments: false });
  } catch (err) {
    console.error('\nRolled back — no changes made:', err.message);
    process.exit(1);
  }

  console.log('Deleted:');
  Object.entries(result.counts).forEach(([t, n]) => console.log(`  ${String(n).padStart(5)}  ${t}`));
  console.log(`\n  ${'─'.repeat(30)}`);
  console.log(`  ${String(result.total).padStart(5)}  total\n`);

  result.warnings.forEach(w => console.warn(`  [warn] ${w}`));

  if (result.fkClean) {
    console.log('FK integrity: CLEAN ✓');
  } else {
    console.warn(`⚠  FK integrity: orphan(s) remain in: ${result.orphanTables.join(', ')}`);
  }

  console.log(`\nDone — "${project.project_name}" is ready for fresh ingest.\n`);
}

if (skipYes) {
  doWipe();
} else {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('  Type YES to confirm wipe (anything else aborts): ', answer => {
    rl.close();
    if (answer.trim() === 'YES') {
      doWipe();
    } else {
      console.log('\nAborted — no changes made.\n');
    }
  });
}
