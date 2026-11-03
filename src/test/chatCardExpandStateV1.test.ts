/**
 * chat1 Step 13: the owner's expand/collapse choice is kept per card and per card state, in a bounded
 * list, and survives a reload.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CARD_EXPAND_CHOICES_KEY_V1,
  forgetStaleCardExpandChoicesV1,
  isCardExpandedV1,
  readCardExpandChoicesV1,
  rememberCardExpandChoiceV1,
  saveCardExpandChoiceV1,
  type CardExpandChoiceV1,
  type CardExpandMementoV1,
} from "../views/chatCardExpandStateV1";

function memento(initial: Record<string, unknown> = {}): CardExpandMementoV1 & { store: Record<string, unknown> } {
  const store = { ...initial };
  return {
    store,
    get: <T>(key: string, defaultValue: T): T => (key in store ? (store[key] as T) : defaultValue),
    update: (key: string, value: unknown): Promise<void> => {
      store[key] = value;
      return Promise.resolve();
    },
  };
}

void describe("card expand choices", () => {
  void it("uses the default when nothing was chosen: open expanded, finished collapsed", () => {
    assert.equal(isCardExpandedV1([], "c1", "open"), true);
    assert.equal(isCardExpandedV1([], "c1", "answered"), false);
  });

  void it("a finished card the owner expanded by hand stays expanded after a reload", async () => {
    const state = memento();
    await saveCardExpandChoiceV1(state, { cardId: "c1", state: "answered", expanded: true });
    const afterReload = readCardExpandChoicesV1(state);
    assert.equal(isCardExpandedV1(afterReload, "c1", "answered"), true);
    assert.equal(isCardExpandedV1(afterReload, "c2", "answered"), false, "other cards keep their default");
  });

  void it("a choice applies only while the card is in the state it was made in", () => {
    const choices: CardExpandChoiceV1[] = [{ cardId: "c1", state: "open", expanded: false }];
    assert.equal(isCardExpandedV1(choices, "c1", "open"), false, "still open: the owner's collapse holds");
    assert.equal(isCardExpandedV1(choices, "c1", "answered"), false, "just finished: default collapsed");
    const expandedOpen: CardExpandChoiceV1[] = [{ cardId: "c1", state: "answered", expanded: true }];
    assert.equal(isCardExpandedV1(expandedOpen, "c1", "open"), true, "back to pending: starts expanded");
    const collapsedOpenThenReposted: CardExpandChoiceV1[] = [{ cardId: "old", state: "open", expanded: false }];
    assert.equal(isCardExpandedV1(collapsedOpenThenReposted, "new", "open"), true, "a card raised again under a new id starts expanded");
  });

  void it("keeps one entry per card, newest last, and a bounded list", () => {
    let choices: CardExpandChoiceV1[] = [];
    choices = rememberCardExpandChoiceV1(choices, { cardId: "c1", state: "open", expanded: false });
    choices = rememberCardExpandChoiceV1(choices, { cardId: "c1", state: "open", expanded: true });
    assert.deepEqual(choices, [{ cardId: "c1", state: "open", expanded: true }]);
    for (let i = 0; i < 400; i++) {
      choices = rememberCardExpandChoiceV1(choices, { cardId: `card-${i}`, state: "answered", expanded: true });
    }
    assert.equal(choices.length, 300);
    assert.equal(choices[choices.length - 1]?.cardId, "card-399");
    assert.equal(choices.some((c) => c.cardId === "c1"), false, "the oldest were dropped");
  });

  void it("forgets a choice whose card has since changed state", () => {
    const choices: CardExpandChoiceV1[] = [
      { cardId: "a", state: "open", expanded: false },
      { cardId: "b", state: "answered", expanded: true },
      { cardId: "gone", state: "answered", expanded: true },
    ];
    const kept = forgetStaleCardExpandChoicesV1(choices, new Map([["a", "answered" as const], ["b", "answered" as const]]));
    assert.deepEqual(kept.map((c) => c.cardId), ["b", "gone"]);
  });

  void it("drops malformed stored entries and never throws on a bad value", () => {
    const state = memento({
      [CARD_EXPAND_CHOICES_KEY_V1]: [
        { cardId: "ok", state: "answered", expanded: true },
        { cardId: 5, state: "answered", expanded: true },
        { cardId: "bad-state", state: "weird", expanded: true },
        null,
        "text",
      ],
    });
    assert.deepEqual(readCardExpandChoicesV1(state), [{ cardId: "ok", state: "answered", expanded: true }]);
    assert.deepEqual(readCardExpandChoicesV1(memento({ [CARD_EXPAND_CHOICES_KEY_V1]: "nope" })), []);
    assert.deepEqual(readCardExpandChoicesV1(undefined), []);
  });

  void it("a failed save never throws", async () => {
    const failing: CardExpandMementoV1 = {
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
      update: (): Promise<void> => Promise.reject(new Error("disk full")),
    };
    await saveCardExpandChoiceV1(failing, { cardId: "c", state: "open", expanded: false });
    await saveCardExpandChoiceV1(undefined, { cardId: "c", state: "open", expanded: false });
  });
});
