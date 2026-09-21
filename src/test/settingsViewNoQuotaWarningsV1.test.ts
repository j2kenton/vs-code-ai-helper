import * as assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as vscode from "vscode";
import { SettingsViewProvider } from "../views/settingsView";
import { __testOnly } from "../utils/modelSelection";
import { quotaLedgerKey, listParkedQuotaLedgerEntriesV1 } from "../utils/quota";
import { setExtensionContextV1 } from "../utils/extensionContextV1";

interface Posted {
  type: string;
  [key: string]: unknown;
}

function createFakeWebviewView() {
  const listeners: Array<(message: Posted) => unknown> = [];
  const posted: Posted[] = [];
  const webview = {
    options: {},
    html: "",
    cspSource: "vscode-webview://fake",
    onDidReceiveMessage(listener: (message: Posted) => unknown) {
      listeners.push(listener);
      return { dispose() {} };
    },
    postMessage(message: Posted) {
      posted.push(message);
      return Promise.resolve(true);
    },
  };
  const view = {
    webview,
    visible: true,
    onDidChangeVisibility: () => ({ dispose() {} }),
    onDidDispose: () => ({ dispose() {} }),
    show: () => {},
  };
  return {
    view: view as unknown as vscode.WebviewView,
    webview,
    posted,
    send: (message: Posted) => listeners.forEach((listener) => void listener(message)),
  };
}

/** A parked quota entry as it sits in the real long-lived globalState ledger. */
function contextWithParkedEntry(): vscode.ExtensionContext {
  const globalValues = new Map<string, unknown>([
    [
      "ensembleQuotaLedgerV1",
      {
        [quotaLedgerKey("devpass-code", undefined, "devpass-cli:llmgateway-devpass/claude-sonnet-5@high")]: {
          failureKind: "quota",
          observedAt: "2026-08-14T10:00:00.000Z",
        },
      },
    ],
  ]);
  const memento = (values: Map<string, unknown>): vscode.Memento =>
    ({
      get: <T>(key: string, fallback?: T): T => (values.has(key) ? (values.get(key) as T) : (fallback as T)),
      update: (key: string, value: unknown): Promise<void> => {
        values.set(key, value);
        return Promise.resolve();
      },
      keys: () => [...values.keys()],
    }) as unknown as vscode.Memento;
  return {
    globalState: memento(globalValues),
    workspaceState: memento(new Map()),
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

void describe("SettingsViewProvider — parked quota entries are not shown", () => {
  afterEach(() => {
    __testOnly.clearModelSelectionTestOverrides();
    setExtensionContextV1(undefined as unknown as vscode.ExtensionContext);
  });

  void it("posts no quotaWarnings and ships no quota-warning markup even with a parked ledger entry", async () => {
    __testOnly.setModelSelectionTestOverrides({
      getAvailableCopilotModels: () => Promise.resolve([]),
      cliCommandExists: () => Promise.resolve(false),
    });
    const context = contextWithParkedEntry();
    setExtensionContextV1(context);
    // The ledger itself is intact (it drives routing) — only the display is gone.
    assert.equal(listParkedQuotaLedgerEntriesV1(context).length, 1);

    const provider = new SettingsViewProvider(vscode.Uri.file("/fake/ext"));
    const fake = createFakeWebviewView();
    provider.resolveWebviewView(fake.view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
    fake.send({ type: "ready" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const init = fake.posted.find((message) => message.type === "init");
    assert.ok(init, "expected an init message");
    assert.ok(!("quotaWarnings" in init), "init must not carry quotaWarnings");
    assert.doesNotMatch(fake.webview.html, /quota-warnings/);
    assert.doesNotMatch(fake.webview.html, /quota-warning/);
    assert.doesNotMatch(fake.webview.html, /quota exhausted/i);
    assert.equal(listParkedQuotaLedgerEntriesV1(context).length, 1, "rendering must not touch the ledger");
  });
});
