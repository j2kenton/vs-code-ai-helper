/**
 * Coverage for resetChatHistoryV1's no-document path applying the SAME
 * private-storage-availability gate AND the same write-and-verify-a-snapshot
 * contract as the with-document path (module header "RESET" section of
 * chatHistoryStore.ts): Reset must not silently relax its declared contract
 * just because there happens to be no prior document to snapshot — the fresh
 * empty document is itself written to the registered recovery-snapshot
 * locator before being committed as chat-v1.json. Runs in its own file (no
 * top-level `configureWorkflowPrivateStorageRootV1` call) so the "storage not
 * configured yet" state is genuine — see the isolation note in
 * chatInteractionOrphanReconciliation.test.ts for why this is safe under
 * this project's `node --test` runner (each `.test.js` file gets its own
 * module registry).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { CHAT_HISTORY_FILENAME, resetChatHistoryV1 } from "../utils/chatHistoryStore";
import { configureWorkflowPrivateStorageRootV1 } from "../services/workflowRuntimeServicesV1";
import { makeOwnedTaskFolder } from "./taskFolderFixture";

function makeTaskFolder(): string {
  // Task conversations require the strict, ownership-backed task-folder
  // root contract (see workflowRuntimeServicesV1.ts).
  return makeOwnedTaskFolder("ensemble-chat-reset-gate-").folder;
}

void describe("resetChatHistoryV1 — no-document path honors the private-storage gate", () => {
  void it("refuses (and creates nothing) when no document exists yet and private storage is not configured", async () => {
    const folder = makeTaskFolder();
    const canonicalId = folder;
    try {
      assert.equal(fs.existsSync(path.join(folder, CHAT_HISTORY_FILENAME)), false);
      const result = await resetChatHistoryV1(folder, canonicalId);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.reason, /workflowStorageUnavailable/);
      }
      assert.equal(
        fs.existsSync(path.join(folder, CHAT_HISTORY_FILENAME)),
        false,
        "no chat-v1.json should be created when the gate refuses"
      );
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("writes and verifies a private snapshot before starting a fresh empty document once storage is configured", async () => {
    const privateStorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-chat-reset-gate-private-"));
    configureWorkflowPrivateStorageRootV1(privateStorageRoot);
    const folder = makeTaskFolder();
    const canonicalId = folder;
    try {
      const result = await resetChatHistoryV1(folder, canonicalId);
      assert.equal(result.ok, true);
      assert.equal(fs.existsSync(path.join(folder, CHAT_HISTORY_FILENAME)), true);

      const committed = JSON.parse(fs.readFileSync(path.join(folder, CHAT_HISTORY_FILENAME), "utf8")) as {
        documentId: string;
      };
      if (!result.ok) {
        assert.fail("expected ok:true");
      }
      const snapshotPath = path.join(
        privateStorageRoot,
        "workflow-runtime-v1",
        "chat-recovery",
        committed.documentId,
        result.resetId,
        "snapshot-v1.json"
      );
      assert.equal(
        fs.existsSync(snapshotPath),
        true,
        "the no-document Reset path must still write a verified private recovery snapshot"
      );
      const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as { documentId: string; messages: unknown[] };
      assert.equal(snapshot.documentId, committed.documentId);
      assert.deepEqual(snapshot.messages, []);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
