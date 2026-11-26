import { isFastForwardRunActiveV1 } from "./activeFastForwardRunsV1";

/**
 * bugs3 Step 2: a card's claim about what is or is not running must come from
 * the live operations state when it is rendered and when an option is taken,
 * not from how the card was raised. The operation registry (local and
 * runner-mirrored) registers itself here so card code that must stay free of
 * the registry's own imports can still ask the one question that matters.
 */
export interface LiveTaskOperationV1 {
  readonly label: string;
  /** The registry id of the operation, so a card can offer to cancel exactly this one. */
  readonly operationId?: string;
  /** True when the operation runs in another window (mirrored from the runner), so this window never sees it end. */
  readonly mirrored?: boolean;
  /** Epoch ms the operation started, when known. */
  readonly startedAt?: number;
  /** What it is doing right now ("tests", "iteration 3/5"), when it reported something. */
  readonly activity?: string;
}

type LiveTaskOperationLookupV1 = (taskFolderPath: string) => LiveTaskOperationV1 | undefined;

let lookup: LiveTaskOperationLookupV1 | undefined;

/** Register (or, with `undefined`, clear) the registry-backed lookup. */
export function setLiveTaskOperationLookupV1(next: LiveTaskOperationLookupV1 | undefined): void {
  lookup = next;
}

/**
 * The operation currently holding the task, local or mirrored from the runner,
 * or undefined when nothing is running. An active in-process Fast Forward loop
 * counts even if the registry has no row for it at this instant.
 */
export function getLiveTaskOperationV1(taskFolderPath: string): LiveTaskOperationV1 | undefined {
  const registered = lookup?.(taskFolderPath);
  if (registered) {
    return registered;
  }
  return isFastForwardRunActiveV1(taskFolderPath) ? { label: "Fast Forward" } : undefined;
}

/** `"Fast Forward Review" (running 3 min so far)`, for card text. */
export function describeLiveTaskOperationV1(op: LiveTaskOperationV1, now: number = Date.now()): string {
  if (op.startedAt === undefined) {
    return `"${op.label}"`;
  }
  const minutes = Math.max(0, Math.round((now - op.startedAt) / 60_000));
  return `"${op.label}" (running ${minutes < 1 ? "under a minute" : `${minutes} min`} so far)`;
}

type OperationLiveByIdLookupV1 = (taskFolderPath: string, operationId: string) => boolean;

let byIdLookup: OperationLiveByIdLookupV1 | undefined;

/** Register (or, with `undefined`, clear) the registry-backed per-operation lookup. */
export function setOperationLiveByIdLookupV1(next: OperationLiveByIdLookupV1 | undefined): void {
  byIdLookup = next;
}

/**
 * Whether the exact operation `operationId` is still running for the task.
 * `undefined` means no lookup is registered, so nothing can be concluded;
 * `false` means the operation ended, or a different operation now holds the
 * task. A newer operation never counts as the referenced one.
 */
export function isOperationLiveByIdV1(taskFolderPath: string, operationId: string): boolean | undefined {
  return byIdLookup?.(taskFolderPath, operationId);
}
