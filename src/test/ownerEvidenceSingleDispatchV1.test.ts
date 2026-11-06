/**
 * review1 Step 41 / Step 46 (item 6 replay, structural): submitting owner evidence starts exactly one thing. The
 * chat calls the one resume-and-rerun command (one admission claim, held through the review dispatch), never a
 * separate resume followed by a review, so the review is not refused as "already in progress".
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
  ADMISSION_DIRNAME_V1,
  acquireOrAdoptWorkAdmissionV1,
  acquireWorkAdmissionV1,
  authorizeWorkAdmissionHandoffV1,
  hasLiveWorkAdmissionBestEffortV1,
  revokeWorkAdmissionHandoffV1,
} from "../state/workAdmissionV1";
import { safeRemoveDir } from "./testFsUtils";

const ADMISSION_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-owner-evidence-admission-"));
after(() => {
  safeRemoveDir(ADMISSION_ROOT);
});

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function read(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const next = source.indexOf("\n  /**", start + signature.length);
  return source.slice(start, next === -1 ? undefined : next);
}

void describe("owner evidence answer starts one dispatch (review1 item 6)", () => {
  void it("the chat re-runs the review through one command and posts the saved line when it dispatches", () => {
    const body = functionBody(read("src/views/chatView.ts"), "private async rerunOwnerEvidenceReviewV1(");
    const commands = [...body.matchAll(/executeCommand\(\s*"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(commands, ["vs-code-ai-helper.resumeAndRerunReview"]);
    assert.match(body, /Saved; re-running/);
    assert.match(body, /onDispatchingV1/);
  });

  void it("resume and review run under the one claim, handing its token to the review", () => {
    const source = read("src/commands/resumeTask.ts");
    const body = source.slice(source.indexOf("export async function resumeAndRerunReviewV1("));
    const review = body.slice(0, body.indexOf("\n}\n"));
    assert.equal((review.match(/resumeThenDispatchV1\(/g) ?? []).length, 1);
    assert.doesNotMatch(review, /vs-code-ai-helper\.resumeTask"/);
    assert.match(review, /admissionHandoffTokenV1: admissionHandoffToken/);
  });

  void it("replay: a separate resume claim then a review is refused as busy; the single-claim hand-off starts exactly one review", async () => {
    // Before Step 41: submitting the evidence took a `resumeTask` claim and, at the same moment, started the
    // review as a second claim. The second was refused as "already in progress" and no review ran.
    const before = path.join(ADMISSION_ROOT, "two-claims");
    fs.mkdirSync(before, { recursive: true });
    const resumeClaim = await acquireWorkAdmissionV1({ taskFolderPath: before, purpose: "admission", commandId: "resumeTask" });
    assert.equal(resumeClaim.outcome, "acquired");
    if (resumeClaim.outcome !== "acquired") return;
    const refused = await acquireWorkAdmissionV1({ taskFolderPath: before, purpose: "admission", commandId: "runReview" });
    assert.equal(refused.outcome, "busy", "two claims for the same task: the review is the one refused");
    await resumeClaim.handle.release();

    // Now: one claim, held by the resume, handed to the review (what resumeThenDispatchV1 does). The review
    // joins it with the token, so it runs; there is still exactly one marker on disk and no busy refusal.
    const after = path.join(ADMISSION_ROOT, "single-claim");
    fs.mkdirSync(after, { recursive: true });
    const held = await acquireWorkAdmissionV1({ taskFolderPath: after, purpose: "admission", commandId: "resumeThenDispatchV1" });
    assert.equal(held.outcome, "acquired");
    if (held.outcome !== "acquired") return;
    const token = authorizeWorkAdmissionHandoffV1(after);
    let reviewsDispatched = 0;
    const joined = await acquireOrAdoptWorkAdmissionV1({
      taskFolderPath: after,
      purpose: "admission",
      commandId: "runReview",
      handoffToken: token,
    });
    assert.equal(joined.outcome, "acquired", "the review is not refused as 'already in progress'");
    if (joined.outcome === "acquired") {
      reviewsDispatched += 1;
      assert.equal(fs.readdirSync(path.join(after, ADMISSION_DIRNAME_V1)).length, 1, "one claim, not two");
      await joined.handle.release();
    }
    revokeWorkAdmissionHandoffV1(after);
    assert.equal(reviewsDispatched, 1);
    assert.equal(hasLiveWorkAdmissionBestEffortV1(after), true, "the resume still holds the task until the review ends");
    await held.handle.release();
    assert.equal(hasLiveWorkAdmissionBestEffortV1(after), false);

    // A second submission cannot replay the same token to start a second review.
    const replayToken = authorizeWorkAdmissionHandoffV1(after);
    const secondHeld = await acquireWorkAdmissionV1({ taskFolderPath: after, purpose: "admission", commandId: "resumeThenDispatchV1" });
    assert.equal(secondHeld.outcome, "acquired");
    if (secondHeld.outcome !== "acquired") return;
    const first = await acquireOrAdoptWorkAdmissionV1({ taskFolderPath: after, purpose: "admission", commandId: "runReview", handoffToken: replayToken });
    assert.equal(first.outcome, "acquired");
    const second = await acquireOrAdoptWorkAdmissionV1({ taskFolderPath: after, purpose: "admission", commandId: "runReview", handoffToken: replayToken });
    assert.equal(second.outcome, "busy", "one submission, one review");
    if (first.outcome === "acquired") await first.handle.release();
    await secondHeld.handle.release();
  });
});
