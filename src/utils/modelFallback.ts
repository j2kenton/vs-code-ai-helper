import type { TaskStage } from "../types/taskProgress";

export type FallbackStrategy = "switch-to-backup" | "pause-and-resume" | "alert-and-wait";

export interface StageModelSetting {
  primary?: string;
  backup?: string;
  strategy: FallbackStrategy;
}

export type ModelSettings = Partial<Record<TaskStage, StageModelSetting>>;

export function canUseBackup(setting: StageModelSetting | undefined): boolean {
  return Boolean(setting?.strategy === "switch-to-backup" && setting.backup && setting.backup !== setting.primary);
}

export function chooseFallback(setting: StageModelSetting | undefined): "backup" | "pause" | "alert" {
  if (!setting || !canUseBackup(setting)) return "alert";
  if (setting.strategy === "switch-to-backup") return "backup";
  if (setting.strategy === "pause-and-resume") return "pause";
  return "alert";
}
