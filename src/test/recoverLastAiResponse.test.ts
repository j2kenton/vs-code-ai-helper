/**
 * Coverage for `findMostRecentSpool` (plan §3.2's Recover Last AI Response
 * command): the fragile disk-walking logic behind "Recover Last AI Response"
 * — newest-recovery-wins, corrupt-meta skip, missing-dir handling, and (since
 * the broker and the coordinator's own rejected-response recovery copy share
 * the exact same store and directory tree) filtering to ONLY spools marked
 * `purpose: "recovery"`, never surfacing an ordinary broker spool for a
 * large in-flight or already-settled response under a "rejected" banner.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { ActionCorrelationV1, allocateHex128IdV1 } from "../types/actionCorrelationV1";
import { createBoundedResultStoreV1 } from "../services/boundedResultStoreV1";
import { findMostRecentSpool } from "../commands/recoverLastAiResponse";

function makeCorrelation(): ActionCorrelationV1 {
  return {
    actionKey: "recoverTestAction.v1",
    operationId: allocateHex128IdV1(),
    attemptId: allocateHex128IdV1(),
    taskBindingId: "task-binding-digest",
    chatDocumentId: "chat-document-id",
  };
}

function makeRootDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-recover-last-response-"));
}

void describe("recoverLastAiResponse — findMostRecentSpool", () => {
  void it("returns undefined for a rootDir that does not exist yet, without throwing", () => {
    const rootDir = path.join(os.tmpdir(), "ensemble-recover-last-response-never-created");
    assert.equal(findMostRecentSpool(rootDir), undefined);
  });

  void it("returns undefined when the tree has no recovery-marked spool at all", async () => {
    const rootDir = makeRootDir();
    try {
      const store = createBoundedResultStoreV1({ rootDir });
      // An ordinary broker spool — never marked "recovery".
      await store.writeSpool(makeCorrelation(), allocateHex128IdV1(), Buffer.from("ordinary"));
      assert.equal(findMostRecentSpool(rootDir), undefined);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  void it("ignores a newer ordinary broker spool and returns the recovery-marked one", async () => {
    const rootDir = makeRootDir();
    try {
      let current = new Date("2026-08-06T10:00:00.000Z");
      const store = createBoundedResultStoreV1({ rootDir, now: () => current });

      const recoveryRef = await store.writeSpool(
        makeCorrelation(),
        allocateHex128IdV1(),
        Buffer.from("rejected response"),
        { purpose: "recovery" }
      );

      // Written LATER (newer createdAt) but never marked — must still lose to
      // the recovery spool above, since it is not a rejected response at all.
      current = new Date("2026-08-06T11:00:00.000Z");
      await store.writeSpool(makeCorrelation(), allocateHex128IdV1(), Buffer.from("ordinary, newer"));

      const found = findMostRecentSpool(rootDir);
      assert.ok(found, "expected the recovery-marked spool to be found");
      assert.equal(found.meta.operationId, recoveryRef.operationId);
      assert.equal(fs.readFileSync(found.binPath, "utf8"), "rejected response");
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  void it("picks the newest among multiple recovery-marked spools", async () => {
    const rootDir = makeRootDir();
    try {
      let current = new Date("2026-08-06T10:00:00.000Z");
      const store = createBoundedResultStoreV1({ rootDir, now: () => current });

      await store.writeSpool(makeCorrelation(), allocateHex128IdV1(), Buffer.from("older rejected"), {
        purpose: "recovery",
      });

      current = new Date("2026-08-06T12:00:00.000Z");
      const newerRef = await store.writeSpool(
        makeCorrelation(),
        allocateHex128IdV1(),
        Buffer.from("newer rejected"),
        { purpose: "recovery" }
      );

      const found = findMostRecentSpool(rootDir);
      assert.ok(found);
      assert.equal(found.meta.operationId, newerRef.operationId);
      assert.equal(fs.readFileSync(found.binPath, "utf8"), "newer rejected");
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  void it("skips a corrupt/unreadable spool-meta-v1.json instead of failing the whole scan", async () => {
    const rootDir = makeRootDir();
    try {
      const store = createBoundedResultStoreV1({ rootDir });
      const goodRef = await store.writeSpool(
        makeCorrelation(),
        allocateHex128IdV1(),
        Buffer.from("good rejected response"),
        { purpose: "recovery" }
      );

      const corruptDir = path.join(rootDir, "corrupt-op", "corrupt-attempt", "corrupt-reservation");
      fs.mkdirSync(corruptDir, { recursive: true });
      fs.writeFileSync(path.join(corruptDir, "spool-meta-v1.json"), "{ not valid json", "utf8");
      fs.writeFileSync(path.join(corruptDir, "result-v1.bin"), "unreachable", "utf8");

      const found = findMostRecentSpool(rootDir);
      assert.ok(found, "the corrupt entry must not hide the good one");
      assert.equal(found?.meta.operationId, goodRef.operationId);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  void it("skips a recovery-marked spool that has already expired", async () => {
    const rootDir = makeRootDir();
    try {
      // Far in the past relative to real wall-clock time, so the 24h expiry
      // computed from it is also already in the past by the time
      // findMostRecentSpool compares against the real `new Date()`.
      const store = createBoundedResultStoreV1({
        rootDir,
        now: () => new Date("2000-01-01T00:00:00.000Z"),
      });
      await store.writeSpool(makeCorrelation(), allocateHex128IdV1(), Buffer.from("long expired"), {
        purpose: "recovery",
      });

      assert.equal(findMostRecentSpool(rootDir), undefined);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
