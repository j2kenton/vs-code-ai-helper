import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canonicalJsonByteLengthV1,
  CanonicalJsonErrorV1,
  decodeStructuredAnswersArrayV1,
  MAX_ANSWER_SUBMISSION_CANONICAL_BYTES_V1,
  MAX_OPTIONS_V1,
  MAX_QUESTION_SET_CANONICAL_BYTES_V1,
  MAX_QUESTIONS_V1,
} from "../types/structuredQuestionV1";

void describe("decodeStructuredAnswersArrayV1", () => {
  void it("decodes a valid text answer from unknown", () => {
    const result = decodeStructuredAnswersArrayV1([
      { questionId: "q1", kind: "text", state: "answered", value: "hello" },
    ]);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.answers.length, 1);
      assert.equal(result.answers[0]!.kind, "text");
    }
  });

  void it("decodes a valid skipped answer from unknown", () => {
    const result = decodeStructuredAnswersArrayV1([
      { questionId: "q1", kind: "text", state: "skipped" },
    ]);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.answers.length, 1);
      assert.equal(result.answers[0]!.state, "skipped");
    }
  });

  void it("decodes a valid singleChoice answer from unknown", () => {
    const result = decodeStructuredAnswersArrayV1([
      { questionId: "q1", kind: "singleChoice", state: "answered", selectedOptionId: "opt1" },
    ]);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.answers[0]!.kind, "singleChoice");
    }
  });

  void it("decodes a valid multipleChoice answer from unknown", () => {
    const result = decodeStructuredAnswersArrayV1([
      { questionId: "q1", kind: "multipleChoice", state: "answered", selectedOptionIds: ["a", "b"] },
    ]);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.answers[0]!.kind, "multipleChoice");
    }
  });

  void it("rejects an answer with an unknown field", () => {
    const result = decodeStructuredAnswersArrayV1([
      { questionId: "q1", kind: "text", state: "answered", value: "hi", bogus: "field" },
    ]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /unknown field/);
    }
  });

  void it("rejects a skipped answer with an unknown field", () => {
    const result = decodeStructuredAnswersArrayV1([
      { questionId: "q1", kind: "text", state: "skipped", extraData: "nope" },
    ]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /unknown field/);
    }
  });

  void it("rejects a singleChoice answer with an unknown field", () => {
    const result = decodeStructuredAnswersArrayV1([
      { questionId: "q1", kind: "singleChoice", state: "answered", selectedOptionId: "a", extra: "bad" },
    ]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /unknown field/);
    }
  });

  void it("rejects a multipleChoice answer with an unknown field", () => {
    const result = decodeStructuredAnswersArrayV1([
      {
        questionId: "q1",
        kind: "multipleChoice",
        state: "answered",
        selectedOptionIds: ["a"],
        extraField: "bad",
      },
    ]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /unknown field/);
    }
  });

  void it("rejects a non-array input", () => {
    const result = decodeStructuredAnswersArrayV1({ not: "array" });
    assert.equal(result.ok, false);
  });

  void it("rejects a non-object entry", () => {
    const result = decodeStructuredAnswersArrayV1(["string"]);
    assert.equal(result.ok, false);
  });

  void it("rejects an unrecognized state value", () => {
    const result = decodeStructuredAnswersArrayV1([
      { questionId: "q1", kind: "text", state: "nonexistent" },
    ]);
    assert.equal(result.ok, false);
  });

  void it("rejects an unrecognized answer kind", () => {
    const result = decodeStructuredAnswersArrayV1([
      { questionId: "q1", kind: "weirdKind", state: "answered", value: "hi" },
    ]);
    assert.equal(result.ok, false);
  });

  void it("rejects an empty answer array (one record per question is required)", () => {
    const result = decodeStructuredAnswersArrayV1([]);
    assert.equal(result.ok, false);
  });

  void it("rejects more answers than the maximum question count", () => {
    const tooMany = Array.from({ length: MAX_QUESTIONS_V1 + 1 }, (_, i) => ({
      questionId: `q${i}`,
      kind: "text",
      state: "skipped",
    }));
    const result = decodeStructuredAnswersArrayV1(tooMany);
    assert.equal(result.ok, false);
  });

  void it("rejects a questionId that is not a bounded ASCII identifier", () => {
    const result = decodeStructuredAnswersArrayV1([
      { questionId: "has interior spaces", kind: "text", state: "answered", value: "hi" },
    ]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /questionId/);
    }
  });

  void it("rejects a selectedOptionId that is not a bounded ASCII identifier", () => {
    const result = decodeStructuredAnswersArrayV1([
      { questionId: "q1", kind: "singleChoice", state: "answered", selectedOptionId: "not ok" },
    ]);
    assert.equal(result.ok, false);
  });

  void it("rejects duplicate selected option ids", () => {
    const result = decodeStructuredAnswersArrayV1([
      { questionId: "q1", kind: "multipleChoice", state: "answered", selectedOptionIds: ["a", "a"] },
    ]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /duplicate/);
    }
  });

  void it("rejects more selections than the maximum option count", () => {
    const tooMany = Array.from({ length: MAX_OPTIONS_V1 + 1 }, (_, i) => `opt${i}`);
    const result = decodeStructuredAnswersArrayV1([
      { questionId: "q1", kind: "multipleChoice", state: "answered", selectedOptionIds: tooMany },
    ]);
    assert.equal(result.ok, false);
  });
});

void describe("canonicalJsonByteLengthV1", () => {
  void it("computes byte length for a simple array of objects", () => {
    const questions = [
      { questionId: "q1", kind: "text", prompt: "Test?", required: true, allowBlank: false, maxLength: 100 },
    ];
    const bytes = canonicalJsonByteLengthV1(questions);
    assert.ok(bytes > 0);
    assert.ok(bytes < MAX_QUESTION_SET_CANONICAL_BYTES_V1);
  });

  void it("returns a value close to MAX_QUESTION_SET_CANONICAL_BYTES_V1 for a near-limit input", () => {
    const bigPrompt = "x".repeat(200 * 1024);
    const questions = [
      { questionId: "q1", kind: "text", prompt: bigPrompt, required: true, allowBlank: false, maxLength: 10 },
    ];
    const bytes = canonicalJsonByteLengthV1(questions);
    assert.ok(bytes < MAX_QUESTION_SET_CANONICAL_BYTES_V1 + 1024);
    assert.ok(bytes > 200 * 1024);
  });

  void it("returns a value exceeding MAX_ANSWER_SUBMISSION_CANONICAL_BYTES_V1 for a large answer", () => {
    const answers = [
      { questionId: "q1", kind: "text", state: "answered", value: "x".repeat(200 * 1024) },
    ];
    const bytes = canonicalJsonByteLengthV1(answers);
    assert.ok(bytes > MAX_ANSWER_SUBMISSION_CANONICAL_BYTES_V1);
  });

  void it("produces consistent output for the same input", () => {
    const input = [
      { questionId: "q1", kind: "text", prompt: "Same?", required: true, allowBlank: false, maxLength: 10 },
    ];
    const a = canonicalJsonByteLengthV1(input);
    const b = canonicalJsonByteLengthV1(input);
    assert.equal(a, b);
  });

  void it("handles null values", () => {
    const bytes = canonicalJsonByteLengthV1(null);
    assert.equal(bytes, 4);
  });

  void it("handles boolean values", () => {
    assert.equal(canonicalJsonByteLengthV1(true), 4);
    assert.equal(canonicalJsonByteLengthV1(false), 5);
  });

  void it("handles number values", () => {
    assert.ok(canonicalJsonByteLengthV1(42) > 0);
  });

  void it("throws CanonicalJsonErrorV1 on cyclic values instead of overflowing the stack", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.throws(() => canonicalJsonByteLengthV1(cyclic), CanonicalJsonErrorV1);
    const cyclicArray: unknown[] = [];
    cyclicArray.push(cyclicArray);
    assert.throws(() => canonicalJsonByteLengthV1(cyclicArray), CanonicalJsonErrorV1);
  });

  void it("accepts repeated (non-cyclic) references to the same object", () => {
    const shared = { a: 1 };
    assert.ok(canonicalJsonByteLengthV1([shared, shared]) > 0);
  });

  void it("throws CanonicalJsonErrorV1 on non-JSON value types", () => {
    assert.throws(() => canonicalJsonByteLengthV1(undefined), CanonicalJsonErrorV1);
    assert.throws(() => canonicalJsonByteLengthV1(() => 1), CanonicalJsonErrorV1);
    assert.throws(() => canonicalJsonByteLengthV1(BigInt(1)), CanonicalJsonErrorV1);
    assert.throws(() => canonicalJsonByteLengthV1({ value: undefined }), CanonicalJsonErrorV1);
  });

  void it("throws CanonicalJsonErrorV1 on non-finite numbers", () => {
    assert.throws(() => canonicalJsonByteLengthV1(Number.POSITIVE_INFINITY), CanonicalJsonErrorV1);
    assert.throws(() => canonicalJsonByteLengthV1([Number.NaN]), CanonicalJsonErrorV1);
  });
});
