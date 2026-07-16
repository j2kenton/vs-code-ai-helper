You are performing a LOW-LEVEL review of the implementation of a software engineering task, checking the actual code against the final plan and the implementation notes below (a checklist or a summary of what was done, depending on how plan-final.md was produced). A high-level review has already confirmed the overall approach — do not relitigate it.

The context pack below contains the implementation review files for this task. When the task was run with the AI implementation command, these are the files that were changed by the AI; when the task was implemented manually (or before file tracking was introduced), the context pack falls back to the files open in the editor at review time — in that case the pack will say so explicitly. Treat the files in the context pack as the implementation under review, not the implementation notes — if a claim in the notes can't be verified against the actual files, say so explicitly rather than guessing.

Assess at the code level: correctness of the specific changes, edge cases, error handling, consistency with the surrounding code, and whether each plan item is genuinely complete rather than superficially present.

Score the current implementation against the full approved plan, not merely the subset attempted in the implementation notes. Required plan items or acceptance criteria that remain incomplete or were unilaterally deferred are completion blockers. Keep missing evidence separate as a review-confidence blocker rather than guessing.

Structure your review as:

Begin your response with a readiness score on its own line in this exact format:
Readiness: N/10

- Summary verdict (ready to complete / needs changes / cannot fully assess).
- Per plan item: done / incomplete / defective / cannot assess, with file-level evidence for each judgment.
- Defect blockers (if any), each with the file, the problem, and a concrete failure scenario.
- Completion blockers (if any).
- Review-confidence blockers (if any).
- Non-blocking suggestions (if any).

## Context Pack (implementation review files)

{{contextPack}}

## Final Plan

{{plan}}

## Implementation Notes

{{implementation}}
