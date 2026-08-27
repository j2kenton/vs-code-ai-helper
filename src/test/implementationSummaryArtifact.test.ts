/**
 * Regression coverage for the implementation-artifact split.
 *
 * Live failure (2026-08-10, task "1.8"): a completed implementation run wrote
 * its final chat message over `plan-final.md`. The message was not a summary
 * at all — "All Task A code changes are in place; the full unit-test suite is
 * still running in the background … I'll report the final summary once it
 * completes" — a promise about work still in flight. The only guard on that
 * write was non-empty, so it passed.
 *
 * Three consumers read `plan-final.md` as durable state, and one write took
 * out all three:
 *   1. completionLint's plan-item verification parses its `- [ ]` checklist.
 *      With the checklist gone `collectAiVerifiedPlanItems` returns undefined
 *      and NO Plan Item Verification section renders — so the 47-item, 0-done
 *      checklist stopped being reported by the very mechanism built to report
 *      it.
 *   2. publishScopeCheck extracts paths from it.
 *   3. `{{implementation}}` is filled from it, so both implementation
 *      reviewers were handed the status message as the implementation notes.
 *
 * The fix separates the two roles — `plan-final.md` is the plan of record,
 * `impl-summary.md` is a run's summary — and validates the summary against
 * the shape both implementation prompts mandate before it is promoted.
 */
import * as assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  assessImplementationSummarySectionsV1,
  attributeImplementationRoundFilesV1,
  buildSyntheticImplementationSummaryV1,
  buildUnusableImplementationSummaryV1,
  describeImplementationSummaryShapeIssue,
  describeIncompleteImplementationRoundV1,
  getCanonicalImplementationUri,
  getImplementationSummaryUri,
  isUnusableImplementationSummaryV1,
  parseReportedFilesChangedV1,
  readImplementationReviewContent,
} from "../utils/implementationArtifactResolver";
import { verifyPlanItems } from "../utils/completionLint";
import {
  collectCheckedChecklistCountsV1,
  collectChecklistItemKeysV1,
  collectRetroactiveTickClaimsV1,
  countChecklistProgressV1,
  EXCLUDED_CHECKLIST_ITEM_MARKER_V1,
  filterUncheckedPlanItemsV1,
  formatChecklistPercentV1,
  hasContradictoryNoChecklistChangeClaimV1,
  hasImplementationChecklistV1,
  listOutstandingManualVerificationItemsV1,
  listUncheckedChecklistItemTextsV1,
  mergeChecklistProgressV1,
  MergeChecklistProgressResultV1,
  NO_CHECKLIST_CHANGE_MARKER_V1,
  normalizeChecklistItemTextV1,
  parseChecklistItemPriorityV1,
  RETROACTIVE_TICK_MARKER_V1,
  scopeToLatestChecklistV1,
  splitSummaryAtEchoV1,
  truncateChecklistItemTextV1,
} from "../utils/implementationChecklist";
import {
  isPlanIncomplete,
  parseReviewProgress,
  readyToAdvanceStage,
  reconcileProgressWithChecklistV1,
} from "../utils/reviewReadiness";
import {
  IMPLEMENTATION_FILENAME,
  IMPLEMENTATION_SUMMARY_FILENAME,
  LEGACY_IMPLEMENTATION_FILENAME,
} from "../types/taskProgress";

/** The exact final response that caused the live failure. */
const STATUS_MESSAGE_NOT_A_SUMMARY =
  "All Task A code changes are in place; the full unit-test suite (`pnpm run test:unit`) " +
  "is still running in the background — it compiles the test project (which type-checks my " +
  "changes) and runs every suite including the new `publishRollbackRegression.test.ts`. " +
  "I'll report the final summary once it completes.";

/** A response in the shape run-implementation.md / apply-impl-review-code.md mandate. */
const WELL_FORMED_SUMMARY = [
  "## Files Changed",
  "",
  "- `src/views/taskTreeProvider.ts` — current stage now wins over completedStages",
  "",
  "## Verification",
  "",
  "- `pnpm run test:unit` passes",
].join("\n");

/** A plan of record with a divided checklist, as the live task actually had. */
const CHECKLIST_PLAN_OF_RECORD = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "# Implementation Checklist",
  "",
  "## Task A — Publish rollback and task-list ordering",
  "",
  "- [ ] Reproduce the Publish rollback bug before fixing",
  "- [ ] Fix `getStageStatus` so the current-stage comparison wins",
  "- [ ] Fix the `autoFirstActive` expansion",
  "",
  "## Task B — Stage-action dispatch and AI authoring",
  "",
  "- [ ] Guard `normalizeDraftTaskArg` against a partial task object",
  "- [ ] Delete the auto-rename block in `handleDraftOutcomeV1`",
].join("\n");

// ---------------------------------------------------------------------------
// In-memory vscode.workspace.fs, so resolver reads/writes never touch disk.
// ---------------------------------------------------------------------------

function installMemStore(seed: Record<string, string>): {
  store: Map<string, string>;
  restore: () => void;
} {
  const fsApi = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = {
    readFile: fsApi.readFile,
    writeFile: fsApi.writeFile,
    stat: fsApi.stat,
  };
  const store = new Map<string, string>(Object.entries(seed));

  fsApi.readFile = (uri: vscode.Uri): Promise<Uint8Array> => {
    const content = store.get(uri.toString());
    if (content === undefined) {
      return Promise.reject(new Error(`ENOENT: ${uri.toString()}`));
    }
    return Promise.resolve(new TextEncoder().encode(content));
  };
  fsApi.writeFile = (uri: vscode.Uri, data: Uint8Array): Promise<void> => {
    store.set(uri.toString(), new TextDecoder().decode(data));
    return Promise.resolve();
  };
  fsApi.stat = (uri: vscode.Uri): Promise<vscode.FileStat> => {
    const content = store.get(uri.toString());
    if (content === undefined) {
      return Promise.reject(new Error(`ENOENT: ${uri.toString()}`));
    }
    const now = 0;
    return Promise.resolve({
      type: vscode.FileType.File,
      ctime: now,
      mtime: now,
      size: Buffer.byteLength(content, "utf8"),
    });
  };

  return {
    store,
    restore: (): void => {
      fsApi.readFile = orig.readFile;
      fsApi.writeFile = orig.writeFile;
      fsApi.stat = orig.stat;
    },
  };
}

/** Asserts the merge actually ticked something and returns the updated document. */
function mergedContent(result: MergeChecklistProgressResultV1): string {
  assert.equal(result.kind, "merged", `expected a merge, got "${result.kind}"`);
  return (result as { kind: "merged"; content: string }).content;
}

const FOLDER = vscode.Uri.file("/tasks/2026-08-07_task_1");

function seedFor(files: Partial<Record<string, string>>): Record<string, string> {
  const seed: Record<string, string> = {};
  for (const [name, content] of Object.entries(files)) {
    if (content !== undefined) {
      seed[vscode.Uri.joinPath(FOLDER, name).toString()] = content;
    }
  }
  return seed;
}

let active: { restore: () => void } | undefined;
afterEach(() => {
  active?.restore();
  active = undefined;
});

void describe("implementation summary shape gate", () => {
  void it("rejects the status message that shipped as implementation notes", () => {
    const issue = describeImplementationSummaryShapeIssue(STATUS_MESSAGE_NOT_A_SUMMARY);
    assert.ok(issue, "a 'tests are still running' message is not a summary");
    assert.match(issue, /Files Changed/);
    assert.match(issue, /Verification/);
  });

  void it("accepts a response in the shape both implementation prompts mandate", () => {
    assert.equal(describeImplementationSummaryShapeIssue(WELL_FORMED_SUMMARY), undefined);
  });

  void it("names only the section that is actually missing", () => {
    const issue = describeImplementationSummaryShapeIssue(
      "## Files Changed\n\n- `src/a.ts` — did a thing"
    );
    assert.ok(issue);
    assert.match(issue, /Verification/);
    assert.doesNotMatch(issue, /Files Changed/);
  });

  void it("reports an empty response distinctly from a malformed one", () => {
    const issue = describeImplementationSummaryShapeIssue("   \n  ");
    assert.ok(issue);
    assert.match(issue, /no final summary text/);
  });
});

void describe("plan of record survives an implementation run", () => {
  void it("writes the run summary to impl-summary.md, leaving plan-final.md byte-identical", async () => {
    const handles = installMemStore(
      seedFor({ [IMPLEMENTATION_FILENAME]: CHECKLIST_PLAN_OF_RECORD })
    );
    active = handles;

    // The post-run write path targets the summary URI, never the canonical one.
    await vscode.workspace.fs.writeFile(
      getImplementationSummaryUri(FOLDER),
      new TextEncoder().encode(`${WELL_FORMED_SUMMARY}\n`)
    );

    const planOfRecord = handles.store.get(getCanonicalImplementationUri(FOLDER).toString());
    assert.equal(
      planOfRecord,
      CHECKLIST_PLAN_OF_RECORD,
      "a completed run must not rewrite the implementation plan of record"
    );
  });

  void it("keeps plan-item verification able to see the checklist after a run", async () => {
    const handles = installMemStore(
      seedFor({ [IMPLEMENTATION_FILENAME]: CHECKLIST_PLAN_OF_RECORD })
    );
    active = handles;

    await vscode.workspace.fs.writeFile(
      getImplementationSummaryUri(FOLDER),
      new TextEncoder().encode(`${WELL_FORMED_SUMMARY}\n`)
    );

    // collectAiVerifiedPlanItems returns undefined — rendering no Plan Item
    // Verification section at all — as soon as verifyPlanItems finds nothing.
    // That is exactly what the overwrite caused.
    const items = verifyPlanItems(
      handles.store.get(getCanonicalImplementationUri(FOLDER).toString()) ?? ""
    );
    assert.equal(items.length, 5, "every checklist item must still be visible after a run");
    assert.ok(
      items.every((item) => item.status !== "passed"),
      "an unchecked box is never evidence of implementation"
    );

    // And the summary itself carries no checklist to be mistaken for one.
    assert.equal(verifyPlanItems(WELL_FORMED_SUMMARY).length, 0);
  });
});

void describe("{{implementation}} resolution order", () => {
  void it("prefers this run's summary over the plan of record", async () => {
    active = installMemStore(
      seedFor({
        [IMPLEMENTATION_SUMMARY_FILENAME]: WELL_FORMED_SUMMARY,
        [IMPLEMENTATION_FILENAME]: CHECKLIST_PLAN_OF_RECORD,
        [LEGACY_IMPLEMENTATION_FILENAME]: "legacy notes",
      })
    );
    assert.equal(await readImplementationReviewContent(FOLDER), WELL_FORMED_SUMMARY);
  });

  void it("falls back to plan-final.md for tasks implemented before the split", async () => {
    active = installMemStore(seedFor({ [IMPLEMENTATION_FILENAME]: CHECKLIST_PLAN_OF_RECORD }));
    assert.equal(await readImplementationReviewContent(FOLDER), CHECKLIST_PLAN_OF_RECORD);
  });

  void it("still falls back to legacy implementation.md", async () => {
    active = installMemStore(seedFor({ [LEGACY_IMPLEMENTATION_FILENAME]: "legacy notes" }));
    assert.equal(await readImplementationReviewContent(FOLDER), "legacy notes");
  });

  void it("treats a whitespace-only summary as absent and reads through it", async () => {
    active = installMemStore(
      seedFor({
        [IMPLEMENTATION_SUMMARY_FILENAME]: "   \n\n  ",
        [IMPLEMENTATION_FILENAME]: CHECKLIST_PLAN_OF_RECORD,
      })
    );
    assert.equal(await readImplementationReviewContent(FOLDER), CHECKLIST_PLAN_OF_RECORD);
  });

  void it("returns undefined when the task has no implementation artifact at all", async () => {
    active = installMemStore({});
    assert.equal(await readImplementationReviewContent(FOLDER), undefined);
  });
});

void describe("checklist progress carries forward into the plan of record", () => {
  /** A round that finished the first two items and reproduced the checklist. */
  const SUMMARY_WITH_PROGRESS = [
    "<!-- ensemble:implementation-checklist -->",
    "",
    "- [x] Reproduce the Publish rollback bug before fixing",
    "- [x] Fix `getStageStatus` so the current-stage comparison wins",
    "- [ ] Fix the `autoFirstActive` expansion",
    "- [ ] Guard `normalizeDraftTaskArg` against a partial task object",
    "- [ ] Delete the auto-rename block in `handleDraftOutcomeV1`",
    "",
    WELL_FORMED_SUMMARY,
  ].join("\n");

  void it("ticks exactly the items the round reported done", () => {
    const merged = mergedContent(mergeChecklistProgressV1(CHECKLIST_PLAN_OF_RECORD, SUMMARY_WITH_PROGRESS));

    const items = verifyPlanItems(merged);
    assert.equal(items.length, 5);
    // Plan Item Verification never upgrades a box to "passed" on its own, so
    // assert the raw checkbox state the next round will actually read.
    assert.ok(merged.includes("- [x] Reproduce the Publish rollback bug before fixing"));
    assert.ok(merged.includes("- [x] Fix `getStageStatus` so the current-stage comparison wins"));
    assert.ok(merged.includes("- [ ] Fix the `autoFirstActive` expansion"));
    assert.ok(merged.includes("- [ ] Delete the auto-rename block in `handleDraftOutcomeV1`"));
  });

  void it("never un-ticks an item an earlier round already earned", () => {
    const alreadyDone = CHECKLIST_PLAN_OF_RECORD.replace(
      "- [ ] Fix the `autoFirstActive` expansion",
      "- [x] Fix the `autoFirstActive` expansion"
    );
    // This round's reproduction sloppily resets that box back to unchecked.
    const merged = mergedContent(mergeChecklistProgressV1(alreadyDone, SUMMARY_WITH_PROGRESS));
    assert.ok(
      merged.includes("- [x] Fix the `autoFirstActive` expansion"),
      "a sloppy reproduction must not erase progress an earlier round earned"
    );
  });

  void it("matches by item text, not position", () => {
    const reordered = [
      "<!-- ensemble:implementation-checklist -->",
      "- [x] Delete the auto-rename block in `handleDraftOutcomeV1`",
      "- [x] Reproduce the Publish rollback bug before fixing",
    ].join("\n");
    const merged = mergedContent(mergeChecklistProgressV1(CHECKLIST_PLAN_OF_RECORD, reordered));
    assert.ok(merged.includes("- [x] Delete the auto-rename block in `handleDraftOutcomeV1`"));
    assert.ok(merged.includes("- [x] Reproduce the Publish rollback bug before fixing"));
    assert.ok(merged.includes("- [ ] Fix the `autoFirstActive` expansion"));
  });

  void it("leaves the document untouched when the round reported no completions", () => {
    assert.equal(
      mergeChecklistProgressV1(CHECKLIST_PLAN_OF_RECORD, WELL_FORMED_SUMMARY).kind,
      "no-report",
      "a summary with no reproduced checklist must not rewrite the plan of record"
    );
  });

  void it("preserves CRLF line endings and surrounding prose byte-for-byte", () => {
    const crlf = CHECKLIST_PLAN_OF_RECORD.split("\n").join("\r\n");
    const merged = mergedContent(mergeChecklistProgressV1(crlf, SUMMARY_WITH_PROGRESS));
    assert.ok(merged.includes("\r\n"), "line endings must survive the merge");
    assert.doesNotMatch(merged, /[^\r]\n/, "no CRLF may be downgraded to LF");
    assert.ok(merged.includes("## Task B — Stage-action dispatch and AI authoring"));
    assert.equal(
      merged.split("\r\n").length,
      crlf.split("\r\n").length,
      "the merge must not add or drop lines"
    );
  });

  void it("tells the next round what remains — the record the clobber destroyed", () => {
    const merged = mergedContent(mergeChecklistProgressV1(CHECKLIST_PLAN_OF_RECORD, SUMMARY_WITH_PROGRESS));
    const remaining = merged
      .split(/\r?\n/)
      .filter((line) => /^\s*[-*]\s*\[ \]/.test(line));
    assert.equal(remaining.length, 3, "three items remain, and the plan still says so");
  });
});

void describe("a narrowed denominator cannot declare the plan finished", () => {
  void it("counts the plan of record's checklist, deduped", () => {
    const counted = countChecklistProgressV1(CHECKLIST_PLAN_OF_RECORD);
    assert.deepEqual(counted, {
      total: 5,
      checked: 0,
      closedWithoutDoing: 0,
      settled: 0,
      remaining: 5,
      excluded: 0,
    });
  });

  void it("reports no checklist for a document that has none", () => {
    assert.equal(countChecklistProgressV1(WELL_FORMED_SUMMARY), undefined);
  });

  void it("overrides the exact 5/5-vs-47 marker that shipped a quarter-built plan", () => {
    // The live failure: the reviewer counted only its self-declared slice.
    const reported = { complete: 5, total: 5 };
    assert.equal(isPlanIncomplete(reported), false, "as reported, this reads as finished");

    const reconciled = reconcileProgressWithChecklistV1(reported, {
      total: 47,
      settled: 6,
      remaining: 41,
    });
    assert.deepEqual(reconciled, { complete: 6, total: 47 });
    assert.equal(isPlanIncomplete(reconciled), true, "the plan is not finished and now says so");
    assert.equal(
      readyToAdvanceStage(10, 8, reconciled),
      false,
      "even a perfect score must not advance a plan with items outstanding"
    );
  });

  void it("lets a review still report itself mid-plan even when every box is ticked", () => {
    // Asymmetric on purpose: either source may say "not finished";
    // neither may unilaterally say "finished".
    const reconciled = reconcileProgressWithChecklistV1(
      { complete: 13, total: 25 },
      { total: 25, settled: 25, remaining: 0 }
    );
    assert.deepEqual(reconciled, { complete: 13, total: 25 });
    assert.equal(isPlanIncomplete(reconciled), true);
  });

  void it("advances normally once both the checklist and the review agree", () => {
    const reconciled = reconcileProgressWithChecklistV1(
      { complete: 25, total: 25 },
      { total: 25, settled: 25, remaining: 0 }
    );
    assert.equal(isPlanIncomplete(reconciled), false);
    assert.equal(readyToAdvanceStage(9, 8, reconciled), true);
  });

  void it("a rolled-back task's leftover checklist must not gate a PLAN review", () => {
    // Rolling a task back from implementation to a plan review leaves its
    // half-finished plan-final.md in place. A plan review emits no progress
    // marker of its own, so reconciling there would inject the
    // implementation's outstanding count, block auto-advance, and drive Fast
    // Forward into no-progress escalation — when returning to implementation
    // is exactly what would tick those items off. The call sites skip
    // reconciliation for plan-review stages; this pins what it would do.
    const leftover = { total: 47, settled: 6, remaining: 41 };
    assert.equal(isPlanIncomplete(reconcileProgressWithChecklistV1(null, leftover)), true);
    assert.equal(
      isPlanIncomplete(parseReviewProgress("Readiness: 9/10")),
      false,
      "unreconciled, a plan review with no marker does not read as incomplete"
    );
  });

  void it("leaves a task with no checklist exactly as it behaved before", () => {
    const reported = { complete: 8, total: 8 };
    assert.equal(reconcileProgressWithChecklistV1(reported, undefined), reported);
    assert.equal(reconcileProgressWithChecklistV1(null, undefined), null);
  });

  void it("still blocks when a checklist exists but the review emitted no marker", () => {
    const reconciled = reconcileProgressWithChecklistV1(null, {
      total: 47,
      settled: 6,
      remaining: 41,
    });
    assert.deepEqual(reconciled, { complete: 6, total: 47 });
    assert.equal(isPlanIncomplete(reconciled), true);
  });
});

// wf "make the stage chat a record of work", Part 5 / item 6: floor the
// percentage, and never render 100% short of every item actually being
// settled — 84 of 85 must read as 98%, never 99% (which reads as finished)
// or 100% (which would make the checklist a liar).
void describe("formatChecklistPercentV1 — floors, and 100% means every item is settled", () => {
  void it("floors 84 of 85 to 98%, never rounding up to 99% or 100%", () => {
    assert.equal(formatChecklistPercentV1(84, 85), 98);
  });

  void it("renders exactly 100% once settled reaches total", () => {
    assert.equal(formatChecklistPercentV1(85, 85), 100);
  });

  void it("renders 0% for a fresh/empty checklist", () => {
    assert.equal(formatChecklistPercentV1(0, 85), 0);
  });

  void it("never renders 100% for a total of 0 (no checklist to be 'done')", () => {
    assert.equal(formatChecklistPercentV1(0, 0), 0);
  });

  void it("clamps just under 100% to 99%, never 100%, when work remains", () => {
    // 999999 of 1000000 floors to 99.9999...% — must still read as 99%, not
    // 100%, however close settled gets without actually reaching total.
    assert.equal(formatChecklistPercentV1(999999, 1000000), 99);
  });
});

void describe("the shape gate matches real headings, not mentions of them", () => {
  void it("rejects prose that merely names the required sections", () => {
    const issue = describeImplementationSummaryShapeIssue(
      "I could not produce ## Files Changed or ## Verification yet — still working."
    );
    assert.ok(issue, "naming a heading in a sentence is not writing that section");
    assert.match(issue, /Files Changed/);
    assert.match(issue, /Verification/);
  });

  void it("rejects headings quoted inside a fenced code block", () => {
    const issue = describeImplementationSummaryShapeIssue(
      ["Here is the template I was asked for:", "", "```md", "## Files Changed", "## Verification", "```"].join("\n")
    );
    assert.ok(issue, "a quoted example is not this response's own section");
  });

  void it("does not let an unterminated fence hide the rest of the response", () => {
    const issue = describeImplementationSummaryShapeIssue(
      ["```", "## Files Changed", "## Verification"].join("\n")
    );
    assert.ok(issue, "everything after an unclosed fence stays inside it");
  });

  void it("closes a fence indented by up to three spaces", () => {
    // A legally indented fence whose close is not recognized swallows the rest
    // of the response, stripping the real headings after it and stamping a
    // perfectly usable round unusable.
    assert.equal(
      describeImplementationSummaryShapeIssue(
        ["  ```ts", "  const x = 1;", "  ```", "", WELL_FORMED_SUMMARY].join("\n")
      ),
      undefined
    );
  });

  void it("still rejects headings quoted inside an indented fence", () => {
    assert.ok(
      describeImplementationSummaryShapeIssue(
        ["  ```md", "  ## Files Changed", "  ## Verification", "  ```"].join("\n")
      )
    );
  });

  void it("accepts real headings that follow a fenced block", () => {
    assert.equal(
      describeImplementationSummaryShapeIssue(
        ["```ts", "const x = 1;", "```", "", WELL_FORMED_SUMMARY].join("\n")
      ),
      undefined
    );
  });

  void it("counts content nested under a child heading as section content", () => {
    // A section ends at the next SAME-OR-HIGHER level heading. Treating every
    // heading as a boundary meant a grouped summary scanned zero lines and was
    // stamped unusable while carrying exactly the required detail.
    const grouped = [
      "## Files Changed",
      "",
      "### Source",
      "",
      "- `src/a.ts` — did a thing",
      "",
      "### Tests",
      "",
      "- `src/a.test.ts` — covered it",
      "",
      "## Verification",
      "",
      "### Automated",
      "",
      "- `pnpm run test:unit` passes",
    ].join("\n");
    assert.equal(
      describeImplementationSummaryShapeIssue(grouped, { roundChangedFiles: true }),
      undefined
    );
  });

  void it("still rejects a section whose only child heading is also empty", () => {
    const hollow = ["## Files Changed", "", "### Source", "", "## Verification", "", "- ok"].join("\n");
    assert.ok(describeImplementationSummaryShapeIssue(hollow, { roundChangedFiles: true }));
  });

  void it("accepts closed ATX headings", () => {
    // `## Files Changed ##` is valid Markdown; rejecting it stamped a
    // contract-satisfying round unusable over heading style alone.
    assert.equal(
      describeImplementationSummaryShapeIssue(
        ["## Files Changed ##", "", "- `src/a.ts` — did a thing", "", "## Verification ##", "", "- tests pass"].join("\n")
      ),
      undefined
    );
  });

  void it("accepts Setext headings", () => {
    // The point of parsing structure instead of enumerating forms: a valid
    // heading style nobody anticipated is parsed, not rejected.
    assert.equal(
      describeImplementationSummaryShapeIssue(
        ["Files Changed", "=============", "", "- `src/a.ts` — did a thing", "", "Verification", "------------", "", "- tests pass"].join("\n")
      ),
      undefined
    );
  });

  void it("does not read a list item above a thematic break as a heading", () => {
    const issue = describeImplementationSummaryShapeIssue(
      ["- Files Changed", "---", "", "- Verification", "---"].join("\n")
    );
    assert.ok(issue, "list items are not Setext headings");
  });

  void it("treats a title ending in a hash as a title, not a closed heading", () => {
    assert.equal(
      describeImplementationSummaryShapeIssue(
        ["## Files Changed", "", "- ported to C#", "", "## Verification", "", "- tests pass"].join("\n")
      ),
      undefined
    );
  });

  void it("accepts indented and deeper-level headings", () => {
    assert.equal(
      describeImplementationSummaryShapeIssue("### Files Changed\n\n- a\n\n  #### Verification\n\n- b"),
      undefined
    );
  });
});

void describe("headings without a summary under them are not a summary", () => {
  /** Right shape, nothing in it — the motivating failure wearing headings. */
  const HOLLOW = [
    "## Files Changed",
    "",
    "## Verification",
    "",
    "- will confirm once the suite finishes",
  ].join("\n");

  void it("rejects an empty Files Changed when the round edited the tree", () => {
    const issue = describeImplementationSummaryShapeIssue(HOLLOW, {
      roundChangedFiles: true,
    });
    assert.ok(issue, "a round that changed files must say which");
    assert.match(issue, /changed files/);
  });

  void it("accepts the same response when the round changed nothing", () => {
    // A zero-change round reporting no files is honest, not evasive.
    assert.equal(
      describeImplementationSummaryShapeIssue(HOLLOW, { roundChangedFiles: false }),
      undefined
    );
  });

  void it("does not reject compliant summaries for talking about pending work", () => {
    // run-implementation.md REQUIRES a staged round to say what it did not
    // reach, so any keyword blacklist would reject the summaries the staged
    // delivery design depends on. This must stay accepted.
    const staged = [
      "## Files Changed",
      "",
      "- `src/a.ts` — implemented part 1",
      "",
      "## Plan Item Checklist",
      "",
      "- part 1 — done — src/a.ts:12",
      "- part 2 — not reached — not yet reached in the executable order",
      "- part 3 — not reached — still outstanding, will be built next round",
      "",
      "## Verification",
      "",
      "- `pnpm run test:unit` passes",
    ].join("\n");
    assert.equal(
      describeImplementationSummaryShapeIssue(staged, { roundChangedFiles: true }),
      undefined
    );
  });

  void it("still rejects the original status message under the new gate", () => {
    assert.ok(
      describeImplementationSummaryShapeIssue(STATUS_MESSAGE_NOT_A_SUMMARY, {
        roundChangedFiles: true,
      })
    );
  });
});

void describe("a plan with a checklist requires the round to echo it", () => {
  void it("rejects a summary that drops the checklist when the plan has one", () => {
    const issue = describeImplementationSummaryShapeIssue(WELL_FORMED_SUMMARY, {
      planChecklist: CHECKLIST_PLAN_OF_RECORD,
    });
    assert.ok(issue, "without the echo, plan progress can never advance");
    assert.match(issue, /checklist/);
  });

  void it("accepts the same summary when the plan carries no checklist", () => {
    assert.equal(describeImplementationSummaryShapeIssue(WELL_FORMED_SUMMARY, {}), undefined);
  });

  void it("is not satisfied by the checkboxes in a `## Verification` section", () => {
    // The prompts specify `## Verification` as "a short checklist", so a
    // compliant summary routinely has checkboxes that are NOT the plan echo.
    // Accepting any checkbox line let that pass the gate while the merge
    // matched nothing and progress silently stayed at zero.
    const verificationOnly = [
      "## Files Changed",
      "",
      "- `src/a.ts` — did a thing",
      "",
      "## Verification",
      "",
      "- [x] `pnpm run test:unit` passes",
      "- [ ] manual smoke test",
    ].join("\n");
    const issue = describeImplementationSummaryShapeIssue(verificationOnly, {
      planChecklist: CHECKLIST_PLAN_OF_RECORD,
    });
    assert.ok(issue, "verification checkboxes are not the plan's checklist");
    assert.match(issue, /checklist/);
    // Proves the gate and the merge now agree: neither finds anything.
    assert.equal(mergeChecklistProgressV1(CHECKLIST_PLAN_OF_RECORD, verificationOnly).kind, "no-report");
  });

  void it("accepts a `no-checklist-change` marker in place of the echo", () => {
    // A round that fixed a review blocker without ticking any plan step (a
    // defect fix, not an unbuilt step) legitimately has nothing to echo.
    const noChange = [
      "<!-- ensemble:no-checklist-change -->",
      "No checkbox state changed this round: the fix addressed a defect the review raised, not an unbuilt plan step.",
      "",
      WELL_FORMED_SUMMARY,
    ].join("\n");
    assert.equal(
      describeImplementationSummaryShapeIssue(noChange, {
        planChecklist: CHECKLIST_PLAN_OF_RECORD,
      }),
      undefined
    );
    // And the merge correctly ticks nothing — there is no echo to match.
    assert.equal(mergeChecklistProgressV1(CHECKLIST_PLAN_OF_RECORD, noChange).kind, "no-report");
  });

  void it("rejects a response truncated after Files Changed, echo notwithstanding", () => {
    // create-implementation.md makes a generated checklist END with a
    // "Verification" section, so the required echo drags that heading into
    // every response. A presence-only check was then satisfied by the PLAN's
    // Verification even when the summary itself stopped after Files Changed.
    const truncated = [
      "<!-- ensemble:implementation-checklist -->",
      "- [x] Reproduce the Publish rollback bug before fixing",
      "- [ ] Fix the `autoFirstActive` expansion",
      "",
      "## Verification",
      "",
      "- Run the full test suite after each part lands",
      "",
      "## Files Changed",
      "",
      "- `src/a.ts` — did a thing",
    ].join("\n");
    const issue = describeImplementationSummaryShapeIssue(truncated, {
      planChecklist: CHECKLIST_PLAN_OF_RECORD,
    });
    assert.ok(issue, "the echoed checklist's Verification is not the summary's");
    assert.match(issue, /Verification/);
  });

  void it("accepts the same response once its own Verification follows", () => {
    const complete = [
      "<!-- ensemble:implementation-checklist -->",
      "- [x] Reproduce the Publish rollback bug before fixing",
      "- [ ] Fix the `autoFirstActive` expansion",
      "",
      "## Verification",
      "",
      "- Run the full test suite after each part lands",
      "",
      "## Files Changed",
      "",
      "- `src/a.ts` — did a thing",
      "",
      "## Verification",
      "",
      "- `pnpm run test:unit` passes",
    ].join("\n");
    assert.equal(
      describeImplementationSummaryShapeIssue(complete, {
        planChecklist: CHECKLIST_PLAN_OF_RECORD,
      }),
      undefined
    );
  });

  void it("rejects a response truncated right after its own Verification heading", () => {
    const truncated = [
      "## Files Changed",
      "",
      "- `src/a.ts` — did a thing",
      "",
      "## Verification",
    ].join("\n");
    const issue = describeImplementationSummaryShapeIssue(truncated, {
      roundChangedFiles: true,
    });
    assert.ok(issue, "a heading with nothing under it is not a verification section");
    assert.match(issue, /Verification/);
  });

  void it("does not impose section order when no echo is expected", () => {
    // Without a checklist there is one Verification heading and nothing to
    // confuse it with, so ordering must not become a new false rejection.
    assert.equal(
      describeImplementationSummaryShapeIssue(
        ["## Verification", "", "- tests pass", "", "## Files Changed", "", "- `src/a.ts` — x"].join("\n")
      ),
      undefined
    );
  });

  void it("accepts a summary that echoes real plan items", () => {
    const echoed = [
      "<!-- ensemble:implementation-checklist -->",
      "- [x] Reproduce the Publish rollback bug before fixing",
      "- [ ] Fix the `autoFirstActive` expansion",
      "",
      WELL_FORMED_SUMMARY,
    ].join("\n");
    assert.equal(
      describeImplementationSummaryShapeIssue(echoed, { planChecklist: CHECKLIST_PLAN_OF_RECORD }),
      undefined
    );
  });

  void it("accepts an echo that reproduces the list without the marker comment", () => {
    // The merge matches by item text, so a dropped HTML comment still records
    // progress correctly — rejecting it would stall a round that did nothing
    // wrong. Overlap, not the marker, is the condition that matters.
    const echoed = [
      "- [x] Reproduce the Publish rollback bug before fixing",
      "",
      WELL_FORMED_SUMMARY,
    ].join("\n");
    assert.equal(
      describeImplementationSummaryShapeIssue(echoed, { planChecklist: CHECKLIST_PLAN_OF_RECORD }),
      undefined
    );
    assert.equal(mergeChecklistProgressV1(CHECKLIST_PLAN_OF_RECORD, echoed).kind, "merged");
  });

  void it("rejects a response that is only the echoed plan", () => {
    // A checklist may itself contain a phase named `## Files Changed`, and
    // ends with its own `## Verification`. Judging the whole response let a
    // reply consisting of nothing but the echo satisfy every heading lookup —
    // the no-summary case this gate exists to reject.
    const planWithFilesChangedPhase = [
      "<!-- ensemble:implementation-checklist -->",
      "",
      "## Files Changed",
      "- [ ] Record every touched path",
      "",
      "## Verification",
      "",
      "- Run the suite",
    ].join("\n");
    const echoOnly = planWithFilesChangedPhase.replace("- [ ]", "- [x]");
    const issue = describeImplementationSummaryShapeIssue(echoOnly, {
      planChecklist: planWithFilesChangedPhase,
      roundChangedFiles: true,
    });
    assert.ok(issue, "an echo is not a summary, whatever headings the plan uses");
  });

  void it("finds the checklist marker even behind an attribution header", () => {
    // The live plan-final.md opens with `<!-- Generated by ... -->`, so a
    // "starts with the marker" test is always false for a real generated
    // checklist — the reason a compliant provider could skip the echo.
    const attributed = `<!-- Generated by Claude Code (fable@high) -->\n\n${CHECKLIST_PLAN_OF_RECORD}`;
    assert.ok(attributed.includes("<!-- ensemble:implementation-checklist -->"));
    assert.equal(attributed.startsWith("<!-- ensemble:implementation-checklist -->"), false);
    assert.deepEqual(countChecklistProgressV1(attributed), {
      total: 5,
      checked: 0,
      closedWithoutDoing: 0,
      settled: 0,
      remaining: 5,
      excluded: 0,
    });
  });
});

void describe("a rejected round is refused by every review entry point", () => {
  void it("stamps a summary that later reviews recognize as unusable", () => {
    const stamp = buildUnusableImplementationSummaryV1(
      "the final response is missing `## Verification`",
      "007-claude-cli-impl.md"
    );
    assert.equal(isUnusableImplementationSummaryV1(stamp), true);
    assert.match(stamp, /007-claude-cli-impl\.md/);
    assert.match(stamp, /missing `## Verification`/);
    assert.match(stamp, /Its edits were kept and recorded for review/);
  });

  void it("does not claim edits were kept when the round changed no files", () => {
    // ensemble.resilience.nothingToFixRoutesToReview can route a genuinely
    // zero-change round onward even when its summary is rejected — the
    // stamp must not then falsely claim files were changed and kept.
    const stamp = buildUnusableImplementationSummaryV1(
      "the final response is missing `## Verification`",
      "007-claude-cli-impl.md",
      false
    );
    assert.equal(isUnusableImplementationSummaryV1(stamp), true);
    assert.match(stamp, /completed without changing any files/);
    assert.match(stamp, /This round changed no files, so there is nothing new recorded for review/);
    assert.doesNotMatch(stamp, /Its edits were kept/);
  });

  void it("does not mistake a real summary or a plan for a rejected round", () => {
    assert.equal(isUnusableImplementationSummaryV1(WELL_FORMED_SUMMARY), false);
    assert.equal(isUnusableImplementationSummaryV1(CHECKLIST_PLAN_OF_RECORD), false);
  });

  void it("does not reject a valid summary that merely mentions the sentinel", () => {
    // The round that ADDED the stamp names it in its own Files Changed. A
    // substring test rejected that summary — blocking review on exactly the
    // work that implemented the feature.
    const summaryAboutTheStamp = [
      "## Files Changed",
      "",
      "- `src/utils/implementationArtifactResolver.ts` — added the",
      "  `<!-- ensemble:implementation-summary-unusable -->` stamp",
      "",
      "## Verification",
      "",
      "- `pnpm run test:unit` passes",
    ].join("\n");
    assert.equal(describeImplementationSummaryShapeIssue(summaryAboutTheStamp), undefined);
    assert.equal(
      isUnusableImplementationSummaryV1(summaryAboutTheStamp),
      false,
      "a summary that passed validation must not then be refused by every reviewer"
    );
  });

  void it("still recognizes the stamp when attribution precedes nothing", () => {
    const stamp = buildUnusableImplementationSummaryV1("reason", "log.md");
    assert.equal(isUnusableImplementationSummaryV1(`\n\n${stamp}`), true);
  });

  void it("surfaces the stamp ahead of the plan of record, so reviews see the rejection", async () => {
    const stamp = buildUnusableImplementationSummaryV1("the provider returned no final summary text", "log.md");
    active = installMemStore(
      seedFor({
        [IMPLEMENTATION_SUMMARY_FILENAME]: stamp,
        [IMPLEMENTATION_FILENAME]: CHECKLIST_PLAN_OF_RECORD,
      })
    );
    const resolved = await readImplementationReviewContent(FOLDER);
    assert.ok(resolved);
    assert.equal(
      isUnusableImplementationSummaryV1(resolved),
      true,
      "the fallback must not read past the stamp and serve the plan as notes"
    );
  });
});

void describe("checklist item identity", () => {
  const DUPLICATE_WORDING = [
    "<!-- ensemble:implementation-checklist -->",
    "",
    "## Part 1",
    "- [ ] Add a regression test",
    "- [ ] Wire the gate",
    "",
    "## Part 2",
    "- [ ] Add a regression test",
  ].join("\n");

  void it("counts two same-worded items as two, not one", () => {
    assert.deepEqual(countChecklistProgressV1(DUPLICATE_WORDING), {
      total: 3,
      checked: 0,
      closedWithoutDoing: 0,
      settled: 0,
      remaining: 3,
      excluded: 0,
    });
  });

  void it("ticking one same-worded item does not tick the other", () => {
    const echo = [
      "<!-- ensemble:implementation-checklist -->",
      "- [x] Add a regression test",
      "- [ ] Wire the gate",
      "- [ ] Add a regression test",
    ].join("\n");
    const merged = mergedContent(mergeChecklistProgressV1(DUPLICATE_WORDING, echo));
    const lines = merged.split("\n").filter((l) => l.includes("Add a regression test"));
    assert.deepEqual(lines, ["- [x] Add a regression test", "- [ ] Add a regression test"]);
    // The unfinished second copy still holds the denominator open.
    assert.deepEqual(countChecklistProgressV1(merged), {
      total: 3,
      checked: 1,
      closedWithoutDoing: 0,
      settled: 1,
      remaining: 2,
      excluded: 0,
    });
  });

  void it("still collapses a whole checklist reproduced a second time", () => {
    // The observed live case: a response reproduces "that entire checklist
    // marker and list verbatim", so the document carries two renderings.
    // Counting both would double the denominator and stall the task.
    const reproduced = `${CHECKLIST_PLAN_OF_RECORD}\n\n## Implementation Notes\n\n${CHECKLIST_PLAN_OF_RECORD}`;
    assert.deepEqual(countChecklistProgressV1(reproduced), {
      total: 5,
      checked: 0,
      closedWithoutDoing: 0,
      settled: 0,
      remaining: 5,
      excluded: 0,
    });
    assert.equal(verifyPlanItems(reproduced).length, 5, "one rendering, not two");
  });

  void it("reads the freshest rendering when an older copy is stale", () => {
    const stale = CHECKLIST_PLAN_OF_RECORD;
    const fresh = CHECKLIST_PLAN_OF_RECORD.replace(/- \[ \]/g, "- [x]");
    assert.deepEqual(countChecklistProgressV1(`${stale}\n\n${fresh}`), {
      total: 5,
      checked: 5,
      closedWithoutDoing: 0,
      settled: 5,
      remaining: 0,
      excluded: 0,
    });
  });

  void it("treats a quoted marker inside an item as prose, not a new rendering", () => {
    // This repo's own plans quote the marker when the work is about this
    // mechanism. A raw substring scan took the quote as the start of a fresh
    // rendering and silently dropped every item above it.
    const quoting = [
      "<!-- ensemble:implementation-checklist -->",
      "",
      "- [ ] Fix the gate",
      "- [ ] Recognize `<!-- ensemble:implementation-checklist -->` after attribution",
      "- [ ] Add a regression test",
    ].join("\n");
    assert.deepEqual(countChecklistProgressV1(quoting), {
      total: 3,
      checked: 0,
      closedWithoutDoing: 0,
      settled: 0,
      remaining: 3,
      excluded: 0,
    });
    assert.equal(verifyPlanItems(quoting).length, 3);
  });

  void it("still counts the checklist when the LAST item quotes the marker", () => {
    // The worst shape: the quote is in the final item, so scanning to it left
    // nothing behind — which reads as "no checklist" and disables the gate.
    const quoting = [
      "<!-- ensemble:implementation-checklist -->",
      "",
      "- [ ] Fix the gate",
      "- [ ] Emit `<!-- ensemble:implementation-checklist -->` in the header",
    ].join("\n");
    const counted = countChecklistProgressV1(quoting);
    assert.ok(counted, "a quoted marker must not make the checklist vanish");
    assert.deepEqual(counted, {
      total: 2,
      checked: 0,
      closedWithoutDoing: 0,
      settled: 0,
      remaining: 2,
      excluded: 0,
    });
  });

  void it("ignores a marker shown inside a fenced example", () => {
    // A plan documenting this mechanism shows the marker in a code block. If
    // that example is taken as the newest rendering, every real item above it
    // disappears from the count — and the completeness gate with them.
    const documenting = [
      "<!-- ensemble:implementation-checklist -->",
      "",
      "- [ ] Fix the gate",
      "- [ ] Add a regression test",
      "",
      "The plan of record opens like this:",
      "",
      "```md",
      "<!-- ensemble:implementation-checklist -->",
      "- [x] some unrelated example item",
      "```",
    ].join("\n");
    assert.deepEqual(countChecklistProgressV1(documenting), {
      total: 2,
      checked: 0,
      closedWithoutDoing: 0,
      settled: 0,
      remaining: 2,
      excluded: 0,
    });
  });

  void it("ignores a trailing marker that begins no checklist", () => {
    const trailing = [
      "<!-- ensemble:implementation-checklist -->",
      "",
      "- [ ] Fix the gate",
      "",
      "## Notes",
      "",
      "<!-- ensemble:implementation-checklist -->",
    ].join("\n");
    assert.deepEqual(countChecklistProgressV1(trailing), {
      total: 1,
      checked: 0,
      closedWithoutDoing: 0,
      settled: 0,
      remaining: 1,
      excluded: 0,
    });
  });

  void it("ticks the right NUMBER of duplicates when the echo reorders them", () => {
    // Occurrence-position identity was unstable exactly here: "the 2nd copy"
    // means different items on each side once the echo reorders. Counting is
    // order-independent, and the remaining count is what the gate reads.
    const plan = [
      "<!-- ensemble:implementation-checklist -->",
      "- [ ] Update foo.ts",
      "- [ ] Wire the gate",
      "- [ ] Update foo.ts",
    ].join("\n");
    const reorderedEcho = [
      "<!-- ensemble:implementation-checklist -->",
      "- [ ] Update foo.ts",
      "- [x] Wire the gate",
      "- [x] Update foo.ts",
    ].join("\n");
    const merged = mergedContent(mergeChecklistProgressV1(plan, reorderedEcho));
    assert.deepEqual(countChecklistProgressV1(merged), {
      total: 3,
      checked: 2,
      closedWithoutDoing: 0,
      settled: 2,
      remaining: 1,
      excluded: 0,
    });
    assert.equal(
      merged.split("\n").filter((l) => l === "- [ ] Update foo.ts").length,
      1,
      "exactly one copy stays open, so the next round still has work to find"
    );
  });

  void it("does not re-tick when the echo reports what the plan already records", () => {
    const plan = [
      "<!-- ensemble:implementation-checklist -->",
      "- [x] Update foo.ts",
      "- [ ] Update foo.ts",
    ].join("\n");
    const echo = ["<!-- ensemble:implementation-checklist -->", "- [x] Update foo.ts"].join("\n");
    assert.equal(
      mergeChecklistProgressV1(plan, echo).kind,
      "unchanged",
      "one reported tick against one already recorded is no new progress"
    );
  });

  void it("does not count a legacy summary's own verification boxes as plan work", () => {
    // A pre-split plan-final.md IS a run response — the summary used to be
    // written over the plan. Counting from its marker to EOF swept in the
    // response's own `## Verification` checklist, so one unchecked
    // verification line could hold `remaining > 0` and block review or publish
    // on a plan whose every real item was done.
    const legacy = [
      "<!-- ensemble:implementation-checklist -->",
      "- [x] Fix the gate",
      "- [x] Add a regression test",
      "",
      "## Files Changed",
      "",
      "- `src/a.ts` — did a thing",
      "",
      "## Verification",
      "",
      "- [x] `pnpm run test:unit` passes",
      "- [ ] manual smoke test on Windows",
    ].join("\n");
    assert.deepEqual(
      countChecklistProgressV1(legacy),
      { total: 2, checked: 2, closedWithoutDoing: 0, settled: 2, remaining: 0, excluded: 0 },
      "every real plan item is done, so the plan is complete"
    );
  });

  void it("counts items under a plan's own `## Files Changed` AREA heading", () => {
    // create-implementation.md groups items "under headings by area or phase",
    // so a plan may legitimately use this name. Treating it as the run-summary
    // boundary dropped every item from there on — reporting an unfinished plan
    // as complete, which is the exact failure this gate exists to prevent.
    const planWithAreaHeading = [
      "<!-- ensemble:implementation-checklist -->",
      "",
      "## Setup",
      "- [x] Wire the gate",
      "",
      "## Files Changed",
      "- [ ] Record every touched path in the summary",
      "- [ ] Add a regression test",
    ].join("\n");
    assert.deepEqual(countChecklistProgressV1(planWithAreaHeading), {
      total: 3,
      checked: 1,
      closedWithoutDoing: 0,
      settled: 1,
      remaining: 2,
      excluded: 0,
    });
  });

  void it("keeps the echoed plan's own Verification prose out of the run region", () => {
    // create-implementation.md makes a generated checklist END with a
    // Verification section, so prose sits AFTER the echo's last checkbox —
    // which is why the PR overview takes the last prose block rather than
    // everything following the final checkbox.
    const response = [
      "<!-- ensemble:implementation-checklist -->",
      "- [x] Fix the gate",
      "",
      "## Verification",
      "",
      "Run the full suite after each part lands.",
      "",
      "Implemented the gate and split the artifacts.",
      "",
      "## Files Changed",
      "",
      "- `src/a.ts` — did a thing",
    ].join("\n");
    const { echo } = splitSummaryAtEchoV1(response);
    assert.ok(echo.includes("Run the full suite after each part lands."));
    assert.ok(echo.includes("Implemented the gate and split the artifacts."));
    // The run's overview is the LAST prose block, not the first one after the
    // final checkbox — which would have been the plan's verification text.
    const blocks = echo.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
    const prose = blocks.filter((b) =>
      b.split(/\r?\n/).every((l) => !/^\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>)/.test(l))
    );
    assert.equal(prose.at(-1), "Implemented the gate and split the artifacts.");
  });

  void it("does not rewrite an older rendering when merging", () => {
    const doc = `${CHECKLIST_PLAN_OF_RECORD}\n\n## Progress\n\n${CHECKLIST_PLAN_OF_RECORD}`;
    const echo = [
      "<!-- ensemble:implementation-checklist -->",
      "- [x] Fix the `autoFirstActive` expansion",
    ].join("\n");
    const merged = mergedContent(mergeChecklistProgressV1(doc, echo));
    const ticked = merged.split("\n").filter((l) => l === "- [x] Fix the `autoFirstActive` expansion");
    assert.equal(ticked.length, 1, "only the latest rendering is updated");
  });
});

void describe("the echoed checklist is separated from the summary's own sections", () => {
  const PLAN_WITH_DUPES = [
    "<!-- ensemble:implementation-checklist -->",
    "- [ ] Run the full test suite",
    "- [ ] Wire the gate",
    "- [ ] Run the full test suite",
  ].join("\n");

  void it("verification checkboxes do not add to the echo's reported progress", () => {
    // `## Verification` is specified as "a short checklist", so its boxes are
    // expected. Counting them alongside the echo ticked MORE copies of a
    // duplicated item than the round actually reported done.
    const response = [
      "<!-- ensemble:implementation-checklist -->",
      "- [x] Run the full test suite",
      "- [ ] Wire the gate",
      "- [ ] Run the full test suite",
      "",
      "## Files Changed",
      "",
      "- `src/a.ts` — did a thing",
      "",
      "## Verification",
      "",
      "- [x] Run the full test suite",
    ].join("\n");
    const merged = mergedContent(mergeChecklistProgressV1(PLAN_WITH_DUPES, response));
    assert.deepEqual(
      countChecklistProgressV1(merged),
      { total: 3, checked: 1, closedWithoutDoing: 0, settled: 1, remaining: 2, excluded: 0 },
      "one reported tick means one tick, whatever the verification list says"
    );
  });

  void it("a verification box alone cannot satisfy the echo requirement", () => {
    const noEcho = [
      "## Files Changed",
      "",
      "- `src/a.ts` — did a thing",
      "",
      "## Verification",
      "",
      "- [x] Run the full test suite",
    ].join("\n");
    const issue = describeImplementationSummaryShapeIssue(noEcho, {
      planChecklist: PLAN_WITH_DUPES,
    });
    assert.ok(issue, "a matching verification box is not the plan echo");
    assert.match(issue, /checklist/);
  });

  void it("splits a response into the echo and the run's own sections", () => {
    const response = [
      "<!-- ensemble:implementation-checklist -->",
      "- [x] Wire the gate",
      "",
      "## Verification",
      "",
      "- planned: run the suite after each part lands",
      "",
      "## Files Changed",
      "",
      "- `src/a.ts` — did a thing",
      "",
      "## Verification",
      "",
      "- actually ran `pnpm run test:unit`",
    ].join("\n");
    const { echo, own } = splitSummaryAtEchoV1(response);
    assert.ok(echo.includes("planned: run the suite"), "the plan's copy stays in the echo");
    assert.ok(!echo.includes("actually ran"));
    assert.ok(own.startsWith("## Files Changed"));
    assert.ok(own.includes("actually ran `pnpm run test:unit`"));
    assert.ok(!own.includes("planned: run the suite"), "the run's region excludes the echo");
  });

  void it("treats a response with no Files Changed as all echo", () => {
    const { echo, own } = splitSummaryAtEchoV1("- [x] Wire the gate");
    assert.equal(echo, "- [x] Wire the gate");
    assert.equal(own, "");
  });
});

void describe("a runner-synthesized summary is not held to the prompt contract", () => {
  /** What runEditActionV1's sealed pipeline reports on success. */
  const SEALED = "Applied 3 sealed edit step(s) with ordered receipts (2 file(s) changed).";

  void it("would fail the shape gate if it were held to it", () => {
    // Pins WHY the flag exists: without it every successful Copilot sealed run
    // was stamped unusable and refused to advance.
    assert.ok(
      describeImplementationSummaryShapeIssue(SEALED, { roundChangedFiles: true }),
      "the sealed summary has no prompt-shaped sections, by construction"
    );
  });

  void it("records itself as runner-authored, and reports only what the runner knows", () => {
    const wrapped = buildSyntheticImplementationSummaryV1(SEALED, [
      "src/a.ts",
      "src/b.ts",
    ]);
    assert.ok(
      wrapped.includes("<!-- ensemble:implementation-summary-synthetic -->"),
      "the artifact is self-identifying for diagnosis, though nothing gates on it"
    );
    assert.ok(wrapped.includes("- `src/a.ts`"), "the paths its receipts touched are real data");
    assert.ok(wrapped.includes("- `src/b.ts`"));
    // It must not dress itself up as a model-authored summary.
    assert.equal(
      verifyPlanItems(wrapped).length,
      0,
      "a runner summary ticks nothing — it has no checklist to echo"
    );
    assert.ok(
      /checkbox state is NOT up to date/i.test(wrapped),
      "the reviewer is told the plan counts are stale, not remaining"
    );
  });

  void it("the rejection stamp is still recognized once the artifact is signed", () => {
    // Every persisted summary goes through withAttribution, which prepends
    // `<!-- Generated by ... -->`. A first-non-empty-line test therefore
    // stopped recognizing the marker the moment the artifact was written —
    // the same attribution-ordering trap the checklist marker hit.
    const signedStamp = `<!-- Generated by Claude Code (opus@high) -->\n\n${buildUnusableImplementationSummaryV1("reason", "log.md")}`;
    assert.equal(isUnusableImplementationSummaryV1(signedStamp), true);
  });

  void it("does not match a stamp mentioned in the body", () => {
    const mentions = [
      "## Files Changed",
      "",
      "- added the `<!-- ensemble:implementation-summary-unusable -->` stamp",
      "",
      "## Verification",
      "",
      "- tests pass",
    ].join("\n");
    assert.equal(isUnusableImplementationSummaryV1(mentions), false);
  });

  void it("is not mistaken for a rejected round", () => {
    const wrapped = buildSyntheticImplementationSummaryV1(SEALED, ["src/a.ts"]);
    assert.equal(isUnusableImplementationSummaryV1(wrapped), false);
  });

  void it("the run's own PR overview survives the echo split", () => {
    // The required one-or-two sentence overview sits BETWEEN the echo and
    // `## Files Changed`, so taking only the run-owned region dropped it and
    // left the PR reporting the first file-list bullet as the summary.
    const response = [
      "<!-- ensemble:implementation-checklist -->",
      "- [x] Wire the gate",
      "",
      "Implemented the summary shape gate and split the artifacts.",
      "",
      "## Files Changed",
      "",
      "- `src/a.ts` — did a thing",
      "",
      "## Verification",
      "",
      "- ran the suite",
    ].join("\n");
    const { echo, own } = splitSummaryAtEchoV1(response);
    const overview = echo
      .split(/\r?\n/)
      .filter((l) => !/^\s*[-*]\s*\[[ xX]\]/.test(l) && !l.includes("ensemble:implementation-checklist"))
      .join("\n")
      .trim();
    assert.equal(overview, "Implemented the summary shape gate and split the artifacts.");
    assert.ok(own.includes("- ran the suite"), "verification still comes from the run's region");
    assert.ok(!own.includes("Implemented the summary shape gate"));
  });
});

void describe("a quoted marker is not a generated checklist", () => {
  /** A plan that documents this mechanism and has ordinary checkboxes. */
  const QUOTES_MARKER = [
    "# Notes on the checklist mechanism",
    "",
    "The plan of record opens with `<!-- ensemble:implementation-checklist -->`.",
    "",
    "- [ ] Investigate the marker handling",
    "- [ ] Write it up",
  ].join("\n");

  void it("does not classify it as a checklist", () => {
    // `prefix !== content` was true for ANY non-empty document with no marker
    // found, so these unrelated boxes became the completeness denominator, the
    // echo requirement fired against them, and real checklist generation was
    // suppressed.
    assert.equal(hasImplementationChecklistV1(QUOTES_MARKER), false);
    assert.equal(scopeToLatestChecklistV1(QUOTES_MARKER).found, false);
  });

  void it("still recognizes a real generated checklist", () => {
    assert.equal(hasImplementationChecklistV1(CHECKLIST_PLAN_OF_RECORD), true);
    assert.equal(scopeToLatestChecklistV1(CHECKLIST_PLAN_OF_RECORD).found, true);
  });

  void it("does not classify a marker with no items following it", () => {
    assert.equal(
      hasImplementationChecklistV1("<!-- ensemble:implementation-checklist -->\n\nNothing yet."),
      false
    );
  });
});

void describe("an echoed plan is never mistaken for a run summary", () => {
  /** A plan whose own phase is named `## Files Changed`. */
  const PLAN_WITH_PHASE = [
    "<!-- ensemble:implementation-checklist -->",
    "",
    "- [ ] Wire the gate",
    "",
    "## Files Changed",
    "",
    "- [ ] Record every touched path",
    "",
    "## Verification",
    "",
    "- Run the suite after each part lands",
  ].join("\n");

  void it("does not split an echo-only response at the plan's own heading", () => {
    // Splitting on the heading NAME let the gate read the plan's Files Changed
    // and Verification as the run's, so a response containing no summary at all
    // was promoted for review.
    const echoOnly = PLAN_WITH_PHASE.replace("- [ ] Wire the gate", "- [x] Wire the gate");
    const { own } = splitSummaryAtEchoV1(echoOnly);
    assert.equal(own, "", "a plan phase is not a summary boundary");

    const issue = describeImplementationSummaryShapeIssue(echoOnly, {
      planChecklist: PLAN_WITH_PHASE,
      roundChangedFiles: true,
    });
    assert.ok(issue, "an echo with no summary must be rejected");
  });

  void it("still splits a real summary whose Files Changed lists files", () => {
    const real = [
      "<!-- ensemble:implementation-checklist -->",
      "- [x] Fix the `autoFirstActive` expansion",
      "",
      "## Files Changed",
      "",
      "- `src/a.ts` — did a thing",
      "",
      "## Verification",
      "",
      "- tests pass",
    ].join("\n");
    const { own } = splitSummaryAtEchoV1(real);
    assert.ok(own.startsWith("## Files Changed"));
    assert.equal(
      describeImplementationSummaryShapeIssue(real, {
        planChecklist: CHECKLIST_PLAN_OF_RECORD,
        roundChangedFiles: true,
      }),
      undefined
    );
  });
});

void describe("artifact identity", () => {
  void it("keeps the summary and the plan of record on separate filenames", () => {
    assert.notEqual(IMPLEMENTATION_SUMMARY_FILENAME, IMPLEMENTATION_FILENAME);
    assert.notEqual(
      getImplementationSummaryUri(FOLDER).toString(),
      getCanonicalImplementationUri(FOLDER).toString()
    );
  });
});

void describe("the rejection message names the real cause", () => {
  // `filesChangedIsSummaryBoundary` refuses a `## Files Changed` whose entries
  // are checkboxes, because a plan legitimately uses that name as an area
  // heading and splitting on the name alone promoted echo-only responses. The
  // cost lands on a run that checkbox-formats its OWN file list: the split
  // finds no run-owned region, and the generic message then claims two
  // sections are missing while both are visibly on screen. That reads as a
  // broken gate rather than a fixable response, so the message says which
  // shape actually tripped it.
  const withCheckboxFileList = [
    CHECKLIST_PLAN_OF_RECORD,
    "",
    "## Files Changed",
    "",
    "- [x] `src/utils/implementationChecklist.ts` — added the merge",
    "- [x] `src/commands/reviewActions.ts` — routed the write",
    "",
    "## Verification",
    "",
    "- `pnpm run test:unit` passes",
  ].join("\n");

  void it("explains a checkbox-formatted file list instead of reporting it missing", () => {
    const issue = describeImplementationSummaryShapeIssue(withCheckboxFileList, {
      planChecklist: CHECKLIST_PLAN_OF_RECORD,
      roundChangedFiles: true,
    });
    assert.ok(issue, "the response still has no distinguishable run-owned region");
    assert.match(issue, /entries are checkboxes/);
    assert.match(issue, /plain bullets/);
    assert.doesNotMatch(
      issue,
      /is missing/,
      "must not claim the sections are absent when they are plainly present"
    );
  });

  void it("still reports genuinely absent sections as missing", () => {
    // The specific message must not swallow the real no-summary case: an
    // echo with nothing of its own has no `## Files Changed` at all.
    const echoOnly = CHECKLIST_PLAN_OF_RECORD;
    const issue = describeImplementationSummaryShapeIssue(echoOnly, {
      planChecklist: CHECKLIST_PLAN_OF_RECORD,
      roundChangedFiles: true,
    });
    assert.ok(issue);
    assert.match(issue, /is missing/);
    assert.doesNotMatch(issue, /checkboxes/);
  });
});

void describe("checklist item identity survives escaped-quote corruption", () => {
  // A round-trip through a JSON-encoded field (the checklist echo travels
  // inside the strict-JSON result frame, and plan-final.md was itself
  // generated the same way) can leave a provider's over-escaped quotes on
  // disk as literal backslash-quote sequences rather than plain quotes.
  void it("unescapes backslash-escaped quotes before folding case/whitespace", () => {
    assert.equal(
      normalizeChecklistItemTextV1(`Fix the \\"foo\\" bug`),
      normalizeChecklistItemTextV1(`Fix the "foo" bug`)
    );
  });

  void it("unescapes backslash-escaped apostrophes", () => {
    assert.equal(
      normalizeChecklistItemTextV1(`Guard against a partial task object\\'s state`),
      normalizeChecklistItemTextV1(`Guard against a partial task object's state`)
    );
  });

  void it("collapses doubled backslashes to a single backslash", () => {
    assert.equal(
      normalizeChecklistItemTextV1(`Update C:\\\\Users\\\\task`),
      normalizeChecklistItemTextV1(`Update C:\\Users\\task`)
    );
  });

  // workflow 8, item 2's jester probe: the only two items (of eight) that
  // never ticked in a real fixture were the only two containing a
  // backslash-escaped backtick — a plan item quoting an identifier in
  // markdown, the single most common way a backtick reaches a checklist line.
  void it("unescapes backslash-escaped backticks", () => {
    assert.equal(
      normalizeChecklistItemTextV1("Rename the \\`exportedName\\` export"),
      normalizeChecklistItemTextV1("Rename the `exportedName` export")
    );
  });

  void it("an echo with clean backticks still ticks a plan line carrying escaped backticks", () => {
    const plan = [
      "<!-- ensemble:implementation-checklist -->",
      "",
      "- [ ] Rename the \\`exportedName\\` export",
      "- [ ] Wire the gate",
    ].join("\n");
    const echo = [
      "<!-- ensemble:implementation-checklist -->",
      "- [x] Rename the `exportedName` export",
    ].join("\n");
    const merged = mergedContent(mergeChecklistProgressV1(plan, echo));
    assert.ok(
      merged.includes("- [x] Rename the \\`exportedName\\` export"),
      "the plan's original (corrupted) spelling is ticked, byte-preserving except the box"
    );
    assert.deepEqual(countChecklistProgressV1(merged), {
      total: 2,
      checked: 1,
      closedWithoutDoing: 0,
      settled: 1,
      remaining: 1,
      excluded: 0,
    });
  });

  void it("an echo with clean quotes still ticks a plan line carrying escaped quotes", () => {
    const plan = [
      "<!-- ensemble:implementation-checklist -->",
      "",
      `- [ ] Fix the \\"getStageStatus\\" comparison`,
      "- [ ] Wire the gate",
    ].join("\n");
    const echo = [
      "<!-- ensemble:implementation-checklist -->",
      `- [x] Fix the "getStageStatus" comparison`,
    ].join("\n");
    const merged = mergedContent(mergeChecklistProgressV1(plan, echo));
    assert.ok(
      merged.includes(`- [x] Fix the \\"getStageStatus\\" comparison`),
      "the plan's original (corrupted) spelling is ticked, byte-preserving except the box"
    );
    assert.deepEqual(countChecklistProgressV1(merged), {
      total: 2,
      checked: 1,
      closedWithoutDoing: 0,
      settled: 1,
      remaining: 1,
      excluded: 0,
    });
  });

  void it("a plan with clean quotes still ticks against an echo carrying escaped quotes", () => {
    const plan = [
      "<!-- ensemble:implementation-checklist -->",
      "",
      `- [ ] Fix the "getStageStatus" comparison`,
      "- [ ] Wire the gate",
    ].join("\n");
    const echo = [
      "<!-- ensemble:implementation-checklist -->",
      `- [x] Fix the \\"getStageStatus\\" comparison`,
    ].join("\n");
    const merged = mergedContent(mergeChecklistProgressV1(plan, echo));
    assert.ok(merged.includes(`- [x] Fix the "getStageStatus" comparison`));
  });
});

void describe("mergeChecklistProgressV1 distinguishes no-op from no-match", () => {
  const PLAN = [
    "<!-- ensemble:implementation-checklist -->",
    "",
    "- [ ] Reproduce the Publish rollback bug before fixing",
    "- [ ] Wire the gate",
  ].join("\n");

  void it("reports \"no-report\" when the round echoed no ticked items at all", () => {
    const result = mergeChecklistProgressV1(PLAN, WELL_FORMED_SUMMARY);
    assert.deepEqual(result, { kind: "no-report" });
  });

  void it("reports \"unchanged\" when every reported tick is already recorded", () => {
    const alreadyDone = PLAN.replace(
      "- [ ] Reproduce the Publish rollback bug before fixing",
      "- [x] Reproduce the Publish rollback bug before fixing"
    );
    const echo = [
      "<!-- ensemble:implementation-checklist -->",
      "- [x] Reproduce the Publish rollback bug before fixing",
    ].join("\n");
    const result = mergeChecklistProgressV1(alreadyDone, echo);
    assert.deepEqual(result, { kind: "unchanged" });
  });

  void it("reports \"no-match\" — distinct from a no-op — when a reported tick names nothing in the plan", () => {
    const echo = [
      "<!-- ensemble:implementation-checklist -->",
      "- [x] Refactor the completely unrelated billing module",
    ].join("\n");
    const result = mergeChecklistProgressV1(PLAN, echo);
    assert.equal(result.kind, "no-match");
    if (result.kind === "no-match") {
      assert.deepEqual(result.unmatchedSample, ["Refactor the completely unrelated billing module"]);
    }
  });

  void it("samples up to two unmatched items when several reported ticks miss", () => {
    const echo = [
      "<!-- ensemble:implementation-checklist -->",
      "- [x] Totally foreign item one",
      "- [x] Totally foreign item two",
      "- [x] Totally foreign item three",
    ].join("\n");
    const result = mergeChecklistProgressV1(PLAN, echo);
    assert.equal(result.kind, "no-match");
    if (result.kind === "no-match") {
      assert.equal(result.unmatchedSample.length, 2);
    }
  });
});

void describe("the completeness gate exempts steps the stage cannot perform", () => {
  const PLAN_WITH_EXCLUDED_STEP = [
    "<!-- ensemble:implementation-checklist -->",
    "",
    "- [ ] Fix `getStageStatus` so the current-stage comparison wins",
    `- [ ] Deploy the classifier change to the production cluster ${EXCLUDED_CHECKLIST_ITEM_MARKER_V1}`,
    "- [ ] Add a regression test",
  ].join("\n");

  void it("an excluded item stays in the FIXED total, but settles as closedWithoutDoing rather than checked", () => {
    // wf "make the stage chat a record of work", Part 5 / item 4: the
    // denominator never shrinks. The excluded item is still one of the
    // plan's 3 items; it is simply settled without having been checked.
    assert.deepEqual(countChecklistProgressV1(PLAN_WITH_EXCLUDED_STEP), {
      total: 3,
      checked: 0,
      closedWithoutDoing: 1,
      settled: 1,
      remaining: 2,
      excluded: 1,
    });
  });

  void it("still ticks a checked excluded item without moving it into `checked` — it settles as closedWithoutDoing either way", () => {
    const ticked = PLAN_WITH_EXCLUDED_STEP.replace(
      `- [ ] Deploy the classifier change to the production cluster ${EXCLUDED_CHECKLIST_ITEM_MARKER_V1}`,
      `- [x] Deploy the classifier change to the production cluster ${EXCLUDED_CHECKLIST_ITEM_MARKER_V1}`
    );
    assert.deepEqual(countChecklistProgressV1(ticked), {
      total: 3,
      checked: 0,
      closedWithoutDoing: 1,
      settled: 1,
      remaining: 2,
      excluded: 1,
    });
  });

  void it("a plan whose only items are all excluded is still a real checklist, not \"no checklist\"", () => {
    const allExcluded = [
      "<!-- ensemble:implementation-checklist -->",
      "",
      `- [ ] Rotate the API key ${EXCLUDED_CHECKLIST_ITEM_MARKER_V1}`,
    ].join("\n");
    assert.equal(hasImplementationChecklistV1(allExcluded), true);
    // The fixed denominator makes this the clean case it always should have
    // been: 1 item, fully settled (closed without doing), 0 remaining —
    // rather than the old total: 0 that made a real (if out-of-scope)
    // checklist look denominator-less.
    assert.deepEqual(countChecklistProgressV1(allExcluded), {
      total: 1,
      checked: 0,
      closedWithoutDoing: 1,
      settled: 1,
      remaining: 0,
      excluded: 1,
    });
  });

  void it("an excluded item is still a real checklist item for merge/echo purposes", () => {
    const echo = [
      "<!-- ensemble:implementation-checklist -->",
      `- [x] Deploy the classifier change to the production cluster ${EXCLUDED_CHECKLIST_ITEM_MARKER_V1}`,
    ].join("\n");
    const merged = mergedContent(mergeChecklistProgressV1(PLAN_WITH_EXCLUDED_STEP, echo));
    assert.ok(
      merged.includes(
        `- [x] Deploy the classifier change to the production cluster ${EXCLUDED_CHECKLIST_ITEM_MARKER_V1}`
      ),
      "an excluded item must still be tickable — it is out of `checked`, not out of the plan or its total"
    );
    // Ticking it must not have moved it from closedWithoutDoing into checked.
    assert.deepEqual(countChecklistProgressV1(merged), {
      total: 3,
      checked: 0,
      closedWithoutDoing: 1,
      settled: 1,
      remaining: 2,
      excluded: 1,
    });
  });

  void it("an unmarked plan is completely unaffected — additive only", () => {
    assert.deepEqual(countChecklistProgressV1(CHECKLIST_PLAN_OF_RECORD), {
      total: 5,
      checked: 0,
      closedWithoutDoing: 0,
      settled: 0,
      remaining: 5,
      excluded: 0,
    });
  });
});

void describe("a round can record work completed in an earlier round", () => {
  const PLAN = [
    "<!-- ensemble:implementation-checklist -->",
    "",
    "- [ ] Add the `databaseWaking` state to the dashboard API",
    "- [ ] Wire the SPA to retry on that state",
  ].join("\n");

  const RESPONSE_WITH_VALID_CLAIM = [
    "## Files Changed",
    "",
    "- `src/api.ts` — no change this round; investigated only",
    "",
    "## Plan Item Checklist",
    "",
    `- Add the \`databaseWaking\` state to the dashboard API — done ${RETROACTIVE_TICK_MARKER_V1} — app.ts:194 returns databaseWaking: true, covered by app.test.ts:616`,
    "- Wire the SPA to retry on that state — not reached — deferred to a later round",
  ].join("\n");

  void it("parses a retroactive claim from the summary's own Plan Item Checklist section", () => {
    const own = splitSummaryAtEchoV1(RESPONSE_WITH_VALID_CLAIM).own;
    const claims = collectRetroactiveTickClaimsV1(own);
    assert.deepEqual(claims, [
      {
        itemText: "Add the `databaseWaking` state to the dashboard API",
        evidence: "app.ts:194 returns databaseWaking: true, covered by app.test.ts:616",
      },
    ]);
  });

  void it("merges a plan line that is unticked on disk but claimed retroactively with evidence", () => {
    const result = mergeChecklistProgressV1(PLAN, RESPONSE_WITH_VALID_CLAIM);
    assert.equal(result.kind, "merged");
    if (result.kind === "merged") {
      assert.ok(
        result.content.includes("- [x] Add the `databaseWaking` state to the dashboard API"),
        "the retroactively-claimed item must be ticked"
      );
      assert.ok(
        result.content.includes("- [ ] Wire the SPA to retry on that state"),
        "an item not claimed must stay unticked"
      );
      assert.deepEqual(result.retroactiveTicks, [
        {
          itemText: "Add the `databaseWaking` state to the dashboard API",
          evidence: "app.ts:194 returns databaseWaking: true, covered by app.test.ts:616",
        },
      ]);
    }
  });

  void it("does not merge a retroactive claim with no evidence, and surfaces it like an unmatched tick", () => {
    const noEvidence = [
      "## Files Changed",
      "",
      "- (none)",
      "",
      "## Plan Item Checklist",
      "",
      `- Add the \`databaseWaking\` state to the dashboard API — done ${RETROACTIVE_TICK_MARKER_V1}`,
    ].join("\n");
    const result = mergeChecklistProgressV1(PLAN, noEvidence);
    assert.equal(result.kind, "no-match");
    if (result.kind === "no-match") {
      assert.deepEqual(result.unmatchedSample, [
        "Add the `databaseWaking` state to the dashboard API",
      ]);
    }
  });

  void it("a done entry WITHOUT the retroactive marker is now accepted as a claim (Part 4: models emit this form unprompted)", () => {
    // The explicit marker is still the RECOMMENDED form, but two separate
    // live tasks (round 073's part-level claim, and the jester task's
    // rounds) produced this exact bare-prose shape with no marker at all —
    // and it carries real evidence, so refusing it is what created the
    // "finished work, unticked checklist" deadlock this plan part exists to
    // close.
    const ordinaryDone = [
      "## Files Changed",
      "",
      "- (none)",
      "",
      "## Plan Item Checklist",
      "",
      "- Add the `databaseWaking` state to the dashboard API — done — built and tested this round",
    ].join("\n");
    const own = splitSummaryAtEchoV1(ordinaryDone).own;
    assert.deepEqual(collectRetroactiveTickClaimsV1(own), [
      {
        itemText: "Add the `databaseWaking` state to the dashboard API",
        evidence: "built and tested this round",
      },
    ]);
    const result = mergeChecklistProgressV1(PLAN, ordinaryDone);
    assert.equal(result.kind, "merged");
    if (result.kind === "merged") {
      assert.ok(result.content.includes("- [x] Add the `databaseWaking` state to the dashboard API"));
      assert.ok(result.content.includes("- [ ] Wire the SPA to retry on that state"));
    }
  });

  void it("an echo tick and a retroactive claim in the same response both apply", () => {
    const both = [
      "<!-- ensemble:implementation-checklist -->",
      "",
      "- [x] Add the `databaseWaking` state to the dashboard API",
      "- [ ] Wire the SPA to retry on that state",
      "",
      "## Files Changed",
      "",
      "- `src/api.ts` — retry wiring",
      "",
      "## Plan Item Checklist",
      "",
      "- Add the `databaseWaking` state to the dashboard API — done — built this round",
      `- Wire the SPA to retry on that state — done ${RETROACTIVE_TICK_MARKER_V1} — components.tsx:115 already wired`,
    ].join("\n");
    const merged = mergedContent(mergeChecklistProgressV1(PLAN, both));
    assert.ok(merged.includes("- [x] Add the `databaseWaking` state to the dashboard API"));
    assert.ok(merged.includes("- [x] Wire the SPA to retry on that state"));
  });
});

// ---------------------------------------------------------------------------
// Part 4 (workflow 3 continuation, second item's extra requirement /
// seventh item req 1): a round must be able to assert checklist completion
// without a matching file diff, in the forms models actually emit — plan
// items whose own text contains " — ", bare prose with no retroactive
// marker, and PART-level claims ("Part 7 — done this round (6/6),
// evidence: ...", the exact shape observed live on round 073 of "workflow
// 3"). Claim collection stays scoped to the round summary's own
// `## Plan Item Checklist` section throughout — widening the accepted
// grammar must not widen WHERE it is read from.
// ---------------------------------------------------------------------------
void describe("Part 4: asserted completions land without a file diff", () => {
  const PLAN_WITH_DASH_ITEM = [
    "<!-- ensemble:implementation-checklist -->",
    "",
    "- [ ] In the webview <style>, set .model-combo-input to font-size: var(--ensemble-small-font-size) — and reduce its vertical padding so the combo-box input height shrinks with the text.",
    "- [ ] a second, unrelated item",
  ].join("\n");

  void it("a plan item whose own text contains ' — ' can still be claimed retroactively (the previously documented known-gap)", () => {
    const claimWithDashItem = [
      "## Files Changed",
      "",
      "- (none)",
      "",
      "## Plan Item Checklist",
      "",
      `- In the webview <style>, set .model-combo-input to font-size: var(--ensemble-small-font-size) — and reduce its vertical padding so the combo-box input height shrinks with the text. — done ${RETROACTIVE_TICK_MARKER_V1} — src/views/settingsView.ts:672-675`,
    ].join("\n");
    const own = splitSummaryAtEchoV1(claimWithDashItem).own;
    const planItemKeys = collectChecklistItemKeysV1(PLAN_WITH_DASH_ITEM);
    assert.deepEqual(collectRetroactiveTickClaimsV1(own, planItemKeys), [
      {
        itemText:
          "In the webview <style>, set .model-combo-input to font-size: var(--ensemble-small-font-size) — and reduce its vertical padding so the combo-box input height shrinks with the text.",
        evidence: "src/views/settingsView.ts:672-675",
      },
    ]);
    const result = mergeChecklistProgressV1(PLAN_WITH_DASH_ITEM, claimWithDashItem);
    assert.equal(result.kind, "merged");
    if (result.kind === "merged") {
      assert.ok(
        result.content.includes(
          "- [x] In the webview <style>, set .model-combo-input to font-size: var(--ensemble-small-font-size) — and reduce its vertical padding so the combo-box input height shrinks with the text."
        )
      );
      assert.ok(result.content.includes("- [ ] a second, unrelated item"));
    }
  });

  const PLAN_WITH_PART_7 = [
    "<!-- ensemble:implementation-checklist -->",
    "",
    "## Part 6 — Some earlier part",
    "",
    "- [ ] an item that belongs to Part 6, not Part 7",
    "",
    "## Part 7 — Copilot desc/impl and the auto default",
    "",
    "- [ ] Reproduce Draft with AI on Copilot",
    "- [ ] Commit the captured or reconstructed response shape as a test fixture",
    "- [ ] Compare draft.v1 vs generatePlan.v1 request construction",
    "- [ ] Harden the draft prompt or record the cause as provider-side",
    "- [ ] Reorder getAvailableCopilotModels to list concrete models first",
    "- [ ] Add a decode unit test for the desc fixture",
    "",
    "## Part 8 — End-to-end self-recovery proof",
    "",
    "- [ ] an item that belongs to Part 8, not Part 7",
  ].join("\n");

  /** Verbatim shape from round 073 of "workflow 3" (`.ensemble/2026-08-13_task_4`). */
  const ROUND_073_RESPONSE = [
    "## Files Changed",
    "",
    "- (none) — this round only verified prior work",
    "",
    "## Plan Item Checklist",
    "",
    "- Part 7 — done this round (6/6), evidence: `src/runners/cliAgentRunner.ts` (watchdog + " +
      "`composeCliTimeoutOutcomeV1`), `src/commands/reviewActions.ts:5599-5651`, " +
      "`src/test/cliRetryEvidence.test.ts:297-420`",
  ].join("\n");

  void it("a PART-level prose claim ticks every item under that Part heading and none outside it (round-073 shape, 6 ticks)", () => {
    const result = mergeChecklistProgressV1(PLAN_WITH_PART_7, ROUND_073_RESPONSE);
    assert.equal(result.kind, "merged");
    if (result.kind === "merged") {
      const tickedCount = (result.content.match(/- \[x\]/g) ?? []).length;
      assert.equal(tickedCount, 6, "exactly the 6 items under Part 7 must be ticked");
      assert.ok(result.content.includes("- [ ] an item that belongs to Part 6, not Part 7"));
      assert.ok(result.content.includes("- [ ] an item that belongs to Part 8, not Part 7"));
      assert.equal(result.retroactiveTicks?.length, 6);
      for (const tick of result.retroactiveTicks ?? []) {
        assert.match(tick.evidence, /composeCliTimeoutOutcomeV1/);
      }
    }
  });

  /**
   * Same shape as ROUND_073_RESPONSE plus a `## Verification` section, so this
   * isolates ONE question: does a prose-only Plan Item Checklist claim (no
   * checkbox echo at all) satisfy `describeImplementationSummaryShapeIssue`'s
   * checklist-echo requirement on its own? `mergeChecklistProgressV1` is
   * called directly by the test above and succeeds — but in production
   * (`reviewActions.ts`) that call only happens AFTER
   * `describeImplementationSummaryShapeIssue` returns undefined first
   * (`summaryIssue === undefined` gates `checklistMergeResult`). Before this
   * fix, `echoesPlanChecklist` only recognized checkbox lines
   * (`collectChecklistItemKeysV1`), so a pure prose claim's `echo` region was
   * empty and the round was rejected before the merge ever ran — the exact
   * shape round 073 itself used.
   */
  const ROUND_073_SHAPE_WITH_VERIFICATION = [
    "## Files Changed",
    "",
    "- (none) — this round only verified prior work",
    "",
    "## Plan Item Checklist",
    "",
    "- Part 7 — done this round (6/6), evidence: `src/runners/cliAgentRunner.ts` (watchdog + " +
      "`composeCliTimeoutOutcomeV1`), `src/commands/reviewActions.ts:5599-5651`, " +
      "`src/test/cliRetryEvidence.test.ts:297-420`",
    "",
    "## Verification",
    "",
    "- ran the full unit suite",
  ].join("\n");

  void it("a prose-only Plan Item Checklist claim (no checkbox echo at all) satisfies the shape gate's echo requirement on its own", () => {
    const issue = describeImplementationSummaryShapeIssue(ROUND_073_SHAPE_WITH_VERIFICATION, {
      planChecklist: PLAN_WITH_PART_7,
    });
    assert.equal(
      issue,
      undefined,
      "a prose Plan Item Checklist claim with real evidence must satisfy the echo requirement on its own; " +
        "otherwise Part 4's merge fix never runs in the real round-completion pipeline, only in direct unit calls"
    );
  });

  void it("prose completion claims OUTSIDE the '## Plan Item Checklist' section tick nothing", () => {
    const proseOutsideSection = [
      "## Files Changed",
      "",
      "- (none)",
      "",
      "## Verification",
      "",
      "- Add the `databaseWaking` state to the dashboard API — done — verified by hand",
    ].join("\n");
    const plan = [
      "<!-- ensemble:implementation-checklist -->",
      "",
      "- [ ] Add the `databaseWaking` state to the dashboard API",
    ].join("\n");
    const own = splitSummaryAtEchoV1(proseOutsideSection).own;
    assert.deepEqual(collectRetroactiveTickClaimsV1(own), []);
    assert.deepEqual(mergeChecklistProgressV1(plan, proseOutsideSection), { kind: "no-report" });
  });

  void it("a claim naming an item the plan does not have still returns no-match (garbage claims are not silently absorbed)", () => {
    const plan = [
      "<!-- ensemble:implementation-checklist -->",
      "",
      "- [ ] Add the `databaseWaking` state to the dashboard API",
    ].join("\n");
    const garbage = [
      "## Files Changed",
      "",
      "- (none)",
      "",
      "## Plan Item Checklist",
      "",
      "- Some entirely unrelated item the plan never mentioned — done — built and verified",
    ].join("\n");
    const result = mergeChecklistProgressV1(plan, garbage);
    assert.equal(result.kind, "no-match");
    if (result.kind === "no-match") {
      assert.deepEqual(result.unmatchedSample, ["Some entirely unrelated item the plan never mentioned"]);
    }
  });

  void it("a PART-level claim naming a part the plan does not have also returns no-match", () => {
    const plan = [
      "<!-- ensemble:implementation-checklist -->",
      "",
      "## Part 1 — Only part",
      "",
      "- [ ] the only item",
    ].join("\n");
    const claim = [
      "## Files Changed",
      "",
      "- (none)",
      "",
      "## Plan Item Checklist",
      "",
      "- Part 99 — done this round (3/3), evidence: nothing real",
    ].join("\n");
    const result = mergeChecklistProgressV1(plan, claim);
    assert.equal(result.kind, "no-match");
  });
});

// ---------------------------------------------------------------------------
// Part 5 — listUncheckedChecklistItemTextsV1 / filterUncheckedPlanItemsV1
// Naming the exact outstanding items, and resolving a reviewer's Verified
// Complete list against them, is what turns "tick the missed items" into
// something an operator (or the one-click apply command) can act on.
// ---------------------------------------------------------------------------
void describe("Part 5: naming and resolving outstanding checklist items", () => {
  const PLAN = [
    "<!-- ensemble:implementation-checklist -->",
    "",
    "- [x] Split the artifacts",
    "- [ ] Wire the completeness gate",
    "- [ ] Add the retry button",
    `- [ ] An operator-only step ${EXCLUDED_CHECKLIST_ITEM_MARKER_V1}`,
    "- [ ] Fix the \\\"quoted\\\" escaping bug",
  ].join("\n");

  void describe("listUncheckedChecklistItemTextsV1", () => {
    void it("lists unchecked, non-excluded items in document order, unescaped", () => {
      const result = listUncheckedChecklistItemTextsV1(PLAN);
      assert.deepEqual(result.items, [
        "Wire the completeness gate",
        "Add the retry button",
        'Fix the "quoted" escaping bug',
      ]);
      assert.equal(result.total, 3, "excluded and already-checked items must not count");
    });

    void it("bounds the preview to `limit` while `total` still reports the true count", () => {
      const result = listUncheckedChecklistItemTextsV1(PLAN, 1);
      assert.deepEqual(result.items, ["Wire the completeness gate"]);
      assert.equal(result.total, 3);
    });

    void it("returns an empty result for a plan with no checklist", () => {
      const result = listUncheckedChecklistItemTextsV1("# Just prose, no checklist.");
      assert.deepEqual(result.items, []);
      assert.equal(result.total, 0);
    });

    void it("returns an empty result once every item is checked", () => {
      const done = PLAN.replace("- [ ] Wire the completeness gate", "- [x] Wire the completeness gate")
        .replace("- [ ] Add the retry button", "- [x] Add the retry button")
        .replace('- [ ] Fix the \\"quoted\\" escaping bug', '- [x] Fix the \\"quoted\\" escaping bug');
      const result = listUncheckedChecklistItemTextsV1(done);
      assert.deepEqual(result.items, []);
      assert.equal(result.total, 0);
    });

    // wf "make the stage chat a record of work" item 16: an evidence block
    // consuming this function must be able to bound each item's own text, not
    // just the count of items — a single long item (e.g. a multi-paragraph
    // deferral annotation) could still blow out a decision card on its own.
    void it("caps each item to maxItemChars when requested, leaving other callers unaffected", () => {
      const longPlan = [
        "<!-- ensemble:implementation-checklist -->",
        "",
        `- [ ] ${"x".repeat(200)}`,
      ].join("\n");
      const capped = listUncheckedChecklistItemTextsV1(longPlan, 10, { maxItemChars: 160 });
      assert.equal(capped.items[0]?.length, 161, "160 chars plus the ellipsis marker");
      assert.ok(capped.items[0]?.endsWith("…"));

      const uncapped = listUncheckedChecklistItemTextsV1(longPlan);
      assert.equal(uncapped.items[0]?.length, 200, "default call site behaviour is unchanged");
    });
  });

  void describe("truncateChecklistItemTextV1", () => {
    void it("passes short single-line text through unchanged", () => {
      assert.equal(truncateChecklistItemTextV1("Wire the completeness gate", 160), "Wire the completeness gate");
    });

    void it("cuts at the first line when the text carries embedded newlines", () => {
      assert.equal(
        truncateChecklistItemTextV1("Wire the completeness gate\nDeferred 2026-08-24: reason...", 160),
        "Wire the completeness gate…"
      );
    });

    void it("cuts at maxChars when the first line alone exceeds it", () => {
      const result = truncateChecklistItemTextV1("x".repeat(200), 160);
      assert.equal(result.length, 161);
      assert.ok(result.endsWith("…"));
    });
  });

  void describe("filterUncheckedPlanItemsV1", () => {
    void it("resolves candidates to the plan's own unchecked item text, matched case/whitespace-insensitively", () => {
      const resolved = filterUncheckedPlanItemsV1(PLAN, [
        "  WIRE the completeness   gate  ",
        "Add the retry button",
      ]);
      assert.deepEqual(resolved, ["Wire the completeness gate", "Add the retry button"]);
    });

    void it("drops a candidate that is already checked", () => {
      const resolved = filterUncheckedPlanItemsV1(PLAN, ["Split the artifacts", "Add the retry button"]);
      assert.deepEqual(resolved, ["Add the retry button"]);
    });

    void it("drops a candidate matching nothing in the plan (paraphrase or foreign text)", () => {
      const resolved = filterUncheckedPlanItemsV1(PLAN, ["Something the plan never said"]);
      assert.deepEqual(resolved, []);
    });

    void it("drops an excluded item even when named as a candidate", () => {
      const resolved = filterUncheckedPlanItemsV1(PLAN, [
        `An operator-only step ${EXCLUDED_CHECKLIST_ITEM_MARKER_V1}`,
      ]);
      assert.deepEqual(resolved, []);
    });

    void it("deduplicates repeated candidates resolving to the same item", () => {
      const resolved = filterUncheckedPlanItemsV1(PLAN, [
        "Wire the completeness gate",
        "wire the completeness gate",
      ]);
      assert.deepEqual(resolved, ["Wire the completeness gate"]);
    });
  });
});

// ---------------------------------------------------------------------------
// parseChecklistItemPriorityV1 / listOutstandingManualVerificationItemsV1
// (task "Actionable Hand-offs", PART 2): the manual-verification/human-
// operator items a plan marks excluded were previously invisible everywhere
// once the rest of the plan finished. These name them, and sort a HIGH-cost
// one ahead of a LOW-cost one so a time-pressed operator can check three
// things instead of nine.
// ---------------------------------------------------------------------------
void describe("parseChecklistItemPriorityV1", () => {
  void it("parses HIGH and LOW case-insensitively from the rendered hand-off contract wording", () => {
    assert.equal(parseChecklistItemPriorityV1("Priority: HIGH — silent data loss."), "high");
    assert.equal(parseChecklistItemPriorityV1("priority: low — loud and recoverable."), "low");
    assert.equal(parseChecklistItemPriorityV1("some text priority: High in the middle"), "high");
  });

  void it("returns undefined when the text declares no priority", () => {
    assert.equal(parseChecklistItemPriorityV1("Just an ordinary step."), undefined);
  });
});

void describe("listOutstandingManualVerificationItemsV1", () => {
  const PLAN_WITH_PRIORITIES = [
    "<!-- ensemble:implementation-checklist -->",
    "",
    "- [ ] Wire the completeness gate",
    `- [ ] Confirm the low-risk report count. Priority: LOW — a wrong count is loud and recoverable. ${EXCLUDED_CHECKLIST_ITEM_MARKER_V1}`,
    `- [x] Already-done manual step ${EXCLUDED_CHECKLIST_ITEM_MARKER_V1}`,
    `- [ ] Confirm the write path landed bytes correctly. Priority: HIGH — a wrong byte is silent and damaging. ${EXCLUDED_CHECKLIST_ITEM_MARKER_V1}`,
    `- [ ] Deploy the classifier change to production ${EXCLUDED_CHECKLIST_ITEM_MARKER_V1}`,
  ].join("\n");

  void it("lists only unchecked, excluded (manual) items, HIGH priority first", () => {
    const result = listOutstandingManualVerificationItemsV1(PLAN_WITH_PRIORITIES);
    assert.deepEqual(result.items, [
      `Confirm the write path landed bytes correctly. Priority: HIGH — a wrong byte is silent and damaging. ${EXCLUDED_CHECKLIST_ITEM_MARKER_V1}`,
      `Deploy the classifier change to production ${EXCLUDED_CHECKLIST_ITEM_MARKER_V1}`,
      `Confirm the low-risk report count. Priority: LOW — a wrong count is loud and recoverable. ${EXCLUDED_CHECKLIST_ITEM_MARKER_V1}`,
    ]);
    assert.equal(result.total, 3, "the gating item and the already-checked manual item must not appear");
  });

  void it("bounds the preview to `limit` while `total` still reports the true count", () => {
    const result = listOutstandingManualVerificationItemsV1(PLAN_WITH_PRIORITIES, 1);
    assert.deepEqual(result.items, [
      `Confirm the write path landed bytes correctly. Priority: HIGH — a wrong byte is silent and damaging. ${EXCLUDED_CHECKLIST_ITEM_MARKER_V1}`,
    ]);
    assert.equal(result.total, 3);
  });

  void it("leaves a plan with no priority markers in document order — old plans render unchanged", () => {
    const noMarkers = [
      "<!-- ensemble:implementation-checklist -->",
      "",
      `- [ ] First manual step ${EXCLUDED_CHECKLIST_ITEM_MARKER_V1}`,
      `- [ ] Second manual step ${EXCLUDED_CHECKLIST_ITEM_MARKER_V1}`,
      `- [ ] Third manual step ${EXCLUDED_CHECKLIST_ITEM_MARKER_V1}`,
    ].join("\n");
    const result = listOutstandingManualVerificationItemsV1(noMarkers);
    assert.deepEqual(result.items, [
      `First manual step ${EXCLUDED_CHECKLIST_ITEM_MARKER_V1}`,
      `Second manual step ${EXCLUDED_CHECKLIST_ITEM_MARKER_V1}`,
      `Third manual step ${EXCLUDED_CHECKLIST_ITEM_MARKER_V1}`,
    ]);
  });

  void it("returns an empty result when there is no checklist or nothing manual is outstanding", () => {
    assert.deepEqual(listOutstandingManualVerificationItemsV1("# Just prose, no checklist."), {
      items: [],
      total: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// hasContradictoryNoChecklistChangeClaimV1 / describeImplementationSummaryShapeIssue
// — round 013 of task "1.9" (2026-08-14): a response that declares
// `<!-- ensemble:no-checklist-change -->` ("nothing to tick") while also
// reporting retroactive completions in `## Plan Item Checklist` wants
// checklist state to change while explicitly declaring it does not. The
// marker alone satisfied the echo requirement, so the round completed with
// its claimed progress recorded nowhere — the retroactive-claim mechanism
// itself worked correctly (the claims used PARAPHRASED item text, so the
// merge legitimately returned "no-match"); the missing guard is the
// contradiction, caught here before the merge ever runs.
// ---------------------------------------------------------------------------
void describe("hasContradictoryNoChecklistChangeClaimV1", () => {
  const PLAN_ITEM =
    "In the webview <style>, set .model-combo-input to font-size: var(--ensemble-small-font-size) " +
    "and reduce its vertical padding so the combo-box input height shrinks with the text.";

  /** The actual shape observed in runs/013-claude-cli-impl.md of task "1.9". */
  const ROUND_013_SHAPED_RESPONSE = [
    "Status: completed",
    "",
    "Files changed:",
    "_none recorded_",
    "",
    NO_CHECKLIST_CHANGE_MARKER_V1,
    "This round independently re-verified every plan anchor in the working tree.",
    "",
    "## Files Changed",
    "",
    "None — no source, test, or configuration file was created, modified, or deleted this round.",
    "",
    "## Plan Item Checklist",
    "",
    `- \`.model-combo-input\` small font + reduced padding — done ${RETROACTIVE_TICK_MARKER_V1} — src/views/settingsView.ts:672-675`,
    "",
    "## Verification",
    "",
    "- pnpm run test:unit — 2688/2688 pass",
  ].join("\n");

  void it("is false for a plain no-checklist-change declaration with no retroactive claims", () => {
    const response = [
      NO_CHECKLIST_CHANGE_MARKER_V1,
      "This round fixed the review's blocker; no checkbox state changes.",
      "",
      "## Files Changed",
      "",
      "- `src/foo.ts` — fixed the null check",
      "",
      "## Verification",
      "",
      "- ran the unit tests",
    ].join("\n");
    assert.equal(hasContradictoryNoChecklistChangeClaimV1(response), false);
  });

  void it("is false for retroactive claims with no no-checklist-change declaration", () => {
    const response = [
      "## Files Changed",
      "",
      "- (none)",
      "",
      "## Plan Item Checklist",
      "",
      `- ${PLAN_ITEM} — done ${RETROACTIVE_TICK_MARKER_V1} — src/views/settingsView.ts:672-675`,
    ].join("\n");
    assert.equal(hasContradictoryNoChecklistChangeClaimV1(response), false);
  });

  void it("is true for the round-013 shape: the marker plus a retroactive claim in the same response", () => {
    assert.equal(hasContradictoryNoChecklistChangeClaimV1(ROUND_013_SHAPED_RESPONSE), true);
  });

  void it("is false when the echoed checklist merely QUOTES the marker inside an item's own text", () => {
    // Reproduces this repo's own plan echo (this very task's plan-final.md
    // has a Part 3 item describing this mechanism by quoting the marker) —
    // a bare substring match over the whole response read that quotation as
    // the round's own declaration and rejected an otherwise-valid response
    // (review finding, 2026-08-14). The marker never appears on a line of its
    // own here, so it must not be treated as a declaration.
    const response = [
      "<!-- ensemble:implementation-checklist -->",
      "",
      "# Implementation Checklist",
      "",
      `- [x] Treat a summary that both declares ${NO_CHECKLIST_CHANGE_MARKER_V1} and supplies ` +
        "retroactive/done claims as self-contradictory",
      "",
      "## Files Changed",
      "",
      "- `src/foo.ts` — fixed the null check",
      "",
      "## Plan Item Checklist",
      "",
      `- ${PLAN_ITEM} — done ${RETROACTIVE_TICK_MARKER_V1} — src/views/settingsView.ts:672-675`,
      "",
      "## Verification",
      "",
      "- ran the unit tests",
    ].join("\n");
    assert.equal(hasContradictoryNoChecklistChangeClaimV1(response), false);
  });

  void it("the round-013 fixture: the retroactive-claim mechanism itself is not the defect — the merge legitimately returns no-match on the paraphrase", () => {
    // Isolates the merge from the shape gate: this is what
    // `mergeChecklistProgressV1` actually does with round 013's real claim
    // text, proving the root cause is the paraphrase (never matches PLAN_ITEM's
    // exact wording), not a bug in `collectRetroactiveTickClaimsV1` or the
    // merge's matching logic.
    const plan = ["<!-- ensemble:implementation-checklist -->", "", `- [ ] ${PLAN_ITEM}`].join("\n");
    const result = mergeChecklistProgressV1(plan, ROUND_013_SHAPED_RESPONSE);
    assert.equal(result.kind, "no-match");
    if (result.kind === "no-match") {
      assert.deepEqual(result.unmatchedSample, [
        "`.model-combo-input` small font + reduced padding",
      ]);
    }
  });

  void it("describeImplementationSummaryShapeIssue rejects the round-013 shape with an actionable message", () => {
    const issue = describeImplementationSummaryShapeIssue(ROUND_013_SHAPED_RESPONSE, {
      planChecklist: CHECKLIST_PLAN_OF_RECORD,
    });
    assert.ok(issue, "a contradictory response must be rejected");
    assert.match(issue, /no-checklist-change/);
    assert.match(issue, /already ticked in the plan of record/);
  });

  void it("does not flag a response with neither marker nor claims", () => {
    assert.equal(describeImplementationSummaryShapeIssue(WELL_FORMED_SUMMARY), undefined);
  });

  // -------------------------------------------------------------------------
  // wf10 item 12 / plan step 21: three independent providers (jester
  // 2026-08-22, wf9 runs 062 and 064) converged unprompted on the SAME shape —
  // the no-checklist-change marker plus per-item "already ticked in a prior
  // round" notes for items the round only re-verified or extended, never
  // ticking anything new. That shape is a genuine, accurate report and must
  // be accepted, not quarantined as if it were round-013's paraphrase-driven
  // contradiction.
  // -------------------------------------------------------------------------
  const CHECKED_PLAN_ITEM = "Fix `getStageStatus` so the current-stage comparison wins";
  const PLAN_WITH_CHECKED_ITEM = [
    "<!-- ensemble:implementation-checklist -->",
    "",
    "# Implementation Checklist",
    "",
    `- [x] ${CHECKED_PLAN_ITEM}`,
    "- [ ] Some other unbuilt step",
  ].join("\n");
  /** The actual shape from run 064: marker plus a per-item already-ticked note, no marker on the item itself. */
  const RUN_064_SHAPED_RESPONSE = [
    NO_CHECKLIST_CHANGE_MARKER_V1,
    "This round fixed a defect the review raised in already-completed work — it did not tick any " +
      "previously-unbuilt checklist item, so no checkbox state changes.",
    "",
    "## Files Changed",
    "",
    "- `src/foo.ts` — fixed the defect",
    "",
    "## Plan Item Checklist",
    "",
    `- ${CHECKED_PLAN_ITEM} — done — already ticked in a prior round; this round only extended it`,
    "",
    "## Verification",
    "",
    "- pnpm run test:unit — pass",
  ].join("\n");

  void it("is false when every retroactive claim names a plan item already ticked in the plan of record", () => {
    assert.equal(
      hasContradictoryNoChecklistChangeClaimV1(
        RUN_064_SHAPED_RESPONSE,
        collectChecklistItemKeysV1(PLAN_WITH_CHECKED_ITEM),
        new Set(collectCheckedChecklistCountsV1(PLAN_WITH_CHECKED_ITEM).keys())
      ),
      false
    );
  });

  void it("is still true when a claim names a real plan item that is NOT yet ticked", () => {
    const planStillUnchecked = PLAN_WITH_CHECKED_ITEM.replace("[x]", "[ ]");
    assert.equal(
      hasContradictoryNoChecklistChangeClaimV1(
        RUN_064_SHAPED_RESPONSE,
        collectChecklistItemKeysV1(planStillUnchecked),
        new Set(collectCheckedChecklistCountsV1(planStillUnchecked).keys())
      ),
      true
    );
  });

  void it("describeImplementationSummaryShapeIssue accepts the run-064 shape: marker plus per-item already-ticked notes", () => {
    const issue = describeImplementationSummaryShapeIssue(RUN_064_SHAPED_RESPONSE, {
      planChecklist: PLAN_WITH_CHECKED_ITEM,
    });
    assert.equal(issue, undefined);
  });

  // -------------------------------------------------------------------------
  // Review-flagged (2026-08-25): matching an already-checked plan item is a
  // fact about the PLAN, not about what the claim itself says. A bare "done"
  // note naming an already-ticked item must still self-declare as a status
  // note (the marker, or "already ticked"/"already checked"/"already
  // complete" phrasing) WITH evidence — otherwise it is indistinguishable
  // from an entry wrongly claiming fresh completion of an item that merely
  // happens to already be ticked.
  // -------------------------------------------------------------------------
  const RESPONSE_WITH_UNANNOTATED_DONE_CLAIM = [
    NO_CHECKLIST_CHANGE_MARKER_V1,
    "Nothing new was ticked this round.",
    "",
    "## Files Changed",
    "",
    "- `src/foo.ts` — fixed the defect",
    "",
    "## Plan Item Checklist",
    "",
    `- ${CHECKED_PLAN_ITEM} — done — completed this round`,
  ].join("\n");

  void it("is true for a done claim on an already-ticked item that never says the item was already ticked", () => {
    assert.equal(
      hasContradictoryNoChecklistChangeClaimV1(
        RESPONSE_WITH_UNANNOTATED_DONE_CLAIM,
        collectChecklistItemKeysV1(PLAN_WITH_CHECKED_ITEM),
        new Set(collectCheckedChecklistCountsV1(PLAN_WITH_CHECKED_ITEM).keys())
      ),
      true
    );
  });

  void it("describeImplementationSummaryShapeIssue rejects the unannotated-done shape", () => {
    const issue = describeImplementationSummaryShapeIssue(RESPONSE_WITH_UNANNOTATED_DONE_CLAIM, {
      planChecklist: PLAN_WITH_CHECKED_ITEM,
    });
    assert.match(issue ?? "", /no-checklist-change/);
  });

  const RESPONSE_WITH_ANNOTATED_BUT_EMPTY_EVIDENCE = [
    NO_CHECKLIST_CHANGE_MARKER_V1,
    "Nothing new was ticked this round.",
    "",
    "## Files Changed",
    "",
    "- `src/foo.ts` — fixed the defect",
    "",
    "## Plan Item Checklist",
    "",
    // Single em-dash: "already ticked" lands inside the STATUS segment
    // itself (satisfying the annotation check), leaving nothing after a
    // second em-dash to parse as evidence — the case the marker's own
    // documented requirement ("with evidence") exists to catch.
    `- ${CHECKED_PLAN_ITEM} — done, already ticked in a prior round`,
  ].join("\n");

  void it("is true for an already-ticked annotation with no evidence after it", () => {
    assert.equal(
      hasContradictoryNoChecklistChangeClaimV1(
        RESPONSE_WITH_ANNOTATED_BUT_EMPTY_EVIDENCE,
        collectChecklistItemKeysV1(PLAN_WITH_CHECKED_ITEM),
        new Set(collectCheckedChecklistCountsV1(PLAN_WITH_CHECKED_ITEM).keys())
      ),
      true
    );
  });

  const RESPONSE_WITH_EXPLICIT_MARKER = [
    NO_CHECKLIST_CHANGE_MARKER_V1,
    "Nothing new was ticked this round.",
    "",
    "## Files Changed",
    "",
    "- `src/foo.ts` — fixed the defect",
    "",
    "## Plan Item Checklist",
    "",
    `- ${CHECKED_PLAN_ITEM} — done ${RETROACTIVE_TICK_MARKER_V1} — re-verified against app.ts:194`,
  ].join("\n");

  void it("is false when the explicit retroactive marker is used instead of 'already ticked' prose", () => {
    assert.equal(
      hasContradictoryNoChecklistChangeClaimV1(
        RESPONSE_WITH_EXPLICIT_MARKER,
        collectChecklistItemKeysV1(PLAN_WITH_CHECKED_ITEM),
        new Set(collectCheckedChecklistCountsV1(PLAN_WITH_CHECKED_ITEM).keys())
      ),
      false
    );
  });

  // -------------------------------------------------------------------------
  // Review-flagged (2026-08-25), narrowed bypass: the annotation check used
  // to scan the ENTIRE raw bullet, including the immutable item text pulled
  // straight from the plan. A plan item whose own wording happens to quote
  // RETROACTIVE_TICK_MARKER_V1 or "already ticked"-style phrasing — exactly
  // what this task's own step 21 checklist item does — let ANY "done" claim
  // against it read as self-annotated, even with no self-declaration at all
  // in the claim's own status/evidence fields. Reproduced with the real step
  // 21 item text below.
  // -------------------------------------------------------------------------
  const STEP_21_ITEM_TEXT =
    "Extend the summary contract to accept `<!-- ensemble:no-checklist-change -->` together with " +
    "per-item status notes when every referenced checklist item carries an explicit already-ticked " +
    `\`${RETROACTIVE_TICK_MARKER_V1}\` annotation; a summary declaring no-checklist-change while ` +
    'claiming a new tick still rejects. Add a contract test using run 064\'s exact shape (marker plus ' +
    'per-item "already ticked in a prior round" notes) asserting it passes rather than being quarantined.';
  const PLAN_WITH_STEP_21_ITEM = [
    "<!-- ensemble:implementation-checklist -->",
    "",
    "# Implementation Checklist",
    "",
    `- [x] ${STEP_21_ITEM_TEXT}`,
    "- [ ] Some other unbuilt step",
  ].join("\n");
  const RESPONSE_CLAIMING_STEP_21_ITEM_UNANNOTATED = [
    NO_CHECKLIST_CHANGE_MARKER_V1,
    "Nothing new was ticked this round.",
    "",
    "## Files Changed",
    "",
    "- `src/foo.ts` — fixed the defect",
    "",
    "## Plan Item Checklist",
    "",
    `- ${STEP_21_ITEM_TEXT} — done — completed this round`,
  ].join("\n");

  void it("is true for a done claim on an already-ticked item whose OWN TEXT quotes the annotation marker/phrasing, when the claim's status/evidence self-declare nothing", () => {
    assert.equal(
      hasContradictoryNoChecklistChangeClaimV1(
        RESPONSE_CLAIMING_STEP_21_ITEM_UNANNOTATED,
        collectChecklistItemKeysV1(PLAN_WITH_STEP_21_ITEM),
        new Set(collectCheckedChecklistCountsV1(PLAN_WITH_STEP_21_ITEM).keys())
      ),
      true
    );
  });

  void it("describeImplementationSummaryShapeIssue rejects the item-text-quotes-the-marker bypass shape", () => {
    const issue = describeImplementationSummaryShapeIssue(RESPONSE_CLAIMING_STEP_21_ITEM_UNANNOTATED, {
      planChecklist: PLAN_WITH_STEP_21_ITEM,
    });
    assert.match(issue ?? "", /no-checklist-change/);
  });
});

// ---------------------------------------------------------------------------
// describeIncompleteImplementationRoundV1 — the DETECTION half of the
// deferred-round failure (2026-08-13 report item 1): a completed-status round
// whose response promises future work while omitting every required section
// is recorded incomplete and recovered via continuation, never banked.
// ---------------------------------------------------------------------------

void describe("describeIncompleteImplementationRoundV1", () => {
  /** The observed round-014 shape: a deferral to a wakeup that never fires. */
  const DEFERRED_RESPONSE =
    "All edits are staged. Waiting for the background test run to finish " +
    "(scheduled wakeup in ~5 min). I'll pick back up automatically when it " +
    "completes or the wakeup fires.";

  void it("classifies a deferral with no sections and no echo as roundDeferred", () => {
    const detected = describeIncompleteImplementationRoundV1(DEFERRED_RESPONSE, {
      planChecklist: CHECKLIST_PLAN_OF_RECORD,
    });
    assert.equal(detected?.kind, "roundDeferred");
    assert.ok(detected?.reason.includes("follow-up turn"));
  });

  /**
   * wf10 continuation item 17, run 122's actual deferral: "I'll pause here
   * and wait for the background test run to complete before producing the
   * final summary — the completion notification will resume this task
   * automatically." Present-tense "wait" (not "waiting") and a third-person
   * "the completion notification will resume" both slipped past the
   * original phrase list — nothing resumed the round, and its review-driven
   * mandate was lost when the recovery that followed reverted to a
   * checklist-driven continuation instead.
   */
  void it("classifies the run-122 'completion notification will resume' deferral as roundDeferred", () => {
    const detected = describeIncompleteImplementationRoundV1(
      "I'll pause here and wait for the background test run to complete " +
        "before producing the final summary — the completion notification " +
        "will resume this task automatically.",
      { planChecklist: CHECKLIST_PLAN_OF_RECORD }
    );
    assert.equal(detected?.kind, "roundDeferred");
  });

  void it("classifies the 2026-08-10 live status message as roundDeferred", () => {
    const detected = describeIncompleteImplementationRoundV1(
      STATUS_MESSAGE_NOT_A_SUMMARY,
      { planChecklist: CHECKLIST_PLAN_OF_RECORD }
    );
    assert.equal(detected?.kind, "roundDeferred");
  });

  void it("classifies a cut-short response without future-work phrasing as roundIncomplete", () => {
    const detected = describeIncompleteImplementationRoundV1(
      "Refactored the resolver and updated the decoder switch.",
      { planChecklist: CHECKLIST_PLAN_OF_RECORD }
    );
    assert.equal(detected?.kind, "roundIncomplete");
  });

  void it("does not fire on a well-formed summary", () => {
    const wellFormed = [CHECKLIST_PLAN_OF_RECORD, "", WELL_FORMED_SUMMARY].join("\n");
    assert.equal(
      describeIncompleteImplementationRoundV1(wellFormed, {
        planChecklist: CHECKLIST_PLAN_OF_RECORD,
      }),
      undefined
    );
  });

  void it("classifies a deferral with exactly one section present as roundDeferred (Part 1 tightening)", () => {
    // Pre-tightening this stayed on the rejected-summary path because one
    // section was present. But the section a deferring response DID produce
    // is a partial narration of work it declares unfinished — a one-section
    // variant of round 010 ("workflow 2") would have been stamped unusable
    // with nothing persisted, stranding the task the same way. Deferral
    // phrasing plus ANY missing required section is now a deferred round.
    const partial =
      "## Files Changed\n\n- `src/a.ts` — resolver update\n\n" +
      "I'll report back when the build completes.";
    assert.equal(
      describeIncompleteImplementationRoundV1(partial, {
        planChecklist: CHECKLIST_PLAN_OF_RECORD,
      })?.kind,
      "roundDeferred"
    );
  });

  void it("classifies a deferral whose sections are empty as roundDeferred when the round changed files", () => {
    const hollow =
      "## Files Changed\n\n## Verification\n\n" +
      "I'll report back when the build completes.";
    assert.equal(
      describeIncompleteImplementationRoundV1(hollow, {
        roundChangedFiles: true,
      })?.kind,
      "roundDeferred"
    );
  });

  void it("accepts a complete, well-shaped summary with an incidental phrase match", () => {
    // "check it completes" trips a deferral phrase, but nothing is missing
    // from the report — an incidental match must not reject a compliant round.
    const complete = [
      "## Files Changed",
      "",
      "- `src/a.ts` — resolver update",
      "",
      "## Verification",
      "",
      "- run `pnpm test` and check it completes cleanly",
    ].join("\n");
    assert.equal(
      describeIncompleteImplementationRoundV1(complete, { roundChangedFiles: true }),
      undefined
    );
  });

  void it("fires on a Verification-only response whose own-scope region is empty", () => {
    // With an echo expected, the run-owned region starts at the response's
    // own `## Files Changed`; a response without one has an EMPTY own scope,
    // so a floating `## Verification` does not count as a report — the plan's
    // own-scope rule, shared with the shape gate.
    const partial =
      "## Verification\n\n- ran the tests\n\nI'll report back when the build completes.";
    assert.equal(
      describeIncompleteImplementationRoundV1(partial, {
        planChecklist: CHECKLIST_PLAN_OF_RECORD,
      })?.kind,
      "roundDeferred"
    );
  });

  void it("does not fire when the response echoes the plan checklist (round reported durable state)", () => {
    const echoOnly = [
      "<!-- ensemble:implementation-checklist -->",
      "",
      "- [x] Reproduce the Publish rollback bug before fixing",
      "- [ ] Fix `getStageStatus` so the current-stage comparison wins",
    ].join("\n");
    assert.equal(
      describeIncompleteImplementationRoundV1(echoOnly, {
        planChecklist: CHECKLIST_PLAN_OF_RECORD,
      }),
      undefined
    );
  });

  void it("classifies an empty response as roundIncomplete (the limiting no-sections case)", () => {
    // Plan contract: EVERY completed response omitting all required sections
    // becomes an incomplete round. Routing the empty case to the shape gate
    // instead let a cut-short round fall onto the rejected-summary path,
    // which banks its changed files and replaces impl-summary.md — the exact
    // poisoning the detector exists to prevent (review blocker, 2026-08-13).
    assert.equal(describeIncompleteImplementationRoundV1("", {})?.kind, "roundIncomplete");
    assert.equal(
      describeIncompleteImplementationRoundV1("   \n ", {})?.kind,
      "roundIncomplete"
    );
    assert.equal(
      describeIncompleteImplementationRoundV1("", {
        planChecklist: CHECKLIST_PLAN_OF_RECORD,
      })?.kind,
      "roundIncomplete"
    );
  });

  void it("detects a section-less deferral even when no checklist echo is expected", () => {
    const detected = describeIncompleteImplementationRoundV1(DEFERRED_RESPONSE, {});
    assert.equal(detected?.kind, "roundDeferred");
  });

  void it("agrees with the shared section assessment used by the shape gate", () => {
    // The detector and the gate read the same factored helper — a response
    // the detector calls section-less must also fail the shape gate, so a
    // detected round can never have been promotable.
    const issue = describeImplementationSummaryShapeIssue(DEFERRED_RESPONSE, {
      planChecklist: CHECKLIST_PLAN_OF_RECORD,
    });
    assert.ok(issue !== undefined);
    const sections = assessImplementationSummarySectionsV1(DEFERRED_RESPONSE, {
      planChecklist: CHECKLIST_PLAN_OF_RECORD,
    });
    assert.equal(sections.filesChangedPresent, false);
    assert.equal(sections.verificationPresent, false);
    assert.equal(sections.checklistEchoPresent, false);
  });
});

// ---------------------------------------------------------------------------
// The round-010 fixture (".ensemble/2026-08-13_task_1" — "workflow 2"): the
// stale-waiter-cutoff reproduction. The round was finalized `completed` with
// its 5-file delta kept, while its entire final response was the narration
// below; impl-summary.md was stamped unusable and NOTHING was persisted or
// scheduled, so the task sat at impl-high-review/active indefinitely. These
// tests pin which gate now catches that exact body.
// ---------------------------------------------------------------------------

void describe("round-010 stale-waiter fixture (workflow 2)", () => {
  /** Verbatim response body from runs/010-claude-cli-impl.md. */
  const ROUND_010_RESPONSE =
    "Stale waiter stopped. The full unit suite (with the fix compiled in) is " +
    "running in the background — I'll write the final summary when its " +
    "completion notification arrives with the final pass/fail counts.";

  void it("the incomplete-round detector catches it as roundDeferred, with a checklist expected", () => {
    const detected = describeIncompleteImplementationRoundV1(ROUND_010_RESPONSE, {
      planChecklist: CHECKLIST_PLAN_OF_RECORD,
      roundChangedFiles: true,
    });
    assert.equal(detected?.kind, "roundDeferred");
    assert.ok(detected?.reason.includes("follow-up turn"));
  });

  void it("the detector catches it with no checklist expectation too", () => {
    assert.equal(
      describeIncompleteImplementationRoundV1(ROUND_010_RESPONSE, {})?.kind,
      "roundDeferred"
    );
  });

  void it("the shape gate also rejects it, so neither gate can promote the narration", () => {
    // The historical failure: this gate DID fire (the summary was stamped
    // unusable) but its branch persisted no recovery state. The detector now
    // classifies the round first, and the recovery transition backs both
    // gates — this pins that the body can never satisfy either.
    assert.ok(
      describeImplementationSummaryShapeIssue(ROUND_010_RESPONSE, {
        planChecklist: CHECKLIST_PLAN_OF_RECORD,
        roundChangedFiles: true,
      }) !== undefined
    );
  });
});

// ---------------------------------------------------------------------------
// Part 2 (finding 2): the round's self-reported `## Files Changed` list and
// the snapshot/report attribution split that keeps concurrent hand edits out
// of implReviewFiles.
// ---------------------------------------------------------------------------

void describe("parseReportedFilesChangedV1", () => {
  void it("parses backticked and plain bullet paths from the response's own Files Changed", () => {
    const summary = [
      "## Files Changed",
      "",
      "- `src/a.ts` — added the resolver",
      "- src/b.ts — wired the decoder",
      "* `src/c.ts`",
      "",
      "## Verification",
      "",
      "- ran tests",
    ].join("\n");
    assert.deepEqual(parseReportedFilesChangedV1(summary), [
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
    ]);
  });

  void it("returns undefined when there is no Files Changed section (or no text at all)", () => {
    assert.equal(parseReportedFilesChangedV1("Just prose, no sections."), undefined);
    assert.equal(parseReportedFilesChangedV1(""), undefined);
    assert.equal(parseReportedFilesChangedV1("   \n\n  "), undefined);
  });

  void it("returns an empty list for a present-but-empty section, distinct from undefined", () => {
    const summary = ["## Files Changed", "", "## Verification", "", "- checked"].join("\n");
    assert.deepEqual(parseReportedFilesChangedV1(summary), []);
  });

  void it("skips checkbox bullets and parenthesized prose entries", () => {
    const summary = [
      "## Files Changed",
      "",
      "- [x] Reproduce the Publish rollback bug before fixing",
      "- (the runner reported no changed paths)",
      "- `src/real.ts` — the only actual file entry",
    ].join("\n");
    assert.deepEqual(parseReportedFilesChangedV1(summary), ["src/real.ts"]);
  });

  void it("normalizes backslashes and a leading ./ in reported paths", () => {
    const summary = [
      "## Files Changed",
      "",
      "- `src\\utils\\thing.ts` — windows separators",
      "- ./src/other.ts — leading dot-slash",
    ].join("\n");
    assert.deepEqual(parseReportedFilesChangedV1(summary), [
      "src/utils/thing.ts",
      "src/other.ts",
    ]);
  });

  void it("scopes to the run-owned region when a checklist echo is expected, so a plan phase named Files Changed is not read as the file list", () => {
    const echoOnly = [
      "<!-- ensemble:implementation-checklist -->",
      "",
      "- [ ] Reproduce the Publish rollback bug before fixing",
      "",
      "## Files Changed",
      "",
      "- [ ] Fix `getStageStatus` so the current-stage comparison wins",
    ].join("\n");
    assert.equal(
      parseReportedFilesChangedV1(echoOnly, { planChecklist: CHECKLIST_PLAN_OF_RECORD }),
      undefined
    );
  });

  void it("ignores a Files Changed heading quoted inside a fenced block", () => {
    const summary = [
      "```",
      "## Files Changed",
      "- `src/fenced.ts`",
      "```",
      "",
      "Some prose only.",
    ].join("\n");
    assert.equal(parseReportedFilesChangedV1(summary), undefined);
  });
});

void describe("attributeImplementationRoundFilesV1", () => {
  void it("banks the intersection and surfaces snapshot-only paths as unattributed", () => {
    const split = attributeImplementationRoundFilesV1(
      ["src/real.ts", "apps/mobile/hand-edit.ts"],
      ["src/real.ts"]
    );
    assert.deepEqual(split.attributed, ["src/real.ts"]);
    assert.deepEqual(split.unattributed, ["apps/mobile/hand-edit.ts"]);
  });

  void it("keeps a file that is in both sets (hand-edited during a pause AND modified by the round)", () => {
    const split = attributeImplementationRoundFilesV1(
      ["src/both.ts", "src/mine.ts"],
      ["src/both.ts", "src/mine.ts", "src/reported-only.ts"]
    );
    assert.deepEqual(split.attributed, ["src/both.ts", "src/mine.ts"]);
    // Reported-only paths simply never appear: the snapshot says they did not change.
    assert.deepEqual(split.unattributed, []);
  });

  void it("matches case-insensitively and across separator styles, so a report never falsely drops a real edit", () => {
    const split = attributeImplementationRoundFilesV1(
      ["src/Utils/Thing.ts"],
      ["src\\utils\\thing.ts"]
    );
    assert.deepEqual(split.attributed, ["src/Utils/Thing.ts"]);
  });

  void it("with no self-report (undefined) attributes NOTHING — the snapshot alone is not evidence of authorship", () => {
    // A model-authored response whose `## Files Changed` section is absent or
    // unparseable must fail CLOSED: banking the raw snapshot here would let a
    // malformed-but-not-incomplete response adopt concurrent hand edits into
    // implReviewFiles. (The synthetic/receipt-backed path banks its snapshot
    // at the call site and never reaches this function.)
    const split = attributeImplementationRoundFilesV1(["src/a.ts", "src/b.ts"], undefined);
    assert.deepEqual(split.attributed, []);
    assert.deepEqual(split.unattributed, ["src/a.ts", "src/b.ts"]);
  });

  void it("with an empty self-report attributes nothing and surfaces everything", () => {
    const split = attributeImplementationRoundFilesV1(["src/a.ts"], []);
    assert.deepEqual(split.attributed, []);
    assert.deepEqual(split.unattributed, ["src/a.ts"]);
  });
});
