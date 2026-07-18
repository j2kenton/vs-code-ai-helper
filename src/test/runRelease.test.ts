/**
 * Unit tests for isSafeReleaseScript, the regex gate that decides whether a
 * package.json `scripts.release` value is safe to show in the Release
 * confirmation dialog. This is a display sanity check, not the security
 * boundary — runRelease never executes the script text itself, it always
 * delegates to `<manager> run release` (see reviewActions.ts) — but a script
 * string engineered to look benign should still never slip past the gate.
 */
import * as assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  isSafeReleaseScript,
  orderReleaseTargetItems,
  resolveReleaseWorkspace,
} from "../commands/reviewActions";

void describe("isSafeReleaseScript", () => {
  void it("accepts plain release commands with allowed characters", () => {
    assert.strictEqual(isSafeReleaseScript("vsce publish"), true);
    assert.strictEqual(isSafeReleaseScript("semantic-release"), true);
    assert.strictEqual(isSafeReleaseScript("node scripts/release.js"), true);
    assert.strictEqual(isSafeReleaseScript("release.sh --tag v1.2.3"), true);
    assert.strictEqual(isSafeReleaseScript("npm-run-all build:prod publish:npm"), true);
  });

  void it("rejects shell chaining metacharacters", () => {
    assert.strictEqual(isSafeReleaseScript("foo && bar"), false);
    assert.strictEqual(isSafeReleaseScript("foo || bar"), false);
    assert.strictEqual(isSafeReleaseScript("foo | bar"), false);
    assert.strictEqual(isSafeReleaseScript("foo & bar"), false);
    assert.strictEqual(isSafeReleaseScript("rm -rf / ; echo pwned"), false);
  });

  void it("rejects command/variable substitution and redirection", () => {
    assert.strictEqual(isSafeReleaseScript("foo `whoami`"), false);
    assert.strictEqual(isSafeReleaseScript("foo $(whoami)"), false);
    assert.strictEqual(isSafeReleaseScript("foo $VAR"), false);
    assert.strictEqual(isSafeReleaseScript("foo > /etc/passwd"), false);
    assert.strictEqual(isSafeReleaseScript("foo < input.txt"), false);
    assert.strictEqual(isSafeReleaseScript("foo 2>&1"), false);
  });

  void it("rejects embedded quotes and newlines", () => {
    assert.strictEqual(isSafeReleaseScript('foo "bar"'), false);
    assert.strictEqual(isSafeReleaseScript("foo 'bar'"), false);
    assert.strictEqual(isSafeReleaseScript("foo\nbar"), false);
    assert.strictEqual(isSafeReleaseScript("foo\r\nbar"), false);
  });

  void it("rejects empty or whitespace-only scripts", () => {
    assert.strictEqual(isSafeReleaseScript(""), false);
    assert.strictEqual(isSafeReleaseScript("   "), false);
  });

  void it("rejects non-string values without throwing", () => {
    assert.strictEqual(isSafeReleaseScript(undefined), false);
    assert.strictEqual(isSafeReleaseScript(null), false);
    assert.strictEqual(isSafeReleaseScript(123), false);
    assert.strictEqual(isSafeReleaseScript({}), false);
    assert.strictEqual(isSafeReleaseScript(["vsce", "publish"]), false);
  });
});

void describe("resolveReleaseWorkspace", () => {
  const workspace = { uri: { fsPath: "C:\\Projects\\Helper" } };

  void it("uses persisted project ownership for an external metadata root", () => {
    const resolved = resolveReleaseWorkspace(
      "C:\\EnsembleMeta\\tasks\\task-a",
      {
        metaRoot: "C:\\EnsembleMeta",
        projectRoot: "c:\\projects\\helper",
      },
      [workspace]
    );

    assert.equal(resolved, workspace);
  });

  void it("rejects a task that is outside its persisted metadata root", () => {
    const resolved = resolveReleaseWorkspace(
      "C:\\Elsewhere\\task-a",
      {
        metaRoot: "C:\\EnsembleMeta",
        projectRoot: "C:\\Projects\\Helper",
      },
      [workspace]
    );

    assert.equal(resolved, undefined);
  });
});

// The release-target QuickPick defaults to the current task's Publish
// verification scope: its package.json is highlighted first (and labeled),
// while the persisted release target itself stays independent of the scope.
void describe("orderReleaseTargetItems", () => {
  const root = path.resolve("C:\\Projects\\Helper");
  const items = (): Array<{ label: string; description?: string }> => [
    { label: path.join("packages", "app", "package.json") },
    { label: "package.json" },
    { label: path.join("packages", "lib", "package.json") },
  ];

  void it("moves the package.json inside the task's Publish scope to the front and labels it", () => {
    const ordered = orderReleaseTargetItems(items(), root, path.join(root, "packages", "lib"));
    assert.equal(ordered[0]?.label, path.join("packages", "lib", "package.json"));
    assert.equal(ordered[0]?.description, "current task's Publish scope");
    // The rest keep the shortest-path-first order.
    assert.deepEqual(
      ordered.slice(1).map((item) => item.label),
      ["package.json", path.join("packages", "app", "package.json")]
    );
  });

  void it("matches the workspace-root scope to the root package.json", () => {
    const ordered = orderReleaseTargetItems(items(), root, root);
    assert.equal(ordered[0]?.label, "package.json");
    assert.equal(ordered[0]?.description, "current task's Publish scope");
  });

  void it("keeps plain shortest-path-first order when no scope is given or nothing matches", () => {
    for (const scope of [undefined, path.join(root, "packages", "missing")]) {
      const ordered = orderReleaseTargetItems(items(), root, scope);
      assert.deepEqual(
        ordered.map((item) => item.label),
        [
          "package.json",
          path.join("packages", "app", "package.json"),
          path.join("packages", "lib", "package.json"),
        ]
      );
      assert.equal(ordered.every((item) => item.description === undefined), true);
    }
  });
});
