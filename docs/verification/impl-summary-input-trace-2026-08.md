# Implementation-summary input trace — 2026-08

Traces `workflow 8` item 6: `workflow 6`'s low review asserted that an
implementation round's notes reported three items as unbuilt when all three
were actually implemented, and attributed this to "the notes examined only
the uncommitted diff, not the tree." This was recorded as an open question,
not a confirmed defect, because a grep of `contextPack.ts` for diff-feeding
found nothing at the time.

**Conclusion: the reviewer was right about the symptom and about model
behavior, but the mechanism is not a system-fed diff — no context pack this
extension builds for an implementation round ever contains a git diff.**
There is no input to fix. What already exists — and is the right fix for
this failure mode — is prompt language directing the model to the tree, which
is present, plus a structured, evidence-gated path for reporting tree-verified
completions that a round's own prose summary missed.

## What an implementation round is actually given

Traced `generateContextPack` and its call sites for implementation rounds
(`src/commands/reviewActions.ts:5106`, `:5918`) and `src/utils/contextPack.ts`
end to end:

- The general context pack assembled for an implementation/review-response
  round carries prose sections — workspace root, the user's request/plan,
  open editors, constraints — never a `git diff` blob. (This document's own
  authoring round received exactly this shape of context pack, with no diff
  section, and had to inspect the working tree directly via file-read tools
  to determine what was already built — directly reproducing the access
  pattern this trace is about.)
- `contextPack.ts`'s only `git diff` usage (`runGitCommand(repoRoot, "diff",
  ...)`, lines ~511/526/553) is scoped to the REVIEW-file changed-region
  excerpt machinery added in this same task's Part 2
  (`buildChangedRegionsForReviewFileV1` and friends) — it computes which line
  ranges of a REVIEWED file changed since a baseline, so a reviewer's excerpt
  can focus on them. It is invoked only when building a review's file
  excerpts, never when assembling the plan/prompt context an implementation
  round receives to decide what is or isn't already built.
- An implementation round itself (CLI providers with native filesystem tools,
  or the sealed edit two-phase pipeline) reads the workspace through its own
  tool calls — `ensemble_readFile`, `ensemble_readDirectory`, or the
  provider's own native read tools — not through a pre-assembled source-code
  blob the harness pushes into the prompt. What it reads, and how much of the
  tree it looks at before writing its notes, is the model's own choice.

## So what produced the stale notes

Given no diff is fed to the round, the most likely account of `workflow 6`'s
symptom is that the round chose a narrow read — e.g. running `git diff` or
`git status` itself to see "what did I just change" and writing its
completion notes from that, rather than checking the plan's other unticked
items against the tree — not a system defect feeding it a truncated view.
This is a model-behavior failure, which is exactly the second outcome this
item's fix list names ("the model chooses the diff... add prompt language
directing it to the tree").

## The fix for this failure mode already exists

`resources/prompts/run-implementation.md:26` (the "Retroactive exception"
clause) already states the rule explicitly:

> "if you find a plan item that is unticked in the 'Final Plan' but is
> ALREADY fully implemented in the **working tree** from an earlier round
> (its tick was lost, e.g. to text drift between the round's echo and the
> plan of record), you may NOT tick it in the echo above ... Instead, report
> it in the `## Plan Item Checklist` section below using the retroactive
> marker described there, with hard evidence."

This is precisely the failure `workflow 6` observed — a round under-reporting
completed work — and precisely the remedy this item's third option
describes: prompt language naming the tree (not "what I just changed") as the
source of truth, paired with a structured, evidence-required channel
(`<!-- ensemble:retroactive -->`, cf.
`src/utils/implementationChecklist.ts`'s retroactive-tick handling) for a
round to correct an earlier round's stale notes without having to re-derive
or guess at what changed.

## Outcome

Closed as: **the reviewer's diagnosis of the symptom was correct; the
proposed mechanism (a system-fed diff) is not what happens — no
implementation-round context pack has ever contained one — and the actual
cause is model read-scope choice, which the existing "working tree" /
retroactive-tick prompt language already targets.** No further prompt or
context-pack change is needed for this specific failure mode; if stale notes
recur, the next step is widening the "working tree" language beyond the
retroactive-exception clause to the implementation summary's `##
Verification`/completion-notes guidance generally, since today it is stated
only for the retroactive-tick case.
