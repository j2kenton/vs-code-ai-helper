/**
 * @ensemble/engine — the portable Ensemble orchestration/execution engine
 * (plan Part 4).
 *
 * Part 4a (this surface): the round/part task loop with `N/M` progress,
 * structured-question lifecycle, resume semantics, and event emission per
 * the Part 3 contract, on top of a storage-agnostic transaction store.
 * Parity with the extension is proven by the engine trace suite
 * (tests/engineTrace.test.ts), which decodes every emitted frame with the
 * extension's own `src/` decoders, and the checklist-parity suite
 * (tests/checklistParity.test.ts).
 *
 * Part 4b (this round): provider dispatch — the real
 * `EngineProviderRunnerV1` behind the loop. Direct model-provider API
 * adapters (`providerAdaptersV1.ts`, replacing the extension's VS Code
 * LM/CLI transports), the ported selection vocabulary and effective-chain
 * resolution (`providerCatalogV1.ts` / `modelChainV1.ts`), failure
 * classification with the auth/quota cascade gates
 * (`failureClassificationV1.ts`), the strict result-frame parser
 * (`resultEnvelopeV1.ts`, dual-decoded against `src/types/aiResultEnvelope`
 * in tests), and the reservation-based fallback cascade
 * (`providerDispatchV1.ts`).
 *
 * Part 4c: gate machinery and crash-safe external effects —
 * the durable gate state machine with exactly-once `pending →
 * approved|rejected` transitions under the (owner, gate, idempotency key)
 * contract (`gateStoreV1.ts`), the execution-attempt/effect protocol with
 * deterministic external idempotency keys persisted BEFORE every external
 * call (`executionAttemptStoreV1.ts`), the single-worker job lease
 * (`leaseStoreV1.ts`), unified-diff generation for gate review
 * (`unifiedDiffV1.ts`), and the machinery tying them together — recovery
 * that replays, reconciles, or re-offers, never silently re-executes
 * (`gateMachineryV1.ts`). Crash-injection coverage lives in
 * tests/gateMachinery.test.ts.
 *
 * Part 4d (this round): sandbox execution integration — generated code
 * executes EXCLUSIVELY through the sandbox provider APIs behind the
 * provider-neutral `SandboxClientV1` surface (`sandboxClientV1.ts`; E2B and
 * Daytona fetch-based reference transports in
 * `sandboxProviderAdaptersV1.ts`), against the task's SandboxBinding:
 * source acquisition per the binding's mode, every path confined under the
 * Part 3 symlink resolve-then-check rule, teardown per the cleanup policy
 * (`sandboxExecutionV1.ts`). Sandbox commands carry the 4c deterministic
 * attempt keys as command markers/metadata for reconciliation, and the
 * engine process itself never evals or shells out untrusted output —
 * commands are strictly-quoted argv sent over the provider API, and the
 * sandbox test suite scans this package's sources to keep it that way.
 *
 * Part 10 support: `syntaxHighlightV1.ts` — the server-side tokenizer
 * producing the shared token-span schema the control plane relays on the
 * read-only file endpoint.
 *
 * Part 11 support: `logRedactionV1.ts` — the mandatory redacting wrapper
 * every engine/control-plane log sink goes through, and
 * `sandboxAuditV1.ts` — the runtime accounting check that every command a
 * sandbox provider recorded is covered by a persisted execution-attempt
 * record and carries its reconciliation marker (criterion 6's audit half).
 */
export * from "./checklistProgressV1";
export * from "./transactionStoreV1";
export * from "./conversationOrchestratorV1";
export * from "./progressV1";
export * from "./engineEventsV1";
export * from "./taskLoopV1";
export * from "./failureClassificationV1";
export * from "./providerCatalogV1";
export * from "./modelChainV1";
export * from "./resultEnvelopeV1";
export * from "./providerAdaptersV1";
export * from "./providerDispatchV1";
export * from "./unifiedDiffV1";
export * from "./gateStoreV1";
export * from "./executionAttemptStoreV1";
export * from "./leaseStoreV1";
export * from "./gateMachineryV1";
export * from "./attemptGuardedRunnerV1";
export * from "./sandboxClientV1";
export * from "./sandboxExecutionV1";
export * from "./sandboxProviderAdaptersV1";
export * from "./syntaxHighlightV1";
export * from "./logRedactionV1";
export * from "./sandboxAuditV1";
