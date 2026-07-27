/**
 * Coverage for AC-CHAT-TX-03's "transaction without a Chat record" direction
 * (plan §5.5): a durable Chat interaction transaction can be begun and then
 * never mirrored into task-local Chat (e.g. a crash between the
 * transaction's `begin()` and the mirror's `appendChatInteraction()` call),
 * which would otherwise leave it permanently undiscoverable. This exercises
 * the real `ChatInteractionTransactionStoreV1` wired through the global
 * workflow runtime singleton (`setChatInteractionTransactionStoreV1`) — the
 * same production wiring `extension.ts` installs — so it runs in its own
 * file to keep that global state from leaking into other test files' module
 * instances (each `.test.js` file gets its own worker/module registry under
 * this project's `node --test` runner).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { CHAT_HISTORY_FILENAME, ChatDocumentInteractionV1, readChatInteractions, writeChatHistory } from "../utils/chatHistoryStore";
import {
  configureWorkflowPrivateStorageRootV1,
  getWorkflowFileStoreV1,
  getWorkflowPathRegistryV1,
  setChatInteractionTransactionStoreV1,
} from "../services/workflowRuntimeServicesV1";
import { createChatInteractionTransactionStoreV1 } from "../services/chatInteractionTransactionStoreV1";
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
  return makeOwnedTaskFolder("ensemble-chat-orphan-").folder;
}

function readRawDocument(folder: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(folder, CHAT_HISTORY_FILENAME), "utf8")) as Record<string, unknown>;
}

const privateStorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-chat-orphan-private-"));
const privateRootId = configureWorkflowPrivateStorageRootV1(privateStorageRoot);
const sharedStore = createChatInteractionTransactionStoreV1({
  registry: getWorkflowPathRegistryV1(),
  fileStore: getWorkflowFileStoreV1(),
  privateRootId,
});
setChatInteractionTransactionStoreV1(sharedStore);

void describe("chatHistoryStore orphaned-transaction reconciliation (AC-CHAT-TX-03)", () => {
  void it("surfaces a transaction with no Chat mirror record as a read-only orphanedTransaction entry", async () => {
    const folder = makeTaskFolder();
    const canonicalId = folder;
    try {
      await writeChatHistory(folder, [], canonicalId);
      const raw = readRawDocument(folder);
      const documentId = raw.documentId as string;
      const taskBindingId = raw.taskBindingId as string;

      const interactionId = allocateHex128IdV1();
      const begun = await sharedStore.begin({
        correlation: {
          actionKey: "generatePlan.v1",
          operationId: allocateHex128IdV1(),
          attemptId: allocateHex128IdV1(),
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

      // Never mirrored (no appendChatInteraction call) — simulates a crash
      // between the transaction's begin() and the mirror append.
      const interactions = await readChatInteractions(folder, canonicalId, "impl");
      const orphan = interactions.find((i) => i.interactionId === interactionId);
      assert.ok(orphan, "the orphaned transaction must be discoverable");
      assert.equal(orphan.state, "orphanedTransaction");
      assert.equal(orphan.actionKey, "generatePlan.v1");
      assert.deepEqual(orphan.questions, QUESTIONS);

      // Discovery is persisted into the mirror, not just returned in-memory.
      const afterFirstRead = readRawDocument(folder);
      const persisted = (afterFirstRead.interactions as ChatDocumentInteractionV1[]).find(
        (i) => i.interactionId === interactionId
      );
      assert.ok(persisted, "the discovered orphan must be persisted into chat-v1.json");
      assert.equal(persisted.state, "orphanedTransaction");

      // A second read must not duplicate the now-persisted orphan entry.
      const second = await readChatInteractions(folder, canonicalId, "impl");
      assert.equal(second.filter((i) => i.interactionId === interactionId).length, 1);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("does not surface a settled transaction as an orphan", async () => {
    const folder = makeTaskFolder();
    const canonicalId = folder;
    try {
      await writeChatHistory(folder, [], canonicalId);
      const raw = readRawDocument(folder);
      const documentId = raw.documentId as string;
      const taskBindingId = raw.taskBindingId as string;

      const operationId = allocateHex128IdV1();
      const begun = await sharedStore.begin({
        correlation: {
          actionKey: "generatePlan.v1",
          operationId,
          attemptId: allocateHex128IdV1(),
          taskBindingId,
          chatDocumentId: documentId,
        },
        interactionId: allocateHex128IdV1(),
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
      assert.equal(begun.kind, "ok");
      const cancelled = await sharedStore.cancel(operationId);
      assert.equal(cancelled.kind, "ok");

      const interactions = await readChatInteractions(folder, canonicalId, "impl");
      assert.equal(
        interactions.length,
        0,
        "a settled (cancelled) transaction with no mirror record is not an orphan to surface"
      );
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
