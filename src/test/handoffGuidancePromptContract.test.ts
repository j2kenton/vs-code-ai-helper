/**
 * Prompt-contract coverage for the manual-verification hand-off shape (task
 * "Actionable Hand-offs: one contract, nine surfaces", PART 2).
 *
 * The prompts that ask a model to author or report on a manual-verification
 * item are the only place that shape actually gets produced — there is no
 * application code that constructs this text, so the only way to guarantee
 * every manual check carries What / Why / How / If-it-fails / Priority is to
 * pin the instruction text itself. Labels are asserted against
 * `handoffGuidanceV1.ts`'s own exported constants rather than literal
 * strings, so this test and the render module can never drift apart on
 * wording.
 */
import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import * as path from "node:path";

import {
  HANDOFF_FAILURE_SIGNAL_LABELS_V1,
  HANDOFF_FIELD_LABELS_V1,
  HANDOFF_IMPACT_LABELS_V1,
} from "../types/handoffGuidanceV1";

async function readPrompt(fileName: string): Promise<string> {
  return readFile(path.resolve(__dirname, "../../resources/prompts", fileName), "utf8");
}

/** Builds a case-insensitive regex matching `label` as a whole word/phrase,
 * escaping any regex-special characters the label itself contains. */
function labelPattern(label: string): RegExp {
  return new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

void describe("manual-verification prompt contract", () => {
  const promptFiles = ["create-plan.md", "create-implementation.md", "run-implementation.md"];

  for (const fileName of promptFiles) {
    void it(`${fileName} requires the five hand-off elements for a manual/human-only check`, async () => {
      const prompt = await readPrompt(fileName);
      assert.match(
        prompt,
        labelPattern(HANDOFF_FIELD_LABELS_V1.action),
        `${fileName} must require a "${HANDOFF_FIELD_LABELS_V1.action}" element`
      );
      assert.match(
        prompt,
        labelPattern(HANDOFF_FIELD_LABELS_V1.reason),
        `${fileName} must require a "${HANDOFF_FIELD_LABELS_V1.reason}" element`
      );
      assert.match(
        prompt,
        labelPattern(HANDOFF_FIELD_LABELS_V1.method),
        `${fileName} must require a "${HANDOFF_FIELD_LABELS_V1.method}" element`
      );
      assert.match(
        prompt,
        labelPattern(HANDOFF_FAILURE_SIGNAL_LABELS_V1.failureSymptom),
        `${fileName} must require an "${HANDOFF_FAILURE_SIGNAL_LABELS_V1.failureSymptom}" element`
      );
      assert.match(
        prompt,
        labelPattern(HANDOFF_IMPACT_LABELS_V1.priority),
        `${fileName} must require a "${HANDOFF_IMPACT_LABELS_V1.priority}" element`
      );
    });

    void it(`${fileName} defines Priority domain-neutrally as HIGH (silent/damaging) vs LOW (loud/recoverable)`, async () => {
      const prompt = await readPrompt(fileName);
      assert.match(prompt, /HIGH/);
      assert.match(prompt, /LOW/);
      assert.match(prompt, /silent/i);
      assert.match(prompt, /damag/i);
      assert.match(prompt, /(loud|recoverable)/i);
      // Domain-neutral: priority must be derived from failure cost, not from
      // a fixed notion tied to source-code write paths.
      assert.match(prompt, /(project|domain|kind of project)/i);
    });

    void it(`${fileName} requires a LOW item to name that skipping it is acceptable`, async () => {
      const prompt = await readPrompt(fileName);
      assert.match(prompt, /skip/i);
    });

    void it(`${fileName} states evidence renders below the guidance, never instead of it`, async () => {
      const prompt = await readPrompt(fileName);
      assert.match(prompt, /evidence/i);
      assert.match(prompt, /below/i);
    });

    // Review finding (2026-08-22): both authoring prompts required the five
    // labels in the abstract but never showed a filled-in example, so a model
    // reading only the instructions had no worked shape to imitate. Pinning
    // the worked example itself (not just its labels) closes that gap and
    // keeps the three prompts from drifting apart on which example they show.
    void it(`${fileName} includes a worked example with a concrete What/Why/How/If-it-fails/Priority filled in`, async () => {
      const prompt = await readPrompt(fileName);
      assert.match(prompt, /Worked example/i, `${fileName} must include a worked example of the hand-off shape, not just the labels`);
      assert.match(prompt, /staging/i, "the worked example must be present verbatim (staging-import scenario)");
      assert.match(prompt, /HIGH priority/);
    });
  }
});
