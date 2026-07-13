// agent/sn-overlap-check.js
//
// Live, cheap ServiceNow duplicate check for a newly-staged requirement (BACKLOG #114).
//
// Runs alongside the ingest cross-check (agent/processor.js): for a document belonging to
// a ServiceNow-connected project, does a small, targeted, capped live search of the
// instance for a record that might already satisfy a staged FR/NFR. If something looks
// like a real match, raises it as a BLOCKING clarification (cross-check.js's `sn_overlap:`
// marker) — same weight as a requirement conflict, so it must be resolved before promote.
//
// Cost discipline:
//   - Never touches the expensive ServiceNow sync pipeline (reverse-engineer/reconcile/
//     review) — only read-only Table API GETs, capped rows, a short curated table list.
//   - Zero AI spend unless the deterministic lookup actually turns up a candidate.
//   - When it does spend, it's the cheapest model in the registry (Haiku), one call,
//     no thinking — modeled directly on agent/req-linker.js.
//
// Non-fatal throughout: any failure (no connection, bad creds, network, parse) is
// swallowed and logged; this check must never break document processing.
//
'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { db } = require('../db');
const aiConfig = require('./ai-config');
const { decrypt } = require('../crypto-util');
const { fetchAllRows, makeFetch } = require('./sn-capture');
const { normalizeInstanceUrl } = require('./sn-catalog');
const { CATALOG_SURFACES } = require('./sn-instance-catalog');
const { loadDocumentRequirements, writeSnOverlapClarification } = require('./cross-check');

const MAX_KEYWORDS = 8;
const ROWS_PER_TABLE_CAP = 10;
const MAX_CANDIDATES_TO_AI = 15;
const VERDICTS = new Set(['possible_overlap', 'likely_duplicate']);

// A short, curated subset of sn-instance-catalog.js's own table list — the record types
// where "ServiceNow may already have this" is a meaningful, common risk. Deliberately not
// the full CATALOG_SURFACES list (24 tables) — this stays a handful of small, fast GETs.
const SEARCH_TABLE_NAMES = ['sc_cat_item', 'sn_aia_agent', 'sn_aia_tool', 'sn_aia_usecase', 'sys_hub_flow'];
const SEARCH_SURFACES = CATALOG_SURFACES.filter(s => SEARCH_TABLE_NAMES.includes(s.table));

const STOPWORDS = new Set(['the', 'a', 'an', 'for', 'and', 'or', 'of', 'to', 'via', 'only', 'with', 'from', 'new', 'system', 'data']);
function tokenize(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !STOPWORDS.has(t));
}
function wordHit(text, token) {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(String(text || ''));
}

function resolveSnConnection(project) {
  const scope = project.servicenow_scope;
  const instance = project.servicenow_instance || process.env.SN_INSTANCE;
  const user = project.sn_user || process.env.SN_USER;
  const pw = decrypt(project.sn_password_enc) || process.env.SN_PASSWORD;
  if (!scope || !instance || !user || !pw) return null;
  return { scope, instance, user, pw };
}

/** Already-open (unanswered) sn_overlap: refs for this document — skip re-checking these. */
function openOverlapRefs(ingestId) {
  const rows = db.prepare(
    "SELECT target_field FROM asdlc_ingest_clarification WHERE ingest_id=? AND answer_text IS NULL AND target_field LIKE 'sn_overlap:%'"
  ).all(ingestId);
  return new Set(rows.map(r => r.target_field.slice('sn_overlap:'.length)));
}

/** Top salient keywords pooled across the requirements being checked. */
function extractKeywords(reqs) {
  const counts = new Map();
  for (const r of reqs) for (const t of tokenize(r.text)) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_KEYWORDS).map(([t]) => t);
}

/** Small, targeted, capped GET per curated table — name-only LIKE search, scoped to the project's app. */
async function searchTable(surface, { instance, user, pw, scope }, keywords, fetchImpl) {
  const f = makeFetch(fetchImpl);
  const auth = 'Basic ' + Buffer.from(`${user}:${pw}`).toString('base64');
  const headers = { Authorization: auth, Accept: 'application/json' };
  const base = normalizeInstanceUrl(instance);
  const orChain = keywords.map(k => `${surface.nameField}LIKE${k}`).join('^OR');
  const query = `sys_scope.scope=${scope}^${orChain}^ORDERBYsys_id`;
  const fieldSet = ['sys_id', surface.nameField, ...surface.fields].filter((v, i, a) => v && a.indexOf(v) === i);
  const baseUrl = `${base}/api/now/table/${surface.table}`
    + `?sysparm_query=${encodeURIComponent(query)}`
    + `&sysparm_fields=${encodeURIComponent(fieldSet.join(','))}`;
  try {
    const { rows } = await fetchAllRows(f, baseUrl, headers, ROWS_PER_TABLE_CAP);
    return rows.map(row => ({
      table: surface.table,
      sys_id: row.sys_id,
      name: row[surface.nameField] || '(unnamed)',
      extra: surface.fields.filter(fld => row[fld] != null && row[fld] !== '').map(fld => `${fld}=${row[fld]}`).join(', '),
    }));
  } catch (err) {
    console.warn(`[sn-overlap-check] search failed for ${surface.table} (non-fatal): ${err.message}`);
    return [];
  }
}

/** Score + rank candidates by name-token overlap against the pooled requirement text; top N. */
function rankCandidates(candidates, reqs) {
  const reqTokens = new Set(reqs.flatMap(r => tokenize(r.text)));
  const scored = candidates.map(c => {
    const nameTokens = tokenize(c.name);
    let hits = 0;
    for (const t of nameTokens) if (reqTokens.has(t)) hits++;
    return { ...c, score: nameTokens.length ? hits / nameTokens.length : 0 };
  }).filter(c => c.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_CANDIDATES_TO_AI);
}

function overlapModel() { return aiConfig.resolveModel('sn_overlap_check'); }

/** One cheap-model call: does any candidate look like a duplicate/overlap of any requirement being checked? */
async function judgeOverlap(reqs, candidates, projectId) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];

  const reqLines = reqs.map(r => `- [${r.req_type === 'nonfunctional' ? 'NFR' : 'FR'}] ${r.slug}: "${r.text.slice(0, 300)}"`).join('\n');
  const candLines = candidates.map((c, i) =>
    `${i}. [${c.table}] "${c.name}"${c.extra ? ' (' + c.extra + ')' : ''}`
  ).join('\n');

  const prompt = [
    'You are a ServiceNow solution analyst checking whether newly-drafted requirements are already',
    'satisfied by something that already exists in the connected ServiceNow instance.',
    '',
    `## Requirements being checked (${reqs.length}):`,
    reqLines,
    '',
    `## Candidate ServiceNow records found by a keyword search (${candidates.length}):`,
    candLines,
    '',
    '## Task',
    'For each requirement, decide whether ANY candidate above is a duplicate, a close duplicate, or',
    'has a big overlap with it — i.e. ServiceNow may already do what this requirement is asking for.',
    'Rules:',
    '  - Be conservative. no_match is the right answer far more often than not — a generic keyword',
    '    collision (e.g. both mention "request") is NOT enough on its own.',
    '  - Reference a candidate using its exact index number from the list above.',
    '  - Do NOT invent a candidate not in the list above.',
    '',
    'Respond with ONLY a JSON array — no markdown fences, no explanation. Omit any requirement with',
    'no real overlap (no_match) — do not include it at all:',
    '[',
    '  { "requirement_slug": "exact slug from the requirements list", "candidate_index": 0,',
    '    "verdict": "possible_overlap" | "likely_duplicate", "reason": "one plain-language sentence" },',
    '  ...',
    ']',
  ].join('\n');

  let response;
  try {
    response = await new Anthropic({ apiKey }).messages.create({
      model: overlapModel(),
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    console.warn('[sn-overlap-check] API call failed (non-fatal):', err.message);
    return [];
  }

  if (response.usage) {
    try { aiConfig.logUsage({ projectId, source: 'sn_overlap_check', refId: null, model: overlapModel(), usage: response.usage }); }
    catch { /* ignore */ }
  }

  const text = (response.content || []).find(b => b.type === 'text')?.text || '';
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  let items;
  try { items = JSON.parse(jsonMatch[0]); } catch { return []; }
  if (!Array.isArray(items)) return [];

  const out = [];
  for (const it of items) {
    if (!it || !it.requirement_slug || !VERDICTS.has(it.verdict)) continue;
    const candidate = candidates[it.candidate_index];
    if (!candidate) continue;
    out.push({ requirement_slug: it.requirement_slug, candidate, verdict: it.verdict, reason: String(it.reason || '').slice(0, 300) });
  }
  return out;
}

/**
 * Check a document's staged requirements against the live ServiceNow instance for a
 * possible existing duplicate. Best-effort — never throws.
 * @param {{doc: object, ingestId: string, round: number, fetchImpl?: Function}} args
 *   `fetchImpl` — test-only fetch override (see agent/sn-capture.js's makeFetch convention).
 * @returns {Promise<{checked: number, raised: number}>}
 */
async function checkServiceNowOverlap({ doc, ingestId, round, fetchImpl }) {
  try {
    const project = db.prepare('SELECT * FROM asdlc_project WHERE project_id=?').get(doc.project_id);
    if (!project) return { checked: 0, raised: 0 };
    const conn = resolveSnConnection(project);
    if (!conn) return { checked: 0, raised: 0 }; // not ServiceNow-connected — zero cost, zero behavior change

    const already = openOverlapRefs(ingestId);
    const reqs = loadDocumentRequirements(ingestId).filter(r => !already.has(r.slug));
    if (!reqs.length) return { checked: 0, raised: 0 };

    const keywords = extractKeywords(reqs);
    if (!keywords.length) return { checked: reqs.length, raised: 0 };

    const perTable = await Promise.all(SEARCH_SURFACES.map(s => searchTable(s, conn, keywords, fetchImpl)));
    const candidates = rankCandidates(perTable.flat(), reqs);
    if (!candidates.length) return { checked: reqs.length, raised: 0 }; // common case — free, no AI spend

    const verdicts = await judgeOverlap(reqs, candidates, project.project_id);
    let raised = 0;
    for (const v of verdicts) {
      const req = reqs.find(r => r.slug === v.requirement_slug);
      if (!req) continue;
      const entityType = req.req_type === 'nonfunctional' ? 'nonfunctional_req' : 'functional_req';
      const question = `A ServiceNow "${v.candidate.name}" (${v.candidate.table}) may already cover this requirement. ${v.reason}`;
      const context = `Candidate: ${v.candidate.table} "${v.candidate.name}" (sys_id ${v.candidate.sys_id})${v.candidate.extra ? ' — ' + v.candidate.extra : ''}. Verdict: ${v.verdict}.`;
      const wrote = writeSnOverlapClarification(ingestId, round, { requirementRef: req.slug, entityType, question, context });
      if (wrote) raised++;
    }
    return { checked: reqs.length, raised };
  } catch (err) {
    console.warn('[sn-overlap-check] check failed (non-fatal):', err.message);
    return { checked: 0, raised: 0 };
  }
}

module.exports = { checkServiceNowOverlap, _internal: { tokenize, wordHit, extractKeywords, rankCandidates, resolveSnConnection } };
