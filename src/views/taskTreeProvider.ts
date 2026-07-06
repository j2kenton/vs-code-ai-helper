import * as vscode from "vscode";
import {
  getMetaResourcesPath,
  hasValidMetaResourcesPath,
} from "../config/settings";
import {
  AI_MODEL_STAGES,
  isReviewStage,
  STAGE_ARTIFACT_FILENAMES,
  STAGE_DISPLAY_NAMES,
  STAGE_ORDER,
  TaskStage,
} from "../types/taskProgress";
import { findAllTasks, IncompleteTask } from "../utils/taskProgressUtils";
import { resolveCurrentPlanUri, statIfExists } from "../utils/fileUtils";
import {
  computeCollapseExpandContext,
  type ExpansionMode,
} from "../utils/collapseExpandContext";
import { computeStageContext } from "../utils/stageContext";

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
 * Tree node representing a single task folder
 */
export class TaskNode extends vscode.TreeItem {
  constructor(
    public readonly task: IncompleteTask,
    expanded: boolean
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

    if (currentStage === "completed") {
      this.description = "Completed";
      this.iconPath = new vscode.ThemeIcon(
        "pass-filled",
        new vscode.ThemeColor("charts.green")
      );
    } else {
      this.description = `${STAGE_DISPLAY_NAMES[currentStage]} · step ${stepNumber} of ${totalSteps}`;
      this.iconPath = new vscode.ThemeIcon(
        "play-circle",
        new vscode.ThemeColor("charts.blue")
      );
    }

    this.tooltip = buildTaskTooltip(task);
    // Review-stage tasks surface the review action buttons instead of the
    // generic resume/set-stage pair.
    this.contextValue =
      currentStage === "completed"
        ? "task-completed"
        : isReviewStage(currentStage)
          ? "task-active-review"
          : "task-active";
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
    artifactUri: vscode.Uri | undefined
  ) {
    super(STAGE_DISPLAY_NAMES[stage], vscode.TreeItemCollapsibleState.None);

    const artifactName =
      artifactUri?.path.split("/").pop() ?? STAGE_ARTIFACT_FILENAMES[stage];

    switch (status) {
      case "done":
        this.iconPath = new vscode.ThemeIcon(
          "check",
          new vscode.ThemeColor("charts.green")
        );
        this.description = "done";
        break;
      case "current":
        this.iconPath = new vscode.ThemeIcon(
          "arrow-right",
          new vscode.ThemeColor("charts.blue")
        );
        this.description = "current";
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
      case "created":
        // Special case for the "created" stage to show "Generate Plan" and "View Task".
        // This value is targeted by an exact-match `when` clause in package.json,
        // so it must not be appended with "-modelable" even if it becomes a modelable stage.
        return "stage-created";
      case "plan":
        contextValue = "stage-reviewable-current";
        break;
      case "plan-final":
        contextValue = "stage-plan-final-current";
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
 * Resolve the configured meta resources folder URI, if any
 */
export function getMetaFolderUri(): vscode.Uri | undefined {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceRoot || !hasValidMetaResourcesPath()) {
    return undefined;
  }
  return vscode.Uri.joinPath(workspaceRoot.uri, getMetaResourcesPath());
}

/**
 * Tree data provider for the AI Helper tasks view. Shows every task in the
 * meta resources folder with a per-stage checklist (done / current /
 * outstanding), so workflow progress is always visible at a glance.
 */
export class TaskTreeProvider implements vscode.TreeDataProvider<TaskTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private lastTaskNodes: TaskNode[] = [];
  private readonly taskNodesByFolder = new Map<string, TaskNode>();

  private readonly _onDidLoadTasks = new vscode.EventEmitter<
    IncompleteTask[]
  >();
  /** Fired after the root task list is (re)loaded, e.g. for the status bar */
  readonly onDidLoadTasks = this._onDidLoadTasks.event;

  // Collapse/expand state management
  // TODO: Consider persisting mode preference in workspace settings for better UX across sessions
  private mode: ExpansionMode = 'autoFirstActive';
  private rootRenderVersion: number = 0;
  private lastLoadedTaskCount: number = 0;
  private refreshInProgress: boolean = false;
  private pendingModeSwitch: ExpansionMode | null = null;

  /**
   * Refresh both the tree view and any other listeners (e.g. the status
   * bar) that depend on the current task list. Loads the task list itself
   * rather than relying on the tree view asking for its root children,
   * since that only happens while the view is visible/expanded — without
   * this, refreshes while the sidebar is collapsed would never reach
   * listeners of `onDidLoadTasks`.
   */
  refresh(): void {
    this._onDidChangeTreeData.fire();
    void this.loadTasks();
  }

  /** Collapse all task rows by switching to collapsed mode */
  collapseAll(): void {
    try {
      this.mode = 'allCollapsed';
      this.rootRenderVersion++;
      this.lastTaskNodes = [];
      this.refresh();
      // Context sync happens automatically at end of loadTasks()
    } catch (error) {
      console.error('Failed to collapse tasks:', error);
      // Revert mode and sync context on error
      this.mode = 'autoFirstActive';
      this.syncCollapseExpandContext();
      void vscode.window.showErrorMessage(
        `Failed to load tasks: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /** Expand all task rows by switching to auto-expand mode */
  async expandAll(treeView: vscode.TreeView<TaskTreeNode>): Promise<void> {
    try {
      this.mode = 'autoFirstActive';
      this.rootRenderVersion++;
      this.lastTaskNodes = [];

      // Refresh to get new nodes with expanded state
      this._onDidChangeTreeData.fire();
      const nodes = await this.getTaskNodes();

      // Reveal each root node expanded
      for (const node of nodes) {
        await treeView.reveal(node, {
          expand: true,
          focus: false,
          select: false,
        });
      }

      // Context sync happens automatically at end of loadTasks()
    } catch (error) {
      console.error('Failed to expand tasks:', error);
      // Revert mode and sync context on error
      this.mode = 'allCollapsed';
      this.lastTaskNodes = [];
      this.syncCollapseExpandContext();
      void vscode.window.showErrorMessage(
        `Failed to load tasks: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /** Handle manual expand of a task node */
  handleManualExpand(): void {
    if (this.mode === 'allCollapsed') {
      if (this.refreshInProgress) {
        // Defer mode switch until refresh completes
        this.pendingModeSwitch = 'autoFirstActive';
      } else {
        // Switch immediately and sync context
        this.mode = 'autoFirstActive';
        this.syncCollapseExpandContext();
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

  private async loadTasks(): Promise<IncompleteTask[]> {
    this.refreshInProgress = true;
    try {
      const metaFolderUri = getMetaFolderUri();

      void vscode.commands.executeCommand(
        "setContext",
        "vs-code-ai-helper.hasMetaFolder",
        metaFolderUri !== undefined
      );

      if (!metaFolderUri) {
        void vscode.commands.executeCommand(
          "setContext",
          "vs-code-ai-helper.hasTasks",
          false
        );
        this.lastLoadedTaskCount = 0;
        this._onDidLoadTasks.fire([]);
        return [];
      }

      const tasks = await findAllTasks(metaFolderUri);

      void vscode.commands.executeCommand(
        "setContext",
        "vs-code-ai-helper.hasTasks",
        tasks.length > 0
      );

      this.lastLoadedTaskCount = tasks.length;
      this._onDidLoadTasks.fire(tasks);
      return tasks;
    } catch (error) {
      console.error('Failed to load tasks:', error);
      this.lastLoadedTaskCount = 0;
      this._onDidLoadTasks.fire([]);
      throw error;
    } finally {
      this.refreshInProgress = false;
      // Apply any pending mode switch that occurred during refresh
      if (this.pendingModeSwitch !== null) {
        this.mode = this.pendingModeSwitch;
        this.pendingModeSwitch = null;
      }
      // Sync context automatically after every loadTasks completion
      this.syncCollapseExpandContext();
    }
  }

  /**
   * Synchronize the collapse/expand context key with current provider state.
   * This is the only place that writes vs-code-ai-helper.tasksViewAllCollapsed.
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

  private async getTaskNodes(): Promise<TaskNode[]> {
    const tasks = await this.loadTasks();

    // Update task count after successful load (already done in loadTasks)
    // this.lastLoadedTaskCount = tasks.length;

    // Active tasks first (most recent first), completed tasks after
    const active = tasks.filter((t) => t.progress.currentStage !== "completed");
    const completed = tasks.filter(
      (t) => t.progress.currentStage === "completed"
    );

    // Auto-expand the first active task only in autoFirstActive mode
    const shouldAutoExpand = (index: number): boolean =>
      this.mode === 'autoFirstActive' && index === 0 && active.length > 0;

    const nodes = [...active, ...completed].map(
      (task, index) =>
        new TaskNode(task, shouldAutoExpand(index))
    );
    this.taskNodesByFolder.clear();
    for (const node of nodes) {
      this.taskNodesByFolder.set(node.task.folderUri.toString(), node);
    }
    this.lastTaskNodes = nodes;

    // Context sync now happens at end of loadTasks(), no need here
    return nodes;
  }

  private async getStageNodes(task: IncompleteTask): Promise<StageNode[]> {
    const nodes: StageNode[] = [];

    for (const stage of STAGE_ORDER) {
      const status = getStageStatus(stage, task.progress.currentStage);

      // The "plan" stage's artifact may live at the legacy plan-updated.md
      // path for tasks migrated from pre-0.6.0 stage names; resolve it the
      // same way the AI commands do rather than assuming plan.md.
      let artifactUri: vscode.Uri | undefined;
      if (stage === "plan") {
        const candidate = await resolveCurrentPlanUri(task.folderUri);
        artifactUri = (await statIfExists(candidate)) ? candidate : undefined;
      } else {
        const artifactName = STAGE_ARTIFACT_FILENAMES[stage];
        if (artifactName) {
          const candidate = vscode.Uri.joinPath(task.folderUri, artifactName);
          artifactUri = (await statIfExists(candidate)) ? candidate : undefined;
        }
      }

      nodes.push(new StageNode(task, stage, status, artifactUri));
    }

    return nodes;
  }
}
