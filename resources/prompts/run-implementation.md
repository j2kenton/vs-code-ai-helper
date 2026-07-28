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

If the "Final Plan" below is an implementation checklist (starts with `<!-- ensemble:implementation-checklist -->`) and it contains ANY `- [ ]` (unchecked) item, that is not informational — it is work you must do this round. "The code I inspected has no defects" is not a reason to stop: an unchecked checklist item usually describes something that does not exist yet, not something broken in what already exists, so inspecting the existing code and finding it correct does NOT mean the plan is satisfied. Pick the next unchecked item (or the first one, if order matters and none have been started) and implement it. Only report zero file changes if you are certain every single checklist item is already checked, or if you are structurally unable to write files (report that failure explicitly instead).

Before producing the final summary, make sure the workspace files were actually changed. If you cannot write files, report that failure and the reason instead of claiming the implementation is complete.

Do NOT create or edit a `plan-final.md` or `implementation.md` file at the repository root — those filenames are reserved there for the extension's own task-tracking artifacts (nested paths, e.g. `docs/implementation.md`, are unaffected and fine to touch if the plan calls for it). When you have finished all changes, output your summary as plain Markdown text in your final response (not written to any file):

- If the "Final Plan" below starts with `<!-- ensemble:implementation-checklist -->` followed by a checklist of `- [ ]`/`- [x]` items, your response's FIRST section must reproduce that entire checklist marker and list verbatim, with only the checkbox state changed for items you completed or made progress on this round (`- [ ]` → `- [x]`) — do not remove, renumber, reword, or add items. This is the only persistent record of overall plan progress across rounds: if you omit it here, the next round will not know what remains, and will incorrectly treat the plan as finished. If some items remain incomplete, they MUST stay `- [ ]` and MUST still be listed — do not drop them because this round didn't touch them.
- A one-or-two sentence statement of what was implemented this round
- A `## Files Changed` section listing each file created or modified with one line describing the change
- A `## Verification` section with a short checklist of how to confirm the implementation is correct

Output ONLY the summary document as your final text response after you are done making changes — do not narrate your intentions before acting, and do not write the summary to a file.

## Context Pack

{{contextPack}}

## Final Plan

{{plan}}
