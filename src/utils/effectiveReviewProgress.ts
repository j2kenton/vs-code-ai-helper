/**
 * The effective plan-progress a review reports, reconciled against the plan
 * of record's checklist — the SAME value the stage-advance gates compute
 * (see reviewActions.ts), factored into one helper so read-only surfaces
 * (the Tasks tree's stage rows) can show exactly the count the workflow acts
 * on instead of re-deriving it — or trusting the review's raw
 * `<!-- progress: N/M -->` marker, whose self-chosen denominator can declare
 * a plan finished while most of its checklist remains unchecked.
 */
import * as path from "path";
import * as vscode from "vscode";

import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { isPlanReviewStage, TaskProgress, TaskStage } from "../types/taskProgress";
import {
  ChecklistProgressV1,
  countChecklistEvidenceProgressV1,
  countChecklistProgressV1,
  countOpenOwnerHandOffsV1,
  formatChecklistPercentV1,
  implementationDisplayCountsV1,
  listOpenPlanItemsForEndV1,
  mergeChecklistProgressV1,
} from "./implementationChecklist";
import { classifyDeferredPlanScopeV1 } from "./deferredPlanScopeV1";
import { readPlanOfRecordForDisplayV1, readPlanOfRecordV1 } from "./implementationArtifactResolver";
import { NotificationRouter } from "./notificationRouter";
import { readTextIfExists } from "./fileUtils";
import {
  parseReviewProgress,
  reconcileProgressWithChecklistV1,
  ReviewProgress,
} from "./reviewReadiness";

/** Basename of the in-round, best-effort progress bookkeeping file a round
 * appends to (Ensemble 1.0 RC1, item 6 / f3 Part 10). Never written to
 * plan-final.md, and never read by the gate reader — only by the two
 * display readers below. */
const ROUND_PROGRESS_FILENAME_V1 = "round-progress.md";

/**
 * Best-effort read of `round-progress.md`, merged IN MEMORY against
 * `planText` (the plan bytes already read by the caller) via
 * `mergeChecklistProgressV1`, and counted — never written back to
 * plan-final.md. A missing, empty, unreadable, or non-matching file yields
 * `counted` unchanged and silently: this is display bookkeeping only, never
 * a source of a warning or a latch.
 */
async function applyRoundProgressBestEffortV1(
  folderUri: vscode.Uri,
  planText: string | undefined,
  counted: ChecklistProgressV1
): Promise<ChecklistProgressV1> {
  if (planText === undefined) {
    return counted;
  }
  const roundProgressUri = vscode.Uri.joinPath(folderUri, ROUND_PROGRESS_FILENAME_V1);
  const roundProgressText = await readTextIfExists(roundProgressUri);
  if (!roundProgressText) {
    return counted;
  }
  const merged = mergeChecklistProgressV1(planText, roundProgressText);
  if (merged.kind !== "merged") {
    return counted;
  }
  return countChecklistProgressV1(merged.content) ?? counted;
}

/**
 * How an unreadable/corrupt task-progress file behaves mid-read:
 *
 * - `"strict"` — the stage-advance gate's behavior: notify and throw, so a
 *   gate never advances a stage on progress state it could not read.
 * - `"lenient"` (default) — for read-only renders (the Tasks tree): stand
 *   the checklist reconciliation down (checklist → `undefined`, the review's
 *   marker returned unchanged) so a tree render never throws or notifies.
 */
export type EffectiveReviewProgressPolicyV1 = "strict" | "lenient";

/**
 * Result of the advisory task-progress read behind the checklist read:
 * `"ok"` carries the decoded progress (or `undefined` for a simply-missing
 * file — nothing to stand down); `"unreadable"` is the lenient policy's
 * stand-down signal for a corrupt file, which must take the checklist down
 * with it rather than presenting counts the latch state cannot vouch for.
 */
type ChecklistAdvisoryReadV1 =
  | { readonly kind: "ok"; readonly progress: TaskProgress | undefined }
  | { readonly kind: "unreadable" };

/**
 * Strict-decode advisory read of task-progress.json. A missing file is
 * `ok`/`undefined`; any other decode failure notifies and throws under the
 * strict policy (byte-identical to the gate's historical behavior) but
 * reports `"unreadable"` silently under the lenient one.
 */
async function readTaskProgressForChecklistV1(
  folderUri: vscode.Uri,
  policy: EffectiveReviewProgressPolicyV1
): Promise<ChecklistAdvisoryReadV1> {
  const strict = await readTaskProgressStrictV1(folderUri, {
    expectedTaskFolder: path.basename(folderUri.fsPath),
  });
  if (strict.ok) {
    return { kind: "ok", progress: strict.decoded.progress };
  }
  if (strict.code === "missing") {
    return { kind: "ok", progress: undefined };
  }
  if (policy === "lenient") {
    return { kind: "unreadable" };
  }
  const folderName = path.basename(folderUri.fsPath);
  NotificationRouter.showError(
    `Task progress for ${folderName} could not be read (${strict.code}) and needs recovery: ${strict.reason}`
  );
  throw new Error(
    `Task progress recovery required for ${folderName} (${strict.code}): ${strict.reason}`
  );
}

/**
 * review1 Step 5: every plan-item count a surface shows, from one read. The Tasks pane, the chat header, the
 * status bar, the cards, the stage-advance gate and the prompt variables all take their numbers from here, so
 * two surfaces can never disagree about how many plan items are done.
 */
export interface PlanItemCountsV1 {
  /** Top-level plan items (the fixed denominator). */
  readonly total: number;
  /** Items the gate counts as settled: reviewer-verified + owner-settled + excluded. */
  readonly settled: number;
  /** Ticked items a reviewer verified. */
  readonly verified: number;
  /** Ticked items the owner settled (form tick, Tick or Exclude, owner test run). */
  readonly ownerSettled: number;
  /** Items excluded from the plan (including owner hand-offs). */
  readonly excluded: number;
  /** Excluded items whose box is still unticked: waiting on a person, not unbuilt work. */
  readonly handOffs: number;
  /** Ticked items no reviewer or owner has settled yet (the gate rule; an unsettled child holds its parent here). */
  readonly provisional: number;
  /** Items neither settled nor ticked: work still to build. */
  readonly open: number;
  /** Items already closed without doing when Implementation first started (left out of the percentage). */
  readonly closedBeforeImplementation: number;
  /** Items the task or plan defers, or a carried owner gate holds (shown apart from open work). */
  readonly deferred: number;
  /** True while the checklist is flagged unreliable: ticks may not match the work, so the figure is qualified. */
  readonly latched: boolean;
  /** The Implementation percentage rule (`implementationDisplayCountsV1`) over the gate's settled count. */
  readonly percent: number;
  /** `settled - closedBeforeImplementation` over `total - closedBeforeImplementation`. */
  readonly shown: { readonly complete: number; readonly total: number };
  /** The gate's full counts, for callers that still reconcile a review marker against them. */
  readonly gate: ChecklistProgressV1;
  /** The plan's own box counts (what the file shows: ticked, excluded, total), before any evidence is applied. */
  readonly display: ChecklistProgressV1;
  /** Boxes ticked in the plan (display count, before any in-round bookkeeping). */
  readonly ticked: number;
  /** Ticks a running round has recorded in round-progress.md that no review has seen: detail, never in the count. */
  readonly roundTicks: number;
  /** The display counts with the running round's live ticks merged in (tree and header detail only). */
  readonly withRoundProgress: ChecklistProgressV1;
}

/**
 * review1 Step 5: the one read API for plan-item counts. `mode: "gate"` reads the plan of record the way the
 * advance gates do; `mode: "display"` reads the durable file only (it never saves an open editor) and adds the
 * round's live ticks as a separate detail. Returns `undefined` when there is no countable checklist or, under
 * the lenient policy, the progress file cannot be read.
 */
export async function readPlanItemCountsV1(
  folderUri: vscode.Uri,
  options: { readonly policy?: EffectiveReviewProgressPolicyV1; readonly mode?: "gate" | "display" } = {}
): Promise<PlanItemCountsV1 | undefined> {
  const counts = await readPlanItemCountsCoreV1(folderUri, options);
  // review1 Step 8: the count the owner is about to see also feeds the settlement snapshot, so a plan change that
  // sent items back to the review is named in chat and in the tooltip whichever surface counted first. The read
  // stays pure; the observer (registered at activation) does the best-effort bookkeeping, off this call's path.
  if (counts && options.mode === "display") {
    try {
      planItemCountsObserverV1?.(folderUri);
    } catch {
      // Bookkeeping only; a failing observer never changes what a surface shows.
    }
  }
  return counts;
}

/**
 * review1 Step 61: the plan items still neither ticked nor excluded (nested ones included), read from the same plan
 * and progress as {@link readPlanItemCountsV1}, with those counts. `undefined` when there is no countable checklist.
 */
export async function readOpenPlanItemListV1(
  folderUri: vscode.Uri,
  options: { readonly policy?: EffectiveReviewProgressPolicyV1 } = {}
): Promise<{ readonly items: readonly string[]; readonly counts: PlanItemCountsV1 } | undefined> {
  const policy = options.policy ?? "lenient";
  const plan = await readPlanOfRecordV1(folderUri);
  if (!plan.hasChecklist || !plan.counts || plan.text === undefined) {
    return undefined;
  }
  const advisory = await readTaskProgressForChecklistV1(folderUri, policy);
  if (advisory.kind === "unreadable") {
    return undefined;
  }
  const taskMd = (await readTextIfExists(vscode.Uri.joinPath(folderUri, "task.md")).catch(() => undefined)) ?? "";
  const counts = computePlanItemCountsV1({ planText: plan.text, progress: advisory.progress, taskMd });
  if (!counts) {
    return undefined;
  }
  const items = listOpenPlanItemsForEndV1(
    plan.text,
    advisory.progress?.planItemEvidence ?? [],
    advisory.progress?.planItemOwnerDecisions ?? []
  );
  return { items, counts };
}

let planItemCountsObserverV1: ((folderUri: vscode.Uri) => void) | undefined;

/**
 * review1 Step 8: registers the one observer that follows displayed plan-item counts (see
 * `observeDisplayedPlanItemCountsV1`). Passing `undefined` removes it. Display-mode reads call it without
 * awaiting; it must never throw into the read.
 */
export function setPlanItemCountsObserverV1(observer: ((folderUri: vscode.Uri) => void) | undefined): void {
  planItemCountsObserverV1 = observer;
}

async function readPlanItemCountsCoreV1(
  folderUri: vscode.Uri,
  options: { readonly policy?: EffectiveReviewProgressPolicyV1; readonly mode?: "gate" | "display" }
): Promise<PlanItemCountsV1 | undefined> {
  const policy = options.policy ?? "lenient";
  const plan = options.mode === "display" ? await readPlanOfRecordForDisplayV1(folderUri) : await readPlanOfRecordV1(folderUri);
  if (!plan.hasChecklist || !plan.counts || plan.text === undefined) {
    return undefined;
  }
  const advisory = await readTaskProgressForChecklistV1(folderUri, policy);
  if (advisory.kind === "unreadable") {
    return undefined;
  }
  const withRoundProgress =
    options.mode === "display" ? await applyRoundProgressBestEffortV1(folderUri, plan.text, plan.counts) : plan.counts;
  const taskMd = (await readTextIfExists(vscode.Uri.joinPath(folderUri, "task.md")).catch(() => undefined)) ?? "";
  return computePlanItemCountsV1({ planText: plan.text, progress: advisory.progress, taskMd, withRoundProgress });
}

/**
 * review1 Step 5: the pure core of {@link readPlanItemCountsV1}, for callers that already hold the plan text and
 * the task progress (prompt variables, cards). Same engine, same numbers.
 */
export function computePlanItemCountsV1(input: {
  readonly planText: string;
  readonly progress:
    | {
        readonly planItemEvidence?: readonly NonNullable<TaskProgress["planItemEvidence"]>[number][];
        readonly planItemOwnerDecisions?: readonly NonNullable<TaskProgress["planItemOwnerDecisions"]>[number][];
        readonly checklistProgressUnreliable?: boolean;
      }
    | undefined;
  readonly taskMd?: string;
  /** The display counts with a running round's live ticks merged in; defaults to the plan's own counts. */
  readonly withRoundProgress?: ChecklistProgressV1;
}): PlanItemCountsV1 | undefined {
  const planCounts = countChecklistProgressV1(input.planText);
  if (!planCounts) {
    return undefined;
  }
  const withRoundProgress = input.withRoundProgress ?? planCounts;
  const evidence = countChecklistEvidenceProgressV1(
    input.planText,
    input.progress?.planItemEvidence ?? [],
    input.progress?.planItemOwnerDecisions ?? []
  );
  const gate = evidence?.gate ?? planCounts;
  const provisional = evidence?.provisional ?? Math.max(0, planCounts.checked);
  const deferredScope = classifyDeferredPlanScopeV1({ planText: input.planText, taskMd: input.taskMd ?? "" });
  const shown = implementationDisplayCountsV1(gate);
  return {
    total: gate.total,
    settled: gate.settled,
    verified: evidence?.verified ?? 0,
    ownerSettled: evidence?.ownerSettled ?? 0,
    excluded: gate.closedWithoutDoing,
    handOffs: countOpenOwnerHandOffsV1(input.planText),
    provisional,
    open: Math.max(0, gate.total - gate.settled - provisional),
    closedBeforeImplementation: gate.closedBeforeImplementation ?? 0,
    deferred: deferredScope.counts.deferred + deferredScope.counts.gated,
    latched: input.progress?.checklistProgressUnreliable === true,
    percent: formatChecklistPercentV1(shown.complete, shown.total),
    shown: { complete: shown.complete, total: shown.total },
    gate,
    display: evidence?.display ?? planCounts,
    ticked: planCounts.checked,
    roundTicks: Math.max(0, withRoundProgress.checked - planCounts.checked),
    withRoundProgress,
  };
}

/**
 * The reviewer-facing `{{checklistProgress}}` value, built from the shared counts (review1 Step 5): the gate's
 * `settled/total`, in the exact form the reviewer echoes as `<!-- progress: N/M -->`.
 */
export function formatPlanItemCountsForReviewerV1(counts: PlanItemCountsV1 | undefined): string {
  return counts ? `${counts.settled}/${counts.total}` : "unknown";
}

/** The first line of the reviewer-facing `{{checklistEvidence}}`: the split behind the settled count. */
export function formatPlanItemCountsEvidenceLineV1(counts: PlanItemCountsV1 | undefined): string {
  if (!counts) return "unknown";
  return (
    `${counts.verified} reviewer-verified; ${counts.provisional} provisional; ` +
    (counts.ownerSettled > 0 ? `${counts.ownerSettled} settled by the owner; ` : "") +
    `${counts.excluded} explicitly excluded`
  );
}

/**
 * review1 Step 5: "N open, of which M are owner hand-offs", from the shared counts. `display.remaining` is the
 * plan's own unsettled count (an excluded hand-off is settled there), so the open figure is that plus the
 * hand-offs still waiting on a person: the sentence `describeOpenAndHandOffsV1` builds from the plan text.
 */
export function describeOpenAndHandOffsFromCountsV1(counts: PlanItemCountsV1 | undefined): string | undefined {
  if (!counts) return undefined;
  return `${counts.display.remaining + counts.handOffs} open, of which ${counts.handOffs} are owner hand-offs`;
}

/** One sentence the surfaces share for a latched checklist (review1 Step 10): the figure stays, qualified. */
export const LATCHED_COUNT_NOTE_V1 = "some ticks not yet checked";

/**
 * The plan of record's checklist state, for reconciling against a review's
 * self-reported progress marker (see reconcileProgressWithChecklistV1).
 * `undefined` whenever there is nothing authoritative to reconcile against:
 * no plan-final.md, one that never had a checklist generated, or — under the
 * lenient policy — a progress file that could not be read at all.
 *
 * bugs2 Step 20 (review, 2026-10-26): the `checklistProgressUnreliable`
 * latch no longer stands this gate value down. The returned count is the
 * EVIDENCE gate — reviewer-verified completion plus explicit exclusions —
 * which never reads the checkbox ticks the latch distrusts, so a latched
 * task reconciles exactly like an unlatched one and a clean review can no
 * longer advance a plan whose every tick is an unverified self-claim. The
 * latch survives as a display qualifier and as the under-recording signal
 * that offers reconciliation, never as a completeness-gate bypass.
 */
export async function readEffectivePlanChecklistProgressV1(
  folderUri: vscode.Uri,
  policy: EffectiveReviewProgressPolicyV1 = "lenient"
): Promise<ChecklistProgressV1 | undefined> {
  return (await readPlanItemCountsV1(folderUri, { policy, mode: "gate" }))?.gate;
}

/**
 * The plan of record's TICK counts, for implementation-side questions ("is
 * there unbuilt work left for a round to do?") rather than completeness
 * gating. A ticked item is built even while it is still provisional — no
 * implementation round can verify it, only a review — so counting
 * provisional ticks as remaining here would refuse or misclassify rounds on
 * a plan with nothing left to build. Stands down (`undefined`) while the
 * `checklistProgressUnreliable` latch is set, since the ticks themselves are
 * then in doubt; advance gates keep using the evidence reader above, which
 * never stands down.
 */
export async function readPlanChecklistTickProgressV1(
  folderUri: vscode.Uri,
  policy: EffectiveReviewProgressPolicyV1 = "lenient"
): Promise<ChecklistProgressV1 | undefined> {
  const plan = await readPlanOfRecordV1(folderUri);
  if (!plan.hasChecklist || !plan.counts) {
    return undefined;
  }
  const advisory = await readTaskProgressForChecklistV1(folderUri, policy);
  if (advisory.kind === "unreadable" || advisory.progress?.checklistProgressUnreliable) {
    return undefined;
  }
  return plan.counts;
}

/**
 * Display-only counterpart of `readEffectivePlanChecklistProgressV1`: the same
 * plan-of-record counts, but a latched (`checklistProgressUnreliable`) task
 * still yields its figure, flagged `unverified`, so the tree can qualify the
 * number instead of hiding it. NEVER feed this to an advance gate — gating
 * stays on the strict evidence reader above, including while latched.
 *
 * Genuine no-value cases (no plan, no checklist, unreadable progress file)
 * still return `undefined`: those are "not applicable", not "unverified".
 *
 * Reads through `readPlanOfRecordForDisplayV1` (merge of `ui 12` into
 * `v1 f2`, 2026-09-21), so refreshing a percentage while a run is ticking
 * boxes never saves an open `plan-final.md` editor.
 */
export async function readDisplayPlanChecklistProgressV1(
  folderUri: vscode.Uri,
  policy: EffectiveReviewProgressPolicyV1 = "lenient"
): Promise<{ counts: ChecklistProgressV1; verifiedCounts: ChecklistProgressV1; verified: number; ownerSettled: number; provisional: number; unverified: boolean; openHandOffs: number; roundTicks: number } | undefined> {
  const counts = await readPlanItemCountsV1(folderUri, { policy, mode: "display" });
  if (!counts) {
    return undefined;
  }
  return {
    counts: counts.withRoundProgress,
    verifiedCounts: counts.gate,
    verified: counts.verified,
    ownerSettled: counts.ownerSettled,
    // review1 Step 5: the gate's provisional count; live in-round ticks are `roundTicks`, a separate detail.
    provisional: counts.provisional,
    unverified: counts.latched,
    // bugs4 item 49: excluded items whose box is unticked are owner hand-offs, not unbuilt work.
    openHandOffs: counts.handOffs,
    roundTicks: counts.roundTicks,
  };
}

/**
 * Display-only twin of `readEffectivePlanChecklistProgressV1` (lenient policy)
 * built on `readPlanOfRecordForDisplayV1`, so refreshing a percentage while a
 * run is ticking boxes never saves an open `plan-final.md` editor. Read-only
 * end to end: the advisory task-progress read decodes and never writes.
 *
 * Since review1 Step 10 this reader no longer hides its figure while
 * `checklistProgressUnreliable` is set: it returns Step 5's count with
 * `latched` set, and the status bar and chat header add a short "some ticks not
 * yet checked" note. Gating never flows through here.
 *
 * Kept alongside `readDisplayPlanChecklistProgressV1` above. Both are pinned by
 * tests; neither replaces the other.
 */
export async function readEffectivePlanChecklistProgressForDisplayV1(
  folderUri: vscode.Uri
): Promise<PlanItemCountsV1 | undefined> {
  // review1 Step 10: a latched checklist keeps its figure (`latched` qualifies it) instead of hiding it, so the
  // status bar and chat header show the same count as the Tasks pane.
  return readPlanItemCountsV1(folderUri, { policy: "lenient", mode: "display" });
}

/**
 * review1 Steps 5 and 10: the one-line text the chat header and the status bar append for an implementation
 * stage, built from the shared counts: the Implementation percentage, verified and provisional, a latch note
 * when some ticks are not yet checked, and the running round's live ticks as a separate detail.
 */
export function formatPlanItemCountsLineV1(counts: PlanItemCountsV1): string {
  const parts = [`${counts.verified} verified`, `${counts.provisional} provisional`];
  if (counts.latched) parts.push(LATCHED_COUNT_NOTE_V1);
  if (counts.roundTicks > 0) parts.push(`${counts.roundTicks} ticked this round, awaiting review`);
  return `${counts.percent}% (${parts.join(", ")})`;
}

/**
 * The progress a review effectively reports for `stage`:
 *
 * - Plan-review stages emit no implementation-progress marker of their own,
 *   so the raw marker passes through unreconciled — reconciling would
 *   substitute the implementation's outstanding count into the plan stage
 *   and block its advance when returning to implementation is precisely
 *   what would tick those items off.
 * - Every other review stage reconciles the marker against the plan of
 *   record's checklist, so the value shown to the user is the same
 *   checklist-reconciled count the advance gates act on.
 *
 * Parsing stays tolerant of AI-generated variation (see parseReviewProgress):
 * a missing or nonsensical marker yields `null` and callers render exactly
 * their pre-marker, score-only output.
 */
export async function effectiveReviewProgressV1(
  folderUri: vscode.Uri,
  stage: TaskStage,
  reviewText: string,
  policy: EffectiveReviewProgressPolicyV1 = "lenient"
): Promise<ReviewProgress | null> {
  const marker = parseReviewProgress(reviewText);
  if (isPlanReviewStage(stage)) {
    return marker;
  }
  const checklist = await readEffectivePlanChecklistProgressV1(folderUri, policy);
  return reconcileProgressWithChecklistV1(marker, checklist);
}
