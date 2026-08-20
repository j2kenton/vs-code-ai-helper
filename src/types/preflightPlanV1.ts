/**
 * Preflight observation ledger and plan-vs-ledger validation (plan §7.3).
 *
 * The envelope decoder (`aiResultEnvelope.ts`) already strict-decodes a
 * `preflight-plan.v1` document SHAPE — bounded ids, base64 canonicality,
 * digest fields, parent-chain referential integrity against earlier steps.
 * What it cannot check is everything that needs the server-side observation
 * LEDGER: that every precondition references an observation this attempt's
 * read session actually minted, that the observation's path/root/kind/
 * completeness authorize the specific operation, and that each parent-chain
 * link names the exact ancestor it must. That validation lives here.
 *
 * The ledger is IN-MEMORY and PER-ATTEMPT: each fresh provider attempt (or
 * Resume drive) gets an empty ledger, so observations from one attempt can
 * never authorize a plan returned by another. Nothing is persisted during
 * preflight; the accepted plan and its observation records are sealed
 * together by the edit broker (§7.6 step 1).
 */
import { allocateHex128IdV1 } from "./actionCorrelationV1";
import { ActionCorrelationV1 } from "./actionCorrelationV1";
import {
  PreflightOperationV1,
  PreflightPlanCompletedV1,
} from "./aiResultEnvelope";
import { sha256OfCanonicalJsonV1 } from "../services/canonicalJsonV1";

/** §7.3's exact observation shape, as echoed to the model in tool results. */
export interface ObservationRefV1 {
  readonly observationId: string;
  readonly callId: string;
  readonly rootId: string;
  readonly relativePath: string;
  readonly kind: "missing" | "file" | "directory";
  readonly revision: string;
  readonly contentSha256?: string;
  readonly complete: boolean;
}

/** Which read tool produced an observation — only exact-path reads authorize mutations (§7.2). */
export type ObservationSourceV1 =
  | "stat"
  | "readFile"
  | "readDirectory"
  | "findFiles"
  | "textSearch";

export interface ObservationRecordV1 extends ObservationRefV1 {
  readonly source: ObservationSourceV1;
  /**
   * Entry names of a COMPLETE `readDirectory` observation — the §7.3
   * emptiness proof for `deleteEmptyDirectory` and the §7.7 re-verification
   * baseline. Never part of the ledger digest (the sorted listing is already
   * folded into `revision`).
   */
  readonly entryNames?: readonly string[];
}

export interface ObservationLedgerV1 {
  /** Mint a server-issued observation id for one tool response. */
  mint(record: Omit<ObservationRecordV1, "observationId">): ObservationRecordV1;
  get(observationId: string): ObservationRecordV1 | undefined;
  records(): readonly ObservationRecordV1[];
  /** SHA-256 over the ordered canonical records (minus entry bodies). */
  digest(): string;
}

export function createObservationLedgerV1(): ObservationLedgerV1 {
  const ordered: ObservationRecordV1[] = [];
  const byId = new Map<string, ObservationRecordV1>();
  return {
    mint(record) {
      const minted: ObservationRecordV1 = { ...record, observationId: allocateHex128IdV1() };
      ordered.push(minted);
      byId.set(minted.observationId, minted);
      return minted;
    },
    get(observationId) {
      return byId.get(observationId);
    },
    records() {
      return ordered;
    },
    digest() {
      return sha256OfCanonicalJsonV1(
        ordered.map((record) => ({
          observationId: record.observationId,
          callId: record.callId,
          rootId: record.rootId,
          relativePath: record.relativePath,
          kind: record.kind,
          revision: record.revision,
          complete: record.complete,
          source: record.source,
          ...(record.contentSha256 !== undefined ? { contentSha256: record.contentSha256 } : {}),
        }))
      );
    },
  };
}

/** Sources allowed to authorize a mutation precondition (§7.2). */
const AUTHORIZING_SOURCES_V1: ReadonlySet<ObservationSourceV1> = new Set([
  "stat",
  "readFile",
  "readDirectory",
]);

export type PreflightPlanValidationResultV1 =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: PreflightPlanValidationCodeV1; readonly reason: string };

export type PreflightPlanValidationCodeV1 =
  | "rootMismatch"
  | "unknownObservation"
  | "observationTargetMismatch"
  | "nonAuthorizingSource"
  | "targetStateMismatch"
  | "duplicateTarget"
  | "emptinessUnproven"
  | "parentChainMismatch";

function failure(
  code: PreflightPlanValidationCodeV1,
  reason: string
): PreflightPlanValidationResultV1 {
  return { ok: false, code, reason };
}

// A NUL byte can never appear in a rootId or a relativePath, so it is a safe
// join separator for a composite map key. Built via fromCharCode rather than
// an inline escape literal in source, which is fragile to round-trip through
// text tooling.
const TARGET_KEY_SEPARATOR_V1 = String.fromCharCode(0);

function targetKeyOfV1(rootId: string, relativePath: string): string {
  return rootId + TARGET_KEY_SEPARATOR_V1 + relativePath;
}

/** Every ancestor between the root (exclusive) and the immediate parent (inclusive), root-to-parent order. */
export function ancestorPathsOfV1(relativePath: string): string[] {
  const segments = relativePath.split("/");
  segments.pop();
  const ancestors: string[] = [];
  for (let i = 1; i <= segments.length; i++) {
    ancestors.push(segments.slice(0, i).join("/"));
  }
  return ancestors;
}

/**
 * Reverse lookup: an ancestor directory that already exists is resolved
 * HOST-SIDE from this attempt's ledger, by exact path — the model no longer
 * hand-lists it (item 20, 2026-08-20). Only a directory this same plan is
 * about to CREATE cannot be found here, and must instead carry an explicit
 * `createdByStep` link.
 */
function findAuthorizingDirectoryObservationV1(
  ledger: ObservationLedgerV1,
  rootId: string,
  relativePath: string
): ObservationRecordV1 | undefined {
  return ledger
    .records()
    .find(
      (record) =>
        record.rootId === rootId &&
        record.relativePath === relativePath &&
        record.kind === "directory" &&
        AUTHORIZING_SOURCES_V1.has(record.source)
    );
}

/**
 * Validate one strictly-decoded plan against this attempt's ledger (§7.3).
 * `expectedRootId` is the single registered workspace root the preflight
 * session exposed — a plan may not name any other root.
 */
export function validatePreflightPlanAgainstLedgerV1(
  plan: PreflightPlanCompletedV1,
  ledger: ObservationLedgerV1,
  expectedRootId: string
): PreflightPlanValidationResultV1 {
  const stepsById = new Map<string, PreflightOperationV1>();
  const seenTargets = new Set<string>();

  // A target may be touched by more than one operation ONLY when every
  // operation sharing it is a `patchFile` (item 17) — a chained sequence of
  // region edits whose later touches re-verify and write against the
  // PREVIOUS patch's own post-write revision at execution time
  // (editBrokerToolSessionHandlerV1), not the sealed observation. Any other
  // repeat (a second whole-file write, or a mix) stays rejected: those
  // primitives have no revision to chain from after the first write lands.
  const operationsByTargetKey = new Map<string, PreflightOperationV1[]>();
  for (const eachOperation of plan.operations) {
    const key = targetKeyOfV1(eachOperation.rootId, eachOperation.relativePath);
    const group = operationsByTargetKey.get(key);
    if (group) {
      group.push(eachOperation);
    } else {
      operationsByTargetKey.set(key, [eachOperation]);
    }
  }

  for (const [index, operation] of plan.operations.entries()) {
    const where = `operation ${index} (${operation.stepId})`;

    if (operation.rootId !== expectedRootId) {
      return failure("rootMismatch", `${where} names root ${JSON.stringify(operation.rootId)}`);
    }

    const targetKey = targetKeyOfV1(operation.rootId, operation.relativePath);
    if (seenTargets.has(targetKey)) {
      const group = operationsByTargetKey.get(targetKey) ?? [];
      const allPatch = group.every((candidate) => candidate.kind === "patchFile");
      if (!allPatch) {
        return failure(
          "duplicateTarget",
          `${where} targets ${operation.relativePath}, which an earlier operation already targets. ` +
            "Each operation carries the revision observed during planning, so the second write " +
            "would use a revision the first one already replaced — combine them into one " +
            "operation, or leave the rest for the next round. (Two or more patchFile operations " +
            "on the same file ARE allowed and chain automatically; this mix is not.)"
        );
      }
    } else {
      seenTargets.add(targetKey);
    }

    const target = ledger.get(operation.targetObservationId);
    if (!target) {
      return failure("unknownObservation", `${where} references an unknown target observation`);
    }
    if (target.rootId !== operation.rootId || target.relativePath !== operation.relativePath) {
      return failure(
        "observationTargetMismatch",
        `${where}'s target observation describes ${target.relativePath}, not ${operation.relativePath}`
      );
    }
    if (!AUTHORIZING_SOURCES_V1.has(target.source)) {
      return failure(
        "nonAuthorizingSource",
        `${where}'s target observation came from ${target.source} — discovery results cannot authorize mutations (§7.2)`
      );
    }

    switch (operation.kind) {
      case "createFile":
      case "createDirectory":
        if (target.kind !== "missing") {
          return failure(
            "targetStateMismatch",
            `${where} creates over an observed ${target.kind} — a missing target requires an exact missing observation`
          );
        }
        break;
      case "replaceFile":
      case "patchFile":
      case "deleteFile":
        if (target.kind !== "file") {
          return failure("targetStateMismatch", `${where} requires an observed file, found ${target.kind}`);
        }
        break;
      case "deleteEmptyDirectory": {
        if (target.kind !== "directory") {
          return failure("targetStateMismatch", `${where} requires an observed directory, found ${target.kind}`);
        }
        if (target.source !== "readDirectory" || !target.complete || target.entryNames === undefined) {
          return failure(
            "emptinessUnproven",
            `${where} requires a COMPLETE exact-path directory listing proving emptiness (§7.3)`
          );
        }
        if (target.entryNames.length > 0) {
          return failure("emptinessUnproven", `${where}'s observed directory is not empty`);
        }
        break;
      }
    }

    // A parent chain answers ONE question: will this operation's parent
    // directory exist when the step runs? That is only ever in doubt for a
    // CREATE — the parent may be missing, or be created by an earlier step in
    // this same plan (`createdByStep`), which is what makes the chain
    // meaningful there.
    //
    // For an operation on an EXISTING target it is pure redundancy: the target
    // observation above already proved this exact path is a `file` (or, for
    // deleteEmptyDirectory, a provably empty `directory`), and a file cannot
    // exist without every one of its ancestors. Demanding the chain anyway
    // cost a model one `ensemble_stat` per directory level per file, all of it
    // re-sent on every later tool round — and cost a whole round outright when
    // it miscounted the depth (2026-08-19: "parent chain has 3 link(s); 4
    // ancestor(s) required" on a four-level path).
    //
    // Deliberately NOT relaxed for creates: there the chain is load-bearing.
    const requiresParentChain =
      operation.kind === "createFile" || operation.kind === "createDirectory";
    // Not merely "ignored": an ignored link still reaches the broker, which
    // re-verifies EVERY ancestor at execution time regardless of kind
    // (editBrokerToolSessionHandlerV1, §7.7 (4)). A link this layer skipped
    // would therefore pass preflight, get sealed, and then block execution as
    // `stalePreflight` — a validated plan failing after the point of no
    // return, which is strictly worse than rejecting it here. The decoder
    // normalizes wire input to an empty chain for these kinds, so reaching
    // this branch means an operation was constructed by some other path.
    if (!requiresParentChain && operation.parentChain.length > 0) {
      return failure(
        "parentChainMismatch",
        `${where} is a ${operation.kind} and must carry an empty parentChain — ` +
          "its target observation already proves every ancestor exists"
      );
    }

    if (requiresParentChain) {
      const ancestors = ancestorPathsOfV1(operation.relativePath);

      // Ancestors that already exist are resolved HOST-SIDE from the ledger,
      // by exact path — the model supplies nothing for them (item 20). Only
      // an ancestor THIS plan is about to create cannot be found this way,
      // and needs an explicit `createdByStep` link.
      const unresolvedAncestors = ancestors.filter(
        (ancestorPath) => !findAuthorizingDirectoryObservationV1(ledger, operation.rootId, ancestorPath)
      );

      const suppliedStepPathsV1 = new Set<string>();
      for (const link of operation.parentChain) {
        if (link.kind !== "createdByStep") {
          return failure(
            "parentChainMismatch",
            `${where}'s parent chain may only carry createdByStep links now — an ancestor that ` +
              "already exists is resolved automatically from the observation ledger and must not be listed"
          );
        }
        const earlier = stepsById.get(link.stepId);
        if (!earlier || earlier.kind !== "createDirectory") {
          return failure("parentChainMismatch", `${where}'s parent link references a non-createDirectory step`);
        }
        if (earlier.rootId !== operation.rootId) {
          return failure("parentChainMismatch", `${where}'s parent link step targets a different root`);
        }
        suppliedStepPathsV1.add(earlier.relativePath);
      }

      for (const ancestorPath of unresolvedAncestors) {
        if (!suppliedStepPathsV1.has(ancestorPath)) {
          return failure(
            "parentChainMismatch",
            `${where} is missing a createdByStep link for ancestor ${ancestorPath} — it does not yet ` +
              "exist on disk and must be created by an earlier step in this same plan"
          );
        }
      }
    }

    stepsById.set(operation.stepId, operation);
  }

  return { ok: true };
}

/** Canonical digest of the plan document itself (every op's ordered parent chain included). */
export function computePreflightPlanDigestV1(plan: PreflightPlanCompletedV1): string {
  return sha256OfCanonicalJsonV1({
    contentType: plan.contentType,
    schemaVersion: plan.schemaVersion,
    requestDigest: plan.requestDigest,
    rootBindingId: plan.rootBindingId,
    operations: plan.operations.map((operation) => ({
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
      // Patch payloads are covered by the plan digest exactly like whole-file
      // content. This list is a WHITELIST: a field omitted here is sealed by
      // nothing, so a tampered find/replacement would verify clean.
      ...(operation.findBase64 !== undefined ? { findBase64: operation.findBase64 } : {}),
      ...(operation.replacementBase64 !== undefined
        ? { replacementBase64: operation.replacementBase64 }
        : {}),
    })),
  });
}

/** `planId` binds the plan digest, the observation-ledger digest, and the correlation tuple (§7.3). */
export function computePreflightPlanIdV1(
  planDigest: string,
  ledgerDigest: string,
  correlation: ActionCorrelationV1
): string {
  return sha256OfCanonicalJsonV1({
    planDigest,
    ledgerDigest,
    correlation: {
      actionKey: correlation.actionKey,
      operationId: correlation.operationId,
      attemptId: correlation.attemptId,
      taskBindingId: correlation.taskBindingId,
      chatDocumentId: correlation.chatDocumentId,
    },
  });
}
