import * as cp from "child_process";
import * as vscode from "vscode";
import { isDesktopNotificationsEnabled } from "../config/settings";

interface NotifyCommand {
  cmd: string;
  args: string[];
}

function psSingleQuote(value: string): string {
  // PowerShell single-quoted strings do not interpolate; doubling an
  // embedded quote is the only escape they support.
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * AppleScript string literals have no backslash escape for a newline — a
 * raw newline inside an `osascript -e` argument ends the statement rather
 * than continuing the string, which breaks any multi-line message (stack
 * traces, git/model output). Splitting on line boundaries and rejoining
 * with `& linefeed &` keeps the generated source on one physical line
 * while still producing a multi-line string value at runtime.
 */
function appleScriptString(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return escaped
    .split(/\r\n|\r|\n/)
    .map((line) => `"${line}"`)
    .join(" & linefeed & ");
}

/** notify-send renders the body as Pango markup; escape what it would parse as a tag/entity. */
function escapePangoMarkup(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Build the OS-specific command used to raise a native notification.
 * Kept separate from execution so escaping/argument construction can be
 * unit-tested without actually spawning a process.
 */
export function buildNotifyCommand(platform: NodeJS.Platform, title: string, message: string): NotifyCommand {
  if (platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "Add-Type -AssemblyName System.Drawing",
      "$n = New-Object System.Windows.Forms.NotifyIcon",
      "$n.Icon = [System.Drawing.SystemIcons]::Information",
      `$n.BalloonTipTitle = ${psSingleQuote(title)}`,
      `$n.BalloonTipText = ${psSingleQuote(message)}`,
      "$n.Visible = $true",
      "$n.ShowBalloonTip(6000)",
      "Start-Sleep -Seconds 6",
      "$n.Dispose()",
    ].join("\n");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    return {
      cmd: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
    };
  }
  if (platform === "darwin") {
    return {
      cmd: "osascript",
      args: ["-e", `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`],
    };
  }
  // "--" stops notify-send's option parser so a title/message that starts
  // with "-" is never mistaken for a flag; the body is Pango markup, so
  // escape the characters that would be parsed as one.
  return { cmd: "notify-send", args: ["--", title, escapePangoMarkup(message)] };
}

function realSpawn(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    try {
      cp.execFile(cmd, args, { windowsHide: true, timeout: 15000 }, () => resolve());
    } catch {
      resolve();
    }
  });
}

let spawnOverride: ((cmd: string, args: string[]) => Promise<void>) | undefined;

function fireOne(title: string, message: string): Promise<void> {
  const { cmd, args } = buildNotifyCommand(process.platform, title, message);
  return (spawnOverride ?? realSpawn)(cmd, args);
}

const MAX_MESSAGE_LENGTH = 300;

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function shouldSuppress(): boolean {
  // Nothing to opt into.
  if (!isDesktopNotificationsEnabled()) return true;
  // The user is looking at VS Code right now — the in-app status surface
  // (or the view that just opened) already shows this; an OS toast on top
  // would be redundant noise, not an alert.
  if (vscode.window.state.focused) return true;
  // Remote-SSH/WSL/Codespaces run the extension host on the remote machine —
  // process.platform reflects that host, not the machine the user is
  // physically looking at, so a native notification there alerts no one.
  if (vscode.env.remoteName) return true;
  return false;
}

// Serialize spawns so a burst of failures doesn't launch several concurrent
// PowerShell/WinForms processes at once (each holds a tray icon open for a
// few seconds); cap the backlog so a large failure cascade doesn't leave a
// long queue of stale toasts draining minutes later.
let queue: Promise<void> = Promise.resolve();
let queuedCount = 0;
const MAX_QUEUED = 3;

/**
 * Fire a native OS notification, independent of VS Code's own in-window-only
 * toasts, so it's visible even when VS Code isn't the focused window.
 * Best-effort: failures (missing notify-send on a headless box, etc.) are
 * swallowed rather than surfaced, since the status surface remains the
 * source of truth for everything this mirrors.
 */
export function notifyDesktop(title: string, message: string): void {
  const trimmedTitle = title.trim();
  const trimmedMessage = message.trim();
  // An empty BalloonTipText throws inside the (swallowed) Windows script,
  // so this would otherwise fail silently only on win32; nothing to show
  // anyway, and a long message makes a useless wall-of-text toast.
  if (!trimmedTitle || !trimmedMessage) return;
  if (queuedCount >= MAX_QUEUED) return;
  queuedCount++;
  const finalMessage = truncate(trimmedMessage, MAX_MESSAGE_LENGTH);
  queue = queue
    .then(() => (shouldSuppress() ? undefined : fireOne(trimmedTitle, finalMessage)))
    // shouldSuppress()/fireOne() touch vscode APIs that can throw during host
    // teardown; without this, one rejection poisons `queue` permanently —
    // every later call chains off an already-rejected promise whose .then()
    // callback never runs again, so notifications go silently dead for the
    // rest of the session (see taskStateStore.ts's withLocalMutationQueue
    // and statusView.ts's persist() for the same defensive pattern).
    .catch(() => undefined)
    .finally(() => {
      queuedCount--;
    });
}

export const __testOnly = {
  setSpawnOverride(fn: (cmd: string, args: string[]) => Promise<void>): void {
    spawnOverride = fn;
  },
  clearSpawnOverride(): void {
    spawnOverride = undefined;
  },
  async flush(): Promise<void> {
    await queue;
  },
};
