/**
 * review2 Steps 6-7 (bugs6 item 28): the end-of-round checklist check compares item wording without Ensemble's own
 * notes, keeps what the owner settled while the round ran, and says "renumbering" only when a step number moved.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildChecklistChangeProposedDecisionInputV1 } from "../commands/planRevisionV1";
import {
  carryOwnerSettledLinesV1,
  detectChecklistItemSetMutationV1,
  hasStepNumbersChangedV1,
  listPlanItemIdsV1,
} from "../utils/implementationChecklist";

const HEAD = "<!-- ensemble:implementation-checklist -->\n\n";

void describe("end-of-round checklist check keeps the owner's writes (review2 Steps 6-7)", () => {
  void it("an owner tick with a note, made during the round, is not a change to the item set", () => {
    const before = `${HEAD}- [ ] Write the tests for Part 2\n- [ ] Build the thing\n`;
    const after = `${HEAD}- [x] Write the tests for Part 2 — Checked: not reached: the round did not report it built.\n- [ ] Build the thing\n`;
    assert.equal(detectChecklistItemSetMutationV1(before, after), undefined);
  });

  void it("an owner exclusion with its note and marker is not a change either", () => {
    const before = `${HEAD}- [ ] Owner hand-off\n- [ ] Build the thing\n`;
    const after = `${HEAD}- [ ] Owner hand-off — Excluded by you: not a goal. (ensemble:excluded)\n- [ ] Build the thing\n`;
    // The marker's own wording is stripped by the shared helper; whichever form it takes, the item is the same item.
    assert.equal(detectChecklistItemSetMutationV1(before, after.replace("(ensemble:excluded)", "<!-- ensemble:excluded -->")), undefined);
  });

  void it("a round that really adds and drops items is still caught", () => {
    const before = `${HEAD}- [ ] Alpha\n- [ ] Beta\n`;
    const after = `${HEAD}- [ ] Alpha\n- [ ] Gamma\n`;
    const mutation = detectChecklistItemSetMutationV1(before, after);
    assert.equal(mutation?.kind, "renumbered");
    assert.deepEqual(mutation?.addedItems, ["Gamma"]);
    assert.deepEqual(mutation?.removedItems, ["Beta"]);
  });

  void it("restoring the item set keeps the item the owner ticked, with its note, and drops the round's edit", () => {
    const preRound = `${HEAD}- [ ] Alpha\n- [ ] Beta\n- [ ] Gamma\n`;
    // During the round the owner ticked Beta (with a note) and the round itself rewrote Gamma into something else.
    const current = `${HEAD}- [ ] Alpha\n- [x] Beta — Checked: confirmed by you.\n- [ ] Gamma rewritten by the round\n`;
    const betaId = listPlanItemIdsV1(preRound).find((entry) => entry.itemText === "Beta")!.itemId;
    const restored = carryOwnerSettledLinesV1(preRound, current, new Set([betaId]));
    assert.equal(restored, `${HEAD}- [ ] Alpha\n- [x] Beta — Checked: confirmed by you.\n- [ ] Gamma\n`);
  });

  void it("with no owner write in the round, the restore is exactly the start-of-round plan", () => {
    const preRound = `${HEAD}- [ ] Alpha\n- [ ] Beta\n`;
    const current = `${HEAD}- [ ] Alpha\n- [x] Something else\n`;
    assert.equal(carryOwnerSettledLinesV1(preRound, current, new Set()), preRound);
  });

  void it("of two identical items, only the one the owner settled keeps its tick", () => {
    const preRound = `${HEAD}- [ ] Same words\n- [ ] Same words\n- [ ] Tail\n`;
    const ids = listPlanItemIdsV1(preRound);
    const current = `${HEAD}- [ ] Same words\n- [x] Same words — Checked: ok.\n- [ ] Tail replaced\n`;
    const restored = carryOwnerSettledLinesV1(preRound, current, new Set([ids[1]!.itemId]));
    assert.equal(restored, `${HEAD}- [ ] Same words\n- [x] Same words — Checked: ok.\n- [ ] Tail\n`);
  });

  void it("says renumbering only when a step number moved", () => {
    assert.equal(hasStepNumbersChangedV1(["Step 2: Build the thing"], ["Step 3: Build the thing"]), true);
    assert.equal(hasStepNumbersChangedV1(["**Step 2** Build the thing"], ["Step 3 — Build the thing"]), true);
    assert.equal(hasStepNumbersChangedV1(["Step 2: Build the thing"], ["Step 2: Build another thing"]), false);
    assert.equal(hasStepNumbersChangedV1(["Build the thing"], ["Build the thing — Checked: ok."]), false);
  });

  void it("the checklist-change card names a renumbering only for one, and a replacement otherwise", () => {
    const renumbered = buildChecklistChangeProposedDecisionInputV1("c", "/t", "impl", {
      at: "2026-11-05T08:37:11.000Z",
      kind: "renumbered",
      proposedItems: ["Step 3: Build the thing"],
      removedItems: ["Step 2: Build the thing"],
    });
    assert.match(renumbered.whatHappened, /by renumbering the items/);
    const replaced = buildChecklistChangeProposedDecisionInputV1("c", "/t", "impl", {
      at: "2026-11-05T08:37:11.000Z",
      kind: "renumbered",
      proposedItems: ["Write the tests — with a different suffix"],
      removedItems: ["Write the tests"],
    });
    assert.doesNotMatch(replaced.whatHappened, /renumbering/);
    assert.match(replaced.whatHappened, /replacing 1 item with 1 differently worded one/);
  });
});
