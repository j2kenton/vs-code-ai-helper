# @ensemble/core

Transport-agnostic Ensemble domain contracts (plan Part 2): the shared
vocabulary for the mobile client (`apps/mobile`), the portable orchestration
engine (`packages/ensemble-engine`, Part 4), and the control plane (Part 5).

Pure types + codecs only:

- **Task/progress schema** — `taskProgressV1.ts` (types/constants) and
  `taskProgressDecoderV1.ts` (the strict fail-closed decoder), ported from
  `src/types/taskProgress.ts` and `src/services/taskProgressDecoderV1.ts`.
- **Structured questions/answers** — `structuredQuestionV1.ts`, ported from
  `src/types/structuredQuestionV1.ts` (includes canonical JSON V1).
- **Chat interaction transactions** — `chatInteractionTransactionV1.ts`, plus
  its dependencies `actionCorrelationV1.ts` and `taskActionOutcomeV1.ts`.
- **Result-frame contract** — `aiResultContractV1.ts`
  (`ensemble.aiResultContract.v1`), ported from
  `src/prompts/aiResultContractV1.ts`.
- **Gate/approval states** — `gateV1.ts` (new): gate state machine states,
  idempotent decision commands, request fingerprints, typed error codes, and
  execution-attempt states for the Part 4c crash-safe effect protocol.
- **Settings shapes** — `settingsV1.ts`: canonical `ensemble.*` keys only.
  The deprecated `vs-code-ai-helper.*` namespace is deliberately not ported.

No VS Code imports and no Node-only APIs: byte lengths use `TextEncoder`,
digests use the bundled dependency-free SHA-256 (`sha256V1.ts`), and id
allocation uses `globalThis.crypto`.

## Conformance

The extension keeps its own codecs under `src/` and never imports this
package. Drift is caught mechanically by the dual-decode conformance suite
(`tests/conformance.test.ts`): every fixture under
`test-fixtures/structured-questions/`, `test-fixtures/chat-transactions/`,
and `test-fixtures/task-progress/` is decoded by BOTH implementations —
valid fixtures must decode identically, invalid fixtures must be rejected by
both (with matching recovery codes for task-progress).

```sh
pnpm --filter @ensemble/core run test        # compile + dual-decode suite
pnpm --filter @ensemble/core run check-types
pnpm --filter @ensemble/core run lint
```

Tooling (`tsc`, `eslint`) resolves from the workspace root's
devDependencies; this package intentionally has no dependencies of its own.
