/**
 * RC9 item 2: at Publish, Fast Forward runs the review after the checks with
 * no "Run Publish Review" card, withdraws a card once its action has run, and
 * never reports a completed Publish review as "did not produce usable output".
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  classifyPublishInitialRereadV1,
  completedReviewAttemptSinceV1,
  handleReviewRoutingOutcome,
  describePublishRanButUnusableV1,
  reviewAttemptBaselineV1,
  type CompletedReviewAttemptV1,
} from "../commands/reviewActions";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import type { TaskProgress } from "../types/taskProgress";
import { offerActionInChatV1 } from "../utils/chatActionOfferV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import { fixtureOwnershipFor } from "./taskFolderFixture";
import { safeRemoveDir } from "./testFsUtils";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-ff-publish-rc9-"));
after(() => {
  safeRemoveDir(ROOT);
});

const read = (...parts: string[]): string => fs.readFileSync(path.join(process.cwd(), ...parts), "utf8");

function historyEntry(attemptId: string, at: string, score: number | null = 8, stage = "publish"): never {
  return { stage, score, attemptId, at, blockerCount: 0, taskFixableCount: 0 } as never;
}

function rejectionEntry(attemptId: string, at: string, stage = "publish"): never {
  return { stage, attemptId, at, reason: "no Readiness line" } as never;
}

function progressWith(extra: Partial<TaskProgress>): TaskProgress {
  return {
    taskFolder: "x",
    currentStage: "publish",
    status: "active",
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
    ...extra,
  } as TaskProgress;
}

function writeTask(name: string, extra: Partial<TaskProgress> | undefined): vscode.Uri {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  if (extra !== undefined) {
    const progress = { ...progressWith(extra), taskFolder: name, ownership: fixtureOwnershipFor(dir) };
    fs.writeFileSync(path.join(dir, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
  }
  return vscode.Uri.file(dir);
}

function stubReadFile(impl: (uri: vscode.Uri) => Promise<Uint8Array>): () => void {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const original = target.readFile;
  target.readFile = impl;
  return () => {
    target.readFile = original;
  };
}

const diskRead = (uri: vscode.Uri): Promise<Uint8Array> =>
  fs.promises.readFile(uri.fsPath).then((buffer) => new Uint8Array(buffer));

const T0 = Date.parse("2026-10-04T08:30:00.000Z");

void describe("reviewAttemptBaselineV1 (RC9 item 2)", () => {
  void it("a successful read gives an ids baseline of only this stage's ids, from both lists", () => {
    const progress = progressWith({
      reviewScoreHistory: [historyEntry("a1", "2026-10-04T08:00:00.000Z"), historyEntry("o1", "2026-10-04T08:01:00.000Z", 5, "impl-low-review")],
      reviewRejections: [rejectionEntry("r1", "2026-10-04T08:02:00.000Z"), rejectionEntry("o2", "2026-10-04T08:03:00.000Z", "plan")],
    });
    const baseline = reviewAttemptBaselineV1({ ok: true, decoded: { progress } }, "publish", T0);
    assert.equal(baseline.kind, "ids");
    assert.deepEqual([...(baseline.kind === "ids" ? baseline.ids : [])].sort(), ["a1", "r1"]);
  });

  void it("a missing read and a decoder failure give afterTime", () => {
    assert.deepEqual(reviewAttemptBaselineV1({ ok: false }, "publish", T0), { kind: "afterTime", afterMs: T0 });
  });

  void it("through the real reader: a decoder failure (unsupported document) gives afterTime, not an ids baseline", async () => {
    const restoreDisk = stubReadFile(diskRead);
    try {
      const dir = path.join(ROOT, "undecodable");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "task-progress.json"), JSON.stringify({ schemaVersion: 99999, reviewScoreHistory: [] }), "utf8");
      const result = await readTaskProgressStrictV1(vscode.Uri.file(dir));
      assert.equal(result.ok, false);
      assert.deepEqual(reviewAttemptBaselineV1(result, "publish", T0), { kind: "afterTime", afterMs: T0 });
    } finally {
      restoreDisk();
    }
  });

  void it("through the real reader: EACCES and a missing file give afterTime; a prior Publish entry gives its id", async () => {
    const restoreDisk = stubReadFile(diskRead);
    try {
      const noFile = writeTask("no-progress-file", undefined);
      const missing = await readTaskProgressStrictV1(noFile);
      assert.deepEqual(reviewAttemptBaselineV1(missing, "publish", T0), { kind: "afterTime", afterMs: T0 });

      const withPrior = writeTask("prior-publish", {
        reviewScoreHistory: [historyEntry("prior-1", "2026-10-04T08:00:00.000Z")],
      });
      const ok = await readTaskProgressStrictV1(withPrior, { expectedTaskFolder: "prior-publish" });
      const baseline = reviewAttemptBaselineV1(ok, "publish", T0);
      assert.equal(baseline.kind, "ids");
      assert.ok(baseline.kind === "ids" && baseline.ids.has("prior-1"));
    } finally {
      restoreDisk();
    }
    const restoreDenied = stubReadFile(() => Promise.reject(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })));
    try {
      const denied = await readTaskProgressStrictV1(writeTask("denied", {}));
      assert.equal(denied.ok, false);
      assert.deepEqual(reviewAttemptBaselineV1(denied, "publish", T0), { kind: "afterTime", afterMs: T0 });
    } finally {
      restoreDenied();
    }
  });
});

void describe("completedReviewAttemptSinceV1 (RC9 item 2)", () => {
  const ids = (...list: string[]) => ({ kind: "ids" as const, ids: new Set(list) });
  const after0 = { kind: "afterTime" as const, afterMs: T0 };

  void it("finds a new scored entry, a new null-score entry, and a new rejection", () => {
    const scored = progressWith({ reviewScoreHistory: [historyEntry("old", "2026-10-04T08:00:00.000Z"), historyEntry("new", "2026-10-04T08:36:51.000Z", 9)] });
    assert.deepEqual(completedReviewAttemptSinceV1(scored, "publish", ids("old"), true), { attemptId: "new", score: 9, rejected: false });
    const nullScore = progressWith({ reviewScoreHistory: [historyEntry("new", "2026-10-04T08:36:51.000Z", null)] });
    assert.deepEqual(completedReviewAttemptSinceV1(nullScore, "publish", ids(), true), { attemptId: "new", score: null, rejected: false });
    const rejected = progressWith({ reviewRejections: [rejectionEntry("rej", "2026-10-04T08:36:51.000Z")] });
    assert.deepEqual(completedReviewAttemptSinceV1(rejected, "publish", ids(), true), { attemptId: "rej", score: null, rejected: true });
  });

  void it("ignores a prior attemptId even with an equal at, and other stages", () => {
    const progress = progressWith({
      reviewScoreHistory: [historyEntry("old", "2026-10-04T08:36:51.000Z"), historyEntry("other", "2026-10-04T08:40:00.000Z", 7, "impl-low-review")],
    });
    assert.equal(completedReviewAttemptSinceV1(progress, "publish", ids("old"), true), undefined);
  });

  void it("returns undefined when nothing was dispatched", () => {
    const progress = progressWith({ reviewScoreHistory: [historyEntry("new", "2026-10-04T08:36:51.000Z")] });
    assert.equal(completedReviewAttemptSinceV1(progress, "publish", ids(), false), undefined);
  });

  void it("afterTime: ignores older, equal and unparseable entries, and finds a later one", () => {
    const old = progressWith({
      reviewScoreHistory: [
        historyEntry("older", "2026-10-04T08:00:00.000Z"),
        historyEntry("equal", new Date(T0).toISOString()),
        historyEntry("garbled", "not a date"),
      ],
    });
    assert.equal(completedReviewAttemptSinceV1(old, "publish", after0, true), undefined);
    const later = progressWith({ reviewScoreHistory: [historyEntry("later", "2026-10-04T08:36:51.000Z", 9)] });
    assert.equal(completedReviewAttemptSinceV1(later, "publish", after0, true)?.attemptId, "later");
  });

  void it("end to end: an EACCES baseline and a fresh read holding only an older Publish entry finds nothing", async () => {
    const restoreDenied = stubReadFile(() => Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" })));
    let baseline;
    try {
      baseline = reviewAttemptBaselineV1(await readTaskProgressStrictV1(writeTask("e2e-denied", {})), "publish", T0);
    } finally {
      restoreDenied();
    }
    const restoreDisk = stubReadFile(diskRead);
    try {
      const uri = writeTask("e2e-fresh", { reviewScoreHistory: [historyEntry("older", "2026-10-04T08:00:00.000Z", 9)] });
      const fresh = await readTaskProgressStrictV1(uri, { expectedTaskFolder: "e2e-fresh" });
      assert.ok(fresh.ok);
      assert.equal(
        completedReviewAttemptSinceV1(fresh.ok ? fresh.decoded.progress : progressWith({}), "publish", baseline, true),
        undefined
      );
    } finally {
      restoreDisk();
    }
  });
});

void describe("classifyPublishInitialRereadV1 / describePublishRanButUnusableV1 (RC9 item 2)", () => {
  const attempt = (score: number | null, rejected = false): CompletedReviewAttemptV1 => ({ attemptId: "a", score, rejected });
  const usable = "# Review\n\nReadiness: 9/10\n";

  void it("usable stays usable, even with a recorded attempt", () => {
    assert.deepEqual(classifyPublishInitialRereadV1(usable, attempt(9)), { kind: "usable" });
    assert.deepEqual(classifyPublishInitialRereadV1(usable, undefined), { kind: "usable" });
  });

  void it("unusable with no attempt is notRun", () => {
    assert.deepEqual(classifyPublishInitialRereadV1(undefined, undefined), { kind: "notRun" });
    assert.deepEqual(classifyPublishInitialRereadV1("no score here", undefined), { kind: "notRun" });
  });

  void it("with an attempt, empty / stale / no-Readiness reads are ranButUnusable with the matching cause", () => {
    assert.deepEqual(classifyPublishInitialRereadV1(undefined, attempt(9)), { kind: "ranButUnusable", score: 9, rejected: false, cause: "empty" });
    assert.deepEqual(classifyPublishInitialRereadV1("# Review Stale\n", attempt(9)), { kind: "ranButUnusable", score: 9, rejected: false, cause: "stale" });
    assert.deepEqual(classifyPublishInitialRereadV1("only checks", attempt(9)), { kind: "ranButUnusable", score: 9, rejected: false, cause: "noReadiness" });
  });

  void it("a null-score attempt in either list is ranButUnusable with the matching rejected, never notRun", () => {
    assert.deepEqual(classifyPublishInitialRereadV1("only checks", attempt(null)), { kind: "ranButUnusable", score: null, rejected: false, cause: "noReadiness" });
    assert.deepEqual(classifyPublishInitialRereadV1("only checks", attempt(null, true)), { kind: "ranButUnusable", score: null, rejected: true, cause: "noReadiness" });
  });

  void it("the reason names the actual cause, scored and unscored", () => {
    const scored = (cause: "empty" | "stale" | "noReadiness") => describePublishRanButUnusableV1({ kind: "ranButUnusable", score: 9, rejected: false, cause });
    const unscored = (cause: "empty" | "stale" | "noReadiness") => describePublishRanButUnusableV1({ kind: "ranButUnusable", score: null, rejected: false, cause });
    assert.equal(scored("empty"), "the Publish review scored 9/10 but publish-review.md is empty");
    assert.equal(scored("stale"), "the Publish review scored 9/10 but publish-review.md still holds a stale placeholder or banner");
    assert.equal(scored("noReadiness"), "the Publish review scored 9/10 but publish-review.md has no Readiness line");
    assert.equal(unscored("empty"), "the Publish review ran but produced no Readiness score, and publish-review.md is empty");
    assert.equal(unscored("stale"), "the Publish review ran but produced no Readiness score, and publish-review.md still holds a stale placeholder or banner");
    assert.equal(unscored("noReadiness"), "the Publish review ran but produced no Readiness score, and publish-review.md has no Readiness line");
  });
});

void describe("source wiring (RC9 item 2)", () => {
  const reviewActions = read("src", "commands", "reviewActions.ts");
  const publishChecks = read("src", "commands", "runPublishChecks.ts");
  const ffStart = reviewActions.indexOf("export async function fastForwardReviewWithAI");
  const ffSource = reviewActions.slice(ffStart);
  const branchStart = ffSource.indexOf("if (!initialContent) {");
  const branchEnd = ffSource.indexOf("RC5 items 1 and 2: the initial review above can move the task", branchStart);
  const branch = ffSource.slice(branchStart, branchEnd);

  void it("(b) with a parent operation the checks post no review card and say the review runs next", () => {
    assert.match(publishChecks, /parentOperation !== undefined && nextStepOffer\.action\.command !== COMMIT_AND_PUSH_COMMAND_V1/);
    assert.match(publishChecks, /Fast Forward runs the Publish review next\./);
    assert.match(publishChecks, /actionLabel: nextStepOffer\.action\.title/, "other callers keep today's card");
  });

  void it("(c) the !initialContent branch dispatches the review with no card between the checks gate and the dispatch", () => {
    const checksGate = ffSource.indexOf("savedChecksPassed");
    const dispatchAt = ffSource.indexOf("runReviewForFolder(extensionUri", branchStart);
    assert.ok(checksGate > 0 && dispatchAt > checksGate);
    assert.doesNotMatch(ffSource.slice(checksGate, dispatchAt), /offerActionInChatV1\(/);
    const baselineAt = branch.indexOf("Date.now()");
    assert.ok(baselineAt > 0 && baselineAt < branch.indexOf("runReviewForFolder(extensionUri"));
    assert.ok(branch.indexOf("readTaskProgressStrictV1") < branch.indexOf("runReviewForFolder(extensionUri"));
    assert.doesNotMatch(branch, /readTaskProgressAdvisoryV1/);
    assert.match(branch, /completedReviewAttemptSinceV1\([\s\S]{0,200}ffInitialReviewProbe\.dispatched/);
  });

  void it("(g) ranButUnusable settles failed and offers a card; usable shows no warning before the stage-drift check", () => {
    const ranStart = branch.indexOf('classified.kind === "ranButUnusable"', branch.indexOf("const classified"));
    const ranBranch = branch.slice(ranStart, branch.indexOf("return false;", ranStart));
    assert.match(ranBranch, /op\.settleAs\("failed"/);
    assert.match(ranBranch, /offerActionInChatV1\(/);
    assert.doesNotMatch(ranBranch, /describeUnusableReviewBlockV1/);
    const usableStart = branch.indexOf('classified.kind === "usable"');
    const usableBranch = branch.slice(usableStart, branch.indexOf("} else if", usableStart));
    assert.doesNotMatch(usableBranch, /showWarning/);
  });

  void it("a landed review withdraws the Run Review card; Publish Checks and Resume withdraw theirs", () => {
    assert.match(reviewActions, /"chatActionOffer:runReviewWithAI"/);
    assert.match(publishChecks, /"chatActionOffer:runPublishChecks"/);
    assert.match(read("src", "commands", "resumeTask.ts"), /"chatActionOffer:resumeTask"/);
  });
});

void describe("a landed review leaves no Run Review card pending (RC9 item 2, h)", () => {
  void it("a review landing through handleReviewRoutingOutcome withdraws the pending card", async () => {
    const dir = path.join(ROOT, "plans", "landed-task");
    fs.mkdirSync(dir, { recursive: true });
    const progress = {
      ensembleProgressVersion: 1,
      ...progressWith({}),
      currentStage: "impl-high-review",
      taskFolder: "landed-task",
      ownership: {
        metaRoot: path.join(ROOT, "plans"),
        projectRoot: ROOT,
        workspaceRoot: ROOT,
        boundAt: "2026-01-01T00:00:00.000Z",
      },
      roundLedger: [
        {
          roundId: "attempt-landed-1",
          attemptIds: ["attempt-landed-1"],
          stage: "impl-high-review",
          mode: "review",
          startedAt: "2026-01-01T00:05:00.000Z",
          state: "open",
        },
      ],
    };
    fs.writeFileSync(path.join(dir, "task-progress.json"), JSON.stringify(progress), "utf8");
    const backing = new Map<string, unknown>();
    const memento = {
      keys: (): readonly string[] => [...backing.keys()],
      get: <T>(key: string, defaultValue?: T): T | undefined => (backing.has(key) ? (backing.get(key) as T) : defaultValue),
      update: (key: string, value: unknown): Thenable<void> => {
        if (value === undefined) {
          backing.delete(key);
        } else {
          backing.set(key, value);
        }
        return Promise.resolve();
      },
    } as vscode.Memento;
    __extensionContextV1TestOnly.set({
      subscriptions: [],
      extensionUri: vscode.Uri.file(ROOT),
      workspaceState: memento,
      globalState: memento,
    } as unknown as vscode.ExtensionContext);
    const fsTarget = vscode.workspace.fs as unknown as Record<string, unknown>;
    const fsOrig = { ...fsTarget };
    fsTarget.readFile = diskRead;
    fsTarget.writeFile = async (uri: vscode.Uri, content: Uint8Array): Promise<void> => {
      await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
      await fs.promises.writeFile(uri.fsPath, content);
    };
    fsTarget.rename = async (source: vscode.Uri, dest: vscode.Uri): Promise<void> => {
      await fs.promises.rm(dest.fsPath, { force: true });
      await fs.promises.rename(source.fsPath, dest.fsPath);
    };
    fsTarget.delete = (uri: vscode.Uri): Promise<void> => fs.promises.rm(uri.fsPath, { force: true, recursive: true });
    fsTarget.createDirectory = (uri: vscode.Uri): Promise<void> =>
      fs.promises.mkdir(uri.fsPath, { recursive: true }).then(() => undefined);
    fsTarget.readDirectory = async (uri: vscode.Uri): Promise<[string, number][]> =>
      (await fs.promises.readdir(uri.fsPath, { withFileTypes: true })).map((e) => [e.name, e.isDirectory() ? 2 : 1]);
    fsTarget.stat = async (uri: vscode.Uri): Promise<unknown> => {
      const st = await fs.promises.stat(uri.fsPath);
      return { type: st.isDirectory() ? 2 : 1, size: st.size, ctime: st.ctimeMs, mtime: st.mtimeMs };
    };
    const wsTarget = vscode.workspace as unknown as Record<string, unknown>;
    const wsOrig = wsTarget.workspaceFolders;
    wsTarget.workspaceFolders = [{ uri: vscode.Uri.file(ROOT), name: "root", index: 0 }];
    initNotificationRouter({ addEntry: (): void => {} });
    try {
      await offerActionInChatV1({
        taskFolderPath: dir,
        actionLabel: "Run Publish Review",
        command: "vs-code-ai-helper.runReviewWithAI",
        args: [{ taskFolderPath: dir }],
        noticeText: "Publish checks passed.",
      });
      const store = new WorkflowDecisionStoreV1(memento);
      const pending = (): number =>
        store.listPending().filter((d) => d.decisionKey === "chatActionOffer:runReviewWithAI").length;
      assert.equal(pending(), 1, "the card is pending before the review lands");
      await handleReviewRoutingOutcome({
        folderUri: vscode.Uri.file(dir),
        targetStage: "impl-high-review",
        reviewAttemptId: "attempt-landed-1",
        content: "Readiness: 9/10\n\n<!-- blockers:start -->\n<!-- blockers:end -->\n",
        score: 9,
        threshold: 8,
      });
      assert.equal(pending(), 0, "a review that lands leaves no Run Review card pending");
    } finally {
      deactivateNotificationRouter();
      wsTarget.workspaceFolders = wsOrig;
      for (const key of ["readFile", "writeFile", "rename", "delete", "createDirectory", "readDirectory", "stat"]) {
        fsTarget[key] = fsOrig[key];
      }
      __extensionContextV1TestOnly.reset();
    }
  });
});
