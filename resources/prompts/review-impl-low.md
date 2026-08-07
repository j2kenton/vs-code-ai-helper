You are performing a LOW-LEVEL review of the implementation of a software engineering task, checking the actual code against the final plan and the implementation notes below (a checklist or a summary of what was done, depending on how plan-final.md was produced). A high-level review has already confirmed the overall approach — do not relitigate it.

The context pack below contains the implementation review files for this task. When the task was run with the AI implementation command, these are the files that were changed by the AI; when the task was implemented manually (or before file tracking was introduced), the context pack falls back to the files open in the editor at review time — in that case the pack will say so explicitly. Treat the files in the context pack as the implementation under review, not the implementation notes — if a claim in the notes can't be verified against the actual files, say so explicitly rather than guessing.

Assess at the code level: correctness of the specific changes, edge cases, error handling, consistency with the surrounding code, and whether each plan item is genuinely complete rather than superficially present.

Score the current implementation against the full approved plan, not merely the subset attempted in the implementation notes. Required plan items or acceptance criteria that remain incomplete or were unilaterally deferred are completion blockers. Keep missing evidence separate as a review-confidence blocker rather than guessing.

Plans built across multiple implementation rounds. A plan larger than one implementation round can deliver is normal, not a problem. When the high-level review has already established that this plan is being delivered in an ordered, multi-round sequence (an "executable order", numbered phases, or a cohort structure), apply the same exception at this level: plan items not yet reached by that order are expected work, not completion blockers, and must not hold the score down. Score what exists — if every landed item is correct and genuinely complete, that is a high score even when most of the plan is still ahead. A landed item that is incomplete, defective, or deviates from the plan's contract is still a blocker regardless of how much of the plan remains; being mid-plan excuses only the ABSENCE of later items, never a defect in what was built.

Do not accept an unapproved substitute merely because it is plausible or
locally safer. When code materially changes an explicit plan contract or
acceptance criterion, report the required behavior and actual behavior as a
completion blocker unless the task records user approval. Implementation notes
do not constitute that approval.

Structure your review as:

Begin your response with a readiness score on its own line in this exact format:
Readiness: N/10

{{reviewScoringRubric}}

- Summary verdict (ready to complete / needs changes / cannot fully assess).
- Per plan item: done / incomplete / defective / cannot assess, with file-level evidence for each judgment.
- Material plan deviations (if any): required behavior vs. actual behavior, and whether the task records user approval.
- Defect blockers (if any), each with the file, the problem, and a concrete failure scenario.
- Completion blockers (if any).
- Review-confidence blockers (if any).
- Non-blocking suggestions (if any).

Record which commit you reviewed. End your response with this marker on its own line, using the exact value shown below (copy it — do not compute or guess a SHA yourself):

```
<!-- reviewed-commit: {{reviewedCommitSha}} -->
```

## Context Pack (implementation review files)

{{contextPack}}

{{verifiedChecks}}

## Final Plan

{{plan}}

## Implementation Notes

{{implementation}}
