/**
 * bugs3 Step 6: how a `promptTransport: "stdin"` provider is handed its prompt.
 *
 * Node's default `'pipe'` stdio is a Unix domain socket on Linux and macOS.
 * Cline 3.0.74 appends piped input to its prompt only when stdin is a FIFO or a
 * regular file, so a prompt written to `child.stdin` never arrived and the
 * model worked from the argv placeholder alone. On POSIX the prompt is
 * therefore written to a private file and the child's stdin IS that file
 * (opened fresh, at offset zero, for every spawn attempt). The file is
 * unlinked as soon as it is open, so nothing is left on disk whatever happens
 * to the process. Windows keeps Node's named-pipe stdin, where the provider
 * accepts it.
 */
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

export interface StdinPromptSourceV1 {
  /** The `stdio` option to spawn with. */
  readonly stdio: ["pipe" | number, "pipe", "pipe"];
  /**
   * True when the caller must still write the prompt to `child.stdin`
   * (the pipe transport); false when stdin already is the prompt file.
   */
  readonly writeToChildStdin: boolean;
  /** Release the parent's descriptor. Idempotent; safe before or after spawn. */
  dispose(): void;
}

export interface StdinPromptFsV1 {
  mkdtempSync(prefix: string): string;
  writeFileSync(path: string, data: string, options: { mode: number }): void;
  openSync(path: string, flags: "r"): number;
  closeSync(fd: number): void;
  rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
}

export interface OpenStdinPromptSourceOptionsV1 {
  readonly platform?: NodeJS.Platform;
  readonly tmpDir?: string;
  readonly fs?: StdinPromptFsV1;
}

/**
 * Prepare the child's stdin for `prompt`. Throws when the private file cannot be
 * created on POSIX: the caller reports a spawn failure rather than silently
 * falling back to a transport the provider may ignore.
 */
export function openStdinPromptSourceV1(prompt: string, options: OpenStdinPromptSourceOptionsV1 = {}): StdinPromptSourceV1 {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return { stdio: ["pipe", "pipe", "pipe"], writeToChildStdin: true, dispose: () => undefined };
  }
  const fs: StdinPromptFsV1 = options.fs ?? nodeFs;
  const dir = fs.mkdtempSync(nodePath.join(options.tmpDir ?? nodeOs.tmpdir(), "ensemble-stdin-"));
  let fd: number | undefined;
  try {
    const file = nodePath.join(dir, "prompt.txt");
    fs.writeFileSync(file, prompt, { mode: 0o600 });
    fd = fs.openSync(file, "r");
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already unusable.
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  // The open descriptor keeps the content alive; nothing needs to stay on disk.
  fs.rmSync(dir, { recursive: true, force: true });
  const openFd = fd;
  let closed = false;
  return {
    stdio: [openFd, "pipe", "pipe"],
    writeToChildStdin: false,
    dispose: () => {
      if (closed) {
        return;
      }
      closed = true;
      try {
        fs.closeSync(openFd);
      } catch {
        // Already closed.
      }
    },
  };
}
