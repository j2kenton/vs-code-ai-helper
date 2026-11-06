/**
 * review1 Step 45: the "Run it for me" option on an owner-evidence card. The card names a read-only command from
 * the allowlist (`ownerEvidenceCommandAllowlistV1.ts`); choosing the option is the owner's confirmation, in the
 * chat, of that exact command. This runs it in the workspace with a 60 s limit, removes anything that looks like
 * a secret from the output, records the exit status and output under `## Owner evidence` in task.md, and re-runs
 * the stage's review. A command that is not on the allowlist is refused whatever the card said.
 */
import * as vscode from "vscode";
import * as path from "path";
import { execFile } from "child_process";
import { TaskStage } from "../types/taskProgress";
import { WorkflowDecisionCommandResultV1 } from "../types/workflowDecisionV1";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { NotificationRouter } from "../utils/notificationRouter";
import { formatNotificationTaskLabelV1 } from "../utils/notificationTaskContextV1";
import { appendOwnerEvidenceV1 } from "../utils/ownerEvidenceV1";
import {
  AllowlistedCommandV1,
  OWNER_EVIDENCE_COMMAND_TIMEOUT_MS_V1,
  RUN_OWNER_EVIDENCE_COMMAND_V1,
  parseAllowlistedCommandV1,
  redactSecretsFromCommandOutputV1,
} from "../utils/ownerEvidenceCommandAllowlistV1";
import { resumeAndRerunReviewV1 } from "./resumeTask";

/** The longest output kept in task.md; the rest is cut with a note. */
export const OWNER_EVIDENCE_OUTPUT_LIMIT_CHARS_V1 = 20_000;

export interface RunOwnerEvidenceCommandArgV1 {
  readonly taskFolderPath: string;
  readonly stage: TaskStage;
  /** The blocker text the evidence answers, as `## Owner evidence` records it. */
  readonly blocker: string;
  /** The command line shown on the card. Re-checked against the allowlist before anything runs. */
  readonly commandLine: string;
}

export interface OwnerEvidenceCommandRunV1 {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly output: string;
  /** Set when the program could not be started at all (not installed, not executable). */
  readonly spawnError?: string;
}

export interface RunOwnerEvidenceCommandDepsV1 {
  readonly run: (command: AllowlistedCommandV1, cwd: string, timeoutMs: number) => Promise<OwnerEvidenceCommandRunV1>;
  /** Resumes the task and re-runs the stage's review; resolves true only when the review was dispatched. */
  readonly rerunReview: (taskFolderPath: string) => Promise<boolean>;
  /** Where the command runs for this task folder, or undefined when the workspace cannot be found. */
  readonly resolveWorkspaceRoot: (taskFolderPath: string) => string | undefined;
  readonly now?: () => Date;
}

function isValidArg(arg: RunOwnerEvidenceCommandArgV1 | undefined): arg is RunOwnerEvidenceCommandArgV1 {
  return (
    !!arg &&
    typeof arg.taskFolderPath === "string" &&
    arg.taskFolderPath !== "" &&
    typeof arg.stage === "string" &&
    typeof arg.blocker === "string" &&
    arg.blocker.trim() !== "" &&
    typeof arg.commandLine === "string" &&
    arg.commandLine.trim() !== ""
  );
}

/** The text recorded under Owner evidence: who ran what, when, how it ended, and the cleaned output. */
export function formatOwnerEvidenceCommandRecordV1(
  command: AllowlistedCommandV1,
  run: OwnerEvidenceCommandRunV1,
  at: Date
): string {
  const status = run.spawnError
    ? `could not be started (${run.spawnError})`
    : run.timedOut
      ? `stopped after ${OWNER_EVIDENCE_COMMAND_TIMEOUT_MS_V1 / 1000} s without finishing`
      : `exit status ${run.exitCode ?? "unknown"}`;
  let output = redactSecretsFromCommandOutputV1(run.output).trim();
  let note = "";
  if (output.length > OWNER_EVIDENCE_OUTPUT_LIMIT_CHARS_V1) {
    output = output.slice(0, OWNER_EVIDENCE_OUTPUT_LIMIT_CHARS_V1);
    note = "\n[output cut at 20000 characters]";
  }
  return (
    `Run by Ensemble at the owner's request (${at.toISOString()}): ${command.display}\n` +
    `Result: ${status}. Anything that looked like a secret was removed from the output.\n\n` +
    (output.length > 0 ? output : "(no output)") +
    note
  );
}

export async function runOwnerEvidenceCommandV1(
  arg: RunOwnerEvidenceCommandArgV1 | undefined,
  deps: RunOwnerEvidenceCommandDepsV1
): Promise<WorkflowDecisionCommandResultV1> {
  if (!isValidArg(arg)) {
    return { outcome: "refused", message: "This option is missing its command or blocker; nothing was run." };
  }
  const command = parseAllowlistedCommandV1(arg.commandLine);
  if (!command) {
    return {
      outcome: "refused",
      message: `\`${arg.commandLine.trim()}\` is not a read-only command Ensemble runs for you; nothing was run. Run it yourself and paste the result.`,
    };
  }
  const cwd = deps.resolveWorkspaceRoot(arg.taskFolderPath);
  if (cwd === undefined) {
    return { outcome: "refused", message: "The workspace folder for this task could not be found; nothing was run." };
  }
  const taskName = formatNotificationTaskLabelV1(undefined, arg.taskFolderPath);
  const at = (deps.now ?? (() => new Date()))();
  const run = await deps.run(command, cwd, OWNER_EVIDENCE_COMMAND_TIMEOUT_MS_V1);
  try {
    await appendOwnerEvidenceV1(arg.taskFolderPath, arg.blocker, formatOwnerEvidenceCommandRecordV1(command, run, at));
  } catch (error) {
    return {
      outcome: "refused",
      message:
        `\`${command.display}\` ran, but its result could not be written to task.md ` +
        `(${error instanceof Error ? error.message : String(error)}). Nothing was recorded; run it again once task.md is writable.`,
    };
  }
  // The result is on record; arranging the re-review is best effort and never turns the record into a failure.
  try {
    if (!(await deps.rerunReview(arg.taskFolderPath))) {
      NotificationRouter.showWarning(
        `${taskName}: the result of \`${command.display}\` is saved under Owner evidence, but the review was not re-run ` +
          "(the task could not be resumed or is busy). Run the review again to use it."
      );
    }
  } catch (error) {
    NotificationRouter.showWarning(
      `${taskName}: the result of \`${command.display}\` is saved under Owner evidence, but re-running the review failed: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }
  return {
    outcome: "done",
    message: run.spawnError
      ? `\`${command.display}\` could not be started (${run.spawnError}); that is recorded under Owner evidence.`
      : `Ran \`${command.display}\` and recorded the result under Owner evidence.`,
  };
}

/** Runs the program directly (no shell), with a time limit and a bounded buffer. */
export function runCommandWithoutShellV1(
  command: AllowlistedCommandV1,
  cwd: string,
  timeoutMs: number
): Promise<OwnerEvidenceCommandRunV1> {
  return new Promise((resolve) => {
    execFile(
      command.executable,
      [...command.args],
      { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true, shell: false },
      (error, stdout, stderr) => {
        const output = [stdout, stderr].filter((part) => part && part.length > 0).join("\n");
        if (!error) {
          resolve({ exitCode: 0, timedOut: false, output });
          return;
        }
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
        if (failure.killed === true) {
          resolve({ exitCode: null, timedOut: true, output });
        } else if (typeof failure.code === "number") {
          resolve({ exitCode: failure.code, timedOut: false, output });
        } else {
          resolve({ exitCode: null, timedOut: false, output, spawnError: failure.message });
        }
      }
    );
  });
}

/** Task folders live at `<workspace>/.ensemble/<task>`; anything else falls back to the first open folder. */
export function resolveOwnerEvidenceWorkspaceRootV1(taskFolderPath: string): string | undefined {
  const parent = path.dirname(taskFolderPath);
  if (path.basename(parent) === ".ensemble") {
    return path.dirname(parent);
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function registerRunOwnerEvidenceCommandV1(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(RUN_OWNER_EVIDENCE_COMMAND_V1, (arg?: RunOwnerEvidenceCommandArgV1) =>
      runOwnerEvidenceCommandV1(arg, {
        run: runCommandWithoutShellV1,
        resolveWorkspaceRoot: resolveOwnerEvidenceWorkspaceRootV1,
        rerunReview: (taskFolderPath) =>
          resumeAndRerunReviewV1(inventory, currentTaskStore, { taskFolderPath }, { skipUnchangedTreeGuardV1: true }),
      })
    )
  );
}
