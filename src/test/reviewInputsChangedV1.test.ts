/**
 * bugs3 Step 9: a resumed run keeps the stage's review only when the task
 * description and plan have not changed since it was written, in addition to
 * the code fingerprint.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { recordReviewInputsV1, reviewInputsChangedSinceV1, reviewWorkspaceChangedSinceV1 } from "../utils/reviewInputsChangedV1";

function setMtime(file: string, secondsFromBase: number): void {
  const base = 1_800_000_000;
  fs.utimesSync(file, base + secondsFromBase, base + secondsFromBase);
}

function folder(): { dir: string; review: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-inputs-"));
  const review = path.join(dir, "impl-high-review.md");
  fs.writeFileSync(review, "review");
  setMtime(review, 100);
  return { dir, review };
}

void describe("reviewInputsChangedSinceV1", () => {
  void it("is unchanged when task.md and plan.md are older than the review", () => {
    const { dir, review } = folder();
    fs.writeFileSync(path.join(dir, "task.md"), "task");
    fs.writeFileSync(path.join(dir, "plan.md"), "plan");
    setMtime(path.join(dir, "task.md"), 10);
    setMtime(path.join(dir, "plan.md"), 20);
    return reviewInputsChangedSinceV1(dir, review).then((result) => {
      assert.equal(result.changed, false);
      assert.deepEqual(result.changedFiles, []);
    });
  });

  void it("names task.md when the owner edited it after the review", async () => {
    const { dir, review } = folder();
    fs.writeFileSync(path.join(dir, "task.md"), "task with new owner evidence");
    setMtime(path.join(dir, "task.md"), 500);
    const result = await reviewInputsChangedSinceV1(dir, review);
    assert.equal(result.changed, true);
    assert.deepEqual(result.changedFiles, ["task.md"]);
  });

  void it("does not use the modification time of plan-final.md, whose checklist ticks change after every review", async () => {
    const { dir, review } = folder();
    fs.writeFileSync(path.join(dir, "plan-final.md"), "- [x] ticked");
    setMtime(path.join(dir, "plan-final.md"), 900);
    // With a record, the tick is invisible; without one the plan of record is simply unknown.
    await recordReviewInputsV1(dir, review);
    fs.utimesSync(review, Date.now() / 1000 + 60, Date.now() / 1000 + 60);
    fs.writeFileSync(path.join(dir, "plan-final.md"), "- [ ] ticked");
    assert.equal((await reviewInputsChangedSinceV1(dir, review)).changed, false);
  });

  void it("a missing input is not an input", async () => {
    const { dir, review } = folder();
    assert.equal((await reviewInputsChangedSinceV1(dir, review)).changed, false);
  });

  void it("with a dispatch-time record, an edit made while the review ran is seen even though the artifact is newer", async () => {
    const { dir, review } = folder();
    fs.writeFileSync(path.join(dir, "task.md"), "task before the review");
    fs.writeFileSync(path.join(dir, "plan.md"), "plan");
    await recordReviewInputsV1(dir, review);
    // The owner edits task.md while the review runs; the artifact is written after that edit.
    fs.writeFileSync(path.join(dir, "task.md"), "task with evidence added mid-review");
    setMtime(path.join(dir, "task.md"), 50);
    fs.utimesSync(review, Date.now() / 1000 + 60, Date.now() / 1000 + 60);
    const result = await reviewInputsChangedSinceV1(dir, review);
    assert.equal(result.changed, true);
    assert.deepEqual(result.changedFiles, ["task.md"]);
  });

  void it("with a dispatch-time record, identical content is unchanged even when the file was touched", async () => {
    const { dir, review } = folder();
    fs.writeFileSync(path.join(dir, "task.md"), "task");
    await recordReviewInputsV1(dir, review);
    fs.utimesSync(review, Date.now() / 1000 + 60, Date.now() / 1000 + 60);
    fs.utimesSync(path.join(dir, "task.md"), Date.now() / 1000 + 120, Date.now() / 1000 + 120);
    assert.equal((await reviewInputsChangedSinceV1(dir, review)).changed, false);
  });

  void it("a record newer than the artifact (a dispatch that failed) does not vouch for the old review", async () => {
    const { dir, review } = folder();
    fs.writeFileSync(path.join(dir, "task.md"), "task");
    setMtime(path.join(dir, "task.md"), 10);
    // The artifact stays at an old mtime; the later dispatch recorded the edited task.md.
    fs.utimesSync(review, Date.now() / 1000 - 3600, Date.now() / 1000 - 3600);
    fs.writeFileSync(path.join(dir, "task.md"), "task edited after the review");
    await recordReviewInputsV1(dir, review);
    const result = await reviewInputsChangedSinceV1(dir, review);
    assert.equal(result.changed, true, "falls back to the modification-time comparison, which sees the newer task.md");
  });

  void it("with a record, ticking plan-final.md items or appending a round summary is unchanged, but rewording an item is changed", async () => {
    const { dir, review } = folder();
    const planFinal = path.join(dir, "plan-final.md");
    fs.writeFileSync(planFinal, "# Implementation checklist\n\n- [ ] Build the thing\n- [ ] Test the thing\n");
    await recordReviewInputsV1(dir, review);
    fs.utimesSync(review, Date.now() / 1000 + 60, Date.now() / 1000 + 60);
    fs.writeFileSync(
      planFinal,
      "# Implementation checklist\n\n- [x] Build the thing\n- [ ] Test the thing\n\n---\n\n## Latest implementation round summary\n\nBuilt it.\n"
    );
    assert.equal((await reviewInputsChangedSinceV1(dir, review)).changed, false, "ticks and the round summary are not inputs");
    fs.writeFileSync(planFinal, "# Implementation checklist\n\n- [ ] Build a different thing\n- [ ] Test the thing\n");
    const reworded = await reviewInputsChangedSinceV1(dir, review);
    assert.equal(reworded.changed, true);
    assert.deepEqual(reworded.changedFiles, ["plan-final.md"]);
  });

  void it("a record written before plan-final.md was an input cannot show an existing plan of record unchanged", async () => {
    const { dir, review } = folder();
    fs.writeFileSync(path.join(dir, "plan-final.md"), "- [ ] one");
    fs.writeFileSync(
      path.join(dir, "review-inputs-v1.json"),
      JSON.stringify({ [path.basename(review)]: { recordedAtMs: 1, digests: { "task.md": "absent", "plan.md": "absent" } } })
    );
    fs.utimesSync(review, Date.now() / 1000 + 60, Date.now() / 1000 + 60);
    const result = await reviewInputsChangedSinceV1(dir, review);
    assert.equal(result.changed, true, "unknown is not the same");
    assert.deepEqual(result.changedFiles, ["plan-final.md"]);
    fs.rmSync(path.join(dir, "plan-final.md"));
    assert.equal((await reviewInputsChangedSinceV1(dir, review)).changed, false, "a plan of record that does not exist is not an input");
  });

  void it("with no record at all, an existing plan of record cannot be shown unchanged", async () => {
    const { dir, review } = folder();
    fs.writeFileSync(path.join(dir, "plan-final.md"), "- [x] ticked");
    const result = await reviewInputsChangedSinceV1(dir, review);
    assert.deepEqual(result.changedFiles, ["plan-final.md"]);
  });

  void it("an unreadable review artifact is never read as current", async () => {
    const { dir } = folder();
    assert.equal((await reviewInputsChangedSinceV1(dir, path.join(dir, "no-such-review.md"))).changed, true);
  });
});

void describe("reviewWorkspaceChangedSinceV1 (plan-stage reviews carry no reviewed-commit stamp)", () => {
  const same = { headSha: "abc", treeFingerprint: "tree-1" };

  async function recorded(identity: { headSha: string | null; treeFingerprint: string | null } | undefined): Promise<{ dir: string; review: string }> {
    const { dir, review } = folder();
    await recordReviewInputsV1(dir, review, identity);
    fs.utimesSync(review, Date.now() / 1000 + 60, Date.now() / 1000 + 60);
    return { dir, review };
  }

  void it("is unchanged only when HEAD and the working-tree fingerprint both match the dispatch-time identity", async () => {
    const { dir, review } = await recorded(same);
    assert.equal(await reviewWorkspaceChangedSinceV1(dir, review, same), false);
    assert.equal(await reviewWorkspaceChangedSinceV1(dir, review, { ...same, treeFingerprint: "tree-2" }), true, "an uncommitted edit");
    assert.equal(await reviewWorkspaceChangedSinceV1(dir, review, { ...same, headSha: "def" }), true, "a commit");
  });

  void it("reads a record that predates the workspace field as changed", async () => {
    const { dir, review } = await recorded(undefined);
    assert.equal(await reviewWorkspaceChangedSinceV1(dir, review, same), true);
  });

  void it("reads an identity git could not give, on either side, as changed", async () => {
    const unknownThen = await recorded({ headSha: null, treeFingerprint: null });
    assert.equal(await reviewWorkspaceChangedSinceV1(unknownThen.dir, unknownThen.review, same), true);
    const knownThen = await recorded(same);
    assert.equal(await reviewWorkspaceChangedSinceV1(knownThen.dir, knownThen.review, { headSha: null, treeFingerprint: null }), true);
  });

  void it("does not read two unavailable identities as unchanged (no repository and unreadable git are not told apart), and a missing artifact is changed", async () => {
    const none = { headSha: null, treeFingerprint: null };
    const { dir, review } = await recorded(none);
    assert.equal(await reviewWorkspaceChangedSinceV1(dir, review, none), true);
    assert.equal(await reviewWorkspaceChangedSinceV1(dir, path.join(dir, "missing.md"), none), true);
  });

  void it("a record newer than the artifact (a dispatch that failed) does not vouch for the old review", async () => {
    const { dir, review } = folder();
    fs.utimesSync(review, Date.now() / 1000 - 3600, Date.now() / 1000 - 3600);
    await recordReviewInputsV1(dir, review, same);
    assert.equal(await reviewWorkspaceChangedSinceV1(dir, review, same), true);
  });
});
