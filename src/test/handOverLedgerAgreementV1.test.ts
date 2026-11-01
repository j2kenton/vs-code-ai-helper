import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";
import {
  describeDeclinedHandOverV1,
  scheduleAutomaticImplementationAfterReview,
  warnHandOverNotStartedV1,
  type HandOverNotStartedCauseV1,
} from "../commands/reviewActions";
import { buildImplementationTypeCheckFailedDecisionInputV1 } from "../utils/implementationTypeCheckHandOffV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import type { RoundLedgerEntryV1, TaskProgress, TaskStage } from "../types/taskProgress";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import {
  describeHandOverRoundFindingV1,
  findHandOverRoundFindingV1,
  findPendingDecisionForRoundV1,
} from "../utils/handOverLedgerAgreementV1";
import type { WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import { describeImplementationNoFollowUpGateV1 } from "../utils/roundLedgerV1";
import { resetAutomationChainGuards } from "../utils/automationChain";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import { recordStageActionRefusalReasonV1, takeStageActionRefusalReasonV1 } from "../utils/stageActionRefusalV1";
import { fixtureOwnershipFor } from "./taskFolderFixture";
import { safeRemoveDir } from "./testFsUtils";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-handover-ledger-"));
after(() => safeRemoveDir(ROOT));

const NOW = Date.parse("2026-10-28T13:45:12.000Z");
const STARTED = "2026-10-28T13:23:54.000Z";
const ENDED = "2026-10-28T13:45:10.000Z";

function implRow(extra: Partial<RoundLedgerEntryV1> = {}): RoundLedgerEntryV1 {
  return {
    roundId: "round-impl-1",
    attemptIds: [],
    stage: "impl",
    mode: "implementation",
    startedAt: STARTED,
    state: "completed",
    endedAt: ENDED,
    outcome: { filesChanged: Array.from({ length: 23 }, (_, i) => `src/f${i}.ts`) },
    ...extra,
  };
}

function progressWith(
  rows: RoundLedgerEntryV1[],
  extra: Partial<TaskProgress> = {},
  dir = "unused"
): TaskProgress {
  return {
    taskFolder: path.basename(dir),
    currentStage: "impl" as TaskStage,
    status: "active",
    nextActor: "human",
    createdAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-28T13:45:10.000Z",
    ownership: fixtureOwnershipFor(dir),
    roundLedger: rows,
    ...extra,
  } as TaskProgress;
}

const TYPE_CHECK_FAILURE = { at: "2026-10-28T13:45:09.000Z", output: "erase-account.integration.test.ts(51,18): error TS2352" };

function makeMemento(): vscode.Memento {
  const backing = new Map<string, unknown>();
  return {
    keys: (): readonly string[] => [...backing.keys()],
    get: <T>(key: string, defaultValue?: T): T | undefined => backing.has(key) ? backing.get(key) as T : defaultValue,
    update: (key: string, value: unknown): Thenable<void> => {
      if (value === undefined) {
        backing.delete(key);
      } else {
        backing.set(key, value);
      }
      return Promise.resolve();
    },
  } as vscode.Memento;
}

void describe("findPendingDecisionForRoundV1 (bugs4 item 4: one event, one decision)", () => {
  const decision = (extra: Record<string, unknown>): WorkflowDecisionV1 =>
    ({
      decisionId: "d1",
      decisionKey: "k",
      taskCanonicalId: "t",
      stage: "impl",
      state: "pending",
      createdAt: "2026-10-28T13:45:11.000Z",
      ...extra,
    }) as unknown as WorkflowDecisionV1;

  void it("matches a decision that names the round, or one raised at the same stage since the round started", () => {
    const row = implRow();
    assert.ok(findPendingDecisionForRoundV1([decision({ stage: "plan", liveReference: { kind: "implementation-operation", roundId: row.roundId }, createdAt: "2026-10-01T00:00:00.000Z" })], row));
    assert.ok(findPendingDecisionForRoundV1([decision({})], row));
  });

  void it("ignores a decision from before the round, at another stage, or already resolved", () => {
    const row = implRow();
    assert.equal(findPendingDecisionForRoundV1([decision({ createdAt: "2026-10-28T12:00:00.000Z" })], row), undefined);
    assert.equal(findPendingDecisionForRoundV1([decision({ stage: "publish" })], row), undefined);
    assert.equal(findPendingDecisionForRoundV1([decision({ state: "resolved" })], row), undefined);
  });
});

void describe("findHandOverRoundFindingV1 / describeImplementationNoFollowUpGateV1 (bugs4 item 4)", () => {
  void it("a completed impl round with a type-check failure inside it is a gated round, with the gate's own sentence", () => {
    const progress = progressWith([implRow()], { implementationTypeCheckFailure: TYPE_CHECK_FAILURE });
    const finding = findHandOverRoundFindingV1(progress, "impl", { now: NOW });
    assert.equal(finding?.kind, "gated");
    assert.equal(finding?.kind === "gated" ? finding.gate.kind : undefined, "type-check");
    assert.ok(finding);
    const text = describeHandOverRoundFindingV1(finding);
    assert.match(text, /completed/);
    assert.match(text, /23 file\(s\) changed/);
    assert.match(text, /fix the type-check errors before review can continue/);
    assert.doesNotMatch(text, /did not start|never started|refusal reason/);
  });

  void it("the round's Ended line and the hand-over read the same gate descriptor", () => {
    const progress = progressWith([implRow()], { implementationTypeCheckFailure: TYPE_CHECK_FAILURE });
    const gate = describeImplementationNoFollowUpGateV1(implRow(), progress);
    assert.equal(gate?.sentence, "No follow-up was scheduled; fix the type-check errors before review can continue.");
  });

  void it("a completed impl round with no type-check failure is handed back, not 'declined'", () => {
    const finding = findHandOverRoundFindingV1(progressWith([implRow()]), "impl", { now: NOW });
    assert.equal(finding?.kind === "gated" ? finding.gate.kind : undefined, "handed-back");
  });

  void it("a completed round whose follow-up IS scheduled (a live row exists) is not gated", () => {
    const live = implRow({ roundId: "next", stage: "impl-high-review", mode: "review" as RoundLedgerEntryV1["mode"], state: "scheduled", endedAt: undefined });
    const finding = findHandOverRoundFindingV1(progressWith([implRow(), live]), "impl", { now: NOW });
    assert.equal(finding?.kind, "terminal-round");
  });

  void it("nothing at the stage, a live round, another stage's round, or a round older than the window is a genuine non-start", () => {
    assert.equal(findHandOverRoundFindingV1(progressWith([]), "impl", { now: NOW }), undefined);
    assert.equal(findHandOverRoundFindingV1(undefined, "impl", { now: NOW }), undefined);
    assert.equal(
      findHandOverRoundFindingV1(progressWith([implRow({ state: "open", endedAt: undefined })]), "impl", { now: NOW }),
      undefined,
      "a live round is not a terminal one"
    );
    assert.equal(findHandOverRoundFindingV1(progressWith([implRow({ stage: "plan" })]), "impl", { now: NOW }), undefined);
    assert.equal(
      findHandOverRoundFindingV1(progressWith([implRow()]), "impl", { now: NOW + 10 * 60 * 1000 }),
      undefined,
      "a round that ended long before is a previous event"
    );
  });

  void it("`since` bounds the lookup to the chain: a round that ended before the chain's root began is not evidence about this hand-over", () => {
    const progress = progressWith([implRow()]);
    const beforeChain = "2026-10-28T13:45:11.000Z";
    const insideChain = "2026-10-28T13:30:00.000Z";
    assert.equal(findHandOverRoundFindingV1(progress, "impl", { now: NOW, since: beforeChain }), undefined);
    assert.ok(findHandOverRoundFindingV1(progress, "impl", { now: NOW, since: insideChain }));
  });

  void it("a failed round is reported as ended failed, not as a round that never started", () => {
    const finding = findHandOverRoundFindingV1(progressWith([implRow({ state: "failed", outcome: undefined })]), "impl", { now: NOW });
    assert.equal(finding?.kind, "terminal-round");
    assert.ok(finding);
    assert.match(describeHandOverRoundFindingV1(finding), /ended failed/);
  });
});

void describe("warnHandOverNotStartedV1 agrees with the ledger (bugs4 item 4)", () => {
  async function withTask<T>(
    progressFor: (dir: string) => TaskProgress,
    body: (dir: string, memento: vscode.Memento) => Promise<T>
  ): Promise<T> {
    const dir = fs.mkdtempSync(path.join(ROOT, "task-"));
    fs.writeFileSync(path.join(dir, "task-progress.json"), JSON.stringify(progressFor(dir)), "utf8");
    const memento = makeMemento();
    __extensionContextV1TestOnly.set({
      subscriptions: [],
      extensionUri: vscode.Uri.file(ROOT),
      workspaceState: memento,
      globalState: memento,
    } as unknown as vscode.ExtensionContext);
    initNotificationRouter({ addEntry: () => undefined });
    const fsBridge = vscode.workspace.fs as unknown as { readFile: (uri: vscode.Uri) => Promise<Uint8Array> };
    const previousReadFile = fsBridge.readFile;
    fsBridge.readFile = (uri): Promise<Uint8Array> => fs.promises.readFile(uri.fsPath).then((b) => new Uint8Array(b));
    try {
      return await body(dir, memento);
    } finally {
      fsBridge.readFile = previousReadFile;
      deactivateNotificationRouter();
      __extensionContextV1TestOnly.reset();
    }
  }

  void it("a completed impl round that ends with a failing type-check raises exactly one decision: the type-check one, which recommends the fix and never says the round did not start", async () => {
    const end = new Date().toISOString();
    const start = new Date(Date.now() - 22 * 60 * 1000).toISOString();
    await withTask(
      (dir) =>
        progressWith(
          [implRow({ startedAt: start, endedAt: end })],
          { implementationTypeCheckFailure: { at: new Date(Date.now() - 1000).toISOString(), output: TYPE_CHECK_FAILURE.output } },
          dir
        ),
      async (dir, memento) => {
        // The hand-over posts the gate's own keyed decision (idempotent when the
        // gate already raised it), so repeated or racing deliveries stay one card.
        await warnHandOverNotStartedV1(vscode.Uri.file(dir), "main task for erase work", "impl", "declined", "implementation");
        await warnHandOverNotStartedV1(vscode.Uri.file(dir), "main task for erase work", "impl", "declined", "implementation");
        const pending = new WorkflowDecisionStoreV1(memento).listPending(dir);
        assert.equal(pending.length, 1, `one event, one decision; got ${JSON.stringify(pending.map((d) => d.decisionKey))}`);
        const decision = pending[0]!;
        assert.equal(decision.decisionKey, "implementationTypeCheckFailed");
        assert.match(decision.whatHappened, /type-check/);
        assert.equal(decision.recommendation.kind === "option" ? decision.recommendation.optionId : undefined, "fixBuildManually");
        assert.ok(decision.options.some((o) => o.optionId === "runImplementationFix"), "Run Implementation stays available");
        for (const d of pending) {
          assert.doesNotMatch(d.whatHappened, /did not start|never started|refusal reason/);
        }
      }
    );
  });

  void it("a completed impl round with no gate and no queued follow-up reports what the round did and does not recommend rerunning it", async () => {
    const end = new Date().toISOString();
    await withTask(
      (dir) => progressWith([implRow({ startedAt: new Date(Date.now() - 60_000).toISOString(), endedAt: end })], {}, dir),
      async (dir, memento) => {
        await warnHandOverNotStartedV1(vscode.Uri.file(dir), "t", "impl", "declined", "implementation");
        const pending = new WorkflowDecisionStoreV1(memento).listPending(dir);
        const card = pending.find((d) => d.decisionKey === "chatActionOffer:runImplementationWithAI");
        assert.ok(card);
        assert.match(card.whatHappened, /Implementation ended completed — 23 file\(s\) changed/);
        assert.doesNotMatch(card.whatHappened, /did not start|refusal reason/);
        assert.equal(card.recommendation.kind, "none", "re-running a round that already completed is not recommended");
        assert.ok(card.options.some((o) => o.optionId === "notNow"));
      }
    );
  });

  const GENUINE: readonly { cause: HandOverNotStartedCauseV1; match: RegExp }[] = [
    { cause: "duplicate-chain", match: /another automatic follow-up is already pending/ },
    { cause: "automation-disabled", match: /automation was turned off/ },
    { cause: "root-operation-unsuccessful", match: /did not finish successfully/ },
    { cause: "declined", match: /Run Implementation command returned without starting a round and recorded no cause/ },
    { cause: "gated-no-follow-up", match: /a check deliberately held the follow-up back/ },
  ];
  for (const { cause, match } of GENUINE) {
    void it(`genuine non-start, cause ${cause}: the warning still appears with a concrete reason and keeps Run Implementation`, async () => {
      await withTask(
        (dir) => progressWith([], {}, dir),
        async (dir, memento) => {
          await warnHandOverNotStartedV1(vscode.Uri.file(dir), "t", "impl", cause, "implementation");
          const card = new WorkflowDecisionStoreV1(memento)
            .listPending(dir)
            .find((d) => d.decisionKey === "chatActionOffer:runImplementationWithAI");
          assert.ok(card, "the warning card is posted");
          assert.match(card.whatHappened, match);
          assert.doesNotMatch(card.whatHappened, /did not provide its refusal reason/);
          assert.equal(card.options.find((o) => o.optionId === "runAction")?.label, "Run Implementation");
          assert.equal(card.options.find((o) => o.optionId === "notNow")?.effect.kind, "doNothing");
        }
      );
    });
  }

  void it("a round from before the chain began does not hide a genuine drop: the cause is reported as a non-start", async () => {
    const ended = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    await withTask(
      (dir) => progressWith([implRow({ startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), endedAt: ended })], {}, dir),
      async (dir, memento) => {
        await warnHandOverNotStartedV1(vscode.Uri.file(dir), "t", "impl", "duplicate-chain", "implementation", {
          since: new Date().toISOString(),
        });
        const card = new WorkflowDecisionStoreV1(memento)
          .listPending(dir)
          .find((d) => d.decisionKey === "chatActionOffer:runImplementationWithAI");
        assert.ok(card);
        assert.match(card.whatHappened, /did not start because another automatic follow-up is already pending/);
        assert.equal(card.options.find((o) => o.optionId === "runAction")?.label, "Run Implementation");
      }
    );
  });

  void it("an in-chain terminal round that did not hand over keeps the genuine cause alongside what the round did", async () => {
    const ended = new Date(Date.now() - 1000).toISOString();
    await withTask(
      (dir) => progressWith([implRow({ state: "failed", outcome: undefined, startedAt: new Date(Date.now() - 60_000).toISOString(), endedAt: ended })], {}, dir),
      async (dir, memento) => {
        await warnHandOverNotStartedV1(vscode.Uri.file(dir), "t", "impl", "automation-disabled", "implementation", {
          since: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        });
        const card = new WorkflowDecisionStoreV1(memento)
          .listPending(dir)
          .find((d) => d.decisionKey === "chatActionOffer:runImplementationWithAI");
        assert.ok(card);
        assert.match(card.whatHappened, /ended failed/);
        assert.match(card.whatHappened, /did not start because automation was turned off/);
      }
    );
  });

  void it("a declined hand-over carries the downstream command's stated refusal reason", async () => {
    await withTask(
      (dir) => progressWith([], {}, dir),
      async (dir, memento) => {
        recordStageActionRefusalReasonV1(dir, "Implementation is already in progress for this task");
        try {
          await warnHandOverNotStartedV1(vscode.Uri.file(dir), "t", "impl", "declined", "implementation");
        } finally {
          takeStageActionRefusalReasonV1(dir);
        }
        const card = new WorkflowDecisionStoreV1(memento)
          .listPending(dir)
          .find((d) => d.decisionKey === "chatActionOffer:runImplementationWithAI");
        assert.match(card?.whatHappened ?? "", /refused to start: Implementation is already in progress for this task/);
      }
    );
  });

  void it("defers to a decision the round's own ending already raised: no second, contradicting card", async () => {
    const end = new Date().toISOString();
    const start = new Date(Date.now() - 60_000).toISOString();
    await withTask(
      (dir) => progressWith([implRow({ startedAt: start, endedAt: end })], {}, dir),
      async (dir, memento) => {
        const store = new WorkflowDecisionStoreV1(memento);
        const posted = await store.post({
          ...buildImplementationTypeCheckFailedDecisionInputV1({
            taskCanonicalId: dir,
            taskFolderPath: dir,
            stage: "impl",
            errors: "error TS2352",
            logFilePath: path.join(dir, "runs", "001.md"),
          }),
          decisionId: "gate-decision-1",
          createdAt: new Date().toISOString(),
        });
        assert.ok(posted.ok);
        await warnHandOverNotStartedV1(vscode.Uri.file(dir), "t", "impl", "declined", "implementation");
        const pending = store.listPending(dir);
        assert.deepEqual(
          pending.map((d) => d.decisionKey),
          ["implementationTypeCheckFailed"],
          "the hand-over posted nothing beside the existing decision"
        );
      }
    );
  });

  void it("a declined hand-over carries the downstream command's typed refusal: its cause, reason and recovery", async () => {
    await withTask(
      (dir) => progressWith([], {}, dir),
      async (dir, memento) => {
        recordStageActionRefusalReasonV1(dir, "High-Level Code Review was not run", {
          kind: "not-run",
          cause: "ledger-unproven",
          reason: "no changed files are tracked for this task",
          recovery: { label: "Run Implementation", detail: "Run an Implementation round." },
        });
        try {
          await warnHandOverNotStartedV1(vscode.Uri.file(dir), "t", "impl-high-review", "declined", "review");
        } finally {
          takeStageActionRefusalReasonV1(dir);
        }
        const text =
          new WorkflowDecisionStoreV1(memento)
            .listPending(dir)
            .find((d) => d.decisionKey === "chatActionOffer:runReviewWithAI")?.whatHappened ?? "";
        assert.match(text, /did not run \(ledger-unproven\): no changed files are tracked for this task; to recover: Run Implementation/);
        assert.doesNotMatch(text, /refusal reason/);
      }
    );
  });

  void it("with no reason at all a declined hand-over names the command and what is known, never 'did not provide its refusal reason'", () => {
    const text = describeDeclinedHandOverV1("implementation", undefined);
    assert.match(text, /Run Implementation command returned without starting a round and recorded no cause/);
    assert.doesNotMatch(text, /did not provide its refusal reason/);
  });

  void it("the manual step names the stage once: an Implementation hand-over at the Implementation stage never reads 'Run Implementation on Implementation'", async () => {
    await withTask(
      (dir) => progressWith([], {}, dir),
      async (dir, memento) => {
        await warnHandOverNotStartedV1(vscode.Uri.file(dir), "t", "impl", "automation-disabled", "implementation");
        const text =
          new WorkflowDecisionStoreV1(memento)
            .listPending(dir)
            .find((d) => d.decisionKey === "chatActionOffer:runImplementationWithAI")?.whatHappened ?? "";
        assert.match(text, /Run Implementation\.$/);
        assert.doesNotMatch(text, /Implementation on Implementation/);
        assert.equal(text.match(/Run Implementation/g)?.length, 1);
      }
    );
  });
});

void describe("scheduled follow-up raises no hand-over warning (bugs4 item 4 control, call site)", () => {
  void it("a completed impl round whose queued follow-up starts never reaches warnHandOverNotStartedV1: no decision, no notice", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const settingsModule = require("../config/settings") as Record<string, unknown>;
    const commandsObj = vscode.commands as unknown as {
      _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
    };
    const originalOverride = commandsObj._executeCommandOverride;
    const originalEnabled = settingsModule.isAutoImplementAfterReviewEnabled;
    const dir = fs.mkdtempSync(path.join(ROOT, "task-sched-"));
    const end = new Date().toISOString();
    const start = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(
      path.join(dir, "task-progress.json"),
      JSON.stringify(progressWith([implRow({ startedAt: start, endedAt: end })], {}, dir)),
      "utf8"
    );
    const memento = makeMemento();
    __extensionContextV1TestOnly.set({
      subscriptions: [],
      extensionUri: vscode.Uri.file(ROOT),
      workspaceState: memento,
      globalState: memento,
    } as unknown as vscode.ExtensionContext);
    const notices: unknown[] = [];
    initNotificationRouter({ addEntry: (entry: unknown) => { notices.push(entry); } } as never);
    const dispatched: string[] = [];
    commandsObj._executeCommandOverride = (id: string): Promise<unknown> => {
      dispatched.push(id);
      return Promise.resolve(true);
    };
    settingsModule.isAutoImplementAfterReviewEnabled = (): boolean => true;
    try {
      const fired: string[] = [];
      const scheduled = scheduleAutomaticImplementationAfterReview("impl", true, dir, undefined, {
        onDropped: (reason) => {
          fired.push(`dropped:${reason}`);
          void warnHandOverNotStartedV1(vscode.Uri.file(dir), "t", "impl", reason, "implementation");
        },
        onDeclined: () => {
          fired.push("declined");
          void warnHandOverNotStartedV1(vscode.Uri.file(dir), "t", "impl", "declined", "implementation");
        },
      });
      assert.equal(scheduled, true);
      for (let i = 0; i < 20; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(dispatched.filter((id) => id === "vs-code-ai-helper.runImplementationWithAI").length, 1);
      assert.deepEqual(fired, [], "neither the drop nor the decline callback fired");
      assert.deepEqual(new WorkflowDecisionStoreV1(memento).listPending(dir), [], "no hand-over card was raised");
      assert.equal(notices.length, 0, "no hand-over notice was raised");
    } finally {
      commandsObj._executeCommandOverride = originalOverride;
      settingsModule.isAutoImplementAfterReviewEnabled = originalEnabled;
      resetAutomationChainGuards();
      deactivateNotificationRouter();
      __extensionContextV1TestOnly.reset();
    }
  });
});
