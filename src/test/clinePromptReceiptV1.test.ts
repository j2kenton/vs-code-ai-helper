/**
 * bugs3 Steps 6/17: Cline prompt receipt is judged from the attempt's own
 * session record, and an editable Cline launch is refused while no fail-closed
 * pre-edit barrier is verified.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { runImplementationWithCli } from "../runners/cliAgentRunner";
import { CLI_PROVIDERS, CLINE_CLI_ARGV_PROMPT_PLACEHOLDER } from "../runners/providers";
import {
  clineEditableLaunchGateV1,
  expectedClineFirstUserMessageV1,
  firstUserMessageTextV1,
  promptNotDeliveredMessageV1,
  sessionBelongsToAttemptV1,
  verifyClinePromptReceiptV1,
} from "../utils/clinePromptReceiptV1";

const PLACEHOLDER = CLINE_CLI_ARGV_PROMPT_PLACEHOLDER;
const SPAWNED_AT = Date.parse("2026-10-28T05:38:35.000Z");
const BINDING = { pid: 1352391, spawnedAtMs: SPAWNED_AT };
const SESSION = { session_id: "1793165915653_c2csa", pid: 1352391, started_at: "2026-10-28T05:38:35.845Z" };

function messagesRecord(text: string): unknown {
  return { version: 1, messages: [{ role: "user", content: [{ type: "text", text }] }] };
}

const PROMPT = `\n  Implement step 4.\n${"x".repeat(150_000)}\nEND-MARKER\n`;

void describe("Cline prompt receipt (bugs3 Step 6)", () => {
  void it("accepts the first message exactly as Cline 3.0.74 wraps and trims the prompt", () => {
    const verdict = verifyClinePromptReceiptV1({
      placeholder: PLACEHOLDER,
      prompt: PROMPT,
      session: SESSION,
      messagesRecord: messagesRecord(expectedClineFirstUserMessageV1(PLACEHOLDER, PROMPT)),
      binding: BINDING,
    });
    assert.equal(verdict.ok, true);
    if (verdict.ok) {
      assert.equal(verdict.sessionId, SESSION.session_id);
      assert.match(verdict.expectedSha256, /^[0-9a-f]{64}$/);
    }
  });

  void it("rejects the placeholder-only first message of the 2026-10-26 incident", () => {
    const verdict = verifyClinePromptReceiptV1({
      placeholder: PLACEHOLDER,
      prompt: PROMPT,
      session: SESSION,
      messagesRecord: messagesRecord(`<user_input mode="act">${PLACEHOLDER}</user_input>`),
      binding: BINDING,
    });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.equal(verdict.code, "placeholderOnly");
      assert.match(promptNotDeliveredMessageV1("Cline CLI", verdict), /^Prompt not delivered/);
    }
  });

  void it("rejects a truncated prompt as a mismatch, without echoing prompt contents", () => {
    const expected = expectedClineFirstUserMessageV1(PLACEHOLDER, PROMPT);
    const verdict = verifyClinePromptReceiptV1({
      placeholder: PLACEHOLDER,
      prompt: PROMPT,
      session: SESSION,
      messagesRecord: messagesRecord(expected.slice(0, 60_000)),
      binding: BINDING,
    });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.equal(verdict.code, "promptMismatch");
      assert.ok(!verdict.detail.includes("END-MARKER"));
    }
  });

  void it("rejects another session's record, whatever its message says", () => {
    const other = { ...SESSION, pid: 4242 };
    const verdict = verifyClinePromptReceiptV1({
      placeholder: PLACEHOLDER,
      prompt: PROMPT,
      session: other,
      messagesRecord: messagesRecord(expectedClineFirstUserMessageV1(PLACEHOLDER, PROMPT)),
      binding: BINDING,
    });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.code, "sessionNotThisAttempt");
  });

  void it("rejects a session that started long before this attempt was spawned", () => {
    assert.equal(
      sessionBelongsToAttemptV1({ ...SESSION, started_at: "2026-10-27T05:38:35.845Z" }, BINDING),
      false
    );
    assert.equal(sessionBelongsToAttemptV1({ ...SESSION, started_at: "not a date" }, BINDING), false);
  });

  void it("reports a missing session record and a missing first user message", () => {
    const none = verifyClinePromptReceiptV1({
      placeholder: PLACEHOLDER, prompt: PROMPT, session: undefined, messagesRecord: undefined, binding: BINDING,
    });
    assert.equal(none.ok === false && none.code, "noSessionRecord");
    const empty = verifyClinePromptReceiptV1({
      placeholder: PLACEHOLDER, prompt: PROMPT, session: SESSION, messagesRecord: { messages: [{ role: "assistant", content: "hi" }] }, binding: BINDING,
    });
    assert.equal(empty.ok === false && empty.code, "noFirstUserMessage");
  });

  void it("reads string and multi-part user content", () => {
    assert.equal(firstUserMessageTextV1({ messages: [{ role: "user", content: "plain" }] }), "plain");
    assert.equal(
      firstUserMessageTextV1({ messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] }),
      "ab"
    );
    assert.equal(firstUserMessageTextV1({}), undefined);
  });
});

void describe("Cline editable launch gate (bugs3 Step 6)", () => {
  void it("refuses while the pre-edit barrier is unverified, and allows once it is", () => {
    const refused = clineEditableLaunchGateV1(false);
    assert.equal(refused.allowed, false);
    if (!refused.allowed) {
      assert.equal(refused.code, "promptReceiptBarrierUnverified");
      assert.match(refused.message, /Nothing was changed/);
    }
    assert.equal(clineEditableLaunchGateV1(true).allowed, true);
  });

  void it("ships with the barrier unverified (no owner evidence of a fail-closed release exists)", () => {
    assert.equal(clineEditableLaunchGateV1().allowed, false);
  });

  void it("runImplementationWithCli refuses Cline before spawning anything and marks the prompt as undelivered", async () => {
    const def = CLI_PROVIDERS.find((p) => p.id === "cline-cli");
    assert.ok(def);
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-cline-gate-"));
    try {
      const cts = new vscode.CancellationTokenSource();
      const progress: string[] = [];
      const result = await runImplementationWithCli({
        def,
        model: undefined,
        prompt: "Implement the requested change.",
        workspaceUri: vscode.Uri.file(workspace),
        token: cts.token,
        onProgress: (message) => progress.push(message),
        requireFileChange: true,
      });
      assert.equal(result.status, "failed");
      assert.equal(result.promptNotDeliveredV1, true);
      assert.deepStrictEqual(result.filesChanged, []);
      assert.equal(result.filesChangedUnknown, false);
      assert.deepStrictEqual(progress, [], "no provider progress: nothing was started");
      assert.match(result.errorMessage ?? "", /not started for this editing round/);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
