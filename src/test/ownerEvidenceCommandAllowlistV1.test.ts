/**
 * review1 Step 45 / Step 46 (allowlist slice): only read-only commands are ever offered for "Run it for me", and
 * output is cleaned of anything that looks like a secret.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  findAllowlistedCommandInTextV1,
  parseAllowlistedCommandV1,
  redactSecretsFromCommandOutputV1,
} from "../utils/ownerEvidenceCommandAllowlistV1";

void describe("review1 Step 45: the read-only allowlist", () => {
  void it("accepts version, help, list and status commands of known provider CLIs", () => {
    for (const command of [
      "claude --version",
      "codex --help",
      "gemini -v",
      "copilot -h",
      "opencode status",
      "codex mcp list",
      "claude mcp ls",
      "agy models list",
    ]) {
      const parsed = parseAllowlistedCommandV1(command);
      assert.ok(parsed, command);
      assert.equal(parsed.display, command);
    }
  });

  void it("accepts git status, log and diff with read-only flags and plain paths", () => {
    for (const command of [
      "git status",
      "git status --short",
      "git log --oneline -5",
      "git log -n10 --stat",
      "git diff --stat src/utils/a.ts",
      "git diff --cached --name-only",
      "git log HEAD~3",
    ]) {
      assert.ok(parseAllowlistedCommandV1(command), command);
    }
  });

  void it("refuses a write command, an unknown program, and anything with shell syntax", () => {
    for (const command of [
      "git commit -m x",
      "git push",
      "git checkout main",
      "git reset --hard",
      "git diff --output=out.txt",
      "git log -o out.txt",
      "git diff ../other",
      "git diff /etc/passwd",
      "git status; rm -rf /",
      "git status && git push",
      "git log | sh",
      "git log > out.txt",
      "git status $(whoami)",
      "git log `id`",
      "claude -p ok",
      "claude auth login",
      "claude mcp add x",
      "claude config set a b",
      "codex exec ls",
      "rm -rf .",
      "curl https://example.com",
      "npm --version",
      "node --version",
      "claude",
      "git",
      "",
    ]) {
      assert.equal(parseAllowlistedCommandV1(command), undefined, JSON.stringify(command));
    }
  });

  void it("finds the first allowlisted command quoted in an owner-evidence request", () => {
    const request = "Run `npm test` and then `claude --version` and paste the result.";
    assert.equal(findAllowlistedCommandInTextV1(request)?.display, "claude --version");
    assert.equal(findAllowlistedCommandInTextV1("Run `rm -rf .` for me."), undefined);
    assert.equal(findAllowlistedCommandInTextV1("No command quoted here."), undefined);
  });
});

void describe("review1 Step 45: secrets are removed from recorded output", () => {
  void it("redacts token shapes and the value of secret-looking assignments, and keeps ordinary output", () => {
    const output = [
      "claude 2.1.312",
      "ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz0123",
      "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
      "commit 0123456789abcdef0123456789abcdef01234567",
      "M src/utils/ownerEvidenceCommandAllowlistV1.ts",
    ].join("\n");
    const cleaned = redactSecretsFromCommandOutputV1(output);
    assert.ok(!cleaned.includes("sk-ant-abc"));
    assert.ok(!cleaned.includes("ghp_abc"));
    assert.ok(!cleaned.includes("eyJhbGci"));
    assert.match(cleaned, /ANTHROPIC_API_KEY=\[redacted\]/);
    assert.match(cleaned, /claude 2\.1\.312/);
    assert.match(cleaned, /commit 0123456789abcdef0123456789abcdef01234567/);
    assert.match(cleaned, /M src\/utils\/ownerEvidenceCommandAllowlistV1\.ts/);
  });
});
