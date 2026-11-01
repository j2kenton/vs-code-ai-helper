/**
 * bugs4 Step 13 (item 43): what to recommend after an Implementation round changed no files
 * while the plan still has unticked items.
 *
 * "Run Review" is right when the round found nothing to build. When the round itself reported
 * open items as "not reached", there is buildable work left and a review of an unchanged tree
 * cannot build it: the useful next step is another Implementation round, on a stronger model
 * when the round ran on a small or fast tier.
 *
 * Pure so the decision and wording are testable without the extension host.
 */
import {
  collectPlanItemReasonsV1,
  listUnsettledPlanItemsV1,
  normalizeChecklistItemTextV1,
} from "./implementationChecklist";

/** A round's own status for an item it did not build, as opposed to deferred/blocked/refused. */
const NOT_REACHED_STATUS_V1 = /^(?:not[ \t]+(?:reached|started|done|built|attempted)|unreached|todo)\b/i;

/** Model ids that name a small or fast tier; those rounds can stop early on a long plan. */
const SMALL_OR_FAST_TIER_V1 = /(?:haiku|mini|nano|flash|lite|fast|small|turbo|instant)/i;

export function isSmallOrFastTierModelV1(modelId: string | undefined): boolean {
  return modelId !== undefined && SMALL_OR_FAST_TIER_V1.test(modelId);
}

/**
 * Open plan items (unticked, not excluded) that the round's own `## Plan Item Checklist` reported
 * as not reached. Items the round called deferred, blocked or refused are not buildable work, and
 * an item the round never mentioned is "not reached" only in the card's sense, not the round's.
 */
export function findNotReachedOpenItemsV1(roundSummary: string, planOfRecord: string): readonly string[] {
  const open = listUnsettledPlanItemsV1(planOfRecord);
  const keys = new Set(open.map((item) => normalizeChecklistItemTextV1(item.text)));
  const notReached = new Set(
    collectPlanItemReasonsV1(roundSummary, keys)
      .filter((entry) => NOT_REACHED_STATUS_V1.test(entry.status.trim()))
      .map((entry) => normalizeChecklistItemTextV1(entry.itemText))
  );
  return open.filter((item) => notReached.has(normalizeChecklistItemTextV1(item.text))).map((item) => item.text);
}

export interface NotReachedRetryNoticeInputV1 {
  readonly notReachedCount: number;
  /** Display label of the model that ran the empty round, when known. */
  readonly modelLabel?: string;
  readonly modelId?: string;
}

export interface NotReachedRetryNoticeV1 {
  readonly warning: string;
  readonly noticeText: string;
  readonly actionLabel: "Run Implementation";
  readonly suggestStrongerModel: boolean;
}

export function buildNotReachedRetryNoticeV1(input: NotReachedRetryNoticeInputV1): NotReachedRetryNoticeV1 {
  const suggestStrongerModel = isSmallOrFastTierModelV1(input.modelId ?? input.modelLabel);
  const count = `${input.notReachedCount} plan item(s)`;
  const modelNote = suggestStrongerModel
    ? ` That round ran on ${input.modelLabel ?? "a small or fast model"}, which can stop before a long plan is done; ` +
      "consider choosing a stronger Implementation model in AI Models before you retry."
    : "";
  const warning =
    `Implementation finished with no file changes, but its own report lists ${count} as not reached. ` +
    `A review of an unchanged tree cannot build them; run Implementation again.${modelNote}`;
  return {
    warning,
    noticeText: warning,
    actionLabel: "Run Implementation",
    suggestStrongerModel,
  };
}
