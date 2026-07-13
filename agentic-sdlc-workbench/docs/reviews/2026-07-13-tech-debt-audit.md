# Agentic SDLC Workbench — Tech Debt Audit (Week-2 Check-in)

**Date:** 2026-07-13 · **Scope:** delta since the 2026-07-06 audit. **Method:** verified each Phase 0 item from that audit against the current repo state (file checks, `package.json`, `npm audit` targets, backup folder, git log), then assessed the 15 feature commits landed since (`sn-discovery-planner.js`, `sn-capability-sync.js`, `sn-instance-catalog.js`, `sn-assess.js`, and the "reach shared platform tables" change) for new debt. A full first-principles re-audit was not repeated — [2026-07-06-tech-debt-audit.md](2026-07-06-tech-debt-audit.md) remains the reference document; this is a status check plus new findings only.

---

## 1. Executive summary

Last week's audit named two cheap, urgent fixes — patch a known security vulnerability in the file-upload library, and wire the 20 existing test files into one runnable suite — plus a phased plan for everything else. **One week later, neither has been done.** In that same week, real product work shipped: five new ServiceNow modules (discovery planning, capability sync, instance cataloging, assessment, capture — roughly 2,100 lines) and the "reach shared platform tables" capability. Nothing has broken. But the safety net that was supposed to go in *before* more code piled up is now further behind, not closer.

**Two numbers worth knowing:**
- The application's main file — the one that handles almost every request — grew from about 8,000 lines to just over 11,000 in a single week (+38%). It's still not tangled (no circular dependencies), so it's not an emergency, but it is growing faster than it's being trimmed.
- The last database backup on disk is now over five weeks old. A week ago it was "about a month" — the gap is widening.

**Nothing new is unsafe.** The new ServiceNow modules follow the same patterns as the rest of the codebase. One of them (capability sync) has no automated test at all, which is the one new item this pass adds to the backlog.

## 2. Status check against last week's "do this week" list

| Item | Status |
|---|---|
| Patch file-upload library security vulnerability (1-line version bump) | **Not done** |
| Remove the dead second backend + fix the README | **Not done** |
| Wire 20 existing test files into `npm test` | **Not done** |
| Schedule automated database backups | **Not done** — newest backup is now 5+ weeks old |
| Add a `.env.example` template | **Not done** |
| CI/CD pipeline | **Not started** (expected — it depends on the test-wiring item above) |

None of this is a crisis by itself. The concern is sequencing: every one of these was scored as cheap and high-value specifically *because* it makes the next round of feature work safer. Each week it's deferred, more code ships without that safety net underneath it.

## 3. What's new this week

**Five new ServiceNow modules, one gap:** `sn-discovery-planner.js`, `sn-instance-catalog.js`, and `sn-assess.js` all have existing test coverage. `sn-capability-sync.js` (243 lines, handles syncing platform capability data) has none — logged below as a new backlog item.

**Monolith growth rate:** the main server file grew ~38% in a week (202 routes now, up from roughly 190). Last week's audit correctly ranked splitting it as low-urgency because nothing is tangled — that's still true. But growing this fast means the eventual split gets more expensive the longer it's deferred, not cheaper.

**Backup staleness:** confirmed via the backups folder — nothing has run since early June. This was already flagged; it's now materially worse.

Everything else checked (CI/CD, dependency versions, dead backend, documentation) is unchanged from last week's findings.

## 4. Updated priorities

Last week's phased plan (Phase 0–3) stands unchanged in content. What's changed is urgency, not substance:

| Cluster | Priority score | Change from last week |
|---|---|---|
| Security patch (multer/qs) | 35 | Unchanged, still overdue |
| Test suite wiring | 30 | Unchanged, still overdue — now blocking CI/CD for a second week |
| Automated DB backups | 24 | **Risk factor should move up** — the exposure window (time since last good backup) has grown by 5 weeks |
| CI/CD pipeline | 24 | Unchanged, correctly still waiting on test-wiring |
| Dead backend + stale README | 20 | Unchanged |
| **New: `sn-capability-sync.js` has no test coverage** | 3 (impact) / 2 (risk) / 1 (effort) → **20** | New this pass |
| Monolith split (server.js) | 5 | Unchanged in formula, but flagging the growth rate as a trend to watch |

## 5. Recommendation

Nothing here demands an emergency stop to feature work. But the Phase 0 list from last week is five small, independent, well-scoped fixes that together take under a day — and every week they wait, the pile they're meant to protect gets bigger. Worth explicitly deciding whether to slot a day for them now, or consciously accept the growing gap and revisit at the next check-in.

## Appendix — new backlog item

Logged in `BACKLOG.md` as **#111**: no automated test coverage for `sn-capability-sync.js`.
