/**
 * Coverage for A3 (1.0.0 gate, Part 3 Step 11), the "never reviewed must not
 * read as stale" fix (2026-09-04 review follow-up, completion blocker):
 * `markReviewArtifactStale`'s no-existing-content branch used to write the
 * legacy `# Review Stale` placeholder even when NO review had ever run,
 * claiming "This review was generated before {artifact} was updated" — false,
 * since nothing was ever generated. A3's own requirement is that only a
 * review that has never run should read as "not yet reviewed"; staling a
 * never-reviewed artifact must never make it read as a stale REVIEW instead.
 *
 * `markReviewArtifactStale` is exported from reviewActions.ts specifically
 * for this direct coverage — the pure banner primitives it delegates to for
 * the "real content exists" branch already have their own suite in
 * reviewArtifactChangeStaleBanner.test.ts.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { markReviewArtifactStale } from "../commands/reviewActions";
import { isStaleReviewArtifactV1 } from "../utils/reviewReadiness";
import { previousVersionUri } from "../utils/artifactBackups";

const FOLDER = vscode.Uri.file("/tasks/2026-09-04_never-reviewed-stale-fix");
const REVIEW_URI = vscode.Uri.joinPath(FOLDER, "impl-low-review.md");

function installMemStore(seed: Record<string, string> = {}): {
  store: Map<string, string>;
  restore: () => void;
} {
  const fsApi = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = {
    readFile: fsApi.readFile,
    writeFile: fsApi.writeFile,
  };
  const store = new Map<string, string>(Object.entries(seed));

  fsApi.readFile = (uri: vscode.Uri): Promise<Uint8Array> => {
    const content = store.get(uri.toString());
    if (content === undefined) {
      return Promise.reject(new Error(`ENOENT: ${uri.toString()}`));
    }
    return Promise.resolve(new TextEncoder().encode(content));
  };
  fsApi.writeFile = (uri: vscode.Uri, data: Uint8Array): Promise<void> => {
    store.set(uri.toString(), new TextDecoder().decode(data));
    return Promise.resolve();
  };

  return {
    store,
    restore: (): void => {
      fsApi.readFile = orig.readFile;
      fsApi.writeFile = orig.writeFile;
    },
  };
}

void describe("markReviewArtifactStale — never-reviewed state (2026-09-04 review follow-up)", () => {
  void it("is a no-op when no review artifact exists yet — never writes the legacy placeholder", async () => {
    const { store, restore } = installMemStore();
    try {
      await markReviewArtifactStale(REVIEW_URI, "workspace files");
      assert.equal(
        store.has(REVIEW_URI.toString()),
        false,
        "no file should be created for a stage that has never been reviewed"
      );
    } finally {
      restore();
    }
  });

  void it("is a no-op when the artifact exists but is empty — same 'nothing to stale' case", async () => {
    const { store, restore } = installMemStore({ [REVIEW_URI.toString()]: "" });
    try {
      await markReviewArtifactStale(REVIEW_URI, "plan.md");
      assert.equal(
        store.get(REVIEW_URI.toString()),
        "",
        "an already-empty artifact must stay empty, never become a fabricated stale-review placeholder"
      );
    } finally {
      restore();
    }
  });

  void it("still bannerizes in place (preserving content) when a real review exists", async () => {
    const realReview = "Readiness: 8/10\n\n<!-- progress: 10/10 -->\n";
    const { store, restore } = installMemStore({ [REVIEW_URI.toString()]: realReview });
    try {
      await markReviewArtifactStale(REVIEW_URI, "workspace files");
      const after = store.get(REVIEW_URI.toString());
      assert.ok(after);
      assert.ok(isStaleReviewArtifactV1(after), "a real review must be marked stale via the banner");
      assert.ok(after.includes("<!-- progress: 10/10 -->"), "the real content must survive, not be overwritten");
      assert.ok(
        !after.trimStart().startsWith("# Review Stale"),
        "must never fall back to the legacy destructive placeholder when real content exists"
      );
    } finally {
      restore();
    }
  });
});

/**
 * 2026-09-15 post-freeze findings, item 3: when `existing` is ITSELF already
 * the legacy bare `# Review Stale` placeholder (left on disk by a pre-A3
 * build, or by a previous run of this function before this fix), the general
 * "bannerize in place" branch above used to banner-wrap the placeholder's own
 * ~138 bytes — none of the verdict, score, blockers or progress a banner
 * exists to keep reachable. `backupReviewUnlessStale`'s stale-skip guard never
 * overwrote `_prev` with a placeholder, so `_prev` can still hold the last
 * real review from before the FIRST staling event; this recovers it.
 */
void describe("markReviewArtifactStale — recovering _prev when re-staling an already-placeholder artifact (2026-09-15 post-freeze findings, item 3)", () => {
  const STALE_PLACEHOLDER =
    "# Review Stale\n\nThis review was generated before plan.md was updated.\n\n" +
    "Run Review with AI again to evaluate the current artifact.\n";

  void it("recovers the last real review from _prev instead of banner-wrapping the empty placeholder", async () => {
    const previousReview = "Readiness: 7/10\n\n<!-- progress: 31/46 -->\nThe last real verdict.\n";
    const { store, restore } = installMemStore({
      [REVIEW_URI.toString()]: STALE_PLACEHOLDER,
      [previousVersionUri(REVIEW_URI).toString()]: previousReview,
    });
    try {
      await markReviewArtifactStale(REVIEW_URI, "workspace files");
      const after = store.get(REVIEW_URI.toString());
      assert.ok(after);
      assert.ok(isStaleReviewArtifactV1(after), "must still read as stale");
      assert.ok(after.includes("Readiness: 7/10"), "the last real verdict's score must be recovered");
      assert.ok(after.includes("<!-- progress: 31/46 -->"), "the last real progress marker must be recovered");
      assert.ok(after.includes("The last real verdict."));
      assert.ok(
        after.includes("superseded by an update to workspace files"),
        "the artifact-change banner must still be present"
      );
      // _prev itself must be untouched — it is the source of the recovery,
      // and `backupReviewUnlessStale` must not have overwritten it with the
      // placeholder that was just replaced.
      assert.equal(store.get(previousVersionUri(REVIEW_URI).toString()), previousReview);
    } finally {
      restore();
    }
  });

  void it("falls back to banner-wrapping the bare placeholder when _prev is missing", async () => {
    const { store, restore } = installMemStore({
      [REVIEW_URI.toString()]: STALE_PLACEHOLDER,
    });
    try {
      await markReviewArtifactStale(REVIEW_URI, "workspace files");
      const after = store.get(REVIEW_URI.toString());
      assert.ok(after);
      // No Readiness anchor line exists in the bare placeholder, so
      // upsertArtifactChangeStaleBannerV1 inserts the banner at the very
      // top — ahead of the (unchanged) placeholder heading, same as it would
      // for any other anchor-less content. Still recognized as stale via
      // isStaleReviewArtifactV1's banner check, which is what every actual
      // consumer reads.
      assert.ok(isStaleReviewArtifactV1(after));
      assert.ok(after.includes("# Review Stale"));
      assert.ok(after.includes("superseded by an update to workspace files"));
      assert.ok(!after.includes("## Previous result"));
    } finally {
      restore();
    }
  });

  void it("falls back to banner-wrapping the bare placeholder when _prev is itself a placeholder (no genuine review landed in between)", async () => {
    const { store, restore } = installMemStore({
      [REVIEW_URI.toString()]: STALE_PLACEHOLDER,
      [previousVersionUri(REVIEW_URI).toString()]: STALE_PLACEHOLDER,
    });
    try {
      await markReviewArtifactStale(REVIEW_URI, "workspace files");
      const after = store.get(REVIEW_URI.toString());
      assert.ok(after);
      assert.ok(isStaleReviewArtifactV1(after));
      assert.ok(after.includes("# Review Stale"));
      assert.ok(!after.includes("## Previous result"));
    } finally {
      restore();
    }
  });
});
