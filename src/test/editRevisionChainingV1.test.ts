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
import {
  buildPreflightClosingOverrideV1,
  buildPreflightToolSessionPreambleV1,
} from "../prompts/toolSessionPreambleV1";
import { safeRemoveDir } from "./testFsUtils";

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
      safeRemoveDir(workspaceRoot);
      safeRemoveDir(privateRoot);
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

// Item 4 (workflow 8): the preamble and the validator it describes drifted
// apart silently once — the validator was relaxed to allow a repeated
// `patchFile` target (item 17, tested above), but two prompt references kept
// asserting the OLD one-operation-per-file rule for a day before being
// corrected by hand. Nothing connects the prompt text to the validator's
// actual behavior, so this recurs whenever either changes. This test pins
// both sides of the claim together: build the exact plan shape the preamble
// describes (two `patchFile` operations, one path), assert the validator
// really does accept it, and assert the preamble states that outcome — not
// the one-operation-per-file rule this validator no longer enforces.
void describe("toolSessionPreambleV1 vs validatePreflightPlanAgainstLedgerV1 — item 4", () => {
  void it("the preamble's repeat-patchFile-target claim matches what the validator actually accepts", async () => {
    const fixture = await installFixtureV1("start\nMARKER\nend\n");
    try {
      const plan = planOf([
        patchOp("s1", "MARKER", "middle-one\nmiddle-two", fixture.fileObservation.observationId),
        patchOp("s2", "middle-two", "middle-two-edited", fixture.fileObservation.observationId),
      ]);
      assert.deepEqual(
        validatePreflightPlanAgainstLedgerV1(plan, fixture.ledger, WORKSPACE_ROOT_ID),
        { ok: true },
        "two patchFile operations on one path must validate — this is the behavior the preamble text below claims"
      );

      const preamble = buildPreflightToolSessionPreambleV1({
        rootId: WORKSPACE_ROOT_ID,
        rootBindingId: "cd".repeat(32),
        requestDigest: "ab".repeat(32),
      });
      assert.ok(
        preamble.includes(
          "Two or more `patchFile` operations on the SAME file, in one plan, ARE allowed"
        ),
        "preamble must state that a repeat patchFile target is allowed, matching the validator above"
      );
      assert.ok(
        !/only ONE operation per file/i.test(preamble) && !/one operation per file/i.test(preamble),
        "preamble must not also claim only one operation per file is allowed — the stale claim that drifted from the validator"
      );
    } finally {
      fixture.cleanup();
    }
  });
});

// 2026-09-17 (v1 fixes 2, run 2057): Fast Forward dispatches the review-fix
// round on every attempt, including after a clean review, and relies on it to
// keep building the plan. The review-fix framing only named blockers as the
// round's work, so a zero-blocker review with 74 steps unbuilt produced an
// empty plan and the task stalled. Pins that the framing covers both jobs.
void describe("toolSessionPreambleV1 — a review-fix round with no blockers builds the next plan steps", () => {
  const preambleFor = (purpose?: "checklist" | "review-fixes" | "lint-fixes"): string =>
    buildPreflightToolSessionPreambleV1({
      rootId: WORKSPACE_ROOT_ID,
      rootBindingId: "cd".repeat(32),
      requestDigest: "ab".repeat(32),
      ...(purpose ? { purpose } : {}),
    });

  void it("review-fixes: blockers come first, and a clean review means build the next steps", () => {
    const preamble = preambleFor("review-fixes");
    assert.ok(preamble.includes("Any blockers it lists come FIRST"));
    assert.ok(preamble.includes("### When the review lists NO blockers, build the next plan steps"));
    assert.ok(preamble.includes("BUILD THE\nNEXT STEPS"));
    assert.ok(
      preamble.includes("only honest when BOTH hold"),
      "an empty plan must be framed as honest only when no blocker AND no unbuilt step remains"
    );
    assert.ok(
      !preamble.includes("The blockers it lists ARE this\nround's work"),
      "the blockers-only framing is what produced the empty plan"
    );
  });

  void it("checklist and lint-fixes framings are unchanged by the zero-blocker section", () => {
    for (const purpose of [undefined, "checklist", "lint-fixes"] as const) {
      assert.ok(!preambleFor(purpose).includes("When the review lists NO blockers"));
    }
    assert.ok(preambleFor("checklist").includes("An empty `operations` array is a valid answer when nothing needs to change."));
  });

  // 2026-09-18 adversarial review, finding 1: apply-impl-review-code.md is
  // appended AFTER the preamble and tells the model to edit files directly,
  // run tests, and answer with a Markdown summary — none of which a read-only
  // planning session can do. The override has to come last, and has to name
  // what it is overriding.
  void it("the closing override contradicts the executor template the round actually carries", () => {
    const override = buildPreflightClosingOverrideV1();
    const template = fs.readFileSync(
      path.join(__dirname, "..", "..", "resources", "prompts", "apply-impl-review-code.md"),
      "utf8"
    );

    // Each of these is a real instruction in the template that a preflight
    // session cannot obey; if one is reworded there, this test should be
    // revisited rather than silently passing.
    assert.match(template, /making actual changes to the codebase/);
    assert.match(template, /Edit files directly in the workspace/);
    assert.match(template, /make sure the workspace files were actually changed/);
    assert.match(override, /do NOT edit, write or delete any file/);
    assert.match(override, /do NOT run commands, tests or type-checks/);
    assert.match(override, /do NOT write the Markdown summary/);
    assert.match(override, /one `preflight-plan\.v1` result frame/);

    // It must be last: the assembled prompt is preamble + caller prompt +
    // override, and this text only wins because nothing follows it.
    const assembled =
      buildPreflightToolSessionPreambleV1({
        rootId: WORKSPACE_ROOT_ID,
        rootBindingId: "cd".repeat(32),
        requestDigest: "ab".repeat(32),
        purpose: "review-fixes",
      }) +
      "\n\n" +
      template +
      "\n\n" +
      override;
    assert.ok(
      assembled.trimEnd().endsWith(override.trimEnd()),
      "the override must be the last thing the model reads"
    );
    assert.ok(
      assembled.indexOf("Edit files directly in the workspace") <
        assembled.indexOf("do NOT edit, write or delete any file"),
      "the override must come after the instruction it overrides"
    );
  });
});
