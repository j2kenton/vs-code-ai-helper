import {
  listOpenPlanItemRecordsV1,
  listUncheckedChecklistItemTextsV1,
  normalizeChecklistItemTextV1,
} from "./implementationChecklist";
import {
  countSettledOpenItemsCardItemsV1,
  describeOpenItemsCardAllSettledV1,
  isOpenItemsCardStaleV1,
  listOpenItemsCardItemTextsV1,
  OPEN_PLAN_ITEMS_DECISION_KEY_V1,
} from "./openItemsCardStalenessV1";
import { normalizePath } from "./taskRoot";
import { withdrawWorkflowDecisionsByKeyV1 } from "./workflowDecisionDispatchV1";

/**
 * bugs4 item 13 / Step 24, review2 Step 7: call this wherever plan-final.md's ticks were just written. A pending
 * open-items card that listed more items than the plan now has open, or that lists an item that is now settled,
 * describes a state that no longer holds, so it is withdrawn (with the standard "Withdrawn: …" chat line). When
 * every item it listed is settled the line says so ("the 9 items are now settled; nothing is open on this card");
 * the next card is built from the plan as it stands, so its recommendation is recomputed. Best-effort; a card that
 * states no count and lists no items is left to the render-time safety net.
 */
export async function withdrawStaleOpenItemsCardV1(
  folder: { readonly fsPath: string },
  planChecklist: string
): Promise<void> {
  const openNow = listUncheckedChecklistItemTextsV1(planChecklist, 0).total;
  const openTextsNow = listOpenPlanItemRecordsV1(planChecklist)
    .filter((record) => !record.settled)
    .map((record) => record.itemText);
  const settledOf = (decision: { readonly options: Parameters<typeof listOpenItemsCardItemTextsV1>[0] }) =>
    countSettledOpenItemsCardItemsV1(listOpenItemsCardItemTextsV1(decision.options), openTextsNow, normalizeChecklistItemTextV1);
  await withdrawWorkflowDecisionsByKeyV1(
    { taskFolderPath: folder.fsPath, canonicalId: normalizePath(folder.fsPath) },
    OPEN_PLAN_ITEMS_DECISION_KEY_V1,
    (decision) => {
      const { listed, settled } = settledOf(decision);
      return listed > 0 && settled === listed
        ? describeOpenItemsCardAllSettledV1(listed)
        : "plan-final.md's checklist ticks changed, so the open-items list on the pending card is out of date";
    },
    (decision) => isOpenItemsCardStaleV1(decision.whatHappened, openNow) || settledOf(decision).settled > 0
  ).catch(() => undefined);
}
