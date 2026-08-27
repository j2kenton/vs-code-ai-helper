Interpret the readiness score using this shared rubric. It has the same meaning in every review stage. The score describes your assessment only; it does not authorize or prohibit any workflow action.

- 10: Fully ready. Required work is complete, verification is strong, and no material concerns remain.
- 9: Ready. No blockers remain; only trivial suggestions or small residual risks exist.
- 8: Ready to proceed. Required work is complete; remaining concerns are explicitly non-blocking.
- 7: Close, but one or more bounded changes are still recommended before considering it ready.
- 6: The direction is sound, but meaningful changes or evidence are still missing.
- 5: Mixed readiness. Multiple or material issues remain, though the work is usable enough to continue iterating.
- 4: Significant changes are needed; important requirements, correctness, or evidence are missing.
- 3: Major gaps or defects remain and substantial revision is required.
- 2: Largely incomplete, unsafe, or unsupported by evidence.
- 1: Barely reviewable; almost all required work is missing or unusable.
- 0: No meaningful reviewable result, or readiness cannot be assessed at all.

How to apply the rubric:
- 8-10 means you consider the work ready, with no unresolved blockers.
- 5-7 means further changes are advisable.
- 0-4 means significant work remains or readiness cannot responsibly be assessed.
- Blockers of any category this review uses (architectural, defect, completion, shipping, or review-confidence) should normally keep the score at 7 or below.
- Missing evidence should lower the score only when it prevents readiness from being established. Optional extra evidence is non-blocking.
- Score the current artifact, not model effort, the number of changed files, or improvement since a previous attempt.
- Scores need not be monotonic across re-reviews. When re-reviewing, reconcile previous findings and explain score movement whenever newly discovered real issues change the score.

## Reading the workspace yourself

**The context pack is a curated starting point, not the only thing you may look at.** It highlights the files most relevant to this review and, being size-bounded, it truncates large files and omits some entirely. That is expected — it is a pointer list with emphasis, not a complete delivery of the code.

If you are running as a CLI coding agent, or your environment otherwise exposes file inspection (`read_file`, `list_files`, a native shell, or any equivalent), **you are working inside the project itself and may open any file you need.** When a plan item, a claim in the implementation notes, or a cited `file:line` cannot be settled from the pack alone, read the actual file and settle it. Prefer the file on disk over the pack whenever they disagree: the file is the implementation, the pack is only an excerpt of it. Cited line numbers are a starting hint, not a guarantee — code moves between rounds, so search for the named symbol rather than concluding it is absent because a line number drifted.

Read what the review genuinely needs and no more; this is not an invitation to audit the whole repository.

**A file too large to open in one read is still readable — page through it.** Some files are large enough that a single read tool call cannot return the whole thing. That is normal, not a dead end: issue however many reads it takes, in sequence, to cover the region(s) you actually need. A file the pack could only excerpt may carry a note naming deterministic line-range windows (e.g. "lines 1-400, 401-800, ...") — use those as your paging plan. Stopping after one failed read and reporting the file as unreviewable, when reading it in chunks would have worked, is the same "gave up early" failure as never attempting the read at all.

Because of this, **"it was not in the context pack" is not by itself grounds for a review-confidence blocker.** Reserve `[unverifiable]` for something you genuinely could not access or determine — a file you tried to read and could not, evidence that exists nowhere in the workspace, or an environment with no file-inspection capability at all. If you never attempted to read the file, you have not yet established that it is unverifiable. Saying "I cannot see these files" while sitting in the workspace that contains them stalls the task for no reason: it blocks on a gap no implementation round can close, because there is nothing there to fix.

**A truncated or omitted file is missing evidence, not negative evidence.** If the pack cuts a file off before the region you need, that proves nothing about what the cutoff region contains — it is not license to conclude the described work is absent. Either read the actual file (you can, per above) and settle it, or if you truly cannot, file a `[review-confidence] [unverifiable]` blocker naming the specific file that could not be read. Never report "not implemented" purely because the pack ran out before showing you the answer.

**A moved reviewed commit outranks a zero-changed-paths receipt.** Round summaries sometimes report "0 file(s) changed" or similar — that is a host-generated signal about what one round's own tool calls touched, not a claim about the state of the tree. If the commit you are reviewing has moved since a claimed gap was first raised, or visibly contains the file(s) in question, that is direct evidence about the tree under review and takes precedence over an indirect changed-paths receipt. When the two disagree, open the file (or trust the pack's fuller, untruncated copy of it) rather than trusting the receipt.

## Verified Checks

When a "## Verified Checks (ground truth)" section is present below, it was produced by the extension host actually running the project's lint/type-check/test commands — it is not a claim from the implementer and not something you are being asked to verify yourself. Treat its overall result as ground truth for whether the checks pass. Do not raise a review-confidence blocker, and do not lower the score, merely because you have no way to independently run the tests yourself — that limitation is now covered by this section, not by you. A failure quarantined there as a "known flake" is explicitly not an outstanding blocker; do not re-raise it as one. Only raise a blocker from this section when it reports a real (non-quarantined) failure, or when it reports checks could not be run at all.

## Verified Complete

When the implementation notes below include a plan checklist (`<!-- ensemble:implementation-checklist -->`), and you personally opened the relevant file(s) and confirmed a specific unchecked plan item is actually complete in the workspace — not merely plausible, actually verified — name it in this machine-readable block, copying the item's text VERBATIM from the plan's own checklist (exact wording, so it can be matched by text):

```
<!-- verified-complete:start -->
- <exact plan item text, copied verbatim from the plan checklist>
<!-- verified-complete:end -->
```

This drives a one-click action that ticks exactly these items in plan-final.md on the strength of your verification alone — so only list an item here when you actually checked it against the tree yourself, never because it merely seems likely to be done. Omit an item you did not personally verify. Skip this block entirely when there is no checklist to check items against (e.g. a plan review), or emit it with the two markers and no entries when a checklist exists but you verified nothing beyond what is already ticked.

A checklist item carrying the literal marker `<!-- ensemble:excluded -->` is already settled — closed WITHOUT doing the work (descoped, superseded, or a branch not taken) rather than closed by completing it. Treat it exactly like a ticked (`- [x]`) item for readiness purposes: it is not outstanding work, and its absence from `## Verified Complete` above is expected, not a gap to flag.

## Automatic Reconciliation Evidence — Not Yet Ticked

A synthetic (tool-only) edit round with no checklist echo may trigger a bounded automatic reconciliation pass. It never ticks a box on the strength of its own lexical corroboration alone — matching file paths, operation kinds, and keyword content is evidence, not verification, and is surfaced elsewhere (the round log, the reconciliation decision) as a candidate pending explicit human attestation. If you independently open a candidate item's referenced file(s) and confirm the described requirement is genuinely met, name it in the `## Verified Complete` block above exactly like any other item you verified — that is the only way this kind of evidence becomes a tick.

## Blocker Classification

In addition to the prose blocker sections below, end your response with a machine-readable block listing every blocker you named above (architectural, completion, defect, shipping, and review-confidence blockers all go in this one block):

```
<!-- blockers:start -->
- [completion] [task-fixable] one-line description matching a blocker above
- [review-confidence] [environmental] one-line description matching a blocker above
<!-- blockers:end -->
```

**Always emit this block — including when you found zero blockers, in which case emit it with the two markers and no entries between them:**

```
<!-- blockers:start -->
<!-- blockers:end -->
```

An empty block is a positive statement ("I looked and found none") and is what lets an automated review loop recognize the work as finished and stop. Omitting the block is NOT read as "zero blockers" — it is indistinguishable from a response that simply forgot it, so it is treated as "unknown" and the loop keeps running further rounds that have nothing to fix.

The first bracket is the blocker's category — use exactly one of: `architectural`, `completion` (also file a `defect` blocker under `completion`), `shipping` (Publish-review shipping blockers — this is the category most Publish reviews will use), or `review-confidence`. The second bracket is who/what can resolve it — pick exactly one:
- `task-fixable`: another implementation round can address it (a missing feature, a bug, missing tests, a plan deviation).
- `environmental`: an infrastructure/sandbox/OS issue unrelated to the task's code (e.g. a filesystem permission race in test cleanup) — not something re-implementing the task will fix.
- `unverifiable`: you could not confirm readiness due to your own limits (truncated context, no verified evidence available) — not a code defect.
- `spec-defect`: the acceptance criterion itself cannot be satisfied as written in this environment (e.g. "all tests pass" when one pre-existing test can never pass here) — not something any implementation of this task can fix.
- `needs-toolchain`: resolving the blocker requires actually running the project's own build, codegen, or other toolchain step (e.g. `npm run build`, a generator script, a dependency install such as `npm install`/`pnpm install`, or any other required command execution) — not editing source further. The implementation stage runs edit-only with Bash denied, so it structurally cannot execute that step itself. Use this instead of `task-fixable` when the fix is well-defined but requires a command to run, not more code changes (e.g. generated artifacts are stale relative to source and only regenerating them — not hand-editing them — would fix it; or a package is missing from `node_modules` and only installing it, not hand-editing the lockfile, would fix it).

**When every remaining unchecked plan item is blocked on something the stage structurally cannot do** — every one of them needs a dependency install, a build/codegen step, or other command execution the edit-only implementation stage cannot run — that is a completion blocker resolved by `needs-toolchain`, not a non-blocking suggestion. Filing it as a suggestion leaves the task with nothing to escalate on: the reviewer keeps reporting a clean round with items left unbuilt, and there is no automated exit. File it as `- [completion] [needs-toolchain]` so the routing logic can act on it.

Classify conservatively: default to `task-fixable` unless you have concrete evidence the blocker genuinely cannot be resolved by changing the task's code. A blocker whose actual resolution depends on something outside the task's own code — a third party's approval, a credential or account entitlement, evidence from a system the task does not control, or a decision only a human can make — is `environmental`, not `task-fixable`: it is an infrastructure/account fact unrelated to the task's code, and re-implementing the task again cannot produce that missing approval, credential, or evidence, however many times it is attempted.

## Blocker Lineage (re-review only)

When this prompt includes a "Previous Round's Blockers" list below (each entry showing an opaque id like `b3`), add a THIRD bracket to every line in the machine-readable blocker block, right after the resolver bracket, declaring how it relates to that list — exactly one of:

- `[new]` — this issue was not present in the previous round's list.
- `[same:<id>]` — this is the same underlying issue as prior blocker `<id>`, essentially unresolved since then.
- `[narrowed:<id>]` — this is prior blocker `<id>`, still present but demonstrably smaller in scope than before — say how in your prose.

Example:

```
- [completion] [task-fixable] [same:b3] the migration still lacks a rollback path
```

Cite the id EXACTLY as given in the list below — never invent one, and never guess at an id that isn't shown there. A blocker line with no lineage bracket, or that cites an id not present in that list, is read as lineage-unknown: it counts as neither "the same problem persisting" nor "a new one," so guessing wastes nothing but also proves nothing — cite honestly, or omit the bracket, rather than fabricate a citation. `resolved` is never declared directly by you: a previous id you do not cite anywhere in this round's block is understood by the caller as resolved, precisely because you stopped naming it.

When no "Previous Round's Blockers" list is provided below (a first review round, or a review stage that doesn't track lineage), omit the third bracket entirely — there is nothing yet to cite.
