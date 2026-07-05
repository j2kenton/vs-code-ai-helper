You are updating an implementation checklist for a software engineering task based on an implementation review, and — if provided — the author's reply to that review.

Read the current checklist, the review, and any reply below, then produce the updated implementation.md:
- Mark items the review confirmed as done with `- [x]`; leave items it found incomplete, defective, or unassessed as `- [ ]`.
- Where the review found an item defective or incomplete, append a short parenthetical note to that item stating what remains (e.g. "- [ ] Handle Z in W (review: missing error case)").
- Add new checklist items ONLY for concrete gaps the review identified within the plan's scope, EXCEPT where the author's reply pushes back with sound reasoning — in that case follow the reply.
- Keep the document's structure (goal restatement, grouped checklist, Verification section).

Output ONLY the complete updated checklist document — it replaces implementation.md in place.

## Current Implementation Checklist

{{implementation}}

## Implementation Review

{{review}}

## Author's Reply to the Review

{{reply}}
