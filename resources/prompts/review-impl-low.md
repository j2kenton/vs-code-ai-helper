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

Keeping a departure: when you recommend keeping a round's departure from the approved plan (any option other than "Keep the plan"), check the reason instead of repeating it. Name the file and line (`path/file.ts:123`) that shows the dependency or harm the round claims, and say what the kept behaviour actually does at this stage. A reason you only took from the round's own report ("the implementation says …") is the round's claim, unchecked: mark it that way, and it cannot on its own make that option Recommended. If you cannot check the reason, the recommendation is "Keep the plan", since the owner already approved the plan. Where the round had a real point, say on the card how to keep that point within the plan.

A blocker raised twice: when a blocker has been raised in two reviews (its lineage is `[same:…]` or `[narrowed:…]` after fixes that each changed files), the likely cause is a rule the plan never stated. Propose that rule in an `## Owner decisions needed` block with options, so the owner can settle it. When task.md's `## Owner decisions` records a rule for a blocker, treat that rule as the specification for that blocker and judge the fix against it, not against your own reading.

Narrowing: when a ticked checklist item was only partly done and the round's evidence says the rest does not apply: if you can check that yourself (open the file or symbol and show what it contains), file it in a `## Verified narrowing` block instead of a blocker, using the grammar in the scoring rubric; Ensemble records it as an excluded sub-item and no owner decision is needed. If you cannot check it, only the owner may narrow the item. File `- [completion] [environmental] Narrowing needs an owner decision: `<the checklist item text, verbatim, in backticks>` — <what was not done>` as the blocker, never `task-fixable` (a round may not narrow the plan, so sending it back to a round cannot clear it). A plan whose tick is disputed is not complete: keep the score below the ready threshold while the narrowing is undecided, otherwise the blocker will not raise the owner card.



Owner hand-offs: an excluded five-element owner check (What/Why/How/Failure/Priority), or an item marked `Verified by Publish Checks`, is an intentional hand-off. If it is still pending, list it in the verdict as owed by the owner; do not file a blocker just because installation or Publish Checks has not happened yet. This exception applies only to those owner hand-offs. An exclusion that hides unfinished round work remains a completion blocker.

The final response must be the review itself and begin with the required `Readiness: N/10` line; do not return a summary of the investigation instead of the review.

Structure your review as:

Begin your response with a readiness score on its own line in this exact format:
Readiness: N/10

{{reviewScoringRubric}}

Item identity: name each plan item in `## Verified Complete` by the `[item:<id>]` Ensemble lists for it (two items can share wording, so the id says which one you mean). Text alone counts only when it matches exactly one item, and an id Ensemble did not issue records nothing.

- Summary verdict (ready to complete / needs changes / cannot fully assess).
- Per plan item: done / incomplete / defective / cannot assess, with file-level evidence for each judgment.
- Material plan deviations (if any): required behavior vs. actual behavior, and whether the task records user approval.
- Defect blockers (if any), each with the file, the problem, and a concrete failure scenario.
- Completion blockers (if any).
- Review-confidence blockers (if any).
- Owner decisions needed (if any blocker only the owner can settle, under `## Owner decisions needed`).
- Files not fully inspected: always include a `## Files not fully inspected` heading. Under it, list as one bullet per file (the workspace path in backticks) every changed file in your scope that you did not read in full (skimmed, sampled or could not open), or write `none`. Ensemble counts only the files you do not list as reviewed. Write this list from this review alone; never copy one from an earlier review.
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
