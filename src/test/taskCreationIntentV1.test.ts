/**
 * Coverage for the §4.2 creation intent/journal/sentinel record types: strict
 * decoding (unknown-field rejection, bounded shapes, no coercion — the same
 * conventions chatInteractionTransactionV1.ts established) and the six-state
 * forward-only transition machine.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import {
  computeTaskCreationIntentDigestV1,
  CREATION_INTENT_STATES_V1,
  creationIntentFileNameV1,
  creationJournalFileNameV1,
  decodeTaskCreationIntentV1,
  decodeTaskCreationJournalV1,
  decodeTaskCreationSentinelV1,
  encodeTaskCreationIntentV1,
  encodeTaskCreationJournalV1,
  encodeTaskCreationSentinelV1,
  fileCreationIntentEntryV1,
  isLegalCreationIntentTransitionV1,
  TaskCreationIntentV1,
  TaskCreationJournalV1,
  TaskCreationSentinelV1,
} from "../types/taskCreationIntentV1";

function makeIntent(overrides: Partial<TaskCreationIntentV1> = {}): TaskCreationIntentV1 {
  return {
    schemaVersion: 1,
    intentId: allocateHex128IdV1(),
    taskFolderName: "2026-07-30_task_1",
    taskFolderPath: "C:\\meta\\2026-07-30_task_1",
    metaFolderPath: "C:\\meta",
    ownership: { metaRoot: "C:\\meta", projectRoot: "C:\\proj", workspaceRoot: "C:\\proj" },
    createdAt: "2026-07-30T10:00:00.000Z",
    ...overrides,
  };
}

function makeJournal(overrides: Partial<TaskCreationJournalV1> = {}): TaskCreationJournalV1 {
  const intentId = overrides.intentId ?? allocateHex128IdV1();
  return {
    schemaVersion: 1,
    intentId,
    state: "intentRecorded",
    entries: [],
    createdAt: "2026-07-30T10:00:00.000Z",
    updatedAt: "2026-07-30T10:00:00.000Z",
    transitions: [{ receiptId: allocateHex128IdV1(), from: null, to: "intentRecorded", at: "2026-07-30T10:00:00.000Z" }],
    ...overrides,
  };
}

void describe("taskCreationIntentV1 — legal transitions", () => {
  void it("allows only the exact forward chain with no self-transitions or skips", () => {
    assert.equal(isLegalCreationIntentTransitionV1(null, "intentRecorded"), true);
    assert.equal(isLegalCreationIntentTransitionV1("intentRecorded", "workMaterialized"), true);
    assert.equal(isLegalCreationIntentTransitionV1("workMaterialized", "finalFolderClaimed"), true);
    assert.equal(isLegalCreationIntentTransitionV1("finalFolderClaimed", "sentinelCommitted"), true);
    assert.equal(isLegalCreationIntentTransitionV1("sentinelCommitted", "progressCommitted"), true);
    assert.equal(isLegalCreationIntentTransitionV1("progressCommitted", "resolved"), true);

    // No self-transitions.
    for (const state of CREATION_INTENT_STATES_V1) {
      assert.equal(isLegalCreationIntentTransitionV1(state, state), false, `${state} -> ${state} must be illegal`);
    }
    // No skipping ahead.
    assert.equal(isLegalCreationIntentTransitionV1("intentRecorded", "finalFolderClaimed"), false);
    assert.equal(isLegalCreationIntentTransitionV1(null, "workMaterialized"), false);
    // No going backward.
    assert.equal(isLegalCreationIntentTransitionV1("workMaterialized", "intentRecorded"), false);
    // Terminal: nothing legal out of "resolved".
    assert.equal(isLegalCreationIntentTransitionV1("resolved", "resolved"), false);
    assert.equal(isLegalCreationIntentTransitionV1("resolved", "intentRecorded"), false);
  });
});

void describe("taskCreationIntentV1 — digest and filenames", () => {
  void it("is a deterministic 64-hex sha256 of its input, and filenames embed it verbatim", () => {
    const digest = computeTaskCreationIntentDigestV1("c:\\meta\\2026-07-30_task_1");
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(computeTaskCreationIntentDigestV1("c:\\meta\\2026-07-30_task_1"), digest, "must be deterministic");
    assert.notEqual(
      computeTaskCreationIntentDigestV1("c:\\meta\\2026-07-30_task_2"),
      digest,
      "different input must produce a different digest"
    );
    assert.equal(creationIntentFileNameV1(digest), `intent-${digest}.json`);
    assert.equal(creationJournalFileNameV1(digest), `journal-${digest}.json`);
  });
});

void describe("taskCreationIntentV1 — intent decoding", () => {
  void it("round-trips a valid intent", () => {
    const intent = makeIntent();
    const decoded = decodeTaskCreationIntentV1(encodeTaskCreationIntentV1(intent));
    assert.equal(decoded.ok, true);
    if (decoded.ok) {
      assert.deepEqual(decoded.intent, intent);
    }
  });

  void it("rejects invalid JSON, non-objects, unknown fields, and bad schemaVersion", () => {
    assert.equal(decodeTaskCreationIntentV1("{not json").ok, false);
    assert.equal(decodeTaskCreationIntentV1("[]").ok, false);
    assert.equal(decodeTaskCreationIntentV1(JSON.stringify({ ...makeIntent(), extra: 1 })).ok, false);
    assert.equal(decodeTaskCreationIntentV1(JSON.stringify({ ...makeIntent(), schemaVersion: 2 })).ok, false);
  });

  void it("rejects a malformed intentId, empty identity strings, and an invalid createdAt", () => {
    assert.equal(decodeTaskCreationIntentV1(JSON.stringify({ ...makeIntent(), intentId: "not-hex" })).ok, false);
    assert.equal(decodeTaskCreationIntentV1(JSON.stringify({ ...makeIntent(), taskFolderName: "" })).ok, false);
    assert.equal(decodeTaskCreationIntentV1(JSON.stringify({ ...makeIntent(), createdAt: "not-a-date" })).ok, false);
  });

  void it("rejects malformed or incomplete ownership", () => {
    const intent = makeIntent();
    assert.equal(
      decodeTaskCreationIntentV1(JSON.stringify({ ...intent, ownership: { ...intent.ownership, metaRoot: "" } })).ok,
      false
    );
    assert.equal(
      decodeTaskCreationIntentV1(
        JSON.stringify({ ...intent, ownership: { metaRoot: intent.ownership.metaRoot, projectRoot: intent.ownership.projectRoot } })
      ).ok,
      false,
      "missing workspaceRoot must be rejected"
    );
    assert.equal(
      decodeTaskCreationIntentV1(
        JSON.stringify({ ...intent, ownership: { ...intent.ownership, extra: "nope" } })
      ).ok,
      false,
      "unknown ownership field must be rejected"
    );
  });
});

void describe("taskCreationIntentV1 — journal decoding", () => {
  void it("round-trips a valid journal at every state", () => {
    let journal = makeJournal();
    const decoded0 = decodeTaskCreationJournalV1(encodeTaskCreationJournalV1(journal));
    assert.equal(decoded0.ok, true);
    if (decoded0.ok) assert.deepEqual(decoded0.journal, journal);

    const chain: Array<{ to: TaskCreationJournalV1["state"] }> = [
      { to: "workMaterialized" },
      { to: "finalFolderClaimed" },
      { to: "sentinelCommitted" },
      { to: "progressCommitted" },
      { to: "resolved" },
    ];
    for (const { to } of chain) {
      const receipt = { receiptId: allocateHex128IdV1(), from: journal.state, to, at: "2026-07-30T10:05:00.000Z" };
      journal = { ...journal, state: to, updatedAt: "2026-07-30T10:05:00.000Z", transitions: [...journal.transitions, receipt] };
      const decoded = decodeTaskCreationJournalV1(encodeTaskCreationJournalV1(journal));
      assert.equal(decoded.ok, true, `journal at state ${to} must decode`);
      if (decoded.ok) assert.equal(decoded.journal.state, to);
    }
  });

  void it("rejects a journal whose declared state does not match its last transition", () => {
    const journal = makeJournal({ state: "workMaterialized" }); // transitions still say intentRecorded
    const decoded = decodeTaskCreationJournalV1(encodeTaskCreationJournalV1(journal));
    assert.equal(decoded.ok, false);
  });

  void it("rejects a transitions array containing an illegal edge", () => {
    const journal = makeJournal({
      state: "finalFolderClaimed",
      transitions: [
        { receiptId: allocateHex128IdV1(), from: null, to: "intentRecorded", at: "2026-07-30T10:00:00.000Z" },
        // Skips workMaterialized entirely — illegal.
        { receiptId: allocateHex128IdV1(), from: "intentRecorded", to: "finalFolderClaimed", at: "2026-07-30T10:01:00.000Z" },
      ],
    });
    const decoded = decodeTaskCreationJournalV1(encodeTaskCreationJournalV1(journal));
    assert.equal(decoded.ok, false);
  });

  void it("rejects a transitions array whose receipts don't chain (a gap or reordering)", () => {
    const journal = makeJournal({
      state: "finalFolderClaimed",
      transitions: [
        { receiptId: allocateHex128IdV1(), from: null, to: "intentRecorded", at: "2026-07-30T10:00:00.000Z" },
        { receiptId: allocateHex128IdV1(), from: "workMaterialized", to: "finalFolderClaimed", at: "2026-07-30T10:01:00.000Z" },
      ],
    });
    const decoded = decodeTaskCreationJournalV1(encodeTaskCreationJournalV1(journal));
    assert.equal(decoded.ok, false);
  });

  void it("rejects duplicate entries, invalid relativePath (traversal), and unknown entryClass", () => {
    const base = makeJournal({ state: "finalFolderClaimed" });
    const withFinal = {
      ...base,
      transitions: [
        ...base.transitions,
        { receiptId: allocateHex128IdV1(), from: "intentRecorded", to: "workMaterialized", at: "2026-07-30T10:01:00.000Z" },
        { receiptId: allocateHex128IdV1(), from: "workMaterialized", to: "finalFolderClaimed", at: "2026-07-30T10:02:00.000Z" },
      ],
    };
    assert.equal(
      decodeTaskCreationJournalV1(
        JSON.stringify({
          ...withFinal,
          entries: [
            { relativePath: "task.md", kind: "file", entryClass: "createdV1" },
            { relativePath: "task.md", kind: "file", entryClass: "createdV1" },
          ],
        })
      ).ok,
      false
    );
    assert.equal(
      decodeTaskCreationJournalV1(
        JSON.stringify({ ...withFinal, entries: [{ relativePath: "../escape.md", kind: "file", entryClass: "createdV1" }] })
      ).ok,
      false
    );
    assert.equal(
      decodeTaskCreationJournalV1(
        JSON.stringify({ ...withFinal, entries: [{ relativePath: "task.md", kind: "file", entryClass: "bogusClass" }] })
      ).ok,
      false
    );
  });

  void it("rejects an empty transitions array and unknown top-level fields", () => {
    const journal = makeJournal();
    assert.equal(decodeTaskCreationJournalV1(JSON.stringify({ ...journal, transitions: [] })).ok, false);
    assert.equal(decodeTaskCreationJournalV1(JSON.stringify({ ...journal, extra: true })).ok, false);
  });

  void it("rejects a file entry missing contentSha256/sizeBytes, and a directory entry carrying either", () => {
    const journal = makeJournal();
    assert.equal(
      decodeTaskCreationJournalV1(
        JSON.stringify({ ...journal, entries: [{ relativePath: "task.md", kind: "file", entryClass: "createdV1" }] })
      ).ok,
      false,
      "a file entry without contentSha256/sizeBytes must be rejected"
    );
    assert.equal(
      decodeTaskCreationJournalV1(
        JSON.stringify({
          ...journal,
          entries: [{ relativePath: "task.md", kind: "file", entryClass: "createdV1", contentSha256: "not-hex", sizeBytes: 3 }],
        })
      ).ok,
      false,
      "a malformed contentSha256 must be rejected"
    );
    assert.equal(
      decodeTaskCreationJournalV1(
        JSON.stringify({
          ...journal,
          entries: [
            { relativePath: "task.md", kind: "file", entryClass: "createdV1", contentSha256: "a".repeat(64), sizeBytes: -1 },
          ],
        })
      ).ok,
      false,
      "a negative sizeBytes must be rejected"
    );
    assert.equal(
      decodeTaskCreationJournalV1(
        JSON.stringify({
          ...journal,
          entries: [
            { relativePath: "runs", kind: "directory", entryClass: "createdV1", contentSha256: "a".repeat(64), sizeBytes: 0 },
          ],
        })
      ).ok,
      false,
      "a directory entry must not carry contentSha256/sizeBytes"
    );
  });

  void it("round-trips a file entry built by fileCreationIntentEntryV1 with its real content hash/size", () => {
    const bytes = Buffer.from("# Task\n\nhello world\n", "utf8");
    const entry = fileCreationIntentEntryV1("task.md", "createdV1", bytes);
    assert.match(entry.contentSha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(entry.sizeBytes, bytes.byteLength);

    const journal = makeJournal({ entries: [entry] });
    const decoded = decodeTaskCreationJournalV1(encodeTaskCreationJournalV1(journal));
    assert.equal(decoded.ok, true);
    if (decoded.ok) {
      assert.deepEqual(decoded.journal.entries, [entry]);
    }

    // Same bytes -> same hash (deterministic); different bytes -> different hash (content-sensitive).
    assert.equal(fileCreationIntentEntryV1("task.md", "createdV1", bytes).contentSha256, entry.contentSha256);
    assert.notEqual(
      fileCreationIntentEntryV1("task.md", "createdV1", Buffer.from("# Task\n\nedited\n", "utf8")).contentSha256,
      entry.contentSha256
    );
  });
});

const TEST_FILE_SHA256 = "a".repeat(64);

void describe("taskCreationIntentV1 — sentinel decoding", () => {
  function makeSentinel(overrides: Partial<TaskCreationSentinelV1> = {}): TaskCreationSentinelV1 {
    return {
      schemaVersion: 1,
      intentId: allocateHex128IdV1(),
      taskFolderName: "2026-07-30_task_1",
      createdAt: "2026-07-30T10:00:00.000Z",
      entries: [
        { relativePath: "task-progress.json", kind: "file", entryClass: "createdV1", contentSha256: TEST_FILE_SHA256, sizeBytes: 42 },
        { relativePath: "task.md", kind: "file", entryClass: "createdV1", contentSha256: TEST_FILE_SHA256, sizeBytes: 42 },
      ],
      ...overrides,
    };
  }

  void it("round-trips a valid sentinel", () => {
    const sentinel = makeSentinel();
    const decoded = decodeTaskCreationSentinelV1(encodeTaskCreationSentinelV1(sentinel));
    assert.equal(decoded.ok, true);
    if (decoded.ok) assert.deepEqual(decoded.sentinel, sentinel);
  });

  void it("rejects an empty entries list and unknown fields", () => {
    assert.equal(decodeTaskCreationSentinelV1(JSON.stringify(makeSentinel({ entries: [] }))).ok, false);
    assert.equal(decodeTaskCreationSentinelV1(JSON.stringify({ ...makeSentinel(), extra: 1 })).ok, false);
  });

  void it("accepts all three sentinel entry classes", () => {
    const sentinel = makeSentinel({
      entries: [
        { relativePath: "task-progress.json", kind: "file", entryClass: "createdV1", contentSha256: TEST_FILE_SHA256, sizeBytes: 42 },
        { relativePath: "task.md", kind: "file", entryClass: "adoptedLegacy", contentSha256: TEST_FILE_SHA256, sizeBytes: 42 },
        { relativePath: "notes.md", kind: "file", entryClass: "preservedUser", contentSha256: TEST_FILE_SHA256, sizeBytes: 42 },
      ],
    });
    const decoded = decodeTaskCreationSentinelV1(encodeTaskCreationSentinelV1(sentinel));
    assert.equal(decoded.ok, true);
  });

  void it("rejects a file entry missing contentSha256/sizeBytes, and a directory entry carrying them", () => {
    assert.equal(
      decodeTaskCreationSentinelV1(
        JSON.stringify(makeSentinel({ entries: [{ relativePath: "task.md", kind: "file", entryClass: "createdV1" }] }))
      ).ok,
      false,
      "a file entry without contentSha256/sizeBytes must be rejected"
    );
    assert.equal(
      decodeTaskCreationSentinelV1(
        JSON.stringify(
          makeSentinel({
            entries: [
              { relativePath: "runs", kind: "directory", entryClass: "createdV1", contentSha256: TEST_FILE_SHA256, sizeBytes: 0 },
            ],
          })
        )
      ).ok,
      false,
      "a directory entry must not carry contentSha256/sizeBytes"
    );
  });
});
