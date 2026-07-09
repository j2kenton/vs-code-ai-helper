import * as vscode from "vscode";
import { StatusSurface } from "../utils/notificationRouter";

const MAX_ENTRIES = 50;
const MAX_MESSAGE_LENGTH = 150;

export interface StatusEntry {
  message: string;
  level: "info" | "warning" | "error";
  timestamp: Date;
}

export class StatusTreeProvider implements vscode.TreeDataProvider<StatusEntry>, StatusSurface {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<StatusEntry | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private entries: StatusEntry[] = [];

  constructor() {}

  /**
   * Add a new status entry to the surface.
   * Enforces bounded retention (MAX_ENTRIES), newest-first ordering, and text trimming.
   */
  addEntry(message: string, level: "info" | "warning" | "error"): void {
    const trimmedMessage =
      message.length > MAX_MESSAGE_LENGTH
        ? message.substring(0, MAX_MESSAGE_LENGTH) + "..."
        : message;

    const entry: StatusEntry = {
      message: trimmedMessage,
      level,
      timestamp: new Date(),
    };

    // Insert newest first
    this.entries.unshift(entry);

    // Keep retention bounded
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.pop();
    }

    this.refresh();
  }

  /**
   * Clear all status entries. Useful for testing.
   */
  clear(): void {
    this.entries = [];
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

  getTreeItem(element: StatusEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(element.message, vscode.TreeItemCollapsibleState.None);
    
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

  getChildren(element?: StatusEntry): vscode.ProviderResult<StatusEntry[]> {
    if (element) {
      return [];
    }
    return this.entries;
  }
}
