/**
 * bugs3 Step 5: the one chat offer to raise Kimi's `[read] default_max_chars`,
 * and the command that makes the change only after the owner chose it.
 *
 * The offer is a chat decision (never a pop-up), posted at most once per task
 * per window. Declining or dismissing it writes nothing; the oversized prompt
 * keeps being rerouted to another model in the stage's chain.
 */
import * as vscode from "vscode";
import type { ChatTarget } from "../views/chatView";
import type { WorkflowDecisionCommandResultV1 } from "../types/workflowDecisionV1";
import { postWorkflowDecisionV1 } from "../utils/workflowDecisionDispatchV1";
import {
  describeKimiReadConfigOfferV1,
  shouldOfferKimiReadConfigV1,
  type KimiPromptSizeV1,
  type KimiReadCapacityV1,
} from "../utils/kimiReadCapacityV1";
import { applyKimiReadMaxCharsConsentV1 } from "../utils/kimiReadCapacityNodeV1";

export const SET_KIMI_READ_MAX_CHARS_COMMAND_V1 = "vs-code-ai-helper.setKimiReadMaxCharsConfirmed";
export const KIMI_READ_CONFIG_OFFER_KEY_V1 = "offerKimiReadMaxChars";

const offeredForTaskV1 = new Set<string>();

/** Forget which tasks were already offered (tests). */
export function resetKimiReadConfigOfferStateV1(): void {
  offeredForTaskV1.clear();
}

/**
 * Post the consent card for an oversized Kimi prompt, once per task per window.
 * Resolves true when a card was posted by this call.
 */
export async function offerKimiReadConfigInChatV1(
  target: ChatTarget,
  capacity: KimiReadCapacityV1,
  prompt: KimiPromptSizeV1
): Promise<boolean> {
  if (!shouldOfferKimiReadConfigV1(capacity, prompt) || offeredForTaskV1.has(target.canonicalId)) {
    return false;
  }
  offeredForTaskV1.add(target.canonicalId);
  const words = describeKimiReadConfigOfferV1(capacity, prompt);
  const posted = await postWorkflowDecisionV1(
    {
      decisionKey: KIMI_READ_CONFIG_OFFER_KEY_V1,
      taskCanonicalId: target.canonicalId,
      stage: target.stage,
      whatHappened: words.whatHappened,
      whyUserNeeded:
        "The setting lives in your own Kimi config and affects every Kimi session you run, so Ensemble will not change it without your say-so.",
      options: [
        {
          optionId: "setKimiReadMaxChars",
          resumeKind: "continue",
          label: "Let Kimi read 500,000 characters at once",
          consequence: words.consequence,
          effect: { kind: "command", command: SET_KIMI_READ_MAX_CHARS_COMMAND_V1 },
        },
        {
          optionId: "keepKimiDefault",
          resumeKind: "continue",
          label: "Leave my Kimi config alone",
          consequence: words.declineConsequence,
          effect: { kind: "doNothing" },
        },
      ],
      recommendation: {
        kind: "none",
        reasoning: "The choice is yours: it trades larger single reads in all your Kimi sessions for letting Ensemble use Kimi on large prompts.",
      },
      gating: {
        holdsTaskPaused: false,
        unblocksProgress: false,
        detail: "This does not pause the task. The round already went to another model; nothing here is required.",
      },
    },
    target
  );
  return posted !== undefined;
}

/** The command behind the consent option: runs only when the owner picked it. */
export async function setKimiReadMaxCharsConfirmedV1(): Promise<WorkflowDecisionCommandResultV1> {
  const result = await applyKimiReadMaxCharsConsentV1();
  if (!result.ok) {
    return { outcome: "refused", message: result.reason };
  }
  return {
    outcome: result.changed ? "done" : "alreadyDone",
    message: result.changed
      ? `Set [read] default_max_chars = 500000 in ${result.path}. It applies to all your Kimi sessions; set it back by hand to undo.`
      : `${result.path} already has [read] default_max_chars = 500000; nothing changed.`,
  };
}

export function registerKimiReadConfigCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(SET_KIMI_READ_MAX_CHARS_COMMAND_V1, () => setKimiReadMaxCharsConfirmedV1())
  );
}
