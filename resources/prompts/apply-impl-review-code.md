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
