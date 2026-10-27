import type { WorkflowDecisionOptionV1 } from "../types/workflowDecisionV1";
import type { TaskStage } from "../types/taskProgress";
import { postWorkflowDecisionV1 } from "./workflowDecisionDispatchV1";
import type { ChatTarget } from "../views/chatView";
import type { RoundGitStashObservationV1 } from "./roundGitStateV1";
import * as path from "node:path";

export const RESOLVE_ROUND_GIT_INTERFERENCE_COMMAND_V1 = "vs-code-ai-helper.resolveRoundGitInterference";

export interface RoundGitInterferenceV1 {
  readonly unmergedPaths: readonly string[];
  readonly stashOperationIds: readonly string[];
  readonly stashObservations?: readonly RoundGitStashObservationV1[];
}

export const OPEN_ROUND_GIT_EVIDENCE_COMMAND_V1 = "vs-code-ai-helper.openRoundGitEvidence";

export function roundGitObservationEvidencePathV1(taskFolderPath: string, operationId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(operationId)) throw new Error("The Git observation identifier is invalid.");
  return path.join(path.resolve(taskFolderPath), "round-git-state-v1", `${operationId}.json`);
}

function describeStashObservation(observation: RoundGitStashObservationV1): string {
  const describe = (entry: { readonly selector: string; readonly objectId: string; readonly subject: string }): string =>
    `${entry.selector} (${entry.objectId.slice(0, 12)}): ${entry.subject}`;
  return [
    `operation ${observation.operationId}; attribution: ${observation.attribution}`,
    observation.observedFrom ? `observed from ${observation.observedFrom}` : undefined,
    observation.observedUntil ? `observed until ${observation.observedUntil}` : undefined,
    observation.added.length ? `added: ${observation.added.map(describe).join(", ")}` : undefined,
    observation.removed.length ? `removed: ${observation.removed.map(describe).join(", ")}` : undefined,
  ].filter(Boolean).join("; ");
}

export function buildRoundGitInterferenceDecisionV1(
  taskFolderPath: string,
  hold: RoundGitInterferenceV1
): {
  readonly whatHappened: string;
  readonly options: readonly WorkflowDecisionOptionV1[];
  readonly recommendation: { readonly kind: "option"; readonly optionId: string; readonly reasoning: string } | { readonly kind: "none"; readonly reasoning: string };
} {
  const description = [
    ...(hold.unmergedPaths.length ? [`unmerged paths: ${hold.unmergedPaths.join(", ")}`] : []),
    ...(hold.stashObservations?.length
      ? hold.stashObservations.map(describeStashObservation)
      : hold.stashOperationIds.map((operationId) => `stash changes observed for operation ${operationId}; attribution is unknown`)),
  ].join("; ");
  const actions: WorkflowDecisionOptionV1[] = [
    ...hold.unmergedPaths.map((relativePath, index) => ({
      optionId: `keepWorkingTree${index + 1}`,
      label: `Keep working-tree version: ${relativePath}`,
      consequence: `Stages only ${relativePath} using its current working-tree contents; other staged files are preserved.`,
      resumeKind: "continue" as const,
      effect: {
        kind: "command" as const,
        command: RESOLVE_ROUND_GIT_INTERFERENCE_COMMAND_V1,
        args: [taskFolderPath, { kind: "keepWorkingTree", relativePath }],
      },
    })),
    ...hold.stashOperationIds.map((operationId, index) => ({
      optionId: `viewStashEvidence${index + 1}`,
      label: `View Git observation evidence: ${operationId}`,
      consequence: `Opens the task-bound before/after Git observation for ${operationId}. The record shows what was observed and does not claim who caused it.`,
      resumeKind: "continue" as const,
      effect: {
        kind: "command" as const,
        command: OPEN_ROUND_GIT_EVIDENCE_COMMAND_V1,
        args: [taskFolderPath, operationId],
      },
    })),
    ...hold.stashOperationIds.map((operationId, index) => ({
      optionId: `acknowledgeStash${index + 1}`,
      label: `Acknowledge stash change: ${operationId}`,
      consequence: `Records that you reviewed the stash change from ${operationId}; it will not pop, apply, or drop a stash.`,
      resumeKind: "continue" as const,
      effect: {
        kind: "command" as const,
        command: RESOLVE_ROUND_GIT_INTERFERENCE_COMMAND_V1,
        args: [taskFolderPath, { kind: "acknowledgeStash", operationId }],
      },
    })),
    {
      optionId: "notNow",
      label: "Not now",
      consequence: "Leaves the Git state unchanged and keeps this task from starting another round.",
      resumeKind: "unpause",
      effect: { kind: "doNothing" },
    },
  ];
  const recommended = hold.unmergedPaths.length
    ? actions.find((action) => action.optionId === "keepWorkingTree1")
    : actions.find((action) => action.optionId === "viewStashEvidence1") ?? actions[0];
  const reasoning = hold.unmergedPaths.length
    ? `An unresolved index conflict was observed in ${hold.unmergedPaths[0]} during a tracked round; observation timing does not establish who caused it. Review and explicitly choose how to handle that path.`
    : hold.stashOperationIds.length
      ? `A stash-list change was observed around a tracked round, but its cause is unknown. Review the recorded entries and timestamps before acknowledging it.`
      : "No Git recovery action is currently required.";
  return {
    whatHappened: `Git state observations require review before this task can start another round. These before/after observations do not establish who caused a change. ${description || "The state could not be established."}`,
    options: actions,
    recommendation: recommended
      ? { kind: "option", optionId: recommended.optionId, reasoning }
      : { kind: "none", reasoning },
  };
}

export async function offerRoundGitInterferenceDecisionV1(input: {
  readonly taskFolderPath: string;
  readonly taskName: string;
  readonly stage: TaskStage;
  readonly hold: RoundGitInterferenceV1;
}): Promise<void> {
  const decision = buildRoundGitInterferenceDecisionV1(input.taskFolderPath, input.hold);
  const target: ChatTarget = {
    canonicalId: input.taskFolderPath,
    taskFolderPath: input.taskFolderPath,
    stage: input.stage,
    taskName: input.taskName,
  };
  await postWorkflowDecisionV1({
    decisionKey: "roundGitInterferenceRecovery",
    taskCanonicalId: input.taskFolderPath,
    stage: input.stage,
    whatHappened: decision.whatHappened,
    whyUserNeeded: "Review the observed paths and stash entries, then choose the exact path or stash record to handle.",
    options: decision.options,
    recommendation: decision.recommendation,
    gating: {
      holdsTaskPaused: false,
      unblocksProgress: true,
      detail: "Rounds remain held until every listed Git change is handled and the repository is reinspected.",
    },
    quietRepost: true,
  }, target);
}
