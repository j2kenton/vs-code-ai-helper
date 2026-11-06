/**
 * review1 Step 46 (Part 7), item 7's replays: chat1's real `runs/010` and `runs/025` reports, whose
 * "## Plan deviations" sections say there is nothing to decide ("None beyond …", "None. This round carries out …"),
 * raise no card. The fixtures are unmodified copies of those run files; the owner-decision text of the 06:20 UTC
 * review ("None. The remaining wording fix is task-fixable …") is replayed with them.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import { describe, it } from "node:test";
import { parseOwnerDecisionsNeededV1, parsePlanDeviationsV1, planDeviationsNoneNoteV1 } from "../utils/reviewReadiness";
import { splitSummaryAtEchoV1 } from "../utils/implementationChecklist";
import { raiseOwnerDecisionCardsFromReviewV1, raisePlanDeviationCardsV1 } from "../commands/ownerPlanDecisionCommandV1";
import { listPendingWorkflowDecisionsForTaskV1 } from "../utils/workflowDecisionDispatchV1";
import { normalizePath } from "../utils/taskRoot";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";

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

const FIXTURE_DIR = nodePath.join(__dirname, "..", "..", "src", "test", "fixtures", "chat1-review1");
const readFixture = (name: string): string => nodeFs.readFileSync(nodePath.join(FIXTURE_DIR, name), "utf8");

const RUN_010 = readFixture("010-claude-cli-impl.md");
const RUN_025 = readFixture("025-claude-cli-impl.md");
const PLAN_FINAL = readFixture("plan-final.md");

const REPLAYS = [
  {
    name: "runs/010 (\"None beyond the alternate mechanisms in Verified Complete …\")",
    run: RUN_010,
    sectionText: /^None beyond the alternate mechanisms in Verified Complete/m,
  },
  {
    name: "runs/025 (\"None. This round carries out the owner's 2026-11-03 decision.\")",
    run: RUN_025,
    sectionText: /^None\. This round carries out the owner's 2026-11-03 decision\./m,
  },
] as const;

void describe("review1 Step 46: 'None' plan deviations in chat1's real run files raise no card (item 7 replays)", () => {
  for (const replay of REPLAYS) {
    void it(`${replay.name}: the fixture carries the section, and parsing it yields no card`, () => {
      assert.match(replay.run, /^## Plan deviations$/m, "the fixture is the real run file");
      assert.match(replay.run, replay.sectionText);
      assert.deepEqual(parsePlanDeviationsV1(replay.run, { roundName: "Apply Review", planOfRecord: PLAN_FINAL }), []);
    });

    void it(`${replay.name}: the round's own text (the path reviewActions takes) yields no card either`, () => {
      const own = splitSummaryAtEchoV1(replay.run, PLAN_FINAL).own;
      assert.match(own, /## Plan deviations/);
      assert.deepEqual(parsePlanDeviationsV1(own, { roundName: "Apply Review", planOfRecord: PLAN_FINAL }), []);
    });

    void it(`${replay.name}: raising cards from it posts nothing to the decision store`, async () => {
      __extensionContextV1TestOnly.set(makeExtensionContext());
      const folder = nodePath.join("/tmp", ".ensemble", `none-replay-${replay.run.length}`);
      const canonicalId = normalizePath(folder);
      const raised = await raisePlanDeviationCardsV1(folder, "impl-high-review", replay.run, { roundName: "Apply Review" });
      assert.equal(raised.length, 0);
      assert.equal(listPendingWorkflowDecisionsForTaskV1(canonicalId).length, 0);
    });
  }

  void it("runs/010's text after 'None beyond …' goes to the summary line, not onto a card", () => {
    const note = planDeviationsNoneNoteV1(RUN_010);
    assert.match(note ?? "", /alternate mechanisms in Verified Complete/);
  });

  void it("the 06:20 UTC review's \"None.\" owner-decision text raises no card (owner-decision-1)", async () => {
    const review = [
      "Readiness: 9/10",
      "",
      "## Owner decisions needed",
      "",
      "None. The remaining wording fix is task-fixable under the existing plan.",
      "",
    ].join("\n");
    assert.deepEqual(parseOwnerDecisionsNeededV1(review), []);
    __extensionContextV1TestOnly.set(makeExtensionContext());
    const folder = nodePath.join("/tmp", ".ensemble", "none-owner-decision-replay");
    const canonicalId = normalizePath(folder);
    const raised = await raiseOwnerDecisionCardsFromReviewV1(folder, "impl-high-review", review);
    assert.equal(raised.length, 0);
    assert.equal(listPendingWorkflowDecisionsForTaskV1(canonicalId).length, 0);
  });

  void it("a real departure written into runs/010's section still raises one card naming the step", () => {
    const changed = RUN_010.replace(
      /^None beyond the alternate mechanisms in Verified Complete.*$/m,
      "- Step 19 renders the lease holder through a helper instead of inline."
    );
    assert.notEqual(changed, RUN_010);
    const cards = parsePlanDeviationsV1(changed, { roundName: "Apply Review", planOfRecord: PLAN_FINAL });
    assert.equal(cards.length, 1);
    assert.match(cards[0]!.problem, /lease holder/);
  });
});
