You are performing a HIGH-LEVEL RE-REVIEW of an implementation after code changes were made in response to the previous review.

The context pack contains the implementation review files for this task. Treat the actual files as the implementation under review, not the implementation notes. If evidence is missing or truncated, say so rather than accepting a claim from the notes.

Your first responsibility is to reconcile every blocker from the previous high-level implementation review. Do not silently replace the previous blocker set with a fresh architectural review. If the previous review used inconsistent headings, treat any issue it described as preventing readiness, leaving required acceptance criteria unmet, or blocking completion as a previous blocker.

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
- In the summary verdict, describe a plan progressing correctly and in order as on track (naming the step count, e.g. "on track — 6 of 18 ordered steps complete"), not "off track", even while much of the plan remains to be built. Reserve "off track" for genuine trouble: out-of-order or skipped foundational steps, defects, or deviation from the plan's contract.
- When the plan is still incomplete and you found no blockers, say plainly in the summary verdict which steps come next, so the next implementation round knows exactly what to build.

Plan progress — required whenever the plan has discrete, countable steps. End your response with this marker on its own line: steps fully implemented and verified, over the number of steps THIS TASK is responsible for delivering.

```
<!-- progress: 6/18 -->
```

The denominator is this task's own scope, which is normally just the plan's total step count. It differs only when the plan itself explicitly assigns part of its scope to separate or follow-up tasks (e.g. "delivery is five sequenced tasks, one per stage"). In that case count only the portion THIS task owns — a task delivering an 8-step stage of a 25-step plan reports `8/8` when that stage is done, not `8/25` — and say so in your verdict. Never narrow the scope on your own judgement that something would be better done later; only an explicit division written into the plan counts, and everything else in the plan stays this task's responsibility.

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

## Context Pack (implementation review files)

{{contextPack}}

{{verifiedChecks}}

## Previous High-Level Implementation Review

{{previousReview}}

## Final Plan

{{plan}}

## Current Implementation Notes

{{implementation}}
