You are performing a HIGH-LEVEL review of the implementation of a software engineering task, checking the actual code against the final plan and the implementation notes below (a checklist or a summary of what was done, depending on how plan-final.md was produced).

The context pack below contains the implementation review files for this task. When the task was run with the AI implementation command, these are the files that were changed by the AI; when the task was implemented manually (or before file tracking was introduced), the context pack falls back to the files open in the editor at review time — in that case the pack will say so explicitly. Treat the actual files as the implementation under review, not the implementation notes. If a plan item cannot be assessed from the pack alone, read the file from the workspace and assess it (see "Reading the workspace yourself" in the rubric below) — never guess, and only say a plan item could not be assessed when you actually tried and could not.

Assess at the architectural level: is the implementation following the plan's approach, are the major pieces present, is anything built that the plan didn't call for?

Assess the current implementation against the full approved plan, not merely the subset attempted in the implementation notes. A required plan area or acceptance criterion that was silently dropped, quietly reduced, or unilaterally deferred is a completion blocker even when the partial code does not contradict the architecture. Work that is simply not yet reached in a plan being built over several rounds is different — that is reported through the progress marker below, not as a blocker.

Plans built across multiple implementation rounds. A plan larger than one implementation round can deliver is normal, not a problem — implementation works through it a batch at a time, and this review is what drives that loop forward. Report completeness as its own signal, and let the score speak only to the QUALITY of what has been built so far:
- Steps not yet reached are expected work, not completion blockers, and must not hold the score down. Score what exists: if every landed step is correct, in order, and verified, that is a high score even when most of the plan is still ahead.
- A landed step that is incorrect, unsafe, unverified, taken out of order, or deviating from the plan's contract is still a blocker and must hold the score down as usual. Being mid-plan excuses only the ABSENCE of later work — never a defect in, or wrong ordering of, what was built.
- Emit the machine-readable progress marker described below on its own line. This — not the score — is what tells the workflow whether to keep implementing or to move on.
- In the summary verdict, describe a plan progressing correctly and in order as on track (naming the step count, e.g. "on track — 6 of 18 ordered steps complete"), not "off track", even while much of the plan remains to be built. Reserve "off track" for genuine trouble: out-of-order or skipped foundational steps, defects, or deviation from the plan's contract. An "off track" verdict must name the actual cause inline, in the same sentence, not merely report the step count — e.g. "Off track — trust-boundary defect in workflowRuntimeServicesV1; 7 of 18 ordered steps complete in order." Steps completing in order is the healthy fact about a staged plan; naming only the step count in an "off track" verdict reads as self-contradictory and buries the real reason further down the response.
- When the plan is still incomplete and you found no blockers, say plainly in the summary verdict which steps come next, so the next implementation round knows exactly what to build.

Plan progress — this marker binds EXACTLY to the plan of record's own checklist; you never invent your own unit of "step." When the Implementation Notes below carry a generated checklist (it opens with `<!-- ensemble:implementation-checklist -->`), the denominator is that checklist's TOTAL top-level item count and the numerator is however many of those top-level items are settled — ticked `- [x]`, PLUS any item carrying `<!-- ensemble:excluded -->` (closed WITHOUT doing the work: descoped, superseded, or a branch not taken). Count directly from the checklist exactly as written on disk; do not re-group, re-derive, or narrow it from prose, and do not count an indented child line nested under a top-level item — those are discovered sub-work the implementation records outside this denominator (see below) and never move it.

End your response with this marker on its own line:

```
<!-- progress: 6/18 -->
```

The denominator is always the whole plan and never shrinks: every top-level item counts toward it for the life of the task, including one later marked excluded. One plan is one task, so there is no smaller scope to count against — a round that finishes an 8-item part of a 25-item checklist reports `8/25`, never `8/8`. This holds even when the plan divides itself into named parts, phases, or lettered sections: a plan may be implemented one part per round, but every part belongs to this task, and the marker measures the task's progress through the whole checklist. Never narrow the denominator on your own judgement that something belongs to a later task, and never adopt a division the plan claims to make across tasks — report the plan-wide count and note the discrepancy in your verdict.

Your job here is verification, not a rival tally: confirm the checklist's item SET was not mutated since the last round (adding, removing, or rewording a top-level item is itself a completion blocker; an indented child added under an existing item is the one permitted exception — a discovered piece of work the plan did not enumerate, recorded as a nested line rather than a new top-level item, and a parent item is not genuinely settled while a child it spawned is still open), and confirm the tick state on disk actually matches the tree. If an item reads ticked or excluded but is not actually done, file that as a completion blocker naming the item — never silently correct the count yourself. If an item reads unchecked but you personally verified it complete against the workspace, name it in the `## Verified Complete` block instead of counting it here. The marker you emit should simply match what the checklist already says; where you disagree with it, say so as a blocker or a `## Verified Complete` entry, never as a different number.

Review both things every round, and keep them separate in your verdict:
- **Quality** — how well the part implemented this round was done, judged against the plan's contract and acceptance criteria for that part.
- **Coverage** — how much of the whole plan remains, named concretely so the next round knows what to build.

A part implemented flawlessly is still `8/25`. Never let a high quality judgement on this round's slice read as completion of the plan.

If the Implementation Notes carry no generated checklist at all — a plan with no discrete, countable steps, or one produced before the checklist convention — omit the marker entirely rather than inventing numbers. When the numerator equals the denominator, this task's work is done; that is what allows it to advance past implementation.

For every major plan area, compare the actual behavior to the explicit plan
contract and acceptance criteria. Do not treat an unapproved reduction,
substitute design, or changed user workflow as complete merely because it is
plausible or simpler. It is a completion blocker when it materially changes
the contract; implementation notes cannot approve that deviation. A detail is
non-blocking only when the plan leaves it open or the alternative preserves all
explicit acceptance criteria.

Distinguish:
- Architectural blockers: the implementation contradicts the plan's approach or introduces an unsafe major design.
- Completion blockers: required major work or acceptance criteria remain incomplete.
- Review-confidence blockers: relevant evidence is unavailable or truncated enough that readiness cannot responsibly be established.

The plan of record may declare certain residual issues out of scope in an "## Accepted Non-Goals" section, reproduced below alongside any standing owner decisions — both are binding inputs to this review, not incidental prose. Do not report a blocker whose subject is covered by an Accepted Non-Goals entry or a recorded owner decision; those questions are already settled and are not this review's to reconsider. If you believe an entry is wrong or no longer applies, say so explicitly in your verdict — name the entry and why — rather than silently re-raising the same blocker with no acknowledgement that a decision already covers it.

Structure your review as:

Begin your response with a readiness score on its own line in this exact format:
Readiness: N/10

{{reviewScoringRubric}}

- Summary verdict (on track / off track / cannot assess).
- Per plan area: implemented / partially implemented / missing / cannot assess, with one line of evidence each (file + what you saw).
- Material plan deviations (if any): required behavior vs. actual behavior, and whether the task records user approval.
- Architectural blockers (if any).
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

## Accepted Non-Goals

{{acceptedNonGoals}}

## Owner Decisions

{{ownerDecisions}}

## Implementation Notes

{{implementation}}
