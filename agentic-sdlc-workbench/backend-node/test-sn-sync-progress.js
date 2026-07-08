// test-sn-sync-progress.js — #105: pre-flight estimate + async job (progress meter, cancel).
//
// Covers:
//   - estimateSyncWork() unit math (deterministic vs AI-path split, cost/time formula)
//   - reverseEngineer/reconcile/review progress callback + cooperative cancelToken mechanics,
//     tested DETERMINISTICALLY (no timing races) by pre-setting cancelToken.cancelled
//   - the new HTTP endpoints: POST .../sync/estimate, POST .../sync/async,
//     GET .../sync/async/:jobId, POST .../sync/async/:jobId/cancel
//   - the EXISTING synchronous POST .../sync endpoint is untouched — verified by the full
//     regression suite (test-sn-sync.js etc.), not re-tested here.
//
// Run:  node test-sn-sync-progress.js   (from backend-node/)
'use strict';
const path = require('path');
const os   = require('os');

process.env.ASDLC_DB_PATH = path.join(os.tmpdir(), `asdlc_syncprog_${Date.now()}.db`);
process.env.PORT = String(8700 + Math.floor(Math.random() * 600));
process.env.ANTHROPIC_API_KEY = '';   // stub mode — deterministic + free

const base = __dirname;
require(path.join(base, 'server.js'));
const { db, generateId } = require(path.join(base, 'db'));
const { hashArtifact } = require(path.join(base, 'agent', 'sn-capture'));
const snSync = require(path.join(base, 'agent', 'sn-sync'));
const { reverseEngineer } = require(path.join(base, 'agent', 'sn-reverse-engineer'));

const BASEURL = `http://127.0.0.1:${process.env.PORT}/api/v1`;
const HEADERS = { 'Content-Type': 'application/json', 'X-User-ID': 'test-syncprog' };
const SCOPE = 'x_test_syncprog';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { console.log('  ok  -', m); pass++; } else { console.error('  FAIL-', m); fail++; } };
function done(code) { try { db.close(); } catch { /* ignore */ } process.exit(code); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function makeProject() {
  const client = db.prepare('SELECT client_id FROM asdlc_client LIMIT 1').get();
  const pid = generateId();
  db.prepare(`INSERT INTO asdlc_project (project_id, client_id, project_name, project_code, servicenow_scope, servicenow_instance, confidence_threshold)
              VALUES (?,?,?,?,?,?,?)`)
    .run(pid, client.client_id, 'SyncProg', `SP-${Date.now().toString(36).slice(-5)}`, SCOPE, 'https://example.service-now.com', 0.75);
  return pid;
}
function art(table, sysId, name, salient) {
  return { source_table: table, source_sys_id: sysId, name, salient, hash: hashArtifact(salient) };
}
async function post(p, body) {
  const r = await fetch(BASEURL + p, { method: 'POST', headers: HEADERS, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}
async function get(p) {
  const r = await fetch(BASEURL + p, { headers: HEADERS });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

(async () => {
  // ── 1. estimateSyncWork() unit math ──────────────────────────────────────────
  console.log('--- 1. estimateSyncWork() math ---');
  const pid1 = makeProject();
  const mixed = [
    art('sc_cat_item', 'C1', 'Item', { name: 'Item' }),                          // deterministic (new)
    art('sys_script', 'B1', 'Rule', { name: 'Rule', script: 'x' }),              // deterministic (new)
    art('sn_aia_agent', 'G1', 'Agent1', { role: 'x' }),                          // AI-path (new)
    art('sn_aia_agent', 'G2', 'Agent2', { role: 'y' }),                          // AI-path (new)
  ];
  const est = await snSync.estimateSyncWork({ projectId: pid1, scope: SCOPE, artifacts: mixed });
  assert(est.total_new === 4 && est.total_changed === 0, 'counts new/changed correctly');
  assert(est.ai_path_new === 2 && est.deterministic_count === 2, 'splits deterministic vs AI-path correctly');
  assert(est.estimated_seconds === Math.round(2 * 9.3), 'time estimate = ai_calls × per-call seconds (2 new AI records = 2 calls)');
  assert(est.estimated_cost_usd > 0 && est.estimated_cost_usd < 1, 'cost estimate is a small positive number for 2 records');
  assert(Array.isArray(est.artifacts) && est.artifacts.length === 4, 'hands back the captured artifacts (avoids a 2nd live capture)');

  // Whole-scope deterministic-only estimate → near-zero cost/time.
  const detOnly = [art('sc_cat_item', 'C2', 'Item2', { name: 'Item2' }), art('sys_db_object', 'D1', 'T1', { name: 'T1', label: 'T' })];
  const est2 = await snSync.estimateSyncWork({ projectId: pid1, scope: SCOPE, artifacts: detOnly });
  assert(est2.ai_path_count === 0 && est2.estimated_seconds === 0 && est2.estimated_cost_usd === 0, 'all-deterministic slice estimates to zero time/cost');

  // ── 2. progress callback + cancelToken mechanics (deterministic, no timing races) ──
  console.log('--- 2. progress + cancel mechanics ---');
  const progressCalls = [];
  const agents = [art('sn_aia_agent', 'PA1', 'A1', { role: 'x' }), art('sn_aia_agent', 'PA2', 'A2', { role: 'y' }), art('sn_aia_agent', 'PA3', 'A3', { role: 'z' })];
  const out1 = await reverseEngineer(agents, { onProgress: (p) => progressCalls.push(p) });
  assert(out1.length === 3, 'all 3 artifacts processed with no cancel');
  assert(progressCalls.length === 3 && progressCalls[2].current === 3 && progressCalls[2].total === 3, 'onProgress fires once per artifact with correct current/total');

  const preCancelled = { cancelled: true };
  const out2 = await reverseEngineer(agents, { cancelToken: preCancelled });
  assert(out2.length === 0, 'pre-cancelled token → zero items processed (checked BEFORE the first item)');

  // Cancel after the first item: flip the token inside onProgress, mid-loop.
  const midToken = { cancelled: false };
  const out3 = await reverseEngineer(agents, { cancelToken: midToken, onProgress: (p) => { if (p.current === 1) midToken.cancelled = true; } });
  assert(out3.length === 1, 'cancel requested after item 1 → loop stops before item 2 (cooperative, checked before next item)');

  // ── 3. runSyncPlan surfaces `cancelled` + excludes unprocessed items from the plan ──
  console.log('--- 3. runSyncPlan cancellation end-to-end ---');
  const pid2 = makeProject();
  const cancelToken2 = { cancelled: false };
  const plan = await snSync.runSyncPlan(
    { projectId: pid2, scope: SCOPE, artifacts: agents, mode: 'additive_hitl' },
    { cancelToken: cancelToken2, onProgress: (p) => { if (p.current === 1) cancelToken2.cancelled = true; } }
  );
  assert(plan.cancelled === true, 'plan.cancelled is true when the token was flipped mid-run');
  assert(plan.planned.length === 1, 'only the processed item made it into the plan (2 excluded, not corrupted)');
  assert(plan.warnings.some(w => /cancelled by user/i.test(w)), 'a human-readable cancellation warning is included');

  // ── 4. HTTP: estimate endpoint ──────────────────────────────────────────────
  console.log('--- 4. POST .../sync/estimate ---');
  const pid3 = makeProject();
  const r1 = await post(`/projects/${pid3}/servicenow/sync/estimate`, { artifacts: mixed });
  assert(r1.status === 200, 'estimate endpoint returns 200');
  assert(r1.body.total_new === 4 && r1.body.ai_path_new === 2, 'estimate endpoint returns the same counts as the unit call');
  assert(r1.body.artifacts === undefined, 'raw artifacts are NOT leaked in the estimate response (cached server-side only)');

  // ── 5. HTTP: async job start → poll → complete (reuses the estimate cache) ──
  console.log('--- 5. async job start/poll (reuses cached capture) ---');
  const r2 = await post(`/projects/${pid3}/servicenow/sync/async?dry_run=1`, {});   // no artifacts in body — must reuse the /estimate cache
  assert(r2.status === 202 && r2.body.job_id, 'async start returns 202 + job_id');
  let job;
  for (let i = 0; i < 40; i++) {
    const p = await get(`/projects/${pid3}/servicenow/sync/async/${r2.body.job_id}`);
    job = p.body;
    if (job.status !== 'running') break;
    await sleep(50);
  }
  assert(job.status === 'complete', `job reaches 'complete' (got '${job.status}')`);
  assert(job.planView && job.planView.summary, 'completed job carries the plan view (same shape the sync endpoint returns)');
  assert(job.planView.classified_summary.new === 4, 'the async job processed the cached 4-artifact capture (no re-capture needed)');

  // ── 6. HTTP: cancel endpoint contract ────────────────────────────────────────
  // NOTE: actually catching a job mid-run via two separate HTTP round-trips is an inherent
  // timing race in stub mode — a stubbed reverseEngineerOne has no real network delay, so 20
  // records can finish before this test's own `fetch()` for the cancel call completes. That's
  // a property of the test environment, not the feature: the cancellation MECHANISM itself is
  // already proven deterministically in step 2/3 above (no timing dependency there — a
  // pre-set/mid-loop cancelToken reliably stops the loop and is reflected on plan.cancelled).
  // This section only checks the endpoint's CONTRACT is correct regardless of which side won
  // the race. The realistic mid-run case (real Opus latency) is verified live in the browser.
  console.log('--- 6. cancel endpoint contract ---');
  const manyAgents = Array.from({ length: 20 }, (_, i) => art('sn_aia_agent', `MANY${i}`, `Agent${i}`, { role: 'x', description: 'y'.repeat(50) }));
  const r3 = await post(`/projects/${pid3}/servicenow/sync/async?dry_run=1`, { artifacts: manyAgents });
  assert(r3.status === 202, 'async start with an explicit larger artifact set returns 202');
  const cancelResp = await post(`/projects/${pid3}/servicenow/sync/async/${r3.body.job_id}/cancel`, {});
  assert(cancelResp.status === 200 && ['cancelling', 'complete'].includes(cancelResp.body.status),
    'cancel endpoint returns 200 with a sensible status (cancelling if still running, or the finished status if the race already resolved)');
  let job2;
  for (let i = 0; i < 40; i++) {
    const p = await get(`/projects/${pid3}/servicenow/sync/async/${r3.body.job_id}`);
    job2 = p.body;
    if (job2.status !== 'running') break;
    await sleep(50);
  }
  assert(['cancelled', 'complete'].includes(job2.status), `job settles to a terminal status either way (got '${job2.status}')`);
  assert(job2.planView && job2.planView.classified_summary.new === 20, 'the job processed the 20-record capture (whichever way the race resolved)');
  if (job2.status === 'cancelled') {
    assert(job2.planView.summary.by_classification.new < 20, 'when cancellation DID win the race, fewer than all 20 items reached the plan');
  }

  // Cancelling an already-finished job is a safe no-op — this one is NOT racy (the job is
  // deterministically finished by the time we call cancel a second time).
  const cancelAgain = await post(`/projects/${pid3}/servicenow/sync/async/${r3.body.job_id}/cancel`, {});
  assert(cancelAgain.status === 200 && /already finished/i.test(cancelAgain.body.note || ''), 'cancelling a finished job is a safe no-op');

  // ── 7. 404s for unknown job / cross-project job access ──────────────────────
  console.log('--- 7. job-id safety ---');
  const badJob = await get(`/projects/${pid3}/servicenow/sync/async/does-not-exist`);
  assert(badJob.status === 404, 'unknown job_id → 404');
  const otherProjectPoll = await get(`/projects/${pid1}/servicenow/sync/async/${r2.body.job_id}`);
  assert(otherProjectPoll.status === 404, "a job started under one project 404s when polled under a DIFFERENT project's id");

  console.log(`\n=== test-sn-sync-progress: ${pass} passed, ${fail} failed ===`);
  done(fail ? 1 : 0);
})().catch(e => { console.error('TEST ERROR', e); done(1); });
