/**
 * The arrow buttons at the bottom of Chat With AI (owner request, 2026-11-09): "◀ Chat with
 * High-Level Code Review" and "Chat with Publish ▶" move the panel to the previous or next
 * stage's chat.
 *
 * A button also says when something there needs the owner, in the Tasks pane's yellow. It counts
 * exactly what the Tasks pane's stage row counts (`countPendingDecisionsForStageRowV1`): open cards
 * and unanswered questions, only on the task's current stage, and nothing for a completed or
 * archived task. So the two surfaces never disagree. When the stage that needs the owner is further
 * along than the next button, that button carries the count and names the stage ("[2 at Publish]"),
 * so the way to it is never unmarked.
 */
import { STAGE_DISPLAY_NAMES, STAGE_ORDER, TaskStage } from "../types/taskProgress";

export interface StageNavButtonV1 {
  readonly stage: TaskStage;
  /** The button text, e.g. "Chat with Publish [2]". */
  readonly label: string;
  /** Items that need the owner in this direction; 0 when none. */
  readonly attention: number;
  readonly tooltip: string;
}

export interface StageNavV1 {
  readonly previous?: StageNavButtonV1;
  readonly next?: StageNavButtonV1;
}

export interface StageNavInputV1 {
  /** The stage whose chat is open. */
  readonly stage: TaskStage;
  /** The task's current stage, where open cards count (as on the Tasks pane). */
  readonly currentStage: TaskStage | undefined;
  /** Open cards plus unanswered questions on the current stage; 0 for a finished task. */
  readonly attentionOnCurrentStage: number;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function button(target: TaskStage, attention: number, attentionStage: TaskStage | undefined): StageNavButtonV1 {
  const name = STAGE_DISPLAY_NAMES[target];
  const where = attentionStage === undefined || attentionStage === target ? "" : ` at ${STAGE_DISPLAY_NAMES[attentionStage]}`;
  const label = `Chat with ${name}` + (attention > 0 ? ` [${attention}${where}]` : "");
  const tooltip =
    attention > 0 && attentionStage !== undefined
      ? `Open the ${name} chat. ${plural(attention, "item needs", "items need")} you on ${STAGE_DISPLAY_NAMES[attentionStage]}.`
      : `Open the ${name} chat.`;
  return { stage: target, label, attention, tooltip };
}

/** The previous and next stage buttons for a stage chat; none past the first or last stage. */
export function buildStageNavV1(input: StageNavInputV1): StageNavV1 {
  const index = STAGE_ORDER.indexOf(input.stage);
  if (index < 0) {
    return {};
  }
  const currentIndex = input.currentStage === undefined ? -1 : STAGE_ORDER.indexOf(input.currentStage);
  const attention = currentIndex >= 0 ? Math.max(0, input.attentionOnCurrentStage) : 0;
  const attentionStage = attention > 0 ? input.currentStage : undefined;
  const previousStage = index > 0 ? STAGE_ORDER[index - 1] : undefined;
  const nextStage = index < STAGE_ORDER.length - 1 ? STAGE_ORDER[index + 1] : undefined;
  return {
    ...(previousStage !== undefined
      ? {
          previous: button(
            previousStage,
            attention > 0 && currentIndex < index ? attention : 0,
            attention > 0 && currentIndex < index ? attentionStage : undefined
          ),
        }
      : {}),
    ...(nextStage !== undefined
      ? {
          next: button(
            nextStage,
            attention > 0 && currentIndex > index ? attention : 0,
            attention > 0 && currentIndex > index ? attentionStage : undefined
          ),
        }
      : {}),
  };
}

/** A stage the panel may be asked to open: one of the workflow's stages, nothing else. */
export function isNavigableStageV1(value: unknown): value is TaskStage {
  return typeof value === "string" && (STAGE_ORDER as readonly string[]).includes(value);
}
