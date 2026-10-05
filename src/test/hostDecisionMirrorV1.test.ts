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
  answeredDecisionsForMirrorV1,
  createMirroredDecisionsMementoV1,
  type MirroredAnsweredDecisionV1,
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

void describe("hostDecisionMirrorV1 — answered decisions (display only)", () => {
  const answered = (overrides: Record<string, unknown> = {}): MirroredAnsweredDecisionV1 =>
    ({
      decisionId: "d-1",
      taskCanonicalId: "/w/.ensemble/2026-09-17_task_3",
      stage: "impl-low-review",
      createdAt: "2026-09-17T16:00:00.000Z",
      resolvedOptionId: "advance",
      chosenLabel: "Advance to Publish",
      whatHappened: "5 rounds without progress.",
      ...overrides,
    }) as MirroredAnsweredDecisionV1;
  const resolvedRecord = (overrides: Partial<WorkflowDecisionV1> = {}): WorkflowDecisionV1 =>
    decision({ state: "resolved", resolvedOptionId: "advance", resolvedAt: "2026-09-17T16:05:00.000Z", ...overrides });

  void it("projects the chosen option's label, falls back to the option id, and drops pending and choice-less records", () => {
    const projected = answeredDecisionsForMirrorV1(
      [
        resolvedRecord(),
        resolvedRecord({ decisionId: "d-unknown-option", resolvedOptionId: "gone" }),
        resolvedRecord({ decisionId: "d-also-pending" }),
        resolvedRecord({ decisionId: "d-no-choice", resolvedOptionId: undefined }),
      ],
      new Set(["d-also-pending"])
    );
    assert.deepEqual(
      projected.map((entry) => [entry.decisionId, entry.chosenLabel]),
      [
        ["d-1", "Advance to Publish"],
        ["d-unknown-option", "gone"],
      ]
    );
    assert.equal(projected[0]!.resolvedAt, "2026-09-17T16:05:00.000Z");
  });

  void it("round-trips through the snapshot file next to the unchanged pending list", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ensemble-decisions-answered-"));
    try {
      assert.equal(await writeRunnerDecisionsSnapshotV1(dir, [decision()], [answered()]), true);
      const snapshot = await readRunnerDecisionsSnapshotV1(dir);
      assert.deepEqual(snapshot?.decisions, [decision()]);
      assert.deepEqual(snapshot?.answered, [answered()]);
      assert.equal(snapshot?.undecodable, 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("an old runner's snapshot (no answered field) reads as no answers, with decisions unchanged", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ensemble-decisions-oldrunner-"));
    try {
      await fs.writeFile(
        path.join(dir, "decisions-v1.json"),
        JSON.stringify({ writtenAt: Date.now(), decisions: [decision()] })
      );
      const snapshot = await readRunnerDecisionsSnapshotV1(dir);
      assert.deepEqual(snapshot?.answered, []);
      assert.deepEqual(snapshot?.decisions, [decision()]);
      assert.equal(snapshot?.undecodable, 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("an old viewer's view is unchanged by the extra field: same decisions and undecodable with or without it", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ensemble-decisions-oldviewer-"));
    try {
      const body = { writtenAt: 1_000, decisions: [decision(), { nonsense: true }] };
      await fs.writeFile(path.join(dir, "decisions-v1.json"), JSON.stringify(body));
      const without = await readRunnerDecisionsSnapshotV1(dir);
      await fs.writeFile(path.join(dir, "decisions-v1.json"), JSON.stringify({ ...body, answered: [answered()] }));
      const withAnswered = await readRunnerDecisionsSnapshotV1(dir);
      assert.deepEqual(withAnswered?.decisions, without?.decisions);
      assert.equal(withAnswered?.undecodable, without?.undecodable);
      assert.equal(withAnswered?.undecodable, 1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("drops malformed answered entries without counting them as undecodable questions", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ensemble-decisions-badanswered-"));
    try {
      await fs.writeFile(
        path.join(dir, "decisions-v1.json"),
        JSON.stringify({
          writtenAt: Date.now(),
          decisions: [decision()],
          answered: [
            answered(),
            answered({ decisionId: "d-stage", stage: "made-up-stage" }),
            answered({ decisionId: "d-label", chosenLabel: "" }),
            answered({ decisionId: "d-what", whatHappened: 5 }),
            answered({ decisionId: "d-at", resolvedAt: 7 }),
            "not an object",
            null,
          ],
        })
      );
      const snapshot = await readRunnerDecisionsSnapshotV1(dir, (stage) => stage === "impl-low-review");
      assert.deepEqual(snapshot?.answered.map((entry) => entry.decisionId), ["d-1"]);
      assert.equal(snapshot?.undecodable, 0);
      assert.equal(await readRunnerDecisionsSnapshotV1(dir).then((s) => s?.answered.length), 2, "an unconstrained stage keeps the made-up stage only");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("answeredFor returns undefined for an id also mirrored as pending, and answers never enter the decisions key or base", async () => {
    const base = new MapMemento();
    const mirror = createMirroredDecisionsMementoV1(base, WORKFLOW_DECISIONS_STORAGE_KEY_V1);
    assert.equal(mirror.setAnswered([answered({ decisionId: "d-done" }), answered({ decisionId: "d-1" })]), true);
    assert.equal(mirror.setAnswered([answered({ decisionId: "d-done" }), answered({ decisionId: "d-1" })]), false, "unchanged");
    assert.equal(mirror.answeredFor("d-done")?.chosenLabel, "Advance to Publish");
    assert.equal(mirror.answeredFor("unknown"), undefined);

    mirror.setDecisions([decision()]);
    assert.equal(mirror.answeredFor("d-1"), undefined, "pending wins");

    const store = new WorkflowDecisionStoreV1(mirror.memento);
    assert.deepEqual(store.listPending().map((d) => d.decisionId), ["d-1"]);
    assert.equal(store.get("d-done"), undefined, "an answer is not a decision record");
    assert.deepEqual(store.listResolvedV1(), []);
    assert.deepEqual(base.keys(), [], "nothing is written to the base memento");
    const posted = await store.post({
      decisionId: "local",
      decisionKey: "exampleDecision",
      taskCanonicalId: "/w/.ensemble/2026-09-17_task_3",
      stage: "impl",
      whatHappened: "Something happened.",
      whyUserNeeded: "Only you can choose.",
      options: [{ optionId: "go", label: "Go", consequence: "Goes.", resumeKind: "unpause", effect: { kind: "doNothing" } }],
      recommendation: { kind: "none", reasoning: "no basis" },
      createdAt: new Date().toISOString(),
    });
    assert.equal(posted.ok, true);
    const persisted = base.values.get(WORKFLOW_DECISIONS_STORAGE_KEY_V1) as readonly WorkflowDecisionV1[];
    assert.deepEqual(persisted.map((d) => d.decisionId), ["local"], "only this window's own record is persisted");
  });

  void it("a store change that only resolves a decision changes the runner's snapshot signature", async () => {
    // The runner's change-listener compares this exact shape (extension.ts):
    // resolving must be a change, or the viewer would keep the card pending.
    const store = new WorkflowDecisionStoreV1(new MapMemento());
    const posted = await store.post({
      decisionId: "d-sig",
      decisionKey: "exampleDecision",
      taskCanonicalId: "/w/.ensemble/2026-09-17_task_3",
      stage: "impl",
      whatHappened: "Something happened.",
      whyUserNeeded: "Only you can choose.",
      options: [
        {
          optionId: "go",
          label: "Go",
          consequence: "Goes.",
          resumeKind: "unpause",
          effect: { kind: "doNothing" },
        },
      ],
      recommendation: { kind: "none", reasoning: "no basis" },
      createdAt: new Date().toISOString(),
    });
    assert.equal(posted.ok, true);
    const signature = (): string => {
      const pending = store.listPending();
      const answered = answeredDecisionsForMirrorV1(
        store.listResolvedV1(),
        new Set(pending.map((d) => d.decisionId))
      );
      return JSON.stringify({ pending, answered });
    };
    const before = signature();
    assert.equal((await store.resolve("d-sig", "go")).kind, "resolved");
    const after = signature();
    assert.notEqual(after, before);
    assert.match(after, /"chosenLabel":"Go"/);
  });
});
