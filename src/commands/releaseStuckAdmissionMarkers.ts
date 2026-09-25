import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { NotificationRouter } from "../utils/notificationRouter";

/**
 * Scan the active workspace folder for stale work-admission markers
 * (last renewed >20 minutes ago) and offer to delete them, clearing
 * blocks to task operations after a crashed or hung fast-forward loop.
 *
 * This command provides a manual escape hatch; the admission system itself
 * never auto-reclaims markers per its v1a policy (conservative to avoid
 * guessing whether a slow process is actually dead).
 */
export async function releaseStuckAdmissionMarkers(): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceRoot) {
    NotificationRouter.showWarning("No workspace folder open.");
    return;
  }

  const admissionDir = path.join(
    workspaceRoot.uri.fsPath,
    ".ensemble",
    "admission-v1"
  );

  if (!fs.existsSync(admissionDir)) {
    NotificationRouter.showInformation(
      "No admission markers found in this workspace."
    );
    return;
  }

  const files = fs.readdirSync(admissionDir);
  if (files.length === 0) {
    NotificationRouter.showInformation(
      "No admission markers found in this workspace."
    );
    return;
  }

  const staleMarkers: Array<{ name: string; mtime: number }> = [];
  const likelyStaleThresholdMs = 20 * 60 * 1000; // 20 minutes
  const now = Date.now();

  for (const file of files) {
    const filePath = path.join(admissionDir, file);
    const stat = fs.statSync(filePath);
    const ageMs = now - stat.mtime.getTime();

    // Only list markers last renewed >20 minutes ago
    if (ageMs > likelyStaleThresholdMs) {
      staleMarkers.push({ name: file, mtime: stat.mtime.getTime() });
    }
  }

  if (staleMarkers.length === 0) {
    NotificationRouter.showInformation(
      `No stale admission markers found. All markers were renewed within the last 20 minutes.`
    );
    return;
  }

  // Sort by age, oldest first
  staleMarkers.sort((a, b) => a.mtime - b.mtime);

  const markerList = staleMarkers
    .map((m) => `  - ${m.name} (${Math.round((now - m.mtime) / 60000)} min old)`)
    .join("\n");

  const choice = await vscode.window.showWarningMessage(
    `Found ${staleMarkers.length} stale admission marker(s) (last renewed >20 min ago).\n\n${markerList}\n\nDelete them to unblock stuck task operations?`,
    "Delete All",
    "Cancel"
  );

  if (choice !== "Delete All") {
    return;
  }

  let deleted = 0;
  let failed = 0;

  for (const marker of staleMarkers) {
    const markerPath = path.join(admissionDir, marker.name);
    try {
      fs.unlinkSync(markerPath);
      deleted++;
    } catch (err) {
      console.error(`Failed to delete ${markerPath}:`, err);
      failed++;
    }
  }

  NotificationRouter.showInformation(
    `Deleted ${deleted} stale marker(s).${failed > 0 ? ` (${failed} failed to delete)` : ""}`
  );
}
