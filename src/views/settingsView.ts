import * as vscode from "vscode";
import { AI_MODEL_STAGES, STAGE_DISPLAY_NAMES, TaskStage } from "../types/taskProgress";
import {
  clearTaskStageModels,
  findTaskModelConflicts,
  getAvailableModels,
} from "../utils/modelSelection";
import { getModelSettings, setModelSettings } from "../config/settings";
import { ModelSettings } from "../utils/modelFallback";
import { getQuotaStatusText } from "../utils/quota";
import { cliDisplayLabel, CLI_PROVIDERS } from "../runners/providers";
import { testCliProviderSetup } from "../runners/cliAgentRunner";

type IncomingMessage =
  | { type: "ready" }
  | { type: "rendered" }
  | { type: "saveSettings"; settings: ModelSettings }
  | { type: "saveWorkspaceSettings"; settings: WorkspaceSettings }
  | { type: "validationError"; message: string }
  | { type: "resetDefaults" }
  | { type: "refreshQuotaStatus" }
  | { type: "testProviderSetup"; providerId: string };

interface WorkspaceSettings {
  metaFilesHidden: boolean;
  enabledProviders: Record<string, boolean>;
  fastForwardMaxIterations: number;
  autoAdvanceEnabled: boolean;
  autoAdvanceScoreThreshold: number;
  fastForwardStopLevel: number;
  fastForwardUseAcceptanceThreshold: boolean;
  autoReviewAfterPlan: boolean;
  autoReviewAfterImplementation: boolean;
  allowDirtyWorktreeChanges: boolean;
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
          // again. Posting "init" eagerly (right after setting .html, as
          // this used to do) races that fresh document's script load: if
          // getAvailableModels() resolves first — it's cache-backed (see
          // cliAgentRunner's commandExistsCache), so it can return near-
          // instantly on the 2nd+ open — the message is posted before the
          // webview's listener exists and is silently dropped, leaving the
          // panel permanently blank. Waiting for the webview to announce
          // it's ready avoids that race regardless of timing.
          await this._postInit(webviewView.webview);
          break;
        }
        case "rendered": {
          // Distinct from "ready": this fires only after the webview has
          // actually built its table rows from the "init" payload (see the
          // 'init' handler in the webview script below), which is what
          // focusStage() needs (it looks up 'row-' + stage in the DOM).
          // Gating on "ready" alone would have a window — after the webview
          // is listening but before getAvailableModels() resolves and the
          // rows exist — where a focusStage() posted immediately would
          // reach a live listener that still finds no matching row and
          // silently drops the request.
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
          void vscode.window.showInformationMessage("AI model settings saved.");
          break;
        }
        case "validationError": {
          void vscode.window.showErrorMessage(data.message);
          break;
        }
        case "saveWorkspaceSettings": {
          // Only touch the .gitignore when the checkbox actually changed —
          // otherwise every workflow-settings save re-runs the hide/show
          // command, which (since there's nothing to write) skips its own
          // confirmation prompt but still fires a spurious "meta files are
          // now hidden/visible" status entry even though nothing changed.
          const previousMetaFilesHidden = vscode.workspace
            .getConfiguration("vs-code-ai-helper")
            .get<boolean>("metaFilesHidden", false);
          if (data.settings.metaFilesHidden !== previousMetaFilesHidden) {
            // Run the .gitignore change first — it prompts the user for
            // confirmation with an exact diff — and abort the whole save with
            // no writes if they decline, rather than silently saving the rest
            // of the workflow settings while the meta-visibility change is
            // dropped.
            const metaChangeApplied = await vscode.commands.executeCommand<boolean>(
              data.settings.metaFilesHidden
                ? "vs-code-ai-helper.hideMetaResourcesInGitIgnore"
                : "vs-code-ai-helper.showMetaResourcesInGitIgnore"
            );
            if (metaChangeApplied === false) {
              void vscode.window.showWarningMessage(
                "Workflow settings were not saved: the .gitignore update was declined."
              );
              break;
            }
          }

          const config = vscode.workspace.getConfiguration("vs-code-ai-helper");
          for (const [key, value] of Object.entries(data.settings)) {
            // Meta visibility is backed by the managed .gitignore block,
            // which the command above already updated atomically along with
            // the UI mirror (see setMetaFilesHidden in that command).
            if (key === "metaFilesHidden") {
              continue;
            }
            await config.update(key, value, vscode.ConfigurationTarget.Workspace);
          }
          void vscode.window.showInformationMessage("Workflow settings saved.");
          break;
        }
        case "resetDefaults": {
          const confirm = await vscode.window.showWarningMessage(
            "Are you sure you want to reset all model settings to defaults?",
            { modal: true },
            "Reset"
          );
          if (confirm === "Reset") {
            const emptySettings: ModelSettings = {};
            await setModelSettings(emptySettings);
            void webviewView.webview.postMessage({ type: "settingsLoaded", settings: emptySettings });
            void vscode.window.showInformationMessage("Model settings reset to defaults.");
          }
          break;
        }
        case "refreshQuotaStatus": {
          void webviewView.webview.postMessage({ type: "quotaStatus", quotaStatus: this._buildQuotaStatus() });
          break;
        }
        case "testProviderSetup": {
          const provider = CLI_PROVIDERS.find((candidate) => candidate.id === data.providerId);
          if (!provider) {
            return;
          }
          const status = await testCliProviderSetup(provider);
          void webviewView.webview.postMessage({
            type: "providerSetupStatus",
            providerId: provider.id,
            available: status.installed && status.authenticated === true,
            message: !status.installed
              ? `${cliDisplayLabel(provider)} CLI was not found. ${provider.installHint}`
              : status.authenticated === false
                ? `${cliDisplayLabel(provider)} CLI is installed but not authenticated. ${provider.loginHint}`
                : `${cliDisplayLabel(provider)} CLI is installed. Authentication cannot be checked without sending a model request.`,
          });
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

    // resolveWebviewView runs on every reveal after this panel was
    // collapsed, not just once per session (see the "ready" case above) —
    // guard with _conflictsChecked so this prompt is a true one-shot,
    // otherwise a user who picks "Keep Existing" would be re-asked every
    // time they reopen the panel.
    if (!this._conflictsChecked) {
      this._conflictsChecked = true;
      void this._checkModelSettingsConflicts();
    }
  }

  /**
   * Send the current settings/models/quota snapshot to the webview. Only
   * called once the webview confirms via "ready" that its script has loaded
   * and attached a message listener — see the "ready" case above for why
   * posting this eagerly right after resolve is unsafe.
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
      workspaceSettings: this._getWorkspaceSettings(),
      providers: CLI_PROVIDERS.map((provider) => ({ id: provider.id, label: provider.label })),
    });
  }

  private _getWorkspaceSettings(): WorkspaceSettings {
    const config = vscode.workspace.getConfiguration("vs-code-ai-helper");
    return {
      // The .gitignore block is read asynchronously by the command.  This
      // persisted value is a display preference only, never used to infer
      // visibility or invert a toggle.
      metaFilesHidden: config.get<boolean>("metaFilesHidden", false),
      enabledProviders: config.get<Record<string, boolean>>("enabledProviders", {}),
      fastForwardMaxIterations: config.get<number>("fastForwardMaxIterations", 5),
      autoAdvanceEnabled: config.get<boolean>("autoAdvanceEnabled", false),
      autoAdvanceScoreThreshold: config.get<number>("autoAdvanceScoreThreshold", 10),
      fastForwardStopLevel: config.get<number>("fastForwardStopLevel", 0),
      fastForwardUseAcceptanceThreshold: config.get<boolean>("fastForwardUseAcceptanceThreshold", false),
      autoReviewAfterPlan: config.get<boolean>("autoReviewAfterPlan", false),
      autoReviewAfterImplementation: config.get<boolean>("autoReviewAfterImplementation", false),
      allowDirtyWorktreeChanges: config.get<boolean>("allowDirtyWorktreeChanges", false),
    };
  }

  /**
   * Leftover per-task model override files (see utils/modelSelection.ts —
   * findTaskModelConflicts) are inert now that model configuration lives
   * only in this Settings panel. Surface them once so the user can clear
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
        "configuration moved to this Settings panel. They are no longer used — the settings " +
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
      // current document is still mid-init (webview loaded and listening,
      // but getAvailableModels() hasn't resolved and the rows the webview
      // needs to look up don't exist yet). Queue the request so it's
      // delivered once "rendered" confirms the rows actually exist, instead
      // of racing a postMessage that the webview would silently no-op.
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
        <title>Ensemble Settings</title>
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
          .model-provider-filter {
            display: block;
            width: 100%;
            margin-bottom: 4px;
            font-size: 0.9em;
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
          .btn-container {
            display: flex;
            gap: 10px;
            margin-top: 15px;
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
          .tooltip {
            position: relative;
            display: inline-block;
            cursor: help;
            color: var(--vscode-descriptionForeground);
          }
        </style>
      </head>
      <body>
        <h2 style="font-size: 1.2em; margin-bottom: 10px;">Model Configuration</h2>
        <div role="status" aria-live="polite" id="status-region" style="position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); border: 0;"></div>
        <div role="alert" aria-live="assertive" id="alert-region" style="position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); border: 0;"></div>
        
        <table id="settings-table">
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

        <div class="btn-container">
          <button id="save-btn">Save Settings</button>
          <button id="reset-btn" class="secondary">Reset to Defaults</button>
        </div>

        <h2 style="font-size: 1.2em; margin: 28px 0 10px;">Workflow Settings</h2>
        <p style="color: var(--vscode-descriptionForeground);">These settings apply to this workspace, not an individual task.</p>
        <div id="workflow-settings"></div>
        <div class="btn-container"><button id="save-workflow-btn">Save Workflow Settings</button></div>

        <script nonce="${nonce}">
          const vscode = acquireVsCodeApi();
          let currentSettings = {};
          let availableModels = [];
          let stagesList = [];
          let stageDisplayNames = {};
          let quotaStatus = {};
          let workspaceSettings = {};
          let providers = [];

          window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'init') {
              currentSettings = message.settings || {};
              availableModels = message.models || [];
              stagesList = message.stages || [];
              stageDisplayNames = message.stageNames || {};
              quotaStatus = message.quotaStatus || {};
              workspaceSettings = message.workspaceSettings || {};
              providers = message.providers || [];
              renderTable();
              renderWorkflowSettings();
              // renderTable() is synchronous, so every row-<stage> element
              // exists by this point. Tell the extension host it's now safe
              // to deliver a focusStage request (see the "rendered" case in
              // resolveWebviewView) instead of it guessing from "ready"
              // alone, which only means this listener is attached.
              vscode.postMessage({ type: 'rendered' });
            } else if (message.type === 'settingsLoaded') {
              currentSettings = message.settings || {};
              renderTable();
            } else if (message.type === 'quotaStatus') {
              quotaStatus = message.quotaStatus || {};
              renderTable();
            } else if (message.type === 'providerSetupStatus') {
              const status = document.getElementById('provider-status-' + message.providerId);
              if (status) {
                status.textContent = message.available ? '✓' : '✗';
                status.title = message.message || '';
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

          // Tell the extension host this document's listener is attached
          // and ready to receive "init". Posting "init" eagerly on resolve
          // (instead of waiting for this) would race this script's load.
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
            // Availability/provider metadata belongs last and in brackets so
            // the model name remains scannable and bracket text can be ignored
            // by search ranking.
            return model ? model.name + ' — ' + model.providerLabel : '';
          }

          function findModelById(id) {
            return availableModels.find(model => model.id === id);
          }

          function providerLabelsInUse() {
            // Providers are derived from the models actually on offer, so
            // the filter always matches what's selectable and needs no
            // separate provider registry (which excludes Copilot).
            const seen = [];
            availableModels.forEach(model => {
              if (!seen.includes(model.providerLabel)) seen.push(model.providerLabel);
            });
            return seen;
          }

          function modelComboboxHtml(kind, stage, selectedId, disabled) {
            const selectedModel = findModelById(selectedId);
            const selectedLabel = selectedModel
              ? modelLabel(selectedModel)
              : selectedId
                ? 'Unknown model: ' + selectedId
                : '';
            const hiddenValue = selectedModel ? selectedId : '';
            const disabledAttr = disabled ? 'disabled' : '';
            // Provider acts as a filter for the model list below it, so it is
            // selected first and narrows what the search/dropdown shows.
            // Pre-select the current model's provider so switching back to
            // "All Providers" is an explicit, visible action rather than the
            // default state hiding the already-configured model's provider.
            const providerOptions = ['All Providers'].concat(providerLabelsInUse());
            const selectedProviderLabel = selectedModel ? selectedModel.providerLabel : 'All Providers';
            return \`
              <div class="model-combobox" data-kind="\${kind}" data-stage="\${stage}">
                <select class="model-provider-filter" id="\${kind}-provider-\${stage}" aria-label="Filter models by provider" \${disabledAttr}>
                  \${providerOptions.map(label => '<option value="' + escapeHtml(label) + '" ' + (label === selectedProviderLabel ? 'selected' : '') + '>' + escapeHtml(label) + '</option>').join('')}
                </select>
                <input type="hidden" id="\${kind}-\${stage}" value="\${escapeHtml(hiddenValue || '')}">
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
              </div>
            \`;
          }

          function setupModelCombobox(row, kind, stage) {
            const hidden = row.querySelector('#' + kind + '-' + stage);
            const input = row.querySelector('#' + kind + '-input-' + stage);
            const list = row.querySelector('#' + kind + '-list-' + stage);
            const providerFilter = row.querySelector('#' + kind + '-provider-' + stage);
            if (!hidden || !input || !list) {
              return;
            }

            let activeIndex = -1;

            function getChoices(query) {
              const tokens = query.toLowerCase().match(/[a-z0-9.]+/g) || [];
              const providerValue = providerFilter ? providerFilter.value : 'All Providers';
              const modelsForProvider = providerValue === 'All Providers'
                ? availableModels
                : availableModels.filter(model => model.providerLabel === providerValue);
              const choices = [{ id: '', label: '(None)', searchable: 'none' }].concat(
                modelsForProvider.map(model => ({
                  id: model.id,
                  label: modelLabel(model),
                  // Plans/availability are rendered in brackets by providers;
                  // they should never make a model match a query.
                  searchable: [model.name, model.providerLabel, model.id]
                    .join(' ').replace(/\\[[^\\]]*\\]/g, '').toLowerCase()
                }))
              );
              if (tokens.length === 0) {
                return choices;
              }
              return choices.filter(choice => tokens.every(token => choice.searchable.includes(token)));
            }

            if (providerFilter) {
              providerFilter.addEventListener('change', () => {
                renderOptions();
                input.focus();
              });
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

          function renderTable() {
            const tbody = document.getElementById('stages-tbody');
            tbody.innerHTML = '';

            stagesList.forEach(stage => {
              const setting = currentSettings[stage] || { strategy: 'alert-and-wait' };
              const row = document.createElement('tr');
              row.id = 'row-' + stage;
              row.className = 'stage-row';

              // Quota telemetry is session-observed only (see utils/quota.ts):
              // no provider exposes a numeric "percent remaining", so this
              // shows what the last run for this stage+model actually
              // reported instead of ever fabricating a number.
              const primaryQuotaStatus = quotaStatus[stage + ':primary'] || 'No usage observed yet this session';
              const backupQuotaStatus = quotaStatus[stage + ':backup'] || 'No usage observed yet this session';
              const quotaText = \`<span class="quota-text tooltip" title="Session-observed usage status">\${primaryQuotaStatus}</span>\`;
              const backupQuotaText = \`<span class="quota-text tooltip" title="Session-observed usage status">\${backupQuotaStatus}</span>\`;

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
                    <div class="extra-backups">\${backupModels.slice(1).map(model => '<div style="display:flex;gap:4px;margin-top:4px"><select class="backup-extra" aria-label="Additional backup model">' + availableModels.map(candidate => '<option value="' + escapeHtml(candidate.id) + '" ' + (candidate.id === model ? 'selected' : '') + '>' + escapeHtml(modelLabel(candidate)) + '</option>').join('') + '</select><button type="button" class="remove-backup" aria-label="Remove backup">×</button></div>').join('')}</div>
                    <button type="button" class="add-backup" style="margin-top:4px" \${backupModels.length >= 10 ? 'disabled title="A maximum of 10 backup models is allowed"' : ''}>+ Add another backup</button>
                    <span class="backup-limit" style="margin-left:4px;font-size:0.9em">\${backupModels.length}/10</span>
                  </div>
                </td>
              \`;

              tbody.appendChild(row);
              setupModelCombobox(row, 'primary', stage);
              setupModelCombobox(row, 'backup', stage);

              const addBackupButton = row.querySelector('.add-backup');
              const backupLimit = row.querySelector('.backup-limit');
              const syncBackupLimit = () => {
                const count = 1 + row.querySelectorAll('.backup-extra').length;
                addBackupButton.disabled = count >= 10;
                addBackupButton.title = count >= 10 ? 'A maximum of 10 backup models is allowed' : '';
                backupLimit.textContent = count + '/10';
              };
              addBackupButton.addEventListener('click', () => {
                const container = row.querySelector('.extra-backups');
                if (container.children.length >= 9) return;
                const item = document.createElement('div');
                item.style.cssText = 'display:flex;gap:4px;margin-top:4px';
                item.innerHTML = '<select class="backup-extra" aria-label="Additional backup model">' + availableModels.map(model => '<option value="' + escapeHtml(model.id) + '">' + escapeHtml(modelLabel(model)) + '</option>').join('') + '</select><button type="button" class="remove-backup" aria-label="Remove backup">×</button>';
                item.querySelector('.remove-backup').addEventListener('click', () => {
                  item.remove();
                  syncBackupLimit();
                });
                container.appendChild(item);
                syncBackupLimit();
              });
              row.querySelectorAll('.remove-backup').forEach(button => button.addEventListener('click', () => {
                button.parentElement.remove();
                syncBackupLimit();
              }));
              syncBackupLimit();
            });
          }

          function checked(value) { return value ? 'checked' : ''; }
          function renderWorkflowSettings() {
            const container = document.getElementById('workflow-settings');
            const enabled = workspaceSettings.enabledProviders || {};
            container.innerHTML =
              '<fieldset><legend>Meta-file visibility</legend>' +
              '<label><input id="meta-files-hidden" type="checkbox" ' + checked(workspaceSettings.metaFilesHidden) + '> Hide Ensemble meta resources from Git</label></fieldset>' +
              '<fieldset style="margin-top:12px"><legend>Provider Selection</legend>' +
              providers.map(provider => '<div style="margin:4px 0"><label><input type="checkbox" data-provider="' + escapeHtml(provider.id) + '" ' + checked(enabled[provider.id] === true) + '> ' + escapeHtml(provider.label) + '</label> <button type="button" class="test-provider" data-test-provider="' + escapeHtml(provider.id) + '">Test Setup</button> <span id="provider-status-' + escapeHtml(provider.id) + '" aria-live="polite">?</span></div>').join('') +
              '<p style="margin:8px 0 0;font-size:0.9em">Usage status is session-observed; providers do not expose a live numeric quota through these checks.</p></fieldset>' +
              '<fieldset style="margin-top:12px"><legend>Fast Forward Review</legend>' +
              '<label>Maximum iterations (1–99): <input id="fast-forward-max" type="number" min="1" max="99" value="' + escapeHtml(workspaceSettings.fastForwardMaxIterations || 5) + '"></label><br>' +
              '<label>Target score (0 = stop after any improvement): <input id="fast-forward-stop" type="number" min="0" max="10" value="' + escapeHtml(workspaceSettings.fastForwardStopLevel || 0) + '"></label><br><p style="margin:6px 0;font-size:0.9em">Fast Forward always continues until the score improves by at least one point from where it started, even when the target is already met.</p>' +
              '<label><input id="fast-forward-acceptance" type="checkbox" ' + checked(workspaceSettings.fastForwardUseAcceptanceThreshold) + '> Use the auto-advance acceptance threshold instead of target score</label></fieldset>' +
              '<fieldset style="margin-top:12px"><legend>Auto-advance and review</legend>' +
              '<label><input id="auto-advance-enabled" type="checkbox" ' + checked(workspaceSettings.autoAdvanceEnabled) + '> Advance after a review reaches this score</label> ' +
              '<input id="auto-advance-score" type="number" min="1" max="10" value="' + escapeHtml(workspaceSettings.autoAdvanceScoreThreshold || 10) + '"><br>' +
              '<label><input id="auto-review-plan" type="checkbox" ' + checked(workspaceSettings.autoReviewAfterPlan) + '> Start review after AI drafts a plan</label><br>' +
              '<label><input id="auto-review-implementation" type="checkbox" ' + checked(workspaceSettings.autoReviewAfterImplementation) + '> Start review after AI completes implementation</label></fieldset>' +
              '<fieldset style="margin-top:12px"><legend>Uncommitted changes</legend>' +
              '<label><input id="allow-dirty-worktree" type="checkbox" ' + checked(workspaceSettings.allowDirtyWorktreeChanges) + '> Always proceed with implementation/Fast Forward runs even when the workspace has unrelated uncommitted changes</label>' +
              '<p style="margin:6px 0 0;font-size:0.9em">When off, you will be warned and asked to confirm before an AI run edits files while unrelated changes are uncommitted.</p></fieldset>';
            const acceptance = document.getElementById('fast-forward-acceptance');
            const target = document.getElementById('fast-forward-stop');
            function syncAcceptance() { target.disabled = acceptance.checked; }
            acceptance.addEventListener('change', syncAcceptance);
            syncAcceptance();
            container.querySelectorAll('[data-test-provider]').forEach(button => {
              button.addEventListener('click', () => {
                const providerId = button.dataset.testProvider;
                const status = document.getElementById('provider-status-' + providerId);
                if (status) status.textContent = '…';
                vscode.postMessage({ type: 'testProviderSetup', providerId });
              });
            });
          }

          document.getElementById('save-btn').addEventListener('click', () => {
            const updatedSettings = {};
            let hasErrors = false;
            const alertRegion = document.getElementById('alert-region');
            alertRegion.innerText = '';

            stagesList.forEach(stage => {
              const primary = reconcileModelInput('primary', stage);
              const primaryText = document.getElementById('primary-input-' + stage).value.trim();
              const strategy = document.getElementById('strategy-' + stage).value;
              const usesBackup = strategy === 'switch-to-backup';
              const backup = reconcileModelInput('backup', stage);
              const backupText = document.getElementById('backup-input-' + stage).value.trim();
              const extraBackups = Array.from(document.querySelectorAll('#row-' + stage + ' .backup-extra')).map(input => input.value.trim()).filter(Boolean);

              if (primaryText && !primary) {
                hasErrors = true;
                alertRegion.innerText += 'Stage ' + (stageDisplayNames[stage] || stage) + ' has an invalid primary model selection. Choose a model from the list.\\n';
              }

              if (usesBackup && backupText && !backup) {
                hasErrors = true;
                alertRegion.innerText += 'Stage ' + (stageDisplayNames[stage] || stage) + ' has an invalid backup model selection. Choose a model from the list.\\n';
              }

              if (usesBackup && !backup) {
                hasErrors = true;
                alertRegion.innerText += 'Stage ' + (stageDisplayNames[stage] || stage) + ' requires a valid backup model when Fallback Strategy is set to Switch to Backup.\\n';
              }
              if (usesBackup && extraBackups.some(candidate => !availableModels.some(model => model.id === candidate))) {
                hasErrors = true;
                alertRegion.innerText += 'Stage ' + (stageDisplayNames[stage] || stage) + ' has an invalid additional backup model selection.\\n';
              }

              updatedSettings[stage] = {
                primary: primary || undefined,
                backup: backup || undefined,
                backups: [backup, ...extraBackups].filter(Boolean).slice(0, 10),
                strategy
              };
            });

            if (hasErrors) {
              vscode.postMessage({ type: 'validationError', message: alertRegion.innerText.trim() });
              return;
            }

            vscode.postMessage({
              type: 'saveSettings',
              settings: updatedSettings
            });
            
            document.getElementById('status-region').innerText = 'Settings saved successfully.';
          });

          document.getElementById('reset-btn').addEventListener('click', () => {
            vscode.postMessage({ type: 'resetDefaults' });
          });

          document.getElementById('save-workflow-btn').addEventListener('click', () => {
            const enabledProviders = {};
            document.querySelectorAll('[data-provider]').forEach(input => {
              enabledProviders[input.dataset.provider] = input.checked;
            });
            const clamp = (id, min, max, fallback) => {
              const value = Number(document.getElementById(id).value);
              return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
            };
            vscode.postMessage({ type: 'saveWorkspaceSettings', settings: {
              metaFilesHidden: document.getElementById('meta-files-hidden').checked,
              enabledProviders,
              fastForwardMaxIterations: clamp('fast-forward-max', 1, 99, 5),
              fastForwardStopLevel: clamp('fast-forward-stop', 0, 10, 0),
              fastForwardUseAcceptanceThreshold: document.getElementById('fast-forward-acceptance').checked,
              autoAdvanceEnabled: document.getElementById('auto-advance-enabled').checked,
              autoAdvanceScoreThreshold: clamp('auto-advance-score', 1, 10, 10),
              autoReviewAfterPlan: document.getElementById('auto-review-plan').checked,
              autoReviewAfterImplementation: document.getElementById('auto-review-implementation').checked,
              allowDirtyWorktreeChanges: document.getElementById('allow-dirty-worktree').checked
            }});
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
