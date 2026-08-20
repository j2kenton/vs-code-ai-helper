/**
 * Stage-owner surfacing of an exhausted provider chain (plan Part 3,
 * 2026-08-13 finding 4): round 018 of "more workflow bugs" left a 60-byte
 * `Status: unavailable (providerModeUnavailable)` run file, no provider
 * named, task still `active` — indistinguishable from a round still
 * thinking. These tests pin the two halves of the fix at the stage-owner
 * layer:
 *
 *  - `pauseTaskForExhaustedChainV1`: the task is set `paused` with a
 *    `pausedReason` naming the stage and the exhausted chain, and
 *    `updatedAt` is bumped (the durable state now says WHY nothing runs);
 *  - `writeReviewRunLogV1`: the run record is enriched with the exhausted
 *    chain and per-candidate reasons instead of the bare status line;
 *  - `updateTaskStatus`/`pauseTaskWithReason`: the reason survives only
 *    while the task is paused — resuming retires it.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import {
  pauseTaskForExhaustedChainV1,
  writeReviewRunLogV1,
} from "../commands/reviewActions";
import {
  clearQuotaParkV1,
  pauseTaskWithReason,
  updateTaskStatus,
} from "../utils/taskProgressTransforms";
import { QuotaParkRecordV1 } from "../types/taskProgress";
import {
  initNotificationRouter,
  deactivateNotificationRouter,
} from "../utils/notificationRouter";
import { StatusTreeProvider } from "../views/statusView";
import { decodeTaskProgressTextV1 } from "../services/taskProgressDecoderV1";
import { TaskProgress } from "../types/taskProgress";
import { ProviderChainExhaustionV1 } from "../types/taskActionOutcomeV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-chain-exhaustion-"));

/** The round-018 configuration: three candidates, none acquirable. */
const EXHAUSTION: ProviderChainExhaustionV1 = {
  stage: "impl-high-review",
  candidates: [
    {
      storedModelId: "cline-cli:kimi-k3",
      providerLabel: "Cline CLI",
      runnerId: "cline-cli",
      reason: "the CLI is not installed",
    },
    {
      storedModelId: "kimi-cli:k3",
      providerLabel: "Kimi CLI",
      runnerId: "kimi-cli",
      reason: "authentication failure: not logged in",
    },
  ],
};

function makeTaskFolder(name: string): { folderPath: string; folderUri: vscode.Uri } {
  const folderPath = path.join(REAL_ROOT, "plans", name);
  fs.mkdirSync(folderPath, { recursive: true });
  const progress: TaskProgress = {
    taskFolder: name,
    currentStage: "impl-high-review",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
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
  return { folderPath, folderUri: vscode.Uri.file(folderPath) };
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
  target.rename = async (
    source: vscode.Uri,
    dest: vscode.Uri,
    _options?: { overwrite?: boolean }
  ): Promise<void> => {
    await fs.promises.rm(dest.fsPath, { force: true });
    await fs.promises.rename(source.fsPath, dest.fsPath);
  };
  target.delete = (uri: vscode.Uri): Promise<void> =>
    fs.promises.rm(uri.fsPath, { force: true, recursive: true });
  target.createDirectory = (uri: vscode.Uri): Promise<void> =>
    fs.promises.mkdir(uri.fsPath, { recursive: true }).then(() => undefined);
  target.readDirectory = async (uri: vscode.Uri): Promise<[string, number][]> => {
    const entries = await fs.promises.readdir(uri.fsPath, { withFileTypes: true });
    return entries.map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]);
  };
  target.stat = async (
    uri: vscode.Uri
  ): Promise<{ type: number; size: number; ctime: number; mtime: number }> => {
    const stat = await fs.promises.stat(uri.fsPath);
    return {
      type: stat.isDirectory() ? 2 : 1,
      size: stat.size,
      ctime: stat.ctimeMs,
      mtime: stat.mtimeMs,
    };
  };
  return {
    restore: (): void => {
      for (const key of [
        "readFile",
        "writeFile",
        "rename",
        "delete",
        "createDirectory",
        "readDirectory",
        "stat",
      ]) {
        target[key] = orig[key];
      }
    },
  };
}

function readProgress(folderPath: string): TaskProgress {
  const text = fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8");
  const decoded = decodeTaskProgressTextV1(text, {
    expectedTaskFolder: path.basename(folderPath),
  });
  assert.ok(
    decoded.ok,
    `persisted task-progress.json must strict-decode: ${decoded.ok ? "" : decoded.reason}`
  );
  return decoded.decoded.progress;
}

async function withHarness(run: () => Promise<void>): Promise<void> {
  const provider = new StatusTreeProvider();
  initNotificationRouter(provider);
  const fsBridge = installFsBridge();
  try {
    await run();
  } finally {
    fsBridge.restore();
    provider.dispose();
    deactivateNotificationRouter();
  }
}

function makeExtensionContext(): vscode.ExtensionContext {
  const backing = new Map<string, unknown>();
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

/** A chain exhausted because the primary candidate hit a quota block. */
const QUOTA_EXHAUSTION: ProviderChainExhaustionV1 = {
  stage: "impl-high-review",
  candidates: [
    {
      storedModelId: "claude-cli:sonnet",
      providerLabel: "Claude Code",
      runnerId: "claude-cli",
      reason: "You've hit your session limit · resets 12:10am (Asia/Jerusalem)",
    },
    {
      storedModelId: "kimi-cli:k3",
      providerLabel: "Kimi CLI",
      runnerId: "kimi-cli",
      reason: "authentication failure: not logged in",
    },
  ],
};

void describe("provider chain exhaustion (stage owner)", () => {
  void it("pauses the task with a reason naming the stage and exhausted chain, bumping updatedAt", async () => {
    const { folderPath, folderUri } = makeTaskFolder("exhausted_pause");
    await withHarness(async () => {
      await pauseTaskForExhaustedChainV1(folderUri, "impl-high-review", EXHAUSTION);
    });

    const persisted = readProgress(folderPath);
    assert.equal(persisted.status, "paused");
    assert.match(
      persisted.pausedReason ?? "",
      /No configured provider for impl-high-review is available/
    );
    assert.match(persisted.pausedReason ?? "", /Cline CLI → Kimi CLI/);
    assert.notEqual(
      persisted.updatedAt,
      "2026-01-01T00:00:00.000Z",
      "updatedAt must be bumped so the task stops presenting as freshly active"
    );
  });

  void it("records a durable quotaParkRecord when a candidate's reason was a quota block", async () => {
    const { folderPath, folderUri } = makeTaskFolder("exhausted_quota_park");
    await withHarness(async () => {
      await pauseTaskForExhaustedChainV1(folderUri, "impl-high-review", QUOTA_EXHAUSTION);
    });

    const persisted = readProgress(folderPath);
    assert.equal(persisted.status, "paused");
    assert.ok(persisted.quotaParkRecord, "expected a quotaParkRecord to be persisted");
    assert.equal(persisted.quotaParkRecord?.modelId, "claude-cli:sonnet");
    assert.equal(persisted.quotaParkRecord?.providerId, "claude-cli");
    assert.equal(persisted.quotaParkRecord?.failureKind, "quota");
    assert.ok(
      persisted.quotaParkRecord?.resetAt,
      "the 12:10am reset phrase should have parsed to a resetAt"
    );
  });

  void it("leaves quotaParkRecord unset when no candidate's reason was quota/entitlement-shaped", async () => {
    const { folderPath, folderUri } = makeTaskFolder("exhausted_no_quota_park");
    await withHarness(async () => {
      await pauseTaskForExhaustedChainV1(folderUri, "impl-high-review", EXHAUSTION);
    });

    const persisted = readProgress(folderPath);
    assert.equal(persisted.status, "paused");
    assert.equal(persisted.quotaParkRecord, undefined);
  });

  void it("posts a WorkflowDecisionV1 enumerating retry/adjust/stay with a 'no basis' recommendation when nothing is quota-shaped", async () => {
    const { folderUri } = makeTaskFolder("exhausted_decision_no_quota");
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      await withHarness(async () => {
        await pauseTaskForExhaustedChainV1(folderUri, "impl-high-review", EXHAUSTION);
      });
      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = store
        .listPending(folderUri.fsPath)
        .find((d) => d.decisionKey === "providerChainExhausted");
      assert.ok(decision, "a decision must be posted");
      const optionIds = decision.options.map((o) => o.optionId);
      assert.deepEqual(
        optionIds.sort(),
        ["adjustSettings", "retry", "stay"].sort(),
        "no quotaParkRecord means no 'wait' option should be offered"
      );
      for (const option of decision.options) {
        assert.ok(option.consequence.length > 0, `option "${option.optionId}" must state its consequence`);
      }
      assert.equal(
        decision.recommendation.kind,
        "none",
        "no quota/entitlement signal means the system has no basis to recommend one option over another"
      );
    } finally {
      __extensionContextV1TestOnly.reset();
    }
  });

  void it("posts a WorkflowDecisionV1 that recommends 'wait' when the quota reset is imminent", async () => {
    const { folderUri } = makeTaskFolder("exhausted_decision_quota_wait");
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    try {
      await withHarness(async () => {
        await pauseTaskForExhaustedChainV1(folderUri, "impl-high-review", QUOTA_EXHAUSTION);
      });
      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const decision = store
        .listPending(folderUri.fsPath)
        .find((d) => d.decisionKey === "providerChainExhausted");
      assert.ok(decision, "a decision must be posted");
      const optionIds = decision.options.map((o) => o.optionId);
      assert.deepEqual(
        optionIds.sort(),
        ["adjustSettings", "retry", "stay", "wait"].sort(),
        "a known near-term reset must add the 'wait' option to the base three"
      );
      assert.equal(decision.recommendation.kind, "option");
      if (decision.recommendation.kind === "option") {
        assert.equal(decision.recommendation.optionId, "wait");
        assert.ok(decision.recommendation.reasoning.length > 0);
      }
    } finally {
      __extensionContextV1TestOnly.reset();
    }
  });

  void it("writes an enriched run record naming the exhausted chain and per-candidate reasons", async () => {
    const { folderPath, folderUri } = makeTaskFolder("exhausted_runlog");
    await withHarness(async () => {
      await writeReviewRunLogV1(
        {
          kind: "unavailable",
          code: "providerModeUnavailable",
          chainExhaustion: EXHAUSTION,
        },
        {
          extensionUri: vscode.Uri.file(REAL_ROOT),
          folderUri,
          workspaceUri: vscode.Uri.file(REAL_ROOT),
          currentStage: "impl",
          targetStage: "impl-high-review",
          reviewUri: vscode.Uri.file(path.join(folderPath, "impl-high-review.md")),
          variables: {},
          reviewAttemptId: "attempt-1",
        }
      );
    });

    const runsDir = path.join(folderPath, "runs");
    const logs = fs
      .readdirSync(runsDir)
      .sort()
      .map((name) => fs.readFileSync(path.join(runsDir, name), "utf8"));
    assert.equal(logs.length, 1);
    // The bare 60-byte record is gone: the status line remains, but the
    // enrichment names the stage, every candidate, and every reason.
    assert.match(logs[0]!, /Status: unavailable \(providerModeUnavailable\)/);
    assert.match(logs[0]!, /## Provider chain exhausted/);
    assert.match(logs[0]!, /No provider could be acquired for impl-high-review/);
    assert.match(logs[0]!, /Cline CLI .*— the CLI is not installed/);
    assert.match(logs[0]!, /Kimi CLI .*— authentication failure: not logged in/);
  });

  void it("a bare unavailable outcome (no evidence) still writes the plain status line", async () => {
    const { folderPath, folderUri } = makeTaskFolder("exhausted_bare");
    await withHarness(async () => {
      await writeReviewRunLogV1(
        { kind: "unavailable", code: "providerModeUnavailable" },
        {
          extensionUri: vscode.Uri.file(REAL_ROOT),
          folderUri,
          workspaceUri: vscode.Uri.file(REAL_ROOT),
          currentStage: "impl",
          targetStage: "impl-high-review",
          reviewUri: vscode.Uri.file(path.join(folderPath, "impl-high-review.md")),
          variables: {},
          reviewAttemptId: "attempt-1",
        }
      );
    });
    const runsDir = path.join(folderPath, "runs");
    const logs = fs.readdirSync(runsDir).map((name) =>
      fs.readFileSync(path.join(runsDir, name), "utf8")
    );
    assert.equal(logs.length, 1);
    assert.doesNotMatch(logs[0]!, /## Provider chain exhausted/);
  });

  // workflow 3 continuation (third item): `candidatesExhausted` (every
  // candidate was reserved, invoked, and failed) is the opposite condition
  // from `providerModeUnavailable` (nothing was ever reserved) — the pause
  // reason and the run-record headline must say which actually happened.
  void it("pauses with 'tried and failed' wording for a candidatesExhausted code, never 'no provider available'", async () => {
    const { folderPath, folderUri } = makeTaskFolder("exhausted_pause_tried");
    await withHarness(async () => {
      await pauseTaskForExhaustedChainV1(folderUri, "impl-high-review", EXHAUSTION, "candidatesExhausted");
    });

    const persisted = readProgress(folderPath);
    assert.equal(persisted.status, "paused");
    assert.match(
      persisted.pausedReason ?? "",
      /Every configured model for impl-high-review was tried and failed/
    );
    assert.doesNotMatch(persisted.pausedReason ?? "", /No configured provider/);
  });

  // Item 5 (2026-08-17..19 workflow-defects batch): a monthly/hard
  // billing-limit block (Copilot's "monthly credit limit", a devpass
  // premium-tier weekly ceiling) previously folded into the same generic
  // "tried and failed" sentence as an ordinary transport/code fault, costing
  // real spend across several rounds before the actual cause was legible.
  // When a candidate's reason classifies as quota/entitlement, the pause
  // reason must name that plainly instead of the generic wording.
  void it("names the quota/credit-limit block plainly instead of the generic 'tried and failed' wording", async () => {
    const { folderPath, folderUri } = makeTaskFolder("exhausted_pause_quota_named");
    await withHarness(async () => {
      await pauseTaskForExhaustedChainV1(folderUri, "impl-high-review", QUOTA_EXHAUSTION, "candidatesExhausted");
    });

    const persisted = readProgress(folderPath);
    assert.equal(persisted.status, "paused");
    assert.match(
      persisted.pausedReason ?? "",
      /blocked by a quota\/credit-limit restriction on Claude Code/
    );
    assert.doesNotMatch(
      persisted.pausedReason ?? "",
      /Every configured model for impl-high-review was tried and failed/
    );
  });

  void it("pauses with the legacy 'no provider available' wording when no code is passed (back-compat)", async () => {
    const { folderPath, folderUri } = makeTaskFolder("exhausted_pause_default");
    await withHarness(async () => {
      await pauseTaskForExhaustedChainV1(folderUri, "impl-high-review", EXHAUSTION);
    });

    const persisted = readProgress(folderPath);
    assert.equal(persisted.status, "paused");
    assert.match(
      persisted.pausedReason ?? "",
      /No configured provider for impl-high-review is available/
    );
  });

  void it("writes an enriched run record with 'tried and failed' wording for candidatesExhausted", async () => {
    const { folderPath, folderUri } = makeTaskFolder("exhausted_runlog_tried");
    await withHarness(async () => {
      await writeReviewRunLogV1(
        {
          kind: "unavailable",
          code: "candidatesExhausted",
          chainExhaustion: EXHAUSTION,
        },
        {
          extensionUri: vscode.Uri.file(REAL_ROOT),
          folderUri,
          workspaceUri: vscode.Uri.file(REAL_ROOT),
          currentStage: "impl",
          targetStage: "impl-high-review",
          reviewUri: vscode.Uri.file(path.join(folderPath, "impl-high-review.md")),
          variables: {},
          reviewAttemptId: "attempt-1",
        }
      );
    });

    const runsDir = path.join(folderPath, "runs");
    const logs = fs
      .readdirSync(runsDir)
      .sort()
      .map((name) => fs.readFileSync(path.join(runsDir, name), "utf8"));
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /Status: unavailable \(candidatesExhausted\)/);
    assert.match(logs[0]!, /## Provider chain exhausted/);
    assert.match(logs[0]!, /Every configured model was tried and failed for impl-high-review/);
    assert.doesNotMatch(logs[0]!, /No provider could be acquired/);
  });
});

void describe("pausedReason lifecycle (transforms)", () => {
  const BASE: TaskProgress = {
    taskFolder: "t",
    currentStage: "impl-high-review",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  void it("pauseTaskWithReason sets paused + reason and bumps updatedAt", () => {
    const paused = pauseTaskWithReason(BASE, "no configured provider for impl-high-review is available");
    assert.equal(paused.status, "paused");
    assert.equal(
      paused.pausedReason,
      "no configured provider for impl-high-review is available"
    );
    assert.notEqual(paused.updatedAt, BASE.updatedAt);
  });

  void it("resuming (any non-paused status) retires the reason", () => {
    const paused = pauseTaskWithReason(BASE, "reason");
    const resumed = updateTaskStatus(paused, "active");
    assert.equal(resumed.status, "active");
    assert.equal(resumed.pausedReason, undefined);
  });

  void it("a user pause without a reason leaves pausedReason absent", () => {
    const paused = updateTaskStatus(BASE, "paused");
    assert.equal(paused.pausedReason, undefined);
  });

  const PARK_RECORD: QuotaParkRecordV1 = {
    modelId: "claude-cli:sonnet",
    providerId: "claude-cli",
    failureKind: "quota",
    observedAt: "2026-01-01T00:00:00.000Z",
  };

  void it(
    "review completion blocker: resuming a quota-parked task (paused -> active) does NOT clear quotaParkRecord — resume is not fresh evidence the block resolved",
    () => {
      const paused = pauseTaskWithReason(BASE, "quota exhausted", PARK_RECORD);
      const resumed = updateTaskStatus(paused, "active");
      assert.equal(resumed.status, "active");
      assert.deepEqual(resumed.quotaParkRecord, PARK_RECORD);
    }
  );

  void it(
    "a later, unrelated pause with no record of its own clears a stale quotaParkRecord from an earlier pause",
    () => {
      const paused = pauseTaskWithReason(BASE, "quota exhausted", PARK_RECORD);
      const resumed = updateTaskStatus(paused, "active");
      const repaused = pauseTaskWithReason(resumed, "unrelated: no provider available");
      assert.equal(repaused.quotaParkRecord, undefined);
    }
  );

  void it("clearQuotaParkV1 is the only mechanism that retires a record while the task stays active", () => {
    const paused = pauseTaskWithReason(BASE, "quota exhausted", PARK_RECORD);
    const resumed = updateTaskStatus(paused, "active");
    assert.deepEqual(resumed.quotaParkRecord, PARK_RECORD);
    const cleared = clearQuotaParkV1(resumed);
    assert.equal(cleared.quotaParkRecord, undefined);
  });

  void it(
    "review completion blocker: clearQuotaParkV1 leaves a record in place when the given identity's model/provider does not match it",
    () => {
      const paused = pauseTaskWithReason(BASE, "quota exhausted", PARK_RECORD);
      const resumed = updateTaskStatus(paused, "active");
      const untouched = clearQuotaParkV1(resumed, {
        providerId: "codex-cli",
        modelId: "codex-cli:gpt-5.6-sol",
      });
      assert.deepEqual(untouched.quotaParkRecord, PARK_RECORD);
    }
  );

  void it("clearQuotaParkV1 clears when the given identity's provider and model match the record", () => {
    const paused = pauseTaskWithReason(BASE, "quota exhausted", PARK_RECORD);
    const resumed = updateTaskStatus(paused, "active");
    const cleared = clearQuotaParkV1(resumed, {
      providerId: PARK_RECORD.providerId,
      modelId: PARK_RECORD.modelId,
    });
    assert.equal(cleared.quotaParkRecord, undefined);
  });

  void it(
    "clearQuotaParkV1 leaves a record in place when accountKey is known on both sides and differs",
    () => {
      const recordWithAccount: QuotaParkRecordV1 = { ...PARK_RECORD, accountKey: "account-a" };
      const paused = pauseTaskWithReason(BASE, "quota exhausted", recordWithAccount);
      const resumed = updateTaskStatus(paused, "active");
      const untouched = clearQuotaParkV1(resumed, {
        providerId: recordWithAccount.providerId,
        modelId: recordWithAccount.modelId,
        accountKey: "account-b",
      });
      assert.deepEqual(untouched.quotaParkRecord, recordWithAccount);
    }
  );
});
