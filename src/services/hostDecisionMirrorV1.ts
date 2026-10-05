import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";
import { normalizeWorkflowDecisionV1, type WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import { writeMirrorSnapshotV1 } from "./hostMirrorWriteV1";

/**
 * The runner's pending workflow decisions, visible and answerable in every
 * viewer window (hostRoleV1.ts).
 *
 * Decisions ("Advance to Publish / Keep iterating / Leave it paused") live in
 * the raising window's own `workspaceState`, which another VS Code process
 * cannot read. A viewer therefore showed "escalated" on the stage with no
 * decision icon and no decision card in chat — the task sat paused on a
 * question the user could not see (seen live 2026-09-17).
 *
 * The runner writes its pending decisions to `<relay dir>/decisions-v1.json`
 * whenever they change and on a heartbeat. A viewer hands its decision store
 * a Memento whose decisions key returns the runner's records ALONGSIDE its
 * own (decisions raised by viewer-local commands must keep working), so the
 * tree and chat render both with their ordinary code. An answer to one of the
 * runner's decisions is never recorded here: it is relayed to the runner,
 * which resolves it and runs the option's effect exactly as a click there
 * would.
 *
 * Everything read back is UNTRUSTED input: the relay directory sits inside
 * the task workspace, which the workflow's own provider CLIs can write. Each
 * record is therefore structurally decoded before any UI sees it — a
 * malformed `options` array would otherwise throw inside the chat webview and
 * leave the panel unusable while a real question was waiting (review,
 * 2026-09-17). VS Code-free (type imports only), so it is unit-testable.
 */

export const HOST_DECISIONS_MIRROR_FILENAME_V1 = "decisions-v1.json";

export interface RunnerDecisionsSnapshotV1 {
  readonly writtenAt: number;
  readonly decisions: readonly WorkflowDecisionV1[];
  /**
   * Decisions the runner has already answered, so a viewer can draw them as
   * collapsed "Decided" cards. `[]` when the runner predates this field.
   * Display-only: never answerable, never part of `decisions`.
   */
  readonly answered: readonly MirroredAnsweredDecisionV1[];
  /**
   * Records in the snapshot this window could not decode. Dropping them
   * silently left a viewer showing "Waiting for your answer" with no card and
   * no way to learn that a question existed at all, so the count is reported
   * (verification review, 2026-09-18).
   */
  readonly undecodable: number;
}

/**
 * A decision the runner has answered, projected to what a viewer needs to
 * draw the collapsed "Decided" card. No options, no effect: a viewer can
 * neither re-answer nor run anything from it.
 */
export interface MirroredAnsweredDecisionV1 {
  readonly decisionId: string;
  readonly taskCanonicalId: string;
  readonly stage: string;
  readonly createdAt: string;
  readonly resolvedAt?: string;
  readonly resolvedOptionId: string;
  readonly chosenLabel: string;
  readonly whatHappened: string;
}

/**
 * Runner side: project the store's resolved records for the snapshot. A
 * record that is also pending (reposted under the same id) is dropped, and
 * so is one with no recorded choice: absence is never evidence of an answer.
 */
export function answeredDecisionsForMirrorV1(
  resolved: readonly WorkflowDecisionV1[],
  pendingIds: ReadonlySet<string>
): readonly MirroredAnsweredDecisionV1[] {
  const answered: MirroredAnsweredDecisionV1[] = [];
  for (const decision of resolved) {
    if (decision.state !== "resolved" || decision.resolvedOptionId === undefined || pendingIds.has(decision.decisionId)) {
      continue;
    }
    const chosen = decision.options.find((option) => option.optionId === decision.resolvedOptionId);
    answered.push({
      decisionId: decision.decisionId,
      taskCanonicalId: decision.taskCanonicalId,
      stage: decision.stage,
      createdAt: decision.createdAt,
      ...(decision.resolvedAt !== undefined ? { resolvedAt: decision.resolvedAt } : {}),
      resolvedOptionId: decision.resolvedOptionId,
      chosenLabel: chosen?.label ?? decision.resolvedOptionId,
      whatHappened: decision.whatHappened,
    });
  }
  return answered;
}

/**
 * Runner side: publish the pending decisions (and, for display only, the
 * answered ones). Resolves false when the write failed or was superseded, so
 * the caller's heartbeat can retry rather than caching a signature for state
 * that never reached disk.
 */
export async function writeRunnerDecisionsSnapshotV1(
  dir: string,
  decisions: readonly WorkflowDecisionV1[],
  answered: readonly MirroredAnsweredDecisionV1[] = []
): Promise<boolean> {
  return writeMirrorSnapshotV1(dir, HOST_DECISIONS_MIRROR_FILENAME_V1, {
    writtenAt: Date.now(),
    decisions,
    answered,
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * One option, structurally. `effect` is what the resolution actually runs, so
 * a `command` effect must name a command and nothing else is accepted.
 */
function decodeOption(value: unknown): value is WorkflowDecisionV1["options"][number] {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const option = value as Record<string, unknown>;
  if (!isNonEmptyString(option.optionId) || !isNonEmptyString(option.label) || typeof option.consequence !== "string") {
    return false;
  }
  // Pre-1.0.0 fixes register, item 14/22 (Part 3): a record written before
  // `resumeKind` existed omits it entirely — accepted, and defaulted to
  // `"unpause"` by `normalizeWorkflowDecisionV1` below. A PRESENT value that
  // is neither literal is a malformed record and is rejected like any other
  // structural violation.
  if (option.resumeKind !== undefined && option.resumeKind !== "unpause" && option.resumeKind !== "continue") {
    return false;
  }
  const effect = option.effect;
  if (typeof effect !== "object" || effect === null) {
    return false;
  }
  const kind = (effect as Record<string, unknown>).kind;
  if (kind === "doNothing") {
    return true;
  }
  if (kind !== "command") {
    return false;
  }
  const command = (effect as Record<string, unknown>).command;
  const args = (effect as Record<string, unknown>).args;
  return isNonEmptyString(command) && (args === undefined || Array.isArray(args));
}

/**
 * The recommendation, which the webview dereferences unguarded
 * (`dcs.recommendation.kind`). A record missing it renders one broken card
 * and aborts the loop, taking every card after it with it — so it is
 * validated here, not hoped for (verification review, 2026-09-17).
 */
function decodeRecommendation(value: unknown, optionIds: ReadonlySet<string>): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const recommendation = value as Record<string, unknown>;
  if (typeof recommendation.reasoning !== "string") {
    return false;
  }
  if (recommendation.kind === "none") {
    return true;
  }
  return recommendation.kind === "option" && isNonEmptyString(recommendation.optionId) && optionIds.has(recommendation.optionId);
}

function decodeEvidence(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.every((item) => {
    if (typeof item !== "object" || item === null) {
      return false;
    }
    const entry = item as Record<string, unknown>;
    return typeof entry.label === "string" && typeof entry.detail === "string";
  });
}

/**
 * One mirrored decision, structurally — every field the tree, the webview and
 * the resolution dereference. `stage` must be a real stage and `state` must be
 * `pending`: a viewer only ever shows the runner's OPEN questions, and a
 * fabricated stage would route a card (and its acknowledgement) into a
 * conversation that does not exist.
 */
export function decodeMirroredDecisionV1(
  value: unknown,
  isKnownStage: (stage: string) => boolean = () => true
): WorkflowDecisionV1 | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const decision = value as Record<string, unknown>;
  const options = decision.options;
  if (!Array.isArray(options) || options.length === 0 || !options.every(decodeOption)) {
    return undefined;
  }
  const optionIds = new Set(options.map((option) => (option as { optionId: string }).optionId));
  const ok =
    isNonEmptyString(decision.decisionId) &&
    isNonEmptyString(decision.decisionKey) &&
    isNonEmptyString(decision.taskCanonicalId) &&
    isNonEmptyString(decision.stage) &&
    isKnownStage(decision.stage) &&
    decision.state === "pending" &&
    isNonEmptyString(decision.createdAt) &&
    typeof decision.whatHappened === "string" &&
    typeof decision.whyUserNeeded === "string" &&
    decodeRecommendation(decision.recommendation, optionIds) &&
    (decision.evidence === undefined || decodeEvidence(decision.evidence)) &&
    (decision.gating === undefined || (typeof decision.gating === "object" && decision.gating !== null));
  // The mirror applies the same normalizer the local store's `all()` does
  // (pre-1.0.0 fixes register, item 14/22), so a decision mirrored from a
  // runner still running an older build — its options missing `resumeKind`
  // entirely — reads as `"unpause"` here, not merely once it later flows
  // through a local store's `all()`.
  return ok ? normalizeWorkflowDecisionV1(decision as unknown as WorkflowDecisionV1) : undefined;
}

/**
 * One mirrored answered decision, structurally. Strict like the pending
 * decode: an entry that fails any check is dropped, never half-shown.
 */
export function decodeMirroredAnsweredDecisionV1(
  value: unknown,
  isKnownStage: (stage: string) => boolean = () => true
): MirroredAnsweredDecisionV1 | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const entry = value as Record<string, unknown>;
  if (
    !isNonEmptyString(entry.decisionId) ||
    !isNonEmptyString(entry.taskCanonicalId) ||
    !isNonEmptyString(entry.stage) ||
    !isKnownStage(entry.stage) ||
    !isNonEmptyString(entry.createdAt) ||
    !isNonEmptyString(entry.resolvedOptionId) ||
    !isNonEmptyString(entry.chosenLabel) ||
    typeof entry.whatHappened !== "string" ||
    (entry.resolvedAt !== undefined && typeof entry.resolvedAt !== "string")
  ) {
    return undefined;
  }
  return {
    decisionId: entry.decisionId,
    taskCanonicalId: entry.taskCanonicalId,
    stage: entry.stage,
    createdAt: entry.createdAt,
    ...(typeof entry.resolvedAt === "string" ? { resolvedAt: entry.resolvedAt } : {}),
    resolvedOptionId: entry.resolvedOptionId,
    chosenLabel: entry.chosenLabel,
    whatHappened: entry.whatHappened,
  };
}

/**
 * Viewer side: the runner's snapshot, or undefined when there is none or it is
 * unreadable. `isKnownStage` is passed in (the stage list lives in the
 * extension's types) so this module stays VS Code-free and testable.
 */
export async function readRunnerDecisionsSnapshotV1(
  dir: string,
  isKnownStage: (stage: string) => boolean = () => true
): Promise<RunnerDecisionsSnapshotV1 | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(dir, HOST_DECISIONS_MIRROR_FILENAME_V1), "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.writtenAt !== "number" || !Array.isArray(record.decisions)) {
      return undefined;
    }
    const decisions: WorkflowDecisionV1[] = [];
    let undecodable = 0;
    for (const candidate of record.decisions) {
      const decoded = decodeMirroredDecisionV1(candidate, isKnownStage);
      if (decoded !== undefined) {
        decisions.push(decoded);
      } else {
        undecodable += 1;
      }
    }
    // Optional and lenient by design: a snapshot from a runner that predates
    // `answered` simply has none, and a malformed entry costs only its own
    // collapsed card, so it is dropped without counting as an unseen question.
    const answered: MirroredAnsweredDecisionV1[] = [];
    if (Array.isArray(record.answered)) {
      for (const candidate of record.answered) {
        const decoded = decodeMirroredAnsweredDecisionV1(candidate, isKnownStage);
        if (decoded !== undefined) {
          answered.push(decoded);
        }
      }
    }
    return { writtenAt: record.writtenAt, decisions, answered, undecodable };
  } catch {
    // No runner has written yet, or a torn read: nothing to show.
    return undefined;
  }
}

/**
 * Viewer side: the runner's decisions to show as answerable — none once the
 * runner has stopped reporting, because answering one relays a request to a
 * process that is not there to take it (review, 2026-09-17). `staleMs` is the
 * operations mirror's own staleness limit, passed in so the two surfaces can
 * never disagree about whether the runner is alive.
 */
export function liveMirroredDecisionsV1(
  snapshot: Omit<RunnerDecisionsSnapshotV1, "answered"> | undefined,
  now: number,
  staleMs: number
): readonly WorkflowDecisionV1[] {
  if (snapshot === undefined || now - snapshot.writtenAt > staleMs) {
    return [];
  }
  return snapshot.decisions;
}

export interface MirroredDecisionsMementoV1 {
  readonly memento: vscode.Memento;
  /** Replace the mirrored decisions; true when they changed. */
  setDecisions(decisions: readonly WorkflowDecisionV1[]): boolean;
  /** Whether `decisionId` belongs to the runner (so its answer must be relayed). */
  isMirrored(decisionId: string): boolean;
  /** Replace the mirrored answered decisions; true when they changed. */
  setAnswered(answered: readonly MirroredAnsweredDecisionV1[]): boolean;
  /**
   * The runner's recorded answer for `decisionId`, or undefined. Always
   * undefined for an id still mirrored as pending: pending wins.
   */
  answeredFor(decisionId: string): MirroredAnsweredDecisionV1 | undefined;
}

/**
 * A Memento that is `base` for every key, except that `decisionsKey` also
 * carries the runner's mirrored decisions.
 *
 * Reads return `base`'s own records FIRST and the runner's after, so a
 * decision this window raised itself keeps rendering and keeps being
 * answerable locally. Writes go to `base` untouched: resolving one of the
 * runner's decisions never writes here (the relay does it on the runner), and
 * `isMirrored` is how the caller tells the two apart.
 */
export function createMirroredDecisionsMementoV1(base: vscode.Memento, decisionsKey: string): MirroredDecisionsMementoV1 {
  let mirrored: readonly WorkflowDecisionV1[] = [];
  let mirroredIds = new Set<string>();
  let signature = "[]";
  // Kept out of the decisions key and out of `base` on purpose: they are
  // display-only, and writing them anywhere a store reads would let a
  // finished decision look answerable.
  let answeredById = new Map<string, MirroredAnsweredDecisionV1>();
  let answeredSignature = "[]";
  const memento: vscode.Memento = {
    keys: () => base.keys(),
    get: (<T>(key: string, defaultValue?: T): T | undefined => {
      if (key !== decisionsKey) {
        return defaultValue === undefined ? base.get<T>(key) : base.get<T>(key, defaultValue);
      }
      const own = base.get<readonly unknown[]>(decisionsKey, []);
      const combined: unknown[] = Array.isArray(own) ? Array.from(own as readonly unknown[]) : [];
      combined.push(...mirrored);
      return combined as unknown as T;
    }) as vscode.Memento["get"],
    update: (key: string, value: unknown) => {
      if (key !== decisionsKey) {
        return base.update(key, value);
      }
      // A store write starts from what `get` returned, which now includes the
      // runner's records — persisting those into THIS window's state would
      // duplicate every mirrored decision (once from disk, once from the
      // mirror) and keep them after the runner dropped them. Only this
      // window's own records are ever written back.
      const own = Array.isArray(value)
        ? value.filter((record) => {
            const id = (record as { decisionId?: unknown } | null)?.decisionId;
            return typeof id !== "string" || !mirroredIds.has(id);
          })
        : value;
      return base.update(key, own);
    },
  };
  return {
    memento,
    setDecisions(next) {
      const nextSignature = JSON.stringify(next);
      if (nextSignature === signature) {
        return false;
      }
      signature = nextSignature;
      mirrored = next;
      mirroredIds = new Set(next.map((decision) => decision.decisionId));
      return true;
    },
    isMirrored(decisionId) {
      return mirroredIds.has(decisionId);
    },
    setAnswered(next) {
      const nextSignature = JSON.stringify(next);
      if (nextSignature === answeredSignature) {
        return false;
      }
      answeredSignature = nextSignature;
      answeredById = new Map(next.map((entry) => [entry.decisionId, entry]));
      return true;
    },
    answeredFor(decisionId) {
      return mirroredIds.has(decisionId) ? undefined : answeredById.get(decisionId);
    },
  };
}
