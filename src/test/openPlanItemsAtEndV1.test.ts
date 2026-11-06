/**
 * review1 Step 61: before Commit & Push commits, and before Mark Done completes a task, plan items that are neither
 * ticked nor excluded are listed as one chat decision ("Continue anyway" or "Stop"); no card when nothing is open;
 * the Publish review's prompt gets the open items so its verdict mentions them.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import { after, afterEach, describe, it } from "node:test";

import {
  buildOpenPlanItemsPublishNoteV1,
  confirmOpenPlanItemsAtEndV1,
  describeOpenPlanItemsAtEndV1,
  OPEN_PLAN_ITEMS_CONTINUE_OPTION_ID_V1,
  OPEN_PLAN_ITEMS_STOP_OPTION_ID_V1,
  readOpenPlanItemsAtEndV1,
} from "../commands/openPlanItemsAtEndV1";
import type { TaskProgress } from "../types/taskProgress";
import { EXCLUDED_CHECKLIST_ITEM_MARKER_V1 } from "../utils/implementationChecklist";
import type { AwaitedDecisionOutcomeV1, PostWorkflowDecisionInputV1 } from "../utils/workflowDecisionDispatchV1";

const ROOT = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ensemble-open-items-end-"));
after(() => {
  nodeFs.rmSync(ROOT, { recursive: true, force: true });
});

const fsApi = vscode.workspace.fs as unknown as { readFile: unknown };
const origReadFile = fsApi.readFile;
afterEach(() => {
  fsApi.readFile = origReadFile;
});

function makeTask(name: string, planLines: readonly string[], progress: Partial<TaskProgress> = {}): vscode.Uri {
  fsApi.readFile = async (uri: vscode.Uri): Promise<Uint8Array> =>
    new TextEncoder().encode(await nodeFs.promises.readFile(uri.fsPath, "utf8"));
  const folder = nodePath.join(ROOT, ".ensemble", name);
  nodeFs.mkdirSync(folder, { recursive: true });
  nodeFs.writeFileSync(
    nodePath.join(folder, "plan-final.md"),
    ["<!-- ensemble:implementation-checklist -->", "", ...planLines, ""].join("\n"),
    "utf8"
  );
  nodeFs.writeFileSync(
    nodePath.join(folder, "task-progress.json"),
    JSON.stringify({
      taskFolder: name,
      currentStage: "publish",
      status: "active",
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      ...progress,
    }),
    "utf8"
  );
  return vscode.Uri.file(folder);
}

interface AskRecorder {
  readonly inputs: PostWorkflowDecisionInputV1[];
  readonly ask: NonNullable<Parameters<typeof confirmOpenPlanItemsAtEndV1>[0]["ask"]>;
}

function asker(answer: string | undefined, outcome?: AwaitedDecisionOutcomeV1): AskRecorder {
  const inputs: PostWorkflowDecisionInputV1[] = [];
  return {
    inputs,
    ask: (input, _target, _token, onOutcome) => {
      inputs.push(input);
      if (outcome) onOutcome?.(outcome);
      return Promise.resolve(answer);
    },
  };
}

const M = EXCLUDED_CHECKLIST_ITEM_MARKER_V1;
const OPEN_PLAN = [
  "- [x] Step 1: Built",
  "- [ ] Step 2: Not built",
  `- [ ] Step 3: Owner hand-off ${M}`,
  "- [ ] Step 4: Also not built",
];
const SETTLED_PLAN = ["- [x] Step 1: Built", `- [ ] Step 2: Owner hand-off ${M}`];

void describe("review1 Step 61: open plan items before Commit & Push and Mark Done", () => {
  void it("lists the items that are neither ticked nor excluded, in plan order", async () => {
    const open = await readOpenPlanItemsAtEndV1(makeTask("lists", OPEN_PLAN));
    assert.deepEqual(open?.items, ["Step 2: Not built", "Step 4: Also not built"]);
  });

  void it("has nothing to say for a task with no plan-final.md checklist", async () => {
    const folder = nodePath.join(ROOT, ".ensemble", "no-plan");
    nodeFs.mkdirSync(folder, { recursive: true });
    assert.equal(await readOpenPlanItemsAtEndV1(vscode.Uri.file(folder)), undefined);
  });

  void it("posts no card when everything is ticked or excluded, and proceeds", async () => {
    const recorder = asker(OPEN_PLAN_ITEMS_STOP_OPTION_ID_V1);
    const verdict = await confirmOpenPlanItemsAtEndV1({
      taskFolderUri: makeTask("settled", SETTLED_PLAN),
      stage: "publish",
      command: "Commit & Push",
      ask: recorder.ask,
    });
    assert.equal(verdict, "proceed");
    assert.deepEqual(recorder.inputs, [], "no card");
  });

  void it("one open item posts one card; Commit & Push goes on only after Continue anyway", async () => {
    const uri = makeTask("one-open", ["- [x] Step 1: Built", "- [ ] Step 2: Not built"]);
    const stopped = asker(OPEN_PLAN_ITEMS_STOP_OPTION_ID_V1);
    assert.equal(
      await confirmOpenPlanItemsAtEndV1({ taskFolderUri: uri, stage: "publish", command: "Commit & Push", ask: stopped.ask }),
      "stop"
    );
    assert.equal(stopped.inputs.length, 1);
    const card = stopped.inputs[0]!;
    assert.deepEqual(
      card.options.map((option) => option.label),
      ["Continue anyway", "Stop"]
    );
    assert.match(card.whatHappened, /1 plan item is still neither ticked nor excluded/);
    assert.match(card.whatHappened, /Step 2: Not built/);
    assert.equal(card.gating?.waitingNothingDone, "committed");
    const carried = asker(OPEN_PLAN_ITEMS_CONTINUE_OPTION_ID_V1);
    assert.equal(
      await confirmOpenPlanItemsAtEndV1({ taskFolderUri: uri, stage: "publish", command: "Commit & Push", ask: carried.ask }),
      "proceed"
    );
  });

  void it("Stop, a dismissed card or a wait that ended without an answer completes nothing", async () => {
    const uri = makeTask("stops", OPEN_PLAN);
    for (const outcome of [{ kind: "dismissed" }, { kind: "timedOut" }, { kind: "interrupted" }] as const) {
      const recorder = asker(undefined, outcome);
      assert.equal(
        await confirmOpenPlanItemsAtEndV1({ taskFolderUri: uri, stage: "publish", command: "Mark Done", ask: recorder.ask }),
        "stop",
        outcome.kind
      );
    }
  });

  void it("with no chat available to ask, a pop-up asks; only its Continue anyway proceeds", async () => {
    const recorder = asker(undefined, { kind: "unavailable" });
    const messages: string[] = [];
    const run = (name: string, popUpAnswer: boolean): Promise<"proceed" | "stop"> =>
      confirmOpenPlanItemsAtEndV1({
        taskFolderUri: makeTask(name, OPEN_PLAN),
        stage: "publish",
        command: "Mark Done",
        ask: recorder.ask,
        askFallback: (message) => {
          messages.push(message);
          return Promise.resolve(popUpAnswer);
        },
      });
    assert.equal(await run("headless-continue", true), "proceed");
    assert.equal(await run("headless-dismissed", false), "stop", "a dismissed pop-up is a Stop");
    assert.equal(messages.length, 2);
    assert.match(messages[0]!, /neither ticked nor excluded/);
  });

  void it("a ticked parent with an unticked child is listed by that child, not skipped", async () => {
    const recorder = asker(OPEN_PLAN_ITEMS_STOP_OPTION_ID_V1);
    const folder = makeTask("nested-open", [
      "- [x] Step 1: Built parent",
      "  - [ ] Step 1a: unfinished child",
      "  - [x] Step 1b: finished child",
      "- [x] Step 2: Built",
    ]);
    const open = await readOpenPlanItemsAtEndV1(folder);
    assert.deepEqual(open?.items, ["Step 1a: unfinished child (under Step 1)"]);
    assert.equal(
      await confirmOpenPlanItemsAtEndV1({ taskFolderUri: folder, stage: "publish", command: "Commit & Push", ask: recorder.ask }),
      "stop"
    );
    assert.match(recorder.inputs[0]!.whatHappened, /Step 1a: unfinished child \(under Step 1\)/);
  });

  void it("Mark Done words its own consequence, not the commit's", async () => {
    const recorder = asker(OPEN_PLAN_ITEMS_STOP_OPTION_ID_V1);
    await confirmOpenPlanItemsAtEndV1({
      taskFolderUri: makeTask("mark-done-words", OPEN_PLAN),
      stage: "publish",
      command: "Mark Done",
      ask: recorder.ask,
    });
    const card = recorder.inputs[0]!;
    assert.equal(card.gating?.waitingNothingDone, "completed");
    assert.match(card.options[1]!.consequence, /Nothing is completed/);
    assert.doesNotMatch(card.whatHappened, /Commit & Push/);
  });

  void it("recommends Stop, and says the count may be behind while the checklist is flagged unreliable", async () => {
    const recorder = asker(OPEN_PLAN_ITEMS_STOP_OPTION_ID_V1);
    await confirmOpenPlanItemsAtEndV1({
      taskFolderUri: makeTask("latched", OPEN_PLAN, { checklistProgressUnreliable: true } as Partial<TaskProgress>),
      stage: "publish",
      command: "Commit & Push",
      ask: recorder.ask,
    });
    const card = recorder.inputs[0]!;
    assert.equal(card.recommendation.kind, "option");
    assert.equal(card.recommendation.kind === "option" ? card.recommendation.optionId : "", OPEN_PLAN_ITEMS_STOP_OPTION_ID_V1);
    assert.match(card.whatHappened, /this count may be behind/);
  });

  void it("names at most a handful of items and counts the rest", () => {
    const items = Array.from({ length: 11 }, (_, index) => `Step ${index + 1}: Item`);
    const text = describeOpenPlanItemsAtEndV1({ items, provisional: 0, latched: false }, "Commit & Push");
    assert.match(text, /11 plan items are still/);
    assert.match(text, /and 3 more/);
  });

  void it("gives the Publish review the open items so its verdict mentions them, and nothing when none are open", async () => {
    const note = buildOpenPlanItemsPublishNoteV1(await readOpenPlanItemsAtEndV1(makeTask("publish-note", OPEN_PLAN)));
    assert.match(note, /## Open plan items/);
    assert.match(note, /Mention them in your verdict/);
    assert.match(note, /Step 4: Also not built/);
    assert.equal(buildOpenPlanItemsPublishNoteV1(await readOpenPlanItemsAtEndV1(makeTask("publish-clean", SETTLED_PLAN))), "");
    assert.equal(buildOpenPlanItemsPublishNoteV1(undefined), "");
  });

  void it("is wired into Commit & Push (before the checks run), Mark Done (before the lock) and the Publish review prompt", () => {
    const read = (relative: string): string => nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "src", relative), "utf8");
    const commit = read("commands/commitAndPushTask.ts");
    assert.ok(
      commit.indexOf("confirmOpenPlanItemsAtEndV1({") < commit.indexOf("const runChecks = async"),
      "Commit & Push asks before any check runs"
    );
    const done = read("commands/markTaskDone.ts");
    assert.ok(
      done.indexOf("confirmOpenPlanItemsAtEndV1({") < done.indexOf("await runTrackedOperation("),
      "Mark Done asks before taking the task lock"
    );
    assert.match(read("commands/reviewActions.ts"), /buildOpenPlanItemsPublishNoteV1\(await readOpenPlanItemsAtEndV1/);
  });
});
