/**
 * review1 Step 46: a `[same:]` blocker that has stood across four reviews reaches the owner card once, and Fast
 * Forward spends no editing round on that blocker alone. Replays the whole path on a real task folder: four review
 * rows in task-progress.json, the review file's `[same:]` line, the helpers Fast Forward calls at its start and
 * after each review, and the loop itself.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { postOwnerOnlyBlockersCardV1 } from "../commands/ownerPlanDecisionCommandV1";
import { standingOnlyBlockersV1 } from "../commands/reviewActions";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { improveReviewScore, type ReviewRoundOutcome } from "../utils/reviewScoreLoop";
import { normalizePath } from "../utils/taskRoot";

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

const BLOCKER_TEXT = "src/utils/saveGuard.ts lets a stale save overwrite a newer one";
const LINEAGE_ID = "5b1f0c2e-saveguard-0";

function reviewWith(...blockerLines: string[]): string {
  return ["Readiness: 6/10", "", "<!-- blockers:start -->", ...blockerLines, "<!-- blockers:end -->", ""].join("\n");
}

function historyRow(index: number): Record<string, unknown> {
  return {
    stage: "impl-high-review",
    score: 6,
    attemptId: `review-${index}`,
    at: `2026-11-04T0${index}:00:00.000Z`,
    blockerCount: 1,
    taskFixableCount: 1,
    blockers: [{ category: "architectural", resolver: "task-fixable", subject: "src/utils/saveguard.ts", id: LINEAGE_ID }],
  };
}

void describe("review1 Step 46: a blocker that stood across four reviews goes to the owner once", () => {
  const STILL_BLOCKED: ReviewRoundOutcome = { score: 6, taskFixableCount: 1, zeroFixableEvidence: false };

  async function makeTask(reviews: number): Promise<{ folder: string; restore: () => void }> {
    const ensembleRoot = nodePath.join(os.tmpdir(), ".ensemble");
    await fs.mkdir(ensembleRoot, { recursive: true });
    const folder = await fs.mkdtemp(nodePath.join(ensembleRoot, "step46-standing-"));
    await fs.writeFile(
      nodePath.join(folder, "task-progress.json"),
      JSON.stringify({
        taskFolder: nodePath.basename(folder),
        currentStage: "impl-high-review",
        status: "active",
        createdAt: "2026-11-04T00:00:00.000Z",
        updatedAt: "2026-11-04T05:00:00.000Z",
        // The newest row is the review being acted on; the ones before it are the prior reviews.
        reviewScoreHistory: Array.from({ length: reviews }, (_, i) => historyRow(i + 1)),
      }),
      "utf8"
    );
    // The vscode stub's workspace.fs is unimplemented; back reads with real disk for this test only.
    const fsTarget = vscode.workspace.fs as unknown as Record<string, unknown>;
    const originalRead = fsTarget.readFile;
    fsTarget.readFile = (uri: vscode.Uri): Promise<Uint8Array> => fs.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
    return {
      folder,
      restore: () => {
        fsTarget.readFile = originalRead;
      },
    };
  }

  void it("raises one owner card, stops Fast Forward before any editing round, and never raises a second card", async () => {
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    const { folder, restore } = await makeTask(4);
    try {
      const folderUri = vscode.Uri.file(folder);
      const review = reviewWith(`- [architectural] [task-fixable] [same:${LINEAGE_ID}] ${BLOCKER_TEXT}`);

      // Fast Forward's start-of-run check: the only blocker has stood across four reviews, so it is the owner's.
      const atStart = await standingOnlyBlockersV1({ folderUri, stage: "impl-high-review", reviewText: review });
      assert.equal(atStart?.length, 1, "the standing blocker is the whole set, so no round has work to do");
      assert.equal(atStart?.[0]?.description, BLOCKER_TEXT);

      // Mirrors reviewActions: a standing-only set posts the owner card and returns before the loop starts.
      let applies = 0;
      if (atStart === undefined) {
        await improveReviewScore({
          context,
          stage: "impl-high-review",
          baselineScore: 6,
          apply: () => {
            applies += 1;
            return Promise.resolve();
          },
          review: () => Promise.resolve(STILL_BLOCKED),
          maxAttempts: 5,
        });
      } else {
        await postOwnerOnlyBlockersCardV1({
          taskFolderPath: folder,
          stage: "impl-high-review",
          blockerDescriptions: atStart.map((b) => b.description),
          blockerLineageIds: atStart.map((b) => (b.lineage && b.lineage.kind !== "new" ? b.lineage.refId : undefined)),
        });
      }
      assert.equal(applies, 0, "Fast Forward spent no editing round on the standing blocker");

      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const ownerCards = (): readonly { decisionKey: string; whatHappened: string }[] =>
        store.listPending(normalizePath(folder)).filter((d) => d.decisionKey.startsWith("ownerOnlyBlockers:"));
      assert.equal(ownerCards().length, 1, "exactly one owner card");
      assert.match(ownerCards()[0]!.whatHappened, /Fast Forward stopped/);

      // The same blocker seen again, by the check that runs after each later review, raises nothing new.
      const again = await postOwnerOnlyBlockersCardV1({
        taskFolderPath: folder,
        stage: "impl-high-review",
        blockerDescriptions: [BLOCKER_TEXT],
        blockerLineageIds: [LINEAGE_ID],
      });
      assert.ok(again, "the existing card is returned");
      assert.equal(ownerCards().length, 1, "still exactly one owner card");
    } finally {
      restore();
    }
  });

  void it("the check after a later review holds the loop with no further editing round", async () => {
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    const { folder, restore } = await makeTask(4);
    try {
      const folderUri = vscode.Uri.file(folder);
      const review = reviewWith(`- [architectural] [task-fixable] [same:${LINEAGE_ID}] ${BLOCKER_TEXT}`);
      let applies = 0;
      let reviews = 0;
      const result = await improveReviewScore({
        context,
        stage: "impl-high-review",
        baselineScore: 6,
        apply: () => {
          applies += 1;
          return Promise.resolve();
        },
        review: () => {
          reviews += 1;
          return Promise.resolve(STILL_BLOCKED);
        },
        // The same hook reviewActions passes: the real work-list check over the real task folder.
        standingBlockersHold: async () => {
          const standing = await standingOnlyBlockersV1({ folderUri, stage: "impl-high-review", reviewText: review });
          if (standing === undefined || standing.length === 0) return undefined;
          return standing.map((b) => b.description).join("; ");
        },
        maxAttempts: 5,
      });
      assert.equal(result.held?.kind, "standing-blockers");
      assert.match(result.held?.detail ?? "", /saveGuard/);
      assert.equal(applies, 1, "only the round that was already under way; none is started for the standing blocker");
      assert.equal(reviews, 1);
    } finally {
      restore();
    }
  });

  void it("a blocker that has stood for fewer reviews is still a round's work", async () => {
    __extensionContextV1TestOnly.set(makeExtensionContext());
    const { folder, restore } = await makeTask(2);
    try {
      const review = reviewWith(`- [architectural] [task-fixable] [same:${LINEAGE_ID}] ${BLOCKER_TEXT}`);
      assert.equal(
        await standingOnlyBlockersV1({ folderUri: vscode.Uri.file(folder), stage: "impl-high-review", reviewText: review }),
        undefined
      );
    } finally {
      restore();
    }
  });
});
