export interface StatusSurface {
  addEntry(message: string, level: "info" | "warning" | "error", filePath?: string): void;
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
  showInformation(message: string, filePath?: string): void {
    const surface = checkInitialized();
    surface.addEntry(message, "info", filePath);
  },

  /**
   * Route routine warning message.
   * NOTE: Routine warning notices must never raise an OS toast (desktop notification).
   */
  showWarning(message: string, filePath?: string): void {
    const surface = checkInitialized();
    surface.addEntry(message, "warning", filePath);
  },

  /**
   * Route routine error message.
   */
  showError(message: string, filePath?: string): void {
    const surface = checkInitialized();
    surface.addEntry(message, "error", filePath);
  },

  /**
   * Route concise status summary (e.g. from progress notifications).
   */
  emitProgressSummary(message: string): void {
    const surface = checkInitialized();
    surface.addEntry(message, "info");
  }
};
