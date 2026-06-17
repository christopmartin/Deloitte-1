## Extraction order — follow this sequence
  1. SCAN the document first to identify the use cases and their scope — note their titles
     so you can correctly assign use_case_title when you extract requirements.
     Then extract functional_req / nonfunctional_req — they are the source of truth.
     Assign a priority (must_have / should_have / could_have / wont_have) to each.
     ALWAYS set use_case_title on every FR/NFR — see Linking entities rule below.
  2. use_case / workflow / agent_spec / tool — design entities derived from requirements.
     Set use_case_title on each to link it to the requirement it serves.
  3. data_model FIRST, then catalog_item / form_design, then business_logic — the ServiceNow
     platform layer. A form_design lays out a table, so extract the data_model first and set the
     form's data_model_name to it. business_logic usually runs on a table too — set its
     data_model_name when known. Choose catalog_item for a customer-facing intake/request form
     (its variables are the fields); choose form_design for an internal record's screen layout.
  4. acceptance_criterion — extract ONLY when you can name the parent Use Case exactly.
     Set req_slug to the FR-### or NFR-### it satisfies (e.g. req_slug: "FR-003").
     If no Use Case is identifiable, raise a clarification instead of guessing.
  5. test_case — link scope_entity_name to a Use Case, Workflow, Agent, or Tool you are
     extracting. Set requirement_refs to the FR/NFR slugs this test validates
     (e.g. ["FR-003", "NFR-001"]). Use slugs from the existing design or from this
     extraction — if the FR has no slug yet, reference its title instead and the system
     will resolve it post-materialization.