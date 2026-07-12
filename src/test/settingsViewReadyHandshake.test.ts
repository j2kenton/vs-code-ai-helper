import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { SettingsViewProvider } from "../views/settingsView";
import { __testOnly } from "../utils/modelSelection";

interface FakeMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * Stands in for a real VS Code WebviewView. Models three points in a
 * document's life as separately controllable, matching real VS Code /
 * the real webview script exactly (see settingsView.ts):
 *  - webview -> extension (onDidReceiveMessage) is captured unconditionally,
 *    since the extension registers its handler synchronously and well
 *    before any webview script could possibly run.
 *  - extension -> webview (postMessage) is only "received" once
 *    simulateScriptLoaded() has run, modeling the webview's own
 *    `window.addEventListener('message', ...)` not existing until its
 *    script has actually executed. A post before that point is dropped,
 *    exactly like real VS Code silently drops posts to a webview whose
 *    document isn't live yet.
 *  - simulateRendered() is a *separate*, later step from
 *    simulateScriptLoaded(): the real webview only sends "rendered" after
 *    it has actually processed an "init" payload and built its table rows
 *    (see the 'init' branch in the webview script). Tests control this
 *    independently so they can probe the window between "listening" and
 *    "rows exist" that focusStage() depends on.
 */
function createFakeWebviewView() {
  const receiveListeners: Array<(message: FakeMessage) => unknown> = [];
  const postedMessages: FakeMessage[] = [];
  let listenerAttached = false;

  const webview = {
    options: {},
    html: "",
    cspSource: "vscode-webview://fake",
    onDidReceiveMessage(listener: (message: FakeMessage) => unknown) {
      receiveListeners.push(listener);
      return { dispose() {} };
    },
    postMessage(message: FakeMessage) {
      if (listenerAttached) {
        postedMessages.push(message);
      }
      return Promise.resolve(listenerAttached);
    },
  };

  const webviewView = {
    webview,
    visible: true,
    onDidChangeVisibility(_listener: () => void) {
      return { dispose() {} };
    },
    show(_preserveFocus?: boolean) {
      webviewView.visible = true;
    },
  };

  function send(message: FakeMessage) {
    for (const listener of receiveListeners) {
      void listener(message);
    }
  }

  return {
    webviewView: webviewView as unknown as vscode.WebviewView,
    postedMessages,
    simulateScriptLoaded() {
      listenerAttached = true;
      send({ type: "ready" });
    },
    simulateRendered() {
      send({ type: "rendered" });
    },
  };
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

void describe("SettingsViewProvider — webview ready handshake", () => {
  void it("does not post init until the webview announces ready", async () => {
    __testOnly.setModelSelectionTestOverrides({
      getAvailableCopilotModels: () => Promise.resolve([]),
      cliCommandExists: () => Promise.resolve(false),
    });
    try {
      const provider = new SettingsViewProvider(vscode.Uri.file("/fake/ext"));
      const fake = createFakeWebviewView();

      provider.resolveWebviewView(
        fake.webviewView,
        {} as vscode.WebviewViewResolveContext,
        {} as vscode.CancellationToken
      );

      // The document was just created; its script hasn't run yet, so
      // nothing should have been posted to it.
      assert.strictEqual(fake.postedMessages.length, 0);

      fake.simulateScriptLoaded();
      await flushAsync();

      assert.strictEqual(fake.postedMessages.length, 1);
      assert.strictEqual(fake.postedMessages[0]?.type, "init");
    } finally {
      __testOnly.clearModelSelectionTestOverrides();
    }
  });

  void it("still renders after a collapse-then-reexpand cycle, even when the second load resolves instantly", async () => {
    // Reproduces the reported bug: getAvailableModels() is cache-backed
    // (see cliAgentRunner's commandExistsCache), so on a real second open it
    // can resolve far faster than the freshly recreated webview document
    // takes to load its script. Model that here by making the override
    // resolve synchronously-fast on both calls, and only flipping the fake
    // webview's listener on when we explicitly say the script has loaded.
    __testOnly.setModelSelectionTestOverrides({
      getAvailableCopilotModels: () => Promise.resolve([]),
      cliCommandExists: () => Promise.resolve(false),
    });
    try {
      const provider = new SettingsViewProvider(vscode.Uri.file("/fake/ext"));

      const first = createFakeWebviewView();
      provider.resolveWebviewView(
        first.webviewView,
        {} as vscode.WebviewViewResolveContext,
        {} as vscode.CancellationToken
      );
      first.simulateScriptLoaded();
      await flushAsync();
      assert.strictEqual(first.postedMessages.length, 1, "first open should render the table");

      // User collapses the section (VS Code deallocates the document), then
      // re-expands it: VS Code recreates the document and calls
      // resolveWebviewView again on the SAME provider instance, passing a
      // fresh webview whose script has not run yet.
      const second = createFakeWebviewView();
      provider.resolveWebviewView(
        second.webviewView,
        {} as vscode.WebviewViewResolveContext,
        {} as vscode.CancellationToken
      );

      // Nothing should be posted to the new document yet, even though
      // getAvailableModels() could already have resolved by this point.
      assert.strictEqual(second.postedMessages.length, 0);

      second.simulateScriptLoaded();
      await flushAsync();

      assert.strictEqual(
        second.postedMessages.length,
        1,
        "re-expanding must render the table again instead of staying blank"
      );
      assert.strictEqual(second.postedMessages[0]?.type, "init");
    } finally {
      __testOnly.clearModelSelectionTestOverrides();
    }
  });

  void it("does not deliver focusStage while ready-but-not-yet-rendered, and delivers it once rendered", async () => {
    // Targets the gap between "webview is listening" and "webview's table
    // rows actually exist": ready fires as soon as the webview's script
    // attaches its listener, which is strictly earlier than the rows
    // existing (that needs getAvailableModels() to resolve AND the webview
    // to process the resulting "init" payload). A focusStage() call that
    // lands in that gap must not be posted immediately — the webview would
    // receive it, find no matching row, and silently no-op it.
    __testOnly.setModelSelectionTestOverrides({
      getAvailableCopilotModels: () => Promise.resolve([]),
      cliCommandExists: () => Promise.resolve(false),
    });
    try {
      const provider = new SettingsViewProvider(vscode.Uri.file("/fake/ext"));
      const fake = createFakeWebviewView();

      provider.resolveWebviewView(
        fake.webviewView,
        {} as vscode.WebviewViewResolveContext,
        {} as vscode.CancellationToken
      );
      fake.simulateScriptLoaded();
      await flushAsync();

      // "init" has been posted, but the webview has not yet confirmed it
      // finished rendering rows from it.
      assert.strictEqual(fake.postedMessages.length, 1);
      assert.strictEqual(fake.postedMessages[0]?.type, "init");

      provider.focusStage("impl", "primary");

      // Must still be queued, not posted: rendering hasn't been confirmed.
      assert.strictEqual(
        fake.postedMessages.length,
        1,
        "focusStage must not be delivered before the webview confirms its rows exist"
      );

      fake.simulateRendered();
      await flushAsync();

      const focusMessage = fake.postedMessages.find((m) => m.type === "focusStage");
      assert.ok(focusMessage, "expected the queued focusStage message to be delivered once rendered");
      assert.strictEqual(focusMessage?.stage, "impl");
      assert.strictEqual(focusMessage?.control, "primary");
    } finally {
      __testOnly.clearModelSelectionTestOverrides();
    }
  });

  void it("queues a focusStage request made against a freshly (re)created, not-yet-loaded document", async () => {
    __testOnly.setModelSelectionTestOverrides({
      getAvailableCopilotModels: () => Promise.resolve([]),
      cliCommandExists: () => Promise.resolve(false),
    });
    try {
      const provider = new SettingsViewProvider(vscode.Uri.file("/fake/ext"));

      const first = createFakeWebviewView();
      provider.resolveWebviewView(
        first.webviewView,
        {} as vscode.WebviewViewResolveContext,
        {} as vscode.CancellationToken
      );
      first.simulateScriptLoaded();
      await flushAsync();
      first.simulateRendered();
      await flushAsync();

      // Collapse + immediate re-reveal via focusStage (as
      // configureStepModels.ts does: reveal() then focusStage() back to
      // back), landing on a fresh, not-yet-loaded document.
      const second = createFakeWebviewView();
      provider.resolveWebviewView(
        second.webviewView,
        {} as vscode.WebviewViewResolveContext,
        {} as vscode.CancellationToken
      );

      provider.focusStage("impl", "backup");

      // Not delivered yet: the new document's script hasn't loaded, let
      // alone rendered its rows.
      assert.strictEqual(second.postedMessages.length, 0);

      second.simulateScriptLoaded();
      await flushAsync();
      second.simulateRendered();
      await flushAsync();

      const focusMessage = second.postedMessages.find((m) => m.type === "focusStage");
      assert.ok(focusMessage, "expected a queued focusStage message to be delivered once rendered");
      assert.strictEqual(focusMessage?.stage, "impl");
      assert.strictEqual(focusMessage?.control, "backup");
    } finally {
      __testOnly.clearModelSelectionTestOverrides();
    }
  });
});
