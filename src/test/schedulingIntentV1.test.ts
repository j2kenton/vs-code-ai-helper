/**
 * Coverage for the scheduling-intent ledger (task: "Actionable Hand-offs",
 * PART 6):
 *  - `SchedulingIntentStoreV1` carries an entry through its full lifecycle
 *    (`scheduled` -> `running` -> a terminal state);
 *  - `deriveSchedulingPostureV1` reduces entries + live state into exactly
 *    one of five mutually-exclusive postures, in precedence order —
 *    running beats scheduled beats owed-but-will-not-retry beats
 *    waiting-for-you beats unknown;
 *  - an in-flight operation with NO matching ledger entry still resolves to
 *    `running` (the in-flight registry is authoritative for "executing now");
 *  - `waitingForYou` requires the coverage marker AND every other positive
 *    clause — an empty ledger without the marker is `unknown`, never a false
 *    "nothing to do";
 *  - `pruneStaleSchedulingIntentsV1` self-heals a stuck `scheduled`/`running`
 *    entry into `expired` past its staleness window;
 *  - `applySchedulingIntentRetentionV1` keeps terminal entries (retention,
 *    not deletion) so "why did that round start" stays answerable.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  announceAutoStartBestEffortV1,
  applySchedulingIntentRetentionV1,
  buildAutoStartAnnouncementTextV1,
  deriveOwedContinuationRecordV1,
  deriveSchedulingPostureV1,
  hasLiveSchedulingIntentBestEffortV1,
  OwedContinuationSourceV1,
  pruneStaleSchedulingIntentsV1,
  SchedulingIntentStoreV1,
  SchedulingIntentV1,
  SCHEDULING_INTENT_STALE_MS_V1,
  syncOwedContinuationLedgerBestEffortV1,
} from "../state/schedulingIntentV1";
import * as vscode from "vscode";
import { readChatHistory } from "../utils/chatHistoryStore";
import { configureWorkflowPrivateStorageRootV1 } from "../services/workflowRuntimeServicesV1";
import { makeOwnedTaskFolder } from "./taskFolderFixture";

/** `announceAutoStartBestEffortV1` reads task-progress.json via
 * `readTaskProgressStrictV1`, which goes through `vscode.workspace.fs.readFile`
 * — unimplemented in the unit-test vscode stub by default (mirrors
 * `taskProgressReaderV1.test.ts`'s own `installRealDiskReadFile`). */
function installRealDiskReadFile(): () => void {
  const orig = (vscode.workspace.fs as unknown as Record<string, unknown>).readFile;
  (vscode.workspace.fs as unknown as Record<string, unknown>).readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  return () => {
    (vscode.workspace.fs as unknown as Record<string, unknown>).readFile = orig;
  };
}

configureWorkflowPrivateStorageRootV1(fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-scheduling-intent-private-storage-")));

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

function fakeMemento(): import("vscode").Memento {
  return new FakeMemento() as unknown as import("vscode").Memento;
}

function makeEntry(overrides: Partial<SchedulingIntentV1> = {}): SchedulingIntentV1 {
  return {
    intentId: "intent-1",
    taskCanonicalId: "/task-a",
    command: "x.review",
    chainId: "auto-review",
    trigger: "auto-review after plan completes",
    willRetry: false,
    transitions: [{ state: "scheduled", at: new Date().toISOString() }],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

void describe("SchedulingIntentStoreV1 lifecycle", () => {
  void it("carries a new entry through scheduled -> running -> completed", async () => {
    const store = new SchedulingIntentStoreV1(fakeMemento());
    const entry = await store.recordScheduled({
      taskCanonicalId: "/task-a",
      command: "x.review",
      chainId: "auto-review",
      trigger: "auto-review after plan completes",
      willRetry: false,
    });
    assert.equal(store.listForTask("/task-a").length, 1);
    assert.deepEqual(
      store.listForTask("/task-a")[0]!.transitions.map((t) => t.state),
      ["scheduled"]
    );

    await store.recordRunning(entry.intentId);
    assert.deepEqual(
      store.listForTask("/task-a")[0]!.transitions.map((t) => t.state),
      ["scheduled", "running"]
    );

    await store.recordTerminal(entry.intentId, "completed");
    assert.deepEqual(
      store.listForTask("/task-a")[0]!.transitions.map((t) => t.state),
      ["scheduled", "running", "completed"]
    );
  });

  void it("carries an entry through scheduled -> cancelled without ever running", async () => {
    const store = new SchedulingIntentStoreV1(fakeMemento());
    const entry = await store.recordScheduled({
      taskCanonicalId: "/task-a",
      command: "x.review",
      chainId: "auto-review",
      trigger: "t",
      willRetry: false,
    });
    await store.recordTerminal(entry.intentId, "cancelled");
    assert.deepEqual(
      store.listForTask("/task-a")[0]!.transitions.map((t) => t.state),
      ["scheduled", "cancelled"]
    );
  });

  void it("recordScheduled marks the task's coverage marker", async () => {
    const store = new SchedulingIntentStoreV1(fakeMemento());
    assert.equal(store.hasCoverage("/task-a"), false);
    await store.recordScheduled({
      taskCanonicalId: "/task-a",
      command: "x.review",
      chainId: "auto-review",
      trigger: "t",
      willRetry: false,
    });
    assert.equal(store.hasCoverage("/task-a"), true);
  });

  void it("removeForTask drops entries and the coverage marker for one task only", async () => {
    const store = new SchedulingIntentStoreV1(fakeMemento());
    await store.recordScheduled({
      taskCanonicalId: "/task-a",
      command: "x.review",
      chainId: "auto-review",
      trigger: "t",
      willRetry: false,
    });
    await store.recordScheduled({
      taskCanonicalId: "/task-b",
      command: "x.review",
      chainId: "auto-review",
      trigger: "t",
      willRetry: false,
    });
    await store.removeForTask("/task-a");
    assert.equal(store.listForTask("/task-a").length, 0);
    assert.equal(store.hasCoverage("/task-a"), false);
    assert.equal(store.listForTask("/task-b").length, 1);
    assert.equal(store.hasCoverage("/task-b"), true);
  });
});

void describe("SchedulingIntentStoreV1 owed-continuation ledger (task 'Actionable Hand-offs', PART 6.5)", () => {
  const source: OwedContinuationSourceV1 = {
    reason: "unusable summary",
    at: "2026-08-23T10:00:00.000Z",
    leaseUntil: "2026-08-23T10:10:00.000Z",
    quarantinedFiles: ["src/a.ts"],
    dispatch: "pending",
  };

  void it("getOwedContinuation is undefined for a task that has never been recorded", () => {
    const store = new SchedulingIntentStoreV1(fakeMemento());
    assert.equal(store.getOwedContinuation("/task-a"), undefined);
  });

  void it("recordOwedContinuation persists the fact and getOwedContinuation reads it back", async () => {
    const store = new SchedulingIntentStoreV1(fakeMemento());
    await store.recordOwedContinuation("/task-a", source);
    assert.deepEqual(store.getOwedContinuation("/task-a"), source);
  });

  void it("recordOwedContinuation with undefined clears a previously-recorded fact", async () => {
    const store = new SchedulingIntentStoreV1(fakeMemento());
    await store.recordOwedContinuation("/task-a", source);
    await store.recordOwedContinuation("/task-a", undefined);
    assert.equal(store.getOwedContinuation("/task-a"), undefined);
  });

  void it("recordOwedContinuation keeps different tasks' facts independent", async () => {
    const store = new SchedulingIntentStoreV1(fakeMemento());
    await store.recordOwedContinuation("/task-a", source);
    assert.equal(store.getOwedContinuation("/task-b"), undefined);
    await store.recordOwedContinuation("/task-b", undefined);
    assert.deepEqual(store.getOwedContinuation("/task-a"), source);
  });

  void it("removeForTask also drops the owed-continuation fact for that task only", async () => {
    const store = new SchedulingIntentStoreV1(fakeMemento());
    await store.recordOwedContinuation("/task-a", source);
    await store.recordOwedContinuation("/task-b", source);
    await store.removeForTask("/task-a");
    assert.equal(store.getOwedContinuation("/task-a"), undefined);
    assert.deepEqual(store.getOwedContinuation("/task-b"), source);
  });
});

void describe("syncOwedContinuationLedgerBestEffortV1", () => {
  void it("is a no-op with no taskKey", async () => {
    // No activating extension context is configured in this test process
    // either, so this also exercises the "no context" no-op path — neither
    // branch may throw.
    await assert.doesNotReject(() => syncOwedContinuationLedgerBestEffortV1(undefined, undefined));
  });

  void it("never throws when no activating extension context is available", async () => {
    await assert.doesNotReject(() =>
      syncOwedContinuationLedgerBestEffortV1("/task-a", {
        reason: "x",
        at: "2026-08-23T10:00:00.000Z",
        quarantinedFiles: [],
        dispatch: "pending",
      })
    );
  });
});

void describe("pruneStaleSchedulingIntentsV1", () => {
  void it("leaves a fresh scheduled/running entry untouched", () => {
    const now = Date.parse("2026-08-23T10:00:00.000Z");
    const entry = makeEntry({ transitions: [{ state: "scheduled", at: new Date(now - 1000).toISOString() }] });
    const pruned = pruneStaleSchedulingIntentsV1([entry], now);
    assert.deepEqual(pruned[0]!.transitions.map((t) => t.state), ["scheduled"]);
  });

  void it("self-heals a stuck scheduled entry into expired past the staleness window", () => {
    const now = Date.parse("2026-08-23T10:00:00.000Z");
    const staleAt = now - SCHEDULING_INTENT_STALE_MS_V1 - 1;
    const entry = makeEntry({ transitions: [{ state: "scheduled", at: new Date(staleAt).toISOString() }] });
    const pruned = pruneStaleSchedulingIntentsV1([entry], now);
    assert.deepEqual(pruned[0]!.transitions.map((t) => t.state), ["scheduled", "expired"]);
  });

  void it("self-heals a stuck running entry into expired past the staleness window (a process died mid-flight)", () => {
    const now = Date.parse("2026-08-23T10:00:00.000Z");
    const staleAt = now - SCHEDULING_INTENT_STALE_MS_V1 - 1;
    const entry = makeEntry({
      transitions: [
        { state: "scheduled", at: new Date(staleAt - 1000).toISOString() },
        { state: "running", at: new Date(staleAt).toISOString() },
      ],
    });
    const pruned = pruneStaleSchedulingIntentsV1([entry], now);
    assert.deepEqual(pruned[0]!.transitions.map((t) => t.state), ["scheduled", "running", "expired"]);
  });

  void it("never re-expires an already-terminal entry", () => {
    const now = Date.parse("2026-08-23T10:00:00.000Z");
    const longAgo = now - SCHEDULING_INTENT_STALE_MS_V1 * 10;
    const entry = makeEntry({ transitions: [{ state: "completed", at: new Date(longAgo).toISOString() }] });
    const pruned = pruneStaleSchedulingIntentsV1([entry], now);
    assert.deepEqual(pruned[0]!.transitions.map((t) => t.state), ["completed"]);
  });
});

void describe("applySchedulingIntentRetentionV1", () => {
  void it("retains terminal entries (retention, not deletion) within the TTL window", () => {
    const now = Date.parse("2026-08-23T10:00:00.000Z");
    const entry = makeEntry({ transitions: [{ state: "completed", at: new Date(now - 1000).toISOString() }] });
    const kept = applySchedulingIntentRetentionV1([entry], now);
    assert.equal(kept.length, 1, "a recent terminal entry must be retained, not dropped");
  });

  void it("keeps at least keepCount most-recent entries regardless of age", () => {
    const now = Date.parse("2026-08-23T10:00:00.000Z");
    const veryOld = now - 365 * 24 * 60 * 60 * 1000;
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({ intentId: `intent-${i}`, transitions: [{ state: "completed", at: new Date(veryOld + i).toISOString() }] })
    );
    const kept = applySchedulingIntentRetentionV1(entries, now, 3, 0);
    assert.equal(kept.length, 3, "the 3 most recent of 5 must survive even though all are past the TTL");
  });

  void it("drops an old terminal entry once past both keepCount and the TTL", () => {
    const now = Date.parse("2026-08-23T10:00:00.000Z");
    const recent = makeEntry({ intentId: "recent", transitions: [{ state: "completed", at: new Date(now - 1000).toISOString() }] });
    const old = makeEntry({ intentId: "old", transitions: [{ state: "completed", at: new Date(now - 100_000).toISOString() }] });
    const kept = applySchedulingIntentRetentionV1([recent, old], now, 1, 10_000);
    assert.deepEqual(kept.map((e) => e.intentId), ["recent"]);
  });
});

void describe("deriveSchedulingPostureV1 precedence", () => {
  const now = Date.parse("2026-08-23T10:00:00.000Z");

  void it("reports unknown when nothing has ever been recorded", () => {
    const posture = deriveSchedulingPostureV1({ entries: [], hasCoverage: false, inFlight: false, now });
    assert.equal(posture.kind, "unknown");
  });

  void it("reports waitingForYou only when the coverage marker is present AND every other clause is negative", () => {
    const posture = deriveSchedulingPostureV1({ entries: [], hasCoverage: true, inFlight: false, now });
    assert.equal(posture.kind, "waitingForYou");
  });

  void it("does NOT report waitingForYou from an empty ledger without the coverage marker (absence is never positive evidence)", () => {
    const posture = deriveSchedulingPostureV1({ entries: [], hasCoverage: false, inFlight: false, now });
    assert.equal(posture.kind, "unknown");
  });

  void it("owedWillNotRetry beats waitingForYou", () => {
    const posture = deriveSchedulingPostureV1({
      entries: [],
      hasCoverage: true,
      inFlight: false,
      owedContinuation: {
        taskCanonicalId: "/task-a",
        blocker: "A continuation round is owed.",
        surfacedAt: new Date(now).toISOString(),
        quarantinedFiles: ["src/a.ts"],
        willRetry: false,
      },
      now,
    });
    assert.equal(posture.kind, "owedWillNotRetry");
  });

  void it("scheduled beats owedWillNotRetry", () => {
    const scheduled = makeEntry({ transitions: [{ state: "scheduled", at: new Date(now).toISOString() }] });
    const posture = deriveSchedulingPostureV1({
      entries: [scheduled],
      hasCoverage: true,
      inFlight: false,
      owedContinuation: {
        taskCanonicalId: "/task-a",
        blocker: "A continuation round is owed.",
        surfacedAt: new Date(now).toISOString(),
        quarantinedFiles: [],
        willRetry: false,
      },
      now,
    });
    assert.equal(posture.kind, "scheduled");
  });

  void it("running (from a ledger entry) beats scheduled", () => {
    const scheduled = makeEntry({ intentId: "a", transitions: [{ state: "scheduled", at: new Date(now).toISOString() }] });
    const running = makeEntry({ intentId: "b", transitions: [{ state: "running", at: new Date(now).toISOString() }] });
    const posture = deriveSchedulingPostureV1({ entries: [scheduled, running], hasCoverage: true, inFlight: false, now });
    assert.equal(posture.kind, "running");
  });

  void it("an in-flight operation with NO matching ledger entry still resolves to running", () => {
    const posture = deriveSchedulingPostureV1({ entries: [], hasCoverage: true, inFlight: true, now });
    assert.equal(posture.kind, "running");
  });

  void it("a stale (past-TTL) scheduled entry does not block the fallback to owed/waiting/unknown", () => {
    const staleAt = now - SCHEDULING_INTENT_STALE_MS_V1 - 1;
    const stale = makeEntry({ transitions: [{ state: "scheduled", at: new Date(staleAt).toISOString() }] });
    const posture = deriveSchedulingPostureV1({ entries: [stale], hasCoverage: true, inFlight: false, now });
    assert.equal(posture.kind, "waitingForYou", "an expired scheduled entry must not present as still scheduled");
  });

  void it("owedContinuationUnknown forces the explicit unknown posture, never the false-positive waitingForYou (review-flagged 2026-08-23)", () => {
    // Coverage present and every other clause negative is exactly the shape
    // that would otherwise resolve to waitingForYou — but the caller could
    // not actually establish whether a continuation is owed (e.g. a failed
    // TaskProgress read), so absence of an owedContinuation record here must
    // NOT be read as positive evidence that nothing is owed.
    const posture = deriveSchedulingPostureV1({
      entries: [],
      hasCoverage: true,
      inFlight: false,
      owedContinuationUnknown: true,
      now,
    });
    assert.equal(posture.kind, "unknown");
  });

  void it("owedContinuationUnknown does not override a live running/scheduled entry", () => {
    const scheduled = makeEntry({ transitions: [{ state: "scheduled", at: new Date(now).toISOString() }] });
    const posture = deriveSchedulingPostureV1({
      entries: [scheduled],
      hasCoverage: true,
      inFlight: false,
      owedContinuationUnknown: true,
      now,
    });
    assert.equal(posture.kind, "scheduled");
  });
});

void describe("deriveOwedContinuationRecordV1", () => {
  void it("returns undefined when no implRecovery source is given", () => {
    assert.equal(deriveOwedContinuationRecordV1("/task-a", undefined), undefined);
  });

  void it("a 'dispatched' record (already claimed a round) is described as will-not-retry", () => {
    const record = deriveOwedContinuationRecordV1("/task-a", {
      reason: "the round ended without a usable report",
      at: "2026-08-21T08:33:00.000Z",
      leaseUntil: "2026-08-21T09:45:27.000Z",
      quarantinedFiles: ["src/a.ts", "src/b.ts"],
      dispatch: "dispatched",
    });
    assert.ok(record);
    assert.equal(record.willRetry, false);
    assert.match(record.blocker, /continuation round is owed/i);
    assert.match(record.blocker, /will not re-fire automatically/i);
    assert.equal(record.surfacedAt, "2026-08-21T08:33:00.000Z");
    assert.equal(record.leaseUntil, "2026-08-21T09:45:27.000Z");
    assert.deepEqual(record.quarantinedFiles, ["src/a.ts", "src/b.ts"]);
  });

  // Review-flagged (2026-08-23): a "pending" record IS retried automatically
  // by the periodic recovery sweep (scheduleTaskResume.ts's
  // armPendingImplRecoveries) — describing it as "will not re-fire
  // automatically" falsely told the operator to intervene manually on a
  // continuation the system already intended to pick back up.
  void it("a 'pending' record (not yet claimed) is described as will-retry, not will-not-retry", () => {
    const record = deriveOwedContinuationRecordV1("/task-a", {
      reason: "the process died before the continuation round began",
      at: "2026-08-21T08:33:00.000Z",
      quarantinedFiles: [],
      dispatch: "pending",
    });
    assert.ok(record);
    assert.equal(record.willRetry, true);
    assert.match(record.blocker, /continuation round is owed/i);
    assert.doesNotMatch(record.blocker, /will not re-fire automatically/i);
    assert.match(record.blocker, /will be retried automatically/i);
  });

  // Review-flagged (2026-08-23): a retryable ("pending") owed continuation is
  // not "owed-but-will-not-retry" at all — that posture's name is a
  // statement of fact, not a label. `deriveSchedulingPostureV1` now routes a
  // retryable owed continuation to "scheduled" instead, so its `willRetry`
  // never disagrees with its own posture kind the way the prior round's
  // fallback allowed. Only a genuinely dead ("dispatched") record reaches
  // `owedWillNotRetry`, where `willRetry` is therefore always `false`.
  void it("a retryable ('pending') owed continuation renders as scheduled, not owed-will-not-retry", () => {
    const now = Date.parse("2026-08-23T10:00:00.000Z");
    const pendingPosture = deriveSchedulingPostureV1({
      entries: [],
      hasCoverage: true,
      inFlight: false,
      owedContinuation: deriveOwedContinuationRecordV1("/task-a", {
        reason: "r",
        at: new Date(now).toISOString(),
        quarantinedFiles: ["src/a.ts"],
        dispatch: "pending",
      }),
      now,
    });
    assert.equal(pendingPosture.kind, "scheduled");
    assert.match((pendingPosture as { trigger: string }).trigger, /retried automatically/i);
    assert.match((pendingPosture as { trigger: string }).trigger, /src\/a\.ts/);
  });

  void it("a dead ('dispatched') owed continuation renders as owed-will-not-retry with willRetry: false", () => {
    const now = Date.parse("2026-08-23T10:00:00.000Z");
    const dispatchedPosture = deriveSchedulingPostureV1({
      entries: [],
      hasCoverage: true,
      inFlight: false,
      owedContinuation: deriveOwedContinuationRecordV1("/task-a", {
        reason: "r",
        at: new Date(now).toISOString(),
        quarantinedFiles: [],
        dispatch: "dispatched",
      }),
      now,
    });
    assert.equal(dispatchedPosture.kind, "owedWillNotRetry");
    assert.equal((dispatchedPosture as { willRetry: boolean }).willRetry, false);
  });
});

void describe("SchedulingIntentStoreV1.listForTask persists stale->expired transitions", () => {
  void it("saves the expired transition back to storage, not only in the returned copy", async () => {
    const memento = fakeMemento();
    const store = new SchedulingIntentStoreV1(memento);
    const entry = await store.recordScheduled({
      taskCanonicalId: "/task-a",
      command: "x.review",
      chainId: "auto-review",
      trigger: "t",
      willRetry: false,
    });
    const farFuture = Date.now() + SCHEDULING_INTENT_STALE_MS_V1 * 10;
    const first = store.listForTask("/task-a", farFuture);
    assert.deepEqual(first[0]!.transitions.map((t) => t.state), ["scheduled", "expired"]);
    // A second, independent store instance over the SAME memento must see the
    // persisted expiry too — proving it was actually saved, not merely
    // returned as a transient pruned copy.
    const otherStore = new SchedulingIntentStoreV1(memento);
    // Small delay to let the fire-and-forget save from the first call land.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = otherStore.listForTask("/task-a", farFuture);
    assert.deepEqual(second[0]!.transitions.map((t) => t.state), ["scheduled", "expired"]);
    void entry;
  });
});

void describe("buildAutoStartAnnouncementTextV1", () => {
  void it("names the trigger and the controlling setting when one is recorded", () => {
    const text = buildAutoStartAnnouncementTextV1({
      trigger: "auto-implement after review completes",
      settingKey: "ensemble.autoImplementAfterReview",
      willRetry: false,
    });
    assert.match(text, /auto-implement after review completes/);
    assert.match(text, /`ensemble\.autoImplementAfterReview`/);
  });

  void it("names the trigger alone, with no fabricated setting, when the dispatch is not setting-driven", () => {
    const text = buildAutoStartAnnouncementTextV1({
      trigger: "structural continuation after implementation review",
      willRetry: false,
    });
    assert.match(text, /structural continuation after implementation review/);
    assert.doesNotMatch(text, /controlled by/);
    // Review-flagged (2026-08-23): provenance must be STATED explicitly, not
    // merely omitted — an absent clause reads as an oversight, not the
    // deliberate "this is structural, not a fabricated setting" statement
    // the plan requires.
    assert.match(text, /not setting-driven/);
  });
});

void describe("announceAutoStartBestEffortV1 (review-flagged 2026-08-23: schema-valid persisted message)", () => {
  void it("writes a message that decodes back cleanly, stamped with the task's real current stage", async () => {
    // The bug: this function used to write `stage: null` unconditionally.
    // `ChatMessage.stage` may only be `null` on a `legacyRecovery` record
    // (chatHistoryStore.ts's `validateMessages`) — every other shape fails
    // decode on the next read, and `readChatDocument` quarantines the WHOLE
    // transcript as an unrecognized document. A passing round-trip here is
    // the guard against that regression: it proves the announcement is
    // actually readable afterward, not just that the write call resolved.
    const fixture = makeOwnedTaskFolder("ensemble-scheduling-announce-");
    const restore = installRealDiskReadFile();
    try {
      await announceAutoStartBestEffortV1({
        taskKey: fixture.folder,
        command: "ensemble.runImplementation",
        intent: { trigger: "auto-implement after review completes", willRetry: false },
      });
      const messages = await readChatHistory(fixture.folder);
      assert.equal(messages.length, 1, "the announcement must be readable back, not silently lost to quarantine");
      assert.equal(messages[0]!.role, "assistant");
      assert.match(messages[0]!.text, /auto-implement after review completes/);
      assert.equal(messages[0]!.stage, "impl", "the persisted message must carry the task's real current TaskStage, never null");
    } finally {
      restore();
      fs.rmSync(fixture.folder, { recursive: true, force: true });
    }
  });

  void it("skips the announcement (rather than writing an invalid message) when the task's stage cannot be established", async () => {
    // No `installRealDiskReadFile()` here — `vscode.workspace.fs.readFile`
    // stays unstubbed, so `readTaskProgressStrictV1` fails exactly like it
    // would for an unreadable/corrupt task-progress.json in production. The
    // announcement must decline silently, never fall back to `stage: null`.
    const fixture = makeOwnedTaskFolder("ensemble-scheduling-announce-unreadable-");
    try {
      await announceAutoStartBestEffortV1({
        taskKey: fixture.folder,
        command: "ensemble.runImplementation",
        intent: { trigger: "auto-implement after review completes", willRetry: false },
      });
      const messages = await readChatHistory(fixture.folder);
      assert.equal(messages.length, 0, "no message should be written when the stage cannot be established");
    } finally {
      fs.rmSync(fixture.folder, { recursive: true, force: true });
    }
  });

  // wf "make the stage chat a record of work" Part 4 / item 1: the
  // announcement must be classifiable as an activity line (for the
  // collapsed "Activity" group, Part 9) and correlatable back to the
  // scheduling-intent id that caused it, so the reconciliation sweep's
  // pass (c) can eventually pair a legacy-shaped announcement with a
  // round-ledger row.
  void it("stamps the announcement with kind:'activity' and the caller's intentId", async () => {
    const fixture = makeOwnedTaskFolder("ensemble-scheduling-announce-activity-");
    const restore = installRealDiskReadFile();
    try {
      await announceAutoStartBestEffortV1({
        taskKey: fixture.folder,
        command: "ensemble.runImplementation",
        intent: { trigger: "auto-implement after review completes", willRetry: false },
        intentId: "intent-abc-123",
      });
      const messages = await readChatHistory(fixture.folder);
      assert.equal(messages.length, 1);
      assert.equal(messages[0]!.kind, "activity");
      assert.equal(messages[0]!.intentId, "intent-abc-123");
    } finally {
      restore();
      fs.rmSync(fixture.folder, { recursive: true, force: true });
    }
  });

  void it("still stamps kind:'activity' when no intentId is supplied, just without the correlation field", async () => {
    const fixture = makeOwnedTaskFolder("ensemble-scheduling-announce-activity-no-intent-");
    const restore = installRealDiskReadFile();
    try {
      await announceAutoStartBestEffortV1({
        taskKey: fixture.folder,
        command: "ensemble.runImplementation",
        intent: { trigger: "auto-implement after review completes", willRetry: false },
      });
      const messages = await readChatHistory(fixture.folder);
      assert.equal(messages.length, 1);
      assert.equal(messages[0]!.kind, "activity");
      assert.equal(messages[0]!.intentId, undefined);
    } finally {
      restore();
      fs.rmSync(fixture.folder, { recursive: true, force: true });
    }
  });
});

// 2026-08-27 review-flagged: this helper's ONLY caller
// (`roundLedgerReconciliationV1.ts`) reads a `false` return as authorization
// to terminalize a `roundLedger` row as orphaned. An earlier version failed
// to `false` on both the "no extension context" and "read threw" paths,
// which is exactly the "definitely nothing live" claim the function's own
// doc comment says must never be made from an indeterminate read. It must
// fail OPEN (`true`) instead, so "cannot determine" is never mistaken for
// "safe to close".
void describe("hasLiveSchedulingIntentBestEffortV1 (fails open, never closed, when indeterminate)", () => {
  void it("returns true when no extension context is available, never false", () => {
    // No `getExtensionContextV1()` has been configured anywhere in this test
    // file, so this exercises the exact "context unavailable" path the
    // review flagged.
    assert.equal(hasLiveSchedulingIntentBestEffortV1("some-canonical-id-with-no-context"), true);
  });
});
