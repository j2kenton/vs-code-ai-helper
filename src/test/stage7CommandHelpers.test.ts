import * as assert from "node:assert/strict";
import { test } from "node:test";
import { clearPendingNoteForStage } from "../commands/applyCurrentStageAction";
import { buildAssistantPrompt } from "../commands/openGeneralAssistant";
import { TaskProgress } from "../types/taskProgress";

function progress(stage: TaskProgress["currentStage"] = "plan"): TaskProgress {
  return {
    taskFolder: "task",
    currentStage: stage,
    status: "active",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    pendingNotes: { plan: "Keep the API backwards compatible." },
  };
}

void test("a successful action cannot consume a pending note after its stage changed", () => {
  const current = progress("impl");
  const result = clearPendingNoteForStage(current, "plan");

  assert.strictEqual(result, current);
  assert.equal(result.pendingNotes?.plan, "Keep the API backwards compatible.");
});

void test("consuming a pending note preserves notes for other stages", () => {
  const current = { ...progress(), pendingNotes: { plan: "Plan note", desc: "Description note" } };
  const result = clearPendingNoteForStage(current, "plan");

  assert.equal(result.pendingNotes?.plan, undefined);
  assert.equal(result.pendingNotes?.desc, "Description note");
});

void test("assistant prompts contain task state, recent status, context, and the question", () => {
  const prompt = buildAssistantPrompt(
    { folderName: "task-42", progress: progress() },
    "# Context\nImportant repository details",
    [{ message: "Plan saved", level: "info", timestamp: "2026-07-13T10:00:00.000Z" }],
    "What should I do next?"
  );

  assert.match(prompt, /task task-42/);
  assert.match(prompt, /"pendingNotes"/);
  assert.match(prompt, /Plan saved/);
  assert.match(prompt, /Important repository details/);
  assert.match(prompt, /What should I do next\?/);
});
