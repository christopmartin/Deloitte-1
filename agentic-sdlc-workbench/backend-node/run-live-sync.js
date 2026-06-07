// run-live-sync.js — LIVE ServiceNow → Workbench SYNC (Phase F end-to-end).
// Drives the real POST /projects/:id/servicenow/sync endpoint against the linked
// "ExxonMobil Invoice Lookup" project (x_dnllp_p1) using the round .env SN creds.
//
//   node run-live-sync.js            → DRY RUN (read-only): live capture + reconcile +
//                                       gate, prints the plan, writes NOTHING to the DB.
//                                       (Still spends Opus $ on the 3 reasoning agents.)
//   node run-live-sync.js --apply    → REAL apply: auto-applies safe additive changes
//                                       (non-destructively, storing source_hash) and
//                                       queues everything else as a pending_review CP.
//
// SAFETY: --apply writes to the LIVE asdlc.db. Before running it: (1) stop any other
// server on the live DB, (2) take a backup —  `node backup-db.js`. The non-destructive
// guard is a hard floor (never blanks/shrinks/deletes populated Workbench content), but
// a backup is cheap insurance.
'use strict';
const path = require('path');
const fs = require('fs');

const APPLY = process.argv.includes('--apply');
process.env.PORT = process.env.PORT || '8078';   // distinct port
const base = __dirname;
require(path.join(base, 'server.js'));            // boots LIVE db + listens
const { db } = require(path.join(base, 'db'));

// SN creds from the root .env (PowerShell Invoke-RestMethod is flaky; node fetch is fine).
const envTxt = fs.readFileSync('C:\\Users\\christopmartin\\Agentic Workbench\\.env', 'utf8');
const getEnv = (k) => { const m = envTxt.match(new RegExp('^\\s*' + k + '=(.*)$', 'm')); return m ? m[1].trim() : null; };
const SN_INSTANCE = (getEnv('SN_INSTANCE') || '').replace(/\/$/, '');
const SN_USER = getEnv('SN_USER');
const SN_PASSWORD = getEnv('SN_PASSWORD');

const WB = `http://127.0.0.1:${process.env.PORT}/api/v1`;
const WBH = { 'Content-Type': 'application/json', 'X-User-ID': 'sn-sync-live' };
const SYSAPP = 'b9c3fc870aa5463c9ec9fee91b1fe9d7';   // x_dnllp_p1 ExxonMobil Invoice Lookup

async function wb(method, p, body) {
  const r = await fetch(WB + p, { method, headers: WBH, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${typeof t === 'string' ? t.slice(0, 400) : ''}`);
  return j;
}

(async () => {
  await new Promise(r => setTimeout(r, 1200));   // let app.listen bind + (no) seed
  if (!SN_INSTANCE || !SN_USER || !SN_PASSWORD) throw new Error('Missing SN creds in root .env (SN_INSTANCE/SN_USER/SN_PASSWORD)');

  // Resolve the linked Workbench project.
  const resolved = await wb('GET', `/servicenow/resolve-project?sys_app_id=${SYSAPP}`);
  const project = resolved.project;
  if (!project) throw new Error(`No Workbench project linked to sys_app ${SYSAPP}. Run run-live-extract.js first.`);
  console.log(`PROJECT: ${project.project_name} (${project.project_id}) scope=${project.servicenow_scope}`);
  console.log(APPLY ? '\n*** APPLY MODE — will write to the LIVE DB ***\n' : '\n--- DRY RUN — no writes ---\n');

  const creds = { instance: SN_INSTANCE, user: SN_USER, pw: SN_PASSWORD };
  const url = `/projects/${project.project_id}/servicenow/sync${APPLY ? '' : '?dry_run=1'}`;
  const res = await wb('POST', url, creds);

  const plan = res.plan || {};
  console.log('MODE:', plan.mode, '| THRESHOLD:', plan.threshold);
  console.log('CLASSIFIED:', JSON.stringify(plan.classified_summary));
  console.log('GATE SUMMARY:', JSON.stringify(plan.summary));
  if (plan.errors && plan.errors.length) console.log('CAPTURE ERRORS:', plan.errors.join('; '));
  console.log('\nITEMS:');
  for (const it of (plan.items || [])) {
    console.log(` - [${it.classification}] ${it.name} | action=${it.action} verdict=${it.verdict} conf=${it.confidence != null ? it.confidence.toFixed(2) : '—'} ` +
      `destr=${it.destructive} -> ${it.decision && it.decision.target} (${it.decision && it.decision.reason})`);
    if (it.issues && it.issues.length) console.log(`     issues: ${it.issues.join('; ')}`);
  }

  if (APPLY) {
    const r = res.result || {};
    console.log('\n=== APPLIED ===');
    if (r.auto_cp) console.log(`AUTO ${r.auto_cp.packet_code}: ${r.auto_cp.item_count} item(s), apply_result=${JSON.stringify(r.auto_cp.apply_result)}`);
    if (r.hitl_cp) console.log(`HITL ${r.hitl_cp.packet_code}: ${r.hitl_cp.item_count} item(s) pending_review`);
    console.log(`hash_advanced=${r.hash_advanced || 0}`);
    if (r.dropped && r.dropped.length) console.log('DROPPED:', JSON.stringify(r.dropped));
  } else {
    console.log('\n(DRY RUN complete — re-run with --apply to materialize, after `node backup-db.js`.)');
  }
})().then(() => { try { db.close(); } catch {} process.exit(0); })
   .catch(e => { console.error('LIVE SYNC ERROR:', e.message); try { db.close(); } catch {} process.exit(1); });
