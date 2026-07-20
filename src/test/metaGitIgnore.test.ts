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
  ensureAutomaticMetaGitIgnore,
  isManagedMetaGitIgnoreHidden,
} from "../commands/toggleMetaResourcesGitIgnore";

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

function installConfigStub(configuredTaskRoot?: string): { restore: () => void } {
  const original = (vscode.workspace as unknown as Record<string, unknown>)
    .getConfiguration;
  (vscode.workspace as unknown as Record<string, unknown>).getConfiguration =
    (): {
      get: (key: string, defaultValue?: unknown) => unknown;
      update: () => Promise<void>;
      inspect: () => undefined;
    } => ({
      get: (key: string, defaultValue?: unknown): unknown =>
        key === "metaResourcesPath" && configuredTaskRoot !== undefined
          ? configuredTaskRoot
          : defaultValue,
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

function installWorkspaceFoldersStub(...roots: string[]): {
  folders: vscode.WorkspaceFolder[];
  restore: () => void;
} {
  const target = vscode.workspace as unknown as Record<string, unknown>;
  const orig = target.workspaceFolders;
  const folders = roots.map((root, index) => ({
    uri: vscode.Uri.file(root),
    name: path.basename(root),
    index,
  }));
  target.workspaceFolders = folders;
  return { folders, restore: (): void => { target.workspaceFolders = orig; } };
}

/** Mirrors the gate-key normalization in ensureAutomaticMetaGitIgnore. */
function gateKeyFor(root: string): string {
  const normalized = path.normalize(vscode.Uri.file(root).fsPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function installWriteFileBridge(): { restore: () => void } {
  const fsTarget = vscode.workspace.fs as unknown as { writeFile: unknown };
  const original = fsTarget.writeFile;
  fsTarget.writeFile = (uri: vscode.Uri, bytes: Uint8Array): Promise<void> => {
    fs.writeFileSync(uri.fsPath, Buffer.from(bytes));
    return Promise.resolve();
  };
  return { restore: (): void => { fsTarget.writeFile = original; } };
}

function makeContext(): { context: vscode.ExtensionContext; state: Map<string, unknown> } {
  const state = new Map<string, unknown>();
  const workspaceState = {
    get: <T>(key: string, defaultValue?: T): T =>
      (state.has(key) ? (state.get(key) as T) : (defaultValue as T)),
    update: (key: string, value: unknown): Promise<void> => {
      if (value === undefined) state.delete(key);
      else state.set(key, value);
      return Promise.resolve();
    },
    keys: (): readonly string[] => [...state.keys()],
  };
  return {
    context: { workspaceState, subscriptions: [] } as unknown as vscode.ExtensionContext,
    state,
  };
}

function readPackageJson(): {
  contributes?: {
    commands?: Array<{ command: string; title: string }>;
    keybindings?: Array<{ command: string; key: string; mac?: string; when?: string }>;
    menus?: { "view/title"?: Array<{ command: string; when?: string }> };
  };
} {
  return JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")
  ) as {
    contributes?: {
      commands?: Array<{ command: string; title: string }>;
      keybindings?: Array<{ command: string; key: string; mac?: string; when?: string }>;
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

  void it("drops persistent transcript patterns already covered by a root pattern when hiding (no redundant nested entry)", () => {
    // Regression coverage for a review finding: /plans/**/chat-v1.json is
    // already ignored by /plans/ itself once the whole folder is hidden —
    // keeping both was confusing, redundant clutter in .gitignore.
    const content = applyManagedMetaGitIgnoreBlock(
      "",
      ["/plans/"],
      true,
      { persistentPatterns: ["/plans/**/chat-v1.json", "/plans/**/chat-v1.corrupt.json"] }
    );

    assert.doesNotMatch(content, /chat-v1/);
    assert.match(content, /\/plans\//);
  });

  void it("keeps a persistent transcript pattern when hiding if no root pattern already covers it", () => {
    const content = applyManagedMetaGitIgnoreBlock(
      "",
      ["/artifacts/helper/"],
      true,
      { persistentPatterns: ["/plans/**/chat-v1.json"] }
    );

    assert.match(content, /\/plans\/\*\*\/chat-v1\.json/, "an uncovered persistent pattern must still be written");
    assert.match(content, /\/artifacts\/helper\//);
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

    assert.match(shown, /# BEGIN Ensemble managed meta resources/, "the block must survive a show edit");
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

  void it("binds the open-task shortcut to Ctrl+Shift+O, scoped outside editor focus so it never shadows Go to Symbol", () => {
    const keybindings = readPackageJson().contributes?.keybindings ?? [];
    const bindingFor = (command: string) =>
      keybindings.find((binding) => binding.command === command);

    assert.deepEqual(bindingFor("vs-code-ai-helper.openAndStartNewTask"), {
      command: "vs-code-ai-helper.openAndStartNewTask",
      key: "ctrl+shift+o",
      mac: "cmd+shift+o",
      when: "!editorTextFocus",
    });

    // "N" is reserved for Next Stage — the open-task binding must never
    // reuse it, and must not collide with any other contributed shortcut.
    const openTaskKey = bindingFor("vs-code-ai-helper.openAndStartNewTask")?.key;
    const collisions = keybindings.filter(
      (binding) => binding.command !== "vs-code-ai-helper.openAndStartNewTask" && binding.key === openTaskKey
    );
    assert.deepEqual(collisions, [], `Ctrl+Shift+O must not collide with another contributed shortcut: ${JSON.stringify(collisions)}`);
  });

  void it("keeps the removed hide/show/toggle commands out of the command manifest", () => {
    // Git-ignore handling is fully automatic now (ensureAutomaticMetaGitIgnore);
    // the manual hide/show/toggle command pathway was removed outright, so the
    // manifest must not resurrect any of it.
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

void describe("automatic managed .gitignore maintenance", () => {
  void it("applies the managed block silently and records the applied root", async () => {
    const repoRoot = makeGitFixture();
    const configStub = installConfigStub();
    const ws = installWorkspaceFoldersStub(repoRoot);
    const writeBridge = installWriteFileBridge();
    const { context, state } = makeContext();

    try {
      await ensureAutomaticMetaGitIgnore(context);

      const written = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
      assert.match(written, /# BEGIN Ensemble managed meta resources/);
      assert.match(written, /\/\.ensemble\//);
      // The transcript-specific patterns are redundant once /.ensemble/
      // itself is ignored (it already covers everything beneath it) and
      // must not be written alongside it.
      assert.doesNotMatch(written, /chat-v1/);
      assert.deepEqual(
        state.get("ensemble.autoGitIgnoreApplied"),
        { [gateKeyFor(repoRoot)]: ".ensemble" },
        "the applied root is recorded per workspace folder so activation does not re-fight a manual edit"
      );
    } finally {
      writeBridge.restore();
      ws.restore();
      configStub.restore();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  void it("is a no-op once applied for the active root, even if the user hand-edited the file", async () => {
    const repoRoot = makeGitFixture();
    const configStub = installConfigStub();
    const ws = installWorkspaceFoldersStub(repoRoot);
    const writeBridge = installWriteFileBridge();
    const { context, state } = makeContext();
    // Legacy bare-string gate format (pre multi-root): it only ever targeted
    // the first workspace folder and must still be honored for it.
    state.set("ensemble.autoGitIgnoreApplied", ".ensemble");

    try {
      await ensureAutomaticMetaGitIgnore(context);
      assert.equal(
        fs.existsSync(path.join(repoRoot, ".gitignore")),
        false,
        "a recorded application for the active root must not write again"
      );
    } finally {
      writeBridge.restore();
      ws.restore();
      configStub.restore();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  void it("does not duplicate the artifacts pattern when the legacy configured root resolves to the same path", async () => {
    const repoRoot = makeGitFixture();
    // A leftover legacy metaResourcesPath of "artifacts/helper" resolves to
    // the exact same repo-relative path as the fixed artifacts root, which
    // previously produced a managed block listing "/artifacts/helper/" twice.
    const configStub = installConfigStub("artifacts/helper");
    const ws = installWorkspaceFoldersStub(repoRoot);
    const writeBridge = installWriteFileBridge();
    const { context } = makeContext();

    try {
      await ensureAutomaticMetaGitIgnore(context);

      const written = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
      const lines = written.split(/\r?\n/).map((line) => line.trim());
      const occurrences = lines.filter((line) => line === "/artifacts/helper/").length;
      assert.equal(
        occurrences,
        1,
        `expected "/artifacts/helper/" to appear exactly once as its own line, got ${occurrences}:\n${written}`
      );
    } finally {
      writeBridge.restore();
      ws.restore();
      configStub.restore();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  void it("writes the .gitignore of the selected workspace folder in a multi-root workspace", async () => {
    // Two independent repositories opened as one multi-root workspace. The
    // first folder was already handled (legacy string gate format); creating
    // the first task in the second folder must update the second repository's
    // .gitignore — not skip on the first folder's gate, and not touch the
    // first repository.
    const firstRepo = makeGitFixture();
    const secondRepo = makeGitFixture();
    const configStub = installConfigStub();
    const ws = installWorkspaceFoldersStub(firstRepo, secondRepo);
    const writeBridge = installWriteFileBridge();
    const { context, state } = makeContext();
    state.set("ensemble.autoGitIgnoreApplied", ".ensemble");

    try {
      await ensureAutomaticMetaGitIgnore(context, ws.folders[1]);

      assert.equal(
        fs.existsSync(path.join(firstRepo, ".gitignore")),
        false,
        "the first repository must not be touched when the second folder is the target"
      );
      const written = fs.readFileSync(path.join(secondRepo, ".gitignore"), "utf8");
      assert.match(written, /# BEGIN Ensemble managed meta resources/);
      assert.match(written, /\/\.ensemble\//);
      assert.deepEqual(
        state.get("ensemble.autoGitIgnoreApplied"),
        {
          [gateKeyFor(firstRepo)]: ".ensemble",
          [gateKeyFor(secondRepo)]: ".ensemble",
        },
        "the legacy first-folder record must be preserved and the second folder recorded alongside it"
      );

      // A second run for the same folder is gated off (record format).
      fs.rmSync(path.join(secondRepo, ".gitignore"));
      await ensureAutomaticMetaGitIgnore(context, ws.folders[1]);
      assert.equal(
        fs.existsSync(path.join(secondRepo, ".gitignore")),
        false,
        "a recorded application for the selected folder must not write again"
      );
    } finally {
      writeBridge.restore();
      ws.restore();
      configStub.restore();
      fs.rmSync(firstRepo, { recursive: true, force: true });
      fs.rmSync(secondRepo, { recursive: true, force: true });
    }
  });
});
