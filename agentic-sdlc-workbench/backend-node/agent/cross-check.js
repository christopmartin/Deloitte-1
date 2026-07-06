// agent/cross-check.js
//
// Ingest Cross-Check & Conflict Reconciliation (Plan C).
//
// Runs AFTER pass-1 extraction + reconcileUpdates in claude-processor.processDocument,
// on the round's staged extractions. Three cost-tiers:
//
//   Tier 0  scanDesignDrift()        — FREE, deterministic. For each material change
//                                       (update/delete of an existing entity), derive the
//                                       salient OLD token(s) (e.g. "sap") and scan the design
//                                       corpus + requirements for OTHER entities that still
//                                       reference them. No LLM.
//   Tier 1  scanRequirementConflicts()— ONE bounded LLM call. New/changed extractions vs ALL
//                                       FR/NFR → {req_slug, relation, severity} + an awareness
//                                       signal. Falls back to the Tier-0 requirement token hits
//                                       when no API key. Logged source='ingest_conflict_scan'.
//   Tier 2  deepDesignScan()         — CONDITIONAL LLM call. Triggered when Tier 0 OR Tier 1
//                                       found something, EXCEPT skipped when awareness=high AND
//                                       max severity=low. Characterises the conflict over a
//                                       capped neighborhood and emits follow-up questions.
//                                       Logged source='ingest_deep_scan'.
//
// Surfacing (clarify-before-promote): blocking clarifications tagged 'conflict:' (promote is
// blocked while any are open); non-blocking 'fyi:' notes when the gate skips the deep scan.
//
'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { db, generateId } = require('../db');
const registry = require('./entity-registry');
const aiConfig = require('./ai-config');

// ── Tunables ──────────────────────────────────────────────────────────────────
const MAX_NEIGHBORHOOD = 40;   // cap candidates fed to the deep scan; beyond → manual-review flag
const SYSTEM_ALIASES = ['sap', 'oracle', 'servicenow', 'workday', 'salesforce', 'netsuite', 'coupa', 'ariba'];
const STOPWORDS = new Set(['the','a','an','for','and','or','of','to','via','only','with','from','detail','lookup','retrieval','invoice','agent','step','system','data','read','write','new']);
const CONFLICT_PREFIX = 'conflict:';   // blocking clarification marker
const FYI_PREFIX       = 'fyi:';        // non-blocking note marker

// Resolve platform-scoped AI Guidance (house rules) for this document and render it
// as prompt lines. The conflict/ripple judges honour the same rules the extractor
// does, so e.g. ServiceNow guidance shapes what counts as a contradiction. Best-effort.
function guidanceBlock(doc, scopes = []) {
  const platform = (doc && doc.platform) || aiConfig.getProjectPlatform(doc && doc.project_id);
  const rules = aiConfig.getActiveBestPractices(scopes, platform);
  if (!rules.length) return [];
  return ['', '## House rules / platform guidance (apply these when judging)',
    ...rules.map(b => `  - ${b.title ? b.title + ': ' : ''}${b.rule_text}`)];
}

// ── Anthropic client (lazy) + key presence ─────────────────────────────────────
let _client;
function hasKey() {
  const k = process.env.ANTHROPIC_API_KEY;
  return !!k && k.trim() !== '' && k !== 'paste-your-anthropic-key-here' && k !== 'your_anthropic_api_key_here';
}
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

// ── small utils ─────────────────────────────────────────────────────────────────
function tryParse(s) { if (s == null) return null; if (typeof s !== 'string') return s; try { return JSON.parse(s); } catch { return s; } }
function asText(v) { if (v == null) return ''; return typeof v === 'string' ? v : JSON.stringify(v); }
function tokenize(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !STOPWORDS.has(t));
}
function wordHit(text, token) {
  // word-boundary, case-insensitive; token already lowercased/sanitised
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(String(text || ''));
}

/** Extract the first {...} JSON object from model text (forgiving of code fences). */
function extractJson(raw) {
  let t = (raw || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s === -1 || e <= s) return null;
  try { return JSON.parse(t.slice(s, e + 1)); } catch { return null; }
}

// ── salient OLD tokens of a change ───────────────────────────────────────────────
// Tokens present in the entity's OLD identity/text but absent from the NEW one. These
// are what OTHER entities may still wrongly reference after the change.
function salientTokens(entityType, current, proposed) {
  const e = registry.byEntityType[entityType];
  const nameKey = (e && e.nameKeys && e.nameKeys[0]) || 'name';
  const oldName = asText(current && current[nameKey]);
  const newName = asText(proposed && proposed[nameKey]);
  const newTok = new Set(tokenize(newName));
  const out = new Set();
  // name-diff tokens
  for (const t of tokenize(oldName)) if (!newTok.has(t)) out.add(t);
  // system aliases that disappeared anywhere in the record's text
  const oldText = Object.values(current || {}).map(asText).join(' ').toLowerCase();
  const newText = Object.values(proposed || {}).map(asText).join(' ').toLowerCase();
  for (const a of SYSTEM_ALIASES) {
    if (wordHit(oldText, a) && !wordHit(newText, a)) out.add(a);
  }
  return [...out];
}

// ── merge / duplicate-consolidation awareness ──────────────────────────────────
// A delete that consolidates a duplicate into a surviving same-type sibling does NOT
// remove that capability from the design — the sibling still provides it. Without
// this, the deleted record's incidental mentions (e.g. a DockTrak tool whose contract
// names "SAP") look like design-wide removals and spray false ripple across every
// element that happens to share the token. So: tokens the survivor still carries are
// not salient, and only a structured interface field the survivor entirely lacks is
// worth a targeted question.
const MERGE_NAME_SIM = 0.5;   // name-token overlap that marks two same-type records as a merge pair
const MERGE_DIFF_SKIP = new Set(['requirement_refs', 'goals', 'done_criteria', 'implements_requirements']);

function nameTokenSet(entityType, data) {
  const e = registry.byEntityType[entityType];
  const key = (e && e.nameKeys && e.nameKeys[0]) || 'name';
  return new Set(tokenize(asText(data && data[key])));
}
function nameJaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** For a delete, find the surviving same-type sibling it is being merged into — a
 *  same-round staged create/update (the merge target) preferred over an existing row —
 *  matched by name-token overlap. Returns { survivorData } or null. */
function findMergeSurvivor(projectId, deletedType, deletedCurrent, stagedSurvivors) {
  const delNames = nameTokenSet(deletedType, deletedCurrent);
  if (!delNames.size) return null;
  let best = null, bestSim = 0;
  for (const s of stagedSurvivors) {
    if (s.entity_type !== deletedType) continue;
    const sim = nameJaccard(delNames, nameTokenSet(deletedType, s.data));
    if (sim > bestSim) { bestSim = sim; best = s.data; }
  }
  if (best && bestSim >= MERGE_NAME_SIM) return { survivorData: best };
  const e = registry.byEntityType[deletedType];
  if (e && e.table) {
    try {
      for (const r of db.prepare(`SELECT * FROM ${e.table} WHERE project_id=? AND slug!=? AND (lifecycle_status IS NULL OR lifecycle_status NOT IN ('retired','deleted'))`).all(projectId, deletedCurrent.slug)) {
        const sim = nameJaccard(delNames, nameTokenSet(deletedType, r));
        if (sim > bestSim) { bestSim = sim; best = r; }
      }
    } catch { /* table without a name column — skip */ }
    if (best && bestSim >= MERGE_NAME_SIM) return { survivorData: best };
  }
  return null;
}

/** Structured (array-valued) interface fields the deleted record populated but the
 *  surviving merged record entirely lacks. Conservative on purpose — item-level diffs
 *  of short interface strings ("PO number" vs "PO / receipt identifier") are noise-prone
 *  and left to the human; only a wholly-dropped field is raised deterministically. */
function droppedInterfaceFields(deletedCurrent, survivorData) {
  const out = [];
  for (const [k, raw] of Object.entries(deletedCurrent || {})) {
    if (MERGE_DIFF_SKIP.has(k)) continue;
    const delVal = tryParse(raw);
    if (!Array.isArray(delVal) || delVal.length === 0) continue;
    const survVal = tryParse(survivorData[k]);
    const survHas = Array.isArray(survVal) ? survVal.length > 0 : (survVal != null && asText(survVal).trim() !== '');
    if (!survHas) out.push({ field: k, items: delVal.map(asText) });
  }
  return out;
}

// ── design corpus (scope-aware) ───────────────────────────────────────────────────
// Returns flat rows: { entity_type, id, slug, workflow_id, fields: {field: text} }.
// scopeWfIds: null = whole project; Set = restrict workflow-bound tables to those workflows.
function loadDesignCorpus(projectId, scopeWfIds) {
  const rows = [];
  const wfFilter = (col) => scopeWfIds ? ` AND ${col} IN (${[...scopeWfIds].map(() => '?').join(',')})` : '';
  const wfArgs   = scopeWfIds ? [...scopeWfIds] : [];
  const active   = "(lifecycle_status IS NULL OR lifecycle_status NOT IN ('retired','deleted'))";

  for (const r of db.prepare(`SELECT workflow_step_id id, slug, workflow_id, name, step_purpose, inputs, outputs, actor_role
      FROM asdlc_workflow_step WHERE project_id=? AND ${active}${wfFilter('workflow_id')}`).all(projectId, ...wfArgs))
    rows.push({ entity_type: 'workflow_step', id: r.id, slug: r.slug, workflow_id: r.workflow_id,
      fields: { name: r.name, step_purpose: r.step_purpose, inputs: r.inputs, outputs: r.outputs, actor_role: r.actor_role } });

  for (const r of db.prepare(`SELECT workflow_path_id id, slug, workflow_id, branch_label
      FROM asdlc_workflow_path WHERE project_id=?${wfFilter('workflow_id')}`).all(projectId, ...wfArgs))
    rows.push({ entity_type: 'workflow_path', id: r.id, slug: r.slug, workflow_id: r.workflow_id, fields: { branch_label: r.branch_label } });

  for (const r of db.prepare(`SELECT workflow_participant_id id, slug, workflow_id, swimlane_display_name, human_role_name, purpose_in_workflow
      FROM asdlc_workflow_participant WHERE project_id=? AND ${active}${wfFilter('workflow_id')}`).all(projectId, ...wfArgs))
    rows.push({ entity_type: 'workflow_participant', id: r.id, slug: r.slug, workflow_id: r.workflow_id,
      fields: { swimlane_display_name: r.swimlane_display_name, human_role_name: r.human_role_name, purpose_in_workflow: r.purpose_in_workflow } });

  // Small / non-workflow-bound sets — always scanned (cheap, high value).
  for (const r of db.prepare(`SELECT use_case_id id, slug, summary, business_objective, constraints_list, expected_value
      FROM asdlc_use_case WHERE project_id=? AND ${active}`).all(projectId))
    rows.push({ entity_type: 'use_case', id: r.id, slug: r.slug, fields: { summary: r.summary, business_objective: r.business_objective, constraints_list: r.constraints_list, expected_value: r.expected_value } });

  for (const r of db.prepare(`SELECT agent_spec_id id, slug, name, scope, instructions FROM asdlc_agent_spec WHERE project_id=? AND ${active}`).all(projectId))
    rows.push({ entity_type: 'agent_spec', id: r.id, slug: r.slug, fields: { name: r.name, scope: r.scope, instructions: r.instructions } });

  for (const r of db.prepare(`SELECT tool_id id, slug, name, contract FROM asdlc_tool WHERE project_id=? AND ${active}`).all(projectId))
    rows.push({ entity_type: 'tool', id: r.id, slug: r.slug, fields: { name: r.name, contract: r.contract } });

  return rows;
}

function loadRequirements(projectId) {
  const out = [];
  for (const r of db.prepare("SELECT fr_id id, slug, title, description FROM asdlc_functional_req WHERE project_id=? AND status!='deleted'").all(projectId))
    out.push({ req_type: 'functional', id: r.id, slug: r.slug, title: r.title, text: `${r.title} ${r.description || ''}` });
  for (const r of db.prepare("SELECT nfr_id id, slug, title, description, measurable_target FROM asdlc_nonfunctional_req WHERE project_id=? AND status!='deleted'").all(projectId))
    out.push({ req_type: 'nonfunctional', id: r.id, slug: r.slug, title: r.title, text: `${r.title} ${r.description || ''} ${r.measurable_target || ''}` });
  return out;
}

// ── scope resolution ──────────────────────────────────────────────────────────────
// 'workflow' scope restricts the big workflow-bound tables to workflows connected to the
// changes (a changed step/workflow/agent's workflow_id). Unresolvable → fall back to project.
function resolveScopeWorkflowIds(projectId, changes, scope) {
  if (scope !== 'workflow') return { ids: null, note: null };
  const ids = new Set();
  for (const c of changes) {
    if (c.entityType === 'workflow' && c.current) ids.add(c.current.workflow_id || c.current.id);
    if (c.entityType === 'workflow_step' && c.current && c.current.workflow_id) ids.add(c.current.workflow_id);
    if (c.entityType === 'agent_spec' && c.current && c.current.workflow_id) ids.add(c.current.workflow_id);
  }
  if (ids.size === 0) return { ids: null, note: 'workflow scope requested but no workflow could be resolved from the changes — fell back to project scope' };
  return { ids, note: null };
}

// ── Tier 0 — deterministic drift scan ───────────────────────────────────────────────
function scanDesignDrift(projectId, changes, scope) {
  const { ids: scopeWfIds, note } = resolveScopeWorkflowIds(projectId, changes, scope);
  const corpus = loadDesignCorpus(projectId, scopeWfIds);
  const reqs   = loadRequirements(projectId);
  const changedKey = new Set(changes.map(c => `${c.entityType}::${c.slug}`));

  const driftTargets = [];
  const requirementDrift = [];
  for (const c of changes) {
    for (const token of c.tokens) {
      // design elements
      for (const row of corpus) {
        if (changedKey.has(`${row.entity_type}::${row.slug}`)) continue; // never flag the entity we changed
        for (const [field, text] of Object.entries(row.fields)) {
          if (wordHit(text, token)) {
            driftTargets.push({ entity_type: row.entity_type, id: row.id, slug: row.slug, workflow_id: row.workflow_id,
              field, token, change_slug: c.slug, change_type: c.entityType, snippet: asText(text).slice(0, 120) });
            break; // one hit per row is enough
          }
        }
      }
      // requirements (free token subset of Tier 1)
      for (const r of reqs) {
        if (wordHit(r.text, token)) requirementDrift.push({ req_slug: r.slug, req_type: r.req_type, title: r.title, token, change_slug: c.slug });
      }
    }
  }
  // de-dup
  const seen = new Set();
  const drift = driftTargets.filter(d => { const k = `${d.entity_type}:${d.slug}:${d.field}:${d.token}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const reqSeen = new Set();
  const reqDrift = requirementDrift.filter(d => { const k = `${d.req_slug}:${d.token}`; if (reqSeen.has(k)) return false; reqSeen.add(k); return true; });
  return { driftTargets: drift, requirementDrift: reqDrift, scopeNote: note, scopeWorkflowIds: scopeWfIds };
}

// ── Tier 1 — requirement-conflict scan (LLM, bounded) ───────────────────────────────
function summariseChange(c) {
  const nameKey = (registry.byEntityType[c.entityType]?.nameKeys || ['name'])[0];
  return `${c.entityType} ${c.slug}: "${asText(c.current && c.current[nameKey])}" → "${asText(c.proposed && c.proposed[nameKey])}"` +
    (c.proposed.conflict_rationale ? ` (stated reason: ${c.proposed.conflict_rationale})` : '');
}

async function scanRequirementConflicts(doc, changes, reqs, round) {
  const model = aiConfig.resolveModel('quality_reviewer');
  const prompt = [
    `You are a requirements-impact auditor for an agentic-design repository. New ingested content has`,
    `produced the changes below. Decide whether each EXISTING requirement is affected — not only direct`,
    `contradictions, but also requirements made STALE or partially wrong by the change.`,
    ...guidanceBlock(doc, ['functional_req', 'nonfunctional_req', ...changes.map(c => c.entityType)]),
    ``,
    `## Changes from this ingest`,
    ...changes.map(c => `  - ${summariseChange(c)}`),
    ``,
    `## Existing requirements`,
    ...reqs.map(r => `  ${r.slug} | ${r.req_type} | "${r.title}"`),
    ``,
    `## Source document (verbatim, for judging whether the author was AWARE of the implications)`,
    (doc.raw_text || '').slice(0, 6000),
    ``,
    `Output STRICT JSON only, no prose:`,
    `{"hits":[{"req_slug":"FR-00X","relation":"contradicts|narrows|supersedes|makes_stale|affects","severity":"low|med|high","rationale":"..."}],`,
    ` "awareness":"high|partial|none"}`,
    `- "awareness" = does the source document show the author KNEW this change would affect those requirements?`,
    `  high = explicitly acknowledged the breadth; partial = implied; none = appears unaware.`,
    `- Only list requirements genuinely affected. Empty hits = {"hits":[],"awareness":"none"}.`,
  ].join('\n');

  const resp = await getClient().messages.create({ model, max_tokens: 1500, messages: [{ role: 'user', content: prompt }] });
  aiConfig.logUsage({ projectId: doc.project_id, source: 'ingest_conflict_scan', refId: doc.ingest_id, model, round, usage: resp.usage });
  const text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const parsed = extractJson(text) || {};
  const validRel = new Set(['contradicts','narrows','supersedes','makes_stale','affects']);
  const validSev = new Set(['low','med','high']);
  const reqBySlug = new Set(reqs.map(r => r.slug));
  const hits = (Array.isArray(parsed.hits) ? parsed.hits : [])
    .filter(h => h && reqBySlug.has(h.req_slug))
    .map(h => ({ req_slug: h.req_slug, relation: validRel.has(h.relation) ? h.relation : 'affects',
                 severity: validSev.has(h.severity) ? h.severity : 'med', rationale: String(h.rationale || '').slice(0, 300) }));
  const awareness = ['high','partial','none'].includes(parsed.awareness) ? parsed.awareness : 'partial';
  return { hits, awareness };
}

// ── Net-new requirement conflict scan (Tier 1, one LLM call) ────────────────────────
// The conflict scan above only considers update/delete changes. A brand-NEW requirement
// that contradicts (or duplicates / narrows / supersedes) an EXISTING one would otherwise
// be staged silently as additive. This compares each net-new requirement proposed this
// ingest against the existing requirements and returns genuine conflicts to surface.
async function scanNetNewConflicts(doc, newReqs, existingReqs, round) {
  const reqText = (d) => {
    const t = d.title || d.name || '(untitled)';
    const body = d.description || d.statement || d.measurable_target || '';
    return `${t}${body ? ' — ' + String(body) : ''}`.slice(0, 300);
  };
  const model = aiConfig.resolveModel('quality_reviewer');
  const prompt = [
    `You are a requirements auditor. The list below proposes NEW requirements to ADD to an existing`,
    `design. For each NEW requirement, decide whether it genuinely conflicts with an EXISTING one —`,
    `they cannot both hold as written (contradicts), one restates the other (duplicates), one tightens`,
    `it (narrows), or one replaces it (supersedes). Ignore merely related-but-compatible requirements.`,
    ``,
    `## New requirements (proposed this ingest)`,
    ...newReqs.map((s, i) => `  [n${i}] ${s.entity_type === 'nonfunctional_req' ? 'NFR' : 'FR'}: ${reqText(s.data)}`),
    ``,
    `## Existing requirements`,
    ...existingReqs.map(r => `  ${r.slug} | ${r.req_type} | "${r.title}"`),
    ``,
    `Output STRICT JSON only, no prose:`,
    `{"hits":[{"new_ref":"n0","existing_slug":"FR-00X","relation":"contradicts|duplicates|narrows|supersedes","severity":"low|med|high","rationale":"one sentence"}]}`,
    `- Only list genuine conflicts a human must resolve. Empty = {"hits":[]}.`,
  ].join('\n');

  const resp = await getClient().messages.create({ model, max_tokens: 1500, messages: [{ role: 'user', content: prompt }] });
  aiConfig.logUsage({ projectId: doc.project_id, source: 'ingest_netnew_conflict_scan', refId: doc.ingest_id, model, round, usage: resp.usage });
  const text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const parsed = extractJson(text) || {};
  const validRel = new Set(['contradicts','duplicates','narrows','supersedes']);
  const validSev = new Set(['low','med','high']);
  const bySlug = new Map(existingReqs.map(r => [r.slug, r]));
  return (Array.isArray(parsed.hits) ? parsed.hits : [])
    .map(h => {
      const m = /^n(\d+)$/.exec(String(h && h.new_ref || ''));
      const nr = m ? newReqs[Number(m[1])] : null;
      if (!nr || !bySlug.has(h.existing_slug)) return null;
      return {
        new_title:      nr.data.title || nr.data.name || 'new requirement',
        existing_slug:  h.existing_slug,
        existing_title: bySlug.get(h.existing_slug).title,
        relation:       validRel.has(h.relation) ? h.relation : 'contradicts',
        severity:       validSev.has(h.severity) ? h.severity : 'med',
        rationale:      String(h.rationale || '').slice(0, 300),
      };
    })
    .filter(Boolean);
}

// ── Tier 2 — deep design scan (LLM, conditional) ────────────────────────────────────
async function deepDesignScan(doc, bundle, round) {
  const model = aiConfig.resolveModel('quality_reviewer');
  const prompt = [
    `You are a conflict-reconciliation auditor. A change was ingested and may have ripple effects across`,
    `the existing design. Produce SPECIFIC, answerable follow-up questions a human must resolve BEFORE the`,
    `change is applied. Each question should name the concrete element and what is ambiguous.`,
    ...guidanceBlock(doc, bundle.changes.map(c => c.entityType)),
    ``,
    `## The change(s)`,
    ...bundle.changes.map(c => `  - ${summariseChange(c)}`),
    ``,
    `## Requirements flagged as affected`,
    ...(bundle.hits.length ? bundle.hits.map(h => `  - ${h.req_slug} [${h.relation}/${h.severity}] ${h.rationale}`) : ['  (none)']),
    ``,
    `## Design elements still referencing the old term(s) (token drift)`,
    ...(bundle.driftTargets.length ? bundle.driftTargets.slice(0, MAX_NEIGHBORHOOD).map(d =>
      `  - ${d.entity_type} ${d.slug || d.id} .${d.field} still mentions "${d.token}": "${d.snippet}"`) : ['  (none)']),
    bundle.capped ? `  (… neighborhood capped at ${MAX_NEIGHBORHOOD}; treat as BROAD impact — recommend manual review)` : ``,
    ``,
    `Output STRICT JSON only:`,
    `{"followups":[{"question":"...","target_entity_type":"workflow_step|tool|...","target_field":"slug-or-field","context":"short quote"}]}`,
    `Keep to the genuinely necessary questions (typically 1–5). Empty = {"followups":[]}.`,
  ].join('\n');

  const resp = await getClient().messages.create({ model, max_tokens: 1500, messages: [{ role: 'user', content: prompt }] });
  aiConfig.logUsage({ projectId: doc.project_id, source: 'ingest_deep_scan', refId: doc.ingest_id, model, round, usage: resp.usage });
  const text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const parsed = extractJson(text) || {};
  return (Array.isArray(parsed.followups) ? parsed.followups : [])
    .filter(f => f && f.question)
    .map(f => ({ question: String(f.question).slice(0, 500), target_entity_type: f.target_entity_type || 'design',
                 target_field: f.target_field || 'conflict', context: String(f.context || '').slice(0, 300) }));
}

// ── deterministic follow-ups (no-API-key fallback for Tier 2) ───────────────────────
function synthesiseFollowups(bundle) {
  const fu = [];
  for (const h of bundle.hits) {
    fu.push({ question: `Ingest change ${bundle.changes.map(c => c.slug).join(', ')} appears to ${h.relation} requirement ${h.req_slug} ("${h.title || ''}"). Should ${h.req_slug} be updated to match, or does the change need to respect it? ${h.rationale}`,
      target_entity_type: 'requirement', target_field: `${h.req_slug}`, context: h.rationale });
  }
  // group drift by the token + changed entity → one question per token
  const byToken = new Map();
  for (const d of bundle.driftTargets) {
    const k = `${d.change_slug}:${d.token}`;
    if (!byToken.has(k)) byToken.set(k, []);
    byToken.get(k).push(d);
  }
  for (const [k, list] of byToken) {
    const [changeSlug, token] = k.split(':');
    const where = list.slice(0, 8).map(d => `${d.entity_type} ${d.slug || d.id} (.${d.field})`).join(', ');
    fu.push({ question: `Change to ${changeSlug} no longer uses "${token}", but ${list.length} other design element(s) still reference "${token}": ${where}. Should these be updated to match, or is "${token}" still correct in those places?`,
      target_entity_type: list[0].entity_type, target_field: `${changeSlug}:${token}`, context: list[0].snippet });
  }
  return fu;
}

// ── surfacing: conflict (blocking) + fyi (non-blocking) clarifications ──────────────
function writeMarkedClarification(ingestId, round, marker, q) {
  const targetField = `${marker}${q.target_field || 'general'}`;
  const dup = db.prepare(
    "SELECT 1 FROM asdlc_ingest_clarification WHERE ingest_id=? AND target_entity_type=? AND target_field=? AND answer_text IS NULL"
  ).get(ingestId, q.target_entity_type || 'design', targetField);
  if (dup) return false;
  db.prepare(`INSERT INTO asdlc_ingest_clarification
      (clarification_id, ingest_id, round, question_text, context_snippet, target_entity_type, target_field, created_at)
    VALUES (?,?,?,?,?,?,?,datetime('now'))`).run(
    generateId(), ingestId, round, q.question, (q.context || '').slice(0, 500),
    q.target_entity_type || 'design', targetField);
  return true;
}

/** True when the document has open conflict-type clarifications (blocks promote). */
function hasOpenConflicts(ingestId) {
  return db.prepare(
    `SELECT COUNT(*) c FROM asdlc_ingest_clarification
     WHERE ingest_id=? AND answer_text IS NULL AND target_field LIKE '${CONFLICT_PREFIX}%'`
  ).get(ingestId).c > 0;
}

// ── main ─────────────────────────────────────────────────────────────────────────
/**
 * Run the ingest cross-check over a round's staged extractions.
 * @returns {Promise<object>} summary counts (never throws — best-effort).
 */
async function runCrossCheck({ doc, round }) {
  const summary = { tier0_drift: 0, requirement_hits: 0, deep_scanned: false, conflicts_raised: 0, fyi_raised: 0, scope: 'project', skipped_reason: null, note: null };
  try {
    const proj = db.prepare('SELECT ripple_scan_scope FROM asdlc_project WHERE project_id=?').get(doc.project_id);
    const scope = (proj && proj.ripple_scan_scope) || 'project';
    summary.scope = scope;

    // Material changes this round = staged update/delete extractions whose target resolves.
    const staged = db.prepare(
      "SELECT entity_type, entity_data FROM asdlc_ingest_extraction WHERE ingest_id=? AND round=? AND status='staged'"
    ).all(doc.ingest_id, round).map(r => ({ entity_type: r.entity_type, data: tryParse(r.entity_data) || {} }));

    // Survivors for merge detection = staged create/update ops this round.
    const stagedSurvivors = staged.filter(s => s.data.operation !== 'delete');
    const changes = [];
    const mergeFollowups = [];   // precise "the survivor is missing X" questions
    let mergeDeletes = 0;
    for (const s of staged) {
      const op = s.data.operation;
      if (op !== 'update' && op !== 'delete') continue;
      const slug = s.data.target_slug;
      if (!slug) continue;
      const e = registry.byEntityType[s.entity_type];
      if (!e || !e.table) continue;
      let current;
      try {
        current = db.prepare(`SELECT * FROM ${e.table} WHERE project_id=? AND slug=? AND (lifecycle_status IS NULL OR lifecycle_status NOT IN ('retired','deleted'))`).get(doc.project_id, slug);
      } catch { current = null; }
      if (!current) continue;
      let tokens = salientTokens(s.entity_type, current, s.data);

      // Merge/consolidation: if this delete folds a duplicate into a surviving sibling,
      // tokens the survivor still carries are NOT design-wide removals — suppress them so
      // they don't spray false ripple (e.g. an incidental "SAP" mention). Genuinely-dropped
      // structured interface fields still surface as one precise question.
      if (op === 'delete') {
        const merged = findMergeSurvivor(doc.project_id, s.entity_type, current, stagedSurvivors);
        if (merged) {
          mergeDeletes++;
          const survText = Object.values(merged.survivorData).map(asText).join(' ').toLowerCase();
          tokens = tokens.filter(t => !wordHit(survText, t));
          const nameKey = (e.nameKeys || ['name'])[0];
          for (const d of droppedInterfaceFields(current, merged.survivorData)) {
            mergeFollowups.push({
              question: `Merge: ${s.entity_type} ${slug} ("${asText(current[nameKey])}") is being consolidated into a surviving sibling, ` +
                `but that sibling defines no ${d.field} while ${slug} had: ${d.items.slice(0, 8).join('; ')}. ` +
                `Carry these into the survivor, or confirm they are intentionally dropped.`,
              target_entity_type: s.entity_type, target_field: `merge:${slug}.${d.field}`,
              context: d.items.slice(0, 8).join('; '),
            });
          }
        }
      }
      if (tokens.length === 0) continue;
      changes.push({ entityType: s.entity_type, slug, current, proposed: s.data, tokens });
    }
    summary.merge_deletes = mergeDeletes;

    // Surface precise merge-divergence questions (independent of the ripple pipeline,
    // so they are raised even when every merge fully covered its salient tokens).
    for (const f of mergeFollowups) {
      if (writeMarkedClarification(doc.ingest_id, round, CONFLICT_PREFIX, f)) summary.conflicts_raised++;
    }

    // ── Net-new requirement conflict scan (runs regardless of update/delete changes) ──
    // A brand-new requirement that contradicts an existing one is the most common "conflicting
    // requirement arrives" case; without this it would be staged silently as additive.
    try {
      const newReqs = staged.filter(s =>
        (s.entity_type === 'functional_req' || s.entity_type === 'nonfunctional_req') &&
        s.data.operation !== 'update' && s.data.operation !== 'delete');
      if (newReqs.length && hasKey()) {
        const existingReqs = loadRequirements(doc.project_id);
        if (existingReqs.length) {
          const nnHits = await scanNetNewConflicts(doc, newReqs, existingReqs, round);
          summary.netnew_hits = nnHits.length;
          for (const h of nnHits) {
            if (h.severity !== 'med' && h.severity !== 'high') continue;   // only block on real conflicts
            const raised = writeMarkedClarification(doc.ingest_id, round, CONFLICT_PREFIX, {
              question: `New requirement "${h.new_title}" ${h.relation} existing ${h.existing_slug}` +
                        (h.existing_title ? ` ("${h.existing_title}")` : '') + `: ${h.rationale} ` +
                        `Resolve which should hold before promoting.`,
              target_entity_type: 'requirement', target_field: `netnew:${h.existing_slug}`, context: h.rationale });
            if (raised) summary.conflicts_raised++;
          }
        }
      }
    } catch (err) { console.warn('[cross-check] net-new conflict scan failed (non-fatal):', err.message); }

    if (changes.length === 0) { console.log('[cross-check] no material changes with salient tokens — skipping'); return summary; }

    // Tier 0 (free)
    const t0 = scanDesignDrift(doc.project_id, changes, scope);
    summary.tier0_drift = t0.driftTargets.length;
    summary.note = t0.scopeNote;

    // Tier 1 (one LLM call; token fallback when no key)
    let hits = [], awareness = 'partial';
    const reqs = loadRequirements(doc.project_id);
    if (hasKey()) {
      try {
        const r = await scanRequirementConflicts(doc, changes, reqs, round);
        hits = r.hits; awareness = r.awareness;
      } catch (err) { console.warn('[cross-check] Tier-1 LLM failed, using token fallback:', err.message); }
    }
    if (hits.length === 0 && t0.requirementDrift.length) {
      // deterministic fallback: token-matched requirements → makes_stale/med, conservative awareness
      const reqBySlug = Object.fromEntries(reqs.map(r => [r.slug, r]));
      hits = [...new Set(t0.requirementDrift.map(d => d.req_slug))].map(slug => ({
        req_slug: slug, relation: 'makes_stale', severity: 'med',
        rationale: `Still references a term the ingest changed (token match).`, title: reqBySlug[slug]?.title }));
      awareness = 'partial';
    }
    summary.requirement_hits = hits.length;

    // Gate: union trigger; skip deep scan only when awareness high AND max severity low
    const triggered = t0.driftTargets.length > 0 || hits.length > 0;
    const maxSev = hits.reduce((m, h) => (['low','med','high'].indexOf(h.severity) > ['low','med','high'].indexOf(m) ? h.severity : m), 'low');
    const skipDeep = awareness === 'high' && maxSev === 'low';

    if (!triggered) { console.log('[cross-check] no drift or requirement hits — clean'); return summary; }

    const bundle = { changes, hits, driftTargets: t0.driftTargets, capped: t0.driftTargets.length > MAX_NEIGHBORHOOD };

    let followups = [];
    if (skipDeep) {
      summary.skipped_reason = 'awareness=high & severity=low → FYI only';
      // non-blocking FYI note (one summary line)
      const raised = writeMarkedClarification(doc.ingest_id, round, FYI_PREFIX, {
        question: `Heads-up: this change touches ${t0.driftTargets.length} design element(s) and ${hits.length} requirement(s); the document appears to acknowledge this. No action required unless you disagree.`,
        target_entity_type: 'design', target_field: 'ripple-fyi', context: '' });
      if (raised) summary.fyi_raised++;
      return summary;
    }

    // Deep scan (LLM if key; else deterministic synthesis)
    if (hasKey()) {
      try { followups = await deepDesignScan(doc, bundle, round); summary.deep_scanned = true; }
      catch (err) { console.warn('[cross-check] Tier-2 LLM failed, synthesising follow-ups:', err.message); }
    }
    if (followups.length === 0) followups = synthesiseFollowups(bundle);

    // Surface as blocking conflict clarifications
    for (const f of followups) {
      if (writeMarkedClarification(doc.ingest_id, round, CONFLICT_PREFIX, f)) summary.conflicts_raised++;
    }
    console.log(`[cross-check] scope=${scope} drift=${summary.tier0_drift} reqHits=${summary.requirement_hits} deep=${summary.deep_scanned} conflicts=${summary.conflicts_raised}`);
    return summary;
  } catch (err) {
    console.error('[cross-check] failed (non-fatal):', err.message);
    return summary;
  }
}

// ── Plan D — post-apply consistency check ──────────────────────────────────────
// Runs AFTER a change packet is approved+applied (transitionCp). Deterministic
// (Tier-0 only — no LLM, cheap enough to run on every apply). For each applied
// update/delete item it derives the salient OLD token(s) from old_value→new_value
// and scans the now-current design + requirements for residual references. Writes
// post_apply_status ('clean'|'flagged') + findings JSON to the CP, which drive the
// advisory banners on the CP detail + project dashboard. Best-effort; never throws.
// Note: token-based, so a system that legitimately still exists (e.g. SAP kept for a
// different purpose) may show as a residual reference — the banner is advisory.
function runPostApplyCheck(cpId) {
  try {
    const cp = db.prepare('SELECT * FROM asdlc_change_packet WHERE change_packet_id=?').get(cpId);
    if (!cp) return { status: 'clean', findings: [] };
    const items = db.prepare('SELECT * FROM asdlc_change_packet_item WHERE change_packet_id=?').all(cpId);

    const changes = [];
    for (const it of items) {
      if (it.operation !== 'update' && it.operation !== 'delete') continue;
      const oldRow  = tryParse(it.old_value);   // full prior DB row (has slug)
      const newData = tryParse(it.new_value) || {};
      if (!oldRow || typeof oldRow !== 'object') continue;
      const slug = oldRow.slug || newData.target_slug;
      if (!slug) continue;
      const tokens = salientTokens(it.entity_type, oldRow, newData);
      if (tokens.length === 0) continue;
      changes.push({ entityType: it.entity_type, slug, current: oldRow, proposed: newData, tokens });
    }

    let findings = [];
    if (changes.length) {
      const proj  = db.prepare('SELECT ripple_scan_scope FROM asdlc_project WHERE project_id=?').get(cp.project_id);
      const scope = (proj && proj.ripple_scan_scope) || 'project';
      const t0 = scanDesignDrift(cp.project_id, changes, scope);
      findings = [
        ...t0.driftTargets.map(d => ({ kind: 'design', entity_type: d.entity_type, slug: d.slug || d.id,
          field: d.field, token: d.token, change_slug: d.change_slug, snippet: d.snippet })),
        ...t0.requirementDrift.map(r => ({ kind: 'requirement', req_slug: r.req_slug, token: r.token, change_slug: r.change_slug })),
      ];
    }

    const status = findings.length ? 'flagged' : 'clean';
    db.prepare("UPDATE asdlc_change_packet SET post_apply_status=?, post_apply_findings=?, updated_at=datetime('now') WHERE change_packet_id=?")
      .run(status, JSON.stringify(findings), cpId);
    if (findings.length) console.log(`[post-apply] CP ${cp.packet_code || cpId}: ${findings.length} residual reference(s) flagged`);
    return { status, findings };
  } catch (err) {
    console.error('[post-apply] failed (non-fatal):', err.message);
    return { status: 'clean', findings: [] };
  }
}

module.exports = { runCrossCheck, hasOpenConflicts, runPostApplyCheck, CONFLICT_PREFIX, FYI_PREFIX,
  _internal: { salientTokens, scanDesignDrift, synthesiseFollowups, loadDesignCorpus,
    findMergeSurvivor, droppedInterfaceFields } };
