import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  parseAiResultEnvelopeV1,
  setInertTrailingObserverV1,
  setLegacyFrameEndObserverV1,
} from "../types/aiResultEnvelope";
import { ActionCorrelationV1 } from "../types/actionCorrelationV1";
import { DEFAULT_TEXT_ANSWER_MAX_LENGTH_V1 } from "../types/structuredQuestionV1";

const HEX_A = "a".repeat(32);
const HEX_B = "b".repeat(32);

function correlation(overrides: Partial<ActionCorrelationV1> = {}): ActionCorrelationV1 {
  return {
    actionKey: "generatePlan.v1",
    operationId: HEX_A,
    attemptId: HEX_B,
    taskBindingId: "task-binding-1",
    chatDocumentId: "chat-doc-1",
    ...overrides,
  };
}

function frame(payload: unknown, eol: "\n" | "\r\n" = "\n"): string {
  return `<<<ENSEMBLE_AI_RESULT_V1>>>${eol}${JSON.stringify(payload)}${eol}<<<END_ENSEMBLE_AI_RESULT_V1>>>`;
}

void describe("parseAiResultEnvelopeV1 — completed content", () => {
  void it("parses a markdown-artifact.v1 completed envelope", () => {
    const raw = frame({
      version: 1,
      correlation: correlation(),
      kind: "completed",
      content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown: "# Plan\n\nDo the thing." },
    });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "completed");
    if (result.kind === "completed") {
      assert.deepEqual(result.correlation, correlation());
      assert.equal(result.content.contentType, "markdown-artifact.v1");
    }
  });

  void it("parses a chat-message.v1 completed envelope", () => {
    const raw = frame({
      version: 1,
      correlation: correlation(),
      kind: "completed",
      content: { contentType: "chat-message.v1", schemaVersion: 1, text: "Here's my answer." },
    });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "completed");
    if (result.kind === "completed" && result.content.contentType === "chat-message.v1") {
      assert.equal(result.content.text, "Here's my answer.");
    }
  });

  void it("parses a commit-metadata.v1 completed envelope with an optional body", () => {
    const raw = frame({
      version: 1,
      correlation: correlation(),
      kind: "completed",
      content: { contentType: "commit-metadata.v1", schemaVersion: 1, subject: "feat: add widget", body: "Explains why." },
    });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "completed");
    if (result.kind === "completed" && result.content.contentType === "commit-metadata.v1") {
      assert.equal(result.content.subject, "feat: add widget");
      assert.equal(result.content.body, "Explains why.");
    }
  });

  void it("rejects a commit-metadata.v1 subject over 72 characters", () => {
    const raw = frame({
      version: 1,
      correlation: correlation(),
      kind: "completed",
      content: { contentType: "commit-metadata.v1", schemaVersion: 1, subject: "x".repeat(73) },
    });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.equal(result.code, "contentSchemaMismatch");
    }
  });

  void it("rejects unknown fields on completed content", () => {
    const raw = frame({
      version: 1,
      correlation: correlation(),
      kind: "completed",
      content: { contentType: "chat-message.v1", schemaVersion: 1, text: "hi", extra: "nope" },
    });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.equal(result.code, "contentSchemaMismatch");
      assert.match(result.reason, /unknown field/);
    }
  });

  void it("rejects an unrecognized contentType", () => {
    const raw = frame({
      version: 1,
      correlation: correlation(),
      kind: "completed",
      content: { contentType: "bogus.v1", schemaVersion: 1 },
    });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.equal(result.code, "contentSchemaMismatch");
    }
  });
});

/**
 * Workflow 3 continuation, fifth item: `draft.v1` (Draft with AI) failed with
 * `contentSchemaMismatch` on GitHub Copilot (both "auto" and the concrete
 * "gpt-5.6-terra" model) on 2026-08-15 — the envelope itself parsed cleanly
 * (`version`, `correlation`, `kind: "completed"` all valid); only
 * `decodeCompletedContentV1(value.content)` rejected the content. No live
 * Copilot entitlement was available in the environment that implemented this
 * fix, and the raw rejected payload from that incident lives in a different
 * repository's task history, not this one — so per the plan's fixture route
 * (Part 7 step 2) this is a RECONSTRUCTED fixture, not a literal capture of
 * that response.
 *
 * The reconstruction is grounded in a concrete code-level finding, not a
 * guess: `draft.v1` and `generatePlan.v1` build byte-identical result
 * contracts (`buildAiResultContractPromptV1` — same `permittedResultKinds`,
 * same `completedContentType`), and `generatePlan.v1` succeeds under the
 * same conditions where `draft.v1` fails. The only differing instruction is
 * `draft-task-with-ai.md`'s closing nudge, prior to this fix, to "ask them
 * instead of guessing" without pointing at the structured "questions" result
 * kind — which invites a model to try to surface a clarifying question
 * inside its "completed" answer instead of switching envelope kind. Doing so
 * as an extra field alongside "markdown" is the shape this test exercises;
 * `resources/prompts/draft-task-with-ai.md` was hardened in this same round
 * to close that ambiguity (see the file for the reworded instruction).
 */
void describe("parseAiResultEnvelopeV1 — reconstructed fixture for the 2026-08-15 Copilot draft.v1 desc failure", () => {
  void it("names the failing check as an unknown field on markdown-artifact.v1 when a clarifying question rides alongside the draft markdown", () => {
    const raw = frame({
      version: 1,
      correlation: correlation({ actionKey: "draft.v1" }),
      kind: "completed",
      content: {
        contentType: "markdown-artifact.v1",
        schemaVersion: 1,
        markdown: "Add a login button.\n\n### Behavior change\n\n...",
        // The hypothesized failure shape: the model tries to ask a
        // clarifying question INSIDE the completed content instead of
        // using "kind": "questions" — an extra field the decoder rejects.
        clarifyingQuestion: "Should the login button use OAuth or email/password?",
      },
    });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.equal(result.code, "contentSchemaMismatch");
      assert.match(result.reason, /markdown-artifact\.v1 has unknown field: clarifyingQuestion/);
    }
  });

  void it("names the failing check as a missing markdown field when only a conversational reply is returned", () => {
    const raw = frame({
      version: 1,
      correlation: correlation({ actionKey: "draft.v1" }),
      kind: "completed",
      content: {
        contentType: "markdown-artifact.v1",
        schemaVersion: 1,
        // No "markdown" field at all — a plausible shape if the model
        // answers conversationally instead of emitting the artifact.
        answer: "I'd like to know more about the login flow before drafting this.",
      },
    });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.equal(result.code, "contentSchemaMismatch");
      assert.match(result.reason, /markdown-artifact\.v1 is missing a string "markdown" field/);
    }
  });
});

void describe("parseAiResultEnvelopeV1 — preflight-plan.v1 and edit-execution.v1", () => {
  function writeOp(
    stepId: string,
    bytes: string,
    parentChain: unknown[] = []
  ): Record<string, unknown> {
    const buf = Buffer.from(bytes, "utf8");
    return {
      stepId,
      kind: "createFile",
      rootId: "root-1",
      relativePath: `src/${stepId}.ts`,
      targetObservationId: "obs-1",
      parentChain,
      contentBase64: buf.toString("base64"),
      decodedByteLength: buf.length,
      contentSha256: createHash("sha256").update(buf).digest("hex"),
    };
  }

  void it("parses a preflight-plan.v1 with a valid createdByStep parent chain", () => {
    const raw = frame({
      version: 1,
      correlation: correlation(),
      kind: "completed",
      content: {
        contentType: "preflight-plan.v1",
        schemaVersion: 1,
        requestDigest: "digest-1",
        rootBindingId: "root-binding-1",
        operations: [
          {
            stepId: "step-1",
            kind: "createDirectory",
            rootId: "root-1",
            relativePath: "src",
            targetObservationId: "obs-missing-src",
            parentChain: [{ kind: "observed", observationId: "obs-root" }],
          },
          writeOp("step-2", "export const x = 1;\n", [{ kind: "createdByStep", stepId: "step-1" }]),
        ],
      },
    });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "completed");
    if (result.kind === "completed" && result.content.contentType === "preflight-plan.v1") {
      assert.equal(result.content.operations.length, 2);
    } else {
      assert.fail(`expected completed preflight-plan.v1, got: ${JSON.stringify(result)}`);
    }
  });

  void it("accepts a patchFile whose payloads are plain text and normalizes them to base64", () => {
    // A model cannot reliably base64-encode a snippet by hand. Copilot refused
    // an entire round rather than guess (its own `unreliable-manual-encoding`,
    // 2026-08-18) — the right call, since a mis-encoded patch corrupts a file.
    // Plain text in, base64 out, so the seal and the executor see exactly one
    // representation regardless of which form the author sent.
    const findText = "const a = 1;\n";
    const replacementText = "const a = 2;\n";
    const raw = frame({
      version: 1,
      correlation: correlation(),
      kind: "completed",
      content: {
        contentType: "preflight-plan.v1",
        schemaVersion: 1,
        requestDigest: "digest-1",
        rootBindingId: "root-binding-1",
        operations: [
          {
            stepId: "step-1",
            kind: "patchFile",
            rootId: "root-1",
            relativePath: "src/a.ts",
            targetObservationId: "obs-file",
            parentChain: [{ kind: "observed", observationId: "obs-src" }],
            findText,
            replacementText,
          },
        ],
      },
    });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "completed");
    if (result.kind === "completed" && result.content.contentType === "preflight-plan.v1") {
      const op = result.content.operations[0];
      assert.ok(op, "expected one decoded operation");
      assert.equal(op?.findBase64, Buffer.from(findText, "utf8").toString("base64"));
      assert.equal(op?.replacementBase64, Buffer.from(replacementText, "utf8").toString("base64"));
      // Consumed, not carried through: one representation reaches the digest,
      // so the same edit always seals identically however it was expressed.
      const opFields = op as unknown as Record<string, unknown>;
      assert.equal(opFields.findText, undefined);
      assert.equal(opFields.replacementText, undefined);
    } else {
      assert.fail(`expected completed preflight-plan.v1, got: ${JSON.stringify(result)}`);
    }
  });

  void it("rejects a patchFile that sends both the text and base64 form", () => {
    const raw = frame({
      version: 1,
      correlation: correlation(),
      kind: "completed",
      content: {
        contentType: "preflight-plan.v1",
        schemaVersion: 1,
        requestDigest: "digest-1",
        rootBindingId: "root-binding-1",
        operations: [
          {
            stepId: "step-1",
            kind: "patchFile",
            rootId: "root-1",
            relativePath: "src/a.ts",
            targetObservationId: "obs-file",
            parentChain: [],
            findText: "a",
            findBase64: "YQ==",
            replacementText: "b",
          },
        ],
      },
    });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.match(result.reason, /must not set both "findBase64" and "findText"/);
    }
  });

  void it("rejects a createdByStep link that references a later step", () => {
    const raw = frame({
      version: 1,
      correlation: correlation(),
      kind: "completed",
      content: {
        contentType: "preflight-plan.v1",
        schemaVersion: 1,
        requestDigest: "digest-1",
        rootBindingId: "root-binding-1",
        operations: [
          writeOp("step-1", "a", [{ kind: "createdByStep", stepId: "step-2" }]),
          { stepId: "step-2", kind: "createDirectory", rootId: "root-1", relativePath: "src", targetObservationId: "obs-1", parentChain: [] },
        ],
      },
    });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.equal(result.code, "contentSchemaMismatch");
      assert.match(result.reason, /non-earlier step/);
    }
  });

  void it("rejects a createdByStep link that references a non-createDirectory step", () => {
    const raw = frame({
      version: 1,
      correlation: correlation(),
      kind: "completed",
      content: {
        contentType: "preflight-plan.v1",
        schemaVersion: 1,
        requestDigest: "digest-1",
        rootBindingId: "root-binding-1",
        operations: [
          writeOp("step-1", "a"),
          writeOp("step-2", "b", [{ kind: "createdByStep", stepId: "step-1" }]),
        ],
      },
    });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.match(result.reason, /non-createDirectory step/);
    }
  });

  void it("rejects a write operation whose contentSha256 does not match its bytes", () => {
    const op = writeOp("step-1", "a");
    const raw = frame({
      version: 1,
      correlation: correlation(),
      kind: "completed",
      content: {
        contentType: "preflight-plan.v1",
        schemaVersion: 1,
        requestDigest: "digest-1",
        rootBindingId: "root-binding-1",
        operations: [{ ...op, contentSha256: "f".repeat(64) }],
      },
    });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.match(result.reason, /contentSha256.*does not match/);
    }
  });

  void it("parses an edit-execution.v1 completed envelope", () => {
    const raw = frame({
      version: 1,
      correlation: correlation(),
      kind: "completed",
      content: {
        contentType: "edit-execution.v1",
        schemaVersion: 1,
        executionId: "exec-1",
        planId: "plan-1",
        planDigest: "digest-1",
        receiptIds: ["r1", "r2"],
      },
    });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "completed");
    if (result.kind === "completed" && result.content.contentType === "edit-execution.v1") {
      assert.deepEqual(result.content.receiptIds, ["r1", "r2"]);
    }
  });

  void it("rejects edit-execution.v1 with a duplicate receiptId", () => {
    const raw = frame({
      version: 1,
      correlation: correlation(),
      kind: "completed",
      content: {
        contentType: "edit-execution.v1",
        schemaVersion: 1,
        executionId: "exec-1",
        planId: "plan-1",
        planDigest: "digest-1",
        receiptIds: ["r1", "r1"],
      },
    });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.match(result.reason, /duplicate receiptId/);
    }
  });
});

void describe("parseAiResultEnvelopeV1 — questions", () => {
  void it("parses a valid single-choice question", () => {
    const raw = frame({
      version: 1,
      correlation: correlation(),
      kind: "questions",
      questions: [
        {
          questionId: "q1",
          kind: "singleChoice",
          prompt: "Which stage?",
          required: true,
          options: [
            { optionId: "a", label: "Plan" },
            { optionId: "b", label: "Implementation" },
          ],
        },
      ],
    });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "questions");
    if (result.kind === "questions") {
      assert.equal(result.questions.length, 1);
    }
  });

  void it("rejects an empty questions array", () => {
    const raw = frame({ version: 1, correlation: correlation(), kind: "questions", questions: [] });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.equal(result.code, "contentSchemaMismatch");
    }
  });

  void it("rejects more than 16 questions", () => {
    const questions = Array.from({ length: 17 }, (_, idx) => ({
      questionId: `q${idx}`,
      kind: "text",
      prompt: "Anything else?",
      required: false,
    }));
    const raw = frame({ version: 1, correlation: correlation(), kind: "questions", questions });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
  });

  void it("rejects a multipleChoice question whose maxSelections exceeds its option count", () => {
    const raw = frame({
      version: 1,
      correlation: correlation(),
      kind: "questions",
      questions: [
        {
          questionId: "q1",
          kind: "multipleChoice",
          prompt: "Pick some",
          required: true,
          minSelections: 0,
          maxSelections: 5,
          options: [{ optionId: "a", label: "A" }, { optionId: "b", label: "B" }],
        },
      ],
    });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
  });

  void it("rejects duplicate questionIds", () => {
    const raw = frame({
      version: 1,
      correlation: correlation(),
      kind: "questions",
      questions: [
        { questionId: "q1", kind: "text", prompt: "A?", required: false },
        { questionId: "q1", kind: "text", prompt: "B?", required: false },
      ],
    });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.match(result.reason, /duplicate/);
    }
  });

  void it("rejects a question with an unknown top-level field", () => {
    const raw = frame({
      version: 1,
      correlation: correlation(),
      kind: "questions",
      questions: [
        {
          questionId: "q1",
          kind: "text",
          prompt: "A?",
          required: false,
          bogusField: "should be rejected",
        },
      ],
    });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.match(result.reason, /unknown field/);
    }
  });

  void it("rejects fresh allowBlank and maxLength as unknown fields, specifically", () => {
    for (const field of ["allowBlank", "maxLength"] as const) {
      const raw = frame({
        version: 1,
        correlation: correlation(),
        kind: "questions",
        questions: [
          {
            questionId: "q1",
            kind: "text",
            prompt: "A?",
            required: false,
            ...(field === "allowBlank" ? { allowBlank: true } : { maxLength: 10 }),
          },
        ],
      });
      const result = parseAiResultEnvelopeV1(raw);
      assert.equal(result.kind, "malformed", `fresh "${field}" must be rejected`);
      if (result.kind === "malformed") {
        assert.match(result.reason, new RegExp(field));
      }
    }
  });

  void it("rejects an option with an unknown field as an invalid options array", () => {
    const raw = frame({
      version: 1,
      correlation: correlation(),
      kind: "questions",
      questions: [
        {
          questionId: "q1",
          kind: "singleChoice",
          prompt: "Which?",
          required: true,
          options: [{ optionId: "a", label: "A", bogus: "yes" }],
        },
      ],
    });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
  });

  void it("rejects a multipleChoice question with an unknown field", () => {
    const raw = frame({
      version: 1,
      correlation: correlation(),
      kind: "questions",
      questions: [
        {
          questionId: "q1",
          kind: "multipleChoice",
          prompt: "Pick",
          required: true,
          minSelections: 0,
          maxSelections: 2,
          options: [{ optionId: "a", label: "A" }, { optionId: "b", label: "B" }],
          extraField: "reject",
        },
      ],
    });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.match(result.reason, /unknown field/);
    }
  });

});

void describe("parseAiResultEnvelopeV1 — cancelled and failed", () => {
  void it("parses a cancelled envelope with a reason", () => {
    const raw = frame({ version: 1, correlation: correlation(), kind: "cancelled", reason: "user" });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "cancelled");
    if (result.kind === "cancelled") {
      assert.equal(result.reason, "user");
    }
  });

  void it("parses a failed envelope", () => {
    const raw = frame({
      version: 1,
      correlation: correlation(),
      kind: "failed",
      code: "providerQuotaExceeded",
      message: "provider quota exceeded",
      retryable: true,
    });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "failed");
    if (result.kind === "failed") {
      assert.equal(result.code, "providerQuotaExceeded");
      assert.equal(result.retryable, true);
    }
  });

  void it("rejects a failed envelope with an invalid code", () => {
    const raw = frame({
      version: 1,
      correlation: correlation(),
      kind: "failed",
      code: "bad code with spaces",
      message: "x",
      retryable: false,
    });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.equal(result.code, "invalidEnvelope");
    }
  });
});

void describe("parseAiResultEnvelopeV1 — envelope-level validation", () => {
  void it("rejects a missing version", () => {
    const raw = frame({ correlation: correlation(), kind: "cancelled" });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.equal(result.code, "invalidEnvelope");
    }
  });

  void it("rejects a missing correlation tuple", () => {
    const raw = frame({ version: 1, kind: "cancelled" });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.equal(result.code, "invalidEnvelope");
    }
  });

  void it("rejects a correlation with a malformed operationId", () => {
    const raw = frame({ version: 1, correlation: correlation({ operationId: "not-hex" }), kind: "cancelled" });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.equal(result.code, "invalidEnvelope");
    }
  });

  void it("rejects an unknown top-level envelope field", () => {
    const raw = frame({ version: 1, correlation: correlation(), kind: "cancelled", bogus: true });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.equal(result.code, "invalidEnvelope");
      assert.match(result.reason, /unknown envelope field/);
    }
  });

  void it("rejects an unrecognized kind", () => {
    const raw = frame({ version: 1, correlation: correlation(), kind: "bogus" });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
  });

  void it("flags a cross-operation result via expectedCorrelation", () => {
    const raw = frame({ version: 1, correlation: correlation(), kind: "cancelled" });
    const otherOperation = correlation({ operationId: "c".repeat(32) });
    const result = parseAiResultEnvelopeV1(raw, otherOperation);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.equal(result.code, "resultCorrelationMismatch");
    }
  });

  void it("accepts a matching expectedCorrelation", () => {
    const raw = frame({ version: 1, correlation: correlation(), kind: "cancelled" });
    const result = parseAiResultEnvelopeV1(raw, correlation());
    assert.equal(result.kind, "cancelled");
  });
});

void describe("parseAiResultEnvelopeV1 — frame parsing", () => {
  void it("accepts a CRLF-framed envelope", () => {
    const raw = frame({ version: 1, correlation: correlation(), kind: "cancelled" }, "\r\n");
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "cancelled");
  });

  void it("tolerates exactly one trailing newline after the end marker", () => {
    const raw = frame({ version: 1, correlation: correlation(), kind: "cancelled" }) + "\n";
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "cancelled");
  });

  void it("rejects plain text with no frame markers at all", () => {
    const result = parseAiResultEnvelopeV1("Here is the plan.");
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.equal(result.code, "invalidFrame");
    }
  });

  void it("rejects a BOM at the start of the input", () => {
    const raw = "﻿" + frame({ version: 1, correlation: correlation(), kind: "cancelled" });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.equal(result.code, "invalidFrame");
      assert.match(result.reason, /byte-order mark/);
    }
  });

  void it("rejects a lone surrogate in the raw input", () => {
    const raw = frame({ version: 1, correlation: correlation(), kind: "completed", content: { contentType: "chat-message.v1", schemaVersion: 1, text: "hi" } }) + "\uD800";
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.match(result.reason, /lone.*surrogate/);
    }
  });

  /**
   * 2026-08-07 live incidents: agentic CLI providers routinely narrate
   * ("I'll check X", "Let me verify Y") before their final answer, and some
   * capture paths concatenate that narration ahead of the frame. Requiring
   * the frame at byte zero made every narrating run fail — not a model
   * defect, a structural mismatch. The parser now tolerates and discards
   * anything before the LAST frame-start marker instead of rejecting it.
   */
  void it("tolerates and discards narration before the frame instead of rejecting it", () => {
    const raw =
      "Let me check the implementation first.\n\nOkay, verified.\n\n" +
      frame({ version: 1, correlation: correlation(), kind: "cancelled" });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "cancelled");
  });

  void it("still rejects outer bytes after the end marker", () => {
    // Preamble is tolerated; a trailer is not — once the model emits the
    // frame, the result-contract prompt says that is its entire reply, so
    // trailing content past the end marker stays a genuine violation.
    const raw = frame({ version: 1, correlation: correlation(), kind: "cancelled" }) + "\ntrailer";
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.equal(result.code, "invalidFrame");
    }
  });

  /**
   * 2026-08-12 field report, item 1: a response whose JSON payload is
   * byte-perfect but whose closing `<<<END_ENSEMBLE_AI_RESULT_V1>>>` never
   * arrived (the CLI stopped writing early) was previously LESS recoverable
   * than a response with no frame at all, because the frameless fallback
   * bails whenever the start marker appears anywhere. A single complete JSON
   * line with no terminator is now accepted.
   */
  void it("accepts a complete unterminated frame: start marker, one JSON line, nothing else", () => {
    const payload = JSON.stringify({ version: 1, correlation: correlation(), kind: "cancelled" });
    const raw = `<<<ENSEMBLE_AI_RESULT_V1>>>\n${payload}`;
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "cancelled");
  });

  void it("accepts a complete unterminated frame with CRLF line ending", () => {
    const payload = JSON.stringify({ version: 1, correlation: correlation(), kind: "cancelled" });
    const raw = `<<<ENSEMBLE_AI_RESULT_V1>>>\r\n${payload}`;
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "cancelled");
  });

  void it("accepts an unterminated frame preceded by tolerated narration", () => {
    const payload = JSON.stringify({ version: 1, correlation: correlation(), kind: "cancelled" });
    const raw = `Let me finish up.\n\n<<<ENSEMBLE_AI_RESULT_V1>>>\n${payload}`;
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "cancelled");
  });

  void it("rejects an unterminated frame whose payload spans multiple lines", () => {
    const raw = `<<<ENSEMBLE_AI_RESULT_V1>>>\n{\n"version": 1\n}`;
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.equal(result.code, "invalidFrame");
      assert.match(result.reason, /expected the frame to end with/);
    }
  });

  void it("rejects an unterminated frame whose single line is not valid JSON, naming the missing terminator (not invalidJson)", () => {
    const raw = `<<<ENSEMBLE_AI_RESULT_V1>>>\n{not json}`;
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.equal(result.code, "invalidFrame");
      assert.match(result.reason, /expected the frame to end with/);
    }
  });

  void it("rejects an unterminated frame with no line ending after the start marker", () => {
    const raw = `<<<ENSEMBLE_AI_RESULT_V1>>>not-even-a-newline`;
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.equal(result.code, "invalidFrame");
    }
  });

  /**
   * REVERSED 2026-08-17, deliberately. This test previously asserted that the
   * extra-outer-brace shape stays malformed ("still rejects … as invalidJson,
   * not invalidFrame"), written from a single field sighting where the
   * surplus brace read as simply bad JSON.
   *
   * The evidence changed. The provider-result spool held EIGHT payloads of
   * exactly this shape — a complete, correct envelope plus one surplus closer
   * — across THREE providers (Copilot `applyReview.v1` ×3, OpenAI Codex
   * `draft.v1` ×2 and `review.v1`, Cline `generateImplementation.v1` ×2).
   * Every one was 9-13KB of finished work discarded over one character,
   * because brace-counting fails at the end of a long escaped Markdown
   * string. That is not a model producing nonsense; it is a finished result
   * with a miscounted tail.
   *
   * The original test's OTHER purpose — pinning the classification as
   * invalidJson rather than invalidFrame when both markers are present — is
   * still valuable and is kept in the sibling test below, using a payload
   * that is genuinely unparseable.
   */
  void it("recovers the extra-outer-brace shape (complete value, one surplus closer) and reports the recovery", () => {
    const seen: string[] = [];
    setInertTrailingObserverV1((t) => seen.push(t));
    try {
      const raw = `<<<ENSEMBLE_AI_RESULT_V1>>>\n{"version": 1, "correlation": ${JSON.stringify(correlation())}, "kind": "cancelled"}}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>`;
      const result = parseAiResultEnvelopeV1(raw);
      assert.equal(result.kind, "cancelled", "the envelope is complete before the surplus brace");
      assert.deepEqual(seen, ["}"], "recovery must be observable, not silent");
    } finally {
      setInertTrailingObserverV1(undefined);
    }
  });

  void it("classifies genuinely unparseable JSON with both markers present as invalidJson, not invalidFrame", () => {
    // The surviving half of the reversed test above: when the terminator IS
    // present, a bad payload is the JSON's fault, not the frame's.
    const raw = `<<<ENSEMBLE_AI_RESULT_V1>>>\n{"version": 1, "correlation": ${JSON.stringify(correlation())}, "kind":}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>`;
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.equal(result.code, "invalidJson");
    }
  });

  void it("rejects a response with no frame marker anywhere", () => {
    const raw = "just some prose, no frame at all, nothing to find here.";
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.equal(result.code, "invalidFrame");
      assert.match(result.reason, /does not contain the required.*frame marker anywhere/);
    }
  });

  /**
   * Multiple frames no longer reject outright — the LAST one wins, and every
   * earlier one is silently discarded. Two reasons: (1) it mirrors the same
   * "keep only the final say" choice extractClineFinalOutput/
   * extractKimiFinalOutput already make for multi-turn CLI output, and
   * (2) it is what makes scanning safe for a repo whose own reviews discuss
   * this exact frame format in prose — a quoted/mentioned marker earlier in
   * the text can never be mistaken for the real, final one.
   */
  void it("keeps the LAST of two frames back to back, discarding the first", () => {
    const first = frame({ version: 1, correlation: correlation(), kind: "cancelled", reason: "user" });
    const second = frame({ version: 1, correlation: correlation(), kind: "cancelled", reason: "provider" });
    const result = parseAiResultEnvelopeV1(first + second);
    assert.equal(result.kind, "cancelled");
    if (result.kind === "cancelled") {
      assert.equal(result.reason, "provider");
    }
  });

  void it("rejects mixed line endings between the markers", () => {
    const payload = JSON.stringify({ version: 1, correlation: correlation(), kind: "cancelled" });
    const raw = `<<<ENSEMBLE_AI_RESULT_V1>>>\n${payload}\r\n<<<END_ENSEMBLE_AI_RESULT_V1>>>`;
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.equal(result.code, "invalidFrame");
    }
  });

  void it("rejects multiline JSON inside the frame", () => {
    const raw = `<<<ENSEMBLE_AI_RESULT_V1>>>\n{\n"version": 1\n}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>`;
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.equal(result.code, "invalidFrame");
    }
  });

  void it("rejects invalid JSON in the payload", () => {
    const raw = `<<<ENSEMBLE_AI_RESULT_V1>>>\n{not json}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>`;
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.equal(result.code, "invalidJson");
    }
  });

  void it("rejects duplicate JSON keys instead of silently keeping the last one", () => {
    const raw = `<<<ENSEMBLE_AI_RESULT_V1>>>\n{"version": 1, "version": 2}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>`;
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.equal(result.code, "invalidJson");
      assert.match(result.reason, /duplicate object key/);
    }
  });

  void it("treats a __proto__ JSON key as an ordinary own field, not prototype pollution", () => {
    const raw = `<<<ENSEMBLE_AI_RESULT_V1>>>\n{"__proto__": {"polluted": true}, "version": 1, "correlation": ${JSON.stringify(correlation())}, "kind": "cancelled"}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>`;
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.match(result.reason, /unknown envelope field: __proto__/);
    }
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  void it("rejects a trailing comma", () => {
    const raw = `<<<ENSEMBLE_AI_RESULT_V1>>>\n{"version": 1,}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>`;
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.equal(result.code, "invalidJson");
    }
  });

  void it("rejects a payload over the non-preflight 4 MiB limit", () => {
    const raw = frame({
      version: 1,
      correlation: correlation(),
      kind: "completed",
      content: { contentType: "chat-message.v1", schemaVersion: 1, text: "x".repeat(5 * 1024 * 1024) },
    });
    const result = parseAiResultEnvelopeV1(raw);
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.equal(result.code, "resultLimitExceeded");
    }
  });
});

void describe("parseAiResultEnvelopeV1 — a complete value followed by surplus closers", () => {
  /**
   * Field shape, not a hypothetical. On 2026-08-16 the provider-result spool
   * held eight rejected payloads that were a COMPLETE, correct envelope
   * followed by one extra `}` — Copilot `applyReview.v1` ×3, OpenAI Codex
   * `draft.v1` ×2 and `review.v1`, Cline `generateImplementation.v1` ×2. Each
   * was 9-13KB of finished work (a plan, an applied review, an
   * implementation) discarded over a single character, because brace-counting
   * fails at the end of a long escaped Markdown string. It is not
   * provider-specific: three of the four providers in the corpus do it.
   */
  const payload = {
    version: 1,
    correlation: correlation(),
    kind: "completed" as const,
    content: {
      contentType: "markdown-artifact.v1" as const,
      schemaVersion: 1 as const,
      markdown: "# Security hardening plan\n\n## Goal\nAudit the surface.",
    },
  };

  void it("recovers the payload when the surplus is a closer, and reports the recovery", () => {
    const seen: string[] = [];
    setInertTrailingObserverV1((t) => seen.push(t));
    try {
      const raw = frame(payload).replace(
        `${JSON.stringify(payload)}\n`,
        `${JSON.stringify(payload)}}\n`
      );
      const result = parseAiResultEnvelopeV1(raw);
      assert.equal(result.kind, "completed", "a complete value must survive one surplus closer");
      if (result.kind === "completed") {
        assert.equal(result.content.contentType, "markdown-artifact.v1");
      }
      assert.deepEqual(seen, ["}"], "the tolerance must be observable, never silent");
    } finally {
      setInertTrailingObserverV1(undefined);
    }
  });

  void it("does NOT report anything for a clean payload", () => {
    const seen: string[] = [];
    setInertTrailingObserverV1((t) => seen.push(t));
    try {
      assert.equal(parseAiResultEnvelopeV1(frame(payload)).kind, "completed");
      assert.deepEqual(seen, []);
    } finally {
      setInertTrailingObserverV1(undefined);
    }
  });

  void it("still rejects trailing content that could begin another value", () => {
    // The tolerance must not become "ignore anything after the JSON": a
    // second object, prose, or a truncated fragment all still fail. Only
    // structurally inert surplus is recoverable.
    for (const tail of ['{"a":1}', "oops", '"x"', "1", "[]"]) {
      const raw = frame(payload).replace(
        `${JSON.stringify(payload)}\n`,
        `${JSON.stringify(payload)}${tail}\n`
      );
      assert.equal(
        parseAiResultEnvelopeV1(raw).kind,
        "malformed",
        `trailing ${JSON.stringify(tail)} must still reject`
      );
    }
  });

  void it("rejects a surplus run longer than the bound", () => {
    const raw = frame(payload).replace(
      `${JSON.stringify(payload)}\n`,
      `${JSON.stringify(payload)}${"}".repeat(20)}\n`
    );
    assert.equal(parseAiResultEnvelopeV1(raw).kind, "malformed");
  });

  void it("a truncated payload still fails — the value must be complete first", () => {
    const truncated = JSON.stringify(payload).slice(0, -12);
    const raw = frame(payload).replace(`${JSON.stringify(payload)}\n`, `${truncated}\n`);
    assert.equal(parseAiResultEnvelopeV1(raw).kind, "malformed");
  });
});

/**
 * The 2026-08-16 spool corpus was not a handful of tiny payloads — every
 * instance was 9-13KB of `markdown-artifact.v1` content (a plan, an
 * implementation, an applied review), because the miscount happens at the
 * end of a long escaped Markdown string, not at small scale. The tests above
 * pin the mechanism with a trivial payload; these pin the actual shape and
 * size across the four action kinds the corpus named, so a future change
 * that only holds at small scale (e.g. swapping the hand-rolled parser for a
 * brace-counting heuristic) cannot pass by accident.
 */
void describe("parseAiResultEnvelopeV1 — corpus-realistic sizes across action kinds", () => {
  // Deliberately mixes headers, lists, fenced code (with braces/quotes/
  // backticks inside), and a long prose tail so the escaped JSON string this
  // becomes is representative of real model output, not a repeated filler
  // character.
  function markdownBody(title: string, paragraphs: number): string {
    const sections: string[] = [`# ${title}`, ""];
    for (let i = 0; i < paragraphs; i++) {
      sections.push(`## Section ${i + 1}`);
      sections.push(
        `This step touches \`src/module_${i}.ts\` and updates the \`{ "key": "value_${i}" }\` shape used ` +
          `by callers such as \`doThing({ id: "${i}", nested: { ok: true } })\`. See the "quoted" note below.`
      );
      sections.push("```ts");
      sections.push(`function handle_${i}(input: { a: number; b: string }): { ok: boolean } {`);
      sections.push(`  if (input.a > ${i}) { return { ok: true }; }`);
      sections.push(`  return { ok: false };`);
      sections.push("}");
      sections.push("```");
      sections.push("");
    }
    return sections.join("\n");
  }

  const corpusCases: ReadonlyArray<{
    readonly label: string;
    readonly markdown: string;
  }> = [
    { label: "draft.v1 (a multi-section draft plan)", markdown: markdownBody("Draft plan", 28) },
    {
      label: "generateImplementation.v1 (an implementation summary)",
      markdown: markdownBody("Implementation summary", 28),
    },
    {
      label: "review.v1 (a scored review with a Readiness line)",
      markdown: `Readiness: 8/10\n\n${markdownBody("Review findings", 28)}`,
    },
    {
      label: "applyReview.v1 (an applied-review summary)",
      markdown: `${markdownBody("Applied review", 28)}\nAll findings above were verified during inventory.`,
    },
  ];

  for (const { label, markdown } of corpusCases) {
    void it(`recovers a ${label} payload in the 9-13KB range with one surplus trailing closer`, () => {
      const payload = {
        version: 1,
        correlation: correlation(),
        kind: "completed" as const,
        content: { contentType: "markdown-artifact.v1" as const, schemaVersion: 1 as const, markdown },
      };
      const serialized = JSON.stringify(payload);
      // Confirms the fixture is actually corpus-scale, not accidentally
      // shrunk by a future edit to markdownBody's section count.
      assert.ok(
        serialized.length >= 9_000 && serialized.length <= 15_000,
        `fixture for ${label} is ${serialized.length} bytes, expected roughly 9-13KB`
      );

      const seen: string[] = [];
      setInertTrailingObserverV1((t) => seen.push(t));
      try {
        const raw = frame(payload).replace(`${serialized}\n`, `${serialized}}\n`);
        const result = parseAiResultEnvelopeV1(raw);
        assert.equal(result.kind, "completed", `a complete ${label} payload must survive one surplus closer`);
        if (result.kind === "completed" && result.content.contentType === "markdown-artifact.v1") {
          assert.equal(result.content.markdown, markdown, "recovered content must be byte-identical to the source");
        }
        assert.deepEqual(seen, ["}"], "recovery must be observable, not silent");
      } finally {
        setInertTrailingObserverV1(undefined);
      }
    });

    void it(`still rejects a truncated ${label} payload even at corpus scale`, () => {
      const payload = {
        version: 1,
        correlation: correlation(),
        kind: "completed" as const,
        content: { contentType: "markdown-artifact.v1" as const, schemaVersion: 1 as const, markdown },
      };
      const serialized = JSON.stringify(payload);
      const truncated = serialized.slice(0, -40);
      const raw = frame(payload).replace(`${serialized}\n`, `${truncated}\n`);
      assert.equal(parseAiResultEnvelopeV1(raw).kind, "malformed");
    });
  }
});

void describe("parseAiResultEnvelopeV1 — legacy frame-end marker tolerance", () => {
  /**
   * Field shape, not a hypothetical (2026-08-15, a Copilot `draft.v1`
   * response, item seven of the 2026-08-16 workflow-fixes review): the model
   * closed with `<<<END_ENSEMBLE_RESULT_V1>>>` — missing the "AI_" segment —
   * and the parser accepted it anyway (decoding reached the content stage).
   * That tolerance existed by accident; this pins it deliberately as a single
   * enumerated alias, not a pattern.
   */
  void it("accepts the observed legacy terminator and reports the recovery", () => {
    const seen: number[] = [];
    setLegacyFrameEndObserverV1(() => seen.push(1));
    try {
      const payload = { version: 1, correlation: correlation(), kind: "cancelled" as const };
      const raw = `<<<ENSEMBLE_AI_RESULT_V1>>>\n${JSON.stringify(payload)}\n<<<END_ENSEMBLE_RESULT_V1>>>`;
      const result = parseAiResultEnvelopeV1(raw);
      assert.equal(result.kind, "cancelled", "the legacy terminator must still close the frame");
      assert.deepEqual(seen, [1], "the tolerance must be observable, never silent");
    } finally {
      setLegacyFrameEndObserverV1(undefined);
    }
  });

  void it("does NOT report anything for the canonical terminator", () => {
    const seen: number[] = [];
    setLegacyFrameEndObserverV1(() => seen.push(1));
    try {
      const payload = { version: 1, correlation: correlation(), kind: "cancelled" as const };
      assert.equal(
        parseAiResultEnvelopeV1(frame(payload)).kind,
        "cancelled"
      );
      assert.deepEqual(seen, []);
    } finally {
      setLegacyFrameEndObserverV1(undefined);
    }
  });

  void it("still rejects arbitrary near-miss markers, not just any END_* variant", () => {
    const payload = { version: 1, correlation: correlation(), kind: "cancelled" as const };
    for (const badEnd of [
      "<<<END_ENSEMBLE_AI_RESULT_V2>>>",
      "<<<END-ENSEMBLE_AI_RESULT_V1>>>",
      "<<<ENSEMBLE_AI_RESULT_V1_END>>>",
      "<<<END_ENSEMBLE_RESULT>>>",
    ]) {
      const raw = `<<<ENSEMBLE_AI_RESULT_V1>>>\n${JSON.stringify(payload)}\n${badEnd}`;
      const result = parseAiResultEnvelopeV1(raw);
      assert.notEqual(
        result.kind,
        "cancelled",
        `${badEnd} must not be treated as a valid terminator`
      );
    }
  });
});

void describe("parseAiResultEnvelopeV1 — a real model-authored clarifying question", () => {
  /**
   * The exact payload GitHub Copilot (`auto`) returned for a `draft.v1`
   * action on 2026-08-15, recovered from the provider-result spool. It was
   * rejected as `contentSchemaMismatch`, which read as "Copilot is broken at
   * the desc stage" and cost two sessions to diagnose.
   *
   * Nothing was wrong with it. The task said "make sure there are no security
   * vulnerabilities in this web app", and the draft prompt tells a model to
   * ask rather than guess when it needs clarification — so it asked which app.
   * The contract documented `{"questionId","kind","prompt","required",...}`;
   * the decoder additionally demanded `allowBlank` and `maxLength`, hidden
   * behind that ellipsis. The model obeyed the contract it was given.
   *
   * Not provider-specific: any model that asks a question sent this shape.
   * This is the corpus's only genuinely model-authored question — every other
   * fixture is hand-written to whatever the decoder wanted, which is exactly
   * how the gap survived.
   */
  void it("accepts the four documented fields, with answer-box behaviour supplied by the app", () => {
    const raw = frame({
      version: 1,
      correlation: correlation({ actionKey: "draft.v1" }),
      kind: "questions",
      questions: [
        {
          questionId: "security-scope",
          kind: "text",
          prompt:
            "What web app, repository, or specific feature should be secured, and are there known vulnerabilities or security requirements to address?",
          required: true,
        },
      ],
    });

    const result = parseAiResultEnvelopeV1(raw, correlation({ actionKey: "draft.v1" }));
    assert.equal(result.kind, "questions", "a model asking for clarification must not be rejected");
    if (result.kind === "questions") {
      const q = result.questions[0];
      assert.equal(q?.questionId, "security-scope");
      if (q?.kind === "text") {
        assert.equal(q.allowBlank, false, "required question => blank is not an answer");
        assert.equal(q.maxLength, DEFAULT_TEXT_ANSWER_MAX_LENGTH_V1, "the app owns the box size");
      }
    }
  });

  void it("rejects allowBlank/maxLength from a fresh envelope, even matching what the app would derive", () => {
    // This is the fresh-envelope path (parseAiResultEnvelopeV1 -> the strict
    // decodeStructuredQuestionsFromProviderV1), NOT the persisted-replay path
    // — a stored transaction's questions are decoded directly from the
    // transaction record by chatInteractionTransactionV1.ts, which still
    // calls the tolerant decodeStructuredQuestionsV1 so questionSetSha256
    // keeps round-tripping. A model has no basis to send either field
    // (owner decision, 2026-08-16), so fresh output supplying them — even
    // values the app would have derived on its own — is rejected outright.
    for (const field of ["allowBlank", "maxLength"] as const) {
      const raw = frame({
        version: 1,
        correlation: correlation(),
        kind: "questions",
        questions: [
          {
            questionId: "q1",
            kind: "text",
            prompt: "Which module?",
            required: true,
            ...(field === "allowBlank" ? { allowBlank: true } : { maxLength: 200 }),
          },
        ],
      });
      const result = parseAiResultEnvelopeV1(raw, correlation());
      assert.equal(result.kind, "malformed", `fresh "${field}" must be rejected`);
    }
  });
});
