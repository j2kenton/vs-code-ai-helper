import * as assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  isAuthenticationFailure,
  resolveRunnerForModel,
  runImplementationForModel,
} from "../runners/runnerRegistry";
import { resolveModelForStage } from "../utils/modelSelection";

const requireModule = createRequire(__filename);
const childProcess = requireModule("node:child_process") as typeof import("node:child_process");

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
    undefined,
    "",
  ];

  for (const message of nonAuthMessages) {
    void it(`does not classify "${message}" as an authentication failure`, () => {
      assert.equal(isAuthenticationFailure(message), false);
    });
  }
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

  void it("preserves runner availability checks when fallback switching is enabled", async () => {
    const settings = installModelSettings({
      "impl-low-review": {
        primary: "auto",
        backup: "copilot-gpt-5.6-sol",
        strategy: "switch-to-backup",
      },
    });
    try {
      const { runner } = resolveRunnerForModel("auto", "impl-low-review");

      assert.equal(typeof runner.isAvailable, "function");
      const availability = await runner.isAvailable();
      assert.equal(availability.available, false);
    } finally {
      settings.restore();
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
    const lm = (vscode as unknown as {
      lm: {
        selectChatModels: () => Promise<vscode.LanguageModelChat[]>;
      };
    }).lm;
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
      };
      assert.strictEqual(progress.fallbackActive?.plan, true);
    } finally {
      settings.restore();
      lm.selectChatModels = originalSelectChatModels;
      workspace.fs.readFile = originalReadFile;
      workspace.fs.writeFile = originalWriteFile;
    }
  });
});

void describe("runImplementationForModel", () => {
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
    const lm = (vscode as unknown as {
      lm: {
        selectChatModels: () => Promise<vscode.LanguageModelChat[]>;
      };
    }).lm;
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
      };
      assert.strictEqual(progress.fallbackActive?.impl, true);
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
});
