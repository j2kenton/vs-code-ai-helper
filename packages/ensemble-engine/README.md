# @ensemble/engine

The portable Ensemble orchestration/execution engine (plan Part 4): a plain
Node package — no VS Code imports — that reimplements the extension
actions-layer semantics (`src/actions/*`) against the shared
`@ensemble/core` (Part 2) contracts and emits events in the
`@ensemble/contract` (Part 3) schemas, so it can be deployed either inside
the hosted control plane or as an orchestrator inside the user's sandbox
without change.

## Part 4a (task loop + event machinery)

- `taskLoopV1.ts` — the round/part task loop: provider rounds, `N/M`
  checklist progress (the checklist is the authority over any self-reported
  `<!-- progress: N/M -->` marker), question pause, resume, stage
  advancement, and strict `ensemble-v1` task-progress frames.
- `conversationOrchestratorV1.ts` + `transactionStoreV1.ts` — the
  structured-question lifecycle on a durable, storage-agnostic transaction
  store (in-memory reference implementation here; Part 5 supplies the
  Postgres-backed one behind the same interface): pre-invocation admission,
  write-through question posting, idempotent answers, exactly-once Resume,
  the invocation-once claim, and the recoverable terminal outcome.
- `checklistProgressV1.ts` — the checklist/`N/M` machinery ported from the
  extension (`implementationChecklist.ts`, `reviewReadiness.ts`,
  `markdownStructure.ts`), parity-tested against those modules directly.
- `progressV1.ts` — strict task-progress document encoding, self-decoded via
  the `@ensemble/core` strict decoder before any frame is emitted.
- `engineEventsV1.ts` — event emission typed as the Part 3 contract's server
  events, so the control plane relays engine events verbatim.

## Part 4b (provider dispatch)

- `providerDispatchV1.ts` — the real `EngineProviderRunnerV1` behind the
  task loop, porting the runner-registry semantics: effective-chain
  resolution with sticky-fallback routing, the disabled-provider entry
  guard, and the quota-triggered backup cascade under an atomic
  once-per-stage-epoch reservation (auth failures never cascade; a completed
  backup becomes the stage's recorded sticky route; an unresolved
  reservation is always released). The fallback state store is
  storage-agnostic (in-memory reference here; Part 5 implements the same
  interface transactionally).
- `providerAdaptersV1.ts` — direct model-provider API adapters (Anthropic /
  OpenAI / Google over injectable fetch), replacing the extension's VS Code
  LM and CLI transports per the plan. Keys travel only in headers and are
  scrubbed from every error message.
- `providerCatalogV1.ts` + `modelChainV1.ts` — the ported selection
  vocabulary (`<provider>:<model>` ids, aliases, normalize/qualify) and the
  pure chain resolvers (`skipFilteredChainOf`, general-model fallback,
  strategy-gated backup lists) over `@ensemble/core` settings snapshots.
- `failureClassificationV1.ts` — the quota/auth/transport classification the
  cascade gates key on, ported from `src/utils/quota.ts`, plus the
  session-observed quota ledger.
- `resultEnvelopeV1.ts` — the strict `ensemble.aiResultContract.v1` frame
  parser (port of `src/types/aiResultEnvelope.ts`); every provider response
  is parsed with the invocation's correlation as the expected echo before
  anything is promoted.

## Part 4c (gate machinery + crash-safe external effects)

- `gateStoreV1.ts` — the durable gate state machine: exactly-once
  `pending → approved|rejected` via an atomic CAS, decision idempotency
  scoped to (owner, gate, idempotency key) with a stored request
  fingerprint (same-key/same-payload replay returns the original outcome;
  same-key/different-payload returns the typed mismatch; a conflicting
  decision returns the typed conflict), and the exactly-once consumption
  CAS that makes a decision for an already-resumed gate a no-op.
- `executionAttemptStoreV1.ts` — the execution-attempt/effect records:
  persisted BEFORE every external call with a DETERMINISTIC idempotency key
  derived from (task id, gate id, effect kind, attempt lineage); only the
  first terminal state is authoritative; `indeterminate` is a first-class
  state.
- `leaseStoreV1.ts` — the single-worker job lease (holder, heartbeat,
  expiry). Necessary but not sufficient: duplicate-execution safety comes
  from the lease COMBINED with the attempt protocol.
- `unifiedDiffV1.ts` — pure unified-diff generation; a gate's proposed
  changes are diffed at open time and the artifact rides the gate record
  for the read-only review view.
- `attemptGuardedRunnerV1.ts` — the same protocol applied to round-level
  provider dispatch: a wrapper for any `EngineProviderRunnerV1` that
  persists the attempt record BEFORE every model-provider call and its
  outcome after (Part 5 composes it around the 4b dispatch pipeline).
- `gateMachineryV1.ts` — the protocol itself: recovery always consults
  persisted attempt records before doing anything — safe replay with the
  SAME key where the platform supports idempotency, reconciliation against
  observable state where it doesn't, and the indeterminate re-offer (a
  fresh pending gate + typed `indeterminateAttempt` event) where neither is
  possible. Never a silent duplicate. Crash-injection tests cover all three
  persistence-to-external-effect boundaries
  (tests/gateMachinery.test.ts).

All four store surfaces are storage-agnostic interfaces with in-memory
reference implementations; the Part 5 control plane implements the same
interfaces transactionally, and the crash-injection tests run against that
store implementation too.

`gateMachineryV1.ts` also exposes `runUngatedEffect(stepId, effect)`: the
identical attempt protocol and lease for external effects that need no human
approval (source acquisition, teardown commands). The step id plays the gate
role in the deterministic key, the same step never executes twice, and a
genuinely indeterminate attempt re-enters the gate flow as a re-offer gate.
The re-offer sequence itself is crash-repairable: recovery finds-or-creates
the re-offer for any indeterminate attempt, so a crash between marking an
attempt indeterminate and surfacing its gate can never silently swallow the
re-approval prompt.

## Part 4d (sandbox execution integration)

Generated code executes EXCLUSIVELY through the sandbox provider APIs; the
engine process itself never evals or shells out anything (the sandbox suite
scans this package's sources for child-process/eval/Function-constructor
usage and fails on any hit).

- `sandboxClientV1.ts` — the provider-neutral `SandboxClientV1` surface (the
  only execution path), strict POSIX argv quoting so untrusted text can only
  ever be argument data, the `ENSEMBLE_ATTEMPT_KEY_V1` marker threading the
  4c deterministic attempt key onto every command line for reconciliation,
  and the in-memory reference client (fake filesystem with symlinks plus a
  complete command audit ledger).
- `sandboxExecutionV1.ts` — execution against the task's `SandboxBinding`:
  the full Part 3 confinement rule (lexical canonicalization, then
  provider-API resolution of BOTH the binding root and the requested path,
  authorizing the RESOLVED target — followed-then-checked, fail-closed; new
  files require an existing, in-root parent because a dangling escaping
  symlink is indistinguishable from a missing directory), gated sandbox
  command effects (reviewed file changes applied inside the root, then the
  marked command), source acquisition per binding mode (`gitClone` with an
  observable-state reconcile probe on `<root>/.git`; side-effect-free
  `attachExisting` verification), and teardown per cleanup policy (only
  task-owned-ephemeral + destroy-on-completion; user-managed workspaces are
  never destroyed).
- `sandboxProviderAdaptersV1.ts` — E2B and Daytona fetch-based reference
  transports (injected fetch, keys only in headers, scrubbed errors,
  fail-closed resolution/reconciliation; a command without a provable exit
  code throws, leaving the open attempt record for 4c recovery). A Part 5
  host may substitute SDK-backed clients behind the same interface.

## Parity oracles

The trace suite (`tests/engineTrace.test.ts`) runs scripted engine
scenarios, captures every emitted structured-question, chat-transaction, and
task-progress frame, and decodes each with the applicable extension
decoder/validator imported directly from `src/` — a frame the extension's
own decoders reject fails the suite (acceptance criterion 7b) — including a
Part 4b integration scenario driven by the real dispatch pipeline. The
dispatch suite (`tests/providerDispatch.test.ts`) additionally dual-decodes
a result-frame corpus through both `src/types/aiResultEnvelope.ts` and the
engine's port, requiring identical accept/reject outcomes.

## Commands

- `npm run check-types` / `npm run lint`
- `npm run test` — compiles and runs the trace, parity, dispatch, gate,
  diff, sandbox-execution, and sandbox-adapter suites

Part 4 is complete (4a–4d). Part 5 — `@ensemble/control-plane` — now
implements these store interfaces over a durable persisted document (the 4c
crash-injection tests re-run against it with real restarts), composes source
acquisition through the SPLIT-LINEAGE path (`acquireSourcePerBindingV1`:
clone and checkout as separate attempt lineages with per-step reconciles —
`createGitCloneEffectV1` / `createGitCheckoutEffectV1`, added for the
composite effect's reconcile-strength wrinkle), routes teardown through the
attempt protocol, and serves the read-only file endpoints via the new
`readFileUtf8` / `listDirectory` members of `SandboxClientV1`.
