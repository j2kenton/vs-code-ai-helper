/**
 * Unit tests for the standing-blockers notice appended to an Implementation
 * prompt — the hedge behind `decidePostReviewActionV1`'s routing, for rounds
 * that reach Implementation anyway while a review still reports task-fixable
 * work. See src/prompts/standingBlockersNoticeV1.ts.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildStandingBlockersNoticeV1,
  MAX_LISTED_STANDING_BLOCKERS_V1,
} from "../prompts/standingBlockersNoticeV1";
import { ReviewBlocker } from "../utils/reviewReadiness";

const BASE = "# Run Implementation\n\nBody of the prompt.";

function blocker(overrides: Partial<ReviewBlocker> = {}): ReviewBlocker {
  return {
    category: "completion",
    resolver: "task-fixable",
    description: "Child insertion and parent transition are unsynchronized",
    ...overrides,
  };
}

void describe("buildStandingBlockersNoticeV1", () => {
  void it("appends the task-fixable blockers under its own heading", () => {
    const prompt = buildStandingBlockersNoticeV1(BASE, {
      blockers: [blocker()],
      reviewStageName: "Low-Level Implementation Review",
    });
    assert.ok(prompt.startsWith(BASE), "base prompt must be preserved verbatim");
    assert.ok(prompt.includes("## Standing Review Blockers"));
    assert.ok(prompt.includes("Low-Level Implementation Review"));
    assert.ok(prompt.includes("Child insertion and parent transition are unsynchronized"));
    assert.ok(prompt.includes("1 unresolved task-fixable blocker(s)"));
  });

  void it("returns the base prompt unchanged when nothing is task-fixable", () => {
    // A round cannot act on environmental/spec-defect work, so naming it here
    // would only spend prompt budget the size gate is already policing.
    const prompt = buildStandingBlockersNoticeV1(BASE, {
      blockers: [
        blocker({ resolver: "environmental" }),
        blocker({ resolver: "spec-defect" }),
      ],
      reviewStageName: "Low-Level Implementation Review",
    });
    assert.strictEqual(prompt, BASE);
  });

  void it("returns the base prompt unchanged with no blockers at all", () => {
    assert.strictEqual(
      buildStandingBlockersNoticeV1(BASE, {
        blockers: [],
        reviewStageName: "Low-Level Implementation Review",
      }),
      BASE
    );
  });

  void it("counts only task-fixable blockers, not the whole reported set", () => {
    const prompt = buildStandingBlockersNoticeV1(BASE, {
      blockers: [
        blocker(),
        blocker({ resolver: "environmental" }),
        blocker({ resolver: "unverifiable" }),
      ],
      reviewStageName: "Low-Level Implementation Review",
    });
    assert.ok(prompt.includes("1 unresolved task-fixable blocker(s)"));
  });

  void it("truncates a long list but still states the true total", () => {
    // A truncated list that reported its own length as the total would read
    // as the complete picture and under-state the remaining work.
    const many = Array.from({ length: MAX_LISTED_STANDING_BLOCKERS_V1 + 4 }, (_unused, i) =>
      blocker({ description: `blocker number ${i}` })
    );
    const prompt = buildStandingBlockersNoticeV1(BASE, {
      blockers: many,
      reviewStageName: "Low-Level Implementation Review",
    });
    assert.ok(prompt.includes(`${many.length} unresolved task-fixable blocker(s)`));
    assert.ok(prompt.includes("4 further task-fixable blocker(s) not listed"));
    assert.ok(prompt.includes(`blocker number ${MAX_LISTED_STANDING_BLOCKERS_V1 - 1}`));
    assert.ok(
      !prompt.includes(`blocker number ${MAX_LISTED_STANDING_BLOCKERS_V1}`),
      "must not list past the cap"
    );
  });

  void it("frames the checklist as the round's purpose, not the blockers", () => {
    // Apply Review owns blocker resolution; making this notice the mandate
    // would give both actions the same job.
    const prompt = buildStandingBlockersNoticeV1(BASE, {
      blockers: [blocker()],
      reviewStageName: "Low-Level Implementation Review",
    });
    assert.ok(prompt.includes("remains this round's purpose"));
  });
});

