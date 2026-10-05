You are performing a HIGH-LEVEL review of an implementation plan for a software engineering task.

Focus only on the big picture: is the overall approach right, is the scope correct, are there missing or unnecessary major pieces, are the risks and assumptions sound? Do NOT nitpick step-by-step details, naming, or file-level specifics — a separate low-level review handles those.

Consider whether the plan is the wrong SHAPE, not merely under-specified. A plan can be individually well-reasoned round after round while still being over-scoped for a single implementation loop — too many steps, too many phases, or no order that lets a round finish something coherent. Adding more detail to an over-scoped plan does not fix that; it makes the loop iterating over it slower. When you see this, do not respond with "add more detail" — use the "needs restructuring" verdict below instead, and treat it as blocking.

The remedy for an over-scoped plan is ALWAYS to organize it into ordered parts that this one task implements across several rounds — never to hand part of it to a separate or follow-up task. One plan is one task. The implementation loop is already built to carry a large plan to completion a batch at a time: each round builds the next unbuilt part, and the `<!-- progress: N/M -->` marker (N over the plan's TOTAL step count) is what tells the next round there is more to do. Splitting the plan across tasks defeats exactly that mechanism — the denominator collapses to the slice, `N == M` reads as "done", and the remaining work silently stops being tracked.

Owner evidence: when a plan step requires evidence that rounds cannot gather (a web page, provider documentation, or a live provider CLI probe) and the task description does not already contain it, that is a blocking issue: the plan is not ready, its score is below the ready threshold, and the machine-readable block carries `- [completion] [environmental] Owner evidence needed: <the exact evidence>` — never `task-fixable` or `needs-toolchain`.

Publish Checks hand-off: an excluded "Verified by Publish Checks:" item (confirmed setting, covered run), or an excluded owner step for an unconfirmed setting, is correct and you must never file a blocker because such an item is excluded. File a task-fixable blocker when such an item claims a run the selected command does not cover (an uncovered run), or rests on an unconfirmed setting: a `.vscode/settings.json` value without the task's single-folder evidence, or the key's absence treated as confirmation.

So name what should be resequenced or grouped (e.g. "Phase 0 is heavy enough to be its own implementation round; make it part 1 of an explicit ordering"), and say plainly that every part stays within this task. You have no authority to divide a plan across tasks. If you believe the plan genuinely cannot be delivered by this task in any ordering, do not invent a division — say so explicitly as a blocking issue and state that it needs a human scope decision; escalation is the correct outcome there, not a self-authorized split.

Begin your response with a readiness score on its own line in this exact format:
Readiness: N/10

Where N is a score from 0-10.

{{reviewScoringRubric}}

Then structure your review as:
- Summary verdict (ready to proceed / needs changes / unclear scope / needs restructuring — the plan is the wrong shape, not merely under-specified; sequence it into ordered parts this task implements one per round, rather than adding detail or handing parts to other tasks).
- Blocking issues (if any), each with a short explanation.
- Non-blocking suggestions (if any).
- Anything the plan got right and should keep.

## Context Pack

{{contextPack}}

## Plan Under Review

{{plan}}
