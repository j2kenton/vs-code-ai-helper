/**
 * Coverage for `WorkflowDecisionStoreV1` (task: "Replace hidden notification
 * decision buttons with explained, selectable decisions"):
 *  - `post` persists a valid decision and rejects an invalid one;
 *  - `listPending` returns only pending decisions, optionally filtered to a
 *    task;
 *  - `resolve` settles a pending decision exactly once and reports a second
 *    resolve attempt as `alreadySettled` rather than an error (the
 *    acknowledgement contract: an already-answered decision is not a
 *    failure);
 *  - `resolve`/`dismiss` against an unknown id report `missing`;
 *  - `dismiss` settles a pending decision without an option;
 *  - reposting a decision under the same `decisionKey` + task updates the
 *    prior pending one in place (same decisionId) rather than leaving two
 *    pending or appending a new record;
 *  - `removeForTask` drops every record for one task.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_WORKFLOW_DECISIONS_V1, WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { CreateWorkflowDecisionInputV1, WorkflowDecisionOptionV1, WorkflowDecisionV1 } from "../types/workflowDecisionV1";

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

function option(overrides: Partial<WorkflowDecisionOptionV1> = {}): WorkflowDecisionOptionV1 {
  return {
    optionId: "doIt",
    label: "Do it",
    consequence: "Applies the change immediately.",
    resumeKind: "unpause",
    effect: { kind: "command", command: "ensemble.doIt" },
    ...overrides,
  };
}

let counter = 0;
function decisionInput(overrides: Partial<CreateWorkflowDecisionInputV1> = {}): CreateWorkflowDecisionInputV1 {
  counter += 1;
  return {
    decisionId: `decision-${counter}`,
    decisionKey: "exampleDecision",
    taskCanonicalId: "/tmp/tasks/task-1",
    stage: "impl",
    whatHappened: "The scheduled round finished and the summary was rejected.",
    whyUserNeeded: "The system cannot tell whether to retry or restore the prior round.",
    options: [option(), option({ optionId: "wait", label: "Wait", consequence: "Leaves the round as-is.", effect: { kind: "doNothing" } })],
    recommendation: { kind: "option", optionId: "wait", reasoning: "Nothing is lost by waiting." },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

void describe("WorkflowDecisionStoreV1", () => {
  void it("posts a valid decision and lists it as pending", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    const posted = await store.post(decisionInput());
    assert.equal(posted.ok, true);
    const pending = store.listPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.state, "pending");
  });

  void it("rejects posting an invalid decision and does not persist it", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    const posted = await store.post(decisionInput({ whatHappened: "" }));
    assert.equal(posted.ok, false);
    assert.equal(store.listPending().length, 0);
  });

  void it("filters listPending by taskCanonicalId", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    await store.post(decisionInput({ taskCanonicalId: "/tmp/tasks/task-1", decisionKey: "a" }));
    await store.post(decisionInput({ taskCanonicalId: "/tmp/tasks/task-2", decisionKey: "b" }));
    const forTask1 = store.listPending("/tmp/tasks/task-1");
    assert.equal(forTask1.length, 1);
    assert.equal(forTask1[0]!.taskCanonicalId, "/tmp/tasks/task-1");
  });

  void it("resolve settles a pending decision and returns the chosen option", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    const posted = await store.post(decisionInput());
    assert.equal(posted.ok, true);
    if (!posted.ok) {return;}
    const result = await store.resolve(posted.decision.decisionId, "wait");
    assert.equal(result.kind, "resolved");
    if (result.kind === "resolved") {
      assert.equal(result.option.optionId, "wait");
      assert.equal(result.decision.state, "resolved");
      assert.equal(result.decision.resolvedOptionId, "wait");
      // 1.0.0 gate, Part 5 (B3, hand-off check "answering a decision works
      // end to end"): the settled record must carry a timestamp proving it
      // was actually answered, not merely flipped to a resolved state.
      assert.ok(result.decision.resolvedAt, "expected resolvedAt to be set on resolution");
      assert.equal(store.get(posted.decision.decisionId)?.resolvedAt, result.decision.resolvedAt);
    }
    assert.equal(store.listPending().length, 0);
  });

  void it("a second resolve of an already-resolved decision reports alreadySettled, not an error", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    const posted = await store.post(decisionInput());
    assert.equal(posted.ok, true);
    if (!posted.ok) {return;}
    const first = await store.resolve(posted.decision.decisionId, "wait");
    assert.equal(first.kind, "resolved");
    const second = await store.resolve(posted.decision.decisionId, "doIt");
    assert.equal(second.kind, "alreadySettled");
    if (second.kind === "alreadySettled") {
      // The original resolution wins; the second attempt's option is ignored.
      assert.equal(second.decision.resolvedOptionId, "wait");
    }
  });

  void it("resolve against an unknown decision id reports missing", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    const result = await store.resolve("does-not-exist", "wait");
    assert.equal(result.kind, "missing");
  });

  void it("resolve with an unknown optionId is rejected", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    const posted = await store.post(decisionInput());
    assert.equal(posted.ok, true);
    if (!posted.ok) {return;}
    const result = await store.resolve(posted.decision.decisionId, "not-an-option");
    assert.equal(result.kind, "rejected");
  });

  void it("dismiss settles a pending decision without an option", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    const posted = await store.post(decisionInput());
    assert.equal(posted.ok, true);
    if (!posted.ok) {return;}
    const result = await store.dismiss(posted.decision.decisionId);
    assert.equal(result.kind, "dismissed");
    assert.equal(store.listPending().length, 0);
  });

  void it("dismiss against an unknown decision id reports missing", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    const result = await store.dismiss("does-not-exist");
    assert.equal(result.kind, "missing");
  });

  void it("reposting the same decisionKey for the same task updates the earlier pending decision in place", async () => {
    // 1.0.0 gate, A4/B2 (review finding, 2026-09-06): a repost of the same
    // standing condition must cost the store nothing extra — no new record,
    // no `superseded` history entry — so a recurring condition never grows
    // the array at all, however many times it reposts.
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    const first = await store.post(decisionInput({ decisionKey: "reconcilePlanChecklist", whatHappened: "first" }));
    assert.equal(first.ok, true);
    const second = await store.post(decisionInput({ decisionKey: "reconcilePlanChecklist", whatHappened: "second" }));
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) {return;}
    const pending = store.listPending();
    assert.equal(pending.length, 1);
    // Same decisionId, refreshed content: a repost is an UPDATE, not a
    // supersede-and-append.
    assert.equal(pending[0]!.decisionId, first.decision.decisionId);
    assert.equal(pending[0]!.whatHappened, "second");
    assert.equal(store.get(first.decision.decisionId)?.state, "pending");
  });

  void it("reposting a decision under the same decisionKey does not grow the store, however many times it repeats", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    for (let i = 0; i < 50; i += 1) {
      const posted = await store.post(decisionInput({ decisionKey: "reconcilePlanChecklist", whatHappened: `round ${i}` }));
      assert.equal(posted.ok, true);
    }
    assert.equal(store.listPending().length, 1);
    assert.equal(store.listPending()[0]!.whatHappened, "round 49");
  });

  void it("reposting consolidates a pre-existing backlog of duplicate pending records into one, withdrawing the rest", async () => {
    // 1.0.0 gate, Part 5 (B3 diagnosis): a store written before update-in-place
    // landed could hold several simultaneous pending records for the same
    // decisionKey+task (the real observed case: 245 for one condition, none
    // of them ever answered because there was no single tractable decision to
    // act on). Simulate that legacy backlog directly via the Memento, then
    // confirm the next repost collapses it to exactly one pending record.
    const memento = new FakeMemento() as unknown as import("vscode").Memento;
    const store = new WorkflowDecisionStoreV1(memento);
    const legacyDuplicates: WorkflowDecisionV1[] = ["round 1", "round 2", "round 3"].map((whatHappened) => {
      const input = decisionInput({ decisionKey: "reconcilePlanChecklist", whatHappened });
      return { ...input, state: "pending" };
    });
    // Write the legacy backlog directly, bypassing post()'s own consolidation,
    // to reproduce a store a pre-fix build actually wrote.
    await memento.update("workflowDecisions", legacyDuplicates);
    assert.equal(store.listPending().length, 3, "sanity check: the simulated legacy backlog is in place");

    const reposted = await store.post(
      decisionInput({ decisionKey: "reconcilePlanChecklist", whatHappened: "fresh repost" })
    );
    assert.equal(reposted.ok, true);

    const pending = store.listPending();
    assert.equal(pending.length, 1, "the legacy backlog must collapse to a single pending decision");
    assert.equal(pending[0]!.whatHappened, "fresh repost");
    assert.equal(pending[0]!.decisionId, legacyDuplicates[0]!.decisionId, "the oldest record's id is kept stable");

    const all = memento.get<WorkflowDecisionV1[]>("workflowDecisions", []);
    const withdrawn = all.filter((d) => d.state === "withdrawn");
    assert.equal(withdrawn.length, 2, "every other duplicate must be withdrawn, not left dangling as pending");
    for (const decision of withdrawn) {
      assert.match(decision.withdrawnReason ?? "", /consolidated into one pending decision/);
    }
  });

  void it("reposting a different decisionKey for the same task does not supersede", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    await store.post(decisionInput({ decisionKey: "keyA" }));
    await store.post(decisionInput({ decisionKey: "keyB" }));
    assert.equal(store.listPending().length, 2);
  });

  // 1.0.0 gate, A4 (review finding, 2026-09-06): the store's "cap of 200" was
  // assumed by design but never enforced anywhere — a real workspace grew to
  // 331 records (2.46 MB, 88% of the extension's workspace-state memory) and
  // was named as the dominant contributor to a repeated OOM window
  // termination. These lock in the enforcement added in response.
  void describe("MAX_WORKFLOW_DECISIONS_V1 cap enforcement (1.0.0 gate A4)", () => {
    void it("trims oldest SETTLED records once the total exceeds the cap, keeping every pending one", async () => {
      const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
      // Post and immediately dismiss MAX_WORKFLOW_DECISIONS_V1 + 50 distinct
      // (unique decisionKey per task) decisions, so none supersede each
      // other and every one becomes a settled (dismissed) history record.
      const overflow = 50;
      const dismissedIds: string[] = [];
      for (let i = 0; i < MAX_WORKFLOW_DECISIONS_V1 + overflow; i += 1) {
        const posted = await store.post(
          decisionInput({ decisionKey: `history-${i}`, taskCanonicalId: `/tmp/tasks/task-${i}` })
        );
        assert.equal(posted.ok, true);
        if (!posted.ok) {return;}
        await store.dismiss(posted.decision.decisionId);
        dismissedIds.push(posted.decision.decisionId);
      }
      // One more decision, left pending — must survive the cap regardless.
      const pendingPosted = await store.post(
        decisionInput({ decisionKey: "still-pending", taskCanonicalId: "/tmp/tasks/task-pending" })
      );
      assert.equal(pendingPosted.ok, true);
      if (!pendingPosted.ok) {return;}

      const memento = (store as unknown as { state: { get<T>(key: string, def: T): T } }).state;
      const persisted = memento.get<Array<{ decisionId: string }>>("workflowDecisions", []);
      assert.ok(
        persisted.length <= MAX_WORKFLOW_DECISIONS_V1,
        `persisted array (${persisted.length}) must never exceed the cap (${MAX_WORKFLOW_DECISIONS_V1})`
      );
      assert.ok(
        persisted.some((d) => d.decisionId === pendingPosted.decision.decisionId),
        "the still-pending decision must never be dropped to make room"
      );
      // The OLDEST dismissed records are the ones dropped, not the newest.
      const oldestDismissedId = dismissedIds[0]!;
      const newestDismissedId = dismissedIds[dismissedIds.length - 1]!;
      assert.ok(
        !persisted.some((d) => d.decisionId === oldestDismissedId),
        "the oldest settled record must be the one trimmed"
      );
      assert.ok(
        persisted.some((d) => d.decisionId === newestDismissedId),
        "the newest settled record must survive the trim"
      );
    });

    void it("never trims below the cap when every record is still pending", async () => {
      const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
      const extra = 20;
      for (let i = 0; i < MAX_WORKFLOW_DECISIONS_V1 + extra; i += 1) {
        const posted = await store.post(
          decisionInput({ decisionKey: `pending-${i}`, taskCanonicalId: `/tmp/tasks/task-${i}` })
        );
        assert.equal(posted.ok, true);
      }
      assert.equal(
        store.listPending().length,
        MAX_WORKFLOW_DECISIONS_V1 + extra,
        "a backlog of genuinely unanswered decisions is a human problem, not something safe to solve by deleting one"
      );
    });
  });

  void it("removeForTask drops every record for one task", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
    await store.post(decisionInput({ taskCanonicalId: "/tmp/tasks/task-1" }));
    await store.post(decisionInput({ taskCanonicalId: "/tmp/tasks/task-1", decisionKey: "other" }));
    await store.post(decisionInput({ taskCanonicalId: "/tmp/tasks/task-2" }));
    const removed = await store.removeForTask("/tmp/tasks/task-1");
    assert.equal(removed, 2);
    assert.equal(store.listPending("/tmp/tasks/task-1").length, 0);
    assert.equal(store.listPending("/tmp/tasks/task-2").length, 1);
  });
});

void describe("WorkflowDecisionStoreV1 — answered decisions are not re-posted (v1 fixes 2, item 7)", () => {
  const suppress = { conditionFingerprint: "latched:unrecorded", answeredOptionIds: ["wait"] };
  const newStore = (): WorkflowDecisionStoreV1 =>
    new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
  const idOf = (posted: { ok: boolean; decision?: WorkflowDecisionV1 }): string => posted.decision?.decisionId ?? "";

  void it("does not create a new record while the answered condition and answers are unchanged", async () => {
    const store = newStore();
    const first = await store.post(decisionInput({ suppressWhileAnswered: suppress }));
    assert.ok(first.ok && !first.suppressed);
    await store.resolve(idOf(first), "wait");

    const again = await store.post(decisionInput({ suppressWhileAnswered: suppress }));
    assert.ok(again.ok);
    assert.equal(again.suppressed, true);
    assert.equal(idOf(again), idOf(first));
    assert.equal(store.listPending().length, 0);
  });

  void it("re-asks when the offered answers change", async () => {
    const store = newStore();
    const first = await store.post(decisionInput({ suppressWhileAnswered: suppress }));
    await store.resolve(idOf(first), "wait");

    const extra = option({ optionId: "newAnswer", label: "New", consequence: "A newly available answer." });
    const again = await store.post(
      decisionInput({
        suppressWhileAnswered: suppress,
        options: [extra, option({ optionId: "wait", label: "Wait", consequence: "x", effect: { kind: "doNothing" } })],
      })
    );
    assert.ok(again.ok && !again.suppressed);
    assert.equal(store.listPending().length, 1);
  });

  void it("re-asks when the condition fingerprint changes", async () => {
    const store = newStore();
    const first = await store.post(decisionInput({ suppressWhileAnswered: suppress }));
    await store.resolve(idOf(first), "wait");
    const again = await store.post(
      decisionInput({ suppressWhileAnswered: { ...suppress, conditionFingerprint: "latched:new reason" } })
    );
    assert.ok(again.ok && !again.suppressed);
  });

  void it("re-asks after an answer that is not in answeredOptionIds (it cleared the condition)", async () => {
    const store = newStore();
    const first = await store.post(decisionInput({ suppressWhileAnswered: suppress }));
    await store.resolve(idOf(first), "doIt");
    const again = await store.post(decisionInput({ suppressWhileAnswered: suppress }));
    assert.ok(again.ok && !again.suppressed);
  });

  void it("never suppresses a poster that did not opt in", async () => {
    const store = newStore();
    const first = await store.post(decisionInput());
    await store.resolve(idOf(first), "wait");
    const again = await store.post(decisionInput());
    assert.ok(again.ok && !again.suppressed);
    assert.equal(store.listPending().length, 1);
  });
});

/**
 * Pre-1.0.0 fixes register, items 14/22 (Part 3, Step 2): `resumeKind` is
 * REQUIRED on `WorkflowDecisionOptionV1`, but a record written by an older
 * build predates the field entirely. `all()` (private, exercised through
 * every public reader) must default a missing or unrecognised value to
 * `"unpause"` — the safe direction, since an old record then never dispatches
 * more than it did before this field existed. Writes directly to the
 * underlying `Memento`, bypassing `post()`'s own typed/validated path, since
 * that is exactly how a genuinely pre-existing on-disk record would be seen.
 */
void describe("WorkflowDecisionStoreV1 — resumeKind compatibility normalizer (pre-1.0.0 fixes register, items 14/22)", () => {
  void it("defaults a missing resumeKind to 'unpause' on read, without touching the value once it is set", async () => {
    const memento = new FakeMemento();
    const raw = {
      decisionId: "pre-existing-1",
      decisionKey: "legacyDecision",
      taskCanonicalId: "/tmp/tasks/task-1",
      stage: "impl",
      whatHappened: "An older build posted this before resumeKind existed.",
      whyUserNeeded: "Needs a human call.",
      options: [
        // No resumeKind at all — the pre-field shape.
        { optionId: "doIt", label: "Do it", consequence: "Applies it.", effect: { kind: "doNothing" } },
        // Already carries a valid value — must pass through unchanged.
        { optionId: "wait", label: "Wait", consequence: "Waits.", resumeKind: "continue", effect: { kind: "doNothing" } },
      ],
      recommendation: { kind: "none", reasoning: "No basis." },
      createdAt: new Date().toISOString(),
      state: "pending",
    };
    await memento.update("workflowDecisions", [raw]);
    const store = new WorkflowDecisionStoreV1(memento as unknown as import("vscode").Memento);

    const pending = store.listPending();
    assert.equal(pending.length, 1);
    const [decoded] = pending;
    assert.equal(decoded!.options[0]!.optionId, "doIt");
    assert.equal(decoded!.options[0]!.resumeKind, "unpause", "missing resumeKind must default to unpause");
    assert.equal(decoded!.options[1]!.resumeKind, "continue", "an already-set value must not be overwritten");

    const fetched = store.get("pre-existing-1");
    assert.equal(fetched?.options[0]?.resumeKind, "unpause");
  });

  void it("normalizes a record carrying an unrecognised resumeKind value to 'unpause', not to the unrecognised value", async () => {
    const memento = new FakeMemento();
    const raw = {
      decisionId: "pre-existing-2",
      decisionKey: "legacyDecision",
      taskCanonicalId: "/tmp/tasks/task-1",
      stage: "impl",
      whatHappened: "Corrupted or forward-incompatible resumeKind value.",
      whyUserNeeded: "Needs a human call.",
      options: [
        { optionId: "doIt", label: "Do it", consequence: "Applies it.", resumeKind: "not-a-real-kind", effect: { kind: "doNothing" } },
      ],
      recommendation: { kind: "none", reasoning: "No basis." },
      createdAt: new Date().toISOString(),
      state: "pending",
    };
    await memento.update("workflowDecisions", [raw]);
    const store = new WorkflowDecisionStoreV1(memento as unknown as import("vscode").Memento);

    assert.equal(store.get("pre-existing-2")?.options[0]?.resumeKind, "unpause");
  });
});
