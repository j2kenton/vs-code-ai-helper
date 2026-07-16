import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import * as vscode from "vscode";
import { advanceStage } from "../utils/stageTransition";
import type { TaskProgress } from "../types/taskProgress";

// Regression coverage for a review finding: advanceStage's review-attempt CAS
// used to complete (and release the task lock) before the caller renamed its
// staged review artifact into place. A slower, already-superseded review
// attempt could still lose its own CAS *after* a faster attempt had already
// published — but nothing stopped a stale attempt whose CAS had *already
// passed* from publishing late, after a newer claim both claimed and
// published in between. advanceStage now takes a `publishArtifact` callback
// that runs atomically with the CAS check/write, inside the same task lock,
// closing that window.

// Same fake-vscode-fs-backed-by-real-disk setup as taskProgressUtils.test.ts:
// patchTaskProgress serializes through withTaskLock, which takes real
// filesystem leases derived from the folder path's ".." ancestry, so the
// task folder must live under a real temp directory shaped like production.

type MemStore = Map<string, string>;

function installMemStore(store: MemStore): void {
  (vscode.workspace.fs as unknown as Record<string, unknown>).readFile = (
    uri: vscode.Uri
  ): Promise<Uint8Array> => {
    if (path.basename(uri.fsPath) === "task-progress.json" && fs.existsSync(uri.fsPath)) {
      return fs.promises.readFile(uri.fsPath, "utf8").then((text) => new TextEncoder().encode(text));
    }
    const content = store.get(uri.toString());
    if (content === undefined) {
      throw new Error(`ENOENT: ${uri.toString()}`);
    }
    return Promise.resolve(new TextEncoder().encode(content));
  };
  (vscode.workspace.fs as unknown as Record<string, unknown>).writeFile = (
    uri: vscode.Uri,
    data: Uint8Array
  ): Promise<void> => {
    store.set(uri.toString(), new TextDecoder().decode(data));
    return Promise.resolve();
  };
}

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-publish-test-"));
after(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

function makeTaskFolderUri(name: string): vscode.Uri {
  return vscode.Uri.file(path.join(TEST_ROOT, ".ensemble", name));
}

function seedProgress(store: MemStore, folderUri: vscode.Uri, progress: TaskProgress): void {
  const uri = vscode.Uri.joinPath(folderUri, "task-progress.json");
  store.set(uri.toString(), JSON.stringify(progress, null, 2));
}

void test(
  "a review attempt that loses the CAS never runs its publishArtifact side effect " +
    "(stale attempt cannot clobber a newer attempt's already-published artifact)",
  async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const folderUri = makeTaskFolderUri("stale-publish-race");
    const progressUri = vscode.Uri.joinPath(folderUri, "task-progress.json");

    // Attempt A has already claimed the stage (the "claim" write
    // runReviewForFolder does before starting its own AI call) and is now
    // slowly generating its review.
    seedProgress(store, folderUri, {
      taskFolder: "stale-publish-race",
      currentStage: "impl-high-review",
      createdAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:00:00.000Z",
      reviewAttemptId: "attempt-A",
    });

    // A second, independent review run (attempt B) claims the stage while A
    // is still in flight — this overwrites reviewAttemptId the same way the
    // real claim step does, with no CAS of its own.
    const current = JSON.parse(store.get(progressUri.toString())!) as TaskProgress;
    store.set(progressUri.toString(), JSON.stringify({ ...current, reviewAttemptId: "attempt-B" }, null, 2));

    let published = "";
    const publishOrder: string[] = [];

    // B finishes generating first and publishes.
    const bResult = await advanceStage(
      folderUri,
      "impl-high-review",
      "impl-high-review",
      false,
      "review-run",
      false,
      "attempt-B",
      () => {
        publishOrder.push("B-publish");
        published = "B-content";
        return Promise.resolve();
      }
    );
    assert.ok(bResult?.persisted);
    assert.equal(published, "B-content");

    // A now finishes generating (slower) and tries to publish its own,
    // older content. Its CAS must fail because reviewAttemptId is now
    // "attempt-B", and — critically — its publishArtifact callback must
    // never run, so it cannot overwrite what B already published.
    await assert.rejects(
      () =>
        advanceStage(folderUri, "impl-high-review", "impl-high-review", false, "review-run", false, "attempt-A", () => {
          publishOrder.push("A-publish");
          published = "A-content";
          return Promise.resolve();
        }),
      /stale/i
    );

    // A's publish callback must not have run at all, and B's published
    // content must be untouched.
    assert.deepEqual(publishOrder, ["B-publish"]);
    assert.equal(published, "B-content");
  }
);

void test(
  "publishArtifact runs only after the CAS accepts a real stage transition, " +
    "and a rejected CAS runs it zero times",
  async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const folderUri = makeTaskFolderUri("transition-publish");
    seedProgress(store, folderUri, {
      taskFolder: "transition-publish",
      currentStage: "impl",
      createdAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:00:00.000Z",
      reviewAttemptId: "attempt-1",
    });

    let publishCount = 0;
    const result = await advanceStage(
      folderUri,
      "impl",
      "impl-high-review",
      false,
      "review-run",
      false,
      "attempt-1",
      () => {
        publishCount += 1;
        return Promise.resolve();
      }
    );
    assert.ok(result?.persisted);
    assert.equal(result.newStage, "impl-high-review");
    assert.equal(publishCount, 1);

    // A second call with a now-stale source stage (task already moved to
    // impl-high-review) must reject and must not publish again.
    await assert.rejects(
      () =>
        advanceStage(folderUri, "impl", "impl-high-review", false, "review-run", false, "attempt-1", () => {
          publishCount += 1;
          return Promise.resolve();
        }),
      /Task changed before transition/
    );
    assert.equal(publishCount, 1);
  }
);
