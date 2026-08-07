/**
 * Coverage for 2k (reconcile sibling reviews of the same commit) at the
 * reviewActions.ts seam: buildSiblingReviewDisagreementVariable reads the
 * already-written impl-high-review.md / impl-low-review.md sibling
 * artifacts from a task folder and renders the `{{siblingReviewDisagreement}}`
 * block the Publish prompt is told to address explicitly. The mechanical
 * detection logic itself (detectSiblingReviewDisagreement) is covered by
 * reviewReadinessBlockers.test.ts; this file covers the file-reading and
 * rendering wrapper around it.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { before, after, describe, it } from "node:test";
import * as vscode from "vscode";

import { buildSiblingReviewDisagreementVariable } from "../commands/reviewActions";
import { safeRemoveDir } from "./testFsUtils";

const SHA = "abc1234";

function makeTaskFolder(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-sibling-review-"));
}

void describe("buildSiblingReviewDisagreementVariable (2k)", () => {
  const workspace = vscode.workspace as unknown as {
    fs: { readFile: (uri: vscode.Uri) => Promise<Uint8Array> };
  };
  let originalReadFile: (uri: vscode.Uri) => Promise<Uint8Array>;

  before(() => {
    // The stub vscode's workspace.fs.readFile is notImplemented; back it
    // with the real filesystem so the function reads the real fixture files
    // written below (same pattern as reviewScoringRubric.test.ts).
    originalReadFile = workspace.fs.readFile;
    workspace.fs.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
      fs.promises.readFile(uri.fsPath);
  });

  after(() => {
    workspace.fs.readFile = originalReadFile;
  });

  void it("renders a disagreement block when the sibling reviews contradict on the same commit", async () => {
    const folder = makeTaskFolder();
    try {
      fs.writeFileSync(
        path.join(folder, "impl-high-review.md"),
        `Readiness: 9/10\n\n<!-- progress: 18/18 -->\n<!-- reviewed-commit: ${SHA} -->\n`
      );
      fs.writeFileSync(
        path.join(folder, "impl-low-review.md"),
        `Readiness: 8/10\n\n<!-- blockers:start -->\n- [completion] [task-fixable] steps 5-18 do not exist yet\n<!-- blockers:end -->\n<!-- reviewed-commit: ${SHA} -->\n`
      );
      const rendered = await buildSiblingReviewDisagreementVariable(vscode.Uri.file(folder), SHA);
      assert.match(rendered, /Sibling Review Disagreement/);
      assert.match(rendered, /18 of 18 ordered steps/);
      assert.match(rendered, /steps 5-18 do not exist yet/);
      assert.match(rendered, /Do not silently average/);
    } finally {
      safeRemoveDir(folder);
    }
  });

  void it("returns an empty string when the sibling reviews agree", async () => {
    const folder = makeTaskFolder();
    try {
      fs.writeFileSync(
        path.join(folder, "impl-high-review.md"),
        `Readiness: 9/10\n\n<!-- progress: 18/18 -->\n<!-- reviewed-commit: ${SHA} -->\n`
      );
      fs.writeFileSync(
        path.join(folder, "impl-low-review.md"),
        `Readiness: 9/10\n\nblockers: none\n\n<!-- reviewed-commit: ${SHA} -->\n`
      );
      const rendered = await buildSiblingReviewDisagreementVariable(vscode.Uri.file(folder), SHA);
      assert.strictEqual(rendered, "");
    } finally {
      safeRemoveDir(folder);
    }
  });

  void it("returns an empty string when a sibling review artifact does not exist yet", async () => {
    const folder = makeTaskFolder();
    try {
      fs.writeFileSync(
        path.join(folder, "impl-high-review.md"),
        `Readiness: 9/10\n\n<!-- progress: 18/18 -->\n<!-- reviewed-commit: ${SHA} -->\n`
      );
      // No impl-low-review.md written.
      const rendered = await buildSiblingReviewDisagreementVariable(vscode.Uri.file(folder), SHA);
      assert.strictEqual(rendered, "");
    } finally {
      safeRemoveDir(folder);
    }
  });
});
