// agent/wiki-context.js
//
// Loads a static "LLM Wiki" of ServiceNow Now Assist / AI Agents design
// best-practices and exposes it to the design-related Claude calls as
// supplementary reference. Two delivery modes:
//
//   1. FULL  (withWiki)        — the whole wiki as one ephemeral-cached system
//      block. Used by the ServiceNow round-trip modules (reverse-engineer,
//      reconcile, review) and other single-shot calls that have no tool loop.
//
//   2. CORE + on-demand (hybrid) — a small always-injected "core" (framing +
//      index/TOC + a list of available pages) plus a `read_wiki_page` tool the
//      model calls to pull a full page only when it needs it. Used by the ingest
//      extraction loop, which has the agentic tool loop to answer the tool. This
//      is "progressive disclosure": only the pages actually requested enter
//      context, instead of always paying for the full ~33K-token wiki.
//
// PLATFORM GATING
// ---------------
// Both modes are ServiceNow-scoped. When the caller passes a platform that is
// explicitly NOT ServiceNow (e.g. 'generic'), the wiki is omitted entirely.
// A null/undefined platform is treated as ServiceNow (backward-compatible with
// callers that don't pass one).
//
// SOURCE
// ------
// Read LIVE at startup from a directory resolved as: asdlc_app_setting('wiki_dir')
// → WIKI_DIR env var → the hardcoded default below. The path is machine-specific
// and will not exist on deploy or other machines — so this module DEGRADES
// GRACEFULLY: if the directory is missing/empty or any read fails, the wiki is
// null and every accessor becomes a no-op, leaving each call site byte-identical
// to its pre-wiki behavior.
//
// To pick up wiki edits (or a changed path), restart the server (loaded once at
// require time).
//
'use strict';

const fs   = require('fs');
const path = require('path');

const DEFAULT_WIKI_DIR = 'C:\\Users\\christopmartin\\Documents\\Wiki\\Wiki\\Wiki';

// Resolve the wiki directory via the standard setting → env → default chain,
// mirroring ai-config.resolveModel. Wrapped in try/catch because this runs at
// require time, before the DB is guaranteed ready.
function resolveWikiDir() {
  try {
    const { getSetting } = require('../db');
    return path.resolve(getSetting('wiki_dir', DEFAULT_WIKI_DIR, 'WIKI_DIR'));
  } catch {
    return path.resolve(process.env.WIKI_DIR || DEFAULT_WIKI_DIR);
  }
}

const WIKI_DIR = resolveWikiDir();

// Stable framing line prepended INSIDE the cached block. Keep it byte-stable —
// any change to this prefix invalidates the prompt cache. Frames the wiki as
// supplementary, ServiceNow-scoped reference (not "answer only from the KB").
const FRAMING =
  'Authoritative ServiceNow Now Assist / AI Agents design reference — apply ' +
  'where the work targets ServiceNow; supplementary to the task instructions below.';

/** First markdown heading (or first non-empty line) of a page body, for the TOC. */
function pageSummary(body) {
  const lines = String(body || '').split('\n');
  for (const ln of lines) {
    const t = ln.trim();
    if (!t) continue;
    const h = t.match(/^#+\s+(.*)$/);
    return (h ? h[1] : t).slice(0, 100);
  }
  return '';
}

/**
 * Read every *.md file in the wiki dir. Returns a structured wiki:
 *   { full, core, pages: {name: body}, names: [name], toc: [{name, summary}] }
 * Ordering: index.md first, then alphabetical (deterministic byte order so the
 * core/full blocks are cache-stable). Returns null on any failure / empty dir.
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
        const ai = a.toLowerCase() === 'index.md';
        const bi = b.toLowerCase() === 'index.md';
        if (ai !== bi) return ai ? -1 : 1;
        return a.localeCompare(b);
      });
    if (files.length === 0) {
      console.warn(`[wiki-context] no .md files in ${dir} — wiki disabled`);
      return null;
    }

    const pages = {};
    const names = [];
    let indexBody = '';
    const wrapped = [];                          // for the FULL block
    for (const f of files) {
      const name = f.replace(/\.md$/i, '');
      const body = fs.readFileSync(path.join(dir, f), 'utf-8');
      wrapped.push(`<page name="${name}">\n${body}\n</page>`);
      if (name.toLowerCase() === 'index') { indexBody = body; continue; }
      pages[name] = body;
      names.push(name);
    }

    // FULL block — every page concatenated (unchanged from the original behavior).
    const full = FRAMING + '\n\n' + wrapped.join('\n\n');

    // CORE block — framing + index/TOC + a list of fetchable pages. Small + stable.
    const toc = names.map(n => ({ name: n, summary: pageSummary(pages[n]) }));
    const listing = toc.map(t => `  - ${t.name}${t.summary ? ` — ${t.summary}` : ''}`).join('\n');
    const core =
      FRAMING + '\n\n' +
      (indexBody ? indexBody + '\n\n' : '') +
      `## Available reference pages\n` +
      `Call the read_wiki_page tool with one of these page names to load its full text only when you need it:\n` +
      listing;

    console.log(
      `[wiki-context] loaded ${files.length} pages from ${dir} ` +
      `(full ~${full.length} chars, core ~${core.length} chars, ${names.length} fetchable)`
    );
    return { full, core, pages, names, toc };
  } catch (err) {
    console.warn(`[wiki-context] could not load wiki from ${dir}: ${err.message} — wiki disabled`);
    return null;
  }
}

// Loaded ONCE at require time; byte-stable for the process lifetime.
const WIKI = loadWiki(WIKI_DIR);

/** True unless the caller passes a platform that is explicitly NOT ServiceNow. */
function isServiceNow(platform) {
  return platform == null || platform === 'servicenow';
}

/** Is the wiki available for this platform context? */
function wikiAvailable(platform) {
  return !!WIKI && isServiceNow(platform);
}

// ── FULL mode ─────────────────────────────────────────────────────────────────

/** The full-wiki ephemeral-cached system block, or null. */
function getWikiBlock() {
  return WIKI ? { type: 'text', text: WIKI.full, cache_control: { type: 'ephemeral' } } : null;
}

/**
 * Prepend the FULL wiki block to a `system` value (string | array | undefined).
 * Platform-aware: returns the input unchanged when no wiki is loaded OR the
 * platform is explicitly non-ServiceNow (the graceful no-op).
 */
function withWiki(system, platform) {
  if (!wikiAvailable(platform)) return system;
  const block = getWikiBlock();
  if (system == null) return [block];
  if (typeof system === 'string') return [block, { type: 'text', text: system }];
  if (Array.isArray(system)) return [block, ...system];
  return [block, system];
}

// ── CORE + on-demand mode (hybrid) ──────────────────────────────────────────────

/** The small core block (framing + index + page list), ephemeral-cached, or null. */
function getWikiCoreBlock() {
  return WIKI ? { type: 'text', text: WIKI.core, cache_control: { type: 'ephemeral' } } : null;
}

/**
 * Prepend the CORE block to a `system` value. Platform-aware no-op, same as
 * withWiki. Use this on call sites that ALSO register the read_wiki_page tool
 * and can answer it inline (i.e. the ingest extraction loop).
 */
function withWikiCore(system, platform) {
  if (!wikiAvailable(platform)) return system;
  const block = getWikiCoreBlock();
  if (system == null) return [block];
  if (typeof system === 'string') return [block, { type: 'text', text: system }];
  if (Array.isArray(system)) return [block, ...system];
  return [block, system];
}

/** Names of the fetchable wiki pages (for the read_wiki_page tool enum). */
function getWikiPageNames() {
  return WIKI ? WIKI.names.slice() : [];
}

/**
 * The read_wiki_page tool definition, or null when no wiki is loaded. Mirrors the
 * get_existing_entity lookup tool: it is answered inline in the agentic loop and
 * its result is NOT a staged extraction.
 */
function getWikiTool() {
  if (!WIKI || WIKI.names.length === 0) return null;
  return {
    name: 'read_wiki_page',
    description: [
      'Load the FULL text of one ServiceNow design reference page from the wiki listed in the',
      'system prompt. Call this only when you need that page\'s detail to design correctly — the',
      'page list (with one-line summaries) is already in the system prompt. Returns the page body.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        page: { type: 'string', enum: WIKI.names, description: 'The exact page name from the Available reference pages list.' },
      },
      required: ['page'],
    },
  };
}

/** Return a wiki page's full body by name, or a not-found message. */
function readWikiPage(name) {
  if (!WIKI) return 'The reference wiki is not available.';
  const body = WIKI.pages[name];
  if (body == null) {
    console.warn(`[wiki-context] read_wiki_page miss: "${name}"`);
    return `No wiki page named "${name}". Available pages: ${WIKI.names.join(', ')}.`;
  }
  console.log(`[wiki-context] read_wiki_page → "${name}" (${body.length} chars)`);
  return body;
}

module.exports = {
  // full mode
  getWikiBlock,
  withWiki,
  // hybrid mode
  withWikiCore,
  getWikiPageNames,
  getWikiTool,
  readWikiPage,
  // helpers
  wikiAvailable,
};
