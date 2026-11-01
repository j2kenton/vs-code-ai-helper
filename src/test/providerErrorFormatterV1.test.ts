/**
 * bugs4 item 35: "Backup used" notes show a provider's message, not its raw
 * error envelope, and are never cut mid-word.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fallbackReasonForAttemptV1 } from "../actions/taskActionCoordinatorV1";
import {
  BACKUP_USED_PREFIX_V1,
  backupUsedNoteV1,
  backupUsedRunLogNoteV1,
  formatProviderErrorV1,
} from "../utils/providerErrorFormatterV1";

// The captured Publish-review outcome (bugs4 item 35), as the coordinator records it.
const AGY_QUOTA =
  "antigravity-cli:claude-sonnet-5-5-high cliExit.3: Antigravity CLI failed: error: Individual quota reached. " +
  "Please upgrade your subscription to increase your limits. Resets in 1h13m30s. AGY_ERROR: " +
  "{\"short_error\":\"RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscripti";

void describe("formatProviderErrorV1", () => {
  void it("AGY quota replay: no JSON, no AGY_ERROR, no internal exit code, reset time once, within the cap", () => {
    const text = formatProviderErrorV1(AGY_QUOTA, { ranOnBackup: "claude-cli:claude-sonnet-5-5@high" });
    assert.ok(text);
    assert.doesNotMatch(text, /[{}]/);
    assert.doesNotMatch(text, /AGY_ERROR/);
    assert.doesNotMatch(text, /cliExit/);
    assert.equal((text.match(/Resets in 1h13m30s/g) ?? []).length, 1);
    assert.match(text, /Individual quota reached/);
    assert.match(text, /Ran on backup claude-cli:claude-sonnet-5-5@high\.$/);
    assert.ok(text.length <= 300);
  });

  void it("backupUsedNoteV1 keeps the stable prefix other readers match on", () => {
    const note = backupUsedNoteV1(AGY_QUOTA, "claude-cli:claude-sonnet-5-5@high");
    assert.ok(note.startsWith(BACKUP_USED_PREFIX_V1));
    assert.doesNotMatch(note, /AGY_ERROR|\{/);
  });

  void it("a 404 with a JSON body renders as one sentence naming the model and 'not found'", () => {
    const text = formatProviderErrorV1(
      "llmgateway-devpass/kimi-k3 providerHttpError: HTTP 404: " +
        "{\"error\":{\"message\":\"Model kimi-k3 not found\",\"type\":\"not_found_error\"}}"
    );
    assert.ok(text);
    assert.match(text, /kimi-k3/);
    assert.match(text, /not found/i);
    assert.doesNotMatch(text, /[{}]/);
  });

  void it("shows a repeated sentence once", () => {
    const text = formatProviderErrorV1("Add credits or choose a free model. Add credits or choose a free model.");
    assert.equal(text, "Add credits or choose a free model.");
  });

  void it("never cuts mid-word: a long message is shortened at a sentence or word boundary", () => {
    const long = "word ".repeat(120).trim();
    const text = formatProviderErrorV1(long, { maxChars: 100 });
    assert.ok(text);
    assert.ok(text.length <= 100);
    assert.match(text, /word…$/);
    const sentences = "First sentence is here. " + "Second sentence is a little longer than the first one. ".repeat(10);
    const cut = formatProviderErrorV1(sentences, { maxChars: 90 });
    assert.equal(cut, "First sentence is here. Second sentence is a little longer than the first one.");
  });

  void it("keeps text containing braces that are not JSON", () => {
    assert.equal(formatProviderErrorV1("expected {name} placeholder to be filled."), "expected {name} placeholder to be filled.");
  });

  void it("returns undefined for empty input", () => {
    assert.equal(formatProviderErrorV1("   "), undefined);
  });
});

void describe("backupUsedRunLogNoteV1", () => {
  void it("keeps the readable line and records the provider's raw text unshortened for the run log", () => {
    const text = backupUsedRunLogNoteV1(AGY_QUOTA, "claude-cli:claude-sonnet-5-5@high");
    assert.ok(text.startsWith(backupUsedNoteV1(AGY_QUOTA, "claude-cli:claude-sonnet-5-5@high")));
    assert.ok(text.includes(`Raw provider message: ${AGY_QUOTA}`));
    assert.ok(text.includes("AGY_ERROR"), "the raw envelope and exit code stay in the run log");
    assert.ok(text.includes("cliExit.3"));
  });

  void it("adds no raw line when the provider gave no text", () => {
    assert.equal(backupUsedRunLogNoteV1("  "), backupUsedNoteV1("  "));
  });
});

void describe("fallbackReasonForAttemptV1 (bugs4 Step 29: format before bounding)", () => {
  void it("AGY replay: the durable fallback reason has no JSON, keeps the exit code, and ends on a word boundary", () => {
    const reason = fallbackReasonForAttemptV1({
      storedModelId: "antigravity-cli:claude-sonnet-5-5-high",
      code: "cliExit.3",
      detail:
        "Antigravity CLI failed: error: Individual quota reached. Please upgrade your subscription to increase your limits. " +
        "Resets in 1h13m30s. AGY_ERROR: " +
        '{"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached. ' +
        'Please upgrade your subscription to increase your limits. Resets in 1h13m30s.","details":[{"reason":"QUOTA"}]}',
    });
    assert.doesNotMatch(reason, /[{}]|AGY_ERROR/);
    assert.match(reason, /^antigravity-cli:claude-sonnet-5-5-high cliExit\.3:/);
    assert.equal((reason.match(/Resets in 1h13m30s/g) ?? []).length, 1);
    assert.ok(reason.length <= 300);
    // The chat note built from it is still clean.
    assert.doesNotMatch(backupUsedNoteV1(reason, "claude-cli:claude-sonnet-5-5@high"), /cliExit|[{}]/);
  });

  void it("a 404 renders as one sentence naming the model and not found", () => {
    const reason = fallbackReasonForAttemptV1({
      storedModelId: "devpass-cli:llmgateway-devpass/gone-model@high",
      code: "cliExit.1",
      detail: 'APIError: Model not found (HTTP 404) {"error":{"message":"Model not found","code":404}}',
    });
    assert.doesNotMatch(reason, /[{}]/);
    assert.match(reason, /gone-model/);
    assert.match(reason, /not found/i);
    assert.equal((reason.match(/Model not found/gi) ?? []).length, 1);
  });

  void it("a long unstructured diagnostic is cut at a word, not mid-word, within 300 characters", () => {
    const reason = fallbackReasonForAttemptV1({
      storedModelId: "m",
      code: "cliExit.1",
      detail: `diagnostic ${"detail ".repeat(100)}`,
    });
    assert.ok(reason.length <= 300);
    assert.match(reason, /detail…$/);
  });
});

// bugs4 item 9: the captured Codex review rejection. The recovery instruction used to be cut
// at `run "Recover L` by the 300-character cap.
const RECOVERY_CLAUSE =
  'run "Recover Last AI Response" (vs-code-ai-helper.recoverLastAiResponse, Ctrl+Shift+Alt+C) to read it back';
const CODEX_CORRELATION =
  "codex-cli:gpt-6.1-terra@high resultCorrelationMismatch: result correlation does not match the expected " +
  "operation/attempt; Primary result rejected (reservation mismatch): claimed eacbcfd371751eaaca111449996abf35, " +
  "stored 0000000000000000000000000000dead; response preserved for recovery in extension private storage " +
  `(operationId=fb8fc77788856feb2134127bdcffd062, reservationId=eacbcfd371751eaaca111449996abf35, ~24h) — ${RECOVERY_CLAUSE}`;

void describe("backupUsedNoteV1 — correlation rejection (bugs4 item 9)", () => {
  void it("leads with the failed field and the backup that ran", () => {
    const note = backupUsedNoteV1(CODEX_CORRELATION, "claude-cli:claude-sonnet-5-5@high");
    assert.ok(
      note.startsWith("Primary result rejected (reservation mismatch); ran on backup claude-cli:claude-sonnet-5-5@high."),
      note
    );
    assert.ok(!note.includes(BACKUP_USED_PREFIX_V1), "the chat outcome starts with the rejection, not the legacy prefix");
  });

  void it("the run-log form keeps the stable prefix that run-log readers match", () => {
    const logNote = backupUsedRunLogNoteV1(CODEX_CORRELATION, "claude-cli:claude-sonnet-5-5@high");
    assert.ok(
      logNote.startsWith(
        `${BACKUP_USED_PREFIX_V1}Primary result rejected (reservation mismatch); ran on backup claude-cli:claude-sonnet-5-5@high.`
      ),
      logNote
    );
  });

  void it("never truncates the recovery instruction", () => {
    const note = backupUsedNoteV1(CODEX_CORRELATION, "claude-cli:claude-sonnet-5-5@high");
    assert.ok(note.endsWith(RECOVERY_CLAUSE), note);
  });

  void it("a recovery instruction survives even when the text before it is long", () => {
    const note = backupUsedNoteV1(
      `${"provider said something long. ".repeat(40)} — run "Recover Last AI Response" (vs-code-ai-helper.recoverLastAiResponse) to read it back`
    );
    assert.match(note, /run "Recover Last AI Response" \(vs-code-ai-helper\.recoverLastAiResponse\) to read it back$/);
  });

  void it("a note with no recovery clause or correlation field is unchanged in shape", () => {
    assert.equal(
      backupUsedNoteV1("Codex hit a usage limit", "claude-cli:x"),
      `${BACKUP_USED_PREFIX_V1}${formatProviderErrorV1("Codex hit a usage limit", { ranOnBackup: "claude-cli:x" })}`
    );
  });
});
