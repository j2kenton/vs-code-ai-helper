You are addressing an implementation review by making actual changes to the codebase — not by editing a checklist document.

Use the file inspection and editing capabilities available in your execution environment:

- If your environment exposes `read_file`, `write_file`, `list_files`, and `delete_file`, use those tools.
- If you are running as a CLI coding agent, use your native shell, patch, and file-editing tools to inspect and modify files directly in the current repository.
- If a named tool is unavailable, use an equivalent available mechanism. Do not stop or switch to a notes-only answer just because the exact tool name is absent.

Read the approved plan, implementation notes, and review below, then:

1. Inspect the current code before touching anything
2. Fix every unresolved or partially resolved blocker the review identifies, including architectural, defect, completion, and previous-review blockers
3. Do not substitute smaller non-blocking changes while required blockers remain
4. Treat review-confidence blockers as an instruction to inspect the workspace directly or improve the missing evidence, not as proof of a code defect
5. Address non-blocking suggestions where they are clearly correct and in scope
6. Edit files directly in the workspace, and remove anything obsolete
7. Never remove a user-facing product surface — a `package.json` `contributes.commands`/menu entry, a public CLI command, an exported API, or similar reachable entry point — as a side effect of addressing this review, even when the review or plan calls for it. Removing user-facing surface is a distinct, higher class of change than deleting internal scaffolding, and a review score alone never authorizes it. If a review or plan step appears to require it, do not delete it: record it as a remaining blocker requiring an explicit human-approved scope decision (recorded in the task itself) and leave the surface in place until that approval exists.
8. If the review reports NO blockers but this task's work is not finished — look for a `<!-- progress: N/M -->` marker where N is less than M, or a verdict naming steps still to come — then this round's job is to **build the next steps**, continuing in the plan's own order from where the last round stopped. `N` is steps SETTLED — fully implemented and verified, PLUS any step the plan itself marks closed without doing the work (descoped, superseded, or a branch not taken, via `<!-- ensemble:excluded -->`) — over `M`, the plan's fixed TOTAL step count, which never shrinks when a step is later marked excluded. `N < M` therefore means genuinely open work remains, not merely steps closed without doing; only `N === M` means nothing further is owed here. "No blockers" means nothing is wrong with what exists; it does not mean the work is done. Reporting "no changes needed" while steps remain unbuilt stalls the task, because this same review-then-implement cycle is what carries a large plan to completion a batch at a time. Implement as much of the remaining order as you can do well in one round — correctness and verification first, volume second — then state exactly which steps you completed and which are still outstanding.

   Scope: the whole plan is THIS task's, and `M` counts every step in it. A plan delivered in parts is still one task's work, so a part the plan claims to assign to a separate or follow-up task is not a boundary — continue into it in the plan's own order when the earlier parts are done. Build in order rather than jumping ahead: implementing a later part before the foundations it rests on is a worse outcome than a round that builds fewer steps well. If the plan's own text conflicts with this (it declares a division across tasks, or its marker counts only a slice), follow the plan's ORDER but the full denominator, and say so plainly in your summary.

The approved plan is the binding delivery contract. Implementation notes are
historical evidence, not approval to reduce, substitute, or defer a plan
requirement. Do not claim the plan is unavailable: it is included below. When
the current code differs materially from an explicit plan or acceptance
criterion, implement the approved contract unless explicit user approval is
recorded in the task or review context. A reasonable alternative is not approval
on its own.

If a blocker is too large to complete in one run, implement the largest coherent prerequisite slice that directly advances that blocker, then state exactly what remains. Do not claim the review is fully addressed merely because unrelated or lower-risk fixes were completed.

Before producing the final summary, make sure the workspace files were actually changed. If you cannot write files, report that failure and the reason instead of claiming the implementation is complete.

This run ends the moment you stop producing output — there is no second turn. If you launch a command in the background and end your response promising to report back once it finishes, that promise is discarded and the round is wasted: nothing re-invokes you to collect the result. Any command whose result the summary depends on (tests, builds, type-checks) must be run to completion and awaited inline before you write the summary. There is no "completion notification" that will resume this task, and no scheduled wakeup that will bring you back to finish a thought — those are not real mechanisms this workflow provides. Ending your response with "I'll pause here and wait for X to complete" or "I'll pick this up when the notification arrives" does not pause anything; it ends the round with nothing recorded, and the work you already did will need to be recovered by a later round working from scratch.

Do NOT create or edit a `plan-final.md` or `implementation.md` file at the repository root — those filenames are reserved there for the extension's own task-tracking artifacts (nested paths, e.g. `docs/implementation.md`, are unaffected and fine to touch if the review calls for it). When you have finished all changes, output your summary as plain Markdown text in your final response (not written to any file):

- If "Implementation Notes (plan-final.md)" below contains `<!-- ensemble:implementation-checklist -->` anywhere (it normally sits just after a `<!-- Generated by ... -->` attribution line rather than on the first line) followed by a checklist of `- [ ]`/`- [x]` items, your response's FIRST section must reproduce that entire checklist marker and list verbatim, with only the checkbox state changed for items you FULLY COMPLETED this round (`- [ ]` → `- [x]`). A box means done, not started: an item you only advanced part-way MUST stay `- [ ]`, because the count of unticked boxes is what tells the workflow how much of the plan is left — ticking partial work reports the plan as finished while it is not. Describe partial progress in your summary prose instead — do not remove, renumber, reword, or add items. This is the only persistent record of overall plan progress across rounds: if you omit it here, the next round will not know what remains, and will incorrectly treat the plan as finished. Items outside this round's review-fix scope MUST stay exactly as they were, still listed, not dropped.
  - Exception: if fixing this review's blockers legitimately required no checkbox change at all (you fixed a defect the review raised, not an unbuilt plan step), you may omit the checklist echo and instead write the line `<!-- ensemble:no-checklist-change -->` at the top of your response, followed by one sentence saying why nothing was ticked. Do not use this to avoid reproducing the checklist when a step actually was completed — that case still requires the full echo above.
  - Retroactive exception: if you find a plan item that is unticked in "Implementation Notes (plan-final.md)" but is ALREADY fully implemented in the working tree from an earlier round (its tick was lost, e.g. to text drift between the round's echo and the plan of record), you may NOT tick it in the echo above — the echo may only tick items FULLY COMPLETED *this* round. Instead, report it in the `## Plan Item Checklist` section below using the retroactive marker described there, with hard evidence. This is the only way an earlier round's already-finished work can ever be recorded.
- A one-or-two sentence statement of what was implemented overall (including this round's fixes)
- A `## Files Changed` section listing each file created or modified in this round with one line describing the change
- A `## Plan Item Checklist` section listing every plan item this round is responsible for (the full plan, or — for a staged/multi-round plan — every item in the executable order reachable this round) as `item — done / deferred / not reached — evidence (file:line or a short reason)`. This lets the reviewer diff your claims against the plan directly instead of re-deriving them by reading every file. An item that is not done must state why. For a staged plan the normal reason is "not yet reached in the executable order" — that is remaining work, not a failure. Do NOT report an item as out of this task's scope: every item in the plan is this task's, so an item you chose not to build is deferred work you must justify, not a scope boundary.
  - Retroactive ticks: to record a plan item that is unticked on disk but that you verified is already fully implemented (built in an earlier round whose tick never landed), write its entry as `item — done <!-- ensemble:retroactive --> — evidence (file:line, symbol, or test name)`. The `<!-- ensemble:retroactive -->` marker is the RECOMMENDED form — it is unambiguous — but is not strictly required: an entry whose status begins with `done` and carries non-empty evidence (`item — done — evidence ...`) is also accepted. Either way, non-empty evidence is required — a `done` entry with no evidence after it will not be applied to the plan of record, and reads only as an unresolved claim. Use this only for genuinely pre-existing work; a step you built this round is ticked via the checklist echo above instead, never this way. This form is ONLY read from this `## Plan Item Checklist` section — a "done" mention elsewhere in your summary (e.g. in `## Verification` or narrative prose) never ticks anything.
    - `item` MUST be the plan's exact item text, copied verbatim (whitespace and wording as written) — never a paraphrase, abbreviation, or your own summary of it. The tick is applied by matching this text against the plan's checklist exactly; a paraphrase matches nothing, so the item silently stays unchecked even though you reported it done. Worked example — given a plan item `- [ ] In the webview <style>, set .model-combo-input to font-size: var(--ensemble-small-font-size) and reduce its vertical padding so the combo-box input height shrinks with the text.`, write `- In the webview <style>, set .model-combo-input to font-size: var(--ensemble-small-font-size) and reduce its vertical padding so the combo-box input height shrinks with the text. — done <!-- ensemble:retroactive --> — src/views/settingsView.ts:672-675`, NOT a shortened `.model-combo-input small font + reduced padding — done <!-- ensemble:retroactive --> — ...`. This still works even when the plan item's own text contains an em dash (` — `) — copy it verbatim; the match is resolved against the plan's real item texts, not by splitting on the first dash.
    - Whole-Part claims: if an ENTIRE plan Part is done and verified, you may claim it in one line instead of enumerating every item: `Part N — done this round (X/Y), evidence: ...` (or the same shape with the retroactive marker). This ticks every item under the matching `## Part N` heading in the plan of record. Evidence is still required at the part level; a part-level claim with no evidence ticks nothing.
    - Never combine a retroactive tick with `<!-- ensemble:no-checklist-change -->` above: that marker declares nothing to tick, and a retroactive claim declares something to tick. If you have retroactive completions to report, omit the marker.
- If any blocker remains, a `## Remaining Blockers` section naming each unresolved item and why it could not be completed in this run
- A `## Verification` section with a short checklist of how to confirm the implementation is correct

Output ONLY the summary document as your final text response after you are done making changes — do not narrate your intentions before acting, and do not write the summary to a file.

## Context Pack

{{contextPack}}

## Approved Plan (plan.md)

{{approvedPlan}}

## Implementation Notes (plan-final.md)

{{implementation}}

## Implementation Review

{{review}}
