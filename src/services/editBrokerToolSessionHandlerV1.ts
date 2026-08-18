/**
 * Edit plan broker + mutation-session tool handler (plan §7.4/§7.6/§7.7).
 *
 * The broker owns everything between an accepted preflight plan and its
 * receipts:
 *
 *  - SEALING (§7.6 step 1): a validated plan, its observation records, the
 *    digests binding them, and the authored execution script are persisted
 *    exclusively under the private-storage root
 *    (`workflow-runtime-v1/edit-runs/<executionId>/sealed-plan-v1.json`),
 *    then read back and digest-verified before any session may start.
 *  - The EXECUTION PERMIT (§7.6 step 2): claim-once, durably — the claim
 *    record is an exclusive create, so no crash, retry, or second attempt
 *    can ever open a second mutation session for the same sealed plan.
 *  - The MUTATION SESSION HANDLER (§7.4): validates every reference-only
 *    call against the script's exact order and tool assignment, re-verifies
 *    the §7.7 preconditions immediately before each operation, executes
 *    through `workflowFileStoreV1`'s exclusive/exact primitives (whose
 *    atomic `revisionMismatch`/`targetExists` failures are the authoritative
 *    stale signals), and persists an ordered receipt BEFORE returning each
 *    tool result.
 *  - OUTCOMES (§7.7): a mismatch before any receipt settles the execution
 *    as `stalePreflight` (never auto-retried); after ≥1 receipt it settles
 *    as `partialEditBlocked` with the authoritative applied receipt ids —
 *    verified partial edits remain in place.
 */
import { createHash } from "crypto";
import {
  WorkflowFileLocatorV1,
  WorkflowFileStoreV1,
} from "./workflowFileStoreV1";
import { canonicalJsonStringifyV1, sha256OfCanonicalJsonV1 } from "./canonicalJsonV1";
import {
  EditExecutionScriptV1,
  EditExecutionStateV1,
  MutationReceiptV1,
  SealedPlanRecordV1,
  buildEditExecutionScriptV1,
  computeEditExecutionScriptDigestV1,
  computeSealedOperationDigestV1,
  decodeMutationCallV1,
} from "../types/editExecutionProtocolV1";
import {
  ObservationLedgerV1,
  ObservationRecordV1,
  computePreflightPlanDigestV1,
  computePreflightPlanIdV1,
} from "../types/preflightPlanV1";
import { PreflightPlanCompletedV1 } from "../types/aiResultEnvelope";
import { ActionCorrelationV1, allocateHex128IdV1 } from "../types/actionCorrelationV1";
import { editToolDescriptorsV1, MAX_DIRECTORY_ENTRIES_V1 } from "../types/workflowToolProtocolV1";
import { RequestLocalToolHandlerV1, createViolationCounterV1 } from "./requestLocalToolHandlerV1";
import { LmToolCallPartV1 } from "../types/vscodeLmCompatV1";
import { EDIT_RUNS_DIRNAME_V1, WORKFLOW_RUNTIME_DIRNAME_V1 } from "./workflowPrivacyClassifierV1";

/**
 * Read ceiling when loading a patch target.
 *
 * Deliberately larger than the tool-session read cap
 * (`MAX_READ_FILE_BYTES_V1`, 512 KB): patching exists precisely to edit files
 * too large to round-trip through a model, so the executor must be able to
 * load files the model itself could never have been shown in full. Bounded all
 * the same — an unbounded read would reintroduce host-side the memory profile
 * the whole-file path is capped to avoid.
 */
const MAX_PATCH_TARGET_BYTES_V1 = 16 * 1024 * 1024;

export type SealPlanResultV1 =
  | {
      readonly ok: true;
      readonly executionId: string;
      readonly planId: string;
      readonly planDigest: string;
      readonly script: EditExecutionScriptV1;
    }
  | { readonly ok: false; readonly code: "sealPersistFailed"; readonly reason: string };

export interface EditExecutionOutcomeV1 {
  readonly state: EditExecutionStateV1;
  /** Authoritative ordered receipt ids issued so far. */
  readonly appliedReceiptIds: readonly string[];
}

export interface EditPlanBrokerV1 {
  /** Seal a validated plan (§7.6 step 1). The ledger must be the attempt's own. */
  sealPlan(input: {
    readonly plan: PreflightPlanCompletedV1;
    readonly ledger: ObservationLedgerV1;
    readonly correlation: ActionCorrelationV1;
    /** The single registered workspace root every operation targets. */
    readonly rootId: string;
  }): Promise<SealPlanResultV1>;
  /** The sealed execution for one coordinator operation, if any. */
  sealedExecutionForOperation(operationId: string): SealedPlanRecordV1 | undefined;
  sealedExecution(executionId: string): SealedPlanRecordV1 | undefined;
  /** §7.6 step 2: durable, claim-once execution permit. */
  claimExecutionPermit(executionId: string): Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly code: "unknownExecution" | "permitAlreadyClaimed" | "permitPersistFailed" }
  >;
  /** The §7.4 mutation-session handler for a claimed execution. */
  createEditSessionHandler(executionId: string): RequestLocalToolHandlerV1;
  executionOutcome(executionId: string): EditExecutionOutcomeV1 | undefined;
}

interface ExecutionStateV1 {
  readonly sealed: SealedPlanRecordV1;
  state: EditExecutionStateV1;
  cursor: number;
  readonly receipts: MutationReceiptV1[];
  readonly receiptsByStepId: Map<string, MutationReceiptV1>;
  readonly observationsById: Map<string, ObservationRecordV1>;
}

export interface EditPlanBrokerDepsV1 {
  /**
   * LIVE file-store accessor: the shared store is rebuilt whenever a new
   * root registers (workflowRuntimeServicesV1.rebuildFileStore), so the
   * broker must never capture one instance for its whole lifetime.
   */
  readonly getFileStore: () => WorkflowFileStoreV1;
  /** The configured private-storage root id (workflowRuntimeServicesV1). */
  readonly privateRootId: string;
}

export function createEditPlanBrokerV1(deps: EditPlanBrokerDepsV1): EditPlanBrokerV1 {
  const executions = new Map<string, ExecutionStateV1>();
  const executionIdByOperationId = new Map<string, string>();

  function runDirPath(executionId: string): string {
    return `${WORKFLOW_RUNTIME_DIRNAME_V1}/${EDIT_RUNS_DIRNAME_V1}/${executionId}`;
  }

  function runFileLocator(executionId: string, fileName: string): WorkflowFileLocatorV1 {
    return { rootId: deps.privateRootId, relativePath: `${runDirPath(executionId)}/${fileName}` };
  }

  async function ensureRunDir(executionId: string): Promise<boolean> {
    // Nonrecursive provisioning: workflow-runtime-v1 and edit-runs first.
    const parents = [
      WORKFLOW_RUNTIME_DIRNAME_V1,
      `${WORKFLOW_RUNTIME_DIRNAME_V1}/${EDIT_RUNS_DIRNAME_V1}`,
      runDirPath(executionId),
    ];
    for (const relativePath of parents) {
      const created = await deps.getFileStore().createDirectory({
        rootId: deps.privateRootId,
        relativePath,
      });
      if (created.kind === "failed" && created.code !== "targetExists") {
        return false;
      }
      if (created.kind === "unavailable") {
        return false;
      }
    }
    return true;
  }

  return {
    async sealPlan(input) {
      const planDigest = computePreflightPlanDigestV1(input.plan);
      const ledgerDigest = input.ledger.digest();
      const planId = computePreflightPlanIdV1(planDigest, ledgerDigest, input.correlation);
      const executionId = allocateHex128IdV1();
      const script = buildEditExecutionScriptV1(
        executionId,
        planId,
        planDigest,
        input.plan.operations
      );
      const sealed: SealedPlanRecordV1 = {
        schemaVersion: 1,
        executionId,
        planId,
        planDigest,
        ledgerDigest,
        requestDigest: input.plan.requestDigest,
        rootBindingId: input.plan.rootBindingId,
        rootId: input.rootId,
        correlation: input.correlation,
        operations: input.plan.operations,
        observations: input.ledger.records(),
        script,
        scriptDigest: computeEditExecutionScriptDigestV1(script),
      };

      if (!(await ensureRunDir(executionId))) {
        return { ok: false, code: "sealPersistFailed", reason: "could not provision the edit-run directory" };
      }
      const sealedJson = JSON.stringify(sealed, null, 2);
      const persisted = await deps.getFileStore().createFileExclusive(
        runFileLocator(executionId, "sealed-plan-v1.json"),
        Buffer.from(sealedJson, "utf8")
      );
      if (persisted.kind !== "ok") {
        return { ok: false, code: "sealPersistFailed", reason: "could not persist the sealed plan" };
      }
      // §7.6 step 1: read the persisted record BACK and verify what is
      // actually on disk, byte for byte, before any session may consume it.
      const readBack = await deps.getFileStore().readFileBounded(
        runFileLocator(executionId, "sealed-plan-v1.json"),
        32 * 1024 * 1024
      );
      if (readBack.kind !== "ok" || readBack.value.bytes.toString("utf8") !== sealedJson) {
        return { ok: false, code: "sealPersistFailed", reason: "sealed plan read-back verification failed" };
      }

      const observationsById = new Map<string, ObservationRecordV1>();
      for (const record of sealed.observations) {
        observationsById.set(record.observationId, record);
      }
      executions.set(executionId, {
        sealed,
        state: "sealed",
        cursor: 0,
        receipts: [],
        receiptsByStepId: new Map(),
        observationsById,
      });
      executionIdByOperationId.set(input.correlation.operationId, executionId);
      return { ok: true, executionId, planId, planDigest, script };
    },

    sealedExecutionForOperation(operationId) {
      const executionId = executionIdByOperationId.get(operationId);
      return executionId ? executions.get(executionId)?.sealed : undefined;
    },

    sealedExecution(executionId) {
      return executions.get(executionId)?.sealed;
    },

    async claimExecutionPermit(executionId) {
      const execution = executions.get(executionId);
      if (!execution) {
        return { ok: false, code: "unknownExecution" };
      }
      if (execution.state !== "sealed") {
        return { ok: false, code: "permitAlreadyClaimed" };
      }
      // Durable claim-once: an exclusive create can succeed exactly once for
      // this executionId, across crashes and processes.
      const claim = await deps.getFileStore().createFileExclusive(
        runFileLocator(executionId, "execution-claim-v1.json"),
        Buffer.from(
          JSON.stringify({ executionId, claimedAt: new Date().toISOString() }, null, 2),
          "utf8"
        )
      );
      if (claim.kind === "failed" && claim.code === "targetExists") {
        return { ok: false, code: "permitAlreadyClaimed" };
      }
      if (claim.kind !== "ok") {
        return { ok: false, code: "permitPersistFailed" };
      }
      execution.state = "executing";
      return { ok: true };
    },

    createEditSessionHandler(executionId) {
      const violations = createViolationCounterV1();

      const blockExecution = (execution: ExecutionStateV1): void => {
        execution.state = execution.receipts.length === 0 ? "stalePreflight" : "partialEditBlocked";
      };

      const errorJson = (code: string, reason: string): string =>
        canonicalJsonStringifyV1({ ok: false, code, reason });

      const handleMutationCall = async (call: LmToolCallPartV1): Promise<string> => {
        const execution = executions.get(executionId);
        if (!execution) {
          violations.record();
          return errorJson("unknownExecution", "no sealed execution for this session");
        }
        if (execution.state !== "executing") {
          violations.record();
          return errorJson("executionBlocked", `execution state is ${execution.state}`);
        }

        const decoded = decodeMutationCallV1(call.input);
        if (!decoded.ok) {
          violations.record();
          blockExecution(execution);
          return errorJson("invalidMutationCall", decoded.reason);
        }
        const { sealed } = execution;
        if (
          decoded.call.executionId !== sealed.executionId ||
          decoded.call.planId !== sealed.planId ||
          decoded.call.planDigest !== sealed.planDigest
        ) {
          violations.record();
          blockExecution(execution);
          return errorJson("mutationReferenceMismatch", "call references do not match the sealed plan");
        }

        const expectedStep = sealed.script.steps[execution.cursor];
        if (!expectedStep || expectedStep.stepId !== decoded.call.stepId || expectedStep.tool !== call.name) {
          // Reordered, repeated, skipped, altered, or unknown call (§7.4).
          violations.record();
          blockExecution(execution);
          return errorJson(
            "mutationOrderViolation",
            expectedStep
              ? `expected step ${expectedStep.stepId} via ${expectedStep.tool}`
              : "no steps remain"
          );
        }

        const operation = sealed.operations[execution.cursor]!;
        const targetLocator: WorkflowFileLocatorV1 = {
          rootId: sealed.rootId,
          relativePath: operation.relativePath,
        };
        const targetObservation = execution.observationsById.get(operation.targetObservationId);
        if (!targetObservation) {
          blockExecution(execution);
          return errorJson("stalePreflight", "sealed target observation is missing");
        }

        // §7.7 (4): every parent-chain link re-verified — observed ancestors
        // must still be directories; step-created ancestors must hold receipts.
        for (const link of operation.parentChain) {
          if (link.kind === "createdByStep") {
            if (!execution.receiptsByStepId.has(link.stepId)) {
              blockExecution(execution);
              return errorJson("stalePreflight", `parent step ${link.stepId} has no receipt`);
            }
            continue;
          }
          const parentObservation = execution.observationsById.get(link.observationId);
          if (!parentObservation) {
            blockExecution(execution);
            return errorJson("stalePreflight", "sealed parent observation is missing");
          }
          const parentStat = await deps.getFileStore().stat({
            rootId: sealed.rootId,
            relativePath: parentObservation.relativePath,
          });
          if (parentStat.kind !== "ok" || parentStat.value.kind !== "directory") {
            blockExecution(execution);
            return errorJson("stalePreflight", `ancestor ${parentObservation.relativePath} is no longer a directory`);
          }
        }

        // §7.7 (3)/(6): target re-verification + sealed-bytes re-hash, then
        // execution through the store's exclusive/exact primitives — whose
        // own atomic failures are the authoritative stale signals.
        let postconditionDigest = "";
        switch (operation.kind) {
          case "createFile":
          case "replaceFile": {
            const bytes = Buffer.from(operation.contentBase64 ?? "", "base64");
            const decodedSha = createHash("sha256").update(bytes).digest("hex");
            if (
              decodedSha !== operation.contentSha256 ||
              bytes.length !== (operation.decodedByteLength ?? -1)
            ) {
              blockExecution(execution);
              return errorJson("stalePreflight", "sealed content failed re-verification");
            }
            if (operation.kind === "createFile") {
              const preStat = await deps.getFileStore().stat(targetLocator);
              if (preStat.kind !== "ok" || preStat.value.kind !== "missing") {
                blockExecution(execution);
                return errorJson("stalePreflight", "create target is no longer missing");
              }
              const created = await deps.getFileStore().createFileExclusive(targetLocator, bytes);
              if (created.kind !== "ok") {
                blockExecution(execution);
                return errorJson("stalePreflight", "exclusive create failed");
              }
              postconditionDigest = sha256OfCanonicalJsonV1({
                revision: created.value.revision,
                sha256: created.value.sha256,
              });
            } else {
              const replaced = await deps.getFileStore().replaceFileExact(
                targetLocator,
                bytes,
                targetObservation.revision
              );
              if (replaced.kind !== "ok") {
                blockExecution(execution);
                return errorJson("stalePreflight", "exact replace failed (revision mismatch or IO)");
              }
              postconditionDigest = sha256OfCanonicalJsonV1({
                revision: replaced.value.revision,
                sha256: replaced.value.sha256,
              });
            }
            break;
          }
          case "patchFile": {
            // §7.7 (3)/(6) equivalent for a spliced write. The sealed payload
            // is a find/replacement pair rather than whole-file bytes, so the
            // re-verification that matters is that the region we are about to
            // replace still exists EXACTLY ONCE in the current file.
            //
            // Uniqueness is the whole safety property. Byte offsets were
            // deliberately not used: a model cannot compute them reliably, and
            // a wrong offset silently corrupts a file, whereas a non-unique or
            // absent match is detectable and refused here.
            const findBytes = Buffer.from(operation.findBase64 ?? "", "base64");
            const replacementBytes = Buffer.from(operation.replacementBase64 ?? "", "base64");
            if (findBytes.length === 0) {
              blockExecution(execution);
              return errorJson("stalePreflight", "patch has an empty find payload");
            }
            const current = await deps.getFileStore().readFileBounded(
              targetLocator,
              MAX_PATCH_TARGET_BYTES_V1
            );
            if (current.kind !== "ok") {
              blockExecution(execution);
              return errorJson("stalePreflight", "patch target could not be read");
            }
            // Raw bytes, never a UTF-8 round-trip: a file that is not valid
            // UTF-8 would be corrupted by re-encoding, and an exact-match
            // splice must operate on exactly what is on disk.
            const currentBytes = current.value.bytes;
            const firstAt = currentBytes.indexOf(findBytes);
            if (firstAt < 0) {
              blockExecution(execution);
              return errorJson(
                "stalePreflight",
                "patch anchor no longer present in the target file"
              );
            }
            if (currentBytes.indexOf(findBytes, firstAt + 1) >= 0) {
              blockExecution(execution);
              return errorJson(
                "stalePreflight",
                "patch anchor is not unique in the target file"
              );
            }
            const patched = Buffer.concat([
              currentBytes.subarray(0, firstAt),
              replacementBytes,
              currentBytes.subarray(firstAt + findBytes.length),
            ]);
            // Same revision-guarded primitive a whole-file replace uses, so a
            // concurrent edit between observation and execution still loses.
            const replacedByPatch = await deps.getFileStore().replaceFileExact(
              targetLocator,
              patched,
              targetObservation.revision
            );
            if (replacedByPatch.kind !== "ok") {
              blockExecution(execution);
              return errorJson("stalePreflight", "exact replace failed (revision mismatch or IO)");
            }
            postconditionDigest = sha256OfCanonicalJsonV1({
              revision: replacedByPatch.value.revision,
              sha256: replacedByPatch.value.sha256,
            });
            break;
          }
          case "createDirectory": {
            const preStat = await deps.getFileStore().stat(targetLocator);
            if (preStat.kind !== "ok" || preStat.value.kind !== "missing") {
              blockExecution(execution);
              return errorJson("stalePreflight", "createDirectory target is no longer missing");
            }
            const created = await deps.getFileStore().createDirectory(targetLocator);
            if (created.kind !== "ok") {
              blockExecution(execution);
              return errorJson("stalePreflight", "nonrecursive mkdir failed");
            }
            postconditionDigest = sha256OfCanonicalJsonV1({ kind: "directory" });
            break;
          }
          case "deleteFile": {
            const deleted = await deps.getFileStore().deleteFileExact(
              targetLocator,
              targetObservation.revision
            );
            if (deleted.kind !== "ok") {
              blockExecution(execution);
              return errorJson("stalePreflight", "exact-file unlink failed (revision mismatch or IO)");
            }
            postconditionDigest = sha256OfCanonicalJsonV1({ kind: "missing" });
            break;
          }
          case "deleteEmptyDirectory": {
            const listing = await deps.getFileStore().listDirectoryBounded(
              targetLocator,
              MAX_DIRECTORY_ENTRIES_V1
            );
            if (listing.kind !== "ok" || listing.value.length > 0) {
              blockExecution(execution);
              return errorJson("stalePreflight", "directory is no longer verifiably empty");
            }
            const removed = await deps.getFileStore().deleteEmptyDirectory(targetLocator);
            if (removed.kind !== "ok") {
              blockExecution(execution);
              return errorJson("stalePreflight", "empty-directory rmdir failed");
            }
            postconditionDigest = sha256OfCanonicalJsonV1({ kind: "missing" });
            break;
          }
        }

        const receipt: MutationReceiptV1 = {
          receiptId: allocateHex128IdV1(),
          executionId: sealed.executionId,
          planId: sealed.planId,
          stepId: operation.stepId,
          hostCallId: call.callId,
          operationDigest: computeSealedOperationDigestV1(operation),
          preconditionDigest: sha256OfCanonicalJsonV1({
            kind: targetObservation.kind,
            revision: targetObservation.revision,
            targetObservationId: operation.targetObservationId,
          }),
          postconditionDigest,
          outcome: "applied",
        };
        // Receipts are durable BEFORE the tool result returns (§7.4).
        const persisted = await deps.getFileStore().createFileExclusive(
          runFileLocator(executionId, `receipt-${execution.cursor + 1}-v1.json`),
          Buffer.from(JSON.stringify(receipt, null, 2), "utf8")
        );
        if (persisted.kind !== "ok") {
          // The mutation LANDED; only the receipt failed to persist. This is
          // a post-mutation protocol failure: partialEditBlocked territory.
          execution.state = "partialEditBlocked";
          return errorJson("receiptPersistFailed", "the applied mutation's receipt could not be persisted");
        }
        execution.receipts.push(receipt);
        execution.receiptsByStepId.set(operation.stepId, receipt);
        execution.cursor += 1;
        if (execution.cursor === sealed.script.steps.length) {
          execution.state = "completed";
        }
        return canonicalJsonStringifyV1({
          ok: true,
          receiptId: receipt.receiptId,
          executionId: receipt.executionId,
          planId: receipt.planId,
          stepId: receipt.stepId,
          hostCallId: receipt.hostCallId,
          operationDigest: receipt.operationDigest,
          preconditionDigest: receipt.preconditionDigest,
          postconditionDigest: receipt.postconditionDigest,
          outcome: receipt.outcome,
        });
      };

      return {
        descriptors: editToolDescriptorsV1(),
        async handleToolCall(call) {
          const toolNames = editToolDescriptorsV1().map((descriptor) => descriptor.name);
          if (!toolNames.includes(call.name)) {
            violations.record();
            return canonicalJsonStringifyV1({
              ok: false,
              code: "unknownTool",
              reason: "not a mutation tool",
            });
          }
          return handleMutationCall(call);
        },
        violationCount: () => violations.count(),
      };
    },

    executionOutcome(executionId) {
      const execution = executions.get(executionId);
      if (!execution) {
        return undefined;
      }
      return {
        state: execution.state,
        appliedReceiptIds: execution.receipts.map((receipt) => receipt.receiptId),
      };
    },
  };
}
