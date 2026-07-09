# Feature Testing Guide

One running log of shipped features: what each one does, and exactly how to start testing it in the Workbench. Newest entries at the top. Each entry includes the backlog number when one applies (see `BACKLOG.md` for full technical detail).

---

## Requirements-driven discovery planner — now scoped to one document (Backlog #106, redesigned #108)

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

## ServiceNow Sync — cost/time estimate, live progress, cancel (Backlog #105)

**What it does:** Before a Preview or a real Sync runs, the Workbench now shows how many records will be touched, roughly how long it will take, and what it will cost in AI spend — and requires a confirm click before anything actually runs. While it's running, a progress bar tracks each stage, and a Cancel button is available the whole time.

**How to start testing:**
1. Go to **ServiceNow Sync** in the left menu.
2. Click **Preview sync (dry run)** or **Run sync** as usual.
3. An estimate panel appears first — records / time / cost — with a **Proceed** button.
4. Confirm to start; watch the progress bar move through stages.
5. Click **Cancel** partway through to confirm the stop takes effect cleanly (whatever already completed is kept; the rest re-surfaces next sync).
