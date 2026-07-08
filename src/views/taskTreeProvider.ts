import * as vscode from "vscode";
import {
  AI_MODEL_STAGES,
  isReviewStage,
  STAGE_ARTIFACT_FILENAMES,
  STAGE_DISPLAY_NAMES,
  STAGE_ORDER,
  TaskStage,
} from "../types/taskProgress";
import { IncompleteTask } from "../utils/taskProgressUtils";
import { resolveCurrentPlanUri, statIfExists } from "../utils/fileUtils";
import {
  computeCollapseExpandContext,
  type ExpansionMode,
} from "../utils/collapseExpandContext";
import { computeStageContext } from "../utils/stageContext";
import { resolveImplementationArtifact } from "../utils/implementationArtifactResolver";
import { getLowLevelPlanUri } from "../utils/lowLevelPlanArtifactResolver";
import { parseReadiness } from "../utils/reviewReadiness";
import { TaskInventory, TaskWithProgress } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";

/**
 * The view ID for the tasks tree view (must match package.json)
 */
export const TASKS_VIEW_ID = "vs-code-ai-helper.tasksView";

type StageStatus = "done" | "current" | "outstanding";

/**
 * Determine the status of a stage relative to a task's current stage
 */
function getStageStatus(stage: TaskStage, currentStage: TaskStage): StageStatus {
  const stageIndex = STAGE_ORDER.indexOf(stage);
  const currentIndex = STAGE_ORDER.indexOf(currentStage);

  if (currentStage === "completed" || stageIndex < currentIndex) {
    return "done";
  }
  if (stageIndex === currentIndex) {
    return "current";
  }
  return "outstanding";
}

/**
 * Build a markdown tooltip summarizing a task's full stage checklist
 */
function buildTaskTooltip(task: IncompleteTask): vscode.MarkdownString {
  const lines: string[] = [`**${task.folderName}**`, ""];

  const isPaused = task.progress.status === "paused";
  if (isPaused) {
    lines.push("⏸ **Paused**", "");
  }

  for (const stage of STAGE_ORDER) {
    const status = getStageStatus(stage, task.progress.currentStage);
    const marker =
      status === "done" ? "$(check)" : status === "current" ? "$(arrow-right)" : "$(circle-large-outline)";
    const suffix =
      status === "current" ? " — **current**" : status === "outstanding" ? " — outstanding" : "";
    lines.push(`${marker} ${STAGE_DISPLAY_NAMES[stage]}${suffix}`);
    lines.push("");
  }

  lines.push(
    `_Last updated: ${new Date(task.progress.updatedAt).toLocaleString()}_`
  );

  const tooltip = new vscode.MarkdownString(lines.join("\n"), true);
  return tooltip;
}

/**
 * Adapt a TaskWithProgress to the IncompleteTask shape expected by tree nodes.
 */
function toIncompleteTask(t: TaskWithProgress): IncompleteTask {
  return {
    folderUri: vscode.Uri.file(t.taskFolderPath),
    folderName: t.folderName,
    progress: t.progress,
  };
}

/**
 * Tree node representing a single task folder
 */
export class TaskNode extends vscode.TreeItem {
  constructor(
    public readonly task: IncompleteTask,
    expanded: boolean,
    isCurrent: boolean = false
  ) {
    super(
      task.folderName,
      expanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
    );

    const currentStage = task.progress.currentStage;
    const stepNumber = STAGE_ORDER.indexOf(currentStage) + 1;
    const totalSteps = STAGE_ORDER.length;
    const isPaused = task.progress.status === "paused";

    if (currentStage === "completed") {
      this.description = "Completed";
      this.iconPath = new vscode.ThemeIcon(
        "pass-filled",
        new vscode.ThemeColor("charts.green")
      );
    } else if (isPaused) {
      this.description = `Paused · ${STAGE_DISPLAY_NAMES[currentStage]} · step ${stepNumber} of ${totalSteps}`;
      this.iconPath = new vscode.ThemeIcon(
        "debug-pause",
        new vscode.ThemeColor("charts.orange")
      );
    } else {
      this.description = `${STAGE_DISPLAY_NAMES[currentStage]} · step ${stepNumber} of ${totalSteps}`;
      this.iconPath = new vscode.ThemeIcon(
        "play-circle",
        new vscode.ThemeColor("charts.blue")
      );
    }

    // Highlight current task
    if (isCurrent) {
      this.resourceUri = vscode.Uri.parse(`current-task:${task.folderName}`);
    }

    this.tooltip = buildTaskTooltip(task);
    // Review-stage tasks surface the review action buttons instead of the
    // generic resume/set-stage pair.
    if (currentStage === "completed") {
      this.contextValue = "task-completed";
    } else if (isPaused) {
      this.contextValue = "task-paused";
    } else if (isReviewStage(currentStage)) {
      this.contextValue = "task-active-review";
    } else {
      this.contextValue = "task-active";
    }
  }
}

/**
 * Tree node representing one workflow stage within a task
 */
export class StageNode extends vscode.TreeItem {
  constructor(
    public readonly task: IncompleteTask,
    public readonly stage: TaskStage,
    status: StageStatus,
    artifactUri: vscode.Uri | undefined,
    /** Optional readiness info for review stages */
    readiness?: { label: string; icon: string; colorKey: string }
  ) {
    super(STAGE_DISPLAY_NAMES[stage], vscode.TreeItemCollapsibleState.None);

    const artifactName =
      artifactUri?.path.split("/").pop() ?? STAGE_ARTIFACT_FILENAMES[stage];

    switch (status) {
      case "done":
        if (readiness) {
          this.iconPath = new vscode.ThemeIcon(
            readiness.icon,
            new vscode.ThemeColor(readiness.colorKey)
          );
          this.description = `done · ${readiness.label}`;
        } else {
          this.iconPath = new vscode.ThemeIcon(
            "check",
            new vscode.ThemeColor("charts.green")
          );
          this.description = "done";
        }
        break;
      case "current":
        if (readiness) {
          this.iconPath = new vscode.ThemeIcon(
            readiness.icon,
            new vscode.ThemeColor(readiness.colorKey)
          );
          this.description = `current · ${readiness.label}`;
        } else {
          this.iconPath = new vscode.ThemeIcon(
            "arrow-right",
            new vscode.ThemeColor("charts.blue")
          );
          this.description = "current";
        }
        break;
      case "outstanding":
        this.iconPath = new vscode.ThemeIcon(
          "circle-large-outline",
          new vscode.ThemeColor("disabledForeground")
        );
        this.description = "outstanding";
        break;
    }

    if (artifactUri) {
      this.command = {
        command: "vscode.open",
        title: "Open Artifact",
        arguments: [artifactUri],
      };
      this.tooltip = artifactName ? `Open ${artifactName}` : "Open artifact";
    } else {
      this.tooltip = artifactName
        ? `${artifactName} has not been created yet`
        : STAGE_DISPLAY_NAMES[stage];
    }

    // Use the computed stage context for stage-specific buttons
    this.contextValue = getStageNodeContextValue(stage, status);
  }
}

/**
 * Computes the `contextValue` for a `StageNode` in the task tree view.
 * This value drives which action buttons are shown on hover for a given stage.
 *
 * @param stage The task stage represented by the node.
 * @param status The stage's status relative to the task's current progress.
 * @returns A string to be used as the `TreeItem.contextValue`.
 */
export function getStageNodeContextValue(
  stage: TaskStage,
  status: StageStatus
): string {
  let contextValue: string;

  if (status === "current") {
    switch (stage) {
      case "task-description":
        // Special case for the "task-description" stage.
        return "stage-task-description";
      case "plan":
        contextValue = "stage-plan-current";
        break;
      case "implementation":
        contextValue = "stage-impl-current";
        break;
      default:
        if (isReviewStage(stage)) {
          contextValue = "stage-review-current";
        } else {
          contextValue = "stage-current";
        }
    }
  } else {
    // For non-current stages, the context is simpler.
    contextValue = computeStageContext(stage);
  }

  // Stages that run an AI model get a "-modelable" suffix so the tree's
  // per-step "Set Model" hover action can target them via a regex `when`
  // clause without disturbing the status-specific action buttons above.
  if (AI_MODEL_STAGES.includes(stage)) {
    return `${contextValue}-modelable`;
  }

  return contextValue;
}

type TaskTreeNode = TaskNode | StageNode;

/**
 * Try to read review readiness from an artifact file.
 */
async function tryReadReadiness(
  artifactUri: vscode.Uri | undefined
): Promise<{ label: string; icon: string; colorKey: string } | undefined> {
  if (!artifactUri) {
    return undefined;
  }
  try {
    const content = await vscode.workspace.fs.readFile(artifactUri);
    const text = new TextDecoder().decode(content);
    const result = parseReadiness(text);
    return { label: result.label, icon: result.icon, colorKey: result.colorKey };
  } catch {
    return undefined;
  }
}

/**
 * Tree data provider for the Ensemble tasks view. Shows every task in the
 * meta resources folder with a per-stage checklist (done / current /
 * outstanding), so workflow progress is always visible at a glance.
 *
 * Accepts the shared TaskInventory so it and all commands use the same
 * discovered-task source.
 */
export class TaskTreeProvider implements vscode.TreeDataProvider<TaskTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly taskNodesByFolder = new Map<string, TaskNode>();

  private readonly _onDidLoadTasks = new vscode.EventEmitter<
    IncompleteTask[]
  >();
  /** Fired after the root task list is (re)loaded, e.g. for the status bar */
  readonly onDidLoadTasks = this._onDidLoadTasks.event;

  // Collapse/expand state management
  private mode: ExpansionMode = 'autoFirstActive';
  private lastLoadedTaskCount: number = 0;

  constructor(
    private readonly inventory: TaskInventory,
    private readonly currentTaskStore?: CurrentTaskStore
  ) {
    // When the shared inventory changes, refresh the tree automatically
    this.inventory.onDidChange(() => this._onDidChangeTreeData.fire());

    // Subscribe to current-task changes and refresh the tree
    if (currentTaskStore) {
      currentTaskStore.onDidChange(() => this._onDidChangeTreeData.fire());
    }
  }

  /**
   * Refresh the tree view. Also asks the inventory to reload so newly-created
   * tasks are visible immediately.
   */
  refresh(): void {
    this._onDidChangeTreeData.fire();
    this.loadTasks();
  }

  /** Collapse all task rows by switching to collapsed mode */
  collapseAll(): void {
    this.mode = 'allCollapsed';
    this.syncCollapseExpandContext();
    this._onDidChangeTreeData.fire();
  }

  /** Expand all task rows by switching to all-expanded mode */
  async expandAll(treeView: vscode.TreeView<TaskTreeNode>): Promise<void> {
    this.mode = 'allExpanded';
    this.syncCollapseExpandContext();
    this._onDidChangeTreeData.fire();

    // Force reveal all nodes to ensure they are expanded
    const nodes = this.getTaskNodes();
    for (const node of nodes) {
      try {
        await treeView.reveal(node, {
          expand: true,
          focus: false,
          select: false,
        });
      } catch {
        // Ignore reveal failures (node may not be visible yet)
      }
    }
  }

  getTreeItem(element: TaskTreeNode): vscode.TreeItem {
    return element;
  }

  getParent(element: TaskTreeNode): TaskNode | undefined {
    if (element instanceof TaskNode) {
      return undefined;
    }
    return this.taskNodesByFolder.get(element.task.folderUri.toString());
  }

  async getChildren(element?: TaskTreeNode): Promise<TaskTreeNode[]> {
    if (element instanceof TaskNode) {
      return this.getStageNodes(element.task);
    }
    if (element) {
      return [];
    }
    return this.getTaskNodes();
  }

  private loadTasks(): IncompleteTask[] {
    try {
      // Use the shared inventory as the source of truth
      const inventoryTasks = this.inventory.getTasks();
      const tasks: IncompleteTask[] = inventoryTasks.map(toIncompleteTask);

      const hasTasks = tasks.length > 0;
      void vscode.commands.executeCommand(
        "setContext",
        "vs-code-ai-helper.hasTasks",
        hasTasks
      );
      // Always report hasMetaFolder as true since we use .helper/plans by default
      void vscode.commands.executeCommand(
        "setContext",
        "vs-code-ai-helper.hasMetaFolder",
        true
      );

      this.lastLoadedTaskCount = tasks.length;
      this.syncCollapseExpandContext();
      this._onDidLoadTasks.fire(tasks);
      return tasks;
    } catch (error) {
      console.error('Failed to load tasks:', error);
      this.lastLoadedTaskCount = 0;
      this.syncCollapseExpandContext();
      this._onDidLoadTasks.fire([]);
      throw error;
    }
  }

  /**
   * Synchronize the collapse/expand context key with current provider state.
   */
  private syncCollapseExpandContext(): void {
    const allCollapsed = computeCollapseExpandContext(
      this.mode,
      this.lastLoadedTaskCount
    );
    void vscode.commands.executeCommand(
      "setContext",
      "vs-code-ai-helper.tasksViewAllCollapsed",
      allCollapsed
    );
  }

  private getTaskNodes(): TaskNode[] {
    const tasks = this.loadTasks();

    const active = tasks.filter((t) => t.progress.currentStage !== "completed");
    const completed = tasks.filter(
      (t) => t.progress.currentStage === "completed"
    );

    const shouldExpand = (index: number): boolean => {
      if (this.mode === 'allExpanded') {
        return true;
      }
      if (this.mode === 'allCollapsed') {
        return false;
      }
      // autoFirstActive mode
      return index === 0 && active.length > 0;
    };

    // Get current task ID
    const currentTaskCanonicalId = this.currentTaskStore?.get();

    const nodes = [...active, ...completed].map(
      (task, index) => {
        const isCurrent = currentTaskCanonicalId === task.folderUri.fsPath;
        return new TaskNode(task, shouldExpand(index), isCurrent);
      }
    );
    this.taskNodesByFolder.clear();
    for (const node of nodes) {
      this.taskNodesByFolder.set(node.task.folderUri.toString(), node);
    }

    return nodes;
  }

  private async getStageNodes(task: IncompleteTask): Promise<StageNode[]> {
    const nodes: StageNode[] = [];

    for (const stage of STAGE_ORDER) {
      const status = getStageStatus(stage, task.progress.currentStage);

      let artifactUri: vscode.Uri | undefined;

      if (stage === "plan") {
        const candidate = await resolveCurrentPlanUri(task.folderUri);
        artifactUri = (await statIfExists(candidate)) ? candidate : undefined;
      } else if (stage === "plan-low-review") {
        // Low-level plan stage opens plan-low.md
        const candidate = getLowLevelPlanUri(task.folderUri);
        artifactUri = (await statIfExists(candidate)) ? candidate : undefined;
      } else if (stage === "implementation") {
        // Merged stage: prefer plan-final.md, fallback to implementation.md
        const resolved = await resolveImplementationArtifact(task.folderUri);
        artifactUri = (await statIfExists(resolved.uri)) ? resolved.uri : undefined;
      } else {
        const artifactName = STAGE_ARTIFACT_FILENAMES[stage];
        if (artifactName) {
          const candidate = vscode.Uri.joinPath(task.folderUri, artifactName);
          artifactUri = (await statIfExists(candidate)) ? candidate : undefined;
        }
      }

      // For review stages, try to parse readiness from the artifact
      let readiness: { label: string; icon: string; colorKey: string } | undefined;
      if (isReviewStage(stage) && (status === "done" || status === "current")) {
        readiness = await tryReadReadiness(artifactUri);
      }

      nodes.push(new StageNode(task, stage, status, artifactUri, readiness));
    }

    return nodes;
  }
}
