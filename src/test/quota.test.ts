import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  buildQuotaRemedyTextV1,
  classifyFailure,
  formatQuotaStatus,
  getQuotaLedgerEntry,
  getQuotaObservation,
  isAuthenticationFailure,
  isCascadeEligibleFailureKind,
  isModelEntitlementFailure,
  isQuotaError,
  isQuotaResetBeyondThresholdV1,
  isTransportError,
  parseQuotaResetV1,
  quotaLedgerKey,
  recordQuotaObservation,
  __quotaTestOnly,
} from "../utils/quota";
import { resolveQuotaAccountKeyV1 } from "../config/settings";

/** Temporarily makes `ensemble.providerAccountLabels` resolve to `labels`,
 * mirroring the monkeypatch pattern used elsewhere for `getConfiguration`
 * (see settingsAutoRunGate.test.ts). Restores the original on return. */
function withProviderAccountLabels<T>(labels: Record<string, string>, run: () => T): T {
  const original = vscode.workspace.getConfiguration;
  (vscode.workspace as { getConfiguration: typeof vscode.workspace.getConfiguration })
    .getConfiguration = ((section?: string) => {
      if (section !== "ensemble") {
        return original(section);
      }
      return {
        get: (key: string, defaultValue?: unknown) =>
          key === "providerAccountLabels" ? labels : defaultValue,
        inspect: () => undefined,
        update: () => Promise.resolve(),
      } as unknown as ReturnType<typeof original>;
    }) as typeof original;
  try {
    return run();
  } finally {
    vscode.workspace.getConfiguration = original;
  }
}

void describe("isQuotaError", () => {
  void it("classifies genuine quota/rate-limit phrasing as quota errors", () => {
    assert.strictEqual(isQuotaError("You have exceeded your current quota"), true);
    assert.strictEqual(isQuotaError("Rate limit exceeded, please retry later"), true);
    assert.strictEqual(isQuotaError("Your usage limit has been reached"), true);
    assert.strictEqual(isQuotaError("Insufficient credits for this request"), true);
    assert.strictEqual(
      isQuotaError("Claude Code CLI failed: You've hit your session limit · resets 2:30am (Asia/Jerusalem)."),
      true
    );
  });

  void it("does not classify unrelated 'exceeded' errors as quota errors", () => {
    // A bare "exceeded" marker previously caused these to false-positive as
    // quota exhaustion even though they're unrelated failure modes.
    assert.strictEqual(isQuotaError("Maximum context length exceeded"), false);
    assert.strictEqual(
      isQuotaError("Codex prompt is too large for this CLI mode (500 bytes; max 400 bytes exceeded)"),
      false
    );
    assert.strictEqual(isQuotaError("Buffer size exceeded while reading stdout"), false);
  });

  void it("returns false for undefined or unrelated messages", () => {
    assert.strictEqual(isQuotaError(undefined), false);
    assert.strictEqual(isQuotaError("command not found"), false);
  });

  void it("treats an explicit structured signal as an additional (not replacement) quota verdict", () => {
    // A structured error CODE like "rate_limit" (underscored) is not a
    // substring of any QUOTA_MARKERS phrase ("rate limit" with a space,
    // "ratelimit" with none), so the phrase scan alone would miss it — this
    // is exactly the gap claude-cli's structured stream closes (see
    // extractClaudeCliStructuredDiagnostics in cliAgentRunner.ts).
    assert.strictEqual(isQuotaError("You have hit the rate_limit for this account.", true), true);
    // The phrase-based scan is still the fallback: no structural signal, but
    // ordinary quota phrasing must keep working exactly as before.
    assert.strictEqual(isQuotaError("Rate limit exceeded, please retry later", false), true);
    assert.strictEqual(isQuotaError("Rate limit exceeded, please retry later"), true);
    // A structural signal alone (with unrelated or absent text) is trusted.
    assert.strictEqual(isQuotaError(undefined, true), true);
    assert.strictEqual(isQuotaError("unrelated failure text", true), true);
    // No structural signal and no matching phrase stays false.
    assert.strictEqual(isQuotaError("unrelated failure text", false), false);
  });
});

void describe("isTransportError", () => {
  void it("recognizes transport-level drops, including opencode's captured wording", () => {
    assert.strictEqual(isTransportError('"Streaming response failed"'), true);
    assert.strictEqual(isTransportError("socket hang up"), true);
    assert.strictEqual(isTransportError("read ECONNRESET"), true);
    assert.strictEqual(isTransportError("TypeError: fetch failed"), true);
    assert.strictEqual(isTransportError("Premature close"), true);
  });

  void it("stays narrow enough not to fire on ordinary failures", () => {
    // The list is deliberately tight: for providers whose failure detail is
    // still raw stdout, a loose marker like "network error" or "stream error"
    // would match ordinary source code echoed into the output and spend a
    // backup-model allocation on an unrelated failure.
    assert.strictEqual(isTransportError("Claude Code CLI exited with code 1."), false);
    assert.strictEqual(isTransportError("stream error"), false);
    assert.strictEqual(isTransportError("network error"), false);
    assert.strictEqual(isTransportError(undefined), false);
  });
});

void describe("classifyFailure", () => {
  void it("classifies quota phrasing as quota", () => {
    assert.strictEqual(
      classifyFailure({ errorMessage: "You have exceeded your current quota" }).failureKind,
      "quota"
    );
  });

  void it("classifies server-side unavailability as temporarily-unavailable", () => {
    for (const message of [
      "Service temporarily unavailable",
      "503 Service Unavailable",
      "Too many requests",
      "Overloaded, please try again later",
    ]) {
      assert.strictEqual(
        classifyFailure({ errorMessage: message }).failureKind,
        "temporarily-unavailable",
        `"${message}" must classify temporarily-unavailable`
      );
    }
  });

  // A provider's argv-only prompt transport (e.g. Kimi's `-p`, which has no
  // stdin/file input at all) can reject a prompt outright for being too
  // large for THAT provider's transport — a structural per-provider limit,
  // not a code defect and not quota exhaustion (isQuotaError deliberately
  // excludes this exact phrasing above, in the "does not classify unrelated
  // 'exceeded' errors" test). It IS safe to cascade to a backup model on,
  // since a different provider very likely has a higher or no such ceiling —
  // the same reasoning that makes "temporarily-unavailable" cascade-eligible.
  void it("classifies a provider's own prompt-too-large rejection as temporarily-unavailable", () => {
    assert.strictEqual(
      classifyFailure({
        errorMessage:
          "Kimi Code CLI prompt is too large for this CLI mode (118611 bytes; max 20000 bytes). " +
          "Reduce context or choose a provider that accepts stdin prompts.",
      }).failureKind,
      "temporarily-unavailable"
    );
  });

  // classifyFailure deliberately does NOT recognize transport phrases
  // ("streaming response failed", "fetch failed", etc.) at all — it is
  // shared with Copilot and has no provider context, so it cannot tell a
  // structured-stream CLI (whose diagnostic text is scoped to parsed error
  // events) from an opaque one (whose diagnostic text IS raw stdout/model
  // prose), a distinction that matters enormously for whether a transport
  // phrase match is trustworthy. See applyTransportTransience
  // (cliAgentRunner.ts), which has that context and does this instead.
  void it("leaves a transport-sounding message generic — TRANSPORT_MARKERS is not checked here", () => {
    assert.strictEqual(
      classifyFailure({ errorMessage: "OpenCode CLI failed: UnknownError: Streaming response failed" })
        .failureKind,
      "generic"
    );
  });

  void it("still lets quota win over an incidental transport phrase in the same message", () => {
    // Retrying or failing over on a rate-limited request just re-hits the
    // limit — isQuotaError is checked first regardless of anything else.
    assert.strictEqual(
      classifyFailure({ errorMessage: "Rate limit exceeded; streaming response failed" }).failureKind,
      "quota"
    );
  });

  // Regression coverage for a review finding: the text-mode backup-cascade
  // gate (runnerRegistry.ts) keys on failureKind ALONE with no auth check of
  // its own — unlike the implementation-mode gate, which separately
  // consults an authFailure verdict before ever looking at failureKind. That
  // means THIS function is the only thing standing between an
  // authentication failure and a cascade through every configured backup
  // model on the text/review path, for any message that also happens to
  // match a TEMPORARY_MARKERS phrase (e.g. "401 Unauthorized: service
  // temporarily unavailable" — note "temporarily unavailable" is a
  // substring of that, even though "service unavailable" alone is not).
  // Scoping applyTransportTransience's own auth guard (in cliAgentRunner.ts)
  // is not sufficient on its own: it only ever sees a failureKind this
  // function has already decided, and never demotes one back down.
  void it("never promotes an authentication failure to temporarily-unavailable via a temporary marker", () => {
    for (const message of [
      "401 Unauthorized: service temporarily unavailable",
      "Not authorized to perform this action; please try again later",
    ]) {
      assert.strictEqual(
        classifyFailure({ errorMessage: message }).failureKind,
        "generic",
        `"${message}" must stay generic (terminal), not cascade-eligible`
      );
    }
  });

  void it("uses authDiagnosticText over errorMessage to decide the auth gate", () => {
    // errorMessage simulates the CLI path: a clean, transient diagnostic with
    // the provider's login hint appended (a login hint always contains
    // "log in"/"API key"-style wording, which isAuthenticationFailure
    // matches on its own — see toFriendlyError in cliAgentRunner.ts).
    // authDiagnosticText is the same text WITHOUT the hint — what
    // toFriendlyError captured before appending it. Scanning errorMessage
    // directly would let the appended hint alone force isAuth=true and
    // suppress the TEMPORARY_MARKERS promotion below, even though the real
    // diagnostic never said anything about authentication — the same
    // self-reinforcing loop the hint/diagnosticText split exists to prevent
    // elsewhere, just unaddressed here until now.
    const failureKind = classifyFailure({
      errorMessage: "Service temporarily unavailable. Run `opencode` and use /connect to log in.",
      authDiagnosticText: "Service temporarily unavailable.",
    }).failureKind;

    assert.strictEqual(failureKind, "temporarily-unavailable");
  });

  void it("leaves unrelated failures generic", () => {
    assert.strictEqual(classifyFailure({ errorMessage: "exited with code 1" }).failureKind, "generic");
    assert.strictEqual(classifyFailure({}).failureKind, "generic");
  });

  void it("preserves fields it does not own", () => {
    // The spread is what carries the runner's pre-hint auth verdict through to
    // the backup-cascade gate without any plumbing here.
    const classified = classifyFailure({
      errorMessage: "boom",
      authFailure: true,
      authDiagnosticText: "boom",
    });
    assert.strictEqual(classified.authFailure, true);
    assert.strictEqual(classified.authDiagnosticText, "boom");
  });

  // The real Bedrock production shape: a valid credential, refused for this
  // specific model id only. The 403/"Forbidden" wording alone would normally
  // match isAuthenticationFailure — the entitlement phrasing must win.
  const BEDROCK_ENTITLEMENT_MESSAGE =
    'devpass-code CLI failed: UnknownError: Error from provider aws-bedrock: 403 Forbidden ' +
    '{"message":"anthropic.claude-sonnet-5 is not available for this account. You can explore ' +
    'other available models on Amazon Bedrock. ..."} Run `devpass-code providers login` in a ' +
    "terminal and complete the LLM Gateway DevPass sign-in, then try again.";

  void it("classifies a Bedrock-style entitlement 403 as model-entitlement, not generic/quota", () => {
    assert.strictEqual(
      classifyFailure({ errorMessage: BEDROCK_ENTITLEMENT_MESSAGE }).failureKind,
      "model-entitlement"
    );
  });

  void it("never classifies entitlement messages as quota, even though 'credits'/'limit' style wording is absent", () => {
    assert.strictEqual(isQuotaError(BEDROCK_ENTITLEMENT_MESSAGE), false);
  });
});

void describe("isModelEntitlementFailure", () => {
  void it("recognizes the Bedrock 'not available for this account' phrasing", () => {
    assert.strictEqual(
      isModelEntitlementFailure(
        'anthropic.claude-sonnet-5 is not available for this account. You can explore other available models.'
      ),
      true
    );
  });

  void it("recognizes per-provider equivalents", () => {
    assert.strictEqual(isModelEntitlementFailure("This model is not enabled for this account."), true);
    assert.strictEqual(isModelEntitlementFailure("The caller does not have access to model gpt-9."), true);
  });

  void it("returns false for genuine credential failures, including ones mentioning entitlement-adjacent words", () => {
    assert.strictEqual(isModelEntitlementFailure("403 Forbidden"), false);
    assert.strictEqual(isModelEntitlementFailure("Insufficient balance."), false);
    // "entitled" appears here, but not the discriminating phrase — must not
    // false-positive on incidental use of the word.
    assert.strictEqual(isModelEntitlementFailure("403 Forbidden: subscription not entitled"), false);
    assert.strictEqual(isModelEntitlementFailure(undefined), false);
  });
});

void describe("isAuthenticationFailure — excludes model-entitlement phrasing", () => {
  void it("does not classify a Bedrock-style entitlement 403 as an authentication failure", () => {
    assert.strictEqual(
      isAuthenticationFailure(
        '403 Forbidden {"message":"anthropic.claude-sonnet-5 is not available for this account."}'
      ),
      false
    );
  });

  void it("still classifies a genuine 403 with no entitlement phrasing as an authentication failure", () => {
    assert.strictEqual(isAuthenticationFailure("403 Forbidden"), true);
  });
});

void describe("isCascadeEligibleFailureKind", () => {
  void it("includes model-entitlement alongside quota and temporarily-unavailable", () => {
    assert.strictEqual(isCascadeEligibleFailureKind("quota"), true);
    assert.strictEqual(isCascadeEligibleFailureKind("temporarily-unavailable"), true);
    assert.strictEqual(isCascadeEligibleFailureKind("model-entitlement"), true);
  });

  void it("excludes generic and undefined", () => {
    assert.strictEqual(isCascadeEligibleFailureKind("generic"), false);
    assert.strictEqual(isCascadeEligibleFailureKind(undefined), false);
  });
});

void describe("recordQuotaObservation / formatQuotaStatus — entitlement-blocked", () => {
  void it("records a model-entitlement failure as entitlement-blocked, never ok", () => {
    __quotaTestOnly.clear();
    void recordQuotaObservation(
      "impl",
      "bedrock/anthropic.claude-sonnet-5",
      "model-entitlement",
      "not available for this account"
    );
    const observation = getQuotaObservation("impl", "bedrock/anthropic.claude-sonnet-5");
    assert.strictEqual(observation?.state, "entitlement-blocked");
    const status = formatQuotaStatus(observation);
    assert.doesNotMatch(status, /^OK/);
    assert.match(status, /not available for this account/i);
  });
});

void describe("parseQuotaResetV1 — clock-time shape", () => {
  void it("resolves today's occurrence when it has not yet passed, in a fixed-offset zone", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    assert.strictEqual(
      parseQuotaResetV1("You've hit your session limit · resets 12:10am (UTC)", now),
      "2026-01-01T00:10:00.000Z"
    );
  });

  void it("rolls to tomorrow when today's occurrence has already passed", () => {
    const now = new Date("2026-01-01T01:00:00.000Z");
    assert.strictEqual(
      parseQuotaResetV1("resets 12:10am (UTC)", now),
      "2026-01-02T00:10:00.000Z"
    );
  });

  void it("resolves a pm time correctly", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    assert.strictEqual(
      parseQuotaResetV1("resets 11:59pm (UTC)", now),
      "2026-01-01T23:59:00.000Z"
    );
  });

  void it("resolves a real IANA zone to a future instant within one day", () => {
    // Not asserting the exact instant here (that depends on DST rules this
    // test should not have to encode) — just that the real-zone path
    // resolves to a defined, future, same-or-next-day instant.
    const now = new Date("2026-06-15T00:00:00.000Z");
    const result = parseQuotaResetV1("resets 12:10am (Asia/Jerusalem)", now);
    assert.notStrictEqual(result, undefined);
    const resultMs = new Date(result!).getTime();
    assert.ok(resultMs > now.getTime());
    assert.ok(resultMs - now.getTime() <= 48 * 60 * 60 * 1000);
  });

  void it("rolls to tomorrow in a west-of-UTC (negative-offset) zone", () => {
    // Regression for a defect where the next-day candidate was derived by
    // reformatting a shifted UTC instant through the zone: for a
    // negative-offset zone that round trip can land back on the *same*
    // calendar day, so the rollover silently failed and the function
    // returned undefined even though a real future occurrence existed.
    const now = new Date("2026-01-02T09:00:00.000Z"); // 2026-01-02T01:00 America/Los_Angeles (PST, UTC-8)
    assert.strictEqual(
      parseQuotaResetV1("resets 12:10am (America/Los_Angeles)", now),
      "2026-01-03T08:10:00.000Z" // 2026-01-03T00:10 PST == 2026-01-03T08:10Z
    );
  });

  void it("rejects a wall-clock time that a DST spring-forward gap skips, and rolls to the next valid day", () => {
    // America/New_York springs forward at 2026-03-08T07:00:00Z (2:00 EST ==
    // 07:00Z); local times from 02:00 to 02:59 do not exist that day. The
    // requested 02:30 must not be returned as a shifted/incorrect instant —
    // the candidate is rejected by the round-trip check and the next day's
    // (unambiguous) occurrence is returned instead.
    const now = new Date("2026-03-08T06:00:00.000Z"); // 2026-03-08T01:00 America/New_York (EST, UTC-5)
    assert.strictEqual(
      parseQuotaResetV1("resets 2:30am (America/New_York)", now),
      "2026-03-09T06:30:00.000Z" // 2026-03-09T02:30 EDT == 2026-03-09T06:30Z
    );
  });

  void it("returns undefined for a wall-clock time that a DST fall-back fold repeats", () => {
    // America/New_York falls back at 2026-11-01T06:00:00Z (2:00 EDT ==
    // 06:00Z, clocks move to 1:00 EST): local times from 01:00 to 01:59
    // occur twice that day (once as EDT, once as EST). The requested 01:30
    // is genuinely ambiguous — two distinct UTC instants both reproduce it —
    // so the parser must return undefined rather than arbitrarily pick one.
    const now = new Date("2026-11-01T00:00:00.000Z"); // 2026-10-31T20:00 America/New_York (EDT, UTC-4)
    assert.strictEqual(parseQuotaResetV1("resets 1:30am (America/New_York)", now), undefined);
  });

  void it("returns undefined for an unrecognized IANA zone", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    assert.strictEqual(parseQuotaResetV1("resets 12:10am (Not/AZone)", now), undefined);
  });

  void it("returns undefined for an invalid minute or hour", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    assert.strictEqual(parseQuotaResetV1("resets 12:70am (UTC)", now), undefined);
    assert.strictEqual(parseQuotaResetV1("resets 13:10pm (UTC)", now), undefined);
  });
});

void describe("parseQuotaResetV1 — relative-duration shape", () => {
  void it("parses a multi-unit duration (days + hours)", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    assert.strictEqual(
      parseQuotaResetV1("resets in 8d 19h", now),
      new Date(now.getTime() + 8 * 86_400_000 + 19 * 3_600_000).toISOString()
    );
  });

  void it("parses whole-word minutes", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    assert.strictEqual(
      parseQuotaResetV1("resets in 45 minutes", now),
      new Date(now.getTime() + 45 * 60_000).toISOString()
    );
  });

  void it("parses abbreviated hours + minutes", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    assert.strictEqual(
      parseQuotaResetV1("in 2h 30m", now),
      new Date(now.getTime() + 2 * 3_600_000 + 30 * 60_000).toISOString()
    );
  });

  void it("returns undefined for an unrecognized unit rather than a partial total", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    assert.strictEqual(parseQuotaResetV1("resets in 3 fortnights", now), undefined);
  });
});

void describe("parseQuotaResetV1 — no match", () => {
  void it("returns undefined for a message with no recognizable reset phrasing", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    assert.strictEqual(parseQuotaResetV1("Claude Code CLI exited with code 1.", now), undefined);
    assert.strictEqual(parseQuotaResetV1(undefined, now), undefined);
  });
});

void describe("recordQuotaObservation / formatQuotaStatus — reset time", () => {
  void it("parses and surfaces a reset time for a quota failure", () => {
    __quotaTestOnly.clear();
    void recordQuotaObservation(
      "impl",
      "claude-cli",
      "quota",
      "You've hit your session limit · resets in 45 minutes"
    );
    const observation = getQuotaObservation("impl", "claude-cli");
    assert.notStrictEqual(observation?.resetAt, undefined);
    const status = formatQuotaStatus(observation);
    assert.match(status, /resets/i);
  });

  void it("does not attach a reset time to a non-quota observation", () => {
    __quotaTestOnly.clear();
    void recordQuotaObservation("impl", "claude-cli", "generic", "exited with code 1");
    const observation = getQuotaObservation("impl", "claude-cli");
    assert.strictEqual(observation?.resetAt, undefined);
  });
});

// ─── Part 5 step 2/3: cross-restart ledger + remedy-text branching ─────────

/** Minimal in-memory Memento-backed ExtensionContext stub — simulates a host
 * restart by constructing a FRESH context object that reads from the same
 * backing store, exactly as VS Code's real globalState survives restarts. */
function createFakeExtensionContext(
  store: Map<string, unknown> = new Map()
): { context: import("vscode").ExtensionContext; store: Map<string, unknown> } {
  const context = {
    globalState: {
      get<T>(key: string, fallback?: T): T {
        return store.has(key) ? (store.get(key) as T) : (fallback as T);
      },
      update(key: string, value: unknown): Promise<void> {
        if (value === undefined) {
          store.delete(key);
        } else {
          store.set(key, value);
        }
        return Promise.resolve();
      },
      keys: (): readonly string[] => Array.from(store.keys()),
      setKeysForSync: (): void => undefined,
    },
    // Cast: only globalState is exercised by recordQuotaObservation/ledger reads.
  } as unknown as import("vscode").ExtensionContext;
  return { context, store };
}

void describe("resolveQuotaAccountKeyV1 — provider account labels", () => {
  void it("returns the bare ProviderAccountId when no label is configured (default, backward compatible)", () => {
    withProviderAccountLabels({}, () => {
      assert.strictEqual(resolveQuotaAccountKeyV1("claude-cli:opus"), "claude-cli");
    });
  });

  void it("suffixes the account key with a user-declared label", () => {
    withProviderAccountLabels({ "claude-cli": "work" }, () => {
      assert.strictEqual(resolveQuotaAccountKeyV1("claude-cli:opus"), "claude-cli#work");
    });
  });

  void it("two credentials for the same provider+model no longer cross-contaminate once labeled", async () => {
    __quotaTestOnly.clear();
    const { context } = createFakeExtensionContext();
    await withProviderAccountLabels({ "claude-cli": "work" }, () =>
      recordQuotaObservation("impl", "claude-cli:opus", "quota", "resets in 1h", context)
    );
    // A second credential (declared "personal") hitting the SAME provider and
    // model must not read the "work" credential's parked quota state.
    const personalObservation = await withProviderAccountLabels({ "claude-cli": "personal" }, () =>
      Promise.resolve(getQuotaLedgerEntry(context, "claude-cli", "claude-cli#personal", "claude-cli:opus"))
    );
    assert.strictEqual(personalObservation, undefined);
    const workObservation = getQuotaLedgerEntry(context, "claude-cli", "claude-cli#work", "claude-cli:opus");
    assert.notStrictEqual(workObservation, undefined);
    assert.strictEqual(workObservation?.failureKind, "quota");
  });

  void it("recordQuotaObservation's accountKeyOverride survives a label edit made mid-run (review completion blocker)", async () => {
    __quotaTestOnly.clear();
    const { context } = createFakeExtensionContext();
    // Simulate a caller (runnerRegistry.ts) that resolved the account key
    // BEFORE dispatching a run, exactly as `primaryAccountKey`/`backupAccountKey`
    // do — capturing "work" while that was the live label.
    const accountKeyCapturedBeforeDispatch = withProviderAccountLabels(
      { "claude-cli": "work" },
      () => resolveQuotaAccountKeyV1("claude-cli:opus")
    );
    assert.strictEqual(accountKeyCapturedBeforeDispatch, "claude-cli#work");
    // The user edits the active label WHILE the run is still in flight —
    // by the time recordQuotaObservation is called (after the run settles),
    // live settings would resolve to "personal" instead.
    await withProviderAccountLabels({ "claude-cli": "personal" }, () =>
      recordQuotaObservation(
        "impl",
        "claude-cli:opus",
        "quota",
        "resets in 1h",
        context,
        undefined,
        accountKeyCapturedBeforeDispatch
      )
    );
    // The ledger entry lands under the identity that was true when the
    // attempt was actually dispatched, not the identity live at write time.
    const workObservation = getQuotaLedgerEntry(context, "claude-cli", "claude-cli#work", "claude-cli:opus");
    assert.notStrictEqual(workObservation, undefined);
    assert.strictEqual(workObservation?.failureKind, "quota");
    const personalObservation = getQuotaLedgerEntry(context, "claude-cli", "claude-cli#personal", "claude-cli:opus");
    assert.strictEqual(personalObservation, undefined);
  });

  void it("recordQuotaObservation resolves the account key live when no override is supplied (unchanged default behavior)", async () => {
    __quotaTestOnly.clear();
    const { context } = createFakeExtensionContext();
    await withProviderAccountLabels({ "claude-cli": "solo" }, () =>
      recordQuotaObservation("impl", "claude-cli:opus", "quota", "resets in 1h", context)
    );
    const soloObservation = getQuotaLedgerEntry(context, "claude-cli", "claude-cli#solo", "claude-cli:opus");
    assert.notStrictEqual(soloObservation, undefined);
  });
});

void describe("recordQuotaObservation — globalState ledger (Part 5 step 2)", () => {
  // recordQuotaObservation derives its accountKey via resolveQuotaAccountKeyV1,
  // which for a non-opencode CLI provider with no declared account label
  // returns the provider id itself — so entries it writes are keyed with
  // accountKey === "claude-cli" here, not "(default)".
  void it("round-trips a quota park entry through a fresh context (simulated host restart)", async () => {
    __quotaTestOnly.clear();
    const { store } = createFakeExtensionContext();
    const { context: freshContext } = createFakeExtensionContext(store);
    await recordQuotaObservation(
      "impl",
      "claude-cli:opus",
      "quota",
      "You've hit your session limit · resets in 45 minutes",
      freshContext
    );
    // A SECOND fresh context object backed by the SAME store simulates
    // reading the ledger back after an extension-host restart.
    const { context: restarted } = createFakeExtensionContext(store);
    const entry = getQuotaLedgerEntry(restarted, "claude-cli", "claude-cli", "claude-cli:opus");
    assert.strictEqual(entry?.failureKind, "quota");
    assert.notStrictEqual(entry?.resetAt, undefined);
  });

  void it("two different accounts sharing a model id do not cross-contaminate the ledger", () => {
    // This test exercises the LEDGER'S OWN key-isolation guarantee directly:
    // an entry written under one accountKey must never be visible under a
    // different one. See the "resolveQuotaAccountKeyV1 — provider account
    // labels" suite above for the end-to-end case (recordQuotaObservation
    // itself, driven by two distinct user-declared account labels).
    __quotaTestOnly.clear();
    const { context, store } = createFakeExtensionContext();
    const key1 = quotaLedgerKey("claude-cli", "account-a", "claude-cli:opus");
    const key2 = quotaLedgerKey("claude-cli", "account-b", "claude-cli:opus");
    assert.notStrictEqual(key1, key2);
    store.set("ensembleQuotaLedgerV1", {
      [key1]: { failureKind: "quota", observedAt: new Date().toISOString() },
    });
    assert.notStrictEqual(
      getQuotaLedgerEntry(context, "claude-cli", "account-a", "claude-cli:opus"),
      undefined
    );
    assert.strictEqual(
      getQuotaLedgerEntry(context, "claude-cli", "account-b", "claude-cli:opus"),
      undefined
    );
  });

  void it("a later successful (non-quota) observation clears the ledger entry", async () => {
    __quotaTestOnly.clear();
    const { context } = createFakeExtensionContext();
    await recordQuotaObservation("impl", "claude-cli:opus", "quota", "resets in 1h", context);
    assert.notStrictEqual(
      getQuotaLedgerEntry(context, "claude-cli", "claude-cli", "claude-cli:opus"),
      undefined
    );
    await recordQuotaObservation("impl", "claude-cli:opus", "generic", undefined, context);
    assert.strictEqual(
      getQuotaLedgerEntry(context, "claude-cli", "claude-cli", "claude-cli:opus"),
      undefined
    );
  });

  void it("a contradicting temporarily-unavailable observation clears a parked entry", async () => {
    __quotaTestOnly.clear();
    const { context } = createFakeExtensionContext();
    await recordQuotaObservation("impl", "claude-cli:opus", "model-entitlement", "not entitled to model", context);
    assert.notStrictEqual(
      getQuotaLedgerEntry(context, "claude-cli", "claude-cli", "claude-cli:opus"),
      undefined
    );
    await recordQuotaObservation("impl", "claude-cli:opus", "temporarily-unavailable", "service unavailable", context);
    assert.strictEqual(
      getQuotaLedgerEntry(context, "claude-cli", "claude-cli", "claude-cli:opus"),
      undefined
    );
  });

  void it("mere time passing does not clear a parked entry (only an explicit clearing observation does)", async () => {
    __quotaTestOnly.clear();
    const { context } = createFakeExtensionContext();
    const pastResetAt = new Date(Date.now() - 60_000).toISOString();
    await recordQuotaObservation(
      "impl",
      "claude-cli:opus",
      "quota",
      undefined,
      context,
      pastResetAt
    );
    const entry = getQuotaLedgerEntry(context, "claude-cli", "claude-cli", "claude-cli:opus");
    assert.strictEqual(entry?.resetAt, pastResetAt);
  });

  void it("omitting context preserves session-only behavior (no ledger write, no throw)", () => {
    __quotaTestOnly.clear();
    assert.doesNotThrow(() => {
      void recordQuotaObservation("impl", "claude-cli:opus", "quota", "resets in 1h");
    });
    const observation = getQuotaObservation("impl", "claude-cli:opus");
    assert.notStrictEqual(observation, undefined);
  });

  // Review completion blocker: production call sites previously fired the
  // ledger write with `void updateQuotaLedger(...)` and never observed
  // whether it landed — a caller had no way to know the durable write had
  // actually completed before, say, composing a remedy message from it.
  // recordQuotaObservation now returns the write's own promise (production
  // call sites in runnerRegistry.ts `await` it) so this is verifiable
  // directly rather than inferred from timing.
  void it("returns a promise that resolves only once the durable write has landed", async () => {
    __quotaTestOnly.clear();
    const { context } = createFakeExtensionContext();
    const write = recordQuotaObservation(
      "impl",
      "claude-cli:opus",
      "quota",
      "resets in 1h",
      context
    );
    assert.strictEqual(typeof write.then, "function");
    await write;
    const entry = getQuotaLedgerEntry(context, "claude-cli", "claude-cli", "claude-cli:opus");
    assert.notStrictEqual(entry, undefined);
  });

  /** Same shape as createFakeExtensionContext, but `update` resolves after a
   * macrotask delay instead of synchronously — this is what actually exposes
   * an unserialized read-modify-write: two overlapping calls issued back to
   * back would otherwise both read the ledger before either write lands, and
   * the second write to land would silently clobber the first. */
  function createDelayedFakeExtensionContext(
    store: Map<string, unknown> = new Map()
  ): { context: import("vscode").ExtensionContext; store: Map<string, unknown> } {
    const context = {
      globalState: {
        get<T>(key: string, fallback?: T): T {
          return store.has(key) ? (store.get(key) as T) : (fallback as T);
        },
        update(key: string, value: unknown): Promise<void> {
          return new Promise((resolve) => {
            setTimeout(() => {
              if (value === undefined) {
                store.delete(key);
              } else {
                store.set(key, value);
              }
              resolve();
            }, 5);
          });
        },
        keys: (): readonly string[] => Array.from(store.keys()),
        setKeysForSync: (): void => undefined,
      },
    } as unknown as import("vscode").ExtensionContext;
    return { context, store };
  }

  // Review completion blocker: `updateQuotaLedger` previously performed its
  // read/mutate/write inline with no serialization, so two observations for
  // DIFFERENT keys on the same context, issued without awaiting the first,
  // could race — the second write's read taken before the first write landed
  // would silently drop the first write's key entirely.
  void it("two concurrent observations for different models on the same context do not clobber each other", async () => {
    __quotaTestOnly.clear();
    const { context } = createDelayedFakeExtensionContext();
    const writeA = recordQuotaObservation(
      "impl",
      "claude-cli:opus",
      "quota",
      "resets in 1h",
      context
    );
    const writeB = recordQuotaObservation(
      "impl",
      "claude-cli:sonnet",
      "model-entitlement",
      "not available for this account",
      context
    );
    await Promise.all([writeA, writeB]);
    const entryA = getQuotaLedgerEntry(context, "claude-cli", "claude-cli", "claude-cli:opus");
    const entryB = getQuotaLedgerEntry(context, "claude-cli", "claude-cli", "claude-cli:sonnet");
    assert.strictEqual(entryA?.failureKind, "quota");
    assert.strictEqual(entryB?.failureKind, "model-entitlement");
  });

  void it("a park followed immediately by a clearing observation for the same key applies in call order", async () => {
    __quotaTestOnly.clear();
    const { context } = createDelayedFakeExtensionContext();
    const park = recordQuotaObservation(
      "impl",
      "claude-cli:opus",
      "quota",
      "resets in 1h",
      context
    );
    const clear = recordQuotaObservation("impl", "claude-cli:opus", "generic", undefined, context);
    await Promise.all([park, clear]);
    const entry = getQuotaLedgerEntry(context, "claude-cli", "claude-cli", "claude-cli:opus");
    assert.strictEqual(entry, undefined);
  });
});

void describe("buildQuotaRemedyTextV1 — threshold branching (Part 5 step 3)", () => {
  void it("keeps today's wording byte-for-byte when no reset time is known", () => {
    assert.strictEqual(
      buildQuotaRemedyTextV1(undefined),
      "Rerun this stage to retry with the same model, or switch the stage's model before rerunning."
    );
  });

  void it("keeps today's wording for an unparsable reset time", () => {
    assert.strictEqual(
      buildQuotaRemedyTextV1("not-a-real-timestamp"),
      "Rerun this stage to retry with the same model, or switch the stage's model before rerunning."
    );
  });

  void it("a near reset (within threshold) mentions the rerun time and the offered Rerun after reset action", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const resetAt = new Date(now.getTime() + 2 * 3_600_000).toISOString(); // 2h away
    const text = buildQuotaRemedyTextV1(resetAt, now, 24);
    assert.match(text, /Rerun this stage after/);
    assert.match(text, /"Rerun after reset"/);
    assert.doesNotMatch(text, /expected to stay blocked until/);
  });

  void it("a far reset (beyond threshold) advises switching models without offering an immediate rerun", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const resetAt = new Date(now.getTime() + 8 * 86_400_000).toISOString(); // 8 days away
    const text = buildQuotaRemedyTextV1(resetAt, now, 24);
    assert.match(text, /expected to stay blocked until/);
    assert.match(text, /switch the stage's model/);
    assert.doesNotMatch(text, /^Rerun this stage after/);
  });

  void it("honors a custom threshold override at the exact boundary", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const resetAt = new Date(now.getTime() + 10 * 3_600_000).toISOString(); // exactly 10h away
    assert.match(buildQuotaRemedyTextV1(resetAt, now, 10), /Rerun this stage after/);
    assert.match(buildQuotaRemedyTextV1(resetAt, now, 9), /expected to stay blocked until/);
  });
});

void describe("isQuotaResetBeyondThresholdV1 — the same branch buildQuotaRemedyTextV1 uses (Part 5 step 3b)", () => {
  void it("is false with no known reset time", () => {
    assert.strictEqual(isQuotaResetBeyondThresholdV1(undefined), false);
  });

  void it("is false for an unparsable reset time", () => {
    assert.strictEqual(isQuotaResetBeyondThresholdV1("not-a-real-timestamp"), false);
  });

  void it("is false for a near reset and true for a far reset, at the same threshold buildQuotaRemedyTextV1 branches on", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const nearResetAt = new Date(now.getTime() + 2 * 3_600_000).toISOString();
    const farResetAt = new Date(now.getTime() + 8 * 86_400_000).toISOString();
    assert.strictEqual(isQuotaResetBeyondThresholdV1(nearResetAt, now, 24), false);
    assert.strictEqual(isQuotaResetBeyondThresholdV1(farResetAt, now, 24), true);
  });

  void it("honors a custom threshold override at the exact boundary, matching buildQuotaRemedyTextV1's own boundary", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const resetAt = new Date(now.getTime() + 10 * 3_600_000).toISOString();
    assert.strictEqual(isQuotaResetBeyondThresholdV1(resetAt, now, 10), false);
    assert.strictEqual(isQuotaResetBeyondThresholdV1(resetAt, now, 9), true);
  });
});
