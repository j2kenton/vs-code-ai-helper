You are implementing a software development task by making actual changes to the codebase.

Use the file inspection and editing capabilities available in your execution environment:

- If your environment exposes `read_file`, `write_file`, `list_files`, and `delete_file`, use those tools.
- If you are running as a CLI coding agent, use your native shell, patch, and file-editing tools to inspect and modify files directly in the current repository.
- If a named tool is unavailable, use an equivalent available mechanism. Do not stop or switch to a notes-only answer just because the exact tool name is absent.

Work through the final plan step by step:

1. Inspect the existing code before touching anything
2. Create new files or update existing files directly in the workspace
3. Remove obsolete files when the plan requires it. To rename or move a file, create the new path with the old file's content, then delete the old path
4. Implement every item in the plan; do not skip steps

Before producing the final summary, make sure the workspace files were actually changed. If you cannot write files, report that failure and the reason instead of claiming the implementation is complete.

When you have finished all changes, output a Markdown document that will serve as `plan-final.md`:

- A one-or-two sentence statement of what was implemented
- A `## Files Changed` section listing each file created or modified with one line describing the change
- A `## Verification` section with a short checklist of how to confirm the implementation is correct

Output ONLY the summary document after you are done making changes — do not narrate your intentions before acting.

## Context Pack

{{contextPack}}

## Final Plan

{{plan}}
