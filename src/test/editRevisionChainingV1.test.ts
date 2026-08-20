/**
 * Coverage for item 17: two or more `patchFile` operations targeting the SAME
 * file within one plan now apply in order — each later touch is verified and
 * written against the file as the PREVIOUS touch left it
 * (editBrokerToolSessionHandlerV1's per-path revision chaining), rather than
 * being rejected outright by `duplicateTarget`.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createWorkflowFileStoreV1, WorkflowFileStoreV1 } from "../services/workflowFileStoreV1";
import { EditPlanBrokerV1, createEditPlanBrokerV1 } from "../services/editBrokerToolSessionHandlerV1";
import {
  ObservationLedgerV1,
  ObservationRecordV1,
  createObservationLedgerV1,
  validatePreflightPlanAgainstLedgerV1,
} from "../types/preflightPlanV1";
import { PreflightOperationV1, PreflightPlanCompletedV1 } from "../types/aiResultEnvelope";
import { ActionCorrelationV1, allocateHex128IdV1 } from "../types/actionCorrelationV1";
import { EditExecutionScriptV1 } from "../types/editExecutionProtocolV1";
import { RequestLocalToolHandlerV1 } from "../services/requestLocalToolHandlerV1";

const WORKSPACE_ROOT_ID = "workspace:revision-chaining-test";
const PRIVATE_ROOT_ID = "private:revision-chaining-test";

interface FixtureV1 {
  readonly store: WorkflowFileStoreV1;
  readonly broker: EditPlanBrokerV1;
  readonly ledger: ObservationLedgerV1;
  readonly fileObservation: ObservationRecordV1;
  cleanup(): void;
}

async function installFixtureV1(initialContent: string): Promise<FixtureV1> {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-revchain-ws-"));
  const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-revchain-priv-"));
  fs.writeFileSync(path.join(workspaceRoot, "target.ts"), initialContent);

  const store = createWorkflowFileStoreV1([
    { rootId: WORKSPACE_ROOT_ID, fsPath: workspaceRoot, trustedForMutation: true },
    { rootId: PRIVATE_ROOT_ID, fsPath: privateRoot, trustedForMutation: true },
  ]);
  const broker = createEditPlanBrokerV1({ getFileStore: () => store, privateRootId: PRIVATE_ROOT_ID });
  const ledger = createObservationLedgerV1();

  const read = await store.readFileBounded(
    { rootId: WORKSPACE_ROOT_ID, relativePath: "target.ts" },
    1024 * 1024
  );
  if (read.kind !== "ok") {
    throw new Error("fixture: could not read target.ts");
  }
  const fileObservation = ledger.mint({
    callId: "c1",
    rootId: WORKSPACE_ROOT_ID,
    relativePath: "target.ts",
    kind: "file",
    revision: read.value.revision,
    contentSha256: read.value.sha256,
    complete: true,
    source: "readFile",
  });

  return {
    store,
    broker,
    ledger,
    fileObservation,
    cleanup() {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      fs.rmSync(privateRoot, { recursive: true, force: true });
    },
  };
}

function patchOp(
  stepId: string,
  findText: string,
  replacementText: string,
  targetObservationId: string
): PreflightOperationV1 {
  return {
    stepId,
    kind: "patchFile",
    rootId: WORKSPACE_ROOT_ID,
    relativePath: "target.ts",
    targetObservationId,
    parentChain: [],
    findBase64: Buffer.from(findText, "utf8").toString("base64"),
    replacementBase64: Buffer.from(replacementText, "utf8").toString("base64"),
  };
}

function correlation(): ActionCorrelationV1 {
  return {
    actionKey: "implementation.v1",
    operationId: allocateHex128IdV1(),
    attemptId: allocateHex128IdV1(),
    taskBindingId: "binding",
    chatDocumentId: "chat",
  };
}

function planOf(operations: readonly PreflightOperationV1[]): PreflightPlanCompletedV1 {
  return {
    contentType: "preflight-plan.v1",
    schemaVersion: 1,
    requestDigest: "ab".repeat(32),
    rootBindingId: "cd".repeat(32),
    operations,
  };
}

interface SealedV1 {
  readonly executionId: string;
  readonly planId: string;
  readonly planDigest: string;
  readonly script: EditExecutionScriptV1;
}

async function sealClaimAndGetHandler(
  fixture: FixtureV1,
  plan: PreflightPlanCompletedV1
): Promise<{ sealed: SealedV1; handler: RequestLocalToolHandlerV1 }> {
  const sealed = await fixture.broker.sealPlan({
    plan,
    ledger: fixture.ledger,
    correlation: correlation(),
    rootId: WORKSPACE_ROOT_ID,
  });
  if (!sealed.ok) {
    throw new Error(`seal failed: ${sealed.reason}`);
  }
  const claim = await fixture.broker.claimExecutionPermit(sealed.executionId);
  if (!claim.ok) {
    throw new Error(`claim failed: ${claim.code}`);
  }
  const handler = fixture.broker.createEditSessionHandler(sealed.executionId);
  return { sealed, handler };
}

async function callStep(
  handler: RequestLocalToolHandlerV1,
  sealed: SealedV1,
  index: number
): Promise<Record<string, unknown>> {
  const step = sealed.script.steps[index]!;
  const text = await handler.handleToolCall({
    kind: "toolCall",
    callId: `host-${index + 1}`,
    name: step.tool,
    input: {
      executionId: sealed.executionId,
      planId: sealed.planId,
      planDigest: sealed.planDigest,
      stepId: step.stepId,
    },
  });
  return JSON.parse(text) as Record<string, unknown>;
}

void describe("editRevisionChainingV1 — item 17", () => {
  void it("validates two patchFile operations on the same path", async () => {
    const fixture = await installFixtureV1("start\nMARKER\nend\n");
    try {
      const plan = planOf([
        patchOp("s1", "MARKER", "middle-one\nmiddle-two", fixture.fileObservation.observationId),
        patchOp("s2", "middle-two", "middle-two-edited", fixture.fileObservation.observationId),
      ]);
      const validation = validatePreflightPlanAgainstLedgerV1(plan, fixture.ledger, WORKSPACE_ROOT_ID);
      assert.deepEqual(validation, { ok: true }, "two patchFile ops on one path must validate");
    } finally {
      fixture.cleanup();
    }
  });

  void it("still refuses a duplicate target when the operations are not all patchFile", async () => {
    const fixture = await installFixtureV1("start\nMARKER\nend\n");
    try {
      const plan = planOf([
        patchOp("s1", "MARKER", "middle", fixture.fileObservation.observationId),
        {
          stepId: "s2",
          kind: "deleteFile",
          rootId: WORKSPACE_ROOT_ID,
          relativePath: "target.ts",
          targetObservationId: fixture.fileObservation.observationId,
          parentChain: [],
        },
      ]);
      const validation = validatePreflightPlanAgainstLedgerV1(plan, fixture.ledger, WORKSPACE_ROOT_ID);
      assert.equal(validation.ok, false);
      assert.equal(validation.ok === false && validation.code, "duplicateTarget");
    } finally {
      fixture.cleanup();
    }
  });

  void it("applies a second patchFile operation anchored on text the first patch introduced", async () => {
    const fixture = await installFixtureV1("start\nMARKER\nend\n");
    try {
      const plan = planOf([
        patchOp("s1", "MARKER", "middle-one\nmiddle-two", fixture.fileObservation.observationId),
        patchOp("s2", "middle-two", "middle-two-edited", fixture.fileObservation.observationId),
      ]);
      assert.deepEqual(validatePreflightPlanAgainstLedgerV1(plan, fixture.ledger, WORKSPACE_ROOT_ID), { ok: true });

      const { sealed, handler } = await sealClaimAndGetHandler(fixture, plan);
      for (let i = 0; i < sealed.script.steps.length; i++) {
        const result = await callStep(handler, sealed, i);
        assert.equal(result.ok, true, `step ${i} (${sealed.script.steps[i]!.stepId}) must apply cleanly: ${JSON.stringify(result)}`);
      }

      const finalRead = await fixture.store.readFileBounded(
        { rootId: WORKSPACE_ROOT_ID, relativePath: "target.ts" },
        1024 * 1024
      );
      if (finalRead.kind !== "ok") {
        throw new Error("could not read final content");
      }
      assert.equal(finalRead.value.bytes.toString("utf8"), "start\nmiddle-one\nmiddle-two-edited\nend\n");
      assert.equal(fixture.broker.executionOutcome(sealed.executionId)?.state, "completed");
    } finally {
      fixture.cleanup();
    }
  });

  void it("fails cleanly when a second patchFile operation anchors on text the first patch removed", async () => {
    const fixture = await installFixtureV1("start\nMARKER\nend\n");
    try {
      const plan = planOf([
        patchOp("s1", "MARKER", "replacement", fixture.fileObservation.observationId),
        // "MARKER" no longer exists once s1 has applied — this anchor is stale.
        patchOp("s2", "MARKER", "should-not-apply", fixture.fileObservation.observationId),
      ]);
      assert.deepEqual(validatePreflightPlanAgainstLedgerV1(plan, fixture.ledger, WORKSPACE_ROOT_ID), { ok: true });

      const { sealed, handler } = await sealClaimAndGetHandler(fixture, plan);
      const first = await callStep(handler, sealed, 0);
      assert.equal(first.ok, true);

      const second = await callStep(handler, sealed, 1);
      assert.equal(second.ok, false);
      assert.equal(second.code, "stalePreflight");

      // The first patch's write remains in place — a stale second touch does
      // not undo an already-applied receipt (§7.7 partialEditBlocked territory).
      const finalRead = await fixture.store.readFileBounded(
        { rootId: WORKSPACE_ROOT_ID, relativePath: "target.ts" },
        1024 * 1024
      );
      if (finalRead.kind !== "ok") {
        throw new Error("could not read final content");
      }
      assert.equal(finalRead.value.bytes.toString("utf8"), "start\nreplacement\nend\n");
      assert.equal(fixture.broker.executionOutcome(sealed.executionId)?.state, "partialEditBlocked");
    } finally {
      fixture.cleanup();
    }
  });
});
