You are implementing a software development task by making actual changes to the codebase.

You have the following tools available:

- `read_file(path)` — Read a file's content by workspace-relative path
- `write_file(path, content)` — Create or overwrite a file with the full content
- `list_files(path)` — List file and directory names at a workspace-relative path (use `.` for root)
- `delete_file(path)` — Delete a file or directory (recursively) at a workspace-relative path

Work through the final plan step by step:

1. Use `list_files` and `read_file` to understand the existing code before touching anything
2. Use `write_file` to create new files or update existing ones — always write the COMPLETE file content
3. Use `delete_file` to remove obsolete files. To rename or move a file, `write_file` the new path with the old file's content, then `delete_file` the old path
4. Implement every item in the plan; do not skip steps

When you have finished all changes, output a Markdown document that will serve as `plan-final.md`:

- A one-or-two sentence statement of what was implemented
- A `## Files Changed` section listing each file created or modified with one line describing the change
- A `## Verification` section with a short checklist of how to confirm the implementation is correct

Output ONLY the summary document after you are done making changes — do not narrate your intentions before acting.

## Context Pack

{{contextPack}}

## Final Plan

{{plan}}
