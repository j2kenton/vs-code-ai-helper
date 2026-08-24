You are turning a finalized implementation plan into a concrete implementation checklist for a software engineering task.

Read the final plan below and produce an implementation checklist in Markdown:
- A short restatement of the goal (one or two sentences).
- A checklist of implementation items using GitHub-style checkboxes (`- [ ]`), grouped under headings by area or phase where that aids clarity.
- Each item must be a single concrete, independently verifiable change (e.g. "Add X to file Y", "Handle case Z in function W") — not a vague activity.
- Preserve the plan's ordering and dependencies between steps.
- If a step is a deploy/toolchain/infra action, requires a human operator, or is explicitly optional/out-of-scope for this stage to perform (e.g. "Deploy the classifier change to production", "Rotate the API key", "Optional: add telemetry once the dashboard exists"), append `<!-- ensemble:excluded -->` to the end of that item's line, after its text. Marked items still appear on the checklist and must still be checked off if completed, but they do not count toward the plan's completion total — use this marker only for steps this implementation stage genuinely cannot or need not perform itself, never as a way to shrink the real scope of work.
- Every item requiring a human to manually check or verify something (as opposed to a deploy/toolchain step nobody needs to inspect) must carry all five hand-off elements in its own text, not just a restatement of what to do:
  - **What** to check — concrete and specific.
  - **Why** — what this confirms, in one sentence.
  - **How** — the actual steps in the user's own project, not "verify it renders" or "confirm it works".
  - **If it fails** — the observable symptom that tells the reader it did not pass.
  - **Priority** — `Priority: HIGH` when a failure here would be silent or damaging in the user's own project, `Priority: LOW` when it would be loud and recoverable; a LOW item must say skipping it is acceptable and name the trade-off being made. Derive this from what the failure actually costs, never from a fixed notion of a "write path" — the same judgment applies whatever kind of project this is.
  This item still carries `<!-- ensemble:excluded -->` when it is not something the implementation stage itself performs.

  Worked example of the shape (the domain here is illustrative only — write each item for the actual project this checklist is for, never copy this example's subject matter):

  > **Duplicate rows after the staging import — HIGH priority.**
  >
  > **What:** run the importer against staging twice and count rows in `orders`.
  >
  > **Why:** the dedupe key changed this round; nothing automated covers a re-run.
  >
  > **How:** `SELECT count(*) FROM orders;` before and after the second run — the number should not change.
  >
  > **If it fails:** the count grows. Rows are duplicated, not corrupted, and staging can be truncated.
  >
  > **Why it is high priority:** if it is wrong in production the damage is silent and compounds with every import.

  A LOW-priority item follows the same shape but ends by naming what is being traded off, e.g. "Priority: LOW — a failure here surfaces as an error dialog immediately; skipping this check only costs a rerun, never bad data."
- End with a "Verification" section listing how to confirm the work is done (tests to run, behaviors to check). Evidence for a manual-verification item (a run log line, a file/line, a query result) is written below its guidance once it exists, never instead of the five elements above.

Do not add work the plan does not call for. Do not create, write, or edit any file yourself — output ONLY the complete checklist document as your response text; it replaces the current plan-final.md content in place.

## Context Pack

{{contextPack}}

## Final Plan

{{plan}}
