/**
 * Regression for the review's completion blocker: existing tests only
 * asserted `improveReviewScore`'s internal `buildRoundsWithoutProgress`
 * counter, not the actual rendered Fast Forward stop notification built from
 * it in `reviewActions.ts`. This asserts the rendering site itself: the
 * message must name the count of stalled build rounds and must never say
 * "the last rounds changed nothing" (item 19's false-stop-message defect),
 * and must always say running Fast Forward again continues.
 *
 * A source-scan test (matching the existing convention in
 * reviewActionsStageActivity.test.ts) rather than a full dispatch drive,
 * because the property under test IS the rendered wording at the actual
 * notification call site.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const source = fs.readFileSync(
  path.join(process.cwd(), "src", "commands", "reviewActions.ts"),
  "utf8"
);

void describe("reviewActions.ts Fast Forward stalled-stop notification wording", () => {
  void it("renders the count of stalled build rounds from outcome.buildRoundsWithoutProgress instead of a blanket claim", () => {
    // RC2 item 13, Step 50: the branch condition grew a second clause
    // (`&& !consumeOpenItemsCardPostedSinceV1(...)`) so the literal
    // single-line `else if (outcome.stalled) {` no longer appears — anchor
    // on the still-stable `outcome.stalled &&` clause opener instead.
    const stalledBranch = source.indexOf("outcome.stalled &&");
    assert.ok(stalledBranch >= 0, "reviewActions.ts must still handle outcome.stalled");
    const branchSlice = source.slice(stalledBranch, stalledBranch + 3200);

    assert.match(
      branchSlice,
      /consecutive build round\(s\) ran without landing a new plan-checklist tick/,
      "the stalled branch must report how many build rounds ran without a new tick"
    );
    assert.match(
      branchSlice,
      /Running Fast Forward again continues from here/,
      "the stalled message must tell the user that running Fast Forward again continues"
    );
    assert.ok(!/the last rounds changed nothing/.test(branchSlice),
      "the stalled message must never claim \\\"the last rounds changed nothing\\\" when build rounds did run");
  });

  void it("derives the rendered stalled-round count from outcome.buildRoundsWithoutProgress, not a hardcoded or unrelated value", () => {
    const stalledBranch = source.indexOf("outcome.stalled &&");
    assert.ok(stalledBranch >= 0, "reviewActions.ts must still handle outcome.stalled");
    const branchSlice = source.slice(stalledBranch, stalledBranch + 3200);

    assert.match(
      branchSlice,
      /const buildRoundsStalled = outcome\.buildRoundsWithoutProgress \?\? 0;/,
      "the stalled branch must derive its local count directly from outcome.buildRoundsWithoutProgress"
    );
    assert.match(
      branchSlice,
      /\$\{buildRoundsStalled\} consecutive build round\(s\) ran without landing a new plan-checklist tick/,
      "the rendered count must interpolate the same buildRoundsStalled variable derived from outcome.buildRoundsWithoutProgress, not a separate or hardcoded figure"
    );
  });

  /**
   * RC3 item 9 (Step 7), 2026-09-30 review follow-up: a genuine Apply Review
   * dispatch failure (every attempt rejected as malformed, unavailable,
   * etc.) must name the real cause — "Apply Review failed: <reason>" — not
   * collapse into the generic "the review did not produce a new, comparable
   * result" wording, which reads as a non-event and sends the owner to check
   * a run log that (for a genuine dispatch failure) does exist and does name
   * the cause, but which the owner had no reason to suspect existed. The
   * integration test in reviewActionsApplyReviewActivityIntegration.test.ts
   * drives the actual malformed-reply dispatch and asserts the run log,
   * ledger row and chat outcome line; this asserts the rendering site itself
   * — the same source-scan convention this file already uses for the
   * sibling `outcome.stalled` branch, because the property under test is the
   * precedence and wording of the rendered notification, not the dispatch
   * machinery that produces `ffCoordinatorOutcomeForAdmissionV1`.
   */
  void it("names 'Apply Review failed: <reason>' for a genuine dispatch failure, ahead of the generic 'did not produce a new, comparable result' fallback", () => {
    const stalledBranch = source.indexOf("outcome.stalled &&");
    assert.ok(stalledBranch >= 0, "reviewActions.ts must still handle outcome.stalled");
    const branchSlice = source.slice(stalledBranch, stalledBranch + 3200);

    // The dispatch-failure kind set must cover a malformed-reply exhaustion
    // (RC3 item 9's own trigger) alongside the other genuine-failure kinds.
    assert.match(
      branchSlice,
      /const ffDispatchFailureKindsV1 = new Set<TaskActionOutcomeV1\["kind"\]>\(\[/,
      "the stalled branch must classify genuine dispatch-failure outcome kinds separately from a normal stall"
    );
    assert.match(
      branchSlice,
      /"malformedResult"/,
      "an all-malformed Apply Review dispatch (RC3 item 9's own trigger) must be classified as a dispatch failure"
    );

    // The ternary must pick the named-cause branch BEFORE the generic
    // fallback text — i.e. the "Apply Review failed: ..." interpolation
    // must appear earlier in the branch than the generic non-event wording,
    // proving the fallback is reached only when the failure-kind check does
    // not match, not the other way around.
    const namedCauseIndex = branchSlice.indexOf(
      "`Apply Review failed: ${describeTaskActionFailureV1(ffCoordinatorOutcomeForAdmissionV1)}`"
    );
    const genericFallbackIndex = branchSlice.indexOf(
      '"the review did not produce a new, comparable result"'
    );
    assert.ok(namedCauseIndex >= 0, "the branch must interpolate describeTaskActionFailureV1's actual cause");
    assert.ok(genericFallbackIndex >= 0, "the branch must still keep the generic fallback for a true stall with no dispatch-failure outcome");
    assert.ok(
      namedCauseIndex < genericFallbackIndex,
      "the named-cause wording must be checked (and win) ahead of the generic 'did not produce a new, comparable result' fallback, never the reverse"
    );

    // The named-cause branch is gated on the failure-kind set, not applied
    // unconditionally — otherwise a true stall (no dispatch failure at all)
    // would wrongly render "Apply Review failed" instead of the generic text.
    const gateIndex = branchSlice.indexOf("ffDispatchFailureKindsV1.has(ffCoordinatorOutcomeForAdmissionV1.kind)");
    assert.ok(gateIndex >= 0 && gateIndex < namedCauseIndex,
      "the named-cause wording must be gated on ffDispatchFailureKindsV1.has(...), not rendered unconditionally");
  });

  /**
   * RC4 item 1 (Step 7): a CLI runner failure (e.g. a provider usage limit)
   * never reaches the coordinator outcome, so the stop message must prefer the
   * per-attempt `runnerFailure` probe over the generic fallback.
   */
  void it("prefers the Apply Review runner failure (provider + message) over the generic fallback", () => {
    const stalledBranch = source.indexOf("outcome.stalled &&");
    assert.ok(stalledBranch >= 0, "reviewActions.ts must still handle outcome.stalled");
    const branchSlice = source.slice(stalledBranch, stalledBranch + 3200);

    assert.match(
      source,
      /ffRunnerFailureV1 = ffAttemptProbe\.runnerFailure;/,
      "each attempt's probe runnerFailure must be kept for the stop message"
    );
    const runnerIndex = branchSlice.indexOf(
      "`Apply Review failed: ${ffRunnerFailureV1.providerLabel}: ${ffRunnerFailureV1.message}`"
    );
    const genericIndex = branchSlice.indexOf('"the review did not produce a new, comparable result"');
    assert.ok(runnerIndex >= 0, "the stalled branch must render the provider label and message");
    assert.ok(genericIndex >= 0, "the generic fallback must remain for a true stall");
    assert.ok(runnerIndex < genericIndex, "the runner-failure wording must win over the generic fallback");
    assert.match(
      branchSlice,
      /:\s*ffRunnerFailureV1\s*\?\s*`Apply Review failed:/,
      "the runner-failure wording must be gated on ffRunnerFailureV1 being set"
    );
  });

  // RC5: a task that left the Fast Forward target stage must be handed over,
  // never reported as a stalled review.
  void it("returns the stage-left hand-over before the stalled branch can say no comparable result", () => {
    const stageLeft = source.indexOf("if (ffStageLeftForV1) {");
    const stalledBranch = source.indexOf("outcome.stalled &&");
    const generic = source.indexOf('"the review did not produce a new, comparable result"');
    assert.ok(stageLeft >= 0, "the post-loop stage-left exit must exist");
    assert.ok(stageLeft < stalledBranch, "the stage-left return must precede the stalled branch");
    assert.ok(stageLeft < generic, "the stage-left return must precede the generic stall wording");
  });

  void it("does not dispatch Fast Forward Review when resuming into Implementation", () => {
    const resumeSource = fs.readFileSync(path.join(process.cwd(), "src", "commands", "resumeTask.ts"), "utf8");
    const impl = resumeSource.indexOf('if (resumeFastForward && stage === "impl")');
    const ff = resumeSource.indexOf("vs-code-ai-helper.fastForwardReviewWithAI", impl);
    assert.ok(impl >= 0, "the impl branch must exist");
    assert.ok(ff > impl, "the Fast Forward Review dispatch must come after the impl branch");
    assert.match(resumeSource.slice(impl, ff), /runImplementationWithAI[\s\S]*return true;/);
  });

  // RC5 review: valid freshness is not a pass, on every entry path.
  void it("requires a passing saved result for Publish whether or not the checks were run here", () => {
    const fn = source.slice(source.indexOf("export async function fastForwardReviewWithAI"));
    const gate = fn.indexOf('if (targetStage === "publish") {\n    const publishScopeFolder');
    const noReview = fn.indexOf("  if (!initialContent) {\n    // No review has been run yet at this stage");
    const slice = fn.slice(gate, noReview);
    const savedRead = slice.indexOf("const savedChecksPayload");
    const passCheck = slice.indexOf("if (!savedChecksPassed)");
    assert.ok(savedRead > 0 && passCheck > savedRead, "the pass check must follow the saved-result read");
    assert.match(slice, /Publish Checks have not passed/);
  });
});
