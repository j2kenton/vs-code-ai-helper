/**
 * review1 Step 52: an owner-run command recorded against a blocker's lineage id reaches the review a reviewer is
 * actually given. Records a run with the real writer, builds the real implementation-review context pack from the
 * task folder, renders the real `review-impl-high.md` template (which expands the shared rubric), and checks that
 * the one prompt carries both the owner's attributed record, bound to the lineage id, and the rule for reading it.
 * `ownerRunCommandRecordV1.test.ts` covers the writer and the rubric text separately.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, before, describe, it } from "node:test";
import * as vscode from "vscode";

import { recordOwnerTestRunV1 } from "../commands/recordOwnerTestRunV1";
import { generateImplReviewContextPack } from "../utils/contextPack";
import { blockerOwnerIdentityV1 } from "../utils/ownerCardCoverageV1";
import { OWNER_RUN_COMMAND_HEADING_V1 } from "../utils/ownerEvidenceV1";
import { renderPromptTemplate } from "../utils/promptTemplates";
import { safeRemoveDir } from "./testFsUtils";

const BLOCKER =
  "Owner evidence needed: the integration run `npm run test:integration` cannot run in this stage; run it and report the result";

const ROOT = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ensemble-owner-run-prompt-test-"));
const EXTENSION_URI = vscode.Uri.file(nodePath.resolve(__dirname, "../.."));

const workspaceFs = vscode.workspace.fs as unknown as Record<string, unknown>;
const originalReadFile = workspaceFs["readFile"];

before(() => {
  // The stub's workspace.fs.readFile is unimplemented; back it with the real filesystem so the context pack and
  // the prompt renderer read the real task folder and the real templates.
  workspaceFs["readFile"] = (uri: vscode.Uri): Promise<Uint8Array> =>
    nodeFs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
});

after(() => {
  workspaceFs["readFile"] = originalReadFile;
  safeRemoveDir(ROOT);
});

function setupTask(name: string): { taskDir: string; task: vscode.Uri; ws: vscode.Uri } {
  const ws = nodePath.join(ROOT, name);
  const taskDir = nodePath.join(ws, ".ensemble", "task");
  nodeFs.mkdirSync(taskDir, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(taskDir, "task.md"), "# Task\n\n## Task Description\n\nDo the thing.\n", "utf8");
  return { taskDir, task: vscode.Uri.file(taskDir), ws: vscode.Uri.file(ws) };
}

async function renderReview(task: vscode.Uri, ws: vscode.Uri): Promise<string> {
  const pack = await generateImplReviewContextPack(task, ws, []);
  return renderPromptTemplate(EXTENSION_URI, "review-impl-high.md", { contextPack: pack.content });
}

void describe("review1 Step 52: an owner-run record bound to a lineage id appears in the rendered review prompt", () => {
  void it("the review prompt carries the attributed record, its lineage id, and the rule that a re-raise must cite it", async () => {
    const { taskDir, task, ws } = setupTask("recorded");
    const lineage = blockerOwnerIdentityV1({ description: BLOCKER });
    const recorded = await recordOwnerTestRunV1({
      taskFolderPath: taskDir,
      formId: "f1",
      command: "npm run test:integration",
      exitCode: 0,
      summary: "owner ran it",
      itemTexts: [],
      blockerLineageId: lineage,
      blockerText: BLOCKER,
      outputTail: "62 tests passed\nexit 0",
    });
    assert.equal(recorded.ok, true);

    const prompt = await renderReview(task, ws);

    // The record, as the reviewer sees it: attributed to the owner, bound to the blocker, with the run's facts.
    assert.ok(prompt.includes(OWNER_RUN_COMMAND_HEADING_V1), "the attributed heading is in the prompt");
    assert.ok(prompt.includes(`Blocker lineage id: ${lineage}`), "the lineage id the record is bound to is in the prompt");
    assert.match(prompt, /Command: npm run test:integration/);
    assert.match(prompt, /Exit code: 0 \(passed\)/);
    assert.match(prompt, /Recorded by the owner at: \d{4}-\d{2}-\d{2}T/);
    assert.match(prompt, /62 tests passed/);
    assert.match(prompt, /Blocker answered:\n> Owner evidence needed: the integration run/);

    // The rule for reading it comes from the same rendered prompt, and the placeholder was expanded.
    assert.ok(!prompt.includes("{{reviewScoringRubric}}"), "the rubric placeholder was expanded");
    assert.match(prompt, /If you still file a blocker whose lineage id has such a record, it is a disagreement: say so in the blocker text, cite the record \(command, exit code, time\)/);
    assert.equal(prompt.split(`Blocker lineage id: ${lineage}`).length - 1, 1, "the record appears exactly once");
  });

  void it("with no owner-run record the prompt carries the rule but no record", async () => {
    const { task, ws } = setupTask("none");
    const prompt = await renderReview(task, ws);
    assert.match(prompt, /Owner-run commands:/);
    assert.ok(!/Blocker lineage id: [0-9a-f-]{8,}/.test(prompt), "no record is invented");
    assert.ok(!/Exit code: \d+ \((?:passed|failed)\)/.test(prompt), "no run facts appear");
  });
});
