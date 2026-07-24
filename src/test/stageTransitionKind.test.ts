import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import * as vscode from "vscode";
import {
  advanceStage,
  AUTO_REVIEW_ELIGIBLE_KINDS,
  StageTransitionResult,
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
  "complete-commit-push",
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

// Commit and push (the Publish command) has no advanceStage-level eligibility
// flag at all — there is no `shouldAutoPublish` result field and no
// `AUTO_PUBLISH_ELIGIBLE_KINDS` set for a caller to consult. It can only ever
// run from the user's explicit "Commit and Push" button click.

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

// ---------------------------------------------------------------------------
// C2 — concurrent manual+auto transition race.
//
// advanceStage has no separate in-memory mutex of its own; the guarantee
// instead comes from patchTaskProgress's underlying withTaskLock (a real
// cross-process file lease, see primarySessionLock.ts), which serializes
// every write for a given task folder and re-validates currentStage under
// the lock before writing. Two overlapping advanceStage calls for the same
// task race for that lock; whichever loses sees the winner's already-applied
// stage and REJECTS (patchTaskProgress does not catch the CAS-mismatch throw
// from its update callback — see stageTransition.ts's "Task changed before
// transition" throw) rather than resolving to undefined. Every production
// call site must therefore wrap advanceStage in try/catch (setTaskStage.ts,
// reviewActions.ts's nextStage, commitAndPushTask.ts all do); this test
// exercises the underlying guarantee directly with a manual
// ("complete-and-move-on") and an auto ("auto-advance") call fired
// concurrently at the same source stage, matching the plan's "concurrent
// manual+auto race" acceptance criterion.
// ---------------------------------------------------------------------------

void test("concurrent manual + auto-advance calls on the same task never both persist (single-dispatch guarantee)", async () => {
  const store = new Map<string, string>();
  installMemStore(store);
  const folderUri = makeTaskFolderUri("concurrent-manual-auto-race");
  seedProgress(store, folderUri, {
    taskFolder: "concurrent-manual-auto-race",
    currentStage: "plan",
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
  });

  const [manual, auto] = await Promise.allSettled([
    advanceStage(folderUri, "plan", "plan-high-review", false, "complete-and-move-on", true),
    advanceStage(folderUri, "plan", "plan-high-review", false, "auto-advance", true),
  ]);

  const results = [manual, auto];
  const succeeded = results.filter(
    (r): r is PromiseFulfilledResult<StageTransitionResult | undefined> =>
      r.status === "fulfilled" && r.value?.persisted === true
  );
  const rejected = results.filter((r) => r.status === "rejected");

  assert.equal(succeeded.length, 1, "exactly one of the two racing transitions must persist");
  assert.equal(rejected.length, 1, "the losing transition must reject (CAS failure), not silently apply");
  assert.equal(succeeded[0]!.value!.shouldAutoReview, true, "the winning transition must still be auto-review eligible");

  // A third, later call using the (now-stale) "plan" source stage must also
  // reject — the task really did move, so nothing can replay the transition
  // and produce a second dispatch after the race resolves.
  await assert.rejects(
    advanceStage(folderUri, "plan", "plan-high-review", false, "complete-and-move-on", true),
    /Task changed before transition/,
    "a stale replay of the same transition must not re-persist or re-dispatch"
  );
});
