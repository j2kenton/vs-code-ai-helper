/**
 * bugs5 Step 25 (item 5): a remembered fallback is a per-task pin ("this stage ran on its backup last time")
 * that `resolveModelForStage` honours so a later round skips a known-failing primary. A pin must not outlive
 * the chain it was made for, or the owner's change in AI Models is ignored for the rest of a run.
 *
 * Pure: no `vscode`, no I/O. `modelSelection.ts` reads and clears the pin; `runnerRegistry.ts` writes it.
 */
import { createHash } from "node:crypto";
import type { TaskProgress, TaskStage } from "../types/taskProgress";

export interface StageChainForFingerprintV1 {
  readonly strategy?: string;
  readonly primary?: string;
  readonly backups: readonly string[];
}

/**
 * A short, stable fingerprint of a stage's effective chain: its strategy, its candidates in order, and
 * whether each candidate's provider is enabled. Any change to the primary, the backups, their order or
 * their enabled flags gives a different value.
 */
export function fingerprintStageChainV1(
  chain: StageChainForFingerprintV1,
  isProviderEnabled: (modelId: string) => boolean = () => true
): string {
  const candidates = [chain.primary, ...chain.backups]
    .filter((id): id is string => id !== undefined)
    .map((id) => `${id}${isProviderEnabled(id) ? "" : "!off"}`);
  return createHash("sha256")
    .update(JSON.stringify({ strategy: chain.strategy ?? null, candidates }))
    .digest("hex")
    .slice(0, 16);
}

export type RememberedFallbackVerdictV1 =
  | { readonly kind: "none" }
  | { readonly kind: "keep"; readonly legacy: boolean }
  | { readonly kind: "clear"; readonly reason: string };

/**
 * Whether the pin recorded for `stage` still applies. It is cleared when the chain it was made for has
 * changed, or when the provider's own reset time has passed. A named pin written before the fingerprint
 * field existed cannot be compared with the current chain, so it is cleared too: the dispatch starts at the
 * chain's primary and, if that fails again, re-pins with a fingerprint. A bare reservation (no model named
 * yet) belongs to a concurrent run and is left alone.
 */
export function judgeRememberedFallbackV1(input: {
  readonly progress: Pick<
    TaskProgress,
    "fallbackActive" | "fallbackModelId" | "fallbackChainFingerprint" | "fallbackResetTime"
  >;
  readonly stage: TaskStage;
  readonly currentFingerprint: string;
  readonly now: Date;
}): RememberedFallbackVerdictV1 {
  const { progress, stage } = input;
  if (!progress.fallbackActive?.[stage]) {
    return { kind: "none" };
  }
  const remembered = progress.fallbackChainFingerprint?.[stage];
  if (remembered === undefined && progress.fallbackModelId?.[stage] !== undefined) {
    return {
      kind: "clear",
      reason: "it was remembered by an older version, so it cannot be checked against the current model chain",
    };
  }
  if (remembered !== undefined && remembered !== input.currentFingerprint) {
    return { kind: "clear", reason: "the stage's model chain was changed in AI Models after the fallback was remembered" };
  }
  const resetTime = progress.fallbackResetTime?.[stage];
  if (resetTime !== undefined) {
    const resetMs = Date.parse(resetTime);
    if (Number.isFinite(resetMs) && resetMs <= input.now.getTime()) {
      return { kind: "clear", reason: `the provider's reset time (${resetTime}) has passed` };
    }
  }
  return { kind: "keep", legacy: remembered === undefined };
}

export interface SkippedCandidateV1 {
  readonly modelId: string;
  readonly reason: string;
}

export interface RememberedFallbackListItemV1 {
  readonly taskFolderPath: string;
  readonly taskName: string;
  readonly stage: TaskStage;
  /** The model the stage is pinned to, as the owner sees it. */
  readonly modelLabel: string;
  /** "remembered after DevPass failed at 04:54 (HTTP 402)", or a plain note for a pin with no recorded cause. */
  readonly cause: string;
}

/**
 * The remembered fallbacks on open tasks, for AI Models: one item per pinned stage with a named model.
 * Completed tasks are left out. `label` names a stored model id the way the owner sees it.
 */
export function listRememberedFallbacksV1(
  tasks: ReadonlyArray<{ readonly folderPath: string; readonly name: string; readonly progress: TaskProgress }>,
  label: (modelId: string) => string
): RememberedFallbackListItemV1[] {
  const items: RememberedFallbackListItemV1[] = [];
  for (const task of tasks) {
    if (task.progress.status === "completed") {
      continue;
    }
    for (const stage of Object.keys(task.progress.fallbackActive ?? {}) as TaskStage[]) {
      const modelId = task.progress.fallbackModelId?.[stage];
      if (!task.progress.fallbackActive?.[stage] || modelId === undefined) {
        continue;
      }
      const failed = task.progress.fallbackFailedModelId?.[stage];
      const at = clockV1(task.progress.fallbackFailedAt?.[stage]);
      const reason = task.progress.fallbackFailureReason?.[stage];
      items.push({
        taskFolderPath: task.folderPath,
        taskName: task.name,
        stage,
        modelLabel: label(modelId),
        cause: failed
          ? `remembered after ${label(failed)} failed${at ? ` at ${at}` : ""}${reason ? ` (${reason})` : ""}`
          : "remembered from an earlier round",
      });
    }
  }
  return items;
}

export interface ConfiguredCandidateV1 {
  readonly modelId: string;
  /** The enabled flag the owner set for this entry in AI Models. */
  readonly enabled: boolean;
}

/**
 * Configured candidates that the chain passes over, each with the plain reason: switched off in AI Models, its
 * provider switched off in Provider Selection, or a quota block on its account that has not reset yet.
 * `quotaBlockedUntil` answers for a model id with the reset time (or `"unknown"`) when its account is blocked.
 * The `chosenModelId` is never listed.
 */
export function collectSkippedCandidatesV1(input: {
  readonly configured: readonly ConfiguredCandidateV1[];
  readonly chosenModelId?: string;
  readonly isProviderEnabled: (modelId: string) => boolean;
  readonly quotaBlockedUntil?: (modelId: string) => string | undefined;
  /**
   * The reason this model cannot run the stage's kind of work (for example a backup that cannot do unattended
   * code edits), or `undefined` when it can.
   */
  readonly modeUnsupportedReason?: (modelId: string) => string | undefined;
}): SkippedCandidateV1[] {
  const skipped: SkippedCandidateV1[] = [];
  for (const candidate of input.configured) {
    if (candidate.modelId === input.chosenModelId) {
      continue;
    }
    if (!candidate.enabled) {
      skipped.push({ modelId: candidate.modelId, reason: "switched off in AI Models" });
    } else if (!input.isProviderEnabled(candidate.modelId)) {
      skipped.push({ modelId: candidate.modelId, reason: "its provider is switched off in Provider Selection" });
    } else if (input.modeUnsupportedReason?.(candidate.modelId) !== undefined) {
      skipped.push({ modelId: candidate.modelId, reason: input.modeUnsupportedReason(candidate.modelId) as string });
    } else {
      const blockedUntil = input.quotaBlockedUntil?.(candidate.modelId);
      if (blockedUntil !== undefined) {
        skipped.push({
          modelId: candidate.modelId,
          reason: blockedUntil === "unknown" ? "quota reached" : `quota reached, resets ${blockedUntil}`,
        });
      }
    }
  }
  return skipped;
}

/** "Not used: Kimi K3.1 (its provider is switched off in Provider Selection); DevPass (quota reached)". */
export function describeSkippedCandidatesV1(
  skipped: readonly SkippedCandidateV1[],
  label: (modelId: string) => string
): string | undefined {
  const reasoned = skipped.filter((s) => !s.reason.startsWith("not tried:"));
  if (reasoned.length === 0) {
    return undefined;
  }
  return `not used: ${reasoned.map((s) => `${label(s.modelId)} (${s.reason})`).join("; ")}`;
}

export interface RememberedFallbackInfoV1 {
  readonly modelId: string;
  readonly failedModelId?: string;
  readonly failureReason?: string;
  readonly failedAt?: string;
}

function clockV1(iso: string | undefined): string | undefined {
  const date = iso ? new Date(iso) : undefined;
  if (!date || Number.isNaN(date.getTime())) {
    return undefined;
  }
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * "using Claude Code, remembered after DevPass failed at 04:54 (HTTP 402); Kimi K3.1 not tried".
 * `label` names a stored model id the way the owner sees it.
 */
export function describeRememberedFallbackV1(
  info: RememberedFallbackInfoV1,
  skipped: readonly SkippedCandidateV1[],
  label: (modelId: string) => string
): string {
  const at = clockV1(info.failedAt);
  const cause = info.failedModelId
    ? `remembered after ${label(info.failedModelId)} failed${at ? ` at ${at}` : ""}${info.failureReason ? ` (${info.failureReason})` : ""}`
    : "remembered from an earlier round (set by an older version)";
  const notTried = skipped.filter((s) => s.modelId !== info.failedModelId).map((s) => `${label(s.modelId)} not tried`);
  return `using ${label(info.modelId)}, ${cause}${notTried.length > 0 ? `; ${notTried.join("; ")}` : ""}`;
}

// The latest note about how a stage's model was chosen, per task folder and stage. `resolveModelForStage`
// sets it; the round's invocation message and run log read it.
const notesV1 = new Map<string, string>();

function noteKeyV1(taskFolderPath: string, stage: TaskStage): string {
  return `${taskFolderPath}\u0000${stage}`;
}

export function setModelResolutionNoteV1(taskFolderPath: string, stage: TaskStage, note: string | undefined): void {
  const key = noteKeyV1(taskFolderPath, stage);
  if (note === undefined) {
    notesV1.delete(key);
  } else {
    notesV1.set(key, note);
    if (notesV1.size > 200) {
      notesV1.delete(notesV1.keys().next().value ?? key);
    }
  }
}

export function getModelResolutionNoteV1(taskFolderPath: string, stage: TaskStage): string | undefined {
  return notesV1.get(noteKeyV1(taskFolderPath, stage));
}
