/**
 * @ensemble/core — transport-agnostic Ensemble domain contracts (plan Part 2).
 *
 * Pure types + codecs only; no VS Code imports, no Node-only APIs. The
 * extension under `src/` keeps its own codecs and never imports this
 * package; drift between the two is caught by the dual-decode conformance
 * suite in tests/conformance.test.ts, which runs every fixture under
 * test-fixtures/ through BOTH implementations.
 */
export * from "./taskProgressV1";
export * from "./fallbackStateV1";
export * from "./taskProgressDecoderV1";
export * from "./structuredQuestionV1";
export * from "./actionCorrelationV1";
export * from "./taskActionOutcomeV1";
export * from "./chatInteractionTransactionV1";
export * from "./aiResultContractV1";
export * from "./gateV1";
export * from "./settingsV1";
export { sha256HexV1, sha256HexUtf8V1, utf8ByteLengthV1 } from "./sha256V1";
