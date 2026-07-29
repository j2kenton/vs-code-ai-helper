/**
 * Coverage for two chatHistoryStore.ts crash-consistency gaps between the
 * task-local Chat mirror and the durable Chat interaction transaction
 * (module header's RECONCILIATION and RESET sections):
 *
 *  - `readChatInteractions` must backfill a durable transaction's own
 *    `answers` into a still-`unresolved` mirror record whenever they differ,
 *    not only propagate a settlement — otherwise a crash between
 *    `doSubmitInteractionAnswers`'s durable-first write (chatView.ts) and its
 *    mirror write leaves the mirror showing a blank, already-submitted
 *    question again.
 *  - `resetChatHistoryV1` must never mark a mirror interaction
 *    `resetByChatRecovery` when its durable counterpart FAILS to settle —
 *    the two records must not permanently disagree about resolution — and,
 *    since Reset's contract is "every unresolved interaction is cleared", a
 *    partial settlement must fail Reset as a whole (leaving chat-v1.json
 *    completely untouched) rather than report `ok: true` while an
 *    interaction remains unresolved.
 *
 * Runs in its own file (its own module registry under this project's
 * `node --test` runner — see chatInteractionOrphanReconciliation.test.ts's
 * header) so the transaction-store singleton it wires/swaps cannot leak into
 * other test files.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import {
  CHAT_HISTORY_FILENAME,
  ChatDocumentInteractionV1,
  appendChatInteraction,
  readChatInteractions,
  resetChatHistoryV1,
  writeChatHistory,
} from "../utils/chatHistoryStore";
import {
  configureWorkflowPrivateStorageRootV1,
  getWorkflowFileStoreV1,
  getWorkflowPathRegistryV1,
  setChatInteractionTransactionStoreV1,
} from "../services/workflowRuntimeServicesV1";
import {
  ChatInteractionTransactionStoreV1,
  ChatTransactionStoreResultV1,
  createChatInteractionTransactionStoreV1,
} from "../services/chatInteractionTransactionStoreV1";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import { StructuredQuestionV1 } from "../types/structuredQuestionV1";
import { makeOwnedTaskFolder } from "./taskFolderFixture";

const QUESTIONS: readonly StructuredQuestionV1[] = [
  {
    questionId: "scope",
    kind: "singleChoice",
    prompt: "Which artifact?",
    required: true,
    options: [
      { optionId: "plan", label: "plan.md" },
      { optionId: "task", label: "task.md" },
    ],
  },
];

function makeTaskFolder(): string {
  // Task conversations require the strict, ownership-backed task-folder
  // root contract (see workflowRuntimeServicesV1.ts).
  return makeOwnedTaskFolder("ensemble-chat-answer-reset-").folder;
}

function readRawDocument(folder: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(folder, CHAT_HISTORY_FILENAME), "utf8")) as Record<string, unknown>;
}

const privateStorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-chat-answer-reset-private-"));
const privateRootId = configureWorkflowPrivateStorageRootV1(privateStorageRoot);
const sharedStore = createChatInteractionTransactionStoreV1({
  registry: getWorkflowPathRegistryV1(),
  fileStore: getWorkflowFileStoreV1(),
  privateRootId,
});
setChatInteractionTransactionStoreV1(sharedStore);

async function beginAndMirror(
  folder: string,
  canonicalId: string,
  operationId: string,
  interactionId: string
): Promise<{ documentId: string; taskBindingId: string }> {
  await writeChatHistory(folder, [], canonicalId);
  const raw = readRawDocument(folder);
  const documentId = raw.documentId as string;
  const taskBindingId = raw.taskBindingId as string;
  const sourceAttemptId = allocateHex128IdV1();

  const begun = await sharedStore.begin({
    correlation: {
      actionKey: "generatePlan.v1",
      operationId,
      attemptId: sourceAttemptId,
      taskBindingId,
      chatDocumentId: documentId,
    },
    interactionId,
    stage: "impl",
    resumeSemantics: "sameOperation",
    validatedInput: { stage: "plan" },
    promptContract: {
      contractId: "ensemble-ai-result-contract",
      contractVersion: 1,
      promptInputSha256: "d".repeat(64),
    },
    questions: QUESTIONS,
  });
  assert.equal(begun.kind, "ok", begun.kind === "rejected" ? begun.reason : JSON.stringify(begun));

  await appendChatInteraction(folder, canonicalId, {
    interactionId,
    operationId,
    actionKey: "generatePlan.v1",
    sourceAttemptId,
    stage: "impl",
    questions: QUESTIONS,
    postedAt: new Date().toISOString(),
    binding: { taskBindingId, chatDocumentId: documentId },
  });

  return { documentId, taskBindingId };
}

/** A store double whose `settleByChatRecovery` is fully controlled; every other member is unused by resetChatHistoryV1. */
function makeSettleFailingStore(
  outcome: (operationId: string) => ChatTransactionStoreResultV1
): ChatInteractionTransactionStoreV1 {
  const notImplemented = (): never => {
    throw new Error("not implemented in this test double");
  };
  return {
    begin: notImplemented,
    beginInvocation: notImplemented,
    discardPendingInvocation: notImplemented,
    load: notImplemented,
    saveAnswersDraft: notImplemented,
    submitAnswers: notImplemented,
    scheduleResume: notImplemented,
    settleResumed: notImplemented,
    claimResumeInvocation: notImplemented,
    recordResumeInvocationOutcome: notImplemented,
    cancel: notImplemented,
    expire: notImplemented,
    settleByChatRecovery: (operationId: string) => Promise.resolve(outcome(operationId)),
    listUnresolvedForChatDocument: () => Promise.resolve([]),
    sweepExpired: () => Promise.resolve({ expired: 0, removed: 0 }),
  };
}

void describe("chatHistoryStore — durable answer backfill (readChatInteractions)", () => {
  void it("backfills durably submitted answers into a still-unresolved mirror record", async () => {
    const folder = makeTaskFolder();
    const canonicalId = folder;
    const operationId = allocateHex128IdV1();
    const interactionId = allocateHex128IdV1();
    try {
      await beginAndMirror(folder, canonicalId, operationId, interactionId);

      // Simulate doSubmitInteractionAnswers's durable-first write (chatView.ts)
      // completing, then a crash BEFORE its mirror write
      // (recordChatInteractionAnswers) ever runs.
      const submitted = await sharedStore.submitAnswers(
        operationId,
        [{ questionId: "scope", kind: "singleChoice", state: "answered", selectedOptionId: "plan" }],
        allocateHex128IdV1()
      );
      assert.equal(submitted.kind, "ok", submitted.kind === "rejected" ? submitted.reason : JSON.stringify(submitted));

      // Before reconciliation, the mirror on disk still has no answers.
      const beforeReconcile = readRawDocument(folder);
      const mirrorBefore = (beforeReconcile.interactions as ChatDocumentInteractionV1[]).find(
        (i) => i.interactionId === interactionId
      );
      assert.ok(mirrorBefore);
      assert.equal(mirrorBefore.answers, undefined);

      const reconciled = await readChatInteractions(folder, canonicalId, "impl");
      const interaction = reconciled.find((i) => i.interactionId === interactionId);
      assert.ok(interaction, "the interaction must still be present");
      assert.equal(interaction.state, "unresolved", "answers alone do not settle the interaction");
      assert.deepEqual(interaction.answers, [
        { questionId: "scope", kind: "singleChoice", state: "answered", selectedOptionId: "plan" },
      ]);

      // The backfill must be persisted, not just returned in-memory.
      const afterReconcile = readRawDocument(folder);
      const mirrorAfter = (afterReconcile.interactions as ChatDocumentInteractionV1[]).find(
        (i) => i.interactionId === interactionId
      );
      assert.ok(mirrorAfter);
      assert.deepEqual(mirrorAfter.answers, [
        { questionId: "scope", kind: "singleChoice", state: "answered", selectedOptionId: "plan" },
      ]);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

void describe("chatHistoryStore — Reset never falsely resolves a mirror whose durable settle fails", () => {
  void it("fails Reset as a whole (chat-v1.json untouched) when settleByChatRecovery reports a real failure", async () => {
    const folder = makeTaskFolder();
    const canonicalId = folder;
    const operationId = allocateHex128IdV1();
    const interactionId = allocateHex128IdV1();
    try {
      await beginAndMirror(folder, canonicalId, operationId, interactionId);
      const beforeReset = readRawDocument(folder);

      setChatInteractionTransactionStoreV1(
        makeSettleFailingStore(() => ({ kind: "storageFailure", errno: "EACCES" }))
      );
      try {
        const result = await resetChatHistoryV1(folder, canonicalId);
        assert.equal(
          result.ok,
          false,
          "Reset must fail as a whole rather than report ok:true with an interaction still unresolved"
        );
      } finally {
        setChatInteractionTransactionStoreV1(sharedStore);
      }

      const raw = readRawDocument(folder);
      const interaction = (raw.interactions as ChatDocumentInteractionV1[]).find(
        (i) => i.interactionId === interactionId
      );
      assert.ok(interaction);
      assert.equal(
        interaction.state,
        "unresolved",
        "a failed durable settle must not be reported as resetByChatRecovery"
      );
      assert.equal(raw.resetEpoch, beforeReset.resetEpoch, "resetEpoch must not bump when Reset fails as a whole");
      assert.deepEqual(raw, beforeReset, "chat-v1.json must be completely untouched when Reset fails");
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("still marks the mirror resetByChatRecovery when the durable settle succeeds", async () => {
    const folder = makeTaskFolder();
    const canonicalId = folder;
    const operationId = allocateHex128IdV1();
    const interactionId = allocateHex128IdV1();
    try {
      await beginAndMirror(folder, canonicalId, operationId, interactionId);

      const result = await resetChatHistoryV1(folder, canonicalId);
      assert.equal(result.ok, true);

      const raw = readRawDocument(folder);
      const interaction = (raw.interactions as ChatDocumentInteractionV1[]).find(
        (i) => i.interactionId === interactionId
      );
      assert.ok(interaction);
      assert.equal(interaction.state, "resetByChatRecovery");
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
