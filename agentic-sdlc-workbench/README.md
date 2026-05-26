# Agentic SDLC Workbench

A local-prototype web workbench for designing and managing ServiceNow Agentic AI applications. Humans provide input and validate; the UI surfaces Change Packets, Evidence, Baselines, and Exceptions across 10 modules.

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js ≥ 22.5 (built-in `node:sqlite`) |
| HTTP server | Express 5 |
| Database | SQLite (file: `backend-node/asdlc.db`) |
| Frontend | Vanilla JS SPA (ES modules, no framework) |

> **Python/Docker alternative**: A full PostgreSQL + FastAPI backend lives in `backend/` (SQL schema, triggers, RLS, routers all written). Use it when Docker and Python are available — `backend-node/` is the zero-install fallback.

## Quick start

```bash
cd backend-node
npm install        # installs Express 5 only
node server.js     # starts on http://localhost:8000
```

Then open **http://localhost:8000** in your browser.

On first run the server:
1. Creates `asdlc.db` and applies the full schema (`schema.sql`)
2. Seeds demo data (idempotent — safe to restart) matching the wireframe examples

## Modules

| # | Module | Route |
|---|---|---|
| 1 | Repository Admin Home | `/` (default) |
| 2 | Project Setup & Access | `projects` |
| 3 | Agent Trust & Permission Console | `trust` |
| 4 | Change Packet Queue | `change_packets` |
| 5 | Evidence & Source Registry | `evidence` |
| 6 | Field-Level Audit Viewer | `audit` |
| 7 | Baseline & Version Manager | `baseline` |
| 8 | Reusable Knowledge/Pattern Library | `library` |
| 9 | Validation & Exception Queue | `validation` |
| 10 | Report Builder/Export Center | `reports` |

## Demo data

Seeded on first start (project: **ACME Pilot 1**, project code: `ACME-P1`):

- 5 users · 3 clients · 7 projects
- 12 agents with trust settings (Orchestrator=3, Intake=2, Process=3 …)
- 7 change packets (CP-2041 through CP-2035) with field-level diff items
- 6 evidence sources (transcript, report markup, corrected template, KA, production signal, voice note)
- 4 baselines (Draft Design, Build, Pilot, Production)
- 7 exceptions
- 3 report exports

## API

All endpoints at `/api/v1/`. The frontend injects `X-User-ID: <uuid>` on every request; the server uses it for `created_by`/`updated_by` and audit log.

Key endpoints:

```
GET  /api/v1/users
GET  /api/v1/dashboard
GET  /api/v1/projects
GET  /api/v1/projects/:id/agent-settings
PUT  /api/v1/projects/:id/agent-settings/:settingId

GET  /api/v1/change-packets?project_id=&status=&risk_level=
POST /api/v1/change-packets/:id/approve
POST /api/v1/change-packets/:id/reject
POST /api/v1/change-packets/:id/send-back
POST /api/v1/change-packets/:id/split

GET  /api/v1/evidence-sources?project_id=
GET  /api/v1/evidence-sources/:id/linked-items
GET  /api/v1/audit-log?table_name=&record_id=&project_id=
GET  /api/v1/baselines?project_id=
POST /api/v1/baselines/:id/lock
GET  /api/v1/baselines/:id/compare/:otherId
GET  /api/v1/exceptions?project_id=
GET  /api/v1/exceptions/summary?project_id=
GET  /api/v1/reports?project_id=
POST /api/v1/reports
GET  /api/v1/library?scope=&record_type=&status=
```

## Directory layout

```
agentic-sdlc-workbench/
├── README.md
├── docker-compose.yml          # PostgreSQL 16 (future use)
├── .env
├── backend/                    # FastAPI + PostgreSQL (future use)
│   ├── sql/001_schema.sql
│   ├── sql/002_triggers.sql
│   ├── sql/003_rls.sql
│   ├── sql/004_seed.sql
│   └── routers/
├── backend-node/               # Active: Node.js + SQLite
│   ├── package.json
│   ├── server.js               # Express app + all API routes
│   ├── db.js                   # DatabaseSync init + auditLog()
│   ├── seed.js                 # Idempotent demo data
│   └── schema.sql              # SQLite-compatible schema (28 tables)
└── frontend/
    ├── index.html
    ├── styles.css
    ├── app.js
    └── modules/
        ├── home.js
        ├── projects.js
        ├── trust.js
        ├── change_packets.js
        ├── evidence.js
        ├── audit.js
        ├── baseline.js
        ├── library.js
        ├── validation.js
        └── reports.js
```
