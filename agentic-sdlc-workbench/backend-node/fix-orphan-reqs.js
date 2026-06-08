// fix-orphan-reqs.js
//
// ONE-TIME retroactive fix: finds all materialized FR/NFR rows with use_case_id=NULL
// and uses the AI req-linker to infer the correct parent use case, then writes it back.
//
// For projects with a single use case, every unambiguous FR/NFR is auto-assigned
// without an API call (fast path). Multi-UC projects use the Haiku AI Agent.
//
// Run:  node fix-orphan-reqs.js   (from backend-node/)
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { db, generateId } = require('./db');
const { linkRequirements } = require('./agent/req-linker');

async function main() {
  const projects = db.prepare('SELECT project_id, project_name FROM asdlc_project').all();
  let totalFixed = 0, totalSkipped = 0;

  for (const proj of projects) {
    const { project_id, project_name } = proj;

    // Orphan FRs/NFRs: materialized with use_case_id = NULL
    const orphanFRs = db.prepare(
      "SELECT fr_id AS id, 'functional_req' AS entity_type, slug, title, description FROM asdlc_functional_req WHERE project_id=? AND use_case_id IS NULL"
    ).all(project_id);
    const orphanNFRs = db.prepare(
      "SELECT nfr_id AS id, 'nonfunctional_req' AS entity_type, slug, title, description FROM asdlc_nonfunctional_req WHERE project_id=? AND use_case_id IS NULL"
    ).all(project_id);
    const allOrphans = [...orphanFRs, ...orphanNFRs];

    if (allOrphans.length === 0) {
      console.log(`[${project_name}] ✓ no orphans`);
      continue;
    }

    const useCases = db.prepare(
      "SELECT use_case_id, title, summary FROM asdlc_use_case WHERE project_id=? AND (lifecycle_status IS NULL OR lifecycle_status != 'retired') ORDER BY created_at"
    ).all(project_id);

    if (useCases.length === 0) {
      console.log(`[${project_name}] ${allOrphans.length} orphans but NO use cases — skipping`);
      totalSkipped += allOrphans.length;
      continue;
    }

    console.log(`\n[${project_name}] ${allOrphans.length} orphans, ${useCases.length} use case(s)`);

    let links = {};

    // Fast path: single use case → assign all unambiguous FRs to it (no AI call needed)
    const distinctUCs = [...new Map(useCases.map(u => [u.title, u])).values()];
    if (distinctUCs.length === 1) {
      const ucTitle = distinctUCs[0].title;
      console.log(`  → single UC "${ucTitle}" — assigning all orphans directly`);
      for (const o of allOrphans) links[o.title] = ucTitle;
    } else {
      // Multi-UC: call AI Agent req-linker
      console.log(`  → ${distinctUCs.length} UCs — calling AI Agent req-linker...`);
      const fakeExtractions = allOrphans.map(o => ({
        entity_type:  o.entity_type,
        entity_data:  { title: o.title, description: o.description },
      }));
      links = await linkRequirements(fakeExtractions, distinctUCs, project_id);
    }

    // Build title → use_case_id lookup
    const ucIdByTitle = {};
    for (const uc of useCases) ucIdByTitle[uc.title] = uc.use_case_id;

    const updateFR  = db.prepare('UPDATE asdlc_functional_req    SET use_case_id=? WHERE fr_id=?  AND project_id=?');
    const updateNFR = db.prepare('UPDATE asdlc_nonfunctional_req SET use_case_id=? WHERE nfr_id=? AND project_id=?');

    for (const o of allOrphans) {
      const ucTitle = links[o.title];
      const ucId    = ucTitle ? ucIdByTitle[ucTitle] : null;
      if (!ucId) {
        console.log(`  ✗ ${o.slug} "${o.title}" — no match (remains orphan)`);
        totalSkipped++;
        continue;
      }
      if (o.entity_type === 'functional_req') {
        updateFR.run(ucId, o.id, project_id);
      } else {
        updateNFR.run(ucId, o.id, project_id);
      }
      console.log(`  ✓ ${o.slug} "${o.title}" → "${ucTitle}"`);
      totalFixed++;
    }
  }

  console.log(`\n=== Done: ${totalFixed} linked, ${totalSkipped} skipped ===`);
  db.close();
}

main().catch(e => { console.error('ERROR:', e); process.exit(1); });
