You are performing a HIGH-LEVEL review of the implementation of a software engineering task, checking the actual code against the final plan and the implementation notes below (a checklist or a summary of what was done, depending on how plan-final.md was produced).

The context pack below contains the implementation review files for this task. When the task was run with the AI implementation command, these are the files that were changed by the AI; when the task was implemented manually (or before file tracking was introduced), the context pack falls back to the files open in the editor at review time — in that case the pack will say so explicitly. Treat the files in the context pack as the implementation under review, not the implementation notes — if a plan item cannot be assessed from the provided files, say so explicitly rather than guessing.

Assess at the architectural level: is the implementation following the plan's approach, are the major pieces present, is anything built that the plan didn't call for?

Score the current implementation against the full approved plan, not merely the subset attempted in the implementation notes. A required major plan area or acceptance criterion that is missing, partially implemented, or unilaterally deferred is a completion blocker even when the partial code does not contradict the architecture.

Exception — staged plans built incrementally. Some final plans explicitly define an ordered, multi-round delivery sequence — an "executable order", numbered phases, or a cohort structure — intended to be implemented across several implementation rounds rather than all at once. When (and only when) the plan is structured this way, score the readiness of that staged delivery instead of the raw fraction of the whole plan present today:
- Steps the executable order places later than the work landed so far are expected, not-yet-reached work, not completion blockers. Do not pin the score low merely because later-ordered steps are still absent; instead state how far the order has progressed (e.g. "N of M ordered steps complete, in order").
- Let the score track genuine progress along the order: it rises as each in-order step lands correctly and verified, sitting in the mid-band while the order is only partway done.
- Express the score to one decimal place (e.g. `Readiness: 3.1/10`) so a single round's progress is visible instead of rounding away. Keep the whole-number part aligned to the rubric band and let the decimal reflect how far through the executable order you are (roughly steps-complete ÷ steps-total). A round that lands another in-order step correctly should raise the decimal even when the band is unchanged; only a real defect, regression, or out-of-order work should lower it.
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

Distinguish:
- Architectural blockers: the implementation contradicts the plan's approach or introduces an unsafe major design.
- Completion blockers: required major work or acceptance criteria remain incomplete.
- Review-confidence blockers: relevant evidence is unavailable or truncated enough that readiness cannot responsibly be established.

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

## Context Pack (implementation review files)

{{contextPack}}

{{verifiedChecks}}

## Final Plan

{{plan}}

## Implementation Notes

{{implementation}}
