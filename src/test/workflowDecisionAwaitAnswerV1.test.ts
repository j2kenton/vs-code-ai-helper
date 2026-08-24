/**
 * Coverage for `awaitWorkflowDecisionAnswerV1` (task "Actionable Hand-offs",
 * Part 11 notification audit): the helper that lets a caller which
 * genuinely `await`s an answer and branches on it (unlike the two advisory,
 * fire-and-forget `postWorkflowDecisionV1` dialogs already migrated in
 * `reviewActions.ts`) swap a raw `vscode.window.showWarningMessage` for a
 * `WorkflowDecisionV1` record without redesigning its own control flow: the
 * awaiting call stays alive in-process exactly as it did around a modal
 * `await`, resolving once the posted decision leaves `"pending"`.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  awaitWorkflowDecisionAnswerV1,
  dismissOrphanedAwaitedDecisionsV1,
  retryOrphanDismissV1,
  PostWorkflowDecisionInputV1,
} from "../utils/workflowDecisionDispatchV1";
import {
  WorkflowDecisionStoreV1,
  clearWorkflowDecisionOrphanedV1,
  isWorkflowDecisionOrphanedV1,
  markWorkflowDecisionOrphanedV1,
} from "../state/workflowDecisionStoreV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { ChatTarget } from "../views/chatView";

/** Minimal in-memory stand-in for `vscode.Memento`. */
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

/**
 * Same as `FakeMemento`, but `update` can be told to reject its NEXT call
 * (and only that one) — simulates a transient `Memento.update` failure
 * without touching the stored value, mirroring real VS Code storage
 * semantics on a failed write.
 */
class FlakyMemento {
  private readonly values = new Map<string, unknown>();
  failNextUpdate = false;
  get<T>(key: string, defaultValue: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }
  update(key: string, value: unknown): Promise<void> {
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      return Promise.reject(new Error("simulated Memento.update failure"));
    }
    this.values.set(key, value);
    return Promise.resolve();
  }
}

function fakeExtensionContext(): vscode.ExtensionContext {
  return { workspaceState: new FakeMemento() as unknown as vscode.Memento } as unknown as vscode.ExtensionContext;
}

const target: ChatTarget = { canonicalId: "/task-a", taskFolderPath: "/task-a", stage: "impl" };

const wellFormedGating = {
  holdsTaskPaused: true,
  unblocksProgress: true,
  detail: "The run is paused on this exact choice.",
};

function makeInput(decisionKey: string, decisionId: string): PostWorkflowDecisionInputV1 {
  return {
    decisionId,
    decisionKey,
    taskCanonicalId: "/task-a",
    stage: "impl" as const,
    whatHappened: "Something needs your input.",
    whyUserNeeded: "The run cannot continue without a choice.",
    options: [
      { optionId: "continue", label: "Continue", consequence: "Keeps going.", effect: { kind: "doNothing" as const } },
      { optionId: "cancel", label: "Cancel", consequence: "Stops here.", effect: { kind: "doNothing" as const } },
    ],
    recommendation: { kind: "none" as const, reasoning: "Only you know which is right." },
    gating: wellFormedGating,
  };
}

void describe("awaitWorkflowDecisionAnswerV1", () => {
  void it("resolves with the chosen option once the decision is resolved via the store", async () => {
    const context = fakeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      const decisionId = "decision-await-1";
      const resultPromise = awaitWorkflowDecisionAnswerV1(makeInput("testAwaitDecision", decisionId), target);

      // Let the internal `post` + subscribe complete before resolving from
      // the outside, mirroring the chat panel resolving a pending decision.
      await new Promise((resolve) => setImmediate(resolve));

      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const resolveResult = await store.resolve(decisionId, "continue");
      assert.equal(resolveResult.kind, "resolved");

      const chosen = await resultPromise;
      assert.equal(chosen, "continue");
    } finally {
      __extensionContextV1TestOnly.reset();
    }
  });

  void it("resolves with undefined when the decision is dismissed rather than resolved", async () => {
    const context = fakeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      const decisionId = "decision-await-2";
      const resultPromise = awaitWorkflowDecisionAnswerV1(makeInput("testAwaitDecision", decisionId), target);

      await new Promise((resolve) => setImmediate(resolve));

      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const dismissResult = await store.dismiss(decisionId);
      assert.equal(dismissResult.kind, "dismissed");

      const chosen = await resultPromise;
      assert.equal(chosen, undefined);
    } finally {
      __extensionContextV1TestOnly.reset();
    }
  });

  void it("resolves with undefined immediately when no extension context is available to post through", async () => {
    __extensionContextV1TestOnly.reset();
    const chosen = await awaitWorkflowDecisionAnswerV1(makeInput("testAwaitDecision", "decision-await-3"), target);
    assert.equal(chosen, undefined);
  });

  void it("stops waiting when the supplied cancellation token fires", async () => {
    const context = fakeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      const tokenSource = new vscode.CancellationTokenSource();
      const decisionId = "decision-await-5";
      const resultPromise = awaitWorkflowDecisionAnswerV1(
        makeInput("testAwaitDecision", decisionId),
        target,
        tokenSource.token
      );

      await new Promise((resolve) => setImmediate(resolve));
      tokenSource.cancel();

      const chosen = await resultPromise;
      assert.equal(chosen, undefined);
    } finally {
      __extensionContextV1TestOnly.reset();
    }
  });

  void it("dismisses the persisted decision when cancellation fires, so it stops presenting as an answerable gate", async () => {
    // Review blocker: cancellation used to resolve only the local promise,
    // leaving the record `"pending"` forever — answerable, but reaching no
    // waiting caller. This asserts the STORE record itself settles too.
    const context = fakeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      const tokenSource = new vscode.CancellationTokenSource();
      const decisionId = "decision-await-6";
      const resultPromise = awaitWorkflowDecisionAnswerV1(
        makeInput("testAwaitDecision", decisionId),
        target,
        tokenSource.token
      );

      await new Promise((resolve) => setImmediate(resolve));
      tokenSource.cancel();
      await resultPromise;

      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const persisted = store.get(decisionId);
      assert.ok(persisted, "the decision record must still exist");
      assert.notEqual(persisted?.state, "pending", "cancellation must settle the persisted record, not just the local promise");
      assert.equal(persisted?.state, "dismissed");
    } finally {
      __extensionContextV1TestOnly.reset();
    }
  });

  void it("does not resolve the waiter until the persisted dismissal write has settled (ordering, not just eventual consistency)", async () => {
    // Review fix (round 2): the earlier shape resolved `finish(undefined)`
    // synchronously inside the cancellation callback while `store.dismiss`
    // was still an in-flight, un-awaited write — so `await resultPromise`
    // could return before the record left `"pending"`. This proves the
    // ordering directly: no extra `setImmediate` turn is needed between
    // `await resultPromise` and observing the dismissed record, because the
    // waiter now resolves strictly AFTER the dismissal write completes.
    const context = fakeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      const tokenSource = new vscode.CancellationTokenSource();
      const decisionId = "decision-await-7";
      const resultPromise = awaitWorkflowDecisionAnswerV1(
        makeInput("testAwaitDecision", decisionId),
        target,
        tokenSource.token
      );

      await new Promise((resolve) => setImmediate(resolve));
      tokenSource.cancel();
      await resultPromise;

      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const persisted = store.get(decisionId);
      assert.equal(
        persisted?.state,
        "dismissed",
        "the record must already be dismissed by the time the waiter resolves, with no further wait"
      );
    } finally {
      __extensionContextV1TestOnly.reset();
    }
  });
});

void describe("dismissOrphanedAwaitedDecisionsV1", () => {
  void it("dismisses pending decisions left behind by an await-answer decision key (simulated extension-host restart)", async () => {
    const context = fakeExtensionContext();
    const store = new WorkflowDecisionStoreV1(context.workspaceState);
    // Simulate a decision posted by a previous process — no in-process
    // waiter exists for it in THIS test, exactly like after a restart.
    const posted = await store.post({
      decisionId: "orphan-1",
      decisionKey: "implementationRoundLimitReached",
      taskCanonicalId: "/task-a",
      stage: "impl",
      whatHappened: "The implementation reached its round limit.",
      whyUserNeeded: "Needed a choice to continue.",
      options: [
        { optionId: "continue", label: "Continue", consequence: "Keeps going.", effect: { kind: "doNothing" } },
      ],
      recommendation: { kind: "none", reasoning: "Only you know." },
      gating: wellFormedGating,
      createdAt: new Date().toISOString(),
    });
    assert.equal(posted.ok, true);

    const dismissedCount = await dismissOrphanedAwaitedDecisionsV1(context.workspaceState);
    assert.equal(dismissedCount, 1);

    const persisted = store.get("orphan-1");
    assert.equal(persisted?.state, "dismissed");
  });

  void it("leaves decisions with other keys untouched", async () => {
    const context = fakeExtensionContext();
    const store = new WorkflowDecisionStoreV1(context.workspaceState);
    const posted = await store.post({
      decisionId: "not-orphan-1",
      decisionKey: "reconcilePlanChecklist",
      taskCanonicalId: "/task-a",
      stage: "impl",
      whatHappened: "Checklist counts may be unreliable.",
      whyUserNeeded: "Needs a human call.",
      options: [
        { optionId: "reconcile", label: "Mark reconciled", consequence: "Clears the flag.", effect: { kind: "doNothing" } },
      ],
      recommendation: { kind: "none", reasoning: "No basis to recommend." },
      gating: wellFormedGating,
      createdAt: new Date().toISOString(),
    });
    assert.equal(posted.ok, true);

    const dismissedCount = await dismissOrphanedAwaitedDecisionsV1(context.workspaceState);
    assert.equal(dismissedCount, 0);

    const persisted = store.get("not-orphan-1");
    assert.equal(persisted?.state, "pending");
  });
});

void describe("orphaned-decision tombstone (rejected dismissal write)", () => {
  void it(
    "renders a decision non-answerable immediately when the cancellation-time dismissal write rejects, " +
      "even though the persisted record is still pending",
    async () => {
      // Review blocker, round 3: a rejected `Memento.update` on cancellation
      // used to only log and proceed, leaving the record `"pending"` and
      // presenting as answerable for the rest of THIS session, not just
      // until a future restart.
      const memento = new FlakyMemento();
      const context = { workspaceState: memento as unknown as vscode.Memento } as unknown as vscode.ExtensionContext;
      __extensionContextV1TestOnly.set(context);
      try {
        const tokenSource = new vscode.CancellationTokenSource();
        const decisionId = "decision-orphan-1";
        const resultPromise = awaitWorkflowDecisionAnswerV1(
          makeInput("testAwaitDecision", decisionId),
          target,
          tokenSource.token
        );

        // Let the initial `post` (a separate, already-succeeding write)
        // complete before arming the failure for the cancellation-time
        // `dismiss` write specifically.
        await new Promise((resolve) => setImmediate(resolve));
        memento.failNextUpdate = true;
        tokenSource.cancel();
        const chosen = await resultPromise;
        assert.equal(chosen, undefined);

        const store = new WorkflowDecisionStoreV1(context.workspaceState);
        // The persisted write failed, so the record itself is still
        // "pending" on disk...
        assert.equal(store.get(decisionId)?.state, "pending");
        // ...but the in-process tombstone must already make it non-
        // answerable: excluded from what's pending, and refusing to resolve.
        assert.equal(store.listPending().some((d) => d.decisionId === decisionId), false);
        const resolveResult = await store.resolve(decisionId, "continue");
        assert.equal(resolveResult.kind, "orphaned");
      } finally {
        clearWorkflowDecisionOrphanedV1("decision-orphan-1");
        __extensionContextV1TestOnly.reset();
      }
    }
  );

  void it("keeps sweeping the rest of the activation-time orphan list when one decision's dismissal write fails", async () => {
    // Review blocker, round 3: the original loop's un-caught `await
    // store.dismiss(...)` meant one failing write aborted the sweep for
    // every orphan after it in the list.
    const memento = new FlakyMemento();
    const state = memento as unknown as vscode.Memento;
    const store = new WorkflowDecisionStoreV1(state);
    await store.post({
      decisionId: "orphan-fail-1",
      decisionKey: "implementationRoundLimitReached",
      taskCanonicalId: "/task-a",
      stage: "impl",
      whatHappened: "The implementation reached its round limit.",
      whyUserNeeded: "Needed a choice to continue.",
      options: [{ optionId: "continue", label: "Continue", consequence: "Keeps going.", effect: { kind: "doNothing" } }],
      recommendation: { kind: "none", reasoning: "Only you know." },
      gating: wellFormedGating,
      createdAt: new Date().toISOString(),
    });
    await store.post({
      decisionId: "orphan-ok-1",
      decisionKey: "quotaExhaustedDuringRun",
      taskCanonicalId: "/task-a",
      stage: "impl",
      whatHappened: "The quota was exhausted mid-run.",
      whyUserNeeded: "Needed a choice to continue.",
      options: [{ optionId: "continue", label: "Continue", consequence: "Keeps going.", effect: { kind: "doNothing" } }],
      recommendation: { kind: "none", reasoning: "Only you know." },
      gating: wellFormedGating,
      createdAt: new Date().toISOString(),
    });

    // Fail only the first write the sweep performs (dismissing
    // "orphan-fail-1", which was posted — and so is listed — first).
    memento.failNextUpdate = true;

    try {
      const dismissedCount = await dismissOrphanedAwaitedDecisionsV1(state);
      assert.equal(dismissedCount, 2, "both matched entries are counted, even though one write failed");

      assert.equal(store.get("orphan-ok-1")?.state, "dismissed");
      assert.equal(store.get("orphan-fail-1")?.state, "pending", "the failed write must not silently mark it dismissed");
      assert.equal(isWorkflowDecisionOrphanedV1("orphan-fail-1"), true, "the failed one must be tombstoned instead");
      assert.equal(store.listPending().some((d) => d.decisionId === "orphan-fail-1"), false);
    } finally {
      clearWorkflowDecisionOrphanedV1("orphan-fail-1");
    }
  });

  void it("retries a failed dismissal write in the background and clears the tombstone once it succeeds", async () => {
    const memento = new FlakyMemento();
    const state = memento as unknown as vscode.Memento;
    const store = new WorkflowDecisionStoreV1(state);
    const decisionId = "decision-orphan-retry-1";
    const posted = await store.post({
      decisionId,
      decisionKey: "implementationRoundLimitReached",
      taskCanonicalId: "/task-a",
      stage: "impl",
      whatHappened: "The implementation reached its round limit.",
      whyUserNeeded: "Needed a choice to continue.",
      options: [{ optionId: "continue", label: "Continue", consequence: "Keeps going.", effect: { kind: "doNothing" } }],
      recommendation: { kind: "none", reasoning: "Only you know." },
      gating: wellFormedGating,
      createdAt: new Date().toISOString(),
    });
    assert.equal(posted.ok, true);

    markWorkflowDecisionOrphanedV1(decisionId);
    memento.failNextUpdate = true; // the retry's first attempt fails too; the second succeeds
    try {
      await retryOrphanDismissV1(store, decisionId, [1, 1]);
      assert.equal(isWorkflowDecisionOrphanedV1(decisionId), false, "the tombstone must clear once the write succeeds");
      assert.equal(store.get(decisionId)?.state, "dismissed");
    } finally {
      clearWorkflowDecisionOrphanedV1(decisionId);
    }
  });

  void it("gives up after exhausting the retry schedule, leaving the tombstone in place", async () => {
    const memento = new FlakyMemento();
    const state = memento as unknown as vscode.Memento;
    const store = new WorkflowDecisionStoreV1(state);
    const decisionId = "decision-orphan-retry-exhausted";
    await store.post({
      decisionId,
      decisionKey: "implementationRoundLimitReached",
      taskCanonicalId: "/task-a",
      stage: "impl",
      whatHappened: "The implementation reached its round limit.",
      whyUserNeeded: "Needed a choice to continue.",
      options: [{ optionId: "continue", label: "Continue", consequence: "Keeps going.", effect: { kind: "doNothing" } }],
      recommendation: { kind: "none", reasoning: "Only you know." },
      gating: wellFormedGating,
      createdAt: new Date().toISOString(),
    });

    markWorkflowDecisionOrphanedV1(decisionId);
    // Fail every attempt by re-arming `failNextUpdate` before each retry
    // would otherwise succeed — simulates storage that never recovers
    // within this schedule.
    const originalUpdate = memento.update.bind(memento);
    memento.update = (key: string, value: unknown): Promise<void> => {
      memento.failNextUpdate = true;
      return originalUpdate(key, value);
    };
    try {
      await retryOrphanDismissV1(store, decisionId, [1, 1, 1]);
      assert.equal(isWorkflowDecisionOrphanedV1(decisionId), true, "the tombstone must stay once every retry fails");
      assert.equal(store.get(decisionId)?.state, "pending");
      assert.equal(store.listPending().some((d) => d.decisionId === decisionId), false);
    } finally {
      clearWorkflowDecisionOrphanedV1(decisionId);
    }
  });
});
