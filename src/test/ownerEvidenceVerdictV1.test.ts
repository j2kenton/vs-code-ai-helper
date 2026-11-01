/**
 * bugs4 item 19 / Step 27: the prompt label, the carried review verdict and the contradiction flag.
 * Fixture text is paraphrased from task.md item 19.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectOwnerEvidenceContradictionV1,
  formatOwnerEvidenceContradictionLineV1,
  formatOwnerEvidenceVerdictForRoundV1,
  readOwnerEvidenceVerdictV1,
} from "../utils/ownerEvidenceVerdictV1";
import { USER_REQUEST_SOURCE_LABEL_V1 } from "../utils/userRequestLabelV1";

const SATISFIED_REVIEW = [
  "Readiness: 8/10",
  "",
  "## Summary verdict",
  "task.md now satisfies the owner-preservation prerequisite (section 3, Owner decision 2026-10-30).",
  "",
  "<!-- blockers:start -->",
  "- [completion] [task-fixable] Step 10 is unbuilt",
  "<!-- blockers:end -->",
].join("\n");

const UNMET_REVIEW = [
  "Readiness: 6/10",
  "<!-- blockers:start -->",
  "- [completion] [environmental] Owner evidence needed: selected historical export source key recorded in task.md before Step 10",
  "<!-- blockers:end -->",
].join("\n");

const CONTRADICTING_SUMMARY = [
  "## Files Changed",
  "None.",
  "task.md still has no owner-selected export source and version. The owner decision in the task description names the key and versions, but task.md does not record them, so I did not start Step 10.",
].join("\n");

void describe("prompt label (item 19)", () => {
  void it("says the User Request section is the current task.md and that it wins over the plan's present-tense claims", () => {
    assert.match(USER_REQUEST_SOURCE_LABEL_V1, /current contents of `task\.md`, read at dispatch time/);
    assert.match(USER_REQUEST_SOURCE_LABEL_V1, /this text is newer and wins/);
  });
});

void describe("carried verdict on an owner-evidence blocker", () => {
  void it("a satisfied verdict is carried and tells the round the plan's gate wording is superseded", () => {
    assert.equal(readOwnerEvidenceVerdictV1(SATISFIED_REVIEW)?.state, "satisfied");
    const block = formatOwnerEvidenceVerdictForRoundV1(SATISFIED_REVIEW);
    assert.match(block, /owner evidence: satisfied/);
    assert.match(block, /superseded/);
    assert.match(block, /section 3/);
  });

  void it("an unmet verdict is carried as unmet, without the superseded wording", () => {
    assert.equal(readOwnerEvidenceVerdictV1(UNMET_REVIEW)?.state, "unmet");
    const block = formatOwnerEvidenceVerdictForRoundV1(UNMET_REVIEW);
    assert.match(block, /owner evidence: not yet satisfied/);
    assert.doesNotMatch(block, /superseded/);
  });

  void it("a review that says nothing about owner evidence adds nothing", () => {
    assert.equal(formatOwnerEvidenceVerdictForRoundV1("Readiness: 7/10\n\n<!-- blockers:start -->\n- [completion] [task-fixable] x\n<!-- blockers:end -->"), "");
  });
});

void describe("contradiction between a satisfied verdict and the round's summary", () => {
  void it("is detected, and the chat line names both sides and says the round is not a stall", () => {
    const contradiction = detectOwnerEvidenceContradictionV1(SATISFIED_REVIEW, CONTRADICTING_SUMMARY);
    assert.ok(contradiction);
    const line = formatOwnerEvidenceContradictionLineV1(contradiction);
    assert.match(line, /task\.md still has no owner-selected export source/);
    assert.match(line, /task\.md now satisfies the owner-preservation prerequisite/);
    assert.match(line, /not counted as a stall/);
  });

  void it("controls: an unmet review, or a summary that does not claim the gate is unmet, is not a contradiction", () => {
    assert.equal(detectOwnerEvidenceContradictionV1(UNMET_REVIEW, CONTRADICTING_SUMMARY), undefined);
    assert.equal(detectOwnerEvidenceContradictionV1(SATISFIED_REVIEW, "## Files Changed\n- src/a.ts\nBuilt Step 10."), undefined);
  });
});
