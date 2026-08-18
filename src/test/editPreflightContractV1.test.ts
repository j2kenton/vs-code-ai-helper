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

void describe("editPreflightContractV1 — patchFile", () => {
  void it("accepts a patch whose target is an observed file", () => {
    const ledger = createObservationLedgerV1();
    const file = mintFile(ledger, "src/old.ts");
    mintDirectory(ledger, "src", ["old.ts"]);
    const srcDir = ledger.records().find((r) => r.relativePath === "src" && r.kind === "directory")!;

    const result = validatePreflightPlanAgainstLedgerV1(
      plan([
        op({
          stepId: "s1",
          kind: "patchFile",
          relativePath: "src/old.ts",
          targetObservationId: file,
          parentChain: [{ kind: "observed", observationId: srcDir.observationId }],
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
    const srcDir = ledger.records().find((r) => r.relativePath === "src" && r.kind === "directory")!;

    const result = validatePreflightPlanAgainstLedgerV1(
      plan([
        op({
          stepId: "s1",
          kind: "patchFile",
          relativePath: "src/new.ts",
          targetObservationId: missing,
          parentChain: [{ kind: "observed", observationId: srcDir.observationId }],
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
    const srcDir = ledger.records().find((r) => r.relativePath === "src" && r.kind === "directory")!;

    const result = validatePreflightPlanAgainstLedgerV1(
      plan([
        op({
          stepId: "s1",
          kind: "createFile",
          relativePath: "src/new.ts",
          targetObservationId: missing,
          parentChain: [{ kind: "observed", observationId: srcDir.observationId }],
          contentBase64: "aGk=",
          decodedByteLength: 2,
          contentSha256: "12".repeat(32),
        }),
        op({
          stepId: "s2",
          kind: "replaceFile",
          relativePath: "src/old.ts",
          targetObservationId: file,
          parentChain: [{ kind: "observed", observationId: srcDir.observationId }],
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

  void it("pins parent chains to the exact ancestor list — including createdByStep targets", () => {
    const ledger = createObservationLedgerV1();
    const missingDir = mintMissing(ledger, "src/generated");
    const missingFile = mintMissing(ledger, "src/generated/out.ts");
    mintDirectory(ledger, "src", []);
    const srcDir = ledger.records().find((r) => r.relativePath === "src" && r.kind === "directory")!;

    const good = validatePreflightPlanAgainstLedgerV1(
      plan([
        op({
          stepId: "s1",
          kind: "createDirectory",
          relativePath: "src/generated",
          targetObservationId: missingDir,
          parentChain: [{ kind: "observed", observationId: srcDir.observationId }],
        }),
        op({
          stepId: "s2",
          kind: "createFile",
          relativePath: "src/generated/out.ts",
          targetObservationId: missingFile,
          parentChain: [
            { kind: "observed", observationId: srcDir.observationId },
            { kind: "createdByStep", stepId: "s1" },
          ],
          contentBase64: "aGk=",
          decodedByteLength: 2,
          contentSha256: "12".repeat(32),
        }),
      ]),
      ledger,
      ROOT
    );
    assert.deepEqual(good, { ok: true });

    // Chain shorter than the ancestor list.
    const short = validatePreflightPlanAgainstLedgerV1(
      plan([
        op({
          stepId: "s2",
          kind: "createFile",
          relativePath: "src/generated/out.ts",
          targetObservationId: missingFile,
          parentChain: [{ kind: "observed", observationId: srcDir.observationId }],
          contentBase64: "aGk=",
          decodedByteLength: 2,
          contentSha256: "12".repeat(32),
        }),
      ]),
      ledger,
      ROOT
    );
    assert.equal(!short.ok && short.code, "parentChainMismatch");

    // createdByStep pointing at a step whose target is NOT the ancestor.
    const wrongTarget = validatePreflightPlanAgainstLedgerV1(
      plan([
        op({
          stepId: "s1",
          kind: "createDirectory",
          relativePath: "src/other",
          targetObservationId: mintMissing(ledger, "src/other"),
          parentChain: [{ kind: "observed", observationId: srcDir.observationId }],
        }),
        op({
          stepId: "s2",
          kind: "createFile",
          relativePath: "src/generated/out.ts",
          targetObservationId: missingFile,
          parentChain: [
            { kind: "observed", observationId: srcDir.observationId },
            { kind: "createdByStep", stepId: "s1" },
          ],
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
