import * as vscode from "vscode";

import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import {
  MAX_PLAN_ITEM_SETTLEMENT_SNAPSHOT_ITEMS_V1,
  type PlanItemSettlementSnapshotV1,
} from "../types/taskProgress";
import { appendChatMessageV1 } from "../utils/chatHistoryStore";
import { withdrawStaleOpenItemsCardV1 } from "../utils/withdrawStaleOpenItemsCardV1";
import { readPlanOfRecordForDisplayV1, readPlanOfRecordV1 } from "../utils/implementationArtifactResolver";
import {
  listPlanItemSettlementV1,
  listUnresolvedLegacyOwnerDecisionsV1,
  type PlanItemSettlementV1,
} from "../utils/implementationChecklist";

/**
 * review1 Step 8: which items settled at the previous count lost that settlement because their own content
 * changed? An item counts as changed when its previous content hash no longer appears among the plan's items.
 * An item that is still there but unsettled again (the owner unticked it) is not "changed".
 */
export function findItemsSentBackByPlanChangeV1(
  previous: PlanItemSettlementSnapshotV1 | undefined,
  current: readonly PlanItemSettlementV1[]
): string[] {
  if (!previous) return [];
  const currentHashes = new Set(current.map((item) => item.hash));
  const lost: string[] = [];
  for (const item of previous.items) {
    if (item.settled && !currentHashes.has(item.hash)) lost.push(item.label);
  }
  return [...new Set(lost)];
}

/**
 * The earlier "sent back" labels that are still waiting: a label drops once an item with that label is settled
 * again (the review re-verified it, or the owner settled it), so the tooltip never reports a drop that is over.
 */
export function carryLostLabelsForwardV1(
  previousLost: PlanItemSettlementSnapshotV1["lost"],
  current: readonly PlanItemSettlementV1[]
): { readonly at: string; readonly labels: readonly string[] } | undefined {
  if (!previousLost) return undefined;
  const settledLabels = new Set(current.filter((item) => item.settled).map((item) => item.label));
  const labels = previousLost.labels.filter((label) => !settledLabels.has(label));
  return labels.length > 0 ? { at: previousLost.at, labels } : undefined;
}

/** The chat line naming the items a plan change sent back to the review. */
export function describeItemsSentBackV1(labels: readonly string[]): string {
  if (labels.length === 0) return "";
  const shown = labels.slice(0, 5).join(", ");
  const more = labels.length > 5 ? ` and ${labels.length - 5} more` : "";
  return (
    `${shown}${more} changed, so the review has to re-check ` +
    `${labels.length} item${labels.length === 1 ? "" : "s"}. Every other item keeps its verification.`
  );
}

/** The tooltip line the Tasks pane shows while an item is waiting to be re-checked after a plan change. */
export function describeSettlementDropForTooltipV1(snapshot: PlanItemSettlementSnapshotV1 | undefined): string | undefined {
  if (!snapshot?.lost || snapshot.lost.labels.length === 0) return undefined;
  return `Plan change: ${describeItemsSentBackV1(snapshot.lost.labels)}`;
}

/**
 * review2 Step 5: the chat line for owner decisions recorded before item ids existed that name wording more than one
 * item shares, so none of them was applied. Names each record (its decision, wording and date) and says what to do.
 */
export function describeUnresolvedLegacyOwnerDecisionsV1(
  rows: readonly { readonly decision: string; readonly itemText?: string; readonly itemKey: string; readonly at?: string }[]
): string {
  if (rows.length === 0) return "";
  const shown = rows
    .slice(0, 5)
    .map((row) => {
      const text = (row.itemText ?? row.itemKey).replace(/\s+/g, " ").trim();
      return `"${text.length > 60 ? `${text.slice(0, 59)}…` : text}" (${row.decision}${row.at ? `, ${row.at.slice(0, 10)}` : ""})`;
    })
    .join(", ");
  const more = rows.length > 5 ? ` and ${rows.length - 5} more` : "";
  return (
    `${rows.length} earlier decision${rows.length === 1 ? "" : "s"} of yours name${rows.length === 1 ? "s" : ""} wording that more ` +
    `than one plan item shares, so ${rows.length === 1 ? "it was" : "none of them were"} applied to any item: ${shown}${more}. ` +
    "Settle the item you meant again; the new decision is recorded against that item itself."
  );
}

const reportedUnresolvedLegacyV1 = new Set<string>();

/** Posts the unresolved-legacy line once per record per session; best effort. */
async function reportUnresolvedLegacyOwnerDecisionsV1(
  taskFolderPath: string,
  rows: readonly { readonly decision: string; readonly itemText?: string; readonly itemKey: string; readonly at?: string; readonly formId?: string }[],
  stage: Parameters<typeof appendChatMessageV1>[1]["stage"],
  at: string
): Promise<void> {
  const fresh = rows.filter((row) => {
    const key = `${taskFolderPath}|${row.formId ?? ""}|${row.at ?? ""}|${row.itemKey}|${row.decision}`;
    if (reportedUnresolvedLegacyV1.has(key)) return false;
    reportedUnresolvedLegacyV1.add(key);
    return true;
  });
  if (fresh.length === 0) return;
  await appendChatMessageV1(taskFolderPath, {
    role: "assistant",
    text: describeUnresolvedLegacyOwnerDecisionsV1(fresh),
    stage,
    at,
    kind: "outcome",
  }).catch(() => undefined);
}

/** Test seam: forgets which unresolved legacy decisions were already reported. */
export function resetUnresolvedLegacyReportsForTestsV1(): void {
  reportedUnresolvedLegacyV1.clear();
}

/**
 * review1 Step 8: counts the plan items now, compares with the snapshot stored at the previous count, posts one
 * chat line naming any item a plan change sent back to the review, and stores the new bounded snapshot. Best
 * effort: it never throws, and it writes nothing when the snapshot is unchanged.
 */
export async function refreshPlanItemSettlementSnapshotV1(
  folderUri: vscode.Uri,
  stage?: Parameters<typeof appendChatMessageV1>[1]["stage"],
  options: { readonly display?: boolean } = {}
): Promise<string[]> {
  try {
    // A refresh that follows a displayed count reads the durable file only, as the display reads do: it never
    // saves an open `plan-final.md` editor.
    const plan =
      options.display === true ? await readPlanOfRecordForDisplayV1(folderUri) : await readPlanOfRecordV1(folderUri);
    if (!plan.hasChecklist || plan.text === undefined) return [];
    // review2 Step 7: whichever path settled items (the form, the settle command, a review's ticks) comes through
    // here, so an open-items card listing items that are now settled is withdrawn at this one point.
    if (options.display !== true) await withdrawStaleOpenItemsCardV1(folderUri, plan.text);
    const read = await readTaskProgressStrictV1(folderUri);
    if (!read.ok) return [];
    const progress = read.decoded.progress;
    const current = listPlanItemSettlementV1(plan.text, progress.planItemEvidence ?? [], progress.planItemOwnerDecisions ?? []);
    const lost = findItemsSentBackByPlanChangeV1(progress.lastPlanItemSettlement, current);
    const at = new Date().toISOString();
    await reportUnresolvedLegacyOwnerDecisionsV1(
      folderUri.fsPath,
      listUnresolvedLegacyOwnerDecisionsV1(plan.text, progress.planItemOwnerDecisions ?? []),
      stage ?? progress.currentStage,
      at
    );
    const items = current
      .slice(0, MAX_PLAN_ITEM_SETTLEMENT_SNAPSHOT_ITEMS_V1)
      .map((item) => ({ hash: item.hash, settled: item.settled, label: item.label }));
    const previous = progress.lastPlanItemSettlement;
    const carriedLost =
      lost.length > 0 ? { at, labels: lost.slice(0, 100) } : carryLostLabelsForwardV1(previous?.lost, current);
    const unchanged =
      previous !== undefined &&
      lost.length === 0 &&
      (previous.lost?.labels.length ?? 0) === (carriedLost?.labels.length ?? 0) &&
      previous.items.length === items.length &&
      previous.items.every((item, index) => item.hash === items[index]!.hash && item.settled === items[index]!.settled);
    if (unchanged) return [];
    const next: PlanItemSettlementSnapshotV1 = {
      at,
      items,
      ...(carriedLost ? { lost: carriedLost } : {}),
    };
    await patchTaskProgressStrictV1(folderUri, (current) => ({ ...current, lastPlanItemSettlement: next }));
    if (lost.length > 0) {
      await appendChatMessageV1(folderUri.fsPath, {
        role: "assistant",
        text: describeItemsSentBackV1(lost),
        stage: stage ?? progress.currentStage,
        at,
        kind: "outcome",
      }).catch(() => undefined);
    }
    return lost;
  } catch {
    return [];
  }
}

/** The shortest gap between two refreshes for one task folder driven by displayed counts. */
export const PLAN_ITEM_COUNT_OBSERVER_MIN_GAP_MS_V1 = 10_000;

const observerLastRunAtV1 = new Map<string, number>();
const observerInFlightV1 = new Set<string>();

/**
 * review1 Step 8: follows a count a surface just displayed (the Tasks pane, the chat header, the status bar).
 * It refreshes the settlement snapshot, which names any item a plan change sent back to the review in chat and
 * keeps the Tasks tooltip's note current, even when the plan was edited by hand and no Ensemble command ran.
 * At most one refresh runs per task folder at a time and at most one per {@link PLAN_ITEM_COUNT_OBSERVER_MIN_GAP_MS_V1};
 * a refresh that finds nothing new writes nothing, so a surface re-rendering after a write does not loop.
 */
export function observeDisplayedPlanItemCountsV1(
  folderUri: vscode.Uri,
  now: () => number = Date.now
): Promise<string[]> | undefined {
  const key = folderUri.fsPath;
  if (observerInFlightV1.has(key)) return undefined;
  const last = observerLastRunAtV1.get(key);
  if (last !== undefined && now() - last < PLAN_ITEM_COUNT_OBSERVER_MIN_GAP_MS_V1) return undefined;
  observerInFlightV1.add(key);
  observerLastRunAtV1.set(key, now());
  return refreshPlanItemSettlementSnapshotV1(folderUri, undefined, { display: true }).finally(() => {
    observerInFlightV1.delete(key);
  });
}

/** Test seam: forgets the per-folder debounce so a test can observe twice in a row. */
export function resetPlanItemCountObserverForTestsV1(): void {
  observerLastRunAtV1.clear();
  observerInFlightV1.clear();
}
