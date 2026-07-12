import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

type CommandContribution = {
  command: string;
  title: string;
};

type MenuContribution = {
  command: string;
  when?: string;
  group?: string;
};

type PackageContributes = {
  commands?: CommandContribution[];
  menus?: {
    "view/item/context"?: MenuContribution[];
  };
};

function readWorkspaceFile(relativePath: string): string {
  const workspaceRoot = process.cwd();
  const absolutePath = path.join(workspaceRoot, relativePath);
  return fs.readFileSync(absolutePath, "utf8");
}

function readPackageContributes(): PackageContributes {
  const packageJsonText = readWorkspaceFile("package.json");
  const packageJson = JSON.parse(packageJsonText) as {
    contributes?: PackageContributes;
  };
  return packageJson.contributes ?? {};
}

void describe("Stage 3 action matrix contracts", () => {
  void it("declares markTaskDone command in package contributions", () => {
    const contributes = readPackageContributes();
    const commands = contributes.commands ?? [];

    const markTaskDone = commands.find(
      (entry) => entry.command === "vs-code-ai-helper.markTaskDone"
    );

    assert.ok(markTaskDone, "Expected markTaskDone command contribution");
    assert.equal(markTaskDone.title, "Complete and Move On to Next Task");
  });

  void it("declares nextStage menu for current desc stage row", () => {
    const contributes = readPackageContributes();
    const contextMenus = contributes.menus?.["view/item/context"] ?? [];

    const nextStageEntry = contextMenus.find(
      (entry) =>
        entry.command === "vs-code-ai-helper.nextStage" &&
        (entry.when ?? "").includes("viewItem =~ /^stage-desc-current/")
    );

    assert.ok(
      nextStageEntry,
      "Expected nextStage menu entry for stage-desc-current"
    );
  });

  void it("declares markTaskDone menu for current Publish (completed) stage row", () => {
    const contributes = readPackageContributes();
    const contextMenus = contributes.menus?.["view/item/context"] ?? [];

    const markDoneEntry = contextMenus.find(
      (entry) =>
        entry.command === "vs-code-ai-helper.markTaskDone" &&
        (entry.when ?? "").includes("viewItem =~ /^stage-publish-current/")
    );

    assert.ok(
      markDoneEntry,
      "Expected markTaskDone menu entry for stage-publish-current"
    );
  });

  void it("declares nextStage menu for current impl-low-review stage row", () => {
    const contributes = readPackageContributes();
    const contextMenus = contributes.menus?.["view/item/context"] ?? [];

    const nextStageEntry = contextMenus.find(
      (entry) =>
        entry.command === "vs-code-ai-helper.nextStage" &&
        (entry.when ?? "").includes("viewItem =~ /^stage-impl-low-review-current/")
    );

    assert.ok(
      nextStageEntry,
      "Expected nextStage menu entry for stage-impl-low-review-current"
    );
  });

  void it("registers markTaskDone command in extension activation", () => {
    const extensionSource = readWorkspaceFile(path.join("src", "extension.ts"));

    assert.match(
      extensionSource,
      /import\s+\{\s*registerMarkTaskDoneCommand\s*\}\s+from\s+"\.\/commands\/markTaskDone";/
    );
    assert.match(
      extensionSource,
      /registerMarkTaskDoneCommand\(context,\s*inventory,\s*currentTaskStore\);/
    );
  });

  void it("maps impl-low-review current stage row to dedicated context value", () => {
    const providerSource = readWorkspaceFile(
      path.join("src", "utils", "contextTokens.ts")
    );

    assert.match(
      providerSource,
      /case\s+"impl-low-review":\s*[\s\S]*tokens\.push\("stage-impl-low-review-current"\);/
    );
  });

  void it("maps completed (Publish) current stage row to dedicated context value", () => {
    const providerSource = readWorkspaceFile(
      path.join("src", "utils", "contextTokens.ts")
    );

    assert.match(
      providerSource,
      /case\s+"publish":\s*[\s\S]*tokens\.push\("stage-publish-current"\);/
    );
  });
});
