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
  const match = new RegExp(`(?:^|[\\s,}])${escaped}\\s*(?:,[^{}]*)?\\{([^}]*)\\}`).exec(html);
  assert.ok(match, `expected a ${selector} CSS rule`);
  return match[1]!;
}

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function hexChannels(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexChannels(hex).map(srgbToLinear);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Mixes `a` over `b`, where `a` contributes `weightPercent` percent (sRGB interpolation, as CSS color-mix does). */
function mixColors(a: string, b: string, weightPercent: number): string {
  const weight = weightPercent / 100;
  const channels = hexChannels(a).map((channel, index) =>
    Math.round(channel * weight + hexChannels(b)[index]! * (1 - weight))
  );
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

void describe("chat webview — info/disabled text contrast tokens", () => {
  void it("defines both tokens with light/dark overrides and no high-contrast override", () => {
    const html = chatHtml();
    assert.match(html, /--ensemble-info-foreground:\s*var\(--vscode-foreground\)/);
    assert.match(html, /--ensemble-disabled-foreground:\s*var\(--vscode-descriptionForeground\)/);
    assert.match(html, /--ensemble-primary-foreground:\s*var\(--vscode-foreground\)/);
    assert.match(html, /--ensemble-muted-foreground:\s*var\(--vscode-descriptionForeground\)/);
    assert.match(html, /body\.vscode-light\s*\{\s*--ensemble-info-foreground:\s*#000000;\s*\}/);
    assert.match(html, /body\.vscode-dark\s*\{\s*--ensemble-info-foreground:\s*#ffffff;\s*\}/);
    assert.match(
      html,
      /body\.vscode-light\s*\{\s*--ensemble-primary-foreground:\s*#000000;\s*--ensemble-muted-foreground:\s*color-mix\(in srgb, var\(--ensemble-primary-foreground\)/
    );
    assert.match(
      html,
      /body\.vscode-dark\s*\{\s*--ensemble-primary-foreground:\s*#ffffff;\s*--ensemble-muted-foreground:\s*color-mix\(in srgb, var\(--ensemble-primary-foreground\)/
    );
    assert.doesNotMatch(html, /body\.vscode-high-contrast[^{]*\{\s*--ensemble-info-foreground/);
    assert.doesNotMatch(
      html,
      /body\.vscode-high-contrast[^{]*\{[^}]*(?:--ensemble-primary-foreground|--ensemble-muted-foreground)/
    );
  });

  void it("colours the informational helper blocks with the info token", () => {
    const html = chatHtml();
    for (const selector of [
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
    for (const selector of [".msg-meta", ".msg-copy", "#busy-indicator", "#steering-note", "#send-reason"]) {
      assert.match(ruleBody(html, selector), /color:\s*var\(--ensemble-muted-foreground\)/, selector);
    }
  });

  void it("keeps body copy on the primary colour", () => {
    const html = chatHtml();
    for (const selector of ["body", "#context", "#messages p.msg-user", "#messages p.msg-agent", "#empty-notice", ".msg-copy:hover"]) {
      assert.match(ruleBody(html, selector), /color:\s*var\(--ensemble-primary-foreground\)/, selector);
    }
  });

  void it("brightens the input placeholder without changing typed text", () => {
    const html = chatHtml();
    assert.match(
      ruleBody(html, "#form textarea::placeholder"),
      /color:\s*var\(--ensemble-muted-foreground\)/
    );
    assert.match(
      ruleBody(html, "#form textarea"),
      /color:\s*var\(--vscode-input-foreground,\s*var\(--vscode-foreground\)\)/
    );
  });

  void it("keeps the muted tier readable and strictly below the primary tier", () => {
    const html = chatHtml();
    const tier = (theme: "light" | "dark"): { primary: string; percent: number; fallback: string } => {
      const match = new RegExp(
        `body\\.vscode-${theme}\\s*\\{\\s*--ensemble-primary-foreground:\\s*(#[0-9a-f]{6});\\s*` +
          `--ensemble-muted-foreground:\\s*color-mix\\(in srgb, var\\(--ensemble-primary-foreground\\)\\s*(\\d+)%,\\s*` +
          `var\\(--vscode-editor-background,\\s*(#[0-9a-f]{6})\\)\\);\\s*\\}`
      ).exec(html);
      assert.ok(match, `expected the ${theme} tier colour-mix rule`);
      const [, primary, percent, fallback] = match;
      return { primary: primary!, percent: Number(percent), fallback: fallback! };
    };

    const dark = tier("dark");
    assert.equal(dark.fallback, "#1f1f1f");
    const darkMuted = mixColors(dark.primary, "#1f1f1f", dark.percent);
    assert.equal(darkMuted, "#b3b3b3");
    assert.ok(contrastRatio(darkMuted, "#1f1f1f") >= 4.5, "dark muted contrast");
    assert.ok(
      contrastRatio(dark.primary, "#1f1f1f") > contrastRatio(darkMuted, "#1f1f1f"),
      "dark primary is brighter than muted"
    );
    assert.ok(
      contrastRatio(darkMuted, "#1f1f1f") < contrastRatio("#cccccc", "#1f1f1f"),
      "dark muted stays below the typed-text input foreground"
    );
    const kimbieDarkMuted = mixColors(dark.primary, "#221a0f", dark.percent);
    assert.ok(
      contrastRatio(kimbieDarkMuted, "#51412c") >= 4.5,
      "Kimbie Dark placeholder contrast on its input background"
    );

    const light = tier("light");
    assert.equal(light.fallback, "#ffffff");
    const lightMuted = mixColors(light.primary, light.fallback, light.percent);
    assert.equal(lightMuted, "#595959");
    assert.ok(contrastRatio(lightMuted, light.fallback) >= 4.5, "light muted contrast");
    assert.ok(
      contrastRatio(light.primary, light.fallback) > contrastRatio(lightMuted, light.fallback),
      "light primary is darker than muted"
    );
    assert.ok(
      contrastRatio(lightMuted, light.fallback) < contrastRatio("#3b3b3b", light.fallback),
      "light muted stays below the typed-text input foreground"
    );
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

void describe("settings webview — dark provider button background", () => {
  void it("gives provider buttons a color-mix grey on dark themes with a distinct hover", () => {
    const html = settingsHtml();
    for (const cls of ["provider-usage", "provider-signin"]) {
      const rest = ruleBody(html, `body.vscode-dark button.${cls}`);
      assert.match(rest, /background-color:\s*color-mix\(/);
      assert.match(rest, /--vscode-foreground/);
      assert.match(rest, /--vscode-editor-background/);
    }
    const rest = ruleBody(html, "body.vscode-dark button.provider-usage");
    const hover = ruleBody(html, "body.vscode-dark button.provider-usage:hover");
    assert.match(hover, /background-color:\s*color-mix\(/);
    assert.notEqual(hover.trim(), rest.trim());
  });

  void it("gives Discard and Add-backup buttons the same dark grey as the provider buttons", () => {
    const html = settingsHtml();
    const ref = ruleBody(html, "body.vscode-dark button.provider-signin");
    const refHover = ruleBody(html, "body.vscode-dark button.provider-signin:hover");
    for (const sel of [
      "body.vscode-dark #discard-btn",
      "body.vscode-dark #discard-providers-btn",
      "body.vscode-dark button.add-backup",
    ]) {
      const rest = ruleBody(html, sel);
      assert.match(rest, /background-color:\s*color-mix\(/, sel);
      assert.match(rest, /--vscode-foreground/, sel);
      assert.match(rest, /--vscode-editor-background/, sel);
      assert.equal(rest.trim(), ref.trim(), sel);
      const hover = ruleBody(html, `${sel}:hover`);
      assert.equal(hover.trim(), refHover.trim(), `${sel}:hover`);
      assert.notEqual(hover.trim(), rest.trim(), `${sel}:hover`);
    }
  });

  void it("adds no light or high-contrast rules for provider buttons", () => {
    const html = settingsHtml();
    assert.doesNotMatch(html, /body\.vscode-(?:light|high-contrast)[^{}]*provider-(?:signin|usage)/);
    assert.doesNotMatch(html, /body\.vscode-(?:light|high-contrast)[^{}]*(?:#discard-btn|#discard-providers-btn|add-backup)/);
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

void describe("settings webview — provider sign-in button sizing", () => {
  void it("shares the Save/Discard button rule and its reduced font size", () => {
    const html = settingsHtml();
    const match = /([^{}]*#save-btn[^{}]*)\{([^}]*)\}/.exec(html);
    assert.ok(match, "expected the shared selection-button CSS rule");
    assert.ok(match[1]!.includes("button.provider-signin"), "selector list includes button.provider-signin");
    assert.match(match[2]!, /font-size:\s*var\(--ensemble-small-font-size\)/);
  });

  void it("does not override the sign-in font size in light or high-contrast themes", () => {
    const html = settingsHtml();
    const themed = /body\.vscode-(?:light|high-contrast)[^{}]*provider-signin[^{}]*\{([^}]*)\}/g;
    for (const m of html.matchAll(themed)) {
      assert.doesNotMatch(m[1]!, /font-size/);
    }
  });
});
