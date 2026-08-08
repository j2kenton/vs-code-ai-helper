import type { TaskStage } from "../types/taskProgress";

export type FallbackStrategy = "switch-to-backup" | "pause-and-resume" | "alert-and-wait";

export interface StageModelSetting {
  primary?: string;
  /** Ordered alternatives tried after the primary. `backup` is retained for migration. */
  backups?: string[];
  backup?: string;
  /**
   * false = skip the primary during resolution while keeping its configured
   * model. Absent means enabled, so existing stored settings stay valid with
   * no migration.
   */
  primaryEnabled?: boolean;
  /**
   * Per-row skip flags, index-aligned with `backups`. A false at index i
   * means "skip backups[i] during resolution" — the row keeps its configured
   * model and its position, it is simply passed over. Absent (or a missing
   * index) means enabled.
   */
  backupsEnabled?: boolean[];
  strategy: FallbackStrategy;
}

export type ModelSettings = Partial<Record<TaskStage, StageModelSetting>>;

export function canUseBackup(setting: StageModelSetting | undefined): boolean {
  return Boolean(setting?.strategy === "switch-to-backup" && getBackupModels(setting).some(model => model !== setting.primary));
}

/**
 * Normalize a backup chain while keeping `backupsEnabled` index-aligned with
 * `backups`: entries are trimmed/normalized, empties and duplicates dropped,
 * and the flag at the same index is spliced out in the same operation, so the
 * two arrays can never drift out of alignment. Flags default to enabled;
 * `backupsEnabled` is omitted from the result entirely when every row is
 * enabled, so stored settings only carry the field when it says something.
 * Shared by the save path (setModelSettings) and the read side
 * (getModelSettings), which the effective-chain resolver consumes.
 */
export function normalizeBackupChain(
  rawBackups: readonly unknown[] | undefined,
  rawFlags: readonly unknown[] | undefined,
  normalizeId: (value: string) => string | undefined = (value) => value,
  cap = 10
): { backups: string[]; backupsEnabled?: boolean[] } {
  const backups: string[] = [];
  const flags: boolean[] = [];
  const seen = new Set<string>();
  (rawBackups ?? []).forEach((value, index) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      return;
    }
    const normalized = normalizeId(value.trim());
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    backups.push(normalized);
    flags.push(!(rawFlags && rawFlags[index] === false));
  });
  const capped = backups.slice(0, cap);
  const cappedFlags = flags.slice(0, cap);
  return cappedFlags.some((flag) => !flag)
    ? { backups: capped, backupsEnabled: cappedFlags }
    : { backups: capped };
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
