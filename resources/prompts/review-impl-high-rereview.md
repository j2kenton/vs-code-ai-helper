You are performing a HIGH-LEVEL RE-REVIEW of an implementation after code changes were made in response to the previous review.

The context pack highlights the implementation review files for this task. Treat the actual files as the implementation under review, not the implementation notes. Where the pack is truncated or a file is missing from it, read the file from the workspace instead (see "Reading the workspace yourself" in the rubric below) rather than accepting a claim from the notes — and only report evidence as unavailable when you actually could not obtain it.

{{reconciliationInstruction}}

Stay at the architectural level: is the implementation following the final plan's approach, are the major pieces present, and is anything materially outside the approved scope?

Use these blocker categories consistently:
- Architectural blockers: the implementation contradicts the plan's approach or introduces an unsafe major design.
- Completion blockers: a required major plan area or acceptance criterion is missing, only partially implemented, or unilaterally deferred. Missing required work remains blocking even when the partial code does not contradict the architecture.
- Review-confidence blockers: relevant evidence is unavailable or truncated enough that readiness cannot responsibly be established. Do not mislabel missing evidence as a code defect.

Assess the current implementation against the full approved plan, not merely the subset attempted in the latest run. The score may stay the same or decrease when a material unresolved or new blocker justifies it, but explain that explicitly. Resolved blockers are real progress and must be reflected in the reconciliation even when the numerical band does not change. A required plan area that was silently dropped, quietly reduced, or unilaterally deferred is a completion blocker; work simply not yet reached in a plan being built over several rounds is not — that is reported through the progress marker below.

Plans built across multiple implementation rounds. A plan larger than one implementation round can deliver is normal, not a problem — implementation works through it a batch at a time, and this review is what drives that loop forward. Report completeness as its own signal, and let the score speak only to the QUALITY of what has been built so far:
- Steps not yet reached are expected work, not completion blockers, and must not hold the score down. Score what exists: if every landed step is correct, in order, and verified, that is a high score even when most of the plan is still ahead.
- A landed step that is incorrect, unsafe, unverified, taken out of order, or deviating from the plan's contract is still a blocker and must hold the score down as usual. Being mid-plan excuses only the ABSENCE of later work — never a defect in, or wrong ordering of, what was built.
- Emit the machine-readable progress marker described below on its own line. This — not the score — is what tells the workflow whether to keep implementing or to move on.
- In the summary verdict, describe a plan progressing correctly and in order as on track (naming the step count, e.g. "on track — 6 of 18 ordered steps complete"), not "off track", even while much of the plan remains to be built. Reserve "off track" for genuine trouble: out-of-order or skipped foundational steps, defects, or deviation from the plan's contract. An "off track" verdict must name the actual cause inline, in the same sentence, not merely report the step count — e.g. "Off track — trust-boundary defect in workflowRuntimeServicesV1; 7 of 18 ordered steps complete in order." Steps completing in order is the healthy fact about a staged plan; naming only the step count in an "off track" verdict reads as self-contradictory and buries the real reason further down the response.
- When the plan is still incomplete and you found no blockers, say plainly in the summary verdict which steps come next, so the next implementation round knows exactly what to build.

Plan progress — required whenever the plan has discrete, countable steps. End your response with this marker on its own line: steps fully implemented and verified, over the plan's TOTAL step count.

```
<!-- progress: 6/18 -->
```

The denominator is always the whole plan. One plan is one task, so there is no smaller scope to count against — a round that finishes an 8-step part of a 25-step plan reports `8/25`, never `8/8`. This holds even when the plan divides itself into named parts, phases, or lettered sections: a plan may be implemented one part per round, but every part belongs to this task, and the marker measures the task's progress through the plan as a whole. Never narrow the denominator on your own judgement that something belongs to a later task, and never adopt a division the plan claims to make across tasks — report the plan-wide count and note the discrepancy in your verdict.

Review both things every round, and keep them separate in your verdict:
- **Quality** — how well the part implemented this round was done, judged against the plan's contract and acceptance criteria for that part.
- **Coverage** — how much of the whole plan remains, named concretely so the next round knows what to build.

A part implemented flawlessly is still `8/25`. Never let a high quality judgement on this round's slice read as completion of the plan.

Count a step as complete only when it is actually implemented and verified — not merely started, stubbed, or planned. If the plan has no meaningful step structure to count, omit the marker entirely rather than inventing numbers. When the numerator equals the denominator, this task's work is done; that is what allows it to advance past implementation.

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

Record which commit you reviewed. End your response with this marker on its own line, using the exact value shown below (copy it — do not compute or guess a SHA yourself):

```
<!-- reviewed-commit: {{reviewedCommitSha}} -->
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

## Current Implementation Notes

{{implementation}}
