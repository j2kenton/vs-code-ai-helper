/**
 * Attempt-guarded provider dispatch (plan Part 4c).
 *
 * Wraps any `EngineProviderRunnerV1` so EVERY model-provider call the task
 * loop makes runs under the execution-attempt/effect protocol: the attempt
 * record (with its deterministic key) persists BEFORE the provider is
 * invoked, and the outcome persists when the call completes. A throw from
 * the wrapped runner is deliberately not caught — an error mid-call is
 * indistinguishable from a crash until recovery inspects it, so the open
 * record is exactly what a killed process would leave behind, and it
 * surfaces through `listOpenForTask` (the recovery worklist).
 *
 * The step identity is the invocation's operation id: stable across a
 * resumed operation's replays (the 4a invocation-once claim reuses the
 * recorded operation and never re-invokes a claimed one), so the derived
 * key is deterministic exactly where crash recovery needs it. Part 5
 * composes this guard around the Part 4b dispatch pipeline when hosting
 * engine runs; Part 4d applies the same protocol to sandbox commands via
 * the gate machinery.
 */
import {
  deriveExecutionAttemptKeyV1,
  EngineExecutionAttemptStoreV1,
} from "./executionAttemptStoreV1";
import {
  EngineProviderInvocationV1,
  EngineProviderRunnerV1,
  EngineRoundResultV1,
} from "./taskLoopV1";

export interface CreateAttemptGuardedProviderRunnerOptionsV1 {
  readonly inner: EngineProviderRunnerV1;
  readonly attemptStore: EngineExecutionAttemptStoreV1;
}

/** The per-operation step identity attempt records are keyed under. */
export function providerRoundStepIdV1(input: EngineProviderInvocationV1): string {
  return `round:${input.correlation.operationId}`;
}

export function createAttemptGuardedProviderRunnerV1(
  options: CreateAttemptGuardedProviderRunnerOptionsV1
): EngineProviderRunnerV1 {
  return {
    async invoke(input: EngineProviderInvocationV1): Promise<EngineRoundResultV1> {
      const stepId = providerRoundStepIdV1(input);
      const lineage = (await options.attemptStore.listForGate(stepId)).length;
      const attemptKey = deriveExecutionAttemptKeyV1({
        taskId: input.taskId,
        gateId: stepId,
        effectKind: "modelProviderCall",
        lineage,
      });
      // The record persists BEFORE the provider ever runs.
      await options.attemptStore.begin({
        attemptKey,
        taskId: input.taskId,
        gateId: stepId,
        effectKind: "modelProviderCall",
        lineage,
      });
      const result = await options.inner.invoke(input);
      await options.attemptStore.complete(
        attemptKey,
        result.kind === "failed" ? "failed" : "succeeded",
        result.kind
      );
      return result;
    },
  };
}
