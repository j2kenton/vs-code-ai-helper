import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  captureForeignTaskArtifactSnapshotV1,
  containForeignTaskArtifactChangesV1,
  detectForeignTaskArtifactChangesV1,
  isEnsembleCreatedTaskFolderV1,
  discoverTaskFoldersFromRootPathsV1,
  sanitizeAuthoritativePromptContextV1,
  sanitizeImplementationReviewContentV1,
} from "../utils/foreignTaskArtifactContainmentV1";

void describe("foreign task artifact containment (Step 11 / Finding 3)", () => {
  let tmpRoot: string;
  let taskFolderA: string;
  let taskFolderB: string;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "foreign-artifact-containment-"));
    taskFolderA = path.join(tmpRoot, ".ensemble", "2026-10-21_task_1");
    taskFolderB = path.join(tmpRoot, ".ensemble", "2026-10-22_task_1");
    fs.mkdirSync(taskFolderA, { recursive: true });
    fs.mkdirSync(taskFolderB, { recursive: true });

    // Pre-existing plan-final.md in task A and task B
    fs.writeFileSync(path.join(taskFolderA, "plan-final.md"), "# Task A Plan", "utf8");
    fs.writeFileSync(path.join(taskFolderB, "plan-final.md"), "# Task B Plan", "utf8");
  });

  after(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  });

  void it("does not attribute pre-existing foreign files to this round", async () => {
    // Snapshot before dispatch for task A
    const snapshot = await captureForeignTaskArtifactSnapshotV1(taskFolderA, [taskFolderB]);

    // Detect changes with nothing changed
    const changes = await detectForeignTaskArtifactChangesV1(snapshot, [taskFolderB]);
    assert.strictEqual(changes.length, 0, "pre-existing foreign files must not be detected as changes");
  });

  void it("discovers a task folder created after the snapshot", async () => {
    const snapshot = await captureForeignTaskArtifactSnapshotV1(taskFolderA, [taskFolderB]);
    const taskFolderC = path.join(tmpRoot, ".ensemble", "2026-10-23_task_1");
    fs.mkdirSync(taskFolderC, { recursive: true });
    fs.writeFileSync(path.join(taskFolderC, "task.md"), "# Newly created task", "utf8");
    fs.writeFileSync(path.join(taskFolderC, "round-progress.md"), "- [x] unrelated task progress\n", "utf8");

    const changes = await detectForeignTaskArtifactChangesV1(snapshot);
    assert.ok(changes.some((change) => change.absolutePath === path.join(taskFolderC, "round-progress.md")));
    fs.rmSync(taskFolderC, { recursive: true, force: true });
  });

  void it("detects newly created round-progress.md in foreign task folder and moves it when destination is unoccupied", async () => {
    const snapshot = await captureForeignTaskArtifactSnapshotV1(taskFolderA, [taskFolderB]);

    // Model in task A accidentally writes round-progress.md into task B
    const misplacedPath = path.join(taskFolderB, "round-progress.md");
    fs.writeFileSync(misplacedPath, "- [x] Step 1 done\n", "utf8");

    const changes = await detectForeignTaskArtifactChangesV1(snapshot, [taskFolderB]);
    assert.strictEqual(changes.length, 1);
    assert.strictEqual(changes[0]?.artifactName, "round-progress.md");
    assert.strictEqual(changes[0]?.foreignFolderPath, path.resolve(taskFolderB).replace(/\\/g, "/"));
    assert.strictEqual(changes[0]?.kind, "created");

    // Contain changes: move to task A
    const containment = await containForeignTaskArtifactChangesV1(changes, taskFolderA, {
      isTaskOwned: () => true,
    });
    assert.strictEqual(containment.actions.length, 1);
    assert.strictEqual(containment.actions[0]?.outcome, "moved");

    // Verify misplaced file in task B is removed, and now exists in task A
    assert.strictEqual(fs.existsSync(misplacedPath), false, "misplaced file should be moved away from foreign task");
    const canonicalPath = path.join(taskFolderA, "round-progress.md");
    assert.strictEqual(fs.existsSync(canonicalPath), true, "misplaced file should be moved to canonical task folder");
    assert.strictEqual(fs.readFileSync(canonicalPath, "utf8"), "- [x] Step 1 done\n");
    assert.ok(containment.chatNotices.some((n) => n.includes("Misplaced artifact contained")));

    // Clean up task A's round-progress.md
    fs.unlinkSync(canonicalPath);
  });

  void it("preserves a misplaced artifact when ownership was not established", async () => {
    const snapshot = await captureForeignTaskArtifactSnapshotV1(taskFolderA, [taskFolderB]);
    const misplacedPath = path.join(taskFolderB, "round-progress.md");
    fs.writeFileSync(misplacedPath, "- [x] Step 1 done\n", "utf8");
    const changes = await detectForeignTaskArtifactChangesV1(snapshot, [taskFolderB]);

    const result = await containForeignTaskArtifactChangesV1(changes, taskFolderA);
    assert.equal(result.actions[0]?.outcome, "preserved-ambiguous");
    assert.equal(fs.existsSync(misplacedPath), true);
    assert.equal(fs.existsSync(path.join(taskFolderA, "round-progress.md")), false);
    assert.ok(result.chatNotices[0]?.includes("ownership was not established"));

    fs.unlinkSync(misplacedPath);
  });

  void it("preserves both files when destination is already occupied", async () => {
    const snapshot = await captureForeignTaskArtifactSnapshotV1(taskFolderA, [taskFolderB]);

    // Pre-populate canonical destination in task A
    const canonicalPath = path.join(taskFolderA, "round-progress.md");
    fs.writeFileSync(canonicalPath, "- [x] Existing progress in task A\n", "utf8");

    // Misplaced file in task B
    const misplacedPath = path.join(taskFolderB, "round-progress.md");
    fs.writeFileSync(misplacedPath, "- [x] Accidental write in task B\n", "utf8");

    const changes = await detectForeignTaskArtifactChangesV1(snapshot, [taskFolderB]);
    assert.strictEqual(changes.length, 1);

    const containment = await containForeignTaskArtifactChangesV1(changes, taskFolderA, {
      isTaskOwned: () => true,
    });
    assert.strictEqual(containment.actions[0]?.outcome, "preserved-occupied");

    // Both files must remain intact
    assert.strictEqual(fs.existsSync(misplacedPath), true, "foreign file must be preserved");
    assert.strictEqual(fs.existsSync(canonicalPath), true, "destination file must be preserved");
    assert.strictEqual(fs.readFileSync(canonicalPath, "utf8"), "- [x] Existing progress in task A\n");

    // Clean up
    fs.unlinkSync(canonicalPath);
    fs.unlinkSync(misplacedPath);
  });

  void it("preserves both files when concurrent foreign-task update is detected or ownership is ambiguous", async () => {
    const snapshot = await captureForeignTaskArtifactSnapshotV1(taskFolderA, [taskFolderB]);

    const misplacedPath = path.join(taskFolderB, "round-progress.md");
    fs.writeFileSync(misplacedPath, "- [x] Foreign task's own progress\n", "utf8");

    const changes = await detectForeignTaskArtifactChangesV1(snapshot, [taskFolderB]);
    assert.strictEqual(changes.length, 1);

    // Concurrent foreign task update
    const containment = await containForeignTaskArtifactChangesV1(changes, taskFolderA, {
      isConcurrentForeignUpdate: true,
    });
    assert.strictEqual(containment.actions[0]?.outcome, "preserved-ambiguous");
    assert.strictEqual(fs.existsSync(misplacedPath), true, "foreign file must be preserved during concurrent activity");

    // Clean up
    fs.unlinkSync(misplacedPath);
  });

  void it("removes foreign-task artifact links from authoritative context while retaining useful code references", () => {
    const textWithForeignLinks = [
      "Summary of round progress:",
      `- Checked [round-progress.md](${taskFolderB}/round-progress.md)`,
      `- Plan is at [plan-final.md](${taskFolderB}/plan-final.md)`,
      `- Changed code file at [reviewActions.ts](/workspace/vs-code-ai-helper/src/commands/reviewActions.ts)`,
      `- Plain path reference: ${taskFolderB}/plan-final.md was examined.`,
    ].join("\n");

    const sanitized = sanitizeAuthoritativePromptContextV1(textWithForeignLinks, taskFolderA, [taskFolderB]);

    const normTaskB = path.resolve(taskFolderB).replace(/\\/g, "/");

    assert.ok(!sanitized.includes(`${normTaskB}/round-progress.md`), "foreign round-progress.md path should be removed");
    assert.ok(!sanitized.includes(`${normTaskB}/plan-final.md`), "foreign plan-final.md path should be removed");
    assert.equal((sanitized.match(/foreign task artifact omitted/g) ?? []).length, 3);
    assert.ok(
      sanitized.includes("[reviewActions.ts](/workspace/vs-code-ai-helper/src/commands/reviewActions.ts)"),
      "code reference links must be preserved intact"
    );
  });

  void it("filters foreign artifact links from implementation-review content using the bound task", () => {
    const content = `Previous round: [plan-final.md](${taskFolderB}/plan-final.md)\nChanged code: /workspace/project/src/file.ts`;
    const sanitized = sanitizeImplementationReviewContentV1(content, taskFolderA);
    assert.ok(!sanitized.includes(`${path.resolve(taskFolderB)}/plan-final.md`));
    assert.ok(sanitized.includes("[foreign task artifact omitted]"));
    assert.ok(sanitized.includes("/workspace/project/src/file.ts"));
  });

  void it("discovers external and legacy roots from authoritative candidates for snapshot and review filtering", async () => {
    const externalRoot = path.join(tmpRoot, "custom-ensemble-root");
    const externalA = path.join(externalRoot, "taskA");
    const externalB = path.join(externalRoot, "taskB");
    const legacyRoot = path.join(tmpRoot, ".helper", "plans");
    const legacyTask = path.join(legacyRoot, "legacy-task");
    for (const folder of [externalA, externalB, legacyTask]) {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, "task.md"), `# ${path.basename(folder)}`);
    }
    fs.writeFileSync(path.join(externalA, "plan-final.md"), "# A");
    const discovered = discoverTaskFoldersFromRootPathsV1([externalRoot, legacyRoot]);
    assert.deepEqual(new Set(discovered), new Set([externalA, externalB, legacyTask].map((p) => path.resolve(p).replace(/\\/g, "/"))));

    const snapshot = await captureForeignTaskArtifactSnapshotV1(externalA, discovered);
    const misplaced = path.join(externalB, "round-progress.md");
    fs.writeFileSync(misplaced, "- [x] accidental write\n");
    const detected = await detectForeignTaskArtifactChangesV1(snapshot, discovered);
    assert.ok(detected.some((change) => change.absolutePath === misplaced));

    const summary = `Wrong link: [plan-final.md](${externalB}/plan-final.md) and [round-progress.md](${legacyTask}/round-progress.md)`;
    const filtered = sanitizeAuthoritativePromptContextV1(summary, externalA, discovered);
    assert.ok(!filtered.includes(`${externalB}/plan-final.md`));
    assert.ok(!filtered.includes(`${legacyTask}/round-progress.md`));
    fs.rmSync(externalRoot, { recursive: true, force: true });
    fs.rmSync(legacyRoot, { recursive: true, force: true });
  });
});

void describe("run1 Step 25: Ensemble's own new tasks, an owner edit said once, move advice only with evidence", () => {
  let root: string;
  let running: string;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "foreign-new-task-"));
    running = path.join(root, ".ensemble", "2026-11-02_task_1");
    fs.mkdirSync(running, { recursive: true });
    fs.writeFileSync(path.join(running, "plan-final.md"), "# running task", "utf8");
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  void it("task folders made by New Task during a round (creation sentinel) produce no note and no move advice", async () => {
    const snapshot = await captureForeignTaskArtifactSnapshotV1(running, []);
    const made: string[] = [];
    for (const name of ["2026-11-05_task_1", "2026-11-05_task_2", "2026-11-05_task_3", "2026-11-05_task_4"]) {
      const folder = path.join(root, ".ensemble", name);
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, ".ensemble-creation-sentinel-v1.json"), "{}", "utf8");
      fs.writeFileSync(path.join(folder, "task.md"), "# a brand new task\n", "utf8");
      made.push(folder);
    }
    const changes = await detectForeignTaskArtifactChangesV1(snapshot, made);
    assert.ok(changes.length >= 4);
    const result = await containForeignTaskArtifactChangesV1(changes, running);
    assert.deepEqual(result.chatNotices, []);
    assert.deepEqual(result.actions, []);
    assert.ok(result.ignoredChanges?.every((ignored) => ignored.why === "ensemble-created-task"));
  });

  void it("only a folder created inside the round's window is exempt: an established task with a sentinel keeps normal handling", async () => {
    const startMs = Date.parse("2026-11-05T05:55:00Z");
    const endMs = Date.parse("2026-11-05T06:01:00Z");
    const window = { startMs, endMs };
    const established = path.join(root, ".ensemble", "2026-10-01_task_2");
    const fresh = path.join(root, ".ensemble", "2026-11-05_task_3");
    for (const [folder, createdAt] of [
      [established, "2026-10-01T08:00:00Z"],
      [fresh, "2026-11-05T05:58:19Z"],
    ] as const) {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(
        path.join(folder, ".ensemble-creation-sentinel-v1.json"),
        JSON.stringify({ schemaVersion: 1, createdAt }),
        "utf8"
      );
    }
    assert.equal(await isEnsembleCreatedTaskFolderV1(fresh, window), true);
    assert.equal(await isEnsembleCreatedTaskFolderV1(established, window), false);
    // A sentinel with no readable creation time is not proof of creation inside the window.
    fs.writeFileSync(path.join(established, ".ensemble-creation-sentinel-v1.json"), "{}", "utf8");
    assert.equal(await isEnsembleCreatedTaskFolderV1(established, window), false);

    // The owner edits the established task's task.md during the round: the once-per-content note appears.
    fs.writeFileSync(path.join(established, "task.md"), "# before\n", "utf8");
    const snapshot = await captureForeignTaskArtifactSnapshotV1(running, [established]);
    fs.writeFileSync(path.join(established, "task.md"), "# the owner's edit\n", "utf8");
    const changes = await detectForeignTaskArtifactChangesV1(snapshot, [established]);
    const result = await containForeignTaskArtifactChangesV1(changes, running, {
      roundWindow: window,
      isRoundRunningInTask: () => false,
    });
    assert.deepEqual(result.chatNotices, ["2026-10-01_task_2 was edited outside this round; nothing needs doing."]);
  });

  void it("a folder New Task made during the round's preparation is still Ensemble's own, though outside the narrower process window", async () => {
    const processWindow = { startMs: Date.parse("2026-11-05T06:00:00Z"), endMs: Date.parse("2026-11-05T06:10:00Z") };
    const wholeRound = { startMs: Date.parse("2026-11-05T05:55:00Z"), endMs: Date.parse("2026-11-05T06:12:00Z") };
    const early = path.join(root, ".ensemble", "2026-11-05_task_7");
    const snapshot = await captureForeignTaskArtifactSnapshotV1(running, []);
    fs.mkdirSync(early, { recursive: true });
    fs.writeFileSync(
      path.join(early, ".ensemble-creation-sentinel-v1.json"),
      JSON.stringify({ schemaVersion: 1, createdAt: "2026-11-05T05:58:19Z" }),
      "utf8"
    );
    fs.writeFileSync(path.join(early, "task.md"), "# a brand new task\n", "utf8");
    const changes = await detectForeignTaskArtifactChangesV1(snapshot, [early]);
    const result = await containForeignTaskArtifactChangesV1(changes, running, {
      roundWindow: processWindow,
      createdWithinWindow: wholeRound,
      isRoundRunningInTask: () => false,
    });
    assert.deepEqual(result.chatNotices, []);
    assert.deepEqual(result.actions, []);
    // With only the narrower window it would not be recognised, which is why the whole-round span is passed.
    assert.equal(await isEnsembleCreatedTaskFolderV1(early, processWindow), false);
    assert.equal(await isEnsembleCreatedTaskFolderV1(early, wholeRound), true);
  });

  void it("an owner edit of another task's task.md gets one short line, once per task and content", async () => {
    const other = path.join(root, ".ensemble", "2026-11-03_task_9");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, "task.md"), "# before\n", "utf8");
    const snapshot = await captureForeignTaskArtifactSnapshotV1(running, [other]);
    fs.writeFileSync(path.join(other, "task.md"), "# after the owner edited it\n", "utf8");
    const changes = await detectForeignTaskArtifactChangesV1(snapshot, [other]);

    const noted = new Set<string>();
    const options = {
      isRoundRunningInTask: () => false,
      isEditAlreadyNoted: (folder: string, sha: string) => noted.has(`${folder}:${sha}`),
    };
    const first = await containForeignTaskArtifactChangesV1(changes, running, options);
    assert.deepEqual(first.chatNotices, ["2026-11-03_task_9 was edited outside this round; nothing needs doing."]);
    for (const edit of first.notedEdits ?? []) noted.add(`${edit.taskFolderPath}:${edit.sha256}`);

    const second = await containForeignTaskArtifactChangesV1(changes, running, options);
    assert.deepEqual(second.chatNotices, []);
    assert.equal(second.ignoredChanges?.[0]?.why, "already-noted");
  });

  void it("move advice appears only for a change inside the round's process window whose content names this task", async () => {
    const other = path.join(root, ".ensemble", "2026-11-04_task_7");
    fs.mkdirSync(other, { recursive: true });
    const snapshot = await captureForeignTaskArtifactSnapshotV1(running, [other]);
    fs.writeFileSync(path.join(other, "plan-final.md"), "mentions 2026-11-02_task_1 here", "utf8");
    const changes = await detectForeignTaskArtifactChangesV1(snapshot, [other]);
    const mtime = changes[0]!.fingerprint.mtimeMs;

    const noEvidence = await containForeignTaskArtifactChangesV1(changes, running, { isEnsembleCreatedFolder: () => false });
    assert.ok(noEvidence.chatNotices.length === 1 && !/move it into/.test(noEvidence.chatNotices[0]!));

    const outsideWindow = await containForeignTaskArtifactChangesV1(changes, running, {
      isEnsembleCreatedFolder: () => false,
      roundWindow: { startMs: mtime - 10_000, endMs: mtime - 5_000 },
      currentTaskNames: ["2026-11-02_task_1"],
    });
    assert.ok(!/move it into/.test(outsideWindow.chatNotices[0]!));

    const notNamed = await containForeignTaskArtifactChangesV1(changes, running, {
      isEnsembleCreatedFolder: () => false,
      roundWindow: { startMs: mtime - 1_000, endMs: mtime + 1_000 },
      currentTaskNames: ["some other task"],
    });
    assert.ok(!/move it into/.test(notNamed.chatNotices[0]!));

    const evidence = await containForeignTaskArtifactChangesV1(changes, running, {
      isEnsembleCreatedFolder: () => false,
      roundWindow: { startMs: mtime - 1_000, endMs: mtime + 1_000 },
      currentTaskNames: ["2026-11-02_task_1"],
    });
    assert.match(evidence.chatNotices[0]!, /move it into/);
  });
});
