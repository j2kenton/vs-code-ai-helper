/**
 * bugs5 Step 11: checkpoint recovery retries when another session's lease holds the state lock
 * (recognised by type), and an interrupted Publish Checks run is announced once, in plain words.
 * Reported 2026-10-31 (jester): an auto-update restart's recovery failed once on the lock and gave up.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { PrimarySessionLock, PrimarySessionLockHeldError } from "../state/primarySessionLock";
import { retryWhileStateLockHeldV1, STATE_LOCK_RETRY_DELAYS_MS_V1 } from "../state/stateLockRetryV1";
import { describeInterruptedChecksNoticeV1 } from "../utils/interruptedChecksNoticeV1";

void describe("retryWhileStateLockHeldV1 (bugs5 Step 11)", () => {
  void it("waits longer than the lock's 30 s lease before giving up", () => {
    const total = STATE_LOCK_RETRY_DELAYS_MS_V1.reduce((sum, ms) => sum + ms, 0);
    assert.ok(total > 30_000);
    assert.equal(STATE_LOCK_RETRY_DELAYS_MS_V1.length, 5);
  });

  void it("retries a held lease by type and returns the eventual result", async () => {
    let calls = 0;
    const waits: number[] = [];
    const result = await retryWhileStateLockHeldV1(
      () => {
        calls += 1;
        return calls < 3 ? Promise.reject(new PrimarySessionLockHeldError()) : Promise.resolve("recovered");
      },
      {
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      }
    );
    assert.equal(result, "recovered");
    assert.equal(calls, 3);
    assert.deepEqual(waits, STATE_LOCK_RETRY_DELAYS_MS_V1.slice(0, 2));
  });

  void it("does not retry an error that merely says the same words, or any other failure", async () => {
    let calls = 0;
    await assert.rejects(
      retryWhileStateLockHeldV1(
        () => {
          calls += 1;
          return Promise.reject(new Error("Another Ensemble session is currently updating task state."));
        },
        { sleep: () => Promise.resolve() }
      ),
      /Another Ensemble/
    );
    assert.equal(calls, 1);
  });

  void it("gives up with the lock error once the delays run out", async () => {
    let calls = 0;
    await assert.rejects(
      retryWhileStateLockHeldV1(
        () => {
          calls += 1;
          return Promise.reject(new PrimarySessionLockHeldError());
        },
        { delaysMs: [1, 1], sleep: () => Promise.resolve() }
      ),
      PrimarySessionLockHeldError
    );
    assert.equal(calls, 3);
  });

  void it("the real lock throws the typed error while another live session holds it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-held-"));
    try {
      const lockPath = path.join(dir, ".test.lock");
      const release = await new PrimarySessionLock(lockPath).acquire();
      try {
        await assert.rejects(new PrimarySessionLock(lockPath).acquire(), PrimarySessionLockHeldError);
      } finally {
        await release();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

void describe("the interrupted Publish Checks notice (bugs5 Step 11)", () => {
  void it("says when Ensemble restarted and that the checks need running again", () => {
    const text = describeInterruptedChecksNoticeV1(new Date(2026, 10, 1, 7, 5));
    assert.equal(text, "Publish Checks were interrupted (Ensemble restarted at 07:05) — run them again.");
  });
});
