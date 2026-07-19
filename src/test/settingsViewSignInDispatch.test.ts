import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dispatchVsCodeCommandSignIn,
  sendInteractiveSlashCommand,
  INTERACTIVE_SLASH_DELAY_MS,
  INTERACTIVE_SLASH_SUBMIT_DELAY_MS,
  type VsCodeCommandSignInDeps,
  type InteractiveTerminalLike,
} from "../views/settingsView";
import type { ProviderSignInAction } from "../runners/providers";

type VsCodeCommandSignIn = Extract<ProviderSignInAction, { kind: "vscode-command" }>;

function makeCapability(commands: string[], fallbackCommands: string[]): VsCodeCommandSignIn {
  return { kind: "vscode-command", commands, fallbackCommands };
}

function makeDeps(overrides: {
  registered?: string[];
  listCommandsError?: unknown;
  throwingCommands?: Set<string>;
}): { deps: VsCodeCommandSignInDeps; executed: string[]; infos: string[]; errors: string[] } {
  const executed: string[] = [];
  const infos: string[] = [];
  const errors: string[] = [];
  const registered = overrides.registered ?? [];
  const throwingCommands = overrides.throwingCommands ?? new Set<string>();

  const deps: VsCodeCommandSignInDeps = {
    listCommands: () => {
      if (overrides.listCommandsError !== undefined) {
        return Promise.reject(overrides.listCommandsError as Error);
      }
      return Promise.resolve(registered);
    },
    executeCommand: (command: string) => {
      executed.push(command);
      if (throwingCommands.has(command)) {
        return Promise.reject(new Error(`stub: ${command} failed`));
      }
      return Promise.resolve(undefined);
    },
    showInfo: (message: string) => {
      infos.push(message);
    },
    showError: (message: string) => {
      errors.push(message);
    },
  };

  return { deps, executed, infos, errors };
}

void describe("dispatchVsCodeCommandSignIn", () => {
  void it("(a) runs the newest primary candidate when it is registered", async () => {
    const capability = makeCapability(["new.signIn", "legacy.signIn"], ["new.accounts", "legacy.accounts"]);
    const { deps, executed, errors } = makeDeps({ registered: ["new.signIn", "legacy.signIn"] });

    await dispatchVsCodeCommandSignIn("Copilot", capability, deps);

    assert.deepEqual(executed, ["new.signIn"]);
    assert.deepEqual(errors, []);
  });

  void it("(b) runs the legacy primary candidate when only it is registered", async () => {
    const capability = makeCapability(["new.signIn", "legacy.signIn"], ["new.accounts", "legacy.accounts"]);
    const { deps, executed, errors } = makeDeps({ registered: ["legacy.signIn"] });

    await dispatchVsCodeCommandSignIn("Copilot", capability, deps);

    assert.deepEqual(executed, ["legacy.signIn"]);
    assert.deepEqual(errors, []);
  });

  void it("(c) falls back with the info message when no primary candidate is registered", async () => {
    const capability = makeCapability(["new.signIn", "legacy.signIn"], ["new.accounts", "legacy.accounts"]);
    const { deps, executed, infos, errors } = makeDeps({ registered: ["legacy.accounts"] });

    await dispatchVsCodeCommandSignIn("Copilot", capability, deps);

    assert.deepEqual(executed, ["legacy.accounts"]);
    assert.equal(infos.length, 1);
    assert.match(infos[0] ?? "", /managed by VS Code/);
    assert.deepEqual(errors, []);
  });

  void it("(d) falls back without an error when a registered primary throws", async () => {
    const capability = makeCapability(["new.signIn"], ["new.accounts"]);
    const { deps, executed, infos, errors } = makeDeps({
      registered: ["new.signIn", "new.accounts"],
      throwingCommands: new Set(["new.signIn"]),
    });

    await dispatchVsCodeCommandSignIn("Copilot", capability, deps);

    assert.deepEqual(executed, ["new.signIn", "new.accounts"]);
    assert.equal(infos.length, 1);
    assert.deepEqual(errors, []);
  });

  void it("(e) shows the terminal error when nothing on either list is registered", async () => {
    const capability = makeCapability(["new.signIn", "legacy.signIn"], ["new.accounts", "legacy.accounts"]);
    const { deps, executed, infos, errors } = makeDeps({ registered: [] });

    await dispatchVsCodeCommandSignIn("Copilot", capability, deps);

    assert.deepEqual(executed, []);
    assert.deepEqual(infos, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /sign-in command is not available/);
    assert.match(errors[0] ?? "", /Accounts menu/);
  });

  void it("(e) shows the terminal error when the fallback candidate also throws", async () => {
    const capability = makeCapability(["new.signIn"], ["new.accounts"]);
    const { deps, executed, infos, errors } = makeDeps({
      registered: ["new.signIn", "new.accounts"],
      throwingCommands: new Set(["new.signIn", "new.accounts"]),
    });

    await dispatchVsCodeCommandSignIn("Copilot", capability, deps);

    assert.deepEqual(executed, ["new.signIn", "new.accounts"]);
    assert.deepEqual(infos, []);
    assert.equal(errors.length, 1);
  });

  void it("(f) treats a rejecting listCommands() as unknown registration and still reaches the fallback path, without crashing", async () => {
    const capability = makeCapability(["new.signIn"], ["new.accounts"]);
    const { deps, executed, infos, errors } = makeDeps({
      listCommandsError: new Error("stub: getCommands rejected"),
      throwingCommands: new Set(["new.signIn"]),
    });

    await dispatchVsCodeCommandSignIn("Copilot", capability, deps);

    // Registration is "unknown" so both candidates are attempted directly,
    // in order: the primary (which throws) then the fallback (which
    // succeeds) — the call never rejects.
    assert.deepEqual(executed, ["new.signIn", "new.accounts"]);
    assert.equal(infos.length, 1);
    assert.deepEqual(errors, []);
  });
});

void describe("sendInteractiveSlashCommand", () => {
  void it("sends launch, then the slash text, then a bare \\r submit keystroke, in that order and with the documented delays", () => {
    const calls: Array<[string, boolean | undefined]> = [];
    const terminal: InteractiveTerminalLike = {
      sendText: (text, shouldExecute) => {
        calls.push([text, shouldExecute]);
      },
    };
    const scheduledDelays: number[] = [];
    // Fake scheduler: runs the callback immediately (synchronously) but
    // records the delay it was asked for, so the test can assert both the
    // exact call sequence and the delay ordering without real timers.
    const fakeScheduler = (callback: () => void, delayMs: number): void => {
      scheduledDelays.push(delayMs);
      callback();
    };

    sendInteractiveSlashCommand(terminal, { launch: "codex", send: "/usage" }, fakeScheduler);

    assert.deepEqual(calls, [
      ["codex", true],
      ["/usage", false],
      ["\r", false],
    ]);
    assert.deepEqual(scheduledDelays, [INTERACTIVE_SLASH_DELAY_MS, INTERACTIVE_SLASH_SUBMIT_DELAY_MS]);
  });
});
