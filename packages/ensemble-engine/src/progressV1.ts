/**
 * Engine task-progress journal (plan Part 4a).
 *
 * The engine maintains each task's progress as a strict `ensemble-v1`
 * persisted document — the SAME on-disk vocabulary the extension writes
 * (`ensembleProgressVersion: 1` plus the closed product-field roster).
 * `encodeTaskProgressTextV1` is a port of the extension writer's fresh-write
 * encoding (`src/services/taskProgressWriterV1.ts`): the version marker
 * first, product fields in declaration order, 2-space document indent. Every
 * mutation re-encodes and strictly re-decodes through the @ensemble/core
 * decoder BEFORE the new state becomes visible or is emitted, so an emitted
 * progress frame that the extension's own decoder would reject cannot exist
 * — the engine trace suite then re-decodes every emitted frame with
 * `src/services/taskProgressDecoderV1.ts` directly as the parity oracle.
 */
import {
  decodeTaskProgressTextV1,
  ENSEMBLE_PROGRESS_VERSION_FIELD_V1,
  PersistedTaskProgressV1,
  TASK_PROGRESS_PRODUCT_FIELD_NAMES_V1,
} from "../../ensemble-core/src/taskProgressDecoderV1";
import { TaskProgress, TaskStage } from "../../ensemble-core/src/taskProgressV1";

/** Serialize one product value at top-level property depth (2-space indent). */
function serializeProductValue(value: unknown): string {
  return JSON.stringify(value, null, 2).split("\n").join("\n  ");
}

/**
 * Encode a strict V1 progress document (fresh-write form: product fields in
 * declaration order, `ensembleProgressVersion` first).
 */
export function encodeTaskProgressTextV1(progress: PersistedTaskProgressV1): string {
  const lines: string[] = [];
  lines.push(`  ${JSON.stringify(ENSEMBLE_PROGRESS_VERSION_FIELD_V1)}: 1`);
  for (const name of TASK_PROGRESS_PRODUCT_FIELD_NAMES_V1) {
    const value = progress[name];
    if (value === undefined) {
      continue;
    }
    lines.push(`  ${JSON.stringify(name)}: ${serializeProductValue(value)}`);
  }
  return `{\n${lines.join(",\n")}\n}`;
}

/**
 * Fresh creation progress: `ensembleProgressVersion: 1` from birth, status
 * `"creating"` as the durable creation sentinel — exactly like the
 * extension's `createTaskProgressV1`, with an injected clock.
 */
export function createTaskProgressV1(
  taskFolder: string,
  now: () => Date,
  stage: TaskStage = "desc"
): PersistedTaskProgressV1 {
  const at = now().toISOString();
  return {
    ensembleProgressVersion: 1,
    taskFolder,
    currentStage: stage,
    status: "creating",
    createdAt: at,
    updatedAt: at,
  };
}

export class TaskProgressJournalErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskProgressJournalErrorV1";
  }
}

/**
 * Holds one task's authoritative progress document. Every `patch` re-encodes
 * the updated document and strictly re-decodes it (fail-closed) before the
 * new state becomes current — a state the strict decoder rejects is an
 * engine bug surfaced immediately, never an emitted frame.
 */
export interface TaskProgressJournalV1 {
  /** The current, strictly-decoded progress document. */
  readonly current: PersistedTaskProgressV1;
  /** The canonical persisted text of the current document. */
  encodedText(): string;
  /**
   * Apply a mutation. `updatedAt` is stamped from the journal clock. Returns
   * the new decoded progress; throws `TaskProgressJournalErrorV1` when the
   * patched document does not survive the strict decode.
   */
  patch(update: (current: PersistedTaskProgressV1) => TaskProgress): PersistedTaskProgressV1;
}

export function createTaskProgressJournalV1(options: {
  readonly taskFolder: string;
  readonly now: () => Date;
  readonly initialStage?: TaskStage;
}): TaskProgressJournalV1 {
  let current = createTaskProgressV1(options.taskFolder, options.now, options.initialStage);

  // Self-verify the birth document too: a journal that cannot round-trip its
  // own creation state must not exist.
  verify(encodeTaskProgressTextV1(current), options.taskFolder);

  function verify(text: string, expectedTaskFolder: string): PersistedTaskProgressV1 {
    const decoded = decodeTaskProgressTextV1(text, { expectedTaskFolder });
    if (!decoded.ok) {
      throw new TaskProgressJournalErrorV1(
        `task-progress document failed its strict self-decode (${decoded.code}): ${decoded.reason}`
      );
    }
    return decoded.decoded.progress;
  }

  return {
    get current(): PersistedTaskProgressV1 {
      return current;
    },
    encodedText(): string {
      return encodeTaskProgressTextV1(current);
    },
    patch(update: (progress: PersistedTaskProgressV1) => TaskProgress): PersistedTaskProgressV1 {
      const patched: PersistedTaskProgressV1 = {
        ...update(current),
        ensembleProgressVersion: 1,
        updatedAt: options.now().toISOString(),
      };
      current = verify(encodeTaskProgressTextV1(patched), options.taskFolder);
      return current;
    },
  };
}
