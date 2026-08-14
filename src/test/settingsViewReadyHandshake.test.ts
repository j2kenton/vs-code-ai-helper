import * as assert from "node:assert/strict";
import * as vm from "node:vm";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { SettingsViewProvider } from "../views/settingsView";
import { __testOnly } from "../utils/modelSelection";
import { initNotificationRouter, deactivateNotificationRouter } from "../utils/notificationRouter";

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
    /** Simulates the webview posting an arbitrary message to the extension
     * host, e.g. "saveProviders" — the real onDidReceiveMessage dispatch. */
    send,
  };
}

/** Minimal `vscode.workspace.getConfiguration()` stand-in backed by a plain
 * key/value store, generic enough for every setting readSetting() touches
 * (getModelSettings, getEnabledProviders, isUnsavedSettingsWarningEnabled,
 * ...) — not just the one key a given test cares about. `inspect()` only
 * reports a globalValue once a key has actually been written, so unwritten
 * settings correctly fall through readSetting() to their schema default. */
function stubWorkspaceConfiguration(): { store: Record<string, unknown>; restore(): void } {
  const workspace = vscode.workspace as unknown as Record<string, unknown>;
  const original = workspace.getConfiguration;
  const store: Record<string, unknown> = {};
  workspace.getConfiguration = () => ({
    get: (key: string, fallback?: unknown): unknown => (key in store ? store[key] : fallback),
    inspect: (key: string): { globalValue: unknown; workspaceValue: unknown; workspaceFolderValue: unknown } | undefined =>
      key in store ? { globalValue: store[key], workspaceValue: undefined, workspaceFolderValue: undefined } : undefined,
    update: (key: string, value: unknown): Promise<void> => {
      store[key] = value;
      return Promise.resolve();
    },
  });
  return {
    store,
    restore() {
      workspace.getConfiguration = original;
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
// button that opens that page; providers with an unverified in-session usage
// command (Antigravity, Gemini) render "unsupported" with no url — the
// button stays DISABLED, since an unconfirmed slash command must never ship
// as if it works (per the approved capability matrix: "If the retry still
// fails, leave the button disabled ... instead of shipping a nonfunctional
// action"). This is the exact compound condition a previous review cycle had
// to add after the button silently stayed dead for providers that now have a
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

      // Kiro: a one-shot, non-interactive usage command (piping "/usage"
      // into `kiro-cli chat`) — a "terminal" capability, not "unsupported".
      const kiro = byId.get("kiro-cli");
      assert.ok(kiro, "expected a kiro-cli entry in the init payload");
      assert.strictEqual(kiro?.usageEnabled, true, "Kiro's usage button must be enabled");
      assert.match(kiro?.usageTooltip ?? "", /Runs the provider's usage command in a visible terminal/);

      // Antigravity: an unverified in-session usage command (agy → /usage)
      // renders "unsupported" with no url — the button stays DISABLED rather
      // than suggesting a command that has never been confirmed to work.
      const antigravity = byId.get("antigravity-cli");
      assert.ok(antigravity, "expected an antigravity-cli entry in the init payload");
      assert.strictEqual(
        antigravity?.usageEnabled,
        false,
        "Antigravity's usage button must be disabled while its slash command is unverified"
      );
      assert.doesNotMatch(antigravity?.usageTooltip ?? "", /Opens the usage page/);
      assert.match(antigravity?.usageTooltip ?? "", /agy/);

      // Gemini gets the identical treatment — not special-cased to
      // Antigravity: any provider whose usage descriptor is "unverified"
      // must resolve to a disabled button, uniformly.
      const gemini = byId.get("gemini-cli");
      assert.ok(gemini, "expected a gemini-cli entry in the init payload");
      assert.strictEqual(
        gemini?.usageEnabled,
        false,
        "Gemini's usage button must be disabled while its slash command is unverified"
      );
    } finally {
      __testOnly.clearModelSelectionTestOverrides();
    }
  });
});

// ---------------------------------------------------------------------------
// Provider save must not reset the model-selection form
//
// Provider selection and model selection are independently saved settings
// (separate config keys). Saving providers must never discard unsaved edits
// sitting in the model-selection form. The extension-host half of that fix
// is _selfOriginatedProviderWrite: a "saveProviders" write flips it on for
// the duration of VS Code's own asynchronous onDidChangeConfiguration
// dispatch for that exact write, so the listener refreshes only the
// provider rows/combobox options (via a targeted "providersRefreshed")
// instead of re-running a full "init" that would flatten the model form to
// whatever is last saved on disk. A genuinely external config change (a
// different window, the settings editor, Global scope) must still trigger
// the full re-init.
// ---------------------------------------------------------------------------

void describe("SettingsViewProvider — provider save does not reset model selections", () => {
  void it("suppresses a full re-init when its own saveProviders write echoes back through onDidChangeConfiguration", async () => {
    __testOnly.setModelSelectionTestOverrides({
      getAvailableCopilotModels: () => Promise.resolve([]),
      cliCommandExists: () => Promise.resolve(false),
    });
    const config = stubWorkspaceConfiguration();
    initNotificationRouter({ addEntry: () => undefined });
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
      assert.strictEqual(fake.postedMessages.length, 1, "expected the initial init post");
      assert.strictEqual(fake.postedMessages[0]?.type, "init");

      fake.send({ type: "saveProviders", enabledProviders: { "claude-cli": true } });
      await flushAsync();

      // The handler itself posts a targeted refresh, never a second "init".
      const afterSave = fake.postedMessages.slice(1);
      assert.strictEqual(afterSave.length, 1, "saveProviders should post exactly one message");
      assert.strictEqual(afterSave[0]?.type, "providersRefreshed");
      assert.strictEqual((afterSave[0] as { settings?: unknown }).settings, undefined,
        "providersRefreshed must not carry model-selection form state");

      // Simulate VS Code's real, asynchronous dispatch of
      // onDidChangeConfiguration for that same self-originated write — the
      // stub's config.update() (unlike real VS Code) does not fire this on
      // its own, so the test fires it explicitly, exactly like the write
      // this webview just performed would in production.
      const changes = (vscode.workspace as unknown as {
        _configurationChanges: { fire(value: { affectsConfiguration(section: string): boolean }): void };
      })._configurationChanges;
      changes.fire({ affectsConfiguration: (section: string) => section === "ensemble" });
      await flushAsync();

      assert.strictEqual(
        fake.postedMessages.filter((m) => m.type === "init").length,
        1,
        "the self-originated config-change echo must not trigger a second full re-init, " +
          "which would overwrite unsaved model-selection edits"
      );
    } finally {
      config.restore();
      deactivateNotificationRouter();
      __testOnly.clearModelSelectionTestOverrides();
    }
  });

  void it("still re-inits on a genuinely external config change (not caused by this webview's own saveProviders write)", async () => {
    __testOnly.setModelSelectionTestOverrides({
      getAvailableCopilotModels: () => Promise.resolve([]),
      cliCommandExists: () => Promise.resolve(false),
    });
    const config = stubWorkspaceConfiguration();
    initNotificationRouter({ addEntry: () => undefined });
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
      assert.strictEqual(fake.postedMessages.length, 1, "expected the initial init post");

      // No saveProviders in this test — the change below models an edit made
      // in the settings editor, a different window, or Global scope, none of
      // which set _selfOriginatedProviderWrite.
      const changes = (vscode.workspace as unknown as {
        _configurationChanges: { fire(value: { affectsConfiguration(section: string): boolean }): void };
      })._configurationChanges;
      changes.fire({ affectsConfiguration: (section: string) => section === "ensemble" });
      await flushAsync();

      assert.strictEqual(
        fake.postedMessages.filter((m) => m.type === "init").length,
        2,
        "an externally-caused config change must still trigger a full re-init"
      );
    } finally {
      config.restore();
      deactivateNotificationRouter();
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
  /** document.body — appended overlays (confirmation dialogs) land here. */
  body: FakeNode;
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
    querySelectorAll(): FakeNode[] {
      return [];
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
    // A real webview's document.activeElement is an HTMLElement; this stub's
    // documentStub has no activeElement getter, so `opener` is always
    // undefined and this check never actually matches — it only needs to
    // exist so `instanceof HTMLElement` doesn't throw ReferenceError.
    HTMLElement: FakeNode,
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
    body: documentStub.body,
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

// ---------------------------------------------------------------------------
// "providersRefreshed" must never discard a dirty model-selection form
//
// This is the webview-script half of the provider-save-preservation fix (see
// the extension-host tests above, "provider save does not reset model
// selections"): a provider-selection save posts "providersRefreshed" rather
// than a full "init", and the webview script's own handler for it must leave
// currentSettings/formDirty untouched so an in-progress model edit survives.
// ---------------------------------------------------------------------------

void describe("SettingsViewProvider webview — providersRefreshed preserves an unsaved model edit", () => {
  void it("leaves a dirty model-selection edit in place when providersRefreshed arrives", async () => {
    const script = extractWebviewScript();
    const stateStore: { value: unknown } = { value: undefined };
    const session = runWebviewSession(script, stateStore);

    const init = initMessage();
    init.settings = { impl: { primary: "claude-cli:sonnet", backups: [], strategy: "alert-and-wait" } };
    await session.deliver(init);

    // Edit the primary model for "impl" without saving — mirrors a real
    // combobox edit, which marks the form dirty via the delegated
    // #stages-tbody listener.
    session.byId("primary-impl").value = "claude-cli:opus";
    await session.byId("stages-tbody").dispatch("input");
    assert.equal(session.byId("save-btn").disabled, false, "the edit must have marked the form dirty");

    // renderTable() rebuilds the whole tbody's innerHTML from currentSettings
    // — capture it now so the assertion below can confirm providersRefreshed
    // does NOT trigger that rebuild while the form is dirty (a rebuilt row's
    // markup reflects currentSettings, not whatever the user has live-typed
    // into the actual, not-yet-saved combobox — checking the rendered HTML
    // for the edited value would not exercise the real bug at all).
    const tbodyHtmlBeforeRefresh = session.byId("stages-tbody").innerHTML;

    // A provider-selection save completes concurrently and refreshes the
    // provider rows / available models — it must not know or care that the
    // model form is mid-edit.
    await session.deliver({
      type: "providersRefreshed",
      models: [{ id: "claude-cli:sonnet", name: "Sonnet", providerLabel: "Claude CLI" }],
      enabledProviders: { "claude-cli": true },
      providers: [],
    });

    assert.equal(
      session.byId("save-btn").disabled,
      false,
      "providersRefreshed must not clear the dirty flag set by the unsaved model edit"
    );
    assert.equal(
      session.byId("stages-tbody").innerHTML,
      tbodyHtmlBeforeRefresh,
      "the model table must not be rebuilt while an edit is unsaved — rebuilding it would discard " +
        "the user's in-progress (unsaved) selection"
    );
    assert.equal(
      session.byId("primary-impl").value,
      "claude-cli:opus",
      "the unsaved edit itself must survive a providersRefreshed message"
    );
  });

  void it("re-renders the model table from providersRefreshed when the form is clean (not dirty)", async () => {
    const script = extractWebviewScript();
    const stateStore: { value: unknown } = { value: undefined };
    const session = runWebviewSession(script, stateStore);

    const init = initMessage();
    init.settings = { impl: { primary: "claude-cli:sonnet", backups: [], strategy: "alert-and-wait" } };
    await session.deliver(init);
    assert.equal(session.byId("save-btn").disabled, true, "nothing unsaved right after init");

    await session.deliver({
      type: "providersRefreshed",
      models: [{ id: "claude-cli:opus", name: "Opus", providerLabel: "Claude CLI" }],
      enabledProviders: { "claude-cli": true },
      providers: [],
    });

    assert.equal(
      session.byId("save-btn").disabled,
      true,
      "a clean form must stay clean after a providersRefreshed re-render"
    );
  });
});

// ---------------------------------------------------------------------------
// AI Models tab: button labels/styling and Discard Unsaved Changes
//
// "Save Provider Selection" and the bottom "Save Model Selection" button must
// share the same (primary, no "secondary" class) styling; "Add another
// backup" and the per-backup remove ("×") control must match the
// sign-in/check-usage secondary styling. The former "Reset to Defaults"
// button is now "Discard Unsaved Changes": it reverts the form to the last
// SAVED settings (not to empty) and requires confirmation.
// ---------------------------------------------------------------------------

void describe("SettingsViewProvider webview — AI Models tab labels and Discard Unsaved Changes", () => {
  void it("labels and styles the save/discard/provider/backup buttons per the AI Models tab conventions", () => {
    const html = extractWebviewHtml();

    // Each action button leads with a CSP-safe inline SVG icon (aria-hidden,
    // left of the label via the shared inline-flex rule); the two save
    // buttons render at the primary styling, discard keeps secondary.
    assert.match(
      html,
      /<button id="save-btn" disabled title="[^"]+"><svg[^>]*aria-hidden="true"[^>]*><path[^>]*\/><\/svg>Save Model Selection<\/button>/
    );
    assert.match(
      html,
      /<button id="discard-btn" class="secondary" disabled title="[^"]+"><svg[^>]*aria-hidden="true"[^>]*><path[^>]*\/><\/svg>Discard Unsaved Changes<\/button>/
    );
    assert.doesNotMatch(html, /Reset to Defaults/);
    // Save Provider Selection starts disabled (enabled only once a checkbox
    // differs from the saved map) and shows the same save icon, injected via
    // the SAVE_ICON_SVG script constant.
    assert.match(
      html,
      /<button id="save-providers-btn" disabled title="[^"]+">' \+ SAVE_ICON_SVG \+ 'Save Provider Selection<\/button>/
    );
    // The two save buttons render the identical icon glyph.
    const saveBtnIcon = /<button id="save-btn"[^>]*><svg[^>]*><path d="([^"]+)"/.exec(html);
    const providerBtnIcon = /const SAVE_ICON_SVG = '<svg[^>]*><path d="([^"]+)"/.exec(html);
    assert.ok(saveBtnIcon, "Save Model Selection must render an inline icon");
    assert.ok(providerBtnIcon, "Save Provider Selection must render an inline icon");
    assert.equal(
      providerBtnIcon[1],
      saveBtnIcon[1],
      "Save Provider Selection must reuse the exact Save Model Selection icon"
    );
    assert.match(html, /class="secondary add-backup"/);
    assert.match(html, /class="secondary remove-backup"/);
  });

  void it("Discard Unsaved Changes reverts the form to the last-saved settings and re-disables both buttons", async () => {
    const script = extractWebviewScript();
    const stateStore: { value: unknown } = { value: undefined };
    const session = runWebviewSession(script, stateStore);

    const init = initMessage();
    init.settings = { impl: { primary: "claude-cli:sonnet", backups: [], strategy: "alert-and-wait" } };
    await session.deliver(init);

    assert.equal(session.byId("save-btn").disabled, true, "nothing unsaved right after init");
    assert.equal(session.byId("discard-btn").disabled, true, "discard has nothing to discard right after init");

    // Edit: the save/collect path reads the hidden model input directly by
    // id (see reconcileModelInput), so this is exactly what a real edit to
    // the primary-model combobox for "impl" produces.
    session.byId("primary-impl").value = "claude-cli:opus";
    await session.byId("stages-tbody").dispatch("input");

    assert.equal(session.byId("save-btn").disabled, false, "editing a field must mark the form dirty");
    assert.equal(session.byId("discard-btn").disabled, false, "discard must be enabled once the form is dirty");

    // Do NOT await this dispatch yet — its click handler awaits
    // confirmDestructiveAction()'s promise, which only resolves once the
    // overlay's own confirm/cancel button is clicked below. The overlay
    // itself is still built synchronously (up to that await), so it is
    // already in document.body by the time this line returns control.
    const discardClick = session.byId("discard-btn").dispatch("click");

    // The confirmation overlay was appended to document.body; find and
    // confirm it (mirrors the "destructive-confirm" button wiring).
    const overlay = session.body.children[session.body.children.length - 1];
    assert.ok(overlay, "expected a confirmation overlay to have been appended");
    await overlay.querySelector("#destructive-confirm").dispatch("click");
    await discardClick;

    assert.equal(session.byId("save-btn").disabled, true, "confirming discard must clear the dirty flag");
    assert.equal(session.byId("discard-btn").disabled, true, "confirming discard must re-disable itself");

    // renderTable() rebuilt the impl row from the reverted currentSettings —
    // the edited value ("opus") must be gone and the saved one ("sonnet")
    // restored, not wiped to empty as the old Reset to Defaults did.
    const tbody = session.byId("stages-tbody");
    const implRow = tbody.children[tbody.children.length - 1];
    assert.ok(implRow, "expected the impl stage row to have been re-rendered");
    assert.match(implRow.innerHTML, /value="claude-cli:sonnet"/);
    assert.doesNotMatch(implRow.innerHTML, /value="claude-cli:opus"/);
  });

  void it("dismissing the Discard Unsaved Changes confirmation leaves the dirty edit untouched", async () => {
    const script = extractWebviewScript();
    const stateStore: { value: unknown } = { value: undefined };
    const session = runWebviewSession(script, stateStore);

    const init = initMessage();
    init.settings = { impl: { primary: "claude-cli:sonnet", backups: [], strategy: "alert-and-wait" } };
    await session.deliver(init);

    session.byId("primary-impl").value = "claude-cli:opus";
    await session.byId("stages-tbody").dispatch("input");
    assert.equal(session.byId("discard-btn").disabled, false);

    const discardClick = session.byId("discard-btn").dispatch("click");
    const overlay = session.body.children[session.body.children.length - 1];
    assert.ok(overlay);
    await overlay.querySelector("#destructive-cancel").dispatch("click");
    await discardClick;

    assert.equal(session.byId("save-btn").disabled, false, "cancelling discard must keep the form dirty");
    assert.equal(session.byId("discard-btn").disabled, false, "cancelling discard must keep discard enabled");
  });
});

// ---------------------------------------------------------------------------
// Save Provider Selection gating
//
// The provider save button mirrors the model form's gating: it starts
// disabled, enables only while a provider checkbox differs from the
// last-saved enabledProviders map, and re-disables after the saveProviders
// round-trip (which ends in a providersRefreshed re-render) or when the
// boxes return to the saved state — all without touching the model form's
// own dirty flag.
// ---------------------------------------------------------------------------

void describe("SettingsViewProvider webview — Save Provider Selection gating", () => {
  const CLAUDE_PROVIDER = {
    id: "claude-cli",
    label: "Claude Code",
    signInLabel: "Sign in / Switch account",
    signInGuidance: "",
    permissionWarning: "",
    installHint: "",
    usageEnabled: true,
    usageTooltip: "usage",
    enabledByDefault: true,
  };

  function providerInitMessage(): Record<string, unknown> {
    const init = initMessage();
    init.providers = [CLAUDE_PROVIDER];
    init.enabledProviders = {};
    return init;
  }

  void it("starts disabled, enables on a checkbox toggle, and re-disables after the save round-trip", async () => {
    const script = extractWebviewScript();
    const stateStore: { value: unknown } = { value: undefined };
    const session = runWebviewSession(script, stateStore);

    await session.deliver(providerInitMessage());
    assert.equal(
      session.byId("save-providers-btn").disabled,
      true,
      "nothing unsaved right after init — the checkboxes match the saved map"
    );

    // Toggle the claude-cli checkbox off (its saved state is on by default).
    await session.byId("provider-selection").dispatch("change", {
      target: { dataset: { provider: "claude-cli" }, checked: false },
    });
    assert.equal(
      session.byId("save-providers-btn").disabled,
      false,
      "a checkbox differing from the saved map must enable the save button"
    );
    assert.equal(
      session.byId("save-btn").disabled,
      true,
      "provider toggles must not mark the independent model form dirty"
    );

    // Saving posts the new provider map…
    await session.byId("provider-selection").querySelector("#save-providers-btn").dispatch("click");
    assert.ok(
      session.posted.some((message) => message.type === "saveProviders"),
      "clicking the enabled save button must post saveProviders"
    );

    // …and the host's providersRefreshed round-trip re-renders from the
    // saved map, re-disabling the button.
    await session.deliver({
      type: "providersRefreshed",
      models: [{ id: "claude-cli:sonnet", name: "Sonnet", providerLabel: "Claude CLI" }],
      enabledProviders: { "claude-cli": false },
      providers: [CLAUDE_PROVIDER],
    });
    assert.equal(
      session.byId("save-providers-btn").disabled,
      true,
      "a successful save must re-disable the button"
    );
  });

  void it("re-disables when the checkboxes return to the saved state", async () => {
    const script = extractWebviewScript();
    const stateStore: { value: unknown } = { value: undefined };
    const session = runWebviewSession(script, stateStore);

    await session.deliver(providerInitMessage());
    assert.equal(session.byId("save-providers-btn").disabled, true);

    // Off → enabled…
    await session.byId("provider-selection").dispatch("change", {
      target: { dataset: { provider: "claude-cli" }, checked: false },
    });
    assert.equal(session.byId("save-providers-btn").disabled, false);

    // …back on (the saved state) → disabled again, with no save in between.
    await session.byId("provider-selection").dispatch("change", {
      target: { dataset: { provider: "claude-cli" }, checked: true },
    });
    assert.equal(
      session.byId("save-providers-btn").disabled,
      true,
      "returning every checkbox to its saved state must re-disable the button"
    );
    assert.ok(
      !session.posted.some((message) => message.type === "saveProviders"),
      "no save may be posted while the button was never meaningfully enabled"
    );
  });
});
