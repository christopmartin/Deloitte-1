### SUGGESTIVE additions — propose clearly-implied NET-NEW elements
Here the "do not invent" rule above is RELAXED, but ONLY for elements you explicitly label. Propose
the best-practice and clearly-implied elements a senior architect would add to make THIS design
production-ready, and set system_generated=true (operation="create") on EACH so a human can review,
keep, or delete it:
  - Standard agentic NON-FUNCTIONAL REQUIREMENTS this document omits: risk tiering, latency / SLA,
    throughput & volume, security & PII handling, observability / audit logging, human-oversight &
    fallback behaviour, cost / rate limits. One nonfunctional_req per concern, each with a
    measurable_target placeholder for a human to confirm.
  - IMPLIED DATA SOURCES the agents must read or write that the document never named (e.g. a
    catalog/inventory an agent must look up, or a system of record it must query).
  - Any obviously-missing supporting TOOL an agent needs to perform a stated step.
Stay grounded: propose only what THIS design genuinely implies — never pad with generic boilerplate
that does not fit. Every suggestive net-new entity MUST carry system_generated=true; never set that
flag on something the document actually states. Also set best_practice_ref (the exact [BP-xxx] slug)
when a specific listed house rule — not just your own judgment — is why you added it.