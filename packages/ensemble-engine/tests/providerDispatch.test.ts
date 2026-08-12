/**
 * Provider dispatch suite (plan Part 4b).
 *
 * Three layers of coverage:
 *  1. **Result-envelope dual-decode parity** — a corpus of framed responses
 *     (valid and malformed) runs through BOTH the extension's
 *     `src/types/aiResultEnvelope.ts` parser and the engine's port; every
 *     valid input must decode identically under both and every invalid input
 *     must be rejected by both with the same malformed code. This is the
 *     drift detector for the one `src` contract Part 4b newly consumes.
 *  2. **Chain/selection semantics** — skip flags, general-model fallback,
 *     strategy gating, dedupe, and the disabled-provider guard, ported from
 *     `modelSelection.ts`/`runnerRegistry.ts`.
 *  3. **Dispatch cascade semantics** — auth failures never cascade, quota
 *     failures cascade once per stage epoch under the reservation CAS, a
 *     completed backup becomes the sticky route, an unresolved reservation
 *     is released — plus the HTTP adapters' failure mapping and key
 *     scrubbing over an injected fetch.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AiResultParseOutcomeV1,
  parseAiResultEnvelopeV1,
} from "../src/resultEnvelopeV1";
import {
  classifyEngineProviderFailureV1,
  isAuthenticationFailureV1,
} from "../src/failureClassificationV1";
import {
  backupModelsForStageV1,
  resolveEffectiveStageChainV1,
  resolveEngineModelForStageV1,
} from "../src/modelChainV1";
import {
  EngineProviderIdV1,
  isEngineModelProviderDisabledV1,
  normalizeEngineQualifiedModelIdV1,
  parseEngineModelSelectionV1,
} from "../src/providerCatalogV1";
import {
  createAnthropicAdapterV1,
  createGoogleAdapterV1,
  createOpenAiAdapterV1,
  EngineModelProviderAdapterV1,
  EngineTextInvocationV1,
  FetchLikeV1,
} from "../src/providerAdaptersV1";
import {
  createEngineProviderRunnerV1,
  createInMemoryFallbackStateStoreV1,
} from "../src/providerDispatchV1";
import { EngineProviderInvocationV1 } from "../src/taskLoopV1";
import { allocateHex128IdV1 } from "../../ensemble-core/src/actionCorrelationV1";
import { sha256HexUtf8V1 } from "../../ensemble-core/src/sha256V1";
import { ModelSettings } from "../../ensemble-core/src/settingsV1";

// --- the extension's own parser (parity oracle) ------------------------------
import * as srcEnvelope from "../../../src/types/aiResultEnvelope";

const CORRELATION = {
  actionKey: "engine.runRound.v1",
  operationId: allocateHex128IdV1(),
  attemptId: allocateHex128IdV1(),
  taskBindingId: sha256HexUtf8V1("binding"),
  chatDocumentId: sha256HexUtf8V1("chat-doc"),
};

function frame(payload: unknown): string {
  return `<<<ENSEMBLE_AI_RESULT_V1>>>\n${JSON.stringify(payload)}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>\n`;
}

// ─── 1. Envelope dual-decode parity ─────────────────────────────────────────

test("result-envelope corpus: engine port and src parser agree on every accept and reject", () => {
  const corpus: readonly { readonly name: string; readonly raw: string }[] = [
    {
      name: "completed markdown artifact",
      raw: frame({
        version: 1,
        correlation: CORRELATION,
        kind: "completed",
        content: {
          contentType: "markdown-artifact.v1",
          schemaVersion: 1,
          markdown: "# Round summary\n\n- [x] item one\n",
        },
      }),
    },
    {
      name: "completed chat message",
      raw: frame({
        version: 1,
        correlation: CORRELATION,
        kind: "completed",
        content: { contentType: "chat-message.v1", schemaVersion: 1, text: "done" },
      }),
    },
    {
      name: "questions",
      raw: frame({
        version: 1,
        correlation: CORRELATION,
        kind: "questions",
        questions: [
          {
            questionId: "q-1",
            kind: "text",
            prompt: "Which module first?",
            required: true,
            allowBlank: false,
            maxLength: 100,
          },
        ],
      }),
    },
    {
      name: "failed",
      raw: frame({
        version: 1,
        correlation: CORRELATION,
        kind: "failed",
        code: "providerUnreachable",
        message: "upstream closed",
        retryable: true,
      }),
    },
    {
      name: "cancelled with reason",
      raw: frame({ version: 1, correlation: CORRELATION, kind: "cancelled", reason: "user" }),
    },
    {
      name: "narration before the frame is tolerated (last frame wins)",
      raw:
        "Let me verify the checklist first...\n" +
        frame({
          version: 1,
          correlation: CORRELATION,
          kind: "completed",
          content: { contentType: "chat-message.v1", schemaVersion: 1, text: "ok" },
        }),
    },
    { name: "no frame at all", raw: "just prose, no frame" },
    { name: "empty payload", raw: "<<<ENSEMBLE_AI_RESULT_V1>>>\n\n<<<END_ENSEMBLE_AI_RESULT_V1>>>" },
    {
      name: "duplicate JSON keys reject",
      raw: `<<<ENSEMBLE_AI_RESULT_V1>>>\n{"version":1,"version":1}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>`,
    },
    {
      name: "unknown envelope field",
      raw: frame({ version: 1, correlation: CORRELATION, kind: "cancelled", extra: true }),
    },
    {
      name: "unknown content type",
      raw: frame({
        version: 1,
        correlation: CORRELATION,
        kind: "completed",
        content: { contentType: "mystery.v1", schemaVersion: 1 },
      }),
    },
    {
      name: "oversized commit subject",
      raw: frame({
        version: 1,
        correlation: CORRELATION,
        kind: "completed",
        content: {
          contentType: "commit-metadata.v1",
          schemaVersion: 1,
          subject: "x".repeat(73),
        },
      }),
    },
    {
      name: "correlation mismatch",
      raw: frame({
        version: 1,
        correlation: { ...CORRELATION, attemptId: allocateHex128IdV1() },
        kind: "cancelled",
      }),
    },
    {
      name: "multiline JSON payload rejects",
      raw: `<<<ENSEMBLE_AI_RESULT_V1>>>\n{\n"version":1}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>`,
    },
    {
      name: "BOM rejects",
      raw:
        String.fromCharCode(0xfeff) +
        frame({ version: 1, correlation: CORRELATION, kind: "cancelled" }),
    },
  ];

  for (const entry of corpus) {
    const engineOutcome: AiResultParseOutcomeV1 = parseAiResultEnvelopeV1(entry.raw, CORRELATION);
    const srcOutcome = srcEnvelope.parseAiResultEnvelopeV1(entry.raw, CORRELATION);
    assert.equal(
      engineOutcome.kind === "malformed",
      srcOutcome.kind === "malformed",
      `${entry.name}: accept/reject disagreement (engine=${engineOutcome.kind}, src=${srcOutcome.kind})`
    );
    if (engineOutcome.kind === "malformed" && srcOutcome.kind === "malformed") {
      assert.equal(
        engineOutcome.code,
        srcOutcome.code,
        `${entry.name}: malformed-code disagreement`
      );
    } else {
      assert.deepEqual(
        JSON.parse(JSON.stringify(engineOutcome)),
        JSON.parse(JSON.stringify(srcOutcome)),
        `${entry.name}: decoded envelopes differ`
      );
    }
  }
});

// ─── 2. Chain/selection semantics ────────────────────────────────────────────

const SETTINGS: ModelSettings = {
  impl: {
    primary: "anthropic:claude-sonnet-5",
    backups: ["openai:gpt-5.4", "anthropic:sonnet", "openai:gpt-5.4", "google:gemini-3.1-pro"],
    backupsEnabled: [true, true, true, false],
    strategy: "switch-to-backup",
  },
  desc: {
    primary: "openai:gpt-5.4",
    backups: ["google:gemini-3.1-pro"],
    strategy: "alert-and-wait",
  },
};

test("effective chain: skip flags drop backups; a skipped primary promotes the first enabled backup", () => {
  const chain = resolveEffectiveStageChainV1(
    {
      impl: {
        primary: "anthropic:claude-sonnet-5",
        primaryEnabled: false,
        backups: ["openai:gpt-5.4", "google:gemini-3.1-pro"],
        backupsEnabled: [false, true],
        strategy: "switch-to-backup",
      },
    },
    "impl"
  );
  assert.equal(chain.source, "stage");
  assert.equal(chain.primary, "google:gemini-3.1-pro");
  assert.deepEqual(chain.backups, []);
});

test("effective chain: a blank stage inherits the general model's chain AND strategy", () => {
  const chain = resolveEffectiveStageChainV1(SETTINGS, "plan");
  assert.equal(chain.source, "general");
  assert.equal(chain.originStage, "desc");
  assert.equal(chain.primary, "openai:gpt-5.4");
  assert.equal(chain.strategy, "alert-and-wait");
});

test("backupModelsForStage: strategy-gated, deduped by normalized id, primary and disabled providers excluded", () => {
  const enabled = { anthropic: true, openai: true, google: true };
  // "anthropic:sonnet" normalizes to the primary via the alias table, and the
  // duplicated openai entry dedupes; the google entry is skip-flagged off.
  assert.deepEqual(
    backupModelsForStageV1(SETTINGS, enabled, "impl", "anthropic:claude-sonnet-5"),
    ["openai:gpt-5.4"]
  );
  // A disabled provider's backup is filtered.
  assert.deepEqual(
    backupModelsForStageV1(SETTINGS, { anthropic: true }, "impl", "anthropic:claude-sonnet-5"),
    []
  );
  // A non-switch-to-backup strategy returns nothing by design.
  assert.deepEqual(backupModelsForStageV1(SETTINGS, enabled, "desc", "openai:gpt-5.4"), []);
});

test("provider guard: active only once a selection exists; sticky-fallback routing honors the recorded model", () => {
  assert.equal(isEngineModelProviderDisabledV1(undefined, "anthropic:claude-sonnet-5"), false);
  assert.equal(
    isEngineModelProviderDisabledV1({ openai: true }, "anthropic:claude-sonnet-5"),
    true
  );
  assert.equal(
    isEngineModelProviderDisabledV1({ anthropic: true }, "anthropic:claude-sonnet-5"),
    false
  );
  assert.equal(
    normalizeEngineQualifiedModelIdV1("anthropic:sonnet"),
    "anthropic:claude-sonnet-5"
  );
  const parsedDefault = parseEngineModelSelectionV1("anthropic:default");
  assert.ok(parsedDefault.ok && parsedDefault.selection.model === undefined);
  assert.equal(parseEngineModelSelectionV1("bare-model-id").ok, false);

  const routed = resolveEngineModelForStageV1(SETTINGS, "impl", {
    active: true,
    modelId: "openai:gpt-5.4",
  });
  assert.equal(routed.modelId, "openai:gpt-5.4");
  const inactive = resolveEngineModelForStageV1(SETTINGS, "impl", { active: false });
  assert.equal(inactive.modelId, "anthropic:claude-sonnet-5");
});

// ─── 3. Dispatch cascade semantics ───────────────────────────────────────────

/** Extract the correlation echo the contract prompt embeds, as a real model must. */
function correlationFromPrompt(prompt: string): unknown {
  const match = /\(echo it verbatim\): (\{[^\n]*\})/.exec(prompt);
  assert.ok(match, "prompt does not carry the correlation echo instruction");
  return JSON.parse(match![1]!);
}

function completedFrameFor(prompt: string, markdown: string): string {
  return frame({
    version: 1,
    correlation: correlationFromPrompt(prompt),
    kind: "completed",
    content: { contentType: "markdown-artifact.v1", schemaVersion: 1, markdown },
  });
}

type ScriptedBehavior =
  | { readonly kind: "completed"; readonly markdown: string }
  | { readonly kind: "questions" }
  | { readonly kind: "authFailure" }
  | { readonly kind: "quota" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "malformed" };

function scriptedAdapter(
  providerId: "anthropic" | "openai" | "google",
  behavior: (invocation: EngineTextInvocationV1, count: number) => ScriptedBehavior
): EngineModelProviderAdapterV1 & { readonly invocations: EngineTextInvocationV1[] } {
  const invocations: EngineTextInvocationV1[] = [];
  return {
    providerId,
    invocations,
    async invokeText(input) {
      invocations.push(input);
      const scripted = behavior(input, invocations.length);
      switch (scripted.kind) {
        case "completed":
          return { status: "completed", text: completedFrameFor(input.prompt, scripted.markdown) };
        case "questions":
          return {
            status: "completed",
            text: frame({
              version: 1,
              correlation: correlationFromPrompt(input.prompt),
              kind: "questions",
              questions: [
                {
                  questionId: "q-1",
                  kind: "text",
                  prompt: "Which module first?",
                  required: true,
                  allowBlank: false,
                  maxLength: 100,
                },
              ],
            }),
          };
        case "authFailure":
          return {
            status: "failed",
            authFailure: true,
            errorMessage: "authentication failed (HTTP 401)",
          };
        case "quota":
          return { status: "failed", errorMessage: "rate limit or quota exhausted (HTTP 429)" };
        case "unavailable":
          return { status: "failed", errorMessage: "temporarily unavailable (HTTP 503)" };
        case "malformed":
          return { status: "completed", text: "no frame here at all" };
      }
    },
  };
}

function invocation(stage: "impl" = "impl"): EngineProviderInvocationV1 {
  return {
    taskId: "task-4b",
    taskFolder: "2026-08-12_task_4b",
    stage,
    round: 1,
    correlation: {
      actionKey: "engine.runRound.v1",
      operationId: allocateHex128IdV1(),
      attemptId: allocateHex128IdV1(),
      taskBindingId: sha256HexUtf8V1("binding-4b"),
      chatDocumentId: sha256HexUtf8V1("chat-doc-4b"),
    },
    planOfRecord: "# Plan\n\n- [ ] item\n",
  };
}

const KEYS: Record<string, string> = {
  anthropic: "sk-ant-test",
  openai: "sk-oa-test",
  google: "g-test",
};

function runner(options: {
  anthropic: ReturnType<typeof scriptedAdapter>;
  openai?: ReturnType<typeof scriptedAdapter>;
  settings?: ModelSettings;
  enabled?: Record<string, boolean>;
  keys?: Record<string, string>;
  fallbackState?: ReturnType<typeof createInMemoryFallbackStateStoreV1>;
}) {
  const adapters = new Map<EngineProviderIdV1, EngineModelProviderAdapterV1>();
  adapters.set("anthropic", options.anthropic);
  if (options.openai) {
    adapters.set("openai", options.openai);
  }
  return createEngineProviderRunnerV1({
    getModelSettings: () => options.settings ?? SETTINGS,
    getEnabledProviders: () => options.enabled,
    getProviderApiKey: (provider) => (options.keys ?? KEYS)[provider],
    adapters,
    ...(options.fallbackState !== undefined ? { fallbackState: options.fallbackState } : {}),
  });
}

test("dispatch: a framed completed response resolves to the round's summary markdown", async () => {
  const anthropic = scriptedAdapter("anthropic", () => ({
    kind: "completed",
    markdown: "# Summary\n\n- [x] item\n",
  }));
  const result = await runner({ anthropic }).invoke(invocation());
  assert.deepEqual(result, { kind: "completed", summaryMarkdown: "# Summary\n\n- [x] item\n" });
  assert.equal(anthropic.invocations.length, 1);
  assert.equal(anthropic.invocations[0]!.model, "claude-sonnet-5");
  assert.equal(anthropic.invocations[0]!.apiKey, "sk-ant-test");
});

test("dispatch: a framed questions response resolves to structured questions", async () => {
  const anthropic = scriptedAdapter("anthropic", () => ({ kind: "questions" }));
  const result = await runner({ anthropic }).invoke(invocation());
  assert.equal(result.kind, "questions");
  assert.ok(result.kind === "questions");
  assert.equal(result.questions[0]!.questionId, "q-1");
});

test("dispatch: an auth failure never cascades and never spends the reservation", async () => {
  const anthropic = scriptedAdapter("anthropic", () => ({ kind: "authFailure" }));
  const openai = scriptedAdapter("openai", () => ({ kind: "completed", markdown: "x" }));
  const fallbackState = createInMemoryFallbackStateStoreV1();
  const result = await runner({ anthropic, openai, fallbackState }).invoke(invocation());
  assert.deepEqual(result, { kind: "failed", code: "authenticationFailed", retryable: false });
  assert.equal(openai.invocations.length, 0, "a backup was invoked on an auth failure");
  assert.deepEqual(await fallbackState.read("impl"), { active: false });
});

test("dispatch: a missing API key is a terminal auth-style failure (no cascade)", async () => {
  const anthropic = scriptedAdapter("anthropic", () => ({ kind: "completed", markdown: "x" }));
  const openai = scriptedAdapter("openai", () => ({ kind: "completed", markdown: "x" }));
  const result = await runner({
    anthropic,
    openai,
    keys: { openai: "sk-oa-test" },
  }).invoke(invocation());
  assert.deepEqual(result, { kind: "failed", code: "missingApiKey", retryable: false });
  assert.equal(anthropic.invocations.length, 0);
  assert.equal(openai.invocations.length, 0);
});

test("dispatch: a disabled provider's model never runs once a selection exists", async () => {
  const anthropic = scriptedAdapter("anthropic", () => ({ kind: "completed", markdown: "x" }));
  const result = await runner({ anthropic, enabled: { openai: true } }).invoke(invocation());
  assert.equal(result.kind, "failed");
  assert.ok(result.kind === "failed");
  assert.equal(result.code, "providerDisabled");
  assert.equal(anthropic.invocations.length, 0);
});

test("dispatch: quota cascades once, records the sticky fallback, and later rounds route straight to it", async () => {
  const anthropic = scriptedAdapter("anthropic", () => ({ kind: "quota" }));
  const openai = scriptedAdapter("openai", () => ({ kind: "completed", markdown: "# ok\n" }));
  const fallbackState = createInMemoryFallbackStateStoreV1();
  const dispatch = runner({ anthropic, openai, fallbackState });

  const first = await dispatch.invoke(invocation());
  assert.deepEqual(first, { kind: "completed", summaryMarkdown: "# ok\n" });
  assert.equal(anthropic.invocations.length, 1);
  assert.equal(openai.invocations.length, 1);
  assert.deepEqual(await fallbackState.read("impl"), { active: true, modelId: "openai:gpt-5.4" });

  // The sticky route sends the SECOND round straight to the recorded backup.
  const second = await dispatch.invoke(invocation());
  assert.deepEqual(second, { kind: "completed", summaryMarkdown: "# ok\n" });
  assert.equal(anthropic.invocations.length, 1, "the exhausted primary was retried");
  assert.equal(openai.invocations.length, 2);
});

test("dispatch: a non-switch-to-backup strategy never cascades on quota", async () => {
  const settings: ModelSettings = {
    impl: {
      primary: "anthropic:claude-sonnet-5",
      backups: ["openai:gpt-5.4"],
      strategy: "pause-and-resume",
    },
  };
  const anthropic = scriptedAdapter("anthropic", () => ({ kind: "quota" }));
  const openai = scriptedAdapter("openai", () => ({ kind: "completed", markdown: "x" }));
  const result = await runner({ anthropic, openai, settings }).invoke(invocation());
  assert.deepEqual(result, { kind: "failed", code: "quotaExhausted", retryable: true });
  assert.equal(openai.invocations.length, 0);
});

test("dispatch: a backup auth failure stops the cascade and releases the reservation", async () => {
  const anthropic = scriptedAdapter("anthropic", () => ({ kind: "unavailable" }));
  const openai = scriptedAdapter("openai", () => ({ kind: "authFailure" }));
  const fallbackState = createInMemoryFallbackStateStoreV1();
  const result = await runner({ anthropic, openai, fallbackState }).invoke(invocation());
  assert.deepEqual(result, { kind: "failed", code: "authenticationFailed", retryable: false });
  assert.deepEqual(await fallbackState.read("impl"), { active: false });
});

test("dispatch: exhausted backups release the reservation and report the last failure", async () => {
  const anthropic = scriptedAdapter("anthropic", () => ({ kind: "quota" }));
  const openai = scriptedAdapter("openai", () => ({ kind: "quota" }));
  const fallbackState = createInMemoryFallbackStateStoreV1();
  const result = await runner({ anthropic, openai, fallbackState }).invoke(invocation());
  assert.deepEqual(result, { kind: "failed", code: "quotaExhausted", retryable: true });
  assert.deepEqual(await fallbackState.read("impl"), { active: false });
});

test("dispatch: a malformed frame is a typed retryable failure that never cascades", async () => {
  const anthropic = scriptedAdapter("anthropic", () => ({ kind: "malformed" }));
  const openai = scriptedAdapter("openai", () => ({ kind: "completed", markdown: "x" }));
  const result = await runner({ anthropic, openai }).invoke(invocation());
  assert.deepEqual(result, {
    kind: "failed",
    code: "malformedResult.invalidFrame",
    retryable: true,
  });
  assert.equal(openai.invocations.length, 0);
});

test("dispatch: a resumed invocation's prompt carries the user's answers", async () => {
  const anthropic = scriptedAdapter("anthropic", () => ({ kind: "completed", markdown: "x" }));
  await runner({ anthropic }).invoke({
    ...invocation(),
    answers: [
      { questionId: "q-1", kind: "text", state: "answered", value: "gamma first" },
    ],
  });
  const prompt = anthropic.invocations[0]!.prompt;
  assert.ok(prompt.includes("User answers to your structured questions"));
  assert.ok(prompt.includes("gamma first"));
});

// ─── 4. HTTP adapters ────────────────────────────────────────────────────────

function fakeFetch(
  responses: { status: number; body: string }[],
  calls: { url: string; headers: Record<string, string>; body: string }[]
): FetchLikeV1 {
  return (url, init) => {
    calls.push({ url, headers: { ...init.headers }, body: init.body });
    const next = responses.shift();
    if (!next) {
      return Promise.reject(new Error("fetch failed"));
    }
    return Promise.resolve({ status: next.status, text: () => Promise.resolve(next.body) });
  };
}

test("anthropic adapter: 200 extracts text; the key travels only in headers", async () => {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const adapter = createAnthropicAdapterV1({
    fetch: fakeFetch(
      [{ status: 200, body: JSON.stringify({ content: [{ type: "text", text: "hello" }] }) }],
      calls
    ),
  });
  const result = await adapter.invokeText({ prompt: "p", model: undefined, apiKey: "sk-ant-x" });
  assert.deepEqual(result, { status: "completed", text: "hello" });
  assert.equal(calls[0]!.headers["x-api-key"], "sk-ant-x");
  assert.ok(calls[0]!.url.endsWith("/v1/messages"));
  assert.ok(!calls[0]!.body.includes("sk-ant-x"), "the key leaked into the request body");
});

test("adapter HTTP mapping: 401 is an auth failure with the key scrubbed from the snippet; 429 classifies quota; 503 and thrown fetch classify temporarily-unavailable", async () => {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const key = "sk-oa-secret";
  const adapter = createOpenAiAdapterV1({
    fetch: fakeFetch(
      [
        { status: 401, body: `{"error":"bad key sk-oa-secret"}` },
        { status: 429, body: "{}" },
        { status: 503, body: "{}" },
      ],
      calls
    ),
  });
  const auth = await adapter.invokeText({ prompt: "p", model: "gpt-5.4", apiKey: key });
  assert.ok(auth.status === "failed" && auth.authFailure === true);
  assert.ok(!auth.errorMessage.includes(key), "the API key leaked into the error message");
  assert.ok(auth.errorMessage.includes("[redacted]"));

  const quota = await adapter.invokeText({ prompt: "p", model: "gpt-5.4", apiKey: key });
  assert.ok(quota.status === "failed");
  assert.equal(classifyEngineProviderFailureV1({ errorMessage: quota.errorMessage }).failureKind, "quota");

  const unavailable = await adapter.invokeText({ prompt: "p", model: "gpt-5.4", apiKey: key });
  assert.ok(unavailable.status === "failed");
  assert.equal(
    classifyEngineProviderFailureV1({ errorMessage: unavailable.errorMessage }).failureKind,
    "temporarily-unavailable"
  );

  // Responses exhausted: the next call's fetch throws ("fetch failed").
  const transport = await adapter.invokeText({ prompt: "p", model: "gpt-5.4", apiKey: key });
  assert.ok(transport.status === "failed");
  assert.equal(
    classifyEngineProviderFailureV1({ errorMessage: transport.errorMessage }).failureKind,
    "temporarily-unavailable"
  );
  assert.equal(isAuthenticationFailureV1(transport.errorMessage), false);
});

test("google adapter: 200 extracts candidate part text with the key in the header", async () => {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const adapter = createGoogleAdapterV1({
    fetch: fakeFetch(
      [
        {
          status: 200,
          body: JSON.stringify({
            candidates: [{ content: { role: "model", parts: [{ text: "hi " }, { text: "there" }] } }],
          }),
        },
      ],
      calls
    ),
  });
  const result = await adapter.invokeText({ prompt: "p", model: undefined, apiKey: "g-x" });
  assert.deepEqual(result, { status: "completed", text: "hi there" });
  assert.equal(calls[0]!.headers["x-goog-api-key"], "g-x");
  assert.ok(calls[0]!.url.includes("gemini-3.1-pro"));
});
