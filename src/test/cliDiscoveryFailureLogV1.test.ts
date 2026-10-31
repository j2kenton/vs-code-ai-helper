/**
 * bugs3 Step 10: a discovery that fails (spawn error, timeout, non-zero exit,
 * unreadable output) is logged with the provider, command, exit code or
 * timeout and the first stderr lines, instead of silently leaving the picker
 * on its built-in list.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  boundDiscoveryStderrV1,
  discoverDevpassModelsWithTimeout,
  discoverKiroModelsWithTimeout,
  formatCliDiscoveryFailureV1,
  isEmptyCliCatalogOutputV1,
  setCliDiscoveryFailureSinkV1,
  type CliDiscoveryFailureV1,
} from "../utils/cliModelDiscovery";

function fakeCli(script: string): { command: string; dispose: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-discovery-"));
  const command = path.join(dir, "devpass-code");
  fs.writeFileSync(command, `#!/usr/bin/env node\n${script}\n`, { mode: 0o755 });
  return { command, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function collect(): CliDiscoveryFailureV1[] {
  const failures: CliDiscoveryFailureV1[] = [];
  setCliDiscoveryFailureSinkV1((failure) => failures.push(failure));
  return failures;
}

void describe("model discovery failure log", { skip: process.platform === "win32" }, () => {
  afterEach(() => setCliDiscoveryFailureSinkV1(undefined));

  void it("logs a non-zero exit with its code and the first stderr lines", async () => {
    const failures = collect();
    const { command, dispose } = fakeCli(
      'process.stderr.write("error: unknown option --verbose\\nline two\\n"); process.exit(3);'
    );
    try {
      assert.deepEqual(await discoverDevpassModelsWithTimeout(command, 10_000, () => Promise.resolve(1)), []);
    } finally {
      dispose();
    }
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.provider, "devpass-code");
    assert.equal(failures[0]!.reason, "exit");
    assert.equal(failures[0]!.exitCode, 3);
    assert.match(failures[0]!.command, /models --verbose/);
    assert.match(failures[0]!.stderrHead, /unknown option --verbose\nline two/);
    assert.match(formatCliDiscoveryFailureV1(failures[0]!), /exited with code 3; showing the built-in list/);
  });

  void it("a non-zero exit is a failure even when the output it printed first parses as a catalog", async () => {
    const failures = collect();
    const { command, dispose } = fakeCli(
      'process.stdout.write(JSON.stringify([{ id: "claude-opus-4.6", name: "Claude Opus 4.6" }])); process.stderr.write("error: partial\\n"); process.exit(2);'
    );
    try {
      assert.deepEqual(await discoverKiroModelsWithTimeout(command, 10_000), [], "a partial catalog is not offered as live");
    } finally {
      dispose();
    }
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.reason, "exit");
    assert.equal(failures[0]!.exitCode, 2);
    assert.match(failures[0]!.stderrHead, /error: partial/);
  });

  void it("logs a missing executable as a spawn failure", async () => {
    const failures = collect();
    const missing = path.join(os.tmpdir(), "definitely-not-installed-devpass-code");
    assert.deepEqual(await discoverDevpassModelsWithTimeout(missing, 10_000, () => Promise.resolve(1)), []);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.reason, "spawn");
  });

  void it("logs a timeout once, not again when the killed process closes", async () => {
    const failures = collect();
    const { command, dispose } = fakeCli("setTimeout(() => {}, 30000);");
    try {
      assert.deepEqual(await discoverDevpassModelsWithTimeout(command, 300, () => Promise.resolve(1)), []);
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      dispose();
    }
    assert.deepEqual(
      failures.map((failure) => failure.reason),
      ["timeout"]
    );
    assert.match(formatCliDiscoveryFailureV1(failures[0]!), /timed out/);
  });

  void it("logs exit 0 with unreadable output (a truncated 2.x response)", async () => {
    const failures = collect();
    const { command, dispose } = fakeCli('process.stdout.write(\'{"location":{},"data":[{"id":"a"\');');
    try {
      assert.deepEqual(await discoverDevpassModelsWithTimeout(command, 10_000, () => Promise.resolve(2)), []);
    } finally {
      dispose();
    }
    assert.deepEqual(
      failures.map((failure) => failure.reason),
      ["noModels"]
    );
  });

  void it("tells a successful empty catalog apart from unreadable output", async () => {
    const failures = collect();
    const { command, dispose } = fakeCli('process.stdout.write(\'{"location":{},"data":[]}\');');
    try {
      assert.deepEqual(await discoverDevpassModelsWithTimeout(command, 10_000, () => Promise.resolve(2)), []);
    } finally {
      dispose();
    }
    assert.deepEqual(
      failures.map((failure) => failure.reason),
      ["emptyCatalog"]
    );
    assert.match(formatCliDiscoveryFailureV1(failures[0]!), /answered successfully with an empty model list/);
  });

  void it("classifies listings: blank and empty JSON lists are empty, other text is unreadable", () => {
    for (const empty of ["", "  \n", "[]", '{"data":[]}', '{"models":[],"x":1}']) {
      assert.equal(isEmptyCliCatalogOutputV1(empty), true, JSON.stringify(empty));
    }
    for (const unreadable of ['{"data":[{"id":"a"', "not json", '{"data":[{"id":"a"}]}', "{}", '{"other":[]}']) {
      assert.equal(isEmptyCliCatalogOutputV1(unreadable), false, JSON.stringify(unreadable));
    }
  });

  void it("does not log a successful discovery", async () => {
    const failures = collect();
    const { command, dispose } = fakeCli(
      'process.stdout.write(\'llmgateway-devpass/a\\n{"id":"a","providerID":"llmgateway-devpass","name":"A"}\\n\');'
    );
    try {
      assert.equal((await discoverDevpassModelsWithTimeout(command, 10_000, () => Promise.resolve(1))).length, 1);
    } finally {
      dispose();
    }
    assert.deepEqual(failures, []);
  });

  void it("a throwing sink never breaks discovery", async () => {
    setCliDiscoveryFailureSinkV1(() => {
      throw new Error("sink exploded");
    });
    const { command, dispose } = fakeCli("process.exit(1);");
    try {
      assert.deepEqual(await discoverDevpassModelsWithTimeout(command, 10_000, () => Promise.resolve(1)), []);
    } finally {
      dispose();
    }
  });
});

void describe("boundDiscoveryStderrV1", () => {
  void it("keeps at most five non-empty lines and masks secret-looking values", () => {
    const stderr = [
      "",
      "request failed: Authorization: Bearer abcdefghijklmnop123456",
      "using api_key=llmg_supersecretvalue123",
      "token: hunter2hunter2",
      "line 4",
      "line 5",
      "line 6 is dropped",
    ].join("\n");
    const bounded = boundDiscoveryStderrV1(stderr);
    assert.equal(bounded.split("\n").length, 5);
    assert.doesNotMatch(bounded, /abcdefghijklmnop123456|supersecretvalue|hunter2/);
    assert.doesNotMatch(bounded, /line 6/);
  });

  void it("truncates a very long line", () => {
    assert.ok(boundDiscoveryStderrV1("x".repeat(5000)).length <= 300);
  });
});
