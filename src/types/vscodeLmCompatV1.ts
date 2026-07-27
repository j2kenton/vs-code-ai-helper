/**
 * Neutral shapes for the VS Code Language Model tool-calling surface (plan
 * §1.6, "Establish the VS Code Language Model boundary").
 *
 * `package.json` declares VS Code `^1.93.0` as the compatibility baseline,
 * but the tool-calling round in `copilotImplementationRunner.ts` (the
 * implementation-edit runner) depends on runtime constructors —
 * `vscode.LanguageModelTextPart`, `vscode.LanguageModelToolCallPart`,
 * `vscode.LanguageModelToolResultPart` — and the `response.stream` shape
 * that were not part of the earlier, simpler `vscode.lm` surface every other
 * runner uses (`selectChatModels`, `LanguageModelChat`, `sendRequest`,
 * `response.text`). A host old enough to lack the tool-calling constructors
 * would otherwise throw a raw "X is not a constructor" deep inside a
 * tool-call round, after a prompt was already sent.
 *
 * Production code that needs to read or construct a tool-calling round talks
 * to these neutral shapes and the guarded adapters in
 * `services/vscodeLmCompat.ts` instead of referencing the concrete classes
 * directly, so the host-capability check happens once, before any prompt is
 * sent or file is read, instead of being implicit in whichever call happens
 * to run first.
 */

export interface LmToolDescriptorV1 {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: object;
}

export interface LmTextPartV1 {
  readonly kind: "text";
  readonly value: string;
}

export interface LmToolCallPartV1 {
  readonly kind: "toolCall";
  readonly callId: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export type LmResponsePartV1 = LmTextPartV1 | LmToolCallPartV1;

/** Stable outcome of probing whether the current host supports tool-calling. */
export type LmHostCapabilityV1 =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: string };

/**
 * Neutral shape of the request options a tool-calling round sends alongside
 * messages. Deliberately narrower than `vscode.LanguageModelChatRequestOptions`
 * (which also carries the post-1.93 `tools` field) so application code can
 * build/hold these options without naming the concrete VS Code type; the
 * boundary attaches `tools` only at the actual `sendRequest` call site.
 */
export interface LmChatRequestOptionsV1 {
  readonly modelOptions?: Record<string, unknown>;
}

/**
 * Neutral shape of a chat response this boundary can stream tool-calling
 * parts out of, without the caller naming `vscode.LanguageModelChatResponse`
 * or reading `.stream` directly.
 *
 * Both members are optional and untyped on purpose: the pinned 1.93
 * declarations expose only `text`, while the post-1.93 tool-calling hosts
 * this boundary probes for at runtime also expose `stream`. Declaring both
 * (rather than requiring `stream`) keeps a real
 * `vscode.LanguageModelChatResponse` assignable under the 1.93 pin;
 * `iterateLmResponsePartsV1` performs the guarded runtime read of `stream`.
 */
export interface LmChatResponseV1 {
  readonly text?: unknown;
  readonly stream?: unknown;
}
