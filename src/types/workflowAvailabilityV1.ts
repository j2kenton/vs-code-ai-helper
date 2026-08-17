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
  /**
   * Every ranked candidate was reserved, invoked, and consumed without
   * producing a usable result. The OPPOSITE condition from
   * `providerModeUnavailable` (no candidate could serve the mode at all —
   * nothing was ever invoked): the remedies differ (fix availability vs.
   * inspect why every invocation failed), so collapsing the two cost a
   * multi-hour misdiagnosis on 2026-08-15 (third item, workflow 3
   * continuation) when "unavailable" was reported for a provider that was
   * available, invoked, and simply failed. Carried by the same
   * `unavailable` outcome kind — the operation still ends with no provider
   * result — but the code now states which of the two conditions held.
   */
  | "candidatesExhausted"
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
