/**
 * v1 fixes 2, item 29: Publish Checks can be cancelled. The token reaches the
 * check processes (via `RunGuardOptions.token`), a cancelled run rejects with a
 * distinct `PublishChecksCancelledError` BEFORE anything is persisted, and the
 * command registers its tracked operation as cancellable and classifies that
 * error as a cancellation rather than a failure.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  PublishChecksCancelledError,
  runCompletionLint,
  throwIfPublishChecksCancelledV1,
} from "../utils/completionLint";
import { safeRemoveDir } from "./testFsUtils";

const TEST_ROOT = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ensemble-publish-cancel-"));
after(() => {
  safeRemoveDir(TEST_ROOT);
});

const SLEEP_SCRIPT = 'node -e "setTimeout(() => {}, 60000)"';

function makeTaskDir(name: string): string {
  const dir = nodePath.join(TEST_ROOT, name);
  nodeFs.mkdirSync(dir, { recursive: true });
  nodeFs.writeFileSync(
    nodePath.join(dir, "package.json"),
    JSON.stringify({ name: "x", scripts: { lint: SLEEP_SCRIPT, test: SLEEP_SCRIPT } }),
    "utf8"
  );
  return dir;
}

void describe("throwIfPublishChecksCancelledV1", () => {
  void it("throws the typed cancellation error only for a cancelled token", () => {
    const source = new vscode.CancellationTokenSource();
    assert.doesNotThrow(() => throwIfPublishChecksCancelledV1(source.token));
    assert.doesNotThrow(() => throwIfPublishChecksCancelledV1(undefined));
    source.cancel();
    assert.throws(() => throwIfPublishChecksCancelledV1(source.token), PublishChecksCancelledError);
  });
});

void describe("runCompletionLint cancellation", () => {
  void it("kills the running checks, rejects with the cancellation error and persists nothing", async () => {
    const dir = makeTaskDir("cancel-mid-run");
    const source = new vscode.CancellationTokenSource();
    const startedAt = Date.now();
    const timer = setTimeout(() => source.cancel(), 500);
    try {
      await assert.rejects(
        runCompletionLint(vscode.Uri.file(dir), [], { token: source.token }),
        (error: unknown) => error instanceof PublishChecksCancelledError
      );
    } finally {
      clearTimeout(timer);
    }
    assert.ok(
      Date.now() - startedAt < 30_000,
      "cancelling must stop the 60s check processes instead of waiting for them"
    );
    assert.equal(
      nodeFs.existsSync(nodePath.join(dir, "task-progress.json")),
      false,
      "a cancelled run must not write a lint result into task progress"
    );
  });
});

void describe("runPublishChecks wiring", () => {
  const source = nodeFs.readFileSync(
    nodePath.join(process.cwd(), "src", "commands", "runPublishChecks.ts"),
    "utf8"
  );

  void it("registers the tracked operation as cancellable and forwards its token to the checks", () => {
    assert.match(source, /kind: "completion-checks",[\s\S]*?cancellable: true,/);
    assert.match(source, /runCompletionLint\(\s*taskFolderUri,\s*resolvedTask\.progress\.implReviewFiles,\s*\{ token: cancelToken \}\s*\)/);
  });

  void it("classifies the cancellation error before the generic failure notification", () => {
    const cancelledIndex = source.indexOf("error instanceof PublishChecksCancelledError");
    const failedIndex = source.indexOf("Publish checks failed to run:");
    assert.ok(cancelledIndex > 0 && failedIndex > cancelledIndex);
  });

  void it("checks for cancellation before writing the freshness stamp", () => {
    const lastCheck = source.lastIndexOf("throwIfPublishChecksCancelledV1(cancelToken)");
    const stampWrite = source.indexOf("await writePublishChecksFreshnessStampV1(");
    assert.ok(lastCheck > 0 && stampWrite > lastCheck);
  });
});
