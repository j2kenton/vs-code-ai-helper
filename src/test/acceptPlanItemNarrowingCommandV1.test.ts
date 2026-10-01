/**
 * RC4 item 3: "Accept this narrowing" records the owner decision under
 * Accepted Non-Goals, then re-runs the review with the unchanged-tree guard
 * bypassed; "Keep the item open" dispatches nothing.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, before, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  acceptPlanItemNarrowingV1,
  AcceptPlanItemNarrowingDepsV1,
} from "../commands/acceptPlanItemNarrowingV1";
import { NotificationRouter } from "../utils/notificationRouter";
import { buildEscalationDecisionV1 } from "../utils/reviewEscalation";
import { derivePlanNonGoalSupersessionsV1 } from "../utils/reviewEvidenceNormalizerV1";
import { ReviewBlocker } from "../utils/reviewReadiness";
import { safeRemoveDir } from "./testFsUtils";

const ROOT = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ensemble-accept-narrowing-test-"));
after(() => {
  safeRemoveDir(ROOT);
});

const ITEM = "Update `a.test.ts` and `b.test.ts` for the new policy";
const BLOCKER =
  "Narrowing needs an owner decision: `Update `a.test.ts` and `b.test.ts` for the new policy` — b.test.ts was not updated";
const PLAN = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "## Build",
  "",
  `- [x] ${ITEM}`,
  "- [ ] Another open item",
  "",
].join("\n");

let counter = 0;
function makeFolder(plan: string): string {
  const folder = nodePath.join(ROOT, `task-${++counter}`);
  nodeFs.mkdirSync(folder, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(folder, "plan-final.md"), plan, "utf8");
  return folder;
}

function makeDeps(
  stage: string,
  dispatched = true
): { deps: AcceptPlanItemNarrowingDepsV1; reruns: string[]; rerunStages: string[] } {
  const reruns: string[] = [];
  const rerunStages: string[] = [];
  return {
    reruns,
    rerunStages,
    deps: {
      readCurrentStage: () => Promise.resolve(stage as never),
      rerunReview: (folder, reviewStage) => {
        reruns.push(folder);
        rerunStages.push(reviewStage);
        return Promise.resolve(dispatched);
      },
    },
  };
}

function arg(folder: string, itemText = ITEM) {
  return {
    taskFolderPath: folder,
    stage: "impl-high-review" as const,
    itemText,
    reason: "b.test.ts never references the feature",
    blockerDescription: BLOCKER,
  };
}

const read = (folder: string): string => nodeFs.readFileSync(nodePath.join(folder, "plan-final.md"), "utf8");

// The vscode stub's workspace.fs is unimplemented; back it with real disk so
// the command reads and writes the fixture plan.
const fsTarget = vscode.workspace.fs as unknown as Record<string, unknown>;
const fsOriginal = { ...fsTarget };
const warnings: string[] = [];
const routerTarget = NotificationRouter as unknown as Record<string, unknown>;
const originalShowWarning = routerTarget.showWarning;
before(() => {
  routerTarget.showWarning = (message: string): void => {
    warnings.push(message);
  };
  fsTarget.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    nodeFs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  fsTarget.writeFile = async (uri: vscode.Uri, content: Uint8Array): Promise<void> => {
    await nodeFs.promises.mkdir(nodePath.dirname(uri.fsPath), { recursive: true });
    await nodeFs.promises.writeFile(uri.fsPath, content);
  };
  fsTarget.createDirectory = (uri: vscode.Uri): Promise<void> =>
    nodeFs.promises.mkdir(uri.fsPath, { recursive: true }).then(() => undefined);
  fsTarget.rename = async (source: vscode.Uri, dest: vscode.Uri): Promise<void> => {
    await nodeFs.promises.rm(dest.fsPath, { force: true });
    await nodeFs.promises.rename(source.fsPath, dest.fsPath);
  };
  fsTarget.delete = (uri: vscode.Uri): Promise<void> =>
    nodeFs.promises.rm(uri.fsPath, { force: true, recursive: true });
});
after(() => {
  routerTarget.showWarning = originalShowWarning;
  for (const key of ["readFile", "writeFile", "createDirectory", "rename", "delete"]) {
    fsTarget[key] = fsOriginal[key];
  }
});

void describe("acceptPlanItemNarrowingV1", () => {
  void it("the entry is appended once with item, reason and verbatim blocker, and the re-review is dispatched", async () => {
    const folder = makeFolder(PLAN);
    const { deps, reruns, rerunStages } = makeDeps("impl-high-review");
    const result = await acceptPlanItemNarrowingV1(arg(folder), deps);
    assert.equal(result.outcome, "done");
    assert.deepEqual(rerunStages, ["impl-high-review"], "the review is re-run for the card's stage");
    const plan = read(folder);
    assert.match(plan, /### Narrowing accepted by the owner \(owner decision, \d{4}-\d{2}-\d{2}\)/);
    assert.ok(plan.includes(`${ITEM} — narrowed: b.test.ts never references the feature.`));
    assert.ok(plan.includes(`Settles the review blocker: "${BLOCKER}"`));
    assert.match(plan, /- \[x\] Update `a\.test\.ts`/, "the item's tick is left as it is");
    assert.deepEqual(reruns, [folder]);
  });

  void it("a second click is alreadyDone, writes nothing more and still dispatches", async () => {
    const folder = makeFolder(PLAN);
    const first = makeDeps("impl-high-review");
    await acceptPlanItemNarrowingV1(arg(folder), first.deps);
    const afterFirst = read(folder);
    const second = makeDeps("impl-high-review");
    const result = await acceptPlanItemNarrowingV1(arg(folder), second.deps);
    assert.equal(result.outcome, "alreadyDone");
    assert.equal(read(folder), afterFirst);
    assert.equal(second.reruns.length, 1);
  });

  void it("an item no longer in the plan is refused and the file is untouched", async () => {
    const folder = makeFolder(PLAN);
    const { deps, reruns } = makeDeps("impl-high-review");
    const result = await acceptPlanItemNarrowingV1(arg(folder, "An item that was reworded"), deps);
    assert.equal(result.outcome, "refused");
    assert.equal(read(folder), PLAN);
    assert.equal(reruns.length, 0);
  });

  void it("an unticked item is refused and the file is untouched", async () => {
    const plan = PLAN.replace(`- [x] ${ITEM}`, `- [ ] ${ITEM}`);
    const folder = makeFolder(plan);
    const { deps, reruns } = makeDeps("impl-high-review");
    const result = await acceptPlanItemNarrowingV1(arg(folder), deps);
    assert.equal(result.outcome, "refused");
    assert.equal(read(folder), plan);
    assert.equal(reruns.length, 0);
  });

  void it("a task that moved past the stage keeps the entry and does not re-review", async () => {
    const folder = makeFolder(PLAN);
    const { deps, reruns } = makeDeps("publish");
    warnings.length = 0;
    const result = await acceptPlanItemNarrowingV1(arg(folder), deps);
    assert.equal(result.outcome, "done");
    assert.ok(read(folder).includes("Settles the review blocker"));
    assert.equal(reruns.length, 0);
    assert.ok(warnings.some((w) => /moved past the stage/.test(w)), "the owner is told the review was not re-run");
  });

  void it("a re-review that was not dispatched still reports the decision as written", async () => {
    const folder = makeFolder(PLAN);
    const { deps, reruns } = makeDeps("impl-high-review", false);
    warnings.length = 0;
    const result = await acceptPlanItemNarrowingV1(arg(folder), deps);
    assert.equal(result.outcome, "done");
    assert.ok(read(folder).includes("Settles the review blocker"));
    assert.equal(reruns.length, 1);
    assert.ok(warnings.some((w) => /decision was written/.test(w)), "the owner is told the review was not re-run");
  });

  void it("the written plan clears the original blocker on the next review", async () => {
    const folder = makeFolder(PLAN);
    await acceptPlanItemNarrowingV1(arg(folder), makeDeps("impl-high-review").deps);
    const blocker: ReviewBlocker = { category: "completion", resolver: "environmental", description: BLOCKER };
    const result = derivePlanNonGoalSupersessionsV1("impl-high-review", [blocker], read(folder), undefined, new Date().toISOString());
    assert.equal(result.effectiveBlockers.length, 0);
  });

  void it("keepItemOpen dispatches nothing", () => {
    const decision = buildEscalationDecisionV1(
      "plateau",
      "impl-high-review",
      "plateau",
      { canonicalId: "c", taskFolderPath: "/t" },
      {
        blockersCount: 1,
        primaryBlockerDescription: BLOCKER,
        allBlockerDescriptions: [BLOCKER],
        narrowedNote: "",
        progressNote: "",
        taskFixableCount: 0,
        hasSpecDefect: false,
        hasDeclinedBlocker: false,
        hasNonFixableBlocker: true,
        nextStageHasRun: false,
        clearingNote: "",
        dispatchModeEvidence: [],
        planItemsOpen: 0,
        narrowing: {
          itemText: ITEM,
          blockerDescription: BLOCKER,
          reason: "r",
          reasonSource: "impl-summary.md",
          evidence: "e",
          evidenceSource: "impl-summary.md",
        },
      }
    );
    const keep = decision.options.find((o) => o.optionId === "keepItemOpen");
    assert.equal(keep?.resumeKind, "unpause");
    assert.equal(keep?.effect.kind, "doNothing");
    const accept = decision.options.find((o) => o.optionId === "acceptNarrowing");
    assert.equal(accept?.resumeKind, "continue");
  });

  void it("the card shows the item, reason and evidence only when a narrowing is present", () => {
    const base = {
      blockersCount: 1,
      primaryBlockerDescription: BLOCKER,
      allBlockerDescriptions: [BLOCKER],
      narrowedNote: "",
      progressNote: "",
      taskFixableCount: 0,
      hasSpecDefect: false,
      hasDeclinedBlocker: false,
      hasNonFixableBlocker: true,
      nextStageHasRun: false,
      clearingNote: "",
      dispatchModeEvidence: [],
      planItemsOpen: 0,
    };
    const target = { canonicalId: "c", taskFolderPath: "/t" };
    const plain = buildEscalationDecisionV1("plateau", "impl-high-review", "plateau", target, base);
    assert.equal(plain.options.some((o) => o.optionId === "acceptNarrowing" || o.optionId === "keepItemOpen"), false);
    assert.equal(plain.evidence?.some((e) => e.label === "Plan item"), false);

    const withNarrowing = buildEscalationDecisionV1("plateau", "impl-high-review", "plateau", target, {
      ...base,
      narrowing: {
        itemText: ITEM,
        blockerDescription: BLOCKER,
        reason: "The round left no reason on file.",
        reasonSource: "none",
        evidence: "No evidence on file; the blocker text above is all the reviewer recorded.",
        evidenceSource: "none",
      },
    });
    const labels = withNarrowing.evidence?.map((e) => e.label) ?? [];
    assert.ok(labels.includes("Plan item"));
    assert.ok(labels.includes("The round's reason"));
    assert.ok(labels.includes("The round's evidence"));
    assert.ok(withNarrowing.options.some((o) => o.optionId === "acceptNarrowing"));
    assert.ok(withNarrowing.options.some((o) => o.optionId === "keepItemOpen"));
  });

  void it("the command file never asks through a pop-up", () => {
    const source = nodeFs.readFileSync(
      nodePath.join(__dirname, "..", "..", "src", "commands", "acceptPlanItemNarrowingV1.ts"),
      "utf8"
    );
    assert.doesNotMatch(source, /showQuickPick|showInputBox|modal\s*:\s*true|showWarningMessage|showInformationMessage/);
  });
});
