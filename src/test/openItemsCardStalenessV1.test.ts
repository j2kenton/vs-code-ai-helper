/**
 * bugs4 item 13 / Step 24: the open-items card is withdrawn when its listed items become ticked
 * (the 05:01 card listing 35 open items, after 30 verified ticks were applied at 05:04:57).
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isOpenItemsCardStaleV1, parseOpenItemsCardCountV1 } from "../utils/openItemsCardStalenessV1";
import { buildOpenPlanItemsNeedDecisionCardInputV1 } from "../commands/decideOpenPlanItemsV1";
import { listUncheckedChecklistItemTextsV1 } from "../utils/implementationChecklist";

function planWithOpen(total: number, ticked: number): string {
  const lines = ["<!-- ensemble:implementation-checklist -->"];
  for (let index = 1; index <= total; index += 1) {
    lines.push(`- [${index <= ticked ? "x" : " "}] Wire stage ${index} of the retention path`);
  }
  return lines.join("\n");
}

void describe("open-items card staleness", () => {
  void it("reads the count the card stated from its own text", () => {
    const card = buildOpenPlanItemsNeedDecisionCardInputV1({
      taskFolderPath: "/tmp/task",
      taskCanonicalId: "/tmp/task",
      stage: "impl-high-review",
      displayName: "Task",
      items: Array.from({ length: 35 }, (_, index) => ({ itemText: `Wire stage ${index + 1} of the retention path`, reason: "" })),
      createdAt: "2026-10-29T05:01:30.000Z",
    });
    assert.equal(parseOpenItemsCardCountV1(card.whatHappened), 35);
  });

  void it("is stale once ticks have reduced the open items below what the card listed", () => {
    assert.equal(isOpenItemsCardStaleV1("The plan checklist still has 35 open items:", listUncheckedChecklistItemTextsV1(planWithOpen(35, 30), 0).total), true);
    assert.equal(isOpenItemsCardStaleV1("The plan checklist still has 35 open items:", 0), true);
  });

  void it("controls: unchanged or larger open counts, a singular card and a card with no count are not stale", () => {
    assert.equal(isOpenItemsCardStaleV1("The plan checklist still has 35 open items:", 35), false);
    assert.equal(isOpenItemsCardStaleV1("The plan checklist still has 35 open items:", 40), false);
    assert.equal(isOpenItemsCardStaleV1("The plan checklist still has 1 open item:", 0), true);
    assert.equal(isOpenItemsCardStaleV1("Something else happened.", 0), false);
  });
});
