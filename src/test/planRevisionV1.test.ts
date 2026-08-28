/**
 * Coverage for wf "make the stage chat a record of work" Part 6 / items
 * 5, 19-20 — the "Revise the plan" / "Discard the proposal" decision that
 * anchors a caught checklist-item-set mutation, and the plan-revision
 * re-finalization merge in `preparePlanPromotion` (`implementationArtifactResolver.ts`).
 *
 *   1. Pure transforms: `markChecklistChangeProposalDiscardedV1`,
 *      `markChecklistChangeProposalAdoptedV1` (taskProgressTransforms.ts).
 *   2. Pure formatters: `formatPlanRevisionProposalVariableV1`,
 *      `listCheckedChecklistItemTextsV1` (implementationChecklist.ts).
 *   3. `preparePlanPromotion`'s plan-revision branch: republishes
 *      plan-final.md from the revised plan.md with prior ticks re-merged,
 *      marks the proposal adopted, clears `planRevision`, and appends a
 *      durable chat line — even though the canonical artifact already
 *      existed (the ordinary "nothing to do" short-circuit).
 *   4. `reviseChecklistChangeProposalConfirmedV1` / `discardChecklistChangeProposalConfirmedV1`
 *      command wiring end-to-end against a real (temp-dir-backed) task folder.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import { TaskProgress, ChecklistChangeProposalV1 } from "../types/taskProgress";
import {
  markChecklistChangeProposalAdoptedV1,
  markChecklistChangeProposalDiscardedV1,
} from "../utils/taskProgressTransforms";
import {
  formatPlanRevisionProposalVariableV1,
  listCheckedChecklistItemTextsV1,
} from "../utils/implementationChecklist";
import {
  preparePlanPromotion,
  PLAN_REVISION_JOURNAL_FILENAME,
  snapshotPlanForRevisionV1,
  applyDeferredPlanRevisionAdoptionV1,
  retryStuckPlanRevisionAdoptionV1,
  PlanRevisionAdoptionV1,
} from "../utils/implementationArtifactResolver";
import {
  discardChecklistChangeProposalConfirmedV1,
  reviseChecklistChangeProposalConfirmedV1,
} from "../commands/planRevisionV1";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { configureWorkflowPrivateStorageRootV1 } from "../services/workflowRuntimeServicesV1";
import { appendChatMessageV1, readChatHistory } from "../utils/chatHistoryStore";
import { deactivateNotificationRouter, initNotificationRouter, StatusSurface } from "../utils/notificationRouter";
import * as taskProgressWriterV1Module from "../services/taskProgressWriterV1";

interface PatchedFn { readonly restore: () => void }

function patchFn(module: Record<string, unknown>, name: string, replacement: unknown): PatchedFn {
  const orig = module[name];
  module[name] = replacement;
  return { restore: (): void => { module[name] = orig; } };
}

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-plan-revision-test-"));
const PRIVATE_STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-plan-revision-test-private-"));
configureWorkflowPrivateStorageRootV1(PRIVATE_STORAGE_ROOT);
after(() => {
  fs.rmSync(REAL_ROOT, { recursive: true, force: true });
});

function installFsBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = { ...target };
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  target.writeFile = async (uri: vscode.Uri, content: Uint8Array): Promise<void> => {
    await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
    await fs.promises.writeFile(uri.fsPath, content);
  };
  target.rename = async (source: vscode.Uri, dest: vscode.Uri): Promise<void> => {
    await fs.promises.rm(dest.fsPath, { force: true });
    await fs.promises.rename(source.fsPath, dest.fsPath);
  };
  target.delete = (uri: vscode.Uri): Promise<void> =>
    fs.promises.rm(uri.fsPath, { force: true, recursive: true });
  target.createDirectory = (uri: vscode.Uri): Promise<void> =>
    fs.promises.mkdir(uri.fsPath, { recursive: true }).then(() => undefined);
  target.readDirectory = async (uri: vscode.Uri): Promise<[string, number][]> => {
    const entries = await fs.promises.readdir(uri.fsPath, { withFileTypes: true });
    return entries.map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]);
  };
  target.stat = async (uri: vscode.Uri): Promise<{ type: number; size: number; ctime: number; mtime: number }> => {
    const stat = await fs.promises.stat(uri.fsPath);
    return { type: stat.isDirectory() ? 2 : 1, size: stat.size, ctime: stat.ctimeMs, mtime: stat.mtimeMs };
  };
  return {
    restore: (): void => {
      for (const key of ["readFile", "writeFile", "rename", "delete", "createDirectory", "readDirectory", "stat"]) {
        target[key] = orig[key];
      }
    },
  };
}

function installWorkspaceFoldersStub(): { restore: () => void } {
  const ws = vscode.workspace as unknown as Record<string, unknown>;
  const orig = ws.workspaceFolders;
  ws.workspaceFolders = [{ uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 }];
  return { restore: (): void => { ws.workspaceFolders = orig; } };
}

const PRE_REVISION_PLAN = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "## Part 1",
  "",
  "- [x] Split the artifacts",
  "- [ ] Wire the completeness gate",
  "",
].join("\n");

const REVISED_DRAFT_PLAN = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "## Part 1",
  "",
  "- [ ] Split the artifacts",
  "- [ ] Wire the completeness gate",
  "- [ ] Add the retry button",
  "",
].join("\n");

function makeTaskFolder(
  name: string,
  overrides: Partial<TaskProgress> = {}
): { folderPath: string; folderUri: vscode.Uri } {
  const folderPath = path.join(REAL_ROOT, "plans", name);
  fs.mkdirSync(folderPath, { recursive: true });
  const progress: TaskProgress & { ensembleProgressVersion: 1 } = {
    ensembleProgressVersion: 1,
    taskFolder: name,
    currentStage: "impl",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ownership: {
      metaRoot: path.join(REAL_ROOT, "plans"),
      projectRoot: REAL_ROOT,
      workspaceRoot: REAL_ROOT,
      boundAt: "2026-01-01T00:00:00.000Z",
    },
    ...overrides,
  };
  fs.writeFileSync(path.join(folderPath, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
  return { folderPath, folderUri: vscode.Uri.file(folderPath) };
}

function readProgress(folderPath: string): TaskProgress {
  return JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
}

function readPlanFinal(folderPath: string): string {
  return fs.readFileSync(path.join(folderPath, "plan-final.md"), "utf8");
}

const PENDING_PROPOSAL: ChecklistChangeProposalV1 = {
  at: "2026-08-28T00:00:00.000Z",
  roundId: "round-1",
  stage: "impl",
  kind: "added",
  proposedItems: ["Add the retry button"],
  removedItems: [],
  status: "pending",
};

void describe("markChecklistChangeProposalDiscardedV1 / markChecklistChangeProposalAdoptedV1", () => {
  void it("flips a pending entry to discarded and leaves others untouched", () => {
    const progress = {
      taskFolder: "t",
      currentStage: "impl",
      status: "active",
      createdAt: "x",
      updatedAt: "x",
      checklistChangeProposals: [PENDING_PROPOSAL],
    } as unknown as TaskProgress;
    const result = markChecklistChangeProposalDiscardedV1(progress, PENDING_PROPOSAL.at);
    assert.equal(result.checklistChangeProposals?.[0]?.status, "discarded");
  });

  void it("is a no-op when no pending entry matches", () => {
    const progress = {
      taskFolder: "t",
      currentStage: "impl",
      status: "active",
      createdAt: "x",
      updatedAt: "x",
      checklistChangeProposals: [{ ...PENDING_PROPOSAL, status: "discarded" as const }],
    } as unknown as TaskProgress;
    const result = markChecklistChangeProposalDiscardedV1(progress, PENDING_PROPOSAL.at);
    assert.equal(result, progress);
  });

  void it("flips a revising entry to adopted and clears planRevision", () => {
    const progress = {
      taskFolder: "t",
      currentStage: "plan",
      status: "active",
      createdAt: "x",
      updatedAt: "x",
      checklistChangeProposals: [{ ...PENDING_PROPOSAL, status: "revising" as const }],
      planRevision: {
        proposalAt: PENDING_PROPOSAL.at,
        startedAt: "x",
        stage: "impl" as const,
        discardedItems: ["Add the retry button"],
        removedItems: [],
        reason: "discovered work",
      },
    } as unknown as TaskProgress;
    const result = markChecklistChangeProposalAdoptedV1(progress, PENDING_PROPOSAL.at);
    assert.equal(result.checklistChangeProposals?.[0]?.status, "adopted");
    assert.equal(result.planRevision, undefined);
  });

  void it("adoption is a no-op when no revising entry matches", () => {
    const progress = {
      taskFolder: "t",
      currentStage: "plan",
      status: "active",
      createdAt: "x",
      updatedAt: "x",
      checklistChangeProposals: [PENDING_PROPOSAL],
    } as unknown as TaskProgress;
    const result = markChecklistChangeProposalAdoptedV1(progress, PENDING_PROPOSAL.at);
    assert.equal(result, progress);
  });
});

void describe("formatPlanRevisionProposalVariableV1 / listCheckedChecklistItemTextsV1", () => {
  void it("states explicitly that no revision is in flight", () => {
    const text = formatPlanRevisionProposalVariableV1(undefined, []);
    assert.match(text, /no plan revision is in flight/i);
  });

  void it("names the discarded items, restored items, and already-checked items", () => {
    const text = formatPlanRevisionProposalVariableV1(
      {
        reason: "a round tried to add a step",
        discardedItems: ["Add the retry button"],
        removedItems: ["Wire the completeness gate"],
      },
      ["Split the artifacts"]
    );
    assert.match(text, /Add the retry button/);
    assert.match(text, /Wire the completeness gate/);
    assert.match(text, /Split the artifacts/);
    assert.match(text, /never renumber, reword, or/i);
  });

  void it("lists only checked, non-excluded items in document order", () => {
    const plan = [
      "- [x] one",
      "- [ ] two",
      "- [x] three <!-- ensemble:excluded -->",
      "- [x] four",
    ].join("\n");
    assert.deepEqual(listCheckedChecklistItemTextsV1(plan), ["one", "four"]);
  });
});

void describe("preparePlanPromotion — plan-revision re-finalization (Part 6 / item 7)", () => {
  void it("republishes plan-final.md from the revised plan.md with prior ticks re-merged, even though canonical already exists", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder("revision-promotion", {
        currentStage: "plan-low-review",
        checklistChangeProposals: [{ ...PENDING_PROPOSAL, status: "revising" }],
        planRevision: {
          proposalAt: PENDING_PROPOSAL.at,
          startedAt: "2026-08-28T00:01:00.000Z",
          stage: "impl",
          discardedItems: ["Add the retry button"],
          removedItems: [],
          reason: "discovered work",
        },
      });
      fs.writeFileSync(path.join(folderPath, "plan-final.md"), PRE_REVISION_PLAN, "utf8");
      fs.writeFileSync(path.join(folderPath, "plan.md"), REVISED_DRAFT_PLAN, "utf8");

      const promotion = await preparePlanPromotion(folderUri);
      assert.equal(promotion.ready, true);
      assert.ok(promotion.ready && promotion.publish, "expected a publish() closure for the revision branch");
      await (promotion as { publish: () => Promise<void> }).publish();

      const finalContent = readPlanFinal(folderPath);
      // The pre-revision tick on "Split the artifacts" is preserved even
      // though the freshly-drafted plan.md reset it to unchecked, and the
      // new "Add the retry button" item survives untouched.
      assert.match(finalContent, /- \[x\] Split the artifacts/);
      assert.match(finalContent, /- \[ \] Wire the completeness gate/);
      assert.match(finalContent, /- \[ \] Add the retry button/);

      const progress = readProgress(folderPath);
      assert.equal(progress.planRevision, undefined);
      assert.equal(
        progress.checklistChangeProposals?.find((p) => p.at === PENDING_PROPOSAL.at)?.status,
        "adopted"
      );

      const chat = await readChatHistory(folderPath, folderPath);
      assert.ok(
        chat.some((m) => m.text.includes("Plan revised: 2 → 3 items")),
        "expected a durable 'Plan revised: N → M items' chat line"
      );
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  void it(
    "annotates the mutating round's own roundLedger row with checklistRevisionAdopted " +
      "(2026-08-28 review fix, completion blocker: \"the implementation does not append or update a " +
      "round-ledger event for 'Plan revised: N → M'\")",
    async () => {
      const fsBridge = installFsBridge();
      const ws = installWorkspaceFoldersStub();
      try {
        const { folderPath, folderUri } = makeTaskFolder("revision-promotion-ledger", {
          currentStage: "plan-low-review",
          checklistChangeProposals: [{ ...PENDING_PROPOSAL, status: "revising" }],
          planRevision: {
            proposalAt: PENDING_PROPOSAL.at,
            startedAt: "2026-08-28T00:01:00.000Z",
            stage: "impl",
            discardedItems: ["Add the retry button"],
            removedItems: [],
            reason: "discovered work",
          },
          roundLedger: [
            {
              roundId: PENDING_PROPOSAL.roundId,
              intentId: PENDING_PROPOSAL.roundId,
              attemptIds: [],
              stage: "impl",
              mode: "implementation",
              startedAt: "2026-08-27T23:00:00.000Z",
              endedAt: "2026-08-27T23:05:00.000Z",
              state: "rejected",
              outcome: { rejectionReason: "checklist mutation reverted" },
            },
          ],
        });
        fs.writeFileSync(path.join(folderPath, "plan-final.md"), PRE_REVISION_PLAN, "utf8");
        fs.writeFileSync(path.join(folderPath, "plan.md"), REVISED_DRAFT_PLAN, "utf8");

        const promotion = await preparePlanPromotion(folderUri);
        assert.ok(promotion.ready && promotion.publish, "expected a publish() closure for the revision branch");
        await (promotion as { publish: () => Promise<void> }).publish();

        const progress = readProgress(folderPath);
        const mutatingRow = progress.roundLedger?.find((r) => r.roundId === PENDING_PROPOSAL.roundId);
        assert.ok(mutatingRow?.checklistRevisionAdopted, "expected the round-ledger row to carry the adoption");
        assert.equal(mutatingRow?.checklistRevisionAdopted?.itemCountBefore, 2);
        assert.equal(mutatingRow?.checklistRevisionAdopted?.itemCountAfter, 3);
        // The row's own frozen terminal facts must survive untouched.
        assert.equal(mutatingRow?.state, "rejected");
        assert.equal(mutatingRow?.outcome?.rejectionReason, "checklist mutation reverted");
      } finally {
        ws.restore();
        fsBridge.restore();
      }
    }
  );

  void it("is a plain no-op when canonical already exists and no revision is in flight", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder("ordinary-promotion");
      fs.writeFileSync(path.join(folderPath, "plan-final.md"), PRE_REVISION_PLAN, "utf8");
      fs.writeFileSync(path.join(folderPath, "plan.md"), REVISED_DRAFT_PLAN, "utf8");

      const promotion = await preparePlanPromotion(folderUri);
      assert.equal(promotion.ready, true);
      assert.ok(promotion.ready && !promotion.publish, "ordinary already-canonical case should have no publish()");
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  // 2026-08-28 review fix, completion blocker: "Step 19 still persists ...
  // instead of ... snapshot plan-final.md to the revert journal and record a
  // journaledPlanRef when revision begins". Proves the journal — not the
  // live canonical file — is what the re-finalization merge actually reads:
  // the live file is deliberately drifted AFTER the journal snapshot was
  // taken, so a pass here can only happen if the journal is consulted.
  void it("re-finalization merges prior ticks from the journaled snapshot, not a since-drifted live canonical file", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder("revision-promotion-journaled", {
        currentStage: "plan-low-review",
        checklistChangeProposals: [{ ...PENDING_PROPOSAL, status: "revising" }],
        planRevision: {
          proposalAt: PENDING_PROPOSAL.at,
          startedAt: "2026-08-28T00:01:00.000Z",
          stage: "impl",
          discardedItems: ["Add the retry button"],
          removedItems: [],
          reason: "discovered work",
          journaledPlanRef: PLAN_REVISION_JOURNAL_FILENAME,
        },
      });
      // The journal holds the TRUE pre-revision state (item ticked).
      fs.writeFileSync(
        path.join(folderPath, PLAN_REVISION_JOURNAL_FILENAME),
        PRE_REVISION_PLAN,
        "utf8"
      );
      // The live canonical file has since drifted to something else entirely
      // — if the merge reads THIS, the ticked item would be lost.
      const driftedCanonical = [
        "<!-- ensemble:implementation-checklist -->",
        "",
        "## Part 1",
        "",
        "- [ ] Split the artifacts",
        "- [ ] Wire the completeness gate",
        "",
      ].join("\n");
      fs.writeFileSync(path.join(folderPath, "plan-final.md"), driftedCanonical, "utf8");
      fs.writeFileSync(path.join(folderPath, "plan.md"), REVISED_DRAFT_PLAN, "utf8");

      const promotion = await preparePlanPromotion(folderUri);
      assert.ok(promotion.ready && promotion.publish, "expected a publish() closure for the revision branch");
      await (promotion as { publish: () => Promise<void> }).publish();

      const finalContent = readPlanFinal(folderPath);
      assert.match(
        finalContent,
        /- \[x\] Split the artifacts/,
        "expected the journal's tick to survive, not the drifted canonical's unticked state"
      );

      // The journal is deleted once adoption durably succeeds.
      assert.equal(
        fs.existsSync(path.join(folderPath, PLAN_REVISION_JOURNAL_FILENAME)),
        false,
        "expected the journal snapshot to be cleaned up after successful adoption"
      );

      const progress = readProgress(folderPath);
      const adopted = progress.checklistChangeProposals?.find((p) => p.at === PENDING_PROPOSAL.at);
      assert.equal(adopted?.status, "adopted");
      // 2026-08-28 review fix: the item-count change is now a durable fact on
      // the proposal record itself, not only narrated in chat prose.
      assert.equal(adopted?.itemCountBefore, 2);
      assert.equal(adopted?.itemCountAfter, 3);
      assert.equal(typeof adopted?.resolvedAt, "string");
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  // 2026-08-28 review fix, completion blocker: "lacks the specified
  // exactly-once/re-entry verification" — `finalizePlanRevisionBestEffortV1`'s
  // bounded retry (ADOPT_ATTEMPTS = 3) must actually recover a transient
  // durable-write failure within the SAME `publish()` call, not merely
  // assume a later re-entry will happen.
  void it("recovers via its own bounded retry when the durable adoption write fails transiently", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    const surface: StatusSurface = { addEntry: (): void => { /* no-op */ } };
    initNotificationRouter(surface);
    const realPatch = taskProgressWriterV1Module.patchTaskProgressStrictV1;
    let calls = 0;
    const patched = patchFn(
      taskProgressWriterV1Module as unknown as Record<string, unknown>,
      "patchTaskProgressStrictV1",
      (...args: Parameters<typeof realPatch>) => {
        calls++;
        if (calls < 3) {
          return Promise.reject(new Error("simulated transient write failure"));
        }
        return realPatch(...args);
      }
    );
    try {
      const { folderPath, folderUri } = makeTaskFolder("revision-promotion-retry", {
        currentStage: "plan-low-review",
        checklistChangeProposals: [{ ...PENDING_PROPOSAL, status: "revising" }],
        planRevision: {
          proposalAt: PENDING_PROPOSAL.at,
          startedAt: "2026-08-28T00:01:00.000Z",
          stage: "impl",
          discardedItems: ["Add the retry button"],
          removedItems: [],
          reason: "discovered work",
        },
      });
      fs.writeFileSync(path.join(folderPath, "plan-final.md"), PRE_REVISION_PLAN, "utf8");
      fs.writeFileSync(path.join(folderPath, "plan.md"), REVISED_DRAFT_PLAN, "utf8");

      const promotion = await preparePlanPromotion(folderUri);
      assert.ok(promotion.ready && promotion.publish, "expected a publish() closure for the revision branch");
      await (promotion as { publish: () => Promise<void> }).publish();

      // 3 for the adoption retry loop (2 failures + 1 success), plus 1 more
      // for `recordChecklistRevisionOnRoundLedgerV1`'s own best-effort
      // round-ledger annotation attempt (a harmless no-op here — this
      // fixture seeds no `roundLedger` row for PENDING_PROPOSAL.roundId).
      assert.equal(calls, 4, "expected exactly 2 failed attempts, 1 successful adoption, then the ledger echo");
      const progress = readProgress(folderPath);
      const adopted = progress.checklistChangeProposals?.find((p) => p.at === PENDING_PROPOSAL.at);
      assert.equal(adopted?.status, "adopted", "the bounded retry must recover within this same publish() call");
      assert.equal(progress.planRevision, undefined);

      const chat = await readChatHistory(folderPath, folderPath);
      assert.ok(
        chat.some((m) => m.text.includes("Plan revised: 2 → 3 items")),
        "expected the success line once the retry recovered"
      );
    } finally {
      patched.restore();
      deactivateNotificationRouter();
      ws.restore();
      fsBridge.restore();
    }
  });

  // Same completion blocker: when EVERY attempt fails, the proposal must stay
  // "revising" (not silently lost as adopted, not silently lost as pending),
  // the journal snapshot must survive so a later retry still has its frozen
  // source, and the chat must state honestly that the durable record did not
  // land rather than claim the revision completed.
  void it("leaves the proposal revising and preserves the journal when the durable write fails on every attempt", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    const surface: StatusSurface = { addEntry: (): void => { /* no-op */ } };
    initNotificationRouter(surface);
    const patched = patchFn(
      taskProgressWriterV1Module as unknown as Record<string, unknown>,
      "patchTaskProgressStrictV1",
      () => Promise.reject(new Error("simulated permanent write failure"))
    );
    try {
      const { folderPath, folderUri } = makeTaskFolder("revision-promotion-always-fails", {
        currentStage: "plan-low-review",
        checklistChangeProposals: [{ ...PENDING_PROPOSAL, status: "revising" }],
        planRevision: {
          proposalAt: PENDING_PROPOSAL.at,
          startedAt: "2026-08-28T00:01:00.000Z",
          stage: "impl",
          discardedItems: ["Add the retry button"],
          removedItems: [],
          reason: "discovered work",
          journaledPlanRef: PLAN_REVISION_JOURNAL_FILENAME,
        },
      });
      fs.writeFileSync(path.join(folderPath, PLAN_REVISION_JOURNAL_FILENAME), PRE_REVISION_PLAN, "utf8");
      fs.writeFileSync(path.join(folderPath, "plan-final.md"), PRE_REVISION_PLAN, "utf8");
      fs.writeFileSync(path.join(folderPath, "plan.md"), REVISED_DRAFT_PLAN, "utf8");

      const promotion = await preparePlanPromotion(folderUri);
      assert.ok(promotion.ready && promotion.publish, "expected a publish() closure for the revision branch");
      // The artifact write itself does not go through patchTaskProgressStrictV1
      // and must still succeed — only the durable adoption record fails here.
      await (promotion as { publish: () => Promise<void> }).publish();

      assert.match(readPlanFinal(folderPath), /- \[x\] Split the artifacts/);

      const progressAfterFailure = readProgress(folderPath);
      assert.equal(
        progressAfterFailure.checklistChangeProposals?.find((p) => p.at === PENDING_PROPOSAL.at)?.status,
        "revising",
        "must not silently read as adopted or pending when the durable write never landed"
      );
      assert.ok(progressAfterFailure.planRevision, "planRevision must stay set so a later retry knows one is owed");

      // The journal is retained — never deleted on a failed adoption — so a
      // later re-entry into preparePlanPromotion for this task can still
      // merge from the frozen pre-revision source.
      assert.equal(
        fs.existsSync(path.join(folderPath, PLAN_REVISION_JOURNAL_FILENAME)),
        true,
        "expected the journal snapshot to survive a failed adoption write"
      );

      const chat = await readChatHistory(folderPath, folderPath);
      assert.ok(
        chat.some(
          (m) =>
            m.text.includes("durable adoption record could not be written after 3 attempts") &&
            m.text.includes("2 → 3 items")
        ),
        "expected an honest failure line naming the item-count change without claiming adoption landed"
      );
    } finally {
      patched.restore();
      deactivateNotificationRouter();
      ws.restore();
      fsBridge.restore();
    }
  });

  // 2026-08-28 review fix (second pass), completion blocker: "adopted =
  // patched !== undefined does not prove the proposal transform matched ...
  // patchTaskProgressStrictV1 also returns current progress for a no-op".
  // Reproduces the race the review named: the proposal has already been
  // resolved to something other than "revising" (e.g. by a concurrent
  // discard) by the time this write runs, so `markChecklistChangeProposalAdoptedV1`
  // returns its own unchanged input — a defined, non-undefined value that the
  // old `patched !== undefined` check would have misread as success.
  void it("does not report success when the write is a no-op racing an already-resolved proposal", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    const surface: StatusSurface = { addEntry: (): void => { /* no-op */ } };
    initNotificationRouter(surface);
    try {
      const { folderPath, folderUri } = makeTaskFolder("revision-promotion-race-resolved", {
        currentStage: "plan-low-review",
        // Already resolved to "discarded" — NOT "revising" — even though
        // planRevision (below) still names this proposal as the one in
        // flight, simulating a discard that landed between publish() being
        // constructed and its adoption write actually running.
        checklistChangeProposals: [{ ...PENDING_PROPOSAL, status: "discarded" }],
        planRevision: {
          proposalAt: PENDING_PROPOSAL.at,
          startedAt: "2026-08-28T00:01:00.000Z",
          stage: "impl",
          discardedItems: ["Add the retry button"],
          removedItems: [],
          reason: "discovered work",
          journaledPlanRef: PLAN_REVISION_JOURNAL_FILENAME,
        },
      });
      fs.writeFileSync(path.join(folderPath, PLAN_REVISION_JOURNAL_FILENAME), PRE_REVISION_PLAN, "utf8");
      fs.writeFileSync(path.join(folderPath, "plan-final.md"), PRE_REVISION_PLAN, "utf8");
      fs.writeFileSync(path.join(folderPath, "plan.md"), REVISED_DRAFT_PLAN, "utf8");

      const promotion = await preparePlanPromotion(folderUri);
      assert.ok(promotion.ready && promotion.publish, "expected a publish() closure for the revision branch");
      await (promotion as { publish: () => Promise<void> }).publish();

      const progress = readProgress(folderPath);
      assert.equal(
        progress.checklistChangeProposals?.find((p) => p.at === PENDING_PROPOSAL.at)?.status,
        "discarded",
        "must not be reported/left as adopted when the transform never matched a revising entry"
      );

      // Never deleted on a non-adoption: a later legitimate retry (or a
      // human inspecting the failure) still needs the frozen source.
      assert.equal(
        fs.existsSync(path.join(folderPath, PLAN_REVISION_JOURNAL_FILENAME)),
        true,
        "expected the journal snapshot to survive when adoption never actually landed"
      );

      const chat = await readChatHistory(folderPath, folderPath);
      assert.ok(
        chat.some((m) => m.text.includes("durable adoption record could not be written after 3 attempts")),
        "expected the honest failure line, not a false 'Plan revised' success line"
      );
      assert.ok(
        !chat.some((m) => m.text.startsWith("Plan revised: ") && !m.text.includes("could not be written")),
        "must never emit the success-shaped line for a write that did not actually adopt anything"
      );
    } finally {
      deactivateNotificationRouter();
      ws.restore();
      fsBridge.restore();
    }
  });

  // 2026-08-28 review fix (second pass), completion blocker: "permits the
  // stage transition to continue with planRevision and the proposal still in
  // progress" — neither production caller of preparePlanPromotion runs again
  // once the stage has left plan/plan-review, so a proposal stuck "revising"
  // after finalizePlanRevisionBestEffortV1 exhausts its bounded retry must be
  // recoverable some other way. This is the periodic-sweep re-entry point
  // (`scheduleTaskResume.ts` calls this every sweep).
  void it("retryStuckPlanRevisionAdoptionV1 durably adopts a proposal stuck revising after the artifact write already landed", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    const surface: StatusSurface = { addEntry: (): void => { /* no-op */ } };
    initNotificationRouter(surface);
    try {
      const { folderPath, folderUri } = makeTaskFolder("revision-recovery-sweep", {
        currentStage: "impl",
        checklistChangeProposals: [{ ...PENDING_PROPOSAL, status: "revising" }],
        planRevision: {
          proposalAt: PENDING_PROPOSAL.at,
          startedAt: "2026-08-28T00:01:00.000Z",
          stage: "impl",
          discardedItems: ["Add the retry button"],
          removedItems: [],
          reason: "discovered work",
          journaledPlanRef: PLAN_REVISION_JOURNAL_FILENAME,
        },
      });
      // Simulates the exact stuck state: publish() already wrote the merged,
      // fully-revised plan-final.md and the pre-revision journal snapshot —
      // only the durable adoption record (task-progress.json) never landed.
      fs.writeFileSync(path.join(folderPath, PLAN_REVISION_JOURNAL_FILENAME), PRE_REVISION_PLAN, "utf8");
      fs.writeFileSync(path.join(folderPath, "plan-final.md"), REVISED_DRAFT_PLAN, "utf8");

      await retryStuckPlanRevisionAdoptionV1(folderUri);

      const progress = readProgress(folderPath);
      assert.equal(progress.planRevision, undefined);
      const adopted = progress.checklistChangeProposals?.find((p) => p.at === PENDING_PROPOSAL.at);
      assert.equal(adopted?.status, "adopted");
      assert.equal(adopted?.itemCountBefore, 2, "expected the count re-derived from the journal");
      assert.equal(adopted?.itemCountAfter, 3, "expected the count re-derived from the already-published canonical file");

      assert.equal(
        fs.existsSync(path.join(folderPath, PLAN_REVISION_JOURNAL_FILENAME)),
        false,
        "expected the journal to be cleaned up once the sweep's retry durably adopts the proposal"
      );

      const chat = await readChatHistory(folderPath, folderPath);
      assert.ok(chat.some((m) => m.text.includes("Plan revised: 2 → 3 items")));
    } finally {
      deactivateNotificationRouter();
      ws.restore();
      fsBridge.restore();
    }
  });

  void it("retryStuckPlanRevisionAdoptionV1 is a no-op when no revision is in flight", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder("revision-recovery-sweep-noop", {
        currentStage: "impl",
      });
      await retryStuckPlanRevisionAdoptionV1(folderUri);
      const progress = readProgress(folderPath);
      assert.equal(progress.planRevision, undefined);
      assert.equal(progress.checklistChangeProposals, undefined);
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  // 2026-08-28 review fix (third pass), narrowed completion blocker:
  // "concurrent/repeated finalization can still produce more than one chat
  // projection because the chat append is outside the adoption transaction".
  // Reproduces the exact race named in `applyDeferredPlanRevisionAdoptionV1`'s
  // own doc comment ("the (expected-rare) case where something else has
  // already resolved... between publish() returning and this running"): a
  // FIRST caller's write already flipped the proposal to "adopted" and
  // already echoed it in chat, but `planRevision` is still present on this
  // read (its clearing write and this stale read raced) — so a SECOND
  // caller's guard ("planRevision present, proposalAt matches") still passes
  // and it reaches the same finalize path. Before this fix that produced a
  // second "Plan revised" chat line for the same completion.
  void it("applyDeferredPlanRevisionAdoptionV1 does not duplicate the chat echo when the proposal was already adopted by a prior caller", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder("revision-adoption-race", {
        currentStage: "impl",
        checklistChangeProposals: [
          {
            ...PENDING_PROPOSAL,
            status: "adopted",
            resolvedAt: "2026-08-28T00:05:00.000Z",
            itemCountBefore: 2,
            itemCountAfter: 3,
          },
        ],
        // Stale on purpose: the first caller's write already adopted the
        // proposal and would have cleared this in the SAME transaction, but
        // this read raced ahead of that write's visibility to a second
        // caller — exactly the case applyDeferredPlanRevisionAdoptionV1's own
        // doc comment names as "expected-rare".
        planRevision: {
          proposalAt: PENDING_PROPOSAL.at,
          startedAt: "2026-08-28T00:01:00.000Z",
          stage: "impl",
          discardedItems: ["Add the retry button"],
          removedItems: [],
          reason: "discovered work",
        },
      });
      // The first caller's own echo, already durably written.
      await appendChatMessageV1(
        folderPath,
        {
          role: "assistant",
          text: "Plan revised: 2 → 3 items — Implementation and later reviews re-run.",
          stage: "impl",
          at: "2026-08-28T00:05:00.000Z",
          kind: "activity",
          roundId: PENDING_PROPOSAL.roundId,
        },
        folderPath
      );

      await applyDeferredPlanRevisionAdoptionV1(folderUri, {
        proposalAt: PENDING_PROPOSAL.at,
        stage: "impl",
        oldTotal: 2,
        newTotal: 3,
      });

      const chat = await readChatHistory(folderPath, folderPath);
      const echoes = chat.filter((m) => m.text.startsWith("Plan revised: 2 → 3 items"));
      assert.equal(echoes.length, 1, "expected the second caller's redundant echo to be skipped, not duplicated");
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  // 2026-08-28 review fix (fourth pass), same completion blocker, the
  // GENUINE concurrency half the previous test did not exercise: that test
  // pre-seeded an echo and ran ONE later caller against already-adopted
  // state, proving the dedupe read catches an echo that already exists — it
  // never had two callers race to be first. This test starts TWO real
  // callers (`applyDeferredPlanRevisionAdoptionV1` and
  // `retryStuckPlanRevisionAdoptionV1`) for the SAME still-"revising"
  // proposal before either has done anything, via `Promise.all`, so both
  // would — absent the `withPlanFileWriteLockV1`-scoped serialization added
  // this pass — read "no echo yet" and both append one.
  void it("two genuinely concurrent finalize callers for the same proposal produce exactly one adoption and one chat echo", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder("revision-adoption-concurrent-race", {
        currentStage: "impl",
        checklistChangeProposals: [{ ...PENDING_PROPOSAL, status: "revising" }],
        planRevision: {
          proposalAt: PENDING_PROPOSAL.at,
          startedAt: "2026-08-28T00:01:00.000Z",
          stage: "impl",
          discardedItems: ["Add the retry button"],
          removedItems: [],
          reason: "discovered work",
        },
      });
      const canonicalUri = vscode.Uri.joinPath(folderUri, "plan-final.md");
      fs.writeFileSync(canonicalUri.fsPath, "# Plan\n\n- [x] Item one\n- [ ] Item two\n- [ ] Item three\n", "utf8");

      await Promise.all([
        applyDeferredPlanRevisionAdoptionV1(folderUri, {
          proposalAt: PENDING_PROPOSAL.at,
          stage: "impl",
          oldTotal: 2,
          newTotal: 3,
        }),
        retryStuckPlanRevisionAdoptionV1(folderUri),
      ]);

      const chat = await readChatHistory(folderPath, folderPath);
      const echoes = chat.filter((m) => m.text.startsWith("Plan revised:"));
      assert.equal(echoes.length, 1, "two concurrent finalize callers must produce exactly one chat echo");

      const progressText = fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8");
      const progress = JSON.parse(progressText) as TaskProgress;
      const proposal = progress.checklistChangeProposals?.find((p) => p.at === PENDING_PROPOSAL.at);
      assert.equal(proposal?.status, "adopted", "the proposal must end up durably adopted exactly once");
      assert.equal(progress.planRevision, undefined, "planRevision must be cleared once adoption lands");
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  // 2026-08-28 review fix, NEW completion blocker: "Automated plan-revision
  // advancement deadlocks by reacquiring the non-reentrant task lock from
  // the next-stage beforeWrite callback". Reproduces the exact production
  // composition the score-based auto-advance route uses
  // (advanceStageViaNextStageRowV1 -> executeNextStageV1 ->
  // patchTaskProgressStrictV1(..., { beforeWrite }), where beforeWrite runs
  // promotion.publish() while the outer call already holds withTaskLock for
  // this task folder), in two parts:
  //   1. publish({ deferAdoptionWrite: true }) must not attempt a nested
  //      task-progress.json write at all (the old skipLock-only fix avoided
  //      the deadlock but let the outer write's own stale-snapshot-derived
  //      write silently clobber the adoption record — worse than the
  //      deadlock, because it failed silently instead of visibly).
  //   2. applyDeferredPlanRevisionAdoptionV1, called AFTER the outer write's
  //      lock has released (mirroring reviewActions.ts's real sequencing),
  //      must still durably adopt the proposal using the returned counts.
  void it("does not deadlock or clobber the adoption record when publish() defers inside an outer beforeWrite", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    const surface: StatusSurface = { addEntry: (): void => { /* no-op */ } };
    initNotificationRouter(surface);
    try {
      const { folderPath, folderUri } = makeTaskFolder("revision-promotion-outer-lock", {
        currentStage: "plan-low-review",
        checklistChangeProposals: [{ ...PENDING_PROPOSAL, status: "revising" }],
        planRevision: {
          proposalAt: PENDING_PROPOSAL.at,
          startedAt: "2026-08-28T00:01:00.000Z",
          stage: "impl",
          discardedItems: ["Add the retry button"],
          removedItems: [],
          reason: "discovered work",
        },
      });
      fs.writeFileSync(path.join(folderPath, "plan-final.md"), PRE_REVISION_PLAN, "utf8");
      fs.writeFileSync(path.join(folderPath, "plan.md"), REVISED_DRAFT_PLAN, "utf8");

      const promotion = await preparePlanPromotion(folderUri);
      assert.ok(promotion.ready && promotion.publish, "expected a publish() closure for the revision branch");
      const publish = (
        promotion as {
          publish: (options?: { deferAdoptionWrite?: boolean }) => Promise<PlanRevisionAdoptionV1 | undefined>;
        }
      ).publish;

      let deferred: PlanRevisionAdoptionV1 | undefined;
      const outerWrite = taskProgressWriterV1Module.patchTaskProgressStrictV1(
        folderUri,
        (current) => ({ ...current, currentStage: "impl" as const }),
        {
          beforeWrite: async () => {
            deferred = await publish({ deferAdoptionWrite: true });
          },
        }
      );

      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), 4000);
      });
      const result = await Promise.race([outerWrite.then(() => "completed" as const), timeout]);
      if (timer) {
        clearTimeout(timer);
      }
      assert.equal(
        result,
        "completed",
        "outer patchTaskProgressStrictV1 deadlocked waiting on its own beforeWrite's deferred publish()"
      );
      assert.ok(deferred, "expected publish() to return the computed adoption counts instead of writing them");

      // The outer write has landed with the stage transition applied and
      // planRevision/checklistChangeProposals still carrying their
      // pre-beforeWrite values (untouched, not clobbered by a nested write
      // that never happened) — this is the expected TRANSIENT state before
      // the deferred adoption is applied below.
      const midway = readProgress(folderPath);
      assert.equal(midway.currentStage, "impl");
      assert.ok(midway.planRevision, "planRevision must still be set until the deferred adoption is applied");

      // Mirrors reviewActions.ts: applied only after the outer write's lock
      // has released — a separate, sequential, normally-locked call.
      await applyDeferredPlanRevisionAdoptionV1(folderUri, deferred);

      const progress = readProgress(folderPath);
      assert.equal(progress.currentStage, "impl", "the stage transition must survive the deferred adoption write");
      assert.equal(progress.planRevision, undefined);
      assert.equal(
        progress.checklistChangeProposals?.find((p) => p.at === PENDING_PROPOSAL.at)?.status,
        "adopted"
      );

      const finalContent = readPlanFinal(folderPath);
      assert.match(finalContent, /- \[x\] Split the artifacts/);
      assert.match(finalContent, /- \[ \] Add the retry button/);
    } finally {
      deactivateNotificationRouter();
      ws.restore();
      fsBridge.restore();
    }
  });
});

void describe("snapshotPlanForRevisionV1 (Part 6 revision journal)", () => {
  void it("copies the current canonical plan-final.md into the fixed journal filename and returns it", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder("journal-snapshot");
      fs.writeFileSync(path.join(folderPath, "plan-final.md"), PRE_REVISION_PLAN, "utf8");

      const ref = await snapshotPlanForRevisionV1(folderUri);
      assert.equal(ref, PLAN_REVISION_JOURNAL_FILENAME);
      const journaled = fs.readFileSync(path.join(folderPath, PLAN_REVISION_JOURNAL_FILENAME), "utf8");
      // `snapshotPlanForRevisionV1` reads through `readNonEmptyText`, which
      // trims — matching every other reader of this artifact throughout the
      // codebase (checklist parsing is whitespace-insensitive at this level).
      assert.equal(journaled, PRE_REVISION_PLAN.trim());
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  void it("returns undefined, not an error, when no canonical plan-final.md exists yet", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderUri } = makeTaskFolder("journal-snapshot-missing");
      const ref = await snapshotPlanForRevisionV1(folderUri);
      assert.equal(ref, undefined);
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });
});

function makeInventory(
  canonicalId: string,
  folder: string,
  progress: TaskProgress
): { inventory: TaskInventory; refreshCount: () => number } {
  let refreshes = 0;
  const inv = Object.create(TaskInventory.prototype) as TaskInventory;
  const task = {
    canonicalId,
    taskFolderPath: folder,
    folderName: path.basename(folder),
    sourceScopeKey: canonicalId,
    progress,
  };
  // @ts-expect-error — direct field init on stub
  inv.visibleTasks = [task];
  // @ts-expect-error — direct field init on stub
  inv.taskByCanonicalId = new Map([[canonicalId, task]]);
  // @ts-expect-error — direct field init on stub
  inv.suppressionAliasMap = new Map();
  inv.refresh = (): Promise<void> => {
    refreshes++;
    return Promise.resolve();
  };
  inv.getTasks = (): Array<typeof task> => [task];
  inv.getTaskById = (id: string): typeof task | undefined => (id === canonicalId ? task : undefined);
  inv.getTaskByPath = (p: string): typeof task | undefined => (p === folder ? task : undefined);
  inv.getVisibleTaskForSuppressedId = (): undefined => undefined;
  inv.getVisibleTaskForSuppressedPath = (): undefined => undefined;
  return { inventory: inv, refreshCount: (): number => refreshes };
}

function makeStore(persistedId?: string): CurrentTaskStore {
  const store = Object.create(CurrentTaskStore.prototype) as CurrentTaskStore;
  store.get = (): string | undefined => persistedId;
  store.set = async (): Promise<void> => { /* no-op */ };
  store.clear = async (): Promise<void> => { /* no-op */ };
  return store;
}

void describe("reviseChecklistChangeProposalConfirmedV1 / discardChecklistChangeProposalConfirmedV1", () => {
  void it("Revise moves the task to plan, truncates completedStages, and records planRevision", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    const surface: StatusSurface = { addEntry: (): void => { /* no-op */ } };
    initNotificationRouter(surface);
    try {
      const { folderPath } = makeTaskFolder("revise-command", {
        currentStage: "impl-high-review",
        completedStages: ["desc", "plan", "plan-high-review", "plan-low-review", "impl"],
        checklistChangeProposals: [PENDING_PROPOSAL],
      });
      const canonicalId = "canonical-revise-command";
      const { inventory } = makeInventory(canonicalId, folderPath, readProgress(folderPath));

      await reviseChecklistChangeProposalConfirmedV1(inventory, makeStore(canonicalId), {
        taskFolderPath: folderPath,
        canonicalId,
        proposalAt: PENDING_PROPOSAL.at,
      });

      const progress = readProgress(folderPath);
      assert.equal(progress.currentStage, "plan");
      assert.deepEqual(progress.completedStages, ["desc"]);
      assert.equal(progress.planRevision?.proposalAt, PENDING_PROPOSAL.at);
      assert.equal(
        progress.checklistChangeProposals?.find((p) => p.at === PENDING_PROPOSAL.at)?.status,
        "revising"
      );
      // No plan-final.md was written for this fixture, so there is nothing
      // to journal — the field is simply absent, not an error.
      assert.equal(progress.planRevision?.journaledPlanRef, undefined);
    } finally {
      deactivateNotificationRouter();
      ws.restore();
      fsBridge.restore();
    }
  });

  // 2026-08-28 review fix, completion blocker: the realistic case — a round
  // mutated an EXISTING plan-final.md, so "Revise the plan" must journal it.
  void it("Revise snapshots the existing plan-final.md into the revision journal and records journaledPlanRef", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    const surface: StatusSurface = { addEntry: (): void => { /* no-op */ } };
    initNotificationRouter(surface);
    try {
      const { folderPath } = makeTaskFolder("revise-command-journaled", {
        currentStage: "impl-high-review",
        completedStages: ["desc", "plan", "plan-high-review", "plan-low-review", "impl"],
        checklistChangeProposals: [PENDING_PROPOSAL],
      });
      fs.writeFileSync(path.join(folderPath, "plan-final.md"), PRE_REVISION_PLAN, "utf8");
      const canonicalId = "canonical-revise-command-journaled";
      const { inventory } = makeInventory(canonicalId, folderPath, readProgress(folderPath));

      await reviseChecklistChangeProposalConfirmedV1(inventory, makeStore(canonicalId), {
        taskFolderPath: folderPath,
        canonicalId,
        proposalAt: PENDING_PROPOSAL.at,
      });

      const progress = readProgress(folderPath);
      assert.equal(progress.planRevision?.journaledPlanRef, PLAN_REVISION_JOURNAL_FILENAME);
      const journaled = fs.readFileSync(
        path.join(folderPath, PLAN_REVISION_JOURNAL_FILENAME),
        "utf8"
      );
      // Trimmed — see `snapshotPlanForRevisionV1`'s own note on `readNonEmptyText`.
      assert.equal(journaled, PRE_REVISION_PLAN.trim());
      // The live canonical file is untouched by the revision transition itself.
      assert.equal(readPlanFinal(folderPath), PRE_REVISION_PLAN);
    } finally {
      deactivateNotificationRouter();
      ws.restore();
      fsBridge.restore();
    }
  });

  void it("Discard marks the proposal discarded and leaves plan-final.md untouched", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    const surface: StatusSurface = { addEntry: (): void => { /* no-op */ } };
    initNotificationRouter(surface);
    try {
      const { folderPath } = makeTaskFolder("discard-command", {
        currentStage: "impl-high-review",
        checklistChangeProposals: [PENDING_PROPOSAL],
      });
      fs.writeFileSync(path.join(folderPath, "plan-final.md"), PRE_REVISION_PLAN, "utf8");
      const canonicalId = "canonical-discard-command";
      const { inventory } = makeInventory(canonicalId, folderPath, readProgress(folderPath));

      await discardChecklistChangeProposalConfirmedV1(inventory, makeStore(canonicalId), {
        taskFolderPath: folderPath,
        canonicalId,
        proposalAt: PENDING_PROPOSAL.at,
      });

      const progress = readProgress(folderPath);
      assert.equal(progress.currentStage, "impl-high-review");
      assert.equal(
        progress.checklistChangeProposals?.find((p) => p.at === PENDING_PROPOSAL.at)?.status,
        "discarded"
      );
      assert.equal(readPlanFinal(folderPath), PRE_REVISION_PLAN);
    } finally {
      deactivateNotificationRouter();
      ws.restore();
      fsBridge.restore();
    }
  });
});
