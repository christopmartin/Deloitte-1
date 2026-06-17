// agent/prompt-templates.js
//
// Loads the static prompt prose from agent/prompts/*.md and renders it with
// {{placeholder}} substitution. The PROSE lives in versioned files; the ASSEMBLY
// logic (which sections to include, in what order) stays in the caller.
//
// Mirrors wiki-context.js: load-once + cache, normalize line endings, and a
// graceful fallback (a missing template returns '' and logs a warning rather
// than crashing extraction). Files are byte-stable so the prompt cache holds.
//
// To pick up edits, restart the server (templates are cached on first read).
//
'use strict';

const fs   = require('fs');
const path = require('path');

const PROMPTS_DIR = path.join(__dirname, 'prompts');
const _cache = new Map();

/**
 * Read a template file once. Normalizes CRLF→LF and strips a single trailing
 * newline so a file may end with a newline on disk without changing assembly.
 * Returns null (cached) when the file is missing.
 */
function loadRaw(name) {
  if (_cache.has(name)) return _cache.get(name);
  let text;
  try {
    text = fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf8')
      .replace(/\r\n/g, '\n');
    if (text.endsWith('\n')) text = text.slice(0, -1);
  } catch (err) {
    console.warn(`[prompt-templates] missing template "${name}": ${err.message}`);
    text = null;
  }
  _cache.set(name, text);
  return text;
}

/**
 * Render a template, substituting {{var}} occurrences from `vars`. Unknown
 * placeholders are left intact. Substituted values are inserted literally (no
 * re-scanning), so a value containing {{...}} or $ is safe.
 * @param {string} name  e.g. 'extraction/confidence-rules'
 * @param {Object<string,*>} [vars]
 * @returns {string}
 */
function render(name, vars = {}) {
  const raw = loadRaw(name);
  if (raw == null) return '';
  return raw.replace(/\{\{(\w+)\}\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m);
}

module.exports = { render };
