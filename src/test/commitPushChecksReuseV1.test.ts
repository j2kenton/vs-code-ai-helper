/**
 * bugs3 Step 17: Commit & Push reuses a passing Publish Checks result recorded
 * for exactly this commit, tree, scope and command set, runs fresh (saying why)
 * otherwise, and never calls a timed-out or dismissed confirmation a cancel by
 * the owner. Reported 2026-10-27 (bugs2, Publish).
 */
import * as assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as vscode from "vscode";
import {
  decideCommitPushChecksReuseV1,
  describeReuseRefusalV1,
} from "../utils/commitPushChecksReuseV1";
import {
  estimateChecksMinutesV1,
  lastCompletedPublishChecksV1,
  type LastCompletedPublishChecksV1,
  type PublishChecksOutcomeV1,
} from "../utils/publishChecksOutcomeV1";
import { describeCommitPushFreshRunV1, describeRunChecksNowLabelV1 } from "../commands/commitAndPushTask";
import {
  clearCommitPushStopStateV1,
  describeCommitPushStopV1,
  noteCommitPushChecksReusedV1,
  recordCommitPushStopV1,
  takeCommitPushStopTextV1,
} from "../utils/commitPushStopCauseV1";
import { computeCommandIdentityV1, type PublishChecksReuseEligibilityResultV1 } from "../utils/publishChecksFreshness";

const PASSING_RECORD =
  "<!-- completion-checks:start -->\n### Completion Checks\n\n- Status: Passed\n- Last run: 2026-10-27T18:29:00.000Z\n- Summary: All checks passed.\n<!-- completion-checks:end -->\n";
const FAILING_RECORD =
  "<!-- completion-checks:start -->\n### Completion Checks\n\n- Status: Failed\n- Last run: 2026-10-27T18:29:00.000Z\n- Summary: 1 check failed.\n<!-- completion-checks:end -->\n";
const COMMANDS = ["pnpm run verify"];

type Check = NonNullable<Parameters<typeof decideCommitPushChecksReuseV1>[0]["checkEligibility"]>;

/** An eligibility check that reads `record` through the caller's validator, like the real one. */
function eligibility(result: PublishChecksReuseEligibilityResultV1, record = PASSING_RECORD): Check {
  return (_folder, _scope, _head, validator) => {
    if (result.eligible && validator && !validator(record)) {
      return Promise.resolve({ eligible: false, reason: "Recorded Completion Checks evidence is missing, failed, or unreadable" });
    }
    return Promise.resolve(result);
  };
}

function decide(check: Check, currentCommands: readonly string[] | null = COMMANDS) {
  return decideCommitPushChecksReuseV1({
    taskFolderUri: vscode.Uri.file("/tmp/task"),
    scopeFolder: "/repo",
    headCommitSha: "abc123",
    currentCommands,
    checkEligibility: check,
  });
}

void describe("Commit & Push reuse of a recorded passing result (bugs3 Step 17)", () => {
  void it("reuses a matching passing result and says nothing was re-run", async () => {
    let expectedIdentity: string | undefined;
    const outcome = await decide(async (folder, scope, head, validator, identity) => {
      expectedIdentity = identity;
      return eligibility({ eligible: true, stamp: { completedAt: "2026-10-27T18:29:30.000Z" } as never })(folder, scope, head, validator, identity);
    });
    assert.equal(outcome.reuse, true);
    if (outcome.reuse) {
      assert.equal(outcome.result.passed, true);
      // bugs5 Step 10: "Using the Publish Checks that passed at HH:MM on this code."
      assert.match(outcome.message, /^Using the Publish Checks that passed at \d\d:\d\d on this code\.$/);
    }
    assert.equal(expectedIdentity, computeCommandIdentityV1(COMMANDS), "the check is asked for the commands a fresh run would execute");
  });

  void it("runs fresh, naming the cause, for each way the record cannot be used", async () => {
    const cases: [string, PublishChecksReuseEligibilityResultV1, RegExp][] = [
      ["missing", { eligible: false, reason: "Freshness check failed: missing" }, /no passing Publish Checks result is recorded/],
      ["stale commit", { eligible: false, reason: "Freshness check failed: staleCommit" }, /the commit changed/],
      ["different scope", { eligible: false, reason: "Freshness check failed: scopeMismatch" }, /different verification scope/],
      ["unreadable head", { eligible: false, reason: "Freshness check failed: unreadableHead" }, /current commit could not be read/],
      ["files changed", { eligible: false, reason: "Working tree fingerprint has changed since checks ran" }, /files changed/],
      ["no fingerprint", { eligible: false, reason: "Stamp does not contain a tree fingerprint (ineligible for reuse)" }, /does not say which files/],
      ["legacy record", { eligible: false, reason: "Recorded checks predate command identity, so they cannot show which commands ran (legacy record)" }, /written before the commands it ran were kept/],
      ["different commands", { eligible: false, reason: "The recorded checks ran a different command set than the one now required" }, /not the ones that passed/],
    ];
    for (const [name, result, reason] of cases) {
      const outcome = await decide(eligibility(result));
      assert.equal(outcome.reuse, false, name);
      if (!outcome.reuse) {
        assert.match(outcome.reason, reason, name);
      }
    }
  });

  void it("never reuses a recorded result that does not show a pass", async () => {
    const outcome = await decide(eligibility({ eligible: true }, FAILING_RECORD));
    assert.equal(outcome.reuse, false);
    if (!outcome.reuse) {
      assert.match(outcome.reason, /do not show a pass/);
    }
  });

  void it("cannot match a record to commands it cannot determine, so it runs fresh", async () => {
    let asked = false;
    const outcome = await decide(() => {
      asked = true;
      return Promise.resolve({ eligible: true });
    }, null);
    assert.equal(outcome.reuse, false);
    assert.equal(asked, false, "nothing is read when the command set is unknown");
    const empty = await decide(eligibility({ eligible: true }), []);
    assert.equal(empty.reuse, false);
  });

  void it("treats an unreadable record as a fresh run, never a pass", async () => {
    const outcome = await decide(() => Promise.reject(new Error("EACCES")));
    assert.equal(outcome.reuse, false);
  });

  void it("describes a refusal with no recognised cause without losing the reason", () => {
    assert.equal(describeReuseRefusalV1({ eligible: false, reason: "something new" }), "something new");
    assert.match(describeReuseRefusalV1({ eligible: false }), /could not be confirmed/);
  });

  void it("offers to run the checks now with the last run's length when it is known", () => {
    assert.equal(describeRunChecksNowLabelV1(20), "Run the checks now (about 20 min, based on the last run)");
    assert.equal(describeRunChecksNowLabelV1(undefined), "Run the checks now");
  });

  void it("names the latest run record's own reason, without the internal prefix", () => {
    assert.equal(
      describeReuseRefusalV1({ eligible: false, reason: "Latest run record: the latest Publish Checks run failed (`pnpm run verify`)" }),
      "the latest Publish Checks run failed (`pnpm run verify`)"
    );
  });
});

void describe("the latest run record and a recorded pass (bugs5 Step 10)", () => {
  const PASS: LastCompletedPublishChecksV1 = { outcome: "passed", at: "2026-11-01T05:40:14.000Z", durationMs: 20 * 60_000 };
  const FAIL: LastCompletedPublishChecksV1 = { outcome: "failed", at: "2026-11-01T05:40:14.000Z", failedCommands: ["pnpm run verify"] };
  const eligible = eligibility({ eligible: true, stamp: { completedAt: "2026-11-01T05:40:14.000Z" } as never });

  function decideWith(outcome: PublishChecksOutcomeV1 | undefined) {
    return decideCommitPushChecksReuseV1({
      taskFolderUri: vscode.Uri.file("/tmp/task"),
      scopeFolder: "/repo",
      headCommitSha: "abc123",
      currentCommands: COMMANDS,
      checkEligibility: eligible,
      readOutcome: () => outcome,
    });
  }

  void it("jester's sequence: a pass, then a run interrupted 23 s in on the same tree, still reuses the pass", async () => {
    const interrupted: PublishChecksOutcomeV1 = {
      outcome: "interrupted",
      at: "2026-11-01T07:52:28.000Z",
      finishedCommands: [{ command: "pnpm run check-types", exitCode: 0 }],
      unknownCommands: ["npm run test"],
      lastCompleted: PASS,
    };
    const outcome = await decideWith(interrupted);
    assert.equal(outcome.reuse, true);
  });

  void it("a cancelled run with an earlier pass on the same tree still reuses the pass", async () => {
    const cancelled: PublishChecksOutcomeV1 = { outcome: "cancelled", at: "2026-11-01T17:18:46.000Z", cause: "cancelled from Notifications", lastCompleted: PASS };
    assert.equal((await decideWith(cancelled)).reuse, true);
  });

  void it("an interrupted run whose own settled results include a failure does not reuse the pass, and names it", async () => {
    const interrupted: PublishChecksOutcomeV1 = {
      outcome: "interrupted",
      at: "2026-11-01T07:52:28.000Z",
      finishedCommands: [{ command: "pnpm run lint", exitCode: 1 }],
      unknownCommands: [],
      lastCompleted: PASS,
    };
    const outcome = await decideWith(interrupted);
    assert.equal(outcome.reuse, false);
    if (!outcome.reuse) {
      assert.match(outcome.reason, /had already failed `pnpm run lint`/);
    }
  });

  void it("a later failed run replaces the pass, and names the failing command", async () => {
    const outcome = await decideWith({ outcome: "failed", at: "2026-11-01T09:00:00.000Z", failedCommands: ["pnpm run test"] });
    assert.equal(outcome.reuse, false);
    if (!outcome.reuse) {
      assert.match(outcome.reason, /the latest Publish Checks run failed \(`pnpm run test`\)/);
    }
  });

  void it("an interrupted run after an earlier failure does not reuse anything", async () => {
    const outcome = await decideWith({ outcome: "interrupted", at: "x", finishedCommands: [], unknownCommands: [], lastCompleted: FAIL });
    assert.equal(outcome.reuse, false);
    if (!outcome.reuse) {
      assert.match(outcome.reason, /last Publish Checks run that finished had failed/);
    }
  });

  void it("a run in progress is not a result", async () => {
    const outcome = await decideWith({
      outcome: "running",
      at: "2026-11-01T09:00:00.000Z",
      pid: 1,
      hostname: "h",
      finishedCommands: [],
      runningCommands: [],
      lastCompleted: PASS,
    });
    assert.equal(outcome.reuse, false);
    if (!outcome.reuse) {
      assert.match(outcome.reason, /running right now/);
    }
  });

  void it("with no run record at all the recorded pass is judged on its own", async () => {
    assert.equal((await decideWith(undefined)).reuse, true);
  });

  void it("an earlier pass is what the record carries when the latest one is not a result", () => {
    const record: PublishChecksOutcomeV1 = { outcome: "cancelled", at: "x", cause: "c", lastCompleted: PASS };
    assert.deepEqual(lastCompletedPublishChecksV1(record), PASS);
    assert.deepEqual(lastCompletedPublishChecksV1({ outcome: "passed", at: "y", durationMs: 60_000 }), { outcome: "passed", at: "y", durationMs: 60_000 });
    assert.equal(lastCompletedPublishChecksV1({ outcome: "failed", at: "y", failedCommands: [], reason: "died" }), undefined);
    assert.equal(estimateChecksMinutesV1(record), 20);
    assert.equal(estimateChecksMinutesV1(undefined), undefined);
  });

  void it("says why the checks run again, with the last run's duration when known", () => {
    assert.equal(
      describeCommitPushFreshRunV1("files changed since the Publish Checks passed", 35),
      "Running the Publish Checks again before committing: files changed since the Publish Checks passed. The last run took about 35 min."
    );
    assert.equal(
      describeCommitPushFreshRunV1("no passing Publish Checks result is recorded for this task", undefined),
      "Running the Publish Checks again before committing: no passing Publish Checks result is recorded for this task."
    );
  });
});

void describe("what stopped a Commit & Push is named, never 'cancelled by the owner' (bugs3 Step 17)", () => {
  const TASK = "/tmp/tasks/commit-push-stop";
  afterEach(() => clearCommitPushStopStateV1(TASK));

  void it("a timed-out confirmation says it timed out, names the step, and that the checks will not re-run when they were reused", () => {
    recordCommitPushStopV1(TASK, "timedOut", "commitPushFinalScopeConfirmation");
    noteCommitPushChecksReusedV1(TASK, true);
    const text = takeCommitPushStopTextV1(TASK);
    assert.match(text ?? "", /not confirmed within 10 minutes/);
    assert.match(text ?? "", /confirmation of what will be committed and where it goes/);
    assert.match(text ?? "", /nothing was committed or pushed/);
    assert.match(text ?? "", /the checks will not re-run/);
    assert.doesNotMatch(text ?? "", /cancelled/i);
  });

  void it("does not promise skipped checks unless this attempt reused a recorded result", () => {
    recordCommitPushStopV1(TASK, "timedOut", "commitPushFinalScopeConfirmation");
    const text = takeCommitPushStopTextV1(TASK);
    assert.match(text ?? "", /the checks will run again/);
    assert.doesNotMatch(text ?? "", /will not re-run/);
  });

  void it("an interruption names the reload, and a dismissal names the dismissed step", () => {
    assert.match(
      describeCommitPushStopV1({ kind: "interrupted", step: "the commit message confirmation" }, false),
      /interrupted before the commit message confirmation was answered \(a reload/
    );
    const dismissed = describeCommitPushStopV1({ kind: "dismissed", step: "the failing-checks question" }, false);
    assert.match(dismissed, /^The failing-checks question was dismissed/);
    assert.doesNotMatch(dismissed, /cancelled/i);
  });

  void it("is read once, and says nothing when no cause was recorded", () => {
    recordCommitPushStopV1(TASK, "dismissed", "commitPushReviewMessage");
    assert.ok(takeCommitPushStopTextV1(TASK));
    assert.equal(takeCommitPushStopTextV1(TASK), undefined);
    assert.equal(takeCommitPushStopTextV1("/tmp/tasks/never-recorded"), undefined);
  });

  void it("a new attempt forgets an earlier attempt's cause and reuse note", () => {
    recordCommitPushStopV1(TASK, "timedOut", "commitPushFinalScopeConfirmation");
    noteCommitPushChecksReusedV1(TASK, true);
    clearCommitPushStopStateV1(TASK);
    assert.equal(takeCommitPushStopTextV1(TASK), undefined);
  });
});
