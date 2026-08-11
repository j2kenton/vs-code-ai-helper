import * as assert from "node:assert/strict";
import * as vm from "node:vm";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  SettingsViewProvider,
  STAGE_ROLE_HINTS,
  STAGE_TITLE_OVERRIDES,
  cliDefinitionForProviderAccountId,
} from "../views/settingsView";

// ---------------------------------------------------------------------------
// AI Models view rework coverage: uniform [checkbox][combo][×] rows with
// skip/clear semantics, general-model presentation, combo labelling and
// type-to-select, provider account-action gating, and the two launch gates
// (permissionWarning inline rendering, installHint empty state). The row and
// combobox logic lives entirely in the inline webview script, so these tests
// execute the REAL script (extracted from the provider's HTML) in a vm
// sandbox with a minimal DOM, mirroring settingsViewReadyHandshake.test.ts.
// ---------------------------------------------------------------------------

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
  dataset: Record<string, string> = {};
  classList = {
    add: (): void => undefined,
    remove: (): void => undefined,
    toggle: (): void => undefined,
  };
  firstChild: FakeNode | null = null;
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
  tbodyRows(): FakeNode[];
}

function runWebviewSession(script: string): WebviewSession {
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
      setState: (): void => undefined,
      getState: (): unknown => undefined,
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
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    tbodyRows: (): FakeNode[] => documentStub.getElementById("stages-tbody").children,
  };
}

interface InitOverrides {
  models?: Array<{ id: string; name: string; providerLabel: string }>;
  stages?: string[];
  providers?: Array<Record<string, unknown>>;
  showProviderAccountActions?: boolean;
  settings?: Record<string, unknown>;
  enabledProviders?: Record<string, boolean>;
}

function initMessage(overrides: InitOverrides = {}): Record<string, unknown> {
  return {
    type: "init",
    settings: overrides.settings ?? {},
    models:
      overrides.models ??
      [{ id: "claude-cli:sonnet", name: "Sonnet", providerLabel: "Claude Code" }],
    stages: overrides.stages ?? ["impl"],
    stageNames: {
      desc: "Task Description",
      impl: "Implementation",
      publish: "Publish",
    },
    stageTitleOverrides: STAGE_TITLE_OVERRIDES,
    stageHints: STAGE_ROLE_HINTS,
    enabledProviders: overrides.enabledProviders ?? {},
    providers: overrides.providers ?? [],
    showProviderAccountActions: overrides.showProviderAccountActions ?? false,
    warnUnsavedSettings: true,
  };
}

const CLAUDE_PROVIDER = {
  id: "claude-cli",
  label: "Claude Code",
  signInLabel: "Sign in / Switch account",
  signInGuidance: "",
  permissionWarning: "",
  installHint: "Install the Claude Code CLI (npm i -g @anthropic-ai/claude-code).",
  usageEnabled: true,
  usageTooltip: "usage",
  enabledByDefault: true,
};

void describe("AI Models view — static row template and captions", () => {
  void it("renames the add button, drops the per-row labels, and keeps the pinned wording", () => {
    const html = extractWebviewHtml();
    assert.ok(html.includes("+ Add backup model"), "the add button must say '+ Add backup model'");
    assert.ok(!html.includes("Add another backup</button>"), "the old 'Add another backup' label must be gone");
    assert.ok(!html.includes("Primary model:"), "the 'Primary model:' field-label must be gone");
    assert.ok(
      html.includes("Backup models (tried in order)"),
      "the backups caption is kept (shown only when backups exist)"
    );
    // Flagged-for-later strings stay byte-identical.
    assert.ok(html.includes("Remove this backup model"));
    // Quota status text no longer renders anywhere — the data keeps
    // accruing underneath (utils/quota.ts), but the UI consumer is gone.
    assert.ok(!html.includes("No usage observed yet this session"));
    assert.ok(!html.includes("quota-text"));
    // Every row shares the uniform template: checkbox + combo + ×.
    assert.ok(html.includes('class="row-enabled"'));
    assert.ok(html.includes("modelRowHtml('primary'"));
  });
});

void describe("AI Models view — general model presentation", () => {
  void it("exports the desc retitle and the role hints for desc and publish", () => {
    assert.equal(STAGE_TITLE_OVERRIDES.desc, "General Model");
    assert.match(STAGE_ROLE_HINTS.desc ?? "", /Global Assistant/);
    assert.match(STAGE_ROLE_HINTS.desc ?? "", /default for any stage with no model of its own/);
    assert.match(STAGE_ROLE_HINTS.publish ?? "", /CLI operations/);
  });

  void it("renders the general title and hints into the stage rows, ordering unchanged", async () => {
    const session = runWebviewSession(extractWebviewScript());
    await session.deliver(initMessage({ stages: ["desc", "impl", "publish"] }));
    const rows = session.tbodyRows();
    assert.equal(rows.length, 3, "desc first, publish last — ordering unchanged");
    assert.ok(rows[0]!.innerHTML.includes("General Model"));
    assert.ok(rows[0]!.innerHTML.includes("Global Assistant"));
    assert.ok(rows[1]!.innerHTML.includes("Implementation"));
    assert.ok(!rows[1]!.innerHTML.includes("stage-hint"), "non-hinted stages render no hint block");
    assert.ok(rows[2]!.innerHTML.includes("CLI operations"));
    // The stage heading stands alone: no per-row primary label anywhere.
    assert.ok(!rows[1]!.innerHTML.includes("Primary model:"));
    // Uniform row markup for the primary row.
    assert.ok(rows[1]!.innerHTML.includes('class="row-enabled"'));
    assert.ok(rows[1]!.innerHTML.includes("remove-backup"));
  });
});

void describe("AI Models view — provider account-action gating (ensemble.showProviderAccountActions)", () => {
  void it("hides the Sign in / Check usage buttons by default while keeping checkbox, save, and warning", async () => {
    const session = runWebviewSession(extractWebviewScript());
    await session.deliver(
      initMessage({
        providers: [{ ...CLAUDE_PROVIDER, permissionWarning: "Antigravity warning text." }],
      })
    );
    const html = session.byId("provider-selection").innerHTML;
    assert.ok(!html.includes("provider-signin"), "sign-in button must be hidden by default");
    assert.ok(!html.includes("Check usage"), "usage button must be hidden by default");
    assert.ok(html.includes('data-provider="claude-cli"'), "the enable checkbox always renders");
    assert.ok(html.includes("save-providers-btn"), "the save button always renders");
    assert.ok(html.includes("Antigravity warning text."), "permissionWarning renders regardless");
  });

  void it("renders both buttons when the setting is enabled", async () => {
    const session = runWebviewSession(extractWebviewScript());
    await session.deliver(
      initMessage({ providers: [CLAUDE_PROVIDER], showProviderAccountActions: true })
    );
    const html = session.byId("provider-selection").innerHTML;
    assert.ok(html.includes("provider-signin"));
    assert.ok(html.includes("Check usage"));
  });
});

void describe("AI Models view — permissionWarning inline rendering (launch gate 4a)", () => {
  void it("pins the inline provider-warning rendering for providers that define one", async () => {
    const session = runWebviewSession(extractWebviewScript());
    const warning =
      "Antigravity runs with --dangerously-skip-permissions in every mode, including plan and review.";
    await session.deliver(
      initMessage({
        providers: [
          CLAUDE_PROVIDER,
          { ...CLAUDE_PROVIDER, id: "antigravity-cli", label: "Antigravity CLI", permissionWarning: warning },
        ],
      })
    );
    const html = session.byId("provider-selection").innerHTML;
    assert.ok(html.includes('class="provider-warning"'));
    assert.ok(html.includes(warning));
    // Providers without a warning render none.
    const warningCount = html.split('class="provider-warning"').length - 1;
    assert.equal(warningCount, 1);
  });
});

void describe("AI Models view — installHint empty state (launch gate 4b)", () => {
  void it("maps provider account ids to the CLI definition carrying the installHint", () => {
    assert.equal(cliDefinitionForProviderAccountId("copilot"), undefined);
    assert.equal(cliDefinitionForProviderAccountId("claude-cli")?.id, "claude-cli");
    assert.equal(cliDefinitionForProviderAccountId("opencode-zen")?.id, "opencode-cli");
    assert.equal(cliDefinitionForProviderAccountId("opencode-go")?.id, "opencode-cli");
    assert.ok((cliDefinitionForProviderAccountId("opencode-zen")?.installHint ?? "").length > 0);
  });

  void it("renders the enabled providers' install hints when no models were discovered at all", async () => {
    const session = runWebviewSession(extractWebviewScript());
    await session.deliver(initMessage({ models: [], providers: [CLAUDE_PROVIDER] }));
    const row = session.tbodyRows()[0]!;
    await row.querySelector("#primary-input-impl").dispatch("focus");
    const list = row.querySelector("#primary-list-impl");
    assert.ok(list.innerHTML.includes(CLAUDE_PROVIDER.installHint));
    assert.ok(!list.innerHTML.includes("No models found"));
  });

  void it("deduplicates one shared hint across providers (Zen/Go both map to the OpenCode hint)", async () => {
    const session = runWebviewSession(extractWebviewScript());
    const sharedHint = "Install OpenCode (npm i -g opencode-ai).";
    await session.deliver(
      initMessage({
        models: [],
        providers: [
          { ...CLAUDE_PROVIDER, id: "opencode-zen", label: "OpenCode Zen", installHint: sharedHint },
          { ...CLAUDE_PROVIDER, id: "opencode-go", label: "OpenCode Go", installHint: sharedHint },
        ],
      })
    );
    const row = session.tbodyRows()[0]!;
    await row.querySelector("#primary-input-impl").dispatch("focus");
    const list = row.querySelector("#primary-list-impl");
    assert.equal(list.innerHTML.split(sharedHint).length - 1, 1, "the shared hint renders once");
  });

  void it("falls back to the plain message when no enabled provider yields a hint (Copilot-only)", async () => {
    const session = runWebviewSession(extractWebviewScript());
    await session.deliver(
      initMessage({
        models: [],
        providers: [{ ...CLAUDE_PROVIDER, id: "copilot", label: "GitHub Copilot", installHint: "" }],
      })
    );
    const row = session.tbodyRows()[0]!;
    await row.querySelector("#primary-input-impl").dispatch("focus");
    assert.ok(row.querySelector("#primary-list-impl").innerHTML.includes("No models found"));
  });

  void it("shows the plain no-match message (no hints) when models exist but the filter matches none", async () => {
    const session = runWebviewSession(extractWebviewScript());
    await session.deliver(initMessage({ providers: [CLAUDE_PROVIDER] }));
    const row = session.tbodyRows()[0]!;
    const input = row.querySelector("#primary-input-impl");
    input.value = "zzz-no-such-model";
    await input.dispatch("input");
    const list = row.querySelector("#primary-list-impl");
    assert.ok(list.innerHTML.includes("No models found"));
    assert.ok(!list.innerHTML.includes(CLAUDE_PROVIDER.installHint));
  });
});

void describe("AI Models view — combo labelling and type-to-select", () => {
  const QUALIFIED_MODELS = [
    {
      id: "cline-cli:kimi-code/k3",
      name: "Kimi K3 [may be unstable, higher usage] (Extra High)",
      providerLabel: "Cline CLI (subscription CLI)",
    },
    { id: "claude-cli:sonnet", name: "Sonnet", providerLabel: "Claude Code" },
  ];

  void it("leads each option with the bare model name and dims the qualifiers", async () => {
    const session = runWebviewSession(extractWebviewScript());
    await session.deliver(initMessage({ models: QUALIFIED_MODELS }));
    const row = session.tbodyRows()[0]!;
    await row.querySelector("#primary-input-impl").dispatch("focus");
    const list = row.querySelector("#primary-list-impl");
    assert.ok(
      list.innerHTML.includes('<span class="model-option-name">Kimi K3</span>'),
      "the bare name must lead the option"
    );
    assert.ok(list.innerHTML.includes("model-option-detail"));
  });

  void it("typing the unambiguous bare model name selects it on blur", async () => {
    const session = runWebviewSession(extractWebviewScript());
    await session.deliver(initMessage({ models: QUALIFIED_MODELS }));
    const row = session.tbodyRows()[0]!;
    const input = row.querySelector("#primary-input-impl");
    const hidden = row.querySelector("#primary-impl");
    input.value = "Kimi K3";
    await input.dispatch("blur");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(hidden.value, "cline-cli:kimi-code/k3");
  });

  void it("an ambiguous bare name shared by two variants selects nothing", async () => {
    const session = runWebviewSession(extractWebviewScript());
    await session.deliver(
      initMessage({
        models: [
          { id: "p:high", name: "Foo Model (High)", providerLabel: "P" },
          { id: "p:low", name: "Foo Model (Low)", providerLabel: "P" },
        ],
      })
    );
    const row = session.tbodyRows()[0]!;
    const input = row.querySelector("#primary-input-impl");
    const hidden = row.querySelector("#primary-impl");
    input.value = "Foo Model";
    await input.dispatch("blur");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(hidden.value, "", "an ambiguous base must not auto-select");
  });

  void it("exact full-label selection still works", async () => {
    const session = runWebviewSession(extractWebviewScript());
    await session.deliver(initMessage({ models: QUALIFIED_MODELS }));
    const row = session.tbodyRows()[0]!;
    const input = row.querySelector("#primary-input-impl");
    const hidden = row.querySelector("#primary-impl");
    input.value = "Sonnet — Claude Code";
    await input.dispatch("blur");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(hidden.value, "claude-cli:sonnet");
  });
});

void describe("AI Models view — save path (skip/clear semantics)", () => {
  void it("saves with fully-unconfigured stages: no errors, explicit stage entries written", async () => {
    const session = runWebviewSession(extractWebviewScript());
    await session.deliver(initMessage({ stages: ["impl", "publish"] }));
    session.byId("strategy-impl").value = "alert-and-wait";
    session.byId("strategy-publish").value = "alert-and-wait";
    await session.byId("save-btn").dispatch("click");
    assert.ok(
      !session.posted.some((message) => message.type === "validationError"),
      "unconfigured stages are valid state, not an error"
    );
    const saved = session.posted.find((message) => message.type === "saveSettings") as
      | { settings: Record<string, { primary?: string; backups?: string[] }> }
      | undefined;
    assert.ok(saved, "saving must succeed on first run with nothing configured");
    assert.ok(saved.settings.impl, "the stage entry is written explicitly even when empty");
    assert.equal(saved.settings.impl.primary, undefined);
    // JSON-compare: the settings object crossed the vm-realm boundary, so
    // its arrays fail deepStrictEqual's same-realm prototype check.
    assert.equal(JSON.stringify(saved.settings.impl.backups), "[]");
  });

  void it("no longer raises the 'switch-to-backup requires a backup' error", async () => {
    const session = runWebviewSession(extractWebviewScript());
    await session.deliver(initMessage());
    session.byId("strategy-impl").value = "switch-to-backup";
    await session.byId("save-btn").dispatch("click");
    assert.ok(!session.posted.some((message) => message.type === "validationError"));
    assert.ok(session.posted.some((message) => message.type === "saveSettings"));
  });

  void it("a skipped primary with unmatched typed text saves without error, preserving the stored id", async () => {
    const session = runWebviewSession(extractWebviewScript());
    await session.deliver(initMessage());
    const collectRow = session.byId("row-impl");
    collectRow.querySelector(".primary-container .model-row").querySelector(".row-enabled").checked = false;
    session.byId("strategy-impl").value = "alert-and-wait";
    session.byId("primary-input-impl").value = "typo that matches nothing";
    session.byId("primary-impl").value = "";
    session.byId("primary-impl").dataset.lastValid = "claude-cli:sonnet";
    await session.byId("save-btn").dispatch("click");
    assert.ok(
      !session.posted.some((message) => message.type === "validationError"),
      "a skipped row's unmatched text must not block saving"
    );
    const saved = session.posted.find((message) => message.type === "saveSettings") as
      | { settings: Record<string, { primary?: string; primaryEnabled?: boolean }> }
      | undefined;
    assert.equal(saved?.settings.impl?.primary, "claude-cli:sonnet");
    assert.equal(saved?.settings.impl?.primaryEnabled, false);
  });

  void it("the same unmatched text on an ENABLED primary still errors", async () => {
    const session = runWebviewSession(extractWebviewScript());
    await session.deliver(initMessage());
    const collectRow = session.byId("row-impl");
    collectRow.querySelector(".primary-container .model-row").querySelector(".row-enabled").checked = true;
    session.byId("strategy-impl").value = "alert-and-wait";
    session.byId("primary-input-impl").value = "typo that matches nothing";
    session.byId("primary-impl").value = "";
    await session.byId("save-btn").dispatch("click");
    assert.ok(session.posted.some((message) => message.type === "validationError"));
    assert.ok(!session.posted.some((message) => message.type === "saveSettings"));
  });
});
