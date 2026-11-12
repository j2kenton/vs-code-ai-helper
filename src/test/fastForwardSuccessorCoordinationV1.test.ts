/**
 * bugs7 item 7 (Steps 19 and 21), owner decision 2026-11-11 (replacement): Fast Forward follows legitimate successor
 * progress through stage hand-offs, settles pending successor work before it runs on top of it, and reaches the final
 * Commit & Push boundary, which it never executes.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

import {
  fastForwardAcrossCleanStagesV1,
  fastForwardCrossingTargetV1,
  stageIsAtOrAfterV1,
  type StageEdgeFactsV1,
} from "../utils/fastForwardStageEdgeV1";
import type { TaskStage } from "../types/taskProgress";

function readSource(file: string): string {
  return fs.readFileSync(path.resolve(__dirname, "../../src/commands", file), "utf8");
}

void describe("Fast Forward follows legitimate successor progress and settles pending work", () => {
  /**
   * A small host model: a move-on (`advance`) lands on the next stage, and the successor review that move queues may
   * advance the task again, either before the command returns (awaited) or only once the wait has settled it
   * (deferred). A run's end is reported the way the host wrapper does it (the clean stage, to its own invocation).
   */
  function host(opts: { startStage: TaskStage; awaitedSuccessorMovesTo?: TaskStage; deferredSuccessorMovesTo?: TaskStage; settles?: boolean }) {
    const log: string[] = [];
    let stage: TaskStage = opts.startStage;
    let reported: TaskStage | undefined;
    let deferred: TaskStage | undefined;
    const deps = {
      runFastForward: () => {
        log.push(`ff:${stage}`);
        reported = stage;
        return Promise.resolve();
      },
      takeEligibleStage: () => {
        const value = reported;
        reported = undefined;
        return value;
      },
      readFacts: (): Promise<StageEdgeFactsV1> =>
        Promise.resolve({ active: true, taskStage: stage, reviewClean: true, gateComplete: true, hold: false }),
      advance: () => {
        stage = fastForwardCrossingTargetV1(stage) ?? stage;
        log.push(`advance:${stage}`);
        if (opts.awaitedSuccessorMovesTo !== undefined) stage = opts.awaitedSuccessorMovesTo;
        deferred = opts.deferredSuccessorMovesTo;
        return Promise.resolve();
      },
      waitUntilFree: () => {
        if (opts.settles === false) {
          log.push("wait:outstanding");
          return Promise.resolve(false);
        }
        if (deferred !== undefined) {
          stage = deferred;
          deferred = undefined;
          log.push(`successor-settled:${stage}`);
        }
        return Promise.resolve(true);
      },
      say: () => Promise.resolve(),
      stoppedAtCommitPushBoundary: (s: TaskStage) => {
        log.push(`boundary:${s}`);
        return Promise.resolve();
      },
    };
    return { deps, log };
  }

  void it("an awaited successor review that moved the task past the next stage is progress: Fast Forward carries on in Publish and reaches the boundary", async () => {
    const h = host({ startStage: "impl-high-review", awaitedSuccessorMovesTo: "publish" });
    const result = await fastForwardAcrossCleanStagesV1(h.deps);
    assert.deepEqual(h.log, ["ff:impl-high-review", "advance:impl-low-review", "ff:publish", "boundary:publish"]);
    assert.deepEqual(result.crossedInto, ["publish"]);
  });

  void it("a deferred successor review that runs after the departing run ended continues into Publish under the same invocation", async () => {
    const h = host({ startStage: "impl-high-review", deferredSuccessorMovesTo: "publish" });
    const result = await fastForwardAcrossCleanStagesV1(h.deps);
    assert.deepEqual(h.log, [
      "ff:impl-high-review",
      "advance:impl-low-review",
      "successor-settled:publish",
      "ff:publish",
      "boundary:publish",
    ]);
    assert.deepEqual(result.crossedInto, ["publish"]);
  });

  void it("pending successor work at the wait's limit hands back: no run starts on top of it", async () => {
    const h = host({ startStage: "impl-high-review", settles: false });
    const result = await fastForwardAcrossCleanStagesV1(h.deps);
    assert.deepEqual(h.log, ["ff:impl-high-review", "advance:impl-low-review", "wait:outstanding"]);
    assert.equal(result.crossings, 0);
  });

  void it("a task that ended up before the move's target is not carried on, and nothing reaches the boundary", async () => {
    const h = host({ startStage: "impl-low-review", awaitedSuccessorMovesTo: "impl-high-review" });
    const result = await fastForwardAcrossCleanStagesV1(h.deps);
    assert.equal(result.crossings, 0);
    assert.ok(!h.log.includes("ff:impl-high-review"));
    assert.ok(!h.log.some((line) => line.startsWith("boundary")));
  });

  void it("stage order: a stage is at or after itself and the later ones, never an earlier one", () => {
    assert.equal(stageIsAtOrAfterV1("impl-low-review", "impl-low-review"), true);
    assert.equal(stageIsAtOrAfterV1("publish", "impl-low-review"), true);
    assert.equal(stageIsAtOrAfterV1("impl-high-review", "impl-low-review"), false);
  });

  void it("after a Publish fix round the queued Publish review is waited for; if it is still pending, Fast Forward hands back", async () => {
    for (const settles of [true, false]) {
      const log: string[] = [];
      let failed = true;
      let reported: TaskStage | undefined;
      await fastForwardAcrossCleanStagesV1({
        runFastForward: () => {
          log.push("ff");
          reported = failed ? undefined : "publish";
          return Promise.resolve();
        },
        takeEligibleStage: () => {
          const value = reported;
          reported = undefined;
          return value;
        },
        takePublishChecksFailed: () => {
          const value = failed;
          failed = false;
          return value;
        },
        runPublishFixRound: () => {
          log.push("fix");
          return Promise.resolve(true);
        },
        readFacts: (stage): Promise<StageEdgeFactsV1> =>
          Promise.resolve({ active: true, taskStage: stage, reviewClean: true, gateComplete: true, hold: false }),
        advance: () => Promise.resolve(),
        waitUntilFree: () => {
          log.push(`wait:${settles}`);
          return Promise.resolve(settles);
        },
        say: () => Promise.resolve(),
        stoppedAtCommitPushBoundary: () => {
          log.push("boundary");
          return Promise.resolve();
        },
      });
      assert.deepEqual(log, settles ? ["ff", "fix", "wait:true", "ff", "boundary"] : ["ff", "fix", "wait:false"], String(settles));
    }
  });

  void it("a fix round that finished while the task was paused or moved off Publish carries on nowhere", async () => {
    for (const facts of [{ active: false }, { taskStage: "impl-low-review" as TaskStage }]) {
      let runs = 0;
      let failed = true;
      await fastForwardAcrossCleanStagesV1({
        runFastForward: () => {
          runs += 1;
          return Promise.resolve();
        },
        takeEligibleStage: () => undefined,
        takePublishChecksFailed: () => {
          const value = failed;
          failed = false;
          return value;
        },
        runPublishFixRound: () => Promise.resolve(true),
        readFacts: (stage): Promise<StageEdgeFactsV1> =>
          // The first read (before the fix round) is healthy; the one after it carries the change.
          Promise.resolve({ active: true, taskStage: stage, reviewClean: true, gateComplete: true, hold: false, ...(runs === 1 && !failed ? facts : {}) }),
        advance: () => Promise.resolve(),
        waitUntilFree: () => Promise.resolve(true),
        say: () => Promise.resolve(),
      });
      assert.equal(runs, 1, JSON.stringify(facts));
    }
  });
});

void describe("the host wrapper's end reports and waits (source)", () => {
  void it("an already-clean Publish review reports its end to the invocation, so the Commit & Push boundary is reachable", () => {
    const source = readSource("reviewActions.ts");
    const at = source.indexOf('ending: "publish-clean"');
    assert.ok(at > 0);
    const branch = source.slice(at, source.indexOf("return;", at) + 10);
    assert.match(branch, /endReport\?\.\(\{ folderPath: resolved\.folderUri\.fsPath, stage: targetStage, movedOn: false \}\)/);
    assert.match(branch, /isCancellationRequested !== true/);
  });

  void it("the wait reports unsettled work instead of returning silently at its limit", () => {
    const source = readSource("reviewActions.ts");
    const host = source.slice(source.indexOf("async function fastForwardAcrossCleanStagesHostV1("));
    const body = host.slice(0, host.indexOf("export async function fastForwardReviewWithAI("));
    assert.match(body, /!taskOperations\.hasRootOperationForTask\(folderPath\) && !successorWorkPendingV1\(folderPath\)/);
  });

  void it("the Publish review a fix round queues is a successor chain the wait honours", () => {
    const source = readSource("reviewActions.ts");
    const start = source.indexOf("const SUCCESSOR_CHAIN_IDS_V1 = [");
    const list = source.slice(start, source.indexOf("] as const;", start));
    assert.match(list, /"publish-review-after-fix"/);
    assert.match(readSource("runLintingFixes.ts"), /chainId: "publish-review-after-fix"/);
  });
});
