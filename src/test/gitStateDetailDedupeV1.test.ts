/**
 * bugs5 Step 20 (item 8): the same "Git state changed ..." line is posted once per operation, not every few seconds.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

import { shouldPostGitStateDetailV1 } from "../utils/taskOperations";

void describe("bugs5 Step 20: one Git-state line that updates", () => {
  const line =
    "Files changed in git while this round ran, and Ensemble can't tell whether the round or someone else changed them: a.ts. " +
    "Check them before you commit. Evidence: x.json";

  void it("posts the first line", () => {
    assert.equal(shouldPostGitStateDetailV1(undefined, line), true);
  });

  void it("does not post an identical repeat", () => {
    assert.equal(shouldPostGitStateDetailV1(line, line), false);
  });

  void it("posts a changed line, which replaces the previous detail", () => {
    assert.equal(shouldPostGitStateDetailV1(line, line.replace("a.ts", "a.ts, b.ts")), true);
  });

  void it("runTrackedOperation remembers the last line per operation and skips the toast for a repeat", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "utils", "taskOperations.ts"), "utf8");
    const start = source.indexOf("let lastGitStateDetailV1");
    assert.ok(start > 0);
    const block = source.slice(start, start + 1400);
    const guard = block.indexOf("shouldPostGitStateDetailV1(lastGitStateDetailV1, detail)");
    assert.ok(guard > 0);
    assert.ok(guard < block.indexOf("handle.reportRootDetail?.(detail)"));
    assert.ok(guard < block.indexOf("NotificationRouter.showWarning"));
  });
});
