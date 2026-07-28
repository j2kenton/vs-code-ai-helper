# Creation seed fixture provenance

These fixtures record the exact `task.md` seed contents emitted at task creation before and after the `draft.v1` atomic cutover (plan §4.3 and §6.3).

Creation recovery (`TaskCreationStartupReconcilerV1`) uses these fixtures to classify legacy `creating` task folders conservatively (e.g. `pristine` when `task.md` matches an exact historical seed versus `preservable` when `task.md` has user-edited description text).

## Emitters and Seed Inventory

| Seed Fixture | Version | Description / Emitting Emitter |
|---|---|---|
| `legacy-pre-draft-cutover-seed.md` | Legacy pre-cutover | Historical seed emitted prior to `draft.v1` cutover. Includes active `## Open Questions` section. |
| `legacy-instructions-user-description-seed.md` | Legacy instructions/user description | Historical seed emitted when template included `# Instructions` and `# User's Description of the Task`. |
| `legacy-single-body-task-seed.md` | Legacy single-body | Historical seed emitted when template had single `# Task` section without `## Task Description`. |
| `legacy-early-inline-fallback-seed.md` | Legacy early inline fallback | Historical inline fallback template emitted when template file read failed in early extension versions. |
| `v1-canonical-seed.md` | V1 Canonical | Canonical seed emitted by `resources/prompts/task-template.md` and `startNewTask.ts` inline fallback after `draft.v1` cutover. Contains `# Task`, `## Task Description`, `## Draft with AI`, UTF-8 without BOM, LF line endings (`\n`), and one final newline. Omits `## Open Questions`. |
