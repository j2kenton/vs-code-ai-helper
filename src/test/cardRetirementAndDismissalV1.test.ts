/**
 * bugs3 Step 8 — retire and dismiss every pending card kind.
 *
 * Covers decisions and question cards (including the owner-evidence question):
 * retirement on stage departure, dismissal that dispatches nothing and writes
 * nothing to task.md, late answers refused with the recorded reason, the
 * waiter released for a retired free-text question, the legacy (pre-field)
 * record shape, and the concurrent answer/retirement race.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import type { CreateWorkflowDecisionInputV1 } from "../types/workflowDecisionV1";
import {
  CARD_RETIRED_BY_TASK_MOVING_ON_REASON_V1,
  describeCardDismissalV1,
  describeQuestionSettlementV1,
  describeSettledDecisionRefusalV1,
  dismissPendingQuestionV1,
  retirePendingQuestionsV1,
  retireQuestionIfWaiterGoneV1,
} from "../utils/cardLifecycleV1";
import {
  appendChatAnswerToPendingQuestionV1,
  appendChatInteraction,
  appendChatMessageV1,
  CHAT_HISTORY_FILENAME,
  LOCAL_ONLY_INTERACTION_ACTION_KEY_V1,
  chatQuestionKeyV1,
  readChatHistory,
  readChatInteractions,
  recordChatInteractionAnswers,
  settleChatInteraction,
  settleChatQuestionsV1,
  type ChatMessage,
} from "../utils/chatHistoryStore";
import {
  __resetChatFreeTextTestOnlyV1,
  askChatFreeTextV1,
  chatFreeTextMarkerV1,
  registerChatFreeTextAnswerV1,
} from "../utils/chatFreeTextV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import type * as vscode from "vscode";
import { OWNER_EVIDENCE_ANSWER_MARKER_V1 } from "../utils/ownerEvidenceV1";
import { retirePendingWorkflowDecisionsForTaskV1 } from "../utils/workflowDecisionDispatchV1";
import { DEPARTED_STAGE_DECISION_RETIRED_REASON_V1 } from "../utils/stageTransition";
import { configureWorkflowPrivateStorageRootV1 } from "../services/workflowRuntimeServicesV1";
import { DISMISS_DECISION_OPTION_ID_V1 } from "../views/chatView";
import { makeOwnedTaskFolder } from "./taskFolderFixture";

configureWorkflowPrivateStorageRootV1(fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-card-private-storage-")));

function question(id: string, stage: ChatMessage["stage"], at: string, text = `Question ${id}`): ChatMessage {
  return { role: "question", text, stage, at, pending: true, id };
}

const answerTo = (key: string): ChatMessage => ({
  role: "user",
  text: "pasted evidence",
  stage: "impl",
  at: "2026-10-26T19:00:00.000Z",
  answersQuestionAt: key,
});

async function seed(folder: string, messages: readonly ChatMessage[]): Promise<void> {
  for (const m of messages) {
    await appendChatMessageV1(folder, m);
  }
}

function makeTask(): { folder: string; taskMd: string } {
  const { folder } = makeOwnedTaskFolder("ensemble-card-lifecycle-");
  const taskMd = path.join(folder, "task.md");
  fs.writeFileSync(taskMd, "# Task\n\n## Owner evidence\n\n(none yet)\n", "utf8");
  return { folder, taskMd };
}

class FakeMemento {
  private readonly values = new Map<string, unknown>();
  get<T>(key: string, defaultValue: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }
  update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

function decisionInput(overrides: Partial<CreateWorkflowDecisionInputV1> = {}): CreateWorkflowDecisionInputV1 {
  return {
    decisionId: "d-1",
    decisionKey: "exampleDecision",
    taskCanonicalId: "/tmp/tasks/task-1",
    stage: "impl",
    whatHappened: "The round finished.",
    whyUserNeeded: "Needs a choice.",
    options: [
      {
        optionId: "go",
        label: "Go",
        consequence: "Goes.",
        resumeKind: "unpause",
        effect: { kind: "command", command: "ensemble.go" },
      },
      {
        optionId: "wait",
        label: "Wait",
        consequence: "Waits.",
        resumeKind: "unpause",
        effect: { kind: "doNothing" },
      },
    ],
    recommendation: { kind: "option", optionId: "wait", reasoning: "Safe." },
    createdAt: "2026-10-26T10:00:00.000Z",
    ...overrides,
  };
}

void describe("question retirement on stage departure (bugs3 Step 8)", () => {
  void it("retires the owner-evidence question and any other question raised on the departed stage, not other stages", async () => {
    const { folder } = makeTask();
    await seed(folder, [
      question("q-evidence", "plan-low-review", "2026-10-26T16:38:00.000Z", `Owner evidence needed ${OWNER_EVIDENCE_ANSWER_MARKER_V1}\nBlocker: x`),
      question("q-other", "plan-low-review", "2026-10-26T16:38:01.000Z"),
      question("q-later-stage", "impl", "2026-10-26T16:38:02.000Z"),
    ]);

    const closed = await retirePendingQuestionsV1(folder, folder, DEPARTED_STAGE_DECISION_RETIRED_REASON_V1, {
      stage: "plan-low-review",
    });

    assert.deepEqual(closed.map(chatQuestionKeyV1).sort(), ["q-evidence", "q-other"]);
    const history = await readChatHistory(folder, folder);
    const byId = new Map(history.map((m) => [m.id, m]));
    for (const id of ["q-evidence", "q-other"]) {
      const m = byId.get(id)!;
      assert.equal(m.pending, false, `${id} must no longer be pending`);
      assert.equal(m.settlement?.kind, "retired");
      assert.equal(m.settlement?.reason, "retired by the task moving on, not answered");
    }
    assert.equal(byId.get("q-later-stage")!.pending, true, "a question on another stage stays open");
    assert.equal(byId.get("q-later-stage")!.settlement, undefined);
  });

  void it("never retires a question raised after the transition began", async () => {
    const { folder } = makeTask();
    await seed(folder, [
      question("q-before", "plan-low-review", "2026-10-26T16:38:00.000Z"),
      question("q-after", "plan-low-review", "2026-10-26T16:41:00.000Z"),
    ]);
    const closed = await retirePendingQuestionsV1(folder, folder, CARD_RETIRED_BY_TASK_MOVING_ON_REASON_V1, {
      stage: "plan-low-review",
      raisedAtOrBefore: "2026-10-26T16:40:00.000Z",
    });
    assert.deepEqual(closed.map(chatQuestionKeyV1), ["q-before"]);
  });

  void it("leaves an already-answered question alone", async () => {
    const { folder } = makeTask();
    await seed(folder, [
      question("q-answered", "plan-low-review", "2026-10-26T16:38:00.000Z"),
      { role: "user", text: "answer", stage: "plan-low-review", at: "2026-10-26T16:39:00.000Z", answersQuestionAt: "q-answered" },
    ]);
    const closed = await retirePendingQuestionsV1(folder, folder, "x", { stage: "plan-low-review" });
    assert.equal(closed.length, 0);
  });

  void it("the stage-departure path (retirePendingWorkflowDecisionsForTaskV1) retires questions too", async () => {
    const { folder } = makeTask();
    await seed(folder, [question("q-evidence", "plan-low-review", "2026-10-26T16:38:00.000Z")]);
    await retirePendingWorkflowDecisionsForTaskV1(
      { taskFolderPath: folder, canonicalId: folder },
      DEPARTED_STAGE_DECISION_RETIRED_REASON_V1,
      { stage: "plan-low-review", raisedAtOrBefore: "2026-10-26T16:40:00.000Z" }
    );
    const history = await readChatHistory(folder, folder);
    assert.equal(history.find((m) => m.id === "q-evidence")?.settlement?.kind, "retired");
  });

  void it("a resume retires only the owner-evidence question, not other questions (the moot-by-resume path)", async () => {
    const { folder } = makeTask();
    await seed(folder, [
      question("q-evidence", "impl", "2026-10-26T16:38:00.000Z", `Owner evidence needed ${OWNER_EVIDENCE_ANSWER_MARKER_V1}`),
      question("q-other", "impl", "2026-10-26T16:38:01.000Z"),
    ]);
    const closed = await retirePendingQuestionsV1(
      folder,
      folder,
      "retired because the task was resumed, so the stage's review runs again",
      { matches: (q) => q.text.includes(OWNER_EVIDENCE_ANSWER_MARKER_V1) }
    );
    assert.deepEqual(closed.map(chatQuestionKeyV1), ["q-evidence"]);
    const history = await readChatHistory(folder, folder);
    assert.equal(history.find((m) => m.id === "q-other")?.pending, true);
  });

  void it("releases a command waiting on a retired free-text question with no answer", async () => {
    __resetChatFreeTextTestOnlyV1();
    const { folder } = makeTask();
    const id = "ab12cd34";
    let released: string | undefined = "not-called";
    registerChatFreeTextAnswerV1(id, (answer) => {
      released = answer;
    });
    await seed(folder, [
      question("q-free", "impl", "2026-10-26T16:38:00.000Z", `Pick a folder ${chatFreeTextMarkerV1(id)}`),
    ]);
    await retirePendingQuestionsV1(folder, folder, "x", { stage: "impl" });
    assert.equal(released, undefined, "the waiter is released with undefined, not left hanging");
  });

  void it("closes a free-text question whose waiter is gone, so a late answer is refused with the restart reason", async () => {
    __resetChatFreeTextTestOnlyV1();
    const { folder } = makeTask();
    const text = `Pick a folder ${chatFreeTextMarkerV1("feed01")}`;
    await seed(folder, [question("q-orphan", "impl", "2026-10-26T16:38:00.000Z", text)]);

    const settlement = await retireQuestionIfWaiterGoneV1(folder, folder, { id: "q-orphan", at: "2026-10-26T16:38:00.000Z", text });
    assert.equal(settlement?.kind, "retired");
    assert.match(settlement?.reason ?? "", /start that action again/);

    // The card is closed, so the guarded save refuses the answer and writes nothing.
    const refused = await appendChatAnswerToPendingQuestionV1(folder, folder, "q-orphan", answerTo("q-orphan"));
    assert.equal(refused.kind, "settled");
    assert.equal((await readChatHistory(folder, folder)).filter((m) => m.role === "user").length, 0);
  });

  void it("names the asking action's own restart step in the withdrawal when the question carried one", async () => {
    __resetChatFreeTextTestOnlyV1();
    const { folder } = makeTask();
    const text =
      `Tick this item — ${chatFreeTextMarkerV1("feed03")}\nWhat did you see?` +
      `\n\nIf this question is still open after a window reload it is withdrawn; to run it again: choose Tick on that plan item again.`;
    await seed(folder, [question("q-guided", "impl", "2026-10-26T16:38:00.000Z", text)]);
    const settlement = await retireQuestionIfWaiterGoneV1(folder, folder, { id: "q-guided", at: "2026-10-26T16:38:00.000Z", text });
    assert.equal(settlement?.kind, "retired");
    assert.match(settlement?.reason ?? "", /choose Tick on that plan item again\./);
    assert.doesNotMatch(settlement?.reason ?? "", /start that action again/, "the generic wording is replaced by the specific step");
  });

  void it("leaves a free-text question alone while its command is still waiting", async () => {
    __resetChatFreeTextTestOnlyV1();
    const { folder } = makeTask();
    registerChatFreeTextAnswerV1("feed02", () => undefined);
    const text = `Pick a folder ${chatFreeTextMarkerV1("feed02")}`;
    await seed(folder, [question("q-live", "impl", "2026-10-26T16:38:00.000Z", text)]);
    assert.equal(await retireQuestionIfWaiterGoneV1(folder, folder, { id: "q-live", at: "2026-10-26T16:38:00.000Z", text }), undefined);
    assert.equal((await appendChatAnswerToPendingQuestionV1(folder, folder, "q-live", answerTo("q-live"))).kind, "answered");
    __resetChatFreeTextTestOnlyV1();
  });

  void it("never treats a durable question without a waiter marker (owner evidence) as orphaned", async () => {
    __resetChatFreeTextTestOnlyV1();
    const { folder } = makeTask();
    await seed(folder, [question("q-durable", "impl", "2026-10-26T16:38:00.000Z", `Owner evidence needed ${OWNER_EVIDENCE_ANSWER_MARKER_V1}`)]);
    assert.equal(
      await retireQuestionIfWaiterGoneV1(folder, folder, { id: "q-durable", at: "2026-10-26T16:38:00.000Z", text: `Owner evidence needed ${OWNER_EVIDENCE_ANSWER_MARKER_V1}` }),
      undefined
    );
    assert.equal((await readChatHistory(folder, folder)).find((m) => m.id === "q-durable")?.pending, true);
  });

  void it("retires a question posted by the production free-text producer and releases its waiter", async () => {
    const { folder } = makeTask();
    __extensionContextV1TestOnly.set({} as vscode.ExtensionContext);
    try {
      const answer = askChatFreeTextV1({ target: { taskFolderPath: folder, canonicalId: folder, stage: "impl" }, prompt: "Choose a folder" });
      let posted: ChatMessage | undefined;
      for (let i = 0; i < 100 && !posted; i++) {
        posted = (await readChatHistory(folder, folder)).find((m) => m.role === "question");
        if (!posted) await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.ok(posted);
      assert.equal(posted.pending, true);
      await retirePendingQuestionsV1(folder, folder, CARD_RETIRED_BY_TASK_MOVING_ON_REASON_V1, { stage: "impl" });
      assert.equal(await answer, undefined);
      const saved = (await readChatHistory(folder, folder)).find((m) => m.id === posted.id);
      assert.equal(saved?.settlement?.reason, CARD_RETIRED_BY_TASK_MOVING_ON_REASON_V1);
    } finally {
      __extensionContextV1TestOnly.reset();
      __resetChatFreeTextTestOnlyV1();
    }
  });

  void it("retires an unanswered legacy free-text producer record without a pending flag", async () => {
    const { folder } = makeTask();
    await seed(folder, [{ role: "question", id: "legacy-free", stage: "impl", at: "2026-10-26T16:38:00.000Z", text: chatFreeTextMarkerV1("ab12") }]);
    const closed = await retirePendingQuestionsV1(folder, folder, CARD_RETIRED_BY_TASK_MOVING_ON_REASON_V1, { stage: "impl" });
    assert.equal(closed.length, 1);
    assert.equal((await readChatHistory(folder, folder))[0]?.settlement?.kind, "retired");
  });
});

void describe("local-only choice cards on a departed stage (bugs3 Step 8)", () => {
  const QUESTIONS = [
    {
      questionId: "scope",
      kind: "singleChoice" as const,
      prompt: "Which artifact?",
      required: true,
      options: [
        { optionId: "plan", label: "plan.md" },
        { optionId: "task", label: "task.md" },
      ],
    },
  ];

  void it("expires a local-only card on the departed stage but leaves operation-backed and other-stage cards", async () => {
    const { folder } = makeTask();
    await seed(folder, [{ role: "assistant", text: "hi", stage: "impl", at: "2026-10-26T16:00:00.000Z" }]);
    const raw = JSON.parse(fs.readFileSync(path.join(folder, CHAT_HISTORY_FILENAME), "utf8")) as Record<string, unknown>;
    const binding = { taskBindingId: raw.taskBindingId as string, chatDocumentId: raw.documentId as string };
    const base = { sourceAttemptId: "a".repeat(32), questions: QUESTIONS, postedAt: "2026-10-26T16:30:00.000Z", binding };
    await appendChatInteraction(folder, folder, {
      ...base,
      interactionId: "1".repeat(32),
      operationId: "2".repeat(32),
      actionKey: LOCAL_ONLY_INTERACTION_ACTION_KEY_V1,
      stage: "plan-low-review",
    });
    await appendChatInteraction(folder, folder, {
      ...base,
      interactionId: "3".repeat(32),
      operationId: "4".repeat(32),
      actionKey: "generatePlan.v1",
      stage: "plan-low-review",
    });
    await appendChatInteraction(folder, folder, {
      ...base,
      interactionId: "5".repeat(32),
      operationId: "6".repeat(32),
      actionKey: LOCAL_ONLY_INTERACTION_ACTION_KEY_V1,
      stage: "impl",
    });

    await retirePendingQuestionsV1(folder, folder, CARD_RETIRED_BY_TASK_MOVING_ON_REASON_V1, {
      stage: "plan-low-review",
    });

    const doc = JSON.parse(fs.readFileSync(path.join(folder, CHAT_HISTORY_FILENAME), "utf8")) as {
      interactions: Array<{ interactionId: string; state: string; retirementReason?: string }>;
    };
    const state = (id: string): string => doc.interactions.find((i) => i.interactionId === id)!.state;
    assert.equal(state("1".repeat(32)), "expired", "the local-only card on the departed stage is closed");
    assert.equal(doc.interactions.find((i) => i.interactionId === "1".repeat(32))?.retirementReason, CARD_RETIRED_BY_TASK_MOVING_ON_REASON_V1);
    assert.equal(state("3".repeat(32)), "unresolved", "an operation-backed card keeps its own transaction settlement");
    assert.equal(state("5".repeat(32)), "unresolved", "a card on another stage is untouched");
  });
});

void describe("question dismissal (bugs3 Step 8)", () => {
  void it("refuses an answer to a legacy non-pending question without settlement metadata", async () => {
    const { folder, taskMd } = makeTask();
    const original = fs.readFileSync(taskMd, "utf8");
    await seed(folder, [{ ...question("closed", "impl", "2026-10-26T16:38:00.000Z"), pending: false }]);
    const result = await appendChatAnswerToPendingQuestionV1(folder, folder, "closed", {
      role: "user", text: "late", stage: "impl", at: "2026-10-26T16:39:00.000Z", answersQuestionAt: "closed",
    });
    assert.equal(result.kind, "settled");
    if (result.kind === "settled") assert.match(result.settlement.reason, /no longer pending/);
    assert.equal((await readChatHistory(folder, folder)).some((m) => m.text === "late"), false);
    assert.equal(fs.readFileSync(taskMd, "utf8"), original);
  });

  void it("records structured-card dismissal and refuses a late answer without changing task.md", async () => {
    const { folder, taskMd } = makeTask();
    const before = fs.readFileSync(taskMd, "utf8");
    await seed(folder, [{ role: "assistant", text: "hi", stage: "impl", at: "2026-10-26T16:00:00.000Z" }]);
    const raw = JSON.parse(fs.readFileSync(path.join(folder, CHAT_HISTORY_FILENAME), "utf8")) as Record<string, unknown>;
    const id = "1".repeat(32);
    await appendChatInteraction(folder, folder, {
      interactionId: id, operationId: "2".repeat(32), sourceAttemptId: "a".repeat(32),
      actionKey: LOCAL_ONLY_INTERACTION_ACTION_KEY_V1, stage: "impl", postedAt: "2026-10-26T16:30:00.000Z",
      binding: { taskBindingId: raw.taskBindingId as string, chatDocumentId: raw.documentId as string },
      questions: [{ questionId: "scope", kind: "singleChoice", prompt: "Which?", required: true, options: [{ optionId: "plan", label: "Plan" }, { optionId: "task", label: "Task" }] }],
    });
    await settleChatInteraction(folder, folder, id, "cancelled", { by: "owner", at: "2026-10-26T16:31:00.000Z" });
    const card = (await readChatInteractions(folder, folder)).find((i) => i.interactionId === id)!;
    assert.equal(card.dismissedBy, "owner");
    assert.equal(card.dismissedAt, "2026-10-26T16:31:00.000Z");
    await assert.rejects(recordChatInteractionAnswers(folder, folder, id, [{ questionId: "scope", kind: "singleChoice", state: "answered", selectedOptionId: "plan" }], true), /dismissed by owner/);
    assert.equal(fs.readFileSync(taskMd, "utf8"), before);
  });
  void it("records who and when, dispatches nothing and leaves task.md byte-for-byte unchanged", async () => {
    const { folder, taskMd } = makeTask();
    const before = fs.readFileSync(taskMd, "utf8");
    await seed(folder, [
      question("q-evidence", "impl", "2026-10-26T16:38:00.000Z", `Owner evidence needed ${OWNER_EVIDENCE_ANSWER_MARKER_V1}`),
    ]);

    const closed = await dismissPendingQuestionV1(folder, folder, "q-evidence", "jonathan");
    assert.ok(closed);

    const m = (await readChatHistory(folder, folder)).find((x) => x.id === "q-evidence")!;
    assert.equal(m.pending, false);
    assert.equal(m.settlement?.kind, "dismissed");
    assert.equal(m.settlement?.by, "jonathan");
    const settlement = m.settlement;
    assert.ok(settlement);
    assert.ok(Date.parse(settlement.at) > 0, "the dismissal time is recorded");
    assert.equal(fs.readFileSync(taskMd, "utf8"), before, "task.md is unchanged");
    assert.match(describeQuestionSettlementV1(settlement), /Dismissed by jonathan/);
    assert.match(describeQuestionSettlementV1(settlement), /task\.md was not changed/);
  });

  void it("reports nothing to dismiss for a question that is not open", async () => {
    const { folder } = makeTask();
    await seed(folder, [question("q1", "impl", "2026-10-26T16:38:00.000Z")]);
    assert.ok(await dismissPendingQuestionV1(folder, folder, "q1"));
    assert.equal(await dismissPendingQuestionV1(folder, folder, "q1"), undefined, "second dismissal finds nothing open");
    assert.equal(await dismissPendingQuestionV1(folder, folder, "no-such-question"), undefined);
  });

  void it("says what moves a task that was waiting on the dismissed card, and stays quiet otherwise", () => {
    const holding = describeCardDismissalV1("the question", { holdsTask: true, taskStatus: "paused" });
    assert.match(holding, /stays paused/);
    assert.match(holding, /Resume it from the Tasks pane/);
    assert.match(holding, /task\.md was not changed/);
    const free = describeCardDismissalV1("the question", { holdsTask: false, taskStatus: "active" });
    assert.doesNotMatch(free, /stays paused|waiting on/);
  });
});

void describe("late answers are refused, never saved (bugs3 Step 8)", () => {

  void it("refuses an answer to a retired question with its recorded reason and saves nothing", async () => {
    const { folder } = makeTask();
    await seed(folder, [question("q1", "impl", "2026-10-26T16:38:00.000Z")]);
    await retirePendingQuestionsV1(folder, folder, CARD_RETIRED_BY_TASK_MOVING_ON_REASON_V1, { stage: "impl" });

    const result = await appendChatAnswerToPendingQuestionV1(folder, folder, "q1", answerTo("q1"));

    assert.equal(result.kind, "settled");
    if (result.kind === "settled") {
      assert.equal(result.settlement.reason, "retired by the task moving on, not answered");
    }
    const history = await readChatHistory(folder, folder);
    assert.equal(history.filter((m) => m.role === "user").length, 0, "the answer was not saved");
  });

  void it("refuses an answer to a dismissed question", async () => {
    const { folder } = makeTask();
    await seed(folder, [question("q1", "impl", "2026-10-26T16:38:00.000Z")]);
    await dismissPendingQuestionV1(folder, folder, "q1", "jonathan");
    const result = await appendChatAnswerToPendingQuestionV1(folder, folder, "q1", answerTo("q1"));
    assert.equal(result.kind, "settled");
    assert.equal((await readChatHistory(folder, folder)).filter((m) => m.role === "user").length, 0);
  });

  void it("saves the first answer to an open question and reports a second as already answered", async () => {
    const { folder } = makeTask();
    await seed(folder, [question("q1", "impl", "2026-10-26T16:38:00.000Z")]);
    assert.equal((await appendChatAnswerToPendingQuestionV1(folder, folder, "q1", answerTo("q1"))).kind, "answered");
    assert.equal((await appendChatAnswerToPendingQuestionV1(folder, folder, "q1", answerTo("q1"))).kind, "alreadyAnswered");
    assert.equal((await readChatHistory(folder, folder)).filter((m) => m.role === "user").length, 1);
  });

  void it("an answer racing a retirement ends with exactly one winner and a consistent transcript", async () => {
    const { folder } = makeTask();
    await seed(folder, [question("q1", "impl", "2026-10-26T16:38:00.000Z")]);

    const [answer, retired] = await Promise.all([
      appendChatAnswerToPendingQuestionV1(folder, folder, "q1", answerTo("q1")),
      settleChatQuestionsV1(folder, folder, { questionKey: "q1" }, { kind: "retired", reason: "moved on" }),
    ]);

    const history = await readChatHistory(folder, folder);
    const saved = history.filter((m) => m.role === "user").length;
    const q = history.find((m) => m.id === "q1")!;
    if (answer.kind === "answered") {
      assert.equal(saved, 1);
      assert.equal(retired.length, 0, "an answered question is not retired afterwards");
      assert.equal(q.settlement, undefined);
    } else {
      assert.equal(answer.kind, "settled");
      assert.equal(saved, 0, "a retired question never keeps an answer");
      assert.equal(q.settlement?.kind, "retired");
    }
  });

  void it("a legacy question row (no settlement field) still decodes and is answerable", async () => {
    const { folder } = makeTask();
    await seed(folder, [question("legacy", "impl", "2026-10-26T16:38:00.000Z")]);
    const m = (await readChatHistory(folder, folder)).find((x) => x.id === "legacy")!;
    assert.equal(m.pending, true);
    assert.equal(m.settlement, undefined);
    assert.equal((await appendChatAnswerToPendingQuestionV1(folder, folder, "legacy", answerTo("legacy"))).kind, "answered");
  });
});

void describe("decision dismissal and late answers (bugs3 Step 8)", () => {
  void it("dismiss records who and when; a later answer is refused with that on record", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as never);
    const posted = await store.post(decisionInput());
    assert.ok(posted.ok);

    const dismissed = await store.dismiss("d-1", "jonathan");
    assert.equal(dismissed.kind, "dismissed");
    const record = store.get("d-1")!;
    assert.equal(record.state, "dismissed");
    assert.equal(record.dismissedBy, "jonathan");
    assert.ok(record.dismissedAt && Date.parse(record.dismissedAt) > 0);

    const late = await store.resolve("d-1", "go");
    assert.equal(late.kind, "alreadySettled", "the effect is never dispatched for a dismissed card");
    assert.match(describeSettledDecisionRefusalV1(record), /dismissed by jonathan/);
    assert.match(describeSettledDecisionRefusalV1(record), /your choice was not applied/);
  });

  void it("a retired (withdrawn) decision refuses a late answer quoting the retirement reason", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as never);
    await store.post(decisionInput());
    await store.withdraw("d-1", CARD_RETIRED_BY_TASK_MOVING_ON_REASON_V1);
    const late = await store.resolve("d-1", "go");
    assert.equal(late.kind, "alreadySettled");
    if (late.kind === "alreadySettled") {
      const text = describeSettledDecisionRefusalV1(late.decision);
      assert.match(text, /retired by the task moving on, not answered/);
      assert.match(text, /your choice was not applied/);
    }
  });

  void it("a decision that was really answered still reads as already submitted", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as never);
    await store.post(decisionInput());
    await store.resolve("d-1", "wait");
    assert.equal(describeSettledDecisionRefusalV1(store.get("d-1")!), "This decision was already submitted.");
  });

  void it("a legacy dismissed record without who/when still produces a reason", async () => {
    const store = new WorkflowDecisionStoreV1(new FakeMemento() as never);
    await store.post(decisionInput());
    await store.dismiss("d-1");
    const text = describeSettledDecisionRefusalV1(store.get("d-1")!);
    assert.match(text, /was dismissed by the owner/);
  });
});

void describe("Dismiss wiring (bugs3 Step 8)", () => {
  void it("the webview posts the same option id the host recognises", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "views", "chatView.ts"), "utf8");
    assert.equal(DISMISS_DECISION_OPTION_ID_V1, "__dismiss__");
    assert.ok(
      source.includes(`optionId:'${DISMISS_DECISION_OPTION_ID_V1}'`),
      "the decision card's Dismiss button must post the host's dismiss option id"
    );
    assert.ok(source.includes("type:'dismissQuestion'"), "the question card's Dismiss button must post dismissQuestion");
  });
});
