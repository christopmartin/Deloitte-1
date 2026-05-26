const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = new DatabaseSync(path.join(__dirname, 'asdlc.db'));
// Check agent catalog entries
const catalog = db.prepare('SELECT * FROM asdlc_agent_catalog LIMIT 20').all();
console.log('CATALOG COUNT:', catalog.length);
console.log('CATALOG SAMPLE:', JSON.stringify(catalog[0], null, 2));

// Check project for Exxon
const proj = db.prepare("SELECT project_id, project_name, project_code FROM asdlc_project WHERE project_code LIKE '%EXX%'").all();
console.log('EXX PROJECT:', JSON.stringify(proj));

// Check trust settings for Exxon project
const trust = db.prepare("SELECT pas.*, ac.agent_name FROM asdlc_project_agent_setting pas JOIN asdlc_agent_catalog ac ON ac.agent_catalog_id = pas.agent_catalog_id WHERE pas.project_id = (SELECT project_id FROM asdlc_project WHERE project_code LIKE '%EXX%' LIMIT 1)").all();
console.log('TRUST SETTINGS:', JSON.stringify(trust));

// Check exceptions
const exceptions = db.prepare("SELECT exception_type, severity, status, description FROM asdlc_exception WHERE project_id = (SELECT project_id FROM asdlc_project WHERE project_code LIKE '%EXX%' LIMIT 1) LIMIT 10").all();
console.log('EXCEPTIONS:', JSON.stringify(exceptions, null, 2));
