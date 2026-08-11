/**
 * Layout tests for the task.md builder/parser:
 *  - an empty description gets the 15-blank-line typing gap;
 *  - an empty draft gets the bracketed Draft with AI hint;
 *  - the hint is stripped on parse (never leaks into taskDescription or the
 *    draft body);
 *  - build → parse → build round-trips are byte-stable (no accumulated blank
 *    lines, no duplicated hints);
 *  - the empty document equals the packaged task-template.md byte-for-byte.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

import {
  buildTaskDocument,
  DRAFT_WITH_AI_HINT,
  EMPTY_DESCRIPTION_GAP_LINES,
  parseTaskDocument,
} from "../utils/taskDescriptionDocument";

const EMPTY_DOC = buildTaskDocument({
  introText: "",
  taskDescription: "",
  draftWithAI: "",
  openQuestions: "",
});

void describe("task document layout", () => {
  void it("an empty description renders the 15-blank-line typing gap", () => {
    const gap = /## Task Description(\n+)## Draft with AI/.exec(EMPTY_DOC);
    assert.ok(gap, "headings must be adjacent apart from the gap");
    // N blank lines = N+1 newline characters between the two heading lines.
    assert.equal(gap[1]!.length, EMPTY_DESCRIPTION_GAP_LINES + 1);
  });

  void it("an empty draft renders the bracketed hint under ## Draft with AI", () => {
    assert.ok(EMPTY_DOC.includes(`## Draft with AI\n\n${DRAFT_WITH_AI_HINT}\n`));
  });

  void it("a non-empty description suppresses the gap; a non-empty draft suppresses the hint", () => {
    const doc = buildTaskDocument({
      introText: "",
      taskDescription: "Fix the flux capacitor.",
      draftWithAI: "### Behavior change\n\nIt fluxes.",
      openQuestions: "",
    });
    assert.doesNotMatch(doc, /\n{4,}/, "no tall gap when the description is present");
    assert.ok(!doc.includes(DRAFT_WITH_AI_HINT), "no hint when the draft is present");
  });

  void it("parse strips the hint so it never leaks into parsed content", () => {
    const parsed = parseTaskDocument(EMPTY_DOC);
    assert.equal(parsed.taskDescription, "");
    assert.equal(parsed.draftWithAI, "");
  });

  void it("build → parse → build is byte-stable for the empty document", () => {
    const rebuilt = buildTaskDocument(parseTaskDocument(EMPTY_DOC));
    assert.equal(rebuilt, EMPTY_DOC);
    const rebuiltTwice = buildTaskDocument(parseTaskDocument(rebuilt));
    assert.equal(rebuiltTwice, EMPTY_DOC, "no accumulated blank lines or duplicated hints");
  });

  void it("build → parse → build is byte-stable with real content", () => {
    const doc = buildTaskDocument({
      introText: "",
      taskDescription: "Fix the flux capacitor.",
      draftWithAI: "### Behavior change\n\nIt fluxes.",
      openQuestions: "",
    });
    const rebuilt = buildTaskDocument(parseTaskDocument(doc));
    assert.equal(rebuilt, doc);
  });

  void it("a description typed inside the gap survives the round-trip without the gap", () => {
    const withTyping = EMPTY_DOC.replace(
      "## Task Description\n",
      "## Task Description\n\nShip the widget.\n"
    );
    const parsed = parseTaskDocument(withTyping);
    assert.equal(parsed.taskDescription, "Ship the widget.");
    assert.equal(parsed.draftWithAI, "", "the hint must not leak into the draft body");
  });

  void it("the empty document equals the packaged task-template.md byte-for-byte", () => {
    const template = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "resources", "prompts", "task-template.md"),
      "utf8"
    ).replace(/\r\n/g, "\n");
    assert.equal(EMPTY_DOC, template);
  });
});
