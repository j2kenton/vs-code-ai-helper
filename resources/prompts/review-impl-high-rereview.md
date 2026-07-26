You are performing a HIGH-LEVEL RE-REVIEW of an implementation after code changes were made in response to the previous review.

The context pack contains the implementation review files for this task. Treat the actual files as the implementation under review, not the implementation notes. If evidence is missing or truncated, say so rather than accepting a claim from the notes.

Your first responsibility is to reconcile every blocker from the previous high-level implementation review. Do not silently replace the previous blocker set with a fresh architectural review. If the previous review used inconsistent headings, treat any issue it described as preventing readiness, leaving required acceptance criteria unmet, or blocking completion as a previous blocker.

Stay at the architectural level: is the implementation following the final plan's approach, are the major pieces present, and is anything materially outside the approved scope?

Use these blocker categories consistently:
- Architectural blockers: the implementation contradicts the plan's approach or introduces an unsafe major design.
- Completion blockers: a required major plan area or acceptance criterion is missing, only partially implemented, or unilaterally deferred. Missing required work remains blocking even when the partial code does not contradict the architecture.
- Review-confidence blockers: relevant evidence is unavailable or truncated enough that readiness cannot responsibly be established. Do not mislabel missing evidence as a code defect.

Score the current implementation against the full approved plan, not merely the subset attempted in the latest run. The score may stay the same or decrease when a material unresolved or new blocker justifies it, but explain that explicitly. Resolved blockers are real progress and must be reflected in the reconciliation even when the numerical band does not change.

Exception — staged plans built incrementally. Some final plans explicitly define an ordered, multi-round delivery sequence — an "executable order", numbered phases, or a cohort structure — intended to be implemented across several implementation rounds rather than all at once. When (and only when) the plan is structured this way, score the readiness of that staged delivery instead of the raw fraction of the whole plan present today:
- Steps the executable order places later than the work landed so far are expected, not-yet-reached work, not completion blockers. Do not pin the score low merely because later-ordered steps are still absent; instead state how far the order has progressed (e.g. "N of M ordered steps complete, in order") and let the score climb across rounds as each in-order step lands correctly and verified.
- Express the score to one decimal place (e.g. `Readiness: 3.1/10`) so this round's progress since the previous review is visible instead of rounding away. Keep the whole-number part aligned to the rubric band and let the decimal reflect how far through the executable order you are (roughly steps-complete ÷ steps-total). Landing another in-order step correctly should raise the decimal even when the band is unchanged, and your `Previous: X/10 -> Current: N/10` line should show that movement; only a real defect, regression, or out-of-order work should lower it.
- A landed step that is incorrect, unsafe, unverified, taken out of order, or deviating from the plan's contract is still a blocker and must hold the score down as usual. Incremental delivery excuses only the absence of later-ordered work — never a defect in, or wrong ordering of, what was built.
- Reserve a ready-to-proceed score for when the executable order is essentially complete; a plan still early in its order, however clean so far, is iterating, not ready.
- In the summary verdict, describe a staged plan that is progressing correctly and in order as on track (naming the step count, e.g. "on track — 6 of 18 ordered steps complete"), not "off track", even while much of the plan remains to be built. Reserve "off track" for genuine trouble: out-of-order or skipped foundational steps, defects, or deviation from the plan's contract.

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
