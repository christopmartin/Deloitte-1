# Plan: Complete ServiceNow import (read-side) — drop the Workbench-owned Fluent/manifest detour

> Rewritten 2026-06-23 (supersedes the original Tier A/B/C manifest plan of the same date).
> Status: plan only — not yet started.

## Context

The headline use case is unchanged: **import an entire ServiceNow application into the Workbench**
(reverse-engineer the whole app design) and, on re-import, let the existing AI conflict-resolution
pipeline reconcile rather than overwrite. The outbound direction is **same-instance drift fix**.

What changed is the architecture. The original plan proposed building a Fluent repo and storing
Tier B/C as manifest pointers to keep the DB lean. That premise was retired after three findings:

- **The Workbench is read-only against ServiceNow.** Every SN call is a GET
  (`agent/sn-capture.js`, `agent/sn-assess.js`); no PATCH/POST/PUT, no `now-sdk deploy`. Deployment
  is an offline handoff to Claude Code + now-sdk.
- **Fluent is the deployer's format.** now-sdk deploys from a Fluent app scaffold. Since the
  Workbench never writes, owning Fluent generation / a Fluent repo solves the deployer's problem in
  the wrong place. The deployer can `now-sdk init/transform` against the live instance at deploy time.
- **DB size was a non-problem.** Live DB ≈ 6 MB with `asdlc_sn_artifact` empty; payloads are
  audit-stripped (~hundreds of bytes–2 KB). Even aggressive multi-app import stays under ~100 MB.
  Manifest-only would relocate bytes (not remove them) and break the in-Workbench editor.

**The Workbench's job:** design intent + round-trip identity (`source_sys_id` + `source_hash`) +
deltas. On the same instance, deployable fidelity already lives in the instance.

## What the Workbench is / is NOT responsible for

| Concern | Owner |
|---|---|
| Complete, faithful **capture** of the app design (read) | **Workbench** |
| Editable **design intent** (Tier A rows; Tier C field values) | **Workbench** |
| **Round-trip identity** (sys_id + content hash) and drift detection | **Workbench** |
| Emitting **what changed** for handoff | **Workbench** |
| Generating deployable **Fluent** (`now-sdk transform`) | **Deployer** (Claude Code + now-sdk, at deploy time) |
| Holding a versioned **Fluent repo** | **Deployer** |
| Writing/PATCHing the **instance** | **Deployer** (prod stays read-only) |

## Phased work

**P1 — Complete capture (correctness; highest priority).** Every capture query is
`sysparm_limit=1000` with **no pagination** (`agent/sn-capture.js` Tier-A / generic / child query
builders). A from-scratch import of a large scope silently drops the 1001st row and looks complete.
Add offset/cursor pagination and loop until exhausted; surface per-surface captured counts; reuse the
`agent/sn-assess.js` pre-count to log expected vs. actual and warn on suspiciously round results.

**P2 — Complete child structures.** `CHILD_SURFACES` covers only Table→Column and Flow→Action.
Add the remaining parent/child relationships needed for faithful reconstruction (CatalogItem→Variable,
Form→Section, etc.), each captured with `parent_artifact_id` / `child_role` / `child_order`.

**P3 — Stop persisting faked `source_fluent` (the real DB win + removes a misleading signal).**
`source_fluent` is currently REST-derived (`JSON.stringify` of fields / raw script body in
`server.js` `snArtifactBody`), not real SDK output — it roughly doubles each artifact row and
*implies* deployability it doesn't have. Stop storing it. The delta-export already generates Fluent
**on demand** from `payload` + the registry `field_schema` (`server.js` ~6082 / ~6347–6391), so this
does **not** break export; it only removes the verbatim-`source_fluent` print in the Build Spec doc
section (~7220 / ~7428–7481), which should fall back to the on-demand emission. This is the honest
resolution of backlog #71's "or drop the path" option.

**P4 — From-scratch import + re-import conflict confirmation.** Confirm the sync route handles a
wholly-empty Workbench end-to-end and produces a complete design (Tier A L1 rows stamped with
`source_sys_id`/`source_hash`; Tier C captured). Verify re-import with pre-existing Tier A routes
conflicts through the existing reconcile / review / HITL pipeline (never blind-overwrite) — add a
regression test. Add a dry-run pre-flight summary ("would import N tables, M rules, K artifacts;
P conflicts to review").

### Explicitly NOT in scope (handed to the deployer / dropped)
- **Building a Fluent repo inside the Workbench** — deployer-side; generated at deploy time.
- **Wiring `now-sdk transform` into the Workbench** (original Phase 2) — reframed under #71; do not adopt.
- **Manifest-pointer storage for Tier B/C** (original Phase 3) — relocates bytes, breaks the editor,
  solves a DB-size problem that does not exist at realistic scale.

## Handoff contract (what the Build Spec must carry for the deployer)
For each changed artifact: `source_sys_id` (PATCH-vs-POST discriminator), `source_hash` (drift basis),
type + scope, parent/child structure, and the current design intent (`payload` + `override_fields`).
The deployer regenerates real Fluent from this against the live instance. On-demand Fluent emission in
the Build Spec stays as a *hint*, not a stored artifact.

## Critical files
- `agentic-sdlc-workbench/backend-node/agent/sn-capture.js` — pagination (P1), child surfaces (P2).
- `agentic-sdlc-workbench/backend-node/agent/sn-assess.js` — pre-count reused for completeness (P1/P4).
- `agentic-sdlc-workbench/backend-node/agent/sn-sync.js` — plan assembly.
- `agentic-sdlc-workbench/backend-node/server.js` — `/servicenow/sync` route; delta-export
  (`sn_generic_artifacts`, ~5983 / ~6082 / ~6347); Build Spec doc section (~7220 / ~7428); stop
  persisting `source_fluent` (`snArtifactBody`).
- `agentic-sdlc-workbench/backend-node/schema.sql` + `db.js` — `asdlc_sn_artifact` (no new pointer
  column needed; P3 may retire `source_fluent` writes).

## Verification
- **Pagination (P1):** point at a scope with >1000 columns / >1000 business rules; assert captured
  count == `sn-assess.js` pre-count. Today this silently truncates — the test fails before, passes after.
- **Child completeness (P2):** import an app with catalog items + multi-section forms; assert variables
  and sections are captured with correct parent/child/order.
- **Drop source_fluent (P3):** after import, confirm `source_fluent` is no longer written; confirm the
  delta-export and Build Spec still emit Fluent (regenerated from payload); confirm artifact rows are
  ~half their previous size.
- **From-scratch (P4):** empty project → sync → all Tier A L1 rows created with provenance, Tier C
  captured, design complete.
- **Conflict on re-import (P4):** with Tier A present, re-run sync after mutating one SN record; assert
  a `changed` artifact routes to a HITL change packet (not auto-overwrite) and populated fields persist.

## Related backlog
- **#71** (now-sdk transform) — resolved toward **drop the path** in the Workbench; Fluent generation
  belongs to the deployer at deploy time.
- **#72** (non-prod deploy target) — still relevant; the Workbench being read-only satisfies much of it
  inherently. Keep prod read-only.
- **#79** (SN generic artifacts integration test) — the checklist P1/P2/P4 must satisfy.
