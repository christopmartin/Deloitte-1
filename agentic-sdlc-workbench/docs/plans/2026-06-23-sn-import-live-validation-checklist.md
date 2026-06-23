# Live-instance validation checklist — SN import P1/P2/P4

> Saved 2026-06-23. Covers what the offline test suite can't prove: real network paging,
> the new wire queries, and the genuine-conflict (Opus) path. Companion to
> `2026-06-23-tier-abc-storage-sn-import-from-scratch.md`.
>
> Code under test (committed on Dev, pushed to origin/Dev):
> - `0bb20f9` plan rewrite · `e00f26a` P1 pagination + P2 catalog variables · `ab6c2a6` P4 pre-flight + tests
>
> What's already proven offline (no need to re-test): pagination logic, catalog-variable
> child capture shape, from-scratch completeness, re-import idempotence, the gate decision
> matrix, the dry-run pre-flight counts. Full suite green (13 test files).

## Where to run it
- **UI:** Administration ▸ **ServiceNow Sync** — use **Preview** (dry-run) then **Run sync**.
- **Driver:** `backend-node/run-live-sync.js` (dry-run by default; `--apply` for real).
- **Known live target (from prior sessions):** MIM project
  `4dd91017-ca33-476c-8898-2c9d723d8147`, scope `sn_major_inc_mgmt`,
  instance `deloitteclient250inovation.service-now.com`, user `christopmartin`
  (password stored in the project row; no .env password needed).
- **Pre-count source:** the read-only instance assessment / fit step (`sn-assess.js`,
  stats API) gives the expected record count per surface — the yardstick for test #1.

## Safety
- Keep **prod read-only**. Tests #1–4 are read-only and safe anywhere.
- Run test #5 (conflict mutation) **only against a dev/test instance**.

---

## 1. Pagination captures everything — the P1 bug (most important)
The whole reason P1 exists; only a live run proves it.

**Cheapest reliable method** — force multi-page paging with a tiny page size:
```
SN_CAPTURE_PAGE_SIZE=100
```
Run a sync (or dry-run) against a real scope, then compare **captured count per surface**
to the **assessment pre-count**.
- ✅ PASS: captured == assessed for every surface, even at page size 100.
- ❌ FAIL/old behavior: a surface caps at 100 (i.e. at the page size) — that's the silent
  truncation P1 fixes.

Also, if a scope has a genuinely large surface (>1,000 columns / business rules / ACLs),
point at it with the **default** page size and confirm you get all of them.

## 2. Catalog variables come across (P2)
Sync a scope that has **catalog items with variables**. Open the generic-artifact view
(or Build Spec / Relationships tab).
- ✅ PASS: each variable appears as a child **under its catalog item**, in the right order.
- ❌ Before P2: catalog variables weren't captured at all.

## 3. New wire queries don't error (P1/P2)
The only changes never tested against real ServiceNow: `^ORDERBYsys_id` added to every
query, and the new `item_option_new` (variables) query. After a sync, inspect the result's
**`errors`** and **`warnings`**.
- ✅ PASS: no new HTTP 400s for any surface; a too-large surface yields a clear
  "capped … import is PARTIAL" warning rather than silence.
- If a surface 400s or returns suspiciously few rows, capture the `errors`/`warnings`
  payload — that's the wire-query risk; send it for a fix.

## 4. Dry-run pre-flight reads true (P4)
Run a **dry-run** and read the new pre-flight line, e.g.:
> "Would import: 12 (3 design, 9 platform artifacts) new; 2 changed; 40 unchanged (skipped).
> Plan: 12 to auto-apply, 2 to review."
- ✅ PASS: counts match expectations for that scope; "to review" equals the conflicts a
  human should see.

## 5. Genuine conflict → review, no overwrite (the Opus path) — dev/test ONLY
The one path the offline stub can't reach (it never produces a real conflict).
1. Take a record you've already synced; in ServiceNow, **change a populated field** to
   something that conflicts with a richer Workbench value.
2. Re-sync.
- ✅ PASS: it lands in a **pending-review** change packet (not auto-applied), and the
  Workbench's richer value is **NOT** overwritten.

---

## If something fails
- #1 mismatch → pagination/ordering issue (paging skip/dupe or premature stop).
- #2/#3 errors → wrong table/column in a capture query (`item_option_new.cat_item`, or the
  `^ORDERBYsys_id` ordering) — fixable once the live error text is known.
- #5 overwrite → escalate immediately; the non-destructive guarantee is the crux invariant.

Knobs: `SN_CAPTURE_PAGE_SIZE` (default 1000), `SN_CAPTURE_MAX_ROWS` (default 50000 — the
safety ceiling that triggers the PARTIAL warning).
