/**
 * RC7 item 4: a notification's button only opens the chat. `offerActionInChatV1`
 * posts the action as a recommended option on a decision and hands back the
 * chat pointer; with nothing to post to, it hands back no action.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import { offerActionInChatV1 } from "../utils/chatActionOfferV1";
import { offerPublishChecksRetryAfterExecutionFailureV1 } from "../commands/runPublishChecks";
import { showResumeStaysPausedV1 } from "../commands/resumeTask";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { TaskProgress } from "../types/taskProgress";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import { fixtureOwnershipFor } from "./taskFolderFixture";
import { safeRemoveDir } from "./testFsUtils";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-chat-action-offer-"));
after(() => {
  safeRemoveDir(ROOT);
});

function makeTask(name: string): string {
  const dir = path.join(ROOT, "tasks", name);
  fs.mkdirSync(dir, { recursive: true });
  const progress: TaskProgress = {
    taskFolder: name,
    currentStage: "publish",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ownership: fixtureOwnershipFor(dir),
  };
  fs.writeFileSync(path.join(dir, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
  return dir;
}

function makeMemento(): vscode.Memento {
  const backing = new Map<string, unknown>();
  return {
    keys: (): readonly string[] => [...backing.keys()],
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      backing.has(key) ? (backing.get(key) as T) : defaultValue,
    update: (key: string, value: unknown): Thenable<void> => {
      if (value === undefined) { backing.delete(key); } else { backing.set(key, value); }
      return Promise.resolve();
    },
  } as vscode.Memento;
}

function withFsBridge<T>(run: () => Promise<T>): Promise<T> {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const original = target.readFile;
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buffer) => new Uint8Array(buffer));
  return run().finally(() => {
    target.readFile = original;
  });
}

const OFFERS = [
  { label: "Run Publish Checks", command: "vs-code-ai-helper.runPublishChecks", holdsTaskPaused: false, optional: false },
  { label: "Fix Linting & Code Errors", command: "vs-code-ai-helper.runLintingFixes", holdsTaskPaused: false, optional: false },
  { label: "Run Publish Review", command: "vs-code-ai-helper.runReviewWithAI", holdsTaskPaused: false, optional: false },
  // An automatic review hand-over that was dropped offers the exact stage action in chat.
  { label: "Run Implementation", command: "vs-code-ai-helper.runImplementationWithAI", holdsTaskPaused: false, optional: true },
  // An Implementation round with no scheduled follow-up offers this action,
  // but does not require the user to accept it to unblock the task.
  { label: "Run Review", command: "vs-code-ai-helper.runReviewWithAI", holdsTaskPaused: false, optional: true },
  { label: "Complete Stage & Move On", command: "vs-code-ai-helper.nextStage", holdsTaskPaused: false, optional: true },
  // RC9 item 3: the paused-refusal Resume offer is optional and holds nothing.
  { label: "Resume", command: "vs-code-ai-helper.resumeTask", holdsTaskPaused: false, optional: true },
];

void describe("offerActionInChatV1 (RC7 item 4)", () => {
  for (const offer of OFFERS) {
    void it(`posts "${offer.label}" as the recommended option and returns the chat pointer`, async () => {
      const dir = makeTask(`offer-${offer.label.replace(/\W+/g, "-").toLowerCase()}`);
      const memento = makeMemento();
      __extensionContextV1TestOnly.set({
        subscriptions: [],
        extensionUri: vscode.Uri.file(ROOT),
        workspaceState: memento,
        globalState: memento,
      } as unknown as vscode.ExtensionContext);
      try {
        const pointer = await withFsBridge(() =>
          offerActionInChatV1({
            taskFolderPath: dir,
            actionLabel: offer.label,
            command: offer.command,
            args: [{ taskFolderPath: dir }],
            noticeText: "the notification text",
            holdsTaskPaused: offer.holdsTaskPaused,
            ...(offer.optional ? { optional: true as const } : {}),
          })
        );
        assert.equal(pointer?.command, "vs-code-ai-helper.openWorkflowDecision");
        assert.equal(pointer?.title, "Open in Chat");
        assert.equal(pointer?.args[0].taskFolderPath, dir);

        const decision = new WorkflowDecisionStoreV1(memento)
          .listPending()
          .find((d) => d.decisionKey.startsWith("chatActionOffer:"));
        assert.ok(decision, "the decision is posted");
        const action = decision.options.find((o) => o.optionId === "runAction");
        assert.equal(action?.label, offer.label);
        assert.deepEqual(action?.effect, { kind: "command", command: offer.command, args: [{ taskFolderPath: dir }] });
        assert.equal(decision.options.find((o) => o.optionId === "notNow")?.effect.kind, "doNothing");
        assert.equal(decision.recommendation.kind === "option" && decision.recommendation.optionId, "runAction");
        assert.equal(decision.gating?.holdsTaskPaused, offer.holdsTaskPaused);
        assert.equal(decision.gating?.unblocksProgress, !offer.optional);
        assert.ok((decision.gating?.detail ?? "").length > 0);
      } finally {
        __extensionContextV1TestOnly.reset();
      }
    });
  }

  void it("returns no action when the decision cannot be posted", async () => {
    const dir = makeTask("offer-no-context");
    __extensionContextV1TestOnly.reset();
    const pointer = await withFsBridge(() =>
      offerActionInChatV1({
        taskFolderPath: dir,
        actionLabel: "Resume",
        command: "vs-code-ai-helper.resumeTask",
        noticeText: "paused",
      })
    );
    assert.equal(pointer, undefined);
  });

  void it("no offer holds the task paused; the paused-refusal Resume offer is optional", () => {
    assert.deepEqual(
      OFFERS.filter((o) => o.holdsTaskPaused).map((o) => o.label),
      []
    );
    assert.deepEqual(
      OFFERS.filter((o) => o.optional).map((o) => o.label),
      ["Run Implementation", "Run Review", "Complete Stage & Move On", "Resume"]
    );
  });

  void it("an optional offer posts holdsTaskPaused: false, unblocksProgress: false (RC9 item 3)", async () => {
    const dir = makeTask("offer-optional-gating");
    const memento = makeMemento();
    __extensionContextV1TestOnly.set({
      subscriptions: [],
      extensionUri: vscode.Uri.file(ROOT),
      workspaceState: memento,
      globalState: memento,
    } as unknown as vscode.ExtensionContext);
    try {
      await withFsBridge(() =>
        offerActionInChatV1({
          taskFolderPath: dir,
          actionLabel: "Resume",
          command: "vs-code-ai-helper.resumeTask",
          noticeText: "paused",
          optional: true,
        })
      );
      const decision = new WorkflowDecisionStoreV1(memento)
        .listPending()
        .find((d) => d.decisionKey.startsWith("chatActionOffer:"));
      assert.equal(decision?.gating?.holdsTaskPaused, false);
      assert.equal(decision?.gating?.unblocksProgress, false);
    } finally {
      __extensionContextV1TestOnly.reset();
    }
  });

  void it("the Publish Checks execution-failure handler offers a retry in task chat", async () => {
    const dir = makeTask("publish-checks-execution-failure");
    const memento = makeMemento();
    const notices: string[] = [];
    __extensionContextV1TestOnly.set({
      subscriptions: [],
      extensionUri: vscode.Uri.file(ROOT),
      workspaceState: memento,
      globalState: memento,
    } as unknown as vscode.ExtensionContext);
    initNotificationRouter({ addEntry: (message) => notices.push(message) });
    try {
      await withFsBridge(() => offerPublishChecksRetryAfterExecutionFailureV1(
        vscode.Uri.file(dir),
        "publish-checks-execution-failure",
        new Error("spawn failed")
      ));
      const decision = new WorkflowDecisionStoreV1(memento).listPending().find((item) =>
        item.decisionKey === "chatActionOffer:runPublishChecks"
      );
      assert.ok(decision);
      assert.equal(decision.state, "pending");
      assert.equal(decision.recommendation.kind, "option");
      if (decision.recommendation.kind === "option") {
        assert.equal(decision.recommendation.optionId, "runAction");
      }
      assert.match(decision.whatHappened, /Publish checks failed to run: spawn failed/);
      assert.equal(decision.options.find((option) => option.optionId === "runAction")?.label, "Run Publish Checks");
      assert.deepEqual(
        decision.options.find((option) => option.optionId === "runAction")?.effect,
        { kind: "command", command: "vs-code-ai-helper.runPublishChecks", args: [{ taskFolderPath: dir }] }
      );
      assert.match(notices.join("\n"), /Open the decision in Chat to continue/);
    } finally {
      deactivateNotificationRouter();
      __extensionContextV1TestOnly.reset();
    }
  });
});

void describe("converted call sites (RC7 item 4)", () => {
  // Every converted notification call, with the action it must offer in the chat.
  const SITES: ReadonlyArray<{ file: string; label: string; command: string; count: number; noDirectTitle?: boolean }> = [
    { file: "utils/pausedTaskRefusalV1.ts", label: "Resume", command: "vs-code-ai-helper.resumeTask", count: 1 },
    { file: "commands/taskCreationRecovery.ts", label: "Resume", command: "vs-code-ai-helper.resumeTask", count: 2 },
    { file: "commands/runLintingFixes.ts", label: "Run Publish Checks", command: "vs-code-ai-helper.runPublishChecks", count: 3 },
    { file: "commands/runPublishChecks.ts", label: "Fix Linting & Code Errors", command: "vs-code-ai-helper.runLintingFixes", count: 1 },
    { file: "commands/runPublishChecks.ts", label: "Run Publish Checks", command: "vs-code-ai-helper.runPublishChecks", count: 2 },
    { file: "commands/scheduleTaskResume.ts", label: "Complete Stage & Move On", command: "vs-code-ai-helper.nextStage", count: 1 },
    { file: "commands/reviewActions.ts", label: "Complete Stage & Move On", command: "vs-code-ai-helper.nextStage", count: 1 },
    { file: "commands/resumeTask.ts", label: "Resume", command: "vs-code-ai-helper.resumeTask", count: 1 },
    { file: "commands/resumeTask.ts", label: "Restore Last Usable Summary", command: "vs-code-ai-helper.restoreRejectedImplementationRound", count: 1 },
    { file: "commands/reviewActions.ts", label: "Run Publish Checks", command: "vs-code-ai-helper.runPublishChecks", count: 2 },
    { file: "commands/reviewActions.ts", label: "Run Review", command: "vs-code-ai-helper.runReviewWithAI", count: 2 },
    { file: "commands/reviewActions.ts", label: "Run Implementation", command: "vs-code-ai-helper.runImplementationWithAI", count: 2, noDirectTitle: false },
  ];
  const root = path.join(__dirname, "..", "..", "src");

  /** The text of each `offerActionInChatV1(` call: from the call to its first `command:` line. */
  const offerCalls = (source: string): string[] =>
    source.split("offerActionInChatV1(").slice(1).map((part) => part.slice(0, 500));

  for (const site of SITES) {
    void it(`${site.file} offers "${site.label}" through the chat ${site.count} time(s)`, () => {
      const source = fs.readFileSync(path.join(root, site.file), "utf8");
      const matching = offerCalls(source).filter(
        (c) => c.includes(`actionLabel: "${site.label}"`) && c.includes(`command: "${site.command}"`)
      );
      assert.equal(matching.length, site.count, `${site.file}: chat offers for ${site.label}`);
      if (site.noDirectTitle !== false) {
        assert.doesNotMatch(
          source,
          new RegExp(`title:\\s*"${site.label}"`),
          `${site.file} keeps no direct "${site.label}" button`
        );
      }
    });
  }

  void it("offers Run Review only when a completed Implementation round arranged no automatic follow-up", () => {
    const source = fs.readFileSync(path.join(root, "commands/reviewActions.ts"), "utf8");
    const start = source.indexOf("async function executeImplementationRun(");
    const end = source.indexOf("export async function recordHandoffOnlyStopV1(", start);
    const implementation = source.slice(start, end);
    assert.match(implementation, /followUpReviewScheduled = true;\s*dispatchReviewChainAfterLockRelease\(/);
    assert.match(
      implementation,
      /if \(!followUpReviewScheduled && !options\.suppressAutoReviewDispatch\)\s*\{[\s\S]*?actionLabel: "Run Review"[\s\S]*?optional: true/
    );
  });

  // RC8 item 7: creating a task while another is active is routine, so it
  // raises an informational notice and no chat decision.
  void it("commands/startNewTask.ts raises no chat decision for a task created paused", () => {
    const source = fs.readFileSync(path.join(root, "commands/startNewTask.ts"), "utf8");
    assert.doesNotMatch(source, /offerActionInChatV1\(/);
    // The multi-root workspace choice is a non-gating question; a paused
    // task creation still posts no decision that holds the task paused.
    assert.doesNotMatch(source, /holdsTaskPaused:\s*true/);
  });

  void it("Run Publish Review reaches the chat through the Publish Checks caller, not a direct button", () => {
    const steps = fs.readFileSync(path.join(root, "utils/publishStageActionsV1.ts"), "utf8");
    assert.match(steps, /title: "Run Publish Review"/);
    const caller = fs.readFileSync(path.join(root, "commands/runPublishChecks.ts"), "utf8");
    assert.ok(
      offerCalls(caller).some(
        (c) => c.includes("actionLabel: nextStepOffer.action.title") && c.includes("command: nextStepOffer.action.command")
      )
    );
    // RC9 item 2: the parent-operation (Fast Forward) arm posts no card; the
    // only offer sits in the manual `else` arm.
    const parentArm = caller.indexOf("parentOperation !== undefined && nextStepOffer.action.command");
    const elseArm = caller.indexOf("} else {", parentArm);
    const offerAt = caller.indexOf("offerActionInChatV1({", parentArm);
    assert.ok(parentArm >= 0 && elseArm > parentArm, "parent/manual split present");
    assert.ok(offerAt > elseArm, "no offer inside the parent-operation arm");
    assert.match(caller.slice(parentArm, elseArm), /Fast Forward runs the Publish review next/);
  });

  void it("failed and cancelled check hand-backs offer their next action in chat", () => {
    const publishChecks = fs.readFileSync(path.join(root, "commands/runPublishChecks.ts"), "utf8");
    assert.match(publishChecks, /Publish checks found issues:[\s\S]*?await offerActionInChatV1\([\s\S]*?actionLabel: "Fix Linting & Code Errors"/);
    assert.match(publishChecks, /Publish checks were cancelled\.[\s\S]*?await offerActionInChatV1\([\s\S]*?actionLabel: "Run Publish Checks"/);
    const fix = fs.readFileSync(path.join(root, "commands/runLintingFixes.ts"), "utf8");
    assert.match(fix, /const showFixHandbackV1 = async[\s\S]*?actionLabel: "Run Publish Checks"[\s\S]*?showWarning\(/);
    assert.match(fix, /await showFixHandbackV1\([\s\S]*?AI final fixes were applied, but checks still fail/);
    assert.match(fix, /await showFixHandbackV1\([\s\S]*?final checks could not be confirmed/);
    assert.match(fix, /AI final fixes unavailable; checks still fail[\s\S]*?await showFixHandbackV1\([\s\S]*?AI final fixes are unavailable:/);
    assert.match(fix, /eslintAutofixAttempted && eslintUnavailable[\s\S]*?await showFixHandbackV1\([\s\S]*?Could not apply automatic fixes because the ESLint extension is unavailable/);
    assert.match(fix, /deterministicFixOutcomeV1\([\s\S]*?passed: postFixLint\.passed[\s\S]*?deterministicOutcome\.kind === "failure"[\s\S]*?await showFixHandbackV1\(deterministicOutcome\.handback!/);
    assert.match(fix, /No automatic fixes were available\.[\s\S]*?await showFixHandbackV1\(/);
    assert.match(publishChecks, /reviewFollows && freshStampWritten[\s\S]*?The Publish review runs next/);
  });

  void it("the Publish Checks execution catch delegates to the tested chat retry handler", () => {
    const source = fs.readFileSync(path.join(root, "commands/runPublishChecks.ts"), "utf8");
    const handlerCall = source.indexOf("await offerPublishChecksRetryAfterExecutionFailureV1(");
    assert.ok(handlerCall >= 0);
    const catchStart = source.lastIndexOf("} catch (error) {", handlerCall);
    assert.ok(catchStart >= 0, "the retry handler is called inside an execution catch");
    assert.match(source.slice(catchStart, handlerCall), /if \(error instanceof PublishChecksCancelledError\)[\s\S]*?return;[\s\S]*$/);
  });

  void it("activation recovery retirement offers the next stage and task creation recovery has a visible active path", () => {
    const recovery = fs.readFileSync(path.join(root, "commands/scheduleTaskResume.ts"), "utf8");
    assert.match(recovery, /retireSatisfiedSummaryRejectedRecoveryV1\([\s\S]*?nextActorOnRetire: "human"[\s\S]*?await offerActionInChatV1\([\s\S]*?actionLabel: "Complete Stage & Move On"/);
    const creation = fs.readFileSync(path.join(root, "commands/taskCreationRecovery.ts"), "utf8");
    assert.match(creation, /if \(outcome\.initialStatus === "active"\) \{[\s\S]*?currentTaskStore\.set\([\s\S]*?actionLabel: "Draft with AI"[\s\S]*?command: "vs-code-ai-helper\.draftTaskWithAI"[\s\S]*?safeOpenTextDocument\(taskFileUri, TASK_FILENAME\)/);
    assert.match(creation, /if \(outcome\.initialStatus === "active"\) \{[\s\S]*?currentTaskStore\.set\([\s\S]*?creation resumed \(task\.md preserved\)[\s\S]*?actionLabel: "Draft with AI"[\s\S]*?command: "vs-code-ai-helper\.draftTaskWithAI"/);
  });

  void describe("showResumeStaysPausedV1 (resumeTask.ts notification-action reconciliation)", () => {
    class RecordingSurface {
      entries: Array<{ message: string; actionCommand?: { command: string; title: string; args?: unknown[] } }> = [];
      addEntry(
        message: string,
        _level: string,
        _filePath?: string,
        _resultTargetUri?: string,
        _sourceOperationId?: string,
        actionCommand?: { command: string; title: string; args?: unknown[] }
      ): void {
        this.entries.push({ message, actionCommand });
      }
    }

    void it("offers Restore Last Usable Summary through chat when restoreSummary is true", async () => {
      const dir = makeTask("resume-stays-paused-restore");
      const memento = makeMemento();
      const context = {
        subscriptions: [],
        extensionUri: vscode.Uri.file(ROOT),
        workspaceState: memento,
        globalState: memento,
      } as unknown as vscode.ExtensionContext;
      __extensionContextV1TestOnly.set(context);

      const surface = new RecordingSurface();
      initNotificationRouter(surface);
      try {
        await withFsBridge(() =>
          showResumeStaysPausedV1(
            "Task Name",
            dir,
            "impl",
            "the implementation summary is unusable",
            true
          )
        );
        assert.equal(surface.entries.length, 1);
        const entry = surface.entries[0];
        assert.ok(entry);
        assert.match(entry.message, /"Task Name" stays paused: the implementation summary is unusable/);
        assert.equal(entry.actionCommand?.command, "vs-code-ai-helper.openWorkflowDecision");
        assert.equal(entry.actionCommand?.title, "Open in Chat");

        const store = new WorkflowDecisionStoreV1(memento);
        const decision = store.listPending().find((d) => d.decisionKey === "chatActionOffer:restoreRejectedImplementationRound");
        assert.ok(decision, "workflow decision for Restore Last Usable Summary must be posted in chat");
        const action = decision.options.find((o) => o.optionId === "runAction");
        assert.equal(action?.label, "Restore Last Usable Summary");
        assert.deepEqual(action?.effect, {
          kind: "command",
          command: "vs-code-ai-helper.restoreRejectedImplementationRound",
          args: [dir, "impl"],
        });
      } finally {
        deactivateNotificationRouter();
        __extensionContextV1TestOnly.reset();
      }
    });

    void it("attaches no action when chat is unavailable (unavailable-chat behavior)", async () => {
      const dir = makeTask("resume-stays-paused-unavail");
      __extensionContextV1TestOnly.reset();

      const surface = new RecordingSurface();
      initNotificationRouter(surface);
      try {
        await withFsBridge(() =>
          showResumeStaysPausedV1(
            "Task Name",
            dir,
            "impl",
            "the implementation summary is unusable",
            true
          )
        );
        assert.equal(surface.entries.length, 1);
        const entry = surface.entries[0];
        assert.ok(entry);
        assert.match(entry.message, /"Task Name" stays paused/);
        assert.equal(entry.actionCommand, undefined, "no action button attached when chat unavailable");
      } finally {
        deactivateNotificationRouter();
      }
    });

    void it("attaches no action when restoreSummary is false or undefined", async () => {
      const dir = makeTask("resume-stays-paused-no-restore");
      const memento = makeMemento();
      __extensionContextV1TestOnly.set({
        subscriptions: [],
        extensionUri: vscode.Uri.file(ROOT),
        workspaceState: memento,
        globalState: memento,
      } as unknown as vscode.ExtensionContext);

      const surface = new RecordingSurface();
      initNotificationRouter(surface);
      try {
        await withFsBridge(() =>
          showResumeStaysPausedV1(
            "Task Name",
            dir,
            "impl",
            "prerequisites not met",
            false
          )
        );
        assert.equal(surface.entries.length, 1);
        const entry = surface.entries[0];
        assert.ok(entry);
        assert.equal(entry.actionCommand, undefined);
      } finally {
        deactivateNotificationRouter();
        __extensionContextV1TestOnly.reset();
      }
    });
  });
});
