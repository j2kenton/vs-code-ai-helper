import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  applyManagedMetaGitIgnoreBlock,
  buildLegacyMetaRootIgnorePatterns,
  buildManagedIgnorePatterns,
  isManagedMetaGitIgnoreHidden,
} from "../commands/toggleMetaResourcesGitIgnore";

function readPackageJson(): {
  contributes?: {
    commands?: Array<{ command: string; title: string }>;
    menus?: { "view/title"?: Array<{ command: string; when?: string }> };
  };
} {
  return JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")
  ) as {
    contributes?: {
      commands?: Array<{ command: string; title: string }>;
      menus?: { "view/title"?: Array<{ command: string; when?: string }> };
    };
  };
}

void describe("managed meta gitignore block", () => {
  void it("adds a helper-owned block without rewriting user-authored rules", () => {
    const original = ["node_modules/", ".env", ""].join("\n");
    const next = applyManagedMetaGitIgnoreBlock(
      original,
      ["/plans/2026-07-09_task_5/"],
      true
    );

    assert.match(next, /^node_modules\/\n\.env\n\n# BEGIN Ensemble managed meta resources/m);
    assert.match(next, /\/plans\/2026-07-09_task_5\//);
    assert.match(next, /# END Ensemble managed meta resources\n$/);
    assert.equal(next.includes("node_modules/"), true);
    assert.equal(next.includes(".env"), true);
  });

  void it("removes only the helper-owned block", () => {
    const hidden = [
      "*.log",
      "",
      "# BEGIN Ensemble managed meta resources",
      "# Managed by Ensemble. Do not edit this block manually.",
      "/plans/2026-07-09_task_5/",
      "# END Ensemble managed meta resources",
      "",
    ].join("\n");

    const next = applyManagedMetaGitIgnoreBlock(
      hidden,
      ["/plans/2026-07-09_task_5/"],
      false
    );

    assert.equal(next, "*.log\n");
  });

  void it("removes legacy whole-root ignore entries when adding the managed block", () => {
    const original = [
      "dist/",
      "",
      "# Ensemble meta resources",
      "/.helper/plans",
      "",
    ].join("\n");

    const next = applyManagedMetaGitIgnoreBlock(
      original,
      ["/.helper/plans/task-a/", "/plans/task-a/"],
      true,
      { legacyRootPatterns: ["/.helper/plans", "/.helper/plans/"] }
    );

    assert.equal(next.includes("# Ensemble meta resources"), false);
    assert.equal(next.includes("/.helper/plans\n"), false);
    assert.match(next, /# BEGIN Ensemble managed meta resources/);
    assert.match(next, /\/\.helper\/plans\/task-a\//);
  });

  void it("removes legacy whole-root ignore entries when showing meta files", () => {
    const original = [
      "dist/",
      "",
      "# Ensemble meta resources",
      "/.helper/plans",
      "",
    ].join("\n");

    const next = applyManagedMetaGitIgnoreBlock(
      original,
      ["/.helper/plans/task-a/"],
      false,
      { legacyRootPatterns: ["/.helper/plans", "/.helper/plans/"] }
    );

    assert.equal(next, "dist/\n");
  });

  void it("leaves content unchanged when showing without a managed block", () => {
    const original = "*.log\n\n";

    assert.equal(
      applyManagedMetaGitIgnoreBlock(
        original,
        ["/plans/2026-07-09_task_5/"],
        false
      ),
      original
    );
  });

  void it("preserves CRLF when updating .gitignore", () => {
    const next = applyManagedMetaGitIgnoreBlock(
      "dist/\r\n",
      ["/.helper/plans/task-a/"],
      true
    );

    assert.equal(next.includes("\r\n# BEGIN Ensemble managed meta resources\r\n"), true);
    assert.equal(next.endsWith("\r\n"), true);
  });

  void it("detects whether the managed block hides the current task", () => {
    const content = applyManagedMetaGitIgnoreBlock(
      "",
      ["/.helper/plans/task-a/", "/plans/task-a/"],
      true
    );

    assert.equal(
      isManagedMetaGitIgnoreHidden(content, [
        "/.helper/plans/task-a/",
        "/plans/task-a/",
      ]),
      true
    );
    assert.equal(
      isManagedMetaGitIgnoreHidden(content, ["/.helper/plans/task-b/"]),
      false
    );
  });

  void it("detects old Ensemble root entries as hidden for compatibility", () => {
    const content = [
      "dist/",
      "",
      "# Ensemble meta resources",
      "/.helper/plans",
      "",
    ].join("\n");

    assert.equal(
      isManagedMetaGitIgnoreHidden(content, ["/.helper/plans/task-a/"], {
        legacyRootPatterns: ["/.helper/plans", "/.helper/plans/"],
      }),
      true
    );
  });

  void it("ignores malformed managed blocks without an end marker", () => {
    const malformed = [
      "# BEGIN Ensemble managed meta resources",
      "# Managed by Ensemble. Do not edit this block manually.",
      "/plans/task-a/",
      "",
    ].join("\n");

    assert.equal(
      isManagedMetaGitIgnoreHidden(malformed, ["/plans/task-a/"]),
      false
    );
    assert.equal(
      applyManagedMetaGitIgnoreBlock(malformed, ["/plans/task-a/"], false),
      malformed
    );
  });

  void it("builds current-task and legacy task-root patterns", () => {
    const repoRoot = path.resolve("repo-root");
    const taskFolder = path.join(repoRoot, ".helper", "plans", "task-a");
    const configuredRoot = path.join(repoRoot, ".helper", "plans");

    assert.deepEqual(
      buildManagedIgnorePatterns(repoRoot, taskFolder, configuredRoot),
      ["/.helper/plans/task-a/", "/plans/task-a/"]
    );
  });

  void it("builds legacy root variants for cleanup", () => {
    const repoRoot = path.resolve("repo-root");
    const configuredRoot = path.join(repoRoot, ".helper", "plans");

    assert.deepEqual(
      buildLegacyMetaRootIgnorePatterns(repoRoot, configuredRoot),
      ["/.helper/plans", "/.helper/plans/", "/plans", "/plans/"]
    );
  });
});

void describe("meta gitignore command contributions", () => {
  void it("declares explicit hide/show commands", () => {
    const commands = readPackageJson().contributes?.commands ?? [];

    assert.ok(
      commands.some(
        (entry) =>
          entry.command === "vs-code-ai-helper.hideMetaResourcesInGitIgnore" &&
          entry.title === "Hide Current Task Meta Files"
      )
    );
    assert.ok(
      commands.some(
        (entry) =>
          entry.command === "vs-code-ai-helper.showMetaResourcesInGitIgnore" &&
          entry.title === "Show Current Task Meta Files"
      )
    );
  });

  void it("shows exactly one header action based on managed current-task state", () => {
    const titleMenus = readPackageJson().contributes?.menus?.["view/title"] ?? [];
    const hideEntry = titleMenus.find(
      (entry) => entry.command === "vs-code-ai-helper.hideMetaResourcesInGitIgnore"
    );
    const showEntry = titleMenus.find(
      (entry) => entry.command === "vs-code-ai-helper.showMetaResourcesInGitIgnore"
    );

    assert.ok(hideEntry, "Expected Hide Current Task Meta Files header action");
    assert.ok(showEntry, "Expected Show Current Task Meta Files header action");
    assert.match(hideEntry.when ?? "", /metaGitIgnoreEligible/);
    assert.match(hideEntry.when ?? "", /!vs-code-ai-helper\.currentTaskMetaHidden/);
    assert.match(showEntry.when ?? "", /metaGitIgnoreEligible/);
    assert.match(showEntry.when ?? "", /vs-code-ai-helper\.currentTaskMetaHidden/);
  });
});
