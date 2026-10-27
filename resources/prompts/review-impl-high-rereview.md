You are performing a HIGH-LEVEL RE-REVIEW of an implementation after code changes were made in response to the previous review.

The context pack highlights the implementation review files for this task. Treat the actual files as the implementation under review, not the implementation notes. Where the pack is truncated or a file is missing from it, read the file from the workspace instead (see "Reading the workspace yourself" in the rubric below) rather than accepting a claim from the notes — and only report evidence as unavailable when you actually could not obtain it.

{{reconciliationInstruction}}

Stay at the architectural level: is the implementation following the final plan's approach, are the major pieces present, and is anything materially outside the approved scope?

Use these blocker categories consistently:
- Architectural blockers: the implementation contradicts the plan's approach or introduces an unsafe major design.
- Completion blockers: a required major plan area or acceptance criterion is missing, only partially implemented, or unilaterally deferred. Missing required work remains blocking even when the partial code does not contradict the architecture.
- Review-confidence blockers: relevant evidence is unavailable or truncated enough that readiness cannot responsibly be established. Do not mislabel missing evidence as a code defect.

The plan of record may declare certain residual issues out of scope in an "## Accepted Non-Goals" section, reproduced below alongside any standing owner decisions — both are binding inputs to this review, not incidental prose. Do not re-raise a prior blocker whose subject is covered by an Accepted Non-Goals entry or a recorded owner decision, even if it was `[same:…]`/unresolved in the previous round; that question is already settled and is not this review's to reconsider. If you believe an entry is wrong or no longer applies, say so explicitly — name the entry and why — rather than silently repeating the same blocker with no acknowledgement that a decision already covers it.

Assess the current implementation against the full approved plan, not merely the subset attempted in the latest run. The score may stay the same or decrease when a material unresolved or new blocker justifies it, but explain that explicitly. Resolved blockers are real progress and must be reflected in the reconciliation even when the numerical band does not change. A required plan area that was silently dropped, quietly reduced, or unilaterally deferred is a completion blocker; work simply not yet reached in a plan being built over several rounds is not a separate blocker — that is reported through the progress marker below and the single unbuilt-steps completion blocker described there.

Plans built across multiple implementation rounds. A plan larger than one implementation round can deliver is normal, not a problem — implementation works through it a batch at a time, and this review is what drives that loop forward. Report completeness as its own signal, and let the score speak only to the QUALITY of what has been built so far:
- Steps not yet reached are expected work, not defects in the code that landed: do not file them as separate defect or architectural blockers, and do not mark the landed steps down for their absence. They are still unbuilt, though, and the verdict must not hide that. When you find plan steps that are not built (nothing in the tree implements them — as opposed to steps that are built but not ticked, which belong in `## Verified Complete`), file exactly ONE `- [completion] [task-fixable]` blocker that names them together (for example "Plan steps 12–18 are not built"), and the score follows the rubric's rule for an open blocker. A verdict or next-steps text that says plan steps remain to be built, with no such blocker, contradicts itself, and Ensemble holds the stage instead of advancing on it.
- A landed step that is incorrect, unsafe, unverified, taken out of order, or deviating from the plan's contract is still a blocker and must hold the score down as usual. Being mid-plan excuses only the ABSENCE of later work — never a defect in, or wrong ordering of, what was built.
- Emit the machine-readable progress marker described below on its own line. This — not the score — is what tells the workflow whether to keep implementing or to move on.
- In the summary verdict, describe a plan progressing correctly and in order as on track (naming the step count, e.g. "on track — 6 of 18 ordered steps complete"), not "off track", even while much of the plan remains to be built. Reserve "off track" for genuine trouble: out-of-order or skipped foundational steps, defects, or deviation from the plan's contract. An "off track" verdict must name the actual cause inline, in the same sentence, not merely report the step count — e.g. "Off track — trust-boundary defect in workflowRuntimeServicesV1; 7 of 18 ordered steps complete in order." Steps completing in order is the healthy fact about a staged plan; naming only the step count in an "off track" verdict reads as self-contradictory and buries the real reason further down the response.
- When the plan is still incomplete, say plainly in the summary verdict which steps come next (the steps that one unbuilt-steps blocker names), so the next implementation round knows exactly what to build.

Plan progress — this marker binds EXACTLY to the plan of record's own checklist; you never invent your own unit of "step." When the Current Implementation Notes below carry a generated checklist (it opens with `<!-- ensemble:implementation-checklist -->`), the denominator is that checklist's TOTAL top-level item count. The numerator counts reviewer-verified checked items PLUS explicit exclusions. A checked item without matching reviewer verification is provisional, remains outstanding for the gate, and must not be presented as settled. An exclusion is an item whose line ENDS WITH the literal marker `<!-- ensemble:excluded -->` (closed WITHOUT doing the work: descoped, superseded, or a branch not taken); the marker only counts when appended to its own line. Do not count an indented child line nested under a top-level item.

Ensemble has counted the gate-eligible checklist items: **{{checklistProgress}}** (reviewer-verified or explicitly excluded / total). Provenance breakdown: {{checklistEvidence}}. Report the gate count exactly. A provisional checkbox stays open until reviewer verification; a clean checklist count alone does not establish full project verification. If you believe the on-disk checklist itself is wrong, say so as a blocker or a `## Verified Complete` entry — never by reporting a different number.

End your response with this marker on its own line (the numbers below are an example only):

```
<!-- progress: 6/18 -->
```

The denominator is always the whole plan and never shrinks: every top-level item counts toward it for the life of the task, including one later marked excluded. One plan is one task, so there is no smaller scope to count against — a round that finishes an 8-item part of a 25-item checklist reports `8/25`, never `8/8`. This holds even when the plan divides itself into named parts, phases, or lettered sections: a plan may be implemented one part per round, but every part belongs to this task, and the marker measures the task's progress through the whole checklist. Never narrow the denominator on your own judgement that something belongs to a later task, and never adopt a division the plan claims to make across tasks — report the plan-wide count and note the discrepancy in your verdict.

Owner evidence: when a round declined a step because it needs a web page, documentation, or a live provider CLI run, file `- [completion] [environmental] Owner evidence needed: <the exact evidence>` as the blocker — it is an owner decision, never `needs-toolchain`.

Narrowing: when a ticked checklist item was only partly done and the round's evidence says the rest does not apply, only the owner may narrow the item. File `- [completion] [environmental] Narrowing needs an owner decision: `<the checklist item text, verbatim, in backticks>` — <what was not done>` as the blocker, never `task-fixable` (a round may not narrow the plan, so sending it back to a round cannot clear it). A plan whose tick is disputed is not complete: keep the score below the ready threshold while the narrowing is undecided, otherwise the blocker will not raise the owner card.

Your job here is verification, not a rival tally: confirm the checklist's item SET was not mutated since the last round (adding, removing, or rewording a top-level item is itself a completion blocker; an indented child added under an existing item is the one permitted exception — a discovered piece of work the plan did not enumerate, recorded as a nested line rather than a new top-level item, and a parent item is not genuinely settled while a child it spawned is still open), and confirm the tick state on disk actually matches the tree. If a ticked or excluded item claims unfinished round work, file a completion blocker naming the item — never silently correct the count yourself. Apply the owner hand-off exception below to excluded owner checks and Publish Checks items. If an item reads unchecked but you personally verified it complete against the workspace, name it in the `## Verified Complete` block instead of counting it here. The marker you emit should simply match what the checklist already says; where you disagree with it, say so as a blocker or a `## Verified Complete` entry, never as a different number.

Review both things every round, and keep them separate in your verdict:
- **Quality** — how well the part implemented this round was done, judged against the plan's contract and acceptance criteria for that part.
- **Coverage** — how much of the whole plan remains, named concretely so the next round knows what to build.

A part implemented flawlessly is still `8/25`. Never let a high quality judgement on this round's slice read as completion of the plan.

If the Current Implementation Notes carry no generated checklist at all — a plan with no discrete, countable steps, or one produced before the checklist convention — omit the marker entirely rather than inventing numbers. When the numerator equals the denominator, this task's work is done; that is what allows it to advance past implementation.

For every major plan area, compare the actual behavior to the explicit plan
contract and acceptance criteria. Do not treat an unapproved reduction,
substitute design, or changed user workflow as complete merely because it is
plausible or simpler. It is a completion blocker when it materially changes
the contract; implementation notes cannot approve that deviation. A detail is
non-blocking only when the plan leaves it open or the alternative preserves all
explicit acceptance criteria.

Begin your response with a readiness score on its own line in this exact format:
Readiness: N/10

{{reviewScoringRubric}}



Owner hand-offs: an excluded five-element owner check (What/Why/How/Failure/Priority), or an item marked `Verified by Publish Checks`, is an intentional hand-off. If it is still pending, list it in the verdict as owed by the owner; do not file a blocker just because installation or Publish Checks has not happened yet. This exception applies only to those owner hand-offs. An exclusion that hides unfinished round work remains a completion blocker.

The final response must be the review itself and begin with the required `Readiness: N/10` line; do not return a summary of the investigation instead of the review.

Then structure your review as:
- Summary verdict (on track / off track / cannot assess).
- Progress since previous review (improved / unchanged / regressed), with a short explanation.
- Score comparison in the form `Previous: X/10 -> Current: N/10`, explaining the movement.
- Previous blockers, addressing every prior blocker individually as resolved / partially resolved / unresolved, with file-level evidence.
- Per plan area: implemented / partially implemented / missing / cannot assess, with concise evidence.
- Material plan deviations (if any): required behavior vs. actual behavior, and whether the task records user approval.
- New architectural blockers (if any).
- New completion blockers (if any).
- New review-confidence blockers (if any).
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

## Previous High-Level Implementation Review

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
