/**
 * Regression coverage for Step 18: recovering from a rejected implementation
 * round.
 *
 * When an implementation round fails the summary shape gate
 * (executeImplementationRun in reviewActions.ts), two durable writes happen:
 * impl-summary.md is replaced with the IMPLEMENTATION_SUMMARY_UNUSABLE_MARKER_V1
 * stamp (the good prior summary survives as impl-summary_prev.md), and the
 * review artifact for the task's review stage is staled to a "# Review Stale"
 * placeholder (the real review survives as its own _prev backup).
 *
 * Two things must hold in that state:
 *  - Fast Forward Review's "no usable review to start from" message must name
 *    the actual cause (a rejected round left no usable summary) rather than
 *    telling the user to re-run the review or hand-edit a Readiness line —
 *    both of which are dead ends while the summary is still stamped.
 *  - A recovery action must be able to restore both `_prev` backups over the
 *    stamped/staled current files, returning the task to its pre-rejection
 *    state in one step.
 */
import * as assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  describeUnusableReviewBlockV1,
  registerReviewActionCommands,
  restoreRejectedImplementationRoundV1,
} from "../commands/reviewActions";
import {
  buildUnusableImplementationSummaryV1,
  getCanonicalImplementationUri,
  getImplementationSummaryUri,
  hasOfferableRunImplementationForUnusableSummaryV1,
  shouldOfferRunImplementationForUnusableSummaryV1,
} from "../utils/implementationArtifactResolver";
import { previousVersionUri } from "../utils/artifactBackups";

const FOLDER = vscode.Uri.file("/tasks/2026-08-13_restore-rejected-round");
const REVIEW_URI = vscode.Uri.joinPath(FOLDER, "impl-low-review.md");

const STALE_PLACEHOLDER = [
  "# Review Stale",
  "",
  "This review was generated before workspace files was updated.",
  "",
  "Run Review with AI again to evaluate the current artifact.",
  "",
].join("\n");

const REAL_REVIEW = "Readiness: 8/10\n\n- Looks solid, ship it.\n";
const REAL_SUMMARY = "## Files Changed\n\n- `src/a.ts` — did a thing\n\n## Verification\n\n- tests pass\n";

// v1 fixes 2, item 1 completion blocker (2026-09-18 review): a plan-final.md
// whose checklist is fully settled (every item checked, nothing remaining) —
// used to prove the unusable-summary refusal never recommends rerunning
// implementation once there is provably nothing left for a round to change.
const IMPLEMENTATION_CHECKLIST_MARKER = "<!-- ensemble:implementation-checklist -->";
const FULLY_SETTLED_PLAN = `# Implementation Checklist\n\n${IMPLEMENTATION_CHECKLIST_MARKER}\n\n- [x] Step one\n- [x] Step two\n`;

// ---------------------------------------------------------------------------
// In-memory vscode.workspace.fs, so these tests never touch real disk.
// Mirrors the pattern in implementationSummaryArtifact.test.ts.
// ---------------------------------------------------------------------------

function installMemStore(seed: Record<string, string> = {}): {
  store: Map<string, string>;
  restore: () => void;
} {
  const fsApi = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = {
    readFile: fsApi.readFile,
    writeFile: fsApi.writeFile,
  };
  const store = new Map<string, string>(Object.entries(seed));

  fsApi.readFile = (uri: vscode.Uri): Promise<Uint8Array> => {
    const content = store.get(uri.toString());
    if (content === undefined) {
      return Promise.reject(new Error(`ENOENT: ${uri.toString()}`));
    }
    return Promise.resolve(new TextEncoder().encode(content));
  };
  fsApi.writeFile = (uri: vscode.Uri, data: Uint8Array): Promise<void> => {
    store.set(uri.toString(), new TextDecoder().decode(data));
    return Promise.resolve();
  };

  return {
    store,
    restore: (): void => {
      fsApi.readFile = orig.readFile;
      fsApi.writeFile = orig.writeFile;
    },
  };
}

function seed(files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [uri, content] of Object.entries(files)) {
    out[uri] = content;
  }
  return out;
}

/* eslint-disable @typescript-eslint/no-var-requires */
const notificationRouterModule = require("../utils/notificationRouter") as {
  NotificationRouter: {
    showWarning: (...args: unknown[]) => void;
    showInformation: (...args: unknown[]) => void;
  };
};
/* eslint-enable @typescript-eslint/no-var-requires */

function captureNotifications(): { messages: string[]; restore: () => void } {
  const messages: string[] = [];
  const origWarning = notificationRouterModule.NotificationRouter.showWarning;
  const origInformation = notificationRouterModule.NotificationRouter.showInformation;
  notificationRouterModule.NotificationRouter.showWarning = (message: unknown) => {
    messages.push(String(message));
  };
  notificationRouterModule.NotificationRouter.showInformation = (message: unknown) => {
    messages.push(String(message));
  };
  return {
    messages,
    restore: (): void => {
      notificationRouterModule.NotificationRouter.showWarning = origWarning;
      notificationRouterModule.NotificationRouter.showInformation = origInformation;
    },
  };
}

let activeStore: { restore: () => void } | undefined;
let activeNotifications: { restore: () => void } | undefined;
afterEach(() => {
  activeStore?.restore();
  activeStore = undefined;
  activeNotifications?.restore();
  activeNotifications = undefined;
});

void describe("describeUnusableReviewBlockV1", () => {
  void it(
    "names the rejected-round cause and offers no restore action when there is no usable _prev backup",
    async () => {
      const stamped = buildUnusableImplementationSummaryV1(
        "the final response is missing Verification",
        "run-log-2026-08-13.md"
      );
      const mem = installMemStore(
        seed({ [getImplementationSummaryUri(FOLDER).toString()]: stamped })
      );
      activeStore = mem;

      const { warning, canRestorePreviousImplSummary, offerRunImplementation } = await describeUnusableReviewBlockV1(
        FOLDER,
        "impl-low-review"
      );

      assert.match(warning, /prior implementation round was rejected/);
      assert.match(warning, /Rerun the implementation/);
      assert.match(warning, /Apply Review Changes/);
      // Must NOT suggest the dead-end recovery: re-running the review or
      // hand-editing a Readiness line cannot work while the summary is stamped.
      assert.doesNotMatch(warning, /Readiness: N\/10/);
      assert.doesNotMatch(warning, /run the review again/i);
      assert.equal(canRestorePreviousImplSummary, false);
      // Part 4 Step 12 (item 16): nothing is restorable and no task-progress.json
      // (hence no live implRecovery) exists here, so "Run Implementation" must be
      // offered — this is the exact deadlock the register recorded.
      assert.equal(offerRunImplementation, true);
    }
  );

  void it(
    "offers no 'Run Implementation' action when a continuation is already armed (implRecovery is live) — " +
      "Part 4 Step 12, item 16",
    async () => {
      const stamped = buildUnusableImplementationSummaryV1(
        "the final response is missing Verification",
        "run-log-2026-08-13.md"
      );
      const liveRecoveryProgress = JSON.stringify({
        taskFolder: "2026-08-13_restore-rejected-round",
        currentStage: "impl-low-review",
        status: "active",
        createdAt: "2026-08-13T00:00:00.000Z",
        updatedAt: "2026-08-13T00:00:00.000Z",
        implRecovery: {
          trigger: "roundIncomplete",
          reason: "the last implementation round ended without a complete report",
          sourceAttemptId: "attempt-1",
          dispatch: "pending",
          mode: "unconstrained",
          at: "2026-08-13T00:00:00.000Z",
        },
      });
      const mem = installMemStore(
        seed({
          [getImplementationSummaryUri(FOLDER).toString()]: stamped,
          [vscode.Uri.joinPath(FOLDER, "task-progress.json").toString()]: liveRecoveryProgress,
        })
      );
      activeStore = mem;

      const { canRestorePreviousImplSummary, offerRunImplementation } = await describeUnusableReviewBlockV1(
        FOLDER,
        "impl-low-review"
      );

      assert.equal(canRestorePreviousImplSummary, false);
      assert.equal(offerRunImplementation, false);
    }
  );

  void it(
    "reports canRestorePreviousImplSummary and wording for 'Restore the last usable summary' when " +
      "impl-summary_prev.md is usable (v1 fixes 2, item 1 — Fast Forward is the third unusable-summary " +
      "refusal surface, alongside runReviewForFolder and buildReviewResumeVariablesV1, that must offer the " +
      "restore action; the caller — fastForwardReviewWithAI — builds the literal actionCommand from this " +
      "flag so the workflow-safety toast-allowlist verifier's static scan can see the dispatched command " +
      "directly in the NotificationRouter.showWarning call, not behind an opaque variable)",
    async () => {
      const stamped = buildUnusableImplementationSummaryV1(
        "the final response is missing Verification",
        "run-log-2026-08-13.md"
      );
      const summaryUri = getImplementationSummaryUri(FOLDER);
      const mem = installMemStore(
        seed({
          [summaryUri.toString()]: stamped,
          [previousVersionUri(summaryUri).toString()]: REAL_SUMMARY,
        })
      );
      activeStore = mem;

      const { warning, canRestorePreviousImplSummary, offerRunImplementation } = await describeUnusableReviewBlockV1(
        FOLDER,
        "impl-low-review"
      );

      assert.match(warning, /Restore the last usable summary/);
      assert.doesNotMatch(warning, /^Rerun the implementation/m);
      assert.equal(canRestorePreviousImplSummary, true);
      // offerRunImplementation is independent of restorability (2026-09-24
      // review, narrowed completion blocker: this field used to be ANDed
      // with `!canRestorePreviousImplSummary`, suppressing it whenever a
      // backup existed — narrower than the checked item's own applicability
      // condition, which names only the live-implRecovery exclusion). The
      // caller attaches Run Implementation as the toast's one action button
      // when this is true, even though Restore is also available; the
      // warning text above still names Restore.
      assert.equal(offerRunImplementation, true);
    }
  );

  void it(
    "reports canRestorePreviousImplSummary: false when no targetStage is supplied, even with a usable _prev " +
      "backup — the caller has nothing to route a restore's rerun back to",
    async () => {
      const stamped = buildUnusableImplementationSummaryV1(
        "the final response is missing Verification",
        "run-log-2026-08-13.md"
      );
      const summaryUri = getImplementationSummaryUri(FOLDER);
      const mem = installMemStore(
        seed({
          [summaryUri.toString()]: stamped,
          [previousVersionUri(summaryUri).toString()]: REAL_SUMMARY,
        })
      );
      activeStore = mem;

      const { canRestorePreviousImplSummary } = await describeUnusableReviewBlockV1(FOLDER);
      assert.equal(canRestorePreviousImplSummary, false);
    }
  );

  void it(
    "never recommends rerunning implementation once the plan's checklist is fully settled, and " +
      "and names the restore action in wording when one is available (v1 fixes 2, item 1 completion blocker)",
    async () => {
      const stamped = buildUnusableImplementationSummaryV1(
        "the final response is missing Verification",
        "run-log-2026-08-13.md"
      );
      const summaryUri = getImplementationSummaryUri(FOLDER);
      const mem = installMemStore(
        seed({
          [summaryUri.toString()]: stamped,
          [previousVersionUri(summaryUri).toString()]: REAL_SUMMARY,
          [getCanonicalImplementationUri(FOLDER).toString()]: FULLY_SETTLED_PLAN,
        })
      );
      activeStore = mem;

      const { warning, canRestorePreviousImplSummary } = await describeUnusableReviewBlockV1(
        FOLDER,
        "impl-low-review"
      );

      assert.equal(canRestorePreviousImplSummary, true);
      assert.match(warning, /Restore the last usable summary/);
      assert.match(warning, /fully settled/);
      assert.doesNotMatch(warning, /rerun the implementation/i);
    }
  );

  void it(
    "still recognises a fully settled plan when checklistProgressUnreliable is latched — the deadlock's " +
      "actual entry state — and never recommends a rerun (v1 fixes 2, item 1 completion blocker)",
    async () => {
      const stamped = buildUnusableImplementationSummaryV1(
        "the final response is missing Verification",
        "run-log-2026-08-13.md"
      );
      const summaryUri = getImplementationSummaryUri(FOLDER);
      const latchedProgress = JSON.stringify({
        taskFolder: "2026-08-13_restore-rejected-round",
        currentStage: "impl-low-review",
        status: "active",
        createdAt: "2026-08-13T00:00:00.000Z",
        updatedAt: "2026-08-13T00:00:00.000Z",
        checklistProgressUnreliable: true,
      });
      const mem = installMemStore(
        seed({
          [summaryUri.toString()]: stamped,
          [previousVersionUri(summaryUri).toString()]: REAL_SUMMARY,
          [getCanonicalImplementationUri(FOLDER).toString()]: FULLY_SETTLED_PLAN,
          [vscode.Uri.joinPath(FOLDER, "task-progress.json").toString()]: latchedProgress,
        })
      );
      activeStore = mem;

      const { warning, canRestorePreviousImplSummary } = await describeUnusableReviewBlockV1(
        FOLDER,
        "impl-low-review"
      );

      assert.equal(canRestorePreviousImplSummary, true);
      assert.match(warning, /Restore the last usable summary/);
      assert.match(warning, /fully settled/);
      assert.doesNotMatch(warning, /rerun the implementation/i);
    }
  );

  void it(
    "still offers Run Implementation when the checklist is fully settled and there is no usable _prev " +
      "backup to restore — the plan's own applicability condition excludes only a LIVE implRecovery, " +
      "never checklist state; a fully-settled checklist only changes the warning TEXT (Part 4 Step 12, " +
      "item 16 completion blocker, 2026-09-24 review)",
    async () => {
      const stamped = buildUnusableImplementationSummaryV1(
        "the final response is missing Verification",
        "run-log-2026-08-13.md"
      );
      const mem = installMemStore(
        seed({
          [getImplementationSummaryUri(FOLDER).toString()]: stamped,
          [getCanonicalImplementationUri(FOLDER).toString()]: FULLY_SETTLED_PLAN,
        })
      );
      activeStore = mem;

      const { warning, canRestorePreviousImplSummary, offerRunImplementation } = await describeUnusableReviewBlockV1(
        FOLDER,
        "impl-low-review"
      );

      assert.equal(canRestorePreviousImplSummary, false);
      assert.match(warning, /fully settled/);
      assert.match(warning, /human decision/);
      assert.doesNotMatch(warning, /rerun the implementation/i);
      // No live implRecovery is armed here, so the button IS offered even
      // though the wording above warns that a rerun may find nothing to
      // change — that judgment is left to the human, not hidden from them.
      assert.equal(offerRunImplementation, true);
    }
  );

  void it("falls back to the generic message when there is no rejection stamp", async () => {
    const mem = installMemStore(
      seed({ [getImplementationSummaryUri(FOLDER).toString()]: REAL_SUMMARY })
    );
    activeStore = mem;

    const { warning, canRestorePreviousImplSummary } = await describeUnusableReviewBlockV1(
      FOLDER,
      "impl-low-review"
    );
    assert.match(warning, /Try running Review manually/);
    assert.equal(canRestorePreviousImplSummary, false);
  });

  void it("falls back to the generic message when impl-summary.md does not exist yet", async () => {
    const mem = installMemStore();
    activeStore = mem;

    const { warning, canRestorePreviousImplSummary } = await describeUnusableReviewBlockV1(
      FOLDER,
      "impl-low-review"
    );
    assert.match(warning, /Try running Review manually/);
    assert.equal(canRestorePreviousImplSummary, false);
  });
});

void describe("restoreRejectedImplementationRoundV1", () => {
  void it("copies both _prev backups back over the stamped summary and staled review", async () => {
    const summaryUri = getImplementationSummaryUri(FOLDER);
    const stamped = buildUnusableImplementationSummaryV1("bad shape", "run-log.md");
    const mem = installMemStore(
      seed({
        [summaryUri.toString()]: stamped,
        [previousVersionUri(summaryUri).toString()]: REAL_SUMMARY,
        [REVIEW_URI.toString()]: STALE_PLACEHOLDER,
        [previousVersionUri(REVIEW_URI).toString()]: REAL_REVIEW,
      })
    );
    activeStore = mem;
    activeNotifications = captureNotifications();

    const restored = await restoreRejectedImplementationRoundV1(FOLDER.fsPath, "impl-low-review");

    assert.equal(restored, true, "a successful restore must report true so a caller can safely rerun");
    assert.equal(mem.store.get(summaryUri.toString()), REAL_SUMMARY);
    assert.equal(mem.store.get(REVIEW_URI.toString()), REAL_REVIEW);
  });

  void it("does nothing and reports 'nothing to restore' when the current summary is not the rejection stamp", async () => {
    const summaryUri = getImplementationSummaryUri(FOLDER);
    const mem = installMemStore(
      seed({
        [summaryUri.toString()]: REAL_SUMMARY,
        [previousVersionUri(summaryUri).toString()]: "some older summary",
        [REVIEW_URI.toString()]: REAL_REVIEW,
      })
    );
    activeStore = mem;
    const notifications = captureNotifications();
    activeNotifications = notifications;

    const restored = await restoreRejectedImplementationRoundV1(FOLDER.fsPath, "impl-low-review");

    // Untouched — restoring here would have clobbered a newer, usable summary.
    assert.equal(restored, false, "a no-op restore must report false so a caller never reruns off of it");
    assert.equal(mem.store.get(summaryUri.toString()), REAL_SUMMARY);
    assert.equal(mem.store.get(REVIEW_URI.toString()), REAL_REVIEW);
    assert.ok(
      notifications.messages.some((m) => /Nothing to restore/.test(m)),
      "must tell the user there was nothing to restore"
    );
  });

  void it("restores the summary even when no review backup exists (plan-only / pre-review task)", async () => {
    const summaryUri = getImplementationSummaryUri(FOLDER);
    const stamped = buildUnusableImplementationSummaryV1("bad shape", "run-log.md");
    const mem = installMemStore(
      seed({
        [summaryUri.toString()]: stamped,
        [previousVersionUri(summaryUri).toString()]: REAL_SUMMARY,
        // No review artifact and no review backup at all.
      })
    );
    activeStore = mem;
    activeNotifications = captureNotifications();

    const restored = await restoreRejectedImplementationRoundV1(FOLDER.fsPath, "impl");

    assert.equal(restored, true);
    assert.equal(mem.store.get(summaryUri.toString()), REAL_SUMMARY);
  });

  void it("reports false (no rerun) when neither the summary nor a review backup can be restored", async () => {
    const summaryUri = getImplementationSummaryUri(FOLDER);
    const stamped = buildUnusableImplementationSummaryV1("bad shape", "run-log.md");
    const mem = installMemStore(
      seed({
        [summaryUri.toString()]: stamped,
        // No _prev backup for the summary, and no review artifact at all.
      })
    );
    activeStore = mem;
    activeNotifications = captureNotifications();

    const restored = await restoreRejectedImplementationRoundV1(FOLDER.fsPath, "impl");

    assert.equal(restored, false);
    assert.equal(mem.store.get(summaryUri.toString()), stamped, "the stamp must survive an impossible restore");
  });
});

/**
 * 2026-09-15 post-freeze findings, item 3 / plan step 24: restoring the last
 * usable summary from the Review/Fast Forward refusal must "rerun admission"
 * — re-enter the refused stage automatically — rather than leaving the user
 * to click Review or Fast Forward again by hand. Driven through the REAL
 * registered "vs-code-ai-helper.restoreRejectedImplementationRound" command
 * (the exact invocation the refusal's notification button makes), with only
 * the rerun target itself faked, so this exercises the actual dispatch glue
 * in registerReviewActionCommands rather than restoreRejectedImplementationRoundV1
 * in isolation.
 */
void describe("restoreRejectedImplementationRound command — rerun-on-success wiring", () => {
  void it("re-invokes the supplied rerun command with {taskFolderPath} after a successful restore", async () => {
    const summaryUri = getImplementationSummaryUri(FOLDER);
    const stamped = buildUnusableImplementationSummaryV1("bad shape", "run-log.md");
    const mem = installMemStore(
      seed({
        [summaryUri.toString()]: stamped,
        [previousVersionUri(summaryUri).toString()]: REAL_SUMMARY,
      })
    );
    activeStore = mem;
    activeNotifications = captureNotifications();

    const fakeContext = {
      subscriptions: [],
      extensionUri: vscode.Uri.file("/fake-extension"),
    } as unknown as vscode.ExtensionContext;
    registerReviewActionCommands(fakeContext);

    const rerunCalls: unknown[] = [];
    vscode.commands.registerCommand("test.spyRerun", (arg: unknown) => {
      rerunCalls.push(arg);
    });

    await vscode.commands.executeCommand(
      "vs-code-ai-helper.restoreRejectedImplementationRound",
      FOLDER.fsPath,
      "impl",
      "test.spyRerun"
    );

    assert.deepEqual(rerunCalls, [{ taskFolderPath: FOLDER.fsPath }]);
  });

  void it("does NOT re-invoke the rerun command when the restore was a no-op", async () => {
    const summaryUri = getImplementationSummaryUri(FOLDER);
    const mem = installMemStore(
      seed({
        // Already a real summary — nothing to restore.
        [summaryUri.toString()]: REAL_SUMMARY,
      })
    );
    activeStore = mem;
    activeNotifications = captureNotifications();

    const fakeContext = {
      subscriptions: [],
      extensionUri: vscode.Uri.file("/fake-extension"),
    } as unknown as vscode.ExtensionContext;
    registerReviewActionCommands(fakeContext);

    const rerunCalls: unknown[] = [];
    vscode.commands.registerCommand("test.spyRerunNoop", () => {
      rerunCalls.push(true);
    });

    await vscode.commands.executeCommand(
      "vs-code-ai-helper.restoreRejectedImplementationRound",
      FOLDER.fsPath,
      "impl",
      "test.spyRerunNoop"
    );

    assert.deepEqual(rerunCalls, []);
  });

  void it("does NOT re-invoke anything when no rerun command id is supplied (the plain 'Discard Last Round' shape)", async () => {
    const summaryUri = getImplementationSummaryUri(FOLDER);
    const stamped = buildUnusableImplementationSummaryV1("bad shape", "run-log.md");
    const mem = installMemStore(
      seed({
        [summaryUri.toString()]: stamped,
        [previousVersionUri(summaryUri).toString()]: REAL_SUMMARY,
      })
    );
    activeStore = mem;
    activeNotifications = captureNotifications();

    const fakeContext = {
      subscriptions: [],
      extensionUri: vscode.Uri.file("/fake-extension"),
    } as unknown as vscode.ExtensionContext;
    registerReviewActionCommands(fakeContext);

    // No third argument — mirrors the "Discard Last Round" decision-card and
    // task-row context-menu invocations, which must keep behaving exactly as
    // before (restore only, never an automatic rerun).
    await vscode.commands.executeCommand(
      "vs-code-ai-helper.restoreRejectedImplementationRound",
      FOLDER.fsPath,
      "impl"
    );

    assert.equal(mem.store.get(summaryUri.toString()), REAL_SUMMARY);
  });
});

/**
 * Part 4 Step 12 (item 16) — the review-stage-ROW half: "Run Implementation"
 * must be offerable straight from the task's context menu AND the review
 * stage's own row, not only from a refusal toast the user has to trigger by
 * pressing Review or Fast Forward first. `shouldOfferRunImplementationForUnusableSummaryV1`
 * is the shared pure predicate both the refusal-toast callers (covered above
 * via `describeUnusableReviewBlockV1`) and both row surfaces
 * (`hasOfferableRunImplementationForUnusableSummaryV1`) resolve through —
 * this pins the shared row gating, and that the function never throws.
 *
 * A 2026-09-24 review flagged an earlier round's task-row wrapper for
 * suppressing the action whenever a restorable `_prev` backup existed
 * ("Restore always takes priority"), which is narrower than the plan's own
 * applicability condition (only a live `implRecovery` excludes it) — that
 * suppression is removed here; Restore and Run Implementation may now be
 * offered together.
 */
void describe("shouldOfferRunImplementationForUnusableSummaryV1", () => {
  void it("is the plain negation of a live implRecovery — no other condition narrows it", () => {
    assert.equal(shouldOfferRunImplementationForUnusableSummaryV1(false), true);
    assert.equal(shouldOfferRunImplementationForUnusableSummaryV1(true), false);
  });
});

void describe("hasOfferableRunImplementationForUnusableSummaryV1", () => {
  void it(
    "returns true even when a restorable round already exists — Restore and Run Implementation " +
      "may be offered together (2026-09-24 review: the plan's applicability condition names only a " +
      "live implRecovery, not restorability)",
    async () => {
      const stamped = buildUnusableImplementationSummaryV1("bad shape", "run-log.md");
      const mem = installMemStore(
        seed({ [getImplementationSummaryUri(FOLDER).toString()]: stamped })
      );
      activeStore = mem;

      const offered = await hasOfferableRunImplementationForUnusableSummaryV1(
        FOLDER,
        /* hasLiveImplRecovery */ false
      );

      assert.equal(offered, true);
    }
  );

  void it("returns false when impl-summary.md does not exist", async () => {
    const mem = installMemStore();
    activeStore = mem;

    const offered = await hasOfferableRunImplementationForUnusableSummaryV1(FOLDER, false);

    assert.equal(offered, false);
  });

  void it("returns false when the current summary is not the rejection stamp", async () => {
    const mem = installMemStore(
      seed({ [getImplementationSummaryUri(FOLDER).toString()]: REAL_SUMMARY })
    );
    activeStore = mem;

    const offered = await hasOfferableRunImplementationForUnusableSummaryV1(FOLDER, false);

    assert.equal(offered, false);
  });

  void it(
    "returns true for an unusable summary with nothing restorable and no live implRecovery — the " +
      "deadlock case the register recorded",
    async () => {
      const stamped = buildUnusableImplementationSummaryV1("bad shape", "run-log.md");
      const mem = installMemStore(
        seed({ [getImplementationSummaryUri(FOLDER).toString()]: stamped })
      );
      activeStore = mem;

      const offered = await hasOfferableRunImplementationForUnusableSummaryV1(FOLDER, false);

      assert.equal(offered, true);
    }
  );

  void it("returns false when a continuation is already live — it will fix the summary automatically", async () => {
    const stamped = buildUnusableImplementationSummaryV1("bad shape", "run-log.md");
    const mem = installMemStore(
      seed({ [getImplementationSummaryUri(FOLDER).toString()]: stamped })
    );
    activeStore = mem;

    const offered = await hasOfferableRunImplementationForUnusableSummaryV1(
      FOLDER,
      /* hasLiveImplRecovery */ true
    );

    assert.equal(offered, false);
  });

  void it(
    "still returns true when the checklist is fully settled — a fully-settled checklist is not, on " +
      "its own, a reason to withhold the row action (only a live implRecovery narrows it)",
    async () => {
      const stamped = buildUnusableImplementationSummaryV1("bad shape", "run-log.md");
      const mem = installMemStore(
        seed({
          [getImplementationSummaryUri(FOLDER).toString()]: stamped,
          [getCanonicalImplementationUri(FOLDER).toString()]: FULLY_SETTLED_PLAN,
        })
      );
      activeStore = mem;

      const offered = await hasOfferableRunImplementationForUnusableSummaryV1(FOLDER, false);

      assert.equal(offered, true);
    }
  );

  void it("never throws on a read failure — a transient error renders as 'not offerable'", async () => {
    const fsApi = vscode.workspace.fs as unknown as { readFile: (uri: vscode.Uri) => Promise<Uint8Array> };
    const orig = fsApi.readFile;
    fsApi.readFile = (): Promise<Uint8Array> => Promise.reject(new Error("EIO: simulated transient failure"));
    activeStore = {
      restore: (): void => {
        fsApi.readFile = orig;
      },
    };

    const offered = await hasOfferableRunImplementationForUnusableSummaryV1(FOLDER, false);

    assert.equal(offered, false);
  });
});
