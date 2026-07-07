import * as vscode from "vscode";

/**
 * Token representing an active loading operation for a specific task/stage scope
 */
export interface LoadingToken {
  taskId: string;
  stageId: string;
  /** Internal sequence number for this token */
  _seq: number;
}

/**
 * Manages loading state for task stages, supporting nested reuse and
 * concurrent protection.
 */
export class StageLoadingState {
  private loadingScopes = new Map<string, LoadingToken>();
  private tokenSequence = 0;
  private readonly _onDidChange = new vscode.EventEmitter<void>();

  readonly onDidChange = this._onDidChange.event;

  /**
   * Begin loading for a task/stage scope. Returns a token to be passed to end().
   * Rejects if the same scope is already loading without an explicit token.
   */
  begin(taskId: string, stageId: string, existingToken?: LoadingToken): LoadingToken {
    const scopeKey = `${taskId}:${stageId}`;

    // If we have an existing token for this exact scope, reuse it
    if (
      existingToken &&
      existingToken.taskId === taskId &&
      existingToken.stageId === stageId
    ) {
      return existingToken;
    }

    // Check for conflicting concurrent load
    const existing = this.loadingScopes.get(scopeKey);
    if (existing) {
      throw new Error(
        `Loading already in progress for task "${taskId}", stage "${stageId}"`
      );
    }

    const token: LoadingToken = {
      taskId,
      stageId,
      _seq: ++this.tokenSequence,
    };

    this.loadingScopes.set(scopeKey, token);
    this._onDidChange.fire();

    return token;
  }

  /**
   * End loading for the given token. Only the owner of the token should call this.
   */
  end(token: LoadingToken): void {
    const scopeKey = `${token.taskId}:${token.stageId}`;
    const current = this.loadingScopes.get(scopeKey);

    // Only clear if this token is the current owner
    if (current && current._seq === token._seq) {
      this.loadingScopes.delete(scopeKey);
      this._onDidChange.fire();
    }
  }

  /**
   * Check if a specific task/stage scope is currently loading
   */
  isLoading(taskId: string, stageId: string): boolean {
    const scopeKey = `${taskId}:${stageId}`;
    return this.loadingScopes.has(scopeKey);
  }
}
