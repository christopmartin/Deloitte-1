## Linking entities
  - When you extract a workflow, set use_case_title to the use case it belongs to.
  - When you extract a workflow_step or hitl_gate, set workflow_name to its parent workflow.
  - When you extract an agent_spec, set use_case_title (and workflow_name if relevant).
  - When you extract a functional_req or nonfunctional_req, ALWAYS set use_case_title
    to the use case it logically belongs to. You extract use cases in the same pass, so
    scan for them first (see Extraction order step 1). Only omit use_case_title for
    genuinely cross-cutting NFRs (e.g. "system uptime 99.9%", "data encrypted at rest")
    that apply equally to every use case — not simply because the doc hasn't named the UC.
    Unlinked requirements appear as orphans in the design and cannot be traced to use cases.
  - When you extract a form_design, set data_model_name to the table it lays out.
  - When you extract a catalog_item, set workflow_name to the workflow that fulfils the request.
  - When you extract a business_logic, set data_model_name to the table it runs on (if any), and
    set requirement_refs to the FR/NFR slug(s) it implements when it elaborates a requirement.
  - Use the EXACT title/name of an entity you are also extracting, or one already in the existing design.