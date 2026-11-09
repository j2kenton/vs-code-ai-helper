/**
 * review1 Steps 23-28: the one "is this working?" measure and the gate in front of every automatic dispatch.
 * Replays bugs6 item 7 (one enabled model, two cut-offs, then 429s every 20 seconds) and review1 item 4.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import { buildThisIsntMovingCardInputV1 } from "../commands/automaticDispatchGateV1";
import * as vscode from "vscode";
import { dispatchDegenerateReviewBackupAdvanceV1 } from "../commands/reviewActions";
import { installOwnerOriginCommandRegistrationV1 } from "../state/ownerCommandRegistrationV1";
import {
  hasOwnerOriginV1,
  hasPassedAutomaticGateV1,
  runWithAdmittedAutomaticDispatchV1,
  runWithAutomaticOriginV1,
  runWithOwnerOriginV1,
} from "../state/automationDispatchContextV1";
import { evaluateProgressWatchV1, registerAutomaticGateLimitsProviderV1 } from "../state/progressWatchGateV1";
import { acquireWorkAdmissionV1, AutomaticDispatchRefusedErrorV1 } from "../state/workAdmissionV1";
import { RESILIENCE_DEFAULTS } from "../config/settings";
import type { ReviewScoreHistoryEntry, RoundLedgerEntryV1, TaskProgress } from "../types/taskProgress";
import { scheduleAutomationChain, releaseAutomationChain } from "../utils/automationChain";
import { isReviewDispatchAgainstUnchangedTreeV1 } from "../utils/reviewReadiness";
import {
  classifyRoundEndingV1,
  describeRoundEndingsV1,
  endingsAreRepeatedProviderFailuresV1,
  recordOwnerActionInWatchV1,
  recordRoundEndedInWatchV1,
} from "../utils/taskProgressWatchV1";
import { writeOwnershipBackedTaskProgress } from "./taskFolderFixture";
import { safeRemoveDir } from "./testFsUtils";

const LIMITS = { askOwnerAfterRounds: RESILIENCE_DEFAULTS.askOwnerAfterRounds, askOwnerAfterFailedRounds: RESILIENCE_DEFAULTS.askOwnerAfterFailedRounds };
const MODEL = "antigravity-cli:gemini-3.8-flash-high";
const T0 = Date.parse("2026-11-02T10:00:00.000Z");
const at = (minutes: number): Date => new Date(T0 + minutes * 60_000);

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-progress-watch-test-"));
after(() => {
  registerAutomaticGateLimitsProviderV1(undefined);
  safeRemoveDir(TEST_ROOT);
});

function baseProgress(extra: Partial<TaskProgress> = {}): TaskProgress {
  return {
    taskFolder: "t",
    currentStage: "impl-high-review",
    status: "active",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...extra,
  } as TaskProgress;
}

function ledgerRow(id: string, state: RoundLedgerEntryV1["state"], reason?: string): Pick<RoundLedgerEntryV1, "roundId" | "stage" | "state" | "outcome"> {
  return { roundId: id, stage: "impl-high-review", state, ...(reason !== undefined ? { outcome: { rejectionReason: reason } } : {}) };
}

function reviewEntry(minutes: number, over: Partial<ReviewScoreHistoryEntry>): ReviewScoreHistoryEntry {
  return {
    stage: "impl-high-review",
    score: 6,
    at: at(minutes).toISOString(),
    blockerCount: 3,
    taskFixableCount: 3,
    ...over,
  } as ReviewScoreHistoryEntry;
}

void describe("classifying a round ending", () => {
  void it("tells a time limit, a quota (with its reset), a refusal and a provider error apart", () => {
    assert.equal(classifyRoundEndingV1("failed", "Antigravity turn limit: cut off after 55 minutes", at(0)).kind, "cut-off");
    const quota = classifyRoundEndingV1("failed", "Individual quota reached (HTTP 429). Resets in 54m14s", at(0));
    assert.equal(quota.kind, "quota");
    assert.ok(quota.quotaResetAt !== undefined, "the reset time is read from the failure text");
    assert.equal(classifyRoundEndingV1("failed", "The provider refused the test command", at(0)).kind, "refused");
    assert.equal(classifyRoundEndingV1("failed", "something odd", at(0)).kind, "provider-error");
    assert.equal(classifyRoundEndingV1("completed", undefined, at(0)).kind, "completed");
    assert.equal(classifyRoundEndingV1("cancelled", undefined, at(0)).kind, "cancelled");
  });
});

void describe("replay of bugs6 item 7: one enabled model, two cut-offs, then 429s", () => {
  void it("stops after the third failed round in a row, with the endings grouped and the reset time named", () => {
    let progress = baseProgress();
    const results: boolean[] = [];
    const reasons = [
      "Antigravity turn limit: cut off after 55 minutes",
      "Antigravity turn limit: cut off after 55 minutes",
      "Individual quota reached (HTTP 429). Resets in 54m14s",
      "Individual quota reached (HTTP 429). Resets in 54m14s",
      "Individual quota reached (HTTP 429). Resets in 54m14s",
    ];
    reasons.forEach((reason, index) => {
      progress = recordRoundEndedInWatchV1(progress, ledgerRow(`r${index}`, "failed", reason), {
        automatic: true, model: MODEL, now: at(10 + index),
      });
      results.push(evaluateProgressWatchV1(progress.progressWatch, LIMITS).trip);
    });
    assert.deepEqual(results, [false, false, true, true, true], "the gate trips on the third failed automatic round in a row");
    const summary = describeRoundEndingsV1(progress.progressWatch!.endings);
    assert.match(summary, /2 cut off/);
    assert.match(summary, /3 quota reached, resets \d\d:\d\d/);
    assert.ok(endingsAreRepeatedProviderFailuresV1(progress.progressWatch!.endings));
  });

  void it("the card lists the cut-offs and the reset, recommends Change models only when another model is enabled", () => {
    let progress = baseProgress();
    for (let i = 0; i < 3; i++) {
      progress = recordRoundEndedInWatchV1(progress, ledgerRow(`r${i}`, "failed", i < 1 ? "cut off after 55 minutes" : "quota reached. Resets in 54m"), {
        automatic: true, model: MODEL, now: at(20 + i),
      });
    }
    const common = { taskFolderPath: path.join(TEST_ROOT, "task"), stage: "impl-high-review" as const, watch: progress.progressWatch!, reason: "failed" as const, now: at(40) };
    const onlyModel = buildThisIsntMovingCardInputV1({ ...common, chainModels: [MODEL] });
    assert.match(onlyModel.whatHappened, /1 cut off, 2 quota reached/);
    assert.match(onlyModel.whatHappened, new RegExp(MODEL.replace(/[.]/g, "\\.")));
    assert.equal(onlyModel.recommendation.kind, "none", "with one enabled model there is nothing better to recommend over the owner's judgement");
    assert.deepEqual(onlyModel.options.map((o) => o.optionId), ["keepGoing", "changeModels", "leaveWithMe", "tellStageAi", "notNow"]);
    const tell = onlyModel.options.find((o) => o.optionId === "tellStageAi")!;
    assert.equal(tell.effect.kind === "command" && tell.effect.command, "vs-code-ai-helper.progressWatchTellStageAiV1", "free text to the stage AI");
    const withBackup = buildThisIsntMovingCardInputV1({ ...common, chainModels: [MODEL, "claude-cli:claude-sonnet-5-5"] });
    assert.deepEqual(withBackup.recommendation, { kind: "option", optionId: "changeModels", reasoning: withBackup.recommendation.reasoning });
  });
});

void describe("rounds that succeed but change nothing", () => {
  void it("trip after N automatic rounds since the last progress", () => {
    let progress = baseProgress({ reviewScoreHistory: [reviewEntry(0, { settledItemCount: 100, score: 6 })] });
    const trips: boolean[] = [];
    for (let i = 0; i < 8; i++) {
      progress = recordRoundEndedInWatchV1(progress, ledgerRow(`r${i}`, "completed"), { automatic: true, model: MODEL, now: at(1 + i) });
      trips.push(evaluateProgressWatchV1(progress.progressWatch, LIMITS).trip);
    }
    assert.deepEqual(trips, [false, false, false, false, false, false, false, true], "the 8th round without progress trips the default limit");
    assert.equal(evaluateProgressWatchV1(progress.progressWatch, LIMITS).trip && (evaluateProgressWatchV1(progress.progressWatch, LIMITS) as { reason: string }).reason, "rounds");
  });

  void it("never trips while every round settles another plan item, however long it runs", () => {
    let progress = baseProgress();
    for (let i = 0; i < 40; i++) {
      progress = {
        ...progress,
        reviewScoreHistory: [...(progress.reviewScoreHistory ?? []), reviewEntry(i, { settledItemCount: 50 + i, taskFixableCount: 3, score: 6 })],
      };
      progress = recordRoundEndedInWatchV1(progress, ledgerRow(`r${i}`, "completed"), { automatic: true, model: MODEL, now: at(i) });
      assert.equal(evaluateProgressWatchV1(progress.progressWatch, LIMITS).trip, false, `round ${i}`);
    }
  });

  void it("a higher score, or fewer task-fixable blockers, counts as progress on its own", () => {
    let progress = baseProgress({ reviewScoreHistory: [reviewEntry(0, { score: 6, taskFixableCount: 3, settledItemCount: 10 })] });
    progress = recordRoundEndedInWatchV1(progress, ledgerRow("a", "completed"), { automatic: true, now: at(1) });
    progress = recordRoundEndedInWatchV1(progress, ledgerRow("b", "completed"), { automatic: true, now: at(2) });
    assert.equal(progress.progressWatch!.autoRoundsSinceProgress, 2);
    progress = { ...progress, reviewScoreHistory: [...progress.reviewScoreHistory!, reviewEntry(3, { score: 7, taskFixableCount: 3, settledItemCount: 10 })] };
    progress = recordRoundEndedInWatchV1(progress, ledgerRow("c", "completed"), { automatic: true, now: at(3) });
    assert.equal(progress.progressWatch!.autoRoundsSinceProgress, 0);
    assert.match(progress.progressWatch!.lastProgressWhat, /review score: 6 → 7/);
    progress = { ...progress, reviewScoreHistory: [...progress.reviewScoreHistory!, reviewEntry(4, { score: 7, taskFixableCount: 1, settledItemCount: 10 })] };
    progress = recordRoundEndedInWatchV1(progress, ledgerRow("d", "completed"), { automatic: true, now: at(4) });
    assert.match(progress.progressWatch!.lastProgressWhat, /task-fixable blockers: 3 → 1/);
  });

  void it("an owner action is progress, resets the counts and answers a held gate", () => {
    let progress = baseProgress();
    for (let i = 0; i < 3; i++) {
      progress = recordRoundEndedInWatchV1(progress, ledgerRow(`r${i}`, "failed", "boom"), { automatic: true, now: at(i) });
    }
    assert.equal(evaluateProgressWatchV1(progress.progressWatch, LIMITS).trip, true);
    progress = recordOwnerActionInWatchV1(progress, "you answered a card", at(10));
    assert.equal(evaluateProgressWatchV1(progress.progressWatch, LIMITS).trip, false);
    assert.equal(progress.progressWatch!.autoRoundsSinceProgress, 0);
    assert.equal(progress.progressWatch!.lastProgressWhat, "you answered a card");
  });

  void it("a round the owner started, or one that never ran, does not count as an automatic round", () => {
    let progress = baseProgress();
    progress = recordRoundEndedInWatchV1(progress, ledgerRow("m", "failed", "boom"), { automatic: false, now: at(0) });
    progress = recordRoundEndedInWatchV1(progress, ledgerRow("d", "dropped"), { automatic: true, now: at(1) });
    progress = recordRoundEndedInWatchV1(progress, ledgerRow("c", "cancelled"), { automatic: true, now: at(2) });
    assert.equal(progress.progressWatch!.autoRoundsSinceProgress, 0);
    assert.equal(progress.progressWatch!.consecutiveFailedAutoRounds, 0);
  });

  void it("with both settings at 0 the gate never trips", () => {
    let progress = baseProgress();
    for (let i = 0; i < 30; i++) {
      progress = recordRoundEndedInWatchV1(progress, ledgerRow(`r${i}`, "failed", "boom"), { automatic: true, now: at(i) });
    }
    assert.equal(evaluateProgressWatchV1(progress.progressWatch, { askOwnerAfterRounds: 0, askOwnerAfterFailedRounds: 0 }).trip, false);
  });
});

void describe("every automatic entry point reaches the gate (Step 24)", () => {
  void it("the automation chain does not run a refused dispatch, and records it as declined", async () => {
    const executed: string[] = [];
    const dropped: string[] = [];
    const ended = new Set<(s: { id: string; state: string }) => void>();
    const deps = {
      onDidEnd: (listener: (s: { id: string; state: string }) => void) => { ended.add(listener); return { dispose: () => ended.delete(listener) }; },
      execute: (command: string) => { executed.push(command); return Promise.resolve(true); },
      admit: () => Promise.resolve(false),
    };
    const dispatch = { command: "x.applyReview", taskKey: path.join(TEST_ROOT, "chain-task"), onDropped: (r: string) => dropped.push(r) };
    await scheduleAutomationChain(dispatch, undefined, deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(executed, [], "a dispatch the gate refused never executes");
    releaseAutomationChain(dispatch.taskKey, dispatch.command);
    const admitting = { ...deps, admit: () => Promise.resolve(true) };
    const second = { command: "x.review", taskKey: path.join(TEST_ROOT, "chain-task-2") };
    await scheduleAutomationChain(second, undefined, admitting);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(executed, ["x.review"], "an admitted dispatch runs");
  });

  void it("Fast Forward's loop asks the gate before every apply(), and stops with a progress-gate hold when it says no", () => {
    const read = (file: string): string => fs.readFileSync(path.resolve(__dirname, "../../src", file), "utf8");
    const loop = read("utils/reviewScoreLoop.ts");
    assert.ok(
      loop.indexOf("options.admitDispatch?.()") !== -1 && loop.indexOf("options.admitDispatch?.()") < loop.indexOf("await options.apply()"),
      "reviewScoreLoop.ts consults admitDispatch before options.apply()"
    );
    assert.match(loop, /held: \{ kind: "progress-gate"/);
    const actions = read("commands/reviewActions.ts");
    assert.match(actions, /admitDispatch: async \(\) =>[\s\S]{0,400}kind: "fast-forward"/, "reviewActions.ts passes admitDispatch to improveReviewScore");
    assert.match(actions, /kind: "fast-forward-publish-checks"/, "Fast Forward's own Publish Checks run passes the gate too");
  });

  void it("the recovery sweep, scheduled reruns and the chain each call the gate", () => {
    const read = (file: string): string => fs.readFileSync(path.join(__dirname, "..", "..", "src", file), "utf8");
    assert.match(read("commands/scheduleTaskResume.ts"), /kind: "recovery-sweep"/);
    assert.match(read("commands/scheduleTaskResume.ts"), /kind: "scheduled-rerun"/);
    assert.match(read("utils/automationChain.ts"), /kind: "automation-chain"/);
  });
});

void describe("the work-admission layer refuses an automatic claim that skipped the gate (Step 24)", () => {
  function heldTaskFolder(name: string): string {
    const folder = path.join(TEST_ROOT, name);
    fs.mkdirSync(folder, { recursive: true });
    writeOwnershipBackedTaskProgress(folder);
    const file = path.join(folder, "task-progress.json");
    const json = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    json["progressWatch"] = {
      lastProgressAt: "2026-11-02T08:00:00.000Z",
      lastProgressWhat: "plan items settled: 109 → 114",
      autoRoundsSinceProgress: 3,
      consecutiveFailedAutoRounds: 3,
      endings: [],
      heldAt: "2026-11-02T09:00:00.000Z",
      heldFor: "failed",
    };
    fs.writeFileSync(file, JSON.stringify(json, null, 2), "utf8");
    return folder;
  }

  void it("refuses an automatic claim that did not pass the gate, admits one that did, and never touches the owner's", async () => {
    registerAutomaticGateLimitsProviderV1(() => LIMITS);
    try {
      const folder = heldTaskFolder("held-task");
      const refused = await runWithAutomaticOriginV1(() =>
        acquireWorkAdmissionV1({ taskFolderPath: folder, purpose: "admission", commandId: "test.auto" })
      );
      assert.equal(refused.outcome, "writeFailed");
      assert.ok(refused.outcome === "writeFailed" && refused.error instanceof AutomaticDispatchRefusedErrorV1);

      const ownerClaim = await runWithOwnerOriginV1(() =>
        acquireWorkAdmissionV1({ taskFolderPath: folder, purpose: "admission", commandId: "test.owner" })
      );
      assert.equal(ownerClaim.outcome, "acquired", "an owner click is never refused by the gate");
      if (ownerClaim.outcome === "acquired") await ownerClaim.handle.release();

      // The shared boundary treats a path nobody marked as automatic, so a new automatic path that forgets both the
      // gate and the origin marker is refused instead of being recorded as the owner's.
      const unmarked = await acquireWorkAdmissionV1({ taskFolderPath: folder, purpose: "admission", commandId: "test.unmarked" });
      assert.equal(unmarked.outcome, "writeFailed", "an unmarked claim counts as automatic");
      assert.ok(unmarked.outcome === "writeFailed" && unmarked.error instanceof AutomaticDispatchRefusedErrorV1);

      // Automatic origin still wins inside an owner-marked tree (the owner started Fast Forward; its rounds are not theirs).
      const nested = await runWithOwnerOriginV1(() =>
        runWithAutomaticOriginV1(() =>
          acquireWorkAdmissionV1({ taskFolderPath: folder, purpose: "admission", commandId: "test.nested" })
        )
      );
      assert.equal(nested.outcome, "writeFailed");

      const passed = await runWithAdmittedAutomaticDispatchV1(async () => {
        assert.equal(hasPassedAutomaticGateV1(), true);
        return acquireWorkAdmissionV1({ taskFolderPath: folder, purpose: "admission", commandId: "test.admitted" });
      });
      assert.equal(passed.outcome, "acquired", "a dispatch that passed the gate is admitted");
      if (passed.outcome === "acquired") await passed.handle.release();
    } finally {
      registerAutomaticGateLimitsProviderV1(undefined);
    }
  });

  void it("review1 Step 24: a task still under its limits refuses an automatic claim that skipped the gate", async () => {
    registerAutomaticGateLimitsProviderV1(() => LIMITS);
    try {
      const folder = path.join(TEST_ROOT, "healthy-task");
      fs.mkdirSync(folder, { recursive: true });
      writeOwnershipBackedTaskProgress(folder);

      const skipped = await runWithAutomaticOriginV1(() =>
        acquireWorkAdmissionV1({ taskFolderPath: folder, purpose: "admission", commandId: "test.forgotTheGate" })
      );
      assert.equal(skipped.outcome, "writeFailed");
      assert.ok(skipped.outcome === "writeFailed" && skipped.error instanceof AutomaticDispatchRefusedErrorV1);
      assert.match(
        skipped.outcome === "writeFailed" ? String(skipped.error.message) : "",
        /did not go through the "is this working\?" check \(test\.forgotTheGate\)/,
        "the refusal names the claim that skipped the gate, not a progress limit"
      );

      const unmarked = await acquireWorkAdmissionV1({ taskFolderPath: folder, purpose: "admission", commandId: "test.unmarked" });
      assert.equal(unmarked.outcome, "writeFailed", "a path nobody marked counts as automatic");

      // The internal in-flight marker starts no work and never passes the gate.
      const marker = await acquireWorkAdmissionV1({ taskFolderPath: folder, purpose: "admission", commandId: "resolutionInFlight" });
      assert.equal(marker.outcome, "acquired");
      if (marker.outcome === "acquired") await marker.handle.release();

      const passed = await runWithAdmittedAutomaticDispatchV1(() =>
        acquireWorkAdmissionV1({ taskFolderPath: folder, purpose: "admission", commandId: "test.admitted" })
      );
      assert.equal(passed.outcome, "acquired");
      if (passed.outcome === "acquired") await passed.handle.release();

      const owner = await runWithOwnerOriginV1(() =>
        acquireWorkAdmissionV1({ taskFolderPath: folder, purpose: "admission", commandId: "test.owner" })
      );
      assert.equal(owner.outcome, "acquired");
      if (owner.outcome === "acquired") await owner.handle.release();
    } finally {
      registerAutomaticGateLimitsProviderV1(undefined);
    }
  });

  void it("installOwnerOriginCommandRegistrationV1 runs each registered handler inside an owner-origin tree, once", () => {
    const registered: Array<(...args: unknown[]) => unknown> = [];
    const commands = {
      registerCommand: (_id: string, cb: (...args: unknown[]) => unknown, thisArg?: unknown): unknown => {
        registered.push((...args) => cb.apply(thisArg, args));
        return {};
      },
    };
    assert.equal(installOwnerOriginCommandRegistrationV1(commands), true);
    assert.equal(installOwnerOriginCommandRegistrationV1(commands), false, "idempotent");
    commands.registerCommand("x", () => hasOwnerOriginV1());
    assert.equal(registered[0]?.(), true, "the handler runs as the owner's");
    assert.equal(hasOwnerOriginV1(), false, "the marker does not leak outside the handler");
  });

  void it("a degenerate-review backup advance passes the gate, and is not dispatched while the gate holds the task (Step 24)", async () => {
    const calls: string[] = [];
    const input = {
      folderUri: vscode.Uri.file(path.join(TEST_ROOT, "backup-advance")),
      workspaceUri: vscode.Uri.file(TEST_ROOT),
      extensionUri: vscode.Uri.file(TEST_ROOT),
      targetStage: "impl-high-review" as const,
      currentStage: "impl-high-review" as const,
      nextModelId: "backup-model",
    };
    const deps = (admitted: boolean) => ({
      recordActiveFallbackModel: (() => {
        calls.push("record");
        return Promise.resolve();
      }) as never,
      getWorkspaceFolder: () => ({ uri: input.workspaceUri, name: "w", index: 0 }),
      runReviewForFolder: (() => {
        calls.push(hasPassedAutomaticGateV1() ? "review(gated)" : "review(ungated)");
        return Promise.resolve();
      }) as never,
      showWarning: (() => undefined) as never,
      admitAutomaticDispatch: ((arg: { kind: string }) => {
        calls.push(`gate:${arg.kind}`);
        return Promise.resolve(admitted ? { admitted: true } : { admitted: false, reason: "failed", cardPosted: true });
      }) as never,
    });
    const ran = await dispatchDegenerateReviewBackupAdvanceV1(input, deps(true));
    assert.deepEqual(calls, ["gate:backup-retry", "record", "review(gated)"]);
    assert.equal(ran.dispatched, true);
    calls.length = 0;
    const held = await dispatchDegenerateReviewBackupAdvanceV1(input, deps(false));
    assert.deepEqual(calls, ["gate:backup-retry"], "held: no model change and no review");
    assert.equal(held.dispatched, false);
  });

  void it("with no limits registered (unit tests, a viewer host) nothing is enforced", async () => {
    registerAutomaticGateLimitsProviderV1(undefined);
    const folder = heldTaskFolder("held-task-unenforced");
    const result = await runWithAutomaticOriginV1(() =>
      acquireWorkAdmissionV1({ taskFolderPath: folder, purpose: "admission", commandId: "test.auto2" })
    );
    assert.equal(result.outcome, "acquired");
    if (result.outcome === "acquired") await result.handle.release();
  });
});

void describe("review1 item 4 replay: an Accepted Non-Goals edit makes the old review stale (Step 27)", () => {
  const HEAD = "abc1234def5678abc1234def5678abc1234def56";
  const FINGERPRINT = "f".repeat(64);
  const REVIEW = `Readiness: 7/10\n<!-- reviewed-commit: ${HEAD} -->\n<!-- reviewed-tree-fingerprint: ${FINGERPRINT} -->\n`;
  void it("the code tree is unchanged, but changed review inputs mean the review is not 'unchanged'", () => {
    assert.equal(isReviewDispatchAgainstUnchangedTreeV1(REVIEW, HEAD, FINGERPRINT), true, "baseline: tree and inputs unchanged → skipped");
    assert.equal(isReviewDispatchAgainstUnchangedTreeV1(REVIEW, HEAD, FINGERPRINT, false), true);
    assert.equal(isReviewDispatchAgainstUnchangedTreeV1(REVIEW, HEAD, FINGERPRINT, true), false, "plan.md changed → the review runs");
  });

  void it("Fast Forward's start compares the review inputs before any stop check", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "commands", "reviewActions.ts"), "utf8");
    assert.match(source, /startReviewInputsChangedV1 =\s*\(await reviewInputsChangedSinceV1/);
    assert.match(source, /startReviewInputsChangedV1 \|\|/);
  });
});

void describe("run1 Step 15: recovery advice reads what the round provably did and why it stopped", () => {
  const rowWith = (
    id: string,
    state: RoundLedgerEntryV1["state"],
    outcome: NonNullable<RoundLedgerEntryV1["outcome"]>
  ): Pick<RoundLedgerEntryV1, "roundId" | "stage" | "state" | "outcome"> => ({ roundId: id, stage: "impl-high-review", state, outcome });

  void it("an Ensemble stop is a cut-off, never a provider error, whatever its wording says", () => {
    const idle = classifyRoundEndingV1("failed", "Ensemble stopped the round: no reply from the model for 20 minutes.", at(0), "ensembleIdleStop");
    assert.equal(idle.kind, "cut-off");
    assert.equal(classifyRoundEndingV1("failed", "anything", at(0), "providerTimeCap").kind, "cut-off");
    assert.equal(classifyRoundEndingV1("failed", "anything", at(0), "providerQuota").kind, "quota");
  });

  void it("a round stopped while its own stream shows it changing files is progress, not another failure", () => {
    const watched = recordRoundEndedInWatchV1(
      baseProgress(),
      rowWith("r1", "failed", { rejectionReason: "Ensemble stops a round after 4 hours.", stopCause: "ensembleBackstop", attributedFiles: ["a.ts", "b.ts"] }),
      { automatic: true, now: at(10) }
    ).progressWatch;
    assert.equal(watched?.consecutiveFailedAutoRounds, 0);
    assert.equal(watched?.autoRoundsSinceProgress, 0);
    assert.match(watched?.lastProgressWhat ?? "", /changed 2 files/);
  });

  void it("files that only changed in the workspace while the round ran are never progress", () => {
    const watched = recordRoundEndedInWatchV1(
      baseProgress(),
      rowWith("r1", "failed", { rejectionReason: "Ensemble stopped the round: no reply.", stopCause: "ensembleIdleStop", observedFiles: ["a.ts", "b.ts", "c.ts"] }),
      { automatic: true, now: at(10) }
    ).progressWatch;
    assert.equal(watched?.consecutiveFailedAutoRounds, 1);
    assert.equal(watched?.endings[0]?.kind, "cut-off");
    assert.equal(watched?.endings[0]?.attributedFileCount, undefined);
  });

  void it("time limits and quiet stops never support switching the model; a model repeating itself twice does", () => {
    const ending = (stopCause: string, model = MODEL) =>
      ({ at: at(0).toISOString(), kind: "cut-off", automatic: true, stopCause, model }) as const;
    assert.equal(endingsAreRepeatedProviderFailuresV1([ending("ensembleIdleStop"), ending("providerTimeCap"), ending("ensembleBackstop")]), false);
    assert.equal(endingsAreRepeatedProviderFailuresV1([ending("ensembleRepeatStop")]), false);
    assert.equal(endingsAreRepeatedProviderFailuresV1([ending("ensembleRepeatStop"), ending("ensembleRepeatStop")]), true);
    assert.equal(endingsAreRepeatedProviderFailuresV1([ending("ensembleRepeatStop"), ending("ensembleRepeatStop", "other-model")]), false);
  });

  void it("generic failures and vanished processes never support switching the model; limits and sign-in failures do", () => {
    const failed = (stopCause: string | undefined, kind: "provider-error" | "cut-off" | "quota" = "provider-error") =>
      ({ at: at(0).toISOString(), kind, automatic: true, model: MODEL, ...(stopCause !== undefined ? { stopCause } : {}) }) as const;
    assert.equal(endingsAreRepeatedProviderFailuresV1([failed(undefined), failed(undefined)]), false, "two generic failures");
    assert.equal(endingsAreRepeatedProviderFailuresV1([failed("generic"), failed("providerError")]), false);
    assert.equal(endingsAreRepeatedProviderFailuresV1([failed("processEnded", "cut-off"), failed("processEnded", "cut-off")]), false, "a vanished process");
    assert.equal(endingsAreRepeatedProviderFailuresV1([failed("signIn"), failed("signIn")]), true);
    assert.equal(endingsAreRepeatedProviderFailuresV1([failed("providerUsageLimit", "quota"), failed("providerQuota", "quota")]), true);
    assert.equal(endingsAreRepeatedProviderFailuresV1([failed(undefined, "quota"), failed(undefined, "quota")]), true);
  });

  void it("a completed round whose stream named files is progress, and the completed ledger row carries them", () => {
    const watched = recordRoundEndedInWatchV1(
      baseProgress(),
      rowWith("r1", "completed", { filesChanged: ["a.ts"], attributedFiles: ["a.ts"], observedFiles: ["x.ts"] }),
      { automatic: true, now: at(10) }
    ).progressWatch;
    assert.equal(watched?.autoRoundsSinceProgress, 0);
    assert.match(watched?.lastProgressWhat ?? "", /changed 1 file and finished/);
    const reviewActionsSource = fs.readFileSync(path.join(__dirname, "..", "..", "src", "commands", "reviewActions.ts"), "utf8");
    assert.match(reviewActionsSource, /const activityFields = roundLedgerActivityFieldsV1\(completedResult\)/);
  });

  void it("the card tells a model that repeated itself apart from one that went quiet", () => {
    const text = describeRoundEndingsV1([
      { at: at(0).toISOString(), kind: "cut-off", automatic: true, stopCause: "ensembleRepeatStop" },
      { at: at(1).toISOString(), kind: "cut-off", automatic: true, stopCause: "ensembleIdleStop" },
    ]);
    assert.match(text, /1 stopped because the model kept repeating itself/);
    assert.match(text, /1 stopped with no reply from the model/);
  });
});
