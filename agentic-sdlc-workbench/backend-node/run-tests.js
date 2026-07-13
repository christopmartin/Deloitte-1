// run-tests.js — aggregate runner for the test-*.js suites (backend-node/).
// Runs each suite in its own process (isolated temp DB + random port per file,
// per each suite's own setup) and stops at the first genuine failure.
//
// Known Windows-only quirk: a suite that boots a real HTTP server can hit a
// libuv abort on process.exit() ("Assertion failed: !(handle->flags &
// UV_HANDLE_CLOSING)") AFTER its own assertions all passed — an OS/runtime
// shutdown-race artifact, not a test failure. Detected by pattern (crash
// signature + a "0 failed" summary already printed) and reported as a
// warning instead of aborting the run.
// Run: node run-tests.js   (same as `npm test`)
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = __dirname;
const files = fs.readdirSync(dir)
  .filter((f) => /^test-.*\.js$/.test(f))
  .sort();

if (!files.length) {
  console.error('No test-*.js files found in', dir);
  process.exit(1);
}

console.log(`Running ${files.length} test suites...\n`);

const LIBUV_CRASH = /UV_HANDLE_CLOSING/;
const CLEAN_SUMMARY = /(\d+) passed, 0 failed/;

let failed = null;
const warnings = [];
for (const file of files) {
  console.log(`--- ${file} ---`);
  const result = spawnSync(process.execPath, [file], { cwd: dir, encoding: 'utf8' });
  const output = (result.stdout || '') + (result.stderr || '');
  process.stdout.write(output);

  if (result.status !== 0) {
    if (LIBUV_CRASH.test(output) && CLEAN_SUMMARY.test(output)) {
      warnings.push(file);
      console.log(`(known Windows libuv shutdown artifact — assertions passed, continuing)\n`);
      continue;
    }
    failed = file;
    break;
  }
  console.log('');
}

if (failed) {
  console.error(`\n=== FAILED at ${failed} ===`);
  process.exit(1);
}

console.log(`\n=== All ${files.length} test suites passed ===`);
if (warnings.length) {
  console.log(`(${warnings.length} suite(s) hit the known libuv shutdown artifact but all assertions passed: ${warnings.join(', ')})`);
}
process.exit(0);
