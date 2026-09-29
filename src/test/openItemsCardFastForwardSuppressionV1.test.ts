/**
 * RC2 item 13, Step 50 (implementation review blocker, narrowed:
 * `5fc689aa-dd9c-4112-996c-ae84585b1f58-1`): "under Fast Forward, suppress
 * its stalled warning for that round only" — but `fastForwardReviewWithAI`'s
 * own `improveReviewScore` loop (which produces the "stalled" outcome
 * synchronously) and `executeImplementationRun`'s zero-file "nothing more
 * to build" open-items card (raised from a detached, unawaited
 * `scheduleAutomaticImplementationAfterReview` dispatch) are two genuinely
 * independent call stacks with no promise or return value linking them.
 * `markOpenItemsCardPostedV1`/`consumeOpenItemsCardPostedSinceV1` are the
 * task-keyed, timestamped, in-memory correlation the fix relies on — this
 * covers that pure logic directly, since driving the full asynchronous
 * automation-chain dispatch end-to-end would not exercise anything this
 * logic does not already fully determine (see
 * `reviewScoreLoopStalledNotificationSource.test.ts` for the sibling
 * coverage of the rendered branch's wording, and the source's own
 * `consumeOpenItemsCardPostedSinceV1(resolved.folderUri.fsPath,
 * ffRunStartedAtV1)` call site in `fastForwardReviewWithAI`'s stalled
 * branch).
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  consumeOpenItemsCardPostedSinceV1,
  markOpenItemsCardPostedV1,
  openItemsCardPostedAtByTaskV1,
} from "../commands/reviewActions";

void describe("open-items card / Fast Forward stalled-warning correlation (RC2 item 13, Step 50)", () => {
  void it("suppresses (returns true, consumes) when the card was posted for this task during the run", () => {
    const taskFolderPath = "/tasks/t1";
    openItemsCardPostedAtByTaskV1.clear();
    const runStartedAt = Date.now();
    markOpenItemsCardPostedV1(taskFolderPath);

    assert.equal(consumeOpenItemsCardPostedSinceV1(taskFolderPath, runStartedAt), true);
    // Consumed: a second check for the same task must not suppress again.
    assert.equal(consumeOpenItemsCardPostedSinceV1(taskFolderPath, runStartedAt), false);
  });

  void it("does not suppress when nothing was posted for this task", () => {
    openItemsCardPostedAtByTaskV1.clear();
    assert.equal(consumeOpenItemsCardPostedSinceV1("/tasks/never-posted", Date.now()), false);
  });

  void it("does not suppress a stale marker left over from before this run started", () => {
    const taskFolderPath = "/tasks/t2";
    openItemsCardPostedAtByTaskV1.clear();
    markOpenItemsCardPostedV1(taskFolderPath);
    // Simulate a LATER, unrelated Fast Forward run starting after the stale
    // marker: its "since" timestamp is after the mark, so it must not
    // inherit a suppression that belongs to the earlier run.
    const laterRunStartedAt = Date.now() + 1000;
    assert.equal(consumeOpenItemsCardPostedSinceV1(taskFolderPath, laterRunStartedAt), false);
    // The stale marker is left untouched (never consumed by an unrelated run).
    assert.equal(openItemsCardPostedAtByTaskV1.has(taskFolderPath), true);
  });

  void it("does not cross-suppress a different task's stalled warning", () => {
    openItemsCardPostedAtByTaskV1.clear();
    const runStartedAt = Date.now();
    markOpenItemsCardPostedV1("/tasks/task-a");

    assert.equal(consumeOpenItemsCardPostedSinceV1("/tasks/task-b", runStartedAt), false);
  });
});
