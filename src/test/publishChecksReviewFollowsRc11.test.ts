/**
 * RC11 item 1: Publish Checks that run as the first half of "Run Publish
 * Checks, Then Review" post no "Request a Publish review" card on a pass.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

import { extractReviewFollowsV1 } from "../commands/runPublishChecks";

const read = (...parts: string[]): string => fs.readFileSync(path.join(process.cwd(), ...parts), "utf8");

void describe("RC11 item 1: reviewFollowsV1", () => {
  void it("extractReviewFollowsV1 is true only for the explicit flag", () => {
    assert.equal(extractReviewFollowsV1({ taskFolderPath: "x", reviewFollowsV1: true }), true);
    assert.equal(extractReviewFollowsV1({ taskFolderPath: "x" }), false);
    assert.equal(extractReviewFollowsV1({ task: {} as never }), false);
    assert.equal(extractReviewFollowsV1(undefined), false);
    assert.equal(extractReviewFollowsV1({ taskFolderPath: "x", reviewFollowsV1: "yes" as never }), false);
  });

  void it("runPublishChecks wires the card-free arm between the Fast Forward arm and the card arm", () => {
    const src = read("src", "commands", "runPublishChecks.ts");
    const ff = src.indexOf("Fast Forward runs the Publish review next.");
    const arm = src.indexOf("} else if (reviewFollows && freshStampWritten");
    const last = src.indexOf("} else {", arm + 1);
    assert.ok(ff > 0 && arm > ff && last > arm);
    const armBody = src.slice(arm, last);
    assert.ok(!armBody.includes("offerActionInChatV1("));
    assert.ok(src.slice(last, last + 1200).includes("actionLabel: nextStepOffer.action.title"));
    assert.match(src, /if \(freshStampWritten[^)]*\) \{\s*await writePublishChecksFreshnessStampV1/);
  });

  void it("the check-and-review route and the post-fix route carry the flag", () => {
    assert.match(
      read("src", "commands", "checkAndReviewPublish.ts"),
      /"vs-code-ai-helper\.runPublishChecks",\s*\{\s*taskFolderPath,\s*reviewFollowsV1: true\s*\}/
    );
    assert.ok(read("src", "commands", "runLintingFixes.ts").includes("CHECK_AND_REVIEW_PUBLISH_COMMAND_ID_V1"));
  });
});
