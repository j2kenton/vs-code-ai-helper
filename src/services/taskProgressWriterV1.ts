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
 * reader/writer (scripts/verifyProgressReaderFence.mjs).
 */
import * as vscode from "vscode";
import * as path from "path";
import { TASK_PROGRESS_FILENAME, TaskProgress } from "../types/taskProgress";
import { writeAtomic } from "../state/writeAtomic";
import { withTaskLock } from "../state/taskStateStore";
import { readTaskProgressStrictV1 } from "./taskProgressReaderV1";
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
  */
export async function patchTaskProgressStrictV1(
  taskFolderUri: vscode.Uri,
  update: (current: PersistedTaskProgressV1) => TaskProgress | undefined
): Promise<TaskProgress | undefined> {
  return withTaskLock(taskFolderUri.fsPath, async () => {
    const folderName = path.basename(taskFolderUri.fsPath);
    const strict = await readTaskProgressStrictV1(taskFolderUri, { expectedTaskFolder: folderName });
    if (!strict.ok) {
      return undefined;
    }
    const current = strict.decoded.progress;
    const patched = update(current);
    if (!patched) {
      return current;
    }
    await writeTaskProgressV1(taskFolderUri, { ...patched, ensembleProgressVersion: 1 }, strict.decoded.entries);
    return patched;
  });
}
