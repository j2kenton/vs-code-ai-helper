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
  computeEditRequestDigestV1,
} from "../commands/runEditActionV1";
import { resetWorkflowRuntimeServicesForTestV1 } from "../services/workflowRuntimeServicesV1";

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
});
