/**
 * Shared fixture for the §7.4/§7.6/§7.7 edit-broker suites
 * (editPreconditionsV1 / editReceiptContractV1 / editRecoveryV1): a real
 * temp workspace root and private-storage root behind one
 * `workflowFileStoreV1`, a ledger populated with REAL on-disk observations,
 * and a canonical five-kind plan the suites drive through the broker.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createWorkflowFileStoreV1, WorkflowFileStoreV1 } from "../services/workflowFileStoreV1";
import {
  EditPlanBrokerV1,
  createEditPlanBrokerV1,
} from "../services/editBrokerToolSessionHandlerV1";
import {
  ObservationLedgerV1,
  createObservationLedgerV1,
  validatePreflightPlanAgainstLedgerV1,
} from "../types/preflightPlanV1";
import { PreflightOperationV1, PreflightPlanCompletedV1 } from "../types/aiResultEnvelope";
import { ActionCorrelationV1, allocateHex128IdV1 } from "../types/actionCorrelationV1";
import { EditExecutionScriptV1 } from "../types/editExecutionProtocolV1";
import { RequestLocalToolHandlerV1 } from "../services/requestLocalToolHandlerV1";

export const WORKSPACE_ROOT_ID = "workspace:edit-broker-test";
export const PRIVATE_ROOT_ID = "private:edit-broker-test";

export interface EditBrokerHarnessV1 {
  readonly workspaceRoot: string;
  readonly privateRoot: string;
  readonly store: WorkflowFileStoreV1;
  readonly broker: EditPlanBrokerV1;
  readonly ledger: ObservationLedgerV1;
  readonly plan: PreflightPlanCompletedV1;
  readonly correlation: ActionCorrelationV1;
  seal(): Promise<{ executionId: string; planId: string; script: EditExecutionScriptV1 }>;
  claimAndHandler(executionId: string): Promise<RequestLocalToolHandlerV1>;
  /** Drive one scripted step through the handler, returning the parsed result. */
  callStep(
    handler: RequestLocalToolHandlerV1,
    script: EditExecutionScriptV1,
    index: number,
    overrides?: Partial<{ stepId: string; tool: string; planDigest: string }>
  ): Promise<Record<string, unknown>>;
  cleanup(): void;
}

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function installEditBrokerHarnessV1(): Promise<EditBrokerHarnessV1> {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-edit-broker-ws-"));
  const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-edit-broker-priv-"));

  // On-disk baseline the plan's preconditions observe.
  fs.mkdirSync(path.join(workspaceRoot, "src"));
  fs.writeFileSync(path.join(workspaceRoot, "src", "existing.ts"), "old content\n");
  fs.writeFileSync(path.join(workspaceRoot, "src", "old.ts"), "delete me\n");
  fs.mkdirSync(path.join(workspaceRoot, "empty"));

  const store = createWorkflowFileStoreV1([
    { rootId: WORKSPACE_ROOT_ID, fsPath: workspaceRoot, trustedForMutation: true },
    { rootId: PRIVATE_ROOT_ID, fsPath: privateRoot, trustedForMutation: true },
  ]);
  const broker = createEditPlanBrokerV1({ getFileStore: () => store, privateRootId: PRIVATE_ROOT_ID });
  const ledger = createObservationLedgerV1();

  // Real observations: revisions/digests come from the actual filesystem.
  const missingNewFile = ledger.mint({
    callId: "c1",
    rootId: WORKSPACE_ROOT_ID,
    relativePath: "src/new.ts",
    kind: "missing",
    revision: "missing",
    complete: true,
    source: "stat",
  });
  const missingGeneratedDir = ledger.mint({
    callId: "c2",
    rootId: WORKSPACE_ROOT_ID,
    relativePath: "src/generated",
    kind: "missing",
    revision: "missing",
    complete: true,
    source: "stat",
  });
  const missingGeneratedFile = ledger.mint({
    callId: "c3",
    rootId: WORKSPACE_ROOT_ID,
    relativePath: "src/generated/out.ts",
    kind: "missing",
    revision: "missing",
    complete: true,
    source: "stat",
  });
  const existingRead = await store.readFileBounded(
    { rootId: WORKSPACE_ROOT_ID, relativePath: "src/existing.ts" },
    1024 * 1024
  );
  if (existingRead.kind !== "ok") {
    throw new Error("harness: could not read src/existing.ts");
  }
  const existingFile = ledger.mint({
    callId: "c4",
    rootId: WORKSPACE_ROOT_ID,
    relativePath: "src/existing.ts",
    kind: "file",
    revision: existingRead.value.revision,
    contentSha256: existingRead.value.sha256,
    complete: true,
    source: "readFile",
  });
  const oldRead = await store.readFileBounded(
    { rootId: WORKSPACE_ROOT_ID, relativePath: "src/old.ts" },
    1024 * 1024
  );
  if (oldRead.kind !== "ok") {
    throw new Error("harness: could not read src/old.ts");
  }
  const oldFile = ledger.mint({
    callId: "c5",
    rootId: WORKSPACE_ROOT_ID,
    relativePath: "src/old.ts",
    kind: "file",
    revision: oldRead.value.revision,
    contentSha256: oldRead.value.sha256,
    complete: true,
    source: "readFile",
  });
  const srcListing = ledger.mint({
    callId: "c6",
    rootId: WORKSPACE_ROOT_ID,
    relativePath: "src",
    kind: "directory",
    revision: "dir:harness",
    complete: true,
    source: "readDirectory",
    entryNames: ["existing.ts", "old.ts"],
  });
  const emptyListing = ledger.mint({
    callId: "c7",
    rootId: WORKSPACE_ROOT_ID,
    relativePath: "empty",
    kind: "directory",
    revision: "dir:empty",
    complete: true,
    source: "readDirectory",
    entryNames: [],
  });

  const newBytes = Buffer.from("new file content\n", "utf8");
  const generatedBytes = Buffer.from("generated\n", "utf8");
  const replacementBytes = Buffer.from("replacement content\n", "utf8");

  const operations: PreflightOperationV1[] = [
    {
      stepId: "s1",
      kind: "createFile",
      rootId: WORKSPACE_ROOT_ID,
      relativePath: "src/new.ts",
      targetObservationId: missingNewFile.observationId,
      parentChain: [{ kind: "observed", observationId: srcListing.observationId }],
      contentBase64: newBytes.toString("base64"),
      decodedByteLength: newBytes.length,
      contentSha256: sha256Hex(newBytes),
    },
    {
      stepId: "s2",
      kind: "createDirectory",
      rootId: WORKSPACE_ROOT_ID,
      relativePath: "src/generated",
      targetObservationId: missingGeneratedDir.observationId,
      parentChain: [{ kind: "observed", observationId: srcListing.observationId }],
    },
    {
      stepId: "s3",
      kind: "createFile",
      rootId: WORKSPACE_ROOT_ID,
      relativePath: "src/generated/out.ts",
      targetObservationId: missingGeneratedFile.observationId,
      parentChain: [
        { kind: "observed", observationId: srcListing.observationId },
        { kind: "createdByStep", stepId: "s2" },
      ],
      contentBase64: generatedBytes.toString("base64"),
      decodedByteLength: generatedBytes.length,
      contentSha256: sha256Hex(generatedBytes),
    },
    {
      stepId: "s4",
      kind: "replaceFile",
      rootId: WORKSPACE_ROOT_ID,
      relativePath: "src/existing.ts",
      targetObservationId: existingFile.observationId,
      parentChain: [{ kind: "observed", observationId: srcListing.observationId }],
      contentBase64: replacementBytes.toString("base64"),
      decodedByteLength: replacementBytes.length,
      contentSha256: sha256Hex(replacementBytes),
    },
    {
      stepId: "s5",
      kind: "deleteFile",
      rootId: WORKSPACE_ROOT_ID,
      relativePath: "src/old.ts",
      targetObservationId: oldFile.observationId,
      parentChain: [{ kind: "observed", observationId: srcListing.observationId }],
    },
    {
      stepId: "s6",
      kind: "deleteEmptyDirectory",
      rootId: WORKSPACE_ROOT_ID,
      relativePath: "empty",
      targetObservationId: emptyListing.observationId,
      parentChain: [],
    },
  ];

  const plan: PreflightPlanCompletedV1 = {
    contentType: "preflight-plan.v1",
    schemaVersion: 1,
    requestDigest: "ab".repeat(32),
    rootBindingId: "cd".repeat(32),
    operations,
  };
  const validation = validatePreflightPlanAgainstLedgerV1(plan, ledger, WORKSPACE_ROOT_ID);
  if (!validation.ok) {
    throw new Error(`harness plan failed validation: ${validation.code} — ${validation.reason}`);
  }

  const correlation: ActionCorrelationV1 = {
    actionKey: "implementation.v1",
    operationId: allocateHex128IdV1(),
    attemptId: allocateHex128IdV1(),
    taskBindingId: "binding",
    chatDocumentId: "chat",
  };

  return {
    workspaceRoot,
    privateRoot,
    store,
    broker,
    ledger,
    plan,
    correlation,
    async seal() {
      const sealed = await broker.sealPlan({
        plan,
        ledger,
        correlation,
        rootId: WORKSPACE_ROOT_ID,
      });
      if (!sealed.ok) {
        throw new Error(`harness seal failed: ${sealed.reason}`);
      }
      return { executionId: sealed.executionId, planId: sealed.planId, script: sealed.script };
    },
    async claimAndHandler(executionId) {
      const claim = await broker.claimExecutionPermit(executionId);
      if (!claim.ok) {
        throw new Error(`harness claim failed: ${claim.code}`);
      }
      return broker.createEditSessionHandler(executionId);
    },
    async callStep(handler, script, index, overrides = {}) {
      const step = script.steps[index]!;
      const text = await handler.handleToolCall({
        kind: "toolCall",
        callId: `host-${index + 1}`,
        name: overrides.tool ?? step.tool,
        input: {
          executionId: script.executionId,
          planId: script.planId,
          planDigest: overrides.planDigest ?? script.planDigest,
          stepId: overrides.stepId ?? step.stepId,
        },
      });
      return JSON.parse(text) as Record<string, unknown>;
    },
    cleanup() {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      fs.rmSync(privateRoot, { recursive: true, force: true });
    },
  };
}
