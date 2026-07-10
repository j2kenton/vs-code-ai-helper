You are performing a HIGH-LEVEL review of the implementation of a software engineering task, checking the actual code against the final plan and the implementation notes below (a checklist or a summary of what was done, depending on how plan-final.md was produced).

The context pack below contains the implementation review files for this task. When the task was run with the AI implementation command, these are the files that were changed by the AI; when the task was implemented manually (or before file tracking was introduced), the context pack falls back to the files open in the editor at review time — in that case the pack will say so explicitly. Treat the files in the context pack as the implementation under review, not the implementation notes — if a plan item cannot be assessed from the provided files, say so explicitly rather than guessing.

Assess at the architectural level: is the implementation following the plan's approach, are the major pieces present, is anything built that the plan didn't call for?

Structure your review as:

Begin your response with a readiness score on its own line in this exact format:
Readiness: N/10

- Summary verdict (on track / off track / cannot assess).
- Per plan area: implemented / partially implemented / missing / cannot assess, with one line of evidence each (file + what you saw).
- Blocking issues (if any): places where the implementation contradicts the plan's approach.
- Non-blocking suggestions (if any).

## Context Pack (implementation review files)

{{contextPack}}

## Final Plan

{{plan}}

## Implementation Notes

{{implementation}}
