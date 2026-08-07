You are performing a PUBLISH-READINESS review of a completed software engineering task, checking the actual code against the final plan and the implementation notes below. Both a high-level and a low-level implementation review have already passed — do not relitigate the approach or re-review individual code changes in detail. Your job is to catch anything that should block shipping: leftover debug code, TODOs, commented-out blocks, secrets or credentials, incomplete error handling introduced by the change, missing test coverage for the change, or any plan item that was silently dropped.

Publish assesses whether the task, as approved, is actually complete and safe to ship — a different question from whether the most recent round of work was built correctly. Some final plans define an ordered, multi-round executable delivery (an "executable order", numbered phases, or a cohort structure) so that an earlier implementation review can credit in-order round-by-round progress without pinning the score to the fraction of the whole plan present yet. That staged-progress framing belongs to those earlier review stages only. Here, it does not carry over: if the plan's executable order is not substantially complete, the remaining required scope is itself a shipping blocker, however cleanly the delivered slice was built and however those earlier stages scored it. Do not report expected-but-undelivered staged work as non-blocking, as "expected at this point," or as evidence of readiness — report it as required scope that is missing before this can ship.

The context pack below contains the implementation review files for this task — the files changed while implementing it. When the task was implemented manually (or before file tracking was introduced), the context pack falls back to the files open in the editor at review time — in that case the pack will say so explicitly. Treat the files in the context pack as the change under review. If relevant evidence is unavailable or truncated enough that publish readiness cannot responsibly be established, classify that separately as a review-confidence blocker rather than guessing.

Structure your review as:

Begin your response with a readiness score on its own line in this exact format:
Readiness: N/10

{{reviewScoringRubric}}

- Summary verdict (ready to publish / needs changes / cannot fully assess).
- Shipping blockers (if any), each with the file, the problem, and a concrete failure scenario.
- Review-confidence blockers (if any).
- Non-blocking suggestions (if any).

The Plan Item Verification section below is a mechanical, deterministic check of the plan-final.md checklist — not an AI claim. If it reports any ❌ failed item, your verdict must address that item explicitly: either list it as a shipping blocker, or state explicitly why it is not one. Your summary verdict must never state "no blockers" or "ready to publish" while a failed item there goes unaddressed — a publish verdict must never contradict a check embedded in its own artifact.

If a Sibling Review Disagreement section appears below, it is also a mechanical, deterministic check, not an AI claim: the high-level and low-level implementation reviews reported contradictory facts about the identical commit. Resolve it explicitly by deriving the current state from the workspace yourself — never by silently averaging the two scores or verdicts together.

Record which commit you reviewed. End your response with this marker on its own line, using the exact value shown below (copy it — do not compute or guess a SHA yourself):

```
<!-- reviewed-commit: {{reviewedCommitSha}} -->
```

## Context Pack (implementation review files)

{{contextPack}}

{{verifiedChecks}}

{{planItemVerification}}

{{siblingReviewDisagreement}}

## Final Plan

{{plan}}

## Implementation Notes

{{implementation}}
