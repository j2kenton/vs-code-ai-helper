/**
 * Coverage for task-local chat history (src/utils/chatHistoryStore.ts, plan
 * §5.1-§5.3).
 *
 * Covers:
 *   1. Round-trip write/read, missing file, wrong schema version, the
 *      200-message cap, and the 4 MiB/64 KiB size limits with compaction.
 *   2. Corrupt-file quarantine: an unparseable/malformed chat-v1.json is
 *      preserved as chat-v1.corrupt.json (only the most recent copy kept)
 *      with a diagnostic logged, rather than silently discarded.
 *   3. Path/store boundary: chat-v1.json is allocated and read/written
 *      through WorkflowPathRegistryV1/WorkflowFileStoreV1, not an ad hoc
 *      vscode.workspace.fs path — fault injection here patches the
 *      underlying `fs.promises` primitives the file store itself uses, not
 *      vscode.workspace.fs.
 *   4. Lazy legacy-Memento migration: the legacy key's VALUE IS NEVER
 *      DELETED (plan §5.3 step 8 / AC-CHAT-MIGRATE-03); a migration marker
 *      is recorded in the new document instead, and a failed migration
 *      write is retried (marker absent) on the next read.
 *   5. Reset Chat History: writes a verified pre-reset snapshot, clears
 *      unresolved interactions, and bumps the reset epoch while preserving
 *      the document id and display transcript.
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
  CHAT_HISTORY_MAX_FILE_BYTES,
  CHAT_HISTORY_MAX_MESSAGE_BYTES,
  ChatHistoryRecoveryErrorV1,
  ChatMessage,
  GLOBAL_ASSISTANT_CANONICAL_ID,
  appendChatInteraction,
  appendChatMessageV1,
  chatHistoryFileExists,
  loadTranscriptWithMigration,
  readChatHistory,
  resetChatHistoryDiagnosticsChannelForTestV1,
  resetChatHistoryV1,
  writeChatHistory,
} from "../utils/chatHistoryStore";
import { StructuredQuestionV1 } from "../types/structuredQuestionV1";
import { TASK_PROGRESS_FILENAME } from "../types/taskProgress";
import {
  configureWorkflowPrivateStorageRootV1,
  getWorkflowPathRegistryV1,
} from "../services/workflowRuntimeServicesV1";
import { bindingIdForOwnedFolder, makeOwnedTaskFolder } from "./taskFolderFixture";

// Reset Chat History (plan §5.1) requires a configured private-storage root
// to write its verified pre-reset snapshot to; this test process never runs
// extension activation, so it configures one itself, once, for the whole file.
configureWorkflowPrivateStorageRootV1(fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-chat-private-storage-")));

/**
 * A TASK conversation's folder must satisfy the strict, ownership-backed
 * task-folder root contract (see workflowRuntimeServicesV1.ts), so every
 * task fixture carries an ownership-backed task-progress.json. The Global
 * Assistant conversation's folder is the exception — see the dedicated
 * non-task tests at the bottom of this file.
 */
function makeTaskFolder(): string {
  return makeOwnedTaskFolder("ensemble-chat-history-").folder;
}

function message(text: string, at = "2026-01-01T00:00:00.000Z"): ChatMessage {
  return { role: "user", text, stage: "impl", at };
}

function readRawDocument(folder: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(folder, CHAT_HISTORY_FILENAME), "utf8")) as Record<string, unknown>;
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

/** Monkey-patches the real `fs.promises` primitives workflowFileStoreV1.ts
 * itself calls, so a failure can be injected exactly for one target path
 * without going through (now-bypassed) vscode.workspace.fs. */
function patchFsPromises(patch: Partial<typeof fs.promises>): { restore: () => void } {
  const target = fs.promises as unknown as Record<string, unknown>;
  const originals: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    originals[key] = target[key];
    target[key] = (patch as Record<string, unknown>)[key];
  }
  return {
    restore: (): void => {
      for (const key of Object.keys(patch)) {
        target[key] = originals[key];
      }
    },
  };
}

void describe("chatHistoryStore round-trip", () => {
  void it("returns an empty transcript when chat-v1.json does not exist", async () => {
    const folder = makeTaskFolder();
    try {
      assert.deepEqual(await readChatHistory(folder), []);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("writes and reads back messages, allocated through the workflow path registry/file store", async () => {
    const folder = makeTaskFolder();
    try {
      await writeChatHistory(folder, [message("hello"), message("world")]);
      const read = await readChatHistory(folder);
      assert.deepEqual(read.map((m) => m.text), ["hello", "world"]);
      const filePath = path.join(folder, CHAT_HISTORY_FILENAME);
      assert.ok(fs.existsSync(filePath));
      const raw = readRawDocument(folder);
      assert.equal(raw.schemaVersion, 1);
      assert.equal(typeof raw.documentId, "string");
      assert.equal(typeof raw.taskBindingId, "string");
      assert.equal(raw.resetEpoch, 0);
      assert.deepEqual(raw.interactions, []);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("round-trips a proposedStageAction through write and read (chatWithStage.ts reads this back to dispatch the action)", async () => {
    const folder = makeTaskFolder();
    try {
      const withAction: ChatMessage = {
        role: "assistant",
        text: "Done — moving this task to impl.",
        stage: "impl",
        at: "2026-01-01T00:00:00.000Z",
        proposedStageAction: { id: "setTaskStage", payload: { stage: "impl" } },
      };
      await writeChatHistory(folder, [message("please move to impl"), withAction]);
      const read = await readChatHistory(folder);
      const last = read[read.length - 1]!;
      assert.deepEqual(last.proposedStageAction, { id: "setTaskStage", payload: { stage: "impl" } });
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("quarantines a message with a malformed proposedStageAction (missing id) rather than passing it through", async () => {
    const folder = makeTaskFolder();
    const channel = vscode.window.createOutputChannel("test-capture") as unknown as { lines: string[] };
    const originalCreate = (vscode.window as unknown as Record<string, unknown>).createOutputChannel;
    (vscode.window as unknown as Record<string, unknown>).createOutputChannel = () => channel;
    resetChatHistoryDiagnosticsChannelForTestV1();
    try {
      fs.writeFileSync(
        path.join(folder, CHAT_HISTORY_FILENAME),
        JSON.stringify({
          version: 1,
          messages: [
            { role: "assistant", text: "bad", stage: "impl", at: "2026-01-01T00:00:00.000Z", proposedStageAction: {} },
          ],
        })
      );
      const read = await readChatHistory(folder);
      assert.deepEqual(read, [], "a message with a malformed proposedStageAction must not be accepted");
      assert.ok(fs.existsSync(path.join(folder, CHAT_HISTORY_CORRUPT_FILENAME)));
    } finally {
      (vscode.window as unknown as Record<string, unknown>).createOutputChannel = originalCreate;
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("preserves the document id and reset epoch across successive writes", async () => {
    const folder = makeTaskFolder();
    try {
      await writeChatHistory(folder, [message("one")]);
      const first = readRawDocument(folder);
      await writeChatHistory(folder, [message("one"), message("two")]);
      const second = readRawDocument(folder);
      assert.equal(second.documentId, first.documentId);
      assert.equal(second.resetEpoch, first.resetEpoch);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("fails closed into recovery (quarantined, not silently emptied) for an unrecognized schema version", async () => {
    const folder = makeTaskFolder();
    const channel = vscode.window.createOutputChannel("test-capture") as unknown as { lines: string[] };
    const originalCreate = (vscode.window as unknown as Record<string, unknown>).createOutputChannel;
    (vscode.window as unknown as Record<string, unknown>).createOutputChannel = () => channel;
    resetChatHistoryDiagnosticsChannelForTestV1();
    try {
      fs.writeFileSync(
        path.join(folder, CHAT_HISTORY_FILENAME),
        JSON.stringify({ schemaVersion: 99, messages: [message("future")] })
      );
      // An unrecognized future version must never be silently treated as an
      // empty transcript — a subsequent write would destroy the unknown
      // content. It fails closed into chatRecoveryRequired instead.
      await assert.rejects(() => readChatHistory(folder), /chatRecoveryRequired/);
      assert.equal(
        fs.existsSync(path.join(folder, CHAT_HISTORY_CORRUPT_FILENAME)),
        true,
        "an unrecognized-version file must be preserved as a quarantine copy for evidence"
      );
    } finally {
      (vscode.window as unknown as Record<string, unknown>).createOutputChannel = originalCreate;
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("upgrades an on-disk reduced legacy shape ({version, messages}) instead of quarantining it", async () => {
    const folder = makeTaskFolder();
    try {
      fs.writeFileSync(
        path.join(folder, CHAT_HISTORY_FILENAME),
        JSON.stringify({ version: 1, messages: [message("pre-existing")] })
      );
      const read = await readChatHistory(folder);
      assert.deepEqual(read.map((m) => m.text), ["pre-existing"]);
      assert.equal(fs.existsSync(path.join(folder, CHAT_HISTORY_CORRUPT_FILENAME)), false);

      // Writing through it upgrades the on-disk shape to the full document.
      await writeChatHistory(folder, [message("pre-existing"), message("new")]);
      const raw = readRawDocument(folder);
      assert.equal(raw.schemaVersion, 1);
      assert.equal(typeof raw.documentId, "string");
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("caps at the most recent 200 messages on write", async () => {
    const folder = makeTaskFolder();
    try {
      const many = Array.from({ length: 250 }, (_, i) => message(`msg-${i}`));
      await writeChatHistory(folder, many);
      const read = await readChatHistory(folder);
      assert.equal(read.length, 200);
      assert.equal(read[0]!.text, "msg-50");
      assert.equal(read[read.length - 1]!.text, "msg-249");
      const raw = readRawDocument(folder);
      const compaction = raw.compaction as { compactedMessageCount: number };
      assert.equal(compaction.compactedMessageCount, 50);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("refuses a single message over the 64 KiB per-message limit rather than truncating it", async () => {
    const folder = makeTaskFolder();
    try {
      const huge = message("x".repeat(CHAT_HISTORY_MAX_MESSAGE_BYTES + 1));
      await assert.rejects(() => writeChatHistory(folder, [huge]), /65536-byte limit/);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("compacts oldest messages first to stay under the 4 MiB document limit", async () => {
    const folder = makeTaskFolder();
    try {
      // Each message is ~25 KiB; 200 of them comfortably exceed 4 MiB once
      // JSON overhead is included, so compaction must trim below 200.
      const big = Array.from({ length: 200 }, (_, i) => message(`${i}-`.padEnd(25 * 1024, "x")));
      await writeChatHistory(folder, big);
      const raw = readRawDocument(folder);
      const bytes = Buffer.byteLength(JSON.stringify(raw), "utf8");
      assert.ok(bytes <= CHAT_HISTORY_MAX_FILE_BYTES, `expected <= 4 MiB, got ${bytes}`);
      const messages = raw.messages as ChatMessage[];
      assert.ok(messages.length < 200, "compaction must have dropped some oldest messages");
      // The newest message must survive compaction.
      assert.equal(messages[messages.length - 1]!.text.startsWith("199-"), true);
      const compaction = raw.compaction as { compactedMessageCount: number; lastCompactionDigest?: string };
      assert.ok(compaction.compactedMessageCount > 0);
      assert.equal(typeof compaction.lastCompactionDigest, "string");
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("never compacts away a trailing pending question", async () => {
    const folder = makeTaskFolder();
    try {
      const filler = Array.from({ length: 150 }, (_, i) => message(`${i}-`.padEnd(20 * 1024, "x")));
      const pendingQuestion: ChatMessage = {
        role: "question",
        text: "still waiting for an answer",
        stage: "impl",
        at: "2026-01-01T00:00:00.000Z",
        pending: true,
      };
      await writeChatHistory(folder, [...filler, pendingQuestion]);
      const raw = readRawDocument(folder);
      const messages = raw.messages as ChatMessage[];
      const last = messages[messages.length - 1]!;
      assert.equal(last.role, "question");
      assert.equal(last.pending, true);
      assert.equal(last.text, "still waiting for an answer");
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("never compacts away a legacy recovery record even though it is the oldest and not pending", async () => {
    const folder = makeTaskFolder();
    try {
      const legacyRecoveryMessage: ChatMessage = {
        role: "question",
        text: "an old unresolved legacy question",
        stage: "impl",
        at: "2020-01-01T00:00:00.000Z",
        legacyRecovery: "legacyQuestion",
        // pending intentionally omitted: recovery protection must not
        // depend on it (plan §5.2's legacyQuestion mapping keys on role).
      };
      const filler = Array.from({ length: 250 }, (_, i) => message(`msg-${i}`));
      await writeChatHistory(folder, [legacyRecoveryMessage, ...filler]);
      const raw = readRawDocument(folder);
      const messages = raw.messages as ChatMessage[];
      assert.ok(messages.length <= 200, "the count cap must still apply to non-protected messages");
      assert.ok(
        messages.some((m) => m.legacyRecovery === "legacyQuestion"),
        "the legacy recovery record must survive compaction despite being the oldest, non-pending message"
      );
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

void describe("appendChatMessageV1 (review-flagged 2026-08-23: safe against a concurrent writer)", () => {
  void it("appends onto the CURRENT document rather than a stale snapshot, never losing a concurrently-written message", async () => {
    const folder = makeTaskFolder();
    try {
      await writeChatHistory(folder, [message("seed")]);
      // Two concurrent appenders, neither aware of the other — exactly the
      // shape of the bug this function exists to fix (the auto-start
      // announcement racing the task's own round writing its own chat
      // messages, with no shared queue protecting either write).
      await Promise.all([
        appendChatMessageV1(folder, message("first")),
        appendChatMessageV1(folder, message("second")),
      ]);
      const read = await readChatHistory(folder);
      const texts = read.map((m) => m.text);
      assert.deepEqual(
        new Set(texts),
        new Set(["seed", "first", "second"]),
        "both concurrent appends must survive — neither may silently overwrite the other's write"
      );
      assert.equal(read.length, 3);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it(
    "many concurrent appenders against an EXISTING document all survive, deterministically " +
      "(review-flagged 2026-08-23: replaceFileExact's revision-check-then-rename is two separate " +
      "steps, so two in-process callers could interleave between them and lose a message with no " +
      "reported conflict — a real-filesystem Promise.all test alone could not force that exact " +
      "interleaving; withChatDocumentQueueV1 now serializes every in-process caller so this is no " +
      "longer timing-dependent at all)",
    async () => {
      const folder = makeTaskFolder();
      try {
        await writeChatHistory(folder, [message("seed")]);
        const concurrency = 20;
        await Promise.all(
          Array.from({ length: concurrency }, (_, i) => appendChatMessageV1(folder, message(`writer-${i}`)))
        );
        const read = await readChatHistory(folder);
        const texts = read.map((m) => m.text);
        assert.deepEqual(
          new Set(texts),
          new Set(["seed", ...Array.from({ length: concurrency }, (_, i) => `writer-${i}`)]),
          "every one of the 20 concurrent appends against the same existing document must survive"
        );
        assert.equal(read.length, concurrency + 1, "no message may be silently discarded by another writer");
      } finally {
        fs.rmSync(folder, { recursive: true, force: true });
      }
    }
  );

  void it("creates a fresh document when none exists yet", async () => {
    const folder = makeTaskFolder();
    try {
      await appendChatMessageV1(folder, message("first ever message"));
      const read = await readChatHistory(folder);
      assert.deepEqual(read.map((m) => m.text), ["first ever message"]);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("two concurrent appenders racing to create the FIRST chat-v1.json both survive (review-flagged 2026-08-23)", async () => {
    // The narrower, more dangerous race than the seeded-document case above:
    // no document exists yet, so BOTH callers attempt an exclusive create and
    // exactly one wins. `persistDocument` used to resolve the loser's
    // `targetExists` conflict by blindly replacing the winner's freshly
    // created document with the loser's own (necessarily empty-based) bytes,
    // discarding the winner's message entirely. The fix surfaces that
    // conflict as a retryable signal instead, so the loser re-reads the
    // winner's real document and appends onto it.
    const folder = makeTaskFolder();
    try {
      await Promise.all([
        appendChatMessageV1(folder, message("alpha")),
        appendChatMessageV1(folder, message("beta")),
      ]);
      const read = await readChatHistory(folder);
      const texts = read.map((m) => m.text);
      assert.deepEqual(
        new Set(texts),
        new Set(["alpha", "beta"]),
        "neither first-writer's message may be discarded by the other"
      );
      assert.equal(read.length, 2);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("refuses an oversized message rather than truncating it", async () => {
    const folder = makeTaskFolder();
    try {
      const huge = message("x".repeat(CHAT_HISTORY_MAX_MESSAGE_BYTES + 1));
      await assert.rejects(() => appendChatMessageV1(folder, huge), /65536-byte limit/);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

void describe("chatHistoryStore corrupt-file quarantine", () => {
  void it("quarantines invalid JSON to chat-v1.corrupt.json, logs a diagnostic, and returns an empty transcript", async () => {
    const folder = makeTaskFolder();
    const channel = vscode.window.createOutputChannel("test-capture") as unknown as { lines: string[] };
    const originalCreate = (vscode.window as unknown as Record<string, unknown>).createOutputChannel;
    (vscode.window as unknown as Record<string, unknown>).createOutputChannel = () => channel;
    resetChatHistoryDiagnosticsChannelForTestV1();
    try {
      fs.writeFileSync(path.join(folder, CHAT_HISTORY_FILENAME), "{not valid json");

      const read = await readChatHistory(folder);
      assert.deepEqual(read, []);

      const quarantined = fs.readFileSync(path.join(folder, CHAT_HISTORY_CORRUPT_FILENAME), "utf8");
      assert.equal(quarantined, "{not valid json");
      assert.ok(channel.lines.some((l) => l.includes("chat-v1.json was unreadable")), "expected a diagnostic line");
    } finally {
      (vscode.window as unknown as Record<string, unknown>).createOutputChannel = originalCreate;
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("quarantines a structurally-invalid document shape (valid JSON, wrong shape)", async () => {
    const folder = makeTaskFolder();
    const channel = vscode.window.createOutputChannel("test-capture") as unknown as { lines: string[] };
    const originalCreate = (vscode.window as unknown as Record<string, unknown>).createOutputChannel;
    (vscode.window as unknown as Record<string, unknown>).createOutputChannel = () => channel;
    resetChatHistoryDiagnosticsChannelForTestV1();
    try {
      fs.writeFileSync(path.join(folder, CHAT_HISTORY_FILENAME), JSON.stringify({ foo: "bar" }));

      const read = await readChatHistory(folder);
      assert.deepEqual(read, []);
      assert.ok(fs.existsSync(path.join(folder, CHAT_HISTORY_CORRUPT_FILENAME)));
    } finally {
      (vscode.window as unknown as Record<string, unknown>).createOutputChannel = originalCreate;
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("quarantines a message with an unrecognized stage value rather than accepting it as-is", async () => {
    const folder = makeTaskFolder();
    const channel = vscode.window.createOutputChannel("test-capture") as unknown as { lines: string[] };
    const originalCreate = (vscode.window as unknown as Record<string, unknown>).createOutputChannel;
    (vscode.window as unknown as Record<string, unknown>).createOutputChannel = () => channel;
    resetChatHistoryDiagnosticsChannelForTestV1();
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
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("quarantines a message whose pending field is not a boolean", async () => {
    const folder = makeTaskFolder();
    const channel = vscode.window.createOutputChannel("test-capture") as unknown as { lines: string[] };
    const originalCreate = (vscode.window as unknown as Record<string, unknown>).createOutputChannel;
    (vscode.window as unknown as Record<string, unknown>).createOutputChannel = () => channel;
    resetChatHistoryDiagnosticsChannelForTestV1();
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
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("only keeps the most recent quarantine copy, and a later successful write is unaffected", async () => {
    const folder = makeTaskFolder();
    const channel = vscode.window.createOutputChannel("test-capture") as unknown as { lines: string[] };
    const originalCreate = (vscode.window as unknown as Record<string, unknown>).createOutputChannel;
    (vscode.window as unknown as Record<string, unknown>).createOutputChannel = () => channel;
    resetChatHistoryDiagnosticsChannelForTestV1();
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
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("throws instead of returning empty when the quarantine copy itself cannot be written, leaving chat-v1.json untouched", async () => {
    const folder = makeTaskFolder();
    const channel = vscode.window.createOutputChannel("test-capture") as unknown as { lines: string[] };
    const originalCreate = (vscode.window as unknown as Record<string, unknown>).createOutputChannel;
    (vscode.window as unknown as Record<string, unknown>).createOutputChannel = () => channel;
    resetChatHistoryDiagnosticsChannelForTestV1();

    const corruptFile = path.join(folder, CHAT_HISTORY_CORRUPT_FILENAME);
    const patch = patchFsPromises({
      writeFile: (((target: fs.PathLike, ...rest: unknown[]) => {
        if (path.normalize(String(target)) === path.normalize(corruptFile)) {
          return Promise.reject(Object.assign(new Error("simulated quarantine write failure"), { code: "EACCES" }));
        }
        return (fs.promises.writeFile as unknown as (...a: unknown[]) => Promise<void>)(target, ...rest);
      }) as unknown) as typeof fs.promises.writeFile,
    });

    try {
      fs.writeFileSync(path.join(folder, CHAT_HISTORY_FILENAME), "{not valid json");

      await assert.rejects(
        () => readChatHistory(folder),
        /unreadable/,
        "readChatHistory must throw rather than silently report an empty transcript"
      );

      assert.equal(fs.existsSync(corruptFile), false, "no quarantine copy exists — the write failed");
      assert.equal(
        fs.readFileSync(path.join(folder, CHAT_HISTORY_FILENAME), "utf8"),
        "{not valid json",
        "the only copy of the corrupt transcript must be left untouched, not overwritten"
      );
    } finally {
      patch.restore();
      (vscode.window as unknown as Record<string, unknown>).createOutputChannel = originalCreate;
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

void describe("chatHistoryStore read failures other than not-found", () => {
  void it("throws instead of returning [] when the file exists but the read fails for a reason other than not-found", async () => {
    const folder = makeTaskFolder();
    const historyPath = path.join(folder, CHAT_HISTORY_FILENAME);
    const original = JSON.stringify({ version: 1, messages: [message("hello")] });
    fs.writeFileSync(historyPath, original);
    const patch = patchFsPromises({
      open: (((target: fs.PathLike, ...rest: unknown[]) => {
        if (path.normalize(String(target)) === path.normalize(historyPath)) {
          return Promise.reject(Object.assign(new Error("simulated permission failure"), { code: "EACCES" }));
        }
        return (fs.promises.open as unknown as (...a: unknown[]) => Promise<fs.promises.FileHandle>)(target, ...rest);
      }) as unknown) as typeof fs.promises.open,
    });
    try {
      await assert.rejects(
        () => readChatHistory(folder),
        /could not be read/,
        "a non-not-found read failure must throw, not silently report an empty transcript"
      );
      assert.equal(fs.readFileSync(historyPath, "utf8"), original);
      assert.equal(fs.existsSync(path.join(folder, CHAT_HISTORY_CORRUPT_FILENAME)), false);
    } finally {
      patch.restore();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("chatHistoryFileExists throws instead of reporting false when stat fails for a reason other than not-found", async () => {
    const folder = makeTaskFolder();
    const historyPath = path.join(folder, CHAT_HISTORY_FILENAME);
    fs.writeFileSync(historyPath, JSON.stringify({ version: 1, messages: [message("hello")] }));

    const patch = patchFsPromises({
      lstat: (((target: fs.PathLike, ...rest: unknown[]) => {
        if (path.normalize(String(target)) === path.normalize(historyPath)) {
          return Promise.reject(Object.assign(new Error("simulated stat failure"), { code: "EBUSY" }));
        }
        return (fs.promises.lstat as unknown as (...a: unknown[]) => Promise<fs.Stats>)(target, ...rest);
      }) as unknown) as typeof fs.promises.lstat,
    });
    try {
      await assert.rejects(
        () => chatHistoryFileExists(folder),
        /could not be accessed/,
        "a non-not-found stat failure must throw, not report the file as missing"
      );
    } finally {
      patch.restore();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("loadTranscriptWithMigration throws (rather than falling through to legacy/empty) when stat fails for a reason other than not-found on an existing transcript", async () => {
    const folder = makeTaskFolder();
    const canonicalId = folder;
    const legacyKey = `ensemble.stageChat.transcript.${encodeURIComponent(canonicalId)}`;
    const { memento, updates } = makeMemento({ [legacyKey]: [message("legacy-should-not-surface")] });
    const historyPath = path.join(folder, CHAT_HISTORY_FILENAME);
    const original = JSON.stringify({ version: 1, messages: [message("existing")] });
    fs.writeFileSync(historyPath, original);

    const patch = patchFsPromises({
      lstat: (((target: fs.PathLike, ...rest: unknown[]) => {
        if (path.normalize(String(target)) === path.normalize(historyPath)) {
          return Promise.reject(Object.assign(new Error("simulated stat failure"), { code: "EBUSY" }));
        }
        return (fs.promises.lstat as unknown as (...a: unknown[]) => Promise<fs.Stats>)(target, ...rest);
      }) as unknown) as typeof fs.promises.lstat,
    });
    try {
      await assert.rejects(
        () => loadTranscriptWithMigration(folder, canonicalId, memento),
        /could not be accessed/,
        "a transient stat failure on an existing transcript must not be treated as 'never chatted'"
      );
      assert.equal(fs.readFileSync(historyPath, "utf8"), original);
      assert.deepEqual(updates, [], "the legacy key must not be touched when the stat failure prevents migration");
    } finally {
      patch.restore();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

void describe("chatHistoryStore legacy migration", () => {
  void it("migrates legacy Memento entries to chat-v1.json and NEVER deletes the legacy key (plan §5.3 / AC-CHAT-MIGRATE-03)", async () => {
    const folder = makeTaskFolder();
    const canonicalId = folder;
    const legacyKey = `ensemble.stageChat.transcript.${encodeURIComponent(canonicalId)}`;
    const legacyValue = [message("legacy-1"), message("legacy-2")];
    const { memento, updates } = makeMemento({ [legacyKey]: legacyValue });
    try {
      const result = await loadTranscriptWithMigration(folder, canonicalId, memento);
      assert.deepEqual(result.map((m) => m.text), ["legacy-1", "legacy-2"]);
      assert.ok(fs.existsSync(path.join(folder, CHAT_HISTORY_FILENAME)), "migration must write chat-v1.json");
      assert.deepEqual(updates, [], "the legacy Memento key must never be deleted or modified by migration");
      assert.deepEqual(memento.get(legacyKey), legacyValue, "the legacy value itself must be byte-for-byte unchanged");

      const raw = readRawDocument(folder);
      const migration = raw.migration as { legacyValueSha256?: string; migratedAt?: string } | undefined;
      assert.ok(migration, "the document must record a migration marker");
      assert.equal(typeof migration.legacyValueSha256, "string");
      assert.equal(typeof migration.migratedAt, "string");

      // The file is authoritative afterward: a second read does not touch
      // the (still-present) legacy key.
      const second = await loadTranscriptWithMigration(folder, canonicalId, memento);
      assert.deepEqual(second.map((m) => m.text), ["legacy-1", "legacy-2"]);
      assert.deepEqual(updates, []);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("does not migrate when chat-v1.json already exists", async () => {
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
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("retains the legacy key and serves legacy entries directly when the migration write fails", async () => {
    const folder = makeTaskFolder();
    const canonicalId = folder;
    const legacyKey = `ensemble.stageChat.transcript.${encodeURIComponent(canonicalId)}`;
    const { memento, updates } = makeMemento({ [legacyKey]: [message("legacy-1")] });

    const targetFile = path.join(folder, CHAT_HISTORY_FILENAME);
    const patch = patchFsPromises({
      writeFile: (((target: fs.PathLike, ...rest: unknown[]) => {
        if (path.normalize(String(target)) === path.normalize(targetFile)) {
          return Promise.reject(Object.assign(new Error("simulated migration write failure"), { code: "EACCES" }));
        }
        return (fs.promises.writeFile as unknown as (...a: unknown[]) => Promise<void>)(target, ...rest);
      }) as unknown) as typeof fs.promises.writeFile,
    });

    try {
      const result = await loadTranscriptWithMigration(folder, canonicalId, memento);
      assert.deepEqual(result.map((m) => m.text), ["legacy-1"], "legacy entries are still served on a failed migration write");
      assert.deepEqual(updates, [], "the legacy key must be retained when the migration write fails");
      assert.equal(fs.existsSync(targetFile), false);
    } finally {
      patch.restore();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("returns an empty transcript when there is no file and no legacy entry", async () => {
    const folder = makeTaskFolder();
    const { memento } = makeMemento();
    try {
      const result = await loadTranscriptWithMigration(folder, folder, memento);
      assert.deepEqual(result, []);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("finds the legacy key by exact-prefix enumeration among multiple tasks' keys rather than guessing", async () => {
    const folder = makeTaskFolder();
    const canonicalId = folder;
    const otherKey = `ensemble.stageChat.transcript.${encodeURIComponent("some-other-task")}`;
    const legacyKey = `ensemble.stageChat.transcript.${encodeURIComponent(canonicalId)}`;
    const { memento } = makeMemento({
      [otherKey]: [message("belongs-to-a-different-task")],
      [legacyKey]: [message("belongs-to-this-task")],
    });
    try {
      const result = await loadTranscriptWithMigration(folder, canonicalId, memento);
      assert.deepEqual(result.map((m) => m.text), ["belongs-to-this-task"]);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("fails closed (quarantined, not silently emptied) when the legacy DTO is an unrecognized shape", async () => {
    const folder = makeTaskFolder();
    const canonicalId = folder;
    const legacyKey = `ensemble.stageChat.transcript.${encodeURIComponent(canonicalId)}`;
    // An unknown role is invalid per the plan §5.2 mapping table.
    const legacyValue = [{ role: "system", text: "unrecognized", stage: "impl", at: "2026-01-01T00:00:00.000Z" }];
    const { memento, updates } = makeMemento({ [legacyKey]: legacyValue });
    try {
      await assert.rejects(
        () => loadTranscriptWithMigration(folder, canonicalId, memento),
        (error: unknown) => error instanceof ChatHistoryRecoveryErrorV1
      );
      assert.deepEqual(updates, [], "the legacy Memento value must be left untouched");
      assert.equal(memento.get(legacyKey), legacyValue, "the legacy value itself must survive byte-for-byte");
      const quarantined = JSON.parse(
        fs.readFileSync(path.join(folder, CHAT_HISTORY_CORRUPT_FILENAME), "utf8")
      ) as unknown;
      assert.deepEqual(quarantined, legacyValue, "the unmigratable legacy value must be preserved for inspection");
      assert.equal(fs.existsSync(path.join(folder, CHAT_HISTORY_FILENAME)), false, "nothing is committed on failure");

      // Repeats every read until the user resolves it — never silently
      // resolves itself into an empty transcript.
      await assert.rejects(
        () => loadTranscriptWithMigration(folder, canonicalId, memento),
        (error: unknown) => error instanceof ChatHistoryRecoveryErrorV1
      );
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

void describe("chatHistoryStore structured interactions and Reset", () => {
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

  void it("appends an unresolved interaction and Reset clears it while preserving the document id and transcript", async () => {
    const folder = makeTaskFolder();
    const canonicalId = folder;
    try {
      await writeChatHistory(folder, [message("hi")], canonicalId);
      const before = readRawDocument(folder);

      await appendChatInteraction(folder, canonicalId, {
        interactionId: "1".repeat(32),
        operationId: "2".repeat(32),
        actionKey: "generatePlan.v1",
        sourceAttemptId: "a".repeat(32),
        stage: "impl",
        questions: QUESTIONS,
        postedAt: "2026-01-01T00:00:00.000Z",
        binding: { taskBindingId: before.taskBindingId as string, chatDocumentId: before.documentId as string },
      });
      const withInteraction = readRawDocument(folder);
      const interactions = withInteraction.interactions as Array<{ state: string }>;
      assert.equal(interactions.length, 1);
      assert.equal(interactions[0]!.state, "unresolved");

      const reset = await resetChatHistoryV1(folder, canonicalId);
      assert.equal(reset.ok, true);
      const afterReset = readRawDocument(folder);
      assert.equal(afterReset.documentId, before.documentId, "Reset must preserve the document id");
      assert.equal((afterReset.messages as ChatMessage[]).length, 1, "Reset must preserve the display transcript");
      assert.equal(afterReset.resetEpoch, 1);
      const resetInteractions = afterReset.interactions as Array<{ state: string }>;
      assert.equal(resetInteractions[0]!.state, "resetByChatRecovery");
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("rejects appending a second interaction with a duplicate interactionId", async () => {
    const folder = makeTaskFolder();
    const canonicalId = folder;
    try {
      const interaction = {
        interactionId: "3".repeat(32),
        operationId: "4".repeat(32),
        actionKey: "generatePlan.v1",
        sourceAttemptId: "b".repeat(32),
        stage: "impl" as const,
        questions: QUESTIONS,
        postedAt: "2026-01-01T00:00:00.000Z",
        binding: { taskBindingId: bindingIdForOwnedFolder(folder), chatDocumentId: "d".repeat(32) },
      };
      await appendChatInteraction(folder, canonicalId, interaction);
      await assert.rejects(() => appendChatInteraction(folder, canonicalId, interaction));
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("Reset refuses (leaving chat-v1.json untouched) when the verified snapshot cannot be written", async () => {
    const folder = makeTaskFolder();
    const canonicalId = folder;
    await writeChatHistory(folder, [message("hi")], canonicalId);
    const before = fs.readFileSync(path.join(folder, CHAT_HISTORY_FILENAME), "utf8");

    const patch = patchFsPromises({
      writeFile: (() => Promise.reject(Object.assign(new Error("simulated snapshot write failure"), { code: "EACCES" }))) as unknown as typeof fs.promises.writeFile,
    });
    try {
      const result = await resetChatHistoryV1(folder, canonicalId);
      assert.equal(result.ok, false);
      assert.equal(fs.readFileSync(path.join(folder, CHAT_HISTORY_FILENAME), "utf8"), before);
    } finally {
      patch.restore();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("Reset starts a fresh empty document when none exists yet, instead of refusing", async () => {
    const folder = makeTaskFolder();
    const canonicalId = folder;
    try {
      assert.equal(fs.existsSync(path.join(folder, CHAT_HISTORY_FILENAME)), false);
      const result = await resetChatHistoryV1(folder, canonicalId);
      assert.equal(result.ok, true);
      const raw = readRawDocument(folder);
      assert.deepEqual(raw.messages, []);
      assert.deepEqual(raw.interactions, []);
      assert.equal(raw.resetEpoch, 0);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

const BOUNDARY_QUESTIONS: readonly StructuredQuestionV1[] = [
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

void describe("chatHistoryStore — strict task-folder vs. non-task storage boundary", () => {
  void it("refuses a task conversation whose folder has no task-progress.json (missing progress)", async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-chat-history-bare-"));
    try {
      await assert.rejects(() => readChatHistory(folder), /has no task-progress\.json/);
      await assert.rejects(() => writeChatHistory(folder, [message("hi")]), /has no task-progress\.json/);
      assert.equal(fs.existsSync(path.join(folder, CHAT_HISTORY_FILENAME)), false);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("refuses a task conversation whose folder's progress carries no ownership (missing ownership)", async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-chat-history-no-ownership-"));
    try {
      fs.writeFileSync(
        path.join(folder, TASK_PROGRESS_FILENAME),
        JSON.stringify({
          taskFolder: path.basename(folder),
          currentStage: "impl",
          createdAt: "2026-07-01T10:00:00.000Z",
          updatedAt: "2026-07-02T11:30:00.000Z",
        })
      );
      await assert.rejects(() => writeChatHistory(folder, [message("hi")]), /carries no ownership binding/);
      assert.equal(fs.existsSync(path.join(folder, CHAT_HISTORY_FILENAME)), false);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("anchors every task conversation document to the folder's ownership-derived binding", async () => {
    const folder = makeTaskFolder();
    try {
      await writeChatHistory(folder, [message("hi")]);
      const raw = readRawDocument(folder);
      assert.equal(raw.taskBindingSource, "ownershipDerived");
      assert.equal(raw.taskBindingId, bindingIdForOwnedFolder(folder));
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("rejects an interaction whose coordinator-supplied binding does not match the folder's ownership (binding-to-folder mismatch)", async () => {
    const folder = makeTaskFolder();
    const canonicalId = folder;
    try {
      await assert.rejects(
        () =>
          appendChatInteraction(folder, canonicalId, {
            interactionId: "1".repeat(32),
            operationId: "2".repeat(32),
            actionKey: "generatePlan.v1",
            sourceAttemptId: "a".repeat(32),
            stage: "impl",
            questions: BOUNDARY_QUESTIONS,
            postedAt: "2026-01-01T00:00:00.000Z",
            binding: { taskBindingId: "0".repeat(64), chatDocumentId: "d".repeat(32) },
          }),
        /does not match the caller-supplied task binding/
      );
      // The refusal happens before anything is read or written.
      assert.equal(fs.existsSync(path.join(folder, CHAT_HISTORY_FILENAME)), false);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("the Global Assistant conversation registers its folder as dedicated non-task storage", async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-chat-history-global-"));
    const canonicalId = GLOBAL_ASSISTANT_CANONICAL_ID;
    try {
      await writeChatHistory(folder, [message("hello global")], canonicalId);
      const read = await readChatHistory(folder, canonicalId);
      assert.deepEqual(read.map((m) => m.text), ["hello global"]);
      // The assistant's folder has no ownership to derive from: the document
      // uses the localDigest stand-in, and the root registers under the
      // separate nonTaskStorage kind — never the strict task-folder kind.
      const raw = readRawDocument(folder);
      assert.equal(raw.taskBindingSource, "localDigest");
      const root = getWorkflowPathRegistryV1()
        .registeredRoots()
        .find((r) => r.fsPath === folder);
      assert.ok(root, "expected the assistant folder to be registered");
      assert.equal(getWorkflowPathRegistryV1().rootKind(root.rootId), "nonTaskStorage");
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
