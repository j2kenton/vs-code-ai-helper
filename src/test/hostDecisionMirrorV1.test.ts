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
  decodeMirroredDecisionV1,
  liveMirroredDecisionsV1,
  readRunnerDecisionsSnapshotV1,
  writeRunnerDecisionsSnapshotV1,
} from "../services/hostDecisionMirrorV1";
import { WORKFLOW_DECISIONS_STORAGE_KEY_V1, WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import type { WorkflowDecisionV1 } from "../types/workflowDecisionV1";

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

function decision(overrides: Partial<WorkflowDecisionV1> = {}): WorkflowDecisionV1 {
  return {
    decisionId: "d-1",
    decisionKey: "reviewPlateau",
    taskCanonicalId: "/w/.ensemble/2026-09-17_task_3",
    stage: "impl-low-review",
    whatHappened: "5 rounds without progress.",
    whyUserNeeded: "Only you can decide whether to advance.",
    options: [
      {
        optionId: "advance",
        label: "Advance to Publish",
        consequence: "The task moves on with the blockers recorded.",
        resumeKind: "unpause",
        effect: { kind: "command", command: "vs-code-ai-helper.resumeAndSetTaskStage", args: [{ stage: "publish" }] },
      },
    ],
    recommendation: { kind: "none", reasoning: "the trade-off is the user's" },
    createdAt: "2026-09-17T16:00:00.000Z",
    state: "pending",
    ...overrides,
  } as WorkflowDecisionV1;
}

void describe("hostDecisionMirrorV1", () => {
  void it("round-trips the runner's pending decisions through the shared file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ensemble-decisions-"));
    try {
      assert.equal(await readRunnerDecisionsSnapshotV1(dir), undefined, "no runner has written yet");
      assert.equal(await writeRunnerDecisionsSnapshotV1(dir, [decision()]), true);
      const snapshot = await readRunnerDecisionsSnapshotV1(dir);
      assert.deepEqual(snapshot?.decisions, [decision()]);
      assert.ok(typeof snapshot?.writtenAt === "number");
      await fs.writeFile(path.join(dir, "decisions-v1.json"), "{torn");
      assert.equal(await readRunnerDecisionsSnapshotV1(dir), undefined);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("counts the records it could not decode, so the viewer can say a question exists", async () => {
    // Dropping them silently left the panel asserting "Waiting for your
    // answer" with no card and no way to find out why (verification review,
    // 2026-09-18).
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ensemble-decisions-undecodable-"));
    try {
      await fs.writeFile(
        path.join(dir, "decisions-v1.json"),
        JSON.stringify({
          writtenAt: Date.now(),
          decisions: [decision(), { decisionId: "from-a-newer-version", options: [] }, { nonsense: true }],
        })
      );
      const snapshot = await readRunnerDecisionsSnapshotV1(dir);
      assert.deepEqual(snapshot?.decisions, [decision()]);
      assert.equal(snapshot?.undecodable, 2);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("the newest snapshot wins, whichever write finishes last", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ensemble-decisions-order-"));
    try {
      // Both writes are in flight at once, exactly as the runner's
      // change-listener and heartbeat can be: the resolved (empty) state must
      // not be overwritten by the older pending one landing late.
      const [first, second] = await Promise.all([
        writeRunnerDecisionsSnapshotV1(dir, [decision()]),
        writeRunnerDecisionsSnapshotV1(dir, []),
      ]);
      assert.equal(second, true, "the newer snapshot is always written");
      assert.equal(first, false, "the superseded snapshot is dropped, not published late");
      assert.deepEqual((await readRunnerDecisionsSnapshotV1(dir))?.decisions, []);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("drops a record that is not structurally a decision, and keeps the rest", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ensemble-decisions-junk-"));
    try {
      // What a hostile or half-written file looks like: the relay directory
      // sits in a workspace the provider CLIs can write.
      await fs.writeFile(
        path.join(dir, "decisions-v1.json"),
        JSON.stringify({
          writtenAt: Date.now(),
          decisions: [
            { ...decision({ decisionId: "no-options" }), options: null },
            { ...decision({ decisionId: "bad-effect" }), options: [{ optionId: "x", label: "X", consequence: "", effect: { kind: "command" } }] },
            decision({ decisionId: "good" }),
            "not-an-object",
          ],
        })
      );
      const snapshot = await readRunnerDecisionsSnapshotV1(dir);
      assert.deepEqual(snapshot?.decisions.map((d) => d.decisionId), ["good"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
    assert.equal(decodeMirroredDecisionV1(undefined), undefined);
    assert.equal(decodeMirroredDecisionV1({ ...decision(), options: [] }), undefined);
    assert.ok(decodeMirroredDecisionV1(decision({ options: [{ optionId: "o", label: "L", consequence: "", resumeKind: "unpause", effect: { kind: "doNothing" } }] })));
  });

  void it("rejects a record the webview would throw on: no recommendation, junk evidence, a fabricated stage, a settled state", () => {
    const base = decision();
    assert.ok(decodeMirroredDecisionV1(base, (stage) => stage === base.stage));
    // The webview dereferences recommendation.kind unguarded; one bad card
    // aborted the render loop and took every later card with it.
    assert.equal(decodeMirroredDecisionV1({ ...base, recommendation: undefined }), undefined);
    assert.equal(decodeMirroredDecisionV1({ ...base, recommendation: { kind: "option", optionId: "nope", reasoning: "x" } }), undefined);
    assert.ok(decodeMirroredDecisionV1({ ...base, recommendation: { kind: "option", optionId: "advance", reasoning: "x" } }));
    assert.equal(decodeMirroredDecisionV1({ ...base, evidence: [null] }), undefined);
    assert.equal(decodeMirroredDecisionV1({ ...base, evidence: [{ label: "a" }] }), undefined);
    assert.ok(decodeMirroredDecisionV1({ ...base, evidence: [{ label: "a", detail: "b" }] }));
    assert.equal(decodeMirroredDecisionV1({ ...base, state: "resolved" }), undefined, "a viewer shows open questions only");
    assert.equal(decodeMirroredDecisionV1({ ...base, createdAt: undefined }), undefined);
    assert.equal(
      decodeMirroredDecisionV1({ ...base, stage: "made-up-stage" }, (stage) => stage === base.stage),
      undefined,
      "a fabricated stage would route the card into a conversation that does not exist"
    );
  });

  void it("a decision is only answerable while the runner is still reporting", () => {
    const now = Date.parse("2026-09-17T17:00:00Z");
    const STALE = 90_000;
    assert.deepEqual(liveMirroredDecisionsV1({ writtenAt: now, decisions: [decision()], undecodable: 0 }, now, STALE), [decision()]);
    assert.deepEqual(liveMirroredDecisionsV1({ writtenAt: now - STALE - 1, decisions: [decision()], undecodable: 0 }, now, STALE), []);
    assert.deepEqual(liveMirroredDecisionsV1(undefined, now, STALE), []);
  });

  void it("the viewer's store lists the runner's decisions AND its own; its own writes never carry the runner's", async () => {
    const base = new MapMemento();
    await base.update("lastChatTarget", { stage: "plan" });
    const local = decision({ decisionId: "viewer-local", decisionKey: "reconcilePlanChecklist" });
    await base.update(WORKFLOW_DECISIONS_STORAGE_KEY_V1, [local]);
    const mirror = createMirroredDecisionsMementoV1(base, WORKFLOW_DECISIONS_STORAGE_KEY_V1);
    const store = new WorkflowDecisionStoreV1(mirror.memento);

    assert.deepEqual(store.listPending().map((d) => d.decisionId), ["viewer-local"], "its own decision still renders");
    assert.equal(mirror.setDecisions([decision()]), true);
    assert.equal(mirror.setDecisions([decision()]), false, "unchanged");
    assert.deepEqual(
      store.listPending(decision().taskCanonicalId).map((d) => d.decisionId),
      ["viewer-local", "d-1"],
      "both the viewer's own and the runner's are answerable"
    );
    assert.equal(mirror.isMirrored("d-1"), true, "the runner's answer must be relayed");
    assert.equal(mirror.isMirrored("viewer-local"), false, "its own is resolved here");
    assert.deepEqual(mirror.memento.get("lastChatTarget"), { stage: "plan" });
    assert.equal(mirror.memento.get("missing", 5), 5);

    // Resolving its OWN decision must not persist the runner's records here.
    assert.equal((await store.resolve("viewer-local", "advance")).kind, "resolved");
    const persisted = base.values.get(WORKFLOW_DECISIONS_STORAGE_KEY_V1) as readonly WorkflowDecisionV1[];
    assert.deepEqual(persisted.map((d) => d.decisionId), ["viewer-local"]);
    assert.equal(persisted[0]!.state, "resolved");
    assert.deepEqual(store.listPending().map((d) => d.decisionId), ["d-1"]);
  });

  /**
   * Pre-1.0.0 fixes register, items 14/22 (Part 3, Step 2): "decodeOption
   * accepts a missing resumeKind and the mirror applies the same
   * normalizer." A runner still running an older build mirrors a record
   * whose options never had the field at all — that must decode, not be
   * dropped as `undecodable` (which would silently hide the whole card from
   * every viewer). A PRESENT value that is neither literal is a genuinely
   * malformed record and is rejected like any other structural violation.
   */
  void it("decodes a mirrored option missing resumeKind entirely, normalizing it to 'unpause'", () => {
    const legacyOption = { optionId: "advance", label: "Advance", consequence: "Moves on.", effect: { kind: "doNothing" } };
    const decoded = decodeMirroredDecisionV1({
      ...decision(),
      options: [legacyOption],
      recommendation: { kind: "option", optionId: "advance", reasoning: "x" },
    });
    assert.ok(decoded);
    assert.equal(decoded.options[0]!.resumeKind, "unpause");
  });

  void it("rejects a mirrored option whose resumeKind is present but not a recognised literal", () => {
    const badOption = {
      optionId: "advance",
      label: "Advance",
      consequence: "Moves on.",
      resumeKind: "sideways",
      effect: { kind: "doNothing" },
    };
    assert.equal(
      decodeMirroredDecisionV1({
        ...decision(),
        options: [badOption],
        recommendation: { kind: "option", optionId: "advance", reasoning: "x" },
      }),
      undefined
    );
  });

  void it("passes through an already-valid mirrored resumeKind unchanged", () => {
    const goodOption = {
      optionId: "advance",
      label: "Advance",
      consequence: "Moves on.",
      resumeKind: "continue",
      effect: { kind: "doNothing" },
    };
    const decoded = decodeMirroredDecisionV1({
      ...decision(),
      options: [goodOption],
      recommendation: { kind: "option", optionId: "advance", reasoning: "x" },
    });
    assert.ok(decoded);
    assert.equal(decoded.options[0]!.resumeKind, "continue");
  });
});
