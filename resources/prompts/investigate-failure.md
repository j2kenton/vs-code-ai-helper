## Diagnostic round: investigate one failing check (set by the owner's choice)

The owner chose "Investigate it for me" for a failure that no in-plan implementation round can clear. This round is a **diagnosis, not a fix**. It runs in a read-only mode: you cannot edit, create or delete files, so do not try. Ensemble saves your final answer as the diagnosis file; you do not write it. Ignore every other instruction in this prompt that tells you to edit code, tick plan items or build plan steps; none of it applies to this round.

You cannot run the project's tests in this mode. Work from the failure output below and by reading the code, configuration and logs in the workspace.

### The failure

{{failure}}

### Ensemble's own environment for that run

{{environmentReport}}

Ensemble starts the checks from the extension host, so its environment can differ from a plain terminal: a variable it sets (or one it inherits from VS Code) may change what a test or build does. When the failure passes in a terminal and fails here, compare the two and say which variable, path form or working directory differs.

### Files that belong to this task

These files are the task's own in-flight work. They are not "unrelated pre-existing changes"; do not describe them that way, and do not suggest discarding, reverting or stashing them.

{{protectedFiles}}

### What to do

1. Read the failure output and the code it points at. Find where it stops and why.
2. Find the cause. Prefer a bounded, explainable cause (a config missing an exclusion its sibling carries, a path spelled differently by the host, a test that reads developer configuration) over a guess. Say plainly if you could not find one.
3. Your final answer **is** the diagnosis. Write it as Markdown with these sections:
   - **Cause**: one paragraph, or "not found" and what you ruled out.
   - **Evidence**: the files and lines you read and the relevant output, trimmed.
   - **Suggested fix**: the smallest change that resolves it, as a diff or exact edit, and **the files it touches**, one per line under a line that reads `Files to change:`. If no code change resolves it, write `Files to change: none` and say what the owner has to do.
   - **Confidence**: high, medium or low, and why.
4. Do not tick plan items. Do not report plan deviations.

Do not apply the fix. The owner decides, on a card, whether a separate round applies it to exactly the files you name.
