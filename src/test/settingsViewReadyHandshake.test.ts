import * as assert from "node:assert/strict";
import * as vm from "node:vm";
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
    onDidDispose(_listener: () => void) {
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

// ---------------------------------------------------------------------------
// Usage-button view-model (unsupported-with-URL vs unsupported-without)
//
// settingsView.ts computes usageEnabled/usageTooltip per provider inside
// _postInit from each entry's usage capability. Providers whose usage is
// "unsupported" but carry a `url` (Copilot, Kiro) must render an ENABLED
// button that opens that page; providers with neither a command nor a URL
// (Antigravity) must stay disabled with just the reason as the tooltip.
// This is the exact compound condition a previous review cycle had to add
// after the button silently stayed dead for providers that now have a
// usage-page fallback — pinned here against the real "init" payload.
// ---------------------------------------------------------------------------

interface InitProviderViewModel {
  id: string;
  usageEnabled: boolean;
  usageTooltip: string;
}

void describe("SettingsViewProvider — usage-button view-model", () => {
  void it("enables the usage button with an 'Opens the usage page' tooltip for unsupported-with-URL providers, and keeps it disabled with just the reason for unsupported-without-URL providers", async () => {
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

      const init = fake.postedMessages.find((m) => m.type === "init");
      assert.ok(init, "expected an init message to have been posted");
      const providers = init?.providers as InitProviderViewModel[];
      assert.ok(Array.isArray(providers) && providers.length > 0);

      const byId = new Map(providers.map((p) => [p.id, p]));

      // Copilot: unsupported usage command, but a known usage page.
      const copilot = byId.get("copilot");
      assert.ok(copilot, "expected a copilot entry in the init payload");
      assert.strictEqual(copilot?.usageEnabled, true, "Copilot's usage button must be enabled");
      assert.match(copilot?.usageTooltip ?? "", /Opens the usage page\.$/);

      // Kiro: same shape — unsupported command, known usage page.
      const kiro = byId.get("kiro-cli");
      assert.ok(kiro, "expected a kiro-cli entry in the init payload");
      assert.strictEqual(kiro?.usageEnabled, true, "Kiro's usage button must be enabled");
      assert.match(kiro?.usageTooltip ?? "", /Opens the usage page\.$/);

      // Antigravity: unsupported with no known page — stays disabled, and
      // the tooltip is just the reason (no "Opens the usage page" promise).
      const antigravity = byId.get("antigravity-cli");
      assert.ok(antigravity, "expected an antigravity-cli entry in the init payload");
      assert.strictEqual(
        antigravity?.usageEnabled,
        false,
        "Antigravity's usage button must stay disabled without a usage-page URL"
      );
      assert.doesNotMatch(antigravity?.usageTooltip ?? "", /Opens the usage page/);
      assert.ok((antigravity?.usageTooltip ?? "").length > 0, "the disabled button still needs a reason tooltip");
    } finally {
      __testOnly.clearModelSelectionTestOverrides();
    }
  });
});

// ---------------------------------------------------------------------------
// Draft preservation across webview disposal (plan step 29)
//
// The discard path VS Code owns — deallocating the webview document when the
// view is hidden/closed — cannot be intercepted by the extension, so the
// webview script itself serializes dirty form state into the webview state
// API (vscode.setState) and restores it, with a notice, on the next init.
// That logic lives entirely in the inline webview script, so these tests
// execute the REAL script (extracted from the provider's HTML) in a vm
// sandbox with a minimal DOM: the "disposal" is a fresh script run sharing
// the same persistent state store, exactly like VS Code recreating the
// document while retaining webview state.
// ---------------------------------------------------------------------------

/** Minimal DOM node for the settings webview script: enough surface for
 * renderProviderSelection/renderTable/collectFormSettings to run, recording
 * innerHTML and appended children so tests can observe what was rendered. */
class FakeNode {
  children: FakeNode[] = [];
  value = "";
  innerHTML = "";
  textContent = "";
  innerText = "";
  hidden = false;
  disabled = false;
  checked = false;
  id = "";
  className = "";
  title = "";
  style: Record<string, unknown> = {};
  dataset: Record<string, string> = {};
  classList = { add: (): void => undefined, remove: (): void => undefined };
  private listeners = new Map<string, Array<(event: unknown) => unknown>>();
  private attributes = new Map<string, string>();
  private selectorChildren = new Map<string, FakeNode>();

  appendChild(child: FakeNode): FakeNode {
    this.children.push(child);
    return child;
  }
  remove(): void {
    /* no-op */
  }
  querySelector(selector: string): FakeNode {
    let node = this.selectorChildren.get(selector);
    if (!node) {
      node = new FakeNode();
      this.selectorChildren.set(selector, node);
    }
    return node;
  }
  querySelectorAll(): FakeNode[] {
    return [];
  }
  addEventListener(type: string, listener: (event: unknown) => unknown): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | undefined {
    return this.attributes.get(name);
  }
  scrollIntoView(): void {
    /* no-op */
  }
  focus(): void {
    /* no-op */
  }
  closest(): null {
    return null;
  }
  async dispatch(type: string, event: unknown = {}): Promise<void> {
    for (const listener of this.listeners.get(type) ?? []) {
      await listener(event);
    }
  }
}

function extractWebviewHtml(): string {
  const provider = new SettingsViewProvider(vscode.Uri.file("/fake/ext"));
  return (
    provider as unknown as { _getHtmlForWebview(webview: { cspSource: string }): string }
  )._getHtmlForWebview({ cspSource: "vscode-webview://fake" });
}

function extractWebviewScript(): string {
  const html = extractWebviewHtml();
  const match = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, "expected the settings webview HTML to contain its inline script");
  return match[1]!;
}

interface WebviewSession {
  byId(id: string): FakeNode;
  posted: Array<Record<string, unknown>>;
  deliver(message: Record<string, unknown>): Promise<void>;
}

/** One webview document lifetime. `stateStore` outlives sessions, exactly
 * like VS Code's webview state persists across document disposal. */
function runWebviewSession(script: string, stateStore: { value: unknown }): WebviewSession {
  const byId = new Map<string, FakeNode>();
  const documentStub = {
    getElementById(id: string): FakeNode {
      let node = byId.get(id);
      if (!node) {
        node = new FakeNode();
        node.id = id;
        byId.set(id, node);
      }
      return node;
    },
    createElement(): FakeNode {
      return new FakeNode();
    },
    body: new FakeNode(),
  };
  const messageListeners: Array<(event: { data: unknown }) => unknown> = [];
  const posted: Array<Record<string, unknown>> = [];
  const sandbox = {
    acquireVsCodeApi: () => ({
      postMessage: (message: Record<string, unknown>): void => {
        posted.push(message);
      },
      setState: (state: unknown): void => {
        stateStore.value = state;
      },
      getState: (): unknown => stateStore.value,
    }),
    document: documentStub,
    window: {
      addEventListener: (type: string, listener: (event: { data: unknown }) => unknown): void => {
        if (type === "message") {
          messageListeners.push(listener);
        }
      },
    },
    CSS: { escape: (value: string): string => value },
    setTimeout,
    console,
    Element: FakeNode,
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  return {
    byId: (id: string): FakeNode => documentStub.getElementById(id),
    posted,
    async deliver(message: Record<string, unknown>): Promise<void> {
      for (const listener of messageListeners) {
        await listener({ data: message });
      }
      // The init handler is async; let its awaited continuations settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

function initMessage(): Record<string, unknown> {
  return {
    type: "init",
    settings: {},
    models: [{ id: "claude-cli:sonnet", name: "Sonnet", providerLabel: "Claude CLI" }],
    stages: ["impl"],
    stageNames: { impl: "Implementation" },
    quotaStatus: {},
    enabledProviders: {},
    providers: [],
    warnUnsavedSettings: true,
  };
}

void describe("SettingsViewProvider webview — draft restore across disposal", () => {
  void it("uses theme tokens and does not repeat the AI Models section title", () => {
    const html = extractWebviewHtml();

    assert.match(html, /font-family: var\(--vscode-font-family\)/);
    assert.match(html, /background-color: var\(--vscode-editor-background\)/);
    assert.match(html, /color: var\(--vscode-foreground\)/);
    assert.match(html, /button:focus-visible, select:focus-visible, input\[type="text"\]:focus-visible/);
    assert.match(html, /role="status" aria-live="polite"/);
    assert.doesNotMatch(html, /<h2[^>]*>\s*AI Models\s*<\/h2>/i);
    assert.doesNotMatch(html, /#[0-9a-f]{3,8}\b|\b(?:rgb|hsl)a?\(/i);
  });

  void it("restores a dirty draft, with a notice, after the document is disposed and recreated", async () => {
    const script = extractWebviewScript();
    const stateStore: { value: unknown } = { value: undefined };

    // Session 1: the user edits the form (a model selection lands in the
    // hidden input), making it dirty — the draft is serialized to state.
    const first = runWebviewSession(script, stateStore);
    await first.deliver(initMessage());
    first.byId("primary-impl").value = "claude-cli:sonnet";
    await first.byId("stages-tbody").dispatch("input");

    const draft = (stateStore.value as { draftSettings?: Record<string, { primary?: string }> } | undefined)
      ?.draftSettings;
    assert.equal(
      draft?.impl?.primary,
      "claude-cli:sonnet",
      "marking the form dirty must persist the draft into webview state"
    );

    // VS Code disposes the document (view hidden/closed) and later recreates
    // it: a brand-new script run against the SAME persistent state store.
    const second = runWebviewSession(script, stateStore);
    await second.deliver(initMessage());

    const noteContainer = second.byId("restored-note-container");
    assert.ok(
      noteContainer.children.some((child) => /Restored unsaved changes/.test(child.textContent)),
      "the recreated document must show the restored-draft notice"
    );
    assert.equal(
      second.byId("save-btn").disabled,
      false,
      "the restored draft must leave the form dirty so Save Settings is enabled"
    );
    const renderedRows = second
      .byId("stages-tbody")
      .children.map((row) => row.innerHTML)
      .join("");
    assert.ok(
      renderedRows.includes("claude-cli:sonnet"),
      "the re-rendered form must contain the drafted model selection, not the empty saved settings"
    );
    assert.ok(second.posted.some((message) => message.type === "rendered"));
  });

  void it("does not show a restore notice when there is no draft, and Save clears a restored draft", async () => {
    const script = extractWebviewScript();

    // No draft: clean init.
    const cleanStore: { value: unknown } = { value: undefined };
    const clean = runWebviewSession(script, cleanStore);
    await clean.deliver(initMessage());
    assert.equal(clean.byId("restored-note-container").children.length, 0);
    assert.equal(clean.byId("save-btn").disabled, true, "a clean form must keep Save disabled");

    // With a draft: restoring and then saving must clear the persisted draft
    // so a later recreation starts clean instead of resurrecting stale edits.
    const draftStore: { value: unknown } = {
      value: { draftSettings: { impl: { primary: "claude-cli:sonnet", backups: [], strategy: "alert-and-wait" } } },
    };
    const restored = runWebviewSession(script, draftStore);
    await restored.deliver(initMessage());
    assert.equal(restored.byId("save-btn").disabled, false);

    await restored.byId("save-btn").dispatch("click");
    assert.ok(
      restored.posted.some((message) => message.type === "saveSettings"),
      "saving the restored draft must post saveSettings"
    );
    assert.equal(draftStore.value, undefined, "saving must clear the persisted draft");

    const third = runWebviewSession(script, draftStore);
    await third.deliver(initMessage());
    assert.equal(
      third.byId("restored-note-container").children.length,
      0,
      "after saving, a recreated document must not claim there are unsaved changes"
    );
  });
});
