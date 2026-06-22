// backfill-sn-artifacts.js
// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 backfill: create one generic asdlc_sn_artifact "twin" for every existing
// Level-1 SN-technical row that carries a source_sys_id, and back-link the L1 row
// (sn_artifact_id). This brings the live data onto the generic substrate without
// disturbing the clean non-technical Level-1 views.
//
// IDEMPOTENT + reversible-by-design: skips rows already linked (sn_artifact_id set)
// and rows whose source_sys_id already has an artifact in the project. Re-runnable.
//
//   node backfill-sn-artifacts.js            # apply
//   node backfill-sn-artifacts.js --dry-run  # report only, no writes
'use strict';
const { db, generateId, nextSlug } = require('./db');
const reg = require('./agent/sn-type-registry');

// L1 table → its business (non-provenance) columns that make up the projected payload.
const L1 = [
  { table: 'asdlc_data_model',     pk: 'data_model_id',     etype: 'data_model',
    cols: ['name', 'purpose', 'physical_name', 'extends_table', 'fields', 'relationships', 'audited'], json: ['fields', 'relationships'] },
  { table: 'asdlc_form_design',    pk: 'form_design_id',    etype: 'form_design',
    cols: ['name', 'view_name', 'sections', 'related_lists', 'mandatory_fields', 'readonly_fields', 'behavior_notes'], json: ['sections', 'related_lists', 'mandatory_fields', 'readonly_fields'] },
  { table: 'asdlc_business_logic', pk: 'business_logic_id', etype: 'business_logic',
    cols: ['name', 'logic_type', 'plain_english', 'when_runs', 'conditions', 'run_order'], json: [] },
  { table: 'asdlc_catalog_item',   pk: 'catalog_item_id',   etype: 'catalog_item',
    cols: ['name', 'short_description', 'category', 'variables', 'who_can_order', 'delivery_time'], json: ['variables'] },
  { table: 'asdlc_integration',    pk: 'integration_id',    etype: 'integration',
    cols: ['name', 'description', 'endpoint', 'auth_type', 'functions', 'alias_type', 'connection_type', 'notes'], json: ['functions'] },
];

function buildPayload(row, spec) {
  const payload = {};
  for (const c of spec.cols) {
    let v = row[c];
    if (v === undefined || v === null) continue;
    if (spec.json.includes(c) && typeof v === 'string') { try { v = JSON.parse(v); } catch { /* keep raw */ } }
    payload[c] = v;
  }
  return payload;
}

function run({ dryRun = false } = {}) {
  const summary = { created: 0, linked: 0, skipped_linked: 0, skipped_no_sysid: 0, skipped_existing_twin: 0, by_table: {} };

  for (const spec of L1) {
    let rows = [];
    try {
      rows = db.prepare(
        `SELECT * FROM ${spec.table} WHERE (lifecycle_status IS NULL OR lifecycle_status != 'retired')`
      ).all();
    } catch { continue; }   // table absent on an old DB
    const t = (summary.by_table[spec.table] = { created: 0, skipped: 0 });

    for (const row of rows) {
      if (row.sn_artifact_id) { summary.skipped_linked++; t.skipped++; continue; }
      if (!row.source_sys_id)  { summary.skipped_no_sysid++; t.skipped++; continue; }

      // Idempotency: an artifact with this sys_id may already exist (prior partial run).
      const twin = db.prepare(
        'SELECT sn_artifact_id AS id FROM asdlc_sn_artifact WHERE source_sys_id = ? AND project_id = ? LIMIT 1'
      ).get(row.source_sys_id, row.project_id);
      if (twin) {
        if (!dryRun) db.prepare(`UPDATE ${spec.table} SET sn_artifact_id = ? WHERE ${spec.pk} = ?`).run(twin.id, row[spec.pk]);
        summary.skipped_existing_twin++; summary.linked++; t.skipped++;
        continue;
      }

      const entry = reg.resolveType(row.source_table || spec.etype);
      const payload = buildPayload(row, spec);
      if (dryRun) { summary.created++; t.created++; continue; }

      const id = generateId();
      let slug = null; try { slug = nextSlug('asdlc_sn_artifact', 'ART', row.project_id); } catch { slug = null; }
      db.prepare(`INSERT INTO asdlc_sn_artifact (sn_artifact_id, project_id, slug, sn_metadata_type, fluent_api_name,
          deploy_strategy, tier, name, payload, override_fields, projected_entity_type, projected_entity_id,
          source_system, source_sys_id, source_table, source_scope, source_fluent, source_hash, created_by, updated_by)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, row.project_id, slug, entry.sn_metadata_type, entry.fluent_api_name || null,
          reg.deployStrategyFor(entry, {}), entry.tier, row.name || '(unnamed)', JSON.stringify(payload), '{}',
          spec.etype, row[spec.pk],
          row.source_system || 'servicenow', row.source_sys_id, row.source_table || entry.source_table || null,
          row.source_scope || null, row.source_fluent || null, row.source_hash || null, 'backfill', 'backfill');
      db.prepare(`UPDATE ${spec.table} SET sn_artifact_id = ? WHERE ${spec.pk} = ?`).run(id, row[spec.pk]);
      summary.created++; summary.linked++; t.created++;
    }
  }
  return summary;
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  const res = run({ dryRun });
  console.log(`[backfill-sn-artifacts]${dryRun ? ' (dry-run)' : ''}`, JSON.stringify(res, null, 2));
}

module.exports = { run, buildPayload, L1 };
