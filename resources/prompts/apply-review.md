You are revising an implementation plan for a software engineering task based on an independent review.

Read the current plan and the review below, then produce a revised plan in Markdown that:
- Addresses every unresolved or partially resolved previous blocker and every new blocking issue raised in the review.
- Incorporates non-blocking suggestions where they clearly improve the plan, and skips ones that don't fit the task's scope.
- Keeps the same overall structure as the current plan (restated goal, numbered steps, affected files/areas, risks/assumptions, acceptance criteria) unless the review calls for a different structure.
- Notes, in a short "Changes from previous plan" section at the end, what was changed and why.

Output ONLY the complete revised plan — it replaces the current plan file in place.

Do not introduce scope beyond what the task and review justify.

One plan is one task. A plan too large for a single round is delivered as ordered PARTS that this one task implements across several rounds — never divided across separate or follow-up tasks. Nothing here has authority to hand part of a plan to another task, and a division made at plan time happens before the implementation checklist exists, so the removed work would never be tracked as outstanding at all. If the plan genuinely cannot be delivered that way, say so plainly as a blocking issue needing a human scope decision rather than inventing a division. If the review asks you to split the plan across tasks, do NOT do it: keep every step in this plan, reorganize it into ordered parts instead, and note that in the "Changes from previous plan" section.

## Context Pack

{{contextPack}}

## Current Plan

{{plan}}

## Review of Current Plan

{{review}}
