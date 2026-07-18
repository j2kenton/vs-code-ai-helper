/**
 * Coverage for the commit-session store (pendingCommitSession.ts): the
 * session is in-memory only (the untitled review editor's lifetime IS the
 * session — nothing survives a window reload, by design), and claiming is
 * exactly-once (the core of settlement's "never commit twice" guarantee).
 */
import * as assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  claimPendingCommitSession,
  clearLiveCommitReviewWake,
  clearPendingCommitSession,
  getPendingCommitSession,
  registerLiveCommitReviewWake,
  requestLiveCommitReviewWake,
  storePendingCommitSession,
  type PendingCommitSession,
} from "../utils/pendingCommitSession";

function makeSession(overrides: Partial<PendingCommitSession> = {}): PendingCommitSession {
  return {
    version: 2,
    taskFolderPath: "/repo/.ensemble/task",
    taskName: "task",
    repoRoot: "/repo",
    scopedFiles: ["src/a.ts"],
    documentUri: "untitled:Untitled-1",
    currentBranch: "main",
    hasUpstream: true,
    pushDestination: "origin/main",
    createdAt: 1234,
    ...overrides,
  };
}

beforeEach(() => {
  // The module keeps an in-memory session and wake registration across
  // tests — reset both.
  clearPendingCommitSession();
  clearLiveCommitReviewWake();
});

void test("store/get round-trips the in-memory session", () => {
  const session = makeSession();
  storePendingCommitSession(session);
  assert.deepEqual(getPendingCommitSession(), session);
});

void test("claim returns the session exactly once", () => {
  storePendingCommitSession(makeSession());
  const first = claimPendingCommitSession();
  const second = claimPendingCommitSession();
  assert.equal(first?.createdAt, 1234);
  assert.equal(second, undefined);
  assert.equal(getPendingCommitSession(), undefined);
});

void test("a restored session (commit-failure retry) can be claimed again", () => {
  storePendingCommitSession(makeSession());
  const claimed = claimPendingCommitSession();
  assert.ok(claimed);
  // Settlement failed → the session is restored so the still-open editor
  // can retry; the retry claims it again.
  storePendingCommitSession(claimed);
  assert.equal(claimPendingCommitSession()?.createdAt, 1234);
});

void test("clear removes the session so later claims find nothing", () => {
  storePendingCommitSession(makeSession());
  clearPendingCommitSession();
  assert.equal(claimPendingCommitSession(), undefined);
});

void test("wake request without a live review returns false", () => {
  assert.equal(requestLiveCommitReviewWake(), false);
});

void test("wake request invokes the registered wake exactly once (one-shot)", () => {
  let wakeCount = 0;
  registerLiveCommitReviewWake(() => { wakeCount += 1; });
  assert.equal(requestLiveCommitReviewWake(), true);
  assert.equal(wakeCount, 1);
  // The registration is consumed: a second confirm falls back to its own
  // tracked operation instead of double-waking a finished review.
  assert.equal(requestLiveCommitReviewWake(), false);
  assert.equal(wakeCount, 1);
});

void test("a cleared wake registration is never invoked", () => {
  let wakeCount = 0;
  registerLiveCommitReviewWake(() => { wakeCount += 1; });
  clearLiveCommitReviewWake();
  assert.equal(requestLiveCommitReviewWake(), false);
  assert.equal(wakeCount, 0);
});
