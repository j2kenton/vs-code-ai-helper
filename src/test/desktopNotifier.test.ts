import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { buildNotifyCommand, notifyDesktop, __testOnly } from "../utils/desktopNotifier";
import { NotificationRouter, initNotificationRouter } from "../utils/notificationRouter";

type SpawnCall = { cmd: string; args: string[] };

/** Makes isDesktopNotificationsEnabled() return true; restore() undoes it. */
function enableDesktopNotifications(): { restore: () => void } {
  const workspaceStub = vscode.workspace as unknown as {
    getConfiguration: typeof vscode.workspace.getConfiguration;
  };
  const original = workspaceStub.getConfiguration;
  workspaceStub.getConfiguration = ((_section?: string) => ({
    get: (key: string, defaultValue: unknown) => (key === "desktopNotifications" ? true : defaultValue),
    inspect: () => undefined,
  })) as unknown as typeof vscode.workspace.getConfiguration;
  return {
    restore: () => {
      workspaceStub.getConfiguration = original;
    },
  };
}

function recordSpawns(): { calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  __testOnly.setSpawnOverride((cmd, args) => {
    calls.push({ cmd, args });
    return Promise.resolve();
  });
  return { calls };
}

/** WindowState.focused is `readonly` in the real vscode.d.ts; the stub backs it with a plain mutable object at runtime. */
function setFocused(value: boolean): void {
  (vscode.window.state as { focused: boolean }).focused = value;
}

/** env.remoteName is likewise `readonly` in the real vscode.d.ts. */
function setRemoteName(value: string | undefined): void {
  (vscode.env as { remoteName: string | undefined }).remoteName = value;
}

void describe("desktopNotifier — buildNotifyCommand", () => {
  void describe("win32", () => {
    void it("base64-encodes a PowerShell script rather than passing raw args", () => {
      const { cmd, args } = buildNotifyCommand("win32", "Title", "Message");
      assert.strictEqual(cmd, "powershell.exe");
      assert.ok(args.includes("-EncodedCommand"));
      const encoded = args[args.length - 1] ?? "";
      const script = Buffer.from(encoded, "base64").toString("utf16le");
      assert.ok(script.includes("Title"));
      assert.ok(script.includes("Message"));
    });

    void it("doubles embedded single quotes so a title cannot break out of the PS string literal", () => {
      const { args } = buildNotifyCommand("win32", "It's here", "Can't stop won't stop");
      const encoded = args[args.length - 1] ?? "";
      const script = Buffer.from(encoded, "base64").toString("utf16le");
      assert.ok(script.includes("It''s here"));
      assert.ok(script.includes("Can''t stop won''t stop"));
    });
  });

  void describe("darwin", () => {
    void it("produces a single-line -e argument even for a multi-line message", () => {
      const { cmd, args } = buildNotifyCommand("darwin", "Ensemble — error", "line one\nline two\nline three");
      assert.strictEqual(cmd, "osascript");
      assert.strictEqual(args[0], "-e");
      const script = args[1] ?? "";
      // The whole point of the fix: no raw newline may reach the -e argument,
      // since osascript treats one as a statement separator and would leave
      // the string literal unterminated.
      assert.ok(!script.includes("\n"), `script should not contain a raw newline: ${script}`);
      assert.ok(script.includes('"line one" & linefeed & "line two" & linefeed & "line three"'));
    });

    void it("escapes embedded double quotes and backslashes", () => {
      const { args } = buildNotifyCommand("darwin", "Title", 'She said "hi" and used a \\ backslash');
      const script = args[1] ?? "";
      assert.ok(script.includes('\\"hi\\"'));
      assert.ok(script.includes("\\\\ backslash"));
    });

    void it("handles CRLF and lone CR line endings, not just \\n", () => {
      const { args } = buildNotifyCommand("darwin", "Title", "a\r\nb\rc");
      const script = args[1] ?? "";
      assert.ok(!script.includes("\r"));
      assert.ok(script.includes('"a" & linefeed & "b" & linefeed & "c"'));
    });
  });

  void describe("linux", () => {
    void it("passes '--' before the summary/body so a leading '-' cannot be read as a flag", () => {
      const { cmd, args } = buildNotifyCommand("linux", "-not-a-flag", "-1 errors found");
      assert.strictEqual(cmd, "notify-send");
      assert.strictEqual(args[0], "--");
      assert.strictEqual(args[1], "-not-a-flag");
      assert.strictEqual(args[2], "-1 errors found");
    });

    void it("escapes Pango markup characters in the body so they don't get parsed as tags/entities", () => {
      const { args } = buildNotifyCommand("linux", "Title", "a < b && <script>alert(1)</script>");
      const body = args[2] ?? "";
      assert.ok(!body.includes("<"));
      assert.ok(!/&(?!amp;|lt;|gt;)/.test(body), `body should have no unescaped bare '&': ${body}`);
      assert.strictEqual(body, "a &lt; b &amp;&amp; &lt;script&gt;alert(1)&lt;/script&gt;");
    });
  });
});

void describe("desktopNotifier — notifyDesktop gating and queueing", () => {
  void it("does not spawn anything when the setting is off (the default)", async () => {
    const { calls } = recordSpawns();
    try {
      notifyDesktop("Title", "Message");
      await __testOnly.flush();
      assert.strictEqual(calls.length, 0);
    } finally {
      __testOnly.clearSpawnOverride();
    }
  });

  void it("does not spawn while VS Code is the focused window", async () => {
    const { restore } = enableDesktopNotifications();
    const { calls } = recordSpawns();
    const originalFocused = vscode.window.state.focused;
    setFocused(true);
    try {
      notifyDesktop("Title", "Message");
      await __testOnly.flush();
      assert.strictEqual(calls.length, 0);
    } finally {
      setFocused(originalFocused);
      __testOnly.clearSpawnOverride();
      restore();
    }
  });

  void it("spawns when enabled and VS Code is not the focused window", async () => {
    const { restore } = enableDesktopNotifications();
    const { calls } = recordSpawns();
    const originalFocused = vscode.window.state.focused;
    setFocused(false);
    try {
      notifyDesktop("Title", "Message");
      await __testOnly.flush();
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0]?.cmd, buildNotifyCommand(process.platform, "Title", "Message").cmd);
    } finally {
      setFocused(originalFocused);
      __testOnly.clearSpawnOverride();
      restore();
    }
  });

  void it("does not spawn on a remote host, even when enabled and unfocused", async () => {
    const { restore } = enableDesktopNotifications();
    const { calls } = recordSpawns();
    const originalFocused = vscode.window.state.focused;
    const originalRemoteName = vscode.env.remoteName;
    setFocused(false);
    setRemoteName("ssh-remote");
    try {
      notifyDesktop("Title", "Message");
      await __testOnly.flush();
      assert.strictEqual(calls.length, 0);
    } finally {
      setFocused(originalFocused);
      setRemoteName(originalRemoteName);
      __testOnly.clearSpawnOverride();
      restore();
    }
  });

  void it("drops an empty or whitespace-only title/message instead of spawning", async () => {
    const { restore } = enableDesktopNotifications();
    const { calls } = recordSpawns();
    const originalFocused = vscode.window.state.focused;
    setFocused(false);
    try {
      notifyDesktop("", "Message");
      notifyDesktop("Title", "   ");
      await __testOnly.flush();
      assert.strictEqual(calls.length, 0);
    } finally {
      setFocused(originalFocused);
      __testOnly.clearSpawnOverride();
      restore();
    }
  });

  void it("truncates an overly long message rather than passing it through verbatim", async () => {
    const { restore } = enableDesktopNotifications();
    const { calls } = recordSpawns();
    const originalFocused = vscode.window.state.focused;
    setFocused(false);
    try {
      notifyDesktop("Title", "x".repeat(1000));
      await __testOnly.flush();
      const encoded = calls[0]?.args[calls[0].args.length - 1] ?? "";
      const script = Buffer.from(encoded, "base64").toString("utf16le");
      assert.ok(!script.includes("x".repeat(1000)), "the full 1000-char message should not reach the spawned command");
    } finally {
      setFocused(originalFocused);
      __testOnly.clearSpawnOverride();
      restore();
    }
  });

  void it("does not stay stuck after a gating check throws mid-queue (regression)", async () => {
    // shouldSuppress() touches vscode.window.state, which real VS Code can
    // throw from during extension-host teardown. Simulate that once, then
    // verify a later, unrelated notifyDesktop() call still fires — proving
    // the queue recovers instead of staying permanently rejected.
    const { restore } = enableDesktopNotifications();
    const { calls } = recordSpawns();
    const originalDescriptor = Object.getOwnPropertyDescriptor(vscode.window, "state");
    let reads = 0;
    Object.defineProperty(vscode.window, "state", {
      configurable: true,
      get() {
        reads++;
        if (reads === 1) throw new Error("boom: simulated host teardown");
        return { focused: false };
      },
    });
    try {
      notifyDesktop("Title", "First message — the gating check throws for this one");
      await __testOnly.flush();
      assert.strictEqual(calls.length, 0, "the call that hit the throw should not itself have spawned anything");

      notifyDesktop("Title", "Second message — must still fire");
      await __testOnly.flush();
      assert.strictEqual(calls.length, 1, "a later call must still fire — the queue must not stay poisoned by the earlier throw");
    } finally {
      if (originalDescriptor) Object.defineProperty(vscode.window, "state", originalDescriptor);
      __testOnly.clearSpawnOverride();
      restore();
    }
  });

  void it("does not trigger desktop notifications for routine information or warning messages through NotificationRouter", async () => {
    const { restore } = enableDesktopNotifications();
    const { calls } = recordSpawns();
    const originalFocused = vscode.window.state.focused;
    setFocused(false);

    // Mock a StatusSurface so NotificationRouter can be initialized
    const mockSurface = {
      addEntry: () => {},
    };
    initNotificationRouter(mockSurface);

    try {
      NotificationRouter.showInformation("Routine info");
      NotificationRouter.showWarning("Routine warning");
      await __testOnly.flush();
      assert.strictEqual(calls.length, 0, "Routine notification routing must not spawn OS notifications");
    } finally {
      setFocused(originalFocused);
      __testOnly.clearSpawnOverride();
      restore();
    }
  });
});
