/**
 * Coverage for plan step 25: fully separate per-stage chat histories, and
 * the global assistant's separate history.
 *
 *  - Messages appended under one stage key never appear in another stage's
 *    transcript for the same task (ChatViewProvider.transcript with a stage
 *    filter is exactly what render() uses for a stage chat).
 *  - The global assistant's history lives in its own dedicated folder, so
 *    its transcript (read unfiltered, as render() does for kind "global")
 *    never contains any task's messages and no task's stage transcript ever
 *    contains the global assistant's messages — even though the global
 *    assistant writes under the same "desc" stage key a task's Task
 *    Description chat uses.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { ChatViewProvider } from "../views/chatView";
import { CHAT_HISTORY_FILENAME } from "../utils/chatHistoryStore";
import { GLOBAL_ASSISTANT_CANONICAL_ID } from "../commands/openGeneralAssistant";

/** Bridges vscode.workspace.fs.readFile to the real filesystem, mirroring
 * chatViewTaskSwitch.test.ts's installReadFileBridge. */
function installReadFileBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = target.readFile;
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  return { restore: (): void => { target.readFile = orig; } };
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

function makeFolder(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ensemble-chat-isolation-${name}-`));
}

void describe("stage chat isolation", () => {
  void it("a stage's transcript never contains another stage's messages", async () => {
    const rf = installReadFileBridge();
    const folder = makeFolder("stages");
    const provider = new ChatViewProvider(makeMemento());
    const identity = { canonicalId: folder, taskFolderPath: folder };

    try {
      await provider.append("user", "impl question", "impl", identity);
      await provider.append("assistant", "impl answer", "impl", identity);
      await provider.append("user", "publish question", "publish", identity);
      await provider.append("user", "desc note", "desc", identity);

      const impl = await provider.transcript(folder, folder, "impl");
      assert.deepEqual(impl.map((m) => m.text), ["impl question", "impl answer"]);
      assert.ok(impl.every((m) => m.stage === "impl"));

      const publish = await provider.transcript(folder, folder, "publish");
      assert.deepEqual(publish.map((m) => m.text), ["publish question"]);

      const desc = await provider.transcript(folder, folder, "desc");
      assert.deepEqual(desc.map((m) => m.text), ["desc note"]);

      // A stage with no conversation shows nothing — not another stage's.
      const planLow = await provider.transcript(folder, folder, "plan-low-review");
      assert.deepEqual(planLow, [], "an unused stage must have an empty, fully separate conversation");

      // The unfiltered read (used only by the global assistant) still holds
      // everything, proving the isolation is a per-read filter over one
      // task-local file rather than data loss.
      const all = await provider.transcript(folder, folder);
      assert.equal(all.length, 4);
    } finally {
      rf.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("the global assistant's history is fully separate from every task's stage chats", async () => {
    const rf = installReadFileBridge();
    const taskFolder = makeFolder("task");
    const globalFolder = makeFolder("global");
    const provider = new ChatViewProvider(makeMemento());
    const taskIdentity = { canonicalId: taskFolder, taskFolderPath: taskFolder };
    const globalIdentity = {
      canonicalId: GLOBAL_ASSISTANT_CANONICAL_ID,
      taskFolderPath: globalFolder,
    };

    try {
      // The global assistant persists under the "desc" stage key (it uses the
      // Task Description model), the same key a task's own desc chat uses —
      // the histories must still never mix because they live in different
      // folders.
      await provider.append("user", "task desc message", "desc", taskIdentity);
      await provider.append("user", "global: archive completed tasks", "desc", globalIdentity);
      await provider.append("assistant", "global: proposing archiveCompletedTasks", "desc", globalIdentity);

      const globalTranscript = await provider.transcript(
        globalIdentity.taskFolderPath,
        globalIdentity.canonicalId
      );
      assert.deepEqual(
        globalTranscript.map((m) => m.text),
        ["global: archive completed tasks", "global: proposing archiveCompletedTasks"],
        "the global transcript must contain only the global assistant's messages"
      );

      const taskDesc = await provider.transcript(taskFolder, taskFolder, "desc");
      assert.deepEqual(
        taskDesc.map((m) => m.text),
        ["task desc message"],
        "a task's desc chat must never show the global assistant's conversation"
      );

      // Physically separate files, so deleting/archiving one can never
      // affect the other.
      assert.ok(fs.existsSync(path.join(taskFolder, CHAT_HISTORY_FILENAME)));
      assert.ok(fs.existsSync(path.join(globalFolder, CHAT_HISTORY_FILENAME)));
    } finally {
      rf.restore();
      provider.dispose();
      fs.rmSync(taskFolder, { recursive: true, force: true });
      fs.rmSync(globalFolder, { recursive: true, force: true });
    }
  });
});
