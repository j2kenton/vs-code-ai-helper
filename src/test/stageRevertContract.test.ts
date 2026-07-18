/**
 * Contract coverage for the revert-availability surface: the stage context
 * value carries a has-backup token (kept before the trailing modelable token
 * so /-modelable$/ menu clauses keep matching), and the package.json menu
 * entries for Revert Changes / Delete Previous Version are gated on it.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildStageContextValue } from "../utils/contextTokens";

void test("has-backup token appears before the trailing modelable token", () => {
  const withBackup = buildStageContextValue({
    stage: "plan",
    status: "current",
    hasBackup: true,
  });
  assert.match(withBackup, /-has-backup/);
  assert.match(withBackup, /-modelable$/);

  const withoutBackup = buildStageContextValue({
    stage: "plan",
    status: "current",
  });
  assert.doesNotMatch(withoutBackup, /-has-backup/);
});

void test("revert and delete-backup menu entries require the has-backup token", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")
  ) as {
    contributes?: {
      menus?: Record<string, Array<{ command: string; when?: string }>>;
    };
  };
  const contextMenus = packageJson.contributes?.menus?.["view/item/context"] ?? [];
  const gatedCommands = [
    "vs-code-ai-helper.revertStageChanges",
    "vs-code-ai-helper.deleteStageBackup",
  ];
  for (const command of gatedCommands) {
    const entries = contextMenus.filter((entry) => entry.command === command);
    assert.ok(entries.length > 0, `Expected menu entries for ${command}`);
    for (const entry of entries) {
      assert.ok(
        (entry.when ?? "").includes("viewItem =~ /-has-backup/"),
        `${command} menu entry must be gated on the has-backup token: ${entry.when}`
      );
    }
  }
});

void test("the confirm-commit-message command is contributed", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")
  ) as { contributes?: { commands?: Array<{ command: string }> } };
  assert.ok(
    (packageJson.contributes?.commands ?? []).some(
      (entry) => entry.command === "vs-code-ai-helper.confirmCommitMessage"
    ),
    "Expected the vs-code-ai-helper.confirmCommitMessage command contribution"
  );
});
