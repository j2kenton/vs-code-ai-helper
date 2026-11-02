/**
 * bugs5 Steps 7-9 / item 3: the pre-staged Commit & Push card names the unstaged and untracked
 * files it found (the first 10 and a count), within the scope the commit uses; no Commit & Push
 * card has a "Cancel" option.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  buildCommitPushUnstagedListV1,
  describeCommitPushUnstagedListV1,
} from "../utils/commitPushUnstagedListV1";
import { describeRecordedChoiceV1 } from "../views/chatView";
import { describeWaitingCommandDismissWarningV1 } from "../utils/cardLifecycleV1";

const TASK_REL = ".ensemble/2026-10-26_task_3";

void describe("buildCommitPushUnstagedListV1 (bugs5 Step 8)", () => {
  void it("names a single unstaged file", () => {
    const list = buildCommitPushUnstagedListV1({ unstagedOutput: "src/a.ts\n", untrackedOutput: "", taskFolderRelative: TASK_REL });
    assert.deepEqual(list.shown, ["src/a.ts"]);
    assert.equal(list.total, 1);
    assert.match(describeCommitPushUnstagedListV1(list), /would add \(1\):\n {2}src\/a\.ts$/);
  });

  void it("lists unstaged then untracked, once each", () => {
    const list = buildCommitPushUnstagedListV1({
      unstagedOutput: "src/a.ts\nsrc/b.ts\n",
      untrackedOutput: "src/b.ts\nsrc/new.ts\n",
      taskFolderRelative: TASK_REL,
    });
    assert.deepEqual(list.shown, ["src/a.ts", "src/b.ts", "src/new.ts"]);
  });

  void it("shows the first 10 and a count of the rest", () => {
    const many = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`).join("\n");
    const list = buildCommitPushUnstagedListV1({ unstagedOutput: many, untrackedOutput: "", taskFolderRelative: TASK_REL });
    assert.equal(list.shown.length, 10);
    assert.equal(list.total, 25);
    assert.match(describeCommitPushUnstagedListV1(list), /… and 15 more$/);
  });

  void it("leaves the task folder out by default and says so when only it changed", () => {
    const list = buildCommitPushUnstagedListV1({
      unstagedOutput: `${TASK_REL}/task.md\n${TASK_REL}/plan.md\n`,
      untrackedOutput: "",
      taskFolderRelative: TASK_REL,
    });
    assert.equal(list.total, 0);
    assert.equal(list.excludedTaskFolderCount, 2);
    assert.match(describeCommitPushUnstagedListV1(list), /all inside the task folder/);
  });

  void it("includes the task folder when the commit's scope does", () => {
    const list = buildCommitPushUnstagedListV1({
      unstagedOutput: `${TASK_REL}/task.md\n`,
      untrackedOutput: "",
      taskFolderRelative: TASK_REL,
      includeTaskFolder: true,
    });
    assert.deepEqual(list.shown, [`${TASK_REL}/task.md`]);
  });

  void it("adds nothing when there is nothing unstaged", () => {
    const list = buildCommitPushUnstagedListV1({ unstagedOutput: "", untrackedOutput: "", taskFolderRelative: TASK_REL });
    assert.equal(describeCommitPushUnstagedListV1(list), "");
  });
});

void describe("Commit & Push wording (bugs5 Steps 7 and 9)", () => {
  void it("builds the Recorded line from what the choice does next", () => {
    assert.equal(
      describeRecordedChoiceV1("Commit Everything Together", "continuing to the final confirmation"),
      'Recorded: "Commit Everything Together" — continuing to the final confirmation.'
    );
    assert.equal(describeRecordedChoiceV1("X", "stopped. "), 'Recorded: "X" — stopped.');
  });

  void it("warns before Dismiss that it ends the command", () => {
    assert.equal(
      describeWaitingCommandDismissWarningV1("Commit & Push", "committed"),
      "Dismissing stops this Commit & Push; nothing is committed."
    );
    assert.equal(describeWaitingCommandDismissWarningV1("Publish Checks"), "Dismissing stops this Publish Checks.");
  });

  void it("no Commit & Push card offers 'Cancel' or leaves the detail describing its options", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../../src/commands/commitAndPushTask.ts"), "utf8");
    assert.doesNotMatch(source, /label: "Cancel"/);
    assert.doesNotMatch(source, /Choosing an option continues/);
    assert.match(source, /label: "Not now"/);
    assert.match(source, /Nothing is staged, committed or pushed\. Choose Commit & Push again when you're ready\./);
    assert.match(source, /waitingCommand: COMMIT_PUSH_COMMAND_NAME_V1/);
    assert.match(source, /const COMMIT_PUSH_UNBLOCKS_V1 = "the commit and push"/);
  });
});
