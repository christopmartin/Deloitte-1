'use strict';
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'asdlc.db'));

const proj = db.prepare("SELECT project_id FROM asdlc_project WHERE project_code = 'EXX-P1'").get();
if (!proj) { console.error('EXX-P1 project not found'); process.exit(1); }

const catalog = db.prepare('SELECT workbench_agent_id, agent_name, agent_type, default_trust_level FROM asdlc_agent_catalog').all();
console.log('Catalog agents:', catalog.length);

const defaults = {
  orchestrator: 3, intake: 2, change_intake: 2, process: 3,
  workflow_design: 3, agent_architect: 3, cost: 2, testing: 3,
  validation: 3, governance: 2, story: 3, reviewer: 3,
};

let inserted = 0;
for (const agent of catalog) {
  const existing = db.prepare('SELECT 1 FROM asdlc_project_agent_setting WHERE project_id = ? AND workbench_agent_id = ?').get(proj.project_id, agent.workbench_agent_id);
  if (!existing) {
    const key   = (agent.agent_type || agent.agent_name || '').toLowerCase().replace(/\s+/g, '_');
    const trust = defaults[key] ?? agent.default_trust_level ?? 3;
    db.prepare(`INSERT INTO asdlc_project_agent_setting
      (project_agent_setting_id, project_id, workbench_agent_id, trust_level, enabled)
      VALUES (?, ?, ?, ?, 1)`
    ).run(crypto.randomUUID(), proj.project_id, agent.workbench_agent_id, trust);
    inserted++;
    console.log(`  Seeded: ${agent.agent_name} (${agent.agent_type}) -> trust ${trust}`);
  } else {
    console.log(`  Already exists: ${agent.agent_name}`);
  }
}
console.log(`\nDone. Inserted ${inserted} trust setting(s).`);
