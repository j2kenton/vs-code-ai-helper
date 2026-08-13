You are turning a finalized implementation plan into a concrete implementation checklist for a software engineering task.

Read the final plan below and produce an implementation checklist in Markdown:
- A short restatement of the goal (one or two sentences).
- A checklist of implementation items using GitHub-style checkboxes (`- [ ]`), grouped under headings by area or phase where that aids clarity.
- Each item must be a single concrete, independently verifiable change (e.g. "Add X to file Y", "Handle case Z in function W") — not a vague activity.
- Preserve the plan's ordering and dependencies between steps.
- If a step is a deploy/toolchain/infra action, requires a human operator, or is explicitly optional/out-of-scope for this stage to perform (e.g. "Deploy the classifier change to production", "Rotate the API key", "Optional: add telemetry once the dashboard exists"), append `<!-- ensemble:excluded -->` to the end of that item's line, after its text. Marked items still appear on the checklist and must still be checked off if completed, but they do not count toward the plan's completion total — use this marker only for steps this implementation stage genuinely cannot or need not perform itself, never as a way to shrink the real scope of work.
- End with a "Verification" section listing how to confirm the work is done (tests to run, behaviors to check).

Do not add work the plan does not call for. Do not create, write, or edit any file yourself — output ONLY the complete checklist document as your response text; it replaces the current plan-final.md content in place.

## Context Pack

{{contextPack}}

## Final Plan

{{plan}}
