import type { TaskStage } from "../types/taskProgress";
import type { WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import { ownerBlockerIdentityV1 } from "./ownerCardCoverageV1";
import { listPendingWorkflowDecisionsForTaskV1, withdrawWorkflowDecisionsByKeyV1 } from "./workflowDecisionDispatchV1";
import { normalizePath } from "./taskRoot";

/**
 * review2 Step 42: a card that asks about blockers is withdrawn as soon as a review no longer lists any of them. A
 * card about "root lint still fails" stayed open for hours after the Apply Review that fixed it and the review that
 * confirmed it (run1, 2026-11-07 17:59 to 18:21).
 */
const OWNER_ONLY_KEY_PREFIX_V1 = "ownerOnlyBlockers:";
const OWNER_DECISION_KEY_PREFIX_V1 = "ownerPlanDecision:";
const PLAN_DEVIATION_KEY_PREFIX_V1 = `${OWNER_DECISION_KEY_PREFIX_V1}plan-deviation-`;

/** A blocker as a review lists it: its description, and the lineage id it carries when it has one. */
export interface ListedBlockerV1 {
  readonly description?: string;
  readonly lineageId?: string;
}

function isBlockerCardKeyV1(decisionKey: string): boolean {
  return (
    decisionKey.startsWith(OWNER_ONLY_KEY_PREFIX_V1) ||
    (decisionKey.startsWith(OWNER_DECISION_KEY_PREFIX_V1) && !decisionKey.startsWith(PLAN_DEVIATION_KEY_PREFIX_V1))
  );
}

/**
 * The pending blocker cards for `stage` whose blockers the review no longer lists. A card that recorded no blocker
 * identities (an older card) is left to the render-time safety net, and a card with even one blocker still listed stays.
 * A clean review (no blockers listed) withdraws every such card.
 */
export function staleBlockerCardsV1(
  pending: readonly WorkflowDecisionV1[],
  stage: TaskStage,
  listed: readonly ListedBlockerV1[]
): readonly WorkflowDecisionV1[] {
  const current = new Set<string>();
  for (const blocker of listed) {
    if (blocker.lineageId !== undefined && blocker.lineageId.trim() !== "") {
      current.add(ownerBlockerIdentityV1(blocker.description ?? "", blocker.lineageId));
    }
    current.add(ownerBlockerIdentityV1(blocker.description ?? ""));
  }
  return pending.filter(
    (decision) =>
      decision.state === "pending" &&
      decision.stage === stage &&
      isBlockerCardKeyV1(decision.decisionKey) &&
      decision.blockerIdentities !== undefined &&
      decision.blockerIdentities.length > 0 &&
      !decision.blockerIdentities.some((identity) => current.has(identity))
  );
}

/** Withdraw (with the standard "Withdrawn: …" chat line) every blocker card the new review no longer backs. */
export async function withdrawStaleBlockerCardsV1(
  folder: { readonly fsPath: string },
  stage: TaskStage,
  listed: readonly ListedBlockerV1[]
): Promise<void> {
  const canonicalId = normalizePath(folder.fsPath);
  const stale = staleBlockerCardsV1(listPendingWorkflowDecisionsForTaskV1(canonicalId), stage, listed);
  for (const key of new Set(stale.map((decision) => decision.decisionKey))) {
    const ids = new Set(stale.filter((decision) => decision.decisionKey === key).map((decision) => decision.decisionId));
    await withdrawWorkflowDecisionsByKeyV1(
      { taskFolderPath: folder.fsPath, canonicalId },
      key,
      "the latest review no longer lists the blocker this card asked about",
      (decision) => ids.has(decision.decisionId)
    ).catch(() => undefined);
  }
}
