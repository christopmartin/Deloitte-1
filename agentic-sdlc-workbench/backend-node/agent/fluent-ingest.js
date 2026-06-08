// agent/fluent-ingest.js
// ─────────────────────────────────────────────────────────────────────────────
// ServiceNow round-trip — INBOUND adapter.
//
// Turns a ServiceNow app's transformed Fluent source (*.now.ts) into an ingest
// document the EXISTING Workbench pipeline can extract (claude-processor →
// cross-check → stage → Change Packet → applyChangePacket → design tables).
//
// A ServiceNow extraction is just a new ingestion SOURCE: we feed the Fluent
// text as the ingest document's raw_text, with document_type='fluent'. Each
// construct is preceded by a provenance header comment so the extractor can
// carry Level-2 identity (source_table / source_sys_id / source_scope) onto each
// Level-1 design record, plus the construct itself into source_fluent.
//
// PRODUCTION PATH (when instance creds are available):
//   1. now-sdk init --from <sys_app sys_id>     (download metadata XML)
//   2. now-sdk transform --from .               (XML → Fluent *.now.ts)
//   3. readFluentDir(generatedDir)              (collect the files)
//   4. createFluentIngestDocument(...)          (create the ingest doc)
// HARDENING TODO: a deterministic pass should parse keys.ts to attach
// source_sys_id per construct rather than relying on the model to copy it.
// For hand-authored fixtures the provenance headers are written inline.
'use strict';

const fs = require('fs');
const path = require('path');
const { db, generateId } = require('../db');

/** Read *.now.ts files under a directory (current level + one nested level). */
function readFluentDir(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      for (const sub of fs.readdirSync(full)) {
        if (sub.endsWith('.now.ts')) {
          out.push({ file: `${name}/${sub}`, text: fs.readFileSync(path.join(full, sub), 'utf8') });
        }
      }
    } else if (name.endsWith('.now.ts')) {
      out.push({ file: name, text: fs.readFileSync(full, 'utf8') });
    }
  }
  return out;
}

/** Concatenate Fluent files into one raw_text blob with file banners + guidance. */
function buildRawText(files, { scope } = {}) {
  const header = [
    '# ServiceNow application design — transformed Fluent source',
    scope ? `# Scope: ${scope}` : '',
    '#',
    '# Each design record below is preceded by a provenance header comment:',
    '#   // source_table:  <ServiceNow metadata table>',
    '#   // source_sys_id: <sys_id of the source record>',
    '#   // source_scope:  <application scope>',
    '# When extracting, copy those three values VERBATIM into the matching fields',
    '# (source_table, source_sys_id, source_scope) and copy the construct itself',
    '# into source_fluent. Never invent a sys_id.',
    '',
  ].filter(Boolean).join('\n');
  const bodies = files.map(f => `\n/* ===== FILE: ${f.file} ===== */\n${f.text}`);
  return header + bodies.join('\n');
}

/**
 * Create an ingest document (document_type='fluent') from Fluent source text.
 * The existing /process → /promote → approve pipeline takes it from here.
 * @returns {{ ingest_id: string }}
 */
function createFluentIngestDocument({ projectId, title, fluentText, uploadedBy = null }) {
  const id = generateId();
  db.prepare(`
    INSERT INTO asdlc_ingest_document
      (ingest_id, project_id, document_title, file_name, file_type, document_type,
       description, ingest_status, uploaded_by, file_path, raw_text,
       uploaded_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?, 'pending', ?, NULL, ?, datetime('now'), datetime('now'), datetime('now'))
  `).run(
    id, projectId, title, null, 'ts', 'fluent',
    'ServiceNow application design extracted via the Fluent SDK transform.',
    uploadedBy, fluentText
  );
  return { ingest_id: id };
}

/** Convenience: read a directory of Fluent files and create the ingest doc in one step. */
function ingestFluentDir({ projectId, dir, scope, title, uploadedBy = null }) {
  const files = readFluentDir(dir);
  const fluentText = buildRawText(files, { scope });
  return { ...createFluentIngestDocument({ projectId, title, fluentText, uploadedBy }), files, fluentText };
}

// ── Application linking: find/create the Workbench project for a ServiceNow app ──
// Ensures extraction lands in the right Application and that re-pulls reuse it.
function ensureServiceNowClient() {
  const c = db.prepare("SELECT client_id FROM asdlc_client WHERE client_code = 'SNOW' LIMIT 1").get();
  if (c) return c.client_id;
  const cid = generateId();
  db.prepare(`INSERT INTO asdlc_client (client_id, client_name, client_code, created_by, updated_by)
              VALUES (?, ?, ?, ?, ?)`).run(cid, 'ServiceNow', 'SNOW', 'fluent-ingest', 'fluent-ingest');
  return cid;
}

/**
 * Find the Workbench project linked to a ServiceNow sys_app id, or create one
 * (under a default "ServiceNow" client) and stamp the link. Idempotent on sysAppId.
 * @returns {{ project_id: string, created: boolean }}
 */
function resolveOrCreateProject({ sysAppId, scope, name, instance } = {}) {
  if (sysAppId) {
    const hit = db.prepare(
      "SELECT project_id FROM asdlc_project WHERE servicenow_sys_app_id = ? AND (lifecycle_status IS NULL OR lifecycle_status != 'retired') LIMIT 1"
    ).get(sysAppId);
    if (hit) return { project_id: hit.project_id, created: false };
  }
  const clientId = ensureServiceNowClient();
  const id = generateId();
  const code = ('SN-' + (scope || sysAppId || id)).slice(0, 40);
  db.prepare(`
    INSERT INTO asdlc_project
      (project_id, client_id, project_name, project_code, stage,
       servicenow_scope, servicenow_sys_app_id, servicenow_instance, created_by, updated_by)
    VALUES (?, ?, ?, ?, 'build', ?, ?, ?, ?, ?)
  `).run(id, clientId, name || scope || 'ServiceNow App', code,
         scope || null, sysAppId || null, instance || null, 'fluent-ingest', 'fluent-ingest');
  return { project_id: id, created: true };
}

/** Stamp the project's last-synced timestamp after a successful extraction ingest. */
function markSynced(projectId) {
  db.prepare("UPDATE asdlc_project SET sn_last_synced_at = datetime('now'), updated_at = datetime('now') WHERE project_id = ?").run(projectId);
}

module.exports = { readFluentDir, buildRawText, createFluentIngestDocument, ingestFluentDir, resolveOrCreateProject, markSynced };
