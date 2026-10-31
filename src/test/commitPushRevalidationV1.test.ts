/**
 * bugs3 Step 17: a Commit & Push that skipped the checks on the strength of a
 * recorded pass re-checks that pass after the owner confirms (the confirmation
 * no longer expires), says what stopped it from what is true now, and goes to
 * the confirmation at once without spawning checks.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe as nodeDescribe, it as nodeIt, type TestContext } from "node:test";
import {
  isReusedCommitPushChecksStillCurrentV1,
  revalidateReusedCommitPushChecksV1,
  verifyCommitPushCheckedTreeBeforeStagingV1,
  type CommitPushTreeReaderV1,
} from "../commands/commitAndPushTask";
import {
  clearCommitPushStopStateV1,
  commitPushCheckedTreeV1,
  commitPushChecksWereReusedV1,
  noteCommitPushCheckedTreeV1,
  noteCommitPushChecksReusedV1,
  recordCommitPushStopV1,
  takeCommitPushStopTextV1,
} from "../utils/commitPushStopCauseV1";
import type { CommitPushChecksReuseV1 } from "../utils/commitPushChecksReuseV1";
import type { ResolvedTaskContext } from "../utils/resolveTaskContext";

const describe = (name: string, body: () => void): void => void nodeDescribe(name, body);
const it = (name: string, body: (t: TestContext) => unknown): void => void nodeIt(name, body as (t: TestContext) => void);

const TASK_FOLDER = path.join(os.tmpdir(), "ens-commit-push-revalidation-task");
const TASK = { taskFolderPath: TASK_FOLDER, progress: undefined } as unknown as ResolvedTaskContext;

const REUSE: CommitPushChecksReuseV1 = {
  reuse: true,
  result: { runAt: "2026-10-27T18:29:30.000Z", passed: true, summary: "ok", issueCount: 0, failedChecks: [], missingScripts: [] },
  message: "Using the Publish Checks result that passed.",
};
const STALE: CommitPushChecksReuseV1 = { reuse: false, reason: "files changed since the Publish Checks passed" };

function deciding(outcome: CommitPushChecksReuseV1): { decide: () => Promise<CommitPushChecksReuseV1>; calls: number } {
  const state = {
    calls: 0,
    decide: () => {
      state.calls += 1;
      return Promise.resolve(outcome);
    },
  };
  return state;
}

afterEach(() => clearCommitPushStopStateV1(TASK_FOLDER));

void describe("revalidating a reused pass after confirmation (bugs3 Step 17)", () => {
  it("asks nothing when this attempt ran the checks itself", async () => {
    const stub = deciding(STALE);
    assert.deepEqual(await revalidateReusedCommitPushChecksV1(TASK, stub.decide), { ok: true });
    assert.equal(await isReusedCommitPushChecksStillCurrentV1(TASK, stub.decide), true);
    assert.equal(stub.calls, 0);
  });

  it("lets the commit go on while the recorded pass still matches the tree", async () => {
    noteCommitPushChecksReusedV1(TASK_FOLDER, true);
    const stub = deciding(REUSE);
    assert.deepEqual(await revalidateReusedCommitPushChecksV1(TASK, stub.decide), { ok: true });
    assert.equal(stub.calls, 1);
    assert.equal(commitPushChecksWereReusedV1(TASK_FOLDER), true);
  });

  it("stops before anything is staged when the tree moved while the confirmation waited", async () => {
    noteCommitPushChecksReusedV1(TASK_FOLDER, true);
    const outcome = await revalidateReusedCommitPushChecksV1(TASK, deciding(STALE).decide);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.match(outcome.detail, /stopped before staging anything: files changed since the Publish Checks passed/);
      assert.match(outcome.detail, /Nothing was committed or pushed/);
      assert.match(outcome.detail, /the checks will run again/);
    }
    assert.equal(commitPushChecksWereReusedV1(TASK_FOLDER), false, "the reuse claim is withdrawn");
  });
});

void describe("the last gate before staging (bugs3 Step 17, final consumption)", () => {
  function reader(values: {
    head?: string | undefined;
    fingerprint?: string | undefined;
    commands?: string | undefined;
  }): CommitPushTreeReaderV1 {
    return {
      head: () => Promise.resolve(values.head),
      fingerprint: () => Promise.resolve(values.fingerprint),
      commandIdentity: () => Promise.resolve("commands" in values ? values.commands : "cmd1"),
    };
  }
  const CHECKED = { scopeFolder: "/repo", headCommitSha: "aaa", treeFingerprint: "fp1", commandIdentity: "cmd1" };

  it("gates nothing when no pass was relied on (published over failing checks)", async () => {
    const outcome = await verifyCommitPushCheckedTreeBeforeStagingV1(TASK, reader({ head: "zzz", fingerprint: "zzz" }));
    assert.deepEqual(outcome, { ok: true });
  });

  it("lets an attempt that ran the checks itself continue while the tree is as checked", async () => {
    noteCommitPushCheckedTreeV1(TASK_FOLDER, CHECKED);
    const outcome = await verifyCommitPushCheckedTreeBeforeStagingV1(TASK, reader({ head: "aaa", fingerprint: "fp1" }));
    assert.deepEqual(outcome, { ok: true });
  });

  it("stops a fresh-checks attempt whose files changed after the checks passed", async () => {
    noteCommitPushCheckedTreeV1(TASK_FOLDER, CHECKED);
    const outcome = await verifyCommitPushCheckedTreeBeforeStagingV1(TASK, reader({ head: "aaa", fingerprint: "fp2" }));
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.match(outcome.detail, /stopped before staging anything: files changed since the checks passed/);
      assert.match(outcome.detail, /Nothing was committed or pushed/);
    }
  });

  it("stops when the commit moved", async () => {
    noteCommitPushCheckedTreeV1(TASK_FOLDER, CHECKED);
    const outcome = await verifyCommitPushCheckedTreeBeforeStagingV1(TASK, reader({ head: "bbb", fingerprint: "fp1" }));
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.match(outcome.detail, /the commit changed since the checks passed/);
    }
  });

  it("fails closed when the tree can no longer be read", async () => {
    noteCommitPushCheckedTreeV1(TASK_FOLDER, CHECKED);
    const unreadable = await verifyCommitPushCheckedTreeBeforeStagingV1(TASK, reader({ head: "aaa", fingerprint: undefined }));
    assert.equal(unreadable.ok, false);
  });

  it("an identity that was never captured is not waived: the pass is tied to no tree", async () => {
    noteCommitPushCheckedTreeV1(TASK_FOLDER, { ...CHECKED, treeFingerprint: undefined });
    const noFingerprint = await verifyCommitPushCheckedTreeBeforeStagingV1(TASK, reader({ head: "aaa", fingerprint: undefined }));
    assert.equal(noFingerprint.ok, false);
    if (!noFingerprint.ok) {
      assert.match(noFingerprint.detail, /files the checks covered were not identified/);
    }
    noteCommitPushCheckedTreeV1(TASK_FOLDER, { ...CHECKED, headCommitSha: undefined });
    const noHead = await verifyCommitPushCheckedTreeBeforeStagingV1(TASK, reader({ head: "aaa", fingerprint: "fp1" }));
    assert.equal(noHead.ok, false);
    if (!noHead.ok) {
      assert.match(noHead.detail, /commit the checks covered was not identified/);
    }
  });

  it("a fresh-check attempt is stopped when the verification commands changed during the wait", async () => {
    noteCommitPushCheckedTreeV1(TASK_FOLDER, CHECKED);
    assert.equal(commitPushChecksWereReusedV1(TASK_FOLDER), false, "this attempt ran its own checks");
    const changed = await verifyCommitPushCheckedTreeBeforeStagingV1(
      TASK,
      reader({ head: "aaa", fingerprint: "fp1", commands: "cmd2" })
    );
    assert.equal(changed.ok, false);
    if (!changed.ok) {
      assert.match(changed.detail, /the verification commands changed since the checks passed/);
    }
    const dropped = await verifyCommitPushCheckedTreeBeforeStagingV1(
      TASK,
      reader({ head: "aaa", fingerprint: "fp1", commands: undefined })
    );
    assert.equal(dropped.ok, false, "commands that can no longer be resolved no longer match either");
  });

  it("a reused pass is also re-checked against the recorded result, and the reuse claim is withdrawn on a stop", async () => {
    noteCommitPushCheckedTreeV1(TASK_FOLDER, CHECKED);
    noteCommitPushChecksReusedV1(TASK_FOLDER, true);
    const outcome = await verifyCommitPushCheckedTreeBeforeStagingV1(
      TASK,
      reader({ head: "aaa", fingerprint: "fp1" }),
      deciding(STALE).decide
    );
    assert.equal(outcome.ok, false);
    assert.equal(commitPushChecksWereReusedV1(TASK_FOLDER), false);
  });

  it("a new attempt forgets the previous attempt's checked tree", () => {
    noteCommitPushCheckedTreeV1(TASK_FOLDER, CHECKED);
    clearCommitPushStopStateV1(TASK_FOLDER);
    assert.equal(commitPushCheckedTreeV1(TASK_FOLDER), undefined);
  });

  it("wiring: the gate runs before the first git add, outside the try that resets the index", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "..", "..", "src", "commands", "commitAndPushTask.ts"), "utf8");
    const fn = source.indexOf("export async function stageAndCommitCommitPushV1(");
    const gate = source.indexOf("verifyCommitPushCheckedTreeBeforeStagingV1(resolvedTask)", fn);
    const tryAt = source.indexOf("      try {", gate);
    const add = source.indexOf('runGitCommand(repoRoot, "add"', fn);
    assert.ok(fn > 0 && gate > fn, "stageAndCommitCommitPushV1 must call the gate");
    assert.ok(gate < tryAt && tryAt < add, "the gate must precede the try block and the add");
  });

  it("wiring: both a fresh pass and a reused pass record the checked tree", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "..", "..", "src", "commands", "commitAndPushTask.ts"), "utf8");
    const fn = source.indexOf("export async function runCommitPushCompletionChecksV1(");
    const capture = source.indexOf("noteCommitPushCheckedTreeV1(resolvedTask.taskFolderPath, checkedIdentity)", fn);
    const loopEnd = source.indexOf("while (!lintPayload.passed)", fn);
    assert.ok(loopEnd > fn && capture > loopEnd, "the note follows the checks loop, so it covers fresh and reused passes alike");
    const before = source.indexOf("checkedIdentity = await captureCommitPushCheckedTreeV1(resolvedTask)", fn);
    const firstRun = source.indexOf("checkPublishPreflight(", fn);
    assert.ok(before > fn && before < firstRun, "the identity is captured before the checks start, never after them");
    const anyway = source.indexOf('noteCommitPushCheckedTreeV1(resolvedTask.taskFolderPath, undefined)', fn);
    assert.ok(anyway > loopEnd && anyway < capture, "Publish Anyway records that no pass was relied on");
  });
});

void describe("restart wording follows the result as it is now (bugs3 Step 17)", () => {
  function timedOut(): void {
    noteCommitPushChecksReusedV1(TASK_FOLDER, true);
    recordCommitPushStopV1(TASK_FOLDER, "timedOut", "commitPushFinalScopeConfirmation");
  }

  it("promises no re-run only while the recorded result still matches", () => {
    timedOut();
    assert.match(takeCommitPushStopTextV1(TASK_FOLDER, { checksStillReusable: true }) ?? "", /the checks will not re-run/);
  });

  it("says the checks will run again once the result no longer matches, whatever the earlier flag said", () => {
    timedOut();
    const text = takeCommitPushStopTextV1(TASK_FOLDER, { checksStillReusable: false }) ?? "";
    assert.match(text, /the checks will run again/);
    assert.doesNotMatch(text, /will not re-run/);
  });

  it("keeps the earlier behaviour when the caller does not say", () => {
    timedOut();
    assert.match(takeCommitPushStopTextV1(TASK_FOLDER) ?? "", /the checks will not re-run/);
  });
});

void describe("Commit & Push wiring (bugs3 Step 17)", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "..", "..", "src", "commands", "commitAndPushTask.ts"), "utf8");

  it("a reused result returns before any check is spawned: the confirmation comes next", () => {
    const start = source.indexOf("const runChecks = async");
    const reuseReturn = source.indexOf("return reuse.result;", start);
    const preflight = source.indexOf("checkPublishPreflight(", start);
    assert.ok(start > 0 && reuseReturn > start, "could not find the reuse branch");
    assert.ok(reuseReturn < preflight, "the reuse branch must return before checkPublishPreflight can run");
  });

  it("the final confirmation revalidates a reused pass after the owner answers, before returning confirmed", () => {
    const confirmStart = source.indexOf("export async function confirmCommitPushScopeV1(");
    const answered = source.indexOf('confirmed !== "commitAndPush"', confirmStart);
    const revalidate = source.indexOf("revalidateReusedCommitPushChecksV1(resolvedTask)", answered);
    const confirmed = source.indexOf('kind: "confirmed"', answered);
    assert.ok(answered > confirmStart && revalidate > answered, "revalidation must follow the owner's answer");
    assert.ok(revalidate < confirmed, "revalidation must precede the confirmed result");
  });

  it("every question in the scope and confirmation steps is bound to the operation's token", () => {
    for (const key of [
      "commitPushExistingStagedChanges",
      "commitPushIncludeTaskFolder",
      "commitPushIncludeRunArtifacts",
      "commitPushFinalScopeConfirmation",
    ]) {
      const at = source.indexOf(`decisionKey: "${key}",`);
      assert.ok(at > 0, key);
      assert.match(source.slice(at, at + 80), /\n\s+token,/, `${key} must pass the cancellation token`);
    }
  });

  it("the row hands its operation's token to both steps", () => {
    const row = fs.readFileSync(path.resolve(__dirname, "..", "..", "src", "actions", "rows", "commitPushRowV1.ts"), "utf8");
    assert.match(row, /resolveCommitPushStagingScopeV1\(services\.resolvedTask, op\.token\)/);
    assert.match(row, /scopeResult\.scope,\s+op\.token\s+\)/);
  });
});

void describe("Publish review reuse compares command identity (bugs3 Step 17)", () => {
  it("passes the expected command identity, and reuses nothing when it cannot be determined", () => {
    const review = fs.readFileSync(path.resolve(__dirname, "..", "..", "src", "commands", "reviewActions.ts"), "utf8");
    const at = review.indexOf("const expectedCommandIdentity = computeCommandIdentityV1(");
    assert.ok(at > 0, "the Publish review must compute the expected command identity");
    const call = review.indexOf("checkPublishChecksReuseEligibilityV1(", at);
    assert.ok(call > at);
    assert.match(review.slice(at, call), /expectedCommandIdentity === undefined\s+\? \{ eligible: false/);
    assert.match(review.slice(call, call + 900), /expectedCommandIdentity\s+\)/);
  });
});

describe("unknown command identity is not waived at the last gate (bugs3 Step 17)", () => {
  const unreadableCommands = (): CommitPushTreeReaderV1 => ({
    head: () => Promise.resolve("aaa"),
    fingerprint: () => Promise.resolve("fp1"),
    commandIdentity: () => Promise.resolve(undefined),
  });

  it("stops when neither the checked nor the current command identity is known", async () => {
    noteCommitPushCheckedTreeV1(TASK_FOLDER, { scopeFolder: "/repo", headCommitSha: "aaa", treeFingerprint: "fp1" });
    const outcome = await verifyCommitPushCheckedTreeBeforeStagingV1(TASK, unreadableCommands());
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.match(outcome.detail, /verification commands the checks ran were not identified/);
    }
  });

  it("stops when the checked identity is known but the current commands cannot be read", async () => {
    noteCommitPushCheckedTreeV1(TASK_FOLDER, {
      scopeFolder: "/repo",
      headCommitSha: "aaa",
      treeFingerprint: "fp1",
      commandIdentity: "cmd1",
    });
    const outcome = await verifyCommitPushCheckedTreeBeforeStagingV1(TASK, unreadableCommands());
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.match(outcome.detail, /current verification commands could not be read/);
    }
  });
});
