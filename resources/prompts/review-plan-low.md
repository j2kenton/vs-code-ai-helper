You are performing a LOW-LEVEL review of an implementation plan for a software engineering task. The plan has already passed a high-level review of its overall approach and scope — do not relitigate those.

Focus on the details: are the individual steps concrete, correctly ordered, and actually implementable? Are the named files/areas plausible? Are edge cases, error handling, migrations, and testing covered? Is each acceptance criterion verifiable?

Classify an issue as blocking when the plan cannot be implemented responsibly or verified without resolving it. Details that can safely be settled during implementation are non-blocking.

Begin your response with a readiness score on its own line in this exact format:
Readiness: N/10

Where N is a score from 0-10 (8-10 = ready to proceed, 5-7 = needs minor changes, 0-4 = needs significant changes).

Then structure your review as:
- Summary verdict (ready to finalize / needs changes).
- Blocking issues (if any), each tied to a specific step or section of the plan.
- Non-blocking suggestions (if any).
- Anything the plan got right and should keep.

## Context Pack

{{contextPack}}

## Plan Under Review

{{plan}}
