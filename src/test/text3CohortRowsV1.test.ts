/**
 * Coverage for Text 3 cohort action rows (plan §6.4 & §6.5):
 *  - generateImplementationRowV1 (generateImplementation.v1)
 *  - reviewRowV1 (review.v1)
 *  - applyReviewRowV1 (applyReview.v1)
 *  - chatSendRowV1 (chatSend.v1)
 *  - commitPushMetadataRowV1 (commitPushMetadata.v1)
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createGenerateImplementationRowV1,
  GENERATE_IMPLEMENTATION_ACTION_KEY_V1,
  validateGenerateImplementationInputV1,
} from "../actions/rows/generateImplementationRowV1";
import {
  createReviewRowV1,
  REVIEW_ACTION_KEY_V1,
  validateReviewInputV1,
} from "../actions/rows/reviewRowV1";
import {
  createApplyReviewRowV1,
  APPLY_REVIEW_ACTION_KEY_V1,
  validateApplyReviewInputV1,
} from "../actions/rows/applyReviewRowV1";
import {
  createChatSendRowV1,
  CHAT_SEND_ACTION_KEY_V1,
  validateChatSendInputV1,
} from "../actions/rows/chatSendRowV1";
import {
  createCommitPushMetadataRowV1,
  COMMIT_PUSH_METADATA_ACTION_KEY_V1,
  validateCommitPushMetadataInputV1,
} from "../actions/rows/commitPushMetadataRowV1";
import { createTaskActionRegistryV1 } from "../actions/taskActionRegistryV1";

void describe("Text 3 cohort action rows", () => {
  void describe("generateImplementationRowV1", () => {
    void it("validates input shape correctly", () => {
      const valid = validateGenerateImplementationInputV1({
        prompt: "Generate impl notes",
        targetLocator: { rootId: "task-root", relativePath: "implementation-1.md" },
      });
      assert.equal(valid.ok, true);

      const invalidPrompt = validateGenerateImplementationInputV1({
        prompt: "",
        targetLocator: { rootId: "task-root", relativePath: "implementation-1.md" },
      });
      assert.equal(invalidPrompt.ok, false);

      const invalidLocator = validateGenerateImplementationInputV1({
        prompt: "Generate impl notes",
        targetLocator: { rootId: "", relativePath: "" },
      });
      assert.equal(invalidLocator.ok, false);
    });

    void it("creates valid registry row", () => {
      const row = createGenerateImplementationRowV1();
      assert.equal(row.actionKey, GENERATE_IMPLEMENTATION_ACTION_KEY_V1);
      assert.equal(row.completedContentType, "markdown-artifact.v1");
      assert.equal(row.providerMode, "text");
      assert.equal(row.resumeSemantics, "sameOperation");
    });
  });

  void describe("reviewRowV1", () => {
    void it("validates input shape correctly", () => {
      const valid = validateReviewInputV1({
        prompt: "Run review",
        targetLocator: { rootId: "task-root", relativePath: "plan-high-review.md" },
      });
      assert.equal(valid.ok, true);

      const invalid = validateReviewInputV1({
        prompt: "Run review",
        targetLocator: 42,
      });
      assert.equal(invalid.ok, false);
    });

    void it("creates valid registry row", () => {
      const row = createReviewRowV1();
      assert.equal(row.actionKey, REVIEW_ACTION_KEY_V1);
      assert.equal(row.completedContentType, "markdown-artifact.v1");
      assert.equal(row.providerMode, "text");
      assert.equal(row.resumeSemantics, "sameOperation");
    });
  });

  void describe("applyReviewRowV1", () => {
    void it("validates input shape correctly", () => {
      const valid = validateApplyReviewInputV1({
        prompt: "Apply review fixes",
        targetLocator: { rootId: "task-root", relativePath: "plan.md" },
      });
      assert.equal(valid.ok, true);
    });

    void it("creates valid registry row", () => {
      const row = createApplyReviewRowV1();
      assert.equal(row.actionKey, APPLY_REVIEW_ACTION_KEY_V1);
      assert.equal(row.completedContentType, "markdown-artifact.v1");
      assert.equal(row.providerMode, "text");
      assert.equal(row.resumeSemantics, "sameOperation");
    });
  });

  void describe("chatSendRowV1", () => {
    void it("validates input shape correctly", () => {
      const valid = validateChatSendInputV1({
        prompt: "Respond to user",
      });
      assert.equal(valid.ok, true);

      const invalid = validateChatSendInputV1({
        prompt: "",
      });
      assert.equal(invalid.ok, false);
    });

    void it("creates valid registry row", () => {
      const row = createChatSendRowV1();
      assert.equal(row.actionKey, CHAT_SEND_ACTION_KEY_V1);
      assert.equal(row.completedContentType, "chat-message.v1");
      assert.equal(row.providerMode, "text");
      assert.equal(row.resumeSemantics, "sameOperation");
    });

    void it("is eligible on both active and paused tasks", () => {
      const row = createChatSendRowV1();
      assert.deepEqual(row.eligibility, { statuses: ["active", "paused"], stages: "anyStage" });
    });
  });

  void describe("commitPushMetadataRowV1", () => {
    void it("validates input shape correctly", () => {
      const valid = validateCommitPushMetadataInputV1({
        prompt: "Generate commit metadata",
      });
      assert.equal(valid.ok, true);

      const invalid = validateCommitPushMetadataInputV1({
        prompt: 123,
      });
      assert.equal(invalid.ok, false);
    });

    void it("creates valid registry row", () => {
      const row = createCommitPushMetadataRowV1();
      assert.equal(row.actionKey, COMMIT_PUSH_METADATA_ACTION_KEY_V1);
      assert.equal(row.completedContentType, "commit-metadata.v1");
      assert.equal(row.providerMode, "text");
      assert.equal(row.resumeSemantics, "replacementOperation");
    });
  });

  void describe("task action registry integration", () => {
    void it("successfully constructs a registry with all Text 3 rows", () => {
      const registry = createTaskActionRegistryV1([
        createGenerateImplementationRowV1(),
        createReviewRowV1(),
        createApplyReviewRowV1(),
        createChatSendRowV1(),
        createCommitPushMetadataRowV1(),
      ]);
      assert.equal(registry.hasActionKey(GENERATE_IMPLEMENTATION_ACTION_KEY_V1), true);
      assert.equal(registry.hasActionKey(REVIEW_ACTION_KEY_V1), true);
      assert.equal(registry.hasActionKey(APPLY_REVIEW_ACTION_KEY_V1), true);
      assert.equal(registry.hasActionKey(CHAT_SEND_ACTION_KEY_V1), true);
      assert.equal(registry.hasActionKey(COMMIT_PUSH_METADATA_ACTION_KEY_V1), true);
    });
  });
});
