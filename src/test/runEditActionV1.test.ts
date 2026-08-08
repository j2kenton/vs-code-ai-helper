/**
 * Coverage for the §7.5 edit-action availability gate and the two-phase
 * driver's request digest (runEditActionV1): checkEditActionAvailabilityV1
 * resolves the WINNING candidate (checkImplementationAvailabilityForModel)
 * before deciding whether a host/tool-calling check applies — skipped for a
 * CLI-resolved winner (which never touches vscode.lm), required for a
 * Copilot-resolved one; an unresolvable/unavailable stage model fails as
 * providerModeUnavailable, and non-workspace paths fail as
 * workspaceRootUnsupported — all BEFORE any task or source read.
 */
import * as assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  checkEditActionAvailabilityV1,
  checkEditActionHostGateV1,
  checkEditActionProviderPathGateV1,
  computeEditRequestDigestV1,
  isEditPreflightActionKeyV1,
  runImplementationOrSealedV1,
} from "../commands/runEditActionV1";

const requireModule = createRequire(__filename);
const childProcess = requireModule("node:child_process") as typeof import("node:child_process");
// Reassigning properties on this required module object affects call sites
// inside runEditActionV1.ts too — tsc's CommonJS output for a named import
// resolves the callee through this exact same namespace object at call time
// (see commitMessageReview.test.ts / publishOwnershipMatrix.test.ts for the
// same pattern against this module).
const runnerRegistryModule = requireModule("../runners/runnerRegistry") as {
  checkImplementationAvailabilityForModel: (...args: unknown[]) => Promise<unknown>;
  runImplementationForModel: (...args: unknown[]) => Promise<unknown>;
};

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
import { resetWorkflowRuntimeServicesForTestV1 } from "../services/workflowRuntimeServicesV1";
import {
  createApplyReviewEditPreflightRowV1,
  createFastForwardPreflightRowV1,
  createImplementationPreflightRowV1,
  createLintPreflightRowV1,
} from "../actions/rows/editPreflightRowsV1";
import { createEditExecutionRowV1 } from "../actions/rows/editExecutionRowV1";

function installWorkspaceFoldersStub(roots: readonly string[]): { restore: () => void } {
  const target = vscode.workspace as unknown as Record<string, unknown>;
  const orig = target.workspaceFolders;
  target.workspaceFolders = roots.map((root, index) => ({
    uri: vscode.Uri.file(root),
    name: path.basename(root),
    index,
  }));
  return { restore: (): void => { target.workspaceFolders = orig; } };
}

/** Makes every `where.exe`/`which` CLI existence probe report "found". */
function installCliFoundStub(): { restore: () => void } {
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = (() => {
    const child = new EventEmitter() as import("node:child_process").ChildProcess;
    process.nextTick(() => child.emit("close", 0));
    return child;
  }) as typeof childProcess.spawn;
  return { restore: (): void => { childProcess.spawn = originalSpawn; } };
}

/** Makes checkImplementationAvailability's Copilot model-list probe report at least one model. */
function installCopilotAvailableStub(): { restore: () => void } {
  const lm = vscode.lm as unknown as { selectChatModels: () => Promise<vscode.LanguageModelChat[]> };
  const original = lm.selectChatModels;
  lm.selectChatModels = (): Promise<vscode.LanguageModelChat[]> =>
    Promise.resolve([{ id: "auto", name: "Auto" } as unknown as vscode.LanguageModelChat]);
  return { restore: (): void => { lm.selectChatModels = original; } };
}

void describe("runEditActionV1 — §7.5 availability", () => {
  void it("accepts a Copilot-backed stage over an open workspace folder and derives the root binding", async () => {
    resetWorkflowRuntimeServicesForTestV1();
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-edit-avail-"));
    const ws = installWorkspaceFoldersStub([workspaceRoot]);
    const copilot = installCopilotAvailableStub();
    try {
      const result = await checkEditActionAvailabilityV1({
        workspaceFsPath: workspaceRoot,
        stageModelId: "copilot:gpt-5",
        stage: "impl",
      });
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.match(result.rootId, /^workspace:/);
        assert.match(result.rootBindingId, /^[0-9a-f]{64}$/);
      }
    } finally {
      copilot.restore();
      ws.restore();
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  void it("accepts a CLI-resolved stage model without requiring the host/LM-tool gate", async () => {
    resetWorkflowRuntimeServicesForTestV1();
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-edit-avail-cli-"));
    const ws = installWorkspaceFoldersStub([workspaceRoot]);
    const cli = installCliFoundStub();
    try {
      const result = await checkEditActionAvailabilityV1({
        workspaceFsPath: workspaceRoot,
        stageModelId: "claude-cli:sonnet",
        stage: "impl",
      });
      // CLI providers run their own direct edit-mode invocation
      // (runImplementationOrSealedV1) rather than the Copilot-only sealed
      // pipeline, so this must succeed even where the host/LM-tool probe
      // below would fail — that probe is irrelevant to a CLI provider.
      assert.equal(result.ok, true);
    } finally {
      cli.restore();
      ws.restore();
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  void it("still accepts a CLI-resolved stage model when the host lacks the tool-calling constructors", async () => {
    resetWorkflowRuntimeServicesForTestV1();
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-edit-avail-cli-nohost-"));
    const ws = installWorkspaceFoldersStub([workspaceRoot]);
    const cli = installCliFoundStub();
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const raw = require("vscode") as Record<string, unknown>;
    const original = raw.LanguageModelToolResultPart;
    delete raw.LanguageModelToolResultPart;
    try {
      const result = await checkEditActionAvailabilityV1({
        workspaceFsPath: workspaceRoot,
        stageModelId: "claude-cli:sonnet",
        stage: "impl",
      });
      assert.equal(result.ok, true);
    } finally {
      raw.LanguageModelToolResultPart = original;
      cli.restore();
      ws.restore();
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  void it("fails as workspaceRootUnsupported for a path that is not an open workspace folder", async () => {
    resetWorkflowRuntimeServicesForTestV1();
    const stray = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-edit-avail-stray-"));
    const ws = installWorkspaceFoldersStub([]);
    const copilot = installCopilotAvailableStub();
    try {
      const result = await checkEditActionAvailabilityV1({
        workspaceFsPath: stray,
        stageModelId: "copilot:gpt-5",
        stage: "impl",
      });
      assert.equal(result.ok === false && result.code, "workspaceRootUnsupported");
    } finally {
      copilot.restore();
      ws.restore();
      fs.rmSync(stray, { recursive: true, force: true });
    }
  });

  void it("fails when the host lacks the tool-calling constructors, before any root check", async () => {
    resetWorkflowRuntimeServicesForTestV1();
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const raw = require("vscode") as Record<string, unknown>;
    const original = raw.LanguageModelToolResultPart;
    delete raw.LanguageModelToolResultPart;
    try {
      const result = await checkEditActionAvailabilityV1({
        workspaceFsPath: "C:\\not-checked",
        stageModelId: "copilot:gpt-5",
        stage: "impl",
      });
      // checkImplementationAvailabilityForModel's own Copilot branch probes
      // this same tool-calling capability internally and reports the missing
      // constructor as a plain provider-unavailable result, so it now
      // surfaces as providerModeUnavailable rather than this function's own
      // (now largely redundant, but still correct) hostToolApiUnavailable
      // check further down — which internal layer supplies the rejection
      // code is not itself the contract; only that it rejects before any
      // task/source read is (AC-HOST-03).
      assert.equal(result.ok, false);
    } finally {
      raw.LanguageModelToolResultPart = original;
    }
  });

  void it("computes the request digest over the exact prompt bytes", () => {
    const digest = computeEditRequestDigestV1("prompt-bytes");
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(digest, computeEditRequestDigestV1("prompt-bytes"));
    assert.notEqual(digest, computeEditRequestDigestV1("prompt-bytes!"));
  });

  void it("exposes the model-independent host gate for handlers' first-statement checks", () => {
    const gate = checkEditActionHostGateV1();
    // Under the test stub (version 1.100.0, tool constructors present) the
    // gate passes; deleting a tool constructor must flip it — proving it
    // needs NO workspace, task, or model input (AC-HOST-03: hostToolApi-
    // Unavailable is decidable before any task/source read).
    assert.equal(gate.ok, true);
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const raw = require("vscode") as Record<string, unknown>;
    const original = raw.LanguageModelToolResultPart;
    delete raw.LanguageModelToolResultPart;
    try {
      const failed = checkEditActionHostGateV1();
      assert.equal(failed.ok === false && failed.code, "hostToolApiUnavailable");
    } finally {
      raw.LanguageModelToolResultPart = original;
    }
  });

  // AI Models rework (§2): a stage with no model of its own resolves through
  // the general (desc) chain via resolveEffectiveStageChainV1 — the §7.5
  // provider-path gate must therefore probe the GENERAL model's provider for
  // a blank stage, not treat the stage as unconfigured.
  void it("resolves a blank stage through the general (desc) chain", async () => {
    const settings = installModelSettings({
      desc: { primary: "claude-cli:sonnet", strategy: "alert-and-wait" },
    });
    const cliFound = installCliFoundStub();
    try {
      const ok = await checkEditActionProviderPathGateV1("impl");
      assert.equal(
        ok.ok,
        true,
        "with the general chain's CLI installed, the blank stage must pass the gate through it"
      );
    } finally {
      cliFound.restore();
      settings.restore();
    }
    // With the general model's CLI NOT installed, the gate's failure must
    // name that provider — proving the blank stage consulted the general
    // chain rather than falling into the unconfigured/Copilot path. Uses a
    // DIFFERENT provider than the leg above: cliAgentRunner caches PATH
    // lookups for 60s, so re-probing "claude" here would answer from the
    // found-cache regardless of the spawn stub.
    const missingCliSettings = installModelSettings({
      desc: { primary: "gemini-cli:default", strategy: "alert-and-wait" },
    });
    const originalSpawn = childProcess.spawn;
    childProcess.spawn = (() => {
      const child = new EventEmitter() as import("node:child_process").ChildProcess;
      process.nextTick(() => child.emit("close", 1));
      return child;
    }) as typeof childProcess.spawn;
    try {
      const failed = await checkEditActionProviderPathGateV1("impl");
      assert.equal(failed.ok, false);
      if (!failed.ok) {
        assert.equal(failed.code, "providerModeUnavailable");
        assert.match(failed.reason, /[Gg]emini/);
      }
    } finally {
      childProcess.spawn = originalSpawn;
      missingCliSettings.restore();
    }
  });

  // Codex review finding (this round): checkEditActionProviderPathGateV1
  // used to decide whether the host floor applied from the PRIMARY's kind
  // alone. Since runImplementationOrSealedV1 can fall through a CLI primary
  // to a Copilot backup, that left the actual host requirement unchecked
  // until deep inside execution (after resolveTask and every artifact read
  // this gate exists to precede) whenever the primary was CLI but the
  // winning candidate turned out to be Copilot. This proves the gate now
  // resolves the WINNING candidate (via checkImplementationAvailabilityForModel,
  // same as runImplementationOrSealedV1 itself) and host-checks THAT one.
  void it("host-checks the winning Copilot backup when the configured CLI primary is not installed", async () => {
    const originalSpawn = childProcess.spawn;
    childProcess.spawn = (() => {
      const child = new EventEmitter() as import("node:child_process").ChildProcess;
      // Every CLI existence probe (where.exe/which) reports "not installed" —
      // the configured CLI primary must be unavailable so the gate is forced
      // to fall through to the configured Copilot backup.
      process.nextTick(() => child.emit("close", 1));
      return child;
    }) as typeof childProcess.spawn;
    const lm = vscode.lm as unknown as { selectChatModels: () => Promise<vscode.LanguageModelChat[]> };
    const originalSelectChatModels = lm.selectChatModels;
    lm.selectChatModels = (): Promise<vscode.LanguageModelChat[]> =>
      Promise.resolve([{ id: "auto", name: "Auto" } as unknown as vscode.LanguageModelChat]);
    const settings = installModelSettings({
      impl: { primary: "opencode-cli:default", backup: "auto", strategy: "switch-to-backup" },
    });
    try {
      const ok = await checkEditActionProviderPathGateV1("impl");
      assert.equal(ok.ok, true, "the Copilot backup is live and the host supports it, so the gate must pass");

      // Removing the tool-calling constructor makes the winning Copilot
      // backup itself unavailable (checkImplementationAvailabilityForModel's
      // own Copilot branch probes the same capability) — either way, the
      // gate must reject BEFORE any task/source read, which is the actual
      // AC-HOST-03 property this fix protects; which of the two internal
      // layers supplies the rejection code is not itself the contract.
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const raw = require("vscode") as Record<string, unknown>;
      const original = raw.LanguageModelToolResultPart;
      delete raw.LanguageModelToolResultPart;
      try {
        const failed = await checkEditActionProviderPathGateV1("impl");
        assert.equal(
          failed.ok,
          false,
          "the CLI primary being down must not mask the winning Copilot backup's own host incapability"
        );
      } finally {
        raw.LanguageModelToolResultPart = original;
      }
    } finally {
      settings.restore();
      childProcess.spawn = originalSpawn;
      lm.selectChatModels = originalSelectChatModels;
    }
  });

  // Codex review finding (P2, 5th round): runImplementationOrSealedV1 used to
  // decide its dispatch path from the PRIMARY's provider kind alone, so a
  // Copilot-resolved primary always ran straight into the sealed pipeline —
  // even when that primary was unavailable and a "switch-to-backup" CLI
  // candidate was configured and live. That backup was reachable through
  // checkEditActionProviderPathGateV1 (which the gate test above already
  // covers) but never actually DISPATCHED to, since the gate and the
  // dispatcher resolved the winning candidate independently. This proves the
  // dispatcher itself now reaches the CLI backup.
  void it("dispatches to the winning CLI backup when the configured Copilot primary is unavailable", async () => {
    const originalAvailability = runnerRegistryModule.checkImplementationAvailabilityForModel;
    const originalRun = runnerRegistryModule.runImplementationForModel;
    let capturedRunOptions: Record<string, unknown> | undefined;
    runnerRegistryModule.checkImplementationAvailabilityForModel = (): Promise<unknown> =>
      Promise.resolve({
        availability: { available: true },
        providerLabel: "Claude Code",
        provider: "claude-cli",
        modelId: "claude-cli:sonnet",
        nativeModelId: "sonnet",
      });
    runnerRegistryModule.runImplementationForModel = (...args: unknown[]): Promise<unknown> => {
      capturedRunOptions = args[0] as Record<string, unknown>;
      return Promise.resolve({
        status: "completed",
        filesChanged: ["a.ts"],
        summary: "stub CLI backup run",
        runnerId: "claude-cli",
        // runImplementationForModel always stamps the identity of whichever
        // candidate actually produced the result at its own return point
        // (see runnerRegistry.ts's withActualIdentity) — this stub mirrors
        // that contract so this test still exercises the real consumption
        // path in runImplementationOrSealedV1.
        actualProviderLabel: "Claude Code",
        actualStoredModelId: "claude-cli:sonnet",
      });
    };
    try {
      const result = await runImplementationOrSealedV1({
        editActionKey: "implementation.v1",
        modelId: "copilot:gpt-5",
        prompt: "do the thing",
        workspaceUri: vscode.Uri.file("C:\\not-checked"),
        token: new vscode.CancellationTokenSource().token,
        onProgress: () => {},
        stage: "impl",
      });
      assert.equal(result.status, "completed");
      assert.equal(result.runnerId, "claude-cli");
      // Durable provider/model attribution task: the result must be stamped
      // with the BACKUP that actually ran (the winning candidate
      // checkImplementationAvailabilityForModel resolved), never the
      // originally requested Copilot primary — the exact mis-stamping this
      // task exists to avoid.
      assert.equal(result.providerLabel, "Claude Code");
      assert.equal(result.storedModelId, "claude-cli:sonnet");
      assert.ok(capturedRunOptions, "runImplementationForModel must have been called");
      assert.equal(capturedRunOptions?.modelId, "claude-cli:sonnet");
      assert.equal(capturedRunOptions?.allowCrossProviderBackups, false);
      // Codex review findings (P2, this round): configuredPrimaryModelId
      // must be the ORIGINAL (Copilot) options.modelId, not the CLI winning
      // candidate — see runnerRegistry.ts's own header for why that's what
      // lets a direct success on this backup be recorded as the active
      // fallback. runCrossProviderBackup must be wired so a RUNTIME failure
      // on this CLI backup can still reach a further Copilot backup through
      // the sealed pipeline instead of runImplementationForModel's own
      // unsealed cascade.
      assert.equal(capturedRunOptions?.configuredPrimaryModelId, "copilot:gpt-5");
      const runCrossProviderBackup = capturedRunOptions?.runCrossProviderBackup as
        | ((modelId: string) => Promise<unknown>)
        | undefined;
      assert.equal(typeof runCrossProviderBackup, "function");
      // Invoking it should reach the REAL runSealedImplementationV1 (this
      // module's own Copilot pipeline), not loop back into
      // runImplementationForModel again — proven by the distinct failure
      // shape only that pipeline's own early gate produces (no LM model
      // configured in this test's environment, so checkEditActionAvailabilityV1
      // rejects before any task/source read, exactly as a fresh Copilot
      // dispatch would).
      const crossProviderResult = (await runCrossProviderBackup!("copilot:some-backup")) as {
        status: string;
        failureKind?: string;
        runnerId: string;
      };
      assert.equal(crossProviderResult.status, "failed");
      assert.equal(crossProviderResult.runnerId, "copilot-lm");
    } finally {
      runnerRegistryModule.checkImplementationAvailabilityForModel = originalAvailability;
      runnerRegistryModule.runImplementationForModel = originalRun;
    }
  });
});

void describe("runEditActionV1 — identity, gate order, and Resume wiring", () => {
  // Compiled tests run from out/test, so the repo root is two levels up.
  const readRepoFile = (relative: string): string =>
    fs.readFileSync(path.join(__dirname, "..", "..", relative), "utf8");

  void it("derives the coordinator binding from ownership, never a raw path (§3.9)", () => {
    const source = readRepoFile("src/commands/runEditActionV1.ts");
    const adapterStart = source.indexOf("export async function runSealedImplementationV1");
    assert.ok(adapterStart >= 0, "runSealedImplementationV1 not found");
    const adapter = source.slice(adapterStart, source.indexOf("\n}", adapterStart));
    assert.ok(
      adapter.includes("getVerifiedTaskBindingIdV1("),
      "task-scoped runs must use the ownership-derived binding digest"
    );
    assert.ok(
      adapter.includes("availability.rootBindingId"),
      "workspace-scoped runs must use the workspace-root binding digest"
    );
    assert.ok(
      !/taskBindingId\s*=\s*canonicalPathKey/.test(adapter) &&
        !adapter.includes("`workspace:${canonicalPathKey"),
      "a raw normalized path must never be used as taskBindingId (it leaks local paths into provider/audit correlation)"
    );
  });

  void it("orders the full §7.5 availability gate before every read in the adapter", () => {
    const source = readRepoFile("src/commands/runEditActionV1.ts");
    const adapterStart = source.indexOf("export async function runSealedImplementationV1");
    const gateIndex = source.indexOf("checkEditActionAvailabilityV1({", adapterStart);
    const bindingIndex = source.indexOf("ensureWorkflowTaskFolderRootV1(", adapterStart);
    const chatReadIndex = source.indexOf("readChatDocumentIdentityV1(", adapterStart);
    assert.ok(gateIndex >= 0 && bindingIndex >= 0 && chatReadIndex >= 0, "expected calls not found");
    assert.ok(
      gateIndex < bindingIndex && gateIndex < chatReadIndex,
      "the availability gate must run before the binding derivation and the Chat-identity read"
    );
  });

  void it("wires the four edit action keys into extension.ts's Chat Resume dispatcher (AC-QUESTION-03)", () => {
    const extensionSource = readRepoFile("src/extension.ts");
    assert.ok(
      extensionSource.includes("isEditPreflightActionKeyV1(actionKey)"),
      "the Resume dispatcher must route edit-preflight action keys"
    );
    assert.ok(
      extensionSource.includes("resumeEditPreflightInteractionV1("),
      "the Resume dispatcher must call resumeEditPreflightInteractionV1"
    );
    assert.equal(isEditPreflightActionKeyV1("implementation.v1"), true);
    assert.equal(isEditPreflightActionKeyV1("fastForward.v1"), true);
    assert.equal(isEditPreflightActionKeyV1("applyReviewEdit.v1"), true);
    assert.equal(isEditPreflightActionKeyV1("lint.v1"), true);
    assert.equal(isEditPreflightActionKeyV1("draft.v1"), false);
  });

  void it("declares real registry stage eligibility on every edit row (no anyStage delegation)", () => {
    const rows = [
      createImplementationPreflightRowV1(),
      createFastForwardPreflightRowV1(),
      createApplyReviewEditPreflightRowV1(),
      createLintPreflightRowV1(),
      createEditExecutionRowV1(),
    ];
    for (const row of rows) {
      assert.notEqual(
        row.eligibility.stages,
        "anyStage",
        `${row.actionKey} must declare an explicit stage list`
      );
      assert.ok(
        Array.isArray(row.eligibility.stages) && row.eligibility.stages.length > 0,
        `${row.actionKey} must list at least one eligible stage`
      );
    }
    const lint = rows.find((row) => row.actionKey === "lint.v1");
    assert.ok(lint, "lint.v1 row missing");
    assert.deepEqual(lint.eligibility.stages, ["publish"], "lint.v1 is Publish-stage only");
  });
});
