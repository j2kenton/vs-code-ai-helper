/**
 * Stable availability outcome for workflow subsystems (plan §1.8 / §3.7).
 *
 * When a host capability, provider mode, workspace root, path, or private
 * storage area cannot support a requested workflow action, the coordinator
 * surfaces exactly one of these codes instead of a per-call-site ad-hoc
 * error. The codes are UI/test contracts — they never change meaning, and
 * they are deliberately NOT provider envelope kinds (a provider cannot claim
 * unavailability on the product's behalf).
 */

export type WorkflowUnavailableCodeV1 =
  | "hostToolApiUnavailable"
  | "providerModeUnavailable"
  | "workspaceRootUnsupported"
  | "workspacePathUnsafe"
  | "workflowStorageUnavailable";

export interface WorkflowUnavailableV1 {
  readonly kind: "unavailable";
  readonly code: WorkflowUnavailableCodeV1;
}

export function unavailableV1(code: WorkflowUnavailableCodeV1): WorkflowUnavailableV1 {
  return { kind: "unavailable", code };
}
