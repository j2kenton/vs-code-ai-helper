You are performing a LOW-LEVEL review of the implementation of a software engineering task, checking the actual code against the final plan and the implementation notes below (a checklist or a summary of what was done, depending on how plan-final.md was produced). A high-level review has already confirmed the overall approach — do not relitigate it.

The context pack below contains the implementation review files for this task. When the task was run with the AI implementation command, these are the files that were changed by the AI; when the task was implemented manually (or before file tracking was introduced), the context pack falls back to the files open in the editor at review time — in that case the pack will say so explicitly. Treat the actual files as the implementation under review, not the implementation notes. If a claim in the notes cannot be verified against the pack alone, read the file from the workspace and verify it there (see "Reading the workspace yourself" in the rubric below) — never guess, and only say a claim is unverified when you actually tried and could not check it.

Assess at the code level: correctness of the specific changes, edge cases, error handling, consistency with the surrounding code, and whether each plan item is genuinely complete rather than superficially present.

Score the current implementation against the full approved plan, not merely the subset attempted in the implementation notes. Required plan items or acceptance criteria that remain incomplete or were unilaterally deferred are completion blockers. Keep missing evidence separate as a review-confidence blocker rather than guessing.

Plans built across multiple implementation rounds. A plan larger than one implementation round can deliver is normal, not a problem. When the high-level review has already established that this plan is being delivered in an ordered, multi-round sequence (an "executable order", numbered phases, or a cohort structure), apply the same exception at this level: plan items not yet reached by that order are expected work, not defects in the code that landed: do not file them as separate blockers or mark the landed items down for their absence. They are still unbuilt, though: when you find plan items that are not built (as opposed to built but not ticked, which belong in `## Verified Complete`), file exactly ONE `- [completion] [task-fixable]` blocker that names them together, and the score follows the rubric's rule for an open blocker. A verdict or next-steps text that says plan items remain to be built, with no such blocker, contradicts itself, and Ensemble holds the stage instead of advancing on it. A landed item that is incomplete, defective, or deviates from the plan's contract is still a blocker regardless of how much of the plan remains; being mid-plan excuses only the ABSENCE of later items, never a defect in what was built.

Do not accept an unapproved substitute merely because it is plausible or
locally safer. When code materially changes an explicit plan contract or
acceptance criterion, report the required behavior and actual behavior as a
completion blocker unless the task records user approval. Implementation notes
do not constitute that approval.

The plan of record may declare certain residual issues out of scope in an "## Accepted Non-Goals" section, reproduced below alongside any standing owner decisions — both are binding inputs to this review, not incidental prose. Do not report a blocker whose subject is covered by an Accepted Non-Goals entry or a recorded owner decision; those questions are already settled and are not this review's to reconsider. If you believe an entry is wrong or no longer applies, say so explicitly in your verdict — name the entry and why — rather than silently re-raising the same blocker with no acknowledgement that a decision already covers it.

Owner evidence: when a round declined a step because it needs a web page, documentation, or a live provider CLI run, file `- [completion] [environmental] Owner evidence needed: <the exact evidence>` as the blocker — it is an owner decision, never `needs-toolchain`.

Narrowing: when a ticked checklist item was only partly done and the round's evidence says the rest does not apply, only the owner may narrow the item. File `- [completion] [environmental] Narrowing needs an owner decision: `<the checklist item text, verbatim, in backticks>` — <what was not done>` as the blocker, never `task-fixable` (a round may not narrow the plan, so sending it back to a round cannot clear it). A plan whose tick is disputed is not complete: keep the score below the ready threshold while the narrowing is undecided, otherwise the blocker will not raise the owner card.



Owner hand-offs: an excluded five-element owner check (What/Why/How/Failure/Priority), or an item marked `Verified by Publish Checks`, is an intentional hand-off. If it is still pending, list it in the verdict as owed by the owner; do not file a blocker just because installation or Publish Checks has not happened yet. This exception applies only to those owner hand-offs. An exclusion that hides unfinished round work remains a completion blocker.

The final response must be the review itself and begin with the required `Readiness: N/10` line; do not return a summary of the investigation instead of the review.

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

Record which commit you reviewed. End your response with these markers on their own lines, using the exact values shown below (copy them — do not compute or guess a SHA or a fingerprint yourself):

```
<!-- reviewed-commit: {{reviewedCommitSha}} -->
<!-- reviewed-tree-fingerprint: {{reviewedTreeFingerprint}} -->
<!-- review-pass: {{reviewPass}} -->
```

## Context Pack (implementation review files)

{{contextPack}}

{{verifiedChecks}}

## Final Plan

{{plan}}

## Accepted Non-Goals

{{acceptedNonGoals}}

## Owner Decisions

{{ownerDecisions}}

## Implementation Notes

{{implementation}}
