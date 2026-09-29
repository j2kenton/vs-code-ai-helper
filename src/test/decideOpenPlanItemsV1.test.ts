/**
 * RC2 item 13, Round 3.2 — the "nothing more to build" card's building
 * blocks: the atomic multi-item apply (`applyOpenPlanItemDecisionsV1`), the
 * card's pure content (`buildOpenPlanItemsNeedDecisionCardInputV1`), and the
 * "Decide item by item" QuickPick flow (`decideOpenPlanItemsV1`).
 *
 * The card's RAISE point in `reviewActions.ts`'s zero-file round-routing
 * branch (Step 50's other half) is wired and end-to-end tested separately, in
 * `deferredRoundRecovery.test.ts`'s "a zero-change round with unticked plan
 * items is refused without a clearing review (Item 4, Part 3)" describe
 * block.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  decideOpenPlanItemsV1,
  buildOpenPlanItemsNeedDecisionCardInputV1,
} from "../commands/decideOpenPlanItemsV1";
import { applyOpenPlanItemDecisionsV1 } from "../utils/implementationChecklist";
import { parseAcceptedNonGoalsV1 } from "../utils/reviewEvidenceNormalizerV1";
import {
  StatusSurface,
  deactivateNotificationRouter,
  initNotificationRouter,
} from "../utils/notificationRouter";
import { safeRemoveDir } from "./testFsUtils";
import { setExtensionContextV1 } from "../utils/extensionContextV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";

const ROOT = nodeFs.mkdtempSync(
  nodePath.join(nodeOs.tmpdir(), "ensemble-decide-open-plan-items-test-")
);
after(() => {
  safeRemoveDir(ROOT);
});

const PLAN = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "## Build",
  "",
  "- [x] Build the thing",
  "- [ ] A human deployment step",
  "- [ ] A measurement only the owner can take",
  "- [ ] Something the round actually did",
  "",
].join("\n");

void describe("applyOpenPlanItemDecisionsV1", () => {
  void it("applies tick, exclude and leave in one pass with one Accepted Non-Goals entry", () => {
    const result = applyOpenPlanItemDecisionsV1(
      PLAN,
      [
        { itemText: "A human deployment step", mode: "exclude", reason: "owner hand-off" },
        { itemText: "A measurement only the owner can take", mode: "exclude", reason: "owner hand-off" },
        { itemText: "Something the round actually did", mode: "tick", reason: "verified in the run log" },
      ],
      "2026-09-28"
    );
    assert.deepEqual(result.ticked, ["Something the round actually did"]);
    assert.deepEqual(result.excluded, ["A human deployment step", "A measurement only the owner can take"]);
    assert.deepEqual(result.notFound, []);
    assert.match(result.content, /- \[x\] Something the round actually did — Checked: verified in the run log\./);
    assert.match(
      result.content,
      /- \[ \] A human deployment step — Excluded by you: owner hand-off\. <!-- ensemble:excluded -->/
    );
    // Exactly one dated entry, naming both excluded items.
    const entries = [...result.content.matchAll(/### Open items settled by the owner \(owner decision, 2026-09-28\)/g)];
    assert.equal(entries.length, 1);
    const parsed = parseAcceptedNonGoalsV1(result.content);
    const ownerEntry = parsed.find((e) => e.heading.includes("2026-09-28"));
    assert.ok(ownerEntry, "owner-decision entry not found by the reader");
    assert.match(ownerEntry.bodyText, /A human deployment step/);
    assert.match(ownerEntry.bodyText, /A measurement only the owner can take/);
  });

  void it("leaves the plan untouched for a 'leave' decision and reports items that no longer match", () => {
    const result = applyOpenPlanItemDecisionsV1(
      PLAN,
      [
        { itemText: "A human deployment step", mode: "leave" },
        { itemText: "No such item", mode: "exclude", reason: "gone" },
      ],
      "2026-09-28"
    );
    assert.equal(result.content, PLAN);
    assert.deepEqual(result.ticked, []);
    assert.deepEqual(result.excluded, []);
    assert.deepEqual(result.notFound, ["No such item"]);
  });

  void it("is a no-op when every decision is 'leave' — no Accepted Non-Goals section is created", () => {
    const result = applyOpenPlanItemDecisionsV1(
      PLAN,
      [{ itemText: "A human deployment step", mode: "leave" }],
      "2026-09-28"
    );
    assert.equal(result.content, PLAN);
    assert.ok(!result.content.includes("Accepted Non-Goals"));
  });
});

void describe("buildOpenPlanItemsNeedDecisionCardInputV1", () => {
  const base = {
    taskFolderPath: "/t",
    taskCanonicalId: "c",
    stage: "impl" as const,
    createdAt: "2026-09-28T00:00:00.000Z",
    items: [
      { itemText: "A human deployment step", reason: "owner hand-off" },
      { itemText: "Runs at Publish", reason: "" },
    ],
  };

  void it("offers exactly three options, no bulk-exclude, and recommends deciding item by item", () => {
    const input = buildOpenPlanItemsNeedDecisionCardInputV1(base);
    const optionIds = input.options.map((o) => o.optionId).sort();
    assert.deepEqual(optionIds, ["decideItemByItem", "leaveOpen", "openPlanFinal"]);
    assert.ok(!input.options.some((o) => /exclude all|bulk/i.test(o.label)));
    assert.equal(input.recommendation.kind, "option");
    assert.equal(
      input.recommendation.kind === "option" ? input.recommendation.optionId : undefined,
      "decideItemByItem"
    );
  });

  void it("does not pause the task", () => {
    const input = buildOpenPlanItemsNeedDecisionCardInputV1(base);
    assert.equal(input.gating?.holdsTaskPaused, false);
  });

  void it("lists each open item with its reason, or 'no reason given'", () => {
    const input = buildOpenPlanItemsNeedDecisionCardInputV1(base);
    assert.match(input.whatHappened, /A human deployment step — owner hand-off/);
    assert.match(input.whatHappened, /Runs at Publish — no reason given/);
  });

  void it("the decide-item-by-item option's command carries the items with their reasons", () => {
    const input = buildOpenPlanItemsNeedDecisionCardInputV1(base);
    const decide = input.options.find((o) => o.optionId === "decideItemByItem");
    assert.equal(decide?.effect.kind, "command");
    if (decide?.effect.kind !== "command") {
      return;
    }
    assert.equal(decide.effect.command, "vs-code-ai-helper.decideOpenPlanItems");
    assert.deepEqual((decide.effect.args?.[0] as { items?: unknown })?.items, base.items);
  });

  void it("the open-plan-final option reuses the existing openPlanNonGoals command", () => {
    const input = buildOpenPlanItemsNeedDecisionCardInputV1(base);
    const open = input.options.find((o) => o.optionId === "openPlanFinal");
    assert.equal(open?.effect.kind, "command");
    if (open?.effect.kind !== "command") {
      return;
    }
    assert.equal(open.effect.command, "vs-code-ai-helper.openPlanNonGoals");
  });
});

void describe("decideOpenPlanItemsV1 command flow", () => {
  function makeTaskFolder(name: string, plan: string): string {
    const folder = nodePath.join(ROOT, name);
    nodeFs.mkdirSync(folder, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(folder, "plan-final.md"), plan, "utf8");
    return folder;
  }

  function testWindow(): typeof vscode.window & {
    _queueQuickPickResult: (v: unknown) => void;
    _queueInputBoxResult: (v: unknown) => void;
    _clearInteractionQueues: () => void;
  } {
    return vscode.window as unknown as ReturnType<typeof testWindow>;
  }

  const captured: { level: string; message: string }[] = [];
  const surface: StatusSurface = {
    addEntry: (message: string, level: "info" | "warning" | "error"): void => {
      captured.push({ level, message });
    },
  };
  initNotificationRouter(surface);

  // Back workspace.fs with the real disk so the command sees its own writes
  // (test-stubs' default `workspace.fs.readFile`/`writeFile` are unimplemented).
  const fs = vscode.workspace.fs as unknown as Record<string, unknown>;
  const origReadFile = fs.readFile;
  const origWriteFile = fs.writeFile;
  fs.readFile = async (uri: vscode.Uri): Promise<Uint8Array> =>
    new TextEncoder().encode(await nodeFs.promises.readFile(uri.fsPath, "utf8"));
  fs.writeFile = async (uri: vscode.Uri, data: Uint8Array): Promise<void> => {
    await nodeFs.promises.writeFile(uri.fsPath, Buffer.from(data));
  };
  after(() => {
    deactivateNotificationRouter();
    fs.readFile = origReadFile;
    fs.writeFile = origWriteFile;
  });

  void it("applies exclude + tick decisions from the QuickPick flow in one write", async () => {
    captured.length = 0;
    const folder = makeTaskFolder("flow-1", PLAN);
    const w = testWindow();
    w._clearInteractionQueues();
    // Item 1: "A human deployment step" -> Exclude, typed reason.
    w._queueQuickPickResult({ label: "Exclude", mode: "exclude" });
    w._queueInputBoxResult("owner hand-off, confirmed");
    // Item 2: "Something the round actually did" -> tick, typed note.
    w._queueQuickPickResult({ label: "I did it — tick it", mode: "tick" });
    w._queueInputBoxResult("checked manually");

    const ok = await decideOpenPlanItemsV1({
      taskFolderPath: folder,
      stage: "impl",
      items: [
        { itemText: "A human deployment step", reason: "" },
        { itemText: "Something the round actually did", reason: "" },
      ],
    });
    assert.equal(ok, true, JSON.stringify(captured));
    const content = nodeFs.readFileSync(nodePath.join(folder, "plan-final.md"), "utf8");
    assert.match(content, /A human deployment step — Excluded by you: owner hand-off, confirmed\./);
    assert.match(content, /Something the round actually did — Checked: checked manually\./);
    assert.match(content, /### Open items settled by the owner/);
  });

  void it("applies nothing when the owner cancels partway through", async () => {
    const folder = makeTaskFolder("flow-2", PLAN);
    const before = nodeFs.readFileSync(nodePath.join(folder, "plan-final.md"), "utf8");
    const w = testWindow();
    w._clearInteractionQueues();
    w._queueQuickPickResult(undefined); // Escape on the first item's QuickPick.

    const ok = await decideOpenPlanItemsV1({
      taskFolderPath: folder,
      stage: "impl",
      items: [{ itemText: "A human deployment step", reason: "" }],
    });
    assert.equal(ok, false);
    assert.equal(nodeFs.readFileSync(nodePath.join(folder, "plan-final.md"), "utf8"), before);
  });

  void it("refuses to exclude with a blank reason and applies nothing", async () => {
    const folder = makeTaskFolder("flow-3", PLAN);
    const before = nodeFs.readFileSync(nodePath.join(folder, "plan-final.md"), "utf8");
    const w = testWindow();
    w._clearInteractionQueues();
    w._queueQuickPickResult({ label: "Exclude", mode: "exclude" });
    w._queueInputBoxResult("   ");

    const ok = await decideOpenPlanItemsV1({
      taskFolderPath: folder,
      stage: "impl",
      items: [{ itemText: "A human deployment step", reason: "" }],
    });
    assert.equal(ok, false);
    assert.equal(nodeFs.readFileSync(nodePath.join(folder, "plan-final.md"), "utf8"), before);
  });

  void it("'leave open' for every item applies nothing and completes as a valid no-op, not a failure", async () => {
    const folder = makeTaskFolder("flow-4", PLAN);
    const before = nodeFs.readFileSync(nodePath.join(folder, "plan-final.md"), "utf8");
    const w = testWindow();
    w._clearInteractionQueues();
    w._queueQuickPickResult({ label: "Leave open", mode: "leave" });

    const result = await decideOpenPlanItemsV1({
      taskFolderPath: folder,
      stage: "impl",
      items: [{ itemText: "A human deployment step", reason: "" }],
    });
    assert.deepEqual(result, { outcome: "done" });
    assert.equal(nodeFs.readFileSync(nodePath.join(folder, "plan-final.md"), "utf8"), before);
  });

  // RC2 item 13, Step 52 — the continuation after applying decisions.
  function installExecuteCommandCapture(): {
    calls: Array<{ command: string; arg: unknown }>;
    restore: () => void;
  } {
    const calls: Array<{ command: string; arg: unknown }> = [];
    const commandsObj = vscode.commands as unknown as { _executeCommandOverride?: unknown };
    const prior = commandsObj._executeCommandOverride;
    commandsObj._executeCommandOverride = (command: string, arg?: unknown): Promise<undefined> => {
      calls.push({ command, arg });
      return Promise.resolve(undefined);
    };
    return {
      calls,
      restore: (): void => {
        commandsObj._executeCommandOverride = prior;
      },
    };
  }

  void it("arranges the stage's continuing action when items remain open after applying", async () => {
    const folder = makeTaskFolder("flow-5", PLAN);
    const w = testWindow();
    w._clearInteractionQueues();
    // Only "A human deployment step" is decided; "A measurement only the
    // owner can take" and "Something the round actually did" stay open.
    w._queueQuickPickResult({ label: "Exclude", mode: "exclude" });
    w._queueInputBoxResult("owner hand-off");
    const exec = installExecuteCommandCapture();
    try {
      const ok = await decideOpenPlanItemsV1({
        taskFolderPath: folder,
        stage: "impl",
        resumeFastForwardV1: { attemptNumber: 3, maxAttempts: 10 },
        items: [{ itemText: "A human deployment step", reason: "" }],
      });
      assert.equal(ok, true);
      const arranged = exec.calls.find(
        (c) => c.command === "vs-code-ai-helper.resumeAndApplyCurrentStageAction"
      );
      assert.ok(arranged, `expected resumeAndApplyCurrentStageAction to be dispatched; got ${JSON.stringify(exec.calls)}`);
      const arg = arranged.arg as { taskFolderPath?: string; resumeFastForwardV1?: unknown };
      assert.equal(arg.taskFolderPath, folder);
      assert.deepEqual(arg.resumeFastForwardV1, { attemptNumber: 3, maxAttempts: 10 });
    } finally {
      exec.restore();
    }
  });

  void it("offers Advance via a workflow decision card when nothing is left open after applying", async () => {
    const folder = makeTaskFolder("flow-6", PLAN);
    const w = testWindow();
    w._clearInteractionQueues();
    // Settle every remaining open item: exclude two, tick one.
    w._queueQuickPickResult({ label: "Exclude", mode: "exclude" });
    w._queueInputBoxResult("owner hand-off");
    w._queueQuickPickResult({ label: "Exclude", mode: "exclude" });
    w._queueInputBoxResult("owner hand-off");
    w._queueQuickPickResult({ label: "I did it — tick it", mode: "tick" });
    w._queueInputBoxResult("verified");

    const workspaceStateValues = new Map<string, unknown>();
    const memento = {
      get: <T>(key: string, fallback?: T): T =>
        workspaceStateValues.has(key) ? (workspaceStateValues.get(key) as T) : (fallback as T),
      update: (key: string, value: unknown): Promise<void> => {
        workspaceStateValues.set(key, value);
        return Promise.resolve();
      },
      keys: () => [...workspaceStateValues.keys()],
    } as unknown as vscode.Memento;
    const context = {
      globalState: memento,
      workspaceState: memento,
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;
    setExtensionContextV1(context);
    const exec = installExecuteCommandCapture();
    try {
      const ok = await decideOpenPlanItemsV1({
        taskFolderPath: folder,
        stage: "impl",
        items: [
          { itemText: "A human deployment step", reason: "" },
          { itemText: "A measurement only the owner can take", reason: "" },
          { itemText: "Something the round actually did", reason: "" },
        ],
      });
      assert.equal(ok, true);
      assert.ok(
        !exec.calls.some((c) => c.command === "vs-code-ai-helper.resumeAndApplyCurrentStageAction"),
        "nothing remains open — the ordinary continuing action must not be dispatched"
      );
      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const pending = store.listPending(folder);
      const advanceCard = pending.find((d) => d.decisionKey === "openPlanItemsSettledOfferAdvance");
      assert.ok(advanceCard, `expected an Advance-offering card; pending: ${JSON.stringify(pending)}`);
      const advanceOption = advanceCard.options.find((o) => o.optionId === "advance");
      assert.ok(advanceOption, "the card must offer an 'advance' option");
      assert.equal(advanceCard.recommendation.kind, "option");
      assert.equal(
        advanceCard.recommendation.kind === "option" ? advanceCard.recommendation.optionId : undefined,
        "advance"
      );
    } finally {
      exec.restore();
      setExtensionContextV1(undefined as unknown as vscode.ExtensionContext);
    }
  });
});
