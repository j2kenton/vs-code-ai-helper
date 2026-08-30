/**
 * Regression coverage for `hasRestorableImplRoundV1` — the task tree's
 * "Discard Last Round" menu gate. Review blocker (2026-08-30, "stage chat as
 * a record of work" Part 11 item 32): the gate used to derive from the
 * `implRecovery`/`pendingImplReviewFiles` proxy, which can diverge from
 * whether a `_prev` backup pair the restore command actually reads exists.
 * These tests assert the EXACT condition `restoreRejectedImplementationRoundV1`
 * itself checks: the current impl-summary.md is the rejection stamp, AND
 * either its own or its review stage's `_prev` backup exists.
 */
import * as assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  buildUnusableImplementationSummaryV1,
  getImplementationSummaryUri,
  hasRestorableImplRoundV1,
} from "../utils/implementationArtifactResolver";
import { previousVersionUri } from "../utils/artifactBackups";

const FOLDER = vscode.Uri.file("/tasks/2026-08-30_restorable-check");
const REVIEW_URI = vscode.Uri.joinPath(FOLDER, "impl-low-review.md");

const REAL_SUMMARY = "## Files Changed\n\n- `src/a.ts` — did a thing\n\n## Verification\n\n- tests pass\n";

function installMemStore(seed: Record<string, string> = {}): {
  store: Map<string, string>;
  restore: () => void;
} {
  const fsApi = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = {
    readFile: fsApi.readFile,
    stat: fsApi.stat,
  };
  const store = new Map<string, string>(Object.entries(seed));

  fsApi.readFile = (uri: vscode.Uri): Promise<Uint8Array> => {
    const content = store.get(uri.toString());
    if (content === undefined) {
      return Promise.reject(new Error(`ENOENT: ${uri.toString()}`));
    }
    return Promise.resolve(new TextEncoder().encode(content));
  };
  fsApi.stat = (uri: vscode.Uri): Promise<vscode.FileStat> => {
    const content = store.get(uri.toString());
    if (content === undefined) {
      return Promise.reject(new Error(`ENOENT: ${uri.toString()}`));
    }
    return Promise.resolve({
      type: vscode.FileType.File,
      ctime: 0,
      mtime: 0,
      size: Buffer.byteLength(content, "utf8"),
    });
  };

  return {
    store,
    restore: (): void => {
      fsApi.readFile = orig.readFile;
      fsApi.stat = orig.stat;
    },
  };
}

let active: { restore: () => void } | undefined;
afterEach(() => {
  active?.restore();
  active = undefined;
});

void describe("hasRestorableImplRoundV1", () => {
  void it("is true when the summary is stamped and its own _prev backup exists", async () => {
    const summaryUri = getImplementationSummaryUri(FOLDER);
    const stamped = buildUnusableImplementationSummaryV1("bad shape", "run-log.md");
    active = installMemStore({
      [summaryUri.toString()]: stamped,
      [previousVersionUri(summaryUri).toString()]: REAL_SUMMARY,
    });

    assert.equal(await hasRestorableImplRoundV1(FOLDER, "impl-low-review"), true);
  });

  void it("is true when only the review stage's _prev backup exists (summary backup missing)", async () => {
    const summaryUri = getImplementationSummaryUri(FOLDER);
    const stamped = buildUnusableImplementationSummaryV1("bad shape", "run-log.md");
    active = installMemStore({
      [summaryUri.toString()]: stamped,
      [previousVersionUri(REVIEW_URI).toString()]: "Readiness: 8/10\n",
    });

    assert.equal(await hasRestorableImplRoundV1(FOLDER, "impl-low-review"), true);
  });

  void it("is false when the current summary is NOT the rejection stamp, even with a _prev file present", async () => {
    const summaryUri = getImplementationSummaryUri(FOLDER);
    active = installMemStore({
      [summaryUri.toString()]: REAL_SUMMARY,
      [previousVersionUri(summaryUri).toString()]: "some older summary",
    });

    assert.equal(await hasRestorableImplRoundV1(FOLDER, "impl-low-review"), false);
  });

  void it("is false when the summary is stamped but neither backup exists", async () => {
    const summaryUri = getImplementationSummaryUri(FOLDER);
    const stamped = buildUnusableImplementationSummaryV1("bad shape", "run-log.md");
    active = installMemStore({
      [summaryUri.toString()]: stamped,
    });

    assert.equal(await hasRestorableImplRoundV1(FOLDER, "impl-low-review"), false);
  });

  void it("is false when impl-summary.md does not exist at all", async () => {
    active = installMemStore({});

    assert.equal(await hasRestorableImplRoundV1(FOLDER, "impl"), false);
  });
});
