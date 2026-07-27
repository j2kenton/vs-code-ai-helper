# Chat interaction transaction fixtures (plan §5.5)

Checked-in evidence for the persisted `ChatInteractionTransactionV1` record
(`src/types/chatInteractionTransactionV1.ts`), whose schema lives at
`workflow-inventories/schemas/chat-interaction-transaction-v1.schema.json`.

Every digest and canonical form in these files is computed by the real
runtime helpers — regenerate with:

```
pnpm run generate:chat-transaction-fixtures
```

(`scripts/generateChatTransactionFixtures.mjs`, which self-checks that every
`valid-*` fixture decodes and every `invalid-*` fixture rejects before
exiting 0).

- `valid-*.json` — one fixture per §5.5 state, including both terminal Resume
  settlements (`resumed` under `sameOperation` semantics,
  `supersededByReplacementOperation` under `replacementOperation` semantics),
  a settle-from-questionsPosted cancellation, a `resumed` settlement carrying
  the durable invocation-once claim (`resumeInvocationClaimedAt`, plan §3.1 /
  AC-RUNNER-03), and a `resumed` settlement carrying both the claim and its
  durably recorded terminal outcome (`resumeInvocationOutcome`, "recover the
  claimed terminal result").
- `invalid-*.json` — targeted mutations of valid records: an unknown
  top-level field, a settled record missing its settlement, a
  settlement/semantics mismatch, a broken transition-receipt chain, a
  question-set digest mismatch, submitted answers missing their idempotency
  record, a byte-correct but non-canonical input snapshot, a transition
  recorded after settlement, a forged Resume settlement whose receipt chain
  never entered `resumeScheduled`, a `resumeIdempotencyId` without a
  `resumeScheduled` receipt, an invocation-once claim forged onto a
  settlement with no `resumeResolution`, a recorded terminal outcome forged
  onto a settlement with no invocation-once claim, a recorded terminal
  outcome whose correlation names a foreign `operationId` instead of this
  interaction's own binding/resolution, and a recorded terminal outcome with
  no correlation tuple at all (plan §3.1 / AC-RUNNER-03's correlation-binding
  check — an unbindable outcome can never be authoritative recovery data).

`src/test/chatInteractionTransactionStoreV1.test.ts`
(`pnpm run test:workflow:chat-transactions`) pins the decoder against every
fixture and drives the durable store through the full state machine.
