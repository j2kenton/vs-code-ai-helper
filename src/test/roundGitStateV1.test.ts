import * as assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import {
  acknowledgeRoundGitStashInterferenceV1,
  captureRoundGitStateV1,
  compareRoundGitStateV1,
  inspectRoundGitInterferenceV1,
  keepWorkingTreeVersionForUnmergedPathV1,
  withRoundGitStateObservationV1,
  type RoundGitObservationRecordV1,
} from "../utils/roundGitStateV1";

void describe("round Git state snapshots (Step 16 groundwork)", () => {
  let root: string;
  const execFileAsync = promisify(execFile);
  const git = (cwd: string, ...args: string[]): void => {
    execFileSync("git", args, { cwd, stdio: "ignore" });
  };
  const gitOutput = async (cwd: string, ...args: string[]): Promise<string> => {
    const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
    return result.stdout;
  };

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "round-git-state-"));
    git(root, "init", "-q");
    git(root, "config", "user.email", "test@example.invalid");
    git(root, "config", "user.name", "Round Git Test");
    fs.writeFileSync(path.join(root, "conflict.txt"), "base\n");
    git(root, "add", "conflict.txt");
    git(root, "commit", "-qm", "base");
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  void it("records unmerged index stages and stash changes without claiming attribution", async () => {
    const before = await captureRoundGitStateV1({ repositoryRoot: root, taskFolderPath: root, roundId: "r1", now: new Date("2026-01-01T00:00:00Z") });
    fs.writeFileSync(path.join(root, "conflict.txt"), "stash version\n");
    git(root, "stash", "push", "-m", "round snapshot test");
    fs.writeFileSync(path.join(root, "conflict.txt"), "working version\n");
    git(root, "add", "conflict.txt");
    git(root, "commit", "-qm", "diverged working version");
    try {
      execFileSync("git", ["stash", "pop"], { cwd: root, stdio: "ignore" });
    } catch {
      // A conflicting pop returns non-zero while intentionally leaving the
      // unmerged index and stash entry in place for the before/after check.
    }
    const after = await captureRoundGitStateV1({ repositoryRoot: root, taskFolderPath: root, roundId: "r1", operationId: "op1", now: new Date("2026-01-01T00:01:00Z") });
    const delta = compareRoundGitStateV1(before, after);
    assert.deepEqual(delta.newUnmergedPaths, ["conflict.txt"]);
    assert.ok(delta.changedIndexEntries.includes("conflict.txt"));
    assert.equal(delta.addedStashes.length, 1);
    assert.equal(delta.attribution, "observed-unattributed");
    assert.equal(after.operationId, "op1");
    assert.equal(after.observedAt, "2026-01-01T00:01:00.000Z");
    const repeated = await captureRoundGitStateV1({ repositoryRoot: root, taskFolderPath: root, roundId: "r2", operationId: "op2" });
    assert.deepEqual(compareRoundGitStateV1(after, repeated).newUnmergedPaths, [], "a conflict already present in the before snapshot is not attributed to the next round");
  });

  void it("persists before/after evidence from the shared round wrapper when the round fails", async () => {
    const task = fs.mkdtempSync(path.join(os.tmpdir(), "round-git-observation-"));
    try {
      git(task, "init", "-q");
      git(task, "config", "user.email", "test@example.invalid");
      git(task, "config", "user.name", "Round Git Test");
      fs.writeFileSync(path.join(task, "tracked.txt"), "base\n");
      git(task, "add", "tracked.txt");
      git(task, "commit", "-qm", "base");
      await assert.rejects(
        withRoundGitStateObservationV1({ taskFolderPath: task, roundId: "round-failed", operationId: "operation-failed" }, () => {
          fs.writeFileSync(path.join(task, "tracked.txt"), "changed\n");
          git(task, "add", "tracked.txt");
          return Promise.reject(new Error("provider failed"));
        }),
        /provider failed/
      );
      const evidencePath = path.join(task, "round-git-state-v1", "operation-failed.json");
      const recordValue = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as unknown;
      assert.ok(recordValue && typeof recordValue === "object");
      const record = recordValue as Record<string, unknown>;
      assert.equal(record["roundId"], "round-failed");
      assert.equal(record["operationId"], "operation-failed");
      assert.ok((record["before"] as Record<string, unknown>)["observedAt"]);
      assert.ok((record["after"] as Record<string, unknown>)["observedAt"]);
      assert.deepEqual((record["delta"] as Record<string, unknown>)["changedIndexEntries"], ["tracked.txt"]);
    } finally {
      fs.rmSync(task, { recursive: true, force: true });
    }
  });

  void it("persists the before snapshot before invoking the provider callback", async () => {
    const task = fs.mkdtempSync(path.join(os.tmpdir(), "round-git-before-durable-"));
    try {
      git(task, "init", "-q");
      git(task, "config", "user.email", "test@example.invalid");
      git(task, "config", "user.name", "Round Git Test");
      fs.writeFileSync(path.join(task, "tracked.txt"), "base\n");
      git(task, "add", "tracked.txt");
      git(task, "commit", "-qm", "base");
      await withRoundGitStateObservationV1(
        { taskFolderPath: task, roundId: "round-before", operationId: "operation-before" },
        () => {
          const persisted = JSON.parse(fs.readFileSync(path.join(task, "round-git-state-v1", "operation-before.json"), "utf8")) as unknown;
          assert.ok(persisted && typeof persisted === "object");
          assert.ok((persisted as Record<string, unknown>)["before"]);
          return Promise.resolve(undefined);
        }
      );
    } finally {
      fs.rmSync(task, { recursive: true, force: true });
    }
  });

  void it("reconstructs terminal Git evidence after an interrupted operation left only its before snapshot", async () => {
    const task = fs.mkdtempSync(path.join(os.tmpdir(), "round-git-interrupted-evidence-"));
    try {
      git(task, "init", "-q");
      git(task, "config", "user.email", "test@example.invalid");
      git(task, "config", "user.name", "Round Git Test");
      fs.writeFileSync(path.join(task, "conflict.txt"), "base\n");
      git(task, "add", "conflict.txt");
      git(task, "commit", "-qm", "base");
      const before = await captureRoundGitStateV1({ repositoryRoot: task, taskFolderPath: task, roundId: "round-interrupted", operationId: "operation-interrupted" });
      const evidenceFolder = path.join(task, "round-git-state-v1");
      fs.mkdirSync(evidenceFolder);
      const interrupted: RoundGitObservationRecordV1 = {
        version: 1,
        roundId: "round-interrupted",
        operationId: "operation-interrupted",
        taskFolderPath: task,
        repositoryRoot: task,
        before,
      };
      const evidencePath = path.join(evidenceFolder, "operation-interrupted.json");
      fs.writeFileSync(evidencePath, `${JSON.stringify(interrupted)}\n`);
      fs.writeFileSync(path.join(task, "conflict.txt"), "changed before the interrupted round exited\n");
      git(task, "add", "conflict.txt");

      const hold = await inspectRoundGitInterferenceV1(task);
      assert.deepEqual(hold.unmergedPaths, []);
      const recoveredValue = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as unknown;
      assert.ok(recoveredValue && typeof recoveredValue === "object");
      const recovered = recoveredValue as Record<string, unknown>;
      assert.ok(recovered["after"]);
      assert.deepEqual((recovered["delta"] as Record<string, unknown>)["changedIndexEntries"], ["conflict.txt"]);
    } finally {
      fs.rmSync(task, { recursive: true, force: true });
    }
  });

  void it("does not finalize a live before-only observation and recovers it after that operation ends", async () => {
    const task = fs.mkdtempSync(path.join(os.tmpdir(), "round-git-live-observation-"));
    try {
      git(task, "init", "-q");
      git(task, "config", "user.email", "test@example.invalid");
      git(task, "config", "user.name", "Round Git Test");
      fs.writeFileSync(path.join(task, "tracked.txt"), "base\n");
      git(task, "add", "tracked.txt");
      git(task, "commit", "-qm", "base");
      const before = await captureRoundGitStateV1({ repositoryRoot: task, taskFolderPath: task, roundId: "round-live", operationId: "operation-live" });
      const evidenceFolder = path.join(task, "round-git-state-v1");
      fs.mkdirSync(evidenceFolder);
      const evidencePath = path.join(evidenceFolder, "operation-live.json");
      fs.writeFileSync(evidencePath, `${JSON.stringify({ version: 1, roundId: "round-live", operationId: "operation-live", taskFolderPath: task, repositoryRoot: task, before })}\n`);

      assert.deepEqual(await inspectRoundGitInterferenceV1(task, { liveOperationIds: new Set(["operation-live"]) }), {
        unmergedPaths: [],
        stashOperationIds: [],
      });
      let stillBeforeOnly = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as Record<string, unknown>;
      assert.equal(stillBeforeOnly["after"], undefined, "a concurrent inspection must not close evidence for a live round");

      fs.writeFileSync(path.join(task, "tracked.txt"), "changed by live operation\n");
      git(task, "add", "tracked.txt");
      assert.deepEqual(await inspectRoundGitInterferenceV1(task), { unmergedPaths: [], stashOperationIds: [] });
      stillBeforeOnly = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as Record<string, unknown>;
      assert.ok(stillBeforeOnly["after"]);
      assert.deepEqual((stillBeforeOnly["delta"] as Record<string, unknown>)["changedIndexEntries"], ["tracked.txt"]);
    } finally {
      fs.rmSync(task, { recursive: true, force: true });
    }
  });

  void it("holds later rounds until conflicts are staged explicitly and stash changes acknowledged", async () => {
    const task = fs.mkdtempSync(path.join(os.tmpdir(), "round-git-interference-hold-"));
    try {
      git(task, "init", "-q");
      git(task, "config", "user.email", "test@example.invalid");
      git(task, "config", "user.name", "Round Git Test");
      fs.writeFileSync(path.join(task, "conflict.txt"), "base\n");
      fs.writeFileSync(path.join(task, "unrelated.txt"), "base\n");
      git(task, "add", "conflict.txt", "unrelated.txt");
      git(task, "commit", "-qm", "base");
      fs.writeFileSync(path.join(task, "unrelated.txt"), "owner staged change\n");
      git(task, "add", "unrelated.txt");

      await withRoundGitStateObservationV1(
        { taskFolderPath: task, roundId: "round-conflict", operationId: "operation-conflict" },
        () => {
          fs.writeFileSync(path.join(task, "conflict.txt"), "stashed version\n");
          git(task, "stash", "push", "-m", "captured round interference");
          fs.writeFileSync(path.join(task, "conflict.txt"), "working-tree version\n");
          git(task, "add", "conflict.txt");
          git(task, "commit", "-qm", "working-tree version");
          try {
            execFileSync("git", ["stash", "pop"], { cwd: task, stdio: "ignore" });
          } catch {
            // A conflicting pop is the state under test.
          }
          return Promise.resolve(undefined);
        }
      );

      const holdBefore = await inspectRoundGitInterferenceV1(task);
      assert.deepEqual(holdBefore.unmergedPaths, ["conflict.txt"]);
      assert.deepEqual(holdBefore.stashOperationIds, ["operation-conflict"]);
      assert.equal(holdBefore.stashObservations?.[0]?.attribution, "observed-unattributed");
      assert.match(holdBefore.stashObservations?.[0]?.observedFrom ?? "", /^\d{4}-\d{2}-\d{2}T/);
      assert.match(holdBefore.stashObservations?.[0]?.added[0]?.subject ?? "", /captured round interference/);
      await keepWorkingTreeVersionForUnmergedPathV1(task, "conflict.txt");
      const heldForStashOnly = await inspectRoundGitInterferenceV1(task);
      assert.deepEqual(heldForStashOnly.unmergedPaths, []);
      assert.deepEqual(heldForStashOnly.stashOperationIds, ["operation-conflict"]);
      assert.equal(heldForStashOnly.stashObservations?.[0]?.attribution, "observed-unattributed");
      assert.ok(heldForStashOnly.stashObservations?.[0]?.observedFrom);
      assert.ok(heldForStashOnly.stashObservations?.[0]?.observedUntil);
      await acknowledgeRoundGitStashInterferenceV1(task, "operation-conflict");
      assert.deepEqual(await inspectRoundGitInterferenceV1(task), { unmergedPaths: [], stashOperationIds: [] });
      const current = await captureRoundGitStateV1({ repositoryRoot: task, taskFolderPath: task, roundId: "verify-resolution" });
      assert.ok(current.indexEntries.some((entry) => entry.path === "unrelated.txt" && entry.stage === 0));
      assert.ok(current.indexEntries.some((entry) => entry.path === "conflict.txt" && entry.stage === 0));
    } finally {
      fs.rmSync(task, { recursive: true, force: true });
    }
  });

  void it("holds a removed stash until the owner acknowledges it without restoring the stash", async () => {
    const task = fs.mkdtempSync(path.join(os.tmpdir(), "round-git-removed-stash-"));
    try {
      git(task, "init", "-q");
      git(task, "config", "user.email", "test@example.invalid");
      git(task, "config", "user.name", "Round Git Test");
      fs.writeFileSync(path.join(task, "tracked.txt"), "base\n");
      git(task, "add", "tracked.txt");
      git(task, "commit", "-qm", "base");
      fs.writeFileSync(path.join(task, "tracked.txt"), "stashed change\n");
      git(task, "stash", "push", "-m", "pre-existing stash");
      await withRoundGitStateObservationV1(
        { taskFolderPath: task, roundId: "round-stash-remove", operationId: "operation-stash-remove" },
        () => {
          git(task, "stash", "drop", "stash@{0}");
          return Promise.resolve(undefined);
        }
      );
      const hold = await inspectRoundGitInterferenceV1(task);
      assert.deepEqual(hold.stashOperationIds, ["operation-stash-remove"]);
      await acknowledgeRoundGitStashInterferenceV1(task, "operation-stash-remove");
      assert.deepEqual(await inspectRoundGitInterferenceV1(task), { unmergedPaths: [], stashOperationIds: [] });
      const remainingStashList = await gitOutput(task, "stash", "list");
      assert.equal(remainingStashList, "");
    } finally {
      fs.rmSync(task, { recursive: true, force: true });
    }
  });
});
