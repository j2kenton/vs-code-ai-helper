/**
 * review1 Steps 53-55: the countdown sentence that counts down and says when it was stopped, and "and keep going".
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { describe, it } from "node:test";

import {
  baseOptionIdOfKeepGoingV1,
  currentRunBindingV1,
  describeKeepGoingAppliedLineV1,
  isKeepGoingOptionIdV1,
  keepGoingKeyV1,
  KEEP_GOING_TTL_MS_V1,
  matchesKeepGoingV1,
  withKeepGoingOptionV1,
} from "../utils/autoContinueKeepGoingV1";
import {
  clearFastForwardRunActiveV1,
  endFastForwardRunChainV1,
  markFastForwardRunActiveV1,
  recordFastForwardRunPausedV1,
} from "../utils/activeFastForwardRunsV1";
import {
  describeAutoContinueNoteV1,
  hasRunningAutoContinueCountdownV1,
  isAutoContinueOptionV1,
  withWaitForMeOptionV1,
} from "../utils/autoContinueV1";
import { runAutoContinueSweepV1, type AutoContinueSweepDepsV1 } from "../utils/autoContinueSweepV1";
import type { WorkflowDecisionOptionV1, WorkflowDecisionV1 } from "../types/workflowDecisionV1";

const T0 = Date.parse("2026-11-04T21:39:00.000Z");
const FOLDER = "/ws/.ensemble/task-x";

const TICKS: WorkflowDecisionOptionV1 = {
  optionId: "apply",
  label: "Apply the 9 ticks now",
  consequence: "Ticks the items.",
  resumeKind: "continue",
  unattendedSafe: true,
  effect: { kind: "command", command: "vs-code-ai-helper.applyReviewerVerifiedTicksConfirmed" },
};
const PUBLISH: WorkflowDecisionOptionV1 = {
  optionId: "publishAnyway",
  label: "I'll publish over it",
  consequence: "Publishes.",
  resumeKind: "continue",
  effect: { kind: "command", command: "vs-code-ai-helper.publishAnyway" },
};

function card(overrides: Partial<WorkflowDecisionV1> = {}): WorkflowDecisionV1 {
  return {
    decisionId: "d1",
    decisionKey: "reviewerVerifiedTicks",
    taskCanonicalId: FOLDER,
    stage: "impl-high-review",
    state: "pending",
    options: withWaitForMeOptionV1([TICKS, PUBLISH]),
    recommendation: { kind: "option", optionId: "apply", reasoning: "safe" },
    autoContinue: { optionId: "apply", minutes: 15, deadline: new Date(T0 + 15 * 60_000).toISOString() },
    ...overrides,
  } as unknown as WorkflowDecisionV1;
}

void describe("review1 Step 53: the countdown sentence is drawn from the stored deadline", () => {
  void it("counts down as the time passes", () => {
    const d = card();
    assert.match(describeAutoContinueNoteV1(d, T0) ?? "", /Continues with ‘Apply the 9 ticks now’ in 15 min unless you choose otherwise\. Press Wait for me/);
    assert.match(describeAutoContinueNoteV1(d, T0 + 10 * 60_000) ?? "", /in 5 min/);
    assert.match(describeAutoContinueNoteV1(d, T0 + 14.5 * 60_000) ?? "", /in 1 min/);
  });

  void it("says the countdown was stopped, instead of promising a run, once it is cancelled", () => {
    const d = card({
      autoContinue: {
        optionId: "apply",
        minutes: 15,
        deadline: new Date(T0 + 15 * 60_000).toISOString(),
        cancelledAt: new Date(T0 + 60_000).toISOString(),
        cancelledReason: "you pressed Wait for me",
      },
    });
    const note = describeAutoContinueNoteV1(d, T0 + 2 * 60_000) ?? "";
    assert.match(note, /countdown was stopped \(you pressed Wait for me\)\. Nothing runs until you choose/);
    assert.doesNotMatch(note, /Continues with/);
    assert.equal(hasRunningAutoContinueCountdownV1(d), false);
  });

  void it("has no note for a card with no countdown or one that is answered", () => {
    assert.equal(describeAutoContinueNoteV1(card({ autoContinue: undefined }), T0), undefined);
    assert.equal(describeAutoContinueNoteV1(card({ state: "resolved" } as Partial<WorkflowDecisionV1>), T0), undefined);
    assert.equal(hasRunningAutoContinueCountdownV1(card()), true);
    assert.equal(hasRunningAutoContinueCountdownV1(card({ state: "resolved" } as Partial<WorkflowDecisionV1>)), false);
  });
});

void describe("review1 Step 54: and keep going", () => {
  void it("adds a sibling of the armed option that does the same thing and says what else it does, before it is chosen", () => {
    const options = withKeepGoingOptionV1(withWaitForMeOptionV1([TICKS, PUBLISH]), "apply");
    const sibling = options.find((o) => o.optionId === "apply:keepGoing");
    assert.ok(sibling);
    assert.equal(sibling.label, "Apply the 9 ticks now and keep going");
    assert.deepEqual(sibling.effect, TICKS.effect);
    assert.match(sibling.consequence, /later cards of this kind in this run are applied at once, each with a line in the chat/);
    assert.equal(options.findIndex((o) => o.optionId === "apply:keepGoing"), options.findIndex((o) => o.optionId === "apply") + 1);
    // Offered once.
    assert.equal(withKeepGoingOptionV1(options, "apply").length, options.length);
  });

  void it("never adds keep going to an option that is not safe to run unattended", () => {
    const options = withKeepGoingOptionV1([TICKS, PUBLISH], "publishAnyway");
    assert.equal(options.some((o) => isKeepGoingOptionIdV1(o.optionId)), false);
    assert.equal(isAutoContinueOptionV1(PUBLISH), false);
  });

  void it("maps the sibling id back to the option it runs", () => {
    assert.equal(baseOptionIdOfKeepGoingV1("apply:keepGoing"), "apply");
    assert.equal(baseOptionIdOfKeepGoingV1("apply"), "apply");
  });

  void it("applies the next card of the same kind, only within the run and only for the same kind", () => {
    const fresh = card({ autoContinue: undefined });
    const key = keepGoingKeyV1(FOLDER, "reviewerVerifiedTicks", "apply");
    const run = { sessionId: "s1", runEpoch: 3 };
    const records = [{ key, recordedAt: new Date(T0).toISOString(), binding: run }];
    assert.equal(matchesKeepGoingV1(fresh, records, T0 + 60_000, run), true);
    // Expired.
    assert.equal(matchesKeepGoingV1(fresh, records, T0 + KEEP_GOING_TTL_MS_V1 + 1, run), false);
    // Another decision kind, another task, or no record at all.
    assert.equal(matchesKeepGoingV1(card({ decisionKey: "other", autoContinue: undefined }), records, T0, run), false);
    assert.equal(matchesKeepGoingV1(card({ taskCanonicalId: "/ws/other", autoContinue: undefined }), records, T0, run), false);
    assert.equal(matchesKeepGoingV1(fresh, [], T0, run), false);
    // A card whose recommended option is not safe never matches.
    assert.equal(
      matchesKeepGoingV1(
        card({ recommendation: { kind: "option", optionId: "publishAnyway", reasoning: "x" }, autoContinue: undefined }),
        records,
        T0,
        run
      ),
      false
    );
  });

  void it("an answer belongs to the run it was given in: a later Fast Forward run or a restart does not inherit it", () => {
    const fresh = card({ autoContinue: undefined });
    const key = keepGoingKeyV1(FOLDER, "reviewerVerifiedTicks", "apply");
    const given = { sessionId: "s1", runEpoch: 3 };
    const records = [{ key, recordedAt: new Date(T0).toISOString(), binding: given }];
    assert.equal(matchesKeepGoingV1(fresh, records, T0 + 1000, given), true);
    // A new Fast Forward run started for the task (the epoch went up).
    assert.equal(matchesKeepGoingV1(fresh, records, T0 + 1000, { sessionId: "s1", runEpoch: 4 }), false);
    // The window was restarted (a new session id).
    assert.equal(matchesKeepGoingV1(fresh, records, T0 + 1000, { sessionId: "s2", runEpoch: 3 }), false);
    // A record written before the binding existed never matches.
    assert.equal(
      matchesKeepGoingV1(fresh, [{ key, recordedAt: new Date(T0).toISOString() }], T0 + 1000, given),
      false
    );
  });

  void it("a run that ends for good, or an automation-stopped card, ends the answer; a resume from a pause keeps it", () => {
    const chainFolder = "/ws/.ensemble/chain-task";
    // A run starts, the owner answers "keep going" in it (the binding is taken now).
    markFastForwardRunActiveV1(chainFolder);
    const given = currentRunBindingV1(chainFolder);
    // It paused for a card and is resumed from that card: the same chain, so the answer still holds.
    clearFastForwardRunActiveV1(chainFolder);
    recordFastForwardRunPausedV1(chainFolder);
    markFastForwardRunActiveV1(chainFolder, { attemptNumber: 2, maxAttempts: 10 }, { continuesPausedRun: true });
    assert.deepEqual(currentRunBindingV1(chainFolder), given);
    // A fresh start that is not a resume is a new chain.
    clearFastForwardRunActiveV1(chainFolder);
    markFastForwardRunActiveV1(chainFolder);
    assert.notDeepEqual(currentRunBindingV1(chainFolder), given);
    // The run ends for good: the answer given in it is dead, and a later independent action does not inherit it.
    const second = currentRunBindingV1(chainFolder);
    clearFastForwardRunActiveV1(chainFolder);
    endFastForwardRunChainV1(chainFolder);
    assert.notDeepEqual(currentRunBindingV1(chainFolder), second);
    const records = [{ key: keepGoingKeyV1(FOLDER, "reviewerVerifiedTicks", "apply"), recordedAt: new Date(T0).toISOString(), binding: second }];
    assert.equal(matchesKeepGoingV1(card({ autoContinue: undefined }), records, T0 + 1000, currentRunBindingV1(chainFolder)), false);
  });

  void it("currentRunBindingV1 follows the task's Fast Forward run epoch", () => {
    const before = currentRunBindingV1(FOLDER);
    markFastForwardRunActiveV1(FOLDER);
    const during = currentRunBindingV1(FOLDER);
    clearFastForwardRunActiveV1(FOLDER);
    assert.equal(during.sessionId, before.sessionId);
    assert.equal(during.runEpoch, before.runEpoch + 1);
    // Ending the run does not take the epoch back: the answer given in it stays dead.
    assert.equal(currentRunBindingV1(FOLDER).runEpoch, during.runEpoch);
  });

  void it("the sweep runs a keep-going card at once and says why in the chat", async () => {
    const keepGoingCard = card({
      autoContinue: { optionId: "apply", minutes: 15, deadline: new Date(T0).toISOString(), keepGoing: true },
    });
    const runs: string[] = [];
    const said: string[] = [];
    const deps: AutoContinueSweepDepsV1 = {
      listArmed: () => [keepGoingCard],
      readTaskState: () => Promise.resolve({}),
      cancel: () => Promise.resolve(),
      admit: () => Promise.resolve(true),
      taskIsBusy: () => false,
      run: (id, optionId) => {
        runs.push(`${id}:${optionId}`);
        return Promise.resolve({ ok: true });
      },
      say: (_id, text) => {
        said.push(text);
        return Promise.resolve();
      },
      reoffer: () => Promise.resolve(false),
      now: () => T0,
    };
    const result = await runAutoContinueSweepV1(deps);
    assert.deepEqual(result.ran, ["d1"]);
    assert.deepEqual(runs, ["d1:apply"]);
    assert.deepEqual(said, [describeKeepGoingAppliedLineV1("Apply the 9 ticks now")]);
    assert.match(said[0]!, /you chose to keep going earlier in this run/);
  });

  void it("a keep-going card still has to pass the automatic-dispatch gate", async () => {
    const refusedCard = card({
      autoContinue: { optionId: "apply", minutes: 15, deadline: new Date(T0).toISOString(), keepGoing: true },
    });
    const runs: string[] = [];
    const deps: AutoContinueSweepDepsV1 = {
      listArmed: () => [refusedCard],
      readTaskState: () => Promise.resolve({}),
      cancel: () => Promise.resolve(),
      admit: () => Promise.resolve(false),
      taskIsBusy: () => false,
      run: (id, optionId) => {
        runs.push(`${id}:${optionId}`);
        return Promise.resolve({ ok: true });
      },
      say: () => Promise.resolve(),
      reoffer: () => Promise.resolve(false),
      now: () => T0,
    };
    const result = await runAutoContinueSweepV1(deps);
    assert.deepEqual(runs, []);
    assert.deepEqual(result.refused, ["d1"]);
  });
});

void describe("review1 Step 54: a one-cycle chain ends when its re-review decides, whichever way", () => {
  void it("routing ends the chain of a chained re-review before it returns a clean advance", () => {
    const source = nodeFs.readFileSync(
      nodePath.join(__dirname, "..", "..", "src", "commands", "reviewActions.ts"),
      "utf8"
    );
    const endsChain = source.indexOf("endFastForwardRunChainV1(folderUri.fsPath)");
    const advanceReturn = source.indexOf('if (decision.route === "advance" || decision.route === "iterate") {');
    assert.ok(endsChain > 0, "the one-cycle path ends the chain");
    assert.ok(endsChain < advanceReturn, "the chain is ended before the clean-advance return");
    const guard = source.slice(Math.max(0, endsChain - 520), endsChain);
    assert.match(guard, /chainedReReview === true/);
    assert.match(guard, /!isFastForwardRunActiveV1\(folderUri\.fsPath\)/);
  });

  void it("a one-cycle Apply Review ends the chain when it is refused, fails or throws before its re-review", () => {
    const source = nodeFs.readFileSync(
      nodePath.join(__dirname, "..", "..", "src", "commands", "reviewActions.ts"),
      "utf8"
    );
    const start = source.indexOf("export async function applyReviewEditWithAI(");
    const end = source.indexOf("function endOneCycleRunChainV1(");
    assert.ok(start > 0 && end > start, "the helper is defined after applyReviewEditWithAI");
    const body = source.slice(start, end);
    // A refused admission ends it.
    const refused = body.indexOf('early.outcome !== "acquired"');
    assert.ok(refused > 0);
    assert.match(body.slice(refused, refused + 700), /endOneCycleRunChainV1\(earlyFolderPath!\)/);
    // The finally ends it for every other ending, ahead of the admission release.
    const finallyEnd = body.lastIndexOf("endOneCycleRunChainV1(oneCycleChainFolderPath)");
    const release = body.lastIndexOf("await releaseAdmissionV1();");
    assert.ok(finallyEnd > 0 && finallyEnd < release, "the chain ends before the admission is released");
    // A call a Fast Forward run holds (parentOperation) never ends the run's chain.
    assert.match(body, /oneCycleChainFolderPath: string \| undefined = options\.parentOperation \? undefined/);
    // A run Fast Forward owns is never cut short by the helper.
    const helper = source.slice(end, end + 300);
    assert.match(helper, /!isFastForwardRunActiveV1\(taskFolderPath\)/);
  });

  void it("a standalone Implementation round ends the chain when it is refused or however it ends", () => {
    const source = nodeFs.readFileSync(
      nodePath.join(__dirname, "..", "..", "src", "commands", "reviewActions.ts"),
      "utf8"
    );
    const start = source.indexOf("export async function runImplementationWithAI(");
    const end = source.indexOf("function endOneCycleRunChainV1(");
    const body = source.slice(start, end);
    assert.ok(start > 0 && end > start);
    const refused = body.indexOf('early.outcome !== "acquired"');
    assert.match(body.slice(refused, refused + 700), /endOneCycleRunChainV1\(earlyFolderPath!\)/);
    const finallyEnd = body.lastIndexOf("endOneCycleRunChainV1(keepGoingChainFolderPathV1)");
    const release = body.lastIndexOf("await releaseAdmissionV1();");
    assert.ok(finallyEnd > refused && finallyEnd < release, "ended in the finally, before the admission is released");
  });

  void it("a no-argument Implementation (task picker) ends the picked task's chain on a late refusal and at the end", () => {
    const source = nodeFs.readFileSync(
      nodePath.join(__dirname, "..", "..", "src", "commands", "reviewActions.ts"),
      "utf8"
    );
    const start = source.indexOf("export async function runImplementationWithAI(");
    const end = source.indexOf("function endOneCycleRunChainV1(");
    const body = source.slice(start, end);
    // Starts from the synchronously known folder (undefined for the picker path) ...
    assert.match(body, /let keepGoingChainFolderPathV1: string \| undefined = earlyFolderPath;/);
    // ... is set as soon as the picker resolves the task, before the late admission and every later return ...
    const resolvedAt = body.indexOf("keepGoingChainFolderPathV1 = resolved.folderUri.fsPath;");
    const lateAdmission = body.indexOf("const late = await acquireOrAdoptWorkAdmissionV1(");
    assert.ok(resolvedAt > 0 && lateAdmission > resolvedAt, "bound before the late admission can refuse");
    // ... and the finally ends the chain from that variable, not from earlyFolderPath alone.
    assert.doesNotMatch(body, /endOneCycleRunChainV1\(earlyFolderPath\)(?!!)/);
    assert.match(body, /if \(keepGoingChainFolderPathV1 !== undefined\) \{\s*endOneCycleRunChainV1\(keepGoingChainFolderPathV1\);/);
  });

  void it("the stage-action router ends the chain when the action is refused before dispatch (no model, paused, no task)", () => {
    const source = nodeFs.readFileSync(
      nodePath.join(__dirname, "..", "..", "src", "commands", "applyCurrentStageAction.ts"),
      "utf8"
    );
    const start = source.indexOf("export async function applyCurrentStageAction(");
    const end = source.indexOf("type StageActionRefusalV1");
    const body = source.slice(start, end);
    assert.match(body, /try \{\s*dispatched = await applyCurrentStageActionCore\(/);
    assert.match(body, /\} finally \{[\s\S]*!isFastForwardRunActiveV1\(chainFolder\)[\s\S]*endFastForwardRunChainV1\(chainFolder\)/);
  });

  void it("an answer given in a one-cycle chain does not match the next independent action", () => {
    const folder = "/ws/.ensemble/one-cycle-task";
    const given = currentRunBindingV1(folder);
    endFastForwardRunChainV1(folder);
    assert.notDeepEqual(currentRunBindingV1(folder), given);
    const records = [
      { key: keepGoingKeyV1(FOLDER, "reviewerVerifiedTicks", "apply"), recordedAt: new Date(T0).toISOString(), binding: given },
    ];
    assert.equal(matchesKeepGoingV1(card({ autoContinue: undefined }), records, T0 + 1000, currentRunBindingV1(folder)), false);
  });
});
