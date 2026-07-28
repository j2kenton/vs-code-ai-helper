/**
 * Unit tests for draftTaskWithAI's structural helpers that remain in use
 * after draft.v1's migration onto the coordinator (plan §6.3): the model's
 * completed content is now the coordinator's `markdown-artifact.v1` payload
 * directly (validated/decoded by the strict envelope decoder), not a
 * free-text "## Draft with AI"/"## Open Questions" response parsed by a
 * bespoke heading matcher — so `parseAIResponse` no longer exists.
 * `validateDraftStructure`/`wrapUnstructuredDraft` still apply the
 * three-required-subsection contract directly to that content.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DRAFT_UNSTRUCTURED_HEADING,
  validateDraftStructure,
  wrapUnstructuredDraft,
} from "../commands/draftTaskWithAI";

void describe("validateDraftStructure — three-subsection contract", () => {
  void it("accepts a draft carrying all three subsections", () => {
    const body = [
      "Goal sentence.",
      "### Behavior change",
      "x",
      "### Affected areas",
      "y",
      "### Actionable changes",
      "z",
    ].join("\n");
    assert.deepStrictEqual(validateDraftStructure(body), {
      valid: true,
      missing: [],
    });
  });

  void it("is tolerant of heading level and case", () => {
    const body = [
      "#### BEHAVIOR CHANGE",
      "x",
      "## affected areas",
      "y",
      "### Actionable Changes",
      "z",
    ].join("\n");
    assert.strictEqual(validateDraftStructure(body).valid, true);
  });

  void it("names each missing subsection", () => {
    const body = ["### Behavior change", "x"].join("\n");
    const result = validateDraftStructure(body);
    assert.strictEqual(result.valid, false);
    assert.deepStrictEqual(result.missing, [
      "Affected areas",
      "Actionable changes",
    ]);
  });

  void it("a plain unstructured draft is invalid (falls back to the unstructured wrap)", () => {
    const result = validateDraftStructure("Just prose with no subsections.");
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.missing.length, 3);
  });

  void it("subsection titles in prose (not headings) do not count", () => {
    const body =
      "The behavior change is X; affected areas are Y; actionable changes are Z.";
    assert.strictEqual(validateDraftStructure(body).valid, false);
  });

  void it("headings with EMPTY bodies are reported as missing", () => {
    // Exactly the non-actionable output the contract exists to prevent:
    // all three headings present, no content under any of them.
    const body = [
      "### Behavior change",
      "",
      "### Affected areas",
      "",
      "### Actionable changes",
      "",
    ].join("\n");
    const result = validateDraftStructure(body);
    assert.strictEqual(result.valid, false);
    assert.deepStrictEqual(result.missing, [
      "Behavior change",
      "Affected areas",
      "Actionable changes",
    ]);
  });

  void it("a single empty subsection among filled ones is reported", () => {
    const body = [
      "### Behavior change",
      "x",
      "### Affected areas",
      "",
      "   ",
      "### Actionable changes",
      "z",
    ].join("\n");
    const result = validateDraftStructure(body);
    assert.strictEqual(result.valid, false);
    assert.deepStrictEqual(result.missing, ["Affected areas"]);
  });

  void it("a trailing subsection with content up to end-of-body is valid", () => {
    const body = [
      "### Behavior change",
      "x",
      "### Affected areas",
      "y",
      "### Actionable changes",
      "final content with no trailing heading",
    ].join("\n");
    assert.strictEqual(validateDraftStructure(body).valid, true);
  });
});

void describe("wrapUnstructuredDraft — fallback heading contract", () => {
  void it("files the draft under the Draft (unstructured) heading with a notice", () => {
    const wrapped = wrapUnstructuredDraft("Just prose.", [
      "Behavior change",
      "Affected areas",
    ]);
    assert.ok(wrapped.startsWith(DRAFT_UNSTRUCTURED_HEADING));
    assert.match(wrapped, /Behavior change, Affected areas/);
    assert.match(wrapped, /Just prose\.$/);
    // The notice is a blockquote so it reads as an annotation, not content.
    assert.match(wrapped, /^> /m);
  });
});
