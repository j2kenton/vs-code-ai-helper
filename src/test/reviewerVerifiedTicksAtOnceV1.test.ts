/**
 * review1 Step 53 (owner, 2026-11-05): reviewer-verified ticks apply at once, with no card and no countdown.
 * Replay of the 2026-11-05 05:08 UTC review that named 1 verified item: the item is ticked, no ticks card is
 * posted, nothing is dispatched, and Undo restores the line.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  applyVerifiedTicksAtOnceV1,
  deriveApplicableVerifiedTicksV1,
  describeTicksAppliedAtOnceV1,
  diffTickedLinesV1,
  undoReviewerVerifiedTicksV1,
  UNDO_REVIEWER_VERIFIED_TICKS_COMMAND_V1,
  type TickLineRestoreV1,
} from "../commands/applyReviewerVerifiedTicks";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { setExtensionContextV1 } from "../utils/extensionContextV1";
import { listCheckedChecklistItemTextsV1 } from "../utils/implementationChecklist";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import { makeOwnedTaskFolder } from "./taskFolderFixture";
import { safeRemoveDir } from "./testFsUtils";

const PLAN = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "# Plan",
  "",
  "- [x] Split the artifacts",
  "- [ ] Wire the completeness gate",
  "- [ ] Add the retry button",
  "",
].join("\n");

const REVIEW = [
  "Readiness: 8/10",
  "",
  "<!-- verified-complete:start -->",
  "- Wire the completeness gate",
  "  evidence: src/gate.ts:12 reads the shared count",
  "<!-- verified-complete:end -->",
  "",
  "<!-- blockers:start -->",
  "<!-- blockers:end -->",
  "",
].join("\n");

type Entry = { message: string; level: string; actionCommand?: { command: string; title: string; args?: unknown[] } };

void describe("reviewer-verified ticks apply at once (Step 53)", () => {
  const roots: string[] = [];
  const fsApi = vscode.workspace.fs as unknown as Record<string, unknown>;
  const original = { ...fsApi };
  let entries: Entry[] = [];
  let memento: vscode.Memento;

  beforeEach(() => {
    entries = [];
    initNotificationRouter({
      addEntry: (message: string, level: string, _f?: string, _r?: string, _s?: string, actionCommand?: Entry["actionCommand"]) => {
        entries.push({ message, level, actionCommand });
      },
    } as unknown as Parameters<typeof initNotificationRouter>[0]);
    fsApi.readFile = (uri: vscode.Uri): Promise<Uint8Array> => fs.promises.readFile(uri.fsPath);
    fsApi.writeFile = (uri: vscode.Uri, data: Uint8Array): Promise<void> => fs.promises.writeFile(uri.fsPath, data);
    fsApi.createDirectory = (): Promise<void> => Promise.resolve();
    fsApi.readDirectory = (): Promise<Array<[string, number]>> => Promise.resolve([]);
    fsApi.stat = (uri: vscode.Uri): Promise<unknown> => fs.promises.stat(uri.fsPath);
    const backing = new Map<string, unknown>();
    memento = {
      get: <T>(key: string, fallback?: T): T => (backing.has(key) ? (backing.get(key) as T) : (fallback as T)),
      update: (key: string, value: unknown): Promise<void> => {
        if (value === undefined) backing.delete(key);
        else backing.set(key, value);
        return Promise.resolve();
      },
      keys: () => [...backing.keys()],
    } as unknown as vscode.Memento;
    setExtensionContextV1({ globalState: memento, workspaceState: memento, subscriptions: [] } as unknown as vscode.ExtensionContext);
  });
  afterEach(() => {
    Object.assign(fsApi, original);
    setExtensionContextV1(undefined as unknown as vscode.ExtensionContext);
    deactivateNotificationRouter();
    for (const root of roots.splice(0)) safeRemoveDir(root);
  });

  function stage(): string {
    const { folder } = makeOwnedTaskFolder("ticks-at-once-");
    roots.push(path.dirname(path.dirname(folder)));
    const progressPath = path.join(folder, "task-progress.json");
    const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as Record<string, unknown>;
    progress.currentStage = "impl-high-review";
    progress.status = "active";
    fs.writeFileSync(progressPath, JSON.stringify(progress));
    fs.writeFileSync(path.join(folder, "plan-final.md"), PLAN);
    fs.writeFileSync(path.join(folder, "impl-high-review.md"), REVIEW);
    return folder;
  }

  void it("ticks the verified item at once, posts no ticks card, and says what it ticked and why", async () => {
    const folder = stage();
    const derived = await deriveApplicableVerifiedTicksV1(vscode.Uri.file(folder), "impl-high-review");
    assert.equal(derived.kind, "ok");
    if (derived.kind !== "ok") return;

    const result = await applyVerifiedTicksAtOnceV1(vscode.Uri.file(folder), derived.derivation, "ticks-task");
    assert.deepEqual(result, { kind: "applied", count: 1, undoable: true });

    const plan = fs.readFileSync(path.join(folder, "plan-final.md"), "utf8");
    assert.ok(listCheckedChecklistItemTextsV1(plan).some((t) => /Wire the completeness gate/.test(t)), "the item is ticked");
    assert.match(plan, /- \[ \] Add the retry button/, "an item the review did not name stays open");

    const pending = new WorkflowDecisionStoreV1(memento).listPending(folder);
    assert.deepEqual(
      pending.filter((d) => d.decisionKey === "applyReviewerVerifiedTicks"),
      [],
      "no reviewer-verified ticks card is posted"
    );

    const info = entries.find((e) => /Ticked 1 item/.test(e.message));
    assert.ok(info, "one notification says what was ticked");
    assert.match(info.message, /verified by impl-high-review\.md/);
    assert.match(info.message, /Wire the completeness gate — src\/gate\.ts:12 reads the shared count/);
    assert.equal(info.actionCommand?.command, UNDO_REVIEWER_VERIFIED_TICKS_COMMAND_V1);
    assert.equal(info.actionCommand?.title, "Undo");

    const chat = JSON.parse(fs.readFileSync(path.join(folder, "chat-v1.json"), "utf8")) as { messages?: Array<{ text: string }> };
    assert.ok(
      (chat.messages ?? []).some((m) => /^Ticked 1 item \(verified by impl-high-review\.md\)/.test(m.text)),
      "one chat line says the same"
    );
  });

  void it("Undo restores exactly the ticked lines", async () => {
    const folder = stage();
    const derived = await deriveApplicableVerifiedTicksV1(vscode.Uri.file(folder), "impl-high-review");
    assert.equal(derived.kind, "ok");
    if (derived.kind !== "ok") return;
    await applyVerifiedTicksAtOnceV1(vscode.Uri.file(folder), derived.derivation);
    const undoArg = entries.find((e) => e.actionCommand)?.actionCommand?.args?.[0] as {
      taskFolderPath: string;
      restores: TickLineRestoreV1[];
    };
    assert.ok(undoArg && undoArg.restores.length === 1, "the Undo carries the one changed line");

    const outcome = await undoReviewerVerifiedTicksV1(undoArg);
    assert.deepEqual(outcome, { restored: 1, skipped: 0 });
    assert.equal(fs.readFileSync(path.join(folder, "plan-final.md"), "utf8"), PLAN, "the plan is back byte for byte");
  });

  void it("Undo leaves a line the owner edited since, and says so", async () => {
    const folder = stage();
    const derived = await deriveApplicableVerifiedTicksV1(vscode.Uri.file(folder), "impl-high-review");
    if (derived.kind !== "ok") throw new Error("expected ok");
    await applyVerifiedTicksAtOnceV1(vscode.Uri.file(folder), derived.derivation);
    const undoArg = entries.find((e) => e.actionCommand)?.actionCommand?.args?.[0] as {
      taskFolderPath: string;
      restores: TickLineRestoreV1[];
    };
    const edited = fs.readFileSync(path.join(folder, "plan-final.md"), "utf8").replace("Wire the completeness gate", "Wire the gate");
    fs.writeFileSync(path.join(folder, "plan-final.md"), edited);
    const outcome = await undoReviewerVerifiedTicksV1(undoArg);
    assert.deepEqual(outcome, { restored: 0, skipped: 1 });
    assert.equal(fs.readFileSync(path.join(folder, "plan-final.md"), "utf8"), edited, "nothing else changed");
  });

  void it("diffTickedLinesV1 reports changed lines only, and nothing when the line count differs", () => {
    assert.deepEqual(diffTickedLinesV1("a\n- [ ] x\nb", "a\n- [x] x\nb"), [{ before: "- [ ] x", after: "- [x] x" }]);
    assert.equal(diffTickedLinesV1("a\nb", "a\nb\nc"), undefined);
    assert.equal(
      describeTicksAppliedAtOnceV1({
        reviewStage: "impl-high-review",
        reviewFilename: "impl-high-review.md",
        applicable: ["A", "B"],
        applicableEvidence: ["seen", undefined],
        applicableTestReportRoundIds: [[], []],
        withheldTestItems: [],
        withheldReasons: new Map(),
      }),
      "Ticked 2 items (verified by impl-high-review.md): A — seen; B — no evidence line in this review (older review format)"
    );
  });

  void it("the review-completion hook ticks instead of posting the ticks card", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "commands", "reviewActions.ts"), "utf8");
    const start = source.indexOf("async function notifyReviewerVerifiedTicksV1(");
    const body = source.slice(start, source.indexOf("\n}\n", start));
    assert.match(body, /applyVerifiedTicksAtOnceV1\(/);
    assert.doesNotMatch(body, /postApplyReviewerVerifiedTicksDecisionV1/, "no card or countdown is raised for verified ticks");
    assert.doesNotMatch(body, /resumeAndApplyCurrentStageAction|runReviewForFolder/, "nothing is dispatched");
  });
});
