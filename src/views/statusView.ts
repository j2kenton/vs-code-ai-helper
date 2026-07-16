import * as vscode from "vscode";
import { StatusSurface } from "../utils/notificationRouter";
import { taskOperations } from "../utils/taskOperations";

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
}

export type StatusTreeNode = StatusEntry | StatusOperationNode;

function isOperationNode(node: StatusTreeNode): node is StatusOperationNode {
  return (node as StatusOperationNode).kind === "operation";
}

const STATUS_STATE_KEY = "ensemble.notifications";
/** Label text above this length is truncated with an ellipsis; the full text is still in the hover tooltip. */
const LABEL_TRUNCATE_LENGTH = 150;

export class StatusTreeProvider implements vscode.TreeDataProvider<StatusTreeNode>, StatusSurface, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<StatusTreeNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private entries: StatusEntry[];
  private writes: Promise<void> = Promise.resolve();
  private readonly operationsSub: vscode.Disposable;

  constructor(private readonly state?: vscode.Memento) {
    const persisted = state?.get<Array<Omit<StatusEntry, "timestamp"> & { timestamp: string }>>(STATUS_STATE_KEY, []) ?? [];
    // Notifications persist for the lifetime of this workspace with no
    // retention limit — the user only clears them explicitly via Clear All.
    this.entries = persisted
      .filter(entry => typeof entry.message === "string" && typeof entry.timestamp === "string")
      .map(entry => ({ ...entry, timestamp: new Date(entry.timestamp) }))
      .filter(entry => !Number.isNaN(entry.timestamp.getTime()));

    // taskOperations is a module singleton that outlives this provider, so the
    // subscription must be released on dispose or it will fire into a dead emitter.
    this.operationsSub = taskOperations.onDidChange(() => this.refresh());
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

  getTreeItem(element: StatusTreeNode): vscode.TreeItem {
    if (isOperationNode(element)) {
      const label = `${element.label} — ${element.taskName}`;
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      item.id = `running:${element.id}`;
      item.description = element.detail ?? "running";
      item.iconPath = new vscode.ThemeIcon("loading~spin", new vscode.ThemeColor("charts.blue"));
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
      const runningNodes = taskOperations.getAll().map((op): StatusOperationNode => ({
        kind: "operation",
        id: op.id,
        label: op.label,
        taskName: op.taskName,
        detail: op.detail,
      }));
      return [...runningNodes, ...this.entries];
    }
    return [];
  }
}
