import * as vscode from "vscode";
import { AI_MODEL_STAGES, STAGE_DISPLAY_NAMES, TaskStage } from "../types/taskProgress";
import {
  clearTaskStageModels,
  findTaskModelConflicts,
  getAvailableModels,
} from "../utils/modelSelection";
import {
  getModelSettings,
  getEnabledProviders,
  isUnsavedSettingsWarningEnabled,
  setEnabledProviders,
  setModelSettings,
  setUnsavedSettingsWarningEnabled,
} from "../config/settings";
import { ModelSettings } from "../utils/modelFallback";
import { getQuotaStatusText } from "../utils/quota";
import {
  getProviderAccountEntry,
  PROVIDER_ACCOUNT_ENTRIES,
  ProviderAccountEntry,
  ProviderSignInAction,
} from "../runners/providers";
import { NotificationRouter } from "../utils/notificationRouter";

type IncomingMessage =
  | { type: "ready" }
  | { type: "rendered" }
  | { type: "saveSettings"; settings: ModelSettings }
  | { type: "saveProviders"; enabledProviders: Record<string, boolean> }
  | { type: "validationError"; message: string }
  | { type: "refreshQuotaStatus" }
  | { type: "providerSignIn"; providerId: string }
  | { type: "providerUsage"; providerId: string }
  | { type: "suppressUnsavedWarning" };

/** Provider label for terminal titles/messages, without a doubled "CLI". */
function accountEntryDisplayLabel(entry: ProviderAccountEntry): string {
  return entry.label.replace(/\s+CLI$/i, "");
}

/**
 * How long the interactive CLI gets to start before its in-session slash
 * command is typed into the terminal. sendText writes straight to the
 * terminal's stdin, so sending the slash command before the CLI is reading
 * input would hand it to the shell instead; VS Code exposes no "CLI is now
 * reading" signal, so a short fixed delay is the available approximation.
 */
export const INTERACTIVE_SLASH_DELAY_MS = 3000;

/**
 * How long to wait, after typing the slash command's text, before sending
 * the submit keystroke. These CLIs' interactive TUIs treat a burst of input
 * ending in a newline as a paste, not a keypress, and only insert a literal
 * newline instead of submitting; a short gap between the typed text and the
 * submit byte gets it recognized as a real Enter press.
 */
export const INTERACTIVE_SLASH_SUBMIT_DELAY_MS = 150;

/** The subset of vscode.Terminal that sendInteractiveSlashCommand needs — narrowed so tests can pass a plain stub. */
export interface InteractiveTerminalLike {
  sendText(text: string, shouldExecute?: boolean): void;
}

/** Injectable in place of setTimeout so tests can run the sequence synchronously. */
export type InteractiveScheduler = (callback: () => void, delayMs: number) => void;

const defaultInteractiveScheduler: InteractiveScheduler = (callback, delayMs) => {
  setTimeout(callback, delayMs);
};

/**
 * Dispatch an "interactive" provider capability: launch the provider's CLI
 * in the given terminal, then send the in-session slash command (e.g.
 * `/usage`, `/stats model`) into the running session. The launch and the
 * slash command are deliberately never concatenated into one command line —
 * the slash commands only exist inside the interactive session.
 *
 * The slash command's TEXT and its SUBMIT keystroke are sent as two separate
 * sendText calls, both with shouldExecute=false. shouldExecute=true appends
 * the platform newline, which on Windows is `\r\n` — a real key press only
 * ever sends `\r`. Worse, sending text-plus-newline in a single write reads
 * to these CLIs' raw-mode TUIs as a paste, whose trailing `\n` lands the
 * cursor on a fresh input line instead of submitting (observed with Codex's
 * `/usage`; Claude's TUI is susceptible to the same bug). Splitting the
 * write into "type the text" then, after a short delay, "press Enter" (`\r`
 * alone) avoids both problems.
 */
export function sendInteractiveSlashCommand(
  terminal: InteractiveTerminalLike,
  capability: { launch: string; send: string },
  scheduler: InteractiveScheduler = defaultInteractiveScheduler
): void {
  terminal.sendText(capability.launch, true);
  scheduler(() => {
    terminal.sendText(capability.send, false);
    scheduler(() => {
      terminal.sendText("\r", false);
    }, INTERACTIVE_SLASH_SUBMIT_DELAY_MS);
  }, INTERACTIVE_SLASH_DELAY_MS);
}

/** Dependencies dispatchVsCodeCommandSignIn needs, injected so it's testable without a VS Code host. */
export interface VsCodeCommandSignInDeps {
  listCommands: () => Promise<readonly string[]>;
  executeCommand: (command: string) => Promise<unknown>;
  showInfo: (message: string) => void;
  showError: (message: string) => void;
}

type VsCodeCommandSignInAction = Extract<ProviderSignInAction, { kind: "vscode-command" }>;

/**
 * Dispatch a "vscode-command" sign-in capability (Copilot). Both `commands`
 * (primary) and `fallbackCommands` are ordered, newest-first candidate
 * lists — see ProviderSignInAction's doc comment for why. Semantics:
 *
 *  - Registration is checked once via `listCommands()`; if that call itself
 *    rejects, registration is treated as "unknown" (not "nothing
 *    registered") so every candidate is attempted directly rather than the
 *    handler crashing or short-circuiting straight to the terminal error.
 *  - The first candidate on the primary list that is registered (or
 *    unknown) is tried; if it throws, dispatch falls through to the
 *    fallback list exactly as if no primary candidate had been registered.
 *  - The first candidate on the fallback list that is registered (or
 *    unknown) and succeeds shows the existing "managed by VS Code" info
 *    message.
 *  - The terminal error (naming the manual Accounts-menu path) fires only
 *    when nothing on either list is registered, or the fallback candidate
 *    that was tried also throws.
 */
export async function dispatchVsCodeCommandSignIn(
  displayLabel: string,
  capability: VsCodeCommandSignInAction,
  deps: VsCodeCommandSignInDeps
): Promise<void> {
  let registered: readonly string[] | undefined;
  try {
    registered = await deps.listCommands();
  } catch {
    registered = undefined;
  }
  const isRegistered = (id: string): boolean => registered === undefined || registered.includes(id);

  const tryRun = async (id: string): Promise<boolean> => {
    try {
      await deps.executeCommand(id);
      return true;
    } catch {
      return false;
    }
  };

  const primary = capability.commands.find(isRegistered);
  if (primary && (await tryRun(primary))) {
    return;
  }

  const fallback = capability.fallbackCommands.find(isRegistered);
  if (fallback && (await tryRun(fallback))) {
    deps.showInfo(
      `${displayLabel} sign-in is managed by VS Code — use the Accounts menu to sign in or switch the GitHub account.`
    );
    return;
  }

  deps.showError(
    `Could not start the ${displayLabel} sign-in — the provider's sign-in command is not available. ` +
      "Use the Accounts menu (bottom-left) to sign in with GitHub."
  );
}

export class SettingsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "vs-code-ai-helper.settingsView";
  private _view?: vscode.WebviewView;
  // True once the webview has confirmed its table rows actually exist in
  // the DOM (see the "rendered" case below) — NOT just that its message
  // listener is attached. focusStage() needs row-<stage> elements to exist,
  // which is a strictly later point than "ready to receive postMessage".
  private _tableRendered = false;
  private _pendingFocus?: { stage: TaskStage; control: "primary" | "backup" };
  private _conflictsChecked = false;

  constructor(private readonly extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    this._tableRendered = false;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data: IncomingMessage) => {
      switch (data.type) {
        case "ready": {
          // Collapsing this panel makes VS Code deallocate its webview
          // document; re-expanding recreates it and calls resolveWebviewView
          // again. Posting "init" eagerly (right after setting .html) races
          // that fresh document's script load: if getAvailableModels()
          // resolves first — it's cache-backed — the message is posted before
          // the webview's listener exists and is silently dropped, leaving
          // the panel permanently blank. Waiting for the webview to announce
          // it's ready avoids that race regardless of timing.
          await this._postInit(webviewView.webview);
          break;
        }
        case "rendered": {
          // Distinct from "ready": this fires only after the webview has
          // actually built its table rows from the "init" payload, which is
          // what focusStage() needs (it looks up 'row-' + stage in the DOM).
          this._tableRendered = true;
          if (this._pendingFocus) {
            const pending = this._pendingFocus;
            this._pendingFocus = undefined;
            void webviewView.webview.postMessage({ type: "focusStage", ...pending });
          }
          break;
        }
        case "saveSettings": {
          await setModelSettings(data.settings);
          NotificationRouter.showInformation("AI model settings saved.");
          break;
        }
        case "validationError": {
          void vscode.window.showErrorMessage(data.message);
          break;
        }
        case "saveProviders": {
          await setEnabledProviders(data.enabledProviders);
          NotificationRouter.showInformation("Provider selection saved.");
          break;
        }
        case "refreshQuotaStatus": {
          void webviewView.webview.postMessage({ type: "quotaStatus", quotaStatus: this._buildQuotaStatus() });
          break;
        }
        case "providerSignIn": {
          const provider = getProviderAccountEntry(data.providerId);
          if (!provider) {
            return;
          }
          if (provider.signIn.kind === "vscode-command") {
            // VS Code-native auth (Copilot): never a shell command — try
            // each candidate on the primary list, then each candidate on the
            // Accounts-menu fallback list, first REGISTERED one wins. See
            // dispatchVsCodeCommandSignIn's doc comment for the full
            // fallback/error semantics.
            await dispatchVsCodeCommandSignIn(
              accountEntryDisplayLabel(provider),
              provider.signIn,
              {
                listCommands: () => Promise.resolve(vscode.commands.getCommands(true)),
                executeCommand: (command) => Promise.resolve(vscode.commands.executeCommand(command)),
                showInfo: (message) => NotificationRouter.showInformation(message),
                showError: (message) => void vscode.window.showErrorMessage(message),
              }
            );
            break;
          }
          if (provider.signIn.kind === "manual") {
            NotificationRouter.showInformation(provider.signIn.instructions);
            if (provider.signIn.url) {
              void vscode.env.openExternal(vscode.Uri.parse(provider.signIn.url));
            }
            break;
          }
          if (provider.signIn.kind === "unsupported") {
            NotificationRouter.showInformation(provider.signIn.reason);
            break;
          }
          // Run the interactive login/switch-account flow in a VISIBLE IDE
          // terminal. The extension reports the terminal as launched — it
          // never claims the sign-in succeeded; any post-hoc status comes
          // from the next model-discovery pass.
          try {
            const terminal = vscode.window.createTerminal({
              name: `Ensemble Sign-in (${accountEntryDisplayLabel(provider)})`,
            });
            terminal.show();
            if (provider.signIn.kind === "interactive") {
              sendInteractiveSlashCommand(terminal, provider.signIn);
            } else {
              terminal.sendText(provider.signIn.command, true);
            }
            NotificationRouter.showInformation(
              `${accountEntryDisplayLabel(provider)} sign-in launched in the terminal. ` +
                (provider.signInGuidance ?? "Complete the sign-in there.")
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(
              `Could not open a terminal for the ${accountEntryDisplayLabel(provider)} sign-in: ${message}`
            );
          }
          break;
        }
        case "providerUsage": {
          const provider = getProviderAccountEntry(data.providerId);
          if (!provider) {
            return;
          }
          // Dispatch on the same capability descriptor the UI rendered the
          // button from (single source of truth — see ProviderActionCapability).
          const usage = provider.usage;
          if (usage.kind === "unsupported") {
            NotificationRouter.showInformation(usage.reason);
            if (usage.url) {
              void vscode.env.openExternal(vscode.Uri.parse(usage.url));
            }
            break;
          }
          if (usage.kind === "manual") {
            NotificationRouter.showInformation(usage.instructions);
            if (usage.url) {
              void vscode.env.openExternal(vscode.Uri.parse(usage.url));
            }
            break;
          }
          if (usage.kind === "vscode-command") {
            try {
              await vscode.commands.executeCommand(usage.command);
            } catch {
              if (usage.fallbackCommand) {
                try {
                  await vscode.commands.executeCommand(usage.fallbackCommand);
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  void vscode.window.showErrorMessage(
                    `Could not run the ${accountEntryDisplayLabel(provider)} usage check: ${message}`
                  );
                }
              }
            }
            break;
          }
          // Usage/quota is reported by the provider's own CLI in a visible
          // terminal — the extension never fabricates a percentage.
          // "interactive": the usage surface is an in-session slash command,
          // so the CLI is launched first and the slash command is sent into
          // the running session (never concatenated into one command line).
          try {
            const terminal = vscode.window.createTerminal({
              name: `Ensemble Usage (${accountEntryDisplayLabel(provider)})`,
            });
            terminal.show();
            if (usage.kind === "interactive") {
              sendInteractiveSlashCommand(terminal, usage);
            } else {
              terminal.sendText(usage.command, true);
            }
            NotificationRouter.showInformation(
              `${accountEntryDisplayLabel(provider)} usage check launched in the terminal.`
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(
              `Could not open a terminal for the ${accountEntryDisplayLabel(provider)} usage check: ${message}`
            );
          }
          break;
        }
        case "suppressUnsavedWarning": {
          // The in-webview "Don't show again" checkbox for the
          // unsaved-settings warning.
          await setUnsavedSettingsWarningEnabled(false);
          break;
        }
      }
    });

    // Refresh quota status (session-observed, not persisted) whenever the
    // panel becomes visible again, so re-opening it after a run reflects
    // what actually happened rather than a stale snapshot from first load.
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void webviewView.webview.postMessage({ type: "quotaStatus", quotaStatus: this._buildQuotaStatus() });
      }
    });

    // Model settings and provider selection can be edited directly in
    // settings.json, or from a different workspace via the Global scope —
    // re-sync the panel so it doesn't show a stale snapshot. The webview
    // itself guards this refresh with the unsaved-changes warning when its
    // form is dirty (an interceptable discard path).
    const configListener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (webviewView.visible && event.affectsConfiguration("ensemble")) {
        void this._postInit(webviewView.webview);
      }
    });
    webviewView.onDidDispose(() => { configListener.dispose(); });

    // resolveWebviewView runs on every reveal after this panel was
    // collapsed, not just once per session — guard with _conflictsChecked so
    // this prompt is a true one-shot.
    if (!this._conflictsChecked) {
      this._conflictsChecked = true;
      void this._checkModelSettingsConflicts();
    }
  }

  /**
   * Send the current settings/models/quota snapshot to the webview. Only
   * called once the webview confirms via "ready" that its script has loaded
   * and attached a message listener.
   *
   * The model list from getAvailableModels() is already filtered by the
   * globally enabled providers — that selection is the single source of
   * truth for which providers' models are offered anywhere in the UI.
   */
  private async _postInit(webview: vscode.Webview): Promise<void> {
    const settings = getModelSettings();
    const models = await getAvailableModels();

    void webview.postMessage({
      type: "init",
      settings,
      models,
      stages: AI_MODEL_STAGES,
      stageNames: STAGE_DISPLAY_NAMES,
      quotaStatus: this._buildQuotaStatus(),
      enabledProviders: getEnabledProviders(),
      providers: PROVIDER_ACCOUNT_ENTRIES.map((provider) => ({
        id: provider.id,
        label: provider.label,
        signInLabel: provider.signInLabel,
        signInGuidance: provider.signInGuidance ?? "",
        // UI button state comes from the same capability descriptor the
        // handler dispatches on: enabled for terminal/interactive/
        // vscode-command/manual, and also for unsupported when it carries a
        // usage-page `url` (the button then opens that page instead of
        // running anything); disabled (with the reason as tooltip) only for
        // unsupported with no known page to send the user to.
        usageEnabled: provider.usage.kind !== "unsupported" || provider.usage.url !== undefined,
        usageTooltip:
          provider.usage.kind === "unsupported"
            ? provider.usage.url
              ? `${provider.usage.reason} Opens the usage page.`
              : provider.usage.reason
            : provider.usage.kind === "manual"
              ? provider.usage.instructions
              : provider.usage.kind === "interactive"
                ? `Launches the provider's CLI in a terminal and runs its ${provider.usage.send} command there`
                : "Runs the provider's usage command in a visible terminal",
        enabledByDefault: provider.enabledByDefault,
      })),
      warnUnsavedSettings: isUnsavedSettingsWarningEnabled(),
    });
  }

  /**
   * Leftover per-task model override files (see utils/modelSelection.ts —
   * findTaskModelConflicts) are inert now that model configuration lives
   * only in this AI Models panel. Surface them once so the user can clear
   * them instead of the extension silently ignoring files it once wrote.
   */
  private async _checkModelSettingsConflicts(): Promise<void> {
    const conflicts = await findTaskModelConflicts();
    if (conflicts.length === 0) {
      return;
    }

    const taskWord = conflicts.length === 1 ? "task has" : "tasks have";
    const choice = await vscode.window.showWarningMessage(
      `${conflicts.length} ${taskWord} leftover per-task model overrides from before model ` +
        "configuration moved to the AI Models panel. They are no longer used — the settings " +
        "above always apply now.",
      "Reset to Default",
      "Keep Existing"
    );
    if (choice === "Reset to Default") {
      for (const conflict of conflicts) {
        await clearTaskStageModels(conflict.taskFolderUri, conflict.stages);
      }
      void vscode.window.showInformationMessage(
        `Cleared leftover per-task model overrides for ${conflicts.length} ${taskWord}.`
      );
    }
  }

  /**
   * Session-observed quota status for every stage's configured primary and
   * backup model. Keyed as `${stage}:primary` / `${stage}:backup` to match
   * how the webview looks it up. See utils/quota.ts — this is never a
   * fabricated percentage, only what this session has actually observed.
   */
  private _buildQuotaStatus(): Record<string, string> {
    const settings = getModelSettings();
    const quotaStatus: Record<string, string> = {};
    for (const stage of AI_MODEL_STAGES) {
      const setting = settings[stage];
      if (setting?.primary) {
        quotaStatus[`${stage}:primary`] = getQuotaStatusText(stage, setting.primary);
      }
      if (setting?.backup) {
        quotaStatus[`${stage}:backup`] = getQuotaStatusText(stage, setting.backup);
      }
    }
    return quotaStatus;
  }

  public focusStage(stage: TaskStage, control: "primary" | "backup" = "primary"): void {
    if (!this._view) {
      return;
    }
    this._view.show(false);
    if (this._tableRendered) {
      void this._view.webview.postMessage({ type: "focusStage", stage, control });
    } else {
      // Either show(false) just triggered a fresh resolveWebviewView (if
      // the panel was collapsed), tearing down the old document, or the
      // current document is still mid-init. Queue the request so it's
      // delivered once "rendered" confirms the rows actually exist.
      this._pendingFocus = { stage, control };
    }
  }

  public reveal(preserveFocus = false): boolean {
    if (!this._view) {
      return false;
    }
    this._view.show(preserveFocus);
    return true;
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Ensemble AI Models</title>
        <style>
          :root {
            --ensemble-space-1: 4px;
            --ensemble-space-2: 8px;
            --ensemble-space-3: 12px;
            --ensemble-space-4: 16px;
            --ensemble-space-half: 2px;
            --ensemble-border-width: 1px;
            --ensemble-focus-width: 2px;
            --ensemble-radius: 3px;
            --ensemble-small-font-size: 0.9em;
          }
          body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            padding: var(--ensemble-space-3);
            margin: 0;
            background-color: var(--vscode-editor-background);
          }
          .visually-hidden {
            position: absolute;
            width: 1px;
            height: 1px;
            padding: 0;
            margin: -1px;
            overflow: hidden;
            clip: rect(0, 0, 0, 0);
            border: 0;
          }
          select, input[type="text"] {
            width: 100%;
            background-color: var(--vscode-input-background, var(--vscode-editor-background));
            color: var(--vscode-input-foreground, var(--vscode-foreground));
            border: var(--ensemble-border-width) solid var(--vscode-input-border, var(--vscode-widget-border));
            padding: var(--ensemble-space-1);
            border-radius: var(--ensemble-radius);
            box-sizing: border-box;
          }
          select:focus, input[type="text"]:focus {
            outline: var(--ensemble-border-width) solid var(--vscode-focusBorder);
          }
          option {
            background-color: var(--vscode-dropdown-background, var(--vscode-editor-background));
            color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
          }
          .model-combobox {
            position: relative;
          }
          .model-combo-input[disabled] {
            opacity: 0.55;
            cursor: not-allowed;
          }
          .model-options {
            position: absolute;
            left: 0;
            right: 0;
            top: calc(100% + var(--ensemble-space-1));
            z-index: 10;
            max-height: 220px;
            overflow-y: auto;
            background-color: var(--vscode-dropdown-background, var(--vscode-editorWidget-background, var(--vscode-editor-background)));
            color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
            border: var(--ensemble-border-width) solid var(--vscode-dropdown-border, var(--vscode-widget-border));
            box-shadow: 0 var(--ensemble-space-half) var(--ensemble-space-2) var(--vscode-widget-shadow);
          }
          .model-option {
            padding: var(--ensemble-space-1) var(--ensemble-space-2);
            cursor: pointer;
            white-space: normal;
            overflow-wrap: anywhere;
          }
          .model-option[aria-selected="true"],
          .model-option:hover {
            background-color: var(--vscode-list-hoverBackground);
            color: var(--vscode-list-hoverForeground);
          }
          .model-option.empty {
            color: var(--vscode-descriptionForeground);
            cursor: default;
          }
          .quota-text {
            font-size: var(--ensemble-small-font-size);
            color: var(--vscode-descriptionForeground);
            margin-top: var(--ensemble-space-half);
          }
          .provider-disabled-note {
            font-size: var(--ensemble-small-font-size);
            color: var(--vscode-errorForeground);
            margin-top: var(--ensemble-space-half);
          }
          .btn-container {
            display: flex;
            gap: var(--ensemble-space-2);
            margin-top: var(--ensemble-space-4);
          }
          #loading-indicator {
            color: var(--vscode-descriptionForeground);
            padding: var(--ensemble-space-3) 0;
          }
          button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: var(--ensemble-space-1) var(--ensemble-space-3);
            cursor: pointer;
            border-radius: var(--ensemble-radius);
          }
          button:hover {
            background-color: var(--vscode-button-hoverBackground);
          }
          button:focus-visible, select:focus-visible, input[type="text"]:focus-visible {
            outline: var(--ensemble-focus-width) solid var(--vscode-focusBorder);
            outline-offset: var(--ensemble-border-width);
          }
          button:disabled {
            opacity: 0.5;
            cursor: default;
          }
          button.secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
          }
          button.secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
          }
          .stage-row {
            padding: var(--ensemble-space-3) 0 var(--ensemble-space-2);
            border-bottom: var(--ensemble-border-width) solid var(--vscode-widget-border);
          }
          .stage-heading {
            margin: 0 0 var(--ensemble-space-2);
            font-size: 1em;
            font-weight: bold;
          }
          .stage-row.highlighted {
            background-color: var(--vscode-editor-findMatchHighlightBackground);
          }
          #unsaved-warning-overlay {
            position: fixed;
            inset: 0;
            background: var(--vscode-editorWidget-background);
            z-index: 50;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          #unsaved-warning-dialog {
            background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
            border: var(--ensemble-border-width) solid var(--vscode-widget-border);
            box-shadow: 0 var(--ensemble-space-1) var(--ensemble-space-4) var(--vscode-widget-shadow);
            padding: var(--ensemble-space-4);
            max-width: 420px;
          }
          .restored-note {
            background: var(--vscode-inputValidation-infoBackground);
            border: var(--ensemble-border-width) solid var(--vscode-inputValidation-infoBorder);
            padding: var(--ensemble-space-2);
            margin: var(--ensemble-space-2) 0;
            font-size: var(--ensemble-small-font-size);
          }
          .dialog-checkbox {
            display: block;
            margin: var(--ensemble-space-3) 0;
          }
          .provider-row {
            display: flex;
            align-items: center;
            gap: var(--ensemble-space-2);
            flex-wrap: wrap;
            margin: var(--ensemble-space-1) 0;
          }
          .provider-help {
            margin: var(--ensemble-space-2) 0 0;
            font-size: var(--ensemble-small-font-size);
            color: var(--vscode-descriptionForeground);
          }
          .form-row {
            margin-bottom: var(--ensemble-space-2);
          }
          .field-label {
            display: block;
            margin-bottom: var(--ensemble-space-half);
            font-size: var(--ensemble-small-font-size);
          }
          .extra-backup {
            display: flex;
            gap: var(--ensemble-space-1);
            margin-top: var(--ensemble-space-1);
            align-items: flex-start;
          }
          .extra-backup .model-combobox {
            flex: 1;
          }
          .add-backup {
            margin-top: var(--ensemble-space-1);
          }
          .backup-limit {
            margin-left: var(--ensemble-space-1);
            font-size: var(--ensemble-small-font-size);
          }
        </style>
      </head>
      <body>
        <div role="status" aria-live="polite" id="status-region" class="visually-hidden"></div>
        <div role="alert" aria-live="assertive" id="alert-region" class="visually-hidden"></div>

        <div id="loading-indicator">Loading settings…</div>

        <!-- Provider selection: the single source of truth for which
             providers' models are offered in every combo box below. -->
        <div id="provider-selection"></div>

        <div id="restored-note-container"></div>

        <!-- Single-column layout: one titled section per stage (stage name
             as a heading, then primary model / fallback strategy / backup
             models stacked vertically). The container keeps the historical
             "settings-table"/"stages-tbody" ids so the show/hide and
             delegated-listener wiring below is unchanged. -->
        <div id="settings-table" hidden>
          <div id="stages-tbody">
            <!-- Will be populated dynamically -->
          </div>
        </div>

        <div class="btn-container" id="model-settings-buttons" hidden>
          <button id="reset-btn" class="secondary">Reset to Defaults</button>
          <button id="save-btn" disabled>Save Settings</button>
        </div>

        <script nonce="${nonce}">
          const vscode = acquireVsCodeApi();
          let currentSettings = {};
          let availableModels = [];
          let stagesList = [];
          let stageDisplayNames = {};
          let quotaStatus = {};
          let enabledProviders = {};
          let providers = [];
          let warnUnsavedSettings = true;
          let formDirty = false;
          let initialized = false;
          let extraBackupSeq = 0;

          function updateSaveButtonState() {
            document.getElementById('save-btn').disabled = !formDirty;
          }

          function markDirty() {
            if (!formDirty) {
              formDirty = true;
              updateSaveButtonState();
            }
            persistDraft();
          }

          function clearDirty() {
            formDirty = false;
            updateSaveButtonState();
            vscode.setState(undefined);
          }

          // Draft preservation for discard paths the extension cannot
          // intercept (VS Code disposing the webview when the view is hidden
          // or closed): serialize the dirty form into the webview state API
          // so it can be restored with a notice on the next render.
          function persistDraft() {
            try {
              vscode.setState({ draftSettings: collectFormSettings().settings });
            } catch {
              // Collection can fail mid-render; drafts are best-effort.
            }
          }

          function takeSavedDraft() {
            const state = vscode.getState();
            return state && state.draftSettings ? state.draftSettings : undefined;
          }

          // ── Unsaved-changes warning (interceptable discard paths) ──────
          // Shown before any extension-initiated re-render, in-form Reset, or
          // external-settings reload discards dirty form state. Hosts a REAL
          // "Don't show again" checkbox (this is a webview, unlike native
          // modals). Uninterceptable discards are covered by persistDraft().
          function confirmDiscardUnsaved(actionLabel) {
            return new Promise(resolve => {
              if (!formDirty || !warnUnsavedSettings) {
                resolve(true);
                return;
              }
              const overlay = document.createElement('div');
              overlay.id = 'unsaved-warning-overlay';
              overlay.innerHTML =
                '<div id="unsaved-warning-dialog" role="alertdialog" aria-modal="true">' +
                '<p><strong>You have unsaved model settings.</strong></p>' +
                '<p>' + escapeHtml(actionLabel) + ' will discard them.</p>' +
                '<label class="dialog-checkbox"><input type="checkbox" id="unsaved-dont-show"> Don\\'t show again</label>' +
                '<div class="btn-container">' +
                '<button id="unsaved-discard">Discard Changes</button>' +
                '<button id="unsaved-keep" class="secondary">Keep Editing</button>' +
                '</div></div>';
              document.body.appendChild(overlay);
              const opener = document.activeElement;
              const finish = (proceed) => {
                const dontShow = overlay.querySelector('#unsaved-dont-show').checked;
                if (dontShow) {
                  warnUnsavedSettings = false;
                  vscode.postMessage({ type: 'suppressUnsavedWarning' });
                }
                overlay.remove();
                if (opener instanceof HTMLElement) opener.focus();
                resolve(proceed);
              };
              overlay.querySelector('#unsaved-discard').addEventListener('click', () => finish(true));
              overlay.querySelector('#unsaved-keep').addEventListener('click', () => finish(false));
              overlay.addEventListener('keydown', event => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  finish(false);
                }
              });
              overlay.querySelector('#unsaved-keep').focus();
            });
          }

          window.addEventListener('message', async event => {
            const message = event.data;
            if (message.type === 'init') {
              // An init while the form is dirty is a discard: the
              // extension re-sends state after external settings changes or
              // its own refresh. Warn (with opt-out) before applying.
              if (initialized && formDirty) {
                const proceed = await confirmDiscardUnsaved('Reloading the settings from disk');
                if (!proceed) {
                  // Keep the dirty form; the user can Save and the next
                  // config-change event will re-sync.
                  warnUnsavedSettings = message.warnUnsavedSettings !== false;
                  return;
                }
              }
              currentSettings = message.settings || {};
              availableModels = message.models || [];
              stagesList = message.stages || [];
              stageDisplayNames = message.stageNames || {};
              quotaStatus = message.quotaStatus || {};
              enabledProviders = message.enabledProviders || {};
              providers = message.providers || [];
              warnUnsavedSettings = message.warnUnsavedSettings !== false;

              // Restore a draft preserved across a webview disposal.
              const draft = takeSavedDraft();
              let restoredDraft = false;
              if (!initialized && draft) {
                currentSettings = draft;
                restoredDraft = true;
              }

              renderProviderSelection();
              renderTable();
              document.getElementById('loading-indicator').hidden = true;
              document.getElementById('settings-table').hidden = false;
              document.getElementById('model-settings-buttons').hidden = false;
              initialized = true;
              if (restoredDraft) {
                const note = document.createElement('div');
                note.className = 'restored-note';
                note.textContent = 'Restored unsaved changes from your previous session. Click Save Settings to apply them.';
                const container = document.getElementById('restored-note-container');
                container.innerHTML = '';
                container.appendChild(note);
                formDirty = true;
                updateSaveButtonState();
              } else {
                clearDirty();
              }
              // renderTable() is synchronous, so every row-<stage> element
              // exists by this point. Tell the extension host it's now safe
              // to deliver a focusStage request.
              vscode.postMessage({ type: 'rendered' });
            } else if (message.type === 'quotaStatus') {
              quotaStatus = message.quotaStatus || {};
              if (!formDirty) {
                renderTable();
              }
            } else if (message.type === 'focusStage') {
              const row = document.getElementById('row-' + message.stage);
              if (row) {
                row.scrollIntoView({ behavior: 'smooth', block: 'center' });
                row.classList.add('highlighted');
                setTimeout(() => row.classList.remove('highlighted'), 3000);
                const control = message.control === 'backup' ? 'backup' : 'primary';
                const input = document.getElementById(control + '-input-' + message.stage);
                if (input) input.focus();
              }
            }
          });

          // Delegated dirty-tracking: rows in #stages-tbody are rebuilt by
          // renderTable() on every 'init' message, so a single listener on
          // the (static) container catches every current and future row.
          document.getElementById('stages-tbody').addEventListener('input', markDirty);
          document.getElementById('stages-tbody').addEventListener('change', markDirty);
          document.getElementById('stages-tbody').addEventListener('click', event => {
            if (event.target.closest('.add-backup, .remove-backup')) {
              markDirty();
            }
          });

          // Tell the extension host this document's listener is attached
          // and ready to receive "init".
          vscode.postMessage({ type: 'ready' });

          function escapeHtml(value) {
            return String(value ?? '').replace(/[&<>"']/g, ch => ({
              '&': '&amp;',
              '<': '&lt;',
              '>': '&gt;',
              '"': '&quot;',
              "'": '&#39;'
            })[ch]);
          }

          function modelLabel(model) {
            return model ? model.name + ' — ' + model.providerLabel : '';
          }

          function findModelById(id) {
            return availableModels.find(model => model.id === id);
          }

          // Provider prefix of a stored model id ("claude-cli:sonnet" ->
          // "claude-cli"); bare ids are Copilot models (always offered).
          function providerIdOfModelId(id) {
            const sep = (id || '').indexOf(':');
            if (sep <= 0) return 'copilot';
            const prefix = id.slice(0, sep);
            return providers.some(p => p.id === prefix) ? prefix : 'copilot';
          }

          function isProviderChecked(providerId) {
            const provider = providers.find(p => p.id === providerId);
            return provider && provider.enabledByDefault
              ? enabledProviders[providerId] !== false
              : enabledProviders[providerId] === true;
          }

          function isStoredModelProviderDisabled(id) {
            if (!id) return false;
            const providerId = providerIdOfModelId(id);
            // Copilot is enabled unless explicitly disabled; CLI providers
            // are opt-in.
            if (providerId === 'copilot') return enabledProviders['copilot'] === false;
            return enabledProviders[providerId] !== true;
          }

          function modelComboboxHtml(kind, stage, selectedId, disabled) {
            const selectedModel = findModelById(selectedId);
            // A stored selection whose provider is disabled (or that is
            // otherwise unavailable) is preserved byte-for-byte: the hidden
            // input keeps the stored id so saving never destroys it.
            const providerDisabled = !selectedModel && isStoredModelProviderDisabled(selectedId);
            const selectedLabel = selectedModel
              ? modelLabel(selectedModel)
              : selectedId
                ? (providerDisabled ? selectedId + ' (provider disabled)' : 'Unknown model: ' + selectedId)
                : '';
            const hiddenValue = selectedId || '';
            const disabledAttr = disabled ? 'disabled' : '';
            const disabledNote = providerDisabled
              ? '<div class="provider-disabled-note">This model\\'s provider is disabled in Provider Selection above; the stage is treated as unconfigured until the provider is re-enabled or another model is chosen.</div>'
              : '';
            return \`
              <div class="model-combobox" data-kind="\${kind}" data-stage="\${stage}">
                <input type="hidden" id="\${kind}-\${stage}" value="\${escapeHtml(hiddenValue)}">
                <input
                  type="text"
                  id="\${kind}-input-\${stage}"
                  class="model-combo-input"
                  value="\${escapeHtml(selectedLabel)}"
                  placeholder="Search models..."
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded="false"
                  aria-controls="\${kind}-list-\${stage}"
                  \${disabledAttr}
                >
                <div id="\${kind}-list-\${stage}" class="model-options" role="listbox" hidden></div>
                \${disabledNote}
              </div>
            \`;
          }

          function setupModelCombobox(row, kind, stage) {
            const hidden = row.querySelector('#' + CSS.escape(kind + '-' + stage));
            const input = row.querySelector('#' + CSS.escape(kind + '-input-' + stage));
            const list = row.querySelector('#' + CSS.escape(kind + '-list-' + stage));
            if (!hidden || !input || !list) {
              return;
            }

            let activeIndex = -1;

            function getChoices(query) {
              const tokens = query.toLowerCase().match(/[a-z0-9.]+/g) || [];
              const choices = [{ id: '', label: '(None)', searchable: 'none' }].concat(
                availableModels.map(model => ({
                  id: model.id,
                  label: modelLabel(model),
                  searchable: [model.name, model.providerLabel, model.id]
                    .join(' ').replace(/\\[[^\\]]*\\]/g, '').toLowerCase()
                }))
              );
              if (tokens.length === 0) {
                return choices;
              }
              return choices.filter(choice => tokens.every(token => choice.searchable.includes(token)));
            }

            function closeList() {
              list.hidden = true;
              input.setAttribute('aria-expanded', 'false');
              activeIndex = -1;
            }

            function setActiveOption(options, index) {
              options.forEach((option, optionIndex) => {
                option.setAttribute('aria-selected', optionIndex === index ? 'true' : 'false');
              });
              const active = options[index];
              if (active) {
                active.scrollIntoView({ block: 'nearest' });
              }
            }

            function selectValue(id, label) {
              hidden.value = id;
              input.value = id ? label : '';
              closeList();
              markDirty();
            }

            function reconcileExactValue() {
              const typed = input.value.trim().toLowerCase();
              const exact = availableModels.find(model =>
                modelLabel(model).toLowerCase() === typed ||
                model.id.toLowerCase() === typed
              );
              if (exact) {
                selectValue(exact.id, modelLabel(exact));
              } else {
                closeList();
              }
            }

            function renderOptions() {
              const choices = getChoices(input.value);
              if (choices.length === 0) {
                list.innerHTML = '<div class="model-option empty">No models found</div>';
                list.hidden = false;
                input.setAttribute('aria-expanded', 'true');
                return;
              }

              list.innerHTML = choices.map((choice, index) =>
                '<div class="model-option" role="option" aria-selected="' + (index === 0 ? 'true' : 'false') +
                '" data-id="' + escapeHtml(choice.id) + '" data-label="' + escapeHtml(choice.label) + '">' +
                escapeHtml(choice.label) +
                '</div>'
              ).join('');
              activeIndex = 0;
              list.hidden = false;
              input.setAttribute('aria-expanded', 'true');
            }

            input.addEventListener('input', () => {
              hidden.value = '';
              renderOptions();
            });

            input.addEventListener('focus', () => {
              renderOptions();
            });

            input.addEventListener('keydown', event => {
              if (event.key === 'Escape') {
                closeList();
                return;
              }

              const options = Array.from(list.querySelectorAll('.model-option:not(.empty)'));
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (list.hidden) {
                  renderOptions();
                  return;
                }
                if (options.length === 0) {
                  return;
                }
                activeIndex = event.key === 'ArrowDown'
                  ? Math.min(activeIndex + 1, options.length - 1)
                  : Math.max(activeIndex - 1, 0);
                setActiveOption(options, activeIndex);
              } else if (event.key === 'Enter' && !list.hidden) {
                const active = options[activeIndex];
                if (active) {
                  event.preventDefault();
                  selectValue(active.dataset.id || '', active.dataset.label || '');
                }
              }
            });

            list.addEventListener('mousedown', event => {
              const target = event.target instanceof Element ? event.target : event.target.parentElement;
              const option = target ? target.closest('.model-option:not(.empty)') : undefined;
              if (!option) {
                return;
              }
              event.preventDefault();
              selectValue(option.dataset.id || '', option.dataset.label || '');
            });

            input.addEventListener('blur', () => {
              setTimeout(reconcileExactValue, 120);
            });
          }

          function reconcileModelInput(kind, stage) {
            const hidden = document.getElementById(kind + '-' + stage);
            const input = document.getElementById(kind + '-input-' + stage);
            if (!hidden || !input) {
              return '';
            }

            const typed = input.value.trim().toLowerCase();
            const exact = availableModels.find(model =>
              modelLabel(model).toLowerCase() === typed ||
              model.id.toLowerCase() === typed
            );
            if (exact) {
              hidden.value = exact.id;
              input.value = modelLabel(exact);
            }
            return hidden.value;
          }

          // Additional backup models use the SAME combobox control as the
          // primary model (no plain <select> anywhere).
          function addExtraBackupCombobox(row, stage, selectedId) {
            const container = row.querySelector('.extra-backups');
            if (!container || container.children.length >= 9) return;
            const kind = 'backupx' + (++extraBackupSeq);
            const item = document.createElement('div');
            item.className = 'extra-backup';
            item.innerHTML =
              modelComboboxHtml(kind, stage, selectedId || '', false) +
              '<button type="button" class="remove-backup" aria-label="Remove backup">×</button>';
            item.querySelector('.remove-backup').addEventListener('click', () => {
              item.remove();
              syncBackupLimitFor(row);
              markDirty();
            });
            container.appendChild(item);
            setupModelCombobox(item, kind, stage);
            syncBackupLimitFor(row);
          }

          function syncBackupLimitFor(row) {
            const addBackupButton = row.querySelector('.add-backup');
            const backupLimit = row.querySelector('.backup-limit');
            if (!addBackupButton || !backupLimit) return;
            const count = 1 + row.querySelectorAll('.extra-backups .model-combobox').length;
            addBackupButton.disabled = count >= 10;
            addBackupButton.title = count >= 10 ? 'A maximum of 10 backup models is allowed' : '';
            backupLimit.textContent = count + '/10';
          }

          function renderProviderSelection() {
            let container = document.getElementById('provider-selection');
            container.innerHTML =
              '<fieldset><legend>Provider Selection</legend>' +
              providers.map(provider =>
                '<div class="provider-row">' +
                '<label><input type="checkbox" data-provider="' + escapeHtml(provider.id) + '" ' + (isProviderChecked(provider.id) ? 'checked' : '') + '> ' + escapeHtml(provider.label) + '</label>' +
                '<button type="button" class="secondary provider-signin" data-signin-provider="' + escapeHtml(provider.id) + '" title="' + escapeHtml(provider.signInGuidance || 'Runs the provider\\'s login command in a visible terminal') + '">' + escapeHtml(provider.signInLabel || 'Sign in') + '</button>' +
                (provider.usageEnabled
                  ? '<button type="button" class="secondary provider-usage" data-usage-provider="' + escapeHtml(provider.id) + '" title="' + escapeHtml(provider.usageTooltip) + '">Check usage</button>'
                  : '<button type="button" class="secondary provider-usage" disabled title="' + escapeHtml(provider.usageTooltip) + '">Check usage</button>') +
                '</div>'
              ).join('') +
              '<p class="provider-help">Enabled providers determine which models are offered below. Sign-in and usage checks run in a visible terminal; the extension reports them as launched, not as succeeded.</p>' +
              '<div class="btn-container"><button id="save-providers-btn" class="secondary">Save Provider Selection</button></div>' +
              '</fieldset>';
            container.querySelectorAll('[data-signin-provider]').forEach(button => {
              button.addEventListener('click', () => {
                vscode.postMessage({ type: 'providerSignIn', providerId: button.dataset.signinProvider });
              });
            });
            container.querySelectorAll('[data-usage-provider]').forEach(button => {
              button.addEventListener('click', () => {
                vscode.postMessage({ type: 'providerUsage', providerId: button.dataset.usageProvider });
              });
            });
            container.querySelector('#save-providers-btn').addEventListener('click', () => {
              const next = {};
              container.querySelectorAll('[data-provider]').forEach(input => {
                next[input.dataset.provider] = input.checked;
              });
              vscode.postMessage({ type: 'saveProviders', enabledProviders: next });
            });
          }

          function renderTable() {
            const tbody = document.getElementById('stages-tbody');
            tbody.innerHTML = '';

            stagesList.forEach(stage => {
              const setting = currentSettings[stage] || { strategy: 'alert-and-wait' };
              const row = document.createElement('div');
              row.id = 'row-' + stage;
              row.className = 'stage-row';

              const primaryQuotaStatus = quotaStatus[stage + ':primary'] || 'No usage observed yet this session';
              const backupQuotaStatus = quotaStatus[stage + ':backup'] || 'No usage observed yet this session';
              const quotaText = \`<span class="quota-text" title="Session-observed usage status">\${primaryQuotaStatus}</span>\`;
              const backupQuotaText = \`<span class="quota-text" title="Session-observed usage status">\${backupQuotaStatus}</span>\`;

              const backupModels = (setting.backups && setting.backups.length ? setting.backups : (setting.backup ? [setting.backup] : []));

              row.innerHTML = \`
                <h3 class="stage-heading">\${stageDisplayNames[stage] || stage}</h3>
                <div class="form-row">
                  <label for="primary-input-\${stage}" class="field-label">Primary model:</label>
                  \${modelComboboxHtml('primary', stage, setting.primary || '', false)}
                  \${quotaText}
                </div>
                <div class="form-row">
                  <label for="strategy-\${stage}" class="field-label">Fallback strategy:</label>
                  <select id="strategy-\${stage}">
                    <option value="switch-to-backup" \${setting.strategy === 'switch-to-backup' ? 'selected' : ''}>Switch to Backup</option>
                    <option value="pause-and-resume" \${setting.strategy === 'pause-and-resume' ? 'selected' : ''}>Pause until available</option>
                    <option value="alert-and-wait" \${setting.strategy === 'alert-and-wait' ? 'selected' : ''}>Alert and wait</option>
                  </select>
                </div>
                <div class="form-row">
                  <label for="backup-input-\${stage}" class="field-label">Backup models (tried in order):</label>
                  \${modelComboboxHtml('backup', stage, backupModels[0] || '', false)}
                  \${backupQuotaText}
                  <div class="extra-backups"></div>
                  <button type="button" class="add-backup">+ Add another backup</button>
                  <span class="backup-limit">1/10</span>
                </div>
              \`;

              tbody.appendChild(row);
              setupModelCombobox(row, 'primary', stage);
              setupModelCombobox(row, 'backup', stage);

              backupModels.slice(1).forEach(model => addExtraBackupCombobox(row, stage, model));

              row.querySelector('.add-backup').addEventListener('click', () => {
                addExtraBackupCombobox(row, stage, '');
              });
              syncBackupLimitFor(row);
            });
          }

          function collectFormSettings() {
            const updatedSettings = {};
            const errors = [];

            stagesList.forEach(stage => {
              const primary = reconcileModelInput('primary', stage);
              const primaryText = document.getElementById('primary-input-' + stage).value.trim();
              const strategy = document.getElementById('strategy-' + stage).value;
              const usesBackup = strategy === 'switch-to-backup';
              const backup = reconcileModelInput('backup', stage);
              const backupText = document.getElementById('backup-input-' + stage).value.trim();
              const row = document.getElementById('row-' + stage);
              const extraBackups = Array.from(row.querySelectorAll('.extra-backups .model-combobox input[type="hidden"]'))
                .map(input => input.value.trim()).filter(Boolean);

              // A stored id whose provider is disabled resolves to no
              // available model but must be preserved, not flagged invalid.
              const primaryIsPreservedStored = primary && !findModelById(primary);
              if (primaryText && !primary && !primaryIsPreservedStored) {
                errors.push('Stage ' + (stageDisplayNames[stage] || stage) + ' has an invalid primary model selection. Choose a model from the list.');
              }
              const backupIsPreservedStored = backup && !findModelById(backup);
              if (usesBackup && backupText && !backup && !backupIsPreservedStored) {
                errors.push('Stage ' + (stageDisplayNames[stage] || stage) + ' has an invalid backup model selection. Choose a model from the list.');
              }
              if (usesBackup && !backup) {
                errors.push('Stage ' + (stageDisplayNames[stage] || stage) + ' requires a valid backup model when Fallback Strategy is set to Switch to Backup.');
              }

              updatedSettings[stage] = {
                primary: primary || undefined,
                backup: backup || undefined,
                backups: [backup, ...extraBackups].filter(Boolean).slice(0, 10),
                strategy
              };
            });

            return { settings: updatedSettings, errors };
          }

          document.getElementById('save-btn').addEventListener('click', () => {
            const alertRegion = document.getElementById('alert-region');
            alertRegion.innerText = '';
            const collected = collectFormSettings();

            if (collected.errors.length > 0) {
              alertRegion.innerText = collected.errors.join('\\n');
              vscode.postMessage({ type: 'validationError', message: collected.errors.join('\\n') });
              return;
            }

            vscode.postMessage({
              type: 'saveSettings',
              settings: collected.settings
            });

            document.getElementById('status-region').innerText = 'Settings saved successfully.';
            document.getElementById('restored-note-container').innerHTML = '';
            clearDirty();
          });

          // Always-on confirmation for destructive form actions (unlike the
          // suppressible unsaved-changes warning above).
          function confirmDestructiveAction(message, confirmLabel) {
            return new Promise(resolve => {
              const overlay = document.createElement('div');
              overlay.id = 'unsaved-warning-overlay';
              overlay.innerHTML =
                '<div id="unsaved-warning-dialog" role="alertdialog" aria-modal="true">' +
                '<p><strong>' + escapeHtml(message) + '</strong></p>' +
                '<div class="btn-container">' +
                '<button id="destructive-confirm">' + escapeHtml(confirmLabel) + '</button>' +
                '<button id="destructive-cancel" class="secondary">Cancel</button>' +
                '</div></div>';
              document.body.appendChild(overlay);
              const opener = document.activeElement;
              const finish = (proceed) => {
                overlay.remove();
                if (opener instanceof HTMLElement) opener.focus();
                resolve(proceed);
              };
              overlay.querySelector('#destructive-confirm').addEventListener('click', () => finish(true));
              overlay.querySelector('#destructive-cancel').addEventListener('click', () => finish(false));
              overlay.addEventListener('keydown', event => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  finish(false);
                }
              });
              overlay.querySelector('#destructive-cancel').focus();
            });
          }

          document.getElementById('reset-btn').addEventListener('click', async () => {
            // Reset repopulates the form with empty settings. It always asks
            // for confirmation (it discards the current selections, saved or
            // not); nothing is persisted until Save Settings is clicked.
            const proceed = await confirmDestructiveAction(
              'Are you sure you want to reset all model settings to their defaults? Your current selections will be cleared (nothing is saved until you click Save Settings).',
              'Reset to Defaults'
            );
            if (!proceed) return;
            currentSettings = {};
            renderTable();
            markDirty();
          });
        </script>
      </body>
      </html>`;
  }
}

function getNonce() {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
