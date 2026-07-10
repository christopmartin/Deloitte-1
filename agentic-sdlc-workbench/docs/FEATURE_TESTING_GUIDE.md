# Feature Testing Guide

One running log of shipped features: what each one does, and exactly how to start testing it in the Workbench. Newest entries at the top. Each entry includes the ship date and the backlog number when one applies (see `BACKLOG.md` for full technical detail).

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
