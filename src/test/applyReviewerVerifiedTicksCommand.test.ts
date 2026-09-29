/**
 * Unit tests for the `applyReviewerVerifiedTicks` command (workflow 3
 * continuation plan, Part 5) — the one-click path that ticks plan-final.md
 * from a reviewer's `## Verified Complete` list, so an operator is no longer
 * asked to retype a verification the reviewer already performed.
 *
 * Structured the same way as reconcilePlanChecklistCommand.test.ts: a real
 * temp task folder, `vscode.workspace.fs` backed by real disk, and
 * `vscode.window.showWarningMessage` stubbed to drive the confirmation modal.
 *
 * Covered here:
 *   1. The happy path — a review naming unticked items ticks exactly those,
 *      through the monotonic merge (never unticking anything already done).
 *   2. Refusals that must write nothing: no review artifact, no
 *      `## Verified Complete` block, every named item already ticked, no
 *      plan checklist at all, task not on a review stage.
 *   3. Items the review names that do not resolve to any unchecked plan item
 *      (paraphrased/foreign text) are silently skipped, not errors.
 *   4. Cancelling the confirmation writes nothing.
 *   5. The plan changing between the read and the confirmation is resolved by
 *      re-deriving against the fresh content rather than aborting (ticking is
 *      monotonic and text-matched, so recomputation is always safe).
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import { applyReviewerVerifiedTicks, applyReviewerVerifiedTicksConfirmedV1 } from "../commands/applyReviewerVerifiedTicks";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { TaskProgress } from "../types/taskProgress";
import {
  StatusSurface,
  deactivateNotificationRouter,
  initNotificationRouter,
} from "../utils/notificationRouter";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { WorkflowDecisionCommandResultV1, WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import { safeRemoveDir } from "./testFsUtils";

const ROOT = nodeFs.mkdtempSync(
  nodePath.join(nodeOs.tmpdir(), "ensemble-apply-verified-ticks-test-")
);
after(() => {
  safeRemoveDir(ROOT);
});

// Part 3, Step 5: `applyReviewerVerifiedTicksConfirmedV1` now dispatches
// "resumeAndApplyCurrentStageAction" ("and try again") once it succeeds. A
// module-scoped no-op registration (each test file is its own node:test
// child process, so this cannot leak into other files) keeps every existing
// happy-path test from hitting the stub's "not registered" throw; tests that
// care which task it was dispatched for read `resumeAndApplyCurrentStageActionCalls`.
const resumeAndApplyCurrentStageActionCalls: unknown[] = [];
vscode.commands.registerCommand("vs-code-ai-helper.resumeAndApplyCurrentStageAction", (arg?: unknown) => {
  resumeAndApplyCurrentStageActionCalls.push(arg);
});

const CHECKLIST_PLAN = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "- [x] Split the artifacts",
  "- [ ] Wire the completeness gate",
  "- [ ] Add the retry button",
  "",
].join("\n");

const PLAN_WITHOUT_CHECKLIST = ["# Final Plan", "", "Prose only, no checklist.", ""].join("\n");

const REVIEW_WITH_VERIFIED_ITEMS = [
  "Readiness: 9/10",
  "",
  "<!-- verified-complete:start -->",
  "- Wire the completeness gate",
  "<!-- verified-complete:end -->",
  "",
  "<!-- blockers:start -->",
  "<!-- blockers:end -->",
].join("\n");

const REVIEW_WITH_NO_VERIFIED_BLOCK = [
  "Readiness: 9/10",
  "",
  "<!-- blockers:start -->",
  "<!-- blockers:end -->",
].join("\n");

const BASE_UPDATED_AT = "2026-08-16T00:00:00.000Z";

function writeProgress(folder: string, progress: TaskProgress): void {
  nodeFs.writeFileSync(
    nodePath.join(folder, "task-progress.json"),
    JSON.stringify(progress, undefined, 2),
    "utf8"
  );
}

function readPlan(folder: string): string {
  return nodeFs.readFileSync(nodePath.join(folder, "plan-final.md"), "utf8");
}

function makeTask(
  name: string,
  options: { plan?: string; review?: string; currentStage?: TaskProgress["currentStage"] }
): { folder: string; progress: TaskProgress } {
  const folder = nodePath.join(ROOT, ".ensemble", name);
  nodeFs.mkdirSync(folder, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(folder, "plan-final.md"), options.plan ?? CHECKLIST_PLAN, "utf8");
  if (options.review !== undefined) {
    nodeFs.writeFileSync(nodePath.join(folder, "impl-high-review.md"), options.review, "utf8");
  }
  const progress: TaskProgress = {
    taskFolder: name,
    currentStage: options.currentStage ?? "impl-high-review",
    status: "active",
    createdAt: BASE_UPDATED_AT,
    updatedAt: BASE_UPDATED_AT,
  } as TaskProgress;
  writeProgress(folder, progress);
  return { folder, progress };
}

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
    folderName: nodePath.basename(folder),
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
  inv.getTaskById = (id: string): typeof task | undefined =>
    id === canonicalId ? task : undefined;
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

type Captured = { method: string; message: string };

function installWindowStub(options: {
  answer?: string;
  onModal?: () => void;
}): { captured: Captured[]; restore: () => void } {
  const captured: Captured[] = [];
  const surface: StatusSurface = {
    addEntry: (message: string, level: "info" | "warning" | "error"): void => {
      captured.push({ method: level === "info" ? "info" : level, message });
    },
  };
  initNotificationRouter(surface);

  const win = vscode.window as unknown as Record<string, unknown>;
  const origWarn = win.showWarningMessage;

  win.showWarningMessage = (
    msg: string,
    ...rest: unknown[]
  ): Promise<string | undefined> => {
    const isModal =
      typeof rest[0] === "object" &&
      rest[0] !== null &&
      (rest[0] as { modal?: boolean }).modal === true;
    if (!isModal) {
      captured.push({ method: "warning", message: msg });
      return Promise.resolve(undefined);
    }
    captured.push({ method: "modal", message: msg });
    options.onModal?.();
    return Promise.resolve(options.answer);
  };

  return {
    captured,
    restore: (): void => {
      win.showWarningMessage = origWarn;
      deactivateNotificationRouter();
    },
  };
}

function installWorkspaceFolders(): { restore: () => void } {
  const orig = (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders;
  (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = [
    { uri: vscode.Uri.file(ROOT), name: "apply-verified-ticks-root", index: 0 },
  ];
  return {
    restore: (): void => {
      (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = orig;
    },
  };
}

function installRealFs(): { restore: () => void } {
  const fs = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = {
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    createDirectory: fs.createDirectory,
  };
  fs.readFile = async (uri: vscode.Uri): Promise<Uint8Array> =>
    new TextEncoder().encode(await nodeFs.promises.readFile(uri.fsPath, "utf8"));
  fs.writeFile = async (uri: vscode.Uri, data: Uint8Array): Promise<void> => {
    await nodeFs.promises.writeFile(uri.fsPath, Buffer.from(data));
  };
  fs.createDirectory = async (uri: vscode.Uri): Promise<void> => {
    await nodeFs.promises.mkdir(uri.fsPath, { recursive: true });
  };
  return {
    restore: (): void => {
      fs.readFile = orig.readFile;
      fs.writeFile = orig.writeFile;
      fs.createDirectory = orig.createDirectory;
    },
  };
}

function makeExtensionContext(): vscode.ExtensionContext {
  const backing = new Map<string, unknown>();
  const memento = {
    keys: (): readonly string[] => [...backing.keys()],
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      backing.has(key) ? (backing.get(key) as T) : defaultValue,
    update: (key: string, value: unknown): Thenable<void> => {
      if (value === undefined) { backing.delete(key); } else { backing.set(key, value); }
      return Promise.resolve();
    },
  };
  return {
    subscriptions: [] as vscode.Disposable[],
    extensionUri: vscode.Uri.file(ROOT),
    workspaceState: memento,
    globalState: memento,
  } as unknown as vscode.ExtensionContext;
}

/**
 * `applyReviewerVerifiedTicks` no longer confirms via a modal — it posts a
 * `WorkflowDecisionV1` (case 2, applyReviewerVerifiedTicks.ts's doc comment)
 * and returns. This driver wires the process-wide extension context so the
 * decision store persists, captures whatever decision was posted, optionally
 * injects `interference` between posting and confirming, and when `confirm`
 * is true resolves the "apply" option and runs
 * `applyReviewerVerifiedTicksConfirmedV1` — exactly what choosing "Apply" in
 * Chat With AI would dispatch.
 */
async function run(
  name: string,
  taskOptions: { plan?: string; review?: string; currentStage?: TaskProgress["currentStage"] },
  confirmOptions: {
    confirm?: boolean;
    interference?: (folder: string) => void;
    /**
     * RC2 item 8, Step 37 follow-up (narrowed blocker `bbd42447-…-1`): when
     * true, confirm by re-dispatching through the "apply" option's OWN
     * `effect.args` — the same args `chatView.ts`'s real dispatch passes to
     * `vscode.commands.executeCommand` — instead of a hand-built
     * `{ canonicalId, taskFolderPath }`. Needed to exercise `offeredItems`,
     * which only exists on the real card's effect, not this shortcut.
     */
    useRealEffectArgs?: boolean;
  },
  arg?: unknown
): Promise<{
  captured: Captured[];
  folder: string;
  refreshes: number;
  decision?: WorkflowDecisionV1;
  confirmedResult?: WorkflowDecisionCommandResultV1 | void;
}> {
  const { folder, progress } = makeTask(name, taskOptions);
  const canonicalId = `canonical-${name}`;
  const { inventory, refreshCount } = makeInventory(canonicalId, folder, progress);
  const workspace = installWorkspaceFolders();
  const fs = installRealFs();
  const win = installWindowStub({});
  const context = makeExtensionContext();
  __extensionContextV1TestOnly.set(context);
  try {
    await applyReviewerVerifiedTicks(
      inventory,
      makeStore(canonicalId),
      (arg ?? { canonicalId, taskFolderPath: folder }) as never
    );
    const store = new WorkflowDecisionStoreV1(context.workspaceState);
    const decision = store
      .listPending(canonicalId)
      .find((d) => d.decisionKey === "applyReviewerVerifiedTicks");
    if (decision) {
      const applyOption = decision.options.find((o) => o.optionId === "apply");
      win.captured.push({
        method: "modal",
        message: `${decision.whatHappened}\n${applyOption?.label ?? ""}\n${applyOption?.consequence ?? ""}`,
      });
    }
    confirmOptions.interference?.(folder);
    let confirmedResult: WorkflowDecisionCommandResultV1 | void = undefined;
    if (confirmOptions.confirm && decision) {
      const resolved = await store.resolve(decision.decisionId, "apply");
      if (resolved.kind === "resolved") {
        const applyOption = decision.options.find((o) => o.optionId === "apply");
        const confirmArg =
          confirmOptions.useRealEffectArgs && applyOption?.effect.kind === "command"
            ? (applyOption.effect.args?.[0] as never)
            : ({ canonicalId, taskFolderPath: folder } as never);
        confirmedResult = await applyReviewerVerifiedTicksConfirmedV1(inventory, makeStore(canonicalId), confirmArg);
      }
    }
    return { captured: win.captured, folder, refreshes: refreshCount(), decision, confirmedResult };
  } finally {
    win.restore();
    fs.restore();
    workspace.restore();
    __extensionContextV1TestOnly.reset();
  }
}

void describe("applyReviewerVerifiedTicks — happy path", () => {
  void it("ticks exactly the review's verified-and-unchecked items, never unticking anything", async () => {
    const result = await run(
      "happy",
      { review: REVIEW_WITH_VERIFIED_ITEMS },
      { confirm: true }
    );
    const plan = readPlan(result.folder);
    assert.match(plan, /- \[x\] Split the artifacts/, "already-ticked item stays ticked");
    assert.match(plan, /- \[x\] Wire the completeness gate/, "the verified item is now ticked");
    assert.match(plan, /- \[ \] Add the retry button/, "an item never named by the review stays unticked");
    assert.equal(result.refreshes, 1);
    // The last "info" entry, not the first: posting the decision itself now
    // also notifies at "info" level when its gating is non-blocking (item 13
    // — the headline/severity must reflect `gating`, not always be a
    // warning), so the first "info" entry can be that announcement rather
    // than this command's own completion message.
    assert.match(
      result.captured.filter((m) => m.method === "info").pop()?.message ?? "",
      /Applied 1 reviewer-verified tick/
    );
    const modal = result.captured.find((m) => m.method === "modal")?.message ?? "";
    assert.match(modal, /Apply 1 Reviewer-Verified Tick/);
    assert.match(modal, /Wire the completeness gate/);
    // Part 3, Step 5: applying succeeds, so it also tries the stage's next
    // action again.
    assert.deepEqual(resumeAndApplyCurrentStageActionCalls.at(-1), { taskFolderPath: result.folder });
  });

  // Task "Actionable Hand-offs" PART 5: every decision this task's plan asks
  // us to populate must state whether resolving it unblocks task progress.
  // Part 3, Step 5: applying now dispatches the stage's next action, so this
  // decision's `gating` must say so rather than claim it never unblocks.
  void it("states its gating metadata: applying ticks dispatches the stage's next action", async () => {
    const result = await run("gating", { review: REVIEW_WITH_VERIFIED_ITEMS }, { confirm: false });
    assert.ok(result.decision, "expected a decision to be posted");
    assert.equal(result.decision.gating?.holdsTaskPaused, false);
    assert.equal(result.decision.gating?.unblocksProgress, true);
    assert.match(result.decision.gating?.detail ?? "", /dispatches this stage's next action/i);
  });
});

void describe("applyReviewerVerifiedTicks — refusals that write nothing", () => {
  void it("reports no items when the review has no Verified Complete block", async () => {
    const callsBefore = resumeAndApplyCurrentStageActionCalls.length;
    const result = await run(
      "no-block",
      { review: REVIEW_WITH_NO_VERIFIED_BLOCK },
      { confirm: true }
    );
    assert.equal(result.captured.some((m) => m.method === "modal"), false);
    assert.match(
      result.captured.find((m) => m.method === "info")?.message ?? "",
      /named no items as verified complete/
    );
    assert.equal(readPlan(result.folder), CHECKLIST_PLAN);
    // Never applied anything, so no stage action is retried.
    assert.equal(resumeAndApplyCurrentStageActionCalls.length, callsBefore);
  });

  void it("reports nothing to apply when every named item is already ticked", async () => {
    const review = [
      "<!-- verified-complete:start -->",
      "- Split the artifacts",
      "<!-- verified-complete:end -->",
    ].join("\n");
    const result = await run("already-ticked", { review }, { confirm: true });
    assert.equal(result.captured.some((m) => m.method === "modal"), false);
    assert.match(
      result.captured.find((m) => m.method === "info")?.message ?? "",
      /already ticked/
    );
    assert.equal(readPlan(result.folder), CHECKLIST_PLAN);
  });

  void it("warns when plan-final.md has no checklist at all", async () => {
    const result = await run(
      "no-checklist",
      { review: REVIEW_WITH_VERIFIED_ITEMS, plan: PLAN_WITHOUT_CHECKLIST },
      { confirm: true }
    );
    assert.equal(result.captured.some((m) => m.method === "modal"), false);
    assert.match(
      result.captured.find((m) => m.method === "warning")?.message ?? "",
      /no implementation checklist/
    );
  });

  void it("reports no review artifact when the task has none yet", async () => {
    const result = await run("no-review-file", {}, { confirm: true });
    assert.equal(result.captured.some((m) => m.method === "modal"), false);
    assert.match(
      result.captured.find((m) => m.method === "info")?.message ?? "",
      /No impl-high-review\.md was found/
    );
  });

  void it("declines when the task is not on a review stage", async () => {
    const result = await run(
      "not-review-stage",
      { review: REVIEW_WITH_VERIFIED_ITEMS, currentStage: "impl" },
      { confirm: true }
    );
    assert.equal(result.captured.some((m) => m.method === "modal"), false);
    assert.match(
      result.captured.find((m) => m.method === "info")?.message ?? "",
      /not on a review stage/
    );
  });
});

void describe("applyReviewerVerifiedTicks — items that do not resolve", () => {
  void it("silently skips a verified item that matches nothing in the plan (paraphrase/foreign text)", async () => {
    const review = [
      "<!-- verified-complete:start -->",
      "- Wire the completeness gate",
      "- Something the plan never actually said",
      "<!-- verified-complete:end -->",
    ].join("\n");
    const result = await run("partial-resolve", { review }, { confirm: true });
    const plan = readPlan(result.folder);
    assert.match(plan, /- \[x\] Wire the completeness gate/);
    // Last "info" entry — see the comment on the identical pattern in the
    // "happy path" test above.
    assert.match(
      result.captured.filter((m) => m.method === "info").pop()?.message ?? "",
      /Applied 1 reviewer-verified tick/,
      "only the one resolvable item should be counted/applied"
    );
  });
});

void describe("applyReviewerVerifiedTicks — decision lists every applicable item without truncation", () => {
  void it("lists all 12 applicable items in the option's consequence text, with no '…and N more' truncation", async () => {
    const items = Array.from({ length: 12 }, (_, i) => `Step ${i + 1}`);
    const plan = [
      "<!-- ensemble:implementation-checklist -->",
      "",
      ...items.map((item) => `- [ ] ${item}`),
      "",
    ].join("\n");
    const review = [
      "<!-- verified-complete:start -->",
      ...items.map((item) => `- ${item}`),
      "<!-- verified-complete:end -->",
    ].join("\n");
    const result = await run("many-items", { plan, review }, { confirm: false });
    assert.ok(result.decision, "the apply-ticks decision should have been posted");
    const applyOption = result.decision.options.find((o) => o.optionId === "apply");
    assert.ok(applyOption, "the decision must offer an 'apply' option");
    for (const item of items) {
      assert.match(
        applyOption.consequence,
        new RegExp(item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `"${item}" must be named in the option's consequence text`
      );
    }
    assert.doesNotMatch(
      applyOption.consequence,
      /…and \d+ more\.?/,
      "the full list must be shown — no truncation to a preview"
    );
    assert.match(applyOption.label, /Apply 12 Reviewer-Verified Ticks/);
  });
});

void describe("applyReviewerVerifiedTicks — cancellation and races", () => {
  void it("writes nothing when the decision is left unresolved", async () => {
    const result = await run(
      "cancelled",
      { review: REVIEW_WITH_VERIFIED_ITEMS },
      { confirm: false }
    );
    assert.ok(result.decision, "the apply-ticks decision should have been posted");
    assert.equal(readPlan(result.folder), CHECKLIST_PLAN);
    assert.equal(result.refreshes, 0);
  });

  void it("re-derives against fresh content when the plan changes between posting and confirming, rather than aborting", async () => {
    // Ticking is monotonic and text-matched, so recomputing against whatever
    // is on disk at write time is safe — unlike reconcilePlanChecklist's
    // latch clear, which approves a byte-exact human judgement and must
    // abort on any drift.
    const result = await run(
      "race-plan-edited",
      { review: REVIEW_WITH_VERIFIED_ITEMS },
      {
        confirm: true,
        interference: (folder): void => {
          nodeFs.writeFileSync(
            nodePath.join(folder, "plan-final.md"),
            CHECKLIST_PLAN.replace("- [ ] Add the retry button", "- [x] Add the retry button"),
            "utf8"
          );
        },
      }
    );
    const plan = readPlan(result.folder);
    assert.match(plan, /- \[x\] Wire the completeness gate/, "the reviewer's tick still applies");
    assert.match(plan, /- \[x\] Add the retry button/, "the concurrent edit is preserved, not clobbered");
    // Last "info" entry — see the comment on the identical pattern in the
    // "happy path" test above.
    assert.match(
      result.captured.filter((m) => m.method === "info").pop()?.message ?? "",
      /Applied 1 reviewer-verified tick/
    );
  });

  // RC2 item 8, Step 37: idempotent re-press. Something else (the
  // duplicate option on a `reconcilePlanChecklist` card, or a second click)
  // ticks the same item between the decision's posting and its confirm —
  // the confirmed command must report `alreadyDone` structurally
  // (`WorkflowDecisionCommandResultV1`) instead of silently doing nothing,
  // so the card's own thread can say "Already done" rather than looking
  // broken (RC1, 2026-09-26: the reconcile card's duplicate option "did
  // nothing" when pressed after the other card had already applied it).
  void it("reports 'alreadyDone' when the review's named item is ticked by something else before the confirm runs", async () => {
    const result = await run(
      "race-already-ticked",
      { review: REVIEW_WITH_VERIFIED_ITEMS },
      {
        confirm: true,
        interference: (folder): void => {
          nodeFs.writeFileSync(
            nodePath.join(folder, "plan-final.md"),
            CHECKLIST_PLAN.replace("- [ ] Wire the completeness gate", "- [x] Wire the completeness gate"),
            "utf8"
          );
        },
      }
    );
    assert.equal(result.confirmedResult?.outcome, "alreadyDone");
    assert.match(result.confirmedResult?.message ?? "", /Already done: the 1 reviewer-verified tick is applied/);
    assert.equal(readPlan(result.folder), CHECKLIST_PLAN.replace("- [ ] Wire the completeness gate", "- [x] Wire the completeness gate"));
  });

  // RC2 item 8, Step 37 follow-up (implementation review, narrowed blocker
  // `bbd42447-…-1`): the confirm-time "already applied" count must be scoped
  // to what THIS card actually offered, not the review's raw named-item
  // count — which can include an item this card never offered at all (one
  // that was already ticked before the card was ever posted, named by the
  // same review alongside the one this card DID offer).
  void it(
    "counts only what the card offered as 'already applied' — not an unrelated item the same review also names that was checked before this card ever existed",
    async () => {
      const plan = [
        "<!-- ensemble:implementation-checklist -->",
        "",
        "- [x] Split the artifacts",
        "- [ ] Wire the completeness gate",
        "- [ ] Add the retry button",
        "",
      ].join("\n");
      // Names TWO items verified complete: one already ticked before this
      // card is ever posted ("Split the artifacts" — unrelated pre-existing
      // evidence), and one still unticked ("Wire the completeness gate" —
      // this is the only thing the card will actually offer).
      const review = [
        "Readiness: 9/10",
        "",
        "<!-- verified-complete:start -->",
        "- Wire the completeness gate",
        "- Split the artifacts",
        "<!-- verified-complete:end -->",
        "",
        "<!-- blockers:start -->",
        "<!-- blockers:end -->",
      ].join("\n");
      const result = await run(
        "offered-scope",
        { plan, review },
        {
          confirm: true,
          useRealEffectArgs: true,
          interference: (folder): void => {
            // Something else ticks the ONE item the card offered, between
            // posting and confirming — the genuine race `alreadyDone` exists
            // to report.
            nodeFs.writeFileSync(
              nodePath.join(folder, "plan-final.md"),
              plan.replace("- [ ] Wire the completeness gate", "- [x] Wire the completeness gate"),
              "utf8"
            );
          },
        }
      );
      const applyOption = result.decision?.options.find((o) => o.optionId === "apply");
      assert.match(applyOption?.label ?? "", /Apply 1 Reviewer-Verified Tick/, "the card only ever offered 1 item");
      assert.equal(result.confirmedResult?.outcome, "alreadyDone");
      // Must be 1 (only what the card offered), never 2 (the raw review
      // count, which also swept in the unrelated pre-existing tick).
      assert.match(result.confirmedResult?.message ?? "", /Already done: the 1 reviewer-verified tick is applied/);
    }
  );

  // Same narrowed blocker, second half: an item a review names that matches
  // NO real plan item at all (paraphrase/foreign text) must never be counted
  // as "already applied" evidence.
  void it("never counts a review-named item that matches nothing real in the plan as 'already applied'", async () => {
    const review = [
      "Readiness: 9/10",
      "",
      "<!-- verified-complete:start -->",
      "- Wire the completeness gate",
      "- Some paraphrased text that matches no real plan item",
      "<!-- verified-complete:end -->",
      "",
      "<!-- blockers:start -->",
      "<!-- blockers:end -->",
    ].join("\n");
    const result = await run(
      "unmatched-not-counted",
      { review },
      {
        confirm: true,
        useRealEffectArgs: true,
        interference: (folder): void => {
          nodeFs.writeFileSync(
            nodePath.join(folder, "plan-final.md"),
            CHECKLIST_PLAN.replace("- [ ] Wire the completeness gate", "- [x] Wire the completeness gate"),
            "utf8"
          );
        },
      }
    );
    assert.equal(result.confirmedResult?.outcome, "alreadyDone");
    assert.match(result.confirmedResult?.message ?? "", /Already done: the 1 reviewer-verified tick is applied/);
  });

  // RC2 item 8, Step 37, second narrowing (implementation review,
  // 2026-09-28): the first fix scoped only the "already applied" COUNT,
  // leaving the actual apply operation unscoped — a card offering item A
  // could still be confirmed into ticking a DIFFERENT item B, if the review
  // file was rewritten between post and confirm to newly verify B while A
  // stayed unticked (so the "nothing left to apply" branch never triggers
  // and the confirm falls through to applying the review's CURRENT full set
  // instead of what the card actually promised).
  void it(
    "applies only the item the card offered, never a different item the review newly verifies before confirm",
    async () => {
      const plan = [
        "<!-- ensemble:implementation-checklist -->",
        "",
        "- [ ] Wire the completeness gate",
        "- [ ] Add the retry button",
        "",
      ].join("\n");
      const reviewAtPostTime = [
        "Readiness: 9/10",
        "",
        "<!-- verified-complete:start -->",
        "- Wire the completeness gate",
        "<!-- verified-complete:end -->",
        "",
        "<!-- blockers:start -->",
        "<!-- blockers:end -->",
      ].join("\n");
      const result = await run(
        "offered-scope-race",
        { plan, review: reviewAtPostTime },
        {
          confirm: true,
          useRealEffectArgs: true,
          interference: (folder): void => {
            // A fresher review lands between posting and confirming, naming
            // a DIFFERENT, still-unticked item verified complete. The card
            // in hand never offered this item and must not apply it.
            nodeFs.writeFileSync(
              nodePath.join(folder, "impl-high-review.md"),
              [
                "Readiness: 9/10",
                "",
                "<!-- verified-complete:start -->",
                "- Wire the completeness gate",
                "- Add the retry button",
                "<!-- verified-complete:end -->",
                "",
                "<!-- blockers:start -->",
                "<!-- blockers:end -->",
              ].join("\n"),
              "utf8"
            );
          },
        }
      );
      const applyOption = result.decision?.options.find((o) => o.optionId === "apply");
      assert.match(applyOption?.label ?? "", /Apply 1 Reviewer-Verified Tick/, "the card only ever offered 1 item");
      assert.equal(result.confirmedResult, undefined, "a normal apply, not an alreadyDone re-press");
      const finalPlan = readPlan(result.folder);
      assert.match(finalPlan, /- \[x\] Wire the completeness gate/);
      // The newly-surfaced item must stay unticked: it was never offered by
      // this card.
      assert.match(finalPlan, /- \[ \] Add the retry button/);
    }
  );
});
