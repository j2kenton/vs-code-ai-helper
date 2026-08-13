import * as assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  backupModelsForStage,
  checkImplementationAvailabilityForModel,
  checkRunnerAvailabilityForModel,
  getConfiguredBackupModelsForStage,
  recordActiveFallbackModel,
  resolveRunnerForModel,
  runImplementationForModel,
} from "../runners/runnerRegistry";
import {
  resolveFreshModelForStage,
  resolveModelForStage,
} from "../utils/modelSelection";
import { isAuthenticationFailure } from "../utils/quota";
import {
  LEGACY_UNCORRELATED_RUNNER_INVOCATION_REJECTED_V0,
  LegacyAiActionSafetyGateErrorV0,
} from "../services/legacyAiActionSafetyGateV0";

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

// Regression coverage: the deliberate second-opinion mechanism (reviewActions.ts)
// originally reused backupModelsForStage, which only returns anything when
// strategy === "switch-to-backup" — the quota-triggered automatic switch-over
// opt-in. A user with backups configured under "pause-and-resume" or
// "alert-and-wait" (explicitly opting OUT of automatic quota switch-over)
// still has models genuinely available, but that reuse made the second-opinion
// mechanism silently inert ("no alternate model was available") for them.
void describe("getConfiguredBackupModelsForStage", () => {
  void it("returns configured backups under strategy 'switch-to-backup'", () => {
    const stub = installModelSettings({
      "impl-high-review": { primary: "codex-cli:gpt-5", backups: ["claude-cli:sonnet"], strategy: "switch-to-backup" },
    });
    try {
      assert.deepEqual(
        getConfiguredBackupModelsForStage("impl-high-review", "codex-cli:gpt-5"),
        ["claude-cli:sonnet"]
      );
    } finally {
      stub.restore();
    }
  });

  void it("still returns configured backups under 'pause-and-resume' — the actual bug fixed here", () => {
    const stub = installModelSettings({
      "impl-high-review": { primary: "codex-cli:gpt-5", backups: ["claude-cli:sonnet"], strategy: "pause-and-resume" },
    });
    try {
      assert.deepEqual(
        getConfiguredBackupModelsForStage("impl-high-review", "codex-cli:gpt-5"),
        ["claude-cli:sonnet"]
      );
    } finally {
      stub.restore();
    }
  });

  void it("still returns configured backups under 'alert-and-wait'", () => {
    const stub = installModelSettings({
      "impl-high-review": { primary: "codex-cli:gpt-5", backups: ["gemini-cli:default"], strategy: "alert-and-wait" },
    });
    try {
      assert.deepEqual(
        getConfiguredBackupModelsForStage("impl-high-review", "codex-cli:gpt-5"),
        ["gemini-cli:default"]
      );
    } finally {
      stub.restore();
    }
  });

  void it("excludes the primary model itself even if it also appears in backups", () => {
    const stub = installModelSettings({
      "impl-high-review": { primary: "codex-cli:gpt-5", backups: ["codex-cli:gpt-5", "claude-cli:sonnet"], strategy: "alert-and-wait" },
    });
    try {
      assert.deepEqual(
        getConfiguredBackupModelsForStage("impl-high-review", "codex-cli:gpt-5"),
        ["claude-cli:sonnet"]
      );
    } finally {
      stub.restore();
    }
  });

  void it("returns an empty array when no stage is given", () => {
    assert.deepEqual(getConfiguredBackupModelsForStage(undefined, "codex-cli:gpt-5"), []);
  });

  void it("returns an empty array when nothing is configured for the stage", () => {
    const stub = installModelSettings({});
    try {
      assert.deepEqual(getConfiguredBackupModelsForStage("impl-high-review", "codex-cli:gpt-5"), []);
    } finally {
      stub.restore();
    }
  });
});

void describe("recordActiveFallbackModel review-attempt CAS", () => {
  void it("does not persist routing after a newer review attempt claims the stage", async () => {
    const metaRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ensemble-fallback-attempt-cas-")
    );
    const taskFolder = path.join(metaRoot, "tasks", "task-a");
    fs.mkdirSync(taskFolder, { recursive: true });
    const taskFolderUri = vscode.Uri.file(taskFolder);
    const progressPath = path.join(taskFolder, "task-progress.json");
    const now = new Date().toISOString();
    fs.writeFileSync(
      progressPath,
      JSON.stringify(
        {
          taskFolder: "task-a",
          currentStage: "impl-low-review",
          status: "active",
          createdAt: now,
          updatedAt: now,
          reviewAttemptId: "newer-attempt",
        },
        null,
        2
      ),
      "utf8"
    );

    const workspace = vscode.workspace as unknown as {
      fs: { readFile: (uri: vscode.Uri) => Promise<Uint8Array> };
    };
    const originalReadFile = workspace.fs.readFile;
    workspace.fs.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
      fs.promises.readFile(uri.fsPath);

    try {
      const recorded = await recordActiveFallbackModel(
        taskFolderUri,
        "impl-low-review",
        "claude-cli:sonnet",
        {
          expectedReviewAttemptId: "older-attempt",
          requireUnreserved: true,
        }
      );

      assert.equal(recorded, false);
      const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as {
        fallbackActive?: Partial<Record<string, boolean>>;
        fallbackModelId?: Partial<Record<string, string>>;
      };
      assert.equal(progress.fallbackActive?.["impl-low-review"], undefined);
      assert.equal(progress.fallbackModelId?.["impl-low-review"], undefined);
    } finally {
      workspace.fs.readFile = originalReadFile;
    }
  });
});

void describe("backupModelsForStage", () => {
  void it("deduplicates canonical and legacy aliases and excludes an aliased primary", () => {
    const stub = installModelSettings({
      "impl-high-review": {
        primary: "antigravity-cli:gemini-3.5-flash-medium",
        backups: [
          "antigravity-cli:Gemini 3.5 Flash (Medium)",
          "antigravity-cli:gemini-3.5-flash-high",
          "antigravity-cli:Gemini 3.5 Flash (High)",
          "claude-cli:sonnet",
        ],
        strategy: "switch-to-backup",
      },
    });
    try {
      assert.deepEqual(
        backupModelsForStage(
          "impl-high-review",
          "antigravity-cli:gemini-3.5-flash-medium"
        ),
        ["antigravity-cli:Gemini 3.5 Flash (High)", "claude-cli:sonnet"]
      );
    } finally {
      stub.restore();
    }
  });
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

  void it("guards OpenCode Go independently from OpenCode Zen", () => {
    const stub = installProviderSelection({ "opencode-zen": true, "opencode-go": false });
    try {
      const zen = resolveRunnerForModel("opencode-cli:opencode/glm-5.2", "impl-low-review");
      assert.equal(zen.provider, "opencode-cli");
      assert.throws(
        () => resolveRunnerForModel("opencode-cli:opencode-go/kimi-k3", "impl-low-review"),
        /OpenCode Go.*disabled in Provider Selection/
      );
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
          reviewAttemptId: "attempt-a",
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
        taskFolderUri,
        "attempt-a"
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

  void it("does not keep an authentication-failed backup as the next text-run route", async () => {
    const metaRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ensemble-text-fallback-auth-")
    );
    const taskFolder = path.join(metaRoot, "tasks", "task-a");
    fs.mkdirSync(taskFolder, { recursive: true });
    const taskFolderUri = vscode.Uri.file(taskFolder);
    const progressPath = path.join(taskFolder, "task-progress.json");
    const now = new Date().toISOString();
    fs.writeFileSync(
      progressPath,
      JSON.stringify(
        {
          taskFolder: "task-a",
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
        primary: "quota-primary",
        backup: "unauthenticated-backup",
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
    const attemptedModels: string[] = [];

    workspace.fs.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
      fs.promises.readFile(uri.fsPath);
    workspace.fs.writeFile = (
      uri: vscode.Uri,
      bytes: Uint8Array
    ): Promise<void> => fs.promises.writeFile(uri.fsPath, bytes);
    lm.selectChatModels = (): Promise<vscode.LanguageModelChat[]> =>
      Promise.resolve([
        {
          id: "quota-primary",
          name: "Quota primary",
          sendRequest: () => {
            attemptedModels.push("quota-primary");
            return Promise.reject(new Error("Rate limit exceeded."));
          },
        } as unknown as vscode.LanguageModelChat,
        {
          id: "unauthenticated-backup",
          name: "Unauthenticated backup",
          sendRequest: () => {
            attemptedModels.push("unauthenticated-backup");
            return Promise.reject(new Error("HTTP 401 Unauthorized."));
          },
        } as unknown as vscode.LanguageModelChat,
      ]);

    try {
      const { runner } = resolveRunnerForModel(
        "quota-primary",
        "plan",
        taskFolderUri
      );
      const result = await runner.run(
        {
          taskFolderUri,
          workspaceUri: vscode.Uri.file(taskFolder),
          stage: "plan",
          prompt: "Create a plan.",
          outputFile: vscode.Uri.file(path.join(taskFolder, "plan.md")),
          modelId: "quota-primary",
        },
        new vscode.CancellationTokenSource().token
      );

      assert.equal(result.status, "failed");
      assert.equal(result.failureKind, "generic");
      assert.deepEqual(attemptedModels, ["quota-primary", "unauthenticated-backup"]);
      const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as {
        fallbackActive?: Partial<Record<string, boolean>>;
        fallbackModelId?: Partial<Record<string, string>>;
      };
      assert.equal(progress.fallbackActive?.plan, undefined);
      assert.equal(progress.fallbackModelId?.plan, undefined);
      assert.equal(
        (await resolveModelForStage(taskFolderUri, "plan")).modelId,
        "quota-primary",
        "the next user action must retry the configured primary, not the failed backup"
      );
    } finally {
      settings.restore();
      lm.selectChatModels = originalSelectChatModels;
      workspace.fs.readFile = originalReadFile;
      workspace.fs.writeFile = originalWriteFile;
      fs.rmSync(metaRoot, { recursive: true, force: true });
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

    // The pinned 1.93 declarations do not define LanguageModelTextPart; the
    // stub provides it at runtime, so name it through a structural cast.
    const { LanguageModelTextPart } = vscode as unknown as {
      LanguageModelTextPart: new (value: string) => { value: string };
    };
    function* responseStream(): Iterable<unknown> {
      yield new LanguageModelTextPart("backup implementation");
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
        correlation: { actionKey: "implementation.v1" },
        allowCrossProviderBackups: true,
      });

      assert.strictEqual(result.runnerId, "copilot-lm");
      assert.strictEqual(result.status, "completed");
      assert.strictEqual(result.summary, "backup implementation");
      // Durable provider/model attribution task: the RUNTIME backup that
      // actually produced this result must be stamped, not the requested
      // primary "copilot-gpt-5.6-sol" — this is the misattribution the
      // implementation review flagged (runnerRegistry.ts's own internal
      // cascade substituting a model with no visible identity at the
      // caller boundary).
      assert.strictEqual(result.actualStoredModelId, "auto");
      assert.strictEqual(result.actualProviderLabel, "Copilot");
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

  // Regression coverage for a review finding: an earlier version let a
  // now-removed `isImplementationV1Bootstrap: true` flag skip
  // assertNoUnauthorizedV1CorrelationV0 entirely, so an uncorrelated
  // "implementation.v1" request could reach a provider — a real
  // edit-capable invocation — with no read-only preflight in front of it.
  // The backstop is enforced unconditionally now; the flag itself was
  // removed rather than left inert. Proven directly against the production
  // boundary switch rather than relying only on the coverage in
  // legacyAiActionSafetyGateV0.test.ts.
  void it("assertNoUnauthorizedV1CorrelationV0 rejects an uncorrelated call", async () => {
    const metaRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ensemble-impl-bootstrap-flag-")
    );
    const taskFolder = path.join(metaRoot, "tasks", "task-a");
    fs.mkdirSync(taskFolder, { recursive: true });
    const taskFolderUri = vscode.Uri.file(taskFolder);
    const progressPath = path.join(taskFolder, "task-progress.json");
    const now = new Date().toISOString();
    fs.writeFileSync(
      progressPath,
      JSON.stringify(
        { taskFolder: "task-a", currentStage: "impl", status: "active", createdAt: now, updatedAt: now },
        null,
        2
      ),
      "utf8"
    );

    const settings = installModelSettings({
      impl: { primary: "copilot-gpt-5.6-sol", strategy: "switch-to-backup" },
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
    const { LanguageModelTextPart } = vscode as unknown as {
      LanguageModelTextPart: new (value: string) => { value: string };
    };
    function* responseStream(): Iterable<unknown> {
      yield new LanguageModelTextPart("done");
    }
    workspace.fs.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
      fs.promises.readFile(uri.fsPath);
    workspace.fs.writeFile = (uri: vscode.Uri, bytes: Uint8Array): Promise<void> =>
      fs.promises.writeFile(uri.fsPath, bytes);
    lm.selectChatModels = (): Promise<vscode.LanguageModelChat[]> =>
      Promise.resolve([
        {
          id: "auto",
          name: "Auto",
          sendRequest: () => Promise.resolve({ stream: responseStream() }),
        } as unknown as vscode.LanguageModelChat,
      ]);

    assert.equal(LEGACY_UNCORRELATED_RUNNER_INVOCATION_REJECTED_V0.enabled, false);
    LEGACY_UNCORRELATED_RUNNER_INVOCATION_REJECTED_V0.enabled = true;
    try {
      const baseRequest = {
        modelId: "copilot-gpt-5.6-sol",
        prompt: "Implement the requested change.",
        workspaceUri: vscode.Uri.file(taskFolder),
        token: new vscode.CancellationTokenSource().token,
        onProgress: () => undefined,
        stage: "impl" as const,
        taskFolderUri,
        // deliberately no `correlation` — this test proves an uncorrelated
        // call is rejected, so it must violate that required field.
      };

      await assert.rejects(
        // @ts-expect-error — deliberately uncorrelated request under test
        runImplementationForModel(baseRequest),
        LegacyAiActionSafetyGateErrorV0
      );
    } finally {
      LEGACY_UNCORRELATED_RUNNER_INVOCATION_REJECTED_V0.enabled = false;
      settings.restore();
      lm.selectChatModels = originalSelectChatModels;
      workspace.fs.readFile = originalReadFile;
      workspace.fs.writeFile = originalWriteFile;
    }
  });

  // Regression coverage for a review finding: resolveRunnerForModel's
  // stage-less branch (historically called by runSecondOpinionReview in
  // reviewActions.ts and by the Global Assistant in
  // openGeneralAssistant.ts — both resolved a runner without ever passing
  // `stage`; both call sites were later removed entirely during the Cleanup
  // cohort's disposition of those two routes, see
  // legacyAiActionSafetyGateV0.ts's file header) used to return
  // toResolvedRunner's raw runner untouched, so its .run() reached the
  // concrete CopilotLanguageModelRunner/CliAgentRunner directly with NO call
  // to assertNoUnauthorizedV1CorrelationV0 at all — not merely being subject
  // to it, as the stage-bearing branches always were. This test proves the
  // stage-less branch itself still enforces the boundary directly against
  // the production switch, independent of whether any production caller
  // currently exercises that branch, mirroring the equivalent
  // runImplementationForModel coverage above.
  void it("resolveRunnerForModel's stage-less branch also rejects an uncorrelated call", async () => {
    assert.equal(LEGACY_UNCORRELATED_RUNNER_INVOCATION_REJECTED_V0.enabled, false);
    LEGACY_UNCORRELATED_RUNNER_INVOCATION_REJECTED_V0.enabled = true;
    try {
      // A bare/legacy model id resolves to Copilot with no provider-selection
      // or model-settings stub needed (resolveEffectiveProvider's rule).
      const { runner } = resolveRunnerForModel("gpt-4o");
      await assert.rejects(
        runner.run(
          {
            taskFolderUri: vscode.Uri.file(path.join(os.tmpdir(), "ensemble-stageless-backstop")),
            workspaceUri: vscode.Uri.file(path.join(os.tmpdir(), "ensemble-stageless-backstop")),
            stage: "desc",
            prompt: "Second opinion / Global Assistant style call with no V1 correlation.",
            outputFile: vscode.Uri.file(path.join(os.tmpdir(), "ensemble-stageless-backstop", "out.md")),
            modelId: "gpt-4o",
          },
          new vscode.CancellationTokenSource().token
        ),
        LegacyAiActionSafetyGateErrorV0
      );
    } finally {
      LEGACY_UNCORRELATED_RUNNER_INVOCATION_REJECTED_V0.enabled = false;
    }
  });

  void it("does not keep an authentication-failed backup as the next implementation route", async () => {
    const metaRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ensemble-impl-fallback-auth-")
    );
    const taskFolder = path.join(metaRoot, "tasks", "task-a");
    fs.mkdirSync(taskFolder, { recursive: true });
    const taskFolderUri = vscode.Uri.file(taskFolder);
    const progressPath = path.join(taskFolder, "task-progress.json");
    const now = new Date().toISOString();
    fs.writeFileSync(
      progressPath,
      JSON.stringify(
        {
          taskFolder: "task-a",
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
        primary: "quota-primary",
        backup: "unauthenticated-backup",
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
    const attemptedModels: string[] = [];

    workspace.fs.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
      fs.promises.readFile(uri.fsPath);
    workspace.fs.writeFile = (
      uri: vscode.Uri,
      bytes: Uint8Array
    ): Promise<void> => fs.promises.writeFile(uri.fsPath, bytes);
    lm.selectChatModels = (): Promise<vscode.LanguageModelChat[]> =>
      Promise.resolve([
        {
          id: "quota-primary",
          name: "Quota primary",
          sendRequest: () => {
            attemptedModels.push("quota-primary");
            return Promise.reject(new Error("Rate limit exceeded."));
          },
        } as unknown as vscode.LanguageModelChat,
        {
          id: "unauthenticated-backup",
          name: "Unauthenticated backup",
          sendRequest: () => {
            attemptedModels.push("unauthenticated-backup");
            return Promise.reject(new Error("HTTP 401 Unauthorized."));
          },
        } as unknown as vscode.LanguageModelChat,
      ]);

    try {
      const result = await runImplementationForModel({
        modelId: "quota-primary",
        prompt: "Implement the requested change.",
        workspaceUri: vscode.Uri.file(taskFolder),
        token: new vscode.CancellationTokenSource().token,
        correlation: { actionKey: "implementation.v1" },
        allowCrossProviderBackups: true,
        onProgress: () => undefined,
        stage: "impl",
        taskFolderUri,
      });

      assert.equal(result.status, "failed");
      assert.equal(result.failureKind, "generic");
      assert.deepEqual(attemptedModels, ["quota-primary", "unauthenticated-backup"]);
      const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as {
        fallbackActive?: Partial<Record<string, boolean>>;
        fallbackModelId?: Partial<Record<string, string>>;
      };
      assert.equal(progress.fallbackActive?.impl, undefined);
      assert.equal(progress.fallbackModelId?.impl, undefined);
      assert.equal(
        (await resolveModelForStage(taskFolderUri, "impl")).modelId,
        "quota-primary",
        "the next user action must retry the configured primary, not the failed backup"
      );
    } finally {
      settings.restore();
      lm.selectChatModels = originalSelectChatModels;
      workspace.fs.readFile = originalReadFile;
      workspace.fs.writeFile = originalWriteFile;
      fs.rmSync(metaRoot, { recursive: true, force: true });
    }
  });

  // Regression coverage for a review finding: the gate combining a CLI
  // result's structural authFailure verdict with its hint-stripped
  // authDiagnosticText (runnerRegistry.ts, just above) had every one of its
  // INGREDIENTS unit-tested in isolation (cliFailureClassification.test.ts),
  // but nothing drove an actual CLI failure through runImplementationForModel
  // itself to prove the gate's combination of those ingredients suppresses
  // the backup cascade — so reverting the gate to its pre-fix form
  // (`isAuthenticationFailure(result.errorMessage)` alone) left the full
  // suite green (verified directly against the compiled output).
  //
  // The fixture needs TWO things at once, or the cascade's outer failureKind
  // check makes the auth gate irrelevant either way: (1) opencode's "no
  // provider available" marker, which matches authErrorMarkers
  // (authFailure=true) but matches none of isAuthenticationFailure's own
  // patterns on its own, using an UNQUALIFIED model selection so the
  // appended login hint is the generic "...connect the OpenCode service for
  // this model..." text (which also matches nothing) — so neither the
  // message nor the hint independently trips the regex; and (2) wording
  // that also classifies failureKind "temporarily-unavailable" (here,
  // "service temporarily unavailable"), since the cascade is only reachable
  // at all when failureKind is quota or temporarily-unavailable.
  void it("does not cascade to backup on a CLI auth failure the errorMessage text alone would not catch", async () => {
    const originalSpawn = childProcess.spawn;
    const spawnedCommands: string[] = [];

    childProcess.spawn = ((command: string) => {
      const child = new EventEmitter() as import("node:child_process").ChildProcess;
      Object.defineProperty(child, "pid", { value: 4321 });
      child.stdout = new EventEmitter() as import("node:child_process").ChildProcess["stdout"];
      child.stderr = new EventEmitter() as import("node:child_process").ChildProcess["stderr"];
      child.stdin = Object.assign(new EventEmitter(), {
        write: () => true,
        end: () => undefined,
      }) as unknown as import("node:child_process").ChildProcess["stdin"];

      if (/^(which|where\.exe)$/.test(command)) {
        // The PATH-existence check: report opencode as installed so
        // resolution proceeds to a real invocation.
        process.nextTick(() => child.emit("close", 0));
        return child;
      }

      spawnedCommands.push(command);
      process.nextTick(() => {
        child.stdout?.emit(
          "data",
          Buffer.from(
            `${JSON.stringify({
              type: "error",
              error: {
                name: "APIError",
                data: { message: "No provider available: service temporarily unavailable" },
              },
            })}\n`
          )
        );
        child.emit("close", 1);
      });
      return child;
    }) as typeof childProcess.spawn;

    // The backup is Copilot (LM-stubbed), not a second real CLI provider —
    // simulating a second CLI's own install-check/auth-check/run lifecycle
    // through generic spawn mocking is its own can of worms unrelated to
    // what this test is verifying; an LM stub gives the same yes/no signal
    // ("was the backup attempted at all") far more simply.
    const lm = lmStub();
    const originalSelectChatModels = lm.selectChatModels;
    let backupAttempted = false;
    lm.selectChatModels = (): Promise<vscode.LanguageModelChat[]> =>
      Promise.resolve([
        {
          id: "auto",
          name: "Auto",
          sendRequest: () => {
            backupAttempted = true;
            return Promise.reject(new Error("must not be reached"));
          },
        } as unknown as vscode.LanguageModelChat,
      ]);

    // The backup cascade's own reservation (reserveFallback) needs a real
    // task-progress.json to CAS against, read/written through
    // vscode.workspace.fs — which the global stub does not back with the real
    // filesystem by default. Without this bridge readTaskProgress silently
    // returns undefined, reserveFallback silently declines, and no backup is
    // ever attempted regardless of the auth gate: this test passed vacuously
    // in both directions until this bridge was added (verified directly).
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
    workspace.fs.writeFile = (uri: vscode.Uri, bytes: Uint8Array): Promise<void> =>
      fs.promises.writeFile(uri.fsPath, bytes);

    const metaRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ensemble-impl-auth-gate-")
    );
    const taskFolder = path.join(metaRoot, "tasks", "task-a");
    fs.mkdirSync(taskFolder, { recursive: true });
    const taskFolderUri = vscode.Uri.file(taskFolder);
    // runImplementationWithCli's before/after git snapshot runs against
    // workspaceUri (== taskFolder here). A bare mkdtemp directory under
    // os.tmpdir() can sit beneath an unrelated, much larger git working tree
    // on some machines, in which case `git status --untracked-files=all`
    // walks up and scans THAT tree instead of the empty temp dir — verified
    // directly: this hung for 8+ seconds against real ambient state before
    // being made its own repo. `git init` gives it an immediate, empty
    // status with nothing to walk past.
    childProcess.execSync("git init", { cwd: taskFolder, stdio: "ignore" });
    const now = new Date().toISOString();
    fs.writeFileSync(
      path.join(taskFolder, "task-progress.json"),
      JSON.stringify(
        { taskFolder: "task-a", currentStage: "impl", status: "active", createdAt: now, updatedAt: now },
        null,
        2
      ),
      "utf8"
    );

    try {
      const settings = installModelSettings({
        impl: {
          primary: "opencode-cli:default",
          backup: "auto",
          strategy: "switch-to-backup",
        },
      });
      try {
        const result = await runImplementationForModel({
          modelId: "opencode-cli:default",
          prompt: "Implement the requested change.",
          workspaceUri: taskFolderUri,
          token: new vscode.CancellationTokenSource().token,
          onProgress: () => undefined,
          correlation: { actionKey: "implementation.v1" },
          allowCrossProviderBackups: true,
          stage: "impl",
          taskFolderUri,
        });

        assert.strictEqual(result.status, "failed");
        assert.strictEqual(result.failureKind, "temporarily-unavailable");
        assert.strictEqual(
          backupAttempted,
          false,
          "the backup must never be attempted for an auth failure, regardless of what the bare error text says"
        );
        assert.deepStrictEqual(spawnedCommands, ["opencode"]);
      } finally {
        settings.restore();
      }
    } finally {
      childProcess.spawn = originalSpawn;
      lm.selectChatModels = originalSelectChatModels;
      workspace.fs.readFile = originalReadFile;
      workspace.fs.writeFile = originalWriteFile;
      fs.rmSync(metaRoot, { recursive: true, force: true });
    }
  });

  // Codex review finding (P1): runImplementationOrSealedV1's CLI branch
  // (runEditActionV1.ts) calls this function specifically so a CLI-resolved
  // model never joins the sealed pipeline — but runImplementationForModel's
  // OWN backup cascade could still silently hand off to a configured Copilot
  // backup via runImplementationWithCopilot (the older, unsealed Copilot
  // runner), bypassing runSealedImplementationV1's host gate/preflight/
  // receipts entirely for that backup attempt. allowCrossProviderBackups:
  // false must keep the cascade from ever crossing from a CLI primary to a
  // Copilot backup, unlike the sibling test above (which asserts the SAME
  // "must not reach the backup" outcome, but for a wholly different reason —
  // an authentication failure, which never cascades regardless of kind).
  void it("does not cross from a CLI primary to a Copilot backup when allowCrossProviderBackups is false", async () => {
    const originalSpawn = childProcess.spawn;
    const spawnedCommands: string[] = [];

    childProcess.spawn = ((command: string) => {
      const child = new EventEmitter() as import("node:child_process").ChildProcess;
      Object.defineProperty(child, "pid", { value: 4322 });
      child.stdout = new EventEmitter() as import("node:child_process").ChildProcess["stdout"];
      child.stderr = new EventEmitter() as import("node:child_process").ChildProcess["stderr"];
      child.stdin = Object.assign(new EventEmitter(), {
        write: () => true,
        end: () => undefined,
      }) as unknown as import("node:child_process").ChildProcess["stdin"];

      if (/^(which|where\.exe)$/.test(command)) {
        process.nextTick(() => child.emit("close", 0));
        return child;
      }

      spawnedCommands.push(command);
      process.nextTick(() => {
        child.stdout?.emit(
          "data",
          Buffer.from(
            `${JSON.stringify({
              type: "error",
              error: {
                name: "APIError",
                data: { message: "Rate limit exceeded, try again later." },
              },
            })}\n`
          )
        );
        child.emit("close", 1);
      });
      return child;
    }) as typeof childProcess.spawn;

    const lm = lmStub();
    const originalSelectChatModels = lm.selectChatModels;
    let backupAttempted = false;
    lm.selectChatModels = (): Promise<vscode.LanguageModelChat[]> =>
      Promise.resolve([
        {
          id: "auto",
          name: "Auto",
          sendRequest: () => {
            backupAttempted = true;
            return Promise.reject(new Error("must not be reached"));
          },
        } as unknown as vscode.LanguageModelChat,
      ]);

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
    workspace.fs.writeFile = (uri: vscode.Uri, bytes: Uint8Array): Promise<void> =>
      fs.promises.writeFile(uri.fsPath, bytes);

    const metaRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ensemble-impl-cross-provider-gate-")
    );
    const taskFolder = path.join(metaRoot, "tasks", "task-a");
    fs.mkdirSync(taskFolder, { recursive: true });
    const taskFolderUri = vscode.Uri.file(taskFolder);
    childProcess.execSync("git init", { cwd: taskFolder, stdio: "ignore" });
    const now = new Date().toISOString();
    fs.writeFileSync(
      path.join(taskFolder, "task-progress.json"),
      JSON.stringify(
        { taskFolder: "task-a", currentStage: "impl", status: "active", createdAt: now, updatedAt: now },
        null,
        2
      ),
      "utf8"
    );

    try {
      const settings = installModelSettings({
        impl: {
          primary: "opencode-cli:default",
          backup: "auto",
          strategy: "switch-to-backup",
        },
      });
      try {
        const result = await runImplementationForModel({
          modelId: "opencode-cli:default",
          prompt: "Implement the requested change.",
          workspaceUri: taskFolderUri,
          token: new vscode.CancellationTokenSource().token,
          onProgress: () => undefined,
          correlation: { actionKey: "implementation.v1" },
          allowCrossProviderBackups: false,
          stage: "impl",
          taskFolderUri,
        });

        assert.strictEqual(
          backupAttempted,
          false,
          "a CLI primary must never fail over to a Copilot backup when allowCrossProviderBackups is false"
        );
        assert.strictEqual(result.status, "failed");
        assert.strictEqual(result.runnerId, "opencode-cli");
        assert.deepStrictEqual(spawnedCommands, ["opencode"]);
      } finally {
        settings.restore();
      }
    } finally {
      childProcess.spawn = originalSpawn;
      lm.selectChatModels = originalSelectChatModels;
      workspace.fs.readFile = originalReadFile;
      workspace.fs.writeFile = originalWriteFile;
      fs.rmSync(metaRoot, { recursive: true, force: true });
    }
  });

  // (2e / plan step 17) A quota-or-outage failure that left the working tree
  // DIRTY must never invoke a backup — the zero-changed-files requirement is
  // the cascade's explicit safety boundary (a second model dispatched at a
  // half-edited tree risks mixing two models' edits in one round). An earlier
  // round replaced this with a "handoff" that deliberately ran the backup
  // against the dirty tree; the implementation review rejected that as a
  // reversal of the plan's contract, so this test pins the required shape:
  // the configured, AVAILABLE backup stays uninvoked, and the primary's own
  // failure comes back enriched with an explanation naming the withheld
  // switch and the two real choices (rerun the stage / switch the stage's
  // model). Especially reachable for Cline/Antigravity, whose edit mode
  // keeps every tool auto-approved right up to a timeout/kill, but the gate
  // applies to every provider uniformly (filesChanged is computed the same
  // way for all of them).
  void it("withholds the backup switch and explains why when the primary run already left the working tree dirty", async () => {
    const originalSpawn = childProcess.spawn;

    const metaRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ensemble-impl-dirty-tree-withheld-")
    );
    const taskFolder = path.join(metaRoot, "tasks", "task-a");
    fs.mkdirSync(taskFolder, { recursive: true });
    const taskFolderUri = vscode.Uri.file(taskFolder);
    childProcess.execSync("git init", { cwd: taskFolder, stdio: "ignore" });
    const mutatedFile = path.join(taskFolder, "mutated-by-partial-run.txt");

    childProcess.spawn = ((command: string) => {
      const child = new EventEmitter() as import("node:child_process").ChildProcess;
      Object.defineProperty(child, "pid", { value: 5555 });
      child.stdout = new EventEmitter() as import("node:child_process").ChildProcess["stdout"];
      child.stderr = new EventEmitter() as import("node:child_process").ChildProcess["stderr"];
      child.stdin = Object.assign(new EventEmitter(), {
        write: () => true,
        end: () => undefined,
      }) as unknown as import("node:child_process").ChildProcess["stdin"];

      if (/^(which|where\.exe)$/.test(command)) {
        process.nextTick(() => child.emit("close", 0));
        return child;
      }

      process.nextTick(() => {
        // Simulate the CLI having already written a real file to the
        // workspace — e.g. a shell command it ran — before it goes on to
        // report a transient, cascade-eligible failure. runImplementationWithCli's
        // real before/after `git status` snapshot (execFile, not spawn, so
        // it runs for real against this actual file) is what must catch
        // this and route it into the withheld branch.
        fs.writeFileSync(mutatedFile, "partial edit from a run that then failed");
        // Cline's real --json error shape is a FLAT top-level
        // {"type":"error","message":"..."} line (see extractClineStructuredDiagnostics
        // in cliAgentRunner.ts) — not opencode's nested error.data.message.
        child.stdout?.emit(
          "data",
          Buffer.from(
            `${JSON.stringify({
              type: "error",
              message: "service temporarily unavailable",
            })}\n`
          )
        );
        child.emit("close", 1);
      });
      return child;
    }) as typeof childProcess.spawn;

    const lm = lmStub();
    const originalSelectChatModels = lm.selectChatModels;
    let backupAttempted = false;
    lm.selectChatModels = (): Promise<vscode.LanguageModelChat[]> =>
      Promise.resolve([
        {
          id: "auto",
          name: "Auto",
          sendRequest: () => {
            backupAttempted = true;
            return Promise.reject(new Error("the backup must never run on a dirty tree"));
          },
        } as unknown as vscode.LanguageModelChat,
      ]);

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
    workspace.fs.writeFile = (uri: vscode.Uri, bytes: Uint8Array): Promise<void> =>
      fs.promises.writeFile(uri.fsPath, bytes);

    const progressPath = path.join(taskFolder, "task-progress.json");
    const now = new Date().toISOString();
    fs.writeFileSync(
      progressPath,
      JSON.stringify(
        { taskFolder: "task-a", currentStage: "impl", status: "active", createdAt: now, updatedAt: now },
        null,
        2
      ),
      "utf8"
    );

    const progressMessages: string[] = [];
    try {
      const settings = installModelSettings({
        impl: {
          primary: "cline-cli:default",
          backup: "auto",
          strategy: "switch-to-backup",
        },
      });
      try {
        const result = await runImplementationForModel({
          modelId: "cline-cli:default",
          prompt: "Implement the requested change.",
          workspaceUri: taskFolderUri,
          token: new vscode.CancellationTokenSource().token,
          onProgress: (message: string) => {
            progressMessages.push(message);
          },
          correlation: { actionKey: "implementation.v1" },
          allowCrossProviderBackups: true,
          stage: "impl",
          taskFolderUri,
        });

        assert.strictEqual(
          backupAttempted,
          false,
          "an available backup must never be dispatched at a tree the failed primary already edited"
        );
        assert.strictEqual(result.status, "failed");
        assert.strictEqual(result.failureKind, "temporarily-unavailable");
        assert.ok(
          result.filesChanged.includes("mutated-by-partial-run.txt"),
          "expected the primary run's own file write to survive in the reported filesChanged list"
        );
        assert.match(
          result.errorMessage ?? "",
          /withheld the automatic switch/,
          "expected the failure message to say the backup switch was deliberately withheld"
        );
        assert.match(
          result.errorMessage ?? "",
          /changed 1 file\(s\)/,
          "expected the failure message to name how many files the interrupted round left behind"
        );
        assert.match(
          result.errorMessage ?? "",
          /Rerun this stage.*switch the stage's model/,
          "expected the failure message to offer the two real choices: rerun or switch the model"
        );
        assert.ok(
          progressMessages.some((message) => message.includes("withheld the automatic switch")),
          "expected an explicit progress notification about the withheld backup, not just the returned error"
        );
        const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as {
          fallbackActive?: Partial<Record<string, boolean>>;
          fallbackModelId?: Partial<Record<string, string>>;
        };
        assert.notStrictEqual(
          progress.fallbackActive?.impl,
          true,
          "a withheld switch must not record an active fallback for the stage"
        );
        assert.strictEqual(progress.fallbackModelId?.impl, undefined);
      } finally {
        settings.restore();
      }
    } finally {
      childProcess.spawn = originalSpawn;
      lm.selectChatModels = originalSelectChatModels;
      workspace.fs.readFile = originalReadFile;
      workspace.fs.writeFile = originalWriteFile;
      fs.rmSync(metaRoot, { recursive: true, force: true });
    }
  });

  // (2e) Sibling of the withheld-switch test above: an UNKNOWN file-change
  // state (outside a git repository, or with git unavailable) is treated the
  // same as dirty by the cascade — genuinely not knowing what changed is not
  // evidence the tree is clean — but it takes the plain fall-through rather
  // than the withheld-message branch (a message claiming "N file(s) changed"
  // cannot be written about a tree whose state could not be determined). The
  // backup must stay uninvoked here exactly as it does for a known-dirty
  // tree.
  void it("does not run a backup when the primary's file-change state is unknown", async () => {
    const originalSpawn = childProcess.spawn;

    const metaRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ensemble-impl-unknown-tree-gate-")
    );
    const taskFolder = path.join(metaRoot, "tasks", "task-a");
    // Deliberately NOT a git repository — gitStatusSnapshot's `before` probe
    // must fail, forcing filesChangedUnknown: true.
    fs.mkdirSync(taskFolder, { recursive: true });
    const taskFolderUri = vscode.Uri.file(taskFolder);

    childProcess.spawn = ((command: string) => {
      const child = new EventEmitter() as import("node:child_process").ChildProcess;
      Object.defineProperty(child, "pid", { value: 5556 });
      child.stdout = new EventEmitter() as import("node:child_process").ChildProcess["stdout"];
      child.stderr = new EventEmitter() as import("node:child_process").ChildProcess["stderr"];
      child.stdin = Object.assign(new EventEmitter(), {
        write: () => true,
        end: () => undefined,
      }) as unknown as import("node:child_process").ChildProcess["stdin"];

      if (/^(which|where\.exe)$/.test(command)) {
        process.nextTick(() => child.emit("close", 0));
        return child;
      }

      process.nextTick(() => {
        child.stdout?.emit(
          "data",
          Buffer.from(
            `${JSON.stringify({
              type: "error",
              message: "service temporarily unavailable",
            })}\n`
          )
        );
        child.emit("close", 1);
      });
      return child;
    }) as typeof childProcess.spawn;

    const lm = lmStub();
    const originalSelectChatModels = lm.selectChatModels;
    let backupAttempted = false;
    lm.selectChatModels = (): Promise<vscode.LanguageModelChat[]> =>
      Promise.resolve([
        {
          id: "auto",
          name: "Auto",
          sendRequest: () => {
            backupAttempted = true;
            return Promise.reject(new Error("must not be reached"));
          },
        } as unknown as vscode.LanguageModelChat,
      ]);

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
    workspace.fs.writeFile = (uri: vscode.Uri, bytes: Uint8Array): Promise<void> =>
      fs.promises.writeFile(uri.fsPath, bytes);

    const now = new Date().toISOString();
    fs.writeFileSync(
      path.join(taskFolder, "task-progress.json"),
      JSON.stringify(
        { taskFolder: "task-a", currentStage: "impl", status: "active", createdAt: now, updatedAt: now },
        null,
        2
      ),
      "utf8"
    );

    try {
      const settings = installModelSettings({
        impl: {
          primary: "cline-cli:default",
          backup: "auto",
          strategy: "switch-to-backup",
        },
      });
      try {
        const result = await runImplementationForModel({
          modelId: "cline-cli:default",
          prompt: "Implement the requested change.",
          workspaceUri: taskFolderUri,
          token: new vscode.CancellationTokenSource().token,
          onProgress: () => undefined,
          correlation: { actionKey: "implementation.v1" },
          allowCrossProviderBackups: true,
          stage: "impl",
          taskFolderUri,
        });

        assert.strictEqual(
          backupAttempted,
          false,
          "the backup must never be dispatched when the primary's file-change state could not be determined"
        );
        assert.strictEqual(result.status, "failed");
        assert.strictEqual(result.failureKind, "temporarily-unavailable");
        assert.strictEqual(result.filesChangedUnknown, true);
      } finally {
        settings.restore();
      }
    } finally {
      childProcess.spawn = originalSpawn;
      lm.selectChatModels = originalSelectChatModels;
      workspace.fs.readFile = originalReadFile;
      workspace.fs.writeFile = originalWriteFile;
      fs.rmSync(metaRoot, { recursive: true, force: true });
    }
  });

  // Codex review finding (P1): the sibling test above proves the dirty-tree
  // gate blocks the FIRST cascade hop (primary -> backup #1) when the
  // PRIMARY leaves a mutated tree. It does not prove the same gate applies
  // BETWEEN backups: backup #1 can itself write a file and then fail with
  // its own cascadable (quota/temporarily-unavailable) error, and nothing
  // previously stopped the loop from dispatching backup #2 against that now
  // half-edited tree. Three distinct CLI commands (opencode, cline, codex)
  // so each stage of the cascade is unambiguously attributable.
  void it("does not cross from a CLI backup to a further backup once that backup itself mutates the tree", async () => {
    const originalSpawn = childProcess.spawn;
    const spawnedCommands: string[] = [];

    const metaRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ensemble-impl-backup-to-backup-dirty-gate-")
    );
    const taskFolder = path.join(metaRoot, "tasks", "task-a");
    fs.mkdirSync(taskFolder, { recursive: true });
    const taskFolderUri = vscode.Uri.file(taskFolder);
    childProcess.execSync("git init", { cwd: taskFolder, stdio: "ignore" });
    const mutatedFile = path.join(taskFolder, "mutated-by-backup-one.txt");

    childProcess.spawn = ((command: string) => {
      const child = new EventEmitter() as import("node:child_process").ChildProcess;
      Object.defineProperty(child, "pid", { value: 6001 });
      child.stdout = new EventEmitter() as import("node:child_process").ChildProcess["stdout"];
      child.stderr = new EventEmitter() as import("node:child_process").ChildProcess["stderr"];
      child.stdin = Object.assign(new EventEmitter(), {
        write: () => true,
        end: () => undefined,
      }) as unknown as import("node:child_process").ChildProcess["stdin"];

      if (/^(which|where\.exe)$/.test(command)) {
        process.nextTick(() => child.emit("close", 0));
        return child;
      }

      spawnedCommands.push(command);
      if (command === "opencode") {
        // Primary: a clean, cascadable failure (no file write) — the
        // cascade must legitimately start.
        process.nextTick(() => {
          child.stdout?.emit(
            "data",
            Buffer.from(
              `${JSON.stringify({
                type: "error",
                error: { name: "APIError", data: { message: "service temporarily unavailable" } },
              })}\n`
            )
          );
          child.emit("close", 1);
        });
        return child;
      }
      if (command === "cline") {
        // Backup #1: writes a real file, THEN reports its own cascadable
        // failure — the exact shape the dirty-tree gate must now catch
        // between backups, not only at the primary.
        process.nextTick(() => {
          fs.writeFileSync(mutatedFile, "partial edit from backup #1 that then failed");
          child.stdout?.emit(
            "data",
            Buffer.from(`${JSON.stringify({ type: "error", message: "service temporarily unavailable" })}\n`)
          );
          child.emit("close", 1);
        });
        return child;
      }
      // Backup #2 (codex): must never be reached.
      process.nextTick(() => child.emit("close", 1));
      return child;
    }) as typeof childProcess.spawn;

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
    workspace.fs.writeFile = (uri: vscode.Uri, bytes: Uint8Array): Promise<void> =>
      fs.promises.writeFile(uri.fsPath, bytes);

    const now = new Date().toISOString();
    fs.writeFileSync(
      path.join(taskFolder, "task-progress.json"),
      JSON.stringify(
        { taskFolder: "task-a", currentStage: "impl", status: "active", createdAt: now, updatedAt: now },
        null,
        2
      ),
      "utf8"
    );

    try {
      const settings = installModelSettings({
        impl: {
          primary: "opencode-cli:default",
          backups: ["cline-cli:default", "codex-cli:default"],
          strategy: "switch-to-backup",
        },
      });
      try {
        const result = await runImplementationForModel({
          modelId: "opencode-cli:default",
          prompt: "Implement the requested change.",
          workspaceUri: taskFolderUri,
          token: new vscode.CancellationTokenSource().token,
          onProgress: () => undefined,
          correlation: { actionKey: "implementation.v1" },
          allowCrossProviderBackups: true,
          stage: "impl",
          taskFolderUri,
        });

        assert.deepStrictEqual(
          spawnedCommands,
          ["opencode", "cline"],
          "codex (backup #2) must never be dispatched once backup #1 (cline) itself left the tree dirty"
        );
        assert.strictEqual(result.status, "failed");
        assert.strictEqual(result.failureKind, "temporarily-unavailable");
        assert.ok(
          result.filesChanged.includes("mutated-by-backup-one.txt"),
          "expected backup #1's own file write to be detected and reported"
        );
      } finally {
        settings.restore();
      }
    } finally {
      childProcess.spawn = originalSpawn;
      workspace.fs.readFile = originalReadFile;
      workspace.fs.writeFile = originalWriteFile;
      fs.rmSync(metaRoot, { recursive: true, force: true });
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
        correlation: { actionKey: "implementation.v1" },
        allowCrossProviderBackups: true,
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
