import * as vscode from "vscode";
import {
  getMetaResourcesPath,
  hasValidMetaResourcesPath,
} from "../config/settings";
import {
  isReviewStage,
  STAGE_ARTIFACT_FILENAMES,
  STAGE_DISPLAY_NAMES,
  STAGE_ORDER,
  TaskStage,
} from "../types/taskProgress";
import { findAllTasks, IncompleteTask } from "../utils/taskProgressUtils";
import { resolveCurrentPlanUri, statIfExists } from "../utils/fileUtils";

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
    // generic resume/set-stage pair. Keep "created" distinct so the tree
    // can hide the generic Next Stage button in favor of curated actions.
    this.contextValue =
      currentStage === "completed"
        ? "task-completed"
        : currentStage === "created"
          ? "task-created"
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

    // The current review stage's row carries the review action buttons
    this.contextValue =
      status === "current" && isReviewStage(stage)
        ? "stage-review-current"
        : status === "current" && (stage === "plan" || stage === "implementation")
          ? "stage-reviewable-current"
        : status === "current"
          ? "stage-current"
        : "stage";
  }
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

  /** Expand every task row currently shown in the tree view. */
  async expandAll(treeView: vscode.TreeView<TaskTreeNode>): Promise<void> {
    if (this.lastTaskNodes.length === 0) {
      this.lastTaskNodes = await this.getTaskNodes();
      this._onDidChangeTreeData.fire();
    }

    for (const node of this.lastTaskNodes) {
      await treeView.reveal(node, {
        expand: true,
        focus: false,
        select: false,
      });
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
    const metaFolderUri = getMetaFolderUri();

    void vscode.commands.executeCommand(
      "setContext",
      "vs-code-ai-helper.hasMetaFolder",
      metaFolderUri !== undefined
    );

    if (!metaFolderUri) {
      this._onDidLoadTasks.fire([]);
      return [];
    }

    const tasks = await findAllTasks(metaFolderUri);

    void vscode.commands.executeCommand(
      "setContext",
      "vs-code-ai-helper.hasTasks",
      tasks.length > 0
    );

    this._onDidLoadTasks.fire(tasks);
    return tasks;
  }

  private async getTaskNodes(): Promise<TaskNode[]> {
    const tasks = await this.loadTasks();

    // Active tasks first (most recent first), completed tasks after
    const active = tasks.filter((t) => t.progress.currentStage !== "completed");
    const completed = tasks.filter(
      (t) => t.progress.currentStage === "completed"
    );

    // Auto-expand the most recently updated active task so the user
    // immediately sees where they are in the workflow
    const nodes = [...active, ...completed].map(
      (task, index) =>
        new TaskNode(task, index === 0 && active.length > 0)
    );
    this.taskNodesByFolder.clear();
    for (const node of nodes) {
      this.taskNodesByFolder.set(node.task.folderUri.toString(), node);
    }
    this.lastTaskNodes = nodes;
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
