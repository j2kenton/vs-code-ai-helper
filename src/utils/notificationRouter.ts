export interface StatusSurface {
  /**
   * `resultTargetUri` is a stringified vscode.Uri (parse with
   * vscode.Uri.parse()) pointing at the operation's result artifact/run log,
   * distinct from the legacy `filePath` (a bare fsPath, opened with
   * vscode.Uri.file()). Never conflate the two.
   *
   * `sourceOperationId` is the id of the taskOperations root operation this
   * entry is about, when known. The surface only shows an inline cancel
   * action for it when that id still resolves to a currently live,
   * cancellable root operation — a terminal/history entry for an already-
   * ended operation renders with no cancel affordance.
   */
  addEntry(
    message: string,
    level: "info" | "warning" | "error",
    filePath?: string,
    resultTargetUri?: string,
    sourceOperationId?: string,
    actionCommand?: { command: string; title: string; args?: unknown[] }
  ): void;
}

let activeStatusSurface: StatusSurface | undefined = undefined;
let isInitialized = false;

export function initNotificationRouter(surface: StatusSurface): void {
  activeStatusSurface = surface;
  isInitialized = true;
}

export function deactivateNotificationRouter(): void {
  activeStatusSurface = undefined;
  isInitialized = false;
}

export function getNotificationRouterStatus(): boolean {
  return isInitialized;
}

function checkInitialized(): StatusSurface {
  if (!isInitialized || !activeStatusSurface) {
    throw new Error("NotificationRouter is not initialized. Please call initNotificationRouter first.");
  }
  return activeStatusSurface;
}

/**
 * Shared wrapper for routine notifications.
 * Routing rules:
 * 1. Routine informational messages and non-blocking notices are routed to the status surface.
 * 2. Destructive confirmations and blocking prompts remain as popup dialogs.
 * 3. Long-running progress notifications remain, but concise summaries are also emitted to the status surface.
 */
export const NotificationRouter = {
  /**
   * Route routine informational message.
   * NOTE: Routine notices must never raise an OS toast (desktop notification).
   */
  showInformation(message: string, filePath?: string, resultTargetUri?: string, sourceOperationId?: string): void {
    const surface = checkInitialized();
    surface.addEntry(message, "info", filePath, resultTargetUri, sourceOperationId);
  },

  /**
   * Route routine warning message.
   * NOTE: Routine warning notices must never raise an OS toast (desktop notification).
   */
  showWarning(
    message: string,
    filePath?: string,
    resultTargetUri?: string,
    sourceOperationId?: string,
    actionCommand?: { command: string; title: string; args?: unknown[] }
  ): void {
    const surface = checkInitialized();
    surface.addEntry(message, "warning", filePath, resultTargetUri, sourceOperationId, actionCommand);
  },

  /**
   * Route routine error message.
   */
  showError(
    message: string,
    filePath?: string,
    resultTargetUri?: string,
    sourceOperationId?: string,
    actionCommand?: { command: string; title: string; args?: unknown[] }
  ): void {
    const surface = checkInitialized();
    surface.addEntry(message, "error", filePath, resultTargetUri, sourceOperationId, actionCommand);
  },

  /**
   * Route concise status summary (e.g. from progress notifications).
   *
   * `sourceOperationId` should be the LIVE root taskOperations id (e.g. from
   * `taskOperations.rootOperationIdFor(taskPath)`), passed at call time while
   * the operation is still running. Unlike the terminal bridge (which stamps
   * an id only after the operation has already ended), this lets the
   * in-progress Notifications row resolve to a currently-live, cancellable
   * root operation and expose a working cancel action while work is still
   * underway.
   */
  emitProgressSummary(message: string, sourceOperationId?: string): void {
    const surface = checkInitialized();
    surface.addEntry(message, "info", undefined, undefined, sourceOperationId);
  }
};
