/**
 * Command-level coverage for draftTaskWithAI (G18): invokes the REAL command
 * function (not just its pure helpers, already covered in
 * draftTaskWithAI.test.ts) to prove three things together, which no existing
 * test asserted in combination:
 *
 *  1. Description-model routing: the model resolved for the "desc" stage is
 *     the one actually used both to generate the draft AND (since the task
 *     name is derived from that same draft response, not a second AI call —
 *     see draftTaskWithAI.ts's title-derivation comment) to name the task.
 *     A single resolveFreshModelForStage("desc") call drives both outcomes.
 *  2. The instructional placeholder text ("Describe the work you want to do
 *     here...") is stripped by parseTaskDocument before task.md's content
 *     ever reaches the model as prompt input.
 *  3. The derived task name comes from the AI response, not the placeholder
 *     or the raw folder slug.
 *
 * Only the provider boundary is faked (model resolution, the runner process,
 * prompt template rendering, run-log writer) — consent, task resolution,
 * parsing/validation, and the task.md / task-progress.json writes are the
 * real production code paths, run against a real temp-directory fixture (the
 * same technique as nextStageAutoReviewCommandChain.test.ts).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { draftTaskWithAI } from "../commands/draftTaskWithAI";
import { TaskInventory } from "../state/taskInventory";
import { TaskProgress } from "../types/taskProgress";
import { readTaskProgress } from "../utils/taskProgressUtils";
import {
  initNotificationRouter,
  deactivateNotificationRouter,
} from "../utils/notificationRouter";
import { safeRemoveDir } from "./testFsUtils";
import { DISCLAIMER_VERSION } from "../legal/disclaimerVersion";
import type { ChatViewProvider } from "../views/chatView";
import type { AgentRunRequest, AgentRunResult } from "../types/agentRunner";

/* eslint-disable @typescript-eslint/no-var-requires */
const modelSelectionModule = require("../utils/modelSelection") as Record<string, unknown>;
const runnerRegistryModule = require("../runners/runnerRegistry") as Record<string, unknown>;
const promptTemplatesModule = require("../utils/promptTemplates") as Record<string, unknown>;
const runLogModule = require("../utils/runLog") as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-var-requires */

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-draft-cmd-"));

const PLACEHOLDER_INTRO =
  "Describe the work you want to do here in as much detail as is useful. When\n" +
  "you're ready, use **Draft with AI** to turn these notes into a structured task\n" +
  "description. Questions from the stage AI appear in the **Chat With AI** panel.";

interface Patched { restore: () => void }
function patch(module: Record<string, unknown>, name: string, replacement: unknown): Patched {
  const orig = module[name];
  module[name] = replacement;
  return { restore: (): void => { module[name] = orig; } };
}

function makeTaskFolder(name: string, taskDescription: string): string {
  const folderPath = path.join(REAL_ROOT, "plans", name);
  fs.mkdirSync(folderPath, { recursive: true });
  const progress: TaskProgress = {
    taskFolder: name,
    currentStage: "desc",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nameIsDefault: true,
    ownership: {
      metaRoot: path.join(REAL_ROOT, "plans"),
      projectRoot: REAL_ROOT,
      workspaceRoot: REAL_ROOT,
      boundAt: "2026-01-01T00:00:00.000Z",
    },
  };
  fs.writeFileSync(
    path.join(folderPath, "task-progress.json"),
    JSON.stringify(progress, null, 2),
    "utf8"
  );
  // task.md still carries the placeholder intro paragraph verbatim, exactly
  // as a freshly-created (undrafted) task does, PLUS the user's own
  // description in the Task Description section.
  fs.writeFileSync(
    path.join(folderPath, "task.md"),
    `${PLACEHOLDER_INTRO}\n\n## Task Description\n\n${taskDescription}\n\n## Draft with AI\n\n## Open Questions\n`,
    "utf8"
  );
  return folderPath;
}

function installFakeInventory(taskFolderPath: string): TaskInventory {
  const task = {
    taskFolderPath,
    folderName: path.basename(taskFolderPath),
    canonicalId: taskFolderPath,
    sourceScopeKey: "test",
    workspaceFolder: undefined,
    progress: JSON.parse(fs.readFileSync(path.join(taskFolderPath, "task-progress.json"), "utf8")) as TaskProgress,
  };
  return {
    getTaskById: (id: string) => (id === taskFolderPath ? task : undefined),
    getVisibleTaskForSuppressedId: () => undefined,
    getTaskByPath: (p: string) => (p === taskFolderPath ? task : undefined),
    getVisibleTaskForSuppressedPath: () => undefined,
    getTasks: () => [task],
    refresh: () => Promise.resolve(undefined),
  } as unknown as TaskInventory;
}

function makeExtensionContext(): vscode.ExtensionContext {
  const backing = new Map<string, unknown>([
    [
      `aiHelper.consent.v${DISCLAIMER_VERSION}`,
      { acceptedAt: "2026-01-01T00:00:00.000Z", version: DISCLAIMER_VERSION },
    ],
  ]);
  const memento = {
    keys: (): readonly string[] => [...backing.keys()],
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      backing.has(key) ? (backing.get(key) as T) : defaultValue,
    update: (key: string, value: unknown): Thenable<void> => {
      if (value === undefined) { backing.delete(key); } else { backing.set(key, value); }
      return Promise.resolve();
    },
  };
  return {
    subscriptions: [] as vscode.Disposable[],
    extensionUri: vscode.Uri.file(REAL_ROOT),
    workspaceState: memento,
    globalState: memento,
  } as unknown as vscode.ExtensionContext;
}

function installFsBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = { ...target };
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  target.writeFile = async (uri: vscode.Uri, content: Uint8Array): Promise<void> => {
    await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
    await fs.promises.writeFile(uri.fsPath, content);
  };
  target.delete = (uri: vscode.Uri): Promise<void> =>
    fs.promises.rm(uri.fsPath, { force: true, recursive: true });
  target.stat = (uri: vscode.Uri): Promise<{ type: number; ctime: number; mtime: number; size: number }> =>
    fs.promises.stat(uri.fsPath).then((s) => ({
      type: s.isDirectory() ? 2 : 1,
      ctime: s.ctimeMs,
      mtime: s.mtimeMs,
      size: s.size,
    }));
  return {
    restore: (): void => {
      for (const key of ["readFile", "writeFile", "delete", "stat"]) {
        target[key] = orig[key];
      }
    },
  };
}

function installWorkspaceFoldersStub(): { restore: () => void } {
  const ws = vscode.workspace as unknown as Record<string, unknown>;
  const orig = ws.workspaceFolders;
  ws.workspaceFolders = [{ uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 }];
  return { restore: (): void => { ws.workspaceFolders = orig; } };
}

const VALID_AI_RESPONSE =
  "## Draft with AI\n\n" +
  "Add a background export queue.\n\n" +
  "### Behavior change\n\nExports run off the UI thread.\n\n" +
  "### Affected areas\n\n- exportService.ts\n\n" +
  "### Actionable changes\n\n- Add the queue.\n\n" +
  "## Open Questions\n\n- None.\n";

void describe("draftTaskWithAI command (G18: Description-model routing regression)", () => {
  void it("routes both the draft generation and the derived task name through the Description-stage model, and never sends the placeholder intro to the AI", async () => {
    const folderPath = makeTaskFolder(
      `draftcmd_${Math.floor(Math.random() * 1e9)}`,
      "Users need to export large datasets without freezing the UI."
    );
    const inventory = installFakeInventory(folderPath);
    const context = makeExtensionContext();

    const surface = { addEntry: (): void => undefined };
    initNotificationRouter(surface);
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();

    const modelStageCalls: string[] = [];
    const runInvokedWithModelId: string[] = [];
    let promptSeenByRenderer: string | undefined;

    const patches: Patched[] = [
      patch(modelSelectionModule, "resolveFreshModelForStage", (
        _folder: unknown,
        stage: string
      ) => {
        modelStageCalls.push(stage);
        // A distinct fake model ID for "desc" so the assertion can tell
        // whether the SAME model drove both the draft and the naming step,
        // rather than two different models silently diverging.
        return Promise.resolve({ modelId: stage === "desc" ? "fake-desc-model:v1" : "wrong-model:v1" });
      }),
      patch(runnerRegistryModule, "resolveRunnerForModel", (modelId: string) => ({
        runner: {
          run: (_request: AgentRunRequest): Promise<AgentRunResult> => {
            runInvokedWithModelId.push(modelId);
            return Promise.resolve({
              runnerId: "stub-runner",
              status: "completed" as const,
              summary: VALID_AI_RESPONSE,
            });
          },
        },
        provider: "claude-cli",
        providerLabel: "Stub Provider",
        nativeModelId: modelId,
      })),
      patch(runnerRegistryModule, "checkRunnerAvailabilityForModel", () =>
        Promise.resolve({ availability: { available: true }, providerLabel: "Stub Provider" })
      ),
      patch(promptTemplatesModule, "renderPromptTemplate", (
        _extensionUri: unknown,
        _templateName: string,
        variables: { taskDescription: string }
      ) => {
        promptSeenByRenderer = variables.taskDescription;
        return Promise.resolve(`stub prompt: ${variables.taskDescription}`);
      }),
      patch(runLogModule, "writeRunLog", () => Promise.resolve(vscode.Uri.file(path.join(folderPath, "run.log")))),
    ];

    const fakeChatViewProvider = {
      ask: () => Promise.resolve(undefined),
    } as unknown as ChatViewProvider;

    try {
      const result = await draftTaskWithAI(inventory, context, fakeChatViewProvider, {
        canonicalId: folderPath,
      });
      assert.equal(result, true, "draftTaskWithAI must report success");

      // 1. Description-model routing: resolveFreshModelForStage was called
      //    for "desc" (and only "desc" — this command has no second,
      //    separately-modeled naming step; the name comes from the SAME
      //    draft response the model produced).
      assert.ok(modelStageCalls.length > 0, "must resolve a model");
      assert.ok(
        modelStageCalls.every((stage) => stage === "desc"),
        `every model resolution during Draft with AI must use the "desc" stage; got: ${JSON.stringify(modelStageCalls)}`
      );

      // 2. The runner that actually generated the content was launched with
      //    the Description-stage model, not some other/default model.
      assert.ok(runInvokedWithModelId.length > 0, "the runner must have been invoked");
      assert.ok(
        runInvokedWithModelId.every((id) => id === "fake-desc-model:v1"),
        `the runner must be invoked with the Description-stage model; got: ${JSON.stringify(runInvokedWithModelId)}`
      );

      // 3. Placeholder exclusion: the instructional intro paragraph must
      //    never reach the model as prompt content, only the user's actual
      //    description.
      assert.ok(promptSeenByRenderer !== undefined, "the prompt template must have been rendered");
      assert.doesNotMatch(
        promptSeenByRenderer,
        /Describe the work you want to do here/,
        "the placeholder intro text must be stripped before reaching the model"
      );
      assert.match(
        promptSeenByRenderer,
        /export large datasets/,
        "the user's actual description must reach the model"
      );

      // 4. The derived task name comes from the AI's draft response (the
      //    opening goal line), driven by the SAME "desc"-stage model call —
      //    not the placeholder text and not the raw folder slug.
      const persisted = await readTaskProgress(vscode.Uri.file(folderPath));
      assert.equal(persisted?.nameIsDefault, false, "a drafted name must replace the default label");
      assert.match(persisted?.displayName ?? "", /background export queue/i);
      assert.doesNotMatch(persisted?.displayName ?? "", /Describe the work you want to do here/);
    } finally {
      for (const p of patches) {p.restore();}
      fsBridge.restore();
      wsStub.restore();
      deactivateNotificationRouter();
      safeRemoveDir(REAL_ROOT);
    }
  });
});
