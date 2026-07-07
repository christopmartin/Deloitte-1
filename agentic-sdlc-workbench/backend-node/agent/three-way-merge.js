// agent/three-way-merge.js
// ─────────────────────────────────────────────────────────────────────────────
// R7 — deterministic per-field 3-way classification for the ServiceNow round-trip.
//
// Compares three states of a record, field by field, WITHOUT any AI:
//   base       — the last-synced ServiceNow snapshot (source_fluent / payload, #85)
//   wbCurrent  — the current Workbench copy of the record
//   snCurrent  — the fresh ServiceNow capture
//
// Each field is bucketed:
//   unchanged     — neither side moved from the base
//   sn_only       — ServiceNow moved, the Workbench did not          → safe to apply
//   wb_only       — the Workbench moved, ServiceNow did not          → keep WB (never refill)
//   both_changed  — both sides moved to DIFFERENT values             → human conflict
//
// SOUNDNESS / SCOPE. A clean 3-way needs all three states in the SAME field space.
// That holds for GENERIC artifacts (asdlc_sn_artifact) — their Workbench payload IS the
// ServiceNow field payload — and for the SN-SIDE delta of any record (base salient vs
// current salient are both ServiceNow-shaped). It does NOT hold for a rich Tier-A record's
// canonical row (Workbench-design field names) against the ServiceNow-shaped base; for those
// use snFieldDelta() to learn WHICH ServiceNow fields moved and feed that to the reconciler.
// When the base is absent or cannot be field-decomposed, classifyFields returns
// available:false so the caller falls back to the coarse record-level both-side floor —
// never a silent wrong merge.
'use strict';

/** Canonical string form for equality: trims strings, stable-stringifies objects, '' for empty. */
function normVal(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
}
function eq(a, b) { return normVal(a) === normVal(b); }
function isEmpty(v) { return normVal(v) === ''; }

/**
 * Parse a stored base snapshot into a field map. Accepts an object, a JSON string
 * (JSON-of-salient — the non-logic form), or a raw script body (the logic form → one
 * whole-body logical field). Returns { fields, form } where form ∈ 'json'|'body'|'empty'
 * and fields is null when there is nothing to compare.
 */
function parseBase(base, opts = {}) {
  const bodyField = opts.bodyField || 'script';
  if (base === undefined || base === null || base === '') return { fields: null, form: 'empty' };
  if (typeof base === 'object') return { fields: base, form: 'json' };
  if (typeof base === 'string') {
    const t = base.trim();
    if (t.startsWith('{')) {
      try { const o = JSON.parse(t); if (o && typeof o === 'object' && !Array.isArray(o)) return { fields: o, form: 'json' }; }
      catch { /* not JSON — fall through to body */ }
    }
    return { fields: { [bodyField]: base }, form: 'body' };   // raw script body: single logical field
  }
  return { fields: null, form: 'empty' };
}

/** Coerce a possibly-string payload into a plain field object ({} when not decomposable). */
function asFields(v) {
  if (v && typeof v === 'object') return v;
  if (typeof v === 'string') { const t = v.trim(); if (t.startsWith('{')) { try { const o = JSON.parse(t); if (o && typeof o === 'object' && !Array.isArray(o)) return o; } catch { /* ignore */ } } }
  return {};
}

/**
 * Full per-field 3-way classification (base vs wbCurrent vs snCurrent). All three must be in
 * the same field space (see module header). Returns
 *   { available, form, fields: { <field>: { kind, base, wb, sn } }, summary }
 * available:false (with a reason) when the base cannot be field-decomposed — the caller then
 * uses the record-level floor instead.
 */
function classifyFields(base, wbCurrent, snCurrent, opts = {}) {
  const { fields: baseFields, form } = parseBase(base, opts);
  if (!baseFields) return { available: false, form, reason: 'no base snapshot to compare', fields: {}, summary: summarize(null) };
  const bodyField = opts.bodyField || 'script';
  const wb = form === 'body' ? asFields(typeof wbCurrent === 'string' ? { [bodyField]: wbCurrent } : wbCurrent) : asFields(wbCurrent);
  const sn = form === 'body' ? asFields(typeof snCurrent === 'string' ? { [bodyField]: snCurrent } : snCurrent) : asFields(snCurrent);

  const keys = new Set();
  if (form === 'body') { keys.add(bodyField); }
  else { for (const k of Object.keys(baseFields)) keys.add(k); for (const k of Object.keys(sn)) keys.add(k); for (const k of Object.keys(wb)) keys.add(k); }

  const fields = {};
  for (const k of keys) {
    const b = baseFields[k], w = wb[k], s = sn[k];
    const snChanged = !eq(s, b);
    const wbChanged = !eq(w, b);
    let kind;
    if (!snChanged && !wbChanged) kind = 'unchanged';
    else if (snChanged && !wbChanged) kind = 'sn_only';
    else if (!snChanged && wbChanged) kind = 'wb_only';
    else kind = eq(w, s) ? 'unchanged' : 'both_changed';   // both moved to the SAME value → agree
    fields[k] = { kind, base: b ?? null, wb: w ?? null, sn: s ?? null };
  }
  return { available: true, form, fields, summary: summarize(fields) };
}

/**
 * Merge the SAFE part of a 3-way onto the current Workbench payload: apply every `sn_only`
 * field, keep `wb_only` and `unchanged` fields verbatim (a Workbench-cleared field is
 * `wb_only` and is therefore NEVER refilled — the fill_blank-resurrection fix, per field).
 * Only meaningful when summary.both_changed === 0. Returns a new field object.
 */
function mergeSafe(wbCurrent, fc) {
  const out = { ...asFields(wbCurrent) };
  if (!fc || !fc.available) return out;
  for (const [k, f] of Object.entries(fc.fields)) {
    if (f.kind === 'sn_only') { if (f.sn === null || f.sn === undefined) delete out[k]; else out[k] = f.sn; }
  }
  return out;
}

/**
 * SN-SIDE field delta (2-way): which ServiceNow fields moved between the last-synced base and
 * the current capture. Both are ServiceNow-shaped, so this is always sound (even for rich
 * Tier-A records). Returns { available, form, changed: [field...], changed_detail: [{field,
 * base, current}] }. available:false when there is no parseable base.
 */
function snFieldDelta(base, snCurrent, opts = {}) {
  const { fields: baseFields, form } = parseBase(base, opts);
  if (!baseFields) return { available: false, form, changed: [], changed_detail: [] };
  const bodyField = opts.bodyField || 'script';
  const cur = form === 'body' ? { [bodyField]: (typeof snCurrent === 'string' ? snCurrent : (asFields(snCurrent)[bodyField])) } : asFields(snCurrent);
  const keys = new Set([...Object.keys(baseFields), ...Object.keys(cur)]);
  const changed = [], changed_detail = [];
  for (const k of keys) {
    if (!eq(cur[k], baseFields[k])) { changed.push(k); changed_detail.push({ field: k, base: baseFields[k] ?? null, current: cur[k] ?? null }); }
  }
  return { available: true, form, changed, changed_detail };
}

function summarize(fields) {
  const s = { unchanged: 0, sn_only: 0, wb_only: 0, both_changed: 0 };
  if (!fields) return { ...s, available: false, has_both_changed: false };
  for (const k of Object.keys(fields)) s[fields[k].kind]++;
  return { ...s, available: true, has_both_changed: s.both_changed > 0 };
}

module.exports = { classifyFields, snFieldDelta, mergeSafe, parseBase, summarize, normVal, isEmpty };
