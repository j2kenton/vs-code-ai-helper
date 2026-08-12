# @ensemble/contract

The control-plane API contract (plan Part 3) — **contract only, no server**.
All client parts (5–10) code against this, insulating them from the Part 5
hosting decision.

- `openapi/control-plane.v1.json` — the HTTPS surface: list/create/monitor
  tasks (+ per-round history), chat turns (including structured-answer
  submissions), idempotent gate approve/reject, read-only file and diff
  retrieval, write/rotate/delete-only key records with masked metadata
  reads, and the Part 6 auth endpoints (server-side PKCE exchange,
  refresh-token rotation, revocation).
- `src/wsEventsV1.ts` — WebSocket event schemas for the notification stream,
  built on `@ensemble/core` (Part 2) types, with subscribe/refresh
  authentication semantics.
- `src/sandboxBindingV1.ts` — the `SandboxBinding` resource, its typed error
  codes (no unbound execution path), shape-level validation, and the lexical
  half of the path-confinement rule (`..`/absolute rejection +
  canonicalization; symlinks are provider-resolved-then-checked server-side
  and rejected with `symlinkEscapesBindingRoot`).

Normative contract rules (also encoded in the spec and asserted by tests):

1. The Part 6 session credential is the contract's ONLY security scheme; no
   endpoint accepts provider OAuth tokens or client-asserted identity.
2. Every resource carries an owner and every operation declares its
   ownership rule (`x-ownership`); WS subscriptions are authorized at
   subscribe time and revalidated on reconnect and token refresh/expiry.
3. File/diff retrieval is read-only and confined to the task's binding root;
   no write/exec endpoint exists.
4. Gate decisions are idempotent per (owner, gate, idempotency key) with a
   stored request fingerprint: same-key/same-payload replay returns the
   original outcome; same-key/different-payload returns
   `gateDecisionPayloadMismatch`; a conflicting decision on a decided gate
   returns `gateAlreadyDecided`.

`tests/contract.test.ts` structurally verifies all of the above against the
OpenAPI document (exact path/method roster, single security scheme, public
override only on the two identity-establishing endpoints, read-only file
surface, required SandboxBinding, idempotency declarations, write-only key
records) and unit-tests the binding validators and path confinement.

```sh
pnpm --filter @ensemble/contract run test
pnpm --filter @ensemble/contract run check-types
pnpm --filter @ensemble/contract run lint
```
