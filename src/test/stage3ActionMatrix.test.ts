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
  keybindings?: KeybindingContribution[];
  menus?: {
    "view/item/context"?: MenuContribution[];
  };
};

type KeybindingContribution = {
  command: string;
  key: string;
  when?: string;
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
    // Final-stage control: the user settled on plain "Complete Task" for the
    // Publish row's completion button.
    assert.equal(markTaskDone.title, "Complete Task");
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

  void it("binds Ctrl+Shift+Alt+I to applyCurrentStageAction for every stage, with no competing binding", () => {
    const contributes = readPackageContributes();
    const keybindings = contributes.keybindings ?? [];
    const implementationBinding = keybindings.find(
      (entry) => entry.command === "vs-code-ai-helper.applyCurrentStageAction"
    );
    const competingBindings = keybindings.filter(
      (entry) => entry.key === "ctrl+shift+alt+i" && entry.command !== "vs-code-ai-helper.applyCurrentStageAction"
    );

    assert.equal(implementationBinding?.key, "ctrl+shift+alt+i");
    // No stage gate: applyCurrentStageAction re-derives the live stage itself
    // and routes accordingly (including to runLintingFixes on Publish), so
    // gating the keybinding on a specific stage only breaks it on every
    // other stage.
    assert.equal(implementationBinding?.when, "vs-code-ai-helper.tasksInitialized");
    assert.deepEqual(
      competingBindings,
      [],
      "No other command should claim Ctrl+Shift+Alt+I; runLintingFixes is reached via applyCurrentStageAction's routing, not its own binding."
    );
  });

  void it("routes the current implementation task by folder path, never through a picker", () => {
    const routerSource = readWorkspaceFile(
      path.join("src", "commands", "applyCurrentStageAction.ts")
    );
    const implementationSource = readWorkspaceFile(
      path.join("src", "commands", "reviewActions.ts")
    );

    assert.match(
      routerSource,
      /runImplementationWithAI[\s\S]*?return;/,
      "The current-stage router must dispatch the implementation command."
    );
    assert.match(
      implementationSource,
      /export async function runImplementationWithAI\([\s\S]*?normalizeReviewArg\(arg\)[\s\S]*?IMPLEMENTATION_ELIGIBLE_STAGES/,
      "The implementation command must normalize its explicit taskFolderPath before task discovery."
    );
  });

  void it("uses the same free-form task-entry guidance in packaged and fallback templates", () => {
    const expected =
      "# Instructions\n\nDescribe the work you want to do here in as much detail as is useful. When\nyou're ready, use **Draft with AI** to turn these notes into a structured task\ndescription. Questions from the stage AI appear in the **Chat With AI** panel.\n\n# User's Description of the Task\n" +
      "\n".repeat(10);
    const packagedTemplate = readWorkspaceFile(
      path.join("resources", "prompts", "task-template.md")
    ).replace(/\r\n/g, "\n");
    assert.equal(packagedTemplate, expected);
    assert.match(
      readWorkspaceFile(path.join("src", "commands", "startNewTask.ts")),
      /return "# Instructions\\n\\nDescribe the work you want to do here/
    );
  });

  void it("declares Draft with AI menu for current desc stage row", () => {
    const contributes = readPackageContributes();
    const contextMenus = contributes.menus?.["view/item/context"] ?? [];

    const draftEntry = contextMenus.find(
      (entry) =>
        entry.command === "vs-code-ai-helper.draftTaskWithAI" &&
        (entry.when ?? "").includes("viewItem =~ /^stage-desc-current/")
    );

    assert.ok(
      draftEntry,
      "Expected draftTaskWithAI menu entry for stage-desc-current"
    );
  });

  void it("declares Generate Plan menu for current plan stage row", () => {
    const contributes = readPackageContributes();
    const contextMenus = contributes.menus?.["view/item/context"] ?? [];

    const generateEntry = contextMenus.find(
      (entry) =>
        entry.command === "vs-code-ai-helper.generatePlanWithAI" &&
        (entry.when ?? "").includes("viewItem =~ /^stage-plan-current/")
    );

    assert.ok(
      generateEntry,
      "Expected generatePlanWithAI menu entry for stage-plan-current"
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

  void it("gives every Publish action a distinct, explicit inline order", () => {
    const contributes = readPackageContributes();
    const contextMenus = contributes.menus?.["view/item/context"] ?? [];
    const publishActionCommands = new Set([
      "vs-code-ai-helper.runReviewWithAI",
      "vs-code-ai-helper.runLintingFixes",
      "vs-code-ai-helper.viewStageChanges",
      "vs-code-ai-helper.chatWithStage",
      "vs-code-ai-helper.commitAndPushTask",
      "vs-code-ai-helper.release",
      "vs-code-ai-helper.markTaskDone",
    ]);
    const publishActions = contextMenus.filter((entry) =>
      publishActionCommands.has(entry.command) &&
      (entry.when ?? "").includes("&& viewItem =~ /^stage-publish-current/ &&")
    );
    const groups = publishActions.map(entry => entry.group);

    assert.deepEqual(groups, [
      "inline@10",
      "inline@20",
      "inline@30",
      "inline@40",
      "inline@50",
      "inline@60",
      "inline@70",
    ]);
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
