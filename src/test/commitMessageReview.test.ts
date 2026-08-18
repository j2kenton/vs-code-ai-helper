/**
 * Coverage for the in-UI commit-message review flow (commitAndPushTask.ts):
 * a modal confirmation showing the AI-suggested message, the capped file
 * preview, and the push destination — no editor document, no file to save,
 * and no need to re-invoke the whole command to see it again.
 *
 * Regression coverage for a review finding: the previous implementation
 * (pendingCommitSession.ts, removed) required the user to review the
 * message in an untitled editor buffer and confirm via a special editor-title
 * button, which was reported as a headache ("I have to save the file, and
 * then I have to start again"). This flow instead confirms inline, and lets
 * the user ask for a different message ("Regenerate") without restarting
 * staging or PR-description generation.
 */
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { commitAndPushTask, resumeCommitPushMetadataInteractionV1 } from "../commands/commitAndPushTask";
import { TaskInventory } from "../state/taskInventory";
import { TaskProgress } from "../types/taskProgress";
import {
  deactivateNotificationRouter,
  initNotificationRouter,
} from "../utils/notificationRouter";
import { safeRemoveDir } from "./testFsUtils";
import { createChatInteractionTransactionStoreV1 } from "../services/chatInteractionTransactionStoreV1";
import {
  configureWorkflowPrivateStorageRootV1,
  getWorkflowFileStoreV1,
  getWorkflowPathRegistryV1,
  setChatInteractionTransactionStoreV1,
} from "../services/workflowRuntimeServicesV1";
import { getProductionActionConversationOrchestratorV1 } from "../actions/productionTaskActionRuntimeV1";
import { ChatViewProvider, ChatInteractionRefV1 } from "../views/chatView";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import { deriveTaskBindingV1 } from "../types/taskBindingV1";

// buildCommitMessage's AI path runs through the real production coordinator
// (createProductionTaskActionCoordinatorV1), which requires the Chat
// interaction transaction store to be wired exactly as extension.ts does at
// activation — otherwise getProductionActionConversationOrchestratorV1
// throws "not wired yet", which buildCommitMessage's catch-all silently
// swallows into the deterministic fallback subject, masking whether the
// configured provider was actually invoked.
const PRIVATE_STORAGE_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), "ensemble-commit-message-review-private-")
);
// configureWorkflowPrivateStorageRootV1 MUST run (and its `rebuildFileStore()`
// side effect complete) before getWorkflowFileStoreV1() is called below —
// object-literal property evaluation runs top-to-bottom, so folding the
// configure call into the `privateRootId` property here would capture the
// PRE-registration (root-less) fileStore instance and every `begin()` write
// through it would fail closed with `workspaceRootUnsupported`, exactly as
// extension.ts's own activation wiring avoids by registering the root in its
// own statement first (src/extension.ts, `workflowPrivateStorageRootId`).
const PRIVATE_STORAGE_ROOT_ID = configureWorkflowPrivateStorageRootV1(PRIVATE_STORAGE_ROOT);
setChatInteractionTransactionStoreV1(
  createChatInteractionTransactionStoreV1({
    registry: getWorkflowPathRegistryV1(),
    fileStore: getWorkflowFileStoreV1(),
    privateRootId: PRIVATE_STORAGE_ROOT_ID,
  })
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const completionLintModule = require("../utils/completionLint") as {
  runCompletionLint: (...args: unknown[]) => Promise<unknown>;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const modelSelectionModule = require("../utils/modelSelection") as {
  resolveFreshModelForStage: (...args: unknown[]) => Promise<unknown>;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const runnerRegistryModule = require("../runners/runnerRegistry") as {
  resolveRunnerForModel: (...args: unknown[]) => unknown;
  checkRunnerAvailabilityForModel: (...args: unknown[]) => Promise<unknown>;
  createV1RunnerSelectionOpener: (...args: unknown[]) => unknown;
};

/**
 * commitAndPushTask's metadata generation now runs through the real V1
 * action coordinator (createProductionTaskActionCoordinatorV1), which
 * selects providers via runnerRegistry's `createV1RunnerSelectionOpener` —
 * NOT the legacy `resolveRunnerForModel` cascade. Framing a fake response
 * requires the V1 envelope format and this seam instead (mirrors
 * publishOwnershipMatrix.test.ts's identical helpers).
 */
function frameV1(json: unknown): string {
  return `<<<ENSEMBLE_AI_RESULT_V1>>>\n${JSON.stringify(json)}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>\n`;
}

interface FakeAgentTransportV1 {
  readonly runnerId: string;
  invoke(
    request: { correlation: unknown },
    output: { write: (chunk: string) => boolean }
  ): Promise<{ kind: "completed" }>;
}

/** A V1 transport that frames a completed commit-metadata.v1 envelope. */
function commitMetadataTransportV1(
  subject: string,
  body?: string,
  runnerId = "stub-runner"
): FakeAgentTransportV1 {
  return {
    runnerId,
    invoke: (request, output): Promise<{ kind: "completed" }> => {
      output.write(
        frameV1({
          version: 1,
          correlation: request.correlation,
          kind: "completed",
          content: {
            contentType: "commit-metadata.v1",
            schemaVersion: 1,
            subject,
            ...(body !== undefined ? { body } : {}),
          },
        })
      );
      return Promise.resolve({ kind: "completed" as const });
    },
  };
}

/** A V1 transport that frames a `questions` envelope with a single required text question. */
function questionsTransportV1(runnerId = "stub-runner"): FakeAgentTransportV1 {
  return {
    runnerId,
    invoke: (request, output): Promise<{ kind: "completed" }> => {
      output.write(
        frameV1({
          version: 1,
          correlation: request.correlation,
          kind: "questions",
          questions: [
            {
              questionId: "q1",
              kind: "text",
              prompt: "What's the primary intent of this change?",
              required: true,
            },
          ],
        })
      );
      return Promise.resolve({ kind: "completed" as const });
    },
  };
}

/**
 * Patches runnerRegistry's `createV1RunnerSelectionOpener` factory so a
 * coordinator-run commit-metadata generation never reaches a real CLI or
 * Copilot provider. `runInvokedWithStage` records the taskStage each
 * reservation was opened for — the equivalent of the legacy stub's
 * `request.stage` observation.
 */
function stubV1RunnerSelection(
  transports: readonly FakeAgentTransportV1[],
  onOpen?: (taskStage: string) => void
): { restore: () => void } {
  const orig = runnerRegistryModule.createV1RunnerSelectionOpener;
  let cursor = 0;
  runnerRegistryModule.createV1RunnerSelectionOpener = () => (request: {
    session: { reserve: (input: Record<string, unknown>) => unknown };
    mode: unknown;
    taskStage: string;
  }) => {
    onOpen?.(request.taskStage);
    return {
      reserveNext(attemptId: string): unknown {
        const transport = transports[cursor];
        if (!transport) {
          return cursor === 0
            ? { kind: "noneRemaining", code: "providerModeUnavailable" }
            : { kind: "noneRemaining", code: "candidatesExhausted" };
        }
        cursor += 1;
        const handle = request.session.reserve({
          attemptId,
          mode: request.mode,
          runnerId: transport.runnerId,
          providerId: "copilot",
          modelId: "copilot:test",
        });
        return {
          kind: "reserved",
          reserved: {
            handle,
            providerLabel: "Test Provider",
            storedModelId: "copilot:test",
            createTransport: () => transport,
          },
        };
      },
    };
  };
  return { restore: (): void => { runnerRegistryModule.createV1RunnerSelectionOpener = orig; } };
}

function git(cwd: string, args: string[]): string {
  return cp.execFileSync("git", args, { cwd, windowsHide: true }).toString("utf8");
}

function makeGitFixtureWithRemote(): string {
  const repoRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "ensemble-commit-message-review-")
  );
  git(repoRoot, ["init"]);
  git(repoRoot, [
    "-c", "user.email=test@example.invalid", "-c", "user.name=Test",
    "commit", "--allow-empty", "-m", "initial",
  ]);
  git(repoRoot, ["remote", "add", "origin", "https://example.invalid/repo.git"]);
  fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "src", "foo.ts"), "export const x = 1;\n");
  fs.mkdirSync(path.join(repoRoot, "plans", "task_1"), { recursive: true });
  return repoRoot;
}

function fixtureTaskProgress(taskFolderPath: string): TaskProgress {
  return {
    taskFolder: "task_1",
    currentStage: "publish",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ownership: {
      metaRoot: path.dirname(taskFolderPath),
      projectRoot: path.dirname(taskFolderPath),
      workspaceRoot: path.dirname(path.dirname(taskFolderPath)),
      boundAt: "2026-01-01T00:00:00.000Z",
      state: "resolved",
    },
  };
}

class RecordingSurface {
  entries: { message: string; level: "info" | "warning" | "error" }[] = [];
  addEntry(message: string, level: "info" | "warning" | "error"): void {
    this.entries.push({ message, level });
  }
}

function installFakeInventory(
  taskFolderPath: string,
  canonicalId: string,
  progressOverrides?: Partial<TaskProgress>
): TaskInventory {
  const task = {
    taskFolderPath,
    folderName: path.basename(taskFolderPath),
    canonicalId,
    sourceScopeKey: "test",
    workspaceFolder: undefined,
    progress: { ...fixtureTaskProgress(taskFolderPath), ...progressOverrides },
  };
  return {
    getTaskById: (id: string) => (id === canonicalId ? task : undefined),
    getVisibleTaskForSuppressedId: () => undefined,
    getTaskByPath: (p: string) => (p === taskFolderPath ? task : undefined),
    getVisibleTaskForSuppressedPath: () => undefined,
    getTasks: () => [task],
    refresh: () => Promise.resolve(undefined),
    // resumeCommitPushMetadataInteractionV1 looks the task up by its
    // durable Chat-transaction taskBindingId (plan §3.9), derived from this
    // task's own `progress.ownership`/`taskFolder`.
    getTaskByBindingId: (taskBindingId: string) => {
      const derived = deriveTaskBindingV1(task.progress);
      return derived.ok && derived.binding.bindingId === taskBindingId ? task : undefined;
    },
  } as unknown as TaskInventory;
}

interface Harness {
  repoRoot: string;
  taskFolderPath: string;
  inventory: TaskInventory;
  surface: RecordingSurface;
  /** Every showInformationMessage call (the commit-message review dialog). */
  infoCalls: { message: string; options: unknown; items: string[] }[];
  /** The `stage` argument of every resolveFreshModelForStage call. */
  modelStageCalls: string[];
  restore(): void;
}

function installHarness(
  answerReviewModal: (call: { message: string; items: string[] }) => string | undefined,
  progressOverrides?: Partial<TaskProgress>
): Harness {
  const repoRoot = makeGitFixtureWithRemote();
  const taskFolderPath = path.join(repoRoot, "plans", "task_1");
  // A real task-progress.json (with a validated ownership binding) is required
  // on disk: ensureWorkflowTaskFolderRootV1 (plan §3.9) reads it via raw node
  // fs, independent of the in-memory inventory stub / workspaceFs mock below,
  // and refuses to register a task-folder root with no ownership binding.
  fs.writeFileSync(
    path.join(taskFolderPath, "task-progress.json"),
    JSON.stringify({ ...fixtureTaskProgress(taskFolderPath), ...progressOverrides }, null, 2),
    "utf8"
  );
  const inventory = installFakeInventory(taskFolderPath, taskFolderPath, progressOverrides);

  const surface = new RecordingSurface();
  initNotificationRouter(surface);

  const workspaceFs = vscode.workspace.fs as unknown as Record<string, unknown>;
  const originals = {
    workspaceFolders: vscode.workspace.workspaceFolders,
    runCompletionLint: completionLintModule.runCompletionLint,
    resolveFreshModelForStage: modelSelectionModule.resolveFreshModelForStage,
    showWarningMessage: vscode.window.showWarningMessage,
    showInformationMessage: vscode.window.showInformationMessage,
    showErrorMessage: vscode.window.showErrorMessage,
    fsWriteFile: workspaceFs.writeFile,
    fsRename: workspaceFs.rename,
  };

  (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = [
    { uri: vscode.Uri.file(repoRoot), name: "root", index: 0 },
  ];
  completionLintModule.runCompletionLint = () => Promise.resolve({
    passed: true, summary: "", runAt: new Date().toISOString(), issueCount: 0, failedChecks: [],
  });
  // Deterministic model resolution: the Copilot lm stub returns no models,
  // so buildCommitMessage always lands on its deterministic fallback subject.
  const modelStageCalls: string[] = [];
  modelSelectionModule.resolveFreshModelForStage = (
    ...args: unknown[]
  ) => {
    modelStageCalls.push(String(args[1]));
    return Promise.resolve({ modelId: "copilot:auto" });
  };
  // The file-scope confirmation modal (unrelated to this file's coverage).
  vscode.window.showWarningMessage =
    (() => Promise.resolve("Commit & Push")) as unknown as typeof vscode.window.showWarningMessage;
  const infoCalls: { message: string; options: unknown; items: string[] }[] = [];
  vscode.window.showInformationMessage = ((...args: unknown[]): Promise<string | undefined> => {
    const message = String(args[0]);
    const options = args[1];
    const items = args.slice(2).filter((a): a is string => typeof a === "string");
    const call = { message, options, items };
    infoCalls.push(call);
    return Promise.resolve(answerReviewModal(call));
  }) as unknown as typeof vscode.window.showInformationMessage;
  vscode.window.showErrorMessage = (() => Promise.resolve(undefined)) as unknown as typeof vscode.window.showErrorMessage;
  workspaceFs.writeFile = () => Promise.resolve();
  workspaceFs.rename = () => Promise.resolve();

  return {
    repoRoot,
    taskFolderPath,
    inventory,
    surface,
    infoCalls,
    modelStageCalls,
    restore(): void {
      completionLintModule.runCompletionLint = originals.runCompletionLint;
      modelSelectionModule.resolveFreshModelForStage = originals.resolveFreshModelForStage;
      vscode.window.showWarningMessage = originals.showWarningMessage;
      vscode.window.showInformationMessage = originals.showInformationMessage;
      vscode.window.showErrorMessage = originals.showErrorMessage;
      workspaceFs.writeFile = originals.fsWriteFile;
      workspaceFs.rename = originals.fsRename;
      (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = originals.workspaceFolders;
      deactivateNotificationRouter();
      safeRemoveDir(repoRoot);
    },
  };
}

/** Minimal vscode.Memento backing store for a standalone ChatViewProvider instance. */
function makeMemento(): vscode.Memento {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string, defaultValue?: T): T => (store.has(key) ? (store.get(key) as T) : (defaultValue as T)),
    update: (key: string, value: unknown): Promise<void> => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
      return Promise.resolve();
    },
    keys: (): readonly string[] => [...store.keys()],
  } as unknown as vscode.Memento;
}

/**
 * ChatViewProvider.askInteraction's first call for a task opens the webview
 * via `executeCommand("vs-code-ai-helper.chatView.focus")` (chatView.ts's
 * `open()`), which this test process never registers — mirrors
 * chatInteractionUI.test.ts's identical harness.
 */
function installExecuteCommandCapture(): { restore: () => void } {
  const commandsObj = vscode.commands as unknown as {
    _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
  };
  const orig = commandsObj._executeCommandOverride;
  commandsObj._executeCommandOverride = (): Promise<unknown> => Promise.resolve(undefined);
  return {
    restore: (): void => {
      commandsObj._executeCommandOverride = orig;
    },
  };
}

void describe("commit-message review (in-UI modal, no editor session)", () => {
  void it("shows a single modal with the message, file preview, and destination, then commits and pushes on confirm", async () => {
    const harness = installHarness(() => "Commit & Push");
    try {
      await commitAndPushTask(harness.inventory, { canonicalId: harness.taskFolderPath });

      assert.equal(harness.infoCalls.length, 1, "exactly one review dialog for a single accept");
      const call = harness.infoCalls[0]!;
      assert.match(call.message, /Commit message:/);
      assert.match(call.message, /Files \(\d+ total\):/);
      assert.match(call.message, /foo\.ts/, "the file preview lists changed files");
      assert.match(call.message, /Destination: /);
      assert.deepEqual(call.items, ["Commit & Push", "Regenerate"]);
      assert.deepEqual(call.options, { modal: true });

      assert.equal(
        git(harness.repoRoot, ["rev-list", "--count", "HEAD"]).trim(),
        "2",
        "confirming must create the commit"
      );
      assert.doesNotMatch(
        git(harness.repoRoot, ["log", "-1", "--format=%s"]).trim(),
        /foo\.ts/,
        "the fallback commit subject must never be a filename list"
      );
    } finally {
      harness.restore();
    }
  });

  void it("the fallback commit subject uses the task.md title, not the raw folder slug", async () => {
    const harness = installHarness(() => "Commit & Push");
    const workspaceFs = vscode.workspace.fs as unknown as Record<string, unknown>;
    const originalReadFile = workspaceFs.readFile;
    try {
      fs.writeFileSync(
        path.join(harness.taskFolderPath, "task.md"),
        "# Add background export queue\n\n## Task Description\n\nSome details.\n"
      );
      workspaceFs.readFile = (uri: vscode.Uri) =>
        Promise.resolve(new Uint8Array(fs.readFileSync(uri.fsPath)));

      await commitAndPushTask(harness.inventory, { canonicalId: harness.taskFolderPath });

      const subject = git(harness.repoRoot, ["log", "-1", "--format=%s"]).trim();
      assert.match(subject, /Add background export queue/, "fallback subject must use the task.md H1, not task_1");
      assert.doesNotMatch(subject, /task_1/, "fallback subject must not fall back to the folder slug when a title is available");
    } finally {
      workspaceFs.readFile = originalReadFile;
      harness.restore();
    }
  });

  void it("the fallback commit subject uses progress.displayName when task.md has no H1 (normal AI drafting)", async () => {
    // Normal Draft with AI never emits an H1 into task.md — it stores its
    // generated summary as progress.displayName and flips nameIsDefault to
    // false. Without this fallback the commit subject would regress to the
    // raw folder slug ("task_1") instead of the drafted intent.
    const harness = installHarness(() => "Commit & Push", {
      displayName: "Add background export queue",
      nameIsDefault: false,
    });
    try {
      await commitAndPushTask(harness.inventory, { canonicalId: harness.taskFolderPath });

      const subject = git(harness.repoRoot, ["log", "-1", "--format=%s"]).trim();
      assert.match(
        subject,
        /Add background export queue/,
        "fallback subject must use progress.displayName, not task_1"
      );
      assert.doesNotMatch(
        subject,
        /task_1/,
        "fallback subject must not fall back to the folder slug when displayName is available"
      );
    } finally {
      harness.restore();
    }
  });

  void it("Regenerate re-shows the dialog without staging or committing anything", async () => {
    let calls = 0;
    const harness = installHarness(() => {
      calls += 1;
      return calls === 1 ? "Regenerate" : "Commit & Push";
    });
    try {
      await commitAndPushTask(harness.inventory, { canonicalId: harness.taskFolderPath });

      assert.equal(harness.infoCalls.length, 2, "Regenerate must re-show the review dialog once");
      assert.equal(
        git(harness.repoRoot, ["rev-list", "--count", "HEAD"]).trim(),
        "2",
        "the eventual confirm must still create exactly one commit"
      );
    } finally {
      harness.restore();
    }
  });

  void it("resolves the model configured for the Publish stage, not some other stage or a fixed default", async () => {
    const harness = installHarness(() => "Commit & Push");
    try {
      await commitAndPushTask(harness.inventory, { canonicalId: harness.taskFolderPath });

      assert.ok(harness.modelStageCalls.length > 0, "commit-message generation must resolve a model");
      assert.ok(
        harness.modelStageCalls.every((stage) => stage === "publish"),
        `every model resolution during commit-message generation must use the "publish" stage; got: ${JSON.stringify(harness.modelStageCalls)}`
      );
    } finally {
      harness.restore();
    }
  });

  void it("uses the configured Publish-stage CLI provider's run output, not the filename-list fallback", async () => {
    const harness = installHarness(() => "Commit & Push");
    const workspaceFs = vscode.workspace.fs as unknown as Record<string, unknown>;
    const originalReadFile = workspaceFs.readFile;
    const originalCreateDirectory = workspaceFs.createDirectory;
    const subject = "Add background export queue";
    const body = "Lets large exports finish without blocking the UI.";
    let runInvokedWithStage: string | undefined;
    const runnerPatch = stubV1RunnerSelection(
      [commitMetadataTransportV1(subject, body)],
      (taskStage) => { runInvokedWithStage = taskStage; }
    );
    try {
      modelSelectionModule.resolveFreshModelForStage = () =>
        Promise.resolve({ modelId: "claude-cli:sonnet" });
      workspaceFs.createDirectory = () => Promise.resolve();
      workspaceFs.readFile = () => Promise.resolve(new TextEncoder().encode(""));
      // commitPushMetadataRowV1's promotion writes the generated metadata to
      // <task-folder>/runs/commit-metadata-<ts>.json via the real (raw-fs,
      // nonrecursive-mkdir) WorkflowFileStoreV1 — independent of the
      // vscode.workspace.fs mocking above. In production "runs/" already
      // exists by the time a task reaches Publish (every prior review/
      // implementation run writes a log there); this minimal harness never
      // creates it, so it must be seeded here.
      fs.mkdirSync(path.join(harness.taskFolderPath, "runs"), { recursive: true });

      await commitAndPushTask(harness.inventory, { canonicalId: harness.taskFolderPath });

      assert.equal(runInvokedWithStage, "publish", "the CLI runner must be invoked for the publish stage");
      assert.equal(harness.infoCalls.length, 1);
      assert.match(harness.infoCalls[0]!.message, /Add background export queue/);
      assert.doesNotMatch(
        harness.infoCalls[0]!.message,
        /^Commit message:\n\nUpdate /,
        "must not fall back to the deterministic filename-list subject when the CLI runner succeeds"
      );
    } finally {
      workspaceFs.readFile = originalReadFile;
      workspaceFs.createDirectory = originalCreateDirectory;
      runnerPatch.restore();
      harness.restore();
    }
  });

  void it("dismissing the review dialog cancels without staging, committing, or writing any file", async () => {
    const harness = installHarness(() => undefined);
    try {
      await commitAndPushTask(harness.inventory, { canonicalId: harness.taskFolderPath });

      assert.equal(
        git(harness.repoRoot, ["rev-list", "--count", "HEAD"]).trim(),
        "1",
        "nothing may be committed when the review dialog is dismissed"
      );
      assert.equal(
        git(harness.repoRoot, ["status", "--porcelain"]).trim().length > 0,
        true,
        "the working tree changes must remain unstaged, exactly as before the run"
      );
      assert.ok(
        harness.surface.entries.some((e) => /Commit and push cancelled/.test(e.message)),
        "cancellation must be reported"
      );
    } finally {
      harness.restore();
    }
  });
});

/**
 * Direct coverage for the production `resumeCommitPushMetadataInteractionV1`
 * delegate (commitAndPushTask.ts) — the wiring extension.ts calls from the
 * Chat "Resume" control for Commit and Push's `commitPushMetadata.v1`
 * question (plan §5.5/§10.2 point 5). Unlike the review/apply-review rows,
 * this row declares `resumeSemantics: "replacementOperation"` (its
 * process-global token was released when the question was first posted), so
 * Resume must start a genuinely fresh, linked public Commit and Push
 * operation — its own token acquisition, index/privacy checks, and lint —
 * rather than resuming the original operation in place.
 */
void describe("resumeCommitPushMetadataInteractionV1 — production Resume delegate", () => {
  void it("resumes a questions-returning commit-metadata attempt end to end: settles \"supersededByReplacementOperation\" and commits with the resumed message", async () => {
    const harness = installHarness(() => "Commit & Push");
    // commitPushMetadataRowV1's promotion writes to
    // <task-folder>/runs/commit-metadata-<ts>.json via the real
    // WorkflowFileStoreV1 (see the identical seeding above).
    fs.mkdirSync(path.join(harness.taskFolderPath, "runs"), { recursive: true });

    const chatViewProvider = new ChatViewProvider(makeMemento());
    const execCapture = installExecuteCommandCapture();
    const askedRefs: ChatInteractionRefV1[] = [];
    const originalAskInteraction = chatViewProvider.askInteraction.bind(chatViewProvider);
    chatViewProvider.askInteraction = (async (question) => {
      askedRefs.push({
        operationId: question.operationId,
        interactionId: question.interactionId,
        taskBindingId: question.binding.taskBindingId,
        chatDocumentId: question.binding.chatDocumentId,
        sourceAttemptId: question.sourceAttemptId,
      });
      return originalAskInteraction(question);
    }) as typeof chatViewProvider.askInteraction;

    try {
      const initialRunnerPatch = stubV1RunnerSelection([questionsTransportV1()]);
      try {
        await commitAndPushTask(
          harness.inventory,
          { canonicalId: harness.taskFolderPath },
          undefined,
          undefined,
          undefined,
          chatViewProvider
        );
      } finally {
        initialRunnerPatch.restore();
      }

      assert.equal(askedRefs.length, 1, "the commit-metadata clarifying question must reach Chat With AI exactly once");
      assert.equal(harness.infoCalls.length, 0, "a questions outcome must never reach the commit-message review modal");
      assert.equal(
        git(harness.repoRoot, ["rev-list", "--count", "HEAD"]).trim(),
        "1",
        "a questions outcome must not commit anything"
      );

      const submitted = await getProductionActionConversationOrchestratorV1().submitAnswers(
        askedRefs[0]!,
        [{ questionId: "q1", kind: "text", state: "answered", value: "A background export queue." }],
        allocateHex128IdV1()
      );
      assert.equal(submitted.ok, true, "the clarifying answer must be accepted before Resume");

      const resumeRunnerPatch = stubV1RunnerSelection([
        commitMetadataTransportV1("Add background export queue", "Lets large exports finish without blocking the UI."),
      ]);
      try {
        const result = await resumeCommitPushMetadataInteractionV1(
          harness.inventory,
          chatViewProvider,
          askedRefs[0]!,
          allocateHex128IdV1()
        );

        assert.equal(result.ok, true, `expected Resume to settle successfully: ${result.ok ? "" : result.reason}`);
        if (result.ok) {
          assert.equal(
            result.settlement,
            "supersededByReplacementOperation",
            "commitPushMetadata.v1 declares replacementOperation resume semantics"
          );
        }
        assert.equal(
          git(harness.repoRoot, ["rev-list", "--count", "HEAD"]).trim(),
          "2",
          "the fresh linked operation Resume starts must actually commit and push"
        );
        assert.equal(
          git(harness.repoRoot, ["log", "-1", "--format=%s"]).trim(),
          "Add background export queue",
          "the commit must use the resumed attempt's own generated subject"
        );

        // A second Resume of the same interaction, with a fresh idempotency
        // id, must be rejected without starting another operation (AC-ID-04).
        const replayRunnerPatch = stubV1RunnerSelection([
          commitMetadataTransportV1("must not be invoked for a replay"),
        ]);
        try {
          const replay = await resumeCommitPushMetadataInteractionV1(
            harness.inventory,
            chatViewProvider,
            askedRefs[0]!,
            allocateHex128IdV1()
          );
          assert.equal(replay.ok, false, "a second Resume of an already-settled interaction must not report success");
        } finally {
          replayRunnerPatch.restore();
        }
      } finally {
        resumeRunnerPatch.restore();
      }
    } finally {
      execCapture.restore();
      harness.restore();
    }
  });
});
