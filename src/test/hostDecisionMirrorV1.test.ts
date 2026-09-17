/**
 * The runner's pending decisions, as a viewer reads them
 * (hostDecisionMirrorV1.ts).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type * as vscode from "vscode";
import {
  createMirroredDecisionsMementoV1,
  readRunnerDecisionsSnapshotV1,
  writeRunnerDecisionsSnapshotV1,
} from "../services/hostDecisionMirrorV1";
import { WORKFLOW_DECISIONS_STORAGE_KEY_V1, WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";

class MapMemento implements vscode.Memento {
  readonly values = new Map<string, unknown>();
  keys(): readonly string[] {
    return [...this.values.keys()];
  }
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.values.has(key) ? (this.values.get(key) as T) : defaultValue;
  }
  update(key: string, value: unknown): Thenable<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

const DECISION = {
  decisionId: "d-1",
  decisionKey: "reviewPlateau",
  taskCanonicalId: "/w/.ensemble/2026-09-17_task_3",
  stage: "impl-low-review",
  state: "pending",
  options: [{ optionId: "advance", label: "Advance to Publish" }],
};

void describe("hostDecisionMirrorV1", () => {
  void it("round-trips the runner's pending decisions through the shared file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ensemble-decisions-"));
    try {
      assert.deepEqual(await readRunnerDecisionsSnapshotV1(dir), [], "no runner has written yet");
      await writeRunnerDecisionsSnapshotV1(dir, [DECISION]);
      assert.deepEqual(await readRunnerDecisionsSnapshotV1(dir), [DECISION]);
      await fs.writeFile(path.join(dir, "decisions-v1.json"), "{torn");
      assert.deepEqual(await readRunnerDecisionsSnapshotV1(dir), []);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("the viewer's store lists the runner's decisions; every other key and every write stays the viewer's own", async () => {
    const base = new MapMemento();
    await base.update("lastChatTarget", { stage: "plan" });
    await base.update(WORKFLOW_DECISIONS_STORAGE_KEY_V1, [{ ...DECISION, decisionId: "viewer-local" }]);
    const mirror = createMirroredDecisionsMementoV1(base, WORKFLOW_DECISIONS_STORAGE_KEY_V1);
    const store = new WorkflowDecisionStoreV1(mirror.memento);
    assert.deepEqual(store.listPending(), [], "nothing until the runner's snapshot is read");
    assert.equal(mirror.setDecisions([DECISION]), true);
    assert.equal(mirror.setDecisions([DECISION]), false, "unchanged");
    assert.deepEqual(store.listPending(DECISION.taskCanonicalId).map((d) => d.decisionId), ["d-1"]);
    assert.deepEqual(mirror.memento.get("lastChatTarget"), { stage: "plan" });
    assert.equal(mirror.memento.get("missing", 5), 5);
    await store.resolve("d-1", "advance");
    assert.equal(store.get("d-1")?.state, "pending", "a viewer never records an answer: the runner does");
    assert.equal((base.values.get(WORKFLOW_DECISIONS_STORAGE_KEY_V1) as unknown[]).length, 1, "the viewer's own records are untouched");
  });
});
