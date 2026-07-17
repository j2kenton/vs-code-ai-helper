import * as vscode from "vscode";
import { StatusSurface } from "../utils/notificationRouter";
import { taskOperations } from "../utils/taskOperations";
import { TaskOperationSnapshot } from "../utils/taskOperations";
import { terminalEntryFor } from "../utils/operationNotificationBridge";

export const STATUS_VIEW_ID = "vs-code-ai-helper.statusView";

export interface StatusEntry {
  message: string;
  level: "info" | "warning" | "error";
  timestamp: Date;
  /** Absolute fsPath of the file this notification relates to, if any. Clicking the entry opens it. */
  filePath?: string;
}

export interface StatusOperationNode {
  readonly kind: "operation";
  readonly id: string;
  readonly label: string;
  readonly taskName: string;
  readonly detail?: string;
  /** Shows the inline cancel button (see the ensemble-operation-cancellable menu contribution). */
  readonly cancellable: boolean;
}

export type StatusTreeNode = StatusEntry | StatusOperationNode;

function isOperationNode(node: StatusTreeNode): node is StatusOperationNode {
  return (node as StatusOperationNode).kind === "operation";
}

const STATUS_STATE_KEY = "ensemble.notifications";
const RUNNING_OPERATIONS_STATE_KEY = "ensemble.runningOperations";
const LEVEL_FILTER_STATE_KEY = "ensemble.notificationLevelFilter";
const ALL_LEVELS: ReadonlyArray<StatusEntry["level"]> = ["info", "warning", "error"];
/** Label text above this length is truncated with an ellipsis; the full text is still in the hover tooltip. */
const LABEL_TRUNCATE_LENGTH = 150;

export class StatusTreeProvider implements vscode.TreeDataProvider<StatusTreeNode>, StatusSurface, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<StatusTreeNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private entries: StatusEntry[];
  private writes: Promise<void> = Promise.resolve();
  private readonly operationsSub: vscode.Disposable;
  /** Which notification levels are shown; all by default. */
  private levelFilter: Set<StatusEntry["level"]>;

  constructor(private readonly state?: vscode.Memento) {
    const savedFilter = state?.get<string[]>(LEVEL_FILTER_STATE_KEY);
    this.levelFilter = new Set(
      Array.isArray(savedFilter)
        ? (savedFilter.filter((l): l is StatusEntry["level"] => (ALL_LEVELS as readonly string[]).includes(l)))
        : ALL_LEVELS
    );
    if (this.levelFilter.size === 0) {
      this.levelFilter = new Set(ALL_LEVELS);
    }
    const persisted = state?.get<Array<Omit<StatusEntry, "timestamp"> & { timestamp: string }>>(STATUS_STATE_KEY, []) ?? [];
    // Notifications persist for the lifetime of this workspace with no
    // retention limit — the user only clears them explicitly via Clear All.
    this.entries = persisted
      .filter(entry => typeof entry.message === "string" && typeof entry.timestamp === "string")
      .map(entry => ({ ...entry, timestamp: new Date(entry.timestamp) }))
      .filter(entry => !Number.isNaN(entry.timestamp.getTime()));

    // Operations themselves are necessarily in-memory, but a tiny snapshot
    // lets a later activation tell the user that a live operation was cut off
    // by reload rather than silently losing its Notifications row.
    const interrupted = state?.get<SerializedOperation[]>(RUNNING_OPERATIONS_STATE_KEY, []) ?? [];
    for (const snapshot of interrupted) {
      const entry = terminalEntryFor({ ...snapshot, state: "interrupted" });
      if (entry) {
        this.entries.unshift({
          message: entry.message,
          level: "warning",
          timestamp: new Date(),
        });
      }
    }
    if (interrupted.length > 0) {
      this.persist();
      void state?.update(RUNNING_OPERATIONS_STATE_KEY, []);
    }

    // taskOperations is a module singleton that outlives this provider, so the
    // subscription must be released on dispose or it will fire into a dead emitter.
    this.operationsSub = taskOperations.onDidChange(() => {
      this.persistRunningOperations();
      this.refresh();
    });
  }

  dispose(): void {
    this.operationsSub.dispose();
  }

  /**
   * Add a new status entry to the surface.
   * Entries persist indefinitely (no retention cap); the user clears them via Clear All.
   */
  addEntry(message: string, level: "info" | "warning" | "error", filePath?: string): void {
    const entry: StatusEntry = {
      // Keep the complete process/result text. The tree label is compacted
      // separately, while the persisted entry remains useful after reload.
      message,
      level,
      timestamp: new Date(),
      filePath,
    };

    // Insert newest first
    this.entries.unshift(entry);

    this.persist();
    this.refresh();
    void vscode.commands.executeCommand("vs-code-ai-helper.statusView.focus").then(undefined, () => undefined);
  }

  /**
   * QuickPick for filtering notifications by type (info / warning / error).
   * Running-operation rows are never filtered out.
   */
  async chooseLevelFilter(): Promise<void> {
    const picked = await vscode.window.showQuickPick(
      ALL_LEVELS.map((level) => ({
        label: level[0]!.toUpperCase() + level.slice(1),
        picked: this.levelFilter.has(level),
        level,
      })),
      { canPickMany: true, title: "Filter notifications by type", placeHolder: "Select the notification types to show" }
    );
    if (!picked) return;
    this.levelFilter = picked.length === 0 ? new Set(ALL_LEVELS) : new Set(picked.map((item) => item.level));
    await this.state?.update(LEVEL_FILTER_STATE_KEY, [...this.levelFilter]);
    this.refresh();
  }

  /**
   * Clear all status entries. Useful for testing.
   */
  clear(): void {
    this.entries = [];
    this.persist();
    this.refresh();
  }

  /**
   * Get all entries currently stored.
   */
  getEntries(): StatusEntry[] {
    return [...this.entries];
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  private persist(): void {
    if (!this.state) return;
    const serialized = this.entries.map(entry => ({ ...entry, timestamp: entry.timestamp.toISOString() }));
    this.writes = this.writes.then(() => this.state!.update(STATUS_STATE_KEY, serialized));
    void this.writes.catch(() => undefined);
  }

  private persistRunningOperations(): void {
    if (!this.state) return;
    const snapshots = taskOperations.getRootOperations().map(serializeOperation);
    this.writes = this.writes.then(() => this.state!.update(RUNNING_OPERATIONS_STATE_KEY, snapshots));
    void this.writes.catch(() => undefined);
  }

  getTreeItem(element: StatusTreeNode): vscode.TreeItem {
    if (isOperationNode(element)) {
      const label = `${element.label} — ${element.taskName}`;
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      item.id = `running:${element.id}`;
      item.description = element.detail ?? "running";
      item.iconPath = new vscode.ThemeIcon("loading~spin", new vscode.ThemeColor("charts.blue"));
      // Cancellable operations get an inline stop button via the
      // view/item/context menu contribution keyed on this contextValue.
      item.contextValue = element.cancellable
        ? "ensemble-operation-cancellable"
        : "ensemble-operation";
      return item;
    }

    const isTruncated = element.message.length > LABEL_TRUNCATE_LENGTH;
    const label = isTruncated ? `${element.message.slice(0, LABEL_TRUNCATE_LENGTH)}…` : element.message;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);

    // Displayed timestamp is HH:mm (seconds are noisy for the user); the
    // underlying Date retains full precision and still drives ordering.
    const timeStr = element.timestamp.toLocaleTimeString(undefined, {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    });

    item.description = timeStr;

    if (element.filePath) {
      item.command = {
        command: "vscode.open",
        title: "Open File",
        arguments: [vscode.Uri.file(element.filePath)],
      };
      item.tooltip = new vscode.MarkdownString(
        `**[${element.level.toUpperCase()}]** ${element.message}\n\nTime: ${element.timestamp.toLocaleString()}\n\nClick to open the related file.`
      );
    } else {
      // Plain (non-Markdown, non-clickable-looking) tooltip when there's
      // nothing for a click to navigate to.
      item.tooltip = `[${element.level.toUpperCase()}] ${element.message}\n\nTime: ${element.timestamp.toLocaleString()}`;
    }

    // Icon based on severity
    let iconName = "info";
    let iconColor = "charts.blue";
    if (element.level === "warning") {
      iconName = "warning";
      iconColor = "charts.orange";
    } else if (element.level === "error") {
      iconName = "error";
      iconColor = "charts.red";
    }

    item.iconPath = new vscode.ThemeIcon(iconName, new vscode.ThemeColor(iconColor));
    return item;
  }

  getChildren(element?: StatusTreeNode): vscode.ProviderResult<StatusTreeNode[]> {
    if (!element) {
      // Root operations only (C1 nesting): a composite like Fast Forward
      // renders exactly one in-progress row, never one per internal attempt.
      // getRootOperations surfaces the newest child detail on the root row.
      const runningNodes = taskOperations.getRootOperations().map((op): StatusOperationNode => ({
        kind: "operation",
        id: op.id,
        label: op.label,
        taskName: op.taskName,
        detail: op.detail,
        cancellable: op.cancellable,
      }));
      return [...runningNodes, ...this.entries.filter((entry) => this.levelFilter.has(entry.level))];
    }
    return [];
  }
}

/** JSON-safe minimal representation of a root operation surviving reload. */
type SerializedOperation = Pick<
  TaskOperationSnapshot,
  "id" | "key" | "label" | "stage" | "taskName" | "startedAt" |
  "detail" | "exclusive" | "kind" | "parentId" | "cancellable"
>;

function serializeOperation(operation: TaskOperationSnapshot): SerializedOperation {
  const { id, key, label, stage, taskName, startedAt, detail, exclusive, kind, parentId, cancellable } = operation;
  return { id, key, label, stage, taskName, startedAt, detail, exclusive, kind, parentId, cancellable };
}
