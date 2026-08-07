/**
 * Coverage for step 12 (1d) of the workflow-resilience backlog: the Verified
 * Checks evidence must disclose the environment it actually ran in — at
 * minimum which env var NAMES were present, plus the resolved cwd and
 * package manager — without ever disclosing a credential-bearing VALUE.
 * Motivating case: jester 2026-07-30_task_1 sat at 7/10 for eight rounds on
 * a blocker that was real in the extension host and unreproducible in a
 * plain shell because the two environments differed (DATABASE_URL) and
 * nothing in either party's evidence hinted at why.
 *
 * These tests spawn a real collectCompletionLint run (matching the sibling
 * completionLint*.test.ts files) so the actual production env-capture is
 * what's being asserted on, not a hand-built fixture.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, before, describe, it } from "node:test";
import {
  buildVerifiedChecksSection,
  collectCompletionLint,
  CompletionLintResult,
} from "../utils/completionLint";

const TEST_ROOT = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ensemble-env-disclosure-test-"));
after(() => {
  nodeFs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

function makeWorkspace(name: string): string {
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
          test: 'node -e "process.exit(0)"',
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

const SECRET_ENV_NAME = "ENSEMBLE_TEST_DATABASE_URL";
const SECRET_ENV_VALUE = "postgres://reviewer:hunter2@db.internal:5432/prod-should-never-leak";

void describe("collectCompletionLint — verification environment disclosure (real command execution)", () => {
  before(() => {
    process.env[SECRET_ENV_NAME] = SECRET_ENV_VALUE;
  });
  after(() => {
    delete process.env[SECRET_ENV_NAME];
  });

  void it("reports the env var NAME but never its VALUE, in both the result and every rendered surface", async () => {
    const dir = makeWorkspace("env-disclosure");
    const result = await collectCompletionLint(dir, []);

    assert.ok(result.verificationEnvironment, "verificationEnvironment must be populated");
    assert.ok(
      result.verificationEnvironment.envVarNames.includes(SECRET_ENV_NAME),
      "a variable actually present in the check's environment must be named"
    );

    const serializedResult = JSON.stringify(result);
    assert.doesNotMatch(
      serializedResult,
      new RegExp(SECRET_ENV_VALUE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "the raw result object must never carry the secret value anywhere"
    );

    const section = buildVerifiedChecksSection(result);
    assert.match(section, new RegExp(SECRET_ENV_NAME), "the name must be disclosed — that's the diagnostic value");
    assert.doesNotMatch(section, /hunter2|db\.internal|prod-should-never-leak/, "the value must never appear");
  });

  void it("discloses the resolved cwd and package manager as the only value-bearing fields", async () => {
    const dir = makeWorkspace("env-cwd-manager");
    const result = await collectCompletionLint(dir, []);

    assert.ok(result.verificationEnvironment, "verificationEnvironment must be populated");
    assert.equal(result.verificationEnvironment.cwd, dir);
    assert.match(result.verificationEnvironment.packageManager, /^npm(\s.+)?$/);

    const section = buildVerifiedChecksSection(result);
    assert.match(section, /Resolved cwd:/);
    assert.match(section, /Package manager: npm/);
  });
});

void describe("buildVerifiedChecksSection — environment rendering (fixture-based)", () => {
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

  void it("renders every env var name and never any value, even for a fabricated credential-shaped name", () => {
    const result = baseResult({
      verificationEnvironment: {
        cwd: "C:\\proj",
        packageManager: "pnpm 9.1.0",
        envVarNames: ["PATH", "DATABASE_URL", "NODE_ENV"],
      },
    });
    const section = buildVerifiedChecksSection(result);
    assert.match(section, /`PATH`, `DATABASE_URL`, `NODE_ENV`/);
    assert.match(section, /values redacted/);
  });

  void it("degrades gracefully when verificationEnvironment is absent (older/mocked result)", () => {
    const section = buildVerifiedChecksSection(baseResult());
    assert.doesNotMatch(section, /Environment these checks ran in|Resolved cwd:/);
  });

  void it("renders the environment section even on a fully clean run with no failures", () => {
    const result = baseResult({
      verificationEnvironment: { cwd: "C:\\proj", packageManager: "npm 10.0.0", envVarNames: ["PATH"] },
    });
    const section = buildVerifiedChecksSection(result);
    assert.match(section, /Overall: All checks passed\./);
    assert.match(section, /Environment these checks ran in/);
  });
});
