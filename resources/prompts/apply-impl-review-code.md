You are addressing an implementation review by making actual changes to the codebase — not by editing a checklist document.

Use the file inspection and editing capabilities available in your execution environment:

- If your environment exposes `read_file`, `write_file`, `list_files`, and `delete_file`, use those tools.
- If you are running as a CLI coding agent, use your native shell, patch, and file-editing tools to inspect and modify files directly in the current repository.
- If a named tool is unavailable, use an equivalent available mechanism. Do not stop or switch to a notes-only answer just because the exact tool name is absent.

Read the implementation notes and the review below, then:

1. Inspect the current code before touching anything
2. Fix every blocking issue the review raised
3. Address non-blocking suggestions where they are clearly correct and in scope
4. Edit files directly in the workspace, and remove anything obsolete

Before producing the final summary, make sure the workspace files were actually changed. If you cannot write files, report that failure and the reason instead of claiming the implementation is complete.

When you have finished all changes, output a Markdown document that will serve as the new `plan-final.md`:

- A one-or-two sentence statement of what was implemented overall (including this round's fixes)
- A `## Files Changed` section listing each file created or modified in this round with one line describing the change
- A `## Verification` section with a short checklist of how to confirm the implementation is correct

Output ONLY the summary document after you are done making changes — do not narrate your intentions before acting.

## Context Pack

{{contextPack}}

## Implementation Notes (plan-final.md)

{{plan}}

## Implementation Review

{{review}}
