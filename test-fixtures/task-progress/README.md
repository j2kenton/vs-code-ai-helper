# Task-progress fixture provenance

Every fixture here must name the production writer (or historical format
family) whose persisted output it reproduces. The strict decoder's rules are
checked-in **evidence** only when its fixtures come from what the shipping
writers actually emit — hand-authored "idealized" documents once let the
decoder reject the only shapes production ever wrote (`completedStages:
["publish"]` from `markTaskDone`, and `completedAt` alongside a non-completed
status from `resumeArchivedTask`) while every suite stayed green. When adding
a fixture, record its producing writer below; if no production writer emits
the shape, say so explicitly and justify the fixture another way.

## legacy/ (workspace-legacy-v0 — decodes strictly)

| Fixture | Producing writer / scenario |
|---|---|
| `minimal.json` | Minimal historical creation footprint: only the fields every legacy emitter always wrote (`taskFolder`, `currentStage`, timestamps); `status` absent means active per the declaration. |
| `full.json` | Composite of the current permissive writers' full field surface (`patchTaskProgress` spread from lint/schedule/fallback/escalation/pin/review paths) plus an opaque vendor property. The contiguous `completedStages` prefix is hand-authored to exercise already-prefix input; the emitter-real gapped shape is `completed-mark-task-done.json`. |
| `envelope.json` | Historical `{ schemaVersion, data }` wrapper family with a legacy stage alias (`plan-final`) and an opaque property inside the envelope. |
| `stage-alias.json` | Historical emitter using the `task-description` stage alias; paused status; empty `completedStages`. |
| `completed-stage-alias.json` | Historical synthetic `currentStage: "completed"` family with `completedAt` as the completion evidence. |
| `completed-mark-task-done.json` | **Exact `markTaskDone.ts` output** (`patchTaskProgress` at `src/commands/markTaskDone.ts:184`): `status: "completed"`, `completedAt`, `completedStages: ["publish"]` — the only non-empty `completedStages` value production has ever written. Decodes with the prefix backfilled through `publish`. |
| `resumed-from-archive.json` | **Exact persisted output of the resume write path**: `resumeArchivedTask` (`src/commands/archiveTask.ts`) → `activateTask(..., mutateTarget)` → `patchTaskProgress`, which composes `updateTaskStatus(mutateTarget(current), "active")` into one write. A completed task archived then resumed — `status: "active"` set by the activation write, `completedAt` preserved as inert historical metadata, and `displayName`/`nameIsDefault` carried through the spread from creation (resume never writes them). No `archivedFrom` key: resume's `mutateTarget` sets it `undefined` (`archiveTask.ts:205`) and `patchTaskProgress`'s `JSON.stringify` drops it, so an active document carrying `archivedFrom` is a shape production never persists. |

## v1/ (ensemble-v1 — decodes strictly)

| Fixture | Producing writer / scenario |
|---|---|
| `valid.json` | Canonical strict-writer output (`encodeTaskProgressV1`) for a completed task, plus an opaque vendor property. |
| `round-ledger-and-review-fields.json` | Hand-authored to exercise every field the "make the stage chat a record of work" task's Parts 1–6 added to `reviewScoreHistory` (`blockers[].origin`, `supersededBlockers`, `reviewerChallengedNonGoal`), `blockerSupersessions[].source`, `roundOutcomes[].dispatchMode`/`originatingReviewStage`, `roundLedger[].checklistRevisionAdopted`, `checklistChangeProposals[].ledgerAnnotated`, and `implRecovery.sourceDispatchMode`/`sourceReviewStage`/`sourceRoundId` — a 2026-08-28 review found the core package's strict decoder rejected several of these as unknown properties even though the extension writes and accepts them; this fixture is the regression guard for that parity gap, not a captured single writer's output. |

## recovery/ (fails closed)

| Fixture | Scenario |
|---|---|
| `unknown-ensemble-field.json` | Unknown reserved `ensemble*` property. |
| `scalar-fallback-active.json` | Scalar `fallbackActive` (the persisted shape is only ever the per-stage map). |
| `version-string.json` | `ensembleProgressVersion` present but not the exact integer 1. |
| `schedule-alias-conflict.json` | `scheduledRun` and its deprecated alias `scheduledResumeTime` both present. |
| `unknown-stage.json` | Unrecognized `currentStage` value (the permissive reader coerces to `desc`; strict decode must not). |

No production writer emits any recovery/ shape; each reproduces corruption or
a future/unknown format the decoder must refuse to normalize.

## transitions/ (decode → field policy → encode)

| Fixture | Input provenance |
|---|---|
| `next-stage-basic.json` | Mid-flight active task with a hand-authored prefix and an opaque property; exercises `applyNextStagePolicyV1`. |
| `next-stage-consumes-runtime-state.json` | Active task carrying every consumable runtime field (lint, schedule, review attempt, escalation, fallback). |
| `mark-task-done-basic.json` | Real pre-completion state: Publish-stage active task with **no** `completedStages` (nothing writes a tick before the terminal action). |
| `reopen-at-publish.json` | Real completed task (`markTaskDone` output, `completedStages: ["publish"]`) reopened at Publish. User-visible on the Resume-cohort cutover: today's permissive path leaves this task with zero completion ticks, while the strict path backfills then retains the seven pre-Publish ticks — a deliberate composition of §3.11's migration and Reopen rules, not drift. |
| `reopen-at-impl.json` | Real completed task reopened at Implementation, with existing fallback reservations to flip. |
| `reopen-at-impl-high-review.json` | Real completed task reopened at High-Level Code Review; impl review scope survives. |
| `next-stage-configured-skip.json` | Active task mid-Plan with a configured optional-review-stage skip (`targetStage: "impl"` bypassing `plan-high-review`); exercises `nextStageRowV1`'s `targetStage` CAS — only `plan` is ticked and only its `fallbackActive` entry is deactivated, the skipped review stage's fallback entry is left untouched. |
