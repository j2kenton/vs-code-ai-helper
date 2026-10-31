/**
 * bugs3 Step 19: a card whose options refer to one running Implementation round
 * ("Keep running Implementation") is tied to that exact operation. When the
 * operation has ended — succeeded, failed, cancelled or refused to start — the
 * keep-running option is no longer true, so the card stops claiming it and
 * offers an explicit "Run Implementation" instead. The live state is read when
 * the card is rendered and again when an option is taken; the task's `status`
 * and an unchanged review/checklist prove nothing about a running operation.
 */
import type { WorkflowDecisionOptionV1, WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import { isOperationLiveByIdV1 } from "./liveTaskOperationLookupV1";

export const RUN_IMPLEMENTATION_OPTION_ID_V1 = "runImplementation";
const RUN_IMPLEMENTATION_COMMAND_V1 = "vs-code-ai-helper.runImplementationWithAI";

/** True when `record` names an operation that is no longer running. Unknown liveness is not "ended". */
export function referencedOperationEndedV1(record: WorkflowDecisionV1): boolean {
  const reference = record.liveReference;
  if (
    record.state !== "pending" ||
    reference === undefined ||
    reference.kind !== "implementation-operation" ||
    reference.operationId === undefined
  ) {
    return false;
  }
  return isOperationLiveByIdV1(record.taskCanonicalId, reference.operationId) === false;
}

function runImplementationOptionV1(record: WorkflowDecisionV1): WorkflowDecisionOptionV1 {
  return {
    optionId: RUN_IMPLEMENTATION_OPTION_ID_V1,
    label: "Run Implementation",
    resumeKind: "continue",
    consequence:
      "Starts one new Implementation round with the models currently enabled for this stage. An earlier quota or " +
      "usage-limit message is history, not proof the limit still applies: if a model is still unavailable, this attempt reports it itself.",
    effect: { kind: "command", command: RUN_IMPLEMENTATION_COMMAND_V1, args: [{ taskFolderPath: record.taskCanonicalId }] },
  };
}

const ENDED_REASON_V1 =
  "the Implementation run this card referred to has already ended, so there is nothing left to keep running";

/**
 * Render-time view of a pending card whose referenced Implementation run has
 * ended: keep-running options are disabled with that reason and an explicit
 * Run Implementation option is added and recommended. A view only — never
 * persisted, so a card is untouched while its run is live.
 */
export function viewEndedLiveReferenceV1(record: WorkflowDecisionV1): WorkflowDecisionV1 {
  if (!referencedOperationEndedV1(record)) {
    return record;
  }
  const options = record.options.map((option) =>
    option.effect.kind === "doNothing"
      ? {
          ...option,
          disabled: true,
          disabledReason: ENDED_REASON_V1,
          consequence: `Not available: ${ENDED_REASON_V1}.`,
        }
      : option
  );
  options.push(runImplementationOptionV1(record));
  return {
    ...record,
    whatHappened: `The Implementation run this card was about has ended. ${record.whatHappened}`,
    options,
    recommendation: {
      kind: "option",
      optionId: RUN_IMPLEMENTATION_OPTION_ID_V1,
      reasoning: "No Implementation run is active any more; starting a fresh one is the only way to keep building the open plan items.",
    },
  };
}

/** Why `option` cannot be taken on `record` because its referenced run ended; undefined when it can. */
export function endedLiveReferenceRefusalV1(record: WorkflowDecisionV1, option: WorkflowDecisionOptionV1): string | undefined {
  if (option.effect.kind !== "doNothing" || !referencedOperationEndedV1(record)) {
    return undefined;
  }
  return (
    `"${option.label}" was not recorded as running anything: ${ENDED_REASON_V1}. Nothing was started or cancelled. ` +
    'Choose "Run Implementation" if you want a fresh round.'
  );
}
