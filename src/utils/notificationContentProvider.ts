import * as vscode from "vscode";

/**
 * Scheme for the read-only fallback document shown when a Notifications-row
 * click has no known result artifact/run log to open (no `filePath`, no
 * `resultTargetUri`). The full notification text is embedded directly in the
 * URI (as its query string) rather than looked up from a side table, so the
 * document opens correctly even for a notification restored from persisted
 * state after a reload.
 */
export const ENSEMBLE_NOTIFICATION_SCHEME = "ensemble-notification";

/**
 * Build the fallback URI for a notification with no click-to-open target.
 * `vscode.open`-ing this URI shows a read-only virtual document with the
 * notification's full, untruncated text.
 */
export function notificationFallbackUri(
  message: string,
  level: "info" | "warning" | "error",
  timestamp: Date
): vscode.Uri {
  const content = `[${level.toUpperCase()}] ${timestamp.toLocaleString()}\n\n${message}`;
  return vscode.Uri.from({
    scheme: ENSEMBLE_NOTIFICATION_SCHEME,
    path: "/Notification.txt",
    query: encodeURIComponent(content),
  });
}

/**
 * Provides the read-only document body for `ensemble-notification:` URIs
 * built by `notificationFallbackUri`. Registered once at activation and
 * added to `context.subscriptions` (see extension.ts).
 */
export class NotificationContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    try {
      return decodeURIComponent(uri.query);
    } catch {
      return uri.query;
    }
  }
}
