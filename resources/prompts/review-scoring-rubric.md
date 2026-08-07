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

## Verified Checks

When a "## Verified Checks (ground truth)" section is present below, it was produced by the extension host actually running the project's lint/type-check/test commands — it is not a claim from the implementer and not something you are being asked to verify yourself. Treat its overall result as ground truth for whether the checks pass. Do not raise a review-confidence blocker, and do not lower the score, merely because you have no way to independently run the tests yourself — that limitation is now covered by this section, not by you. A failure quarantined there as a "known flake" is explicitly not an outstanding blocker; do not re-raise it as one. Only raise a blocker from this section when it reports a real (non-quarantined) failure, or when it reports checks could not be run at all.

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
- `needs-toolchain`: resolving the blocker requires actually running the project's own build, codegen, or other toolchain step (e.g. `npm run build`, a generator script) — not editing source further. The implementation stage runs edit-only with Bash denied, so it structurally cannot execute that step itself. Use this instead of `task-fixable` when the fix is well-defined but requires a command to run, not more code changes (e.g. generated artifacts are stale relative to source and only regenerating them — not hand-editing them — would fix it).

Classify conservatively: default to `task-fixable` unless you have concrete evidence the blocker genuinely cannot be resolved by changing the task's code. A blocker whose actual resolution depends on something outside the task's own code — a third party's approval, a credential or account entitlement, evidence from a system the task does not control, or a decision only a human can make — is `environmental`, not `task-fixable`: it is an infrastructure/account fact unrelated to the task's code, and re-implementing the task again cannot produce that missing approval, credential, or evidence, however many times it is attempted.
