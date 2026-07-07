import * as vscode from "vscode";
import { DISCLAIMER_VERSION } from "../legal/disclaimerVersion";

/**
 * Workspace-state key for the current disclaimer version's consent record.
 * Changing DISCLAIMER_VERSION changes the key, which automatically
 * re-prompts users who consented to an older version.
 */
const CONSENT_KEY = `aiHelper.consent.v${DISCLAIMER_VERSION}`;

/**
 * The value stored in workspaceState when the user accepts.
 */
interface ConsentRecord {
  acceptedAt: string; // ISO 8601
  version: number;
}

/**
 * Ensure the user has given informed consent before any AI feature runs.
 *
 * - Checks workspaceState for a valid consent record at the current version.
 * - If absent: shows a modal summarising risks and linking to DISCLAIMER.md.
 * - Returns true when consent is already given or just given.
 * - Returns false when the user declines (caller must abort the AI action).
 *
 * Call this at the TOP of every AI entry point, AFTER the workspace-folder
 * guard and BEFORE any provider launch or file write.
 *
 * Guard ordering in the shared pipeline (src/utils/aiLaunchGuards.ts):
 *   1. ensureAiConsent        ← this function
 *   2. keybinding confirm     (if invoked via keybinding)
 *   3. high-context confirm   (if prompt is large)
 */
export async function ensureAiConsent(
  context: vscode.ExtensionContext
): Promise<boolean> {
  const existing = context.workspaceState.get<ConsentRecord>(CONSENT_KEY);
  if (existing && existing.version === DISCLAIMER_VERSION) {
    return true;
  }

  const ACCEPT = "I Understand — Enable AI Features";
  const VIEW = "View Disclaimer";

  // Loop so "View Disclaimer" returns to the consent dialog rather than
  // silently declining.
  let promptAgain = true;
  while (promptAgain) {
    const choice = await vscode.window.showWarningMessage(
      [
        "⚠️  VS Code AI Helper — Before you continue",
        "",
        "AI commands consume real quota/money from your AI subscription.",
        "AI implementation runs can edit or delete files in your workspace.",
        "File contents from open editors are sent to the selected AI provider.",
        "Out-of-workspace editors are excluded, but any in-workspace editor",
        "  (including unsaved buffers) may be included in the prompt.",
        "",
        "Use is at your own risk. Read DISCLAIMER.md before proceeding.",
        "Never use this extension unsupervised.",
      ].join("\n"),
      { modal: true },
      ACCEPT,
      VIEW
    );

    if (choice === ACCEPT) {
      const record: ConsentRecord = {
        acceptedAt: new Date().toISOString(),
        version: DISCLAIMER_VERSION,
      };
      await context.workspaceState.update(CONSENT_KEY, record);
      return true;
    }

    if (choice === VIEW) {
      await vscode.commands.executeCommand(
        "vs-code-ai-helper.viewDisclaimer"
      );
      // Loop back to the consent dialog
      continue;
    }

    // Dismissed / Esc / closed without choosing
    promptAgain = false;
    return false;
  }

  return false;
}
