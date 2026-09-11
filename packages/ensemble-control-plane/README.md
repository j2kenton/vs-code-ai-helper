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
- **`sandboxLifecycleV1.ts`** — sandbox client factory for the three
  providers (`docker` self-hosted, `e2b`/`daytona` BYOS): two
  interchangeable factories behind `SandboxClientV1`
  (`createFetchSandboxClientFactoryV1` over the engine's fetch adapters, used
  by this package's own tests; `createSdkSandboxClientFactoryV1` over the
  real vendor SDKs — see `sandboxSdkAdaptersV1.ts` — the deployment default),
  fail-closed binding reachability, split-lineage source acquisition,
  teardown routed through `runUngatedEffect` so the destroy is
  attempt-recorded (and a persistent workspace is never destroyed), and
  `ensureUserSandboxV1` — the ONE persistent sandbox per (user, provider)
  behind the `user-owned-managed` binding lifecycle, created on first use
  and reused by every later task.
- **`localDockerSandboxClientV1.ts`** — the self-hosted `docker` provider:
  `SandboxClientV1` over the local Docker daemon (dockerode, host-side —
  the engine's no-child-process rule still holds). Containers run as the
  control plane's own uid (never root, by default), and it is the one
  provider implementing `createInteractiveSession` (a real TTY exec, which
  isatty-gated CLIs require before they print anything).
  **`docker/sandbox.Dockerfile`** is the image those containers should run:
  `node` plus the Claude Code CLI baked in at build time — installing per
  container was rejected (the non-root uid cannot `npm install -g`). Build
  it on the host and name it via `ENSEMBLE_DOCKER_SANDBOX_IMAGE`.
- **`cliLoginSessionsV1.ts`** — the bring-your-own-subscription sign-in:
  runs `claude auth login` inside the caller's persistent sandbox through
  an interactive session, relays the printed authorization URL, accepts
  the pasted code, and reports a verdict — never any captured output after
  the code (it may be credential material). `claude setup-token` was the
  first attempt and persists nothing; `auth login` leaves the login in the
  sandbox's own `~/.claude`, which is what the engine's `claude-cli` rounds
  authenticate with. Abandoned sessions are killed after 15 minutes.
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
  and structured answers route into the paused run. A task DTO carries the
  run's own state as `run.{status,failureCode}` — the core progress
  vocabulary has no failed state, so this is where a client learns a run
  stopped and why.
- **`serveV1.ts`** — the composition root and the only place anything
  listens on a port. What a hosted task can actually DO depends on its model
  selection: a direct-API model (`anthropic:…`, `openai:…`, `google:…`)
  only "thinks" (nothing turns its rounds into file changes); a
  `claude-cli:<model>` selection runs the real Claude Code CLI inside the
  task's sandbox for every round (`@ensemble/engine`'s
  `sandboxCliRunnerV1.ts`, dispatched through `cliRunnerFor`) —
  implementation rounds edit files and run commands there, review stages
  run read-only — on the subscription signed in to that sandbox.

## Running it

```
ENSEMBLE_KEK_SECRET=…                      # required; envelope KEK boot secret
ENSEMBLE_ALLOWED_IDENTITIES=github:9324248 # required; who may sign in (provider:numericId, comma-separated)
                                           #   `gh api user --jq .id`; ENSEMBLE_OPEN_SIGNUP=1 to deliberately skip
ENSEMBLE_GITHUB_CLIENT_ID/SECRET=…         # at least one identity provider
ENSEMBLE_GOOGLE_CLIENT_ID/SECRET=…
ENSEMBLE_PORT=8787                         # default
ENSEMBLE_BIND_HOST=127.0.0.1               # default: reach it through a tunnel/proxy; 0.0.0.0 to expose it directly
ENSEMBLE_DATABASE_PATH=control-plane.sqlite
ENSEMBLE_CORS_ORIGINS=http://localhost:8081
ENSEMBLE_DOCKER_SANDBOX_IMAGE=ensemble-sandbox:latest   # docker/sandbox.Dockerfile; unset = bare node image, no CLI
ENSEMBLE_WORKER_ID=…                       # optional stable lease-holder id
pnpm --filter @ensemble/control-plane serve   # reads .env.local if present
```

The end-to-end subscription path, as verified live (2026-09-10) on a
self-hosted box: enable Docker sandboxes (one stored `sandbox:docker`
record; the value is ignored), sign Claude Code in to your persistent
sandbox (`POST /v1/user-sandbox/login` → browser → `…/code`), create a task
with model `claude-cli:sonnet` and a `user-owned-managed` Docker binding —
all eight stages ran through the CLI in the sandbox and wrote the requested
files in about three minutes, with no API key anywhere.

## Security posture (after the 2026-09-11 review)

A four-way Codex review found a critical cross-tenant hole (any signed-in
user could attach a task to any Docker container on the host by id prefix)
plus several crash and resource paths; all confirmed findings are fixed and
regression-tested. What still holds and what does not:

- One person per control plane is the model, enforced: sign-in requires
  `ENSEMBLE_ALLOWED_IDENTITIES`.
- The Docker adapter touches only containers it created (label + full id),
  with memory/CPU/pid limits, no capabilities, no privilege escalation, and
  bounded exec output and time.
- **Open:** sandbox network egress is unrestricted — AI-generated code in a
  sandbox can reach the host's network. Closing it needs host firewall rules
  or a separate sandbox host (E2B/Daytona, or a second VM), not a container
  flag. With sign-in restricted to the owner, the exposure is the owner's
  own generated code, not other users.
- **Open:** leases are not renewed during long rounds and provisioning is
  serialized in-process — both correct for one control-plane process, both
  need durable versions before running more than one.

## Still to come (plan order)

- The reference Postgres storage adapter (semantics pinned by the store
  tests; the swap is confined to `storeV1.ts`) — blocked on workspace
  dependency installation.
- Validating `sandboxSdkAdaptersV1.ts` against the LIVE E2B/Daytona SDKs
  (today it is proven against an injected fake factory, per above), and
  `createInteractiveSession` for them (today only `docker` has it, so the
  in-sandbox CLI sign-in is Docker-only; the route answers
  `userSandboxLoginUnsupported` for the others).
- Per-stage model selection through the API (a task record carries one
  `modelId`, which becomes the general chain; the engine already resolves
  per-stage chains, the contract just does not carry them yet).
- The Parts 6–10 Playwright web smoke checks and the Part 11
  react-native-web hardening pass, native/web e2e smoke suite, and app
  store / web deploy packaging.
