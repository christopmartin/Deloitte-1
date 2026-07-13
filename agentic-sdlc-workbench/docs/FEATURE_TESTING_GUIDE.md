# Feature Testing Guide

One running log of shipped features: what each one does, and exactly how to start testing it in the Workbench. Newest entries at the top. Each entry includes the ship date and the backlog number when one applies (see `BACKLOG.md` for full technical detail).

---

## Admin: Data Maintenance — reset an application's design data — 2026-07-13

**What it does:** A new Administration page lets you clear out one application's design data (use cases, workflows, requirements, everything else generated from ingest) so it can be re-ingested from scratch — without deleting the application itself or its setup. By default, it also keeps your uploaded Document Catalog entries and resets them so you can resubmit them into the fresh design without re-uploading files (there's a checkbox if you'd rather delete those too). Every delete shows an exact row-count preview first, and requires typing the application's name to confirm — this cannot be undone.

While building this, we also found and fixed a gap in the existing wipe logic: 15 categories of ServiceNow-derived design data (business rules, user groups, choice sets, service portals, workspaces, variable sets, inbound REST APIs, dashboards, reports, KPIs, SLAs, email notifications, natural-language rules, ServiceNow discovery plans, and outbound integrations) had never been included in any wipe, on any application, to date. Any wipe run going forward — from this page or the existing command-line tool — now clears all of it.

**How to start testing:**
1. Go to **Administration ▸ Data Maintenance**.
2. Pick an application with existing design data, leave **"Keep Document Catalog entries"** checked, and click **Preview what will be deleted** — confirm the row counts look right and the message says documents will be kept.
3. Click **Delete Design Data…**, type the application's exact name in the confirmation box, and confirm.
4. Check other tabs (Use Cases, Workflows, Requirements) — design data should be gone. Check **Ingest Documents** — your documents should still be listed, ready to resubmit.
5. Repeat on a different application with the checkbox unchecked — confirm the documents are deleted too this time.

---

## ServiceNow duplicate check on new requirements (Backlog #114) — 2026-07-13

**What it does:** For projects connected to a ServiceNow instance, whenever a new requirement is staged from a document, the app now does a quick, free check of the live instance to see if something already covers it — before you (or the AI) design something ServiceNow already has. Most of the time nothing is found and nothing happens — no cost, no delay. Only when a real possible match turns up does it spend a small amount on the cheapest AI model to double-check and explain why. If it's confident enough, it raises a real, blocking question — the **same weight as a requirement conflict** — right alongside your other clarifying questions. It must be resolved before that document can be promoted.

**How to start testing:**
1. Make sure the Application you're testing has a ServiceNow connection configured (Application settings — instance, user, password).
2. Go to **Ingest Documents** and submit a requirement that closely describes something you know already exists in that ServiceNow instance (e.g. an existing catalog item, Now Assist agent/tool, or flow) — the closer the wording, the more likely it triggers.
3. After extraction completes, look at **Clarifying Questions** — a genuine match shows a **🔁 Possible ServiceNow Duplicate** card (same red styling as a conflict), naming the ServiceNow record and why it looks related.
4. Confirm the **Promote now** button is greyed out while that question is open, and that clicking **Promote** is blocked until you answer it.
5. Type an answer (e.g. confirm it's the same, or explain why it's genuinely different) and submit — the block clears and promote becomes available again (assuming no other open questions).
6. To confirm it stays out of your way otherwise: submit an unrelated requirement — no question should appear, and nothing in **Admin ▸ AI Settings ▸ Usage** should show spend for the new "ServiceNow overlap check" role on that document.

---

## Housekeeping: security patch, automated tests, automated backups (Backlog #90–#93) — 2026-07-13

**What it does:** No visible change to the app itself — this is upkeep behind the scenes, closing five gaps flagged in the tech-debt reviews:
1. **Security patch.** Closed a known file-upload security vulnerability and a related one in a supporting library. Both were already fixed in newer library versions — this just picks those up.
2. **Dead code removed.** Deleted an abandoned, never-used backup backend scaffold (Python) that predated today's actual backend and was only still confusing the documentation.
3. **Automated test suite.** All 30 existing test scripts now run as one command instead of one at a time by hand — this is the safety net that catches a broken change before it ships.
4. **Automated database backups.** The backup script now runs on its own every day at 9:00 AM via Windows Task Scheduler, instead of relying on someone remembering to run it manually (the last backup had gone stale for over 5 weeks).
5. **Environment variable reference.** Added a checked-in list of every configuration setting the app reads (API keys, ServiceNow connection, tuning knobs) with a one-line explanation of each — no real credentials in it — so setting up the app on a new machine doesn't require reverse-engineering the code.

**How to confirm it worked:**
1. Open a command prompt in `backend-node/` and run `npm audit` — should report **0 vulnerabilities**.
2. Run `npm test` — should run all 30 suites and end with **"All 30 test suites passed."**
3. Open Windows Task Scheduler and look for **"ASDLC Workbench DB Backup"** — should show as `Ready`, next run tomorrow 9:00 AM; `backend-node/backups/` should contain a file timestamped today.
4. Confirm `agentic-sdlc-workbench/backend/` no longer exists, and `backend-node/.env.example` does.

---

## 3-way extraction classification: Extracted / AI Suggestion / Best-Practice Match (Backlog #110) — 2026-07-10

**What it does:** Every staged extraction is now labeled one of three ways instead of one confidence number doing double duty:
1. **Extracted** — a normal reading of the document. No badge — this stays the quiet default.
2. **AI Suggestion** — the AI added this on its own judgment; nothing in your rule list backs it.
3. **Best-Practice Match** — the AI added this AND it traces to one specific, currently-active rule in Admin ▸ AI Guidance. This is a verified link — the system checks the AI's claim against your real, live rule list before trusting it, so it can never be faked or hallucinated into looking more authoritative than it is.

The confidence percentage on each row now means the right thing for that row — how clearly the document stated it (Extracted), or how confident the AI is in its own idea (the other two) — with a hover tooltip spelling out which.

**How to start testing:**
1. Go to **Ingest Documents**, open a document with staged extractions that include an AI-invented item (enrichment level "Balanced" or "Suggestive" on upload), and look at the **Staged Extractions** table — an invented item now shows an **AI Suggestion** or **Best-Practice Match** tag next to its entity-type badge.
2. Hover the confidence percentage on a few different rows — the tooltip explains what that specific number means for that row.
3. Expand a Best-Practice Match row (click it) — the detail grid shows **Best Practice Title**, naming the exact house rule that justified the addition.
4. Scroll to the **Design Quality Check** panel (above the promote button) — each "Needs review"/"FYI" finding for an AI-invented agent/workflow/tool now names its category and, for a match, the rule, right in the finding text.
5. To see a Best-Practice Match happen naturally rather than seeded: add a new rule in **Admin ▸ AI Guidance** that clearly covers a gap in one of your documents, then re-run extraction on that document.

---

## Reach shared ServiceNow tables + best-practice guidance (Backlog #109) — 2026-07-10

**What it does:** Closes a real gap — until now, the import planner could only see tables an app *owns*; it had no way to reach shared ServiceNow tables like the standard work-ticket tables or routing groups, even when a requirement clearly needed them. Three changes:
1. **Automatic reach for common cases.** If a catalog item is in scope, its fulfillment work records (Requested Item, Catalog Tasks) and their routing group now come along automatically — no extra step.
2. **"Not enough?" escalation.** A new button lets AI consider *any* ServiceNow table from its own knowledge, not just what it found in your instance. This is capped and clearly labeled — a small, most-recent sample, never a full import — so it can't accidentally overload the system. It's a separate, deliberate click; it never turns on by itself.
3. **Best-practice guidance now actually informs the plan** (previously it was wired to see none of your house rules for this step). Two new draft guidance rules were added — covering exactly the "which table for this?" question that surfaced the gap — marked **[DRAFT — pending approval]** in Admin ▸ AI Guidance for your review before they're trusted as-is.

**How to start testing:**
1. Go to **Admin ▸ AI Guidance** and confirm you see two new rules starting with `[DRAFT — pending approval]` — review and edit the wording to your liking (they work either way, this is just making sure your team's phrasing is on them before relying on them).
2. Go to **Ingest Documents**, open a document with a catalog-item-related requirement, and click **Generate ServiceNow import plan** as usual — if the ServiceNow app has a real catalog item, its request/task records show up automatically in the plan.
3. Click **Not enough? Let AI consider any ServiceNow table** to see the escalation — any table it proposes this way carries a distinct **⚠ platform-wide — capped sample (most recent)** tag so it's never confused with a normal, fully-scoped table.
4. Approve the plan as usual, then go to **ServiceNow Sync** — the cost/time estimate now calls out any platform-wide table separately, with a note that it's a capped sample, not a complete import.

---

## Requirements-driven discovery planner — now scoped to one document (Backlog #106, redesigned #108) — 2026-07-09

**What it does:** Instead of manually ticking which ServiceNow tables to import, AI reads ONE Ingest Document's own requirements (before they're promoted) plus the real inventory of the connected ServiceNow scope, and proposes a focused list of tables to import — including supporting/related tables — each with a plain-language reason tied to a specific requirement in that document. If the AI is genuinely unsure about something, it asks you directly as a real question, right there with your other clarifying questions — not a passive note. Nothing imports until you review and approve. You never have to visit the Assessment page yourself — if the app hasn't been surveyed yet, that happens automatically the first time you generate a plan.

**How to start testing:**
1. Go to **Ingest Documents**, upload or type in some requirements, and let extraction run until the document reaches **"Ready to Promote"** (or is still on **"Needs Answers"** — the plan section shows up either way, as soon as any requirement has been extracted).
2. Open that document and scroll to the **"ServiceNow Import Plan"** section.
3. Click **Generate ServiceNow import plan**. The first time for a given app, this also runs the ServiceNow scan automatically — expect it to take a little longer than a regenerate.
4. Review the proposal — tables, a direct/related badge, requirement tags, rationale, and a collapsible list of excluded tables with reasons.
5. If the AI raised a **"ServiceNow Plan Questions"** section below, answer it and click **Regenerate plan** — answering there never re-runs the document's own extraction.
6. Click **Approve & save plan**, then follow the link to **ServiceNow Sync** to see the cost/time estimate (below) before actually importing.
7. (Advanced users only) The ServiceNow Assessment page still has the manual "Scan instance" button and the checkbox grid, for re-scanning or hand-picking surfaces directly — a short note there points back to Ingest Documents for the AI-driven path.

---

## ServiceNow Sync — cost/time estimate, live progress, cancel (Backlog #105) — 2026-07-08

**What it does:** Before a Preview or a real Sync runs, the Workbench now shows how many records will be touched, roughly how long it will take, and what it will cost in AI spend — and requires a confirm click before anything actually runs. While it's running, a progress bar tracks each stage, and a Cancel button is available the whole time.

**How to start testing:**
1. Go to **ServiceNow Sync** in the left menu.
2. Click **Preview sync (dry run)** or **Run sync** as usual.
3. An estimate panel appears first — records / time / cost — with a **Proceed** button.
4. Confirm to start; watch the progress bar move through stages.
5. Click **Cancel** partway through to confirm the stop takes effect cleanly (whatever already completed is kept; the rest re-surfaces next sync).
