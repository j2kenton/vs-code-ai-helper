/**
 * Request-local tool handler contract (plan §7.2/§7.4).
 *
 * A handler is created PER PROVIDER ATTEMPT and passed to the LM tool-
 * session transport (`languageModelToolSessionV1.ts`), which dispatches
 * every neutral tool call to it and sends the returned JSON text back as
 * the tool result. Handlers are mode-specific: the read-session handler
 * (`readToolSessionHandlerV1.ts`) exposes exactly the five read tools; the
 * edit broker's handler (`editBrokerToolSessionHandlerV1.ts`) exactly the
 * three mutation tools. Tools are attached request-locally — never
 * registered globally with the host.
 *
 * Protocol violations (unknown tool, undecodable input, out-of-order
 * mutation call) are counted; the transport aborts the session once
 * `MAX_TOOL_PROTOCOL_VIOLATIONS_V1` is reached, so a confused or
 * adversarial model cannot loop forever.
 */
import { LmToolCallPartV1, LmToolDescriptorV1 } from "../types/vscodeLmCompatV1";

export interface RequestLocalToolHandlerV1 {
  /** The closed tool roster this session attaches request-locally. */
  readonly descriptors: readonly LmToolDescriptorV1[];
  /**
   * Handle one neutral tool call; the returned string is sent back verbatim
   * as the tool-result text (always a JSON document). Never throws for
   * model-caused problems — those return an error document and count as
   * violations; only host-side invariants may throw.
   */
  handleToolCall(call: LmToolCallPartV1): Promise<string>;
  /** Model protocol violations observed so far (unknown tool, bad input, order breaks). */
  violationCount(): number;
}

/** Shared violation counter helper for the concrete handlers. */
export function createViolationCounterV1(): { count: () => number; record: () => void } {
  let violations = 0;
  return {
    count: () => violations,
    record: () => {
      violations += 1;
    },
  };
}
