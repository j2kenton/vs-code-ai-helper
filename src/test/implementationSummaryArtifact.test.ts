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
  buildSyntheticImplementationSummaryV1,
  buildUnusableImplementationSummaryV1,
  describeImplementationSummaryShapeIssue,
  getCanonicalImplementationUri,
  getImplementationSummaryUri,
  isUnusableImplementationSummaryV1,
  readImplementationReviewContent,
} from "../utils/implementationArtifactResolver";
import { verifyPlanItems } from "../utils/completionLint";
import {
  countChecklistProgressV1,
  hasImplementationChecklistV1,
  mergeChecklistProgressV1,
  scopeToLatestChecklistV1,
  splitSummaryAtEchoV1,
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
    const merged = mergeChecklistProgressV1(CHECKLIST_PLAN_OF_RECORD, SUMMARY_WITH_PROGRESS);
    assert.ok(merged, "a round reporting progress must update the plan of record");

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
    const merged = mergeChecklistProgressV1(alreadyDone, SUMMARY_WITH_PROGRESS);
    assert.ok(merged);
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
    const merged = mergeChecklistProgressV1(CHECKLIST_PLAN_OF_RECORD, reordered);
    assert.ok(merged);
    assert.ok(merged.includes("- [x] Delete the auto-rename block in `handleDraftOutcomeV1`"));
    assert.ok(merged.includes("- [x] Reproduce the Publish rollback bug before fixing"));
    assert.ok(merged.includes("- [ ] Fix the `autoFirstActive` expansion"));
  });

  void it("leaves the document untouched when the round reported no completions", () => {
    assert.equal(
      mergeChecklistProgressV1(CHECKLIST_PLAN_OF_RECORD, WELL_FORMED_SUMMARY),
      undefined,
      "a summary with no reproduced checklist must not rewrite the plan of record"
    );
  });

  void it("preserves CRLF line endings and surrounding prose byte-for-byte", () => {
    const crlf = CHECKLIST_PLAN_OF_RECORD.split("\n").join("\r\n");
    const merged = mergeChecklistProgressV1(crlf, SUMMARY_WITH_PROGRESS);
    assert.ok(merged);
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
    const merged = mergeChecklistProgressV1(CHECKLIST_PLAN_OF_RECORD, SUMMARY_WITH_PROGRESS);
    assert.ok(merged);
    const remaining = merged
      .split(/\r?\n/)
      .filter((line) => /^\s*[-*]\s*\[ \]/.test(line));
    assert.equal(remaining.length, 3, "three items remain, and the plan still says so");
  });
});

void describe("a narrowed denominator cannot declare the plan finished", () => {
  void it("counts the plan of record's checklist, deduped", () => {
    const counted = countChecklistProgressV1(CHECKLIST_PLAN_OF_RECORD);
    assert.deepEqual(counted, { total: 5, checked: 0, remaining: 5 });
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
      checked: 6,
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
      { total: 25, checked: 25, remaining: 0 }
    );
    assert.deepEqual(reconciled, { complete: 13, total: 25 });
    assert.equal(isPlanIncomplete(reconciled), true);
  });

  void it("advances normally once both the checklist and the review agree", () => {
    const reconciled = reconcileProgressWithChecklistV1(
      { complete: 25, total: 25 },
      { total: 25, checked: 25, remaining: 0 }
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
    const leftover = { total: 47, checked: 6, remaining: 41 };
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
      checked: 6,
      remaining: 41,
    });
    assert.deepEqual(reconciled, { complete: 6, total: 47 });
    assert.equal(isPlanIncomplete(reconciled), true);
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
    assert.equal(mergeChecklistProgressV1(CHECKLIST_PLAN_OF_RECORD, verificationOnly), undefined);
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
    assert.ok(mergeChecklistProgressV1(CHECKLIST_PLAN_OF_RECORD, echoed));
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
    assert.deepEqual(countChecklistProgressV1(attributed), { total: 5, checked: 0, remaining: 5 });
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
      remaining: 3,
    });
  });

  void it("ticking one same-worded item does not tick the other", () => {
    const echo = [
      "<!-- ensemble:implementation-checklist -->",
      "- [x] Add a regression test",
      "- [ ] Wire the gate",
      "- [ ] Add a regression test",
    ].join("\n");
    const merged = mergeChecklistProgressV1(DUPLICATE_WORDING, echo);
    assert.ok(merged);
    const lines = merged.split("\n").filter((l) => l.includes("Add a regression test"));
    assert.deepEqual(lines, ["- [x] Add a regression test", "- [ ] Add a regression test"]);
    // The unfinished second copy still holds the denominator open.
    assert.deepEqual(countChecklistProgressV1(merged), { total: 3, checked: 1, remaining: 2 });
  });

  void it("still collapses a whole checklist reproduced a second time", () => {
    // The observed live case: a response reproduces "that entire checklist
    // marker and list verbatim", so the document carries two renderings.
    // Counting both would double the denominator and stall the task.
    const reproduced = `${CHECKLIST_PLAN_OF_RECORD}\n\n## Implementation Notes\n\n${CHECKLIST_PLAN_OF_RECORD}`;
    assert.deepEqual(countChecklistProgressV1(reproduced), {
      total: 5,
      checked: 0,
      remaining: 5,
    });
    assert.equal(verifyPlanItems(reproduced).length, 5, "one rendering, not two");
  });

  void it("reads the freshest rendering when an older copy is stale", () => {
    const stale = CHECKLIST_PLAN_OF_RECORD;
    const fresh = CHECKLIST_PLAN_OF_RECORD.replace(/- \[ \]/g, "- [x]");
    assert.deepEqual(countChecklistProgressV1(`${stale}\n\n${fresh}`), {
      total: 5,
      checked: 5,
      remaining: 0,
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
      remaining: 3,
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
    assert.deepEqual(counted, { total: 2, checked: 0, remaining: 2 });
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
      remaining: 2,
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
      remaining: 1,
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
    const merged = mergeChecklistProgressV1(plan, reorderedEcho);
    assert.ok(merged);
    assert.deepEqual(countChecklistProgressV1(merged), {
      total: 3,
      checked: 2,
      remaining: 1,
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
      mergeChecklistProgressV1(plan, echo),
      undefined,
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
      { total: 2, checked: 2, remaining: 0 },
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
      remaining: 2,
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
    const merged = mergeChecklistProgressV1(doc, echo);
    assert.ok(merged);
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
    const merged = mergeChecklistProgressV1(PLAN_WITH_DUPES, response);
    assert.ok(merged);
    assert.deepEqual(
      countChecklistProgressV1(merged),
      { total: 3, checked: 1, remaining: 2 },
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
