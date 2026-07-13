# backend-node — Agentic SDLC Workbench backend

The real, actively-developed backend for the Workbench. Node.js + Express 5 + SQLite (via the built-in `node:sqlite` module) — no build step, no external database to stand up.

> There used to be a second, unfinished Python/FastAPI/PostgreSQL scaffold at `backend/` from before the project pivoted here. It was deleted 2026-07-13 — it had zero references from any live code.

## Run it

```bash
cd backend-node
npm install
cp .env.example .env    # fill in real values — see below
node server.js          # starts on http://localhost:8000 (or $PORT)
```

On first run the server creates `asdlc.db` from `schema.sql` and seeds idempotent demo data.

## Requirements

- Node.js **>= 22.5.0** — this is load-bearing, not incidental: `db.js` and several scripts use `node:sqlite`, which is unflagged only from 22.5 onward and has no fallback driver. The app will not start on an older Node LTS (e.g. 20.x).

## Environment variables

See [.env.example](.env.example) for the full list (~19 vars) with descriptions and placeholder values. Highlights:

- `ANTHROPIC_API_KEY` — Claude API key. Leave empty to run in deterministic "stub mode" (no AI calls, no cost) — this is how the test suite runs.
- `SN_INSTANCE` / `SN_USER` / `SN_PASSWORD` — ServiceNow connection (normally set per-project via the Admin UI instead; these env vars are a dev-only fallback).
- `ASDLC_DB_PATH` — override the SQLite file location.
- `ASDLC_ENCRYPT_KEY` — encrypts stored ServiceNow passwords at rest; without it they're stored in plaintext (a warning is logged).

## Testing

```bash
npm test
```

Runs every `test-*.js` file in this directory as one suite (`run-tests.js`), stopping at the first genuine failure. All suites are deterministic and stub-mode-safe (forced `ANTHROPIC_API_KEY=''`, isolated temp DB, randomized port, mocked ServiceNow fetches) — none require live credentials.

Note: on Windows, a suite that boots a real HTTP server can occasionally hit a known libuv shutdown artifact (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`) *after* its own assertions have already passed. `run-tests.js` recognizes this exact signature and reports it as a warning rather than a failure.

## Database backups

`backup-db.js` takes a consistent snapshot of `asdlc.db` via SQLite's `VACUUM INTO` (safe to run while the server is up) into `backups/`:

```bash
node backup-db.js
```

This is scheduled to run automatically — see the Task Scheduler setup documented at the top of [backup-db.js](backup-db.js).

## Layout

| Path | What it is |
|---|---|
| `server.js` | Express app + all ~200 API routes under `/api/v1/*` |
| `db.js` | `DatabaseSync` init, migrations, `auditLog()` |
| `schema.sql` | Full SQLite schema |
| `seed.js` | Idempotent demo data |
| `agent/` | AI pipeline — ingestion, extraction, reconciliation, ServiceNow capture/sync/discovery |
| `report-html.js` | Standalone printable Design Report generator |
| `run-tests.js` | Aggregate test runner (`npm test`) |
| `backup-db.js` | DB snapshot script |

## Key route groups (`/api/v1/*`)

`users`, `clients`, `projects`, `dashboard`, `ingest-documents`, `change-packets`, `change-packet-items`, `evidence-sources`, `audit-log`, `baselines`, `library`, `exceptions`, `reports`, `design-entity-catalog`, `best-practices`, `cost-assumption`, `rate-card`, `usage`, `feedback`, `settings`, `admin`, `servicenow/*` (capture, sync, discovery planner, assessment, catalog).
