/**
 * Coverage for globalAssistantSend.v1 (Global Assistant restoration): the
 * one action row that diverges from chatSend.v1's shape —
 * promoteCompletedContent additionally decodes the response as a possible
 * cross-task ACTION proposal (utils/globalAssistantActions.ts), stripping
 * the envelope before the answer is appended and executing a recognized
 * proposal via the activation-wired runtime-deps singleton, with its
 * outcome appended as a second assistant message.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  createGlobalAssistantSendRowV1,
  GLOBAL_ASSISTANT_SEND_ACTION_KEY_V1,
  validateGlobalAssistantSendInputV1,
} from "../actions/rows/globalAssistantSendRowV1";
import { TaskActionExecutionContextV1 } from "../actions/taskActionRegistryV1";
import {
  resetGlobalAssistantRuntimeDepsForTestV1,
  setGlobalAssistantRuntimeDepsV1,
} from "../utils/globalAssistantActions";
import { GLOBAL_ASSISTANT_CANONICAL_ID } from "../utils/chatHistoryConstants";
import { readChatHistory } from "../utils/chatHistoryStore";
import { TaskInventory, TaskWithProgress } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { ActionCorrelationV1 } from "../types/actionCorrelationV1";
import { CompletedContentV1 } from "../types/aiResultEnvelope";

/** Bridges vscode.workspace.fs.readFile to the real filesystem, mirroring chatStageIsolation.test.ts's installReadFileBridge. */
function installReadFileBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = target.readFile;
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  return {
    restore: (): void => {
      target.readFile = orig;
    },
  };
}

function makeMemento(): vscode.Memento {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string, defaultValue?: T): T => (store.has(key) ? (store.get(key) as T) : (defaultValue as T)),
    update: (key: string, value: unknown): Promise<void> => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
      return Promise.resolve();
    },
    keys: (): readonly string[] => [...store.keys()],
  } as unknown as vscode.Memento;
}

/** The Global Assistant's dedicated folder is non-task storage — a plain temp directory, no ownership/progress required. */
function makeGlobalFolder(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ensemble-global-assistant-row-${name}-`));
}

function chatMessageContent(text: string): CompletedContentV1 {
  return { contentType: "chat-message.v1", schemaVersion: 1, text };
}

const FAKE_CORRELATION: ActionCorrelationV1 = {
  actionKey: GLOBAL_ASSISTANT_SEND_ACTION_KEY_V1,
  operationId: "op-1",
  attemptId: "attempt-1",
  taskBindingId: "binding-1",
  chatDocumentId: "doc-1",
};

function makeContext(taskFolderPath: string): TaskActionExecutionContextV1 {
  return {
    correlation: FAKE_CORRELATION,
    stage: "desc",
    validatedInput: {
      prompt: "irrelevant for promotion — buildPrompt is not under test here",
      taskFolderPath,
      canonicalId: GLOBAL_ASSISTANT_CANONICAL_ID,
    },
  };
}

void describe("globalAssistantSendRowV1", () => {
  let bridge: { restore: () => void };
  before(() => {
    bridge = installReadFileBridge();
  });
  after(() => {
    bridge.restore();
  });

  void describe("validateGlobalAssistantSendInputV1", () => {
    void it("accepts a valid input", () => {
      const result = validateGlobalAssistantSendInputV1({
        prompt: "hello",
        taskFolderPath: "c:/tmp/global-assistant",
        canonicalId: GLOBAL_ASSISTANT_CANONICAL_ID,
      });
      assert.equal(result.ok, true);
    });

    void it("rejects a missing prompt", () => {
      const result = validateGlobalAssistantSendInputV1({
        taskFolderPath: "c:/tmp/global-assistant",
        canonicalId: GLOBAL_ASSISTANT_CANONICAL_ID,
      });
      assert.equal(result.ok, false);
    });

    void it("rejects a missing taskFolderPath (unlike chatSend.v1, this field is required — the Global Assistant always has a folder)", () => {
      const result = validateGlobalAssistantSendInputV1({
        prompt: "hello",
        canonicalId: GLOBAL_ASSISTANT_CANONICAL_ID,
      });
      assert.equal(result.ok, false);
    });

    void it("rejects a missing canonicalId (unlike chatSend.v1, this field is required)", () => {
      const result = validateGlobalAssistantSendInputV1({
        prompt: "hello",
        taskFolderPath: "c:/tmp/global-assistant",
      });
      assert.equal(result.ok, false);
    });

    void it("rejects an unknown field", () => {
      const result = validateGlobalAssistantSendInputV1({
        prompt: "hello",
        taskFolderPath: "c:/tmp/global-assistant",
        canonicalId: GLOBAL_ASSISTANT_CANONICAL_ID,
        extra: "not allowed",
      });
      assert.equal(result.ok, false);
    });

    void it("rejects a prompt exceeding the 8 MB cap", () => {
      const result = validateGlobalAssistantSendInputV1({
        prompt: "a".repeat(8 * 1024 * 1024 + 1),
        taskFolderPath: "c:/tmp/global-assistant",
        canonicalId: GLOBAL_ASSISTANT_CANONICAL_ID,
      });
      assert.equal(result.ok, false);
    });
  });

  void describe("createGlobalAssistantSendRowV1", () => {
    void it("creates a valid registry row", () => {
      const row = createGlobalAssistantSendRowV1();
      assert.equal(row.actionKey, GLOBAL_ASSISTANT_SEND_ACTION_KEY_V1);
      assert.equal(row.completedContentType, "chat-message.v1");
      assert.equal(row.providerMode, "text");
      assert.equal(row.resumeSemantics, "sameOperation");
    });
  });

  void describe("promoteCompletedContent", () => {
    void it("rejects a non-chat-message completed content", async () => {
      const row = createGlobalAssistantSendRowV1();
      const folder = makeGlobalFolder("wrong-type");
      try {
        await assert.rejects(
          row.promoteCompletedContent(
            { contentType: "markdown-artifact.v1", schemaVersion: 1, content: "x", targetLocator: { rootId: "r", relativePath: "p.md" } } as unknown as CompletedContentV1,
            makeContext(folder)
          )
        );
      } finally {
        fs.rmSync(folder, { recursive: true, force: true });
      }
    });

    void it("strips the ACTION envelope before appending the answer, and reports the proposal unexecutable with no runtime deps wired", async () => {
      resetGlobalAssistantRuntimeDepsForTestV1();
      const folder = makeGlobalFolder("strip");
      try {
        const row = createGlobalAssistantSendRowV1();
        const code = await row.promoteCompletedContent(
          chatMessageContent("Sure, I'll archive it. [[ACTION:archiveCompletedTasks]]"),
          makeContext(folder)
        );
        assert.equal(code, "completed");

        const history = await readChatHistory(folder, GLOBAL_ASSISTANT_CANONICAL_ID);
        assert.equal(history.length, 2, "expects the stripped answer plus the deps-missing fallback message");
        assert.equal(history[0]?.text, "Sure, I'll archive it.");
        assert.ok(!history[0]?.text.includes("[[ACTION:"), "the envelope must not survive into the displayed answer");
        assert.match(history[1]?.text ?? "", /could not be executed in this context/);
      } finally {
        fs.rmSync(folder, { recursive: true, force: true });
      }
    });

    void it("executes a recognized proposal through the wired runtime deps and appends its outcome as a second message", async () => {
      const inventory = Object.create(TaskInventory.prototype) as TaskInventory;
      inventory.getTasks = (): TaskWithProgress[] => [];
      inventory.refresh = async (): Promise<void> => {
        /* no-op */
      };
      const currentTaskStore = Object.create(CurrentTaskStore.prototype) as CurrentTaskStore;
      setGlobalAssistantRuntimeDepsV1({ inventory, currentTaskStore, workspaceState: makeMemento() });

      const win = vscode.window as unknown as Record<string, unknown>;
      const originalWarning = win.showWarningMessage;
      win.showWarningMessage = (): Promise<string | undefined> => Promise.resolve("Run Action");

      const folder = makeGlobalFolder("execute");
      try {
        const row = createGlobalAssistantSendRowV1();
        const code = await row.promoteCompletedContent(
          chatMessageContent("On it. [[ACTION:archiveCompletedTasks]]"),
          makeContext(folder)
        );
        assert.equal(code, "completed");

        const history = await readChatHistory(folder, GLOBAL_ASSISTANT_CANONICAL_ID);
        assert.equal(history.length, 2);
        assert.equal(history[0]?.text, "On it.");
        assert.equal(history[1]?.text, "No completed tasks to archive.");
      } finally {
        win.showWarningMessage = originalWarning;
        resetGlobalAssistantRuntimeDepsForTestV1();
        fs.rmSync(folder, { recursive: true, force: true });
      }
    });

    void it('falls back to "did not return an answer" when the response has no text and no action proposal', async () => {
      resetGlobalAssistantRuntimeDepsForTestV1();
      const folder = makeGlobalFolder("empty");
      try {
        const row = createGlobalAssistantSendRowV1();
        const code = await row.promoteCompletedContent(chatMessageContent(""), makeContext(folder));
        assert.equal(code, "completed");

        const history = await readChatHistory(folder, GLOBAL_ASSISTANT_CANONICAL_ID);
        assert.equal(history.length, 1);
        assert.equal(history[0]?.text, "The Global Assistant did not return an answer.");
      } finally {
        fs.rmSync(folder, { recursive: true, force: true });
      }
    });
  });
});
