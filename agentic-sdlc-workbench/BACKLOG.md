# Agentic SDLC Workbench — Backlog

> Items are logged in rough discovery order. Update status as work progresses.
> Types: **Feature** | **Defect**

---

## ✅ Completed

| # | Type | Description |
|---|------|-------------|
| #3 | Feature | Cost scoping — per-Application planning/entitlement fields; global pricing stays on rate card |
| #5 | Feature | Draft Agent Prompt via Claude — AI-assisted system prompt drafting with stub fallback |
| #8 | Feature | Automated requirements → test cases traceability |
| #9 | Feature | Design Repository Quality Reviewer + CP Audit Trail — on-demand AI auditor, findings panel, CP history panel |

---

## 🐛 Open Defects

| # | Description |
|---|-------------|
| #2 | Fix logon/auth flow |
| #4 | Fix report formatting for Tools, Agents, Workflows, Use Cases |
| #17 | CP action buttons (Approve / Reject / Send Back) remain active after a terminal action — should be greyed out |
| #18 | Cost projections not updated after a CP approval adds or modifies Assist-consuming entities (Agents, Workflows, Use Cases) |
| #22 | Orphan requirements — BRD-extracted FR/NFR can materialize with `use_case_id = NULL` when the AI Agent omits `use_case_title` (or it doesn't match a same-packet use case). Strengthen prompt/linking so requirements attach to their use case. |

---

## 🚀 Open Features

| # | Description |
|---|-------------|
| #1 | Source doc links — save traceability links from source documents to design artifacts |
| #6 | Show cost estimating logic in the UI — transparency on how Assist counts are calculated |
| #7 | AI-summarised requirements from unstructured documents |
| #10 | Baselines & versioning — mark baseline snapshots, compare to current (deferred from #9; implementation shape TBD at planning time) |
| #11 | Client-level (cross-Application) document library — store and recall reference docs across Applications |
| #12 | Per-Application source-material inventory — track docs, recordings, transcripts tied to an Application |
| #13 | Requirement dedup / similarity check agent — flag near-duplicate or overlapping requirements |
| #14 | Recording + transcription agent — multi-speaker capture and transcription into the Design Repository |
| #15 | Conflict cross-pointers — bidirectional links between conflicting requirements |
| #16 | Model tiering — Opus for complex work (ingest, full-app audit, conflict detection), Sonnet for lighter tasks; single `model-policy.js` config |
| #19 | RAG best practices documents — better mechanism for ingesting and managing reference material (standards, guidelines, playbooks) for agent retrieval |
| #20 | Fix Supporting Evidence functionality — buttons currently do nothing useful; wire up to meaningful actions |
| #21 | Per-Application Claude/AI cost view — surface AI usage & spend at the Application (project) level, not only in the global Admin AI Settings; roll up `asdlc_ai_usage` by `project_id` so Opus-heavy work (e.g. ServiceNow reconciliation/extraction) is attributable to the right Application |
| #23 | Inference dials beyond materiality (fast-follow to the materiality gate) — pre-run cost estimate / dry-run projection, per-run budget ceiling, per-item *adaptive* reverse-engineer effort, cheap→Opus *escalation*, and Economy/Balanced/Maximum **Effort Profile** presets bundling model+thinking+materiality. Floor today: per-role config in `ai-config.js` + post-hoc `asdlc_ai_usage`. |
| #24 | Reverse-path "force-elevate" — let a human promote a previously *captured-not-elevated* ServiceNow logic artifact into a Level-1 `business_logic` design row (e.g. from the sync report), and re-capture its body on demand. |
| ~~#25~~ | ✅ Resolved — `catalog_item` is now an intentional forward-BRD extraction target: a customer-facing intake form is modelled as a Service Catalog record producer (variables = fields), distinct from `form_design` (internal record layout). Prompt clarifies the choice. |
