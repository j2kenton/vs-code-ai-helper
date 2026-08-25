import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import * as vscode from "vscode";
import {
  computeDegenerateReviewEpisodeModelIdsV1,
  decideDegenerateReviewBackupAdvanceV1,
} from "../utils/degenerateReviewBackupAdvanceV1";
import { dispatchDegenerateReviewBackupAdvanceV1 } from "../commands/reviewActions";
import { RoundOutcomeEntryV1 } from "../types/taskProgress";

function entry(overrides: Partial<RoundOutcomeEntryV1> = {}): RoundOutcomeEntryV1 {
  return {
    stage: "impl-high-review",
    classification: "rejected-degenerate",
    at: "2026-08-24T00:00:00.000Z",
    modelId: "kimi-code:k3",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeDegenerateReviewEpisodeModelIdsV1
// ---------------------------------------------------------------------------

void test("collects the trailing run of rejected-degenerate model ids for the stage", () => {
  const outcomes = [
    entry({ modelId: "codex-cli:gpt" }),
    entry({ modelId: "kimi-code:k3" }),
  ];
  assert.deepEqual(
    computeDegenerateReviewEpisodeModelIdsV1(outcomes, "impl-high-review"),
    ["kimi-code:k3", "codex-cli:gpt"]
  );
});

void test("a real (non-degenerate) entry for the same stage ends the episode", () => {
  const outcomes = [
    entry({ modelId: "codex-cli:gpt" }),
    { stage: "impl-high-review" as const, classification: "edits-produced" as const, at: "2026-08-24T01:00:00.000Z" },
    entry({ modelId: "kimi-code:k3" }),
  ];
  assert.deepEqual(computeDegenerateReviewEpisodeModelIdsV1(outcomes, "impl-high-review"), ["kimi-code:k3"]);
});

void test("entries for a different stage are ignored, not treated as episode breakers", () => {
  const outcomes = [
    entry({ modelId: "codex-cli:gpt", stage: "plan-high-review" }),
    entry({ modelId: "kimi-code:k3" }),
  ];
  assert.deepEqual(computeDegenerateReviewEpisodeModelIdsV1(outcomes, "impl-high-review"), ["kimi-code:k3"]);
});

void test("returns empty when no entries exist for the stage", () => {
  assert.deepEqual(computeDegenerateReviewEpisodeModelIdsV1(undefined, "impl-high-review"), []);
});

// wf10 review fix (Part 5 step 15): a successfully SCORED review never
// appends a `roundOutcomes` entry — only `rejected-degenerate` rounds do —
// so an old episode's rejections are otherwise indistinguishable from the
// current one unless `latestScoredReviewAt` is threaded through.
void test("a scored review's timestamp ends the episode even with no intervening roundOutcomes entry", () => {
  const outcomes = [
    entry({ modelId: "codex-cli:gpt", at: "2026-08-20T00:00:00.000Z" }),
    entry({ modelId: "kimi-code:k3", at: "2026-08-23T00:00:00.000Z" }),
  ];
  // A real score published at 2026-08-24 (after both old rejections, before
  // "now") ends the episode those two rejections belonged to — a fresh
  // rejection this episode should not resurrect them.
  assert.deepEqual(
    computeDegenerateReviewEpisodeModelIdsV1(outcomes, "impl-high-review", "2026-08-24T00:00:00.000Z"),
    []
  );
});

void test("rejections strictly after the latest scored review still count toward the episode", () => {
  const outcomes = [
    entry({ modelId: "codex-cli:gpt", at: "2026-08-20T00:00:00.000Z" }),
    entry({ modelId: "kimi-code:k3", at: "2026-08-25T00:00:00.000Z" }),
  ];
  assert.deepEqual(
    computeDegenerateReviewEpisodeModelIdsV1(outcomes, "impl-high-review", "2026-08-24T00:00:00.000Z"),
    ["kimi-code:k3"]
  );
});

void test("with no latestScoredReviewAt given, behavior is unchanged (backward compatible)", () => {
  const outcomes = [
    entry({ modelId: "codex-cli:gpt", at: "2026-08-20T00:00:00.000Z" }),
    entry({ modelId: "kimi-code:k3", at: "2026-08-25T00:00:00.000Z" }),
  ];
  assert.deepEqual(
    computeDegenerateReviewEpisodeModelIdsV1(outcomes, "impl-high-review"),
    ["kimi-code:k3", "codex-cli:gpt"]
  );
});

// ---------------------------------------------------------------------------
// decideDegenerateReviewBackupAdvanceV1
// ---------------------------------------------------------------------------

void test("advances automatically to the first untried backup under switch-to-backup", () => {
  const decision = decideDegenerateReviewBackupAdvanceV1({
    chainBackups: ["codex-cli:gpt", "grok-4.6", "claude-cli:sonnet"],
    strategy: "switch-to-backup",
    currentModelId: "kimi-code:k3",
    episodeTriedModelIds: ["codex-cli:gpt"],
  });
  assert.deepEqual(decision, { kind: "advance", nextModelId: "grok-4.6" });
});

void test("offers a manual retry (not automatic) under pause-and-resume", () => {
  const decision = decideDegenerateReviewBackupAdvanceV1({
    chainBackups: ["codex-cli:gpt"],
    strategy: "pause-and-resume",
    currentModelId: "kimi-code:k3",
    episodeTriedModelIds: [],
  });
  assert.deepEqual(decision, { kind: "manual", nextModelId: "codex-cli:gpt" });
});

void test("offers a manual retry under alert-and-wait", () => {
  const decision = decideDegenerateReviewBackupAdvanceV1({
    chainBackups: ["codex-cli:gpt"],
    strategy: "alert-and-wait",
    currentModelId: "kimi-code:k3",
    episodeTriedModelIds: [],
  });
  assert.deepEqual(decision, { kind: "manual", nextModelId: "codex-cli:gpt" });
});

void test("reports exhausted once every configured backup has been tried this episode", () => {
  const decision = decideDegenerateReviewBackupAdvanceV1({
    chainBackups: ["codex-cli:gpt", "grok-4.6"],
    strategy: "switch-to-backup",
    currentModelId: "grok-4.6",
    episodeTriedModelIds: ["kimi-code:k3", "codex-cli:gpt"],
  });
  assert.deepEqual(decision, { kind: "exhausted" });
});

void test("reports exhausted with no configured backups at all", () => {
  const decision = decideDegenerateReviewBackupAdvanceV1({
    chainBackups: [],
    strategy: "switch-to-backup",
    currentModelId: "kimi-code:k3",
    episodeTriedModelIds: [],
  });
  assert.deepEqual(decision, { kind: "exhausted" });
});

void test("the current round's own model is always excluded even if it also appears in chainBackups", () => {
  const decision = decideDegenerateReviewBackupAdvanceV1({
    chainBackups: ["kimi-code:k3", "codex-cli:gpt"],
    strategy: "switch-to-backup",
    currentModelId: "kimi-code:k3",
    episodeTriedModelIds: [],
  });
  assert.deepEqual(decision, { kind: "advance", nextModelId: "codex-cli:gpt" });
});

// ---------------------------------------------------------------------------
// dispatchDegenerateReviewBackupAdvanceV1 (Part 5 step 15 production wiring)
//
// Review fix: the prior round's coverage of this behavior was a source-text
// assertion that the call expression existed inside `routeReviewOutcomeV1`,
// never a test that actually exercised the dispatch. `routeReviewOutcomeV1`
// itself is still a same-file local too entangled with the extension host to
// call directly, but the dispatch decision it delegates to
// (`dispatchDegenerateReviewBackupAdvanceV1`) is now extracted and exported
// specifically so it can be driven end-to-end with injected fakes instead of
// only inspected as text.
// ---------------------------------------------------------------------------

function fakeUri(fsPath: string): vscode.Uri {
  return vscode.Uri.file(fsPath);
}

void test("dispatchDegenerateReviewBackupAdvanceV1 records the backup and dispatches a fresh review when the workspace resolves", async () => {
  const calls: string[] = [];
  const folderUri = fakeUri("/ws/.ensemble/task_1");
  const workspaceUri = fakeUri("/ws");
  const extensionUri = fakeUri("/ext");
  const fakeWorkspaceFolder = { uri: workspaceUri, name: "ws", index: 0 } as vscode.WorkspaceFolder;

  const result = await dispatchDegenerateReviewBackupAdvanceV1(
    {
      folderUri,
      workspaceUri,
      extensionUri,
      targetStage: "impl-high-review",
      currentStage: "impl-high-review",
      nextModelId: "grok-4.6",
    },
    {
      recordActiveFallbackModel: (fUri, stage, modelId) => {
        calls.push(`record:${fUri.fsPath}:${stage}:${modelId}`);
        return Promise.resolve(true);
      },
      getWorkspaceFolder: (uri) => {
        calls.push(`getWorkspaceFolder:${uri.fsPath}`);
        return fakeWorkspaceFolder;
      },
      runReviewForFolder: (extUri, fUri, wsFolder, currentStage, _skip, options) => {
        calls.push(
          `run:${extUri.fsPath}:${fUri.fsPath}:${wsFolder.uri.fsPath}:${currentStage}:` +
            `preserveActiveFallback=${options?.preserveActiveFallback}`
        );
        return Promise.resolve();
      },
      showWarning: () => {
        calls.push("showWarning");
      },
    }
  );

  assert.deepEqual(result, { dispatched: true });
  assert.deepEqual(calls, [
    `record:${folderUri.fsPath}:impl-high-review:grok-4.6`,
    `getWorkspaceFolder:${workspaceUri.fsPath}`,
    `run:${extensionUri.fsPath}:${folderUri.fsPath}:${workspaceUri.fsPath}:impl-high-review:preserveActiveFallback=true`,
  ]);
});

void test("dispatchDegenerateReviewBackupAdvanceV1 falls back to a manual-retry warning when the workspace folder cannot be resolved", async () => {
  const calls: string[] = [];
  const folderUri = fakeUri("/ws/.ensemble/task_1");
  const workspaceUri = fakeUri("/ws");
  const extensionUri = fakeUri("/ext");

  const result = await dispatchDegenerateReviewBackupAdvanceV1(
    {
      folderUri,
      workspaceUri,
      extensionUri,
      targetStage: "impl-high-review",
      currentStage: "impl-high-review",
      nextModelId: "grok-4.6",
    },
    {
      recordActiveFallbackModel: (fUri, stage, modelId) => {
        calls.push(`record:${fUri.fsPath}:${stage}:${modelId}`);
        return Promise.resolve(true);
      },
      // The workspace folder lookup fails to resolve — the review's own
      // observed defect: the prior inline version silently did nothing here.
      getWorkspaceFolder: () => undefined,
      runReviewForFolder: () => {
        calls.push("run (must not happen)");
        return Promise.resolve();
      },
      showWarning: (message, _file, _target, _source, actionCommand) => {
        calls.push(`showWarning:${message}:${JSON.stringify(actionCommand)}`);
      },
    }
  );

  assert.deepEqual(result, { dispatched: false });
  assert.equal(calls.length, 2);
  assert.equal(calls[0], `record:${folderUri.fsPath}:impl-high-review:grok-4.6`);
  assert.ok(!calls.some((c) => c.startsWith("run")), "runReviewForFolder must not be called when no workspace folder resolves");
  assert.ok(calls[1]!.startsWith("showWarning:"), "a warning with a retry affordance must be shown instead of silently doing nothing");
  assert.ok(
    calls[1]!.includes("vs-code-ai-helper.retryReviewWithBackupV1"),
    "the warning must offer the same one-click retry command the manual/exhausted branches use"
  );
  assert.ok(calls[1]!.includes("\"modelId\":\"grok-4.6\""), "the retry action must target the backup that was selected");
});

// Sanity check that the production "advance" branch actually delegates to
// the now-tested dispatch function above, rather than re-inlining its own
// (untested) copy of the same logic.
void test("routeReviewOutcomeV1's 'advance' branch delegates to dispatchDegenerateReviewBackupAdvanceV1", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "..", "src", "commands", "reviewActions.ts"),
    "utf8"
  );
  const fnStart = source.indexOf("async function routeReviewOutcomeV1(");
  assert.ok(fnStart >= 0, "routeReviewOutcomeV1 not found");
  const nextFnStart = source.indexOf("\nasync function ", fnStart + 1);
  const fnBody = source.slice(fnStart, nextFnStart > 0 ? nextFnStart : undefined);

  const branchStart = fnBody.indexOf("degenerateBackupAdvance?.kind === \"advance\"");
  assert.ok(branchStart >= 0, "the 'advance' branch was not found inside routeReviewOutcomeV1");
  const branch = fnBody.slice(branchStart, branchStart + 400);

  assert.ok(
    branch.includes("dispatchDegenerateReviewBackupAdvanceV1("),
    "the advance branch must delegate to the tested dispatch function, not re-inline its own copy"
  );
});
