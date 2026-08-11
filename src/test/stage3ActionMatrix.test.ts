import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

type CommandContribution = {
  command: string;
  title: string;
  icon?: string;
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
    // and routes accordingly (including to runPublishChecks on Publish), so
    // gating the keybinding on a specific stage only breaks it on every
    // other stage.
    assert.equal(implementationBinding?.when, "vs-code-ai-helper.tasksInitialized");
    assert.deepEqual(
      competingBindings,
      [],
      "No other command should claim Ctrl+Shift+Alt+I; runPublishChecks is reached via applyCurrentStageAction's routing, not its own binding."
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

  void it("uses the same canonical task document template in packaged and fallback templates", () => {
    const expected =
      "# Task\n\n## Task Description\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n## Draft with AI\n\n[Click the Draft with AI button, or press Ctrl+Shift+Alt+I]\n";
    const packagedTemplate = readWorkspaceFile(
      path.join("resources", "prompts", "task-template.md")
    ).replace(/\r\n/g, "\n");
    assert.equal(packagedTemplate, expected);
    assert.match(
      readWorkspaceFile(path.join("src", "commands", "startNewTask.ts")),
      /return "# Task\\n\\n## Task Description(?:\\n){16}## Draft with AI\\n\\n\[Click the Draft with AI button, or press Ctrl\+Shift\+Alt\+I\]\\n"/
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
      "vs-code-ai-helper.runPublishChecks",
      "vs-code-ai-helper.runLintingFixes",
      "vs-code-ai-helper.viewStageChanges",
      "vs-code-ai-helper.chatWithStage",
      "vs-code-ai-helper.commitAndPushTask",
      "vs-code-ai-helper.release",
      "vs-code-ai-helper.markTaskDone",
    ]);
    const publishActions = contextMenus.filter((entry) =>
      publishActionCommands.has(entry.command) &&
      (entry.when ?? "").includes("&& viewItem =~ /^stage-publish-current/")
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

  void it("makes 'run the checks' (scales icon) the first Publish action and 'fix the report' the second", () => {
    const contributes = readPackageContributes();
    const commands = contributes.commands ?? [];
    const contextMenus = contributes.menus?.["view/item/context"] ?? [];
    const publishInline = contextMenus.filter((entry) =>
      (entry.when ?? "").includes("&& viewItem =~ /^stage-publish-current/ &&")
    );

    const firstAction = publishInline.find((entry) => entry.group === "inline@10");
    assert.equal(
      firstAction?.command,
      "vs-code-ai-helper.runPublishChecks",
      "The first inline Publish action must run the checks and produce the report"
    );
    const secondAction = publishInline.find((entry) => entry.group === "inline@20");
    assert.equal(
      secondAction?.command,
      "vs-code-ai-helper.runLintingFixes",
      "The second inline Publish action must fix the report's findings"
    );

    const checksCommand = commands.find(
      (entry) => entry.command === "vs-code-ai-helper.runPublishChecks"
    );
    assert.equal(
      checksCommand?.icon,
      "$(law)",
      "The check-and-report action carries the scales icon"
    );
    const fixCommand = commands.find(
      (entry) => entry.command === "vs-code-ai-helper.runLintingFixes"
    );
    assert.equal(fixCommand?.icon, "$(wand)");
  });

  void it("separates Publish check and fix responsibilities in the command sources", () => {
    const checksSource = readWorkspaceFile(
      path.join("src", "commands", "runPublishChecks.ts")
    );
    assert.match(
      checksSource,
      /runCompletionLint\(\s*taskFolderUri/,
      "The first Publish action must run the completion checks (lint/tests + plan verification)"
    );
    assert.match(
      checksSource,
      /await ensureStageModelConfigured\(taskFolderUri, "publish"\)/,
      "The directly-invocable check action must carry the missing-model guard itself (the inline button bypasses applyCurrentStageAction)"
    );

    const fixesSource = readWorkspaceFile(
      path.join("src", "commands", "runLintingFixes.ts")
    );
    assert.match(
      fixesSource,
      /const lastReport = resolvedTask\.progress\.lintPayload;/,
      "The fix action must consume the persisted report from the first action, not run initial checks itself"
    );
    assert.match(
      fixesSource,
      /resolvePublishScopeFolder\(taskFolderUri, resolvedTask\.progress\)/,
      "Deterministic fixes and diagnostics must be limited to the resolved Publish verification scope, not the workspace root"
    );
    assert.match(
      fixesSource,
      /await ensureStageModelConfigured\(taskFolderUri, "publish"\)/,
      "The directly-invocable fix action must carry the missing-model guard before any mutation (the inline button bypasses applyCurrentStageAction)"
    );
    assert.ok(
      fixesSource.indexOf('await ensureStageModelConfigured(taskFolderUri, "publish")') <
        fixesSource.indexOf("runTrackedOperation("),
      "The fix action's model guard must run before the tracked operation so no autofix/format mutation happens without a usable Publish model"
    );
    assert.match(
      fixesSource,
      /resolveFreshModelForStage\(taskFolderUri, "publish"\)/,
      "The AI fix pass must run with the Publish-stage model"
    );
    assert.match(
      fixesSource,
      /stage: "publish",\s+taskStage: "publish",\s+taskFolderUri/,
      "The AI fix run must execute under the Publish stage, not Implementation"
    );

    const routerSource = readWorkspaceFile(
      path.join("src", "commands", "applyCurrentStageAction.ts")
    );
    assert.match(
      routerSource,
      /stage === "publish"[\s\S]{0,120}?runPublishChecks/,
      "The current-stage router must dispatch the Publish checks as the stage's primary action"
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
