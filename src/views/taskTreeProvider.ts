import * as vscode from "vscode";
import {
  getMetaResourcesPath,
  hasValidMetaResourcesPath,
} from "../config/settings";
import {
  STAGE_DISPLAY_NAMES,
  STAGE_ORDER,
  TASK_FILENAME,
  TaskStage,
} from "../types/taskProgress";
import { findAllTasks, IncompleteTask } from "../utils/taskProgressUtils";

/**
 * The view ID for the tasks tree view (must match package.json)
 */
export const TASKS_VIEW_ID = "vs-code-ai-helper.tasksView";

/**
 * Maps each stage to the markdown artifact it produces, so stage nodes can
 * open the corresponding file. "completed" has no artifact of its own.
 */
const STAGE_ARTIFACT_FILENAMES: Record<TaskStage, string | undefined> = {
  created: TASK_FILENAME,
  plan: "plan.md",
  "plan-review": "plan-review.md",
  "plan-updated": "plan-updated.md",
  "plan-updated-review": "plan-updated-review.md",
  "plan-final": "plan-final.md",
  completed: undefined,
};

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
    this.contextValue =
      currentStage === "completed" ? "task-completed" : "task-active";
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
      this.tooltip = `Open ${STAGE_ARTIFACT_FILENAMES[stage] ?? ""}`;
    } else {
      const artifactName = STAGE_ARTIFACT_FILENAMES[stage];
      this.tooltip = artifactName
        ? `${artifactName} has not been created yet`
        : STAGE_DISPLAY_NAMES[stage];
    }

    this.contextValue = "stage";
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

  getTreeItem(element: TaskTreeNode): vscode.TreeItem {
    return element;
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
    return [...active, ...completed].map(
      (task, index) => new TaskNode(task, index === 0 && active.length > 0)
    );
  }

  private async getStageNodes(task: IncompleteTask): Promise<StageNode[]> {
    const nodes: StageNode[] = [];

    for (const stage of STAGE_ORDER) {
      const status = getStageStatus(stage, task.progress.currentStage);
      const artifactName = STAGE_ARTIFACT_FILENAMES[stage];

      let artifactUri: vscode.Uri | undefined;
      if (artifactName) {
        const candidate = vscode.Uri.joinPath(task.folderUri, artifactName);
        try {
          await vscode.workspace.fs.stat(candidate);
          artifactUri = candidate;
        } catch {
          // Artifact not created yet
        }
      }

      nodes.push(new StageNode(task, stage, status, artifactUri));
    }

    return nodes;
  }
}
