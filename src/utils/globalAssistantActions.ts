import * as vscode from "vscode";
import * as path from "path";
import { TaskInventory, TaskWithProgress } from "../state/taskInventory";
import { CurrentTaskStore } from "./currentTaskStore";
import { patchTaskProgress } from "./taskProgressUtils";
import { TaskStatus } from "../types/taskProgress";
import { writeRunLog } from "./runLog";
import { cancelRunningOperationsForArchive } from "../commands/archiveTask";
import { PendingOperationsStore } from "../state/pendingOperationsStore";
import { recoverActivationCheckpoint } from "../state/taskActivationCoordinator";

/**
 * The global assistant's structured action layer: a typed registry of
 * allowlisted, schema-validated operations. Anything the AI proposes that is
 * not registered here is rejected, never executed. Consequential operations
 * (anything mutating more than one task, or any repair) require an explicit
 * user confirmation listing the affected tasks before executing.
 *
 * Workspace boundary: operations only ever touch tasks in the current
 * workspace's inventory. Every executed operation appends an audit entry
 * (operation, payload, affected tasks, outcome) to the global assistant's
 * run log.
 */

export interface GlobalActionOutcome {
  /** Human-readable summary shown in chat. */
  summary: string;
  succeeded: string[];
  failed: Array<{ task: string; reason: string }>;
}

export interface GlobalAssistantContext {
  inventory: TaskInventory;
  currentTaskStore: CurrentTaskStore;
  /** Folder the global assistant's own artifacts (audit log) live in. */
  assistantFolderUri: vscode.Uri;
  /** Persisted pending-operation records (workspaceState). Repairs and
   * archives clear a task's records through this store. */
  pendingOperations?: PendingOperationsStore;
}

export interface GlobalAssistantOperation {
  readonly id: string;
  /** Shown in the assistant prompt so the AI knows what it may propose. */
  readonly description: string;
  readonly requiresConfirmation: boolean;
  /** Returns an error message when the payload is invalid; undefined when OK. */
  validatePayload(payload: unknown): string | undefined;
  /** Tasks the operation would touch — shown in the confirmation dialog. */
  affectedTasks(ctx: GlobalAssistantContext, payload: unknown): TaskWithProgress[];
  execute(ctx: GlobalAssistantContext, payload: unknown): Promise<GlobalActionOutcome>;
}

const ARCHIVE_ELIGIBLE: readonly TaskStatus[] = ["completed"];

const archiveCompletedTasks: GlobalAssistantOperation = {
  id: "archiveCompletedTasks",
  description:
    "Archive every task in this workspace whose status is completed. Takes no payload.",
  requiresConfirmation: true,
  validatePayload(payload: unknown): string | undefined {
    if (payload !== undefined && payload !== null && Object.keys(payload as object).length > 0) {
      return "archiveCompletedTasks takes no payload.";
    }
    return undefined;
  },
  affectedTasks(ctx: GlobalAssistantContext): TaskWithProgress[] {
    return ctx.inventory
      .getTasks()
      .filter((t) => ARCHIVE_ELIGIBLE.includes((t.progress.status ?? "active") as TaskStatus));
  },
  async execute(ctx: GlobalAssistantContext): Promise<GlobalActionOutcome> {
    const targets = this.affectedTasks(ctx, undefined);
    const succeeded: string[] = [];
    const failed: Array<{ task: string; reason: string }> = [];
    for (const task of targets) {
      const label = task.progress.displayName ?? task.folderName;
      // Honor the in-flight-operation rule: a live process must never keep
      // writing into an archived task. On cancellation failure, stop —
      // partial failures stop and report rather than plowing on.
      const cancelResult = await cancelRunningOperationsForArchive(task.taskFolderPath);
      if (!cancelResult.ok) {
        failed.push({ task: label, reason: cancelResult.reason ?? "running operation could not be cancelled" });
        break;
      }
      try {
        const patched = await patchTaskProgress(vscode.Uri.file(task.taskFolderPath), (current) => ({
          ...current,
          status: "archived" as TaskStatus,
          archivedFrom: current.status ?? "active",
          // pinnedAt is progress data and is preserved through archive, the
          // same as the interactive archive command; only scheduled work is
          // cleared so nothing fires against a parked task.
          scheduledRun: undefined,
          scheduledResumeTime: undefined,
          updatedAt: new Date().toISOString(),
        }));
        if (!patched) {
          failed.push({ task: label, reason: "task progress could not be read" });
          break;
        }
        await ctx.pendingOperations?.removeForTask(task.canonicalId);
        if (ctx.currentTaskStore.get() === task.canonicalId) {
          await ctx.currentTaskStore.clear();
        }
        succeeded.push(label);
      } catch (error) {
        failed.push({ task: label, reason: error instanceof Error ? error.message : String(error) });
        break;
      }
    }
    await ctx.inventory.refresh();
    const summary =
      targets.length === 0
        ? "No completed tasks to archive."
        : `Archived ${succeeded.length} of ${targets.length} completed task(s).` +
          (failed.length > 0 ? ` Stopped after a failure: ${failed.map((f) => `${f.task} (${f.reason})`).join("; ")}. Remaining tasks were left untouched.` : "");
    return { summary, succeeded, failed };
  },
};

interface RepairStuckTaskPayload {
  taskFolder: string;
}

function isRepairPayload(payload: unknown): payload is RepairStuckTaskPayload {
  return (
    !!payload &&
    typeof payload === "object" &&
    typeof (payload as Record<string, unknown>).taskFolder === "string" &&
    ((payload as Record<string, unknown>).taskFolder as string).trim().length > 0
  );
}

function findTaskByFolder(ctx: GlobalAssistantContext, taskFolder: string): TaskWithProgress | undefined {
  const needle = taskFolder.trim().toLowerCase();
  return ctx.inventory
    .getTasks()
    .find(
      (t) =>
        t.folderName.toLowerCase() === needle ||
        (t.progress.displayName ?? "").toLowerCase() === needle ||
        t.taskFolderPath.toLowerCase() === needle
    );
}

const repairStuckTask: GlobalAssistantOperation = {
  id: "repairStuckTask",
  description:
    'Clear stale scheduling/pending-operation state for one task so it becomes actionable again. Payload: {"taskFolder": "<folder name or task name>"}.',
  requiresConfirmation: true,
  validatePayload(payload: unknown): string | undefined {
    return isRepairPayload(payload)
      ? undefined
      : 'repairStuckTask requires a payload of the form {"taskFolder": "<folder name>"}.';
  },
  affectedTasks(ctx: GlobalAssistantContext, payload: unknown): TaskWithProgress[] {
    if (!isRepairPayload(payload)) return [];
    const task = findTaskByFolder(ctx, payload.taskFolder);
    return task ? [task] : [];
  },
  async execute(ctx: GlobalAssistantContext, payload: unknown): Promise<GlobalActionOutcome> {
    if (!isRepairPayload(payload)) {
      return { summary: "Invalid payload for repairStuckTask.", succeeded: [], failed: [] };
    }
    const task = findTaskByFolder(ctx, payload.taskFolder);
    if (!task) {
      return {
        summary: `No task named "${payload.taskFolder}" exists in this workspace.`,
        succeeded: [],
        failed: [{ task: payload.taskFolder, reason: "not found in this workspace" }],
      };
    }
    const label = task.progress.displayName ?? task.folderName;
    try {
      const patched = await patchTaskProgress(vscode.Uri.file(task.taskFolderPath), (current) => ({
        ...current,
        scheduledRun: undefined,
        scheduledResumeTime: undefined,
        reviewAttemptId: undefined,
        fallbackActive: undefined,
        fallbackModelId: undefined,
        updatedAt: new Date().toISOString(),
      }));
      if (!patched) {
        return { summary: `Could not read task progress for "${label}".`, succeeded: [], failed: [{ task: label, reason: "task progress could not be read" }] };
      }

      // Repair the specified state stores too, not just task-progress.json:
      // stale persisted pending-operation records for this task
      // (pendingOperationsStore) and any unresolved activation checkpoint in
      // its task root (taskActivationCoordinator) are exactly the state that
      // leaves a task looking permanently busy/unactivatable.
      const clearedOps = (await ctx.pendingOperations?.removeForTask(task.canonicalId)) ?? 0;
      let activationNote = "";
      try {
        const recovery = await recoverActivationCheckpoint(
          path.resolve(task.taskFolderPath, ".."),
          ctx.currentTaskStore
        );
        if (recovery) {
          activationNote = ` ${recovery}`;
        }
      } catch (error) {
        activationNote = ` Activation-state recovery failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }

      await ctx.inventory.refresh();
      return {
        summary:
          `Cleared stale scheduling and pending-run state for "${label}"` +
          (clearedOps > 0 ? ` (including ${clearedOps} persisted pending operation record(s))` : "") +
          `.${activationNote}`,
        succeeded: [label],
        failed: [],
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { summary: `Repair failed for "${label}": ${reason}`, succeeded: [], failed: [{ task: label, reason }] };
    }
  },
};

export const GLOBAL_ASSISTANT_OPERATIONS: readonly GlobalAssistantOperation[] = [
  archiveCompletedTasks,
  repairStuckTask,
];

export function getGlobalAssistantOperation(id: string): GlobalAssistantOperation | undefined {
  return GLOBAL_ASSISTANT_OPERATIONS.find((op) => op.id === id);
}

export interface ProposedGlobalAction {
  operationId: string;
  payload: unknown;
}

/**
 * Parse the first `[[ACTION:<operationId> <json payload>]]` envelope from an
 * assistant response. Returns undefined when no action is proposed; a parse
 * failure of the payload yields a payload of undefined (the operation's own
 * validation then rejects it with a useful message).
 */
export function parseProposedAction(text: string): ProposedGlobalAction | undefined {
  const match = /\[\[ACTION:([A-Za-z0-9_-]+)(?:\s+([\s\S]*?))?\]\]/.exec(text);
  if (!match || !match[1]) {
    return undefined;
  }
  let payload: unknown;
  if (match[2] && match[2].trim().length > 0) {
    try {
      payload = JSON.parse(match[2]);
    } catch {
      payload = undefined;
    }
  }
  return { operationId: match[1], payload };
}

/** Strip every ACTION envelope from the displayed response. */
export function stripActionEnvelopes(text: string): string {
  return text.replace(/\[\[ACTION:[A-Za-z0-9_-]+(?:\s+[\s\S]*?)?\]\]/g, "").trim();
}

/**
 * Execute a proposed action through the registry: unregistered operations
 * are rejected, payloads are validated, consequential operations are
 * confirmed with the affected-task list, and every execution is audited.
 * Returns the text to append to the chat.
 */
export async function executeProposedAction(
  ctx: GlobalAssistantContext,
  proposal: ProposedGlobalAction
): Promise<string> {
  const operation = getGlobalAssistantOperation(proposal.operationId);
  if (!operation) {
    return `_The assistant proposed an operation ("${proposal.operationId}") that is not in the allowlisted registry; it was rejected and nothing was executed._`;
  }
  const validationError = operation.validatePayload(proposal.payload);
  if (validationError) {
    return `_The proposed ${operation.id} action was rejected: ${validationError}_`;
  }

  if (operation.requiresConfirmation) {
    const affected = operation.affectedTasks(ctx, proposal.payload);
    const taskList =
      affected.length > 0
        ? affected.map((t) => `• ${t.progress.displayName ?? t.folderName}`).join("\n")
        : "(no tasks match)";
    const choice = await vscode.window.showWarningMessage(
      `The global assistant wants to run "${operation.id}".\n\nAffected tasks:\n${taskList}\n\nProceed?`,
      { modal: true },
      "Run Action"
    );
    if (choice !== "Run Action") {
      await appendAudit(ctx, operation.id, proposal.payload, [], "declined by user");
      return `_The ${operation.id} action was not confirmed; nothing was executed._`;
    }
  }

  const outcome = await operation.execute(ctx, proposal.payload);
  await appendAudit(
    ctx,
    operation.id,
    proposal.payload,
    [...outcome.succeeded, ...outcome.failed.map((f) => f.task)],
    outcome.failed.length === 0 ? "succeeded" : `partial failure: ${outcome.failed.map((f) => `${f.task} (${f.reason})`).join("; ")}`
  );
  return outcome.summary;
}

async function appendAudit(
  ctx: GlobalAssistantContext,
  operationId: string,
  payload: unknown,
  affectedTasks: string[],
  outcome: string
): Promise<void> {
  try {
    await writeRunLog(
      ctx.assistantFolderUri,
      "global-assistant",
      "desc",
      [
        "# Global Assistant Action Audit",
        "",
        `- Operation: ${operationId}`,
        `- Payload: ${JSON.stringify(payload ?? null)}`,
        `- Affected tasks: ${affectedTasks.length > 0 ? affectedTasks.join(", ") : "(none)"}`,
        `- Outcome: ${outcome}`,
        `- At: ${new Date().toISOString()}`,
      ].join("\n")
    );
  } catch {
    // Auditing is best-effort; a log failure must not undo an executed action.
  }
}
