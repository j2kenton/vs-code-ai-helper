import * as vscode from "vscode";
import {
  CONTEXT_CONFIRM_THRESHOLD_BYTES,
  PROMPT_TOTAL_MAX_BYTES,
  estimateTokensFromUtf8Bytes,
  measurePromptBytes,
} from "./contextEligibility";
import {
  isLargeTokenRequestWarningEnabled,
  setLargeTokenRequestWarningEnabled,
} from "../config/settings";
import { NotificationRouter } from "./notificationRouter";
import { isUnattendedExecutionV1, unattendedRefusalV1 } from "../state/unattendedExecutionV1";
import {
  describeAutomationDefaultV1,
  isAutomationDispatchContextV1,
} from "../state/automationDispatchContextV1";
import { formatNotificationTaskLabelV1 } from "./notificationTaskContextV1";

/**
 * Check whether a prompt is safe to send, applying two enforcement rules:
 *
 * 1. Hard ceiling (`PROMPT_TOTAL_MAX_BYTES`): if the prompt exceeds this,
 *    abort immediately — no confirm can override it. Returns `"abort"`.
 *
 * 2. High-context confirm (`CONTEXT_CONFIRM_THRESHOLD_BYTES`): if the
 *    prompt is large but below the ceiling, show a one-off confirmation
 *    dialog before the run. Returns `"confirmed"` when the user proceeds,
 *    `"declined"` when they cancel.
 *
 * Returns `"ok"` when the prompt is below the confirmation threshold
 * (no dialog shown, caller should proceed).
 *
 * Call this AFTER consent has succeeded and BEFORE any provider process
 * is launched or any on-disk artifact is written for the run.
 *
 * `backupProviderCount`, when the caller may retry this exact prompt against
 * configured backups (for quota/availability fallback or content-validation
 * failure), discloses that in the confirmation text — the dialog otherwise
 * names only `providerLabel`, which is misleading once the same prompt can
 * silently fan out to other providers' quotas afterward.
 *
 * This function does NOT report Notifications in-flight activity — by the
 * time it runs, the prompt is already fully assembled (template-rendered,
 * and at some call sites already shrunk to fit a canonical-size ceiling), so
 * its byte count no longer describes "reading context." Callers that want a
 * live "reading context (N KB)" row report it themselves, sized from the
 * context pack their own assembly step produced, right after that step
 * resolves — see reviewActions.ts's `generateContextPack` call sites.
 */
export async function checkAndConfirmPromptSize(
  prompt: string,
  providerLabel: string,
  backupProviderCount = 0,
  /**
   * The task this prompt belongs to, when the caller has one — every call
   * site but the Global Assistant's does. Used only to name the task in the
   * notifications below; never affects the size check itself.
   */
  task?: { displayName?: string; folderPath: string }
): Promise<"ok" | "confirmed" | "declined" | "abort"> {
  const bytes = measurePromptBytes(prompt);
  const taskLabel = task ? formatNotificationTaskLabelV1(task.displayName, task.folderPath) : undefined;
  const withTaskLabel = (message: string): string => (taskLabel ? `${taskLabel} — ${message}` : message);

  // Hard ceiling — no override
  if (bytes > PROMPT_TOTAL_MAX_BYTES) {
    const kb = Math.round(bytes / 1024);
    const ceiling = Math.round(PROMPT_TOTAL_MAX_BYTES / 1024);
    NotificationRouter.showError(
      withTaskLabel(
        `⛔ Prompt is too large to send (${kb} KB). The hard limit is ${ceiling} KB. ` +
          `Reduce the number of open editors, close large files, or shorten your task description.`
      )
    );
    return "abort";
  }

  // High-context confirmation threshold. Configurable: when the user has
  // opted out (vs-code-ai-helper.warnings.largeTokenRequest = false) the
  // dialog is skipped and the run proceeds as if confirmed. The hard
  // ceiling above is never skippable. Native modals can't host a checkbox,
  // so the opt-out is the middle button rather than a checkbox.
  if (bytes > CONTEXT_CONFIRM_THRESHOLD_BYTES) {
    if (!isLargeTokenRequestWarningEnabled()) {
      return "confirmed";
    }
    if (isUnattendedExecutionV1()) {
      // Relayed from a viewer (unattendedExecutionV1.ts): nobody can answer
      // this dialog here. Declining is the safe answer — it is the user's
      // quota — and the relay reports the reason instead of hanging.
      const kb = Math.round(bytes / 1024);
      NotificationRouter.showWarning(
        withTaskLabel(
          unattendedRefusalV1(`Sending a ~${kb} KB prompt to ${providerLabel}`) +
            " (turn off the large-request warning in Ensemble Settings to send prompts this size without asking.)"
        )
      );
      return "declined";
    }
    if (isAutomationDispatchContextV1()) {
      // Automation-driven round: no human can answer the modal below. Decline
      // (the safe answer — it is the user's quota), say so, and name the
      // setting that lets prompts this size through unattended.
      const kbAuto = Math.round(bytes / 1024);
      console.log(describeAutomationDefaultV1(`Sending a ~${kbAuto} KB prompt to ${providerLabel}`, "declined"));
      NotificationRouter.showWarning(
        withTaskLabel(
          `An automated round did not send a ~${kbAuto} KB prompt to ${providerLabel}: large prompts need a confirmation ` +
            "and no one was attached to give it. Turn off the large-request warning in Ensemble Settings to let " +
            "automated rounds send prompts this size, then run the action again."
        )
      );
      return "declined";
    }
    const kb = Math.round(bytes / 1024);
    const tokens = estimateTokensFromUtf8Bytes(bytes);
    const PROCEED = "Proceed";
    const PROCEED_DONT_ASK = "Proceed and don't ask again";
    const backupNote = backupProviderCount > 0
      ? ` If this run hits quota/availability limits or its response doesn't validate, this same prompt may also be retried against up to ` +
        `${backupProviderCount} configured backup model${backupProviderCount === 1 ? "" : "s"}.`
      : "";
    const choice = await vscode.window.showWarningMessage(
      withTaskLabel(
        `⚠️ This will send a prompt of ~${kb} KB (~${tokens.toLocaleString()} tokens) to ${providerLabel}. ` +
          `This may use significant quota.${backupNote} Continue?`
      ),
      { modal: true },
      PROCEED,
      PROCEED_DONT_ASK
    );
    if (choice === PROCEED_DONT_ASK) {
      await setLargeTokenRequestWarningEnabled(false);
      return "confirmed";
    }
    if (choice !== PROCEED) {
      return "declined";
    }
    return "confirmed";
  }

  return "ok";
}
