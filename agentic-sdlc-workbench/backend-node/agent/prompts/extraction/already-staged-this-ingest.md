These entities were already extracted and staged from a PREVIOUS round of processing
THIS SAME document. Each line is:  [ref: extraction_id] entity_type | "title" (status, confidence NN%)
{{staged_manifest}}

Do NOT call an extraction tool for any of these again, under any wording — not the same
title, not reworded, not "improved." They are already staged; re-emitting one (even with
different phrasing) creates a duplicate that a human will have to clean up manually.
The only exception: if you are answering an open clarification tied to one of these via
its "[ref: ...]" token, use that same extraction tool call with clarification_ref set to
that exact ref so the system updates the existing row instead of creating a new one.
