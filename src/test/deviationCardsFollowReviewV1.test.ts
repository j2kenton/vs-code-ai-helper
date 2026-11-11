/**
 * bugs6 item 44 (Steps 4-5): open deviation cards take the verdict of a later review's "Material plan deviations"
 * section: Approve with the review's sentence quoted, Reject when a blocker holds it, unchanged otherwise.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import { after, describe, it } from "node:test";
import { assessDeviationAgainstReviewV1 } from "../utils/reviewReadiness";
import {
  raisePlanDeviationCardsV1,
  refreshPlanDeviationCardsFromReviewV1,
} from "../commands/ownerPlanDecisionCommandV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { normalizePath } from "../utils/taskRoot";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";

class FakeMemento {
  private readonly values = new Map<string, unknown>();
  get<T>(key: string, defaultValue: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }
  update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

function makeExtensionContext(): vscode.ExtensionContext {
  const memento = new FakeMemento();
  return {
    workspaceState: memento as unknown as vscode.Memento,
    globalState: memento as unknown as vscode.Memento & { setKeysForSync(keys: readonly string[]): void },
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

const ROOT = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ensemble-deviation-follow-test-"));
after(() => {
  nodeFs.rmSync(ROOT, { recursive: true, force: true });
});

const STAGE = "impl-high-review" as const;

const SUMMARY = [
  "## Plan deviations",
  "",
  "- The carried-over-list strip works on the previous review text given to the model instead of the stored blockers.",
  "- The record is written only for implementation review stages with a tracked file set instead of for every stage.",
].join("\n");

// The 13:02 review: it discusses nothing about the two deviations.
const REVIEW_BEFORE = ["Readiness: 7/10", "", "## Findings", "Part 6 is unbuilt.", "<!-- blockers:start -->", "<!-- blockers:end -->"].join(
  "\n"
);

// The 13:16 review's "Material plan deviations" section.
const REVIEW_1316 = [
  "Readiness: 8/10",
  "",
  "## Material plan deviations",
  "None that change the contract. Neither departs from the plan in a way the owner has to decide; these two cards are status notes, not decisions.",
  "",
  "## Findings",
  "Part 6 is unbuilt.",
].join("\n");

function pendingDeviationCards(context: vscode.ExtensionContext, folder: string) {
  return new WorkflowDecisionStoreV1(context.workspaceState)
    .listPending(normalizePath(folder))
    .filter((d) => d.decisionKey.startsWith("ownerPlanDecision:plan-deviation-"));
}

void describe("bugs6 item 44: deviation cards follow the latest review", () => {
  void it("assesses the 13:16 review as 'meets the plan' for both deviations", () => {
    for (const text of [
      "The carried-over-list strip works on the previous review text given to the model instead of the stored blockers.",
      "The record is written only for implementation review stages with a tracked file set instead of for every stage.",
    ]) {
      const verdict = assessDeviationAgainstReviewV1(text, REVIEW_1316);
      assert.equal(verdict?.kind, "meets");
    }
  });

  void it("after the 13:16 review both cards recommend Approve and quote the review, and none says 'has not verified it'", async () => {
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    const folder = nodePath.join(ROOT, ".ensemble", "follow-approve");
    await raisePlanDeviationCardsV1(folder, STAGE, SUMMARY, { roundName: "Apply Review", latestReviewText: REVIEW_BEFORE });
    const before = pendingDeviationCards(context, folder);
    assert.equal(before.length, 2);
    for (const card of before) {
      assert.match(card.whatHappened, /The latest review has not verified it\./);
      assert.equal(card.recommendation.kind, "none");
    }

    const updated = await refreshPlanDeviationCardsFromReviewV1(folder, STAGE, REVIEW_1316);
    assert.equal(updated, 2);
    const after = pendingDeviationCards(context, folder);
    assert.equal(after.length, 2, "refreshed in place: no second card per deviation");
    for (const card of after) {
      assert.equal(card.recommendation.kind, "option");
      assert.equal(card.recommendation.kind === "option" ? card.recommendation.optionId : "", "approve-deviation");
      assert.match(card.recommendation.reasoning, /^Approve \(the review found it meets the plan\): “/);
      assert.match(card.recommendation.reasoning, /None that change the contract/);
      assert.doesNotMatch(card.whatHappened, /has not verified it/);
      assert.match(card.whatHappened, /The latest review found it meets the plan: “/);
    }
  });

  void it("a review that holds the deviation's step as a blocker makes the card recommend Reject", async () => {
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    const folder = nodePath.join(ROOT, ".ensemble", "follow-reject");
    const summary = [
      "## Plan deviations",
      "",
      "- Step 12 was built differently from the plan: the record skips the tracked-file check.",
    ].join("\n");
    await raisePlanDeviationCardsV1(folder, STAGE, summary, { roundName: "Apply Review", latestReviewText: REVIEW_BEFORE });
    const review = [
      "Readiness: 6/10",
      "## Material plan deviations",
      "Step 12 departs from the plan and is a blocker.",
      "<!-- blockers:start -->",
      "- [completion] [task-fixable] Step 12 skips the tracked-file check the plan requires",
      "<!-- blockers:end -->",
    ].join("\n");
    assert.equal(await refreshPlanDeviationCardsFromReviewV1(folder, STAGE, review), 1);
    const [card] = pendingDeviationCards(context, folder);
    assert.equal(card?.recommendation.kind === "option" ? card.recommendation.optionId : "", "reject-deviation");
    assert.match(card?.whatHappened ?? "", /The latest review holds this as a blocker: Step 12 skips the tracked-file check/);
  });

  void it("with no confident match the card is left unchanged", async () => {
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    const folder = nodePath.join(ROOT, ".ensemble", "follow-nomatch");
    await raisePlanDeviationCardsV1(folder, STAGE, SUMMARY, { roundName: "Apply Review", latestReviewText: REVIEW_BEFORE });
    const before = pendingDeviationCards(context, folder).map((card) => ({ id: card.decisionId, text: card.whatHappened }));
    const silent = ["Readiness: 7/10", "## Material plan deviations", "The logging format changed slightly.", "## Findings", "x"].join("\n");
    assert.equal(await refreshPlanDeviationCardsFromReviewV1(folder, STAGE, silent), 0);
    const afterCards = pendingDeviationCards(context, folder).map((card) => ({ id: card.decisionId, text: card.whatHappened }));
    assert.deepEqual(afterCards, before);
  });

  void it("a review that refuses in the same section never yields 'meets'", () => {
    const review = [
      "Readiness: 6/10",
      "## Material plan deviations",
      "Neither departs from the plan, but the record is unverified and must be fixed.",
    ].join("\n");
    assert.equal(
      assessDeviationAgainstReviewV1("The record is written only for tracked stages instead of every stage.", review),
      undefined
    );
  });
});
