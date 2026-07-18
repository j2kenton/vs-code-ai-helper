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
import {
  DRAFT_UNSTRUCTURED_HEADING,
  parseAIResponse,
  validateDraftStructure,
  wrapUnstructuredDraft,
} from "../commands/draftTaskWithAI";

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
    assert.strictEqual(result.draftWithAI, "The draft content.");
    assert.strictEqual(result.openQuestions, "- Q1");
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
    assert.strictEqual(result.draftWithAI, "Draft body.");
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
    assert.strictEqual(result.draftWithAI, "Draft body.");
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
    assert.strictEqual(result.draftWithAI, "Draft.");
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
    assert.strictEqual(result.draftWithAI, "Draft body.");
    assert.strictEqual(result.openQuestions, "- Q1");
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
    assert.ok(result.draftWithAI.includes("Draft body."));
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
    assert.strictEqual(result.draftWithAI, "");
    assert.strictEqual(result.openQuestions, "");
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
    assert.strictEqual(result.draftWithAI, "Content with leading space");
    assert.strictEqual(result.openQuestions, "- Q1");
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
    assert.ok(result.openQuestions.includes("Line 1."));
    assert.ok(result.openQuestions.includes("Line 2."));
    assert.ok(result.openQuestions.includes("Line 3."));
  });
});

void describe("parseAIResponse — draft subsection headings are body content", () => {
  void it("accepts the three required subsections under Draft with AI", () => {
    const response = [
      "## Draft with AI",
      "",
      "Goal sentence.",
      "",
      "### Behavior change",
      "",
      "The settings panel gains a third option.",
      "",
      "### Affected areas",
      "",
      "- settingsView.ts",
      "",
      "### Actionable changes",
      "",
      "- Add the enum.",
      "",
      "## Open Questions",
      "",
      "- None.",
    ].join("\n");
    const result = parseAIResponse(response);
    assert.ok(
      result !== undefined,
      "subsection headings must not be treated as unrecognized sections"
    );
    assert.ok(result.draftWithAI.includes("### Behavior change"));
    assert.ok(result.draftWithAI.includes("### Actionable changes"));
  });

  void it("still rejects genuinely unrecognized top-level headings", () => {
    const response = [
      "## Draft with AI",
      "",
      "Draft.",
      "",
      "## Random Section",
      "",
      "## Open Questions",
      "",
      "- Q1",
    ].join("\n");
    assert.strictEqual(parseAIResponse(response), undefined);
  });
});

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

  void it("a plain unstructured draft is invalid (triggers the repair retry)", () => {
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
