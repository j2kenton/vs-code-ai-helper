You are performing a LOW-LEVEL RE-REVIEW of an implementation after code changes were made in response to the previous review. A high-level review has already confirmed the overall approach; do not relitigate it.

The context pack highlights the implementation review files for this task. Treat the actual files as the implementation under review, not the implementation notes. Where the pack is truncated or a file is missing from it, read the file from the workspace instead (see "Reading the workspace yourself" in the rubric below) rather than accepting a claim from the notes — and only report evidence as unavailable when you actually could not obtain it.

{{reconciliationInstruction}}

Focus on code-level correctness: specific plan items, failure scenarios, edge cases, error handling, consistency with surrounding code, and whether each required item is genuinely complete.

Use these blocker categories consistently:
- Defect blockers: concrete bugs or regressions with a plausible failure scenario.
- Completion blockers: required plan items or acceptance criteria that remain incomplete or were unilaterally deferred.
- Review-confidence blockers: relevant evidence is unavailable or truncated enough that readiness cannot responsibly be established.

Ensemble facts: the context pack's `## Ensemble facts` section lists values Ensemble measured itself (the effective `ensemble.publishVerificationCommands` and where it was found, the Publish Checks command auto-detection would select, single-folder or multi-root window, the Ensemble version, provider CLI major versions). Use those facts; never file owner evidence or an owner decision for anything listed there.

Owner evidence: before recording "owner evidence needed", first try what can be safely done yourself: run a CLI against a throwaway folder outside the workspace, read files you have access to, or run a read-only command. Save any gathered evidence under the task's `evidence/` folder and record what was tried. "Owner evidence needed" is reserved for what truly requires the owner (their machine, account, payment, or judgement) — state which of these is required and why an agent cannot obtain it. When evidence can be gathered by an agent at a cost (provider usage, runtime), file `- [completion] [task-fixable] Agent can gather (cost: <estimate>): <description>` instead.

Owner decisions needed: for each blocker only the owner can settle (an unapproved plan deviation, an open design choice, or owner evidence), include an `## Owner decisions needed` block. Each block must provide:
- an id (e.g. `### step-6-decision`)
- what this part of the plan is for (in plain words)
- what is undecided or what went wrong (in plain words)
- each option in plain words, with its trade-offs
- a recommendation and the reason for it
- a separate paragraph of technical details (internal functions, file paths, tokens)

Write each block as labelled lines: `Id:`, `Plan purpose:`, `Problem:`, `Options:` (one bullet per option, `- <label> — <trade-offs>`), `Recommendation:` (the recommended option's label, then the reason), `Plan items:` and `Technical details:`. Put every blocker's text in plain words first; internal names go only under `Technical details:`. In `Plan items:` quote, in backticks and verbatim, the checklist items the decision settles, and add `[exclude]` to the option that drops them from the plan. An option that keeps the plan as written starts with "Keep the plan" or "Reject". Raise the decision once: do not file the same blocker again as a task-fixable blocker.

Narrowing: when a ticked checklist item was only partly done and the round's evidence says the rest does not apply: if you can check that yourself (open the file or symbol and show what it contains), file it in a `## Verified narrowing` block instead of a blocker, using the grammar in the scoring rubric; Ensemble records it as an excluded sub-item and no owner decision is needed. If you cannot check it, only the owner may narrow the item. File `- [completion] [environmental] Narrowing needs an owner decision: `<the checklist item text, verbatim, in backticks>` — <what was not done>` as the blocker, never `task-fixable` (a round may not narrow the plan, so sending it back to a round cannot clear it). A plan whose tick is disputed is not complete: keep the score below the ready threshold while the narrowing is undecided, otherwise the blocker will not raise the owner card.

Score the current implementation against the full approved plan. Explain any unchanged or lower score despite resolved findings, and keep newly discovered blockers separate from the previous blocker reconciliation.

Plans built across multiple implementation rounds. When the high-level review has already established that this plan is being delivered in an ordered, multi-round sequence (an "executable order", numbered phases, or a cohort structure), apply the same exception at this level: plan items not yet reached by that order are expected work, not defects in the code that landed: do not file them as separate blockers or mark the landed items down for their absence. They are still unbuilt, though: when you find plan items that are not built (as opposed to built but not ticked, which belong in `## Verified Complete`), file exactly ONE `- [completion] [task-fixable]` blocker that names them together, and the score follows the rubric's rule for an open blocker. A verdict or next-steps text that says plan items remain to be built, with no such blocker, contradicts itself, and Ensemble holds the stage instead of advancing on it. A landed item that is incomplete, defective, or deviates from the plan's contract is still a blocker regardless of how much of the plan remains; being mid-plan excuses only the ABSENCE of later items, never a defect in what was built.

Do not accept an unapproved substitute merely because it is plausible or
locally safer. When code materially changes an explicit plan contract or
acceptance criterion, report the required behavior and actual behavior as a
completion blocker unless the task records user approval. Implementation notes
do not constitute that approval.

The plan of record may declare certain residual issues out of scope in an "## Accepted Non-Goals" section, reproduced below alongside any standing owner decisions — both are binding inputs to this review, not incidental prose. Do not re-raise a prior blocker whose subject is covered by an Accepted Non-Goals entry or a recorded owner decision, even if it was `[same:…]`/unresolved in the previous round; that question is already settled and is not this review's to reconsider. If you believe an entry is wrong or no longer applies, say so explicitly — name the entry and why — rather than silently repeating the same blocker with no acknowledgement that a decision already covers it.

Begin your response with a readiness score on its own line in this exact format:
Readiness: N/10

{{reviewScoringRubric}}

Item identity: name each plan item in `## Verified Complete` by the `[item:<id>]` Ensemble lists for it (two items can share wording, so the id says which one you mean). Text alone counts only when it matches exactly one item, and an id Ensemble did not issue records nothing.



Owner hand-offs: an excluded five-element owner check (What/Why/How/Failure/Priority), or an item marked `Verified by Publish Checks`, is an intentional hand-off. If it is still pending, list it in the verdict as owed by the owner; do not file a blocker just because installation or Publish Checks has not happened yet. This exception applies only to those owner hand-offs. An exclusion that hides unfinished round work remains a completion blocker.

The final response must be the review itself and begin with the required `Readiness: N/10` line; do not return a summary of the investigation instead of the review.

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
- Owner decisions needed (if any blocker only the owner can settle, under `## Owner decisions needed`).
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

## Previous Low-Level Implementation Review

{{previousReview}}

## Previous Round's Blockers (for lineage citation)

{{priorBlockerLineageList}}

## Final Plan

{{plan}}

## Accepted Non-Goals

{{acceptedNonGoals}}

## Owner Decisions

{{ownerDecisions}}

## Current Implementation Notes

{{implementation}}
