import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";
import type { WorkflowDecisionV1 } from "../types/workflowDecisionV1";
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
}

/**
 * Runner side: publish the pending decisions. Resolves false when the write
 * failed or was superseded, so the caller's heartbeat can retry rather than
 * caching a signature for state that never reached disk.
 */
export async function writeRunnerDecisionsSnapshotV1(
  dir: string,
  decisions: readonly WorkflowDecisionV1[]
): Promise<boolean> {
  return writeMirrorSnapshotV1(dir, HOST_DECISIONS_MIRROR_FILENAME_V1, {
    writtenAt: Date.now(),
    decisions,
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
  return ok ? (decision as unknown as WorkflowDecisionV1) : undefined;
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
    for (const candidate of record.decisions) {
      const decoded = decodeMirroredDecisionV1(candidate, isKnownStage);
      if (decoded !== undefined) {
        decisions.push(decoded);
      }
    }
    return { writtenAt: record.writtenAt, decisions };
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
  snapshot: RunnerDecisionsSnapshotV1 | undefined,
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
  };
}
