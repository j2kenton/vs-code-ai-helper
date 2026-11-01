/**
 * bugs4 item 8: a short-lived record of the task-artifact bytes the extension
 * itself wrote (pin, unpin, rename, archive, the watchdog, Tasks-pane edits all
 * persist through `writeAtomic`). Foreign-folder containment compares a changed
 * file's hash against this record: a file whose current bytes are exactly what
 * the extension last wrote is the extension's own update, never a round's
 * misplaced artifact, whether the target task is active or paused.
 *
 * Pure and VS-Code-free so both `writeAtomic` and containment can import it.
 * Bounded in age and size: an entry that outlives its window simply stops
 * excusing the file, which then falls back to content attribution.
 */
import * as crypto from "crypto";
import * as path from "path";

/** Long enough to cover a long round plus its terminalization; short enough to be a window, not a ledger. */
export const EXTENSION_WRITE_WINDOW_MS_V1 = 2 * 60 * 60 * 1000;
const MAX_ENTRIES_V1 = 500;

interface ExtensionWriteEntryV1 {
  readonly sha256: string;
  readonly at: number;
}

const writes = new Map<string, ExtensionWriteEntryV1[]>();

function keyOf(absolutePath: string): string {
  return path.resolve(absolutePath).replace(/\\/g, "/");
}

function sha256Of(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function prune(now: number): void {
  for (const [key, entries] of writes) {
    const live = entries.filter((entry) => now - entry.at <= EXTENSION_WRITE_WINDOW_MS_V1);
    if (live.length === 0) {
      writes.delete(key);
    } else if (live.length !== entries.length) {
      writes.set(key, live);
    }
  }
  while (writes.size > MAX_ENTRIES_V1) {
    const oldest = writes.keys().next();
    if (oldest.done) break;
    writes.delete(oldest.value);
  }
}

/** Record that the extension just wrote `content` to `absolutePath`. */
export function recordExtensionTaskArtifactWriteV1(
  absolutePath: string,
  content: string | Buffer,
  now: number = Date.now()
): void {
  prune(now);
  const key = keyOf(absolutePath);
  const entries = writes.get(key) ?? [];
  entries.push({ sha256: sha256Of(content), at: now });
  // A file is only ever compared against its few most recent extension writes.
  writes.set(key, entries.slice(-4));
}

/**
 * True when `sha256` is the hash of bytes the extension wrote to
 * `absolutePath` within the window ending at `now` (both edges inclusive).
 */
export function wasExtensionTaskArtifactWriteV1(
  absolutePath: string,
  sha256: string,
  now: number = Date.now()
): boolean {
  const entries = writes.get(keyOf(absolutePath));
  return entries?.some((entry) => entry.sha256 === sha256 && now - entry.at <= EXTENSION_WRITE_WINDOW_MS_V1) === true;
}

/** Test seam: forget every recorded write. */
export function resetExtensionTaskArtifactWritesV1(): void {
  writes.clear();
}
