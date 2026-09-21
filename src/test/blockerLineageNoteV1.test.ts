/**
 * v1 fixes 2, item 5: a card naming a remaining blocker states its lineage —
 * new, narrowed from an earlier round, or unchanged — from the marker the
 * reviewer already declared, so an unchanged score beside a narrowed blocker
 * reads as progress rather than a repeat.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeBlockerLineageV1 } from "../utils/reviewEscalation";
import type { ReviewBlocker } from "../utils/reviewReadiness";

const blocker = (lineage: ReviewBlocker["lineage"]): ReviewBlocker => ({
  category: "completion",
  resolver: "task-fixable",
  description: "a blocker",
  ...(lineage ? { lineage } : {}),
});

void describe("describeBlockerLineageV1", () => {
  void it("says nothing when there are no blockers", () => {
    assert.equal(describeBlockerLineageV1([]), "");
  });

  void it("calls a narrowed blocker progress, citing the declared marker", () => {
    const note = describeBlockerLineageV1([blocker({ kind: "narrowed", refId: "b3" })]);
    assert.match(note, /1 blocker narrowed from an earlier round \(declared `\[narrowed:b3\]`\)/);
    assert.match(note, /iteration IS making progress on it/);
  });

  void it("reports an unchanged blocker as not moved, and a new one as newly raised", () => {
    const note = describeBlockerLineageV1([blocker({ kind: "same", refId: "b1" }), blocker({ kind: "new" })]);
    assert.match(note, /1 blocker unchanged from an earlier round \(declared `\[same:b1\]`\) — the last round did not move it/);
    assert.match(note, /1 blocker newly raised this round/);
    assert.doesNotMatch(note, /making progress/);
  });

  void it("reports a blocker with no declared lineage as such instead of guessing", () => {
    const note = describeBlockerLineageV1([blocker(undefined)]);
    assert.match(note, /1 blocker with no lineage declared by the reviewer/);
    assert.doesNotMatch(note, /new|narrowed|unchanged/);
  });

  void it("covers a mixed set in one sentence", () => {
    const note = describeBlockerLineageV1([
      blocker({ kind: "narrowed", refId: "b3" }),
      blocker({ kind: "narrowed", refId: "b4" }),
      blocker({ kind: "new" }),
    ]);
    assert.match(note, /2 blockers narrowed from an earlier round/);
    assert.match(note, /they have simply not cleared yet/);
    assert.match(note, /1 blocker newly raised/);
  });
});
