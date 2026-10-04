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
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { TaskProgress } from "../types/taskProgress";
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
  { label: "Run Publish Review", command: "vs-code-ai-helper.runReviewWithAI", holdsTaskPaused: false, optional: false },
  { label: "Run Review", command: "vs-code-ai-helper.runReviewWithAI", holdsTaskPaused: false, optional: false },
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
      ["Resume"]
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
});

void describe("converted call sites (RC7 item 4)", () => {
  // Every converted notification call, with the action it must offer in the chat.
  const SITES: ReadonlyArray<{ file: string; label: string; command: string; count: number }> = [
    { file: "utils/pausedTaskRefusalV1.ts", label: "Resume", command: "vs-code-ai-helper.resumeTask", count: 1 },
    { file: "commands/taskCreationRecovery.ts", label: "Resume", command: "vs-code-ai-helper.resumeTask", count: 2 },
    { file: "commands/runLintingFixes.ts", label: "Run Publish Checks", command: "vs-code-ai-helper.runPublishChecks", count: 2 },
    { file: "commands/reviewActions.ts", label: "Run Publish Checks", command: "vs-code-ai-helper.runPublishChecks", count: 1 },
    { file: "commands/reviewActions.ts", label: "Run Review", command: "vs-code-ai-helper.runReviewWithAI", count: 1 },
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
      assert.doesNotMatch(
        source,
        new RegExp(`title:\\s*"${site.label}"`),
        `${site.file} keeps no direct "${site.label}" button`
      );
    });
  }

  // RC8 item 7: creating a task while another is active is routine, so it
  // raises an informational notice and no chat decision.
  void it("commands/startNewTask.ts raises no chat decision for a task created paused", () => {
    const source = fs.readFileSync(path.join(root, "commands/startNewTask.ts"), "utf8");
    assert.doesNotMatch(source, /offerActionInChatV1\(/);
    assert.doesNotMatch(source, /holdsTaskPaused/);
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
});
