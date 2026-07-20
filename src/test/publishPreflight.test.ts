/**
 * Regression coverage for `checkPublishPreflight` (src/utils/publishPreflight.ts)
 * and its wiring into the two Publish auto-run entry paths.
 *
 * Review finding: both setTaskStage.ts and reviewActions.ts's nextStage ran
 * completion-lint checks immediately on landing at the Publish stage, but
 * then scheduled the `auto-publish` automation chain unconditionally — the
 * lint result was persisted (for the Publish review's Completion Checks
 * section) but never actually consulted before deciding whether to dispatch
 * commitAndPushTask. checkPublishPreflight is the shared, reusable check
 * both entry paths now gate their auto-publish scheduling on.
 *
 * Second review finding: checkPublishPreflight was not side-effect-free — it
 * always persisted the lint payload via runCompletionLint, even when called
 * merely to decide whether to *schedule* auto-publish. It now defaults to
 * `collectCompletionLintPreview` (no persistence) and only persists via
 * `runCompletionLint` when explicitly called with `{ persist: true }` — the
 * mode commitAndPushTask.ts uses for its actual pre-commit execution-time
 * recheck. Most tests below stub `collectCompletionLintPreview` (the default
 * path); a dedicated pair of tests pins the `{ persist: true }` contract.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { checkPublishPreflight } from "../utils/publishPreflight";
import { CompletionLintResult } from "../utils/completionLint";

// completionLint.ts and gitRepoInfo.ts are required (not `import`ed) so their
// exported function references can be monkey-patched for the duration of a
// test — see the same pattern in commitAndPushDuplicateGuard.test.ts.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const completionLintModule = require("../utils/completionLint") as {
  runCompletionLint: (...args: unknown[]) => Promise<CompletionLintResult>;
  collectCompletionLintPreview: (...args: unknown[]) => Promise<CompletionLintResult>;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const gitRepoInfoModule = require("../utils/gitRepoInfo") as {
  checkGitPublishReadiness: (folderPath: string) => Promise<
    | { ok: true; repoRoot: string; currentBranch: string; pushDestination: string; hasUpstream: boolean; singleRemote?: string }
    | { ok: false; reason: string }
  >;
};

/** checkPublishPreflight now checks read-only git readiness before it ever
 * runs the lint — these tests are about the lint gating, so git readiness is
 * stubbed to always succeed unless a test overrides it. */
function stubGitReady(): () => void {
  const original = gitRepoInfoModule.checkGitPublishReadiness;
  gitRepoInfoModule.checkGitPublishReadiness = () =>
    Promise.resolve({
      ok: true,
      repoRoot: "/dev/repo",
      currentBranch: "main",
      pushDestination: "origin/main",
      hasUpstream: true,
    });
  return () => {
    gitRepoInfoModule.checkGitPublishReadiness = original;
  };
}

function passingLint(): CompletionLintResult {
  return {
    passed: true,
    runAt: new Date().toISOString(),
    summary: "",
    issueCount: 0,
    failedChecks: [],
    missingScripts: [],
  };
}

function failingLint(summary: string): CompletionLintResult {
  return {
    passed: false,
    runAt: new Date().toISOString(),
    summary,
    issueCount: 2,
    failedChecks: [{ command: "npm test", exitCode: 1, output: "2 failing" }],
    missingScripts: [],
  };
}

void describe("checkPublishPreflight", () => {
  void it("resolves ok:true when git is ready and completion checks pass", async () => {
    const restoreGit = stubGitReady();
    const original = completionLintModule.collectCompletionLintPreview;
    completionLintModule.collectCompletionLintPreview = () => Promise.resolve(passingLint());
    try {
      const result = await checkPublishPreflight(vscode.Uri.file("/dev/task_1"));
      assert.equal(result.ok, true);
    } finally {
      completionLintModule.collectCompletionLintPreview = original;
      restoreGit();
    }
  });

  void it("resolves ok:false with a human-readable reason when completion checks fail", async () => {
    const restoreGit = stubGitReady();
    const original = completionLintModule.collectCompletionLintPreview;
    completionLintModule.collectCompletionLintPreview = () => Promise.resolve(failingLint("2 errors"));
    try {
      const result = await checkPublishPreflight(vscode.Uri.file("/dev/task_1"));
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.reason, /2 errors/);
      }
    } finally {
      completionLintModule.collectCompletionLintPreview = original;
      restoreGit();
    }
  });

  void it("resolves ok:false (not a throw) when the lint run itself throws", async () => {
    const restoreGit = stubGitReady();
    const original = completionLintModule.collectCompletionLintPreview;
    completionLintModule.collectCompletionLintPreview = () => Promise.reject(new Error("no valid Publish scope"));
    try {
      const result = await checkPublishPreflight(vscode.Uri.file("/dev/task_1"));
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.reason, /no valid Publish scope/);
      }
    } finally {
      completionLintModule.collectCompletionLintPreview = original;
      restoreGit();
    }
  });

  void it("passes relevantFiles through to collectCompletionLintPreview", async () => {
    const restoreGit = stubGitReady();
    const original = completionLintModule.collectCompletionLintPreview;
    let receivedFiles: unknown;
    completionLintModule.collectCompletionLintPreview = (_uri: unknown, files: unknown) => {
      receivedFiles = files;
      return Promise.resolve(passingLint());
    };
    try {
      await checkPublishPreflight(vscode.Uri.file("/dev/task_1"), ["src/foo.ts"]);
      assert.deepEqual(receivedFiles, ["src/foo.ts"]);
    } finally {
      completionLintModule.collectCompletionLintPreview = original;
      restoreGit();
    }
  });

  void it("resolves ok:false with the git-readiness reason and never runs the lint when git is not ready", async () => {
    const originalGit = gitRepoInfoModule.checkGitPublishReadiness;
    gitRepoInfoModule.checkGitPublishReadiness = () =>
      Promise.resolve({
        ok: false,
        reason: "Repository is in detached HEAD state. Check out a branch before committing.",
      });
    const originalPreview = completionLintModule.collectCompletionLintPreview;
    let lintCalled = false;
    completionLintModule.collectCompletionLintPreview = () => {
      lintCalled = true;
      return Promise.resolve(passingLint());
    };
    try {
      const result = await checkPublishPreflight(vscode.Uri.file("/dev/task_1"));
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.reason, /detached HEAD/);
        assert.equal(result.lintPayload, undefined);
      }
      assert.equal(lintCalled, false, "the lint must not run when git is not ready");
    } finally {
      completionLintModule.collectCompletionLintPreview = originalPreview;
      gitRepoInfoModule.checkGitPublishReadiness = originalGit;
    }
  });

  void it("is side-effect-free by default: it calls collectCompletionLintPreview, never runCompletionLint, when persist is omitted", async () => {
    const restoreGit = stubGitReady();
    const originalPreview = completionLintModule.collectCompletionLintPreview;
    const originalPersist = completionLintModule.runCompletionLint;
    let previewCalled = false;
    let persistCalled = false;
    completionLintModule.collectCompletionLintPreview = () => {
      previewCalled = true;
      return Promise.resolve(passingLint());
    };
    completionLintModule.runCompletionLint = () => {
      persistCalled = true;
      return Promise.resolve(passingLint());
    };
    try {
      const result = await checkPublishPreflight(vscode.Uri.file("/dev/task_1"));
      assert.equal(result.ok, true);
      assert.equal(previewCalled, true, "default mode must compute via the non-persisting preview path");
      assert.equal(persistCalled, false, "default mode (a scheduling decision) must never persist a lint payload");
    } finally {
      completionLintModule.collectCompletionLintPreview = originalPreview;
      completionLintModule.runCompletionLint = originalPersist;
      restoreGit();
    }
  });

  void it("persists via runCompletionLint, not collectCompletionLintPreview, when called with { persist: true }", async () => {
    const restoreGit = stubGitReady();
    const originalPreview = completionLintModule.collectCompletionLintPreview;
    const originalPersist = completionLintModule.runCompletionLint;
    let previewCalled = false;
    let persistCalled = false;
    completionLintModule.collectCompletionLintPreview = () => {
      previewCalled = true;
      return Promise.resolve(passingLint());
    };
    completionLintModule.runCompletionLint = () => {
      persistCalled = true;
      return Promise.resolve(passingLint());
    };
    try {
      const result = await checkPublishPreflight(vscode.Uri.file("/dev/task_1"), undefined, { persist: true });
      assert.equal(result.ok, true);
      assert.equal(persistCalled, true, "{ persist: true } (an actual publish attempt) must persist the lint payload");
      assert.equal(previewCalled, false, "{ persist: true } must not additionally run the non-persisting path");
    } finally {
      completionLintModule.collectCompletionLintPreview = originalPreview;
      completionLintModule.runCompletionLint = originalPersist;
      restoreGit();
    }
  });

  void it("default (scheduling-decision) mode never prompts to re-pick a stale Publish scope — it reports failure instead", async () => {
    // Second review finding: collectCompletionLintPreview always prompted
    // (and persisted) a re-picked scope via promptAndPersistPublishScope
    // when the saved scope was stale, even when called from a scheduling
    // decision — a genuine side effect (blocking UI + a disk write) hiding
    // behind the "side-effect-free" preflight. It now takes
    // { allowScopePrompt: false } for that path and throws a structured
    // error instead of prompting. This pins that checkPublishPreflight's
    // default path requests allowScopePrompt: false.
    const restoreGit = stubGitReady();
    const originalPreview = completionLintModule.collectCompletionLintPreview;
    let receivedOptions: unknown;
    completionLintModule.collectCompletionLintPreview = (...args: unknown[]) => {
      receivedOptions = args[2];
      return Promise.resolve(passingLint());
    };
    try {
      await checkPublishPreflight(vscode.Uri.file("/dev/task_1"));
      assert.deepEqual(receivedOptions, { allowScopePrompt: false });
    } finally {
      completionLintModule.collectCompletionLintPreview = originalPreview;
      restoreGit();
    }
  });
});
