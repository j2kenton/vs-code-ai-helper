/**
 * Coverage for the §7.3 preflight contract layer (preflightPlanV1.ts): the
 * per-attempt observation ledger, plan-vs-ledger validation (the checks the
 * envelope decoder cannot perform without server state), and the
 * planId/planDigest/ledgerDigest computations.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createObservationLedgerV1,
  computePreflightPlanDigestV1,
  computePreflightPlanIdV1,
  ObservationLedgerV1,
  validatePreflightPlanAgainstLedgerV1,
} from "../types/preflightPlanV1";
import {
  ParentChainLinkV1,
  PreflightOperationV1,
  PreflightPlanCompletedV1,
} from "../types/aiResultEnvelope";
import { ActionCorrelationV1, allocateHex128IdV1 } from "../types/actionCorrelationV1";

const ROOT = "root-workspace";

function correlation(): ActionCorrelationV1 {
  return {
    actionKey: "implementation.v1",
    operationId: allocateHex128IdV1(),
    attemptId: allocateHex128IdV1(),
    taskBindingId: "binding",
    chatDocumentId: "chat-doc",
  };
}

function mintMissing(ledger: ObservationLedgerV1, relativePath: string): string {
  return ledger.mint({
    callId: "call-1",
    rootId: ROOT,
    relativePath,
    kind: "missing",
    revision: "missing",
    complete: true,
    source: "stat",
  }).observationId;
}

function mintFile(ledger: ObservationLedgerV1, relativePath: string): string {
  return ledger.mint({
    callId: "call-2",
    rootId: ROOT,
    relativePath,
    kind: "file",
    revision: "v1:10:1:2",
    contentSha256: "ab".repeat(32),
    complete: true,
    source: "readFile",
  }).observationId;
}

function mintDirectory(
  ledger: ObservationLedgerV1,
  relativePath: string,
  entryNames: readonly string[],
  source: "readDirectory" | "stat" = "readDirectory"
): string {
  return ledger.mint({
    callId: "call-3",
    rootId: ROOT,
    relativePath,
    kind: "directory",
    revision: "dir:abc",
    complete: true,
    source,
    ...(source === "readDirectory" ? { entryNames } : {}),
  }).observationId;
}

function op(partial: Partial<PreflightOperationV1> & Pick<PreflightOperationV1, "stepId" | "kind" | "relativePath" | "targetObservationId">): PreflightOperationV1 {
  return {
    rootId: ROOT,
    parentChain: [] as readonly ParentChainLinkV1[],
    ...partial,
  };
}

function plan(operations: readonly PreflightOperationV1[]): PreflightPlanCompletedV1 {
  return {
    contentType: "preflight-plan.v1",
    schemaVersion: 1,
    requestDigest: "cd".repeat(32),
    rootBindingId: "ef".repeat(32),
    operations,
  };
}

void describe("editPreflightContractV1 — parent-chain proofs", () => {
  // The chain answers one question: will the parent exist when the step runs?
  // That is only in doubt for a CREATE, so these all use createFile — the kind
  // the chain is load-bearing for. Operations on an existing target no longer
  // carry one (an observed file proves its own ancestors). Since item 20
  // (2026-08-20), an ancestor that already exists is resolved HOST-SIDE from
  // the ledger by path — the model supplies nothing for it, and a
  // `parentChain` entry is required ONLY for an ancestor this same plan is
  // about to create.
  void it("resolves existing ancestors from the ledger with an empty parentChain", () => {
    const ledger = createObservationLedgerV1();
    const missing = mintMissing(ledger, "apps/server/new.ts");
    mintDirectory(ledger, "apps", [], "stat");
    mintDirectory(ledger, "apps/server", [], "stat");

    const result = validatePreflightPlanAgainstLedgerV1(
      plan([
        op({
          stepId: "s1",
          kind: "createFile",
          relativePath: "apps/server/new.ts",
          targetObservationId: missing,
          parentChain: [],
          contentBase64: "aGk=",
        }),
      ]),
      ledger,
      ROOT
    );
    assert.deepEqual(result, { ok: true });
  });

  void it("still refuses when an ancestor is only a discovery observation (not host-resolvable, no createdByStep claim)", () => {
    // §7.2: a findFiles/textSearch result can never authorize anything. It is
    // not in AUTHORIZING_SOURCES_V1, so the host-side lookup cannot resolve
    // it — and nothing creates it either, so the plan is rejected.
    const ledger = createObservationLedgerV1();
    const missing = mintMissing(ledger, "apps/new.ts");
    ledger.mint({
      callId: "call-discovery",
      rootId: ROOT,
      relativePath: "apps",
      kind: "directory",
      revision: "dir",
      complete: true,
      source: "findFiles",
    });

    const result = validatePreflightPlanAgainstLedgerV1(
      plan([
        op({
          stepId: "s1",
          kind: "createFile",
          relativePath: "apps/new.ts",
          targetObservationId: missing,
          parentChain: [],
          contentBase64: "aGk=",
        }),
      ]),
      ledger,
      ROOT
    );
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, "parentChainMismatch");
  });

  void it("still refuses an ancestor with neither an authorizing observation nor a createdByStep claim", () => {
    const ledger = createObservationLedgerV1();
    const missing = mintMissing(ledger, "apps/new.ts"); // "apps" itself never observed

    const result = validatePreflightPlanAgainstLedgerV1(
      plan([
        op({
          stepId: "s1",
          kind: "createFile",
          relativePath: "apps/new.ts",
          targetObservationId: missing,
          parentChain: [],
          contentBase64: "aGk=",
        }),
      ]),
      ledger,
      ROOT
    );
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, "parentChainMismatch");
  });

  void it("refuses an observed-kind parentChain link now that ancestors are host-resolved", () => {
    const ledger = createObservationLedgerV1();
    const missing = mintMissing(ledger, "apps/new.ts");
    const apps = mintDirectory(ledger, "apps", [], "stat");

    const result = validatePreflightPlanAgainstLedgerV1(
      plan([
        op({
          stepId: "s1",
          kind: "createFile",
          relativePath: "apps/new.ts",
          targetObservationId: missing,
          parentChain: [{ kind: "observed", observationId: apps }],
          contentBase64: "aGk=",
        }),
      ]),
      ledger,
      ROOT
    );
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, "parentChainMismatch");
  });

  void it("resolves a step-created ancestor via createdByStep without restating ancestors that already exist", () => {
    const ledger = createObservationLedgerV1();
    mintDirectory(ledger, "apps", [], "stat"); // exists already — resolved automatically
    const missingDir = mintMissing(ledger, "apps/generated");
    const missingFile = mintMissing(ledger, "apps/generated/out.ts");

    const result = validatePreflightPlanAgainstLedgerV1(
      plan([
        op({
          stepId: "s1",
          kind: "createDirectory",
          relativePath: "apps/generated",
          targetObservationId: missingDir,
          parentChain: [],
        }),
        op({
          stepId: "s2",
          kind: "createFile",
          relativePath: "apps/generated/out.ts",
          targetObservationId: missingFile,
          parentChain: [{ kind: "createdByStep", stepId: "s1" }],
          contentBase64: "aGk=",
        }),
      ]),
      ledger,
      ROOT
    );
    assert.deepEqual(result, { ok: true });
  });

  void it("still refuses a createdByStep link naming the wrong ancestor path", () => {
    const ledger = createObservationLedgerV1();
    mintDirectory(ledger, "apps", [], "stat"); // "apps" resolves automatically
    const missingOther = mintMissing(ledger, "apps/other");
    const missing = mintMissing(ledger, "apps/server/new.ts");

    const result = validatePreflightPlanAgainstLedgerV1(
      plan([
        op({
          stepId: "wrong-dir",
          kind: "createDirectory",
          relativePath: "apps/other",
          targetObservationId: missingOther,
          parentChain: [],
        }),
        op({
          stepId: "s1",
          kind: "createFile",
          relativePath: "apps/server/new.ts",
          targetObservationId: missing,
          // "apps/server" does not exist and nothing creates it — the only
          // supplied link targets a different ancestor.
          parentChain: [{ kind: "createdByStep", stepId: "wrong-dir" }],
          contentBase64: "aGk=",
        }),
      ]),
      ledger,
      ROOT
    );
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, "parentChainMismatch");
  });

  void it("does not require a parent chain for an operation on an existing file", () => {
    // The target observation already proves every ancestor exists — a file
    // cannot exist without its directories. Demanding the chain anyway cost a
    // stat per directory level per file, and cost a whole round when the model
    // miscounted the depth (2026-08-19).
    const ledger = createObservationLedgerV1();
    const file = mintFile(ledger, "apps/server/lib/competition/split.ts");

    const result = validatePreflightPlanAgainstLedgerV1(
      plan([
        op({
          stepId: "s1",
          kind: "patchFile",
          relativePath: "apps/server/lib/competition/split.ts",
          targetObservationId: file,
          parentChain: [],
          findText: "a",
          replacementText: "b",
        }),
      ]),
      ledger,
      ROOT
    );
    assert.deepEqual(result, { ok: true });
  });
});

void describe("editPreflightContractV1 — patchFile", () => {
  void it("accepts a patch whose target is an observed file", () => {
    const ledger = createObservationLedgerV1();
    const file = mintFile(ledger, "src/old.ts");
    mintDirectory(ledger, "src", ["old.ts"]);

    const result = validatePreflightPlanAgainstLedgerV1(
      plan([
        op({
          stepId: "s1",
          kind: "patchFile",
          relativePath: "src/old.ts",
          targetObservationId: file,
          parentChain: [],
          findBase64: "aGk=",
          replacementBase64: "Ynll",
        }),
      ]),
      ledger,
      ROOT
    );
    assert.deepEqual(result, { ok: true });
  });

  void it("refuses a patch aimed at a missing target", () => {
    // A patch edits bytes that must already exist. Sharing replaceFile's
    // observed-file precondition is what stops a patch being used to
    // conjure a file whose prior contents were never observed.
    const ledger = createObservationLedgerV1();
    const missing = mintMissing(ledger, "src/new.ts");
    mintDirectory(ledger, "src", []);

    const result = validatePreflightPlanAgainstLedgerV1(
      plan([
        op({
          stepId: "s1",
          kind: "patchFile",
          relativePath: "src/new.ts",
          targetObservationId: missing,
          parentChain: [],
          findBase64: "aGk=",
          replacementBase64: "Ynll",
        }),
      ]),
      ledger,
      ROOT
    );
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, "targetStateMismatch");
  });

  void it("seals the patch payloads into the plan digest", () => {
    // computePreflightPlanDigestV1 whitelists the fields it hashes. A payload
    // omitted from that list would sit OUTSIDE the seal entirely, so a
    // tampered find/replacement would verify clean — the digest must move
    // when either payload moves.
    const ledger = createObservationLedgerV1();
    const file = mintFile(ledger, "src/old.ts");
    const base = op({
      stepId: "s1",
      kind: "patchFile",
      relativePath: "src/old.ts",
      targetObservationId: file,
      findBase64: "aGk=",
      replacementBase64: "Ynll",
    });
    const original = computePreflightPlanDigestV1(plan([base]));

    const tamperedFind = computePreflightPlanDigestV1(
      plan([{ ...base, findBase64: "aGo=" }])
    );
    assert.notEqual(original, tamperedFind, "findBase64 must be covered by the plan digest");

    const tamperedReplacement = computePreflightPlanDigestV1(
      plan([{ ...base, replacementBase64: "Ynlm" }])
    );
    assert.notEqual(
      original,
      tamperedReplacement,
      "replacementBase64 must be covered by the plan digest"
    );
  });
});

void describe("editPreflightContractV1 — plan-vs-ledger validation", () => {
  void it("accepts a well-formed create+replace plan whose preconditions come from exact-path reads", () => {
    const ledger = createObservationLedgerV1();
    const missing = mintMissing(ledger, "src/new.ts");
    const file = mintFile(ledger, "src/old.ts");
    mintDirectory(ledger, "src", ["old.ts"]);

    const result = validatePreflightPlanAgainstLedgerV1(
      plan([
        op({
          stepId: "s1",
          kind: "createFile",
          relativePath: "src/new.ts",
          targetObservationId: missing,
          // "src" already exists and is resolved host-side from the ledger.
          parentChain: [],
          contentBase64: "aGk=",
          decodedByteLength: 2,
          contentSha256: "12".repeat(32),
        }),
        op({
          stepId: "s2",
          kind: "replaceFile",
          relativePath: "src/old.ts",
          targetObservationId: file,
          parentChain: [],
          contentBase64: "aGk=",
          decodedByteLength: 2,
          contentSha256: "34".repeat(32),
        }),
      ]),
      ledger,
      ROOT
    );
    assert.deepEqual(result, { ok: true });
  });

  void it("rejects a discovery-sourced precondition (findFiles cannot authorize mutations)", () => {
    const ledger = createObservationLedgerV1();
    const discovered = ledger.mint({
      callId: "call-4",
      rootId: ROOT,
      relativePath: "src/old.ts",
      kind: "file",
      revision: "v1:10:1:2",
      complete: false,
      source: "findFiles",
    }).observationId;
    const result = validatePreflightPlanAgainstLedgerV1(
      plan([op({ stepId: "s1", kind: "deleteFile", relativePath: "src/old.ts", targetObservationId: discovered })]),
      ledger,
      ROOT
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "nonAuthorizingSource");
    }
  });

  void it("rejects unknown observations, mismatched targets, wrong roots, and duplicate targets", () => {
    const ledger = createObservationLedgerV1();
    const file = mintFile(ledger, "a.ts");

    const unknown = validatePreflightPlanAgainstLedgerV1(
      plan([op({ stepId: "s1", kind: "deleteFile", relativePath: "a.ts", targetObservationId: allocateHex128IdV1() })]),
      ledger,
      ROOT
    );
    assert.equal(!unknown.ok && unknown.code, "unknownObservation");

    const mismatched = validatePreflightPlanAgainstLedgerV1(
      plan([op({ stepId: "s1", kind: "deleteFile", relativePath: "b.ts", targetObservationId: file })]),
      ledger,
      ROOT
    );
    assert.equal(!mismatched.ok && mismatched.code, "observationTargetMismatch");

    const wrongRoot = validatePreflightPlanAgainstLedgerV1(
      plan([
        { ...op({ stepId: "s1", kind: "deleteFile", relativePath: "a.ts", targetObservationId: file }), rootId: "other" },
      ]),
      ledger,
      ROOT
    );
    assert.equal(!wrongRoot.ok && wrongRoot.code, "rootMismatch");

    const duplicate = validatePreflightPlanAgainstLedgerV1(
      plan([
        op({ stepId: "s1", kind: "deleteFile", relativePath: "a.ts", targetObservationId: file }),
        op({ stepId: "s2", kind: "deleteFile", relativePath: "a.ts", targetObservationId: file }),
      ]),
      ledger,
      ROOT
    );
    assert.equal(!duplicate.ok && duplicate.code, "duplicateTarget");
  });

  void it("allows two or more patchFile operations on the same target (item 17)", () => {
    const ledger = createObservationLedgerV1();
    const file = mintFile(ledger, "a.ts");

    const result = validatePreflightPlanAgainstLedgerV1(
      plan([
        op({
          stepId: "s1",
          kind: "patchFile",
          relativePath: "a.ts",
          targetObservationId: file,
          findBase64: "aGk=",
          replacementBase64: "Ynll",
        }),
        op({
          stepId: "s2",
          kind: "patchFile",
          relativePath: "a.ts",
          targetObservationId: file,
          findBase64: "Ynll",
          replacementBase64: "Ynl6",
        }),
        op({
          stepId: "s3",
          kind: "patchFile",
          relativePath: "a.ts",
          targetObservationId: file,
          findBase64: "Ynl6",
          replacementBase64: "eno=",
        }),
      ]),
      ledger,
      ROOT
    );
    assert.deepEqual(result, { ok: true });
  });

  void it("still rejects a duplicate target when the operations mix patchFile with any other kind", () => {
    const ledger = createObservationLedgerV1();
    const file = mintFile(ledger, "a.ts");

    const patchThenReplace = validatePreflightPlanAgainstLedgerV1(
      plan([
        op({
          stepId: "s1",
          kind: "patchFile",
          relativePath: "a.ts",
          targetObservationId: file,
          findBase64: "aGk=",
          replacementBase64: "Ynll",
        }),
        op({
          stepId: "s2",
          kind: "replaceFile",
          relativePath: "a.ts",
          targetObservationId: file,
          contentBase64: "Ynll",
          decodedByteLength: 3,
          contentSha256: "12".repeat(32),
        }),
      ]),
      ledger,
      ROOT
    );
    assert.equal(!patchThenReplace.ok && patchThenReplace.code, "duplicateTarget");

    const patchThenDelete = validatePreflightPlanAgainstLedgerV1(
      plan([
        op({
          stepId: "s1",
          kind: "patchFile",
          relativePath: "a.ts",
          targetObservationId: file,
          findBase64: "aGk=",
          replacementBase64: "Ynll",
        }),
        op({ stepId: "s2", kind: "deleteFile", relativePath: "a.ts", targetObservationId: file }),
      ]),
      ledger,
      ROOT
    );
    assert.equal(!patchThenDelete.ok && patchThenDelete.code, "duplicateTarget");
  });

  void it("still rejects two whole-file writes on one target — the second would silently discard the first", () => {
    // The safety half of workflow-6 manual-confirm line 98. Item 17 relaxed
    // `duplicateTarget` so several `patchFile` operations may chain on one
    // path, each re-verified against the previous one's post-write revision.
    // Whole-file writes have no such revision to chain from: the second one
    // carries the revision observed during PLANNING, which the first write
    // already replaced, and applying it anyway would overwrite the first
    // edit with content that never saw it. That is silent data loss, not a
    // visible failure, so it is the one case in this relaxation where a
    // regression costs work rather than a round.
    //
    // Pinned here rather than probed through a model: no prompt reliably
    // makes a model emit two whole-file writes for one path, so the only
    // durable guard is this assertion.
    const ledger = createObservationLedgerV1();
    const file = mintFile(ledger, "a.ts");

    const replaceTwice = validatePreflightPlanAgainstLedgerV1(
      plan([
        op({
          stepId: "s1",
          kind: "replaceFile",
          relativePath: "a.ts",
          targetObservationId: file,
          contentBase64: "Ynll",
          decodedByteLength: 3,
          contentSha256: "12".repeat(32),
        }),
        op({
          stepId: "s2",
          kind: "replaceFile",
          relativePath: "a.ts",
          targetObservationId: file,
          contentBase64: "eno=",
          decodedByteLength: 3,
          contentSha256: "34".repeat(32),
        }),
      ]),
      ledger,
      ROOT
    );
    assert.equal(!replaceTwice.ok && replaceTwice.code, "duplicateTarget");

    // Same reasoning for repeated creates: the second would either clobber
    // the first or act on a path its `missing` observation no longer
    // describes.
    const missing = mintMissing(ledger, "new.ts");
    const createTwice = validatePreflightPlanAgainstLedgerV1(
      plan([
        op({
          stepId: "s1",
          kind: "createFile",
          relativePath: "new.ts",
          targetObservationId: missing,
          contentBase64: "Ynll",
          decodedByteLength: 3,
          contentSha256: "12".repeat(32),
        }),
        op({
          stepId: "s2",
          kind: "createFile",
          relativePath: "new.ts",
          targetObservationId: missing,
          contentBase64: "eno=",
          decodedByteLength: 3,
          contentSha256: "34".repeat(32),
        }),
      ]),
      ledger,
      ROOT
    );
    assert.equal(!createTwice.ok && createTwice.code, "duplicateTarget");
  });

  void it("requires kind-appropriate target states (create over missing, replace/delete over file)", () => {
    const ledger = createObservationLedgerV1();
    const file = mintFile(ledger, "a.ts");
    const result = validatePreflightPlanAgainstLedgerV1(
      plan([
        op({
          stepId: "s1",
          kind: "createFile",
          relativePath: "a.ts",
          targetObservationId: file,
          contentBase64: "aGk=",
          decodedByteLength: 2,
          contentSha256: "12".repeat(32),
        }),
      ]),
      ledger,
      ROOT
    );
    assert.equal(!result.ok && result.code, "targetStateMismatch");
  });

  void it("requires a COMPLETE readDirectory emptiness proof for deleteEmptyDirectory — a stat observation is not enough", () => {
    const ledger = createObservationLedgerV1();
    const statDir = mintDirectory(ledger, "empty", [], "stat");
    const rejected = validatePreflightPlanAgainstLedgerV1(
      plan([op({ stepId: "s1", kind: "deleteEmptyDirectory", relativePath: "empty", targetObservationId: statDir })]),
      ledger,
      ROOT
    );
    assert.equal(!rejected.ok && rejected.code, "emptinessUnproven");

    const listedEmpty = mintDirectory(ledger, "empty", []);
    const accepted = validatePreflightPlanAgainstLedgerV1(
      plan([op({ stepId: "s1", kind: "deleteEmptyDirectory", relativePath: "empty", targetObservationId: listedEmpty })]),
      ledger,
      ROOT
    );
    assert.deepEqual(accepted, { ok: true });

    const listedNonEmpty = mintDirectory(ledger, "full", ["x.ts"]);
    const nonEmpty = validatePreflightPlanAgainstLedgerV1(
      plan([op({ stepId: "s1", kind: "deleteEmptyDirectory", relativePath: "full", targetObservationId: listedNonEmpty })]),
      ledger,
      ROOT
    );
    assert.equal(!nonEmpty.ok && nonEmpty.code, "emptinessUnproven");
  });

  void it("requires a createdByStep link only for the ancestor this plan creates, and rejects a missing or misdirected claim", () => {
    const ledger = createObservationLedgerV1();
    const missingDir = mintMissing(ledger, "src/generated");
    const missingFile = mintMissing(ledger, "src/generated/out.ts");
    mintDirectory(ledger, "src", []); // "src" already exists — resolved host-side

    const good = validatePreflightPlanAgainstLedgerV1(
      plan([
        op({
          stepId: "s1",
          kind: "createDirectory",
          relativePath: "src/generated",
          targetObservationId: missingDir,
          parentChain: [],
        }),
        op({
          stepId: "s2",
          kind: "createFile",
          relativePath: "src/generated/out.ts",
          targetObservationId: missingFile,
          parentChain: [{ kind: "createdByStep", stepId: "s1" }],
          contentBase64: "aGk=",
          decodedByteLength: 2,
          contentSha256: "12".repeat(32),
        }),
      ]),
      ledger,
      ROOT
    );
    assert.deepEqual(good, { ok: true });

    // No createdByStep claim at all for the ancestor this plan is creating.
    const missingClaim = validatePreflightPlanAgainstLedgerV1(
      plan([
        op({
          stepId: "s2",
          kind: "createFile",
          relativePath: "src/generated/out.ts",
          targetObservationId: missingFile,
          parentChain: [],
          contentBase64: "aGk=",
          decodedByteLength: 2,
          contentSha256: "12".repeat(32),
        }),
      ]),
      ledger,
      ROOT
    );
    assert.equal(!missingClaim.ok && missingClaim.code, "parentChainMismatch");

    // createdByStep pointing at a step whose target is NOT the ancestor.
    const wrongTarget = validatePreflightPlanAgainstLedgerV1(
      plan([
        op({
          stepId: "s1",
          kind: "createDirectory",
          relativePath: "src/other",
          targetObservationId: mintMissing(ledger, "src/other"),
          parentChain: [],
        }),
        op({
          stepId: "s2",
          kind: "createFile",
          relativePath: "src/generated/out.ts",
          targetObservationId: missingFile,
          parentChain: [{ kind: "createdByStep", stepId: "s1" }],
          contentBase64: "aGk=",
          decodedByteLength: 2,
          contentSha256: "12".repeat(32),
        }),
      ]),
      ledger,
      ROOT
    );
    assert.equal(!wrongTarget.ok && wrongTarget.code, "parentChainMismatch");
  });
});

void describe("editPreflightContractV1 — digests", () => {
  void it("planDigest covers the ordered parent chains; ledger digest and correlation feed planId", () => {
    const ledger = createObservationLedgerV1();
    const missing = mintMissing(ledger, "a.ts");
    const p1 = plan([
      op({
        stepId: "s1",
        kind: "createFile",
        relativePath: "a.ts",
        targetObservationId: missing,
        contentBase64: "aGk=",
        decodedByteLength: 2,
        contentSha256: "12".repeat(32),
      }),
    ]);
    const digest1 = computePreflightPlanDigestV1(p1);
    assert.match(digest1, /^[0-9a-f]{64}$/);
    // Deterministic for identical input.
    assert.equal(computePreflightPlanDigestV1(p1), digest1);

    const corr = correlation();
    const id1 = computePreflightPlanIdV1(digest1, ledger.digest(), corr);
    const id2 = computePreflightPlanIdV1(digest1, ledger.digest(), corr);
    assert.equal(id1, id2);
    // A different attempt id yields a different planId.
    const otherId = computePreflightPlanIdV1(digest1, ledger.digest(), {
      ...corr,
      attemptId: allocateHex128IdV1(),
    });
    assert.notEqual(otherId, id1);
    // Ledger digest ignores entry bodies but is order-sensitive.
    assert.match(ledger.digest(), /^[0-9a-f]{64}$/);
  });
});
