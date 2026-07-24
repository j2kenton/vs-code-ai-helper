/**
 * Backup-cascade coverage for draftTaskWithAI. The Description-stage "Draft
 * with AI" command must fall back to the stage's configured backup model(s)
 * when a model exits cleanly with NO USABLE DRAFT — the shape opencode's
 * free-tier models produce when they burn the run on tool calls and emit no
 * final text (the reported jester bug). Draft with AI was the one stage
 * command with no content-level fallback.
 *
 * The cascade mirrors reviewActions.runAiToFile:
 *  - A PRIMARY hard failure is terminal (its stage wrapper already cascaded
 *    through the stage's backups, or ruled the error terminal), so it surfaces
 *    the error and never re-spends backups.
 *  - Once a model exits cleanly with an unusable draft, backups are tried one
 *    at a time; a non-completed backup is skipped (its quota state recorded)
 *    and the next backup runs.
 *  - A model already run — including one the primary's own internal cascade
 *    substituted — is never re-charged (dedupe by the real ran-model id).
 *  - The accepted draft is attributed to the provider that actually produced
 *    it, even when that was a silently-substituted backup.
 *
 * Only the provider boundary is faked (model resolution, the per-model runner,
 * the backup-model list, prompt rendering, run-log writer). Consent, task
 * resolution, parsing/validation, quota observation, and the task.md writes
 * are the real production code paths, against a real temp-directory fixture.
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
import { getQuotaObservation, recordQuotaObservation, __quotaTestOnly } from "../utils/quota";
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

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-draft-fallback-"));

const PLACEHOLDER_INTRO =
  "Describe the work you want to do here in as much detail as is useful. When\n" +
  "you're ready, use **Draft with AI** to turn these notes into a structured task\n" +
  "description. Questions from the stage AI appear in the **Chat With AI** panel.";

// Real provider-qualified ids — the cascade's dedupe and provider attribution
// use the REAL getCliProvider/normalizeQualifiedModelId, so these must resolve.
const PRIMARY_MODEL = "opencode-cli:opencode/nemotron-free";
const BACKUP_MODEL = "claude-cli:opus@high";
const BACKUP2_MODEL = "codex-cli:gpt-5.6-terra@medium";
// Real provider labels getCliProvider(runnerId).label returns for each.
const PRIMARY_LABEL = "OpenCode";
const BACKUP_LABEL = "Claude Code";

const providerIdFor = (modelId: string): string => modelId.split(":")[0] ?? "opencode-cli";
const nativeIdFor = (modelId: string): string => modelId.split(":").slice(1).join(":");

// A parseable, well-structured draft — what a healthy model returns.
const VALID_RESPONSE =
  "## Draft with AI\n\n" +
  "Add a background export queue.\n\n" +
  "### Behavior change\n\nExports run off the UI thread.\n\n" +
  "### Affected areas\n\n- exportService.ts\n\n" +
  "### Actionable changes\n\n- Add the queue.\n\n" +
  "## Open Questions\n\n- None.\n";

// A clean exit that produced no parseable sections — the "no usable draft" shape.
const UNUSABLE_TEXT = "I looked around the workspace but did not produce a structured draft.";

// Parseable (both ## sections present) but structurally INVALID (no ### sub-
// sections) — triggers the same-model structure-repair retry.
const UNSTRUCTURED_RESPONSE =
  "## Draft with AI\n\nA vague paragraph with none of the required subsections.\n\n" +
  "## Open Questions\n\n- None.\n";

// Per-model result factories (keyed on the model resolveRunnerForModel was asked for).
const completedValid = (modelId: string): AgentRunResult =>
  ({ runnerId: providerIdFor(modelId), modelId: nativeIdFor(modelId), status: "completed", summary: VALID_RESPONSE });
const completedUnusable = (modelId: string): AgentRunResult =>
  ({ runnerId: providerIdFor(modelId), modelId: nativeIdFor(modelId), status: "completed", summary: UNUSABLE_TEXT });
const authFailed = (modelId: string): AgentRunResult =>
  ({ runnerId: providerIdFor(modelId), modelId: nativeIdFor(modelId), status: "failed", failureKind: "generic", authFailure: true, errorMessage: "HTTP 401 Unauthorized. Sign in again to continue." });
const genericFailed = (modelId: string): AgentRunResult =>
  ({ runnerId: providerIdFor(modelId), modelId: nativeIdFor(modelId), status: "failed", failureKind: "generic", errorMessage: "the CLI crashed unexpectedly" });
const transientFailed = (modelId: string): AgentRunResult =>
  ({ runnerId: providerIdFor(modelId), modelId: nativeIdFor(modelId), status: "failed", failureKind: "temporarily-unavailable", errorMessage: "temporarily unavailable" });
const hardFailed = (msg: string) => (modelId: string): AgentRunResult =>
  ({ runnerId: providerIdFor(modelId), modelId: nativeIdFor(modelId), status: "failed", errorMessage: msg });

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

/**
 * Patch the provider boundary. `runFor` decides what each model's runner
 * returns (keyed by model id); `backups` is the configured switch-to-backup
 * list for the "desc" stage. Records the order models actually ran.
 */
function installProviderPatches(
  ran: string[],
  runFor: (modelId: string) => AgentRunResult,
  backups: string[]
): Patched[] {
  const makeRunner = (modelId: string): {
    id: string;
    run: (r: AgentRunRequest) => Promise<AgentRunResult>;
    isAvailable: () => Promise<{ available: boolean }>;
  } => ({
    id: providerIdFor(modelId),
    run: (_request: AgentRunRequest): Promise<AgentRunResult> => {
      ran.push(modelId);
      return Promise.resolve(runFor(modelId));
    },
    isAvailable: (): Promise<{ available: boolean }> => Promise.resolve({ available: true }),
  });

  return [
    patch(modelSelectionModule, "resolveFreshModelForStage", () =>
      Promise.resolve({ modelId: PRIMARY_MODEL, source: "workspace" })
    ),
    patch(runnerRegistryModule, "backupModelsForStage", (stage: string | undefined) =>
      stage === "desc" ? backups : []
    ),
    patch(runnerRegistryModule, "resolveRunnerForModel", (modelId: string) => ({
      runner: makeRunner(modelId),
      provider: providerIdFor(modelId),
      providerLabel: providerIdFor(modelId),
      nativeModelId: nativeIdFor(modelId),
    })),
    patch(runnerRegistryModule, "checkRunnerAvailabilityForModel", () =>
      Promise.resolve({ availability: { available: true }, providerLabel: PRIMARY_LABEL })
    ),
    patch(promptTemplatesModule, "renderPromptTemplate", (
      _extensionUri: unknown,
      _templateName: string,
      variables: { taskDescription: string }
    ) => Promise.resolve(`stub prompt: ${variables.taskDescription}`)),
    patch(runLogModule, "writeRunLog", () => Promise.resolve(vscode.Uri.file(path.join(REAL_ROOT, "run.log")))),
  ];
}

const fakeChatViewProvider = { ask: () => Promise.resolve(undefined) } as unknown as ChatViewProvider;

async function runScenario(
  name: string,
  runFor: (modelId: string) => AgentRunResult,
  backups: string[]
): Promise<{
  result: boolean | undefined;
  ran: string[];
  taskMd: string;
  taskMdBefore: string;
  displayName: string | undefined;
  info: string[];
  errors: string[];
}> {
  // The quota-observation store is a live module singleton; clear it so each
  // scenario's telemetry assertions (and the production quota-exhausted skip)
  // see only THIS scenario's records, not leftovers from an earlier one.
  __quotaTestOnly.clear();
  const folderPath = makeTaskFolder(
    `${name}_${Math.floor(Math.random() * 1e9)}`,
    "Users need to export large datasets without freezing the UI."
  );
  const taskMdBefore = fs.readFileSync(path.join(folderPath, "task.md"), "utf8");
  const inventory = installFakeInventory(folderPath);
  const context = makeExtensionContext();
  const info: string[] = [];
  const errors: string[] = [];
  initNotificationRouter({
    addEntry: (message: string, kind: string) => {
      if (kind === "info") {info.push(message);}
      if (kind === "error") {errors.push(message);}
    },
  } as never);
  const fsBridge = installFsBridge();
  const wsStub = installWorkspaceFoldersStub();
  const ran: string[] = [];
  const patches = installProviderPatches(ran, runFor, backups);
  try {
    const result = await draftTaskWithAI(inventory, context, fakeChatViewProvider, { canonicalId: folderPath });
    const persisted = await readTaskProgress(vscode.Uri.file(folderPath));
    return {
      result,
      ran,
      taskMd: fs.readFileSync(path.join(folderPath, "task.md"), "utf8"),
      taskMdBefore,
      displayName: persisted?.displayName,
      info,
      errors,
    };
  } finally {
    for (const p of patches) {p.restore();}
    fsBridge.restore();
    wsStub.restore();
    deactivateNotificationRouter();
    safeRemoveDir(REAL_ROOT);
  }
}

void describe("draftTaskWithAI — Description-stage backup cascade", () => {
  void it("falls back to the configured backup when the primary completes with an UNUSABLE draft, and updates task.md from the backup", async () => {
    const s = await runScenario(
      "unusable",
      (modelId) => (modelId === PRIMARY_MODEL ? completedUnusable(modelId) : completedValid(modelId)),
      [BACKUP_MODEL]
    );
    assert.equal(s.result, true, "must succeed via the backup");
    assert.deepEqual(s.ran, [PRIMARY_MODEL, BACKUP_MODEL], "primary then backup");
    assert.match(s.taskMd, /Exports run off the UI thread\./, "task.md must carry the backup draft");
    assert.doesNotMatch(s.taskMd, /did not produce a structured draft/, "the primary's unusable text must not be written");
    assert.match(s.displayName ?? "", /background export queue/i, "name derived from the backup draft");
    assert.ok(s.info.some((m) => m.includes(BACKUP_LABEL)), `success toast must name the backup provider (${BACKUP_LABEL}); got ${JSON.stringify(s.info)}`);
  });

  void it("does NOT fall back on a primary AUTH/config failure — it surfaces the error and never runs a backup", async () => {
    const s = await runScenario(
      "primary_auth",
      () => authFailed(PRIMARY_MODEL),
      [BACKUP_MODEL, BACKUP2_MODEL]
    );
    assert.equal(s.result, undefined, "an auth failure must not report success");
    assert.deepEqual(s.ran, [PRIMARY_MODEL], "no backup may run on a primary auth/config failure");
    assert.ok(s.errors.some((m) => /401|Sign in/i.test(m)), `the real auth error must surface; got ${JSON.stringify(s.errors)}`);
    assert.equal(s.taskMd, s.taskMdBefore, "task.md must be untouched");
  });

  void it("continues PAST a generic backup hard failure to a later backup that succeeds (matches reviewActions content-retry)", async () => {
    const s = await runScenario(
      "backup_generic",
      (modelId) => {
        if (modelId === PRIMARY_MODEL) {return completedUnusable(modelId);}
        if (modelId === BACKUP_MODEL) {return genericFailed(modelId);}
        return completedValid(modelId); // BACKUP2 rescues
      },
      [BACKUP_MODEL, BACKUP2_MODEL]
    );
    assert.equal(s.result, true, "a generic backup failure must not abort the cascade");
    assert.deepEqual(s.ran, [PRIMARY_MODEL, BACKUP_MODEL, BACKUP2_MODEL], "all three tried in order");
    assert.match(s.taskMd, /Exports run off the UI thread\./);
    // Finding 4: the failed backup's quota state is recorded (telemetry not blind).
    assert.ok(getQuotaObservation("desc", BACKUP_MODEL) !== undefined, "the backup failure must be recorded for quota telemetry");
  });

  void it("continues PAST a transient backup failure (quota / temporarily-unavailable) to the next backup", async () => {
    const s = await runScenario(
      "backup_transient",
      (modelId) => {
        if (modelId === PRIMARY_MODEL) {return completedUnusable(modelId);}
        if (modelId === BACKUP_MODEL) {return transientFailed(modelId);}
        return completedValid(modelId);
      },
      [BACKUP_MODEL, BACKUP2_MODEL]
    );
    assert.equal(s.result, true);
    assert.deepEqual(s.ran, [PRIMARY_MODEL, BACKUP_MODEL, BACKUP2_MODEL]);
    assert.match(s.taskMd, /Exports run off the UI thread\./);
  });

  void it("does NOT re-run a backup the primary's own internal cascade already executed (no double-charge)", async () => {
    const s = await runScenario(
      "dedupe",
      (modelId) => {
        if (modelId === PRIMARY_MODEL) {
          // The stage-wrapped primary internally substituted BACKUP_MODEL
          // (claude) which completed but returned unusable content — reported
          // via runnerId/modelId pointing at that backup.
          return { runnerId: providerIdFor(BACKUP_MODEL), modelId: nativeIdFor(BACKUP_MODEL), status: "completed", summary: UNUSABLE_TEXT };
        }
        return completedValid(modelId); // whichever backup runs next
      },
      [BACKUP_MODEL, BACKUP2_MODEL]
    );
    assert.equal(s.result, true, "the second backup rescues");
    // BACKUP_MODEL was already run inside the primary's cascade, so the external
    // loop must SKIP it and go straight to BACKUP2 — BACKUP_MODEL never re-runs.
    assert.deepEqual(s.ran, [PRIMARY_MODEL, BACKUP2_MODEL], `must skip the already-run backup; got ${JSON.stringify(s.ran)}`);
    assert.match(s.taskMd, /Exports run off the UI thread\./);
  });

  void it("skips a backup the primary's own internal cascade just exhausted (no second run against dead quota)", async () => {
    const s = await runScenario(
      "quota_skip",
      (modelId) => {
        if (modelId === PRIMARY_MODEL) {
          // Simulate the stage-wrapped primary's internal cascade burning
          // BACKUP_MODEL's quota (fresh 'exhausted' observation) mid-run, then
          // returning a DIFFERENT, content-unusable result — so ranModelId does
          // NOT point at BACKUP_MODEL and only the quota observation catches it.
          recordQuotaObservation("desc", BACKUP_MODEL, "quota", "quota exhausted");
          return completedUnusable(PRIMARY_MODEL);
        }
        return completedValid(modelId); // BACKUP2 rescues
      },
      [BACKUP_MODEL, BACKUP2_MODEL]
    );
    assert.equal(s.result, true, "the un-exhausted backup rescues");
    assert.deepEqual(s.ran, [PRIMARY_MODEL, BACKUP2_MODEL], `must skip the freshly-exhausted backup; got ${JSON.stringify(s.ran)}`);
    assert.ok(!s.ran.includes(BACKUP_MODEL), "must NOT launch a second run against the exhausted backup");
    assert.match(s.taskMd, /Exports run off the UI thread\./);
  });

  void it("attributes the success toast to the provider that ACTUALLY ran, even when the primary silently substituted a backup", async () => {
    const s = await runScenario(
      "attribution",
      (modelId) => {
        if (modelId === PRIMARY_MODEL) {
          // Primary (opencode) internally substituted claude, which produced a
          // valid draft on the first attempt.
          return { runnerId: providerIdFor(BACKUP_MODEL), modelId: nativeIdFor(BACKUP_MODEL), status: "completed", summary: VALID_RESPONSE };
        }
        return completedValid(modelId);
      },
      [BACKUP_MODEL, BACKUP2_MODEL]
    );
    assert.equal(s.result, true);
    assert.deepEqual(s.ran, [PRIMARY_MODEL], "the substituted primary result was already valid — no external backup needed");
    assert.ok(s.info.some((m) => m.includes(BACKUP_LABEL)), `toast must name the real producer (${BACKUP_LABEL}), not the primary (${PRIMARY_LABEL}); got ${JSON.stringify(s.info)}`);
    assert.ok(!s.info.some((m) => m.includes(`(${PRIMARY_LABEL})`)), "toast must not name the primary provider");
  });

  void it("attributes the toast to the REPAIR attempt's provider when the repair (not the first attempt) produced the committed draft", async () => {
    let primaryCall = 0;
    const s = await runScenario(
      "repair_attribution",
      (modelId) => {
        if (modelId === PRIMARY_MODEL) {
          primaryCall += 1;
          if (primaryCall === 1) {
            // First attempt: parseable but unstructured (from opencode) →
            // triggers the same-model structure-repair retry.
            return { runnerId: providerIdFor(PRIMARY_MODEL), modelId: nativeIdFor(PRIMARY_MODEL), status: "completed", summary: UNSTRUCTURED_RESPONSE };
          }
          // Repair attempt: the primary's internal cascade substituted claude,
          // which returned a VALID draft — this is what commits.
          return { runnerId: providerIdFor(BACKUP_MODEL), modelId: nativeIdFor(BACKUP_MODEL), status: "completed", summary: VALID_RESPONSE };
        }
        return completedValid(modelId);
      },
      [BACKUP_MODEL, BACKUP2_MODEL]
    );
    assert.equal(s.result, true);
    assert.deepEqual(s.ran, [PRIMARY_MODEL, PRIMARY_MODEL], "first attempt + repair, both via the primary runner; no external backup");
    assert.match(s.taskMd, /Exports run off the UI thread\./, "the repair attempt's valid draft is committed");
    assert.ok(s.info.some((m) => m.includes(BACKUP_LABEL)), `toast must name the repair attempt's producer (${BACKUP_LABEL}); got ${JSON.stringify(s.info)}`);
    assert.ok(!s.info.some((m) => m.includes(`(${PRIMARY_LABEL})`)), "toast must not name the first attempt's provider");
  });

  void it("does not abort the cascade when a backup's run() throws — it skips to the next backup", async () => {
    const s = await runScenario(
      "backup_throws",
      (modelId) => {
        if (modelId === PRIMARY_MODEL) {return completedUnusable(modelId);}
        if (modelId === BACKUP_MODEL) {throw new Error("runner exploded");}
        return completedValid(modelId); // BACKUP2 rescues
      },
      [BACKUP_MODEL, BACKUP2_MODEL]
    );
    assert.equal(s.result, true, "a thrown backup must not reject the whole operation");
    assert.deepEqual(s.ran, [PRIMARY_MODEL, BACKUP_MODEL, BACKUP2_MODEL], "the throwing backup is attempted, then skipped to the next");
    assert.match(s.taskMd, /Exports run off the UI thread\./);
  });

  void it("with NO backup configured, a hard primary failure keeps the runner's own error and leaves task.md unchanged", async () => {
    const s = await runScenario(
      "nobackup_fail",
      hardFailed("Streaming response failed"),
      []
    );
    assert.equal(s.result, undefined, "a hard failure with no backup must not report success");
    assert.deepEqual(s.ran, [PRIMARY_MODEL], "only the primary runs when no backup exists");
    assert.ok(s.errors.some((m) => /Streaming response failed/.test(m)), `the runner's own error must survive; got ${JSON.stringify(s.errors)}`);
    assert.equal(s.taskMd, s.taskMdBefore, "task.md must be untouched");
  });
});
