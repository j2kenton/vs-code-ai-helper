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
  ParentChainLinkV1,
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

/** Every ancestor between the root (exclusive) and the immediate parent (inclusive), root-to-parent order. */
function ancestorPathsOf(relativePath: string): string[] {
  const segments = relativePath.split("/");
  segments.pop();
  const ancestors: string[] = [];
  for (let i = 1; i <= segments.length; i++) {
    ancestors.push(segments.slice(0, i).join("/"));
  }
  return ancestors;
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

  for (const [index, operation] of plan.operations.entries()) {
    const where = `operation ${index} (${operation.stepId})`;

    if (operation.rootId !== expectedRootId) {
      return failure("rootMismatch", `${where} names root ${JSON.stringify(operation.rootId)}`);
    }

    const targetKey = `${operation.rootId}\u0000${operation.relativePath}`;
    if (seenTargets.has(targetKey)) {
      return failure(
        "duplicateTarget",
        `${where} targets ${operation.relativePath}, which an earlier operation already targets. ` +
          "Each operation carries the revision observed during planning, so the second write " +
          "would use a revision the first one already replaced — combine them into one " +
          "operation, or leave the rest for the next round."
      );
    }
    seenTargets.add(targetKey);

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
    // this same plan (`createdByStep`), which is what makes the ordered chain
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
    // re-verifies EVERY link at execution time regardless of kind
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
    const ancestors = requiresParentChain ? ancestorPathsOf(operation.relativePath) : [];
    if (requiresParentChain && operation.parentChain.length !== ancestors.length) {
      return failure(
        "parentChainMismatch",
        `${where}'s parent chain has ${operation.parentChain.length} link(s); ${ancestors.length} ancestor(s) required`
      );
    }
    for (let i = 0; i < ancestors.length; i++) {
      const ancestorPath = ancestors[i]!;
      const link: ParentChainLinkV1 = operation.parentChain[i]!;
      if (link.kind === "observed") {
        const observed = ledger.get(link.observationId);
        if (!observed) {
          return failure("parentChainMismatch", `${where}'s parent link ${i} references an unknown observation`);
        }
        // A parent link's job is to prove ONE thing: this ancestor exists and
        // is a directory. `stat` proves exactly that, and it is already in
        // AUTHORIZING_SOURCES_V1 — trusted to authorize a mutation on the
        // operation's own TARGET, a far stronger claim. Requiring a COMPLETE
        // `readDirectory` here as well was therefore inconsistent, and
        // expensive in a way that mattered: `apps/server/lib/competition/x.ts`
        // has four ancestors, so a plan touching six such files demanded ~24
        // full directory listings (up to MAX_DIRECTORY_ENTRIES_V1 = 2048
        // entries each), every one re-sent on every later tool round, to prove
        // nothing a stat had not already proven. Copilot failed a whole round
        // on it (2026-08-18, `parentChainMismatch` on `apps`).
        //
        // What is still enforced, and is the actual safety property: the
        // observation must come from this attempt's ledger, name the EXACT
        // ancestor path under the same root, be a directory, and come from an
        // authorizing source — so a `findFiles`/`textSearch` discovery result
        // still cannot stand in for a parent proof (§7.2). Completeness
        // remains required where it carries real meaning:
        // `deleteEmptyDirectory` above, which needs a full listing to prove
        // emptiness.
        if (
          observed.rootId !== operation.rootId ||
          observed.relativePath !== ancestorPath ||
          observed.kind !== "directory" ||
          !AUTHORIZING_SOURCES_V1.has(observed.source)
        ) {
          return failure(
            "parentChainMismatch",
            `${where}'s parent link ${i} must be an exact-path directory observation of ${ancestorPath} ` +
              `(from stat or readDirectory, not a discovery result)`
          );
        }
      } else {
        // Referential integrity (earlier + createDirectory) was already
        // enforced by the envelope decoder; the ledger layer must pin the
        // exact TARGET of that earlier step to this ancestor.
        const earlier = stepsById.get(link.stepId);
        if (!earlier || earlier.kind !== "createDirectory") {
          return failure("parentChainMismatch", `${where}'s parent link ${i} references a non-createDirectory step`);
        }
        if (earlier.rootId !== operation.rootId || earlier.relativePath !== ancestorPath) {
          return failure(
            "parentChainMismatch",
            `${where}'s parent link ${i} step creates ${earlier.relativePath}, not the required ancestor ${ancestorPath}`
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
