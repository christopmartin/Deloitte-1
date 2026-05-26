# Agentic SDLC Workbench — Regression Test Checklist

> **How to use:** Say **"run regression"** in any session to load and execute this checklist interactively.
> Work through items top-to-bottom against the `dev` branch running locally.
> Mark each item ✅ pass or ❌ fail as you go.
> Estimated time: ~45–60 minutes (full), ~10 min (smoke), ~15 min (Phase 2 only).

---

## Quick presets

| Preset | Items | Use when |
|---|---|---|
| **Smoke** | A1–A4, B1–B3, D1, E1–E2, F1–F3, K1–K2, L1 | After any commit — confirm nothing is on fire |
| **Phase 2** | E + F + G (all) | After any Participants / RASIC / Paths change |
| **Full** | All 128 items | Before merging to `main`; after a phase ships |

---

## A — App Shell & Navigation (8)

| # | What to verify | Pass criteria |
|---|---|---|
| A1 | Server starts | `node server.js` — no crash, port open |
| A2 | Browser loads | No console errors on first load |
| A3 | Sidebar all 14 tabs | Each tab loads without error |
| A4 | Project selector | Dropdown shows all seeded projects; switching changes data |
| A5 | Local storage restore | Reload — same project and module restored |
| A6 | Toast notifications | Trigger any save → toast appears, auto-dismisses |
| A7 | Keyboard Escape | Opens modal → Esc closes it |
| A8 | Overlay click | Click darkened backdrop → modal closes |

---

## B — Design Review: Use Cases (10)

| # | What to verify | Pass criteria |
|---|---|---|
| B1 | Cards render | Each UC shows slug (UC-###), title, status pill |
| B2 | Slug visible | UC-001, UC-002 … shown in header alongside name |
| B3 | All display fields | supervision_model, risk_tier, owner, primary_success_metric, baseline_cost_annual_usd visible on card |
| B4 | Edit modal opens | ✏️ Edit button → modal appears with all 12 fields |
| B5 | All fields editable | title, summary, business_objective, expected_value, success_criteria, constraints_list, supervision_model, risk_tier, owner, primary_success_metric, baseline_cost_annual_usd, readiness |
| B6 | Enum selects correct | supervision_model shows 3 options; risk_tier shows H/M/L |
| B7 | Save creates CP | Save → toast includes "Change Packet CP-###" |
| B8 | No-change save | Save with no edits → toast says "no changes detected" |
| B9 | Child ACs visible | Acceptance criteria linked to this UC appear below |
| B10 | Child breadcrumbs | Workflow and Agent cards breadcrumb back to correct UC |

---

## C — Design Review: User Stories (3)

| # | What to verify | Pass criteria |
|---|---|---|
| C1 | Cards render | All user stories list with title, story_type, sprint |
| C2 | Story type chip | Correct tag colour per type |
| C3 | AC links | Each US shows its acceptance criteria listed below |

---

## D — Design Review: Workflows (12)

| # | What to verify | Pass criteria |
|---|---|---|
| D1 | Cards render | Each WF shows slug (WF-###), name, status pill |
| D2 | Trigger section | trigger.type, trigger.description, SLA, risk_tier, runs_per_period all display |
| D3 | risk_tier badge | Colour-coded (red/amber/green) |
| D4 | Edit modal opens | All fields present: name, sla_hours, readiness, risk_tier, runs_per_period, trigger.*, fallback_paths |
| D5 | Save creates CP | As B7 |
| D6 | Fallback paths | Editable as multi-line list |
| D7 | Steps section | All steps render with step_number, name, step_type chip, S-### slug |
| D8 | Step type chip | Start/End/Decision/Approval/Activity/Notification/Wait — correct colour |
| D9 | Step Phase 1 fields | step_purpose, preconditions, evidence_captured visible on step card |
| D10 | Step edit modal | Opens with all fields: name, actor_role, sla_hours, decisions, step_type, step_purpose, preconditions, evidence_captured |
| D11 | Step save creates CP | As B7 |
| D12 | HITL gate badge | Steps with HITL gate show ⚡ chip |

---

## E — Workflow Participants — Phase 2 (12)

| # | What to verify | Pass criteria |
|---|---|---|
| E1 | Section always visible | Participants section appears even when 0 rows exist |
| E2 | "＋ Add" button | Clicking opens modal |
| E3 | Orchestrator/Specialist type | Selects Agent Spec dropdown; Human type fields hidden |
| E4 | Human type | Shows Human Role Name text field; agent dropdown hidden |
| E5 | Type switch | Toggling participant_type live-swaps visible fields |
| E6 | All modal fields | purpose, authority_level, handoff_method, swimlane label, lane order, include_in_rasic |
| E7 | Add saves + slug | New row appears with P-### slug auto-assigned |
| E8 | ✏️ edit | Existing row → edit modal pre-filled correctly |
| E9 | Edit saves | Change a field → saves, updates row |
| E10 | Delete | Confirm dialog → participant disappears |
| E11 | ExxonMobil | Agentic Invoice Lookup project shows 4 participants: Platform, Invoice Agent, IT Fulfiller, Admin |
| E12 | ACME | ACME Order Management project shows 10 participants across 3 workflows |

---

## F — RASIC Matrix — Phase 2 (12)

| # | What to verify | Pass criteria |
|---|---|---|
| F1 | Matrix renders | Appears when participants exist; shows all steps (not just those with existing codes) |
| F2 | Columns | One column per participant marked include_in_rasic |
| F3 | Existing codes | Seeded codes (R, A, I, C) show in correct cells |
| F4 | Hint text | "Click any cell to toggle…" hint visible above matrix |
| F5 | Cell click | Popover appears with R/A/S/I/C checkboxes |
| F6 | Check a code | POST fires → code appears in cell immediately (no reload) |
| F7 | Uncheck a code | DELETE fires → code disappears immediately |
| F8 | Multi-code cell | Check R + A → cell shows "AR" |
| F9 | Popover closes | Click outside popover → it dismisses |
| F10 | Empty cell | Unchecked cell shows · not blank |
| F11 | ExxonMobil S-005 | Shows R (Invoice Agent), A (Platform), C (Admin) |
| F12 | ExxonMobil S-006 | Shows R (Invoice Agent), A (Platform), I (IT Fulfiller) |

---

## G — Workflow Paths — Phase 2 (11)

| # | What to verify | Pass criteria |
|---|---|---|
| G1 | Section always visible | Paths section appears even when 0 rows exist |
| G2 | "＋ Add" button | Clicking opens modal |
| G3 | Step dropdowns | From Step / To Step dropdowns populated with this workflow's steps |
| G4 | All modal fields | branch_label, branch_condition, default checkbox, notes |
| G5 | Add saves + slug | New path appears with PATH-### slug |
| G6 | ✏️ edit | Pre-filled correctly |
| G7 | Edit saves | Changes persist |
| G8 | Delete | Path disappears |
| G9 | Default marker | Default path shows green ✓ in table |
| G10 | ExxonMobil branch | S-003 has two outgoing paths (SAP needed / No SAP needed) |
| G11 | ACME WF1 | 6 paths visible including two branches |

---

## H — Design Review: Agents (11)

| # | What to verify | Pass criteria |
|---|---|---|
| H1 | Cards render | AG-### slug, name, status pill |
| H2 | Breadcrumb | Links back to parent Use Case |
| H3 | Operational Metadata section | supervision_model, orchestration_strategy, maintenance_owner, latency_target, post_release_validation visible when set |
| H4 | cost_model hidden | cost_model only shown when !== 'none' |
| H5 | Edit modal | All 15 fields present including Phase 1 additions |
| H6 | Enum selects | supervision_model (3 options), orchestration_strategy (3 options) |
| H7 | goals list | Editable as multi-line |
| H8 | done_criteria list | Editable as multi-line |
| H9 | design_risks json | Editable, saved as JSON |
| H10 | run_as_model fields | model_type, trust_level, rationale editable as dot-path |
| H11 | Save creates CP | As B7 |

---

## I — Design Review: Tools (4)

| # | What to verify | Pass criteria |
|---|---|---|
| I1 | Cards render | T-### slug, name, dev_status badge |
| I2 | dev_status badge | "Existing" / "To be built" chip visible |
| I3 | Edit modal | All fields: name, execution_mode, cost_impact, dev_status, access_requirements.*, contract.*, boundaries |
| I4 | Save creates CP | As B7 |

---

## J — Design Review: Supporting Scopes (10)

| # | What to verify | Pass criteria |
|---|---|---|
| J1 | Guardrails tab | Loads, shows items from ingest extraction |
| J2 | Data Sources tab | Loads, shows items |
| J3 | Test Scenarios tab | Loads, shows extraction scenarios |
| J4 | User Stories tab | Loads, shows all user stories with story_type |
| J5 | Governance tab | Loads |
| J6 | Relationships tab | Loads, shows entity relationship map |
| J7 | Design Library tab | Loads knowledge articles |
| J8 | Library filter | Scope filter changes displayed articles |
| J9 | Document drawer | Click a source doc → side panel slides open |
| J10 | Drawer search | Search within drawer filters results |

---

## K — Testing Module (15)

| # | What to verify | Pass criteria |
|---|---|---|
| K1 | Module loads | No errors, project selector present |
| K2 | AC tab | Acceptance Criteria listed, grouped by UC / US |
| K3 | AC text inline edit | Click text → contentEditable activates |
| K4 | AC blur save | Blur → source flips to user_edited, CP created |
| K5 | AC status change | Select draft/approved/rejected → saves immediately |
| K6 | AC add | "Add AC" button → new row appears, editable |
| K7 | AC delete | Delete button → confirm → row removed |
| K8 | TC tab | Test cases listed with scope |
| K9 | TC scope sub-tabs | Filters by use_case / workflow / agent / tool |
| K10 | TC case_type | Dropdown: happy_path / edge_case / negative / regression / performance |
| K11 | TC inline edit | title, test_action, test_input, expected_result all editable |
| K12 | TC blur save | Saves, flips source |
| K13 | TC add | "Add Test Case" button works |
| K14 | TC delete | Deletes correctly |
| K15 | Project switch | Switching project reloads AC and TC for new project |

---

## L — Other Modules: Smoke Only (12)

| # | What to verify | Pass criteria |
|---|---|---|
| L1 | Home / Dashboard | Loads, shows summary stats |
| L2 | Ingest | Module loads; file list renders |
| L3 | Projects | Loads; project list shows |
| L4 | Trust | Loads without error |
| L5 | Change Packets | List loads; a CP from a previous save appears |
| L6 | Change Packet detail | Click a CP → detail view shows old/new data |
| L7 | Evidence | Module loads |
| L8 | Audit Log | Loads; shows recent audit entries |
| L9 | Baseline | Loads |
| L10 | Validation | Loads |
| L11 | Build / Export | Loads |
| L12 | Reports | Loads |

---

## M — Cross-cutting Concerns (8)

| # | What to verify | Pass criteria |
|---|---|---|
| M1 | Slug system | Every entity card (UC/WF/AG/T/S/AC/TC/P/PATH) shows its ### slug |
| M2 | Slug immutability | Edit a UC → slug field absent from edit modal (read-only) |
| M3 | Slug uniqueness | Two UCs in same project have different slugs |
| M4 | Per-project numbering | ExxonMobil has its own UC-001 independent of ACME |
| M5 | Enum enforcement | PUT supervision_model = "Banana" via curl → 400 returned |
| M6 | Seeded data integrity | Both projects (ACME + ExxonMobil) load with no missing entities |
| M7 | DB cold start | Delete `asdlc.db`, restart server → DB recreated and seeded correctly |
| M8 | Concurrent edits | Edit same entity in two browser tabs → second save doesn't crash |

---

## N — Phase 3: Agent M:N & Tool Bindings (10)

| # | What to verify | Pass criteria |
|---|---|---|
| N1 | Agent → multiple UCs | Agent card breadcrumb lists one chip per linked use case (not just one) |
| N2 | Agent UC modal | "＋ Link Use Case" opens modal with UC dropdown, business_value, notes |
| N3 | Add UC link | Saves; new UC appears in breadcrumb |
| N4 | Unlink UC | ✕ button → confirm → UC disappears |
| N5 | Tool bindings section | Each agent card has a "Tools used by this agent" table |
| N6 | Bind tool | "＋ Bind Tool" modal → choose tool, set purpose/fallback/exec mode/sup model → saves |
| N7 | Edit binding | ✏️ pre-fills correctly; save persists |
| N8 | Remove binding | ✕ removes the row |
| N9 | Tools tab — broader scope | Tools tab includes GLOBAL / ORGANIZATION / PROGRAM scoped tools alongside project tools |
| N10 | UC agent_count | Use Case card's agent count uses M:N join (re-link an agent to a 2nd UC; both UCs show it) |

---

## O — Phase 4: Cost Management (15)

| # | What to verify | Pass criteria |
|---|---|---|
| O1 | Rate card seeded | Cost Management admin page shows 132 Now Assist skills |
| O2 | Cost assumption settings | Form shows $0.015/Monthly defaults; saves persist |
| O3 | Skill row edit | ✏️ on a rate card row → edits `assists_per_unit` and `category` |
| O4 | Costs left-nav item | "Costs" appears in sidebar between Design Review and Testing |
| O5 | Costs page totals | Shows Projected/month + Projected/year + Baseline + Savings + ROI tiles |
| O6 | Agent breakdown grouped by agent | Each agent block shows its tool bindings, owned steps, and per-step skill bindings |
| O7 | Non-Agentic Costs bucket | Steps owned by non-agent participants show in a separate "Non-Agentic Costs" section |
| O8 | Headline split subline | When both Agentic + Non-Agentic > 0, headline shows "Agentic $X · Non-Agentic $Y" |
| O9 | Per-bucket WF subtotal | WF row inside Agent bucket = sum of bindings IN THAT bucket (not the whole WF cost) |
| O10 | Branch % editable | Click a Branch % cell → input → Tab/Enter saves; cost recomputes |
| O11 | UC card cost chip | ExxonMobil UC card shows `~$X / month` chip + `ROI ~X.X×` chip |
| O12 | WF card cost chip | Each WF card shows projected $/month + `N runs / period` badge |
| O13 | Agent card cost chip | Each agent card shows projected $/month chip |
| O14 | Step card binding rows | Each step card shows its cost_bindings table with AI badge + remove button |
| O15 | AI estimate button | "🤖 Generate Bindings with AI" → toast "AI estimation unavailable" when no API key; spinner+toast on success when key set |

---

## P — Phase 4: Volume + Cost Recomputation (4)

| # | What to verify | Pass criteria |
|---|---|---|
| P1 | UC volume fields | Edit a UC → Volume — Monthly Requests / Peak Concurrency / Peak Period / Notes inputs render |
| P2 | Volume → runs propagation | Set UC monthly_requests = 5000 → save → all child workflows' `runs_per_period = 5000` |
| P3 | Cost recomputes after volume | After P2, UC + WF + Agent cost chips update on next render |
| P4 | Cost recomputes after Branch % | Change Branch % on a binding → after-save reload shows updated WF / Agent / UC totals |

---

## Q — Phase 5: Slug Autolinker + RBM Panel + Scope Badge + ROI (12)

| # | What to verify | Pass criteria |
|---|---|---|
| Q1 | Slug-map endpoint | GET `/api/v1/projects/:id/slug-map` returns a map of every slug → {scope, entity_id, label} |
| Q2 | Inline slug autolinks | Any free-text field rendered in Design Review with a UC-### / WF-### / S-### / AG-### / T-### reference shows it as a clickable monospace blue link |
| Q3 | Slug link drills correctly | Clicking `WF-001` from agents view switches to workflows scope and scrolls to that WF |
| Q4 | TC slug routes to parent scope | A TC-### slug whose underlying TC has scope=tool routes to the Tools tab on click |
| Q5 | AC slug routes to parent UC | An AC-### slug routes to the parent UC's card |
| Q6 | RBM panel — UC modal | Edit any UC → expand "Methodology Guidance" → matrix filtered to the selected supervision_model |
| Q7 | RBM panel reactive | Change supervision_model in the form → matrix re-filters live |
| Q8 | RBM panel — Agent modal | Same as Q6 for agents |
| Q9 | RBM panel — Workflow modal | Workflow modal shows all three modes side-by-side (no supervision_model column) |
| Q10 | Tool scope badge | Every tool in the Tools tab shows a scope chip: ◧ Project / 🌐 Global / 🏢 Org / 🎯 Program with distinct colors |
| Q11 | ROI display has Savings tile | Costs page shows "Savings / year — $X (Y% of baseline)" when baseline is set |
| Q12 | Volume_assumptions migration | Legacy `monthly` key normalized to `monthly_requests`, `note` to `notes` (no duplicate rows on UC card) |

---

## Item count by section

| Section | Count |
|---|---|
| A — Shell & Nav | 8 |
| B — Use Cases | 10 |
| C — User Stories | 3 |
| D — Workflows | 12 |
| E — Participants | 12 |
| F — RASIC Matrix | 12 |
| G — Paths | 11 |
| H — Agents | 11 |
| I — Tools | 4 |
| J — Supporting Scopes | 10 |
| K — Testing Module | 15 |
| L — Other Modules | 12 |
| M — Cross-cutting | 8 |
| N — Phase 3 Agent M:N | 10 |
| O — Phase 4 Cost Management | 15 |
| P — Phase 4 Volume + Recomputation | 4 |
| Q — Phase 5 Autolinker/RBM/Scope/ROI | 12 |
| **Total** | **169** |

---

*Last updated: 2026-05-17 — reflects Phases 1–5 (slugs, field additions, Participants/RASIC/Paths, Agent M:N + tool bindings, Cost Management, slug autolinker, Required-By-Mode panel, scope badge, ROI polish).*
*Update this file when new phases ship.*
