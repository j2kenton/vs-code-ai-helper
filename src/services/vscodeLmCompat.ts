/**
 * VS Code Language Model tool-calling compatibility boundary (plan §1.6).
 *
 * This is the one module allowed to touch the post-1.93 Language Model
 * tool-calling surface — `vscode.LanguageModelTextPart` /
 * `LanguageModelToolCallPart` / `LanguageModelToolResultPart`, the
 * parts-array message content, the `tools` request option, and
 * `response.stream`. The extension compiles against the pinned
 * `@types/vscode@1.93.0` declarations, which do not contain any of those
 * members, so nothing in this module may name them as types: every access
 * goes through guarded `unknown` reads against the structural
 * `VscodeLmModuleV1` shape, and every caller (currently
 * `copilotImplementationRunner.ts`) goes through
 * `probeLmToolCallingHostCapabilityV1` before selecting a model or sending a
 * prompt — never through a bare `instanceof` or `new vscode.LanguageModelX(...)`
 * of its own. That keeps the "does this host support tool calling" question
 * answered in exactly one place instead of being implicit in whichever
 * constructor happens to run first.
 *
 * Nothing here widens what the extension does; it only isolates a runtime
 * capability check and guarded property access that already needed to exist
 * for `copilotImplementationRunner.ts` to fail closed on an old host instead
 * of throwing partway through a tool-call round.
 */
import type * as vscodeTypes from "vscode";
import {
  LmChatResponseV1,
  LmHostCapabilityV1,
  LmResponsePartV1,
  LmToolCallPartV1,
  LmToolDescriptorV1,
} from "../types/vscodeLmCompatV1";

/**
 * The subset of the `vscode` module this boundary depends on, structurally.
 * Every tool-calling member is `unknown` because the pinned 1.93 declarations
 * do not define it — presence and shape are established at runtime by
 * `probeLmToolCallingHostCapabilityV1` and the guarded accessors below.
 * `lm` and `LanguageModelChatMessage` do exist in 1.93, which keeps the real
 * `typeof vscode` module (and the test stub) structurally assignable here.
 */
export type VscodeLmModuleV1 = {
  readonly LanguageModelTextPart?: unknown;
  readonly LanguageModelToolCallPart?: unknown;
  readonly LanguageModelToolResultPart?: unknown;
  readonly LanguageModelChatMessage?: unknown;
  readonly lm?: unknown;
};

/** Narrow an unknown module member to a runtime constructor, or undefined. */
function asConstructor(value: unknown): (new (...args: never[]) => object) | undefined {
  return typeof value === "function"
    ? (value as new (...args: never[]) => object)
    : undefined;
}

/**
 * True only when the host exposes every runtime constructor and function a
 * tool-calling round needs. Call this before selecting a model or sending
 * any prompt, so an older host fails closed with one readable reason instead
 * of throwing "X is not a constructor" partway through a round after files
 * may already have been read.
 */
export function probeLmToolCallingHostCapabilityV1(
  vscodeModule: VscodeLmModuleV1
): LmHostCapabilityV1 {
  const missing: string[] = [];
  if (typeof vscodeModule.LanguageModelTextPart !== "function") {
    missing.push("LanguageModelTextPart");
  }
  if (typeof vscodeModule.LanguageModelToolCallPart !== "function") {
    missing.push("LanguageModelToolCallPart");
  }
  if (typeof vscodeModule.LanguageModelToolResultPart !== "function") {
    missing.push("LanguageModelToolResultPart");
  }
  const lm = vscodeModule.lm as { selectChatModels?: unknown } | undefined;
  if (typeof lm?.selectChatModels !== "function") {
    missing.push("lm.selectChatModels");
  }
  if (missing.length > 0) {
    return {
      supported: false,
      reason:
        "This VS Code host does not expose the Language Model tool-calling API " +
        `(missing: ${missing.join(", ")}). Update VS Code to run AI-assisted implementation.`,
    };
  }
  return { supported: true };
}

/** Guarded `instanceof` — false (never throws) if the constructor is absent. */
export function isLmTextPartV1(vscodeModule: VscodeLmModuleV1, part: unknown): boolean {
  const ctor = asConstructor(vscodeModule.LanguageModelTextPart);
  return ctor !== undefined && part instanceof ctor;
}

/** Guarded `instanceof` — false (never throws) if the constructor is absent. */
export function isLmToolCallPartV1(vscodeModule: VscodeLmModuleV1, part: unknown): boolean {
  const ctor = asConstructor(vscodeModule.LanguageModelToolCallPart);
  return ctor !== undefined && part instanceof ctor;
}

/**
 * Adapt a real `vscode.LanguageModelToolCallPart` into the neutral shape
 * through guarded `unknown` property reads, so a caller never assumes more
 * about the class's internals than these three documented fields.
 */
export function toNeutralToolCallV1(part: unknown): LmToolCallPartV1 {
  const raw = part as { callId?: unknown; name?: unknown; input?: unknown };
  const callId = typeof raw.callId === "string" ? raw.callId : "";
  const name = typeof raw.name === "string" ? raw.name : "";
  const input =
    typeof raw.input === "object" && raw.input !== null
      ? (raw.input as Record<string, unknown>)
      : {};
  return { kind: "toolCall", callId, name, input };
}

/**
 * Construct a real `vscode.LanguageModelTextPart` through the guarded
 * boundary. Returned as `unknown` because the class does not exist in the
 * pinned 1.93 declarations; callers only round-trip the instance back into
 * message content through this boundary's message builders.
 */
export function createLmTextPartV1(vscodeModule: VscodeLmModuleV1, text: string): unknown {
  const ctor = vscodeModule.LanguageModelTextPart as new (value: string) => unknown;
  return new ctor(text);
}

/**
 * Construct a real `vscode.LanguageModelToolResultPart` (wrapping one text
 * part) through the guarded boundary. Returned as `unknown` for the same
 * reason as `createLmTextPartV1`.
 */
export function createLmToolResultPartV1(
  vscodeModule: VscodeLmModuleV1,
  callId: string,
  text: string
): unknown {
  const resultCtor = vscodeModule.LanguageModelToolResultPart as new (
    callId: string,
    content: readonly unknown[]
  ) => unknown;
  return new resultCtor(callId, [createLmTextPartV1(vscodeModule, text)]);
}

/**
 * Build an assistant `LanguageModelChatMessage` whose content is an array of
 * tool-calling parts. The 1.93 declarations type message content as `string`;
 * the parts-array overload exists only on tool-capable hosts, which the probe
 * has already established before any round runs — so the single cast lives
 * here, not in callers.
 */
export function createLmAssistantMessageWithPartsV1(
  vscodeModule: VscodeLmModuleV1,
  parts: readonly unknown[]
): vscodeTypes.LanguageModelChatMessage {
  const messageClass = vscodeModule.LanguageModelChatMessage as {
    Assistant(content: unknown): vscodeTypes.LanguageModelChatMessage;
  };
  return messageClass.Assistant(parts);
}

/**
 * Build a user `LanguageModelChatMessage` whose content is an array of
 * tool-result parts. Same 1.93-vs-runtime rationale as
 * `createLmAssistantMessageWithPartsV1`.
 */
export function createLmUserMessageWithPartsV1(
  vscodeModule: VscodeLmModuleV1,
  parts: readonly unknown[]
): vscodeTypes.LanguageModelChatMessage {
  const messageClass = vscodeModule.LanguageModelChatMessage as {
    User(content: unknown): vscodeTypes.LanguageModelChatMessage;
  };
  return messageClass.User(parts);
}

/**
 * Attach the tool-calling-specific `tools` field to a neutral request-options
 * object at the actual `sendRequest` call boundary, so callers never need to
 * spell the post-1.93 `tools` member themselves. The returned value is typed
 * as the 1.93 `LanguageModelChatRequestOptions` (which exists at the pin);
 * the extra `tools` property is meaningful only on the tool-capable hosts the
 * probe has already admitted.
 */
export function attachLmToolsV1(
  requestOptions: { readonly modelOptions?: Record<string, unknown> },
  tools: readonly LmToolDescriptorV1[]
): vscodeTypes.LanguageModelChatRequestOptions {
  return { ...requestOptions, tools } as unknown as vscodeTypes.LanguageModelChatRequestOptions;
}

/**
 * Guarded iterable check for the runtime `response.stream` read. Accepts sync
 * iterables too because `for await` consumes both and test hosts stub the
 * stream with a plain generator.
 */
function isStreamIterable(value: unknown): value is AsyncIterable<unknown> | Iterable<unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as {
    [Symbol.asyncIterator]?: unknown;
    [Symbol.iterator]?: unknown;
  };
  return (
    typeof candidate[Symbol.asyncIterator] === "function" ||
    typeof candidate[Symbol.iterator] === "function"
  );
}

/**
 * Stream a tool-calling response one neutral part at a time, so a caller
 * never reads `response.stream` (absent from the 1.93 declarations) or names
 * `vscode.LanguageModelChatResponse` directly. Yields the decoded neutral
 * part alongside the real instance (`raw`) so a caller that must round-trip
 * the original class back into the next assistant message (as
 * `copilotImplementationRunner.ts` does) still can, without itself performing
 * the `instanceof` check.
 */
export async function* iterateLmResponsePartsV1(
  vscodeModule: VscodeLmModuleV1,
  response: LmChatResponseV1
): AsyncGenerator<{ part: LmResponsePartV1; raw: unknown }> {
  const stream = (response as { stream?: unknown }).stream;
  if (!isStreamIterable(stream)) {
    // The capability probe admits only hosts whose responses carry the
    // tool-calling part stream; reaching here means a caller skipped it.
    throw new Error(
      "This chat response has no tool-calling part stream. " +
        "Run probeLmToolCallingHostCapabilityV1 before sending a tool-calling request."
    );
  }
  for await (const raw of stream) {
    if (isLmTextPartV1(vscodeModule, raw)) {
      const value = (raw as { value?: unknown }).value;
      yield { part: { kind: "text", value: typeof value === "string" ? value : "" }, raw };
    } else if (isLmToolCallPartV1(vscodeModule, raw)) {
      yield { part: toNeutralToolCallV1(raw), raw };
    }
  }
}
