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
    if (conflicts.length === 0) return;

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
      this._view.show(true);
      void this._view.webview.postMessage({ type: "focusStage", stage, control });
    }
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
            background-color: var(--vscode-settings-selectBackground);
            color: var(--vscode-settings-selectForeground);
            border: 1px solid var(--vscode-settings-selectBorder);
            padding: 4px;
            border-radius: 2px;
          }
          select:focus, input[type="text"]:focus {
            outline: 1px solid var(--vscode-focusBorder);
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
                const control = message.control === 'backup' ? 'backup-' : 'primary-';
                const select = document.getElementById(control + message.stage);
                if (select) select.focus();
              }
            }
          });

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

              // Dropdown for primary model
              let primaryOptions = '<option value="">(None)</option>';
              availableModels.forEach(m => {
                const selected = setting.primary === m.id ? 'selected' : '';
                primaryOptions += \`<option value="\${m.id}" \${selected}>\${m.name} (\${m.providerLabel})</option>\`;
              });

              // Dropdown for backup model
              let backupOptions = '<option value="">(None)</option>';
              availableModels.forEach(m => {
                const selected = setting.backup === m.id ? 'selected' : '';
                backupOptions += \`<option value="\${m.id}" \${selected}>\${m.name} (\${m.providerLabel})</option>\`;
              });

              const fallbackChecked = setting.fallbackEnabled ? 'checked' : '';
              const backupDisabled = setting.fallbackEnabled ? '' : 'disabled';

              row.innerHTML = \`
                <td style="font-weight: bold; width: 35%;">\${stageDisplayNames[stage] || stage}</td>
                <td>
                  <div style="margin-bottom: 8px;">
                    <label for="primary-\${stage}" style="font-size: 0.9em; display:block; margin-bottom: 2px;">Primary Model:</label>
                    <select id="primary-\${stage}">\${primaryOptions}</select>
                    \${quotaText}
                  </div>
                  <div style="margin-bottom: 8px;">
                    <input type="checkbox" id="enable-fallback-\${stage}" \${fallbackChecked}>
                    <label for="enable-fallback-\${stage}">Use Backup Model</label>
                  </div>
                  <div style="margin-bottom: 8px;">
                    <label for="backup-\${stage}" style="font-size: 0.9em; display:block; margin-bottom: 2px;">Backup Model:</label>
                    <select id="backup-\${stage}" \${backupDisabled}>\${backupOptions}</select>
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

              const checkbox = row.querySelector('#enable-fallback-' + stage);
              const backupSelect = row.querySelector('#backup-' + stage);
              checkbox.addEventListener('change', () => {
                backupSelect.disabled = !checkbox.checked;
              });
            });
          }

          document.getElementById('save-btn').addEventListener('click', () => {
            const updatedSettings = {};
            let hasErrors = false;
            const alertRegion = document.getElementById('alert-region');
            alertRegion.innerText = '';

            stagesList.forEach(stage => {
              const primary = document.getElementById('primary-' + stage).value;
              const fallbackEnabled = document.getElementById('enable-fallback-' + stage).checked;
              const backup = document.getElementById('backup-' + stage).value;
              const strategy = document.getElementById('strategy-' + stage).value;

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
