import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * One writer for every runner→viewer mirror file (hostOperationsMirrorV1.ts,
 * hostDecisionMirrorV1.ts).
 *
 * Two properties the mirrors need and a bare `writeFile`+`rename` does not
 * give them (review, 2026-09-17):
 *
 * 1. **Order.** Both mirrors are written from debounced/event handlers, so two
 *    writes can be in flight at once. Their renames can land in either order,
 *    and the LOSER is the one the viewer keeps: a decision resolved the
 *    instant after it was raised could be republished as pending forever.
 *    Writes are therefore serialized per file, and a write superseded while
 *    it was still queued is dropped rather than published late.
 * 2. **Failure.** The caller must be able to tell a published snapshot from a
 *    failed one, so a heartbeat can retry instead of caching a signature for
 *    state that never reached disk.
 */

const queues = new Map<string, Promise<void>>();
/** Bumped per file on every enqueue; a queued write with a stale ticket is skipped. */
const latest = new Map<string, number>();

/**
 * Write `data` as JSON to `dir/filename`, atomically (temp + rename) and in
 * order with every other write to the same file. Resolves true when this
 * snapshot reached disk, false when it failed or was superseded before its
 * turn (in which case a newer snapshot is being written instead).
 */
export async function writeMirrorSnapshotV1(dir: string, filename: string, data: unknown): Promise<boolean> {
  const file = path.join(dir, filename);
  const ticket = (latest.get(file) ?? 0) + 1;
  latest.set(file, ticket);
  const previous = queues.get(file) ?? Promise.resolve();
  const run = previous.then(async (): Promise<boolean> => {
    if (latest.get(file) !== ticket) {
      return false; // A newer snapshot was queued while this one waited.
    }
    const temp = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(temp, JSON.stringify(data), "utf8");
      await fs.rename(temp, file);
      return true;
    } catch {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      return false;
    }
  });
  // The chain must never reject and must not keep the last result alive.
  queues.set(file, run.then(() => undefined, () => undefined));
  return run;
}
