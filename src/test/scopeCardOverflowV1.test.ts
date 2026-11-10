/**
 * review2 Steps 21-23 and 26: files past the pack's total size limit are read natively by a reviewer that can open
 * files, the scope card says why each file was not shown and recommends only what can change the result, no stored
 * option label carries "(Recommended)", and a scope marker written by the model never decides a gate.
 */
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import { buildPartialScopeDecisionInputV1 } from "../commands/partialScopeDecisionV1";
import { generateImplReviewContextPack } from "../utils/contextPack";
import { computeReviewScopeGapV1, formatMissingFilesSectionV1 } from "../utils/reviewScopeGapV1";
import {
  classifyScopeFilesV1,
  countedV1,
  describeScopeFilesV1,
  hashMissingFilesV1,
  partialScopeFromVariablesV1,
  partialScopeVariablesV1,
  qualifyReviewForPartialScopeV1,
  recommendScopeOptionV1,
  reviewHoldsForPartialScopeV1,
  stripModelScopeNoteV1,
  type PartialReviewScopeV1,
} from "../utils/reviewPartialScopeV1";
import { safeRemoveDir } from "./testFsUtils";

function git(cwd: string, args: string[]): void {
  cp.execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true });
}

function installRealFsBridge(): { restore: () => void } {
  const fsObj = vscode.workspace.fs as unknown as Record<string, unknown>;
  const origReadFile = fsObj.readFile;
  fsObj.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    nodeFs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  return {
    restore: (): void => {
      fsObj.readFile = origReadFile;
    },
  };
}

const REPO_ROOT = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ensemble-overflow-pack-test-"));
git(REPO_ROOT, ["init"]);
git(REPO_ROOT, ["config", "user.email", "test@example.com"]);
git(REPO_ROOT, ["config", "user.name", "Test"]);

after(() => {
  safeRemoveDir(REPO_ROOT);
});

function lines(prefix: string, count: number, changedLine?: number): string {
  return Array.from({ length: count }, (_, i) =>
    i === changedLine ? `${prefix} CHANGED_LINE_MARKER` : `${prefix} line ${i} ........................................`
  ).join("\n");
}

void describe("files past the pack's total size limit (review2 Step 21)", () => {
  void it("a reviewer with file access gets a read-natively entry with changed regions, and none are counted as omitted", async () => {
    const taskFolderUri = vscode.Uri.file(nodePath.join(REPO_ROOT, ".ensemble", "task-overflow"));
    nodeFs.mkdirSync(taskFolderUri.fsPath, { recursive: true });
    nodeFs.mkdirSync(nodePath.join(REPO_ROOT, "src"), { recursive: true });
    for (const name of ["a", "b", "c"]) {
      nodeFs.writeFileSync(nodePath.join(REPO_ROOT, "src", `${name}.ts`), lines(name, 30), "utf8");
    }
    git(REPO_ROOT, ["add", "-A"]);
    git(REPO_ROOT, ["commit", "-m", "base"]);
    nodeFs.writeFileSync(nodePath.join(REPO_ROOT, "src", "b.ts"), lines("b", 30, 7), "utf8");
    nodeFs.writeFileSync(nodePath.join(REPO_ROOT, "src", "c.ts"), lines("c", 30, 12), "utf8");

    const budget = 2500; // one 30-line file (~1.4k chars) fits; the next does not
    const bridge = installRealFsBridge();
    try {
      const files = ["src/a.ts", "src/b.ts", "src/c.ts"];
      const legacy = await generateImplReviewContextPack(
        taskFolderUri,
        vscode.Uri.file(REPO_ROOT),
        files,
        undefined,
        undefined,
        budget
      );
      assert.ok(legacy.omittedRelPaths.length > 0, "fixture: the total size limit must cut at least one file");
      assert.match(legacy.content, /further tracked file\(s\) omitted: total content size limit reached/);

      const natively = await generateImplReviewContextPack(
        taskFolderUri,
        vscode.Uri.file(REPO_ROOT),
        files,
        undefined,
        undefined,
        budget,
        undefined,
        undefined,
        true
      );
      assert.deepEqual(natively.omittedRelPaths, [], "an overflow file is in scope, not omitted");
      assert.doesNotMatch(natively.content, /further tracked file\(s\) omitted/);
      for (const cut of legacy.omittedRelPaths) {
        assert.match(natively.content, new RegExp(`### ${cut.replace(/[.]/g, "\\.")} \\(over the total size limit — read natively\\)`));
        assert.match(natively.content, new RegExp(`${cut.replace(/[.]/g, "\\.")} \\(\\d[\\d,]* bytes\\) did not fit`));
      }
      assert.match(natively.content, /Changed regions: lines \d+-\d+/, "the entry names the file's changed regions");
      assert.doesNotMatch(natively.content, /CHANGED_LINE_MARKER/, "an overflow entry is a direction, never file content");
    } finally {
      bridge.restore();
    }
  });
});

const NOT_IN_LIST = ["src/a.ts", "src/test/a.test.ts"];

function scopeOf(files: string[], sizeLimitFiles: string[] = []): PartialReviewScopeV1 {
  const scope = partialScopeFromVariablesV1(
    partialScopeVariablesV1(files, "Reviewed 7 of 24 changed files (5 of 10 production files)", sizeLimitFiles),
    "impl-high-review"
  );
  assert.ok(scope);
  return scope;
}

function build(scope: PartialReviewScopeV1, readEarlier?: ReadonlySet<string>) {
  return buildPartialScopeDecisionInputV1({
    taskFolderPath: "/ws/.ensemble/t",
    stage: "impl-high-review",
    scope,
    score: 8,
    threshold: 8,
    ...(readEarlier ? { readEarlier } : {}),
  });
}

void describe("the scope card (review2 Steps 22-23)", () => {
  void it("the size-limit file list travels with the scope and splits the files by cause", () => {
    const scope = scopeOf([...NOT_IN_LIST, "src/b.ts"], ["src/b.ts"]);
    assert.deepEqual(scope.sizeLimitFiles, ["src/b.ts"]);
    assert.deepEqual(classifyScopeFilesV1(scope), { notInList: NOT_IN_LIST, sizeLimit: ["src/b.ts"] });
    // A size-limit file that is not among the missing files is ignored.
    assert.equal(scopeOf(NOT_IN_LIST, ["src/zzz.ts"]).sizeLimitFiles, undefined);
  });

  void it("lists each unshown file, production first, with its cause and whether an earlier review read it", () => {
    const scope = scopeOf(["src/test/b.test.ts", "src/a.ts", "src/b.ts"], ["src/b.ts"]);
    const text = describeScopeFilesV1(scope, new Set(["src/a.ts"]));
    const rows = text.split("\n");
    assert.deepEqual(
      rows.map((row) => row.split(" — ")[0]),
      ["src/a.ts", "src/b.ts", "src/test/b.test.ts"],
      "production files first"
    );
    assert.match(rows[0]!, /not in the review list; an earlier review read its current content/);
    assert.match(rows[1]!, /in the list, but this review had no room for it \(size limit\); no earlier review read/);
    assert.doesNotMatch(text, /never part of the review/);
    assert.doesNotMatch(describeScopeFilesV1(scope), /earlier review/, "no coverage record: nothing is claimed");
  });

  void it("uses correct plurals", () => {
    assert.equal(countedV1(1, "file"), "1 file");
    assert.equal(countedV1(3, "missing file"), "3 missing files");
    const input = build(scopeOf(["src/a.ts"]));
    const labels = input.options.map((option) => option.label);
    assert.deepEqual(labels, ["Add the 1 missing file and review again", "Accept the partial scope (1 file not reviewed)", "Not now"]);
    assert.match(input.whyUserNeeded, /1 changed file was not shown/);
    assert.doesNotMatch(input.whyUserNeeded, /never part of the review/);
  });

  void it("no option label contains '(Recommended)': the card adds the marker from the recommendation only", () => {
    for (const scope of [
      scopeOf(NOT_IN_LIST),
      scopeOf(["src/test/a.test.ts"], ["src/test/a.test.ts"]),
      scopeOf(["src/b.ts"], ["src/b.ts"]),
      scopeOf([...NOT_IN_LIST, "src/b.ts"], ["src/b.ts"]),
    ]) {
      for (const option of build(scope).options) {
        assert.ok(!option.label.includes("Recommended"), `label "${option.label}" must not carry the marker`);
      }
    }
  });

  void it("no decision option label in src/ is written with a baked-in '(Recommended)'", () => {
    const root = nodePath.join(__dirname, "..", "..", "src");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of nodeFs.readdirSync(dir, { withFileTypes: true })) {
        const full = nodePath.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "test") walk(full);
        } else if (entry.name.endsWith(".ts") && /label:\s*[`"'][^\n]*\(Recommended\)/.test(nodeFs.readFileSync(full, "utf8"))) {
          offenders.push(nodePath.relative(root, full));
        }
      }
    };
    walk(root);
    assert.deepEqual(offenders, []);
  });

  void it("recommends Add only for files missing from the list, and Add covers only those", () => {
    const input = build(scopeOf([...NOT_IN_LIST, "src/b.ts"], ["src/b.ts"]));
    assert.equal(input.recommendation.kind === "option" ? input.recommendation.optionId : undefined, "addAndRereview");
    const add = input.options.find((option) => option.optionId === "addAndRereview");
    assert.ok(add && add.effect.kind === "command");
    const arg = (add.effect.args?.[0] ?? {}) as { missingFiles?: string[] };
    assert.deepEqual(arg.missingFiles, NOT_IN_LIST, "the cut file is already in the list, so it is not re-added");
    assert.match(add.label, /Add the 2 missing files/);
    assert.match(add.consequence, /1 file cut by the size limit is already in the list/);
  });

  void it("recommends Accept when only test files are cut, and offers no Add that cannot change the result", () => {
    const scope = scopeOf(["src/test/reviewScoreLoop.test.ts"], ["src/test/reviewScoreLoop.test.ts"]);
    const input = build(scope);
    assert.equal(input.recommendation.kind === "option" ? input.recommendation.optionId : undefined, "acceptPartial");
    assert.ok(!input.options.some((option) => option.optionId === "addAndRereview"));
    assert.match(input.whatHappened, /1 file is in the review list, but this review had no room for it \(size limit\)/);
    const accept = input.options.find((option) => option.optionId === "acceptPartial");
    assert.match(accept?.consequence ?? "", /this stage only/);
  });

  void it("recommends a separate pass when a production file is cut (review2 Step 23, built with Part 6)", () => {
    const input = build(scopeOf(["src/b.ts", "src/test/b.test.ts"], ["src/b.ts", "src/test/b.test.ts"]));
    assert.equal(input.recommendation.kind === "option" ? input.recommendation.optionId : undefined, "separatePass");
    assert.match(input.recommendation.reasoning, /production file was cut/);
    assert.ok(!input.options.some((option) => option.optionId === "addAndRereview"), "Add cannot change a cut");
    const separate = input.options.find((option) => option.optionId === "separatePass");
    assert.ok(separate && separate.effect.kind === "command");
    assert.match(separate.label, /Review the 2 cut files in a separate pass/);
    assert.ok(!separate.label.includes("Recommended"));
    const arg = (separate.effect.args?.[0] ?? {}) as { action?: string; missingFiles?: string[] };
    assert.equal(arg.action, "separatePass");
    assert.deepEqual(arg.missingFiles, ["src/b.ts", "src/test/b.test.ts"]);
    const option = recommendScopeOptionV1({ notInList: [], sizeLimit: ["src/x.ts"] });
    assert.equal(option.kind === "option" ? option.optionId : undefined, "separatePass");
  });

  void it("a separate pass is offered for any size-limit cut, and never when nothing was cut", () => {
    const testOnly = build(scopeOf(["src/test/a.test.ts"], ["src/test/a.test.ts"]));
    assert.ok(testOnly.options.some((option) => option.optionId === "separatePass"));
    assert.equal(testOnly.recommendation.kind === "option" ? testOnly.recommendation.optionId : undefined, "acceptPartial");
    const missingOnly = build(scopeOf(["src/a.ts"]));
    assert.ok(!missingOnly.options.some((option) => option.optionId === "separatePass"));
  });
});

void describe("the reviewer's scope sentence (review2 Step 23)", () => {
  void it("states shown, total and not-in-pack production-file counts explicitly", () => {
    const gap = computeReviewScopeGapV1({
      ledgerFiles: ["src/a.ts", "src/b.ts", "src/c.ts", "src/test/a.test.ts"],
      workingTreeFiles: [],
      scopeFiles: ["src/a.ts", "src/test/a.test.ts"],
    });
    const section = formatMissingFilesSectionV1(gap);
    assert.match(section, /You were shown 1 of 3 production files; 2 are not in this pack\./);
  });
});

void describe("a scope marker written by the model never decides a gate (review2 Step 26)", () => {
  const files = ["src/a.ts"];
  const scope = scopeOf(files);
  const hash = hashMissingFilesV1(files);

  void it("a copied marker without a note, plus a matching acceptance, gives the accepted note and nothing holds", () => {
    const modelOutput = "Readiness: 8/10\n\nGood.\n\n<!-- review-scope: partial -->\n";
    assert.equal(reviewHoldsForPartialScopeV1(modelOutput), true, "fixture: the bare marker holds on its own");
    const qualified = qualifyReviewForPartialScopeV1(modelOutput, scope, true);
    assert.match(qualified, /The owner accepted this partial scope\./);
    assert.equal(reviewHoldsForPartialScopeV1(qualified), false);
    assert.equal((qualified.match(/review-scope: partial/g) ?? []).length, 1, "exactly one marker: Ensemble's own");
    assert.ok(hash.length > 0);
  });

  void it("a copied note from an earlier review is replaced, not kept", () => {
    const copied =
      "Readiness: 8/10\n\n> **Review scope:** partial. Reviewed 1 of 9 changed files; 8 changed file(s) were not part of what this review was shown, so its score says nothing about them. The score does not clear the stage until the missing files are added and reviewed, or the owner accepts the gap.\n\n<!-- review-scope: partial -->\n";
    const qualified = qualifyReviewForPartialScopeV1(copied, scope, true);
    assert.match(qualified, /Reviewed 7 of 24 changed files/);
    assert.doesNotMatch(qualified, /Reviewed 1 of 9/);
    assert.equal((qualified.match(/Review scope:/g) ?? []).length, 1);
    assert.equal(reviewHoldsForPartialScopeV1(qualified), false);
  });

  void it("an unaccepted gap still holds, and an acceptance given after the note was written is applied", () => {
    const held = qualifyReviewForPartialScopeV1("Readiness: 8/10\n", scope, false);
    assert.equal(reviewHoldsForPartialScopeV1(held), true);
    const accepted = qualifyReviewForPartialScopeV1(held, scope, true);
    assert.equal(reviewHoldsForPartialScopeV1(accepted), false);
    assert.equal(qualifyReviewForPartialScopeV1(accepted, scope, true), accepted, "idempotent");
  });

  void it("stripping removes a multi-line note and every marker, and leaves the review text", () => {
    const stripped = stripModelScopeNoteV1(
      "Readiness: 7/10\n\nBody.\n\n> **Review scope:** partial. one\n> two\n\n<!-- review-scope: partial -->\n<!-- review-scope: partial -->\n"
    );
    assert.equal(stripped, "Readiness: 7/10\n\nBody.\n");
  });
});
