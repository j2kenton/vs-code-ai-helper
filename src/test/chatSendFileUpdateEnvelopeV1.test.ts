/**
 * Coverage for item 21 (2026-08-17..19 workflow-defects batch): the C4 chat-
 * edit envelope (`[[UPDATE_FILE:path]]...[[/UPDATE_FILE]]`) was prompted for
 * but never applied — `promoteChatSendContentV1` (chatSendRowV1.ts) persisted
 * the model's raw text verbatim, so a compliant model's envelope rendered
 * into the chat transcript instead of updating the file, with no report of
 * what happened either way.
 *
 * These tests drive `createChatSendRowV1().promoteCompletedContent` directly
 * against a real, ownership-backed task folder (taskFolderFixture.ts) and a
 * real `workflowFileStoreV1` write — no mocking of the write path — so a
 * regression here (envelope surviving into the transcript, or a write
 * silently failing) is caught at the same layer production runs.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

import { createChatSendRowV1 } from "../actions/rows/chatSendRowV1";
import { TaskActionExecutionContextV1 } from "../actions/taskActionRegistryV1";
import { ActionCorrelationV1 } from "../types/actionCorrelationV1";
import { CompletedContentV1 } from "../types/aiResultEnvelope";
import { readChatHistory } from "../utils/chatHistoryStore";
import { makeOwnedTaskFolder } from "./taskFolderFixture";

function chatMessageContent(text: string): CompletedContentV1 {
  return { contentType: "chat-message.v1", schemaVersion: 1, text };
}

const FAKE_CORRELATION: ActionCorrelationV1 = {
  actionKey: "chatSend.v1",
  operationId: "op-1",
  attemptId: "attempt-1",
  taskBindingId: "binding-1",
  chatDocumentId: "doc-1",
};

function makeContext(taskFolderPath: string): TaskActionExecutionContextV1 {
  return {
    correlation: FAKE_CORRELATION,
    stage: "plan",
    validatedInput: {
      prompt: "irrelevant for promotion — buildPrompt is not under test here",
      taskFolderPath,
    },
  };
}

void describe("chatSendRowV1 — C4 chat-edit envelope (item 21)", () => {
  void it("writes a single valid envelope's content to the target file and reports it in the chat", async () => {
    const fixture = makeOwnedTaskFolder("ensemble-chat-edit-write-");
    fs.writeFileSync(path.join(fixture.folder, "plan.md"), "# Old Plan\n", "utf8");
    try {
      const row = createChatSendRowV1();
      const code = await row.promoteCompletedContent(
        chatMessageContent(
          "Sure, here's the updated plan.\n\n[[UPDATE_FILE:plan.md]]\n# New Plan\n\nBody text.\n[[/UPDATE_FILE]]"
        ),
        makeContext(fixture.folder)
      );
      assert.equal(code, "completed");

      const onDisk = fs.readFileSync(path.join(fixture.folder, "plan.md"), "utf8");
      assert.equal(onDisk, "# New Plan\n\nBody text.");

      const history = await readChatHistory(fixture.folder);
      assert.equal(history.length, 1);
      const text = history[0]?.text ?? "";
      assert.ok(!text.includes("[[UPDATE_FILE"), "the envelope must not survive into the displayed answer");
      assert.ok(text.startsWith("Sure, here's the updated plan."));
      assert.match(text, /_Updated `plan\.md`\._/);
    } finally {
      fs.rmSync(fixture.folder, { recursive: true, force: true });
    }
  });

  void it("creates a new file when the target does not exist yet", async () => {
    const fixture = makeOwnedTaskFolder("ensemble-chat-edit-create-");
    try {
      const row = createChatSendRowV1();
      const code = await row.promoteCompletedContent(
        chatMessageContent("[[UPDATE_FILE:notes.md]]\nfresh notes\n[[/UPDATE_FILE]]"),
        makeContext(fixture.folder)
      );
      assert.equal(code, "completed");
      assert.equal(fs.readFileSync(path.join(fixture.folder, "notes.md"), "utf8"), "fresh notes");
    } finally {
      fs.rmSync(fixture.folder, { recursive: true, force: true });
    }
  });

  void it("rejects two envelopes atomically — zero writes — and reports why, with neither surviving into the text", async () => {
    const fixture = makeOwnedTaskFolder("ensemble-chat-edit-multi-");
    fs.writeFileSync(path.join(fixture.folder, "plan.md"), "# Original\n", "utf8");
    try {
      const row = createChatSendRowV1();
      const code = await row.promoteCompletedContent(
        chatMessageContent(
          "[[UPDATE_FILE:plan.md]]one[[/UPDATE_FILE]] and [[UPDATE_FILE:task.md]]two[[/UPDATE_FILE]]"
        ),
        makeContext(fixture.folder)
      );
      assert.equal(code, "completed");

      // Neither file was written.
      assert.equal(fs.readFileSync(path.join(fixture.folder, "plan.md"), "utf8"), "# Original\n");
      assert.equal(fs.existsSync(path.join(fixture.folder, "task.md")), false);

      const history = await readChatHistory(fixture.folder);
      const text = history[0]?.text ?? "";
      assert.ok(!text.includes("[[UPDATE_FILE"));
      assert.match(text, /chat may update only one markdown file per response/);
    } finally {
      fs.rmSync(fixture.folder, { recursive: true, force: true });
    }
  });

  void it("refuses a path that escapes the task folder, reports the refusal, and writes nothing", async () => {
    const fixture = makeOwnedTaskFolder("ensemble-chat-edit-escape-");
    try {
      const row = createChatSendRowV1();
      const code = await row.promoteCompletedContent(
        chatMessageContent("[[UPDATE_FILE:../escape.md]]x[[/UPDATE_FILE]]"),
        makeContext(fixture.folder)
      );
      assert.equal(code, "completed");
      assert.equal(fs.existsSync(path.join(path.dirname(fixture.folder), "escape.md")), false);

      const history = await readChatHistory(fixture.folder);
      const text = history[0]?.text ?? "";
      assert.match(text, /Could not update `\.\.\/escape\.md`/);
    } finally {
      fs.rmSync(fixture.folder, { recursive: true, force: true });
    }
  });

  void it("refuses a non-markdown target and writes nothing", async () => {
    const fixture = makeOwnedTaskFolder("ensemble-chat-edit-nonmd-");
    try {
      const row = createChatSendRowV1();
      const code = await row.promoteCompletedContent(
        chatMessageContent("[[UPDATE_FILE:src/app.ts]]evil[[/UPDATE_FILE]]"),
        makeContext(fixture.folder)
      );
      assert.equal(code, "completed");
      assert.equal(fs.existsSync(path.join(fixture.folder, "src", "app.ts")), false);

      const history = await readChatHistory(fixture.folder);
      assert.match(history[0]?.text ?? "", /Could not update `src\/app\.ts`/);
    } finally {
      fs.rmSync(fixture.folder, { recursive: true, force: true });
    }
  });

  void it("passes an ordinary response with no envelope through unchanged", async () => {
    const fixture = makeOwnedTaskFolder("ensemble-chat-edit-none-");
    try {
      const row = createChatSendRowV1();
      const code = await row.promoteCompletedContent(
        chatMessageContent("The task looks ready to move to Draft — no blockers I can see."),
        makeContext(fixture.folder)
      );
      assert.equal(code, "completed");
      const history = await readChatHistory(fixture.folder);
      assert.equal(history[0]?.text, "The task looks ready to move to Draft — no blockers I can see.");
    } finally {
      fs.rmSync(fixture.folder, { recursive: true, force: true });
    }
  });
});
