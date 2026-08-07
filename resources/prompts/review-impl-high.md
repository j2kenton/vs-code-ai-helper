You are performing a HIGH-LEVEL review of the implementation of a software engineering task, checking the actual code against the final plan and the implementation notes below (a checklist or a summary of what was done, depending on how plan-final.md was produced).

The context pack below contains the implementation review files for this task. When the task was run with the AI implementation command, these are the files that were changed by the AI; when the task was implemented manually (or before file tracking was introduced), the context pack falls back to the files open in the editor at review time — in that case the pack will say so explicitly. Treat the files in the context pack as the implementation under review, not the implementation notes — if a plan item cannot be assessed from the provided files, say so explicitly rather than guessing.

Assess at the architectural level: is the implementation following the plan's approach, are the major pieces present, is anything built that the plan didn't call for?

Assess the current implementation against the full approved plan, not merely the subset attempted in the implementation notes. A required plan area or acceptance criterion that was silently dropped, quietly reduced, or unilaterally deferred is a completion blocker even when the partial code does not contradict the architecture. Work that is simply not yet reached in a plan being built over several rounds is different — that is reported through the progress marker below, not as a blocker.

Plans built across multiple implementation rounds. A plan larger than one implementation round can deliver is normal, not a problem — implementation works through it a batch at a time, and this review is what drives that loop forward. Report completeness as its own signal, and let the score speak only to the QUALITY of what has been built so far:
- Steps not yet reached are expected work, not completion blockers, and must not hold the score down. Score what exists: if every landed step is correct, in order, and verified, that is a high score even when most of the plan is still ahead.
- A landed step that is incorrect, unsafe, unverified, taken out of order, or deviating from the plan's contract is still a blocker and must hold the score down as usual. Being mid-plan excuses only the ABSENCE of later work — never a defect in, or wrong ordering of, what was built.
- Emit the machine-readable progress marker described below on its own line. This — not the score — is what tells the workflow whether to keep implementing or to move on.
- In the summary verdict, describe a plan progressing correctly and in order as on track (naming the step count, e.g. "on track — 6 of 18 ordered steps complete"), not "off track", even while much of the plan remains to be built. Reserve "off track" for genuine trouble: out-of-order or skipped foundational steps, defects, or deviation from the plan's contract. An "off track" verdict must name the actual cause inline, in the same sentence, not merely report the step count — e.g. "Off track — trust-boundary defect in workflowRuntimeServicesV1; 7 of 18 ordered steps complete in order." Steps completing in order is the healthy fact about a staged plan; naming only the step count in an "off track" verdict reads as self-contradictory and buries the real reason further down the response.
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
