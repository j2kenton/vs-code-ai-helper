/**
 * bugs3 Step 19 (item 19): "Keep running Implementation" is tied to the exact
 * Implementation operation the card was raised for. Once that operation has
 * ended the card stops claiming a run, refuses the no-op answer, and offers an
 * explicit "Run Implementation"; a live run keeps the original harmless no-op.
 */
import * as assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import type { CreateWorkflowDecisionInputV1 } from "../types/workflowDecisionV1";
import { setOperationLiveByIdLookupV1 } from "../utils/liveTaskOperationLookupV1";

class FakeMemento {
  private readonly values = new Map<string, unknown>();
  get<T>(key: string, defaultValue: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }
  update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

const TASK = "/tmp/tasks/live-ref-task";

function routingCard(operationId: string | null = "op-1"): CreateWorkflowDecisionInputV1 {
  return {
    decisionId: "routing-1",
    decisionKey: "preImplementationRouting",
    taskCanonicalId: TASK,
    stage: "impl",
    whatHappened: "Implementation is running now anyway.",
    whyUserNeeded: "Both actions are valid here.",
    options: [
      {
        optionId: "goToReviewAndApply",
        label: "Go to Review & Apply",
        resumeKind: "continue",
        consequence: "Cancels the running round.",
        effect: { kind: "command", command: "vs-code-ai-helper.resumeIfPausedThenGoToReviewAndApply", args: [{ taskFolderPath: TASK }] },
      },
      {
        optionId: "letItRun",
        label: "Keep running Implementation",
        resumeKind: "continue",
        consequence: "Does nothing further. Implementation keeps running as already started.",
        effect: { kind: "doNothing" },
      },
    ],
    recommendation: { kind: "option", optionId: "letItRun", reasoning: "The blockers are unbuilt work." },
    createdAt: new Date().toISOString(),
    ...(operationId !== null ? { liveReference: { kind: "implementation-operation" as const, operationId } } : {}),
  };
}

/** Pretend exactly the listed operation ids are running. */
function running(...ids: string[]): void {
  setOperationLiveByIdLookupV1((_task, id) => ids.includes(id));
}

async function posted(card = routingCard()): Promise<WorkflowDecisionStoreV1> {
  const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
  await store.post(card);
  return store;
}

void describe("a keep-running card is bound to its Implementation operation (bugs3 Step 19)", () => {
  afterEach(() => setOperationLiveByIdLookupV1(undefined));

  void it("is unchanged and keep-running stays a harmless no-op while the same operation runs", async () => {
    const store = await posted();
    running("op-1");
    const card = store.get("routing-1")!;
    assert.equal(card.options.length, 2);
    assert.ok(card.options.every((o) => o.disabled !== true));
    assert.equal(card.recommendation.kind === "option" && card.recommendation.optionId, "letItRun");
    const answered = await store.resolve("routing-1", "letItRun");
    assert.equal(answered.kind, "resolved");
  });

  void it("is unchanged when liveness cannot be read (no registry), rather than guessing", async () => {
    const store = await posted();
    const card = store.get("routing-1")!;
    assert.equal(card.options.length, 2);
    assert.equal((await store.resolve("routing-1", "letItRun")).kind, "resolved");
  });

  void it("once the run has ended: keep-running is disabled, Run Implementation is offered and recommended", async () => {
    const store = await posted();
    running(); // the referenced round failed on quota; nothing runs
    const card = store.get("routing-1")!;
    const keep = card.options.find((o) => o.optionId === "letItRun")!;
    assert.equal(keep.disabled, true);
    assert.match(keep.disabledReason ?? "", /already ended/);
    assert.doesNotMatch(keep.consequence, /keeps running/);
    const fresh = card.options.find((o) => o.optionId === "runImplementation")!;
    assert.ok(fresh);
    assert.equal(fresh.effect.kind, "command");
    assert.equal(fresh.effect.kind === "command" && fresh.effect.command, "vs-code-ai-helper.runImplementationWithAI");
    assert.equal(card.recommendation.kind === "option" && card.recommendation.optionId, "runImplementation");
    // Quota history is not treated as a current limit and does not force a model change.
    assert.match(fresh.consequence, /history, not proof/);
    assert.match(fresh.consequence, /currently enabled/);
    // Not persisted: the stored record is untouched, so the view lifts by itself while a run lives.
    running("op-1");
    assert.equal(store.get("routing-1")!.options.length, 2);
  });

  void it("refuses a stale keep-running click after the run ended and leaves the card pending, dispatching nothing", async () => {
    const store = await posted();
    running();
    const refused = await store.resolve("routing-1", "letItRun");
    assert.equal(refused.kind, "rejected");
    assert.match(refused.kind === "rejected" ? refused.reason : "", /already ended/);
    assert.doesNotMatch(refused.kind === "rejected" ? refused.reason : "", /keeps running/);
    assert.equal(store.get("routing-1")!.state, "pending");
  });

  void it("a run that ends between render and click is refused at answer time", async () => {
    const store = await posted();
    running("op-1");
    assert.equal(store.get("routing-1")!.options.some((o) => o.disabled), false); // rendered as live
    running(); // ends before the click lands
    assert.equal((await store.resolve("routing-1", "letItRun")).kind, "rejected");
  });

  void it("an old card never rebinds to a newer operation", async () => {
    const store = await posted();
    running("op-2"); // a later round is live; the referenced op-1 is not
    const card = store.get("routing-1")!;
    assert.equal(card.options.find((o) => o.optionId === "letItRun")!.disabled, true);
    assert.equal((await store.resolve("routing-1", "letItRun")).kind, "rejected");
  });

  void it("Run Implementation is an explicit command answer that resolves the card once", async () => {
    const store = await posted();
    running();
    const answered = await store.resolve("routing-1", "runImplementation");
    assert.equal(answered.kind, "resolved");
    if (answered.kind === "resolved") {
      assert.equal(answered.option.effect.kind, "command");
    }
    assert.equal(store.get("routing-1")!.state, "resolved");
  });

  void it("Run Implementation does not exist while the referenced run is live", async () => {
    const store = await posted();
    running("op-1");
    assert.equal((await store.resolve("routing-1", "runImplementation")).kind, "rejected");
    assert.equal(store.get("routing-1")!.state, "pending");
  });

  void it("a card with no live reference is never altered", async () => {
    const store = await posted(routingCard(null));
    running();
    assert.equal(store.get("routing-1")!.options.length, 2);
    assert.equal((await store.resolve("routing-1", "letItRun")).kind, "resolved");
  });

  void it("after a reload (a fresh store over the same saved state) the card still follows the referenced operation", async () => {
    const memento = new FakeMemento() as unknown as import("vscode").Memento;
    const before = new WorkflowDecisionStoreV1(memento);
    await before.post(routingCard());
    // The window reloaded: nothing is running any more, and the saved card is read by a new store.
    running();
    const after = new WorkflowDecisionStoreV1(memento);
    const card = after.get("routing-1")!;
    assert.equal(card.options.find((o) => o.optionId === "letItRun")!.disabled, true);
    assert.equal(card.options.some((o) => o.optionId === "runImplementation"), true);
    const refused = await after.resolve("routing-1", "letItRun");
    assert.equal(refused.kind, "rejected");
    assert.doesNotMatch(refused.kind === "rejected" ? refused.reason : "", /keeps running/);
    assert.equal(after.get("routing-1")!.state, "pending", "nothing was dispatched and the card stays answerable by Run Implementation");
  });

  void it("quota failure, owner resets usage, then clicks the still-visible keep-running card: refused, and a fresh run is the offered next step", async () => {
    const store = await posted();
    // 18:44 the referenced round failed on a usage limit; 19:09 the owner (who already reset usage) clicks.
    running();
    const stale = await store.resolve("routing-1", "letItRun");
    assert.equal(stale.kind, "rejected", "the click never claims a run");
    const card = store.get("routing-1")!;
    const fresh = card.options.find((o) => o.optionId === "runImplementation")!;
    // No wait for the obsolete reset time and no forced model change.
    assert.doesNotMatch(fresh.consequence, /wait for|switch the model|change the model/i);
    assert.match(fresh.consequence, /currently enabled/);
    // Only the explicit action starts anything, and it resolves exactly once.
    assert.equal((await store.resolve("routing-1", "runImplementation")).kind, "resolved");
    assert.equal((await store.resolve("routing-1", "runImplementation")).kind, "alreadySettled", "a second click starts nothing");
  });
});
