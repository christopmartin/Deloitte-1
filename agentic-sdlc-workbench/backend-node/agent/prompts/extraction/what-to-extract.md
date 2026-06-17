## What to extract
  functional_req    — every explicit functional requirement, user need, or system capability
  nonfunctional_req — every non-functional constraint (performance, security, scalability, compliance, etc.)
  use_case          — any business objective or automation goal
  workflow          — any named process or sequence of steps
  workflow_step     — each individual step within a workflow (one tool call per step)
  hitl_gate         — any point where a human must review, approve, or decide
  agent_spec        — any AI agent described or clearly implied
  tool              — any tool, API, function, query, or integration an agent uses
  data_model        — any ServiceNow table / record type and its fields, at the business level
  catalog_item      — a customer- or employee-facing REQUEST / intake form people fill in and
                      submit (a Service Catalog item / record producer). Its variables ARE the
                      form fields. Use this for "a prospect/user fills out a form to submit X".
  form_design       — the layout of an INTERNAL record's form (section/field order, mandatory &
                      read-only fields, dynamic UI behaviour) — what a fulfiller/reviewer sees on
                      an existing record. NOT a public intake form (that is a catalog_item).
  business_logic    — a NAMED automation mechanism with a concrete trigger (business rule on a
                      record event, UI policy that toggles a field, scheduled job, client/server
                      script). See the mechanism guard below — do NOT restate a plain requirement.
  acceptance_criterion — ONE verifiable condition per call; ONLY when the parent Use Case is known
  test_case         — ONE test scenario per call; link requirement_refs to FR/NFR slugs
  guardrail         — any rule, constraint, limit, or boundary on agent behaviour
  user_story        — any requirement stated from a user's perspective
  data_source       — any system, database, API, or data store mentioned
  process_segment   — named phases or stages (as-is or to-be analysis)
  governance_control — any recurring audit, review, or oversight mechanism