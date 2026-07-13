# Conflict Detection & Impact Analysis — Coverage Assessment

**Date:** 2026-07-13 · **Trigger:** user question — does the new ingest-integrated ServiceNow discovery planner search for conflicting requirements when it pulls in ServiceNow data, and more broadly, is conflict detection sufficient given it's a Tier-1 requirement? **Method:** two independent full-file code-tracing passes (exhaustive reads + grep, no assumptions) over `cross-check.js`, `sn-discovery-planner.js`, `sn-sync.js`, `sn-reconcile.js`, `three-way-merge.js`, `sn-capture.js`, `sn-review.js`, and every `server.js` call site touching any of them. Cross-checked against the 2026-06-11 critical-AI-capabilities review and 2026-07-03 round-trip fidelity assessment.

## Executive summary (business language)

The Workbench has **three separate "conflict" mechanisms**, each covering a different, narrow slice. None of them cover the specific case the user asked about: a new requirement, paired with ServiceNow data pulled in to support it, being checked against each other or against what ServiceNow already does.

1. **Requirement vs. requirement** (`cross-check.js`) — when a document is uploaded, any new or changed FR/NFR is compared, by AI, against the requirements already in the Workbench. Catches contradictions and duplicates in the *wording* of requirements. Confirmed working. **Never reads ServiceNow data of any kind.**
2. **ServiceNow field-value conflicts** (the sync/reconcile engine) — when a record that was already imported before changes on *both* the Workbench side and the ServiceNow side between two syncs, the system flags it for human review. This is the mechanism most people mean by "ServiceNow round-trip conflict detection." Confirmed working, but **it can only ever fire on a record the Workbench has already seen and linked before.**
3. **Post-approval ripple check** (also `cross-check.js`, shared code) — after any change is approved (a human approval or a ServiceNow auto-apply), a check re-scans for dependent content gone stale. **Explicitly skips brand-new records** — it only looks at edits and deletions.

**The gap:** a ServiceNow record that is entering the Workbench for the very first time — which is exactly what happens every time the new discovery planner's approved import runs — is *structurally excluded from all three mechanisms at once*. It isn't old enough for mechanism 2 (no prior link to compare against), it's the wrong operation type for mechanism 3 (a "create," not an "edit"), and mechanism 1 never looks at ServiceNow content regardless. It goes from ServiceNow straight into the design with only an AI confidence check — no contradiction check against the requirement that justified pulling it in, and no contradiction check against anything else already in the design.

This is not a brand-new problem introduced by the discovery planner — the 2026-07-03 assessment already flagged the general shape of it (its gap G8: "net-new SN records are auto-created as 'universally safe' with no semantic-contradiction check against existing design intent") and rated it low severity, because at the time it was an edge case inside a broad, occasional import. **The discovery planner changes the stakes, not the mechanism**: it makes "type a requirement, then pull in the ServiceNow data behind it" a first-class, everyday action — so the uncovered case is now squarely in the middle of the most common new-requirement workflow, not a rare corner.

A second, unrelated defect was found in the process: the new-requirement-vs-existing-requirement check (mechanism 1's newest half) has **no fallback and is silently skipped whenever the AI key isn't configured** — inconsistent with the rest of the same file, which does have a fallback for other conflict types. This is a "must work consistently" violation in its own right.

## Direct answer to the question asked

**"Will entering a new requirement and pulling in ServiceNow data result in a search for possible conflicting requirements?"**

No. The discovery planner's job is narrowly scoped to *which ServiceNow tables to pull* — it reads the new requirement only to decide relevance, never to check it for contradictions. Its own "ask a human" mechanism (`clarifications[]`) is explicitly defined, in its own prompt instructions, as being for table-selection ambiguity only ("a real ambiguity where a human's answer would change which table(s) you pick") — never for a substantive conflict. It does not call, import, or otherwise reach the module that does requirement-conflict detection. Confirmed by reading the full file and grepping it for "conflict" — zero matches.

Separately, the requirement itself *does* get checked against other existing requirements — but that check runs earlier, at document-extraction time, and compares text to text. It is unconnected to the ServiceNow pull and never sees ServiceNow content.

## The three mechanisms, precisely

### 1. Requirement vs. requirement (`agent/cross-check.js`)

- **`scanRequirementConflicts`** (lines 314–352): when an existing requirement-linked entity is updated or deleted, an AI call checks whether any *existing* requirement is contradicted or made stale. Sends the changed entities + existing requirement list + (incidentally) up to 6,000 characters of the source document's raw text.
- **`scanNetNewConflicts`** (lines 359–405, the 2026-06-11 fix, backlog #60): when a document stages a **brand-new** FR/NFR, an AI call checks it against the existing requirement list for contradiction, duplication, narrowing, or supersession.
- Both run automatically, unconditionally, every extraction round (`agent/processor.js:38`), and a medium/high-severity hit becomes a **blocking** clarification — the document cannot be promoted into the design until a human resolves it (`hasOpenConflicts`, checked at `server.js:9409-9410`, HTTP 409 if open).
- Verified by grep across the whole file: **no query, prompt, or comparison ever touches a ServiceNow table, `source_fluent`, or `source_sys_id`.** This module only ever compares requirement text (or design-corpus text) to other requirement text.
- **Defect found:** `scanNetNewConflicts` is gated only by `if (newReqs.length && hasKey())` (line 596) — no deterministic fallback. The update/delete path has one (token-matching, lines 630-637); the net-new path does not. **In stub/no-API-key mode, a brand-new requirement's conflict with existing requirements is never checked, silently.**

### 2. ServiceNow field-value conflicts (`sn-sync.js` / `sn-reconcile.js` / `three-way-merge.js`)

- Every captured ServiceNow record is looked up by its ServiceNow ID against prior Workbench links (`sn-capture.js:858`). **If no link is found, the record is unconditionally classified `new` (line 866) and the entire conflict apparatus below is skipped.**
- Only for a record with a prior link, and only when it changed on the ServiceNow side since the last sync, does the system compute whether the Workbench side *also* changed since the last sync (`wb_edited_since_sync`) and route genuinely disputed fields to a human for review, with a plain-language explanation of who changed what.
- This mechanism is completely independent of mechanism 1 — confirmed by grep, zero cross-references in either direction. It has never read a requirement, and cross-check.js has never read ServiceNow data.
- A first-time-captured record instead goes: reverse-engineer → (non-destructive "create," hardcoded) → an auto-approval step that **doesn't even invoke the reviewing AI** → applied to the design once a confidence threshold clears. No conflict check anywhere in that path.

### 3. Post-approval ripple check (`runPostApplyCheck`, still `cross-check.js`)

- Runs after every Change Packet is applied — both a human clicking Approve and a ServiceNow sync auto-applying a packet share the exact same underlying function (`server.js:1307`, called from both `server.js:1364` and `server.js:10037`).
- But it explicitly filters to update/delete operations only (`if (it.operation !== 'update' && it.operation !== 'delete') continue;`) — a brand-new record (always a "create") is skipped by construction.

## Why the discovery planner doesn't close the gap

Traced end to end: a user drafts a requirement in the ingest form → the discovery planner reads that requirement plus a **table-level inventory** (table names, record counts, a reference graph — no actual ServiceNow record content) → proposes which tables to pull, tied to the requirement → the user approves → the next ServiceNow sync executes the pull. Every record behind a freshly-approved slice is, by definition, new to this Workbench project, so mechanism 2 above is structurally unreachable for it on that first pass, mechanism 3 excludes it as a "create," and mechanism 1 was never wired to see it in the first place. The planner's own AI call never receives ServiceNow field-level content to reason about — only table identity and counts — so even if it wanted to flag a contradiction, it has nothing to check against.

## Verdict against the Tier-1 bar

**Not sufficient**, on two distinct counts:

- **Coverage gap:** no mechanism anywhere checks a new requirement (or the ServiceNow data pulled in to support it) against what ServiceNow is actually configured to do. This is a real, confirmed absence, not a maybe.
- **Consistency gap:** the one requirement-vs-requirement check that is closest to the ask has a silent failure mode (stub mode) that the rest of the same module already guards against elsewhere.

## Logged to backlog

- **#112** (defect) — the stub-mode silent-skip.
- **#113** (decision point) — the ServiceNow-content contradiction-check gap, extending 2026-07-03's G8 now that the discovery planner makes this path common rather than an edge case.

## Addendum — a fourth, distinct scenario (user follow-up, same day)

The user described a related but different situation: a NEW requirement is entered, and it duplicates or substantially overlaps something that **already exists in the live ServiceNow instance** (not the Workbench database) — they want to be notified before a redundant object gets created. This is not the same as #113.

- **#113** is about data *already decided* to be imported, checked (or not) afterward against the requirement that drove the pull.
- This new scenario is about the moment a requirement is *entered* — before any table/import decision is made — searching the live instance's actual records for something that already covers it.

**The closest existing mechanism runs the opposite direction and is too shallow to help.** `computeCollisions()` in [agent/sn-instance-catalog.js:173-201](../../backend-node/agent/sn-instance-catalog.js) does compute "does this collide with what's already on the instance" — but only for Workbench-authored entities the Workbench is **about to deploy out** to ServiceNow (export-prep time), matched by **exact normalized name only** (`norm(entry.name) !== target`, line 190). The identity sweep it draws from is deliberately shallow by design — "NO scripts, NO descriptions, NO payloads" (module header, lines 7-8) — so even pointed the other way, it could catch an exact-name clash but not a close paraphrase or a big-overlap-but-differently-named record. It also requires a separate, explicit "catalog run" to have been executed first; it isn't triggered by requirement entry at all.

**What would be needed:** a check triggered at requirement-entry time that (a) has access to enough live-instance record content (at minimum names + short descriptions, not just identity fields) to judge overlap, and (b) uses an AI comparison (not exact string match) to judge "duplicate / close duplicate / big overlap" the way the user described it, rather than only catching an identical name. The existing identity-only sweep could supply candidate records to check against; it does not by itself do the judging.

Logged separately as **#114** (decision point) — related to #113 (same root theme: nothing evaluates a requirement against ServiceNow's actual content) but a different trigger point and a different mechanism, so tracked as its own item rather than folded in.
