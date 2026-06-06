// run-live-extract.js — LIVE ServiceNow → Workbench closure test (REST path).
// Pulls the x_dnllp_p1 "ExxonMobil Invoice Lookup" AI-agent app via the read-only
// Table API (works with current basic-auth creds; the SDK init --from path is
// blocked on a keychain prompt), auto-creates/links the Workbench Application,
// runs the records through the REAL pipeline (/process → /promote → /approve),
// deterministically stamps the true sys_ids as Level-2 provenance, and verifies
// the agent + use case + 4 tools reappear (round-trip closure vs the seed EXX_*).
//
// Writes to the LIVE asdlc.db. Revert point #2 (clean new-schema, no SN data) exists.
'use strict';
const path = require('path');
const fs = require('fs');

process.env.PORT = process.env.PORT || '8077';   // distinct port to avoid clashing with a running app
const base = __dirname;
require(path.join(base, 'server.js'));                         // boots LIVE db + listens
const { db } = require(path.join(base, 'db'));
const fluentIngest = require(path.join(base, 'agent', 'fluent-ingest'));

// ── ServiceNow creds from root .env ──
const envTxt = fs.readFileSync('C:\\Users\\christopmartin\\Agentic Workbench\\.env', 'utf8');
const getEnv = (k) => { const m = envTxt.match(new RegExp('^\\s*' + k + '=(.*)$', 'm')); return m ? m[1].trim() : null; };
const SN = getEnv('SN_INSTANCE').replace(/\/$/, '');
const snAuth = 'Basic ' + Buffer.from(getEnv('SN_USER') + ':' + getEnv('SN_PASSWORD')).toString('base64');
const WB = `http://127.0.0.1:${process.env.PORT}/api/v1`;
const WBH = { 'Content-Type': 'application/json', 'X-User-ID': 'sn-extract' };
const SCOPE = 'x_dnllp_p1', SYSAPP = 'b9c3fc870aa5463c9ec9fee91b1fe9d7';

async function snGet(table, q, fields) {
  const u = `${SN}/api/now/table/${table}?sysparm_query=${encodeURIComponent(q)}&sysparm_fields=${encodeURIComponent(fields)}&sysparm_display_value=true&sysparm_exclude_reference_link=true&sysparm_limit=200`;
  const r = await fetch(u, { headers: { Authorization: snAuth, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`SN ${table} -> ${r.status}`);
  return (await r.json()).result;
}
async function wb(method, p, body) {
  const r = await fetch(WB + p, { method, headers: WBH, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${t.slice(0, 300)}`);
  return j;
}

(async () => {
  await new Promise(r => setTimeout(r, 1200));   // let app.listen bind + seed finish

  // 1) Pull the app's design records (read-only).
  const agents   = await snGet('sn_aia_agent',   'sys_scope.scope=' + SCOPE, 'sys_id,name,description,role,instructions');
  const usecases = await snGet('sn_aia_usecase', 'sys_scope.scope=' + SCOPE, 'sys_id,name,description');
  const tools    = await snGet('sn_aia_tool',    'sys_scope.scope=' + SCOPE, 'sys_id,name,type,description');
  console.log(`PULLED: ${agents.length} agent(s), ${usecases.length} use case(s), ${tools.length} tool(s)`);

  // 2) Find/create the Workbench Application linked to this ServiceNow app.
  const proj = fluentIngest.resolveOrCreateProject({ sysAppId: SYSAPP, scope: SCOPE, name: 'ExxonMobil Invoice Lookup', instance: SN });
  console.log(`PROJECT: ${proj.project_id} ${proj.created ? '(created)' : '(existing)'}`);

  // 3) Compose raw_text with per-record provenance headers.
  let rt = `# ServiceNow application: ExxonMobil Invoice Lookup (scope ${SCOPE})\n` +
           `# Extracted via Table API. For each record, copy the provenance header values verbatim\n` +
           `# into source_table / source_sys_id / source_scope.\n`;
  for (const uc of usecases) rt += `\n=== DESIGN RECORD ===\n// source_table: sn_aia_usecase\n// source_sys_id: ${uc.sys_id}\n// source_scope: ${SCOPE}\nUSE CASE: ${uc.name}\nDescription: ${uc.description || ''}\n`;
  for (const a of agents)   rt += `\n=== DESIGN RECORD ===\n// source_table: sn_aia_agent\n// source_sys_id: ${a.sys_id}\n// source_scope: ${SCOPE}\nAI AGENT: ${a.name}\nRole: ${a.role || ''}\nDescription: ${a.description || ''}\nInstructions: ${a.instructions || ''}\n`;
  for (const t of tools)    rt += `\n=== DESIGN RECORD ===\n// source_table: sn_aia_tool\n// source_sys_id: ${t.sys_id}\n// source_scope: ${SCOPE}\nTOOL: ${t.name}${t.type ? ' (' + t.type + ')' : ''}\nDescription: ${t.description || ''}\n`;

  // 4) Create the ingest document (document_type='fluent').
  const { ingest_id } = fluentIngest.createFluentIngestDocument({ projectId: proj.project_id, title: 'ExxonMobil Invoice Lookup (ServiceNow REST extract)', fluentText: rt });
  console.log(`INGEST DOC: ${ingest_id} (raw_text ${rt.length} chars)`);

  // 5) Process with REAL Claude.
  console.log('PROCESSING with Claude (real)…');
  await wb('POST', `/ingest-documents/${ingest_id}/process`);
  const staged = db.prepare("SELECT entity_type, COUNT(*) c FROM asdlc_ingest_extraction WHERE ingest_id=? AND status='staged' GROUP BY entity_type").all(ingest_id);
  const needClar = db.prepare("SELECT COUNT(*) c FROM asdlc_ingest_extraction WHERE ingest_id=? AND status='needs_clarification'").get(ingest_id).c;
  const openClar = db.prepare("SELECT COUNT(*) c FROM asdlc_ingest_clarification WHERE ingest_id=? AND answer_text IS NULL").get(ingest_id).c;
  console.log('STAGED:', JSON.stringify(staged), '| needs_clarification:', needClar, '| open clarifications:', openClar);

  const totalStaged = staged.reduce((s, r) => s + r.c, 0);
  if (totalStaged === 0) { console.log('No staged extractions — stopping for review.'); return; }

  // 6) Promote + approve.
  const promo = await wb('POST', `/ingest-documents/${ingest_id}/promote`);
  const cp = promo.change_packets && promo.change_packets[0];
  if (!cp) { console.log('Promote produced no change packet:', JSON.stringify(promo)); return; }
  console.log(`PROMOTED ${cp.packet_code}: ${JSON.stringify(cp.by_type)}`);
  const appr = await wb('POST', `/change-packets/${cp.change_packet_id}/approve`);
  console.log('APPROVED. apply_result:', JSON.stringify(appr.apply_result || {}));

  // 7) Deterministic provenance stamp — overwrite source_* on materialized agent/tool
  //    rows by exact name match, so identity is the TRUE sys_id (not LLM-copied).
  const stamp = (table, name, sysId) => db.prepare(
    `UPDATE ${table} SET source_system='servicenow', source_sys_id=?, source_scope=?, updated_at=datetime('now')
     WHERE project_id=? AND name=? AND (lifecycle_status IS NULL OR lifecycle_status!='retired')`
  ).run(sysId, SCOPE, proj.project_id, name).changes;
  let stamped = 0;
  for (const a of agents) stamped += stamp('asdlc_agent_spec', a.name, a.sys_id);
  for (const t of tools)  stamped += stamp('asdlc_tool', t.name, t.sys_id);
  console.log('PROVENANCE stamped on', stamped, 'rows (deterministic, true sys_ids)');
  fluentIngest.markSynced(proj.project_id);

  // 8) Verify closure.
  const ag = db.prepare("SELECT name, source_sys_id FROM asdlc_agent_spec WHERE project_id=? AND (lifecycle_status IS NULL OR lifecycle_status!='retired')").all(proj.project_id);
  const tl = db.prepare("SELECT name, source_sys_id FROM asdlc_tool WHERE project_id=? AND (lifecycle_status IS NULL OR lifecycle_status!='retired')").all(proj.project_id);
  const uc = db.prepare("SELECT title FROM asdlc_use_case WHERE project_id=? AND (lifecycle_status IS NULL OR lifecycle_status!='retired')").all(proj.project_id);
  console.log('\n=== MATERIALIZED in Workbench ===');
  console.log('Use cases:', uc.map(x => x.title).join(' | ') || '(none)');
  console.log('Agents:', ag.map(x => `${x.name} [sys_id ${x.source_sys_id ? x.source_sys_id.slice(0, 8) + '…' : 'NONE'}]`).join(' | ') || '(none)');
  console.log('Tools:', tl.map(x => `${x.name} [${x.source_sys_id ? 'prov' : 'no-prov'}]`).join(' | ') || '(none)');
  console.log(`\nCLOSURE: expected 1 agent / ${tools.length} tools / ${usecases.length} use case → got ${ag.length} agent / ${tl.length} tool / ${uc.length} uc`);
})().then(() => process.exit(0)).catch(e => { console.error('LIVE EXTRACT ERROR:', e.message); process.exit(1); });
