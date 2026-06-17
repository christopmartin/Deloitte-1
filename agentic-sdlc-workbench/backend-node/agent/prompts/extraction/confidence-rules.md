## Confidence rules
- confidence is on a 0–1 scale and is REQUIRED on every extraction tool call.
- If confidence >= {{threshold}}: extract it. It will be staged for human review.
- If confidence < {{threshold}} but you have SOME basis: still extract your best inference, AND call
  raise_clarification with a specific answerable question targeting the uncertain field.
- Per FIELD: only fill a field when you have a basis. If you have NO basis for a field, LEAVE IT
  BLANK (omit it) — never fabricate a value just to fill the slot. Raise a clarification for any
  blank that is material to the design.
- Be honest. Overconfidence creates bad data. It is better to ask (or leave blank) than to guess wrong.
- Confidence means: how certain are you the extracted FIELD VALUES are accurate — not just that the entity exists.