# Agentic SDLC Workbench — Tech Debt Audit

**Date:** 2026-07-06 · **Scope:** whole repo (`agentic-sdlc-workbench`). **Method:** aggregated the 89 already-tracked items in `BACKLOG.md` (from prior 2026-06-11 backend/agent/frontend reviews + this project's own dogfooding) into tech-debt categories; cross-checked architecture claims against a graphify dependency-graph pass (1722 nodes / 3943 edges / 94 communities over 165 files); ran a fresh audit of the four categories the backlog does **not** cover — dependency, infrastructure, test, and documentation debt — including live `npm outdated`/`npm audit`.

**New findings from this pass** (not previously tracked) are logged as BACKLOG #90–#94.

---

## 1. Executive summary (business language)

The codebase's *correctness* debt is unusually well-mapped already — five prior review passes left 89 numbered, file:line-precise items in `BACKLOG.md`, and this session closed 6 of the highest-value ones (the AI model configuration system, a silent data-loss bug in ServiceNow conflict approval, and four round-trip integrity gaps). What was **not** yet examined is whether the *product* is safe to operate and hand off: dependency hygiene, deployment infrastructure, test coverage, and documentation currency. That gap is now closed, and it surfaces a consistent pattern — the engineering-heavy areas (AI pipelines, the ServiceNow sync engine) are mature and well-tested; the operational areas (CI/CD, backups, dependency patching, onboarding docs) have had almost no investment. `docs/PRODUCTION_WORKPLAN.md` already self-rates the app 4/10 production-ready, and this audit corroborates that number independently.

**Two things need attention this week, both cheap:**
1. **A known, publicly-documented security vulnerability** in a direct dependency (`multer`, used for file uploads) has a one-line fix available — nobody has applied it. A second, related vulnerability sits in a transitive dependency.
2. **The test suite doesn't run as a suite.** Twenty solid, self-contained test files exist — more test coverage than the backlog's tone suggests — but `npm test` is still the default "no tests specified" stub, so nothing runs them together, and nothing runs them automatically on a commit. This is the single highest-leverage fix available: it costs under an hour and is the prerequisite for every other safety net (CI/CD, safe refactoring of the two monolith files already flagged in the backlog).

**One thing is actively misleading:** a complete second backend — a Python/FastAPI/PostgreSQL implementation with 20 files and its own routers — sits in the repo from the very first commit, before the project pivoted to the current Node.js backend. It has zero references anywhere in the live code, but the root `README.md` still describes it as if it were real, which will confuse the next person who reads it before the code.

**Everything else is a scale problem, not a safety problem** — the two monolith files (the 8,000-line server and the 6,150-line Design Review UI), the eventual SQLite→PostgreSQL migration, and the broader AI-ingestion-quality program are all real, all already tracked, and all correctly *not* urgent: they're expensive to fix and the cost of leaving them alone accrues slowly. The phased plan below sequences the cheap safety fixes first, specifically because they make the expensive structural fixes safer to attempt later.

## 2. Scoring method

Per the tech-debt framework: **Priority = (Impact + Risk) × (6 − Effort)**, each scored 1–5. High priority = high payoff, low cost — not necessarily high severity alone. Full item-level detail (89 backlog items) lives in `BACKLOG.md`; this doc scores at the **cluster** level (grouping related backlog items) plus the 5 net-new items from this pass, since scoring all 89 individually would just restate the backlog without adding decision-relevant signal.

## 3. Findings by category

### 3.1 Code debt — the backlog's core (44 open items, `BACKLOG.md` #2,4,17,18,36–58,63,64)
Already exhaustively tracked with file:line precision from the 2026-06-11 backend/frontend/critical-AI-capabilities reviews. Highlights re-scored here:

| Cluster | Backlog items | Impact | Risk | Effort | Priority |
|---|---|---|---|---|---|
| Transactional integrity trio (non-transactional writes, no error middleware, migration-error swallowing) | #37, #38, #42 | 4 | 4 | 2 | **32** |
| RASIC recurring regression (no automated guard) | #36 | 4 | 4 | 3 | **24** |
| Frontend defect cluster (baseline id bug, discarded feedback, unstyled modal, fake-success buttons, no error-state reset, brittle array assumption) | #49–#54 | 3 | 3 | 2 | **24** |
| N+1 query / missing index cluster | #45, #46 | 3 | 2 | 2 | 20 |
| Dynamic SQL hardening (safe today, fragile) | #47 | 2 | 2 | 2 | 16 |
| SQLi in `/library` + error-detail leak | #39, #41 | — | — | — | *folded into §3.4 Security* |
| Shared frontend helpers extraction | #56 | 3 | 2 | 3 | 15 |
| Targeted DOM updates / debounced search | #57, #58 | 2 | 1 | 2 | 12 |
| server.js / design_review.js monolith split | #44, #55 | 3 | 2 | 5 | **5** |

**Graphify corroboration:** the dependency graph independently confirms #56 is real, not theoretical — `el()` (208 edges), `apiFetch()` (113), `showToast()` (76), `formatDateTime()` (27) are the highest-fan-in nodes in the entire 1722-node graph, meaning they're already the de facto shared kernel; they're just not packaged as one. **No import cycles were detected anywhere in the codebase** — the monolith files are large but not tangled, which is exactly why the formula correctly ranks splitting them low: it's a readability/velocity cost, not a correctness risk.

### 3.2 Architecture debt (`BACKLOG.md` #70–72, #75, #79–83, #86 + one new item)

The ServiceNow round-trip architecture debt was the subject of this session's own assessment (`docs/reviews/2026-07-03-sn-roundtrip-fidelity-assessment.md`) — 6 of 8 recommended fixes are now built (see that doc's build log). Remaining: **#86** (adopt ServiceNow's native change ledger — needs a schema migration, awaiting sign-off) and the field-level 3-way merge (its prerequisite is now done). **#75** (SQLite→PostgreSQL) remains the correct "when you actually hit multi-user scale" migration — 15–22 dev-days, fully scoped already, correctly not urgent today.

**New finding — dead second backend (#90):** `backend/` (Python, FastAPI, PostgreSQL with row-level security, 20 files: `main.py`, `database.py`, `deps.py`, 10 routers, 4 SQL migration files) is tracked in git from the single "Initial backup" commit and has **not been touched since**. It predates the pivot to `backend-node/` (Node.js/Express/SQLite), which is the actual, actively-developed, 189-route, 20-test-suite backend. Zero code anywhere references `backend/`. The problem isn't that it exists — it's that `README.md` still documents it as if it's live, which will send a new developer down a dead path exactly when `docs/KT_ONBOARDING.md` (written 2 days ago) is trying to get them oriented correctly.

| Cluster | Impact | Risk | Effort | Priority |
|---|---|---|---|---|
| Dead Python backend + stale README | 2 | 2 | 1 | **20** |

### 3.3 Test debt (net-new category — not in `BACKLOG.md`)

**The good news:** 20 test files exist at `backend-node/` root, and every one of them is genuinely well-built — deterministic, stub-mode-safe (forces `ANTHROPIC_API_KEY=''`), isolated temp SQLite DB, randomized port, mocked ServiceNow fetches. None require live credentials. This is materially better than a codebase with "some ad-hoc scripts."

**The gap:** `package.json`'s `"test"` script is still the unmodified `npm init` stub (`echo "Error: no test specified" && exit 1`) — the 20 real suites have no aggregate runner and must be invoked one file at a time by hand. There is **zero frontend test coverage** (no `*.test.js`, no test framework config anywhere under `frontend/`). Of `server.js`'s 189 registered routes, tests exercise roughly a dozen route groups (ServiceNow sync/catalog/baseline/delta-export, a few internal-module tests) — **the remaining ~45 route groups, including nearly all CRUD, reporting, and admin surfaces, are entirely untested.**

| Cluster | Impact | Risk | Effort | Priority |
|---|---|---|---|---|
| Wire the 20 existing suites into one `npm test` | 3 | 3 | 1 | **30** |
| Build coverage for the ~45 untested route groups + any frontend tests | 4 | 3 | 5 | 7 |

The gap between these two scores is the point: wiring what already exists is nearly free and should happen immediately; building net-new coverage for 45 route groups is a real multi-week investment, correctly sequenced later and done incrementally (per the tech-debt framework's own guidance) alongside feature work, not as a dedicated sprint.

### 3.4 Dependency debt (net-new category)

`backend-node/package.json` is the only manifest in the repo (frontend is static, no build step). `npm outdated` and `npm audit` both ran successfully (network available):

| Package | Installed | Latest | Gap |
|---|---|---|---|
| `@anthropic-ai/sdk` | 0.95.1 | 0.110.0 | 15 minors |
| `openai` | 6.37.0 | 6.45.0 | 8 minors |
| `docx` | 9.6.1 | 9.7.1 | 1 minor |
| `multer` | 2.1.1 | 2.2.0 | 1 minor — **fixes a known vuln** |

`npm audit` found **2 real vulnerabilities**: `multer` **HIGH** (GHSA-72gw-mp4g-v24j, denial-of-service via deeply nested field names, CVSS 7.5 — this project's own file-upload path is exposed) and a transitive `qs` **MODERATE** (GHSA-q8mj-m7cp-5q26, DoS via crafted array input). Both have fixes available in the current dependency tree — this is a version bump, not a migration.

Separately: `engines.node: ">=22.5.0"` is **load-bearing, not incidental** — `db.js` and 6 other scripts use `node:sqlite`, an experimental Node core module unflagged only since 22.5, with no fallback driver. Deploying to any environment pinned to an older Node LTS (20.x is still common) means the app **cannot start**, not "runs slower." There is also **no `devDependencies` block at all** — no linter, no declared test framework — which compounds the test-debt gap above (nothing enforces style or catches an obviously broken test file before commit).

| Cluster | Impact | Risk | Effort | Priority |
|---|---|---|---|---|
| multer HIGH + qs MODERATE vulnerabilities | 3 | 4 | 1 | **35** |
| `node:sqlite` Node-version hard requirement, no fallback, undocumented | 2 | 2 | 1 (to document + assert) | 20 |
| Stale dependency versions (anthropic-sdk/openai/docx) | 2 | 2 | 2 | 16 |
| No devDependencies (no linter/test framework declared) | 2 | 2 | 2 | 16 |

### 3.5 Infrastructure / deployment debt (net-new category)

No Dockerfile anywhere (a `docker-compose.yml` stub defines an unused `postgres:16-alpine` service for the future #75 migration — not a working deploy path today). **No CI/CD whatsoever** — no `.github/workflows/`, no equivalent anywhere. The app is started via three `.bat` files that are hardcoded to one developer's exact machine path and force a specific git branch checkout — dev conveniences, not a deployment mechanism. `docs/PRODUCTION_WORKPLAN.md` (dated 2026-07-01, already approved) independently rates the app **4/10 production-ready** and has a 24-week roadmap that already includes Docker, CI/CD, and automated backups as not-yet-started — this audit's findings corroborate rather than duplicate that plan.

44 files read `process.env.*` directly with no central config module; roughly 16 distinct environment variables are needed, and only 3 are documented anywhere (no `.env.example` is checked in). Logging is 258 `console.log` + 116 `console.error` + 36 `console.warn` calls with no levels, rotation, or correlation IDs — already flagged in the production workplan. A manual backup script (`backup-db.js`) exists and works, but nothing schedules it — the newest backup on disk at audit time was already about a month old.

| Cluster | Impact | Risk | Effort | Priority |
|---|---|---|---|---|
| No automated DB backups (script exists — just needs scheduling) | 3 | 3 | 2 | **24** |
| No CI/CD pipeline (unblocked cheaply once §3.3's test-runner item lands) | 4 | 4 | 3 | **24** |
| No containerization | 2 | 2 | 3 | 12 |
| No structured logging | 2 | 2 | 3 | 12 |
| No `.env.example` (16 vars, 3 documented) | 1 | 1 | 1 | 10 |

### 3.6 Documentation debt (net-new category)

Root `README.md` (123 lines) has no test instructions and — per §3.2 — actively misdocuments the dead Python backend as live. `backend-node/` (the real backend) has **no README of its own**. There is no `CONTRIBUTING.md`, `CODEOWNERS`, or `LICENSE` anywhere. Comment density is uneven but not uniformly bad: the `agent/*.js` layer (the AI pipeline code) is genuinely well-commented with WHY-focused rationale (prompt-cache byte-stability, non-destructive-write guarantees); `server.js` is comment-light by comparison. Seven real TODO/FIXME markers exist (not noise); the most consequential is a cluster of **four identical "structured editor TODO" markers in `design_review.js`** revealing an undocumented feature gap — agent I/O, tool I/O, tool errors, and HITL gates are all view-only in the Design Review UI today, with editing silently deferred. That's a product-roadmap decision hiding inside a code comment, not pure engineering debt.

| Cluster | Impact | Risk | Effort | Priority |
|---|---|---|---|---|
| Stale README + missing backend-node README | — | — | — | *bundled with §3.2's dead-backend item* |
| No CONTRIBUTING/CODEOWNERS/LICENSE | 1 | 1 | 1 | 10 |
| Undocumented structured-editor feature gap (design_review.js) | 3 | 2 | 4 | 10 — *flag to product, not engineering* |

## 4. Phased remediation plan

**Phase 0 — This week, all cheap, do regardless of what else is prioritized:**
- Apply the `multer`/`qs` dependency fixes (§3.4) — highest score of anything in this audit, and it's a version bump.
- Delete the dead `backend/` Python scaffold and fix `README.md` + add a `backend-node/README.md` (§3.2/3.6) — same underlying problem, one pass.
- Wrap the three non-transactional write flows in `BEGIN`/`COMMIT`, add the terminal Express error handler, narrow the migration-swallow catch (#37/#38/#42) — all three are bounded, well-scoped fixes per the existing backlog descriptions.
- Wire `package.json`'s `"test"` script to run all 20 existing suites (§3.3) — this is the prerequisite for Phase 1's CI/CD item.
- Schedule the existing `backup-db.js` (Task Scheduler/cron) + add a `.env.example` documenting all ~16 variables (§3.5).

**Phase 1 — Next 1–2 sprints:**
- Stand up a baseline CI/CD pipeline (lint + the now-aggregated test suite on every push) — depends on Phase 0.
- Root-cause the RASIC recurring regression and add the automated smoke-check (#36) — it keeps coming back precisely because nothing catches it automatically.
- Work through the frontend defect cluster (#49–#54) — each is small and independent.
- Apply the N+1/missing-index fixes (#45/#46) and document/assert the `node:sqlite` Node-version requirement.
- Bump the stale dependencies (anthropic-sdk, openai, docx) and add a linter as a real devDependency.

**Phase 2 — Next quarter, larger but bounded:**
- Extract the shared frontend helper module (#56) — the graphify fan-in data makes the target list unambiguous (`el`, `apiFetch`, `showToast`, `formatDateTime`, etc.).
- Targeted-re-render and debounced-search performance work (#57/#58).
- Formalize the dynamic-SQL-name allowlist assertion (#47).
- Roll out structured logging.
- Begin building route/frontend test coverage incrementally — pick untested routes up as they're touched for feature work, not as a dedicated sprint (per the framework's own "alongside feature work" guidance).

**Phase 3 — Strategic, schedule deliberately rather than opportunistically:**
- The `server.js`/`design_review.js` monolith decomposition (#44/#55) — the scoring correctly ranks this low as a stand-alone project (high effort, no correctness payoff, no import cycles to untangle); do it file-by-file as those areas get touched anyway, now that Phase 0's CI/CD safety net makes that safe.
- The SQLite→PostgreSQL migration (#75) and containerization — only once multi-user concurrency is an actual, not hypothetical, constraint.
- The broader AI-ingestion-quality program (#28–35, #65–69, #74, #78) — this is the product's core value proposition, which is exactly why it deserves a dedicated product/engineering planning pass rather than being squeezed into a tech-debt remediation cycle.
- Bring the four `design_review.js` structured-editor TODOs to product as an explicit roadmap decision.
- `#86` (adopt ServiceNow's native `sys_metadata` change ledger) — pending the schema-migration sign-off already flagged in the round-trip assessment.

## Appendix — new backlog items from this audit

Logged in `BACKLOG.md` as #90–#94 (dead backend + stale docs, dependency vulnerabilities, test-runner wiring, backup automation + env template, CI/CD baseline).
