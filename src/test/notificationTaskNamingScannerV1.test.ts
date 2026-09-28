/**
 * 1.0 item 11: the notification-naming scanner must see every call that creates
 * a Notifications entry, including `NotificationRouter.emitProgressSummary`
 * (progress summaries), not only the `show*` methods. The script's own self-test
 * classifies a synthetic file that contains progress-summary sites (one bare, one
 * inside `runTrackedOperation`) and exits non-zero with "self-test failed" if the
 * scan skips them, so running it here guards that coverage.
 */
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { describe, it } from "node:test";

void describe("verifyNotificationTaskNamingV1 scanner coverage", () => {
  const repoRoot = path.join(__dirname, "..", "..");
  const run = spawnSync(process.execPath, ["scripts/verifyNotificationTaskNamingV1.mjs", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

  void it("passes its built-in self-test, which covers emitProgressSummary sites", () => {
    assert.ok(!run.stderr.includes("self-test failed"), run.stderr);
    const report = JSON.parse(run.stdout) as { counts: Record<string, number> };
    assert.ok(Object.values(report.counts).reduce((a, b) => a + b, 0) > 0);
  });

  // RC1 item 11 / f3 Part 14 boundary: the working tree must classify every
  // task-specific notification site as attributed, self-named, or allow-listed
  // global — none left in the un-named group verify:workflow-safety gates on.
  void it("reports zero un-named sites on the current working tree, and exits 0", () => {
    const report = JSON.parse(run.stdout) as {
      counts: Record<string, number>;
      unNamed: Array<{ file: string; line: number; snippet: string }>;
      stale: string[];
    };
    assert.equal(report.counts["un-named"], 0, JSON.stringify(report.unNamed, null, 2));
    assert.equal(report.unNamed.length, 0);
    assert.equal(report.stale.length, 0, JSON.stringify(report.stale, null, 2));
    assert.equal(run.status, 0);
  });
});
