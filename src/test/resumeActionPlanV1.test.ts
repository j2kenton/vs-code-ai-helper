/**
 * v1 fixes 2, items 14 + 25 (Part 4, step 9-10): a resume button arranges only
 * an action whose preconditions hold, names it with its provider, and — for a
 * task whose next step is the human's — arranges nothing.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TaskStage } from "../types/taskProgress";
import {
  describeResumeOptionV1,
  describeRetryFailedReviewV1,
  planResumeActionV1,
  type ResumeActionFactsV1,
} from "../utils/resumeActionPlanV1";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

function review(commit: string | undefined, blockers: number): string {
  const lines = ["Readiness: 6/10", "", "Prose.", "", "<!-- blockers:start -->"];
  for (let i = 0; i < blockers; i++) {
    lines.push(`- [completion] [task-fixable] blocker ${i}`);
  }
  lines.push("<!-- blockers:end -->");
  if (commit) {
    lines.push(`<!-- reviewed-commit: ${commit} -->`);
  }
  return lines.join("\n");
}

function facts(stage: TaskStage, overrides: Partial<ResumeActionFactsV1> = {}): ResumeActionFactsV1 {
  return {
    stage,
    nextActor: "automation",
    reviewContent: undefined,
    headSha: HEAD,
    unmet: {},
    providers: { review: "Copilot", apply: "Claude Code", stage: "Claude Code" },
    ...overrides,
  };
}

void describe("planResumeActionV1", () => {
  void it("arranges Review, not Apply Review, when the review is behind HEAD", () => {
    const plan = planResumeActionV1(facts("impl-high-review", { reviewContent: review(OLD, 3) }));
    assert.equal(plan.kind, "run-review");
    assert.equal(plan.kind === "run-review" && plan.label, "Resume and run the review again (Copilot)");
  });

  void it("arranges Review when the review artifact carries the artifact-change stale banner", () => {
    const stale = "# Review Stale\n\nThe workspace changed.";
    const plan = planResumeActionV1(facts("impl-low-review", { reviewContent: stale }));
    assert.equal(plan.kind, "run-review");
  });

  void it("arranges Apply Review, naming the blocker count and provider, when the review is current", () => {
    const plan = planResumeActionV1(facts("impl-high-review", { reviewContent: review(HEAD, 3) }));
    assert.equal(plan.kind, "apply-review");
    assert.equal(plan.kind === "apply-review" && plan.label, "Resume and fix the review's 3 blockers (Claude Code)");
  });

  void it("singularises one blocker", () => {
    const plan = planResumeActionV1(facts("impl-high-review", { reviewContent: review(HEAD, 1) }));
    assert.equal(plan.kind === "apply-review" && plan.label, "Resume and fix the review's 1 blocker (Claude Code)");
  });

  void it("does not compare a plan review against HEAD (its artifact never carries the marker)", () => {
    const plan = planResumeActionV1(facts("plan-high-review", { reviewContent: review(OLD, 2) }));
    assert.equal(plan.kind, "apply-review");
  });

  void it("arranges Review when the review is current by commit but left over from an earlier pass (item 32)", () => {
    const plan = planResumeActionV1(
      facts("impl-high-review", { reviewContent: review(HEAD, 3), reviewPassCurrent: false })
    );
    assert.equal(plan.kind, "run-review");
    assert.equal(plan.kind === "run-review" && plan.label, "Resume and run the review again (Copilot)");
  });

  void it("still applies a review that belongs to the current pass, and does not judge an unestablished pass stale", () => {
    for (const reviewPassCurrent of [true, undefined]) {
      const plan = planResumeActionV1(
        facts("impl-high-review", { reviewContent: review(HEAD, 3), ...(reviewPassCurrent === undefined ? {} : { reviewPassCurrent }) })
      );
      assert.equal(plan.kind, "apply-review");
    }
  });

  void it("does not apply the pass rule to a plan review, which never carries a pass marker", () => {
    const plan = planResumeActionV1(facts("plan-high-review", { reviewContent: review(HEAD, 2), reviewPassCurrent: false }));
    assert.equal(plan.kind, "apply-review");
  });

  void it("arranges Review when no review exists yet", () => {
    const plan = planResumeActionV1(facts("impl-high-review"));
    assert.equal(plan.kind, "run-review");
  });

  void it("stays paused and names the precondition when the selected action's prerequisite is unmet", () => {
    const plan = planResumeActionV1(
      facts("impl-high-review", { reviewContent: review(HEAD, 2), unmet: { apply: "plan-final.md is missing." } })
    );
    assert.deepEqual(plan, { kind: "blocked", precondition: "plan-final.md is missing." });
    const stalePlan = planResumeActionV1(
      facts("impl-high-review", { reviewContent: review(OLD, 2), unmet: { review: "plan.md is missing." } })
    );
    assert.deepEqual(stalePlan, { kind: "blocked", precondition: "plan.md is missing." });
  });

  void it("still arranges Review when only Apply Review's prerequisite is missing", () => {
    const unmet = { apply: "plan-final.md is missing." };
    const stale = planResumeActionV1(facts("impl-high-review", { reviewContent: review(OLD, 2), unmet }));
    assert.equal(stale.kind, "run-review");
    const missing = planResumeActionV1(facts("impl-high-review", { unmet }));
    assert.equal(missing.kind, "run-review");
  });

  void it("does not let a Review-only gap block Apply Review on a current review", () => {
    const plan = planResumeActionV1(
      facts("impl-high-review", { reviewContent: review(HEAD, 2), unmet: { review: "notes missing." } })
    );
    assert.equal(plan.kind, "apply-review");
  });

  void it("stays paused, naming the restore remedy, when Review would refuse an unusable summary", () => {
    const unusableSummary = { remedy: "Restore the last usable summary.", canRestore: true };
    for (const content of [undefined, review(OLD, 2)]) {
      const plan = planResumeActionV1(facts("impl-high-review", { reviewContent: content, unusableSummary }));
      assert.equal(plan.kind, "blocked");
      assert.ok(plan.kind === "blocked" && plan.precondition.includes("Restore the last usable summary."));
      assert.equal(plan.kind === "blocked" && plan.restoreSummary, true);
    }
  });

  void it("does not offer the restore action when no usable previous summary exists", () => {
    const unusableSummary = { remedy: "Run the implementation step again to produce them.", canRestore: false };
    const plan = planResumeActionV1(facts("impl-low-review", { unusableSummary }));
    assert.equal(plan.kind === "blocked" && plan.restoreSummary, false);
  });

  void it("does not let an unusable summary block Apply Review on a current review", () => {
    const unusableSummary = { remedy: "Restore the last usable summary.", canRestore: true };
    const plan = planResumeActionV1(facts("impl-high-review", { reviewContent: review(HEAD, 2), unusableSummary }));
    assert.equal(plan.kind, "apply-review");
  });

  void it("only resumes a new, undrafted task — never Draft with AI on an empty description", () => {
    const plan = planResumeActionV1(facts("desc", { nextActor: "human" }));
    assert.equal(plan.kind, "resume-only");
  });

  void it("only resumes Publish when it awaits Commit & Push — never re-runs passed checks", () => {
    const plan = planResumeActionV1(facts("publish", { nextActor: "human" }));
    assert.equal(plan.kind, "resume-only");
  });

  void it("never re-runs fresh Publish checks: arranges the review in state B, resumes only in state A", () => {
    const stateB = planResumeActionV1(
      facts("publish", { publishChecksFresh: true, publishActions: ["checks", "review"] })
    );
    assert.equal(stateB.kind, "run-review");
    assert.equal(stateB.kind === "run-review" && stateB.label, "Resume and run the Publish review (Copilot)");
    const stateA = planResumeActionV1(facts("publish", { publishChecksFresh: true, publishActions: ["checks"] }));
    assert.equal(stateA.kind, "resume-only");
    assert.match(stateA.kind === "resume-only" ? stateA.reason : "", /Commit & Push/);
  });

  void it("arranges the Publish review in state B for the real post-checks state: nextActor human AND fresh checks", () => {
    // `runPublishChecks` hands back with `nextActor: "human"` once its checks
    // pass, so this is the combination production actually produces.
    const stateB = planResumeActionV1(
      facts("publish", { nextActor: "human", publishChecksFresh: true, publishActions: ["checks", "review"] })
    );
    assert.equal(stateB.kind, "run-review");
    const stateA = planResumeActionV1(
      facts("publish", { nextActor: "human", publishChecksFresh: true, publishActions: ["checks"] })
    );
    assert.equal(stateA.kind, "resume-only");
    assert.match(stateA.kind === "resume-only" ? stateA.reason : "", /Commit & Push/);
  });

  void it("stays paused and names the missing model instead of arranging a review that would refuse", () => {
    const stale = planResumeActionV1(
      facts("impl-high-review", { reviewContent: review(OLD, 3), noModel: { review: true } })
    );
    assert.equal(stale.kind, "blocked");
    assert.match(stale.kind === "blocked" ? stale.precondition : "", /No AI model is configured/);
    const current = planResumeActionV1(
      facts("impl-high-review", { reviewContent: review(HEAD, 3), noModel: { apply: true } })
    );
    assert.equal(current.kind, "blocked");
    const missing = planResumeActionV1(facts("impl-low-review", { noModel: { review: true } }));
    assert.equal(missing.kind, "blocked");
    // State B Publish: the Publish review is a candidate too, so a missing
    // Publish model must block it rather than arrange a refusal.
    const publish = planResumeActionV1(
      facts("publish", {
        nextActor: "human",
        publishChecksFresh: true,
        publishActions: ["checks", "review"],
        noModel: { review: true },
      })
    );
    assert.equal(publish.kind, "blocked");
    assert.match(publish.kind === "blocked" ? publish.precondition : "", /No AI model is configured/);
  });

  void it("blocks the Publish review on its own artifact prerequisite after fresh checks, but never blocks the checks", () => {
    const afterChecks = planResumeActionV1(
      facts("publish", {
        nextActor: "human",
        publishChecksFresh: true,
        publishActions: ["checks", "review"],
        unmet: { review: "plan-final.md is missing." },
      })
    );
    assert.equal(afterChecks.kind, "blocked");
    assert.equal(afterChecks.kind === "blocked" && afterChecks.precondition, "plan-final.md is missing.");
    // The review's requirement is not a reason to refuse the checks that precede it.
    for (const publishChecksFresh of [false, undefined] as const) {
      const checks = planResumeActionV1(
        facts("publish", { publishChecksFresh, publishActions: ["checks", "review"], unmet: { review: "x" } })
      );
      assert.equal(checks.kind, "stage-default");
    }
  });

  void it("still runs the Publish checks when they are stale or their freshness is unknown", () => {
    for (const publishChecksFresh of [false, undefined] as const) {
      const plan = planResumeActionV1(facts("publish", { publishChecksFresh }));
      assert.equal(plan.kind, "stage-default");
    }
  });

  void it("still dispatches the stage default when automation is (or may be) the next actor", () => {
    for (const nextActor of ["automation", undefined] as const) {
      const plan = planResumeActionV1(facts("desc", { nextActor }));
      assert.equal(plan.kind, "stage-default");
      assert.equal(plan.kind === "stage-default" && plan.label, "Resume and run Task Description (Claude Code)");
    }
  });

  void it("does not exempt a genuinely dead automated stage from resuming", () => {
    const plan = planResumeActionV1(facts("impl", { nextActor: "automation" }));
    assert.equal(plan.kind, "stage-default");
  });
});

void describe("describeResumeOptionV1", () => {
  void it("never says 're-run this stage', whatever the plan", () => {
    const plans = [
      undefined,
      planResumeActionV1(facts("impl-high-review", { reviewContent: review(OLD, 3) })),
      planResumeActionV1(facts("impl-high-review", { reviewContent: review(HEAD, 3) })),
      planResumeActionV1(facts("desc", { nextActor: "human" })),
      planResumeActionV1(facts("impl", { unmet: { stage: "plan.md is missing." } })),
      planResumeActionV1(facts("impl")),
    ];
    for (const plan of plans) {
      const option = describeResumeOptionV1(plan);
      assert.ok(!/re-run this stage/i.test(option.label), option.label);
      assert.ok(option.consequence.length > 0);
    }
  });

  // Pre-1.0.0 fixes register, item 22: the label must say whether the
  // action edits code, resolved at card-build time from the plan's own
  // kind — not a bare pass-through of the planned action's label, which is
  // what let "Resume and re-run this stage" dispatch an implementation
  // round while reading as a review re-run.
  void it("apply-review's label names the planned action and says it edits code", () => {
    const plan = planResumeActionV1(facts("impl-high-review", { reviewContent: review(HEAD, 3) }));
    assert.equal(plan.kind, "apply-review");
    assert.equal(
      describeResumeOptionV1(plan).label,
      "Resume and fix the review's 3 blockers (Claude Code) — runs an implementation round that edits code"
    );
    assert.match(describeResumeOptionV1(plan).consequence, /implementation round that edits the workspace/);
  });

  void it("run-review's label names the planned action and says it does not edit code", () => {
    const plan = planResumeActionV1(facts("impl-high-review", { reviewContent: review(OLD, 3) }));
    assert.equal(plan.kind, "run-review");
    const option = describeResumeOptionV1(plan);
    assert.match(option.label, /— a review; it does not edit code$/);
    assert.match(option.consequence, /does not edit code/);
  });

  void it("says what decides the outcome for stage-default and the unresolvable (undefined) plan, instead of guessing", () => {
    const stageDefaultPlan = planResumeActionV1(facts("impl", { nextActor: "automation" }));
    assert.equal(stageDefaultPlan.kind, "stage-default");
    assert.match(
      describeResumeOptionV1(stageDefaultPlan).consequence,
      /whether that action edits code depends on the stage/i
    );
    assert.match(
      describeResumeOptionV1(undefined).consequence,
      /whether it edits code, depends on whether a usable, fresh review already exists/i
    );
  });
});

void describe("describeRetryFailedReviewV1", () => {
  // The exhausted chain belongs to a Review round, so the retry names the Review
  // even when a current review with blockers exists (which the stage default
  // would answer with Apply Review, a different action on a different chain).
  void it("names the review that failed, with its provider", () => {
    const option = describeRetryFailedReviewV1("impl-high-review", "Copilot", undefined);
    assert.equal(option.label, "Retry now: run the High-Level Code Review again (Copilot)");
    assert.equal(option.disabled, undefined);
    assert.equal(option.disabledReason, undefined);
  });

  void it("omits the provider when it cannot be resolved", () => {
    const option = describeRetryFailedReviewV1("impl-high-review", undefined, undefined);
    assert.equal(option.label, "Retry now: run the High-Level Code Review again");
  });

  void it("is disabled with the failed precondition when the review cannot run", () => {
    const option = describeRetryFailedReviewV1("impl-high-review", "Copilot", {
      precondition: "No plan found.",
      restoreSummary: false,
    });
    assert.equal(option.disabled, true);
    assert.equal(option.disabledReason, "No plan found.");
    assert.match(option.label, /unavailable/);
  });
});
