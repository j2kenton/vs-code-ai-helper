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
  getImplementationSummaryUri,
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

      const { warning, canRestorePreviousImplSummary } = await describeUnusableReviewBlockV1(
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

      const { warning, canRestorePreviousImplSummary } = await describeUnusableReviewBlockV1(
        FOLDER,
        "impl-low-review"
      );

      assert.match(warning, /Restore the last usable summary/);
      assert.doesNotMatch(warning, /^Rerun the implementation/m);
      assert.equal(canRestorePreviousImplSummary, true);
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
