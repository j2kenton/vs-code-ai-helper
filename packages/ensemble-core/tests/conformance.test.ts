/**
 * Dual-decode conformance suite (plan Part 2 / acceptance criterion 7a).
 *
 * Every fixture under test-fixtures/structured-questions/,
 * test-fixtures/chat-transactions/, and test-fixtures/task-progress/ is run
 * through BOTH the extension's decoder/validator (imported directly from
 * `src/`) and the @ensemble/core codec: every valid fixture must decode
 * identically under both, and every invalid fixture must be rejected by
 * both. This is the drift detector between `src` and `ensemble-core` — the
 * extension keeps its own codecs and never imports this package, so this
 * suite is the only mechanical link. It follows the exact-enumeration
 * mechanism `scripts/verifyStructuredQuestions.mjs` established: fixture
 * directories are enumerated exhaustively, and an unclassified file is a
 * failure, not a skip.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

// --- ensemble-core codecs ---------------------------------------------------
import * as coreQuestions from "../src/structuredQuestionV1";
import * as coreChat from "../src/chatInteractionTransactionV1";
import * as coreProgress from "../src/taskProgressDecoderV1";
import { sha256HexUtf8V1 } from "../src/sha256V1";
import { buildAiResultContractPromptV1 as coreBuildContractPrompt } from "../src/aiResultContractV1";
import { allocateHex128IdV1 as coreAllocateHex128IdV1 } from "../src/actionCorrelationV1";

// --- the extension's own decoders (parity oracles) --------------------------
import * as srcQuestions from "../../../src/types/structuredQuestionV1";
import * as srcChat from "../../../src/types/chatInteractionTransactionV1";
import * as srcProgress from "../../../src/services/taskProgressDecoderV1";
import { buildAiResultContractPromptV1 as srcBuildContractPrompt } from "../../../src/prompts/aiResultContractV1";
import { allocateHex128IdV1 as srcAllocateHex128IdV1 } from "../../../src/types/actionCorrelationV1";

function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error("could not locate the repository root (pnpm-workspace.yaml) above " + __dirname);
}

const repoRoot = findRepoRoot();
const fixturesRoot = path.join(repoRoot, "test-fixtures");

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function listJsonFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
}

// ---------------------------------------------------------------------------
// SHA-256 self-test: the core package carries its own dependency-free SHA-256
// (Node crypto is what produced every fixture digest); pin it to the FIPS
// vectors before trusting it in the digest-bearing decodes below.
// ---------------------------------------------------------------------------

test("sha256V1 matches the FIPS 180-4 test vectors", () => {
  assert.equal(
    sha256HexUtf8V1(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  );
  assert.equal(
    sha256HexUtf8V1("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
  assert.equal(
    sha256HexUtf8V1("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
  );
  // Multi-block (>64 bytes) and non-ASCII UTF-8 coverage, cross-checked
  // against Node's own crypto.
  assert.equal(
    sha256HexUtf8V1("a".repeat(1000)),
    "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3"
  );
});

// ---------------------------------------------------------------------------
// Constant parity: the numeric bounds and identifier pattern must be the
// same in both implementations, or verdict parity below is accidental.
// ---------------------------------------------------------------------------

test("structured-question constants match the extension's", () => {
  assert.equal(coreQuestions.MIN_QUESTIONS_V1, srcQuestions.MIN_QUESTIONS_V1);
  assert.equal(coreQuestions.MAX_QUESTIONS_V1, srcQuestions.MAX_QUESTIONS_V1);
  assert.equal(
    coreQuestions.DEFAULT_TEXT_ANSWER_MAX_LENGTH_V1,
    srcQuestions.DEFAULT_TEXT_ANSWER_MAX_LENGTH_V1
  );
  assert.equal(coreQuestions.MIN_OPTIONS_V1, srcQuestions.MIN_OPTIONS_V1);
  assert.equal(coreQuestions.MAX_OPTIONS_V1, srcQuestions.MAX_OPTIONS_V1);
  assert.equal(
    coreQuestions.MAX_QUESTION_SET_CANONICAL_BYTES_V1,
    srcQuestions.MAX_QUESTION_SET_CANONICAL_BYTES_V1
  );
  assert.equal(
    coreQuestions.MAX_ANSWER_SUBMISSION_CANONICAL_BYTES_V1,
    srcQuestions.MAX_ANSWER_SUBMISSION_CANONICAL_BYTES_V1
  );
  assert.equal(coreQuestions.STABLE_ID_PATTERN_V1.source, srcQuestions.STABLE_ID_PATTERN_V1.source);
  assert.equal(
    coreChat.MAX_INPUT_SNAPSHOT_CANONICAL_BYTES_V1,
    srcChat.MAX_INPUT_SNAPSHOT_CANONICAL_BYTES_V1
  );
  assert.equal(coreChat.MAX_TRANSITION_RECEIPTS_V1, srcChat.MAX_TRANSITION_RECEIPTS_V1);
  assert.deepEqual(
    [...coreProgress.TASK_PROGRESS_PRODUCT_FIELD_NAMES_V1],
    [...srcProgress.TASK_PROGRESS_PRODUCT_FIELD_NAMES_V1]
  );
});

// ---------------------------------------------------------------------------
// Corpus 1: structured questions/answers
// ---------------------------------------------------------------------------

/**
 * Exact classification of every structured-question fixture, mirroring the
 * roster in scripts/verifyStructuredQuestions.mjs (contract only — the
 * expected verdict is not repeated here; verify:structured-questions already
 * pins it against `src`, and this suite pins core against `src`).
 */
const QUESTION_FIXTURE_CONTRACTS: Record<string, "questions" | "answers"> = {
  "valid-text.json": "questions",
  "valid-text-app-owned-answer-box.json": "questions",
  "valid-single-choice.json": "questions",
  "valid-multiple-choice.json": "questions",
  "valid-mixed.json": "questions",
  "empty-questions.json": "questions",
  "too-many-questions.json": "questions",
  "unknown-field-on-question.json": "questions",
  "unknown-field-on-option.json": "questions",
  "duplicate-question-ids.json": "questions",
  "duplicate-option-ids.json": "questions",
  "selection-bounds-exceed-options.json": "questions",
  "invalid-question-id-pattern.json": "questions",
  "too-few-options.json": "questions",
  "valid-text-copilot-security-scope.json": "questions",
  "allow-blank-only-on-text-question.json": "questions",
  "max-length-only-on-text-question.json": "questions",
  "end-to-end-answers.json": "answers",
  "end-to-end-answers-skip-required.json": "answers",
  "unknown-field-on-skipped-answer.json": "answers",
  "unknown-field-on-text-answer.json": "answers",
  "empty-answers.json": "answers",
  "duplicate-selected-option-ids.json": "answers",
  "invalid-answer-question-id-pattern.json": "answers",
};

test("structured-questions corpus: dual decode agrees for every fixture", () => {
  const dir = path.join(fixturesRoot, "structured-questions");
  const files = listJsonFiles(dir);
  for (const name of files) {
    assert.ok(
      name in QUESTION_FIXTURE_CONTRACTS,
      `unclassified structured-question fixture ${name} — classify it in this suite`
    );
  }
  for (const name of Object.keys(QUESTION_FIXTURE_CONTRACTS)) {
    assert.ok(files.includes(name), `classified fixture ${name} is missing on disk`);
  }
  for (const name of files) {
    const data = readJson(path.join(dir, name));
    if (QUESTION_FIXTURE_CONTRACTS[name] === "questions") {
      const fromSrc = srcQuestions.decodeStructuredQuestionsV1(data);
      const fromCore = coreQuestions.decodeStructuredQuestionsV1(data);
      assert.equal(
        fromCore.ok,
        fromSrc.ok,
        `${name}: verdict divergence (src ${fromSrc.ok ? "valid" : `invalid: ${fromSrc.reason}`}, ` +
          `core ${fromCore.ok ? "valid" : `invalid: ${fromCore.reason}`})`
      );
      if (fromSrc.ok && fromCore.ok) {
        assert.deepEqual(fromCore.questions, fromSrc.questions, `${name}: decoded questions differ`);
        assert.equal(
          coreQuestions.canonicalJsonTextV1(fromCore.questions),
          srcQuestions.canonicalJsonTextV1(fromSrc.questions),
          `${name}: canonical JSON text differs`
        );
      }

      // Cross-check the strict FRESH-envelope ("wire") decoder too — until
      // this assertion, `decodeStructuredQuestionsFromProviderV1` had no
      // dual-decode parity test at all, so `packages/ensemble-core` and
      // `src` could silently diverge on which fields a model may send
      // without either verifier noticing.
      const fromSrcWire = srcQuestions.decodeStructuredQuestionsFromProviderV1(data);
      const fromCoreWire = coreQuestions.decodeStructuredQuestionsFromProviderV1(data);
      assert.equal(
        fromCoreWire.ok,
        fromSrcWire.ok,
        `${name}: wire-decoder verdict divergence (src ${fromSrcWire.ok ? "valid" : `invalid: ${fromSrcWire.reason}`}, ` +
          `core ${fromCoreWire.ok ? "valid" : `invalid: ${fromCoreWire.reason}`})`
      );
      if (fromSrcWire.ok && fromCoreWire.ok) {
        assert.deepEqual(fromCoreWire.questions, fromSrcWire.questions, `${name}: wire-decoded questions differ`);
      }
    } else {
      const fromSrc = srcQuestions.decodeStructuredAnswersArrayV1(data);
      const fromCore = coreQuestions.decodeStructuredAnswersArrayV1(data);
      assert.equal(
        fromCore.ok,
        fromSrc.ok,
        `${name}: verdict divergence (src ${fromSrc.ok ? "valid" : `invalid: ${fromSrc.reason}`}, ` +
          `core ${fromCore.ok ? "valid" : `invalid: ${fromCore.reason}`})`
      );
      if (fromSrc.ok && fromCore.ok) {
        assert.deepEqual(fromCore.answers, fromSrc.answers, `${name}: decoded answers differ`);
      }
    }
  }
});

test("structured-questions corpus: paired answer validation agrees", () => {
  const dir = path.join(fixturesRoot, "structured-questions");
  const pairs: Array<{ answers: string; questions: string }> = [
    { answers: "end-to-end-answers.json", questions: "valid-mixed.json" },
    { answers: "end-to-end-answers-skip-required.json", questions: "valid-mixed.json" },
  ];
  for (const pair of pairs) {
    const questionData = readJson(path.join(dir, pair.questions));
    const answerData = readJson(path.join(dir, pair.answers));

    const srcQ = srcQuestions.decodeStructuredQuestionsV1(questionData);
    const srcA = srcQuestions.decodeStructuredAnswersArrayV1(answerData);
    const coreQ = coreQuestions.decodeStructuredQuestionsV1(questionData);
    const coreA = coreQuestions.decodeStructuredAnswersArrayV1(answerData);
    assert.ok(srcQ.ok && srcQ.questions && srcA.ok, `${pair.answers}: src side must decode`);
    assert.ok(coreQ.ok && coreQ.questions && coreA.ok, `${pair.answers}: core side must decode`);

    const srcVerdict = srcQuestions.validateStructuredAnswersV1(srcQ.questions, srcA.answers);
    const coreVerdict = coreQuestions.validateStructuredAnswersV1(coreQ.questions, coreA.answers);
    assert.equal(
      coreVerdict.ok,
      srcVerdict.ok,
      `${pair.answers}: paired validation diverges (src ${srcVerdict.ok}, core ${coreVerdict.ok})`
    );
  }
});

test("textAnswerPolicyV1: core and src agree, and both ignore a historical stored maxLength", () => {
  // max-length-only-on-text-question.json carries a PERSISTED-shaped
  // maxLength (500) that is deliberately non-default, exactly the shape the
  // 2026-08-16 owner decision says must NOT drive runtime behaviour: only
  // DEFAULT_TEXT_ANSWER_MAX_LENGTH_V1 (app-owned) may.
  const dir = path.join(fixturesRoot, "structured-questions");
  const data = readJson(path.join(dir, "max-length-only-on-text-question.json"));
  const fromSrc = srcQuestions.decodeStructuredQuestionsV1(data);
  const fromCore = coreQuestions.decodeStructuredQuestionsV1(data);
  assert.ok(fromSrc.ok && fromSrc.questions && fromSrc.questions.length === 1, "src must decode the persisted fixture");
  assert.ok(fromCore.ok && fromCore.questions && fromCore.questions.length === 1, "core must decode the persisted fixture");
  if (!fromSrc.ok || !fromSrc.questions || !fromCore.ok || !fromCore.questions) return;
  const srcQuestion = fromSrc.questions[0];
  const coreQuestion = fromCore.questions[0];
  assert.ok(srcQuestion && coreQuestion, "both sides must decode exactly one question");
  if (!srcQuestion || !coreQuestion) return;
  assert.equal(srcQuestion.kind, "text");
  assert.equal(coreQuestion.kind, "text");
  if (srcQuestion.kind !== "text" || coreQuestion.kind !== "text") return;

  // The decoded question still round-trips the historical 500 (needed for
  // questionSetSha256), but the policy function must ignore it.
  assert.equal(srcQuestion.maxLength, 500);
  assert.equal(coreQuestion.maxLength, 500);

  const srcPolicy = srcQuestions.textAnswerPolicyV1(srcQuestion);
  const corePolicy = coreQuestions.textAnswerPolicyV1(coreQuestion);
  assert.deepEqual(corePolicy, srcPolicy, "core and src policy must agree");
  assert.equal(srcPolicy.maxLength, srcQuestions.DEFAULT_TEXT_ANSWER_MAX_LENGTH_V1);
  assert.equal(srcPolicy.allowBlank, !srcQuestion.required);

  // An answer longer than the historical 500 but within the app default of
  // 4000 must be ACCEPTED — proving validateStructuredAnswersV1 itself (not
  // just the standalone policy function) no longer honours the stored value.
  const longAnswer = "x".repeat(600);
  const srcVerdict = srcQuestions.validateStructuredAnswersV1(fromSrc.questions, [
    { questionId: "q1", kind: "text", state: "answered", value: longAnswer },
  ]);
  const coreVerdict = coreQuestions.validateStructuredAnswersV1(fromCore.questions, [
    { questionId: "q1", kind: "text", state: "answered", value: longAnswer },
  ]);
  assert.equal(srcVerdict.ok, true, `src: ${srcVerdict.reason ?? ""}`);
  assert.equal(coreVerdict.ok, true, `core: ${coreVerdict.reason ?? ""}`);
});

test("aiResultContractV1: core and src emit byte-identical \"questions\" contract text", () => {
  // The literal per-kind examples (added 2026-08-16 to replace the "..."
  // ellipsis that caused a live contentSchemaMismatch) must stay identical
  // between the extension's prompt builder and this package's port, or the
  // two codebases could silently start telling models different contracts
  // again.
  const correlation = {
    actionKey: "contractParityTestAction.v1",
    operationId: srcAllocateHex128IdV1(),
    attemptId: srcAllocateHex128IdV1(),
    taskBindingId: "task-binding-digest",
    chatDocumentId: "chat-document-id",
  };
  assert.equal(typeof coreAllocateHex128IdV1(), "string", "core allocator must be callable");

  const srcText = srcBuildContractPrompt({
    correlation,
    permittedResultKinds: ["completed", "questions"],
    completedContentType: "markdown-artifact.v1",
    maxResponseBytes: 4096,
  });
  const coreText = coreBuildContractPrompt({
    correlation,
    permittedResultKinds: ["completed", "questions"],
    completedContentType: "markdown-artifact.v1",
    maxResponseBytes: 4096,
  });
  assert.equal(coreText, srcText, "core and src must emit byte-identical contract prompts");
  assert.doesNotMatch(srcText, /"prompt","required",\.\.\.\}/, "the questions contract must not regress to an ellipsis");
});

// ---------------------------------------------------------------------------
// Corpus 2: chat interaction transactions
// ---------------------------------------------------------------------------

test("chat-transactions corpus: dual decode agrees for every fixture", () => {
  const dir = path.join(fixturesRoot, "chat-transactions");
  const files = listJsonFiles(dir);
  assert.ok(files.length > 0, "chat-transactions fixture directory is empty");
  for (const name of files) {
    const expectValid = name.startsWith("valid-");
    assert.ok(
      expectValid || name.startsWith("invalid-"),
      `chat-transaction fixture ${name} has no valid-/invalid- polarity prefix`
    );
    const data = readJson(path.join(dir, name));
    const fromSrc = srcChat.decodeChatInteractionTransactionV1(data);
    const fromCore = coreChat.decodeChatInteractionTransactionV1(data);
    assert.equal(
      fromSrc.ok,
      expectValid,
      `${name}: extension decoder says ${fromSrc.ok ? "valid" : `invalid (${fromSrc.ok === false ? fromSrc.reason : ""})`} ` +
        `but the fixture is classified ${expectValid ? "valid" : "invalid"}`
    );
    assert.equal(
      fromCore.ok,
      fromSrc.ok,
      `${name}: verdict divergence (src ${fromSrc.ok}, core ${
        fromCore.ok ? "valid" : `invalid: ${fromCore.ok === false ? fromCore.reason : ""}`
      })`
    );
    if (fromSrc.ok && fromCore.ok) {
      assert.deepEqual(fromCore.transaction, fromSrc.transaction, `${name}: decoded transactions differ`);
    }
  }
});

// ---------------------------------------------------------------------------
// Corpus 3: task progress
// ---------------------------------------------------------------------------

function assertProgressDualDecode(name: string, text: string, expectValid: boolean): void {
  const fromSrc = srcProgress.decodeTaskProgressTextV1(text);
  const fromCore = coreProgress.decodeTaskProgressTextV1(text);
  assert.equal(
    fromSrc.ok,
    expectValid,
    `${name}: extension decoder says ${fromSrc.ok ? "valid" : `invalid (${fromSrc.ok === false ? fromSrc.code : ""})`} ` +
      `but the fixture is classified ${expectValid ? "valid" : "invalid"}`
  );
  assert.equal(
    fromCore.ok,
    fromSrc.ok,
    `${name}: verdict divergence (src ${fromSrc.ok}, core ${fromCore.ok})`
  );
  if (!fromSrc.ok && !fromCore.ok) {
    assert.equal(fromCore.code, fromSrc.code, `${name}: recovery code divergence`);
  }
  if (fromSrc.ok && fromCore.ok) {
    assert.equal(fromCore.decoded.family, fromSrc.decoded.family, `${name}: family differs`);
    assert.deepEqual(fromCore.decoded.progress, fromSrc.decoded.progress, `${name}: decoded progress differs`);
    assert.deepEqual(fromCore.decoded.entries, fromSrc.decoded.entries, `${name}: document entries differ`);
    assert.equal(
      fromCore.decoded.wasEnvelopeWrapped,
      fromSrc.decoded.wasEnvelopeWrapped,
      `${name}: envelope flag differs`
    );
  }
  // The lightweight version selector must agree with the full decode's
  // family/verdict path in both implementations.
  const srcSelect = srcProgress.selectTaskProgressFamilyV1(text);
  const coreSelect = coreProgress.selectTaskProgressFamilyV1(text);
  assert.equal(coreSelect.ok, srcSelect.ok, `${name}: family selection verdict diverges`);
  if (srcSelect.ok && coreSelect.ok) {
    assert.equal(coreSelect.family, srcSelect.family, `${name}: selected family diverges`);
  }
}

test("task-progress corpus: legacy/ and v1/ decode identically under both", () => {
  for (const family of ["legacy", "v1"]) {
    const dir = path.join(fixturesRoot, "task-progress", family);
    const files = listJsonFiles(dir);
    assert.ok(files.length > 0, `task-progress/${family} fixture directory is empty`);
    for (const name of files) {
      const text = fs.readFileSync(path.join(dir, name), "utf8");
      assertProgressDualDecode(`${family}/${name}`, text, true);
    }
  }
});

test("task-progress corpus: recovery/ is rejected identically under both", () => {
  const dir = path.join(fixturesRoot, "task-progress", "recovery");
  const files = listJsonFiles(dir);
  assert.ok(files.length > 0, "task-progress/recovery fixture directory is empty");
  for (const name of files) {
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    assertProgressDualDecode(`recovery/${name}`, text, false);
  }
});

test("task-progress corpus: transitions/ input and expected documents dual-decode", () => {
  const dir = path.join(fixturesRoot, "task-progress", "transitions");
  const files = listJsonFiles(dir);
  assert.ok(files.length > 0, "task-progress/transitions fixture directory is empty");
  for (const name of files) {
    const fixture = readJson(path.join(dir, name)) as Record<string, unknown>;
    for (const side of ["input", "expected"] as const) {
      const document = fixture[side];
      assert.ok(document !== undefined, `transitions/${name} has no "${side}" document`);
      const text = JSON.stringify(document, null, 2);
      assertProgressDualDecode(`transitions/${name}#${side}`, text, true);
    }
  }
});
