/**
 * review1 Steps 31 and 36: the owner's own settlement makes the stage ready, and the "<Stage> is done" card follows at
 * once, but only when the review on record describes the code as it is now. Also Step 18: the Implementation dispatch
 * after a review fits the review into the input limit with the same renderer Apply Review uses.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  postStageReadyCardIfReadyV1,
  reviewDescribesCurrentWorkspaceV1,
  type StageReadyWorkspaceIdentityV1,
} from "../commands/automationStoppedCardV1";
import { fitApplyReviewPartsToCanonicalLimitV1, type ApplyReviewPartsV1 } from "../commands/reviewActions";
import { applySettleChecklistItemV1 } from "../commands/settleChecklistItem";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { MAX_INPUT_SNAPSHOT_CANONICAL_BYTES_V1 } from "../types/chatInteractionTransactionV1";
import { setExtensionContextV1 } from "../utils/extensionContextV1";
import { settleChecklistItemV1 } from "../utils/implementationChecklist";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import { recordReviewInputsV1 } from "../utils/reviewInputsChangedV1";
import { makeOwnedTaskFolder } from "./taskFolderFixture";
import { safeRemoveDir } from "./testFsUtils";

const REVIEWED_SHA = "1111111111111111111111111111111111111111";
const REVIEWED_FINGERPRINT = "a".repeat(64);

const CLEAN_REVIEW = [
  "Readiness: 9/10",
  "",
  "## Summary verdict",
  "",
  "On track. Nothing blocks the stage.",
  "",
  "<!-- blockers:start -->",
  "<!-- blockers:end -->",
  "",
  `<!-- reviewed-commit: ${REVIEWED_SHA} -->`,
  `<!-- reviewed-tree-fingerprint: ${REVIEWED_FINGERPRINT} -->`,
  "<!-- progress: 1/2 -->",
  "",
].join("\n");

const PLAN_BEFORE = "<!-- ensemble:implementation-checklist -->\n\n# Plan\n\n- [ ] Owner check on the live window\n- [ ] Second owner check\n";

function setStageAndStatus(folder: string): void {
  const progressPath = path.join(folder, "task-progress.json");
  const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as Record<string, unknown>;
  progress.currentStage = "impl-high-review";
  progress.status = "active";
  fs.writeFileSync(progressPath, JSON.stringify(progress));
}

void describe("the stage-ready card follows the owner's last settlement (Steps 31 and 36)", () => {
  const roots: string[] = [];
  const fsApi = vscode.workspace.fs as unknown as Record<string, unknown>;
  const original = { ...fsApi };
  const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
  let backing = new Map<string, unknown>();
  let memento: vscode.Memento;

  beforeEach(() => {
    initNotificationRouter({ addEntry: () => undefined } as unknown as Parameters<typeof initNotificationRouter>[0]);
    fsApi.readFile = (uri: vscode.Uri): Promise<Uint8Array> => fs.promises.readFile(uri.fsPath);
    fsApi.writeFile = (uri: vscode.Uri, data: Uint8Array): Promise<void> => fs.promises.writeFile(uri.fsPath, data);
    fsApi.createDirectory = (): Promise<void> => Promise.resolve();
    fsApi.readDirectory = (): Promise<Array<[string, number]>> => Promise.resolve([]);
    fsApi.stat = (uri: vscode.Uri): Promise<unknown> => fs.promises.stat(uri.fsPath);
    backing = new Map();
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
    (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = originalWorkspaceFolders;
    setExtensionContextV1(undefined as unknown as vscode.ExtensionContext);
    deactivateNotificationRouter();
    for (const root of roots.splice(0)) safeRemoveDir(root);
  });

  /** A stage with a clean review on record, whose last two plan items the owner then settles. */
  async function stageWithCleanReview(): Promise<{ folder: string; settledPlan: string }> {
    const { folder } = makeOwnedTaskFolder("ready-card-");
    roots.push(path.dirname(path.dirname(folder)));
    // The owning workspace: the helper compares the review's code identity against it (the injected identity
    // replaces the git reads, but the helper must still know there is a workspace to ask).
    (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = [
      { uri: vscode.Uri.file(path.dirname(path.dirname(folder))), name: "ws", index: 0 },
    ];
    setStageAndStatus(folder);
    fs.writeFileSync(path.join(folder, "plan-final.md"), PLAN_BEFORE);
    const review = path.join(folder, "impl-high-review.md");
    fs.writeFileSync(review, CLEAN_REVIEW);
    await recordReviewInputsV1(folder, review, { headSha: REVIEWED_SHA, treeFingerprint: REVIEWED_FINGERPRINT });
    const future = Date.now() / 1000 + 60;
    fs.utimesSync(review, future, future);
    // The same text the real settle command writes for an owner exclusion, with its note.
    const first = settleChecklistItemV1(PLAN_BEFORE, "Owner check on the live window", "exclude", "mine to do after deploy");
    const second = settleChecklistItemV1(first.content, "Second owner check", "exclude", "mine to do after deploy");
    return { folder, settledPlan: second.content };
  }

  const identity = (fingerprint: string | undefined, sha: string | undefined = REVIEWED_SHA): (() => Promise<StageReadyWorkspaceIdentityV1>) =>
    () => Promise.resolve({ headSha: sha, treeFingerprint: fingerprint });

  void it("ticking the last item after a current, clean review posts the done card recommending the next stage", async () => {
    const { folder, settledPlan } = await stageWithCleanReview();
    fs.writeFileSync(path.join(folder, "plan-final.md"), settledPlan);
    const result = await postStageReadyCardIfReadyV1(folder, "After your exclusion", {
      readWorkspaceIdentity: identity(REVIEWED_FINGERPRINT),
    });
    assert.equal(result.posted, true, "the owner's own settlement completes the gate, so the stage says it is ready");
    const card = new WorkflowDecisionStoreV1(memento).listPending(folder).find((d) => d.decisionKey === "automationStopped");
    assert.ok(card, "one automationStopped card is pending");
    assert.match(card.whatHappened, /Code Review is done/);
    const moveOn = card.options.find((o) => o.optionId === "moveOn");
    assert.ok(moveOn && /Move on to Low-Level Code Review/.test(moveOn.label), "Move on is offered");
    assert.ok(card.recommendation.kind === "option" && card.recommendation.optionId === "moveOn", "and it is the recommended option");
  });

  void it("an owner TICK on the last open items (not an exclusion) after a clean review posts the done card", async () => {
    const { folder } = await stageWithCleanReview();
    // The real settle path: it writes the ticked line and records the owner's row the gate counts.
    const first = await applySettleChecklistItemV1(folder, "Owner check on the live window", "tick", "checked by hand");
    const second = await applySettleChecklistItemV1(folder, "Second owner check", "tick", "checked by hand");
    assert.equal(first.kind, "settled");
    assert.equal(second.kind, "settled");
    const plan = fs.readFileSync(path.join(folder, "plan-final.md"), "utf8");
    assert.match(plan, /- \[x\] Owner check on the live window/, "the box is ticked, not excluded");
    assert.doesNotMatch(plan, /Excluded by you/);
    const progress = JSON.parse(fs.readFileSync(path.join(folder, "task-progress.json"), "utf8")) as {
      planItemOwnerDecisions?: Array<{ decision: string }>;
    };
    assert.equal(progress.planItemOwnerDecisions?.filter((row) => row.decision === "tick").length, 2, "two owner tick rows are recorded");

    // The settle command's own (un-injectable) check cannot read a git identity here; the card is then checked
    // with the injected, matching one.
    const result = await postStageReadyCardIfReadyV1(folder, "After your tick", {
      readWorkspaceIdentity: identity(REVIEWED_FINGERPRINT),
    });
    assert.equal(result.posted, true, "owner ticks settle the gate, so the stage says it is ready");
    const card = new WorkflowDecisionStoreV1(memento).listPending(folder).find((d) => d.decisionKey === "automationStopped");
    assert.ok(card, "one automationStopped card is pending");
    assert.match(card.whatHappened, /Code Review is done/);
    assert.ok(card.recommendation.kind === "option" && card.recommendation.optionId === "moveOn", "Move on is the recommended option");
  });

  void it("an owner tick that leaves one item open posts nothing", async () => {
    const { folder } = await stageWithCleanReview();
    await applySettleChecklistItemV1(folder, "Owner check on the live window", "tick", "checked by hand");
    const result = await postStageReadyCardIfReadyV1(folder, "After your tick", {
      readWorkspaceIdentity: identity(REVIEWED_FINGERPRINT),
    });
    assert.equal(result.posted, false);
  });

  void it("a source file changed since the review leaves the tree fingerprint different, so no done card is posted", async () => {
    const { folder, settledPlan } = await stageWithCleanReview();
    fs.writeFileSync(path.join(folder, "plan-final.md"), settledPlan);
    const result = await postStageReadyCardIfReadyV1(folder, "After your exclusion", {
      readWorkspaceIdentity: identity("b".repeat(64)),
    });
    assert.equal(result.posted, false, "the review describes older code than the workspace holds");
    assert.deepEqual(new WorkflowDecisionStoreV1(memento).listPending(folder).filter((d) => d.decisionKey === "automationStopped"), []);
  });

  void it("an unknowable workspace identity (no repository) is not read as current", async () => {
    const { folder, settledPlan } = await stageWithCleanReview();
    fs.writeFileSync(path.join(folder, "plan-final.md"), settledPlan);
    const noFingerprint = await postStageReadyCardIfReadyV1(folder, "After your exclusion", {
      readWorkspaceIdentity: identity(undefined),
    });
    assert.equal(noFingerprint.posted, false);
    const noHead = await postStageReadyCardIfReadyV1(folder, "After your exclusion", {
      readWorkspaceIdentity: () => Promise.resolve({ headSha: undefined, treeFingerprint: REVIEWED_FINGERPRINT }),
    });
    assert.equal(noHead.posted, false);
  });

  void it("an item the owner has not settled yet posts nothing", async () => {
    const { folder } = await stageWithCleanReview();
    const first = settleChecklistItemV1(PLAN_BEFORE, "Owner check on the live window", "exclude", "mine");
    fs.writeFileSync(path.join(folder, "plan-final.md"), first.content);
    const result = await postStageReadyCardIfReadyV1(folder, "After your exclusion", {
      readWorkspaceIdentity: identity(REVIEWED_FINGERPRINT),
    });
    assert.equal(result.posted, false);
  });

  void it("a card answer that changed task.md leaves the review stale, so no done card is posted", async () => {
    const { folder, settledPlan } = await stageWithCleanReview();
    fs.writeFileSync(path.join(folder, "plan-final.md"), settledPlan);
    fs.writeFileSync(path.join(folder, "task.md"), "# Task\n\n## Owner decisions\n\n- decided something new\n");
    const result = await postStageReadyCardIfReadyV1(folder, "After your answer", {
      readWorkspaceIdentity: identity(REVIEWED_FINGERPRINT),
    });
    assert.equal(result.posted, false);
  });

  void it("only a code review's stamps are compared; a plan review carries none", () => {
    assert.equal(reviewDescribesCurrentWorkspaceV1("plan-high-review", "Readiness: 9/10", { headSha: undefined, treeFingerprint: undefined }), true);
    assert.equal(reviewDescribesCurrentWorkspaceV1("impl-high-review", CLEAN_REVIEW, { headSha: REVIEWED_SHA, treeFingerprint: REVIEWED_FINGERPRINT }), true);
    assert.equal(reviewDescribesCurrentWorkspaceV1("impl-high-review", CLEAN_REVIEW, { headSha: REVIEWED_SHA, treeFingerprint: "c".repeat(64) }), false);
    assert.equal(reviewDescribesCurrentWorkspaceV1("impl-low-review", "Readiness: 9/10\n", { headSha: REVIEWED_SHA, treeFingerprint: REVIEWED_FINGERPRINT }), false, "a review with no stamps cannot be shown current");
  });
});

void describe("the Implementation dispatch after a review fits the input like Apply Review (Step 18)", () => {
  const parts = (reviewChars: number | undefined, implChars: number | undefined): ApplyReviewPartsV1 => {
    const review = "R".repeat(Math.min(reviewChars ?? 40_000, 40_000));
    const implementation = "I".repeat(Math.min(implChars ?? 20_000, 20_000));
    return { prompt: `plan\n${review}\n${implementation}`, templateVariables: { review, implementation, approvedPlan: "plan" } };
  };

  void it("shrinks the review, then the notes, until the measured input fits", async () => {
    const seen: Array<[number | undefined, number | undefined]> = [];
    const fitted = await fitApplyReviewPartsToCanonicalLimitV1({
      usesCopilotModel: true,
      workspaceRootPath: "/unused",
      measureCanonicalBytes: (prompt) => prompt.length * 12,
      build: (maxReview, maxImpl) => {
        seen.push([maxReview, maxImpl]);
        return Promise.resolve(parts(maxReview, maxImpl));
      },
    });
    assert.ok(seen.length > 1, "the first build was over the limit, so it was rebuilt smaller");
    assert.equal(fitted.oversizedAfterShrink, false);
    assert.ok(fitted.lastCanonicalBytes <= MAX_INPUT_SNAPSHOT_CANONICAL_BYTES_V1);
    assert.ok(fitted.maxReviewChars !== undefined && fitted.maxReviewChars < 40_000, "the review was cut first");
  });

  void it("reports an input that stays over the limit at the floors instead of sending it", async () => {
    const fitted = await fitApplyReviewPartsToCanonicalLimitV1({
      usesCopilotModel: true,
      workspaceRootPath: "/unused",
      measureCanonicalBytes: () => 10_000_000,
      build: (maxReview, maxImpl) => Promise.resolve(parts(maxReview, maxImpl)),
    });
    assert.equal(fitted.oversizedAfterShrink, true);
    assert.equal(fitted.maxReviewChars, 2000);
    assert.equal(fitted.maxImplementationChars, 4000);
  });

  void it("a CLI-resolved model is not measured: one build, nothing shrunk", async () => {
    let builds = 0;
    const fitted = await fitApplyReviewPartsToCanonicalLimitV1({
      usesCopilotModel: false,
      workspaceRootPath: "/unused",
      build: () => {
        builds += 1;
        return Promise.resolve(parts(undefined, undefined));
      },
    });
    assert.equal(builds, 1);
    assert.equal(fitted.oversizedAfterShrink, false);
    assert.equal(fitted.maxReviewChars, undefined);
  });

  void it("both editing routes go through the shared renderer", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../../src/commands/reviewActions.ts"), "utf8");
    assert.equal((source.match(/await fitApplyReviewPartsToCanonicalLimitV1\(/g) ?? []).length, 2, "Apply Review and the Implementation dispatch");
    const implRoute = source.slice(source.indexOf("export async function runImplementationWithAI("));
    assert.ok(implRoute.includes("fitApplyReviewPartsToCanonicalLimitV1({"), "runImplementationWithAI measures and shrinks");
  });
});
