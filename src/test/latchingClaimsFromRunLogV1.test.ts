/**
 * bugs4 Step 15 (items 14-15): the claims that set the unreliable-checklist latch are
 * recovered from the latching round's run log when the triggering summary is not in
 * scope, and only when the logged list is provably complete.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { buildChecklistMergeDiagnosticsNoteV1 } from "../commands/reviewActions";
import { areAllUnmatchedChecklistClaimsAlreadySettledV1 } from "../utils/implementationChecklist";
import { loadLatchingClaimsFromRunLogV1, parseLatchingClaimsFromRunLogV1 } from "../utils/latchingClaimsFromRunLogV1";

const CLAIM_A = "Key a single terminal chat emitter by operation ID and derive its Ended record from `TaskActionOutcomeV1`.";
const CLAIM_B = "Bridge duplicate command and notification endings into the single terminal emitter.";
const CLAIM_C = "A third claim that matches nothing.";

function logWith(note: string): string {
  return `# Run 065\n\nSome body.${note}\n`;
}

void describe("latching claims recovered from the run log (bugs4 item 15)", () => {
  void it("round-trips every unmatched claim written by the diagnostics note, including more than two", () => {
    const claims = [CLAIM_A, CLAIM_B, CLAIM_C];
    const note = buildChecklistMergeDiagnosticsNoteV1({
      mergeKind: "no-match",
      unmatchedSample: claims,
      unmatchedTotal: claims.length,
      latchSet: true,
    });
    const parsed = parseLatchingClaimsFromRunLogV1(logWith(note));
    assert.ok(parsed);
    assert.deepEqual([...parsed.unmatchedAll], claims);
    assert.deepEqual([...parsed.unmatchedSample], claims.slice(0, 2));
  });

  void it("a log from an older build that listed only a sample (no total) is not trusted", () => {
    const note = buildChecklistMergeDiagnosticsNoteV1({
      mergeKind: "no-match",
      unmatchedSample: [CLAIM_A, CLAIM_B],
      latchSet: true,
    });
    assert.equal(parseLatchingClaimsFromRunLogV1(logWith(note)), undefined);
  });

  void it("a total that disagrees with the listed claims is not trusted", () => {
    const note = buildChecklistMergeDiagnosticsNoteV1({
      mergeKind: "no-match",
      unmatchedSample: [CLAIM_A, CLAIM_B],
      unmatchedTotal: 5,
      latchSet: true,
    });
    assert.equal(parseLatchingClaimsFromRunLogV1(logWith(note)), undefined);
  });

  void it("a merged round has no latching claims", () => {
    const note = buildChecklistMergeDiagnosticsNoteV1({ mergeKind: "merged", latchSet: false });
    assert.equal(parseLatchingClaimsFromRunLogV1(logWith(note)), undefined);
  });

  void it("the recovered claims drive the same already-settled judgement as the in-scope result", () => {
    const plan = `- [x] ${CLAIM_A}\n- [x] ${CLAIM_B}\n- [ ] Something else.\n`;
    const restated = buildChecklistMergeDiagnosticsNoteV1({
      mergeKind: "no-match",
      unmatchedSample: [CLAIM_A, CLAIM_B],
      unmatchedTotal: 2,
      latchSet: true,
    });
    const parsed = parseLatchingClaimsFromRunLogV1(logWith(restated));
    assert.ok(parsed);
    assert.equal(areAllUnmatchedChecklistClaimsAlreadySettledV1(plan, parsed.unmatchedAll), true);
    // Control: a claim that matches nothing in the plan keeps the latch justified.
    const withStray = buildChecklistMergeDiagnosticsNoteV1({
      mergeKind: "no-match",
      unmatchedSample: [CLAIM_A, CLAIM_C],
      unmatchedTotal: 2,
      latchSet: true,
    });
    const parsedStray = parseLatchingClaimsFromRunLogV1(logWith(withStray));
    assert.ok(parsedStray);
    assert.equal(areAllUnmatchedChecklistClaimsAlreadySettledV1(plan, parsedStray.unmatchedAll), false);
  });

  void it("the loader reads the newest log that has a diagnostics section, and returns undefined with no runs folder", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "latching-claims-"));
    try {
      assert.equal(await loadLatchingClaimsFromRunLogV1(dir), undefined);
      const runs = path.join(dir, "runs");
      await fs.mkdir(runs);
      const older = buildChecklistMergeDiagnosticsNoteV1({
        mergeKind: "no-match",
        unmatchedSample: [CLAIM_C],
        unmatchedTotal: 1,
        latchSet: true,
      });
      const newer = buildChecklistMergeDiagnosticsNoteV1({
        mergeKind: "no-match",
        unmatchedSample: [CLAIM_A, CLAIM_B],
        unmatchedTotal: 2,
        latchSet: true,
      });
      await fs.writeFile(path.join(runs, "064-claude-cli-impl.md"), logWith(older));
      await fs.writeFile(path.join(runs, "065-claude-cli-impl.md"), logWith(newer));
      await fs.writeFile(path.join(runs, "066-review.md"), "# a review log with no diagnostics section\n");
      const loaded = await loadLatchingClaimsFromRunLogV1(dir);
      assert.deepEqual([...(loaded?.unmatchedAll ?? [])], [CLAIM_A, CLAIM_B]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
