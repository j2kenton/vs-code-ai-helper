import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import * as path from "node:path";

void test("completion final-fixes prompt exposes lint and context inputs", async () => {
  const promptPath = path.resolve(__dirname, "../../resources/prompts/final-fixes-code.md");
  const prompt = await readFile(promptPath, "utf8");
  assert.match(prompt, /Keep the task in the completed stage/);
  assert.match(prompt, /{{lint}}/);
  assert.match(prompt, /{{contextPack}}/);
});

void test("run-implementation prompt states the full suite runs once before Publish, not after each round", async () => {
  const promptPath = path.resolve(__dirname, "../../resources/prompts/run-implementation.md");
  const prompt = await readFile(promptPath, "utf8");
  // run1 Step 14: rounds run no checks at all; Ensemble's own post-round checks and Publish Checks do.
  assert.match(prompt, /Don't run the type check, lint, the tests or `verify`/);
  assert.match(prompt, /Publish Checks run the full test suite/);
  assert.match(prompt, /run once, in full, before Publish/);
  assert.doesNotMatch(
    prompt,
    /runs.*the full test suite.*after (the|this) round/i,
    "must never claim the full suite runs after an implementation round"
  );
});

void test("apply-impl-review-code prompt states the full suite runs once before Publish, not after each round", async () => {
  const promptPath = path.resolve(__dirname, "../../resources/prompts/apply-impl-review-code.md");
  const prompt = await readFile(promptPath, "utf8");
  assert.match(prompt, /the full test suite and `verify:workflow-safety` are NOT run again for this review/);
  assert.match(prompt, /run once, in full, before Publish/);
});
