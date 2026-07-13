import * as assert from "node:assert/strict";
import { test } from "node:test";
import * as vscode from "vscode";
import {
  buildStageChatPrompt,
  resolveStageChatOutcome,
} from "../commands/chatWithStage";
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

void test("stage chat prompt includes task context and the user message", () => {
  const prompt = buildStageChatPrompt(
    "Plan",
    "task-42",
    "# Context\nImportant repository details",
    "What should I change?"
  );

  assert.match(prompt, /Plan stage/);
  assert.match(prompt, /task-42/);
  assert.match(prompt, /Important repository details/);
  assert.match(prompt, /What should I change\?/);
});

void test("stage chat handles completed, cancelled, and failed outcomes", () => {
  const output = vscode.Uri.file("/tmp/stage-chat.md");
  assert.deepEqual(
    resolveStageChatOutcome({
      status: "completed",
      outputFile: output,
    }),
    {
      kind: "completed",
      outputFile: output,
    }
  );

  assert.deepEqual(
    resolveStageChatOutcome({
      status: "cancelled",
    }),
    {
      kind: "cancelled",
    }
  );

  assert.throws(
    () =>
      resolveStageChatOutcome({
        status: "failed",
        errorMessage: "Provider is unavailable.",
      }),
    /Provider is unavailable\./
  );
});
