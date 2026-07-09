// server.js — Agentic SDLC Workbench API
'use strict';

require('dotenv').config();          // load .env before anything else

// Corporate SSL inspection presents a self-signed cert chain Node.js rejects.
// SN_INSECURE_TLS=true disables verification for all outbound HTTPS from this process.
// Proper fix: set NODE_EXTRA_CA_CERTS=/path/to/corp-root-ca.pem instead.
if (process.env.SN_INSECURE_TLS === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('[tls] SN_INSECURE_TLS=true — TLS certificate verification disabled. Set NODE_EXTRA_CA_CERTS to your corporate root CA PEM for a proper fix.');
}

const path = require('path');
const fs = require('fs');
const express = require('express');
const { db, generateId, auditLog, nextSlug, getSetting, setSetting } = require('./db');
const { encrypt: encryptField, decrypt: decryptField } = require('./crypto-util');
const registry = require('./agent/entity-registry');
const { deriveSwimlane } = require('./agent/swimlane-deriver');
const { relinkOrphanRequirements, repairProjectDesign } = require('./agent/design-repair');
const aiConfig = require('./agent/ai-config');
const reviewQueue = require('./agent/review-queue');
const { withWiki } = require('./agent/wiki-context');
const { buildDesignReviewHtml } = require('./report-html');

// Strip the encrypted password from a project row before sending to the client.
// Returns sn_user (plaintext) and has_sn_password (boolean) instead.
function scrubProject(project) {
  if (!project) return project;
  const { sn_password_enc, ...rest } = project;
  rest.has_sn_password = !!(sn_password_enc);
  return rest;
}

// Phase 1 enum constants (Decisions #2, #16, #17, #18) — used for validation
// in PUT endpoints. SQLite CHECK constraints back-stop these, but validating
// at the app layer gives nicer error messages.
const ENUMS = {
  risk_tier:              ['High', 'Medium', 'Low'],
  supervision_model_3val: ['Advisory-only', 'Supervised HITL', 'Autonomous'],
  orchestration_strategy: ['Base Planner', 'ReActive Planner', 'Batch Planner'],
  step_type:              ['Start', 'Activity', 'Decision', 'Approval', 'Notification', 'Wait', 'End'],
  dev_status:             ['Existing', 'To be built'],
  trigger_type_6val:      ['Manual', 'Record-based trigger', 'Now Assist Panel', 'UI Action', 'Automated/async', 'Timed'],
  // Phase 2
  participant_type:       ['Orchestrator Agent', 'Specialist Agent', 'Human Role', 'Human Coordinator'],
  authority_level:        ['Advise only', 'Draft only', 'Execute (human)', 'Execute (gated)', 'Execute (autonomous)'],
  handoff_method:         ['Task creation', 'Assignment', 'Comment', 'Panel response', 'Notification', 'Other'],
  rasic_code:             ['R', 'A', 'S', 'C', 'I'],
};

/**
 * Validate that a value belongs to an enum (or is null/undefined/empty).
 * Throws an Error with a clear message on mismatch.
 */
function validateEnum(value, enumValues, fieldName) {
  if (value === null || value === undefined || value === '') return;
  if (!enumValues.includes(value)) {
    throw new Error(`${fieldName}: invalid value "${value}". Must be one of: ${enumValues.join(', ')}`);
  }
}
const { seed } = require('./seed');

// Run seed on startup
seed();

const multer = require('multer');
const app  = express();
const PORT = process.env.PORT || 8000;

// ── Multer — file upload storage ──────────────────────────────────────────────
const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 30 * 1024 * 1024 }, // 30 MB hard cap
  fileFilter: (_req, file, cb) => {
    const allowed = /\.(docx?|txt|csv|json|md|mp3|wav|m4a|mp4|webm|ogg)$/i;
    if (allowed.test(file.originalname)) return cb(null, true);
    cb(new Error(`File type not supported: ${path.extname(file.originalname)}`));
  },
});

// ──────────────────────────────────────────────
// Middleware
// ──────────────────────────────────────────────
app.use(express.json());

// CORS — allow all origins
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS,PATCH');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-ID');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Static frontend
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────
const userId = (req) => req.headers['x-user-id'] || null;
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/** Parse a JSON string column safely; return original value if not JSON */
function parseJson(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

const JSON_COLS = [
  'goals', 'done_criteria', 'inputs', 'outputs', 'run_as_model',
  'design_risks', 'success_criteria', 'constraints_list',
  'volume_assumptions', 'trigger_def', 'handoffs', 'decisions',
  'fallback_paths', 'decisions_list', 'raci', 'hitl_tags',
  'contract', 'errors', 'access_requirements', 'boundaries',
];

function parseRow(row) {
  if (!row) return row;
  const out = { ...row };
  for (const col of JSON_COLS) {
    if (col in out) out[col] = parseJson(out[col]);
  }
  return out;
}

function parseRows(rows) {
  return rows.map(parseRow);
}

// ──────────────────────────────────────────────
// COST PARAMETERS (fully per-Application model)
// ──────────────────────────────────────────────
// All cost params (pricing + planning + entitlement) live on asdlc_project.
// Each customer/application negotiates its own ServiceNow price sheet. The
// legacy global asdlc_cost_assumption row is kept for backward-compat reads
// only and used as a fallback when a project row has not been populated yet.
//
// Pricing fields: cost_per_assist, overage_rate, cost_per_assist_expansion
//   (cost_per_assist_expansion is stored for forward use; no calc consumes it yet)
// Plan fields:    planning_period, periods_per_year
// Entitlement:    entitlement_enabled, annual_included_assists
function getEffectiveCostParams(projectId) {
  const globalRow = db.prepare(
    `SELECT cost_per_assist, overage_rate FROM asdlc_cost_assumption LIMIT 1`
  ).get() || {};
  let projRow = null;
  if (projectId) {
    projRow = db.prepare(
      `SELECT planning_period, periods_per_year, entitlement_enabled, annual_included_assists,
              cost_per_assist, overage_rate, cost_per_assist_expansion
       FROM asdlc_project WHERE project_id = ?`
    ).get(projectId);
  }
  return {
    // Per-application pricing (with legacy global fallback for safety).
    cost_per_assist:           projRow?.cost_per_assist           ?? globalRow.cost_per_assist ?? 0.015,
    overage_rate:              projRow?.overage_rate              ?? globalRow.overage_rate    ?? null,
    cost_per_assist_expansion: projRow?.cost_per_assist_expansion ?? null,
    // Per-application planning + entitlement.
    planning_period:         projRow?.planning_period         ?? 'Monthly',
    periods_per_year:        projRow?.periods_per_year        ?? 12,
    entitlement_enabled:     projRow?.entitlement_enabled     ?? 0,
    annual_included_assists: projRow?.annual_included_assists ?? null,
  };
}

// ──────────────────────────────────────────────
// USERS
// ──────────────────────────────────────────────
app.get('/api/v1/users', (req, res) => {
  const rows = db.prepare('SELECT * FROM asdlc_user WHERE active = 1').all();
  res.json(rows);
});

app.get('/api/v1/users/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM asdlc_user WHERE user_id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'User not found' });
  res.json(row);
});

// ──────────────────────────────────────────────
// DASHBOARD
// ──────────────────────────────────────────────
app.get('/api/v1/dashboard', (req, res) => {
  const activeProjects = db.prepare(
    "SELECT COUNT(*) AS n FROM asdlc_project WHERE lifecycle_status = 'active'"
  ).get().n;

  const openChangePkts = db.prepare(
    "SELECT COUNT(*) AS n FROM asdlc_change_packet WHERE status = 'pending'"
  ).get().n;

  const failedValidations = db.prepare(
    "SELECT COUNT(*) AS n FROM asdlc_change_packet WHERE validation_status = 'failed'"
  ).get().n;

  const pendingApprovals = db.prepare(
    "SELECT COUNT(*) AS n FROM asdlc_change_packet WHERE status = 'pending' AND baseline_impacting = 1"
  ).get().n;

  const recentChanges = db.prepare(`
    SELECT cp.*, p.project_name, p.project_code
    FROM asdlc_change_packet cp
    LEFT JOIN asdlc_project p ON p.project_id = cp.project_id
    ORDER BY cp.updated_at DESC
    LIMIT 10
  `).all();

  // "Missing owner" = a step with no owning participant/lane (person role, AI agent,
  // or supporting system). owner_participant_id is the canonical owner; owner_member_id
  // is only the optional *specific human* for human-role participants, so it is NOT the
  // signal here (it is null on every agent/system step). This matches the swimlane's
  // own missing-owner definition (swimlane.js).
  const missingOwners = db.prepare(`
    SELECT ws.*, wf.name AS workflow_name, p.project_code
    FROM asdlc_workflow_step ws
    LEFT JOIN asdlc_workflow wf ON wf.workflow_id = ws.workflow_id
    LEFT JOIN asdlc_project p ON p.project_id = ws.project_id
    WHERE ws.owner_participant_id IS NULL
      AND (ws.lifecycle_status IS NULL OR ws.lifecycle_status NOT IN ('retired', 'deleted'))
    LIMIT 6
  `).all();

  // Reusable records: library-scope use cases, workflows, tools
  const reusableUc = db.prepare(
    "SELECT 'use_case' AS type, use_case_id AS id, title AS name FROM asdlc_use_case WHERE visibility_scope != 'PROJECT' LIMIT 3"
  ).all();
  const reusableWf = db.prepare(
    "SELECT 'workflow' AS type, workflow_id AS id, name FROM asdlc_workflow WHERE visibility_scope != 'PROJECT' LIMIT 3"
  ).all();
  const reusableTool = db.prepare(
    "SELECT 'tool' AS type, tool_id AS id, name FROM asdlc_tool WHERE visibility_scope != 'PROJECT' LIMIT 3"
  ).all();
  const reusableRecords = [...reusableUc, ...reusableWf, ...reusableTool].slice(0, 9);

  res.json({
    active_projects: activeProjects,
    open_change_packets: openChangePkts,
    failed_validations: failedValidations,
    pending_approvals: pendingApprovals,
    recent_changes: parseRows(recentChanges),
    missing_owners: parseRows(missingOwners),
    reusable_records: parseRows(reusableRecords),
  });
});

// ──────────────────────────────────────────────
// PROJECTS
// ──────────────────────────────────────────────
app.get('/api/v1/projects', (req, res) => {
  const { client_id } = req.query;
  let sql = `
    SELECT p.*, c.client_name, c.client_code
    FROM asdlc_project p
    LEFT JOIN asdlc_client c ON c.client_id = p.client_id
    WHERE p.lifecycle_status = 'active'
  `;
  const params = [];
  if (client_id) { sql += ' AND p.client_id = ?'; params.push(client_id); }
  sql += ' ORDER BY p.updated_at DESC';
  res.json(db.prepare(sql).all(...params).map(scrubProject));
});

app.get('/api/v1/projects/:id', (req, res) => {
  const project = db.prepare(`
    SELECT p.*, c.client_name, c.client_code
    FROM asdlc_project p
    LEFT JOIN asdlc_client c ON c.client_id = p.client_id
    WHERE p.project_id = ?
  `).get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const members = db.prepare(`
    SELECT pm.*, u.email
    FROM asdlc_project_member pm
    LEFT JOIN asdlc_user u ON u.user_id = pm.user_id
    WHERE pm.project_id = ? AND pm.active = 1
  `).all(req.params.id);

  res.json({ ...scrubProject(project), members });
});

// ── Clients ──────────────────────────────────────────────────────────────────
// List active clients (used to populate the New Application client dropdown).
app.get('/api/v1/clients', (req, res) => {
  const rows = db.prepare(
    "SELECT client_id, client_name, client_code FROM asdlc_client WHERE lifecycle_status != 'retired' ORDER BY client_name"
  ).all();
  res.json(rows);
});

// Create a new client (so a brand-new application can be attached to a brand-new customer).
app.post('/api/v1/clients', (req, res) => {
  const { client_name, client_code } = req.body || {};
  if (!client_name || !client_code) {
    return res.status(400).json({ error: 'client_name and client_code are required' });
  }
  const code = String(client_code).trim().toUpperCase();
  const existing = db.prepare('SELECT * FROM asdlc_client WHERE client_code = ?').get(code);
  if (existing) return res.status(409).json({ error: `Client code "${code}" already exists.`, client: existing });
  const id = generateId();
  const uid = userId(req);
  db.prepare(`
    INSERT INTO asdlc_client (client_id, client_name, client_code, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, String(client_name).trim(), code, uid, uid);
  const created = db.prepare('SELECT * FROM asdlc_client WHERE client_id = ?').get(id);
  auditLog('asdlc_client', id, 'INSERT', null, created, uid);
  res.status(201).json(created);
});

app.post('/api/v1/projects', (req, res) => {
  const { client_id, project_name, project_code, stage, target_platform,
          servicenow_scope, servicenow_sys_app_id, servicenow_instance } = req.body;
  if (!client_id || !project_name || !project_code) {
    return res.status(400).json({ error: 'client_id, project_name and project_code are required' });
  }
  // Validate the FK up-front so the caller gets a clear 400 instead of a raw
  // "FOREIGN KEY constraint failed" 500 when client_id isn't a real client.
  const clientRow = db.prepare('SELECT client_id FROM asdlc_client WHERE client_id = ?').get(client_id);
  if (!clientRow) {
    return res.status(400).json({ error: `Unknown client_id "${client_id}". Pick an existing client or create one first.` });
  }
  const dupe = db.prepare('SELECT * FROM asdlc_project WHERE client_id = ? AND project_code = ?').get(client_id, project_code);
  if (dupe) {
    return res.status(409).json({ error: `Application code "${project_code}" already exists for this client.`, project: scrubProject(dupe) });
  }
  const id = generateId();
  const uid = userId(req);
  const tplat = ['servicenow', 'generic'].includes(target_platform) ? target_platform : 'servicenow';
  db.prepare(`
    INSERT INTO asdlc_project
      (project_id, client_id, project_name, project_code, stage, target_platform,
       servicenow_scope, servicenow_sys_app_id, servicenow_instance, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, client_id, project_name, project_code, stage || 'draft', tplat,
         servicenow_scope || null, servicenow_sys_app_id || null, servicenow_instance || null, uid, uid);
  const created = db.prepare('SELECT * FROM asdlc_project WHERE project_id = ?').get(id);
  auditLog('asdlc_project', id, 'INSERT', null, created, uid);
  res.status(201).json(scrubProject(created));
});

// ── ServiceNow round-trip: link a Workbench Application to a ServiceNow app ──
// Set/clear the link (scope + sys_app id + instance + optional per-project credentials).
// sn_password = "" clears stored credentials; omitted = leave existing creds unchanged.
app.post('/api/v1/projects/:id/servicenow-link', (req, res) => {
  const uid = userId(req);
  const existing = db.prepare('SELECT * FROM asdlc_project WHERE project_id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Project not found' });
  const { servicenow_scope, servicenow_sys_app_id, servicenow_instance, sn_user, sn_password } = req.body || {};

  // Credential handling: explicit empty string → clear; absent → keep existing; value → encrypt+store.
  let newSnUser = existing.sn_user;
  let newSnPasswordEnc = existing.sn_password_enc;
  if (sn_password === '') {
    newSnUser = null;
    newSnPasswordEnc = null;
  } else if (typeof sn_password === 'string' && sn_password.length > 0) {
    newSnUser = typeof sn_user === 'string' ? sn_user : (existing.sn_user || null);
    newSnPasswordEnc = encryptField(sn_password);
  } else if (typeof sn_user === 'string') {
    newSnUser = sn_user || null;
  }

  db.prepare(`
    UPDATE asdlc_project
       SET servicenow_scope = ?, servicenow_sys_app_id = ?, servicenow_instance = ?,
           sn_user = ?, sn_password_enc = ?,
           updated_by = ?, updated_at = datetime('now')
     WHERE project_id = ?
  `).run(servicenow_scope || null, servicenow_sys_app_id || null, servicenow_instance || null,
         newSnUser, newSnPasswordEnc, uid, req.params.id);
  const after = db.prepare('SELECT * FROM asdlc_project WHERE project_id = ?').get(req.params.id);
  auditLog('asdlc_project', req.params.id, 'UPDATE', existing, after, uid);
  res.json(scrubProject(after));
});

// ── Clear per-project ServiceNow credentials (revert to env-var fallback) ──────
app.delete('/api/v1/projects/:id/servicenow-credentials', (req, res) => {
  const uid = userId(req);
  const existing = db.prepare('SELECT * FROM asdlc_project WHERE project_id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Project not found' });
  db.prepare(`
    UPDATE asdlc_project SET sn_user = NULL, sn_password_enc = NULL,
           updated_by = ?, updated_at = datetime('now')
     WHERE project_id = ?
  `).run(uid, req.params.id);
  const after = db.prepare('SELECT * FROM asdlc_project WHERE project_id = ?').get(req.params.id);
  auditLog('asdlc_project', req.params.id, 'UPDATE', existing, after, uid);
  res.json(scrubProject(after));
});

// Resolve the Workbench project linked to a ServiceNow sys_app id (or scope) —
// used to target extraction at the right Application. Returns {project:null} if none.
app.get('/api/v1/servicenow/resolve-project', (req, res) => {
  const sysApp = req.query.sys_app_id;
  const scope  = req.query.scope;
  if (!sysApp && !scope) return res.status(400).json({ error: 'sys_app_id or scope is required' });
  const row = sysApp
    ? db.prepare("SELECT project_id, project_name, servicenow_scope, servicenow_sys_app_id, sn_last_synced_at FROM asdlc_project WHERE servicenow_sys_app_id = ? AND (lifecycle_status IS NULL OR lifecycle_status != 'retired') LIMIT 1").get(sysApp)
    : db.prepare("SELECT project_id, project_name, servicenow_scope, servicenow_sys_app_id, sn_last_synced_at FROM asdlc_project WHERE servicenow_scope = ? AND (lifecycle_status IS NULL OR lifecycle_status != 'retired') LIMIT 1").get(scope);
  res.json({ project: row || null });
});

// ── ServiceNow instance assessment / fit analysis (Phase 0, read-only) ────────
// Resolve credentials (body → project link → env), insert a `running` row, then run
// the read-only discovery off the request path (202 + poll), mirroring ingest/process.
const snAssess = require('./agent/sn-assess');
const snCatalog = require('./agent/sn-instance-catalog');

/**
 * Insert a 'running' asdlc_sn_assessment row and return its id — synchronous, so a caller
 * that needs to respond 202 immediately (the manual endpoint below) has the id in hand before
 * the actual (possibly long) scan starts.
 */
function createAssessmentRow({ project, instance, scopes, uid }) {
  const aid = generateId();
  db.prepare(`
    INSERT INTO asdlc_sn_assessment (assessment_id, project_id, instance_url, scopes_json, status, created_by, created_at, updated_at)
    VALUES (?,?,?,?,'running',?,datetime('now'),datetime('now'))
  `).run(aid, project.project_id, instance.replace(/\/$/, ''), JSON.stringify(scopes || []), uid);
  return aid;
}

/**
 * Run the actual read-only scan and persist its result (or failure) onto an existing
 * 'running' row. Shared by the manual "Scan instance" endpoint (fire-and-forget) and the
 * discovery-plan generate endpoint's automatic assessment (awaited) — same row shape either
 * way, so a later visit to the Assessment page can't tell which path created it. Throws on
 * failure (after persisting status='failed') so an awaiting caller can turn it into a clear
 * error instead of silently continuing on missing data.
 * @returns {Promise<object>} the report, on success.
 */
async function runAssessment(aid, { instance, user, pw, scopes }) {
  try {
    const report = await snAssess.assessInstance({ instance, user, pw, scopes });
    report.assessed_at = new Date().toISOString();
    const v = report.capacity_verdict || {};
    const cov = report.coverage_summary || {};
    const summary = `${report.version && report.version.family ? report.version.family : 'unknown'} · ${report.volume.total_artifacts} artifacts · capacity ${v.level || '?'} · coverage ${cov.mapped || 0} mapped/${cov.partial || 0} partial/${cov.unmapped || 0} unmapped`;
    db.prepare("UPDATE asdlc_sn_assessment SET status='complete', report_json=?, summary=?, updated_at=datetime('now') WHERE assessment_id=?")
      .run(JSON.stringify(report), summary, aid);
    return report;
  } catch (err) {
    console.error('[sn-assess] failed:', err.message);
    db.prepare("UPDATE asdlc_sn_assessment SET status='failed', error=?, updated_at=datetime('now') WHERE assessment_id=?")
      .run(String(err.message).slice(0, 1000), aid);
    throw err;
  }
}

app.post('/api/v1/projects/:id/servicenow/assess', (req, res) => {
  const uid = userId(req);
  const project = db.prepare("SELECT * FROM asdlc_project WHERE project_id=?").get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const body = req.body || {};
  const instance = body.instance || project.servicenow_instance || process.env.SN_INSTANCE;
  const user = body.user || project.sn_user || process.env.SN_USER;
  const pw   = body.pw   || decryptField(project.sn_password_enc) || process.env.SN_PASSWORD;
  if (!instance || !user || !pw) {
    return res.status(400).json({ error: 'ServiceNow credentials required (set them on the Application, or SN_INSTANCE/SN_USER/SN_PASSWORD env).' });
  }
  // scopes: explicit list in body, else the project's linked scope, else whole-instance discovery.
  const scopes = Array.isArray(body.scopes) && body.scopes.length
    ? body.scopes
    : (project.servicenow_scope ? [project.servicenow_scope] : undefined);

  const aid = createAssessmentRow({ project, instance, scopes, uid });
  res.status(202).json({ assessment_id: aid, status: 'running' });
  runAssessment(aid, { instance, user, pw, scopes }).catch(() => { /* already persisted as failed */ });
});

// Fast, synchronous credential/connectivity check (no assessment row, no capability probing) —
// lets a user verify a username/password at the point of entry on the Applications screen,
// instead of only discovering a bad login later via an empty Scan/Sync result.
app.post('/api/v1/projects/:id/servicenow/test-connection', async (req, res) => {
  const project = db.prepare("SELECT * FROM asdlc_project WHERE project_id=?").get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const body = req.body || {};
  const instance = body.instance || project.servicenow_instance || process.env.SN_INSTANCE;
  const user = body.user || project.sn_user || process.env.SN_USER;
  const pw   = body.pw   || decryptField(project.sn_password_enc) || process.env.SN_PASSWORD;
  try {
    const result = await snAssess.checkConnection({ instance, user, pw });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, status: null, message: 'Connection test failed: ' + err.message });
  }
});

// List assessments for a project (newest first; no heavy report_json).
app.get('/api/v1/projects/:id/servicenow/assessments', (req, res) => {
  const rows = db.prepare(`
    SELECT assessment_id, project_id, instance_url, scopes_json, status, summary, error, created_by, created_at, updated_at
    FROM asdlc_sn_assessment WHERE project_id=? ORDER BY created_at DESC LIMIT 50
  `).all(req.params.id);
  res.json(rows);
});

// Fetch one assessment with its full report.
app.get('/api/v1/projects/:id/servicenow/assessments/:aid', (req, res) => {
  const row = db.prepare("SELECT * FROM asdlc_sn_assessment WHERE assessment_id=? AND project_id=?")
    .get(req.params.aid, req.params.id);
  if (!row) return res.status(404).json({ error: 'Assessment not found' });
  let report = null;
  try { report = row.report_json ? JSON.parse(row.report_json) : null; } catch { /* leave null */ }
  res.json({ ...row, report });
});

// ── Slice-scoped ingest: the project's editable IMPORT PROFILE ────────────────
// Bounds a ServiceNow ingest to a SLICE of a scope (surface/type selection now; a future
// record filter later). GET returns the saved profile, else a seed derived from the latest
// assessment's recommended_profile (source: 'saved' | 'assessment_seed' | 'none').
app.get('/api/v1/projects/:id/servicenow/import-profile', (req, res) => {
  const project = db.prepare("SELECT project_id, servicenow_scope, sn_import_profile_json FROM asdlc_project WHERE project_id=?").get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (project.sn_import_profile_json) {
    let profile = null; try { profile = JSON.parse(project.sn_import_profile_json); } catch { profile = null; }
    if (profile) return res.json({ profile, source: 'saved' });
  }
  // Seed from the latest complete assessment's recommended_profile (never persisted until PUT).
  const asr = db.prepare("SELECT report_json FROM asdlc_sn_assessment WHERE project_id=? AND status='complete' ORDER BY created_at DESC LIMIT 1").get(req.params.id);
  let seed = null;
  if (asr && asr.report_json) {
    try {
      const rp = (JSON.parse(asr.report_json) || {}).recommended_profile;
      if (rp) seed = {
        scope: project.servicenow_scope || (Array.isArray(rp.scopes) ? rp.scopes[0] : null) || null,
        include_types: [],
        include_surfaces: Array.isArray(rp.include_surfaces) ? rp.include_surfaces : [],
        per_surface_cap: rp.per_surface_cap || null,
        record_filters: {},
      };
    } catch { /* leave seed null */ }
  }
  res.json({ profile: seed, source: seed ? 'assessment_seed' : 'none' });
});

/**
 * Persist a project's import-profile slice (or clear it to whole-scope). Shared by the
 * PUT /import-profile endpoint and the discovery-plan approve endpoint (below) so both
 * write through the EXACT same validation + audit path. Never throws — returns
 * { profile, source } on success or { error: { status, message } } on a bad request.
 */
function persistImportProfile(project, body, uid) {
  const surfaces = Array.isArray(body.include_surfaces) ? body.include_surfaces.filter(s => typeof s === 'string' && s) : [];
  const clear = body.clear === true || (!surfaces.length && !body.scope);
  if (clear) {
    db.prepare("UPDATE asdlc_project SET sn_import_profile_json=NULL, updated_by=?, updated_at=datetime('now') WHERE project_id=?").run(uid, project.project_id);
    auditLog('asdlc_project', project.project_id, 'UPDATE', { sn_import_profile_json: project.sn_import_profile_json }, { sn_import_profile_json: null }, uid);
    return { profile: null, source: 'none' };
  }
  if (!surfaces.length) return { error: { status: 400, message: 'include_surfaces must be a non-empty array of ServiceNow table names (or send {clear:true} to reset to whole-scope).' } };
  const capNum = Number(body.per_surface_cap);
  const profile = {
    scope: (typeof body.scope === 'string' && body.scope) ? body.scope : (project.servicenow_scope || null),
    include_types: Array.isArray(body.include_types) ? body.include_types.filter(t => typeof t === 'string') : [],
    include_surfaces: surfaces,
    per_surface_cap: (Number.isFinite(capNum) && capNum > 0) ? Math.floor(capNum) : null,
    record_filters: (body.record_filters && typeof body.record_filters === 'object' && !Array.isArray(body.record_filters)) ? body.record_filters : {},
  };
  db.prepare("UPDATE asdlc_project SET sn_import_profile_json=?, updated_by=?, updated_at=datetime('now') WHERE project_id=?").run(JSON.stringify(profile), uid, project.project_id);
  auditLog('asdlc_project', project.project_id, 'UPDATE', { sn_import_profile_json: project.sn_import_profile_json }, { sn_import_profile_json: JSON.stringify(profile) }, uid);
  return { profile, source: 'saved' };
}

// PUT saves the import profile (bounds later ingests), or resets to whole-scope with
// {clear:true} / an empty include_surfaces. Validates the shape minimally.
app.put('/api/v1/projects/:id/servicenow/import-profile', (req, res) => {
  const uid = userId(req);
  const project = db.prepare("SELECT * FROM asdlc_project WHERE project_id=?").get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const result = persistImportProfile(project, req.body || {}, uid);
  if (result.error) return res.status(result.error.status).json({ error: result.error.message });
  res.json(result);
});

// ── Requirements-driven discovery planner ──────────────────────────────────────
// Reads ONE Ingest Document's own not-yet-promoted requirements (pre-Change-Packet) plus
// the target scope's REAL inventory (an existing or, if none exists yet, an automatically-
// run assessment's census + a whole-scope sys_metadata sweep + custom sys_db_object tables,
// each flagged curated-rich vs generic, with a reference-relationship graph read from THIS
// instance's data dictionary) and proposes a focused import slice — which tables to pull and
// why, tied to that document's requirements, plus related/supporting tables. The planner's
// own genuine uncertainty is raised as real discovery: clarifications in that SAME document's
// Q&A (never the project-wide/materialized requirements, never a passive note-only display).
// A human reviews/approves before anything is captured; approving writes the SAME
// import-profile slice the manual grid writes (persistImportProfile, above) — every existing
// path (manual selection, the deterministic recommendation, whole-scope, direct sync) is
// untouched.
app.post('/api/v1/projects/:id/servicenow/discovery-plan', async (req, res) => {
  const uid = userId(req);
  const project = db.prepare("SELECT * FROM asdlc_project WHERE project_id=?").get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const body = req.body || {};
  const ingestId = body.ingest_id;
  if (!ingestId) return res.status(400).json({ error: 'ingest_id is required — the discovery plan is scoped to one Ingest Document.' });
  const doc = db.prepare("SELECT ingest_id, lifecycle_status FROM asdlc_ingest_document WHERE ingest_id=? AND project_id=?").get(ingestId, project.project_id);
  if (!doc) return res.status(404).json({ error: 'Ingest document not found in this project' });
  if (doc.lifecycle_status === 'cancelled') return res.status(409).json({ error: 'This document has been cancelled — restore it first.' });

  const resolved = resolveSyncOpts(project, body);
  if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
  const { scope, instance, user, pw } = resolved.opts;

  const { SN_CATALOG } = require('./agent/sn-catalog');
  const { sweepScopeMetadata, readReferenceGraph } = require('./agent/sn-capture');
  const snAssess = require('./agent/sn-assess');
  const { buildDiscoveryInventory, planDiscovery } = require('./agent/sn-discovery-planner');
  const { loadDocumentRequirements, writeDiscoveryClarification, getNextDiscoveryRound, getAnsweredDiscoveryClarifications } = require('./agent/cross-check');

  // Fail loudly on stale/bad credentials — checked BEFORE the assessment search/auto-run
  // below, so a regular user is never told "run an assessment" when the real problem is
  // their stored credentials (same class of fix as Scan-instance and the sync estimate).
  const connCheck = await snAssess.checkConnection({ instance, user, pw });
  if (!connCheck.ok) return res.status(502).json({ error: connCheck.message });

  // ── Automatic assessment (a regular user is never sent to the Assessment page manually) ──
  // Reuse any existing complete assessment whose OWN report already covers this scope
  // (search history, not just the latest row — a whole-instance scan can cover a scope even
  // with an empty scopes_json); otherwise run one now, scoped to just this one scope
  // (bounded to the same cost a manual "Scan instance" already accepts). No freshness
  // policy — any existing match is reused regardless of age; advanced users can re-scan
  // manually from the Assessment page if they want a fresher one.
  const history = db.prepare(
    "SELECT assessment_id, report_json FROM asdlc_sn_assessment WHERE project_id=? AND status='complete' ORDER BY created_at DESC LIMIT 20"
  ).all(project.project_id);
  let assessmentId = null, report = null;
  for (const row of history) {
    let r; try { r = JSON.parse(row.report_json); } catch { continue; }
    if (r && Array.isArray(r.scope_reports) && r.scope_reports.some(sr => sr.scope === scope)) { assessmentId = row.assessment_id; report = r; break; }
  }
  let assessmentAutoRun = false;
  if (!report) {
    assessmentAutoRun = true;
    const aid = createAssessmentRow({ project, instance, scopes: [scope], uid });
    try { report = await runAssessment(aid, { instance, user, pw, scopes: [scope] }); assessmentId = aid; }
    catch (err) { return res.status(502).json({ error: `Could not survey the ServiceNow app: ${err.message}` }); }
  }

  // Whole-scope, best-effort reads (each degrades gracefully — never breaks planning).
  const sweep = await sweepScopeMetadata({ scope, instance, user, pw, slice: null });
  const curatedTables = new Set(SN_CATALOG.map(c => c.table));
  const customTables = await snAssess.listCustomDataTables({ instance, user, pw, scope, excludeTables: curatedTables });

  const inventoryNoGraph = buildDiscoveryInventory({ report, sweep, customTables, edges: [], scope });
  const refGraph = await readReferenceGraph({ instance, user, pw, tables: inventoryNoGraph.tables.map(t => t.table) });
  const inventory = { ...inventoryNoGraph, edges: refGraph.edges };

  const requirements = loadDocumentRequirements(ingestId);
  const round = getNextDiscoveryRound(ingestId);
  const pastDiscoveryQA = getAnsweredDiscoveryClarifications(ingestId).map(r => ({ question: r.question_text, answer: r.answer_text }));

  const planId = generateId();
  db.prepare(`INSERT INTO asdlc_sn_discovery_plan
      (plan_id, project_id, ingest_id, scope, assessment_id, status, inventory_json, created_by, updated_at)
      VALUES (?,?,?,?,?, 'draft', ?, ?, datetime('now'))`)
    .run(planId, project.project_id, ingestId, scope, assessmentId, JSON.stringify(inventory), uid);

  let result;
  try {
    result = await planDiscovery({ requirements, inventory, scope, pastDiscoveryQA }, { projectId: project.project_id });
  } catch (err) {
    db.prepare("UPDATE asdlc_sn_discovery_plan SET error=?, updated_at=datetime('now') WHERE plan_id=?").run(err.message, planId);
    return res.status(502).json({ error: `Discovery planning failed: ${err.message}` });
  }

  db.prepare(`UPDATE asdlc_sn_discovery_plan SET plan_json=?, model=?, usage_json=?, stub=?, updated_at=datetime('now') WHERE plan_id=?`)
    .run(JSON.stringify(result.plan), result.model || null, result.usage ? JSON.stringify(result.usage) : null, result.stub ? 1 : 0, planId);

  let discoveryClarificationsRaised = 0;
  for (const item of (result.plan.clarifications || [])) {
    if (writeDiscoveryClarification(ingestId, round, item)) discoveryClarificationsRaised++;
  }

  const row = db.prepare('SELECT * FROM asdlc_sn_discovery_plan WHERE plan_id=?').get(planId);
  res.json({
    ...row, plan: result.plan, inventory, _stub: !!result.stub,
    assessment_auto_run: assessmentAutoRun, discovery_clarifications_raised: discoveryClarificationsRaised,
  });
});

// GET the latest discovery plan for one Ingest Document (draft or approved), parsed.
app.get('/api/v1/projects/:id/servicenow/discovery-plan', (req, res) => {
  const ingestId = req.query.ingest_id;
  if (!ingestId) return res.status(400).json({ error: 'ingest_id is required' });
  const row = db.prepare('SELECT * FROM asdlc_sn_discovery_plan WHERE project_id=? AND ingest_id=? ORDER BY created_at DESC LIMIT 1').get(req.params.id, ingestId);
  if (!row) return res.json({ plan: null });
  let plan = null, inventory = null;
  try { plan = row.plan_json ? JSON.parse(row.plan_json) : null; } catch { plan = null; }
  try { inventory = row.inventory_json ? JSON.parse(row.inventory_json) : null; } catch { inventory = null; }
  res.json({ ...row, plan, inventory });
});

// Answer a discovery: clarification WITHOUT triggering the full-document extraction re-run
// that answering a real clarification does — deliberately decoupled so refining the
// ServiceNow plan never forces an unrelated, costly re-extraction. Defense-in-depth: the
// WHERE clause filters to discovery: rows only, so this endpoint can never be used to
// "answer" a conflict:/fyi:/standing: row without its normal (re-extraction/deterministic-
// apply) side effects.
app.post('/api/v1/projects/:id/servicenow/discovery-plan/clarifications/answer', (req, res) => {
  const uid = userId(req);
  const project = db.prepare('SELECT project_id FROM asdlc_project WHERE project_id=?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const body = req.body || {};
  const ingestId = body.ingest_id;
  if (!ingestId) return res.status(400).json({ error: 'ingest_id is required' });
  const doc = db.prepare('SELECT ingest_id FROM asdlc_ingest_document WHERE ingest_id=? AND project_id=?').get(ingestId, project.project_id);
  if (!doc) return res.status(404).json({ error: 'Ingest document not found in this project' });

  const { DISCOVERY_PREFIX } = require('./agent/cross-check');
  const upd = db.prepare(
    `UPDATE asdlc_ingest_clarification SET answer_text=?, answered_at=datetime('now'), answered_by=?
     WHERE clarification_id=? AND ingest_id=? AND target_field LIKE ?`
  );
  let answered = 0;
  for (const [cid, text] of Object.entries(body.answers || {})) {
    if (!text || !String(text).trim()) continue;
    const r = upd.run(String(text).trim(), uid, cid, ingestId, `${DISCOVERY_PREFIX}%`);
    if (r.changes) answered++;
  }
  res.json({ answered });
});

// Approve a draft plan: map its `include[]` to the 5-field import-profile slice and save it
// through the SAME path the manual checkbox grid uses (persistImportProfile) — so a
// planner-approved slice is indistinguishable, downstream, from a human-picked one.
app.post('/api/v1/projects/:id/servicenow/discovery-plan/:planId/approve', (req, res) => {
  const uid = userId(req);
  const project = db.prepare('SELECT * FROM asdlc_project WHERE project_id=?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const row = db.prepare('SELECT * FROM asdlc_sn_discovery_plan WHERE plan_id=? AND project_id=?').get(req.params.planId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Discovery plan not found in this project' });
  let plan = null;
  try { plan = row.plan_json ? JSON.parse(row.plan_json) : null; } catch { plan = null; }
  const include = (plan && Array.isArray(plan.include)) ? plan.include : [];
  if (!include.length) return res.status(400).json({ error: 'This plan has no included tables — nothing to approve.' });

  const body = req.body || {};
  // The body may override the cap; per-table record_filter (if the model proposed one)
  // folds into the record_filters map — the same LIVE, dormant hook sliceQuery reads.
  const record_filters = {};
  for (const item of include) if (item && item.table && item.record_filter) record_filters[item.table] = item.record_filter;
  const result = persistImportProfile(project, {
    scope: row.scope,
    include_surfaces: include.map(i => i.table).filter(Boolean),
    per_surface_cap: body.per_surface_cap,
    record_filters,
  }, uid);
  if (result.error) return res.status(result.error.status).json({ error: result.error.message });

  db.prepare(`UPDATE asdlc_sn_discovery_plan SET status='approved', import_profile_json=?, approved_by=?, approved_at=datetime('now'), updated_at=datetime('now') WHERE plan_id=?`)
    .run(JSON.stringify(result.profile), uid, row.plan_id);
  auditLog('asdlc_sn_discovery_plan', row.plan_id, 'UPDATE', { status: 'draft' }, { status: 'approved' }, uid);

  const updated = db.prepare('SELECT * FROM asdlc_sn_discovery_plan WHERE plan_id=?').get(row.plan_id);
  res.json({ ...updated, plan, profile: result.profile });
});

// ── ServiceNow whole-instance CATALOG (read-only awareness sweep) ─────────────
// Cross-scope, identity-only sweep → collision awareness for the deployer + cross-scope
// net-new for governance. Mirrors the assess 202 async pattern; creds resolve body →
// project → env. Complements deep-capture (one scope, full payloads); never writes.
app.post('/api/v1/projects/:id/servicenow/catalog', (req, res) => {
  const uid = userId(req);
  const project = db.prepare("SELECT * FROM asdlc_project WHERE project_id=?").get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const body = req.body || {};
  const instance = body.instance || project.servicenow_instance || process.env.SN_INSTANCE;
  const user = body.user || project.sn_user || process.env.SN_USER;
  const pw   = body.pw   || decryptField(project.sn_password_enc) || process.env.SN_PASSWORD;
  if (!instance || !user || !pw) {
    return res.status(400).json({ error: 'ServiceNow credentials required (set them on the Application, or SN_INSTANCE/SN_USER/SN_PASSWORD env).' });
  }

  const crid = generateId();
  db.prepare(`
    INSERT INTO asdlc_sn_catalog_run (catalog_run_id, project_id, instance_url, capturing_user, status, created_by, created_at, updated_at)
    VALUES (?,?,?,?,'running',?,datetime('now'),datetime('now'))
  `).run(crid, project.project_id, String(instance).replace(/\/$/, ''), user, uid);
  res.status(202).json({ catalog_run_id: crid, status: 'running' });

  // Fire-and-forget; persist result (or error) back onto the row.
  (async () => {
    try {
      const catalog = await snCatalog.captureInstanceCatalog({ instance, user, pw });
      const summary = snCatalog.summarizeCatalog(catalog);
      db.prepare("UPDATE asdlc_sn_catalog_run SET status='complete', catalog_json=?, summary_json=?, capturing_user=?, updated_at=datetime('now') WHERE catalog_run_id=?")
        .run(JSON.stringify(catalog), JSON.stringify(summary), catalog.capturing_user || user, crid);
    } catch (err) {
      console.error('[sn-catalog] failed:', err.message);
      db.prepare("UPDATE asdlc_sn_catalog_run SET status='failed', error=?, updated_at=datetime('now') WHERE catalog_run_id=?")
        .run(String(err.message).slice(0, 1000), crid);
    }
  })();
});

// Latest catalog run for a project. summary_json always; full catalog_json only on
// ?full=1 (snapshots run ~1-5 MB — never ship them by default).
app.get('/api/v1/projects/:id/servicenow/catalog/latest', (req, res) => {
  const row = db.prepare(`
    SELECT catalog_run_id, project_id, instance_url, capturing_user, status, summary_json, error, created_by, created_at, updated_at
    FROM asdlc_sn_catalog_run WHERE project_id=? ORDER BY created_at DESC LIMIT 1
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'No catalog run for this project' });
  let summary = null;
  try { summary = row.summary_json ? JSON.parse(row.summary_json) : null; } catch { /* leave null */ }
  const out = { ...row, summary };
  delete out.summary_json;
  // Back-fill warnings for runs stored before warnings were added to summary_json.
  if (summary && !summary.warnings) {
    try {
      const catRow = db.prepare("SELECT catalog_json FROM asdlc_sn_catalog_run WHERE catalog_run_id=?").get(row.catalog_run_id);
      if (catRow && catRow.catalog_json) {
        const warnMatch = catRow.catalog_json.match(/"warnings"\s*:\s*(\[[^\]]*\])/);
        summary.warnings = warnMatch ? JSON.parse(warnMatch[1]) : [];
      }
    } catch { summary.warnings = []; }
  }
  if (req.query.full === '1') {
    const full = db.prepare("SELECT catalog_json FROM asdlc_sn_catalog_run WHERE catalog_run_id=?").get(row.catalog_run_id);
    try { out.catalog = full && full.catalog_json ? JSON.parse(full.catalog_json) : null; } catch { out.catalog = null; }
  }
  res.json(out);
});

// Existence-drift governance view from the latest COMPLETE catalog: vanished (advisory),
// moved (scope changed), untracked (net-new on the instance → inbound HITL candidates).
app.get('/api/v1/projects/:id/servicenow/catalog/drift', (req, res) => {
  const project = db.prepare("SELECT project_id, servicenow_scope FROM asdlc_project WHERE project_id=?").get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const row = db.prepare(
    "SELECT catalog_run_id, catalog_json, capturing_user FROM asdlc_sn_catalog_run WHERE project_id=? AND status='complete' ORDER BY created_at DESC LIMIT 1"
  ).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'No completed catalog run — run a catalog sweep first.' });
  let catalog = null;
  try { catalog = JSON.parse(row.catalog_json); } catch { /* unreadable */ }
  if (!catalog) return res.status(500).json({ error: 'Catalog snapshot is unreadable.' });
  const drift = snCatalog.detectExistenceDrift(project.project_id, catalog, { projectScope: project.servicenow_scope });
  res.json({
    catalog_run_id: row.catalog_run_id, captured_at: catalog.captured_at, capturing_user: row.capturing_user,
    caveat: 'Catalog reflects only what the capturing account can read (ServiceNow ACL-filters rows silently). "vanished" is advisory — never a delete.',
    ...drift,
  });
});

// ── ServiceNow round-trip: sync apply-mode (system setting) ──────────────────
// Governs how freely SAFE (additive / fill-blank / non-shrinking) sync changes apply.
// The non-destructive guard is a hard floor under ALL modes — destructive/shrinking
// changes never auto-apply regardless of mode (consumed by the gate in a later phase).
const SN_SYNC_APPLY_MODES = ['additive_hitl', 'confidence_gate', 'review_all'];
app.get('/api/v1/settings/sn-sync-apply-mode', (req, res) => {
  res.json({ mode: getSetting('sn_sync_apply_mode', 'additive_hitl'), modes: SN_SYNC_APPLY_MODES });
});
app.put('/api/v1/settings/sn-sync-apply-mode', (req, res) => {
  const mode = req.body && req.body.mode;
  if (!SN_SYNC_APPLY_MODES.includes(mode)) {
    return res.status(400).json({ error: `mode must be one of: ${SN_SYNC_APPLY_MODES.join(', ')}` });
  }
  setSetting('sn_sync_apply_mode', mode, userId(req));
  res.json({ mode });
});

app.put('/api/v1/projects/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM asdlc_project WHERE project_id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Project not found' });
  const uid = userId(req);
  const { project_name, project_code, stage, lifecycle_status, confidence_threshold, ripple_scan_scope, target_platform } = req.body;
  // Guard the scope enum so the cross-check only ever sees a known value.
  const scope = (ripple_scan_scope === 'project' || ripple_scan_scope === 'workflow') ? ripple_scan_scope : null;
  const tplat = ['servicenow', 'generic'].includes(target_platform) ? target_platform : null;
  db.prepare(`
    UPDATE asdlc_project
    SET project_name         = COALESCE(?, project_name),
        project_code         = COALESCE(?, project_code),
        stage                = COALESCE(?, stage),
        lifecycle_status     = COALESCE(?, lifecycle_status),
        confidence_threshold = COALESCE(?, confidence_threshold),
        ripple_scan_scope    = COALESCE(?, ripple_scan_scope),
        target_platform      = COALESCE(?, target_platform),
        updated_by           = ?,
        updated_at           = datetime('now'),
        version              = version + 1
    WHERE project_id = ?
  `).run(project_name ?? null, project_code ?? null, stage ?? null, lifecycle_status ?? null,
         confidence_threshold != null ? Number(confidence_threshold) : null,
         scope, tplat,
         uid, req.params.id);
  const updated = db.prepare('SELECT * FROM asdlc_project WHERE project_id = ?').get(req.params.id);
  auditLog('asdlc_project', req.params.id, 'UPDATE', existing, updated, uid);
  res.json(scrubProject(updated));
});

// ──────────────────────────────────────────────
// PROJECT MEMBERS
// ──────────────────────────────────────────────
app.get('/api/v1/projects/:id/members', (req, res) => {
  const rows = db.prepare(`
    SELECT pm.*, u.email
    FROM asdlc_project_member pm
    LEFT JOIN asdlc_user u ON u.user_id = pm.user_id
    WHERE pm.project_id = ? AND pm.active = 1
  `).all(req.params.id);
  res.json(rows);
});

app.post('/api/v1/projects/:id/members', (req, res) => {
  const { user_id: uid_param, display_name, member_role, can_approve, hitl_role } = req.body;
  if (!uid_param || !display_name) {
    return res.status(400).json({ error: 'user_id and display_name are required' });
  }
  const id = generateId();
  const uid = userId(req);
  db.prepare(`
    INSERT INTO asdlc_project_member
      (project_member_id, project_id, user_id, display_name, member_role, can_approve, hitl_role)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.params.id, uid_param, display_name, member_role || 'other', can_approve ? 1 : 0, hitl_role || null);
  const created = db.prepare('SELECT * FROM asdlc_project_member WHERE project_member_id = ?').get(id);
  auditLog('asdlc_project_member', id, 'INSERT', null, created, uid);
  res.status(201).json(created);
});

app.delete('/api/v1/projects/:id/members/:memberId', (req, res) => {
  const existing = db.prepare(
    'SELECT * FROM asdlc_project_member WHERE project_member_id = ? AND project_id = ?'
  ).get(req.params.memberId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Member not found' });
  const uid = userId(req);
  db.prepare(
    "UPDATE asdlc_project_member SET active = 0, updated_at = datetime('now') WHERE project_member_id = ?"
  ).run(req.params.memberId);
  auditLog('asdlc_project_member', req.params.memberId, 'UPDATE', existing, { ...existing, active: 0 }, uid);
  res.json({ success: true });
});

// ──────────────────────────────────────────────
// AGENT SETTINGS
// ──────────────────────────────────────────────
app.get('/api/v1/projects/:id/agent-settings', (req, res) => {
  const rows = db.prepare(`
    SELECT pas.*, ac.agent_type, ac.agent_name, ac.purpose
    FROM asdlc_project_agent_setting pas
    JOIN asdlc_agent_catalog ac ON ac.workbench_agent_id = pas.workbench_agent_id
    WHERE pas.project_id = ?
    ORDER BY ac.agent_name
  `).all(req.params.id);
  res.json(rows);
});

app.put('/api/v1/projects/:id/agent-settings/:settingId', (req, res) => {
  const existing = db.prepare(
    'SELECT * FROM asdlc_project_agent_setting WHERE project_agent_setting_id = ? AND project_id = ?'
  ).get(req.params.settingId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Setting not found' });
  const uid = userId(req);
  const { trust_level, enabled, allowed_actions, requires_human_approval, notes } = req.body;
  const toBool = (v) => v === undefined ? null : (v ? 1 : 0);
  db.prepare(`
    UPDATE asdlc_project_agent_setting
    SET trust_level             = COALESCE(?, trust_level),
        enabled                 = COALESCE(?, enabled),
        allowed_actions         = COALESCE(?, allowed_actions),
        requires_human_approval = COALESCE(?, requires_human_approval),
        notes                   = COALESCE(?, notes),
        updated_at              = datetime('now')
    WHERE project_agent_setting_id = ?
  `).run(
    trust_level ?? null,
    toBool(enabled),
    allowed_actions ?? null,
    toBool(requires_human_approval),
    notes ?? null,
    req.params.settingId
  );
  const updated = db.prepare('SELECT * FROM asdlc_project_agent_setting WHERE project_agent_setting_id = ?').get(req.params.settingId);
  auditLog('asdlc_project_agent_setting', req.params.settingId, 'UPDATE', existing, updated, uid);
  res.json(updated);
});

// ──────────────────────────────────────────────
// CHANGE PACKETS
// ──────────────────────────────────────────────
app.get('/api/v1/change-packets', (req, res) => {
  const { project_id, status, risk_level, conflict_classification } = req.query;
  let sql = `
    SELECT cp.*, p.project_code, es.source_title
    FROM asdlc_change_packet cp
    LEFT JOIN asdlc_project p ON p.project_id = cp.project_id
    LEFT JOIN asdlc_evidence_source es ON es.evidence_source_id = cp.source_evidence_id
    WHERE cp.lifecycle_status = 'active'
  `;
  const params = [];
  if (project_id)             { sql += ' AND cp.project_id = ?';              params.push(project_id); }
  if (status)                 { sql += ' AND cp.status = ?';                  params.push(status); }
  if (risk_level)             { sql += ' AND cp.risk_level = ?';              params.push(risk_level); }
  if (conflict_classification){ sql += ' AND cp.conflict_classification = ?'; params.push(conflict_classification); }
  sql += ' ORDER BY cp.updated_at DESC';
  res.json(db.prepare(sql).all(...params));
});

app.get('/api/v1/change-packets/:id', (req, res) => {
  const cp = db.prepare(`
    SELECT cp.*, p.project_code, es.source_title
    FROM asdlc_change_packet cp
    LEFT JOIN asdlc_project p ON p.project_id = cp.project_id
    LEFT JOIN asdlc_evidence_source es ON es.evidence_source_id = cp.source_evidence_id
    WHERE cp.change_packet_id = ?
  `).get(req.params.id);
  if (!cp) return res.status(404).json({ error: 'Change packet not found' });
  const items = db.prepare(
    'SELECT * FROM asdlc_change_packet_item WHERE change_packet_id = ? ORDER BY created_at'
  ).all(req.params.id);
  res.json({ ...cp, items });
});

app.post('/api/v1/change-packets', (req, res) => {
  const { project_id, packet_code, summary, source_evidence_id, risk_level, conflict_classification, baseline_impacting } = req.body;
  if (!project_id || !packet_code || !summary) {
    return res.status(400).json({ error: 'project_id, packet_code and summary are required' });
  }
  const id = generateId();
  const uid = userId(req);
  db.prepare(`
    INSERT INTO asdlc_change_packet
      (change_packet_id, project_id, packet_code, summary, source_evidence_id,
       risk_level, conflict_classification, baseline_impacting, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, project_id, packet_code, summary,
    source_evidence_id || null,
    risk_level || 'med',
    conflict_classification || 'net_new',
    baseline_impacting ? 1 : 0,
    uid, uid
  );
  const created = db.prepare('SELECT * FROM asdlc_change_packet WHERE change_packet_id = ?').get(id);
  auditLog('asdlc_change_packet', id, 'INSERT', null, created, uid);
  res.status(201).json(created);
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-item decisions: approve or reject a single CP item individually.
// Approve = apply just this item to the design tables immediately.
// Reject  = mark item as skipped (the CP-level approve will not re-apply it).
// Both are audit-logged. When ALL items in a CP have been individually decided
// the CP auto-closes (approved if ≥1 item applied; rejected if all rejected).
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/v1/change-packet-items/:itemId/approve', (req, res) => {
  const uid = userId(req);
  const item = db.prepare('SELECT * FROM asdlc_change_packet_item WHERE change_packet_item_id = ?').get(req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Change packet item not found' });

  const cp = db.prepare('SELECT * FROM asdlc_change_packet WHERE change_packet_id = ?').get(item.change_packet_id);
  if (!cp) return res.status(404).json({ error: 'Change packet not found' });
  if (!['pending_review', 'in_review'].includes(cp.status)) {
    return res.status(409).json({ error: `Cannot approve item — CP is '${cp.status}'` });
  }
  if (item.item_status === 'approved' || item.applied_at) {
    return res.status(409).json({ error: 'Item has already been approved/applied' });
  }
  if (item.item_status === 'rejected') {
    return res.status(409).json({ error: 'Item is rejected — restore it before approving' });
  }

  // Optional custom resolution: a reviewer-supplied { dataKey: value } map that overrides the
  // AI's proposed values before applying. This is how a human "enters a way to handle it" — the
  // chosen values are merged into the item, written to the design, and persisted so future Build
  // Spec exports reflect the human decision. Unknown keys (not on the entity) are ignored.
  const overrides = (req.body && req.body.field_overrides && typeof req.body.field_overrides === 'object' && !Array.isArray(req.body.field_overrides))
    ? req.body.field_overrides : null;

  let applyResult;
  const itemBefore = { ...item };

  db.exec('BEGIN');
  try {
    let forceKeys = null;
    if (overrides) {
      const entity = registry.byEntityType[item.entity_type];
      const validKeys = entity && entity.fieldMap ? new Set(Object.keys(entity.fieldMap)) : null;
      let data; try { data = JSON.parse(item.new_value); } catch { data = {}; }
      const appliedKeys = [];
      for (const [k, v] of Object.entries(overrides)) {
        if (validKeys && !validKeys.has(k)) continue;           // ignore fields not on this entity
        data[k] = v;
        if (data._sn_proposed) delete data._sn_proposed[k];      // this conflict field is now resolved
        appliedKeys.push(k);
      }
      if (data._sn_proposed && !Object.keys(data._sn_proposed).length) delete data._sn_proposed;
      if (appliedKeys.length) {
        const mergedJson = JSON.stringify(data);
        db.prepare("UPDATE asdlc_change_packet_item SET new_value=?, item_decision_notes=? WHERE change_packet_item_id=?")
          .run(mergedJson, `Custom resolution — reviewer set: ${appliedKeys.join(', ')}`, item.change_packet_item_id);
        item.new_value = mergedJson;                             // applyOneItem reads from this object
        forceKeys = new Set(appliedKeys);
      }
    }

    // Apply this single item to the design tables
    applyResult = applyOneItem(item, cp, uid, forceKeys);

    // Mark item as individually approved
    db.prepare(`
      UPDATE asdlc_change_packet_item
      SET item_status='approved', item_decided_by=?, item_decided_at=datetime('now'), updated_at=datetime('now')
      WHERE change_packet_item_id=?
    `).run(uid || 'reviewer', item.change_packet_item_id);

    // Auto-close CP if ALL items in the CP are now decided
    const allItems = db.prepare(
      'SELECT item_status FROM asdlc_change_packet_item WHERE change_packet_id = ?'
    ).all(cp.change_packet_id);
    const allDecided = allItems.every(i => i.item_status && i.item_status !== 'pending');
    const anyApproved = allItems.some(i => i.item_status === 'approved');
    let cpNewStatus = cp.status;

    if (allDecided) {
      cpNewStatus = anyApproved ? 'approved' : 'rejected';
      db.prepare(`
        UPDATE asdlc_change_packet
        SET status=?,
            approval_timestamp=CASE WHEN ? = 'approved' THEN datetime('now') ELSE approval_timestamp END,
            updated_by=?, updated_at=datetime('now'), version=version+1
        WHERE change_packet_id=?
      `).run(cpNewStatus, cpNewStatus, uid, cp.change_packet_id);

      if (cpNewStatus === 'approved' && cp.project_id) {
        db.prepare(
          "UPDATE asdlc_project SET version=version+1, updated_at=datetime('now'), updated_by=? WHERE project_id=?"
        ).run(uid, cp.project_id);
      }
    }

    db.exec('COMMIT');

    const itemAfter = db.prepare('SELECT * FROM asdlc_change_packet_item WHERE change_packet_item_id = ?').get(item.change_packet_item_id);
    auditLog('asdlc_change_packet_item', item.change_packet_item_id, 'APPROVE_ITEM', itemBefore, itemAfter, uid);
    if (allDecided) {
      const cpAfter = db.prepare('SELECT * FROM asdlc_change_packet WHERE change_packet_id = ?').get(cp.change_packet_id);
      auditLog('asdlc_change_packet', cp.change_packet_id, 'UPDATE', cp, cpAfter, uid);
    }

    // Fire-and-forget test generation for newly-created testable entities
    const toGenerate = applyResult.createdTestable || [];
    if (toGenerate.length) {
      Promise.allSettled(
        toGenerate.map(e => generateAndInsertTests(cp.project_id, e.scope, e.entityId, uid))
      ).catch(e => console.error('[item-approve test-gen]', e.message));
    }
    // Auto-draft a starting prompt for any newly-created agent that arrived without one.
    const newAgents = toGenerate.filter(e => e.scope === 'agent_spec');
    if (newAgents.length) {
      Promise.allSettled(
        newAgents.map(e => autoDraftAgentPromptIfEmpty(cp.project_id, e.entityId, uid))
      ).catch(e => console.error('[item-approve prompt-draft]', e.message));
    }

    const itemFinal = db.prepare('SELECT * FROM asdlc_change_packet_item WHERE change_packet_item_id = ?').get(item.change_packet_item_id);
    res.json({ item: itemFinal, apply_result: applyResult, cp_status: cpNewStatus });
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('[item-approve]', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/v1/change-packet-items/:itemId/reject', (req, res) => {
  const uid = userId(req);
  const { decision_notes } = req.body || {};
  const item = db.prepare('SELECT * FROM asdlc_change_packet_item WHERE change_packet_item_id = ?').get(req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Change packet item not found' });

  const cp = db.prepare('SELECT * FROM asdlc_change_packet WHERE change_packet_id = ?').get(item.change_packet_id);
  if (!cp) return res.status(404).json({ error: 'Change packet not found' });
  if (!['pending_review', 'in_review'].includes(cp.status)) {
    return res.status(409).json({ error: `Cannot reject item — CP is '${cp.status}'` });
  }
  if (item.applied_at) {
    return res.status(409).json({ error: 'Item has already been applied and cannot be rejected' });
  }

  const itemBefore = { ...item };

  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE asdlc_change_packet_item
      SET item_status='rejected',
          item_decision_notes=COALESCE(?, item_decision_notes),
          item_decided_by=?, item_decided_at=datetime('now'), updated_at=datetime('now')
      WHERE change_packet_item_id=?
    `).run(decision_notes || null, uid || 'reviewer', item.change_packet_item_id);

    // Auto-close CP if ALL items now decided
    const allItems = db.prepare(
      'SELECT item_status FROM asdlc_change_packet_item WHERE change_packet_id = ?'
    ).all(cp.change_packet_id);
    const allDecided = allItems.every(i => i.item_status && i.item_status !== 'pending');
    const anyApproved = allItems.some(i => i.item_status === 'approved');
    let cpNewStatus = cp.status;

    if (allDecided) {
      cpNewStatus = anyApproved ? 'approved' : 'rejected';
      db.prepare(`
        UPDATE asdlc_change_packet
        SET status=?,
            approval_timestamp=CASE WHEN ? = 'approved' THEN datetime('now') ELSE approval_timestamp END,
            updated_by=?, updated_at=datetime('now'), version=version+1
        WHERE change_packet_id=?
      `).run(cpNewStatus, cpNewStatus, uid, cp.change_packet_id);
    }

    db.exec('COMMIT');

    const itemAfter = db.prepare('SELECT * FROM asdlc_change_packet_item WHERE change_packet_item_id = ?').get(item.change_packet_item_id);
    auditLog('asdlc_change_packet_item', item.change_packet_item_id, 'REJECT_ITEM', itemBefore, itemAfter, uid);
    if (allDecided) {
      const cpAfter = db.prepare('SELECT * FROM asdlc_change_packet WHERE change_packet_id = ?').get(cp.change_packet_id);
      auditLog('asdlc_change_packet', cp.change_packet_id, 'UPDATE', cp, cpAfter, uid);
    }

    const itemFinal = db.prepare('SELECT * FROM asdlc_change_packet_item WHERE change_packet_item_id = ?').get(item.change_packet_item_id);
    res.json({ item: itemFinal, cp_status: cpNewStatus });
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('[item-reject]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Approve a change packet and materialize it — the shared core used by BOTH the
 * /change-packets/:id/approve HTTP handler and the ServiceNow sync engine's
 * auto-apply path. Wraps the status flip + applyChangePacket() + project version
 * bump in ONE transaction (rolled back atomically on any error), then runs the
 * post-commit side effects (audit, learning feedback, post-apply consistency check,
 * fire-and-forget test generation). Returns the same pieces the HTTP handler needs.
 * Throws on apply failure (caller maps to a 500 / surfaces the error).
 */
function approveAndApplyCp(cpId, uid, opts = {}) {
  const existing = db.prepare('SELECT * FROM asdlc_change_packet WHERE change_packet_id = ?').get(cpId);
  let applyResult;
  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE asdlc_change_packet
      SET status='approved', approver_member_id=COALESCE(?,approver_member_id),
          decision_notes=COALESCE(?,decision_notes), approval_timestamp=datetime('now'),
          updated_by=?, updated_at=datetime('now'), version=version+1
      WHERE change_packet_id=?
    `).run(opts.approver_member_id || null, opts.decision_notes || null, uid, cpId);

    // Materialize the packet into the real design tables (the missing pipeline)
    applyResult = applyChangePacket(cpId, uid);

    // Increment the project version so design history tracks the release
    if (existing.project_id) {
      const projBefore = db.prepare('SELECT * FROM asdlc_project WHERE project_id = ?').get(existing.project_id);
      db.prepare("UPDATE asdlc_project SET version=version+1, updated_at=datetime('now'), updated_by=? WHERE project_id=?")
        .run(uid, existing.project_id);
      const projAfter = db.prepare('SELECT * FROM asdlc_project WHERE project_id = ?').get(existing.project_id);
      auditLog('asdlc_project', existing.project_id, 'UPDATE', projBefore, projAfter, uid);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const updated = db.prepare('SELECT * FROM asdlc_change_packet WHERE change_packet_id = ?').get(cpId);
  auditLog('asdlc_change_packet', cpId, 'UPDATE', existing, updated, uid);
  try { recordFeedbackForCp(updated, 'accepted_asis', uid); } catch (e) { console.error('[feedback]', e.message); }

  // Plan D — post-apply consistency check (deterministic, cheap).
  let postApply = null;
  try { postApply = require('./agent/cross-check').runPostApplyCheck(cpId); }
  catch (e) { console.error('[post-apply]', e.message); }

  // Auto-generate test coverage for newly-materialized testable entities — fire-and-forget
  // AFTER commit (Claude calls must not run inside the txn).
  const toGenerate = (applyResult && applyResult.createdTestable) || [];
  if (toGenerate.length) {
    Promise.allSettled(toGenerate.map(e => generateAndInsertTests(existing.project_id, e.scope, e.entityId, uid)))
      .then(rs => {
        const n = rs.reduce((a, r) => a + (r.status === 'fulfilled' ? (r.value.created || 0) : 0), 0);
        if (n) console.log(`[test-gen] materialize: generated ${n} test case(s) across ${toGenerate.length} entit(ies) for CP ${updated.packet_code}`);
      });
  }
  // Auto-draft starting prompts for newly-materialized agents that arrived without one.
  const newAgents = toGenerate.filter(e => e.scope === 'agent_spec');
  if (newAgents.length) {
    Promise.allSettled(newAgents.map(e => autoDraftAgentPromptIfEmpty(existing.project_id, e.entityId, uid)))
      .then(rs => {
        const n = rs.reduce((a, r) => a + (r.status === 'fulfilled' && r.value.drafted ? 1 : 0), 0);
        if (n) console.log(`[prompt-draft] materialize: drafted ${n} agent prompt(s) for CP ${updated.packet_code}`);
      });
  }

  // AI RASIC inference for touched workflows — fire-and-forget AFTER commit.
  // Runs after deriveSwimlane (participants + owner_participant_id already set).
  // Skips any workflow that already has RASIC rows (preserves manual edits).
  const touchedWfs = applyResult && applyResult.touchedWorkflows
    ? [...applyResult.touchedWorkflows]
    : [];
  if (touchedWfs.length && existing.project_id) {
    const { inferRasicMatrix } = require('./agent/rasic-deriver');
    Promise.allSettled(
      touchedWfs.map(wfId =>
        inferRasicMatrix(wfId, existing.project_id, uid).then(r => {
          if (!r.skipped && r.cellsCreated > 0)
            console.log(`[rasic-deriver] apply: ${r.cellsCreated} cell(s) inferred for workflow ${wfId}`);
        })
      )
    ).catch(() => {});
  }

  return { existing, updated, applyResult, postApply };
}

// Helper for approve/reject/send-back status transitions
function transitionCp(req, res, newStatus) {
  const existing = db.prepare('SELECT * FROM asdlc_change_packet WHERE change_packet_id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Change packet not found' });
  const uid = userId(req);
  const { approver_member_id, decision_notes } = req.body || {};

  // ── Approval: status change + materialization + version bump, atomically ───
  if (newStatus === 'approved') {
    if (existing.status === 'approved') {
      return res.json({ ...existing, apply_result: { applied: 0, updated: 0, deleted: 0, skipped: 0, errors: [], note: 'already approved' } });
    }
    let r;
    try { r = approveAndApplyCp(req.params.id, uid, { approver_member_id, decision_notes }); }
    catch (err) {
      console.error('[transitionCp] apply failed — rolled back:', err.message);
      return res.status(500).json({ error: `Failed to apply change packet: ${err.message}` });
    }
    const { updated, applyResult, postApply } = r;
    return res.json({
      ...updated,
      post_apply_status:   postApply ? postApply.status : updated.post_apply_status,
      post_apply_findings: postApply ? JSON.stringify(postApply.findings) : updated.post_apply_findings,
      apply_result: applyResult,
      post_apply: postApply,
    });
  }

  // ── Reject / send-back: simple status update ───────────────────────────────
  db.prepare(`
    UPDATE asdlc_change_packet
    SET status=?, approver_member_id=COALESCE(?,approver_member_id),
        decision_notes=COALESCE(?,decision_notes), approval_timestamp=datetime('now'),
        updated_by=?, updated_at=datetime('now'), version=version+1
    WHERE change_packet_id=?
  `).run(newStatus, approver_member_id || null, decision_notes || null, uid, req.params.id);
  const updated = db.prepare('SELECT * FROM asdlc_change_packet WHERE change_packet_id = ?').get(req.params.id);
  auditLog('asdlc_change_packet', req.params.id, 'UPDATE', existing, updated, uid);
  if (newStatus === 'rejected') {
    try { recordFeedbackForCp(updated, 'rejected', uid); } catch (e) { console.error('[feedback]', e.message); }
  }
  res.json(updated);
}

// ─────────────────────────────────────────────────────────────────────────────
// CHANGE PACKET MATERIALIZER  (registry-driven)
// Applies an approved packet's items to the real design tables. Called from
// transitionCp inside a transaction. SoftSkip = a business-rule skip (recorded,
// commit continues); any other throw rolls the whole packet back.
// ─────────────────────────────────────────────────────────────────────────────
class SoftSkip extends Error {}

/** Generate a unique, human-readable change-packet code (collision-safe). */
function uniquePacketCode() {
  for (let i = 0; i < 25; i++) {
    const base = `CP-${now().replace(/\D/g, '').slice(4, 14)}`;   // MMDDHHMMSS
    const code = i === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 5)}`;
    if (!db.prepare('SELECT 1 FROM asdlc_change_packet WHERE packet_code = ?').get(code)) return code;
  }
  return `CP-${generateId().slice(0, 8)}`;
}

function mtRow(table, pk, id) {
  return db.prepare(`SELECT * FROM ${table} WHERE ${pk} = ?`).get(id);
}

/** Resolve a per-project slug to its real entity id (null if not found). */
function resolveSlugToId(entity, projectId, slug) {
  if (!slug || !entity || !entity.slugPrefix) return null;
  const row = db.prepare(
    `SELECT ${entity.pk} AS id FROM ${entity.table} WHERE slug = ? AND project_id = ?`
  ).get(slug, projectId);
  return row ? row.id : null;
}

/** Map entity_data → { column: value } using the registry fieldMap. */
function mapFields(entity, data) {
  const out = {};
  for (const [key, spec] of Object.entries(entity.fieldMap || {})) {
    let v = data[key];
    if (v === undefined || v === null) continue;
    if (spec.enumMap && spec.enumMap[v] !== undefined) v = spec.enumMap[v];
    if (spec.transform) v = spec.transform(v);
    else if (spec.json)  v = JSON.stringify(v);
    out[spec.col] = v;
  }
  return out;
}

// ── ServiceNow round-trip: non-destructive sync guard ────────────────────────
// Level-2 provenance columns are identity, not content — always allowed to update.
const SN_PROVENANCE_COLS = new Set(['source_system','source_sys_id','source_table','source_scope','source_fluent','source_hash']);
// True if writing `incoming` over `current` would blank or shrink a populated field.
// Used to protect richer Workbench content from a lossy ServiceNow sync. JSON columns
// are compared by serialized length as a proxy for "fewer/less-detailed entries".
function snWouldShrink(current, incoming) {
  const cur = current == null ? '' : String(current);
  const inc = incoming == null ? '' : String(incoming);
  if (cur.trim() === '') return false;   // nothing populated to protect
  if (inc.trim() === '') return true;    // would blank a populated field
  return inc.length < cur.length;        // would shrink (lose detail)
}

/** Resolve a child entity's parent FK columns to real ids (same-packet → DB → fallback). */
/** Resolve one parent link's name value → parent id: same-packet idMap first, then an
 *  active existing row by name. Returns null when unresolvable (no fallback). */
function lookupParentId(link, nameVal, projectId, idMap) {
  if (!nameVal) return null;
  let parentId = (idMap && idMap[`${link.parentType}::${nameVal}`]) || null;
  if (!parentId) {
    const pe = registry.byEntityType[link.parentType];
    const pNameKey = pe && pe.nameKeys && pe.nameKeys[0];
    const pNameCol = pe && pNameKey && pe.fieldMap[pNameKey] ? pe.fieldMap[pNameKey].col : null;
    if (pe && pNameCol) {
      const row = db.prepare(
        `SELECT ${pe.pk} AS id FROM ${pe.table}
         WHERE project_id = ? AND ${pNameCol} = ?
           AND (lifecycle_status IS NULL OR lifecycle_status != 'retired')
         ORDER BY created_at LIMIT 1`
      ).get(projectId, nameVal);
      if (row) parentId = row.id;
    }
  }
  return parentId;
}

function resolveParents(entity, data, projectId, idMap) {
  const fks = {};
  for (const link of (entity.parentLinks || [])) {
    const nameVal = data[link.nameKeyInData];
    let parentId = lookupParentId(link, nameVal, projectId, idMap);
    if (!parentId && link.required) parentId = fallbackParent(link.parentType, projectId, idMap);
    if (!parentId && link.required) {
      throw new SoftSkip(`${entity.entity_type}: could not resolve required parent ${link.parentType} (${link.nameKeyInData}="${nameVal || ''}")`);
    }
    // tryFallback: optional link that still benefits from unambiguous auto-assignment
    // (e.g. FR/NFR when AI omits use_case_title but there is only one UC in the packet/DB)
    if (!parentId && !link.required && link.tryFallback) parentId = fallbackParent(link.parentType, projectId, idMap) || null;
    if (parentId) fks[link.col] = parentId;
  }
  return fks;
}

/** Last-resort parent: the single one created in this packet, else the single existing one. */
function fallbackParent(parentType, projectId, idMap) {
  const inPacket = Object.entries(idMap)
    .filter(([k]) => k.startsWith(parentType + '::'))
    .map(([, v]) => v);
  if (inPacket.length === 1) return inPacket[0];
  const pe = registry.byEntityType[parentType];
  if (pe) {
    const rows = db.prepare(
      `SELECT ${pe.pk} AS id FROM ${pe.table}
       WHERE project_id = ? AND (lifecycle_status IS NULL OR lifecycle_status != 'retired')`
    ).all(projectId);
    if (rows.length === 1) return rows[0].id;
  }
  if (inPacket.length > 1) return inPacket[inPacket.length - 1];
  return null;
}

function mtCreate(entity, data, projectId, uid, idMap, item) {
  const fks = resolveParents(entity, data, projectId, idMap);
  const id  = generateId();
  const cols = [entity.pk, 'project_id'];
  const vals = [id, projectId];

  if (entity.slugPrefix) { cols.push('slug'); vals.push(nextSlug(entity.table, entity.slugPrefix, projectId)); }
  for (const [c, v] of Object.entries(fks)) { cols.push(c); vals.push(v); }

  const mapped = mapFields(entity, data);
  if (entity.entity_type === 'workflow_step' && (mapped.step_number === undefined || mapped.step_number === null)) {
    const r = db.prepare("SELECT COALESCE(MAX(step_number),0)+1 AS n FROM asdlc_workflow_step WHERE workflow_id = ?").get(fks.workflow_id);
    mapped.step_number = r ? r.n : 1;
  }
  for (const [c, v] of Object.entries(mapped)) { cols.push(c); vals.push(v); }

  // staticColumns: registry-declared columns that always get the same value (e.g. parent_type, source).
  for (const [c, v] of Object.entries(entity.staticColumns || {})) {
    if (!cols.includes(c)) { cols.push(c); vals.push(v); }
  }

  // scopeResolution: test_case needs scope_entity_id resolved from scope + scope_entity_name
  // because the parent table varies by scope value (use_case/workflow/agent/tool).
  if (entity.scopeResolution && data.scope && data.scope_entity_name) {
    const SCOPE_MAP = {
      use_case: { table: 'asdlc_use_case',   pk: 'use_case_id',   nameCol: 'title' },
      workflow:  { table: 'asdlc_workflow',   pk: 'workflow_id',   nameCol: 'name'  },
      agent:     { table: 'asdlc_agent_spec', pk: 'agent_spec_id', nameCol: 'name'  },
      tool:      { table: 'asdlc_tool',       pk: 'tool_id',       nameCol: 'name'  },
    };
    const st = SCOPE_MAP[data.scope];
    if (st && !cols.includes('scope_entity_id')) {
      // Try DB first, then same-packet idMap
      const dbRow = db.prepare(
        `SELECT ${st.pk} AS id FROM ${st.table}
         WHERE project_id=? AND ${st.nameCol}=?
           AND (lifecycle_status IS NULL OR lifecycle_status!='retired')
         LIMIT 1`
      ).get(projectId, data.scope_entity_name);
      const resolvedId = (dbRow && dbRow.id) ||
        idMap[`${data.scope}::${data.scope_entity_name}`] || null;
      if (resolvedId) { cols.push('scope_entity_id'); vals.push(resolvedId); }
      else throw new SoftSkip(
        `test_case: cannot resolve scope_entity_id for ${data.scope} "${data.scope_entity_name}" — ` +
        `ensure the parent entity exists or is being created in the same Change Packet`
      );
    }
  }

  cols.push('created_by', 'updated_by'); vals.push(uid, uid);

  db.prepare(`INSERT INTO ${entity.table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
  auditLog(entity.table, id, 'INSERT', null, mtRow(entity.table, entity.pk, id), uid);

  const nm = registry.entityName(entity.entity_type, data);
  if (nm) idMap[`${entity.entity_type}::${nm}`] = id;
  // CP item entity_id was an extraction placeholder for creates — point it at the real row
  db.prepare("UPDATE asdlc_change_packet_item SET entity_id = ? WHERE change_packet_item_id = ?").run(id, item.change_packet_item_id);
  return id;
}

function mtUpdate(entity, data, item, uid, forceCols, projectId, idMap) {
  const id = item.entity_id;
  const before = mtRow(entity.table, entity.pk, id);
  if (!before) throw new SoftSkip(`${entity.entity_type}: update target ${id} no longer exists`);
  const mapped = mapFields(entity, data);
  // Non-destructive guard (ServiceNow-sourced syncs only): never overwrite a populated
  // Workbench field with an empty or strictly-smaller value. Protected fields are kept
  // and reported. Provenance columns always update. Hard floor under ALL apply-modes.
  // EXCEPTION: columns in `forceCols` are explicit human resolutions (a reviewer typed the
  // value during ratification) and always apply, even if shorter than the current value.
  const protectedCols = [];
  if (data && data.source_sys_id) {
    for (const col of Object.keys(mapped)) {
      if (SN_PROVENANCE_COLS.has(col)) continue;
      if (forceCols && forceCols.has(col)) continue;
      if (snWouldShrink(before[col], mapped[col])) { delete mapped[col]; protectedCols.push(col); }
    }
  }
  // Re-parenting on update: mapFields only maps fieldMap columns, so a changed parent
  // reference (e.g. agent_spec.workflow_name → workflow_id) would otherwise be silently
  // dropped — the FK keeps pointing at the old parent, which then blocks that parent's
  // deletion in a merge. Re-resolve each parent link the update actually supplies a name
  // for, and apply the resolved FK when it genuinely differs. Only runs when the caller
  // provides resolution context (CP apply passes projectId + idMap); never nulls an FK.
  if (projectId) {
    for (const link of (entity.parentLinks || [])) {
      if (!Object.prototype.hasOwnProperty.call(data, link.nameKeyInData)) continue;
      const newFk = lookupParentId(link, data[link.nameKeyInData], projectId, idMap || {});
      if (newFk && newFk !== before[link.col]) mapped[link.col] = newFk;
    }
  }
  const setCols = Object.keys(mapped);
  if (setCols.length === 0) return { protected: protectedCols };
  const sql = setCols.map(c => `${c} = ?`).join(', ');
  db.prepare(
    `UPDATE ${entity.table} SET ${sql}, version=version+1, updated_by=?, updated_at=datetime('now') WHERE ${entity.pk}=?`
  ).run(...setCols.map(c => mapped[c]), uid, id);
  auditLog(entity.table, id, 'UPDATE', before, mtRow(entity.table, entity.pk, id), uid);
  return { protected: protectedCols };
}

// #88 — apply a baseline-restore item: write the snapshot's COLUMN values directly.
// Restore items deliberately bypass mapFields/fieldMap: snapshots hold post-transform
// column values (e.g. tool.contract already '{"text":…}'), so routing them through the
// field transforms again would double-wrap. Still CP-gated (a human approved the
// restore) + audited; provenance/audit/identity columns are never restored.
const RESTORE_SKIP_COLS = new Set(['project_id', 'created_at', 'created_by', 'updated_at', 'updated_by',
  'version', 'lifecycle_status', 'visibility_scope',
  'source_system', 'source_sys_id', 'source_table', 'source_scope', 'source_fluent', 'source_hash']);
function mtRestore(entity, data, item, uid) {
  const id = item.entity_id;
  const before = mtRow(entity.table, entity.pk, id);
  if (!before) throw new SoftSkip(`${entity.entity_type}: restore target ${id} no longer exists`);
  const setCols = Object.keys(data || {}).filter(c =>
    c !== entity.pk && !RESTORE_SKIP_COLS.has(c) && Object.prototype.hasOwnProperty.call(before, c));
  if (!setCols.length) return { restored: [] };
  const sql = setCols.map(c => `${c} = ?`).join(', ');
  db.prepare(
    `UPDATE ${entity.table} SET ${sql}, version=version+1, updated_by=?, updated_at=datetime('now') WHERE ${entity.pk}=?`
  ).run(...setCols.map(c => data[c]), uid, id);
  auditLog(entity.table, id, 'RESTORE', before, mtRow(entity.table, entity.pk, id), uid);
  return { restored: setCols };
}

function mtDelete(entity, item, uid) {
  const id = item.entity_id;
  const before = mtRow(entity.table, entity.pk, id);
  if (!before) throw new SoftSkip(`${entity.entity_type}: delete target ${id} no longer exists`);
  for (const k of (registry.childrenOf[entity.entity_type] || [])) {
    const cnt = db.prepare(
      `SELECT COUNT(*) AS c FROM ${k.table} WHERE ${k.col} = ? AND (lifecycle_status IS NULL OR lifecycle_status != 'retired')`
    ).get(id).c;
    if (cnt > 0) return { blocked: true, reason: `${entity.entity_type} has ${cnt} dependent ${k.childType} — not deleted` };
  }
  db.prepare(
    `UPDATE ${entity.table} SET lifecycle_status='retired', version=version+1, updated_by=?, updated_at=datetime('now') WHERE ${entity.pk}=?`
  ).run(uid, id);
  auditLog(entity.table, id, 'UPDATE', before, mtRow(entity.table, entity.pk, id), uid);
  return { blocked: false };
}

/**
 * #62 fix — promote SN-proposed conflict values into real fields on approval.
 * HITL sync items stash the ServiceNow-proposed values under entity_data._sn_proposed
 * (never a fieldMap key), so applying the item used to write NOTHING for exactly the
 * fields the human was ratifying — the approval looked successful while the accepted
 * values were silently dropped, and the conflict re-surfaced on the next sync.
 * Approving an item (individually or with the whole packet) accepts the proposed
 * values as displayed, so: merge them into `data`, persist the merged new_value on
 * the item (audit truth), and return their columns as force-apply targets (the same
 * shrink-guard exception used for reviewer-typed field_overrides).
 * Mutates `data`. Returns a Set of column names to force, or null.
 */
function promoteSnProposed(entity, data, item) {
  if (!data || !data._sn_proposed || typeof data._sn_proposed !== 'object') return null;
  const validKeys = entity.fieldMap ? new Set(Object.keys(entity.fieldMap)) : null;
  const promoted = [];
  for (const [k, v] of Object.entries(data._sn_proposed)) {
    if (validKeys && !validKeys.has(k)) continue;
    data[k] = v;
    promoted.push(k);
  }
  delete data._sn_proposed;
  if (!promoted.length) return null;
  db.prepare(`UPDATE asdlc_change_packet_item
              SET new_value = ?, item_decision_notes = COALESCE(item_decision_notes, ?)
              WHERE change_packet_item_id = ?`)
    .run(JSON.stringify(data), `SN-proposed values accepted on approval: ${promoted.join(', ')}`, item.change_packet_item_id);
  item.new_value = JSON.stringify(data);
  return new Set(promoted.map(k => (entity.fieldMap && entity.fieldMap[k] && entity.fieldMap[k].col) || k));
}

function markItemApplied(itemId, note) {
  if (note) {
    db.prepare("UPDATE asdlc_change_packet_item SET applied_at=datetime('now'), rationale=TRIM(COALESCE(rationale,'') || ' ' || ?) WHERE change_packet_item_id=?").run(note, itemId);
  } else {
    db.prepare("UPDATE asdlc_change_packet_item SET applied_at=datetime('now') WHERE change_packet_item_id=?").run(itemId);
  }
}

// Registry entity_type → test_case.scope (the entities tests can target).
const TESTABLE_SCOPE_OF = { use_case: 'use_case', workflow: 'workflow', agent_spec: 'agent_spec', tool: 'tool' };

/**
 * Apply a single CP item using the same materializer as applyChangePacket, but
 * for ONE item only. Callers must wrap in a transaction. Returns the same result
 * shape as applyChangePacket so callers can treat it uniformly.
 */
function applyOneItem(item, cp, uid, forceKeys) {
  const result = { applied: 0, updated: 0, deleted: 0, skipped: 0, evidence: 0, errors: [], createdTestable: [] };

  const fp = item.field_path || '';
  if (!new RegExp(`^${item.entity_type}\\.(new_record|create|update|delete|restore)$`).test(fp)) {
    result.skipped++;
    return result;
  }

  const entity = registry.byEntityType[item.entity_type];
  let data; try { data = JSON.parse(item.new_value); } catch { data = {}; }

  if (!entity || !entity.materializable) {
    markItemApplied(item.change_packet_item_id, '[captured as supporting evidence — no design table for this type]');
    result.evidence++;
    return result;
  }

  const op = item.operation || 'create';
  const idMap = {};
  try {
    if (fp === `${item.entity_type}.restore`) {
      // Baseline restore (#88): snapshot columns applied verbatim — human-approved rollback.
      const r = mtRestore(entity, data, item, uid);
      result.updated++;
      if (r.restored.length) markItemApplied(item.change_packet_item_id, `[baseline restore: ${r.restored.join(', ')}]`);
    } else if (op === 'delete') {
      const r = mtDelete(entity, item, uid);
      if (r.blocked) {
        result.errors.push({ item: item.change_packet_item_id, entity_type: item.entity_type, reason: r.reason });
        return result;
      }
      result.deleted++;
    } else if (op === 'update') {
      // Translate human-resolved data-keys → columns so mtUpdate applies them verbatim.
      let forceCols = (forceKeys && forceKeys.size)
        ? new Set([...forceKeys].map(k => (entity.fieldMap && entity.fieldMap[k] && entity.fieldMap[k].col) || k))
        : null;
      // Any REMAINING SN-proposed values (not individually overridden) are accepted
      // as-is by this approval — promote + force them too (#62).
      const promotedCols = promoteSnProposed(entity, data, item);
      if (promotedCols) forceCols = new Set([...(forceCols || []), ...promotedCols]);
      const r = mtUpdate(entity, data, item, uid, forceCols, cp.project_id, idMap);
      result.updated++;
      if (r && r.protected && r.protected.length) {
        markItemApplied(item.change_packet_item_id, `[non-destructive: kept richer Workbench values for ${r.protected.join(', ')}]`);
      }
      materializeRequirementLinks(entity.entity_type, item.entity_id, data, cp.project_id, uid);
    } else {
      const newId = mtCreate(entity, data, cp.project_id, uid, idMap, item);
      result.applied++;
      materializeRequirementLinks(entity.entity_type, newId, data, cp.project_id, uid);
      const scope = TESTABLE_SCOPE_OF[entity.entity_type];
      if (scope) result.createdTestable.push({ scope, entityId: newId });
    }
    if (result.applied + result.updated + result.deleted > 0) {
      markItemApplied(item.change_packet_item_id, null);
    }
  } catch (err) {
    if (err instanceof SoftSkip) {
      result.errors.push({ item: item.change_packet_item_id, entity_type: item.entity_type, reason: err.message });
    } else {
      throw err;  // fatal — caller must roll back
    }
  }
  return result;
}

// Insert AI-generated test cases for one entity (draft, source='generated').
// Used both at materialize time and on demand. Dedupes by title per entity so
// re-running doesn't pile up copies. Never throws; returns the count inserted.
async function generateAndInsertTests(projectId, scope, entityId, uid) {
  try {
    const { generateTestCases } = require('./agent/test-generator');
    const result = await generateTestCases({ projectId, scope, entityId, db });
    if (!result.tests || !result.tests.length) return { created: 0, source: result.source };

    const validSlugs = new Set([
      ...db.prepare("SELECT slug FROM asdlc_functional_req WHERE project_id=? AND slug IS NOT NULL").all(projectId).map(r => r.slug),
      ...db.prepare("SELECT slug FROM asdlc_nonfunctional_req WHERE project_id=? AND slug IS NOT NULL").all(projectId).map(r => r.slug),
    ]);
    const existingTitles = new Set(
      db.prepare("SELECT title FROM asdlc_test_case WHERE project_id=? AND scope=? AND scope_entity_id=? AND lifecycle_status='active'")
        .all(projectId, scope, entityId).map(r => (r.title || '').toLowerCase())
    );

    let created = 0;
    for (const t of result.tests) {
      if (existingTitles.has((t.title || '').toLowerCase())) continue;
      const refs = (t.requirement_refs || []).filter(s => validSlugs.has(s));
      const id = generateId();
      db.prepare(`INSERT INTO asdlc_test_case
        (test_case_id, project_id, scope, scope_entity_id, title, test_action,
         test_input, expected_result, case_type, source, status, requirement_ids, created_by, updated_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, projectId, scope, entityId, t.title, t.test_action || '', t.test_input || '',
          t.expected_result || '', t.case_type || 'happy_path', 'generated', 'draft',
          JSON.stringify(refs), uid, uid);
      auditLog('asdlc_test_case', id, 'INSERT', null,
        db.prepare('SELECT * FROM asdlc_test_case WHERE test_case_id=?').get(id), uid);
      created++;
    }
    return { created, source: result.source };
  } catch (err) {
    console.error('[generateAndInsertTests]', err.message);
    return { created: 0, error: err.message };
  }
}

// Gather the full context the prompt-drafter needs for one agent row (workflow,
// use case, tools, design fields). Shared by the on-demand Draft Prompt endpoint
// and the auto-draft-on-ingest path so the two stay in lockstep.
function buildAgentPromptCtx(agent) {
  const workflow = agent.workflow_id
    ? db.prepare('SELECT workflow_id, name, slug FROM asdlc_workflow WHERE workflow_id = ?').get(agent.workflow_id)
    : null;
  const useCaseRow = db.prepare(`
    SELECT uc.use_case_id, uc.title, uc.summary, uc.business_objective
    FROM asdlc_agent_use_case auc
    JOIN asdlc_use_case uc ON uc.use_case_id = auc.use_case_id
    WHERE auc.agent_spec_id = ?
    ORDER BY auc.created_at
    LIMIT 1
  `).get(agent.agent_spec_id)
    || (agent.use_case_id ? db.prepare(
        'SELECT use_case_id, title, summary, business_objective FROM asdlc_use_case WHERE use_case_id = ?'
      ).get(agent.use_case_id) : null);
  const tools = db.prepare(`
    SELECT t.name, at.purpose, at.tool_execution_mode
    FROM asdlc_agent_tool at
    JOIN asdlc_tool t ON t.tool_id = at.tool_id
    WHERE at.agent_spec_id = ?
    ORDER BY t.name
  `).all(agent.agent_spec_id);
  // Platform-scoped AI Guidance so the drafted agent prompt honours the same house rules.
  const bestPractices = aiConfig.getActiveBestPractices(
    ['agent', 'agent_spec'], aiConfig.getProjectPlatform(agent.project_id));
  return {
    name:                   agent.name,
    scope:                  agent.scope,
    goals:                  parseJson(agent.goals)         || [],
    done_criteria:          parseJson(agent.done_criteria) || [],
    design_risks:           parseJson(agent.design_risks)  || [],
    supervision_model:      agent.supervision_model,
    orchestration_strategy: agent.orchestration_strategy,
    latency_target:         agent.latency_target,
    use_case_title:         useCaseRow?.title,
    workflow_name:          workflow?.name,
    tools,
    bestPractices,
  };
}

// Auto-draft a starting system prompt for a newly-created agent that has none, so
// agents arrive from ingest already carrying an editable prompt. Fire-and-forget
// AFTER commit (the Claude call must not run inside a DB transaction). Never throws.
// Only fills an EMPTY prompt — never overwrites one a user or the extractor already wrote.
async function autoDraftAgentPromptIfEmpty(projectId, agentId, uid) {
  try {
    const agent = db.prepare('SELECT * FROM asdlc_agent_spec WHERE agent_spec_id = ? AND project_id = ?').get(agentId, projectId);
    if (!agent) return { skipped: 'not found' };
    if (agent.instructions && agent.instructions.trim()) return { skipped: 'already has prompt' };

    const { draftAgentSystemPrompt } = require('./agent/prompt-drafter');
    const result = await draftAgentSystemPrompt(buildAgentPromptCtx(agent));
    if (!result || !result.draft || !result.draft.trim()) return { skipped: 'empty draft' };

    db.prepare("UPDATE asdlc_agent_spec SET instructions=?, updated_by=?, updated_at=datetime('now') WHERE agent_spec_id=?")
      .run(result.draft, uid || null, agentId);
    auditLog('asdlc_agent_spec', agentId, 'auto_draft_prompt', null,
      { source: result.source, model: result.model, chars: result.draft.length }, uid);
    if (result.usage) aiConfig.logUsage({ projectId, source: 'prompt_drafter', refId: agentId, model: result.model, usage: result.usage });
    return { drafted: true, source: result.source };
  } catch (err) {
    console.error('[autoDraftAgentPrompt]', err.message);
    return { drafted: false, error: err.message };
  }
}

// Derived entity types whose ingest extractions can carry implements_requirements.
const INGEST_LINK_ENTITY_TYPES = new Set(['workflow', 'workflow_step', 'agent_spec', 'tool']);

/**
 * Materialize requirement→element traceability links from an entity's
 * `implements_requirements` slug list (AI ingest). Resolves each FR/NFR slug to a
 * real requirement in the same project and inserts a 'proposed' link (source
 * 'agent_ingest'). Best-effort: slugs that don't resolve — e.g. a requirement
 * created later, or a hallucinated slug — are skipped; the /traceability/infer
 * backfill can pick them up afterward. Never throws into the apply loop.
 */
function materializeRequirementLinks(entityType, entityId, data, projectId, uid) {
  if (!INGEST_LINK_ENTITY_TYPES.has(entityType) || !entityId) return;
  const slugs = Array.isArray(data && data.implements_requirements) ? data.implements_requirements : [];
  if (slugs.length === 0) return;
  const conf = (typeof data.confidence === 'number') ? data.confidence : null;
  for (const raw of slugs) {
    const slug = String(raw || '').trim();
    if (!slug) continue;
    let req_type = null, req_id = null;
    const fr = db.prepare('SELECT fr_id AS id FROM asdlc_functional_req WHERE project_id=? AND slug=?').get(projectId, slug);
    if (fr) { req_type = 'functional'; req_id = fr.id; }
    else {
      const nfr = db.prepare('SELECT nfr_id AS id FROM asdlc_nonfunctional_req WHERE project_id=? AND slug=?').get(projectId, slug);
      if (nfr) { req_type = 'nonfunctional'; req_id = nfr.id; }
    }
    if (!req_id) continue;  // unresolved slug — backfill can catch it later
    const dup = db.prepare(
      "SELECT 1 FROM asdlc_requirement_link WHERE project_id=? AND req_type=? AND req_id=? AND entity_type=? AND entity_id=? AND lifecycle_status='active'"
    ).get(projectId, req_type, req_id, entityType, entityId);
    if (dup) continue;
    const id = generateId();
    db.prepare(`INSERT INTO asdlc_requirement_link
      (link_id, project_id, req_type, req_id, entity_type, entity_id, relationship, confidence, status, source, created_by, updated_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, projectId, req_type, req_id, entityType, entityId, 'implements', conf, 'proposed', 'agent_ingest', uid, uid);
    auditLog('asdlc_requirement_link', id, 'INSERT', null,
      db.prepare('SELECT * FROM asdlc_requirement_link WHERE link_id=?').get(id), uid);
  }
}

/**
 * Apply all items of an approved change packet to the real design tables.
 * @returns {{applied:number, updated:number, deleted:number, skipped:number, errors:Array}}
 */
// ─── Generic ServiceNow artifact materializer (Phase 2) ───────────────────────
// Writes asdlc_sn_artifact rows for Tier-B/C long-tail artifacts (and, later, Tier-A
// twins). Coalesces by source_sys_id within the project so a re-sync updates the same
// row (survives renames, never duplicates). parent_source_sys_id resolves to
// parent_artifact_id via the run's artifactIdMap or a DB lookup — a parent created
// earlier in the same packet is visible inside the surrounding transaction. SN is the
// source of truth for these technical bodies, so an update replaces payload/provenance;
// the non-destructive guard protects Workbench-AUTHORED content, not SN-owned L2.
function upsertArtifact(rec, projectId, uid, artifactIdMap, item) {
  let parent_artifact_id = null;
  if (rec.parent_source_sys_id) {
    parent_artifact_id = (artifactIdMap && artifactIdMap[rec.parent_source_sys_id]) || null;
    if (!parent_artifact_id) {
      const p = db.prepare("SELECT sn_artifact_id AS id FROM asdlc_sn_artifact WHERE source_sys_id=? AND project_id=? LIMIT 1").get(rec.parent_source_sys_id, projectId);
      parent_artifact_id = p ? p.id : null;
    }
  }
  const payloadJson  = JSON.stringify(rec.payload || {});
  const overrideJson = JSON.stringify(rec.override_fields || {});

  let existing = null;
  if (rec.source_sys_id) {
    existing = db.prepare("SELECT sn_artifact_id AS id FROM asdlc_sn_artifact WHERE source_sys_id=? AND project_id=? AND (lifecycle_status IS NULL OR lifecycle_status!='retired') LIMIT 1").get(rec.source_sys_id, projectId);
  }

  if (existing) {
    const before = mtRow('asdlc_sn_artifact', 'sn_artifact_id', existing.id);
    db.prepare(`UPDATE asdlc_sn_artifact SET sn_metadata_type=?, fluent_api_name=?, deploy_strategy=?, tier=?, name=?,
        payload=?, override_fields=?, parent_artifact_id=COALESCE(?,parent_artifact_id), child_role=?, child_order=?,
        projected_entity_type=COALESCE(?,projected_entity_type), source_table=?, source_scope=?, source_fluent=?,
        source_hash=?, sdk_version=?, version=version+1, updated_by=?, updated_at=datetime('now') WHERE sn_artifact_id=?`)
      .run(rec.sn_metadata_type, rec.fluent_api_name, rec.deploy_strategy, rec.tier, rec.name,
        payloadJson, overrideJson, parent_artifact_id, rec.child_role, rec.child_order,
        rec.projected_entity_type, rec.source_table, rec.source_scope, rec.source_fluent,
        rec.source_hash, rec.sdk_version, uid, existing.id);
    auditLog('asdlc_sn_artifact', existing.id, 'UPDATE', before, mtRow('asdlc_sn_artifact', 'sn_artifact_id', existing.id), uid);
    if (artifactIdMap && rec.source_sys_id) artifactIdMap[rec.source_sys_id] = existing.id;
    if (item) db.prepare("UPDATE asdlc_change_packet_item SET entity_id=? WHERE change_packet_item_id=?").run(existing.id, item.change_packet_item_id);
    return { id: existing.id, created: false };
  }

  const id = generateId();
  let slug = null;
  try { slug = nextSlug('asdlc_sn_artifact', 'ART', projectId); } catch { slug = null; }
  db.prepare(`INSERT INTO asdlc_sn_artifact (sn_artifact_id, project_id, slug, sn_metadata_type, fluent_api_name,
      deploy_strategy, tier, name, payload, override_fields, parent_artifact_id, child_role, child_order,
      projected_entity_type, projected_entity_id, source_system, source_sys_id, source_table, source_scope,
      source_fluent, source_hash, sdk_version, created_by, updated_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, projectId, slug, rec.sn_metadata_type, rec.fluent_api_name,
      rec.deploy_strategy, rec.tier, rec.name, payloadJson, overrideJson, parent_artifact_id, rec.child_role, rec.child_order,
      rec.projected_entity_type, rec.projected_entity_id || null, rec.source_system || 'servicenow', rec.source_sys_id, rec.source_table, rec.source_scope,
      rec.source_fluent, rec.source_hash, rec.sdk_version, uid, uid);
  auditLog('asdlc_sn_artifact', id, 'INSERT', null, mtRow('asdlc_sn_artifact', 'sn_artifact_id', id), uid);
  if (artifactIdMap && rec.source_sys_id) artifactIdMap[rec.source_sys_id] = id;
  if (item) db.prepare("UPDATE asdlc_change_packet_item SET entity_id=? WHERE change_packet_item_id=?").run(id, item.change_packet_item_id);
  return { id, created: true };
}

// After a Tier-A SN-sourced Level-1 row is materialized, mirror it into a generic
// asdlc_sn_artifact twin (the plan's "projection + twin") and back-link the L1 row.
// This also gives recursive children (e.g. a table's columns) a parent_artifact_id to
// resolve to within the same packet. No-op for non-Tier-A types and non-SN rows.
const L1_TWIN_TYPES = new Set(['data_model', 'form_design', 'business_logic', 'catalog_item', 'integration']);
function syncL1Twin(entityType, entityId, projectId, uid, artifactIdMap) {
  if (!L1_TWIN_TYPES.has(entityType)) return;
  const { L1, buildPayload } = require('./backfill-sn-artifacts');
  const reg2 = require('./agent/sn-type-registry');
  const spec = L1.find(s => s.etype === entityType);
  if (!spec) return;
  const row = mtRow(spec.table, spec.pk, entityId);
  if (!row || !row.source_sys_id) return;   // only ServiceNow-sourced rows get a twin
  const entry = reg2.resolveType(row.source_table || entityType);
  upsertArtifact({
    sn_metadata_type: entry.sn_metadata_type, fluent_api_name: entry.fluent_api_name || null,
    deploy_strategy: reg2.deployStrategyFor(entry, {}), tier: entry.tier,
    name: row.name || '(unnamed)', payload: buildPayload(row, spec), override_fields: {},
    projected_entity_type: entityType, projected_entity_id: entityId,
    parent_source_sys_id: null, child_role: null, child_order: null,
    source_system: row.source_system || 'servicenow', source_sys_id: row.source_sys_id,
    source_table: row.source_table, source_scope: row.source_scope, source_fluent: row.source_fluent,
    source_hash: row.source_hash, sdk_version: null,
  }, projectId, uid, artifactIdMap, null);
  const twinId = artifactIdMap && artifactIdMap[row.source_sys_id];
  if (twinId && row.sn_artifact_id !== twinId) {
    try { db.prepare(`UPDATE ${spec.table} SET sn_artifact_id=? WHERE ${spec.pk}=?`).run(twinId, entityId); } catch { /* column absent on old DB */ }
  }
}

function applyChangePacket(cpId, uid) {
  const cp = db.prepare("SELECT * FROM asdlc_change_packet WHERE change_packet_id = ?").get(cpId);
  const projectId = cp ? cp.project_id : null;
  const items = db.prepare("SELECT * FROM asdlc_change_packet_item WHERE change_packet_id = ? ORDER BY created_at").all(cpId);

  // Parents before children (FK-safe)
  const ordered = items.slice().sort((a, b) =>
    (registry.byEntityType[a.entity_type]?.order ?? 999) - (registry.byEntityType[b.entity_type]?.order ?? 999)
  );

  const idMap = {};
  const artifactIdMap = {};              // source_sys_id → sn_artifact_id (generic-artifact parent linkage within this packet)
  const touchedWorkflows = new Set();   // workflows that gained/changed steps → derive swimlane + RASIC after
  const result = { applied: 0, updated: 0, deleted: 0, skipped: 0, evidence: 0, errors: [], createdTestable: [], touchedWorkflows };

  for (const item of ordered) {
    if (item.applied_at) { result.skipped++; continue; }
    // Skip items the reviewer individually rejected — they opted out of this item
    if (item.item_status === 'rejected') { result.skipped++; continue; }

    // Only materialize items produced by the AI ingest pipeline (field_path
    // "<type>.new_record|create|update|delete"). Skip legacy/manual items —
    // e.g. seed 'initial_import' rows or design-review field edits — so they are
    // never re-created as new rows when an old change packet is approved.
    const fp = item.field_path || '';
    if (!new RegExp(`^${item.entity_type}\\.(new_record|create|update|delete|restore)$`).test(fp)) {
      result.skipped++;
      continue;
    }

    // Generic ServiceNow artifact (Phase 2): Tier-B/C long-tail + Tier-A twins live in
    // asdlc_sn_artifact, NOT the 22-type business registry. Handled BEFORE the registry
    // lookup so the business-design path below stays 100% unchanged.
    if (item.entity_type === 'sn_artifact') {
      let rec; try { rec = JSON.parse(item.new_value); } catch { rec = null; }
      if (!rec) { result.skipped++; continue; }
      try {
        const r = upsertArtifact(rec, projectId, uid, artifactIdMap, item);
        if (r.created) result.applied++; else result.updated++;
        markItemApplied(item.change_packet_item_id, null);
      } catch (err) {
        if (err instanceof SoftSkip) { result.errors.push({ item: item.change_packet_item_id, entity_type: 'sn_artifact', reason: err.message }); continue; }
        throw err;
      }
      continue;
    }

    const entity = registry.byEntityType[item.entity_type];
    let data; try { data = JSON.parse(item.new_value); } catch { data = {}; }

    if (!entity || !entity.materializable) {
      if (!entity) {
        // Completely unknown type — may indicate a stale/renamed entity_type in the CPI.
        console.warn(`[apply] unknown entity_type '${item.entity_type}' in CPI ${item.change_packet_item_id} — captured as evidence`);
      }
      markItemApplied(item.change_packet_item_id, '[captured as supporting evidence — no design table for this type]');
      result.evidence++;
      continue;
    }

    const op = item.operation || 'create';
    try {
      if (fp === `${item.entity_type}.restore`) {
        // Baseline restore (#88): snapshot columns applied verbatim — human-approved rollback.
        const r = mtRestore(entity, data, item, uid);
        result.updated++;
        if (r.restored.length) markItemApplied(item.change_packet_item_id, `[baseline restore: ${r.restored.join(', ')}]`);
      } else if (op === 'delete') {
        const r = mtDelete(entity, item, uid);
        if (r.blocked) { result.errors.push({ item: item.change_packet_item_id, entity_type: item.entity_type, reason: r.reason }); continue; }
        result.deleted++;
      } else if (op === 'update') {
        // Approving the packet accepts any SN-proposed conflict values as displayed —
        // promote them to real fields and force-apply (#62; previously they were
        // silently dropped and the "successful" approval wrote nothing).
        const forceCols = promoteSnProposed(entity, data, item);
        const r = mtUpdate(entity, data, item, uid, forceCols, projectId, idMap); result.updated++;
        if (r && r.protected && r.protected.length) {
          markItemApplied(item.change_packet_item_id, `[non-destructive: kept richer Workbench values for ${r.protected.join(', ')}]`);
        }
        materializeRequirementLinks(entity.entity_type, item.entity_id, data, projectId, uid);
        recordTouchedWorkflow(entity.entity_type, item.entity_id, touchedWorkflows);
        syncL1Twin(entity.entity_type, item.entity_id, projectId, uid, artifactIdMap);
      } else {
        const newId = mtCreate(entity, data, projectId, uid, idMap, item); result.applied++;
        materializeRequirementLinks(entity.entity_type, newId, data, projectId, uid);
        recordTouchedWorkflow(entity.entity_type, newId, touchedWorkflows);
        syncL1Twin(entity.entity_type, newId, projectId, uid, artifactIdMap);
        // Record newly-created testable entities so the caller can auto-generate
        // test coverage AFTER the transaction commits (Claude calls must not run
        // inside the DB transaction).
        const scope = TESTABLE_SCOPE_OF[entity.entity_type];
        if (scope) result.createdTestable.push({ scope, entityId: newId });
      }
      markItemApplied(item.change_packet_item_id, null);
    } catch (err) {
      if (err instanceof SoftSkip) {
        result.errors.push({ item: item.change_packet_item_id, entity_type: item.entity_type, reason: err.message });
        continue;
      }
      throw err;   // fatal — caller rolls back the whole transaction
    }
  }
  // ── Post-apply pass: link FRs/NFRs whose use_case_id is still NULL ────────────
  // FRs/NFRs have order:0 and UCs have order:1, so FRs are materialised BEFORE the
  // use case exists in idMap or the DB. resolveParents correctly reads use_case_title
  // but finds nothing to link to. Now the full pass is done — UCs exist — fix them.
  // This delegates to the same idempotent relinker used for backfill so the logic
  // (exact-title match → single-UC fallback) lives in ONE place and can never drift.
  try {
    const r = relinkOrphanRequirements(projectId, uid);
    if (r.linked) console.log(`[apply] post-pass linked ${r.linked} orphan requirement(s) to their use case`);
  } catch (err) {
    console.warn('[apply] orphan-requirement relink failed (non-fatal):', err.message);
  }

  // ── Post-apply pass: derive swimlane structure for touched workflows ──────────
  // Ingest extracts steps with an `actor_role` string but never creates participants,
  // step owners, or paths — so the swimlane renders everything in a single
  // "Missing Owner" lane with no arrows. Derive that structure deterministically.
  for (const wfId of touchedWorkflows) {
    try {
      const s = deriveSwimlane(wfId, projectId, uid);
      if (s.participantsCreated || s.ownersSet || s.pathsCreated) {
        console.log(`[apply] swimlane derived for workflow ${wfId}: +${s.participantsCreated} lanes, ${s.ownersSet} owners, +${s.pathsCreated} paths`);
      }
    } catch (err) {
      console.warn(`[apply] swimlane derivation failed for ${wfId} (non-fatal):`, err.message);
    }
  }

  return result;
}

/** Add a step/workflow's parent workflow id to the touched set (for swimlane derivation). */
function recordTouchedWorkflow(entityType, entityId, set) {
  try {
    if (entityType === 'workflow') { set.add(entityId); return; }
    if (entityType === 'workflow_step') {
      const row = db.prepare('SELECT workflow_id FROM asdlc_workflow_step WHERE workflow_step_id = ?').get(entityId);
      if (row && row.workflow_id) set.add(row.workflow_id);
    }
  } catch { /* non-fatal */ }
}

/** Learning loop: record proposed-vs-final for AI-sourced (ingest) change packets. */
function recordFeedbackForCp(cp, outcome, uid) {
  if (!cp || !cp.packet_code || !cp.packet_code.startsWith('CP-')) return;  // only ingest CPs, not manual EDIT-* CPs
  const items = db.prepare("SELECT * FROM asdlc_change_packet_item WHERE change_packet_id = ?").all(cp.change_packet_id);
  if (items.length === 0) return;
  const model = aiConfig.resolveModel('extraction');
  // Determine whether uid is a real user or a system-agent label (e.g. 'sn-extract').
  // Real users go in reviewer_id (FK-compatible); agent labels go in source_agent.
  const isRealUser = uid && !!db.prepare("SELECT 1 FROM asdlc_user WHERE user_id=?").get(uid);
  const ins = db.prepare(`
    INSERT INTO asdlc_ingest_feedback
      (feedback_id, project_id, ingest_id, extraction_id, change_packet_id, entity_type,
       model, confidence, outcome, proposed_value, final_value, reviewer_id, source_agent, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
  `);
  for (const it of items) {
    let finalValue = null;
    if (outcome !== 'rejected') {
      const entity = registry.byEntityType[it.entity_type];
      if (entity && entity.materializable && it.applied_at) {
        try { finalValue = JSON.stringify(mtRow(entity.table, entity.pk, it.entity_id)); } catch { /* ignore */ }
      }
    }
    ins.run(generateId(), cp.project_id, null, it.entity_id, cp.change_packet_id,
      it.entity_type, model, null, outcome, it.new_value, finalValue,
      isRealUser ? uid : null,   // reviewer_id — only when uid is a real user
      isRealUser ? null : uid);  // source_agent — system-agent label otherwise
  }
}

app.post('/api/v1/change-packets/:id/approve',    (req, res) => transitionCp(req, res, 'approved'));
app.post('/api/v1/change-packets/:id/reject',     (req, res) => transitionCp(req, res, 'rejected'));

// Send Back — sets status=sent_back, stores the reviewer's reason as decision_notes,
// and — when the CP has a linked ingest_id — routes that reason back to the ingest doc
// as a pre-answered clarification, resets the doc so it can be re-processed, and
// re-runs extraction immediately so a corrected CP can be promoted without re-uploading.
app.post('/api/v1/change-packets/:id/send-back', async (req, res) => {
  const cp = db.prepare('SELECT * FROM asdlc_change_packet WHERE change_packet_id = ?').get(req.params.id);
  if (!cp) return res.status(404).json({ error: 'Change packet not found' });
  const uid = userId(req);
  const reason = (req.body && (req.body.reason || req.body.decision_notes || '')).toString().trim();

  // 1. Update the CP: status + decision_notes
  db.prepare(`
    UPDATE asdlc_change_packet
    SET status = 'sent_back',
        decision_notes = COALESCE(?, decision_notes),
        updated_by = ?, updated_at = datetime('now'), version = version + 1
    WHERE change_packet_id = ?
  `).run(reason || null, uid, req.params.id);
  auditLog('asdlc_change_packet', req.params.id, 'UPDATE', cp,
    db.prepare('SELECT * FROM asdlc_change_packet WHERE change_packet_id = ?').get(req.params.id), uid);

  // 2. If no linked ingest doc, return the simple status update (manual CP — no re-run).
  if (!cp.ingest_id) {
    return res.json({
      change_packet: db.prepare('SELECT * FROM asdlc_change_packet WHERE change_packet_id = ?').get(req.params.id),
      ingest_result: null,
      message: 'Packet sent back. No linked ingest document — re-submit manually.',
    });
  }

  // 3. Linked ingest doc: write reason as a pre-answered clarification so the next
  //    extraction round sees it as reviewer context. Uses the existing multi-round flow.
  const ingestId = cp.ingest_id;
  const clarText  = reason
    ? `Reviewer sent back packet ${cp.packet_code}: ${reason}`
    : `Reviewer sent back packet ${cp.packet_code} — please re-analyse and correct the extraction.`;

  // Use the current round so the clarification is correctly numbered.
  const roundRow = db.prepare('SELECT MAX(round) AS r FROM asdlc_ingest_clarification WHERE ingest_id = ?').get(ingestId);
  const nextRound = ((roundRow && roundRow.r) || 0) + 1;

  // Skip if we already wrote a send-back clarification this round (idempotent).
  const dupCheck = db.prepare(
    "SELECT 1 FROM asdlc_ingest_clarification WHERE ingest_id=? AND target_field='send_back_reason' AND answer_text IS NOT NULL AND round=?"
  ).get(ingestId, nextRound);
  if (!dupCheck) {
    db.prepare(`
      INSERT INTO asdlc_ingest_clarification
        (clarification_id, ingest_id, round, question_text, context_snippet,
         target_entity_type, target_field, answer_text, answered_at, answered_by, created_at)
      VALUES (?,?,?,?,?, 'general','send_back_reason',?,datetime('now'),?,datetime('now'))
    `).run(generateId(), ingestId, nextRound,
      'Reviewer sent this change packet back. What should be corrected?',
      cp.summary || '',
      clarText, uid);
  }

  // 4. Delete promoted extractions so the new round re-extracts cleanly rather than
  //    treating all items as "already promoted and no changes needed".
  db.prepare("DELETE FROM asdlc_ingest_extraction WHERE ingest_id = ? AND status = 'promoted'").run(ingestId);

  // 5. Reset the ingest doc so it can be re-processed and re-promoted.
  db.prepare(`
    UPDATE asdlc_ingest_document
    SET ingest_status = 'staged', change_packets_generated = 0, updated_at = datetime('now')
    WHERE ingest_id = ?
  `).run(ingestId);

  // 6. Re-run extraction immediately with the new clarification context.
  //    Non-fatal: if it fails, the doc is still in a re-processable state.
  let ingestResult = null;
  try {
    const { processDocument } = require('./agent/processor');
    ingestResult = await processDocument(ingestId);
  } catch (err) {
    console.error('[send-back] re-run failed — doc left in staged state:', err.message);
    ingestResult = { error: err.message, note: 'Re-run failed — open the Ingest window to process manually.' };
  }

  return res.json({
    change_packet: db.prepare('SELECT * FROM asdlc_change_packet WHERE change_packet_id = ?').get(req.params.id),
    ingest_id: ingestId,
    ingest_result: ingestResult,
    message: 'Packet sent back. Extraction re-running — check the Ingest window to review and promote the corrected version.',
  });
});

// ──────────────────────────────────────────────
// ADMIN — AI SETTINGS (global model / thinking / tokens)
// ──────────────────────────────────────────────
// Keys are generated from the role list — every role's model + thinking effort is
// settable (plus the legacy enabled/budget pair, still honored beneath the effort key).
const AI_SETTING_KEYS = [
  ...aiConfig.ROLES.flatMap(r => [`${r}_model`, `${r}_thinking_effort`, `${r}_thinking_enabled`, `${r}_thinking_budget`]),
  'max_tokens', 'max_extraction_loops', 'model_registry_custom',
];

app.get('/api/v1/settings/ai', (_req, res) => {
  const settings = {
    max_tokens:           aiConfig.getMaxTokens(),
    max_extraction_loops: aiConfig.getMaxExtractionLoops(),
    // legacy fields kept for backward compat with older clients
    extraction_thinking_enabled: String(getSetting('extraction_thinking_enabled', 'false')) === 'true',
    extraction_thinking_budget:  getSetting('extraction_thinking_budget', '4000'),
  };
  for (const role of aiConfig.ROLES) {
    settings[`${role}_model`] = aiConfig.resolveModel(role);
    settings[`${role}_thinking_effort`] = aiConfig.resolveEffort(role) || 'off';
  }
  res.json({
    available_models: aiConfig.getRegistry().filter(m => m.status !== 'retired'),
    roles: aiConfig.ROLES,
    thinking_roles: aiConfig.THINKING_ROLES,
    effort_levels: aiConfig.EFFORT_LEVELS,
    settings,
    validation: aiConfig.validateAiConfig(),
    registry_custom: getSetting('model_registry_custom', ''),
  });
});

app.put('/api/v1/settings/ai', (req, res) => {
  const uid = userId(req);
  const body = req.body || {};
  const registry = aiConfig.getRegistry();
  const byId = new Map(registry.map(m => [m.id, m]));
  for (const key of AI_SETTING_KEYS) {
    if (!(key in body)) continue;
    let val = body[key];
    if (key.endsWith('_model') && val) {
      const entry = byId.get(val);
      if (!entry) return res.status(400).json({ error: `Unknown model "${val}" for ${key}` });
      if (entry.status === 'retired') return res.status(400).json({ error: `Model "${val}" is retired and cannot be selected for ${key}` });
      // deprecated/legacy are allowed — the validation block returned below carries the warning
    }
    if (key.endsWith('_thinking_effort') && val) {
      const v = String(val).toLowerCase();
      if (v !== 'off' && !aiConfig.EFFORT_LEVELS.includes(v)) {
        return res.status(400).json({ error: `Invalid thinking effort "${val}" for ${key} — use off|${aiConfig.EFFORT_LEVELS.join('|')}` });
      }
      val = v;
    }
    if (key === 'model_registry_custom' && val && String(val).trim()) {
      try {
        const parsed = JSON.parse(val);
        if (!Array.isArray(parsed)) throw new Error('must be a JSON array');
        for (const e of parsed) {
          if (!e || typeof e.id !== 'string' || !e.id) throw new Error('every entry needs a string "id"');
        }
      } catch (err) {
        return res.status(400).json({ error: `model_registry_custom rejected: ${err.message}` });
      }
    }
    if (key.endsWith('_thinking_enabled')) val = val ? 'true' : 'false';
    setSetting(key, val, uid);
  }
  auditLog('asdlc_app_setting', 'ai', 'UPDATE', null, body, uid);
  res.json({ ok: true, validation: aiConfig.validateAiConfig() });
});

// ──────────────────────────────────────────────
// AI USAGE (token / cost tracking)
// ──────────────────────────────────────────────
app.get('/api/v1/usage', (req, res) => {
  const { project_id, source, limit } = req.query;
  const where = [];
  const params = [];
  if (project_id) { where.push('project_id = ?'); params.push(project_id); }
  if (source)     { where.push('source = ?');     params.push(source); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT * FROM asdlc_ai_usage ${whereSql} ORDER BY created_at DESC LIMIT ?`
  ).all(...params, Math.min(parseInt(limit, 10) || 200, 1000));
  const totals = db.prepare(
    `SELECT COUNT(*) AS runs, COALESCE(SUM(input_tokens),0) AS input_tokens,
            COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(cost_usd),0) AS cost_usd
     FROM asdlc_ai_usage ${whereSql}`
  ).get(...params);
  const byModel = db.prepare(
    `SELECT model, COUNT(*) AS runs, COALESCE(SUM(input_tokens),0) AS input_tokens,
            COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(cost_usd),0) AS cost_usd
     FROM asdlc_ai_usage ${whereSql} GROUP BY model ORDER BY cost_usd DESC`
  ).all(...params);
  // Flag models whose usage can't be costed (missing from the registry / no pricing)
  const pricing = aiConfig.MODEL_PRICING;
  for (const r of byModel) r.has_pricing = !!(r.model && pricing[r.model]);
  totals.pricing_missing_models = byModel.filter(r => !r.has_pricing && r.model).map(r => r.model);
  res.json({ rows, totals, by_model: byModel });
});

app.get('/api/v1/projects/:id/usage', (req, res) => {
  const pid = req.params.id;
  const rows = db.prepare(
    "SELECT * FROM asdlc_ai_usage WHERE project_id = ? ORDER BY created_at DESC LIMIT 50"
  ).all(pid);
  const totals = db.prepare(
    `SELECT COUNT(*) AS runs,
            COALESCE(SUM(input_tokens),0)  AS input_tokens,
            COALESCE(SUM(output_tokens),0) AS output_tokens,
            COALESCE(SUM(cost_usd),0)      AS cost_usd
     FROM asdlc_ai_usage WHERE project_id = ?`
  ).get(pid);
  const byModel = db.prepare(
    `SELECT model, COUNT(*) AS runs,
            COALESCE(SUM(input_tokens),0)  AS input_tokens,
            COALESCE(SUM(output_tokens),0) AS output_tokens,
            COALESCE(SUM(cost_usd),0)      AS cost_usd
     FROM asdlc_ai_usage WHERE project_id = ? GROUP BY model ORDER BY cost_usd DESC`
  ).all(pid);
  const bySource = db.prepare(
    `SELECT source, COUNT(*) AS runs,
            COALESCE(SUM(cost_usd),0) AS cost_usd
     FROM asdlc_ai_usage WHERE project_id = ? GROUP BY source ORDER BY cost_usd DESC`
  ).all(pid);
  res.json({ rows, totals, by_model: byModel, by_source: bySource });
});

// Usage for a single ingest document (surfaced on the ingest detail screen)
app.get('/api/v1/ingest-documents/:id/usage', (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM asdlc_ai_usage WHERE ref_id = ? AND source = 'ingest_extraction' ORDER BY created_at DESC"
  ).all(req.params.id);
  res.json(rows);
});

// Tool-call audit: distinct tools ever invoked by Claude, with count + last-seen
app.get('/api/v1/admin/tool-calls', (req, res) => {
  const summary = db.prepare(
    `SELECT tool_name, source, COUNT(*) AS count, MAX(created_at) AS last_seen
     FROM asdlc_tool_call_log
     GROUP BY tool_name, source
     ORDER BY count DESC`
  ).all();
  const distinct_tools = db.prepare(
    `SELECT tool_name, SUM(count) AS total_count, MAX(last_seen) AS last_seen
     FROM (SELECT tool_name, COUNT(*) AS count, MAX(created_at) AS last_seen
           FROM asdlc_tool_call_log GROUP BY tool_name)
     GROUP BY tool_name ORDER BY total_count DESC`
  ).all();
  res.json({ distinct_tools, by_source: summary });
});

// Raw tool-call log (time-ordered, capped)
app.get('/api/v1/admin/tool-calls/raw', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
  const rows = db.prepare(
    `SELECT * FROM asdlc_tool_call_log ORDER BY created_at DESC LIMIT ?`
  ).all(limit);
  res.json(rows);
});

// ──────────────────────────────────────────────
// BEST PRACTICES (global house rules for the AI) + LEARNING FEEDBACK
// ──────────────────────────────────────────────
app.get('/api/v1/best-practices', (_req, res) => {
  res.json(db.prepare("SELECT * FROM asdlc_best_practice ORDER BY is_active DESC, sort_order, created_at").all());
});

app.post('/api/v1/best-practices', (req, res) => {
  const uid = userId(req);
  const { title, rule_text, scope, is_active, sort_order, source, practice_type, platform } = req.body || {};
  if (!title || !rule_text) return res.status(400).json({ error: 'title and rule_text are required' });
  const ptype = (practice_type === 'question' || practice_type === 'rule') ? practice_type : 'rule';
  const plat = ['any', 'servicenow', 'generic'].includes(platform) ? platform : 'any';
  const id = generateId();
  db.prepare(`
    INSERT INTO asdlc_best_practice
      (best_practice_id, scope, platform, title, rule_text, practice_type, is_active, sort_order, source, created_by, updated_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, scope || 'global', plat, title, rule_text, ptype,
         is_active === false ? 0 : 1, sort_order || 0, source || 'manual', uid, uid);
  auditLog('asdlc_best_practice', id, 'INSERT', null, { title, scope: scope || 'global', platform: plat, practice_type: ptype }, uid);
  res.status(201).json(db.prepare("SELECT * FROM asdlc_best_practice WHERE best_practice_id = ?").get(id));
});

app.put('/api/v1/best-practices/:id', (req, res) => {
  const uid = userId(req);
  const existing = db.prepare("SELECT * FROM asdlc_best_practice WHERE best_practice_id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Best practice not found' });
  const { title, rule_text, scope, is_active, sort_order, practice_type, platform } = req.body || {};
  const ptype = practice_type === 'question' ? 'question' : practice_type === 'rule' ? 'rule' : null;
  const plat = ['any', 'servicenow', 'generic'].includes(platform) ? platform : null;
  db.prepare(`
    UPDATE asdlc_best_practice
    SET title=COALESCE(?,title), rule_text=COALESCE(?,rule_text), scope=COALESCE(?,scope),
        platform=COALESCE(?,platform),
        is_active=COALESCE(?,is_active), sort_order=COALESCE(?,sort_order),
        practice_type=COALESCE(?,practice_type),
        updated_by=?, updated_at=datetime('now')
    WHERE best_practice_id=?
  `).run(
    title ?? null, rule_text ?? null, scope ?? null, plat,
    is_active === undefined ? null : (is_active ? 1 : 0),
    sort_order ?? null, ptype, uid, req.params.id
  );
  res.json(db.prepare("SELECT * FROM asdlc_best_practice WHERE best_practice_id = ?").get(req.params.id));
});

app.delete('/api/v1/best-practices/:id', (req, res) => {
  db.prepare("DELETE FROM asdlc_best_practice WHERE best_practice_id = ?").run(req.params.id);
  res.json({ ok: true });
});

// Learning view: extraction acceptance stats + recent corrections.
app.get('/api/v1/feedback/summary', (req, res) => {
  const { project_id } = req.query;
  const where = project_id ? 'WHERE project_id = ?' : '';
  const params = project_id ? [project_id] : [];
  const byOutcome = db.prepare(
    `SELECT outcome, COUNT(*) AS n FROM asdlc_ingest_feedback ${where} GROUP BY outcome`
  ).all(...params);
  const byModel = db.prepare(
    `SELECT model, outcome, COUNT(*) AS n FROM asdlc_ingest_feedback ${where} GROUP BY model, outcome`
  ).all(...params);
  const recent = db.prepare(
    `SELECT * FROM asdlc_ingest_feedback ${where} ORDER BY created_at DESC LIMIT 100`
  ).all(...params);
  res.json({ by_outcome: byOutcome, by_model: byModel, recent });
});

// ──────────────────────────────────────────────
// MASS APPROVE (semantic versioning + baseline)
// ──────────────────────────────────────────────

/** Bump a "major.minor.patch" version string */
function bumpVersion(current, releaseType) {
  const parts = String(current || '1.0.0').split('.').map(n => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  if (releaseType === 'major')      { parts[0]++; parts[1] = 0; parts[2] = 0; }
  else if (releaseType === 'minor') { parts[1]++; parts[2] = 0; }
  else                              { parts[2]++; } // patch
  return parts.join('.');
}

app.post('/api/v1/projects/:id/mass-approve', (req, res) => {
  const { change_packet_ids, release_type, notes } = req.body || {};
  if (!Array.isArray(change_packet_ids) || change_packet_ids.length === 0) {
    return res.status(400).json({ error: 'change_packet_ids array is required' });
  }
  const validTypes = ['major', 'minor', 'patch'];
  const rType = validTypes.includes(release_type) ? release_type : 'patch';
  const uid = userId(req);

  const proj = db.prepare('SELECT * FROM asdlc_project WHERE project_id = ?').get(req.params.id);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const newVersionString = bumpVersion(proj.version_string, rType);
  const projBefore = { ...proj };

  // Approve + MATERIALIZE all specified CPs in ONE transaction so a release is atomic:
  // status flip + design materialization (applyChangePacket — the previously-missing
  // pipeline) + project version bump + baseline all commit together, or roll back
  // together. Test generation / feedback run AFTER commit (Claude calls must not run
  // inside the DB transaction).
  const approveStmt = db.prepare(`
    UPDATE asdlc_change_packet
    SET status             = 'approved',
        approval_timestamp = datetime('now'),
        updated_by         = ?,
        updated_at         = datetime('now'),
        version            = version + 1
    WHERE change_packet_id = ? AND project_id = ? AND status != 'approved'
  `);

  let approvedCount = 0;
  const approvedCpIds  = [];
  const createdTestable = [];
  const applyErrors     = [];
  let baseline = null;

  db.exec('BEGIN');
  try {
    for (const cpId of change_packet_ids) {
      const cpBefore = db.prepare('SELECT * FROM asdlc_change_packet WHERE change_packet_id = ?').get(cpId);
      if (!cpBefore || cpBefore.project_id !== req.params.id) continue;
      const info = approveStmt.run(uid, cpId, req.params.id);
      if (info.changes === 0) continue;

      // Materialize this packet into the real design tables (was missing → CPs were
      // marked approved/released but nothing was written). Fatal errors bubble to the
      // outer catch and roll back the whole release; SoftSkips are collected.
      const ar = applyChangePacket(cpId, uid);
      if (ar.errors && ar.errors.length) applyErrors.push(...ar.errors.map(e => ({ change_packet_id: cpId, ...e })));
      if (ar.createdTestable && ar.createdTestable.length) createdTestable.push(...ar.createdTestable);

      const cpAfter = db.prepare('SELECT * FROM asdlc_change_packet WHERE change_packet_id = ?').get(cpId);
      auditLog('asdlc_change_packet', cpId, 'UPDATE', cpBefore, cpAfter, uid);
      approvedCpIds.push(cpId);
      approvedCount++;
    }

    if (approvedCount === 0) {
      db.exec('ROLLBACK');
      return res.status(400).json({ error: 'No eligible change packets found for this project' });
    }

    // Bump version_string and integer version on the project
    db.prepare(`
      UPDATE asdlc_project
      SET version_string = ?, version = version + 1, updated_at = datetime('now'), updated_by = ?
      WHERE project_id = ?
    `).run(newVersionString, uid, req.params.id);
    const projAfter = db.prepare('SELECT * FROM asdlc_project WHERE project_id = ?').get(req.params.id);
    auditLog('asdlc_project', req.params.id, 'UPDATE', projBefore, projAfter, uid);

    // Create a baseline record to represent this release (non-fatal if it fails)
    const baselineId = generateId();
    const relLabel = rType.charAt(0).toUpperCase() + rType.slice(1);
    const baselineName = `v${newVersionString} — ${relLabel} Release`;
    try {
      db.prepare(`
        INSERT INTO asdlc_baseline (baseline_id, project_id, baseline_name, baseline_type, baseline_status, locked_at, created_by, updated_by)
        VALUES (?, ?, ?, ?, 'approved', datetime('now'), ?, ?)
      `).run(baselineId, req.params.id, baselineName, rType, uid, uid);
    } catch (e) {
      // baseline_type enum may reject 'major'/'minor'/'patch' — fall back to 'production'
      try {
        db.prepare(`
          INSERT INTO asdlc_baseline (baseline_id, project_id, baseline_name, baseline_type, baseline_status, locked_at, created_by, updated_by)
          VALUES (?, ?, ?, 'production', 'approved', datetime('now'), ?, ?)
        `).run(baselineId, req.params.id, baselineName, uid, uid);
      } catch (e2) { console.warn('[mass-approve] Could not create baseline:', e2.message); }
    }
    baseline = db.prepare('SELECT * FROM asdlc_baseline WHERE baseline_id = ?').get(baselineId) || null;
    // Snapshot the released design into the baseline so it is a real, comparable version.
    if (baseline) {
      try {
        const snap = snapshotDesignIntoBaseline(req.params.id, baselineId);
        db.prepare("UPDATE asdlc_baseline SET record_count=?, field_count=? WHERE baseline_id=?")
          .run(snap.recordCount, snap.fieldCount, baselineId);
      } catch (e) { console.warn('[mass-approve] baseline snapshot failed (non-fatal):', e.message); }
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('[mass-approve] failed — rolled back:', err.message);
    return res.status(500).json({ error: `Mass-approve failed (no changes applied): ${err.message}` });
  }

  // ── Post-commit side effects (outside the transaction) ──────────────────────
  for (const cpId of approvedCpIds) {
    try { recordFeedbackForCp(db.prepare('SELECT * FROM asdlc_change_packet WHERE change_packet_id = ?').get(cpId), 'accepted_asis', uid); }
    catch (e) { console.error('[mass-approve feedback]', e.message); }
  }
  if (createdTestable.length) {
    Promise.allSettled(createdTestable.map(e => generateAndInsertTests(req.params.id, e.scope, e.entityId, uid)))
      .then(rs => {
        const n = rs.reduce((a, r) => a + (r.status === 'fulfilled' ? (r.value.created || 0) : 0), 0);
        if (n) console.log(`[mass-approve] generated ${n} test case(s) across ${createdTestable.length} entit(ies)`);
      });
    const newAgents = createdTestable.filter(e => e.scope === 'agent_spec');
    if (newAgents.length) {
      Promise.allSettled(newAgents.map(e => autoDraftAgentPromptIfEmpty(req.params.id, e.entityId, uid)))
        .then(rs => {
          const n = rs.reduce((a, r) => a + (r.status === 'fulfilled' && r.value.drafted ? 1 : 0), 0);
          if (n) console.log(`[mass-approve] drafted ${n} agent prompt(s)`);
        });
    }
  }

  res.json({
    version_string: newVersionString,
    previous_version_string: proj.version_string || '1.0.0',
    release_type: rType,
    approved_count: approvedCount,
    apply_errors: applyErrors,
    notes: notes || null,
    baseline,
  });
});

// Split: creates a sibling CP and copies all items into it (pending, not yet applied).
// The reviewer can then approve/reject each sibling independently — e.g. approve one
// half while rejecting the other, or edit items in one before approving.
app.post('/api/v1/change-packets/:id/split', (req, res) => {
  const existing = db.prepare('SELECT * FROM asdlc_change_packet WHERE change_packet_id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Change packet not found' });
  const uid  = userId(req);
  const newId   = generateId();
  const newCode = existing.packet_code + '-SPLIT';

  db.prepare(`
    INSERT INTO asdlc_change_packet
      (change_packet_id, project_id, packet_code, status, summary,
       source_evidence_id, ingest_id, risk_level, conflict_classification,
       baseline_impacting, created_by, updated_by)
    VALUES (?, ?, ?, 'pending_review', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newId, existing.project_id, newCode,
    (req.body && req.body.summary) ? req.body.summary : existing.summary + ' (split)',
    existing.source_evidence_id ?? null,
    existing.ingest_id ?? null,
    existing.risk_level,
    existing.conflict_classification,
    existing.baseline_impacting,
    uid, uid
  );

  // Copy all change items into the new CP. Items are unapplied (applied_at=null).
  const items = db.prepare('SELECT * FROM asdlc_change_packet_item WHERE change_packet_id = ?').all(req.params.id);
  const insItem = db.prepare(`
    INSERT INTO asdlc_change_packet_item
      (change_packet_item_id, change_packet_id, entity_type, entity_id, operation,
       field_path, old_value, new_value, rationale, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
  `);
  for (const it of items) {
    insItem.run(generateId(), newId, it.entity_type, it.entity_id, it.operation,
      it.field_path, it.old_value, it.new_value, it.rationale);
  }

  const created = db.prepare('SELECT * FROM asdlc_change_packet WHERE change_packet_id = ?').get(newId);
  auditLog('asdlc_change_packet', newId, 'INSERT', null, created, uid);
  res.status(201).json({ new_id: newId, item_count: items.length, change_packet: created });
});

// ──────────────────────────────────────────────
// EVIDENCE SOURCES
// ──────────────────────────────────────────────
app.get('/api/v1/evidence-sources', (req, res) => {
  const { project_id, source_type, validation_status } = req.query;
  let sql = "SELECT * FROM asdlc_evidence_source WHERE lifecycle_status = 'active'";
  const params = [];
  if (project_id)        { sql += ' AND project_id = ?';        params.push(project_id); }
  if (source_type)       { sql += ' AND source_type = ?';       params.push(source_type); }
  if (validation_status) { sql += ' AND validation_status = ?'; params.push(validation_status); }
  sql += ' ORDER BY source_datetime DESC';
  res.json(db.prepare(sql).all(...params));
});

app.get('/api/v1/evidence-sources/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM asdlc_evidence_source WHERE evidence_source_id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Evidence source not found' });
  const refs = db.prepare(
    'SELECT * FROM asdlc_source_reference WHERE evidence_source_id = ? ORDER BY created_at'
  ).all(req.params.id);
  res.json({ ...row, references: refs });
});

app.post('/api/v1/evidence-sources', (req, res) => {
  const { project_id, source_title, source_type, validation_status } = req.body;
  if (!project_id || !source_title) {
    return res.status(400).json({ error: 'project_id and source_title are required' });
  }
  const id = generateId();
  const uid = userId(req);
  db.prepare(`
    INSERT INTO asdlc_evidence_source
      (evidence_source_id, project_id, source_title, source_type, validation_status, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, project_id, source_title, source_type || 'document', validation_status || 'draft', uid, uid);
  const created = db.prepare('SELECT * FROM asdlc_evidence_source WHERE evidence_source_id = ?').get(id);
  auditLog('asdlc_evidence_source', id, 'INSERT', null, created, uid);
  res.status(201).json(created);
});

app.put('/api/v1/evidence-sources/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM asdlc_evidence_source WHERE evidence_source_id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Evidence source not found' });
  const uid = userId(req);
  const { source_title, source_type, validation_status, notes, ingestion_status } = req.body;
  db.prepare(`
    UPDATE asdlc_evidence_source
    SET source_title      = COALESCE(?, source_title),
        source_type       = COALESCE(?, source_type),
        validation_status = COALESCE(?, validation_status),
        notes             = COALESCE(?, notes),
        ingestion_status  = COALESCE(?, ingestion_status),
        updated_by        = ?,
        updated_at        = datetime('now'),
        version           = version + 1
    WHERE evidence_source_id = ?
  `).run(source_title, source_type, validation_status, notes, ingestion_status, uid, req.params.id);
  const updated = db.prepare('SELECT * FROM asdlc_evidence_source WHERE evidence_source_id = ?').get(req.params.id);
  auditLog('asdlc_evidence_source', req.params.id, 'UPDATE', existing, updated, uid);
  res.json(updated);
});

app.get('/api/v1/evidence-sources/:id/linked-items', (req, res) => {
  const count = db.prepare(
    'SELECT COUNT(*) AS n FROM asdlc_change_packet WHERE source_evidence_id = ?'
  ).get(req.params.id).n;
  res.json({ evidence_source_id: req.params.id, linked_change_packets: count });
});

// ──────────────────────────────────────────────
// AUDIT LOG
// ──────────────────────────────────────────────
app.get('/api/v1/audit-log', (req, res) => {
  const { table_name, record_id } = req.query;
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  let sql = 'SELECT * FROM asdlc_audit_log WHERE 1=1';
  const params = [];
  if (table_name) { sql += ' AND table_name = ?'; params.push(table_name); }
  if (record_id)  { sql += ' AND record_id = ?';  params.push(record_id); }
  sql += ` ORDER BY changed_at DESC LIMIT ${limit}`;
  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(r => ({
    ...r,
    old_data: parseJson(r.old_data),
    new_data: parseJson(r.new_data),
  })));
});

// ──────────────────────────────────────────────
// BASELINES
// ──────────────────────────────────────────────
// Snapshot the current materialized design into asdlc_baseline_item so a baseline is a
// real, comparable point-in-time version (not just an empty shell). One item per entity
// (field_path=null), snapshot_value = JSON of the entity's business columns (volatile/
// provenance columns stripped so diffs are meaningful). Returns magnitude counts.
// Caller controls the transaction; per-row failures are skipped, never thrown.
function snapshotDesignIntoBaseline(projectId, baselineId) {
  const SKIP = new Set(['created_at','updated_at','updated_by','created_by','version',
    'source_hash','source_fluent','lifecycle_status','visibility_scope']);
  let recordCount = 0, fieldCount = 0;
  const insItem = db.prepare(`INSERT INTO asdlc_baseline_item
    (baseline_item_id, baseline_id, entity_type, entity_id, field_path, snapshot_value) VALUES (?,?,?,?,?,?)`);
  for (const [etype, ent] of Object.entries(registry.byEntityType)) {
    if (!ent || !ent.materializable || !ent.table || !ent.pk) continue;
    let rows;
    try {
      rows = db.prepare(`SELECT * FROM ${ent.table} WHERE project_id = ? AND (lifecycle_status IS NULL OR lifecycle_status NOT IN ('retired','deleted'))`).all(projectId);
    } catch {
      try { rows = db.prepare(`SELECT * FROM ${ent.table} WHERE project_id = ?`).all(projectId); } catch { continue; }
    }
    for (const row of rows) {
      const snap = {};
      for (const [k, v] of Object.entries(row)) {
        if (SKIP.has(k) || v === null || v === undefined || v === '') continue;
        snap[k] = v;
      }
      try {
        insItem.run(generateId(), baselineId, etype, String(row[ent.pk]), null, JSON.stringify(snap));
        recordCount++; fieldCount += Object.keys(snap).length;
      } catch { /* skip a bad row, keep going */ }
    }
  }
  return { recordCount, fieldCount };
}

app.get('/api/v1/baselines', (req, res) => {
  const { project_id } = req.query;
  let sql = "SELECT * FROM asdlc_baseline WHERE lifecycle_status = 'active'";
  const params = [];
  if (project_id) { sql += ' AND project_id = ?'; params.push(project_id); }
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

app.get('/api/v1/baselines/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM asdlc_baseline WHERE baseline_id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Baseline not found' });
  res.json(row);
});

app.post('/api/v1/baselines', (req, res) => {
  const { project_id, baseline_type, baseline_name, baseline_status } = req.body;
  if (!project_id || !baseline_name) {
    return res.status(400).json({ error: 'project_id and baseline_name are required' });
  }
  const id = generateId();
  const uid = userId(req);
  db.prepare(`
    INSERT INTO asdlc_baseline
      (baseline_id, project_id, baseline_type, baseline_name, baseline_status, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, project_id, baseline_type || 'draft', baseline_name, baseline_status || 'draft', uid, uid);
  const created = db.prepare('SELECT * FROM asdlc_baseline WHERE baseline_id = ?').get(id);
  auditLog('asdlc_baseline', id, 'INSERT', null, created, uid);
  res.status(201).json(created);
});

app.post('/api/v1/baselines/:id/lock', (req, res) => {
  const existing = db.prepare('SELECT * FROM asdlc_baseline WHERE baseline_id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Baseline not found' });
  if (existing.locked_at) return res.status(409).json({ error: 'Baseline already locked' });
  const uid = userId(req);
  const { locked_by_member_id } = req.body || {};
  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE asdlc_baseline
      SET baseline_status     = 'approved',
          locked_at           = datetime('now'),
          locked_by_member_id = COALESCE(?, locked_by_member_id),
          updated_by          = ?,
          updated_at          = datetime('now'),
          version             = version + 1
      WHERE baseline_id = ?
    `).run(locked_by_member_id || null, uid, req.params.id);
    // Capture a real design snapshot at lock time so the baseline is a comparable version.
    const snap = snapshotDesignIntoBaseline(existing.project_id, req.params.id);
    db.prepare("UPDATE asdlc_baseline SET record_count=?, field_count=? WHERE baseline_id=?")
      .run(snap.recordCount, snap.fieldCount, req.params.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: 'Failed to lock baseline: ' + err.message });
  }
  const updated = db.prepare('SELECT * FROM asdlc_baseline WHERE baseline_id = ?').get(req.params.id);
  auditLog('asdlc_baseline', req.params.id, 'UPDATE', existing, updated, uid);
  res.json(updated);
});

// #88 — Restore a project's design to a locked baseline, as a reviewable Change Packet.
// Non-destructive posture: field values of still-existing records are restored (via
// `.restore` items applied column-verbatim on approval — bypassing field transforms,
// since snapshots hold post-transform column values); records MISSING since the baseline
// and records ADDED since the baseline are REPORTED for the human, never auto-recreated
// or auto-retired. ?dry_run=1 (or body.dry_run) returns the plan without writing.
app.post('/api/v1/baselines/:id/restore', (req, res) => {
  const baseline = db.prepare('SELECT * FROM asdlc_baseline WHERE baseline_id = ?').get(req.params.id);
  if (!baseline) return res.status(404).json({ error: 'Baseline not found' });
  const items = db.prepare('SELECT entity_type, entity_id, snapshot_value FROM asdlc_baseline_item WHERE baseline_id = ?').all(req.params.id);
  if (!items.length) return res.status(409).json({ error: 'Baseline has no snapshot — lock it first (snapshots are captured at lock time).' });

  const uid = userId(req);
  const updates = [], missing = [];
  let unchanged = 0;
  const inBaseline = new Set();
  for (const it of items) {
    inBaseline.add(`${it.entity_type}::${it.entity_id}`);
    const entity = registry.byEntityType[it.entity_type];
    if (!entity || !entity.materializable || !entity.table || !entity.pk) continue;
    let snap; try { snap = JSON.parse(it.snapshot_value) || {}; } catch { continue; }
    const cur = mtRow(entity.table, entity.pk, it.entity_id);
    if (!cur || ['retired', 'deleted'].includes(cur.lifecycle_status)) {
      missing.push({ entity_type: it.entity_type, entity_id: it.entity_id, name: snap.name || snap.title || null });
      continue;
    }
    const cols = {};
    for (const [k, v] of Object.entries(snap)) {
      if (k === entity.pk || RESTORE_SKIP_COLS.has(k)) continue;
      if (!Object.prototype.hasOwnProperty.call(cur, k)) continue;
      if (String(cur[k] ?? '') !== String(v ?? '')) cols[k] = { from: cur[k], to: v };
    }
    if (Object.keys(cols).length) {
      updates.push({ entity_type: it.entity_type, entity_id: it.entity_id, name: cur.name || cur.title || snap.name || null, cols });
    } else unchanged++;
  }
  // Records created after the baseline (present now, absent from the snapshot) — report only.
  const added = [];
  for (const [etype, ent] of Object.entries(registry.byEntityType)) {
    if (!ent || !ent.materializable || !ent.table || !ent.pk) continue;
    let rows = [];
    try {
      rows = db.prepare(`SELECT * FROM ${ent.table} WHERE project_id = ? AND (lifecycle_status IS NULL OR lifecycle_status NOT IN ('retired','deleted'))`).all(baseline.project_id);
    } catch { continue; }
    for (const r of rows) if (!inBaseline.has(`${etype}::${r[ent.pk]}`)) {
      added.push({ entity_type: etype, entity_id: String(r[ent.pk]), name: r.name || r.title || null });
    }
  }
  const plan = {
    baseline: { id: baseline.baseline_id, name: baseline.baseline_name, locked_at: baseline.locked_at },
    restore_updates: updates.length, unchanged,
    missing_since_baseline: missing, added_since_baseline: added,
    updates,
    note: 'Only field values of still-existing records are restored. Records missing since the baseline are NOT auto-recreated and records added since are NOT auto-retired — review those manually.',
  };
  const dryRun = req.query.dry_run === '1' || (req.body && req.body.dry_run === true);
  if (dryRun || !updates.length) return res.json({ dry_run: true, applied: false, plan });

  db.exec('BEGIN');
  let cp;
  try {
    const cpId = generateId();
    db.prepare(`INSERT INTO asdlc_change_packet (change_packet_id, project_id, packet_code, status, summary, conflict_classification, recommended_action, created_by, updated_by)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(cpId, baseline.project_id, uniquePacketCode(), 'pending_review',
           `Restore design to baseline "${baseline.baseline_name}" (${updates.length} record(s))`,
           'modifies_existing', 'review', uid, uid);
    const ins = db.prepare(`INSERT INTO asdlc_change_packet_item (change_packet_item_id, change_packet_id, entity_type, entity_id, operation, field_path, old_value, new_value, rationale)
                            VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const u of updates) {
      const oldVals = {}, newVals = {};
      for (const [c, d] of Object.entries(u.cols)) { oldVals[c] = d.from; newVals[c] = d.to; }
      ins.run(generateId(), cpId, u.entity_type, u.entity_id, 'update', `${u.entity_type}.restore`,
              JSON.stringify(oldVals), JSON.stringify(newVals),
              `[baseline restore] revert ${Object.keys(u.cols).join(', ')} to "${baseline.baseline_name}"`);
    }
    db.exec('COMMIT');
    cp = db.prepare('SELECT * FROM asdlc_change_packet WHERE change_packet_id = ?').get(cpId);
  } catch (err) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: 'Failed to create restore packet: ' + err.message });
  }
  auditLog('asdlc_change_packet', cp.change_packet_id, 'INSERT', null, cp, uid);
  res.status(201).json({ dry_run: false, applied: false, change_packet: cp, item_count: updates.length, plan,
    next: 'Review and approve the packet in the Change Packet Queue to apply the restore.' });
});

app.get('/api/v1/baselines/:id/compare/:otherId', (req, res) => {
  const a = db.prepare('SELECT * FROM asdlc_baseline WHERE baseline_id = ?').get(req.params.id);
  const b = db.prepare('SELECT * FROM asdlc_baseline WHERE baseline_id = ?').get(req.params.otherId);
  if (!a) return res.status(404).json({ error: 'Baseline not found' });
  if (!b) return res.status(404).json({ error: 'Other baseline not found' });

  const meta = {
    baseline_a: { id: a.baseline_id, name: a.baseline_name, record_count: a.record_count, field_count: a.field_count },
    baseline_b: { id: b.baseline_id, name: b.baseline_name, record_count: b.record_count, field_count: b.field_count },
  };

  // Real diff over the captured snapshots (asdlc_baseline_item), keyed by entity_type::entity_id.
  const loadItems = (bid) => {
    const m = new Map();
    for (const it of db.prepare('SELECT entity_type, entity_id, snapshot_value FROM asdlc_baseline_item WHERE baseline_id=?').all(bid))
      m.set(`${it.entity_type}::${it.entity_id}`, it.snapshot_value);
    return m;
  };
  const aItems = loadItems(a.baseline_id);
  const bItems = loadItems(b.baseline_id);

  // Fallback for baselines locked before snapshots were captured: use the header counts.
  if (aItems.size === 0 && bItems.size === 0) {
    const recordDelta = (b.record_count || 0) - (a.record_count || 0);
    const fieldDelta  = (b.field_count  || 0) - (a.field_count  || 0);
    return res.json({ ...meta,
      added_records: Math.max(0, recordDelta), removed_records: Math.max(0, -recordDelta),
      modified_records: 0, modified_fields: Math.abs(fieldDelta), snapshot_based: false,
      note: 'One or both baselines were locked before design snapshots existed — showing a count-based estimate only.' });
  }

  const parse = (s) => { try { return JSON.parse(s) || {}; } catch { return {}; } };
  const added = [], removed = [], modified = [];
  let modifiedFields = 0;
  for (const k of bItems.keys()) if (!aItems.has(k)) added.push(k);
  for (const k of aItems.keys()) if (!bItems.has(k)) removed.push(k);
  for (const [k, bRaw] of bItems) {
    if (!aItems.has(k)) continue;
    const av = parse(aItems.get(k)), bv = parse(bRaw);
    const changed = [];
    for (const f of new Set([...Object.keys(av), ...Object.keys(bv)]))
      if (JSON.stringify(av[f]) !== JSON.stringify(bv[f])) changed.push(f);
    if (changed.length) { modified.push({ entity: k, changed_fields: changed }); modifiedFields += changed.length; }
  }
  res.json({ ...meta,
    added_records: added.length, removed_records: removed.length,
    modified_records: modified.length, modified_fields: modifiedFields,
    snapshot_based: true,
    added: added.slice(0, 100), removed: removed.slice(0, 100), modified: modified.slice(0, 100),
  });
});

// ──────────────────────────────────────────────
// EXCEPTIONS
// ──────────────────────────────────────────────
app.get('/api/v1/exceptions/summary', (req, res) => {
  const { project_id } = req.query;
  let sql = `
    SELECT exception_type, severity, COUNT(*) AS count
    FROM asdlc_exception
    WHERE lifecycle_status = 'active'
  `;
  const params = [];
  if (project_id) { sql += ' AND project_id = ?'; params.push(project_id); }
  sql += ' GROUP BY exception_type, severity ORDER BY exception_type, severity';
  res.json(db.prepare(sql).all(...params));
});

app.get('/api/v1/exceptions', (req, res) => {
  const { project_id, exception_type, status, detected_by, finding_category } = req.query;
  let sql = "SELECT * FROM asdlc_exception WHERE lifecycle_status = 'active'";
  const params = [];
  if (project_id)       { sql += ' AND project_id = ?';        params.push(project_id); }
  if (exception_type)   { sql += ' AND exception_type = ?';    params.push(exception_type); }
  if (status)           { sql += ' AND status = ?';            params.push(status); }
  if (detected_by)      { sql += ' AND detected_by = ?';       params.push(detected_by); }
  if (finding_category) { sql += ' AND finding_category = ?';  params.push(finding_category); }
  sql += ' ORDER BY severity DESC, created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

app.get('/api/v1/exceptions/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM asdlc_exception WHERE exception_id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Exception not found' });
  res.json(row);
});

app.post('/api/v1/exceptions', (req, res) => {
  const { project_id, exception_type, severity, description, related_entity_type, related_entity_id } = req.body;
  if (!project_id || !description || !related_entity_id) {
    return res.status(400).json({ error: 'project_id, description and related_entity_id are required' });
  }
  const id = generateId();
  const uid = userId(req);
  db.prepare(`
    INSERT INTO asdlc_exception
      (exception_id, project_id, exception_type, severity, description,
       related_entity_type, related_entity_id, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, project_id,
    exception_type || 'other',
    severity || 'med',
    description,
    related_entity_type || '',
    related_entity_id,
    uid, uid
  );
  const created = db.prepare('SELECT * FROM asdlc_exception WHERE exception_id = ?').get(id);
  auditLog('asdlc_exception', id, 'INSERT', null, created, uid);
  res.status(201).json(created);
});

app.put('/api/v1/exceptions/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM asdlc_exception WHERE exception_id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Exception not found' });
  const uid = userId(req);
  const { status, severity, description, resolution_summary, assigned_member_id } = req.body;
  db.prepare(`
    UPDATE asdlc_exception
    SET status             = COALESCE(?, status),
        severity           = COALESCE(?, severity),
        description        = COALESCE(?, description),
        resolution_summary = COALESCE(?, resolution_summary),
        assigned_member_id = COALESCE(?, assigned_member_id),
        updated_by         = ?,
        updated_at         = datetime('now'),
        version            = version + 1
    WHERE exception_id = ?
  `).run(status, severity, description, resolution_summary, assigned_member_id, uid, req.params.id);
  const updated = db.prepare('SELECT * FROM asdlc_exception WHERE exception_id = ?').get(req.params.id);
  auditLog('asdlc_exception', req.params.id, 'UPDATE', existing, updated, uid);
  res.json(updated);
});

// ──────────────────────────────────────────────
// MISSING-OWNER VALIDATOR
// ──────────────────────────────────────────────
// Deterministic detector that keeps `missing_owner` exceptions in sync with the
// design. A step's owner is its participant/lane (person role, AI agent, or
// supporting system) = owner_participant_id. The Validation & Exception Queue
// already has a missing_owner type/KPI/filter but nothing populated it, and the
// AI quality-reviewer writes category-typed findings (missing/incomplete/…), not
// the missing_owner type — so this fills that gap. detected_by='owner-validator'
// namespaces these rows so we never disturb manual or quality-reviewer exceptions.
function syncOwnerExceptions(db, projectId, uid) {
  const now = new Date().toISOString();
  let inserted = 0, resolved = 0;

  // Steps that SHOULD have an owner but don't (active steps only).
  const orphanSteps = db.prepare(`
    SELECT s.workflow_step_id, s.slug, s.name, s.step_number, w.name AS workflow_name, w.slug AS workflow_slug
    FROM asdlc_workflow_step s
    LEFT JOIN asdlc_workflow w ON w.workflow_id = s.workflow_id
    WHERE s.project_id = ?
      AND s.owner_participant_id IS NULL
      AND (s.lifecycle_status IS NULL OR s.lifecycle_status NOT IN ('retired', 'deleted'))
  `).all(projectId);
  const orphanIds = new Set(orphanSteps.map(s => s.workflow_step_id));

  // Existing open missing_owner exceptions this validator owns.
  const existing = db.prepare(`
    SELECT exception_id, related_entity_id FROM asdlc_exception
    WHERE project_id = ? AND exception_type = 'missing_owner'
      AND detected_by = 'owner-validator' AND status = 'open'
  `).all(projectId);
  const existingByStep = new Map(existing.map(e => [e.related_entity_id, e.exception_id]));

  // 1) Open/refresh an exception for every current orphan.
  const ins = db.prepare(`INSERT INTO asdlc_exception
      (exception_id, project_id, exception_type, severity, description,
       related_entity_type, related_entity_id, suggested_action, status,
       detected_by, field_name, finding_category, created_by, updated_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?, 'open', 'owner-validator', 'owner_participant_id', 'missing', ?,?,?,?)`);
  for (const s of orphanSteps) {
    if (existingByStep.has(s.workflow_step_id)) continue; // already open — leave as-is
    const id = generateId();
    const where = `${s.workflow_slug || s.workflow_name || 'workflow'} step ${s.slug || ('#' + s.step_number)} "${s.name}"`;
    ins.run(
      id, projectId, 'missing_owner', 'med',
      `${where} has no owning participant (person role, AI agent, or supporting system). It cannot be placed in a swimlane lane or held accountable in RACI.`,
      'workflow_step', s.workflow_step_id,
      'Assign an owner_participant_id — a person role, AI agent, or the supporting system that performs/serves this step.',
      uid || 'owner-validator', uid || 'owner-validator', now, now
    );
    inserted++;
  }

  // 2) Auto-resolve exceptions whose step now has an owner (or was removed).
  const resolveStmt = db.prepare(`UPDATE asdlc_exception
      SET status = 'resolved', resolution_summary = 'auto: owner assigned', updated_at = ?
    WHERE exception_id = ?`);
  for (const e of existing) {
    if (!orphanIds.has(e.related_entity_id)) { resolveStmt.run(now, e.exception_id); resolved++; }
  }

  return { inserted, resolved, open: orphanSteps.length };
}

// Standalone on-demand run (mirrors the quality-reviewer's on-demand philosophy).
app.post('/api/v1/projects/:id/validate/owners', (req, res) => {
  try {
    const counts = syncOwnerExceptions(db, req.params.id, userId(req));
    res.json({ ok: true, ...counts });
  } catch (err) {
    console.error('[validate/owners]', err);
    res.status(500).json({ error: err.message });
  }
});

// One-click deterministic repair: relink orphan requirements + derive swimlane
// structure (participants, step owners, sequential paths) for every workflow.
// Idempotent — heals projects ingested before the apply-time fix existed.
app.post('/api/v1/projects/:id/repair-design', async (req, res) => {
  const uid = userId(req);
  const projectId = req.params.id;
  db.exec('BEGIN');
  let summary;
  try {
    summary = repairProjectDesign(projectId, uid);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('[repair-design]', err);
    return res.status(500).json({ error: err.message });
  }
  // Refresh missing-owner exceptions now that owners may have been assigned (own txn).
  try { syncOwnerExceptions(db, projectId, uid); } catch { /* non-fatal */ }

  // AI RASIC inference for all workflows in the project — runs AFTER transaction commits
  // (Claude calls must not run inside the DB txn). Skips workflows that already have
  // RASIC rows so manual edits are never overwritten.
  let rasicCells = 0;
  try {
    const { inferRasicMatrix } = require('./agent/rasic-deriver');
    const wfIds = db.prepare(
      "SELECT workflow_id FROM asdlc_workflow WHERE project_id = ? AND (lifecycle_status IS NULL OR lifecycle_status != 'retired')"
    ).all(projectId).map(r => r.workflow_id);
    if (wfIds.length) {
      const results = await Promise.allSettled(wfIds.map(id => inferRasicMatrix(id, projectId, uid)));
      rasicCells = results.reduce((sum, r) => sum + (r.status === 'fulfilled' ? (r.value.cellsCreated || 0) : 0), 0);
    }
  } catch (err) {
    console.error('[repair-design] RASIC inference failed (non-fatal):', err.message);
  }

  res.json({ ok: true, ...summary, rasicCells });
});

// Re-materialize CPIs that were previously marked as 'supporting evidence' for an
// entity type that was non-materializable at the time of approval but is now
// materializable. The db.js data migration resets their applied_at; this endpoint
// re-runs applyChangePacket on the affected parent CPs (idempotent — already-applied
// items are skipped, only the newly-reset ones are processed).
app.post('/api/v1/projects/:id/repair-stuck-cpis', (req, res) => {
  const uid = userId(req);
  const projectId = req.params.id;
  const materializableTypes = Object.values(registry.byEntityType)
    .filter(e => e.materializable)
    .map(e => e.entity_type);
  if (materializableTypes.length === 0) return res.json({ ok: true, reapplied: 0, cps: [] });

  const placeholders = materializableTypes.map(() => '?').join(',');
  const stuckCpIds = db.prepare(`
    SELECT DISTINCT i.change_packet_id
    FROM asdlc_change_packet_item i
    JOIN asdlc_change_packet cp ON cp.change_packet_id = i.change_packet_id
    WHERE cp.project_id = ?
      AND i.applied_at IS NULL
      AND i.entity_type IN (${placeholders})
  `).all(projectId, ...materializableTypes).map(r => r.change_packet_id);

  if (stuckCpIds.length === 0) return res.json({ ok: true, reapplied: 0, cps: [] });

  const totals = { applied: 0, updated: 0, deleted: 0, errors: [] };
  const processed = [];
  for (const cpId of stuckCpIds) {
    db.exec('BEGIN');
    try {
      const r = applyChangePacket(cpId, uid);
      db.exec('COMMIT');
      totals.applied  += r.applied;
      totals.updated  += r.updated;
      totals.deleted  += r.deleted;
      totals.errors.push(...r.errors);
      processed.push({ cpId, applied: r.applied, updated: r.updated, deleted: r.deleted, errors: r.errors });
      console.log(`[repair-stuck-cpis] cp=${cpId} applied=${r.applied} updated=${r.updated}`);
    } catch (err) {
      db.exec('ROLLBACK');
      console.error('[repair-stuck-cpis]', cpId, err);
      totals.errors.push({ cpId, reason: err.message });
      processed.push({ cpId, error: err.message });
    }
  }
  res.json({ ok: true, ...totals, cps: processed });
});

// ──────────────────────────────────────────────
// QUALITY REVIEWER (Feature #9)
// ──────────────────────────────────────────────
// Reviewer is on-demand only. Two entry points:
//   POST /api/v1/projects/:id/quality-review/entity/:type/:id   (delta)
//   POST /api/v1/projects/:id/quality-review/full               (whole Application)
// Both write findings to asdlc_exception with detected_by='quality-reviewer'.
app.post('/api/v1/projects/:id/quality-review/entity/:entityType/:entityId', async (req, res) => {
  const { id: projectId, entityType, entityId } = req.params;
  try {
    const { reviewEntity, applyFindings } = require('./agent/quality-reviewer');
    const result = await reviewEntity({ projectId, entityType, entityId, db });
    const counts = applyFindings(db, projectId, entityType, entityId, result.findings);
    res.json({
      findings: result.findings,
      counts,
      model: result.model,
      source: result.source,
      error: result.error,
    });
  } catch (err) {
    console.error('[quality-review/entity]', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/v1/projects/:id/quality-review/full', async (req, res) => {
  const { id: projectId } = req.params;
  try {
    const { reviewApplication } = require('./agent/quality-reviewer');
    const result = await reviewApplication({ projectId, db });
    // Deterministic owner check runs alongside the AI review (the AI emits
    // category-typed findings, not the missing_owner type the queue filters on).
    const owners = syncOwnerExceptions(db, projectId, userId(req));
    res.json({ ...result, missing_owners: owners });
  } catch (err) {
    console.error('[quality-review/full]', err);
    res.status(500).json({ error: err.message });
  }
});

// Backfill requirement→element traceability links via AI inference. Proposes
// links (status='proposed', source='agent_ingest') that don't already exist.
app.post('/api/v1/projects/:id/traceability/infer', async (req, res) => {
  const projectId = req.params.id;
  const uid = userId(req);
  try {
    const { inferLinks } = require('./agent/traceability');
    const result = await inferLinks({ projectId, db });
    let created = 0, skipped = 0;
    for (const l of result.links) {
      const em = LINK_ENTITY_META[l.entity_type];
      if (!em) { skipped++; continue; }
      // Derive requirement type from the slug prefix (NFR-### vs FR-###).
      const isNfr = l.req_slug.toUpperCase().startsWith('NFR');
      const reqTable = isNfr ? 'asdlc_nonfunctional_req' : 'asdlc_functional_req';
      const reqType  = isNfr ? 'nonfunctional' : 'functional';
      const reqIdCol = isNfr ? 'nfr_id' : 'fr_id';
      const reqRow = db.prepare(`SELECT ${reqIdCol} AS id FROM ${reqTable} WHERE project_id=? AND slug=?`).get(projectId, l.req_slug);
      const entRow = db.prepare(`SELECT ${em.idCol} AS id FROM ${em.table} WHERE project_id=? AND slug=?`).get(projectId, l.entity_slug);
      if (!reqRow || !entRow) { skipped++; continue; }
      const dup = db.prepare(
        "SELECT 1 FROM asdlc_requirement_link WHERE project_id=? AND req_type=? AND req_id=? AND entity_type=? AND entity_id=? AND lifecycle_status='active'"
      ).get(projectId, reqType, reqRow.id, l.entity_type, entRow.id);
      if (dup) { skipped++; continue; }
      const linkId = generateId();
      db.prepare(`INSERT INTO asdlc_requirement_link
        (link_id, project_id, req_type, req_id, entity_type, entity_id, relationship, confidence, status, source, created_by, updated_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(linkId, projectId, reqType, reqRow.id, l.entity_type, entRow.id, 'implements', l.confidence, 'proposed', 'agent_ingest', uid, uid);
      auditLog('asdlc_requirement_link', linkId, 'INSERT', null,
        db.prepare('SELECT * FROM asdlc_requirement_link WHERE link_id=?').get(linkId), uid);
      created++;
    }
    res.json({ proposed: result.links.length, created, skipped, model: result.model, source: result.source, error: result.error });
  } catch (err) {
    console.error('[traceability/infer]', err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// CHANGE PACKETS — audit trail UI endpoints (Feature #9)
// ──────────────────────────────────────────────
// Read-only browse + drill-in. CPs are still created by createAutoApprovedCP()
// from the entity PUT paths; these endpoints just surface them.
app.get('/api/v1/projects/:id/change-packets', (req, res) => {
  const projectId = req.params.id;
  const limit  = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const q      = (req.query.q || '').trim();

  // Pull the CPs first
  let cpSql = `SELECT change_packet_id, packet_code, summary, status, risk_level,
                      conflict_classification, baseline_impacting,
                      authoring_agent_run_id, approver_member_id,
                      created_at, updated_at
                 FROM asdlc_change_packet
                WHERE lifecycle_status = 'active' AND project_id = ?`;
  const params = [projectId];
  if (q) {
    cpSql += ` AND (LOWER(summary) LIKE ? OR change_packet_id IN
                   (SELECT cpi.change_packet_id FROM asdlc_change_packet_item cpi
                     WHERE LOWER(cpi.entity_id) LIKE ? OR LOWER(cpi.entity_type) LIKE ?))`;
    const like = `%${q.toLowerCase()}%`;
    params.push(like, like, like);
  }
  cpSql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const cps = db.prepare(cpSql).all(...params);

  if (cps.length === 0) return res.json([]);

  // Bulk-load items for the returned CPs
  const ids = cps.map(c => c.change_packet_id);
  const placeholders = ids.map(() => '?').join(',');
  const items = db.prepare(
    `SELECT change_packet_id, entity_type, entity_id, field_path
       FROM asdlc_change_packet_item
      WHERE change_packet_id IN (${placeholders})`
  ).all(...ids);

  const byCp = {};
  for (const it of items) (byCp[it.change_packet_id] ||= []).push(it);

  res.json(cps.map(cp => ({
    ...cp,
    items: byCp[cp.change_packet_id] || [],
    entity_count: new Set((byCp[cp.change_packet_id] || []).map(i => `${i.entity_type}/${i.entity_id}`)).size,
  })));
});

app.get('/api/v1/change-packets/:cpId', (req, res) => {
  const cp = db.prepare(
    `SELECT * FROM asdlc_change_packet WHERE change_packet_id = ?`
  ).get(req.params.cpId);
  if (!cp) return res.status(404).json({ error: 'Change packet not found' });
  const items = db.prepare(
    `SELECT * FROM asdlc_change_packet_item WHERE change_packet_id = ?`
  ).all(req.params.cpId);
  res.json({ ...cp, items });
});

// ──────────────────────────────────────────────
// REPORTS
// ──────────────────────────────────────────────
app.get('/api/v1/reports', (req, res) => {
  const { project_id } = req.query;
  let sql = "SELECT * FROM asdlc_report_export WHERE lifecycle_status = 'active'";
  const params = [];
  if (project_id) { sql += ' AND project_id = ?'; params.push(project_id); }
  sql += ' ORDER BY generated_at DESC';
  res.json(db.prepare(sql).all(...params));
});

app.get('/api/v1/reports/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM asdlc_report_export WHERE report_export_id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Report not found' });
  res.json(row);
});

app.post('/api/v1/reports', (req, res) => {
  const { project_id, report_type, format, audience, title, baseline_id } = req.body;
  if (!project_id || !report_type || !title) {
    return res.status(400).json({ error: 'project_id, report_type and title are required' });
  }
  const id = generateId();
  const uid = userId(req);
  db.prepare(`
    INSERT INTO asdlc_report_export
      (report_export_id, project_id, report_type, format, audience, title, baseline_id,
       generated_at, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)
  `).run(id, project_id, report_type, format || 'docx', audience || 'reviewer', title, baseline_id || null, uid, uid);
  const created = db.prepare('SELECT * FROM asdlc_report_export WHERE report_export_id = ?').get(id);
  auditLog('asdlc_report_export', id, 'INSERT', null, created, uid);
  res.status(201).json(created);
});

// ──────────────────────────────────────────────
// USE CASES
// ──────────────────────────────────────────────
app.get('/api/v1/projects/:id/use-cases', (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM asdlc_use_case WHERE project_id = ? AND lifecycle_status != 'deleted' ORDER BY updated_at DESC"
  ).all(req.params.id);
  res.json(parseRows(rows));
});

app.get('/api/v1/projects/:id/use-cases/:ucId', (req, res) => {
  const row = db.prepare(
    'SELECT * FROM asdlc_use_case WHERE use_case_id = ? AND project_id = ?'
  ).get(req.params.ucId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Use case not found' });
  res.json(parseRow(row));
});

app.post('/api/v1/projects/:id/use-cases', (req, res) => {
  const { title, summary, business_objective, lifecycle_status } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });
  const id = generateId();
  const uid = userId(req);
  const slug = nextSlug('asdlc_use_case', 'UC', req.params.id);
  db.prepare(`
    INSERT INTO asdlc_use_case
      (use_case_id, project_id, slug, title, summary, business_objective, lifecycle_status, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.params.id, slug, title, summary || '', business_objective || '', lifecycle_status || 'draft', uid, uid);
  const created = db.prepare('SELECT * FROM asdlc_use_case WHERE use_case_id = ?').get(id);
  auditLog('asdlc_use_case', id, 'INSERT', null, created, uid);
  res.status(201).json(parseRow(created));
});

// ──────────────────────────────────────────────
// DIRECT-EDIT HELPERS (auto-approved Change Packets)
// ──────────────────────────────────────────────

/**
 * Create an auto-approved Change Packet for a direct design edit.
 * Records who made the change and when, bumps project integer version.
 */
function createAutoApprovedCP(projectId, entityType, entityId, entityLabel, diffItems, uid) {
  const cpId   = generateId();
  const short  = Date.now().toString(36).toUpperCase().slice(-6);
  const cpCode = `EDIT-${short}`;
  const summary = `Direct edit: ${entityLabel}`;

  db.prepare(`
    INSERT INTO asdlc_change_packet
      (change_packet_id, project_id, packet_code, status, summary,
       conflict_classification, baseline_impacting, validation_status,
       approval_timestamp, created_by, updated_by)
    VALUES (?, ?, ?, 'approved', ?, 'update', 0, 'unverified', datetime('now'), ?, ?)
  `).run(cpId, projectId, cpCode, summary, uid, uid);

  diffItems.forEach(item => {
    const itemId = generateId();
    db.prepare(`
      INSERT INTO asdlc_change_packet_item
        (change_packet_item_id, change_packet_id, entity_type, entity_id,
         field_path, old_value, new_value)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(itemId, cpId, entityType, entityId, item.field,
           item.old_value != null ? JSON.stringify(item.old_value) : null,
           item.new_value != null ? JSON.stringify(item.new_value) : 'null');
  });

  // Bump project integer version (semantic version only touched by mass-approve)
  db.prepare(`
    UPDATE asdlc_project SET version = version + 1,
      updated_at = datetime('now'), updated_by = ?
    WHERE project_id = ?
  `).run(uid, projectId);

  const cpAfter = db.prepare('SELECT * FROM asdlc_change_packet WHERE change_packet_id = ?').get(cpId);
  auditLog('asdlc_change_packet', cpId, 'INSERT', null, cpAfter, uid);

  return { cpId, cpCode };
}

/**
 * Build a field-level diff between an existing DB row and an updates object.
 * jsonCols: list of column names that hold JSON (compared by normalised string).
 */
function diffFields(existing, updates, jsonCols) {
  const diff = [];
  for (const [field, newRaw] of Object.entries(updates)) {
    const oldRaw = existing[field] !== undefined ? existing[field] : null;
    const toStr = (v, isJson) => {
      if (v === null || v === undefined) return '';
      if (isJson) return typeof v === 'string' ? v : JSON.stringify(v);
      return String(v);
    };
    const isJson = jsonCols.includes(field);
    if (toStr(oldRaw, isJson) !== toStr(newRaw, isJson)) {
      diff.push({ field, old_value: oldRaw, new_value: newRaw });
    }
  }
  return diff;
}

// PUT /api/v1/projects/:id/use-cases/:ucId
app.put('/api/v1/projects/:id/use-cases/:ucId', (req, res) => {
  const uid = userId(req);
  const existing = db.prepare('SELECT * FROM asdlc_use_case WHERE use_case_id = ? AND project_id = ?')
    .get(req.params.ucId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Use case not found' });

  const ALLOWED = ['title', 'summary', 'business_objective', 'expected_value',
                   'success_criteria', 'constraints_list', 'readiness', 'supervision_model',
                   'volume_assumptions',
                   // Phase 1 additions (Decisions #2, #4, #6, #7, #17):
                   'risk_tier', 'owner', 'primary_success_metric',
                   'epic_or_feature_id', 'baseline_cost_annual_usd'];
  const JSON_UC = ['success_criteria', 'constraints_list', 'volume_assumptions'];
  // Object-shaped JSON columns get DEEP-MERGED with the existing row so a partial
  // update (e.g. {volume_assumptions: {monthly_requests: 5000}}) doesn't clobber
  // other keys already in the JSON. Array-shaped JSON columns are replaced as-is.
  const JSON_UC_MERGE = new Set(['volume_assumptions']);
  const updates = {};
  ALLOWED.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
  // For merge-shaped JSON fields, fold the incoming object onto the existing one
  // BEFORE serializing. Frontend already does this, but the safety net protects
  // direct API callers and the auto-propagation path below.
  JSON_UC_MERGE.forEach(f => {
    if (updates[f] !== undefined && typeof updates[f] === 'object' && !Array.isArray(updates[f])) {
      let existingObj = {};
      try {
        const parsed = JSON.parse(existing[f] || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existingObj = parsed;
      } catch { /* keep empty */ }
      updates[f] = { ...existingObj, ...updates[f] };
    }
  });
  // Serialise JSON fields
  JSON_UC.forEach(f => { if (updates[f] !== undefined && typeof updates[f] !== 'string') updates[f] = JSON.stringify(updates[f]); });

  // Phase 1 enum validation (Decisions #2, #4)
  try {
    if (updates.risk_tier !== undefined)         validateEnum(updates.risk_tier, ENUMS.risk_tier, 'risk_tier');
    if (updates.supervision_model !== undefined) validateEnum(updates.supervision_model, ENUMS.supervision_model_3val, 'supervision_model');
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No updatable fields provided' });

  const diff = diffFields(existing, updates, JSON_UC);

  const setClauses = Object.keys(updates).map(f => `${f} = ?`).join(', ');
  db.prepare(`UPDATE asdlc_use_case SET ${setClauses}, updated_at = datetime('now'), updated_by = ?
    WHERE use_case_id = ?`).run(...Object.values(updates), uid, req.params.ucId);

  const after = db.prepare('SELECT * FROM asdlc_use_case WHERE use_case_id = ?').get(req.params.ucId);
  auditLog('asdlc_use_case', req.params.ucId, 'UPDATE', existing, after, uid);

  // Phase 4: auto-propagate UC.volume_assumptions.monthly_requests → child workflows.runs_per_period
  // so editing the volume on the UC drives the cost recalculation. Triggered only when the value
  // actually changed (skip no-op edits to notes/peak fields).
  let propagatedWorkflows = 0;
  try {
    const prevVol = (() => { try { return JSON.parse(existing.volume_assumptions || '{}'); } catch { return {}; } })();
    const newVol  = (() => { try { return JSON.parse(after.volume_assumptions    || '{}'); } catch { return {}; } })();
    const newMonthly  = Number(newVol.monthly_requests);
    const prevMonthly = Number(prevVol.monthly_requests);
    if (Number.isFinite(newMonthly) && newMonthly > 0 && newMonthly !== prevMonthly) {
      const r = db.prepare(`UPDATE asdlc_workflow
                            SET runs_per_period = ?, updated_at = datetime('now'), updated_by = ?
                            WHERE use_case_id = ?`).run(newMonthly, uid, req.params.ucId);
      propagatedWorkflows = r.changes;
    }
  } catch (err) {
    console.error('[uc PUT] volume propagation failed:', err.message);
  }

  let cpResult = null;
  if (diff.length > 0) {
    cpResult = createAutoApprovedCP(req.params.id, 'use_case', req.params.ucId,
      existing.title, diff, uid);
  }

  const reviewQueued = reviewQueue.maybeEnqueueReview({
    projectId: req.params.id, entityType: 'use_case', entityId: req.params.ucId,
    changedFields: diff.map(d => d.field),
  });

  res.json({ ...parseRow(after), _cp: cpResult, _propagated_workflows: propagatedWorkflows, _review_queued: reviewQueued });
});

// ──────────────────────────────────────────────
// WORKFLOWS
// ──────────────────────────────────────────────
app.get('/api/v1/projects/:id/workflows', (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM asdlc_workflow WHERE project_id = ? AND lifecycle_status != 'deleted' ORDER BY updated_at DESC"
  ).all(req.params.id);
  res.json(parseRows(rows));
});

app.get('/api/v1/projects/:id/workflows/:wfId', (req, res) => {
  const wf = db.prepare(
    'SELECT * FROM asdlc_workflow WHERE workflow_id = ? AND project_id = ?'
  ).get(req.params.wfId, req.params.id);
  if (!wf) return res.status(404).json({ error: 'Workflow not found' });
  const steps = db.prepare(
    'SELECT * FROM asdlc_workflow_step WHERE workflow_id = ? ORDER BY step_number'
  ).all(req.params.wfId);
  res.json({ ...parseRow(wf), steps: parseRows(steps) });
});

// PUT /api/v1/projects/:id/workflows/:wfId
app.put('/api/v1/projects/:id/workflows/:wfId', (req, res) => {
  const uid = userId(req);
  const existing = db.prepare('SELECT * FROM asdlc_workflow WHERE workflow_id = ? AND project_id = ?')
    .get(req.params.wfId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Workflow not found' });

  const ALLOWED = ['name', 'sla_hours', 'readiness', 'trigger_def',
                   'handoffs', 'decisions', 'fallback_paths',
                   // Phase 1 additions (Decisions #12, #17):
                   'risk_tier', 'runs_per_period'];
  const JSON_WF = ['trigger_def', 'handoffs', 'decisions', 'fallback_paths'];
  const updates = {};
  ALLOWED.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
  JSON_WF.forEach(f => { if (updates[f] !== undefined && typeof updates[f] !== 'string') updates[f] = JSON.stringify(updates[f]); });

  // Phase 1 enum validation
  try {
    if (updates.risk_tier !== undefined) validateEnum(updates.risk_tier, ENUMS.risk_tier, 'risk_tier');
    // Validate trigger_def.type (app-level since SQLite can't CHECK inside JSON)
    if (updates.trigger_def !== undefined) {
      let triggerObj;
      try { triggerObj = typeof updates.trigger_def === 'string' ? JSON.parse(updates.trigger_def) : updates.trigger_def; } catch { triggerObj = null; }
      if (triggerObj && triggerObj.type) {
        validateEnum(triggerObj.type, ENUMS.trigger_type_6val, 'trigger_def.type');
      }
    }
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No updatable fields provided' });

  const diff = diffFields(existing, updates, JSON_WF);
  const setClauses = Object.keys(updates).map(f => `${f} = ?`).join(', ');
  db.prepare(`UPDATE asdlc_workflow SET ${setClauses}, updated_at = datetime('now'), updated_by = ?
    WHERE workflow_id = ?`).run(...Object.values(updates), uid, req.params.wfId);

  const after = db.prepare('SELECT * FROM asdlc_workflow WHERE workflow_id = ?').get(req.params.wfId);
  auditLog('asdlc_workflow', req.params.wfId, 'UPDATE', existing, after, uid);

  let cpResult = null;
  if (diff.length > 0) {
    cpResult = createAutoApprovedCP(req.params.id, 'workflow', req.params.wfId,
      existing.name, diff, uid);
  }

  const reviewQueued = reviewQueue.maybeEnqueueReview({
    projectId: req.params.id, entityType: 'workflow', entityId: req.params.wfId,
    changedFields: diff.map(d => d.field),
  });

  res.json({ ...parseRow(after), _cp: cpResult, _review_queued: reviewQueued });
});

// PUT /api/v1/projects/:id/workflows/:wfId/steps/:stepId
app.put('/api/v1/projects/:id/workflows/:wfId/steps/:stepId', (req, res) => {
  const uid = userId(req);
  const existing = db.prepare(
    'SELECT * FROM asdlc_workflow_step WHERE workflow_step_id = ? AND workflow_id = ? AND project_id = ?'
  ).get(req.params.stepId, req.params.wfId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Workflow step not found' });

  const ALLOWED = ['name', 'actor_role', 'sla_hours', 'decisions_list',
                   // Phase 1 additions (Decision #12):
                   'step_type', 'step_purpose', 'preconditions',
                   'evidence_captured', 'is_end_step',
                   // Phase 2 addition (Decision #12 FK):
                   'owner_participant_id'];
  const JSON_STEP = ['decisions_list'];
  const updates = {};
  ALLOWED.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

  JSON_STEP.forEach(f => {
    if (updates[f] !== undefined && typeof updates[f] !== 'string') updates[f] = JSON.stringify(updates[f]);
  });

  // Phase 1 enum validation
  try {
    if (updates.step_type !== undefined) validateEnum(updates.step_type, ENUMS.step_type, 'step_type');
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No updatable fields provided' });

  const diff = diffFields(existing, updates, JSON_STEP);
  const setClauses = Object.keys(updates).map(f => `${f} = ?`).join(', ');
  db.prepare(
    `UPDATE asdlc_workflow_step SET ${setClauses}, updated_at = datetime('now'), updated_by = ? WHERE workflow_step_id = ?`
  ).run(...Object.values(updates), uid, req.params.stepId);

  const updated = db.prepare('SELECT * FROM asdlc_workflow_step WHERE workflow_step_id = ?').get(req.params.stepId);

  let cpResult = null;
  if (diff.length > 0) {
    cpResult = createAutoApprovedCP(req.params.id, 'workflow_step', req.params.stepId,
      `Step "${existing.name}"`, diff, uid);
  }

  const reviewQueued = reviewQueue.maybeEnqueueReview({
    projectId: req.params.id, entityType: 'workflow_step', entityId: req.params.stepId,
    changedFields: diff.map(d => d.field),
  });

  res.json({ ...updated, decisions: parseJson(updated.decisions_list) || [], _cp: cpResult, _review_queued: reviewQueued });
});

// ──────────────────────────────────────────────
// AGENT SPECS (CRUD)
// ──────────────────────────────────────────────
app.get('/api/v1/projects/:id/agent-specs', (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM asdlc_agent_spec WHERE project_id = ? AND lifecycle_status != 'deleted' ORDER BY name"
  ).all(req.params.id);
  res.json(parseRows(rows));
});

app.get('/api/v1/projects/:id/agent-specs/:agentId', (req, res) => {
  const row = db.prepare('SELECT * FROM asdlc_agent_spec WHERE agent_spec_id = ? AND project_id = ?')
    .get(req.params.agentId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Agent spec not found' });
  res.json(parseRow(row));
});

// PUT /api/v1/projects/:id/agent-specs/:agentId
app.put('/api/v1/projects/:id/agent-specs/:agentId', (req, res) => {
  const uid = userId(req);
  const existing = db.prepare('SELECT * FROM asdlc_agent_spec WHERE agent_spec_id = ? AND project_id = ?')
    .get(req.params.agentId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Agent spec not found' });

  const ALLOWED = ['name', 'scope', 'instructions', 'goals', 'done_criteria',
                   'memory_strategy', 'design_risks', 'run_as_model',
                   // Phase 1 additions (Decisions #2, #16, #17, #18):
                   'supervision_model', 'maintenance_owner', 'orchestration_strategy',
                   'latency_target', 'post_release_validation', 'cost_model'];
  const JSON_AG = ['goals', 'done_criteria', 'design_risks', 'inputs', 'outputs', 'run_as_model'];
  const updates = {};
  ALLOWED.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
  JSON_AG.forEach(f => { if (updates[f] !== undefined && typeof updates[f] !== 'string') updates[f] = JSON.stringify(updates[f]); });

  // Phase 1 enum validation
  try {
    if (updates.supervision_model !== undefined)      validateEnum(updates.supervision_model, ENUMS.supervision_model_3val, 'supervision_model');
    if (updates.orchestration_strategy !== undefined) validateEnum(updates.orchestration_strategy, ENUMS.orchestration_strategy, 'orchestration_strategy');
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No updatable fields provided' });

  const diff = diffFields(existing, updates, JSON_AG);
  const setClauses = Object.keys(updates).map(f => `${f} = ?`).join(', ');
  db.prepare(`UPDATE asdlc_agent_spec SET ${setClauses}, updated_at = datetime('now'), updated_by = ?
    WHERE agent_spec_id = ?`).run(...Object.values(updates), uid, req.params.agentId);

  const after = db.prepare('SELECT * FROM asdlc_agent_spec WHERE agent_spec_id = ?').get(req.params.agentId);
  auditLog('asdlc_agent_spec', req.params.agentId, 'UPDATE', existing, after, uid);

  let cpResult = null;
  if (diff.length > 0) {
    cpResult = createAutoApprovedCP(req.params.id, 'agent_spec', req.params.agentId,
      existing.name, diff, uid);
  }

  const reviewQueued = reviewQueue.maybeEnqueueReview({
    projectId: req.params.id, entityType: 'agent_spec', entityId: req.params.agentId,
    changedFields: diff.map(d => d.field),
  });

  res.json({ ...parseRow(after), _cp: cpResult, _review_queued: reviewQueued });
});

// POST /api/v1/projects/:id/agent-specs/:agentId/draft-prompt
// Generate a starting system prompt for an Agent via Claude (or a templated stub
// when ANTHROPIC_API_KEY is missing). Does NOT auto-save — caller decides whether
// to PUT the returned draft into the agent's `instructions` field.
app.post('/api/v1/projects/:id/agent-specs/:agentId/draft-prompt', async (req, res) => {
  const agent = db.prepare(
    'SELECT * FROM asdlc_agent_spec WHERE agent_spec_id = ? AND project_id = ?'
  ).get(req.params.agentId, req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent spec not found' });

  const ctx = buildAgentPromptCtx(agent);

  try {
    const { draftAgentSystemPrompt } = require('./agent/prompt-drafter');
    const result = await draftAgentSystemPrompt(ctx);
    // Cost visibility: record the draft call's token usage like every other AI path.
    if (result.usage) {
      aiConfig.logUsage({ projectId: req.params.id, source: 'prompt_drafter', refId: req.params.agentId, model: result.model, usage: result.usage });
    }
    res.json(result); // { draft, model, source, usage, [error] }
  } catch (err) {
    console.error('[draft-prompt] failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// PHASE 3 — AGENT ↔ USE CASE (M:N join)
// ──────────────────────────────────────────────

// POST /api/v1/projects/:id/agents/:agentId/use-cases  — link a UC to this agent
app.post('/api/v1/projects/:id/agents/:agentId/use-cases', (req, res) => {
  const uid = userId(req);
  const { use_case_id, business_value, notes } = req.body || {};
  if (!use_case_id) return res.status(400).json({ error: 'use_case_id is required' });

  const agent = db.prepare('SELECT * FROM asdlc_agent_spec WHERE agent_spec_id = ? AND project_id = ?')
    .get(req.params.agentId, req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const uc = db.prepare('SELECT * FROM asdlc_use_case WHERE use_case_id = ? AND project_id = ?')
    .get(use_case_id, req.params.id);
  if (!uc) return res.status(404).json({ error: 'Use case not found in this project' });

  const existing = db.prepare('SELECT * FROM asdlc_agent_use_case WHERE agent_spec_id = ? AND use_case_id = ?')
    .get(req.params.agentId, use_case_id);
  if (existing) return res.status(409).json({ error: 'Agent is already linked to this use case' });

  const aucId = generateId();
  db.prepare(`INSERT INTO asdlc_agent_use_case
    (agent_use_case_id, agent_spec_id, use_case_id, project_id, business_value, notes, created_by, updated_by)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(aucId, req.params.agentId, use_case_id, req.params.id,
         business_value || null, notes || null, uid, uid);

  const row = db.prepare('SELECT * FROM asdlc_agent_use_case WHERE agent_use_case_id = ?').get(aucId);
  auditLog('asdlc_agent_use_case', aucId, 'INSERT', null, row, uid);
  res.status(201).json({ agent_use_case_id: aucId, agent_spec_id: req.params.agentId,
    use_case_id, business_value: row.business_value, notes: row.notes });
});

// DELETE /api/v1/projects/:id/agents/:agentId/use-cases/:aucId
app.delete('/api/v1/projects/:id/agents/:agentId/use-cases/:aucId', (req, res) => {
  const uid = userId(req);
  const row = db.prepare(
    'SELECT * FROM asdlc_agent_use_case WHERE agent_use_case_id = ? AND agent_spec_id = ? AND project_id = ?'
  ).get(req.params.aucId, req.params.agentId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Agent–use case link not found' });

  db.prepare('DELETE FROM asdlc_agent_use_case WHERE agent_use_case_id = ?').run(req.params.aucId);
  auditLog('asdlc_agent_use_case', req.params.aucId, 'DELETE', row, null, uid);
  res.json({ deleted: true });
});

// ──────────────────────────────────────────────
// PHASE 3 — AGENT ↔ TOOL bindings
// ──────────────────────────────────────────────

// POST /api/v1/projects/:id/agents/:agentId/tools  — add a tool binding
app.post('/api/v1/projects/:id/agents/:agentId/tools', (req, res) => {
  const uid = userId(req);
  const { tool_id, purpose, fallback_behavior, binding_supervision_model,
          tool_execution_mode, linked_user_story_refs, details } = req.body || {};
  if (!tool_id) return res.status(400).json({ error: 'tool_id is required' });

  const SUPERVISION_MODELS = ['Supervised', 'Autonomous'];
  const EXECUTION_MODES    = ['Autonomous', 'Human-permission required'];
  if (binding_supervision_model && !SUPERVISION_MODELS.includes(binding_supervision_model))
    return res.status(400).json({ error: `binding_supervision_model must be one of: ${SUPERVISION_MODELS.join(', ')}` });
  if (tool_execution_mode && !EXECUTION_MODES.includes(tool_execution_mode))
    return res.status(400).json({ error: `tool_execution_mode must be one of: ${EXECUTION_MODES.join(', ')}` });

  const agent = db.prepare('SELECT * FROM asdlc_agent_spec WHERE agent_spec_id = ? AND project_id = ?')
    .get(req.params.agentId, req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  // Tool must belong to this project OR be a broader-scope tool accessible to the project
  const tool = db.prepare(
    "SELECT * FROM asdlc_tool WHERE tool_id = ? AND (project_id = ? OR visibility_scope IN ('GLOBAL','ORGANIZATION','PROGRAM')) AND lifecycle_status = 'active'"
  ).get(tool_id, req.params.id);
  if (!tool) return res.status(404).json({ error: 'Tool not found or not accessible to this project' });

  const existing = db.prepare('SELECT * FROM asdlc_agent_tool WHERE agent_spec_id = ? AND tool_id = ?')
    .get(req.params.agentId, tool_id);
  if (existing) return res.status(409).json({ error: 'Tool is already bound to this agent' });

  const atId = generateId();
  db.prepare(`INSERT INTO asdlc_agent_tool
    (agent_tool_id, agent_spec_id, tool_id, project_id, purpose, fallback_behavior,
     binding_supervision_model, tool_execution_mode, linked_user_story_refs, details,
     created_by, updated_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(atId, req.params.agentId, tool_id, req.params.id,
         purpose || null, fallback_behavior || null,
         binding_supervision_model || null, tool_execution_mode || null,
         linked_user_story_refs || null, details || null, uid, uid);

  const row = db.prepare('SELECT * FROM asdlc_agent_tool WHERE agent_tool_id = ?').get(atId);
  auditLog('asdlc_agent_tool', atId, 'INSERT', null, row, uid);
  res.status(201).json({ agent_tool_id: atId, tool_name: tool.name, tool_slug: tool.slug, ...row });
});

// PUT /api/v1/projects/:id/agents/:agentId/tools/:atId  — edit a binding
app.put('/api/v1/projects/:id/agents/:agentId/tools/:atId', (req, res) => {
  const uid = userId(req);
  const existing = db.prepare(
    'SELECT * FROM asdlc_agent_tool WHERE agent_tool_id = ? AND agent_spec_id = ? AND project_id = ?'
  ).get(req.params.atId, req.params.agentId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Tool binding not found' });

  const ALLOWED = ['purpose', 'fallback_behavior', 'binding_supervision_model',
                   'tool_execution_mode', 'linked_user_story_refs', 'details'];
  const SUPERVISION_MODELS = ['Supervised', 'Autonomous'];
  const EXECUTION_MODES    = ['Autonomous', 'Human-permission required'];

  const updates = {};
  for (const key of ALLOWED) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) updates[key] = req.body[key];
  }
  if (!Object.keys(updates).length) return res.json({ changed: false, message: 'no changes detected' });
  if (updates.binding_supervision_model && !SUPERVISION_MODELS.includes(updates.binding_supervision_model))
    return res.status(400).json({ error: `binding_supervision_model must be one of: ${SUPERVISION_MODELS.join(', ')}` });
  if (updates.tool_execution_mode && !EXECUTION_MODES.includes(updates.tool_execution_mode))
    return res.status(400).json({ error: `tool_execution_mode must be one of: ${EXECUTION_MODES.join(', ')}` });

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE asdlc_agent_tool SET ${setClauses}, updated_at = datetime('now'), updated_by = ?
    WHERE agent_tool_id = ?`).run(...Object.values(updates), uid, req.params.atId);

  const after = db.prepare('SELECT * FROM asdlc_agent_tool WHERE agent_tool_id = ?').get(req.params.atId);
  auditLog('asdlc_agent_tool', req.params.atId, 'UPDATE', existing, after, uid);
  res.json({ changed: true, agent_tool_id: req.params.atId });
});

// DELETE /api/v1/projects/:id/agents/:agentId/tools/:atId
app.delete('/api/v1/projects/:id/agents/:agentId/tools/:atId', (req, res) => {
  const uid = userId(req);
  const row = db.prepare(
    'SELECT * FROM asdlc_agent_tool WHERE agent_tool_id = ? AND agent_spec_id = ? AND project_id = ?'
  ).get(req.params.atId, req.params.agentId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Tool binding not found' });

  db.prepare('DELETE FROM asdlc_agent_tool WHERE agent_tool_id = ?').run(req.params.atId);
  auditLog('asdlc_agent_tool', req.params.atId, 'DELETE', row, null, uid);
  res.json({ deleted: true });
});

// ──────────────────────────────────────────────
// PHASE 4: RATE CARD, COST ASSUMPTION, STEP COST BINDINGS, AI COST ESTIMATE
// ──────────────────────────────────────────────

// GET /api/v1/rate-card — list all Now Assist skills
app.get('/api/v1/rate-card', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM asdlc_assist_rate_card ORDER BY category, skill_name'
  ).all();
  res.json(rows);
});

// PUT /api/v1/rate-card/:skillId — edit a skill's assists_per_unit or category
app.put('/api/v1/rate-card/:skillId', (req, res) => {
  const row = db.prepare('SELECT * FROM asdlc_assist_rate_card WHERE skill_id = ?').get(req.params.skillId);
  if (!row) return res.status(404).json({ error: 'Skill not found' });

  const ALLOWED = ['assists_per_unit', 'category', 'source_note'];
  const updates = {};
  for (const k of ALLOWED) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  const cols = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE asdlc_assist_rate_card SET ${cols}, updated_at = datetime('now') WHERE skill_id = ?`)
    .run(...Object.values(updates), req.params.skillId);

  res.json(db.prepare('SELECT * FROM asdlc_assist_rate_card WHERE skill_id = ?').get(req.params.skillId));
});

// GET /api/v1/cost-assumption — DEPRECATED legacy singleton.
// All pricing + planning + entitlement is now per-Application; use
// GET /api/v1/projects/:id/cost-params instead. This endpoint still returns
// the legacy global pricing row (if any) for older clients, but writes are
// rejected to avoid silently divergent global vs per-app values.
app.get('/api/v1/cost-assumption', (req, res) => {
  let row = db.prepare('SELECT * FROM asdlc_cost_assumption').get();
  if (!row) row = { cost_assumption_id: null, cost_per_assist: null, overage_rate: null };
  res.json({
    cost_assumption_id: row.cost_assumption_id,
    cost_per_assist:    row.cost_per_assist,
    overage_rate:       row.overage_rate,
    updated_at:         row.updated_at,
    updated_by:         row.updated_by,
    _deprecated: 'Pricing is per-Application. Use GET /api/v1/projects/:id/cost-params.',
  });
});

// PUT /api/v1/cost-assumption — DEPRECATED. Pricing is per-Application now.
app.put('/api/v1/cost-assumption', (req, res) => {
  res.status(410).json({
    error: 'This endpoint is deprecated. Cost-per-assist, overage rate, and all ' +
           'other cost params are now per-Application. Use PUT /api/v1/projects/:id/cost-params.',
  });
});

// GET /api/v1/projects/:id/cost-params — per-Application planning + entitlement
app.get('/api/v1/projects/:id/cost-params', (req, res) => {
  const row = db.prepare(
    `SELECT project_id, planning_period, periods_per_year,
            entitlement_enabled, annual_included_assists,
            cost_per_assist, overage_rate, cost_per_assist_expansion
     FROM asdlc_project WHERE project_id = ?`
  ).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Project not found' });
  res.json(row);
});

// PUT /api/v1/projects/:id/cost-params — update per-Application cost params
app.put('/api/v1/projects/:id/cost-params', (req, res) => {
  const uid = userId(req);
  const existing = db.prepare('SELECT * FROM asdlc_project WHERE project_id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Project not found' });

  const ALLOWED = ['planning_period', 'periods_per_year',
                   'entitlement_enabled', 'annual_included_assists',
                   'cost_per_assist', 'overage_rate', 'cost_per_assist_expansion'];
  const updates = {};
  for (const k of ALLOWED) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  // Validate planning_period enum
  if (updates.planning_period !== undefined) {
    const valid = ['Weekly', 'Monthly', 'Quarterly', 'Annual'];
    if (!valid.includes(updates.planning_period)) {
      return res.status(400).json({ error: `planning_period must be one of: ${valid.join(', ')}` });
    }
  }
  // Validate non-negative numerics on the pricing fields
  for (const k of ['cost_per_assist', 'overage_rate', 'cost_per_assist_expansion']) {
    if (updates[k] !== undefined && updates[k] !== null) {
      const n = Number(updates[k]);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ error: `${k} must be a non-negative number` });
      }
      updates[k] = n;
    }
  }

  const cols = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE asdlc_project SET ${cols}, updated_at = datetime('now'), updated_by = ?
              WHERE project_id = ?`)
    .run(...Object.values(updates), uid || null, req.params.id);

  // Snapshot the old vs new cost params for audit (covers all 7 fields)
  const COST_PARAM_KEYS = ALLOWED;
  const before = {};
  const after  = {};
  COST_PARAM_KEYS.forEach(k => { before[k] = existing[k]; after[k] = updates[k] ?? existing[k]; });
  auditLog('asdlc_project', req.params.id, 'UPDATE',
           { cost_params: before }, { cost_params: after }, uid);

  const row = db.prepare(
    `SELECT project_id, planning_period, periods_per_year,
            entitlement_enabled, annual_included_assists,
            cost_per_assist, overage_rate, cost_per_assist_expansion
     FROM asdlc_project WHERE project_id = ?`
  ).get(req.params.id);
  res.json(row);
});

// GET /api/v1/projects/:id/steps/:stepId/cost-bindings
app.get('/api/v1/projects/:id/steps/:stepId/cost-bindings', (req, res) => {
  const rows = db.prepare(`
    SELECT b.*, r.assists_per_unit, r.category
    FROM asdlc_workflow_step_cost_binding b
    JOIN asdlc_assist_rate_card r ON r.skill_name = b.skill_name
    WHERE b.workflow_step_id = ? AND b.project_id = ?
    ORDER BY b.created_at
  `).all(req.params.stepId, req.params.id);
  res.json(rows);
});

// POST /api/v1/projects/:id/steps/:stepId/cost-bindings — add a manual binding
app.post('/api/v1/projects/:id/steps/:stepId/cost-bindings', (req, res) => {
  const uid = userId(req);
  const { skill_name, qty_per_run, branch_probability, notes } = req.body;
  if (!skill_name) return res.status(400).json({ error: 'skill_name required' });
  const skill = db.prepare('SELECT * FROM asdlc_assist_rate_card WHERE skill_name = ?').get(skill_name);
  if (!skill) return res.status(400).json({ error: 'skill_name not in rate card' });

  const bid = generateId();
  db.prepare(`
    INSERT INTO asdlc_workflow_step_cost_binding
      (binding_id, workflow_step_id, project_id, skill_name, qty_per_run,
       branch_probability, ai_generated, notes, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,0,?,?,datetime('now'),datetime('now'))
  `).run(bid, req.params.stepId, req.params.id, skill_name,
         qty_per_run ?? 1.0, branch_probability ?? null, notes ?? null, uid || null);

  auditLog('asdlc_workflow_step_cost_binding', bid, 'INSERT', null,
    { workflow_step_id: req.params.stepId, skill_name }, uid);
  res.status(201).json(db.prepare(
    'SELECT b.*, r.assists_per_unit FROM asdlc_workflow_step_cost_binding b JOIN asdlc_assist_rate_card r ON r.skill_name = b.skill_name WHERE b.binding_id = ?'
  ).get(bid));
});

// PUT /api/v1/projects/:id/steps/:stepId/cost-bindings/:bid — edit binding
app.put('/api/v1/projects/:id/steps/:stepId/cost-bindings/:bid', (req, res) => {
  const uid = userId(req);
  const row = db.prepare(
    'SELECT * FROM asdlc_workflow_step_cost_binding WHERE binding_id = ? AND project_id = ?'
  ).get(req.params.bid, req.params.id);
  if (!row) return res.status(404).json({ error: 'Binding not found' });

  const ALLOWED = ['qty_per_run', 'branch_probability', 'notes'];
  const updates = { ai_generated: 0 }; // any user edit marks as manual
  for (const k of ALLOWED) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }
  const cols = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE asdlc_workflow_step_cost_binding SET ${cols}, updated_at = datetime('now'), updated_by = ?
    WHERE binding_id = ?`).run(...Object.values(updates), uid || null, req.params.bid);

  auditLog('asdlc_workflow_step_cost_binding', req.params.bid, 'UPDATE', row, updates, uid);
  res.json(db.prepare('SELECT * FROM asdlc_workflow_step_cost_binding WHERE binding_id = ?').get(req.params.bid));
});

// DELETE /api/v1/projects/:id/steps/:stepId/cost-bindings/:bid
app.delete('/api/v1/projects/:id/steps/:stepId/cost-bindings/:bid', (req, res) => {
  const uid = userId(req);
  const row = db.prepare(
    'SELECT * FROM asdlc_workflow_step_cost_binding WHERE binding_id = ? AND project_id = ?'
  ).get(req.params.bid, req.params.id);
  if (!row) return res.status(404).json({ error: 'Binding not found' });
  db.prepare('DELETE FROM asdlc_workflow_step_cost_binding WHERE binding_id = ?').run(req.params.bid);
  auditLog('asdlc_workflow_step_cost_binding', req.params.bid, 'DELETE', row, null, uid);
  res.json({ deleted: true });
});

// POST /api/v1/projects/:id/cost-estimate — AI-driven cost estimation using Claude API
app.post('/api/v1/projects/:id/cost-estimate', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === 'your_anthropic_api_key_here' || apiKey.trim() === '') {
    return res.status(503).json({
      status: 'unavailable',
      message: 'ANTHROPIC_API_KEY is not configured. Set it in backend-node/.env to enable AI cost estimation.'
    });
  }

  const projectId = req.params.id;

  // Gather all project data needed for estimation.
  // Cost params are merged from global pricing + per-app planning/entitlement.
  const assumption = getEffectiveCostParams(projectId);

  const rateCard = db.prepare(
    'SELECT skill_name, category, assists_per_unit, description FROM asdlc_assist_rate_card ORDER BY category, skill_name'
  ).all();

  const workflows = db.prepare(
    "SELECT * FROM asdlc_workflow WHERE project_id = ? AND lifecycle_status != 'deleted'"
  ).all(projectId);

  const allSteps = db.prepare(
    "SELECT s.*, wp.participant_type, wp.agent_spec_id AS step_owner_agent_id FROM asdlc_workflow_step s LEFT JOIN asdlc_workflow_participant wp ON wp.workflow_participant_id = s.owner_participant_id WHERE s.project_id = ? ORDER BY s.workflow_id, s.step_number"
  ).all(projectId);

  const allAgents = db.prepare(
    "SELECT agent_spec_id, name, scope, instructions, cost_model FROM asdlc_agent_spec WHERE project_id = ? AND lifecycle_status != 'deleted'"
  ).all(projectId);

  const allToolBindings = db.prepare(`
    SELECT at.agent_spec_id, t.name AS tool_name, at.purpose, at.tool_execution_mode
    FROM asdlc_agent_tool at
    JOIN asdlc_tool t ON t.tool_id = at.tool_id
    WHERE at.project_id = ?
  `).all(projectId);

  // Build compact prompt data
  const toolsByAgent = {};
  allToolBindings.forEach(tb => {
    if (!toolsByAgent[tb.agent_spec_id]) toolsByAgent[tb.agent_spec_id] = [];
    toolsByAgent[tb.agent_spec_id].push(`${tb.tool_name} (${tb.tool_execution_mode || 'Autonomous'})`);
  });

  const agentSummary = allAgents.map(a => ({
    id: a.agent_spec_id,
    name: a.name,
    cost_model: a.cost_model,
    tools: toolsByAgent[a.agent_spec_id] || [],
    scope: a.scope ? a.scope.substring(0, 200) : ''
  }));

  const workflowSummary = workflows.map(wf => ({
    workflow_id: wf.workflow_id,
    name: wf.name,
    runs_per_period: wf.runs_per_period || 100,
    steps: allSteps.filter(s => s.workflow_id === wf.workflow_id).map(s => ({
      workflow_step_id: s.workflow_step_id,
      step_number: s.step_number,
      name: s.name,
      step_type: s.step_type || 'Activity',
      purpose: s.step_purpose || '',
      owner_type: s.participant_type || 'unknown',
      inputs: s.inputs ? JSON.stringify(s.inputs).substring(0, 100) : '',
      outputs: s.outputs ? JSON.stringify(s.outputs).substring(0, 100) : ''
    }))
  }));

  // Only include agentic skills in the prompt (shorter, more relevant)
  const agenticSkills = rateCard.filter(r =>
    r.category === 'Agentic' || r.category === 'Integration' || r.category === 'Flow' ||
    r.category === 'Knowledge' || r.category === 'Document'
  );

  const rateCardSummary = agenticSkills.map(r =>
    `"${r.skill_name}" (${r.category}): ${r.assists_per_unit} assists — ${r.description || ''}`
  ).join('\n');

  const prompt = `You are a ServiceNow Now Assist cost estimator for agentic AI workflows.

Analyze the following workflow design and determine which Now Assist skills are invoked at each workflow step, how many times per run, and at what probability.

RATE CARD — use ONLY these exact skill names:
${rateCardSummary}

AGENTS IN PROJECT:
${JSON.stringify(agentSummary, null, 1)}

WORKFLOWS AND STEPS:
${JSON.stringify(workflowSummary, null, 1)}

RULES:
- Only include agent-owned steps (owner_type includes "Agent" or "Orchestrator")
- Skip pure human steps (owner_type = "Human Role" or "Human Coordinator")
- For the main agentic processing step, use "Agentic workflow – small" (≤3 tools), "medium" (4-8 tools), or "large" (9-20 tools)
- For each MCP tool call, add "MCP server call" × number of distinct tool calls
- For knowledge lookups within a workflow (reading one or a few KB articles for a specific record), add "Knowledge graph query" — NOT "Knowledge gaps detection" or "Identify duplicate articles"
- CRITICAL — read the description carefully before assigning any Knowledge or high-cost skill: several skills are INSTANCE-WIDE BATCH OPERATIONS that scan all records across the entire SN instance (e.g., "Knowledge gaps detection" generates clusters across all cases; "Identify duplicate articles" scans all KB articles). These must NEVER be assigned to a per-record or per-incident agentic workflow step. Assign them only when a step explicitly triggers a full-instance scan as a scheduled or admin operation.
- branch_probability: 1.0 if always runs, lower if conditional (e.g. 0.4 for a branch path)
- qty_per_run: how many times this skill fires in one workflow execution
- Respond with a JSON array ONLY (no markdown, no extra text)

OUTPUT FORMAT:
[
  {
    "workflow_step_id": "<exact step UUID>",
    "skill_name": "<exact name from rate card>",
    "qty_per_run": 1,
    "branch_probability": 1.0,
    "reasoning": "one sentence"
  }
]`;

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    const model = aiConfig.resolveModel('cost_estimate');
    const message = await client.messages.create({
      model,
      max_tokens: aiConfig.getMaxTokens(),
      system: withWiki(),
      messages: [{ role: 'user', content: prompt }]
    });
    // Record token usage so this Opus call shows up in the /usage cost dashboards
    // and is attributable to the project (was previously invisible). Never throws.
    aiConfig.logUsage({ projectId, source: 'cost_estimate', refId: projectId, model, usage: message.usage });

    const rawText = message.content[0]?.text || '[]';
    // Strip markdown code fences if present
    const jsonText = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    let bindings;
    try {
      bindings = JSON.parse(jsonText);
    } catch {
      return res.status(500).json({ error: 'AI returned invalid JSON', raw: rawText.substring(0, 500) });
    }

    if (!Array.isArray(bindings)) {
      return res.status(500).json({ error: 'AI response was not an array', raw: rawText.substring(0, 500) });
    }

    // Validate skill names against rate card
    const validSkills = new Set(rateCard.map(r => r.skill_name));
    const uid = userId(req);
    let created = 0;
    const skipped = [];

    const upsertStmt = db.prepare(`
      INSERT INTO asdlc_workflow_step_cost_binding
        (binding_id, workflow_step_id, project_id, skill_name, qty_per_run,
         branch_probability, ai_generated, ai_reasoning, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,1,?,?,datetime('now'),datetime('now'))
      ON CONFLICT(workflow_step_id, skill_name) DO UPDATE SET
        qty_per_run = excluded.qty_per_run,
        branch_probability = excluded.branch_probability,
        ai_generated = 1,
        ai_reasoning = excluded.ai_reasoning,
        updated_at = datetime('now')
    `);

    // Valid step IDs for this project
    const validStepIds = new Set(allSteps.map(s => s.workflow_step_id));

    for (const b of bindings) {
      if (!b.workflow_step_id || !b.skill_name) { skipped.push({ reason: 'missing fields', b }); continue; }
      if (!validSkills.has(b.skill_name)) { skipped.push({ reason: 'unknown skill', skill: b.skill_name }); continue; }
      if (!validStepIds.has(b.workflow_step_id)) { skipped.push({ reason: 'unknown step', step: b.workflow_step_id }); continue; }
      try {
        upsertStmt.run(
          generateId(), b.workflow_step_id, projectId, b.skill_name,
          b.qty_per_run ?? 1.0, b.branch_probability ?? null,
          b.reasoning || null, uid || null
        );
        created++;
      } catch (err) {
        skipped.push({ reason: err.message, b });
      }
    }

    res.json({ status: 'ok', bindings_created: created, skipped_count: skipped.length, skipped: skipped.slice(0, 5) });
  } catch (err) {
    console.error('[cost-estimate] Claude API error:', err.message);
    res.status(500).json({ error: 'Claude API call failed', detail: err.message });
  }
});

// ──────────────────────────────────────────────
// KNOWLEDGE ARTICLES
// ──────────────────────────────────────────────
app.get('/api/v1/projects/:id/knowledge-articles', (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM asdlc_knowledge_article WHERE project_id = ? AND lifecycle_status != 'deleted' ORDER BY updated_at DESC"
  ).all(req.params.id);
  res.json(rows);
});

// ──────────────────────────────────────────────
// TOOLS
// ──────────────────────────────────────────────
app.get('/api/v1/projects/:id/tools', (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM asdlc_tool WHERE project_id = ? AND lifecycle_status = 'active' ORDER BY name"
  ).all(req.params.id);
  res.json(parseRows(rows));
});

// PUT /api/v1/projects/:id/tools/:toolId
app.put('/api/v1/projects/:id/tools/:toolId', (req, res) => {
  const uid = userId(req);
  const existing = db.prepare("SELECT * FROM asdlc_tool WHERE tool_id = ? AND project_id = ?")
    .get(req.params.toolId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Tool not found' });

  const ALLOWED = ['name', 'execution_mode', 'cost_impact', 'access_requirements',
                   'contract', 'boundaries',
                   // Phase 1 additions (Decision #14):
                   'dev_status'];
  const JSON_TOOL = ['contract', 'inputs', 'outputs', 'errors', 'boundaries', 'access_requirements'];
  const updates = {};
  ALLOWED.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

  // Phase 1 enum validation
  try {
    if (updates.dev_status !== undefined) validateEnum(updates.dev_status, ENUMS.dev_status, 'dev_status');
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Special: contract_description merges into the existing contract JSON object
  if (req.body.contract_description !== undefined) {
    const existingContract = parseJson(existing.contract) || {};
    if (typeof existingContract === 'object') {
      updates.contract = JSON.stringify({ ...existingContract, description: req.body.contract_description });
    } else {
      updates.contract = JSON.stringify({ description: req.body.contract_description });
    }
  }

  JSON_TOOL.forEach(f => { if (updates[f] !== undefined && typeof updates[f] !== 'string') updates[f] = JSON.stringify(updates[f]); });

  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No updatable fields provided' });

  const diff = diffFields(existing, updates, JSON_TOOL);
  const setClauses = Object.keys(updates).map(f => `${f} = ?`).join(', ');
  db.prepare(`UPDATE asdlc_tool SET ${setClauses}, updated_at = datetime('now'), updated_by = ?
    WHERE tool_id = ?`).run(...Object.values(updates), uid, req.params.toolId);

  const after = db.prepare('SELECT * FROM asdlc_tool WHERE tool_id = ?').get(req.params.toolId);
  auditLog('asdlc_tool', req.params.toolId, 'UPDATE', existing, after, uid);

  let cpResult = null;
  if (diff.length > 0) {
    cpResult = createAutoApprovedCP(req.params.id, 'tool', req.params.toolId,
      existing.name, diff, uid);
  }

  const reviewQueued = reviewQueue.maybeEnqueueReview({
    projectId: req.params.id, entityType: 'tool', entityId: req.params.toolId,
    changedFields: diff.map(d => d.field),
  });

  res.json({ ...parseRow(after), _cp: cpResult, _review_queued: reviewQueued });
});

// ──────────────────────────────────────────────
// HITL GATES
// ──────────────────────────────────────────────
app.get('/api/v1/projects/:id/hitl-gates', (req, res) => {
  const rows = db.prepare(
    "SELECT hg.*, wf.name AS workflow_name FROM asdlc_hitl_gate hg LEFT JOIN asdlc_workflow wf ON wf.workflow_id = hg.workflow_id WHERE hg.project_id = ? AND hg.lifecycle_status = 'active' ORDER BY hg.created_at"
  ).all(req.params.id);
  res.json(rows);
});

// ──────────────────────────────────────────────
// WORKFLOW PARTICIPANTS  (Phase 2)
// ──────────────────────────────────────────────

app.get('/api/v1/projects/:id/workflows/:wfId/participants', (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM asdlc_workflow_participant WHERE workflow_id = ? AND project_id = ? AND lifecycle_status != 'deleted' ORDER BY lane_order, created_at"
  ).all(req.params.wfId, req.params.id);
  res.json(rows);
});

app.post('/api/v1/projects/:id/workflows/:wfId/participants', (req, res) => {
  const uid = userId(req);
  const { participant_type, human_role_name, purpose_in_workflow, authority_level,
          handoff_method, agent_spec_id, inputs_required, outputs_produced,
          swimlane_display_name, lane_order, include_in_swimlane, include_in_rasic,
          rasic_column_display_name, rasic_column_order, engagement_channel, notes } = req.body || {};
  if (!participant_type) return res.status(400).json({ error: 'participant_type is required' });
  try {
    validateEnum(participant_type, ENUMS.participant_type, 'participant_type');
    if (authority_level) validateEnum(authority_level, ENUMS.authority_level, 'authority_level');
    if (handoff_method)  validateEnum(handoff_method,  ENUMS.handoff_method,  'handoff_method');
  } catch (err) { return res.status(400).json({ error: err.message }); }

  const id   = generateId();
  const slug = nextSlug('asdlc_workflow_participant', 'P', req.params.id);
  db.prepare(`
    INSERT INTO asdlc_workflow_participant
      (workflow_participant_id, workflow_id, project_id, slug, participant_type,
       agent_spec_id, human_role_name, purpose_in_workflow, authority_level, handoff_method,
       inputs_required, outputs_produced, swimlane_display_name, lane_order,
       include_in_swimlane, include_in_rasic, rasic_column_display_name, rasic_column_order,
       engagement_channel, notes, created_by, updated_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, req.params.wfId, req.params.id, slug, participant_type,
         agent_spec_id || null, human_role_name || null, purpose_in_workflow || null,
         authority_level || null, handoff_method || null,
         inputs_required || null, outputs_produced || null,
         swimlane_display_name || null, lane_order != null ? lane_order : null,
         include_in_swimlane != null ? include_in_swimlane : 1,
         include_in_rasic    != null ? include_in_rasic    : 1,
         rasic_column_display_name || null, rasic_column_order != null ? rasic_column_order : null,
         engagement_channel || null, notes || null, uid, uid);
  const row = db.prepare('SELECT * FROM asdlc_workflow_participant WHERE workflow_participant_id = ?').get(id);
  auditLog('asdlc_workflow_participant', id, 'INSERT', null, row, uid);
  res.status(201).json(row);
});

app.put('/api/v1/projects/:id/workflows/:wfId/participants/:participantId', (req, res) => {
  const uid = userId(req);
  const existing = db.prepare(
    'SELECT * FROM asdlc_workflow_participant WHERE workflow_participant_id = ? AND workflow_id = ? AND project_id = ?'
  ).get(req.params.participantId, req.params.wfId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Participant not found' });

  const ALLOWED = ['participant_type', 'human_role_name', 'purpose_in_workflow', 'authority_level',
                   'handoff_method', 'agent_spec_id', 'inputs_required', 'outputs_produced',
                   'swimlane_display_name', 'lane_order', 'include_in_swimlane', 'include_in_rasic',
                   'rasic_column_display_name', 'rasic_column_order', 'engagement_channel', 'notes'];
  const updates = {};
  ALLOWED.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
  try {
    if (updates.participant_type) validateEnum(updates.participant_type, ENUMS.participant_type, 'participant_type');
    if (updates.authority_level)  validateEnum(updates.authority_level,  ENUMS.authority_level,  'authority_level');
    if (updates.handoff_method)   validateEnum(updates.handoff_method,   ENUMS.handoff_method,   'handoff_method');
  } catch (err) { return res.status(400).json({ error: err.message }); }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No updatable fields' });

  const setClauses = Object.keys(updates).map(f => `${f} = ?`).join(', ');
  db.prepare(`UPDATE asdlc_workflow_participant SET ${setClauses}, updated_at = datetime('now'), updated_by = ?
    WHERE workflow_participant_id = ?`).run(...Object.values(updates), uid, req.params.participantId);
  const after = db.prepare('SELECT * FROM asdlc_workflow_participant WHERE workflow_participant_id = ?').get(req.params.participantId);
  auditLog('asdlc_workflow_participant', req.params.participantId, 'UPDATE', existing, after, uid);
  res.json(after);
});

app.delete('/api/v1/projects/:id/workflows/:wfId/participants/:participantId', (req, res) => {
  const uid = userId(req);
  db.prepare(`UPDATE asdlc_workflow_participant SET lifecycle_status = 'deleted', updated_by = ?, updated_at = datetime('now')
    WHERE workflow_participant_id = ? AND workflow_id = ? AND project_id = ?`
  ).run(uid, req.params.participantId, req.params.wfId, req.params.id);
  res.json({ deleted: true });
});

// ──────────────────────────────────────────────
// WORKFLOW STEP RASIC  (Phase 2)
// ──────────────────────────────────────────────

app.get('/api/v1/projects/:id/workflows/:wfId/steps/:stepId/rasic', (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, p.participant_type, p.human_role_name, p.swimlane_display_name,
           p.slug AS participant_slug, a.name AS agent_name
    FROM asdlc_workflow_step_rasic r
    JOIN asdlc_workflow_participant p ON p.workflow_participant_id = r.workflow_participant_id
    LEFT JOIN asdlc_agent_spec a ON a.agent_spec_id = p.agent_spec_id
    WHERE r.workflow_step_id = ? AND r.project_id = ?
    ORDER BY p.rasic_column_order, p.created_at, r.code
  `).all(req.params.stepId, req.params.id);
  res.json(rows);
});

app.post('/api/v1/projects/:id/workflows/:wfId/steps/:stepId/rasic', (req, res) => {
  const uid = userId(req);
  const { workflow_participant_id, code } = req.body || {};
  if (!workflow_participant_id || !code) return res.status(400).json({ error: 'workflow_participant_id and code are required' });
  try { validateEnum(code, ENUMS.rasic_code, 'code'); } catch (err) { return res.status(400).json({ error: err.message }); }

  const id = generateId();
  try {
    db.prepare(`
      INSERT INTO asdlc_workflow_step_rasic
        (rasic_id, workflow_step_id, workflow_participant_id, project_id, code, created_by, updated_by)
      VALUES (?,?,?,?,?,?,?)
    `).run(id, req.params.stepId, workflow_participant_id, req.params.id, code, uid, uid);
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'This code already exists for this step/participant combination' });
    throw err;
  }
  const row = db.prepare('SELECT * FROM asdlc_workflow_step_rasic WHERE rasic_id = ?').get(id);
  auditLog('asdlc_workflow_step_rasic', id, 'INSERT', null, row, uid);
  res.status(201).json(row);
});

app.delete('/api/v1/projects/:id/workflows/:wfId/steps/:stepId/rasic/:rasicId', (req, res) => {
  const uid = userId(req);
  const row = db.prepare('SELECT * FROM asdlc_workflow_step_rasic WHERE rasic_id = ? AND workflow_step_id = ?')
    .get(req.params.rasicId, req.params.stepId);
  if (!row) return res.status(404).json({ error: 'RASIC entry not found' });
  db.prepare('DELETE FROM asdlc_workflow_step_rasic WHERE rasic_id = ?').run(req.params.rasicId);
  auditLog('asdlc_workflow_step_rasic', req.params.rasicId, 'DELETE', row, null, uid);
  res.json({ deleted: true });
});

// ──────────────────────────────────────────────
// WORKFLOW PATHS  (Phase 2)
// ──────────────────────────────────────────────

app.get('/api/v1/projects/:id/workflows/:wfId/paths', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM asdlc_workflow_path WHERE workflow_id = ? AND project_id = ? ORDER BY created_at'
  ).all(req.params.wfId, req.params.id);
  res.json(rows);
});

app.post('/api/v1/projects/:id/workflows/:wfId/paths', (req, res) => {
  const uid = userId(req);
  const { from_step_id, to_step_id, branch_label, branch_condition, is_default_path, notes } = req.body || {};
  if (!from_step_id || !to_step_id) return res.status(400).json({ error: 'from_step_id and to_step_id are required' });

  const id   = generateId();
  const slug = nextSlug('asdlc_workflow_path', 'PATH', req.params.id);
  db.prepare(`
    INSERT INTO asdlc_workflow_path
      (workflow_path_id, workflow_id, project_id, slug, from_step_id, to_step_id,
       branch_label, branch_condition, is_default_path, notes, created_by, updated_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, req.params.wfId, req.params.id, slug, from_step_id, to_step_id,
         branch_label || null, branch_condition || null,
         is_default_path ? 1 : 0, notes || null, uid, uid);
  const row = db.prepare('SELECT * FROM asdlc_workflow_path WHERE workflow_path_id = ?').get(id);
  auditLog('asdlc_workflow_path', id, 'INSERT', null, row, uid);
  res.status(201).json(row);
});

app.put('/api/v1/projects/:id/workflows/:wfId/paths/:pathId', (req, res) => {
  const uid = userId(req);
  const existing = db.prepare(
    'SELECT * FROM asdlc_workflow_path WHERE workflow_path_id = ? AND workflow_id = ? AND project_id = ?'
  ).get(req.params.pathId, req.params.wfId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Path not found' });

  const ALLOWED = ['from_step_id', 'to_step_id', 'branch_label', 'branch_condition', 'is_default_path', 'notes'];
  const updates = {};
  ALLOWED.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No updatable fields' });

  const setClauses = Object.keys(updates).map(f => `${f} = ?`).join(', ');
  db.prepare(`UPDATE asdlc_workflow_path SET ${setClauses}, updated_at = datetime('now'), updated_by = ?
    WHERE workflow_path_id = ?`).run(...Object.values(updates), uid, req.params.pathId);
  const after = db.prepare('SELECT * FROM asdlc_workflow_path WHERE workflow_path_id = ?').get(req.params.pathId);
  auditLog('asdlc_workflow_path', req.params.pathId, 'UPDATE', existing, after, uid);
  res.json(after);
});

app.delete('/api/v1/projects/:id/workflows/:wfId/paths/:pathId', (req, res) => {
  const uid = userId(req);
  const row = db.prepare('SELECT * FROM asdlc_workflow_path WHERE workflow_path_id = ? AND workflow_id = ?')
    .get(req.params.pathId, req.params.wfId);
  if (!row) return res.status(404).json({ error: 'Path not found' });
  db.prepare('DELETE FROM asdlc_workflow_path WHERE workflow_path_id = ?').run(req.params.pathId);
  auditLog('asdlc_workflow_path', req.params.pathId, 'DELETE', row, null, uid);
  res.json({ deleted: true });
});

// ──────────────────────────────────────────────
// SWIMLANE DIAGRAM (PlantUML → PNG/SVG via kroki.io)
// ──────────────────────────────────────────────

/**
 * GET /api/v1/projects/:id/workflows/:wfId/swimlane
 * Generates a swimlane diagram for the given workflow via kroki.io and
 * returns a PNG (default) or SVG suitable for downloading.
 *
 * Query params:
 *   ?format=png|svg   (default: png)
 */
const { buildSwimlaneSVG } = require('./swimlane');

app.get('/api/v1/projects/:id/workflows/:wfId/swimlane', (req, res) => {
  // ── load project ──────────────────────────────────────────────────────────
  const project = db.prepare(
    'SELECT project_name, project_code FROM asdlc_project WHERE project_id = ?'
  ).get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  // ── load workflow ─────────────────────────────────────────────────────────
  const wf = db.prepare(
    "SELECT * FROM asdlc_workflow WHERE workflow_id = ? AND project_id = ? AND lifecycle_status != 'deleted'"
  ).get(req.params.wfId, req.params.id);
  if (!wf) return res.status(404).json({ error: 'Workflow not found' });

  // ── load steps, participants, paths ───────────────────────────────────────
  const steps = db.prepare(
    'SELECT * FROM asdlc_workflow_step WHERE workflow_id = ? ORDER BY step_number'
  ).all(req.params.wfId);

  const participants = db.prepare(`
    SELECT p.*, a.name AS agent_name
    FROM asdlc_workflow_participant p
    LEFT JOIN asdlc_agent_spec a ON a.agent_spec_id = p.agent_spec_id
    WHERE p.workflow_id = ? AND p.lifecycle_status != 'deleted'
    ORDER BY p.lane_order, p.created_at
  `).all(req.params.wfId);

  const paths = db.prepare(
    'SELECT * FROM asdlc_workflow_path WHERE workflow_id = ? ORDER BY created_at'
  ).all(req.params.wfId);

  // HITL gates per step (boolean flag on steps so the renderer can badge them)
  const hitlGates = db.prepare('SELECT * FROM asdlc_hitl_gate WHERE workflow_id = ?')
    .all(req.params.wfId);
  const hitlByStep = new Set();
  hitlGates.forEach(h => { if (h.workflow_step_id) hitlByStep.add(h.workflow_step_id); });
  // Also flag steps whose own hitl_gate_id is non-null
  for (const s of steps) {
    s.hitl_gate = s.hitl_gate_id || hitlByStep.has(s.workflow_step_id) || null;
  }

  // Parse workflow JSON columns for the renderer
  let fallbackPaths = [];
  try { fallbackPaths = wf.fallback_paths ? JSON.parse(wf.fallback_paths) : []; } catch (_) {}

  // ── build SVG ─────────────────────────────────────────────────────────────
  let svgText;
  try {
    svgText = buildSwimlaneSVG(
      {
        workflow_id:    wf.workflow_id,
        slug:           wf.slug,
        name:           wf.name,
        steps,
        participants,
        paths,
        fallback_paths: fallbackPaths,
      },
      project.project_name
    );
  } catch (err) {
    return res.status(422).json({ error: `Swimlane build failed: ${err.message}` });
  }

  // ── stream as SVG download ────────────────────────────────────────────────
  const slug     = (wf.slug || 'workflow').toLowerCase();
  const filename = `swimlane-${slug}.svg`;
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(svgText);
});

// ──────────────────────────────────────────────
// ACCEPTANCE CRITERIA
// ──────────────────────────────────────────────

// List acceptance criteria for a project, optionally filtered by parent.
// Query params: parent_type=use_case|user_story, parent_id=<id>
app.get('/api/v1/projects/:id/acceptance-criteria', (req, res) => {
  const where = ['project_id = ?', "lifecycle_status != 'deleted'"];
  const args  = [req.params.id];
  if (req.query.parent_type) { where.push('parent_type = ?'); args.push(req.query.parent_type); }
  if (req.query.parent_id)   { where.push('parent_id = ?');   args.push(req.query.parent_id); }
  const rows = db.prepare(
    `SELECT * FROM asdlc_acceptance_criterion WHERE ${where.join(' AND ')} ORDER BY created_at`
  ).all(...args);
  res.json(rows);
});

// Create
app.post('/api/v1/projects/:id/acceptance-criteria', (req, res) => {
  const uid = userId(req);
  const { parent_type, parent_id, text, source, status, req_slug } = req.body || {};
  if (!parent_type || !parent_id || !text) {
    return res.status(400).json({ error: 'parent_type, parent_id, and text are required' });
  }
  if (!['use_case', 'user_story'].includes(parent_type)) {
    return res.status(400).json({ error: "parent_type must be 'use_case' or 'user_story'" });
  }
  const id = generateId();
  db.prepare(`
    INSERT INTO asdlc_acceptance_criterion
      (acceptance_criterion_id, project_id, parent_type, parent_id, req_slug, text,
       source, status, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.params.id, parent_type, parent_id, req_slug || null, text,
         source || 'user_added', status || 'draft', uid, uid);
  const row = db.prepare('SELECT * FROM asdlc_acceptance_criterion WHERE acceptance_criterion_id = ?').get(id);
  auditLog('asdlc_acceptance_criterion', id, 'INSERT', null, row, uid);
  res.status(201).json(row);
});

// Update — triggers auto-approved CP for every changed field
app.put('/api/v1/projects/:id/acceptance-criteria/:acId', (req, res) => {
  const uid = userId(req);
  const existing = db.prepare(
    'SELECT * FROM asdlc_acceptance_criterion WHERE acceptance_criterion_id = ? AND project_id = ?'
  ).get(req.params.acId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Acceptance criterion not found' });

  const ALLOWED = ['text', 'status', 'source', 'req_slug'];
  const updates = {};
  ALLOWED.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
  // PO edits flip source to user_edited unless caller is the auto-generator.
  if (updates.text !== undefined && existing.source === 'generated' && !req.body.source) {
    updates.source = 'user_edited';
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No updatable fields provided' });

  const diff = diffFields(existing, updates, []);
  const setClauses = Object.keys(updates).map(f => `${f} = ?`).join(', ');
  db.prepare(`UPDATE asdlc_acceptance_criterion SET ${setClauses}, updated_at = datetime('now'), updated_by = ?
    WHERE acceptance_criterion_id = ?`).run(...Object.values(updates), uid, req.params.acId);

  const after = db.prepare('SELECT * FROM asdlc_acceptance_criterion WHERE acceptance_criterion_id = ?').get(req.params.acId);
  auditLog('asdlc_acceptance_criterion', req.params.acId, 'UPDATE', existing, after, uid);

  let cpResult = null;
  if (diff.length > 0) {
    const label = (existing.text || '').slice(0, 40) + (existing.text && existing.text.length > 40 ? '…' : '');
    cpResult = createAutoApprovedCP(req.params.id, 'acceptance_criterion', req.params.acId,
      label || 'Acceptance Criterion', diff, uid);
  }
  res.json({ ...after, _cp: cpResult });
});

// Soft-delete
app.delete('/api/v1/projects/:id/acceptance-criteria/:acId', (req, res) => {
  const uid = userId(req);
  const existing = db.prepare(
    'SELECT * FROM asdlc_acceptance_criterion WHERE acceptance_criterion_id = ? AND project_id = ?'
  ).get(req.params.acId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Acceptance criterion not found' });
  db.prepare(`UPDATE asdlc_acceptance_criterion
    SET lifecycle_status = 'deleted', updated_at = datetime('now'), updated_by = ?
    WHERE acceptance_criterion_id = ?`).run(uid, req.params.acId);
  auditLog('asdlc_acceptance_criterion', req.params.acId, 'DELETE', existing, null, uid);
  res.status(204).end();
});

// ──────────────────────────────────────────────
// TEST CASES
// ──────────────────────────────────────────────

// List test cases. Query params: scope=agent|workflow|tool|use_case, scope_entity_id=<id>
app.get('/api/v1/projects/:id/test-cases', (req, res) => {
  const where = ['project_id = ?', "lifecycle_status != 'deleted'"];
  const args  = [req.params.id];
  if (req.query.scope)           { where.push('scope = ?');           args.push(req.query.scope); }
  if (req.query.scope_entity_id) { where.push('scope_entity_id = ?'); args.push(req.query.scope_entity_id); }
  const rows = db.prepare(
    `SELECT * FROM asdlc_test_case WHERE ${where.join(' AND ')} ORDER BY created_at`
  ).all(...args);
  res.json(rows);
});

app.post('/api/v1/projects/:id/test-cases', (req, res) => {
  const uid = userId(req);
  const { scope, scope_entity_id, title, test_action, test_input, expected_result,
          case_type, source, status, requirement_ids } = req.body || {};
  if (!scope || !scope_entity_id || !title) {
    return res.status(400).json({ error: 'scope, scope_entity_id, and title are required' });
  }
  if (!['agent', 'workflow', 'tool', 'use_case'].includes(scope)) {
    return res.status(400).json({ error: "scope must be 'agent', 'workflow', 'tool', or 'use_case'" });
  }
  const reqIds = requirement_ids
    ? (Array.isArray(requirement_ids) ? JSON.stringify(requirement_ids) : String(requirement_ids))
    : '[]';
  const id = generateId();
  db.prepare(`
    INSERT INTO asdlc_test_case
      (test_case_id, project_id, scope, scope_entity_id, title, test_action,
       test_input, expected_result, case_type, source, status, requirement_ids,
       created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.params.id, scope, scope_entity_id, title,
         test_action || '', test_input || '', expected_result || '',
         case_type || 'happy_path', source || 'user_added', status || 'draft', reqIds, uid, uid);
  const row = db.prepare('SELECT * FROM asdlc_test_case WHERE test_case_id = ?').get(id);
  auditLog('asdlc_test_case', id, 'INSERT', null, row, uid);
  res.status(201).json(row);
});

app.put('/api/v1/projects/:id/test-cases/:tcId', (req, res) => {
  const uid = userId(req);
  const existing = db.prepare(
    'SELECT * FROM asdlc_test_case WHERE test_case_id = ? AND project_id = ?'
  ).get(req.params.tcId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Test case not found' });

  const ALLOWED = ['title', 'test_action', 'test_input', 'expected_result',
                   'case_type', 'status', 'source', 'requirement_ids'];
  const updates = {};
  ALLOWED.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
  // Normalise requirement_ids to a JSON string
  if (updates.requirement_ids !== undefined && Array.isArray(updates.requirement_ids)) {
    updates.requirement_ids = JSON.stringify(updates.requirement_ids);
  }
  // User edits flip source to user_edited (unless caller explicitly sets source).
  const userEditedFields = ['title', 'test_action', 'test_input', 'expected_result', 'case_type'];
  if (userEditedFields.some(f => updates[f] !== undefined) && existing.source === 'generated' && !req.body.source) {
    updates.source = 'user_edited';
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No updatable fields provided' });

  const diff = diffFields(existing, updates, []);
  const setClauses = Object.keys(updates).map(f => `${f} = ?`).join(', ');
  db.prepare(`UPDATE asdlc_test_case SET ${setClauses}, updated_at = datetime('now'), updated_by = ?
    WHERE test_case_id = ?`).run(...Object.values(updates), uid, req.params.tcId);

  const after = db.prepare('SELECT * FROM asdlc_test_case WHERE test_case_id = ?').get(req.params.tcId);
  auditLog('asdlc_test_case', req.params.tcId, 'UPDATE', existing, after, uid);

  let cpResult = null;
  if (diff.length > 0) {
    cpResult = createAutoApprovedCP(req.params.id, 'test_case', req.params.tcId,
      existing.title || 'Test Case', diff, uid);
  }
  res.json({ ...after, _cp: cpResult });
});

app.delete('/api/v1/projects/:id/test-cases/:tcId', (req, res) => {
  const uid = userId(req);
  const existing = db.prepare(
    'SELECT * FROM asdlc_test_case WHERE test_case_id = ? AND project_id = ?'
  ).get(req.params.tcId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Test case not found' });
  db.prepare(`UPDATE asdlc_test_case
    SET lifecycle_status = 'deleted', updated_at = datetime('now'), updated_by = ?
    WHERE test_case_id = ?`).run(uid, req.params.tcId);
  auditLog('asdlc_test_case', req.params.tcId, 'DELETE', existing, null, uid);
  res.status(204).end();
});

// ── Test coverage matrix: requirement × case_type ─────────────────
// Surfaces test traceability + gaps. Counts active test cases per requirement
// (via the loose requirement_ids slug array) broken out by case_type.
const TC_CASE_TYPES = ['happy_path', 'edge_case', 'negative', 'regression', 'performance'];
function tcParseIds(v) { try { return Array.isArray(v) ? v : JSON.parse(v || '[]'); } catch { return []; } }

app.get('/api/v1/projects/:id/test-coverage', (req, res) => {
  const projectId = req.params.id;
  const frs = db.prepare(
    "SELECT fr_id AS id, slug, title FROM asdlc_functional_req WHERE project_id=? AND status!='deleted' AND slug IS NOT NULL ORDER BY slug"
  ).all(projectId);
  const nfrs = db.prepare(
    "SELECT nfr_id AS id, slug, title FROM asdlc_nonfunctional_req WHERE project_id=? AND status!='deleted' AND slug IS NOT NULL ORDER BY slug"
  ).all(projectId);
  const tcs = db.prepare(
    "SELECT test_case_id, case_type, requirement_ids FROM asdlc_test_case WHERE project_id=? AND lifecycle_status='active'"
  ).all(projectId);

  // slug → { case_type: [tcId,...] }
  const bySlug = {};
  let linkedTcCount = 0;
  for (const tc of tcs) {
    const slugs = tcParseIds(tc.requirement_ids);
    if (slugs.length) linkedTcCount++;
    const ct = TC_CASE_TYPES.includes(tc.case_type) ? tc.case_type : 'happy_path';
    for (const slug of slugs) {
      (bySlug[slug] ||= {});
      (bySlug[slug][ct] ||= []).push(tc.test_case_id);
    }
  }

  const buildRow = (r, req_type) => {
    const cell = bySlug[r.slug] || {};
    const counts = {}; let total = 0; const tcIds = [];
    for (const ct of TC_CASE_TYPES) {
      const ids = cell[ct] || [];
      counts[ct] = ids.length; total += ids.length; tcIds.push(...ids);
    }
    return { req_type, id: r.id, slug: r.slug, title: r.title, counts, total, linked_tc_ids: tcIds };
  };

  const requirements = [
    ...frs.map(r => buildRow(r, 'functional')),
    ...nfrs.map(r => buildRow(r, 'nonfunctional')),
  ];
  res.json({
    case_types: TC_CASE_TYPES,
    requirements,
    summary: {
      total_requirements: requirements.length,
      requirements_with_any_tc: requirements.filter(r => r.total > 0).length,
      total_test_cases: tcs.length,
      test_cases_with_link: linkedTcCount,
    },
  });
});

// AI: suggest test→requirement links and apply them (additive, deduped).
app.post('/api/v1/projects/:id/test-coverage/infer', async (req, res) => {
  const projectId = req.params.id;
  const uid = userId(req);
  const onlyUnlinked = req.body && req.body.only_unlinked === false ? false : true;
  try {
    const { inferTestLinks } = require('./agent/test-coverage');
    const result = await inferTestLinks({ projectId, db, onlyUnlinked });

    // Valid requirement slugs for this project (so we never write a hallucinated slug).
    const validSlugs = new Set([
      ...db.prepare("SELECT slug FROM asdlc_functional_req WHERE project_id=? AND slug IS NOT NULL").all(projectId).map(r => r.slug),
      ...db.prepare("SELECT slug FROM asdlc_nonfunctional_req WHERE project_id=? AND slug IS NOT NULL").all(projectId).map(r => r.slug),
    ]);

    let updated = 0, linksAdded = 0;
    for (const s of result.suggestions) {
      const tc = db.prepare("SELECT * FROM asdlc_test_case WHERE test_case_id=? AND project_id=? AND lifecycle_status='active'").get(s.test_case_id, projectId);
      if (!tc) continue;
      const current = tcParseIds(tc.requirement_ids);
      const merged = [...current];
      for (const slug of s.requirement_slugs) {
        if (validSlugs.has(slug) && !merged.includes(slug)) { merged.push(slug); linksAdded++; }
      }
      if (merged.length !== current.length) {
        db.prepare("UPDATE asdlc_test_case SET requirement_ids=?, updated_at=datetime('now'), updated_by=? WHERE test_case_id=?")
          .run(JSON.stringify(merged), uid, s.test_case_id);
        auditLog('asdlc_test_case', s.test_case_id, 'UPDATE', tc,
          db.prepare("SELECT * FROM asdlc_test_case WHERE test_case_id=?").get(s.test_case_id), uid);
        updated++;
      }
    }
    res.json({ suggested: result.suggestions.length, test_cases_updated: updated, links_added: linksAdded, model: result.model, source: result.source, error: result.error });
  } catch (err) {
    console.error('[test-coverage/infer]', err);
    res.status(500).json({ error: err.message });
  }
});

// On-demand: AI-generate test cases for one entity (fills gaps for entities that
// were materialized without tests, e.g. an agent ingested from a design-only doc).
const TC_SCOPE_VALS = ['use_case', 'workflow', 'agent', 'tool'];
app.post('/api/v1/projects/:id/test-cases/generate', async (req, res) => {
  const { scope, scope_entity_id } = req.body || {};
  if (!TC_SCOPE_VALS.includes(scope)) return res.status(400).json({ error: `scope must be one of: ${TC_SCOPE_VALS.join(', ')}` });
  if (!scope_entity_id) return res.status(400).json({ error: 'scope_entity_id is required' });
  try {
    const r = await generateAndInsertTests(req.params.id, scope, scope_entity_id, userId(req));
    res.json(r);
  } catch (err) {
    console.error('[test-cases/generate]', err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// LIBRARY
// ──────────────────────────────────────────────
app.get('/api/v1/library', (req, res) => {
  const { scope, type } = req.query;
  const scopeFilter = scope ? `AND uc.visibility_scope = '${scope.replace(/'/g, "''")}'` : '';

  const results = {};

  if (!type || type === 'use_case') {
    results.use_cases = db.prepare(
      `SELECT 'use_case' AS record_type, uc.use_case_id AS id, uc.title AS name,
              uc.visibility_scope, uc.lifecycle_status, uc.summary AS description,
              uc.project_id, p.project_name, p.project_code, c.client_name,
              uc.readiness, uc.business_objective, uc.expected_value,
              uc.created_at, uc.updated_at
       FROM asdlc_use_case uc
       LEFT JOIN asdlc_project p ON p.project_id = uc.project_id
       LEFT JOIN asdlc_client c ON c.client_id = p.client_id
       WHERE uc.lifecycle_status != 'deleted' ${scopeFilter}`
    ).all();
  }
  if (!type || type === 'workflow') {
    const wfScope = scope ? `AND wf.visibility_scope = '${scope.replace(/'/g, "''")}'` : '';
    results.workflows = db.prepare(
      `SELECT 'workflow' AS record_type, wf.workflow_id AS id, wf.name,
              wf.visibility_scope, wf.lifecycle_status, wf.readiness AS description,
              wf.project_id, p.project_name, p.project_code, c.client_name,
              wf.sla_hours, wf.created_at, wf.updated_at
       FROM asdlc_workflow wf
       LEFT JOIN asdlc_project p ON p.project_id = wf.project_id
       LEFT JOIN asdlc_client c ON c.client_id = p.client_id
       WHERE wf.lifecycle_status != 'deleted' ${wfScope}`
    ).all();
  }
  if (!type || type === 'tool') {
    const toolScope = scope ? `AND t.visibility_scope = '${scope.replace(/'/g, "''")}'` : '';
    results.tools = db.prepare(
      `SELECT 'tool' AS record_type, t.tool_id AS id, t.name,
              t.visibility_scope, t.lifecycle_status, t.contract AS description,
              t.project_id, p.project_name, p.project_code, c.client_name,
              t.execution_mode, t.cost_impact, t.access_requirements,
              t.created_at, t.updated_at
       FROM asdlc_tool t
       LEFT JOIN asdlc_project p ON p.project_id = t.project_id
       LEFT JOIN asdlc_client c ON c.client_id = p.client_id
       WHERE t.lifecycle_status = 'active' ${toolScope}`
    ).all();
  }
  if (!type || type === 'knowledge_article') {
    const kaScope = scope ? `AND ka.visibility_scope = '${scope.replace(/'/g, "''")}'` : '';
    results.knowledge_articles = db.prepare(
      `SELECT 'knowledge_article' AS record_type, ka.knowledge_article_id AS id, ka.title AS name,
              ka.visibility_scope, ka.lifecycle_status, ka.body AS description,
              ka.project_id, p.project_name, p.project_code, c.client_name,
              ka.created_at, ka.updated_at
       FROM asdlc_knowledge_article ka
       LEFT JOIN asdlc_project p ON p.project_id = ka.project_id
       LEFT JOIN asdlc_client c ON c.client_id = p.client_id
       WHERE ka.lifecycle_status != 'deleted' ${kaScope}`
    ).all();
  }

  res.json(results);
});

/**
 * GET /api/v1/projects/:id/version-history
 * Returns audit log entries where the project's version counter was incremented,
 * along with the nearest approved Change Packet at that timestamp.
 */
app.get('/api/v1/projects/:id/version-history', (req, res) => {
  const project = db.prepare('SELECT * FROM asdlc_project WHERE project_id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  // Audit entries for this project where version changed
  const auditRows = db.prepare(`
    SELECT al.*, u.display_name AS changed_by_name
    FROM asdlc_audit_log al
    LEFT JOIN asdlc_user u ON u.user_id = al.changed_by
    WHERE al.table_name = 'asdlc_project'
      AND al.record_id  = ?
      AND json_extract(al.new_data, '$.version') IS NOT NULL
    ORDER BY al.changed_at DESC
    LIMIT 100
  `).all(req.params.id);

  // Filter to rows where version actually changed
  const versionEvents = auditRows
    .map(r => {
      const oldD = parseJson(r.old_data) || {};
      const newD = parseJson(r.new_data) || {};
      return {
        ...r,
        old_version:        oldD.version ?? null,
        new_version:        newD.version ?? null,
        old_version_string: oldD.version_string ?? null,
        new_version_string: newD.version_string ?? null,
      };
    })
    .filter(r => r.old_version !== r.new_version);

  // For each event, find the nearest CP approval around that timestamp (±5 seconds)
  const cpNear = db.prepare(`
    SELECT change_packet_id, packet_code, summary, approval_timestamp
    FROM asdlc_change_packet
    WHERE project_id = ? AND status = 'approved'
      AND abs(strftime('%s', approval_timestamp) - strftime('%s', ?)) < 10
    ORDER BY abs(strftime('%s', approval_timestamp) - strftime('%s', ?))
    LIMIT 1
  `);

  const events = versionEvents.map(ev => {
    const cp = cpNear.get(req.params.id, ev.changed_at, ev.changed_at);
    return {
      audit_id:           ev.audit_id,
      changed_at:         ev.changed_at,
      old_version:        ev.old_version,
      new_version:        ev.new_version,
      old_version_string: ev.old_version_string,
      new_version_string: ev.new_version_string,
      changed_by:         ev.changed_by,
      changed_by_name:    ev.changed_by_name || null,
      triggered_by_cp:    cp ? { change_packet_id: cp.change_packet_id, packet_code: cp.packet_code, summary: cp.summary } : null,
    };
  });

  res.json({
    project_id:             project.project_id,
    project_name:           project.project_name,
    current_version:        project.version,
    current_version_string: project.version_string || '1.0.0',
    events,
  });
});

// ──────────────────────────────────────────────
// DESIGN REPORTS
// ──────────────────────────────────────────────

/**
 * GET /api/v1/projects/:id/design-report/agents
 * Returns all agent design content for a project in a single aggregated payload,
 * ready for the Design Review module to render as a human-readable report.
 */
app.get('/api/v1/projects/:id/design-report/agents', (req, res) => {
  const project = db.prepare(`
    SELECT p.*, c.client_name, c.client_code
    FROM asdlc_project p
    LEFT JOIN asdlc_client c ON c.client_id = p.client_id
    WHERE p.project_id = ?
  `).get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const agentRows = db.prepare(
    "SELECT * FROM asdlc_agent_spec WHERE project_id = ? AND lifecycle_status != 'deleted' ORDER BY name"
  ).all(req.params.id);

  // Phase 4: cost params merged from global pricing + per-app planning/entitlement
  const agentCostAssumption = getEffectiveCostParams(req.params.id);
  const agentCostPerAssist = agentCostAssumption.cost_per_assist || 0.015;

  // Ingest document for extraction rows (guardrails, data_sources)
  const ingestDoc = db.prepare(
    "SELECT ingest_id FROM asdlc_ingest_document WHERE project_id = ? ORDER BY created_at DESC LIMIT 1"
  ).get(req.params.id);

  const extractionsByType = {};
  if (ingestDoc) {
    ['guardrail', 'data_source'].forEach(etype => {
      extractionsByType[etype] = db.prepare(
        'SELECT entity_data FROM asdlc_ingest_extraction WHERE ingest_id = ? AND entity_type = ? ORDER BY rowid'
      ).all(ingestDoc.ingest_id, etype).map(r => parseJson(r.entity_data) || {});
    });
  }

  const tools = db.prepare(
    "SELECT * FROM asdlc_tool WHERE project_id = ? AND lifecycle_status = 'active' ORDER BY name"
  ).all(req.params.id).map(t => ({
    tool_id: t.tool_id,
    slug: t.slug,                                                // Phase 1
    name: t.name,
    contract: parseJson(t.contract) || {},
    inputs: parseJson(t.inputs) || {},
    outputs: parseJson(t.outputs) || {},
    errors: parseJson(t.errors) || [],
    access_requirements: parseJson(t.access_requirements) || t.access_requirements,
    execution_mode: t.execution_mode,
    cost_impact: t.cost_impact,
    dev_status: t.dev_status || null,                            // Phase 1
    visibility_scope: t.visibility_scope || 'PROJECT',           // Phase 1: surfaces scope
    boundaries: parseJson(t.boundaries) || [],
    system_generated: t.system_generated ? 1 : 0,
  }));

  const agents = agentRows.map(agent => {
    // Phase 3: fetch linked UCs via join table (M:N)
    const ucLinks = db.prepare(`
      SELECT auc.agent_use_case_id, auc.business_value, auc.notes,
             uc.use_case_id, uc.slug, uc.title, uc.summary, uc.business_objective,
             uc.success_criteria, uc.constraints_list
      FROM asdlc_agent_use_case auc
      JOIN asdlc_use_case uc ON uc.use_case_id = auc.use_case_id
      WHERE auc.agent_spec_id = ?
      ORDER BY auc.created_at
    `).all(agent.agent_spec_id).map(r => ({
      agent_use_case_id:  r.agent_use_case_id,
      use_case_id:        r.use_case_id,
      slug:               r.slug,
      title:              r.title,
      summary:            r.summary,
      business_objective: r.business_objective,
      success_criteria:   parseJson(r.success_criteria) || [],
      constraints:        parseJson(r.constraints_list) || [],
      business_value:     r.business_value,
      notes:              r.notes
    }));

    // Phase 3: fetch tool bindings
    const toolBindings = db.prepare(`
      SELECT at.agent_tool_id, at.tool_id, at.purpose, at.fallback_behavior,
             at.binding_supervision_model, at.tool_execution_mode,
             at.linked_user_story_refs, at.details,
             t.name AS tool_name, t.slug AS tool_slug, t.dev_status, t.execution_mode,
             t.system_generated AS tool_system_generated
      FROM asdlc_agent_tool at
      JOIN asdlc_tool t ON t.tool_id = at.tool_id
      WHERE at.agent_spec_id = ?
      ORDER BY t.name
    `).all(agent.agent_spec_id);

    const workflow = agent.workflow_id
      ? db.prepare('SELECT * FROM asdlc_workflow WHERE workflow_id = ?').get(agent.workflow_id)
      : null;

    const steps = workflow
      ? db.prepare('SELECT * FROM asdlc_workflow_step WHERE workflow_id = ? ORDER BY step_number').all(workflow.workflow_id)
          .map(s => ({
            workflow_step_id: s.workflow_step_id,
            workflow_id:  s.workflow_id,
            step_number:  s.step_number,
            name:         s.name,
            actor_role:   s.actor_role,
            inputs:       parseJson(s.inputs) || {},
            outputs:      parseJson(s.outputs) || {},
            decisions:    parseJson(s.decisions_list) || [],
            sla_hours:    s.sla_hours,
            hitl_gate_id: s.hitl_gate_id,
            system_generated: s.system_generated ? 1 : 0,
          }))
      : [];

    const hitlGates = workflow
      ? db.prepare('SELECT * FROM asdlc_hitl_gate WHERE workflow_id = ?').all(workflow.workflow_id)
          .map(h => ({
            hitl_gate_id: h.hitl_gate_id,
            gate_type: h.gate_type,
            criteria: h.criteria,
            owner_role: h.owner_role,
            sla: h.sla,
            handoff_mechanism: h.handoff_mechanism
          }))
      : [];

    return {
      agent_spec_id: agent.agent_spec_id,
      project_id: agent.project_id,                             // Phase 3: needed by frontend for API calls
      slug: agent.slug,                                          // Phase 1
      name: agent.name,
      lifecycle_status: agent.lifecycle_status,
      scope: agent.scope,
      instructions: agent.instructions,
      goals: parseJson(agent.goals) || [],
      done_criteria: parseJson(agent.done_criteria) || [],
      inputs: parseJson(agent.inputs) || {},
      outputs: parseJson(agent.outputs) || {},
      run_as_model: parseJson(agent.run_as_model) || {},
      memory_strategy: agent.memory_strategy,
      design_risks: parseJson(agent.design_risks) || [],
      // ── Phase 1 additions ─────────────────────────────────────
      supervision_model:       agent.supervision_model || null,
      maintenance_owner:       agent.maintenance_owner || null,
      orchestration_strategy:  agent.orchestration_strategy || null,
      latency_target:          agent.latency_target || null,
      post_release_validation: agent.post_release_validation || null,
      cost_model:              agent.cost_model || 'none',
      system_generated:        agent.system_generated ? 1 : 0,
      // ── Phase 3: M:N use cases + tool bindings ────────────────
      use_cases: ucLinks,               // array of linked UCs (replaces single use_case)
      tool_bindings: toolBindings,      // array of agent↔tool bindings
      // ── Phase 4: agent cost = sum of owned step costs ──────────
      agent_cost_per_period: (() => {
        // Find all steps owned by this agent's participants, across all workflows
        const ownedStepCosts = db.prepare(`
          SELECT b.qty_per_run, b.branch_probability, r.assists_per_unit,
                 wf.runs_per_period
          FROM asdlc_workflow_step_cost_binding b
          JOIN asdlc_assist_rate_card r ON r.skill_name = b.skill_name
          JOIN asdlc_workflow_step s ON s.workflow_step_id = b.workflow_step_id
          JOIN asdlc_workflow wf ON wf.workflow_id = s.workflow_id
          JOIN asdlc_workflow_participant p ON p.workflow_participant_id = s.owner_participant_id
          WHERE p.agent_spec_id = ? AND wf.project_id = ?
        `).all(agent.agent_spec_id, agent.project_id);
        return ownedStepCosts.reduce((sum, c) => {
          const rpp = c.runs_per_period || 0;
          return sum + c.qty_per_run * (c.branch_probability ?? 1.0) * c.assists_per_unit * rpp * agentCostPerAssist;
        }, 0);
      })(),
      workflow: workflow ? {
        workflow_id: workflow.workflow_id,
        slug: workflow.slug,                                     // Phase 1
        name: workflow.name,
        trigger: parseJson(workflow.trigger_def) || {},
        sla_hours: workflow.sla_hours,
        handoffs: parseJson(workflow.handoffs) || [],
        steps,
        hitl_gates: hitlGates
      } : null,
      tools,
      guardrails: extractionsByType['guardrail'] || [],
      data_sources: extractionsByType['data_source'] || []
    };
  });

  res.json({
    project: {
      project_id: project.project_id,
      project_name: project.project_name,
      project_code: project.project_code,
      client_name: project.client_name,
      stage: project.stage
    },
    generated_at: new Date().toISOString(),
    agents
  });
});

/**
 * GET /api/v1/projects/:id/design-report/workflows
 * All workflows for a project with steps, HITL gates, handoffs, test scenarios, and user stories.
 */
app.get('/api/v1/projects/:id/design-report/workflows', (req, res) => {
  const project = db.prepare(`
    SELECT p.*, c.client_name FROM asdlc_project p
    LEFT JOIN asdlc_client c ON c.client_id = p.client_id
    WHERE p.project_id = ?
  `).get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const workflowRows = db.prepare(
    "SELECT * FROM asdlc_workflow WHERE project_id = ? AND lifecycle_status != 'deleted' ORDER BY name"
  ).all(req.params.id);

  // Phase 4: cost params merged from global pricing + per-app planning/entitlement
  const costAssumption = getEffectiveCostParams(req.params.id);
  const costPerAssist = costAssumption.cost_per_assist || 0.015;

  // Extraction rows: test_scenario + user_story (scoped to project's ingest doc)
  const ingestDoc = db.prepare(
    'SELECT ingest_id FROM asdlc_ingest_document WHERE project_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(req.params.id);
  const extractionsByType = {};
  if (ingestDoc) {
    ['test_scenario', 'user_story'].forEach(etype => {
      extractionsByType[etype] = db.prepare(
        'SELECT entity_data FROM asdlc_ingest_extraction WHERE ingest_id = ? AND entity_type = ? ORDER BY rowid'
      ).all(ingestDoc.ingest_id, etype).map(r => parseJson(r.entity_data) || {});
    });
  }

  const workflows = workflowRows.map(wf => {
    const steps = db.prepare(
      'SELECT * FROM asdlc_workflow_step WHERE workflow_id = ? ORDER BY step_number'
    ).all(wf.workflow_id);

    const hitlGates = db.prepare(
      'SELECT * FROM asdlc_hitl_gate WHERE workflow_id = ?'
    ).all(wf.workflow_id);
    const hitlById = {};
    hitlGates.forEach(h => { hitlById[h.hitl_gate_id] = h; });

    // Use case: try workflow.use_case_id first, then via agent_spec FK
    let useCase = wf.use_case_id
      ? db.prepare('SELECT use_case_id, title, summary, business_objective FROM asdlc_use_case WHERE use_case_id = ?').get(wf.use_case_id)
      : db.prepare(`
          SELECT uc.use_case_id, uc.title, uc.summary, uc.business_objective
          FROM asdlc_use_case uc
          JOIN asdlc_agent_spec asp ON asp.use_case_id = uc.use_case_id
          WHERE asp.workflow_id = ? LIMIT 1
        `).get(wf.workflow_id);

    const linkedAgents = db.prepare(
      "SELECT name, lifecycle_status FROM asdlc_agent_spec WHERE workflow_id = ? AND lifecycle_status != 'deleted'"
    ).all(wf.workflow_id);

    // Phase 2: participants, RASIC matrix, paths
    const participants = db.prepare(`
      SELECT p.*, a.name AS agent_name, a.slug AS agent_slug
      FROM asdlc_workflow_participant p
      LEFT JOIN asdlc_agent_spec a ON a.agent_spec_id = p.agent_spec_id
      WHERE p.workflow_id = ? AND p.lifecycle_status != 'deleted'
      ORDER BY p.lane_order, p.created_at
    `).all(wf.workflow_id);

    // Build RASIC matrix: {step_id: {participant_id: [{code, rasic_id}]}}
    const rasicRows = db.prepare(`
      SELECT r.rasic_id, r.workflow_step_id, r.workflow_participant_id, r.code
      FROM asdlc_workflow_step_rasic r
      JOIN asdlc_workflow_step s ON s.workflow_step_id = r.workflow_step_id
      WHERE s.workflow_id = ?
      ORDER BY s.step_number, r.code
    `).all(wf.workflow_id);
    const rasicByStep = {};
    rasicRows.forEach(r => {
      if (!rasicByStep[r.workflow_step_id]) rasicByStep[r.workflow_step_id] = {};
      if (!rasicByStep[r.workflow_step_id][r.workflow_participant_id]) rasicByStep[r.workflow_step_id][r.workflow_participant_id] = [];
      rasicByStep[r.workflow_step_id][r.workflow_participant_id].push({ code: r.code, rasic_id: r.rasic_id });
    });

    const paths = db.prepare(`
      SELECT p.*,
             fs.step_number AS from_step_number, fs.name AS from_step_name,
             ts.step_number AS to_step_number,   ts.name AS to_step_name
      FROM asdlc_workflow_path p
      JOIN asdlc_workflow_step fs ON fs.workflow_step_id = p.from_step_id
      JOIN asdlc_workflow_step ts ON ts.workflow_step_id = p.to_step_id
      WHERE p.workflow_id = ?
      ORDER BY fs.step_number, p.is_default_path DESC, p.created_at
    `).all(wf.workflow_id);

    const result = {
      workflow_id: wf.workflow_id,
      slug:        wf.slug,                                       // Phase 1
      name: wf.name,
      lifecycle_status: wf.lifecycle_status,
      readiness: wf.readiness,
      system_generated: wf.system_generated ? 1 : 0,
      trigger:        parseJson(wf.trigger_def)     || {},
      sla_hours:      wf.sla_hours,
      handoffs:       parseJson(wf.handoffs)         || [],
      decisions:      parseJson(wf.decisions)        || [],
      fallback_paths: parseJson(wf.fallback_paths)   || [],
      // ── Phase 1 additions ───────────────────────────────────────
      risk_tier:       wf.risk_tier || null,
      runs_per_period: wf.runs_per_period != null ? wf.runs_per_period : null,
      // ── Phase 2 additions ───────────────────────────────────────
      participants,
      rasic_by_step: rasicByStep,   // {step_id: {participant_id: ['R','A',...]}}
      paths,
      steps: steps.map(s => {
        // Phase 4: fetch cost bindings for this step
        const costBindings = db.prepare(`
          SELECT b.binding_id, b.skill_name, b.qty_per_run, b.branch_probability,
                 b.ai_generated, b.ai_reasoning, b.notes, r.assists_per_unit, r.category
          FROM asdlc_workflow_step_cost_binding b
          JOIN asdlc_assist_rate_card r ON r.skill_name = b.skill_name
          WHERE b.workflow_step_id = ?
          ORDER BY b.created_at
        `).all(s.workflow_step_id);
        const runsPerPeriod = wf.runs_per_period || 0;
        const stepCostPerPeriod = runsPerPeriod > 0 ? costBindings.reduce((sum, b) => {
          return sum + b.qty_per_run * (b.branch_probability ?? 1.0) * b.assists_per_unit * runsPerPeriod * costPerAssist;
        }, 0) : 0;
        return {
          workflow_step_id: s.workflow_step_id,
          workflow_id:  s.workflow_id,
          slug:         s.slug,                                     // Phase 1
          step_number:  s.step_number,
          name:         s.name,
          actor_role:   s.actor_role,
          system_generated: s.system_generated ? 1 : 0,
          inputs:       parseJson(s.inputs)        || {},
          outputs:      parseJson(s.outputs)       || {},
          decisions:    parseJson(s.decisions_list) || [],
          sla_hours:    s.sla_hours,
          hitl_gate:    s.hitl_gate_id ? (hitlById[s.hitl_gate_id] || null) : null,
          // ── Phase 1 step additions ──────────────────────────────
          step_type:         s.step_type || null,
          step_purpose:      s.step_purpose || null,
          preconditions:     s.preconditions || null,
          evidence_captured: s.evidence_captured || null,
          is_end_step:       s.is_end_step ? true : false,
          // ── Phase 2 ─────────────────────────────────────────────
          owner_participant_id: s.owner_participant_id || null,
          // ── Phase 4: cost ───────────────────────────────────────
          cost_bindings:       costBindings,
          step_cost_per_period: stepCostPerPeriod,
        };
      }),
      hitl_gates: hitlGates.map(h => ({
        gate_type:         h.gate_type,
        criteria:          h.criteria,
        owner_role:        h.owner_role,
        sla:               h.sla,
        handoff_mechanism: h.handoff_mechanism,
      })),
      use_case:      useCase || null,
      linked_agents: linkedAgents,
      test_scenarios: extractionsByType['test_scenario'] || [],
      user_stories:   extractionsByType['user_story']    || [],
    };
    // Phase 4: workflow total cost = sum of step costs (steps already built above)
    result.workflow_cost_per_period = result.steps.reduce((s, step) => s + (step.step_cost_per_period || 0), 0);
    return result;
  });

  res.json({
    project: {
      project_id: project.project_id, project_name: project.project_name,
      project_code: project.project_code, client_name: project.client_name, stage: project.stage,
    },
    generated_at: new Date().toISOString(),
    workflows,
  });
});

/**
 * GET /api/v1/projects/:id/design-report/tools
 * All tools for a project with full contract, inputs, outputs, errors, and integration details.
 */
app.get('/api/v1/projects/:id/design-report/tools', (req, res) => {
  const project = db.prepare(`
    SELECT p.*, c.client_name FROM asdlc_project p
    LEFT JOIN asdlc_client c ON c.client_id = p.client_id
    WHERE p.project_id = ?
  `).get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const toolRows = db.prepare(
    "SELECT * FROM asdlc_tool WHERE project_id = ? AND lifecycle_status = 'active' ORDER BY name"
  ).all(req.params.id);

  // All agents in this project act as the "used by" reference
  // (asdlc_agent_tool join table is not populated in MVP 1)
  const agentsInProject = db.prepare(
    "SELECT agent_spec_id, name, lifecycle_status FROM asdlc_agent_spec WHERE project_id = ? AND lifecycle_status != 'deleted'"
  ).all(req.params.id);

  const tools = toolRows.map(t => ({
    tool_id:              t.tool_id,
    slug:                 t.slug,                                 // Phase 1
    name:                 t.name,
    lifecycle_status:     t.lifecycle_status,
    system_generated:     t.system_generated ? 1 : 0,
    contract:             parseJson(t.contract)    || {},
    inputs:               parseJson(t.inputs)      || {},
    outputs:              parseJson(t.outputs)     || {},
    errors:               parseJson(t.errors)      || [],
    access_requirements:  parseJson(t.access_requirements) || t.access_requirements,
    execution_mode:       t.execution_mode,
    cost_impact:          t.cost_impact,
    boundaries:           parseJson(t.boundaries)  || [],
    dev_status:           t.dev_status || null,                   // Phase 1
    visibility_scope:     t.visibility_scope || 'PROJECT',        // Phase 1
    used_by_agents:       agentsInProject,
  }));

  res.json({
    project: {
      project_id: project.project_id, project_name: project.project_name,
      project_code: project.project_code, client_name: project.client_name, stage: project.stage,
    },
    generated_at: new Date().toISOString(),
    tools,
  });
});

// ─── Extraction-based report factory ──────────────────────────────────────────
function extractionReport(entityType, responseKey) {
  return (req, res) => {
    const project = db.prepare(`
      SELECT p.*, c.client_name FROM asdlc_project p
      LEFT JOIN asdlc_client c ON c.client_id = p.client_id
      WHERE p.project_id = ?
    `).get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const ingestDoc = db.prepare(
      'SELECT * FROM asdlc_ingest_document WHERE project_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(req.params.id);

    const items = ingestDoc
      ? db.prepare(
          'SELECT entity_data FROM asdlc_ingest_extraction WHERE ingest_id = ? AND entity_type = ? ORDER BY rowid'
        ).all(ingestDoc.ingest_id, entityType).map(r => parseJson(r.entity_data) || {})
      : [];

    res.json({
      project: {
        project_id: project.project_id, project_name: project.project_name,
        project_code: project.project_code, client_name: project.client_name, stage: project.stage,
      },
      generated_at: new Date().toISOString(),
      [responseKey]: items,
      ingest_document: ingestDoc
        ? { ingest_id: ingestDoc.ingest_id, document_title: ingestDoc.document_title || ingestDoc.title || ingestDoc.file_name }
        : null,
    });
  };
}

app.get('/api/v1/projects/:id/design-report/guardrails',     extractionReport('guardrail',          'guardrails'));
app.get('/api/v1/projects/:id/design-report/data-sources',   extractionReport('data_source',        'data_sources'));
app.get('/api/v1/projects/:id/design-report/test-scenarios', extractionReport('test_scenario',      'test_scenarios'));
app.get('/api/v1/projects/:id/design-report/user-stories',   extractionReport('user_story',         'user_stories'));
app.get('/api/v1/projects/:id/design-report/governance',     extractionReport('governance_control', 'governance_controls'));

// ═══════════════════════════════════════════════════════════════════════════
// ServiceNow round-trip: Level-1 design types — design-report (list) + GET/PUT.
// These are materialized into real tables, so they read from the table (like
// tools), not from raw extractions. Provenance columns (source_*) are Level-2
// and intentionally NOT editable here — hidden from non-technical Level-1 editors.
// ═══════════════════════════════════════════════════════════════════════════
const RT_DESIGN = {
  'data-models':    { table: 'asdlc_data_model',     pk: 'data_model_id',     key: 'data_models',   entity_type: 'data_model',
                      json: ['fields', 'relationships'],
                      allowed: ['name', 'purpose', 'physical_name', 'extends_table', 'fields', 'relationships', 'audited'] },
  'form-designs':   { table: 'asdlc_form_design',    pk: 'form_design_id',    key: 'form_designs',  entity_type: 'form_design',
                      json: ['sections', 'related_lists', 'mandatory_fields', 'readonly_fields'],
                      allowed: ['name', 'view_name', 'sections', 'related_lists', 'mandatory_fields', 'readonly_fields', 'behavior_notes'] },
  'business-logic': { table: 'asdlc_business_logic', pk: 'business_logic_id', key: 'business_logic', entity_type: 'business_logic',
                      json: [],
                      allowed: ['name', 'logic_type', 'plain_english', 'when_runs', 'conditions', 'run_order'],
                      enums: { logic_type: ['business_rule','client_script','script_include','ui_action','scheduled_job','ui_policy'] } },
  'catalog-items':  { table: 'asdlc_catalog_item',   pk: 'catalog_item_id',   key: 'catalog_items', entity_type: 'catalog_item',
                      json: ['variables'],
                      allowed: ['name', 'short_description', 'category', 'variables', 'who_can_order', 'delivery_time'] },
  'integrations':   { table: 'asdlc_integration',    pk: 'integration_id',    key: 'integrations',  entity_type: 'integration',
                      json: ['functions'],
                      allowed: ['name', 'description', 'endpoint', 'auth_type', 'functions', 'alias_type', 'connection_type', 'notes'],
                      enums: { auth_type: ['noAuthentication','basic','oauth2'], alias_type: ['connection','credential'], connection_type: ['httpConnection','jdbcConnection','basicConnection','jmsConnection'] } },
};

// Config-driven entities: merge RT_DESIGN specs derived from registry `display`
// blocks (Dashboards/Reports/KPIs/NL rules). Hand-written entries above always win —
// the guard means a future hand-tuned spec is never clobbered by the derived one.
for (const e of registry.entitiesWithDisplay()) {
  if (RT_DESIGN[e.display.scope_id]) continue;
  RT_DESIGN[e.display.scope_id] = registry.rtDesignSpec(e);
}

function rtParseRow(row, jsonCols) {
  if (!row) return row;
  const out = { ...row };
  for (const c of jsonCols) if (c in out) out[c] = parseJson(out[c]);
  return out;
}

function rtDesignReport(spec) {
  return (req, res) => {
    const project = db.prepare(`
      SELECT p.*, c.client_name FROM asdlc_project p
      LEFT JOIN asdlc_client c ON c.client_id = p.client_id
      WHERE p.project_id = ?
    `).get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const rows = db.prepare(
      `SELECT * FROM ${spec.table} WHERE project_id = ? AND lifecycle_status = 'active' ORDER BY slug`
    ).all(req.params.id).map(r => rtParseRow(r, spec.json));
    res.json({
      project: {
        project_id: project.project_id, project_name: project.project_name,
        project_code: project.project_code, client_name: project.client_name, stage: project.stage,
      },
      generated_at: new Date().toISOString(),
      [spec.key]: rows,
    });
  };
}

for (const [scope, spec] of Object.entries(RT_DESIGN)) {
  // Design Review report (list)
  app.get(`/api/v1/projects/:id/design-report/${scope}`, rtDesignReport(spec));

  // Single GET — the edit modal loads current values from here.
  app.get(`/api/v1/projects/:id/${scope}/:eid`, (req, res) => {
    const row = db.prepare(`SELECT * FROM ${spec.table} WHERE ${spec.pk} = ? AND project_id = ?`)
      .get(req.params.eid, req.params.id);
    if (!row) return res.status(404).json({ error: `${spec.entity_type} not found` });
    res.json(rtParseRow(row, spec.json));
  });

  // Single PUT — Level-1 edit → direct update + auto-approved CP (history), like
  // the other design-review edit endpoints. Provenance columns are never in `allowed`.
  app.put(`/api/v1/projects/:id/${scope}/:eid`, (req, res) => {
    const uid = userId(req);
    const existing = db.prepare(`SELECT * FROM ${spec.table} WHERE ${spec.pk} = ? AND project_id = ?`)
      .get(req.params.eid, req.params.id);
    if (!existing) return res.status(404).json({ error: `${spec.entity_type} not found` });

    const updates = {};
    spec.allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No updatable fields provided' });

    if (spec.enums) {
      try {
        for (const [col, vals] of Object.entries(spec.enums)) {
          if (updates[col] !== undefined) validateEnum(updates[col], vals, col);
        }
      } catch (err) { return res.status(400).json({ error: err.message }); }
    }

    const toWrite = { ...updates };
    for (const c of spec.json) if (c in toWrite && typeof toWrite[c] !== 'string') toWrite[c] = JSON.stringify(toWrite[c]);

    const setCols = Object.keys(toWrite);
    db.prepare(
      `UPDATE ${spec.table} SET ${setCols.map(c => `${c} = ?`).join(', ')}, version = version + 1,
        updated_by = ?, updated_at = datetime('now') WHERE ${spec.pk} = ?`
    ).run(...setCols.map(c => toWrite[c]), uid, req.params.eid);

    const after = db.prepare(`SELECT * FROM ${spec.table} WHERE ${spec.pk} = ?`).get(req.params.eid);
    auditLog(spec.table, req.params.eid, 'UPDATE', existing, after, uid);

    const diff = diffFields(existing, updates, spec.json);
    let cpResult = null;
    if (diff.length > 0) {
      cpResult = createAutoApprovedCP(req.params.id, spec.entity_type, req.params.eid,
        existing.name || existing.title || req.params.eid, diff, uid);
    }
    res.json({ ...rtParseRow(after, spec.json), _cp: cpResult });
  });

  // Single POST — create a new row. Only for config-driven (display) entities so the
  // hardcoded FK-parented RT types keep their ingest-only create path. Enables
  // PO-authoring (e.g. an NL rule, a dashboard) directly in the UI, with an audit CP.
  const regEntry = registry.byEntityType[spec.entity_type];
  const isDisplayEntity = regEntry && regEntry.display && regEntry.display.scope_id === scope;
  if (isDisplayEntity) {
    app.post(`/api/v1/projects/:id/${scope}`, (req, res) => {
      const uid = userId(req);
      const project = db.prepare('SELECT project_id FROM asdlc_project WHERE project_id = ?').get(req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const name = (req.body && (req.body.name || req.body.title) || '').trim();
      if (!name) return res.status(400).json({ error: 'name is required' });

      const insert = {};
      spec.allowed.forEach(f => { if (req.body[f] !== undefined) insert[f] = req.body[f]; });
      insert.name = name;
      if (spec.enums) {
        try {
          for (const [col, vals] of Object.entries(spec.enums)) {
            if (insert[col] !== undefined && insert[col] !== '' && insert[col] != null) validateEnum(insert[col], vals, col);
          }
        } catch (err) { return res.status(400).json({ error: err.message }); }
      }
      for (const c of spec.json) if (c in insert && typeof insert[c] !== 'string') insert[c] = JSON.stringify(insert[c]);
      Object.assign(insert, regEntry.staticColumns || {});   // e.g. NL rules rule_kind

      const id   = generateId();
      const slug = regEntry.slugPrefix ? nextSlug(spec.table, regEntry.slugPrefix, req.params.id) : null;
      const cols = [spec.pk, 'project_id', ...(slug ? ['slug'] : []), ...Object.keys(insert), 'created_by', 'updated_by'];
      const vals = [id, req.params.id, ...(slug ? [slug] : []), ...Object.keys(insert).map(k => insert[k]), uid, uid];
      db.prepare(`INSERT INTO ${spec.table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);

      const after = db.prepare(`SELECT * FROM ${spec.table} WHERE ${spec.pk} = ?`).get(id);
      auditLog(spec.table, id, 'CREATE', null, after, uid);
      const cpResult = createAutoApprovedCP(req.params.id, spec.entity_type, id, name,
        [{ field: 'name', old: null, new: name }], uid);
      res.json({ ...rtParseRow(after, spec.json), _cp: cpResult });
    });
  }
}

// ─── Design-entity catalog (config-driven engine) ────────────────────────────
// Single source of truth for the frontend: the registry `display` blocks projected
// for generic rendering/editing. Global (identical per project) — the SPA caches it
// once and merges into its hardcoded tabs (hardcoded wins on key collision).
app.get('/api/v1/design-entity-catalog', (_req, res) => {
  res.json({ entities: registry.designEntityCatalog() });
});

// ─── NL rules: AI reverse-engineering + gap-prompting ────────────────────────
// reverse-engineer: read a captured implementation script (asdlc_sn_artifact whose
// source_table is sys_script*) and emit a PLAIN-ENGLISH candidate rule for PO review.
app.post('/api/v1/projects/:id/nl-rules/reverse-engineer', async (req, res) => {
  const uid = userId(req);
  const projectId = req.params.id;
  const project = db.prepare('SELECT project_id FROM asdlc_project WHERE project_id = ?').get(projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { artifact_id, rule_kind } = req.body || {};
  if (!artifact_id) return res.status(400).json({ error: 'artifact_id is required (an asdlc_sn_artifact id for a captured script)' });
  const kind = rule_kind === 'validation' ? 'validation' : 'business';

  const art = db.prepare('SELECT * FROM asdlc_sn_artifact WHERE sn_artifact_id = ? AND project_id = ?').get(artifact_id, projectId);
  if (!art) return res.status(404).json({ error: 'Source artifact not found in this project' });

  // Build an artifact-like object the reverse-engineer expects (salient carries the script + context).
  const payload = parseJson(art.payload) || {};
  const salient = {};
  for (const k of ['name', 'collection', 'table', 'when', 'condition', 'script', 'description']) {
    if (payload[k] != null && payload[k] !== '') salient[k] = payload[k];
  }
  const reArtifact = {
    source_table: art.source_table || 'sys_script',
    source_sys_id: art.source_sys_id || null,
    source_scope: art.source_scope || null,
    name: art.name,
    salient,
  };

  let result;
  try {
    const { reverseEngineerNlRule } = require('./agent/sn-reverse-engineer');
    result = await reverseEngineerNlRule(reArtifact, { projectId });
  } catch (err) {
    return res.status(502).json({ error: `Reverse-engineering failed: ${err.message}` });
  }
  const rule = result.rule || {};

  const id   = generateId();
  const slug = nextSlug('asdlc_nl_rule', 'NLR', projectId);
  db.prepare(`INSERT INTO asdlc_nl_rule
      (nl_rule_id, project_id, slug, rule_kind, name, rule_text, linked_table, linked_field,
       status, rationale, confidence, source_system, source_sys_id, source_table, source_scope,
       created_by, updated_by)
      VALUES (?,?,?,?,?,?,?,?, 'reverse_engineered', ?,?, 'workbench', ?,?,?, ?,?)`)
    .run(id, projectId, slug, kind, rule.name || art.name || '(unnamed rule)', rule.rule_text || '',
      rule.linked_table || null, rule.linked_field || null, rule.rationale || null,
      typeof rule.confidence === 'number' ? rule.confidence : null,
      reArtifact.source_sys_id, reArtifact.source_table, reArtifact.source_scope, uid, uid);

  const after = db.prepare('SELECT * FROM asdlc_nl_rule WHERE nl_rule_id = ?').get(id);
  auditLog('asdlc_nl_rule', id, 'CREATE', null, after, uid);
  const entityType = kind === 'validation' ? 'nl_validation_rule' : 'nl_business_rule';
  const cpResult = createAutoApprovedCP(projectId, entityType, id, after.name,
    [{ field: 'rule_text', old: null, new: after.rule_text }], uid);

  res.json({ ...after, _cp: cpResult, _stub: !!result.stub, _confidence: rule.confidence });
});

// ── "Explain with AI" — on-request narration of ONE business_logic record ─────────────
// Business logic imports deterministically with a BLANK plain-English narrative (#103): the
// raw script is preserved for drift/redeploy and needs no AI. This endpoint narrates a single
// record ON DEMAND — the only place the reverse-engineer AI runs for business logic — reading
// the stored script (source_fluent) and forcing the AI path past the deterministic short-circuit.
app.post('/api/v1/projects/:id/design/business-logic/:blId/explain', async (req, res) => {
  const uid = userId(req);
  const projectId = req.params.id;
  const row = db.prepare('SELECT * FROM asdlc_business_logic WHERE business_logic_id = ? AND project_id = ?')
    .get(req.params.blId, projectId);
  if (!row) return res.status(404).json({ error: 'Business logic record not found in this project' });
  if (!row.source_fluent) return res.status(400).json({ error: 'No captured script to explain (source_fluent is empty).' });

  const artifact = {
    source_table: row.source_table || 'sys_script',
    source_sys_id: row.source_sys_id || null,
    source_scope: row.source_scope || null,
    name: row.name,
    salient: { name: row.name, script: row.source_fluent },
  };

  let result;
  try {
    const { reverseEngineerOne } = require('./agent/sn-reverse-engineer');
    result = await reverseEngineerOne(artifact, { projectId }, { forceAi: true });   // force AI past the deterministic short-circuit
  } catch (err) {
    return res.status(502).json({ error: `Explain failed: ${err.message}` });
  }
  const ed = (result.inferred && result.inferred.entity_data) || {};
  const before = { plain_english: row.plain_english, when_runs: row.when_runs, conditions: row.conditions };
  const after = {
    plain_english: ed.plain_english || (result.inferred && result.inferred.behavior) || null,
    when_runs:     ed.when_runs || null,
    conditions:    ed.conditions || null,
  };
  db.prepare(`UPDATE asdlc_business_logic SET plain_english = ?, when_runs = ?, conditions = ?,
      updated_by = ?, updated_at = datetime('now') WHERE business_logic_id = ?`)
    .run(after.plain_english, after.when_runs, after.conditions, uid, row.business_logic_id);

  const updated = db.prepare('SELECT * FROM asdlc_business_logic WHERE business_logic_id = ?').get(row.business_logic_id);
  auditLog('asdlc_business_logic', row.business_logic_id, 'UPDATE', before, after, uid);
  const diffs = [
    { field: 'plain_english', old_value: before.plain_english, new_value: after.plain_english },
    { field: 'when_runs',     old_value: before.when_runs,     new_value: after.when_runs },
    { field: 'conditions',    old_value: before.conditions,    new_value: after.conditions },
  ].filter(d => d.new_value != null);
  const cpResult = createAutoApprovedCP(projectId, 'business_logic', row.business_logic_id, row.name, diffs, uid);

  res.json({ ...updated, _cp: cpResult, _stub: !!result.stub });
});

// gaps: design entities (data models, workflows) with no documented NL rule, plus
// captured scripts not yet reverse-engineered — drives the "add a rule" prompts.
app.get('/api/v1/projects/:id/nl-rules/gaps', (req, res) => {
  const projectId = req.params.id;
  const project = db.prepare('SELECT project_id FROM asdlc_project WHERE project_id = ?').get(projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const rules = db.prepare("SELECT linked_table, linked_workflow, source_sys_id FROM asdlc_nl_rule WHERE project_id = ? AND lifecycle_status = 'active'").all(projectId);
  const linkedTables    = new Set(rules.map(r => (r.linked_table || '').trim().toLowerCase()).filter(Boolean));
  const linkedWorkflows = new Set(rules.map(r => (r.linked_workflow || '').trim().toLowerCase()).filter(Boolean));
  const reSysIds        = new Set(rules.map(r => r.source_sys_id).filter(Boolean));

  const dataModels = db.prepare("SELECT data_model_id, slug, name, physical_name FROM asdlc_data_model WHERE project_id = ? AND lifecycle_status = 'active' ORDER BY slug").all(projectId);
  const tables_without_rules = dataModels.filter(dm => {
    const n = (dm.name || '').trim().toLowerCase(), p = (dm.physical_name || '').trim().toLowerCase();
    return !(linkedTables.has(n) || (p && linkedTables.has(p)));
  }).map(dm => ({ data_model_id: dm.data_model_id, slug: dm.slug, name: dm.name }));

  const workflows = db.prepare("SELECT workflow_id, slug, name FROM asdlc_workflow WHERE project_id = ? AND lifecycle_status = 'active' ORDER BY slug").all(projectId);
  const workflows_without_rules = workflows.filter(wf => !linkedWorkflows.has((wf.name || '').trim().toLowerCase()))
    .map(wf => ({ workflow_id: wf.workflow_id, slug: wf.slug, name: wf.name }));

  // Captured implementation scripts (Tier-C) not yet turned into an NL rule.
  let scripts_not_reverse_engineered = [];
  try {
    const scripts = db.prepare(
      "SELECT sn_artifact_id, name, source_sys_id, source_table FROM asdlc_sn_artifact " +
      "WHERE project_id = ? AND source_table IN ('sys_script','sys_script_include','sys_ui_action') ORDER BY name"
    ).all(projectId);
    scripts_not_reverse_engineered = scripts.filter(s => !s.source_sys_id || !reSysIds.has(s.source_sys_id))
      .map(s => ({ sn_artifact_id: s.sn_artifact_id, name: s.name, source_table: s.source_table }));
  } catch { /* substrate table may be empty / absent — non-fatal */ }

  res.json({
    generated_at: new Date().toISOString(),
    tables_without_rules, workflows_without_rules, scripts_not_reverse_engineered,
    summary: {
      tables_without_rules: tables_without_rules.length,
      workflows_without_rules: workflows_without_rules.length,
      scripts_not_reverse_engineered: scripts_not_reverse_engineered.length,
    },
  });
});

// ─── Generic ServiceNow artifact read/edit API (Phase 4b) ────────────────────
// The polymorphic asdlc_sn_artifact substrate, mirroring the RT_DESIGN pattern.
// EDITABLE: name + payload (the artifact's field values) + override_fields. Type
// identity (sn_metadata_type/fluent_api_name/deploy_strategy/tier), parent linkage, and
// Level-2 provenance (source_*) are READ-ONLY — managed by capture + the SDK registry.
// Tier-A artifacts project onto a Level-1 row and must be edited via that L1 editor;
// editing them here is refused so the two edit paths can't diverge.
function snArtifactParse(row) {
  if (!row) return row;
  const out = { ...row };
  try { out.payload = JSON.parse(out.payload || '{}'); } catch { out.payload = {}; }
  try { out.override_fields = JSON.parse(out.override_fields || '{}'); } catch { out.override_fields = {}; }
  return out;
}

// List — grouped client-side; provenance kept minimal here, full detail via single GET.
app.get('/api/v1/projects/:id/sn-artifacts', (req, res) => {
  const project = db.prepare('SELECT project_id, project_name, project_code FROM asdlc_project WHERE project_id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT a.sn_artifact_id, a.slug, a.name, a.sn_metadata_type, a.fluent_api_name, a.deploy_strategy,
              a.tier, a.parent_artifact_id, a.child_role, a.child_order, a.projected_entity_type,
              a.projected_entity_id, a.source_sys_id, a.source_table,
              (r.field_schema IS NOT NULL) AS has_field_schema
       FROM asdlc_sn_artifact a
       LEFT JOIN asdlc_sn_type_registry r ON r.sn_metadata_type = a.sn_metadata_type
       WHERE a.project_id = ? AND (a.lifecycle_status IS NULL OR a.lifecycle_status = 'active')
       ORDER BY (a.parent_artifact_id IS NOT NULL), a.sn_metadata_type, a.name`
    ).all(req.params.id);
  } catch { rows = []; }   // table absent on an older DB — degrade to empty
  const artifacts = rows.map(r => ({ ...r, editable: !r.projected_entity_type, has_field_schema: !!r.has_field_schema }));
  res.json({ project, generated_at: new Date().toISOString(), artifacts });
});

// Single — full row + parsed payload/override + the type's field_schema + children.
app.get('/api/v1/projects/:id/sn-artifacts/:aid', (req, res) => {
  let row;
  try {
    row = db.prepare(
      `SELECT a.*, r.field_schema AS registry_field_schema
       FROM asdlc_sn_artifact a LEFT JOIN asdlc_sn_type_registry r ON r.sn_metadata_type = a.sn_metadata_type
       WHERE a.sn_artifact_id = ? AND a.project_id = ?`
    ).get(req.params.aid, req.params.id);
  } catch { return res.status(404).json({ error: 'Generic artifact not found' }); }
  if (!row) return res.status(404).json({ error: 'Generic artifact not found' });
  const out = snArtifactParse(row);
  try { out.field_schema = row.registry_field_schema ? JSON.parse(row.registry_field_schema) : null; } catch { out.field_schema = null; }
  delete out.registry_field_schema;
  out.editable = !row.projected_entity_type;
  try {
    out.children = db.prepare(
      `SELECT sn_artifact_id, slug, name, sn_metadata_type, child_role, child_order, source_sys_id
       FROM asdlc_sn_artifact WHERE parent_artifact_id = ? AND project_id = ? ORDER BY child_order, name`
    ).all(req.params.aid, req.params.id);
  } catch { out.children = []; }
  res.json(out);
});

// Update — editable fields only; auto-approved history CP (field_path = column name, so
// the sn_artifact materializer branch never re-applies it). Tier-A edits are refused.
app.put('/api/v1/projects/:id/sn-artifacts/:aid', (req, res) => {
  const uid = userId(req);
  let existing;
  try { existing = db.prepare('SELECT * FROM asdlc_sn_artifact WHERE sn_artifact_id = ? AND project_id = ?').get(req.params.aid, req.params.id); }
  catch { return res.status(404).json({ error: 'Generic artifact not found' }); }
  if (!existing) return res.status(404).json({ error: 'Generic artifact not found' });
  if (existing.projected_entity_type) {
    return res.status(409).json({ error: `This is a Tier-A artifact projected onto a ${existing.projected_entity_type}; edit it via the Level-1 design editor (Design Review), not here.` });
  }
  const b = req.body || {};
  const raw = {};
  if (typeof b.name === 'string' && b.name.trim()) raw.name = b.name.trim();
  if (b.payload && typeof b.payload === 'object' && !Array.isArray(b.payload)) raw.payload = b.payload;
  if (b.override_fields && typeof b.override_fields === 'object' && !Array.isArray(b.override_fields)) raw.override_fields = b.override_fields;
  if (!Object.keys(raw).length) return res.status(400).json({ error: 'Provide name, payload, or override_fields to update.' });

  const toWrite = { ...raw };
  for (const c of ['payload', 'override_fields']) if (c in toWrite && typeof toWrite[c] !== 'string') toWrite[c] = JSON.stringify(toWrite[c]);
  const setCols = Object.keys(toWrite);
  db.prepare(
    `UPDATE asdlc_sn_artifact SET ${setCols.map(c => `${c} = ?`).join(', ')}, version = version + 1,
       updated_by = ?, updated_at = datetime('now') WHERE sn_artifact_id = ?`
  ).run(...setCols.map(c => toWrite[c]), uid, req.params.aid);

  const after = db.prepare('SELECT * FROM asdlc_sn_artifact WHERE sn_artifact_id = ?').get(req.params.aid);
  auditLog('asdlc_sn_artifact', req.params.aid, 'UPDATE', existing, after, uid);
  const diff = diffFields(existing, raw, ['payload', 'override_fields']);
  let cpResult = null;
  if (diff.length) cpResult = createAutoApprovedCP(req.params.id, 'sn_artifact', req.params.aid, existing.name || req.params.aid, diff, uid);
  res.json({ ...snArtifactParse(after), _cp: cpResult });
});

/**
 * GET /api/v1/projects/:id/slug-map
 * Phase 5: lightweight project-wide slug → {scope, entity_id, label} index.
 * Used by the frontend slug-autolinker so a UC-### / WF-### / AG-### reference
 * inside any free-text field becomes a clickable drill-down link regardless
 * of which design-report scope is currently open.
 */
app.get('/api/v1/projects/:id/slug-map', (req, res) => {
  const pid = req.params.id;
  const map = {};
  const addRows = (rows, scope, idCol, labelCol) => {
    for (const r of rows) {
      if (r.slug) map[r.slug] = { scope, entity_id: r[idCol], label: r[labelCol] || r.slug };
    }
  };
  try {
    addRows(db.prepare("SELECT use_case_id, slug, title FROM asdlc_use_case WHERE project_id = ? AND slug IS NOT NULL").all(pid),
            'use-cases', 'use_case_id', 'title');
    addRows(db.prepare("SELECT workflow_id, slug, name FROM asdlc_workflow WHERE project_id = ? AND slug IS NOT NULL").all(pid),
            'workflows', 'workflow_id', 'name');
    addRows(db.prepare("SELECT workflow_step_id, slug, name FROM asdlc_workflow_step WHERE project_id = ? AND slug IS NOT NULL").all(pid),
            'workflows', 'workflow_step_id', 'name');
    addRows(db.prepare("SELECT agent_spec_id, slug, name FROM asdlc_agent_spec WHERE project_id = ? AND slug IS NOT NULL").all(pid),
            'agents', 'agent_spec_id', 'name');
    addRows(db.prepare(`SELECT tool_id, slug, name FROM asdlc_tool
                        WHERE slug IS NOT NULL AND (project_id = ? OR visibility_scope IN ('GLOBAL','ORGANIZATION','PROGRAM'))`).all(pid),
            'tools', 'tool_id', 'name');
    // ACs: drill to the parent UC/US card (where ACs render inline), not the AC's own UUID.
    const acRows = db.prepare(`SELECT slug, text, parent_type, parent_id
                               FROM asdlc_acceptance_criterion
                               WHERE project_id = ? AND slug IS NOT NULL`).all(pid);
    for (const r of acRows) {
      if (!r.slug) continue;
      const scope = r.parent_type === 'user_story' ? 'user-stories' : 'use-cases';
      map[r.slug] = {
        scope,
        entity_id: r.parent_id,
        label: (r.text || '').substring(0, 80),
      };
    }
    // TCs: drill to the parent entity (scope_entity_id) on the scope-matching tab.
    const tcScopeMap = { use_case: 'use-cases', workflow: 'workflows', agent: 'agents', tool: 'tools' };
    const tcRows = db.prepare(`SELECT slug, title, scope, scope_entity_id
                               FROM asdlc_test_case
                               WHERE project_id = ? AND slug IS NOT NULL`).all(pid);
    for (const r of tcRows) {
      if (!r.slug) continue;
      const scope = tcScopeMap[r.scope] || 'agents';
      map[r.slug] = {
        scope,
        entity_id: r.scope_entity_id,
        label: r.title || r.slug,
      };
    }
    res.json(map);
  } catch (err) {
    console.error('[slug-map]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/v1/projects/:id/design-report/use-cases
 * All use cases for a project with structured metadata, workflow count, and agent count.
 */
app.get('/api/v1/projects/:id/design-report/use-cases', (req, res) => {
  const project = db.prepare(`
    SELECT p.*, c.client_name FROM asdlc_project p
    LEFT JOIN asdlc_client c ON c.client_id = p.client_id
    WHERE p.project_id = ?
  `).get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const rows = db.prepare(
    "SELECT * FROM asdlc_use_case WHERE project_id = ? AND lifecycle_status != 'deleted' ORDER BY title"
  ).all(req.params.id);

  const wfCountStmt  = db.prepare('SELECT COUNT(*) AS cnt FROM asdlc_workflow WHERE use_case_id = ?');
  // Phase 3: count via M:N join table (was: asdlc_agent_spec.use_case_id direct FK)
  const agCountStmt  = db.prepare('SELECT COUNT(*) AS cnt FROM asdlc_agent_use_case WHERE use_case_id = ?');

  // Phase 4: cost params merged from global pricing + per-app planning/entitlement
  const ucCostAssumption = getEffectiveCostParams(req.params.id);
  const ucCostPerAssist = ucCostAssumption.cost_per_assist || 0.015;

  // Statement to get total step cost across all workflows for a UC
  const ucStepCostStmt = db.prepare(`
    SELECT b.qty_per_run, b.branch_probability, r.assists_per_unit, wf.runs_per_period
    FROM asdlc_workflow_step_cost_binding b
    JOIN asdlc_assist_rate_card r ON r.skill_name = b.skill_name
    JOIN asdlc_workflow_step s ON s.workflow_step_id = b.workflow_step_id
    JOIN asdlc_workflow wf ON wf.workflow_id = s.workflow_id
    WHERE wf.use_case_id = ? AND wf.project_id = ?
  `);

  const use_cases = rows.map(uc => ({
    use_case_id:       uc.use_case_id,
    slug:              uc.slug,                                   // Phase 1
    title:             uc.title,
    summary:           uc.summary,
    business_objective: uc.business_objective,
    expected_value:    uc.expected_value,
    readiness:         uc.readiness,
    lifecycle_status:  uc.lifecycle_status,
    success_criteria:  parseJson(uc.success_criteria) || [],
    constraints_list:  parseJson(uc.constraints_list) || [],
    volume_assumptions: parseJson(uc.volume_assumptions) || {},
    supervision_model: uc.supervision_model || null,
    system_generated:  uc.system_generated ? 1 : 0,
    // ── Phase 1 additions ───────────────────────────────────────────
    risk_tier:                uc.risk_tier || null,
    owner:                    uc.owner || null,
    primary_success_metric:   uc.primary_success_metric || null,
    epic_or_feature_id:       uc.epic_or_feature_id || null,
    baseline_cost_annual_usd: uc.baseline_cost_annual_usd != null ? uc.baseline_cost_annual_usd : null,
    workflow_count:    (wfCountStmt.get(uc.use_case_id) || {}).cnt || 0,
    agent_count:       (agCountStmt.get(uc.use_case_id) || {}).cnt || 0,
    // Phase 4: UC cost projection
    uc_cost_per_period: (() => {
      const rows2 = ucStepCostStmt.all(uc.use_case_id, req.params.id);
      return rows2.reduce((sum, c) => {
        const rpp = c.runs_per_period || 0;
        return sum + c.qty_per_run * (c.branch_probability ?? 1.0) * c.assists_per_unit * rpp * ucCostPerAssist;
      }, 0);
    })(),
    roi_ratio: uc.baseline_cost_annual_usd != null ? (() => {
      const rows2 = ucStepCostStmt.all(uc.use_case_id, req.params.id);
      const costPerPeriod = rows2.reduce((sum, c) => {
        const rpp = c.runs_per_period || 0;
        return sum + c.qty_per_run * (c.branch_probability ?? 1.0) * c.assists_per_unit * rpp * ucCostPerAssist;
      }, 0);
      const annualCost = costPerPeriod * (ucCostAssumption.periods_per_year || 12);
      return annualCost > 0 ? uc.baseline_cost_annual_usd / annualCost : null;
    })() : null,
  }));

  res.json({
    project: {
      project_id: project.project_id, project_name: project.project_name,
      project_code: project.project_code, client_name: project.client_name, stage: project.stage,
    },
    generated_at: new Date().toISOString(),
    use_cases,
  });
});

/**
 * GET /api/v1/projects/:id/design-report/relationships
 * Hierarchical map: use_cases → workflows → agents + HITL roles; plus project tools.
 */
app.get('/api/v1/projects/:id/design-report/relationships', (req, res) => {
  const project = db.prepare(`
    SELECT p.*, c.client_name FROM asdlc_project p
    LEFT JOIN asdlc_client c ON c.client_id = p.client_id
    WHERE p.project_id = ?
  `).get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const ucRows = db.prepare(
    "SELECT use_case_id, slug, title, readiness FROM asdlc_use_case WHERE project_id = ? AND lifecycle_status != 'deleted' ORDER BY title"
  ).all(req.params.id);

  const wfByUC    = db.prepare("SELECT * FROM asdlc_workflow WHERE use_case_id = ? AND lifecycle_status != 'deleted' ORDER BY name");
  const agByWF    = db.prepare("SELECT agent_spec_id, name FROM asdlc_agent_spec WHERE workflow_id = ? AND lifecycle_status != 'deleted'");
  const hitlByWF  = db.prepare("SELECT owner_role, gate_type, sla FROM asdlc_hitl_gate WHERE workflow_id = ?");
  const stepCount = db.prepare('SELECT COUNT(*) AS cnt FROM asdlc_workflow_step WHERE workflow_id = ?');

  // Project-wide tools — used as fallback per agent since the asdlc_agent_tool
  // join table is not populated yet (MVP 1).
  const project_tools = db.prepare(
    "SELECT tool_id, name, execution_mode FROM asdlc_tool WHERE project_id = ? AND lifecycle_status = 'active' ORDER BY name"
  ).all(req.params.id);

  const buildWorkflowShape = (wf) => ({
    workflow_id: wf.workflow_id,
    name:        wf.name,
    step_count:  (stepCount.get(wf.workflow_id) || {}).cnt || 0,
    agents:      agByWF.all(wf.workflow_id).map(a => ({
      agent_spec_id: a.agent_spec_id,
      name:          a.name,
      tools:         project_tools,   // fallback; switch to per-agent join when populated
    })),
    hitl_roles:  hitlByWF.all(wf.workflow_id).map(h => ({
      owner_role: h.owner_role,
      gate_type:  h.gate_type,
      sla:        h.sla,
    })),
  });

  const use_cases = ucRows.map(uc => ({
    use_case_id: uc.use_case_id, title: uc.title, readiness: uc.readiness,
    workflows: wfByUC.all(uc.use_case_id).map(buildWorkflowShape),
  }));

  // Workflows not linked to any use case — returned separately so the frontend
  // can surface them in a "No Use Case" bucket instead of silently dropping them.
  const orphaned_workflows = db.prepare(
    "SELECT * FROM asdlc_workflow WHERE project_id = ? AND (use_case_id IS NULL OR use_case_id = '') AND lifecycle_status != 'deleted' ORDER BY name"
  ).all(req.params.id).map(buildWorkflowShape);

  // SN platform entities ─────────────────────────────────────────────────────
  const dmRows    = db.prepare("SELECT data_model_id, slug, name, purpose, physical_name FROM asdlc_data_model WHERE project_id = ? AND lifecycle_status != 'deleted' ORDER BY name").all(req.params.id);
  const formsByDM = db.prepare("SELECT form_design_id, slug, name, view_name FROM asdlc_form_design WHERE data_model_id = ? AND lifecycle_status != 'deleted'");
  const logicByDM = db.prepare("SELECT business_logic_id, slug, name, logic_type, plain_english FROM asdlc_business_logic WHERE data_model_id = ? AND lifecycle_status != 'deleted'");

  const data_models = dmRows.map(dm => ({
    data_model_id: dm.data_model_id,
    slug:          dm.slug,
    name:          dm.name,
    purpose:       dm.purpose,
    physical_name: dm.physical_name,
    forms:         formsByDM.all(dm.data_model_id),
    logic:         logicByDM.all(dm.data_model_id),
  }));

  const catalog_items = db.prepare(`
    SELECT ci.catalog_item_id, ci.slug, ci.name, ci.short_description, ci.category,
           ci.workflow_id, wf.name AS workflow_name
    FROM asdlc_catalog_item ci
    LEFT JOIN asdlc_workflow wf ON ci.workflow_id = wf.workflow_id
    WHERE ci.project_id = ? AND ci.lifecycle_status != 'deleted' ORDER BY ci.name
  `).all(req.params.id);

  const integrations = db.prepare(
    "SELECT integration_id, slug, name, integration_type, description, endpoint, auth_type, alias_type, connection_type FROM asdlc_integration WHERE project_id = ? AND lifecycle_status != 'deleted' ORDER BY integration_type, name"
  ).all(req.params.id);

  const frs = db.prepare(`
    SELECT fr.*, uc.slug AS use_case_slug, uc.title AS use_case_title
    FROM asdlc_functional_req fr
    LEFT JOIN asdlc_use_case uc ON fr.use_case_id = uc.use_case_id
    WHERE fr.project_id = ? AND fr.status != 'deleted'
    ORDER BY fr.slug ASC
  `).all(req.params.id).map(parseReqRow);

  const nfrs = db.prepare(`
    SELECT nfr.*, uc.slug AS use_case_slug, uc.title AS use_case_title
    FROM asdlc_nonfunctional_req nfr
    LEFT JOIN asdlc_use_case uc ON nfr.use_case_id = uc.use_case_id
    WHERE nfr.project_id = ? AND nfr.status != 'deleted'
    ORDER BY nfr.slug ASC
  `).all(req.params.id).map(parseReqRow);

  const use_case_map = {};
  ucRows.forEach(uc => { use_case_map[uc.use_case_id] = { slug: uc.slug, title: uc.title }; });

  // Config-driven Tier-A entities for the Miller "Tier-A Design" section. Lightweight rows
  // (id, slug, name + a 1-line secondary) grouped by display.group so the view self-populates.
  const tier_a_entities = {};
  for (const e of registry.entitiesWithDisplay()) {
    let rows = [];
    try {
      rows = db.prepare(`SELECT * FROM ${e.table} WHERE project_id = ? AND lifecycle_status = 'active' ORDER BY slug`).all(req.params.id);
    } catch { rows = []; }
    if (!rows.length) continue;
    // secondary = the first non-name flat field with a value (e.g. purpose, target, metric).
    const secondaryKeys = e.display.fields.filter(f => f.key !== 'name' && f.type !== 'json' && f.type !== 'json-list').map(f => f.key);
    tier_a_entities[e.display.data_key] = {
      label: e.display.label, scope_id: e.display.scope_id, group: e.display.group || 'design',
      id_key: e.pk,
      rows: rows.map(r => {
        let secondary = '';
        for (const k of secondaryKeys) { if (r[k]) { secondary = String(r[k]); break; } }
        return { id: r[e.pk], slug: r.slug, name: r.name, secondary };
      }),
    };
  }

  res.json({
    project: {
      project_id: project.project_id, project_name: project.project_name,
      project_code: project.project_code, client_name: project.client_name, stage: project.stage,
    },
    generated_at: new Date().toISOString(),
    relationships: {
      use_cases,
      orphaned_workflows,
      project_tools,
      tools_are_project_wide: true,
    },
    data_models,
    catalog_items,
    integrations,
    functional_reqs: frs,
    nonfunctional_reqs: nfrs,
    use_case_map,
    tier_a_entities,
  });
});

/**
 * GET /api/v1/projects/:id/build-export
 * Export a complete application build specification as Markdown.
 * Query params:
 *   baseline_id  (optional) — UUID of a locked baseline; stamps the header only
 *   sections     (optional, default 'all') — comma-separated list:
 *                use_cases, workflows, agents, tools, guardrails, data_sources,
 *                test_scenarios, user_stories, governance, relationships
 */
app.get('/api/v1/projects/:id/build-export', async (req, res) => {
  const project = db.prepare(`
    SELECT p.*, c.client_name, c.client_code
    FROM asdlc_project p
    LEFT JOIN asdlc_client c ON c.client_id = p.client_id
    WHERE p.project_id = ?
  `).get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const allSections = ['use_cases','workflows','agents','tools','guardrails','data_sources','test_scenarios','user_stories','governance','relationships','cost_summary',
    'data_models','form_designs','business_logic','catalog_items','integrations','sn_generic_artifacts',
    'requirements','best_practices',
    // config-driven Tier-A entities (Information Layer + NL rules) — derived from registry display blocks
    ...registry.entitiesWithDisplay().map(e => e.display.data_key)];
  const sectionsParam = req.query.sections || 'all';
  const sections = sectionsParam === 'all' ? allSections : sectionsParam.split(',').map(s => s.trim()).filter(s => allSections.includes(s));
  // Delta mode: only include entity rows updated after the last Build Spec export.
  const deltaMode = req.query.delta === 'true' || req.query.delta === '1';
  const sinceTs   = deltaMode ? (project.last_build_spec_generated_at || null) : null;

  // Baseline — only for header stamping, never filters SQL queries
  let baseline = null;
  if (req.query.baseline_id) {
    baseline = db.prepare('SELECT * FROM asdlc_baseline WHERE baseline_id = ?').get(req.query.baseline_id);
  }

  // Shared ingest document (most recent for this project)
  const ingestDoc = db.prepare(
    'SELECT * FROM asdlc_ingest_document WHERE project_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(req.params.id);

  const data = {};

  // ── Use Cases ──────────────────────────────────────────────────────────────
  if (sections.includes('use_cases')) {
    const ucRows = db.prepare(
      "SELECT * FROM asdlc_use_case WHERE project_id = ? AND lifecycle_status != 'deleted' ORDER BY title"
    ).all(req.params.id);
    const wfCnt  = db.prepare('SELECT COUNT(*) AS cnt FROM asdlc_workflow        WHERE use_case_id = ?');
    const agCnt  = db.prepare('SELECT COUNT(*) AS cnt FROM asdlc_agent_use_case WHERE use_case_id = ?');
    // Phase 4: projected cost per UC (sum of child workflow step costs).
    // cost_per_assist is now per-Application — JOIN against asdlc_project
    // (with a final fallback to the legacy global row for safety).
    const ucCostStmt = db.prepare(`
      SELECT COALESCE(SUM(
        b.qty_per_run * COALESCE(b.branch_probability, 1.0)
        * r.assists_per_unit * COALESCE(wf.runs_per_period, 0)
        * COALESCE(ap.cost_per_assist, ca.cost_per_assist, 0.015)
      ), 0) AS projected_per_period
      FROM asdlc_workflow_step_cost_binding b
      JOIN asdlc_assist_rate_card r ON r.skill_name = b.skill_name
      JOIN asdlc_workflow_step s ON s.workflow_step_id = b.workflow_step_id
      JOIN asdlc_workflow wf ON wf.workflow_id = s.workflow_id
      LEFT JOIN asdlc_project ap ON ap.project_id = wf.project_id
      LEFT JOIN asdlc_cost_assumption ca ON ca.cost_assumption_id = 'cost-assumption-global'
      WHERE wf.use_case_id = ?
    `);
    // Phase 4: periods_per_year is per-application (split from global assumption).
    const periodsPerYear = getEffectiveCostParams(req.params.id).periods_per_year || 12;
    data.use_cases = ucRows.map(uc => {
      const projected = (ucCostStmt.get(uc.use_case_id) || {}).projected_per_period || 0;
      const baseline  = uc.baseline_cost_annual_usd || 0;
      const roi = (projected > 0 && baseline > 0)
        ? (baseline / (projected * periodsPerYear)).toFixed(1)
        : null;
      return {
        ...uc,
        success_criteria:        parseJson(uc.success_criteria)   || [],
        constraints_list:        parseJson(uc.constraints_list)   || [],
        volume_assumptions:      parseJson(uc.volume_assumptions)  || [],
        workflow_count:          (wfCnt.get(uc.use_case_id) || {}).cnt || 0,
        agent_count:             (agCnt.get(uc.use_case_id) || {}).cnt || 0,
        projected_cost_per_period: projected,
        roi_ratio:               roi,
      };
    });
  }

  // ── Workflows ──────────────────────────────────────────────────────────────
  if (sections.includes('workflows')) {
    const wfRows = db.prepare(
      "SELECT * FROM asdlc_workflow WHERE project_id = ? AND lifecycle_status != 'deleted' ORDER BY name"
    ).all(req.params.id);
    // Prepared statements reused across all workflow rows
    const stepsStmt        = db.prepare('SELECT * FROM asdlc_workflow_step WHERE workflow_id = ? ORDER BY step_number');
    const hitlStmt         = db.prepare('SELECT * FROM asdlc_hitl_gate WHERE workflow_id = ?');
    const participantStmt  = db.prepare("SELECT * FROM asdlc_workflow_participant WHERE workflow_id = ? AND lifecycle_status != 'deleted' ORDER BY lane_order");
    const pathStmt         = db.prepare(`
      SELECT p.*, sf.name AS from_step_name, sf.step_number AS from_step_num,
             st.name AS to_step_name
      FROM asdlc_workflow_path p
      LEFT JOIN asdlc_workflow_step sf ON sf.workflow_step_id = p.from_step_id
      LEFT JOIN asdlc_workflow_step st ON st.workflow_step_id = p.to_step_id
      WHERE p.workflow_id = ? ORDER BY sf.step_number, p.is_default_path DESC
    `);
    const rasicStmt        = db.prepare(`
      SELECT r.code, r.workflow_step_id, r.workflow_participant_id,
             wp.swimlane_display_name AS participant_name, wp.rasic_column_order,
             wp.include_in_rasic,
             s.step_number, s.name AS step_name
      FROM asdlc_workflow_step_rasic r
      JOIN asdlc_workflow_participant wp ON wp.workflow_participant_id = r.workflow_participant_id
      JOIN asdlc_workflow_step s ON s.workflow_step_id = r.workflow_step_id
      WHERE s.workflow_id = ? ORDER BY s.step_number, wp.rasic_column_order
    `);
    const stepCostStmt     = db.prepare(`
      SELECT b.workflow_step_id, b.skill_name, b.qty_per_run,
             b.branch_probability, r.assists_per_unit,
             b.qty_per_run * COALESCE(b.branch_probability, 1.0) * r.assists_per_unit AS assists_per_run
      FROM asdlc_workflow_step_cost_binding b
      JOIN asdlc_assist_rate_card r ON r.skill_name = b.skill_name
      WHERE b.workflow_step_id IN (
        SELECT workflow_step_id FROM asdlc_workflow_step WHERE workflow_id = ?
      )
    `);
    data.workflows = wfRows.map(wf => {
      const steps        = stepsStmt.all(wf.workflow_id);
      const hitlGates    = hitlStmt.all(wf.workflow_id);
      const participants = participantStmt.all(wf.workflow_id);
      const paths        = pathStmt.all(wf.workflow_id);
      const rasicRows    = rasicStmt.all(wf.workflow_id);
      const costBindings = stepCostStmt.all(wf.workflow_id);
      // Build participant lookup for resolving owner names on steps
      const participantById = {};
      for (const p of participants) participantById[p.workflow_participant_id] = p;
      // Group cost bindings by step
      const costByStep = {};
      for (const cb of costBindings) {
        (costByStep[cb.workflow_step_id] = costByStep[cb.workflow_step_id] || []).push(cb);
      }
      return {
        ...wf,
        trigger:      parseJson(wf.trigger_def) || {},
        handoffs:     parseJson(wf.handoffs)    || [],
        decisions:    parseJson(wf.decisions)   || [],
        participants,
        paths,
        rasic_rows:   rasicRows,
        steps: steps.map(s => ({
          ...s,
          inputs:               parseJson(s.inputs)         || {},
          outputs:              parseJson(s.outputs)        || {},
          decisions:            parseJson(s.decisions_list) || [],
          owner_participant_name: s.owner_participant_id
            ? (participantById[s.owner_participant_id]?.swimlane_display_name || s.actor_role || '')
            : (s.actor_role || ''),
          cost_bindings: costByStep[s.workflow_step_id] || [],
        })),
        hitl_gates: hitlGates.map(h => ({ ...h })),
      };
    });
  }

  // ── Agents ─────────────────────────────────────────────────────────────────
  if (sections.includes('agents')) {
    const agRows = db.prepare(
      "SELECT * FROM asdlc_agent_spec WHERE project_id = ? AND lifecycle_status != 'deleted' ORDER BY name"
    ).all(req.params.id);
    // Prepared statements for Phase 3 M:N joins
    const agUCStmt   = db.prepare(`
      SELECT auc.business_value, auc.notes, uc.title, uc.slug
      FROM asdlc_agent_use_case auc
      JOIN asdlc_use_case uc ON uc.use_case_id = auc.use_case_id
      WHERE auc.agent_spec_id = ? ORDER BY uc.title
    `);
    const agToolStmt = db.prepare(`
      SELECT at.purpose, at.fallback_behavior, at.binding_supervision_model,
             at.tool_execution_mode, at.linked_user_story_refs,
             t.name AS tool_name, t.slug AS tool_slug, t.dev_status
      FROM asdlc_agent_tool at
      JOIN asdlc_tool t ON t.tool_id = at.tool_id
      WHERE at.agent_spec_id = ? ORDER BY t.name
    `);
    data.agents = agRows.map(agent => ({
      ...agent,
      goals:             parseJson(agent.goals)             || [],
      done_criteria:     parseJson(agent.done_criteria)     || [],
      inputs:            parseJson(agent.inputs)            || {},
      outputs:           parseJson(agent.outputs)           || {},
      run_as_model:      parseJson(agent.run_as_model)      || {},
      design_risks:      parseJson(agent.design_risks)      || [],
      escalation_policy: parseJson(agent.escalation_policy) || {},
      use_cases:         agUCStmt.all(agent.agent_spec_id),
      tool_bindings:     agToolStmt.all(agent.agent_spec_id),
    }));
  }

  // ── Tools ──────────────────────────────────────────────────────────────────
  if (sections.includes('tools')) {
    const toolRows = db.prepare(
      "SELECT * FROM asdlc_tool WHERE project_id = ? AND lifecycle_status = 'active' ORDER BY name"
    ).all(req.params.id);
    data.tools = toolRows.map(t => ({
      ...t,
      inputs:     parseJson(t.inputs)     || {},
      outputs:    parseJson(t.outputs)    || {},
      errors:     parseJson(t.errors)     || [],
      boundaries: parseJson(t.boundaries) || [],
    }));
  }

  // ── ServiceNow round-trip: Level-1 design (materialized tables) ─────────────
  const RT_EXPORT = {
    data_models:    { table: 'asdlc_data_model',     json: ['fields', 'relationships'] },
    form_designs:   { table: 'asdlc_form_design',    json: ['sections', 'related_lists', 'mandatory_fields', 'readonly_fields'] },
    business_logic: { table: 'asdlc_business_logic', json: ['requirement_refs'] },
    catalog_items:  { table: 'asdlc_catalog_item',   json: ['variables'] },
    integrations:   { table: 'asdlc_integration',    json: ['functions'] },
  };
  for (const [sectionKey, spec] of Object.entries(RT_EXPORT)) {
    if (sections.includes(sectionKey)) {
      data[sectionKey] = db.prepare(
        `SELECT * FROM ${spec.table} WHERE project_id = ? AND lifecycle_status = 'active' ORDER BY slug`
      ).all(req.params.id).map(r => {
        const o = { ...r };
        for (const c of spec.json) o[c] = parseJson(o[c]);
        return o;
      });
    }
  }

  // ── Config-driven Tier-A entities (Information Layer + NL rules) ─────────────
  // Gathered generically from registry display blocks; rendered by the generic
  // section renderer in buildExportMarkdown (bespoke RT sections above untouched).
  for (const e of registry.entitiesWithDisplay()) {
    const k = e.display.data_key;
    if (!sections.includes(k)) continue;
    const jsonCols = Object.values(e.fieldMap).filter(m => m.json).map(m => m.col);
    data[k] = db.prepare(
      `SELECT * FROM ${e.table} WHERE project_id = ? AND lifecycle_status = 'active' ORDER BY slug`
    ).all(req.params.id).map(r => {
      const o = { ...r };
      for (const c of jsonCols) o[c] = parseJson(o[c]);
      return o;
    });
  }

  // ── ServiceNow Generic Artifacts (Phase 1-3 substrate) ──────────────────────
  if (sections.includes('sn_generic_artifacts')) {
    try {
      const rootArtifacts = db.prepare(`
        SELECT a.*,
               r.explain_topic AS registry_explain_topic,
               r.sdk_version   AS registry_sdk_version
        FROM asdlc_sn_artifact a
        LEFT JOIN asdlc_sn_type_registry r ON r.sn_metadata_type = a.sn_metadata_type
        WHERE a.project_id = ?
          AND a.parent_artifact_id IS NULL
          AND (a.lifecycle_status IS NULL OR a.lifecycle_status = 'active')
        ORDER BY a.sn_metadata_type, a.name
      `).all(req.params.id);

      const childrenStmt = db.prepare(`
        SELECT * FROM asdlc_sn_artifact
        WHERE parent_artifact_id = ?
          AND (lifecycle_status IS NULL OR lifecycle_status = 'active')
        ORDER BY child_order, name
      `);

      data.sn_generic_artifacts = rootArtifacts.map(art => ({
        ...art,
        payload:         parseJson(art.payload)         || {},
        override_fields: parseJson(art.override_fields) || {},
        children: childrenStmt.all(art.sn_artifact_id).map(ch => ({
          ...ch,
          payload:         parseJson(ch.payload)         || {},
          override_fields: parseJson(ch.override_fields) || {},
        })),
      }));
    } catch { data.sn_generic_artifacts = []; }

    try {
      data.sn_type_registry_summary = {
        by_tier: db.prepare(
          "SELECT tier, COUNT(*) AS cnt FROM asdlc_sn_type_registry GROUP BY tier"
        ).all(),
        by_strategy: db.prepare(
          "SELECT deploy_strategy, COUNT(*) AS cnt FROM asdlc_sn_type_registry GROUP BY deploy_strategy"
        ).all(),
        sdk_version: (db.prepare(
          "SELECT sdk_version FROM asdlc_sn_type_registry WHERE sdk_version IS NOT NULL ORDER BY updated_at DESC LIMIT 1"
        ).get() || {}).sdk_version || null,
      };
    } catch { data.sn_type_registry_summary = null; }
  }

  // ── Materialized BRD design elements (guardrails, data sources) ─────────────
  // These now have real design tables, so read the canonical rows. Fall back to the
  // latest ingest's extractions for older projects whose items predate materialization
  // (so their Build Spec is unchanged).
  const MATERIALIZED_BRD = {
    guardrails:   { table: 'asdlc_guardrail',   type: 'guardrail',   json: [] },
    data_sources: { table: 'asdlc_data_source', type: 'data_source', json: ['access_requirements'] },
  };
  for (const [sectionKey, spec] of Object.entries(MATERIALIZED_BRD)) {
    if (!sections.includes(sectionKey)) continue;
    const rows = db.prepare(
      `SELECT * FROM ${spec.table} WHERE project_id = ? AND (lifecycle_status IS NULL OR lifecycle_status != 'retired') ORDER BY slug`
    ).all(req.params.id);
    if (rows.length) {
      data[sectionKey] = rows.map(r => { const o = { ...r }; for (const c of spec.json) o[c] = parseJson(o[c]); return o; });
    } else {
      data[sectionKey] = ingestDoc
        ? db.prepare('SELECT entity_data FROM asdlc_ingest_extraction WHERE ingest_id = ? AND entity_type = ? ORDER BY rowid')
            .all(ingestDoc.ingest_id, spec.type).map(r => parseJson(r.entity_data) || {})
        : [];
    }
  }

  // ── Extraction-based (supporting-evidence) sections ─────────────────────────
  // user_stories stays extraction-sourced on purpose: the materialized story table is
  // a thin traceability home (narrative + requirement_refs) and intentionally omits the
  // acceptance-criteria content the evidence section renders.
  const EXTRACTION_TYPES = {
    test_scenarios: 'test_scenario',
    user_stories:   'user_story',
    governance:     'governance_control',
  };
  for (const [sectionKey, entityType] of Object.entries(EXTRACTION_TYPES)) {
    if (sections.includes(sectionKey)) {
      data[sectionKey] = ingestDoc
        ? db.prepare('SELECT entity_data FROM asdlc_ingest_extraction WHERE ingest_id = ? AND entity_type = ? ORDER BY rowid')
            .all(ingestDoc.ingest_id, entityType).map(r => parseJson(r.entity_data) || {})
        : [];
    }
  }

  // ── Relationships ──────────────────────────────────────────────────────────
  if (sections.includes('relationships')) {
    const ucRows = db.prepare(
      "SELECT use_case_id, title, readiness FROM asdlc_use_case WHERE project_id = ? AND lifecycle_status != 'deleted' ORDER BY title"
    ).all(req.params.id);
    const wfByUC         = db.prepare("SELECT workflow_id, name, slug FROM asdlc_workflow WHERE use_case_id = ? AND lifecycle_status != 'deleted' ORDER BY name");
    // Phase 3: agents via M:N join on use_case, not workflow FK
    const agByUC         = db.prepare(`
      SELECT ag.name, ag.slug, ag.supervision_model
      FROM asdlc_agent_use_case auc
      JOIN asdlc_agent_spec ag ON ag.agent_spec_id = auc.agent_spec_id
      WHERE auc.use_case_id = ? AND ag.lifecycle_status != 'deleted'
      ORDER BY ag.name
    `);
    const hitlByWF       = db.prepare('SELECT owner_role, gate_type, sla FROM asdlc_hitl_gate WHERE workflow_id = ?');
    const stpCnt         = db.prepare('SELECT COUNT(*) AS cnt FROM asdlc_workflow_step WHERE workflow_id = ?');
    // Phase 2: participants per workflow
    const participantsByWF = db.prepare("SELECT swimlane_display_name, participant_type FROM asdlc_workflow_participant WHERE workflow_id = ? AND lifecycle_status != 'deleted' ORDER BY lane_order");
    data.relationships = {
      use_cases: ucRows.map(uc => ({
        ...uc,
        agents: agByUC.all(uc.use_case_id),
        workflows: wfByUC.all(uc.use_case_id).map(wf => ({
          workflow_id:  wf.workflow_id,
          name:         wf.name,
          slug:         wf.slug,
          step_count:   (stpCnt.get(wf.workflow_id) || {}).cnt || 0,
          hitl_roles:   hitlByWF.all(wf.workflow_id),
          participants: participantsByWF.all(wf.workflow_id),
        })),
      })),
      project_tools: db.prepare(
        "SELECT tool_id, name, slug, execution_mode, dev_status FROM asdlc_tool WHERE project_id = ? AND lifecycle_status = 'active' ORDER BY name"
      ).all(req.params.id),
    };
  }

  // ── Cost Summary ──────────────────────────────────────────────────────────
  if (sections.includes('cost_summary')) {
    // All cost params are now per-Application.
    const assumption = getEffectiveCostParams(req.params.id);
    // cost_per_assist comes from asdlc_project (with the legacy global row as a
    // safety fallback for projects that haven't been backfilled).
    const ucCosts = db.prepare(`
      SELECT uc.title, uc.slug, uc.baseline_cost_annual_usd,
        COALESCE(SUM(
          b.qty_per_run * COALESCE(b.branch_probability, 1.0)
          * r.assists_per_unit * COALESCE(wf.runs_per_period, 0)
          * COALESCE(ap.cost_per_assist, ca.cost_per_assist, 0.015)
        ), 0) AS projected_per_period
      FROM asdlc_use_case uc
      LEFT JOIN asdlc_workflow wf
        ON wf.use_case_id = uc.use_case_id AND wf.lifecycle_status != 'deleted'
      LEFT JOIN asdlc_workflow_step s ON s.workflow_id = wf.workflow_id
      LEFT JOIN asdlc_workflow_step_cost_binding b ON b.workflow_step_id = s.workflow_step_id
      LEFT JOIN asdlc_assist_rate_card r ON r.skill_name = b.skill_name
      LEFT JOIN asdlc_project ap ON ap.project_id = uc.project_id
      LEFT JOIN asdlc_cost_assumption ca ON ca.cost_assumption_id = 'cost-assumption-global'
      WHERE uc.project_id = ? AND uc.lifecycle_status != 'deleted'
      GROUP BY uc.use_case_id ORDER BY uc.title
    `).all(req.params.id);
    data.cost_summary = { assumption, use_cases: ucCosts };
  }

  // ── Requirements (FR + NFR) ────────────────────────────────────────────────────
  if (sections.includes('requirements')) {
    data.functional_reqs = db.prepare(
      `SELECT fr.*, uc.slug AS use_case_slug, uc.title AS use_case_title
       FROM asdlc_functional_req fr
       LEFT JOIN asdlc_use_case uc ON uc.use_case_id = fr.use_case_id
       WHERE fr.project_id = ? AND (fr.status IS NULL OR fr.status != 'deleted')
       ORDER BY fr.slug`
    ).all(req.params.id).map(r => ({
      ...r,
      actors: parseJson(r.actors),
      acceptance_criteria: parseJson(r.acceptance_criteria),
      dependencies: parseJson(r.dependencies),
    }));
    data.nonfunctional_reqs = db.prepare(
      "SELECT * FROM asdlc_nonfunctional_req WHERE project_id = ? AND (status IS NULL OR status != 'deleted') ORDER BY slug"
    ).all(req.params.id).map(r => ({
      ...r,
      dependencies: parseJson(r.dependencies),
    }));
  }

  // ── Best Practices / AI Guidance ──────────────────────────────────────────────
  if (sections.includes('best_practices')) {
    data.best_practices = db.prepare(
      "SELECT * FROM asdlc_best_practice WHERE is_active = 1 AND (platform = 'any' OR platform = 'servicenow' OR platform IS NULL) ORDER BY sort_order, title"
    ).all();
  }

  // ── Delta filter: trim design sections to records changed since last export ──
  // Must run after ALL data-gather blocks so every array is populated before filtering.
  if (deltaMode && sinceTs) {
    const after = r => !r.updated_at || r.updated_at > sinceTs;
    ['use_cases','agents','tools','data_models','form_designs','business_logic',
     'catalog_items','integrations','sn_generic_artifacts',
     'functional_reqs','nonfunctional_reqs'].forEach(k => {
      if (Array.isArray(data[k])) data[k] = data[k].filter(after);
    });
    // Workflows: include if the workflow itself OR any of its steps/participants changed
    if (Array.isArray(data.workflows)) {
      data.workflows = data.workflows.filter(wf =>
        after(wf) ||
        (wf.steps        || []).some(after) ||
        (wf.participants || []).some(after)
      );
    }
    // Config-driven Tier-A entities (dashboards, KPIs, NL rules, etc.)
    for (const e of registry.entitiesWithDisplay()) {
      const k = e.display.data_key;
      if (Array.isArray(data[k])) data[k] = data[k].filter(after);
    }
    // Gather approved-CP summaries so the preamble can explain what drove this export
    data._delta_context = {
      since_ts: sinceTs,
      cps: db.prepare(
        "SELECT packet_code, summary, updated_at FROM asdlc_change_packet WHERE project_id = ? AND status = 'approved' AND updated_at > ? ORDER BY updated_at DESC LIMIT 20"
      ).all(req.params.id, sinceTs),
    };
  } else if (deltaMode) {
    // Delta requested but never exported before — note it; include everything
    data._delta_context = { since_ts: null, cps: [] };
  }
  data._export_meta = { deltaMode, sinceTs };

  // Best-effort: resolve the configured runAsUser account's sys_id live, so the
  // Build Spec can pre-fill it instead of emitting a REPLACE_WITH_… placeholder.
  // Read-only single GET; any failure (no creds, unreachable, not found) just
  // leaves the placeholder in place — the export never blocks on this.
  {
    const inst = project.servicenow_instance || process.env.SN_INSTANCE;
    const usr  = project.sn_user || process.env.SN_USER;
    const pw   = decryptField(project.sn_password_enc) || process.env.SN_PASSWORD;
    if (inst && usr && pw) {
      try {
        data.sn_runas = await snAssess.resolveUserSysId({ instance: inst, user: usr, pw });
      } catch (err) {
        console.error('[build-export] runAsUser sys_id resolve failed:', err.message);
      }
    }
  }

  // Instance Context: collision awareness for the names this spec would CREATE,
  // computed against the latest instance catalog (read-only; {available:false} if none).
  data._instance_context = loadInstanceContext(project.project_id, deployTargetsFromData(data, project.servicenow_scope));

  // Build the deterministic markdown (a faithful DB dump — never altered by AI)
  let md = buildExportMarkdown(project, baseline, sections, data);

  // Optional, additive AI review section (req #6). Appended only; the body above
  // is always the authoritative, reproducible export.
  if (String(req.query.ai_review) === '1' || String(req.query.ai_review) === 'true') {
    try {
      const review = await generateBuildReview(project, md);
      if (review) md += `\n\n${review}\n`;
    } catch (err) {
      console.error('[build-export] AI review failed:', err.message);
      md += `\n\n---\n\n> _AI design review could not be generated: ${err.message}_\n`;
    }
  }

  // Stamp last-export timestamp so subsequent delta exports know where to pick up.
  // Skippable via ?stamp=0 for automated/test callers that don't want to advance the cursor.
  if (req.query.stamp !== '0') {
    try {
      db.prepare("UPDATE asdlc_project SET last_build_spec_generated_at = ? WHERE project_id = ?")
        .run(new Date().toISOString(), req.params.id);
    } catch { /* non-critical; column may not exist on older DB */ }
  }

  const dateStr  = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const code     = (project.project_code || project.project_name || 'project').replace(/\s+/g, '-');
  const suffix   = deltaMode ? '-delta' : '';
  const fileName = `${code}-build-spec${suffix}-${dateStr}.md`;

  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.send(md);
});

// ─── ServiceNow Outbound Delta Export (Phase 2) ──────────────────────────────

/**
 * GET /api/v1/projects/:id/servicenow/delta-info
 * Lightweight check — how many approved CPs have accumulated since the last SN sync.
 * Frontend uses this to decide whether to show/enable the "Export SN Delta" button.
 */
app.get('/api/v1/projects/:id/servicenow/delta-info', (req, res) => {
  const project = db.prepare(`
    SELECT p.*, c.client_name
    FROM asdlc_project p
    LEFT JOIN asdlc_client c ON c.client_id = p.client_id
    WHERE p.project_id = ?
  `).get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  if (!project.servicenow_scope) {
    return res.json({ enabled: false, has_last_sync: false, sn_last_synced_at: null,
      delta_cp_count: 0, update_count: 0, create_count: 0, has_changes: false, pending_cps: [] });
  }

  // Outbound delta EXCLUDES inbound-origin CPs (cp_origin='sn_inbound') — that content
  // came FROM ServiceNow, so pushing it back would be a redundant/destructive round-trip.
  const sinceTs = project.sn_last_synced_at || null;
  let deltaCps;
  if (sinceTs) {
    deltaCps = db.prepare(
      "SELECT change_packet_id, packet_code, summary, approval_timestamp, cp_origin FROM asdlc_change_packet WHERE project_id = ? AND status = 'approved' AND (cp_origin IS NULL OR cp_origin != 'sn_inbound') AND updated_at > ?"
    ).all(req.params.id, sinceTs);
  } else {
    deltaCps = db.prepare(
      "SELECT change_packet_id, packet_code, summary, approval_timestamp, cp_origin FROM asdlc_change_packet WHERE project_id = ? AND status = 'approved' AND (cp_origin IS NULL OR cp_origin != 'sn_inbound')"
    ).all(req.params.id);
  }

  // Artifact tier counts for the Build Export preview card (computed before any early return)
  let genericCounts = null;
  try {
    const tierRows = db.prepare(
      "SELECT tier, COUNT(*) AS cnt FROM asdlc_sn_artifact WHERE project_id = ? AND (lifecycle_status IS NULL OR lifecycle_status = 'active') GROUP BY tier"
    ).all(req.params.id);
    genericCounts = { tier_a: 0, tier_b: 0, tier_c: 0 };
    for (const r of tierRows) {
      if (r.tier === 'A') genericCounts.tier_a = r.cnt;
      else if (r.tier === 'B') genericCounts.tier_b = r.cnt;
      else if (r.tier === 'C') genericCounts.tier_c = r.cnt;
    }
  } catch { /* asdlc_sn_artifact absent on older DB — degrade silently */ }

  if (!deltaCps.length) {
    return res.json({ enabled: true, has_last_sync: !!sinceTs, sn_last_synced_at: sinceTs,
      delta_cp_count: 0, update_count: 0, create_count: 0, has_changes: false, pending_cps: [],
      generics: genericCounts });
  }

  const cpIds = deltaCps.map(c => c.change_packet_id);
  const pholds = cpIds.map(() => '?').join(',');
  const items = db.prepare(
    `SELECT entity_type, entity_id FROM asdlc_change_packet_item WHERE change_packet_id IN (${pholds}) AND item_status != 'rejected'`
  ).all(...cpIds);

  let updateCount = 0, createCount = 0;
  const createTargets = [];   // R1c: CREATE items → check for catalog name collisions
  const mapForCollision = (entity_type, row) => {
    const m = snCatalog.DESIGN_SURFACE_MAP[entity_type]; if (!m || !row) return;
    const name = row[m.nameKey || 'name'] || row.name;
    if (name) createTargets.push({ kind: entity_type, name, slug: row.slug || null, surfaces: m.surfaces, scope: project.servicenow_scope || null, instanceUnique: m.instanceUnique });
  };
  for (const item of items) {
    // Generic artifacts (Phase 3): live in asdlc_sn_artifact, not the 22-type registry.
    if (item.entity_type === 'sn_artifact') {
      let row = null;
      try { row = db.prepare('SELECT source_sys_id FROM asdlc_sn_artifact WHERE sn_artifact_id = ?').get(item.entity_id); } catch { /* ignore */ }
      if (!row) continue;
      if (row.source_sys_id) updateCount++; else createCount++;
      continue;
    }
    const ent = registry.byEntityType[item.entity_type];
    if (!ent || !ent.materializable) continue;
    let row = null;
    try { row = db.prepare(`SELECT * FROM ${ent.table} WHERE ${ent.pk} = ?`).get(item.entity_id); } catch { /* ignore */ }
    if (!row) continue;
    if (row.source_sys_id) updateCount++;
    else { createCount++; mapForCollision(item.entity_type, row); }
  }

  // R1c: a CREATE whose name already exists on the instance is likely a record deployed
  // last cycle but never registered (source_sys_id still NULL) — re-export will DUPLICATE
  // it. Surface a pre-export warning from the latest catalog (best-effort; catalog optional).
  let collisionWarnings = [];
  if (createTargets.length) {
    try {
      const cr = db.prepare("SELECT catalog_json FROM asdlc_sn_catalog_run WHERE project_id=? AND status='complete' ORDER BY created_at DESC LIMIT 1").get(req.params.id);
      if (cr && cr.catalog_json) {
        collisionWarnings = snCatalog.computeCollisions(JSON.parse(cr.catalog_json), createTargets).filter(c => c.hard);
      }
    } catch { /* catalog absent / unreadable — skip the warning */ }
  }

  const pendingCps = deltaCps.map(c => ({
    packet_code: c.packet_code,
    summary: c.summary || null,
    approved_at: c.approval_timestamp || null,
    cp_origin: c.cp_origin || null,
  }));

  res.json({
    enabled: true,
    has_last_sync: !!sinceTs,
    sn_last_synced_at: sinceTs,
    delta_cp_count: deltaCps.length,
    update_count: updateCount,
    create_count: createCount,
    has_changes: (updateCount + createCount) > 0,
    pending_cps: pendingCps,
    generics: genericCounts,
    collision_warning_count: collisionWarnings.length,
    collision_warnings: collisionWarnings.slice(0, 10),
    last_build_spec_generated_at: project.last_build_spec_generated_at || null,
  });
});

/**
 * GET /api/v1/projects/:id/servicenow/delta-export
 * Download a single Markdown file containing the SN delta spec (PATCH + POST records)
 * and companion deployment instructions.
 * Covers all approved CPs since sn_last_synced_at; if never synced, covers all approved CPs.
 */
app.get('/api/v1/projects/:id/servicenow/delta-export', (req, res) => {
  const project = db.prepare(`
    SELECT p.*, c.client_name, c.client_code
    FROM asdlc_project p
    LEFT JOIN asdlc_client c ON c.client_id = p.client_id
    WHERE p.project_id = ?
  `).get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!project.servicenow_scope) {
    return res.status(400).json({ error: 'Project is not linked to a ServiceNow scope.' });
  }

  // Outbound delta EXCLUDES inbound-origin CPs (cp_origin='sn_inbound') — that content
  // came FROM ServiceNow, so pushing it back would be a redundant/destructive round-trip.
  const sinceTs = project.sn_last_synced_at || null;
  const cpQuery = sinceTs
    ? `SELECT cp.*, (SELECT COUNT(*) FROM asdlc_change_packet_item WHERE change_packet_id = cp.change_packet_id AND item_status != 'rejected') AS item_count
       FROM asdlc_change_packet cp WHERE cp.project_id = ? AND cp.status = 'approved' AND (cp.cp_origin IS NULL OR cp.cp_origin != 'sn_inbound') AND cp.updated_at > ? ORDER BY cp.updated_at ASC`
    : `SELECT cp.*, (SELECT COUNT(*) FROM asdlc_change_packet_item WHERE change_packet_id = cp.change_packet_id AND item_status != 'rejected') AS item_count
       FROM asdlc_change_packet cp WHERE cp.project_id = ? AND cp.status = 'approved' AND (cp.cp_origin IS NULL OR cp.cp_origin != 'sn_inbound') ORDER BY cp.updated_at ASC`;
  const deltaCps = sinceTs
    ? db.prepare(cpQuery).all(req.params.id, sinceTs)
    : db.prepare(cpQuery).all(req.params.id);

  const cpIds = deltaCps.map(c => c.change_packet_id);
  let allItems = [];
  if (cpIds.length) {
    const pholds = cpIds.map(() => '?').join(',');
    allItems = db.prepare(`
      SELECT i.*, cp.packet_code AS cp_ref, cp.summary AS cp_title
      FROM asdlc_change_packet_item i
      JOIN asdlc_change_packet cp ON cp.change_packet_id = i.change_packet_id
      WHERE i.change_packet_id IN (${pholds}) AND i.item_status != 'rejected'
      ORDER BY i.entity_type, i.created_at
    `).all(...cpIds);
  }

  const STRIP_INTERNAL = ['created_by','created_at','updated_by','updated_at','version','project_id',
    'lifecycle_status','source_hash','source_fluent','ingest_id'];
  const updates = [], creates = [], generics = [];
  for (const item of allItems) {
    // Generic artifacts (Phase 3): emit Fluent from asdlc_sn_artifact, not the rich JSON path.
    if (item.entity_type === 'sn_artifact') {
      let row = null;
      try { row = db.prepare('SELECT * FROM asdlc_sn_artifact WHERE sn_artifact_id = ?').get(item.entity_id); } catch { /* ignore */ }
      if (!row) continue;
      let payload = {}, override = {}, field_schema = null;
      try { payload = JSON.parse(row.payload || '{}'); } catch { /* keep {} */ }
      try { override = JSON.parse(row.override_fields || '{}'); } catch { /* keep {} */ }
      // Curated field_schema (Phase 4) drives idiomatic typed Fluent emission; absent → Record().
      try {
        const fs = db.prepare('SELECT field_schema FROM asdlc_sn_type_registry WHERE sn_metadata_type = ?').get(row.sn_metadata_type);
        if (fs && fs.field_schema) field_schema = JSON.parse(fs.field_schema);
      } catch { /* registry absent / bad JSON — fall back to Record() */ }
      generics.push({
        entity_id: item.entity_id, slug: row.slug, name: row.name,
        sn_metadata_type: row.sn_metadata_type, fluent_api_name: row.fluent_api_name,
        deploy_strategy: row.deploy_strategy, tier: row.tier, source_table: row.source_table,
        source_sys_id: row.source_sys_id, source_scope: row.source_scope,
        parent_artifact_id: row.parent_artifact_id, child_role: row.child_role, child_order: row.child_order,
        payload, override, field_schema, cp_ref: item.cp_ref, cp_title: item.cp_title,
      });
      continue;
    }
    const ent = registry.byEntityType[item.entity_type];
    if (!ent || !ent.materializable) continue;
    let row = null;
    try { row = db.prepare(`SELECT * FROM ${ent.table} WHERE ${ent.pk} = ?`).get(item.entity_id); } catch { /* ignore */ }
    if (!row) continue;

    // Derive display name from registry nameKeys → DB column names
    let entityName = item.entity_id;
    for (const nk of (ent.nameKeys || [])) {
      const col = (ent.fieldMap && ent.fieldMap[nk] && ent.fieldMap[nk].col) || nk;
      if (row[col]) { entityName = String(row[col]); break; }
    }

    const cleanRow = { ...row };
    for (const k of STRIP_INTERNAL) delete cleanRow[k];

    const entry = { entity_type: item.entity_type, entity_id: item.entity_id, entity_name: entityName,
      cp_ref: item.cp_ref, cp_title: item.cp_title, operation: item.operation, row: cleanRow };

    if (row.source_sys_id) updates.push(entry);
    else creates.push(entry);
  }

  const instanceContext = loadInstanceContext(project.project_id, deployTargetsFromCreates(creates, project.servicenow_scope));
  const md       = buildSNDeltaMarkdown(project, deltaCps, updates, creates, sinceTs, generics, instanceContext);
  const dateStr  = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const code     = (project.project_code || project.project_name || 'project').replace(/\s+/g, '-');
  const fileName = `${code}-sn-delta-${dateStr}.md`;

  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.send(md);
});

/**
 * POST /api/v1/projects/:id/servicenow/register-sysid
 * Closes the round-trip loop. After a Workbench-authored entity is CREATED in ServiceNow
 * (via the delta export + SDK deploy), record the returned `sys_id` (and optionally the SN
 * table/scope) onto the Workbench row. The next delta export then sees a `source_sys_id` and
 * classifies the entity as a PATCH (update) instead of a POST — preventing duplicate records
 * on the second pass, which is the core data-sync hazard of the round-trip.
 *
 * Body: { registrations: [{ entity_type, sys_id, entity_id?, slug?, source_table?, source_scope? }] }
 *       (a single such object is also accepted). Identify the Workbench row by EITHER its
 *       primary key (entity_id) OR its per-project slug (e.g. "AG-001") — slug lets a deploy
 *       manifest register without knowing internal IDs.
 */
app.post('/api/v1/projects/:id/servicenow/register-sysid', (req, res) => {
  const uid = userId(req);
  const project = db.prepare('SELECT project_id, servicenow_scope FROM asdlc_project WHERE project_id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const body = req.body || {};
  const regs = Array.isArray(body.registrations) ? body.registrations
             : (body.entity_type && (body.entity_id || body.slug)) ? [body] : null;
  if (!regs || !regs.length) {
    return res.status(400).json({ error: 'Provide registrations:[{entity_type, sys_id, entity_id|slug}] (or a single such object).' });
  }

  const registered = [], skipped = [];
  for (const r of regs) {
    const entity_type = r && r.entity_type, sys_id = r && r.sys_id, slug = r && r.slug;
    let entity_id = r && r.entity_id;
    const ref = entity_id || slug || null;   // for reporting
    if (!entity_type || !sys_id || (!entity_id && !slug)) {
      skipped.push({ entity_id: ref, slug: slug || null, reason: 'missing entity_type, sys_id, or one of entity_id/slug' }); continue;
    }
    // Resolve target table/pk: generic artifacts live in asdlc_sn_artifact; everything
    // else in the 22-type business registry.
    let tbl, pk;
    if (entity_type === 'sn_artifact') { tbl = 'asdlc_sn_artifact'; pk = 'sn_artifact_id'; }
    else {
      const ent = registry.byEntityType[entity_type];
      if (!ent || !ent.materializable || !ent.table || !ent.pk) {
        skipped.push({ entity_id: ref, slug: slug || null, reason: `unknown or non-materializable entity_type "${entity_type}"` }); continue;
      }
      tbl = ent.table; pk = ent.pk;
    }
    let row;
    try {
      if (!entity_id && slug) {
        row = db.prepare(`SELECT ${pk} AS pk, source_sys_id FROM ${tbl} WHERE slug = ? AND project_id = ?`).get(slug, req.params.id);
        if (row) entity_id = row.pk;
      } else {
        row = db.prepare(`SELECT ${pk} AS pk, source_sys_id FROM ${tbl} WHERE ${pk} = ? AND project_id = ?`).get(entity_id, req.params.id);
      }
    } catch (e) {
      skipped.push({ entity_id: ref, slug: slug || null, reason: `table ${tbl} does not support ServiceNow links` }); continue;
    }
    if (!row) { skipped.push({ entity_id: ref, slug: slug || null, reason: slug ? `slug "${slug}" not found in this project` : 'not found in this project' }); continue; }
    if (row.source_sys_id && row.source_sys_id !== sys_id) {
      skipped.push({ entity_id, slug: slug || null, reason: `already linked to a different sys_id (${row.source_sys_id})` }); continue;
    }
    if (row.source_sys_id === sys_id) { registered.push({ entity_id, slug: slug || null, sys_id, already_linked: true }); continue; }
    try {
      db.prepare(`
        UPDATE ${tbl}
           SET source_sys_id = ?,
               source_table  = COALESCE(?, source_table),
               source_scope  = COALESCE(?, source_scope),
               updated_by    = ?, updated_at = datetime('now')
         WHERE ${pk} = ? AND project_id = ?
      `).run(sys_id, r.source_table || null, r.source_scope || project.servicenow_scope || null, uid, entity_id, req.params.id);
      auditLog(tbl, entity_id, 'sn_register_sysid', { source_sys_id: null }, { source_sys_id: sys_id }, uid);
      registered.push({ entity_id, slug: slug || null, sys_id });
    } catch (e) {
      skipped.push({ entity_id, slug: slug || null, reason: e.message });
    }
  }

  res.json({ registered_count: registered.length, skipped_count: skipped.length, registered, skipped });
});

// ─── SN Delta markdown assembler ─────────────────────────────────────────────

function buildSNDeltaMarkdown(project, deltaCps, updates, creates, sinceTs, generics = [], instanceContext = null) {
  const lines    = [];
  const ts       = new Date().toISOString();
  const genUpdates = generics.filter(g => g.source_sys_id).length;
  const genCreates = generics.length - genUpdates;
  const prefix   = project.client_name ? `${project.client_name} — ` : '';
  const scope    = project.servicenow_scope    || '(not set)';
  const instance = project.servicenow_instance || '(not configured)';

  function fmtType(t) { return t.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '); }
  function stripProvenance(obj) {
    const o = { ...obj };
    ['source_sys_id','source_table','source_scope','source_fluent','source_hash','source_system'].forEach(k => delete o[k]);
    return o;
  }

  // ── Header ──────────────────────────────────────────────────────────────────
  lines.push(`# ${prefix}${project.project_name}`);
  lines.push(`## ServiceNow Delta Export + Deployment Instructions`);
  lines.push('');
  lines.push('> **Purpose:** Deploy approved Workbench design changes back to ServiceNow using the SDK.');
  lines.push('> Read the Deployment Instructions section at the bottom of this file before proceeding.');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('|---|---|');
  lines.push(`| Project | ${project.project_name}${project.project_code ? ` (${project.project_code})` : ''} |`);
  if (project.client_name) lines.push(`| Client | ${project.client_name} |`);
  lines.push(`| ServiceNow Scope | \`${scope}\` |`);
  lines.push(`| ServiceNow Instance | ${instance} |`);
  lines.push(`| Delta Baseline | ${sinceTs ? sinceTs : 'First-time export (no prior sync)'} |`);
  lines.push(`| Change Packets | ${deltaCps.length} approved |`);
  lines.push(`| Updates (PATCH) | ${updates.length} |`);
  lines.push(`| Creates (POST) | ${creates.length} |`);
  if (generics.length) lines.push(`| Generic artifacts (Fluent) | ${generics.length} (${genUpdates} update, ${genCreates} create) |`);
  lines.push(`| Exported | ${ts} |`);
  lines.push('');

  // ── Instance Context (whole-instance collision awareness for the POSTs below) ─
  renderInstanceContextSection(lines, instanceContext);

  lines.push('---');
  lines.push('');

  // ── Change Packets table ─────────────────────────────────────────────────────
  lines.push('## Change Packets Included in This Delta');
  lines.push('');
  if (!deltaCps.length) {
    lines.push('_No approved Change Packets found — nothing to deploy._');
  } else {
    lines.push('| CP Ref | Title | Non-Rejected Items |');
    lines.push('|---|---|---|');
    for (const cp of deltaCps) {
      lines.push(`| ${mdCell(cp.packet_code || cp.change_packet_id.slice(0, 8))} | ${mdCell(cp.summary)} | ${cp.item_count} |`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── PATCH: update existing SN records ────────────────────────────────────────
  lines.push('## 🔄 PATCH — Update Existing ServiceNow Records');
  lines.push('');
  if (!updates.length) {
    lines.push('_No records to update in this delta._');
    lines.push('');
  } else {
    lines.push('These records already exist in ServiceNow (they carry a `source_sys_id`).');
    lines.push('**Use PATCH, not POST.** Locate each by its `sys_id` and apply the Workbench values.');
    lines.push('');
    for (const u of updates) {
      lines.push(`### ${fmtType(u.entity_type)}: ${u.entity_name}`);
      lines.push('');
      lines.push('| Field | Value |');
      lines.push('|---|---|');
      lines.push(`| Workbench ID | \`${u.entity_id}\` |`);
      lines.push(`| SN sys_id | \`${u.row.source_sys_id}\` |`);
      if (u.row.source_table) lines.push(`| SN table | \`${u.row.source_table}\` |`);
      lines.push(`| SN scope | \`${u.row.source_scope || scope}\` |`);
      lines.push(`| From CP | ${mdCell(u.cp_ref)} — ${mdCell(u.cp_title)} |`);
      lines.push('');
      lines.push('**Workbench values to PATCH to ServiceNow:**');
      lines.push('');
      lines.push('```json');
      lines.push(JSON.stringify(stripProvenance(u.row), null, 2));
      lines.push('```');
      lines.push('');
    }
  }
  lines.push('---');
  lines.push('');

  // ── POST: create new SN records ───────────────────────────────────────────────
  lines.push('## ✨ POST — Create New ServiceNow Records');
  lines.push('');
  if (!creates.length) {
    lines.push('_No new records to create in this delta._');
    lines.push('');
  } else {
    lines.push('These records exist in the Workbench but not yet in ServiceNow (no `source_sys_id`).');
    lines.push('**Use POST.** After creation, capture the returned `sys_id` and register it back to the Workbench');
    lines.push('so the next delta correctly classifies this record as a PATCH (not another POST).');
    lines.push('');
    for (const c of creates) {
      lines.push(`### ${fmtType(c.entity_type)}: ${c.entity_name}`);
      lines.push('');
      lines.push('| Field | Value |');
      lines.push('|---|---|');
      lines.push(`| Workbench ID | \`${c.entity_id}\` |`);
      lines.push(`| Target SN scope | \`${scope}\` |`);
      lines.push(`| From CP | ${mdCell(c.cp_ref)} — ${mdCell(c.cp_title)} |`);
      lines.push('');
      lines.push('**Design values to POST to ServiceNow:**');
      lines.push('');
      lines.push('```json');
      lines.push(JSON.stringify(stripProvenance(c.row), null, 2));
      lines.push('```');
      lines.push('');
    }
  }

  // ── Fluent: generic artifacts (auto-generated deployable code) ───────────────
  lines.push('---');
  lines.push('');
  lines.push('## 🧱 ServiceNow Fluent — Generic Artifacts');
  lines.push('');
  if (!generics.length) {
    lines.push('_No generic artifacts in this delta._');
    lines.push('');
  } else {
    lines.push('Auto-generated Fluent (now-sdk) for artifacts on the generic substrate. Records carrying a');
    lines.push('`sys_id` are **updates** — coalesce on that `sys_id` (via `keys.ts`) so they PATCH rather than');
    lines.push('duplicate; records without are **creates**. Types with a curated field map emit their native');
    lines.push('typed constructor (`new Acl({...})`, `new Property({...})`); the long tail deploys via the generic');
    lines.push('`Record()`. Child artifacts (e.g. a table\'s columns) are listed under their parent.');
    lines.push('');

    const fluentKey = (g) => (g.slug || `${g.sn_metadata_type}_${(g.source_sys_id || 'new').slice(0, 14)}`).replace(/[^A-Za-z0-9_-]/g, '-');
    // Render a payload value as a Fluent literal per its curated type.
    const fmtVal = (v, type) => {
      if (type === 'boolean') return (v === true || v === 'true' || v === 1 || v === '1') ? 'true' : 'false';
      if (type === 'number')  { const n = Number(v); return Number.isFinite(n) ? String(n) : '0'; }
      if (type === 'string[]') {
        const arr = Array.isArray(v) ? v : String(v).split(',').map(s => s.trim()).filter(Boolean);
        return JSON.stringify(arr);
      }
      return JSON.stringify(v == null ? '' : String(v));   // string | text
    };
    const emitFluent = (g) => {
      const isUpdate = !!g.source_sys_id;
      const typed = g.deploy_strategy === 'typed' && g.fluent_api_name &&
        g.field_schema && Array.isArray(g.field_schema.fields) && g.field_schema.fields.length;
      lines.push(`### ${g.sn_metadata_type}: ${mdCell(g.name)}${g.child_role ? ` _(child: ${g.child_role})_` : ''} — ${isUpdate ? '🔄 UPDATE' : '✨ CREATE'}`);
      lines.push('');
      lines.push(`- Tier ${g.tier} · deploy strategy \`${g.deploy_strategy}\`${g.fluent_api_name ? ` · constructor \`${g.fluent_api_name}\`` : ''}`);
      if (isUpdate) lines.push(`- Existing ServiceNow \`sys_id\`: \`${g.source_sys_id}\` — coalesce on this so it PATCHes (no duplicate)`);
      lines.push(`- From CP ${mdCell(g.cp_ref)}`);
      if (g.fluent_api_name && g.deploy_strategy === 'typed' && !typed) {
        lines.push(`- A dedicated Fluent API \`new ${g.fluent_api_name}({...})\` exists; the raw field map below deploys reliably via \`Record()\` until a typed field map is curated.`);
      }
      lines.push('');
      lines.push('```typescript');
      if (typed) {
        // Idiomatic typed constructor (Phase 4): map curated SN columns → Fluent props.
        lines.push(`import { ${g.fluent_api_name} } from '@servicenow/sdk/core'`);
        lines.push('');
        lines.push(`${g.fluent_api_name}({`);
        lines.push(`  $id: Now.ID['${fluentKey(g)}'],`);
        for (const f of g.field_schema.fields) {
          if (!(f.col in g.payload)) continue;
          lines.push(`  ${f.prop}: ${fmtVal(g.payload[f.col], f.type)},`);
        }
        lines.push('})');
        const extra = Object.keys(g.override || {});
        if (extra.length) lines.push(`// + ${extra.length} override field(s) not in the typed surface: ${extra.join(', ')} — set via $override`);
      } else {
        // Generic fallback: faithful raw replay via Record().
        lines.push(`import { Record } from '@servicenow/sdk/core'`);
        lines.push('');
        lines.push('Record({');
        lines.push(`  $id: Now.ID['${fluentKey(g)}'],`);
        lines.push(`  table: '${g.source_table || '(unknown)'}',`);
        const dataStr = JSON.stringify({ ...g.payload, ...g.override }, null, 2).split('\n').join('\n  ');
        lines.push(`  data: ${dataStr},`);
        lines.push('})');
      }
      lines.push('```');
      lines.push('');
    };

    // Group children under their parent (when the parent is also in this delta).
    const ids = new Set(generics.map(g => g.entity_id));
    const childrenOf = {};
    const tops = [];
    for (const g of generics) {
      if (g.parent_artifact_id && ids.has(g.parent_artifact_id)) {
        (childrenOf[g.parent_artifact_id] = childrenOf[g.parent_artifact_id] || []).push(g);
      } else tops.push(g);
    }
    for (const g of tops) {
      emitFluent(g);
      for (const ch of (childrenOf[g.entity_id] || []).sort((a, b) => (a.child_order ?? 0) - (b.child_order ?? 0))) emitFluent(ch);
    }
  }

  // ── Deploy identity manifest (#87): known slug→sys_id mappings for keys.ts seeding ──
  lines.push('---');
  lines.push('');
  lines.push(...buildKeysManifestLines(project.project_id));

  // ── Companion: Deployment Instructions ────────────────────────────────────────
  lines.push('---');
  lines.push('');
  lines.push('# Deployment Instructions');
  lines.push('');
  lines.push('## ⚠️ Critical Rules — Read Before Deploying');
  lines.push('');
  lines.push('1. **NEVER deploy to production.** Target DEV or TEST only.');
  lines.push('2. **PATCH records that have a `sys_id`, POST records that do not.** Never create duplicates.');
  lines.push('3. **Sequence matters:** deploy parent entities (Use Cases, Agents) before children (Tools, Steps).');
  lines.push('4. **After POST:** capture the returned `sys_id` and register it back to the Workbench entity');
  lines.push('   (`source_sys_id` column) so future deltas treat it as PATCH.');
  lines.push('5. **Run a validation sync** after deployment to confirm all changes landed correctly.');
  lines.push('');
  lines.push('## Prerequisites');
  lines.push('');
  lines.push('```bash');
  lines.push('# Install the ServiceNow SDK (if not already installed)');
  lines.push('npm install -g @servicenow/sdk');
  lines.push('');
  lines.push(`# Configure credentials for the target DEV instance`);
  lines.push(`# Instance: ${instance}`);
  lines.push(`# Scope:    ${scope}`);
  lines.push('snc configure  # follow the prompts to enter instance URL and credentials');
  lines.push('snc app list   # verify the connection');
  lines.push('```');
  lines.push('');
  lines.push('## Deployment Steps');
  lines.push('');
  lines.push('1. **Review this delta** — confirm every PATCH/POST record is correct.');
  lines.push(`2. **Open the SDK project** for this scope:`);
  lines.push(`   \`\`\`bash`);
  lines.push(`   snc app open --scope ${scope}`);
  lines.push(`   \`\`\``);
  lines.push('3. **For each 🔄 PATCH record:**');
  lines.push('   - Locate the artifact file by its `sys_id`');
  lines.push('   - Apply the updated field values from the JSON block above');
  lines.push('   - Deploy to DEV: `snc app deploy --target DEV`');
  lines.push('4. **For each ✨ POST record:**');
  lines.push('   - Create a new artifact file in the SDK project');
  lines.push('   - Populate all fields from the JSON block above');
  lines.push('   - Deploy to DEV: `snc app deploy --target DEV`');
  lines.push('   - **Capture the new `sys_id`** from the deployment output');
  lines.push('5. **Validate the deployment:**');
  lines.push('   ```bash');
  lines.push('   snc app validate --target DEV');
  lines.push('   ```');
  lines.push('6. **Register new sys_ids** back to the Workbench so future deltas PATCH rather than re-create.');
  lines.push('   For each ✨ POST record, call the Workbench API with its Workbench ID, entity type, and the');
  lines.push('   new ServiceNow `sys_id` (this flips it to a PATCH next time — no duplicate):');
  lines.push('   ```bash');
  lines.push(`   curl -X POST "<workbench-url>/api/v1/projects/${project.project_id}/servicenow/register-sysid" \\`);
  lines.push('     -H "Content-Type: application/json" \\');
  lines.push('     -d \'{"registrations":[{"entity_type":"<type>","entity_id":"<workbench-id>","sys_id":"<new-sys_id>"}]}\'');
  lines.push('   ```');
  lines.push('7. **Advance the sync baseline** — run the Workbench SN ingest sync for this project');
  lines.push('   so `sn_last_synced_at` advances and the CPs above are excluded from the next delta.');
  lines.push('');
  lines.push('## Using Claude Code + SDK for AI-Assisted Deployment');
  lines.push('');
  lines.push('You can hand this entire file to Claude Code to automate the deployment:');
  lines.push('');
  lines.push('```');
  lines.push('Deploy the ServiceNow delta described in this file to the DEV instance.');
  lines.push('Follow the Critical Rules section exactly. Use PATCH for records with a sys_id,');
  lines.push('POST for records without one. Never touch production. Report the sys_id');
  lines.push('returned by each POST so I can register it back to the Workbench.');
  lines.push('```');
  lines.push('');
  lines.push('Claude Code will use the ServiceNow SDK to build the artifact files, apply the');
  lines.push('Workbench values, and deploy to DEV in the correct parent-before-child order.');
  lines.push('');
  lines.push('---');
  lines.push(`_Generated by Agentic SDLC Workbench · ${ts}_`);

  return lines.join('\n');
}

/**
 * Optional AI review of the deterministic build spec. Returns an additive Markdown
 * section (Executive Summary + Gaps + Implementation Notes) or null if no API key.
 */
async function generateBuildReview(project, md) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key === 'paste-your-anthropic-key-here') return null;
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: key });
  const model  = aiConfig.resolveModel('build_review');
  const system = [
    'You are a senior solution architect reviewing an Agentic AI build specification.',
    'You are given the complete, authoritative design spec (already assembled from the database).',
    'Write a concise review with EXACTLY these three Markdown H2 sections:',
    '## Executive Summary — 4–6 sentences for a non-technical sponsor.',
    '## Design Gaps & Completeness Review — bullet list of missing/weak/ambiguous areas, risks, and unanswered questions; reference entities by name.',
    '## Implementation Notes — practical guidance for the engineers who will build this (sequencing, integration risks, test focus).',
    'Do NOT restate the whole spec. Do NOT invent requirements not implied by the spec. If something is missing, say it is missing rather than fabricating it.',
  ].join('\n');

  const resp = await client.messages.create({
    model,
    max_tokens: 2048,
    system: withWiki(system),
    messages: [{ role: 'user', content: `Here is the build specification to review:\n\n${md}` }],
  });
  aiConfig.logUsage({ projectId: project.project_id, source: 'build_review', refId: project.project_id, model, usage: resp.usage });

  const text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!text) return null;
  return `---\n\n# AI Design Review & Implementation Notes\n\n_Generated by ${model}. Advisory only — the specification above is the authoritative, deterministic export._\n\n${text}`;
}

// ─── Build export markdown assembler ──────────────────────────────────────────

// Safely coerce any value to a plain string suitable for a Markdown table cell.
// Arrays are joined with '; ', objects are JSON-stringified, nulls become ''.
function mdCell(val) {
  if (val == null) return '';
  if (Array.isArray(val)) return val.map(v => mdCell(v)).join('; ');
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val).replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

// ── Instance Context (catalog-derived collision awareness) helpers ────────────
// Shared by the full Build Spec (buildExportMarkdown) and the SN delta spec
// (buildSNDeltaMarkdown). The Workbench knows the names it is about to CREATE, so it
// checks them against the latest instance catalog and surfaces only the hits.

// Build deployTargets (entities the Workbench would CREATE → no source_sys_id) from the
// build-export `data` object. A tracked row (has source_sys_id) is an intended PATCH, not
// a collision. Targets deploy INTO the project scope, so that's the scope we collide on.
function deployTargetsFromData(data, projectScope) {
  const map = snCatalog.DESIGN_SURFACE_MAP;
  const out = [];
  const add = (type, rows) => {
    const m = map[type]; if (!m) return;
    for (const r of (rows || [])) {
      if (r.source_sys_id) continue;
      const name = r[m.nameKey || 'name'] || r.name;
      if (!name) continue;
      out.push({ kind: type, name, slug: r.slug || null, surfaces: m.surfaces, scope: projectScope || null, instanceUnique: m.instanceUnique });
    }
  };
  add('agent_spec', data.agents);
  add('tool', data.tools);
  add('use_case', data.use_cases);
  add('workflow', data.workflows);
  add('data_model', data.data_models);
  add('business_logic', data.business_logic);
  add('catalog_item', data.catalog_items);
  add('integration', data.integrations);
  return out;
}

// Same, from the SN delta-export `creates` list (entities being POSTed → no source_sys_id).
function deployTargetsFromCreates(creates, projectScope) {
  const map = snCatalog.DESIGN_SURFACE_MAP;
  const out = [];
  for (const c of (creates || [])) {
    const m = map[c.entity_type]; if (!m) continue;
    const name = (c.row && c.row[m.nameKey || 'name']) || c.entity_name;
    if (!name) continue;
    out.push({ kind: c.entity_type, name, slug: (c.row && c.row.slug) || null, surfaces: m.surfaces, scope: projectScope || null, instanceUnique: m.instanceUnique });
  }
  return out;
}

// Load the latest COMPLETE catalog for a project and compute the instance-context view
// (collisions for deployTargets + a per-surface inventory). Returns {available:false}
// when no catalog exists so the caller can emit a "run a catalog" note.
function loadInstanceContext(projectId, deployTargets, { sampleSize = 25 } = {}) {
  let row;
  try {
    row = db.prepare("SELECT catalog_run_id, catalog_json, summary_json, capturing_user FROM asdlc_sn_catalog_run WHERE project_id=? AND status='complete' ORDER BY created_at DESC LIMIT 1").get(projectId);
  } catch { return { available: false }; }
  if (!row) return { available: false };
  let catalog = null, summary = null;
  try { catalog = JSON.parse(row.catalog_json); } catch { /* unreadable */ }
  try { summary = row.summary_json ? JSON.parse(row.summary_json) : null; } catch { /* ignore */ }
  if (!catalog) return { available: false };
  const collisions = snCatalog.computeCollisions(catalog, deployTargets || []);
  const inventory = {};
  for (const [t, rows] of Object.entries(catalog.surfaces || {})) {
    inventory[t] = { count: rows.length, sample: rows.slice(0, sampleSize).map(r => r.name).filter(Boolean) };
  }
  return { available: true, captured_at: catalog.captured_at, capturing_user: row.capturing_user, summary, collisions, inventory };
}

// Render the `## Instance Context` section into a markdown lines[] array. Bounded by
// design: only collision HITS + a collapsed, sampled inventory (the spec is unbounded).
function renderInstanceContextSection(lines, ic) {
  lines.push('---'); lines.push('');
  lines.push('## Instance Context');
  lines.push('');
  if (!ic || !ic.available) {
    lines.push('> No instance catalog has been captured for this project — **collision checks were skipped**. Run a Catalog sweep (Instance Catalog page) to enable "what already exists on this instance" awareness before deploying.');
    lines.push('');
    return;
  }
  const s = ic.summary || {};
  const surfaceCount = Object.keys(s.surface_counts || {}).length;
  lines.push(`> Catalog captured **${ic.captured_at || '?'}** by **${ic.capturing_user || '?'}** · ${s.total_entries || 0} records across ${surfaceCount} surfaces.`);
  lines.push('>');
  lines.push('> ⚠️ **Completeness caveat:** the catalog reflects only what the capturing account can read (ServiceNow ACL-filters rows silently). Absence of a collision is **not** proof a name is free.');
  lines.push('');
  const collisions = ic.collisions || [];
  const hard = collisions.filter(c => c.hard);
  const soft = collisions.filter(c => !c.hard);
  if (hard.length) {
    lines.push('### ⚠️ Name collisions — a record with this name ALREADY EXISTS on the target instance');
    lines.push('');
    lines.push('| Deploying | SN surface | Existing scope | sys_id |');
    lines.push('|---|---|---|---|');
    for (const c of hard) lines.push(`| ${c.deploy_kind}: ${c.name} | \`${c.surface}\` | \`${c.scope || '?'}\` | \`${c.sys_id}\` |`);
    lines.push('');
    lines.push('> Resolve each before deploy: PATCH the existing record (register its sys_id onto the Workbench row), rename, or confirm the duplicate is intentional. A blind create will duplicate or clobber.');
    lines.push('');
  } else {
    lines.push('_No hard name collisions detected against the captured catalog._');
    lines.push('');
  }
  if (soft.length) {
    lines.push('<details><summary>Same-name records in OTHER scopes (informational — names are unique per scope)</summary>');
    lines.push('');
    for (const c of soft) lines.push(`- ${c.deploy_kind}: \`${c.name}\` also exists in scope \`${c.scope || '?'}\` (\`${c.surface}\`)`);
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }
  if (ic.inventory && Object.keys(ic.inventory).length) {
    lines.push('<details><summary>Instance inventory — per-surface counts + sample names</summary>');
    lines.push('');
    for (const [t, info] of Object.entries(ic.inventory)) {
      if (!info.count) continue;
      const names = info.sample && info.sample.length ? ` — e.g. ${info.sample.slice(0, 25).join(', ')}` : '';
      lines.push(`- \`${t}\`: ${info.count}${names}`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }
}

function buildExportMarkdown(project, baseline, sections, data) {
  const lines  = [];
  const ts     = new Date().toISOString();
  const prefix = project.client_name ? `${project.client_name} — ` : '';

  // Helper: format a cost value as $X,XXX
  function fmtCost(n) {
    if (!n || n === 0) return '$0';
    if (n < 100)  return `$${n.toFixed(2)}`;
    return `$${Math.round(n).toLocaleString('en-US')}`;
  }

  // ── Header ─────────────────────────────────────────────────────────────────
  lines.push(`# ${prefix}${project.project_name}`);
  lines.push(`## Agentic Application Build Specification for ServiceNow`);
  lines.push('');
  lines.push('> **Purpose:** Use this document to build ServiceNow artifacts (agents, workflows, etc.)');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('|---|---|');
  lines.push(`| Project | ${project.project_name}${project.project_code ? ` (${project.project_code})` : ''} |`);
  if (project.client_name) lines.push(`| Client | ${project.client_name} |`);
  if (project.stage)       lines.push(`| Stage | ${project.stage} |`);
  if (baseline && baseline.locked_at) {
    lines.push(`| Version | ${baseline.baseline_name} — locked ${baseline.locked_at.slice(0, 10)} |`);
  } else {
    lines.push(`| Version | Current live design |`);
  }
  lines.push(`| Exported | ${ts} |`);
  lines.push('');

  // ── Build Readiness ──────────────────────────────────────────────────────────
  // Emitted immediately after the header so Claude Code can see at a glance
  // whether this spec is fully self-contained or needs manual steps before install.
  {
    const snRunAsForBR  = data.sn_runas || null;
    const resolvedRunAs = !!(snRunAsForBR && snRunAsForBR.sys_id);
    const dmCount       = sections.includes('data_models')    ? (data.data_models    || []).length : null;
    const blCount       = sections.includes('business_logic') ? (data.business_logic || []).length : null;
    const agentCount    = sections.includes('agents')         ? (data.agents         || []).length : null;
    const wfCount       = sections.includes('workflows')      ? (data.workflows      || []).length : null;

    lines.push('---'); lines.push('');
    lines.push('## Build Readiness');
    lines.push('');
    lines.push('> Quick-check before opening the SDK. Items marked ❌ **must** be resolved manually before running `npx now-sdk install`.');
    lines.push('');
    lines.push('| Item | Status |');
    lines.push('|---|---|');

    if (resolvedRunAs) {
      const who = [snRunAsForBR.user_name, snRunAsForBR.name].filter(Boolean).join(' / ');
      lines.push(`| \`runAsUser\` sys_id | ✅ Resolved at export — \`${snRunAsForBR.sys_id}\`${who ? ` (${who})` : ''} |`);
    } else if (project.sn_user || project.servicenow_instance) {
      lines.push(`| \`runAsUser\` sys_id | ❌ **Manual step required** — account \`${project.sn_user || '?'}\` on \`${project.servicenow_instance || '?'}\` — look up sys_id via SDK query before install (see Pre-flight §1) |`);
    } else {
      lines.push(`| \`runAsUser\` sys_id | ❌ **Manual step required** — no account configured; resolve sys_id before install (see Pre-flight §1) |`);
    }

    if (dmCount !== null && blCount !== null && blCount > 0 && dmCount === 0) {
      lines.push(`| Table prerequisites | ❌ **${blCount} business rule(s) but 0 data models** — the tables these rules target must already exist on the instance (or be added to this spec). Deploy tables before business logic. |`);
    } else if (dmCount !== null && blCount !== null && dmCount > 0 && blCount > 0) {
      lines.push(`| Table prerequisites | ⚠ ${dmCount} table(s) + ${blCount} business rule(s) — deploy data models in a **separate first pass** before business rules (see Deployment Sequence step 1) |`);
    } else {
      lines.push(`| Table prerequisites | ✅ No cross-dependency detected in this export |`);
    }

    if (agentCount !== null && wfCount !== null && wfCount > 0 && agentCount === 0) {
      lines.push(`| Agent-less workflows | ⚠ ${wfCount} workflow(s) with no agents in this spec — **omit \`team\` block** on all of them (see Common Mistakes) |`);
    } else {
      lines.push(`| Agent-less workflows | ✅ |`);
    }

    lines.push('');
  }

  // ── Delta preamble (only when generated in delta mode) ─────────────────────
  const exportMeta = data._export_meta || {};
  if (exportMeta.deltaMode) {
    lines.push('---'); lines.push('');
    lines.push('> ⚠️ **Delta Build Spec** — Contains only entities changed since the last export.');
    if (exportMeta.sinceTs) {
      lines.push(`> Last export: **${exportMeta.sinceTs.slice(0, 10)}**. Only records with \`updated_at\` after that date are included in each design section.`);
    } else {
      lines.push('> No prior export found — this is the first export so all records are included (identical to a full spec).');
    }
    lines.push('> Claude Code should **PATCH** existing records and **POST** new ones. Do **not** redeploy or overwrite artifacts absent from this spec.');
    lines.push('');
    const deltaCtx = data._delta_context || {};
    if (deltaCtx.cps && deltaCtx.cps.length) {
      lines.push('### Change Context (Approved CPs driving this export)');
      lines.push('');
      lines.push('| CP | Summary | Date |');
      lines.push('|---|---|---|');
      for (const cp of deltaCtx.cps) {
        lines.push(`| ${cp.packet_code || ''} | ${mdCell(cp.summary || '(no summary)')} | ${(cp.updated_at || '').slice(0, 10)} |`);
      }
      lines.push('');
    }
  }

  // ── Instance Context (whole-instance collision awareness) ───────────────────
  // What already exists on the target instance, + ⚠️ collisions for names this spec
  // would CREATE. Computed in the handler from the latest catalog (data._instance_context).
  renderInstanceContextSection(lines, data._instance_context);

  // ── ServiceNow SDK Quick Reference ─────────────────────────────────────────
  // Always emitted — gives Claude Code the SDK conventions it needs to generate
  // valid TypeScript artifact files without leaving the document.
  lines.push('---'); lines.push('');
  lines.push('## 📖 ServiceNow SDK Quick Reference');
  lines.push('');
  lines.push(`> **Source:** https://servicenow.github.io/sdk/guides/building-ai-agents-guide`);
  lines.push(`> *SDK conventions embedded at export time (${ts.slice(0,10)}). Check URL for latest updates.*`);
  lines.push('');

  lines.push('### Agent vs Workflow — When to Use Which');
  lines.push('');
  lines.push('| Use case | Choose |');
  lines.push('|---|---|');
  lines.push('| Multiple tools on same table / same capability type | **AI Agent** (`AiAgent`) |');
  lines.push('| Sequential specialization across different capability types | **AI Agentic Workflow** (`AiAgenticWorkflow`) |');
  lines.push('');

  lines.push('### Required Fields');
  lines.push('');
  lines.push('| Artifact | Required Fields |');
  lines.push('|---|---|');
  lines.push('| AI Agent | `$id`, `name`, `description`, `agentRole`, `securityAcl`, `versionDetails` (array) |');
  lines.push('| AI Agentic Workflow | `$id`, `name`, `description`, `securityAcl`, `team.$id` *(only when agents are linked — omit entirely for zero-agent workflows)*, `versions` (array) |');
  lines.push('| All tools | `name`, `type` |');
  lines.push('| All versions | `name`, `number`, `state`, `instructions` |');
  lines.push('');
  lines.push('> ⚠ **`securityAcl` is mandatory on both `AiAgent` and `AiAgenticWorkflow`.**');
  lines.push('');

  lines.push('### Deployment Sequence');
  lines.push('');
  lines.push('0. **Initialize the project before installing.** A fresh project folder needs `npx now-sdk init --auth` to create the `sys_scope` record on the instance and write `scopeId` back into `now.config.json`. `now-sdk install` will **not** create the scope — it fails if `scopeId` is absent.');
  lines.push('1. **Deploy data models (tables + fields) before anything else.** Business rules, client scripts, and UI actions are table-scoped — they fail silently or error on install if the target table does not exist. Run an isolated first `now-sdk install` pass with only data models, confirm the tables are live on the instance, then run the full install for all remaining artifacts.');
  lines.push('2. Define `securityAcl` (with `$id` and `type`)');
  lines.push('3. Configure tools — priority order: OOB → reference-based → CRUD → script (last resort)');
  lines.push('4. Author `instructions` referencing tool names explicitly; include failure contingencies');
  lines.push('5. Define `versionDetails`/`versions` (1+ required, `state: "published"`)');
  lines.push('6. **Workflows reference agents by real `sys_id` — plan for a two-pass install.** On the first install, `team.members` referenced via the `Record()`/`Now.ID` coalesce create empty **stub** agent records rather than resolving to the real agents. Install once to obtain the real agent `sys_id`s, hardcode those strings into `team.members`, then rebuild and reinstall.');
  lines.push('7. Configure `triggerConfig` — agents use `"nap"` or `"nap_and_va"`; workflows use `"Now Assist Panel"`');
  lines.push('8. Validate: query `sn_aia_agent` (agents) or `sn_aia_usecase` (workflows) to verify deployment');
  lines.push('');

  lines.push('### ⚠ Round-Trip Identity Rules (read before deploying)');
  lines.push('');
  lines.push('This design round-trips: artifacts you create here will later be re-captured and reconciled back into the Workbench. To prevent **duplicate** design records, preserve a stable identity link.');
  lines.push('');
  lines.push('**DO:**');
  lines.push('- Embed the Workbench **identity tag** verbatim on its own trailing line of each artifact\'s `description` field. The tag format is `[[wb:<PROJECT_ID>/<SLUG>]]` — qualifying with the Project ID keeps it **globally unique across every instance and scope** (a bare slug like `AG-001` is only unique within one project).');
  lines.push(`  - **This application\'s Project ID:** \`${project.project_id}\``);
  lines.push('  - **`<SLUG>`** is the value printed in each artifact\'s section heading (e.g. `AG-001`, `T-003`, `WF-001`). Use the exact tags listed in the table below.');
  lines.push('- Keep it **1:1** — one tag per ServiceNow record, matching exactly one source design record.');
  lines.push('- After `now-sdk install`, fill in the **Post-Deploy: Register sys_ids** manifest at the bottom of this document and POST it (this records each returned `sys_id` onto its Workbench row).');
  lines.push('');
  lines.push('**DON\'T:**');
  lines.push('- Don\'t remove or edit the `[[wb:...]]` tag once deployed — it is the durable identity key that lets a re-sync match even before sys_ids are registered.');
  lines.push('- Don\'t split one Workbench artifact into multiple ServiceNow records without tagging **each** — an untagged extra record is classified NEW on the next sync (a duplicate candidate).');
  lines.push('- Don\'t invent slugs or alter the Project ID. If a needed artifact has no slug here, leave it untagged and flag the design owner.');
  lines.push('- Don\'t use `ART-###` slugs for Level-1 design entities (Data Models, Business Logic, etc.) — each L1 type has its own slug namespace (`DM-###`, `BL-###`, etc.). `ART-###` slugs belong exclusively to rows in the generic artifact substrate (`asdlc_sn_artifact`).');
  lines.push('');
  // Concrete, copy-paste-exact identity tags for every in-scope artifact (built from the same data
  // the sections below render). Globally unique because each is qualified with the Project ID.
  const tagRows = [];
  for (const a of (data.agents || []))    if (a.slug) tagRows.push([`Agent: ${a.name}`,    a.slug]);
  for (const w of (data.workflows || [])) if (w.slug) tagRows.push([`Workflow: ${w.name}`, w.slug]);
  for (const t of (data.tools || []))     if (t.slug) tagRows.push([`Tool: ${t.name}`,     t.slug]);
  if (tagRows.length) {
    lines.push('**Identity tags for this application** (copy the exact tag into each record\'s `description`):');
    lines.push('');
    lines.push('| Artifact | Identity tag to embed |');
    lines.push('|---|---|');
    for (const [label, slug] of tagRows) lines.push(`| ${mdCell(label)} | \`[[wb:${project.project_id}/${slug}]]\` |`);
    lines.push('');
  }

  // Generic artifact identity tags (ART-### slugs)
  const artTagRows = (data.sn_generic_artifacts || []).filter(a => a.slug);
  if (artTagRows.length) {
    lines.push('**Generic Artifact identity tags** (embed in the SN artifact\'s `description` field on its own trailing line):');
    lines.push('');
    lines.push('| Artifact | Type | Identity tag to embed |');
    lines.push('|---|---|---|');
    for (const art of artTagRows) {
      lines.push(`| ${mdCell(art.name)} | \`${art.sn_metadata_type}\` | \`[[wb:${project.project_id}/${art.slug}]]\` |`);
    }
    lines.push('');
    lines.push('> **Note:** Tier-B and Tier-C artifacts use `Record()` with `sys_id` coalescing — when `source_sys_id` is set the SDK PATCHes the existing record; when absent it POSTs a new one. Child artifacts (columns, variables, actions) carry their own identity tag and are tracked independently.');
    lines.push('');
  }

  // ── Deploy identity manifest (#87): known slug→sys_id mappings for keys.ts seeding ──
  lines.push(...buildKeysManifestLines(project.project_id));

  lines.push('### Tool Selection Priority (highest → lowest)');
  lines.push('');
  lines.push('1. **OOB tools** — `web_search`, `rag`, `knowledge_graph`');
  lines.push('2. **Reference-based** — `action`, `subflow`, `capability`');
  lines.push('3. **CRUD tools** — `create`, `lookup`, `update`, `delete`');
  lines.push('4. **Script tools** — last resort only (no alternative fits)');
  lines.push('');

  lines.push('### Key SDK Patterns');
  lines.push('');
  lines.push('```typescript');
  lines.push('import { AiAgent } from "@servicenow/sdk/core";            // single agent');
  lines.push('import { AiAgenticWorkflow } from "@servicenow/sdk/core";  // orchestrated workflow');
  lines.push('');
  lines.push('// Record identity pattern');
  lines.push('$id: Now.ID["unique_identifier"]');
  lines.push('');
  lines.push('// Agents use versionDetails; workflows use versions (different names!)');
  lines.push('versionDetails: [{ name: "V1", number: 1, state: "published", instructions: `...` }]');
  lines.push('versions:       [{ name: "V1", number: 1, state: "published", instructions: `...` }]');
  lines.push('');
  lines.push('// CRUD queryCondition syntax');
  lines.push('queryCondition: "column_name=={{input_field_name}}"');
  lines.push('');
  lines.push('// Script tools: inputs are strings at runtime');
  lines.push('const id = parseInt(inputs.record_id);  // must parse manually');
  lines.push('// Always use GlideRecordSecure (NOT GlideRecord) in script tools');
  lines.push('```');
  lines.push('');

  lines.push('### Generic Artifact Deployment (`Record()` pattern)');
  lines.push('');
  lines.push('Generic artifacts (ACLs, roles, SLAs, properties, widgets, flow actions, etc.) are deployed via the Fluent `Record()` constructor when no typed API exists, or via a dedicated typed constructor (e.g. `Acl`, `Sla`) when the `asdlc_sn_type_registry` shows `deploy_strategy: \'typed\'`.');
  lines.push('');
  lines.push('```typescript');
  lines.push('import { Record } from \'@servicenow/sdk/core\'');
  lines.push('');
  lines.push('// deploy_strategy: \'record\'  (Tier B/C long-tail — generic fallback)');
  lines.push('Record({');
  lines.push('  $id: Now.ID[\'ART-042\'],          // slug from asdlc_sn_artifact.slug');
  lines.push('  table: \'sys_security_acl\',        // source_table from the artifact row');
  lines.push('  data: { /* payload + override_fields merged */ },');
  lines.push('})');
  lines.push('');
  lines.push('// deploy_strategy: \'typed\'  (Tier A/B with a dedicated Fluent constructor)');
  lines.push('// import { Acl } from \'@servicenow/sdk/core\'   // fluent_api_name from the registry row');
  lines.push('// new Acl({ $id: Now.ID[\'ART-007\'], ...typedFields })');
  lines.push('');
  lines.push('// PATCH vs POST: when source_sys_id is set on the artifact row, wire the $id');
  lines.push('// through keys.ts coalescing so the SDK PATCHes rather than creating a duplicate.');
  lines.push('// Each child artifact (column, variable, action) has its own $id + source_sys_id');
  lines.push('// and is tracked + deployed independently of its parent.');
  lines.push('```');
  lines.push('');
  lines.push('> ⚠ **Tier-A twin rule:** Tier-A generic artifacts project onto a Level-1 row (Data Model, Form Design, etc.). Deploy the L1 row and its generic twin together as a single SDK artifact install — never deploy the generic twin independently. The Delta Export handles this pairing automatically.');
  lines.push('');

  lines.push('### Common Mistakes to Avoid');
  lines.push('');
  lines.push('- [ ] Using `versionDetails` on workflows (use `versions` — different field name)');
  lines.push('- [ ] Using `runAs` on agents (use `runAsUser`)');
  lines.push('- [ ] Omitting `securityAcl` or `dataAccess` when `runAsUser`/`runAs` absent');
  lines.push('- [ ] Missing `$id` on `team` object in workflows');
  lines.push('- [ ] Assuming `Record()`/`Now.ID` agent refs in `team.members` resolve on first install — they create empty stubs; do the two-pass install with real `sys_id`s (Deployment Sequence step 5)');
  lines.push('- [ ] Setting `team.description` manually (auto-populated — do not set)');
  lines.push('- [ ] Referencing "triggering record" in instructions — use "from the task" or "from the context"');
  lines.push('- [ ] Using `GlideRecord` in script tools — always use `GlideRecordSecure`');
  lines.push('- [ ] Script tool inputs defined as object (must be **array**); omit `inputSchema` (auto-generated)');
  lines.push('- [ ] Deploying a Tier-A generic artifact independently from its Level-1 row — they form a single SDK artifact; use the Delta Export which handles the pairing, or deploy both in the same install pass');
  lines.push('- [ ] Creating a `team` block when the workflow has **zero agents linked** — this generates non-unique stub records that collide on install. If a workflow has no agents, **omit `team` entirely** rather than generating an empty or placeholder block.');
  lines.push('- [ ] Attempting raw REST calls, `Invoke-WebRequest`, or PowerShell credential extraction to resolve a missing `sys_id` — the SDK already holds valid credentials; use `npx now-sdk query` instead, and if that fails, stop and ask the human. Never improvise an alternative auth path.');
  lines.push('');

  // ── ServiceNow Pre-flight Checklist ────────────────────────────────────────
  lines.push('---'); lines.push('');
  lines.push('## ⚠ ServiceNow Pre-flight Checklist');
  lines.push('');
  lines.push('Complete **all** items below before running `npx now-sdk install`.');
  lines.push('');

  // Authentication & project initialization — done before anything else.
  lines.push('### 0. Authentication & Project Initialization');
  lines.push('');
  lines.push('- [ ] Run `npx now-sdk auth --list` and confirm the credential alias for the target instance is set as **default** (starred). Authenticating mid-build is the single biggest time sink — resolve it first.');
  lines.push('- [ ] **Use the Claude user\'s saved ServiceNow credentials (the `now-sdk auth` alias) — never the admin profile.** Deploy under the already-authenticated non-admin alias shown by `now-sdk auth --list`; do not switch to an admin account or prompt for admin credentials to get around an auth/permission error.');
  lines.push('- [ ] For a fresh project folder, run `npx now-sdk init --auth` to create the `sys_scope` record on the instance and write `scopeId` into `now.config.json`. `now-sdk install` will not create the scope.');
  lines.push('- [ ] Pin the build to this one project folder. Reading or writing other scoped-app folders mid-session risks cross-contamination.');
  lines.push('- [ ] **Never inspect credential storage files, extract OAuth tokens, or make raw REST/PowerShell calls to resolve missing `sys_id`s.** The SDK holds valid credentials — use `npx now-sdk query --table <table> --filter "<field>=<value>" --fields sys_id,name` for any lookup. If `now-sdk query` fails, stop and ask the human — do **not** improvise an alternative auth path.');
  lines.push('');

  // Service accounts
  lines.push('### 1. Service Accounts');
  lines.push('');
  lines.push('Create (or identify) the `runAsUser` service account on the target instance and record its `sys_id`. If the account already exists, resolve its `sys_id` **now** and substitute it for the placeholder before install — this avoids a mid-build REST round-trip to look it up.');
  lines.push('');
  // data.sn_runas is populated at export time by a live, read-only sys_user lookup
  // of the project's configured account (null if not configured / unreachable).
  const snRunAs = data.sn_runas || null;
  if (snRunAs && snRunAs.sys_id) {
    const who = [snRunAs.user_name, snRunAs.name].filter(Boolean).join(' — ');
    lines.push(`> ✅ **\`runAsUser\` resolved live from the instance:** ${who ? `**${who}** → ` : ''}sys_id \`${snRunAs.sys_id}\`. Use this value directly — no manual lookup needed. (If your agents should run as a *different* dedicated service account, override it with that account's \`sys_id\`.)`);
    lines.push('');
  } else if (project.sn_user || project.servicenow_instance) {
    const acct = project.sn_user || '(not set)';
    const inst = project.servicenow_instance || '(not set)';
    lines.push(`> ❌ **STOP — \`runAsUser\` sys_id is unresolved.** Do not run \`npx now-sdk install\` until the placeholder \`REPLACE_WITH_AGENT_SERVICE_ACCOUNT_SYS_ID\` is replaced with a real sys_id.`);
    lines.push(`>`);
    lines.push(`> **Configured account:** \`${acct}\` on \`${inst}\``);
    lines.push(`>`);
    lines.push('> **To resolve using only the SDK (no raw REST):**');
    lines.push(`> \`\`\`bash`);
    lines.push(`> npx now-sdk query --table sys_user --filter "user_name=${acct}" --fields sys_id,user_name,name`);
    lines.push(`> \`\`\``);
    lines.push(`> If \`npx now-sdk query\` is unavailable or returns no results, **ask the human to provide the sys_id manually**. Do NOT make raw REST calls, extract OAuth tokens, or read credential files to obtain it.`);
    lines.push('');
  }
  const runAsVal = (snRunAs && snRunAs.sys_id) ? `\`${snRunAs.sys_id}\`` : '`REPLACE_WITH_AGENT_SERVICE_ACCOUNT_SYS_ID`';
  lines.push('| `runAsUser` value to use | Purpose | Minimum Roles Required |');
  lines.push('|---|---|---|');
  const agentsForPreflight = (data.agents || []);
  if (agentsForPreflight.length) {
    for (const a of agentsForPreflight) {
      const roles = a.access_requirements || 'See agent specification';
      lines.push(`| ${runAsVal} | Runtime identity for **${a.name}** | ${mdCell(roles)} |`);
    }
  } else {
    lines.push(`| ${runAsVal} | Agent runtime service account | Verify with architect |`);
  }
  lines.push('');
  lines.push('> ⚠ **Now Assist Panel role:** any agent or workflow using the `nap` / `nap_and_va` channel will not appear in — or fire from — the Now Assist Panel unless the `runAsUser` account holds the **`now_assist_panel_user`** role. Verify this role is assigned before any end-to-end test.');
  lines.push('');

  // REST Message records
  const restTools = (data.tools || []).filter(t => {
    const m = (t.execution_mode || '').toLowerCase();
    return m.includes('rest') || m.includes('http') || m.includes('api') || m.includes('spoke');
  });
  lines.push('### 2. REST Message Records');
  lines.push('');
  if (restTools.length) {
    lines.push('Create the following records at **System Web Services › Outbound › REST Message**:');
    lines.push('');
    lines.push('| REST Message Name | Execution Mode | Access / Auth Notes |');
    lines.push('|---|---|---|');
    for (const t of restTools) {
      lines.push(`| **${t.name}** | ${mdCell(t.execution_mode)} | ${mdCell(t.access_requirements)} |`);
    }
    lines.push('');
    lines.push('For each record above, also create the HTTP Method child record and test the connection before proceeding.');
  } else {
    lines.push('*No REST-mode tools detected. Verify tool execution modes in Section 4.*');
  }
  lines.push('');

  // IntegrationHub actions
  const ihTools = (data.tools || []).filter(t => {
    const m = (t.execution_mode || '').toLowerCase();
    return m.includes('integration') || m.includes('hub') || m.includes('flow') || m.includes('action');
  });
  lines.push('### 3. IntegrationHub Actions');
  lines.push('');
  if (ihTools.length) {
    lines.push('Create or verify the following IntegrationHub actions (Scope shown in tool name prefix):');
    lines.push('');
    lines.push('| Action Name | Scope | Input Fields | Output Fields |');
    lines.push('|---|---|---|---|');
    for (const t of ihTools) {
      const inputKeys  = t.inputs  ? Object.keys(t.inputs).join(', ')  : '—';
      const outputKeys = t.outputs ? Object.keys(t.outputs).join(', ') : '—';
      const scope = t.name.includes('.') ? t.name.split('.')[0] : 'global';
      lines.push(`| \`${t.name}\` | ${scope} | ${inputKeys} | ${outputKeys} |`);
    }
  } else {
    lines.push('*No IntegrationHub-mode tools detected. Verify tool execution modes in Section 4.*');
  }
  lines.push('');

  // Trigger condition verification
  lines.push('### 4. Trigger Condition Verification');
  lines.push('');
  lines.push('Verify the agent trigger matches your instance\'s record classification before deploying:');
  lines.push('');
  const wfsForTrigger = (data.workflows || []);
  if (wfsForTrigger.length) {
    for (const wf of wfsForTrigger) {
      const trig = wf.trigger || {};
      lines.push(`**Workflow: ${wf.name}${wf.slug ? ` (${wf.slug})` : ''}**`);
      lines.push('');
      lines.push('| Trigger Field | Value to verify on instance |');
      lines.push('|---|---|');
      if (trig.type  || trig.event)      lines.push(`| Trigger Type | \`${trig.type || trig.event}\` |`);
      if (trig.table)                    lines.push(`| Table | \`${trig.table}\` |`);
      if (trig.condition || trig.filter) lines.push(`| Filter Condition | \`${trig.condition || trig.filter}\` |`);
      if (trig.category)                 lines.push(`| Category | \`${trig.category}\` — confirm this value exists on the instance |`);
      if (trig.channel)                  lines.push(`| Channel | \`${trig.channel}\` |`);
      const knownKeys = new Set(['type','event','table','condition','filter','category','channel']);
      const extraKeys = Object.keys(trig).filter(k => !knownKeys.has(k));
      for (const k of extraKeys) lines.push(`| ${k} | \`${mdCell(trig[k])}\` |`);
      if (!Object.keys(trig).length) lines.push('| — | See workflow trigger definition |');
      lines.push('');
    }
  } else {
    lines.push('*No workflow data included in this export. Re-export with Workflows section enabled.*');
    lines.push('');
  }

  // sys_id placeholder summary
  lines.push('### 5. sys_id Placeholders Summary');
  lines.push('');
  lines.push('Search the generated SDK files for these strings and replace before install:');
  lines.push('');
  lines.push('| Placeholder | What to substitute |');
  lines.push('|---|---|');
  if (snRunAs && snRunAs.sys_id) {
    lines.push(`| \`REPLACE_WITH_AGENT_SERVICE_ACCOUNT_SYS_ID\` | \`${snRunAs.sys_id}\` — resolved live from \`${snRunAs.user_name || project.sn_user}\` (override if using a different dedicated service account) |`);
  } else {
    lines.push('| `REPLACE_WITH_AGENT_SERVICE_ACCOUNT_SYS_ID` | `sys_id` of the service account from step 1 |');
  }
  const instSub = project.servicenow_instance
    ? `\`${project.servicenow_instance}\` (configured for this project)`
    : 'Your ServiceNow instance URL (e.g. `https://myinstance.service-now.com`)';
  lines.push(`| \`REPLACE_WITH_INSTANCE_URL\` | ${instSub} |`);
  lines.push('');

  // Cost model verification (only if any agent uses SN Now Assist)
  const nowAssistAgents = agentsForPreflight.filter(a => a.cost_model === 'servicenow_now_assist');
  if (nowAssistAgents.length) {
    lines.push('### 6. Cost Model Verification (Now Assist)');
    lines.push('');
    lines.push('The following agents are configured for ServiceNow Now Assist cost tracking:');
    lines.push('');
    for (const a of nowAssistAgents) {
      lines.push(`- **${a.name}**${a.slug ? ` (${a.slug})` : ''}`);
    }
    lines.push('');
    lines.push('Before go-live, verify the Now Assist entitlement settings and cost-per-assist value');
    lines.push('in the **Cost Management** admin page within the workbench.');
    lines.push('');
  }

  // ── Requirements (FR + NFR) ─────────────────────────────────────────────────
  if (sections.includes('requirements') && (data.functional_reqs !== undefined || data.nonfunctional_reqs !== undefined)) {
    lines.push('---'); lines.push('');
    lines.push('## Requirements'); lines.push('');
    lines.push('> Functional and non-functional requirements that define what the application must do and how it must perform.');
    lines.push('> Each artifact (agent, workflow, tool) should implement the requirements linked to it.');
    lines.push('');
    const frs  = data.functional_reqs    || [];
    const nfrs = data.nonfunctional_reqs || [];
    if (!frs.length && !nfrs.length) {
      lines.push('*No requirements defined.*'); lines.push('');
    }
    if (frs.length) {
      lines.push('### Functional Requirements'); lines.push('');
      lines.push('| Slug | Priority | Title | Use Case | Status |');
      lines.push('|---|---|---|---|---|');
      for (const fr of frs) {
        const ucRef = fr.use_case_slug || (fr.use_case_id ? fr.use_case_id.slice(0, 8) : '—');
        lines.push(`| ${fr.slug || ''} | ${fr.priority || ''} | ${mdCell(fr.title)} | ${ucRef} | ${fr.status || ''} |`);
      }
      lines.push('');
      // Detail blocks for FRs that have acceptance criteria or rich prose
      for (const fr of frs) {
        const ac = Array.isArray(fr.acceptance_criteria) ? fr.acceptance_criteria : [];
        if (!fr.description && !ac.length && !(fr.actors || []).length && !fr.preconditions && !fr.postconditions) continue;
        lines.push(`#### ${fr.slug || 'FR'}: ${mdCell(fr.title)}`); lines.push('');
        if (fr.description) { lines.push(fr.description); lines.push(''); }
        if (fr.actors && fr.actors.length) lines.push(`**Actors:** ${fr.actors.join(', ')}`);
        if (fr.preconditions)  lines.push(`**Preconditions:** ${fr.preconditions}`);
        if (fr.postconditions) lines.push(`**Postconditions:** ${fr.postconditions}`);
        if (ac.length) {
          lines.push('**Acceptance Criteria:**');
          ac.forEach(c => lines.push(`- ${typeof c === 'string' ? c : (c.criterion || c.text || JSON.stringify(c))}`));
        }
        lines.push('');
      }
    }
    if (nfrs.length) {
      lines.push('### Non-Functional Requirements'); lines.push('');
      lines.push('| Slug | Category | Priority | Title | Measurable Target | Status |');
      lines.push('|---|---|---|---|---|---|');
      for (const nfr of nfrs) {
        lines.push(`| ${nfr.slug || ''} | ${mdCell(nfr.category)} | ${nfr.priority || ''} | ${mdCell(nfr.title)} | ${mdCell(nfr.measurable_target)} | ${nfr.status || ''} |`);
      }
      lines.push('');
    }
  }

  // ── 1. Application Overview ─────────────────────────────────────────────────
  if (sections.includes('use_cases') && data.use_cases) {
    lines.push('---'); lines.push('');
    lines.push('## 1. Application Overview'); lines.push('');
    if (!data.use_cases.length) {
      lines.push('*No use cases defined.*'); lines.push('');
    } else {
      for (const uc of data.use_cases) {
        const ucHead = [uc.title || '(untitled)', uc.slug].filter(Boolean).join(' — ');
        lines.push(`### Use Case: ${ucHead}`); lines.push('');
        if (uc.owner)                  lines.push(`**Business Owner:** ${uc.owner}`);
        if (uc.risk_tier)              lines.push(`**Risk Tier:** ${uc.risk_tier}`);
        if (uc.business_objective)     lines.push(`**Objective:** ${uc.business_objective}`);
        if (uc.summary)                lines.push(`**Summary:** ${uc.summary}`);
        if (uc.expected_value)         lines.push(`**Expected Value:** ${uc.expected_value}`);
        if (uc.primary_success_metric) lines.push(`**Primary Success Metric:** ${uc.primary_success_metric}`);
        if (uc.readiness)              lines.push(`**Readiness:** ${uc.readiness}`);
        if (uc.supervision_model)      lines.push(`**Supervision Model:** ${uc.supervision_model}`);
        if (uc.trigger_event)          lines.push(`**Trigger Event:** ${uc.trigger_event}`);
        if (uc.sla_target)             lines.push(`**SLA Target:** ${uc.sla_target}`);
        lines.push('');
        if (uc.success_criteria.length) {
          lines.push('#### Success Criteria');
          uc.success_criteria.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
          lines.push('');
        }
        if (uc.constraints_list.length) {
          lines.push('#### Constraints');
          uc.constraints_list.forEach(c => lines.push(`- ${c}`));
          lines.push('');
        }
        if (uc.volume_assumptions && (Array.isArray(uc.volume_assumptions) ? uc.volume_assumptions.length : Object.keys(uc.volume_assumptions).length)) {
          lines.push('#### Volume Assumptions');
          if (Array.isArray(uc.volume_assumptions)) {
            uc.volume_assumptions.forEach(v => lines.push(`- ${v}`));
          } else {
            Object.entries(uc.volume_assumptions).forEach(([k, v]) => lines.push(`- **${k}:** ${v}`));
          }
          lines.push('');
        }
        // Projected cost (Phase 4)
        if (uc.projected_cost_per_period > 0 || uc.baseline_cost_annual_usd > 0) {
          lines.push('#### Projected Cost');
          if (uc.projected_cost_per_period > 0)
            lines.push(`- **Projected:** ${fmtCost(uc.projected_cost_per_period)}/period`);
          if (uc.baseline_cost_annual_usd > 0)
            lines.push(`- **Baseline (status quo):** ${fmtCost(uc.baseline_cost_annual_usd)}/yr`);
          if (uc.roi_ratio)
            lines.push(`- **Estimated ROI:** ${uc.roi_ratio}x`);
          lines.push('');
        }
        lines.push(`*Linked: ${uc.workflow_count} workflow(s), ${uc.agent_count} agent(s)*`); lines.push('');
      }
    }
  }

  // ── 2. Workflows ─────────────────────────────────────────────────────────────
  if (sections.includes('workflows') && data.workflows) {
    lines.push('---'); lines.push('');
    lines.push('## 2. Workflows'); lines.push('');
    if (!data.workflows.length) {
      lines.push('*No workflows defined.*'); lines.push('');
    } else {
      for (const wf of data.workflows) {
        const wfHead = [wf.name || '(untitled)', wf.slug].filter(Boolean).join(' — ');
        lines.push(`### Workflow: ${wfHead}`); lines.push('');
        if (wf.lifecycle_status)    lines.push(`**Status:** ${wf.lifecycle_status}`);
        if (wf.risk_tier)           lines.push(`**Risk Tier:** ${wf.risk_tier}`);
        if (wf.sla_hours != null)   lines.push(`**SLA:** ${wf.sla_hours}h`);
        if (wf.readiness)           lines.push(`**Readiness:** ${wf.readiness}`);
        if (wf.runs_per_period != null) lines.push(`**Volume:** ${wf.runs_per_period} runs/period`);
        lines.push('');

        // Trigger configuration
        const trig = wf.trigger || {};
        const trigKeys = Object.keys(trig);
        if (trigKeys.length) {
          lines.push('#### ServiceNow Trigger Configuration');
          lines.push('');
          lines.push('| Field | Value |');
          lines.push('|---|---|');
          for (const k of trigKeys) lines.push(`| ${k} | \`${mdCell(trig[k])}\` |`);
          lines.push('');
        } else if (typeof wf.trigger === 'string' && wf.trigger) {
          lines.push(`**Trigger:** ${wf.trigger}`); lines.push('');
        }

        // Steps table — enhanced with Phase 1 + Phase 2 fields
        if (wf.steps && wf.steps.length) {
          lines.push('#### Steps'); lines.push('');
          lines.push('| # | Slug | Type | Step | Owner | SLA (h) | Purpose | Decision Points |');
          lines.push('|---|---|---|---|---|---|---|---|');
          for (const s of wf.steps) {
            const dec = Array.isArray(s.decisions) ? s.decisions.join('; ') : (s.decisions || '');
            lines.push(`| ${s.step_number || ''} | ${s.slug || ''} | ${s.step_type || ''} | ${mdCell(s.name)} | ${mdCell(s.owner_participant_name)} | ${s.sla_hours != null ? s.sla_hours : ''} | ${mdCell(s.step_purpose)} | ${mdCell(dec)} |`);
          }
          lines.push('');
          // Per-step preconditions / evidence captured (Phase 1 — show only if any step has them)
          const stepsWithMeta = wf.steps.filter(s => s.preconditions || s.evidence_captured);
          if (stepsWithMeta.length) {
            lines.push('##### Step Detail (Preconditions & Evidence)');
            lines.push('');
            lines.push('| # | Slug | Preconditions | Evidence Captured |');
            lines.push('|---|---|---|---|');
            for (const s of stepsWithMeta) {
              lines.push(`| ${s.step_number || ''} | ${s.slug || ''} | ${mdCell(s.preconditions)} | ${mdCell(s.evidence_captured)} |`);
            }
            lines.push('');
          }
        }

        // HITL Gates
        if (wf.hitl_gates && wf.hitl_gates.length) {
          lines.push('#### HITL Gates'); lines.push('');
          lines.push('| Role | Gate Type | SLA | Criteria |');
          lines.push('|---|---|---|---|');
          for (const h of wf.hitl_gates) {
            lines.push(`| ${mdCell(h.owner_role)} | ${mdCell(h.gate_type)} | ${mdCell(h.sla)} | ${mdCell(h.criteria)} |`);
          }
          lines.push('');
        }

        // Phase 2: Participant Register
        if (wf.participants && wf.participants.length) {
          lines.push('#### Participant Register'); lines.push('');
          lines.push('| Slug | Name | Type | Authority | Handoff Method | Purpose |');
          lines.push('|---|---|---|---|---|---|');
          for (const p of wf.participants) {
            lines.push(`| ${p.slug || ''} | ${mdCell(p.swimlane_display_name || p.human_role_name)} | ${mdCell(p.participant_type)} | ${mdCell(p.authority_level)} | ${mdCell(p.handoff_method)} | ${mdCell(p.purpose_in_workflow)} |`);
          }
          lines.push('');
        }

        // Phase 2: Routing / Paths
        if (wf.paths && wf.paths.length) {
          lines.push('#### Routing / Paths'); lines.push('');
          lines.push('| Slug | From Step | Condition | Label | To Step | Default |');
          lines.push('|---|---|---|---|---|---|');
          for (const p of wf.paths) {
            const from = p.from_step_name ? `S-${String(p.from_step_num || '').padStart(3,'0')}: ${p.from_step_name}` : (p.from_step_id || '—');
            const to   = p.to_step_name || p.to_step_id || 'END';
            lines.push(`| ${p.slug || ''} | ${mdCell(from)} | ${mdCell(p.branch_condition)} | ${mdCell(p.branch_label)} | ${mdCell(to)} | ${p.is_default_path ? '✓' : ''} |`);
          }
          lines.push('');
        }

        // Phase 2: RASIC Matrix
        if (wf.rasic_rows && wf.rasic_rows.length) {
          // Build cross-tab: rows=steps, cols=participants (include_in_rasic)
          const rasicParticipants = [];
          const rasicPartSeen = new Set();
          for (const r of wf.rasic_rows) {
            if (r.include_in_rasic !== 0 && !rasicPartSeen.has(r.workflow_participant_id)) {
              rasicPartSeen.add(r.workflow_participant_id);
              rasicParticipants.push({ id: r.workflow_participant_id, name: r.participant_name, order: r.rasic_column_order });
            }
          }
          rasicParticipants.sort((a, b) => (a.order || 0) - (b.order || 0));
          if (rasicParticipants.length) {
            // Build lookup: stepId+participantId → concatenated codes
            const rasicMap = {};
            for (const r of wf.rasic_rows) {
              const key = `${r.workflow_step_id}|${r.workflow_participant_id}`;
              rasicMap[key] = (rasicMap[key] || '') + r.code;
            }
            // Collect unique steps in order
            const rasicSteps = [];
            const rasicStepSeen = new Set();
            for (const r of wf.rasic_rows) {
              if (!rasicStepSeen.has(r.workflow_step_id)) {
                rasicStepSeen.add(r.workflow_step_id);
                rasicSteps.push({ id: r.workflow_step_id, name: r.step_name, num: r.step_number });
              }
            }
            rasicSteps.sort((a, b) => (a.num || 0) - (b.num || 0));
            lines.push('#### RASIC Matrix'); lines.push('');
            const header = ['| Step', ...rasicParticipants.map(p => mdCell(p.name)), '|'].join(' | ');
            const sep    = ['|---',   ...rasicParticipants.map(() => '---'),          '|'].join('|');
            lines.push(header);
            lines.push(sep);
            for (const st of rasicSteps) {
              const stepLabel = `${st.num ? `S-${String(st.num).padStart(3,'0')}: ` : ''}${st.name || ''}`;
              const cells = rasicParticipants.map(p => rasicMap[`${st.id}|${p.id}`] || '');
              lines.push(`| ${mdCell(stepLabel)} | ${cells.join(' | ')} |`);
            }
            lines.push('');
          }
        }

        // Handoffs (legacy JSON field — keep for backward compatibility)
        if (wf.handoffs && wf.handoffs.length) {
          lines.push('#### Handoffs');
          wf.handoffs.forEach(h => lines.push(`- ${typeof h === 'string' ? h : JSON.stringify(h)}`));
          lines.push('');
        }
      }
    }
  }

  // ── 3. Agent Specifications ───────────────────────────────────────────────────
  if (sections.includes('agents') && data.agents) {
    lines.push('---'); lines.push('');
    lines.push('## 3. Agent Specifications'); lines.push('');
    if (!data.agents.length) {
      lines.push('*No agents defined.*'); lines.push('');
    } else {
      for (const agent of data.agents) {
        const agHead = [agent.name || '(untitled)', agent.slug].filter(Boolean).join(' — ');
        lines.push(`### Agent: ${agHead}`); lines.push('');
        const model = agent.run_as_model?.model || agent.run_as_model?.name || '';
        if (model)                           lines.push(`**Model:** ${model}`);
        if (agent.supervision_model)         lines.push(`**Supervision Model:** ${agent.supervision_model}`);
        if (agent.orchestration_strategy)    lines.push(`**Orchestration Strategy:** ${agent.orchestration_strategy}`);
        if (agent.scope)                     lines.push(`**Scope:** ${agent.scope}`);
        if (agent.lifecycle_status)          lines.push(`**Status:** ${agent.lifecycle_status}`);
        if (agent.memory_strategy)           lines.push(`**Memory Strategy:** ${agent.memory_strategy}`);
        if (agent.maintenance_owner)         lines.push(`**Maintenance Owner:** ${agent.maintenance_owner}`);
        if (agent.latency_target)            lines.push(`**Latency Target:** ${agent.latency_target}`);
        lines.push('');

        if (agent.instructions) {
          lines.push('**Instructions:**'); lines.push('');
          lines.push(agent.instructions); lines.push('');
        }
        if (agent.goals.length) {
          lines.push('**Goals:**');
          agent.goals.forEach(g => lines.push(`- ${g}`));
          lines.push('');
        }
        if (agent.done_criteria.length) {
          lines.push('**Done Criteria:**');
          agent.done_criteria.forEach(d => lines.push(`- ${d}`));
          lines.push('');
        }
        if (agent.inputs && Object.keys(agent.inputs).length) {
          lines.push('**Input Schema:**'); lines.push('');
          lines.push('```json'); lines.push(JSON.stringify(agent.inputs, null, 2)); lines.push('```'); lines.push('');
        }
        if (agent.outputs && Object.keys(agent.outputs).length) {
          lines.push('**Output Schema:**'); lines.push('');
          lines.push('```json'); lines.push(JSON.stringify(agent.outputs, null, 2)); lines.push('```'); lines.push('');
        }

        // Phase 3: Use Cases Served (M:N)
        if (agent.use_cases && agent.use_cases.length) {
          lines.push('#### Use Cases Served'); lines.push('');
          lines.push('| UC | Title | Business Value |');
          lines.push('|---|---|---|');
          for (const uc of agent.use_cases) {
            lines.push(`| ${uc.slug || '—'} | ${mdCell(uc.title)} | ${mdCell(uc.business_value)} |`);
          }
          lines.push('');
        }

        // Phase 3: Tool Bindings (M:N)
        if (agent.tool_bindings && agent.tool_bindings.length) {
          lines.push('#### Tool Bindings'); lines.push('');
          lines.push('| Tool | Slug | Dev Status | Purpose | Execution Mode | Supervision | Fallback |');
          lines.push('|---|---|---|---|---|---|---|');
          for (const tb of agent.tool_bindings) {
            const devBadge = tb.dev_status === 'To be built' ? '🔨 To be built' : (tb.dev_status ? '✅ Existing' : '');
            lines.push(`| ${mdCell(tb.tool_name)} | ${tb.tool_slug || ''} | ${devBadge} | ${mdCell(tb.purpose)} | ${mdCell(tb.tool_execution_mode)} | ${mdCell(tb.binding_supervision_model)} | ${mdCell(tb.fallback_behavior)} |`);
          }
          lines.push('');
        }

        if (agent.design_risks.length) {
          lines.push('**Design Risks:**');
          agent.design_risks.forEach(r => lines.push(`- ${typeof r === 'string' ? r : JSON.stringify(r)}`));
          lines.push('');
        }

        // Phase 1: Post-release validation notes
        if (agent.post_release_validation) {
          lines.push('**Post-Release Validation:**'); lines.push('');
          lines.push('```');
          lines.push(agent.post_release_validation);
          lines.push('```');
          lines.push('');
        }
      }
    }
  }

  // ── 4. Tools & Integrations ───────────────────────────────────────────────────
  if (sections.includes('tools') && data.tools) {
    lines.push('---'); lines.push('');
    lines.push('## 4. Tools & Integrations'); lines.push('');
    if (!data.tools.length) {
      lines.push('*No tools defined.*'); lines.push('');
    } else {
      for (const t of data.tools) {
        const toolHead = [t.name || '(untitled)', t.slug].filter(Boolean).join(' — ');
        lines.push(`### \`${toolHead}\``); lines.push('');
        const mode = (t.execution_mode || '').toLowerCase();
        let snArtifact = '';
        if (mode.includes('rest') || mode.includes('http'))            snArtifact = 'REST Message (System Web Services › Outbound › REST Message)';
        else if (mode.includes('integration') || mode.includes('hub')) snArtifact = 'IntegrationHub Action (Flow Designer › Action Designer)';
        else if (mode.includes('flow') || mode.includes('subflow'))    snArtifact = 'Subflow (Flow Designer)';
        else if (mode.includes('script') || mode.includes('sync'))     snArtifact = 'Script Include';
        else if (t.execution_mode)                                     snArtifact = t.execution_mode;
        if (snArtifact) lines.push(`> **ServiceNow Artifact to create:** ${snArtifact}`);
        lines.push('');
        if (t.dev_status)           lines.push(`**Dev Status:** ${t.dev_status === 'To be built' ? '🔨 To be built' : '✅ Existing'}`);
        if (t.contract)             lines.push(`**Contract:** ${t.contract}`);
        if (t.execution_mode)       lines.push(`**Execution Mode:** ${t.execution_mode}`);
        if (t.cost_impact)          lines.push(`**Cost Impact:** ${t.cost_impact}`);
        if (t.access_requirements)  lines.push(`**Access Requirements:** ${t.access_requirements}`);
        lines.push('');
        if (t.inputs && Object.keys(t.inputs).length) {
          lines.push('**Input Parameters:**'); lines.push('');
          lines.push('```json'); lines.push(JSON.stringify(t.inputs, null, 2)); lines.push('```'); lines.push('');
        }
        if (t.outputs && Object.keys(t.outputs).length) {
          lines.push('**Output Fields:**'); lines.push('');
          lines.push('```json'); lines.push(JSON.stringify(t.outputs, null, 2)); lines.push('```'); lines.push('');
        }
        if (t.boundaries.length) {
          lines.push('**Boundaries:**');
          t.boundaries.forEach(b => lines.push(`- ${typeof b === 'string' ? b : JSON.stringify(b)}`));
          lines.push('');
        }
        if (t.errors.length) {
          lines.push('**Error Conditions:**');
          t.errors.forEach(e => lines.push(`- ${typeof e === 'string' ? e : JSON.stringify(e)}`));
          lines.push('');
        }
      }
    }
  }

  // ── ServiceNow round-trip: Level-1 design sections ──────────────────────────
  // These INCLUDE Level-2 provenance (source_sys_id / source_table / Fluent): the
  // Build Spec is the technical handoff to Claude Code + the SN SDK and needs the
  // identity + construct to regenerate and redeploy safely.
  const rtFluentDetails = (rec) => {
    if (!rec.source_fluent) return;
    lines.push('<details><summary>Fluent (Level-2 construct)</summary>'); lines.push('');
    lines.push('```typescript'); lines.push(rec.source_fluent); lines.push('```');
    lines.push('</details>'); lines.push('');
  };
  if (sections.includes('data_models') && data.data_models) {
    lines.push('---'); lines.push('');
    lines.push('## ServiceNow Data Model'); lines.push('');
    if (!data.data_models.length) { lines.push('*No data models.*'); lines.push(''); }
    for (const dm of data.data_models) {
      lines.push(`### \`${[dm.name, dm.slug].filter(Boolean).join(' — ')}\``); lines.push('');
      if (dm.source_sys_id) lines.push(`> **Source:** ${dm.source_table || 'sys_db_object'} \`${dm.source_sys_id}\`${dm.source_scope ? ` (scope ${dm.source_scope})` : ''}`);
      if (dm.physical_name) lines.push(`**ServiceNow Table:** \`${dm.physical_name}\``);
      if (dm.extends_table) lines.push(`**Extends:** \`${dm.extends_table}\``);
      if (dm.purpose) lines.push(`**Purpose:** ${dm.purpose}`);
      lines.push('');
      const fields = Array.isArray(dm.fields) ? dm.fields : [];
      if (fields.length) {
        lines.push('| Field | Type | Required | Meaning |'); lines.push('|---|---|---|---|');
        fields.forEach(f => lines.push(`| ${f.label || ''} | ${f.type_business || ''} | ${f.mandatory ? 'Yes' : 'No'} | ${(f.meaning || '').replace(/\|/g, '\\|')} |`));
        lines.push('');
      }
      rtFluentDetails(dm);
    }
  }
  if (sections.includes('form_designs') && data.form_designs) {
    lines.push('---'); lines.push('');
    lines.push('## ServiceNow Form Designs'); lines.push('');
    if (!data.form_designs.length) { lines.push('*No form designs.*'); lines.push(''); }
    for (const fd of data.form_designs) {
      lines.push(`### \`${[fd.name, fd.slug].filter(Boolean).join(' — ')}\``); lines.push('');
      if (fd.source_sys_id) lines.push(`> **Source:** ${fd.source_table || 'sys_ui_form'} \`${fd.source_sys_id}\``);
      if (fd.view_name) lines.push(`**View:** ${fd.view_name}`);
      if (fd.behavior_notes) lines.push(`**Behavior:** ${fd.behavior_notes}`);
      lines.push('');
      const secs = Array.isArray(fd.sections) ? fd.sections : [];
      secs.forEach(s => lines.push(`- **${s.section_label || 'Section'}**${s.columns != null ? ` (${s.columns} col)` : ''}: ${Array.isArray(s.fields) ? s.fields.join(', ') : ''}`));
      if (secs.length) lines.push('');
      rtFluentDetails(fd);
    }
  }
  if (sections.includes('business_logic') && data.business_logic) {
    lines.push('---'); lines.push('');
    lines.push('## Implementation Artifacts (Tier C)'); lines.push('');
    lines.push('> **These are implementation artifacts** — Business Rules, Script Includes, Client Scripts, UI Actions, and UI Policies captured for round-trip drift detection. **Do not regenerate or redeploy these from this spec.** Edit them directly in ServiceNow Studio or via Update Set. They are included here so Claude Code can detect drift (name collisions, changed scripts) before deploying Tier A design elements.');
    lines.push('');
    if (!data.business_logic.length) { lines.push('*No implementation artifacts captured.*'); lines.push(''); }
    for (const bl of data.business_logic) {
      lines.push(`### \`${[bl.name, bl.slug].filter(Boolean).join(' — ')}\` (${bl.logic_type || ''})`); lines.push('');
      if (bl.source_sys_id) lines.push(`> **Source:** ${bl.source_table || ''} \`${bl.source_sys_id}\``);
      if (bl.plain_english) lines.push(`**What it does:** ${bl.plain_english}`);
      if (bl.when_runs) lines.push(`**When:** ${bl.when_runs}`);
      if (bl.conditions) lines.push(`**Conditions:** ${bl.conditions}`);
      if (bl.run_order != null) lines.push(`**Order:** ${bl.run_order}`);
      const blRefs = Array.isArray(bl.requirement_refs) ? bl.requirement_refs
        : (() => { try { return JSON.parse(bl.requirement_refs || '[]'); } catch { return []; } })();
      if (blRefs.length) lines.push(`**Implements:** ${blRefs.join(', ')}`);
      lines.push('');
      rtFluentDetails(bl);
    }
  }
  if (sections.includes('integrations') && data.integrations) {
    lines.push('---'); lines.push('');
    lines.push('## ServiceNow Integrations'); lines.push('');
    if (!data.integrations.length) { lines.push('*No integrations.*'); lines.push(''); }
    for (const intg of data.integrations) {
      lines.push(`### \`${[intg.name, intg.slug].filter(Boolean).join(' — ')}\``); lines.push('');
      const srcTable = intg.source_table || (intg.integration_type === 'rest_message' ? 'sys_rest_message' : 'sys_alias');
      if (intg.source_sys_id) lines.push(`> **Source:** ${srcTable} \`${intg.source_sys_id}\``);
      if (intg.description) lines.push(`**Description:** ${intg.description}`);
      if (intg.integration_type === 'rest_message') {
        if (intg.endpoint) lines.push(`**Endpoint:** ${intg.endpoint}`);
        if (intg.auth_type) lines.push(`**Authentication:** ${intg.auth_type}`);
        const fns = Array.isArray(intg.functions) ? intg.functions : [];
        if (fns.length) {
          lines.push(''); lines.push('| Method | Name | Endpoint |'); lines.push('|---|---|---|');
          fns.forEach(fn => lines.push(`| \`${fn.http_method || ''}\` | ${fn.name || ''} | ${fn.endpoint || '*(base)*'} |`));
        }
      } else {
        if (intg.alias_type)      lines.push(`**Alias Type:** ${intg.alias_type}`);
        if (intg.connection_type) lines.push(`**Connection Type:** ${intg.connection_type}`);
      }
      if (intg.notes) lines.push(`**Notes:** ${intg.notes}`);
      lines.push('');
      rtFluentDetails(intg);
    }
  }
  if (sections.includes('catalog_items') && data.catalog_items) {
    lines.push('---'); lines.push('');
    lines.push('## ServiceNow Catalog Items'); lines.push('');
    if (!data.catalog_items.length) { lines.push('*No catalog items.*'); lines.push(''); }
    for (const ci of data.catalog_items) {
      lines.push(`### \`${[ci.name, ci.slug].filter(Boolean).join(' — ')}\``); lines.push('');
      if (ci.source_sys_id) lines.push(`> **Source:** ${ci.source_table || 'sc_cat_item'} \`${ci.source_sys_id}\``);
      if (ci.short_description) lines.push(`**Description:** ${ci.short_description}`);
      if (ci.category) lines.push(`**Category:** ${ci.category}`);
      if (ci.who_can_order) lines.push(`**Who can order:** ${ci.who_can_order}`);
      lines.push('');
      const vars = Array.isArray(ci.variables) ? ci.variables : [];
      if (vars.length) {
        lines.push('| Variable | Type | Required |'); lines.push('|---|---|---|');
        vars.forEach(v => lines.push(`| ${v.label || ''} | ${v.type_business || ''} | ${v.mandatory ? 'Yes' : 'No'} |`));
        lines.push('');
      }
      rtFluentDetails(ci);
    }
  }

  // ── Config-driven Tier-A entities (Information Layer + NL rules) ─────────────
  // ONE generic renderer driven by each registry display block. Existing bespoke
  // sections above are skipped (BESPOKE set) so they render exactly as before.
  {
    const BESPOKE = new Set(['data_models','form_designs','business_logic','catalog_items','integrations']);
    for (const e of registry.entitiesWithDisplay()) {
      const k = e.display.data_key;
      if (BESPOKE.has(k) || !sections.includes(k) || data[k] === undefined) continue;
      const colOf = (key) => (e.fieldMap[key] && e.fieldMap[key].col) || key;
      const childCfg = e.display.children || null;   // nested collection → rendered as a sub-table
      lines.push('---'); lines.push('');
      lines.push(`## ${e.display.label}s`); lines.push('');
      if (!data[k].length) { lines.push(`*No ${e.display.label.toLowerCase()}s.*`); lines.push(''); continue; }
      for (const rec of data[k]) {
        lines.push(`### \`${[rec.name, rec.slug].filter(Boolean).join(' — ')}\``); lines.push('');
        if (rec.source_sys_id) lines.push(`> **Source:** ${e.display.source_table || rec.source_table || ''} \`${rec.source_sys_id}\``);
        for (const f of e.display.fields) {
          if (f.key === 'name') continue;
          if (childCfg && f.key === childCfg.key) continue;   // children rendered as a table below
          let v = rec[colOf(f.key)];
          if (v == null || v === '') continue;
          if (Array.isArray(v)) v = v.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ');
          const label = f.label.replace(/ \(one per line\)$/, '');
          lines.push(`**${label}:** ${mdCell(v)}`);
        }
        lines.push('');
        // Nested child collection as a markdown table.
        if (childCfg) {
          const rows = Array.isArray(rec[colOf(childCfg.key)]) ? rec[colOf(childCfg.key)] : [];
          lines.push(`#### ${childCfg.label} (${rows.length})`); lines.push('');
          if (rows.length) {
            lines.push('| ' + childCfg.columns.map(c => c.label).join(' | ') + ' |');
            lines.push('|' + childCfg.columns.map(() => '---').join('|') + '|');
            for (const r of rows) lines.push('| ' + childCfg.columns.map(c => mdCell(r[c.key])).join(' | ') + ' |');
          } else {
            lines.push(`*No ${childCfg.label.toLowerCase()} recorded.*`);
          }
          lines.push('');
        }
        rtFluentDetails(rec);
      }
    }
  }

  // ── ServiceNow Generic Artifacts (Phase 1-3 substrate) ─────────────────────
  if (sections.includes('sn_generic_artifacts') && data.sn_generic_artifacts !== undefined) {
    lines.push('---'); lines.push('');
    lines.push('## ServiceNow Generic Artifacts'); lines.push('');

    const arts = data.sn_generic_artifacts || [];

    if (!arts.length) {
      lines.push('*No generic artifacts found for this project. Run the ServiceNow Sync → Capture, or run `node backfill-sn-artifacts.js` from the `backend-node/` directory to create generic twins for existing Level-1 SN entities.*');
      lines.push('');
      lines.push('> **Tip:** If this project has Data Models, Form Designs, or other Level-1 SN entities already synced,');
      lines.push('> run `node backfill-sn-artifacts.js` to populate the generic substrate without disturbing any existing Level-1 views.');
      lines.push('');
    } else {
      // Registry capability status
      const reg = data.sn_type_registry_summary;
      if (reg) {
        lines.push('### Registry Capability Status'); lines.push('');
        if (reg.sdk_version) {
          lines.push(`> **SDK version at last type-registry scan:** \`${reg.sdk_version}\``);
          lines.push('');
        }
        const tierMap = {}; for (const r of (reg.by_tier || [])) tierMap[r.tier] = r.cnt;
        const stratMap = {}; for (const r of (reg.by_strategy || [])) stratMap[r.deploy_strategy] = r.cnt;
        const totalReg = Object.values(tierMap).reduce((s, n) => s + n, 0);
        if (totalReg) {
          lines.push('| Tier | Types in Registry | Description |');
          lines.push('|---|---|---|');
          lines.push(`| A | ${tierMap['A'] || 0} | SN types that have a clean L1 projection AND a generic twin |`);
          lines.push(`| B | ${tierMap['B'] || 0} | SN types with curated field schema; not yet L1-projected |`);
          lines.push(`| C | ${tierMap['C'] || 0} | Generic long-tail — deployed via \`Record()\` fallback |`);
          lines.push('');
          lines.push('| Deploy Strategy | Registry Count |');
          lines.push('|---|---|');
          lines.push(`| typed (dedicated Fluent constructor) | ${stratMap['typed'] || 0} |`);
          lines.push(`| record (generic \`Record()\`) | ${stratMap['record'] || 0} |`);
          lines.push(`| override (\`Record()\` + custom x\\_/u\\_ fields) | ${stratMap['override'] || 0} |`);
          lines.push('');
        }
      }

      // Project-level artifact summary
      lines.push('### Artifact Summary'); lines.push('');
      const artsByTier = { A: 0, B: 0, C: 0 };
      const artsByStrategy = {};
      for (const art of arts) {
        artsByTier[art.tier || 'C'] = (artsByTier[art.tier || 'C'] || 0) + 1;
        const s = art.deploy_strategy || 'record';
        artsByStrategy[s] = (artsByStrategy[s] || 0) + 1;
      }
      lines.push('| Tier | Count | Description |');
      lines.push('|---|---|---|');
      lines.push(`| A | ${artsByTier['A']} | Projected onto a Level-1 row AND has a generic twin |`);
      lines.push(`| B | ${artsByTier['B']} | Curated field schema; not yet L1-projected |`);
      lines.push(`| C | ${artsByTier['C']} | Generic long-tail (ACLs, roles, SLAs, properties, widgets, flow actions) |`);
      lines.push(`| **Total** | **${arts.length}** | |`);
      lines.push('');
      lines.push('| Deploy Strategy | Count |');
      lines.push('|---|---|');
      lines.push(`| typed | ${artsByStrategy['typed'] || 0} |`);
      lines.push(`| record | ${artsByStrategy['record'] || 0} |`);
      lines.push(`| override | ${artsByStrategy['override'] || 0} |`);
      lines.push('');

      lines.push(`> **Deployment:** Generic artifacts are deployed via \`now-sdk\` using the Fluent \`Record()\` constructor (or a typed constructor when available). The **SN Delta Export** contains auto-generated Fluent code blocks for all artifacts in approved Change Packets and is the deployable artifact.`);
      lines.push(`> Delta Export endpoint: \`GET /api/v1/projects/${project.project_id}/servicenow/delta-export\``);
      lines.push('');

      // Artifacts grouped by sn_metadata_type
      lines.push('### Artifacts by Type'); lines.push('');
      const byType = {};
      for (const art of arts) {
        const t = art.sn_metadata_type || 'unknown';
        (byType[t] = byType[t] || []).push(art);
      }

      for (const [metaType, typeArts] of Object.entries(byType).sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`#### \`${metaType}\` (${typeArts.length})`); lines.push('');

        for (const art of typeArts) {
          const artHead = [art.name, art.slug].filter(Boolean).join(' — ');
          const isUpdate = !!art.source_sys_id;

          lines.push(`##### ${mdCell(artHead)}`); lines.push('');
          lines.push('| Field | Value |');
          lines.push('|---|---|');
          lines.push(`| Slug | \`${art.slug || '—'}\` |`);
          lines.push(`| Tier | ${art.tier || '—'} |`);
          lines.push(`| Deploy Strategy | \`${art.deploy_strategy || 'record'}\` |`);
          if (art.fluent_api_name) lines.push(`| Fluent Constructor | \`${art.fluent_api_name}\` |`);
          lines.push(`| Round-Trip Status | ${isUpdate ? `PATCH — existing SN record (\`${art.source_sys_id}\`)` : 'POST — not yet deployed to SN'} |`);
          if (art.source_table) lines.push(`| SN Table | \`${art.source_table}\` |`);
          if (art.source_scope) lines.push(`| SN Scope | \`${art.source_scope}\` |`);
          lines.push('');

          // Tier-A cross-reference
          if (art.tier === 'A' && art.projected_entity_type && art.projected_entity_id) {
            lines.push(`> **Tier-A twin:** Projects onto Level-1 entity \`${art.projected_entity_type}\` / \`${art.projected_entity_id}\`. Deploy the L1 row and this generic twin together — the L1 row carries human-readable design intent; this twin carries the Fluent construct and round-trip identity.`);
            lines.push('');
          }

          // Fluent construct
          if (art.source_fluent) {
            lines.push('<details><summary>Fluent construct (captured from live SDK)</summary>');
            lines.push(''); lines.push('```typescript');
            lines.push(art.source_fluent);
            lines.push('```'); lines.push('</details>'); lines.push('');
          } else {
            const payloadKeys = Object.keys(art.payload || {});
            const overrideKeys = Object.keys(art.override_fields || {});
            if (payloadKeys.length || overrideKeys.length) {
              const fluentKey = (art.slug || `${art.sn_metadata_type || 'art'}_${(art.sn_artifact_id || '').slice(0, 8)}`).replace(/[^A-Za-z0-9_-]/g, '-');
              const dataObj = { ...art.payload, ...art.override_fields };
              lines.push('<details><summary>Fluent construct (auto-generated Record())</summary>');
              lines.push(''); lines.push('```typescript');
              lines.push(`import { Record } from '@servicenow/sdk/core'`);
              lines.push('');
              lines.push('Record({');
              lines.push(`  $id: Now.ID['${fluentKey}'],`);
              lines.push(`  table: '${art.source_table || '(unknown)'}',`);
              const dataStr = JSON.stringify(dataObj, null, 2).replace(/\n/g, '\n  ');
              lines.push(`  data: ${dataStr},`);
              lines.push('})');
              lines.push('```'); lines.push('</details>'); lines.push('');
            }
          }

          // Round-trip provenance
          if (art.source_sys_id || art.source_hash) {
            lines.push('<details><summary>Round-trip provenance</summary>'); lines.push('');
            if (art.source_sys_id) lines.push(`- **source_sys_id:** \`${art.source_sys_id}\``);
            if (art.source_table)  lines.push(`- **source_table:** \`${art.source_table}\``);
            if (art.source_scope)  lines.push(`- **source_scope:** \`${art.source_scope}\``);
            if (art.source_hash)   lines.push(`- **source_hash:** \`${art.source_hash}\` *(drift detection — changes trigger re-sync)*`);
            if (art.sdk_version)   lines.push(`- **sdk_version:** \`${art.sdk_version}\``);
            lines.push('</details>'); lines.push('');
          }

          // Children
          if (art.children && art.children.length) {
            lines.push(`**Child artifacts** (${art.children.length}):`); lines.push('');
            lines.push('| Role | Name | Strategy | SN sys_id |');
            lines.push('|---|---|---|---|');
            for (const ch of art.children) {
              const chSysId = ch.source_sys_id ? `\`${ch.source_sys_id}\`` : '*(not yet deployed)*';
              lines.push(`| ${mdCell(ch.child_role || '—')} | ${mdCell(ch.name)} | \`${ch.deploy_strategy || 'record'}\` | ${chSysId} |`);
            }
            lines.push('');

            for (const ch of art.children) {
              const hasFluentData = ch.source_fluent || Object.keys(ch.payload || {}).length;
              if (!hasFluentData) continue;
              const chHead = [ch.name, ch.child_role].filter(Boolean).join(' — ');
              lines.push(`<details><summary>Child: ${mdCell(chHead)}</summary>`);
              lines.push(''); lines.push('```typescript');
              if (ch.source_fluent) {
                lines.push(ch.source_fluent);
              } else {
                const chKey = (ch.slug || `${ch.sn_metadata_type || 'child'}_${(ch.sn_artifact_id || '').slice(0, 8)}`).replace(/[^A-Za-z0-9_-]/g, '-');
                const chData = { ...ch.payload, ...ch.override_fields };
                lines.push(`import { Record } from '@servicenow/sdk/core'`);
                lines.push('Record({');
                lines.push(`  $id: Now.ID['${chKey}'],`);
                lines.push(`  table: '${ch.source_table || art.source_table || '(unknown)'}',`);
                const chDataStr = JSON.stringify(chData, null, 2).replace(/\n/g, '\n  ');
                lines.push(`  data: ${chDataStr},`);
                lines.push('})');
              }
              lines.push('```'); lines.push('</details>'); lines.push('');
            }
          }
        }
      }
    }
  }

  // ── Deployment Guidance ──────────────────────────────────────────────────────
  // Partition this spec's design elements into: SDK-deployable (now-sdk handles
  // these automatically) vs. elements that require an Update Set or manual config.
  // Only types that are actually present in this spec are listed.
  {
    const NON_SDK_TYPES = {
      sys_report:        { label: 'Reports (`sys_report`)',                    how: 'Export Update Set from source instance and apply on target, or create manually via Reports > View/Run.' },
      pa_indicator:      { label: 'PA Indicators / KPIs (`pa_indicator`)',     how: 'Configure manually in Performance Analytics > Indicators.' },
      sys_user_group:    { label: 'User Groups (`sys_user_group`)',            how: 'Create via User Management > Groups, or include in an Update Set from source.' },
      sys_choice:        { label: 'Choice / Picklist Values (`sys_choice`)',   how: 'Add choices in the Dictionary editor for each field, or include in an Update Set.' },
      sc_category:       { label: 'Catalog Categories (`sc_category`)',        how: 'Create in Service Catalog > Catalog Administration; assign items after SDK deploy.' },
      sys_transform_map: { label: 'Transform Maps (`sys_transform_map`)',      how: 'Create via System Import Sets > Transform Maps (with Transform Entries).' },
    };

    // Build list of SDK-deployable elements present in this spec
    const sdkElements = [];
    if (sections.includes('agents') && (data.agents || []).length)           sdkElements.push('**AI Agents** — `AiAgent` Fluent constructor');
    if (sections.includes('workflows') && (data.workflows || []).length)     sdkElements.push('**AI Agentic Workflows** — `AiAgenticWorkflow` Fluent constructor');
    if (sections.includes('tools') && (data.tools || []).length)             sdkElements.push('**Tools** — `Record()` or typed constructor per tool type');
    if (sections.includes('data_models') && (data.data_models || []).length) sdkElements.push('**Data Models / Tables** — `Table` Fluent constructor');
    if (sections.includes('form_designs') && (data.form_designs || []).length)   sdkElements.push('**Form Designs** — `Record()` on `sys_ui_form`');
    if (sections.includes('integrations') && (data.integrations || []).length)   sdkElements.push('**Integrations** — `RestMessage` (outbound), `Alias` (connection aliases)');
    if (sections.includes('catalog_items') && (data.catalog_items || []).length) sdkElements.push('**Catalog Items + Variables** — `CatalogItem` Fluent constructor');
    const arts = data.sn_generic_artifacts || [];
    const artsByStrategy = {};
    for (const a of arts) { const s = a.deploy_strategy || 'record'; artsByStrategy[s] = (artsByStrategy[s] || 0) + 1; }
    if (artsByStrategy['typed'])    sdkElements.push(`**Generic Artifacts (typed)** — ${artsByStrategy['typed']} artifact(s) use dedicated Fluent constructors`);
    if (artsByStrategy['record'] || artsByStrategy['override'])
      sdkElements.push(`**Generic Artifacts (Record())** — ${(artsByStrategy['record']||0) + (artsByStrategy['override']||0)} artifact(s) via \`Record()\` fallback`);

    // Find non-SDK types present in generic artifacts or business logic
    const nonSdkPresent = [];
    const seenNonSdk = new Set();
    for (const a of arts) {
      const t = a.source_table;
      if (t && NON_SDK_TYPES[t] && !seenNonSdk.has(t)) {
        seenNonSdk.add(t); nonSdkPresent.push({ ...NON_SDK_TYPES[t], table: t });
      }
    }

    // Config-driven Tier-A entities: partition by display.sdk_deployable. SDK-deployable
    // → install pass; otherwise → manual/Update Set (keyed by source_table in NON_SDK_TYPES).
    // Entities with no source_table (NL rules) deploy as neither — they drive code, not deploy.
    for (const de of registry.entitiesWithDisplay()) {
      const k = de.display.data_key;
      if (!sections.includes(k) || !(data[k] || []).length) continue;
      const t = de.display.source_table;
      if (de.display.sdk_deployable) {
        sdkElements.push(`**${de.display.label}s** — Fluent constructor${t ? ` (\`${t}\`)` : ''}`);
      } else if (t && NON_SDK_TYPES[t] && !seenNonSdk.has(t)) {
        seenNonSdk.add(t); nonSdkPresent.push({ ...NON_SDK_TYPES[t], table: t });
      }
    }

    const implArtifactCount = (data.business_logic || []).length;
    const hasContent = sdkElements.length || nonSdkPresent.length || implArtifactCount;
    if (hasContent) {
      lines.push('---'); lines.push('');
      lines.push('## Deployment Guidance'); lines.push('');
      lines.push('Deploy order: initialize scope → SDK install (Tier A) → manual/Update Set steps (non-SDK) → validate.');
      lines.push('');
      if (sdkElements.length) {
        lines.push('### Deploy via `npx now-sdk install`');
        lines.push('');
        lines.push('The following design elements in this spec have Fluent API support and deploy in a single SDK install pass:');
        lines.push('');
        for (const e of sdkElements) lines.push(`- ${e}`);
        lines.push('');
      }
      if (nonSdkPresent.length) {
        lines.push('### Requires Update Set or manual configuration');
        lines.push('');
        lines.push('These element types were captured but **cannot be deployed via `now-sdk install`**. Deploy them before or after the SDK pass as noted:');
        lines.push('');
        lines.push('| Type | How to deploy |');
        lines.push('|---|---|');
        for (const e of nonSdkPresent) lines.push(`| ${e.label} | ${e.how} |`);
        lines.push('');
      }
      if (implArtifactCount) {
        lines.push('### Implementation Artifacts — do NOT redeploy');
        lines.push('');
        lines.push(`This spec contains **${implArtifactCount}** implementation artifact(s) (Business Rules, Script Includes, Client Scripts, UI Actions, UI Policies) captured for drift detection. **Do not regenerate these from this spec.** They live in ServiceNow and must be edited there directly. Use them for collision awareness only.`);
        lines.push('');
      }
    }
  }

  // ── AI Guidance & Best Practices ────────────────────────────────────────────
  if (sections.includes('best_practices') && data.best_practices !== undefined) {
    lines.push('---'); lines.push('');
    lines.push('## AI Guidance & Best Practices'); lines.push('');
    lines.push('> **Apply these rules throughout the build.** They represent accumulated platform knowledge and must guide every design decision Claude Code makes.');
    lines.push('');
    const bps = data.best_practices || [];
    if (!bps.length) {
      lines.push('*No best practices configured.*'); lines.push('');
    } else {
      const byScope = {};
      for (const bp of bps) {
        const s = bp.scope || 'global';
        if (!byScope[s]) byScope[s] = [];
        byScope[s].push(bp);
      }
      for (const [scope, scopeBps] of Object.entries(byScope).sort((a, b) => a[0].localeCompare(b[0]))) {
        const heading = scope === 'global'
          ? 'General'
          : scope.charAt(0).toUpperCase() + scope.slice(1).replace(/_/g, ' ');
        lines.push(`### ${heading}`); lines.push('');
        for (const bp of scopeBps) {
          const rule = bp.rule_text ? `: ${bp.rule_text}` : '';
          lines.push(`- **${bp.title}**${rule}`);
        }
        lines.push('');
      }
    }
  }

  // ── 5. Guardrails ─────────────────────────────────────────────────────────────
  if (sections.includes('guardrails') && data.guardrails) {
    lines.push('---'); lines.push('');
    lines.push('## 5. Guardrails'); lines.push('');
    if (!data.guardrails.length) {
      lines.push('*No guardrails defined.*'); lines.push('');
    } else {
      lines.push('| ID | Name | Severity | Action if Triggered | Rule |');
      lines.push('|---|---|---|---|---|');
      for (const g of data.guardrails) {
        const id   = g.slug || g.guardrail_id_ref || g.guardrail_id || '';
        const name = g.rule_name || g.name || g.guardrail_name || '';
        const sev  = mdCell(g.severity);
        const act  = mdCell(g.action_if_triggered || g.enforcement_level || g.enforcement);
        const rule = mdCell(g.rule_text || g.description || g.guardrail_description);
        lines.push(`| ${mdCell(id)} | ${mdCell(name)} | ${sev} | ${act} | ${rule} |`);
      }
      lines.push('');
    }
  }

  // ── 6. Data Sources ───────────────────────────────────────────────────────────
  if (sections.includes('data_sources') && data.data_sources) {
    lines.push('---'); lines.push('');
    lines.push('## 6. Data Sources'); lines.push('');
    if (!data.data_sources.length) {
      lines.push('*No data sources defined.*'); lines.push('');
    } else {
      lines.push('| ID | System | Type | Access | Contains PII | Description |');
      lines.push('|---|---|---|---|---|---|');
      for (const ds of data.data_sources) {
        const id     = ds.slug || ds.data_source_id || '';
        const system = mdCell(ds.source_name || ds.source_system || ds.system_name || ds.name);
        const type   = mdCell(ds.source_type);
        const access = mdCell(ds.access_type || ds.access_method);
        const pii    = (ds.contains_pii === 1 || ds.contains_pii === true) ? 'Yes'
                     : (ds.contains_pii === 0 || ds.contains_pii === false) ? 'No'
                     : mdCell(ds.data_sensitivity || ds.sensitivity);
        const desc   = mdCell(ds.description);
        lines.push(`| ${mdCell(id)} | ${system} | ${type} | ${access} | ${pii} | ${desc} |`);
      }
      lines.push('');
    }
  }

  // ── 7. Test Scenarios ─────────────────────────────────────────────────────────
  if (sections.includes('test_scenarios') && data.test_scenarios) {
    lines.push('---'); lines.push('');
    lines.push('## 7. Test Scenarios'); lines.push('');
    if (!data.test_scenarios.length) {
      lines.push('*No test scenarios defined.*'); lines.push('');
    } else {
      lines.push('| ID | Type | Description | Expected Output |');
      lines.push('|---|---|---|---|');
      for (const ts of data.test_scenarios) {
        const id   = ts.scenario_id_ref || ts.test_id || ts.id || '';
        const type = mdCell(ts.scenario_type || ts.type);
        const desc = mdCell(ts.description  || ts.scenario_description);
        const exp  = mdCell(ts.expected_output || ts.expected_result);
        lines.push(`| ${mdCell(id)} | ${type} | ${desc} | ${exp} |`);
      }
      lines.push('');
    }
  }

  // ── 8. User Stories ───────────────────────────────────────────────────────────
  if (sections.includes('user_stories') && data.user_stories) {
    lines.push('---'); lines.push('');
    lines.push('## 8. User Stories'); lines.push('');
    if (!data.user_stories.length) {
      lines.push('*No user stories defined.*'); lines.push('');
    } else {
      const bySprint = {};
      for (const us of data.user_stories) {
        const sprint = us.sprint || us.sprint_number || 'Backlog';
        (bySprint[sprint] = bySprint[sprint] || []).push(us);
      }
      for (const [sprint, stories] of Object.entries(bySprint)) {
        lines.push(`### Sprint ${sprint}`); lines.push('');
        lines.push('| ID | Story | Priority | Acceptance Criteria |');
        lines.push('|---|---|---|---|');
        for (const us of stories) {
          const id    = us.slug || us.story_id_ref || us.user_story_id || us.id || '';
          // Render the canonical "As a X, I want Y, so that Z" narrative; fall back to
          // legacy title/description if a story predates the role/want/so_that shape.
          const story = us.role || us.want || us.so_that
            ? `As a ${us.role || '—'}, I want ${us.want || '—'}${us.so_that ? `, so that ${us.so_that}` : ''}`
            : (us.title || us.story_title || us.description || us.story_description || '');
          const prio  = mdCell(us.priority || us.story_type || us.type);
          const ac    = mdCell(us.acceptance_criteria);
          lines.push(`| ${mdCell(id)} | ${mdCell(story)} | ${prio} | ${ac} |`);
        }
        lines.push('');
      }
    }
  }

  // ── 9. Governance Controls ────────────────────────────────────────────────────
  if (sections.includes('governance') && data.governance) {
    lines.push('---'); lines.push('');
    lines.push('## 9. Governance Controls'); lines.push('');
    if (!data.governance.length) {
      lines.push('*No governance controls defined.*'); lines.push('');
    } else {
      lines.push('| ID | Control | Risk | Framework | Owner | Approvals |');
      lines.push('|---|---|---|---|---|---|');
      for (const gc of data.governance) {
        const id    = gc.governance_id_ref || gc.id || '';
        const ctrl  = mdCell(gc.control_description || gc.name);
        const risk  = gc.risk_classification  || gc.risk  || '';
        const fw    = gc.framework || gc.compliance_framework || '';
        const owner = gc.control_owner || gc.owner || '';
        const appr  = gc.approvals_required || gc.approvals || '';
        lines.push(`| ${id} | ${ctrl} | ${risk} | ${fw} | ${owner} | ${appr} |`);
      }
      lines.push('');
    }
  }

  // ── 10. Entity Relationships ──────────────────────────────────────────────────
  if (sections.includes('relationships') && data.relationships) {
    lines.push('---'); lines.push('');
    lines.push('## 10. Entity Relationships'); lines.push('');
    const { use_cases = [], project_tools = [] } = data.relationships;
    if (!use_cases.length && !project_tools.length) {
      lines.push('*No relationship data available.*'); lines.push('');
    } else {
      for (const uc of use_cases) {
        lines.push(`- **Use Case:** ${uc.title}${uc.readiness ? ` *(${uc.readiness})*` : ''}`);
        // Phase 3: agents listed per UC (M:N join), not per workflow
        for (const ag of (uc.agents || [])) {
          const supLabel = ag.supervision_model ? ` — ${ag.supervision_model}` : '';
          lines.push(`  - 🤖 Agent: ${ag.name}${ag.slug ? ` (${ag.slug})` : ''}${supLabel}`);
        }
        for (const wf of (uc.workflows || [])) {
          const wfLabel = wf.slug ? `${wf.name} (${wf.slug})` : wf.name;
          lines.push(`  - **Workflow:** ${wfLabel} *(${wf.step_count} step${wf.step_count !== 1 ? 's' : ''})*`);
          // Phase 2: participants
          if (wf.participants && wf.participants.length) {
            const pNames = wf.participants.map(p => p.swimlane_display_name).filter(Boolean).join(', ');
            if (pNames) lines.push(`    - 👥 Participants: ${pNames}`);
          }
          for (const hitl of (wf.hitl_roles || []))
            lines.push(`    - 👤 HITL: ${hitl.owner_role} — ${hitl.gate_type}${hitl.sla ? ` (SLA: ${hitl.sla})` : ''}`);
        }
      }
      lines.push('');
      if (project_tools.length) {
        lines.push('**Project Tools:**');
        for (const t of project_tools) {
          const devBadge = t.dev_status === 'To be built' ? ' 🔨' : '';
          lines.push(`- \`${t.name}\`${t.slug ? ` (${t.slug})` : ''}${t.execution_mode ? ` — ${t.execution_mode}` : ''}${devBadge}`);
        }
        lines.push('');
      }
    }
  }

  // ── 11. Cost Projections ──────────────────────────────────────────────────────
  if (sections.includes('cost_summary') && data.cost_summary) {
    lines.push('---'); lines.push('');
    lines.push('## 11. Cost Projections (Now Assist)'); lines.push('');
    const { assumption, use_cases: costUCs = [] } = data.cost_summary;
    if (assumption) {
      lines.push(`> **Cost model:** ServiceNow Now Assist · **$${assumption.cost_per_assist}/assist** · ${assumption.planning_period} planning period`);
      lines.push('');
    }
    const hasAnyBindings = costUCs.some(u => u.projected_per_period > 0);
    if (!hasAnyBindings) {
      lines.push('*No cost bindings defined. Use the **Estimate Costs** button on a Use Case in Design Review to generate AI-powered projections.*');
      lines.push('');
    } else {
      const periodsPerYear = assumption?.periods_per_year || 12;
      lines.push('| Use Case | Slug | Projected/Period | Projected/Year | Baseline/Year | Est. ROI |');
      lines.push('|---|---|---|---|---|---|');
      for (const uc of costUCs) {
        const perPeriod = uc.projected_per_period || 0;
        const perYear   = perPeriod * periodsPerYear;
        const baseline  = uc.baseline_cost_annual_usd || 0;
        const roi       = (perYear > 0 && baseline > 0) ? `${(baseline / perYear).toFixed(1)}x` : '—';
        lines.push(`| ${mdCell(uc.title)} | ${uc.slug || ''} | ${fmtCost(perPeriod)} | ${fmtCost(perYear)} | ${baseline > 0 ? fmtCost(baseline) : '—'} | ${roi} |`);
      }
      lines.push('');
      lines.push('*Cost estimates are derived from AI-generated step skill bindings. Verify against actual usage post-deployment.*');
      lines.push('');
    }
  }

  // ── Post-Deploy: Register sys_ids ───────────────────────────────────────────
  // Slug-keyed manifest the deployer fills with returned sys_ids and POSTs back, closing
  // the round-trip identity loop so the next reverse-sync reconciles instead of duplicating.
  // CREATE entities only (no source_sys_id) — a row that already carries a sys_id is a
  // tracked PATCH and needs no registration. Each row is a ready-to-fill register-sysid
  // payload (R1b): registration is REQUIRED or the next delta re-POSTs → duplicate.
  const regScope = project.servicenow_scope || '';
  const regRows = [];
  const addReg = (rows, entity_type, source_table) => {
    for (const r of (rows || [])) if (r.slug && !r.source_sys_id)
      regRows.push({ entity_type, slug: r.slug, sys_id: '', source_table, source_scope: regScope });
  };
  addReg(data.use_cases,      'use_case',       'sn_aia_usecase');
  addReg(data.agents,         'agent_spec',     'sn_aia_agent');
  addReg(data.tools,          'tool',           'sn_aia_tool');
  addReg(data.workflows,      'workflow',       'sn_aia_usecase');
  addReg(data.data_models,    'data_model',     'sys_db_object');
  addReg(data.business_logic, 'business_logic', 'sys_script');
  addReg(data.catalog_items,  'catalog_item',   'sc_cat_item');
  addReg(data.integrations,   'integration',    'sys_rest_message');
  // Generic artifacts (new records only — those with source_sys_id are already registered)
  for (const art of (data.sn_generic_artifacts || [])) {
    if (art.slug && !art.source_sys_id)
      regRows.push({ entity_type: 'sn_artifact', slug: art.slug, sys_id: '', source_table: art.source_table || '', source_scope: regScope });
    for (const ch of (art.children || []))
      if (ch.slug && !ch.source_sys_id)
        regRows.push({ entity_type: 'sn_artifact', slug: ch.slug, sys_id: '', source_table: ch.source_table || art.source_table || '', source_scope: regScope });
  }
  if (regRows.length) {
    lines.push('---'); lines.push('');
    lines.push('## Post-Deploy: Register sys_ids');
    lines.push('');
    lines.push('> **REQUIRED step — do not skip.** Until each created record\'s `sys_id` is registered back, the Workbench row stays unlinked and the **next delta will re-create it as a duplicate**. (Re-capturing a record that carries its `[[wb:…]]` tag also self-heals the link, but registering here is the deterministic path.)');
    lines.push('');
    lines.push('After `now-sdk install`, look up each artifact\'s `sys_id` on the instance and paste it into the matching row below, then POST the whole body to the endpoint below.');
    lines.push('');
    lines.push('- **L1 design entities:** query `sn_aia_agent` / `sn_aia_tool` / `sn_aia_usecase` by name');
    lines.push('- **Generic artifacts (`sn_artifact`):** query the `source_table` column value (e.g. `sys_security_acl`) by name, or use the `sys_id` returned directly in the SDK deploy output');
    lines.push('');
    lines.push('');
    lines.push(`\`POST /api/v1/projects/${project.project_id}/servicenow/register-sysid\``);
    lines.push('');
    lines.push('This records each `sys_id` onto its Workbench row so the next ServiceNow → Workbench sync reconciles these records in place instead of creating duplicates. Rows are keyed by **slug** — no internal IDs needed.');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify({ registrations: regRows }, null, 2));
    lines.push('```');
    lines.push('');
  }

  // ── Footer ─────────────────────────────────────────────────────────────────
  lines.push('---'); lines.push('');
  lines.push(`*Generated by Agentic SDLC Workbench — ${ts}*`); lines.push('');

  return lines.join('\n');
}

// ──────────────────────────────────────────────
// AGENT INGESTION — process / extractions / clarifications / promote
// ──────────────────────────────────────────────

// Trigger agent processing for one document.
// NON-BLOCKING: marks the document 'processing', returns 202 immediately, and runs the
// (multi-minute) extraction in the background. The client polls GET /:id until the status
// leaves 'processing' (→ staged | review_required | failed). Any failure — including file
// text extraction — is persisted to the document (ingest_status='failed' + processing_notes)
// so the poll surfaces it; it is never lost in a request that already returned.
app.post('/api/v1/ingest-documents/:id/process', (req, res) => {
  const id = req.params.id;
  const doc = db.prepare('SELECT * FROM asdlc_ingest_document WHERE ingest_id = ?').get(id);
  if (!doc) return res.status(404).json({ error: 'Ingest document not found' });
  if (doc.lifecycle_status === 'cancelled') return res.status(409).json({ error: 'Document is cancelled — restore it before processing.' });
  if (doc.ingest_status === 'processing') return res.status(409).json({ error: 'Document is already being processed.' });

  // Optional AI-mode override on (re-)run: faithful | balanced | suggestive. Persist it so
  // processDocument (which re-loads the doc) picks it up, and re-runs honour the chosen dial.
  if (['faithful','balanced','suggestive'].includes(req.body && req.body.enrichment_level)) {
    db.prepare("UPDATE asdlc_ingest_document SET enrichment_level=? WHERE ingest_id=?").run(req.body.enrichment_level, id);
  }

  // Mark 'processing' BEFORE responding so the client's immediate poll sees it (no race).
  db.prepare("UPDATE asdlc_ingest_document SET ingest_status='processing', processing_notes=NULL, updated_at=datetime('now') WHERE ingest_id=?").run(id);
  res.status(202).json({ status: 'processing', ingest_id: id });

  // Fire-and-forget the actual work; persist any failure to the document.
  (async () => {
    try {
      // First run on an uploaded file: extract its text.
      if (doc.file_path && !doc.raw_text) {
        console.log(`[process] Extracting text from file: ${doc.file_path}`);
        const { extractText } = require('./agent/document-reader');
        const rawText = await extractText(doc.file_path, doc.file_type);
        db.prepare("UPDATE asdlc_ingest_document SET raw_text = ?, updated_at = datetime('now') WHERE ingest_id = ?")
          .run(rawText, id);
        console.log(`[process] Text extracted — ${rawText.length} chars stored for ingest ${id}`);
      }
      const { processDocument } = require('./agent/processor');
      const result = await processDocument(id);
      console.log(`[process] Done — ingest ${id}: ${JSON.stringify(result && { staged: result.extractions_staged, status: result.new_status })}`);

      // ── Auto-inject standing cost questions (once per project) ───────────────
      // Standing questions (practice_type='question') are surfaced to the product
      // owner during ingest review to collect cost-relevant data (run volumes,
      // cost model) that BRDs rarely include. Idempotency: once an answer exists
      // for any ingest in the project, no further injection for that question.
      try {
        const ingestDoc = db.prepare('SELECT project_id FROM asdlc_ingest_document WHERE ingest_id=?').get(id);
        if (ingestDoc && ingestDoc.project_id) {
          const pid = ingestDoc.project_id;
          const standingQs = db.prepare(
            "SELECT * FROM asdlc_best_practice WHERE practice_type='question' AND is_active=1 ORDER BY sort_order"
          ).all();

          // Determine current round for this ingest (use the max round just written)
          const roundRow = db.prepare(
            'SELECT MAX(round) AS r FROM asdlc_ingest_clarification WHERE ingest_id=?'
          ).get(id);
          const currentRound = roundRow?.r ?? 1;

          for (const sq of standingQs) {
            const field = `standing:${sq.best_practice_id}`;

            // Skip if this project already has an answered standing question for this bp
            const alreadyAnswered = db.prepare(`
              SELECT 1 FROM asdlc_ingest_clarification c
              JOIN asdlc_ingest_document d ON d.ingest_id = c.ingest_id
              WHERE d.project_id = ? AND c.target_field = ? AND c.answer_text IS NOT NULL
            `).get(pid, field);
            if (alreadyAnswered) continue;

            // Only inject if this extraction produced entities of the relevant type
            const hasEntity = db.prepare(
              "SELECT 1 FROM asdlc_ingest_extraction WHERE ingest_id=? AND entity_type=?"
            ).get(id, sq.scope);
            if (!hasEntity) continue;

            // Avoid duplicates on re-runs of the same ingest
            const alreadyInjected = db.prepare(
              "SELECT 1 FROM asdlc_ingest_clarification WHERE ingest_id=? AND target_field=?"
            ).get(id, field);
            if (alreadyInjected) continue;

            db.prepare(`
              INSERT INTO asdlc_ingest_clarification
                (clarification_id, ingest_id, round, question_text, context_snippet,
                 target_entity_type, target_field, created_at)
              VALUES (?,?,?,?,?,?,?,datetime('now'))
            `).run(generateId(), id, currentRound, sq.rule_text, null, sq.scope, field);
            console.log(`[process] Injected standing question "${sq.title}" for ingest ${id}`);
          }
        }
      } catch (sqErr) {
        console.error('[process] Standing question injection failed (non-fatal):', sqErr.message);
      }
    } catch (err) {
      console.error('[process:async]', err.message);
      db.prepare("UPDATE asdlc_ingest_document SET ingest_status='failed', processing_notes=?, updated_at=datetime('now') WHERE ingest_id=?")
        .run(String((err && err.message) || err).slice(0, 1000), id);
    }
  })();
});

// Get staged extractions
app.get('/api/v1/ingest-documents/:id/extractions', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM asdlc_ingest_extraction WHERE ingest_id=? ORDER BY round, entity_type, created_at'
  ).all(req.params.id);
  res.json(rows.map(r => ({ ...r, entity_data: parseJson(r.entity_data) })));
});

// Update a single extraction (e.g. reject it)
app.put('/api/v1/ingest-documents/:id/extractions/:eid', (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'status is required' });
  const parent = db.prepare('SELECT lifecycle_status FROM asdlc_ingest_document WHERE ingest_id = ?').get(req.params.id);
  if (parent && parent.lifecycle_status === 'cancelled') return res.status(409).json({ error: 'Document is cancelled — restore it before editing extractions.' });
  db.prepare("UPDATE asdlc_ingest_extraction SET status=? WHERE extraction_id=? AND ingest_id=?")
    .run(status, req.params.eid, req.params.id);
  const row = db.prepare('SELECT * FROM asdlc_ingest_extraction WHERE extraction_id=?').get(req.params.eid);
  res.json({ ...row, entity_data: parseJson(row.entity_data) });
});

// Get clarification questions (all rounds)
app.get('/api/v1/ingest-documents/:id/clarifications', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM asdlc_ingest_clarification WHERE ingest_id=? ORDER BY round, created_at'
  ).all(req.params.id);
  res.json(rows);
});

// Submit answers for the current open round, then re-run extraction
app.post('/api/v1/ingest-documents/:id/clarifications/answer', async (req, res) => {
  const uid = userId(req);
  const { answers } = req.body; // { clarification_id: "answer text", ... }
  if (!answers || typeof answers !== 'object') {
    return res.status(400).json({ error: 'answers object is required' });
  }
  const parentDoc = db.prepare('SELECT lifecycle_status FROM asdlc_ingest_document WHERE ingest_id = ?').get(req.params.id);
  if (parentDoc && parentDoc.lifecycle_status === 'cancelled') return res.status(409).json({ error: 'Document is cancelled — restore it before answering clarifications.' });
  for (const [clarId, answerText] of Object.entries(answers)) {
    if (answerText && String(answerText).trim()) {
      db.prepare(`
        UPDATE asdlc_ingest_clarification
        SET answer_text=?, answered_at=datetime('now'), answered_by=?
        WHERE clarification_id=? AND ingest_id=?
      `).run(String(answerText).trim(), uid, clarId, req.params.id);
    }
  }
  // ── Auto-apply standing question answers ─────────────────────────────────────
  // Standing questions (target_field = 'standing:<best_practice_id>') are answered
  // by the product owner directly — no AI re-extraction needed. Parse the answer and
  // write it immediately, deterministically, to the relevant design entities.
  const standingApplied = [];
  try {
    const ingestDocForStanding = db.prepare('SELECT project_id FROM asdlc_ingest_document WHERE ingest_id=?').get(req.params.id);
    if (ingestDocForStanding && ingestDocForStanding.project_id) {
      const pid = ingestDocForStanding.project_id;
      for (const [clarId] of Object.entries(answers)) {
        const clarRow = db.prepare(
          "SELECT c.answer_text, c.target_field, bp.scope FROM asdlc_ingest_clarification c " +
          "LEFT JOIN asdlc_best_practice bp ON bp.best_practice_id = SUBSTR(c.target_field, 10) " +
          "WHERE c.clarification_id=? AND c.target_field LIKE 'standing:%' AND c.answer_text IS NOT NULL"
        ).get(clarId);
        if (!clarRow) continue;

        // Standing questions are project-level planning assumptions, so these writes
        // are intentionally project-wide — but they (a) only FILL values that are still
        // unset (never clobber a value the user set explicitly), (b) validate the parsed
        // input before writing, and (c) are audited + reported back so the bulk change is
        // visible rather than silent. See BACKLOG #40.
        if (clarRow.scope === 'workflow') {
          // Parse a number from the answer (e.g. "50 per month" → 50)
          const numMatch = clarRow.answer_text.match(/\d+/);
          const vol = numMatch ? parseInt(numMatch[0], 10) : NaN;
          if (Number.isFinite(vol) && vol > 0) {
            // IS NULL only — an explicit 0 (a workflow that intentionally doesn't run on
            // a schedule) is a real value and must not be overwritten by a project default.
            const updated = db.prepare(
              "UPDATE asdlc_workflow SET runs_per_period=?, updated_by=?, updated_at=datetime('now') WHERE project_id=? AND runs_per_period IS NULL"
            ).run(vol, uid, pid);
            if (updated.changes > 0) {
              auditLog('asdlc_workflow', pid, 'standing_bulk_fill',
                null, { field: 'runs_per_period', value: vol, rows: updated.changes, clarification_id: clarId }, uid);
              standingApplied.push({ scope: 'workflow', field: 'runs_per_period', value: vol, rows_filled: updated.changes });
            }
            console.log(`[clarify] Auto-filled runs_per_period=${vol} on ${updated.changes} unset workflow(s) in project ${pid}`);
          } else {
            console.log(`[clarify] Standing workflow-volume answer had no usable positive number; skipped (answer: ${JSON.stringify(clarRow.answer_text).slice(0, 80)})`);
          }
        } else if (clarRow.scope === 'agent_spec') {
          // 'yes' → enable cost tracking; anything else → leave as-is (cost_model stays 'none')
          if (/yes/i.test(clarRow.answer_text)) {
            const updated = db.prepare(
              "UPDATE asdlc_agent_spec SET cost_model='servicenow_now_assist', updated_by=?, updated_at=datetime('now') WHERE project_id=? AND (cost_model='none' OR cost_model IS NULL)"
            ).run(uid, pid);
            if (updated.changes > 0) {
              auditLog('asdlc_agent_spec', pid, 'standing_bulk_fill',
                null, { field: 'cost_model', value: 'servicenow_now_assist', rows: updated.changes, clarification_id: clarId }, uid);
              standingApplied.push({ scope: 'agent_spec', field: 'cost_model', value: 'servicenow_now_assist', rows_filled: updated.changes });
            }
            console.log(`[clarify] Auto-set cost_model=servicenow_now_assist on ${updated.changes} agent(s) in project ${pid}`);
          }
        }
      }
    }
  } catch (sqErr) {
    console.error('[clarify] Standing question auto-apply failed (non-fatal):', sqErr.message);
  }

  try {
    const { processDocument } = require('./agent/processor');
    const result = await processDocument(req.params.id);
    // Surface any project-wide standing-question fills so the caller/UI can show what changed.
    const payload = (result && typeof result === 'object' && standingApplied.length)
      ? { ...result, standing_applied: standingApplied }
      : result;
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Design quality check — read-only report the UI can fetch and display on the
// staged-extractions screen, before the user ever clicks Create Change Packets.
app.get('/api/v1/ingest-documents/:id/quality-check', (req, res) => {
  const doc = db.prepare('SELECT * FROM asdlc_ingest_document WHERE ingest_id=?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Ingest document not found' });
  const { runQualityCheck } = require('./agent/quality-check');
  res.json(runQualityCheck(db, req.params.id));
});

// Promote staged extractions → Change Packets
app.post('/api/v1/ingest-documents/:id/promote', async (req, res) => {
  const uid = userId(req);
  const doc = db.prepare('SELECT * FROM asdlc_ingest_document WHERE ingest_id=?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Ingest document not found' });
  if (doc.lifecycle_status === 'cancelled') return res.status(409).json({ error: 'Document is cancelled — restore it before promoting.' });

  const extractions = db.prepare(
    "SELECT * FROM asdlc_ingest_extraction WHERE ingest_id=? AND status='staged' ORDER BY entity_type"
  ).all(req.params.id).map(r => ({ ...r, entity_data: parseJson(r.entity_data) }));

  if (extractions.length === 0) return res.status(400).json({ error: 'No staged extractions to promote' });

  // Clarify-before-promote: block while the cross-check has unresolved conflict
  // ('conflict:') clarifications. The user must answer them (which re-runs extraction)
  // so ripple/requirement conflicts are reconciled before any change is applied.
  const { hasOpenConflicts } = require('./agent/cross-check');
  if (hasOpenConflicts(req.params.id)) {
    const open = db.prepare(
      "SELECT clarification_id, question_text, target_entity_type, target_field FROM asdlc_ingest_clarification WHERE ingest_id=? AND answer_text IS NULL AND target_field LIKE 'conflict:%'"
    ).all(req.params.id);
    return res.status(409).json({
      error: 'Unresolved conflict clarifications must be answered before promoting.',
      conflict_clarifications: open,
    });
  }

  // ── Orphan guard: never silently drop a REQUIRED parent and half-materialize the subtree.
  // A staged child whose required parent (registry parentLinks, required:true) is neither being
  // promoted here nor already materialized would fail to materialize on apply, cascading to its
  // children (the use_case → workflow → steps/agents bug). Pull in a HIGH-CONFIDENCE parent that
  // is merely needs_clarification (its flag is incidental); HARD-BLOCK a genuinely unresolved one.
  {
    const thrRow = db.prepare('SELECT confidence_threshold FROM asdlc_project WHERE project_id=?').get(doc.project_id);
    const threshold = (thrRow && typeof thrRow.confidence_threshold === 'number') ? thrRow.confidence_threshold : 0.75;
    const allEx = db.prepare('SELECT * FROM asdlc_ingest_extraction WHERE ingest_id=?')
      .all(req.params.id).map(r => ({ ...r, entity_data: parseJson(r.entity_data) || {} }));
    const nameOf = (type, data) => {
      const e = registry.byEntityType[type];
      for (const k of ((e && e.nameKeys) || ['title', 'name'])) if (data && data[k]) return data[k];
      return (data && (data.title || data.name)) || null;
    };
    const parentAvailable = (parentType, name) => {
      if (!name) return false;
      if (extractions.some(e => e.entity_type === parentType && nameOf(parentType, e.entity_data) === name)) return true;
      const e = registry.byEntityType[parentType];
      if (e && e.materializable && e.table) {
        const col = (e.nameKeys && e.nameKeys[0]) || 'name';
        try { if (db.prepare(`SELECT 1 FROM ${e.table} WHERE project_id=? AND ${col}=? LIMIT 1`).get(doc.project_id, name)) return true; } catch { /* table without that col */ }
      }
      return false;
    };
    const pulledIn = [];
    // Fixpoint: pulling in a parent may itself reference a (grand)parent.
    let added = true, guard = 0;
    while (added && guard++ < 12) {
      added = false;
      for (const child of [...extractions]) {
        const e = registry.byEntityType[child.entity_type];
        for (const link of ((e && e.parentLinks) || [])) {
          if (!link.required) continue;
          const pname = child.entity_data[link.nameKeyInData];
          if (!pname || parentAvailable(link.parentType, pname)) continue;
          const cand = allEx.find(x => x.entity_type === link.parentType && nameOf(link.parentType, x.entity_data) === pname
            && !['staged', 'promoted'].includes(x.status) && !extractions.some(s => s.extraction_id === x.extraction_id));
          if (cand && cand.confidence >= threshold) {
            cand.status = 'staged'; extractions.push(cand); pulledIn.push(cand);
            db.prepare("UPDATE asdlc_ingest_extraction SET status='staged' WHERE extraction_id=?").run(cand.extraction_id);
            added = true;
          }
        }
      }
    }
    if (pulledIn.length) console.log(`[promote] pulled in ${pulledIn.length} high-confidence required parent(s) flagged needs_clarification: ` +
      pulledIn.map(p => `${p.entity_type} "${nameOf(p.entity_type, p.entity_data)}"`).join(', '));
    const orphans = [];
    for (const child of extractions) {
      const e = registry.byEntityType[child.entity_type];
      for (const link of ((e && e.parentLinks) || [])) {
        if (!link.required) continue;
        const pname = child.entity_data[link.nameKeyInData];
        if (!pname || parentAvailable(link.parentType, pname)) continue;
        const cand = allEx.find(x => x.entity_type === link.parentType && nameOf(link.parentType, x.entity_data) === pname);
        orphans.push({ child: nameOf(child.entity_type, child.entity_data) || child.entity_type, child_type: child.entity_type,
          requires: link.parentType, parent_name: pname, parent_status: cand ? cand.status : 'missing', parent_confidence: cand ? cand.confidence : null });
      }
    }
    if (orphans.length) {
      return res.status(409).json({
        error: 'Cannot promote: required parent(s) are unresolved — promoting would orphan their children and leave a half-materialized design. ' +
          'Answer/dismiss the parent\'s clarification (or raise its confidence) so it can be staged, then promote.',
        orphans,
      });
    }
  }

  // ── Design quality gate: deterministic checks for duplicate/split entities,
  // unresolved placeholders, AI-invented structural additions, and requirement
  // coverage gaps. 'block' findings can never be bypassed. 'warn' findings
  // require the caller to acknowledge them once (acknowledge_warnings:true in
  // the request body) before promotion proceeds — 'info' findings never block.
  {
    const { runQualityCheck } = require('./agent/quality-check');
    const quality = runQualityCheck(db, req.params.id);
    if (quality.summary.blocking > 0) {
      return res.status(409).json({
        error: 'Design quality check found blocking issues — resolve them before promoting.',
        quality,
      });
    }
    if (quality.summary.warnings > 0 && !(req.body && req.body.acknowledge_warnings)) {
      return res.status(409).json({
        error: 'Design quality check found issues worth a look before promoting.',
        quality,
        requires_acknowledgment: true,
      });
    }
  }

  // ── AI requirement re-linker: fill missing use_case_title on orphan FRs/NFRs ────
  // The extraction AI Agent extracts FRs before it knows use case titles; this
  // AI Agent pass runs Haiku to infer the link. Non-fatal — promote continues
  // even if it fails. Updates entity_data in memory AND in the extraction row
  // so re-promotes also carry the inferred link.
  {
    const orphanReqs = extractions.filter(ex =>
      (ex.entity_type === 'functional_req' || ex.entity_type === 'nonfunctional_req') &&
      !(ex.entity_data && ex.entity_data.use_case_title)
    );
    if (orphanReqs.length > 0) {
      const useCasesInPacket = extractions
        .filter(ex => ex.entity_type === 'use_case')
        .map(ex => ({ title: (ex.entity_data || {}).title, summary: (ex.entity_data || {}).summary }))
        .filter(uc => uc.title);
      const useCasesInDb = (() => {
        try {
          return db.prepare(
            "SELECT title, summary FROM asdlc_use_case WHERE project_id=? AND (lifecycle_status IS NULL OR lifecycle_status != 'retired') ORDER BY created_at"
          ).all(doc.project_id);
        } catch { return []; }
      })();
      const allUseCases = [...useCasesInPacket, ...useCasesInDb].filter(uc => uc.title);

      if (allUseCases.length > 0) {
        try {
          const { linkRequirements } = require('./agent/req-linker');
          const links = await linkRequirements(orphanReqs, allUseCases, doc.project_id);
          const updateEx = db.prepare("UPDATE asdlc_ingest_extraction SET entity_data=? WHERE extraction_id=?");
          for (const ex of extractions) {
            if ((ex.entity_type === 'functional_req' || ex.entity_type === 'nonfunctional_req') &&
                !(ex.entity_data && ex.entity_data.use_case_title) &&
                links[(ex.entity_data || {}).title]) {
              ex.entity_data = { ...ex.entity_data, use_case_title: links[ex.entity_data.title] };
              // Persist so re-promote also carries the inferred link
              updateEx.run(JSON.stringify(ex.entity_data), ex.extraction_id);
            }
          }
        } catch (err) {
          console.warn('[promote] req-linker failed (non-fatal):', err.message);
        }
      }
    }
  }

  // ONE CP per ingest iteration. Each extraction becomes a change_packet_item
  // carrying its operation (create/update/delete), the resolved target for
  // update/delete, the prior value (old_value) and a conflict classification.
  const cpId    = generateId();
  const cpCode  = uniquePacketCode();
  // ServiceNow-sourced ingests (document_type='fluent', from the Fluent/REST adapter)
  // are labeled as a "SN to WB synch" in Change History; transcript/doc ingests keep
  // the generic label.
  const isSnSync = doc.document_type === 'fluent';
  const summary = isSnSync
    ? `SN to WB synch — ${extractions.length} entities from "${doc.document_title}"`
    : `Ingest promotion — ${extractions.length} entities from "${doc.document_title}"`;

  const CONFLICT_RANK    = { net_new: 0, modifies_existing: 1, deletes_existing: 2 };
  const CONFLICT_BY_RANK = ['net_new', 'modifies_existing', 'deletes_existing'];

  // First pass: resolve each extraction into a concrete CP item spec.
  const itemSpecs = [];
  let worstRank = 0;
  let hasChange = false;   // any update/delete present
  for (let ex of extractions) {
    let   data   = ex.entity_data || {};
    const entity = registry.byEntityType[ex.entity_type];
    // Inject ingest_id server-side for entity types that have an ingest_id column
    // (FR, NFR). The AI never emits it — we stamp it from the source document here
    // so it ends up in new_value and gets written to the DB column at materialization.
    if (entity && entity.injectsIngestId && doc.ingest_id) {
      data = { ...data, ingest_id: doc.ingest_id };
      ex = { ...ex, entity_data: data };   // keep ex in sync for new_value below
    }
    let op        = data.operation || 'create';
    let entityId  = ex.extraction_id;            // placeholder until materialized
    let fieldPath = `${ex.entity_type}.new_record`;
    let oldValue  = null;
    let rationale = `Extracted from "${doc.document_title}" (confidence ${Math.round(ex.confidence * 100)}%)` +
      (data.conflict_rationale ? ` — ${data.conflict_rationale}` : '');
    let classification = data.conflict_classification ||
      (op === 'delete' ? 'deletes_existing' : op === 'update' ? 'modifies_existing' : 'net_new');

    // ServiceNow identity coalescing: an extraction carrying a source_sys_id that
    // matches an already-materialized record is an UPDATE of THAT record, even if
    // its name/slug changed (survives renames in ServiceNow). Deterministic —
    // overrides whatever operation the model proposed. Only for entity types that
    // track provenance (fieldMap.source_sys_id) and have the column.
    let resolvedBySysId = false;
    if (entity && entity.materializable && entity.fieldMap && entity.fieldMap.source_sys_id && data.source_sys_id) {
      try {
        const hit = db.prepare(
          `SELECT ${entity.pk} AS id FROM ${entity.table}
           WHERE source_sys_id = ? AND project_id = ?
             AND (lifecycle_status IS NULL OR lifecycle_status != 'retired') LIMIT 1`
        ).get(data.source_sys_id, doc.project_id);
        if (hit) {
          op = 'update'; entityId = hit.id; fieldPath = `${ex.entity_type}.update`;
          const row = mtRow(entity.table, entity.pk, hit.id);
          oldValue = row ? JSON.stringify(row) : null;
          hasChange = true; classification = 'modifies_existing'; resolvedBySysId = true;
        }
      } catch { /* table lacks source_sys_id — ignore */ }
    }

    if (!resolvedBySysId && (op === 'update' || op === 'delete') && entity && entity.materializable && data.target_slug) {
      const targetId = resolveSlugToId(entity, doc.project_id, data.target_slug);
      if (targetId) {
        entityId  = targetId;
        fieldPath = `${ex.entity_type}.${op}`;
        const row = mtRow(entity.table, entity.pk, targetId);
        oldValue  = row ? JSON.stringify(row) : null;
        hasChange = true;
      } else {
        op = 'create';
        rationale = `[auto-downgraded: target ${data.target_slug} not found] ` + rationale;
      }
    } else if (!resolvedBySysId && (op === 'update' || op === 'delete')) {
      op = 'create';   // no resolvable target → safe downgrade
    }
    if (op === 'create') classification = 'net_new';

    worstRank = Math.max(worstRank, CONFLICT_RANK[classification] ?? 0);
    itemSpecs.push({ ex, op, entityId, fieldPath, oldValue, rationale });
  }

  db.prepare(`
    INSERT INTO asdlc_change_packet
      (change_packet_id, project_id, packet_code, status, summary,
       source_timestamp, conflict_classification, risk_level, recommended_action,
       ingest_id, cp_origin, visibility_scope, created_by, created_at, updated_at)
    VALUES (?,?,?,'pending_review',?,datetime('now'),?,?,'review',?,?,'PROJECT',?,datetime('now'),datetime('now'))
  `).run(cpId, doc.project_id, cpCode, summary, CONFLICT_BY_RANK[worstRank] || 'net_new', hasChange ? 'med' : 'low',
         req.params.id, isSnSync ? 'sn_inbound' : null, uid);

  const insertItem = db.prepare(`
    INSERT INTO asdlc_change_packet_item
      (change_packet_item_id, change_packet_id, entity_type, entity_id, operation,
       field_path, old_value, new_value, rationale, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
  `);
  const markPromoted = db.prepare("UPDATE asdlc_ingest_extraction SET status='promoted' WHERE extraction_id=?");

  // Per-type counts purely for the response (UX context)
  const byType = {};
  for (const spec of itemSpecs) {
    insertItem.run(
      generateId(), cpId, spec.ex.entity_type, spec.entityId, spec.op,
      spec.fieldPath, spec.oldValue, JSON.stringify(spec.ex.entity_data), spec.rationale
    );
    markPromoted.run(spec.ex.extraction_id);
    byType[spec.ex.entity_type] = (byType[spec.ex.entity_type] || 0) + 1;
  }

  auditLog('asdlc_change_packet', cpId, 'INSERT', null,
    { packet_code: cpCode, source: 'agent_ingest', ingest_id: req.params.id, by_type: byType }, uid);

  db.prepare(`
    UPDATE asdlc_ingest_document
    SET ingest_status='promoted', change_packets_generated=1, updated_at=datetime('now')
    WHERE ingest_id=?
  `).run(req.params.id);

  res.json({
    change_packets: [{
      change_packet_id: cpId,
      packet_code: cpCode,
      summary,
      item_count: extractions.length,
      by_type: byType,
    }],
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ServiceNow round-trip — Phase F: SYNC (capture → reconcile → gate → apply)
// ─────────────────────────────────────────────────────────────────────────
// POST /api/v1/projects/:id/servicenow/sync
//   Runs the full pipeline (agent/sn-sync.js) for a ServiceNow-linked project and
//   GATES each proposal. SAFE additive changes (reviewer-approved, non-destructive,
//   above the project's confidence threshold) auto-apply through the SAME materializer
//   a human-approved Change Packet uses — storing source_hash so the next sync's
//   tier-0 pre-diff detects "unchanged". Everything else lands in a 'pending_review'
//   Change Packet for HITL. Drift is flagged, NEVER deleted. The non-destructive guard
//   is a hard floor under all modes.
//   ?dry_run=1 (or body.dry_run:true) → return the gated plan with NO writes.
//   body may carry {scope,instance,user,pw,mode,threshold,artifacts} overrides; creds
//   fall back to the project link + SN_INSTANCE/SN_USER/SN_PASSWORD env.
// ═══════════════════════════════════════════════════════════════════════════
const snSync = require('./agent/sn-sync');
const { WB_PROVENANCE_TABLES, persistChangeSignals } = require('./agent/sn-capture');
// wb table name → { pk } for the R1 link self-heal (covers L1 tables + asdlc_sn_artifact).
const PK_BY_WB_TABLE = {};
WB_PROVENANCE_TABLES.forEach(t => { PK_BY_WB_TABLE[t.table] = t.pk; });

// ── Deploy identity: keys.ts seed manifest (#87) ─────────────────────────────
// The SDK's keys.ts is "the source of truth for record identity": on rebuild "the record
// is updated in place, not duplicated" — but ONLY if the deployer seeds it with the
// sys_ids the Workbench already knows. Without this, Now.ID mints fresh sys_ids on every
// update-deploy → duplicates that the next inbound sync imports as "new". Emitted into
// both the full Build Spec and the SN Delta export. Deterministic Now.ID key naming:
//   wb-<first 8 of project id>-<slug lowercase>   (stable iff the slug is stable —
// "renaming a key creates a new record and orphans the old one", so slugs are an
// identity invariant once deployed).
function deployKeyFor(projectId, slug) {
  return `wb-${String(projectId).slice(0, 8)}-${String(slug).toLowerCase()}`;
}
function buildKeysManifestLines(projectId) {
  const rows = [];
  for (const t of WB_PROVENANCE_TABLES) {
    let recs = [];
    try {
      recs = db.prepare(
        `SELECT ${t.pk} AS id, ${t.nameCol} AS name, slug, source_table, source_sys_id
         FROM ${t.table}
         WHERE project_id = ? AND source_sys_id IS NOT NULL AND slug IS NOT NULL
           AND (lifecycle_status IS NULL OR lifecycle_status != 'retired')
         ORDER BY slug`
      ).all(projectId);
    } catch { continue; }   // table without slug/provenance columns — skip
    for (const r of recs) rows.push({ type: t.type, ...r });
  }
  const lines = [];
  lines.push('## 🔑 Deploy Identity — keys.ts Seed Manifest');
  lines.push('');
  lines.push('The ServiceNow SDK tracks record identity in your project\'s `keys.ts` ("the source of truth');
  lines.push('for record identity" — commit it). A `Now.ID[\'<key>\']` whose key already maps to a sys_id is');
  lines.push('**updated in place, not duplicated**. Seed `keys.ts` with the known identities below BEFORE the');
  lines.push('first build so update-deploys coalesce onto the existing records (exact file syntax:');
  lines.push('https://servicenow.github.io/sdk/config/keys-file).');
  lines.push('');
  lines.push('**Identity invariants:**');
  lines.push('- Use the EXACT `Now.ID` key shown — it is derived from the stable Workbench slug.');
  lines.push('- **Never rename a key once deployed** — renaming a key creates a NEW record and orphans the old one.');
  lines.push('- For records with no sys_id yet (creates), use the same naming rule: `wb-<project8>-<slug lowercase>`,');
  lines.push('  then register the minted sys_id back via the Post-Deploy manifest so it appears here next export.');
  lines.push('');
  if (rows.length) {
    lines.push('| Now.ID key | Workbench artifact | ServiceNow table | sys_id |');
    lines.push('|---|---|---|---|');
    for (const r of rows) {
      lines.push(`| \`${deployKeyFor(projectId, r.slug)}\` | ${r.slug} — ${mdCell(r.name || '')} | ${r.source_table || '—'} | \`${r.source_sys_id}\` |`);
    }
    lines.push('');
    lines.push('Machine-readable copy (for scripting the keys.ts seed):');
    lines.push('```json');
    lines.push(JSON.stringify(rows.map(r => ({
      key: deployKeyFor(projectId, r.slug), slug: r.slug, table: r.source_table || null, sys_id: r.source_sys_id,
    })), null, 2));
    lines.push('```');
  } else {
    lines.push('_No Workbench records are linked to ServiceNow sys_ids yet — every deploy below is a CREATE._');
    lines.push('_Use the stable key naming rule above and register the minted sys_ids back afterwards._');
  }
  lines.push('');
  return lines;
}

// A reconcile field_change names a DB column; turn it back into the entity_data key
// the materializer's fieldMap understands (or null if it isn't a mappable field).
function colToDataKey(entity, field) {
  if (!entity || !entity.fieldMap || !field) return null;
  if (entity.fieldMap[field]) return field;                       // already a fieldMap key
  for (const [k, spec] of Object.entries(entity.fieldMap)) if (spec.col === field) return k;
  return null;
}

// Honest minimal mapping of a reverse-engineered candidate → registry entity_data for
// a CREATE. ServiceNow net-new gives only a name + a primary descriptive field; a human
// enriches the rest later. Returns null for types we cannot materialize faithfully.
function inferredToEntityData(inferred) {
  if (!inferred) return null;
  // Phase 2 (reverse L1 parity): the reverse-engineer reused the forward extract_* tool, so the
  // FULL Level-1 entity_data is already present — strip meta/provenance and return it as-is. This
  // is what lifts round-tripped designs to parity (data_model.fields[], tool inputs/outputs, etc.).
  if (inferred.entity_data && typeof inferred.entity_data === 'object') {
    const ed = { ...inferred.entity_data };
    for (const k of ['operation', 'target_slug', 'conflict_classification', 'conflict_rationale',
      'confidence', 'confidence_notes', 'implements_requirements', 'system_generated',
      'source_system', 'source_sys_id', 'source_table', 'source_scope', 'source_fluent', 'source_hash']) delete ed[k];
    return Object.keys(ed).length ? ed : null;
  }
  // Legacy thin fallback (no entity_data — e.g. an old cached inference).
  const name = inferred.name || '(unnamed)';
  const purpose = inferred.purpose || '';
  const behavior = inferred.behavior || '';
  const desc = [purpose, behavior].filter(Boolean).join('\n\n') || name;
  switch (inferred.design_type) {
    case 'use_case':       return { title: name, summary: purpose || name, business_objective: behavior };
    case 'workflow':       return { name, trigger: { description: behavior || purpose || 'See ServiceNow source' } };
    case 'agent_spec':     return { name, scope: purpose || name, instructions: behavior };
    case 'tool':           return { name, contract: desc };
    case 'data_model':     return { name, purpose: desc };
    case 'form_design':    return { name, behavior_notes: desc };
    case 'business_logic': return { name, logic_type: 'business_rule', plain_english: desc };
    case 'catalog_item':     return { name, short_description: purpose || name };
    case 'rest_message':     return { name, integration_type: 'rest_message', description: desc };
    case 'connection_alias': return { name, integration_type: 'connection_alias', description: desc };
    default:               return null;   // 'other' → not auto-creatable
  }
}

// Tier-3 body: the real ServiceNow instantiation kept inline alongside the Level-1 design
// row. For logic artifacts this is the script body; otherwise a compact snapshot of the
// captured salient fields. Lets an elevated business_logic row hold its real source — not
// just the sys_id identity — so the round-trip can preserve "the how as built".
function snArtifactBody(a) {
  const s = a && a.salient;
  if (!s) return null;
  if (typeof s.script === 'string' && s.script.trim()) return s.script;
  try { return JSON.stringify(s); } catch { return null; }
}

// Build the Change-Packet item spec for ONE gated plan item, or null if it can't be
// materialized faithfully (→ caller drops it to a note). `withHash` controls whether
// the captured artifact's source_hash is stamped: only when the Workbench content is
// (or is being brought) in line with this ServiceNow version — i.e. a create or a safe
// auto-applied enrich. A conflict left for HITL must NOT advance the hash, or the
// unresolved conflict would silently classify as "unchanged" on the next sync.
function snPlanItemToCpSpec(pl, scope) {
  const cls = pl.classification;
  const a = pl.artifact || {};
  const dec = pl.decision || {};

  // Generic (Tier-B/C) artifacts (Phase 2): deterministic capture → asdlc_sn_artifact.
  // No registry/business mapping; the prebuilt generic_record already carries type,
  // deploy_strategy, full provenance and (for new/auto-changed) source_hash.
  if (pl.generic) {
    if (cls === 'drift') {
      // Advisory only — field_path deliberately does NOT match the materializer regex.
      return {
        entity_type: 'sn_artifact', operation: 'update', entity_id: pl.wb_id || generateId(),
        field_path: 'sn_artifact.drift_flag', old_value: null,
        new_value: JSON.stringify({ name: pl.name || null }),
        rationale: `[SN sync · drift] ${(dec && dec.reason) || ''}`,
      };
    }
    const rec = pl.generic_record;
    if (!rec) return null;
    const isNew = cls === 'new';
    // Drop source_hash on a non-auto changed item so it re-surfaces until applied.
    if (!(isNew || dec.target === 'auto')) rec.source_hash = null;
    return {
      entity_type: 'sn_artifact', operation: isNew ? 'create' : 'update',
      entity_id: pl.wb_id || generateId(),
      field_path: isNew ? 'sn_artifact.new_record' : 'sn_artifact.update',
      old_value: null, new_value: JSON.stringify(rec),
      rationale: `[SN sync · ${cls}] generic ${rec.sn_metadata_type} "${rec.name}"${rec.tier ? ` (Tier ${rec.tier})` : ''} — ${(dec && dec.reason) || ''}`,
    };
  }
  const conf = (pl.review && typeof pl.review.final_confidence === 'number') ? ` conf ${pl.review.final_confidence.toFixed(2)}` : '';
  const withHash = cls === 'new' || (cls === 'changed' && dec.target === 'auto');
  const prov = {
    source_system: 'servicenow',
    source_sys_id: pl.source_sys_id || a.source_sys_id || null,
    source_table:  a.source_table || null,
    source_scope:  scope || null,
    source_fluent: snArtifactBody(a),   // Tier-3: the real instantiation (script body / captured fields)
  };
  if (withHash) prov.source_hash = a.hash || null;

  if (cls === 'drift') {
    // Advisory only: this field_path deliberately does NOT match the materializer regex,
    // so approving the CP never writes or deletes the drifted record.
    const etype = snSync.TYPE_BY_WB_TABLE[pl.wb_table] || 'workflow';
    return {
      entity_type: etype, operation: 'update', entity_id: pl.wb_id,
      field_path: `${etype}.drift_flag`, old_value: null,
      new_value: JSON.stringify({ name: pl.proposal && pl.proposal.name }),
      rationale: `[SN sync · drift] ${dec.reason}`,
    };
  }

  if (cls === 'new') {
    const inferred = pl.inferred || {};
    const entity = registry.byEntityType[inferred.design_type];
    if (!entity || !entity.materializable) return null;
    const base = inferredToEntityData(inferred);
    if (!base) return null;
    return {
      entity_type: inferred.design_type, operation: 'create',
      entity_id: generateId(),                         // placeholder; mtCreate rewrites it
      field_path: `${inferred.design_type}.new_record`, old_value: null,
      new_value: JSON.stringify({ ...base, ...prov }),
      rationale: `[SN sync · new] ${dec.reason}${conf}`,
    };
  }

  // changed: an auto enrich (fill_blank only, already gated) or a HITL conflict.
  const etype = snSync.TYPE_BY_WB_TABLE[pl.wb_table];
  const entity = etype && registry.byEntityType[etype];
  if (!entity) return null;
  const before = mtRow(entity.table, entity.pk, pl.wb_id);
  const proposal = pl.proposal || {};
  const entity_data = { ...prov };
  const filled = [], deferred = [];
  const snProposed = {};   // proposed values for conflict fields — stored so the UI can show before/after
  for (const fc of (proposal.field_changes || [])) {
    const key = colToDataKey(entity, fc.field);
    if (fc.change_kind === 'fill_blank' && key) {
      entity_data[key] = fc.proposed;
      filled.push(fc.field);
    } else {
      deferred.push(`${fc.field} (${fc.change_kind})`);
      // Preserve the proposed value so the reviewer can compare old vs proposed
      if (fc.proposed !== undefined && fc.proposed !== null && key) snProposed[key] = fc.proposed;
    }
  }
  if (Object.keys(snProposed).length) entity_data._sn_proposed = snProposed;
  const parts = [`[SN sync · ${proposal.action || 'changed'}] ${dec.reason}${conf}`];
  if (filled.length)   parts.push(`fills: ${filled.join(', ')}`);
  if (deferred.length) parts.push(`needs human: ${deferred.join(', ')}`);
  if (pl.sn_updated_by || pl.sn_updated_on)   // #86b: deterministic who/when for the human
    parts.push(`SN last changed by ${pl.sn_updated_by || 'unknown'} on ${pl.sn_updated_on || 'unknown'}`);
  if (proposal.rationale) parts.push(proposal.rationale);
  return {
    entity_type: etype, operation: 'update', entity_id: pl.wb_id,
    field_path: `${etype}.update`, old_value: before ? JSON.stringify(before) : null,
    new_value: JSON.stringify(entity_data),
    rationale: parts.join(' · '),
  };
}

// Resolve the request body + project row into the fully-formed opts runSyncPlan/estimateSyncWork
// need. Shared by the synchronous endpoint and the async job (#105) so both build the identical
// plan for identical input — no second, potentially-divergent parameter-resolution copy.
function resolveSyncOpts(project, body) {
  const scope = body.scope || project.servicenow_scope;
  if (!scope) return { error: { status: 400, message: 'Project is not linked to a ServiceNow scope (set servicenow_scope first).' } };
  const instance = body.instance || project.servicenow_instance || process.env.SN_INSTANCE;
  const user = body.user || project.sn_user              || process.env.SN_USER;
  const pw   = body.pw   || decryptField(project.sn_password_enc) || process.env.SN_PASSWORD;
  const artifacts = body.artifacts;   // test / pre-capture hook: skip the live REST pull
  if (!artifacts && (!instance || !user || !pw)) {
    return { error: { status: 400, message: 'ServiceNow credentials required (instance/user/pw in body, or SN_INSTANCE/SN_USER/SN_PASSWORD env).' } };
  }
  const modeOverride = body.mode;
  const thresholdOverride = typeof body.threshold === 'number' ? body.threshold : undefined;
  // Slice: an explicit body.slice wins (null forces whole-scope); otherwise the project's saved
  // import profile bounds the ingest to a subset of the scope. Absent ⇒ whole scope (legacy).
  let importSlice = null;
  if (body.slice !== undefined) importSlice = body.slice;
  else if (project.sn_import_profile_json) { try { importSlice = JSON.parse(project.sn_import_profile_json); } catch { importSlice = null; } }
  return { opts: { projectId: project.project_id, scope, instance, user, pw, artifacts, metadataSweep: body.metadataSweep, mode: modeOverride, threshold: thresholdOverride, slice: importSlice } };
}

/**
 * Run the full sync pipeline (plan + apply-unless-dryRun) and return {status, body} instead of
 * writing to `res` — shared by the synchronous endpoint (unchanged response contract, so the
 * ~10 existing test suites that call it directly keep working) and the async job (#105), which
 * additionally threads ctx.onProgress/cancelToken through to the AI stages.
 */
async function executeSyncRequest({ project, opts, dryRun, uid, ctx }) {
  let plan;
  try {
    plan = await snSync.runSyncPlan(opts, { projectId: project.project_id, ...ctx });
  } catch (err) {
    console.error('[sn-sync] plan failed:', err.message);
    return { status: 502, body: { error: `ServiceNow sync failed: ${err.message}` } };
  }
  const scope = opts.scope;

  // Serializable plan view (drop heavy artifact.salient).
  const planView = {
    project_id: plan.project_id, scope: plan.scope, slice: plan.slice || null, mode: plan.mode, threshold: plan.threshold,
    cancelled: !!plan.cancelled,   // #105 — the run was stopped early via the cancel button
    summary: plan.summary, classified_summary: plan.classified_summary, errors: plan.errors,
    warnings: plan.warnings || [], surface_counts: plan.surface_counts || {},
    completeness: plan.completeness || null,
    preflight: plan.preflight || null,
    materiality: plan.materiality || null,
    items: plan.planned.map(pl => ({
      classification: pl.classification, source_sys_id: pl.source_sys_id,
      name: (pl.inferred && pl.inferred.name) || (pl.proposal && pl.proposal.name) || (pl.artifact && pl.artifact.name) || null,
      wb_table: pl.wb_table || null, wb_id: pl.wb_id || null,
      action: pl.proposal && pl.proposal.action, destructive: !!(pl.proposal && pl.proposal.destructive),
      verdict: pl.review && pl.review.verdict, confidence: pl.review && pl.review.final_confidence,
      issues: (pl.review && pl.review.issues) || [],
      field_changes: (pl.proposal && pl.proposal.field_changes) || [],
      wb_edited_since_sync: !!pl.wb_edited_since_sync, wb_updated_at: pl.wb_updated_at || null,
      sn_unmoved: !!pl.sn_unmoved, sn_updated_by: pl.sn_updated_by || null, sn_updated_on: pl.sn_updated_on || null,
      decision: pl.decision,
    })),
  };
  if (dryRun) return { status: 200, body: { dry_run: true, plan: planView } };

  // ── Materialize: AUTO change packet (approved) + HITL packet (pending_review) ──
  const autoSpecs = [], hitlSpecs = [], dropped = [];
  for (const pl of plan.planned) {
    if (pl.decision.target === 'none') continue;          // no_change — nothing to record
    const spec = snPlanItemToCpSpec(pl, scope);
    if (!spec) { dropped.push({ source_sys_id: pl.source_sys_id, name: (pl.inferred && pl.inferred.name) || null, reason: 'not materializable (type=other / unmapped)' }); continue; }
    (pl.decision.target === 'auto' ? autoSpecs : hitlSpecs).push(spec);
  }

  const insertSyncCp = (specs, status, label) => {
    const cpId = generateId();
    const cpCode = uniquePacketCode();
    const summary = `SN to WB synch — ${label} (${specs.length} item${specs.length === 1 ? '' : 's'} from ${scope})`;
    db.prepare(`
      INSERT INTO asdlc_change_packet
        (change_packet_id, project_id, packet_code, status, summary, source_timestamp,
         conflict_classification, risk_level, recommended_action, cp_origin, visibility_scope, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,datetime('now'),?,?,?, 'sn_inbound', 'PROJECT', ?, datetime('now'), datetime('now'))
    `).run(cpId, project.project_id, cpCode, status, summary, 'modifies_existing', 'med',
           status === 'approved' ? 'apply' : 'review', uid);
    const ins = db.prepare(`
      INSERT INTO asdlc_change_packet_item
        (change_packet_item_id, change_packet_id, entity_type, entity_id, operation, field_path, old_value, new_value, rationale, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`);
    for (const s of specs) ins.run(generateId(), cpId, s.entity_type, s.entity_id, s.operation, s.field_path, s.old_value, s.new_value, s.rationale);
    auditLog('asdlc_change_packet', cpId, 'INSERT', null, { packet_code: cpCode, source: 'sn_sync', item_count: specs.length }, uid);
    return { change_packet_id: cpId, packet_code: cpCode, item_count: specs.length };
  };

  const result = { auto_cp: null, hitl_cp: null, hash_advanced: 0, links_healed: 0, dropped };

  // 1. HITL packet (pending_review) — surfaced in the Change Packet Queue, never auto-applied.
  if (hitlSpecs.length) result.hitl_cp = insertSyncCp(hitlSpecs, 'pending_review', 'needs human review');

  // 2. AUTO packet — create then approve+materialize via the shared core (stores source_hash).
  if (autoSpecs.length) {
    const cp = insertSyncCp(autoSpecs, 'pending_review', 'auto-applied (safe additive)');
    try {
      const r = approveAndApplyCp(cp.change_packet_id, uid, { decision_notes: 'Auto-applied by ServiceNow sync — safe additive, reviewer-approved, above confidence threshold.' });
      result.auto_cp = { ...cp, apply_result: r.applyResult };
    } catch (err) {
      console.error('[sn-sync] auto-apply failed:', err.message);
      return { status: 500, body: { error: `Auto-apply failed: ${err.message}`, plan: planView, result } };
    }
  }

  // 3. Advance source_hash on `changed`→no_change rows (content already matches this SN
  //    version) so they classify as tier-0 "unchanged" next sync. Pure provenance write —
  //    no content change, non-destructive. (new/enrich rows get their hash via the CP above.)
  //    #85: the hash must never claim a currency the stored snapshot doesn't have — refresh
  //    the last-seen SN body (source_fluent, the Tier-3 "as built" snapshot written at apply
  //    time) alongside it, and keep the generic twin's provenance in lockstep so the two
  //    rows for one sys_id never disagree about which SN version was last synced.
  for (const pl of plan.planned) {
    if (pl.classification !== 'changed' || pl.decision.target !== 'none' || !pl.artifact) continue;
    const etype = snSync.TYPE_BY_WB_TABLE[pl.wb_table];
    const entity = etype && registry.byEntityType[etype];
    if (!entity) continue;
    const row = mtRow(entity.table, entity.pk, pl.wb_id);
    if (!row || row.source_hash === pl.artifact.hash) continue;
    const snapshot = snArtifactBody(pl.artifact);   // null-safe: keeps the old snapshot when capture had no salient
    db.prepare(`UPDATE ${entity.table} SET source_hash=?, source_fluent=COALESCE(?, source_fluent), source_system=COALESCE(source_system,'servicenow'), source_scope=COALESCE(source_scope,?), updated_at=datetime('now') WHERE ${entity.pk}=?`)
      .run(pl.artifact.hash, snapshot, scope, pl.wb_id);
    auditLog(entity.table, pl.wb_id, 'UPDATE',
      { source_hash: row.source_hash },
      { source_hash: pl.artifact.hash, source_fluent_refreshed: !!snapshot }, uid);
    if (pl.artifact.source_sys_id) {
      try {
        db.prepare(`UPDATE asdlc_sn_artifact SET source_hash=?, source_fluent=COALESCE(?, source_fluent), updated_at=datetime('now')
                    WHERE project_id=? AND source_sys_id=? AND (source_hash IS NULL OR source_hash != ?)`)
          .run(pl.artifact.hash, snapshot, project.project_id, pl.artifact.source_sys_id, pl.artifact.hash);
      } catch { /* no twin — nothing to keep in lockstep */ }
    }
    result.hash_advanced++;
  }

  // 3b. #86b: refresh the stored hash+snapshot for GENERIC artifacts whose ServiceNow copy
  //     was UNMOVED (sys_mod_count stable) but whose capture-formula hash drifted, so they
  //     classify tier-0 next cycle. The rich loop above already covers Tier-A twins via
  //     TYPE_BY_WB_TABLE; a pure generic (no L1 twin) is handled here. Non-destructive —
  //     only provenance moves; keep source_hash↔payload consistent (hash is over payload).
  for (const pl of plan.planned) {
    if (!pl.generic || !pl.sn_unmoved || !pl.decision || pl.decision.target !== 'none' || !pl.artifact) continue;
    const a = pl.artifact;
    if (!a.source_sys_id || !a.hash) continue;
    try {
      const body = JSON.stringify(a.payload || a.salient || {});
      const r = db.prepare(`UPDATE asdlc_sn_artifact SET source_hash=?, payload=?, updated_at=datetime('now')
                            WHERE project_id=? AND source_sys_id=? AND (source_hash IS NULL OR source_hash != ?)`)
        .run(a.hash, body, project.project_id, a.source_sys_id, a.hash);
      if (r.changes) result.hash_advanced++;
    } catch { /* no twin row — nothing to advance */ }
  }

  // 4. R1 LINK SELF-HEAL. A Workbench-authored entity deployed to SN and re-captured
  //    matches here either by its sys_id (already linked) or by its embedded
  //    [[wb:project/slug]] tag (classifyArtifacts → findWbBySlug). The tag match heals
  //    source_hash but historically NOT source_sys_id — so the next outbound delta still
  //    saw NULL → POST → duplicate. Back-fill source_sys_id for any matched row that lacks
  //    it. Safe: classifyArtifacts only slug-matches on a QUALIFIED tag within this project,
  //    and we write the sys_id of the very record that carried the tag. `IS NULL` guard
  //    makes it a no-op for already-linked rows (never overwrites a different sys_id).
  const healSeen = new Set();
  const healCandidates = [];
  for (const u of (plan.unchanged || [])) {
    if (u && u.wb_table && u.wb_id && u.source_sys_id)
      healCandidates.push({ wb_table: u.wb_table, wb_id: u.wb_id, sys_id: u.source_sys_id, source_table: u.source_table || null });
  }
  for (const pl of plan.planned) {
    if (pl.classification === 'drift' || !pl.wb_table || !pl.wb_id) continue;
    const sid = pl.source_sys_id || (pl.artifact && pl.artifact.source_sys_id);
    if (sid) healCandidates.push({ wb_table: pl.wb_table, wb_id: pl.wb_id, sys_id: sid, source_table: (pl.artifact && pl.artifact.source_table) || null });
  }
  for (const c of healCandidates) {
    const key = `${c.wb_table}:${c.wb_id}`;
    if (healSeen.has(key)) continue;
    healSeen.add(key);
    const pk = PK_BY_WB_TABLE[c.wb_table];
    if (!pk) continue;
    try {
      const r = db.prepare(
        `UPDATE ${c.wb_table}
            SET source_sys_id = ?, source_table = COALESCE(source_table, ?),
                source_scope = COALESCE(source_scope, ?), updated_at = datetime('now')
          WHERE ${pk} = ? AND project_id = ? AND (source_sys_id IS NULL OR source_sys_id = '')`
      ).run(c.sys_id, c.source_table, scope, c.wb_id, project.project_id);
      if (r.changes) {
        auditLog(c.wb_table, c.wb_id, 'sn_link_selfheal', { source_sys_id: null }, { source_sys_id: c.sys_id }, uid);
        result.links_healed++;
      }
    } catch { /* table without provenance columns — skip */ }
  }

  // #86b: record each swept record's sys_mod_count / who / when so the NEXT sync can tell a
  // real ServiceNow change from our own capture-formula drift (and name who/when in conflicts).
  // Only on a real apply (never dry-run), and only when the sweep actually ran.
  try {
    const n = persistChangeSignals(project.project_id, plan.sn_signals || []);
    if (n) result.signals_recorded = n;
  } catch (e) { console.error('[sn-sync] persistChangeSignals', e.message); }

  try { require('./agent/fluent-ingest').markSynced(project.project_id); } catch (e) { console.error('[sn-sync] markSynced', e.message); }
  return { status: 200, body: { dry_run: false, plan: planView, result } };
}

app.post('/api/v1/projects/:id/servicenow/sync', async (req, res) => {
  const uid = userId(req);
  const project = db.prepare(
    "SELECT * FROM asdlc_project WHERE project_id=? AND (lifecycle_status IS NULL OR lifecycle_status!='retired')"
  ).get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const body = req.body || {};
  const resolved = resolveSyncOpts(project, body);
  if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
  const dryRun = req.query.dry_run === '1' || body.dry_run === true;

  const r = await executeSyncRequest({ project, opts: resolved.opts, dryRun, uid });
  res.status(r.status).json(r.body);
});

// ── #105: pre-flight cost/time estimate — capture + classify only, NO AI spend ──────────────
// A dry run is NOT free: it runs the same AI stages as a real run and only skips the DB write.
// This lets the UI tell the user what a Preview/Run will cost BEFORE either one starts.
app.post('/api/v1/projects/:id/servicenow/sync/estimate', async (req, res) => {
  const project = db.prepare(
    "SELECT * FROM asdlc_project WHERE project_id=? AND (lifecycle_status IS NULL OR lifecycle_status!='retired')"
  ).get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const body = req.body || {};
  const resolved = resolveSyncOpts(project, body);
  if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });

  try {
    const est = await snSync.estimateSyncWork(resolved.opts);
    // Cache the just-captured artifacts/sweep so the subsequent async start doesn't have to
    // re-read ServiceNow a second time for the same data (best-effort — a short-lived slot per
    // project; the async start falls back to a fresh live capture if this has expired/missed).
    lastSyncCapture.set(project.project_id, { artifacts: est.artifacts, metadataSweep: est.metadataSweep, ts: Date.now() });
    const { artifacts, metadataSweep, ...estView } = est;
    res.json(estView);
  } catch (err) {
    console.error('[sn-sync] estimate failed:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── #105: async sync job — start / poll / cancel ────────────────────────────────────────────
// ADDITIVE ONLY: the synchronous POST .../sync endpoint above is UNCHANGED (existing tests and
// scripts keep working). This is a separate, in-memory-tracked background job the frontend uses
// to show a live progress meter and offer a cancel button on long-running Preview/Run calls.
const syncJobs = new Map();          // job_id -> {status, progress, planView, result, error, cancelToken, projectId}
const lastSyncCapture = new Map();   // project_id -> {artifacts, metadataSweep, ts} — from the last /estimate call
const SYNC_CAPTURE_TTL_MS = 10 * 60 * 1000;   // 10 min — long enough to read an estimate and click Start

app.post('/api/v1/projects/:id/servicenow/sync/async', async (req, res) => {
  const uid = userId(req);
  const project = db.prepare(
    "SELECT * FROM asdlc_project WHERE project_id=? AND (lifecycle_status IS NULL OR lifecycle_status!='retired')"
  ).get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const body = { ...(req.body || {}) };

  // Reuse the most recent /estimate capture for this project if it's fresh and the caller
  // didn't already supply artifacts explicitly — avoids a second live ServiceNow read, and
  // (must happen BEFORE resolveSyncOpts) lets the request succeed on cached data even without
  // live credentials in the body, exactly as an immediately-following /estimate call would.
  if (!body.artifacts) {
    const cached = lastSyncCapture.get(project.project_id);
    if (cached && (Date.now() - cached.ts) < SYNC_CAPTURE_TTL_MS) {
      body.artifacts = cached.artifacts;
      body.metadataSweep = cached.metadataSweep;
    }
  }

  const resolved = resolveSyncOpts(project, body);
  if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
  const dryRun = req.query.dry_run === '1' || body.dry_run === true;
  const opts = resolved.opts;

  const jobId = generateId();
  const cancelToken = { cancelled: false };
  const job = { job_id: jobId, project_id: project.project_id, status: 'running', dry_run: dryRun,
    progress: { stage: 'capturing', current: 0, total: 0 }, planView: null, result: null, error: null,
    cancelToken, startedAt: new Date().toISOString() };
  syncJobs.set(jobId, job);
  res.status(202).json({ job_id: jobId, status: 'running' });

  // Fire-and-forget — the same executeSyncRequest the synchronous endpoint uses, so behavior
  // (gating, materialization, audit) is identical; only progress/cancel plumbing is added.
  (async () => {
    try {
      const ctx = {
        cancelToken,
        onProgress: (p) => { job.progress = p; },
      };
      const r = await executeSyncRequest({ project, opts, dryRun, uid, ctx });
      job.status = cancelToken.cancelled ? 'cancelled' : (r.status === 200 ? 'complete' : 'failed');
      job.planView = (r.body && r.body.plan) || null;
      job.result = (r.body && r.body.result) || null;
      if (r.status !== 200) job.error = (r.body && r.body.error) || `HTTP ${r.status}`;
    } catch (err) {
      job.status = 'failed';
      job.error = err.message;
      console.error('[sn-sync async]', err.message);
    }
  })();
});

app.get('/api/v1/projects/:id/servicenow/sync/async/:jobId', (req, res) => {
  const job = syncJobs.get(req.params.jobId);
  if (!job || job.project_id !== req.params.id) return res.status(404).json({ error: 'Sync job not found' });
  const { cancelToken, ...view } = job;
  res.json(view);
});

app.post('/api/v1/projects/:id/servicenow/sync/async/:jobId/cancel', (req, res) => {
  const job = syncJobs.get(req.params.jobId);
  if (!job || job.project_id !== req.params.id) return res.status(404).json({ error: 'Sync job not found' });
  if (job.status !== 'running') return res.json({ job_id: job.job_id, status: job.status, note: 'already finished — nothing to cancel' });
  job.cancelToken.cancelled = true;   // cooperative — the running loop checks this before its next item
  res.json({ job_id: job.job_id, status: 'cancelling' });
});

/** Extract a human-readable label from entity_data based on entity_type */
function getEntityLabel(type, data) {
  if (!data) return type;
  return data.use_case_name || data.workflow_name || data.step_name ||
         data.rule_name || data.want || data.segment_name ||
         data.source_name || data.agent_name || data.gate_name ||
         data.control_name || data.story_title || type;
}

// ──────────────────────────────────────────────
// INGEST DOCUMENTS
// ──────────────────────────────────────────────
app.get('/api/v1/ingest-documents', (req, res) => {
  const { project_id, status, include_cancelled, archived } = req.query;
  if (!project_id) return res.status(400).json({ error: 'project_id is required' });
  let sql = `
    SELECT d.*, u.display_name AS uploaded_by_name, c.display_name AS cancelled_by_name, p.project_name
    FROM asdlc_ingest_document d
    LEFT JOIN asdlc_user u ON d.uploaded_by = u.user_id
    LEFT JOIN asdlc_user c ON d.cancelled_by = c.user_id
    LEFT JOIN asdlc_project p ON d.project_id = p.project_id
    WHERE d.project_id = ?
  `;
  const params = [project_id];
  if (status)     { sql += ' AND d.ingest_status = ?'; params.push(status); }
  // Lifecycle filter: default = active only. ?archived=1 → cancelled only.
  // ?include_cancelled=1 → both (no lifecycle filter).
  const truthy = v => v === '1' || v === 'true';
  if (truthy(archived)) {
    sql += " AND d.lifecycle_status = 'cancelled'";
  } else if (!truthy(include_cancelled)) {
    sql += " AND d.lifecycle_status = 'active'";
  }
  sql += ' ORDER BY d.uploaded_at DESC';
  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

app.get('/api/v1/ingest-documents/:id', (req, res) => {
  const row = db.prepare(`
    SELECT d.*, u.display_name AS uploaded_by_name, c.display_name AS cancelled_by_name, p.project_name
    FROM asdlc_ingest_document d
    LEFT JOIN asdlc_user u ON d.uploaded_by = u.user_id
    LEFT JOIN asdlc_user c ON d.cancelled_by = c.user_id
    LEFT JOIN asdlc_project p ON d.project_id = p.project_id
    WHERE d.ingest_id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

/**
 * GET /api/v1/ingest-documents/:id/content
 * Returns the raw text of an ingested document for the source viewer.
 * Reads from raw_text column if populated; otherwise reads from file_path and caches it.
 */
app.get('/api/v1/ingest-documents/:id/content', (req, res) => {
  const doc = db.prepare('SELECT * FROM asdlc_ingest_document WHERE ingest_id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });

  // Use cached raw_text if available
  if (doc.raw_text) {
    return res.json({
      ingest_id:      doc.ingest_id,
      document_title: doc.document_title || doc.file_name,
      file_name:      doc.file_name,
      file_type:      doc.file_type,
      content:        doc.raw_text,
    });
  }

  // Fall back to reading file_path
  if (!doc.file_path) {
    return res.status(404).json({ error: 'No content available — document was not stored with a file path' });
  }

  let content;
  try {
    content = fs.readFileSync(doc.file_path, 'utf8');
  } catch (e) {
    return res.status(404).json({ error: `File not readable: ${e.message}` });
  }

  // Cache in raw_text for subsequent requests
  try {
    db.prepare('UPDATE asdlc_ingest_document SET raw_text = ? WHERE ingest_id = ?')
      .run(content, doc.ingest_id);
  } catch { /* non-fatal — serve from file each time if caching fails */ }

  res.json({
    ingest_id:      doc.ingest_id,
    document_title: doc.document_title || doc.file_name,
    file_name:      doc.file_name,
    file_type:      doc.file_type,
    content,
  });
});

// Stream the original uploaded file as an attachment (fallback for binary docs).
app.get('/api/v1/ingest-documents/:id/download', (req, res) => {
  const doc = db.prepare('SELECT * FROM asdlc_ingest_document WHERE ingest_id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  if (!doc.file_path) return res.status(404).json({ error: 'No file attached to this document' });
  const fileName = doc.file_name || path.basename(doc.file_path);
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.sendFile(path.resolve(doc.file_path), err => {
    if (err && !res.headersSent) res.status(404).json({ error: `File not readable: ${err.message}` });
  });
});

// POST supports both JSON (metadata only) and multipart/form-data (with file).
// The frontend sends multipart when a file is attached.
app.post('/api/v1/ingest-documents', upload.single('file'), (req, res) => {
  const uid = userId(req);

  // Field values come from req.body regardless of content-type
  const project_id     = req.body.project_id;
  const document_title = req.body.document_title;
  const file_type      = req.body.file_type || (req.file ? path.extname(req.file.originalname).slice(1).toLowerCase() : null);
  const file_name      = req.body.file_name  || (req.file ? req.file.originalname : null);
  const document_type  = req.body.document_type  || 'other';
  const description    = req.body.description    || null;
  const file_path      = req.file ? req.file.path : null;
  // raw_text may be supplied directly (requirements update panel — no file attachment)
  const raw_text       = req.body.raw_text || null;
  // AI mode dial: faithful | balanced (default) | suggestive. Anything else → balanced.
  const enrichment_level = ['faithful','balanced','suggestive'].includes(req.body.enrichment_level)
    ? req.body.enrichment_level : 'balanced';

  if (!project_id || !document_title) {
    if (req.file) require('fs').unlinkSync(req.file.path);   // clean up orphan
    return res.status(400).json({ error: 'project_id and document_title are required' });
  }

  // ── Guard foreign keys so a stale client value can't throw an opaque
  //    "FOREIGN KEY constraint failed". project_id must exist; a stale/unknown
  //    uploaded_by (e.g. a user_id cached from an older DB) is downgraded to NULL
  //    rather than blocking the upload.
  const projExists = db.prepare('SELECT 1 FROM asdlc_project WHERE project_id = ?').get(project_id);
  if (!projExists) {
    if (req.file) require('fs').unlinkSync(req.file.path);
    return res.status(400).json({ error: `Unknown project_id "${project_id}". Re-select the application and try again.` });
  }
  const uploadedBy = (uid && db.prepare('SELECT 1 FROM asdlc_user WHERE user_id = ?').get(uid)) ? uid : null;
  if (uid && !uploadedBy) {
    console.warn(`[ingest-documents] uploaded_by "${uid}" is not a known user — storing NULL. The current profile may be stale; re-pick a user.`);
  }

  // Per-document platform tag; null = inherit the project's target_platform.
  const platform = ['servicenow', 'generic'].includes(req.body.platform) ? req.body.platform : null;
  const id = generateId();
  db.prepare(`
    INSERT INTO asdlc_ingest_document
      (ingest_id, project_id, document_title, file_name, file_type, document_type,
       description, ingest_status, enrichment_level, platform, uploaded_by, file_path, raw_text,
       uploaded_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,'pending',?,?,?,?,?,datetime('now'),datetime('now'),datetime('now'))
  `).run(id, project_id, document_title, file_name, file_type,
         document_type, description, enrichment_level, platform, uploadedBy, file_path, raw_text);

  auditLog('asdlc_ingest_document', id, 'INSERT', null,
    { project_id, document_title, file_name, document_type }, uploadedBy);

  const created = db.prepare(`
    SELECT d.*, u.display_name AS uploaded_by_name, p.project_name
    FROM asdlc_ingest_document d
    LEFT JOIN asdlc_user u ON d.uploaded_by = u.user_id
    LEFT JOIN asdlc_project p ON d.project_id = p.project_id
    WHERE d.ingest_id = ?
  `).get(id);
  res.status(201).json(created);
});

app.put('/api/v1/ingest-documents/:id', (req, res) => {
  const uid = userId(req);
  const row = db.prepare('SELECT * FROM asdlc_ingest_document WHERE ingest_id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { ingest_status, processing_notes, change_packets_generated } = req.body;
  const updates = {};
  if (ingest_status !== undefined) updates.ingest_status = ingest_status;
  if (processing_notes !== undefined) updates.processing_notes = processing_notes;
  if (change_packets_generated !== undefined) updates.change_packets_generated = change_packets_generated;
  if (Object.keys(updates).length === 0) return res.json(row);
  const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE asdlc_ingest_document SET ${sets}, updated_at = datetime('now') WHERE ingest_id = ?`)
    .run(...Object.values(updates), req.params.id);
  auditLog('asdlc_ingest_document', req.params.id, 'UPDATE', row, updates, uid);
  res.json(db.prepare('SELECT * FROM asdlc_ingest_document WHERE ingest_id = ?').get(req.params.id));
});

// Soft-cancel an ingest document (reversible). Allowed any time BEFORE promote.
// A cancelled doc drops out of the default list and all mutating endpoints refuse,
// which effectively voids its staged extractions + open clarifications until restored.
app.post('/api/v1/ingest-documents/:id/cancel', (req, res) => {
  const uid = userId(req);
  const row = db.prepare('SELECT * FROM asdlc_ingest_document WHERE ingest_id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.lifecycle_status === 'cancelled') return res.status(409).json({ error: 'Document is already cancelled' });
  if (row.ingest_status === 'promoted') {
    return res.status(409).json({ error: 'Promoted documents cannot be cancelled — their design has already been turned into a Change Packet.' });
  }
  const reason = (req.body && req.body.reason ? String(req.body.reason).trim() : '') || null;
  db.prepare(`
    UPDATE asdlc_ingest_document
    SET lifecycle_status='cancelled', cancelled_at=datetime('now'), cancelled_by=?, cancel_reason=?,
        updated_at=datetime('now')
    WHERE ingest_id=?
  `).run(uid, reason, req.params.id);
  const after = db.prepare('SELECT * FROM asdlc_ingest_document WHERE ingest_id = ?').get(req.params.id);
  auditLog('asdlc_ingest_document', req.params.id, 'UPDATE', row, after, uid);
  res.json(after);
});

// Restore (un-cancel) a soft-cancelled ingest document.
app.post('/api/v1/ingest-documents/:id/restore', (req, res) => {
  const uid = userId(req);
  const row = db.prepare('SELECT * FROM asdlc_ingest_document WHERE ingest_id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.lifecycle_status !== 'cancelled') return res.status(409).json({ error: 'Document is not cancelled' });
  db.prepare(`
    UPDATE asdlc_ingest_document
    SET lifecycle_status='active', cancelled_at=NULL, cancelled_by=NULL, cancel_reason=NULL,
        updated_at=datetime('now')
    WHERE ingest_id=?
  `).run(req.params.id);
  const after = db.prepare('SELECT * FROM asdlc_ingest_document WHERE ingest_id = ?').get(req.params.id);
  auditLog('asdlc_ingest_document', req.params.id, 'UPDATE', row, after, uid);
  res.json(after);
});

// ──────────────────────────────────────────────
// REQUIREMENTS (Functional & Non-Functional)
// ──────────────────────────────────────────────

const FR_JSON_FIELDS  = ['actors', 'acceptance_criteria', 'dependencies'];
const NFR_JSON_FIELDS = ['dependencies'];
const REQ_STATUS_VALS = ['draft', 'approved', 'implemented', 'verified', 'deleted'];
const REQ_PRIORITY_VALS = ['must_have', 'should_have', 'could_have', 'wont_have'];

function parseReqRow(row) {
  if (!row) return row;
  const out = { ...row, is_orphan: row.use_case_id == null };
  const jsonFields = row.fr_id ? FR_JSON_FIELDS : NFR_JSON_FIELDS;
  for (const f of jsonFields) {
    if (out[f] && typeof out[f] === 'string') {
      try { out[f] = JSON.parse(out[f]); } catch { /* leave as string */ }
    }
  }
  return out;
}

function insertReqChangeLog(reqType, reqId, projectId, action, note, changedBy) {
  const logId = generateId();
  db.prepare(`INSERT INTO asdlc_requirement_change_log
    (log_id, req_type, req_id, project_id, action, note, changed_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(logId, reqType, reqId, projectId, action, note || '', changedBy || 'system');
}

// ── Functional Requirements ──────────────────────────────────────

app.get('/api/v1/projects/:id/functional-reqs', (req, res) => {
  const includeDeleted = req.query.include_deleted === '1';
  const whereClause = includeDeleted
    ? 'WHERE fr.project_id = ?'
    : "WHERE fr.project_id = ? AND fr.status != 'deleted'";
  const rows = db.prepare(`
    SELECT fr.*, uc.slug AS use_case_slug, uc.title AS use_case_title
    FROM asdlc_functional_req fr
    LEFT JOIN asdlc_use_case uc ON fr.use_case_id = uc.use_case_id
    ${whereClause}
    ORDER BY fr.slug ASC, fr.created_at ASC
  `).all(req.params.id);
  res.json(rows.map(parseReqRow));
});

app.get('/api/v1/projects/:id/functional-reqs/:frId', (req, res) => {
  const row = db.prepare(`
    SELECT fr.*, uc.slug AS use_case_slug, uc.title AS use_case_title
    FROM asdlc_functional_req fr
    LEFT JOIN asdlc_use_case uc ON fr.use_case_id = uc.use_case_id
    WHERE fr.fr_id = ? AND fr.project_id = ?
  `).get(req.params.frId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Functional requirement not found' });
  const changeLog = db.prepare(
    "SELECT * FROM asdlc_requirement_change_log WHERE req_type='functional' AND req_id=? ORDER BY created_at ASC"
  ).all(req.params.frId);
  // AC/TC counts for traceability links in the Requirements UI
  const acCount = db.prepare(
    "SELECT COUNT(*) AS c FROM asdlc_acceptance_criterion WHERE req_slug=? AND project_id=? AND lifecycle_status='active'"
  ).get(row.slug, req.params.id).c || 0;
  const tcCount = db.prepare(
    "SELECT COUNT(*) AS c FROM asdlc_test_case WHERE requirement_ids LIKE ? AND project_id=? AND lifecycle_status='active'"
  ).get(`%${row.slug}%`, req.params.id).c || 0;
  res.json({ ...parseReqRow(row), change_log: changeLog, ac_count: acCount, tc_count: tcCount });
});

function createFunctionalReq(projectId, body, uid) {
  const { title, description, actors, preconditions, postconditions, priority,
          acceptance_criteria, dependencies, source, status, use_case_id, ingest_id } = body;
  if (!title) throw new Error('title is required');
  if (priority && !REQ_PRIORITY_VALS.includes(priority))
    throw new Error(`priority must be one of: ${REQ_PRIORITY_VALS.join(', ')}`);
  if (status && !REQ_STATUS_VALS.includes(status))
    throw new Error(`status must be one of: ${REQ_STATUS_VALS.join(', ')}`);
  const id   = generateId();
  const slug = nextSlug('asdlc_functional_req', 'FR', projectId);
  db.prepare(`INSERT INTO asdlc_functional_req
    (fr_id, project_id, use_case_id, ingest_id, slug, title, description, actors,
     preconditions, postconditions, priority, acceptance_criteria, dependencies,
     source, status, created_by, updated_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      id, projectId, use_case_id || null, ingest_id || null, slug,
      title, description || '', JSON.stringify(actors || []),
      preconditions || '', postconditions || '',
      priority || 'must_have',
      JSON.stringify(acceptance_criteria || []),
      JSON.stringify(dependencies || []),
      source || '', status || 'draft', uid, uid
    );
  const created = db.prepare('SELECT * FROM asdlc_functional_req WHERE fr_id = ?').get(id);
  auditLog('asdlc_functional_req', id, 'INSERT', null, created, uid);
  insertReqChangeLog('functional', id, projectId, 'Added', `Created: ${title}`, uid);
  return parseReqRow(created);
}

app.post('/api/v1/projects/:id/functional-reqs', (req, res) => {
  const uid = userId(req);
  try {
    const created = createFunctionalReq(req.params.id, req.body, uid);
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/v1/projects/:id/functional-reqs/bulk', (req, res) => {
  const uid = userId(req);
  const items = Array.isArray(req.body) ? req.body : req.body.items;
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: 'Body must be an array or { items: [...] }' });
  const results = [], errors = [];
  for (let i = 0; i < items.length; i++) {
    try {
      results.push(createFunctionalReq(req.params.id, items[i], uid));
    } catch (err) {
      errors.push({ index: i, error: err.message });
    }
  }
  res.status(errors.length && results.length === 0 ? 400 : 207)
     .json({ created: results, errors });
});

app.put('/api/v1/projects/:id/functional-reqs/:frId', (req, res) => {
  const uid = userId(req);
  const existing = db.prepare('SELECT * FROM asdlc_functional_req WHERE fr_id = ? AND project_id = ?')
    .get(req.params.frId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Functional requirement not found' });
  if (existing.status === 'deleted')
    return res.status(400).json({ error: 'Cannot modify a deleted requirement' });

  const ALLOWED = ['title','description','actors','preconditions','postconditions',
                   'priority','acceptance_criteria','dependencies','source','status','use_case_id','ingest_id'];
  const updates = {};
  for (const f of ALLOWED) { if (req.body[f] !== undefined) updates[f] = req.body[f]; }

  if (updates.priority && !REQ_PRIORITY_VALS.includes(updates.priority))
    return res.status(400).json({ error: `priority must be one of: ${REQ_PRIORITY_VALS.join(', ')}` });
  if (updates.status && !REQ_STATUS_VALS.includes(updates.status))
    return res.status(400).json({ error: `status must be one of: ${REQ_STATUS_VALS.join(', ')}` });

  for (const f of FR_JSON_FIELDS) {
    if (updates[f] !== undefined && typeof updates[f] !== 'string')
      updates[f] = JSON.stringify(updates[f]);
  }

  const isDeleting = updates.status === 'deleted' && existing.status !== 'deleted';
  if (isDeleting) updates.deleted_at = "datetime('now')";

  if (Object.keys(updates).length === 0) return res.json(parseReqRow(existing));

  // Build SET clause — deleted_at needs to call datetime('now') as SQL, not a bind param
  const regularUpdates = { ...updates };
  delete regularUpdates.deleted_at;
  const setClauses = Object.keys(regularUpdates).map(f => `${f} = ?`).join(', ');
  const deletedAtClause = isDeleting ? ", deleted_at = datetime('now')" : '';
  db.prepare(`UPDATE asdlc_functional_req SET ${setClauses}${deletedAtClause},
    updated_at = datetime('now'), updated_by = ?, version = version + 1
    WHERE fr_id = ?`)
    .run(...Object.values(regularUpdates), uid, req.params.frId);

  const after = db.prepare('SELECT * FROM asdlc_functional_req WHERE fr_id = ?').get(req.params.frId);
  auditLog('asdlc_functional_req', req.params.frId, 'UPDATE', existing, after, uid);

  const logAction = isDeleting ? 'Deleted' : 'Modified';
  const logNote   = req.body.change_note || (isDeleting ? `Marked deleted` : `Updated fields: ${Object.keys(regularUpdates).join(', ')}`);
  insertReqChangeLog('functional', req.params.frId, req.params.id, logAction, logNote, uid);

  // Trigger an AI quality review (debounced, gated on material-field changes).
  const reviewQueued = !isDeleting && reviewQueue.maybeEnqueueReview({
    projectId: req.params.id, entityType: 'functional_req', entityId: req.params.frId,
    changedFields: Object.keys(regularUpdates),
  });

  const changeLog = db.prepare(
    "SELECT * FROM asdlc_requirement_change_log WHERE req_type='functional' AND req_id=? ORDER BY created_at ASC"
  ).all(req.params.frId);
  res.json({ ...parseReqRow(after), change_log: changeLog, _review_queued: reviewQueued });
});

// ── Non-Functional Requirements ──────────────────────────────────

app.get('/api/v1/projects/:id/nonfunctional-reqs', (req, res) => {
  const includeDeleted = req.query.include_deleted === '1';
  const whereClause = includeDeleted
    ? 'WHERE nfr.project_id = ?'
    : "WHERE nfr.project_id = ? AND nfr.status != 'deleted'";
  const rows = db.prepare(`
    SELECT nfr.*, uc.slug AS use_case_slug, uc.title AS use_case_title
    FROM asdlc_nonfunctional_req nfr
    LEFT JOIN asdlc_use_case uc ON nfr.use_case_id = uc.use_case_id
    ${whereClause}
    ORDER BY nfr.slug ASC, nfr.created_at ASC
  `).all(req.params.id);
  res.json(rows.map(parseReqRow));
});

app.get('/api/v1/projects/:id/nonfunctional-reqs/:nfrId', (req, res) => {
  const row = db.prepare(`
    SELECT nfr.*, uc.slug AS use_case_slug, uc.title AS use_case_title
    FROM asdlc_nonfunctional_req nfr
    LEFT JOIN asdlc_use_case uc ON nfr.use_case_id = uc.use_case_id
    WHERE nfr.nfr_id = ? AND nfr.project_id = ?
  `).get(req.params.nfrId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Non-functional requirement not found' });
  const changeLog = db.prepare(
    "SELECT * FROM asdlc_requirement_change_log WHERE req_type='nonfunctional' AND req_id=? ORDER BY created_at ASC"
  ).all(req.params.nfrId);
  const acCount = db.prepare(
    "SELECT COUNT(*) AS c FROM asdlc_acceptance_criterion WHERE req_slug=? AND project_id=? AND lifecycle_status='active'"
  ).get(row.slug, req.params.id).c || 0;
  const tcCount = db.prepare(
    "SELECT COUNT(*) AS c FROM asdlc_test_case WHERE requirement_ids LIKE ? AND project_id=? AND lifecycle_status='active'"
  ).get(`%${row.slug}%`, req.params.id).c || 0;
  res.json({ ...parseReqRow(row), change_log: changeLog, ac_count: acCount, tc_count: tcCount });
});

function createNonfunctionalReq(projectId, body, uid) {
  const { title, category, description, measurable_target, verification_method,
          priority, dependencies, source, status, use_case_id, ingest_id } = body;
  if (!title) throw new Error('title is required');
  if (priority && !REQ_PRIORITY_VALS.includes(priority))
    throw new Error(`priority must be one of: ${REQ_PRIORITY_VALS.join(', ')}`);
  if (status && !REQ_STATUS_VALS.includes(status))
    throw new Error(`status must be one of: ${REQ_STATUS_VALS.join(', ')}`);
  const id   = generateId();
  const slug = nextSlug('asdlc_nonfunctional_req', 'NFR', projectId);
  db.prepare(`INSERT INTO asdlc_nonfunctional_req
    (nfr_id, project_id, use_case_id, ingest_id, slug, title, category, description,
     measurable_target, verification_method, priority, dependencies,
     source, status, created_by, updated_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      id, projectId, use_case_id || null, ingest_id || null, slug,
      title, category || '', description || '',
      measurable_target || '', verification_method || '',
      priority || 'must_have',
      JSON.stringify(dependencies || []),
      source || '', status || 'draft', uid, uid
    );
  const created = db.prepare('SELECT * FROM asdlc_nonfunctional_req WHERE nfr_id = ?').get(id);
  auditLog('asdlc_nonfunctional_req', id, 'INSERT', null, created, uid);
  insertReqChangeLog('nonfunctional', id, projectId, 'Added', `Created: ${title}`, uid);
  return parseReqRow(created);
}

app.post('/api/v1/projects/:id/nonfunctional-reqs', (req, res) => {
  const uid = userId(req);
  try {
    const created = createNonfunctionalReq(req.params.id, req.body, uid);
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/v1/projects/:id/nonfunctional-reqs/bulk', (req, res) => {
  const uid = userId(req);
  const items = Array.isArray(req.body) ? req.body : req.body.items;
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: 'Body must be an array or { items: [...] }' });
  const results = [], errors = [];
  for (let i = 0; i < items.length; i++) {
    try {
      results.push(createNonfunctionalReq(req.params.id, items[i], uid));
    } catch (err) {
      errors.push({ index: i, error: err.message });
    }
  }
  res.status(errors.length && results.length === 0 ? 400 : 207)
     .json({ created: results, errors });
});

app.put('/api/v1/projects/:id/nonfunctional-reqs/:nfrId', (req, res) => {
  const uid = userId(req);
  const existing = db.prepare('SELECT * FROM asdlc_nonfunctional_req WHERE nfr_id = ? AND project_id = ?')
    .get(req.params.nfrId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Non-functional requirement not found' });
  if (existing.status === 'deleted')
    return res.status(400).json({ error: 'Cannot modify a deleted requirement' });

  const ALLOWED = ['title','category','description','measurable_target','verification_method',
                   'priority','dependencies','source','status','use_case_id','ingest_id'];
  const updates = {};
  for (const f of ALLOWED) { if (req.body[f] !== undefined) updates[f] = req.body[f]; }

  if (updates.priority && !REQ_PRIORITY_VALS.includes(updates.priority))
    return res.status(400).json({ error: `priority must be one of: ${REQ_PRIORITY_VALS.join(', ')}` });
  if (updates.status && !REQ_STATUS_VALS.includes(updates.status))
    return res.status(400).json({ error: `status must be one of: ${REQ_STATUS_VALS.join(', ')}` });

  for (const f of NFR_JSON_FIELDS) {
    if (updates[f] !== undefined && typeof updates[f] !== 'string')
      updates[f] = JSON.stringify(updates[f]);
  }

  const isDeleting = updates.status === 'deleted' && existing.status !== 'deleted';

  if (Object.keys(updates).length === 0) return res.json(parseReqRow(existing));

  const regularUpdates = { ...updates };
  delete regularUpdates.deleted_at;
  const setClauses = Object.keys(regularUpdates).map(f => `${f} = ?`).join(', ');
  const deletedAtClause = isDeleting ? ", deleted_at = datetime('now')" : '';
  db.prepare(`UPDATE asdlc_nonfunctional_req SET ${setClauses}${deletedAtClause},
    updated_at = datetime('now'), updated_by = ?, version = version + 1
    WHERE nfr_id = ?`)
    .run(...Object.values(regularUpdates), uid, req.params.nfrId);

  const after = db.prepare('SELECT * FROM asdlc_nonfunctional_req WHERE nfr_id = ?').get(req.params.nfrId);
  auditLog('asdlc_nonfunctional_req', req.params.nfrId, 'UPDATE', existing, after, uid);

  const logAction = isDeleting ? 'Deleted' : 'Modified';
  const logNote   = req.body.change_note || (isDeleting ? `Marked deleted` : `Updated fields: ${Object.keys(regularUpdates).join(', ')}`);
  insertReqChangeLog('nonfunctional', req.params.nfrId, req.params.id, logAction, logNote, uid);

  const reviewQueued = !isDeleting && reviewQueue.maybeEnqueueReview({
    projectId: req.params.id, entityType: 'nonfunctional_req', entityId: req.params.nfrId,
    changedFields: Object.keys(regularUpdates),
  });

  const changeLog = db.prepare(
    "SELECT * FROM asdlc_requirement_change_log WHERE req_type='nonfunctional' AND req_id=? ORDER BY created_at ASC"
  ).all(req.params.nfrId);
  res.json({ ...parseReqRow(after), change_log: changeLog, _review_queued: reviewQueued });
});

// ── Requirement → element traceability links ─────────────────────
// Soft-FK junction (asdlc_requirement_link). Links are AI-proposed during
// ingest (status='proposed', source='agent_ingest') and human-confirmed/edited
// here; manually-created links default to status='confirmed', source='manual'.

// Maps the polymorphic entity_type/req_type to their table + id/display columns
// so a link can be enriched with slugs + human labels for the UI.
const LINK_ENTITY_META = {
  use_case:      { table: 'asdlc_use_case',      idCol: 'use_case_id',      label: 'title' },
  workflow:      { table: 'asdlc_workflow',      idCol: 'workflow_id',      label: 'name'  },
  workflow_step: { table: 'asdlc_workflow_step', idCol: 'workflow_step_id', label: 'name'  },
  agent_spec:    { table: 'asdlc_agent_spec',    idCol: 'agent_spec_id',    label: 'name'  },
  tool:          { table: 'asdlc_tool',          idCol: 'tool_id',          label: 'name'  },
};
const LINK_REQ_META = {
  functional:    { table: 'asdlc_functional_req',    idCol: 'fr_id'  },
  nonfunctional: { table: 'asdlc_nonfunctional_req', idCol: 'nfr_id' },
};
const LINK_STATUS_VALS = ['proposed', 'confirmed', 'rejected'];

function enrichLink(link) {
  if (!link) return link;
  const em = LINK_ENTITY_META[link.entity_type];
  const rm = LINK_REQ_META[link.req_type];
  let entity_slug = null, entity_label = null, req_slug = null, req_title = null;
  if (em) {
    const row = db.prepare(`SELECT slug, ${em.label} AS label FROM ${em.table} WHERE ${em.idCol} = ?`).get(link.entity_id);
    if (row) { entity_slug = row.slug; entity_label = row.label; }
  }
  if (rm) {
    const row = db.prepare(`SELECT slug, title FROM ${rm.table} WHERE ${rm.idCol} = ?`).get(link.req_id);
    if (row) { req_slug = row.slug; req_title = row.title; }
  }
  return { ...link, entity_slug, entity_label, req_slug, req_title };
}

// List links, filterable by requirement (req_type+req_id) and/or entity
// (entity_type+entity_id) and/or status. Defaults to active links only.
app.get('/api/v1/projects/:id/requirement-links', (req, res) => {
  const { req_type, req_id, entity_type, entity_id, status, include_rejected } = req.query;
  let sql = "SELECT * FROM asdlc_requirement_link WHERE project_id = ? AND lifecycle_status = 'active'";
  const params = [req.params.id];
  if (req_type)    { sql += ' AND req_type = ?';    params.push(req_type); }
  if (req_id)      { sql += ' AND req_id = ?';       params.push(req_id); }
  if (entity_type) { sql += ' AND entity_type = ?';  params.push(entity_type); }
  if (entity_id)   { sql += ' AND entity_id = ?';    params.push(entity_id); }
  if (status)      { sql += ' AND status = ?';       params.push(status); }
  else if (include_rejected !== '1') { sql += " AND status != 'rejected'"; }
  sql += ' ORDER BY created_at ASC';
  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(enrichLink));
});

app.post('/api/v1/projects/:id/requirement-links', (req, res) => {
  const uid = userId(req);
  const projectId = req.params.id;
  const { req_type, req_id, entity_type, entity_id, relationship, confidence, status, source } = req.body || {};
  const rm = LINK_REQ_META[req_type];
  const em = LINK_ENTITY_META[entity_type];
  if (!rm) return res.status(400).json({ error: `req_type must be one of: ${Object.keys(LINK_REQ_META).join(', ')}` });
  if (!em) return res.status(400).json({ error: `entity_type must be one of: ${Object.keys(LINK_ENTITY_META).join(', ')}` });
  if (!req_id || !entity_id) return res.status(400).json({ error: 'req_id and entity_id are required' });

  // Validate both endpoints exist and belong to this project.
  const reqRow = db.prepare(`SELECT 1 FROM ${rm.table} WHERE ${rm.idCol} = ? AND project_id = ?`).get(req_id, projectId);
  if (!reqRow) return res.status(404).json({ error: 'Requirement not found in this project' });
  const entRow = db.prepare(`SELECT 1 FROM ${em.table} WHERE ${em.idCol} = ? AND project_id = ?`).get(entity_id, projectId);
  if (!entRow) return res.status(404).json({ error: 'Linked entity not found in this project' });

  if (status && !LINK_STATUS_VALS.includes(status))
    return res.status(400).json({ error: `status must be one of: ${LINK_STATUS_VALS.join(', ')}` });

  // Idempotent: if an active link already exists for this triple, return it.
  const dup = db.prepare(
    "SELECT * FROM asdlc_requirement_link WHERE project_id = ? AND req_type = ? AND req_id = ? AND entity_type = ? AND entity_id = ? AND lifecycle_status = 'active'"
  ).get(projectId, req_type, req_id, entity_type, entity_id);
  if (dup) return res.status(200).json(enrichLink(dup));

  const id = generateId();
  db.prepare(`INSERT INTO asdlc_requirement_link
    (link_id, project_id, req_type, req_id, entity_type, entity_id,
     relationship, confidence, status, source, created_by, updated_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      id, projectId, req_type, req_id, entity_type, entity_id,
      relationship || 'implements',
      (typeof confidence === 'number' ? confidence : null),
      status || 'confirmed',
      source === 'agent_ingest' ? 'agent_ingest' : 'manual',
      uid, uid
    );
  const created = db.prepare('SELECT * FROM asdlc_requirement_link WHERE link_id = ?').get(id);
  auditLog('asdlc_requirement_link', id, 'INSERT', null, created, uid);
  res.status(201).json(enrichLink(created));
});

app.put('/api/v1/projects/:id/requirement-links/:linkId', (req, res) => {
  const uid = userId(req);
  const existing = db.prepare('SELECT * FROM asdlc_requirement_link WHERE link_id = ? AND project_id = ?')
    .get(req.params.linkId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Link not found' });

  const ALLOWED = ['status', 'relationship', 'confidence'];
  const updates = {};
  for (const f of ALLOWED) { if (req.body[f] !== undefined) updates[f] = req.body[f]; }
  if (updates.status && !LINK_STATUS_VALS.includes(updates.status))
    return res.status(400).json({ error: `status must be one of: ${LINK_STATUS_VALS.join(', ')}` });
  if (Object.keys(updates).length === 0) return res.json(enrichLink(existing));

  const setClauses = Object.keys(updates).map(f => `${f} = ?`).join(', ');
  db.prepare(`UPDATE asdlc_requirement_link SET ${setClauses},
    updated_at = datetime('now'), updated_by = ?, version = version + 1
    WHERE link_id = ?`)
    .run(...Object.values(updates), uid, req.params.linkId);
  const after = db.prepare('SELECT * FROM asdlc_requirement_link WHERE link_id = ?').get(req.params.linkId);
  auditLog('asdlc_requirement_link', req.params.linkId, 'UPDATE', existing, after, uid);
  res.json(enrichLink(after));
});

// Soft-delete (lifecycle_status='cancelled'), consistent with other reversible deletes.
app.delete('/api/v1/projects/:id/requirement-links/:linkId', (req, res) => {
  const uid = userId(req);
  const existing = db.prepare('SELECT * FROM asdlc_requirement_link WHERE link_id = ? AND project_id = ?')
    .get(req.params.linkId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Link not found' });
  db.prepare(`UPDATE asdlc_requirement_link SET lifecycle_status = 'cancelled',
    updated_at = datetime('now'), updated_by = ?, version = version + 1 WHERE link_id = ?`)
    .run(uid, req.params.linkId);
  auditLog('asdlc_requirement_link', req.params.linkId, 'DELETE', existing, { ...existing, lifecycle_status: 'cancelled' }, uid);
  res.json({ deleted: true, link_id: req.params.linkId });
});

// ── Requirements design-report ───────────────────────────────────

app.get('/api/v1/projects/:id/design-report/requirements', (req, res) => {
  const project = db.prepare('SELECT p.*, c.client_name FROM asdlc_project p LEFT JOIN asdlc_client c ON p.client_id = c.client_id WHERE p.project_id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const frs = db.prepare(`
    SELECT fr.*, uc.slug AS use_case_slug, uc.title AS use_case_title
    FROM asdlc_functional_req fr
    LEFT JOIN asdlc_use_case uc ON fr.use_case_id = uc.use_case_id
    WHERE fr.project_id = ? AND fr.status != 'deleted'
    ORDER BY fr.slug ASC
  `).all(req.params.id).map(parseReqRow);

  const nfrs = db.prepare(`
    SELECT nfr.*, uc.slug AS use_case_slug, uc.title AS use_case_title
    FROM asdlc_nonfunctional_req nfr
    LEFT JOIN asdlc_use_case uc ON nfr.use_case_id = uc.use_case_id
    WHERE nfr.project_id = ? AND nfr.status != 'deleted'
    ORDER BY nfr.slug ASC
  `).all(req.params.id).map(parseReqRow);

  const ucRows = db.prepare("SELECT use_case_id, slug, title FROM asdlc_use_case WHERE project_id = ? AND lifecycle_status != 'deleted'").all(req.params.id);
  const use_case_map = {};
  ucRows.forEach(uc => { use_case_map[uc.use_case_id] = { slug: uc.slug, title: uc.title }; });

  res.json({
    project,
    generated_at: new Date().toISOString(),
    functional_reqs: frs,
    nonfunctional_reqs: nfrs,
    use_case_map,
  });
});

// ──────────────────────────────────────────────
// UNIFIED DESIGN REVIEW REPORT
// ──────────────────────────────────────────────
app.get('/api/v1/projects/:id/design-review-report', (req, res) => {
  const ok = db.prepare('SELECT 1 FROM asdlc_project WHERE project_id = ?').get(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Project not found' });
  try {
    const html = buildDesignReviewHtml(db, req.params.id);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('[design-review-report]', err);
    res.status(500).send(`<pre>Report generation error: ${String(err.message).replace(/&/g,'&amp;').replace(/</g,'&lt;')}</pre>`);
  }
});

// ──────────────────────────────────────────────
// 404 fallback for API
// ──────────────────────────────────────────────
app.use('/api/*path', (req, res) => {
  res.status(404).json({ error: `No API route: ${req.method} ${req.path}` });
});

// ──────────────────────────────────────────────
// SPA fallback — serve index.html for all non-API routes
// ──────────────────────────────────────────────
app.get('*path', (req, res) => {
  const idx = path.join(__dirname, '..', 'frontend', 'index.html');
  res.sendFile(idx, (err) => {
    if (err) res.status(404).send('Frontend not found');
  });
});

// ──────────────────────────────────────────────
// Start
// ──────────────────────────────────────────────
// Boot-time AI config validation: loud on misconfiguration, never fatal
// (offline test suites boot this server with no API key and must stay green).
try {
  const v = aiConfig.validateAiConfig();
  const errs  = v.issues.filter(i => i.level === 'error');
  const warns = v.issues.filter(i => i.level === 'warn');
  for (const i of errs)  console.error(`[ai-config] ERROR${i.role ? ` (${i.role})` : ''}: ${i.message}`);
  for (const i of warns) console.warn(`[ai-config] warning${i.role ? ` (${i.role})` : ''}: ${i.message}`);
  if (!errs.length && !warns.length) {
    console.log(`[ai-config] model config OK (${aiConfig.ROLES.length} roles, ${v.model_count} models)`);
  }
} catch (err) {
  console.error('[ai-config] boot validation failed:', err.message);
}

app.listen(PORT, () => {
  console.log(`[server] Agentic SDLC Workbench API running on http://localhost:${PORT}`);
});

module.exports = app;
