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

type IncomingMessage =
  | { type: "saveSettings"; settings: ModelSettings }
  | { type: "resetDefaults" }
  | { type: "refreshQuotaStatus" };

export class SettingsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "vs-code-ai-helper.settingsView";
  private _view?: vscode.WebviewView;

  constructor(private readonly extensionUri: vscode.Uri) {}

  public async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data: IncomingMessage) => {
      switch (data.type) {
        case "saveSettings": {
          await setModelSettings(data.settings);
          void vscode.window.showInformationMessage("AI model settings saved.");
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

    // Load initial settings and models
    const settings = getModelSettings();
    const models = await getAvailableModels();

    void webviewView.webview.postMessage({
      type: "init",
      settings,
      models,
      stages: AI_MODEL_STAGES,
      stageNames: STAGE_DISPLAY_NAMES,
      quotaStatus: this._buildQuotaStatus(),
    });

    // One-shot per activation (resolveWebviewView runs once per session, not
    // on every reveal) rather than tied to onDidChangeVisibility — otherwise
    // a user who picks "Keep Existing" would be re-asked every time they
    // reopen the panel.
    void this._checkModelSettingsConflicts();
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
    if (this._view) {
      this._view.show(false);
      void this._view.webview.postMessage({ type: "focusStage", stage, control });
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

        <script nonce="${nonce}">
          const vscode = acquireVsCodeApi();
          let currentSettings = {};
          let availableModels = [];
          let stagesList = [];
          let stageDisplayNames = {};
          let quotaStatus = {};

          window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'init') {
              currentSettings = message.settings || {};
              availableModels = message.models || [];
              stagesList = message.stages || [];
              stageDisplayNames = message.stageNames || {};
              quotaStatus = message.quotaStatus || {};
              renderTable();
            } else if (message.type === 'settingsLoaded') {
              currentSettings = message.settings || {};
              renderTable();
            } else if (message.type === 'quotaStatus') {
              quotaStatus = message.quotaStatus || {};
              renderTable();
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
            return model ? model.name + ' (' + model.providerLabel + ')' : '';
          }

          function findModelById(id) {
            return availableModels.find(model => model.id === id);
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
            return \`
              <div class="model-combobox" data-kind="\${kind}" data-stage="\${stage}">
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
            if (!hidden || !input || !list) {
              return;
            }

            let activeIndex = -1;

            function getChoices(query) {
              const normalized = query.trim().toLowerCase();
              const choices = [{ id: '', label: '(None)', searchable: 'none' }].concat(
                availableModels.map(model => ({
                  id: model.id,
                  label: modelLabel(model),
                  searchable: [model.name, model.providerLabel, model.id].join(' ').toLowerCase()
                }))
              );
              if (!normalized) {
                return choices;
              }
              return choices.filter(choice =>
                choice.label.toLowerCase().includes(normalized) ||
                choice.searchable.includes(normalized)
              );
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
              const setting = currentSettings[stage] || { fallbackEnabled: false, strategy: 'alert-and-wait' };
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

              const fallbackChecked = setting.fallbackEnabled ? 'checked' : '';
              const backupDisabled = setting.fallbackEnabled ? '' : 'disabled';

              row.innerHTML = \`
                <td style="font-weight: bold; width: 35%;">\${stageDisplayNames[stage] || stage}</td>
                <td>
                  <div style="margin-bottom: 8px;">
                    <label for="primary-input-\${stage}" style="font-size: 0.9em; display:block; margin-bottom: 2px;">Primary Model:</label>
                    \${modelComboboxHtml('primary', stage, setting.primary || '', false)}
                    \${quotaText}
                  </div>
                  <div style="margin-bottom: 8px;">
                    <input type="checkbox" id="enable-fallback-\${stage}" \${fallbackChecked}>
                    <label for="enable-fallback-\${stage}">Use Backup Model</label>
                  </div>
                  <div style="margin-bottom: 8px;">
                    <label for="backup-input-\${stage}" style="font-size: 0.9em; display:block; margin-bottom: 2px;">Backup Model:</label>
                    \${modelComboboxHtml('backup', stage, setting.backup || '', backupDisabled)}
                    \${backupDisabled ? '' : backupQuotaText}
                  </div>
                  <div>
                    <label for="strategy-\${stage}" style="font-size: 0.9em; display:block; margin-bottom: 2px;">Fallback Strategy:</label>
                    <select id="strategy-\${stage}">
                      <option value="switch-to-backup" \${setting.strategy === 'switch-to-backup' ? 'selected' : ''}>Switch to Backup</option>
                      <option value="pause-and-resume" \${setting.strategy === 'pause-and-resume' ? 'selected' : ''}>Pause until available</option>
                      <option value="alert-and-wait" \${setting.strategy === 'alert-and-wait' ? 'selected' : ''}>Alert and wait</option>
                    </select>
                  </div>
                </td>
              \`;

              tbody.appendChild(row);
              setupModelCombobox(row, 'primary', stage);
              setupModelCombobox(row, 'backup', stage);

              const checkbox = row.querySelector('#enable-fallback-' + stage);
              const backupInput = row.querySelector('#backup-input-' + stage);
              checkbox.addEventListener('change', () => {
                backupInput.disabled = !checkbox.checked;
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
              const fallbackEnabled = document.getElementById('enable-fallback-' + stage).checked;
              const backup = reconcileModelInput('backup', stage);
              const backupText = document.getElementById('backup-input-' + stage).value.trim();
              const strategy = document.getElementById('strategy-' + stage).value;

              if (primaryText && !primary) {
                hasErrors = true;
                alertRegion.innerText += 'Stage ' + (stageDisplayNames[stage] || stage) + ' has an invalid primary model selection. Choose a model from the list.\\n';
              }

              if (fallbackEnabled && backupText && !backup) {
                hasErrors = true;
                alertRegion.innerText += 'Stage ' + (stageDisplayNames[stage] || stage) + ' has an invalid backup model selection. Choose a model from the list.\\n';
              }

              if (fallbackEnabled && (!backup || backup === primary)) {
                hasErrors = true;
                alertRegion.innerText += 'Stage ' + (stageDisplayNames[stage] || stage) + ' requires a distinct valid backup model when backup is enabled.\\n';
              }

              updatedSettings[stage] = {
                primary: primary || undefined,
                backup: backup || undefined,
                fallbackEnabled,
                strategy
              };
            });

            if (hasErrors) {
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
