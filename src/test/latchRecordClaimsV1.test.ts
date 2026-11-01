/**
 * bugs4 Step 15 (items 22-23): the claims that set the unreliable-checklist latch travel
 * on the latch record (`checklistProgressUnreliableClaims`), and the reconcile card reads
 * that record before it falls back to the latching round's run log.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { buildChecklistMergeDiagnosticsNoteV1 } from "../commands/reviewActions";
import { decodeTaskProgressTextV1 } from "../services/taskProgressDecoderV1";
import { encodeTaskProgressV1 } from "../services/taskProgressWriterV1";
import { MAX_LATCHING_CLAIMS_V1 } from "../types/taskProgress";
import { latchingClaimsForRecordV1, loadLatchingClaimsV1 } from "../utils/latchingClaimsFromRunLogV1";

const CLAIM_A = "Key a single terminal chat emitter by operation ID and derive its Ended record from `TaskActionOutcomeV1`.";
const CLAIM_B = "Bridge duplicate command and notification endings into the single terminal emitter.";

const BASE = {
  taskFolder: "2026-07-01_task_1",
  currentStage: "impl",
  createdAt: "2026-07-01T10:00:00.000Z",
  updatedAt: "2026-07-02T11:30:00.000Z",
};

void describe("latch record carries the latching claims (bugs4 item 22)", () => {
  void it("stores every unmatched claim of a no-match round", () => {
    const stored = latchingClaimsForRecordV1({
      kind: "no-match",
      unmatchedSample: [CLAIM_A, CLAIM_B],
      unmatchedAll: [CLAIM_A, CLAIM_B],
    });
    assert.deepEqual(stored, [CLAIM_A, CLAIM_B]);
  });

  void it("stores nothing for other merge outcomes, and never a partial list", () => {
    assert.equal(latchingClaimsForRecordV1(undefined), undefined);
    assert.equal(latchingClaimsForRecordV1({ kind: "no-report" } as never), undefined);
    const tooMany = Array.from({ length: MAX_LATCHING_CLAIMS_V1 + 1 }, (_, index) => `claim ${index}`);
    assert.equal(
      latchingClaimsForRecordV1({ kind: "no-match", unmatchedSample: tooMany.slice(0, 2), unmatchedAll: tooMany }),
      undefined,
      "a list the record cannot hold is left to the run log rather than truncated"
    );
  });

  void it("round-trips through the strict task-progress decoder and writer", () => {
    const written = encodeTaskProgressV1({
      ...BASE,
      checklistProgressUnreliable: true,
      checklistProgressUnreliableReason: "an implementation round claimed checklist items that did not match any plan item",
      checklistProgressUnreliableClaims: [CLAIM_A, CLAIM_B],
      ensembleProgressVersion: 1,
    } as unknown as Parameters<typeof encodeTaskProgressV1>[0]);
    const decoded = decodeTaskProgressTextV1(written);
    assert.equal(decoded.ok, true);
    if (decoded.ok) {
      assert.deepEqual(decoded.decoded.progress.checklistProgressUnreliableClaims, [CLAIM_A, CLAIM_B]);
    }
  });

  void it("rejects an empty list, a non-string claim and an over-long list", () => {
    for (const bad of [[], [1], [""], Array.from({ length: MAX_LATCHING_CLAIMS_V1 + 1 }, () => "x"), "claim"]) {
      const result = decodeTaskProgressTextV1(JSON.stringify({ ...BASE, checklistProgressUnreliableClaims: bad }));
      assert.equal(result.ok, false, JSON.stringify(bad).slice(0, 60));
    }
  });
});

void describe("loadLatchingClaimsV1 (bugs4 item 23)", () => {
  async function folderWithLog(claims: readonly string[]): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "latch-claims-"));
    await fs.mkdir(path.join(dir, "runs"));
    const note = buildChecklistMergeDiagnosticsNoteV1({
      mergeKind: "no-match",
      unmatchedSample: [...claims],
      unmatchedTotal: claims.length,
      latchSet: true,
    });
    await fs.writeFile(path.join(dir, "runs", "065-impl.md"), `# Run 065\n${note}\n`);
    return dir;
  }

  void it("prefers the latch record over the run log", async () => {
    const dir = await folderWithLog([CLAIM_B]);
    try {
      const loaded = await loadLatchingClaimsV1(dir, [CLAIM_A]);
      assert.deepEqual(loaded?.unmatchedAll, [CLAIM_A]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("falls back to the run log's complete diagnostics when the record is absent (a latch from an older build)", async () => {
    const dir = await folderWithLog([CLAIM_A, CLAIM_B]);
    try {
      const loaded = await loadLatchingClaimsV1(dir, undefined);
      assert.deepEqual(loaded?.unmatchedAll, [CLAIM_A, CLAIM_B]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("returns nothing when there is neither a record nor a log", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "latch-claims-empty-"));
    try {
      assert.equal(await loadLatchingClaimsV1(dir, undefined), undefined);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
