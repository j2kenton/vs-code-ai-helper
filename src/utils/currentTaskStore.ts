import * as vscode from "vscode";

const CURRENT_TASK_KEY = "vs-code-ai-helper.currentTaskCanonicalId";

/**
 * Persistent store for the "current task" canonical ID.
 *
 * Uses VS Code workspaceState so the selection survives reloads but is
 * scoped to the workspace (not shared across different projects).
 *
 * The canonical ID is the normalized absolute path of the task folder,
 * which is stable and unambiguous even when multiple roots are configured.
 */
export class CurrentTaskStore {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly workspaceState: vscode.Memento) {}

  /**
   * Read the persisted current-task canonical ID, or undefined when none.
   */
  get(): string | undefined {
    return this.workspaceState.get<string>(CURRENT_TASK_KEY);
  }

  /**
   * Persist a task as the current task using its canonical ID (normalized
   * absolute path).
   */
  async set(canonicalId: string): Promise<void> {
    await this.workspaceState.update(CURRENT_TASK_KEY, canonicalId);
    this._onDidChange.fire();
  }

  /**
   * Clear the persisted current task.
   */
  async clear(): Promise<void> {
    await this.workspaceState.update(CURRENT_TASK_KEY, undefined);
    this._onDidChange.fire();
  }
}
