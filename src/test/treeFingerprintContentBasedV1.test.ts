/**
 * bugs5 Step 17: the tree fingerprint depends on file content, not on whether it is staged; the
 * start-vs-end per-path comparison names the files that changed during a run; a stamp from the old
 * algorithm refuses reuse with its own reason; and the Publish review's refusal says which case it is.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import * as vscode from "vscode";
import {
  checkPublishChecksReuseEligibilityV1,
  computePublishScopeId,
  computeTreeFingerprintSnapshotV1,
  computeTreeFingerprintV1,
  describePublishChecksFreshnessFailureV1,
  diffTreeFingerprintSnapshotsV1,
  parsePublishChecksFreshnessStamp,
  renderPublishChecksFreshnessStamp,
  TREE_FINGERPRINT_VERSION_V1,
  writePublishChecksFreshnessStampV1,
} from "../utils/publishChecksFreshness";
import { publishStatusLineForOutcomeV1, type PublishChecksOutcomeV1 } from "../utils/publishChecksOutcomeV1";
import { describePublishRowStatusV1 } from "../utils/publishRowStatusV1";
import { STAGE_ARTIFACT_FILENAMES } from "../types/taskProgress";
import { safeRemoveDir } from "./testFsUtils";

const TEST_ROOT = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ensemble-tree-fingerprint-v2-test-"));
after(() => {
  safeRemoveDir(TEST_ROOT);
});

function makeRepo(name: string): { repo: string; git: (...args: string[]) => string; write: (rel: string, text: string) => void } {
  const repo = nodePath.join(TEST_ROOT, name);
  nodeFs.mkdirSync(repo, { recursive: true });
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  const write = (rel: string, text: string): void => {
    nodeFs.mkdirSync(nodePath.dirname(nodePath.join(repo, rel)), { recursive: true });
    nodeFs.writeFileSync(nodePath.join(repo, rel), text);
  };
  write("a.ts", "export const a = 1;\n");
  write("b.ts", "export const b = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return { repo, git, write };
}

void describe("bugs5 Step 17: content-based tree fingerprint", () => {
  void it("gives the same value whether identical content is staged or not", async () => {
    const { repo, git, write } = makeRepo("staging");
    write("a.ts", "export const a = 2;\n");
    const unstaged = await computeTreeFingerprintV1(repo);
    git("add", "a.ts");
    const staged = await computeTreeFingerprintV1(repo);
    assert.ok(unstaged);
    assert.equal(staged, unstaged);
    git("reset", "-q", "a.ts");
    assert.equal(await computeTreeFingerprintV1(repo), unstaged);
  });

  void it("treats an untracked file the same once it is staged", async () => {
    const { repo, git, write } = makeRepo("untracked");
    write("c.ts", "export const c = 3;\n");
    const untracked = await computeTreeFingerprintV1(repo);
    git("add", "c.ts");
    assert.equal(await computeTreeFingerprintV1(repo), untracked);
  });

  void it("still changes when content changes, and when a file is deleted or its mode flips", async () => {
    const { repo, git, write } = makeRepo("changes");
    const clean = await computeTreeFingerprintV1(repo);
    write("a.ts", "export const a = 99;\n");
    const edited = await computeTreeFingerprintV1(repo);
    assert.notEqual(edited, clean);
    git("checkout", "--", "a.ts");
    assert.equal(await computeTreeFingerprintV1(repo), clean);
    nodeFs.rmSync(nodePath.join(repo, "b.ts"));
    assert.notEqual(await computeTreeFingerprintV1(repo), clean);
    git("checkout", "--", "b.ts");
    nodeFs.chmodSync(nodePath.join(repo, "b.ts"), 0o755);
    assert.notEqual(await computeTreeFingerprintV1(repo), clean);
  });

  void it("ignores the task folder and per-run raw logs", async () => {
    const { repo, write } = makeRepo("excluded");
    const clean = await computeTreeFingerprintV1(repo);
    write(".ensemble/task/runs/raw-check-output-abc.log", "noise");
    write(".ensemble/task/task.md", "noise");
    assert.equal(await computeTreeFingerprintV1(repo), clean);
  });

  void it("names the files that changed between two snapshots, staged or not", async () => {
    const { repo, git, write } = makeRepo("diff");
    const before = await computeTreeFingerprintSnapshotV1(repo);
    assert.ok(before);
    write("a.ts", "export const a = 5;\n");
    write("new.ts", "export const n = 1;\n");
    git("add", "-A");
    const after = await computeTreeFingerprintSnapshotV1(repo);
    assert.ok(after);
    assert.deepEqual(diffTreeFingerprintSnapshotsV1(before, after), ["a.ts", "new.ts"]);
    assert.deepEqual(diffTreeFingerprintSnapshotsV1(after, after), []);
  });

  void it("a run that only staged its edits has nothing changed during the run", async () => {
    const { repo, git, write } = makeRepo("stage-during-run");
    write("a.ts", "export const a = 7;\n");
    const before = await computeTreeFingerprintSnapshotV1(repo);
    git("add", "-A");
    const after = await computeTreeFingerprintSnapshotV1(repo);
    assert.ok(before && after);
    assert.deepEqual(diffTreeFingerprintSnapshotsV1(before, after), []);
    assert.equal(before.fingerprint, after.fingerprint);
  });
});

void describe("bugs5 Step 17: fingerprint version on the stamp", () => {
  const SAMPLE = {
    formatVersion: 1 as const,
    runId: "33333333-3333-4333-8333-333333333333",
    completedAt: "2026-11-01T18:00:00.000Z",
  };

  void it("a stamp written now records the algorithm version and it round-trips", async () => {
    const { repo, git } = makeRepo("stamp-version");
    const head = git("rev-parse", "HEAD");
    const taskFolder = vscode.Uri.file(nodePath.join(TEST_ROOT, "task-version"));
    nodeFs.mkdirSync(taskFolder.fsPath, { recursive: true });
    const fingerprint = await computeTreeFingerprintV1(repo);
    await writePublishChecksFreshnessStampV1(taskFolder, {
      ...SAMPLE,
      verifiedCommitSha: head,
      scopeId: computePublishScopeId(repo),
      treeFingerprint: fingerprint,
    });
    const text = nodeFs.readFileSync(nodePath.join(taskFolder.fsPath, STAGE_ARTIFACT_FILENAMES.publish!), "utf8");
    assert.equal(parsePublishChecksFreshnessStamp(text)?.fingerprintVersion, TREE_FINGERPRINT_VERSION_V1);
    assert.equal((await checkPublishChecksReuseEligibilityV1(taskFolder, repo, head)).eligible, true);
  });

  void it("a stamp from the old algorithm refuses reuse with its own reason", async () => {
    const { repo, git } = makeRepo("stamp-old");
    const head = git("rev-parse", "HEAD");
    const taskFolder = vscode.Uri.file(nodePath.join(TEST_ROOT, "task-old"));
    nodeFs.mkdirSync(taskFolder.fsPath, { recursive: true });
    nodeFs.writeFileSync(
      nodePath.join(taskFolder.fsPath, STAGE_ARTIFACT_FILENAMES.publish!),
      renderPublishChecksFreshnessStamp({
        ...SAMPLE,
        verifiedCommitSha: head,
        scopeId: computePublishScopeId(repo),
        treeFingerprint: "a".repeat(64),
      })
    );
    const result = await checkPublishChecksReuseEligibilityV1(taskFolder, repo, head);
    assert.equal(result.eligible, false);
    assert.match(result.reason ?? "", /older Ensemble; run the checks once more/);
  });
});

void describe("bugs5 Step 17: the Publish review's refusal tells the cases apart", () => {
  const missing = { status: "missing" } as const;
  const at = "2026-11-01T18:03:57.000Z";

  void it("says 'have not been run yet' only when no run record exists", () => {
    assert.match(describePublishChecksFreshnessFailureV1(missing), /have not been run yet/);
    assert.match(describePublishChecksFreshnessFailureV1(missing, undefined), /have not been run yet/);
  });

  void it("names the files that changed while a passing run was going", () => {
    const outcome: PublishChecksOutcomeV1 = { outcome: "passed", at, changedDuringRun: ["src/a.ts", "src/b.ts"] };
    const message = describePublishChecksFreshnessFailureV1(missing, outcome);
    assert.match(message, /changed while they ran: src\/a\.ts, src\/b\.ts/);
    assert.doesNotMatch(message, /have not been run yet/);
  });

  void it("never says 'have not been run yet' after a completed, failed, cancelled or interrupted run", () => {
    const outcomes: PublishChecksOutcomeV1[] = [
      { outcome: "passed", at },
      { outcome: "failed", at, failedCommands: ["pnpm run verify"] },
      { outcome: "cancelled", at, cause: "cancelled from the chat" },
      { outcome: "interrupted", at, finishedCommands: [], unknownCommands: [] },
    ];
    for (const outcome of outcomes) {
      const message = describePublishChecksFreshnessFailureV1(missing, outcome);
      assert.doesNotMatch(message, /have not been run yet/, outcome.outcome);
      assert.match(message, /Publish Checks/, outcome.outcome);
    }
  });

  void it("the Publish row does not call a pass that missed changed files plain 'passed'", () => {
    assert.equal(
      describePublishRowStatusV1({ hasScore: false, checksOperationLive: false, reviewRunning: false, outcome: { outcome: "passed", at, changedDuringRun: ["x.ts"] } }),
      "Checks passed · files changed during the run"
    );
    assert.equal(
      describePublishRowStatusV1({ hasScore: false, checksOperationLive: false, reviewRunning: false, outcome: { outcome: "passed", at } }),
      "Checks passed · AI review not run yet"
    );
  });

  void it("the status line for a pass with changed files names them, and a clean pass has none", () => {
    assert.match(
      publishStatusLineForOutcomeV1({ outcome: "passed", at, changedDuringRun: ["x.ts"] }) ?? "",
      /changed while they ran:\*\* `x\.ts`/
    );
    assert.equal(publishStatusLineForOutcomeV1({ outcome: "passed", at }), undefined);
  });
});

void describe("bugs5 Step 17: runPublishChecks ends honestly when files changed during the run", () => {
  const source = nodeFs.readFileSync(
    nodePath.resolve(__dirname, "..", "..", "src", "commands", "runPublishChecks.ts"),
    "utf8"
  );

  void it("compares the start and end snapshots and saves the changed paths on the outcome", () => {
    assert.match(source, /beforeSnapshot = await computeTreeFingerprintSnapshotV1\(scopeGuess\)/);
    assert.match(source, /diffTreeFingerprintSnapshotsV1\(beforeSnapshot, afterSnapshot\)/);
    assert.match(source, /outcome: "passed",[\s\S]{0,160}changedDuringRun/);
  });

  void it("raises a 'run them again' notice, not the review offer, for that case", () => {
    const branch = source.indexOf("if (checksPassed && changedDuringRun.length > 0) {");
    const passBranch = source.indexOf("} else if (result.passedModuloKnownFlakes ?? result.passed) {", branch);
    assert.ok(branch > 0 && passBranch > branch);
    const changedBranch = source.slice(branch, passBranch);
    assert.match(changedBranch, /these files changed while they ran/);
    assert.match(changedBranch, /Run them again to cover the change/);
    assert.doesNotMatch(changedBranch, /Publish Review|publishNextStepOfferV1/);
  });
});
