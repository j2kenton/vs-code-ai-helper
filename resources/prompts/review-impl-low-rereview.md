You are performing a LOW-LEVEL RE-REVIEW of an implementation after code changes were made in response to the previous review. A high-level review has already confirmed the overall approach; do not relitigate it.

The context pack highlights the implementation review files for this task. Treat the actual files as the implementation under review, not the implementation notes. Where the pack is truncated or a file is missing from it, read the file from the workspace instead (see "Reading the workspace yourself" in the rubric below) rather than accepting a claim from the notes — and only report evidence as unavailable when you actually could not obtain it.

{{reconciliationInstruction}}

Focus on code-level correctness: specific plan items, failure scenarios, edge cases, error handling, consistency with surrounding code, and whether each required item is genuinely complete.

Use these blocker categories consistently:
- Defect blockers: concrete bugs or regressions with a plausible failure scenario.
- Completion blockers: required plan items or acceptance criteria that remain incomplete or were unilaterally deferred.
- Review-confidence blockers: relevant evidence is unavailable or truncated enough that readiness cannot responsibly be established.

Score the current implementation against the full approved plan. Explain any unchanged or lower score despite resolved findings, and keep newly discovered blockers separate from the previous blocker reconciliation.

Plans built across multiple implementation rounds. When the high-level review has already established that this plan is being delivered in an ordered, multi-round sequence (an "executable order", numbered phases, or a cohort structure), apply the same exception at this level: plan items not yet reached by that order are expected work, not completion blockers, and must not hold the score down. Score what exists — if every landed item is correct and genuinely complete, that is a high score even when most of the plan is still ahead. A landed item that is incomplete, defective, or deviates from the plan's contract is still a blocker regardless of how much of the plan remains; being mid-plan excuses only the ABSENCE of later items, never a defect in what was built.

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

Record which commit you reviewed. End your response with this marker on its own line, using the exact value shown below (copy it — do not compute or guess a SHA yourself):

```
<!-- reviewed-commit: {{reviewedCommitSha}} -->
```

## Context Pack (implementation review files)

{{contextPack}}

{{verifiedChecks}}

## Previous Low-Level Implementation Review

{{previousReview}}

## Previous Round's Blockers (for lineage citation)

{{priorBlockerLineageList}}

## Final Plan

{{plan}}

## Current Implementation Notes

{{implementation}}
