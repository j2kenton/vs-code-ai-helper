# Creation seed fixture provenance

These fixtures record the exact `task.md` seed contents emitted at task creation before and after the `draft.v1` atomic cutover (plan §4.3 and §6.3).

Creation recovery (`TaskCreationStartupReconcilerV1`) uses these fixtures to classify legacy `creating` task folders conservatively (e.g. `pristine` when `task.md` matches an exact historical seed versus `preservable` when `task.md` has user-edited description text).

At every one of the four revisions `task-template.md` has ever had, `startNewTask.ts`'s inline fallback string (used when the bundled template file fails to read) was kept byte-identical to it — this is a general rule across the whole corpus below, not a one-off coincidence noted for a single row.

## Emitters and Seed Inventory

| Seed Fixture | Version | Description / Emitting Emitter | Provenance |
|---|---|---|---|
| `legacy-instructions-user-description-seed.md` | Legacy instructions/user description | Historical seed emitted when template included `# Instructions` and `# User's Description of the Task`. | **Pinned.** Byte-identical to `resources/prompts/task-template.md` as committed at `15d81a4` (`sha256:a417e5ca…`) — and, at that same revision, to `startNewTask.ts`'s inline fallback string too. |
| `legacy-single-body-task-seed.md` | Legacy single-body | Historical seed emitted when template had single `# Task` section without `## Task Description`. | **Pinned.** Byte-identical to `resources/prompts/task-template.md` as committed at `876cca8` (`sha256:e8b9ab91…`) — and, at that same revision, to `startNewTask.ts`'s inline fallback string too. |
| `legacy-early-inline-fallback-seed.md` | Legacy early inline fallback | Historical inline fallback template emitted by `startNewTask.ts`'s `loadTaskTemplate()` when the bundled `task-template.md` file failed to read, from the file's introduction at `486aab4` through `5c5c17c`. | **Pinned.** Byte-identical to `resources/prompts/task-template.md` as committed at `486aab4` — the oldest committed revision of that file — and to the `return \`...\`;` fallback string in `src/commands/startNewTask.ts` at the same and later revisions (`sha256:83a43f9a…`). |
| `v1-canonical-seed.md` | V1 Canonical | Canonical seed emitted by `resources/prompts/task-template.md` and `startNewTask.ts` inline fallback after `draft.v1` cutover. Contains `# Task`, `## Task Description`, `## Draft with AI`, UTF-8 without BOM, LF line endings (`\n`), and one final newline. Omits `## Open Questions`. | **Pinned.** Byte-identical to `resources/prompts/task-template.md` as committed at `3e467f7` (current; `sha256:2175edf8…`). |

`sha256` prefixes above are the first 8 hex characters of each fixture's content digest, matching the `liveSha256` values recorded for the corresponding `resources/prompts/creation-seed-legacy-*.md` shipped copies in `workflow-inventories/workflow-production-source-annotations-v1.json`.

### Removed: `legacy-pre-draft-cutover-seed.md`

An earlier revision of this corpus carried a fifth row, `legacy-pre-draft-cutover-seed.md`, as a representative reconstruction of the pre-`draft.v1` format (active `## Open Questions` section). It was never a byte-for-byte extraction of a real historical blob — an exhaustive search of every commit touching `resources/prompts/task-template.md` and the `startNewTask.ts` inline fallback (`git log -p --follow`) found exactly four `task.md` seed shapes the extension ever actually emitted: the three legacy rows above and the current `v1-canonical` row. None matched the reconstructed row's digest. Since `TaskCreationStartupReconcilerV1`'s `pristine` classification requires "an exact recorded historical seed" (plan §4.3) and is the one class Safe-Delete recovery will treat as adoption-eligible, an unverifiable reconstruction was removed from the corpus rather than kept as a best-effort match — see `src/services/taskCreationSeedHistoryV1.ts`'s header comment for the same finding recorded at the code that reads this corpus.
