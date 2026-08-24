/**
 * Coverage for the refusal explainer (task "Actionable Hand-offs", "Also in
 * scope: when an action refuses, say what is blocking it and when it
 * clears"). The live incident: Review, Apply Review, and Fast Forward all
 * refused with a generic "already in progress" / "run the review again"
 * message while a continuation lease was actually held, and none of the
 * refusals named the blocker, the clearing time, the quarantined files, or
 * whether retrying could help. These tests pin the five required elements —
 * blocker, clearing time, quarantined files, do-not-retry line, remedy — and
 * the wiring into `showTaskBusyWarning` (the chokepoint every
 * `runTrackedOperation` refusal shares, including Review/Apply Review/Fast
 * Forward).
 */
import * as assert from "node:assert/strict";
import { afterEach, before, after, describe, it } from "node:test";
import * as vscode from "vscode";

import { describeOwedContinuationRefusalV1 } from "../utils/owedContinuationRefusalV1";
import { ImplRecoveryV1, MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1 } from "../types/taskProgress";
import {
  runTrackedOperation,
  showTaskBusyWarning,
  taskOperations,
} from "../utils/taskOperations";
import {
  deactivateNotificationRouter,
  initNotificationRouter,
} from "../utils/notificationRouter";

class RecordingSurface {
  entries: { message: string; level: "info" | "warning" | "error" }[] = [];
  addEntry(message: string, level: "info" | "warning" | "error"): void {
    this.entries.push({ message, level });
  }
}

function makeRecord(overrides: Partial<ImplRecoveryV1> = {}): ImplRecoveryV1 {
  return {
    sourceAttemptId: "impl-recovery-1",
    reason: "the provider returned no final response text at all",
    trigger: "roundIncomplete",
    mode: "unconstrained",
    dispatch: "dispatched",
    at: "2026-08-21T13:33:00.000Z",
    leaseUntil: "2026-08-21T13:45:27.000Z",
    ...overrides,
  };
}

void describe("describeOwedContinuationRefusalV1 — the refusal explainer's required elements", () => {
  void it("names the blocker in plain terms, including the recorded reason", () => {
    const message = describeOwedContinuationRefusalV1(makeRecord(), [], 0);
    assert.match(message, /A continuation round is owed for this task/);
    assert.match(message, /the provider returned no final response text at all/);
  });

  void it("names the clearing wall-clock time derived from leaseUntil", () => {
    const message = describeOwedContinuationRefusalV1(
      makeRecord({ leaseUntil: "2026-08-21T13:45:00.000Z" }),
      [],
      0
    );
    assert.match(message, /lease is held until/);
    // Localized HH:MM rendering — assert the mechanism (a real wall-clock
    // rendering of the ISO instant) rather than one fixed timezone's text.
    const expected = new Date("2026-08-21T13:45:00.000Z").toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    assert.match(message, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  void it("omits the lease clause entirely when no leaseUntil is recorded (a capped/exhausted record)", () => {
    const message = describeOwedContinuationRefusalV1(
      makeRecord({ leaseUntil: undefined }),
      [],
      0
    );
    assert.doesNotMatch(message, /lease is held until/);
  });

  void it("lists the quarantined files from pendingImplReviewFiles", () => {
    const message = describeOwedContinuationRefusalV1(
      makeRecord(),
      ["src/a.ts", "src/b.ts", "src/c.ts"],
      0
    );
    assert.match(message, /3 file\(s\) are quarantined/);
    assert.match(message, /- src\/a\.ts/);
    assert.match(message, /- src\/b\.ts/);
    assert.match(message, /- src\/c\.ts/);
  });

  void it("omits the file list when nothing is quarantined and the change set is not recorded unknown", () => {
    const message = describeOwedContinuationRefusalV1(makeRecord(), [], 0);
    assert.doesNotMatch(message, /quarantined/);
  });

  void it("renders an explicit unknown when nothing is quarantined but filesChangedUnknown is set", () => {
    const message = describeOwedContinuationRefusalV1(
      makeRecord({ filesChangedUnknown: true }),
      [],
      0
    );
    assert.match(message, /could not be enumerated \(recorded as unknown\)/);
  });

  void it("a dispatched record states retrying cannot help and that it is never re-fired automatically", () => {
    const message = describeOwedContinuationRefusalV1(makeRecord({ dispatch: "dispatched" }), [], 0);
    assert.match(message, /retrying this action will not/i);
    assert.match(message, /never re-fired automatically, even once its lease expires/i);
    // Must NOT claim the lease expiring re-arms it — that is the false
    // guidance this round corrects (a dispatched record is never re-armed).
    assert.doesNotMatch(message, /lease to expire and the continuation to re-arm/i);
  });

  void it("a dispatched record's remedy says lease expiry does not restart it, and offers reload-and-rerun", () => {
    const message = describeOwedContinuationRefusalV1(makeRecord({ dispatch: "dispatched" }), [], 0);
    assert.match(message, /lease expiring does not restart it/i);
    assert.match(message, /reload the window to release the dead owner and rerun the implementation manually/i);
  });

  void it("a pending record under budget says it will retry automatically and tells the user no action is needed", () => {
    const message = describeOwedContinuationRefusalV1(
      makeRecord({ dispatch: "pending", leaseUntil: undefined }),
      [],
      0
    );
    assert.match(message, /queued and will be retried automatically/);
    assert.match(message, /no action is needed from you/);
    assert.doesNotMatch(message, /retrying this action will not/i);
  });

  void it("a pending record with the continuation budget exhausted does NOT promise an automatic retry", () => {
    const message = describeOwedContinuationRefusalV1(
      makeRecord({ dispatch: "pending", leaseUntil: undefined }),
      [],
      MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1
    );
    assert.doesNotMatch(message, /queued and will be retried automatically/);
    assert.doesNotMatch(message, /no action is needed from you/);
    assert.match(message, /continuation budget is exhausted/);
    assert.match(message, /retrying this action will not help either/);
    assert.match(message, /rerun the implementation manually to continue/);
  });

  void it("a dispatched record with no lease still tells the user to reload rather than wait forever", () => {
    const message = describeOwedContinuationRefusalV1(
      makeRecord({ dispatch: "dispatched", leaseUntil: undefined }),
      [],
      0
    );
    assert.match(message, /Reload the window to release a dead owner/);
    assert.doesNotMatch(message, /wait for the lease to expire/);
  });

  void it("degrades gracefully rather than throwing on an unparseable leaseUntil", () => {
    const message = describeOwedContinuationRefusalV1(
      makeRecord({ leaseUntil: "not-a-real-timestamp" }),
      [],
      0
    );
    assert.match(message, /lease is held until not-a-real-timestamp/);
  });
});

void describe("showTaskBusyWarning — routes the busy refusal through the explainer when a continuation is owed", () => {
  afterEach(() => {
    deactivateNotificationRouter();
  });

  void it("falls back to the plain busy message for a task with no readable progress (e.g. a scratch path in tests)", async () => {
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const taskPath = `/tmp/rto-owed-fallback-${Math.random()}`;

    const handle = taskOperations.begin(taskPath, { label: "Running Implementation" });
    assert.ok(handle);
    try {
      await showTaskBusyWarning(taskPath);
      assert.ok(
        surface.entries.some((e) => e.message.includes("is already in progress")),
        `expected the generic busy message; got: ${JSON.stringify(surface.entries)}`
      );
      assert.ok(
        !surface.entries.some((e) => e.message.includes("continuation round is owed")),
        "must not fabricate an owed-continuation message with no progress evidence"
      );
    } finally {
      taskOperations.end(handle);
    }
  });

  void it("runTrackedOperation's busy refusal awaits the explainer before resolving (no floating promise)", async () => {
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const taskPath = `/tmp/rto-owed-tracked-${Math.random()}`;

    const existing = taskOperations.begin(taskPath, { label: "First Op" });
    assert.ok(existing);
    try {
      let fnCalled = false;
      const result = await runTrackedOperation(taskPath, { label: "Second Op" }, () => {
        fnCalled = true;
        return Promise.resolve("should not run");
      });
      assert.equal(result, undefined);
      assert.equal(fnCalled, false);
      // The warning must already be recorded by the time runTrackedOperation
      // resolves — proves the busy path is awaited, not fired-and-forgotten.
      assert.ok(surface.entries.length > 0, "the busy warning must be shown before runTrackedOperation resolves");
    } finally {
      taskOperations.end(existing);
    }
  });
});

void describe("showTaskBusyWarning — reads a real implRecovery record and surfaces the explainer", () => {
  const FOLDER_NAME = "owed-continuation-task";
  const FOLDER = vscode.Uri.file(`/tasks/${FOLDER_NAME}`);
  const workspace = vscode.workspace as unknown as {
    fs: {
      readFile: (uri: vscode.Uri) => Promise<Uint8Array>;
      createDirectory: (uri: vscode.Uri) => Promise<void>;
      readDirectory: (uri: vscode.Uri) => Promise<[string, number][]>;
      writeFile: (uri: vscode.Uri, content: Uint8Array) => Promise<void>;
    };
  };
  let originalReadFile: typeof workspace.fs.readFile;
  let originalCreateDirectory: typeof workspace.fs.createDirectory;
  let originalReadDirectory: typeof workspace.fs.readDirectory;
  let originalWriteFile: typeof workspace.fs.writeFile;
  const writtenRunLogs: { uri: vscode.Uri; content: string }[] = [];

  before(() => {
    originalReadFile = workspace.fs.readFile;
    originalCreateDirectory = workspace.fs.createDirectory;
    originalReadDirectory = workspace.fs.readDirectory;
    originalWriteFile = workspace.fs.writeFile;
  });

  after(() => {
    workspace.fs.readFile = originalReadFile;
    workspace.fs.createDirectory = originalCreateDirectory;
    workspace.fs.readDirectory = originalReadDirectory;
    workspace.fs.writeFile = originalWriteFile;
  });

  afterEach(() => {
    deactivateNotificationRouter();
    workspace.fs.readFile = originalReadFile;
    workspace.fs.createDirectory = originalCreateDirectory;
    workspace.fs.readDirectory = originalReadDirectory;
    workspace.fs.writeFile = originalWriteFile;
    writtenRunLogs.length = 0;
  });

  function stubProgress(progress: Record<string, unknown>): void {
    workspace.fs.readFile = (uri: vscode.Uri): Promise<Uint8Array> => {
      if (uri.fsPath === vscode.Uri.joinPath(FOLDER, "task-progress.json").fsPath) {
        return Promise.resolve(new TextEncoder().encode(JSON.stringify(progress)));
      }
      return Promise.reject(new Error(`ENOENT: ${uri.fsPath}`));
    };
  }

  function stubRunLogWrites(): void {
    workspace.fs.createDirectory = (): Promise<void> => Promise.resolve();
    workspace.fs.readDirectory = (): Promise<[string, number][]> => Promise.reject(new Error("ENOENT"));
    workspace.fs.writeFile = (uri: vscode.Uri, content: Uint8Array): Promise<void> => {
      writtenRunLogs.push({ uri, content: new TextDecoder().decode(content) });
      return Promise.resolve();
    };
  }

  void it("shows the rich explainer, naming the lease and quarantined files, for a task with an owed continuation", async () => {
    stubProgress({
      taskFolder: FOLDER_NAME,
      currentStage: "impl-high-review",
      status: "active",
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T13:33:00.000Z",
      pendingImplReviewFiles: ["src/foo.ts", "src/bar.ts"],
      implRecovery: {
        sourceAttemptId: "impl-recovery-9",
        reason: "the provider's final response was cut short",
        trigger: "roundIncomplete",
        mode: "unconstrained",
        dispatch: "dispatched",
        at: "2026-08-21T13:33:00.000Z",
        leaseOwner: "window-a:abc123",
        leaseUntil: "2026-08-21T13:45:27.000Z",
      },
    });
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const handle = taskOperations.begin(FOLDER.fsPath, { label: "Applying implementation review" });
    assert.ok(handle);
    try {
      await showTaskBusyWarning(FOLDER.fsPath);
      const message = surface.entries[0]?.message ?? "";
      assert.match(message, /A continuation round is owed for this task/);
      assert.match(message, /2 file\(s\) are quarantined/);
      assert.match(message, /- src\/foo\.ts/);
      assert.match(message, /retrying this action will not/i);
    } finally {
      taskOperations.end(handle);
    }
  });

  void it("records a visible declined-with-reason run-log entry, distinguishable from a failure or a silent gap", async () => {
    stubProgress({
      taskFolder: FOLDER_NAME,
      currentStage: "impl-high-review",
      status: "active",
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T13:33:00.000Z",
      pendingImplReviewFiles: ["src/foo.ts"],
      implRecovery: {
        sourceAttemptId: "impl-recovery-9",
        reason: "the provider's final response was cut short",
        trigger: "roundIncomplete",
        mode: "unconstrained",
        dispatch: "dispatched",
        at: "2026-08-21T13:33:00.000Z",
        leaseUntil: "2026-08-21T13:45:27.000Z",
      },
    });
    stubRunLogWrites();
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const handle = taskOperations.begin(FOLDER.fsPath, { label: "Review" });
    assert.ok(handle);
    try {
      await showTaskBusyWarning(FOLDER.fsPath);
      assert.equal(writtenRunLogs.length, 1, "exactly one run log must be written for the declined action");
      const [log] = writtenRunLogs;
      assert.match(log!.uri.fsPath, /-declined-/, "the run log filename must name this a declined action");
      assert.match(log!.content, /Status: declined \(owed continuation\)/);
      assert.match(log!.content, /A continuation round is owed for this task/);
    } finally {
      taskOperations.end(handle);
    }
  });

  void it("falls back to the plain busy message when progress is readable but carries no implRecovery", async () => {
    stubProgress({
      taskFolder: FOLDER_NAME,
      currentStage: "impl",
      status: "active",
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T13:33:00.000Z",
    });
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const handle = taskOperations.begin(FOLDER.fsPath, { label: "Running Implementation" });
    assert.ok(handle);
    try {
      await showTaskBusyWarning(FOLDER.fsPath);
      const message = surface.entries[0]?.message ?? "";
      assert.match(message, /is already in progress/);
      assert.doesNotMatch(message, /continuation round is owed/);
    } finally {
      taskOperations.end(handle);
    }
  });
});
