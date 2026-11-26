import { listUncheckedChecklistItemTextsV1 } from "./implementationChecklist";
import { isOpenItemsCardStaleV1, OPEN_PLAN_ITEMS_DECISION_KEY_V1 } from "./openItemsCardStalenessV1";
import { normalizePath } from "./taskRoot";
import { withdrawWorkflowDecisionsByKeyV1 } from "./workflowDecisionDispatchV1";

/**
 * bugs4 item 13 / Step 24: call this wherever plan-final.md's ticks were just written. A pending
 * open-items card that listed more items than the plan now has open describes a state that no
 * longer holds, so it is withdrawn (with the standard "Withdrawn: …" chat line) by the same rule
 * that withdraws the tick-application card. Best-effort; a card that states no count is left to
 * the render-time safety net.
 */
export async function withdrawStaleOpenItemsCardV1(
  folder: { readonly fsPath: string },
  planChecklist: string
): Promise<void> {
  const openNow = listUncheckedChecklistItemTextsV1(planChecklist, 0).total;
  await withdrawWorkflowDecisionsByKeyV1(
    { taskFolderPath: folder.fsPath, canonicalId: normalizePath(folder.fsPath) },
    OPEN_PLAN_ITEMS_DECISION_KEY_V1,
    "plan-final.md's checklist ticks changed, so the open-items list on the pending card is out of date",
    (decision) => isOpenItemsCardStaleV1(decision.whatHappened, openNow)
  ).catch(() => undefined);
}
