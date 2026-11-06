/**
 * bugs4 Step 25 (item 22): the two progress signals a review round records so the
 * churn ceiling (`roundsWithoutTaskFixableDecrease`, reviewRouting.ts) can tell a
 * round that moved the plan forward from one that only re-found the same work.
 *
 * - `settledItemCount`: plan items the completeness gate counts as settled.
 * - `unbuiltStepCount`: distinct plan steps named by the round's task-fixable
 *   `[completion]` blockers. The grouped unbuilt-steps blocker stays a single blocker
 *   until the last step is built, so this number is the only way to see it narrow.
 */
import type { TaskProgress } from "../types/taskProgress";
import { computePlanItemCountsV1 } from "./effectiveReviewProgress";
import { listStepNumbersNamedInTextV1 } from "./implementationChecklist";

export interface ChurnProgressSignalsV1 {
  readonly settledItemCount?: number;
  readonly unbuiltStepCount?: number;
}

export function computeChurnProgressSignalsV1(input: {
  readonly planOfRecord: string | undefined;
  readonly planItemEvidence: TaskProgress["planItemEvidence"] | undefined;
  readonly planItemOwnerDecisions: TaskProgress["planItemOwnerDecisions"] | undefined;
  readonly blockers: readonly { readonly category: string; readonly resolver: string; readonly description: string }[];
}): ChurnProgressSignalsV1 {
  // review1 Step 5: the settled count is the shared counter's, not a private copy of the gate.
  const progress =
    input.planOfRecord === undefined
      ? undefined
      : computePlanItemCountsV1({
          planText: input.planOfRecord,
          progress: { planItemEvidence: input.planItemEvidence, planItemOwnerDecisions: input.planItemOwnerDecisions },
        });
  const named = new Set<number>();
  for (const blocker of input.blockers) {
    if (blocker.category === "completion" && blocker.resolver === "task-fixable") {
      for (const step of listStepNumbersNamedInTextV1(blocker.description).steps) {
        named.add(step);
      }
    }
  }
  return {
    ...(progress ? { settledItemCount: progress.settled } : {}),
    ...(named.size > 0 ? { unbuiltStepCount: named.size } : {}),
  };
}
