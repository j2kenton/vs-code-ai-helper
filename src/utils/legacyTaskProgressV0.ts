/**
 * Named legacy boundary for the permissive task-progress reader/writer
 * (plan §3.12 step 1).
 *
 * `utils/taskProgressUtils` normalizes malformed/legacy values on read and
 * returns undefined for invalid progress — behavior the strict V1 progress
 * stack (plan §3.10) replaces with fail-closed decoding. Until each consumer
 * cohort migrates, the permissive surface stays exactly as it is; this
 * module only gives it its plan-mandated V0 name so the retirement boundary
 * is visible in imports and enforceable by verify:progress-reader-fence.
 *
 * NO BEHAVIOR CHANGE: every member is the original function by reference.
 * V1 modules (coordinator, registry rows, lifecycle actions, creation
 * reconciler/recovery, completed-task Resume, field policy, strict writers)
 * are prohibited from importing this module OR taskProgressUtils directly —
 * scripts/verifyProgressReaderFence.mjs fails the build on any such import.
 * Existing consumers keep their direct taskProgressUtils imports and are
 * tracked, cohort by cohort, in
 * workflow-inventories/task-progress-fields-v1.json.
 *
 * The pure in-memory transformers (updateTaskStatus, updateImplReviewFiles,
 * ...) are not part of this boundary: they neither read nor write disk and
 * retire with their owning cohorts.
 */
import {
  createTaskProgress,
  findAllTasks,
  findIncompleteTasks,
  patchTaskProgress,
  readTaskProgress,
  writeTaskProgress,
} from "./taskProgressUtils";

/** The permissive read surface §3.12 retires by consumer cohort. */
export const LegacyTaskProgressReaderV0 = {
  readTaskProgress,
  findAllTasks,
  findIncompleteTasks,
} as const;

/** The permissive write surface §3.12 retires by consumer cohort. */
export const LegacyTaskProgressWriterV0 = {
  writeTaskProgress,
  patchTaskProgress,
  createTaskProgress,
} as const;
