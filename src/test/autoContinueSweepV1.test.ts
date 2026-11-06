/**
 * review1 Steps 53 and 55: the sweep that runs a safe card's recommended option when its countdown ends with no
 * answer, and the rule that only options flagged `unattendedSafe` ever do.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildAutomationStoppedCardInputV1, type AutomationStopFactsV1 } from "../utils/automationStopV1";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import {
  WAIT_FOR_ME_OPTION_ID_V1,
  describeAutoContinueScheduleV1,
  planAutoContinueV1,
  withWaitForMeOptionV1,
} from "../utils/autoContinueV1";
import { runAutoContinueSweepV1, type AutoContinueSweepDepsV1 } from "../utils/autoContinueSweepV1";
import type { WorkflowDecisionOptionV1, WorkflowDecisionV1 } from "../types/workflowDecisionV1";

const T0 = Date.parse("2026-11-04T21:39:00.000Z");
const FOLDER = "/ws/.ensemble/task-x";

const TICKS_OPTION: WorkflowDecisionOptionV1 = {
  optionId: "apply",
  label: "Apply the 9 ticks now",
  consequence: "Ticks the items.",
  resumeKind: "continue",
  unattendedSafe: true,
  effect: { kind: "command", command: "vs-code-ai-helper.applyReviewerVerifiedTicksConfirmed" },
};

function armedCard(overrides: Partial<WorkflowDecisionV1> = {}): WorkflowDecisionV1 {
  const base = {
    decisionId: "d1",
    decisionKey: "reviewerVerifiedTicks",
    taskCanonicalId: FOLDER,
    stage: "impl-high-review",
    state: "pending",
    options: withWaitForMeOptionV1([TICKS_OPTION]),
    recommendation: { kind: "option", optionId: "apply", reasoning: "safe" },
    autoContinue: { optionId: "apply", minutes: 15, deadline: new Date(T0 + 15 * 60_000).toISOString(), armedProgressVersion: 4, armedRoundCount: 7 },
  };
  return { ...base, ...overrides } as unknown as WorkflowDecisionV1;
}

interface Recorder {
  readonly deps: AutoContinueSweepDepsV1;
  readonly runs: string[];
  readonly said: string[];
  readonly cancelled: string[];
  readonly reoffered: string[];
}

function recorder(
  cards: WorkflowDecisionV1[],
  nowMs: number,
  extra: {
    state?: { progressVersion?: number; roundCount?: number };
    admit?: boolean;
    busy?: boolean;
    ok?: boolean;
    reoffer?: boolean;
  } = {}
): Recorder {
  const runs: string[] = [];
  const said: string[] = [];
  const cancelled: string[] = [];
  const reoffered: string[] = [];
  return {
    runs,
    said,
    cancelled,
    reoffered,
    deps: {
      listArmed: () => cards,
      readTaskState: () => Promise.resolve(extra.state ?? { progressVersion: 4, roundCount: 7 }),
      cancel: (id, reason) => {
        cancelled.push(`${id}:${reason}`);
        return Promise.resolve();
      },
      admit: () => Promise.resolve(extra.admit ?? true),
      taskIsBusy: () => extra.busy ?? false,
      run: (id, optionId) => {
        runs.push(`${id}:${optionId}`);
        return Promise.resolve({ ok: extra.ok ?? true });
      },
      say: (_id, text) => {
        said.push(text);
        return Promise.resolve();
      },
      reoffer: (decision) => {
        reoffered.push(decision.decisionId);
        return Promise.resolve(extra.reoffer ?? false);
      },
      now: () => nowMs,
    },
  };
}

void describe("review1 Step 53: the auto-continue sweep", () => {
  void it("runs the recommended option after the wait and records the chat line (the 21:39 card)", async () => {
    const r = recorder([armedCard()], T0 + 15 * 60_000 + 1);
    const result = await runAutoContinueSweepV1(r.deps);
    assert.deepEqual(r.runs, ["d1:apply"]);
    assert.deepEqual(result.ran, ["d1"]);
    assert.deepEqual(r.said, ["Continued automatically with ‘Apply the 9 ticks now’ after 15 min (no answer)."]);
  });

  void it("does nothing before the deadline", async () => {
    const r = recorder([armedCard()], T0 + 14 * 60_000);
    await runAutoContinueSweepV1(r.deps);
    assert.deepEqual(r.runs, []);
    assert.deepEqual(r.cancelled, []);
  });

  void it("a task that changed while the card waited cancels the countdown and runs nothing", async () => {
    for (const state of [{ progressVersion: 5, roundCount: 7 }, { progressVersion: 4, roundCount: 8 }]) {
      const r = recorder([armedCard()], T0 + 20 * 60_000, { state });
      const result = await runAutoContinueSweepV1(r.deps);
      assert.deepEqual(r.runs, []);
      assert.deepEqual(result.cancelled, ["d1"]);
      assert.match(r.cancelled[0] ?? "", /^d1:/);
      assert.match(r.said[0] ?? "", /still open; choose when you are ready/);
    }
  });

  void it("a task that changed while the card waited re-offers the card; the stale one gets no 'choose when ready' line", async () => {
    const r = recorder([armedCard()], T0 + 20 * 60_000, { state: { progressVersion: 5, roundCount: 7 }, reoffer: true });
    const result = await runAutoContinueSweepV1(r.deps);
    assert.deepEqual(r.runs, []);
    assert.deepEqual(r.reoffered, ["d1"]);
    assert.deepEqual(result.cancelled, ["d1"]);
    assert.deepEqual(r.said, []);
  });

  void it("only a changed task is re-offered: a gate refusal or an option that is no longer safe is not", async () => {
    const refused = recorder([armedCard()], T0 + 20 * 60_000, { admit: false, reoffer: true });
    await runAutoContinueSweepV1(refused.deps);
    assert.deepEqual(refused.reoffered, []);
    const unsafe = armedCard({ options: [] } as Partial<WorkflowDecisionV1>);
    const notSafe = recorder([unsafe], T0 + 20 * 60_000, { reoffer: true });
    await runAutoContinueSweepV1(notSafe.deps);
    assert.deepEqual(notSafe.reoffered, []);
  });

  void it("an answered card is not in the armed list, and a stopped countdown is left alone", async () => {
    const stopped = armedCard({
      autoContinue: { optionId: "apply", minutes: 15, deadline: new Date(T0).toISOString(), cancelledAt: new Date(T0).toISOString(), cancelledReason: "you pressed Wait for me" },
    });
    const resolved = armedCard({ state: "resolved" } as Partial<WorkflowDecisionV1>);
    const r = recorder([stopped, resolved], T0 + 60 * 60_000);
    await runAutoContinueSweepV1(r.deps);
    assert.deepEqual(r.runs, []);
  });

  void it("a gate refusal does not run the option and stops the countdown", async () => {
    const r = recorder([armedCard()], T0 + 20 * 60_000, { admit: false });
    const result = await runAutoContinueSweepV1(r.deps);
    assert.deepEqual(r.runs, []);
    assert.deepEqual(result.refused, ["d1"]);
    assert.match(r.cancelled[0] ?? "", /is this working/);
  });

  void it("waits for the next pass while a round is running on the task", async () => {
    const r = recorder([armedCard()], T0 + 20 * 60_000, { busy: true });
    await runAutoContinueSweepV1(r.deps);
    assert.deepEqual(r.runs, []);
    assert.deepEqual(r.cancelled, []);
  });

  void it("an option that could not be run is not retried on every pass", async () => {
    const r = recorder([armedCard()], T0 + 20 * 60_000, { ok: false });
    const result = await runAutoContinueSweepV1(r.deps);
    assert.deepEqual(result.ran, []);
    assert.deepEqual(result.cancelled, ["d1"]);
  });
});

void describe("review1 Step 53: only safe options carry a countdown", () => {
  const card = (options: WorkflowDecisionOptionV1[], recommended: string) => ({
    options,
    recommendation: { kind: "option" as const, optionId: recommended, reasoning: "r" },
    state: "pending" as const,
  });

  void it("plans a countdown for the safe option and adds Wait for me", () => {
    const plan = planAutoContinueV1(card([TICKS_OPTION], "apply"), 15, T0, { progressVersion: 4, roundCount: 7 });
    assert.equal(plan?.optionId, "apply");
    assert.equal(plan?.minutes, 15);
    assert.match(describeAutoContinueScheduleV1(plan, TICKS_OPTION.label), /Continues with ‘Apply the 9 ticks now’ in 15 min \(at \d\d:\d\d\) unless you choose otherwise/);
    assert.ok(withWaitForMeOptionV1([TICKS_OPTION]).some((o) => o.optionId === WAIT_FOR_ME_OPTION_ID_V1));
  });

  void it("never plans one for an option that is not flagged (Commit & Push, Publish Anyway, exclusions)", () => {
    const commit: WorkflowDecisionOptionV1 = {
      optionId: "commitAndPush",
      label: "Commit & Push",
      consequence: "Commits.",
      resumeKind: "continue",
      effect: { kind: "command", command: "vs-code-ai-helper.commitAndPush" },
    };
    assert.equal(planAutoContinueV1(card([commit], "commitAndPush"), 15, T0, {}), undefined);
    // A destructive option is refused even if someone flagged it.
    assert.equal(
      planAutoContinueV1(card([{ ...commit, destructive: true, unattendedSafe: true }], "commitAndPush"), 15, T0, {}),
      undefined
    );
  });

  void it("only the reviewer-verified ticks option and Move on to a review set the flag in the product code", () => {
    const srcRoot = nodePath.resolve(__dirname, "..", "..", "src");
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of nodeFs.readdirSync(dir, { withFileTypes: true })) {
        const full = nodePath.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "test") walk(full);
        } else if (entry.name.endsWith(".ts") && /unattendedSafe:\s*true/.test(nodeFs.readFileSync(full, "utf8"))) {
          found.push(nodePath.relative(srcRoot, full).replace(/\\/g, "/"));
        }
      }
    };
    walk(srcRoot);
    assert.deepEqual(found.sort(), ["commands/applyReviewerVerifiedTicks.ts", "utils/automationStopV1.ts"]);
  });

  void it("is off when the setting is 0", () => {
    assert.equal(planAutoContinueV1(card([TICKS_OPTION], "apply"), 0, T0, {}), undefined);
  });

  void it("Move on after a clean review is flagged safe only when the next stage is a review", () => {
    const base: AutomationStopFactsV1 = {
      taskFolderPath: FOLDER,
      stage: "impl-high-review",
      ending: "stage-ready",
      stopReason: "every plan item is settled and the review is clean",
      score: 9,
      blockers: { fixFirst: 0, buildToClear: 0, notThisRound: 0 },
      planItems: { total: 10, settled: 10, open: 0, provisional: 0 },
      buildNext: [],
      dismissedDependencies: [],
      reviewClean: true,
      gateComplete: true,
      fastForwardWasRunning: false,
    };
    const toReview = buildAutomationStoppedCardInputV1(base).options.find((o) => o.optionId === "moveOn");
    assert.equal(toReview?.unattendedSafe, true);
    const toPublish = buildAutomationStoppedCardInputV1({ ...base, stage: "impl-low-review" }).options.find(
      (o) => o.optionId === "moveOn"
    );
    assert.notEqual(toPublish?.unattendedSafe, true, "moving on to Publish stays the owner's call");
  });
});
