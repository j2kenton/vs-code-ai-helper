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
      assert.match(outcome.message, /2026-10-27T18:29:30/);
      assert.match(outcome.message, /not run again/);
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
