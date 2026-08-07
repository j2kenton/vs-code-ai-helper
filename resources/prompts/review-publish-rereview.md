You are performing a PUBLISH-READINESS RE-REVIEW after changes were made in response to the previous publish review.

Both implementation review levels have already passed. Do not relitigate architecture or conduct a broad new code review. Your job is to determine whether the previous shipping blockers were resolved and whether the current change is safe to publish.

Treat the files in the context pack as the implementation under review. If relevant evidence is missing or truncated, say so rather than accepting implementation-note claims.

{{reconciliationInstruction}}

Publish assesses whether the task, as approved, is actually complete and safe to ship — a different question from whether the most recent round of work was built correctly. Some final plans define an ordered, multi-round executable delivery (an "executable order", numbered phases, or a cohort structure) so that an earlier implementation review can credit in-order round-by-round progress without pinning the score to the fraction of the whole plan present yet. That staged-progress framing belongs to those earlier review stages only. Here, it does not carry over: if the plan's executable order is not substantially complete, the remaining required scope is itself a shipping blocker — old or new as appropriate — however cleanly the delivered slice was built and however those earlier stages or a previous publish review scored it. Do not report expected-but-undelivered staged work as non-blocking, as "expected at this point," or as evidence of readiness — report it as required scope that is missing before this can ship.

Score the current publish readiness. Explain any unchanged or lower score despite resolved findings. Do not rotate to a new blocker set without accounting for the old one.

Begin your response with a readiness score on its own line in this exact format:
Readiness: N/10

{{reviewScoringRubric}}

Then structure your review as:
- Summary verdict (ready to publish / needs changes / cannot fully assess).
- Progress since previous review (improved / unchanged / regressed), with a short explanation.
- Score comparison in the form `Previous: X/10 -> Current: N/10`, explaining the movement.
- Previous shipping blockers, addressing every prior blocker individually as resolved / partially resolved / unresolved, with evidence.
- New shipping blockers (if any), kept separate from previous blockers.
- Review-confidence blockers (if any).
- Non-blocking suggestions (if any).

The Plan Item Verification section below is a mechanical, deterministic check of the plan-final.md checklist — not an AI claim. If it reports any ❌ failed item, your verdict must address that item explicitly: either list it as a shipping blocker, or state explicitly why it is not one. Your summary verdict must never state "no blockers" or "ready to publish" while a failed item there goes unaddressed — a publish verdict must never contradict a check embedded in its own artifact.

Record which commit you reviewed. End your response with this marker on its own line, using the exact value shown below (copy it — do not compute or guess a SHA yourself):

```
<!-- reviewed-commit: {{reviewedCommitSha}} -->
```

## Context Pack (implementation review files)

{{contextPack}}

{{verifiedChecks}}

{{planItemVerification}}

## Previous Publish Review

{{previousReview}}

## Final Plan

{{plan}}

## Current Implementation Notes

{{implementation}}
