import * as vscode from "vscode";
import * as path from "path";
import { TaskInventory, TaskWithProgress } from "../state/taskInventory";
import { CurrentTaskStore } from "./currentTaskStore";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import {
  STAGE_DISPLAY_NAMES,
  TASK_DESCRIPTION_FILENAME,
  TaskProgress,
  TaskStage,
  TaskStatus,
} from "../types/taskProgress";
import { writeRunLog } from "./runLog";
import { cancelRunningOperationsForArchive } from "../commands/archiveTask";
import { PendingOperationsStore } from "../state/pendingOperationsStore";
import { recoverActivationCheckpoint } from "../state/taskActivationCoordinator";
import { runTrackedOperation, taskOperations } from "./taskOperations";

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

/**
 * Activation-wired dependencies `globalAssistantSendRowV1.ts` needs to build
 * a `GlobalAssistantContext` and execute a proposed action. The action-row
 * registry (`productionTaskActionRuntimeV1.ts`) is a process-lifetime
 * singleton built with no per-call arguments (rows are "pure declarations,
 * safe to share"), so a row's `promoteCompletedContent` cannot close over
 * `inventory`/`currentTaskStore` the way a freshly-constructed-per-call
 * coordinator does — it reads them from here instead, exactly like
 * `workflowRuntimeServicesV1.ts`'s `setChatInteractionTransactionStoreV1`
 * wires a value at activation for later singleton-module consumers.
 */
export interface GlobalAssistantRuntimeDepsV1 {
  readonly inventory: TaskInventory;
  readonly currentTaskStore: CurrentTaskStore;
  readonly workspaceState: vscode.Memento;
}

let runtimeDeps: GlobalAssistantRuntimeDepsV1 | undefined;

/** Activation wiring (extension.ts's `activate`): see `GlobalAssistantRuntimeDepsV1`. */
export function setGlobalAssistantRuntimeDepsV1(deps: GlobalAssistantRuntimeDepsV1): void {
  runtimeDeps = deps;
}

/** The activation-wired dependencies, or `undefined` when not wired yet (tests, pre-activation). */
export function getGlobalAssistantRuntimeDepsV1(): GlobalAssistantRuntimeDepsV1 | undefined {
  return runtimeDeps;
}

/** Test isolation: forget any wired dependencies. Production never calls this. */
export function resetGlobalAssistantRuntimeDepsForTestV1(): void {
  runtimeDeps = undefined;
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

/**
 * Archive one task honoring the in-flight-operation rule (a live process
 * must never keep writing into an archived task). Shared by the
 * whole-workspace and explicitly-targeted bulk archive operations. Returns
 * an error reason on failure, undefined on success.
 */
async function archiveOneTask(
  ctx: GlobalAssistantContext,
  task: TaskWithProgress
): Promise<string | undefined> {
  const cancelResult = await cancelRunningOperationsForArchive(task.taskFolderPath);
  if (!cancelResult.ok) {
    return cancelResult.reason ?? "running operation could not be cancelled";
  }
  const patched = await patchTaskProgressStrictV1(vscode.Uri.file(task.taskFolderPath), (current) => ({
    ...current,
    status: "archived" as TaskStatus,
    archivedFrom: current.status ?? "active",
    // pinnedAt is progress data and is preserved through archive, the same
    // as the interactive archive command; only scheduled work is cleared so
    // nothing fires against a parked task.
    scheduledRun: undefined,
    scheduledResumeTime: undefined,
    updatedAt: new Date().toISOString(),
  }));
  if (!patched) {
    return "task progress could not be read";
  }
  await ctx.pendingOperations?.removeForTask(task.canonicalId);
  if (ctx.currentTaskStore.get() === task.canonicalId) {
    await ctx.currentTaskStore.clear();
  }
  return undefined;
}

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
      // Partial failures stop and report rather than plowing on.
      try {
        const reason = await archiveOneTask(ctx, task);
        if (reason) {
          failed.push({ task: label, reason });
          break;
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

interface TaskFolderPayload {
  taskFolder: string;
}

function isTaskFolderPayload(payload: unknown): payload is TaskFolderPayload {
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
    return isTaskFolderPayload(payload)
      ? undefined
      : 'repairStuckTask requires a payload of the form {"taskFolder": "<folder name>"}.';
  },
  affectedTasks(ctx: GlobalAssistantContext, payload: unknown): TaskWithProgress[] {
    if (!isTaskFolderPayload(payload)) return [];
    const task = findTaskByFolder(ctx, payload.taskFolder);
    return task ? [task] : [];
  },
  async execute(ctx: GlobalAssistantContext, payload: unknown): Promise<GlobalActionOutcome> {
    if (!isTaskFolderPayload(payload)) {
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
      const patched = await patchTaskProgressStrictV1(vscode.Uri.file(task.taskFolderPath), (current) => ({
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

/**
 * Build a single-task operation that delegates to one of the extension's own
 * registered commands, so the assistant path reuses exactly the same
 * eligibility guards, cancellation handling, and notifications as the UI
 * buttons.
 *
 * State-accurate outcomes: many UI commands refuse an ineligible action by
 * showing a notification and RESOLVING normally (e.g. markTaskDone outside
 * Publish), so a resolved executeCommand proves nothing. When `verify` is
 * provided, the task's fresh progress is re-read after the command and the
 * item is reported as succeeded ONLY when the postcondition holds; otherwise
 * it is reported failed with `notAppliedReason`.
 */
function makeSingleTaskCommandOperation(options: {
  id: string;
  description: string;
  command: string;
  /** Past-tense verb for the chat summary, e.g. "Archived". */
  summaryVerb: string;
  requiresConfirmation?: boolean;
  /** Postcondition proving the command actually applied the change. */
  verify?: (after: TaskProgress, before: TaskProgress) => boolean;
  /** Reason reported when the postcondition does not hold. */
  notAppliedReason?: string;
}): GlobalAssistantOperation {
  return {
    id: options.id,
    description: options.description,
    requiresConfirmation: options.requiresConfirmation ?? false,
    validatePayload(payload: unknown): string | undefined {
      return isTaskFolderPayload(payload)
        ? undefined
        : `${options.id} requires a payload of the form {"taskFolder": "<folder name or task name>"}.`;
    },
    affectedTasks(ctx: GlobalAssistantContext, payload: unknown): TaskWithProgress[] {
      if (!isTaskFolderPayload(payload)) return [];
      const task = findTaskByFolder(ctx, payload.taskFolder);
      return task ? [task] : [];
    },
    async execute(ctx: GlobalAssistantContext, payload: unknown): Promise<GlobalActionOutcome> {
      if (!isTaskFolderPayload(payload)) {
        return { summary: `Invalid payload for ${options.id}.`, succeeded: [], failed: [] };
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
      const before = task.progress;
      try {
        await vscode.commands.executeCommand(options.command, {
          taskFolderPath: task.taskFolderPath,
        });
        await ctx.inventory.refresh();
        if (options.verify) {
          const fresh = ctx.inventory
            .getTasks()
            .find((t) => t.taskFolderPath === task.taskFolderPath);
          if (!fresh || !options.verify(fresh.progress, before)) {
            const reason =
              options.notAppliedReason ??
              "the command declined the action — see the notification it showed for the reason";
            return {
              summary: `${options.id} was not applied to "${label}": ${reason}.`,
              succeeded: [],
              failed: [{ task: label, reason }],
            };
          }
          return {
            summary: `${options.summaryVerb} "${label}".`,
            succeeded: [label],
            failed: [],
          };
        }
        return {
          summary: `${options.summaryVerb} "${label}" (any eligibility warnings appear as notifications).`,
          succeeded: [label],
          failed: [],
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
          summary: `${options.id} failed for "${label}": ${reason}`,
          succeeded: [],
          failed: [{ task: label, reason }],
        };
      }
    },
  };
}

interface CreateTaskPayload {
  title?: string;
  description?: string;
}

function parseCreateTaskPayload(payload: unknown): CreateTaskPayload | string {
  if (payload === undefined || payload === null) {
    return {};
  }
  if (typeof payload !== "object") {
    return 'createTask takes an optional payload of the form {"title": "...", "description": "..."}.';
  }
  const record = payload as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "title" && key !== "description") {
      return `createTask does not accept a "${key}" field — only "title" and "description".`;
    }
  }
  if (record.title !== undefined && typeof record.title !== "string") {
    return 'createTask "title" must be a string.';
  }
  if (record.description !== undefined && typeof record.description !== "string") {
    return 'createTask "description" must be a string.';
  }
  return { title: record.title, description: record.description };
}

const createTask: GlobalAssistantOperation = {
  id: "createTask",
  description:
    'Create a brand-new task in this workspace and open its task.md for editing. Optional payload: {"title": "<task name>", "description": "<initial task description>"} — both fields optional.',
  requiresConfirmation: false,
  validatePayload(payload: unknown): string | undefined {
    const parsed = parseCreateTaskPayload(payload);
    return typeof parsed === "string" ? parsed : undefined;
  },
  affectedTasks(): TaskWithProgress[] {
    return [];
  },
  async execute(ctx: GlobalAssistantContext, payload: unknown): Promise<GlobalActionOutcome> {
    const parsed = parseCreateTaskPayload(payload);
    if (typeof parsed === "string") {
      return { summary: parsed, succeeded: [], failed: [] };
    }
    try {
      const folderName = await vscode.commands.executeCommand<string | undefined>(
        "vs-code-ai-helper.startNewTask"
      );
      await ctx.inventory.refresh();
      if (!folderName) {
        return { summary: "Task creation did not complete.", succeeded: [], failed: [] };
      }
      const created = ctx.inventory
        .getTasks()
        .find((t) => t.folderName === folderName);
      const notes: string[] = [];
      if (created && parsed.title?.trim()) {
        const title = parsed.title.trim().slice(0, 120);
        await patchTaskProgressStrictV1(vscode.Uri.file(created.taskFolderPath), (current) => ({
          ...current,
          displayName: title,
          nameIsDefault: false,
        }));
        notes.push(`named it "${title}"`);
      }
      if (created && parsed.description?.trim()) {
        await vscode.workspace.fs.writeFile(
          vscode.Uri.joinPath(vscode.Uri.file(created.taskFolderPath), TASK_DESCRIPTION_FILENAME),
          new TextEncoder().encode(parsed.description.trim() + "\n")
        );
        notes.push("filled in its initial description");
      }
      if (notes.length > 0) {
        await ctx.inventory.refresh();
      }
      return {
        summary:
          `Created task "${folderName}" and opened its task.md` +
          (notes.length > 0 ? ` (${notes.join(", ")})` : "") +
          ".",
        succeeded: [folderName],
        failed: [],
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { summary: `Could not create a task: ${reason}`, succeeded: [], failed: [] };
    }
  },
};

/**
 * Unarchive one task through the extension's own command and verify from the
 * fresh inventory that the status actually changed — the command resolves
 * normally when it declines, so a resolved call alone proves nothing.
 * Returns an error reason on failure, undefined on verified success.
 */
async function unarchiveOneTaskVerified(
  ctx: GlobalAssistantContext,
  task: TaskWithProgress
): Promise<string | undefined> {
  await vscode.commands.executeCommand("vs-code-ai-helper.unarchiveTask", {
    taskFolderPath: task.taskFolderPath,
  });
  await ctx.inventory.refresh();
  const fresh = ctx.inventory
    .getTasks()
    .find((t) => t.taskFolderPath === task.taskFolderPath);
  if (!fresh || fresh.progress.status === "archived") {
    return "still archived — the command declined the unarchive (see the notification it showed for the reason)";
  }
  return undefined;
}

const unarchiveAllTasks: GlobalAssistantOperation = {
  id: "unarchiveAllTasks",
  description:
    "Resume every archived task in this workspace (returning each to the active list). Takes no payload.",
  requiresConfirmation: true,
  validatePayload(payload: unknown): string | undefined {
    if (payload !== undefined && payload !== null && Object.keys(payload as object).length > 0) {
      return "unarchiveAllTasks takes no payload.";
    }
    return undefined;
  },
  affectedTasks(ctx: GlobalAssistantContext): TaskWithProgress[] {
    return ctx.inventory.getTasks().filter((t) => t.progress.status === "archived");
  },
  async execute(ctx: GlobalAssistantContext): Promise<GlobalActionOutcome> {
    const targets = this.affectedTasks(ctx, undefined);
    const succeeded: string[] = [];
    const failed: Array<{ task: string; reason: string }> = [];
    for (const task of targets) {
      const label = task.progress.displayName ?? task.folderName;
      try {
        const reason = await unarchiveOneTaskVerified(ctx, task);
        if (reason) {
          failed.push({ task: label, reason });
          break;
        }
        succeeded.push(label);
      } catch (error) {
        // Partial failure stops and reports; remaining tasks stay untouched.
        failed.push({ task: label, reason: error instanceof Error ? error.message : String(error) });
        break;
      }
    }
    await ctx.inventory.refresh();
    const summary =
      targets.length === 0
        ? "No archived tasks to resume."
        : `Resumed ${succeeded.length} of ${targets.length} archived task(s).` +
          (failed.length > 0
            ? ` Stopped after a failure: ${failed.map((f) => `${f.task} (${f.reason})`).join("; ")}. Remaining tasks were left untouched.`
            : "");
    return { summary, succeeded, failed };
  },
};

interface RenameTaskPayload {
  taskFolder: string;
  newName: string;
}

function isRenameTaskPayload(payload: unknown): payload is RenameTaskPayload {
  if (!isTaskFolderPayload(payload)) return false;
  const record = payload as unknown as Record<string, unknown>;
  return typeof record.newName === "string" && record.newName.trim().length > 0;
}

const renameTaskOperation: GlobalAssistantOperation = {
  id: "renameTask",
  description:
    'Rename one task (display name only; folder and IDs are unchanged). Payload: {"taskFolder": "<folder name or task name>", "newName": "<new display name>"}.',
  requiresConfirmation: false,
  validatePayload(payload: unknown): string | undefined {
    return isRenameTaskPayload(payload)
      ? undefined
      : 'renameTask requires a payload of the form {"taskFolder": "<folder name>", "newName": "<new display name>"}.';
  },
  affectedTasks(ctx: GlobalAssistantContext, payload: unknown): TaskWithProgress[] {
    if (!isRenameTaskPayload(payload)) return [];
    const task = findTaskByFolder(ctx, payload.taskFolder);
    return task ? [task] : [];
  },
  async execute(ctx: GlobalAssistantContext, payload: unknown): Promise<GlobalActionOutcome> {
    if (!isRenameTaskPayload(payload)) {
      return { summary: "Invalid payload for renameTask.", succeeded: [], failed: [] };
    }
    const task = findTaskByFolder(ctx, payload.taskFolder);
    if (!task) {
      return {
        summary: `No task named "${payload.taskFolder}" exists in this workspace.`,
        succeeded: [],
        failed: [{ task: payload.taskFolder, reason: "not found in this workspace" }],
      };
    }
    const oldLabel = task.progress.displayName ?? task.folderName;
    const newName = payload.newName.trim().slice(0, 120);
    try {
      // Mirrors the interactive Rename Task command's tracked mutation, but
      // takes the name from the typed payload instead of an input box.
      await runTrackedOperation(
        task.taskFolderPath,
        { label: "Rename Task", taskName: task.folderName, kind: "rename-task" },
        async (op) => {
          await patchTaskProgressStrictV1(vscode.Uri.file(task.taskFolderPath), (current) => ({
            ...current,
            displayName: newName,
            nameIsDefault: false,
          }));
          await ctx.inventory.refresh();
          op.report(`renamed to "${newName}"`);
        }
      );
      return { summary: `Renamed "${oldLabel}" to "${newName}".`, succeeded: [newName], failed: [] };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { summary: `Rename failed for "${oldLabel}": ${reason}`, succeeded: [], failed: [{ task: oldLabel, reason }] };
    }
  },
};

interface SetTaskStagePayload {
  taskFolder: string;
  stage: TaskStage;
}

function isSetTaskStagePayload(payload: unknown): payload is SetTaskStagePayload {
  if (!isTaskFolderPayload(payload)) return false;
  const record = payload as unknown as Record<string, unknown>;
  return (
    typeof record.stage === "string" &&
    Object.prototype.hasOwnProperty.call(STAGE_DISPLAY_NAMES, record.stage)
  );
}

const setTaskStageOperation: GlobalAssistantOperation = {
  id: "setTaskStage",
  description:
    `Move one task to a specific stage (same as the "Set Task Stage" button). Payload: {"taskFolder": "<folder name or task name>", "stage": "<stage id>"} where stage id is one of: ${Object.keys(STAGE_DISPLAY_NAMES).join(", ")}.`,
  requiresConfirmation: true,
  validatePayload(payload: unknown): string | undefined {
    return isSetTaskStagePayload(payload)
      ? undefined
      : `setTaskStage requires {"taskFolder": "<folder name>", "stage": "<stage id>"} with a stage id from: ${Object.keys(STAGE_DISPLAY_NAMES).join(", ")}.`;
  },
  affectedTasks(ctx: GlobalAssistantContext, payload: unknown): TaskWithProgress[] {
    if (!isSetTaskStagePayload(payload)) return [];
    const task = findTaskByFolder(ctx, payload.taskFolder);
    return task ? [task] : [];
  },
  async execute(ctx: GlobalAssistantContext, payload: unknown): Promise<GlobalActionOutcome> {
    if (!isSetTaskStagePayload(payload)) {
      return { summary: "Invalid payload for setTaskStage.", succeeded: [], failed: [] };
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
      // Delegates to the extension's own command so the same eligibility
      // guards, reopen handling, and notifications apply as the UI button.
      await vscode.commands.executeCommand("vs-code-ai-helper.setTaskStage", {
        taskFolderPath: task.taskFolderPath,
        stage: payload.stage,
      });
      await ctx.inventory.refresh();
      // State-accurate outcome: the command resolves normally even when it
      // declines the move, so only the fresh progress proves it happened.
      const fresh = ctx.inventory
        .getTasks()
        .find((t) => t.taskFolderPath === task.taskFolderPath);
      if (fresh?.progress.currentStage !== payload.stage) {
        const reason =
          "the stage was not changed — the command declined the move (see the notification it showed for the reason)";
        return {
          summary: `setTaskStage was not applied to "${label}": ${reason}.`,
          succeeded: [],
          failed: [{ task: label, reason }],
        };
      }
      return {
        summary: `Moved "${label}" to ${STAGE_DISPLAY_NAMES[payload.stage]}.`,
        succeeded: [label],
        failed: [],
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { summary: `setTaskStage failed for "${label}": ${reason}`, succeeded: [], failed: [{ task: label, reason }] };
    }
  },
};

const triggerStageAI: GlobalAssistantOperation = {
  id: "triggerStageAI",
  description:
    'Run the primary AI action for one task\'s current stage (same as "Apply Current Stage Action" — uses provider quota). Payload: {"taskFolder": "<folder name or task name>"}.',
  requiresConfirmation: true,
  validatePayload(payload: unknown): string | undefined {
    return isTaskFolderPayload(payload)
      ? undefined
      : 'triggerStageAI requires a payload of the form {"taskFolder": "<folder name>"}.';
  },
  affectedTasks(ctx: GlobalAssistantContext, payload: unknown): TaskWithProgress[] {
    if (!isTaskFolderPayload(payload)) return [];
    const task = findTaskByFolder(ctx, payload.taskFolder);
    return task ? [task] : [];
  },
  async execute(ctx: GlobalAssistantContext, payload: unknown): Promise<GlobalActionOutcome> {
    if (!isTaskFolderPayload(payload)) {
      return { summary: "Invalid payload for triggerStageAI.", succeeded: [], failed: [] };
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
      await vscode.commands.executeCommand("vs-code-ai-helper.applyCurrentStageAction", {
        taskFolderPath: task.taskFolderPath,
      });
      return {
        summary: `Started the current stage's AI action for "${label}" (progress appears in Notifications).`,
        succeeded: [label],
        failed: [],
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { summary: `triggerStageAI failed for "${label}": ${reason}`, succeeded: [], failed: [{ task: label, reason }] };
    }
  },
};

/**
 * Explicit-target bulk payload: an explicit task list, a status filter, or
 * both (union). At least one selector is required so a malformed payload
 * can never silently mean "every task".
 */
interface BulkTargetPayload {
  taskFolders?: string[];
  status?: TaskStatus;
}

const BULK_STATUSES: readonly TaskStatus[] = ["active", "paused", "completed", "archived"];

function parseBulkTargetPayload(payload: unknown): BulkTargetPayload | string {
  if (!payload || typeof payload !== "object") {
    return 'requires a payload with "taskFolders" (array of task names) and/or "status" (one of active, paused, completed, archived).';
  }
  const record = payload as Record<string, unknown>;
  const result: BulkTargetPayload = {};
  if (record.taskFolders !== undefined) {
    if (
      !Array.isArray(record.taskFolders) ||
      record.taskFolders.length === 0 ||
      record.taskFolders.some((f) => typeof f !== "string" || f.trim().length === 0)
    ) {
      return '"taskFolders" must be a non-empty array of task folder/display names.';
    }
    result.taskFolders = record.taskFolders as string[];
  }
  if (record.status !== undefined) {
    if (typeof record.status !== "string" || !BULK_STATUSES.includes(record.status as TaskStatus)) {
      return `"status" must be one of: ${BULK_STATUSES.join(", ")}.`;
    }
    result.status = record.status as TaskStatus;
  }
  if (!result.taskFolders && !result.status) {
    return 'requires at least one selector: "taskFolders" and/or "status".';
  }
  return result;
}

function resolveBulkTargets(
  ctx: GlobalAssistantContext,
  payload: BulkTargetPayload
): { targets: TaskWithProgress[]; unmatched: string[] } {
  const byPath = new Map<string, TaskWithProgress>();
  const unmatched: string[] = [];
  for (const folder of payload.taskFolders ?? []) {
    const task = findTaskByFolder(ctx, folder);
    if (task) {
      byPath.set(task.taskFolderPath, task);
    } else {
      unmatched.push(folder);
    }
  }
  if (payload.status) {
    for (const task of ctx.inventory.getTasks()) {
      if ((task.progress.status ?? "active") === payload.status) {
        byPath.set(task.taskFolderPath, task);
      }
    }
  }
  return { targets: [...byPath.values()], unmatched };
}

const archiveTasks: GlobalAssistantOperation = {
  id: "archiveTasks",
  description:
    'Archive an explicit set of tasks. Payload: {"taskFolders": ["<task name>", ...]} and/or {"status": "active" | "paused" | "completed"} to target every task with that status.',
  requiresConfirmation: true,
  validatePayload(payload: unknown): string | undefined {
    const parsed = parseBulkTargetPayload(payload);
    if (typeof parsed === "string") return `archiveTasks ${parsed}`;
    if (parsed.status === "archived") return "archiveTasks cannot target already-archived tasks.";
    return undefined;
  },
  affectedTasks(ctx: GlobalAssistantContext, payload: unknown): TaskWithProgress[] {
    const parsed = parseBulkTargetPayload(payload);
    if (typeof parsed === "string") return [];
    return resolveBulkTargets(ctx, parsed).targets.filter(
      (t) => t.progress.status !== "archived"
    );
  },
  async execute(ctx: GlobalAssistantContext, payload: unknown): Promise<GlobalActionOutcome> {
    const parsed = parseBulkTargetPayload(payload);
    if (typeof parsed === "string") {
      return { summary: `Invalid payload: archiveTasks ${parsed}`, succeeded: [], failed: [] };
    }
    const { unmatched } = resolveBulkTargets(ctx, parsed);
    const targets = this.affectedTasks(ctx, payload);
    const succeeded: string[] = [];
    const failed: Array<{ task: string; reason: string }> = unmatched.map((name) => ({
      task: name,
      reason: "not found in this workspace",
    }));
    for (const task of targets) {
      const label = task.progress.displayName ?? task.folderName;
      try {
        const reason = await archiveOneTask(ctx, task);
        if (reason) {
          failed.push({ task: label, reason });
          break;
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
        ? `No matching tasks to archive.${unmatched.length > 0 ? ` Not found: ${unmatched.join(", ")}.` : ""}`
        : `Archived ${succeeded.length} of ${targets.length} targeted task(s).` +
          (failed.length > 0
            ? ` Issues: ${failed.map((f) => `${f.task} (${f.reason})`).join("; ")}.`
            : "");
    return { summary, succeeded, failed };
  },
};

const unarchiveTasks: GlobalAssistantOperation = {
  id: "unarchiveTasks",
  description:
    'Resume an explicit set of archived tasks. Payload: {"taskFolders": ["<task name>", ...]}.',
  requiresConfirmation: true,
  validatePayload(payload: unknown): string | undefined {
    const parsed = parseBulkTargetPayload(payload);
    if (typeof parsed === "string") return `unarchiveTasks ${parsed}`;
    if (!parsed.taskFolders) return 'unarchiveTasks requires an explicit "taskFolders" list (use unarchiveAllTasks to resume every archived task).';
    return undefined;
  },
  affectedTasks(ctx: GlobalAssistantContext, payload: unknown): TaskWithProgress[] {
    const parsed = parseBulkTargetPayload(payload);
    if (typeof parsed === "string" || !parsed.taskFolders) return [];
    return resolveBulkTargets(ctx, { taskFolders: parsed.taskFolders }).targets.filter(
      (t) => t.progress.status === "archived"
    );
  },
  async execute(ctx: GlobalAssistantContext, payload: unknown): Promise<GlobalActionOutcome> {
    const parsed = parseBulkTargetPayload(payload);
    if (typeof parsed === "string" || !parsed.taskFolders) {
      return { summary: "Invalid payload for unarchiveTasks.", succeeded: [], failed: [] };
    }
    const { unmatched } = resolveBulkTargets(ctx, { taskFolders: parsed.taskFolders });
    const targets = this.affectedTasks(ctx, payload);
    const succeeded: string[] = [];
    const failed: Array<{ task: string; reason: string }> = unmatched.map((name) => ({
      task: name,
      reason: "not found in this workspace",
    }));
    for (const task of targets) {
      const label = task.progress.displayName ?? task.folderName;
      try {
        const reason = await unarchiveOneTaskVerified(ctx, task);
        if (reason) {
          failed.push({ task: label, reason });
          break;
        }
        succeeded.push(label);
      } catch (error) {
        // Partial failure stops and reports; remaining tasks stay untouched.
        failed.push({ task: label, reason: error instanceof Error ? error.message : String(error) });
        break;
      }
    }
    await ctx.inventory.refresh();
    const summary =
      targets.length === 0
        ? `No matching archived tasks to resume.${unmatched.length > 0 ? ` Not found: ${unmatched.join(", ")}.` : ""}`
        : `Resumed ${succeeded.length} of ${targets.length} targeted archived task(s).` +
          (failed.length > 0
            ? ` Issues: ${failed.map((f) => `${f.task} (${f.reason})`).join("; ")}.`
            : "");
    return { summary, succeeded, failed };
  },
};

export const GLOBAL_ASSISTANT_OPERATIONS: readonly GlobalAssistantOperation[] = [
  createTask,
  makeSingleTaskCommandOperation({
    id: "completeTask",
    description:
      'Mark one Publish-stage task as completed (same as the "Complete Task" button). Payload: {"taskFolder": "<folder name or task name>"}.',
    command: "vs-code-ai-helper.markTaskDone",
    summaryVerb: "Completed",
    requiresConfirmation: true,
    verify: (after) => after.status === "completed",
    notAppliedReason:
      "the task was not marked completed — Complete Task only applies to a Publish-stage task (the command's own notification has the details)",
  }),
  makeSingleTaskCommandOperation({
    id: "completeStage",
    description:
      'Complete one task\'s current stage and advance it to the next stage (same as the "Complete Stage & Move On" button). Payload: {"taskFolder": "<folder name or task name>"}.',
    command: "vs-code-ai-helper.nextStage",
    summaryVerb: "Advanced the stage of",
    requiresConfirmation: true,
    verify: (after, before) =>
      after.currentStage !== before.currentStage || after.status === "completed",
    notAppliedReason:
      "the stage did not advance — the command declined it (see the notification it showed for the reason)",
  }),
  makeSingleTaskCommandOperation({
    id: "runReview",
    description:
      'Run (or re-run) the AI review for one task\'s current stage (same as the "Review with AI" button — uses provider quota). Payload: {"taskFolder": "<folder name or task name>"}.',
    command: "vs-code-ai-helper.runReviewWithAI",
    summaryVerb: "Ran the current stage's AI review for",
    requiresConfirmation: true,
  }),
  makeSingleTaskCommandOperation({
    id: "fastForwardReview",
    description:
      'Run the review-and-apply-fixes loop for one task\'s current stage (same as the "Fast Forward Fixes" button — uses provider quota). Payload: {"taskFolder": "<folder name or task name>"}.',
    command: "vs-code-ai-helper.fastForwardReviewWithAI",
    summaryVerb: "Ran the review-and-fixes loop for",
    requiresConfirmation: true,
  }),
  makeSingleTaskCommandOperation({
    id: "pauseTask",
    description:
      'Pause one active task. Payload: {"taskFolder": "<folder name or task name>"}.',
    command: "vs-code-ai-helper.pauseTask",
    summaryVerb: "Paused",
    verify: (after) => after.status === "paused",
    notAppliedReason:
      "the task was not paused — the command declined it (see the notification it showed for the reason)",
  }),
  makeSingleTaskCommandOperation({
    id: "resumeTask",
    description:
      'Resume one paused or completed task. Payload: {"taskFolder": "<folder name or task name>"}.',
    command: "vs-code-ai-helper.resumeTask",
    summaryVerb: "Resumed",
    verify: (after) => (after.status ?? "active") === "active",
    notAppliedReason:
      "the task was not resumed — the command declined it (see the notification it showed for the reason)",
  }),
  makeSingleTaskCommandOperation({
    id: "archiveTask",
    description:
      'Archive one task (active, paused, or completed). Payload: {"taskFolder": "<folder name or task name>"}.',
    command: "vs-code-ai-helper.archiveTask",
    summaryVerb: "Archived",
    verify: (after) => after.status === "archived",
    notAppliedReason:
      "the task was not archived — the command declined it (see the notification it showed for the reason)",
  }),
  makeSingleTaskCommandOperation({
    id: "unarchiveTask",
    description:
      'Resume one archived task, returning it to the active list. Payload: {"taskFolder": "<folder name or task name>"}.',
    command: "vs-code-ai-helper.unarchiveTask",
    summaryVerb: "Unarchived",
    verify: (after) => after.status !== "archived",
    notAppliedReason:
      "the task is still archived — the command declined the unarchive (see the notification it showed for the reason)",
  }),
  makeSingleTaskCommandOperation({
    id: "pinTask",
    description:
      'Pin one task to the top of the task list. Payload: {"taskFolder": "<folder name or task name>"}.',
    command: "vs-code-ai-helper.pinTask",
    summaryVerb: "Pinned",
    verify: (after) => after.pinnedAt !== undefined,
    notAppliedReason:
      "the task was not pinned — the command declined it (see the notification it showed for the reason)",
  }),
  makeSingleTaskCommandOperation({
    id: "unpinTask",
    description:
      'Remove one task\'s pin. Payload: {"taskFolder": "<folder name or task name>"}.',
    command: "vs-code-ai-helper.unpinTask",
    summaryVerb: "Unpinned",
    verify: (after) => after.pinnedAt === undefined,
    notAppliedReason:
      "the task is still pinned — the command declined the unpin (see the notification it showed for the reason)",
  }),
  renameTaskOperation,
  setTaskStageOperation,
  triggerStageAI,
  archiveCompletedTasks,
  archiveTasks,
  unarchiveAllTasks,
  unarchiveTasks,
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
    const auditLogUri = await writeRunLog(
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
    // executeProposedAction (this function's only caller) runs inside its
    // caller's own tracked operation for ctx.assistantFolderUri's path — sole
    // production caller is chatWithStage.ts's stage-action executor, whose
    // handle isn't threaded this deep — resolve it by task path instead.
    // No-ops harmlessly if that operation has already ended.
    taskOperations.setResultTargetUriForTask(ctx.assistantFolderUri.fsPath, auditLogUri);
  } catch {
    // Auditing is best-effort; a log failure must not undo an executed action.
  }
}
