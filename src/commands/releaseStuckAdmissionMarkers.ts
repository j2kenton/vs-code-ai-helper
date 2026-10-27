import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { NotificationRouter } from "../utils/notificationRouter";
import {
  readHeldAdmissionMarkerForTaskV1,
  stopHeldAdmissionMarkerAndReleaseV1,
  confirmNoProcessAndReleaseHeldAdmissionMarkerV1,
  type HeldAdmissionMarkerInfoV1,
} from "../state/workAdmissionV1";
import { describeSurvivingRecordedProcessV1 } from "../state/recordedCliStopV1";
import type { RoundProcessStateV1 } from "../types/agentExecutionV1";
import { TaskStage } from "../types/taskProgress";
import {
  CreateWorkflowDecisionInputV1,
  WorkflowDecisionCommandResultV1,
  WorkflowDecisionOptionV1,
} from "../types/workflowDecisionV1";
import { postWorkflowDecisionV1 } from "../utils/workflowDecisionDispatchV1";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { formatNotificationTaskLabelV1 } from "../utils/notificationTaskContextV1";
import type { ChatTarget } from "../views/chatView";

export const RELEASE_STUCK_ADMISSION_STALE_MS_V1 = 20 * 60 * 1000;

const MARKER_RE_V1 = /^admission\.([0-9a-z-]+)\.g(\d+)\.([0-9a-z]+)$/;
const SKIP_DIRS_V1 = new Set([".git", "node_modules", "out", "out-test", "dist"]);

export interface StaleAdmissionMarkerCandidateV1 {
  readonly filePath: string;
  readonly basename: string;
  readonly admissionDirPath: string;
  readonly workspaceRelativePath: string;
  readonly mtimeMs: number;
}

export function isAdmissionMarkerBasenameForReleaseV1(basename: string): boolean {
  return MARKER_RE_V1.test(basename);
}

function isStaleAdmissionMarkerFileV1(
  filePath: string,
  nowMs: number,
  staleThresholdMs: number
): { readonly ok: true; readonly mtimeMs: number } | { readonly ok: false } {
  if (!isAdmissionMarkerBasenameForReleaseV1(path.basename(filePath))) {
    return { ok: false };
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    return { ok: false };
  }
  if (!stat.isFile()) {
    return { ok: false };
  }
  if (nowMs - stat.mtime.getTime() <= staleThresholdMs) {
    return { ok: false };
  }
  return { ok: true, mtimeMs: stat.mtime.getTime() };
}

function collectAdmissionDirsV1(rootPath: string): string[] {
  const dirs: string[] = [];
  const stack = [rootPath];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    if (path.basename(current) === "admission-v1") {
      dirs.push(current);
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS_V1.has(entry.name)) {
        continue;
      }
      stack.push(path.join(current, entry.name));
    }
  }

  return dirs;
}

export function findStaleAdmissionMarkersForReleaseV1(
  workspaceRootPath: string,
  nowMs: number = Date.now(),
  staleThresholdMs: number = RELEASE_STUCK_ADMISSION_STALE_MS_V1
): StaleAdmissionMarkerCandidateV1[] {
  const candidates: StaleAdmissionMarkerCandidateV1[] = [];
  for (const admissionDirPath of collectAdmissionDirsV1(workspaceRootPath)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(admissionDirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !isAdmissionMarkerBasenameForReleaseV1(entry.name)) {
        continue;
      }
      const filePath = path.join(admissionDirPath, entry.name);
      const stale = isStaleAdmissionMarkerFileV1(filePath, nowMs, staleThresholdMs);
      if (stale.ok) {
        candidates.push({
          filePath,
          basename: entry.name,
          admissionDirPath,
          workspaceRelativePath: path.relative(workspaceRootPath, filePath),
          mtimeMs: stale.mtimeMs,
        });
      }
    }
  }
  return candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

export interface HeldAdmissionMarkerCandidateV1 {
  readonly taskFolderPath: string;
  readonly workspaceRelativePath: string;
  readonly info: HeldAdmissionMarkerInfoV1;
}

/**
 * Step 57a: markers held past their owner's own terminal release (a provider
 * process that may still be running) are listed here REGARDLESS of the
 * ordinary 20-minute staleness threshold — such a marker is heartbeat-renewed
 * by its (still-alive) owning process while it waits for the process to exit,
 * so it would never appear in {@link findStaleAdmissionMarkersForReleaseV1}
 * at all, yet it is exactly the case a human may need to act on.
 */
export function findHeldAdmissionMarkersForReleaseV1(workspaceRootPath: string): HeldAdmissionMarkerCandidateV1[] {
  const candidates: HeldAdmissionMarkerCandidateV1[] = [];
  for (const admissionDirPath of collectAdmissionDirsV1(workspaceRootPath)) {
    const taskFolderPath = path.dirname(admissionDirPath);
    const info = readHeldAdmissionMarkerForTaskV1(taskFolderPath);
    if (info) {
      candidates.push({
        taskFolderPath,
        workspaceRelativePath: path.relative(workspaceRootPath, info.filePath),
        info,
      });
    }
  }
  return candidates;
}

/**
 * Step 57a: "routes them through the same card" — a held marker found by
 * "Release Stuck Admission Markers" is resolved through the exact same
 * "Provider process may still be running" chat card the proactive notifier
 * raises (`postHeldAdmissionMarkerCardV1`/`buildHeldAdmissionMarkerCardInputV1`),
 * not a second, separate modal flow with its own wording and options. This
 * command's job is only to surface a held marker the owner may not have seen
 * a notification for yet (e.g. after reopening the window) and point them at
 * the card; the card itself never auto-selects an action.
 */
async function resolveHeldAdmissionMarkerV1(candidate: HeldAdmissionMarkerCandidateV1): Promise<void> {
  const { taskFolderPath, workspaceRelativePath } = candidate;
  await postHeldAdmissionMarkerCardV1(taskFolderPath);
  let displayName: string | undefined;
  try {
    const readResult = await readTaskProgressStrictV1(vscode.Uri.file(taskFolderPath));
    displayName = readResult.ok ? readResult.decoded.progress.displayName : undefined;
  } catch {
    // Best-effort: fall back to the folder's own name.
  }
  const taskName = formatNotificationTaskLabelV1(displayName, taskFolderPath);
  NotificationRouter.showInformation(
    `Provider process may still be running for ${taskName} (${workspaceRelativePath}). Posted the "Provider ` +
      'process may still be running" card in that task\'s chat — decide there.'
  );
}

const STOP_HELD_ADMISSION_MARKER_COMMAND_V1 = "vs-code-ai-helper.stopHeldAdmissionMarkerAndRelease";
const CONFIRM_NO_PROCESS_RELEASE_HELD_ADMISSION_MARKER_COMMAND_V1 =
  "vs-code-ai-helper.confirmNoProcessAndReleaseHeldAdmissionMarker";

interface HeldAdmissionMarkerCommandArgV1 {
  readonly taskFolderPath: string;
  readonly claimId: string;
  readonly displayName?: string;
}

/**
 * Step 57a's "Stop it and release the task" option effect, exposed as a
 * registered command so the proactive chat card
 * (`buildHeldAdmissionMarkerCardInputV1`) can dispatch it like any other
 * `WorkflowDecisionOptionV1` — the same primitive
 * `resolveHeldAdmissionMarkerV1` already calls from "Release Stuck Admission
 * Markers", wrapped here to report `WorkflowDecisionCommandResultV1` instead
 * of showing its own notification (the card renders the message itself).
 */
export async function stopHeldAdmissionMarkerAndReleaseCommandV1(
  arg?: HeldAdmissionMarkerCommandArgV1
): Promise<WorkflowDecisionCommandResultV1> {
  if (!arg?.taskFolderPath || !arg.claimId) {
    return { outcome: "refused", message: "Missing task or claim information." };
  }
  const taskName = formatNotificationTaskLabelV1(arg.displayName, arg.taskFolderPath);
  const outcome = await stopHeldAdmissionMarkerAndReleaseV1(arg.taskFolderPath, arg.claimId);
  if (outcome.outcome === "released") {
    return { outcome: "done", message: `Stopped the provider process and released ${taskName}.` };
  }
  if (outcome.outcome === "markerGone") {
    return { outcome: "alreadyDone", message: `${taskName} was already released.` };
  }
  if (outcome.outcome === "stillHeld") {
    return {
      outcome: "refused",
      message: `Stopped the provider process for ${taskName}, but its admission marker is still being renewed. Try again.`,
    };
  }
  return {
    outcome: "refused",
    message: `Could not stop every provider process for ${taskName}: ${outcome.survivors
      .map(describeSurvivingRecordedProcessV1)
      .join("; ")}`,
  };
}

/**
 * Step 57a's "I have checked: no provider process for this task is running —
 * release the task" option effect for an `unconfirmedSpawn` hold, exposed the
 * same way as {@link stopHeldAdmissionMarkerAndReleaseCommandV1}.
 */
export async function confirmNoProcessAndReleaseHeldAdmissionMarkerCommandV1(
  arg?: HeldAdmissionMarkerCommandArgV1
): Promise<WorkflowDecisionCommandResultV1> {
  if (!arg?.taskFolderPath || !arg.claimId) {
    return { outcome: "refused", message: "Missing task or claim information." };
  }
  const taskName = formatNotificationTaskLabelV1(arg.displayName, arg.taskFolderPath);
  const outcome = await confirmNoProcessAndReleaseHeldAdmissionMarkerV1(arg.taskFolderPath, arg.claimId);
  if (outcome.outcome === "released") {
    return { outcome: "done", message: `Released ${taskName}.` };
  }
  if (outcome.outcome === "markerGone") {
    return { outcome: "alreadyDone", message: `${taskName} was already released.` };
  }
  return {
    outcome: "refused",
    message: `Could not release ${taskName} yet — its admission marker is still being renewed. Try again.`,
  };
}

export function registerHeldAdmissionMarkerCommandsV1(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(STOP_HELD_ADMISSION_MARKER_COMMAND_V1, (arg?: HeldAdmissionMarkerCommandArgV1) =>
      stopHeldAdmissionMarkerAndReleaseCommandV1(arg)
    ),
    vscode.commands.registerCommand(
      CONFIRM_NO_PROCESS_RELEASE_HELD_ADMISSION_MARKER_COMMAND_V1,
      (arg?: HeldAdmissionMarkerCommandArgV1) => confirmNoProcessAndReleaseHeldAdmissionMarkerCommandV1(arg)
    )
  );
}

/**
 * Step 57a's proactive card content, built independently of where it is
 * raised (mirrors `decideOpenPlanItemsV1.ts`'s
 * `buildOpenPlanItemsNeedDecisionCardInputV1` pattern) so its contract —
 * options, wording, which branch a `processState` takes — is directly
 * testable. `processState === "unconfirmedSpawn"` offers the owner-confirmed
 * release only (no pid to stop); every other state (including an older
 * sidecar with no recorded `processState` at all) offers the automatic stop,
 * matching `resolveHeldAdmissionMarkerV1`'s own fail-open branch choice.
 */
export function buildHeldAdmissionMarkerCardInputV1(input: {
  readonly taskFolderPath: string;
  readonly taskCanonicalId: string;
  readonly stage: TaskStage;
  readonly displayName?: string;
  readonly claimId: string;
  readonly outstandingReason: string;
  readonly processState: RoundProcessStateV1 | undefined;
  readonly pids: readonly number[];
  readonly createdAt: string;
  /** Step 57a: the provider and command recorded for an `unconfirmedSpawn`
   * hold, shown so the owner can check their own process list — there is no
   * pid to identify the process by instead. Ignored for every other
   * `processState`. */
  readonly providerLabel?: string;
  readonly command?: string;
}): Omit<CreateWorkflowDecisionInputV1, "decisionId"> {
  const {
    taskFolderPath,
    taskCanonicalId,
    stage,
    displayName,
    claimId,
    outstandingReason,
    processState,
    pids,
    createdAt,
    providerLabel,
    command,
  } = input;
  const keepWaitingOption: WorkflowDecisionOptionV1 = {
    optionId: "keepWaiting",
    label: "Keep waiting",
    resumeKind: "unpause",
    consequence: "No change. Ensemble keeps checking and will release the task automatically once it is confirmed gone.",
    effect: { kind: "doNothing" },
  };
  const gating = {
    holdsTaskPaused: false,
    unblocksProgress: false,
    detail:
      "This card does not pause the task; the marker stays held, and Ensemble keeps retrying on its own, until the " +
      "process is confirmed gone or you act.",
  };
  if (processState === "unconfirmedSpawn") {
    const confirmOption: WorkflowDecisionOptionV1 = {
      optionId: "confirmNoProcess",
      label: "I have checked: no provider process for this task is running — release the task",
      resumeKind: "unpause",
      destructive: true,
      consequence:
        "Releases the task's admission marker so a new round can be admitted. Ensemble never recorded this " +
        "process's id, so it cannot identify, stop, or confirm it gone by itself — choose this only after checking " +
        "your own running processes.",
      effect: {
        kind: "command",
        command: CONFIRM_NO_PROCESS_RELEASE_HELD_ADMISSION_MARKER_COMMAND_V1,
        args: [{ taskFolderPath, claimId, displayName }],
      },
    };
    const identityText =
      providerLabel !== undefined || command !== undefined
        ? `\n\nRecorded for this attempt: ${providerLabel ?? "an unknown provider"} (${command ?? "command not recorded"}).`
        : "";
    return {
      decisionKey: "providerProcessMayStillBeRunning",
      taskCanonicalId,
      stage,
      whatHappened: `Provider process may still be running.\n\n${outstandingReason}${identityText}`,
      whyUserNeeded:
        "Ensemble could not record this process's id (it was starting when the round ended), so only you can " +
        "confirm it is not still running before the task is released. Check your running processes for the " +
        "provider and command named above.",
      options: [confirmOption, keepWaitingOption],
      recommendation: {
        kind: "none",
        reasoning: "Only you can confirm no provider process for this task is still running.",
      },
      gating,
      createdAt,
    };
  }
  const pidText = pids.length > 0 ? pids.join(", ") : "unknown";
  const stopOption: WorkflowDecisionOptionV1 = {
    optionId: "stopAndRelease",
    label: "Stop it and release the task",
    resumeKind: "unpause",
    destructive: true,
    consequence: `Ends the recorded provider process(es) (pid ${pidText}) and releases the task's admission marker once they are confirmed gone.`,
    effect: {
      kind: "command",
      command: STOP_HELD_ADMISSION_MARKER_COMMAND_V1,
      args: [{ taskFolderPath, claimId, displayName }],
    },
  };
  return {
    decisionKey: "providerProcessMayStillBeRunning",
    taskCanonicalId,
    stage,
    whatHappened: `Provider process may still be running.\n\n${outstandingReason}`,
    whyUserNeeded:
      "Ensemble will keep checking on its own, but you can stop the recorded process yourself to free the task sooner.",
    options: [stopOption, keepWaitingOption],
    recommendation: {
      kind: "option",
      optionId: "stopAndRelease",
      reasoning: "Stopping the recorded process now is the fastest way to free the task.",
    },
    gating,
    createdAt,
  };
}

/**
 * Step 57a: raises the proactive "Provider process may still be running"
 * chat card the first time a hold is detected, alongside the existing
 * notification (`onHeld` callers already show one) — see
 * `createAdmissionHeldNotifierV1`, the shared factory every `trySafeAdmissionReleaseV1`
 * call site now uses for its `onHeld` argument. Re-reads the held marker
 * itself (rather than trusting the caller's in-memory `reason` string) so
 * this works from any process that can see the same `workspaceState`/marker
 * directory, not only the one that detected the hold. Best-effort: a failure
 * to read task progress or post the decision leaves the existing
 * notification as the only signal, never throws into the caller's release
 * path.
 */
export async function postHeldAdmissionMarkerCardV1(taskFolderPath: string): Promise<void> {
  try {
    const info = readHeldAdmissionMarkerForTaskV1(taskFolderPath);
    if (!info) {
      return;
    }
    let stage: TaskStage = "desc";
    let displayName: string | undefined;
    try {
      const read = await readTaskProgressStrictV1(vscode.Uri.file(taskFolderPath));
      if (read.ok) {
        stage = read.decoded.progress.currentStage;
        displayName = read.decoded.progress.displayName;
      }
    } catch {
      // Best-effort: post with the fallback stage rather than not at all.
    }
    const target: ChatTarget = { canonicalId: taskFolderPath, taskFolderPath, stage, taskName: displayName };
    await postWorkflowDecisionV1(
      buildHeldAdmissionMarkerCardInputV1({
        taskFolderPath,
        taskCanonicalId: taskFolderPath,
        stage,
        displayName,
        claimId: info.claimId,
        outstandingReason: info.outstandingReason,
        processState: info.processState,
        pids: info.pids,
        providerLabel: info.providerLabel,
        command: info.command,
        createdAt: new Date().toISOString(),
      }),
      target
    );
  } catch {
    // Best-effort — see doc comment above.
  }
}

/**
 * Shared `onHeld` callback for every `trySafeAdmissionReleaseV1` /
 * `requestSafeAdmissionReleaseV1` call site (item 2 / Step 57a): shows the
 * existing notification AND raises the proactive chat card exactly once per
 * hold detection (the caller only invokes `onHeld` once, guarded by its own
 * `releaseHeldWarned` flag — see `workAdmissionV1.ts`). Posting the card is
 * fire-and-forget: a command's release path must not block on it.
 */
export function createAdmissionHeldNotifierV1(): (taskFolderPath: string, reason: string) => void {
  return (taskFolderPath: string, reason: string): void => {
    const taskName = formatNotificationTaskLabelV1(undefined, taskFolderPath);
    NotificationRouter.showWarning(
      `Admission kept held for ${taskName} (${taskFolderPath}): ${reason} Will keep checking and release ` +
        "automatically once it is confirmed gone."
    );
    void postHeldAdmissionMarkerCardV1(taskFolderPath);
  };
}

/**
 * Scan the active workspace folder for stale work-admission markers
 * (last renewed >20 minutes ago) and offer to delete them, clearing
 * blocks to task operations after a crashed or hung fast-forward loop.
 *
 * This command provides a manual escape hatch; the admission system itself
 * never auto-reclaims markers per its v1a policy (conservative to avoid
 * guessing whether a slow process is actually dead).
 */
export async function releaseStuckAdmissionMarkers(): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceRoot) {
    NotificationRouter.showWarning("No workspace folder open.");
    return;
  }

  // Step 57a: a held marker (a provider process that may still be running)
  // is routed through its own stop-or-confirm flow FIRST, one at a time and
  // regardless of its renewal age — it is never a candidate for the blind
  // bulk "Delete All" below, because that path has no way to confirm the
  // process is actually gone before unlinking the marker.
  const heldMarkers = findHeldAdmissionMarkersForReleaseV1(workspaceRoot.uri.fsPath);
  for (const held of heldMarkers) {
    await resolveHeldAdmissionMarkerV1(held);
  }
  const heldFilePaths = new Set(heldMarkers.map((h) => h.info.filePath));

  const now = Date.now();
  const staleMarkers = findStaleAdmissionMarkersForReleaseV1(workspaceRoot.uri.fsPath, now).filter(
    (m) => !heldFilePaths.has(m.filePath)
  );

  if (staleMarkers.length === 0) {
    if (heldMarkers.length === 0) {
      NotificationRouter.showInformation(
        "No stale admission markers found. All valid admission markers were renewed within the last 20 minutes."
      );
    }
    return;
  }

  const markerList = staleMarkers
    .map((m) => `  - ${m.workspaceRelativePath} (${Math.round((now - m.mtimeMs) / 60000)} min old)`)
    .join("\n");

  const choice = await vscode.window.showWarningMessage(
    `Found ${staleMarkers.length} stale admission marker(s) (last renewed >20 min ago).\n\n${markerList}\n\nDelete them to unblock stuck task operations?`,
    "Delete All",
    "Cancel"
  );

  if (choice !== "Delete All") {
    return;
  }

  let deleted = 0;
  let skippedFresh = 0;
  const failed: string[] = [];

  for (const marker of staleMarkers) {
    const current = isStaleAdmissionMarkerFileV1(
      marker.filePath,
      Date.now(),
      RELEASE_STUCK_ADMISSION_STALE_MS_V1
    );
    if (!current.ok) {
      skippedFresh++;
      continue;
    }
    try {
      fs.unlinkSync(marker.filePath);
      deleted++;
    } catch (err) {
      console.error(`Failed to delete ${marker.filePath}:`, err);
      failed.push(marker.workspaceRelativePath);
    }
  }

  const skippedText = skippedFresh > 0 ? ` Skipped ${skippedFresh} marker(s) that were refreshed before deletion.` : "";
  if (failed.length > 0) {
    NotificationRouter.showError(
      `Deleted ${deleted} stale marker(s).${skippedText} Failed to delete: ${failed.join(", ")}`
    );
    return;
  }
  NotificationRouter.showInformation(`Deleted ${deleted} stale marker(s).${skippedText}`);
}
