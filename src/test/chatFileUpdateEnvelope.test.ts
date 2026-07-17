/**
 * Coverage for the C4 chat-edit boundary: a stage-chat response may propose
 * updating exactly one markdown file that lives inside the active task's own
 * folder (see chatWithStage.ts). Envelope extraction, the all-or-nothing
 * update plan, and the path containment check are pure/VS-Code-free, so
 * they're tested directly here without a host.
 */
import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import {
  planFileUpdate,
  resolveMarkdownUpdateTarget,
  splitFileUpdateEnvelopes,
} from "../commands/chatWithStage";

// ---------------------------------------------------------------------------
// splitFileUpdateEnvelopes
// ---------------------------------------------------------------------------

void test("returns the text unchanged when no envelope is present", () => {
  const result = splitFileUpdateEnvelopes("just a normal answer");
  assert.equal(result.text, "just a normal answer");
  assert.deepEqual(result.updates, []);
});

void test("extracts the file path and content from an envelope", () => {
  const result = splitFileUpdateEnvelopes(
    "Sure, here's the update.\n\n[[UPDATE_FILE:plan.md]]\n# New Plan\n\nBody text.\n[[/UPDATE_FILE]]"
  );
  assert.equal(result.text, "Sure, here's the update.");
  assert.equal(result.updates.length, 1);
  assert.equal(result.updates[0]?.relPath, "plan.md");
  assert.equal(result.updates[0]?.content, "# New Plan\n\nBody text.");
});

void test("extracts every envelope and strips them all from the text", () => {
  const result = splitFileUpdateEnvelopes(
    "[[UPDATE_FILE:a.md]]one[[/UPDATE_FILE]] and [[UPDATE_FILE:b.md]]two[[/UPDATE_FILE]]"
  );
  assert.equal(result.updates.length, 2);
  assert.equal(result.updates[0]?.relPath, "a.md");
  assert.equal(result.updates[0]?.content, "one");
  assert.equal(result.updates[1]?.relPath, "b.md");
  assert.equal(result.updates[1]?.content, "two");
  // No envelope may survive into the displayed response.
  assert.ok(!result.text.includes("[[UPDATE_FILE"));
  assert.ok(!result.text.includes("[[/UPDATE_FILE]]"));
});

// ---------------------------------------------------------------------------
// planFileUpdate — the all-or-nothing policy
// ---------------------------------------------------------------------------

const TASK_FOLDER = path.join("C:", "tasks", "2026-07-16_task_1");

void test("plans no write when the response carries no envelope", () => {
  assert.deepEqual(planFileUpdate(TASK_FOLDER, []), { action: "none" });
});

void test("plans a write for a single valid markdown target", () => {
  const plan = planFileUpdate(TASK_FOLDER, [{ relPath: "plan.md", content: "# P" }]);
  assert.equal(plan.action, "write");
  if (plan.action === "write") {
    assert.equal(plan.targetPath, path.join(TASK_FOLDER, "plan.md"));
    assert.equal(plan.content, "# P");
  }
});

void test("rejects two envelopes atomically — zero writes even when both targets are valid", () => {
  const plan = planFileUpdate(TASK_FOLDER, [
    { relPath: "plan.md", content: "one" },
    { relPath: "task.md", content: "two" },
  ]);
  assert.equal(plan.action, "reject");
});

void test("rejects a valid-first-plus-invalid-second batch without writing the first", () => {
  const plan = planFileUpdate(TASK_FOLDER, [
    { relPath: "plan.md", content: "one" },
    { relPath: "../escape/plan.md", content: "two" },
  ]);
  assert.equal(plan.action, "reject");
});

void test("rejects a single envelope whose target fails the containment check", () => {
  const plan = planFileUpdate(TASK_FOLDER, [
    { relPath: "../other-task/plan.md", content: "x" },
  ]);
  assert.equal(plan.action, "reject");
});

// ---------------------------------------------------------------------------
// resolveMarkdownUpdateTarget
// ---------------------------------------------------------------------------

void test("resolves a plain markdown filename inside the task folder", () => {
  const resolved = resolveMarkdownUpdateTarget(TASK_FOLDER, "plan.md");
  assert.equal(resolved, path.join(TASK_FOLDER, "plan.md"));
});

void test("resolves a nested markdown path inside the task folder", () => {
  const resolved = resolveMarkdownUpdateTarget(TASK_FOLDER, "runs/notes.md");
  assert.equal(resolved, path.join(TASK_FOLDER, "runs", "notes.md"));
});

void test("rejects a non-markdown file", () => {
  assert.equal(resolveMarkdownUpdateTarget(TASK_FOLDER, "plan.ts"), undefined);
});

void test("rejects a path that escapes the task folder via ..", () => {
  assert.equal(
    resolveMarkdownUpdateTarget(TASK_FOLDER, "../other-task/plan.md"),
    undefined
  );
});

void test("rejects an absolute path outside the task folder", () => {
  assert.equal(
    resolveMarkdownUpdateTarget(TASK_FOLDER, path.join("C:", "tasks", "other", "plan.md")),
    undefined
  );
});

void test("rejects an empty path", () => {
  assert.equal(resolveMarkdownUpdateTarget(TASK_FOLDER, "   "), undefined);
});
