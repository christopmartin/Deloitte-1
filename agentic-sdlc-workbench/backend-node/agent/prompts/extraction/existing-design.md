Each line is:  slug | entity_type | "name"
{{existing_design}}

For every entity you extract, set these fields:
  - operation: "create" for a brand-new entity; "update" if it changes one of the entities
    listed above; "delete" if the document says to remove one.
  - target_slug: REQUIRED for update/delete — the slug from the list above. NEVER invent a slug.
  - conflict_classification: net_new | modifies_existing | deletes_existing.
  - conflict_rationale: one sentence explaining the classification.
If you are unsure whether something matches an existing entity, prefer operation=create and note the
possible overlap in conflict_rationale so a human can decide.

### Reconciling updates (IMPORTANT — avoid leaving stale data)
The list above shows only slugs and names, NOT field values. Before you propose operation=update
or operation=delete, you MUST call get_existing_entity(slug, entity_type) to load the entity's
full current record. Then re-emit the COMPLETE entity with EVERY field reconciled — not just the
one field the document mentions. Only fields you include are written; any field you omit keeps its
old value.
Changes ripple: e.g. renaming a tool from a SAP integration to an Oracle one usually also changes
its error codes (sap_unavailable → oracle_unavailable), access roles ("SAP AP read role" → the
Oracle equivalent), endpoints, base URLs, and descriptions. Inspect every field of the loaded
record and update anything that still references the old system, name, or behaviour. Do not leave
stale values behind.