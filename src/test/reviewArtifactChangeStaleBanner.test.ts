/**
 * Coverage for A3 (1.0.0 gate, Part 3 Step 11): the non-destructive
 * replacement for `markReviewArtifactStale`'s old `# Review Stale`
 * full-content placeholder. Before this fix, an artifact invalidated because
 * another task artifact changed (the plan, or the workspace files an
 * implementation round edited) was overwritten wholesale — 138 bytes where a
 * real verdict, score, blockers and progress marker had been, recoverable
 * only from `_prev`, which nothing points a reader at. This suite covers the
 * pure primitives in reviewReadiness.ts that replace it:
 *
 *  - buildArtifactChangeStaleBannerV1 / hasArtifactChangeStaleBannerV1 /
 *    upsertArtifactChangeStaleBannerV1 (the new banner);
 *  - isStaleReviewArtifactV1 (the shared "is this stale" predicate every
 *    existing consumer — recovery, Apply Review, Fast Forward, re-review
 *    prompt selection — reads, now widened to recognize the banner as well
 *    as the legacy placeholder);
 *  - markReviewInProgressBannerV1's swap covering the new banner too.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildArtifactChangeStaleBannerV1,
  hasArtifactChangeStaleBannerV1,
  upsertArtifactChangeStaleBannerV1,
  isStaleReviewArtifactV1,
  markReviewInProgressBannerV1,
  parseReadiness,
  parseReviewBlockersDetailed,
  parseReviewProgress,
} from "../utils/reviewReadiness";

const REAL_REVIEW =
  "Readiness: 7/10\n\n" +
  "<!-- blockers:start -->\n" +
  "- [task-fixable] missing test coverage for the retry path.\n" +
  "<!-- blockers:end -->\n\n" +
  "<!-- progress: 31/46 -->\n";

void describe("buildArtifactChangeStaleBannerV1 / hasArtifactChangeStaleBannerV1", () => {
  void it("builds a banner naming the changed artifact and the timestamp", () => {
    const banner = buildArtifactChangeStaleBannerV1("plan.md", "2026-08-30T08:51:00.000Z");
    assert.equal(banner, "> ⚠ Stale: superseded by an update to plan.md at 2026-08-30T08:51:00.000Z.");
  });

  void it("detects a banner present anywhere in the content", () => {
    const withBanner = `Readiness: 7/10\n\n${buildArtifactChangeStaleBannerV1("workspace files", "2026-08-30T08:51:00.000Z")}\n\n- ok\n`;
    assert.ok(hasArtifactChangeStaleBannerV1(withBanner));
    assert.ok(!hasArtifactChangeStaleBannerV1(REAL_REVIEW));
  });
});

void describe("upsertArtifactChangeStaleBannerV1", () => {
  void it("inserts the banner immediately after the Readiness line, preserving the rest of the body verbatim", () => {
    const result = upsertArtifactChangeStaleBannerV1(REAL_REVIEW, "plan.md", "2026-08-30T08:51:00.000Z");
    const lines = result.split("\n");
    assert.equal(lines[0], "Readiness: 7/10");
    assert.equal(lines[1], "> ⚠ Stale: superseded by an update to plan.md at 2026-08-30T08:51:00.000Z.");
    // The full previous verdict, blockers, and progress marker survive.
    assert.ok(result.includes("missing test coverage for the retry path."));
    assert.ok(result.includes("<!-- progress: 31/46 -->"));
    // The banner does not corrupt the parsers that read the surviving body.
    assert.equal(parseReadiness(result).score, 7);
    assert.deepEqual(parseReviewProgress(result), { complete: 31, total: 46 });
    assert.equal(parseReviewBlockersDetailed(result).blockers.length, 1);
  });

  void it("is idempotent: re-applying the same reason/timestamp is a byte-identical no-op", () => {
    const once = upsertArtifactChangeStaleBannerV1(REAL_REVIEW, "plan.md", "2026-08-30T08:51:00.000Z");
    const twice = upsertArtifactChangeStaleBannerV1(once, "plan.md", "2026-08-30T08:51:00.000Z");
    assert.equal(twice, once);
  });

  void it("refreshes an existing banner in place rather than stacking a second one", () => {
    const once = upsertArtifactChangeStaleBannerV1(REAL_REVIEW, "plan.md", "2026-08-30T08:51:00.000Z");
    const refreshed = upsertArtifactChangeStaleBannerV1(once, "workspace files", "2026-08-30T09:10:00.000Z");
    const bannerLines = refreshed.split("\n").filter((l) => l.startsWith("> ⚠ Stale:"));
    assert.equal(bannerLines.length, 1, "only one artifact-change banner line may ever be present");
    assert.equal(bannerLines[0], "> ⚠ Stale: superseded by an update to workspace files at 2026-08-30T09:10:00.000Z.");
  });

  void it("inserts at the very top when there is no Readiness line to anchor on", () => {
    const noReadiness = "Some free-form content with no readiness line.\n";
    const result = upsertArtifactChangeStaleBannerV1(noReadiness, "plan.md", "2026-08-30T08:51:00.000Z");
    assert.ok(result.startsWith("> ⚠ Stale: superseded by an update to plan.md at 2026-08-30T08:51:00.000Z."));
  });
});

void describe("isStaleReviewArtifactV1 (A1 1.0.0 gate, Part A3 — the shared predicate every consumer reads)", () => {
  void it("is true for the legacy full-content placeholder (backward compatibility with pre-upgrade data)", () => {
    assert.ok(
      isStaleReviewArtifactV1(
        "# Review Stale\n\nThis review was generated before plan.md was updated.\n\nRun Review with AI again to evaluate the current artifact.\n"
      )
    );
  });

  void it("is true for content carrying the new artifact-change banner, even though the real body survives", () => {
    const banded = upsertArtifactChangeStaleBannerV1(REAL_REVIEW, "plan.md", "2026-08-30T08:51:00.000Z");
    assert.ok(isStaleReviewArtifactV1(banded));
    // And the body is still there for a human (or a downstream reader) to see.
    assert.equal(parseReadiness(banded).score, 7);
  });

  void it("is false for a current review with no stale marker at all", () => {
    assert.ok(!isStaleReviewArtifactV1(REAL_REVIEW));
  });
});

void describe("markReviewInProgressBannerV1 covers the artifact-change banner too", () => {
  void it("swaps the artifact-change banner line to the shared in-progress form, leaving the body untouched", () => {
    const banded = upsertArtifactChangeStaleBannerV1(REAL_REVIEW, "plan.md", "2026-08-30T08:51:00.000Z");
    const inProgress = markReviewInProgressBannerV1(banded);
    assert.notEqual(inProgress, banded);
    assert.ok(inProgress.includes("> ⏳ Review in progress: re-evaluating this artifact against the current HEAD."));
    assert.ok(!inProgress.includes("superseded by an update to plan.md"));
    // Body (blockers, progress marker) is untouched.
    assert.ok(inProgress.includes("missing test coverage for the retry path."));
    assert.ok(inProgress.includes("<!-- progress: 31/46 -->"));
  });

  void it("is a no-op for a current review carrying no stale banner of either kind", () => {
    assert.equal(markReviewInProgressBannerV1(REAL_REVIEW), REAL_REVIEW);
  });
});
