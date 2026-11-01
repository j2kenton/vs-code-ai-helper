/**
 * bugs4 item 8 (and item 26's note wording): a pin, archive or rename of
 * another task during a round, or a hand edit to another task's task.md, is
 * not "a round writing into a foreign task folder". Containment stays for
 * genuine misplacement (content naming the current task, or no attribution).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  captureForeignTaskArtifactSnapshotV1,
  containForeignTaskArtifactChangesV1,
  detectForeignTaskArtifactChangesV1,
} from "../utils/foreignTaskArtifactContainmentV1";
import {
  EXTENSION_WRITE_WINDOW_MS_V1,
  recordExtensionTaskArtifactWriteV1,
  resetExtensionTaskArtifactWritesV1,
  wasExtensionTaskArtifactWriteV1,
} from "../utils/extensionTaskWriteRegistryV1";
import * as crypto from "node:crypto";

void describe("foreign-folder containment: legitimate writes are not misplacement (bugs4 item 8)", () => {
  let tmpRoot: string;
  let taskA: string;
  let taskB: string;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "foreign-legit-"));
    taskA = path.join(tmpRoot, ".ensemble", "2026-10-28_task_3");
    taskB = path.join(tmpRoot, ".ensemble", "2026-10-28_task_1");
    fs.mkdirSync(taskA, { recursive: true });
    fs.mkdirSync(taskB, { recursive: true });
  });

  beforeEach(() => {
    resetExtensionTaskArtifactWritesV1();
    fs.writeFileSync(path.join(taskB, "task-progress.json"), JSON.stringify({ taskFolder: "2026-10-28_task_1", status: "paused" }), "utf8");
    fs.writeFileSync(path.join(taskB, "task.md"), "# Task B\n", "utf8");
  });

  after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  void it("pinning a paused task B during task A's round (an extension write) produces no notice and no action, and leaves B's file untouched", async () => {
    const snapshot = await captureForeignTaskArtifactSnapshotV1(taskA, [taskB]);
    const pinned = JSON.stringify({ taskFolder: "2026-10-28_task_1", status: "paused", pinnedAt: "2026-10-29T01:03:27.045Z" });
    fs.writeFileSync(path.join(taskB, "task-progress.json"), pinned, "utf8");
    recordExtensionTaskArtifactWriteV1(path.join(taskB, "task-progress.json"), pinned);

    const changes = await detectForeignTaskArtifactChangesV1(snapshot, [taskB]);
    assert.equal(changes.length, 1);
    const result = await containForeignTaskArtifactChangesV1(changes, taskA, { isConcurrentForeignUpdate: false });
    assert.deepEqual(result.chatNotices, []);
    assert.deepEqual(result.actions, []);
    assert.equal(result.ignoredChanges?.[0]?.why, "extension-write");
    assert.equal(fs.readFileSync(path.join(taskB, "task-progress.json"), "utf8"), pinned);
  });

  void it("an extension write to a task that is ACTIVE is ignored the same way", async () => {
    const snapshot = await captureForeignTaskArtifactSnapshotV1(taskA, [taskB]);
    const archived = JSON.stringify({ taskFolder: "2026-10-28_task_1", status: "archived" });
    fs.writeFileSync(path.join(taskB, "task-progress.json"), archived, "utf8");
    recordExtensionTaskArtifactWriteV1(path.join(taskB, "task-progress.json"), archived);
    const changes = await detectForeignTaskArtifactChangesV1(snapshot, [taskB]);
    const result = await containForeignTaskArtifactChangesV1(changes, taskA, { isConcurrentForeignUpdate: true });
    assert.deepEqual(result.chatNotices, []);
  });

  void it("a task-progress.json whose own taskFolder names its folder is that task's own update, even with no recorded extension write", async () => {
    const snapshot = await captureForeignTaskArtifactSnapshotV1(taskA, [taskB]);
    fs.writeFileSync(
      path.join(taskB, "task-progress.json"),
      JSON.stringify({ taskFolder: "2026-10-28_task_1", displayName: "Map User Data", pinnedAt: "2026-10-29T01:03:27.045Z" }),
      "utf8"
    );
    const changes = await detectForeignTaskArtifactChangesV1(snapshot, [taskB]);
    const result = await containForeignTaskArtifactChangesV1(changes, taskA, { isConcurrentForeignUpdate: false });
    assert.deepEqual(result.chatNotices, []);
    assert.equal(result.ignoredChanges?.[0]?.why, "own-task-update");
  });

  void it("a hand edit to an existing task.md in another task's folder is a note at most: it names the file and when, and never talks about copies or choosing", async () => {
    const snapshot = await captureForeignTaskArtifactSnapshotV1(taskA, [taskB]);
    fs.writeFileSync(path.join(taskB, "task.md"), "# Task B\n\n## 37. A new finding\n", "utf8");
    const changes = await detectForeignTaskArtifactChangesV1(snapshot, [taskB]);
    const result = await containForeignTaskArtifactChangesV1(changes, taskA, { isConcurrentForeignUpdate: true });
    assert.equal(result.chatNotices.length, 1);
    const notice = result.chatNotices[0]!;
    assert.match(notice, /'task\.md' in another task's folder/);
    assert.match(notice, /changed at \d{4}-\d{2}-\d{2}T/);
    assert.doesNotMatch(notice, /both copies|choose which copy|compare/i);
    assert.equal(fs.readFileSync(path.join(taskB, "task.md"), "utf8").includes("A new finding"), true, "the file is left exactly as edited");
  });

  void it("control: a task-progress.json whose content names task A, written into B's folder, is still reported as misplaced and left in place", async () => {
    const snapshot = await captureForeignTaskArtifactSnapshotV1(taskA, [taskB]);
    fs.writeFileSync(path.join(taskB, "task-progress.json"), JSON.stringify({ taskFolder: "2026-10-28_task_3" }), "utf8");
    const changes = await detectForeignTaskArtifactChangesV1(snapshot, [taskB]);
    const result = await containForeignTaskArtifactChangesV1(changes, taskA, { isConcurrentForeignUpdate: false });
    assert.equal(result.chatNotices.length, 1);
    assert.match(result.chatNotices[0]!, /ownership/);
    assert.equal(result.actions[0]?.outcome, "preserved-ambiguous");
    assert.equal(result.ignoredChanges?.length, 0);
  });

  void it("control: a new, unattributed round-progress.md in B's folder is still reported", async () => {
    const snapshot = await captureForeignTaskArtifactSnapshotV1(taskA, [taskB]);
    fs.writeFileSync(path.join(taskB, "round-progress.md"), "- [x] something\n", "utf8");
    const changes = await detectForeignTaskArtifactChangesV1(snapshot, [taskB]);
    const result = await containForeignTaskArtifactChangesV1(changes, taskA, {});
    assert.equal(result.chatNotices.length, 1);
    assert.match(result.chatNotices[0]!, /ownership was not established/);
    fs.unlinkSync(path.join(taskB, "round-progress.md"));
  });
});

void describe("extension write registry window edges (bugs4 item 8)", () => {
  const file = "/tmp/some-task/task-progress.json";
  const sha = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");

  void it("matches the exact bytes inside the window, both edges inclusive, and not after it", () => {
    resetExtensionTaskArtifactWritesV1();
    const t0 = 1_000_000;
    recordExtensionTaskArtifactWriteV1(file, "pinned", t0);
    assert.equal(wasExtensionTaskArtifactWriteV1(file, sha("pinned"), t0), true);
    assert.equal(wasExtensionTaskArtifactWriteV1(file, sha("pinned"), t0 + EXTENSION_WRITE_WINDOW_MS_V1), true);
    assert.equal(wasExtensionTaskArtifactWriteV1(file, sha("pinned"), t0 + EXTENSION_WRITE_WINDOW_MS_V1 + 1), false);
  });

  void it("different bytes (someone edited after the extension wrote) are not excused", () => {
    resetExtensionTaskArtifactWritesV1();
    recordExtensionTaskArtifactWriteV1(file, "pinned", 5);
    assert.equal(wasExtensionTaskArtifactWriteV1(file, sha("pinned + hand edit"), 6), false);
  });
});
