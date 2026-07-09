/**
 * Unit tests for the updated draftTaskWithAI behaviors:
 *
 * 1. parseAIResponse: robust heading matching (case, level, whitespace,
 *    CRLF, extra blank lines). Kept as focused regression coverage to
 *    complement the existing tests in taskTreeProvider.test.ts.
 * 2. parseAIResponse: hard failures for missing/duplicate/unrecognized
 *    sections remain strict.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAIResponse } from "../commands/draftTaskWithAI";

void describe("parseAIResponse — tolerant heading matching", () => {
  // ── Baseline valid response ──────────────────────────────────────────────

  void it("parses a standard response with ## headings", () => {
    const response = [
      "## Draft with AI",
      "",
      "The draft content.",
      "",
      "## Open Questions",
      "",
      "- Q1",
    ].join("\n");
    const result = parseAIResponse(response);
    assert.ok(result !== undefined);
    assert.strictEqual(result!.draftWithAI, "The draft content.");
    assert.strictEqual(result!.openQuestions, "- Q1");
  });

  // ── Heading level tolerance ──────────────────────────────────────────────

  void it("accepts # (h1) headings", () => {
    const response = [
      "# Draft with AI",
      "",
      "Draft body.",
      "",
      "# Open Questions",
      "",
      "- Q1",
    ].join("\n");
    const result = parseAIResponse(response);
    assert.ok(result !== undefined, "should accept h1 headings");
    assert.strictEqual(result!.draftWithAI, "Draft body.");
  });

  void it("accepts ### (h3) headings", () => {
    const response = [
      "### Draft with AI",
      "",
      "Draft body.",
      "",
      "### Open Questions",
      "",
      "- Q1",
    ].join("\n");
    const result = parseAIResponse(response);
    assert.ok(result !== undefined, "should accept h3 headings");
    assert.strictEqual(result!.draftWithAI, "Draft body.");
  });

  void it("accepts mixed heading levels across sections", () => {
    const response = [
      "## Draft with AI",
      "",
      "Draft.",
      "",
      "# Open Questions",
      "",
      "- Q1",
    ].join("\n");
    const result = parseAIResponse(response);
    assert.ok(result !== undefined, "should accept mixed heading levels");
  });

  // ── Case tolerance ───────────────────────────────────────────────────────

  void it("accepts all-uppercase headings", () => {
    const response = [
      "## DRAFT WITH AI",
      "",
      "Draft.",
      "",
      "## OPEN QUESTIONS",
      "",
      "- Q1",
    ].join("\n");
    const result = parseAIResponse(response);
    assert.ok(result !== undefined, "should accept uppercase headings");
    assert.strictEqual(result!.draftWithAI, "Draft.");
  });

  void it("accepts mixed-case headings", () => {
    const response = [
      "## Draft With AI",
      "",
      "Draft.",
      "",
      "## Open questions",
      "",
      "- Q1",
    ].join("\n");
    const result = parseAIResponse(response);
    assert.ok(result !== undefined, "should accept mixed-case headings");
  });

  // ── Trailing whitespace tolerance ────────────────────────────────────────

  void it("accepts trailing whitespace on heading lines", () => {
    const response = [
      "## Draft with AI   ",
      "",
      "Draft.",
      "",
      "## Open Questions  ",
      "",
      "- Q1",
    ].join("\n");
    const result = parseAIResponse(response);
    assert.ok(result !== undefined, "should accept trailing whitespace on headings");
  });

  // ── CRLF tolerance ───────────────────────────────────────────────────────

  void it("accepts CRLF line endings", () => {
    const response = [
      "## Draft with AI",
      "",
      "Draft body.",
      "",
      "## Open Questions",
      "",
      "- Q1",
    ].join("\r\n");
    const result = parseAIResponse(response);
    assert.ok(result !== undefined, "should accept CRLF line endings");
    assert.strictEqual(result!.draftWithAI, "Draft body.");
    assert.strictEqual(result!.openQuestions, "- Q1");
  });

  // ── Extra blank lines ────────────────────────────────────────────────────

  void it("preserves extra blank lines in body content", () => {
    const response = [
      "## Draft with AI",
      "",
      "",
      "Draft body.",
      "",
      "",
      "## Open Questions",
      "",
      "- Q1",
    ].join("\n");
    const result = parseAIResponse(response);
    assert.ok(result !== undefined, "should accept extra blank lines");
    assert.ok(result!.draftWithAI.includes("Draft body."));
  });

  // ── Empty section bodies ─────────────────────────────────────────────────

  void it("accepts empty section bodies (empty string after trim)", () => {
    const response = [
      "## Draft with AI",
      "",
      "## Open Questions",
      "",
    ].join("\n");
    const result = parseAIResponse(response);
    assert.ok(result !== undefined, "should accept empty bodies");
    assert.strictEqual(result!.draftWithAI, "");
    assert.strictEqual(result!.openQuestions, "");
  });
});

void describe("parseAIResponse — strict failures remain hard failures", () => {
  void it("returns undefined when Draft with AI section is missing", () => {
    const response = "## Open Questions\n\n- Q1";
    assert.strictEqual(parseAIResponse(response), undefined);
  });

  void it("returns undefined when Open Questions section is missing", () => {
    const response = "## Draft with AI\n\nDraft.";
    assert.strictEqual(parseAIResponse(response), undefined);
  });

  void it("returns undefined when sections are in wrong order", () => {
    const response = "## Open Questions\n\n- Q1\n\n## Draft with AI\n\nDraft.";
    assert.strictEqual(parseAIResponse(response), undefined);
  });

  void it("returns undefined when Draft with AI appears twice", () => {
    const response = [
      "## Draft with AI",
      "",
      "Draft 1.",
      "",
      "## Open Questions",
      "",
      "- Q1",
      "",
      "## Draft with AI",
      "",
      "Draft 2.",
    ].join("\n");
    assert.strictEqual(parseAIResponse(response), undefined);
  });

  void it("returns undefined when Open Questions appears twice", () => {
    const response = [
      "## Draft with AI",
      "",
      "Draft.",
      "",
      "## Open Questions",
      "",
      "- Q1",
      "",
      "## Open Questions",
      "",
      "- Q2",
    ].join("\n");
    assert.strictEqual(parseAIResponse(response), undefined);
  });

  void it("returns undefined when an unrecognized top-level heading is present", () => {
    const response = [
      "## Draft with AI",
      "",
      "Draft.",
      "",
      "## Open Questions",
      "",
      "- Q1",
      "",
      "## Extra Section",
      "",
      "Extra content.",
    ].join("\n");
    assert.strictEqual(parseAIResponse(response), undefined);
  });
});

void describe("parseAIResponse — body content extraction", () => {
  void it("body content between headings is extracted and trimmed", () => {
    const response = [
      "## Draft with AI",
      "",
      "  Content with leading space  ",
      "",
      "## Open Questions",
      "",
      "  - Q1  ",
    ].join("\n");
    const result = parseAIResponse(response);
    assert.ok(result !== undefined);
    // trim() is applied to the full body block
    assert.strictEqual(result!.draftWithAI, "Content with leading space");
    assert.strictEqual(result!.openQuestions, "- Q1");
  });

  void it("body content after Open Questions heading is extracted to end of response", () => {
    const response = [
      "## Draft with AI",
      "",
      "Draft text.",
      "",
      "## Open Questions",
      "",
      "Line 1.",
      "Line 2.",
      "Line 3.",
    ].join("\n");
    const result = parseAIResponse(response);
    assert.ok(result !== undefined);
    assert.ok(result!.openQuestions.includes("Line 1."));
    assert.ok(result!.openQuestions.includes("Line 2."));
    assert.ok(result!.openQuestions.includes("Line 3."));
  });
});
