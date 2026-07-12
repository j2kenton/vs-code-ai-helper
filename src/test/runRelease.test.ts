/**
 * Unit tests for isSafeReleaseScript, the regex gate that decides whether a
 * package.json `scripts.release` value is safe to show in the Release
 * confirmation dialog. This is a display sanity check, not the security
 * boundary — runRelease never executes the script text itself, it always
 * delegates to `<manager> run release` (see reviewActions.ts) — but a script
 * string engineered to look benign should still never slip past the gate.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSafeReleaseScript } from "../commands/reviewActions";

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
