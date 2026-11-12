import type { WorkflowDecisionV1 } from "../types/workflowDecisionV1";

/**
 * bugs7 item 4: when the owner last answered a decision card about a blocker. A blocker that stood across reviews as
 * an owner decision is a new one for a round once the owner has answered: the reviews before the answer asked the
 * owner, not a round, so they must not count towards "stood unchanged". A decision is about the blocker when the
 * blocker's text names the decision's id, or the card carries the blocker's lineage in its identities.
 */
const OWNER_DECISION_KEY_PREFIX_V1 = "ownerPlanDecision:";

export function latestOwnerAnswerAtV1(
  decisions: readonly Pick<WorkflowDecisionV1, "decisionKey" | "state" | "resolvedAt" | "blockerIdentities">[],
  blockerDescription: string,
  lineageId?: string
): string | undefined {
  const text = blockerDescription.toLowerCase();
  let latest: string | undefined;
  for (const decision of decisions) {
    if (decision.state !== "resolved" || decision.resolvedAt === undefined) continue;
    if (!decision.decisionKey.startsWith(OWNER_DECISION_KEY_PREFIX_V1)) continue;
    const id = decision.decisionKey.slice(OWNER_DECISION_KEY_PREFIX_V1.length).toLowerCase();
    const named = id !== "" && text.includes(id);
    const byLineage = lineageId !== undefined && lineageId !== "" && (decision.blockerIdentities ?? []).some((identity) => identity.includes(lineageId));
    if (!named && !byLineage) continue;
    if (latest === undefined || decision.resolvedAt > latest) latest = decision.resolvedAt;
  }
  return latest;
}
