# Agentic Workbench — Production Readiness Work Plan

**Version:** 2026-07-01
**Status:** Approved
**Team size:** 2–4 developers
**Timeline:** 3–6 months to first client-ready MVP

---

## Context

The Agentic Workbench is a POC Node.js/Express tool for ingesting ServiceNow application designs, running AI-powered design review workflows, and supporting a full SN round-trip. A codebase audit (June 2026) rates it **4/10 production-ready**: the AI integration and SN ingestion pipeline are solid, but authentication does not exist (just an HTTP header), multi-tenancy is modeled but not enforced, there is no test suite, no CI/CD, and the database is SQLite with missing transactions.

This work plan covers everything required to take it to a Deloitte-managed, multi-tenant Azure SaaS product approved through Deloitte's **Certified to Use (CTU)** process and capable of supporting multiple clients simultaneously.

**Constraints:**
- Team: 2–4 developers
- Timeline: 3–6 months to first client-ready MVP
- Hosting: Deloitte-managed Azure, multi-tenant (one shared instance, data isolated per client)
- Database: Migrate from SQLite → Azure PostgreSQL (recommended) or Azure SQL
- Auth: Azure Entra ID SSO (Deloitte IT engagement required — TBD)
- MVP scope: Open — first activity is a scoping workshop; the v1/v2 cut is an open decision

**Codebase baseline (from June 2026 audit):**
- `backend-node/server.js` — 9,935 lines, 188 routes, no route modularization
- `backend-node/schema.sql` — 68 tables, raw parameterized SQL, no ORM, WAL mode enabled
- `frontend/` — Vanilla JS SPA, 22 modules, no build step, no framework
- No test runner, no CI/CD pipeline, no Dockerfile for app
- 7 critical security/data-integrity issues tracked in BACKLOG.md (#2, #37, #38, #39, #42, #73, #76)

---

## Work Plan

---

### Phase 0 — Start Immediately & Run in Parallel

#### 0.0 Knowledge Transfer (Weeks 1–3)
*New team members cannot contribute until they understand the tool. KT runs in parallel with all other Week 1–3 activity. See `docs/KT_ONBOARDING.md` for the KT document.*
- 0.0.1 Distribute KT document to all team members before first working session
- 0.0.2 Walkthrough session: system architecture, tech stack, data model (2 hours, all team)
- 0.0.3 Walkthrough session: working features demo — live run of key user journeys (2 hours, all team)
- 0.0.4 Walkthrough session: stubbed / incomplete features — what's fake, why, and what the v1 plan is (1 hour)
- 0.0.5 Walkthrough session: AI ingestion pipeline deep-dive — how prompts, models, and `agent/` modules work (2 hours, devs)
- 0.0.6 Walkthrough session: ServiceNow integration — connection model, round-trip, Fluent notation (1 hour, devs)
- 0.0.7 Individual developer setup: each dev gets local environment running against SQLite (half-day per person)
- 0.0.8 KT Q&A / open issues session (1 hour) and update KT document with answers

#### 0.A Azure Cloud Setup — Start Day 1 in Parallel
*Cloud provisioning involves Deloitte IT approvals that can take weeks. Initiate immediately regardless of where feature work stands.*
- 0.A.1 Identify Deloitte Azure subscription owner and request meeting within Week 1
- 0.A.2 Determine if a Deloitte standard Azure landing zone applies (naming conventions, policy, networking baseline)
- 0.A.3 Submit Azure resource group provisioning request (dev environment first)
- 0.A.4 Register application in Azure Entra ID — initiate with Deloitte IT (can take 2–4 weeks for approval)
- 0.A.5 Confirm Anthropic API vendor status in Deloitte procurement (pre-approved or CTU vendor track needed)
- 0.A.6 Identify CTU process owner and schedule intake call

---

### Phase 1 — Immediate Risk Mitigation (Weeks 1–2)
*Fast wins — critical defects blocking any multi-user use. 1–2 dev-weeks, runs in parallel with scoping.*

#### 1.1 Data Integrity Fixes
- 1.1.1 Wrap ingest promote and SN sync write-back in SQL transactions (issue #37 — `server.js` lines ~6943, ~7201)
- 1.1.2 Add Express global error middleware to replace bare 500s (issue #38 — no error middleware currently)
- 1.1.3 Fix migration loop error swallowing in `db.js` (issue #42 — `catch {}` hides schema failures)
- 1.1.4 Replace manual string escaping in `/library` with parameterized queries (issue #39 — SQL injection risk)

#### 1.2 Security Hardening (Immediate)
- 1.2.1 Make `ASDLC_ENCRYPT_KEY` required at startup — fail fast rather than storing credentials in plaintext (issue #76)
- 1.2.2 Strip ServiceNow error detail from client responses (issue #41 — SN instance URL leakage)
- 1.2.3 Add per-request project_id access validation (stub: verify userId has a row in `asdlc_project_member` for the requested project_id)

#### 1.3 Database Performance Foundations
- 1.3.1 Add missing indexes to schema: `workflow_step(workflow_id)`, `agent_spec(project_id, workflow_id)`, `tool(project_id)`, and other frequent-join columns (issue #46)
- 1.3.2 Fix N+1 query loops in design-report endpoint (7 hot loops re-preparing identical statements, issue #45)

---

### Phase 2 — Foundation & Scoping (Weeks 1–3)

#### 2.1 Product Scoping Workshop
- 2.1.1 Inventory all 22 frontend modules and map each to MVP / Deferred (v2) / Cut
- 2.1.2 Identify stub features (Evidence "Re-run", Reports "Preview") — decide: implement or remove for v1
- 2.1.3 Decide whether SN write-back (round-trip) is v1 or v2 — this is the heaviest remaining feature
- 2.1.4 Decide whether AI quality redesign (Suggestion Level slider, two-tier Sonnet+Opus) is v1 or v2
- 2.1.5 Define feature flags in code to gate deferred features without deleting them
- 2.1.6 Produce written v1 scope document, signed off by project lead

#### 2.2 Architecture & Technology Decisions
- 2.2.1 Select production database: Azure PostgreSQL vs. Azure SQL (recommendation: Azure PostgreSQL for cost + Prisma support)
- 2.2.2 Decide ORM vs. raw queries: adopt Prisma or Knex on top of existing parameterized SQL patterns (68 tables, no existing ORM)
- 2.2.3 Decide multi-tenancy enforcement model: application-layer `tenant_id` filtering vs. PostgreSQL row-level security
- 2.2.4 Decide containerization: Azure Container Apps (recommended) vs. Azure App Service
- 2.2.5 Decide frontend evolution path: keep Vanilla JS SPA vs. introduce a lightweight framework — v1 can stay Vanilla
- 2.2.6 Confirm Anthropic API vendor approval path (Phase 0.A.5 result)
- 2.2.7 Produce Architecture Decision Records (ADRs) for each major decision

#### 2.3 Project Foundations
- 2.3.1 Git branching strategy: `main` (protected, prod), `staging`, feature branches
- 2.3.2 Set up project tracking board (one ticket per work plan activity)
- 2.3.3 Standardize developer environment via devcontainer or `setup.sh`
- 2.3.4 Define environment inventory: local → dev → staging → prod
- 2.3.5 Assign workstream owners (auth, infra, testing, CTU)

---

### Phase 3 — Infrastructure & Platform (Weeks 2–10)

#### 3.1 Azure Cloud Provisioning
- 3.1.1 Provision resource groups for dev / staging / prod (follows 0.A.2–0.A.3)
- 3.1.2 Configure virtual network, private endpoints, and outbound firewall rules
- 3.1.3 Set up Azure Key Vault for all secrets (`ANTHROPIC_API_KEY`, `ASDLC_ENCRYPT_KEY`, DB credentials, SN credentials)
- 3.1.4 Configure Azure Monitor + Log Analytics workspace

#### 3.2 Infrastructure as Code
- 3.2.1 Choose IaC toolchain (Azure Bicep recommended for Deloitte Azure-native environments)
- 3.2.2 Write Bicep modules: compute, Azure PostgreSQL, networking, Key Vault, Container Registry
- 3.2.3 Parameterize for environment promotion (dev / staging / prod configs)
- 3.2.4 Store IaC under `/infra` in repo and wire to deployment pipeline

#### 3.3 Database Migration (SQLite → Azure PostgreSQL)
- 3.3.1 Audit all 68 tables in `schema.sql` for SQLite-specific syntax (type affinity, `AUTOINCREMENT`, JSON TEXT columns)
- 3.3.2 Rewrite schema for PostgreSQL: proper types (`uuid`, `jsonb`, `timestamptz`), sequences
- 3.3.3 Add `client_id` tenant column to any tables missing explicit client linkage
- 3.3.4 Introduce ORM or migration tool (Prisma Migrate or Knex — replaces raw `db.js` ALTER statements)
- 3.3.5 Port all raw SQL in `server.js` (188 routes, ~9,935 lines) to PostgreSQL-compatible parameterized queries — highest-effort item in this phase
- 3.3.6 Add application-layer tenant filtering: utility function `scopeToTenant(query, tenantId)` used in every route
- 3.3.7 Write SQLite → PostgreSQL data migration script for existing dev/test datasets
- 3.3.8 Connection pooling configuration (pg-pool or Prisma connection pool) and baseline load test
- 3.3.9 Validate all 188 API routes against new database layer (automated regression)

#### 3.4 Application Containerization
- 3.4.1 Write `Dockerfile` for Node.js Express backend (docker-compose.yml already has PostgreSQL service — extend it)
- 3.4.2 Serve Vanilla JS frontend from Express static middleware (no separate web server needed for v1)
- 3.4.3 Multi-stage Docker build: dependencies → runtime image
- 3.4.4 Push to Azure Container Registry

#### 3.5 CI/CD Pipeline
- 3.5.1 Set up GitHub Actions build pipeline: lint → unit tests → build → container image push
- 3.5.2 Set up deployment pipeline: image → dev deploy → staging deploy → prod deploy (manual approval gate before prod)
- 3.5.3 Configure Azure Key Vault secret injection into container env vars
- 3.5.4 Define and test rollback procedure (redeploy previous container tag)
- 3.5.5 Add pipeline status badge to README

---

### Phase 4 — Authentication, Authorization & Multi-Tenancy (Weeks 4–10)

#### 4.1 Authentication (start from scratch — currently just `X-User-ID` header in localStorage)
- 4.1.1 Register application in Azure Entra ID (follows 0.A.4)
- 4.1.2 Implement OIDC/OAuth2 login flow (Microsoft identity platform / MSAL)
- 4.1.3 Replace `localStorage` user ID with proper JWT session (access token + refresh token)
- 4.1.4 Update `apiFetch()` in `app.js` to send `Authorization: Bearer <token>` instead of `X-User-ID` header
- 4.1.5 Add server-side JWT verification middleware (replaces line 103 `X-User-ID` extraction in `server.js`)
- 4.1.6 Handle Deloitte-internal users vs. external client users (Entra B2B guest accounts or separate IdP federation)
- 4.1.7 Implement logout, token revocation, and idle session timeout
- 4.1.8 Add CSRF protection and tighten CORS from `*` to allowed origins

#### 4.2 Role-Based Access Control (RBAC)
- 4.2.1 Define role taxonomy: Platform Admin / Client Admin / Analyst / Viewer
- 4.2.2 Implement `requiresRole()` middleware applied to every route group in `server.js`
- 4.2.3 Implement `requiresProjectAccess()` middleware — verify authenticated user has a row in `asdlc_project_member` (replacing Phase 1.2.3 stub)
- 4.2.4 Add role management UI in admin panel
- 4.2.5 Audit all 188 routes for appropriate role requirement

#### 4.3 Client & Tenant Data Isolation
- 4.3.1 Implement tenant context middleware: extract `client_id` from authenticated user's JWT claims on every request
- 4.3.2 Apply `scopeToTenant()` utility on every database query (built in Phase 3.3.6)
- 4.3.3 Write automated cross-tenant isolation test suite (tenant A cannot read/write tenant B data)
- 4.3.4 Implement client onboarding flow: create `asdlc_client` record → assign Client Admin → configure SN connection
- 4.3.5 Implement client deprovisioning: data deletion or archival, user removal

#### 4.4 User Management
- 4.4.1 User invitation flow (email invite or SSO just-in-time provisioning)
- 4.4.2 Client admin UI: user list, invite, role assignment, deactivate
- 4.4.3 Platform admin UI: cross-client user and tenant overview
- 4.4.4 Auth events (login, logout, failed auth) wired to `asdlc_audit_log`

---

### Phase 5 — Server Modularization & Feature Completion (Weeks 4–14)

#### 5.1 Server.js Refactoring (Technical Debt #44)
*`server.js` is 9,935 lines with 188 routes — must be split before 2–4 devs can work in parallel without constant merge conflicts.*
- 5.1.1 Extract route groups into `backend-node/routes/` (one file per domain: projects, ingest, design, servicenow, cost, admin)
- 5.1.2 Extract agent/AI orchestration logic into `backend-node/agent/` submodules (partially done for ingest prompts)
- 5.1.3 Extract shared DB utilities from monolith into `backend-node/db/` modules
- 5.1.4 Verify all 188 routes still pass after modularization (regression test)

#### 5.2 Technical Debt Triage & Cleanup
- 5.2.1 Remove or feature-flag all non-MVP functionality identified in Phase 2 scoping
- 5.2.2 Remove stub buttons or replace with clear "coming in v2" messaging (Evidence, Reports stubs)
- 5.2.3 Move all hardcoded values to environment variables (`ANTHROPIC_API_KEY`, `PORT`, `ASDLC_DB_PATH`, hardcoded `'claude-opus-4-5'` in cost-estimate — issue #43)
- 5.2.4 Remove `SN_INSECURE_TLS` bypass for production; implement `NODE_EXTRA_CA_CERTS` with Deloitte proxy cert
- 5.2.5 Add startup validation: required env vars checked at boot, fail fast with clear message
- 5.2.6 Remove `seed.js` auto-run on startup (make dev-only)

#### 5.3 AI Ingestion Pipeline Hardening
- 5.3.1 Add retry logic and circuit breaker for Anthropic API failures (currently unhandled)
- 5.3.2 Per-tenant AI cost tracking and budget alerting (expand existing `asdlc_ai_usage`)
- 5.3.3 Add PDF ingest support (currently falls through to UTF-8 read — issue #64)
- 5.3.4 Implement "Suggestion Level" slider (confidence threshold) — if scoped to v1
- 5.3.5 Fix RASIC auto-population (recurring regression — issue #36)
- 5.3.6 Fix clarification auto-apply overwriting cost params project-wide (issue #40)

#### 5.4 ServiceNow Integration Hardening
- 5.4.1 Make all SN connection parameters configurable per tenant via Key Vault (not `.env` fallback)
- 5.4.2 Complete SN sys_id write-back (full round-trip) — if scoped to v1
- 5.4.3 Add net-new conflict detection (changes in SN since last ingest)
- 5.4.4 Handle SN API rate limits and timeouts gracefully
- 5.4.5 Validate Build Spec generation end-to-end against a real SN dev instance

#### 5.5 Frontend Bug Fixes & Polish
- 5.5.1 Fix change-packet action buttons staying active after terminal action (issue #17)
- 5.5.2 Fix baseline detail fetch using wrong ID field (issue #49)
- 5.5.3 Fix cost management modal missing CSS classes (issue #51)
- 5.5.4 Add debounce to search filters (issue #58)
- 5.5.5 Fix SN-conflict approval silently dropping accepted value (issue #62)
- 5.5.6 Fix testing.js assuming unpaginated `/projects` response (issue #54)
- 5.5.7 Consistent error handling and user-facing messages across all 22 modules
- 5.5.8 Loading states and progress indicators for long-running AI operations

---

### Phase 6 — Testing (Weeks 6–16)

#### 6.1 Test Strategy & Infrastructure
- 6.1.1 Write test plan document covering scope, types, tooling, and pass criteria
- 6.1.2 Select and configure test runner — Jest or Vitest (currently: `test` script is `echo "Error: no test specified"`)
- 6.1.3 Set up test database: isolated PostgreSQL instance seeded with fixtures
- 6.1.4 Define test data management policy (synthetic data only; no real client data in test environments)
- 6.1.5 Add coverage reporting to CI pipeline (target: 70% line coverage on business logic)

#### 6.2 Unit Tests
- 6.2.1 Unit tests for `db.js` helper functions (`generateId`, `nextSlug`, `auditLog`, `scopeToTenant`)
- 6.2.2 Unit tests for AI ingestion pipeline modules (`agent/`)
- 6.2.3 Unit tests for cost mapping and rate card logic
- 6.2.4 Unit tests for auth middleware and RBAC enforcement
- 6.2.5 Unit tests for SN integration utilities (provenance, sys_id mapping, Fluent notation)
- 6.2.6 Organize and add assertions to the 11 existing `test-*.js` files where they contain useful scenarios

#### 6.3 Integration Tests
- 6.3.1 API integration test suite for all 188 endpoints (auth, CRUD, AI operations)
- 6.3.2 Database integration tests: multi-tenant isolation, transaction rollback, foreign key enforcement
- 6.3.3 AI pipeline integration tests (mocked Anthropic API + real PostgreSQL)
- 6.3.4 ServiceNow integration tests (against a SN dev instance)
- 6.3.5 Cross-tenant isolation tests: confirm tenant A cannot access tenant B on any endpoint

#### 6.4 End-to-End Tests
- 6.4.1 Select E2E framework (Playwright recommended — works with Vanilla JS SPA)
- 6.4.2 Core analyst journey: login → select project → ingest SN app → review design → export
- 6.4.3 Admin journey: login as Client Admin → create project → invite user → configure SN → assign role
- 6.4.4 SN round-trip E2E: ingest → edit design → write-back → verify in SN instance
- 6.4.5 Cross-tenant isolation E2E: user from tenant A cannot navigate to tenant B data via URL manipulation

#### 6.5 Performance & Load Testing
- 6.5.1 Define performance targets (API p95 latency, AI operation timeout budgets, concurrent user count)
- 6.5.2 Load test concurrent user scenarios against PostgreSQL
- 6.5.3 AI pipeline cost and latency profiling under load
- 6.5.4 PostgreSQL query performance analysis and index optimization
- 6.5.5 Document performance baselines in ARCHITECTURE.md

#### 6.6 User Acceptance Testing (UAT)
- 6.6.1 Write UAT test scripts for all MVP features
- 6.6.2 Internal pilot: run against a real Deloitte-internal SN instance with the project team
- 6.6.3 Triage UAT findings: P1 (must fix) / P2 (should fix) / P3 (v2)
- 6.6.4 Resolve all P1 and targeted P2 issues
- 6.6.5 Formal UAT sign-off from project lead

---

### Phase 7 — Security & Certified to Use (CTU) (Weeks 3–16)
*CTU is on the critical path. Start vendor engagement and submissions in Weeks 3–5, not Week 12.*

#### 7.1 Security Self-Assessment
- 7.1.1 Produce threat model document: data flows, trust boundaries, threat actors, data classification
- 7.1.2 OWASP Top 10 self-assessment against codebase (auth gap, SQL injection in /library, open CORS)
- 7.1.3 LLM/AI-specific security review: prompt injection, client data leakage into prompts, output validation
- 7.1.4 Secrets audit: confirm no API keys, credentials, or tokens in source code, logs, or error responses
- 7.1.5 npm dependency vulnerability scan (`npm audit` + Snyk) and remediation
- 7.1.6 Remediate all critical findings before InfoSec submission

#### 7.2 Deloitte InfoSec Review
- 7.2.1 Identify Deloitte InfoSec / CISO team contact for application security reviews
- 7.2.2 Complete Deloitte security questionnaire / application security intake
- 7.2.3 Provide architecture diagram, data flow diagrams, and threat model to InfoSec
- 7.2.4 Schedule penetration test if required by CTU process
- 7.2.5 Remediate all critical and high findings from InfoSec review
- 7.2.6 Obtain InfoSec sign-off

#### 7.3 Data Privacy & Legal Review
- 7.3.1 Identify all personal data and client confidential data processed (user emails, SN design content, AI inputs/outputs)
- 7.3.2 Complete Data Privacy Impact Assessment (DPIA)
- 7.3.3 Define and implement data retention, deletion, and portability policies
- 7.3.4 Review Anthropic API terms of service for client data handling (data residency, training opt-out, DPA)
- 7.3.5 Engage Deloitte Legal on IP ownership and liability
- 7.3.6 Obtain Legal sign-off on data handling and IP

#### 7.4 CTU Certification Submission
- 7.4.1 Identify CTU process owner and required submission package components (follows 0.A.6)
- 7.4.2 Confirm Anthropic API vendor status — pre-approved or needs CTU vendor approval track (follows 0.A.5)
- 7.4.3 Complete vendor approval for any other third-party services
- 7.4.4 Compile tool risk assessment document
- 7.4.5 Submit full CTU package: risk assessment + InfoSec sign-off + Legal sign-off + DPIA + vendor approvals
- 7.4.6 Respond to CTU reviewer questions and requested changes
- 7.4.7 Receive, file, and communicate CTU approval certificate

---

### Phase 8 — Observability & Operations (Weeks 8–16)

#### 8.1 Monitoring & Alerting
- 8.1.1 Configure Azure Application Insights (APM) on the Node.js process
- 8.1.2 Set up error rate, latency, and availability alerts
- 8.1.3 AI pipeline cost and token usage dashboards (expand existing `asdlc_ai_usage` data into Azure Monitor)
- 8.1.4 PostgreSQL performance monitoring (slow queries, connection pool saturation)
- 8.1.5 Uptime/SLA dashboard

#### 8.2 Logging & Audit Trail
- 8.2.1 Implement structured JSON logging (Winston or Pino) — replace `console.log` calls throughout `server.js`
- 8.2.2 Confirm no PII, credentials, or SN error details appear in logs (issue #41 partially broken)
- 8.2.3 Wire auth events (login, logout, failed auth) to `asdlc_audit_log` (follows Phase 4.4.4)
- 8.2.4 Configure log retention policy aligned with data privacy requirements
- 8.2.5 Set up log search and alerting via Log Analytics

#### 8.3 Runbooks & Support Documentation
- 8.3.1 Deployment runbook (deploy, roll back, hotfix)
- 8.3.2 Incident response runbook (triage, escalate, communicate, post-mortem)
- 8.3.3 Common operational procedures (restart, scale, re-run failed ingestion, clear stuck queue item)
- 8.3.4 Known issues and FAQ for support team
- 8.3.5 On-call rotation setup and escalation path

#### 8.4 Backup & Recovery
- 8.4.1 Configure automated Azure PostgreSQL backups (point-in-time restore, minimum 7-day retention)
- 8.4.2 Define and test Recovery Time Objective (RTO) and Recovery Point Objective (RPO)
- 8.4.3 Document disaster recovery procedure
- 8.4.4 Execute a backup restoration drill before GA

---

### Phase 9 — Documentation & Enablement (Weeks 10–18)

#### 9.1 Technical Documentation
- 9.1.1 Architecture document: system overview, component diagram, data flows (extend existing `ARCHITECTURE.md`)
- 9.1.2 API reference: all 188 endpoints, auth, request/response schemas
- 9.1.3 Database schema documentation: all 68 tables, key relationships, multi-tenancy model
- 9.1.4 Developer onboarding guide: local setup, test run, deploy process
- 9.1.5 AI ingestion design guide: how prompts work in `agent/prompts/*.md`, how to extend

#### 9.2 End-User Documentation
- 9.2.1 User guide: ingesting a ServiceNow application
- 9.2.2 User guide: reviewing and editing a design in the Workbench
- 9.2.3 User guide: the SN round-trip (edit → write-back) — if in v1 scope
- 9.2.4 Client admin guide: user management, project setup, SN configuration
- 9.2.5 Platform admin guide: tenant management, monitoring, cost control

#### 9.3 Client Onboarding Package
- 9.3.1 Client onboarding checklist (SN credentials, user list, roles, project setup steps)
- 9.3.2 Client-facing one-pager / tool overview for engagement kickoff
- 9.3.3 Training materials and demo script for client onboarding call

---

### Phase 10 — Pilot Launch & General Availability (Weeks 16–24)

#### 10.1 Internal Pilot
- 10.1.1 Select pilot — a Deloitte-internal project or low-risk client with a known SN environment
- 10.1.2 Stand up pilot tenant and onboard users
- 10.1.3 Run structured pilot sessions with facilitated feedback capture
- 10.1.4 Triage pilot feedback; implement priority fixes in a dedicated stabilization sprint
- 10.1.5 Pilot retrospective and go/no-go decision for general availability

#### 10.2 General Availability Preparation
- 10.2.1 Define GA release criteria: scope complete + CTU approved + InfoSec clear + UAT signed off
- 10.2.2 Staged rollout plan: 1 client → 3 clients → open intake
- 10.2.3 Rollback plan for production issues (specific container tag + DB restore procedure)
- 10.2.4 Internal communications to practice/sector leads
- 10.2.5 Client intake process: how engagement teams request access

#### 10.3 Post-Launch Stabilization
- 10.3.1 Hyper-care period: daily standups, rapid-response SLA, 2-week window post-GA
- 10.3.2 Bug triage and priority fix cycles
- 10.3.3 Collect early client feedback and feed into v2 backlog
- 10.3.4 Transition to steady-state support model

---

## Critical Path

Delays in any of these slip the launch date. Start these in parallel with everything else:

| Priority | Item | Start by | Why it blocks |
|----------|------|----------|---------------|
| **#1** | CTU engagement (Phase 7.4.1) | Week 2 | Procurement and legal reviews take months; submissions can't be rushed |
| **#2** | Anthropic vendor approval (Phase 7.4.2) | Week 2 | May need to go through Deloitte procurement if not pre-approved |
| **#3** | Azure provisioning + Deloitte IT (Phase 3.1) | Week 2 | Deloitte IT approvals and landing zone setup take time |
| **#4** | Azure Entra ID registration (Phase 4.1.1) | Week 3 | Auth gates all UAT and any real client usage |
| **#5** | Database migration (Phase 3.3) | Week 2 | All feature work and performance testing blocks on this |
| **#6** | Server.js modularization (Phase 5.1) | Week 3 | 9,935-line monolith causes merge conflicts with 2–4 devs in parallel |

---

## Rough Timeline (3–6 Month View)

| Weeks | Focus |
|-------|-------|
| 1–2 | Phase 0 (KT + Azure kickoff) + Phase 1 (fast wins) + Phase 2 (scoping + ADRs) |
| 3–6 | Phase 3 (infrastructure + DB migration) + Phase 4 (auth) + Phase 5 (server modularization) |
| 6–10 | Phase 5 (feature completion) + Phase 6.1–6.3 (unit + integration tests) + Phase 7 (security review) |
| 10–14 | Phase 6.4–6.6 (E2E + UAT) + Phase 7.4 (CTU submission) + Phase 8 (observability) |
| 14–18 | Phase 9 (documentation) + Phase 10.1 (internal pilot) |
| 18–24 | Phase 10.2–10.3 (GA + stabilization) |

*At 2 devs this is 20–24 weeks (fits in 6 months). At 4 devs with parallel workstreams it fits 14–16 weeks.*

---

## Open Questions to Resolve in Phase 2

1. Is Anthropic already a pre-approved vendor in Deloitte procurement, or does it need a new CTU vendor track?
2. What are the specific steps and typical timeline for CTU at Deloitte?
3. Does a Deloitte Azure landing zone standard apply? If so, who owns the subscription?
4. Do external client users log in via Entra B2B guest accounts or via federated client IdP?
5. Is the SN write-back (round-trip) in scope for v1 or v2?
6. Does Deloitte require data residency (e.g., EU data must stay in EU Azure regions)?
