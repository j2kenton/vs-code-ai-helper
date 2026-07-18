You are performing a LOW-LEVEL RE-REVIEW of an implementation after code changes were made in response to the previous review. A high-level review has already confirmed the overall approach; do not relitigate it.

The context pack contains the implementation review files for this task. Treat the actual files as the implementation under review, not the implementation notes. If evidence is missing or truncated, say so rather than accepting a claim from the notes.

Your first responsibility is to reconcile every blocker from the previous low-level implementation review. Do not silently replace the previous blocker set with a fresh code review. If the previous review used inconsistent headings, treat any issue it described as preventing completion or leaving a required plan item unmet as a previous blocker.

Focus on code-level correctness: specific plan items, failure scenarios, edge cases, error handling, consistency with surrounding code, and whether each required item is genuinely complete.

Use these blocker categories consistently:
- Defect blockers: concrete bugs or regressions with a plausible failure scenario.
- Completion blockers: required plan items or acceptance criteria that remain incomplete or were unilaterally deferred.
- Review-confidence blockers: relevant evidence is unavailable or truncated enough that readiness cannot responsibly be established.

Score the current implementation against the full approved plan. Explain any unchanged or lower score despite resolved findings, and keep newly discovered blockers separate from the previous blocker reconciliation.

Do not accept an unapproved substitute merely because it is plausible or
locally safer. When code materially changes an explicit plan contract or
acceptance criterion, report the required behavior and actual behavior as a
completion blocker unless the task records user approval. Implementation notes
do not constitute that approval.

Begin your response with a readiness score on its own line in this exact format:
Readiness: N/10

{{reviewScoringRubric}}

Then structure your review as:
- Summary verdict (ready to complete / needs changes / cannot fully assess).
- Progress since previous review (improved / unchanged / regressed), with a short explanation.
- Score comparison in the form `Previous: X/10 -> Current: N/10`, explaining the movement.
- Previous blockers, addressing every prior blocker individually as resolved / partially resolved / unresolved, with file-level evidence.
- Per plan item: done / incomplete / defective / cannot assess.
- Material plan deviations (if any): required behavior vs. actual behavior, and whether the task records user approval.
- New defect blockers (if any), each with the file, problem, and concrete failure scenario.
- New completion blockers (if any).
- New review-confidence blockers (if any).
- Non-blocking suggestions (if any).

## Context Pack (implementation review files)

{{contextPack}}

## Previous Low-Level Implementation Review

{{previousReview}}

## Final Plan

{{plan}}

## Current Implementation Notes

{{implementation}}
