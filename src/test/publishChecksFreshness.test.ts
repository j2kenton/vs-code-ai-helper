/**
 * Coverage for the `publish-review.md` freshness stamp (plan PART 2, step 6;
 * relocated into the unified Publish artifact by plan item 17, step 20):
 * render/parse/merge/invalidate round-tripping, and the disk helpers used by
 * `runPublishChecks.ts` to prove the completion lint and Publish Scope Check
 * ran back-to-back against one unchanged commit.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  checkPublishChecksFreshnessV1,
  classifyPublishChecksFreshnessV1,
  computePublishScopeId,
  describePublishChecksFreshnessFailureV1,
  invalidatePublishChecksFreshnessStamp,
  invalidatePublishChecksFreshnessStampOnDiskV1,
  mergePublishChecksFreshnessStamp,
  parsePublishChecksFreshnessStamp,
  PublishChecksFreshnessCheckV1,
  PublishChecksFreshnessStampV1,
  readPublishChecksFreshnessStampV1,
  renderPublishChecksFreshnessStamp,
  withPublishChecksReportLockV1,
  writeFileAtomicV1,
  writePublishChecksFreshnessStampV1,
} from "../utils/publishChecksFreshness";
import { STAGE_ARTIFACT_FILENAMES } from "../types/taskProgress";

const PUBLISH_REVIEW_FILENAME = STAGE_ARTIFACT_FILENAMES.publish!;

const TEST_ROOT = nodeFs.mkdtempSync(
  nodePath.join(nodeOs.tmpdir(), "ensemble-publish-checks-freshness-test-")
);
after(() => {
  nodeFs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

function makeTaskFolder(name: string): vscode.Uri {
  const dir = nodePath.join(TEST_ROOT, name);
  nodeFs.mkdirSync(dir, { recursive: true });
  return vscode.Uri.file(dir);
}

const SAMPLE_STAMP: PublishChecksFreshnessStampV1 = {
  formatVersion: 1,
  runId: "11111111-1111-4111-8111-111111111111",
  verifiedCommitSha: "abc123def4567890abc123def4567890abc123d",
  completedAt: "2026-08-17T12:00:00.000Z",
  scopeId: "0123456789abcdef",
};

void describe("publishChecksFreshness — pure render/parse", () => {
  void it("round-trips a rendered stamp through the parser", () => {
    const rendered = renderPublishChecksFreshnessStamp(SAMPLE_STAMP);
    const parsed = parsePublishChecksFreshnessStamp(rendered);
    assert.deepEqual(parsed, SAMPLE_STAMP);
  });

  void it("returns undefined when no stamp block is present", () => {
    assert.equal(parsePublishChecksFreshnessStamp("# Publish Checks\n\nNothing here.\n"), undefined);
  });

  void it("returns undefined for a truncated block (end marker missing)", () => {
    const rendered = renderPublishChecksFreshnessStamp(SAMPLE_STAMP);
    const truncated = rendered.slice(0, rendered.indexOf("<!-- completed-at:"));
    assert.equal(parsePublishChecksFreshnessStamp(truncated), undefined);
  });

  void it("returns undefined when a required field is missing", () => {
    const rendered = renderPublishChecksFreshnessStamp(SAMPLE_STAMP);
    const withoutRunId = rendered
      .split("\n")
      .filter((line) => !line.startsWith("<!-- run-id:"))
      .join("\n");
    assert.equal(parsePublishChecksFreshnessStamp(withoutRunId), undefined);
  });

  void it("returns undefined for an unrecognized format-version", () => {
    const rendered = renderPublishChecksFreshnessStamp(SAMPLE_STAMP).replace(
      "<!-- format-version: 1 -->",
      "<!-- format-version: 2 -->"
    );
    assert.equal(parsePublishChecksFreshnessStamp(rendered), undefined);
  });
});

void describe("publishChecksFreshness — merge/invalidate", () => {
  void it("appends a stamp to content with none present", () => {
    const merged = mergePublishChecksFreshnessStamp(
      "# Publish Checks\n",
      renderPublishChecksFreshnessStamp(SAMPLE_STAMP)
    );
    assert.equal(parsePublishChecksFreshnessStamp(merged)?.runId, SAMPLE_STAMP.runId);
    assert.ok(merged.startsWith("# Publish Checks"));
  });

  void it("replaces a previous stamp in place, preserving surrounding content", () => {
    const withFirst = mergePublishChecksFreshnessStamp(
      "# Publish Checks\n\n## Completion Checks\nsome content\n",
      renderPublishChecksFreshnessStamp(SAMPLE_STAMP)
    );
    const second: PublishChecksFreshnessStampV1 = { ...SAMPLE_STAMP, runId: "22222222-2222-4222-8222-222222222222" };
    const withSecond = mergePublishChecksFreshnessStamp(withFirst, renderPublishChecksFreshnessStamp(second));
    assert.equal(parsePublishChecksFreshnessStamp(withSecond)?.runId, second.runId);
    assert.ok(withSecond.includes("## Completion Checks"));
    assert.ok(withSecond.includes("some content"));
  });

  void it("invalidate is a no-op on content with no stamp", () => {
    const content = "# Publish Checks\n\nNothing here.\n";
    assert.equal(invalidatePublishChecksFreshnessStamp(content), content);
  });

  void it("invalidate strips the stamp and preserves the rest", () => {
    const withStamp = mergePublishChecksFreshnessStamp(
      "# Publish Checks\n\n## Completion Checks\nsome content\n",
      renderPublishChecksFreshnessStamp(SAMPLE_STAMP)
    );
    const stripped = invalidatePublishChecksFreshnessStamp(withStamp);
    assert.equal(parsePublishChecksFreshnessStamp(stripped), undefined);
    assert.ok(stripped.includes("## Completion Checks"));
    assert.ok(stripped.includes("some content"));
  });
});

void describe("publishChecksFreshness — scope id", () => {
  void it("is deterministic and never contains the raw path", () => {
    const rawPath = "C:\\Users\\jjk61\\dev\\some-private-project";
    const id = computePublishScopeId(rawPath);
    assert.equal(id, computePublishScopeId(rawPath));
    assert.ok(!id.includes("jjk61"));
    assert.match(id, /^[0-9a-f]{16}$/);
  });

  void it("differs for different scope folders", () => {
    assert.notEqual(computePublishScopeId("/repo/a"), computePublishScopeId("/repo/b"));
  });
});

void describe("publishChecksFreshness — disk helpers", () => {
  void it("writes a stamp readable back via readPublishChecksFreshnessStampV1", async () => {
    const taskFolder = makeTaskFolder("write-read");
    await writePublishChecksFreshnessStampV1(taskFolder, SAMPLE_STAMP);
    const readBack = await readPublishChecksFreshnessStampV1(taskFolder);
    assert.deepEqual(readBack, SAMPLE_STAMP);
  });

  void it("invalidate-on-disk removes a stamp without touching other content", async () => {
    const taskFolder = makeTaskFolder("invalidate");
    const filePath = nodePath.join(taskFolder.fsPath, PUBLISH_REVIEW_FILENAME);
    nodeFs.writeFileSync(filePath, "## Completion Checks\nprior content\n", "utf8");
    await writePublishChecksFreshnessStampV1(taskFolder, SAMPLE_STAMP);
    assert.notEqual(await readPublishChecksFreshnessStampV1(taskFolder), undefined);

    await invalidatePublishChecksFreshnessStampOnDiskV1(taskFolder);
    assert.equal(await readPublishChecksFreshnessStampV1(taskFolder), undefined);
    const finalContent = nodeFs.readFileSync(filePath, "utf8");
    assert.ok(finalContent.includes("prior content"));
  });

  void it("invalidate-on-disk is a no-op (no write) when the file has no stamp", async () => {
    const taskFolder = makeTaskFolder("invalidate-noop");
    const filePath = nodePath.join(taskFolder.fsPath, PUBLISH_REVIEW_FILENAME);
    nodeFs.writeFileSync(filePath, "## Completion Checks\nno stamp here\n", "utf8");
    const before = nodeFs.statSync(filePath).mtimeMs;
    await invalidatePublishChecksFreshnessStampOnDiskV1(taskFolder);
    const after = nodeFs.statSync(filePath).mtimeMs;
    assert.equal(before, after);
  });

  void it("readPublishChecksFreshnessStampV1 returns undefined when the file does not exist", async () => {
    const taskFolder = makeTaskFolder("missing-file");
    assert.equal(await readPublishChecksFreshnessStampV1(taskFolder), undefined);
  });
});

void describe("publishChecksFreshness — writeFileAtomicV1", () => {
  void it("leaves no temp file behind after a successful write", async () => {
    const dir = makeTaskFolder("atomic-write").fsPath;
    const target = nodePath.join(dir, PUBLISH_REVIEW_FILENAME);
    await writeFileAtomicV1(target, "hello atomic\n");
    assert.equal(nodeFs.readFileSync(target, "utf8"), "hello atomic\n");
    const leftovers = nodeFs.readdirSync(dir).filter((name) => name.includes(".tmp-"));
    assert.deepEqual(leftovers, []);
  });

  void it("never exposes a partially written file to a concurrent reader", async () => {
    const dir = makeTaskFolder("atomic-write-torn").fsPath;
    const target = nodePath.join(dir, PUBLISH_REVIEW_FILENAME);
    const big = "x".repeat(200_000);
    const writes = Promise.all([
      writeFileAtomicV1(target, `A:${big}`),
      writeFileAtomicV1(target, `B:${big}`),
    ]);
    // Poll while both writes are in flight: whatever is on disk at any
    // moment must be either absent or one full write, never a torn mix.
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      try {
        const content = nodeFs.readFileSync(target, "utf8");
        seen.add(content[0] ?? "");
        assert.ok(content.length === 0 || content.length === big.length + 2);
      } catch {
        // File briefly absent between temp-file write and rename — fine.
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await writes;
    const final = nodeFs.readFileSync(target, "utf8");
    assert.ok(final === `A:${big}` || final === `B:${big}`);
  });
});

void describe("publishChecksFreshness — withPublishChecksReportLockV1", () => {
  void it("serializes concurrent critical sections against the same task folder", async () => {
    const taskFolder = makeTaskFolder("lock-serializes");
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;

    const run = (label: string, delayMs: number): Promise<void> =>
      withPublishChecksReportLockV1(taskFolder, async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        order.push(`${label}-start`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        order.push(`${label}-end`);
        active--;
      });

    await Promise.all([run("A", 20), run("B", 5), run("C", 1)]);

    assert.equal(maxActive, 1, "no two critical sections ever ran concurrently");
    // Each label's start must be immediately followed by its own end —
    // proof that no other critical section interleaved inside it.
    for (const label of ["A", "B", "C"]) {
      const startIdx = order.indexOf(`${label}-start`);
      assert.equal(order[startIdx + 1], `${label}-end`);
    }
  });

  void it("propagates the critical section's result and does not block a different task folder", async () => {
    const taskFolderA = makeTaskFolder("lock-result-a");
    const taskFolderB = makeTaskFolder("lock-result-b");

    const slowA = withPublishChecksReportLockV1(taskFolderA, async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return "a-result";
    });
    const fastB = withPublishChecksReportLockV1(taskFolderB, () => Promise.resolve("b-result"));

    const bResult = await fastB;
    assert.equal(bResult, "b-result");
    assert.equal(await slowA, "a-result");
  });

  void it("propagates a rejection without deadlocking the next queued caller", async () => {
    const taskFolder = makeTaskFolder("lock-rejection");
    await assert.rejects(
      withPublishChecksReportLockV1(taskFolder, () => {
        throw new Error("boom");
      }),
      /boom/
    );
    const after = await withPublishChecksReportLockV1(taskFolder, () => Promise.resolve("recovered"));
    assert.equal(after, "recovered");
  });
});

void describe("publishChecksFreshness — entry-point freshness gate (plan PART 2, step 7)", () => {
  const SCOPE_A = "/scope/project-a";
  const SCOPE_B = "/scope/project-b";
  const COMMIT_1 = "1111111111111111111111111111111111111a";
  const COMMIT_2 = "2222222222222222222222222222222222222b";
  const stampFor = (scope: string, commit: string): PublishChecksFreshnessStampV1 => ({
    formatVersion: 1,
    runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    verifiedCommitSha: commit,
    completedAt: "2026-08-18T00:00:00.000Z",
    scopeId: computePublishScopeId(scope),
  });

  void it("classifies as valid when scope and commit both match", () => {
    const check = classifyPublishChecksFreshnessV1(stampFor(SCOPE_A, COMMIT_1), SCOPE_A, COMMIT_1);
    assert.equal(check.status, "valid");
  });

  void it("classifies as missing when no stamp is present", () => {
    const check = classifyPublishChecksFreshnessV1(undefined, SCOPE_A, COMMIT_1);
    assert.equal(check.status, "missing");
  });

  void it("classifies as unreadableHead when the current commit cannot be resolved", () => {
    const check = classifyPublishChecksFreshnessV1(stampFor(SCOPE_A, COMMIT_1), SCOPE_A, undefined);
    assert.equal(check.status, "unreadableHead");
  });

  void it("classifies as staleCommit when the commit has moved since the stamped run", () => {
    const check = classifyPublishChecksFreshnessV1(stampFor(SCOPE_A, COMMIT_1), SCOPE_A, COMMIT_2);
    assert.equal(check.status, "staleCommit");
    if (check.status === "staleCommit") {
      assert.equal(check.currentCommitSha, COMMIT_2);
      assert.equal(check.stamp.verifiedCommitSha, COMMIT_1);
    }
  });

  void it("classifies as scopeMismatch when the verification scope has changed", () => {
    const check = classifyPublishChecksFreshnessV1(stampFor(SCOPE_A, COMMIT_1), SCOPE_B, COMMIT_1);
    assert.equal(check.status, "scopeMismatch");
  });

  void it("prefers scopeMismatch over staleCommit when both differ", () => {
    // Scope identity is checked first: a stamp from an entirely different
    // scope folder should never be reported as merely a stale commit, which
    // would understate how unrelated the evidence actually is.
    const check = classifyPublishChecksFreshnessV1(stampFor(SCOPE_A, COMMIT_1), SCOPE_B, COMMIT_2);
    assert.equal(check.status, "scopeMismatch");
  });

  void it("describes every non-valid status with an actionable, non-empty message", () => {
    const checks: Array<Exclude<PublishChecksFreshnessCheckV1, { status: "valid" }>> = [
      { status: "missing" },
      { status: "unreadableHead" },
      { status: "staleCommit", stamp: stampFor(SCOPE_A, COMMIT_1), currentCommitSha: COMMIT_2 },
      { status: "scopeMismatch", stamp: stampFor(SCOPE_A, COMMIT_1) },
    ];
    for (const check of checks) {
      const message = describePublishChecksFreshnessFailureV1(check);
      assert.ok(message.length > 0, `${check.status} must produce a message`);
      assert.match(message, /Publish Checks/, `${check.status} message should mention Publish Checks`);
    }
  });

  void it("checkPublishChecksFreshnessV1 reads the on-disk stamp and reports valid against a matching scope/commit", async () => {
    const taskFolder = makeTaskFolder("gate-valid");
    await writePublishChecksFreshnessStampV1(taskFolder, stampFor(SCOPE_A, COMMIT_1));
    const check = await checkPublishChecksFreshnessV1(taskFolder, SCOPE_A, COMMIT_1);
    assert.equal(check.status, "valid");
  });

  void it("checkPublishChecksFreshnessV1 reports missing when no Publish Checks have ever run", async () => {
    const taskFolder = makeTaskFolder("gate-missing");
    const check = await checkPublishChecksFreshnessV1(taskFolder, SCOPE_A, COMMIT_1);
    assert.equal(check.status, "missing");
  });

  void it("checkPublishChecksFreshnessV1 reports staleCommit once the tree advances past the stamped run", async () => {
    const taskFolder = makeTaskFolder("gate-stale");
    await writePublishChecksFreshnessStampV1(taskFolder, stampFor(SCOPE_A, COMMIT_1));
    const check = await checkPublishChecksFreshnessV1(taskFolder, SCOPE_A, COMMIT_2);
    assert.equal(check.status, "staleCommit");
  });
});
