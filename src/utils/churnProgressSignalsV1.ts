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
import { countChecklistEvidenceProgressV1, listStepNumbersNamedInTextV1 } from "./implementationChecklist";

export interface ChurnProgressSignalsV1 {
  readonly settledItemCount?: number;
  readonly unbuiltStepCount?: number;
}

export function computeChurnProgressSignalsV1(input: {
  readonly planOfRecord: string | undefined;
  readonly planItemEvidence: Parameters<typeof countChecklistEvidenceProgressV1>[1] | undefined;
  readonly planItemOwnerDecisions: Parameters<typeof countChecklistEvidenceProgressV1>[2] | undefined;
  readonly blockers: readonly { readonly category: string; readonly resolver: string; readonly description: string }[];
}): ChurnProgressSignalsV1 {
  const progress =
    input.planOfRecord === undefined
      ? undefined
      : countChecklistEvidenceProgressV1(
          input.planOfRecord,
          input.planItemEvidence ?? [],
          input.planItemOwnerDecisions ?? []
        );
  const named = new Set<number>();
  for (const blocker of input.blockers) {
    if (blocker.category === "completion" && blocker.resolver === "task-fixable") {
      for (const step of listStepNumbersNamedInTextV1(blocker.description).steps) {
        named.add(step);
      }
    }
  }
  return {
    ...(progress ? { settledItemCount: progress.gate.settled } : {}),
    ...(named.size > 0 ? { unbuiltStepCount: named.size } : {}),
  };
}
