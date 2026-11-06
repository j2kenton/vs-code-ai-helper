/**
 * review1 Step 59 (owner, 2026-11-05; bugs6 items 30 and 34): a partial review scope always has a way out.
 *
 * - The card says plainly when the score would not have cleared the stage anyway.
 * - A Fast Forward run stops for an unaccepted partial scope instead of ending a "clean" review as a success.
 * - "Add the missing files" really adds them, and the list survives the next Apply Review (the 40-entry cap is gone).
 * - When the round history cannot confirm the list, the fallback is git's changes since the baseline commit plus
 *   untracked files, not the last tracked set.
 */
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import * as vscode from "vscode";

import { readGitBaselineReviewScopeV1 } from "../commands/reviewActions";
import { buildPartialScopeDecisionInputV1 } from "../commands/partialScopeDecisionV1";
import { describeFastForwardHoldV1 } from "../utils/fastForwardHoldV1";
import {
  formatPartialScopeVerdictNoteV1,
  hashMissingFilesV1,
  reviewHoldsForPartialScopeV1,
  type PartialReviewScopeV1,
} from "../utils/reviewPartialScopeV1";
import { improveReviewScore } from "../utils/reviewScoreLoop";
import { updateImplReviewFiles } from "../utils/taskProgressTransforms";
import type { TaskProgress } from "../types/taskProgress";

const FILES = Array.from({ length: 62 }, (_, i) => `src/changed${i}.ts`);
const SCOPE: PartialReviewScopeV1 = {
  missingCount: FILES.length,
  summary: "Reviewed 40 of 102 changed files (21 of 60 production files)",
  hash: hashMissingFilesV1(FILES),
  files: FILES,
};

function fakeContext(): vscode.ExtensionContext {
  const store = new Map<string, unknown>();
  return {
    workspaceState: {
      get: (key: string, defaultValue?: unknown) => (store.has(key) ? store.get(key) : defaultValue),
      update: (key: string, value: unknown) => {
        store.set(key, value);
        return Promise.resolve();
      },
    },
  } as unknown as vscode.ExtensionContext;
}

function progressWith(files: string[] | undefined): TaskProgress {
  return {
    taskFolder: "t",
    currentStage: "impl-high-review",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(files ? { implReviewFiles: files } : {}),
  };
}

void describe("the partial-scope card says what the score means", () => {
  void it("a score that would not clear anyway is said so, and Add stays recommended", () => {
    const input = buildPartialScopeDecisionInputV1({
      taskFolderPath: "/ws/.ensemble/t",
      stage: "impl-high-review",
      scope: SCOPE,
      score: 7,
      threshold: 8,
      scoreClears: false,
    });
    assert.match(input.whatHappened, /scored 7\/10/);
    assert.match(input.whatHappened, /Whatever the score/);
    assert.equal(input.recommendation?.kind, "option");
    assert.equal(input.recommendation?.kind === "option" ? input.recommendation.optionId : "", "addAndRereview");
    assert.ok(input.options.some((option) => option.optionId === "acceptPartial"));
    assert.ok(input.decisionKey.endsWith(SCOPE.hash), "one card per exact gap");
  });

  void it("a clearing score keeps the original wording", () => {
    const input = buildPartialScopeDecisionInputV1({
      taskFolderPath: "/ws/.ensemble/t",
      stage: "impl-high-review",
      scope: SCOPE,
      score: 9,
      threshold: 8,
    });
    assert.match(input.whatHappened, /The stage was not advanced\./);
    assert.doesNotMatch(input.whatHappened, /Whatever the score/);
  });
});

void describe("reviewHoldsForPartialScopeV1", () => {
  void it("holds for an unaccepted partial verdict, and not for an accepted or complete one", () => {
    assert.equal(reviewHoldsForPartialScopeV1("Readiness: 9/10\n" + formatPartialScopeVerdictNoteV1(SCOPE, false)), true);
    assert.equal(reviewHoldsForPartialScopeV1("Readiness: 9/10\n" + formatPartialScopeVerdictNoteV1(SCOPE, true)), false);
    assert.equal(reviewHoldsForPartialScopeV1("Readiness: 9/10\nNo blockers.\n"), false);
  });
});

void describe("Fast Forward stops for an unaccepted partial scope", () => {
  void it("a clean review over a partial scope ends as a partial-scope hold, not as a success, and dispatches no round", async () => {
    let applies = 0;
    const result = await improveReviewScore({
      context: fakeContext(),
      stage: "impl-high-review",
      baselineScore: 9,
      maxAttempts: 5,
      zeroFixableTerminates: true,
      preLoopEvidence: { zeroFixableEvidence: true, planIncomplete: false },
      cleanReviewNeverApplies: true,
      partialScopeHold: () => "the latest review was not shown every changed file",
      apply: () => {
        applies += 1;
        return Promise.resolve();
      },
      review: () => Promise.resolve({ score: 9, taskFixableCount: 0, zeroFixableEvidence: true }),
    });
    assert.equal(applies, 0, "no Apply Review is dispatched for a review that could not see the whole change");
    assert.equal(result.held?.kind, "partial-scope");
    assert.equal(result.zeroFixableSuccess, false);
    assert.match(describeFastForwardHoldV1(result.held,"High-Level Code Review", result.attempts), /add the missing files, or accept the gap/);
  });

  void it("with the gap accepted (no hold) the clean review ends as before", async () => {
    const result = await improveReviewScore({
      context: fakeContext(),
      stage: "impl-high-review",
      baselineScore: 9,
      maxAttempts: 5,
      zeroFixableTerminates: true,
      preLoopEvidence: { zeroFixableEvidence: true, planIncomplete: false },
      cleanReviewNeverApplies: true,
      partialScopeHold: () => undefined,
      apply: () => Promise.resolve(),
      review: () => Promise.resolve({ score: 9, taskFixableCount: 0, zeroFixableEvidence: true }),
    });
    assert.equal(result.held?.kind, "clean-review");
  });

  void it("a review with task-fixable blockers is held too: no Apply Review runs against a list that misses files", async () => {
    let applies = 0;
    const result = await improveReviewScore({
      context: fakeContext(),
      stage: "impl-high-review",
      baselineScore: 6,
      maxAttempts: 3,
      zeroFixableTerminates: true,
      preLoopEvidence: { zeroFixableEvidence: false, planIncomplete: false },
      cleanReviewNeverApplies: true,
      partialScopeHold: () => "the latest review was not shown every changed file",
      apply: () => {
        applies += 1;
        return Promise.resolve();
      },
      review: () => Promise.resolve({ score: 6, taskFixableCount: 2, zeroFixableEvidence: false }),
    });
    assert.equal(applies, 0);
    assert.equal(result.held?.kind, "partial-scope");
    assert.equal(result.zeroFixableSuccess, false);
  });

  void it("a baseline that already meets the stop level is held, not reported as a success, when its scope is partial", async () => {
    let applies = 0;
    const result = await improveReviewScore({
      context: fakeContext(),
      stage: "impl-high-review",
      baselineScore: 9,
      stopAtScore: 8,
      maxAttempts: 3,
      zeroFixableTerminates: true,
      preLoopEvidence: { zeroFixableEvidence: true, planIncomplete: false },
      cleanReviewNeverApplies: true,
      partialScopeHold: () => "the latest review was not shown every changed file",
      apply: () => {
        applies += 1;
        return Promise.resolve();
      },
      review: () => Promise.resolve({ score: 9, taskFixableCount: 0, zeroFixableEvidence: true }),
    });
    assert.equal(applies, 0);
    assert.equal(result.attempts, 0);
    assert.equal(result.held?.kind, "partial-scope");
    assert.equal(result.zeroFixableSuccess, false);
  });

  void it("a clean evidence-only baseline over a partial scope runs no Publish Checks and no Apply Review", async () => {
    let applies = 0;
    let gapRuns = 0;
    const result = await improveReviewScore({
      context: fakeContext(),
      stage: "impl-high-review",
      baselineScore: 8,
      maxAttempts: 5,
      preLoopEvidence: { zeroFixableEvidence: true, planIncomplete: true },
      cleanReviewNeverApplies: true,
      partialScopeHold: () => "the latest review was not shown every changed file",
      closeEvidenceGap: () => {
        gapRuns += 1;
        return Promise.resolve({ kind: "closed" });
      },
      apply: () => {
        applies += 1;
        return Promise.resolve();
      },
      review: () => Promise.resolve({ score: 8, taskFixableCount: 0, zeroFixableEvidence: true }),
    });
    assert.equal(gapRuns, 0, "the evidence-gap run waits for the missing files too");
    assert.equal(applies, 0);
    assert.equal(result.held?.kind, "partial-scope");
  });

  void it("a review finished inside the run that turns out partial ends as a hold, not as a success", async () => {
    for (const scenario of ["stop level", "improved", "zero fixable"] as const) {
      let reviewed = false;
      const result = await improveReviewScore({
        context: fakeContext(),
        stage: "impl-high-review",
        // "improved" climbs from 5 to 7; the other two start at 9 so the score gain is not what returns.
        baselineScore: scenario === "improved" ? 5 : 9,
        maxAttempts: 5,
        ...(scenario === "stop level" ? { stopAtScore: 8 } : {}),
        ...(scenario === "zero fixable"
          ? { zeroFixableTerminates: true, preLoopEvidence: { zeroFixableEvidence: true, planIncomplete: false } }
          : {}),
        partialScopeHold: () => (reviewed ? "the latest review was not shown every changed file" : undefined),
        apply: () => Promise.resolve(),
        review: () => {
          reviewed = true;
          return Promise.resolve(
            scenario === "improved"
              ? { score: 7, taskFixableCount: 1, zeroFixableEvidence: false }
              : { score: 9, taskFixableCount: 0, zeroFixableEvidence: true },
          );
        },
      });
      assert.equal(result.held?.kind, "partial-scope", scenario);
      assert.equal(result.zeroFixableSuccess, false, scenario);
      assert.equal(result.improved, false, scenario);
      assert.equal(result.attempts, 1, scenario);
    }
  });

  void it("a baseline that meets the stop level still succeeds when nothing is held", async () => {
    const result = await improveReviewScore({
      context: fakeContext(),
      stage: "impl-high-review",
      baselineScore: 9,
      stopAtScore: 8,
      maxAttempts: 3,
      zeroFixableTerminates: true,
      preLoopEvidence: { zeroFixableEvidence: true, planIncomplete: false },
      cleanReviewNeverApplies: true,
      partialScopeHold: () => undefined,
      apply: () => Promise.resolve(),
      review: () => Promise.resolve({ score: 9, taskFixableCount: 0, zeroFixableEvidence: true }),
    });
    assert.equal(result.zeroFixableSuccess, true);
    assert.equal(result.held, undefined);
  });
});

void describe("the review's file list is not capped", () => {
  void it("Add gives every changed file, and the next Apply Review keeps them", () => {
    const tracked = Array.from({ length: 40 }, (_, i) => `src/tracked${i}.ts`);
    const added = updateImplReviewFiles(progressWith(tracked), [...FILES]);
    assert.equal(added.implReviewFiles?.length, 40 + FILES.length);
    for (const file of [...tracked, ...FILES]) {
      assert.ok(added.implReviewFiles?.includes(file), `${file} is in the list`);
    }
    const afterApplyReview = updateImplReviewFiles(added, ["src/edited-by-the-round.ts"]);
    assert.equal(afterApplyReview.implReviewFiles?.length, 40 + FILES.length + 1);
    assert.equal(afterApplyReview.implReviewFiles?.[0], "src/edited-by-the-round.ts");
  });
});

// ---------------------------------------------------------------------------
// The fallback list comes from git
// ---------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

const tmpRoots: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

void describe("readGitBaselineReviewScopeV1 (the fallback when the round history cannot confirm the list)", () => {
  const { workspace } = vscode;
  let originalReadFile: typeof workspace.fs.readFile;

  before(() => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- saved for restoration only
    originalReadFile = workspace.fs.readFile;
  });
  afterEach(() => {
    workspace.fs.readFile = originalReadFile;
  });

  function stubSidecar(content: string | undefined): void {
    workspace.fs.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
      uri.fsPath.endsWith(".impl-baseline-commit") && content !== undefined
        ? Promise.resolve(new TextEncoder().encode(content))
        : Promise.reject(new Error(`ENOENT: ${uri.fsPath}`));
  }

  void it("equals the git diff since the baseline plus untracked files, and leaves out the task records", async () => {
    const repo = mkTmp("ensemble-scope-fallback-");
    fs.mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "a.ts"), "a\n");
    fs.writeFileSync(path.join(repo, "src", "b.ts"), "b\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "baseline");
    const baseline = git(repo, "rev-parse", "HEAD").trim();

    // committed since the baseline, edited but uncommitted, new and untracked, and a task record
    fs.writeFileSync(path.join(repo, "src", "a.ts"), "a changed\n");
    git(repo, "commit", "-qam", "change a");
    fs.writeFileSync(path.join(repo, "src", "b.ts"), "b changed\n");
    fs.writeFileSync(path.join(repo, "src", "c.ts"), "c\n");
    fs.mkdirSync(path.join(repo, ".ensemble", "t"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".ensemble", "t", "task.md"), "task\n");

    stubSidecar(baseline);
    const taskFolder = vscode.Uri.file(path.join(repo, ".ensemble", "t"));
    const result = await readGitBaselineReviewScopeV1(taskFolder, vscode.Uri.file(repo), {
      ledgerFiles: [],
      taskRecordFolders: [".ensemble/t"],
    });
    assert.equal(result.kind, "established");
    if (result.kind !== "established") return;
    const gitList = [
      ...git(repo, "diff", "--name-only", baseline).split("\n"),
      ...git(repo, "ls-files", "--others", "--exclude-standard").split("\n"),
    ]
      .filter((file) => file.length > 0 && !file.startsWith(".ensemble/"))
      .sort();
    assert.deepEqual([...result.files].sort(), gitList);
    assert.deepEqual([...result.files].sort(), ["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  void it("is unavailable, with the reason, when no baseline commit is recorded", async () => {
    const repo = mkTmp("ensemble-scope-fallback-none-");
    git(repo, "init", "-q");
    stubSidecar(undefined);
    const result = await readGitBaselineReviewScopeV1(vscode.Uri.file(path.join(repo, ".ensemble", "t")), vscode.Uri.file(repo), {
      ledgerFiles: [],
    });
    assert.equal(result.kind, "unavailable");
    if (result.kind === "unavailable") {
      assert.match(result.reason, /baseline/);
    }
  });
});
