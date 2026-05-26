const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = new DatabaseSync(path.join(__dirname, 'asdlc.db'));

// Check table schema
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('TABLES:', tables.map(t => t.name).join(', '));

// Check asdlc_agent_catalog columns
const catCols = db.prepare("PRAGMA table_info(asdlc_agent_catalog)").all();
console.log('\nasdlc_agent_catalog columns:', catCols.map(c => c.name).join(', '));

// Check asdlc_project_agent_setting columns
const settingCols = db.prepare("PRAGMA table_info(asdlc_project_agent_setting)").all();
console.log('asdlc_project_agent_setting columns:', settingCols.map(c => c.name).join(', '));

// Check asdlc_exception columns
const exCols = db.prepare("PRAGMA table_info(asdlc_exception)").all();
console.log('asdlc_exception columns:', exCols.map(c => c.name).join(', '));
