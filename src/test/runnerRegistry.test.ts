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
import { resolveQuotaAccountKeyV1 } from "../config/settings";
import { parseModelSelection, providerAccountIdForModelId } from "../runners/providers";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";

/** Minimal in-memory Memento-backed ExtensionContext stub — mirrors the
 * pattern in quota.test.ts's `createFakeExtensionContext`. */
function createFakeExtensionContextV1(
  store: Map<string, unknown> = new Map()
): { context: vscode.ExtensionContext; store: Map<string, unknown> } {
  const context = {
    globalState: {
      get<T>(key: string, fallback?: T): T {
        return store.has(key) ? (store.get(key) as T) : (fallback as T);
      },
      update(key: string, value: unknown): Promise<void> {
        if (value === undefined) {
          store.delete(key);
        } else {
          store.set(key, value);
        }
        return Promise.resolve();
      },
      keys: (): readonly string[] => Array.from(store.keys()),
      setKeysForSync: (): void => undefined,
    },
  } as unknown as vscode.ExtensionContext;
  return { context, store };
}

const requireModule = createRequire(__filename);
const childProcess = requireModule("node:child_process") as typeof import("node:child_process");

// Same monkey-patch pattern deferredRoundRecovery.test.ts / implRecoveryDispatch.test.ts
// use for the chain-dispatch boundary: `beginImplementationRecoveryV1`'s
// `finishDispatch()` fires `scheduleAutomationChain` with the default deps
// (real `vscode.commands.executeCommand`), and no command handler for
// `vs-code-ai-helper.runImplementationWithAI` is registered in this unit-test
// harness — patched to a no-op for the dirty-tree hand-off tests below so the
// (production-correct) continuation scheduling doesn't reject against an
// unregistered command.
const automationChainModule = requireModule("../utils/automationChain") as Record<string, unknown>;
interface PatchedV1 { restore: () => void }
function patchModule(module: Record<string, unknown>, name: string, replacement: unknown): PatchedV1 {
  const orig = module[name];
  module[name] = replacement;
  return { restore: (): void => { module[name] = orig; } };
}

/**
 * The dirty-tree hand-off's `finishDispatch()` (`implementationRecoveryV1.ts`)
 * unconditionally calls `NotificationRouter.showWarning` — safe in production
 * (initialized once at activation), but this suite never activates the
 * extension, so it must be initialized around the hand-off tests below or
 * that call throws "NotificationRouter is not initialized".
 */
function installNoopNotificationRouterV1(): PatchedV1 {
  initNotificationRouter({ addEntry: () => undefined });
  return { restore: (): void => deactivateNotificationRouter() };
}

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

  // The case above is about an ABSENT copilot key (Copilot predates provider
  // selection, so no key means enabled). An EXPLICIT false is different, and
  // was silently ignored: resolveEffectiveProvider's Copilot branch returned
  // without ever consulting the guard, so a stage with Copilot disabled still
  // resolved to Copilot and invoked it (workflow 5 runs 060/061, 2026-08-18 —
  // every impl-chain entry disabled, reload ruled out stale config, and the
  // round still ran `Provider: Copilot (auto)`).
  void it("blocks a bare/legacy Copilot model id when Copilot is explicitly disabled", () => {
    const stub = installProviderSelection({ "claude-cli": true, copilot: false });
    try {
      assert.throws(
        () => resolveRunnerForModel("gpt-4o", "impl-low-review"),
        /disabled in Provider Selection/
      );
    } finally {
      stub.restore();
    }
  });

  void it("blocks the Copilot \"auto\" selection when Copilot is explicitly disabled", () => {
    // `auto` is the id the observed failure actually resolved with.
    const stub = installProviderSelection({ "claude-cli": true, copilot: false });
    try {
      assert.throws(
        () => resolveRunnerForModel("auto", "impl"),
        /disabled in Provider Selection/
      );
    } finally {
      stub.restore();
    }
  });

  void it("blocks an explicitly qualified copilot: model id when Copilot is disabled", () => {
    const stub = installProviderSelection({ "claude-cli": true, copilot: false });
    try {
      assert.throws(
        () => resolveRunnerForModel("copilot:claude-sonnet-5", "impl"),
        /disabled in Provider Selection/
      );
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

  // Review completion blocker: plan/review text runs only updated the
  // session/global quota ledger via withQuotaObservation — a successful or
  // contradicting-classified retry never cleared a stale task-level
  // quotaParkRecord, unlike the implementation-run path. These three pin
  // withQuotaObservation's new taskFolderUri-threaded clearing behavior:
  // success clears, a genuinely contradicting failure clears, and a
  // cancelled run (no fresh evidence) leaves the record untouched.
  void describe("withQuotaObservation clears a stale task-level quotaParkRecord on fresh evidence", () => {
    function seedProgressWithParkRecord(taskFolder: string, stage: string): string {
      const progressPath = path.join(taskFolder, "task-progress.json");
      const now = new Date().toISOString();
      fs.writeFileSync(
        progressPath,
        JSON.stringify(
          {
            taskFolder: path.basename(taskFolder),
            currentStage: stage,
            status: "active",
            createdAt: now,
            updatedAt: now,
            quotaParkRecord: {
              modelId: "copilot-gpt-5.6-sol",
              providerId: "copilot",
              failureKind: "quota",
              observedAt: now,
            },
          },
          null,
          2
        ),
        "utf8"
      );
      return progressPath;
    }

    void it("a successful run clears the record", async () => {
      const metaRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "ensemble-quota-park-clear-success-")
      );
      const taskFolder = path.join(metaRoot, "tasks", "task-a");
      fs.mkdirSync(taskFolder, { recursive: true });
      const taskFolderUri = vscode.Uri.file(taskFolder);
      const outputFile = vscode.Uri.file(path.join(taskFolder, "plan.md"));
      const progressPath = seedProgressWithParkRecord(taskFolder, "plan");

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
      workspace.fs.writeFile = (uri: vscode.Uri, bytes: Uint8Array): Promise<void> =>
        fs.promises.writeFile(uri.fsPath, bytes);
      lm.selectChatModels = (): Promise<vscode.LanguageModelChat[]> =>
        Promise.resolve([
          {
            id: "copilot-gpt-5.6-sol",
            name: "GPT-5.6",
            sendRequest: () =>
              Promise.resolve({
                text: ["done"] as unknown as AsyncIterable<string>,
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
            workspaceUri: taskFolderUri,
            stage: "plan",
            prompt: "Create a plan.",
            outputFile,
            modelId: "copilot-gpt-5.6-sol",
          },
          new vscode.CancellationTokenSource().token
        );
        assert.strictEqual(result.status, "completed");
        const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as {
          quotaParkRecord?: unknown;
        };
        assert.strictEqual(progress.quotaParkRecord, undefined);
      } finally {
        lm.selectChatModels = originalSelectChatModels;
        workspace.fs.readFile = originalReadFile;
        workspace.fs.writeFile = originalWriteFile;
        fs.rmSync(metaRoot, { recursive: true, force: true });
      }
    });

    void it("a failed run with a contradicting, non-quota/entitlement classification clears the record", async () => {
      const metaRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "ensemble-quota-park-clear-contradict-")
      );
      const taskFolder = path.join(metaRoot, "tasks", "task-a");
      fs.mkdirSync(taskFolder, { recursive: true });
      const taskFolderUri = vscode.Uri.file(taskFolder);
      const outputFile = vscode.Uri.file(path.join(taskFolder, "plan.md"));
      const progressPath = seedProgressWithParkRecord(taskFolder, "plan");

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
      workspace.fs.writeFile = (uri: vscode.Uri, bytes: Uint8Array): Promise<void> =>
        fs.promises.writeFile(uri.fsPath, bytes);
      lm.selectChatModels = (): Promise<vscode.LanguageModelChat[]> =>
        Promise.resolve([
          {
            id: "copilot-gpt-5.6-sol",
            name: "GPT-5.6",
            sendRequest: () => Promise.reject(new Error("service temporarily unavailable")),
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
            workspaceUri: taskFolderUri,
            stage: "plan",
            prompt: "Create a plan.",
            outputFile,
            modelId: "copilot-gpt-5.6-sol",
          },
          new vscode.CancellationTokenSource().token
        );
        assert.strictEqual(result.status, "failed");
        assert.notEqual(result.failureKind, "quota");
        assert.notEqual(result.failureKind, "model-entitlement");
        const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as {
          quotaParkRecord?: unknown;
        };
        assert.strictEqual(progress.quotaParkRecord, undefined);
      } finally {
        lm.selectChatModels = originalSelectChatModels;
        workspace.fs.readFile = originalReadFile;
        workspace.fs.writeFile = originalWriteFile;
        fs.rmSync(metaRoot, { recursive: true, force: true });
      }
    });

    void it("a cancelled run is not fresh evidence and leaves the record in place", async () => {
      const metaRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "ensemble-quota-park-no-clear-cancel-")
      );
      const taskFolder = path.join(metaRoot, "tasks", "task-a");
      fs.mkdirSync(taskFolder, { recursive: true });
      const taskFolderUri = vscode.Uri.file(taskFolder);
      const outputFile = vscode.Uri.file(path.join(taskFolder, "plan.md"));
      const progressPath = seedProgressWithParkRecord(taskFolder, "plan");

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
      workspace.fs.writeFile = (uri: vscode.Uri, bytes: Uint8Array): Promise<void> =>
        fs.promises.writeFile(uri.fsPath, bytes);
      lm.selectChatModels = (): Promise<vscode.LanguageModelChat[]> =>
        Promise.resolve([
          {
            id: "copilot-gpt-5.6-sol",
            name: "GPT-5.6",
            sendRequest: () =>
              Promise.resolve({
                text: ["partial"] as unknown as AsyncIterable<string>,
              }),
          } as unknown as vscode.LanguageModelChat,
        ]);

      const tokenSource = new vscode.CancellationTokenSource();
      tokenSource.cancel();
      try {
        const { runner } = resolveRunnerForModel(
          "copilot-gpt-5.6-sol",
          "plan",
          taskFolderUri
        );
        const result = await runner.run(
          {
            taskFolderUri,
            workspaceUri: taskFolderUri,
            stage: "plan",
            prompt: "Create a plan.",
            outputFile,
            modelId: "copilot-gpt-5.6-sol",
          },
          tokenSource.token
        );
        assert.strictEqual(result.status, "cancelled");
        const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as {
          quotaParkRecord?: unknown;
        };
        assert.ok(progress.quotaParkRecord, "expected the pre-existing quotaParkRecord to survive a cancelled run");
      } finally {
        lm.selectChatModels = originalSelectChatModels;
        workspace.fs.readFile = originalReadFile;
        workspace.fs.writeFile = originalWriteFile;
        fs.rmSync(metaRoot, { recursive: true, force: true });
      }
    });

    // Review completion blocker: clearing previously required only that SOME
    // fresh evidence be associated with the task folder, with no check that
    // it came from the model/provider the persisted record actually blocked.
    // A successful run on a DIFFERENT model must not erase a record about a
    // model that was never retried.
    void it("a successful run on a DIFFERENT model than the parked record leaves it in place", async () => {
      const metaRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "ensemble-quota-park-no-clear-mismatch-")
      );
      const taskFolder = path.join(metaRoot, "tasks", "task-a");
      fs.mkdirSync(taskFolder, { recursive: true });
      const taskFolderUri = vscode.Uri.file(taskFolder);
      const outputFile = vscode.Uri.file(path.join(taskFolder, "plan.md"));
      const progressPath = seedProgressWithParkRecord(taskFolder, "plan");

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
      workspace.fs.writeFile = (uri: vscode.Uri, bytes: Uint8Array): Promise<void> =>
        fs.promises.writeFile(uri.fsPath, bytes);
      lm.selectChatModels = (): Promise<vscode.LanguageModelChat[]> =>
        Promise.resolve([
          {
            id: "copilot-gpt-5.6-mini",
            name: "GPT-5.6 mini",
            sendRequest: () =>
              Promise.resolve({
                text: ["done"] as unknown as AsyncIterable<string>,
              }),
          } as unknown as vscode.LanguageModelChat,
        ]);

      try {
        // The seeded record blocks "copilot-gpt-5.6-sol"; this run uses a
        // different model id ("copilot-gpt-5.6-mini") entirely.
        const { runner } = resolveRunnerForModel(
          "copilot-gpt-5.6-mini",
          "plan",
          taskFolderUri
        );
        const result = await runner.run(
          {
            taskFolderUri,
            workspaceUri: taskFolderUri,
            stage: "plan",
            prompt: "Create a plan.",
            outputFile,
            modelId: "copilot-gpt-5.6-mini",
          },
          new vscode.CancellationTokenSource().token
        );
        assert.strictEqual(result.status, "completed");
        const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as {
          quotaParkRecord?: unknown;
        };
        assert.ok(
          progress.quotaParkRecord,
          "expected the parked record for a DIFFERENT model to survive an unrelated model's successful run"
        );
      } finally {
        lm.selectChatModels = originalSelectChatModels;
        workspace.fs.readFile = originalReadFile;
        workspace.fs.writeFile = originalWriteFile;
        fs.rmSync(metaRoot, { recursive: true, force: true });
      }
    });
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

  // New review completion blocker: unlike the no-backups `withQuotaObservation`
  // path and the implementation cascade (both of which capture the account
  // key before dispatch), this primary-with-backups-configured branch called
  // `recordQuotaObservation` with no override, so it re-resolved the account
  // key from live settings AFTER `primary.run` had already completed. A label
  // edit mid-run split one attempt's ledger write across two identities.
  void it("captures the account key before the primary dispatches when backups are configured, so a mid-run label edit does not split the ledger write", async () => {
    const metaRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ensemble-quota-primary-with-backups-")
    );
    const taskFolder = path.join(metaRoot, "tasks", "task-a");
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

    let labels: Record<string, string> = {};
    const originalGetConfiguration = vscode.workspace.getConfiguration;
    (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = ((
      section?: string
    ) => {
      if (section !== "ensemble") {
        return originalGetConfiguration(section);
      }
      return {
        get: (key: string, defaultValue?: unknown): unknown => {
          if (key === "modelSettings") {
            return {
              plan: {
                primary: "copilot-gpt-5.6-sol",
                backup: "kiro-cli:default",
                strategy: "switch-to-backup",
              },
            };
          }
          if (key === "providerAccountLabels") {
            return labels;
          }
          return defaultValue;
        },
        inspect: () => undefined,
        update: () => Promise.resolve(),
      } as unknown as ReturnType<typeof originalGetConfiguration>;
    }) as typeof originalGetConfiguration;

    const { context, store } = createFakeExtensionContextV1();
    __extensionContextV1TestOnly.set(context);

    const modelId = "copilot-gpt-5.6-sol";
    const preRunAccountKey = resolveQuotaAccountKeyV1(modelId);

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
    workspace.fs.writeFile = (uri: vscode.Uri, bytes: Uint8Array): Promise<void> =>
      fs.promises.writeFile(uri.fsPath, bytes);
    // The backup ("kiro-cli:default") never actually needs to run for this
    // test — the primary's own quota failure and ledger write happen before
    // the cascade reaches it — but its availability check spawns a real
    // process unless stubbed, so keep it a fast, deterministic "unavailable".
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
          id: "copilot-gpt-5.6-sol",
          name: "GPT-5.6",
          sendRequest: () => {
            // Simulate the user editing the account label WHILE this
            // attempt is in flight — the same race the review flagged.
            labels = { ...labels, [providerAccountIdForModelId(modelId)]: "work" };
            return Promise.reject(
              new Error("You've hit your usage limit · resets in 8h")
            );
          },
        } as unknown as vscode.LanguageModelChat,
      ]);

    try {
      const { runner } = resolveRunnerForModel(modelId, "plan", taskFolderUri);
      const result = await runner.run(
        {
          taskFolderUri,
          workspaceUri: taskFolderUri,
          stage: "plan",
          prompt: "Create a plan.",
          outputFile,
          modelId,
        },
        new vscode.CancellationTokenSource().token
      );
      assert.strictEqual(result.status, "failed");

      const postRunAccountKey = resolveQuotaAccountKeyV1(modelId);
      assert.notStrictEqual(
        postRunAccountKey,
        preRunAccountKey,
        "the label mutation inside sendRequest must actually change what a fresh resolve would return"
      );

      const ledger = store.get("ensembleQuotaLedgerV1") as
        | Record<string, unknown>
        | undefined;
      const providerId = parseModelSelection(modelId).provider;
      assert.ok(
        ledger?.[`${providerId}::${preRunAccountKey}::${modelId}`],
        "expected the ledger write to use the account key captured before dispatch"
      );
      assert.strictEqual(
        ledger?.[`${providerId}::${postRunAccountKey}::${modelId}`],
        undefined,
        "the mid-run label edit must not split this attempt's ledger write onto a second identity"
      );
    } finally {
      vscode.workspace.getConfiguration = originalGetConfiguration;
      lm.selectChatModels = originalSelectChatModels;
      childProcess.spawn = originalSpawn;
      workspace.fs.readFile = originalReadFile;
      workspace.fs.writeFile = originalWriteFile;
      __extensionContextV1TestOnly.set(undefined);
      fs.rmSync(metaRoot, { recursive: true, force: true });
    }
  });

  // Code-review non-blocking suggestion (Part 5): the test above
  // ("captures the account key before the primary dispatches...") only
  // proves the ledger write uses the pre-dispatch identity — it never seeds a
  // `quotaParkRecord` at all, so it says nothing about whether a matching
  // pre-existing park record actually gets CLEARED when the primary succeeds
  // through this same backup-configured branch of `resolveRunnerForModel`
  // (the branch that dispatches the primary and each backup directly, not
  // through `withQuotaObservation` — see `recordQuotaObservationAndClearParkV1`'s
  // own doc comment for why that branch needed its own park-clearing wiring).
  // This is the direct regression test for that: seed a `quotaParkRecord`
  // whose providerId/modelId/accountKey match exactly what THIS run's primary
  // will use, run a backup-configured stage where the primary succeeds
  // outright, and assert the record is gone afterward.
  void it("clears a matching pre-seeded quotaParkRecord when the primary succeeds through the backup-configured branch", async () => {
    const metaRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ensemble-quota-park-clear-")
    );
    const taskFolder = path.join(metaRoot, "tasks", "task-a");
    fs.mkdirSync(taskFolder, { recursive: true });
    const taskFolderUri = vscode.Uri.file(taskFolder);
    const outputFile = vscode.Uri.file(path.join(taskFolder, "plan.md"));
    const progressPath = path.join(taskFolder, "task-progress.json");
    const now = new Date().toISOString();
    const modelId = "copilot-gpt-5.6-sol";
    const providerId = parseModelSelection(modelId).provider;
    const accountKey = resolveQuotaAccountKeyV1(modelId);
    fs.writeFileSync(
      progressPath,
      JSON.stringify(
        {
          taskFolder: path.basename(taskFolder),
          currentStage: "plan",
          status: "active",
          createdAt: now,
          updatedAt: now,
          quotaParkRecord: {
            modelId,
            providerId,
            accountKey,
            failureKind: "quota",
            resetAt: new Date(Date.now() + 3_600_000).toISOString(),
            observedAt: now,
          },
        },
        null,
        2
      ),
      "utf8"
    );

    const settings = installModelSettings({
      plan: {
        primary: modelId,
        backup: "kiro-cli:default",
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
    workspace.fs.writeFile = (uri: vscode.Uri, bytes: Uint8Array): Promise<void> =>
      fs.promises.writeFile(uri.fsPath, bytes);
    // The backup never needs to actually run — the primary succeeds
    // outright — but stub it fast/deterministic regardless.
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
          id: modelId,
          name: "GPT-5.6",
          sendRequest: () =>
            Promise.resolve({
              text: ["a fresh, successful plan"] as unknown as AsyncIterable<string>,
            }),
        } as unknown as vscode.LanguageModelChat,
      ]);

    try {
      const { runner } = resolveRunnerForModel(modelId, "plan", taskFolderUri);
      const result = await runner.run(
        {
          taskFolderUri,
          workspaceUri: taskFolderUri,
          stage: "plan",
          prompt: "Create a plan.",
          outputFile,
          modelId,
        },
        new vscode.CancellationTokenSource().token
      );
      assert.strictEqual(result.status, "completed");

      const persisted = JSON.parse(fs.readFileSync(progressPath, "utf8")) as {
        quotaParkRecord?: unknown;
      };
      assert.strictEqual(
        persisted.quotaParkRecord,
        undefined,
        "a matching pre-seeded quotaParkRecord must be cleared once the primary succeeds"
      );
    } finally {
      settings.restore();
      lm.selectChatModels = originalSelectChatModels;
      childProcess.spawn = originalSpawn;
      workspace.fs.readFile = originalReadFile;
      workspace.fs.writeFile = originalWriteFile;
      fs.rmSync(metaRoot, { recursive: true, force: true });
    }
  });
});

void describe("runImplementationForModel", () => {
  // wf10 item 3 / Part 5 step 13: a Copilot-resolved backup (here the bare
  // legacy id "auto") must NEVER be selected by this automatic availability
  // walk — Copilot implementation runs go through the sealed two-phase
  // preflight pipeline, which both wf9 and jester observed landing on
  // reliably ("available") while reliably producing zero-file rounds when
  // reached this way. This test previously asserted the OLD behavior (the
  // walk silently succeeding on the Copilot backup); it now asserts the
  // opposite — the primary's own unavailability is reported honestly instead
  // of being masked by an excluded backup.
  void it("does not fall through to a Copilot-resolved backup — reports the primary's own unavailability instead", async () => {
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
      assert.equal(availability.available, false);
      assert.notEqual(providerLabel, "Copilot");
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

  // (2e / plan step 17, superseded by Plan Part 15 / item 7b, review
  // completion blocker 2026-09-01) A quota-or-outage failure that left the
  // working tree DIRTY must never invoke a backup INLINE against that
  // half-edited tree — that hazard stays closed, and this test still pins
  // `backupAttempted === false` for exactly that reason. What changed: the
  // AVAILABLE backup no longer stays withheld outright. The primary's edits
  // are quarantined, the source round is terminalized with a continuation
  // owed, and the backup is recorded as this stage's sticky fallback so a
  // FRESH, bounded `inspect-and-complete` continuation round — never this
  // failed attempt resumed, and never the backup invoked synchronously here
  // — finishes the work. Especially reachable for Cline/Antigravity, whose
  // edit mode keeps every tool auto-approved right up to a timeout/kill, but
  // the gate applies to every provider uniformly (filesChanged is computed
  // the same way for all of them).
  void it("hands a dirty-tree cascade-eligible failure to the backup as an inspect-and-complete continuation, never invoked inline", async () => {
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
    const chainPatch = patchModule(automationChainModule, "scheduleAutomationChain", (): Promise<boolean> =>
      Promise.resolve(true)
    );
    const routerPatch = installNoopNotificationRouterV1();
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
          "an available backup must never be invoked INLINE at a tree the failed primary already edited"
        );
        assert.strictEqual(result.status, "failed");
        assert.strictEqual(result.failureKind, "temporarily-unavailable");
        assert.ok(
          result.filesChanged.includes("mutated-by-partial-run.txt"),
          "expected the primary run's own file write to survive in the reported filesChanged list — the " +
            "hand-off must never revert the primary's edits"
        );
        assert.match(
          result.errorMessage ?? "",
          /handed the work to Copilot in inspect-and-complete mode/,
          "expected the failure message to name the backup and the inspect-and-complete mode"
        );
        assert.match(
          result.errorMessage ?? "",
          /changed 1 file\(s\)/,
          "expected the failure message to name how many files the interrupted round left behind"
        );
        assert.ok(
          progressMessages.some((message) => message.includes("handed the work to Copilot")),
          "expected an explicit progress notification about the hand-off, not just the returned error"
        );
        const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as {
          fallbackActive?: Partial<Record<string, boolean>>;
          fallbackModelId?: Partial<Record<string, string>>;
          pendingImplReviewFiles?: string[];
          implRecovery?: {
            trigger?: string;
            mode?: string;
            dispatch?: string;
          };
        };
        assert.strictEqual(
          progress.fallbackActive?.impl,
          true,
          "the hand-off must record an active sticky fallback for the stage so the scheduled " +
            "continuation resolves to the backup"
        );
        assert.strictEqual(progress.fallbackModelId?.impl, "auto");
        assert.ok(
          progress.pendingImplReviewFiles?.includes("mutated-by-partial-run.txt"),
          "expected the primary's edits to be quarantined for the continuation round"
        );
        assert.strictEqual(progress.implRecovery?.trigger, "providerFailedMidRound");
        assert.strictEqual(progress.implRecovery?.mode, "inspect-and-complete");
        assert.strictEqual(progress.implRecovery?.dispatch, "pending");
      } finally {
        settings.restore();
      }
    } finally {
      routerPatch.restore();
      chainPatch.restore();
      childProcess.spawn = originalSpawn;
      lm.selectChatModels = originalSelectChatModels;
      workspace.fs.readFile = originalReadFile;
      workspace.fs.writeFile = originalWriteFile;
      fs.rmSync(metaRoot, { recursive: true, force: true });
    }
  });

  // (2e / plan step 17, Part 15 / item 7b) The withheld-switch explanation
  // stays reachable when a backup IS configured (`chainWantsBackup` true, so
  // the hand-off resolution loop runs) but nothing in it is actually
  // AVAILABLE — the default `lm.selectChatModels` stub returns `[]` (no
  // override installed below), so the bare/legacy "auto" backup resolves to
  // Copilot with zero models and `checkImplementationAvailabilityForModel`
  // reports it unavailable. The hand-off loop finds no candidate and falls
  // through to the pre-existing withheld-cascade branch unchanged.
  void it("still withholds the switch and explains why when a dirty-tree failure has no backup available to hand off to", async () => {
    const originalSpawn = childProcess.spawn;

    const metaRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ensemble-impl-dirty-tree-no-backup-")
    );
    const taskFolder = path.join(metaRoot, "tasks", "task-a");
    fs.mkdirSync(taskFolder, { recursive: true });
    const taskFolderUri = vscode.Uri.file(taskFolder);
    childProcess.execSync("git init", { cwd: taskFolder, stdio: "ignore" });
    const mutatedFile = path.join(taskFolder, "mutated-by-partial-run.txt");

    childProcess.spawn = ((command: string) => {
      const child = new EventEmitter() as import("node:child_process").ChildProcess;
      Object.defineProperty(child, "pid", { value: 5558 });
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
        fs.writeFileSync(mutatedFile, "partial edit from a run that then failed");
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
      // A backup IS configured (`chainWantsBackup` true) but never made
      // available — no `lm.selectChatModels` override is installed for this
      // test, so the default stub's `[]` makes "auto" resolve unavailable.
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
          implRecovery?: unknown;
        };
        assert.notStrictEqual(
          progress.fallbackActive?.impl,
          true,
          "a withheld switch must not record an active fallback for the stage"
        );
        assert.strictEqual(progress.fallbackModelId?.impl, undefined);
        assert.strictEqual(
          progress.implRecovery,
          undefined,
          "no backup was available to hand off to, so no recovery continuation should be recorded"
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

  // Review blocker 2026-09-01 (Part 15 / Step 40, narrowed): the two hand-off
  // tests above only ever fail the PRIMARY. Neither proves what happens when
  // the BACKUP a hand-off just dispatched into (as its own scheduled
  // `inspect-and-complete` continuation) itself later fails mid-round on a
  // dirty tree — the plan's own test bullet requires that case to "fall to
  // the next chain entry or stop with the never-switch sentence", not loop or
  // dispatch a stale identity. `runImplementationForModel`'s hand-off branch
  // is generic over `options.modelId` (it excludes only that one id from the
  // backup search, never accumulating a "already tried" set beyond it), so
  // calling it directly with `modelId` set to the FIRST backup reproduces
  // exactly the shape a claimed continuation would present when it fails
  // again: this test proves that case hands off a SECOND time to the next
  // configured backup, never invoking it inline against the now-doubly-dirty
  // tree, and never getting stuck retrying the same identity.
  void it("hands off to the NEXT configured backup when a backup itself fails mid-round on a dirty tree", async () => {
    const originalSpawn = childProcess.spawn;

    const metaRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ensemble-impl-dirty-tree-second-handoff-")
    );
    const taskFolder = path.join(metaRoot, "tasks", "task-a");
    fs.mkdirSync(taskFolder, { recursive: true });
    const taskFolderUri = vscode.Uri.file(taskFolder);
    childProcess.execSync("git init", { cwd: taskFolder, stdio: "ignore" });
    const mutatedFile = path.join(taskFolder, "mutated-by-backup-one.txt");
    let codexInvokedWithRealWork = false;

    childProcess.spawn = ((command: string) => {
      const child = new EventEmitter() as import("node:child_process").ChildProcess;
      Object.defineProperty(child, "pid", { value: 5559 });
      child.stdout = new EventEmitter() as import("node:child_process").ChildProcess["stdout"];
      child.stderr = new EventEmitter() as import("node:child_process").ChildProcess["stderr"];
      child.stdin = Object.assign(new EventEmitter(), {
        write: () => true,
        end: () => undefined,
      }) as unknown as import("node:child_process").ChildProcess["stdin"];

      if (/^(which|where\.exe)$/.test(command)) {
        // Both "cline" (the model under test here) and "codex" (the next
        // configured backup) report as installed, so the hand-off's
        // availability check finds codex a real, selectable candidate.
        process.nextTick(() => child.emit("close", 0));
        return child;
      }

      if (command === "cline") {
        // This model is itself already running as a claimed continuation
        // (a prior hand-off's backup) — it writes a real file, then reports
        // its own cascade-eligible failure.
        process.nextTick(() => {
          fs.writeFileSync(mutatedFile, "partial edit from a backup that itself then failed");
          child.stdout?.emit(
            "data",
            Buffer.from(
              `${JSON.stringify({ type: "error", message: "service temporarily unavailable" })}\n`
            )
          );
          child.emit("close", 1);
        });
        return child;
      }

      // "codex" must never be dispatched to do real work here — only its
      // availability (`which`/`where.exe`) may be probed, handled above.
      codexInvokedWithRealWork = true;
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
          // This model is already the stage's active sticky fallback, as a
          // prior hand-off would have left it — the exact starting state a
          // claimed continuation for "cline-cli:default" actually runs under.
          fallbackActive: { impl: true },
          fallbackModelId: { impl: "cline-cli:default" },
        },
        null,
        2
      ),
      "utf8"
    );

    const chainPatch = patchModule(automationChainModule, "scheduleAutomationChain", (): Promise<boolean> =>
      Promise.resolve(true)
    );
    const routerPatch = installNoopNotificationRouterV1();
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
          codexInvokedWithRealWork,
          false,
          "the next backup must never be invoked INLINE against the tree the failing backup already edited"
        );
        assert.strictEqual(result.status, "failed");
        assert.strictEqual(result.failureKind, "temporarily-unavailable");
        assert.ok(
          result.filesChanged.includes("mutated-by-backup-one.txt"),
          "expected the failing backup's own file write to survive in the reported filesChanged list"
        );
        assert.match(
          result.errorMessage ?? "",
          /handed the work to (OpenAI Codex|Codex)/,
          "expected the failure message to name the NEXT backup in the chain, not stop or repeat the same one"
        );

        const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as {
          fallbackActive?: Partial<Record<string, boolean>>;
          fallbackModelId?: Partial<Record<string, string>>;
          pendingImplReviewFiles?: string[];
          implRecovery?: { trigger?: string; mode?: string; dispatch?: string };
        };
        assert.strictEqual(
          progress.fallbackActive?.impl,
          true,
          "the second hand-off must keep the stage's sticky fallback active"
        );
        assert.strictEqual(
          progress.fallbackModelId?.impl,
          "codex-cli:default",
          "the sticky fallback must move on to the NEXT chain entry, not stay pinned on the backup that just failed"
        );
        assert.ok(
          progress.pendingImplReviewFiles?.includes("mutated-by-backup-one.txt"),
          "expected the failing backup's own edits to be quarantined for the next continuation round"
        );
        assert.strictEqual(progress.implRecovery?.trigger, "providerFailedMidRound");
        assert.strictEqual(progress.implRecovery?.mode, "inspect-and-complete");
        assert.strictEqual(progress.implRecovery?.dispatch, "pending");
      } finally {
        settings.restore();
      }
    } finally {
      routerPatch.restore();
      chainPatch.restore();
      childProcess.spawn = originalSpawn;
      workspace.fs.readFile = originalReadFile;
      workspace.fs.writeFile = originalWriteFile;
      fs.rmSync(metaRoot, { recursive: true, force: true });
    }
  });

  // Sibling of the two hand-off tests above: when a backup fails mid-round on
  // a dirty tree and NO further backup remains in the chain, the mechanism
  // must stop with the same never-switch/withheld-switch sentence the
  // primary-with-no-backup case uses — never loop, never silently drop the
  // failure. Single-backup chain, so once "cline" (the model under test,
  // itself already a claimed continuation) fails dirty there is nothing left
  // to hand off to.
  void it("stops with the withheld-switch sentence when a backup fails mid-round on a dirty tree with no further backup configured", async () => {
    const originalSpawn = childProcess.spawn;

    const metaRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ensemble-impl-dirty-tree-second-handoff-exhausted-")
    );
    const taskFolder = path.join(metaRoot, "tasks", "task-a");
    fs.mkdirSync(taskFolder, { recursive: true });
    const taskFolderUri = vscode.Uri.file(taskFolder);
    childProcess.execSync("git init", { cwd: taskFolder, stdio: "ignore" });
    const mutatedFile = path.join(taskFolder, "mutated-by-backup-one.txt");

    childProcess.spawn = ((command: string) => {
      const child = new EventEmitter() as import("node:child_process").ChildProcess;
      Object.defineProperty(child, "pid", { value: 5560 });
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
        fs.writeFileSync(mutatedFile, "partial edit from a backup that itself then failed");
        child.stdout?.emit(
          "data",
          Buffer.from(
            `${JSON.stringify({ type: "error", message: "service temporarily unavailable" })}\n`
          )
        );
        child.emit("close", 1);
      });
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
          fallbackActive: { impl: true },
          fallbackModelId: { impl: "cline-cli:default" },
        },
        null,
        2
      ),
      "utf8"
    );

    try {
      const settings = installModelSettings({
        impl: {
          primary: "opencode-cli:default",
          backups: ["cline-cli:default"],
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

        assert.strictEqual(result.status, "failed");
        assert.strictEqual(result.failureKind, "temporarily-unavailable");
        assert.match(
          result.errorMessage ?? "",
          /withheld the automatic switch/,
          "with no further chain entry available, the second failure must stop with the same " +
            "withheld-switch sentence the no-backup case uses"
        );

        const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as {
          fallbackActive?: Partial<Record<string, boolean>>;
          fallbackModelId?: Partial<Record<string, string>>;
          implRecovery?: unknown;
        };
        assert.strictEqual(
          progress.implRecovery,
          undefined,
          "no further backup was available, so no second recovery continuation should be recorded"
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

  // Plan Part 14 (item 8, "stage chat as a record of work"): the withheld-
  // switch explanation used to be attached only inside the non-auth branches
  // of this same guard, so an authentication failure that ALSO classifies
  // into a cascade-eligible failureKind (e.g. its message also carries quota
  // wording — classifyFailure's quota check is deliberately auth-independent,
  // see quota.ts) left the dirty-tree-withheld round with NO explanation at
  // all: the switch was withheld exactly as for the quota case, but only the
  // quota case said so. This pins the fix: the same "changed N file(s), so
  // Ensemble withheld the automatic switch" sentence must appear for an auth
  // failure too, worded for authentication rather than a resettable limit.
  void it("explains the withheld backup switch for an authentication failure that left the working tree dirty, not just for quota", async () => {
    const originalSpawn = childProcess.spawn;

    const metaRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ensemble-impl-dirty-tree-auth-withheld-")
    );
    const taskFolder = path.join(metaRoot, "tasks", "task-a");
    fs.mkdirSync(taskFolder, { recursive: true });
    const taskFolderUri = vscode.Uri.file(taskFolder);
    childProcess.execSync("git init", { cwd: taskFolder, stdio: "ignore" });
    const mutatedFile = path.join(taskFolder, "mutated-by-partial-run.txt");

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
        fs.writeFileSync(mutatedFile, "partial edit from a run that then failed authentication");
        // Deliberately carries BOTH a QUOTA_MARKERS phrase ("rate limit" —
        // classifyFailure's quota check is unconditional/auth-independent)
        // AND an auth-regex match ("403"/"sign in"), so this reproduces the
        // exact real-world combination: a cascade-eligible failureKind that
        // is ALSO an authentication failure.
        child.stdout?.emit(
          "data",
          Buffer.from(
            `${JSON.stringify({
              type: "error",
              message: "rate limit exceeded — 403 unauthorized, please sign in again",
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
            return Promise.reject(new Error("the backup must never run on an authentication failure"));
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
          "a backup must never be dispatched at a tree an authentication failure already edited"
        );
        assert.strictEqual(result.status, "failed");
        assert.strictEqual(result.authFailure, true);
        assert.ok(
          result.filesChanged.includes("mutated-by-partial-run.txt"),
          "expected the primary run's own file write to survive in the reported filesChanged list"
        );
        assert.match(
          result.errorMessage ?? "",
          /Hit an authentication failure/,
          "expected the failure message to explain this was an authentication failure"
        );
        assert.match(
          result.errorMessage ?? "",
          /changed 1 file\(s\)/,
          "expected the failure message to name how many files the interrupted round left behind"
        );
        assert.match(
          result.errorMessage ?? "",
          /withheld the automatic switch to this stage's backup model/,
          "expected the same withheld-switch sentence the quota path already carries"
        );
        assert.ok(
          progressMessages.some((message) => message.includes("Hit an authentication failure")),
          "expected an explicit progress notification, not just the returned error"
        );
        const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as {
          quotaParkRecord?: unknown;
        };
        assert.strictEqual(
          progress.quotaParkRecord,
          undefined,
          "an authentication failure must never record a durable quota-park block — there is no reset time to wait out"
        );
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

  // Review completion blocker (2026-09-01, plan Part 14 item 8 revisited):
  // the test above deliberately combines "rate limit exceeded" (a
  // QUOTA_MARKERS phrase) with the 403/sign-in wording, which makes
  // classifyFailure land on failureKind "quota" regardless of the auth
  // verdict — that failureKind alone was already enough to satisfy the old
  // gate (`isCascadeEligibleFailureKind`), so it never actually exercised the
  // case the gate excluded. This test uses the exact wf10 run-042 message —
  // "403 Unable to verify organization membership" — which carries NO quota
  // or temporary-outage vocabulary at all, so classifyFailure puts it in
  // "generic" (cascade-ineligible). Before this fix, `authFailure` alone
  // could not open the explanation block, and this exact real-world failure
  // fell straight through with no explanation whatsoever — the precise
  // defect item 8 was written to close, reproduced here without borrowing
  // quota wording to get in the door.
  void it("explains the withheld backup switch for a pure authentication failure with no quota/outage wording at all", async () => {
    const originalSpawn = childProcess.spawn;

    const metaRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ensemble-impl-dirty-tree-pure-auth-withheld-")
    );
    const taskFolder = path.join(metaRoot, "tasks", "task-a");
    fs.mkdirSync(taskFolder, { recursive: true });
    const taskFolderUri = vscode.Uri.file(taskFolder);
    childProcess.execSync("git init", { cwd: taskFolder, stdio: "ignore" });
    const mutatedFile = path.join(taskFolder, "mutated-by-partial-run.txt");

    childProcess.spawn = ((command: string) => {
      const child = new EventEmitter() as import("node:child_process").ChildProcess;
      Object.defineProperty(child, "pid", { value: 5557 });
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
        fs.writeFileSync(mutatedFile, "partial edit from a run that then failed authentication");
        child.stdout?.emit(
          "data",
          Buffer.from(
            `${JSON.stringify({
              type: "error",
              message: "403 Unable to verify organization membership",
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
            return Promise.reject(new Error("the backup must never run on an authentication failure"));
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
          "a backup must never be dispatched at a tree an authentication failure already edited"
        );
        assert.strictEqual(result.status, "failed");
        assert.strictEqual(result.authFailure, true);
        assert.ok(
          result.filesChanged.includes("mutated-by-partial-run.txt"),
          "expected the primary run's own file write to survive in the reported filesChanged list"
        );
        assert.match(
          result.errorMessage ?? "",
          /Hit an authentication failure/,
          "a PURE auth failure (no quota/outage wording) must still get the explanation, not fall through silently"
        );
        assert.match(
          result.errorMessage ?? "",
          /changed 1 file\(s\)/,
          "expected the failure message to name how many files the interrupted round left behind"
        );
        assert.match(
          result.errorMessage ?? "",
          /withheld the automatic switch to this stage's backup model/,
          "expected the same withheld-switch sentence the quota path already carries"
        );
        assert.ok(
          progressMessages.some((message) => message.includes("Hit an authentication failure")),
          "expected an explicit progress notification, not just the returned error"
        );
        const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as {
          quotaParkRecord?: unknown;
        };
        assert.strictEqual(
          progress.quotaParkRecord,
          undefined,
          "an authentication failure must never record a durable quota-park block — there is no reset time to wait out"
        );
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

  // Review completion blocker (2026-09-01, plan Part 14 item 8 revisited):
  // `chainWantsBackup` is false both when no backup is configured at all AND
  // when the stage's strategy is `never-switch` — before this fix both cases
  // rendered the same "no backup model is configured" sentence, which is
  // simply false when a chain IS configured but the setting says never to
  // use it. This test configures a real backup chain under `never-switch`
  // and asserts the explanation names the setting, not an absent chain.
  void it("names the Never switch setting (not 'no backup configured') when a chain exists but the stage never switches", async () => {
    const originalSpawn = childProcess.spawn;

    const metaRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ensemble-impl-never-switch-withheld-")
    );
    const taskFolder = path.join(metaRoot, "tasks", "task-a");
    fs.mkdirSync(taskFolder, { recursive: true });
    const taskFolderUri = vscode.Uri.file(taskFolder);
    childProcess.execSync("git init", { cwd: taskFolder, stdio: "ignore" });

    childProcess.spawn = ((command: string) => {
      const child = new EventEmitter() as import("node:child_process").ChildProcess;
      Object.defineProperty(child, "pid", { value: 5558 });
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
              message: "monthly limit reached, resets in 8d 19h, please try again later",
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
            return Promise.reject(new Error("never-switch must never dispatch the backup"));
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

    try {
      const settings = installModelSettings({
        impl: {
          primary: "cline-cli:default",
          backup: "auto",
          strategy: "never-switch",
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

        assert.strictEqual(backupAttempted, false, "never-switch must never dispatch the configured backup");
        assert.strictEqual(result.status, "failed");
        assert.match(
          result.errorMessage ?? "",
          /Never switch/,
          "expected the explanation to name the Never switch setting, not claim nothing is configured"
        );
        assert.doesNotMatch(
          result.errorMessage ?? "",
          /no backup model is configured/,
          "a chain IS configured here — only the setting withholds it, which is a different fact"
        );
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

  // Review completion blocker (2026-09-01, round 2, plan Part 14 item 8
  // revisited a second time): the final fallthrough's own gate used to
  // require `authFailure || isCascadeEligibleFailureKind(result.failureKind)`
  // — which excludes a non-authentication "generic" failure just as
  // completely as it once excluded a pure auth failure (the round-1 fix
  // above). A malformed/unexplained failure with NO quota, outage, entitlement
  // or auth wording at all — one that changed files, with a real backup chain
  // configured and a clean-tree cascade never even attempted because
  // `isCascadeEligibleFailureKind` excludes "generic" outright — used to fall
  // straight through with the raw, unexplained provider error and no
  // indication that a backup exists but was never going to be tried for this
  // kind of failure. This is the direct regression test for that gap.
  void it("explains that a non-cascade-eligible generic failure is never retried against a backup, even with a chain configured and files changed", async () => {
    const originalSpawn = childProcess.spawn;

    const metaRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ensemble-impl-generic-not-cascade-eligible-")
    );
    const taskFolder = path.join(metaRoot, "tasks", "task-a");
    fs.mkdirSync(taskFolder, { recursive: true });
    const taskFolderUri = vscode.Uri.file(taskFolder);
    childProcess.execSync("git init", { cwd: taskFolder, stdio: "ignore" });
    const mutatedFile = path.join(taskFolder, "mutated-by-partial-run.txt");

    childProcess.spawn = ((command: string) => {
      const child = new EventEmitter() as import("node:child_process").ChildProcess;
      Object.defineProperty(child, "pid", { value: 5559 });
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
        fs.writeFileSync(mutatedFile, "partial edit from a run that then failed for an unclassified reason");
        // Deliberately carries none of the quota/temporary/transport/
        // entitlement/auth markers, so classifyFailure lands on "generic".
        child.stdout?.emit(
          "data",
          Buffer.from(
            `${JSON.stringify({
              type: "error",
              message: "Unexpected malformed tool-call output from the model",
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
            return Promise.reject(new Error("a non-cascade-eligible failure must never dispatch the backup"));
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
          "a generic (non-cascade-eligible) failure must never dispatch the configured backup"
        );
        assert.strictEqual(result.status, "failed");
        assert.strictEqual(result.failureKind, "generic");
        assert.match(
          result.errorMessage ?? "",
          /does not automatically retry this kind of failure against a backup model/,
          "a generic failure must no longer fall through with the raw, unexplained provider error"
        );
        assert.doesNotMatch(
          result.errorMessage ?? "",
          /no backup model is configured/,
          "a chain IS configured here — the reason is the failure kind, not an absent chain"
        );
        // Review completion blocker (2026-09-01, round 3): the test's own
        // spawn stub writes `mutated-by-partial-run.txt` before failing, so
        // this run's tree IS dirty — item 8's guard sentence ("this round
        // changed N file(s), so the switch was withheld") must still appear
        // alongside the failure-kind explanation, per item 8's rule that ANY
        // round which changed files and then failed carries the sentence.
        assert.match(
          result.errorMessage ?? "",
          /This round already changed 1 file\(s\), so Ensemble withheld the automatic switch/,
          "a dirty-tree generic failure must still carry the item 8 withheld-switch guard sentence"
        );
        const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as {
          quotaParkRecord?: unknown;
        };
        assert.strictEqual(
          progress.quotaParkRecord,
          undefined,
          "a generic failure has no resettable block and must never record a durable quota-park"
        );
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

  // Workflow 3 continuation, first item: replays the real "monthly ...
  // limit ... resets in 8d 19h, please try again later" Cline message —
  // which classifies as "temporarily-unavailable" (its "try again later"
  // wording, not any quota marker), the exact case that used to bypass the
  // reset-aware remedy entirely and fall back to the generic "rerun or
  // switch" text no matter how far out the reset actually was. Also proves
  // the far branch enumerates every OTHER stage sharing the blocked
  // provider account with its actual substitute (or its absence).
  void it("replays the Cline 'resets in 8d 19h' monthly-limit message: takes the far branch, never offers a rerun, and names each affected stage's substitute", async () => {
    const originalSpawn = childProcess.spawn;

    const metaRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ensemble-impl-far-reset-stage-impact-")
    );
    const taskFolder = path.join(metaRoot, "tasks", "task-a");
    fs.mkdirSync(taskFolder, { recursive: true });
    const taskFolderUri = vscode.Uri.file(taskFolder);
    childProcess.execSync("git init", { cwd: taskFolder, stdio: "ignore" });
    const mutatedFile = path.join(taskFolder, "mutated-by-partial-run.txt");

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

      process.nextTick(() => {
        // The round already made real edits before hitting the limit — same
        // shape as the live 18-file incident (kept to one file here).
        fs.writeFileSync(mutatedFile, "partial edit from a run that then hit the monthly limit");
        child.stdout?.emit(
          "data",
          Buffer.from(
            `${JSON.stringify({
              type: "error",
              message:
                "You have reached your monthly Clinepass limit. The limit resets in 8d 19h, please try again later.",
            })}\n`
          )
        );
        child.emit("close", 1);
      });
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
          backup: "kiro-cli:default",
          strategy: "switch-to-backup",
        },
        // Shares impl's blocked provider account (cline-cli) and has an
        // enabled backup on a DIFFERENT account — must name that substitute.
        "plan-high-review": {
          primary: "cline-cli:default",
          backups: ["kiro-cli:default"],
          strategy: "switch-to-backup",
        },
        // Also shares the blocked account, but configures no backup at all
        // — must be reported as having none, not silently omitted.
        "plan-low-review": {
          primary: "cline-cli:default",
          strategy: "alert-and-wait",
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

        assert.strictEqual(result.status, "failed");
        assert.strictEqual(result.failureKind, "temporarily-unavailable");
        const message = result.errorMessage ?? "";
        assert.match(
          message,
          /expected to stay blocked until/,
          "an 8d19h-out reset must take the far branch even though this failure classified as temporarily-unavailable, not quota"
        );
        assert.doesNotMatch(
          message,
          /Rerun this stage after/,
          "the far branch must never offer or imply an immediate rerun"
        );
        assert.match(
          message,
          /This also affects: High-Level Review \(Plan\) → kiro-cli:default; Low-Level Review \(Plan\): no backup configured — this stage will pause\./,
          "expected every other stage sharing the blocked provider account to be named with its actual substitute (or its absence)"
        );
        assert.ok(
          progressMessages.some((progressMessage) => progressMessage.includes("This also affects:")),
          "expected the live progress notification to carry the same stage-impact enumeration"
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

  // Model-entitlement failures (item 3): a Bedrock/Vertex-style "not
  // available for this account" refusal is a valid credential blocked from
  // only THIS model id — a different model id (a backup) is a legitimate
  // fix, unlike a genuine auth failure. On a CLEAN tree the cascade must
  // fire exactly as it does for quota/temporarily-unavailable.
  void it("cascades to the backup on a model-entitlement failure with a clean working tree", async () => {
    const originalSpawn = childProcess.spawn;
    const metaRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ensemble-impl-entitlement-cascade-")
    );
    const taskFolder = path.join(metaRoot, "tasks", "task-a");
    fs.mkdirSync(taskFolder, { recursive: true });
    const taskFolderUri = vscode.Uri.file(taskFolder);
    childProcess.execSync("git init", { cwd: taskFolder, stdio: "ignore" });

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
        // No file written — the working tree stays clean.
        child.stdout?.emit(
          "data",
          Buffer.from(
            `${JSON.stringify({
              type: "error",
              message:
                'Error from provider aws-bedrock: 403 Forbidden {"message":"anthropic.claude-sonnet-5 is not available for this account."}',
            })}\n`
          )
        );
        child.emit("close", 1);
      });
      return child;
    }) as typeof childProcess.spawn;

    const lm = lmStub();
    const originalSelectChatModels = lm.selectChatModels;
    const { LanguageModelTextPart } = vscode as unknown as {
      LanguageModelTextPart: new (value: string) => { value: string };
    };
    function* responseStream(): Iterable<unknown> {
      yield new LanguageModelTextPart("backup implementation");
    }
    lm.selectChatModels = (): Promise<vscode.LanguageModelChat[]> =>
      Promise.resolve([
        {
          id: "auto",
          name: "Auto",
          sendRequest: () => Promise.resolve({ stream: responseStream() }),
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

        assert.strictEqual(result.status, "completed");
        assert.strictEqual(result.summary, "backup implementation");
        assert.strictEqual(result.actualStoredModelId, "auto");
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

  // Sibling of the dirty-tree-withheld test above, for model-entitlement: the
  // same dirty-tree safety boundary applies — a second model must never be
  // dispatched at a tree the failed primary already edited, regardless of
  // WHY the primary failed.
  void it("hands a model-entitlement dirty-tree failure to the backup as an inspect-and-complete continuation", async () => {
    const originalSpawn = childProcess.spawn;
    const metaRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ensemble-impl-entitlement-dirty-tree-")
    );
    const taskFolder = path.join(metaRoot, "tasks", "task-a");
    fs.mkdirSync(taskFolder, { recursive: true });
    const taskFolderUri = vscode.Uri.file(taskFolder);
    childProcess.execSync("git init", { cwd: taskFolder, stdio: "ignore" });
    const mutatedFile = path.join(taskFolder, "mutated-by-partial-run.txt");

    childProcess.spawn = ((command: string) => {
      const child = new EventEmitter() as import("node:child_process").ChildProcess;
      Object.defineProperty(child, "pid", { value: 5557 });
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
        fs.writeFileSync(mutatedFile, "partial edit from a run that then failed");
        child.stdout?.emit(
          "data",
          Buffer.from(
            `${JSON.stringify({
              type: "error",
              message:
                'Error from provider aws-bedrock: 403 Forbidden {"message":"anthropic.claude-sonnet-5 is not available for this account."}',
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
    const chainPatch = patchModule(automationChainModule, "scheduleAutomationChain", (): Promise<boolean> =>
      Promise.resolve(true)
    );
    const routerPatch = installNoopNotificationRouterV1();
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
          "an available backup must never be invoked INLINE at a tree the failed primary already edited"
        );
        assert.strictEqual(result.status, "failed");
        assert.strictEqual(result.failureKind, "model-entitlement");
        assert.match(
          result.errorMessage ?? "",
          /handed the work to Copilot in inspect-and-complete mode/,
          "expected the failure message to name the backup and the inspect-and-complete mode"
        );
        assert.ok(
          progressMessages.some((message) => message.includes("handed the work to Copilot")),
          "expected an explicit progress notification about the hand-off"
        );
        const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as {
          fallbackActive?: Partial<Record<string, boolean>>;
          fallbackModelId?: Partial<Record<string, string>>;
          implRecovery?: { trigger?: string; mode?: string };
        };
        assert.strictEqual(progress.fallbackActive?.impl, true);
        assert.strictEqual(progress.fallbackModelId?.impl, "auto");
        assert.strictEqual(progress.implRecovery?.trigger, "providerFailedMidRound");
        assert.strictEqual(progress.implRecovery?.mode, "inspect-and-complete");
      } finally {
        settings.restore();
      }
    } finally {
      routerPatch.restore();
      chainPatch.restore();
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
