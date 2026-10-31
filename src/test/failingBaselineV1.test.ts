/**
 * bugs3 Step 15: a recorded failing check run stands in for a fresh one before
 * the AI fix pass only when the commit, tree fingerprint, scope, configured
 * commands and command identity all match and the automatic fixes saved nothing.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { CompletionLintResult } from "../utils/completionLint";
import {
  buildFailingBaselineRecordV1,
  clearFailingBaselineV1,
  completionLintResultFromBaselineV1,
  decideFailingBaselineReuseV1,
  readFailingBaselineV1,
  writeFailingBaselineV1,
  type FailingBaselineRecordV1,
} from "../utils/failingBaselineV1";

const COMMANDS = ["pnpm run verify"];

function failingResult(overrides: Partial<CompletionLintResult> = {}): CompletionLintResult {
  return {
    runAt: "2026-10-27T08:09:00.000Z",
    passed: false,
    summary: "1 check failed",
    issueCount: 1,
    failedChecks: [
      {
        command: "pnpm run verify",
        exitCode: 1,
        output: "Failing tests (2): …",
        failingTests: {
          total: 2,
          runCompleted: true,
          tests: [
            { file: "out/test/a.test.js", title: "one" },
            { file: "out/test/a.test.js", title: "two" },
          ],
        },
      },
    ],
    missingScripts: [],
    commandsRun: COMMANDS,
    verifiedFolder: "/repo",
    ...overrides,
  } as CompletionLintResult;
}

function record(): FailingBaselineRecordV1 {
  const built = buildFailingBaselineRecordV1({
    result: failingResult(),
    headBefore: "abc123",
    headAfter: "abc123",
    fingerprintBefore: "fp1",
    fingerprintAfter: "fp1",
    scopeId: "scope-1",
    configuredCommands: [],
  });
  assert.ok(built);
  return built;
}

const SAME = { headCommit: "abc123", treeFingerprint: "fp1", scopeId: "scope-1", configuredCommands: [] as string[] };

void describe("failing baseline record (bugs3 Step 15)", () => {
  void it("records a failing run bound to commit, fingerprint, scope and command identity", () => {
    const built = record();
    assert.equal(built.headCommit, "abc123");
    assert.equal(built.treeFingerprint, "fp1");
    assert.equal(built.scopeId, "scope-1");
    assert.match(built.commandIdentity, /^[0-9a-f]{32}$/);
    assert.deepEqual(built.commandsRun, COMMANDS);
  });

  void it("records nothing for a passing run, an unknown identity, or a tree that moved during the run", () => {
    const base = {
      headBefore: "abc123",
      headAfter: "abc123",
      fingerprintBefore: "fp1",
      fingerprintAfter: "fp1",
      scopeId: "s",
      configuredCommands: [],
    };
    assert.equal(buildFailingBaselineRecordV1({ ...base, result: failingResult({ passed: true, failedChecks: [] }) }), undefined);
    assert.equal(buildFailingBaselineRecordV1({ ...base, result: failingResult({ commandsRun: undefined }) }), undefined);
    assert.equal(buildFailingBaselineRecordV1({ ...base, headAfter: "def456", result: failingResult() }), undefined);
    assert.equal(buildFailingBaselineRecordV1({ ...base, fingerprintAfter: "fp2", result: failingResult() }), undefined);
    assert.equal(buildFailingBaselineRecordV1({ ...base, fingerprintBefore: undefined, fingerprintAfter: undefined, result: failingResult() }), undefined);
  });

  void it("keeps each check's output bounded", () => {
    const big = buildFailingBaselineRecordV1({
      result: failingResult({ failedChecks: [{ command: "pnpm run verify", exitCode: 1, output: "x".repeat(200_000) }] }),
      headBefore: "h",
      headAfter: "h",
      fingerprintBefore: "f",
      fingerprintAfter: "f",
      scopeId: "s",
      configuredCommands: [],
    });
    assert.ok((big?.failedChecks[0]?.output.length ?? Infinity) < 30_000);
  });
});

void describe("failing baseline reuse decision (bugs3 Step 15)", () => {
  void it("reuses a matching record when the automatic fixes saved nothing", () => {
    const decision = decideFailingBaselineReuseV1({ record: record(), current: SAME, deterministicEdits: 0 });
    assert.equal(decision.reuse, true);
  });

  void it("runs fresh, saying why, for each kind of mismatch", () => {
    const cases: { name: string; input: Parameters<typeof decideFailingBaselineReuseV1>[0]; reason: RegExp }[] = [
      { name: "missing record", input: { record: undefined, current: SAME, deterministicEdits: 0 }, reason: /no failing check result was recorded/ },
      { name: "automatic fixes edited files", input: { record: record(), current: SAME, deterministicEdits: 2 }, reason: /automatic fixes changed files/ },
      { name: "commit moved", input: { record: record(), current: { ...SAME, headCommit: "zzz" }, deterministicEdits: 0 }, reason: /commit changed/ },
      { name: "tree changed", input: { record: record(), current: { ...SAME, treeFingerprint: "fp2" }, deterministicEdits: 0 }, reason: /files changed/ },
      { name: "unknown fingerprint", input: { record: record(), current: { ...SAME, treeFingerprint: undefined }, deterministicEdits: 0 }, reason: /files changed/ },
      { name: "scope differs", input: { record: record(), current: { ...SAME, scopeId: "scope-2" }, deterministicEdits: 0 }, reason: /scope is different/ },
      { name: "commands setting changed", input: { record: record(), current: { ...SAME, configuredCommands: ["npm test"] }, deterministicEdits: 0 }, reason: /commands setting differs/ },
    ];
    for (const entry of cases) {
      const decision = decideFailingBaselineReuseV1(entry.input);
      assert.equal(decision.reuse, false, entry.name);
      if (!decision.reuse) {
        assert.match(decision.reason, entry.reason, entry.name);
      }
    }
  });

  void it("treats a record without configured commands (written before command identity) as legacy, never reusable", () => {
    const { configuredCommands: _dropped, ...legacy } = record();
    const decision = decideFailingBaselineReuseV1({
      record: legacy as unknown as FailingBaselineRecordV1,
      current: SAME,
      deterministicEdits: 0,
    });
    assert.equal(decision.reuse, false);
    if (!decision.reuse) {
      assert.match(decision.reason, /predates command identity/);
    }
  });

  void it("refuses a record whose identity does not match the commands it lists", () => {
    const tampered = { ...record(), commandsRun: ["pnpm run something-else"] };
    assert.equal(decideFailingBaselineReuseV1({ record: tampered, current: SAME, deterministicEdits: 0 }).reuse, false);
  });

  void it("the stand-in result is a failing run carrying the recorded failures and says it was not re-run", () => {
    const result = completionLintResultFromBaselineV1(record());
    assert.equal(result.passed, false);
    assert.equal(result.failedChecks[0]?.failingTests?.total, 2);
    assert.deepEqual(result.commandsRun, COMMANDS);
    assert.match(result.summary, /not run again/);
  });
});

void describe("failing baseline persistence (bugs3 Step 15)", () => {
  let folder: string;
  beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-baseline-"));
  });
  afterEach(() => {
    fs.rmSync(folder, { recursive: true, force: true });
  });

  void it("round-trips, clears, and ignores unreadable or foreign files", async () => {
    assert.equal(await readFailingBaselineV1(folder), undefined);
    await writeFailingBaselineV1(folder, record());
    const read = await readFailingBaselineV1(folder);
    assert.equal(read?.treeFingerprint, "fp1");
    assert.equal(read?.failedChecks[0]?.failingTests?.runCompleted, true);
    await clearFailingBaselineV1(folder);
    assert.equal(await readFailingBaselineV1(folder), undefined);
    fs.mkdirSync(path.join(folder, "runs"), { recursive: true });
    fs.writeFileSync(path.join(folder, "runs", "last-failing-checks-v1.json"), "{ not json");
    assert.equal(await readFailingBaselineV1(folder), undefined);
    fs.writeFileSync(path.join(folder, "runs", "last-failing-checks-v1.json"), JSON.stringify({ formatVersion: 2 }));
    assert.equal(await readFailingBaselineV1(folder), undefined);
  });
});
