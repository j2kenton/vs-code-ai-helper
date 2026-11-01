/**
 * RC2 item 13, Round 3.2 — the "nothing more to build" card's building
 * blocks: the atomic multi-item apply (`applyOpenPlanItemDecisionsV1`), the
 * card's pure content (`buildOpenPlanItemsNeedDecisionCardInputV1`), and the
 * "Decide item by item" in-chat form flow (`decideOpenPlanItemsV1` posts it,
 * `applyOpenPlanItemsFormSubmissionV1` applies it).
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
  applyOpenPlanItemsFormSubmissionV1,
  decideOpenPlanItemsV1,
  dismissOpenPlanItemsFormV1,
  buildOpenPlanItemsNeedDecisionCardInputV1,
  tickAllVerifiedOpenPlanItemsV1,
} from "../commands/decideOpenPlanItemsV1";
import {
  decodeOpenPlanItemsFormsV1,
  OpenPlanItemsFormV1,
  readOpenPlanItemsFormsV1,
} from "../utils/chatHistoryStore";
import { makeOwnedTaskFolder, readTaskProgressForTest } from "./taskFolderFixture";
import { retirePendingQuestionsV1, CARD_RETIRED_BY_TASK_MOVING_ON_REASON_V1 } from "../utils/cardLifecycleV1";
import {
  applyOpenPlanItemDecisionsV1,
  applyOpenPlanItemsFormV1,
  computeOpenPlanItemIdV1,
  countChecklistEvidenceProgressV1,
  listOpenPlanItemRecordsV1,
} from "../utils/implementationChecklist";
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

/**
 * RC3 item 5, Step 10 (engine slice): the chat-form apply path
 * (`applyOpenPlanItemsFormV1`) and its occurrence-aware item identity
 * (`computeOpenPlanItemIdV1`/`listOpenPlanItemRecordsV1`). These are the
 * pure resolution/validation/apply functions the form's persistence and
 * webview rendering (not yet built — see plan-final.md's Step 10) will call;
 * covered standalone here so the engine is correct and tested independent
 * of that wiring.
 */
const DUP_PLAN = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "## Build",
  "",
  "- [x] Add error handling",
  "- [ ] Add error handling",
  "- [ ] A human deployment step",
  "- [ ] A measurement only the owner can take",
  "",
].join("\n");

void describe("listOpenPlanItemRecordsV1 / computeOpenPlanItemIdV1", () => {
  void it("numbers duplicate-text items by occurrence, in plan order, over all items regardless of state", () => {
    const records = listOpenPlanItemRecordsV1(DUP_PLAN);
    assert.deepEqual(
      records.map((r) => [r.itemText, r.occurrence, r.settled]),
      [
        ["Add error handling", 1, true],
        ["Add error handling", 2, false],
        ["A human deployment step", 1, false],
        ["A measurement only the owner can take", 1, false],
      ]
    );
    // Distinct ids for the two identical-text occurrences.
    assert.notEqual(records[0]!.itemId, records[1]!.itemId);
  });

  void it("is stable for the same text+occurrence and differs across occurrences", () => {
    const a1 = computeOpenPlanItemIdV1("Add error handling", 1);
    const a1Again = computeOpenPlanItemIdV1("Add error handling", 1);
    const a2 = computeOpenPlanItemIdV1("Add error handling", 2);
    assert.equal(a1, a1Again);
    assert.notEqual(a1, a2);
  });
});

void describe("applyOpenPlanItemsFormV1", () => {
  void it("applies tick/exclude/leave for a full set of answers, resolving duplicate text to distinct lines", () => {
    const records = listOpenPlanItemRecordsV1(DUP_PLAN);
    const openDup = records.find((r) => r.itemText === "Add error handling" && !r.settled)!;
    const deploy = records.find((r) => r.itemText === "A human deployment step")!;
    const measurement = records.find((r) => r.itemText === "A measurement only the owner can take")!;
    const formItemIds = new Set(records.map((r) => r.itemId));
    const result = applyOpenPlanItemsFormV1(
      DUP_PLAN,
      formItemIds,
      [
        { itemId: openDup.itemId, choice: "tick", note: "verified in the run log" },
        { itemId: deploy.itemId, choice: "exclude", note: "owner hand-off" },
        { itemId: measurement.itemId, choice: "leave" },
      ],
      "2026-09-30"
    );
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.ticked, ["Add error handling"]);
    assert.deepEqual(result.excluded, ["A human deployment step"]);
    assert.deepEqual(result.skipped, []);
    // Only the SECOND (open) occurrence of "Add error handling" was ticked —
    // the first (already-checked) line's own box is untouched.
    const lines = result.content.split("\n").filter((l) => l.includes("Add error handling"));
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /^- \[x\] Add error handling$/);
    assert.match(lines[1]!, /^- \[x\] Add error handling — Checked: verified in the run log\.$/);
  });

  void it("applies a partial answer set, leaving unanswered items open", () => {
    const records = listOpenPlanItemRecordsV1(DUP_PLAN);
    const deploy = records.find((r) => r.itemText === "A human deployment step")!;
    const formItemIds = new Set(records.map((r) => r.itemId));
    const result = applyOpenPlanItemsFormV1(
      DUP_PLAN,
      formItemIds,
      [{ itemId: deploy.itemId, choice: "exclude", note: "owner hand-off" }],
      "2026-09-30"
    );
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.excluded, ["A human deployment step"]);
    assert.match(result.content, /A measurement only the owner can take\n/);
  });

  void it("rejects the whole submission on an unknown itemId, leaving the plan untouched", () => {
    const formItemIds = new Set(listOpenPlanItemRecordsV1(DUP_PLAN).map((r) => r.itemId));
    const result = applyOpenPlanItemsFormV1(
      DUP_PLAN,
      formItemIds,
      [{ itemId: "not-a-real-id", choice: "tick" }],
      "2026-09-30"
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.rejectionReason, /does not match an item on this form/);
  });

  void it("rejects Exclude with a blank reason, leaving the plan untouched", () => {
    const records = listOpenPlanItemRecordsV1(DUP_PLAN);
    const deploy = records.find((r) => r.itemText === "A human deployment step")!;
    const formItemIds = new Set(records.map((r) => r.itemId));
    const result = applyOpenPlanItemsFormV1(
      DUP_PLAN,
      formItemIds,
      [{ itemId: deploy.itemId, choice: "exclude", note: "   " }],
      "2026-09-30"
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.rejectionReason, /needs a reason/);
  });

  void it("rejects a note over the max length", () => {
    const records = listOpenPlanItemRecordsV1(DUP_PLAN);
    const deploy = records.find((r) => r.itemText === "A human deployment step")!;
    const formItemIds = new Set(records.map((r) => r.itemId));
    const result = applyOpenPlanItemsFormV1(
      DUP_PLAN,
      formItemIds,
      [{ itemId: deploy.itemId, choice: "tick", note: "x".repeat(4001) }],
      "2026-09-30"
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.rejectionReason, /too long/);
  });

  void it("skips an item whose text+occurrence no longer exists in the current plan, applying the rest", () => {
    const records = listOpenPlanItemRecordsV1(DUP_PLAN);
    const deploy = records.find((r) => r.itemText === "A human deployment step")!;
    const measurement = records.find((r) => r.itemText === "A measurement only the owner can take")!;
    const formItemIds = new Set(records.map((r) => r.itemId));
    // Plan changed since the form was built: the deployment item's text was edited.
    const editedPlan = DUP_PLAN.replace(
      "- [ ] A human deployment step",
      "- [ ] A human deployment step (revised)"
    );
    const result = applyOpenPlanItemsFormV1(
      editedPlan,
      formItemIds,
      [
        { itemId: deploy.itemId, choice: "exclude", note: "owner hand-off" },
        { itemId: measurement.itemId, choice: "tick", note: "done" },
      ],
      "2026-09-30"
    );
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.excluded, []);
    assert.deepEqual(result.ticked, ["A measurement only the owner can take"]);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0]!.itemId, deploy.itemId);
    assert.match(result.skipped[0]!.reason, /no longer in the plan as written/);
    // The other, unrelated item's answer was not misapplied to a different line.
    assert.match(result.content, /A human deployment step \(revised\)\n/);
  });

  void it("treats a case-only or whitespace-only edit as a different item and skips it", () => {
    const records = listOpenPlanItemRecordsV1(DUP_PLAN);
    const deploy = records.find((r) => r.itemText === "A human deployment step")!;
    const formItemIds = new Set(records.map((r) => r.itemId));
    for (const edited of ["A Human deployment step", "A human  deployment step"]) {
      const editedPlan = DUP_PLAN.replace("- [ ] A human deployment step", `- [ ] ${edited}`);
      const result = applyOpenPlanItemsFormV1(
        editedPlan,
        formItemIds,
        [{ itemId: deploy.itemId, choice: "exclude", note: "owner hand-off" }],
        "2026-09-30"
      );
      assert.ok(result.ok);
      if (!result.ok) return;
      assert.deepEqual(result.excluded, []);
      assert.equal(result.skipped.length, 1);
      assert.match(result.skipped[0]!.reason, /no longer in the plan as written/);
      assert.match(result.content, new RegExp(`- \\[ \\] ${edited}\\n`));
    }
  });

  void it("skips an item that was already settled by the time the form is applied", () => {
    const records = listOpenPlanItemRecordsV1(DUP_PLAN);
    const alreadyChecked = records.find((r) => r.itemText === "Add error handling" && r.settled)!;
    const formItemIds = new Set(records.map((r) => r.itemId));
    const result = applyOpenPlanItemsFormV1(
      DUP_PLAN,
      formItemIds,
      [{ itemId: alreadyChecked.itemId, choice: "tick", note: "again" }],
      "2026-09-30"
    );
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.ticked, []);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0]!.reason, /already settled/);
  });

  void it("double-submit: applying the same answers again settles nothing new and reports the item as already settled", () => {
    const records = listOpenPlanItemRecordsV1(DUP_PLAN);
    const deploy = records.find((r) => r.itemText === "A human deployment step")!;
    const formItemIds = new Set(records.map((r) => r.itemId));
    const answers = [{ itemId: deploy.itemId, choice: "exclude" as const, note: "owner hand-off" }];
    const first = applyOpenPlanItemsFormV1(DUP_PLAN, formItemIds, answers, "2026-09-30");
    assert.ok(first.ok);
    if (!first.ok) return;
    const second = applyOpenPlanItemsFormV1(first.content, formItemIds, answers, "2026-09-30");
    assert.ok(second.ok);
    if (!second.ok) return;
    // The excluded line carries "— Excluded by you: …", which the id ignores,
    // so it still resolves to the same id and is reported as already settled
    // — never a re-exclude or a second Accepted Non-Goals entry.
    assert.deepEqual(second.excluded, []);
    assert.equal(second.content, first.content);
    assert.equal(second.skipped.length, 1);
    assert.match(second.skipped[0]!.reason, /already settled/);
  });

  void it("handles a 40-item form", () => {
    const lines = ["<!-- ensemble:implementation-checklist -->", "", "## Build", ""];
    for (let i = 1; i <= 40; i += 1) {
      lines.push(`- [ ] Step ${i}: do the thing`);
    }
    const bigPlan = lines.join("\n") + "\n";
    const records = listOpenPlanItemRecordsV1(bigPlan);
    assert.equal(records.length, 40);
    const formItemIds = new Set(records.map((r) => r.itemId));
    const answers = records.map((r) => ({ itemId: r.itemId, choice: "tick" as const, note: "done" }));
    const result = applyOpenPlanItemsFormV1(bigPlan, formItemIds, answers, "2026-09-30");
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.ticked.length, 40);
    assert.equal(result.skipped.length, 0);
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

  void it("the decide-item-by-item consequence says leaving every item open runs nothing and the task waits", () => {
    const input = buildOpenPlanItemsNeedDecisionCardInputV1(base);
    const decide = input.options.find((o) => o.optionId === "decideItemByItem");
    assert.match(decide?.consequence ?? "", /If you leave every item open, nothing runs and the task waits/);
    assert.doesNotMatch(decide?.consequence ?? "", /Then builds whatever is still open/);
  });

  void it("does not pause the task", () => {
    const input = buildOpenPlanItemsNeedDecisionCardInputV1(base);
    assert.equal(input.gating?.holdsTaskPaused, false);
  });

  void it("lists each open item with its reason; an item the round named nothing for is 'not reached', never 'no reason given'", () => {
    const input = buildOpenPlanItemsNeedDecisionCardInputV1(base);
    assert.match(input.whatHappened, /A human deployment step — the round said: owner hand-off/);
    assert.match(input.whatHappened, /Runs at Publish — not reached: the round did not report it built or unbuildable/);
    assert.doesNotMatch(input.whatHappened, /no reason given/);
  });

  void it("the decide-item-by-item option's command carries the items with their reasons", () => {
    const input = buildOpenPlanItemsNeedDecisionCardInputV1(base);
    const decide = input.options.find((o) => o.optionId === "decideItemByItem");
    assert.equal(decide?.effect.kind, "command");
    if (decide?.effect.kind !== "command") {
      return;
    }
    assert.equal(decide.effect.command, "vs-code-ai-helper.decideOpenPlanItems");
    assert.deepEqual((decide.effect.args?.[0] as { items?: unknown })?.items, [
      { itemText: "A human deployment step", reason: "the round said: owner hand-off" },
      { itemText: "Runs at Publish", reason: "not reached: the round did not report it built or unbuildable" },
    ]);
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
  function makeTaskFolder(_name: string, plan: string): string {
    const { folder } = makeOwnedTaskFolder("ensemble-open-items-form-");
    nodeFs.writeFileSync(nodePath.join(folder, "plan-final.md"), plan, "utf8");
    return folder;
  }

  /** Fail the test if any pop-up is opened: the flow is in-chat only. */
  function forbidPopups(): () => void {
    const win = vscode.window as unknown as Record<string, unknown>;
    const origPick = win.showQuickPick;
    const origInput = win.showInputBox;
    const boom = (): never => {
      throw new Error("open-items flow must not open a pick list or input box");
    };
    win.showQuickPick = boom;
    win.showInputBox = boom;
    return (): void => {
      win.showQuickPick = origPick;
      win.showInputBox = origInput;
    };
  }

  async function postForm(
    folder: string,
    items: { itemText: string; reason: string }[],
    extra: { resumeFastForwardV1?: { attemptNumber: number; maxAttempts: number } } = {}
  ): Promise<OpenPlanItemsFormV1> {
    const restore = forbidPopups();
    try {
      const result = await decideOpenPlanItemsV1({ taskFolderPath: folder, stage: "impl", items, ...extra });
      assert.deepEqual(result, { outcome: "done" });
    } finally {
      restore();
    }
    const forms = await readOpenPlanItemsFormsV1(folder, folder, "impl");
    const form = forms.filter((f) => f.state === "open").pop();
    assert.ok(form, "a form must have been posted into the chat document");
    return form;
  }

  function idOf(form: OpenPlanItemsFormV1, text: string, occurrence = 1): string {
    const item = form.items.find((i) => i.itemText === text && i.occurrence === occurrence);
    assert.ok(item, `form item not found: ${text}`);
    return item.itemId;
  }

  function submit(folder: string, form: OpenPlanItemsFormV1, answers: unknown) {
    return applyOpenPlanItemsFormSubmissionV1({
      taskFolderPath: folder,
      canonicalId: folder,
      formId: form.formId,
      answers,
    });
  }

  function readPlan(folder: string): string {
    return nodeFs.readFileSync(nodePath.join(folder, "plan-final.md"), "utf8");
  }

  void it("retires a departed-stage form and refuses a previously rendered submission", async () => {
    const folder = makeTaskFolder("departure", "<!-- ensemble:implementation-checklist -->\n- [ ] Work\n");
    const form = await postForm(folder, [{ itemText: "Work", reason: "" }]);
    const before = readPlan(folder);
    await retirePendingQuestionsV1(folder, folder, CARD_RETIRED_BY_TASK_MOVING_ON_REASON_V1, { stage: "impl" });
    const result = await submit(folder, form, [{ itemId: form.items[0]!.itemId, choice: "tick" }]);
    assert.equal(result.kind, "ignored");
    assert.match(result.message, /retired by the task moving on/);
    assert.equal(readPlan(folder), before);
    const stored = (await readOpenPlanItemsFormsV1(folder, folder))[0]!;
    assert.equal(stored.state, "stale");
    assert.equal(stored.closedReason, CARD_RETIRED_BY_TASK_MOVING_ON_REASON_V1);
  });

  void it("dismisses a form with actor and time, and refuses its later answers", async () => {
    const folder = makeTaskFolder("dismiss", "<!-- ensemble:implementation-checklist -->\n- [ ] Work\n");
    const form = await postForm(folder, [{ itemText: "Work", reason: "" }]);
    const before = readPlan(folder);
    const closed = await dismissOpenPlanItemsFormV1(folder, folder, form.formId, "owner");
    assert.equal(closed?.closedBy, "owner");
    assert.ok(closed?.closedAt);
    const result = await submit(folder, form, [{ itemId: form.items[0]!.itemId, choice: "tick" }]);
    assert.equal(result.kind, "ignored");
    assert.match(result.message, /dismissed by the owner/);
    assert.equal(readPlan(folder), before);
  });

  void it("refuses a submission after the task stage changes before retirement runs", async () => {
    const folder = makeTaskFolder("stage-race", "<!-- ensemble:implementation-checklist -->\n- [ ] Work\n");
    const form = await postForm(folder, [{ itemText: "Work", reason: "" }]);
    const progressPath = nodePath.join(folder, "task-progress.json");
    const progress = JSON.parse(nodeFs.readFileSync(progressPath, "utf8")) as Record<string, unknown>;
    progress.currentStage = "impl-high-review";
    nodeFs.writeFileSync(progressPath, JSON.stringify(progress));
    const before = readPlan(folder);
    const result = await submit(folder, form, [{ itemId: form.items[0]!.itemId, choice: "tick" }]);
    assert.equal(result.kind, "ignored");
    assert.match(result.message, /stage is no longer current/);
    assert.equal(readPlan(folder), before);
  });

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

  const FOUR_PLAN = [
    "<!-- ensemble:implementation-checklist -->",
    "",
    "## Build",
    "",
    "- [ ] Owner item one",
    "- [ ] Owner item two",
    "- [ ] Owner item three",
    "- [ ] Owner item four",
    "",
  ].join("\n");
  const FOUR_ITEMS = ["Owner item one", "Owner item two", "Owner item three", "Owner item four"].map(
    (itemText) => ({ itemText, reason: "needs the owner" })
  );

  void it("posts a chat form with every open item and its reason, and opens no pop-up", async () => {
    const folder = makeTaskFolder("flow-post", FOUR_PLAN);
    const form = await postForm(folder, FOUR_ITEMS);
    assert.equal(form.state, "open");
    assert.equal(form.stage, "impl");
    assert.deepEqual(
      form.items.map((i) => [i.itemText, i.occurrence, i.reason]),
      FOUR_ITEMS.map((i) => [i.itemText, 1, "needs the owner"])
    );
    assert.equal(readPlan(folder), FOUR_PLAN, "posting the form must not touch the plan");
  });

  void it("four open items: exclude three and tick one in one Apply, with one Accepted Non-Goals entry", async () => {
    const folder = makeTaskFolder("flow-four", FOUR_PLAN);
    const form = await postForm(folder, FOUR_ITEMS);
    const result = await submit(folder, form, [
      { itemId: idOf(form, "Owner item one"), choice: "exclude", note: "hand-off one" },
      { itemId: idOf(form, "Owner item two"), choice: "exclude", note: "hand-off two" },
      { itemId: idOf(form, "Owner item three"), choice: "exclude", note: "hand-off three" },
      { itemId: idOf(form, "Owner item four"), choice: "tick", note: "checked" },
    ]);
    assert.equal(result.kind, "applied");
    const content = readPlan(folder);
    assert.match(content, /- \[x\] Owner item four — Checked: checked\./);
    assert.equal([...content.matchAll(/<!-- ensemble:excluded -->/g)].length, 3);
    assert.equal([...content.matchAll(/### Open items settled by the owner/g)].length, 1);
    const stored = (await readOpenPlanItemsFormsV1(folder, folder)).find((f) => f.formId === form.formId);
    assert.equal(stored?.state, "applied");
  });

  void it("bugs4 item 7: form ticks are recorded with owner provenance and settle the gate, even with notes and across two forms", async () => {
    const folder = makeTaskFolder("flow-owner", FOUR_PLAN);
    const first = await postForm(folder, FOUR_ITEMS);
    const firstResult = await submit(folder, first, [
      { itemId: idOf(first, "Owner item one"), choice: "tick", note: "did it" },
      { itemId: idOf(first, "Owner item two"), choice: "tick" },
    ]);
    assert.equal(firstResult.kind, "applied");
    assert.match(firstResult.message, /Gate: 2 ticked, 0 verified by review, 2 settled by you/);

    const second = await postForm(folder, [
      { itemText: "Owner item three", reason: "needs the owner" },
      { itemText: "Owner item four", reason: "needs the owner" },
    ]);
    const secondResult = await submit(folder, second, [
      { itemId: idOf(second, "Owner item three"), choice: "tick", note: "also did it" },
      { itemId: idOf(second, "Owner item four"), choice: "tick", note: "and this" },
    ]);
    assert.equal(secondResult.kind, "applied");
    // The second write changed the plan revision (notes change item text); the
    // first form's decisions must still count.
    assert.match(secondResult.message, /Gate: 4 ticked, 0 verified by review, 4 settled by you; 4 of 4 settled/);

    const progress = await readTaskProgressForTest(vscode.Uri.file(folder));
    const gate = countChecklistEvidenceProgressV1(readPlan(folder), progress?.planItemEvidence ?? [], progress?.planItemOwnerDecisions ?? []);
    assert.ok(gate);
    assert.equal(gate.gate.remaining, 0);
    assert.equal(gate.verified, 0, "owner decisions are never reviewer verification");
    assert.equal(gate.ownerSettled, 4);
    const decisions = progress?.planItemOwnerDecisions ?? [];
    assert.ok(decisions.length >= 4);
    assert.ok((progress?.planItemEvidence ?? []).every((entry) => !("ownerDecisions" in entry)));
    assert.ok(decisions.every((d) => d.source === "owner" && d.decision === "tick" && d.formId.length > 0));
  });

  void it("bugs4 Step 20: 'Tick all N' ticks every listed item in one pass with owner provenance and one outcome message", async () => {
    const folder = makeTaskFolder("flow-tick-all", FOUR_PLAN);
    const restore = forbidPopups();
    let result: unknown;
    try {
      result = await tickAllVerifiedOpenPlanItemsV1({ taskFolderPath: folder, stage: "impl", items: FOUR_ITEMS });
    } finally {
      restore();
    }
    const outcome = result as { outcome: string; message: string };
    assert.equal(outcome.outcome, "done");
    assert.match(outcome.message, /ticked 4 in plan-final\.md/);
    assert.match(outcome.message, /4 settled by you/);
    const content = readPlan(folder);
    assert.equal([...content.matchAll(/- \[x\] Owner item/g)].length, 4);
    assert.match(content, /settled by your decision; no test report recorded/);
    const progress = await readTaskProgressForTest(vscode.Uri.file(folder));
    const gate = countChecklistEvidenceProgressV1(content, progress?.planItemEvidence ?? [], progress?.planItemOwnerDecisions ?? []);
    assert.ok(gate);
    assert.equal(gate.verified, 0, "Tick all is never reviewer verification");
    assert.equal(gate.ownerSettled, 4);
    assert.equal(gate.gate.remaining, 0);
  });

  void it("bugs4 Step 20: 'Tick all N' on items no longer open ticks nothing and says so", async () => {
    const folder = makeTaskFolder("flow-tick-all-stale", "<!-- ensemble:implementation-checklist -->\n- [x] Owner item one\n");
    const result = (await tickAllVerifiedOpenPlanItemsV1({
      taskFolderPath: folder,
      stage: "impl",
      items: [{ itemText: "Owner item one", reason: "" }],
    })) as { outcome: string; message: string };
    assert.equal(result.outcome, "done");
    assert.match(result.message, /none of these items is still open/);
  });

  void it("leaving every item open reports that nothing will run and leaves the plan untouched", async () => {
    const folder = makeTaskFolder("flow-none", FOUR_PLAN);
    const form = await postForm(folder, FOUR_ITEMS);
    const exec = installExecuteCommandCapture();
    let result: Awaited<ReturnType<typeof submit>>;
    try {
      result = await submit(
        folder,
        form,
        FOUR_ITEMS.map((i) => ({ itemId: idOf(form, i.itemText), choice: "leave", note: "" }))
      );
    } finally {
      exec.restore();
    }
    assert.equal(result.kind, "applied");
    assert.equal(
      (result as { message: string }).message,
      "No items were changed. Nothing will run; the items stay open. Fix what blocks them, then use Fast Forward or Apply Review."
    );
    assert.equal(readPlan(folder), FOUR_PLAN);
    assert.deepEqual(exec.calls, [], "a no-change Apply must dispatch nothing");
  });

  void it("answering only two applies those two and leaves the others open", async () => {
    const folder = makeTaskFolder("flow-partial", FOUR_PLAN);
    const form = await postForm(folder, FOUR_ITEMS);
    const result = await submit(folder, form, [
      { itemId: idOf(form, "Owner item one"), choice: "exclude", note: "hand-off" },
      { itemId: idOf(form, "Owner item two"), choice: "tick", note: "done" },
      { itemId: idOf(form, "Owner item three"), choice: "leave", note: "" },
      { itemId: idOf(form, "Owner item four"), choice: "leave", note: "" },
    ]);
    assert.equal(result.kind, "applied");
    const content = readPlan(folder);
    assert.match(content, /- \[ \] Owner item three\n/);
    assert.match(content, /- \[ \] Owner item four\n/);
    assert.match(content, /- \[x\] Owner item two — Checked: done\./);
    assert.match(content, /Owner item one — Excluded by you: hand-off\./);
  });

  void it("a blank Exclude reason (or an unknown id) is rejected, nothing is written and the form stays open", async () => {
    const folder = makeTaskFolder("flow-reject", FOUR_PLAN);
    const form = await postForm(folder, FOUR_ITEMS);
    const blank = await submit(folder, form, [
      { itemId: idOf(form, "Owner item one"), choice: "exclude", note: "   " },
      { itemId: idOf(form, "Owner item two"), choice: "tick", note: "done" },
    ]);
    assert.equal(blank.kind, "rejected");
    const unknown = await submit(folder, form, [{ itemId: "nope", choice: "tick", note: "x" }]);
    assert.equal(unknown.kind, "rejected");
    assert.equal(readPlan(folder), FOUR_PLAN);
    const stored = (await readOpenPlanItemsFormsV1(folder, folder)).find((f) => f.formId === form.formId);
    assert.equal(stored?.state, "open");
  });

  void it("a second submit of an applied form is ignored", async () => {
    const folder = makeTaskFolder("flow-double", FOUR_PLAN);
    const form = await postForm(folder, FOUR_ITEMS);
    const answers = [{ itemId: idOf(form, "Owner item one"), choice: "tick", note: "done" }];
    assert.equal((await submit(folder, form, answers)).kind, "applied");
    const afterFirst = readPlan(folder);
    assert.equal((await submit(folder, form, answers)).kind, "ignored");
    assert.equal(readPlan(folder), afterFirst);
  });

  void it("a stale form skips an item edited out of the plan, never applying it to a different line", async () => {
    const folder = makeTaskFolder("flow-stale", FOUR_PLAN);
    const form = await postForm(folder, FOUR_ITEMS);
    // The owner edits item two's text and ticks item one by hand before pressing Apply.
    nodeFs.writeFileSync(
      nodePath.join(folder, "plan-final.md"),
      FOUR_PLAN.replace("Owner item two", "Owner item 2 (reworded)").replace("- [ ] Owner item one", "- [x] Owner item one"),
      "utf8"
    );
    const result = await submit(folder, form, [
      { itemId: idOf(form, "Owner item one"), choice: "tick", note: "x" },
      { itemId: idOf(form, "Owner item two"), choice: "exclude", note: "gone" },
      { itemId: idOf(form, "Owner item three"), choice: "tick", note: "ok" },
    ]);
    assert.equal(result.kind, "applied");
    assert.match(result.message, /no longer in the plan as written/);
    assert.match(result.message, /already settled/);
    const content = readPlan(folder);
    assert.match(content, /- \[ \] Owner item 2 \(reworded\)\n/, "the reworded line is untouched");
    assert.match(content, /- \[x\] Owner item three — Checked: ok\./);
    assert.ok(!content.includes("ensemble:excluded"));
  });

  void it("two items with identical text resolve to distinct plan lines", async () => {
    const plan = [
      "<!-- ensemble:implementation-checklist -->",
      "",
      "- [ ] Add error handling",
      "- [ ] Add error handling",
      "",
    ].join("\n");
    const folder = makeTaskFolder("flow-dup", plan);
    const form = await postForm(folder, [
      { itemText: "Add error handling", reason: "" },
      { itemText: "Add error handling", reason: "" },
    ]);
    assert.deepEqual(form.items.map((i) => i.occurrence), [1, 2]);
    assert.notEqual(form.items[0]!.itemId, form.items[1]!.itemId);
    const result = await submit(folder, form, [
      { itemId: form.items[1]!.itemId, choice: "tick", note: "second" },
    ]);
    assert.equal(result.kind, "applied");
    const lines = readPlan(folder).split("\n");
    assert.equal(lines[2], "- [ ] Add error handling");
    assert.match(lines[3]!, /^- \[x\] Add error handling — Checked: second\./);
  });

  void it("a 40-item form renders 40 rows and applies each answer", async () => {
    const texts = Array.from({ length: 40 }, (_, i) => `Bulk item ${i + 1}`);
    const plan = ["<!-- ensemble:implementation-checklist -->", "", ...texts.map((t) => `- [ ] ${t}`), ""].join("\n");
    const folder = makeTaskFolder("flow-40", plan);
    const form = await postForm(folder, texts.map((itemText) => ({ itemText, reason: "" })));
    assert.equal(form.items.length, 40);
    const result = await submit(
      folder,
      form,
      form.items.map((i) => ({ itemId: i.itemId, choice: "tick", note: "ok" }))
    );
    assert.equal(result.kind, "applied");
    assert.equal([...readPlan(folder).matchAll(/- \[x\] Bulk item/g)].length, 40);
  });

  void it("an item this flow already settled (annotated line) is reported as already settled, not as gone", async () => {
    const folder = makeTaskFolder("flow-annotated", FOUR_PLAN);
    const form = await postForm(folder, FOUR_ITEMS);
    const id = idOf(form, "Owner item one");
    assert.equal((await submit(folder, form, [{ itemId: id, choice: "exclude", note: "first" }])).kind, "applied");
    const second = await postForm(folder, FOUR_ITEMS.slice(1));
    // Re-apply the FIRST form's id against the now-annotated plan through a fresh form entry.
    const engine = applyOpenPlanItemsFormV1(
      readPlan(folder),
      new Set([id, ...second.items.map((i) => i.itemId)]),
      [{ itemId: id, choice: "tick", note: "again" }],
      "2026-09-30"
    );
    assert.ok(engine.ok);
    assert.match(engine.skipped[0]!.reason, /already settled/);
  });

  void it("the decoder round-trips a persisted form and rejects a malformed one", () => {
    const good = decodeOpenPlanItemsFormsV1([
      {
        formId: "a".repeat(32),
        taskBindingId: "b",
        stage: "impl",
        items: [{ itemId: "i", itemText: "t", occurrence: 1, reason: "" }],
        planFingerprint: "f",
        resumeFastForwardV1: { attemptNumber: 1, maxAttempts: 3 },
        state: "open",
        postedAt: "2026-09-30T00:00:00.000Z",
      },
    ]);
    assert.equal(good?.[0]?.resumeFastForwardV1?.maxAttempts, 3);
    assert.equal(decodeOpenPlanItemsFormsV1([{ formId: "short" }]), undefined);
    assert.deepEqual(decodeOpenPlanItemsFormsV1(undefined), []);
  });

  void it("the command source no longer opens any pick list or input box", () => {
    const source = nodeFs.readFileSync(
      nodePath.join(__dirname, "..", "..", "src", "commands", "decideOpenPlanItemsV1.ts"),
      "utf8"
    );
    assert.ok(!/showQuickPick|showInputBox/.test(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
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
    // Only "A human deployment step" is decided; "A measurement only the
    // owner can take" and "Something the round actually did" stay open.
    const exec = installExecuteCommandCapture();
    try {
      const form = await postForm(folder, [{ itemText: "A human deployment step", reason: "" }], {
        resumeFastForwardV1: { attemptNumber: 3, maxAttempts: 10 },
      });
      const result = await submit(folder, form, [
        { itemId: idOf(form, "A human deployment step"), choice: "exclude", note: "owner hand-off" },
      ]);
      assert.equal(result.kind, "applied");
      assert.match(result.message, /3 item\(s\) are still open, so .* stage action was dispatched to build them/);
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

  void it("bugs4 item 7: when every open item is ticked through the form, the gate counts them settled and the Advance card is posted (no round dispatched)", async () => {
    const folder = makeTaskFolder("flow-advance", FOUR_PLAN);
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
    setExtensionContextV1({ globalState: memento, workspaceState: memento, subscriptions: [] } as unknown as vscode.ExtensionContext);
    const exec = installExecuteCommandCapture();
    try {
      const form = await postForm(folder, FOUR_ITEMS);
      const result = await submit(folder, form, FOUR_ITEMS.map((item) => ({
        itemId: idOf(form, item.itemText), choice: "tick" as const, note: "done by me",
      })));
      assert.equal(result.kind, "applied");
      assert.equal(
        exec.calls.some((c) => c.command === "vs-code-ai-helper.resumeAndApplyCurrentStageAction"),
        false,
        "nothing is open, so no round is dispatched"
      );
      const pending = new WorkflowDecisionStoreV1(memento).listPending(folder);
      const advance = pending.find((d) => d.decisionKey === "openPlanItemsSettledOfferAdvance");
      assert.ok(advance, `the Advance card must be posted; pending: ${JSON.stringify(pending)}`);
    } finally {
      exec.restore();
      setExtensionContextV1(undefined as unknown as vscode.ExtensionContext);
    }
  });

  void it("keeps a model-ticked item provisional (the owner-ticked one is settled) and does not offer Advance", async () => {
    const folder = makeTaskFolder("flow-6", PLAN);
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
      // Exclude two owner-only items and self-tick one. The checkbox is now
      // visible as complete, but without reviewer evidence it remains open to
      // the stage gate and must not offer Advance.
      const form = await postForm(folder, [
        { itemText: "A human deployment step", reason: "" },
        { itemText: "A measurement only the owner can take", reason: "" },
        { itemText: "Something the round actually did", reason: "" },
      ]);
      const result = await submit(folder, form, [
        { itemId: idOf(form, "A human deployment step"), choice: "exclude", note: "owner hand-off" },
        { itemId: idOf(form, "A measurement only the owner can take"), choice: "exclude", note: "owner hand-off" },
        { itemId: idOf(form, "Something the round actually did"), choice: "tick", note: "verified" },
      ]);
      assert.equal(result.kind, "applied");
      // bugs4 item 6: every box is now ticked or excluded, yet the gate still
      // counts the model's earlier self-tick ("Build the thing") as unverified.
      // The form says so in its one chat line instead of dispatching a round to
      // "build" a finished item. bugs4 item 7: the owner's own tick, made through
      // this form, is settled by their decision and is not part of that count.
      assert.equal(
        exec.calls.some((c) => c.command === "vs-code-ai-helper.resumeAndApplyCurrentStageAction"),
        false,
        "no round may be dispatched to build items the owner just ticked"
      );
      assert.match(result.message, /Nothing was started/);
      assert.match(result.message, /the completeness gate still counts 1 of 4 as not yet verified/);
      assert.match(result.message, /0 verified by review, 1 ticked without review verification/);
      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const pending = store.listPending(folder);
      const advanceCard = pending.find((d) => d.decisionKey === "openPlanItemsSettledOfferAdvance");
      assert.equal(advanceCard, undefined, `provisional work must not offer Advance; pending: ${JSON.stringify(pending)}`);
    } finally {
      exec.restore();
      setExtensionContextV1(undefined as unknown as vscode.ExtensionContext);
    }
  });
});
