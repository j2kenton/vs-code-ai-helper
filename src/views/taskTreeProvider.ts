import * as vscode from "vscode";
import * as path from "path";
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
import { resolveImplementationArtifact } from "../utils/implementationArtifactResolver";
import { parseReadiness } from "../utils/reviewReadiness";
import { TaskInventory, TaskWithProgress } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { buildTaskContextValue, buildStageContextValue } from "../utils/contextTokens";
import {
  resolveModelForStage,
  type ResolvedStageModel,
  type SelectableModel,
  describeResolvedModel,
  getAvailableModels,
} from "../utils/modelSelection";

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

  if (stageIndex < currentIndex) {
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
 * Return the stable identity key for a task, used as `TreeItem.id` and for
 * matching against the persisted `CurrentTaskStore` value.
 *
 * Prefers the canonicalId when present (normalized absolute path produced by
 * taskRoot.ts — lowercased on Windows). Falls back to `folderUri.fsPath` for
 * legacy task objects that were not sourced through TaskInventory.
 */
function taskIdentityKey(task: IncompleteTask): string {
  return task.canonicalId ?? task.folderUri.fsPath;
}

/**
 * Adapt a TaskWithProgress to the IncompleteTask shape expected by tree nodes.
 *
 * Preserves the canonicalId from the inventory so that every render surface
 * (TreeItem.id, status bar, isCurrent matching, getTaskNodeById) uses the
 * same normalized identity key that CurrentTaskStore persists. Without this,
 * a path-case difference on Windows (inventory normalizes to lower-case, but
 * Uri.file().fsPath preserves the original case) would cause the stored
 * canonical ID to not match the fsPath used for comparison, making the tree
 * badge and status bar miss the current task.
 */
function toIncompleteTask(t: TaskWithProgress): IncompleteTask {
  return {
    folderUri: vscode.Uri.file(t.taskFolderPath),
    folderName: t.folderName,
    progress: t.progress,
    canonicalId: t.canonicalId,
  };
}
// ... (skip down to TaskNode)
export class TaskNode extends vscode.TreeItem {
  constructor(
    public readonly task: IncompleteTask,
    expanded: boolean,
    isCurrent: boolean = false,
    isScheduled: boolean = false,
    hasPendingNote: boolean = false,
    isMetaManaged: boolean = false
  ) {
    super(
      task.folderName,
      expanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
    );

    // Stable identity so VS Code can preserve expansion state across
    // refreshes within the same session. Uses the canonical ID when
    // available (normalized, lowercased on Windows) so it matches
    // exactly what CurrentTaskStore persists, falling back to fsPath for
    // legacy task objects not sourced through TaskInventory.
    this.id = taskIdentityKey(task);

    const currentStage = task.progress.currentStage;
    const stepNumber = STAGE_ORDER.indexOf(currentStage) + 1;
    const totalSteps = STAGE_ORDER.length;
    const isPaused = task.progress.status === "paused";

    if (isPaused) {
      this.description = `Paused · ${STAGE_DISPLAY_NAMES[currentStage]} · step ${stepNumber} of ${totalSteps}`;
      this.iconPath = new vscode.ThemeIcon(
        "debug-pause",
        new vscode.ThemeColor("charts.orange")
      );
    } else if (task.progress.status === "completed") {
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

    // Highlight current task: synthesize a `current-task:` URI so the
    // FileDecorationProvider in extension.ts can paint the ▶ badge.
    // The URI authority carries the canonical identity key so the decoration
    // provider can invalidate it precisely when the current task changes.
    if (isCurrent) {
      this.resourceUri = vscode.Uri.parse(
        `current-task:${taskIdentityKey(task)}`
      );
    }

    this.tooltip = buildTaskTooltip(task);
    
    // Centralized context value construction via buildTaskContextValue
    this.contextValue = buildTaskContextValue({
      status: isPaused ? "paused" : (task.progress.status || "active"),
      currentStage,
      hasLintPayload: task.progress.lintPayload !== undefined,
      lintPassed: task.progress.lintPayload?.passed,
      isScheduled,
      hasPendingNote,
      isMetaManaged
    });
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
    readiness?: { label: string; icon: string; colorKey: string },
    modelInfo?: ResolvedStageModel,
    availableModels?: readonly SelectableModel[]  ,
    isScheduled: boolean = false,
    hasPendingNote: boolean = false,
    isMetaManaged: boolean = false
  ) {
    super(STAGE_DISPLAY_NAMES[stage], vscode.TreeItemCollapsibleState.None);

    const artifactName =
      artifactUri?.path.split("/").pop() ?? STAGE_ARTIFACT_FILENAMES[stage];

    switch (status) {
      case "done":
        // Completed stages always render with the done/tick icon, regardless
        // of whether readiness data is present. Overwriting the tick with a
        // readiness icon (thumbsup/question/thumbsdown) would make completed
        // stages visually ambiguous after a refresh — the acceptance criterion
        // for reliable completed-stage ticks requires the tick to be
        // unconditional for the "done" state.
        this.iconPath = new vscode.ThemeIcon(
          "check",
          new vscode.ThemeColor("charts.green")
        );
        this.description = "done";
        break;
      case "current":
        // Current review stages show the readiness icon so the user can see
        // the AI's assessment at a glance without opening the artifact.
        if (TaskTreeProvider.isStageRunning(task.canonicalId ?? task.folderUri.fsPath, stage)) {
          this.iconPath = new vscode.ThemeIcon("loading~spin", new vscode.ThemeColor("charts.blue"));
          this.description = "running";
        } else if (readiness) {
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
    }

    let tooltipStr = artifactName
      ? (artifactUri ? `Open ${artifactName}` : `${artifactName} has not been created yet`)
      : STAGE_DISPLAY_NAMES[stage];

    if (modelInfo && availableModels) {
      const effectiveStr = describeResolvedModel(modelInfo, availableModels);
      tooltipStr += `\n\nEffective Model: ${effectiveStr}`;
    }
    this.tooltip = new vscode.MarkdownString(tooltipStr, true);

    // Use the computed stage context for stage-specific buttons
    this.contextValue = getStageNodeContextValue(
      stage,
      status,
      task.progress.status === "paused",
      task.progress.lintPayload !== undefined,
      task.progress.lintPayload?.passed,
      isScheduled,
      hasPendingNote,
      isMetaManaged
    );
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
  status: StageStatus,
  isPaused: boolean = false,
  hasLintPayload: boolean = false,
  lintPassed?: boolean,
  isScheduled: boolean = false,
  hasPendingNote: boolean = false,
  isMetaManaged: boolean = false
): string {
  return buildStageContextValue({
    stage,
    status,
    isPaused,
    hasLintPayload,
    lintPassed,
    isScheduled,
    hasPendingNote,
    isMetaManaged,
  });
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
  private readonly explicitlyExpanded = new Set<string>();
  private readonly explicitlyCollapsed = new Set<string>();
  private availableModels: SelectableModel[] = [];

  private static readonly runningStages = new Map<string, Set<TaskStage>>();
  private static instance: TaskTreeProvider | undefined;

  static setStageRunning(canonicalId: string, stage: TaskStage, running: boolean): void {
    let set = this.runningStages.get(canonicalId);
    if (!set) {
      set = new Set<TaskStage>();
      this.runningStages.set(canonicalId, set);
    }
    if (running) {
      set.add(stage);
    } else {
      set.delete(stage);
    }
    if (this.instance) {
      this.instance._onDidChangeTreeData.fire();
    }
  }

  static isStageRunning(canonicalId: string, stage: TaskStage): boolean {
    return this.runningStages.get(canonicalId)?.has(stage) ?? false;
  }

  constructor(
    private readonly inventory: TaskInventory,
    private readonly currentTaskStore?: CurrentTaskStore
  ) {
    TaskTreeProvider.instance = this;
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
    this.explicitlyExpanded.clear();
    this.explicitlyCollapsed.clear();
    this.syncCollapseExpandContext();
    this._onDidChangeTreeData.fire();
  }

  /** Expand all task rows by switching to all-expanded mode */
  async expandAll(treeView: vscode.TreeView<TaskTreeNode>): Promise<void> {
    this.mode = 'allExpanded';
    this.explicitlyExpanded.clear();
    this.explicitlyCollapsed.clear();
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

  /**
   * Called when a task row is explicitly expanded by the user.
   * Records the choice so it survives refreshes within the same session.
   */
  notifyExpanded(task: IncompleteTask): void {
    const id = taskIdentityKey(task);
    this.explicitlyExpanded.add(id);
    this.explicitlyCollapsed.delete(id);
  }

  /**
   * Called when a task row is explicitly collapsed by the user.
   * Records the choice so it survives refreshes within the same session.
   */
  notifyCollapsed(task: IncompleteTask): void {
    const id = taskIdentityKey(task);
    this.explicitlyCollapsed.add(id);
    this.explicitlyExpanded.delete(id);
  }

  /**
   * Return the cached TaskNode for the given canonical ID, or undefined if the
   * node is not in the current render. Used by the reveal helper in
   * extension.ts so it can call `treeView.reveal()` with a live node reference.
   *
   * Matching priority:
   *   1. `task.canonicalId` — exact match against the normalized ID that
   *      CurrentTaskStore persists. This is the authoritative comparison and
   *      handles Windows case-normalization differences between the stored
   *      canonical ID and `folderUri.fsPath`.
   *   2. `task.folderUri.fsPath` — fallback for legacy nodes that were
   *      constructed without a canonical ID (e.g. direct URI scan tasks).
   */
  getTaskNodeById(canonicalId: string): TaskNode | undefined {
    for (const node of this.taskNodesByFolder.values()) {
      if (
        node.task.canonicalId === canonicalId ||
        node.task.folderUri.fsPath === canonicalId
      ) {
        return node;
      }
    }
    return undefined;
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

  private isMetaManaged: boolean = false;

  private async updateMetaManagedStatus(): Promise<void> {
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        this.isMetaManaged = false;
        return;
      }
      
      const metaPath = vscode.workspace.getConfiguration("vs-code-ai-helper").get<string>("metaResourcesPath") || ".helper/plans";
      if (!metaPath || metaPath.trim() === "" || path.isAbsolute(metaPath)) {
        this.isMetaManaged = false;
        return;
      }
      
      const normalized = path.normalize(metaPath);
      if (normalized.startsWith("..") || normalized.includes(`..${path.sep}`)) {
        this.isMetaManaged = false;
        return;
      }
      
      const gitignorePath = normalized.replace(/\\/g, "/");
      const firstFolder = workspaceFolders[0];
      if (!firstFolder) {
        this.isMetaManaged = false;
        return;
      }
      const workspaceRoot = firstFolder.uri.fsPath;
      const gitignoreUri = vscode.Uri.file(path.join(workspaceRoot, ".gitignore"));
      
      const fileContent = await vscode.workspace.fs.readFile(gitignoreUri);
      const content = new TextDecoder().decode(fileContent);
      const lines = content.split(/\r?\n/);
      const metaResourcesEntry = `/${gitignorePath}`;
      
      this.isMetaManaged = lines.some((line) => line.trim() === metaResourcesEntry);
    } catch {
      this.isMetaManaged = false;
    }
  }

  async getChildren(element?: TaskTreeNode): Promise<TaskTreeNode[]> {
    if (!element) {
      await this.updateMetaManagedStatus();
    }
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

    const active = tasks.filter((t) => t.progress.status !== "completed");
    const completed = tasks.filter(
      (t) => t.progress.status === "completed"
    );

    const shouldExpand = (task: IncompleteTask, index: number): boolean => {
      const id = taskIdentityKey(task);

      // Explicit user state takes precedence over mode
      if (this.explicitlyExpanded.has(id)) {
        return true;
      }
      if (this.explicitlyCollapsed.has(id)) {
        return false;
      }

      // Otherwise follow the global mode
      if (this.mode === 'allExpanded') {
        return true;
      }
      if (this.mode === 'allCollapsed') {
        return false;
      }
      // autoFirstActive mode: expand only the first active task
      return index === 0 && active.length > 0;
    };

    // Get current task ID from the store (canonical normalized path).
    // Compare against task.canonicalId first, falling back to fsPath for
    // legacy task objects that have no canonicalId.
    const currentTaskCanonicalId = this.currentTaskStore?.get();

    const nodes = [...active, ...completed].map(
      (task, index) => {
        const taskId = taskIdentityKey(task);
        const isCurrent =
          currentTaskCanonicalId !== undefined &&
          taskId === currentTaskCanonicalId;
        const isScheduled = task.progress.scheduledResumeTime !== undefined;
        const hasPendingNote = task.progress.pendingNotes !== undefined &&
          Object.keys(task.progress.pendingNotes).length > 0;
        return new TaskNode(
          task,
          shouldExpand(task, index),
          isCurrent,
          isScheduled,
          hasPendingNote,
          this.isMetaManaged
        );
      }
    );

    // Rebuild the folder→node cache so getParent and getTaskNodeById work
    this.taskNodesByFolder.clear();
    for (const node of nodes) {
      this.taskNodesByFolder.set(node.task.folderUri.toString(), node);
    }

    return nodes;
  }

  private async getStageNodes(task: IncompleteTask): Promise<StageNode[]> {
    const nodes: StageNode[] = [];

    if (this.availableModels.length === 0) {
      try {
        this.availableModels = await getAvailableModels();
      } catch {
        // ignore
      }
    }

    for (const stage of STAGE_ORDER) {
      const status = getStageStatus(stage, task.progress.currentStage);

      let artifactUri: vscode.Uri | undefined;

      if (stage === "plan") {
        const candidate = await resolveCurrentPlanUri(task.folderUri);
        artifactUri = (await statIfExists(candidate)) ? candidate : undefined;
      } else if (stage === "impl") {
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

      // For review stages, only try to parse readiness when the stage is
      // current — done stages always render with the tick icon regardless of
      // readiness data present in the artifact.
      let readiness: { label: string; icon: string; colorKey: string } | undefined;
      if (isReviewStage(stage) && status === "current") {
        readiness = await tryReadReadiness(artifactUri);
      }

      let modelInfo: ResolvedStageModel | undefined;
      if (AI_MODEL_STAGES.includes(stage)) {
        modelInfo = await resolveModelForStage(task.folderUri, stage);
      }

      const isStageScheduled = status === "current" && task.progress.scheduledResumeTime !== undefined;
      const isStagePendingNote = status === "current" && task.progress.pendingNotes?.[stage] !== undefined;

      nodes.push(
        new StageNode(
          task,
          stage,
          status,
          artifactUri,
          readiness,
          modelInfo,
          this.availableModels,
          isStageScheduled,
          isStagePendingNote,
          this.isMetaManaged
        )
      );
    }

    return nodes;
  }
}
