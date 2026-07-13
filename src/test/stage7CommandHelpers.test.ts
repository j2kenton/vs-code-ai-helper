import * as assert from "node:assert/strict";
import { test } from "node:test";
import * as vscode from "vscode";
import {
  buildStageEditPrompt,
  buildStageChatPrompt,
  looksLikeStageEditRequest,
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

void test("stage edit prompt tells the model to make workspace changes", () => {
  const prompt = buildStageEditPrompt(
    "Plan",
    "task-42",
    "# Context\nImportant repository details",
    "Update task.md to reflect the latest clarifications."
  );

  assert.match(prompt, /Update the relevant task artifacts/);
  assert.match(prompt, /summarize what changed/);
});

void test("stage chat routes explicit file-update requests to implementation mode", () => {
  assert.equal(
    looksLikeStageEditRequest(
      [
        "update",
        "plans\\2026-07-12_task_2\\task.md",
        "to reflect clarifications found in",
        "plans\\2026-07-12_task_2\\runs\\stage-chat-1783947049280.md",
      ].join("\n")
    ),
    true
  );

  assert.equal(
    looksLikeStageEditRequest("Can you update task.md to reflect the latest review?"),
    true
  );

  assert.equal(
    looksLikeStageEditRequest("The scope changed, please update task.md accordingly."),
    true
  );

  assert.equal(
    looksLikeStageEditRequest("please review and update the plan"),
    true
  );

  assert.equal(
    looksLikeStageEditRequest("review this then update task.md"),
    true
  );

  assert.equal(
    looksLikeStageEditRequest("Please do this: update task.md"),
    true
  );

  assert.equal(
    looksLikeStageEditRequest("Note: please change the task description."),
    true
  );

  assert.equal(
    looksLikeStageEditRequest("What changed in task.md after the last review?"),
    false
  );

  assert.equal(
    looksLikeStageEditRequest("Explain the fix you applied to task.md."),
    false
  );

  assert.equal(
    looksLikeStageEditRequest("Can you explain how to update task.md?"),
    false
  );

  assert.equal(
    looksLikeStageEditRequest(
      "I looked at task.md, and fix looks like it's still pending from last time."
    ),
    false
  );

  assert.equal(
    looksLikeStageEditRequest(
      "In plan.md, remove seems like the wrong word choice in paragraph 2 - is that intentional?"
    ),
    false
  );

  assert.equal(
    looksLikeStageEditRequest(
      "The commit message says: fix the task file typo (already done, just asking)."
    ),
    false
  );

  assert.equal(
    looksLikeStageEditRequest(
      "Note: change the task description was already suggested in the review; do you agree?"
    ),
    false
  );

  assert.equal(
    looksLikeStageEditRequest(
      "FYI: update the plan file happened last week per the log."
    ),
    false
  );

  assert.equal(
    looksLikeStageEditRequest(
      "Action taken previously: fix the plan file resolved the issue last sprint."
    ),
    false
  );

  assert.equal(
    looksLikeStageEditRequest(
      "My request for context: fix the task file was already merged, just documenting."
    ),
    false
  );
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
