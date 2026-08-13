/**
 * Coverage for Step 20: a Publish-stage review's already-computed
 * `collectCompletionLintPreview` result (used to build the review's
 * `{{verifiedChecks}}`/`{{planItemVerification}}` prompt variables) is also
 * persisted into task-progress.json's `lintPayload`, marked
 * `source: "review"`, via `persistPublishReviewLintPayload`
 * (reviewActions.ts). Before this, the result was computed and discarded,
 * leaving `runLintingFixes.ts` unable to find a report even right after a
 * Publish review had just run and passed the exact same checks.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { persistPublishReviewLintPayload } from "../commands/reviewActions";
import type { CompletionLintResult } from "../utils/completionLint";
import { makeOwnedTaskFolder, readTaskProgressForTest } from "./taskFolderFixture";

/** Same fake-vscode-fs-backed-by-real-disk bridge used throughout src/test
 * (see markTaskDoneUngated.test.ts / chatViewTaskSwitch.test.ts) — reads go
 * through vscode.workspace.fs, writes go straight to real fs via writeAtomic. */
function installReadFileBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = target.readFile;
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  return { restore: (): void => { target.readFile = orig; } };
}

function makeCompletionLintResult(overrides?: Partial<CompletionLintResult>): CompletionLintResult {
  return {
    runAt: "2026-08-13T10:00:00.000Z",
    passed: true,
    summary: "All checks passed.",
    issueCount: 0,
    failedChecks: [],
    ...overrides,
  } as CompletionLintResult;
}

void describe("persistPublishReviewLintPayload (Publish-stage review -> lintPayload)", () => {
  void it("writes a review-sourced lintPayload from a passing preview result", async () => {
    const fixture = makeOwnedTaskFolder("ensemble-review-lintpayload-");
    const folderUri = vscode.Uri.file(fixture.folder);
    const rf = installReadFileBridge();

    try {
      const result = makeCompletionLintResult({
        passed: true,
        summary: "All checks passed.",
        issueCount: 0,
        failedChecks: [],
      });

      await persistPublishReviewLintPayload(folderUri, result);

      const progress = await readTaskProgressForTest(folderUri);
      assert.ok(progress?.lintPayload, "expected lintPayload to be persisted");
      assert.equal(progress?.lintPayload?.passed, true);
      assert.equal(progress?.lintPayload?.runAt, result.runAt);
      assert.equal(progress?.lintPayload?.summary, "All checks passed.");
      assert.equal(
        progress?.lintPayload?.source,
        "review",
        "a Publish-stage review's persisted lintPayload must be marked source: \"review\" " +
          "since it ran with allowScopePrompt: false and may reflect a stale Publish scope"
      );
    } finally {
      rf.restore();
    }
  });

  void it("writes a review-sourced lintPayload from a failing preview result, including failedChecks", async () => {
    const fixture = makeOwnedTaskFolder("ensemble-review-lintpayload-fail-");
    const folderUri = vscode.Uri.file(fixture.folder);
    const rf = installReadFileBridge();

    try {
      const result = makeCompletionLintResult({
        passed: false,
        summary: "1 completion check(s) failed.",
        issueCount: 1,
        failedChecks: [{ command: "npm run lint", exitCode: 1, output: "error TS1234" }],
      });

      await persistPublishReviewLintPayload(folderUri, result);

      const progress = await readTaskProgressForTest(folderUri);
      assert.equal(progress?.lintPayload?.passed, false);
      assert.equal(progress?.lintPayload?.source, "review");
      assert.equal(progress?.lintPayload?.failedChecks?.length, 1);
      assert.equal(progress?.lintPayload?.failedChecks?.[0]?.command, "npm run lint");
    } finally {
      rf.restore();
    }
  });

  void it("is best-effort: never throws when the task folder has no decodable task-progress.json", async () => {
    const folderUri = vscode.Uri.file(
      path.join(os.tmpdir(), "ensemble-nonexistent-task-folder-xyz")
    );
    const result = makeCompletionLintResult();

    // Must resolve, not reject — buildVerifiedChecksVariable must keep
    // building the review prompt even if this persistence fails.
    await assert.doesNotReject(() => persistPublishReviewLintPayload(folderUri, result));
  });
});
