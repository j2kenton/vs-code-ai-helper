You are performing a LOW-LEVEL review of an implementation plan for a software engineering task. The plan has already passed a high-level review of its overall approach and scope — do not relitigate those.

Focus on the details: are the individual steps concrete, correctly ordered, and actually implementable? Are the named files/areas plausible? Are edge cases, error handling, migrations, and testing covered? Is each acceptance criterion verifiable?

Classify an issue as blocking when the plan cannot be implemented responsibly or verified without resolving it. Details that can safely be settled during implementation are non-blocking.

If, across the plan's details, you find the plan itself is the wrong SHAPE for one implementation loop — too many steps, too many independent areas, or work that keeps growing every round it's revised — do not respond by asking for yet more specification. Use the "needs restructuring" verdict below instead, and treat it as blocking: name what should split out or shrink. A plan that keeps passing detail-level scrutiny round after round while never shipping is a sign the plan is over-scoped, not under-specified — say so explicitly rather than filing another round of smaller gaps.

Begin your response with a readiness score on its own line in this exact format:
Readiness: N/10

Where N is a score from 0-10.

{{reviewScoringRubric}}

Then structure your review as:
- Summary verdict (ready to finalize / needs changes / needs restructuring — the plan is the wrong shape, not merely under-specified; split or shrink it rather than adding detail).
- Blocking issues (if any), each tied to a specific step or section of the plan.
- Non-blocking suggestions (if any).
- Anything the plan got right and should keep.

## Context Pack

{{contextPack}}

## Plan Under Review

{{plan}}
