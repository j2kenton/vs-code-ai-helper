/**
 * Provider reservation contract (plan §3.3, "Split provider selection from
 * invocation").
 *
 * A reservation is the coordinator's proof that provider selection happened
 * through the selection policy for exactly one attempt. It is claim-once and
 * invocation-once (plan product decisions): fallback never reuses a
 * reservation — it requires a new globally unique attempt and an explicit
 * next reservation from the same selection policy
 * (`providerSelectionPolicyV1.ts`).
 */
import {
  ActionCorrelationV1,
  ReservationIdV1,
} from "./actionCorrelationV1";
import { AgentExecutionModeV1 } from "./agentExecutionV1";

export interface ProviderReservationHandleV1 {
  readonly selectionSessionId: string;
  readonly reservationId: ReservationIdV1;
  readonly correlation: ActionCorrelationV1;
  readonly mode: AgentExecutionModeV1;
  readonly runnerId: string;
  readonly providerId: string;
  readonly modelId: string;
}
