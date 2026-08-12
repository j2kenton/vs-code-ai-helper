/**
 * @ensemble/control-plane — the reference control plane (plan Part 5).
 *
 * - `storeV1` — ONE durable storage interface (sessions, refresh-token
 *   families, identities keyed by (provider, provider-subject-id), tasks,
 *   sandbox bindings, engine job checkpoints, gate/command records,
 *   execution-attempt records, key envelopes) with atomic-persist document
 *   semantics; implements the engine's Part 4c store interfaces so the
 *   crash-injection tests run against THIS implementation, including real
 *   restarts via reload-from-disk.
 * - `sqliteStoreV1` — the same `ControlPlaneStoreV1` interface on a real
 *   SQLite database (Node's built-in `node:sqlite`; the plan's accepted
 *   single-node dev durable store): database-level CAS transitions, the
 *   UNIQUE (owner, gate, idempotency key) decision constraint, leased job
 *   rows, and per-mutation transactions; the crash-injection and
 *   store-semantics suites re-run against it. The reference Postgres
 *   adapter remains a swap of this module only.
 * - `keyCustodyV1` — envelope encryption for ALL key material with the KEK
 *   behind a KMS/boot-secret provider interface, fail-closed, DEK-re-wrap
 *   rotation, masked display hints.
 * - `identityValidatorsV1` / `sessionServiceV1` — the Part 6 trust boundary:
 *   server-side code exchange with per-provider validation (OIDC JWKS/iss/
 *   aud/exp/nonce; GitHub server-side user API), stable (provider, subject)
 *   identity, short-lived access tokens, rotating refresh tokens with reuse
 *   detection revoking the family, revocation on sign-out.
 * - `wsHubV1` — WS subscription authorization + owner-keyed fan-out with
 *   revalidation on refresh/expiry (transport-agnostic; the RFC6455 wire
 *   codec slots in at the node adapter).
 * - `sandboxLifecycleV1` — E2B/Daytona client factory, server-side binding
 *   reachability validation, split-lineage source acquisition, and
 *   attempt-recorded teardown per cleanup policy.
 * - `engineJobsV1` — engine job checkpointing and the restart/recovery
 *   procedure (lease re-acquired, attempt-record recovery replayed).
 * - `engineRunHostV1` — hosted Part 4a/4b engine runs: per-task loop driving
 *   with provider dispatch behind the runner seam, persist-then-relay event
 *   flow, per-round history, question pause/resume, job checkpoints.
 * - `taskModelSettingsV1` — the Part 9 bridge from a task's validated model
 *   selection to the engine dispatch's settings snapshot.
 * - `wsTransportV1` — dependency-free RFC6455 wire transport for
 *   `/v1/events` (handshake, framing, masking enforcement) bridging sockets
 *   to the hub's subscription semantics.
 * - `controlPlaneServerV1` — the pure Part 3 contract handler (ownership
 *   enforcement, typed binding/gate errors, confined read-only file/diff
 *   endpoints, masked key metadata) plus a thin node:http adapter carrying
 *   the WS upgrade.
 */
export * from "./storeV1";
export * from "./sqliteStoreV1";
export * from "./keyCustodyV1";
export * from "./identityValidatorsV1";
export * from "./sessionServiceV1";
export * from "./webSessionCookieV1";
export * from "./wsHubV1";
export * from "./wsTransportV1";
export * from "./sandboxLifecycleV1";
export * from "./engineJobsV1";
export * from "./engineRunHostV1";
export * from "./taskModelSettingsV1";
export * from "./controlPlaneServerV1";
