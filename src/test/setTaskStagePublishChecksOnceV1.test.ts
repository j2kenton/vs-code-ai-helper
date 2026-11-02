/**
 * bugs5 Step 15 (items 13 and 14): moving a task to Publish must not run the full checks inline.
 * That run had no registered operation and no saved result, and Fast Forward then ran the same
 * checks again. The move now dispatches Publish Checks through the registered command, and only
 * when it is not a card-driven move that dispatches its own next action.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const SOURCE = fs.readFileSync(path.join(process.cwd(), "src", "commands", "setTaskStage.ts"), "utf8");

void describe("setTaskStage does not run the Publish checks inline (bugs5 Step 15)", () => {
  void it("never calls checkPublishPreflight", () => {
    assert.doesNotMatch(SOURCE, /checkPublishPreflight/);
  });

  void it("dispatches the registered Publish Checks command, and only for a move that does not dispatch its own next action", () => {
    assert.match(
      SOURCE,
      /newStage === "publish" && cancelResultOutV1 === undefined\)\s*\{\s*await scheduleAutomationChain\(\{\s*command: "vs-code-ai-helper\.runPublishChecks"/
    );
  });

  void it("resumeAndSetTaskStageV1 supplies the cancel-result box, so its Fast Forward / stage-action dispatch is the only checks run", () => {
    const resume = fs.readFileSync(path.join(process.cwd(), "src", "commands", "resumeTask.ts"), "utf8");
    assert.match(resume, /cancelResultOutV1: cancelResultBox/);
  });
});
