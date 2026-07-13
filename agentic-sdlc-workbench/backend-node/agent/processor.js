// agent/processor.js — processor router
//
// Picks the real Claude extraction engine when ANTHROPIC_API_KEY is set,
// falls back to the stub processor for local dev without a key.
//
// Then runs the ingest cross-check (agent/cross-check.js) for BOTH engines — it has a
// free deterministic tier (ripple + requirement token scan) plus LLM tiers, so it adds
// value even without a key. Centralised here so it runs exactly once per extraction round,
// regardless of which engine produced the extractions.
//
'use strict';

const { db } = require('../db');

const hasKey =
  process.env.ANTHROPIC_API_KEY &&
  process.env.ANTHROPIC_API_KEY !== 'paste-your-anthropic-key-here';

const engine = hasKey
  ? (console.log('[processor] ANTHROPIC_API_KEY detected — using claude-processor'), require('./claude-processor'))
  : (console.log('[processor] No ANTHROPIC_API_KEY — falling back to stub-processor'), require('./stub-processor'));

async function processDocument(ingestId) {
  const result = await engine.processDocument(ingestId);

  // ── Cross-check pass (ripple + requirement-conflict detection) ──────────────
  // Never fatal. May raise blocking 'conflict:' clarifications, which flips the
  // document back to review_required and blocks promote until answered.
  try {
    const { runCrossCheck, DISCOVERY_PREFIX } = require('./cross-check');
    const doc = db.prepare(`
      SELECT d.*, p.project_name FROM asdlc_ingest_document d
      LEFT JOIN asdlc_project p ON p.project_id = d.project_id
      WHERE d.ingest_id = ?
    `).get(ingestId);
    if (doc) {
      const round = result && result.round ? result.round : 1;
      const cc = await runCrossCheck({ doc, round });

      // ── ServiceNow overlap check (BACKLOG #114) ────────────────────────────────
      // Best-effort, never fatal, zero cost for a non-ServiceNow project (checked inside).
      // Raises 'sn_overlap:' clarifications — same blocking weight as a real conflict.
      let overlapRaised = 0;
      try {
        const { checkServiceNowOverlap } = require('./sn-overlap-check');
        overlapRaised = (await checkServiceNowOverlap({ doc, ingestId, round })).raised || 0;
      } catch (err) {
        console.warn(`[processor] ServiceNow overlap check failed (non-fatal): ${err.message}`);
      }

      const raised = (cc.conflicts_raised || 0) + (cc.fyi_raised || 0) + overlapRaised;
      if (raised > 0) {
        // Recompute status to reflect any newly-raised (blocking) clarifications. Excludes
        // discovery: rows (ServiceNow discovery-plan ambiguities) — those are advisory-only
        // and live in their own mini-form, never this document's real Q&A loop.
        const openQ = db.prepare(
          "SELECT COUNT(*) c FROM asdlc_ingest_clarification WHERE ingest_id=? AND answer_text IS NULL AND target_field NOT LIKE ?"
        ).get(ingestId, `${DISCOVERY_PREFIX}%`).c;
        const newStatus = openQ > 0 ? 'review_required' : (result.new_status || 'staged');
        db.prepare("UPDATE asdlc_ingest_document SET ingest_status=?, updated_at=datetime('now') WHERE ingest_id=?")
          .run(newStatus, ingestId);
        result.new_status = newStatus;
        result.clarifications_raised = (result.clarifications_raised || 0) + raised;
      }
      result.cross_check = cc;
    }
  } catch (err) {
    console.warn(`[processor] cross-check pass failed (non-fatal): ${err.message}`);
  }

  return result;
}

module.exports = { processDocument };
