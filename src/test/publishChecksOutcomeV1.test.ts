/**
 * bugs3 Step 12: a Publish Checks run always ends with a recorded outcome
 * (passed, failed with which command, cancelled and by what), and
 * `publish-review.md`'s status line follows it — including a run cut short by a
 * pause, a resume or a cancel, which used to leave "Not yet reviewed" and no
 * trace of what happened.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import * as vscode from "vscode";

import { STAGE_ARTIFACT_FILENAMES } from "../types/taskProgress";
import {
  describePublishCancelSourceV1,
  PUBLISH_CHECKS_OUTCOME_FILENAME_V1,
  publishStatusLineForOutcomeV1,
  readPublishChecksOutcomeV1,
  recordPublishChecksOutcomeV1,
  recordPublishChecksRunningV1,
  recoverAbandonedPublishChecksRunV1,
  settleUnrecordedPublishChecksRunV1,
} from "../utils/publishChecksOutcomeV1";
import { ensurePublishReviewArtifactExistsV1 } from "../utils/publishChecksFreshness";

const folders: string[] = [];

function taskFolder(): { readonly dir: string; readonly uri: vscode.Uri; readonly report: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ens-publish-outcome-"));
  folders.push(dir);
  return { dir, uri: vscode.Uri.file(dir), report: path.join(dir, STAGE_ARTIFACT_FILENAMES.publish ?? "publish-review.md") };
}

afterEach(() => {
  for (const dir of folders.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const AT = "2026-10-30T10:00:00.000Z";

void describe("who stopped the run, in plain words (bugs3 Step 12)", () => {
  void it("names each cancellation source and says so when none was recorded", () => {
    assert.match(describePublishCancelSourceV1("notifications"), /Notifications/);
    assert.match(describePublishCancelSourceV1("chat"), /chat/);
    assert.match(describePublishCancelSourceV1("viewer"), /another window/);
    assert.match(describePublishCancelSourceV1("command"), /pause or resume/);
    assert.match(describePublishCancelSourceV1(undefined), /not recorded/);
    assert.match(describePublishCancelSourceV1("unknown"), /not recorded/);
  });
});

void describe("status line for each outcome (bugs3 Step 12)", () => {
  void it("a cancelled run says nothing was recorded as passed or failed, and what to do", () => {
    const line = publishStatusLineForOutcomeV1({ outcome: "cancelled", at: AT, cause: "cancelled from Notifications" });
    assert.match(line ?? "", /Publish Checks were cancelled\*\* \(cancelled from Notifications\)/);
    assert.match(line ?? "", /Nothing was recorded as passed or failed/);
    assert.match(line ?? "", /run Publish Checks again/);
  });

  void it("a run that broke before finishing says it did not finish; red checks keep their own wording", () => {
    assert.match(
      publishStatusLineForOutcomeV1({ outcome: "failed", at: AT, failedCommands: [], reason: "spawn ENOENT" }) ?? "",
      /did not finish\*\* \(spawn ENOENT\)/
    );
    assert.equal(publishStatusLineForOutcomeV1({ outcome: "failed", at: AT, failedCommands: ["npm run test"] }), undefined);
    assert.equal(publishStatusLineForOutcomeV1({ outcome: "passed", at: AT }), undefined);
  });
});

void describe("recording the outcome (bugs3 Step 12)", () => {
  void it("a cancelled run is stored with its cause and replaces 'Not yet reviewed' in the report", async () => {
    const task = taskFolder();
    await ensurePublishReviewArtifactExistsV1(task.uri);
    assert.match(fs.readFileSync(task.report, "utf8"), /Not yet reviewed/);

    await recordPublishChecksOutcomeV1(task.uri, {
      outcome: "cancelled",
      at: AT,
      cause: describePublishCancelSourceV1("command"),
      operationId: "op-1",
    });

    assert.deepEqual(readPublishChecksOutcomeV1(task.dir), {
      version: 1,
      outcome: "cancelled",
      at: AT,
      cause: "stopped by a command (a pause or resume of the task)",
      operationId: "op-1",
    });
    const report = fs.readFileSync(task.report, "utf8");
    assert.match(report, /Publish Checks were cancelled\*\* \(stopped by a command/);
    assert.doesNotMatch(report, /Not yet reviewed/);
  });

  void it("creates the report when the run was cancelled before one existed", async () => {
    const task = taskFolder();
    await recordPublishChecksOutcomeV1(task.uri, { outcome: "cancelled", at: AT, cause: "cancelled from the chat" });
    assert.match(fs.readFileSync(task.report, "utf8"), /Publish Checks were cancelled/);
  });

  void it("a failed run names the commands that failed and leaves the report's own status line to the checks", async () => {
    const task = taskFolder();
    await ensurePublishReviewArtifactExistsV1(task.uri);
    const before = fs.readFileSync(task.report, "utf8");
    await recordPublishChecksOutcomeV1(task.uri, { outcome: "failed", at: AT, failedCommands: ["npm run test"] });
    const outcome = readPublishChecksOutcomeV1(task.dir);
    assert.equal(outcome?.outcome, "failed");
    assert.deepEqual(outcome?.outcome === "failed" ? outcome.failedCommands : undefined, ["npm run test"]);
    assert.equal(fs.readFileSync(task.report, "utf8"), before, "the Completion Checks section already describes red checks");
  });

  void it("the latest outcome wins: a passing run after a cancelled one is what is recorded", async () => {
    const task = taskFolder();
    await recordPublishChecksOutcomeV1(task.uri, { outcome: "cancelled", at: AT, cause: "cancelled from the chat" });
    await recordPublishChecksOutcomeV1(task.uri, { outcome: "passed", at: "2026-10-30T11:00:00.000Z" });
    assert.equal(readPublishChecksOutcomeV1(task.dir)?.outcome, "passed");
  });

  void it("does not overwrite a real Publish review with the cancelled line", async () => {
    const task = taskFolder();
    fs.writeFileSync(task.report, "# Publish Review\n\nReadiness: 8/10\n\nReady to publish.\n");
    await recordPublishChecksOutcomeV1(task.uri, { outcome: "cancelled", at: AT, cause: "cancelled from the chat" });
    assert.equal(fs.readFileSync(task.report, "utf8"), "# Publish Review\n\nReadiness: 8/10\n\nReady to publish.\n");
    assert.equal(readPublishChecksOutcomeV1(task.dir)?.outcome, "cancelled", "the outcome is still recorded");
  });

  void it("reads a missing, damaged or foreign file as no outcome", () => {
    const task = taskFolder();
    assert.equal(readPublishChecksOutcomeV1(task.dir), undefined);
    const file = path.join(task.dir, PUBLISH_CHECKS_OUTCOME_FILENAME_V1);
    fs.writeFileSync(file, "{not json");
    assert.equal(readPublishChecksOutcomeV1(task.dir), undefined);
    fs.writeFileSync(file, JSON.stringify({ outcome: "cancelled", at: AT }));
    assert.equal(readPublishChecksOutcomeV1(task.dir), undefined, "a cancelled record without a cause is not trusted");
  });

  void it("never throws when the folder cannot be written", async () => {
    await assert.doesNotReject(
      recordPublishChecksOutcomeV1(vscode.Uri.file(path.join(os.tmpdir(), "ens-no-such-folder", "x")), {
        outcome: "cancelled",
        at: AT,
        cause: "cancelled from the chat",
      })
    );
  });
});

void describe("wiring in runPublishChecks (bugs3 Step 12)", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "..", "..", "src", "commands", "runPublishChecks.ts"), "utf8");

  void it("a pass or failure is recorded before the freshness stamp, on the success path", () => {
    const checksPassed = source.indexOf("const checksPassed = Boolean(result.passedModuloKnownFlakes ?? result.passed);");
    const record = source.indexOf("recordPublishChecksOutcomeV1(", checksPassed);
    const stamp = source.indexOf("const freshStampWritten", checksPassed);
    assert.ok(checksPassed > 0 && record > checksPassed && record < stamp);
  });

  void it("a cancelled run is recorded with its cause before the notice is shown", () => {
    const catchCancelled = source.indexOf("if (error instanceof PublishChecksCancelledError)");
    const record = source.indexOf('outcome: "cancelled"', catchCancelled);
    const notice = source.indexOf("const cancelledNotice", catchCancelled);
    assert.ok(catchCancelled > 0 && record > catchCancelled && record < notice);
    assert.match(source.slice(notice, notice + 200), /Cause: \$\{cancelCause\}/);
  });

  void it("a run that died on an error is recorded as failed before it is settled", () => {
    const generic = source.indexOf("const errorMessage = error instanceof Error ? error.message : String(error);");
    const record = source.indexOf('outcome: "failed"', generic);
    const settle = source.indexOf('operation.settleAs("failed", `Publish Checks failed:', generic);
    assert.ok(generic > 0 && record > generic && record < settle);
  });
});

/** Waits for the running record's queued updates (a settle of an operation that does not exist is a no-op). */
async function settleQueue(uri: vscode.Uri): Promise<void> {
  await settleUnrecordedPublishChecksRunV1(uri, "__no-such-operation__");
}

void describe("durable running record and abandoned-run recovery (bugs3 Step 12)", () => {
  void it("records the run before any command, tracks each command, and never reads as a result", async () => {
    const task = taskFolder();
    const hooks = await recordPublishChecksRunningV1(task.uri, "op-7");
    const started = readPublishChecksOutcomeV1(task.dir);
    assert.equal(started?.outcome, "running");
    assert.equal(started?.outcome === "running" ? started.pid : undefined, process.pid);
    hooks.commandStarted("npm run test");
    hooks.commandStarted("npm run lint");
    hooks.commandSettled("npm run lint");
    await settleQueue(task.uri);
    const mid = readPublishChecksOutcomeV1(task.dir);
    assert.deepEqual(mid?.outcome === "running" ? mid.runningCommands : undefined, ["npm run test"]);
    assert.deepEqual(mid?.outcome === "running" ? mid.finishedCommands : undefined, [{ command: "npm run lint" }]);
    assert.equal(publishStatusLineForOutcomeV1(mid!), undefined, "a running record never rewrites the report status");
  });

  void it("bugs4 item 33: publish-review.md says the checks are running, not still showing the previous run's result", async () => {
    const task = taskFolder();
    await ensurePublishReviewArtifactExistsV1(task.uri);
    await recordPublishChecksRunningV1(task.uri, "op-run");
    const report = fs.readFileSync(task.report, "utf8");
    assert.match(report, /Publish Checks are running\*\* \(started \d{4}-\d{2}-\d{2}T/);
    assert.match(report, /earlier run and is out of date/);
    // A cancelled run replaces the running line with its own status.
    await recordPublishChecksOutcomeV1(task.uri, { outcome: "cancelled", at: AT, cause: "cancelled from Notifications", operationId: "op-run" });
    const after = fs.readFileSync(task.report, "utf8");
    assert.doesNotMatch(after, /Publish Checks are running/);
    assert.match(after, /Publish Checks were cancelled/);
  });

  void it("a terminal outcome replaces the running record and a late command update cannot bring it back", async () => {
    const task = taskFolder();
    const hooks = await recordPublishChecksRunningV1(task.uri, "op-8");
    hooks.commandStarted("npm run test");
    await recordPublishChecksOutcomeV1(task.uri, { outcome: "passed", at: AT, operationId: "op-8" });
    hooks.commandSettled("npm run test");
    await settleQueue(task.uri);
    assert.equal(readPublishChecksOutcomeV1(task.dir)?.outcome, "passed");
  });

  void it("another run's record is not touched by a stale run's updates", async () => {
    const task = taskFolder();
    const first = await recordPublishChecksRunningV1(task.uri, "op-A");
    const second = await recordPublishChecksRunningV1(task.uri, "op-B");
    first.commandStarted("stale command");
    second.commandStarted("npm run test");
    await settleQueue(task.uri);
    const record = readPublishChecksOutcomeV1(task.dir);
    assert.equal(record?.outcome === "running" ? record.operationId : undefined, "op-B");
    assert.deepEqual(record?.outcome === "running" ? record.runningCommands : undefined, ["npm run test"]);
  });

  void it("recovers a run whose process is gone as interrupted, naming what finished and what is unknown", async () => {
    const task = taskFolder();
    await ensurePublishReviewArtifactExistsV1(task.uri);
    fs.writeFileSync(
      path.join(task.dir, PUBLISH_CHECKS_OUTCOME_FILENAME_V1),
      JSON.stringify({
        version: 1,
        outcome: "running",
        at: AT,
        operationId: "op-9",
        pid: 424242,
        hostname: os.hostname(),
        finishedCommands: [{ command: "npm run lint" }],
        runningCommands: ["npm run test"],
      })
    );
    const recovered = await recoverAbandonedPublishChecksRunV1(task.uri, { isProcessAlive: () => false });
    assert.equal(recovered, true);
    const outcome = readPublishChecksOutcomeV1(task.dir);
    assert.equal(outcome?.outcome, "interrupted");
    assert.deepEqual(outcome?.outcome === "interrupted" ? outcome.unknownCommands : undefined, ["npm run test"]);
    const report = fs.readFileSync(task.report, "utf8");
    assert.match(report, /Publish Checks were interrupted/);
    assert.match(report, /1 command\(s\) had finished and 1 were still running, so their result is unknown/);
    assert.match(report, /Nothing was recorded as passed/);
    assert.doesNotMatch(report, /Not yet reviewed/);
  });

  void it("a host lost during the preflight replaces the previous result with an interrupted one and never a pass", async () => {
    const task = taskFolder();
    await ensurePublishReviewArtifactExistsV1(task.uri);
    // The previous run passed; the new run writes its running record at the start of the preflight.
    await recordPublishChecksOutcomeV1(task.uri, { outcome: "passed", at: AT });
    await recordPublishChecksRunningV1(task.uri, "op-preflight");
    assert.equal(readPublishChecksOutcomeV1(task.dir)?.outcome, "running", "the old passed result no longer stands as this run's");
    // The host dies before any command starts; activation recovery settles it.
    const recovered = await recoverAbandonedPublishChecksRunV1(task.uri, { ownRunIsLive: () => false });
    assert.equal(recovered, true);
    const outcome = readPublishChecksOutcomeV1(task.dir);
    assert.equal(outcome?.outcome, "interrupted");
    assert.equal(outcome?.outcome === "interrupted" ? outcome.operationId : undefined, "op-preflight");
    const report = fs.readFileSync(task.report, "utf8");
    assert.match(report, /No command had started yet/);
    assert.match(report, /Nothing was recorded as passed/);
  });

  void it("leaves a live process's run, another machine's run, and a settled run alone", async () => {
    const task = taskFolder();
    const file = path.join(task.dir, PUBLISH_CHECKS_OUTCOME_FILENAME_V1);
    const running = (over: Record<string, unknown>): string =>
      JSON.stringify({
        version: 1,
        outcome: "running",
        at: AT,
        pid: 424242,
        hostname: os.hostname(),
        finishedCommands: [],
        runningCommands: [],
        ...over,
      });
    fs.writeFileSync(file, running({}));
    assert.equal(await recoverAbandonedPublishChecksRunV1(task.uri, { isProcessAlive: () => true }), false, "owner alive");
    fs.writeFileSync(file, running({ hostname: "some-other-machine" }));
    assert.equal(await recoverAbandonedPublishChecksRunV1(task.uri, { isProcessAlive: () => false }), false, "cannot judge another host");
    fs.writeFileSync(file, JSON.stringify({ version: 1, outcome: "passed", at: AT }));
    assert.equal(await recoverAbandonedPublishChecksRunV1(task.uri, { isProcessAlive: () => false }), false, "already settled");
    assert.equal(readPublishChecksOutcomeV1(task.dir)?.outcome, "passed");
  });

  void it("this process's own record is abandoned at activation but kept while its run is live", async () => {
    const task = taskFolder();
    await recordPublishChecksRunningV1(task.uri, "op-own");
    assert.equal(await recoverAbandonedPublishChecksRunV1(task.uri, { ownRunIsLive: () => true }), false);
    assert.equal(readPublishChecksOutcomeV1(task.dir)?.outcome, "running");
    assert.equal(await recoverAbandonedPublishChecksRunV1(task.uri, { ownRunIsLive: () => false }), true);
    assert.equal(readPublishChecksOutcomeV1(task.dir)?.outcome, "interrupted");
  });

  void it("a run that exits without recording is settled as not finished, never as passed", async () => {
    const task = taskFolder();
    await recordPublishChecksRunningV1(task.uri, "op-10");
    assert.equal(await settleUnrecordedPublishChecksRunV1(task.uri, "op-10"), true);
    const outcome = readPublishChecksOutcomeV1(task.dir);
    assert.equal(outcome?.outcome, "failed");
    assert.match(outcome?.outcome === "failed" ? (outcome.reason ?? "") : "", /without recording a result/);
    assert.equal(await settleUnrecordedPublishChecksRunV1(task.uri, "op-10"), false, "nothing left to settle");
  });

  void it("Publish Checks wires the running record, per-command progress and the last-resort settle", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "..", "..", "src", "commands", "runPublishChecks.ts"), "utf8");
    const running = source.indexOf("recordPublishChecksRunningV1(taskFolderUri, operation.id)");
    const preflight = source.indexOf("const beforeSha = await resolveHeadCommitSha(scopeGuess)");
    assert.ok(running > 0 && running < preflight, "recorded before the preflight");
    assert.match(source, /onCheckEvent: \{[\s\S]*runningRecord\.commandStarted/);
    assert.match(source, /settleUnrecordedPublishChecksRunV1\(taskFolderUri, operation\.id\)/);
    // A throw anywhere after the running record (preflight or the progress host) settles it too.
    assert.match(source, /\}\)\(\)\.catch\(settleOnUnexpectedError\)/);
    assert.match(source, /\)\)\.catch\(settleOnUnexpectedError\)/);
  });

  void it("settling with a reason records that reason instead of the generic one", async () => {
    const task = taskFolder();
    await recordPublishChecksRunningV1(task.uri, "op-11");
    assert.equal(await settleUnrecordedPublishChecksRunV1(task.uri, "op-11", "disk full"), true);
    const outcome = readPublishChecksOutcomeV1(task.dir);
    assert.equal(outcome?.outcome === "failed" ? outcome.reason : undefined, "disk full");
  });
});

void describe("per-command exit codes in the running record (bugs3 Step 12)", () => {
  void it("keeps each finished command's exit code and settles one entry when two share a command line", async () => {
    const task = taskFolder();
    const hooks = await recordPublishChecksRunningV1(task.uri, "op-exit");
    hooks.commandStarted("npm run test");
    hooks.commandStarted("npm run test");
    hooks.commandSettled("npm run test", 1);
    await settleQueue(task.uri);
    const record = readPublishChecksOutcomeV1(task.dir);
    assert.deepEqual(record?.outcome === "running" ? record.runningCommands : undefined, ["npm run test"]);
    assert.deepEqual(record?.outcome === "running" ? record.finishedCommands : undefined, [
      { command: "npm run test", exitCode: 1 },
    ]);
  });

  void it("an interrupted status line says which finished commands passed and which failed", () => {
    const line = publishStatusLineForOutcomeV1({
      outcome: "interrupted",
      at: AT,
      finishedCommands: [
        { command: "npm run lint", exitCode: 0 },
        { command: "npm run test", exitCode: 1 },
      ],
      unknownCommands: ["npm run build"],
    });
    assert.match(line ?? "", /2 command\(s\) had finished \(1 passed, 1 failed: `npm run test`\) and 1 were still running/);
    assert.match(line ?? "", /Nothing was recorded as passed/);
  });

  void it("the admission preflight runs inside the tracked operation, so Cancel has a target and a refusal is an operation outcome", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "commands", "runPublishChecks.ts"), "utf8");
    const trackedAt = source.indexOf("runTrackedOperation(\n      lockKey");
    assert.ok(trackedAt > 0, "runPublishChecks must register a tracked operation");
    const runningAt = source.indexOf("recordPublishChecksRunningV1(taskFolderUri");
    // The read-only stage check precedes the durable running record; the slower preflight follows
    // it, so a host lost during pause reconciliation or the model check leaves an interruptible record.
    const stageAt = source.indexOf("readTaskProgressStrictV1(taskFolderUri)");
    assert.ok(stageAt > trackedAt && stageAt < runningAt, "the stage check runs inside the operation, before the running record");
    for (const preflight of [
      "reconcileWatchdogPauseAgainstAdmissionV1(taskFolderUri)",
      'ensureStageModelConfigured(taskFolderUri, "publish"',
    ]) {
      const at = source.indexOf(preflight);
      assert.ok(at > runningAt, `${preflight} must run after the durable running record exists`);
    }
    assert.match(source, /operation\.settleAs\("refused", reason\)/, "a preflight refusal settles the operation as refused");
    // The refusal and the cancel both leave a durable result before the operation settles.
    const refuseAt = source.indexOf("const refusePreflight = async");
    assert.ok(refuseAt > 0);
    assert.ok(
      source.indexOf("recordPublishChecksOutcomeV1(taskFolderUri", refuseAt) < source.indexOf('operation.settleAs("refused", reason)', refuseAt),
      "a refusal records its outcome before the operation settles"
    );
    const cancelAt = source.indexOf("const cancelPreflight = async");
    assert.ok(cancelAt > 0);
    assert.match(
      source.slice(cancelAt, source.indexOf('operation.settleAs("cancelled"', cancelAt)),
      /outcome: "cancelled"/,
      "a preflight cancel records a cancelled outcome before the operation settles"
    );
    assert.match(source, /operation\.settleAs\("cancelled", `Publish Checks were cancelled before any command started/);
  });
});
