/**
 * RC6 items 2 and 5: pure pieces — the Publish fix note under the stale
 * banner, and the per-attempt provider labels in a failure message.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import * as vscode from "vscode";
import {
  isStaleReviewArtifactV1,
  upsertArtifactChangeStaleBannerV1,
  upsertNoteBelowArtifactChangeBannerV1,
} from "../utils/reviewReadiness";
import { initNotificationRouter, deactivateNotificationRouter } from "../utils/notificationRouter";
import { describePublishPromotionGuardFailureV1 } from "../actions/rows/reviewRowV1";
import {
  classifyPublishChecksFreshnessV1,
  computePublishScopeId,
  describePublishChecksFreshnessFailureV1,
  markPublishReviewStaleV1,
  writePublishFixNoteV1,
} from "../utils/publishChecksFreshness";
import { describeTaskActionFailureV1 } from "../utils/taskActionOutcomeTextV1";
import {
  createSafeAdmissionReleaseStateV1,
  type WorkAdmissionHandleV1,
} from "../state/workAdmissionV1";
import {
  beginRoundProcessRecordingV1,
  recordRoundProcessV1,
  type RecordedProviderProcessV1,
} from "../state/roundProcessRecordV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import {
  createPublishFixReleaseCoordinatorV1,
  createReleaseTrackedHandleV1,
} from "../commands/runLintingFixes";
import { CHECK_AND_REVIEW_PUBLISH_COMMAND_ID_V1 } from "../commands/checkAndReviewPublish";
import type { AutomationDispatch } from "../utils/automationChain";

const PREFIXES = ["> Publish Checks still fail after the fix:", "> Publish Checks pass after the fix"];
const REVIEW = "Readiness: 6/10\n\nNeeds changes.\n\n<!-- stamp -->\n";

void describe("Publish fix banner and note (RC6 item 5)", () => {
  void it("inserts the stale banner under Readiness and leaves every other line unchanged", () => {
    const stale = upsertArtifactChangeStaleBannerV1(
      REVIEW,
      "workspace files (Fix Linting & Code Errors)",
      "2026-10-02T04:00:00.000Z"
    );
    assert.equal(
      stale,
      "Readiness: 6/10\n> ⚠ Stale: superseded by an update to workspace files (Fix Linting & Code Errors) at 2026-10-02T04:00:00.000Z.\n\nNeeds changes.\n\n<!-- stamp -->\n"
    );
    assert.ok(isStaleReviewArtifactV1(stale));
  });

  void it("puts one note below the banner and replaces it in place", () => {
    const stale = upsertArtifactChangeStaleBannerV1(REVIEW, "workspace files", "2026-10-02T04:00:00.000Z");
    const first = upsertNoteBelowArtifactChangeBannerV1(stale, PREFIXES, "> Publish Checks still fail after the fix: pnpm run verify.");
    const second = upsertNoteBelowArtifactChangeBannerV1(first, PREFIXES, "> Publish Checks pass after the fix.");
    const lines = second.split("\n");
    assert.equal(lines[2], "> Publish Checks pass after the fix.");
    assert.equal(second.split("Publish Checks").length - 1, 1);
  });

  void it("leaves content without a banner untouched", () => {
    assert.equal(upsertNoteBelowArtifactChangeBannerV1(REVIEW, PREFIXES, "> x"), REVIEW);
  });
});

void describe("failure message names every model tried (RC6 item 2)", () => {
  void it("renders provider labels for each attempt", () => {
    const text = describeTaskActionFailureV1({
      kind: "failed",
      code: "cliExit.1",
      retryable: true,
      attemptId: "a3",
      provider: { providerLabel: "Claude", storedModelId: "claude-cli:opus" },
      priorRejectedAttemptsV1: [
        { attemptId: "a1", code: "cliExit.1", detail: "usage limit", providerLabel: "Codex" },
        { attemptId: "a2", code: "copilotEmptyResponse", providerLabel: "Copilot" },
      ],
    });
    assert.match(text, /attempt 1: cliExit\.1: usage limit \[Codex\]/);
    assert.match(text, /attempt 2: copilotEmptyResponse \[Copilot\]/);
  });
});

void describe("Publish freshness messages (RC6 item 6)", () => {
  const OLD = "a".repeat(40);
  const NEW = "b".repeat(40);
  const guard = { taskFolderPath: "/t", scopeFolderPath: "/s", runId: "run-1", verifiedCommitSha: OLD };

  void it("names both commits when the commit changed during the review", () => {
    const msg = describePublishPromotionGuardFailureV1(guard, {
      status: "staleCommit",
      stamp: { verifiedCommitSha: OLD, runId: "run-1" },
      currentCommitSha: NEW,
    } as never);
    assert.match(msg, /commit changed from aaaaaaaaaaaa to bbbbbbbbbbbb/);
  });

  void it("says a new Publish Checks run finished when the commit is unchanged", () => {
    const msg = describePublishPromotionGuardFailureV1(guard, {
      status: "valid",
      stamp: { verifiedCommitSha: OLD, runId: "run-2" },
    } as never);
    assert.match(msg, /A new Publish Checks run finished/);
    assert.doesNotMatch(msg, /commit changed/);
  });

  void it("the entry-gate staleCommit text names the stamped and the current commit", () => {
    const msg = describePublishChecksFreshnessFailureV1({
      status: "staleCommit",
      stamp: { verifiedCommitSha: OLD, runId: "run-1" },
      currentCommitSha: NEW,
    } as never);
    assert.match(msg, /aaaaaaaaaaaa/);
    assert.match(msg, /bbbbbbbbbbbb/);
  });
});

void describe("Publish entry gate (RC6 item 6, Step 13)", () => {
  void it("a stamp verified against the previous HEAD classifies as staleCommit", () => {
    const scope = "/repo";
    const check = classifyPublishChecksFreshnessV1(
      { scopeId: computePublishScopeId(scope), verifiedCommitSha: "a".repeat(40), runId: "r" } as never,
      scope,
      "b".repeat(40)
    );
    assert.equal(check.status, "staleCommit");
  });

  void it("review dispatch runs the entry gate before checks and again right before the provider call", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "src", "commands", "reviewActions.ts"), "utf8");
    const calls = [...src.matchAll(/await requirePublishChecksFreshnessOrWarnV1\(folderUri, targetStage\)/g)];
    assert.equal(calls.length, 2);
  });
});

void describe("Failed review round settles its operation as failed (RC6 item 6, Step 15)", () => {
  // Loaded lazily: reviewActions pulls in the vscode stub.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { settleOperationFailedForRoundOutcomeV1 } = require("../commands/reviewActions") as typeof import("../commands/reviewActions");

  void it("settles as failed with the reason for a failed round outcome", () => {
    const calls: Array<[string, string | undefined]> = [];
    const op = { settleAs: (s: string, r?: string) => calls.push([s, r]) };
    settleOperationFailedForRoundOutcomeV1(op as never, {
      kind: "failed",
      code: "publishChecksChanged",
      detail: "The commit changed from a to b",
      retryable: false,
    } as never);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]![0], "failed");
    assert.match(calls[0]![1] ?? "", /publishChecksChanged/);
  });

  void it("does not settle for a successful outcome or a missing operation", () => {
    const calls: unknown[] = [];
    const op = { settleAs: (...a: unknown[]) => calls.push(a) };
    settleOperationFailedForRoundOutcomeV1(op as never, { kind: "applied" } as never);
    settleOperationFailedForRoundOutcomeV1(undefined, { kind: "failed", code: "x" } as never);
    assert.equal(calls.length, 0);
  });

  void it("settles as failed with promotion guard reason when promotion guard throws", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { ReviewPromotionErrorV1, describePublishPromotionGuardFailureV1 } = require("../actions/rows/reviewRowV1") as typeof import("../actions/rows/reviewRowV1");
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { promotionFailureCodeV1 } = require("../actions/taskActionCoordinatorV1") as typeof import("../actions/taskActionCoordinatorV1");

    const guard = {
      taskFolderPath: "/fake/task",
      scopeFolderPath: "/fake/scope",
      runId: "run-1",
      verifiedCommitSha: "1111111111111111111111111111111111111111",
    };
    const message = describePublishPromotionGuardFailureV1(guard, {
      status: "staleCommit",
      stamp: { verifiedCommitSha: guard.verifiedCommitSha, runId: guard.runId } as never,
      currentCommitSha: "2222222222222222222222222222222222222222",
    });
    const error = new ReviewPromotionErrorV1(message);
    const outcome = {
      kind: "failed" as const,
      code: promotionFailureCodeV1(error.message),
      retryable: false,
    };

    const calls: Array<[string, string | undefined]> = [];
    const op = { settleAs: (s: string, r?: string) => calls.push([s, r]) };
    settleOperationFailedForRoundOutcomeV1(op as never, outcome as never);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]![0], "failed");
    assert.match(calls[0]![1] ?? "", /The commit changed from 111111111111 to 222222222222/);
  });
});

void describe("releaseTrackedHandleV1 delegating handle (RC6 item 5)", () => {
  void it("type-checks as WorkAdmissionHandleV1 and handover delegates to handle without releasing", async () => {
    let handoverCalled = 0;
    let releaseCalled = 0;
    const fakeHandle: WorkAdmissionHandleV1 = {
      ownerToken: "token-1",
      claimId: "claim-1",
      taskFolderPath: "/task",
      commandId: "runLintingFixes",
      purpose: "admission",
      heartbeat: () => Promise.resolve(),
      handover: () => {
        handoverCalled++;
        return Promise.resolve();
      },
      release: () => {
        releaseCalled++;
        return Promise.resolve();
      },
    };
    let markerRemoved = false;
    const tracked = createReleaseTrackedHandleV1(
      () => fakeHandle,
      () => {
        markerRemoved = true;
      }
    );
    assert.ok(tracked, "the delegating handle must be returned when handle is present");
    await tracked.handover();
    assert.equal(handoverCalled, 1);
    assert.equal(releaseCalled, 0);
    assert.equal(markerRemoved, false);
    await tracked.release();
    assert.equal(releaseCalled, 1);
    assert.equal(markerRemoved, true);
  });
});

void describe("Publish review follow-up after fix (RC6 item 5, Steps 10-12)", () => {
  before(() => {
    initNotificationRouter({ addEntry: () => undefined });
  });
  after(() => {
    deactivateNotificationRouter();
  });

  function installFakeExtensionContextV1(): () => void {
    const values = new Map<string, unknown>();
    const memento = {
      get<T>(key: string, defaultValue: T): T {
        return (values.has(key) ? values.get(key) : defaultValue) as T;
      },
      update(key: string, value: unknown): Promise<void> {
        if (value === undefined) {
          values.delete(key);
        } else {
          values.set(key, value);
        }
        return Promise.resolve();
      },
      keys(): readonly string[] {
        return [...values.keys()];
      },
    } as unknown as vscode.Memento;
    __extensionContextV1TestOnly.set({ workspaceState: memento } as unknown as vscode.ExtensionContext);
    return () => __extensionContextV1TestOnly.reset();
  }

  function makeFakeProcess(pid: number): RecordedProviderProcessV1 {
    return {
      pid,
      processStartTime: Date.parse("2026-01-01T00:00:00.000Z"),
      providerId: "codex",
      providerLabel: "Codex CLI",
      command: "codex exec --json <prompt omitted>",
      recordedAt: Date.parse("2026-01-01T00:00:00.000Z"),
    };
  }

  function createTempTaskFolder(initialPublishReviewContent?: string): {
    taskFolderUri: vscode.Uri;
    dir: string;
    cleanup: () => void;
  } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc6-publish-test-"));
    if (initialPublishReviewContent !== undefined) {
      fs.writeFileSync(path.join(dir, "publish-review.md"), initialPublishReviewContent, "utf8");
    }
    return {
      taskFolderUri: vscode.Uri.file(dir),
      dir,
      cleanup: () => {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      },
    };
  }

  function createFakeHandle(overrides?: Partial<WorkAdmissionHandleV1>): WorkAdmissionHandleV1 {
    return {
      ownerToken: "test-token",
      claimId: "test-claim",
      taskFolderPath: "/fake/task",
      commandId: "runLintingFixes",
      purpose: "admission",
      heartbeat: () => Promise.resolve(),
      handover: () => Promise.resolve(),
      release: () => Promise.resolve(),
      ...overrides,
    };
  }

  // 1. Banner written at fix start
  void it("the banner is written at fix start with exact text and byte-identical managed sections", async () => {
    const stamp =
      "<!-- publish-checks-freshness:start -->\n" +
      "<!-- Machine-readable freshness stamp — do not edit by hand. -->\n" +
      "<!-- format-version: 1 -->\n" +
      "<!-- run-id: run-test-123 -->\n" +
      "<!-- verified-commit: 1111111111111111111111111111111111111111 -->\n" +
      "<!-- completed-at: 2026-10-02T00:00:00.000Z -->\n" +
      "<!-- scope-id: scope123 -->\n" +
      "<!-- publish-checks-freshness:end -->";
    const statusLine =
      "<!-- publish-status-line:start -->\n" +
      "> ⚠ Publish Checks failed (see Completion Checks below for failing commands and logs).\n" +
      "<!-- publish-status-line:end -->";
    const managedSections =
      "<!-- completion-checks:start -->\n" +
      "### Completion Checks\n" +
      "- pnpm run check-types: passed\n" +
      "- pnpm run lint: failed\n" +
      "<!-- completion-checks:end -->";
    const initialContent =
      `Readiness: 6/10\n\n` +
      `Needs changes.\n\n` +
      `${stamp}\n\n` +
      `${statusLine}\n\n` +
      `${managedSections}\n`;

    const { taskFolderUri, dir, cleanup } = createTempTaskFolder(initialContent);
    try {
      const startIso = "2026-10-03T12:34:56.789Z";
      await markPublishReviewStaleV1(
        taskFolderUri,
        "workspace files (Fix Linting & Code Errors)",
        startIso
      );

      const content = fs.readFileSync(path.join(dir, "publish-review.md"), "utf8");
      assert.ok(isStaleReviewArtifactV1(content));
      const expectedBanner = `> ⚠ Stale: superseded by an update to workspace files (Fix Linting & Code Errors) at ${startIso}.`;
      assert.ok(content.includes(expectedBanner));

      const lines = content.split("\n");
      assert.equal(lines[0], "Readiness: 6/10");
      assert.equal(lines[1], expectedBanner);

      assert.ok(content.includes(stamp), "freshness stamp must be byte-identical");
      assert.ok(content.includes(statusLine), "status line must be byte-identical");
      assert.ok(content.includes(managedSections), "managed checks sections must be byte-identical");
    } finally {
      cleanup();
    }
  });

  // 2. Standalone deterministic success
  void it("standalone deterministic success schedules chained command once after fake handle release resolves", async () => {
    let releaseResolved = false;
    let scheduledAfterRelease = false;
    const fakeHandle = createFakeHandle({
      release: () => {
        releaseResolved = true;
        return Promise.resolve();
      },
    });
    const scheduledCalls: Array<{ dispatch: AutomationDispatch; rootOp?: unknown }> = [];
    const coordinator = createPublishFixReleaseCoordinatorV1({
      getTaskFolderUri: () => vscode.Uri.file("/workspace/task-1"),
      getLockKey: () => "/workspace/task-1",
      getHandle: () => fakeHandle,
      onAdmissionHeld: () => undefined,
      onAdmissionReleased: () => undefined,
      safeReleaseState: createSafeAdmissionReleaseStateV1(),
      getFinalChecks: () => ({ passed: true, failedChecks: [] }),
      getFixSucceeded: () => true,
      rootOperationIdFor: () => undefined,
      scheduleChain: (dispatch, rootOp) => {
        scheduledAfterRelease = releaseResolved;
        scheduledCalls.push({ dispatch, rootOp });
        return Promise.resolve(true);
      },
    });

    await coordinator.finishPublishFix();

    assert.equal(scheduledCalls.length, 1);
    assert.equal(scheduledCalls[0]!.dispatch.command, CHECK_AND_REVIEW_PUBLISH_COMMAND_ID_V1);
    assert.deepEqual(scheduledCalls[0]!.dispatch.arg, { taskFolderPath: "/workspace/task-1" });
    assert.equal(scheduledCalls[0]!.rootOp, undefined);
    assert.equal(scheduledAfterRelease, true, "chain must be scheduled after fake handle release resolves");
    assert.equal(coordinator.isMarkerRemoved(), true, "marker must be marked removed so command is admitted");
  });

  // 3. Standalone AI success
  void it("standalone AI success schedules chained command once only after release resolves", async () => {
    let releaseResolved = false;
    let scheduledAfterRelease = false;
    const fakeHandle = createFakeHandle({
      release: () => {
        releaseResolved = true;
        return Promise.resolve();
      },
    });
    const scheduledCalls: Array<{ dispatch: AutomationDispatch; rootOp?: unknown }> = [];
    const coordinator = createPublishFixReleaseCoordinatorV1({
      getTaskFolderUri: () => vscode.Uri.file("/workspace/task-ai"),
      getLockKey: () => "/workspace/task-ai",
      getHandle: () => fakeHandle,
      onAdmissionHeld: () => undefined,
      onAdmissionReleased: () => undefined,
      safeReleaseState: createSafeAdmissionReleaseStateV1(),
      getFinalChecks: () => ({ passed: true, failedChecks: [] }),
      getFixSucceeded: () => true,
      rootOperationIdFor: () => undefined,
      scheduleChain: (dispatch, rootOp) => {
        scheduledAfterRelease = releaseResolved;
        scheduledCalls.push({ dispatch, rootOp });
        return Promise.resolve(true);
      },
    });

    await coordinator.finishPublishFix();

    assert.equal(scheduledCalls.length, 1);
    assert.equal(scheduledAfterRelease, true);
    assert.equal(coordinator.isMarkerRemoved(), true);
  });

  // 4. Successful fix holding no admission handle
  void it("successful fix holding no admission handle schedules chained command once from finally", async () => {
    const scheduledCalls: Array<{ dispatch: AutomationDispatch; rootOp?: unknown }> = [];
    const coordinator = createPublishFixReleaseCoordinatorV1({
      getTaskFolderUri: () => vscode.Uri.file("/workspace/task-no-handle"),
      getLockKey: () => "/workspace/task-no-handle",
      getHandle: () => undefined,
      onAdmissionHeld: () => undefined,
      onAdmissionReleased: () => undefined,
      safeReleaseState: createSafeAdmissionReleaseStateV1(),
      getFinalChecks: () => ({ passed: true, failedChecks: [] }),
      getFixSucceeded: () => true,
      scheduleChain: (dispatch, rootOp) => {
        scheduledCalls.push({ dispatch, rootOp });
        return Promise.resolve(true);
      },
    });

    await coordinator.finishPublishFix();

    assert.equal(coordinator.isMarkerRemoved(), true);
    assert.equal(coordinator.isPublishReviewScheduled(), true);
    assert.equal(scheduledCalls.length, 1);
    assert.deepEqual(scheduledCalls[0]!.dispatch.arg, { taskFolderPath: "/workspace/task-no-handle" });
  });

  // 5. Nested success deferred follow-up
  void it("nested success passes { id: <root id> } and dispatchEvenIfRootFails: true without awaiting", async () => {
    const scheduledCalls: Array<{ dispatch: AutomationDispatch; rootOp?: { id: string } }> = [];
    const infoMessages: string[] = [];
    let chainPromiseAwaited = false;
    const fakeHandle = createFakeHandle();

    const coordinator = createPublishFixReleaseCoordinatorV1({
      getTaskFolderUri: () => vscode.Uri.file("/workspace/task-nested"),
      getLockKey: () => "/workspace/task-nested",
      getHandle: () => fakeHandle,
      onAdmissionHeld: () => undefined,
      onAdmissionReleased: () => undefined,
      safeReleaseState: createSafeAdmissionReleaseStateV1(),
      getFinalChecks: () => ({ passed: true, failedChecks: [] }),
      getFixSucceeded: () => true,
      rootOperationIdFor: () => "parent-root-op-123",
      showInformation: (msg) => infoMessages.push(msg),
      scheduleChain: (dispatch, rootOp) => {
        scheduledCalls.push({ dispatch, rootOp: rootOp as { id: string } });
        return new Promise<boolean>((resolve) => {
          setTimeout(() => {
            chainPromiseAwaited = true;
            resolve(true);
          }, 100);
        });
      },
    });

    await coordinator.finishPublishFix();

    assert.equal(scheduledCalls.length, 1);
    assert.deepEqual(scheduledCalls[0]!.rootOp, { id: "parent-root-op-123" });
    assert.equal(scheduledCalls[0]!.dispatch.dispatchEvenIfRootFails, true);
    assert.equal(chainPromiseAwaited, false, "coordinator must not await the chain promise");
    assert.ok(
      infoMessages.includes("The Publish review will run once the commit-and-push flow finishes."),
      "deferred announcement must be shown"
    );
  });

  // 6. Held, then removed by later heartbeat tick
  void it("held then removed by later heartbeat tick schedules exactly once, never from onAdmissionReleased", async () => {
    const restoreContext = installFakeExtensionContextV1();
    try {
      await beginRoundProcessRecordingV1("/workspace/task-held", "claim-held-1");
      await recordRoundProcessV1("/workspace/task-held", "claim-held-1", makeFakeProcess(5555));

      let scheduledDuringOnAdmissionReleased = false;
      const scheduledCalls: Array<{ dispatch: AutomationDispatch }> = [];
      const notesWritten: string[] = [];
      const infoMessages: string[] = [];
      let releaseResolved = false;
      let scheduledAfterRelease = false;

      const fakeHandle = createFakeHandle({
        claimId: "claim-held-1",
        taskFolderPath: "/workspace/task-held",
        release: () => {
          releaseResolved = true;
          return Promise.resolve();
        },
      });

      const coordinator = createPublishFixReleaseCoordinatorV1({
        getTaskFolderUri: () => vscode.Uri.file("/workspace/task-held"),
        getLockKey: () => "/workspace/task-held",
        getHandle: () => fakeHandle,
        onAdmissionHeld: () => undefined,
        onAdmissionReleased: () => {
          if (scheduledCalls.length > 0) {
            scheduledDuringOnAdmissionReleased = true;
          }
        },
        safeReleaseState: createSafeAdmissionReleaseStateV1(),
        getFinalChecks: () => ({ passed: true, failedChecks: [] }),
        getFixSucceeded: () => true,
        writeNote: (_uri, note) => {
          notesWritten.push(note);
          return Promise.resolve(true);
        },
        showInformation: (msg) => infoMessages.push(msg),
        scheduleChain: (dispatch) => {
          scheduledAfterRelease = releaseResolved;
          scheduledCalls.push({ dispatch });
          return Promise.resolve(true);
        },
      });

      // Attempt 1 in finishPublishFix: unsafe process running
      await coordinator.finishPublishFix({
        classify: () => Promise.resolve("alive" as const),
      });

      assert.equal(coordinator.isPublishReviewScheduled(), false);
      assert.equal(coordinator.isPublishReviewOwed(), true);
      assert.equal(scheduledCalls.length, 0);
      assert.ok(
        notesWritten.some((n) =>
          n.includes(
            "Publish Checks pass after the fix. The Publish review will start once the previous provider process is confirmed stopped."
          )
        )
      );
      assert.ok(
        infoMessages.some((m) =>
          m.includes(
            "Publish Checks pass after the fix. The Publish review will start once the previous provider process is confirmed stopped."
          )
        )
      );

      // Heartbeat tick: safe classification
      await coordinator.heartbeatTick({ classify: () => Promise.resolve("gone" as const) });

      assert.equal(scheduledDuringOnAdmissionReleased, false, "never schedule from inside onAdmissionReleased");
      assert.equal(coordinator.isPublishReviewScheduled(), true);
      assert.equal(coordinator.isPublishReviewOwed(), false);
      assert.equal(scheduledCalls.length, 1);
      assert.equal(scheduledAfterRelease, true);

      // Further tick does not schedule again
      await coordinator.heartbeatTick({ classify: () => Promise.resolve("gone" as const) });
      assert.equal(scheduledCalls.length, 1);
    } finally {
      restoreContext();
    }
  });

  // 7. Overlapping finalizer and heartbeat release with pending release()
  void it("overlapping finalizer and heartbeat release with pending release() schedules once after resolve", async () => {
    // Order A: finalizer starts and awaits release(), tick overlaps
    {
      let resolveRelease!: () => void;
      const releasePromise = new Promise<void>((r) => {
        resolveRelease = r;
      });
      const fakeHandle = createFakeHandle({
        release: () => releasePromise,
      });
      const scheduledCalls: Array<{ dispatch: AutomationDispatch }> = [];
      const coordinator = createPublishFixReleaseCoordinatorV1({
        getTaskFolderUri: () => vscode.Uri.file("/workspace/task-overlap-a"),
        getLockKey: () => "/workspace/task-overlap-a",
        getHandle: () => fakeHandle,
        onAdmissionHeld: () => undefined,
        onAdmissionReleased: () => undefined,
        safeReleaseState: createSafeAdmissionReleaseStateV1(),
        getFinalChecks: () => ({ passed: true, failedChecks: [] }),
        getFixSucceeded: () => true,
        scheduleChain: (dispatch) => {
          scheduledCalls.push({ dispatch });
          return Promise.resolve(true);
        },
      });

      const p1 = coordinator.finishPublishFix();
      await new Promise((r) => setImmediate(r));

      // released is true, but release() is still pending
      const p2 = coordinator.heartbeatTick();
      assert.equal(scheduledCalls.length, 0, "nothing scheduled while release() is pending");

      resolveRelease();
      await p1;
      await p2;
      assert.equal(scheduledCalls.length, 1, "scheduled exactly once when release resolves");
    }

    // Order B: tick starts and awaits release(), finalizer overlaps
    {
      let resolveRelease!: () => void;
      const releasePromise = new Promise<void>((r) => {
        resolveRelease = r;
      });
      const fakeHandle = createFakeHandle({
        release: () => releasePromise,
      });
      const scheduledCalls: Array<{ dispatch: AutomationDispatch }> = [];
      const safeReleaseState = createSafeAdmissionReleaseStateV1();
      safeReleaseState.releaseRequested = true;
      const coordinator = createPublishFixReleaseCoordinatorV1({
        getTaskFolderUri: () => vscode.Uri.file("/workspace/task-overlap-b"),
        getLockKey: () => "/workspace/task-overlap-b",
        getHandle: () => fakeHandle,
        onAdmissionHeld: () => undefined,
        onAdmissionReleased: () => undefined,
        safeReleaseState,
        getFinalChecks: () => ({ passed: true, failedChecks: [] }),
        getFixSucceeded: () => true,
        scheduleChain: (dispatch) => {
          scheduledCalls.push({ dispatch });
          return Promise.resolve(true);
        },
      });

      coordinator.setPublishReviewOwed(true);
      const pTick = coordinator.heartbeatTick();
      await new Promise((r) => setImmediate(r));

      const pFin = coordinator.finishPublishFix();
      assert.equal(scheduledCalls.length, 0);

      resolveRelease();
      await pTick;
      await pFin;
      assert.equal(scheduledCalls.length, 1);
    }

    // Variant: one overlapping release rejects, other resolves -> schedules once with no failure note
    {
      let attempts = 0;
      const notesWritten: string[] = [];
      const fakeHandle = createFakeHandle({
        release: () => {
          attempts++;
          if (attempts === 1) {
            return Promise.reject(new Error("first unlink transient EBUSY"));
          }
          return Promise.resolve();
        },
      });
      const scheduledCalls: Array<{ dispatch: AutomationDispatch }> = [];
      const coordinator = createPublishFixReleaseCoordinatorV1({
        getTaskFolderUri: () => vscode.Uri.file("/workspace/task-overlap-variant"),
        getLockKey: () => "/workspace/task-overlap-variant",
        getHandle: () => fakeHandle,
        onAdmissionHeld: () => undefined,
        onAdmissionReleased: () => undefined,
        safeReleaseState: createSafeAdmissionReleaseStateV1(),
        getFinalChecks: () => ({ passed: true, failedChecks: [] }),
        getFixSucceeded: () => true,
        writeNote: (_uri, note) => {
          notesWritten.push(note);
          return Promise.resolve(true);
        },
        scheduleChain: (dispatch) => {
          scheduledCalls.push({ dispatch });
          return Promise.resolve(true);
        },
      });

      coordinator.setPublishReviewOwed(true);
      const p1 = coordinator.trackReleaseAttempt(async () => {
        await coordinator.releaseTrackedHandle()!.release();
      });
      const p2 = coordinator.trackReleaseAttempt(async () => {
        await coordinator.releaseTrackedHandle()!.release();
      });

      await assert.rejects(p1, /first unlink transient EBUSY/);
      await p2;

      assert.equal(scheduledCalls.length, 1, "resolving attempt must schedule once");
      assert.ok(!notesWritten.some((n) => n.includes("could not be released")), "no failure note when one resolves");
    }
  });

  // 8. Pre-release rejection while another attempt is still deciding
  void it("pre-release rejection while other attempt is still pending concludes nothing then pending attempt schedules once", async () => {
    // 8a: finalizer's safety decision rejects while tick is pending in safety decision
    {
      const restoreContext = installFakeExtensionContextV1();
      try {
        await beginRoundProcessRecordingV1("/workspace/task-prerelease-a", "claim-pre-a");
        await recordRoundProcessV1("/workspace/task-prerelease-a", "claim-pre-a", makeFakeProcess(101));

        let resolveTickSafety!: (val: "gone") => void;
        const tickSafetyPromise = new Promise<"gone">((r) => {
          resolveTickSafety = r;
        });
        let resolveFinSafety!: (err: Error) => void;
        const finSafetyPromise = new Promise<"gone">((_res, rej) => {
          resolveFinSafety = rej;
        });
        const fakeHandle = createFakeHandle({
          claimId: "claim-pre-a",
          taskFolderPath: "/workspace/task-prerelease-a",
        });
        const scheduledCalls: Array<{ dispatch: AutomationDispatch }> = [];
        const warnings: string[] = [];
        const notesWritten: string[] = [];

        const coordinator = createPublishFixReleaseCoordinatorV1({
          getTaskFolderUri: () => vscode.Uri.file("/workspace/task-prerelease-a"),
          getLockKey: () => "/workspace/task-prerelease-a",
          getHandle: () => fakeHandle,
          onAdmissionHeld: () => undefined,
          onAdmissionReleased: () => undefined,
          safeReleaseState: createSafeAdmissionReleaseStateV1(),
          getFinalChecks: () => ({ passed: true, failedChecks: [] }),
          getFixSucceeded: () => true,
          showWarning: (w) => warnings.push(w),
          writeNote: (_uri, note) => {
            notesWritten.push(note);
            return Promise.resolve(true);
          },
          scheduleChain: (dispatch) => {
            scheduledCalls.push({ dispatch });
            return Promise.resolve(true);
          },
        });

        const pFin = coordinator.finishPublishFix({
          classify: () => finSafetyPromise,
        });
        await new Promise((r) => setImmediate(r));

        const pTick = coordinator.heartbeatTick({ classify: () => tickSafetyPromise });
        await new Promise((r) => setImmediate(r));

        resolveFinSafety(new Error("probe failure 1"));
        await assert.rejects(pFin, /probe failure 1/);

        assert.equal(coordinator.isPublishReviewOwed(), true, "review must still be owed while tick is in flight");
        assert.equal(coordinator.isReleaseFailed(), false);
        assert.equal(warnings.length, 0);
        assert.ok(!notesWritten.some((n) => n.includes("could not be released")));

        resolveTickSafety("gone");
        await pTick;

        assert.equal(coordinator.isPublishReviewScheduled(), true);
        assert.equal(scheduledCalls.length, 1);
        assert.ok(!notesWritten.some((n) => n.includes("could not be released")));
      } finally {
        restoreContext();
      }
    }

    // 8b: tick's safety decision rejects while finalizer is pending
    {
      const restoreContext = installFakeExtensionContextV1();
      try {
        await beginRoundProcessRecordingV1("/workspace/task-prerelease-b", "claim-pre-b");
        await recordRoundProcessV1("/workspace/task-prerelease-b", "claim-pre-b", makeFakeProcess(102));

        let resolveFinSafety!: (val: "gone") => void;
        const finSafetyPromise = new Promise<"gone">((r) => {
          resolveFinSafety = r;
        });
        const fakeHandle = createFakeHandle({
          claimId: "claim-pre-b",
          taskFolderPath: "/workspace/task-prerelease-b",
        });
        const scheduledCalls: Array<{ dispatch: AutomationDispatch }> = [];
        const warnings: string[] = [];

        const coordinator = createPublishFixReleaseCoordinatorV1({
          getTaskFolderUri: () => vscode.Uri.file("/workspace/task-prerelease-b"),
          getLockKey: () => "/workspace/task-prerelease-b",
          getHandle: () => fakeHandle,
          onAdmissionHeld: () => undefined,
          onAdmissionReleased: () => undefined,
          safeReleaseState: createSafeAdmissionReleaseStateV1(),
          getFinalChecks: () => ({ passed: true, failedChecks: [] }),
          getFixSucceeded: () => true,
          showWarning: (w) => warnings.push(w),
          scheduleChain: (dispatch) => {
            scheduledCalls.push({ dispatch });
            return Promise.resolve(true);
          },
        });

        const pFin = coordinator.finishPublishFix({ classify: () => finSafetyPromise });
        await new Promise((r) => setImmediate(r));

        const pTick = coordinator.heartbeatTick({
          classify: () => Promise.reject(new Error("tick probe failure")),
        });
        await assert.rejects(pTick, /tick probe failure/);

        assert.equal(coordinator.isPublishReviewOwed(), true);
        assert.equal(coordinator.isReleaseFailed(), false);
        assert.equal(warnings.length, 0);

        resolveFinSafety("gone");
        await pFin;

        assert.equal(coordinator.isPublishReviewScheduled(), true);
        assert.equal(scheduledCalls.length, 1);
      } finally {
        restoreContext();
      }
    }

    // 8c: pre-release clearHeldAdmissionReason rejection while other attempt is pending
    {
      let resolvePendingAttempt!: () => void;
      const pendingPromise = new Promise<void>((r) => {
        resolvePendingAttempt = r;
      });
      const fakeHandle = createFakeHandle();
      const scheduledCalls: Array<{ dispatch: AutomationDispatch }> = [];

      const coordinator = createPublishFixReleaseCoordinatorV1({
        getTaskFolderUri: () => vscode.Uri.file("/workspace/task-prerelease-c"),
        getLockKey: () => "/workspace/task-prerelease-c",
        getHandle: () => fakeHandle,
        onAdmissionHeld: () => undefined,
        onAdmissionReleased: () => undefined,
        safeReleaseState: createSafeAdmissionReleaseStateV1(),
        getFinalChecks: () => ({ passed: true, failedChecks: [] }),
        getFixSucceeded: () => true,
        scheduleChain: (dispatch) => {
          scheduledCalls.push({ dispatch });
          return Promise.resolve(true);
        },
      });

      coordinator.setPublishReviewOwed(true);
      const pPending = coordinator.trackReleaseAttempt(() => pendingPromise);
      await new Promise((r) => setImmediate(r));

      const pRejecting = coordinator.trackReleaseAttempt(() =>
        Promise.reject(new Error("clearHeldAdmissionReason failed before release"))
      );
      await assert.rejects(pRejecting, /clearHeldAdmissionReason failed/);

      // Concludes nothing while pPending is running
      assert.equal(coordinator.isPublishReviewOwed(), true);
      assert.equal(scheduledCalls.length, 0);

      resolvePendingAttempt();
      await pPending;
      assert.equal(coordinator.isPublishReviewOwed(), true);
    }

    // 8d: variant where pending attempt then fails terminally
    {
      let resolvePendingAttempt!: (err: Error) => void;
      const pendingPromise = new Promise<void>((_resolve, reject) => {
        resolvePendingAttempt = reject;
      });
      const fakeHandle = createFakeHandle();
      const scheduledCalls: Array<{ dispatch: AutomationDispatch }> = [];
      const notesWritten: string[] = [];
      const safeReleaseState = createSafeAdmissionReleaseStateV1();

      const coordinator = createPublishFixReleaseCoordinatorV1({
        getTaskFolderUri: () => vscode.Uri.file("/workspace/task-prerelease-d"),
        getLockKey: () => "/workspace/task-prerelease-d",
        getHandle: () => fakeHandle,
        onAdmissionHeld: () => undefined,
        onAdmissionReleased: () => undefined,
        safeReleaseState,
        getFinalChecks: () => ({ passed: true, failedChecks: [] }),
        getFixSucceeded: () => true,
        writeNote: (_uri, note) => {
          notesWritten.push(note);
          return Promise.resolve(true);
        },
        scheduleChain: (dispatch) => {
          scheduledCalls.push({ dispatch });
          return Promise.resolve(true);
        },
      });

      coordinator.setPublishReviewOwed(true);
      const pPending = coordinator.trackReleaseAttempt(() => pendingPromise);
      await new Promise((r) => setImmediate(r));

      const pFirst = coordinator.trackReleaseAttempt(() =>
        Promise.reject(new Error("first safety error"))
      );
      await assert.rejects(pFirst, /first safety error/);

      // Mark released so pending failure is terminal
      safeReleaseState.released = true;
      resolvePendingAttempt(new Error("terminal failure"));
      await assert.rejects(pPending, /terminal failure/);

      assert.equal(scheduledCalls.length, 0);
      assert.ok(notesWritten.some((n) => n.includes("could not be released (terminal failure)")));
    }
  });

  // 9. Safety-decision rejection alone
  void it("safety-decision rejection alone records no failure, writes held note, rejects, and later safe tick schedules once", async () => {
    const restoreContext = installFakeExtensionContextV1();
    try {
      await beginRoundProcessRecordingV1("/workspace/task-safety-reject", "claim-safe-reject");
      await recordRoundProcessV1("/workspace/task-safety-reject", "claim-safe-reject", makeFakeProcess(202));

      const fakeHandle = createFakeHandle({
        claimId: "claim-safe-reject",
        taskFolderPath: "/workspace/task-safety-reject",
      });
      const scheduledCalls: Array<{ dispatch: AutomationDispatch }> = [];
      const notesWritten: string[] = [];

      const coordinator = createPublishFixReleaseCoordinatorV1({
        getTaskFolderUri: () => vscode.Uri.file("/workspace/task-safety-reject"),
        getLockKey: () => "/workspace/task-safety-reject",
        getHandle: () => fakeHandle,
        onAdmissionHeld: () => undefined,
        onAdmissionReleased: () => undefined,
        safeReleaseState: createSafeAdmissionReleaseStateV1(),
        getFinalChecks: () => ({ passed: true, failedChecks: [] }),
        getFixSucceeded: () => true,
        writeNote: (_uri, note) => {
          notesWritten.push(note);
          return Promise.resolve(true);
        },
        scheduleChain: (dispatch) => {
          scheduledCalls.push({ dispatch });
          return Promise.resolve(true);
        },
      });

      await assert.rejects(
        () =>
          coordinator.finishPublishFix({
            classify: () => Promise.reject(new Error("safety probe crashed")),
          }),
        /safety probe crashed/
      );

      assert.equal(coordinator.isReleaseFailed(), false, "safety rejection must not record terminal failure");
      assert.equal(coordinator.isPublishReviewOwed(), true);
      assert.equal(scheduledCalls.length, 0);
      assert.ok(
        notesWritten.some((n) =>
          n.includes(
            "Publish Checks pass after the fix. The Publish review will start once the previous provider process is confirmed stopped."
          )
        )
      );

      // Later safe tick schedules review
      await coordinator.heartbeatTick({ classify: () => Promise.resolve("gone" as const) });

      assert.equal(coordinator.isPublishReviewScheduled(), true);
      assert.equal(scheduledCalls.length, 1);
    } finally {
      restoreContext();
    }
  });

  // 10. Finalizer release rejection after released is set
  void it("finalizer release rejection after released is set writes release-failure note and rejects", async () => {
    // 10a: fake release() rejects
    {
      const fakeHandle = createFakeHandle({
        release: () => Promise.reject(new Error("EIO unlink failed")),
      });
      const scheduledCalls: Array<{ dispatch: AutomationDispatch }> = [];
      const notesWritten: string[] = [];
      const warnings: string[] = [];
      const infoMessages: string[] = [];

      const coordinator = createPublishFixReleaseCoordinatorV1({
        getTaskFolderUri: () => vscode.Uri.file("/workspace/task-finalizer-reject-a"),
        getLockKey: () => "/workspace/task-finalizer-reject-a",
        getHandle: () => fakeHandle,
        onAdmissionHeld: () => undefined,
        onAdmissionReleased: () => undefined,
        safeReleaseState: createSafeAdmissionReleaseStateV1(),
        getFinalChecks: () => ({ passed: true, failedChecks: [] }),
        getFixSucceeded: () => true,
        showWarning: (w) => warnings.push(w),
        showInformation: (m) => infoMessages.push(m),
        writeNote: (_uri, note) => {
          notesWritten.push(note);
          return Promise.resolve(true);
        },
        scheduleChain: (dispatch) => {
          scheduledCalls.push({ dispatch });
          return Promise.resolve(true);
        },
      });

      await assert.rejects(
        () => coordinator.finishPublishFix(),
        /EIO unlink failed/
      );

      assert.equal(coordinator.isReleaseFailed(), true);
      assert.equal(coordinator.isPublishReviewScheduled(), false);
      assert.equal(scheduledCalls.length, 0);
      assert.ok(
        notesWritten.some((n) => n.includes("could not be released (EIO unlink failed)")),
        "release failure note must be written"
      );
      assert.ok(
        warnings.some((w) => w.includes("could not be released (EIO unlink failed)")),
        "warning line must be posted"
      );
      assert.ok(!infoMessages.some((m) => m.includes("will start")), "no will start line may be posted");
    }

    // 10b: clearHeldAdmissionReasonV1 rejects after released is set
    {
      const fakeHandle = createFakeHandle();
      const scheduledCalls: Array<{ dispatch: AutomationDispatch }> = [];
      const notesWritten: string[] = [];

      const coordinator = createPublishFixReleaseCoordinatorV1({
        getTaskFolderUri: () => vscode.Uri.file("/workspace/task-finalizer-reject-b"),
        getLockKey: () => "/workspace/task-finalizer-reject-b",
        getHandle: () => fakeHandle,
        onAdmissionHeld: () => undefined,
        onAdmissionReleased: () => undefined,
        safeReleaseState: createSafeAdmissionReleaseStateV1(),
        getFinalChecks: () => ({ passed: true, failedChecks: [] }),
        getFixSucceeded: () => true,
        requestSafeRelease: (state, _handle, _onHeld, onReleased) => {
          state.released = true;
          onReleased();
          return Promise.reject(new Error("clear reason failed"));
        },
        writeNote: (_uri, note) => {
          notesWritten.push(note);
          return Promise.resolve(true);
        },
        scheduleChain: (dispatch) => {
          scheduledCalls.push({ dispatch });
          return Promise.resolve(true);
        },
      });

      await assert.rejects(() => coordinator.finishPublishFix(), /clear reason failed/);

      assert.equal(coordinator.isReleaseFailed(), true);
      assert.equal(scheduledCalls.length, 0);
      assert.ok(notesWritten.some((n) => n.includes("could not be released (clear reason failed)")));
    }
  });

  // 11. Tick release rejection after held first attempt
  void it("tick release rejection after held first attempt replaces held note with release-failure note", async () => {
    // 11a: tick fake release() rejects
    {
      const restoreContext = installFakeExtensionContextV1();
      try {
        await beginRoundProcessRecordingV1("/workspace/task-tick-reject-a", "claim-tick-a");
        await recordRoundProcessV1("/workspace/task-tick-reject-a", "claim-tick-a", makeFakeProcess(303));

        let releaseShouldReject = false;
        const fakeHandle = createFakeHandle({
          claimId: "claim-tick-a",
          taskFolderPath: "/workspace/task-tick-reject-a",
          release: () => {
            if (releaseShouldReject) {
              return Promise.reject(new Error("tick unlink error"));
            }
            return Promise.resolve();
          },
        });
        const scheduledCalls: Array<{ dispatch: AutomationDispatch }> = [];
        const notesWritten: string[] = [];

        const coordinator = createPublishFixReleaseCoordinatorV1({
          getTaskFolderUri: () => vscode.Uri.file("/workspace/task-tick-reject-a"),
          getLockKey: () => "/workspace/task-tick-reject-a",
          getHandle: () => fakeHandle,
          onAdmissionHeld: () => undefined,
          onAdmissionReleased: () => undefined,
          safeReleaseState: createSafeAdmissionReleaseStateV1(),
          getFinalChecks: () => ({ passed: true, failedChecks: [] }),
          getFixSucceeded: () => true,
          writeNote: (_uri, note) => {
            notesWritten.push(note);
            return Promise.resolve(true);
          },
          scheduleChain: (dispatch) => {
            scheduledCalls.push({ dispatch });
            return Promise.resolve(true);
          },
        });

        await coordinator.finishPublishFix({ classify: () => Promise.resolve("alive" as const) });
        assert.ok(
          notesWritten.some((n) =>
            n.includes(
              "Publish review will start once the previous provider process is confirmed stopped"
            )
          )
        );

        releaseShouldReject = true;
        await assert.rejects(
          () => coordinator.heartbeatTick({ classify: () => Promise.resolve("gone" as const) }),
          /tick unlink error/
        );

        assert.equal(coordinator.isReleaseFailed(), true);
        assert.equal(coordinator.isPublishReviewScheduled(), false);
        assert.equal(scheduledCalls.length, 0);
        assert.ok(notesWritten.some((n) => n.includes("could not be released (tick unlink error)")));
      } finally {
        restoreContext();
      }
    }

    // 11b: tick clearHeldAdmissionReasonV1 rejects after released is set
    {
      const fakeHandle = createFakeHandle();
      const notesWritten: string[] = [];
      const safeReleaseState = createSafeAdmissionReleaseStateV1();

      const coordinator = createPublishFixReleaseCoordinatorV1({
        getTaskFolderUri: () => vscode.Uri.file("/workspace/task-tick-reject-b"),
        getLockKey: () => "/workspace/task-tick-reject-b",
        getHandle: () => fakeHandle,
        onAdmissionHeld: () => undefined,
        onAdmissionReleased: () => undefined,
        safeReleaseState,
        getFinalChecks: () => ({ passed: true, failedChecks: [] }),
        getFixSucceeded: () => true,
        trySafeRelease: (state, _handle, _onHeld, onReleased) => {
          state.released = true;
          onReleased();
          return Promise.reject(new Error("tick clear reason failed"));
        },
        writeNote: (_uri, note) => {
          notesWritten.push(note);
          return Promise.resolve(true);
        },
      });

      coordinator.setPublishReviewOwed(true);
      safeReleaseState.releaseRequested = true;

      await assert.rejects(() => coordinator.heartbeatTick(), /tick clear reason failed/);
      assert.equal(coordinator.isReleaseFailed(), true);
      assert.ok(notesWritten.some((n) => n.includes("could not be released (tick clear reason failed)")));
    }
  });

  // 12. Held and never released
  void it("held and never released schedules nothing, leaving held note and banner", async () => {
    const restoreContext = installFakeExtensionContextV1();
    try {
      await beginRoundProcessRecordingV1("/workspace/task-held-never", "claim-held-never");
      await recordRoundProcessV1("/workspace/task-held-never", "claim-held-never", makeFakeProcess(404));

      const fakeHandle = createFakeHandle({
        claimId: "claim-held-never",
        taskFolderPath: "/workspace/task-held-never",
      });
      const scheduledCalls: Array<{ dispatch: AutomationDispatch }> = [];
      const notesWritten: string[] = [];
      const infoMessages: string[] = [];

      const coordinator = createPublishFixReleaseCoordinatorV1({
        getTaskFolderUri: () => vscode.Uri.file("/workspace/task-held-never"),
        getLockKey: () => "/workspace/task-held-never",
        getHandle: () => fakeHandle,
        onAdmissionHeld: () => undefined,
        onAdmissionReleased: () => undefined,
        safeReleaseState: createSafeAdmissionReleaseStateV1(),
        getFinalChecks: () => ({ passed: true, failedChecks: [] }),
        getFixSucceeded: () => true,
        writeNote: (_uri, note) => {
          notesWritten.push(note);
          return Promise.resolve(true);
        },
        showInformation: (m) => infoMessages.push(m),
        scheduleChain: (dispatch) => {
          scheduledCalls.push({ dispatch });
          return Promise.resolve(true);
        },
      });

      await coordinator.finishPublishFix({ classify: () => Promise.resolve("alive" as const) });

      assert.equal(coordinator.isPublishReviewScheduled(), false);
      assert.equal(scheduledCalls.length, 0);
      assert.ok(
        notesWritten.some((n) =>
          n.includes(
            "Publish review will start once the previous provider process is confirmed stopped"
          )
        )
      );
      assert.ok(
        infoMessages.some((m) =>
          m.includes(
            "Publish review will start once the previous provider process is confirmed stopped"
          )
        )
      );
      assert.ok(!infoMessages.some((m) => m.includes("is starting")));
    } finally {
      restoreContext();
    }
  });

  // 13. Duplicate drop
  void it("duplicate drop posts already scheduled line without will run line", () => {
    const infoMessages: string[] = [];
    const coordinator = createPublishFixReleaseCoordinatorV1({
      getTaskFolderUri: () => vscode.Uri.file("/workspace/task-duplicate"),
      getLockKey: () => "/workspace/task-duplicate",
      getHandle: () => createFakeHandle(),
      onAdmissionHeld: () => undefined,
      onAdmissionReleased: () => undefined,
      safeReleaseState: createSafeAdmissionReleaseStateV1(),
      getFinalChecks: () => ({ passed: true, failedChecks: [] }),
      getFixSucceeded: () => true,
      rootOperationIdFor: () => "parent-root-123",
      showInformation: (m) => infoMessages.push(m),
      scheduleChain: (dispatch) => {
        dispatch.onDropped?.("duplicate-chain");
        return Promise.resolve(true);
      },
    });

    coordinator.schedulePublishReviewAfterFixOnce();

    assert.ok(
      infoMessages.includes("A Publish review is already scheduled for this task."),
      "already scheduled notification must be posted"
    );
    assert.ok(
      !infoMessages.some((m) => m.includes("will run once the commit-and-push flow finishes")),
      "will run line must not be posted on duplicate drop"
    );
  });

  // 14. Error after passing lint result
  void it("error after passing lint result resets success and checks, scheduling nothing and leaving banner", async () => {
    const fakeHandle = createFakeHandle();
    const scheduledCalls: Array<{ dispatch: AutomationDispatch }> = [];
    const notesWritten: string[] = [];

    // Simulate catch block behavior: fixSucceeded = false, finalChecks = undefined
    const coordinator = createPublishFixReleaseCoordinatorV1({
      getTaskFolderUri: () => vscode.Uri.file("/workspace/task-error-reset"),
      getLockKey: () => "/workspace/task-error-reset",
      getHandle: () => fakeHandle,
      onAdmissionHeld: () => undefined,
      onAdmissionReleased: () => undefined,
      safeReleaseState: createSafeAdmissionReleaseStateV1(),
      getFinalChecks: () => undefined,
      getFixSucceeded: () => false,
      writeNote: (_uri, note) => {
        notesWritten.push(note);
        return Promise.resolve(true);
      },
      scheduleChain: (dispatch) => {
        scheduledCalls.push({ dispatch });
        return Promise.resolve(true);
      },
    });

    await coordinator.finishPublishFix();

    assert.equal(coordinator.isPublishReviewOwed(), false);
    assert.equal(coordinator.isPublishReviewScheduled(), false);
    assert.equal(scheduledCalls.length, 0);
    assert.equal(notesWritten.length, 0, "no note may be written on error");

    // Later heartbeat tick also schedules nothing
    await coordinator.heartbeatTick();
    assert.equal(scheduledCalls.length, 0);
  });

  // 15. Still-failing fixes
  void it("still-failing fixes write failing-checks note and replace in place", async () => {
    // 15a: AI unavailable
    {
      const notesWritten: string[] = [];
      const scheduledCalls: Array<{ dispatch: AutomationDispatch }> = [];
      const coordinator = createPublishFixReleaseCoordinatorV1({
        getTaskFolderUri: () => vscode.Uri.file("/workspace/task-fail-ai-unavail"),
        getLockKey: () => "/workspace/task-fail-ai-unavail",
        getHandle: () => createFakeHandle(),
        onAdmissionHeld: () => undefined,
        onAdmissionReleased: () => undefined,
        safeReleaseState: createSafeAdmissionReleaseStateV1(),
        getFinalChecks: () => ({ passed: false, failedChecks: [{ command: "pnpm run test:unit" }] }),
        getFixSucceeded: () => false,
        writeNote: (_uri, note) => {
          notesWritten.push(note);
          return Promise.resolve(true);
        },
        scheduleChain: (dispatch) => {
          scheduledCalls.push({ dispatch });
          return Promise.resolve(true);
        },
      });

      await coordinator.finishPublishFix();
      assert.equal(scheduledCalls.length, 0);
      assert.ok(notesWritten.includes("> Publish Checks still fail after the fix: pnpm run test:unit."));
    }

    // 15b: AI completed still failing
    {
      const notesWritten: string[] = [];
      const coordinator = createPublishFixReleaseCoordinatorV1({
        getTaskFolderUri: () => vscode.Uri.file("/workspace/task-fail-ai-completed"),
        getLockKey: () => "/workspace/task-fail-ai-completed",
        getHandle: () => createFakeHandle(),
        onAdmissionHeld: () => undefined,
        onAdmissionReleased: () => undefined,
        safeReleaseState: createSafeAdmissionReleaseStateV1(),
        getFinalChecks: () => ({ passed: false, failedChecks: [{ command: "pnpm run verify" }] }),
        getFixSucceeded: () => false,
        writeNote: (_uri, note) => {
          notesWritten.push(note);
          return Promise.resolve(true);
        },
      });

      await coordinator.finishPublishFix();
      assert.ok(notesWritten.includes("> Publish Checks still fail after the fix: pnpm run verify."));
    }

    // 15c: No automatic fixes available
    {
      const notesWritten: string[] = [];
      const coordinator = createPublishFixReleaseCoordinatorV1({
        getTaskFolderUri: () => vscode.Uri.file("/workspace/task-fail-no-autofix"),
        getLockKey: () => "/workspace/task-fail-no-autofix",
        getHandle: () => createFakeHandle(),
        onAdmissionHeld: () => undefined,
        onAdmissionReleased: () => undefined,
        safeReleaseState: createSafeAdmissionReleaseStateV1(),
        getFinalChecks: () => ({ passed: false, failedChecks: [{ command: "pnpm run lint" }] }),
        getFixSucceeded: () => false,
        writeNote: (_uri, note) => {
          notesWritten.push(note);
          return Promise.resolve(true);
        },
      });

      await coordinator.finishPublishFix();
      assert.ok(notesWritten.includes("> Publish Checks still fail after the fix: pnpm run lint."));
    }

    // 15d: Nested still-failing fix
    {
      const notesWritten: string[] = [];
      const coordinator = createPublishFixReleaseCoordinatorV1({
        getTaskFolderUri: () => vscode.Uri.file("/workspace/task-fail-nested"),
        getLockKey: () => "/workspace/task-fail-nested",
        getHandle: () => createFakeHandle(),
        onAdmissionHeld: () => undefined,
        onAdmissionReleased: () => undefined,
        safeReleaseState: createSafeAdmissionReleaseStateV1(),
        getFinalChecks: () => ({ passed: false, failedChecks: [{ command: "pnpm run test:fast" }] }),
        getFixSucceeded: () => false,
        rootOperationIdFor: () => "parent-op",
        writeNote: (_uri, note) => {
          notesWritten.push(note);
          return Promise.resolve(true);
        },
      });

      await coordinator.finishPublishFix();
      assert.ok(notesWritten.includes("> Publish Checks still fail after the fix: pnpm run test:fast."));
    }

    // Replace note in place on subsequent failing fix
    {
      const initial =
        "Readiness: 6/10\n" +
        "> ⚠ Stale: superseded by an update to workspace files (Fix Linting & Code Errors) at 2026-10-02T04:00:00.000Z.\n" +
        "> Publish Checks still fail after the fix: pnpm run test.\n\n" +
        "Needs changes.\n";
      const { taskFolderUri, dir, cleanup } = createTempTaskFolder(initial);
      try {
        await writePublishFixNoteV1(taskFolderUri, "> Publish Checks still fail after the fix: pnpm run lint.");
        const content = fs.readFileSync(path.join(dir, "publish-review.md"), "utf8");
        assert.ok(content.includes("> Publish Checks still fail after the fix: pnpm run lint."));
        assert.ok(!content.includes("pnpm run test"));
        assert.equal(content.split("Publish Checks still fail").length - 1, 1, "must replace in place, not duplicate");
      } finally {
        cleanup();
      }
    }
  });
});

void describe("RC6 item 5: nested fix does not acquire a second admission", () => {
  void it("runLintingFixes skips admission acquisition when a parent operation holds it", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "src", "commands", "runLintingFixes.ts"), "utf8");
    assert.match(src, /const parentHoldsAdmissionV1 = parentOperation !== undefined;/);
    assert.match(src, /earlyFolderPath && !parentHoldsAdmissionV1/);
    assert.match(src, /if \(!handle && !parentHoldsAdmissionV1\)/);
  });

  void it("a nested fix records its provider process against the parent's claim", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "src", "commands", "runLintingFixes.ts"), "utf8");
    assert.match(src, /heldAdmissionClaimIdForTaskV1\(lockKey\)/);
  });

  void it("a zero-fix deterministic ending is not recorded as a success", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "src", "commands", "runLintingFixes.ts"), "utf8");
    assert.match(src, /if \(postFixLint\.passed && fixedCount > 0\) \{\s*fixSucceededV1 = true;/);
  });
});


