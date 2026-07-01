# Agentic Workbench — Knowledge Transfer & Onboarding Guide

**Version:** 2026-07-01
**Audience:** New developers and team members joining the project
**Purpose:** Get oriented in under a day — understand what the tool does, navigate the code, know what's real vs. fake, and run it locally

---

## 1. What Is This Tool?

The Agentic Workbench is a **design-intelligence platform** for ServiceNow implementations. It solves a specific problem: when a client wants to build or modernize a ServiceNow application, the design work is expensive, error-prone, and hard to keep in sync with what's actually been built.

The tool does three things:

**1. AI Ingestion** — Upload existing documents (BRDs, process maps, meeting notes, SN config exports) and Claude reads them, extracts structured design entities (use cases, workflows, agents, tools, requirements, acceptance criteria, test cases), and populates a design database. Think of it as "AI fills in the blanks from your documents."

**2. Design Review & Management** — A structured workspace for reviewing, editing, and governing the AI-generated design. Supports change packets (tracked change proposals with approval workflow), baselines (snapshots for comparison), cost estimation for Now Assist, and quality review.

**3. ServiceNow Round-Trip** — Connect to a live ServiceNow instance, reverse-engineer its current configuration into the Workbench, reconcile it against the design, and (partially) write approved changes back to SN. This is the highest-value capability and is partially complete.

**Who uses it:** Deloitte consultants on ServiceNow engagements — primarily architects and analysts who need to design, document, and govern SN applications at scale.

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Browser (Vanilla JS SPA)                               │
│  frontend/app.js  →  frontend/modules/*.js (22 modules) │
│  No framework, no build step, plain ES modules          │
└────────────────────────┬────────────────────────────────┘
                         │ HTTP/JSON  (X-User-ID header — dev only)
┌────────────────────────▼────────────────────────────────┐
│  Node.js / Express  (backend-node/server.js)            │
│  188 routes, ~9,935 lines (monolith — refactor planned) │
│  async/await, multer for file uploads                   │
└──────┬─────────────────┬───────────────────┬────────────┘
       │                 │                   │
┌──────▼──────┐  ┌───────▼────────┐  ┌──────▼──────────┐
│  SQLite DB  │  │  Anthropic API │  │  ServiceNow API │
│  asdlc.db   │  │  Claude Opus / │  │  REST (per-proj │
│  68 tables  │  │  Sonnet / Haiku│  │  credentials)   │
│  WAL mode   │  │  @anthropic-ai │  │                 │
└─────────────┘  └────────────────┘  └─────────────────┘
```

### Request flow — typical page load
1. `app.js` reads `asdlc_user_id` + `asdlc_project_id` from `localStorage`
2. Module's `render(container)` is called; it fires `apiFetch()` calls
3. `apiFetch()` appends `X-User-ID` header and calls the Express API
4. Express queries SQLite, returns JSON
5. Module renders response into DOM via `.innerHTML`

### Request flow — AI ingestion
1. User uploads a document; POST to `/api/v1/ingest/documents`
2. Server stores document, returns immediately with `status: pending`
3. Frontend polls `GET /api/v1/ingest/documents/:id` every 3 seconds
4. Background async function calls Anthropic API (Sonnet for extraction, Opus for synthesis)
5. Results written to `asdlc_ingest_extraction`, status flips to `staged`
6. User reviews staged entities and clicks "Promote" to commit to design tables

---

## 3. Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Runtime | Node.js ≥ 22.5 | Required for built-in `node:sqlite` module |
| Web framework | Express 4.x | Single monolithic `server.js` (188 routes) |
| Database | SQLite via `node:sqlite` | WAL mode; raw parameterized SQL; no ORM |
| AI provider | Anthropic Claude | `@anthropic-ai/sdk` ^0.95.1; multi-model routing |
| SN integration | ServiceNow REST API | AES-256-GCM credential storage per project |
| File parsing | mammoth (DOCX), plain `fs` (TXT/CSV) | PDF not yet properly supported |
| Frontend | Vanilla JS ES modules | No React/Vue/Angular; no build step; no bundler |
| Styling | Single `frontend/styles.css` (38 KB) | CSS variables; light/dark mode vars |
| Document export | `docx` library | Used for Build Spec export to DOCX |
| Dev tooling | None currently | Linter, test runner, CI/CD all to be added |

---

## 4. Feature Inventory

### Status key
- ✅ **WORKING** — real API, real data, used in practice
- ⚠️ **PARTIAL** — core function works but specific capabilities are incomplete or have known bugs
- 🔲 **STUB** — UI exists but functionality is fake (alert/toast, no real API call)
- 🔮 **FUTURE** — designed or planned but not yet built

---

### 4.1 Navigation & Shell
**File:** `frontend/app.js`
**Status:** ✅ WORKING

The SPA shell. Reads user identity and active project from `localStorage`. Renders the sidebar nav, handles module routing, and provides shared utilities (`apiFetch`, `showToast`, `formatDate`).

> **Dev note:** No real login exists. A dropdown lets you pick from 5 pre-seeded demo users. This is the first thing replaced in the production build.

---

### 4.2 Dashboard / Home
**File:** `frontend/modules/home.js`
**Status:** ✅ WORKING

Landing page after project selection. Shows project summary stats (use case count, workflow count, open change packets, AI usage), recent audit activity, and quick-navigation cards.

---

### 4.3 Projects & Clients
**File:** `frontend/modules/projects.js`
**Status:** ✅ WORKING

Create and manage clients (`asdlc_client`) and projects (`asdlc_project`). Project settings include ServiceNow connection configuration (instance URL, username, encrypted password), AI model overrides, and cost parameters. Entry point for new client engagements.

---

### 4.4 AI Ingestion
**File:** `frontend/modules/ingest.js`
**Status:** ✅ WORKING (with gaps)

The primary AI data-entry mechanism. Users upload source documents; Claude extracts structured design entities and populates the design tables.

**What works:**
- Upload DOCX, TXT, CSV files
- AI extraction pipeline: Sonnet extracts, Opus synthesizes
- Staged review of extracted entities before promotion to the design
- Clarification Q&A: AI asks follow-up questions when source is ambiguous
- User feedback loop (thumbs up/down on individual extractions)
- Full ingest history with status tracking

**Known gaps:**
- ❌ PDF files produce garbage output — falls through to UTF-8 read (issue #64)
- ❌ RASIC fields not consistently populated — recurring AI regression (issue #36)
- ❌ Clarification auto-apply overwrites cost params project-wide (issue #40)
- ⚠️ If `ANTHROPIC_API_KEY` is missing, silently uses regex heuristics instead of Claude with no warning

---

### 4.5 Design Review
**File:** `frontend/modules/design_review.js` (6,151 lines — largest module)
**Status:** ✅ WORKING (mostly)

The central design workspace. Tabbed interface covering all design entity types.

**What works:**
- Use Cases — CRUD, AI-generated descriptions, acceptance criteria, test cases
- Workflows — CRUD with steps, participants, paths, RASIC assignments
- Workflow Steps — agent assignments, tool bindings, cost bindings, HITL gates
- Agent Specs — AI agent definitions with supervision model and trust level
- Tools — tool catalog per project
- Functional & Non-Functional Requirements — CRUD with traceability links to use cases
- Data Sources & Guardrails — BRD-level design elements
- User Stories — AI-generated from use cases
- Quality Review — AI-powered design quality assessment per entity
- Design Repair — automated fix suggestions for orphaned entities

**Known gaps:**
- ❌ Change packet action buttons remain active after terminal action (issue #17)
- ❌ Full page re-renders on single item edits — performance issue (issue #57)
- ⚠️ 6,151-line monolith makes parallel development difficult (refactor in production roadmap)

---

### 4.6 Change Packets
**File:** `frontend/modules/change_packets.js`
**Status:** ✅ WORKING

Governance workflow for design changes. Every significant edit is wrapped in a change packet for tracked approval.

**What works:**
- Create change packets with linked design entities
- Submit → Review → Approve / Reject / Send-back workflow
- Split a change packet into smaller packets
- Mass-approve multiple packets
- Full change packet history and audit trail

**Known gaps:**
- ❌ Action buttons stay active after terminal state (issue #17)
- ❌ SN-conflict approval silently drops the accepted value (issue #62)

---

### 4.7 ServiceNow Sync
**File:** `frontend/modules/servicenow_sync.js`
**Status:** ⚠️ PARTIAL

The round-trip integration with live ServiceNow instances.

**What works:**
- Connect to a SN instance (per-project encrypted credentials)
- Reverse-engineer SN app configuration into Level-1 design entities
- Assess alignment between SN config and Workbench design
- Delta export: generate set of changes to be applied to SN
- Reconciliation: detect differences between SN and design
- Instance catalog management

**What's incomplete:**
- ❌ SN sys_id write-back — pushing approved changes back into SN (biggest missing piece)
- ❌ Net-new conflict detection — SN changes since last ingest are not detected
- ⚠️ SN error details currently leaked to client response (security issue #41)

---

### 4.8 ServiceNow Assessment
**File:** `frontend/modules/servicenow_assessment.js`
**Status:** ✅ WORKING

AI-powered assessment of a SN application's design quality, completeness, and alignment with best practices. Produces a scored report with findings.

---

### 4.9 ServiceNow Catalog
**File:** `frontend/modules/servicenow_catalog.js`
**Status:** ✅ WORKING

Exports catalog item designs from the Workbench into SN-compatible format. Covers catalog item structure, variables, and workflow bindings.

---

### 4.10 SN Artifacts
**File:** `frontend/modules/sn_artifacts.js`
**Status:** ⚠️ PARTIAL

Phase 4 feature. Generic viewer and editor for SN artifacts (scripts, flows, tables) captured from a live SN instance. Core viewing works; editing pipeline is partial.

---

### 4.11 Cost Projections
**File:** `frontend/modules/cost_projections.js`
**Status:** ✅ WORKING

Now Assist cost modeling. Projects the cost of running AI-assisted workflows using per-step cost bindings and Deloitte rate cards.

**Known gap:** `/cost-estimate` endpoint hardcodes `claude-opus-4-5` instead of using admin-configured model (issue #43).

---

### 4.12 Cost Management
**File:** `frontend/modules/cost_management.js`
**Status:** ⚠️ PARTIAL

Manages per-project cost parameters (cost per assist, overage rates, annual entitlement, planning period). Core CRUD works.

**Known gap:** Cost management modal is missing CSS classes — functional but visually broken (issue #51).

---

### 4.13 Testing
**File:** `frontend/modules/testing.js`
**Status:** ⚠️ PARTIAL

Test case management. Covers test case CRUD, AI-powered gap analysis, and test coverage matrix.

**What works:** Test case list, create, edit, AI "infer gaps", coverage matrix view.

**Known gaps:**
- ❌ Assumes unpaginated `/projects` response — breaks with pagination active (issue #54)
- ⚠️ Some re-render performance issues on filter changes

---

### 4.14 Build Export
**File:** `frontend/modules/build_export.js`
**Status:** ⚠️ PARTIAL

Generates a Build Specification document from the finalized design and exports as DOCX.

**What works:** Build spec generation, DOCX export, preview.

**Incomplete:** SN write-back — auto-deploying build spec changes to a live SN instance requires the sys_id write-back capability in the SN sync module (not yet production-ready).

---

### 4.15 Baselines
**File:** `frontend/modules/baseline.js`
**Status:** ⚠️ PARTIAL

Design snapshot management. Create locked baselines at milestones; compare baselines to track design evolution.

**What works:** Create baseline, lock baseline, list view, comparison view.

**Known gap:** Baseline detail fetch uses the wrong ID field (`undefined`), breaking the detail view (issue #49).

---

### 4.16 Library
**File:** `frontend/modules/library.js`
**Status:** ✅ WORKING (with caution)

Cross-project entity reuse. Browse design entities from other projects and copy them into the current project.

**Known gap:** One library endpoint uses manual string escaping instead of parameterized queries — SQL injection risk (issue #39). Fix is a Phase 1 fast-win.

---

### 4.17 Evidence
**File:** `frontend/modules/evidence.js`
**Status:** ⚠️ PARTIAL

Links evidence sources (documents, requirements) to specific design entities for traceability.

**What works:** View linked evidence, navigate to source documents.

**Stub:** "Re-run Extraction" button shows a fake success toast with no real API call.

---

### 4.18 Validation
**File:** `frontend/modules/validation.js`
**Status:** ⚠️ PARTIAL

Design validation rules — checks the design for completeness, consistency, and best practices.

**What works:** Rule definition and display, basic validation runs.

**Incomplete:** Some validation rule types and the full natural language rule engine are partially implemented.

---

### 4.19 Audit Log
**File:** `frontend/modules/audit.js`
**Status:** ✅ WORKING

Read-only viewer for `asdlc_audit_log`. Every create/update/delete operation writes an audit entry. Filter by entity type, user, and date range.

---

### 4.20 Reports
**File:** `frontend/modules/reports.js`
**Status:** 🔲 STUB

Report templates for design deliverables (design summary, traceability matrix, BRD output).

**Current state:** Report list and template definitions exist. "Preview" and "Generate" buttons show fake success toasts. No real report generation. This is a v2 feature.

---

### 4.21 Admin — AI Settings
**File:** `frontend/modules/admin_ai.js`
**Status:** ✅ WORKING

Platform configuration for AI behavior. Override which Claude model is used per role (extraction, synthesis, quality review, etc.). Settings in `asdlc_app_setting`, read by `agent/ai-config.js` at runtime.

---

### 4.22 Admin — Best Practices
**File:** `frontend/modules/admin_best_practices.js`
**Status:** ✅ WORKING

Manage the library of best practices injected into AI prompts during ingestion and quality review. Add, edit, categorize, activate/deactivate.

---

### 4.23 Trust & Supervision
**File:** `frontend/modules/trust.js`
**Status:** ⚠️ PARTIAL

Configures AI agent trust levels and human-in-the-loop (HITL) gate requirements per workflow. UI for setting supervision model (autonomous / supervised / human-delegated).

**Incomplete:** Trust level configuration works. Runtime enforcement of HITL gates in workflow execution is not yet implemented.

---

## 5. Key Code Landmarks

| What you need | Where to look |
|---------------|--------------|
| All API routes (188) | `backend-node/server.js` — search for `app.get(`, `app.post(`, `app.put(`, `app.delete(` |
| Database schema (68 tables) | `backend-node/schema.sql` |
| DB helpers (generateId, nextSlug, auditLog) | `backend-node/db.js` lines 1–300 |
| Schema migrations (ALTER TABLE history) | `backend-node/db.js` lines 27–160 |
| AI model routing (which model for which role) | `backend-node/agent/ai-config.js` |
| AI ingestion orchestration | `backend-node/agent/` directory |
| AI prompt templates | `backend-node/agent/prompts/*.md` |
| SN REST client & credentials | `backend-node/server.js` (search `sn_instance`) |
| Credential encryption/decryption | `backend-node/crypto-util.js` |
| SN wiki context injection | `backend-node/agent/wiki-context.js` |
| Frontend SPA bootstrap & shared utils | `frontend/app.js` |
| Frontend module entry points | `frontend/modules/<name>.js` — each exports `render(container)` |
| All CSS | `frontend/styles.css` |
| Backlog of known issues | `BACKLOG.md` |
| Architecture overview | `ARCHITECTURE.md` |

---

## 6. Data Model — Key Entities

The database has 68 tables. These are the ones you'll encounter most:

```
asdlc_client               Organization (Deloitte client)
  └── asdlc_project        Engagement / application scope
        └── asdlc_project_member    User ↔ Project membership

asdlc_use_case             Discrete business capability
  └── asdlc_workflow       Process that fulfills a use case
        └── asdlc_workflow_step     Individual steps in the process
              └── asdlc_agent_spec  AI agent that executes the step
              └── asdlc_tool        Tools the agent uses
              └── asdlc_hitl_gate   Human approval checkpoints

asdlc_functional_req       Functional requirements (linked to use cases)
asdlc_nonfunctional_req    NFRs
asdlc_acceptance_criterion Acceptance criteria per use case
asdlc_test_case            Test cases (manual and automated)

asdlc_ingest_document      Uploaded source document
asdlc_ingest_extraction    AI-extracted entity (staged, pre-promotion)
asdlc_ingest_clarification AI follow-up Q&A during ingestion
asdlc_ingest_feedback      User thumbs up/down on extractions

asdlc_change_packet        Tracked change proposal
asdlc_change_packet_item   Individual entity changes within a packet

asdlc_baseline             Design snapshot at a milestone
asdlc_audit_log            Every write operation (who, what, when, before/after)
asdlc_ai_usage             Every Claude API call (tokens, cost, model, role)

asdlc_app_setting          Key/value config store (AI model overrides, etc.)
asdlc_assist_rate_card     Now Assist pricing per skill/tier
asdlc_workflow_step_cost_binding  Cost per step for projections
```

### Key patterns
- **UUID primary keys** — TEXT, generated by `db.generateId()`
- **Slugs** — human-readable IDs (`UC-001`, `WF-002`) generated by `db.nextSlug()`
- **JSON in TEXT columns** — goals, fields, relationships stored as JSON strings; migrating to `jsonb` in PostgreSQL
- **Soft delete** — `lifecycle_status` column (`active` / `archived` / `deprecated` / `retired`)
- **Audit trail** — `db.auditLog()` called on every write; stores before/after state
- **SN provenance** — SN-sourced entities carry `source_system`, `source_sys_id`, `source_table`, `source_fluent`, `source_hash` for round-trip identity

### Multi-tenancy note
Every design entity carries `project_id`. Projects carry `client_id`. The schema is correct but the API does **not yet verify** that the authenticated user belongs to the requested project. This is the primary security gap — fixed in the production roadmap (Phase 4 of the work plan).

---

## 7. AI Integration

### Models in use

| Role | Default Model | Purpose |
|------|--------------|---------|
| `EXTRACTION` | claude-sonnet-4-6 | Document extraction, entity parsing |
| `SYNTHESIS` | claude-opus-4-8 | Cross-document synthesis, design generation |
| `QUALITY_REVIEWER` | claude-sonnet-4-6 | Design quality assessment |
| `COST_ESTIMATOR` | claude-opus-4-8 | Now Assist cost estimation |
| `RECONCILER` | claude-opus-4-8 | SN reconciliation, conflict detection |
| `LIGHTWEIGHT` | claude-haiku-4-5 | Simple classification, formatting |

All models are configurable via Admin → AI Settings; overrides stored in `asdlc_app_setting`.

### How prompts work
Prompts are externalized Markdown files in `backend-node/agent/prompts/*.md`, loaded at runtime by `prompt-templates.js`. Prompt changes don't require code deployments — just edit the `.md` file.

The ingest loop injects a small SN context block into every prompt, plus a `read_wiki_page` tool that lets Claude pull detailed SN design reference on demand (progressive disclosure — avoids loading 33K tokens on every call unless needed).

### Usage tracking
Every API call is logged to `asdlc_ai_usage` with input tokens, output tokens, estimated cost, model used, and the role that triggered it. Viewable in Admin → AI Settings.

### Extended thinking
Opus calls for reasoning-heavy tasks (reconciliation, synthesis) use Anthropic's extended thinking (adaptive mode) when enabled. Adds latency but significantly improves quality on complex design work.

---

## 8. ServiceNow Integration

### Connection model
Each project has its own SN connection (instance URL, username, password). Passwords are stored AES-256-GCM encrypted in `asdlc_project.sn_password_enc` using `ASDLC_ENCRYPT_KEY` from the environment.

> **Important:** If `ASDLC_ENCRYPT_KEY` is not set, credentials fall back to plaintext with a `"plain:"` prefix. Always set this key.

### Corporate TLS issue
Deloitte's SSL inspection proxy causes `SELF_SIGNED_CERT_IN_CHAIN` errors on SN calls. Dev workaround: set `SN_INSECURE_TLS=true` in `.env`. **This is not acceptable for production.** The production fix is `NODE_EXTRA_CA_CERTS=<path-to-deloitte-proxy-cert>`.

### Fluent notation
The round-trip identity system uses "Fluent notation" — an internal intermediate representation (IR) that encodes SN design objects in a normalized form. When an entity is ingested from SN, its Fluent representation is stored in `source_fluent`. When writing back, Fluent is used to map Workbench design changes to the correct SN sys_ids. This is what makes the round-trip reliable rather than fragile name-based matching.

### Round-trip status
| Capability | Status |
|-----------|--------|
| Read from SN (reverse-engineer) | ✅ Working |
| Assess alignment | ✅ Working |
| Reconcile + delta export | ✅ Working |
| Write back to SN (sys_id) | ⚠️ Partially implemented |
| Detect SN changes since last ingest | ❌ Not built |

---

## 9. Local Development Setup

```bash
# Prerequisites: Node.js >= 22.5, Git

# 1. Clone and install
git clone <repo-url>
cd agentic-sdlc-workbench/backend-node
npm install

# 2. Create .env file
# Copy from .env.example if it exists, or create manually:

ANTHROPIC_API_KEY=sk-ant-...           # Get from Anthropic console — required for real AI
ASDLC_ENCRYPT_KEY=any-32-char-secret   # For SN credential encryption — set this
PORT=8000                               # Optional, defaults to 8000

# Optional — for ServiceNow integration:
SN_INSTANCE=https://your-instance.service-now.com
SN_USER=admin
SN_PASSWORD=...
SN_INSECURE_TLS=true                   # Required on Deloitte network

# 3. Start the server (seeds demo data automatically on first run)
node server.js

# Server output: "Agentic SDLC Workbench running on port 8000"

# 4. Open the frontend
# Double-click: agentic-sdlc-workbench/Launch Workbench.bat
# Or open: frontend/index.html directly in Chrome/Edge

# 5. Select a demo user from the dropdown (no password needed in dev)
# Demo users: Alice Chen, Bob Martinez, Carol Johnson, David Lee, Emma Wilson
# Select any project to start exploring
```

### Useful dev scripts
The `backend-node/` directory contains 11 manual test scripts (`test-*.js`) for exercising specific subsystems:

```bash
node test-reverse-l1.js          # Test SN reverse-engineering
node test-sn-sync.js             # Test SN sync pipeline
node test-roundtrip-inbound.js   # Test inbound round-trip
node test-instance-catalog.js    # Test instance catalog
```

These are **manual exploration scripts, not a test suite** — no assertions, no framework. They're useful for debugging but not for CI.

---

## 10. Known Issues & Backlog

Full backlog is in `BACKLOG.md`. Here are the highest-priority items:

### Critical — fix before any multi-user use

| # | Issue | Impact |
|---|-------|--------|
| #2 | No real authentication — only HTTP header | Anyone can impersonate any user |
| #37 | Non-transactional multi-writes in promote and SN sync | Data corruption on mid-loop failure |
| #38 | No Express error middleware | Silent failures, bare 500s |
| #39 | `/library` uses manual string escaping | SQL injection risk on one endpoint |
| #42 | Migration error swallowing in `db.js` | Failed schema changes go unnoticed |
| #73 | No write serialization on concurrent promote/approve/sync | Data corruption under concurrent load |
| #76 | `ASDLC_ENCRYPT_KEY` optional | SN credentials stored in plaintext if key missing |

### High — functional failures

| # | Issue |
|---|-------|
| #17 | CP action buttons stay active after terminal action |
| #36 | RASIC not populated (recurring AI regression) |
| #40 | Clarification auto-apply overwrites cost params project-wide |
| #41 | SN sync error detail leaked to client response |
| #43 | `/cost-estimate` hardcodes `claude-opus-4-5` model |
| #49 | Baseline detail fetch uses undefined ID field |
| #54 | `testing.js` assumes unpaginated `/projects` response |
| #62 | SN-conflict approval silently drops accepted value |
| #64 | PDF ingest produces garbage output |

### Medium — code quality / performance

| # | Issue |
|---|-------|
| #44 | `server.js` is 9,935 lines — needs route modularization |
| #45 | N+1 query loop in design-report (7 hot loops) |
| #46 | Missing indexes on frequent-join columns |
| #51 | Cost management modal missing CSS classes |
| #55 | `design_review.js` is 6,151 lines |
| #57 | Full re-renders on single-item edits |
| #58 | No debounce on list search filters |

---

## 11. Deferred (v2) Features

These are designed or partially built but not in scope for the first production release:

| Feature | Current State | Why Deferred |
|---------|--------------|--------------|
| SN write-back (full round-trip) | Partially built | Needs sys_id write-back + conflict detection + test coverage |
| AI quality redesign (Suggestion Level slider) | Designed (backlog #28–#31) | Significant pipeline change; defer for stability |
| Two-tier Sonnet+Opus synthesis | Designed | Adds latency and cost; validate quality first |
| Reports (design summary, traceability matrix) | UI stubbed | Report generation engine not built |
| HITL gate runtime enforcement | UI built | Execution model not implemented |
| Natural language validation rules | Partially built | Rule engine incomplete |
| Real-time collaboration | Not started | Requires websockets + conflict resolution |
| PDF document ingestion | Not started | Needs proper PDF-to-text (pdfjs-dist or similar) |
| Audit log export (CSV/Excel) | Not started | Viewing works; export not built |

---

## 12. KT Session Guide

Suggested structure for onboarding walkthroughs:

| Session | Duration | Who | Topics |
|---------|----------|-----|--------|
| 1 — Architecture & Data Model | 2 hours | All team | Sections 2, 3, 6 — system diagram, tech stack, 68-table schema |
| 2 — Working Features Demo | 2 hours | All team | Live walkthrough of sections 4.2–4.9, 4.21–4.22 — what works today |
| 3 — Stubs, Gaps & Roadmap | 1 hour | All team | Sections 4.10–4.20, 10–11 — what's fake, what's broken, what's v2 |
| 4 — AI Pipeline Deep-Dive | 2 hours | Developers | Section 7 — model routing, prompts, extended thinking, usage tracking |
| 5 — ServiceNow Integration | 1 hour | Developers | Section 8 — connection model, Fluent notation, round-trip status |
| 6 — Local Setup & First PR | Half-day | Developers | Section 9 — get running locally; fix one of the issue #-tagged bugs |

---

*KT document version: 2026-07-01 | Update this document when major features are completed or deferred items move to v1 scope*
