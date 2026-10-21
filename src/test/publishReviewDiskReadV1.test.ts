/**
 * A freshly promoted Publish review is read from disk, not from an open editor
 * buffer that may still hold the pre-promotion Publish Checks report.
 *
 * Regression: Fast Forward re-read `publish-review.md` straight after the
 * coordinator promoted it (temp file + `fs.promises.rename`, which bypasses
 * any open document) and, when the editor had not reloaded yet, classified a
 * perfectly good review as `ranButUnusable` / `noReadiness` — "the Publish
 * review scored 9/10 but publish-review.md has no Readiness line".
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  classifyPublishInitialRereadV1,
  readReviewArtifactFromDiskV1,
  type CompletedReviewAttemptV1,
} from "../commands/reviewActions";
import { readTextIfExists } from "../utils/fileUtils";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-publish-disk-read-"));
after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const EMPTY_ATTEMPT: CompletedReviewAttemptV1 = {
  attemptId: "attempt-1",
  score: 9,
  rejected: false,
};

/** Publish Checks report: what the editor buffer still holds after promotion. */
const CHECKS_ONLY = "# Publish Checks\n\nAll checks passed.\n\n## Commands that ran\n\n- pnpm run test\n";

/** The review the coordinator actually wrote to disk. */
const PROMOTED_REVIEW = "# Publish review\n\nReadiness: 9/10\n\nEverything checks out.\n";

const openDocuments: vscode.TextDocument[] = [];

/** Simulate `publish-review.md` being open in an editor with stale content. */
function openStaleDocument(uri: vscode.Uri, text: string): void {
  const doc = {
    uri,
    getText: () => text,
    isDirty: false,
  } as unknown as vscode.TextDocument;
  (vscode.workspace.textDocuments as vscode.TextDocument[]).push(doc);
  openDocuments.push(doc);
}

afterEach(() => {
  const documents = vscode.workspace.textDocuments as vscode.TextDocument[];
  for (const doc of openDocuments.splice(0)) {
    const index = documents.indexOf(doc);
    if (index !== -1) {
      documents.splice(index, 1);
    }
  }
});

/** Stub `workspace.fs.readFile` to back it with the real filesystem. */
function stubDiskRead(): () => void {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const original = target.readFile;
  target.readFile = async (uri: vscode.Uri): Promise<Uint8Array> =>
    new Uint8Array(await fs.promises.readFile(uri.fsPath));
  return () => {
    target.readFile = original;
  };
}

function writeReview(name: string, content: string): vscode.Uri {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  const uri = vscode.Uri.file(path.join(dir, "publish-review.md"));
  fs.writeFileSync(uri.fsPath, content, "utf8");
  return uri;
}

void describe("readReviewArtifactFromDiskV1", () => {
  void it("reads the promoted review from disk, not the stale open document, and classifies it usable", async () => {
    const restore = stubDiskRead();
    try {
      const uri = writeReview("stale-buffer", PROMOTED_REVIEW);
      openStaleDocument(uri, CHECKS_ONLY);

      // The editor-aware read still sees the stale buffer (the shared helper is
      // deliberately unchanged) ...
      assert.equal(await readTextIfExists(uri), CHECKS_ONLY);
      // ... but Fast Forward's disk read sees the review that was promoted.
      const content = await readReviewArtifactFromDiskV1(uri);
      assert.equal(content, PROMOTED_REVIEW.trim());
      assert.deepEqual(classifyPublishInitialRereadV1(content, EMPTY_ATTEMPT), { kind: "usable" });
    } finally {
      restore();
    }
  });

  void it("a disk file that really has no Readiness line still raises the decision", async () => {
    const restore = stubDiskRead();
    try {
      const uri = writeReview("genuine-failure", CHECKS_ONLY);
      openStaleDocument(uri, CHECKS_ONLY);

      const content = await readReviewArtifactFromDiskV1(uri);
      assert.equal(content, CHECKS_ONLY.trim());
      assert.deepEqual(classifyPublishInitialRereadV1(content, EMPTY_ATTEMPT), {
        kind: "ranButUnusable",
        score: 9,
        rejected: false,
        cause: "noReadiness",
      });
    } finally {
      restore();
    }
  });

  void it("the shared readTextIfExists still prefers the open buffer", async () => {
    const restore = stubDiskRead();
    try {
      const uri = writeReview("helper-regression", PROMOTED_REVIEW);
      openStaleDocument(uri, CHECKS_ONLY);
      assert.equal(await readTextIfExists(uri), CHECKS_ONLY);
    } finally {
      restore();
    }
  });

});

void describe("Fast Forward source wiring", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src", "commands", "reviewActions.ts"), "utf8");
  const start = source.indexOf("export async function fastForwardReviewWithAI");
  const nextExport = source.indexOf("\nexport async function ", start + 1);
  const ffSource = source.slice(start, nextExport === -1 ? undefined : nextExport);

  void it("the four decision reads in fastForwardReviewWithAI use the disk reader", () => {
    const diskReads = ffSource.match(/readReviewArtifactFromDiskV1\(reviewUri\)/g) ?? [];
    assert.equal(diskReads.length, 4, "pre-dispatch, post-dispatch, Publish re-read and apply-loop");
    assert.doesNotMatch(ffSource, /readNonEmptyText\(reviewUri\)/);
    assert.doesNotMatch(ffSource, /readTextIfExists\(reviewUri\)/);
  });

  void it("the apply-loop re-read is paired with the disk-based baseline", () => {
    assert.match(ffSource, /let previousContent = initialContent;/);
    const applyReadAt = ffSource.indexOf("const newContent = await readReviewArtifactFromDiskV1(reviewUri);");
    const previousAt = ffSource.indexOf("let previousContent = initialContent;");
    assert.ok(previousAt > 0 && applyReadAt > previousAt);
  });

});
