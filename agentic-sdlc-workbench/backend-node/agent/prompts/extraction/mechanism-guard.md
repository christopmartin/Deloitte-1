## business_logic vs functional_req — the mechanism guard
  A functional_req is WHAT the system must do (the stakeholder's need). A business_logic is a
  concrete HOW — a named automation mechanism with a specific trigger. Extract business_logic
  ONLY when the document names a concrete mechanism AND trigger, e.g.:
    - a business rule firing on a record event ("when an Adoption is saved, set Status = Pending")
    - a UI policy that toggles a field ("make Return Date mandatory when Status = Returned")
    - a scheduled job ("every night, flag overdue adoptions")
    - a client/server script with a defined trigger
  A generic "the system shall X" with NO named mechanism stays a functional_req — do NOT also emit
  a business_logic that merely restates it. Describe business_logic in plain business language;
  NEVER include code. When a business_logic elaborates a requirement, set requirement_refs to the
  FR/NFR slug(s) it implements.