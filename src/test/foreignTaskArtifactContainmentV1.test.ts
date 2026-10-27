import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  captureForeignTaskArtifactSnapshotV1,
  containForeignTaskArtifactChangesV1,
  detectForeignTaskArtifactChangesV1,
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
