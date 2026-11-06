import type { TaskStage } from "../types/taskProgress";

/**
 * review1 Step 38: card options whose availability depends on how far the task has got. A card must never offer
 * an option that cannot work at the stage it is raised for (review1 item 3: "Tick or Exclude a Checklist Item…"
 * recommended at the Plan stage, where there is no checklist, failed at once).
 */
export type StageScopedCardOptionV1 =
  /** "Tick or Exclude a Checklist Item…" and the open-items form: they act on plan-final.md's checklist. */
  | "settleChecklistItem"
  /** "I'll publish over it": the audited override of the Publish flow. */
  | "publishAnyway";

const PLAN_STAGES_V1: ReadonlySet<TaskStage> = new Set<TaskStage>(["desc", "plan", "plan-high-review", "plan-low-review"]);

/** True at the stages that come before plan-final.md exists (the plan is still plan.md). */
export function isBeforePlanFinalStageV1(stage: TaskStage): boolean {
  return PLAN_STAGES_V1.has(stage);
}

/**
 * Whether `option` can work at `stage`.
 *
 * - The checklist options need `plan-final.md`, which only exists from Implementation on.
 * - "I'll publish over it" opens Commit & Push, which only works at Publish. The owner decided on 2026-11-04
 *   (`step-38-publish-anyway-stage`, recorded under Owner Decisions in plan-final.md) to keep the plan as written:
 *   no card offers it before Publish, the code-review stages included. The override itself stays in the Publish flow.
 */
export function optionAppliesAtStageV1(option: StageScopedCardOptionV1, stage: TaskStage): boolean {
  switch (option) {
    case "settleChecklistItem":
      return !isBeforePlanFinalStageV1(stage);
    case "publishAnyway":
      return stage === "publish";
  }
}

/**
 * Extra command args for the "open the plan" commands: the stage, but only where it changes which file opens
 * (the plan stages). Code-stage cards keep their original args.
 */
export function openPlanStageArgV1(stage: TaskStage | undefined): { stage?: TaskStage } {
  return stage !== undefined && isBeforePlanFinalStageV1(stage) ? { stage } : {};
}

/** The plan file the owner edits at `stage`: plan.md while the plan is under review, plan-final.md after. */
export function planFileNameForStageV1(stage: TaskStage | undefined): "plan.md" | "plan-final.md" {
  return stage !== undefined && isBeforePlanFinalStageV1(stage) ? "plan.md" : "plan-final.md";
}
