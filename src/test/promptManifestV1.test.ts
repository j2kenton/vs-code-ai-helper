import * as assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "crypto";
import { buildPromptManifestV1 } from "../utils/promptManifestV1";
import { canonicalJsonByteLengthV1 } from "../types/structuredQuestionV1";

// ---------------------------------------------------------------------------
// buildPromptManifestV1 (item 17a/18 — Part 2 step 7)
// ---------------------------------------------------------------------------

const ROUND_ID = "0123456789abcdef0123456789abcdef";

void test("records templateName, per-variable byte size and sha256, and total prompt bytes", () => {
  const variables = { contextPack: "hello", plan: "world" };
  const prompt = "hello\n\nworld";
  const manifest = buildPromptManifestV1("run-implementation.md", variables, prompt, true, ROUND_ID);

  assert.equal(manifest.templateName, "run-implementation.md");
  assert.equal(manifest.totalPromptBytes, Buffer.byteLength(prompt, "utf8"));
  assert.equal(manifest.variables.length, 2);

  const contextPackEntry = manifest.variables.find((v) => v.name === "contextPack");
  assert.ok(contextPackEntry);
  assert.equal(contextPackEntry.bytes, Buffer.byteLength("hello", "utf8"));
  assert.equal(
    contextPackEntry.sha256,
    createHash("sha256").update("hello", "utf8").digest("hex")
  );

  const planEntry = manifest.variables.find((v) => v.name === "plan");
  assert.ok(planEntry);
  assert.equal(planEntry.bytes, Buffer.byteLength("world", "utf8"));
});

void test("records the caller-allocated roundId verbatim", () => {
  const manifest = buildPromptManifestV1("run-implementation.md", { plan: "x" }, "x", true, ROUND_ID);
  assert.equal(manifest.roundId, ROUND_ID);
});

void test("totalCanonicalBytes matches canonicalJsonByteLengthV1 over templateName + variables, and differs from totalPromptBytes", () => {
  const variables = { contextPack: "hello", plan: "world" };
  const prompt = "hello\n\nworld";
  const manifest = buildPromptManifestV1("run-implementation.md", variables, prompt, true, ROUND_ID);

  assert.equal(
    manifest.totalCanonicalBytes,
    canonicalJsonByteLengthV1({ templateName: "run-implementation.md", variables })
  );
  // The canonical encoding adds JSON structural overhead (quotes, braces,
  // key names) on top of the raw dispatched-prompt bytes, so the two figures
  // are not expected to coincide — this manifest deliberately reports both.
  assert.notEqual(manifest.totalCanonicalBytes, manifest.totalPromptBytes);
});

void test("multi-byte UTF-8 content is measured in bytes, not characters", () => {
  const text = "héllo wörld — 日本語";
  const manifest = buildPromptManifestV1("run-implementation.md", { plan: text }, text, true, ROUND_ID);
  const entry = manifest.variables.find((v) => v.name === "plan");
  assert.ok(entry);
  assert.equal(entry.bytes, Buffer.byteLength(text, "utf8"));
  assert.notEqual(entry.bytes, text.length);
});

void test("detects an '## Accepted Non-Goals' heading in any variable", () => {
  const manifest = buildPromptManifestV1(
    "apply-impl-review-code.md",
    { approvedPlan: "# Plan\n\nSome text", implementation: "## Accepted Non-Goals\n\nsome content" },
    "irrelevant",
    true,
    ROUND_ID
  );
  assert.equal(manifest.planSections.acceptedNonGoals, true);
  assert.equal(manifest.planSections.humanVerificationHandoffs, false);
});

void test("detects a '## Human Verification Hand-offs' heading in any variable", () => {
  const manifest = buildPromptManifestV1(
    "run-implementation.md",
    { plan: "## Human Verification Hand-offs\n\nsome content" },
    "irrelevant",
    true,
    ROUND_ID
  );
  assert.equal(manifest.planSections.humanVerificationHandoffs, true);
  assert.equal(manifest.planSections.acceptedNonGoals, false);
});

void test("reports both plan sections false when neither heading is present", () => {
  const manifest = buildPromptManifestV1(
    "run-implementation.md",
    { plan: "# Plan\n\nJust ordinary content, no special sections." },
    "irrelevant",
    true,
    ROUND_ID
  );
  assert.equal(manifest.planSections.acceptedNonGoals, false);
  assert.equal(manifest.planSections.humanVerificationHandoffs, false);
});

void test("promptCaptureComplete records whether the retained text is what the provider actually received", () => {
  const cliManifest = buildPromptManifestV1("run-implementation.md", { plan: "x" }, "x", true, ROUND_ID);
  assert.equal(cliManifest.promptCaptureComplete, true);

  const copilotSealedManifest = buildPromptManifestV1("run-implementation.md", { plan: "x" }, "x", false, ROUND_ID);
  assert.equal(copilotSealedManifest.promptCaptureComplete, false);
});

void test("a heading mentioned only in prose (not as a markdown heading) is not detected", () => {
  const manifest = buildPromptManifestV1(
    "run-implementation.md",
    { plan: "This plan has no Accepted Non-Goals section and no Human Verification Hand-offs either." },
    "irrelevant",
    true,
    ROUND_ID
  );
  assert.equal(manifest.planSections.acceptedNonGoals, false);
  assert.equal(manifest.planSections.humanVerificationHandoffs, false);
});
