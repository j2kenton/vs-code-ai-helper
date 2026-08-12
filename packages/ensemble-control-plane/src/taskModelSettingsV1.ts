/**
 * Task-scoped model settings (plan Part 9): the bridge between a task
 * record's validated `modelId` and the engine's Part 4b dispatch, which
 * resolves models from a `ModelSettings` snapshot.
 *
 * The task's selection becomes the GENERAL model chain's primary (the stage
 * every other stage inherits from), so one selection drives every round of
 * the run — matching the client's single "model" setting. The strategy is
 * deliberately `alert-and-wait`: an explicit user selection must never be
 * silently routed around by the quota fallback cascade; a failure surfaces
 * instead. A task with no selection falls through to the host's configured
 * defaults unchanged.
 */
import type { ModelSettings } from "../../ensemble-core/src/settingsV1";
import { GENERAL_MODEL_STAGE_V1 } from "../../ensemble-engine/src/modelChainV1";
import type { ControlPlaneTaskRecordV1 } from "./storeV1";

export function taskModelSettingsV1(
  task: Pick<ControlPlaneTaskRecordV1, "modelId">,
  hostDefaults?: ModelSettings
): ModelSettings {
  if (task.modelId === undefined) {
    return hostDefaults ?? {};
  }
  return {
    ...(hostDefaults ?? {}),
    [GENERAL_MODEL_STAGE_V1]: { primary: task.modelId, strategy: "alert-and-wait" },
  };
}
