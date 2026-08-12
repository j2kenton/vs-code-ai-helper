/**
 * Direct model-provider API adapters (plan Part 4b).
 *
 * These replace the extension's VS Code LM path (`copilotModelResolution.ts`
 * / `copilotLanguageModelRunner.ts`) and CLI transports with plain HTTPS
 * calls against each provider's public API, authenticated with the user's
 * own key (resolved by the dispatch layer from Part 5 custody — decrypted
 * only in engine-run memory).
 *
 * Failure text is written so `classifyEngineProviderFailureV1` reaches the
 * same verdicts the extension's cascade gates rely on:
 *  - HTTP 401/403 → `authFailure: true` plus explicit auth wording (terminal
 *    for the provider; never spends a backup allocation);
 *  - HTTP 429 → "rate limit" wording (quota; cascade-eligible);
 *  - HTTP 5xx/529 → "temporarily unavailable" wording (cascade-eligible);
 *  - a thrown fetch → the raw transport error text ("fetch failed",
 *    "socket hang up", …), which the engine classifier may promote to
 *    temporarily-unavailable because adapter diagnostics are scoped to the
 *    transport layer, never model prose.
 *
 * The API key travels ONLY in request headers. Error messages embed at most
 * a bounded response-body snippet with any occurrence of the key scrubbed,
 * so a logged failure can never leak a credential.
 */
import { EngineProviderIdV1, getEngineProviderV1 } from "./providerCatalogV1";

/** Minimal fetch shape so tests and hosts can inject their own transport. */
export interface FetchResponseLikeV1 {
  readonly status: number;
  text(): Promise<string>;
}
export type FetchLikeV1 = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly signal?: AbortSignal;
  }
) => Promise<FetchResponseLikeV1>;

export interface EngineTextInvocationV1 {
  readonly prompt: string;
  /** Provider-native model name; undefined = the provider's default model. */
  readonly model: string | undefined;
  readonly apiKey: string;
  readonly signal?: AbortSignal;
}

export type EngineAdapterResultV1 =
  | { readonly status: "completed"; readonly text: string }
  | {
      readonly status: "failed";
      readonly errorMessage: string;
      readonly authFailure?: boolean;
    };

export interface EngineModelProviderAdapterV1 {
  readonly providerId: EngineProviderIdV1;
  invokeText(input: EngineTextInvocationV1): Promise<EngineAdapterResultV1>;
}

export interface CreateAdapterOptionsV1 {
  readonly fetch: FetchLikeV1;
  /** Override the catalog's default base URL (proxies, self-hosted relays). */
  readonly baseUrl?: string;
  /** Anthropic requires an explicit output cap; default is deliberately modest. */
  readonly maxOutputTokens?: number;
}

const MAX_BODY_SNIPPET_CHARS_V1 = 600;
const DEFAULT_MAX_OUTPUT_TOKENS_V1 = 8192;

function scrub(text: string, apiKey: string): string {
  return apiKey.length > 0 ? text.split(apiKey).join("[redacted]") : text;
}

function bodySnippet(body: string, apiKey: string): string {
  const flattened = scrub(body, apiKey).replace(/\s+/g, " ").trim();
  return flattened.length > MAX_BODY_SNIPPET_CHARS_V1
    ? `${flattened.slice(0, MAX_BODY_SNIPPET_CHARS_V1)}…`
    : flattened;
}

function httpFailure(
  label: string,
  status: number,
  body: string,
  apiKey: string
): EngineAdapterResultV1 {
  const snippet = bodySnippet(body, apiKey);
  const detail = snippet.length > 0 ? ` ${snippet}` : "";
  if (status === 401 || status === 403) {
    return {
      status: "failed",
      authFailure: true,
      errorMessage: `${label} authentication failed (HTTP ${status}). Check the API key configured in Settings.${detail}`,
    };
  }
  if (status === 429) {
    return {
      status: "failed",
      errorMessage: `${label} rate limit or quota exhausted (HTTP 429).${detail}`,
    };
  }
  if (status >= 500) {
    return {
      status: "failed",
      errorMessage: `${label} is temporarily unavailable (HTTP ${status}). Try again later.${detail}`,
    };
  }
  return {
    status: "failed",
    errorMessage: `${label} request failed (HTTP ${status}).${detail}`,
  };
}

function transportFailure(label: string, error: unknown, apiKey: string): EngineAdapterResultV1 {
  const text = error instanceof Error ? error.message : String(error);
  return {
    status: "failed",
    errorMessage: `${label} request did not complete: ${scrub(text, apiKey)}`,
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Anthropic Messages API (`POST /v1/messages`). */
export function createAnthropicAdapterV1(options: CreateAdapterOptionsV1): EngineModelProviderAdapterV1 {
  const def = getEngineProviderV1("anthropic")!;
  const baseUrl = (options.baseUrl ?? def.defaultBaseUrl).replace(/\/$/, "");
  const maxTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS_V1;
  return {
    providerId: "anthropic",
    async invokeText(input): Promise<EngineAdapterResultV1> {
      const model = input.model ?? def.defaultModel;
      let response: FetchResponseLikeV1;
      try {
        response = await options.fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": input.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            messages: [{ role: "user", content: input.prompt }],
          }),
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        });
      } catch (error) {
        return transportFailure(def.label, error, input.apiKey);
      }
      const body = await response.text();
      if (response.status !== 200) {
        return httpFailure(def.label, response.status, body, input.apiKey);
      }
      const parsed = parseJson(body);
      const content = isRecord(parsed) ? parsed.content : undefined;
      if (Array.isArray(content)) {
        const text = content
          .filter((block): block is Record<string, unknown> => isRecord(block))
          .filter((block) => block.type === "text" && typeof block.text === "string")
          .map((block) => block.text as string)
          .join("");
        if (text.length > 0) {
          return { status: "completed", text };
        }
      }
      return {
        status: "failed",
        errorMessage: `${def.label} returned a response with no text content.`,
      };
    },
  };
}

/** OpenAI Chat Completions API (`POST /v1/chat/completions`). */
export function createOpenAiAdapterV1(options: CreateAdapterOptionsV1): EngineModelProviderAdapterV1 {
  const def = getEngineProviderV1("openai")!;
  const baseUrl = (options.baseUrl ?? def.defaultBaseUrl).replace(/\/$/, "");
  return {
    providerId: "openai",
    async invokeText(input): Promise<EngineAdapterResultV1> {
      const model = input.model ?? def.defaultModel;
      let response: FetchResponseLikeV1;
      try {
        response = await options.fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${input.apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: input.prompt }],
          }),
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        });
      } catch (error) {
        return transportFailure(def.label, error, input.apiKey);
      }
      const body = await response.text();
      if (response.status !== 200) {
        return httpFailure(def.label, response.status, body, input.apiKey);
      }
      const parsed = parseJson(body);
      const choices = isRecord(parsed) ? parsed.choices : undefined;
      const first = Array.isArray(choices) && isRecord(choices[0]) ? choices[0] : undefined;
      const message = first !== undefined && isRecord(first.message) ? first.message : undefined;
      if (message !== undefined && typeof message.content === "string" && message.content.length > 0) {
        return { status: "completed", text: message.content };
      }
      return {
        status: "failed",
        errorMessage: `${def.label} returned a response with no text content.`,
      };
    },
  };
}

/** Google Generative Language API (`POST /v1beta/models/{model}:generateContent`). */
export function createGoogleAdapterV1(options: CreateAdapterOptionsV1): EngineModelProviderAdapterV1 {
  const def = getEngineProviderV1("google")!;
  const baseUrl = (options.baseUrl ?? def.defaultBaseUrl).replace(/\/$/, "");
  return {
    providerId: "google",
    async invokeText(input): Promise<EngineAdapterResultV1> {
      const model = input.model ?? def.defaultModel;
      let response: FetchResponseLikeV1;
      try {
        response = await options.fetch(
          `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-goog-api-key": input.apiKey,
            },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: input.prompt }] }],
            }),
            ...(input.signal !== undefined ? { signal: input.signal } : {}),
          }
        );
      } catch (error) {
        return transportFailure(def.label, error, input.apiKey);
      }
      const body = await response.text();
      if (response.status !== 200) {
        return httpFailure(def.label, response.status, body, input.apiKey);
      }
      const parsed = parseJson(body);
      const candidates = isRecord(parsed) ? parsed.candidates : undefined;
      const first = Array.isArray(candidates) && isRecord(candidates[0]) ? candidates[0] : undefined;
      const content = first !== undefined && isRecord(first.content) ? first.content : undefined;
      const parts = content !== undefined ? content.parts : undefined;
      if (Array.isArray(parts)) {
        const text = parts
          .filter((part): part is Record<string, unknown> => isRecord(part))
          .filter((part) => typeof part.text === "string")
          .map((part) => part.text as string)
          .join("");
        if (text.length > 0) {
          return { status: "completed", text };
        }
      }
      return {
        status: "failed",
        errorMessage: `${def.label} returned a response with no text content.`,
      };
    },
  };
}

/** The default adapter set, one per catalog provider. */
export function createDefaultEngineAdaptersV1(
  options: CreateAdapterOptionsV1
): ReadonlyMap<EngineProviderIdV1, EngineModelProviderAdapterV1> {
  return new Map<EngineProviderIdV1, EngineModelProviderAdapterV1>([
    ["anthropic", createAnthropicAdapterV1(options)],
    ["openai", createOpenAiAdapterV1(options)],
    ["google", createGoogleAdapterV1(options)],
  ]);
}
