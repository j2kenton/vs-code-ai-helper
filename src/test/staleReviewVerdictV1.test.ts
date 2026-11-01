/**
 * bugs4 Step 13 (item 29): a review that predates a change to plan-final.md or task.md is
 * a stale verdict for Complete & Move On, and an unticked nested child is never invisible.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { countOpenNestedChecklistItemsV1 } from "../utils/implementationChecklist";
import { recordReviewInputsV1, staleReviewInputsV1 } from "../utils/reviewInputsChangedV1";
import { buildStaleReviewVerdictTextV1 } from "../utils/staleReviewVerdictV1";

const PLAN_AT_REVIEW = "- [x] Retire the old bucket policy.\n- [x] Other item.\n";

function taskFolder(): { dir: string; review: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stale-verdict-"));
  fs.writeFileSync(path.join(dir, "task.md"), "task text");
  fs.writeFileSync(path.join(dir, "plan-final.md"), PLAN_AT_REVIEW);
  const review = path.join(dir, "impl-low-review.md");
  fs.writeFileSync(review, "Readiness: 9/10");
  return { dir, review };
}

/** The record is written at dispatch; the artifact lands after it. */
async function recordThenPublish(dir: string, review: string): Promise<void> {
  await recordReviewInputsV1(dir, review);
  const later = Date.now() / 1000 + 30;
  fs.utimesSync(review, later, later);
}

void describe("staleReviewInputsV1 (bugs4 item 29)", () => {
  void it("names plan-final.md and the time when children are added after a 9/10 review", async () => {
    const { dir, review } = taskFolder();
    await recordThenPublish(dir, review);
    const withChildren =
      "- [x] Retire the old bucket policy.\n  - [ ] Add the deny-delete fix.\n  - [ ] Add the alarm-flapping fix.\n- [x] Other item.\n";
    fs.writeFileSync(path.join(dir, "plan-final.md"), withChildren);
    const result = await staleReviewInputsV1(dir, review);
    assert.equal(result.recorded, true);
    assert.deepEqual(result.stale.map((entry) => entry.name), ["plan-final.md"]);
    assert.match(result.stale[0]!.modifiedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(countOpenNestedChecklistItemsV1(withChildren), 2, "an unticked nested child shows as open");

    const text = buildStaleReviewVerdictTextV1({
      reviewStageName: "Low-Level Code Review",
      stale: result.stale,
      openNestedItems: 2,
      nextStageName: "Publish",
    });
    assert.match(text.whatHappened, /plan-final\.md \(changed \d{4}-/);
    assert.match(text.whatHappened, /2 unticked sub-item\(s\)/);
    assert.match(text.whyUserNeeded, /Re-run the review/);
  });

  void it("names task.md when the owner edited it after the review", async () => {
    const { dir, review } = taskFolder();
    await recordThenPublish(dir, review);
    fs.writeFileSync(path.join(dir, "task.md"), "task text with owner evidence");
    const result = await staleReviewInputsV1(dir, review);
    assert.deepEqual(result.stale.map((entry) => entry.name), ["task.md"]);
  });

  void it("control: children added and ticked BEFORE the review raise no warning", async () => {
    const { dir, review } = taskFolder();
    fs.writeFileSync(
      path.join(dir, "plan-final.md"),
      "- [x] Retire the old bucket policy.\n  - [x] Add the deny-delete fix.\n- [x] Other item.\n"
    );
    await recordThenPublish(dir, review);
    const result = await staleReviewInputsV1(dir, review);
    assert.equal(result.recorded, true);
    assert.deepEqual(result.stale, []);
  });

  void it("control: ticking an item after the review is not a stale verdict", async () => {
    const { dir, review } = taskFolder();
    fs.writeFileSync(path.join(dir, "plan-final.md"), "- [ ] Retire the old bucket policy.\n- [x] Other item.\n");
    await recordThenPublish(dir, review);
    fs.writeFileSync(path.join(dir, "plan-final.md"), PLAN_AT_REVIEW);
    assert.deepEqual((await staleReviewInputsV1(dir, review)).stale, []);
  });

  void it("counts sub-items added since the review and says so (item 39), without a latch", async () => {
    const { dir, review } = taskFolder();
    await recordThenPublish(dir, review);
    fs.writeFileSync(
      path.join(dir, "plan-final.md"),
      "- [x] Retire the old bucket policy.\n  - [ ] Add the deny-delete fix.\n  - [ ] Add the alarm-flapping fix.\n- [x] Other item.\n"
    );
    const result = await staleReviewInputsV1(dir, review);
    assert.equal(result.nestedItemsAdded, 2);
    const text = buildStaleReviewVerdictTextV1({
      reviewStageName: "Low-Level Code Review",
      stale: result.stale,
      openNestedItems: 2,
      nestedItemsAdded: result.nestedItemsAdded,
      nextStageName: "Publish",
    });
    assert.match(text.whatHappened, /2 sub-item\(s\) added since the last review/);
  });

  void it("children present when the review started are not reported as added", async () => {
    const { dir, review } = taskFolder();
    fs.writeFileSync(path.join(dir, "plan-final.md"), "- [x] Retire the old bucket policy.\n  - [x] Child.\n- [x] Other item.\n");
    await recordThenPublish(dir, review);
    assert.equal((await staleReviewInputsV1(dir, review)).nestedItemsAdded, 0);
  });

  void it("a review with no dispatch-time record is not called stale on a guess", async () => {
    const { dir, review } = taskFolder();
    fs.writeFileSync(path.join(dir, "task.md"), "edited");
    const later = Date.now() / 1000 + 60;
    fs.utimesSync(path.join(dir, "task.md"), later, later);
    const result = await staleReviewInputsV1(dir, review);
    assert.equal(result.recorded, false);
    assert.deepEqual(result.stale, []);
  });
});
