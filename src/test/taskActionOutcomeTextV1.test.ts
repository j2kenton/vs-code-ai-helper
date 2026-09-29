/**
 * Coverage for the shared outcome text helpers, plus a structural regression
 * guard for the silent-failure bug they were extracted to fix.
 *
 * The bug: `handleReviewOutcomeV1` (reviewActions.ts) handled only
 * "completed", "questions", and a Publish-stage special case. A `failed` /
 * `malformedResult` / `unavailable` outcome on any OTHER review stage
 * matched no branch, so the function returned having shown the user nothing
 * — no notification — while the V1 review path also wrote no run log. The
 * observable result was a stuck "Running review…" row with no error, no
 * artifact, and no explanation anywhere but a console.log.
 *
 * Live example that produced it: Kimi Code CLI narrates before its final
 * answer ("• The file is large..."), and the strict envelope parser requires
 * the output to START with the frame marker (parseAiResultEnvelopeV1 rejects
 * any leading bytes), so a genuinely-completed review settled as
 * `malformedResult` and then vanished silently.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";
import {
  describeTaskActionFailureV1,
  describeTaskActionOutcomeForLogV1,
} from "../utils/taskActionOutcomeTextV1";

const CORRELATION = {
  actionKey: "review.v1",
  operationId: "a".repeat(32),
  attemptId: "b".repeat(32),
  taskBindingId: "tb",
  chatDocumentId: "cd",
} as const;

/** One instance of every outcome kind in the union (plan §3.7's closed set). */
const ALL_OUTCOMES: readonly TaskActionOutcomeV1[] = [
  { kind: "completed", correlation: CORRELATION, code: "completed" },
  { kind: "questions", correlation: CORRELATION, interactionId: "c".repeat(32) },
  { kind: "cancelled", correlation: CORRELATION, code: "userCancelled" },
  { kind: "failed", correlation: CORRELATION, code: "providerExploded", retryable: true },
  { kind: "malformedResult", correlation: CORRELATION, code: "invalidFrame" },
  { kind: "unavailable", code: "providerModeUnavailable" },
  { kind: "recoveryRequired", code: "taskProgressRecoveryRequired" },
  { kind: "stalePreflight", correlation: CORRELATION, planId: "plan-1" },
  {
    kind: "partialEditBlocked",
    correlation: CORRELATION,
    executionId: "exec-1",
    appliedReceiptIds: [],
  },
  { kind: "duplicateRejected", code: "operationAlreadyRunning" },
] as unknown as readonly TaskActionOutcomeV1[];

void describe("describeTaskActionOutcomeForLogV1", () => {
  void it("produces a non-empty status line for EVERY outcome kind", () => {
    for (const outcome of ALL_OUTCOMES) {
      const line = describeTaskActionOutcomeForLogV1(outcome);
      assert.ok(
        line.startsWith("Status: ") && line.length > "Status: ".length,
        `${outcome.kind} must produce a real status line, got ${JSON.stringify(line)}`
      );
    }
  });

  void it("names the untouched artifact on a questions settlement when one is given", () => {
    const withNote = describeTaskActionOutcomeForLogV1(ALL_OUTCOMES[1]!, "plan.md");
    assert.match(withNote, /instead of writing plan\.md/);
    // Optional: omitted for callers with no single target artifact.
    const withoutNote = describeTaskActionOutcomeForLogV1(ALL_OUTCOMES[1]!);
    assert.doesNotMatch(withoutNote, /instead of writing/);
  });

  void it("carries the machine-readable code, never raw provider text", () => {
    assert.match(
      describeTaskActionOutcomeForLogV1(ALL_OUTCOMES[4]!),
      /malformed result \(invalidFrame\)/
    );
    assert.match(
      describeTaskActionOutcomeForLogV1(ALL_OUTCOMES[3]!),
      /code=providerExploded, retryable=true/
    );
  });

  void it(
    "records the failing attempt's actionKey/operationId for an attemptIdentityAttachmentFailed " +
      "failure (pre-1.0.0 fixes register, Part 4 Step 8: a wrongOwner run log must name who arrived " +
      "second, not just the bookkeeping row id)",
    () => {
      const wrongOwner: TaskActionOutcomeV1 = {
        kind: "failed",
        correlation: CORRELATION,
        code: "attemptIdentityAttachmentFailed",
        retryable: false,
        detail:
          "wrongOwner: round ledger row r-1 belongs to another operation " +
          "(existing operationId=owning-op, this attempt's operationId=retry-op) — this stage can " +
          "simply be re-run: re-running its action allocates a fresh round ledger row rather than " +
          "reusing this one.",
      };
      const line = describeTaskActionOutcomeForLogV1(wrongOwner);
      assert.match(line, /\[actionKey=review\.v1, operationId=a+\]/);
      assert.match(line, /existing operationId=owning-op/);
      assert.match(line, /this attempt's operationId=retry-op/);

      // A different failed code must not gain the bracket — it is specific to
      // this one code, not every failed outcome that happens to carry a
      // correlation.
      assert.doesNotMatch(describeTaskActionOutcomeForLogV1(ALL_OUTCOMES[3]!), /\[actionKey=/);
    }
  );

  void it("appends detail when the coordinator supplied one, for OUR OWN parser/schema diagnostics only", () => {
    const withDetail: TaskActionOutcomeV1 = {
      kind: "malformedResult",
      correlation: CORRELATION,
      code: "invalidFrame",
      detail: "the response does not contain the required <<<ENSEMBLE_AI_RESULT_V1>>> frame marker anywhere",
    };
    assert.equal(
      describeTaskActionOutcomeForLogV1(withDetail),
      "Status: malformed result (invalidFrame: the response does not contain the required <<<ENSEMBLE_AI_RESULT_V1>>> frame marker anywhere)"
    );
    // No detail (the majority of malformedResult outcomes, and every one
    // built before this field existed) must render exactly as before.
    assert.equal(
      describeTaskActionOutcomeForLogV1(ALL_OUTCOMES[4]!),
      "Status: malformed result (invalidFrame)"
    );
  });

  void it("renders the reservation's provider/model identity when a completed outcome carries one", () => {
    const withProvider: TaskActionOutcomeV1 = {
      kind: "completed",
      correlation: CORRELATION,
      code: "completed",
      provider: { providerLabel: "Claude Code", storedModelId: "claude-cli:opus@max" },
    };
    assert.equal(
      describeTaskActionOutcomeForLogV1(withProvider),
      "Status: completed (completed) [Claude Code (opus@max)]"
    );
    // Absent provider (every pre-existing outcome, or an outcome kind that
    // never reaches a provider invocation) renders exactly as before.
    assert.equal(describeTaskActionOutcomeForLogV1(ALL_OUTCOMES[0]!), "Status: completed (completed)");
  });

  void it("renders the reservation's provider/model identity on a malformedResult that writes no artifact", () => {
    const withProvider: TaskActionOutcomeV1 = {
      kind: "malformedResult",
      correlation: CORRELATION,
      code: "invalidFrame",
      provider: { providerLabel: "OpenAI Codex", storedModelId: "codex-cli:gpt-5.6-sol@high" },
    };
    assert.equal(
      describeTaskActionOutcomeForLogV1(withProvider),
      "Status: malformed result (invalidFrame) [OpenAI Codex (gpt-5.6-sol@high)]"
    );
  });

  void it("records a repaired frame end marker (item 5) on the round's run-log line", () => {
    const repaired: TaskActionOutcomeV1 = {
      kind: "completed",
      correlation: CORRELATION,
      code: "completed",
      frameRepairV1: { expected: "<<<END_ENSEMBLE_AI_RESULT_V1>>>", actual: "<<<END_ENSᗩMBLE_AI_RESULT_V1>>>", index: 10 },
    };
    assert.equal(
      describeTaskActionOutcomeForLogV1(repaired),
      "Status: completed (completed)\nFrame: end marker repaired (one substituted character at index 10)"
    );
    // Absent on every ordinary completed outcome (no repair happened).
    assert.doesNotMatch(describeTaskActionOutcomeForLogV1(ALL_OUTCOMES[0]!), /Frame: end marker repaired/);
  });

  void it("records every earlier attempt's own rejection reason on the round's run-log line (item 6)", () => {
    const exhausted: TaskActionOutcomeV1 = {
      kind: "malformedResult",
      correlation: CORRELATION,
      code: "invalidEnvelope",
      detail: 'unsupported envelope "version": 99',
      priorRejectedAttemptsV1: [
        { attemptId: "attempt-1", code: "invalidFrame", detail: "expected the frame to end with <<<END...>>>" },
        { attemptId: "attempt-2", code: "invalidJson", detail: "the JSON payload is empty" },
      ],
    };
    assert.equal(
      describeTaskActionOutcomeForLogV1(exhausted),
      "Status: malformed result (invalidEnvelope: unsupported envelope \"version\": 99)\n" +
        "Attempt attempt-1 rejected (invalidFrame: expected the frame to end with <<<END...>>>)\n" +
        "Attempt attempt-2 rejected (invalidJson: the JSON payload is empty)"
    );
    // No prior attempts (the ordinary, non-chained case) renders exactly as before.
    assert.doesNotMatch(describeTaskActionOutcomeForLogV1(ALL_OUTCOMES[4]!), /Attempt .* rejected/);
  });

  void it(
    "names the FINAL attempt's own id next to the status line, for both malformedResult and " +
      "failed/contentContractFailed chains (2026-09-28 implementation-review follow-up to item 6: " +
      "every prior attempt got its id on its own line, but the chain's own final attempt — the one " +
      "the status line itself reports — had no id anywhere in the run file)",
    () => {
      const exhaustedMalformed: TaskActionOutcomeV1 = {
        kind: "malformedResult",
        correlation: CORRELATION,
        code: "invalidEnvelope",
        detail: 'unsupported envelope "version": 99',
        attemptId: "attempt-3",
        priorRejectedAttemptsV1: [
          { attemptId: "attempt-1", code: "invalidFrame" },
          { attemptId: "attempt-2", code: "invalidJson" },
        ],
      };
      assert.equal(
        describeTaskActionOutcomeForLogV1(exhaustedMalformed),
        "Status: malformed result (invalidEnvelope: unsupported envelope \"version\": 99) [attempt=attempt-3]\n" +
          "Attempt attempt-1 rejected (invalidFrame)\n" +
          "Attempt attempt-2 rejected (invalidJson)"
      );
      const exhaustedContentContract: TaskActionOutcomeV1 = {
        kind: "failed",
        correlation: CORRELATION,
        code: "contentContractFailed",
        retryable: false,
        detail: 'missing required "MAGIC" marker (got: "third candidate")',
        attemptId: "attempt-3",
        priorRejectedAttemptsV1: [
          { attemptId: "attempt-1", code: "contentContractFailed", detail: "missing required \"MAGIC\" marker (got: \"first candidate\")" },
          { attemptId: "attempt-2", code: "contentContractFailed", detail: "missing required \"MAGIC\" marker (got: \"second candidate\")" },
        ],
      };
      assert.equal(
        describeTaskActionOutcomeForLogV1(exhaustedContentContract),
        "Status: failed (code=contentContractFailed: missing required \"MAGIC\" marker (got: \"third candidate\"), " +
          "retryable=false) [attempt=attempt-3]\n" +
          "Attempt attempt-1 rejected (contentContractFailed: missing required \"MAGIC\" marker (got: \"first candidate\"))\n" +
          "Attempt attempt-2 rejected (contentContractFailed: missing required \"MAGIC\" marker (got: \"second candidate\"))"
      );
      // No attemptId set (every pre-existing outcome) renders exactly as before.
      assert.doesNotMatch(describeTaskActionOutcomeForLogV1(ALL_OUTCOMES[3]!), /\[attempt=/);
      assert.doesNotMatch(describeTaskActionOutcomeForLogV1(ALL_OUTCOMES[4]!), /\[attempt=/);
    }
  );
});

void describe("describeTaskActionFailureV1", () => {
  void it("produces a non-empty clause for every failure-shaped outcome", () => {
    for (const outcome of ALL_OUTCOMES) {
      if (outcome.kind === "completed" || outcome.kind === "questions") {
        continue;
      }
      const clause = describeTaskActionFailureV1(outcome);
      assert.ok(
        clause.length > 0,
        `${outcome.kind} must produce a user-facing failure clause`
      );
    }
  });

  void it("explains a malformed result in user terms rather than leaking the frame contract", () => {
    assert.strictEqual(
      describeTaskActionFailureV1(ALL_OUTCOMES[4]!),
      "the model's response was malformed (invalidFrame)"
    );
  });

  void it("includes the coordinator's own diagnostic detail when present", () => {
    const withDetail: TaskActionOutcomeV1 = {
      kind: "malformedResult",
      correlation: CORRELATION,
      code: "contentSchemaMismatch",
      detail: 'received content type "chat-message.v1", expected "markdown-artifact.v1"',
    };
    assert.strictEqual(
      describeTaskActionFailureV1(withDetail),
      "the model's response was malformed (contentSchemaMismatch: received content type \"chat-message.v1\", expected \"markdown-artifact.v1\")"
    );
  });

  void it("summarizes every attempt's own reason, not only the last, when a malformed chain exhausted (item 6)", () => {
    const exhausted: TaskActionOutcomeV1 = {
      kind: "malformedResult",
      correlation: CORRELATION,
      code: "invalidEnvelope",
      detail: 'unsupported envelope "version": 99',
      priorRejectedAttemptsV1: [
        { attemptId: "attempt-1", code: "invalidFrame" },
        { attemptId: "attempt-2", code: "invalidJson", detail: "the JSON payload is empty" },
      ],
    };
    assert.strictEqual(
      describeTaskActionFailureV1(exhausted),
      "the model's response was malformed (attempt 1: invalidFrame; " +
        "attempt 2: invalidJson: the JSON payload is empty; " +
        'final attempt: invalidEnvelope: unsupported envelope "version": 99)'
    );
  });

  void it(
    "summarizes every attempt's own reason, not only the last, when a content-contract " +
      "(failed/contentContractFailed) chain exhausted (2026-09-28 implementation-review follow-up to " +
      "item 6: this chain kind shares the same history shape as malformedResult but was not wired up)",
    () => {
      const exhausted: TaskActionOutcomeV1 = {
        kind: "failed",
        correlation: CORRELATION,
        code: "contentContractFailed",
        retryable: false,
        detail: 'missing required "MAGIC" marker (got: "third")',
        priorRejectedAttemptsV1: [
          { attemptId: "attempt-1", code: "contentContractFailed", detail: 'missing required "MAGIC" marker (got: "first")' },
          { attemptId: "attempt-2", code: "contentContractFailed", detail: 'missing required "MAGIC" marker (got: "second")' },
        ],
      };
      assert.strictEqual(
        describeTaskActionFailureV1(exhausted),
        'attempt 1: contentContractFailed: missing required "MAGIC" marker (got: "first"); ' +
          'attempt 2: contentContractFailed: missing required "MAGIC" marker (got: "second"); ' +
          'final attempt: contentContractFailed: missing required "MAGIC" marker (got: "third")'
      );
      // No prior attempts (the ordinary, non-chained case) renders exactly as before.
      assert.strictEqual(
        describeTaskActionFailureV1(ALL_OUTCOMES[3]!),
        "providerExploded (retryable)"
      );
    }
  );

  void it("renders an invocationDeadlineExceeded failure as 'timed out after N minutes' (item 2 / Step 55)", () => {
    const timedOut: TaskActionOutcomeV1 = {
      kind: "failed",
      correlation: CORRELATION,
      code: "invocationDeadlineExceeded",
      retryable: true,
      detail: "provider invocation exceeded 3600000ms",
    };
    assert.strictEqual(
      describeTaskActionFailureV1(timedOut),
      "timed out after 60 minutes (retryable)"
    );
  });

  void it("falls back to 'timed out' for an invocationDeadlineExceeded failure with no parseable detail", () => {
    const timedOut: TaskActionOutcomeV1 = {
      kind: "failed",
      correlation: CORRELATION,
      code: "invocationDeadlineExceeded",
      retryable: true,
    };
    assert.strictEqual(describeTaskActionFailureV1(timedOut), "timed out (retryable)");
  });

  void it("renders a callerCancelled/providerCancelled failure as 'cancelled — <detail>' (item 2 / Step 55)", () => {
    const stillRunning: TaskActionOutcomeV1 = {
      kind: "failed",
      correlation: CORRELATION,
      code: "providerCancelled",
      retryable: true,
      detail: "a provider process may still be running and was not confirmed stopped",
    };
    assert.strictEqual(
      describeTaskActionFailureV1(stillRunning),
      "cancelled — a provider process may still be running and was not confirmed stopped (retryable)"
    );
    const unconfirmedSpawn: TaskActionOutcomeV1 = {
      kind: "failed",
      correlation: CORRELATION,
      code: "callerCancelled",
      retryable: true,
      detail: "a provider process may still be starting and could not be confirmed stopped",
    };
    assert.strictEqual(
      describeTaskActionFailureV1(unconfirmedSpawn),
      "cancelled — a provider process may still be starting and could not be confirmed stopped (retryable)"
    );
  });

  void it("falls back to plain 'cancelled' for a callerCancelled/providerCancelled failure with no detail", () => {
    const noDetail: TaskActionOutcomeV1 = {
      kind: "failed",
      correlation: CORRELATION,
      code: "providerCancelled",
      retryable: true,
    };
    assert.strictEqual(describeTaskActionFailureV1(noDetail), "cancelled (retryable)");
  });
});

void describe("draft run log (draftTaskWithAI) — decoder reason and provider suffix", () => {
  void it("records the decoder's rejection reason AND the provider suffix on a malformed draft", () => {
    // The 2026-08-15 desc failure's durable run record read only
    // "Status: malformed result (contentSchemaMismatch)" because the draft
    // command's hand-copied formatter dropped `detail`. The shared formatter
    // must carry both the decoder's own reason and which provider produced
    // the response, or the record is undiagnosable after the fact.
    const outcome: TaskActionOutcomeV1 = {
      kind: "malformedResult",
      correlation: CORRELATION,
      code: "contentSchemaMismatch",
      detail: 'received content type "chat-message.v1", expected "markdown-artifact.v1"',
      provider: { providerLabel: "GitHub Copilot", storedModelId: "copilot:auto" },
    };
    const line = describeTaskActionOutcomeForLogV1(outcome, "task.md");
    assert.match(line, /contentSchemaMismatch: received content type "chat-message\.v1", expected "markdown-artifact\.v1"/);
    assert.match(line, /\[GitHub Copilot \(auto\)\]$/);
  });

  void it("draftTaskWithAI writes its run log through the shared formatter, with no surviving hand copy", () => {
    // Structural pin for the Part 1 dedupe: three character-identical
    // formatters existed and two drifted (dropping `detail`). The draft
    // command must call the shared helpers, and the deleted local copies
    // must not quietly come back.
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "src", "commands", "draftTaskWithAI.ts"),
      "utf8"
    );
    assert.match(
      source,
      /describeTaskActionOutcomeForLogV1\(outcome, "task\.md"\)/,
      "the draft run log must record the shared, detail-carrying status line"
    );
    assert.match(
      source,
      /describeTaskActionFailureV1\(outcome\)/,
      "the draft failure notification must use the shared failure text"
    );
    assert.doesNotMatch(
      source,
      /function describeDraftOutcomeForLogV1|function describeDraftFailureV1/,
      "the hand-copied draft formatters were deleted and must not be reintroduced"
    );
  });
});

void describe("handleReviewOutcomeV1 silent-failure regression", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "src", "commands", "reviewActions.ts"),
    "utf8"
  );

  void it("surfaces a failure for review stages other than Publish", () => {
    // The original bug was structural: the outcome chain ended at the
    // Publish-only branch, so every other stage's failure fell through to
    // nothing. Pin that a terminal else-branch exists and reports the
    // failure, so a future edit cannot quietly restore the silent path.
    assert.match(
      source,
      /describeTaskActionFailureV1\(outcome\)/,
      "handleReviewOutcomeV1 must report non-completed outcomes using the shared failure text"
    );
    assert.match(
      source,
      /NotificationRouter\.showError\(\s*`\$\{STAGE_DISPLAY_NAMES\[targetStage\]\} failed/,
      "a failed review must raise a user-visible error naming the stage"
    );
  });

  void it("always writes a review run log so a failure leaves a diagnosable artifact", () => {
    // The V1 migration dropped review run logging entirely (the only
    // writeRunLog call left in the file was the implementation run's), which
    // is why a failed review left nothing on disk to inspect.
    assert.match(
      source,
      /writeRunLog\(\s*ctx\.folderUri,\s*"review-v1"/,
      "the review outcome handler must write a run log for every settlement"
    );
    assert.match(
      source,
      /describeTaskActionOutcomeForLogV1\(/,
      "the review run log must record the sanitized outcome status line"
    );
  });

  void it("writes that run log from a finally block, so early returns cannot skip it", () => {
    // Review finding: the routing body has several early returns (a stage
    // transition that throws or fails to persist, a missing Chat record).
    // With the log placed after the branch chain, every one of those paths
    // silently produced no artifact — reproducing the exact
    // nothing-to-inspect problem the log exists to end. Pin the structure:
    // the router is called inside try, the log runs in finally.
    //
    // 2026-08-27 review fix (Part 4, narrowed blocker 2): the same finally
    // block now ALSO closes the round-ledger row `claimReviewAttempt` opened
    // at this round's real start — every non-"completed" outcome, and a
    // "completed" outcome whose own routing never reaches
    // `handleReviewRoutingOutcome`'s terminalization, previously left that
    // row open forever. Pinned alongside the run-log call for the same
    // reason: an early return must not be able to skip it either.
    assert.match(
      source,
      /try\s*\{\s*await routeReviewOutcomeV1\(outcome, ctx\);\s*\}\s*finally\s*\{\s*await writeReviewRunLogV1\(outcome, ctx\);\s*await terminalizeUnclosedReviewRoundV1\(outcome, ctx\);\s*\}/,
      "handleReviewOutcomeV1 must run the run log AND the round-ledger safety-net terminalizer in a finally around the routing body"
    );
  });

  void it("does not promise prompt details the run log never records", () => {
    // Review finding: the failure notification told users to check the run
    // log for "the prompt and settlement details", but the log holds only a
    // heading plus the sanitized outcome — this handler has no prompt in
    // scope, and the rendered prompt embeds the whole context pack anyway.
    assert.doesNotMatch(
      source,
      /for the prompt and settlement details/,
      "the failure notification must not claim the run log contains the prompt"
    );
  });
});
