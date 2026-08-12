/**
 * Engine event emission contract (plan Part 4a).
 *
 * The engine emits exactly the Part 3 contract's server-push event shapes
 * (`@ensemble/contract`'s `WsServerEventV1`), minus the subscription-
 * management envelope (`subscribed` / `subscriptionClosed`), which belongs
 * to the Part 5 control plane's WS layer. The control plane can therefore
 * relay engine events to authorized subscribers verbatim — no re-mapping
 * layer exists to drift.
 */
import type {
  WsNotificationV1,
  WsServerEventV1,
} from "../../ensemble-contract/src/wsEventsV1";

/** The engine-emitted subset of the contract's server events. */
export type EngineEventV1 = Extract<
  WsServerEventV1,
  {
    type:
      | "taskProgress"
      | "notification"
      | "structuredQuestions"
      | "chatTransactionState"
      | "gateStateChanged";
  }
>;

export type { WsNotificationV1 };

/** Where the engine publishes events (the control plane's fan-out feeds off it). */
export interface EngineEventSinkV1 {
  emit(event: EngineEventV1): void;
}

/** A recording sink for tests and local diagnostics. */
export function createRecordingEventSinkV1(): EngineEventSinkV1 & {
  readonly events: readonly EngineEventV1[];
} {
  const events: EngineEventV1[] = [];
  return {
    events,
    emit(event: EngineEventV1): void {
      events.push(event);
    },
  };
}
