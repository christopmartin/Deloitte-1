// agent/wiki-context.js
//
// Loads a static "LLM Wiki" of ServiceNow Now Assist / AI Agents design
// best-practices and exposes it as a prompt-cacheable system block that the
// design-related Claude calls inject as supplementary reference.
//
// WHY
// ---
// The wiki is small (~28K tokens). Per the handoff doc, the right approach is
// load-once + prompt-cache, NOT a vector DB / RAG pipeline:
//   1. Load all wiki *.md files into one byte-stable string at startup.
//   2. Inject it as the FIRST system block with an ephemeral cache breakpoint,
//      so it forms a shared, stable prefix across every call site → one cache
//      write per model, then ~10% input cost on subsequent calls.
//
// SOURCE
// ------
// Read LIVE from the vault path at startup (default below; override with the
// WIKI_DIR env var). The path is machine-specific and will not exist on deploy
// or other machines — so this module DEGRADES GRACEFULLY: if the directory is
// missing/empty or any read fails, the wiki text is null and withWiki() becomes
// a no-op, leaving every call site byte-identical to its pre-wiki behavior.
//
// To pick up wiki edits, restart the server (loaded once at require time).
//
'use strict';

const fs   = require('fs');
const path = require('path');

const WIKI_DIR = path.resolve(
  process.env.WIKI_DIR || 'C:\\Users\\christopmartin\\Documents\\Wiki\\Wiki\\Wiki'
);

// Stable framing line prepended INSIDE the cached block. Keep it byte-stable —
// any change to this prefix invalidates the prompt cache. Frames the wiki as
// supplementary, ServiceNow-scoped reference (not "answer only from the KB").
const FRAMING =
  'Authoritative ServiceNow Now Assist / AI Agents design reference — apply ' +
  'where the work targets ServiceNow; supplementary to the task instructions below.';

/**
 * Read every *.md file in the wiki dir into one byte-stable string.
 * Ordering: alphabetical, but index.md is forced first (it is the table of
 * contents). Each file is wrapped as <page name="<basename-without-ext>">.
 * Returns null on any failure or if no pages were found.
 */
function loadWiki(dir) {
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) {
      console.warn(`[wiki-context] WIKI_DIR is not a directory: ${dir} — wiki disabled`);
      return null;
    }
    const files = fs.readdirSync(dir)
      .filter(f => f.toLowerCase().endsWith('.md'))
      .sort((a, b) => {
        // index.md first, then alphabetical — deterministic byte order.
        const ai = a.toLowerCase() === 'index.md';
        const bi = b.toLowerCase() === 'index.md';
        if (ai !== bi) return ai ? -1 : 1;
        return a.localeCompare(b);
      });
    if (files.length === 0) {
      console.warn(`[wiki-context] no .md files in ${dir} — wiki disabled`);
      return null;
    }
    const pages = files.map(f => {
      const name = f.replace(/\.md$/i, '');
      const body = fs.readFileSync(path.join(dir, f), 'utf-8');
      return `<page name="${name}">\n${body}\n</page>`;
    });
    const text = FRAMING + '\n\n' + pages.join('\n\n');
    console.log(`[wiki-context] loaded ${files.length} pages, ~${text.length} chars from ${dir}`);
    return text;
  } catch (err) {
    console.warn(`[wiki-context] could not load wiki from ${dir}: ${err.message} — wiki disabled`);
    return null;
  }
}

// Loaded ONCE at require time; byte-stable for the process lifetime.
const WIKI_TEXT = loadWiki(WIKI_DIR);

/** The assembled ephemeral-cached system block, or null if no wiki loaded. */
function getWikiBlock() {
  return WIKI_TEXT
    ? { type: 'text', text: WIKI_TEXT, cache_control: { type: 'ephemeral' } }
    : null;
}

/**
 * Normalize a `system` value (string | array-of-blocks | undefined) into an
 * array with the wiki block placed FIRST, so the wiki is a shared byte-stable
 * cache prefix across all call sites. When no wiki is loaded, returns the input
 * unchanged — the graceful no-op.
 */
function withWiki(system) {
  const block = getWikiBlock();
  if (!block) return system;                                  // no-op: input unchanged
  if (system == null) return [block];                         // absent → [wiki]
  if (typeof system === 'string') return [block, { type: 'text', text: system }];
  if (Array.isArray(system)) return [block, ...system];       // array → [wiki, ...existing]
  return [block, system];                                     // defensive: single block object
}

module.exports = { getWikiBlock, withWiki };
