import * as vscode from "vscode";

import { runWithAdmittedAutomaticDispatchV1 } from "../state/automationDispatchContextV1";
import { setAutoContinueSweepNowHandlerV1 } from "../state/autoContinueSweepTriggerV1";
import type { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import type { ChatViewProvider } from "../views/chatView";
import { readAutoContinueTaskStateV1 } from "../utils/autoContinueTaskStateV1";
import { runAutoContinueSweepV1 } from "../utils/autoContinueSweepV1";
import { getLiveTaskOperationV1 } from "../utils/liveTaskOperationLookupV1";
import { postApplyReviewerVerifiedTicksDecisionV1 } from "./applyReviewerVerifiedTicks";
import { admitAutomaticDispatchV1 } from "./automaticDispatchGateV1";
import { AUTOMATION_STOPPED_DECISION_KEY_V1 } from "../utils/automationStopV1";
import { postAutomationStoppedCardV1 } from "./automationStoppedCardV1";
import { APPLY_TICKS_DECISION_KEY_V1 } from "./verifiedTicksHeldOptionsV1";

/** How often the countdowns are checked. A countdown is minutes long, so this only bounds how late one can run. */
export const AUTO_CONTINUE_SWEEP_INTERVAL_MS_V1 = 30_000;

/**
 * review1 Step 53: starts the periodic sweep that runs a safe card's recommended option when its countdown ends
 * with no answer. The deadlines are stored on the decision records, so a reload loses nothing: the first pass after
 * activation picks up whatever is armed. Returns a disposable that stops the timer.
 */
export function startAutoContinueSweepV1(
  store: WorkflowDecisionStoreV1,
  chatViewProvider: ChatViewProvider
): vscode.Disposable {
  let running = false;
  const pass = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await runAutoContinueSweepV1({
        listArmed: () => store.listWithArmedAutoContinue(),
        readTaskState: readAutoContinueTaskStateV1,
        cancel: (decisionId, reason) => store.cancelAutoContinue(decisionId, reason),
        admit: async (decision) =>
          (
            await admitAutomaticDispatchV1({
              taskFolderPath: decision.taskCanonicalId,
              kind: "auto-continue",
              stage: decision.stage,
            })
          ).admitted,
        taskIsBusy: (taskFolderPath) => getLiveTaskOperationV1(taskFolderPath) !== undefined,
        run: (decisionId, optionId) =>
          runWithAdmittedAutomaticDispatchV1(() => chatViewProvider.resolveWorkflowDecisionAutomaticallyV1(decisionId, optionId)),
        say: (decisionId, text) => chatViewProvider.appendDecisionStatusLineV1(decisionId, text),
        reoffer: async (decision) => {
          // Only the reviewer-verified ticks card can run unattended today, and it is re-derived from the plan and the
          // latest review, so the fresh card (or the reason there is none) reflects what the task is now.
          if (decision.decisionKey === AUTOMATION_STOPPED_DECISION_KEY_V1) {
            // The next-step card (Move on after a clean review): rebuilt from the task's state now, as a stop card if work
            // is left or as the "<Stage> is done" card if the stage is ready.
            const withdrawnStop = await store.withdraw(decision.decisionId, "the task changed while the card waited");
            if (withdrawnStop.kind !== "withdrawn") return false;
            const folderUri = vscode.Uri.file(decision.taskCanonicalId);
            const reason = "the task changed while the earlier card waited, so this is where things stand now";
            let reposted = (await postAutomationStoppedCardV1({ folderUri, stage: decision.stage, ending: "resumed-run", stopReason: reason })).posted;
            if (!reposted) {
              reposted = (await postAutomationStoppedCardV1({ folderUri, stage: decision.stage, ending: "stage-ready", stopReason: reason })).posted;
            }
            await chatViewProvider.appendDecisionStatusLineV1(
              decision.decisionId,
              reposted
                ? "The task changed while this card waited, so its countdown was stopped and a fresh card was posted from what the task is now."
                : "The task changed while this card waited, so it was withdrawn; nothing is left for it to offer."
            );
            return true;
          }
          if (decision.decisionKey !== APPLY_TICKS_DECISION_KEY_V1) return false;
          const withdrawn = await store.withdraw(decision.decisionId, "the task changed while the card waited");
          if (withdrawn.kind !== "withdrawn") return false;
          const posted = await postApplyReviewerVerifiedTicksDecisionV1(
            vscode.Uri.file(decision.taskCanonicalId),
            decision.taskCanonicalId,
            decision.taskCanonicalId,
            decision.stage
          );
          await chatViewProvider.appendDecisionStatusLineV1(
            decision.decisionId,
            posted.kind === "posted"
              ? "The task changed while this card waited, so its countdown was stopped and a fresh card was posted from what the task is now."
              : "The task changed while this card waited, so it was withdrawn. " +
                  (posted.kind === "blocked" ? posted.message : "Nothing is left to apply.")
          );
          return true;
        },
        now: () => Date.now(),
      });
    } catch (error) {
      console.warn("Auto-continue sweep failed:", error);
    } finally {
      running = false;
    }
  };
  setAutoContinueSweepNowHandlerV1(() => void pass());
  const timer = setInterval(() => void pass(), AUTO_CONTINUE_SWEEP_INTERVAL_MS_V1);
  timer.unref?.();
  const first = setTimeout(() => void pass(), 5_000);
  first.unref?.();
  return {
    dispose: () => {
      setAutoContinueSweepNowHandlerV1(undefined);
      clearInterval(timer);
      clearTimeout(first);
    },
  };
}
