import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  bashRuleAllowsCommandV1,
  formatAllowedTestCommandGuidanceV1,
  readProjectBashAllowRulesV1,
  resolveAllowedTargetedTestCommandV1,
} from "../utils/allowedTestCommandV1";

// bugs4 item 16: the round prompt names the project's allowed way to run specific tests,
// chosen read-only from package.json and the project's own allow rules.

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "allowed-test-command-"));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

const ALLOW = JSON.stringify({ permissions: { allow: ["Bash(pnpm run *)", "Bash(node --test *)", "Read(*)"] } });

void describe("resolveAllowedTargetedTestCommandV1 (bugs4 item 16)", () => {
  void it("for this repository's shape it names `pnpm run test:unit -- <test files>`, allowed by the project's rules", () => {
    const root = project({
      "package.json": JSON.stringify({ scripts: { "test:unit": "node test-stubs/run-unit-tests.js", test: "turbo run test" } }),
      "pnpm-lock.yaml": "",
      ".claude/settings.local.json": ALLOW,
    });
    assert.deepEqual(resolveAllowedTargetedTestCommandV1(root), {
      template: "pnpm run test:unit -- <test files>",
      allowedByProjectRules: true,
    });
    const sentence = formatAllowedTestCommandGuidanceV1(root);
    assert.match(sentence, /`pnpm run test:unit -- <test files>`/);
    assert.match(sentence, /already permit it/);
    assert.match(sentence, /passed and failed counts under `## Verification`/);
  });

  void it("when no allow rule covers the script it says so and tells the round to report a refusal, not try another spelling", () => {
    const root = project({
      "package.json": JSON.stringify({ scripts: { "test:unit": "x" } }),
      ".claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash(git status *)"] } }),
    });
    const command = resolveAllowedTargetedTestCommandV1(root);
    assert.equal(command?.template, "npm run test:unit -- <test files>");
    assert.equal(command?.allowedByProjectRules, false);
    assert.match(formatAllowedTestCommandGuidanceV1(root), /report it as refused rather than trying another spelling/);
  });

  void it("a project with no targeted script gets no sentence, so a prompt never names a command that does not exist", () => {
    const root = project({ "package.json": JSON.stringify({ scripts: { test: "x" } }) });
    assert.equal(resolveAllowedTargetedTestCommandV1(root), undefined);
    assert.equal(formatAllowedTestCommandGuidanceV1(root), "");
    assert.equal(formatAllowedTestCommandGuidanceV1(path.join(root, "missing")), "");
  });

  void it("malformed or absent settings and package files never throw", () => {
    const root = project({ "package.json": "{not json", ".claude/settings.local.json": "[]" });
    assert.equal(resolveAllowedTargetedTestCommandV1(root), undefined);
    assert.deepEqual(readProjectBashAllowRulesV1(root), []);
  });

  void it("reads only Bash rules from both settings files", () => {
    const root = project({
      ".claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash(npx tsc *)", "Read(*)"] } }),
      ".claude/settings.local.json": ALLOW,
    });
    assert.deepEqual(readProjectBashAllowRulesV1(root), ["npx tsc *", "pnpm run *", "node --test *"]);
  });

  void it("rule matching: wildcard prefix, colon wildcard, and exact", () => {
    assert.equal(bashRuleAllowsCommandV1("pnpm run *", "pnpm run test:unit"), true);
    assert.equal(bashRuleAllowsCommandV1("pnpm run:*", "pnpm run test:unit"), true);
    assert.equal(bashRuleAllowsCommandV1("pnpm run test:unit", "pnpm run test:unit"), true);
    assert.equal(bashRuleAllowsCommandV1("node --test *", "pnpm run test:unit"), false);
  });

  void it("resolving reads only: the project's permission files are byte-for-byte unchanged", () => {
    const root = project({
      "package.json": JSON.stringify({ scripts: { "test:unit": "x" } }),
      ".claude/settings.local.json": ALLOW,
    });
    const before = fs.readFileSync(path.join(root, ".claude", "settings.local.json"), "utf8");
    formatAllowedTestCommandGuidanceV1(root);
    assert.equal(fs.readFileSync(path.join(root, ".claude", "settings.local.json"), "utf8"), before);
    assert.deepEqual(fs.readdirSync(path.join(root, ".claude")), ["settings.local.json"]);
  });
});

void describe("no extension code writes a permission file (bugs4 item 16)", () => {
  void it("no source file writes to .claude/settings*", () => {
    const srcRoot = path.join(process.cwd(), "src");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "test") walk(full);
        } else if (entry.name.endsWith(".ts")) {
          const text = fs.readFileSync(full, "utf8");
          const mentionsSettings = /\.claude[/\\'"]+\s*,?\s*['"]?settings|\.claude\/settings/.test(text);
          const writes = /(?:writeFile|writeFileSync|appendFile|appendFileSync|writeAtomic|patchJson)\w*\(/.test(text);
          if (mentionsSettings && writes) offenders.push(path.relative(srcRoot, full));
        }
      }
    };
    walk(srcRoot);
    // The read-only resolver is the only module allowed to name those paths, and it never writes.
    assert.deepEqual(offenders, []);
  });
});
