/**
 * bugs6 item 23: a quota stop under "never-switch" deliberately does not move on to a backup. When a switched-on backup
 * was skipped for that reason, the stop's card says so, in words that name the backup and the box, and offers this:
 * turn "Fall back to backup models" on for the stage (an ordinary AI Models settings write, with the change stated on
 * the card before it is made) and retry the review.
 */
import * as vscode from "vscode";
import type { TaskStage } from "../types/taskProgress";
import type { ModelSettings, StageModelSetting } from "../utils/modelFallback";
import { enabledModelsOfStageV1, stageGroupLabelV1 } from "../utils/modelStageLabelsV1";
import { getModelSettings, setModelSettings } from "../config/settings";
import type { WorkflowDecisionCommandResultV1 } from "../types/workflowDecisionV1";

export const TURN_ON_FALLBACK_AND_RETRY_COMMAND_V1 = "vs-code-ai-helper.turnOnFallbackAndRetryV1";

/**
 * The switched-on backups of a stage that a quota stop skipped because its strategy is "never-switch": enabled backups,
 * other than the primary, that the stop's chain did not try. Empty under "switch-to-backup" (nothing was skipped by the
 * setting), and for backups the stop did try or whose provider is disabled.
 */
export function findBackupsSkippedByNeverSwitchV1(
  setting: StageModelSetting | undefined,
  triedModelIds: readonly string[],
  isProviderDisabled: (modelId: string) => boolean = () => false
): string[] {
  if (!setting || setting.strategy === "switch-to-backup") return [];
  const tried = new Set(triedModelIds);
  return enabledModelsOfStageV1(setting).filter(
    (modelId) => modelId !== setting.primary && !tried.has(modelId) && !isProviderDisabled(modelId)
  );
}

/** "Claude Opus 5.5 is a backup but 'Fall back to backup models' is off for Implementation › High-Level Code Review." */
export function describeSkippedBackupsV1(stage: TaskStage, labels: readonly string[]): string {
  if (labels.length === 0) return "";
  const subject = labels.length === 1 ? `${labels[0]} is a backup` : `${labels.join(" and ")} are backups`;
  return `${subject} but 'Fall back to backup models' is off for ${stageGroupLabelV1(stage)}, so ${labels.length === 1 ? "it was" : "they were"} not tried.`;
}

/** What the card's option says it will change, before it changes it. */
export function describeTurnOnFallbackConsequenceV1(stage: TaskStage, labels: readonly string[]): string {
  return (
    `Changes one AI Models setting: turns on "Fall back to backup models" for ${stageGroupLabelV1(stage)} (it is off now). ` +
    `Then retries the review that stopped; if its first model is still limited, it runs on ${labels.join(", then ")}. ` +
    "You can turn the box off again in AI Models."
  );
}

/** Returns the settings with "Fall back to backup models" on for `stage`; `undefined` when the stage has no entry to change. */
export function withFallbackOnV1(settings: ModelSettings, stage: TaskStage): ModelSettings | undefined {
  const entry = settings[stage];
  if (!entry) return undefined;
  return { ...settings, [stage]: { ...entry, strategy: "switch-to-backup" } };
}

export interface TurnOnFallbackAndRetryArgV1 {
  readonly taskFolderPath: string;
  readonly stage: TaskStage;
}

export async function turnOnFallbackAndRetryV1(arg: TurnOnFallbackAndRetryArgV1): Promise<WorkflowDecisionCommandResultV1> {
  const next = withFallbackOnV1(getModelSettings(), arg.stage);
  if (next === undefined) {
    return { outcome: "refused", message: `${stageGroupLabelV1(arg.stage)} has no model settings to change; open AI Models and add one.` };
  }
  await setModelSettings(next);
  await vscode.commands.executeCommand("vs-code-ai-helper.resumeAndRerunReview", { taskFolderPath: arg.taskFolderPath });
  return { outcome: "done" };
}

export function registerTurnOnFallbackAndRetryCommandV1(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(TURN_ON_FALLBACK_AND_RETRY_COMMAND_V1, (arg: TurnOnFallbackAndRetryArgV1) =>
      turnOnFallbackAndRetryV1(arg)
    )
  );
}
