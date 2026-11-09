/**
 * run1 Step 14: an editing round is pre-approved to run no checks at all
 * (roundShellAllowlistV1.ts). Its allowed tools and its prompt say the same thing.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { resolveRoundShellCommandsV1 } from "../utils/roundShellAllowlistV1";
import { claudeAllowedToolsValueV1 } from "../runners/providers";
import { safeRemoveDir } from "./testFsUtils";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    safeRemoveDir(root);
  }
});

function projectWith(scripts: Record<string, string> | undefined, extra: Record<string, unknown> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-shell-allowlist-"));
  roots.push(root);
  if (scripts) {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "p", scripts, ...extra }), "utf8");
  }
  return root;
}

const CHECK_WORDS = /\b(verify|test|lint|check-types|build)\b/;

void describe("resolveRoundShellCommandsV1 (run1 Step 14: rounds run no checks)", () => {
  void it("allows no check, lint, test, build or verify command when the project has detectable checks", () => {
    const commands = resolveRoundShellCommandsV1(
      projectWith({ lint: "eslint .", test: "node --test", build: "tsc", verify: "pnpm run lint && pnpm run test", "check-types": "tsc --noEmit" })
    );
    assert.deepEqual(commands, []);
  });

  void it("allows none when the Publish commands are configured explicitly either", () => {
    const root = projectWith({ test: "node --test" });
    fs.mkdirSync(path.join(root, ".vscode"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".vscode", "settings.json"),
      JSON.stringify({ "ensemble.publishVerificationCommands": ["pnpm run verify", "pnpm run test"] }),
      "utf8"
    );
    const commands = resolveRoundShellCommandsV1(root);
    assert.ok(!commands.some((command) => CHECK_WORDS.test(command)), commands.join(" | "));
  });

  void it("allows nothing without a package.json", () => {
    assert.deepEqual(resolveRoundShellCommandsV1(projectWith(undefined)), []);
  });

  void it("never lists git, so no rule can approve git diff --output or an external diff helper", () => {
    for (const scripts of [{ test: "node --test" }, undefined]) {
      const commands = resolveRoundShellCommandsV1(projectWith(scripts));
      assert.ok(!commands.some((c) => /^git(\s|$)/.test(c)), commands.join(" | "));
      assert.doesNotMatch(claudeAllowedToolsValueV1(commands), /Bash\(git/);
    }
  });
});

void describe("the implementation prompts tell a round the same thing (run1 Step 14)", () => {
  for (const name of ["run-implementation.md", "apply-impl-review-code.md"]) {
    void it(`${name} says not to run the type check, lint, the tests or verify`, () => {
      const prompt = fs.readFileSync(path.resolve(__dirname, "../../resources/prompts", name), "utf8");
      assert.match(prompt, /Don't run the type check, lint, the tests or `verify`/);
      assert.doesNotMatch(prompt, /run only the tests that cover the files you changed/);
    });
  }
});
