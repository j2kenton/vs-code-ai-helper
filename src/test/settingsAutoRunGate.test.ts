/**
 * Coverage for the fast-forward/auto-run gating decided in the defect-batch
 * plan (Task C):
 *
 *  1. Namespace precedence in readSetting: whenever ANY `ensemble.*` value
 *     exists at any scope, the deprecated `vs-code-ai-helper.*` twin is
 *     ignored entirely. Previously a leftover legacy workspace value could
 *     shadow an `ensemble.*` global value written by the Settings UI — the
 *     verified match for "I turned every fast-forward option off and it
 *     still runs".
 *  2. resolveAutoRunMode is the single dispatch-time gate: it reads the
 *     setting fresh per call, and re-validates a chained caller-supplied
 *     "auto-fast-forward" marker against the setting that minted it
 *     (completeAndMoveOnTriggersAI), so a stale queued arg cannot resurrect
 *     a disabled automation.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import * as vscode from "vscode";
import {
  getAutoAdvanceMode,
  getAutoReviewAfterPlanMode,
  getCompleteAndMoveOnTriggersAIMode,
  resolveAutoRunMode,
} from "../config/settings";

interface ScopeValues {
  global?: Record<string, unknown>;
  workspace?: Record<string, unknown>;
  workspaceFolder?: Record<string, unknown>;
}

/**
 * Section-aware WorkspaceConfiguration stub: `ensemble` and the legacy
 * `vs-code-ai-helper` section each get their own per-scope value maps, so
 * readSetting's cross-namespace precedence is observable. `get` mirrors VS
 * Code's merge (folder > workspace > global > provided default).
 */
function installConfigStub(values: { ensemble?: ScopeValues; legacy?: ScopeValues }): {
  restore: () => void;
} {
  const workspace = vscode.workspace as unknown as Record<string, unknown>;
  const original = workspace.getConfiguration;
  workspace.getConfiguration = (section?: string): Record<string, unknown> => {
    const scoped =
      section === "ensemble" ? values.ensemble
        : section === "vs-code-ai-helper" ? values.legacy
          : undefined;
    return {
      get: (key: string, defaultValue?: unknown): unknown => {
        for (const scope of ["workspaceFolder", "workspace", "global"] as const) {
          const value = scoped?.[scope]?.[key];
          if (value !== undefined) {
            return value;
          }
        }
        return defaultValue;
      },
      inspect: (key: string) => ({
        key,
        globalValue: scoped?.global?.[key],
        workspaceValue: scoped?.workspace?.[key],
        workspaceFolderValue: scoped?.workspaceFolder?.[key],
      }),
      update: (): Promise<void> => Promise.resolve(),
    };
  };
  return {
    restore: (): void => {
      workspace.getConfiguration = original;
    },
  };
}

void test("an ensemble value at any scope makes the legacy key ignored entirely", () => {
  // The Settings UI writes global scope; a leftover legacy workspace value
  // must not shadow it.
  const stub = installConfigStub({
    ensemble: { global: { autoAdvanceEnabled: "off" } },
    legacy: { workspace: { autoAdvanceEnabled: "auto-fast-forward" } },
  });
  try {
    assert.equal(getAutoAdvanceMode(), "off");
    assert.equal(resolveAutoRunMode("autoAdvance"), "off");
  } finally {
    stub.restore();
  }
});

void test("a legacy value is still honored when no ensemble value exists at any scope", () => {
  const stub = installConfigStub({
    legacy: { workspace: { completeAndMoveOnTriggersAI: "off" } },
  });
  try {
    assert.equal(getCompleteAndMoveOnTriggersAIMode(), "off");
  } finally {
    stub.restore();
  }
});

void test("legacy boolean values keep their true=auto / false=off meaning through the gate", () => {
  const stub = installConfigStub({
    legacy: { global: { autoAdvanceEnabled: true, autoReviewAfterPlan: false } },
  });
  try {
    assert.equal(getAutoAdvanceMode(), "auto");
    assert.equal(getAutoReviewAfterPlanMode(), "off");
  } finally {
    stub.restore();
  }
});

void test("shipped defaults: one AI action per Complete & Move On click, everything else off", () => {
  const stub = installConfigStub({});
  try {
    assert.equal(resolveAutoRunMode("autoAdvance"), "off");
    assert.equal(resolveAutoRunMode("autoReviewAfterPlan"), "off");
    assert.equal(resolveAutoRunMode("autoReviewAfterImplementation"), "off");
    assert.equal(resolveAutoRunMode("completeAndMoveOn"), "auto");
  } finally {
    stub.restore();
  }
});

void test("a chained auto-fast-forward marker is dropped once completeAndMoveOnTriggersAI is no longer auto-fast-forward", () => {
  const stub = installConfigStub({
    ensemble: {
      global: {
        completeAndMoveOnTriggersAI: "auto",
        autoReviewAfterPlan: "off",
      },
    },
  });
  try {
    assert.equal(resolveAutoRunMode("autoReviewAfterPlan", "auto-fast-forward"), "off");
  } finally {
    stub.restore();
  }
});

void test("a chained auto-fast-forward marker is honored while completeAndMoveOnTriggersAI still says auto-fast-forward", () => {
  const stub = installConfigStub({
    ensemble: {
      global: {
        completeAndMoveOnTriggersAI: "auto-fast-forward",
        autoReviewAfterPlan: "off",
      },
    },
  });
  try {
    assert.equal(
      resolveAutoRunMode("autoReviewAfterPlan", "auto-fast-forward"),
      "auto-fast-forward"
    );
  } finally {
    stub.restore();
  }
});

void test("every auto option off in both namespaces resolves off for every kind", () => {
  const stub = installConfigStub({
    ensemble: {
      global: {
        autoAdvanceEnabled: "off",
        autoReviewAfterPlan: "off",
        autoReviewAfterImplementation: "off",
        completeAndMoveOnTriggersAI: "off",
      },
    },
    legacy: {
      workspace: {
        autoAdvanceEnabled: "auto-fast-forward",
        autoReviewAfterPlan: "auto-fast-forward",
        autoReviewAfterImplementation: "auto-fast-forward",
        completeAndMoveOnTriggersAI: "auto-fast-forward",
      },
    },
  });
  try {
    for (const kind of [
      "autoAdvance",
      "autoReviewAfterPlan",
      "autoReviewAfterImplementation",
      "completeAndMoveOn",
    ] as const) {
      assert.equal(resolveAutoRunMode(kind), "off", kind);
      // Even a caller-supplied chained marker cannot resurrect the loop.
      assert.equal(resolveAutoRunMode(kind, "auto-fast-forward"), "off", `${kind} + marker`);
    }
  } finally {
    stub.restore();
  }
});
