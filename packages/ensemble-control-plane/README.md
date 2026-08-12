# @ensemble/control-plane

The reference control plane for the Part 3 contract (plan Part 5): the broker
that establishes identity, custodies keys, persists everything durable,
supervises engine runs, and relays engine events to clients. Depends only on
Node plus the workspace packages (`@ensemble/core`, `@ensemble/contract`,
`@ensemble/engine`) — no external dependencies, mirroring the engine's
injected-transport discipline.

## Modules

- **`storeV1.ts`** — ONE durable storage interface for sessions,
  refresh-token families, identity records keyed by
  (provider, provider-subject-id), tasks, sandbox bindings, engine job
  checkpoints, gate/command records, execution-attempt records, and key
  envelopes. Implements the engine's Part 4c store interfaces
  (`EngineGateStoreV1` / `EngineExecutionAttemptStoreV1` /
  `EngineLeaseStoreV1`) plus the Part 4a chat-transaction backend
  (`EngineTransactionStoreBackendV1`, so interaction records and
  invocation-once claims persist with the document) over a persisted
  document with atomic-save semantics, so `createEngineGateMachineryV1`
  runs against it unchanged and
  the 4c crash-injection tests re-run against THIS implementation with real
  restarts (reload-from-disk). File persistence writes temp-file + rename.
  Swapping in the reference Postgres store touches only this module — the
  CAS + scoped-unique-constraint + lease + attempt-record semantics are
  requirements on the interface, pinned by `tests/store.test.ts`.
- **`keyCustodyV1.ts`** — envelope encryption (AES-256-GCM data + wrapped
  DEK) for ALL key material, with the KEK behind `KekProviderV1`
  (KMS/secret-manager in production, injected boot secret in dev — never
  stored alongside the database). Fail-closed on KEK unavailability
  (`KeyCustodyUnavailableErrorV1`; nothing falls back to plaintext),
  rotation via DEK re-wrap, last-4 display masking.
- **`identityValidatorsV1.ts`** — the server-side trust boundary: GitHub
  (code exchange + user-API verification) and OIDC (code exchange + full
  RS256 JWKS / issuer / audience / expiry / nonce validation via
  node:crypto), both over injected fetch. Identity is the stable
  (provider, provider-subject-id) pair — never email; provider tokens are
  used once and not retained.
- **`sessionServiceV1.ts`** — control-plane session credentials: short-lived
  access tokens, rotating refresh tokens, reuse detection revoking the
  family, sign-out revocation. Tokens are stored as SHA-256 hashes only.
- **`wsHubV1.ts`** — transport-agnostic WS subscription semantics:
  subscribe-time authorization, ownership-checked task filters, refreshAuth
  revalidation, per-delivery token revalidation, owner-keyed fan-out.
- **`wsTransportV1.ts`** — the dependency-free RFC6455 wire transport for
  `/v1/events`: handshake (SHA-1 accept key, version 13 only), full framing
  (7/16/64-bit lengths, fragmentation reassembly, interleaved control
  frames, ping→pong, close echo), client-mask enforcement (1002 on an
  unmasked frame), contract-shape validation of inbound messages (1008
  otherwise). Holds no authorization logic — it only moves frames between
  the socket and the hub, so it cannot drift from the contract semantics.
  Attached by `createControlPlaneNodeServerV1(handler, { hub })`. The same
  factory takes an optional `corsOrigins` allowlist so a browser-hosted web
  client on a different origin can complete the `credentials: 'include'`
  cookie round-trip (`webSessionCookieV1.ts`): an allowlisted `Origin` gets a
  specific (never wildcard) `Access-Control-Allow-Origin` +
  `Access-Control-Allow-Credentials`, and an `OPTIONS` preflight from an
  allowlisted origin is answered directly with 204 — see `cors.test.ts`.
- **`sandboxLifecycleV1.ts`** — E2B/Daytona client factory: two
  interchangeable factories behind `SandboxClientV1`
  (`createFetchSandboxClientFactoryV1` over the engine's fetch adapters, used
  by this package's own tests; `createSdkSandboxClientFactoryV1` over the
  real vendor SDKs — see `sandboxSdkAdaptersV1.ts` — the deployment default),
  fail-closed binding reachability, split-lineage source acquisition, and
  teardown routed through `runUngatedEffect` so the destroy is
  attempt-recorded (and a user-managed workspace is never destroyed).
- **`sandboxSdkAdaptersV1.ts`** — SDK-backed `SandboxClientV1` for E2B
  (`e2b`) and Daytona (`@daytona/sdk`): the ONLY file that imports either
  vendor SDK. Outcome discipline matches the fetch adapters exactly (a
  `CommandExitError`/non-zero exit is a valid result, never a fabricated
  one; `resolveRealPath` fails closed — E2B follows `getInfo().symlinkTarget`
  hop by hop, Daytona has no such field so it proves the real path via
  `readlink -f` run through the sandbox's own process API). Still open: the
  recorded Part 5 item to validate the wrapper against the LIVE provider
  SDKs, not just their locally installed type surface (`tests/sandboxSdkAdapters.test.ts`
  injects a fake factory, so it proves the request/response contract, not a
  real network round trip).
- **`engineJobsV1.ts`** — engine job checkpointing (`running` / `gatePaused`
  / `questionsPaused` / `completed` / `failed`, with the paused gate id or
  interaction resume point) and the restart
  procedure: re-acquire the lease, replay attempt-record recovery, resume or
  re-offer — never orphan, never double-run.
- **`engineRunHostV1.ts`** — hosted Part 4a/4b engine runs: one
  `EngineTaskV1` per task seeded from its request text, Part 4b provider
  dispatch behind the injected runner seam (production composition decrypts
  model keys from custody into engine-run memory only), persist-then-relay
  event flow (progress snapshots and question posts land in the store, then
  fan out through the hub), per-round history records, question
  pause/resume with the answer idempotency id doubling as the resume id
  (a replayed submission observes the original settlement, never a second
  provider invocation), and job checkpoints at every transition. The
  engine's chat-transaction store runs over the store's DURABLE backend, so
  a question-paused run survives a control-plane restart: the
  `questionsPaused` checkpoint records the interaction address and plan of
  record, a restarted host rebuilds the run on the next answer submission,
  and a pre-crash invocation-once claim fails the resume closed instead of
  re-invoking (`tests/durableRunRecovery.test.ts`). Stale `running`
  checkpoints (crashed mid-round, no durable resume point) reconcile to
  `failed` at boot.
- **`controlPlaneServerV1.ts`** — the pure Part 3 request handler (bearer
  session auth only, ownership-as-404, typed SandboxBinding errors, the
  gate-idempotency HTTP mapping, confined read-only file/diff endpoints via
  the engine's resolve-then-check rule, write-only key records with masked
  metadata) plus a thin node:http adapter that also carries the WS upgrade.
  With a `runs` host configured, task creation starts the hosted engine run
  and structured answers route into the paused run.

## Still to come (plan order)

- The reference Postgres storage adapter (semantics pinned by the store
  tests; the swap is confined to `storeV1.ts`) — blocked on workspace
  dependency installation.
- Validating `sandboxSdkAdaptersV1.ts` against the LIVE E2B/Daytona SDKs
  (today it is proven against an injected fake factory, per above).
- The Parts 6–10 Playwright web smoke checks and the Part 11
  react-native-web hardening pass, native/web e2e smoke suite, and app
  store / web deploy packaging.
