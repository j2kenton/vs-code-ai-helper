/**
 * The runner's running operations, as a viewer shows them
 * (hostOperationsMirrorV1.ts).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  describeRunnerActivityV1,
  readRunnerOperationsSnapshotV1,
  RUNNER_OPERATIONS_STALE_MS_V1,
  writeRunnerOperationsSnapshotV1,
} from "../services/hostOperationsMirrorV1";

const NOW = Date.parse("2026-09-17T13:10:00Z");

void describe("hostOperationsMirrorV1", () => {
  void it("round-trips a snapshot through the shared file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ensemble-ops-"));
    try {
      assert.equal(await readRunnerOperationsSnapshotV1(dir), undefined, "no runner has written yet");
      const snapshot = {
        writtenAt: NOW,
        operations: [
          { id: "root", label: "Fast Forward Review", taskName: "Increase Spacing", startedAt: NOW - 5 * 60000, waitingForUser: false },
        ],
      };
      await writeRunnerOperationsSnapshotV1(dir, snapshot);
      assert.deepEqual(await readRunnerOperationsSnapshotV1(dir), snapshot);
      await fs.writeFile(path.join(dir, "operations-v1.json"), "{not json");
      assert.equal(await readRunnerOperationsSnapshotV1(dir), undefined);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("shows the root operation with the most specific current activity", () => {
    const view = describeRunnerActivityV1(
      {
        writtenAt: NOW - 1000,
        operations: [
          { id: "root", label: "Fast Forward Review", taskName: "Increase Spacing", startedAt: NOW - 7 * 60000, waitingForUser: false, activity: "starting" },
          { id: "child", parentId: "root", label: "Review", taskName: "Increase Spacing", startedAt: NOW - 60000, waitingForUser: false, activity: "running verification" },
        ],
      },
      NOW
    );
    assert.equal(view.kind, "running");
    assert.ok(view.kind === "running");
    assert.equal(view.text, "Runner: Fast Forward Review — Increase Spacing · running verification");
    assert.deepEqual(view.details, ["Fast Forward Review — Increase Spacing (7 min)"]);
    assert.equal(view.waitingForUser, false);
  });

  void it("an empty or missing snapshot is idle; a silent runner with work listed is stale, never still spinning", () => {
    assert.deepEqual(describeRunnerActivityV1(undefined, NOW), { kind: "idle" });
    assert.deepEqual(describeRunnerActivityV1({ writtenAt: NOW, operations: [] }, NOW), { kind: "idle" });
    const old = NOW - RUNNER_OPERATIONS_STALE_MS_V1 - 1;
    const stale = describeRunnerActivityV1(
      { writtenAt: old, operations: [{ id: "r", label: "Review", taskName: "t", startedAt: old, waitingForUser: false }] },
      NOW
    );
    assert.equal(stale.kind, "stale");
    assert.deepEqual(describeRunnerActivityV1({ writtenAt: old, operations: [] }, NOW), { kind: "idle" });
  });
});
