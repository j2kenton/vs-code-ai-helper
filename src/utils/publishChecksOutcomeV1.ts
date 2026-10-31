/**
 * bugs3 Step 12: every Publish Checks run ends with a recorded outcome.
 *
 * A run started from a decision option ("Move on") was cut short by a pause or a
 * resume and left nothing behind: no result file, and `publish-review.md` still
 * read "Not yet reviewed". Whether the checks had passed, failed or been
 * cancelled was unknown. A passed or failed run already lands in the report's
 * Completion Checks section; this records the same three outcomes in one small
 * file beside it — including a cancelled run (and who or what cancelled it) and
 * a run that died on an error — and keeps the report's status line in step.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";

import { PUBLISH_CHECKS_FILENAME, STAGE_ARTIFACT_FILENAMES } from "../types/taskProgress";
import {
  ensurePublishReviewArtifactExistsV1,
  mergePublishStatusLineSection,
  readPublishChecksFile,
  withPublishChecksReportLockV1,
  writeFileAtomicV1,
} from "./publishChecksFreshness";
import type { CancelSourceV1 } from "./taskOperations";

export const PUBLISH_CHECKS_OUTCOME_FILENAME_V1 = "publish-checks-outcome-v1.json";

/** Serializes the running record's read-modify-write per task so parallel commands cannot lose an update. */
const runningRecordQueuesV1 = new Map<string, Promise<void>>();

export interface PublishCheckCommandRecordV1 {
  readonly command: string;
  /** The command's exit code when it ran to an exit; absent when it died without one. */
  readonly exitCode?: number;
}

export type PublishChecksOutcomeV1 =
  /**
   * Written before the first command starts and kept current as each command settles, so a
   * run that vanishes (a reload, a crash, a window that died) leaves what it knew behind. It
   * is never a result: nothing may read "running" as passed or failed.
   */
  | {
      readonly outcome: "running";
      readonly at: string;
      readonly operationId?: string;
      readonly pid: number;
      readonly hostname: string;
      /** Commands that have settled so far. */
      readonly finishedCommands: readonly PublishCheckCommandRecordV1[];
      /** Commands started and not yet settled. */
      readonly runningCommands: readonly string[];
    }
  /** A run found abandoned: it stopped without a recorded result, so the rest is unknown. */
  | {
      readonly outcome: "interrupted";
      readonly at: string;
      readonly operationId?: string;
      readonly finishedCommands: readonly PublishCheckCommandRecordV1[];
      /** Commands that were running when it stopped; their outcome is unknown. */
      readonly unknownCommands: readonly string[];
    }
  | { readonly outcome: "passed"; readonly at: string; readonly operationId?: string }
  | {
      readonly outcome: "failed";
      readonly at: string;
      /** The commands that failed; empty when the run itself broke before any check reported. */
      readonly failedCommands: readonly string[];
      /** Set when the run died on an error instead of finishing with red checks. */
      readonly reason?: string;
      readonly operationId?: string;
    }
  | {
      readonly outcome: "cancelled";
      readonly at: string;
      /** Plain words for who or what stopped the run. */
      readonly cause: string;
      readonly operationId?: string;
    };

/** "from Notifications", "from the chat", … — who asked the run to stop. */
export function describePublishCancelSourceV1(source: CancelSourceV1 | undefined): string {
  switch (source) {
    case "notifications":
      return "cancelled from Notifications";
    case "chat":
      return "cancelled from the chat";
    case "viewer":
      return "cancelled from another window of this workspace";
    case "command":
      return "stopped by a command (a pause or resume of the task)";
    default:
      return "stopped before it finished (the source was not recorded)";
  }
}

/** The managed status line for an outcome; the passed and failed wording is the existing one. */
export function publishStatusLineForOutcomeV1(outcome: PublishChecksOutcomeV1): string | undefined {
  switch (outcome.outcome) {
    case "interrupted": {
      const done = outcome.finishedCommands.length;
      const unknown = outcome.unknownCommands.length;
      const failedBefore = outcome.finishedCommands.filter((entry) => entry.exitCode !== undefined && entry.exitCode !== 0);
      const withExit = outcome.finishedCommands.filter((entry) => entry.exitCode !== undefined).length;
      const finishedDetail =
        withExit > 0
          ? ` (${withExit - failedBefore.length} passed, ${failedBefore.length} failed${failedBefore.length > 0 ? `: ${failedBefore.map((entry) => `\`${entry.command}\``).join(", ")}` : ""})`
          : "";
      const progressSentence =
        done === 0 && unknown === 0
          ? "No command had started yet (the window stopped while the run was being prepared)."
          : `${done} command(s) had finished${finishedDetail}${unknown > 0 ? ` and ${unknown} were still running, so their result is unknown` : ""}.`;
      return (
        "**Publish Checks were interrupted** (the window running them stopped before they finished). " +
        `${progressSentence} ` +
        "Nothing was recorded as passed — run Publish Checks again."
      );
    }
    case "cancelled":
      return (
        `**Publish Checks were cancelled** (${outcome.cause}). Nothing was recorded as passed or failed — ` +
        "run Publish Checks again."
      );
    case "failed":
      return outcome.reason !== undefined
        ? `**Publish Checks did not finish** (${outcome.reason}). Run Publish Checks again.`
        : undefined;
    default:
      return undefined;
  }
}

function outcomeFilePathV1(taskFolderPath: string): string {
  return path.join(taskFolderPath, PUBLISH_CHECKS_OUTCOME_FILENAME_V1);
}

/** The last recorded outcome, or undefined when none was written or the file is unreadable. */
export function readPublishChecksOutcomeV1(taskFolderPath: string): PublishChecksOutcomeV1 | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(outcomeFilePathV1(taskFolderPath), "utf8")) as Partial<PublishChecksOutcomeV1> & {
      version?: number;
    };
    if (typeof parsed.at !== "string") {
      return undefined;
    }
    if (
      parsed.outcome === "passed" ||
      parsed.outcome === "cancelled" ||
      parsed.outcome === "failed" ||
      parsed.outcome === "running" ||
      parsed.outcome === "interrupted"
    ) {
      if (parsed.outcome === "running" && typeof (parsed as { pid?: unknown }).pid !== "number") {
        return undefined;
      }
      if (
        (parsed.outcome === "running" || parsed.outcome === "interrupted") &&
        !Array.isArray((parsed as { finishedCommands?: unknown }).finishedCommands)
      ) {
        return undefined;
      }
      if (parsed.outcome === "cancelled" && typeof (parsed as { cause?: unknown }).cause !== "string") {
        return undefined;
      }
      if (parsed.outcome === "failed" && !Array.isArray((parsed as { failedCommands?: unknown }).failedCommands)) {
        return undefined;
      }
      return parsed as PublishChecksOutcomeV1;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Record how a Publish Checks run ended, and — for the outcomes the report's own
 * Completion Checks section does not describe (cancelled, or died on an error) —
 * move the report's status line off "Not yet reviewed". A report that already
 * holds a real review keeps its own verdict (see `mergePublishStatusLineSection`).
 * Never throws: recording the outcome must not turn a settled run into a crash.
 */
export async function recordPublishChecksOutcomeV1(
  taskFolderUri: vscode.Uri,
  outcome: PublishChecksOutcomeV1
): Promise<void> {
  try {
    // Let any pending running-record update land first so it cannot overwrite this result.
    await (runningRecordQueuesV1.get(taskFolderUri.fsPath) ?? Promise.resolve()).catch(() => undefined);
    await writeFileAtomicV1(outcomeFilePathV1(taskFolderUri.fsPath), `${JSON.stringify({ version: 1, ...outcome }, null, 2)}\n`);
    const statusLine = publishStatusLineForOutcomeV1(outcome);
    if (statusLine === undefined) {
      return;
    }
    await ensurePublishReviewArtifactExistsV1(taskFolderUri);
    await withPublishChecksReportLockV1(taskFolderUri, async () => {
      const reportPath = path.join(taskFolderUri.fsPath, STAGE_ARTIFACT_FILENAMES.publish ?? PUBLISH_CHECKS_FILENAME);
      const existing = await readPublishChecksFile(taskFolderUri);
      const merged = mergePublishStatusLineSection(existing, statusLine);
      if (merged !== existing) {
        await writeFileAtomicV1(reportPath, merged);
      }
    });
  } catch (error) {
    console.warn("[publishChecksOutcome] Could not record the Publish Checks outcome", error);
  }
}

type RunningRecordV1 = Extract<PublishChecksOutcomeV1, { outcome: "running" }>;

function updateRunningRecordV1(
  taskFolderPath: string,
  update: (current: RunningRecordV1) => RunningRecordV1,
  operationId: string | undefined
): void {
  const previous = runningRecordQueuesV1.get(taskFolderPath) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const current = readPublishChecksOutcomeV1(taskFolderPath);
      // A run that already settled (or another run's record) is never rewritten as running.
      if (current?.outcome !== "running" || current.operationId !== operationId) {
        return;
      }
      await writeFileAtomicV1(outcomeFilePathV1(taskFolderPath), `${JSON.stringify({ version: 1, ...update(current) }, null, 2)}\n`);
    })
    .catch((error) => console.warn("[publishChecksOutcome] Could not update the running record", error));
  runningRecordQueuesV1.set(taskFolderPath, next);
}

/**
 * Record, before any command starts, that a Publish Checks run is under way, and return the hooks
 * that keep the record current as commands start and settle. Never throws.
 */
export async function recordPublishChecksRunningV1(
  taskFolderUri: vscode.Uri,
  operationId: string | undefined,
  now: () => Date = () => new Date()
): Promise<{ commandStarted(command: string): void; commandSettled(command: string, exitCode?: number): void }> {
  const taskFolderPath = taskFolderUri.fsPath;
  const initial: RunningRecordV1 = {
    outcome: "running",
    at: now().toISOString(),
    ...(operationId !== undefined ? { operationId } : {}),
    pid: process.pid,
    hostname: os.hostname(),
    finishedCommands: [],
    runningCommands: [],
  };
  const written = (runningRecordQueuesV1.get(taskFolderPath) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => writeFileAtomicV1(outcomeFilePathV1(taskFolderPath), `${JSON.stringify({ version: 1, ...initial }, null, 2)}\n`))
    .catch((error) => console.warn("[publishChecksOutcome] Could not record the running state", error));
  runningRecordQueuesV1.set(taskFolderPath, written);
  await written;
  return {
    commandStarted: (command) =>
      updateRunningRecordV1(
        taskFolderPath,
        (current) => ({ ...current, runningCommands: [...current.runningCommands, command] }),
        operationId
      ),
    commandSettled: (command, exitCode) =>
      updateRunningRecordV1(
        taskFolderPath,
        (current) => {
          // Two concurrent checks can share a command line (different cwds): settle one entry, not both.
          const at = current.runningCommands.indexOf(command);
          return {
            ...current,
            runningCommands: at < 0 ? current.runningCommands : current.runningCommands.filter((_, index) => index !== at),
            finishedCommands: [...current.finishedCommands, { command, ...(exitCode !== undefined ? { exitCode } : {}) }],
          };
        },
        operationId
      ),
  };
}

/**
 * A run's last line of defence: when the run is over but its own "running" record is still there (an exit path
 * that recorded nothing), settle it as a run that did not finish. Never infers a pass.
 */
export async function settleUnrecordedPublishChecksRunV1(
  taskFolderUri: vscode.Uri,
  operationId: string | undefined,
  reason: string = "the run ended without recording a result"
): Promise<boolean> {
  await (runningRecordQueuesV1.get(taskFolderUri.fsPath) ?? Promise.resolve()).catch(() => undefined);
  const record = readPublishChecksOutcomeV1(taskFolderUri.fsPath);
  if (record?.outcome !== "running" || record.operationId !== operationId) {
    return false;
  }
  await recordPublishChecksOutcomeV1(taskFolderUri, {
    outcome: "failed",
    at: new Date().toISOString(),
    failedCommands: [],
    reason: reason.slice(0, 200),
    ...(operationId !== undefined ? { operationId } : {}),
  });
  return true;
}

/** Whether a process id is alive on this machine (signal 0 probes without sending anything). */
function processAliveV1(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else, so it is alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Turn a "running" record whose owner is gone into an explicit "interrupted" result and say so in the
 * report. The owner is gone when it was a process on this machine that no longer exists, or this very
 * process when no run of its own is live (asked at activation, before any run has started). A record
 * from another machine cannot be judged from here and is left alone. A pass is never inferred.
 * Returns whether a record was recovered.
 */
export async function recoverAbandonedPublishChecksRunV1(
  taskFolderUri: vscode.Uri,
  options: {
    /** True while a run this process started is live for the task (its own record is then not abandoned). */
    readonly ownRunIsLive?: () => boolean;
    readonly hostname?: string;
    readonly isProcessAlive?: (pid: number) => boolean;
    readonly now?: () => Date;
  } = {}
): Promise<boolean> {
  const record = readPublishChecksOutcomeV1(taskFolderUri.fsPath);
  if (record?.outcome !== "running") {
    return false;
  }
  if (record.hostname !== (options.hostname ?? os.hostname())) {
    return false;
  }
  if (record.pid === process.pid) {
    if (options.ownRunIsLive?.() === true) {
      return false;
    }
  } else if ((options.isProcessAlive ?? processAliveV1)(record.pid)) {
    return false;
  }
  await recordPublishChecksOutcomeV1(taskFolderUri, {
    outcome: "interrupted",
    at: (options.now ?? (() => new Date()))().toISOString(),
    ...(record.operationId !== undefined ? { operationId: record.operationId } : {}),
    finishedCommands: record.finishedCommands,
    unknownCommands: record.runningCommands,
  });
  return true;
}
