/**
 * bugs4 Step 13 (item 29): Publish Checks do not silently rely on a code review that predates a
 * change to plan-final.md or task.md; the card names the file and time and offers
 * "Build the new items" when sub-items were added.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildStalePublishTextV1, findStalePublishVerdictV1 } from "../utils/publishStaleVerdictV1";
import { recordReviewInputsV1 } from "../utils/reviewInputsChangedV1";

const PLAN_AT_REVIEW = "- [x] Retire the old bucket policy.\n- [x] Other item.\n";

function taskFolder(): { dir: string; low: string; high: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-stale-"));
  fs.writeFileSync(path.join(dir, "task.md"), "task text");
  fs.writeFileSync(path.join(dir, "plan-final.md"), PLAN_AT_REVIEW);
  const low = path.join(dir, "impl-low-review.md");
  const high = path.join(dir, "impl-high-review.md");
  fs.writeFileSync(low, "Readiness: 9/10");
  fs.writeFileSync(high, "Readiness: 8/10");
  return { dir, low, high };
}

/** The record is written at dispatch; the artifact lands after it. */
async function recordThenFinish(dir: string, review: string): Promise<void> {
  await recordReviewInputsV1(dir, review);
  const later = Date.now() / 1000 + 30;
  fs.utimesSync(review, later, later);
}

const WITH_CHILDREN =
  "- [x] Retire the old bucket policy.\n  - [ ] Add the deny-delete fix.\n  - [ ] Add the alarm-flapping fix.\n- [x] Other item.\n";

void describe("findStalePublishVerdictV1 (bugs4 item 29, Publish entry)", () => {
  void it("a 9/10 Low-Level review, then children added to plan-final.md: Publish sees a stale verdict naming plan-final.md", async () => {
    const { dir, low } = taskFolder();
    await recordThenFinish(dir, low);
    fs.writeFileSync(path.join(dir, "plan-final.md"), WITH_CHILDREN);

    const stale = await findStalePublishVerdictV1(dir);
    assert.ok(stale, "a stale verdict is reported");
    assert.equal(stale.reviewStage, "impl-low-review");
    assert.deepEqual(stale.stale.map((entry) => entry.name), ["plan-final.md"]);
    assert.equal(stale.nestedItemsAdded, 2);
    assert.equal(stale.openNestedItems, 2);

    const text = buildStalePublishTextV1({
      reviewStageName: "Low-Level Code Review",
      stale: stale.stale,
      nestedItemsAdded: stale.nestedItemsAdded,
      openNestedItems: stale.openNestedItems,
    });
    assert.match(text.notice, /Publish Checks were not started/);
    assert.match(text.notice, /plan-final\.md \(changed \d{4}-/);
    assert.match(text.notice, /2 sub-item\(s\) added since that review/);
    assert.equal(text.offerBuildNewItems, true);
    assert.equal(text.recommendation, "buildNewItems");
  });

  void it("an edit to task.md alone recommends re-running the review, not building", async () => {
    const { dir, low } = taskFolder();
    await recordThenFinish(dir, low);
    fs.writeFileSync(path.join(dir, "task.md"), "task text with owner evidence");

    const stale = await findStalePublishVerdictV1(dir);
    assert.ok(stale);
    assert.deepEqual(stale.stale.map((entry) => entry.name), ["task.md"]);
    const text = buildStalePublishTextV1({
      reviewStageName: "Low-Level Code Review",
      stale: stale.stale,
      nestedItemsAdded: stale.nestedItemsAdded,
      openNestedItems: stale.openNestedItems,
    });
    assert.match(text.notice, /task\.md \(changed /);
    assert.equal(text.offerBuildNewItems, false);
    assert.equal(text.recommendation, "rerunReview");
  });

  void it("control: children added and ticked before the review raise no warning", async () => {
    const { dir, low } = taskFolder();
    fs.writeFileSync(
      path.join(dir, "plan-final.md"),
      "- [x] Retire the old bucket policy.\n  - [x] Add the deny-delete fix.\n- [x] Other item.\n"
    );
    await recordThenFinish(dir, low);
    assert.equal(await findStalePublishVerdictV1(dir), undefined);
  });

  void it("control: ticking an existing item after the review is not a stale verdict", async () => {
    const { dir, low } = taskFolder();
    fs.writeFileSync(path.join(dir, "plan-final.md"), "- [ ] Retire the old bucket policy.\n- [x] Other item.\n");
    await recordThenFinish(dir, low);
    fs.writeFileSync(path.join(dir, "plan-final.md"), PLAN_AT_REVIEW);
    assert.equal(await findStalePublishVerdictV1(dir), undefined);
  });

  void it("falls back to the High-Level review when no Low-Level review has a record", async () => {
    const { dir, high } = taskFolder();
    fs.rmSync(path.join(dir, "impl-low-review.md"));
    await recordThenFinish(dir, high);
    fs.writeFileSync(path.join(dir, "plan-final.md"), WITH_CHILDREN);
    const stale = await findStalePublishVerdictV1(dir);
    assert.equal(stale?.reviewStage, "impl-high-review");
  });

  void it("a legacy review with no dispatch-time record, or no review at all, is never reported stale", async () => {
    const { dir } = taskFolder();
    fs.writeFileSync(path.join(dir, "plan-final.md"), WITH_CHILDREN);
    assert.equal(await findStalePublishVerdictV1(dir), undefined, "no record: a modification-time guess is not evidence");
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "publish-stale-empty-"));
    assert.equal(await findStalePublishVerdictV1(empty), undefined);
  });

  void it("the newest recorded review decides: a fresh Low-Level review supersedes a stale High-Level one", async () => {
    const { dir, low, high } = taskFolder();
    await recordThenFinish(dir, high);
    fs.writeFileSync(path.join(dir, "plan-final.md"), WITH_CHILDREN);
    await recordThenFinish(dir, low);
    assert.equal(await findStalePublishVerdictV1(dir), undefined);
  });
});
