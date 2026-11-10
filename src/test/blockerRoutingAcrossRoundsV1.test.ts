/**
 * review2 Step 42 (Part 8): blocker persistence counts rounds, not reviews; task-fixable blockers and failing checks
 * go to a round; the owner-only card offers a tick only for a plan-item blocker; a card Fast Forward carries past
 * never holds it and remembers "Not now"; a blocker card is withdrawn when a review no longer lists its blocker.
 */
import * as assert from "node:assert/strict";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import { describe, it } from "node:test";
import {
  buildBlockerWorkListV1,
  countReviewsBlockerHasStoodV1,
  isFailingCheckBlockerV1,
  isPlanItemBlockerV1,
  reviewSeparationFromHistoryV1,
} from "../utils/blockerWorkListV1";
import type { ReviewBlocker } from "../utils/reviewReadiness";
import { blockerIdentity } from "../utils/reviewRouting";
import { postOwnerOnlyBlockersCardV1 } from "../commands/ownerPlanDecisionCommandV1";
import { isBlockingDecisionV1 } from "../views/chatView";
import { listPendingWorkflowDecisionsForTaskV1 } from "../utils/workflowDecisionDispatchV1";
import { staleBlockerCardsV1 } from "../utils/withdrawStaleBlockerCardsV1";
import { ownerBlockerIdentityV1 } from "../utils/ownerCardCoverageV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { normalizePath } from "../utils/taskRoot";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { countRealFixRoundsV1 } from "../utils/plateauFixCycleV1";

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

function blocker(
  category: ReviewBlocker["category"],
  resolver: ReviewBlocker["resolver"],
  description: string,
  origin?: "reviewer" | "mechanical"
): ReviewBlocker {
  return { category, resolver, description, ...(origin !== undefined ? { origin } : {}) } as ReviewBlocker;
}

const LINT = blocker(
  "shipping",
  "task-fixable",
  "Root lint still fails: `pnpm run lint` reports three errors in reviewActions.ts, roundLostToStateLockV1.ts and a test. This needs the owner to look at nothing, only edits."
);
const PLAN_ITEM = blocker("completion", "task-fixable", "Step 6 remains unbuilt: the card does not offer the id.");

function identities(blockers: readonly ReviewBlocker[]) {
  return blockers.map((b) => blockerIdentity(b));
}

void describe("review2 Step 42: stood unchanged counts fix rounds, not reviews", () => {
  void it("three reviews with no fix round between them are one observation", () => {
    const prior = [identities([PLAN_ITEM]), identities([PLAN_ITEM])];
    // Entry i says whether a fix round ran between review i-1 and review i; the last entry is the current review.
    assert.equal(countReviewsBlockerHasStoodV1(PLAN_ITEM, prior, [undefined, false, false]), 1);
    assert.equal(countReviewsBlockerHasStoodV1(PLAN_ITEM, prior, [undefined, true, true]), 3);
  });

  void it("a review written before the round ids were recorded counts as before", () => {
    const prior = [identities([PLAN_ITEM]), identities([PLAN_ITEM])];
    assert.equal(countReviewsBlockerHasStoodV1(PLAN_ITEM, prior, [undefined, undefined, undefined]), 3);
    assert.equal(countReviewsBlockerHasStoodV1(PLAN_ITEM, prior), 3);
  });

  void it("reads the separation from the history's fixRoundIds", () => {
    assert.deepEqual(reviewSeparationFromHistoryV1([{}, { fixRoundIds: [] }, { fixRoundIds: ["r1"] }]), [undefined, false, true]);
  });

  void it("run1 17:54 replay: reviews with no Apply Review between them do not make a blocker 'stood unchanged'", () => {
    // 16:39, 17:25, 17:43: three reviews, no round between them. The lint blocker is task-fixable work, and a plain
    // task-fixable blocker has not stood across rounds either.
    const prior = [identities([PLAN_ITEM]), identities([PLAN_ITEM])];
    const list = buildBlockerWorkListV1({
      blockers: [PLAN_ITEM],
      priorReviewBlockers: prior,
      reviewSeparatedByFixRound: [undefined, false, false],
      plateauRounds: 3,
    });
    assert.equal(list.notThisRound.length, 0);
    assert.equal(list.fixFirst.length, 1);
    // The same three reviews with a fix round before each do count.
    const separated = buildBlockerWorkListV1({
      blockers: [PLAN_ITEM],
      priorReviewBlockers: prior,
      reviewSeparatedByFixRound: [undefined, true, true],
      plateauRounds: 3,
    });
    assert.equal(separated.notThisRound.length, 1);
    assert.equal(separated.notThisRound[0]!.kind, "standing");
  });

  void it("counts real fix rounds in the ledger", () => {
    const row = (mode: string, state: string) => ({ roundId: mode + state, mode, state, startedAt: "2026-11-09T10:00:00Z" });
    assert.equal(
      countRealFixRoundsV1([row("apply-review", "completed"), row("review", "completed"), row("implementation", "open")] as never),
      1
    );
  });
});

void describe("review2 Step 42: task-fixable blockers and failing checks are round work", () => {
  void it("a failing lint check with 'owner' in its text is fix-first work, never owner-only", () => {
    const list = buildBlockerWorkListV1({ blockers: [LINT], plateauRounds: 3 });
    assert.deepEqual(list.fixFirst.map((item) => item.blocker), [LINT]);
    assert.equal(list.notThisRound.length, 0);
  });

  void it("a failing check never stands, however many separated reviews list it", () => {
    const prior = [identities([LINT]), identities([LINT]), identities([LINT])];
    const list = buildBlockerWorkListV1({
      blockers: [LINT],
      priorReviewBlockers: prior,
      reviewSeparatedByFixRound: [undefined, true, true, true],
      plateauRounds: 3,
    });
    assert.equal(list.notThisRound.length, 0);
    assert.equal(list.fixFirst.length, 1);
  });

  void it("a mechanically recorded failure is a failing check", () => {
    assert.equal(isFailingCheckBlockerV1(blocker("shipping", "task-fixable", "The build failed.", "mechanical")), true);
    assert.equal(isFailingCheckBlockerV1(PLAN_ITEM), false);
  });

  void it("a spec-defect blocker still goes to the owner", () => {
    const list = buildBlockerWorkListV1({
      blockers: [blocker("architectural", "spec-defect", "The plan contradicts itself.")],
      plateauRounds: 3,
    });
    assert.equal(list.notThisRound[0]?.kind, "owner");
  });
});

void describe("review2 Step 42: a tick or exclude is offered only for a plan-item blocker", () => {
  void it("classifies the blocker kinds", () => {
    assert.equal(isPlanItemBlockerV1(LINT), false);
    assert.equal(isPlanItemBlockerV1(PLAN_ITEM), true);
    assert.equal(isPlanItemBlockerV1({ description: "Owner evidence needed: a laptop file" }), true);
    assert.equal(isPlanItemBlockerV1({ description: "Narrowing needs an owner decision" }), true);
  });

  void it("run1 17:54 replay: the card for a lint blocker offers the owner's own words, not Tick or Exclude", async () => {
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    const folder = nodePath.join("/tmp", ".ensemble", "lint-owner-card");
    const card = await postOwnerOnlyBlockersCardV1({
      taskFolderPath: folder,
      stage: "impl-high-review",
      blockerDescriptions: ["Root lint still fails with three source errors: unsafe finally in reviewActions.ts:9700"],
    });
    assert.ok(card);
    assert.deepEqual(card.options.map((o) => o.optionId), ["ownWords", "notNow"]);
    assert.equal(card.recommendation?.kind === "option" ? card.recommendation.optionId : undefined, "ownWords");
    assert.ok(!card.options.some((o) => /Tick or Exclude/.test(o.label)));
  });

  void it("a plan-item blocker keeps the tick option", async () => {
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    const folder = nodePath.join("/tmp", ".ensemble", "plan-item-owner-card");
    const card = await postOwnerOnlyBlockersCardV1({
      taskFolderPath: folder,
      stage: "impl-high-review",
      blockerDescriptions: ["Step 6 owner decision: token hand-off versus the simpler design"],
    });
    assert.ok(card);
    assert.deepEqual(card.options.map((o) => o.optionId), ["settleItem", "notNow"]);
  });
});

void describe("review2 Step 42: a card Fast Forward carries past never holds it", () => {
  void it("is a notice, so it is not a blocking decision", async () => {
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    const folder = nodePath.join("/tmp", ".ensemble", "carry-past-card");
    const carried = await postOwnerOnlyBlockersCardV1({
      taskFolderPath: folder,
      stage: "impl-high-review",
      blockerDescriptions: ["Step 6 owner decision: token hand-off versus the simpler design"],
      continuesWithOtherWork: true,
      fixRoundsRun: 2,
    });
    assert.ok(carried);
    assert.equal(isBlockingDecisionV1(carried), false);
    const stopped = await postOwnerOnlyBlockersCardV1({
      taskFolderPath: nodePath.join("/tmp", ".ensemble", "stop-card"),
      stage: "impl-high-review",
      blockerDescriptions: ["Step 6 owner decision: token hand-off versus the simpler design"],
    });
    assert.ok(stopped);
    assert.equal(isBlockingDecisionV1(stopped), true, "the stop card still holds the run");
  });

  void it("'Not now' is remembered until another round has run", async () => {
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    const folder = nodePath.join("/tmp", ".ensemble", "carry-past-not-now");
    const input = {
      taskFolderPath: folder,
      stage: "impl-high-review" as const,
      blockerDescriptions: ["Step 6 owner decision: token hand-off versus the simpler design"],
      continuesWithOtherWork: true,
    };
    const first = await postOwnerOnlyBlockersCardV1({ ...input, fixRoundsRun: 2 });
    assert.ok(first);
    const store = new WorkflowDecisionStoreV1(context.workspaceState);
    await store.resolve(first.decisionId, "notNow");
    await postOwnerOnlyBlockersCardV1({ ...input, fixRoundsRun: 2 });
    assert.equal(listPendingWorkflowDecisionsForTaskV1(normalizePath(folder)).length, 0, "no second card with no round in between");
    const afterRound = await postOwnerOnlyBlockersCardV1({ ...input, fixRoundsRun: 3 });
    assert.ok(afterRound);
    assert.equal(listPendingWorkflowDecisionsForTaskV1(normalizePath(folder)).length, 1);
  });
});

void describe("review2 Step 42: a blocker card is withdrawn when the review no longer lists its blocker", () => {
  const stage = "impl-high-review" as const;
  const text = "Root lint still fails with three source errors";
  const card = (id: string, blockerIdentities: readonly string[] | undefined, key = "ownerOnlyBlockers:abc") =>
    ({
      decisionId: id,
      decisionKey: key,
      state: "pending",
      stage,
      ...(blockerIdentities !== undefined ? { blockerIdentities } : {}),
    }) as never;

  void it("withdraws a card whose blocker is gone and keeps one that is still listed", () => {
    const own = ownerBlockerIdentityV1(text);
    const other = ownerBlockerIdentityV1("A different blocker");
    const stale = staleBlockerCardsV1([card("gone", [own]), card("kept", [other])], stage, [{ description: "A different blocker" }]);
    assert.deepEqual(stale.map((c) => c.decisionId), ["gone"]);
  });

  void it("a clean review withdraws every blocker card; an older card with no identities is left alone", () => {
    const stale = staleBlockerCardsV1(
      [card("a", [ownerBlockerIdentityV1(text)]), card("old", undefined)],
      stage,
      []
    );
    assert.deepEqual(stale.map((c) => c.decisionId), ["a"]);
  });

  void it("a lineage-keyed card stays while the review still carries the lineage id", () => {
    const stale = staleBlockerCardsV1(
      [card("a", [ownerBlockerIdentityV1("old wording", "lineage-1")])],
      stage,
      [{ description: "reworded text", lineageId: "lineage-1" }]
    );
    assert.equal(stale.length, 0);
  });

  void it("plan-deviation cards and cards of other stages are never touched", () => {
    const stale = staleBlockerCardsV1(
      [
        card("dev", [ownerBlockerIdentityV1(text)], "ownerPlanDecision:plan-deviation-1"),
        { ...(card("other", [ownerBlockerIdentityV1(text)]) as object), stage: "plan-high-review" } as never,
      ],
      stage,
      []
    );
    assert.equal(stale.length, 0);
  });
});
