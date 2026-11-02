/**
 * bugs5 Step 18: every line about Publish names which of its two parts it is.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { describe, it } from "node:test";
import {
  publishChecksPassedHeadingV1,
  publishNextStepOfferV1,
  publishPartOneRunningLineV1,
  reviewOperationLabelV1,
} from "../utils/publishStageActionsV1";

void describe("bugs5 Step 18: Publish names its two parts", () => {
  void it("the checks start line says part 1 of 2, what runs, the usual time and that the owner can leave", () => {
    assert.equal(
      publishPartOneRunningLineV1(["pnpm run verify"], 35),
      "Publish, part 1 of 2: checks running — pnpm run verify (usually about 35 min here). " +
        "You can leave this; the result will appear here."
    );
  });

  void it("falls back to the check kinds, and leaves the duration out when no run was ever timed", () => {
    const line = publishPartOneRunningLineV1([]);
    assert.match(line, /checks running — lint, types, tests\. You can leave this/);
    assert.doesNotMatch(line, /usually/);
  });

  void it("the card after a pass reads as part 1 of 2 and asks to run part 2", () => {
    assert.equal(publishChecksPassedHeadingV1("review"), "Publish part 1 of 2 (checks) passed.");
    assert.equal(
      publishNextStepOfferV1("review").sentence,
      "Part 2 is the AI review, which gives the score out of 10. Run it now?"
    );
  });

  void it("does not invent a part 2 when Commit & Push follows the checks", () => {
    assert.equal(publishChecksPassedHeadingV1("commit-and-push"), "Publish checks passed.");
    assert.equal(publishNextStepOfferV1("commit-and-push").sentence, "Commit & Push to finish.");
  });

  void it("the Publish review's operation is named as part 2 of 2; other stages keep their own name", () => {
    assert.equal(reviewOperationLabelV1("publish", "Review"), "Publish, part 2 of 2: AI review");
    assert.equal(reviewOperationLabelV1("impl-high-review", "Review"), "Review");
    assert.equal(reviewOperationLabelV1(undefined, "Review"), "Review");
  });

  void it("runPublishChecks opens with the part 1 line and the review operations use the part 2 label", () => {
    const root = nodePath.resolve(__dirname, "..", "..", "src", "commands");
    const checks = nodeFs.readFileSync(nodePath.join(root, "runPublishChecks.ts"), "utf8");
    assert.match(checks, /operation\.reportActivity\(\s*publishPartOneRunningLineV1\(/);
    const reviews = nodeFs.readFileSync(nodePath.join(root, "reviewActions.ts"), "utf8");
    assert.equal((reviews.match(/label: reviewOperationLabelV1\(/g) ?? []).length, 2);
  });
});
