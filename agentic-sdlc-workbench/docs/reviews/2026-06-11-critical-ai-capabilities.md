# Critical Review — The Three Crown-Jewel AI Capabilities

**Date:** 2026-06-11 · **Commit at review:** `27a9d64` · **Method:** three parallel deep-dive subagents over the live code, top findings hand-verified against source.

These are the three AI capabilities the product is built around; this review looks for weakness in each as it stands in the code. Severity rubric: **CRITICAL** = capability fundamentally fails its standard or risks data loss/spend; **HIGH** = major gap degrading reliability/quality; **MEDIUM** = works but costs maintainability/quality; **LOW** = minor.

## Summary

| Capability | Health | Headline risk |
|---|---|---|
| 1 · Initial ingest | ⚠️ Under-delivers on its goal | "Fill-in-the-blanks" off by default; not ServiceNow-aware; key structure rule-derived, not AI-authored |
| 2 · Change processing | ⚠️ Real engine, three serious gaps | Net-new contradictions never flagged; "versioning" is hollow; changes don't ripple |
| 3 · ServiceNow round-trip | ✅ Far more built than feared, loop not closed | No sys_id write-back → duplicates on 2nd pass; push-back is a manual handoff |

| Severity | Cap 1 | Cap 2 | Cap 3 |
|---|---|---|---|
| Critical | 2 | 3 | 2 |
| High | 5 | 4 | 2 |
| Medium | 3 | 4 | 1 |

> **Note (2026-06-11):** the same-day "platform-tagged AI Guidance" build (commit after `27a9d64`) addresses Cap-1's ServiceNow-awareness findings and the cross-cutting "guidance reaches only 2 of 8 AI processes" gap. See **Remediation status** at the end. Findings below are written as reviewed; status is marked inline where it changed.

---

## Capability 1 — Initial ingest

The two-tier Sonnet→Opus pipeline exists and runs on round 1 and fills many blank fields. But the *creative* half of the standard — proactively adding what a senior architect would add — was default-off, ServiceNow-blind, token-throttled, and propped up by deterministic post-hoc repair.

- **[CRITICAL] claude-processor.js:388-428** — "Fill-in-the-blanks" net-new generation is gated behind the *Suggestive* enrichment level, but every upload defaults to *Balanced* (schema.sql:741, server.js:7467). Balanced only fills empty fields on entities the document already evidenced; net-new best-practice elements (standard NFRs, implied data sources, missing tools) appear only in Suggestive. → Default to Suggestive, or make Balanced add net-new elements.
- **[CRITICAL] claude-processor.js:272-385 — ✅ ADDRESSED 2026-06-11** — No ServiceNow-specific extraction guidance; a generic BRD was never reasoned into SN constructs. *Now configurable via the AI Guidance tab: 8 seeded `platform='servicenow'` house rules (catalog item, business rule, UI policy, ACL, IntegrationHub, extend Task, notification, Flow Designer) inject into the extraction prompt for ServiceNow-tagged work.* → Curate/extend the seeded rules in the tab.
- **[HIGH] entity-registry.js + swimlane-deriver.js:14-16** — Swimlane participants/paths and step owners are never produced by the AI; a regex categorizer guesses lanes and builds naive linear paths. → Add extraction tools so the model authors swimlane structure.
- **[HIGH] design-repair.js + server.js:1360-1379** — FR/NFR→use-case links and swimlane structure are back-filled at *promote*, not ingest, so the staged design a reviewer inspects is structurally incomplete; the orphan-relink "single-UC fallback" (design-repair.js:40,60) silently misattributes requirements in multi-use-case projects. → Resolve links at stage time; replace the fallback with a clarification when ambiguous.
- **[HIGH] quality-reviewer.js:605-672 + server.js:2289,2308** — The quality-review pass does NOT run in the ingest path (two manual endpoints only), and even when run it only logs findings (no corrective feedback). → Auto-invoke after promote; feed high-severity findings back.
- **[HIGH] document-reader.js:37-52** — PDF is unsupported and fails to *garbage*, not error: a `.pdf` is read as raw bytes and sent to Claude, producing a hollow-but-plausible design. → Add a PDF reader; make unknown/binary types fail the ingest.
- **[HIGH] ai-config.js:62-65 + claude-processor.js:549** — The Opus synthesis pass (where "creation is the core job") is capped at the same default max-tokens (8192) as plain extraction, while the SN modules raise their floor to 12000. → Give synthesis its own higher token floor.
- **[MEDIUM]** Synthesis skipped on every clarification round > 1 (claude-processor.js:998-1007); stub-processor silently substituted with no API key (processor.js:15-21); cap-hit yields a partial design with no "incomplete" signal (claude-processor.js:627-629).

---

## Capability 2 — Change processing / reconciliation

More is built than feared: a real multi-tier conflict/ripple checker (cross-check.js), transactional apply/promote/mass-approve, re-ingest sees the existing design, and clarification-round dedup is handled. Three serious gaps remain.

- **[CRITICAL] cross-check.js:334-352** — Conflict detection only scans `update`/`delete` items (`if (op !== 'update' && op !== 'delete') continue;`). A NEW requirement that contradicts an existing FR/NFR — the most common "conflicting requirement arrives" case — is classified net-new and staged additively with no conflict raised. → Run a net-new-vs-existing contradiction scan; raise blocking conflict clarifications.
- **[CRITICAL] server.js:1771-1789, 1998** — "Versioning" creates an `asdlc_baseline` shell with counts defaulting to 0 and never writes any `asdlc_baseline_item` snapshot; "compare" diffs only those always-zero counters. No point-in-time snapshot, no rollback — prior design state is unrecoverable after apply. → Snapshot real entity/field state at lock; make compare diff snapshots.
- **[CRITICAL] server.js:7224-7337** — The ServiceNow sync handler does three write groups with no enclosing transaction (HITL CP insert, AUTO CP insert+apply, hash-advance loop); a mid-way failure leaves the design partially hash-advanced. → Wrap the whole materialize/apply/hash-advance block in one transaction.
- **[HIGH] server.js:7197-7211** — On a SN `changed` conflict, proposed values are stashed in `entity_data._sn_proposed`, which is not a field-map key, so approving the change writes nothing — the value the reviewer intended to accept is silently dropped. → Promote `_sn_proposed` into real fields on accept.
- **[HIGH] server.js:953-1011 (mtCreate)** — A `create` never checks for an existing same-identity row; a second document describing the same workflow/agent duplicates it unless the model tags it `update` with a correct target_slug. → Add a deterministic identity match in mtCreate.
- **[HIGH] server.js:1370-1379 + cross-check.js:426-466** — Propagation is detect-but-don't-repair: dependent steps/paths/prose are flagged stale with a banner, never updated (the WF-001 symptom, systemic). → Auto-open a follow-up packet proposing the dependent edits.
- **[HIGH] server.js:6757-6781 (#40 path)** — The standing-question fill still issues a project-wide bulk UPDATE from one free-text answer (now `IS NULL`-guarded + audited, but no per-row review). → Route standing-answer fills through a staged, reviewable change packet.
- **[MEDIUM]** No concurrency guard serializes overlapping promote/approve/sync on one project; the CP-level audit + version-bump audit run after COMMIT (server.js:740-747); `auditLog` swallows all failures (db.js:746-765); the ripple corpus omits FR/NFR/business_logic/forms/data_models prose (cross-check.js:97-129).

---

## Capability 3 — ServiceNow round-trip ("the magic")

The inbound half is genuinely built AND tested. Reverse intake, the sys_id link storage (the linchpin), the 2-layer hybrid, drift detection, and a correct non-duplicating delta export all exist. The "drift over the last few days" is new *additive* work, not a regression. The gaps are in closing the loop.

**Status of each piece:** reverse intake — BUILT (sn-capture.js:55); link storage — BUILT & populated (`source_*` columns, schema.sql:382-388, written server.js:7155-7197); 2-layer hybrid — BUILT (sn-reconcile.js:96-108); build spec / delta export — BUILT (server.js:5421); push-back/deploy — ABSENT as automation (Markdown handoff); sync/drift — BUILT; prod read-only — PARTIAL (text only).

- **[CRITICAL] no endpoint — round-trip not closed** — After pushing a Workbench-authored entity into SN, nothing writes the returned sys_id back onto the Workbench row (only inbound paths write `source_sys_id`). It stays NULL → the next delta export re-classifies it as a POST (server.js:5481-5482) → **duplicate record**. → Add `POST /projects/:id/servicenow/register-sysid` and call it from the deploy step (or auto-reconcile via a validation sync right after deploy).
- **[CRITICAL] server.js:5662-5674** — Push-back is a manual Markdown handoff; nothing in the Workbench invokes the SN SDK/Table API to write. Measured against "re-push WITH Claude Code + SDK," the Workbench side is unimplemented. → Decide explicitly: keep as a documented handoff (and close the sys_id seam), or build a real deploy endpoint that writes sys_ids back.
- **[HIGH] fluent-ingest.js:15-22** — The cleaner Fluent-transform intake (`now-sdk init/transform`) is a TODO comment; today L2 `source_fluent` is populated from REST fields, not a real SDK Fluent transform. → Wire the now-sdk transform if Fluent fidelity matters, else drop the path.
- **[HIGH] server.js:5617** — "Never deploy to prod" is prose, not enforced; intake creds aren't constrained to non-prod. → Add an explicit non-prod check on the link/sync endpoints.
- **[MEDIUM] server.js:7252,7316** — SN sync leaks raw `err.message` (instance URL/cred hints) and isn't transactional (already BACKLOG #41). → Scrub the error; wrap in a transaction.

---

## Remediation status (2026-06-11)

**Implemented this session — "platform-tagged AI Guidance, consumed by every AI process":**
- Platform dimension added: `asdlc_project.target_platform` (default `servicenow`), `asdlc_ingest_document.platform` (nullable = inherit), `asdlc_best_practice.platform` (`any`/`servicenow`/`generic`, default `any` = backward-compatible). schema.sql + three db.js migrations.
- `ai-config.getActiveBestPractices(scopes, platform)` + `getProjectPlatform()`; platform filter is additive.
- Guidance now consumed by **all 8 AI processes** (was 2): extract/reconcile/synthesis, quality-reviewer, cross-check (both LLM tiers), prompt-drafter, sn-reverse-engineer / sn-reconcile / sn-review (separate uncached block to preserve prompt caching), rasic-deriver.
- Platform selectors on the AI Guidance tab, ingest upload, and project create/edit.
- 8 editable ServiceNow design-heuristic house rules seeded (`platform='servicenow'`).
- Closes Cap-1 CRITICAL "not ServiceNow-aware" and the cross-cutting "guidance reaches only 2 of 8 processes" gap.

**Top remaining actions (recommended order):**
1. **Cap 3 — ServiceNow sys_id write-back** (CRITICAL). Smallest, highest-leverage; without it the full round-trip duplicates on the 2nd pass. Do before any end-to-end demo.
2. **Cap 2 — net-new conflict detection** (CRITICAL). Closes the biggest hole in "flag conflicts to the human".
3. **Cap 1 — default to Suggestive** (CRITICAL). The single biggest lift to perceived ingest richness now that ServiceNow guidance flows.
4. Cap 2 real versioning snapshots; Cap 1 PDF support + fail-loud; then the HIGH-severity items.
