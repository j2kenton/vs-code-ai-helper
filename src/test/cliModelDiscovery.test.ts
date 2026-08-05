import * as assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import {
  discoverKiroModelsWithTimeout,
  discoverOpencodeModelsWithTimeout,
  parseAgyModelsOutput,
  parseKimiModelsOutput,
  parseKiroModelsOutput,
  parseOpencodeModelsOutput,
} from "../utils/cliModelDiscovery";

const requireModule = createRequire(__filename);
const childProcess = requireModule("node:child_process") as typeof import("node:child_process");

/**
 * Minimal fake ChildProcess for mocking cp.spawn in discovery tests.
 * runCliModelDiscovery (cliModelDiscovery.ts) spawns rather than execFiles
 * — see its doc comment for why (execFile's built-in timeout can't tree-kill
 * a grandchild process spawned via shell:true on Windows) — so these tests
 * mock spawn's actual event-emitter shape (stdout data events + a close
 * event carrying an exit code) instead of execFile's single callback.
 */
class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 4242;
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

void describe("parseAgyModelsOutput", () => {
  void it("parses simple line-based model output", () => {
    const parsed = parseAgyModelsOutput(
      [
        "Available models:",
        "gemini-2.5-pro",
        "gemini-2.5-flash",
      ].join("\n")
    );

    assert.deepStrictEqual(parsed, [
      { model: "gemini-2.5-pro", name: "gemini-2.5-pro" },
      { model: "gemini-2.5-flash", name: "gemini-2.5-flash" },
    ]);
  });

  void it("parses tabular output by taking the first column as the model id", () => {
    const parsed = parseAgyModelsOutput(
      [
        "MODEL                 DESCRIPTION",
        "gemini-2.5-pro        General-purpose model",
        "gemini-2.5-flash      Fast model",
      ].join("\n")
    );

    assert.deepStrictEqual(parsed, [
      { model: "gemini-2.5-pro", name: "gemini-2.5-pro" },
      { model: "gemini-2.5-flash", name: "gemini-2.5-flash" },
    ]);
  });

  void it("keeps multi-word display names whole when there is no id column (real `agy models` output)", () => {
    // `agy models` has no id/slug form at all — each line is the whole
    // display name, single-spaced, and that whole string is what `agy
    // --model` expects back verbatim (verified against the real CLI).
    const parsed = parseAgyModelsOutput(
      [
        "Gemini 3.5 Flash (Medium)",
        "Gemini 3.1 Pro (High)",
        "Claude Sonnet 4.6 (Thinking)",
        "GPT-OSS 120B (Medium)",
      ].join("\n")
    );

    assert.deepStrictEqual(parsed, [
      { model: "Gemini 3.5 Flash (Medium)", name: "Gemini 3.5 Flash (Medium)" },
      { model: "Gemini 3.1 Pro (High)", name: "Gemini 3.1 Pro (High)" },
      { model: "Claude Sonnet 4.6 (Thinking)", name: "Claude Sonnet 4.6 (Thinking)" },
      { model: "GPT-OSS 120B (Medium)", name: "GPT-OSS 120B (Medium)" },
    ]);
  });

  void it("cannot distinguish a single-space id/description pair from a multi-word name (known limitation)", () => {
    // Only a 2+-space or tab column separator is treated as tabular; a
    // single-space "id description" line (no CLI in this codebase emits
    // that today — Kiro requests --format json and agy has no id column)
    // is indistinguishable from a multi-word display name and is kept
    // whole rather than truncated to its first word.
    const parsed = parseAgyModelsOutput("gpt-oss-120b some fast model");

    assert.deepStrictEqual(parsed, [
      { model: "gpt-oss-120b some fast model", name: "gpt-oss-120b some fast model" },
    ]);
  });

  void it("parses JSON arrays and deduplicates repeated entries", () => {
    const parsed = parseAgyModelsOutput(
      JSON.stringify([
        { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
        { model: "gemini-2.5-flash" },
        { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
      ])
    );

    assert.deepStrictEqual(parsed, [
      { model: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
      { model: "gemini-2.5-flash", name: "gemini-2.5-flash" },
    ]);
  });

  void it("can recover models from partial line output", () => {
    const parsed = parseAgyModelsOutput(
      [
        "gemini-2.5-pro",
        "gemini-2.5-flash",
        "",
      ].join("\n")
    );

    assert.deepStrictEqual(parsed, [
      { model: "gemini-2.5-pro", name: "gemini-2.5-pro" },
      { model: "gemini-2.5-flash", name: "gemini-2.5-flash" },
    ]);
  });
});

void describe("parseKiroModelsOutput", () => {
  void it("parses JSON model output and deduplicates repeated entries", () => {
    const parsed = parseKiroModelsOutput(
      JSON.stringify([
        { id: "claude-opus-4.6", name: "Claude Opus 4.6" },
        { model: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
        { name: "deepseek-3.2", displayName: "DeepSeek 3.2" },
        { id: "claude-opus-4.6", name: "Claude Opus 4.6" },
      ])
    );

    assert.deepStrictEqual(parsed, [
      { model: "claude-opus-4.6", name: "Claude Opus 4.6" },
      { model: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
      { model: "deepseek-3.2", name: "DeepSeek 3.2" },
    ]);
  });

  void it("parses wrapped JSON model output", () => {
    const parsed = parseKiroModelsOutput(
      JSON.stringify({
        models: [
          { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
          { model: "deepseek-3.2", displayName: "DeepSeek 3.2" },
        ],
      })
    );

    assert.deepStrictEqual(parsed, [
      { model: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
      { model: "deepseek-3.2", name: "DeepSeek 3.2" },
    ]);
  });

  void it("parses plain model-list output as a fallback", () => {
    const parsed = parseKiroModelsOutput(
      [
        "MODEL                 DESCRIPTION",
        "claude-opus-4.6       Extended thinking",
        "claude-sonnet-4.5     Balanced",
      ].join("\n")
    );

    assert.deepStrictEqual(parsed, [
      { model: "claude-opus-4.6", name: "claude-opus-4.6" },
      { model: "claude-sonnet-4.5", name: "claude-sonnet-4.5" },
    ]);
  });

  void it("discovers models with Kiro's non-interactive chat mode", async () => {
    const originalSpawn = childProcess.spawn;
    let observedCommand: string | undefined;
    let observedArgs: readonly string[] | undefined;
    let observedOptions: { shell?: boolean; env?: NodeJS.ProcessEnv } | undefined;

    childProcess.spawn = ((
      command: string,
      args: readonly string[] = [],
      options?: { shell?: boolean; env?: NodeJS.ProcessEnv }
    ) => {
      observedCommand = command;
      observedArgs = [...args];
      observedOptions = options;
      const fake = new FakeChildProcess();
      process.nextTick(() => {
        fake.stdout.emit(
          "data",
          Buffer.from(
            JSON.stringify({
              models: [{ id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" }],
            })
          )
        );
        fake.emit("close", 0);
      });
      return fake as unknown as import("node:child_process").ChildProcess;
    }) as typeof childProcess.spawn;

    try {
      const parsed = await discoverKiroModelsWithTimeout("kiro-cli", 500);

      assert.strictEqual(observedCommand, "kiro-cli");
      assert.deepStrictEqual(observedArgs, [
        "chat",
        "--no-interactive",
        "--list-models",
        "--format",
        "json",
      ]);
      // kiro-cli installs as a native .exe (not an npm shim), so the
      // Windows-only shell:true workaround must NOT apply to it — only to
      // providers that actually need it (opencode's .cmd shim, tested
      // below). A wrong/missing shell flag here would mean the fix meant
      // for opencode accidentally changed every other provider's spawn
      // behavior instead of being scoped correctly.
      assert.strictEqual(observedOptions?.shell, process.platform === "win32");
      assert.deepStrictEqual(parsed, [
        { model: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
      ]);
    } finally {
      childProcess.spawn = originalSpawn;
    }
  });

  void it("tree-kills a hung discovery process on timeout instead of leaving it orphaned", async () => {
    // Regression guard for the actual bug this PR fixes: cp.execFile's
    // built-in `timeout` only terminates the interposed cmd.exe on Windows
    // (shell:true), leaving the real CLI process running as an orphaned
    // grandchild — verified live by spawning `cmd.exe /c ping ...` and
    // observing the ping.exe process survive execFile's timeout firing.
    // runCliModelDiscovery must call killProcessTree (taskkill /T on
    // Windows) on its own manual timeout instead of relying on execFile.
    const originalSpawn = childProcess.spawn;
    const originalPlatform = process.platform;
    let spawnedTaskkill = false;

    childProcess.spawn = ((
      command: string,
      args: readonly string[] = []
    ) => {
      if (command === "taskkill") {
        spawnedTaskkill = true;
        assert.ok(args.includes("/T"), "taskkill must use /T to kill the whole process tree");
        return new FakeChildProcess() as unknown as import("node:child_process").ChildProcess;
      }
      // The CLI itself: never closes on its own — simulates a hang.
      return new FakeChildProcess() as unknown as import("node:child_process").ChildProcess;
    }) as typeof childProcess.spawn;
    Object.defineProperty(process, "platform", { value: "win32" });

    try {
      const parsed = await discoverKiroModelsWithTimeout("kiro-cli", 20);
      assert.deepStrictEqual(parsed, []);
      assert.ok(spawnedTaskkill, "expected killProcessTree to spawn taskkill /T on timeout");
    } finally {
      childProcess.spawn = originalSpawn;
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  void it("drains stderr so a chatty CLI cannot block the pipe and hang discovery", async () => {
    // Regression guard: an earlier version attached a "data" listener only
    // to child.stdout, leaving child.stderr completely unread. On both
    // Windows and POSIX, once a child process writes more than the OS pipe
    // buffer (tens of KB) to a stream nobody is reading, its write() call
    // blocks forever waiting for a reader — reproduced directly with a real
    // child process (200KB to stderr, only stdout drained: the process
    // never closed, confirmed still running past its own timeout). That
    // hang would silently eat the full discovery timeout instead of
    // returning promptly. This test can't reproduce the real OS pipe
    // deadlock inside a unit test (the fake child's stderr is just an
    // EventEmitter, not a real OS pipe with a bounded buffer), but it does
    // assert the actual code contract that prevents it: stderr must have a
    // listener attached so Node keeps consuming it rather than pausing the
    // stream.
    const originalSpawn = childProcess.spawn;
    let fakeChild: FakeChildProcess | undefined;

    childProcess.spawn = (() => {
      fakeChild = new FakeChildProcess();
      process.nextTick(() => {
        fakeChild!.stdout.emit(
          "data",
          Buffer.from(JSON.stringify({ models: [{ id: "m", name: "M" }] }))
        );
        // Simulate the CLI also writing a large amount of stderr noise
        // before exiting — this must not prevent the close event/resolution.
        fakeChild!.stderr.emit("data", Buffer.alloc(200_000, "x"));
        fakeChild!.emit("close", 0);
      });
      return fakeChild as unknown as import("node:child_process").ChildProcess;
    }) as typeof childProcess.spawn;

    try {
      const parsed = await discoverKiroModelsWithTimeout("kiro-cli", 500);
      assert.deepStrictEqual(parsed, [{ model: "m", name: "M" }]);
      assert.ok(
        fakeChild!.stderr.listenerCount("data") > 0,
        "expected a stderr data listener to be attached so the OS pipe is actually drained"
      );
    } finally {
      childProcess.spawn = originalSpawn;
    }
  });
});

void describe("parseOpencodeModelsOutput", () => {
  // Shape captured live from `opencode models --verbose` (opencode 1.18.4):
  // repeating "<providerID>/<id>\n<pretty JSON object>\n" blocks, not a JSON
  // array — see parseOpencodeVerboseModels's doc comment.
  function verboseBlock(providerID: string, id: string, name: string, variants: Record<string, unknown>): string {
    return `${providerID}/${id}\n${JSON.stringify({ id, providerID, name, variants }, null, 2)}\n`;
  }

  void it("expands each model's declared variants into @variant-suffixed entries", () => {
    // deepseek-v4-flash's real variants are "high"/"max" (not a uniform
    // reasoning-effort ladder shared by every model — see north-mini-code-
    // free below, which has "none"/"high" instead).
    const output = verboseBlock("opencode", "deepseek-v4-flash", "DeepSeek V4 Flash", {
      high: { reasoningEffort: "high" },
      max: { reasoningEffort: "max" },
    });

    assert.deepStrictEqual(parseOpencodeModelsOutput(output), [
      { model: "opencode/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
      { model: "opencode/deepseek-v4-flash@high", name: "DeepSeek V4 Flash (high)" },
      { model: "opencode/deepseek-v4-flash@max", name: "DeepSeek V4 Flash (max)" },
    ]);
  });

  void it("handles a model whose variant set differs from the usual reasoning-effort ladder", () => {
    const output = verboseBlock("opencode", "north-mini-code-free", "North Mini Code Free", {
      none: { reasoningEffort: "none" },
      high: { reasoningEffort: "high" },
    });

    assert.deepStrictEqual(parseOpencodeModelsOutput(output), [
      { model: "opencode/north-mini-code-free", name: "North Mini Code Free" },
      { model: "opencode/north-mini-code-free@none", name: "North Mini Code Free (none)" },
      { model: "opencode/north-mini-code-free@high", name: "North Mini Code Free (high)" },
    ]);
  });

  void it("emits only the base model when variants is empty", () => {
    const output = verboseBlock("opencode", "big-pickle", "Big Pickle", {});

    assert.deepStrictEqual(parseOpencodeModelsOutput(output), [
      { model: "opencode/big-pickle", name: "Big Pickle" },
    ]);
  });

  void it("parses a compact single-line JSON block, not only opencode's own pretty-printed shape", () => {
    // The seeded catalog in modelSelection.ts is stored as compact
    // single-line JSON per block (to keep the compiled extension smaller)
    // and run through this same parser at load time — it must parse
    // identically to opencode's own pretty-printed output. Regression
    // guard: an earlier version of parseOpencodeVerboseModels only started
    // capturing a block on a line that was EXACTLY "{" (line.trim() ===
    // "{"), which never matches when the opening brace shares a line with
    // other JSON content — reproduced directly, it silently fell through
    // to the plain-line fallback parser instead (still returning a model
    // id from the header line, but no real display name).
    const compactBlock =
      'opencode/big-pickle\n{"id":"big-pickle","providerID":"opencode","name":"Big Pickle","variants":{"high":{},"max":{}}}\n';

    assert.deepStrictEqual(parseOpencodeModelsOutput(compactBlock), [
      { model: "opencode/big-pickle", name: "Big Pickle" },
      { model: "opencode/big-pickle@high", name: "Big Pickle (high)" },
      { model: "opencode/big-pickle@max", name: "Big Pickle (max)" },
    ]);
  });

  void it("ignores braces inside JSON string values (a model name containing '{' or '}')", () => {
    // Regression guard: an earlier version counted every "{"/"}" CHARACTER
    // in a line unconditionally, including ones inside JSON string values.
    // Reproduced directly against opencode's real pretty-printed multi-line
    // shape: a model named `"Weird } Stray Brace"` made brace depth hit
    // zero mid-object, so JSON.parse got fed a truncated/invalid buffer and
    // threw — the model vanished silently with no error, while the
    // following block still parsed fine. A stray "{" in a string is worse:
    // it can merge two blocks together and corrupt both. Model names/
    // descriptions are free text a provider controls, not something this
    // parser can assume is brace-free.
    const withStrayCloseBrace = [
      "opencode/weird-a",
      "{",
      '  "id": "weird-a",',
      '  "providerID": "opencode",',
      '  "name": "Weird } Stray Brace",',
      '  "variants": {',
      '    "high": {}',
      "  }",
      "}",
      "opencode/normal-b",
      "{",
      '  "id": "normal-b",',
      '  "providerID": "opencode",',
      '  "name": "Normal B",',
      '  "variants": {}',
      "}",
    ].join("\n");

    assert.deepStrictEqual(parseOpencodeModelsOutput(withStrayCloseBrace), [
      { model: "opencode/weird-a", name: "Weird } Stray Brace" },
      { model: "opencode/weird-a@high", name: "Weird } Stray Brace (high)" },
      { model: "opencode/normal-b", name: "Normal B" },
    ]);

    const withStrayOpenBrace = [
      "opencode/weird-c",
      "{",
      '  "id": "weird-c",',
      '  "providerID": "opencode",',
      '  "name": "Weird { Stray Brace",',
      '  "variants": {}',
      "}",
      "opencode/normal-d",
      "{",
      '  "id": "normal-d",',
      '  "providerID": "opencode",',
      '  "name": "Normal D",',
      '  "variants": {}',
      "}",
    ].join("\n");

    assert.deepStrictEqual(parseOpencodeModelsOutput(withStrayOpenBrace), [
      { model: "opencode/weird-c", name: "Weird { Stray Brace" },
      { model: "opencode/normal-d", name: "Normal D" },
    ]);
  });

  void it("honors escaped quotes inside strings when tracking string state", () => {
    // A `\"` inside a JSON string must not be mistaken for the string's
    // closing quote — otherwise the scanner would think it exited the
    // string early and start treating subsequent literal braces as
    // structural again.
    const withEscapedQuote =
      'opencode/weird-e\n{"id":"weird-e","providerID":"opencode","name":"Say \\"hi\\" } to me","variants":{}}\n';

    assert.deepStrictEqual(parseOpencodeModelsOutput(withEscapedQuote), [
      { model: "opencode/weird-e", name: 'Say "hi" } to me' },
    ]);
  });

  void it("parses mixed compact and pretty-printed blocks in the same input", () => {
    const mixed =
      'opencode/big-pickle\n{"id":"big-pickle","providerID":"opencode","name":"Big Pickle","variants":{}}\n' +
      verboseBlock("openai", "gpt-5", "GPT-5", { high: {} });

    assert.deepStrictEqual(parseOpencodeModelsOutput(mixed), [
      { model: "opencode/big-pickle", name: "Big Pickle" },
      { model: "openai/gpt-5", name: "GPT-5" },
      { model: "openai/gpt-5@high", name: "GPT-5 (high)" },
    ]);
  });

  void it("ignores a non-object variants value instead of emitting bogus numeric-index @0/@1 entries", () => {
    // Object.keys() on an array or string still returns numeric-index keys
    // rather than throwing ({ variants: ["high","max"] } -> ["0","1"]), so
    // a malformed/future-shape "variants" value must be explicitly rejected
    // rather than trusted — verified this would otherwise silently produce
    // "opencode/weird-model@0" picker entries with no real meaning.
    const arrayVariants = `opencode/weird-model\n${JSON.stringify(
      { id: "weird-model", providerID: "opencode", name: "Weird Model", variants: ["high", "max"] },
      null,
      2
    )}\n`;
    assert.deepStrictEqual(parseOpencodeModelsOutput(arrayVariants), [
      { model: "opencode/weird-model", name: "Weird Model" },
    ]);

    const stringVariants = `opencode/weird-model-2\n${JSON.stringify(
      { id: "weird-model-2", providerID: "opencode", name: "Weird Model 2", variants: "high" },
      null,
      2
    )}\n`;
    assert.deepStrictEqual(parseOpencodeModelsOutput(stringVariants), [
      { model: "opencode/weird-model-2", name: "Weird Model 2" },
    ]);
  });

  void it("parses multiple models across repeated blocks", () => {
    const output =
      verboseBlock("opencode", "big-pickle", "Big Pickle", {}) +
      verboseBlock("openai", "gpt-5", "GPT-5", { minimal: {}, low: {}, medium: {}, high: {} });

    const parsed = parseOpencodeModelsOutput(output);
    assert.deepStrictEqual(
      parsed.map((m) => m.model),
      [
        "opencode/big-pickle",
        "openai/gpt-5",
        "openai/gpt-5@minimal",
        "openai/gpt-5@low",
        "openai/gpt-5@medium",
        "openai/gpt-5@high",
      ]
    );
  });

  void it("falls back to plain line parsing when --verbose output doesn't parse as expected", () => {
    // Defends against a future opencode version changing --verbose's shape:
    // discovery should still surface bare model IDs from a plain
    // "provider/model" line listing rather than silently returning nothing.
    const parsed = parseOpencodeModelsOutput(
      ["openai/gpt-4o", "anthropic/claude-opus-4-8"].join("\n")
    );

    assert.deepStrictEqual(parsed, [
      { model: "openai/gpt-4o", name: "openai/gpt-4o" },
      { model: "anthropic/claude-opus-4-8", name: "anthropic/claude-opus-4-8" },
    ]);
  });

  void it("discovers models via `opencode models --verbose`, spawning with shell:true on Windows", async () => {
    // Regression guard for the actual bug this PR fixes: opencode installs
    // as an npm .cmd shim on Windows, and spawning without a shell fails
    // with "spawn opencode ENOENT" — verified live — which
    // runCliModelDiscovery previously swallowed into an empty (not
    // erroring) result. This test asserts the shell option directly rather
    // than only observing command/args, so a future regression back to
    // shell:false (or a dropped shell option entirely) fails this test
    // instead of passing silently.
    const originalSpawn = childProcess.spawn;
    const originalPlatform = process.platform;
    let observedCommand: string | undefined;
    let observedArgs: readonly string[] | undefined;
    let observedOptions: { shell?: boolean; env?: NodeJS.ProcessEnv } | undefined;

    childProcess.spawn = ((
      command: string,
      args: readonly string[] = [],
      options?: { shell?: boolean; env?: NodeJS.ProcessEnv }
    ) => {
      observedCommand = command;
      observedArgs = [...args];
      observedOptions = options;
      const fake = new FakeChildProcess();
      process.nextTick(() => {
        fake.stdout.emit(
          "data",
          Buffer.from(verboseBlock("opencode", "big-pickle", "Big Pickle", { high: {} }))
        );
        fake.emit("close", 0);
      });
      return fake as unknown as import("node:child_process").ChildProcess;
    }) as typeof childProcess.spawn;
    Object.defineProperty(process, "platform", { value: "win32" });

    try {
      const parsed = await discoverOpencodeModelsWithTimeout("opencode", 500);

      assert.strictEqual(observedCommand, "opencode");
      assert.deepStrictEqual(observedArgs, ["models", "--verbose"]);
      assert.strictEqual(observedOptions?.shell, true);
      assert.deepStrictEqual(parsed, [
        { model: "opencode/big-pickle", name: "Big Pickle" },
        { model: "opencode/big-pickle@high", name: "Big Pickle (high)" },
      ]);
    } finally {
      childProcess.spawn = originalSpawn;
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
});

void describe("parseKimiModelsOutput", () => {
  // Shape captured live from `kimi provider list --json` (kimi-code 0.29.2):
  // a "models" map keyed by the full "<provider>/<alias>" id, each value
  // carrying "displayName" and, for K3/K3-256k only, "supportEfforts".
  void it("expands a model's supportEfforts into @effort-suffixed entries", () => {
    const output = JSON.stringify({
      models: {
        "kimi-code/k3": {
          displayName: "K3",
          supportEfforts: ["low", "high", "max"],
          defaultEffort: "high",
        },
      },
    });

    assert.deepStrictEqual(parseKimiModelsOutput(output), [
      { model: "kimi-code/k3", name: "K3" },
      { model: "kimi-code/k3@low", name: "K3 (Low)" },
      { model: "kimi-code/k3@high", name: "K3 (High)" },
      { model: "kimi-code/k3@max", name: "K3 (Max)" },
    ]);
  });

  void it("emits only the base model for one with no supportEfforts (K2.7's always-on thinking)", () => {
    const output = JSON.stringify({
      models: {
        "kimi-code/kimi-for-coding": { displayName: "K2.7 Coding" },
      },
    });

    assert.deepStrictEqual(parseKimiModelsOutput(output), [
      { model: "kimi-code/kimi-for-coding", name: "K2.7 Coding" },
    ]);
  });

  void it("falls back to the model id when displayName is absent or blank", () => {
    const output = JSON.stringify({
      models: {
        "kimi-code/mystery-model": {},
        "kimi-code/blank-name": { displayName: "   " },
      },
    });

    assert.deepStrictEqual(parseKimiModelsOutput(output), [
      { model: "kimi-code/mystery-model", name: "kimi-code/mystery-model" },
      { model: "kimi-code/blank-name", name: "kimi-code/blank-name" },
    ]);
  });

  void it("drops an effort the selection parser would not recognize, rather than publishing an unrunnable model", () => {
    // Review finding: discovery accepted any non-blank effort string while
    // parseKimiModelSelection recognizes only low/high/max. An unexpected
    // "medium" became "kimi-code/k3@medium", which the parser could not
    // split back off — so buildArgs passed the whole suffixed id to -m and
    // Kimi rejected it ("Model ... is not configured in config.toml"),
    // turning a picker entry into a model that can never run. Both sides now
    // share KIMI_REASONING_EFFORTS_V1.
    const output = JSON.stringify({
      models: {
        "kimi-code/k3": {
          displayName: "K3",
          supportEfforts: ["low", "medium", "high", "max", "ultra"],
        },
      },
    });

    assert.deepStrictEqual(parseKimiModelsOutput(output), [
      { model: "kimi-code/k3", name: "K3" },
      { model: "kimi-code/k3@low", name: "K3 (Low)" },
      { model: "kimi-code/k3@high", name: "K3 (High)" },
      { model: "kimi-code/k3@max", name: "K3 (Max)" },
    ]);
  });

  void it("ignores a malformed supportEfforts value instead of throwing or producing bogus variants", () => {
    const output = JSON.stringify({
      models: {
        "kimi-code/odd-a": { displayName: "Odd A", supportEfforts: "low" },
        "kimi-code/odd-b": { displayName: "Odd B", supportEfforts: [42, "", "  ", "max"] },
      },
    });

    assert.deepStrictEqual(parseKimiModelsOutput(output), [
      { model: "kimi-code/odd-a", name: "Odd A" },
      { model: "kimi-code/odd-b", name: "Odd B" },
      { model: "kimi-code/odd-b@max", name: "Odd B (Max)" },
    ]);
  });

  void it("returns an empty array for empty, malformed, or shapeless input", () => {
    assert.deepStrictEqual(parseKimiModelsOutput(""), []);
    assert.deepStrictEqual(parseKimiModelsOutput("   "), []);
    assert.deepStrictEqual(parseKimiModelsOutput("not json"), []);
    assert.deepStrictEqual(parseKimiModelsOutput("null"), []);
    assert.deepStrictEqual(parseKimiModelsOutput("[]"), []);
    assert.deepStrictEqual(parseKimiModelsOutput('{"models": "not an object"}'), []);
  });
});
