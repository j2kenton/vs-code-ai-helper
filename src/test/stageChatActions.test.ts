/**
 * Coverage for the stage-chat action boundary: a stage-chat response may
 * propose exactly one of the FOUR pinned stage actions (complete stage, set
 * this task's stage, trigger this task's AI action, complete task) via the
 * shared typed `[[ACTION:id]]` envelope (legacy `[[STAGE_ACTION:id]]`
 * accepted); each id is a global-assistant operation id and executes through
 * the shared typed executor (executeProposedAction) with the chat's own task
 * pinned as the target. Envelope extraction, payload pinning, and the
 * allowlist registry are pure/VS-Code-free, so they're tested directly here
 * without a host.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildStageActionPayload,
  buildStageResponsePrompt,
  getStageChatAction,
  splitStageActionEnvelopes,
  STAGE_CHAT_ACTIONS,
} from "../commands/chatWithStage";
import { getGlobalAssistantOperation } from "../utils/globalAssistantActions";

void test("returns the text unchanged when no envelope is present", () => {
  const result = splitStageActionEnvelopes("just a normal answer");
  assert.equal(result.text, "just a normal answer");
  assert.deepEqual(result.actions, []);
});

void test("extracts the action id and strips the envelope from the text", () => {
  const result = splitStageActionEnvelopes(
    "Done — I'll mark the task complete.\n\n[[STAGE_ACTION:completeTask]]"
  );
  assert.equal(result.text, "Done — I'll mark the task complete.");
  assert.deepEqual(
    result.actions.map((a) => a.id),
    ["completeTask"]
  );
});

void test("extracts every envelope so multi-action responses can be rejected whole", () => {
  const result = splitStageActionEnvelopes(
    "[[STAGE_ACTION:completeStage]] and [[STAGE_ACTION:completeTask]]"
  );
  assert.equal(result.text, "and");
  assert.deepEqual(
    result.actions.map((a) => a.id),
    ["completeStage", "completeTask"]
  );
});

void test("no envelope survives into the displayed text even for unknown ids", () => {
  const result = splitStageActionEnvelopes("Answer. [[STAGE_ACTION:formatDisk]]");
  assert.ok(!result.text.includes("STAGE_ACTION"));
  assert.deepEqual(
    result.actions.map((a) => a.id),
    ["formatDisk"]
  );
});

void test("unknown action ids are not in the registry", () => {
  assert.equal(getStageChatAction("formatDisk"), undefined);
  assert.equal(getStageChatAction(""), undefined);
});

void test("the catalog is exactly the four approved pinned stage actions", () => {
  assert.deepEqual(
    STAGE_CHAT_ACTIONS.map((action) => action.id),
    ["completeStage", "setTaskStage", "triggerStageAI", "completeTask"]
  );
});

void test("every stage action executes through the shared typed executor", () => {
  for (const action of STAGE_CHAT_ACTIONS) {
    const operation = getGlobalAssistantOperation(action.id);
    assert.ok(
      operation,
      `${action.id} must be a global-assistant operation so it runs through executeProposedAction`
    );
    assert.equal(
      operation.requiresConfirmation,
      true,
      `${action.id} must be confirmation-gated`
    );
    // The executor receives the pinned {taskFolder} payload plus the
    // action's allowlisted pass-through keys (setTaskStage's "stage").
    const payload = buildStageActionPayload(
      action,
      "some-task",
      action.id === "setTaskStage" ? { stage: "plan" } : undefined
    );
    assert.equal(
      operation.validatePayload(payload),
      undefined,
      `${action.id} must accept the chat's pinned payload`
    );
    assert.ok(action.label.length > 0, `${action.id} needs a label`);
    assert.ok(action.description.length > 0, `${action.id} needs a description`);
    assert.equal(getStageChatAction(action.id), action);
  }
});

void test("the proposal payload can never retarget another task", () => {
  const setStage = getStageChatAction("setTaskStage");
  assert.ok(setStage);
  const payload = buildStageActionPayload(setStage, "the-chats-own-task", {
    taskFolder: "some-other-task",
    stage: "impl",
    extraneous: "dropped",
  });
  assert.deepEqual(payload, {
    stage: "impl",
    taskFolder: "the-chats-own-task",
  });

  // Actions with no allowlisted keys pass nothing through at all.
  const completeTask = getStageChatAction("completeTask");
  assert.ok(completeTask);
  assert.deepEqual(
    buildStageActionPayload(completeTask, "the-chats-own-task", {
      taskFolder: "some-other-task",
      stage: "impl",
    }),
    { taskFolder: "the-chats-own-task" }
  );
});

void test("stage prompt advertises the shared ACTION envelope and every action id", () => {
  const prompt = buildStageResponsePrompt("Plan", "my-task", "", "ctx", "msg");
  assert.ok(prompt.includes("[[ACTION:"), "prompt must advertise the shared typed envelope");
  assert.ok(prompt.includes("[[STAGE_ACTION:"), "prompt must mention the legacy form");
  for (const action of STAGE_CHAT_ACTIONS) {
    assert.ok(prompt.includes(action.id), `prompt must list ${action.id}`);
  }
});

void test("accepts the shared typed [[ACTION:...]] protocol alongside the legacy form", () => {
  const shared = splitStageActionEnvelopes("Marking done. [[ACTION:completeTask]]");
  assert.equal(shared.text, "Marking done.");
  assert.deepEqual(
    shared.actions.map((a) => a.id),
    ["completeTask"]
  );

  // A JSON payload is captured (setTaskStage needs its target stage); the
  // target task is still pinned by buildStageActionPayload at execution.
  const withPayload = splitStageActionEnvelopes(
    'Done. [[ACTION:setTaskStage {"stage": "impl"}]]'
  );
  assert.equal(withPayload.text, "Done.");
  assert.deepEqual(withPayload.actions, [
    { id: "setTaskStage", payload: { stage: "impl" } },
  ]);

  // An unparseable payload yields undefined — the operation's own
  // validation then rejects it with a useful message.
  const broken = splitStageActionEnvelopes("Done. [[ACTION:setTaskStage {not json}]]");
  assert.deepEqual(broken.actions, [{ id: "setTaskStage", payload: undefined }]);

  const mixed = splitStageActionEnvelopes(
    "[[ACTION:completeStage]] then [[STAGE_ACTION:completeTask]]"
  );
  assert.deepEqual(
    mixed.actions.map((a) => a.id),
    ["completeStage", "completeTask"]
  );
  assert.ok(!mixed.text.includes("ACTION"));
});
