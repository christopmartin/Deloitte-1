// agent/sn-assess.js
// ─────────────────────────────────────────────────────────────────────────────
// ServiceNow round-trip — Phase 0: read-only INSTANCE ASSESSMENT / FIT ANALYSIS.
//
// Point this at an instance BEFORE any extraction. It discovers, using only Table
// API + Aggregate API GETs (no writes, no row pulls, no LLM):
//   • platform version / edition
//   • capability matrix — which catalog tables actually exist (feature/version signal)
//   • application scope inventory
//   • per-scope record COUNTS (cheap; via the Aggregate stats API)
//   • a coverage map (mapped / partial / unmapped vs. the Workbench)
//   • a volume / cost / capacity verdict
//   • a recommended, editable import profile (bounds for later extraction)
//
// Everything is deterministic and cheap — safe to run against a huge instance.
'use strict';

const { SN_CATALOG, SN_COMPLEXITY_PROBES, normalizeInstanceUrl } = require('./sn-catalog');
const aiConfig = require('./ai-config');

// ── Tunable thresholds ───────────────────────────────────────────────────────
// The binding constraint on a SQLite-backed Workbench is NOT raw storage — it is
// (a) the per-artifact reverse-engineer Opus cost/time and (b) UI rendering at
// scale. These artifact-count bands reflect that. Override via env if needed.
const CAP_GREEN  = parseInt(process.env.SN_ASSESS_CAP_GREEN  || '400', 10);   // ≤ → comfortable
const CAP_YELLOW = parseInt(process.env.SN_ASSESS_CAP_YELLOW || '2000', 10);  // ≤ → large but doable with bounds
// Rough per-artifact reverse-engineer token estimate (input incl. system+thinking, output = a Level-1 record).
const EST_INPUT_TOKENS_PER_ARTIFACT  = 6000;
const EST_OUTPUT_TOKENS_PER_ARTIFACT = 3000;
// Optional hard version floor (release family token, lowercased). Empty = no floor (capability-detection only).
const MIN_FAMILY = (process.env.SN_MIN_FAMILY || '').trim().toLowerCase();

function makeClient({ instance, user, pw, fetchImpl }) {
  const f = fetchImpl || fetch;
  const auth = 'Basic ' + Buffer.from(`${user}:${pw}`).toString('base64');
  const base = normalizeInstanceUrl(instance);
  const headers = { Authorization: auth, Accept: 'application/json' };
  return {
    base,
    async get(pathAndQuery, init) {
      const url = `${base}${pathAndQuery}`;
      try {
        const r = await f(url, { headers, ...(init || {}) });
        let json = null;
        try { json = await r.json(); } catch { /* non-JSON / empty */ }
        return { ok: r.ok, status: r.status, json, totalCount: r.headers && r.headers.get ? r.headers.get('x-total-count') : null };
      } catch (e) {
        return { ok: false, status: 0, error: e.message, json: null };
      }
    },
  };
}

const q = (s) => encodeURIComponent(s);

/** Count records in a table, optionally scoped. Aggregate API first, X-Total-Count fallback. */
async function countRecords(client, table, scope) {
  const scopeQ = scope ? `sys_scope.scope=${scope}` : '';
  const statsUrl = `/api/now/stats/${table}?sysparm_count=true${scopeQ ? `&sysparm_query=${q(scopeQ)}` : ''}`;
  const r = await client.get(statsUrl);
  if (r.ok && r.json && r.json.result && r.json.result.stats && r.json.result.stats.count != null) {
    return { count: parseInt(r.json.result.stats.count, 10) || 0, via: 'stats' };
  }
  // Fallback: Table API limit=1 + X-Total-Count header.
  const tblUrl = `/api/now/table/${table}?sysparm_limit=1&sysparm_fields=sys_id${scopeQ ? `&sysparm_query=${q(scopeQ)}` : ''}`;
  const t = await client.get(tblUrl);
  if (t.ok && t.totalCount != null) return { count: parseInt(t.totalCount, 10) || 0, via: 'header' };
  return { count: null, via: 'unavailable', http: r.status || t.status };
}

/** Probe table existence (capability/feature signal): 200 ⇒ present, 4xx ⇒ absent. */
async function probeTable(client, table) {
  const r = await client.get(`/api/now/table/${table}?sysparm_limit=1&sysparm_fields=sys_id`);
  return { table, present: !!r.ok, http: r.status };
}

/** Detect platform version/edition from sys_properties. */
async function detectVersion(client) {
  const r = await client.get(
    `/api/now/table/sys_properties?sysparm_query=${q('nameINglide.buildtag,glide.product.description,glide.war,glide.builddate')}&sysparm_fields=name,value&sysparm_limit=20`
  );
  const out = { readable: !!r.ok, http: r.status, properties: {}, family: null, edition: null };
  if (r.ok && r.json && Array.isArray(r.json.result)) {
    for (const row of r.json.result) out.properties[row.name] = row.value;
    out.edition = out.properties['glide.product.description'] || null;
    // The .war filename embeds the release codename, e.g. glide-australia-...zip → 'australia'.
    const war = out.properties['glide.war'] || out.properties['glide.buildtag'] || '';
    const m = /glide-([a-z]+)/i.exec(war);
    out.family = m ? m[1].toLowerCase() : null;
    out.build = war || null;
  }
  return out;
}

/**
 * Fast, synchronous credential/connectivity check — ONE minimal authenticated read.
 * For the "Test connection" action on the Applications screen, so a bad username/password
 * (or an account missing the `snc_basic_auth_api_access` role) is caught immediately at the
 * point credentials are entered, instead of only surfacing later as an empty Scan/Sync result.
 * @returns {Promise<{ok:boolean, status:?number, message:string}>}
 */
async function checkConnection({ instance, user, pw, fetchImpl } = {}) {
  if (!instance || !user || !pw) {
    return { ok: false, status: null, message: 'Instance URL, username, and password are all required.' };
  }
  const client = makeClient({ instance, user, pw, fetchImpl });
  const r = await client.get('/api/now/table/sys_properties?sysparm_limit=1&sysparm_fields=sys_id');
  if (r.ok) return { ok: true, status: r.status, message: 'Connected successfully.' };
  if (r.status === 401) {
    return { ok: false, status: 401, message: 'Authentication failed (401 Unauthorized) — check the username and password. The account must also have the "snc_basic_auth_api_access" role.' };
  }
  if (r.status === 403) {
    return { ok: false, status: 403, message: 'Connected, but access was denied (403 Forbidden) reading a basic table — check the account\'s roles.' };
  }
  if (r.status === 0) {
    return { ok: false, status: 0, message: `Could not reach "${normalizeInstanceUrl(instance)}" — check the instance URL and network connectivity.${r.error ? ' (' + r.error + ')' : ''}` };
  }
  return { ok: false, status: r.status, message: `Unexpected response (HTTP ${r.status}).` };
}

/** List application scopes (custom apps the user can target). */
async function listScopes(client) {
  const r = await client.get(
    `/api/now/table/sys_scope?sysparm_fields=${q('sys_id,name,scope,version,vendor')}&sysparm_query=${q('ORDERBYname')}&sysparm_limit=2000`
  );
  if (r.ok && r.json && Array.isArray(r.json.result)) {
    return r.json.result.map(s => ({ sys_id: s.sys_id, name: s.name, scope: s.scope, version: s.version, vendor: s.vendor }));
  }
  return [];
}

/** Capacity verdict from the total material artifact count. */
function capacityVerdict(totalArtifacts) {
  if (totalArtifacts == null) return { level: 'unknown', reason: 'Counts unavailable for this instance.' };
  if (totalArtifacts <= CAP_GREEN)
    return { level: 'green', reason: `~${totalArtifacts} artifacts — comfortable for a single bounded import.` };
  if (totalArtifacts <= CAP_YELLOW)
    return { level: 'yellow', reason: `~${totalArtifacts} artifacts — large. Bound by scope/surface and expect meaningful Opus cost/time.` };
  return { level: 'red', reason: `~${totalArtifacts} artifacts — exceeds the comfortable band. Import a subset (scope/surface caps) rather than the whole instance; UI rendering and reverse-engineer cost are the limits, not SQLite.` };
}

/**
 * Read-only assessment of a ServiceNow instance.
 * @param {{instance,user,pw,scopes?:string[],fetchImpl?}} opts
 * @returns {Promise<object>} the fit-analysis report (JSON-serialisable)
 */
async function assessInstance({ instance, user, pw, scopes, fetchImpl } = {}) {
  if (!instance || !user || !pw) throw new Error('instance, user and pw are required');
  const client = makeClient({ instance, user, pw, fetchImpl });
  const warnings = [];

  // 1. Version / edition. This is also the FIRST live call, so use its raw HTTP status as
  //    the connectivity/auth gate: a bad username/password (or an account missing the
  //    `snc_basic_auth_api_access` role, which ServiceNow also reports as 401 on every Table
  //    API call) must fail LOUDLY here rather than silently degrading into a "complete"
  //    report with zero data and a vague "insufficient role?" warning — the failure mode a
  //    user actually hit and got no feedback from.
  const version = await detectVersion(client);
  if (version.http === 401) {
    throw new Error('ServiceNow authentication failed (401 Unauthorized) — check the stored username and password. The account must also have the "snc_basic_auth_api_access" role (see the note on the Applications screen).');
  }
  if (version.http === 0) {
    throw new Error(`Could not reach the ServiceNow instance at "${normalizeInstanceUrl(instance)}" — check the instance URL and network connectivity.`);
  }
  if (!version.readable) warnings.push('Could not read sys_properties — version/edition unknown (insufficient role?).');
  const versionSupported = !MIN_FAMILY || !version.family ? true : version.family >= MIN_FAMILY;
  if (MIN_FAMILY && version.family && !versionSupported)
    warnings.push(`Detected release "${version.family}" is below the configured floor "${MIN_FAMILY}".`);

  // 2. Capability matrix.
  const capability = [];
  for (const c of SN_CATALOG) capability.push({ ...(await probeTable(client, c.table)), captureType: c.captureType, wbDesignType: c.wbDesignType });
  const presentTables = new Set(capability.filter(c => c.present).map(c => c.table));

  // 3. Scope inventory. Instances can have 1000+ scopes (mostly ServiceNow's own);
  //    cap what we store/return so the report stays small. The UI can search/filter.
  const SCOPE_LIST_CAP = 300;
  const allScopesFull = await listScopes(client);
  if (!allScopesFull.length) warnings.push('No application scopes returned from sys_scope (insufficient role, or none exist).');
  const allScopes = allScopesFull.slice(0, SCOPE_LIST_CAP);
  const scopesTruncated = allScopesFull.length > SCOPE_LIST_CAP;
  if (scopesTruncated) warnings.push(`Instance has ${allScopesFull.length} scopes; listing the first ${SCOPE_LIST_CAP}. Pass explicit scopes to assess others.`);
  // Which scopes to deep-census: requested, else all discovered (capped).
  const MAX_CENSUS_SCOPES = 25;
  let censusScopes = (Array.isArray(scopes) && scopes.length) ? scopes : allScopes.map(s => s.scope).filter(Boolean);
  if (censusScopes.length > MAX_CENSUS_SCOPES) {
    warnings.push(`Census limited to the first ${MAX_CENSUS_SCOPES} of ${censusScopes.length} scopes — narrow the request to assess others.`);
    censusScopes = censusScopes.slice(0, MAX_CENSUS_SCOPES);
  }

  // 4. Per-scope census (counts only) over PRESENT surfaces + complexity probes.
  const scopeReports = [];
  let grandArtifacts = 0;
  let countsUnavailable = false;
  for (const scope of censusScopes) {
    const surfaces = [];
    let scopeArtifacts = 0;
    for (const c of SN_CATALOG) {
      if (!presentTables.has(c.table)) { surfaces.push({ ...catalogMeta(c), present: false, count: 0 }); continue; }
      const { count } = await countRecords(client, c.table, scope);
      if (count == null) countsUnavailable = true;
      const n = count || 0;
      scopeArtifacts += n;
      surfaces.push({ ...catalogMeta(c), present: true, count: n });
    }
    // Complexity probes (volume drivers, not captured directly). These tables are not
    // in the catalog, so count directly and treat an unavailable count as "absent".
    const complexity = [];
    for (const probe of SN_COMPLEXITY_PROBES) {
      const { count } = await countRecords(client, probe.table, scope);
      complexity.push({ table: probe.table, parent: probe.parent, label: probe.label, note: probe.note, present: count != null, count: count || 0 });
    }
    grandArtifacts += scopeArtifacts;
    scopeReports.push({ scope, artifact_count: scopeArtifacts, surfaces, complexity });
  }
  if (countsUnavailable) warnings.push('Some record counts were unavailable (stats ACL?) — volume estimate is a lower bound.');

  // 5. Coverage map (instance-level, from catalog × capability).
  const coverage = SN_CATALOG.map(c => {
    const cap = capability.find(x => x.table === c.table);
    return {
      table: c.table, wbDesignType: c.wbDesignType,
      mappingStatus: cap && cap.present ? c.mappingStatus : 'absent',
      partialIntent: c.mappingStatus === 'partial' ? (c.partialIntent || 'gap') : null,
      present: !!(cap && cap.present), featureNote: c.featureNote,
    };
  });
  const unmapped = coverage.filter(c => c.present && c.mappingStatus === 'unmapped');
  const partial  = coverage.filter(c => c.present && c.mappingStatus === 'partial');

  // 6. Volume / cost / capacity.
  const estOpusCalls = grandArtifacts;
  const model = aiConfig.resolveModel('reverse_engineer');
  const pricing = (aiConfig.MODEL_PRICING || {})[model] || null;
  const estCostUsd = pricing
    ? +(((estOpusCalls * EST_INPUT_TOKENS_PER_ARTIFACT) / 1e6) * pricing.in +
        ((estOpusCalls * EST_OUTPUT_TOKENS_PER_ARTIFACT) / 1e6) * pricing.out).toFixed(2)
    : null;
  const verdict = capacityVerdict(countsUnavailable && grandArtifacts === 0 ? null : grandArtifacts);

  // 7. Recommended import profile (editable downstream; bounds the later extraction).
  const includeSurfaces = coverage.filter(c => c.present && c.mappingStatus !== 'unmapped').map(c => c.table);
  const excludeSurfaces = coverage.filter(c => !c.present || c.mappingStatus === 'unmapped').map(c => c.table);
  const recommendedProfile = {
    scopes: censusScopes,
    include_surfaces: includeSurfaces,
    exclude_surfaces: excludeSurfaces,
    // When large, suggest dropping cosmetic client logic to control cost.
    materiality_disallow_types: verdict.level === 'green' ? [] : ['client_script', 'ui_action'],
    per_surface_cap: verdict.level === 'red' ? 200 : null,
    notes: verdict.level === 'red'
      ? 'Large instance — import the highest-value scopes/surfaces first; raise caps once validated.'
      : 'Defaults derived from the assessment; edit before extraction.',
  };

  return {
    assessed_at_note: 'timestamp stamped by caller',
    instance_url: client.base,
    version: { family: version.family, build: version.build || null, edition: version.edition, supported: versionSupported, readable: version.readable },
    capability,
    scopes_available: allScopes,
    scopes_available_total: allScopesFull.length,
    scopes_truncated: scopesTruncated,
    scopes_assessed: censusScopes,
    scope_reports: scopeReports,
    coverage,
    coverage_summary: {
      mapped: coverage.filter(c => c.present && c.mappingStatus === 'mapped').length,
      partial: partial.length,
      unmapped: unmapped.length,
      absent: coverage.filter(c => !c.present).length,
    },
    volume: {
      total_artifacts: grandArtifacts,
      est_reverse_engineer_calls: estOpusCalls,
      est_cost_usd: estCostUsd,
      est_cost_model: model,
      counts_partial: countsUnavailable,
    },
    capacity_verdict: verdict,
    recommended_profile: recommendedProfile,
    warnings,
  };
}

function catalogMeta(c) {
  return { table: c.table, captureType: c.captureType, wbDesignType: c.wbDesignType, mappingStatus: c.mappingStatus, complexityWeight: c.complexityWeight };
}

/**
 * Resolve a ServiceNow user's sys_id from their login (user_name). Read-only —
 * a single Table API GET against sys_user. Used to fill the runAsUser sys_id into
 * the Build Spec so the placeholder doesn't have to be looked up by hand.
 * Returns { sys_id, user_name, name } on success, or null if not found / on any error.
 * Never throws — callers treat null as "leave the placeholder in place".
 * @param {{instance,user,pw,lookupUser?,timeoutMs?,fetchImpl?}} opts
 *   lookupUser defaults to the connecting `user` (the common single-account case).
 */
async function resolveUserSysId({ instance, user, pw, lookupUser, timeoutMs, fetchImpl } = {}) {
  const login = lookupUser || user;
  if (!instance || !user || !pw || !login) return null;
  try {
    const client = makeClient({ instance, user, pw, fetchImpl });
    const init = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout)
      ? { signal: AbortSignal.timeout(timeoutMs || 8000) }
      : undefined;
    const r = await client.get(
      `/api/now/table/sys_user?sysparm_query=${q(`user_name=${login}`)}&sysparm_fields=sys_id,user_name,name&sysparm_limit=1`,
      init
    );
    const row = r.ok && r.json && Array.isArray(r.json.result) ? r.json.result[0] : null;
    if (row && row.sys_id) return { sys_id: row.sys_id, user_name: row.user_name, name: row.name };
    return null;
  } catch {
    return null;
  }
}

module.exports = { assessInstance, checkConnection, capacityVerdict, resolveUserSysId };
