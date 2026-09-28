/**
 * 1.0 item 13: no two inline buttons on the Publish row share an icon. The
 * checks and the review both used `$(law)`, so the two looked like the same
 * button. Reads the shipped manifest, so a later contribution that reuses an
 * icon on that row fails here.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

interface ManifestV1 {
  contributes: {
    commands: { command: string; icon?: string }[];
    menus: Record<string, { command: string; when?: string; group?: string }[]>;
  };
}

void describe("Publish row inline buttons", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")
  ) as ManifestV1;
  const iconOf = new Map(manifest.contributes.commands.map((c) => [c.command, c.icon]));
  const publishInline = (manifest.contributes.menus["view/item/context"] ?? []).filter(
    (entry) => entry.group?.startsWith("inline") && entry.when?.includes("stage-publish-current")
  );

  void it("offers one Check and review button instead of separate checks and review buttons", () => {
    const commands = publishInline.map((entry) => entry.command);
    assert.ok(commands.includes("vs-code-ai-helper.checkAndReviewPublish"));
    assert.ok(!commands.includes("vs-code-ai-helper.runPublishChecks"));
    assert.ok(!commands.includes("vs-code-ai-helper.runReviewWithAI"));
  });

  void it("keeps the separate checks and review commands reachable from the row's context menu and palette", () => {
    const menu = manifest.contributes.menus["view/item/context"] ?? [];
    for (const command of ["vs-code-ai-helper.runPublishChecks", "vs-code-ai-helper.runReviewWithAI"]) {
      assert.ok(
        menu.some(
          (entry) =>
            entry.command === command &&
            entry.when?.includes("stage-publish-current") &&
            !entry.group?.startsWith("inline")
        ),
        `${command} is no longer offered on the Publish row`
      );
      assert.ok(iconOf.has(command));
    }
  });

  void it("shows Fix Linting only when the checks failed", () => {
    const fix = publishInline.filter((entry) => entry.command === "vs-code-ai-helper.runLintingFixes");
    assert.ok(fix.length > 0);
    for (const entry of fix) {
      assert.ok(entry.when?.includes("-lint-failed"), `Fix Linting is shown without a failed-checks condition: ${entry.when}`);
    }
  });

  void it("gives every inline button its own icon", () => {
    const seen = new Map<string, string>();
    for (const entry of publishInline) {
      // The same command listed twice (different `when` clauses) is one button.
      if ([...seen.values()].includes(entry.command)) {
        continue;
      }
      const icon = iconOf.get(entry.command);
      assert.ok(icon, `${entry.command} has no icon`);
      const other = seen.get(icon);
      assert.equal(other, undefined, `${entry.command} and ${other} share ${icon}`);
      seen.set(icon, entry.command);
    }
  });
});
