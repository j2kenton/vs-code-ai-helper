/**
 * bugs5 Steps 2-4: the reviewer-verified-ticks card while an operation holds the task offers
 * "Apply the N ticks now" (ticks only, dispatches nothing) and "Apply when Fast Forward next
 * pauses" (kept now, carried out later); a newer review's card inherits the kept answer for the
 * items it shares; the withheld note says how to settle items by hand.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import type { CreateWorkflowDecisionInputV1, WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import { liveOperationBlockingOptionV1 } from "../commands/fastForwardResumeSuffixV1";
import { setLiveTaskOperationLookupV1 } from "../utils/liveTaskOperationLookupV1";
import {
  APPLY_OPTION_ID_V1,
  APPLY_TICKS_NOW_COMMAND_V1,
  APPLY_TICKS_NOW_OPTION_ID_V1,
  APPLY_WHEN_PAUSED_OPTION_ID_V1,
  HELD_CARD_STAYS_OPEN_NOTE_V1,
  buildHeldTicksAnswerOptionsV1,
  computeDeferredAnswerCarryOverV1,
  describeDeferredAnswerCarryOverV1,
} from "../commands/verifiedTicksHeldOptionsV1";
import {
  SETTLE_CHECKLIST_ITEM_COMMAND_TITLE_V1,
  SETTLE_WITHHELD_ITEMS_HINT_V1,
  addTickOnlyOptionWhenFastForwardLiveV1,
} from "../commands/applyReviewerVerifiedTicks";
import { decisionHeadingV1, isBlockingDecisionV1 } from "../views/chatView";

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

const TASK = "/tmp/tasks/ticks-task";

/** A stable fake issued id for a test item, so the same wording gets the same id unless a test says otherwise. */
function idOf(item: string): string {
  return `id-${item.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function idsOf(items: readonly string[]): readonly string[] {
  return items.map(idOf);
}

function ticksCard(items: readonly string[], itemIds: readonly (string | null)[] = idsOf(items)): CreateWorkflowDecisionInputV1 {
  return {
    decisionId: "ticks-1",
    decisionKey: "applyReviewerVerifiedTicks",
    taskCanonicalId: TASK,
    stage: "impl-high-review",
    whatHappened: `impl-high-review.md named ${items.length} plan item(s) as verified complete.`,
    whyUserNeeded: "Applying re-arms the completeness gate on the reviewer's word.",
    options: [
      {
        optionId: "apply",
        label: `Apply ${items.length} Reviewer-Verified Ticks and try again (one cycle)`,
        resumeKind: "continue",
        consequence: "Ticks the items, then dispatches this stage's next action.",
        effect: {
          kind: "command",
          command: "vs-code-ai-helper.applyReviewerVerifiedTicksConfirmed",
          args: [{ taskFolderPath: TASK, canonicalId: TASK, reviewStage: "impl-high-review", offeredItems: items, offeredItemIds: itemIds }],
        },
      },
      {
        optionId: "skip",
        label: "Not yet",
        resumeKind: "unpause",
        consequence: "Does nothing. The items stay unticked until you apply this or tick them yourself.",
        effect: { kind: "doNothing" },
      },
    ],
    recommendation: { kind: "option", optionId: "apply", reasoning: "The reviewer verified them." },
    gating: { holdsTaskPaused: false, unblocksProgress: true, detail: "Moves the task forward." },
    createdAt: new Date().toISOString(),
  };
}

function newStore(): WorkflowDecisionStoreV1 {
  return new WorkflowDecisionStoreV1(new FakeMemento() as unknown as import("vscode").Memento);
}

function fastForwardRunning(): void {
  setLiveTaskOperationLookupV1(() => ({ label: "Fast Forward Review", startedAt: Date.now() - 297 * 60_000 }));
}

const ITEMS = ["Item one", "Item two", "Item three"];

void describe("held answers on the reviewer-verified-ticks card (bugs5 Steps 2-3)", () => {
  afterEach(() => setLiveTaskOperationLookupV1(undefined));

  void it("builds a tick-only option that dispatches nothing and a kept-answer option that dispatches like Apply", () => {
    const options = buildHeldTicksAnswerOptionsV1(ticksCard(ITEMS));
    const tickNow = options.find((o) => o.optionId === APPLY_TICKS_NOW_OPTION_ID_V1)!;
    const whenPaused = options.find((o) => o.optionId === APPLY_WHEN_PAUSED_OPTION_ID_V1)!;
    assert.equal(tickNow.label, "Apply the 3 ticks now");
    assert.equal(tickNow.resumeKind, "unpause");
    assert.equal(tickNow.effect.kind === "command" && tickNow.effect.command, APPLY_TICKS_NOW_COMMAND_V1);
    assert.equal(whenPaused.label, "Apply when Fast Forward next pauses");
    assert.equal(whenPaused.runsWhenTaskFree, true);
    const applyEffect = ticksCard(ITEMS).options[0]!.effect;
    assert.deepEqual(whenPaused.effect, applyEffect);
  });

  void it("offers nothing for another card kind", () => {
    assert.deepEqual(buildHeldTicksAnswerOptionsV1({ ...ticksCard(ITEMS), decisionKey: "reconcilePlanChecklist" }), []);
  });

  void it("neither new option is held by a running operation", () => {
    fastForwardRunning();
    const record = { ...ticksCard(ITEMS), state: "pending" } as unknown as WorkflowDecisionV1;
    for (const option of buildHeldTicksAnswerOptionsV1(record)) {
      assert.equal(liveOperationBlockingOptionV1(record, option), undefined, option.optionId);
    }
  });

  void it("while Fast Forward runs: Apply is held, the tick-only option is enabled and recommended, and the card is a decision", async () => {
    const store = newStore();
    await store.post(ticksCard(ITEMS));
    fastForwardRunning();
    const [card] = store.listPending(TASK);
    assert.ok(card);
    const byId = (id: string) => card.options.find((o) => o.optionId === id)!;
    assert.equal(byId(APPLY_OPTION_ID_V1).disabled, true);
    assert.notEqual(byId(APPLY_TICKS_NOW_OPTION_ID_V1).disabled, true);
    assert.notEqual(byId(APPLY_WHEN_PAUSED_OPTION_ID_V1).disabled, true);
    assert.equal(card.recommendation.kind === "option" && card.recommendation.optionId, APPLY_TICKS_NOW_OPTION_ID_V1);
    assert.match(card.whyUserNeeded, /This card stays open\. Its Apply button comes back when Fast Forward ends\./);
    assert.ok(card.whyUserNeeded.includes(HELD_CARD_STAYS_OPEN_NOTE_V1));
    assert.equal(card.options.at(-1)!.optionId, "skip", "Not yet stays last");
    assert.equal(isBlockingDecisionV1(card), true);
    assert.equal(decisionHeadingV1(card), "Decision needed");
  });

  void it("with nothing running the card is unchanged", async () => {
    const store = newStore();
    await store.post(ticksCard(ITEMS));
    const [card] = store.listPending(TASK);
    assert.deepEqual(
      card!.options.map((o) => o.optionId),
      ["apply", "skip"]
    );
  });

  void it("the store accepts the tick-only and kept answers while Fast Forward runs, and still refuses Apply", async () => {
    const store = newStore();
    await store.post(ticksCard(ITEMS));
    fastForwardRunning();
    const refused = await store.resolve("ticks-1", APPLY_OPTION_ID_V1);
    assert.equal(refused.kind, "rejected");
    const tickNow = await store.resolve("ticks-1", APPLY_TICKS_NOW_OPTION_ID_V1);
    assert.equal(tickNow.kind, "resolved");
  });

  void it("a kept answer survives on the record and inherits onto a newer review's card for the shared items", async () => {
    const store = newStore();
    await store.post(ticksCard(ITEMS));
    await store.recordDeferredAnswer("ticks-1", {
      kind: "applyAndDispatch",
      optionId: APPLY_WHEN_PAUSED_OPTION_ID_V1,
      acceptedAt: "2026-11-01T04:30:00.000Z",
      itemKeys: ITEMS,
      itemIds: idsOf(ITEMS),
    });
    const replaced = await store.post(ticksCard(["Item two", "Item three", "Brand new item"]));
    assert.ok(replaced.ok);
    if (!replaced.ok) return;
    assert.equal(replaced.updatedInPlace, true);
    assert.deepEqual(replaced.deferredCarryOver, {
      carried: ["Item two", "Item three"],
      carriedIds: [idOf("Item two"), idOf("Item three")],
      dropped: ["Item one"],
      skipped: [{ item: "Item one", itemId: idOf("Item one"), reason: "notOffered" }],
      newItems: ["Brand new item"],
    });
    assert.deepEqual(replaced.decision.deferredAnswer?.itemKeys, ["Item two", "Item three"]);
    assert.deepEqual(replaced.decision.deferredAnswer?.itemIds, [idOf("Item two"), idOf("Item three")]);
    assert.equal(store.listWithPendingDeferredAnswer(TASK).length, 1);
  });

  void it("two identical items stay two: an answer for the first is not carried to a card offering only the second", async () => {
    const store = newStore();
    await store.post(ticksCard(["Same words", "Same words"], ["id-a1", "id-a2"]));
    await store.recordDeferredAnswer("ticks-1", {
      kind: "applyAndDispatch",
      optionId: APPLY_WHEN_PAUSED_OPTION_ID_V1,
      acceptedAt: "2026-11-01T04:30:00.000Z",
      itemKeys: ["Same words"],
      itemIds: ["id-a1"],
    });
    const replaced = await store.post(ticksCard(["Same words"], ["id-a2"]));
    assert.ok(replaced.ok);
    if (!replaced.ok) return;
    assert.equal(replaced.decision.deferredAnswer, undefined, "the answer for A1 must not tick A2");
    assert.deepEqual(replaced.deferredCarryOver?.carried, []);
    assert.deepEqual(replaced.deferredCarryOver?.skipped, [
      { item: "Same words", itemId: "id-a1", reason: "notOffered" },
    ]);
    assert.ok(replaced.deferredCarryOver);
    const line = describeDeferredAnswerCarryOverV1(replaced.deferredCarryOver);
    assert.match(line, /\[item:id-a1\]/);
    assert.match(line, /no longer offers it/);
  });

  void it("an answer that recorded no id for an item never carries it by wording", () => {
    const carryOver = computeDeferredAnswerCarryOverV1(["Item one"], undefined, ["Item one"], ["id-item-one"]);
    assert.deepEqual(carryOver.carried, []);
    assert.deepEqual(carryOver.skipped, [{ item: "Item one", itemId: null, reason: "noId" }]);
    assert.match(describeDeferredAnswerCarryOverV1(carryOver), /no item id was recorded/);
  });

  void it("a replacement sharing no item drops the kept answer", async () => {
    const store = newStore();
    await store.post(ticksCard(ITEMS));
    await store.recordDeferredAnswer("ticks-1", {
      kind: "applyAndDispatch",
      optionId: APPLY_WHEN_PAUSED_OPTION_ID_V1,
      acceptedAt: "2026-11-01T04:30:00.000Z",
      itemKeys: ITEMS,
      itemIds: idsOf(ITEMS),
    });
    const replaced = await store.post(ticksCard(["Something else"]));
    assert.ok(replaced.ok);
    if (!replaced.ok) return;
    assert.equal(replaced.decision.deferredAnswer, undefined);
    assert.equal(store.listWithPendingDeferredAnswer(TASK).length, 0);
  });

  void it("reopening a card whose kept answer could not run clears the answer", async () => {
    const store = newStore();
    await store.post(ticksCard(ITEMS));
    await store.resolve("ticks-1", "skip");
    await store.recordDeferredAnswer("ticks-1", {
      kind: "ticksOnly",
      optionId: APPLY_TICKS_NOW_OPTION_ID_V1,
      acceptedAt: "2026-11-01T04:30:00.000Z",
      itemKeys: ITEMS,
    });
    assert.equal(await store.reopenResolved("ticks-1", "skip"), true);
    assert.equal(store.get("ticks-1")?.deferredAnswer, undefined);
  });

  void it("marks a carried-out answer so it is not carried out twice", async () => {
    const store = newStore();
    await store.post(ticksCard(ITEMS));
    await store.recordDeferredAnswer("ticks-1", {
      kind: "ticksOnly",
      optionId: APPLY_TICKS_NOW_OPTION_ID_V1,
      acceptedAt: "2026-11-01T04:30:00.000Z",
      itemKeys: ITEMS,
    });
    await store.clearDeferredAnswer("ticks-1", true);
    assert.equal(store.listWithPendingDeferredAnswer(TASK).length, 0);
    assert.ok(store.get("ticks-1")?.deferredAnswer?.carriedOutAt);
  });

  void it("says how many items carried over, how many are new, and names what dropped out", () => {
    const fresh = ["Item two", "Item three", "Fresh"];
    const carryOver = computeDeferredAnswerCarryOverV1(ITEMS, idsOf(ITEMS), fresh, idsOf(fresh));
    const line = describeDeferredAnswerCarryOverV1(carryOver);
    assert.match(line, /Your earlier answer was carried over to 2 of the 3 items; 1 new item waits for you\./);
    assert.match(line, /"Item one" \[item:id-item-one\]/);
  });

  void it("adds the tick-only option before Not yet only while Fast Forward is live", () => {
    const options = ticksCard(ITEMS).options;
    assert.equal(addTickOnlyOptionWhenFastForwardLiveV1(false, options), options);
    const withTickOnly = addTickOnlyOptionWhenFastForwardLiveV1(true, options);
    assert.deepEqual(
      withTickOnly.map((o) => o.optionId),
      ["apply", APPLY_TICKS_NOW_OPTION_ID_V1, "skip"]
    );
  });
});

void describe("withheld items say how to settle them (bugs5 Step 4)", () => {
  void it("names the command exactly as package.json titles it", () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8")) as {
      contributes: { commands: Array<{ command: string; title: string }> };
    };
    const settle = manifest.contributes.commands.find((c) => c.command === "vs-code-ai-helper.settleChecklistItem");
    assert.ok(settle);
    assert.equal(settle.title.replace(/…$/, ""), SETTLE_CHECKLIST_ITEM_COMMAND_TITLE_V1);
    assert.equal(
      SETTLE_WITHHELD_ITEMS_HINT_V1,
      "You can settle them yourself with Tick or Exclude a Checklist Item."
    );
  });
});
