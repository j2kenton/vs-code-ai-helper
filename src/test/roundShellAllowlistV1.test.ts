/**
 * The shell commands an editing round may run without approval: the
 * project's own checks only (roundShellAllowlistV1.ts).
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

function projectWith(scripts: Record<string, string> | undefined): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-shell-allowlist-"));
  roots.push(root);
  if (scripts) {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "p", scripts }), "utf8");
  }
  return root;
}

void describe("resolveRoundShellCommandsV1", () => {
  void it("allows the detected package checks", () => {
    const commands = resolveRoundShellCommandsV1(projectWith({ lint: "eslint .", test: "node --test", build: "tsc" }));
    assert.ok(commands.some((c) => / run lint$/.test(c)), commands.join(" | "));
    assert.ok(commands.some((c) => / run test$/.test(c)), commands.join(" | "));
  });

  void it("never allows a deploy-style script that is not a check", () => {
    const commands = resolveRoundShellCommandsV1(projectWith({ test: "node --test", deploy: "node scripts/deploy.mjs" }));
    assert.ok(!commands.some((c) => /deploy/.test(c)), commands.join(" | "));
  });

  void it("never lists git, so no rule can approve git diff --output or an external diff helper", () => {
    for (const scripts of [{ test: "node --test" }, undefined]) {
      const commands = resolveRoundShellCommandsV1(projectWith(scripts));
      assert.ok(!commands.some((c) => /^git(\s|$)/.test(c)), commands.join(" | "));
      const rules = claudeAllowedToolsValueV1(commands);
      assert.doesNotMatch(rules, /Bash\(git/);
    }
  });

  void it("without a package.json, allows nothing but check scripts", () => {
    for (const command of resolveRoundShellCommandsV1(projectWith(undefined))) {
      assert.match(command, / run (lint|check-types|test|build)$/);
    }
  });
});
