import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { afterEach, describe, it } from "node:test";
import {
  buildRoundGitInterferenceDecisionV1,
  offerRoundGitInterferenceDecisionV1,
  OPEN_ROUND_GIT_EVIDENCE_COMMAND_V1,
  roundGitObservationEvidencePathV1,
} from "../utils/roundGitInterferenceDecisionV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { makeOwnedTaskFolder } from "./taskFolderFixture";
import { openRoundGitObservationEvidenceV1 } from "../commands/roundGitInterferenceV1";

function makeExtensionContext(): vscode.ExtensionContext {
  const backing = new Map<string, unknown>();
  const memento = {
    keys: (): readonly string[] => [...backing.keys()],
    get: <T>(key: string, defaultValue?: T): T | undefined => backing.has(key) ? backing.get(key) as T : defaultValue,
    update: (key: string, value: unknown): Thenable<void> => {
      if (value === undefined) backing.delete(key); else backing.set(key, value);
      return Promise.resolve();
    },
  };
  return { subscriptions: [], extensionUri: vscode.Uri.file("/tasks"), workspaceState: memento, globalState: memento } as unknown as vscode.ExtensionContext;
}

function installRealFs(): { restore: () => void } {
  const workspaceFs = vscode.workspace.fs as unknown as Record<string, unknown>;
  const originalReadFile = workspaceFs.readFile;
  workspaceFs.readFile = (uri: vscode.Uri): Promise<Uint8Array> => Promise.resolve(new Uint8Array(fs.readFileSync(uri.fsPath)));
  return { restore: (): void => { workspaceFs.readFile = originalReadFile; } };
}

afterEach(() => __extensionContextV1TestOnly.reset());

void describe("round Git interference chat recovery decision", () => {
  void it("states the observed reason and offers exact, ordered recovery choices", () => {
    const decision = buildRoundGitInterferenceDecisionV1("/tasks/task-a", {
      unmergedPaths: ["src/a.ts", "src/b.ts"],
      stashOperationIds: ["op-7"],
    });

    assert.match(decision.whatHappened, /unmerged paths: src\/a\.ts, src\/b\.ts/);
    assert.match(decision.whatHappened, /observations do not establish who caused a change/);
    assert.match(decision.whatHappened, /attribution is unknown/);
    assert.equal(decision.recommendation.kind, "option");
    assert.equal(decision.recommendation.optionId, "keepWorkingTree1");
    assert.deepEqual(decision.options.map((option) => option.label), [
      "Keep working-tree version: src/a.ts",
      "Keep working-tree version: src/b.ts",
      "View Git observation evidence: op-7",
      "Acknowledge stash change: op-7",
      "Not now",
    ]);
    const first = decision.options[0];
    const viewEvidence = decision.options[2];
    const stash = decision.options[3];
    const notNow = decision.options[4];
    assert.ok(first);
    assert.ok(viewEvidence);
    assert.ok(stash);
    assert.ok(notNow);
    assert.deepEqual(first.effect, {
      kind: "command",
      command: "vs-code-ai-helper.resolveRoundGitInterference",
      args: ["/tasks/task-a", { kind: "keepWorkingTree", relativePath: "src/a.ts" }],
    });
    assert.match(first.consequence, /Stages only src\/a\.ts/);
    assert.deepEqual(viewEvidence.effect, {
      kind: "command",
      command: OPEN_ROUND_GIT_EVIDENCE_COMMAND_V1,
      args: ["/tasks/task-a", "op-7"],
    });
    assert.match(viewEvidence.consequence, /Opens the task-bound before\/after Git observation/);
    assert.match(stash.consequence, /will not pop, apply, or drop a stash/);
    assert.deepEqual(notNow.effect, { kind: "doNothing" });
  });

  void it("recommends opening task-bound stash evidence before acknowledgement", () => {
    const decision = buildRoundGitInterferenceDecisionV1("/tasks/task-a", {
      unmergedPaths: [],
      stashOperationIds: ["op-9"],
      stashObservations: [{
        operationId: "op-9",
        attribution: "observed-unattributed",
        observedFrom: "2026-01-01T00:00:00.000Z",
        observedUntil: "2026-01-01T00:01:00.000Z",
        added: [{ objectId: "abcdef1234567890", selector: "stash@{0}", subject: "saved work" }],
        removed: [],
      }],
    });

    assert.equal(decision.recommendation.kind, "option");
    assert.equal(decision.recommendation.optionId, "viewStashEvidence1");
    assert.match(decision.recommendation.reasoning, /cause is unknown/);
    assert.equal(decision.options[0]?.label, "View Git observation evidence: op-9");
    assert.equal(decision.options[1]?.label, "Acknowledge stash change: op-9");
    assert.match(decision.whatHappened, /stash@\{0\} \(abcdef123456\): saved work/);
    assert.match(decision.whatHappened, /observed from 2026-01-01T00:00:00.000Z/);
    assert.deepEqual(decision.options[0]?.effect, {
      kind: "command",
      command: OPEN_ROUND_GIT_EVIDENCE_COMMAND_V1,
      args: ["/tasks/task-a", "op-9"],
    });
  });

  void it("resolves only safe operation IDs to task-owned evidence files", () => {
    assert.equal(roundGitObservationEvidencePathV1("/tasks/task-a", "op_9-1"), "/tasks/task-a/round-git-state-v1/op_9-1.json");
    assert.throws(() => roundGitObservationEvidencePathV1("/tasks/task-a", "../other"), /identifier is invalid/);
  });

  void it("opens only a task-matching observation record from the evidence action", async () => {
    const readPaths: string[] = [];
    const openedPaths: string[] = [];
    const opened = await openRoundGitObservationEvidenceV1({
      taskFolderPath: "/tasks/task-a",
      operationId: "op-9",
      readText: (evidencePath) => {
        readPaths.push(evidencePath);
        return Promise.resolve(JSON.stringify({ taskFolderPath: "/tasks/task-a", operationId: "op-9", delta: { attribution: "observed-unattributed" } }));
      },
      open: (evidencePath) => { openedPaths.push(evidencePath); return Promise.resolve(); },
    });
    assert.equal(opened, "/tasks/task-a/round-git-state-v1/op-9.json");
    assert.deepEqual(readPaths, [opened]);
    assert.deepEqual(openedPaths, [opened]);
    await assert.rejects(openRoundGitObservationEvidenceV1({
      taskFolderPath: "/tasks/task-a",
      operationId: "op-9",
      readText: () => Promise.resolve(JSON.stringify({ taskFolderPath: "/tasks/other", operationId: "op-9" })),
      open: () => Promise.reject(new Error("must not open another task's record")),
    }), /does not belong to this task/);
  });

  void it("posts one updateable task-chat decision and refreshes it after another observation", async () => {
    const fixture = makeOwnedTaskFolder("round-git-decision-");
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    const realFs = installRealFs();
    try {
      const common = {
        taskFolderPath: fixture.folder,
        taskName: "Git recovery task",
        stage: "impl" as const,
      };
      await offerRoundGitInterferenceDecisionV1({
        ...common,
        hold: { unmergedPaths: ["src/a.ts"], stashOperationIds: [] },
      });
      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const first = store.listPending(fixture.folder);
      assert.equal(first.length, 1);
      const firstId = first[0]?.decisionId;
      assert.equal(first[0]?.whatHappened.includes("src/a.ts"), true);

      await offerRoundGitInterferenceDecisionV1({
        ...common,
        hold: { unmergedPaths: ["src/a.ts", "src/b.ts"], stashOperationIds: ["op-8"] },
      });
      const refreshed = store.listPending(fixture.folder);
      assert.equal(refreshed.length, 1);
      assert.equal(refreshed[0]?.decisionId, firstId);
      assert.deepEqual(refreshed[0]?.options.map((option) => option.label), [
        "Keep working-tree version: src/a.ts",
        "Keep working-tree version: src/b.ts",
        "View Git observation evidence: op-8",
        "Acknowledge stash change: op-8",
        "Not now",
      ]);
      assert.equal(refreshed[0]?.decisionKey, "roundGitInterferenceRecovery");
    } finally {
      realFs.restore();
      fs.rmSync(fixture.folder, { recursive: true, force: true });
    }
  });
});
