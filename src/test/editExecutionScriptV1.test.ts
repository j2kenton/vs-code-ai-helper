/**
 * Coverage for the §7.4 execution-script contract (editExecutionProtocolV1):
 * the fixed operation-kind → tool mapping, script authoring order, the
 * script digest, and the script's content-freedom invariant (no paths, no
 * bytes, no observations ever leave the broker in a script).
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildEditExecutionScriptV1,
  computeEditExecutionScriptDigestV1,
  computeSealedOperationDigestV1,
  toolForOperationKindV1,
} from "../types/editExecutionProtocolV1";
import { PreflightOperationV1 } from "../types/aiResultEnvelope";

function operationOf(
  stepId: string,
  kind: PreflightOperationV1["kind"],
  relativePath: string
): PreflightOperationV1 {
  return {
    stepId,
    kind,
    rootId: "root",
    relativePath,
    targetObservationId: "obs-" + stepId,
    parentChain: [],
    ...(kind === "createFile" || kind === "replaceFile"
      ? { contentBase64: "aGk=", decodedByteLength: 2, contentSha256: "12".repeat(32) }
      : {}),
  };
}

void describe("editExecutionScriptV1", () => {
  void it("maps every operation kind to its fixed §7.4 tool", () => {
    assert.equal(toolForOperationKindV1("createFile"), "ensemble.writeFile");
    assert.equal(toolForOperationKindV1("replaceFile"), "ensemble.writeFile");
    assert.equal(toolForOperationKindV1("createDirectory"), "ensemble.createDirectory");
    assert.equal(toolForOperationKindV1("deleteFile"), "ensemble.deletePath");
    assert.equal(toolForOperationKindV1("deleteEmptyDirectory"), "ensemble.deletePath");
  });

  void it("authors steps in plan order and carries NO paths, bytes, preconditions, or observations", () => {
    const script = buildEditExecutionScriptV1("exec-1", "plan-1", "ab".repeat(32), [
      operationOf("s1", "createDirectory", "src/generated"),
      operationOf("s2", "createFile", "src/generated/out.ts"),
      operationOf("s3", "deleteFile", "src/old.ts"),
    ]);
    assert.deepEqual(script.steps, [
      { stepId: "s1", tool: "ensemble.createDirectory" },
      { stepId: "s2", tool: "ensemble.writeFile" },
      { stepId: "s3", tool: "ensemble.deletePath" },
    ]);
    const serialized = JSON.stringify(script);
    assert.ok(!serialized.includes("src/"), "the script must never contain a path");
    assert.ok(!serialized.includes("aGk="), "the script must never contain content bytes");
    assert.ok(!serialized.includes("obs-"), "the script must never contain observation ids");
  });

  void it("digests are stable and order-sensitive", () => {
    const ops = [operationOf("s1", "createFile", "a.ts"), operationOf("s2", "deleteFile", "b.ts")];
    const script = buildEditExecutionScriptV1("exec-1", "plan-1", "ab".repeat(32), ops);
    const digest = computeEditExecutionScriptDigestV1(script);
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(computeEditExecutionScriptDigestV1(script), digest);

    const reordered = buildEditExecutionScriptV1("exec-1", "plan-1", "ab".repeat(32), [ops[1]!, ops[0]!]);
    assert.notEqual(computeEditExecutionScriptDigestV1(reordered), digest);
  });

  void it("sealed-operation digests cover content and parent chains", () => {
    const a = computeSealedOperationDigestV1(operationOf("s1", "createFile", "a.ts"));
    const b = computeSealedOperationDigestV1({
      ...operationOf("s1", "createFile", "a.ts"),
      contentSha256: "34".repeat(32),
    });
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, b);
  });
});
