import * as assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import {
  discoverKiroModelsWithTimeout,
  parseAgyModelsOutput,
  parseKiroModelsOutput,
} from "../utils/cliModelDiscovery";

const requireModule = createRequire(__filename);
const childProcess = requireModule("node:child_process") as typeof import("node:child_process");

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
    const originalExecFile = childProcess.execFile;
    let observedCommand: string | undefined;
    let observedArgs: readonly string[] | undefined;

    childProcess.execFile = ((
      command: string,
      args: readonly string[] = [],
      _options: unknown,
      callback?: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      observedCommand = command;
      observedArgs = [...args];
      process.nextTick(() => {
        callback?.(
          null,
          JSON.stringify({
            models: [{ id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" }],
          }),
          ""
        );
      });
      return new EventEmitter() as import("node:child_process").ChildProcess;
    }) as typeof childProcess.execFile;

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
      assert.deepStrictEqual(parsed, [
        { model: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
      ]);
    } finally {
      childProcess.execFile = originalExecFile;
    }
  });
});
