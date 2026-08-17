/**
 * Edit-execution protocol (plan §7.4/§7.6): the canonical execution script
 * (the ONLY description of work a mutation session receives), reference-only
 * mutation calls, ordered receipts, and the sealed-plan/audit record shapes
 * the edit broker persists and reads back before any mutation.
 */
import { ActionCorrelationV1 } from "./actionCorrelationV1";
import { PreflightOperationKindV1, PreflightOperationV1 } from "./aiResultEnvelope";
import { ObservationRecordV1 } from "./preflightPlanV1";
import { EditToolNameV1 } from "./workflowToolProtocolV1";
import { sha256OfCanonicalJsonV1 } from "../services/canonicalJsonV1";

export interface EditExecutionScriptStepV1 {
  readonly stepId: string;
  readonly tool: EditToolNameV1;
}

/** §7.4's script: step order and tool assignment only — no paths, bytes, preconditions, or observations. */
export interface EditExecutionScriptV1 {
  readonly executionId: string;
  readonly planId: string;
  readonly planDigest: string;
  readonly steps: readonly EditExecutionScriptStepV1[];
}

/** Reference-only mutation-call arguments (§7.4) — never a path, never bytes. */
export interface MutationCallV1 {
  readonly executionId: string;
  readonly planId: string;
  readonly planDigest: string;
  readonly stepId: string;
}

export interface MutationReceiptV1 {
  readonly receiptId: string;
  readonly executionId: string;
  readonly planId: string;
  readonly stepId: string;
  readonly hostCallId: string;
  readonly operationDigest: string;
  readonly preconditionDigest: string;
  readonly postconditionDigest: string;
  readonly outcome: "applied";
}

/** Broker execution states. `sealed` → `executing` (permit claimed) → one terminal state. */
export type EditExecutionStateV1 =
  | "sealed"
  | "executing"
  | "completed"
  | "stalePreflight"
  | "partialEditBlocked";

/**
 * Everything the broker persists when a validated preflight plan is sealed
 * (§7.6 step 1): the plan operations, the observation records that
 * authorized them, the digests binding them together, and the authored
 * script. Written exclusively, read back and digest-verified before any
 * mutation session starts.
 */
export interface SealedPlanRecordV1 {
  readonly schemaVersion: 1;
  readonly executionId: string;
  readonly planId: string;
  readonly planDigest: string;
  readonly ledgerDigest: string;
  readonly requestDigest: string;
  readonly rootBindingId: string;
  /** The single registered workspace root every operation targets. */
  readonly rootId: string;
  readonly correlation: ActionCorrelationV1;
  readonly operations: readonly PreflightOperationV1[];
  readonly observations: readonly ObservationRecordV1[];
  readonly script: EditExecutionScriptV1;
  readonly scriptDigest: string;
}

/** §7.4's fixed operation-kind → mutation-tool mapping. */
export function toolForOperationKindV1(kind: PreflightOperationKindV1): EditToolNameV1 {
  switch (kind) {
    case "createFile":
    case "replaceFile":
      return "ensemble_writeFile";
    case "createDirectory":
      return "ensemble_createDirectory";
    case "deleteFile":
    case "deleteEmptyDirectory":
      return "ensemble_deletePath";
  }
}

export function buildEditExecutionScriptV1(
  executionId: string,
  planId: string,
  planDigest: string,
  operations: readonly PreflightOperationV1[]
): EditExecutionScriptV1 {
  return {
    executionId,
    planId,
    planDigest,
    steps: operations.map((operation) => ({
      stepId: operation.stepId,
      tool: toolForOperationKindV1(operation.kind),
    })),
  };
}

export function computeEditExecutionScriptDigestV1(script: EditExecutionScriptV1): string {
  return sha256OfCanonicalJsonV1({
    executionId: script.executionId,
    planId: script.planId,
    planDigest: script.planDigest,
    steps: script.steps.map((step) => ({ stepId: step.stepId, tool: step.tool })),
  });
}

/** Canonical digest of one sealed operation — recorded in its receipt. */
export function computeSealedOperationDigestV1(operation: PreflightOperationV1): string {
  return sha256OfCanonicalJsonV1({
    stepId: operation.stepId,
    kind: operation.kind,
    rootId: operation.rootId,
    relativePath: operation.relativePath,
    targetObservationId: operation.targetObservationId,
    parentChain: operation.parentChain.map((link) =>
      link.kind === "observed"
        ? { kind: "observed", observationId: link.observationId }
        : { kind: "createdByStep", stepId: link.stepId }
    ),
    ...(operation.contentBase64 !== undefined ? { contentBase64: operation.contentBase64 } : {}),
    ...(operation.decodedByteLength !== undefined
      ? { decodedByteLength: operation.decodedByteLength }
      : {}),
    ...(operation.contentSha256 !== undefined ? { contentSha256: operation.contentSha256 } : {}),
  });
}

export type MutationCallDecodeResultV1 =
  | { readonly ok: true; readonly call: MutationCallV1 }
  | { readonly ok: false; readonly reason: string };

/** Strict decode of model-authored mutation-call arguments: exactly the four reference fields. */
export function decodeMutationCallV1(raw: unknown): MutationCallDecodeResultV1 {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "mutation call is not an object" };
  }
  const record = raw as Record<string, unknown>;
  const fields = ["executionId", "planId", "planDigest", "stepId"] as const;
  for (const key of Object.keys(record)) {
    if (!(fields as readonly string[]).includes(key)) {
      return { ok: false, reason: `mutation call has an unknown field: ${key}` };
    }
  }
  for (const field of fields) {
    const value = record[field];
    if (typeof value !== "string" || value.length === 0 || value.length > 256) {
      return { ok: false, reason: `mutation call has a missing or invalid ${field}` };
    }
  }
  return {
    ok: true,
    call: {
      executionId: record.executionId as string,
      planId: record.planId as string,
      planDigest: record.planDigest as string,
      stepId: record.stepId as string,
    },
  };
}
