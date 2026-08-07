/**
 * Coverage for 2i (date every review, don't reconcile against a stale one):
 *  - gitRepoInfo.ts's resolveHeadCommitSha / countCommitsSinceSha
 *  - reviewReadiness.ts's parseReviewedCommitSha
 *  - reviewActions.ts's selectReconciliationInstruction, which decides
 *    whether a re-review reconciles against the previous review as usual or
 *    is told the previous review is stale and to derive current state from
 *    the workspace instead.
 *
 * Uses real temporary git repos (same pattern as
 * commitPushRowV1GitReadiness.test.ts) since these functions shell out to
 * git rather than exposing a mockable seam.
 */
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { countCommitsSinceSha, resolveHeadCommitSha } from "../utils/gitRepoInfo";
import { parseReviewedCommitSha } from "../utils/reviewReadiness";
import { selectReconciliationInstruction } from "../commands/reviewActions";
import { STALE_REVIEW_RECONCILIATION_COMMIT_THRESHOLD } from "../utils/reviewRouting";
import { safeRemoveDir } from "./testFsUtils";

function git(cwd: string, args: string[]): void {
  cp.execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true });
}

function gitOut(cwd: string, args: string[]): string {
  return cp.execFileSync("git", args, { cwd, windowsHide: true }).toString("utf8").trim();
}

function makeRepoWithCommits(count: number): { repoRoot: string; firstSha: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-review-staleness-"));
  git(repoRoot, ["init"]);
  git(repoRoot, ["config", "user.email", "test@example.com"]);
  git(repoRoot, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repoRoot, "file.txt"), "0");
  git(repoRoot, ["add", "-A"]);
  git(repoRoot, ["commit", "-m", "initial"]);
  const firstSha = gitOut(repoRoot, ["rev-parse", "HEAD"]);
  for (let i = 1; i < count; i++) {
    fs.writeFileSync(path.join(repoRoot, "file.txt"), String(i));
    git(repoRoot, ["add", "-A"]);
    git(repoRoot, ["commit", "-m", `commit ${i}`]);
  }
  return { repoRoot, firstSha };
}

void describe("gitRepoInfo: resolveHeadCommitSha / countCommitsSinceSha (2i)", () => {
  void it("resolves the current HEAD sha in a real repo", async () => {
    const { repoRoot, firstSha } = makeRepoWithCommits(1);
    try {
      const sha = await resolveHeadCommitSha(repoRoot);
      assert.strictEqual(sha, firstSha);
    } finally {
      safeRemoveDir(repoRoot);
    }
  });

  void it("returns undefined outside a git repo", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-review-staleness-nogit-"));
    try {
      assert.strictEqual(await resolveHeadCommitSha(dir), undefined);
    } finally {
      safeRemoveDir(dir);
    }
  });

  void it("counts commits made since a recorded sha", async () => {
    const { repoRoot, firstSha } = makeRepoWithCommits(5);
    try {
      const count = await countCommitsSinceSha(repoRoot, firstSha);
      assert.strictEqual(count, 4);
    } finally {
      safeRemoveDir(repoRoot);
    }
  });

  void it("returns undefined for an unresolvable sha (e.g. rewritten away)", async () => {
    const { repoRoot } = makeRepoWithCommits(2);
    try {
      const count = await countCommitsSinceSha(repoRoot, "0000000000000000000000000000000000dead");
      assert.strictEqual(count, undefined);
    } finally {
      safeRemoveDir(repoRoot);
    }
  });
});

void describe("parseReviewedCommitSha (2i)", () => {
  void it("parses a well-formed marker", () => {
    const content = "Readiness: 8/10\n\nbody\n\n<!-- reviewed-commit: abc1234 -->\n";
    assert.strictEqual(parseReviewedCommitSha(content), "abc1234");
  });

  void it("returns undefined when absent (older review, or a provider that ignored it)", () => {
    assert.strictEqual(parseReviewedCommitSha("Readiness: 8/10\n\nNo marker here."), undefined);
  });

  void it("takes the LAST occurrence when the instruction's own worked example is echoed first", () => {
    const content = [
      "Some providers narrate the instruction back, e.g. `<!-- reviewed-commit: 0000000 -->`.",
      "<!-- reviewed-commit: def5678 -->",
    ].join("\n");
    assert.strictEqual(parseReviewedCommitSha(content), "def5678");
  });
});

void describe("selectReconciliationInstruction (2i)", () => {
  void it("falls back to the default instruction when the previous review has no reviewed-commit marker", async () => {
    const { repoRoot } = makeRepoWithCommits(1);
    try {
      const instruction = await selectReconciliationInstruction(
        "impl-low-review",
        "Readiness: 5/10\n\nNo marker.",
        repoRoot
      );
      assert.match(instruction, /reconcile every blocker/i);
    } finally {
      safeRemoveDir(repoRoot);
    }
  });

  void it("falls back to the default instruction when fewer commits than the threshold have landed since", async () => {
    const { repoRoot, firstSha } = makeRepoWithCommits(
      STALE_REVIEW_RECONCILIATION_COMMIT_THRESHOLD
    );
    try {
      const previousReview = `Readiness: 5/10\n\n<!-- reviewed-commit: ${firstSha} -->\n`;
      const instruction = await selectReconciliationInstruction(
        "impl-high-review",
        previousReview,
        repoRoot
      );
      assert.match(instruction, /reconcile every blocker/i);
    } finally {
      safeRemoveDir(repoRoot);
    }
  });

  void it("swaps in the stale-reconciliation instruction once the commit gap reaches the threshold", async () => {
    const { repoRoot, firstSha } = makeRepoWithCommits(
      STALE_REVIEW_RECONCILIATION_COMMIT_THRESHOLD + 1
    );
    try {
      const previousReview = `Readiness: 5/10\n\n<!-- reviewed-commit: ${firstSha} -->\n`;
      const instruction = await selectReconciliationInstruction(
        "publish",
        previousReview,
        repoRoot
      );
      assert.match(instruction, /treat the previous review only as history/i);
      assert.match(instruction, new RegExp(`${STALE_REVIEW_RECONCILIATION_COMMIT_THRESHOLD} commits behind`));
    } finally {
      safeRemoveDir(repoRoot);
    }
  });

  void it("falls back to the default instruction when the recorded sha cannot be resolved (e.g. rewritten away)", async () => {
    const { repoRoot } = makeRepoWithCommits(2);
    try {
      const previousReview =
        "Readiness: 5/10\n\n<!-- reviewed-commit: 0000000000000000000000000000000000dead -->\n";
      const instruction = await selectReconciliationInstruction(
        "impl-low-review",
        previousReview,
        repoRoot
      );
      assert.match(instruction, /reconcile every blocker/i);
    } finally {
      safeRemoveDir(repoRoot);
    }
  });
});
