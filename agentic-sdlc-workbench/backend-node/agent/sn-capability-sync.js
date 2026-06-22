// agent/sn-capability-sync.js
// ─────────────────────────────────────────────────────────────────────────────
// The ADAPTIVITY ENGINE for the generic ServiceNow artifact substrate.
//
// The now-sdk / Fluent keeps improving — new metadata types, types graduating from
// the generic Record() fallback to dedicated typed APIs, new fields. Rather than
// hand-maintain a type list that goes stale every release, we DERIVE the registry
// (asdlc_sn_type_registry) from the SDK's own machine-readable catalog:
//
//     npx @servicenow/sdk explain --list --format=raw
//
// Each `*-api` topic is a first-class deployable metadata type. Its tag list carries
// the Fluent constructor name (first tag) and the backing SN table (e.g.
//   acl-api [Acl, acl, access control, security, permission, sys_security_acl]
// → type 'acl', constructor 'Acl', table 'sys_security_acl').
//
// syncCapabilities() upserts one row per type, stamps the installed SDK version, and
// AUTO-PROMOTES a type from deploy_strategy 'record' → 'typed' the moment a dedicated
// constructor appears — no code change, no migration. Human-curated fields (tier,
// projected_entity_type, field_schema, parent_type, child_role on rows with
// curated=1) are preserved across re-scans; the derived facts (constructor, table,
// tags, sdk_version) always refresh.
//
// PARSING is a pure, exported function (parseExplainCatalog) so it is testable
// offline; the CLI call is injectable (execImpl) for the same reason.
'use strict';
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { db } = require('../db');

// A baseline snapshot is checked in so a fresh DB has a working registry WITHOUT
// needing the SDK present at boot. `syncCapabilities` refreshes it from the live SDK.
const BASELINE_PATH = path.join(__dirname, 'sn-type-registry.baseline.json');

// Curated overlay: the 6 Tier-A types that PROJECT onto an existing Level-1 table,
// plus the common parent→child structures. A re-scan refreshes derived facts but
// must not clobber these tier/projection/parent assignments (curated=1).
//   key = sn_metadata_type (explain topic stem, minus '-api')
const CURATED = {
  // ── Tier A: high-fidelity L1 projection today ──
  table:          { tier: 'A', projected_entity_type: 'data_model' },
  businessrule:   { tier: 'A', projected_entity_type: 'business_logic' },
  clientscript:   { tier: 'A', projected_entity_type: 'business_logic' },
  scriptinclude:  { tier: 'A', projected_entity_type: 'business_logic' },
  uiaction:       { tier: 'A', projected_entity_type: 'business_logic' },
  form:           { tier: 'A', projected_entity_type: 'form_design' },
  uipolicy:       { tier: 'A', projected_entity_type: 'form_design' },
  catalogitem:    { tier: 'A', projected_entity_type: 'catalog_item' },
  restmessage:    { tier: 'A', projected_entity_type: 'integration' },
  alias:          { tier: 'A', projected_entity_type: 'integration' },
  // ── Parent→child structures (children round-trip with their own sys_id) ──
  // Column + Variable subtypes are detected generically below; these name the parents.
};

// SN backing-table heuristic: among a topic's tags, the primary backing table is the
// FIRST snake_case token (a lowercase word with at least one underscore). SN metadata
// tables are sys_*/sc_*/sp_*/dl_*/par_*/contract_*/sysevent_*… — all underscored —
// while prose tags ("access control", "before", "true false") never match.
const SNAKE_TABLE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

/**
 * Parse `npx @servicenow/sdk explain --list --format=raw` output into registry rows.
 * PURE + exported for offline testing. Returns [{ sn_metadata_type, fluent_api_name,
 * source_table, explain_topic, tags, parent_type, child_role }] for each `*-api` topic
 * (the deployable metadata types), excluding `record-api` (the generic fallback itself).
 */
function parseExplainCatalog(raw) {
  const out = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const m = /^([a-z0-9][a-z0-9-]*)\s*\[(.*)\]\s*$/.exec(line.trim());
    if (!m) continue;
    const topic = m[1];
    if (!topic.endsWith('-api')) continue;       // '-guide' topics are docs, not types
    if (topic === 'record-api') continue;          // the generic Record() fallback, not a discrete type
    const tags = m[2].split(',').map(t => t.trim()).filter(Boolean);
    if (!tags.length) continue;
    const fluent_api_name = tags[0];               // first tag is the Fluent constructor (PascalCase)
    const source_table = tags.find(t => SNAKE_TABLE.test(t)) || null;
    const sn_metadata_type = topic.replace(/-api$/, '');
    // Generic parent→child detection for the big sub-element families.
    let parent_type = null, child_role = null;
    if (/column-api$/.test(topic) && topic !== 'column-api') { parent_type = 'table';       child_role = 'column'; }
    else if (/variable-api$/.test(topic))                    { parent_type = 'catalogitem'; child_role = 'variable'; }
    out.push({ sn_metadata_type, fluent_api_name, source_table, explain_topic: topic, tags, parent_type, child_role });
  }
  return out;
}

/** Resolve the installed @servicenow/sdk version (package.json first, then CLI). Best-effort. */
function detectSdkVersion(execImpl) {
  try {
    const pkg = require.resolve('@servicenow/sdk/package.json', { paths: [process.cwd(), __dirname] });
    return JSON.parse(fs.readFileSync(pkg, 'utf8')).version || null;
  } catch { /* not resolvable locally — fall through */ }
  try {
    const out = (execImpl || defaultExec)('npx @servicenow/sdk --version');
    const m = /(\d+\.\d+\.\d+[\w.-]*)/.exec(out || '');
    return m ? m[1] : null;
  } catch { return null; }
}

/** Default catalog fetch: shell the SDK CLI. Replaceable in tests via execImpl. */
function defaultExec(cmd) {
  return cp.execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 180000 });
}

const UPSERT_SQL = `
  INSERT INTO asdlc_sn_type_registry
    (sn_metadata_type, fluent_api_name, source_table, explain_topic, deploy_strategy, tier,
     projected_entity_type, parent_type, child_role, tags, sdk_version, curated, discovered_at, updated_at)
  VALUES (@sn_metadata_type, @fluent_api_name, @source_table, @explain_topic, @deploy_strategy, @tier,
     @projected_entity_type, @parent_type, @child_role, @tags, @sdk_version, @curated, datetime('now'), datetime('now'))
  ON CONFLICT(sn_metadata_type) DO UPDATE SET
    -- Derived facts always refresh (this is how a type tracks the installed SDK):
    fluent_api_name = excluded.fluent_api_name,
    source_table    = excluded.source_table,
    explain_topic   = excluded.explain_topic,
    tags            = excluded.tags,
    sdk_version     = excluded.sdk_version,
    -- AUTO-PROMOTION: once a dedicated constructor exists, leave 'record' behind for good.
    deploy_strategy = CASE WHEN excluded.fluent_api_name IS NOT NULL AND excluded.fluent_api_name <> ''
                           THEN 'typed' ELSE asdlc_sn_type_registry.deploy_strategy END,
    -- Human-curated rows keep their tier/projection/parent; auto rows take the rescan's values.
    tier                  = CASE WHEN asdlc_sn_type_registry.curated = 1 THEN asdlc_sn_type_registry.tier ELSE excluded.tier END,
    projected_entity_type = CASE WHEN asdlc_sn_type_registry.curated = 1 THEN asdlc_sn_type_registry.projected_entity_type ELSE excluded.projected_entity_type END,
    parent_type           = CASE WHEN asdlc_sn_type_registry.curated = 1 THEN asdlc_sn_type_registry.parent_type ELSE excluded.parent_type END,
    child_role            = CASE WHEN asdlc_sn_type_registry.curated = 1 THEN asdlc_sn_type_registry.child_role ELSE excluded.child_role END,
    updated_at      = datetime('now')
`;

/** Turn a parsed catalog entry into a full registry row (applies the curated overlay). */
function toRow(entry, sdkVersion) {
  const curated = CURATED[entry.sn_metadata_type] || null;
  return {
    sn_metadata_type: entry.sn_metadata_type,
    fluent_api_name: entry.fluent_api_name || null,
    source_table: entry.source_table,
    explain_topic: entry.explain_topic,
    // Every catalog `*-api` type has a dedicated constructor ⇒ typed deploy. Types
    // ABSENT from the catalog never get a row here — resolveType() returns the Tier-C
    // Record() default for them, which is the generic fallback.
    deploy_strategy: entry.fluent_api_name ? 'typed' : 'record',
    tier: curated ? curated.tier : 'C',
    projected_entity_type: curated ? (curated.projected_entity_type || null) : null,
    parent_type: entry.parent_type,
    child_role: entry.child_role,
    tags: JSON.stringify(entry.tags || []),
    sdk_version: sdkVersion || null,
    curated: curated ? 1 : 0,
  };
}

/**
 * Refresh asdlc_sn_type_registry from the live SDK catalog.
 * @param {object} [opts]
 * @param {(cmd:string)=>string} [opts.execImpl]  inject the CLI runner (tests/offline)
 * @param {string} [opts.raw]                      pre-fetched catalog text (skips the CLI)
 * @param {boolean} [opts.writeBaseline]           also write the checked-in baseline JSON
 * @returns {{ sdkVersion:string|null, scanned:number, promoted:string[], rows:number }}
 */
function syncCapabilities(opts = {}) {
  const exec = opts.execImpl || defaultExec;
  const sdkVersion = opts.sdkVersion || detectSdkVersion(opts.execImpl);
  const raw = opts.raw != null ? opts.raw : exec('npx @servicenow/sdk explain --list --format=raw');
  const entries = parseExplainCatalog(raw);

  // Detect record→typed promotions vs. the pre-scan state, for reporting/telemetry.
  const before = new Map();
  try {
    for (const r of db.prepare('SELECT sn_metadata_type, deploy_strategy FROM asdlc_sn_type_registry').all())
      before.set(r.sn_metadata_type, r.deploy_strategy);
  } catch { /* table not present yet — first run */ }

  const stmt = db.prepare(UPSERT_SQL);
  const promoted = [];
  const txn = db.transaction ? db.transaction(rows => { for (const r of rows) stmt.run(r); }) : null;
  const rows = entries.map(e => toRow(e, sdkVersion));
  if (txn) txn(rows); else for (const r of rows) stmt.run(r);
  for (const r of rows) {
    const prev = before.get(r.sn_metadata_type);
    if (prev === 'record' && r.deploy_strategy === 'typed') promoted.push(r.sn_metadata_type);
  }

  if (opts.writeBaseline) {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify({ sdkVersion, generatedFrom: 'explain --list', rows }, null, 2));
  }
  return { sdkVersion, scanned: entries.length, promoted, rows: rows.length };
}

/**
 * Seed asdlc_sn_type_registry from the checked-in baseline JSON when it is empty.
 * Lets a fresh DB resolve known types WITHOUT the SDK installed; a later
 * syncCapabilities() refreshes against the live SDK. No-op if already populated or
 * the baseline is missing.
 */
function seedFromBaseline() {
  let count = 0;
  try { count = db.prepare('SELECT COUNT(*) AS n FROM asdlc_sn_type_registry').get().n; } catch { return { seeded: 0 }; }
  if (count > 0) return { seeded: 0, reason: 'already populated' };
  let baseline;
  try { baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')); } catch { return { seeded: 0, reason: 'no baseline' }; }
  const stmt = db.prepare(UPSERT_SQL);
  for (const r of baseline.rows || []) stmt.run({ ...r, tags: typeof r.tags === 'string' ? r.tags : JSON.stringify(r.tags || []) });
  return { seeded: (baseline.rows || []).length, sdkVersion: baseline.sdkVersion || null };
}

module.exports = {
  parseExplainCatalog, syncCapabilities, seedFromBaseline, detectSdkVersion,
  BASELINE_PATH, CURATED,
};
