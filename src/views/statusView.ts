import * as vscode from "vscode";
import { StatusSurface } from "../utils/notificationRouter";

export interface StatusEntry {
  message: string;
  level: "info" | "warning" | "error";
  timestamp: Date;
}

/** Synthetic child node revealing an entry's full text when expanded. */
interface StatusDetailNode {
  readonly kind: "detail";
  readonly entry: StatusEntry;
}

type StatusTreeNode = StatusEntry | StatusDetailNode;

function isDetailNode(node: StatusTreeNode): node is StatusDetailNode {
  return (node as StatusDetailNode).kind === "detail";
}

const STATUS_STATE_KEY = "ensemble.notifications";
/** Label text above this length gets a "click to expand" child row instead of a hover-only tooltip. */
const LABEL_TRUNCATE_LENGTH = 150;

export class StatusTreeProvider implements vscode.TreeDataProvider<StatusTreeNode>, StatusSurface {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<StatusTreeNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private entries: StatusEntry[];
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly state?: vscode.Memento) {
    const persisted = state?.get<Array<Omit<StatusEntry, "timestamp"> & { timestamp: string }>>(STATUS_STATE_KEY, []) ?? [];
    // Notifications persist for the lifetime of this workspace with no
    // retention limit — the user only clears them explicitly via Clear All.
    this.entries = persisted
      .filter(entry => typeof entry.message === "string" && typeof entry.timestamp === "string")
      .map(entry => ({ ...entry, timestamp: new Date(entry.timestamp) }))
      .filter(entry => !Number.isNaN(entry.timestamp.getTime()));
  }

  /**
   * Add a new status entry to the surface.
   * Entries persist indefinitely (no retention cap); the user clears them via Clear All.
   */
  addEntry(message: string, level: "info" | "warning" | "error"): void {
    const entry: StatusEntry = {
      // Keep the complete process/result text. The tree label is compacted
      // separately, while the persisted entry remains useful after reload.
      message,
      level,
      timestamp: new Date(),
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
    if (isDetailNode(element)) {
      const item = new vscode.TreeItem(element.entry.message, vscode.TreeItemCollapsibleState.None);
      item.tooltip = new vscode.MarkdownString(element.entry.message);
      return item;
    }

    const isTruncated = element.message.length > LABEL_TRUNCATE_LENGTH;
    const label = isTruncated ? `${element.message.slice(0, LABEL_TRUNCATE_LENGTH)}…` : element.message;
    const item = new vscode.TreeItem(
      label,
      isTruncated ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );

    // Format timestamp as HH:mm:ss
    const timeStr = element.timestamp.toLocaleTimeString(undefined, {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    item.description = timeStr;
    item.tooltip = new vscode.MarkdownString(
      `**[${element.level.toUpperCase()}]** ${element.message}\n\nTime: ${element.timestamp.toLocaleString()}`
    );

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
      return this.entries;
    }
    if (isDetailNode(element)) {
      return [];
    }
    // Clicking the caret on a truncated entry reveals its full text below it.
    return element.message.length > LABEL_TRUNCATE_LENGTH
      ? [{ kind: "detail", entry: element }]
      : [];
  }
}
