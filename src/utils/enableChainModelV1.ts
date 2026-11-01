/**
 * bugs4 Step 32 (item 31): switching a configured-but-switched-off model back on in a stage's
 * chain, so a Publish fix round that ran out of quota can be rerun on a backup the owner already
 * set up. Pure: it edits a copy of the stage's setting and never reads or writes any settings
 * store, project permission file or provider account.
 */
import type { StageModelSetting } from "./modelFallback";

export const ENABLE_PUBLISH_BACKUP_AND_RERUN_FIX_COMMAND_V1 = "vs-code-ai-helper.enablePublishBackupAndRerunFix";

export type EnableChainModelResultV1 =
  | {
      readonly kind: "enabled";
      readonly setting: StageModelSetting;
      /** The stored model id that was switched on. */
      readonly modelId: string;
      readonly row: "primary" | "backup";
    }
  /** The row is already on: what keeps the model out of the chain is outside this stage's row flags. */
  | { readonly kind: "already-enabled"; readonly modelId: string }
  | { readonly kind: "not-found" };

/** The model part of a stored id: `codex-cli:gpt-6.1-terra@high` and `gpt-6.1-terra@high` compare equal. */
function bareModelId(id: string): string {
  const trimmed = id.trim();
  const colon = trimmed.indexOf(":");
  return colon >= 0 ? trimmed.slice(colon + 1) : trimmed;
}

/** A chain label names a model by its bare id, optionally after a provider label ("devpass-code llm/x@high"). */
function labelNamesModel(label: string, modelId: string): boolean {
  const wanted = label.trim().toLowerCase();
  const stored = modelId.trim().toLowerCase();
  const bare = bareModelId(modelId).toLowerCase();
  if (wanted === "" || bare === "") return false;
  return wanted === stored || wanted === bare || wanted.endsWith(` ${bare}`) || wanted.endsWith(` ${stored}`);
}

/**
 * Switches on the first switched-off row (backups first, then the primary) whose model the label names.
 * A row that is already on yields `already-enabled` so the caller can say the cause lies elsewhere
 * (for example Provider Selection) rather than pretend it changed something.
 */
export function enableChainModelV1(setting: StageModelSetting | undefined, label: string): EnableChainModelResultV1 {
  if (setting === undefined) return { kind: "not-found" };
  const backups = Array.isArray(setting.backups) && setting.backups.length > 0 ? setting.backups : setting.backup ? [setting.backup] : [];
  let alreadyOn: string | undefined;
  for (let index = 0; index < backups.length; index++) {
    const modelId = backups[index]!;
    if (!labelNamesModel(label, modelId)) continue;
    if (setting.backupsEnabled?.[index] !== false) {
      alreadyOn ??= modelId;
      continue;
    }
    const flags = backups.map((_, i) => setting.backupsEnabled?.[i] !== false);
    flags[index] = true;
    // Absent means "every row on", matching how settings are stored elsewhere.
    const { backupsEnabled: _dropped, ...rest } = setting;
    void _dropped;
    return {
      kind: "enabled",
      modelId,
      row: "backup",
      setting: { ...rest, backups: [...backups], ...(flags.some((flag) => flag === false) ? { backupsEnabled: flags } : {}) },
    };
  }
  if (setting.primary !== undefined && labelNamesModel(label, setting.primary)) {
    if (setting.primaryEnabled !== false) return { kind: "already-enabled", modelId: alreadyOn ?? setting.primary };
    const { primaryEnabled: _dropped, ...rest } = setting;
    void _dropped;
    return { kind: "enabled", modelId: setting.primary, row: "primary", setting: rest };
  }
  return alreadyOn !== undefined ? { kind: "already-enabled", modelId: alreadyOn } : { kind: "not-found" };
}

/** Whether a configured model's provider can run right now (installed and signed in), with the reason when not. */
export type ChainModelReadinessProbeV1 = (modelId: string) => Promise<{ readonly ready: boolean; readonly reason?: string }>;

export interface SwitchedOffBackupReadinessV1 {
  /** Switched-off backups whose provider is installed and signed in: safe to offer "Enable ... and rerun". */
  readonly ready: readonly string[];
  /** Switched-off backups that would fail again, with the reason, so the card can say why it does not offer them. */
  readonly notReady: readonly { readonly label: string; readonly reason: string }[];
}

/**
 * Splits the failure text's switched-off backups into those the owner can enable and rerun on right
 * now and those whose provider is not usable (not installed, not signed in, or no longer in the
 * chain). A probe error counts as not ready: offering a model that cannot run repeats the failure.
 */
export async function partitionSwitchedOffBackupsByReadinessV1(
  setting: StageModelSetting | undefined,
  labels: readonly string[],
  probe: ChainModelReadinessProbeV1
): Promise<SwitchedOffBackupReadinessV1> {
  const ready: string[] = [];
  const notReady: { label: string; reason: string }[] = [];
  for (const label of labels) {
    const resolved = enableChainModelV1(setting, label);
    if (resolved.kind !== "enabled") {
      notReady.push({
        label,
        reason: resolved.kind === "already-enabled" ? "it is already switched on in this chain" : "it is not in the Publish chain any more",
      });
      continue;
    }
    try {
      const readiness = await probe(resolved.modelId);
      if (readiness.ready) ready.push(label);
      else notReady.push({ label, reason: readiness.reason?.trim() || "its provider is not available or not signed in" });
    } catch (error) {
      notReady.push({ label, reason: "its provider could not be checked (" + (error instanceof Error ? error.message : String(error)) + ")" });
    }
  }
  return { ready, notReady };
}
