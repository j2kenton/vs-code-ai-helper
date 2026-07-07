import * as vscode from "vscode";
import {
  CONTEXT_CONFIRM_THRESHOLD_BYTES,
  PROMPT_TOTAL_MAX_BYTES,
  estimateTokensFromUtf8Bytes,
  measurePromptBytes,
} from "./contextEligibility";

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
 */
export async function checkAndConfirmPromptSize(
  prompt: string,
  providerLabel: string
): Promise<"ok" | "confirmed" | "declined" | "abort"> {
  const bytes = measurePromptBytes(prompt);

  // Hard ceiling — no override
  if (bytes > PROMPT_TOTAL_MAX_BYTES) {
    const kb = Math.round(bytes / 1024);
    const ceiling = Math.round(PROMPT_TOTAL_MAX_BYTES / 1024);
    void vscode.window.showErrorMessage(
      `⛔ Prompt is too large to send (${kb} KB). The hard limit is ${ceiling} KB. ` +
        `Reduce the number of open editors, close large files, or shorten your task description.`
    );
    return "abort";
  }

  // High-context confirmation threshold
  if (bytes > CONTEXT_CONFIRM_THRESHOLD_BYTES) {
    const kb = Math.round(bytes / 1024);
    const tokens = estimateTokensFromUtf8Bytes(bytes);
    const choice = await vscode.window.showWarningMessage(
      `⚠️ This will send a prompt of ~${kb} KB (~${tokens.toLocaleString()} tokens) to ${providerLabel}. ` +
        `This may use significant quota. Continue?`,
      { modal: true },
      "Continue"
    );
    if (choice !== "Continue") {
      return "declined";
    }
    return "confirmed";
  }

  return "ok";
}
