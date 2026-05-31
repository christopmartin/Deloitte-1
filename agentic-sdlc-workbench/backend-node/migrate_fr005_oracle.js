/**
 * migrate_fr005_oracle.js — closes Plan A's gap.
 *
 * The "change SAP to Oracle" ingest renamed only tool T-002. Plan A then propagated
 * to the step/participant/path/UC layer but MISSED the requirements. FR-005 still
 * describes the conditional detail retrieval (now Oracle) as "SAP", and NFR-004's
 * source-system list omits Oracle. This fixes both. NFR-007 ("extended SAP narrative")
 * is intentionally LEFT unchanged — it's ambiguous (could mean the Oracle detail record
 * or the new SAP payment-history) and is the kind of call a human/clarification should make.
 *
 * Requiring ./db also applies pending db.js migrations (incl. ripple_scan_scope).
 * Idempotent + audit-logged.
 */
'use strict';
const { db, auditLog } = require('./db');

const PID = 'EE000000-0000-0000-0000-000000000010';
const ACTOR = '11111111-0000-0000-0000-000000000001';
const log = [];

db.exec('BEGIN');
try {
  // FR-005 — conditional detail retrieval is now Oracle (both title + description).
  const fr = db.prepare("SELECT fr_id, title, description FROM asdlc_functional_req WHERE project_id=? AND slug='FR-005'").get(PID);
  if (fr && (/SAP/.test(fr.title) || /SAP/.test(fr.description))) {
    const nt = fr.title.replace(/SAP/g, 'Oracle');
    const nd = fr.description.replace(/SAP/g, 'Oracle');
    db.prepare("UPDATE asdlc_functional_req SET title=?, description=?, updated_by=?, updated_at=datetime('now') WHERE fr_id=?")
      .run(nt, nd, ACTOR, fr.fr_id);
    auditLog('asdlc_functional_req', fr.fr_id, 'UPDATE', { title: fr.title, description: fr.description }, { title: nt, description: nd }, ACTOR);
    log.push(`FR-005 SAP→Oracle: "${nt}"`);
  } else log.push('FR-005 already Oracle (skipped)');

  // NFR-004 — add Oracle to the read-only source list (SAP stays: payment history).
  const nfr = db.prepare("SELECT nfr_id, description FROM asdlc_nonfunctional_req WHERE project_id=? AND slug='NFR-004'").get(PID);
  if (nfr && /ServiceNow read APIs, SAP, Supplier Master/.test(nfr.description)) {
    const nd = nfr.description.replace('ServiceNow read APIs, SAP, Supplier Master', 'ServiceNow read APIs, Oracle, SAP, Supplier Master');
    db.prepare("UPDATE asdlc_nonfunctional_req SET description=?, updated_by=?, updated_at=datetime('now') WHERE nfr_id=?")
      .run(nd, ACTOR, nfr.nfr_id);
    auditLog('asdlc_nonfunctional_req', nfr.nfr_id, 'UPDATE', { description: nfr.description }, { description: nd }, ACTOR);
    log.push('NFR-004 source list: added Oracle (SAP kept for payment history)');
  } else log.push('NFR-004 already includes Oracle (skipped)');

  db.exec('COMMIT');
  console.log('✅ Requirement cleanup committed.\n' + log.map(l => '  • ' + l).join('\n'));
  console.log('  • NFR-007 left unchanged (ambiguous "SAP narrative" — flagged for human review)');
  // Confirm the ripple_scan_scope migration applied
  const hasCol = db.prepare("PRAGMA table_info(asdlc_project)").all().some(c => c.name === 'ripple_scan_scope');
  console.log('  • ripple_scan_scope column present:', hasCol);
} catch (err) {
  db.exec('ROLLBACK');
  console.error('❌ Rolled back:', err.message);
  process.exitCode = 1;
}
