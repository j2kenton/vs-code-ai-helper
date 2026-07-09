import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAgyModelsOutput } from "../utils/cliModelDiscovery";

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
