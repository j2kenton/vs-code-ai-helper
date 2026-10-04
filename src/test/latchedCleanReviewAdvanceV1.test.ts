/**
 * RC8 item 4: while the checklist is flagged unreliable (the under-recording
 * latch), a review that meets the auto-advance threshold with zero blockers
 * advances; the count the review echoes does not hold it. The reviewer's
 * verified-complete ticks are applied before the decision. Without the latch,
 * an open checklist still holds the stage as before.
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

function reviewText(options: { blockers?: string[]; verified?: string[] }): string {
  return [
    "# Implementation Review",
    "",
    "Readiness: 9/10",
    "",
    "<!-- progress: 29/90 -->",
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
  options: { latched: boolean; review: string }
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
  fs.writeFileSync(planFinalUri.fsPath, PLAN_FINAL);

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
  void it("(a) latched, zero blockers: advances with the new notice and never says it is staying", async () => {
    const { entries, stage, error } = await route("latched-clean", { latched: true, review: CLEAN });
    assert.equal(error, undefined, "routing completed without throwing");
    assert.equal(stage, "impl-low-review", "the task actually advanced to Low-Level Code Review");
    const messages = entries.map((e) => e.message);
    assert.ok(messages.some((m) => m.includes(NOTICE)), "the notice says the checklist is not used to hold the stage");
    assert.ok(messages.some((m) => m.includes("Auto-advancing stage")));
    assert.ok(
      messages.findIndex((m) => m.includes(NOTICE)) < messages.findIndex((m) => m.includes("Auto-advancing stage")),
      "the notice comes before the Auto-advancing line"
    );
    assert.ok(!messages.some((m) => m.includes("Staying on this stage")));
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
