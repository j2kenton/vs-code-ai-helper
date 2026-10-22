import { RoundOutcomeEntryV1, TaskProgress, TaskStage } from "../types/taskProgress";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface CompletedRoundAttributionV1 {
  readonly modelId: string;
  readonly providerLabel?: string;
  readonly providerId?: string;
}

/** Read the actual provider identity already recorded for a completed stage. */
export function completedRoundAttributionV1(
  progress: Pick<TaskProgress, "reviewScoreHistory" | "roundOutcomes">,
  stage: TaskStage,
  attemptIds?: readonly string[]
): CompletedRoundAttributionV1 | undefined {
  const belongsToRound = (attemptId: string | undefined): boolean =>
    attemptIds === undefined || (attemptId !== undefined && attemptIds.includes(attemptId));
  if (stage.endsWith("review")) {
    const review = [...(progress.reviewScoreHistory ?? [])]
      .reverse()
      .find((entry) => entry.stage === stage && entry.reviewer?.storedModelId && belongsToRound(entry.attemptId));
    return review?.reviewer
      ? {
          modelId: review.reviewer.storedModelId,
          providerLabel: review.reviewer.providerLabel,
        }
      : undefined;
  }
  const outcome: RoundOutcomeEntryV1 | undefined = [...(progress.roundOutcomes ?? [])]
    .reverse()
    .find((entry) => entry.stage === stage && entry.modelId && belongsToRound(entry.attemptId));
  return outcome?.modelId
    ? {
        modelId: outcome.modelId,
        ...(outcome.providerId ? { providerId: outcome.providerId } : {}),
      }
    : undefined;
}

/**
 * Read backup provenance from the durable run log for this exact ledger
 * round. Chat history is intentionally compacted, so it cannot be the only
 * source for a completed stage row's primary-failure explanation.
 */
export async function readCompletedRoundFallbackReasonFromRunLogV1(
  runsDirectory: string,
  stage: TaskStage,
  roundId: string
): Promise<string | undefined> {
  try {
    const names = (await fs.readdir(runsDirectory))
      .filter((name) => /^\d+-/.test(name) && name.endsWith(`-${stage}.md`))
      .sort((left, right) => {
        const leftNumber = Number(/^([0-9]+)-/.exec(left)?.[1] ?? 0);
        const rightNumber = Number(/^([0-9]+)-/.exec(right)?.[1] ?? 0);
        return rightNumber - leftNumber;
      })
      .slice(0, 200);
    let isNewestStageLog = true;
    for (const name of names) {
      const content = await fs.readFile(path.join(runsDirectory, name), "utf8");
      const roundMarker = /^(?:Review round|Round ID): (.+)$/m.exec(content)?.[1];
      if (roundMarker !== undefined && roundMarker !== roundId) {
        isNewestStageLog = false;
        continue;
      }
      if (roundMarker === undefined && !isNewestStageLog) {
        continue;
      }
      // Older logs did not carry a round id. Their newest stage-specific
      // entry is the safe fallback for that latest stage row.
      const match = content.match(/^Backup used; primary was skipped or failed: ([^\r\n]{1,300})$/m);
      if (match?.[1]) {
        return match[1].trim();
      }
      if (stage === "impl") {
        const legacyCascadeNote = content.match(/^([^\r\n]{1,300}primary[^\r\n]{0,300})$/im);
        if (legacyCascadeNote?.[1] && /backup|fallback/i.test(legacyCascadeNote[1])) {
          return legacyCascadeNote[1].trim();
        }
      }
      return undefined;
    }
  } catch {
    // This is display-only enrichment. A missing/unreadable run log must not
    // prevent the stage tree from rendering its other recorded attribution.
  }
  return undefined;
}
