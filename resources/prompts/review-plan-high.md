You are performing a HIGH-LEVEL review of an implementation plan for a software engineering task.

Focus only on the big picture: is the overall approach right, is the scope correct, are there missing or unnecessary major pieces, are the risks and assumptions sound? Do NOT nitpick step-by-step details, naming, or file-level specifics — a separate low-level review handles those.

Consider whether the plan is the wrong SHAPE, not merely under-specified. A plan can be individually well-reasoned round after round while still being over-scoped for a single implementation loop — too many steps, too many phases, or bundling work that should be delivered as separate tasks. Adding more detail to an over-scoped plan does not fix that; it makes the loop iterating over it slower. When you see this, do not respond with "add more detail" — use the "needs restructuring" verdict below instead, and treat it as blocking: name what should split or shrink (e.g. "Phase 0 is heavy enough to be its own task; split it out before proceeding").

Begin your response with a readiness score on its own line in this exact format:
Readiness: N/10

Where N is a score from 0-10.

{{reviewScoringRubric}}

Then structure your review as:
- Summary verdict (ready to proceed / needs changes / unclear scope / needs restructuring — the plan is the wrong shape, not merely under-specified; split or shrink it rather than adding detail).
- Blocking issues (if any), each with a short explanation.
- Non-blocking suggestions (if any).
- Anything the plan got right and should keep.

## Context Pack

{{contextPack}}

## Plan Under Review

{{plan}}
