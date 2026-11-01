/**
 * bugs4 Step 10 (item 34): "View Full List" returns to the same confirmation instead
 * of ending the run, and every run that ends without committing says so plainly.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildFullListConfirmMessageV1, describeCommitPushNotCommittedV1 } from "../utils/commitPushFullListV1";

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "..", "src", "commands", "commitAndPushTask.ts"),
  "utf8"
);

void describe("Commit & Push View Full List (bugs4 Step 10)", () => {
  void it("the re-asked card lists every file, not the first 15, and says nothing re-ran", () => {
    const files = Array.from({ length: 40 }, (_, i) => `src/file${i}.ts`);
    const text = buildFullListConfirmMessageV1({
      title: "Commit and push bugs4 — please review carefully",
      scopeLabel: "source changes only",
      currentBranch: "main",
      pushDestination: "origin/main",
      scopedFiles: files,
      trailer: "\n\n(3 file(s) changed in the task folder — not staged by default)",
    });
    assert.match(text, /Full list of files to be staged \(40 total\)/);
    for (const file of files) {
      assert.ok(text.includes(`• ${file}`), file);
    }
    assert.match(text, /checks did not run again/);
    assert.match(text, /not staged by default/);
    assert.doesNotMatch(text, /and \d+ more file/);
  });

  void it("the handler loops on the same confirmation instead of returning viewedFullFileList", () => {
    assert.doesNotMatch(SOURCE, /reason: "viewedFullFileList"/);
    assert.match(SOURCE, /let fullListShown = false;/);
    assert.match(SOURCE, /if \(confirmed !== "viewFullList"\) \{\s*break;/);
    // Commit & Push and Cancel are offered on the re-ask; View Full List is not repeated.
    assert.match(SOURCE, /\.\.\.\(fullListShown\s*\?\s*\[\]/);
  });

  void it("the re-ask happens before the checks-reuse revalidation, so no check re-runs", () => {
    const loop = SOURCE.indexOf("let fullListShown = false;");
    const revalidate = SOURCE.indexOf("revalidateReusedCommitPushChecksV1(resolvedTask)", loop);
    assert.ok(loop > 0 && revalidate > loop);
    const between = SOURCE.slice(loop, revalidate);
    assert.doesNotMatch(between, /runCompletionChecks|runPublishChecks|executeCommand/);
  });

  void it("a run that ends without committing says what did not happen, that nothing changed, and the next step", () => {
    const line = describeCommitPushNotCommittedV1("cancelled");
    assert.match(line, /Nothing was committed or pushed/);
    assert.match(line, /working tree and index are unchanged/);
    assert.match(line, /Choose Commit & Push/);
    assert.match(describeCommitPushNotCommittedV1("declined"), /Nothing was committed or pushed/);
  });

  void it("Cancel returns userCancelled with no staging step in between, and its presented text is the plain wording", () => {
    assert.match(SOURCE, /if \(confirmed !== "commitAndPush"\) \{\s*return \{ kind: "notCompleted", reason: "userCancelled" \};/);
    const row = fs.readFileSync(
      path.join(__dirname, "..", "..", "src", "actions", "rows", "commitPushRowV1.ts"),
      "utf8"
    );
    assert.match(row, /userCancelled: NOTHING_COMMITTED_TEXT_V1/);
    assert.doesNotMatch(row, /: "Commit and push cancelled\."/);
  });
});
