/**
 * bugs5 Step 21: bugs4's first 40 High-Level Code Review rounds (2026-10-31 23:37 UTC to 2026-11-01 13:42 UTC).
 *
 * Copied from the `impl-high-review` entries of `.ensemble/2026-10-28_task_1/task-progress.json`
 * `reviewScoreHistory`: score, time and `taskFixableCount` are verbatim. Blocker text and lineage tags are
 * not reproduced (the churn ceiling no longer reads them). `settledItemCount` and `unbuiltStepCount` were
 * absent from every real entry, so they are absent here.
 */
import type { ReviewScoreHistoryEntry } from "../../types/taskProgress";

/** [score, at, taskFixableCount] for each of the 40 rounds, in order. */
export const BUGS4_HIGH_LEVEL_ROUNDS_V1: ReadonlyArray<readonly [number, string, number]> = [
  [5, "2026-10-31T23:37:05.557Z", 2],
  [6, "2026-11-01T00:04:45.928Z", 2],
  [6, "2026-11-01T00:24:51.976Z", 1],
  [6, "2026-11-01T00:41:08.857Z", 1],
  [6, "2026-11-01T00:54:03.214Z", 1],
  [6, "2026-11-01T01:17:17.720Z", 1],
  [5, "2026-11-01T01:36:49.478Z", 2],
  [6, "2026-11-01T01:54:42.115Z", 1],
  [6, "2026-11-01T02:15:03.622Z", 2],
  [6, "2026-11-01T02:54:47.815Z", 1],
  [6, "2026-11-01T03:12:26.285Z", 3],
  [7, "2026-11-01T03:27:11.361Z", 1],
  [7, "2026-11-01T03:40:23.794Z", 1],
  [7, "2026-11-01T03:52:13.169Z", 1],
  [7, "2026-11-01T04:06:00.718Z", 1],
  [7, "2026-11-01T04:22:10.925Z", 1],
  [7, "2026-11-01T04:46:34.732Z", 2],
  [7, "2026-11-01T05:10:49.533Z", 1],
  [6, "2026-11-01T05:27:03.986Z", 2],
  [7, "2026-11-01T05:41:17.186Z", 1],
  [7, "2026-11-01T06:03:38.095Z", 1],
  [7, "2026-11-01T06:20:52.979Z", 1],
  [7, "2026-11-01T06:33:39.325Z", 1],
  [7, "2026-11-01T06:59:57.029Z", 2],
  [7, "2026-11-01T07:28:34.144Z", 3],
  [7, "2026-11-01T08:27:38.016Z", 2],
  [7, "2026-11-01T09:05:24.345Z", 1],
  [6, "2026-11-01T09:20:59.083Z", 2],
  [7, "2026-11-01T09:41:57.995Z", 1],
  [6, "2026-11-01T09:59:47.976Z", 2],
  [7, "2026-11-01T10:26:23.336Z", 2],
  [7, "2026-11-01T10:50:32.707Z", 2],
  [7, "2026-11-01T11:10:40.546Z", 1],
  [6, "2026-11-01T11:35:16.195Z", 2],
  [7, "2026-11-01T11:50:02.941Z", 1],
  [7, "2026-11-01T12:22:48.549Z", 1],
  [7, "2026-11-01T12:42:47.780Z", 1],
  [6, "2026-11-01T13:02:20.876Z", 2],
  [6, "2026-11-01T13:21:50.184Z", 2],
  [6, "2026-11-01T13:42:31.788Z", 1],
];

export const BUGS4_HIGH_LEVEL_SCORES_V1: readonly number[] = BUGS4_HIGH_LEVEL_ROUNDS_V1.map(([score]) => score);

export const BUGS4_HIGH_LEVEL_TASK_FIXABLE_COUNTS_V1: readonly number[] = BUGS4_HIGH_LEVEL_ROUNDS_V1.map(
  ([, , count]) => count
);

/** Index (0-based) of the first 7/10, the last time the best score rose. */
export const BUGS4_LAST_BEST_SCORE_RISE_INDEX_V1 = 11;

/** `narrowedGroupedBlocker` adds the `[narrowed:…]` lineage tag the real entries carried on most rounds. */
export function buildBugs4HighLevelReviewHistoryV1(
  options: { narrowedGroupedBlocker?: boolean } = {}
): ReviewScoreHistoryEntry[] {
  return BUGS4_HIGH_LEVEL_ROUNDS_V1.map(([score, at, taskFixableCount], index) => {
    const entry: Record<string, unknown> = {
      stage: "impl-high-review",
      score,
      attemptId: `bugs4-high-${index + 1}`,
      at,
      blockerCount: taskFixableCount + 1,
      taskFixableCount,
      blockers: options.narrowedGroupedBlocker
        ? [
            {
              id: `unbuilt-items-${index}`,
              category: "completion",
              resolver: "task-fixable",
              subject: "unbuilt/partial plan items",
              lineage: index === 0 ? { kind: "new" } : { kind: "narrowed", refId: `unbuilt-items-${index - 1}` },
            },
          ]
        : [],
    };
    return entry as unknown as ReviewScoreHistoryEntry;
  });
}
