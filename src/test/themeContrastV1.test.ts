import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { ChatViewProvider } from "../views/chatView";
import { SettingsViewProvider } from "../views/settingsView";
import { escapeTooltipHtmlV1, renderTooltipInfoTextV1 } from "../views/tooltipInfoTextV1";

function makeMemento(): vscode.Memento {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string, defaultValue?: T): T => (store.has(key) ? (store.get(key) as T) : (defaultValue as T)),
    update: (key: string, value: unknown): Promise<void> => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
      return Promise.resolve();
    },
    keys: (): readonly string[] => [...store.keys()],
  } as unknown as vscode.Memento;
}

function chatHtml(): string {
  const provider = new ChatViewProvider(makeMemento());
  return (provider as unknown as { html(): string }).html();
}

function settingsHtml(): string {
  const provider = new SettingsViewProvider(vscode.Uri.file("/fake/ext"));
  const webview = {
    options: {},
    html: "",
    cspSource: "vscode-webview://fake",
    onDidReceiveMessage: () => ({ dispose() {} }),
    postMessage: () => Promise.resolve(false),
  };
  const view = {
    webview,
    visible: true,
    onDidChangeVisibility: () => ({ dispose() {} }),
    onDidDispose: () => ({ dispose() {} }),
    show: () => {},
  };
  provider.resolveWebviewView(
    view as unknown as vscode.WebviewView,
    {} as vscode.WebviewViewResolveContext,
    {} as vscode.CancellationToken
  );
  return webview.html;
}

/** Body of the first CSS rule whose selector list contains `selector` verbatim. */
function ruleBody(html: string, selector: string): string {
  const escaped = selector.replace(/[.#[\]]/g, "\\$&");
  const match = new RegExp(`(?:^|[\\s,}])${escaped}\\s*\\{([^}]*)\\}`).exec(html);
  assert.ok(match, `expected a ${selector} CSS rule`);
  return match[1]!;
}

void describe("chat webview — info/disabled text contrast tokens", () => {
  void it("defines both tokens with light/dark overrides and no high-contrast override", () => {
    const html = chatHtml();
    assert.match(html, /--ensemble-info-foreground:\s*var\(--vscode-foreground\)/);
    assert.match(html, /--ensemble-disabled-foreground:\s*var\(--vscode-descriptionForeground\)/);
    assert.match(html, /body\.vscode-light\s*\{\s*--ensemble-info-foreground:\s*#000000;\s*\}/);
    assert.match(html, /body\.vscode-dark\s*\{\s*--ensemble-info-foreground:\s*#ffffff;\s*\}/);
    assert.doesNotMatch(html, /body\.vscode-high-contrast[^{]*\{\s*--ensemble-info-foreground/);
  });

  void it("colours the informational helper blocks with the info token", () => {
    const html = chatHtml();
    for (const selector of [
      "#scheduling-posture",
      ".interaction-help",
      ".decision-option-consequence",
      ".decision-recommendation",
      ".decision-gating",
      ".decision-paused-note",
    ]) {
      assert.match(ruleBody(html, selector), /color:\s*var\(--ensemble-info-foreground\)/, selector);
    }
  });

  void it("keeps metadata/status text on the muted colour", () => {
    const html = chatHtml();
    for (const selector of [".msg-meta", ".msg-copy", "#busy-indicator", "#empty-notice"]) {
      assert.match(ruleBody(html, selector), /color:\s*var\(--vscode-descriptionForeground\)/, selector);
    }
  });

  void it("renders a disabled decision option with the disabled colour, not opacity", () => {
    const html = chatHtml();
    const disabled = ruleBody(html, ".decision-option-disabled");
    assert.doesNotMatch(disabled, /opacity/);
    assert.match(disabled, /color:\s*var\(--ensemble-disabled-foreground\)/);
    assert.match(disabled, /cursor:\s*not-allowed/);
    assert.match(
      ruleBody(html, ".decision-option-disabled .decision-option-consequence"),
      /color:\s*var\(--ensemble-disabled-foreground\)/
    );
  });
});

void describe("settings webview — info/disabled text contrast tokens", () => {
  void it("defines both tokens with light/dark overrides", () => {
    const html = settingsHtml();
    assert.match(html, /--ensemble-info-foreground:\s*var\(--vscode-foreground\)/);
    assert.match(html, /--ensemble-disabled-foreground:\s*var\(--vscode-descriptionForeground\)/);
    assert.match(html, /body\.vscode-light\s*\{\s*--ensemble-info-foreground:\s*#000000;\s*\}/);
    assert.match(html, /body\.vscode-dark\s*\{\s*--ensemble-info-foreground:\s*#ffffff;\s*\}/);
  });

  void it("colours helper copy with the info token", () => {
    const html = settingsHtml();
    for (const selector of [".provider-help", ".stage-hint", ".model-option-detail"]) {
      assert.match(ruleBody(html, selector), /color:\s*var\(--ensemble-info-foreground\)/, selector);
    }
  });

  void it("uses the disabled colour, not opacity, on neutral disabled controls", () => {
    const html = settingsHtml();
    const comboDisabled = ruleBody(html, ".model-combo-input[disabled]");
    assert.doesNotMatch(comboDisabled, /opacity/);
    assert.match(comboDisabled, /color:\s*var\(--ensemble-disabled-foreground\)/);
    const skipped = ruleBody(html, ".model-row.skipped .model-combo-input");
    assert.doesNotMatch(skipped, /opacity/);
    const secondaryDisabled = ruleBody(html, "button.secondary:disabled");
    assert.match(secondaryDisabled, /opacity:\s*1/);
    assert.match(secondaryDisabled, /color:\s*var\(--ensemble-disabled-foreground\)/);
    assert.match(ruleBody(html, "button:disabled"), /opacity:\s*0\.7/);
  });
});

void describe("tooltipInfoTextV1", () => {
  void it("wraps text in a black span for light themes and a white span for dark themes", () => {
    assert.equal(
      renderTooltipInfoTextV1("Why: x", vscode.ColorThemeKind.Light),
      '<span style="color:#000000;">Why: x</span>'
    );
    assert.equal(
      renderTooltipInfoTextV1("Why: x", vscode.ColorThemeKind.Dark),
      '<span style="color:#ffffff;">Why: x</span>'
    );
  });

  void it("emits escaped text with no span for both high-contrast kinds", () => {
    for (const kind of [vscode.ColorThemeKind.HighContrast, vscode.ColorThemeKind.HighContrastLight]) {
      assert.equal(renderTooltipInfoTextV1("a <b> & c", kind), "a &lt;b&gt; &amp; c");
    }
  });

  void it("escapes HTML metacharacters, ampersand first", () => {
    assert.equal(escapeTooltipHtmlV1('<a href="x">&</a>'), "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
    assert.equal(
      renderTooltipInfoTextV1("<script>", vscode.ColorThemeKind.Light),
      '<span style="color:#000000;">&lt;script&gt;</span>'
    );
  });
});
