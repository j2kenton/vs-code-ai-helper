import * as assert from "node:assert/strict";
import { test } from "node:test";
import { extractChatResponseText } from "../commands/chatWithStage";
import { buildAssistantPrompt } from "../commands/openGeneralAssistant";
import { TaskProgress } from "../types/taskProgress";

function progress(stage: TaskProgress["currentStage"] = "plan"): TaskProgress {
  return {
    taskFolder: "task",
    currentStage: stage,
    status: "active",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
  };
}

void test("assistant prompts contain task state, recent status, context, and the question", () => {
  const prompt = buildAssistantPrompt(
    { folderName: "task-42", progress: progress() },
    "# Context\nImportant repository details",
    [{ message: "Plan saved", level: "info", timestamp: "2026-07-13T10:00:00.000Z" }],
    "What should I do next?"
  );

  assert.match(prompt, /task task-42/);
  assert.match(prompt, /Plan saved/);
  assert.match(prompt, /Important repository details/);
  assert.match(prompt, /What should I do next\?/);
});

void test("stage chat surfaces completed summaries and rejects failed runs", () => {
  assert.equal(
    extractChatResponseText({
      runnerId: "copilot-lm",
      status: "completed",
      filesChanged: [],
      summary: "Use the existing abstraction.",
    }),
    "Use the existing abstraction."
  );

  assert.throws(
    () =>
      extractChatResponseText({
        runnerId: "copilot-lm",
        status: "failed",
        filesChanged: [],
        errorMessage: "Provider is unavailable.",
      }),
    /Provider is unavailable\./
  );
});
