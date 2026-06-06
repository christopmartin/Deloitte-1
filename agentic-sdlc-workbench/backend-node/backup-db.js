// backup-db.js — consistent snapshot of the Workbench SQLite DB.
// Uses SQLite `VACUUM INTO`, which produces a transactionally-consistent single
// .db file even while the server is running (WAL allows concurrent readers).
// Usage:  node backup-db.js            (backs up ./asdlc.db, or $ASDLC_DB_PATH)
// Restore: stop the app, copy the backup over backend-node/asdlc.db, delete any
//          asdlc.db-wal / asdlc.db-shm, then restart.
'use strict';
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const dbPath = process.env.ASDLC_DB_PATH || path.join(__dirname, 'asdlc.db');
if (!fs.existsSync(dbPath)) {
  console.error('No database found at', dbPath, '— nothing to back up (a fresh boot would re-seed it).');
  process.exit(1);
}
const backupsDir = path.join(__dirname, 'backups');
fs.mkdirSync(backupsDir, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const out = path.join(backupsDir, `asdlc.${ts}.db`);

const db = new DatabaseSync(dbPath);
const sqlPath = out.replace(/\\/g, '/').replace(/'/g, "''");   // forward slashes + escape quotes for SQLite
db.exec("VACUUM INTO '" + sqlPath + "'");
db.close();

const size = fs.statSync(out).size;
const b = new DatabaseSync(out);
const count = (t) => { try { return b.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch { return 'n/a'; } };
const summary = {
  projects: count('asdlc_project'), use_cases: count('asdlc_use_case'),
  agents: count('asdlc_agent_spec'), tools: count('asdlc_tool'),
  data_models: count('asdlc_data_model'), business_logic: count('asdlc_business_logic'),
};
b.close();

console.log('✓ Backup written:', out);
console.log('  size:', (size / 1024).toFixed(1), 'KB');
console.log('  row counts:', JSON.stringify(summary));
