/**
 * Coverage for §10.2 step 1 / §2.4's index/privacy gate in Commit and Push:
 *
 *  - `findForbiddenStagedRecordsV1` — the §2.4 rename/copy/deletion fixture
 *    quartet: a staged private deletion, a private→public rename, a
 *    public→private rename, and a copy with a private origin are all
 *    forbidden (either-endpoint tainting); a clean index is not.
 *  - `collectStagedIndexRecordsV1` — reads only records with INDEX content
 *    (staged changes, staged renames with origins, staged deletions), never
 *    untracked/unstaged-only entries. Real-git fixture.
 *  - Source-order wiring: the index gate runs before git readiness, lint,
 *    and the first prompt, and the post-add re-verification sits between
 *    `git add` and `git commit` (§2.4 rule 7).
 *  - `getChangedFiles`/`stripSensitiveTaskFiles` — workflow-control paths
 *    are omitted from staging proposals into `excludedControlPaths`.
 */
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  collectStagedIndexRecordsV1,
  findForbiddenStagedRecordsV1,
  getChangedFiles,
  stripSensitiveTaskFiles,
} from "../commands/commitAndPushTask";
import { safeRemoveDir } from "./testFsUtils";

function git(cwd: string, args: string[]): void {
  cp.execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true });
}

function makeGitFixture(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-commit-index-guard-"));
  git(repoRoot, ["init"]);
  git(repoRoot, [
    "-c", "user.email=test@example.invalid",
    "-c", "user.name=Test",
    "commit", "--allow-empty", "-m", "initial",
  ]);
  return repoRoot;
}

function commitAll(repoRoot: string, message: string): void {
  git(repoRoot, ["add", "-A"]);
  git(repoRoot, [
    "-c", "user.email=test@example.invalid",
    "-c", "user.name=Test",
    "commit", "-m", message,
  ]);
}

void describe("findForbiddenStagedRecordsV1 — §2.4 index-content rule", () => {
  const repoRoot = "C:\\repo";
  const taskFolderPath = "C:\\repo\\plans\\2026-07-01_task_1";

  void it("flags a staged deletion of a workflow-control path (the deleted path IS the private content)", () => {
    const forbidden = findForbiddenStagedRecordsV1(
      [{ status: "D.", path: "plans/creation-intents-v1/intent-abc123.json" }],
      repoRoot,
      taskFolderPath
    );
    assert.equal(forbidden.length, 1);
  });

  void it("flags a private→public rename by its ORIGIN endpoint (content survives a git mv)", () => {
    const forbidden = findForbiddenStagedRecordsV1(
      [{ status: "R.", path: "docs/innocuous-notes.md", origPath: "plans/2026-07-01_task_1/chat-v1.json" }],
      repoRoot,
      taskFolderPath
    );
    assert.equal(forbidden.length, 1);
  });

  void it("flags a public→private rename by its DESTINATION endpoint", () => {
    const forbidden = findForbiddenStagedRecordsV1(
      [{ status: "R.", path: "plans/.ensemble-meta.lock", origPath: "src/settings.json" }],
      repoRoot,
      taskFolderPath
    );
    assert.equal(forbidden.length, 1);
  });

  void it("flags a copy whose origin is private", () => {
    const forbidden = findForbiddenStagedRecordsV1(
      [{ status: "C.", path: "src/copied.ts", origPath: "plans/2026-07-01_task_1/chat-v1.json" }],
      repoRoot,
      taskFolderPath
    );
    assert.equal(forbidden.length, 1);
  });

  void it("passes a clean staged set untouched", () => {
    const forbidden = findForbiddenStagedRecordsV1(
      [
        { status: "M.", path: "src/foo.ts" },
        { status: "A.", path: "docs/readme.md" },
        { status: "R.", path: "src/renamed.ts", origPath: "src/original.ts" },
      ],
      repoRoot,
      taskFolderPath
    );
    assert.deepEqual(forbidden, []);
  });
});

void describe("collectStagedIndexRecordsV1", () => {
  void it("returns only records with index content: staged adds/deletions/renames, never untracked-only entries", async () => {
    const repoRoot = makeGitFixture();
    try {
      // Committed baseline files so deletions/renames have something to act on.
      fs.writeFileSync(path.join(repoRoot, "keep.ts"), "keep");
      fs.writeFileSync(path.join(repoRoot, "delete-me.ts"), "bye");
      fs.writeFileSync(path.join(repoRoot, "rename-me.ts"), "move");
      commitAll(repoRoot, "baseline");

      // Clean tree → no staged records.
      assert.deepEqual(await collectStagedIndexRecordsV1(repoRoot), []);

      // Untracked file only → still no staged records (X column is "?").
      fs.writeFileSync(path.join(repoRoot, "untracked.ts"), "new");
      assert.deepEqual(await collectStagedIndexRecordsV1(repoRoot), []);

      // Stage an addition, a deletion, and a rename.
      fs.writeFileSync(path.join(repoRoot, "added.ts"), "added");
      git(repoRoot, ["add", "added.ts"]);
      git(repoRoot, ["rm", "--quiet", "delete-me.ts"]);
      git(repoRoot, ["mv", "rename-me.ts", "renamed.ts"]);

      const records = await collectStagedIndexRecordsV1(repoRoot);
      const byPath = new Map(records.map((r) => [r.path, r]));
      assert.ok(byPath.has("added.ts"), "staged addition must be reported");
      assert.ok(byPath.has("delete-me.ts"), "staged deletion must be reported");
      const rename = byPath.get("renamed.ts");
      assert.ok(rename, "staged rename must be reported");
      assert.equal(rename.origPath, "rename-me.ts");
      assert.ok(!byPath.has("untracked.ts"), "untracked-only entries carry no index content");
    } finally {
      safeRemoveDir(repoRoot);
    }
  });
});

void describe("commitAndPushTask.ts / commitPushRowV1.ts source order (§10.2, full coordinator sequencing)", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "src", "commands", "commitAndPushTask.ts"),
    "utf8"
  );

  void it("runs the index/privacy gate before git readiness and the first prompt, inside resolveCommitPushStagingScopeV1, and nowhere else in commitAndPushTask.ts", () => {
    // §10.2 step 1 is factored into its own coordinator-native helper,
    // checkCommitPushIndexPrivacyV1 (defined just above
    // resolveCommitPushStagingScopeV1 in source order) — commitPushRowV1.ts's
    // executeCommitPushV1 calls it itself before ever invoking
    // resolveCommitPushStagingScopeV1, and resolveCommitPushStagingScopeV1
    // calls the SAME function again, at its own top, as its own revalidation
    // (§7.7) before the real staging-scope work (the pre-existing-staged
    // prompt, then the default/"Include Task Folder"/"Include Run Artifacts"
    // prompts) begins. The real collectStagedIndexRecordsV1 read now lives
    // inside that helper rather than inline in resolveCommitPushStagingScopeV1,
    // so source-order wiring is checked via the call to the helper, not the
    // raw index-read call.
    //
    // Completion checks (the former "lint" step) run exactly once, in the
    // coordinator, via runCommitPushCompletionChecksV1, BEFORE
    // resolveCommitPushStagingScopeV1 or any of the remaining save/
    // PR-description/commit-message/staging/commit/push steps are ever
    // invoked (see the "coordinator opens the operation..." test below) —
    // neither asserts a lint call of its own.
    const helperStart = source.indexOf("async function checkCommitPushIndexPrivacyV1(");
    assert.ok(helperStart >= 0, "could not find checkCommitPushIndexPrivacyV1");
    const helperGateIdx = source.indexOf("collectStagedIndexRecordsV1(repoRoot)", helperStart);
    assert.ok(helperGateIdx > helperStart, "the helper must read the staged index");

    const scopeStart = source.indexOf("export async function resolveCommitPushStagingScopeV1(");
    assert.ok(scopeStart >= 0, "could not find resolveCommitPushStagingScopeV1");
    assert.ok(helperStart < scopeStart, "checkCommitPushIndexPrivacyV1 must be defined before resolveCommitPushStagingScopeV1");

    const gateIdx = source.indexOf("checkCommitPushIndexPrivacyV1(resolvedTask)", scopeStart);
    assert.ok(gateIdx > scopeStart, "resolveCommitPushStagingScopeV1 must call checkCommitPushIndexPrivacyV1");

    const readinessIdx = source.indexOf("checkGitPublishReadiness(", scopeStart);
    assert.ok(readinessIdx > scopeStart, "could not find the readiness check");

    const promptIdx = source.indexOf("showWarningMessage", gateIdx);
    assert.ok(promptIdx > gateIdx, "could not find a prompt after the gate");

    assert.ok(
      gateIdx < readinessIdx && readinessIdx < promptIdx,
      `index gate (${gateIdx}) must precede readiness (${readinessIdx}) and prompts (${promptIdx})`
    );

    // None of the remaining save/PR-description/commit-message/staging/
    // commit/push functions may re-run the index/privacy gate — it is
    // settled once, by resolveCommitPushStagingScopeV1 (called exactly once
    // more by executeCommitPushV1's own coordinator-native pre-check), and
    // never a single opaque "core" call anymore.
    const callSites = source.split("checkCommitPushIndexPrivacyV1(resolvedTask)").length - 1;
    assert.equal(
      callSites,
      1,
      "checkCommitPushIndexPrivacyV1 must be called exactly once in commitAndPushTask.ts, inside resolveCommitPushStagingScopeV1"
    );
  });

  void it("commitPushRowV1's executeCommitPushV1 calls resolveCommitPushStagingScopeV1 then confirmCommitPushScopeV1, before the remaining save/PR-description/commit-message/staging/commit/push steps (§3.8/§10.2 steps 6-7)", () => {
    // The blocker this closes: staging-scope resolution, final preview/
    // confirmation, save, PR-description generation, commit-message review,
    // staging/commit, and push each now run as their own coordinator-native
    // steps, called directly by executeCommitPushV1, in this order — there
    // is no longer a single opaque delegated "core" call for any of them.
    const rowSource = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "src", "actions", "rows", "commitPushRowV1.ts"),
      "utf8"
    );
    const executeStart = rowSource.indexOf("export async function executeCommitPushV1(");
    assert.ok(executeStart >= 0, "could not find executeCommitPushV1");

    const checksIdx = rowSource.indexOf("runCommitPushCompletionChecksV1(", executeStart);
    assert.ok(checksIdx > executeStart, "executeCommitPushV1 must call runCommitPushCompletionChecksV1");

    const scopeIdx = rowSource.indexOf("resolveCommitPushStagingScopeV1(", executeStart);
    assert.ok(scopeIdx > executeStart, "executeCommitPushV1 must call resolveCommitPushStagingScopeV1");

    const confirmIdx = rowSource.indexOf("confirmCommitPushScopeV1(", executeStart);
    assert.ok(confirmIdx > executeStart, "executeCommitPushV1 must call confirmCommitPushScopeV1");

    const saveIdx = rowSource.indexOf("saveCommitPushDocumentsV1(", executeStart);
    assert.ok(saveIdx > executeStart, "executeCommitPushV1 must call saveCommitPushDocumentsV1");

    const prIdx = rowSource.indexOf("generateCommitPushPrDescriptionV1(", executeStart);
    assert.ok(prIdx > executeStart, "executeCommitPushV1 must call generateCommitPushPrDescriptionV1");

    const messageIdx = rowSource.indexOf("reviewCommitPushMessageV1(", executeStart);
    assert.ok(messageIdx > executeStart, "executeCommitPushV1 must call reviewCommitPushMessageV1");

    const stageCommitIdx = rowSource.indexOf("stageAndCommitCommitPushV1(", executeStart);
    assert.ok(stageCommitIdx > executeStart, "executeCommitPushV1 must call stageAndCommitCommitPushV1");

    const pushIdx = rowSource.indexOf("pushCommitPushV1(", executeStart);
    assert.ok(pushIdx > executeStart, "executeCommitPushV1 must call pushCommitPushV1");

    assert.ok(
      checksIdx < scopeIdx &&
        scopeIdx < confirmIdx &&
        confirmIdx < saveIdx &&
        saveIdx < prIdx &&
        prIdx < messageIdx &&
        messageIdx < stageCommitIdx &&
        stageCommitIdx < pushIdx,
      `completion checks (${checksIdx}) must precede staging-scope resolution (${scopeIdx}), which must precede ` +
        `confirmation (${confirmIdx}), which must precede save (${saveIdx}), which must precede PR description ` +
        `(${prIdx}), which must precede commit-message review (${messageIdx}), which must precede staging/commit ` +
        `(${stageCommitIdx}), which must precede push (${pushIdx})`
    );
  });

  void it("commitPushRowV1's executeCommitPushV1 calls the index/privacy gate before ever calling the remaining coordinator-native steps", () => {
    const rowSource = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "src", "actions", "rows", "commitPushRowV1.ts"),
      "utf8"
    );
    const executeStart = rowSource.indexOf("export async function executeCommitPushV1(");
    assert.ok(executeStart >= 0, "could not find executeCommitPushV1");
    const gateIdx = rowSource.indexOf("checkCommitPushIndexPrivacyV1(services.resolvedTask)", executeStart);
    assert.ok(gateIdx > executeStart, "executeCommitPushV1 must call checkCommitPushIndexPrivacyV1");
    const pushCallIdx = rowSource.indexOf("await pushCommitPushV1(", executeStart);
    assert.ok(pushCallIdx > executeStart, "could not find the pushCommitPushV1 call");
    assert.ok(
      gateIdx < pushCallIdx,
      `the coordinator-native gate (${gateIdx}) must precede the final pushCommitPushV1 call (${pushCallIdx})`
    );
  });

  void it("commitPushRowV1's executeCommitPushV1 also calls the read-only git readiness check before the remaining coordinator-native steps (§10.2 step 2)", () => {
    const rowSource = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "src", "actions", "rows", "commitPushRowV1.ts"),
      "utf8"
    );
    const executeStart = rowSource.indexOf("export async function executeCommitPushV1(");
    assert.ok(executeStart >= 0, "could not find executeCommitPushV1");
    const indexGateIdx = rowSource.indexOf("checkCommitPushIndexPrivacyV1(services.resolvedTask)", executeStart);
    assert.ok(indexGateIdx > executeStart, "executeCommitPushV1 must call checkCommitPushIndexPrivacyV1");
    const readinessGateIdx = rowSource.indexOf(
      "checkGitPublishReadiness(services.resolvedTask.taskFolderPath)",
      executeStart
    );
    assert.ok(readinessGateIdx > executeStart, "executeCommitPushV1 must call checkGitPublishReadiness");
    const pushCallIdx = rowSource.indexOf("await pushCommitPushV1(", executeStart);
    assert.ok(pushCallIdx > executeStart, "could not find the pushCommitPushV1 call");
    assert.ok(
      indexGateIdx < readinessGateIdx && readinessGateIdx < pushCallIdx,
      `the index gate (${indexGateIdx}) must precede the readiness gate (${readinessGateIdx}), which must precede ` +
        `the final pushCommitPushV1 call (${pushCallIdx})`
    );
  });

  void it("commitPushRowV1's executeCommitPushV1 opens the tracked operation and runs completion checks itself, before the remaining coordinator-native steps (§3.8/§10.2 step 3)", () => {
    // The blocker this closes: completion checks (Publish Anyway / Fix with
    // AI / Cancel), and now every remaining save/PR-description/
    // commit-message/staging/commit/push step too, run in the coordinator,
    // under an operation handle the coordinator itself opens via
    // taskOperations.begin — the same acquire/release pair
    // runTrackedOperation was always built on — never inside one opaque
    // delegated "core" call.
    const rowSource = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "src", "actions", "rows", "commitPushRowV1.ts"),
      "utf8"
    );
    const executeStart = rowSource.indexOf("export async function executeCommitPushV1(");
    assert.ok(executeStart >= 0, "could not find executeCommitPushV1");

    const readinessGateIdx = rowSource.indexOf(
      "checkGitPublishReadiness(services.resolvedTask.taskFolderPath)",
      executeStart
    );
    assert.ok(readinessGateIdx > executeStart, "executeCommitPushV1 must call checkGitPublishReadiness");

    const beginIdx = rowSource.indexOf("taskOperations.begin(lockKey", executeStart);
    assert.ok(beginIdx > executeStart, "executeCommitPushV1 must open the tracked operation itself");

    const checksIdx = rowSource.indexOf("runCommitPushCompletionChecksV1(", executeStart);
    assert.ok(checksIdx > executeStart, "executeCommitPushV1 must call runCommitPushCompletionChecksV1");

    const pushCallIdx = rowSource.indexOf("await pushCommitPushV1(", executeStart);
    assert.ok(pushCallIdx > executeStart, "could not find the pushCommitPushV1 call");

    const endIdx = rowSource.indexOf("taskOperations.end(op", executeStart);
    assert.ok(endIdx > executeStart, "executeCommitPushV1 must end the tracked operation itself");

    assert.ok(
      readinessGateIdx < beginIdx &&
        beginIdx < checksIdx &&
        checksIdx < pushCallIdx &&
        pushCallIdx < endIdx,
      `readiness (${readinessGateIdx}) must precede opening the operation (${beginIdx}), which must precede ` +
        `completion checks (${checksIdx}), which must precede the final pushCommitPushV1 call ` +
        `(${pushCallIdx}), which must precede ending the operation (${endIdx})`
    );
  });

  void it("the completion-checks decision loop runs exactly once, in runCommitPushCompletionChecksV1, never inside any of the remaining coordinator-native steps", () => {
    // runChecks is a const local to runCommitPushCompletionChecksV1's own
    // lexical scope, so it can only ever be called from within that
    // function — this asserts the two expected call sites (the initial
    // check and the post-fix re-check inside the Publish Anyway / Fix with
    // AI loop) and that no other occurrence exists in the file.
    const occurrences = source.split("await runChecks()").length - 1;
    assert.equal(
      occurrences,
      2,
      "await runChecks() must appear exactly twice, both inside runCommitPushCompletionChecksV1 — " +
        "completion checks run exactly once per attempt, never re-run by a different function"
    );
  });

  void it("re-verifies the index between git add and git commit, inside the reset-on-failure block (§2.4 rule 7)", () => {
    const addIdx = source.indexOf('runGitCommand(repoRoot, "add", ["--", ...scopedFiles])');
    assert.ok(addIdx >= 0, "could not find the git add call");

    const reverifyIdx = source.indexOf("findForbiddenStagedRecordsV1(", addIdx);
    assert.ok(reverifyIdx > addIdx, "the post-add re-verification must follow git add");

    const commitIdx = source.indexOf('runGitCommand(repoRoot, "commit"', addIdx);
    assert.ok(commitIdx > addIdx, "could not find the git commit call");

    assert.ok(
      reverifyIdx < commitIdx,
      `post-add re-verification (${reverifyIdx}) must precede git commit (${commitIdx})`
    );
  });
});

void describe("getChangedFiles — workflow-control omission (§2.4 rule 5)", () => {
  void it("routes control paths into excludedControlPaths, never scopedFiles, and stripSensitiveTaskFiles drops them", async () => {
    const repoRoot = makeGitFixture();
    try {
      const taskFolderPath = path.join(repoRoot, "plans", "2026-07-01_task_1");
      fs.mkdirSync(taskFolderPath, { recursive: true });
      fs.writeFileSync(path.join(taskFolderPath, "task.md"), "# t");
      commitAll(repoRoot, "baseline");

      fs.writeFileSync(path.join(repoRoot, "src.ts"), "code");
      // Stray workflow-control debris: a crashed meta lock at the task root.
      fs.writeFileSync(path.join(repoRoot, "plans", ".ensemble-meta.lock"), "{}");

      const { scopedFiles, excludedControlPaths } = await getChangedFiles(
        repoRoot,
        taskFolderPath,
        false
      );
      assert.ok(scopedFiles.includes("src.ts"), "ordinary source stays staged");
      assert.ok(
        excludedControlPaths.includes("plans/.ensemble-meta.lock"),
        "control debris must be omitted into excludedControlPaths"
      );
      assert.ok(!scopedFiles.includes("plans/.ensemble-meta.lock"));

      // The flat-list final gate drops control paths regardless of origin.
      assert.deepEqual(
        stripSensitiveTaskFiles(["src.ts", "plans/.ensemble-meta.lock"], repoRoot, taskFolderPath),
        ["src.ts"]
      );
    } finally {
      safeRemoveDir(repoRoot);
    }
  });
});
