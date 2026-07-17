import * as assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  checkImplementationAvailabilityForModel,
  checkRunnerAvailabilityForModel,
  isAuthenticationFailure,
  resolveRunnerForModel,
  runImplementationForModel,
} from "../runners/runnerRegistry";
import {
  resolveFreshModelForStage,
  resolveModelForStage,
} from "../utils/modelSelection";

const requireModule = createRequire(__filename);
const childProcess = requireModule("node:child_process") as typeof import("node:child_process");

type LmStub = {
  selectChatModels: () => Promise<vscode.LanguageModelChat[]>;
};

function lmStub(): LmStub {
  return (vscode as unknown as { lm: LmStub }).lm;
}

function installModelSettings(raw: Record<string, unknown>): { restore: () => void } {
  const original = (vscode.workspace as unknown as Record<string, unknown>).getConfiguration;
  (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = (): {
    get: (key: string, defaultValue?: unknown) => unknown;
    inspect: () => undefined;
  } => ({
    get: (key: string, defaultValue?: unknown): unknown =>
      key === "modelSettings" ? raw : defaultValue,
    inspect: () => undefined,
  });

  return {
    restore: (): void => {
      (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = original;
    },
  };
}

// Regression coverage for a review finding: isAuthenticationFailure used a
// regex too narrow to catch common provider wording ("logged in" as opposed
// to "log in", "session expired"), so those messages fell through to
// failureKind "temporarily-unavailable" and the code auto-consumed the
// backup model — exactly what must never happen for an auth failure.
void describe("isAuthenticationFailure", () => {
  const authMessages = [
    "You are not logged in. Try again later.",
    "Please log in to continue.",
    "Logging in required before this action.",
    "Session expired, please sign in again.",
    "Your session has timed out.",
    "Authentication failed: invalid credentials.",
    "User is not authenticated.",
    "Authorization required for this request.",
    "Not authorized to perform this action.",
    "Please re-authenticate your account.",
    "Reauth required.",
    "API key is missing.",
    "Access denied.",
    "Permission denied.",
    "403 Forbidden",
    "HTTP 401",
    "unauthorized request",
    "token expired",
    "token has been revoked",
  ];

  for (const message of authMessages) {
    void it(`classifies "${message}" as an authentication failure`, () => {
      assert.equal(isAuthenticationFailure(message), true);
    });
  }

  const nonAuthMessages = [
    "Service temporarily unavailable.",
    "Rate limit exceeded, try again later.",
    "Quota exhausted for this billing period.",
    "Context length exceeded.",
    "The Kiro CLI (kiro-cli) is not installed. Install Kiro CLI, then set KIRO_API_KEY for headless mode.",
    "Could not start the Codex CLI (codex): command not found. Install the Codex CLI, then run `codex login`.",
    undefined,
    "",
  ];

  for (const message of nonAuthMessages) {
    void it(`does not classify "${message}" as an authentication failure`, () => {
      assert.equal(isAuthenticationFailure(message), false);
    });
  }
});

/** Config stub with a recorded provider selection (enabledProviders present
 * in the Global scope), so the runner-entry disabled-provider guard is
 * active — unlike installModelSettings, whose inspect() returns undefined
 * (no selection ever recorded → guard inactive by design). */
function installProviderSelection(
  enabled: Record<string, boolean>,
  raw: Record<string, unknown> = {}
): { restore: () => void } {
  const original = (vscode.workspace as unknown as Record<string, unknown>).getConfiguration;
  (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = (): {
    get: (key: string, defaultValue?: unknown) => unknown;
    inspect: (key: string) => { globalValue?: unknown } | undefined;
  } => ({
    get: (key: string, defaultValue?: unknown): unknown =>
      key === "modelSettings" ? raw : key === "enabledProviders" ? enabled : defaultValue,
    inspect: (key: string) =>
      key === "enabledProviders" ? { globalValue: enabled } : undefined,
  });
  return {
    restore: (): void => {
      (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = original;
    },
  };
}

void describe("runner-entry disabled-provider guard", () => {
  void it("refuses to resolve a runner for a disabled provider's model", () => {
    const stub = installProviderSelection({ "claude-cli": true });
    try {
      assert.throws(
        () => resolveRunnerForModel("kiro-cli:default", "impl-low-review"),
        /disabled in Provider Selection/
      );
    } finally {
      stub.restore();
    }
  });

  void it("resolves normally when the provider is enabled", () => {
    const stub = installProviderSelection({ "kiro-cli": true });
    try {
      const { provider } = resolveRunnerForModel("kiro-cli:default", "impl-low-review");
      assert.equal(provider, "kiro-cli");
    } finally {
      stub.restore();
    }
  });

  void it("never blocks Copilot (bare/legacy) model ids", () => {
    const stub = installProviderSelection({ "claude-cli": true });
    try {
      const { provider } = resolveRunnerForModel("gpt-4o", "impl-low-review");
      assert.equal(provider, "copilot");
    } finally {
      stub.restore();
    }
  });

  void it("stays inactive when no provider selection was ever recorded", () => {
    const settings = installModelSettings({});
    try {
      const { provider } = resolveRunnerForModel("kiro-cli:default", "impl-low-review");
      assert.equal(provider, "kiro-cli");
    } finally {
      settings.restore();
    }
  });

  void it("guards implementation availability checks through the same rule", async () => {
    const stub = installProviderSelection({ "claude-cli": true });
    try {
      await assert.rejects(
        () => checkImplementationAvailabilityForModel("kiro-cli:default", "impl"),
        /disabled in Provider Selection/
      );
    } finally {
      stub.restore();
    }
  });
});

void describe("resolveRunnerForModel", () => {
  void it("preserves runner availability checks when quota observation is enabled", async () => {
    const settings = installModelSettings({});
    try {
      const { runner } = resolveRunnerForModel("auto", "impl-low-review");

      assert.equal(typeof runner.isAvailable, "function");
      const availability = await runner.isAvailable();
      assert.equal(availability.available, false);
    } finally {
      settings.restore();
    }
  });

  void it("reports available when fallback switching has an available backup", async () => {
    const settings = installModelSettings({
      "impl-low-review": {
        primary: "kiro-cli:default",
        backup: "auto",
        strategy: "switch-to-backup",
      },
    });
    const lm = lmStub();
    const originalSelectChatModels = lm.selectChatModels;
    const originalSpawn = childProcess.spawn;

    lm.selectChatModels = (): Promise<vscode.LanguageModelChat[]> =>
      Promise.resolve([
        { id: "auto", name: "Auto" } as unknown as vscode.LanguageModelChat,
      ]);
    childProcess.spawn = ((
      _command: string,
      _args: readonly string[] = []
    ) => {
      const child = new EventEmitter() as import("node:child_process").ChildProcess;
      process.nextTick(() => child.emit("close", 1));
      return child;
    }) as typeof childProcess.spawn;

    try {
      const { runner } = resolveRunnerForModel("kiro-cli:default", "impl-low-review");

      assert.equal(typeof runner.isAvailable, "function");
      const availability = await runner.isAvailable();
      assert.equal(availability.available, true);

      const checked = await checkRunnerAvailabilityForModel(
        "kiro-cli:default",
        "impl-low-review"
      );
      assert.equal(checked.availability.available, true);
      assert.equal(checked.providerLabel, "Copilot");
    } finally {
      settings.restore();
      lm.selectChatModels = originalSelectChatModels;
      childProcess.spawn = originalSpawn;
    }
  });

  void it("does not report backup availability when the primary availability failure is authentication", async () => {
    const settings = installModelSettings({
      "impl-low-review": {
        primary: "auto",
        backup: "kiro-cli:default",
        strategy: "switch-to-backup",
      },
    });
    const lm = lmStub();
    const originalSelectChatModels = lm.selectChatModels;

    lm.selectChatModels = (): Promise<vscode.LanguageModelChat[]> =>
      Promise.resolve([]);

    try {
      const { runner } = resolveRunnerForModel("auto", "impl-low-review");

      const availability = await runner.isAvailable();
      assert.equal(availability.available, false);
      assert.match(availability.reason ?? "", /Sign in to GitHub Copilot/i);
    } finally {
      settings.restore();
      lm.selectChatModels = originalSelectChatModels;
    }
  });

  void it("switches to backup when an explicit Copilot primary model is unavailable", async () => {
    const metaRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ensemble-runner-fallback-")
    );
    const tasksRoot = path.join(metaRoot, "tasks");
    const taskFolder = path.join(tasksRoot, "task-a");
    fs.mkdirSync(taskFolder, { recursive: true });
    const taskFolderUri = vscode.Uri.file(taskFolder);
    const outputFile = vscode.Uri.file(path.join(taskFolder, "plan.md"));
    const progressPath = path.join(taskFolder, "task-progress.json");
    const now = new Date().toISOString();
    fs.writeFileSync(
      progressPath,
      JSON.stringify(
        {
          taskFolder: path.basename(taskFolder),
          currentStage: "plan",
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
        null,
        2
      ),
      "utf8"
    );

    const settings = installModelSettings({
      plan: {
        primary: "copilot-gpt-5.6-sol",
        backup: "auto",
        strategy: "switch-to-backup",
      },
    });
    const lm = lmStub();
    const originalSelectChatModels = lm.selectChatModels;
    const workspace = vscode.workspace as unknown as {
      fs: {
        readFile: (uri: vscode.Uri) => Promise<Uint8Array>;
        writeFile: (uri: vscode.Uri, bytes: Uint8Array) => Promise<void>;
      };
    };
    const originalReadFile = workspace.fs.readFile;
    const originalWriteFile = workspace.fs.writeFile;

    workspace.fs.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
      fs.promises.readFile(uri.fsPath);
    workspace.fs.writeFile = (
      uri: vscode.Uri,
      bytes: Uint8Array
    ): Promise<void> => fs.promises.writeFile(uri.fsPath, bytes);
    lm.selectChatModels = (): Promise<vscode.LanguageModelChat[]> =>
      Promise.resolve([
        {
          id: "auto",
          name: "Auto",
          sendRequest: () =>
            Promise.resolve({
              text: ["backup output"] as unknown as AsyncIterable<string>,
            }),
        } as unknown as vscode.LanguageModelChat,
      ]);

    try {
      const { runner } = resolveRunnerForModel(
        "copilot-gpt-5.6-sol",
        "plan",
        taskFolderUri
      );

      const result = await runner.run(
        {
          taskFolderUri,
          workspaceUri: vscode.Uri.file(taskFolder),
          stage: "plan",
          prompt: "Create a plan.",
          outputFile,
          modelId: "copilot-gpt-5.6-sol",
        },
        new vscode.CancellationTokenSource().token
      );

      assert.strictEqual(result.status, "completed");
      assert.strictEqual(result.modelId, "auto");
      assert.match(fs.readFileSync(outputFile.fsPath, "utf8"), /backup output/);
      const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as {
        fallbackActive?: Partial<Record<string, boolean>>;
        fallbackModelId?: Partial<Record<string, string>>;
      };
      assert.strictEqual(progress.fallbackActive?.plan, true);
      assert.strictEqual(progress.fallbackModelId?.plan, "auto");
    } finally {
      settings.restore();
      lm.selectChatModels = originalSelectChatModels;
      workspace.fs.readFile = originalReadFile;
      workspace.fs.writeFile = originalWriteFile;
    }
  });

  void it("skips an unavailable backup and runs the next configured backup", async () => {
    const metaRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ensemble-runner-multi-fallback-")
    );
    const tasksRoot = path.join(metaRoot, "tasks");
    const taskFolder = path.join(tasksRoot, "task-a");
    fs.mkdirSync(taskFolder, { recursive: true });
    const taskFolderUri = vscode.Uri.file(taskFolder);
    const outputFile = vscode.Uri.file(path.join(taskFolder, "plan.md"));
    const progressPath = path.join(taskFolder, "task-progress.json");
    const now = new Date().toISOString();
    fs.writeFileSync(
      progressPath,
      JSON.stringify(
        {
          taskFolder: path.basename(taskFolder),
          currentStage: "plan",
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
        null,
        2
      ),
      "utf8"
    );

    const settings = installModelSettings({
      plan: {
        primary: "kiro-cli:default",
        backups: ["antigravity-cli:Gemini 3.5 Flash (Medium)", "auto"],
        strategy: "switch-to-backup",
      },
    });
    const lm = lmStub();
    const originalSelectChatModels = lm.selectChatModels;
    const originalSpawn = childProcess.spawn;
    const workspace = vscode.workspace as unknown as {
      fs: {
        readFile: (uri: vscode.Uri) => Promise<Uint8Array>;
        writeFile: (uri: vscode.Uri, bytes: Uint8Array) => Promise<void>;
      };
    };
    const originalReadFile = workspace.fs.readFile;
    const originalWriteFile = workspace.fs.writeFile;

    workspace.fs.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
      fs.promises.readFile(uri.fsPath);
    workspace.fs.writeFile = (
      uri: vscode.Uri,
      bytes: Uint8Array
    ): Promise<void> => fs.promises.writeFile(uri.fsPath, bytes);
    childProcess.spawn = ((
      _command: string,
      _args: readonly string[] = []
    ) => {
      const child = new EventEmitter() as import("node:child_process").ChildProcess;
      process.nextTick(() => child.emit("close", 1));
      return child;
    }) as typeof childProcess.spawn;
    lm.selectChatModels = (): Promise<vscode.LanguageModelChat[]> =>
      Promise.resolve([
        {
          id: "auto",
          name: "Auto",
          sendRequest: () =>
            Promise.resolve({
              text: ["second backup output"] as unknown as AsyncIterable<string>,
            }),
        } as unknown as vscode.LanguageModelChat,
      ]);

    try {
      const { runner } = resolveRunnerForModel(
        "kiro-cli:default",
        "plan",
        taskFolderUri
      );

      const result = await runner.run(
        {
          taskFolderUri,
          workspaceUri: vscode.Uri.file(taskFolder),
          stage: "plan",
          prompt: "Create a plan.",
          outputFile,
          modelId: "default",
        },
        new vscode.CancellationTokenSource().token
      );

      assert.strictEqual(result.status, "completed");
      assert.strictEqual(result.modelId, "auto");
      assert.match(fs.readFileSync(outputFile.fsPath, "utf8"), /second backup output/);
      const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as {
        fallbackActive?: Partial<Record<string, boolean>>;
        fallbackModelId?: Partial<Record<string, string>>;
      };
      assert.strictEqual(progress.fallbackActive?.plan, true);
      assert.strictEqual(progress.fallbackModelId?.plan, "auto");

      const stickyResolved = await resolveModelForStage(taskFolderUri, "plan");
      assert.strictEqual(stickyResolved.modelId, "auto");
    } finally {
      settings.restore();
      lm.selectChatModels = originalSelectChatModels;
      childProcess.spawn = originalSpawn;
      workspace.fs.readFile = originalReadFile;
      workspace.fs.writeFile = originalWriteFile;
    }
  });
});

void describe("runImplementationForModel", () => {
  void it("reports implementation availability from a configured backup", async () => {
    const settings = installModelSettings({
      impl: {
        primary: "kiro-cli:default",
        backup: "auto",
        strategy: "switch-to-backup",
      },
    });
    const lm = lmStub();
    const originalSelectChatModels = lm.selectChatModels;
    const originalSpawn = childProcess.spawn;

    lm.selectChatModels = (): Promise<vscode.LanguageModelChat[]> =>
      Promise.resolve([
        { id: "auto", name: "Auto" } as unknown as vscode.LanguageModelChat,
      ]);
    childProcess.spawn = ((
      _command: string,
      _args: readonly string[] = []
    ) => {
      const child = new EventEmitter() as import("node:child_process").ChildProcess;
      process.nextTick(() => child.emit("close", 1));
      return child;
    }) as typeof childProcess.spawn;

    try {
      const { availability, providerLabel } =
        await checkImplementationAvailabilityForModel("kiro-cli:default", "impl");
      assert.equal(availability.available, true);
      assert.equal(providerLabel, "Copilot");
    } finally {
      settings.restore();
      lm.selectChatModels = originalSelectChatModels;
      childProcess.spawn = originalSpawn;
    }
  });

  void it("switches implementation to backup when an explicit Copilot primary model is unavailable", async () => {
    const metaRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ensemble-impl-fallback-")
    );
    const tasksRoot = path.join(metaRoot, "tasks");
    const taskFolder = path.join(tasksRoot, "task-a");
    fs.mkdirSync(taskFolder, { recursive: true });
    const taskFolderUri = vscode.Uri.file(taskFolder);
    const progressPath = path.join(taskFolder, "task-progress.json");
    const now = new Date().toISOString();
    fs.writeFileSync(
      progressPath,
      JSON.stringify(
        {
          taskFolder: path.basename(taskFolder),
          currentStage: "impl",
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
        null,
        2
      ),
      "utf8"
    );

    const settings = installModelSettings({
      impl: {
        primary: "copilot-gpt-5.6-sol",
        backup: "auto",
        strategy: "switch-to-backup",
      },
    });
    const lm = lmStub();
    const originalSelectChatModels = lm.selectChatModels;
    const workspace = vscode.workspace as unknown as {
      fs: {
        readFile: (uri: vscode.Uri) => Promise<Uint8Array>;
        writeFile: (uri: vscode.Uri, bytes: Uint8Array) => Promise<void>;
      };
    };
    const originalReadFile = workspace.fs.readFile;
    const originalWriteFile = workspace.fs.writeFile;

    function* responseStream(): Iterable<vscode.LanguageModelTextPart> {
      yield new vscode.LanguageModelTextPart("backup implementation");
    }

    workspace.fs.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
      fs.promises.readFile(uri.fsPath);
    workspace.fs.writeFile = (
      uri: vscode.Uri,
      bytes: Uint8Array
    ): Promise<void> => fs.promises.writeFile(uri.fsPath, bytes);
    lm.selectChatModels = (): Promise<vscode.LanguageModelChat[]> =>
      Promise.resolve([
        {
          id: "auto",
          name: "Auto",
          sendRequest: () =>
            Promise.resolve({
              stream: responseStream(),
            }),
        } as unknown as vscode.LanguageModelChat,
      ]);

    try {
      const result = await runImplementationForModel({
        modelId: "copilot-gpt-5.6-sol",
        prompt: "Implement the requested change.",
        workspaceUri: vscode.Uri.file(taskFolder),
        token: new vscode.CancellationTokenSource().token,
        onProgress: () => undefined,
        stage: "impl",
        taskFolderUri,
      });

      assert.strictEqual(result.runnerId, "copilot-lm");
      assert.strictEqual(result.status, "completed");
      assert.strictEqual(result.summary, "backup implementation");
      const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as {
        fallbackActive?: Partial<Record<string, boolean>>;
        fallbackModelId?: Partial<Record<string, string>>;
      };
      assert.strictEqual(progress.fallbackActive?.impl, true);
      assert.strictEqual(progress.fallbackModelId?.impl, "auto");
    } finally {
      settings.restore();
      lm.selectChatModels = originalSelectChatModels;
      workspace.fs.readFile = originalReadFile;
      workspace.fs.writeFile = originalWriteFile;
    }
  });

  void it("keeps provider-qualified CLI model IDs on the CLI implementation path", async () => {
    const originalSpawn = childProcess.spawn;
    const spawnCalls: Array<{ command: string; args: readonly string[] }> = [];

    childProcess.spawn = ((
      command: string,
      args: readonly string[] = []
    ) => {
      spawnCalls.push({ command, args });
      const child = new EventEmitter() as import("node:child_process").ChildProcess;
      Object.defineProperty(child, "pid", { value: 1234 });
      child.stdout = new EventEmitter() as import("node:child_process").ChildProcess["stdout"];
      child.stderr = new EventEmitter() as import("node:child_process").ChildProcess["stderr"];
      child.stdin = new EventEmitter() as import("node:child_process").ChildProcess["stdin"];
      process.nextTick(() => child.emit("close", 1));
      return child;
    }) as typeof childProcess.spawn;

    try {
      const tokenSource = new vscode.CancellationTokenSource();
      const result = await runImplementationForModel({
        modelId: "codex-cli:gpt-5.6-luna@low",
        prompt: "Implement the requested change.",
        workspaceUri: vscode.Uri.file(process.cwd()),
        token: tokenSource.token,
        onProgress: () => undefined,
        stage: "impl",
        taskFolderUri: vscode.Uri.file(process.cwd()),
      });

      assert.strictEqual(result.runnerId, "codex-cli");
      assert.strictEqual(result.status, "failed");
      assert.match(result.errorMessage ?? "", /OpenAI Codex CLI/);
      assert.strictEqual(spawnCalls.length, 1);
      assert.match(spawnCalls[0]?.command ?? "", /^(which|where\.exe)$/);
      assert.deepStrictEqual(spawnCalls[0]?.args, ["codex"]);
    } finally {
      childProcess.spawn = originalSpawn;
    }
  });

  // Regression coverage: implementation-pipeline fallback bookkeeping must
  // stay keyed on "impl" (the stage the model is actually resolved from),
  // never on whatever review stage the task happens to be parked at. Before
  // the fix, a failed implementation run recorded fallbackActive under the
  // *review* stage, which then made the next review-generation run for that
  // stage skip straight to its own backup without ever trying its primary.
  void it("does not let an impl-stage fallback bleed into an unrelated review stage's model resolution", async () => {
    const metaRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ensemble-stage-isolation-")
    );
    const tasksRoot = path.join(metaRoot, "tasks");
    const taskFolder = path.join(tasksRoot, "task-a");
    fs.mkdirSync(taskFolder, { recursive: true });
    const taskFolderUri = vscode.Uri.file(taskFolder);
    const progressPath = path.join(taskFolder, "task-progress.json");
    const now = new Date().toISOString();
    fs.writeFileSync(
      progressPath,
      JSON.stringify(
        {
          taskFolder: path.basename(taskFolder),
          currentStage: "impl-low-review",
          status: "active",
          createdAt: now,
          updatedAt: now,
          // Simulates the state left behind by an implementation run whose
          // primary failed: only "impl"'s fallback flag is set.
          fallbackActive: { impl: true },
        },
        null,
        2
      ),
      "utf8"
    );

    const settings = installModelSettings({
      impl: {
        primary: "impl-primary",
        backup: "impl-backup",
        strategy: "switch-to-backup",
      },
      "impl-low-review": {
        primary: "review-primary",
        backup: "review-backup",
        strategy: "switch-to-backup",
      },
    });

    const workspace = vscode.workspace as unknown as {
      fs: {
        readFile: (uri: vscode.Uri) => Promise<Uint8Array>;
      };
    };
    const originalReadFile = workspace.fs.readFile;
    workspace.fs.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
      fs.promises.readFile(uri.fsPath);

    try {
      const implResolved = await resolveModelForStage(taskFolderUri, "impl");
      assert.strictEqual(implResolved.modelId, "impl-backup");

      const reviewResolved = await resolveModelForStage(
        taskFolderUri,
        "impl-low-review"
      );
      assert.strictEqual(reviewResolved.modelId, "review-primary");
    } finally {
      settings.restore();
      workspace.fs.readFile = originalReadFile;
    }
  });

  void it("retries the primary model for a fresh implementation run after an earlier fallback", async () => {
    const metaRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ensemble-fresh-impl-primary-")
    );
    const tasksRoot = path.join(metaRoot, "tasks");
    const taskFolder = path.join(tasksRoot, "task-a");
    fs.mkdirSync(taskFolder, { recursive: true });
    const taskFolderUri = vscode.Uri.file(taskFolder);
    const progressPath = path.join(taskFolder, "task-progress.json");
    const now = new Date().toISOString();
    fs.writeFileSync(
      progressPath,
      JSON.stringify(
        {
          taskFolder: path.basename(taskFolder),
          currentStage: "impl-high-review",
          status: "active",
          createdAt: now,
          updatedAt: now,
          fallbackActive: { impl: true },
          fallbackModelId: { impl: "impl-backup" },
        },
        null,
        2
      ),
      "utf8"
    );

    const settings = installModelSettings({
      impl: {
        primary: "impl-primary",
        backup: "impl-backup",
        strategy: "switch-to-backup",
      },
    });

    const workspace = vscode.workspace as unknown as {
      fs: {
        readFile: (uri: vscode.Uri) => Promise<Uint8Array>;
      };
    };
    const originalReadFile = workspace.fs.readFile;
    workspace.fs.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
      fs.promises.readFile(uri.fsPath);

    try {
      const stickyResolved = await resolveModelForStage(taskFolderUri, "impl");
      assert.strictEqual(stickyResolved.modelId, "impl-backup");

      const freshResolved = await resolveFreshModelForStage(taskFolderUri, "impl");
      assert.strictEqual(freshResolved.modelId, "impl-primary");

      const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as {
        fallbackActive?: Partial<Record<string, boolean>>;
        fallbackModelId?: Partial<Record<string, string>>;
      };
      assert.strictEqual(progress.fallbackActive?.impl, undefined);
      assert.strictEqual(progress.fallbackModelId?.impl, undefined);
    } finally {
      settings.restore();
      workspace.fs.readFile = originalReadFile;
    }
  });
});
