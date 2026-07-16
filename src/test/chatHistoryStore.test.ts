/**
 * Coverage for Slice 1 of the 2026-07-14_task_5 backlog: task-local chat
 * history (src/utils/chatHistoryStore.ts).
 *
 * Covers:
 *   1. Round-trip write/read, missing file, wrong schema version, and the
 *      200-message cap on write.
 *   2. Corrupt-file quarantine: an unparseable/malformed chat-v1.json is
 *      preserved as chat-v1.corrupt.json (only the most recent copy kept)
 *      with a diagnostic logged, rather than silently discarded.
 *   3. Lazy legacy-Memento migration: the legacy key is deleted only after
 *      a successful file write, and retried (key intact) after a failed one.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import {
  CHAT_HISTORY_CORRUPT_FILENAME,
  CHAT_HISTORY_FILENAME,
  ChatMessage,
  chatHistoryFileExists,
  loadTranscriptWithMigration,
  readChatHistory,
  writeChatHistory,
} from "../utils/chatHistoryStore";

// writeAtomic.ts is required (not `import`ed) so its exported function
// reference can be monkey-patched for a test's duration — see the equivalent
// comment in commitAndPushDuplicateGuard.test.ts.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const writeAtomicModule = require("../state/writeAtomic") as {
  writeAtomic: (uri: vscode.Uri, content: string) => Promise<void>;
};

function makeTaskFolder(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-chat-history-"));
}

/** Bridges vscode.workspace.fs.readFile to the real filesystem, mirroring
 * completedTaskResume.test.ts's installReadFileBridge. */
function installReadFileBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = target.readFile;
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  return { restore: (): void => { target.readFile = orig; } };
}

function message(text: string, at = "2026-01-01T00:00:00.000Z"): ChatMessage {
  return { role: "user", text, stage: "impl", at };
}

function makeMemento(seed: Record<string, unknown> = {}): {
  memento: vscode.Memento;
  updates: Array<{ key: string; value: unknown }>;
} {
  const store = new Map<string, unknown>(Object.entries(seed));
  const updates: Array<{ key: string; value: unknown }> = [];
  const memento = {
    get: <T>(key: string, defaultValue?: T): T => (store.has(key) ? (store.get(key) as T) : (defaultValue as T)),
    update: (key: string, value: unknown): Promise<void> => {
      updates.push({ key, value });
      if (value === undefined) store.delete(key);
      else store.set(key, value);
      return Promise.resolve();
    },
    keys: (): readonly string[] => [...store.keys()],
  } as unknown as vscode.Memento;
  return { memento, updates };
}

void describe("chatHistoryStore round-trip", () => {
  void it("returns an empty transcript when chat-v1.json does not exist", async () => {
    const rf = installReadFileBridge();
    const folder = makeTaskFolder();
    try {
      assert.deepEqual(await readChatHistory(folder), []);
    } finally {
      rf.restore();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("writes and reads back messages", async () => {
    const rf = installReadFileBridge();
    const folder = makeTaskFolder();
    try {
      await writeChatHistory(folder, [message("hello"), message("world")]);
      const read = await readChatHistory(folder);
      assert.deepEqual(read.map((m) => m.text), ["hello", "world"]);
      assert.ok(fs.existsSync(path.join(folder, CHAT_HISTORY_FILENAME)));
    } finally {
      rf.restore();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("treats an unrecognized schema version as empty, not corrupt", async () => {
    const rf = installReadFileBridge();
    const folder = makeTaskFolder();
    try {
      fs.writeFileSync(
        path.join(folder, CHAT_HISTORY_FILENAME),
        JSON.stringify({ version: 99, messages: [message("future")] })
      );
      const read = await readChatHistory(folder);
      assert.deepEqual(read, []);
      assert.equal(
        fs.existsSync(path.join(folder, CHAT_HISTORY_CORRUPT_FILENAME)),
        false,
        "a recognized envelope with an unknown version must not be quarantined"
      );
    } finally {
      rf.restore();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("caps at the most recent 200 messages on write", async () => {
    const rf = installReadFileBridge();
    const folder = makeTaskFolder();
    try {
      const many = Array.from({ length: 250 }, (_, i) => message(`msg-${i}`));
      await writeChatHistory(folder, many);
      const read = await readChatHistory(folder);
      assert.equal(read.length, 200);
      assert.equal(read[0]!.text, "msg-50");
      assert.equal(read[read.length - 1]!.text, "msg-249");
    } finally {
      rf.restore();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

void describe("chatHistoryStore corrupt-file quarantine", () => {
  void it("quarantines invalid JSON to chat-v1.corrupt.json, logs a diagnostic, and returns an empty transcript", async () => {
    const rf = installReadFileBridge();
    const folder = makeTaskFolder();
    const channel = vscode.window.createOutputChannel("test-capture") as unknown as { lines: string[] };
    const originalCreate = (vscode.window as unknown as Record<string, unknown>).createOutputChannel;
    (vscode.window as unknown as Record<string, unknown>).createOutputChannel = () => channel;
    try {
      fs.writeFileSync(path.join(folder, CHAT_HISTORY_FILENAME), "{not valid json");

      const read = await readChatHistory(folder);
      assert.deepEqual(read, []);

      const quarantined = fs.readFileSync(path.join(folder, CHAT_HISTORY_CORRUPT_FILENAME), "utf8");
      assert.equal(quarantined, "{not valid json");
      assert.ok(channel.lines.some((l) => l.includes("chat-v1.json was unreadable")), "expected a diagnostic line");
    } finally {
      (vscode.window as unknown as Record<string, unknown>).createOutputChannel = originalCreate;
      rf.restore();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("quarantines a structurally-invalid document shape (valid JSON, wrong shape)", async () => {
    const rf = installReadFileBridge();
    const folder = makeTaskFolder();
    const channel = vscode.window.createOutputChannel("test-capture") as unknown as { lines: string[] };
    const originalCreate = (vscode.window as unknown as Record<string, unknown>).createOutputChannel;
    (vscode.window as unknown as Record<string, unknown>).createOutputChannel = () => channel;
    try {
      fs.writeFileSync(path.join(folder, CHAT_HISTORY_FILENAME), JSON.stringify({ foo: "bar" }));

      const read = await readChatHistory(folder);
      assert.deepEqual(read, []);
      assert.ok(fs.existsSync(path.join(folder, CHAT_HISTORY_CORRUPT_FILENAME)));
    } finally {
      (vscode.window as unknown as Record<string, unknown>).createOutputChannel = originalCreate;
      rf.restore();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("quarantines a message with an unrecognized stage value rather than accepting it as-is", async () => {
    const rf = installReadFileBridge();
    const folder = makeTaskFolder();
    const channel = vscode.window.createOutputChannel("test-capture") as unknown as { lines: string[] };
    const originalCreate = (vscode.window as unknown as Record<string, unknown>).createOutputChannel;
    (vscode.window as unknown as Record<string, unknown>).createOutputChannel = () => channel;
    try {
      fs.writeFileSync(
        path.join(folder, CHAT_HISTORY_FILENAME),
        JSON.stringify({ version: 1, messages: [{ role: "user", text: "hi", stage: "not-a-real-stage", at: "2026-01-01T00:00:00.000Z" }] })
      );

      const read = await readChatHistory(folder);
      assert.deepEqual(read, [], "a message with an unrecognized stage must not be accepted");
      assert.ok(fs.existsSync(path.join(folder, CHAT_HISTORY_CORRUPT_FILENAME)));
    } finally {
      (vscode.window as unknown as Record<string, unknown>).createOutputChannel = originalCreate;
      rf.restore();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("quarantines a message whose pending field is not a boolean", async () => {
    const rf = installReadFileBridge();
    const folder = makeTaskFolder();
    const channel = vscode.window.createOutputChannel("test-capture") as unknown as { lines: string[] };
    const originalCreate = (vscode.window as unknown as Record<string, unknown>).createOutputChannel;
    (vscode.window as unknown as Record<string, unknown>).createOutputChannel = () => channel;
    try {
      fs.writeFileSync(
        path.join(folder, CHAT_HISTORY_FILENAME),
        JSON.stringify({ version: 1, messages: [{ role: "question", text: "hi", stage: "impl", at: "2026-01-01T00:00:00.000Z", pending: "yes" }] })
      );

      const read = await readChatHistory(folder);
      assert.deepEqual(read, [], "a message with a non-boolean pending field must not be accepted");
      assert.ok(fs.existsSync(path.join(folder, CHAT_HISTORY_CORRUPT_FILENAME)));
    } finally {
      (vscode.window as unknown as Record<string, unknown>).createOutputChannel = originalCreate;
      rf.restore();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("only keeps the most recent quarantine copy, and a later successful write is unaffected", async () => {
    const rf = installReadFileBridge();
    const folder = makeTaskFolder();
    const channel = vscode.window.createOutputChannel("test-capture") as unknown as { lines: string[] };
    const originalCreate = (vscode.window as unknown as Record<string, unknown>).createOutputChannel;
    (vscode.window as unknown as Record<string, unknown>).createOutputChannel = () => channel;
    try {
      fs.writeFileSync(path.join(folder, CHAT_HISTORY_FILENAME), "{first corrupt");
      await readChatHistory(folder); // quarantines "{first corrupt"

      fs.writeFileSync(path.join(folder, CHAT_HISTORY_FILENAME), "{second corrupt");
      await readChatHistory(folder); // overwrites the quarantine copy

      assert.equal(
        fs.readFileSync(path.join(folder, CHAT_HISTORY_CORRUPT_FILENAME), "utf8"),
        "{second corrupt",
        "only the most recent quarantine copy should be kept"
      );

      // A message sent after the corruption must not be silently lost — it
      // writes a fresh, valid chat-v1.json, and the quarantine copy survives
      // untouched alongside it.
      await writeChatHistory(folder, [message("recovered")]);
      assert.deepEqual((await readChatHistory(folder)).map((m) => m.text), ["recovered"]);
      assert.equal(
        fs.readFileSync(path.join(folder, CHAT_HISTORY_CORRUPT_FILENAME), "utf8"),
        "{second corrupt"
      );
    } finally {
      (vscode.window as unknown as Record<string, unknown>).createOutputChannel = originalCreate;
      rf.restore();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("throws instead of returning empty when the quarantine copy itself cannot be written, leaving chat-v1.json untouched", async () => {
    const rf = installReadFileBridge();
    const folder = makeTaskFolder();
    const channel = vscode.window.createOutputChannel("test-capture") as unknown as { lines: string[] };
    const originalCreate = (vscode.window as unknown as Record<string, unknown>).createOutputChannel;
    (vscode.window as unknown as Record<string, unknown>).createOutputChannel = () => channel;

    const original = writeAtomicModule.writeAtomic;
    const corruptFile = path.join(folder, CHAT_HISTORY_CORRUPT_FILENAME);
    writeAtomicModule.writeAtomic = (uri: vscode.Uri, content: string): Promise<void> => {
      if (path.normalize(uri.fsPath) === path.normalize(corruptFile)) {
        throw new Error("simulated quarantine write failure");
      }
      return original(uri, content);
    };

    try {
      fs.writeFileSync(path.join(folder, CHAT_HISTORY_FILENAME), "{not valid json");

      await assert.rejects(
        () => readChatHistory(folder),
        /unreadable/,
        "readChatHistory must throw rather than silently report an empty transcript"
      );

      assert.equal(
        fs.existsSync(corruptFile),
        false,
        "no quarantine copy exists — the write failed"
      );
      assert.equal(
        fs.readFileSync(path.join(folder, CHAT_HISTORY_FILENAME), "utf8"),
        "{not valid json",
        "the only copy of the corrupt transcript must be left untouched, not overwritten"
      );
      // Not asserting on `channel.lines` here: the module's diagnostics
      // channel is a lazily-created singleton (see getDiagnosticsChannel),
      // so whichever test in this file happens to trigger quarantine first
      // is the one whose stubbed channel instance actually receives every
      // subsequent diagnostic line — this test's own local `channel` stub
      // is not guaranteed to be the live one.
    } finally {
      writeAtomicModule.writeAtomic = original;
      (vscode.window as unknown as Record<string, unknown>).createOutputChannel = originalCreate;
      rf.restore();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

void describe("chatHistoryStore read failures other than not-found", () => {
  void it("throws instead of returning [] when the file exists but the read fails for a reason other than not-found", async () => {
    const folder = makeTaskFolder();
    const target = vscode.workspace.fs as unknown as Record<string, unknown>;
    const orig = target.readFile;
    const historyPath = path.join(folder, CHAT_HISTORY_FILENAME);
    const original = JSON.stringify({ version: 1, messages: [message("hello")] });
    fs.writeFileSync(historyPath, original);
    target.readFile = (uri: vscode.Uri): Promise<Uint8Array> => {
      if (path.normalize(uri.fsPath) === path.normalize(historyPath)) {
        return Promise.reject(Object.assign(new Error("simulated permission failure"), { code: "EACCES" }));
      }
      return fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
    };
    try {
      await assert.rejects(
        () => readChatHistory(folder),
        /could not be read/,
        "a non-not-found read failure must throw, not silently report an empty transcript"
      );
      // A transient/permission read failure must not be treated as "safely
      // empty" — the file is left completely untouched, with no quarantine
      // copy made either (unlike a genuinely corrupt file, this one is fine;
      // it just couldn't be read this time).
      assert.equal(fs.readFileSync(historyPath, "utf8"), original);
      assert.equal(fs.existsSync(path.join(folder, CHAT_HISTORY_CORRUPT_FILENAME)), false);
    } finally {
      target.readFile = orig;
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("chatHistoryFileExists throws instead of reporting false when stat fails for a reason other than not-found", async () => {
    const folder = makeTaskFolder();
    const historyPath = path.join(folder, CHAT_HISTORY_FILENAME);
    fs.writeFileSync(historyPath, JSON.stringify({ version: 1, messages: [message("hello")] }));

    const target = vscode.workspace.fs as unknown as Record<string, unknown>;
    const orig = target.stat;
    target.stat = (uri: vscode.Uri): Promise<unknown> => {
      if (path.normalize(uri.fsPath) === path.normalize(historyPath)) {
        return Promise.reject(Object.assign(new Error("simulated stat failure"), { code: "EBUSY" }));
      }
      return (orig as (uri: vscode.Uri) => Promise<unknown>)(uri);
    };
    try {
      await assert.rejects(
        () => chatHistoryFileExists(folder),
        /could not be accessed/,
        "a non-not-found stat failure must throw, not report the file as missing"
      );
    } finally {
      target.stat = orig;
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("loadTranscriptWithMigration throws (rather than falling through to legacy/empty) when stat fails for a reason other than not-found on an existing transcript", async () => {
    const rf = installReadFileBridge();
    const folder = makeTaskFolder();
    const canonicalId = folder;
    const legacyKey = `ensemble.stageChat.transcript.${encodeURIComponent(canonicalId)}`;
    const { memento, updates } = makeMemento({ [legacyKey]: [message("legacy-should-not-surface")] });
    const historyPath = path.join(folder, CHAT_HISTORY_FILENAME);
    const original = JSON.stringify({ version: 1, messages: [message("existing")] });
    fs.writeFileSync(historyPath, original);

    const target = vscode.workspace.fs as unknown as Record<string, unknown>;
    const orig = target.stat;
    target.stat = (uri: vscode.Uri): Promise<unknown> => {
      if (path.normalize(uri.fsPath) === path.normalize(historyPath)) {
        return Promise.reject(Object.assign(new Error("simulated stat failure"), { code: "EBUSY" }));
      }
      return (orig as (uri: vscode.Uri) => Promise<unknown>)(uri);
    };
    try {
      await assert.rejects(
        () => loadTranscriptWithMigration(folder, canonicalId, memento),
        /could not be accessed/,
        "a transient stat failure on an existing transcript must not be treated as 'never chatted'"
      );
      // Nothing must have been touched: no migration write clobbering the
      // real transcript, and the legacy key (a decoy here) left alone.
      assert.equal(fs.readFileSync(historyPath, "utf8"), original);
      assert.deepEqual(updates, [], "the legacy key must not be touched when the stat failure prevents migration");
    } finally {
      target.stat = orig;
      rf.restore();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

void describe("chatHistoryStore legacy migration", () => {
  void it("migrates legacy Memento entries to chat-v1.json and deletes the legacy key only after a successful write", async () => {
    const rf = installReadFileBridge();
    const folder = makeTaskFolder();
    const canonicalId = folder;
    const legacyKey = `ensemble.stageChat.transcript.${encodeURIComponent(canonicalId)}`;
    const { memento, updates } = makeMemento({ [legacyKey]: [message("legacy-1"), message("legacy-2")] });
    try {
      const result = await loadTranscriptWithMigration(folder, canonicalId, memento);
      assert.deepEqual(result.map((m) => m.text), ["legacy-1", "legacy-2"]);
      assert.ok(fs.existsSync(path.join(folder, CHAT_HISTORY_FILENAME)), "migration must write chat-v1.json");
      assert.deepEqual(updates, [{ key: legacyKey, value: undefined }], "legacy key must be deleted after a successful write");

      // The file is authoritative afterward: a second read does not touch
      // the (now-deleted) legacy key.
      const second = await loadTranscriptWithMigration(folder, canonicalId, memento);
      assert.deepEqual(second.map((m) => m.text), ["legacy-1", "legacy-2"]);
    } finally {
      rf.restore();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("does not migrate when chat-v1.json already exists", async () => {
    const rf = installReadFileBridge();
    const folder = makeTaskFolder();
    const canonicalId = folder;
    const legacyKey = `ensemble.stageChat.transcript.${encodeURIComponent(canonicalId)}`;
    const { memento, updates } = makeMemento({ [legacyKey]: [message("legacy-should-not-appear")] });
    try {
      await writeChatHistory(folder, [message("file-is-authoritative")]);
      const result = await loadTranscriptWithMigration(folder, canonicalId, memento);
      assert.deepEqual(result.map((m) => m.text), ["file-is-authoritative"]);
      assert.deepEqual(updates, [], "an existing file must not trigger migration or touch the legacy key");
    } finally {
      rf.restore();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("retains the legacy key and serves legacy entries directly when the migration write fails", async () => {
    const rf = installReadFileBridge();
    const folder = makeTaskFolder();
    const canonicalId = folder;
    const legacyKey = `ensemble.stageChat.transcript.${encodeURIComponent(canonicalId)}`;
    const { memento, updates } = makeMemento({ [legacyKey]: [message("legacy-1")] });

    const original = writeAtomicModule.writeAtomic;
    const targetFile = path.join(folder, CHAT_HISTORY_FILENAME);
    writeAtomicModule.writeAtomic = (uri: vscode.Uri, content: string): Promise<void> => {
      if (path.normalize(uri.fsPath) === path.normalize(targetFile)) {
        throw new Error("simulated migration write failure");
      }
      return original(uri, content);
    };

    try {
      const result = await loadTranscriptWithMigration(folder, canonicalId, memento);
      assert.deepEqual(result.map((m) => m.text), ["legacy-1"], "legacy entries are still served on a failed migration write");
      assert.deepEqual(updates, [], "the legacy key must be retained when the migration write fails");
      assert.equal(fs.existsSync(targetFile), false);
    } finally {
      writeAtomicModule.writeAtomic = original;
      rf.restore();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("returns an empty transcript when there is no file and no legacy entry", async () => {
    const rf = installReadFileBridge();
    const folder = makeTaskFolder();
    const { memento } = makeMemento();
    try {
      const result = await loadTranscriptWithMigration(folder, folder, memento);
      assert.deepEqual(result, []);
    } finally {
      rf.restore();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
