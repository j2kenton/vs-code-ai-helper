import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { NotificationRouter } from "../utils/notificationRouter";

export const RELEASE_STUCK_ADMISSION_STALE_MS_V1 = 20 * 60 * 1000;

const MARKER_RE_V1 = /^admission\.([0-9a-z-]+)\.g(\d+)\.([0-9a-z]+)$/;
const SKIP_DIRS_V1 = new Set([".git", "node_modules", "out", "out-test", "dist"]);

export interface StaleAdmissionMarkerCandidateV1 {
  readonly filePath: string;
  readonly basename: string;
  readonly admissionDirPath: string;
  readonly workspaceRelativePath: string;
  readonly mtimeMs: number;
}

export function isAdmissionMarkerBasenameForReleaseV1(basename: string): boolean {
  return MARKER_RE_V1.test(basename);
}

function isStaleAdmissionMarkerFileV1(
  filePath: string,
  nowMs: number,
  staleThresholdMs: number
): { readonly ok: true; readonly mtimeMs: number } | { readonly ok: false } {
  if (!isAdmissionMarkerBasenameForReleaseV1(path.basename(filePath))) {
    return { ok: false };
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    return { ok: false };
  }
  if (!stat.isFile()) {
    return { ok: false };
  }
  if (nowMs - stat.mtime.getTime() <= staleThresholdMs) {
    return { ok: false };
  }
  return { ok: true, mtimeMs: stat.mtime.getTime() };
}

function collectAdmissionDirsV1(rootPath: string): string[] {
  const dirs: string[] = [];
  const stack = [rootPath];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    if (path.basename(current) === "admission-v1") {
      dirs.push(current);
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS_V1.has(entry.name)) {
        continue;
      }
      stack.push(path.join(current, entry.name));
    }
  }

  return dirs;
}

export function findStaleAdmissionMarkersForReleaseV1(
  workspaceRootPath: string,
  nowMs: number = Date.now(),
  staleThresholdMs: number = RELEASE_STUCK_ADMISSION_STALE_MS_V1
): StaleAdmissionMarkerCandidateV1[] {
  const candidates: StaleAdmissionMarkerCandidateV1[] = [];
  for (const admissionDirPath of collectAdmissionDirsV1(workspaceRootPath)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(admissionDirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !isAdmissionMarkerBasenameForReleaseV1(entry.name)) {
        continue;
      }
      const filePath = path.join(admissionDirPath, entry.name);
      const stale = isStaleAdmissionMarkerFileV1(filePath, nowMs, staleThresholdMs);
      if (stale.ok) {
        candidates.push({
          filePath,
          basename: entry.name,
          admissionDirPath,
          workspaceRelativePath: path.relative(workspaceRootPath, filePath),
          mtimeMs: stale.mtimeMs,
        });
      }
    }
  }
  return candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

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

  const now = Date.now();
  const staleMarkers = findStaleAdmissionMarkersForReleaseV1(workspaceRoot.uri.fsPath, now);

  if (staleMarkers.length === 0) {
    NotificationRouter.showInformation(
      "No stale admission markers found. All valid admission markers were renewed within the last 20 minutes."
    );
    return;
  }

  const markerList = staleMarkers
    .map((m) => `  - ${m.workspaceRelativePath} (${Math.round((now - m.mtimeMs) / 60000)} min old)`)
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
  let skippedFresh = 0;
  const failed: string[] = [];

  for (const marker of staleMarkers) {
    const current = isStaleAdmissionMarkerFileV1(
      marker.filePath,
      Date.now(),
      RELEASE_STUCK_ADMISSION_STALE_MS_V1
    );
    if (!current.ok) {
      skippedFresh++;
      continue;
    }
    try {
      fs.unlinkSync(marker.filePath);
      deleted++;
    } catch (err) {
      console.error(`Failed to delete ${marker.filePath}:`, err);
      failed.push(marker.workspaceRelativePath);
    }
  }

  const skippedText = skippedFresh > 0 ? ` Skipped ${skippedFresh} marker(s) that were refreshed before deletion.` : "";
  if (failed.length > 0) {
    NotificationRouter.showError(
      `Deleted ${deleted} stale marker(s).${skippedText} Failed to delete: ${failed.join(", ")}`
    );
    return;
  }
  NotificationRouter.showInformation(`Deleted ${deleted} stale marker(s).${skippedText}`);
}
