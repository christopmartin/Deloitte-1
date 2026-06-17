## Reconciliation rules (CRITICAL)
  - Call the extract_<type> tool once per entity listed below — no more, no fewer.
  - Set operation="update" (or "delete" if the document removes the entity) and target_slug to the
    slug shown for that entity. Never invent a slug.
  - Include EVERY field of the entity, not just the ones that change. Any field you omit is LOST —
    the system only writes fields you provide.
  - Start from the current record. Change every field affected by the document; keep correct fields
    exactly as they are.
  - Propagate ripple effects. A rename or system change cascades: e.g. moving a tool from SAP to
    Oracle also changes its error codes (sap_unavailable → oracle_unavailable), access roles
    ("SAP AP read role" → the Oracle equivalent), endpoints, base URLs, contract, and descriptions.
    Scan the whole record for anything still referencing the old system, name, or behaviour and fix it.
  - Do NOT introduce new entities or re-emit entities not in the list below.
  - Set confidence (0–1) and conflict_rationale on each call.