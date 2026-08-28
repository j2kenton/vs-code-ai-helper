/**
 * Types for the exhaustive task-progress field policy (plan §3.11).
 *
 * The policy module (services/taskProgressFieldPolicyV1.ts) is the ONLY
 * place lifecycle code may derive a persisted-progress mutation from; its
 * table covers every persisted field for each coordinated transition. The
 * coordinator clock is always an input — policy functions never read the
 * wall clock themselves, so transitions are deterministic and testable.
 *
 * Runtime operation leases are workflowLeaseStoreV1's job and are never
 * part of these inputs or outputs; the persisted `ownership` binding is
 * preserved exactly by every transition (plan product decisions). The
 * current-task checkpoint is external workspace state owned by the
 * coordinator, not by this policy.
 */
import type { TaskStage } from "./taskProgress";
import type { PersistedTaskProgressV1 } from "../services/taskProgressDecoderV1";

/** The §3.11 table columns. `migration` is realized by the strict decoder + writer. */
export type TaskProgressLifecycleTransitionV1 =
  | "migration"
  | "nextStage"
  | "markTaskDone"
  | "reopen";

/** One row of the exhaustive per-field policy table (documentation mirror of §3.11). */
export interface TaskProgressFieldPolicyRowV1 {
  readonly migration: string;
  readonly nextStage: string;
  readonly markTaskDone: string;
  readonly reopen: string;
}

export interface NextStagePolicyInputV1 {
  /** Coordinator clock (ISO timestamp) applied to updatedAt. */
  readonly now: string;
  /**
   * Explicit destination stage, overriding the default literal `STAGE_ORDER`
   * successor. Lets a caller land on a configured-review-stage-aware target
   * (skipping an optional review stage the workspace has no model
   * configured for) through this same coordinated transition, instead of a
   * separate legacy path. Must be strictly forward of the current stage;
   * omit to advance to the immediate `STAGE_ORDER` successor.
   */
  readonly targetStage?: TaskStage;
}

export interface MarkTaskDonePolicyInputV1 {
  /** Coordinator clock (ISO timestamp) applied to updatedAt and completedAt. */
  readonly now: string;
}

export interface ReopenPolicyInputV1 {
  /** Coordinator clock (ISO timestamp) applied to updatedAt. */
  readonly now: string;
  /** The stage the user chose to reopen at (Publish preselected by the picker). */
  readonly selectedStage: TaskStage;
}

/** Input to `applyPlanRevisionPolicyV1` (wf "make the stage chat a record of
 * work" Part 6 / items 4-5). */
export interface PlanRevisionPolicyInputV1 {
  /** Coordinator clock (ISO timestamp) applied to updatedAt and planRevision.startedAt. */
  readonly now: string;
  /** The `checklistChangeProposals` entry (`at`) this revision resolves — must currently be `"pending"`. */
  readonly proposalAt: string;
  /** Plain-language reason surfaced to the plan-stage prompt once `{{planRevisionProposal}}` is built (Part 6 item 6, not yet built). */
  readonly reason: string;
  /** The revision-owned journal snapshot's filename (`snapshotPlanForRevisionV1`,
   * `implementationArtifactResolver.ts`), taken by the caller BEFORE this
   * policy runs — see `PlanRevisionStateV1.journaledPlanRef`'s doc comment.
   * Omitted only when there was no pre-existing `plan-final.md` to snapshot. */
  readonly journaledPlanRef?: string;
}

export type TaskProgressPolicyErrorCodeV1 =
  | "invalidTimestamp"
  | "statusNotActive"
  | "statusNotCompleted"
  | "noNextStage"
  | "invalidTargetStage"
  | "invalidSelectedStage"
  | "checklistChangeProposalNotPending";

export type TaskProgressPolicyResultV1 =
  | { readonly ok: true; readonly progress: PersistedTaskProgressV1 }
  | {
      readonly ok: false;
      readonly code: TaskProgressPolicyErrorCodeV1;
      readonly reason: string;
    };
