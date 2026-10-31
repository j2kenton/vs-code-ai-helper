/**
 * bugs3 Step 16: a manual advance past review blockers is one deliberate,
 * auditable action.
 *
 * The owner's click on "Complete Stage & Move On" while a review still lists
 * blockers used to be answered by a second, separate chat card labelled
 * "Complete Anyway" and "Optional" — one click turned into a round trip, a
 * second click raised a duplicate, and the label read as finishing the task.
 * The helpers here give the click ONE confirmation ("Advance to <next stage>
 * anyway"), bound to the task, source stage, destination and the exact blocker
 * set so a repeated click joins the same confirmation instead of raising
 * another, and record the override with the blockers it skipped.
 *
 * Pure of `vscode`; the command owns the chat card and the transition.
 */
import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

/** The task-folder file the overrides are appended to (one JSON object per line). */
export const STAGE_ADVANCE_OVERRIDE_FILE_V1 = "advance-overrides-v1.jsonl";

export interface AdvanceSkippedBlockerV1 {
  /** Caller-supplied id; otherwise {@link skippedBlockerIdV1} derives a stable one. */
  readonly id?: string;
  /** The lineage the reviewer declared (for example `same:<id>`), when it declared one. */
  readonly declaredLineage?: string;
  readonly category: string;
  readonly resolver: string;
  readonly description: string;
}

export interface StageAdvanceOverrideRecordV1 {
  readonly kind: "stage-advance-override";
  readonly sourceStage: string;
  readonly destinationStage: string;
  /** Who chose to advance. A manual click is always the owner. */
  readonly actor: "owner";
  readonly at: string;
  readonly skippedBlockers: readonly AdvanceSkippedBlockerV1[];
}

const OWNER_EVIDENCE_RE = /^\W*owner evidence needed\b/i;

/** "Advance to Low-Level Review (Plan) anyway": names what happens, never "Complete". */
export function advanceAnywayLabelV1(nextStageName: string): string {
  return `Advance to ${nextStageName} anyway`;
}

export function isOwnerEvidenceBlockerV1(blocker: Pick<AdvanceSkippedBlockerV1, "description">): boolean {
  return OWNER_EVIDENCE_RE.test(blocker.description);
}

/**
 * Guidance that matches the kinds of blocker being skipped. An owner-evidence
 * blocker cannot be cleared by a plan.md edit, so it points to the Owner evidence
 * answer or to advancing with the gate carried forward; a task-fixable blocker
 * points to a fix round; anything else (environmental, unverifiable, …) is
 * something no round will clear.
 */
export function advanceBlockerGuidanceV1(blockers: readonly AdvanceSkippedBlockerV1[], nextStageName: string): string {
  const ownerEvidence = blockers.filter(isOwnerEvidenceBlockerV1);
  const taskFixable = blockers.filter((b) => !isOwnerEvidenceBlockerV1(b) && b.resolver === "task-fixable");
  const other = blockers.filter((b) => !isOwnerEvidenceBlockerV1(b) && b.resolver !== "task-fixable");
  const lines: string[] = [];
  if (ownerEvidence.length > 0) {
    lines.push(
      `${ownerEvidence.length === 1 ? "The owner-evidence blocker" : "The owner-evidence blockers"} cannot be cleared by a plan edit: ` +
        "answer it under Owner evidence in this chat, or advance now and carry the gate forward to the steps that depend on it."
    );
  }
  if (taskFixable.length > 0) {
    lines.push(
      `${taskFixable.length === 1 ? "The task-fixable blocker" : "The task-fixable blockers"} can be addressed by a fix round that re-reviews this stage; ` +
        "advancing skips that."
    );
  }
  if (other.length > 0) {
    lines.push(
      `${other.length === 1 ? "The other blocker is" : "The other blockers are"} not something another round can fix; advancing records that you moved on with ${other.length === 1 ? "it" : "them"} open.`
    );
  }
  lines.push(`Advancing to ${nextStageName} is recorded as an override together with the blockers it skips.`);
  return lines.join(" ");
}

/** Identity of one confirmation: the task, the move, and the exact blocker set. */
export function stageAdvanceConfirmationKeyV1(
  taskFolderPath: string,
  sourceStage: string,
  destinationStage: string,
  blockers: readonly Pick<AdvanceSkippedBlockerV1, "description">[]
): string {
  const digest = crypto
    .createHash("sha256")
    .update(blockers.map((b) => b.description.trim()).sort().join("\n"))
    .digest("hex")
    .slice(0, 16);
  return `${path.normalize(taskFolderPath)}\u0000${sourceStage}\u0000${destinationStage}\u0000${digest}`;
}

const advancesInFlight = new Set<string>();

/** One manual advance per task and source stage at a time. */
export function stageAdvanceInFlightKeyV1(taskFolderPath: string, sourceStage: string): string {
  return `${path.normalize(taskFolderPath)}\u0000${sourceStage}`;
}

/**
 * Holds one advance slot per key across the WHOLE advance — the confirmation,
 * the revalidation after it, the audit record and the committed transition — so
 * a second click while any of those is in flight is refused rather than raising
 * another confirmation or racing the transition. `work` receives an idempotent
 * `release` for the moment the transition has committed (so the follow-up
 * dispatch is not blocked); the slot is always released when `work` settles.
 * A busy slot runs `onBusy` instead of `work`.
 */
export async function runExclusiveStageAdvanceV1<T>(
  key: string,
  work: (release: () => void) => Promise<T>,
  onBusy: () => Promise<T> | T
): Promise<T> {
  if (advancesInFlight.has(key)) {
    return onBusy();
  }
  advancesInFlight.add(key);
  let released = false;
  const release = (): void => {
    if (!released) {
      released = true;
      advancesInFlight.delete(key);
    }
  };
  try {
    return await work(release);
  } finally {
    release();
  }
}

/** @internal for tests */
export function pendingStageAdvanceCountV1(): number {
  return advancesInFlight.size;
}

/**
 * A stable id for a skipped blocker. `ReviewBlocker` carries no id of its own, so
 * derive one from what identifies it (category, resolver, description): the same
 * blocker skipped twice maps to the same id.
 */
export function skippedBlockerIdV1(
  blocker: Pick<AdvanceSkippedBlockerV1, "category" | "resolver" | "description">
): string {
  return crypto
    .createHash("sha256")
    .update(`${blocker.category}\u0000${blocker.resolver}\u0000${blocker.description.trim()}`)
    .digest("hex")
    .slice(0, 12);
}

export function buildStageAdvanceOverrideRecordV1(input: {
  readonly sourceStage: string;
  readonly destinationStage: string;
  readonly blockers: readonly AdvanceSkippedBlockerV1[];
  readonly now?: Date;
}): StageAdvanceOverrideRecordV1 {
  return {
    kind: "stage-advance-override",
    sourceStage: input.sourceStage,
    destinationStage: input.destinationStage,
    actor: "owner",
    at: (input.now ?? new Date()).toISOString(),
    skippedBlockers: input.blockers.map((b) => ({
      id: b.id ?? skippedBlockerIdV1(b),
      ...(b.declaredLineage !== undefined ? { declaredLineage: b.declaredLineage } : {}),
      category: b.category,
      resolver: b.resolver,
      description: b.description,
    })),
  };
}

/**
 * Appends one override to the task folder's log. Never throws; the caller writes
 * it BEFORE the transition and refuses the advance when this returns false, so an
 * advance cannot succeed without its audit line.
 */
export async function appendStageAdvanceOverrideV1(
  taskFolderPath: string,
  record: StageAdvanceOverrideRecordV1
): Promise<boolean> {
  try {
    await fsp.appendFile(path.join(taskFolderPath, STAGE_ADVANCE_OVERRIDE_FILE_V1), `${JSON.stringify(record)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * The override line is written before the transition. When the transition then
 * fails, this line says the override did not take effect.
 */
export async function voidStageAdvanceOverrideV1(
  taskFolderPath: string,
  record: StageAdvanceOverrideRecordV1,
  reason: string,
  now: Date = new Date()
): Promise<boolean> {
  const line = {
    kind: "stage-advance-override-void",
    voids: record.at,
    sourceStage: record.sourceStage,
    destinationStage: record.destinationStage,
    reason,
    at: now.toISOString(),
  };
  try {
    await fsp.appendFile(path.join(taskFolderPath, STAGE_ADVANCE_OVERRIDE_FILE_V1), `${JSON.stringify(line)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}
