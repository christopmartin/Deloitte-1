/**
 * repair_staged_no_extractions.js — one-off data repair for backlog "Data
 * Maintenance keepDocuments reset used the wrong status."
 *
 * Documents reset by design-wipe.js's keepDocuments path were set to
 * ingest_status='staged' even though their extraction rows were deleted in the
 * same operation — a state the rest of the codebase never expects ('staged'
 * always means "has real staged extraction rows"). This left the Document
 * Catalog screen unable to offer "Submit for Analysis" for those documents.
 * design-wipe.js now resets to 'pending' instead; this script corrects any
 * documents already left in the broken state by the old code.
 *
 * Idempotent + audit-logged — safe to re-run (matches zero rows once fixed).
 */
'use strict';
const { db, auditLog } = require('./db');

const ACTOR = '11111111-0000-0000-0000-000000000001';

const stuck = db.prepare(`
  SELECT ingest_id, project_id, document_title, ingest_status, change_packets_generated
  FROM asdlc_ingest_document
  WHERE ingest_status = 'staged'
    AND ingest_id NOT IN (SELECT ingest_id FROM asdlc_ingest_extraction WHERE status = 'staged')
`).all();

if (!stuck.length) {
  console.log('No documents stuck in staged-with-no-extractions state. Nothing to repair.');
  process.exit(0);
}

db.exec('BEGIN');
try {
  for (const doc of stuck) {
    db.prepare(`
      UPDATE asdlc_ingest_document
      SET ingest_status='pending', updated_at=datetime('now')
      WHERE ingest_id=?
    `).run(doc.ingest_id);
    auditLog('asdlc_ingest_document', doc.ingest_id, 'UPDATE',
      { ingest_status: doc.ingest_status },
      { ingest_status: 'pending', reason: 'repair: staged with zero staged extractions after design-wipe keepDocuments reset' },
      ACTOR);
    console.log(`  • ${doc.document_title} (${doc.ingest_id}) — staged → pending`);
  }
  db.exec('COMMIT');
  console.log(`✅ Repaired ${stuck.length} document(s).`);
} catch (err) {
  db.exec('ROLLBACK');
  console.error('❌ Rolled back:', err.message);
  process.exitCode = 1;
}
