/**
 * The stage-chat action envelope (`[[ACTION:id]]` / legacy `[[STAGE_ACTION:id]]`):
 * a stage-chat response may propose exactly one of the four pinned stage
 * actions for its own task (complete stage, set this task's stage, trigger
 * this task's AI action, complete task). Extraction and payload pinning are
 * pure and VS-Code-free so they are unit-testable without a host — see
 * stageChatActions.test.ts.
 *
 * Split out of commands/chatWithStage.ts (which re-exports these for
 * backward compatibility with existing imports) so the production write path
 * in actions/rows/chatSendRowV1.ts can depend on these functions without a
 * commands -> actions -> commands import cycle — the same reason
 * chatFileUpdateEnvelope.ts exists as its own module.
 */
import { STAGE_DISPLAY_NAMES } from "../types/taskProgress";

/** One of the four pinned stage actions the stage chat may propose (the
 * approved catalog: complete stage, set this task's stage, trigger this
 * task's AI action, complete task). Each id IS a global-assistant operation
 * id: execution flows through the shared typed executor with the chat's own
 * task pinned as the payload target, so the chat path reuses exactly the
 * same confirmation, guards, and outcome verification as the global
 * assistant (which in turn delegates to the UI buttons' commands).
 * Task-lifecycle actions beyond the stage itself (pause, archive, pin,
 * reviews across tasks, …) belong to the global assistant, not stage chat. */
export interface StageChatActionDefinition {
  /** Global-assistant operation id this action executes as. */
  readonly id: string;
  /** Human label used in the outcome note. */
  readonly label: string;
  /** Shown to the model in the prompt so it knows what it may propose. */
  readonly description: string;
  /**
   * Payload keys the chat may pass through from the proposal envelope to the
   * operation (e.g. setTaskStage's target "stage"). Everything else in the
   * proposal payload is dropped, and the target task is ALWAYS the chat's
   * own task — the model can never retarget another task from stage chat.
   */
  readonly allowedPayloadKeys?: readonly string[];
}

const STAGE_ID_LIST = Object.keys(STAGE_DISPLAY_NAMES).join(", ");

export const STAGE_CHAT_ACTIONS: readonly StageChatActionDefinition[] = [
  {
    id: "completeStage",
    label: "Complete Stage & Move On",
    description: "complete the current stage and advance the task to its next stage",
  },
  {
    id: "setTaskStage",
    label: "Set Task Stage",
    description:
      `move this task to a specific stage — the envelope must carry the target stage, e.g. [[ACTION:setTaskStage {"stage": "<stage id>"}]] with a stage id from: ${STAGE_ID_LIST}`,
    allowedPayloadKeys: ["stage"],
  },
  {
    id: "triggerStageAI",
    label: "Apply Current Stage Action",
    description:
      "run the primary AI action for this task's current stage (uses provider quota)",
  },
  {
    id: "completeTask",
    label: "Complete Task",
    description: "mark this Publish-stage task as completed",
  },
];

export function getStageChatAction(
  id: string
): StageChatActionDefinition | undefined {
  return STAGE_CHAT_ACTIONS.find((action) => action.id === id);
}

/** A stage-chat action proposal extracted from a response envelope. The
 * payload (when present and valid JSON) is filtered later against the
 * action's `allowedPayloadKeys`; the target task is always pinned to the
 * chat's own task regardless of what the payload claims. */
export interface StageChatActionProposal {
  id: string;
  payload?: unknown;
}

/** Extracts every action envelope and returns the remaining text with all
 * envelopes removed — no envelope may survive into the displayed response,
 * whether or not it is executed. The stage chat shares the global
 * assistant's typed action protocol (`[[ACTION:<id> <optional json>]]`) and
 * still accepts the legacy `[[STAGE_ACTION:<id>]]` form. A JSON payload is
 * captured so actions that need one (setTaskStage's target stage) can use
 * it; unparseable payloads yield undefined and the operation's own
 * validation rejects them with a useful message. Pure and VS-Code-free so
 * the allowlist boundary is unit-testable without a host. */
export function splitStageActionEnvelopes(
  text: string
): { text: string; actions: StageChatActionProposal[] } {
  const actions: StageChatActionProposal[] = [];
  const remaining = text
    .replace(
      /\[\[(?:STAGE_)?ACTION:([A-Za-z0-9_-]+)(?:\s+([\s\S]*?))?\]\]/gi,
      (_whole, id: string, rawPayload: string | undefined) => {
        let payload: unknown;
        if (rawPayload && rawPayload.trim().length > 0) {
          try {
            payload = JSON.parse(rawPayload);
          } catch {
            payload = undefined;
          }
        }
        actions.push({ id, payload });
        return "";
      }
    )
    .trim();
  return { text: remaining, actions };
}

export type StageActionPlan =
  | { readonly action: "none" }
  | { readonly action: "reject"; readonly note: string }
  | { readonly action: "propose"; readonly proposal: StageChatActionProposal };

/**
 * All-or-nothing validation of the action envelopes extracted from one
 * response, mirroring `planFileUpdate`'s shape: a stage-chat response may
 * propose at most one action (the prompt says so explicitly), so more than
 * one is rejected whole, and an id outside the pinned catalog is rejected
 * too — both are deterministic verdicts that need no VS Code UI, so they are
 * decided here rather than deferred to the caller that does the actual
 * execution. Pure so both verdicts are directly unit-testable.
 */
export function planStageAction(actions: readonly StageChatActionProposal[]): StageActionPlan {
  if (actions.length === 0) {
    return { action: "none" };
  }
  if (actions.length > 1) {
    return {
      action: "reject",
      note:
        `_The response proposed ${actions.length} actions (${actions.map((a) => a.id).join(", ")}); ` +
        "a stage-chat response may propose at most one, so none were executed._",
    };
  }
  const proposal = actions[0]!;
  if (!getStageChatAction(proposal.id)) {
    return {
      action: "reject",
      note:
        `_The response proposed an action ("${proposal.id}") that is not one of this task's stage actions; ` +
        "it was rejected and nothing was executed._",
    };
  }
  return { action: "propose", proposal };
}

/**
 * Build the payload the shared typed executor receives for a stage-chat
 * action: the chat's own task is ALWAYS the target (pinned last so a
 * proposal can never override it), and only the action's allowlisted keys
 * are copied through from the proposal payload. Pure for unit testing.
 */
export function buildStageActionPayload(
  action: StageChatActionDefinition,
  taskFolderPath: string,
  proposalPayload: unknown
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (
    proposalPayload &&
    typeof proposalPayload === "object" &&
    action.allowedPayloadKeys
  ) {
    for (const key of action.allowedPayloadKeys) {
      const value = (proposalPayload as Record<string, unknown>)[key];
      if (value !== undefined) {
        payload[key] = value;
      }
    }
  }
  payload.taskFolder = taskFolderPath;
  return payload;
}
