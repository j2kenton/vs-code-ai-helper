import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import * as vscode from "vscode";
import { TaskNode, TaskTreeProvider } from "../views/taskTreeProvider";
import { TaskStatusBar } from "../views/taskStatusBar";
import { tooltipLiteralTextV1 } from "../views/tooltipInfoTextV1";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { setExtensionContextV1 } from "../utils/extensionContextV1";
import type { IncompleteTask } from "../types/incompleteTask";
import type { TaskStage } from "../types/taskProgress";

class FakeMemento {
  private readonly values = new Map<string, unknown>();
  get<T>(key: string, defaultValue?: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }
  update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
  keys(): readonly string[] {
    return [...this.values.keys()];
  }
}

const windowStub = vscode.window as unknown as { activeColorTheme: { kind: number } };
const originalTheme = windowStub.activeColorTheme;
function setTheme(kind: vscode.ColorThemeKind): void {
  windowStub.activeColorTheme = { kind };
}

const TASK_PATH = "/workspace/tasks/tooltip-task";
const TASK_NAME = "tooltip-task<b>";

function makeInventory(
  extraProgress: Record<string, unknown> = {},
  taskFolderPath: string = TASK_PATH
): import("../state/taskInventory").TaskInventory {
  return {
    getTasks: () => [
      {
        taskFolderPath,
        folderName: TASK_NAME,
        progress: {
          currentStage: "impl" as TaskStage,
          status: "active",
          taskFolder: TASK_NAME,
          createdAt: "2026-08-19T00:00:00.000Z",
          updatedAt: "2026-08-19T00:00:00.000Z",
          ...extraProgress,
        },
        canonicalId: taskFolderPath,
      },
    ],
    refresh: async (): Promise<void> => {},
    onDidChange: (_handler: () => void): { dispose: () => void } => ({ dispose(): void {} }),
  } as unknown as import("../state/taskInventory").TaskInventory;
}

async function firstTaskNode(provider: TaskTreeProvider): Promise<TaskNode> {
  const commandsStub = vscode.commands as typeof vscode.commands & {
    _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
  };
  const previous = commandsStub._executeCommandOverride;
  commandsStub._executeCommandOverride = (): Promise<unknown> => Promise.resolve(undefined);
  try {
    const roots = await provider.getChildren();
    const node = roots.find((n): n is TaskNode => n instanceof TaskNode);
    assert.ok(node, "the single task renders a TaskNode");
    return node;
  } finally {
    commandsStub._executeCommandOverride = previous;
  }
}

function makeStatusBarTask(): IncompleteTask {
  const folderUri = vscode.Uri.file(TASK_PATH);
  return {
    folderUri,
    folderName: TASK_NAME,
    canonicalId: folderUri.fsPath,
    progress: {
      currentStage: "spec" as TaskStage,
      status: "active",
      taskFolder: "tooltip-task",
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
    },
  } as unknown as IncompleteTask;
}

const tooltipOf = (bar: TaskStatusBar): vscode.MarkdownString =>
  (bar as unknown as { item: vscode.StatusBarItem }).item.tooltip as vscode.MarkdownString;

void describe("task tree tooltip — theme-aware informational text", () => {
  afterEach(() => {
    windowStub.activeColorTheme = originalTheme;
  });

  void it("enables supportHtml without trust and wraps the posture sentence per theme kind", async () => {
    for (const [kind, colour] of [
      [vscode.ColorThemeKind.Light, "#000000"],
      [vscode.ColorThemeKind.Dark, "#ffffff"],
    ] as const) {
      setTheme(kind);
      const provider = new TaskTreeProvider(makeInventory(), undefined, new FakeMemento() as unknown as vscode.Memento);
      try {
        const node = await firstTaskNode(provider);
        const tooltip = node.tooltip as vscode.MarkdownString;
        assert.equal(tooltip.supportHtml, true);
        assert.notEqual((tooltip as { isTrusted?: unknown }).isTrusted, true);
        assert.match(tooltip.value, new RegExp(`What happens next\\*\\* — <span style="color:${colour};">Why: `));
      } finally {
        provider.dispose();
      }
    }
  });

  void it("emits no span for high-contrast themes", async () => {
    setTheme(vscode.ColorThemeKind.HighContrast);
    const provider = new TaskTreeProvider(makeInventory(), undefined, new FakeMemento() as unknown as vscode.Memento);
    try {
      const node = await firstTaskNode(provider);
      const value = (node.tooltip as vscode.MarkdownString).value;
      assert.match(value, /What happens next\*\* — Why: /);
      assert.doesNotMatch(value, /<span/);
    } finally {
      provider.dispose();
    }
  });

  void it("escapes a pending decision's text", async () => {
    const memento = new FakeMemento() as unknown as vscode.Memento;
    const posted = await new WorkflowDecisionStoreV1(memento).post({
      decisionId: "decision-escape",
      decisionKey: "restoreRejectedRound",
      taskCanonicalId: TASK_PATH,
      stage: "impl",
      whatHappened: "Round <img src=x> failed.",
      whyUserNeeded: "Needs a human.",
      options: [
        {
          optionId: "restore",
          label: "Restore",
          consequence: "Restores.",
          destructive: false,
          resumeKind: "unpause",
          effect: { kind: "command", command: "vs-code-ai-helper.restoreRejectedImplementationRound" },
        },
      ],
      recommendation: { kind: "option", optionId: "restore", reasoning: "Only choice." },
      createdAt: new Date().toISOString(),
    });
    assert.equal(posted.ok, true);
    const provider = new TaskTreeProvider(makeInventory(), undefined, memento);
    try {
      const value = ((await firstTaskNode(provider)).tooltip as vscode.MarkdownString).value;
      assert.match(value, /Round &lt;img src=x&gt; failed\./);
      assert.doesNotMatch(value, /<b>|<img/);
    } finally {
      provider.dispose();
    }
  });

  void it("escapes free-text values such as the task name", async () => {
    const provider = new TaskTreeProvider(makeInventory(), undefined, new FakeMemento() as unknown as vscode.Memento);
    try {
      const node = await firstTaskNode(provider);
      const value = (node.tooltip as vscode.MarkdownString).value;
      assert.ok(value.startsWith("**tooltip-task&lt;b&gt;**"), value.slice(0, 60));
      assert.ok(!value.includes("tooltip-task<b>"));
    } finally {
      provider.dispose();
    }
  });
});

void describe("status bar tooltip — theme-aware informational text and refresh", () => {
  afterEach(() => {
    windowStub.activeColorTheme = originalTheme;
    setExtensionContextV1(undefined as unknown as vscode.ExtensionContext);
  });

  function withContext(): void {
    setExtensionContextV1({ workspaceState: new FakeMemento() } as unknown as vscode.ExtensionContext);
  }

  void it("wraps the posture detail per theme kind, escapes the quarantine-free fields and sets supportHtml", () => {
    withContext();
    setTheme(vscode.ColorThemeKind.Light);
    const bar = new TaskStatusBar(new CurrentTaskStore(new FakeMemento() as unknown as vscode.Memento));
    try {
      const task = makeStatusBarTask();
      bar.update([task], task.canonicalId);
      const tooltip = tooltipOf(bar);
      assert.equal(tooltip.supportHtml, true);
      assert.notEqual((tooltip as { isTrusted?: unknown }).isTrusted, true);
      assert.match(tooltip.value, /What happens next\*\* — <span style="color:#000000;">Why: /);
    } finally {
      bar.dispose();
    }
  });

  void it("refresh() re-renders from the cached tasks so the span flips with the theme kind", () => {
    withContext();
    setTheme(vscode.ColorThemeKind.Light);
    const bar = new TaskStatusBar(new CurrentTaskStore(new FakeMemento() as unknown as vscode.Memento));
    try {
      const task = makeStatusBarTask();
      bar.update([task], task.canonicalId);
      assert.match(tooltipOf(bar).value, /color:#000000;/);

      setTheme(vscode.ColorThemeKind.Dark);
      bar.refresh();
      const value = tooltipOf(bar).value;
      assert.match(value, /color:#ffffff;/);
      assert.doesNotMatch(value, /color:#000000;/);
    } finally {
      bar.dispose();
    }
  });
});

void describe("tooltipLiteralTextV1", () => {
  void it("escapes HTML and markdown syntax and collapses line breaks", () => {
    assert.equal(tooltipLiteralTextV1("plan-final.md"), "plan-final.md");
    assert.equal(tooltipLiteralTextV1("a<b>&c"), "a&lt;b&gt;&amp;c");
    const hostile = tooltipLiteralTextV1("x` <img src=x onerror=1> `\n\ny");
    assert.ok(!hostile.includes("<"));
    assert.ok(!hostile.includes("\n"));
    assert.ok(!/(^|[^\\])`/.test(hostile), "every backtick is backslash-escaped");
  });
});

void describe("tooltips — artifact, model id and folder name are HTML-escaped", () => {
  void it("escapes the status-bar task folder name", () => {
    setExtensionContextV1({ workspaceState: new FakeMemento() } as unknown as vscode.ExtensionContext);
    const bar = new TaskStatusBar(new CurrentTaskStore(new FakeMemento() as unknown as vscode.Memento));
    try {
      const task = makeStatusBarTask();
      bar.update([task], task.canonicalId);
      const value = tooltipOf(bar).value;
      assert.ok(value.includes("Task: tooltip-task&lt;b&gt;"), value);
      assert.doesNotMatch(value, /<b>/);
    } finally {
      bar.dispose();
      setExtensionContextV1(undefined as unknown as vscode.ExtensionContext);
    }
  });

  void it("escapes markup in a missing artifact name and a model id", async () => {
    const inventory = makeInventory({
      completedWithMissingArtifacts: [
        { stage: "spec", artifact: "a`<b>x", at: "2026-09-06T00:00:00.000Z", override: "user" },
      ],
      quotaParkRecord: {
        modelId: "m`<i>",
        providerId: "p",
        failureKind: "quota",
        observedAt: "2026-09-06T00:00:00.000Z",
      },
    });
    const provider = new TaskTreeProvider(inventory, undefined, new FakeMemento() as unknown as vscode.Memento);
    try {
      const node = await firstTaskNode(provider);
      const value = (node.tooltip as vscode.MarkdownString).value;
      assert.ok(value.includes("a\\`&lt;b&gt;x"), value);
      assert.ok(value.includes("m\\`&lt;i&gt;"), value);
      assert.doesNotMatch(value, /<b>|<i>/);
    } finally {
      provider.dispose();
    }
  });
});

void describe("task tree tooltip — paused reason, unchecked and manual checklist items are escaped", () => {
  void it("renders no raw markup from a paused reason, an outstanding checklist item or a manual step", async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "tooltip-escape-"));
    try {
      fs.writeFileSync(
        path.join(folder, "plan-final.md"),
        [
          "<!-- ensemble:implementation-checklist -->",
          "",
          "- [ ] Outstanding <img src=x onerror=1> item",
          "- [ ] Manual <script>alert(1)</script> step <!-- ensemble:excluded -->",
          "",
        ].join("\n")
      );
      const inventory = makeInventory(
        {
          status: "paused",
          pausedReason: "Provider <b>chain</b> exhausted",
          checklistProgressUnreliable: true,
        },
        folder
      );
      const provider = new TaskTreeProvider(inventory, undefined, new FakeMemento() as unknown as vscode.Memento);
      try {
        const value = ((await firstTaskNode(provider)).tooltip as vscode.MarkdownString).value;
        assert.ok(value.includes("Provider &lt;b&gt;chain&lt;/b&gt; exhausted"), value);
        assert.ok(value.includes("Outstanding &lt;img src=x onerror=1&gt; item"), value);
        assert.ok(value.includes("Manual &lt;script&gt;alert(1)&lt;/script&gt; step"), value);
        assert.doesNotMatch(value, /<b>|<\/b>|<img|<script/);
      } finally {
        provider.dispose();
      }
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
