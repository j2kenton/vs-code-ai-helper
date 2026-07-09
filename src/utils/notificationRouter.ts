export interface StatusSurface {
  addEntry(message: string, level: "info" | "warning" | "error"): void;
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
   */
  showInformation(message: string): void {
    const surface = checkInitialized();
    surface.addEntry(message, "info");
  },

  /**
   * Route routine warning message.
   */
  showWarning(message: string): void {
    const surface = checkInitialized();
    surface.addEntry(message, "warning");
  },

  /**
   * Route routine error message.
   */
  showError(message: string): void {
    const surface = checkInitialized();
    surface.addEntry(message, "error");
  },

  /**
   * Route concise status summary (e.g. from progress notifications).
   */
  emitProgressSummary(message: string): void {
    const surface = checkInitialized();
    surface.addEntry(message, "info");
  }
};
