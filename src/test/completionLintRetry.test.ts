/**
 * Coverage for step 9 (1a) of the workflow-resilience backlog: a completion
 * check that fails once is retried (with the build cache disabled) before
 * being reported red, so a single flaky failure does not become "ground
 * truth" a reviewer is instructed to trust and an implementer cannot
 * reproduce. See completionLint.ts's runWithRetry and CHECK_ATTEMPTS_MAX.
 *
 * These tests spawn real child processes (matching completionLintPublishChecks
 * .test.ts / completionLintKnownFlakes.test.ts) rather than mocking
 * child_process — the thing under test IS the actual retry-and-env-override
 * wiring around spawn.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, describe, it } from "node:test";
import {
  buildVerifiedChecksSection,
  collectCompletionLint,
  CompletionLintResult,
  runWithRetry,
} from "../utils/completionLint";

const TEST_ROOT = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ensemble-retry-test-"));
after(() => {
  nodeFs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

function makeWorkspace(name: string, testScript: string): string {
  const dir = nodePath.join(TEST_ROOT, name);
  nodeFs.mkdirSync(dir, { recursive: true });
  nodeFs.writeFileSync(
    nodePath.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "x",
        scripts: {
          lint: 'node -e "process.exit(0)"',
          "check-types": 'node -e "process.exit(0)"',
          test: testScript,
          build: 'node -e "process.exit(0)"',
        },
      },
      null,
      2
    ),
    "utf8"
  );
  return dir;
}

// Fails on its first invocation (no counter file yet), passes on every
// invocation after — exercises "fails once, passes on retry" without a
// timing-dependent flake.
const FAIL_ONCE_THEN_PASS =
  "node -e \"const fs=require('fs'); let n=0; try{n=parseInt(fs.readFileSync('counter.txt','utf8'))}catch(e){}; " +
  "fs.writeFileSync('counter.txt',String(n+1)); process.exit(n===0?1:0);\"";

// Fails every invocation, regardless of retries — proves retries are bounded
// and a genuinely-red check still reports failed.
const ALWAYS_FAILS = 'node -e "console.error(\'boom\'); process.exit(1)"';

// Fails invocation 1 unconditionally (forcing a retry); every invocation
// after that only passes if TURBO_FORCE=1 is set in its environment — proves
// the retry (and only the retry) runs with the cache bypass env applied.
const REQUIRES_CACHE_BYPASS_ON_RETRY =
  "node -e \"const fs=require('fs'); let n=0; try{n=parseInt(fs.readFileSync('counter.txt','utf8'))}catch(e){}; " +
  "fs.writeFileSync('counter.txt',String(n+1)); " +
  "if(n===0){process.exit(1)} process.exit(process.env.TURBO_FORCE==='1'?0:1);\"";

void describe("runWithRetry", () => {
  void it("returns retryCount 0 and does not retry when the first attempt passes", async () => {
    let calls = 0;
    const outcome = await runWithRetry(() => {
      calls++;
      return Promise.resolve({ code: 0, output: "ok" });
    });
    assert.deepEqual(outcome, { code: 0, output: "ok", retryCount: 0 });
    assert.equal(calls, 1);
  });

  void it("retries on failure and stops as soon as an attempt passes", async () => {
    let calls = 0;
    const outcome = await runWithRetry(() => {
      calls++;
      return Promise.resolve(calls < 2 ? { code: 1, output: "fail" } : { code: 0, output: "ok" });
    });
    assert.equal(outcome.code, 0);
    assert.equal(outcome.retryCount, 1);
    assert.equal(calls, 2);
  });

  void it("stops after CHECK_ATTEMPTS_MAX total attempts and reports the last failure", async () => {
    let calls = 0;
    const outcome = await runWithRetry(() => {
      calls++;
      return Promise.resolve({ code: 7, output: `fail ${calls}` });
    });
    assert.equal(outcome.code, 7);
    assert.equal(outcome.output, "fail 3");
    assert.equal(outcome.retryCount, 2, "2 retries after the initial attempt = 3 total attempts");
    assert.equal(calls, 3);
  });

  void it("passes the cache-bypass env override only on retries, never the first attempt", async () => {
    const envSeen: Array<NodeJS.ProcessEnv | undefined> = [];
    await runWithRetry((extraEnv) => {
      envSeen.push(extraEnv);
      return Promise.resolve(envSeen.length < 2 ? { code: 1, output: "fail" } : { code: 0, output: "ok" });
    });
    assert.equal(envSeen[0], undefined, "the first attempt must not receive a cache-bypass override");
    assert.deepEqual(envSeen[1], { TURBO_FORCE: "1" }, "the retry must bypass the build cache");
  });
});

void describe("collectCompletionLint — retry with cache bypass (real command execution)", () => {
  void it("reports a check that fails once and passes on retry as passing, with the retry recorded", async () => {
    const dir = makeWorkspace("fail-once-then-pass", FAIL_ONCE_THEN_PASS);
    const result = await collectCompletionLint(dir, []);

    assert.equal(result.passed, true, "the check's FINAL exit code was 0");
    assert.equal(result.failedChecks.length, 0);
    assert.equal(result.retriedPasses?.length, 1, "a retried pass must never be silently indistinguishable from clean");
    assert.equal(result.retriedPasses?.[0]?.command.includes("run test"), true);
    assert.equal(result.retriedPasses?.[0]?.retryCount, 1);
    assert.match(result.summary, /required a retry to pass/);
  });

  void it("stays red when a check fails consistently, recording the retry count on the failure", async () => {
    const dir = makeWorkspace("always-fails", ALWAYS_FAILS);
    const result = await collectCompletionLint(dir, []);

    assert.equal(result.passed, false);
    const failure = result.failedChecks.find((c) => c.command.includes("run test"));
    assert.ok(failure, "a check that fails every attempt must still be reported as a failed check");
    assert.equal(failure.retryCount, 2, "2 retries were exhausted before giving up");
    assert.equal(result.retriedPasses?.length ?? 0, 0);
  });

  void it("bypasses the build cache (TURBO_FORCE=1) on the retry but not the first attempt", async () => {
    const dir = makeWorkspace("cache-bypass-required", REQUIRES_CACHE_BYPASS_ON_RETRY);
    const result = await collectCompletionLint(dir, []);

    assert.equal(result.passed, true, "the retry — which sees TURBO_FORCE=1 — must succeed");
    assert.equal(result.retriedPasses?.[0]?.retryCount, 1);
  });
});

void describe("buildVerifiedChecksSection — retried-pass visibility (the actual 1a fix)", () => {
  function baseResult(overrides: Partial<CompletionLintResult> = {}): CompletionLintResult {
    return {
      runAt: "2026-01-01T00:00:00.000Z",
      passed: true,
      summary: "No linting issues found.",
      issueCount: 0,
      failedChecks: [],
      missingScripts: [],
      ...overrides,
    };
  }

  void it("surfaces a retried-pass with its retry count even though failedChecks is empty", () => {
    // The exact bug this test guards against: a check that failed once and
    // passed on retry has NO entry in failedChecks (final exit code 0), so a
    // naive implementation renders it identically to a check that was clean
    // on the first try — the backlog's explicit "never rendered as clean".
    const result = baseResult({
      retriedPasses: [{ command: "npm run test", retryCount: 1 }],
    });
    const section = buildVerifiedChecksSection(result);
    assert.doesNotMatch(section, /^- Overall: All checks passed\.$/m, "must not read as a fully clean run");
    assert.match(section, /only after a retry/);
    assert.match(section, /npm run test.*passed on retry 1/);
  });

  void it("still reports a completely clean run as clean when there were no retries", () => {
    const section = buildVerifiedChecksSection(baseResult());
    assert.match(section, /Overall: All checks passed\.$/m);
    assert.doesNotMatch(section, /retry/);
  });
});
