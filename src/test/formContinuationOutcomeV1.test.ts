/**
 * bugs4 item 6: applying the open-items form always ends in ONE plain chat
 * outcome — the dispatched round, the Advance card, or a refusal with its reason
 * and the next step. Never a pop-up alone, never silence, and never a second
 * dispatch racing the form's own.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { after, afterEach, describe, it } from "node:test";
import * as vscode from "vscode";

import { continueAfterOpenPlanItemDecisionsV1 } from "../commands/decideOpenPlanItemsV1";
import {
  clearFormPlanWriteMarkerV1,
  FORM_PLAN_WRITE_MARKER_WINDOW_MS_V1,
  isFormContinuationPendingV1,
  isFormPlanWriteContentV1,
  markFormPlanWriteV1,
} from "../utils/formPlanWriteMarkerV1";
import { recordStageActionRefusalReasonV1, takeStageActionRefusalReasonV1 } from "../utils/stageActionRefusalV1";
import { makeOwnedTaskFolder } from "./taskFolderFixture";

const OPEN_PLAN = ["<!-- ensemble:implementation-checklist -->", "", "- [x] Done one", "- [ ] Still open", ""].join("\n");

function installExecuteCommand(handler: (command: string, arg: unknown) => Promise<unknown>): {
  calls: string[];
  restore: () => void;
} {
  const calls: string[] = [];
  const commandsObj = vscode.commands as unknown as { _executeCommandOverride?: unknown };
  const prior = commandsObj._executeCommandOverride;
  commandsObj._executeCommandOverride = (command: string, arg?: unknown): Promise<unknown> => {
    calls.push(command);
    return handler(command, arg);
  };
  return {
    calls,
    restore: (): void => {
      commandsObj._executeCommandOverride = prior;
    },
  };
}

function taskWithPlan(plan: string | undefined): string {
  const { folder } = makeOwnedTaskFolder("ensemble-form-continuation-");
  if (plan !== undefined) {
    nodeFs.writeFileSync(nodePath.join(folder, "plan-final.md"), plan, "utf8");
  }
  return folder;
}

void describe("open-items form continuation always reports one chat outcome (bugs4 item 6)", () => {
  // Back workspace.fs with the real disk (the test stubs' default is unimplemented).
  const fsBridge = vscode.workspace.fs as unknown as Record<string, unknown>;
  const origReadFile = fsBridge.readFile;
  const origWriteFile = fsBridge.writeFile;
  fsBridge.readFile = async (uri: vscode.Uri): Promise<Uint8Array> =>
    new TextEncoder().encode(await nodeFs.promises.readFile(uri.fsPath, "utf8"));
  fsBridge.writeFile = async (uri: vscode.Uri, data: Uint8Array): Promise<void> => {
    await nodeFs.promises.writeFile(uri.fsPath, Buffer.from(data));
  };
  after(() => {
    fsBridge.readFile = origReadFile;
    fsBridge.writeFile = origWriteFile;
  });
  const folders: string[] = [];
  afterEach(() => {
    for (const f of folders.splice(0)) {
      clearFormPlanWriteMarkerV1(f);
      takeStageActionRefusalReasonV1(f);
    }
  });

  void it("a refused follow-up (admission held) is stated in the outcome with its reason and the next step", async () => {
    const folder = taskWithPlan(OPEN_PLAN);
    folders.push(folder);
    const exec = installExecuteCommand(() => {
      recordStageActionRefusalReasonV1(folder, '"main task for erase work" already has a stage action in progress — Implementation is running.');
      return Promise.resolve(undefined);
    });
    try {
      const text = await continueAfterOpenPlanItemDecisionsV1({ taskFolderPath: folder, stage: "impl", items: [] }, "t");
      assert.match(text, /The next step was not started: .*already has a stage action in progress/);
      assert.match(text, /2 item\(s\) are still open/);
      assert.match(text, /use Fast Forward or Apply Current Stage Action to continue/);
      assert.doesNotMatch(text, /pid|host|\.lock|admission-v1/i, "technical identifiers never appear in the chat outcome");
      assert.equal(exec.calls.length, 1, "exactly one dispatch");
    } finally {
      exec.restore();
    }
  });

  void it("a stale refusal reason from an earlier action is not blamed on this dispatch", async () => {
    const folder = taskWithPlan(OPEN_PLAN);
    folders.push(folder);
    recordStageActionRefusalReasonV1(folder, "an old refusal");
    const exec = installExecuteCommand(() => Promise.resolve(undefined));
    try {
      const text = await continueAfterOpenPlanItemDecisionsV1({ taskFolderPath: folder, stage: "impl", items: [] }, "t");
      assert.doesNotMatch(text, /old refusal/);
      assert.match(text, /stage action was dispatched to build them/);
    } finally {
      exec.restore();
    }
  });

  void it("an unreadable gate (no plan-final.md) names the problem instead of returning silently", async () => {
    const folder = taskWithPlan(undefined);
    folders.push(folder);
    const exec = installExecuteCommand(() => Promise.resolve(undefined));
    try {
      const text = await continueAfterOpenPlanItemDecisionsV1({ taskFolderPath: folder, stage: "impl", items: [] }, "t");
      assert.match(text, /Nothing was started: the completeness gate could not be read \(plan-final\.md is missing or unreadable\)/);
      assert.equal(exec.calls.length, 0);
    } finally {
      exec.restore();
    }
  });

  void it("a plan with nothing the gate can count is also named", async () => {
    const folder = taskWithPlan("# Plan\n\nNo checklist here.\n");
    folders.push(folder);
    const exec = installExecuteCommand(() => Promise.resolve(undefined));
    try {
      const text = await continueAfterOpenPlanItemDecisionsV1({ taskFolderPath: folder, stage: "impl", items: [] }, "t");
      assert.match(text, /has no checklist the gate can count/);
      assert.equal(exec.calls.length, 0);
    } finally {
      exec.restore();
    }
  });

  void it("with nothing left open the outcome is the Advance offer, and no round is dispatched", async () => {
    const folder = taskWithPlan(
      ["<!-- ensemble:implementation-checklist -->", "", "- [ ] Owner hand-off <!-- ensemble:excluded -->", ""].join("\n")
    );
    folders.push(folder);
    const exec = installExecuteCommand(() => Promise.resolve(undefined));
    try {
      const text = await continueAfterOpenPlanItemDecisionsV1({ taskFolderPath: folder, stage: "impl", items: [] }, "t");
      assert.match(text, /Every plan item is now settled/);
      assert.match(text, /Advance to /);
      assert.equal(exec.calls.length, 0, "nothing is dispatched to build already-settled items");
    } finally {
      exec.restore();
    }
  });

  void it("a throwing dispatch becomes a chat outcome, not a pop-up", async () => {
    const folder = taskWithPlan(OPEN_PLAN);
    folders.push(folder);
    const exec = installExecuteCommand(() => Promise.reject(new Error("command exploded")));
    try {
      const text = await continueAfterOpenPlanItemDecisionsV1({ taskFolderPath: folder, stage: "impl", items: [] }, "t");
      assert.match(text, /arranging what runs next failed: command exploded/);
      assert.match(text, /Nothing else will run now/);
    } finally {
      exec.restore();
    }
  });

  void it("a task that left the stage is reported rather than silently skipped", async () => {
    const folder = taskWithPlan(OPEN_PLAN);
    folders.push(folder);
    const text = await continueAfterOpenPlanItemDecisionsV1({ taskFolderPath: folder, stage: "plan", items: [] }, "t");
    assert.match(text, /^Nothing was started: t is no longer on /);
  });
});

void describe("form plan-write marker (bugs4 item 6)", () => {
  void it("is pending only inside its window and only for the content the form wrote", () => {
    const folder = "/tmp/task-a";
    const at = 1_000_000;
    markFormPlanWriteV1(folder, "/tmp/task-a/plan-final.md", "plan v2", at);
    assert.equal(isFormContinuationPendingV1(folder, at + 1000), true);
    assert.equal(isFormPlanWriteContentV1(folder, "plan v2", at + 1000), true);
    assert.equal(isFormPlanWriteContentV1(folder, "someone else's edit", at + 1000), false);
    assert.equal(isFormContinuationPendingV1("/tmp/task-b", at + 1000), false, "another task is unaffected");
    // Window edges: still pending at the edge, expired just past it.
    assert.equal(isFormContinuationPendingV1(folder, at + FORM_PLAN_WRITE_MARKER_WINDOW_MS_V1), true);
    assert.equal(isFormContinuationPendingV1(folder, at + FORM_PLAN_WRITE_MARKER_WINDOW_MS_V1 + 1), false);
    assert.equal(isFormContinuationPendingV1(folder, at + 1000), false, "an expired marker is dropped");
  });

  void it("clearing it releases the follow-up", () => {
    const folder = "/tmp/task-c";
    markFormPlanWriteV1(folder, "/tmp/task-c/plan-final.md", "x");
    assert.equal(isFormContinuationPendingV1(folder), true);
    clearFormPlanWriteMarkerV1(folder);
    assert.equal(isFormContinuationPendingV1(folder), false);
  });
});
