/**
 * review1 Steps 19 and 20: Ensemble sorts the review's blockers before a round starts, and the apply prompt
 * carries one order of work.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { describe, it } from "node:test";

import type { ReviewBlockerIdentity } from "../types/taskProgress";
import { buildBlockerWorkListV1, countReviewsBlockerHasStoodV1, formatBlockerWorkListV1 } from "../utils/blockerWorkListV1";
import type { ReviewBlocker } from "../utils/reviewReadiness";
import { blockerIdentity } from "../utils/reviewRouting";

const PLAN = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "## Part 4 — Automation terminalization",
  "",
  "- [ ] Step 12: Terminalize the round ledger",
  "- [ ] Step 13: Withdraw cards at transition sites",
  "",
  "## Part 5 — Later",
  "",
  "- [x] Step 20: Already built",
  "",
].join("\n");

const blocker = (category: ReviewBlocker["category"], resolver: ReviewBlocker["resolver"], description: string): ReviewBlocker => ({
  category,
  resolver,
  description,
});

const DEFECT = blocker("architectural", "task-fixable", "src/utils/saveGuard.ts lets a stale save overwrite a newer one");
const UNBUILT = blocker("completion", "task-fixable", "Part 4 remains unbuilt: terminalization and transition-site withdrawals are missing");
const ENVIRONMENTAL = blocker("completion", "environmental", "The authoritative server test run fails before collecting all 86 suites");
const OWNER = blocker("completion", "task-fixable", "Owner evidence needed: the effective publishVerificationCommands");
const STANDING = blocker("architectural", "task-fixable", "src/utils/standing.ts keeps the wrong default");

function identities(blockers: readonly ReviewBlocker[]): ReviewBlockerIdentity[] {
  return blockers.map((b) => blockerIdentity(b));
}

void describe("buildBlockerWorkListV1 (Step 19)", () => {
  void it("puts 'Part 4 remains unbuilt' under build-to-clear, with the plan steps it names", () => {
    const list = buildBlockerWorkListV1({ blockers: [DEFECT, UNBUILT], planOfRecord: PLAN, plateauRounds: 4 });
    assert.deepEqual(list.fixFirst.map((item) => item.blocker), [DEFECT]);
    assert.equal(list.buildToClear.length, 1);
    assert.equal(list.buildToClear[0]?.blocker, UNBUILT);
    assert.equal(list.buildToClear[0]?.plan[0]?.kind, "part");
    assert.equal(list.buildToClear[0]?.plan[0]?.open, 2);
    assert.equal(list.notThisRound.length, 0);
  });

  void it("a completion blocker that names no open plan work is a defect to fix first", () => {
    const list = buildBlockerWorkListV1({
      blockers: [blocker("completion", "task-fixable", "Part 5 remains unbuilt")],
      planOfRecord: PLAN,
      plateauRounds: 4,
    });
    assert.equal(list.buildToClear.length, 0, "Part 5 has nothing open");
    assert.equal(list.fixFirst.length, 1);
  });

  void it("a 4-round [same:] blocker goes under not-this-round, with the reason", () => {
    const prior = [identities([STANDING]), identities([STANDING]), identities([STANDING])];
    assert.equal(countReviewsBlockerHasStoodV1(STANDING, prior), 4);
    const list = buildBlockerWorkListV1({ blockers: [STANDING, DEFECT], planOfRecord: PLAN, priorReviewBlockers: prior, plateauRounds: 4 });
    assert.deepEqual(list.notThisRound.map((item) => item.blocker), [STANDING]);
    assert.match(list.notThisRound[0]!.reason, /stood unchanged across 4 reviews/);
    assert.deepEqual(list.fixFirst.map((item) => item.blocker), [DEFECT]);

    const brokenStreak = [identities([STANDING]), identities([DEFECT]), identities([STANDING])];
    assert.equal(countReviewsBlockerHasStoodV1(STANDING, brokenStreak), 2, "a review without it ends the streak");
  });

  void it("owner decisions, environmental and needs-toolchain blockers are not this round's work", () => {
    const toolchain = blocker("completion", "needs-toolchain", "Run `npm run test:integration` from outside the task");
    const list = buildBlockerWorkListV1({ blockers: [ENVIRONMENTAL, OWNER, toolchain], planOfRecord: PLAN, plateauRounds: 4 });
    assert.equal(list.fixFirst.length + list.buildToClear.length, 0);
    assert.equal(list.notThisRound.length, 3);
    assert.match(list.notThisRound[0]!.reason, /environmental/);
    assert.match(list.notThisRound[1]!.reason, /only the owner can make/);
    assert.match(list.notThisRound[2]!.reason, /toolchain/);
  });

  void it("a blocker earlier rounds declined with a recorded reason is not retried", () => {
    const list = buildBlockerWorkListV1({
      blockers: [DEFECT],
      planOfRecord: PLAN,
      plateauRounds: 4,
      declined: [{ blockerText: "src/utils/saveGuard.ts lets a stale save overwrite a newer one", reason: "needs an owner decision on the lock design" }],
    });
    assert.equal(list.notThisRound.length, 1);
    assert.match(list.notThisRound[0]!.reason, /declined it, with the recorded reason: needs an owner decision/);
  });

  void it("formats the three groups in the order a round works through them", () => {
    const text = formatBlockerWorkListV1(buildBlockerWorkListV1({ blockers: [DEFECT, UNBUILT, ENVIRONMENTAL], planOfRecord: PLAN, plateauRounds: 4 }));
    assert.ok(text.indexOf("1. Fix first") < text.indexOf("2. Build to clear"));
    assert.ok(text.indexOf("2. Build to clear") < text.indexOf("3. Not this round"));
    assert.match(text, /Build: Part 4 \(2 open\)/);
    assert.match(text, /Why not: no code change resolves it/);
    assert.equal(formatBlockerWorkListV1(buildBlockerWorkListV1({ blockers: [], plateauRounds: 4 })), "The review lists no blockers.");
  });
});

void describe("the apply prompt carries one order of work (Step 20)", () => {
  const template = nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "resources", "prompts", "apply-impl-review-code.md"), "utf8");

  void it("replaces the old rule 3 with fix-first, build-to-clear, then the next unbuilt steps", () => {
    assert.match(template, /3\. Work in this one order/);
    assert.ok(template.indexOf("(1) **Fix first**") < template.indexOf("(2) **Build to clear**"));
    assert.ok(template.indexOf("(2) **Build to clear**") < template.indexOf("(3) with the round's remaining capacity"));
    assert.doesNotMatch(template, /Do not substitute smaller non-blocking changes while \*\*fixable\*\* blockers remain/);
  });

  void it("adds the two rules that go with it and the background-work rule", () => {
    assert.match(template, /Never build on top of an unfixed defect in work the next steps depend on/);
    assert.match(template, /always leave the round with something finished/);
    assert.match(template, /must not end waiting for background work: finish every run you started, or report it as not run/);
  });

  void it("renders the sorted list as a variable", () => {
    assert.ok(template.includes("{{blockerWorkList}}"));
  });
});
