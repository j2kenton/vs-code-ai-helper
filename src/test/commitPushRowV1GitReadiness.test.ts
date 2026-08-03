/**
 * Coverage for `commitPushRowV1.ts`'s second coordinator-native step
 * (impl-high-review round: extending §3.8/§10.2's real, coordinator-owned
 * sequencing past the index/privacy check to the read-only git readiness
 * check too — `checkGitPublishReadiness`, shared with `publishPreflight.ts`):
 * `executeCommitPushV1` now short-circuits on a not-ready repo (detached
 * HEAD, no repo, ambiguous push target) BEFORE ever invoking any of the
 * remaining coordinator-native steps (staging-scope resolution through
 * push), exactly like the pre-existing index/privacy short-circuit — see
 * `commitAndPushIndexGuard.test.ts`'s source-order suite for the static
 * ordering assertions this behavioral test complements.
 */
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { executeCommitPushV1, COMMIT_PUSH_ACTION_KEY_V1 } from "../actions/rows/commitPushRowV1";
import { LifecycleExecutionContextV1 } from "../actions/taskActionRegistryV1";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import { TaskInventory } from "../state/taskInventory";
import { ResolvedTaskContext } from "../utils/resolveTaskContext";
import {
  deactivateNotificationRouter,
  initNotificationRouter,
} from "../utils/notificationRouter";
import { fixtureOwnershipFor } from "./taskFolderFixture";
import { safeRemoveDir } from "./testFsUtils";

// Required (not `import`ed) so saveCommitPushDocumentsV1's exported
// reference — the first of the remaining coordinator-native steps that runs
// after staging-scope resolution/confirmation — can be monkey-patched for
// the duration of a test to prove it is never called — same pattern/
// rationale as commitAndPushPublishGate.test.ts.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const commitAndPushTaskModule = require("../commands/commitAndPushTask") as {
  saveCommitPushDocumentsV1: (...args: unknown[]) => Promise<unknown>;
};

function git(cwd: string, args: string[]): void {
  cp.execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true });
}

class RecordingSurface {
  entries: { message: string; level: "info" | "warning" | "error" }[] = [];
  addEntry(message: string, level: "info" | "warning" | "error"): void {
    this.entries.push({ message, level });
  }
}

/** A real git repo, checked out in detached HEAD, with a task folder inside it. */
function makeDetachedHeadFixture(): { repoRoot: string; taskFolderPath: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-commit-git-readiness-"));
  git(repoRoot, ["init"]);
  const taskFolderPath = path.join(repoRoot, "plans", "task_1");
  fs.mkdirSync(taskFolderPath, { recursive: true });
  fs.writeFileSync(path.join(taskFolderPath, "task.md"), "# t");
  git(repoRoot, ["add", "-A"]);
  git(repoRoot, [
    "-c", "user.email=test@example.invalid", "-c", "user.name=Test",
    "commit", "-m", "initial",
  ]);
  const headSha = cp
    .execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, windowsHide: true })
    .toString()
    .trim();
  git(repoRoot, ["checkout", headSha]);
  return { repoRoot, taskFolderPath };
}

function fakeResolvedTask(taskFolderPath: string): ResolvedTaskContext {
  return {
    taskRef: { canonicalId: taskFolderPath, taskFolderPath },
    canonicalId: taskFolderPath,
    taskFolderPath,
    folderName: "task_1",
    sourceScopeKey: "test",
    workspaceFolder: undefined,
    progress: {
      taskFolder: "task_1",
      currentStage: "publish",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ownership: fixtureOwnershipFor(taskFolderPath),
    },
  } as unknown as ResolvedTaskContext;
}

function contextFor(taskFolderPath: string): LifecycleExecutionContextV1 {
  return {
    actionKey: COMMIT_PUSH_ACTION_KEY_V1,
    operationId: allocateHex128IdV1(),
    taskBindingId: "test-task-binding",
    chatDocumentId: "test-chat-doc",
    validatedInput: { taskFolderPath },
    services: {
      inventory: {} as TaskInventory,
      resolvedTask: fakeResolvedTask(taskFolderPath),
    },
  };
}

void describe("executeCommitPushV1 — git readiness short-circuit (§10.2 step 2)", () => {
  void it("returns commitPush.gitNotReady and never invokes any remaining coordinator-native step for a detached-HEAD repo", async () => {
    const { repoRoot, taskFolderPath } = makeDetachedHeadFixture();
    const surface = new RecordingSurface();
    initNotificationRouter(surface);

    const originalSave = commitAndPushTaskModule.saveCommitPushDocumentsV1;
    let saveCalled = false;
    commitAndPushTaskModule.saveCommitPushDocumentsV1 = (): Promise<unknown> => {
      saveCalled = true;
      return Promise.resolve({ kind: "saved" });
    };

    try {
      const outcome = await executeCommitPushV1(contextFor(taskFolderPath));

      assert.equal(saveCalled, false, "a not-ready repo must short-circuit before any remaining coordinator-native step runs");
      assert.equal(outcome.kind, "failed");
      if (outcome.kind === "failed") {
        assert.equal(outcome.code, "commitPush.gitNotReady");
        assert.equal(outcome.retryable, true);
      }
      assert.ok(
        surface.entries.some((e) => e.level === "error" && /detached HEAD/.test(e.message)),
        `the detached-HEAD reason must be surfaced to the user; got: ${JSON.stringify(surface.entries)}`
      );
    } finally {
      commitAndPushTaskModule.saveCommitPushDocumentsV1 = originalSave;
      deactivateNotificationRouter();
      safeRemoveDir(repoRoot);
    }
  });
});
