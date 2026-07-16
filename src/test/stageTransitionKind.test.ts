import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import * as vscode from "vscode";
import {
  advanceStage,
  AUTO_REVIEW_ELIGIBLE_KINDS,
  TransitionKind,
} from "../utils/stageTransition";
import type { TaskProgress } from "../types/taskProgress";

// Regression coverage for a review finding: advanceStage used to gate
// auto-review dispatch on a single boolean (`triggerAutoReview`), which
// cannot express "these five call reasons must never auto-review, no matter
// what a caller passes in." `kind` makes that a hard, matrix-testable gate —
// this file is that matrix.

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

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-transition-kind-test-"));
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

const ALL_KINDS: TransitionKind[] = [
  "complete-and-move-on",
  "auto-advance",
  "jump",
  "reset",
  "reopen",
  "recovery",
  "fast-forward-internal",
  "review-run",
];

void test("exactly complete-and-move-on and auto-advance are auto-review eligible", () => {
  assert.deepEqual(
    [...AUTO_REVIEW_ELIGIBLE_KINDS].sort(),
    ["auto-advance", "complete-and-move-on"]
  );
});

for (const kind of ALL_KINDS) {
  const eligible = AUTO_REVIEW_ELIGIBLE_KINDS.has(kind);
  void test(
    `advanceStage(kind="${kind}", optIn=true) on an eligible plan->plan-high-review transition ` +
      `${eligible ? "auto-reviews" : "never auto-reviews"}`,
    async () => {
      const store = new Map<string, string>();
      installMemStore(store);
      const folderUri = makeTaskFolderUri(`kind-${kind}`);
      seedProgress(store, folderUri, {
        taskFolder: `kind-${kind}`,
        currentStage: "plan",
        createdAt: "2026-07-07T00:00:00.000Z",
        updatedAt: "2026-07-07T00:00:00.000Z",
      });

      const result = await advanceStage(
        folderUri,
        "plan",
        "plan-high-review",
        false,
        kind,
        true
      );

      assert.ok(result?.persisted);
      assert.equal(
        result.shouldAutoReview,
        eligible,
        `kind="${kind}" should${eligible ? "" : " never"} produce shouldAutoReview: true`
      );
    }
  );
}

void test("advanceStage(kind=\"complete-and-move-on\", optIn=false) never auto-reviews even though the kind is eligible", async () => {
  const store = new Map<string, string>();
  installMemStore(store);
  const folderUri = makeTaskFolderUri("optout-complete-and-move-on");
  seedProgress(store, folderUri, {
    taskFolder: "optout-complete-and-move-on",
    currentStage: "plan",
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
  });

  const result = await advanceStage(
    folderUri,
    "plan",
    "plan-high-review",
    false,
    "complete-and-move-on",
    false
  );

  assert.ok(result?.persisted);
  assert.equal(result.shouldAutoReview, false);
});
