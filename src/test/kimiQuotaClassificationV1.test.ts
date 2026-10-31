/**
 * bugs3 Step 11: a Kimi usage limit (HTTP 429) is a quota failure, never an
 * authentication failure, even when text the model's own commands produced
 * mentions login/401; a real sign-in failure is still authentication; and the
 * failure message lists the model that already ran only once.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { __testOnly } from "../runners/cliAgentRunner";
import { getCliProvider } from "../runners/providers";
import { distinctBackupRecordsV1, describeMidRoundOutcomeV1 } from "../utils/stopBehaviourV1";
import {
  classifyCliFailure,
  describeExplicitUsageLimitV1,
  explicitProviderUsageLimitLineV1,
  isExplicitProviderUsageLimitV1,
} from "../utils/quota";

const LIMIT_LINE =
  "error: failed to run prompt: provider.api_error: 429 You've reached your 5-hour usage limit. " +
  "Your quota will reset when the current 5-hour window ends.";

/** What a Kimi round that edited auth tests leaves on stdout: the model's own command output. */
const LEAKED_COMMAND_OUTPUT = [
  "M  package.json",
  "# tests 12 pass 11 fail 1 — login rejected with 401 Unauthorized",
  "AssertionError: user must login again (401)",
].join("\n");

void describe("Kimi usage limit vs authentication (bugs3 Step 11)", () => {
  const kimi = getCliProvider("kimi-cli");

  void it("no longer treats the bare word login as an authentication marker", () => {
    assert.ok(kimi);
    assert.ok(!kimi.authErrorMarkers.includes("login"));
    assert.ok(kimi.authErrorMarkers.includes("not logged in"));
  });

  void it("classifies the 429 usage-limit line as quota even with login/401 text on stdout", () => {
    assert.ok(kimi);
    const friendly = __testOnly.toFriendlyError(kimi, "kimi-code/k3.1-pro", 1, LIMIT_LINE, LEAKED_COMMAND_OUTPUT);
    assert.equal(friendly.authFailure, false);
    assert.equal(friendly.quotaSignal, true);
    assert.doesNotMatch(friendly.message, /kimi login|sign[\s-]*in/i);
    assert.match(friendly.message, /5-hour usage limit is used up; it resets when the window ends/);
    // The excerpt carries the provider's error line, not the model's command output.
    assert.doesNotMatch(friendly.message, /package\.json|AssertionError|tests 12/);
    const classified = classifyCliFailure({
      status: "failed" as const,
      output: "",
      errorMessage: friendly.message,
      authDiagnosticText: friendly.diagnosticText,
      structuredQuotaSignal: friendly.quotaSignal,
    });
    assert.equal(classified.failureKind, "quota");
  });

  void it("does not let leaked stdout alone read as an authentication failure", () => {
    assert.ok(kimi);
    const friendly = __testOnly.toFriendlyError(kimi, "kimi-code/k3.1-pro", 1, "", LEAKED_COMMAND_OUTPUT);
    assert.equal(friendly.authFailure, false);
  });

  void it("still reports a real sign-in failure as authentication", () => {
    assert.ok(kimi);
    const friendly = __testOnly.toFriendlyError(
      kimi,
      "kimi-code/k3.1-pro",
      1,
      "error: failed to run prompt: auth.not_logged_in: not logged in. Run `kimi login`.",
      ""
    );
    assert.equal(friendly.authFailure, true);
    assert.match(friendly.message, /kimi login/);
    // And so does Kimi's own error line on stdout.
    const fromStdout = __testOnly.toFriendlyError(
      kimi,
      "kimi-code/k3.1-pro",
      1,
      "",
      "error: failed to run prompt: provider.api_error: 401 Unauthorized"
    );
    assert.equal(fromStdout.authFailure, true);
  });

  void it("recognises an explicit usage-limit line only when 429 and the limit wording share a line", () => {
    assert.equal(isExplicitProviderUsageLimitV1(LIMIT_LINE), true);
    assert.equal(isExplicitProviderUsageLimitV1("HTTP 429 Too Many Requests: quota exceeded"), true);
    assert.equal(isExplicitProviderUsageLimitV1("429\nusage limit docs"), false);
    assert.equal(isExplicitProviderUsageLimitV1("401 Unauthorized"), false);
    assert.equal(explicitProviderUsageLimitLineV1(`noise\n${LIMIT_LINE}`), LIMIT_LINE);
    assert.doesNotMatch(describeExplicitUsageLimitV1("Kimi Code CLI", LIMIT_LINE), /sign[\s-]*in|kimi login/i);
  });
});

void describe("failure summary lists each model once (bugs3 Step 11)", () => {
  void it("drops the backup record that repeats the headline failure, and exact duplicates", () => {
    const headline = "Kimi Code CLI failed: error: provider.api_error: 429 usage limit";
    const kept = distinctBackupRecordsV1(
      [
        { label: "Kimi Code CLI kimi-code/k3.1-pro", outcome: "tried-and-failed", reason: "provider.api_error: 429 usage limit" },
        { label: "Codex gpt-6", outcome: "tried-and-failed", reason: "unavailable" },
        { label: "Codex gpt-6", outcome: "tried-and-failed", reason: "unavailable" },
        { label: "Gemini pro", outcome: "disabled", reason: "off" },
      ],
      headline
    );
    assert.deepEqual(
      kept.map((record) => record.label),
      ["Codex gpt-6", "Gemini pro"]
    );
  });

  void it("keeps a different model that failed with the same wording", () => {
    const reason = "429 You've reached your usage limit";
    const kept = distinctBackupRecordsV1(
      [
        { label: "Kimi Code CLI kimi-code/k3.1-pro", outcome: "tried-and-failed", reason },
        { label: "Kimi Code CLI kimi-code/k3", outcome: "tried-and-failed", reason },
        { label: "Codex gpt-6", outcome: "tried-and-failed", reason },
      ],
      reason,
      "Kimi Code CLI kimi-code/k3.1-pro"
    );
    assert.deepEqual(
      kept.map((record) => record.label),
      ["Kimi Code CLI kimi-code/k3", "Codex gpt-6"]
    );
  });

  void it("drops only the record of the headline model when the caller names it", () => {
    const reason = "429 You've reached your usage limit";
    const records = [
      { label: "Kimi Code CLI kimi-code/k3.1-pro", outcome: "tried-and-failed" as const, reason },
      { label: "Kimi Code CLI kimi-code/k3", outcome: "tried-and-failed" as const, reason },
    ];
    // The provider label alone would match both; the model label picks the one that just ran.
    assert.deepEqual(
      distinctBackupRecordsV1(records, reason, "Kimi Code CLI", "Kimi Code CLI kimi-code/k3").map((r) => r.label),
      ["Kimi Code CLI kimi-code/k3.1-pro"]
    );
    // A headline model with no record of its own drops nothing.
    assert.equal(distinctBackupRecordsV1(records, reason, "Kimi Code CLI", "Kimi Code CLI kimi-code/other").length, 2);
    const text = describeMidRoundOutcomeV1(
      "Kimi Code CLI",
      reason,
      { kind: "backupsExhausted", backups: records, remedyText: "Rerun after the reset." },
      "Kimi Code CLI kimi-code/k3"
    );
    assert.match(text, /kimi-code\/k3\.1-pro was tried and failed/);
    assert.doesNotMatch(text, /kimi-code\/k3 was tried and failed/);
  });

  void it("prints the error once in the withheld-switch message", () => {
    const text = describeMidRoundOutcomeV1("Kimi Code CLI", "429 You've reached your usage limit", {
      kind: "backupsExhausted",
      backups: [{ label: "Kimi Code CLI kimi-code/k3.1-pro", outcome: "tried-and-failed", reason: "429 You've reached your usage limit" }],
      remedyText: "Rerun after the reset.",
    });
    assert.equal(text.match(/reached your usage limit/g)?.length, 1);
    assert.doesNotMatch(text, /was tried and failed/);
  });
});
