/**
 * bugs5 Step 25 (item 5): a remembered fallback follows the chain it was made for. Replays the cloud-box
 * incident: DevPass fails (HTTP 402), Claude Code is remembered, the owner moves Kimi ahead of Claude in AI
 * Models, and the next dispatch must start at Kimi and say why.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, afterEach, describe, it } from "node:test";
import * as vscode from "vscode";
import {
  collectSkippedCandidatesV1,
  describeRememberedFallbackV1,
  describeSkippedCandidatesV1,
  fingerprintStageChainV1,
  getModelResolutionNoteV1,
  judgeRememberedFallbackV1,
  listRememberedFallbacksV1,
} from "../utils/rememberedFallbackV1";
import { resolveFreshModelForStage, resolveModelForStage } from "../utils/modelSelection";
import { isModelProviderEnabled } from "../config/settings";
import { recordActiveFallbackModel } from "../runners/runnerRegistry";
import { candidateInvocationMessageV1 } from "../utils/dispatchModelChainV1";
import type { TaskProgress } from "../types/taskProgress";

const DEVPASS = "devpass-cli:deepseek-v4-pro";
const CLAUDE = "claude-cli:claude-sonnet-5-5@high";
const KIMI = "kimi-cli:kimi-code/k3.1-pro";
const label = (id: string): string => id.split(":")[0] ?? id;

const NOW = new Date("2026-11-01T06:00:00.000Z");

void describe("collectSkippedCandidatesV1 / describeSkippedCandidatesV1", () => {
  void it("lists switched-off entries, switched-off providers and quota-blocked accounts, each with its reason", () => {
    const skipped = collectSkippedCandidatesV1({
      configured: [
        { modelId: KIMI, enabled: false },
        { modelId: DEVPASS, enabled: true },
        { modelId: "antigravity-cli:x", enabled: true },
        { modelId: CLAUDE, enabled: true },
      ],
      chosenModelId: CLAUDE,
      isProviderEnabled: (id) => id !== DEVPASS,
      quotaBlockedUntil: (id) => (id.startsWith("antigravity") ? "2026-11-08 12:00 UTC" : undefined),
    });
    assert.deepEqual(skipped, [
      { modelId: KIMI, reason: "switched off in AI Models" },
      { modelId: DEVPASS, reason: "its provider is switched off in Provider Selection" },
      { modelId: "antigravity-cli:x", reason: "quota reached, resets 2026-11-08 12:00 UTC" },
    ]);
    assert.equal(
      describeSkippedCandidatesV1(skipped, label),
      "not used: kimi-cli (switched off in AI Models); devpass-cli (its provider is switched off in Provider Selection); antigravity-cli (quota reached, resets 2026-11-08 12:00 UTC)"
    );
  });

  void it("lists a candidate whose mode the stage cannot use, with its reason", () => {
    const skipped = collectSkippedCandidatesV1({
      configured: [
        { modelId: CLAUDE, enabled: true },
        { modelId: "gpt-5", enabled: true },
      ],
      chosenModelId: CLAUDE,
      isProviderEnabled: () => true,
      modeUnsupportedReason: (id) => (id === "gpt-5" ? "Copilot is not used as a backup for unattended code edits" : undefined),
    });
    assert.deepEqual(skipped, [
      { modelId: "gpt-5", reason: "Copilot is not used as a backup for unattended code edits" },
    ]);
    assert.equal(
      describeSkippedCandidatesV1(skipped, (id) => id),
      "not used: gpt-5 (Copilot is not used as a backup for unattended code edits)"
    );
  });

  void it("lists nothing when every other candidate is simply usable", () => {
    const skipped = collectSkippedCandidatesV1({
      configured: [{ modelId: KIMI, enabled: true }, { modelId: CLAUDE, enabled: true }],
      chosenModelId: KIMI,
      isProviderEnabled: () => true,
    });
    assert.deepEqual(skipped, []);
    assert.equal(describeSkippedCandidatesV1(skipped, label), undefined);
    assert.equal(
      describeSkippedCandidatesV1([{ modelId: KIMI, reason: "not tried: a remembered fallback is in use" }], label),
      undefined
    );
  });
});

void describe("listRememberedFallbacksV1", () => {
  const pinned = {
    status: "active",
    fallbackActive: { impl: true, "impl-high-review": true },
    fallbackModelId: { impl: CLAUDE },
    fallbackFailedModelId: { impl: DEVPASS },
    fallbackFailureReason: { impl: "HTTP 402" },
  } as unknown as TaskProgress;

  void it("lists a named pin with its cause, skips bare reservations and completed tasks", () => {
    const items = listRememberedFallbacksV1(
      [
        { folderPath: "/t/a", name: "bugs4", progress: pinned },
        { folderPath: "/t/b", name: "done", progress: { ...pinned, status: "completed" } as TaskProgress },
      ],
      label
    );
    assert.equal(items.length, 1);
    assert.equal(items[0]?.taskName, "bugs4");
    assert.equal(items[0]?.stage, "impl");
    assert.equal(items[0]?.modelLabel, "claude-cli");
    assert.match(items[0]?.cause ?? "", /remembered after devpass-cli failed.*HTTP 402/);
  });
});

void describe("fingerprintStageChainV1", () => {
  const chain = { strategy: "switch-to-backup", primary: DEVPASS, backups: [CLAUDE] };

  void it("is stable for an identical chain", () => {
    assert.equal(fingerprintStageChainV1(chain), fingerprintStageChainV1({ ...chain, backups: [CLAUDE] }));
  });

  void it("changes with the primary, the backups, their order, the strategy and the enabled flags", () => {
    const base = fingerprintStageChainV1(chain);
    assert.notEqual(fingerprintStageChainV1({ ...chain, primary: KIMI }), base);
    assert.notEqual(fingerprintStageChainV1({ ...chain, backups: [CLAUDE, KIMI] }), base);
    assert.notEqual(
      fingerprintStageChainV1({ ...chain, primary: KIMI, backups: [DEVPASS, CLAUDE] }),
      fingerprintStageChainV1({ ...chain, primary: KIMI, backups: [CLAUDE, DEVPASS] })
    );
    assert.notEqual(fingerprintStageChainV1({ ...chain, strategy: "alert-and-wait" }), base);
    assert.notEqual(fingerprintStageChainV1(chain, (id) => id !== CLAUDE), base);
  });
});

void describe("judgeRememberedFallbackV1", () => {
  const pin = (extra: Partial<TaskProgress> = {}): Pick<TaskProgress, "fallbackActive" | "fallbackChainFingerprint" | "fallbackResetTime"> => ({
    fallbackActive: { impl: true },
    fallbackChainFingerprint: { impl: "fp-a" },
    ...extra,
  });

  void it("reports no pin when none is active", () => {
    assert.deepEqual(judgeRememberedFallbackV1({ progress: {}, stage: "impl", currentFingerprint: "fp-a", now: NOW }), { kind: "none" });
  });

  void it("keeps a pin made for the current chain", () => {
    assert.deepEqual(judgeRememberedFallbackV1({ progress: pin(), stage: "impl", currentFingerprint: "fp-a", now: NOW }), {
      kind: "keep",
      legacy: false,
    });
  });

  void it("clears a pin made for a different chain", () => {
    const verdict = judgeRememberedFallbackV1({ progress: pin(), stage: "impl", currentFingerprint: "fp-b", now: NOW });
    assert.equal(verdict.kind, "clear");
    assert.match(verdict.kind === "clear" ? verdict.reason : "", /chain was changed/);
  });

  void it("clears a pin once the provider's reset time has passed, and keeps it before", () => {
    const expired = pin({ fallbackResetTime: { impl: "2026-11-01T05:00:00.000Z" } });
    const pending = pin({ fallbackResetTime: { impl: "2026-11-02T05:00:00.000Z" } });
    assert.equal(judgeRememberedFallbackV1({ progress: expired, stage: "impl", currentFingerprint: "fp-a", now: NOW }).kind, "clear");
    assert.equal(judgeRememberedFallbackV1({ progress: pending, stage: "impl", currentFingerprint: "fp-a", now: NOW }).kind, "keep");
  });

  void it("clears a named pin from before the fingerprint existed, but leaves a bare reservation alone", () => {
    const legacy = { fallbackActive: { impl: true }, fallbackModelId: { impl: "claude-cli:claude-sonnet-5-5@high" } } as const;
    assert.equal(
      judgeRememberedFallbackV1({ progress: legacy, stage: "impl", currentFingerprint: "fp-a", now: NOW }).kind,
      "clear"
    );
    assert.deepEqual(
      judgeRememberedFallbackV1({ progress: { fallbackActive: { impl: true } }, stage: "impl", currentFingerprint: "fp-a", now: NOW }),
      { kind: "keep", legacy: true }
    );
  });

  void it("only looks at its own stage", () => {
    assert.equal(judgeRememberedFallbackV1({ progress: pin(), stage: "impl-high-review", currentFingerprint: "x", now: NOW }).kind, "none");
  });
});

void describe("describeRememberedFallbackV1", () => {
  void it("names the pin, its cause and the model not tried", () => {
    const failedAt = "2026-11-01T04:54:00.000Z";
    const text = describeRememberedFallbackV1(
      { modelId: CLAUDE, failedModelId: DEVPASS, failureReason: "HTTP 402", failedAt },
      [{ modelId: KIMI, reason: "x" }],
      label
    );
    const d = new Date(failedAt);
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    assert.equal(text, `using claude-cli, remembered after devpass-cli failed at ${hhmm} (HTTP 402); kimi-cli not tried`);
  });

  void it("says so when the pin predates the recorded cause", () => {
    assert.match(describeRememberedFallbackV1({ modelId: CLAUDE }, [], label), /set by an older version/);
  });
});

void describe("candidateInvocationMessageV1 carries the model choice", () => {
  void it("appends the note to a first-model message, never to a backup message", () => {
    assert.match(candidateInvocationMessageV1("Apply Review", CLAUDE, "Claude Code", false, undefined, "using Claude Code, remembered"), /Model choice: using Claude Code, remembered\.$/);
    assert.doesNotMatch(candidateInvocationMessageV1("Apply Review", CLAUDE, "Claude Code", true, "quota", "using Claude Code"), /Model choice/);
    assert.equal(candidateInvocationMessageV1("Apply Review", CLAUDE, "Claude Code", false), `Running Apply Review with Claude Code — ${CLAUDE}.`);
  });
});

const ROOT = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ensemble-remembered-fallback-"));
after(() => {
  nodeFs.rmSync(ROOT, { recursive: true, force: true });
});

function installModelSettings(modelSettings: Record<string, unknown>): () => void {
  const ws = vscode.workspace as unknown as Record<string, unknown>;
  const original = ws.getConfiguration;
  ws.getConfiguration = (): unknown => ({
    get: (key: string, defaultValue?: unknown): unknown => (key === "modelSettings" ? modelSettings : defaultValue),
    inspect: () => undefined,
    update: () => Promise.resolve(),
  });
  // The strict task-progress reader goes through workspace.fs.readFile, which the unit-test stub leaves out.
  const fsApi = vscode.workspace.fs as unknown as { readFile: unknown };
  const originalReadFile = fsApi.readFile;
  fsApi.readFile = async (uri: vscode.Uri): Promise<Uint8Array> =>
    new TextEncoder().encode(await nodeFs.promises.readFile(uri.fsPath, "utf8"));
  return (): void => {
    ws.getConfiguration = original;
    fsApi.readFile = originalReadFile;
  };
}

function makePinnedTask(name: string, chainForPin: { primary: string; backups: string[] }): vscode.Uri {
  const folder = nodePath.join(ROOT, ".ensemble", name);
  nodeFs.mkdirSync(folder, { recursive: true });
  const progress = {
    taskFolder: name,
    currentStage: "impl-high-review",
    status: "active",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ownership: {
      metaRoot: nodePath.join(ROOT, ".ensemble"),
      projectRoot: ROOT,
      workspaceRoot: ROOT,
      boundAt: "2026-11-01T00:00:00.000Z",
    },
    fallbackActive: { impl: true },
    fallbackModelId: { impl: CLAUDE },
    fallbackChainFingerprint: {
      impl: fingerprintStageChainV1({ strategy: "switch-to-backup", ...chainForPin }, isModelProviderEnabled),
    },
    fallbackFailedModelId: { impl: DEVPASS },
    fallbackFailureReason: { impl: "HTTP 402" },
    fallbackFailedAt: { impl: "2026-11-01T04:54:00.000Z" },
  } as unknown as TaskProgress;
  nodeFs.writeFileSync(nodePath.join(folder, "task-progress.json"), JSON.stringify(progress, undefined, 2), "utf8");
  return vscode.Uri.file(folder);
}

function readProgress(folder: vscode.Uri): TaskProgress {
  return JSON.parse(nodeFs.readFileSync(nodePath.join(folder.fsPath, "task-progress.json"), "utf8")) as TaskProgress;
}

void describe("resolveModelForStage follows the chain a pin was made for", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  void it("keeps using the remembered fallback while the chain is unchanged, and names it with what was not tried", async () => {
    restore = installModelSettings({ impl: { primary: DEVPASS, backups: [CLAUDE], strategy: "switch-to-backup" } });
    const task = makePinnedTask("pin-kept", { primary: DEVPASS, backups: [CLAUDE] });

    const resolved = await resolveModelForStage(task, "impl");

    assert.equal(resolved.modelId, CLAUDE);
    assert.equal(resolved.rememberedFallback?.failedModelId, DEVPASS);
    assert.deepEqual(resolved.skippedCandidates?.map((s) => s.modelId), [DEVPASS]);
    assert.match(getModelResolutionNoteV1(task.fsPath, "impl") ?? "", /remembered after .*failed at \d\d:\d\d \(HTTP 402\)/);
    assert.equal(readProgress(task).fallbackActive?.impl, true, "the pin is untouched");
  });

  void it("replay: the owner puts Kimi ahead of Claude, the pin is dropped and the primary runs, with the reason recorded", async () => {
    // The pin was made when the chain was DevPass -> Claude. The owner now saves Kimi -> DevPass -> Claude.
    restore = installModelSettings({ impl: { primary: KIMI, backups: [DEVPASS, CLAUDE], strategy: "switch-to-backup" } });
    const task = makePinnedTask("pin-cleared", { primary: DEVPASS, backups: [CLAUDE] });

    const resolved = await resolveModelForStage(task, "impl");

    assert.equal(resolved.modelId, KIMI, "the next dispatch starts at the chain's primary");
    assert.equal(resolved.rememberedFallback, undefined);
    assert.match(getModelResolutionNoteV1(task.fsPath, "impl") ?? "", /^remembered fallback cleared: the stage's model chain was changed/);
    const after = readProgress(task);
    assert.equal(after.fallbackActive?.impl, undefined);
    assert.equal(after.fallbackModelId?.impl, undefined);
    assert.equal(after.fallbackChainFingerprint?.impl, undefined);
    assert.equal(after.fallbackFailedModelId?.impl, undefined);
    assert.equal(after.fallbackFailureReason?.impl, undefined);
    assert.equal(after.fallbackFailedAt?.impl, undefined);
  });

  void it("a pin whose provider reset time has passed is dropped", async () => {
    restore = installModelSettings({ impl: { primary: DEVPASS, backups: [CLAUDE], strategy: "switch-to-backup" } });
    const task = makePinnedTask("pin-expired", { primary: DEVPASS, backups: [CLAUDE] });
    const file = nodePath.join(task.fsPath, "task-progress.json");
    const progress = readProgress(task);
    nodeFs.writeFileSync(
      file,
      JSON.stringify({ ...progress, fallbackResetTime: { impl: "2026-11-01T05:00:00.000Z" } }, undefined, 2),
      "utf8"
    );

    const resolved = await resolveModelForStage(task, "impl");

    assert.equal(resolved.modelId, DEVPASS);
    assert.match(getModelResolutionNoteV1(task.fsPath, "impl") ?? "", /reset time .* has passed/);
    assert.equal(readProgress(task).fallbackActive?.impl, undefined);
  });

  void it("a fresh run notes that the pin was cleared because it was started fresh", async () => {
    restore = installModelSettings({ impl: { primary: DEVPASS, backups: [CLAUDE], strategy: "switch-to-backup" } });
    const task = makePinnedTask("pin-fresh", { primary: DEVPASS, backups: [CLAUDE] });

    const resolved = await resolveFreshModelForStage(task, "impl");

    assert.equal(resolved.modelId, DEVPASS);
    assert.match(getModelResolutionNoteV1(task.fsPath, "impl") ?? "", /started fresh/);
    assert.equal(readProgress(task).fallbackActive?.impl, undefined);
  });
});

void describe("recordActiveFallbackModel stores what a later round needs to explain and expire the pin", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  function unpinnedTask(name: string): vscode.Uri {
    const task = makePinnedTask(name, { primary: DEVPASS, backups: [CLAUDE] });
    const file = nodePath.join(task.fsPath, "task-progress.json");
    const { fallbackActive, fallbackModelId, fallbackChainFingerprint, fallbackFailedModelId, fallbackFailureReason, fallbackFailedAt, ...rest } =
      readProgress(task);
    void [fallbackActive, fallbackModelId, fallbackChainFingerprint, fallbackFailedModelId, fallbackFailureReason, fallbackFailedAt];
    nodeFs.writeFileSync(file, JSON.stringify(rest, undefined, 2), "utf8");
    return task;
  }

  void it("records the chain fingerprint, the failed model, a readable cause and the provider's reset time", async () => {
    restore = installModelSettings({ impl: { primary: DEVPASS, backups: [CLAUDE], strategy: "switch-to-backup" } });
    const task = unpinnedTask("record-with-failure");

    const recorded = await recordActiveFallbackModel(task, "impl", CLAUDE, {
      failure: { modelId: DEVPASS, reason: "HTTP 402 payment required. Quota resets in 22 hours" },
    });

    assert.equal(recorded, true);
    const progress = readProgress(task);
    assert.equal(progress.fallbackModelId?.impl, CLAUDE);
    assert.equal(
      progress.fallbackChainFingerprint?.impl,
      fingerprintStageChainV1({ strategy: "switch-to-backup", primary: DEVPASS, backups: [CLAUDE] }, isModelProviderEnabled)
    );
    assert.equal(progress.fallbackFailedModelId?.impl, DEVPASS);
    assert.match(progress.fallbackFailureReason?.impl ?? "", /HTTP 402/);
    assert.ok(progress.fallbackFailedAt?.impl, "the failure time is recorded");
    const resetMs = Date.parse(progress.fallbackResetTime?.impl ?? "");
    assert.ok(Number.isFinite(resetMs), "a reset time the provider gave is recorded");
    assert.ok(Math.abs(resetMs - Date.now() - 22 * 3_600_000) < 60_000, "about 22 hours from now");
  });

  void it("a later write for the same model without a failure keeps the cause; a different model drops it", async () => {
    restore = installModelSettings({ impl: { primary: DEVPASS, backups: [CLAUDE, KIMI], strategy: "switch-to-backup" } });
    const task = unpinnedTask("record-repeat");
    await recordActiveFallbackModel(task, "impl", CLAUDE, { failure: { modelId: DEVPASS, reason: "HTTP 402" } });

    await recordActiveFallbackModel(task, "impl", CLAUDE);
    assert.equal(readProgress(task).fallbackFailedModelId?.impl, DEVPASS, "the same model keeps its recorded cause");

    await recordActiveFallbackModel(task, "impl", KIMI);
    const after = readProgress(task);
    assert.equal(after.fallbackModelId?.impl, KIMI);
    assert.equal(after.fallbackFailedModelId?.impl, undefined, "a cause that belonged to another model is dropped");
    assert.equal(after.fallbackFailureReason?.impl, undefined);
  });
});
