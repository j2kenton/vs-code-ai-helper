/**
 * Coverage for the coordinator-owned result spool store (plan §3.2):
 * spools are private, integrity-checked, correlation-bound, claim-once,
 * removed after settlement, and expired within 24 hours.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { ActionCorrelationV1, allocateHex128IdV1 } from "../types/actionCorrelationV1";
import { ResultSpoolRefV1 } from "../types/agentExecutionV1";
import {
  BoundedResultStoreErrorV1,
  BoundedResultStoreV1,
  createBoundedResultStoreV1,
  RESULT_SPOOL_EXPIRY_MS_V1,
} from "../services/boundedResultStoreV1";

function makeCorrelation(): ActionCorrelationV1 {
  return {
    actionKey: "brokerTestAction.v1",
    operationId: allocateHex128IdV1(),
    attemptId: allocateHex128IdV1(),
    taskBindingId: "task-binding-digest",
    chatDocumentId: "chat-document-id",
  };
}

interface StoreFixture {
  rootDir: string;
  store: BoundedResultStoreV1;
  setNow(date: Date): void;
  cleanup(): void;
}

function makeStore(): StoreFixture {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-result-store-"));
  let current = new Date("2026-07-26T10:00:00.000Z");
  const store = createBoundedResultStoreV1({ rootDir, now: () => current });
  return {
    rootDir,
    store,
    setNow: (date: Date): void => {
      current = date;
    },
    cleanup: (): void => fs.rmSync(rootDir, { recursive: true, force: true }),
  };
}

function spoolBinPath(rootDir: string, ref: ResultSpoolRefV1): string {
  return path.join(rootDir, ref.operationId, ref.attemptId, ref.reservationId, "result-v1.bin");
}

function spoolClaimMarkerPath(rootDir: string, ref: ResultSpoolRefV1): string {
  return path.join(rootDir, ref.operationId, ref.attemptId, ref.reservationId, "claimed-v1.marker");
}

void describe("boundedResultStoreV1", () => {
  void it("writes correlation-bound metadata and round-trips a claim", async () => {
    const fixture = makeStore();
    try {
      const correlation = makeCorrelation();
      const reservationId = allocateHex128IdV1();
      const bytes = Buffer.from("sealed provider response ✓", "utf8");
      const ref = await fixture.store.writeSpool(correlation, reservationId, bytes);

      assert.equal(ref.byteLength, bytes.length);
      assert.equal(ref.reservationId, reservationId);
      assert.equal(ref.actionKey, correlation.actionKey);
      assert.equal(
        Date.parse(ref.expiresAt) - Date.parse(ref.createdAt),
        RESULT_SPOOL_EXPIRY_MS_V1,
        "spools must expire exactly 24 hours after creation"
      );

      const claim = await fixture.store.claimSpoolOnce(ref, correlation);
      assert.ok(claim.ok);
      if (claim.ok) {
        assert.equal(claim.utf8Text, bytes.toString("utf8"));
      }
    } finally {
      fixture.cleanup();
    }
  });

  void it("refuses to write without a complete well-formed identity", async () => {
    const fixture = makeStore();
    try {
      const correlation = makeCorrelation();
      await assert.rejects(
        fixture.store.writeSpool(
          { ...correlation, operationId: "short" },
          allocateHex128IdV1(),
          Buffer.from("x")
        ),
        BoundedResultStoreErrorV1
      );
      await assert.rejects(
        fixture.store.writeSpool(correlation, "not-a-reservation", Buffer.from("x")),
        BoundedResultStoreErrorV1
      );
    } finally {
      fixture.cleanup();
    }
  });

  void it("rejects a cross-operation claim without consuming the spool", async () => {
    const fixture = makeStore();
    try {
      const correlation = makeCorrelation();
      const ref = await fixture.store.writeSpool(
        correlation,
        allocateHex128IdV1(),
        Buffer.from("private")
      );
      const wrongClaim = await fixture.store.claimSpoolOnce(ref, {
        ...correlation,
        operationId: allocateHex128IdV1(),
      });
      assert.deepEqual(wrongClaim, { ok: false, code: "spoolCorrelationMismatch" });

      // The mismatched claim must not have consumed the single claim.
      const rightClaim = await fixture.store.claimSpoolOnce(ref, correlation);
      assert.ok(rightClaim.ok, "the correct owner can still claim after a mismatched attempt");
    } finally {
      fixture.cleanup();
    }
  });

  void it("is claim-once", async () => {
    const fixture = makeStore();
    try {
      const correlation = makeCorrelation();
      const ref = await fixture.store.writeSpool(
        correlation,
        allocateHex128IdV1(),
        Buffer.from("once")
      );
      const first = await fixture.store.claimSpoolOnce(ref, correlation);
      assert.ok(first.ok);
      const second = await fixture.store.claimSpoolOnce(ref, correlation);
      assert.deepEqual(second, { ok: false, code: "spoolAlreadyClaimed" });
    } finally {
      fixture.cleanup();
    }
  });

  void it("detects tampered spool bytes without consuming a claim, and removes them immediately", async () => {
    const fixture = makeStore();
    try {
      const correlation = makeCorrelation();
      const ref = await fixture.store.writeSpool(
        correlation,
        allocateHex128IdV1(),
        Buffer.from("authentic bytes")
      );
      fs.writeFileSync(spoolBinPath(fixture.rootDir, ref), "tampered bytes!");
      const claim = await fixture.store.claimSpoolOnce(ref, correlation);
      assert.deepEqual(claim, { ok: false, code: "spoolIntegrityMismatch" });
      // Only a successful claim consumes the spool's single claim: a failed
      // integrity check must never leave a claim marker behind.
      assert.equal(
        fs.existsSync(spoolClaimMarkerPath(fixture.rootDir, ref)),
        false,
        "an integrity failure must not create the claim marker"
      );
      // The corrupt bytes are removed immediately — not left behind until
      // the 24-hour expiry sweep.
      assert.equal(
        fs.existsSync(spoolBinPath(fixture.rootDir, ref)),
        false,
        "corrupt spool bytes must be removed at claim time"
      );
    } finally {
      fixture.cleanup();
    }
  });

  void it("only a successful claim creates the durable claim marker", async () => {
    const fixture = makeStore();
    try {
      const correlation = makeCorrelation();
      const ref = await fixture.store.writeSpool(
        correlation,
        allocateHex128IdV1(),
        Buffer.from("claimed once")
      );
      // A correlation-mismatched claim fails before the marker stage.
      await fixture.store.claimSpoolOnce(ref, {
        ...correlation,
        operationId: allocateHex128IdV1(),
      });
      assert.equal(fs.existsSync(spoolClaimMarkerPath(fixture.rootDir, ref)), false);

      const claim = await fixture.store.claimSpoolOnce(ref, correlation);
      assert.ok(claim.ok);
      assert.equal(
        fs.existsSync(spoolClaimMarkerPath(fixture.rootDir, ref)),
        true,
        "a successful claim writes the durable exclusive marker"
      );
    } finally {
      fixture.cleanup();
    }
  });

  void it("cleans up its partial files immediately when the metadata write fails", async () => {
    const fixture = makeStore();
    try {
      const correlation = makeCorrelation();
      const reservationId = allocateHex128IdV1();
      // Pre-create the metadata path so the exclusive ("wx") metadata write
      // fails after the binary write already succeeded.
      const dir = path.join(
        fixture.rootDir,
        correlation.operationId,
        correlation.attemptId,
        reservationId
      );
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "spool-meta-v1.json"), "occupied");

      await assert.rejects(
        fixture.store.writeSpool(correlation, reservationId, Buffer.from("private provider bytes"))
      );
      // The failed write's provider bytes must not linger until the expiry
      // sweep: a spool is durable only once BOTH files exist.
      assert.equal(
        fs.existsSync(path.join(dir, "result-v1.bin")),
        false,
        "a metadata-write failure removes the just-written binary immediately"
      );
    } finally {
      fixture.cleanup();
    }
  });

  void it("refuses a second spool write for the same reservation and keeps the first intact", async () => {
    const fixture = makeStore();
    try {
      const correlation = makeCorrelation();
      const reservationId = allocateHex128IdV1();
      const ref = await fixture.store.writeSpool(correlation, reservationId, Buffer.from("first"));
      // A reservation is invocation-once, so a second spool write for the
      // same reservation is always a protocol violation (exclusive creation).
      await assert.rejects(
        fixture.store.writeSpool(correlation, reservationId, Buffer.from("second"))
      );
      const claim = await fixture.store.claimSpoolOnce(ref, correlation);
      assert.ok(claim.ok, "the original spool survives the rejected duplicate write");
      if (claim.ok) {
        assert.equal(claim.utf8Text, "first");
      }
    } finally {
      fixture.cleanup();
    }
  });

  void it("expires spools after 24 hours and sweeps them", async () => {
    const fixture = makeStore();
    try {
      const correlation = makeCorrelation();
      const ref = await fixture.store.writeSpool(
        correlation,
        allocateHex128IdV1(),
        Buffer.from("stale")
      );
      fixture.setNow(new Date(Date.parse(ref.createdAt) + RESULT_SPOOL_EXPIRY_MS_V1 + 1000));

      const claim = await fixture.store.claimSpoolOnce(ref, correlation);
      assert.deepEqual(claim, { ok: false, code: "spoolExpired" });
      assert.equal(fs.existsSync(spoolBinPath(fixture.rootDir, ref)), false);

      const other = makeCorrelation();
      const otherRef = await fixture.store.writeSpool(
        other,
        allocateHex128IdV1(),
        Buffer.from("also stale")
      );
      fixture.setNow(new Date(Date.parse(otherRef.expiresAt) + 1000));
      const removed = await fixture.store.expireStaleSpools();
      assert.equal(removed, 1);
      assert.equal(fs.existsSync(spoolBinPath(fixture.rootDir, otherRef)), false);
    } finally {
      fixture.cleanup();
    }
  });

  void it("removes a settled spool completely", async () => {
    const fixture = makeStore();
    try {
      const correlation = makeCorrelation();
      const ref = await fixture.store.writeSpool(
        correlation,
        allocateHex128IdV1(),
        Buffer.from("settled")
      );
      const claim = await fixture.store.claimSpoolOnce(ref, correlation);
      assert.ok(claim.ok);
      await fixture.store.removeSpool(ref);
      assert.equal(
        fs.existsSync(path.join(fixture.rootDir, ref.operationId)),
        false,
        "settlement removes the spool's whole directory chain"
      );
    } finally {
      fixture.cleanup();
    }
  });
});
