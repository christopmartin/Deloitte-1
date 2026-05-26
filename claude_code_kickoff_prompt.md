# Claude Code Kickoff Prompt — Agentic SDLC Workbench

## What we are building

A web-based workbench application that dramatically changes how ServiceNow Agentic AI applications are designed and configured. AI agents do the heavy lifting of agentic design details; humans provide initial input and review/validate. A secure multi-client repository supports the full lifecycle from requirements through build/test.

---

## Reference documents

Three files are included with this prompt. Read all three before writing any code:

1. **agentic_sdlc_workbench_wireframes.html** — UI wireframes for all 10 modules. This is the target UI. Use it as the specification for screens and information architecture.
2. **agentic_sdlc_repository_erd_v2.html** — Entity relationship diagram. Six layers, 35 tables.
3. **from_Claude_repository_database_design_merged_v1.docx** — Full logical database design. Includes all table definitions, field-level detail, design principles, relationships, indexes, and open questions.

---

## Architecture decisions — already made, do not re-open

| Decision | Choice |
|---|---|
| Implementation location | External workbench (not ServiceNow-native) |
| Database | PostgreSQL — Azure Database for PostgreSQL Flexible Server |
| Field model | Typed columns on entity tables only (no hybrid asdlc_field_value generic store) |
| Audit trail | PostgreSQL triggers write changes to audit table(s) — not application-layer logging |
| Polymorphic FK pattern | (scope_type, scope_id) two-column pattern; integrity enforced via application layer and/or triggers |
| User identity | First-class entity inside the workbench — thin asdlc_user table (id, display_name, email, role, active). Do not integrate with external IdP in this prototype. |
| All-client reusable patterns | Same tables as project records; project_id = NULL, visibility_scope = ALL_CLIENTS, functional_owner_id required |
| Multi-tenant isolation | PostgreSQL Row-Level Security (RLS) enforced at DB level |
| Agent/ORM language | Python preferred for agent layer; use SQLAlchemy if ORM is needed |

---

## Open questions — deferred, do not implement yet

- Q6: RAG / vector search for Knowledge Articles (defer to MVP 4)
- Q7: Trust dial behavior-class granularity (defer to v1.1)
- Q8: Cross-project inherited record ID handling (defer to v1.1)
- Q9: Rich source citations (defer to MVP 4)
- Q10: Orchestration event retention policy (defer to MVP 5)

---

## Build sequence

Follow the MVP phases defined in §12 of the database design document:

**Start with MVP 1 — Core repository only:**
- asdlc_client, asdlc_project, asdlc_project_member, asdlc_user
- All Design Content tables (use_case, workflow, workflow_step, agent_spec, tool, agent_tool, data_source, guardrail, hitl_gate, test_scenario, cost_estimate, governance_control, user_story, knowledge_article, process_segment)
- asdlc_evidence_source
- asdlc_change_packet, asdlc_change_packet_item
- asdlc_baseline, asdlc_baseline_item
- asdlc_report_export
- Audit triggers for all tables
- RLS policies for project_id and visibility_scope

Do not build MVP 2+ tables (agent_catalog, agent_run, agent_task, etc.) in this prototype pass.

---

## UI target

Build the 10 modules shown in the wireframes HTML file:

1. Repository Admin Home
2. Project Setup & Access (v1)
3. Agent Trust & Permission Console (v1)
4. Change Packet Queue (v1)
5. Evidence & Source Registry (v1)
6. Field-Level Audit Viewer
7. Baseline & Version Manager (v1)
8. Reusable Knowledge / Pattern Library
9. Validation & Exception Queue
10. Report Builder / Export Center (v1)

Modules marked **v1** are the priority. The wireframes are low-fidelity — use them for information architecture and layout, not visual design. Apply reasonable professional styling.

---

## Key design principles to preserve (from §2 of database design)

- The atomic unit of truth is the field value
- Every meaningful field value must be traceable to evidence (source document or transcript with date/time)
- The repository is internal only — clients receive reports and exports, not direct repository access
- Agents propose changes; humans approve through Change Packets
- Project separation is required — reusable records have explicit scope: PROJECT, CLIENT, ALL_CLIENTS
- The trust dial is per project, per agent, set manually 1–5
- Baselines provide human-readable design snapshots: Draft, Build, optional Pilot, Production, Post-Prod vX.Y

---

## Constraints

- This is a local prototype running on a laptop
- Use Docker Compose to run PostgreSQL locally (do not require Azure for the prototype)
- Keep dependencies minimal
- Prioritize getting the data model and UI working over production hardening
