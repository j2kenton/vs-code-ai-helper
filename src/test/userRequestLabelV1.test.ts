/**
 * bugs4 Step 27 (item 19): every context pack labels its `## User Request` section as the
 * current contents of task.md, so "check task.md" points at the text the round was handed.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { USER_REQUEST_SOURCE_LABEL_V1 } from "../utils/userRequestLabelV1";

void describe("User Request section label (bugs4 item 19)", () => {
  void it("says the section is task.md, read at dispatch time, and wins over stale plan wording", () => {
    assert.match(USER_REQUEST_SOURCE_LABEL_V1, /current contents of `task\.md`, read at dispatch time/);
    assert.match(USER_REQUEST_SOURCE_LABEL_V1, /refers to this section/);
    assert.match(USER_REQUEST_SOURCE_LABEL_V1, /newer and wins/);
  });

  void it("both context-pack builders put the label directly under the heading", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "utils", "contextPack.ts"), "utf8");
    const headings = source.split('lines.push("## User Request");').length - 1;
    const labelled = source.split(
      'lines.push("## User Request");\n  lines.push("");\n  lines.push(USER_REQUEST_SOURCE_LABEL_V1);'
    ).length - 1;
    assert.equal(headings, 2);
    assert.equal(labelled, 2, "every User Request heading is followed by the source label");
  });
});
