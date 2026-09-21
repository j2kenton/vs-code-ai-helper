/**
 * Notification attribution (v1 fixes 2, item 6, release half): a notification
 * raised inside a tracked operation names that operation's task — per
 * operation, so overlapping operations never mix, and never after the
 * operation has settled.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attributeNotificationMessageV1, runWithNotificationTaskContextV1 } from "../utils/notificationTaskContextV1";
import { terminalEntryFor } from "../utils/operationNotificationBridge";
import type { TaskOperationSnapshot } from "../utils/taskOperations";

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

void describe("notification task context", () => {
  void it("leaves a notification outside any operation unattributed", () => {
    assert.equal(attributeNotificationMessageV1("Nothing to do."), "Nothing to do.");
  });

  void it("names the operation's task for a notification raised inside it", async () => {
    const seen = await runWithNotificationTaskContextV1("alpha", "/w/2026-09-20_task_1", async () => {
      await tick(1);
      return attributeNotificationMessageV1("Review is stale.");
    });
    assert.equal(seen, '"alpha" — Review is stale.');
  });

  void it("does not double a message that already names the task", async () => {
    const seen = await runWithNotificationTaskContextV1("alpha", "/w/x", () =>
      Promise.resolve(attributeNotificationMessageV1('Review — "alpha": completed'))
    );
    assert.equal(seen, 'Review — "alpha": completed');
  });

  void it("attributes two overlapping operations on different tasks to their own tasks", async () => {
    const [a, b] = await Promise.all([
      runWithNotificationTaskContextV1("alpha", "/w/a", async () => {
        await tick(10);
        const first = attributeNotificationMessageV1("one");
        await tick(10);
        return [first, attributeNotificationMessageV1("two")];
      }),
      runWithNotificationTaskContextV1("beta", "/w/b", async () => {
        await tick(5);
        const first = attributeNotificationMessageV1("one");
        await tick(20);
        return [first, attributeNotificationMessageV1("two")];
      }),
    ]);
    assert.deepEqual(a, ['"alpha" — one', '"alpha" — two']);
    assert.deepEqual(b, ['"beta" — one', '"beta" — two']);
  });

  void it("leaves a late emission, after the operation returned, unattributed", async () => {
    let late: string | undefined;
    const done = new Promise<void>((resolve) => {
      void runWithNotificationTaskContextV1("alpha", "/w/a", () => {
        setTimeout(() => {
          late = attributeNotificationMessageV1("Retrying.");
          resolve();
        }, 20);
        return Promise.resolve();
      });
    });
    await done;
    assert.equal(late, "Retrying.");
  });

  void it("never uses the raw folder default as a task name, but still attributes the task", async () => {
    const seen = await runWithNotificationTaskContextV1(undefined, "/w/2026-09-20_task_3", () =>
      Promise.resolve(attributeNotificationMessageV1("Hello."))
    );
    assert.equal(seen, '"Task 3 (2026-09-20)" — Hello.');
    assert.doesNotMatch(seen, /_task_/);
  });

  void it("names the operation's stage on a stage-specific notice, once", async () => {
    const seen = await runWithNotificationTaskContextV1(
      "alpha",
      "/w/a",
      () => Promise.resolve(attributeNotificationMessageV1("No model is configured for this stage.")),
      "impl-high-review"
    );
    assert.match(seen, /^"alpha" \(.+\) — No model is configured for this stage\.$/);
  });

  void it("keeps the enclosing root's context for a nested operation", async () => {
    const seen = await runWithNotificationTaskContextV1("alpha", "/w/a", () =>
      runWithNotificationTaskContextV1("child-name", "/w/a", () => Promise.resolve(attributeNotificationMessageV1("x")))
    );
    assert.equal(seen, '"alpha" — x');
  });
});

void describe("terminal notification stage attribution", () => {
  const base: TaskOperationSnapshot = {
    id: "op-1",
    key: "/dev/task_1",
    label: "Fast Forward",
    taskName: "alpha",
    startedAt: 1,
    finishedAt: 2,
    exclusive: true,
    cancellable: false,
    state: "succeeded",
    waitingForUser: false,
  };

  void it("names the stage when the snapshot has one and the label does not", () => {
    const entry = terminalEntryFor({ ...base, stage: "impl-high-review" });
    assert.match(entry?.message ?? "", /^Fast Forward — "alpha" \(.+\): completed$/);
  });

  void it("does not repeat a stage the label already names", () => {
    const entry = terminalEntryFor({ ...base, label: "Implementation", stage: "impl" });
    assert.doesNotMatch(entry?.message ?? "", /\(Implementation\)/);
  });

  void it("omits the stage when the snapshot has none", () => {
    assert.equal(terminalEntryFor(base)?.message, 'Fast Forward — "alpha": completed');
  });
});
