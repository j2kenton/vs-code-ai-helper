import { createHash } from "node:crypto";

import type { BlockerLineageDeclaration, TaskStage } from "../types/taskProgress";
import type { WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import { listPendingWorkflowDecisionsForTaskV1 } from "./workflowDecisionDispatchV1";

/**
 * review1 Step 37: one card per owner-only blocker. Several paths can raise a card for the same blocker (the
 * plateau card, the owner-decision card parsed from the review, the "every blocker needs you" Fast Forward stop,
 * the environmental notice). Each asks the same question with different options, which is how review1 item 3 got
 * two cards two seconds apart with different recommendations.
 *
 * The rule: the owner-decision card wins when the review wrote a decision block; otherwise the plateau card;
 * otherwise the Fast Forward stop card. Each poster calls the helper for the cards that outrank it and does not
 * post when one is already waiting for these blockers. Plateau and stop cards record which blockers they ask
 * about (`blockerIdentities`), so a card about one blocker never hides a different owner-only blocker.
 */
const OWNER_DECISION_KEY_PREFIX_V1 = "ownerPlanDecision:";
/** A plan-deviation card shares the owner-plan-decision key prefix but asks about the round, not a blocker. */
const PLAN_DEVIATION_KEY_PREFIX_V1 = `${OWNER_DECISION_KEY_PREFIX_V1}plan-deviation-`;

function isOwnerDecisionCardKeyV1(decisionKey: string): boolean {
  return decisionKey.startsWith(OWNER_DECISION_KEY_PREFIX_V1) && !decisionKey.startsWith(PLAN_DEVIATION_KEY_PREFIX_V1);
}
const OWNER_ONLY_KEY_PREFIX_V1 = "ownerOnlyBlockers:";
const PLATEAU_KEY_V1 = "reviewPlateauEscalation";

/**
 * The identity of one owner-only blocker: its lineage id when the review declared one (it survives rewording
 * across reviews), otherwise a hash of its normalised text.
 */
export function ownerBlockerIdentityV1(description: string, lineageId?: string): string {
  if (lineageId !== undefined && lineageId.trim() !== "") return `lineage:${lineageId.trim()}`;
  // The review history keeps the first 200 characters of a description, so a recorded blocker and the full text
  // it came from must hash alike.
  const normalised = description.slice(0, 200).toLowerCase().replace(/\s+/g, " ").trim();
  return `text:${createHash("sha256").update(normalised).digest("hex").slice(0, 16)}`;
}

/**
 * The identity of a parsed or recorded blocker: the stable lineage id the reviewer cited (`[same:<id>]` or
 * `[narrowed:<id>]`, carried forward unchanged across reviews), else a hash of its text.
 */
export function blockerOwnerIdentityV1(blocker: {
  readonly description?: string;
  readonly lineage?: BlockerLineageDeclaration;
}): string {
  const refId = blocker.lineage !== undefined && blocker.lineage.kind !== "new" ? blocker.lineage.refId : undefined;
  return ownerBlockerIdentityV1(blocker.description ?? "", refId);
}

function pendingForStageV1(canonicalId: string, stage: TaskStage): readonly WorkflowDecisionV1[] {
  return listPendingWorkflowDecisionsForTaskV1(canonicalId).filter(
    (decision) => decision.state === "pending" && decision.stage === stage
  );
}

/**
 * True when the pending owner-decision card(s) for `stage` ask about every one of `identities`. A card that
 * recorded no identities (older) covers the whole stage; with no `identities` given, any such card counts.
 */
function ownerDecisionCardsCoverV1(
  cards: readonly WorkflowDecisionV1[],
  identities: readonly string[] | undefined
): boolean {
  if (cards.length === 0) return false;
  if (identities === undefined || identities.length === 0) return true;
  if (cards.some((card) => card.blockerIdentities === undefined)) return true;
  const asked = new Set(cards.flatMap((card) => card.blockerIdentities ?? []));
  return identities.every((identity) => asked.has(identity));
}

/**
 * The owner-decision card (from the review's `## Owner decisions needed`) already waiting for `stage`. With
 * `identities`, it must ask about all of those blockers: a card about one blocker never hides another.
 */
export function hasPendingOwnerDecisionCardV1(
  canonicalId: string,
  stage: TaskStage,
  identities?: readonly string[]
): boolean {
  const cards = pendingForStageV1(canonicalId, stage).filter((d) => isOwnerDecisionCardKeyV1(d.decisionKey));
  return ownerDecisionCardsCoverV1(cards, identities);
}

/** True when `card` asks about every one of `identities`; a card that recorded none (older) covers the stage. */
function cardCoversIdentitiesV1(card: WorkflowDecisionV1, identities: readonly string[] | undefined): boolean {
  if (identities === undefined || identities.length === 0) return true;
  if (card.blockerIdentities === undefined) return true;
  const asked = new Set(card.blockerIdentities);
  return identities.every((identity) => asked.has(identity));
}

/**
 * The card that already asks the owner about this stage's owner-only blockers, if any: an owner-decision card
 * (the review wrote a decision block for this stage), else a plateau or Fast Forward stop card that asks about
 * all of `identities`. The Fast Forward stop card is only posted when this finds none.
 */
export function findCardCoveringOwnerOnlyBlockersV1(
  canonicalId: string,
  stage: TaskStage,
  identities?: readonly string[]
): WorkflowDecisionV1 | undefined {
  const pending = pendingForStageV1(canonicalId, stage);
  const ownerDecisionCards = pending.filter((d) => isOwnerDecisionCardKeyV1(d.decisionKey));
  return (
    (ownerDecisionCardsCoverV1(ownerDecisionCards, identities) ? ownerDecisionCards[0] : undefined) ??
    pending.find((d) => d.decisionKey === PLATEAU_KEY_V1 && cardCoversIdentitiesV1(d, identities)) ??
    pending.find((d) => d.decisionKey.startsWith(OWNER_ONLY_KEY_PREFIX_V1) && cardCoversIdentitiesV1(d, identities))
  );
}
