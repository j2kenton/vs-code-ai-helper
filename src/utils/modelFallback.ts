import type { TaskStage } from "../types/taskProgress";

export type FallbackStrategy = "switch-to-backup" | "pause-and-resume" | "alert-and-wait";

export interface StageModelSetting {
  primary?: string;
  /** Ordered alternatives tried after the primary. `backup` is retained for migration. */
  backups?: string[];
  backup?: string;
  strategy: FallbackStrategy;
}

export type ModelSettings = Partial<Record<TaskStage, StageModelSetting>>;

export function canUseBackup(setting: StageModelSetting | undefined): boolean {
  return Boolean(setting?.strategy === "switch-to-backup" && getBackupModels(setting).some(model => model !== setting.primary));
}

export function getBackupModels(setting: StageModelSetting | undefined): string[] {
  if (!setting) return [];
  const values = [...(Array.isArray(setting.backups) ? setting.backups : []), setting.backup];
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map(value => value.trim()))];
}

export function chooseFallback(setting: StageModelSetting | undefined): "backup" | "pause" | "alert" {
  if (!setting || !canUseBackup(setting)) return "alert";
  if (setting.strategy === "switch-to-backup") return "backup";
  if (setting.strategy === "pause-and-resume") return "pause";
  return "alert";
}
