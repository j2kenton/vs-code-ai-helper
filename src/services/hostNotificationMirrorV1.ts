import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * The runner's Notifications, shown in every viewer window (hostRoleV1.ts).
 *
 * Everything the runner reports — a refusal, a round's outcome, a stage
 * completing — goes to ITS Notifications view, on a screen nobody watches.
 * A viewer's forwarded action looked like it silently did nothing: the
 * runner had refused it with a clear reason only the runner could see
 * (seen live 2026-09-17, "a prior implementation round was rejected…").
 *
 * The runner appends each entry, one JSON object per line, to
 * `<relay dir>/notifications-v1.jsonl`; a viewer follows the file from the
 * offset it opened it at and adds new entries to its own Notifications view.
 * VS Code-free, so it is unit-testable; extension.ts wires both ends.
 */

export const HOST_NOTIFICATION_MIRROR_FILENAME_V1 = "notifications-v1.jsonl";
/** Past this size the runner starts a fresh file (a viewer notices the shrink and restarts at 0). */
const MAX_MIRROR_BYTES_V1 = 1024 * 1024;

export interface MirroredNotificationV1 {
  readonly at: string;
  readonly level: "info" | "warning" | "error";
  readonly message: string;
  readonly filePath?: string;
  readonly resultTargetUri?: string;
  readonly actionCommand?: { readonly command: string; readonly title: string; readonly args?: readonly unknown[] };
}

/** Runner side: append one entry. Never throws — a lost mirror line must not break the runner's own reporting. */
export async function appendMirroredNotificationV1(dir: string, entry: MirroredNotificationV1): Promise<void> {
  const file = path.join(dir, HOST_NOTIFICATION_MIRROR_FILENAME_V1);
  try {
    await fs.mkdir(dir, { recursive: true });
    try {
      const stat = await fs.stat(file);
      if (stat.size > MAX_MIRROR_BYTES_V1) {
        await fs.rename(file, `${file}.1`);
      }
    } catch {
      // No file yet.
    }
    await fs.appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Best effort.
  }
}

function isMirroredNotification(value: unknown): value is MirroredNotificationV1 {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.message === "string" &&
    (record.level === "info" || record.level === "warning" || record.level === "error")
  );
}

export interface NotificationMirrorTailV1 {
  /** Read whatever was appended since the last poll and hand the new entries over. */
  poll(): Promise<void>;
}

/**
 * Viewer side. Starts at the file's CURRENT end: a viewer that opens later
 * shows what happens from then on, not the runner's whole history.
 */
export async function createNotificationMirrorTailV1(
  dir: string,
  onEntries: (entries: readonly MirroredNotificationV1[]) => void
): Promise<NotificationMirrorTailV1> {
  const file = path.join(dir, HOST_NOTIFICATION_MIRROR_FILENAME_V1);
  let offset = 0;
  try {
    offset = (await fs.stat(file)).size;
  } catch {
    offset = 0;
  }
  let partial = "";
  let polling: Promise<void> | undefined;

  async function readNew(): Promise<void> {
    let size: number;
    try {
      size = (await fs.stat(file)).size;
    } catch {
      return;
    }
    if (size < offset) {
      // The runner rotated the file: everything in the new one is unseen.
      offset = 0;
      partial = "";
    }
    if (size === offset) {
      return;
    }
    const handle = await fs.open(file, "r");
    try {
      const length = size - offset;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);
      offset = size;
      const text = partial + buffer.toString("utf8");
      const lines = text.split("\n");
      // The last piece is a line still being written (or empty after a final newline).
      partial = lines.pop() ?? "";
      const entries: MirroredNotificationV1[] = [];
      for (const line of lines) {
        if (line.trim().length === 0) {
          continue;
        }
        try {
          const parsed: unknown = JSON.parse(line);
          if (isMirroredNotification(parsed)) {
            entries.push(parsed);
          }
        } catch {
          // A malformed line is skipped, never fatal.
        }
      }
      if (entries.length > 0) {
        onEntries(entries);
      }
    } finally {
      await handle.close();
    }
  }

  return {
    poll(): Promise<void> {
      // Serialized: the watcher and the timer can both ask at once.
      polling = (polling ?? Promise.resolve()).then(readNew).catch(() => undefined);
      return polling;
    },
  };
}
