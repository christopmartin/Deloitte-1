# ServiceNow ↔ Workbench Integration — Goal, Reality, and Gaps

_Assessment date: 2026-07-14 (updated from 2026-07-09). Reflects the current state of the code and backlog, not aspiration._

---

## 1. The Goal

Most ServiceNow apps of any age are **brownfield**: built up over years, only partly documented, with the real design living inside the platform itself rather than in any design document. The goal of this integration is to close that gap in both directions:

1. **Pull a live ServiceNow app into the Workbench** — read its real configuration (catalog items, forms, data tables, integrations, business rules, and — for newer AI-enabled apps — the AI agents, tools, and use cases) and turn it into a readable, editable design.
2. **Let a person improve that design in the Workbench** — add a workflow, extend a catalog item, define a new AI agent, tighten a requirement — using the Workbench's review and approval process rather than editing ServiceNow directly.
3. **Push those edits back out** as a deployment package that a supervised process (today, a Claude Code session with ServiceNow SDK access) applies to a **development** instance of ServiceNow — never production.
4. **Re-sync afterward** so the Workbench and ServiceNow stay in agreement going forward, instead of drifting apart the moment either side changes something.

If this works end-to-end, an app that today exists only as scattered configuration inside ServiceNow gets a real, maintained design record — and that design record becomes the input the team actually edits from, with ServiceNow as the deployment target rather than the source of truth.

---

## 2. Why This Is Genuinely Hard

This isn't hard because of one bug to fix — it's hard because of the nature of the problem:

- **Scale and variety.** A single ServiceNow app can span tens of thousands of records across dozens of very different record types — a catalog item and a business rule have almost nothing in common structurally. There is no one universal way to "read" ServiceNow.
- **Two representations of the same thing.** ServiceNow stores an app as raw configuration fields. The Workbench represents the same app as a readable design (goals, workflows, narrative). Keeping those two representations honestly in agreement — without quietly losing information in either direction — is the core technical risk, not a side detail.
- **Both sides can change at once.** Someone can edit a record directly in ServiceNow while someone else is editing the same thing in the Workbench. The system has to notice that correctly, every time, without false alarms and without silently picking a winner.
- **Reading is safe; writing is not.** Pulling data out of ServiceNow can't break anything. Pushing a change into ServiceNow can — a bad write can break a live app. That asymmetry is why nothing in this system writes to ServiceNow automatically today; it produces a reviewable package for a supervised deploy step instead.
- **Cost and speed at real scale.** Early testing showed that naively asking AI to interpret every single record does not scale — a full large ServiceNow app was projected at roughly 65 hours and $1,200 in AI cost to import. That specific problem has largely been solved (details below), but it's a good example of the kind of wall this project keeps running into: what works on a small test app doesn't automatically work at real volume.
- **It has not been proven end-to-end.** Everything below has been built and tested piece by piece. The full loop — pull from a live app, edit, generate a deployment package, hand it to Claude Code, watch it actually deploy to a real ServiceNow dev instance, and confirm it landed correctly — has **not yet been run for real.** That is the single biggest open question, and it should be treated as unproven until it is.

---

## 3. What Works Today: ServiceNow → Workbench

This is the more mature half. Concretely, today the system can:

- **Connect to a live ServiceNow instance** and read a chosen slice of it — not necessarily the whole app — so a first import can be scoped down rather than all-or-nothing.
- **Check the connection before doing any real work.** A bad username, password, or unreachable instance is caught up front, both when saving the connection and before a sync starts — it used to fail silently.
- **Read most record types without any AI at all.** For anything that's essentially a structured record — catalog items, data tables, forms, integrations, and (as of this month) business rules and scripts — the system copies the real ServiceNow values directly into the design. This is faster, cheaper, and more faithful than describing them in AI-generated prose, because it's the actual data, not someone's summary of it.
- **Reserve AI for the few things that genuinely need interpretation** — AI agents, AI use cases, and AI tools, where the point is understanding intent (what is this agent for, what should it decide), not copying fields. That's a small fraction of a typical app's records.
- **See beyond the records an app owns, into the shared ServiceNow "backbone."** As of 2026-07-10, the discovery planner can follow a catalog item into its fulfillment chain (request → task) and resolve the routing groups those tasks reference — automatically, at no extra cost, because these are common and predictable. For anything else shared and platform-wide, a person can opt in to a separate, capped, clearly-labeled "look beyond the app" pass rather than that happening by default. This closes a real gap found in live use (a work-routing table the import simply couldn't see), while keeping normal imports exactly as fast and predictable as before.
- **Detect what changed, on either side, without guessing.** Whether a record changed in ServiceNow, changed in the Workbench, or both, is determined by comparing real signals (ServiceNow's own change counters, stored snapshots) — not by asking AI whether something looks different. If both sides changed the same thing, the system stops and asks a person rather than silently choosing.
- **Give a cost and time estimate before running anything real**, show live progress while it runs, and allow it to be canceled mid-run without losing the work already completed or corrupting the in-progress state.
- **Bring every incoming change through a human review step** ("change packets") rather than writing straight into the design — nothing lands silently.
- **Catch it when a brand-new requirement someone is typing already exists in ServiceNow.** As of 2026-07-13, for connected projects, a new requirement is checked against a live instance for a duplicate or close overlap before it can be promoted — cheaply (a handful of small lookups; AI is only used on an actual candidate match). A real hit blocks promotion the same way a design conflict does, so the same requirement can't be built twice. This only catches duplicate/overlapping *requirements* — it does not yet check whether ServiceNow data newly pulled *into* the design contradicts what's already there (see gap table below).

**Honest caveat on AI narration:** for business rules and scripts specifically, the system by default records *what the rule is* (name, type, the real script) without an AI-written explanation of *what it does* — that explanation is available on request, one rule at a time, rather than generated automatically for every rule on import. This was a deliberate call to control cost, not a limitation discovered by accident.

---

## 4. What Works Today: Workbench → ServiceNow

This half exists and has been designed carefully, but is thinner and less proven:

- **A generated deployment package.** When a design is ready, the system produces a Markdown document listing everything to deploy — in the correct order, with an explicit step-by-step checklist (authenticate first, deploy data tables before anything that depends on them, register results afterward) and explicit guardrails written into the document itself (never target production, never guess at credentials, don't invent workarounds if something's missing — ask a person).
- **A way to close the loop after a deploy.** Once something is actually created in ServiceNow, its new ServiceNow ID can be registered back onto the Workbench record, so the *next* import recognizes it as the same thing instead of creating a duplicate.
- **This is a document handoff, not a push-button deploy.** Today, nothing in the Workbench calls ServiceNow directly to make a change. It hands a document to a supervised process — currently, a Claude Code session with ServiceNow's own developer tooling — which does the actual deploying. Whether that should ever become an automatic, one-click deploy from inside the Workbench is an open decision, not yet made either way.

---

## 5. Where It Falls Short Today

| Gap | In plain terms | Status |
|---|---|---|
| **Never tested live, end-to-end** | The deployment package has been designed and reviewed carefully, but no one has yet handed a real one to Claude Code and watched it successfully deploy to a real ServiceNow development instance. | Open — the top risk |
| **Business-rule scripts may not survive the round trip** | If a business rule is edited from its Workbench record and then redeployed, the actual rule code may not make it into the deployment package for that specific path — it can get dropped. There's a separate, always-reliable path that does carry raw data faithfully, but the two aren't yet unified for this record type. | Flagged as a decision to make, not yet decided whether it's actually needed |
| **No system-enforced "never touch production" rule** | The instruction not to deploy to production exists as text inside the generated document. Nothing in the system currently blocks a production target technically. | Open |
| **Comparing "what changed" isn't equally precise for every record type** | For simple, structured records, the system can tell exactly which individual field changed on which side. For richer, more heavily-redesigned records (business logic, workflows, AI agents), it's conservative rather than surgical: if both sides changed, it correctly stops and asks a person, but it can't yet always say precisely which piece changed where. | Known limitation, safe by design (asks rather than guesses), not yet closed |
| **New ServiceNow data can enter the design without being checked against the requirement that pulled it in, or against what's already there** | Today, when ServiceNow data with no prior link comes in — through the new AI-assisted planner or a plain import — it's treated as automatically safe to add and goes straight into the design, without an AI check for whether it actually makes sense next to the requirement or contradicts existing design intent. This was a known lower-priority edge case; it now matters more because pulling in ServiceNow data off the back of a requirement is becoming a routine, everyday action, not a rare one. **This is flagged as a decision to make, not yet decided how to build it** — a live self-assessment on 2026-07-13 traced the gap in detail (`docs/reviews/2026-07-13-conflict-detection-assessment.md`). A related but narrower gap closed the same day: a brand-new *requirement* is now checked for a live duplicate in ServiceNow before it can be promoted (see above) — that catches duplicate asks, not a data contradiction once the import proceeds. | Open — flagged 2026-07-13 as the top conflict-detection gap, decision pending |
| **Only tested at modest scale so far** | The performance and cost fixes were validated against a real but modest test app. The behavior against a true large-scale global app hasn't been separately confirmed. | Partially validated |
| **Credential handling has a fallback that isn't ideal** | If a specific security setting isn't configured, ServiceNow passwords fall back to being stored in a weaker form rather than properly encrypted. It's a known, flagged setting to fix, not a silent risk. | Open, low effort to close |

---

## 6. Honest Bottom Line

The **read direction** — bringing a live ServiceNow app into the Workbench as a real, editable design — remains in solid shape and got measurably better this week: it now reaches the shared ServiceNow "backbone" tables an app doesn't own (not just what's inside the app itself), and it now catches a brand-new requirement that duplicates something already live in ServiceNow before it can be promoted. It still has real fidelity (actual data, not AI paraphrase, for most record types), is fast and inexpensive for the bulk of records, and gives visibility and control (estimate, progress, cancel) before it spends anything.

One real gap surfaced by a self-review this week, though: once ServiceNow data is actually being pulled into a design, nothing yet checks whether that data contradicts the requirement driving it, or the design already in place — it's treated as automatically safe to add. This is a decision to make (how to check this without slowing down every import), not yet a decided or built fix, and it should be treated as an open item rather than assumed covered by the new duplicate check above.

The **write-back direction** — generating a deployment package and having it applied to a real ServiceNow environment — is designed thoughtfully but **unproven**. It has never been run against a live instance from end to end. Until that happens once, successfully, the "nirvana vision" of edit-in-Workbench → deploy-to-ServiceNow should be treated as a well-designed hypothesis, not a working capability.

The most responsible next step, before trusting this with anything real, is a single live test: take one small, low-stakes edit, generate the deployment package, and actually walk it through a real ServiceNow development instance to see what breaks.
