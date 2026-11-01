/**
 * bugs4 item 3 (Fast Forward, in-loop): a re-review refused before any
 * reviewer ran settles its own typed outcome, so the generic "stalled ... run
 * Implementation" warning must not be added on top of it.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { shouldWarnFastForwardStalledV1 } from "../utils/reviewPreflightRefusalV1";

void describe("shouldWarnFastForwardStalledV1", () => {
  void it("warns for a genuine stall", () => {
    assert.equal(
      shouldWarnFastForwardStalledV1({ stalled: true, openItemsCardPostedSinceRunStart: () => false, preflightRefused: false }),
      true
    );
  });

  void it("a preflight-refused re-review gets no second, generic stall warning", () => {
    assert.equal(
      shouldWarnFastForwardStalledV1({ stalled: true, openItemsCardPostedSinceRunStart: () => false, preflightRefused: true }),
      false
    );
  });

  void it("an open-items card already posted this run suppresses it too", () => {
    assert.equal(
      shouldWarnFastForwardStalledV1({ stalled: true, openItemsCardPostedSinceRunStart: () => true, preflightRefused: false }),
      false
    );
  });

  void it("a run that did not stall never reads (or consumes) the open-items marker", () => {
    let probed = 0;
    const result = shouldWarnFastForwardStalledV1({
      stalled: false,
      openItemsCardPostedSinceRunStart: () => {
        probed += 1;
        return false;
      },
      preflightRefused: false,
    });
    assert.equal(result, false);
    assert.equal(probed, 0);
  });
});
