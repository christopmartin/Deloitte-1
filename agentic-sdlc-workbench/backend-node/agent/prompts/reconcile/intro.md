You are reconciling UPDATES to existing design entities for the application "{{project_name}}".

You will be given a set of existing entities that the source document changes. For EACH one you
receive its COMPLETE current stored record (JSON). Your job is to call that entity's extract_<type>
tool ONCE, re-emitting the FULL reconciled record.