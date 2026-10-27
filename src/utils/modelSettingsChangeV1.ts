import { AI_MODEL_STAGES, TaskStage } from "../types/taskProgress";
import { ModelSettings, StageModelSetting } from "./modelFallback";

function normalizedStage(setting: StageModelSetting | undefined): Record<string, unknown> {
  if (!setting) return {};
  const backups = Array.isArray(setting.backups) && setting.backups.length > 0
    ? setting.backups
    : setting.backup ? [setting.backup] : [];
  return {
    primary: setting.primary ?? null,
    primaryEnabled: setting.primaryEnabled !== false,
    backups,
    backupsEnabled: backups.map((_, index) => setting.backupsEnabled?.[index] !== false),
    strategy: setting.strategy === "switch-to-backup" ? "switch-to-backup" : "never-switch",
  };
}

export function modelSettingsFingerprintV1(settings: ModelSettings): string {
  return JSON.stringify(Object.fromEntries(AI_MODEL_STAGES.map((stage) => [stage, normalizedStage(settings[stage])])));
}

export function changedModelSettingStagesV1(before: ModelSettings, after: ModelSettings): TaskStage[] {
  return AI_MODEL_STAGES.filter((stage) =>
    JSON.stringify(normalizedStage(before[stage])) !== JSON.stringify(normalizedStage(after[stage]))
  );
}

const localWriteFingerprints = new Map<string, number>();

export function markLocalModelSettingsWriteV1(settings: ModelSettings): string {
  const fingerprint = modelSettingsFingerprintV1(settings);
  localWriteFingerprints.set(fingerprint, (localWriteFingerprints.get(fingerprint) ?? 0) + 1);
  return fingerprint;
}

export function cancelLocalModelSettingsWriteV1(fingerprint: string): void {
  const count = localWriteFingerprints.get(fingerprint) ?? 0;
  if (count <= 1) localWriteFingerprints.delete(fingerprint);
  else localWriteFingerprints.set(fingerprint, count - 1);
}

export function consumeLocalModelSettingsWriteV1(settings: ModelSettings): boolean {
  const fingerprint = modelSettingsFingerprintV1(settings);
  if (!localWriteFingerprints.has(fingerprint)) return false;
  cancelLocalModelSettingsWriteV1(fingerprint);
  return true;
}
