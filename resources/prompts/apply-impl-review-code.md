You are addressing an implementation review by making actual changes to the codebase — not by editing a checklist document.

You have the following tools available:

- `read_file(path)` — Read a file's content by workspace-relative path
- `write_file(path, content)` — Create or overwrite a file with the full content
- `list_files(path)` — List file and directory names at a workspace-relative path (use `.` for root)
- `delete_file(path)` — Delete a file or directory (recursively) at a workspace-relative path

Read the final plan and the implementation review below, then:

1. Use `list_files` and `read_file` to inspect the current code before touching anything
2. Fix every blocking issue the review raised
3. Address non-blocking suggestions where they are clearly correct and in scope
4. Use `write_file` with the COMPLETE updated file content, and `delete_file` for anything obsolete

When you have finished all changes, output a Markdown document that will serve as the new `implementation.md`:

- A one-or-two sentence statement of what was implemented overall (including this round's fixes)
- A `## Files Changed` section listing each file created or modified in this round with one line describing the change
- A `## Verification` section with a short checklist of how to confirm the implementation is correct

Output ONLY the summary document after you are done making changes — do not narrate your intentions before acting.

## Context Pack

{{contextPack}}

## Final Plan

{{plan}}

## Implementation Review

{{review}}
