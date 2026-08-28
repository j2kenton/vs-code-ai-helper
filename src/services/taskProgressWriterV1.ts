/**
 * Strict task-progress writer and splice-based migrator (plan §3.10).
 *
 * The writer is the only V1 emitter of `task-progress.json`. It re-encodes
 * product-owned fields canonically (2-space indent, declaration semantics)
 * while splicing opaque non-product properties back in BYTE-IDENTICALLY and
 * in their original order, exactly as the strict decoder captured them.
 * `ensembleProgressVersion` is always emitted first, so a migrated file is
 * unambiguously V1 input on the next read.
 *
 * Like the decoder, this module is fenced from the permissive legacy
 * reader/writer: it never imports from `utils/taskProgressUtils`.
 */
import * as vscode from "vscode";
import * as path from "path";
import { TASK_PROGRESS_FILENAME, TaskProgress, TaskStage } from "../types/taskProgress";
import { writeAtomic } from "../state/writeAtomic";
import { withTaskLock } from "../state/taskStateStore";
import { beginFinalization, finishFinalization } from "../state/finalizationJournal";
import {
  DecodeTaskProgressOptionsV1,
  DecodedTaskProgressV1,
  ENSEMBLE_PROGRESS_VERSION_FIELD_V1,
  PersistedTaskProgressV1,
  TASK_PROGRESS_PRODUCT_FIELD_NAMES_V1,
  TaskProgressDocumentEntryV1,
  TaskProgressRecoveryCodeV1,
  decodeTaskProgressTextV1,
} from "./taskProgressDecoderV1";

/** Serialize one product value at top-level property depth (2-space document indent). */
function serializeProductValue(value: unknown): string {
  return JSON.stringify(value, null, 2).split("\n").join("\n  ");
}

/**
 * Encode a strict V1 progress document. When `entries` (the decoder's
 * ordered document model) is provided, original property order is preserved:
 * product fields are re-encoded canonically in place, opaque fields are
 * emitted from their exact raw spans, cleared product fields (now
 * `undefined`) are omitted, and newly set product fields are appended in
 * declaration order. Without `entries` (a fresh write), product fields are
 * emitted in declaration order.
 */
export function encodeTaskProgressV1(
  progress: PersistedTaskProgressV1,
  entries?: readonly TaskProgressDocumentEntryV1[]
): string {
  const lines: string[] = [];
  lines.push(`  ${JSON.stringify(ENSEMBLE_PROGRESS_VERSION_FIELD_V1)}: 1`);

  const emitted = new Set<keyof TaskProgress>();
  const emitProduct = (name: keyof TaskProgress): void => {
    const value = progress[name];
    if (value === undefined) {
      return;
    }
    lines.push(`  ${JSON.stringify(name)}: ${serializeProductValue(value)}`);
    emitted.add(name);
  };

  if (entries !== undefined) {
    for (const entry of entries) {
      if (entry.kind === "product") {
        emitProduct(entry.name);
      } else {
        lines.push(`  ${entry.entry.rawKey}: ${entry.entry.rawValue}`);
      }
    }
  }
  for (const name of TASK_PROGRESS_PRODUCT_FIELD_NAMES_V1) {
    if (!emitted.has(name)) {
      emitProduct(name);
    }
  }

  return `{\n${lines.join(",\n")}\n}`;
}

export type TaskProgressMigrationResultV1 =
  | {
      readonly ok: true;
      readonly text: string;
      readonly decoded: DecodedTaskProgressV1;
      /** False when the input was already canonical V1 output. */
      readonly changed: boolean;
    }
  | {
      readonly ok: false;
      readonly code: TaskProgressRecoveryCodeV1;
      readonly reason: string;
    };

/**
 * The splice-based migration path: strictly decode a supported document and
 * re-emit it as canonical V1 text. Product fields are canonicalized (stage
 * aliases resolved, absent status materialized, `ensembleProgressVersion: 1`
 * added, historical envelopes flattened); opaque properties pass through
 * byte-identically and in order. Unsupported input returns the decoder's
 * recovery result unchanged — migration never coerces.
 */
export function migrateTaskProgressTextV1(
  text: string,
  options?: DecodeTaskProgressOptionsV1
): TaskProgressMigrationResultV1 {
  const result = decodeTaskProgressTextV1(text, options);
  if (!result.ok) {
    return result;
  }
  const migrated = encodeTaskProgressV1(result.decoded.progress, result.decoded.entries);
  return {
    ok: true,
    text: migrated,
    decoded: result.decoded,
    changed: migrated !== text,
  };
}

/**
 * Persist a strict V1 progress document atomically. Callers pass the
 * decoder's document model so opaque properties survive; a fresh creation
 * write omits it.
 */
export async function writeTaskProgressV1(
  taskFolderUri: vscode.Uri,
  progress: PersistedTaskProgressV1,
  entries?: readonly TaskProgressDocumentEntryV1[]
): Promise<void> {
  const progressFileUri = vscode.Uri.joinPath(taskFolderUri, TASK_PROGRESS_FILENAME);
  await writeAtomic(progressFileUri, encodeTaskProgressV1(progress, entries));
}

/** Options for `patchTaskProgressStrictV1` — mirrors the legacy `patchTaskProgress` knobs. */
export interface PatchTaskProgressStrictOptionsV1 {
  /**
   * Skip acquiring the per-task lock: the caller already holds an equivalent
   * or covering lock (e.g. task activation holding the shared meta-root
   * lock). `withTaskLock` queues on the same per-process key regardless of
   * which lock file backs it, so re-acquiring under a held covering lock
   * would self-deadlock — exactly the legacy `patchTaskProgress` `skipLock`
   * contract.
   */
  readonly skipLock?: boolean;
  /**
   * Side effect run after `update` has validated/computed the patched value
   * but before it is persisted, still inside the same lease as `update`'s
   * own CAS checks. Use this to publish a file artifact (e.g. rename a
   * staged review into place) atomically with the progress write, so a
   * superseded caller's `update` throwing prevents both the write AND the
   * side effect. Runs even when the patch turns out to be a byte-identical
   * no-op — a validated no-op CAS may still have a side effect (same-stage
   * review refreshes publish their staged artifact this way).
   */
  readonly beforeWrite?: (patched: TaskProgress) => Promise<void>;
}

/**
 * Read the raw bytes of `task-progress.json`, undecoded — `undefined` when
 * the file cannot be read (missing, or any other I/O failure). Exists so
 * `patchTaskProgressStrictV1`'s out-of-band guard (below) can detect that the
 * file changed underneath it by comparing exact bytes, independent of the
 * decoder and of this writer's own canonical formatting — a write from
 * outside this module (a raw external edit) need not match this module's
 * encoding to be detected.
 */
async function readProgressFileRawTextV1(progressFileUri: vscode.Uri): Promise<string | undefined> {
  try {
    const content = await vscode.workspace.fs.readFile(progressFileUri);
    return new TextDecoder().decode(content);
  } catch {
    return undefined;
  }
}

/** Bound on how many times a single `patchTaskProgressStrictV1` call re-reads
 * and recomputes `update` after detecting an out-of-band write — see the
 * function's own doc comment. Small and finite: each retry costs one extra
 * read, and a caller racing this many genuinely concurrent out-of-band writes
 * has a problem this guard cannot fix by looping further; the final attempt
 * proceeds to write against whatever was last read, exactly as this function
 * always did before this guard existed. */
const MAX_OUT_OF_BAND_WRITE_RETRIES_V1 = 5;

/**
  * Read-modify-write progress mutation using strict decoding and encoding (plan §3.10 / §3.12).
  *
  * Runs under the same per-task-folder lock (`withTaskLock`) the legacy
  * `patchTaskProgress` (`src/utils/taskProgressUtils.ts`) acquires, keyed
  * identically by `taskFolderUri.fsPath`. Without this, a V1 read-modify-write
  * here and a legacy transition running concurrently (e.g. a manual "Complete
  * Stage & Move On" racing an auto-advance) could interleave and silently
  * clobber or double-apply a transition — the lock makes the two paths
  * mutually exclusive on one task, exactly like two legacy callers today.
  *
  * Write-side parity with the legacy patch (which lifecycle recovery and the
  * file watcher depend on):
  *  - the write is journaled via `beginFinalization`/`finishFinalization`, so
  *    startup recovery can reconcile an interrupted mutation;
  *  - a byte-identical patch (canonical encoding unchanged) performs NO write
  *    — callers use an unchanged return value to decline a compare-and-swap
  *    update, and task-progress.json is watched, so no-op writes would
  *    re-trigger inventory refreshes and scheduler loops forever.
  *
  * Out-of-band write guard (2026-08-28 review fix, PARTIAL progress toward
  * the architectural blocker "coordinator allocation sites still do not
  * attach operation and attempt identities to a round-ledger row at
  * allocation time" — see the caveat at the end of this comment):
  * `withTaskLock` only serializes writers that go THROUGH this function — it
  * cannot help against a write that lands on disk by some other route
  * entirely (a raw external edit; `publishOwnershipMatrix.test.ts`'s "paused
  * while the review was running" case simulates exactly this with a direct
  * `fs.writeFileSync` mid-round). Earlier attempts to attach round-ledger
  * identity directly at allocation time were reverted because a
  * fire-and-forget call into this function, started early, could read
  * `current` BEFORE such an out-of-band write and still not finish writing
  * until AFTER it — silently reverting the out-of-band write with stale data
  * (see the round-ledger allocation hooks for the full history). This
  * was the missing half of the compare-and-swap: `progressVersion` already
  * detects two *lock-respecting* callers racing each other, but nothing
  * previously re-checked the raw file against what was actually read once a
  * caller had already committed to writing. Immediately before committing
  * (skipped when `beforeWrite` is supplied — its own side effect must never
  * fire more than once per call, so a caller that needs one keeps today's
  * single-read behavior and remains responsible for its own external
  * synchronization, as before this guard), the raw bytes are re-read and
  * compared byte-for-byte against what `current` was decoded from; a mismatch
  * means something else wrote to this file since, so `update` is re-run
  * against the fresh read rather than clobbering it — the same
  * read-recompute-retry shape as any optimistic concurrency control, bounded
  * by `MAX_OUT_OF_BAND_WRITE_RETRIES_V1` so a pathologically busy writer
  * cannot loop this call forever.
  *
  * CAVEAT — this guard alone does NOT close the architectural blocker above.
  * It is verified in isolation (a deterministic reproduction of the exact
  * race lives in `taskProgressWriterV1.test.ts`, and the full suite —
  * including `publishOwnershipMatrix.test.ts`'s original regression case —
  * passes with it in place). But re-wiring the allocation-time attachment
  * onto `onAttemptAllocated` (the change this guard was meant to make safe)
  * was tried a third time on the strength of this guard and reproduced that
  * same regression test's failure again by a different path — the extra
  * queued `patchTaskProgressStrictV1` call this hook adds interacts with the
  * NEXT_STAGE action's own pause-aware commit (dispatched through the same
  * shared driver) in a way not yet root-caused. See `runEditActionV1.ts`'s
  * matching NOTE for the full account. This guard is kept because it is a
  * real, independently verified improvement (the specific stale-read-clobber
  * hazard it targets cannot recur through this function), not because it
  * completes the allocation-time attach — that remains open.
  */
export async function patchTaskProgressStrictV1(
  taskFolderUri: vscode.Uri,
  update: (current: PersistedTaskProgressV1) => TaskProgress | undefined,
  options?: PatchTaskProgressStrictOptionsV1
): Promise<TaskProgress | undefined> {
  const progressFileUri = vscode.Uri.joinPath(taskFolderUri, TASK_PROGRESS_FILENAME);
  const operation = async (): Promise<TaskProgress | undefined> => {
    const folderName = path.basename(taskFolderUri.fsPath);
    for (let attempt = 0; ; attempt++) {
      const rawText = await readProgressFileRawTextV1(progressFileUri);
      if (rawText === undefined) {
        return undefined;
      }
      const decodeResult = decodeTaskProgressTextV1(rawText, { expectedTaskFolder: folderName });
      if (!decodeResult.ok) {
        return undefined;
      }
      const current = decodeResult.decoded.progress;
      const patched = update(current);
      if (!patched) {
        return current;
      }
      // `update` already threw for a stale/rejected CAS, so reaching here means
      // this caller owns the transition. The side effect runs before the
      // no-op check on purpose — see `PatchTaskProgressStrictOptionsV1.beforeWrite`.
      if (options?.beforeWrite) {
        await options.beforeWrite(patched);
      }
      // `progressVersion` (wf10 item 8) is incremented HERE and nowhere else —
      // no caller's own comparison can race the bump, because no caller ever
      // sets this field itself. Determine whether the patch is a real change
      // with the token held at its CURRENT value on both sides first, so the
      // token itself can never be what makes an otherwise byte-identical patch
      // look like a change.
      const currentEncoded = encodeTaskProgressV1(current, decodeResult.decoded.entries);
      const unversionedEncoded = encodeTaskProgressV1(
        { ...patched, ensembleProgressVersion: 1, progressVersion: current.progressVersion },
        decodeResult.decoded.entries
      );
      if (unversionedEncoded === currentEncoded) {
        return current;
      }
      if (!options?.beforeWrite && attempt < MAX_OUT_OF_BAND_WRITE_RETRIES_V1) {
        const rawTextNow = await readProgressFileRawTextV1(progressFileUri);
        if (rawTextNow !== rawText) {
          continue;
        }
      }
      const versioned: TaskProgress = {
        ...patched,
        progressVersion: (current.progressVersion ?? 0) + 1,
      };
      const encoded = encodeTaskProgressV1({ ...versioned, ensembleProgressVersion: 1 }, decodeResult.decoded.entries);
      await beginFinalization(taskFolderUri.fsPath, taskFolderUri.fsPath, "task-progress mutation");
      // Keep the intent journal on failure. Startup recovery needs the record
      // to reconcile an interrupted mutation instead of losing the evidence.
      await writeAtomic(progressFileUri, encoded);
      await finishFinalization(taskFolderUri.fsPath);
      return versioned;
    }
  };
  return options?.skipLock ? operation() : withTaskLock(taskFolderUri.fsPath, operation);
}

/**
 * Fresh strict creation progress (plan §3.10): the V1 counterpart of the
 * legacy `createTaskProgress`, emitting `ensembleProgressVersion: 1` from
 * birth so the file is unambiguously V1 input on its first read. Status
 * starts as `"creating"` — the durable creation sentinel — exactly like the
 * legacy creator.
 */
export function createTaskProgressV1(
  taskFolder: string,
  stage: TaskStage = "desc"
): PersistedTaskProgressV1 {
  const now = new Date().toISOString();
  return {
    ensembleProgressVersion: 1,
    taskFolder,
    currentStage: stage,
    status: "creating",
    createdAt: now,
    updatedAt: now,
  };
}
