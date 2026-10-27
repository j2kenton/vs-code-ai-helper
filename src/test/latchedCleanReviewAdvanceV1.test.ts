/**
 * bugs2 Step 20: the unreliable-checklist latch no longer bypasses the
 * reviewer-verified completeness gate. A clean review can offer the owner an
 * explicit Move on decision, and reviewer-verified ticks are applied before
 * the decision, but provisional self-claims never advance automatically.
 *
 * Drives `handleReviewOutcomeV1` over a temp directory (the plan write is
 * atomic and needs a real disk), like `reviewNoTrackedFileSetV1.test.ts`
 * otherwise. The task carries an ownership binding so the stage write persists.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import { handleReviewOutcomeV1 } from "../commands/reviewActions";
import type { TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import { REVIEW_STAGES, type TaskProgress } from "../types/taskProgress";
import { safeRemoveDir } from "./testFsUtils";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import type { WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import { clearFastForwardRunActiveV1, markFastForwardRunActiveV1 } from "../utils/activeFastForwardRunsV1";

/* eslint-disable @typescript-eslint/no-var-requires */
const settingsModule = require("../config/settings") as Record<string, unknown>;
const modelSelectionModule = require("../utils/modelSelection") as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-var-requires */

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-latched-clean-review-"));
after(() => {
  safeRemoveDir(ROOT);
});

/** Bridge the vscode-stub file system onto the real disk for this test. */
function installDiskBridge(): { restore: () => void } {
  const fsObj = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = { ...fsObj };
  const notFound = (uri: vscode.Uri): Error =>
    Object.assign(new Error(`ENOENT: ${uri.toString()}`), { code: "FileNotFound" });
  fsObj.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then(
      (buf) => new Uint8Array(buf),
      () => Promise.reject(notFound(uri))
    );
  fsObj.writeFile = async (uri: vscode.Uri, data: Uint8Array): Promise<void> => {
    await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
    await fs.promises.writeFile(uri.fsPath, data);
  };
  fsObj.stat = (uri: vscode.Uri): Promise<unknown> =>
    fs.promises.stat(uri.fsPath).then(
      (s) => ({ type: s.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File, ctime: 0, mtime: 0, size: s.size }),
      () => Promise.reject(notFound(uri))
    );
  fsObj.rename = async (source: vscode.Uri, dest: vscode.Uri): Promise<void> => {
    await fs.promises.rm(dest.fsPath, { force: true });
    await fs.promises.rename(source.fsPath, dest.fsPath);
  };
  fsObj.delete = (uri: vscode.Uri): Promise<void> => fs.promises.rm(uri.fsPath, { force: true, recursive: true });
  fsObj.createDirectory = (uri: vscode.Uri): Promise<void> =>
    fs.promises.mkdir(uri.fsPath, { recursive: true }).then(() => undefined);
  fsObj.readDirectory = (): Promise<Array<[string, number]>> => Promise.resolve([]);
  return {
    restore: (): void => {
      Object.assign(fsObj, orig);
    },
  };
}

class RecordingSurface {
  entries: { message: string; level: "info" | "warning" | "error" }[] = [];
  addEntry(message: string, level: "info" | "warning" | "error"): void {
    this.entries.push({ message, level });
  }
}

const PLAN_FINAL = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "- [x] 1. Item one",
  "- [ ] 2. Item two",
  "- [ ] 3. Item three",
  "- [ ] 4. Item four",
  "",
].join("\n");

function reviewText(options: { blockers?: string[]; verified?: string[]; verdict?: string; progress?: string }): string {
  return [
    "# Implementation Review",
    "",
    "Readiness: 9/10",
    "",
    ...(options.verdict ? [`**Verdict:** ${options.verdict}`, ""] : []),
    `<!-- progress: ${options.progress ?? "29/90"} -->`,
    "",
    "<!-- blockers:start -->",
    ...(options.blockers ?? []),
    "<!-- blockers:end -->",
    "",
    "<!-- verified-complete:start -->",
    ...(options.verified ?? []).map((item) => `- ${item}`),
    "<!-- verified-complete:end -->",
    "",
  ].join("\n");
}

interface Routed {
  /** Keys of every pending workflow decision posted to the chat. */
  decisionKeys: readonly string[];
  /** Pending workflow decisions with the given key, as posted to the chat. */
  latchedCards: readonly WorkflowDecisionV1[];
  entries: RecordingSurface["entries"];
  planFinal: string;
  pendingTickCards: number;
  postedTickDecisions: number;
  stage: string;
  error: unknown;
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

async function route(
  name: string,
  options: { latched: boolean; review: string; plan?: string }
): Promise<Routed> {
  const bridge = installDiskBridge();
  const memento = makeMemento();
  __extensionContextV1TestOnly.set({
    subscriptions: [],
    extensionUri: vscode.Uri.file(ROOT),
    workspaceState: memento,
    globalState: memento,
  } as unknown as vscode.ExtensionContext);
  const surface = new RecordingSurface();
  initNotificationRouter(surface);
  const folderUri = vscode.Uri.file(path.join(ROOT, ".ensemble", name));
  const reviewUri = vscode.Uri.joinPath(folderUri, "impl-high-review.md");
  const planFinalUri = vscode.Uri.joinPath(folderUri, "plan-final.md");
  const progress: TaskProgress = {
    taskFolder: name,
    displayName: "Latched task",
    currentStage: "impl-high-review",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    reviewAttemptId: "attempt-latched",
    ownership: {
      metaRoot: path.join(ROOT, ".ensemble"),
      projectRoot: ROOT,
      workspaceRoot: ROOT,
      boundAt: "2026-01-01T00:00:00.000Z",
    },
    ...(options.latched ? { checklistProgressUnreliable: true } : {}),
  } as TaskProgress;
  fs.mkdirSync(folderUri.fsPath, { recursive: true });
  fs.writeFileSync(path.join(folderUri.fsPath, "task-progress.json"), JSON.stringify(progress, null, 2));
  fs.writeFileSync(reviewUri.fsPath, options.review);
  fs.writeFileSync(planFinalUri.fsPath, options.plan ?? PLAN_FINAL);

  const originals = ["isAutoAdvanceEnabled", "getAutoAdvanceScoreThreshold"].map(
    (key) => [key, settingsModule[key]] as const
  );
  settingsModule.isAutoAdvanceEnabled = (): boolean => true;
  settingsModule.getAutoAdvanceScoreThreshold = (): number => 8;
  // With no model configured, optional review stages are skipped, so the
  // advance would land on Publish; configure every review stage.
  const origConfiguredStages = modelSelectionModule.resolveConfiguredReviewStages;
  modelSelectionModule.resolveConfiguredReviewStages = (): Promise<ReadonlySet<string>> =>
    Promise.resolve(new Set<string>(REVIEW_STAGES));
  const ws = vscode.workspace as unknown as Record<string, unknown>;
  const origFolders = ws.workspaceFolders;
  ws.workspaceFolders = [{ uri: vscode.Uri.file(ROOT), name: "root", index: 0 }];
  let error: unknown;
  // Stop the automatic follow-up review so only the first transition is observed.
  const commandsObj = vscode.commands as unknown as {
    _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
  };
  const origOverride = commandsObj._executeCommandOverride;
  commandsObj._executeCommandOverride = (): Promise<unknown> => Promise.resolve(true);
  try {
    const outcome: TaskActionOutcomeV1 = {
      kind: "completed",
      code: "completed",
      correlation: {
        actionKey: "review.v1",
        operationId: "0".repeat(32),
        attemptId: "1".repeat(32),
        taskBindingId: "2".repeat(32),
        chatDocumentId: "3".repeat(32),
      },
      provider: { providerLabel: "Codex", storedModelId: "codex-cli:gpt-5.6" },
    };
    try {
      await handleReviewOutcomeV1(outcome, {
        extensionUri: vscode.Uri.file(ROOT),
        folderUri,
        workspaceUri: vscode.Uri.file(ROOT),
        currentStage: "impl-high-review",
        targetStage: "impl-high-review",
        reviewUri,
        variables: {},
        reviewAttemptId: "attempt-latched",
        modelId: "codex-cli:gpt-5.6",
        providerId: "codex-cli",
      });
    } catch (err) {
      error = err;
    }
    return {
      error,
      decisionKeys: new WorkflowDecisionStoreV1(memento).listPending().map((d) => d.decisionKey),
      latchedCards: new WorkflowDecisionStoreV1(memento)
        .listPending()
        .filter((d) => d.decisionKey === "latchedCleanReviewOpenItems"),
      entries: surface.entries,
      planFinal: fs.readFileSync(planFinalUri.fsPath, "utf8"),
      stage: (
        JSON.parse(fs.readFileSync(path.join(folderUri.fsPath, "task-progress.json"), "utf8")) as TaskProgress
      ).currentStage,
      postedTickDecisions: new WorkflowDecisionStoreV1(memento)
        .listPending()
        .filter((d) => d.decisionKey === "applyReviewerVerifiedTicks").length,
      pendingTickCards: surface.entries.filter((e) => /verified complete/i.test(e.message)).length,
    };
  } finally {
    commandsObj._executeCommandOverride = origOverride;
    ws.workspaceFolders = origFolders;
    for (const [key, value] of originals) {
      settingsModule[key] = value;
    }
    modelSelectionModule.resolveConfiguredReviewStages = origConfiguredStages;
    __extensionContextV1TestOnly.reset();
    deactivateNotificationRouter();
    bridge.restore();
  }
}

const CLEAN = reviewText({});
const NOTICE = "Advancing: the review is clean; the plan checklist is behind and is not used to hold the stage.";

void describe("RC8 item 4: a clean review advances while the checklist is flagged unreliable", () => {
  void it("(a) latched, zero blockers, plan items still open: does not advance; one chat card offers Move on and Back to Implementation", async () => {
    const { entries, stage, error, latchedCards } = await route("latched-clean", { latched: true, review: CLEAN });
    assert.equal(error, undefined, "routing completed without throwing");
    assert.equal(stage, "impl-high-review", "the stage is not advanced by itself while plan items are open");
    const messages = entries.map((e) => e.message);
    assert.ok(!messages.some((m) => m.includes("Auto-advancing stage")));
    assert.ok(!messages.some((m) => m.includes(NOTICE)), "the silent 'not used to hold the stage' notice is gone");
    assert.equal(latchedCards.length, 1, "exactly one card");
    const card = latchedCards[0]!;
    assert.match(card.whatHappened, /3 plan items are still open/);
    assert.match(card.whatHappened, /Item two/);
    assert.deepEqual(card.options.map((o) => o.label).sort(), ["Back to Implementation", "Move on"]);
    // An open item asks for a build, so Back to Implementation is recommended.
    assert.equal(card.recommendation.kind === "option" ? card.recommendation.optionId : undefined, "backToImplementation");
    const moveOn = card.options.find((o) => o.optionId === "moveOn")!;
    assert.equal(moveOn.effect.kind, "command");
    if (moveOn.effect.kind === "command") {
      assert.equal(moveOn.effect.command, "vs-code-ai-helper.resumeAndSetTaskStage");
      assert.equal((moveOn.effect.args?.[0] as { stage: string }).stage, "impl-low-review");
    }
    const back = card.options.find((o) => o.optionId === "backToImplementation")!;
    if (back.effect.kind === "command") {
      assert.equal((back.effect.args?.[0] as { stage: string }).stage, "impl");
    }
  });

  void it("(a1) a Fast Forward run reaching the card stops there; Move on is built to continue the run", async () => {
    const folderPath = path.join(ROOT, ".ensemble", "latched-ff");
    markFastForwardRunActiveV1(folderPath);
    try {
      const { latchedCards, stage } = await route("latched-ff", { latched: true, review: CLEAN });
      assert.equal(stage, "impl-high-review", "the run waits for the owner");
      assert.equal(latchedCards.length, 1);
      const moveOn = latchedCards[0]!.options.find((o) => o.optionId === "moveOn")!;
      assert.ok(moveOn.effect.kind === "command");
      if (moveOn.effect.kind === "command") {
        assert.equal((moveOn.effect.args?.[0] as { resumeFastForward: boolean }).resumeFastForward, true);
      }
    } finally {
      clearFastForwardRunActiveV1(folderPath);
    }
  });

  void it("(a2) latched, clean, every open item is a verification item: Move on is recommended", async () => {
    const plan = [
      "<!-- ensemble:implementation-checklist -->",
      "",
      "- [x] 1. Item one",
      "- [ ] 2. Verify the fix by running the unit tests on the dev box",
      "",
    ].join("\n");
    const { latchedCards, stage } = await route("latched-verification", { latched: true, review: CLEAN, plan });
    assert.equal(stage, "impl-high-review");
    assert.equal(latchedCards.length, 1);
    const recommendation = latchedCards[0]!.recommendation;
    assert.equal(recommendation.kind === "option" ? recommendation.optionId : undefined, "moveOn");
  });

  void it("(a3) latched self-ticks do not advance without reviewer verification", async () => {
    const plan = ["<!-- ensemble:implementation-checklist -->", "", "- [x] 1. Item one", "- [x] 2. Item two", ""].join("\n");
    const { entries, stage } = await route("latched-nothing-open", { latched: true, review: CLEAN, plan });
    assert.equal(stage, "impl-high-review");
    assert.ok(!entries.some((e) => e.message.includes("Auto-advancing stage")));
  });

  void it("(a4) latched, exclusions plus reviewer ticks settle every item: advances, no card", async () => {
    const plan = PLAN_FINAL.replace("- [x] 1. Item one", "- [ ] 1. Item one <!-- ensemble:excluded -->");
    const review = reviewText({ verified: ["2. Item two", "3. Item three", "4. Item four"] });
    const { stage, latchedCards, entries, planFinal } = await route("latched-ticked-all", { latched: true, review, plan });
    assert.equal(latchedCards.length, 0);
    assert.equal(stage, "impl-low-review", JSON.stringify({ entries, planFinal }));
  });

  void it("(f) item 10: a clean-scoring review whose verdict says steps remain to be built, with no completion blocker, is held with a chat card", async () => {
    const plan = ["<!-- ensemble:implementation-checklist -->", "", "- [x] 1. Item one", "- [x] 2. Item two", ""].join("\n");
    const review = reviewText({
      verdict: "On track — 41 of 94 checklist items are settled. Next, finish Step 6's caller handling and tests.",
      progress: "2/2",
    });
    const { stage, entries, decisionKeys } = await route("unbuilt-contradiction", { latched: false, review, plan });
    assert.equal(stage, "impl-high-review", "the stage is held");
    assert.ok(!entries.some((e) => e.message.includes("Auto-advancing stage")));
    assert.ok(decisionKeys.includes("reviewNamesUnbuiltSteps"), "the card says why the stage was held");
  });

  void it("(f2) built-but-unticked wording is not a contradiction, but self-ticks still need verification", async () => {
    const plan = ["<!-- ensemble:implementation-checklist -->", "", "- [x] 1. Item one", "- [x] 2. Item two", ""].join("\n");
    const review = reviewText({
      verdict: "Ready — Steps 3 and 4 are built but not ticked and are listed under Verified Complete.",
      progress: "2/2",
    });
    const { stage, entries, decisionKeys } = await route("built-not-ticked", { latched: false, review, plan });
    assert.equal(stage, "impl-high-review", JSON.stringify({ entries, decisionKeys }));
    assert.ok(!decisionKeys.includes("reviewNamesUnbuiltSteps"));
  });

  void it("(b) not latched, same input: an open checklist still holds the stage", async () => {
    const { entries, stage } = await route("unlatched-clean", { latched: false, review: CLEAN });
    assert.equal(stage, "impl-high-review");
    const messages = entries.map((e) => e.message);
    assert.ok(messages.some((m) => m.includes("Staying on this stage to build the rest.")));
    assert.ok(!messages.some((m) => m.includes("Auto-advancing stage")));
    assert.ok(!messages.some((m) => m.includes(NOTICE)));
  });

  void it("(c) latched with one blocker: does not advance", async () => {
    const review = reviewText({ blockers: ["- [completion] [task-fixable] The retry path is not built."] });
    const { entries, stage } = await route("latched-blocker", { latched: true, review });
    assert.equal(stage, "impl-high-review");
    const messages = entries.map((e) => e.message);
    assert.ok(!messages.some((m) => m.includes("Auto-advancing stage")));
    assert.ok(!messages.some((m) => m.includes(NOTICE)));
  });

  void it("(d) latched: ticks the review verified are applied before the decision, with no tick card", async () => {
    const review = reviewText({ verified: ["2. Item two", "3. Item three"] });
    const { entries, planFinal, pendingTickCards, postedTickDecisions } = await route("latched-ticks", { latched: true, review });
    assert.match(planFinal, /- \[x\] 2\. Item two/);
    assert.match(planFinal, /- \[x\] 3\. Item three/);
    assert.match(planFinal, /- \[ \] 4\. Item four/);
    assert.equal(
      entries.filter((e) => /named \d+ plan item\(s\) as verified complete/.test(e.message)).length,
      0,
      "no fallback tick notice"
    );
    assert.equal(pendingTickCards, 0);
    assert.equal(postedTickDecisions, 0, "no tick card is posted when the ticks were applied");
    assert.ok(entries.some((e) => e.message.includes("Applied 2 reviewer-verified tick(s)")));
  });

  void it("(e) not latched, same review: the tick card is offered and plan-final.md is unchanged", async () => {
    const review = reviewText({ verified: ["2. Item two", "3. Item three"] });
    const { planFinal, entries, postedTickDecisions } = await route("unlatched-ticks", { latched: false, review });
    assert.equal(planFinal, PLAN_FINAL, "nothing is ticked without the owner's confirmation");
    assert.ok(!entries.some((e) => e.message.includes("Applied 2 reviewer-verified tick(s)")));
    assert.equal(postedTickDecisions, 1, "the unlatched review posts the verified-complete card");
  });
});
