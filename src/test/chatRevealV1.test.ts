/**
 * bugs4 item 20 / Step 33: a card that waits on the owner opens the chat once, never takes focus;
 * the Notifications view reveals only for warnings and errors.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  REVEALED_CARD_IDS_KEY_V1,
  cardWaitsOnOwnerV1,
  rememberRevealedCardV1,
  revealChatForOwnerCardV1,
  setChatRevealHandlerV1,
  shouldRevealChatForCardV1,
} from "../views/chatRevealV1";
import { shouldRevealStatusViewForLevelV1 } from "../views/statusView";

const holding = { decisionId: "d1", gating: { holdsTaskPaused: true, unblocksProgress: true } };
const blocking = { decisionId: "d2", gating: { holdsTaskPaused: false, unblocksProgress: true } };
const optional = { decisionId: "d3", gating: { holdsTaskPaused: false, unblocksProgress: false } };

function fakeState(initial: string[] = []) {
  const store = new Map<string, unknown>([[REVEALED_CARD_IDS_KEY_V1, initial]]);
  return {
    store,
    get<T>(key: string, fallback: T): T {
      return (store.has(key) ? store.get(key) : fallback) as T;
    },
    update(key: string, value: unknown): Promise<void> {
      store.set(key, value);
      return Promise.resolve();
    },
  };
}

void describe("chat reveal for owner cards (bugs4 item 20)", () => {
  void it("only cards that pause or block the task wait on the owner", () => {
    assert.equal(cardWaitsOnOwnerV1(holding), true);
    assert.equal(cardWaitsOnOwnerV1(blocking), true);
    assert.equal(cardWaitsOnOwnerV1(optional), false);
    assert.equal(cardWaitsOnOwnerV1({ decisionId: "x" }), false);
  });

  void it("a card reveals once: not again after it has been remembered", () => {
    assert.equal(shouldRevealChatForCardV1(holding, []), true);
    assert.equal(shouldRevealChatForCardV1(holding, ["d1"]), false);
    assert.equal(shouldRevealChatForCardV1(optional, []), false);
  });

  void it("remembered ids are bounded and idempotent", () => {
    const many = Array.from({ length: 250 }, (_, i) => `id${i}`);
    const next = rememberRevealedCardV1(many, "latest");
    assert.equal(next.length, 200);
    assert.equal(next[next.length - 1], "latest");
    assert.deepEqual(rememberRevealedCardV1(["a"], "a"), ["a"]);
  });

  void it("reveals a waiting card once, persists the id, and a re-post or reload does not reveal again", async () => {
    const calls: string[] = [];
    setChatRevealHandlerV1((id) => {
      calls.push(id);
    });
    try {
      const state = fakeState();
      assert.equal(await revealChatForOwnerCardV1(holding, state), true);
      assert.deepEqual(state.store.get(REVEALED_CARD_IDS_KEY_V1), ["d1"]);
      assert.equal(await revealChatForOwnerCardV1(holding, state), false, "re-render / restore does not reveal again");
      // A window reload keeps the persisted ids.
      assert.equal(await revealChatForOwnerCardV1(holding, fakeState(["d1"])), false);
      // The next NEW card reveals again.
      assert.equal(await revealChatForOwnerCardV1(blocking, state), true);
      assert.deepEqual(calls, ["d1", "d2"]);
    } finally {
      setChatRevealHandlerV1(undefined);
    }
  });

  void it("an optional card, progress or acknowledgement never reveals, and a failing reveal never throws", async () => {
    const calls: string[] = [];
    setChatRevealHandlerV1((id) => {
      calls.push(id);
    });
    try {
      assert.equal(await revealChatForOwnerCardV1(optional, fakeState()), false);
      assert.deepEqual(calls, []);
      setChatRevealHandlerV1(() => {
        throw new Error("view unavailable");
      });
      assert.equal(await revealChatForOwnerCardV1(holding, fakeState()), false);
    } finally {
      setChatRevealHandlerV1(undefined);
    }
  });

  void it("with no registered view or no state nothing happens", async () => {
    setChatRevealHandlerV1(undefined);
    assert.equal(await revealChatForOwnerCardV1(holding, fakeState()), false);
    setChatRevealHandlerV1(() => undefined);
    try {
      assert.equal(await revealChatForOwnerCardV1(holding, undefined), false);
    } finally {
      setChatRevealHandlerV1(undefined);
    }
  });

  void it("the Notifications view reveals only for warnings and errors", () => {
    assert.equal(shouldRevealStatusViewForLevelV1("info"), false);
    assert.equal(shouldRevealStatusViewForLevelV1("warning"), true);
    assert.equal(shouldRevealStatusViewForLevelV1("error"), true);
  });
});
