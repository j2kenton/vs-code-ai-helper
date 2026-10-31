/**
 * bugs3 Step 15: the failed-first run is one helper shared by Publish Checks and
 * Fix Linting & Code Errors' post-fix re-check, and it yields exactly one result.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type * as vscode from "vscode";
import type { CompletionLintResult } from "../utils/completionLint";
import { runChecksFailedFirstV1 } from "../utils/failedFirstChecksV1";
import { buildFailedPublishRunSnapshotV1 } from "../utils/failedPublishRunV1";

function lintResult(passed: boolean): CompletionLintResult {
  return {
    runAt: "2026-10-30T10:00:00.000Z",
    passed,
    summary: passed ? "all passed" : "one failed",
    issueCount: passed ? 0 : 1,
    missingScripts: [],
    commandsRun: ["pnpm run verify"],
    failedChecks: passed ? [] : [{ command: "pnpm run verify", exitCode: 1, output: "boom" }],
  };
}

function harness(): { calls: Array<{ explicit: boolean }>; persisted: string[]; deps: NonNullable<Parameters<typeof runChecksFailedFirstV1>[0]["deps"]> } {
  const calls: Array<{ explicit: boolean }> = [];
  const persisted: string[] = [];
  return {
    calls,
    persisted,
    deps: {
      runCompletionLint: (_uri, _files, options) => {
        calls.push({ explicit: options?.explicitChecks !== undefined });
        return Promise.resolve(lintResult(true));
      },
      persist: (_uri, result) => {
        persisted.push(result.summary);
        return Promise.resolve();
      },
      readSnapshot: () => Promise.resolve(undefined),
    },
  };
}

const uri = { fsPath: path.join(os.tmpdir(), "failed-first-task") } as vscode.Uri;

void describe("failed-first checks helper (bugs3 Step 15)", () => {
  void it("runs the complete set exactly once, and says why, when no earlier failure is recorded", async () => {
    const h = harness();
    const outcome = await runChecksFailedFirstV1({
      taskFolderUri: uri,
      relevantFiles: undefined,
      token: undefined,
      scopeFolder: os.tmpdir(),
      headCommit: "a".repeat(40),
      deps: h.deps,
    });
    assert.equal(outcome.failedFirst, false);
    assert.equal(h.calls.length, 1, "one run, not a recheck followed by a second full run");
    assert.equal(h.calls[0]!.explicit, false);
    assert.match(outcome.skippedReason ?? "", /no earlier failed run/);
    assert.deepEqual(h.persisted, [], "nothing extra is persisted for a plain full run");
  });

  void it("runs the complete set once when the earlier failure is not compatible with the current command plan", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "failed-first-helper-"));
    const emptyScope = fs.mkdtempSync(path.join(os.tmpdir(), "failed-first-scope-"));
    try {
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10.34.5", scripts: { verify: "true" } }));
      const failed = lintResult(false);
      const snapshot = buildFailedPublishRunSnapshotV1({
        taskFolder: path.join(root, ".ensemble", "t"),
        repositoryRoot: root,
        verificationScopeId: "scope-1",
        headCommit: "a".repeat(40),
        result: {
          ...failed,
          verifiedFolder: root,
          verificationEnvironment: { cwd: root, packageManager: "pnpm 10.34.5", envVarNames: [] },
        },
      });
      const h = harness();
      const outcome = await runChecksFailedFirstV1({
        taskFolderUri: uri,
        relevantFiles: undefined,
        token: undefined,
        scopeFolder: emptyScope,
        headCommit: "a".repeat(40),
        deps: { ...h.deps, readSnapshot: () => Promise.resolve(snapshot) },
      });
      assert.equal(outcome.failedFirst, false);
      assert.equal(h.calls.length, 1);
      assert.equal(h.calls[0]!.explicit, false, "the complete set, not a targeted recheck");
      assert.ok(outcome.skippedReason, "the reason the targeted recheck was not used is reported");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(emptyScope, { recursive: true, force: true });
    }
  });

  void it("skips the targeted recheck when the earlier record names no package manager", async () => {
    const h = harness();
    const outcome = await runChecksFailedFirstV1({
      taskFolderUri: uri,
      relevantFiles: undefined,
      token: undefined,
      scopeFolder: os.tmpdir(),
      headCommit: undefined,
      deps: {
        ...h.deps,
        readSnapshot: () =>
          Promise.resolve({
            failures: [{ command: "pnpm run verify" }],
            runner: {},
            commands: [{ command: "pnpm run verify" }],
            failedAt: "2026-10-30T09:00:00.000Z",
          } as unknown as Awaited<ReturnType<NonNullable<NonNullable<Parameters<typeof runChecksFailedFirstV1>[0]["deps"]>["readSnapshot"]>>>),
      },
    });
    assert.equal(outcome.failedFirst, false);
    assert.equal(h.calls.length, 1);
    assert.match(outcome.skippedReason ?? "", /package manager/);
  });
});
