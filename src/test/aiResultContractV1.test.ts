/**
 * Coverage for the AI result-contract prompt fragment (plan §3.8,
 * `src/prompts/aiResultContractV1.ts`) — previously untested. Added
 * 2026-08-07 alongside the closing reminder line (a defense-in-depth
 * complement to taskActionCoordinatorV1.ts's frameless-content fallback,
 * both responses to the same day's four live invalidFrame incidents on the
 * "workflow" task).
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ActionCorrelationV1, allocateHex128IdV1 } from "../types/actionCorrelationV1";
import {
  AiResultContractPromptErrorV1,
  buildAiResultContractPromptV1,
} from "../prompts/aiResultContractV1";

function makeCorrelation(): ActionCorrelationV1 {
  return {
    actionKey: "contractTestAction.v1",
    operationId: allocateHex128IdV1(),
    attemptId: allocateHex128IdV1(),
    taskBindingId: "task-binding-digest",
    chatDocumentId: "chat-document-id",
  };
}

void describe("buildAiResultContractPromptV1", () => {
  void it("emits the frame markers and echoes the correlation verbatim", () => {
    const correlation = makeCorrelation();
    const text = buildAiResultContractPromptV1({
      correlation,
      permittedResultKinds: ["completed"],
      completedContentType: "markdown-artifact.v1",
      maxResponseBytes: 4096,
    });
    assert.match(text, /<<<ENSEMBLE_AI_RESULT_V1>>>/);
    assert.match(text, /<<<END_ENSEMBLE_AI_RESULT_V1>>>/);
    assert.ok(text.includes(correlation.operationId), "must echo the operationId");
    assert.ok(text.includes(correlation.attemptId), "must echo the attemptId");
  });

  void it("ends with a reminder restating the frame requirement as the last line", () => {
    // 2026-08-06/07 live incidents: four reviews on the "workflow" task did
    // real, correct work but never emitted the frame at all, each one
    // narrating its own verification process right up to the final answer.
    // This reminder is the closing line of the whole fragment deliberately —
    // this pins that it stays there rather than drifting earlier under a
    // future edit.
    const text = buildAiResultContractPromptV1({
      correlation: makeCorrelation(),
      permittedResultKinds: ["completed"],
      completedContentType: "markdown-artifact.v1",
      maxResponseBytes: 4096,
    });
    const lines = text.split("\n");
    assert.equal(lines[lines.length - 1], "=== END ENSEMBLE RESULT CONTRACT ===");
    assert.match(lines[lines.length - 2] ?? "", /REMINDER:.*<<<ENSEMBLE_AI_RESULT_V1>>>/);
    assert.match(lines[lines.length - 2] ?? "", /let me check|let me verify/i);
  });

  void it("is deterministic — identical input produces identical output", () => {
    const correlation = makeCorrelation();
    const input = {
      correlation,
      permittedResultKinds: ["completed", "questions"] as const,
      completedContentType: "chat-message.v1" as const,
      maxResponseBytes: 8192,
    };
    assert.equal(buildAiResultContractPromptV1(input), buildAiResultContractPromptV1(input));
  });

  void it("includes the shape hint for the declared completed-content type only", () => {
    const text = buildAiResultContractPromptV1({
      correlation: makeCorrelation(),
      permittedResultKinds: ["completed"],
      completedContentType: "commit-metadata.v1",
      maxResponseBytes: 4096,
    });
    assert.match(text, /"contentType":"commit-metadata\.v1"/);
    assert.doesNotMatch(text, /"contentType":"markdown-artifact\.v1"/);
  });

  void it("throws when no result kinds are permitted", () => {
    assert.throws(
      () =>
        buildAiResultContractPromptV1({
          correlation: makeCorrelation(),
          permittedResultKinds: [],
          completedContentType: "none",
          maxResponseBytes: 4096,
        }),
      AiResultContractPromptErrorV1
    );
  });

  void it("throws when \"completed\" is permitted without a completed-content type", () => {
    assert.throws(
      () =>
        buildAiResultContractPromptV1({
          correlation: makeCorrelation(),
          permittedResultKinds: ["completed"],
          completedContentType: "none",
          maxResponseBytes: 4096,
        }),
      AiResultContractPromptErrorV1
    );
  });

  void it("throws when a completed-content type is declared but \"completed\" is not permitted", () => {
    assert.throws(
      () =>
        buildAiResultContractPromptV1({
          correlation: makeCorrelation(),
          permittedResultKinds: ["cancelled"],
          completedContentType: "markdown-artifact.v1",
          maxResponseBytes: 4096,
        }),
      AiResultContractPromptErrorV1
    );
  });
});
