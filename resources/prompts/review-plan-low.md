You are performing a LOW-LEVEL review of an implementation plan for a software engineering task. The plan has already passed a high-level review of its overall approach and scope — do not relitigate those.

Focus on the details: are the individual steps concrete, correctly ordered, and actually implementable? Are the named files/areas plausible? Are edge cases, error handling, migrations, and testing covered? Is each acceptance criterion verifiable?

Classify an issue as blocking when the plan cannot be implemented responsibly or verified without resolving it. Details that can safely be settled during implementation are non-blocking.

If, across the plan's details, you find the plan itself is the wrong SHAPE for one implementation loop — too many steps, too many independent areas, or work that keeps growing every round it's revised — do not respond by asking for yet more specification. Use the "needs restructuring" verdict below instead, and treat it as blocking: name what should be resequenced or grouped. A plan that keeps passing detail-level scrutiny round after round while never shipping is a sign the plan is over-scoped, not under-specified — say so explicitly rather than filing another round of smaller gaps.

One plan is one task. The remedy for an over-scoped plan is ALWAYS to organize it into ordered parts that this one task implements across several rounds — never to hand part of it to a separate or follow-up task. You have no authority to divide a plan across tasks, and a division made here would be made before the implementation checklist exists, so the removed work would never be tracked as outstanding at all. If you believe the plan genuinely cannot be delivered by this task in any ordering, say so explicitly as a blocking issue needing a human scope decision rather than inventing a division.

Owner evidence: when a plan step requires evidence that rounds cannot gather (a web page, provider documentation, or a live provider CLI probe) and the task description does not already contain it, that is a blocking issue: the plan is not ready, its score is below the ready threshold, and the machine-readable block carries `- [completion] [environmental] Owner evidence needed: <the exact evidence>` — never `task-fixable` or `needs-toolchain`.

Publish Checks hand-off: an excluded "Verified by Publish Checks:" item (confirmed setting, covered run), or an excluded owner step for an unconfirmed setting, is correct and you must never file a blocker because such an item is excluded. File a task-fixable blocker when such an item claims a run the selected command does not cover (an uncovered run), or rests on an unconfirmed setting: a `.vscode/settings.json` value without the task's single-folder evidence, or the key's absence treated as confirmation.

Begin your response with a readiness score on its own line in this exact format:
Readiness: N/10

Where N is a score from 0-10.

{{reviewScoringRubric}}

Then structure your review as:
- Summary verdict (ready to finalize / needs changes / needs restructuring — the plan is the wrong shape, not merely under-specified; sequence it into ordered parts this task implements one per round, rather than adding detail or handing parts to other tasks).
- Blocking issues (if any), each tied to a specific step or section of the plan.
- Non-blocking suggestions (if any).
- Anything the plan got right and should keep.

## Context Pack

{{contextPack}}

## Plan Under Review

{{plan}}
