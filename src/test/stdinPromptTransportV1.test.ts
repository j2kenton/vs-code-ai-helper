/**
 * bugs3 Step 6: a stdin provider's prompt reaches the child as a regular-file
 * descriptor on POSIX (Cline 3.0.74 ignores Node's socket-backed pipe), whole,
 * from offset zero on every attempt, with nothing left on disk.
 */
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { CLI_PROVIDERS } from "../runners/providers";
import { openStdinPromptSourceV1, type StdinPromptFsV1 } from "../utils/stdinPromptTransportV1";

const IS_POSIX = process.platform !== "win32";

/** Reports what kind of stdin the child got and everything it read from it. */
const PROBE_SCRIPT = `
const fs = require("fs");
const kind = fs.fstatSync(0).isFile() ? "file" : fs.fstatSync(0).isFIFO() ? "fifo" : "other";
const text = fs.readFileSync(0, "utf8");
process.stdout.write(JSON.stringify({ kind, length: text.length, text }));
`;

function runProbe(prompt: string, tmpDir?: string): { kind: string; length: number; text: string } {
  const source = openStdinPromptSourceV1(prompt, tmpDir !== undefined ? { tmpDir } : {});
  try {
    const result = cp.spawnSync(process.execPath, ["-e", PROBE_SCRIPT], {
      stdio: source.stdio,
      input: source.writeToChildStdin ? prompt : undefined,
      encoding: "utf8",
    });
    return JSON.parse(result.stdout) as { kind: string; length: number; text: string };
  } finally {
    source.dispose();
  }
}

void describe("stdin prompt transport (bugs3 Step 6)", () => {
  void it("hands a POSIX child its 150 KB prompt as a regular file, complete", { skip: !IS_POSIX }, () => {
    const prompt = `BEGIN-MARKER\n${"line of context\n".repeat(10_000)}END-MARKER`;
    assert.ok(prompt.length > 150_000);
    const seen = runProbe(prompt);
    assert.equal(seen.kind, "file");
    assert.equal(seen.length, prompt.length);
    assert.equal(seen.text, prompt);
  });

  void it("keeps Unicode intact and delivers an empty prompt as EOF", { skip: !IS_POSIX }, () => {
    const unicode = "héllo — 日本語 — 😀\n".repeat(500);
    assert.equal(runProbe(unicode).text, unicode);
    const empty = runProbe("");
    assert.equal(empty.length, 0);
  });

  void it("works when the temporary folder's path has spaces", { skip: !IS_POSIX }, () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble stdin "));
    try {
      assert.equal(runProbe("with spaces", base).text, "with spaces");
      assert.deepEqual(fs.readdirSync(base), [], "no prompt file is left behind");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  void it("opens a fresh descriptor at offset zero for every attempt", { skip: !IS_POSIX }, () => {
    const first = openStdinPromptSourceV1("same prompt");
    const second = openStdinPromptSourceV1("same prompt");
    try {
      assert.notEqual(first.stdio[0], second.stdio[0]);
      for (const source of [first, second]) {
        const result = cp.spawnSync(process.execPath, ["-e", PROBE_SCRIPT], { stdio: source.stdio, encoding: "utf8" });
        assert.equal((JSON.parse(result.stdout) as { text: string }).text, "same prompt");
      }
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  void it("keeps Node's pipe on Windows, where the provider accepts it", () => {
    const source = openStdinPromptSourceV1("anything", { platform: "win32" });
    assert.deepEqual(source.stdio, ["pipe", "pipe", "pipe"]);
    assert.equal(source.writeToChildStdin, true);
    source.dispose();
  });

  void it("closes its descriptor once, and cleans up when the file cannot be written", () => {
    const calls: string[] = [];
    const fake: StdinPromptFsV1 = {
      mkdtempSync: (prefix) => {
        calls.push("mkdtemp");
        return `${prefix}x`;
      },
      writeFileSync: () => {
        calls.push("write");
      },
      openSync: () => {
        calls.push("open");
        return 42;
      },
      closeSync: (fd) => {
        calls.push(`close:${fd}`);
      },
      rmSync: () => {
        calls.push("rm");
      },
    };
    const source = openStdinPromptSourceV1("p", { platform: "linux", fs: fake });
    assert.deepEqual(source.stdio, [42, "pipe", "pipe"]);
    source.dispose();
    source.dispose();
    assert.deepEqual(calls, ["mkdtemp", "write", "open", "rm", "close:42"]);

    const failing: StdinPromptFsV1 = {
      ...fake,
      writeFileSync: () => {
        throw new Error("ENOSPC");
      },
    };
    calls.length = 0;
    assert.throws(() => openStdinPromptSourceV1("p", { platform: "linux", fs: failing }), /ENOSPC/);
    assert.deepEqual(calls, ["mkdtemp", "rm"]);
  });
});

void describe("stdin provider inventory (bugs3 Step 6)", () => {
  // Every provider whose prompt travels over stdin goes through
  // `openStdinPromptSourceV1` in both spawn paths, so each one needs live
  // owner smoke coverage. A new stdin provider must be added here on purpose.
  void it("lists exactly the providers that take their prompt on stdin", () => {
    const stdinProviders = CLI_PROVIDERS.filter((provider) => provider.promptTransport === "stdin").map(
      (provider) => provider.id
    );
    assert.deepEqual([...stdinProviders].sort(), ["cline-cli", "devpass-cli", "kiro-cli", "opencode-cli"]);
  });
});
