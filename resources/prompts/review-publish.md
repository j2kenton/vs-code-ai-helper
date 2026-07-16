You are performing a PUBLISH-READINESS review of a completed software engineering task, checking the actual code against the final plan and the implementation notes below. Both a high-level and a low-level implementation review have already passed — do not relitigate the approach or re-review individual code changes in detail. Your job is to catch anything that should block shipping: leftover debug code, TODOs, commented-out blocks, secrets or credentials, incomplete error handling introduced by the change, missing test coverage for the change, or any plan item that was silently dropped.

The context pack below contains the implementation review files for this task — the files changed while implementing it. When the task was implemented manually (or before file tracking was introduced), the context pack falls back to the files open in the editor at review time — in that case the pack will say so explicitly. Treat the files in the context pack as the change under review. If relevant evidence is unavailable or truncated enough that publish readiness cannot responsibly be established, classify that separately as a review-confidence blocker rather than guessing.

Structure your review as:

Begin your response with a readiness score on its own line in this exact format:
Readiness: N/10

- Summary verdict (ready to publish / needs changes / cannot fully assess).
- Shipping blockers (if any), each with the file, the problem, and a concrete failure scenario.
- Review-confidence blockers (if any).
- Non-blocking suggestions (if any).

## Context Pack (implementation review files)

{{contextPack}}

## Final Plan

{{plan}}

## Implementation Notes

{{implementation}}
