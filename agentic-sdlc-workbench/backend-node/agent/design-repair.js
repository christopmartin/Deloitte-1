// agent/design-repair.js
//
// DETERMINISTIC (non-AI), idempotent repair of relational gaps the ingest pipeline
// leaves behind. ONE source of truth for two recurring defects:
//
//   1. Orphan requirements — FR/NFR rows materialized with use_case_id = NULL.
//      Requirements have registry order 0 (materialized BEFORE the use case at
//      order 1), so resolveParents has nothing to link to at create time. The fix
//      relies on a post-apply pass; if that pass didn't run (e.g. a stale server
//      when the packet was approved) the orphan persists forever with no recovery.
//
//   2. Swimlane "way off" — workflows with no participants, no step owners, and no
//      paths, so every step renders in a single red "Missing Owner" lane in a flat
//      row (see agent/swimlane-deriver.js for the full explanation).
//
// Both are healed deterministically and idempotently here, so the live apply path,
// a backfill script, and a repair endpoint all share the exact same behavior.
//
'use strict';

const { db } = require('../db');
const registry = require('./entity-registry');
const { deriveSwimlane } = require('./swimlane-deriver');

/**
 * Link FR/NFR rows whose use_case_id is NULL to their parent use case.
 * Per orphan: (1) exact use_case_title match recovered from the originating CP item;
 * (2) fallback — if the project has exactly ONE non-retired use case, link to it
 *     (the common single-UC case, which makes the project self-heal even when the
 *     extractor omitted the title). Returns { linked }.
 */
function relinkOrphanRequirements(projectId, uid) {
  let linked = 0;
  if (!projectId) return { linked };

  const ucs = db.prepare(
    "SELECT use_case_id, title FROM asdlc_use_case " +
    "WHERE project_id = ? AND (lifecycle_status IS NULL OR lifecycle_status != 'retired')"
  ).all(projectId);
  const soleUc = ucs.length === 1 ? ucs[0] : null;
  const ucIdByTitle = new Map(ucs.map(u => [u.title, u.use_case_id]));

  for (const et of ['functional_req', 'nonfunctional_req']) {
    const entity = registry.byEntityType[et];
    const orphans = db.prepare(
      `SELECT ${entity.pk} AS id FROM ${entity.table} WHERE project_id = ? AND use_case_id IS NULL`
    ).all(projectId);
    if (!orphans.length) continue;

    const upd = db.prepare(`UPDATE ${entity.table} SET use_case_id = ?, updated_by = ? WHERE ${entity.pk} = ?`);
    for (const o of orphans) {
      let ucId = null;
      const item = db.prepare(
        "SELECT new_value FROM asdlc_change_packet_item WHERE entity_id = ? ORDER BY created_at DESC LIMIT 1"
      ).get(o.id);
      if (item) {
        let data; try { data = JSON.parse(item.new_value); } catch { data = {}; }
        if (data.use_case_title && ucIdByTitle.has(data.use_case_title)) ucId = ucIdByTitle.get(data.use_case_title);
      }
      if (!ucId && soleUc) ucId = soleUc.use_case_id;
      if (ucId) { upd.run(ucId, uid, o.id); linked++; }
    }
  }
  return { linked };
}

/**
 * Full deterministic repair for one project: relink orphan requirements + derive
 * swimlane structure (participants, step owners, sequential paths) for every
 * workflow. Idempotent and additive — safe to run any number of times.
 */
function repairProjectDesign(projectId, uid) {
  const out = { linked: 0, workflows: 0, participantsCreated: 0, ownersSet: 0, pathsCreated: 0 };
  out.linked = relinkOrphanRequirements(projectId, uid).linked;

  const wfs = db.prepare(
    "SELECT workflow_id FROM asdlc_workflow WHERE project_id = ? AND (lifecycle_status IS NULL OR lifecycle_status != 'retired')"
  ).all(projectId);
  for (const wf of wfs) {
    const s = deriveSwimlane(wf.workflow_id, projectId, uid);
    out.workflows++;
    out.participantsCreated += s.participantsCreated;
    out.ownersSet           += s.ownersSet;
    out.pathsCreated        += s.pathsCreated;
  }
  return out;
}

module.exports = { relinkOrphanRequirements, repairProjectDesign };
