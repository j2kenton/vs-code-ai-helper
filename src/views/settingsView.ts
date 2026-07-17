import * as vscode from "vscode";
import { AI_MODEL_STAGES, STAGE_DISPLAY_NAMES, TaskStage } from "../types/taskProgress";
import {
  clearTaskStageModels,
  findTaskModelConflicts,
  getAvailableModels,
} from "../utils/modelSelection";
import {
  getModelSettings,
  isUnsavedSettingsWarningEnabled,
  setModelSettings,
  setUnsavedSettingsWarningEnabled,
  targetFor,
} from "../config/settings";
import { ModelSettings } from "../utils/modelFallback";
import { getQuotaStatusText } from "../utils/quota";
import { cliDisplayLabel, CLI_PROVIDERS } from "../runners/providers";
import { NotificationRouter } from "../utils/notificationRouter";

type IncomingMessage =
  | { type: "ready" }
  | { type: "rendered" }
  | { type: "saveSettings"; settings: ModelSettings }
  | { type: "saveProviders"; enabledProviders: Record<string, boolean> }
  | { type: "validationError"; message: string }
  | { type: "refreshQuotaStatus" }
  | { type: "providerSignIn"; providerId: string }
  | { type: "suppressUnsavedWarning" };

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
          const config = vscode.workspace.getConfiguration("vs-code-ai-helper");
          await config.update("enabledProviders", data.enabledProviders, targetFor("enabledProviders"));
          NotificationRouter.showInformation("Provider selection saved.");
          break;
        }
        case "refreshQuotaStatus": {
          void webviewView.webview.postMessage({ type: "quotaStatus", quotaStatus: this._buildQuotaStatus() });
          break;
        }
        case "providerSignIn": {
          const provider = CLI_PROVIDERS.find((candidate) => candidate.id === data.providerId);
          if (!provider) {
            return;
          }
          // Run the interactive login/switch-account flow in a VISIBLE IDE
          // terminal. The extension reports the terminal as launched — it
          // never claims the sign-in succeeded; any post-hoc status comes
          // from the next model-discovery pass.
          try {
            const terminal = vscode.window.createTerminal({
              name: `Ensemble Sign-in (${cliDisplayLabel(provider)})`,
            });
            terminal.show();
            terminal.sendText(provider.signInCommand, true);
            NotificationRouter.showInformation(
              `${cliDisplayLabel(provider)} sign-in launched in the terminal. ` +
                (provider.signInGuidance ?? "Complete the sign-in there.")
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(
              `Could not open a terminal for the ${cliDisplayLabel(provider)} sign-in: ${message}`
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
      if (webviewView.visible && event.affectsConfiguration("vs-code-ai-helper")) {
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
      enabledProviders: vscode.workspace
        .getConfiguration("vs-code-ai-helper")
        .get<Record<string, boolean>>("enabledProviders", {}),
      providers: CLI_PROVIDERS.map((provider) => ({
        id: provider.id,
        label: provider.label,
        signInLabel: provider.signInLabel,
        signInGuidance: provider.signInGuidance ?? "",
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
          body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            padding: 10px;
            background-color: var(--vscode-editor-background);
          }
          table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 20px;
          }
          th, td {
            text-align: left;
            padding: 8px 4px;
            border-bottom: 1px solid var(--vscode-widget-border);
            vertical-align: middle;
          }
          th {
            font-weight: bold;
          }
          select, input[type="text"] {
            width: 100%;
            background-color: var(--vscode-input-background, var(--vscode-editor-background));
            color: var(--vscode-input-foreground, var(--vscode-foreground));
            border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
            padding: 4px;
            border-radius: 2px;
            box-sizing: border-box;
          }
          select:focus, input[type="text"]:focus {
            outline: 1px solid var(--vscode-focusBorder);
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
            top: calc(100% + 2px);
            z-index: 10;
            max-height: 220px;
            overflow-y: auto;
            background-color: var(--vscode-dropdown-background, var(--vscode-editorWidget-background, var(--vscode-editor-background)));
            color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
            border: 1px solid var(--vscode-dropdown-border, var(--vscode-widget-border));
            box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.35));
          }
          .model-option {
            padding: 5px 7px;
            cursor: pointer;
            white-space: normal;
            overflow-wrap: anywhere;
          }
          .model-option[aria-selected="true"],
          .model-option:hover {
            background-color: var(--vscode-list-hoverBackground, var(--vscode-list-activeSelectionBackground, rgba(127, 127, 127, 0.25)));
            color: var(--vscode-list-hoverForeground, var(--vscode-list-activeSelectionForeground, var(--vscode-foreground)));
          }
          .model-option.empty {
            color: var(--vscode-descriptionForeground);
            cursor: default;
          }
          .quota-text {
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
            margin-top: 2px;
          }
          .provider-disabled-note {
            font-size: 0.85em;
            color: var(--vscode-errorForeground, #f48771);
            margin-top: 2px;
          }
          .btn-container {
            display: flex;
            gap: 10px;
            margin-top: 15px;
          }
          #loading-indicator {
            color: var(--vscode-descriptionForeground);
            padding: 12px 0;
          }
          button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 12px;
            cursor: pointer;
            border-radius: 2px;
          }
          button:hover {
            background-color: var(--vscode-button-hoverBackground);
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
          .stage-row.highlighted {
            background-color: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.3));
          }
          #unsaved-warning-overlay {
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.45);
            z-index: 50;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          #unsaved-warning-dialog {
            background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
            border: 1px solid var(--vscode-widget-border);
            box-shadow: 0 4px 16px var(--vscode-widget-shadow, rgba(0,0,0,0.5));
            padding: 16px;
            max-width: 420px;
          }
          .restored-note {
            background: var(--vscode-inputValidation-infoBackground, rgba(64,128,255,0.15));
            border: 1px solid var(--vscode-inputValidation-infoBorder, rgba(64,128,255,0.4));
            padding: 6px 8px;
            margin: 8px 0;
            font-size: 0.9em;
          }
        </style>
      </head>
      <body>
        <h2 style="font-size: 1.2em; margin-bottom: 10px;">AI Models</h2>
        <div role="status" aria-live="polite" id="status-region" style="position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); border: 0;"></div>
        <div role="alert" aria-live="assertive" id="alert-region" style="position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); border: 0;"></div>

        <div id="loading-indicator">Loading settings…</div>

        <!-- Provider selection: the single source of truth for which
             providers' models are offered in every combo box below. -->
        <div id="provider-selection"></div>

        <div id="restored-note-container"></div>

        <table id="settings-table" hidden>
          <thead>
            <tr>
              <th scope="col">Stage</th>
              <th scope="col">Models &amp; Fallbacks</th>
            </tr>
          </thead>
          <tbody id="stages-tbody">
            <!-- Will be populated dynamically -->
          </tbody>
        </table>

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
                '<label style="display:block;margin:10px 0"><input type="checkbox" id="unsaved-dont-show"> Don\\'t show again</label>' +
                '<div class="btn-container">' +
                '<button id="unsaved-discard">Discard Changes</button>' +
                '<button id="unsaved-keep" class="secondary">Keep Editing</button>' +
                '</div></div>';
              document.body.appendChild(overlay);
              const finish = (proceed) => {
                const dontShow = overlay.querySelector('#unsaved-dont-show').checked;
                if (dontShow) {
                  warnUnsavedSettings = false;
                  vscode.postMessage({ type: 'suppressUnsavedWarning' });
                }
                overlay.remove();
                resolve(proceed);
              };
              overlay.querySelector('#unsaved-discard').addEventListener('click', () => finish(true));
              overlay.querySelector('#unsaved-keep').addEventListener('click', () => finish(false));
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

          function isStoredModelProviderDisabled(id) {
            if (!id) return false;
            const providerId = providerIdOfModelId(id);
            if (providerId === 'copilot') return false;
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
            item.style.cssText = 'display:flex;gap:4px;margin-top:4px;align-items:flex-start';
            item.innerHTML =
              '<div style="flex:1">' + modelComboboxHtml(kind, stage, selectedId || '', false) + '</div>' +
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
                '<div style="margin:4px 0;display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
                '<label><input type="checkbox" data-provider="' + escapeHtml(provider.id) + '" ' + (enabledProviders[provider.id] === true ? 'checked' : '') + '> ' + escapeHtml(provider.label) + '</label>' +
                '<button type="button" class="secondary provider-signin" data-signin-provider="' + escapeHtml(provider.id) + '" title="' + escapeHtml(provider.signInGuidance || 'Runs the provider\\'s login command in a visible terminal') + '">' + escapeHtml(provider.signInLabel || 'Sign in') + '</button>' +
                '</div>'
              ).join('') +
              '<p style="margin:8px 0 0;font-size:0.9em">Enabled providers determine which models are offered below. Sign-in runs in a visible terminal; the extension reports it as launched, not as succeeded.</p>' +
              '<div class="btn-container" style="margin-top:8px"><button id="save-providers-btn" class="secondary">Save Provider Selection</button></div>' +
              '</fieldset>';
            container.querySelectorAll('[data-signin-provider]').forEach(button => {
              button.addEventListener('click', () => {
                vscode.postMessage({ type: 'providerSignIn', providerId: button.dataset.signinProvider });
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
              const row = document.createElement('tr');
              row.id = 'row-' + stage;
              row.className = 'stage-row';

              const primaryQuotaStatus = quotaStatus[stage + ':primary'] || 'No usage observed yet this session';
              const backupQuotaStatus = quotaStatus[stage + ':backup'] || 'No usage observed yet this session';
              const quotaText = \`<span class="quota-text" title="Session-observed usage status">\${primaryQuotaStatus}</span>\`;
              const backupQuotaText = \`<span class="quota-text" title="Session-observed usage status">\${backupQuotaStatus}</span>\`;

              const backupModels = (setting.backups && setting.backups.length ? setting.backups : (setting.backup ? [setting.backup] : []));

              row.innerHTML = \`
                <td style="font-weight: bold; width: 35%;">\${stageDisplayNames[stage] || stage}</td>
                <td>
                  <div style="margin-bottom: 8px;">
                    <label for="primary-input-\${stage}" style="font-size: 0.9em; display:block; margin-bottom: 2px;">Primary Model:</label>
                    \${modelComboboxHtml('primary', stage, setting.primary || '', false)}
                    \${quotaText}
                  </div>
                  <div style="margin-bottom: 8px;">
                    <label for="strategy-\${stage}" style="font-size: 0.9em; display:block; margin-bottom: 2px;">Fallback Strategy:</label>
                    <select id="strategy-\${stage}">
                      <option value="switch-to-backup" \${setting.strategy === 'switch-to-backup' ? 'selected' : ''}>Switch to Backup</option>
                      <option value="pause-and-resume" \${setting.strategy === 'pause-and-resume' ? 'selected' : ''}>Pause until available</option>
                      <option value="alert-and-wait" \${setting.strategy === 'alert-and-wait' ? 'selected' : ''}>Alert and wait</option>
                    </select>
                  </div>
                  <div style="margin-bottom: 8px;">
                    <label for="backup-input-\${stage}" style="font-size: 0.9em; display:block; margin-bottom: 2px;">Backup models (tried in order):</label>
                    \${modelComboboxHtml('backup', stage, backupModels[0] || '', false)}
                    \${backupQuotaText}
                    <div class="extra-backups"></div>
                    <button type="button" class="add-backup" style="margin-top:4px">+ Add another backup</button>
                    <span class="backup-limit" style="margin-left:4px;font-size:0.9em">1/10</span>
                  </div>
                </td>
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

          document.getElementById('reset-btn').addEventListener('click', async () => {
            // Reset repopulates the form with empty settings; it is an
            // interceptable discard of any dirty state, so it goes through
            // the unsaved-changes warning first. Nothing is persisted until
            // Save Settings is clicked.
            const proceed = await confirmDiscardUnsaved('Resetting the form');
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
