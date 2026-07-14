// Design Quality Check — deterministic pre-promotion gate.
//
// Runs a set of rule-based checks over an ingest's staged extractions to catch
// the class of defects that survive the orphan/conflict guards in server.js's
// /promote handler but still produce a broken or half-confirmed design:
//   - the same real-world use case/workflow extracted twice under different
//     names across rounds, with children split across both copies
//   - the same integration/tool described twice under different names
//   - guardrails/NFRs/etc. still carrying placeholder ("TBD") language
//   - AI-invented agents/workflows/tools not named in the source material
//   - functional requirements with no acceptance criterion or test case
//
// Findings carry a severity: 'block' (structurally breaks the design — never
// bypassable), 'warn' (needs a human look — bypassable with explicit
// acknowledgment), or 'info' (FYI, never blocks).
const registry = require('./entity-registry');

const PLACEHOLDER_RE = /\b(tbd|to be defined|to be determined|to confirm|confirm with (?:the )?business|placeholder)\b/i;
const SPLIT_PARENT_JACCARD = 0.4;
const LEAF_DUP_JACCARD = 0.55;
const SIBLING_JACCARD = 0.4;
// A reworded restatement of a requirement (title+description) typically scores LOWER
// than a reworded short entity name would (more content words to differ on) — calibrated
// against the actual reported incident's duplicate pair. Set below LEAF_DUP_JACCARD (0.55);
// false positives here are cheap (a 'warn' finding the human acknowledges, never blocks).
const REQUIREMENT_DUP_JACCARD = 0.5;
const LEAF_DEDUP_TYPES = new Set(['tool', 'rest_message', 'connection_alias', 'data_source', 'nl_business_rule', 'guardrail']);
const STRUCTURAL_TYPES = new Set(['agent_spec', 'workflow', 'tool', 'rest_message', 'connection_alias', 'inbound_rest_api']);

function nameOf(type, data) {
  const e = registry.byEntityType[type];
  const keys = (e && e.nameKeys) || ['title', 'name'];
  const parts = keys.map(k => data && data[k]).filter(Boolean);
  if (parts.length) return parts.join(' ');
  return (data && (data.title || data.name)) || '(unnamed)';
}

function tokenize(name) {
  return new Set(String(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 1));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

function hubTypes() {
  const set = new Set();
  for (const e of registry.REGISTRY) for (const l of (e.parentLinks || [])) set.add(l.parentType);
  return set;
}

function humanType(type) { return String(type).replace(/_/g, ' '); }

// ── Check 1: same real-world parent entity extracted twice under different
// names, with children (steps/gates/agents) split across both copies ────────
function checkSplitParents(items) {
  const findings = [];
  for (const hub of hubTypes()) {
    const candidates = items.filter(it => it.type === hub);
    if (candidates.length < 2) continue;
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i], b = candidates[j];
        const nameA = nameOf(hub, a.data), nameB = nameOf(hub, b.data);
        if (jaccard(tokenize(nameA), tokenize(nameB)) < SPLIT_PARENT_JACCARD) continue;

        const childrenOf = (name) => items.filter(child => {
          const ce = registry.byEntityType[child.type];
          return ((ce && ce.parentLinks) || []).some(l => l.parentType === hub && child.data && child.data[l.nameKeyInData] === name);
        });
        const childrenA = childrenOf(nameA), childrenB = childrenOf(nameB);
        if (!childrenA.length && !childrenB.length) continue; // neither is in use — not worth flagging here

        const severity = (childrenA.length && childrenB.length) ? 'block' : 'warn';
        const describe = (name, kids) => kids.length
          ? `"${name}" has ${kids.length} linked item(s): ${kids.map(c => `${humanType(c.type)} "${nameOf(c.type, c.data)}"`).join(', ')}`
          : `"${name}" has no linked items`;

        findings.push({
          severity,
          category: 'split_entity',
          title: `Possible duplicate ${humanType(hub)}: "${nameA}" vs "${nameB}"`,
          detail: `These look like the same real-world ${humanType(hub)}, extracted twice under different names. ` +
            `${describe(nameA, childrenA)}; ${describe(nameB, childrenB)}. ` +
            (severity === 'block'
              ? 'Promoting as-is splits one real workflow across two disconnected records.'
              : 'One side is unused — likely a stray duplicate.'),
          entities: [
            { type: hub, name: nameA, extraction_id: a.id },
            { type: hub, name: nameB, extraction_id: b.id },
          ],
          suggested_action: `Merge these two ${humanType(hub)} records into one before promoting.`,
        });
      }
    }
  }
  return findings;
}

// ── Check 2: same integration/tool/rule described twice under different names ──
function checkLeafDuplicates(items) {
  const findings = [];
  for (const type of LEAF_DEDUP_TYPES) {
    const candidates = items.filter(it => it.type === type);
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i], b = candidates[j];
        const nameA = nameOf(type, a.data), nameB = nameOf(type, b.data);
        if (jaccard(tokenize(nameA), tokenize(nameB)) < LEAF_DUP_JACCARD) continue;
        findings.push({
          severity: 'warn',
          category: 'duplicate_leaf',
          title: `Possible duplicate ${humanType(type)}: "${nameA}" vs "${nameB}"`,
          detail: 'These look like two extraction rounds describing the same capability under different names.',
          entities: [
            { type, name: nameA, extraction_id: a.id },
            { type, name: nameB, extraction_id: b.id },
          ],
          suggested_action: `Consolidate into one ${humanType(type)} record before promoting to avoid duplicate build artifacts.`,
        });
      }
    }
  }
  return findings;
}

// ── Check 2b: same requirement staged twice under a reworded title (2026-07-14) ──
// Standalone rather than folded into checkLeafDuplicates — FR/NFR text is title+description
// (richer than a leaf entity's bare name) and needs its own tighter threshold, and keeping
// this separate avoids touching the existing, already-tested checkLeafDuplicates.
function requirementText(type, data) {
  const base = `${data.title || ''} ${data.description || ''}`;
  return type === 'nonfunctional_req' ? `${base} ${data.measurable_target || ''}` : base;
}

function checkRequirementDuplicates(items) {
  const findings = [];
  for (const type of ['functional_req', 'nonfunctional_req']) {
    const candidates = items.filter(it => it.type === type);
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i], b = candidates[j];
        const textA = requirementText(type, a.data || {}), textB = requirementText(type, b.data || {});
        if (jaccard(tokenize(textA), tokenize(textB)) < REQUIREMENT_DUP_JACCARD) continue;
        const nameA = nameOf(type, a.data), nameB = nameOf(type, b.data);
        findings.push({
          severity: 'warn',
          category: 'duplicate_requirement',
          title: `Possible duplicate ${humanType(type)}: "${nameA}" vs "${nameB}"`,
          detail: 'These look like the same requirement staged twice under different wording, likely across extraction rounds.',
          entities: [
            { type, name: nameA, extraction_id: a.id },
            { type, name: nameB, extraction_id: b.id },
          ],
          suggested_action: `Consolidate into one ${humanType(type)} record before promoting.`,
        });
      }
    }
  }
  return findings;
}

// ── Check 3: unresolved "TBD"/placeholder language left on a staged entity ──
function checkPlaceholders(items) {
  const findings = [];
  for (const it of items) {
    const blob = JSON.stringify(it.data || {});
    if (!PLACEHOLDER_RE.test(blob)) continue;
    const name = nameOf(it.type, it.data);
    const sibling = items.find(o => o !== it && o.type === it.type &&
      jaccard(tokenize(nameOf(o.type, o.data)), tokenize(name)) >= SIBLING_JACCARD &&
      !PLACEHOLDER_RE.test(JSON.stringify(o.data || {})));
    findings.push({
      severity: 'warn',
      category: 'unconfirmed_placeholder',
      title: `Unconfirmed placeholder in ${humanType(it.type)} "${name}"`,
      detail: sibling
        ? `Looks superseded by "${nameOf(sibling.type, sibling.data)}", which already has a concrete value. Retire this one instead of carrying both forward.`
        : `Still carries placeholder/TBD language (confidence ${it.confidence}) and hasn't been explicitly confirmed by the business.`,
      entities: [{ type: it.type, name, extraction_id: it.id }],
      suggested_action: sibling ? 'Retire this record — superseded by the confirmed version.' : 'Get explicit business sign-off before treating this as a final target.',
    });
  }
  return findings;
}

// ── Check 4: AI invented a new agent/workflow/tool not named in the source ──
function checkAiInventedStructure(items) {
  const findings = [];
  for (const it of items) {
    if (!STRUCTURAL_TYPES.has(it.type)) continue;
    if (!it.data || it.data.system_generated !== true) continue;
    if (it.data.conflict_classification !== 'net_new') continue;
    const name = nameOf(it.type, it.data);
    const highStakes = it.type === 'agent_spec' || it.type === 'workflow';
    // Category is provenance, not risk — severity stays keyed on entity type either way.
    // best_practice_title only ever arrives via ai-config.js's applyBestPracticeGate, which
    // already verified the ref against a real, active rule at extraction time — never the
    // model's own unverified claim.
    const matched = Boolean(it.data.best_practice_ref && it.data.best_practice_title);
    findings.push({
      severity: highStakes ? 'warn' : 'info',
      category: 'ai_invented_structure',
      match_category: matched ? 'best_practice_match' : 'ai_suggestion',
      title: `${matched ? 'Best-Practice Match' : 'AI Suggestion'}: ${humanType(it.type)} "${name}"`,
      detail: matched
        ? `Not explicitly named in the source material — added because of the house rule "${it.data.best_practice_title}" (confidence ${it.confidence}). ${it.data.conflict_rationale || ''}`.trim()
        : `Not explicitly named in the source material — added as the AI's own judgment call, not backed by a specific house rule (confidence ${it.confidence}). ${it.data.conflict_rationale || ''}`.trim(),
      entities: [{ type: it.type, name, extraction_id: it.id, best_practice_ref: it.data.best_practice_ref || null }],
      suggested_action: 'Confirm this addition is wanted before it goes into the build.',
    });
  }
  return findings;
}

// ── Check 5: functional requirements with no acceptance criterion / test case ──
// Best-effort: correlates on the requirement's declared source numbering (e.g.
// "BRD FR-3"), not the final DB slug — real slugs aren't assigned until
// materialization, so this cannot be exact. Findings say so explicitly.
function parseFrNumber(str) {
  if (!str) return null;
  const m = String(str).match(/FR[-\s]?0*(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

function checkRequirementCoverage(items) {
  const findings = [];
  const frs = items.filter(it => it.type === 'functional_req');
  const acs = items.filter(it => it.type === 'acceptance_criterion');
  const tcs = items.filter(it => it.type === 'test_case');

  const acNums = new Set(acs.map(a => parseFrNumber(a.data && a.data.req_slug)).filter(n => n != null));
  const tcNums = new Set();
  for (const t of tcs) for (const ref of ((t.data && t.data.requirement_refs) || [])) {
    const n = parseFrNumber(ref);
    if (n != null) tcNums.add(n);
  }

  for (const fr of frs) {
    const n = parseFrNumber(fr.data && fr.data.source);
    if (n == null) continue; // system_generated FRs have no source numbering to correlate on
    const title = nameOf('functional_req', fr.data);
    const mustHave = fr.data && fr.data.priority === 'must_have';
    const caveat = 'Best-effort check based on the requirement\'s declared source numbering — final DB slugs aren\'t assigned until promotion, so re-verify afterward.';
    if (!acNums.has(n)) {
      findings.push({
        severity: mustHave ? 'warn' : 'info',
        category: 'coverage_gap',
        title: `No acceptance criterion for FR-${String(n).padStart(3, '0')}: "${title}"`,
        detail: caveat,
        entities: [{ type: 'functional_req', name: title, extraction_id: fr.id }],
        suggested_action: 'Add an acceptance criterion, or confirm this requirement doesn\'t need one.',
      });
    }
    if (!tcNums.has(n)) {
      findings.push({
        severity: mustHave ? 'warn' : 'info',
        category: 'coverage_gap',
        title: `No test case for FR-${String(n).padStart(3, '0')}: "${title}"`,
        detail: caveat,
        entities: [{ type: 'functional_req', name: title, extraction_id: fr.id }],
        suggested_action: 'Add a test case, or confirm this requirement is covered elsewhere.',
      });
    }
  }
  return findings;
}

// Pure function over a plain item list — independently testable without a DB.
function runChecks(items) {
  const findings = [
    ...checkSplitParents(items),
    ...checkLeafDuplicates(items),
    ...checkRequirementDuplicates(items),
    ...checkPlaceholders(items),
    ...checkAiInventedStructure(items),
    ...checkRequirementCoverage(items),
  ];
  const summary = { blocking: 0, warnings: 0, info: 0 };
  for (const f of findings) {
    if (f.severity === 'block') summary.blocking++;
    else if (f.severity === 'warn') summary.warnings++;
    else summary.info++;
  }
  return { findings, summary };
}

// DB-facing entry point — loads this ingest's currently staged extractions and
// runs the checks. Stateless: always recomputed from current staged state.
function runQualityCheck(db, ingestId) {
  const rows = db.prepare(
    "SELECT extraction_id, entity_type, confidence, entity_data FROM asdlc_ingest_extraction WHERE ingest_id=? AND status='staged'"
  ).all(ingestId);
  const items = rows.map(r => ({ id: r.extraction_id, type: r.entity_type, confidence: r.confidence, data: JSON.parse(r.entity_data) }));
  return { ingest_id: ingestId, ...runChecks(items) };
}

module.exports = { runQualityCheck, runChecks, nameOf, tokenize, jaccard, checkRequirementDuplicates };
