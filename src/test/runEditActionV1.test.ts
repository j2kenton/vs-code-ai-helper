/**
 * Coverage for the §7.5 edit-action availability gate and the two-phase
 * driver's request digest (runEditActionV1): host floor + runtime tool
 * shapes fail as hostToolApiUnavailable, CLI-only stage models as
 * providerModeUnavailable, and non-workspace paths as
 * workspaceRootUnsupported — all BEFORE any task or source read.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  checkEditActionAvailabilityV1,
  checkEditActionHostGateV1,
  computeEditRequestDigestV1,
  isEditPreflightActionKeyV1,
} from "../commands/runEditActionV1";
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

void describe("runEditActionV1 — §7.5 availability", () => {
  void it("accepts a Copilot-backed stage over an open workspace folder and derives the root binding", () => {
    resetWorkflowRuntimeServicesForTestV1();
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-edit-avail-"));
    const ws = installWorkspaceFoldersStub([workspaceRoot]);
    try {
      const result = checkEditActionAvailabilityV1({
        workspaceFsPath: workspaceRoot,
        stageModelId: "copilot:gpt-5",
      });
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.match(result.rootId, /^workspace:/);
        assert.match(result.rootBindingId, /^[0-9a-f]{64}$/);
      }
    } finally {
      ws.restore();
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  void it("fails as providerModeUnavailable for a CLI-only stage model (§7.5: no CLI edit path)", () => {
    resetWorkflowRuntimeServicesForTestV1();
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-edit-avail-cli-"));
    const ws = installWorkspaceFoldersStub([workspaceRoot]);
    try {
      const result = checkEditActionAvailabilityV1({
        workspaceFsPath: workspaceRoot,
        stageModelId: "claude-cli:sonnet",
      });
      assert.equal(result.ok === false && result.code, "providerModeUnavailable");
    } finally {
      ws.restore();
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  void it("fails as workspaceRootUnsupported for a path that is not an open workspace folder", () => {
    resetWorkflowRuntimeServicesForTestV1();
    const stray = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-edit-avail-stray-"));
    const ws = installWorkspaceFoldersStub([]);
    try {
      const result = checkEditActionAvailabilityV1({
        workspaceFsPath: stray,
        stageModelId: "copilot:gpt-5",
      });
      assert.equal(result.ok === false && result.code, "workspaceRootUnsupported");
    } finally {
      ws.restore();
      fs.rmSync(stray, { recursive: true, force: true });
    }
  });

  void it("fails as hostToolApiUnavailable when the host lacks the tool-calling constructors, before any root check", () => {
    resetWorkflowRuntimeServicesForTestV1();
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const raw = require("vscode") as Record<string, unknown>;
    const original = raw.LanguageModelToolResultPart;
    delete raw.LanguageModelToolResultPart;
    try {
      const result = checkEditActionAvailabilityV1({
        workspaceFsPath: "C:\\not-checked",
        stageModelId: "copilot:gpt-5",
      });
      assert.equal(result.ok === false && result.code, "hostToolApiUnavailable");
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
