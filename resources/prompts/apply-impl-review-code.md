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
7. If the review reports NO blockers but this task's work is not finished — look for a `<!-- progress: N/M -->` marker where N is less than M, or a verdict naming steps still to come — then this round's job is to **build the next steps**, continuing in the plan's own order from where the last round stopped. "No blockers" means nothing is wrong with what exists; it does not mean the work is done. Reporting "no changes needed" while steps remain unbuilt stalls the task, because this same review-then-implement cycle is what carries a large plan to completion a batch at a time. Implement as much of the remaining order as you can do well in one round — correctness and verification first, volume second — then state exactly which steps you completed and which are still outstanding.

   Scope limit: build only what THIS task owns. When the plan explicitly assigns part of its scope to separate or follow-up tasks, work outside this task's portion is out of scope — do not start it, even when the progress marker or a stale earlier review appears to point past the boundary. If the marker's denominator looks like it counts another task's steps, say so plainly in your summary instead of building them; implementing another task's work out of order is a worse outcome than a round that correctly reports it has nothing left to do.

The approved plan is the binding delivery contract. Implementation notes are
historical evidence, not approval to reduce, substitute, or defer a plan
requirement. Do not claim the plan is unavailable: it is included below. When
the current code differs materially from an explicit plan or acceptance
criterion, implement the approved contract unless explicit user approval is
recorded in the task or review context. A reasonable alternative is not approval
on its own.

If a blocker is too large to complete in one run, implement the largest coherent prerequisite slice that directly advances that blocker, then state exactly what remains. Do not claim the review is fully addressed merely because unrelated or lower-risk fixes were completed.

Before producing the final summary, make sure the workspace files were actually changed. If you cannot write files, report that failure and the reason instead of claiming the implementation is complete.

Do NOT create or edit a `plan-final.md` or `implementation.md` file at the repository root — those filenames are reserved there for the extension's own task-tracking artifacts (nested paths, e.g. `docs/implementation.md`, are unaffected and fine to touch if the review calls for it). When you have finished all changes, output your summary as plain Markdown text in your final response (not written to any file):

- If "Implementation Notes (plan-final.md)" below starts with `<!-- ensemble:implementation-checklist -->` followed by a checklist of `- [ ]`/`- [x]` items, your response's FIRST section must reproduce that entire checklist marker and list verbatim, with only the checkbox state changed for items you completed or made progress on this round (`- [ ]` → `- [x]`) — do not remove, renumber, reword, or add items. This is the only persistent record of overall plan progress across rounds: if you omit it here, the next round will not know what remains, and will incorrectly treat the plan as finished. Items outside this round's review-fix scope MUST stay exactly as they were, still listed, not dropped.
- A one-or-two sentence statement of what was implemented overall (including this round's fixes)
- A `## Files Changed` section listing each file created or modified in this round with one line describing the change
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
