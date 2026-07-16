import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  applyManagedMetaGitIgnoreBlock,
  buildLegacyMetaRootIgnorePatterns,
  buildManagedIgnorePatterns,
  diffGitignoreLines,
  hideMetaResourcesInGitIgnore,
  isManagedMetaGitIgnoreHidden,
  showMetaResourcesInGitIgnore,
} from "../commands/toggleMetaResourcesGitIgnore";
import {
  deactivateNotificationRouter,
  initNotificationRouter,
} from "../utils/notificationRouter";
import { StatusTreeProvider } from "../views/statusView";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";

function git(cwd: string, args: string[]): void {
  cp.execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true });
}

function makeGitFixture(): string {
  const repoRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "ensemble-meta-gitignore-")
  );
  git(repoRoot, ["init"]);
  git(repoRoot, [
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "user.name=Test",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  ]);
  return repoRoot;
}

function installConfigStub(): { restore: () => void } {
  const original = (vscode.workspace as unknown as Record<string, unknown>)
    .getConfiguration;
  (vscode.workspace as unknown as Record<string, unknown>).getConfiguration =
    (): {
      get: (key: string, defaultValue?: unknown) => unknown;
      update: () => Promise<void>;
      inspect: () => undefined;
    } => ({
      get: (_key: string, defaultValue?: unknown): unknown => defaultValue,
      update: async (): Promise<void> => {},
      inspect: () => undefined,
    });
  return {
    restore: (): void => {
      (
        vscode.workspace as unknown as Record<string, unknown>
      ).getConfiguration = original;
    },
  };
}

function readPackageJson(): {
  contributes?: {
    commands?: Array<{ command: string; title: string }>;
    keybindings?: Array<{ command: string; key: string; mac?: string }>;
    menus?: { "view/title"?: Array<{ command: string; when?: string }> };
  };
} {
  return JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")
  ) as {
    contributes?: {
      commands?: Array<{ command: string; title: string }>;
      keybindings?: Array<{ command: string; key: string; mac?: string }>;
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

  void it("keeps transcript patterns present when hiding (persistentPatterns merged with root patterns)", () => {
    const content = applyManagedMetaGitIgnoreBlock(
      "",
      ["/plans/"],
      true,
      { persistentPatterns: ["/plans/**/chat-v1.json", "/plans/**/chat-v1.corrupt.json"] }
    );

    assert.match(content, /\/plans\/\*\*\/chat-v1\.json/);
    assert.match(content, /\/plans\/\*\*\/chat-v1\.corrupt\.json/);
    assert.match(content, /\/plans\//);
  });

  void it("replaces the block with a transcripts-only block on show, instead of removing it (Option A)", () => {
    const hidden = applyManagedMetaGitIgnoreBlock(
      "",
      ["/plans/"],
      true,
      { persistentPatterns: ["/plans/**/chat-v1.json", "/plans/**/chat-v1.corrupt.json"] }
    );

    const shown = applyManagedMetaGitIgnoreBlock(
      hidden,
      ["/plans/"],
      false,
      { persistentPatterns: ["/plans/**/chat-v1.json", "/plans/**/chat-v1.corrupt.json"] }
    );

    assert.match(shown, /# BEGIN Ensemble managed meta resources/, "the block must survive Show Meta Files");
    assert.match(shown, /\/plans\/\*\*\/chat-v1\.json/);
    assert.match(shown, /\/plans\/\*\*\/chat-v1\.corrupt\.json/);
    const lines = shown.split(/\r?\n/).map((line) => line.trim());
    assert.equal(lines.includes("/plans/"), false, "the root folder pattern itself must be gone once shown");
  });

  void it("isManagedMetaGitIgnoreHidden reports NOT hidden once shown, even though a transcripts-only block remains", () => {
    const hidden = applyManagedMetaGitIgnoreBlock(
      "",
      ["/plans/"],
      true,
      { persistentPatterns: ["/plans/**/chat-v1.json"] }
    );
    assert.equal(isManagedMetaGitIgnoreHidden(hidden, ["/plans/"]), true);

    const shown = applyManagedMetaGitIgnoreBlock(
      hidden,
      ["/plans/"],
      false,
      { persistentPatterns: ["/plans/**/chat-v1.json"] }
    );
    assert.equal(
      isManagedMetaGitIgnoreHidden(shown, ["/plans/"]),
      false,
      "hidden-detection keys on the root pattern, which is absent from a transcripts-only block"
    );
  });

  void it("removes the block entirely on show when there are no persistent patterns (unchanged default behavior)", () => {
    const hidden = applyManagedMetaGitIgnoreBlock("dist/\n", ["/plans/"], true);
    const shown = applyManagedMetaGitIgnoreBlock(hidden, ["/plans/"], false);
    assert.equal(shown, "dist/\n");
  });

  void it("builds legacy root variants for cleanup", () => {
    const repoRoot = path.resolve("repo-root");
    const configuredRoot = path.join(repoRoot, ".helper", "plans");

    assert.deepEqual(
      buildLegacyMetaRootIgnorePatterns(repoRoot, configuredRoot),
      [
        "/.helper/plans",
        "/.helper/plans/",
        "/artifacts/helper",
        "/artifacts/helper/",
        "/plans",
        "/plans/",
      ]
    );
  });
});

void describe("meta gitignore command contributions", () => {
  void it("declares the commit/push and next-stage shortcuts", () => {
    const keybindings = readPackageJson().contributes?.keybindings ?? [];
    const bindingFor = (command: string) =>
      keybindings.find((binding) => binding.command === command);

    assert.deepEqual(bindingFor("vs-code-ai-helper.commitAndPushTask"), {
      command: "vs-code-ai-helper.commitAndPushTask",
      key: "ctrl+shift+alt+p",
      mac: "cmd+shift+alt+p",
    });
    assert.deepEqual(bindingFor("vs-code-ai-helper.nextStage"), {
      command: "vs-code-ai-helper.nextStage",
      key: "ctrl+shift+alt+n",
      mac: "cmd+shift+alt+n",
    });
  });

  void it("keeps hide/show/toggle commands out of the command manifest (Settings owns confirmation)", () => {
    // These commands still exist and are still registered (settingsView.ts
    // invokes them programmatically), but they must not be reachable from
    // the Command Palette or any menu — every .gitignore write must go
    // through the confirmation flow, and the only caller that's supposed to
    // reach it is the Settings save handler.
    const commands = readPackageJson().contributes?.commands ?? [];

    for (const command of [
      "vs-code-ai-helper.hideMetaResourcesInGitIgnore",
      "vs-code-ai-helper.showMetaResourcesInGitIgnore",
      "vs-code-ai-helper.toggleMetaResourcesGitIgnore",
    ]) {
      assert.equal(
        commands.some((entry) => entry.command === command),
        false,
        `${command} must not be declared in contributes.commands`
      );
    }
  });

  void it("keeps Git-ignore actions out of the Tasks header and exposes settings there", () => {
    const titleMenus = readPackageJson().contributes?.menus?.["view/title"] ?? [];
    const hideEntry = titleMenus.find(
      (entry) => entry.command === "vs-code-ai-helper.hideMetaResourcesInGitIgnore"
    );
    const showEntry = titleMenus.find(
      (entry) => entry.command === "vs-code-ai-helper.showMetaResourcesInGitIgnore"
    );

    assert.equal(hideEntry, undefined);
    assert.equal(showEntry, undefined);
    assert.ok(titleMenus.some((entry) => entry.command === "vs-code-ai-helper.openSettings"));
  });
});

void describe("diffGitignoreLines", () => {
  void it("reports exactly the added lines when hiding meta files for the first time", () => {
    const current = ["node_modules/", ""].join("\n");
    const next = applyManagedMetaGitIgnoreBlock(current, ["/plans/task-a/"], true);

    const { added, removed } = diffGitignoreLines(current, next);
    assert.equal(removed.length, 0);
    assert.deepEqual(added, [
      "# BEGIN Ensemble managed meta resources",
      "# Managed by Ensemble. Do not edit this block manually.",
      "/plans/task-a/",
      "# END Ensemble managed meta resources",
    ]);
  });

  void it("reports no diff when the content is unchanged", () => {
    assert.deepEqual(diffGitignoreLines("dist/\n", "dist/\n"), {
      added: [],
      removed: [],
    });
  });
});

void describe("gitignore writes require confirmation with an exact diff", () => {
  void it("does not touch .gitignore when the user declines the confirmation", async () => {
    const repoRoot = makeGitFixture();
    const configStub = installConfigStub();
    const surface = new StatusTreeProvider();
    initNotificationRouter(surface);

    const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
    const originalShowWarningMessage = vscode.window.showWarningMessage;
    (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: vscode.Uri.file(repoRoot), name: "repo", index: 0 },
    ];

    let promptedDetail: string | undefined;
    (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage =
      (
        _message: string,
        options: { detail?: string },
        ..._actions: string[]
      ): Promise<string | undefined> => {
        promptedDetail = options.detail;
        return Promise.resolve(undefined); // user dismisses/declines
      };

    try {
      const applied = await hideMetaResourcesInGitIgnore(
        {} as TaskInventory,
        {} as CurrentTaskStore
      );

      assert.equal(applied, false);
      assert.ok(promptedDetail?.includes("BEGIN Ensemble managed meta resources"));
      assert.equal(
        fs.existsSync(path.join(repoRoot, ".gitignore")),
        false,
        "declining the confirmation must leave .gitignore untouched"
      );
    } finally {
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders =
        originalWorkspaceFolders;
      (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage =
        originalShowWarningMessage;
      deactivateNotificationRouter();
      configStub.restore();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  void it("writes .gitignore once the user confirms", async () => {
    const repoRoot = makeGitFixture();
    const configStub = installConfigStub();
    const surface = new StatusTreeProvider();
    initNotificationRouter(surface);

    const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
    const originalShowWarningMessage = vscode.window.showWarningMessage;
    const originalWriteFile = (
      vscode.workspace.fs as unknown as { writeFile: unknown }
    ).writeFile;
    (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: vscode.Uri.file(repoRoot), name: "repo", index: 0 },
    ];
    (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage =
      (
        _message: string,
        _options: { detail?: string },
        ...actions: string[]
      ): Promise<string | undefined> => Promise.resolve(actions[0]);
    (vscode.workspace.fs as unknown as { writeFile: unknown }).writeFile = (
      uri: vscode.Uri,
      bytes: Uint8Array
    ): Promise<void> => {
      fs.writeFileSync(uri.fsPath, Buffer.from(bytes));
      return Promise.resolve();
    };
    // setMetaVisibilityContexts fires the built-in "setContext" command as a
    // side effect once the write is confirmed; the stub throws on
    // unregistered commands, so no-op it for the duration of this test.
    const commandsStub = vscode.commands as typeof vscode.commands & {
      _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
    };
    const originalExecuteCommandOverride = commandsStub._executeCommandOverride;
    commandsStub._executeCommandOverride = () => Promise.resolve(undefined);

    try {
      const applied = await hideMetaResourcesInGitIgnore(
        {} as TaskInventory,
        {} as CurrentTaskStore
      );

      assert.equal(applied, true);
      const written = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
      assert.match(written, /# BEGIN Ensemble managed meta resources/);
    } finally {
      commandsStub._executeCommandOverride = originalExecuteCommandOverride;
      (vscode.workspace.fs as unknown as { writeFile: unknown }).writeFile =
        originalWriteFile;
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders =
        originalWorkspaceFolders;
      (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage =
        originalShowWarningMessage;
      deactivateNotificationRouter();
      configStub.restore();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  void it("does not duplicate the artifacts pattern when the configured task root resolves to the same path", async () => {
    const repoRoot = makeGitFixture();
    const surface = new StatusTreeProvider();
    initNotificationRouter(surface);

    // Configuring the task root to "artifacts/helper" makes it resolve to
    // the exact same repo-relative path as the fixed artifacts root, which
    // previously produced a managed block listing "/artifacts/helper/"
    // twice (reported by users as an unexplained duplicate entry).
    const originalGetConfiguration = (
      vscode.workspace as unknown as Record<string, unknown>
    ).getConfiguration;
    (vscode.workspace as unknown as Record<string, unknown>).getConfiguration =
      (): {
        get: (key: string, defaultValue?: unknown) => unknown;
        update: () => Promise<void>;
        inspect: () => undefined;
      } => ({
        get: (key: string, defaultValue?: unknown): unknown =>
          key === "metaResourcesPath" ? "artifacts/helper" : defaultValue,
        update: async (): Promise<void> => {},
        inspect: () => undefined,
      });

    const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
    const originalShowWarningMessage = vscode.window.showWarningMessage;
    const originalWriteFile = (
      vscode.workspace.fs as unknown as { writeFile: unknown }
    ).writeFile;
    (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: vscode.Uri.file(repoRoot), name: "repo", index: 0 },
    ];
    (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage =
      (
        _message: string,
        _options: { detail?: string },
        ...actions: string[]
      ): Promise<string | undefined> => Promise.resolve(actions[0]);
    (vscode.workspace.fs as unknown as { writeFile: unknown }).writeFile = (
      uri: vscode.Uri,
      bytes: Uint8Array
    ): Promise<void> => {
      fs.writeFileSync(uri.fsPath, Buffer.from(bytes));
      return Promise.resolve();
    };
    const commandsStub = vscode.commands as typeof vscode.commands & {
      _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
    };
    const originalExecuteCommandOverride = commandsStub._executeCommandOverride;
    commandsStub._executeCommandOverride = () => Promise.resolve(undefined);

    try {
      const applied = await hideMetaResourcesInGitIgnore(
        {} as TaskInventory,
        {} as CurrentTaskStore
      );

      assert.equal(applied, true);
      const written = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
      // Count exact standalone-line occurrences of the root pattern, not a
      // raw substring count: "/artifacts/helper/**/chat-v1.json" legitimately
      // contains "/artifacts/helper/" as a prefix without being a duplicate
      // of the root pattern itself.
      const lines = written.split(/\r?\n/).map((line) => line.trim());
      const occurrences = lines.filter((line) => line === "/artifacts/helper/").length;
      assert.equal(
        occurrences,
        1,
        `expected "/artifacts/helper/" to appear exactly once as its own line, got ${occurrences}:\n${written}`
      );
    } finally {
      commandsStub._executeCommandOverride = originalExecuteCommandOverride;
      (vscode.workspace.fs as unknown as { writeFile: unknown }).writeFile =
        originalWriteFile;
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders =
        originalWorkspaceFolders;
      (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage =
        originalShowWarningMessage;
      deactivateNotificationRouter();
      (vscode.workspace as unknown as Record<string, unknown>).getConfiguration =
        originalGetConfiguration;
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  void it("keeps chat-transcript patterns in .gitignore after hide then show (Option A end-to-end)", async () => {
    const repoRoot = makeGitFixture();
    const configStub = installConfigStub();
    const surface = new StatusTreeProvider();
    initNotificationRouter(surface);

    const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
    const originalShowWarningMessage = vscode.window.showWarningMessage;
    const originalWriteFile = (
      vscode.workspace.fs as unknown as { writeFile: unknown }
    ).writeFile;
    const originalReadFile = (
      vscode.workspace.fs as unknown as { readFile: unknown }
    ).readFile;
    (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: vscode.Uri.file(repoRoot), name: "repo", index: 0 },
    ];
    (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage =
      (
        _message: string,
        _options: { detail?: string },
        ...actions: string[]
      ): Promise<string | undefined> => Promise.resolve(actions[0]);
    (vscode.workspace.fs as unknown as { writeFile: unknown }).writeFile = (
      uri: vscode.Uri,
      bytes: Uint8Array
    ): Promise<void> => {
      fs.writeFileSync(uri.fsPath, Buffer.from(bytes));
      return Promise.resolve();
    };
    // The second call (show) must see the first call's (hide) write, so
    // readFile needs a real bridge too — unlike the other tests in this
    // file, which only ever write once and never need to read back a prior
    // write of their own.
    (vscode.workspace.fs as unknown as { readFile: unknown }).readFile = (
      uri: vscode.Uri
    ): Promise<Uint8Array> => fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
    const commandsStub = vscode.commands as typeof vscode.commands & {
      _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
    };
    const originalExecuteCommandOverride = commandsStub._executeCommandOverride;
    commandsStub._executeCommandOverride = () => Promise.resolve(undefined);

    try {
      const hideApplied = await hideMetaResourcesInGitIgnore(
        {} as TaskInventory,
        {} as CurrentTaskStore
      );
      assert.equal(hideApplied, true);
      const hiddenContent = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
      // The config stub returns the caller's own default for every key
      // (installConfigStub), so the task root here resolves to the real
      // built-in default (".ensemble"), not the legacy "/plans/".
      assert.match(hiddenContent, /\/\.ensemble\/\*\*\/chat-v1\.json/);
      assert.match(hiddenContent, /\/\.ensemble\/\*\*\/chat-v1\.corrupt\.json/);

      const showApplied = await showMetaResourcesInGitIgnore(
        {} as TaskInventory,
        {} as CurrentTaskStore
      );
      assert.equal(showApplied, true);
      const shownContent = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
      assert.match(
        shownContent,
        /\/\.ensemble\/\*\*\/chat-v1\.json/,
        "transcript patterns must survive Show Meta Files"
      );
      assert.match(shownContent, /\/\.ensemble\/\*\*\/chat-v1\.corrupt\.json/);
      const shownLines = shownContent.split(/\r?\n/).map((line) => line.trim());
      assert.equal(
        shownLines.includes("/.ensemble/"),
        false,
        "the root task-folder pattern itself must be gone once shown"
      );
    } finally {
      commandsStub._executeCommandOverride = originalExecuteCommandOverride;
      (vscode.workspace.fs as unknown as { writeFile: unknown }).writeFile =
        originalWriteFile;
      (vscode.workspace.fs as unknown as { readFile: unknown }).readFile =
        originalReadFile;
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders =
        originalWorkspaceFolders;
      (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage =
        originalShowWarningMessage;
      deactivateNotificationRouter();
      configStub.restore();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
