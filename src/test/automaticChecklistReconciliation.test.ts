/**
 * Unit tests for `runAutomaticChecklistReconciliationV1` (workflow 8, item 2 /
 * plan Part 4) — the bounded automatic pass that gathers evidence for a
 * runner-synthesized edit round (`summaryIsSynthetic`) so a human can decide
 * whether the plan's checklist actually reflects what landed.
 *
 * 2026-08-21 NINTH review round (the persisting Part 4 architectural
 * blocker): this pass never writes plan-final.md and never ticks anything
 * itself, for EITHER tier — an earlier revision auto-merged tier-1
 * (review-verified) evidence on the strength of the reviewer's own judgement;
 * the review held that this was the same mistake tier 2's auto-tick was
 * (EIGHTH round): the plan's own narrowing decision requires explicit human
 * selection for ALL evidence this pass finds, applied only through
 * `applyReconciliationReviewVerifiedTicksV1` (which reuses
 * `applyReviewerVerifiedTicks.ts`'s own merge primitives). Correspondingly,
 * `computeSyntheticRoundChecklistLatchV1` no longer reads this function's
 * outcome at all — a synthetic round that changed files always latches,
 * regardless of what this pass found (see that function's own doc comment
 * and `checklistRoundDiagnosticsV1.test.ts`).
 *
 * Covered here, at the pure-function level (real filesystem fixtures, no
 * VS Code command/inventory scaffolding needed since the function under test
 * takes only a folder URI):
 *   1. `"candidatesFound"` — a review names an unticked item verified
 *      complete; it is surfaced as a tier-1 candidate (`reviewVerifiedItems`),
 *      never ticked or written.
 *   2. `"nothingCovered"` — no review artifact exists at all.
 *   3. `"nothingCovered"` — a review exists but names none of the currently
 *      unticked items.
 *   4. `"unavailable"` — the plan has no checklist to reconcile against.
 *   5. Only currently-unticked items are reported as candidates; an item the
 *      review names that is already checked is left alone and not
 *      double-counted.
 *   6. Coverage is deduplicated across multiple review stages naming the
 *      same item — reported once, not twice.
 *   7. `"candidatesFound"` — this round's own applied operations fully cover
 *      every file an unticked item names; it is surfaced as a
 *      `pendingOperationEvidenceItems` candidate (tier 2), NEVER ticked.
 *      Partial coverage (some but not all referenced files touched) or a
 *      pathless item never qualifies as a candidate either.
 *   8. Two further tier-2 candidate guards (2026-08-21 SECOND review round):
 *      a path shared by two unticked items excludes both from tier 2
 *      (exclusivity — a shared-file receipt cannot be attributed to just one
 *      of them), and a `deleteFile`-only receipt only qualifies an item
 *      whose own text reads as a removal (kind-vs-intent — proves removal,
 *      not addition or repair).
 *   9. A third tier-2 guard (2026-08-21 THIRD review round, hardened again
 *      in FOURTH and FIFTH rounds): a non-deletion receipt only qualifies an
 *      item when ALL of the item's own content-check tokens are found, on a
 *      whole-token boundary, in that receipt's `contentExcerpt`, on a line
 *      that does not itself declare the work unfinished. Content that has
 *      nothing to do with the item, content that merely contains an item's
 *      identifier as a substring of a longer word (e.g. `resolverStatus` for
 *      a token `resolver`), content mentioning only SOME of the item's
 *      required concepts, content whose only match sits on a
 *      `TODO`/`FIXME`/not-implemented line, or a receipt with no excerpt at
 *      all, all leave the item unresolved — not even a candidate.
 *  10. Tier 1 and tier 2 can each contribute candidates in the same pass, and
 *      an item covered by neither tier that still overlaps this round's
 *      changed paths is reported as `unresolvedOverlap`.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, before, describe, it } from "node:test";
import * as vscode from "vscode";

import { runAutomaticChecklistReconciliationV1 } from "../commands/reconcilePlanChecklist";
import { computeSyntheticRoundChecklistLatchV1 } from "../commands/reviewActions";

const ROOT = nodeFs.mkdtempSync(
  nodePath.join(nodeOs.tmpdir(), "ensemble-auto-reconcile-test-")
);
after(() => {
  nodeFs.rmSync(ROOT, { recursive: true, force: true });
});

// Back workspace.fs with the real disk — the vscode test stub's
// workspace.fs.readFile is `notImplemented` by default (test-stubs/vscode/index.js),
// same pattern as reconcilePlanChecklistCommand.test.ts's installRealFs.
let restoreFs: () => void;
before(() => {
  const fs = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = { readFile: fs.readFile };
  fs.readFile = async (uri: vscode.Uri): Promise<Uint8Array> =>
    new TextEncoder().encode(await nodeFs.promises.readFile(uri.fsPath, "utf8"));
  restoreFs = (): void => {
    fs.readFile = orig.readFile;
  };
});
after(() => restoreFs());

let counter = 0;
function makeTaskFolder(plan: string | undefined, reviews: Record<string, string> = {}): vscode.Uri {
  const folder = nodePath.join(ROOT, `task-${counter++}`);
  nodeFs.mkdirSync(folder, { recursive: true });
  if (plan !== undefined) {
    nodeFs.writeFileSync(nodePath.join(folder, "plan-final.md"), plan, "utf8");
  }
  for (const [filename, content] of Object.entries(reviews)) {
    nodeFs.writeFileSync(nodePath.join(folder, filename), content, "utf8");
  }
  return vscode.Uri.file(folder);
}

const CHECKLIST_PLAN = [
  "# Final Plan",
  "",
  "<!-- ensemble:implementation-checklist -->",
  "",
  "- [x] Already done before this round",
  "- [ ] Wire the completeness gate",
  "- [ ] Add the missing test",
  "",
].join("\n");

function verifiedCompleteReview(items: readonly string[]): string {
  return [
    "Readiness: 9/10",
    "",
    "<!-- verified-complete:start -->",
    ...items.map((item) => `- ${item}`),
    "<!-- verified-complete:end -->",
    "",
  ].join("\n");
}

/** Confirms a synthetic round with this outcome always latches, regardless of what the pass found. */
async function assertAlwaysLatched(folder: vscode.Uri, changedPaths: readonly string[]): Promise<void> {
  const outcome = await runAutomaticChecklistReconciliationV1(folder, changedPaths);
  const latched = computeSyntheticRoundChecklistLatchV1({
    planChecklistPresent: true,
    roundMayHaveChangedFiles: changedPaths.length > 0,
    summaryIsSynthetic: true,
    summaryIssuePresent: false,
    checklistClaimedButUnmerged: false,
  });
  assert.equal(latched, true, `a synthetic round that changed files must always latch (outcome: ${outcome.kind})`);
}

void describe("runAutomaticChecklistReconciliationV1", () => {
  void it("surfaces a tier-1 candidate for an unticked item a review already names verified complete, never ticks it", async () => {
    const folder = makeTaskFolder(CHECKLIST_PLAN, {
      "impl-high-review.md": verifiedCompleteReview(["Wire the completeness gate"]),
    });
    const outcome = await runAutomaticChecklistReconciliationV1(folder, []);
    assert.equal(outcome.kind, "candidatesFound");
    if (outcome.kind !== "candidatesFound") return;
    assert.deepEqual(outcome.reviewVerifiedItems, ["Wire the completeness gate"]);
    assert.deepEqual(outcome.pendingOperationEvidenceItems, []);

    // Never written — this is a candidate, not a tick (NINTH review round).
    const plainPlan = nodeFs.readFileSync(nodePath.join(folder.fsPath, "plan-final.md"), "utf8");
    assert.equal(plainPlan, CHECKLIST_PLAN);
  });

  void it("reports nothingCovered when no review artifact exists yet", async () => {
    const folder = makeTaskFolder(CHECKLIST_PLAN);
    const outcome = await runAutomaticChecklistReconciliationV1(folder, []);
    assert.equal(outcome.kind, "nothingCovered");
  });

  void it("reports nothingCovered when a review exists but names none of the unticked items", async () => {
    const folder = makeTaskFolder(CHECKLIST_PLAN, {
      "impl-high-review.md": verifiedCompleteReview(["Some unrelated item never in this plan"]),
    });
    const outcome = await runAutomaticChecklistReconciliationV1(folder, []);
    assert.equal(outcome.kind, "nothingCovered");
  });

  void it("reports unavailable when plan-final.md has no checklist", async () => {
    const folder = makeTaskFolder(["# Final Plan", "", "Prose only, no checklist.", ""].join("\n"), {
      "impl-high-review.md": verifiedCompleteReview(["Wire the completeness gate"]),
    });
    const outcome = await runAutomaticChecklistReconciliationV1(folder, []);
    assert.equal(outcome.kind, "unavailable");
  });

  void it("does not report or double-count an item the review names that is already checked", async () => {
    const folder = makeTaskFolder(CHECKLIST_PLAN, {
      "impl-high-review.md": verifiedCompleteReview([
        "Already done before this round",
        "Wire the completeness gate",
      ]),
    });
    const outcome = await runAutomaticChecklistReconciliationV1(folder, []);
    assert.equal(outcome.kind, "candidatesFound");
    if (outcome.kind !== "candidatesFound") return;
    assert.deepEqual(outcome.reviewVerifiedItems, ["Wire the completeness gate"]);
  });

  void it("deduplicates coverage across two review stages naming the same item", async () => {
    const folder = makeTaskFolder(CHECKLIST_PLAN, {
      "impl-high-review.md": verifiedCompleteReview(["Wire the completeness gate"]),
      "impl-low-review.md": verifiedCompleteReview(["Wire the completeness gate"]),
    });
    const outcome = await runAutomaticChecklistReconciliationV1(folder, []);
    assert.equal(outcome.kind, "candidatesFound");
    if (outcome.kind !== "candidatesFound") return;
    assert.deepEqual(outcome.reviewVerifiedItems, ["Wire the completeness gate"]);
  });

  // 2026-08-21 review finding: the pass used to report "nothingCovered" purely
  // because no review had yet named any unticked item — true even for a round
  // whose own changed paths were exactly what an unticked item was about,
  // before any review had a chance to verify it. `changedPaths` closes that
  // gap: the pass now checks whether the round's own edits plausibly relate
  // to an unticked item's referenced file(s) before it will call
  // "nothingCovered".
  void it("reports unavailable (not nothingCovered) when the round's changed paths overlap an unticked item's referenced file, with no review covering it yet", async () => {
    const plan = [
      "# Final Plan",
      "",
      "<!-- ensemble:implementation-checklist -->",
      "",
      "- [ ] Wire the completeness gate in `src/commands/reconcilePlanChecklist.ts`",
      "",
    ].join("\n");
    const folder = makeTaskFolder(plan);
    const outcome = await runAutomaticChecklistReconciliationV1(folder, [
      "src/commands/reconcilePlanChecklist.ts",
    ]);
    assert.equal(outcome.kind, "unavailable");
    if (outcome.kind !== "unavailable") return;
    assert.match(outcome.reason, /reconcilePlanChecklist\.ts/);
  });

  void it("still reports nothingCovered when the round's changed paths do not overlap any unticked item's referenced file", async () => {
    const plan = [
      "# Final Plan",
      "",
      "<!-- ensemble:implementation-checklist -->",
      "",
      "- [ ] Wire the completeness gate in `src/commands/reconcilePlanChecklist.ts`",
      "",
    ].join("\n");
    const folder = makeTaskFolder(plan);
    const outcome = await runAutomaticChecklistReconciliationV1(folder, ["src/utils/unrelatedFile.ts"]);
    assert.equal(outcome.kind, "nothingCovered");
  });

  // 2026-08-21 review finding (pathless case): a checklist item's own prose
  // frequently carries no inline path even though it corresponds to real,
  // file-scoped work. Treating "no path to match against" as proof of
  // unrelatedness was a false safety — it let a round whose changes
  // plausibly completed that exact item slip through as `nothingCovered`.
  // The pass now treats a pathless unticked item as unresolved (not
  // affirmatively ruled unrelated) whenever this round changed some file.
  void it("reports unavailable (not nothingCovered) when an unticked item names no file path at all and this round changed some file", async () => {
    const outcome = await runAutomaticChecklistReconciliationV1(
      makeTaskFolder(CHECKLIST_PLAN),
      ["src/anything.ts"]
    );
    assert.equal(outcome.kind, "unavailable");
    if (outcome.kind !== "unavailable") return;
    assert.match(outcome.reason, /Wire the completeness gate/);
  });

  void it("reports nothingCovered when no file was changed at all, even though unticked items name no path", async () => {
    const outcome = await runAutomaticChecklistReconciliationV1(makeTaskFolder(CHECKLIST_PLAN), []);
    assert.equal(outcome.kind, "nothingCovered");
  });

  // Production wiring: whatever this pass reports, the real
  // `computeSyntheticRoundChecklistLatchV1` must keep a synthetic round with
  // changed files latched (NINTH review round: it no longer reads this
  // function's outcome at all).
  void it("keeps a synthetic round latched (via the real latch decision) regardless of what this pass reports", async () => {
    await assertAlwaysLatched(makeTaskFolder(CHECKLIST_PLAN), ["src/commands/reconcilePlanChecklist.ts"]);
  });

  void describe("mixed case: one item covered by review, a different unticked item overlapped by this round", () => {
    const plan = [
      "# Final Plan",
      "",
      "<!-- ensemble:implementation-checklist -->",
      "",
      "- [ ] Wire the completeness gate in `src/commands/reconcilePlanChecklist.ts`",
      "- [ ] Add the missing test in `src/test/reconcilePlanChecklist.test.ts`",
      "",
    ].join("\n");

    void it("reports the review-covered item as a tier-1 candidate, never writes it, and reports the other item as unresolved overlap", async () => {
      const folder = makeTaskFolder(plan, {
        "impl-high-review.md": verifiedCompleteReview([
          "Wire the completeness gate in `src/commands/reconcilePlanChecklist.ts`",
        ]),
      });

      const outcome = await runAutomaticChecklistReconciliationV1(folder, [
        "src/commands/reconcilePlanChecklist.ts",
        "src/test/reconcilePlanChecklist.test.ts",
      ]);

      assert.equal(outcome.kind, "candidatesFound");
      if (outcome.kind !== "candidatesFound") return;
      assert.deepEqual(outcome.reviewVerifiedItems, [
        "Wire the completeness gate in `src/commands/reconcilePlanChecklist.ts`",
      ]);
      assert.deepEqual(outcome.unresolvedOverlap, [
        "Add the missing test in `src/test/reconcilePlanChecklist.test.ts`",
      ]);

      const persisted = nodeFs.readFileSync(nodePath.join(folder.fsPath, "plan-final.md"), "utf8");
      assert.equal(persisted, plan, "the pass never writes plan-final.md, for either item");

      const latched = computeSyntheticRoundChecklistLatchV1({
        planChecklistPresent: true,
        roundMayHaveChangedFiles: true,
        summaryIsSynthetic: true,
        summaryIssuePresent: false,
        checklistClaimedButUnmerged: false,
      });
      assert.equal(latched, true);
    });

    // 2026-08-21 review finding (Part 4 architectural blocker): applied-
    // operation evidence — the sealed pipeline's own per-step kind + path
    // receipts, threaded end-to-end from `TwoPhaseEditResultV1` through
    // `ImplementationRunResult.appliedOperations` to this function's third
    // parameter (see its doc comment) — is surfaced as a candidate
    // (`pendingOperationEvidenceItems`), never ticked. Each item here names
    // exactly one file, and that file was fully covered by an applied
    // operation this round, so both surface as candidates (there is no
    // review here at all, so tier 1 finds nothing). Each operation also
    // carries a `contentExcerpt` whose words corroborate the item's own
    // content-check tokens (2026-08-21 THIRD review round guard) — without
    // it, path+kind coverage alone would not even qualify as a candidate.
    void it("surfaces items from this round's own applied-operation evidence as pending candidates, never ticked", async () => {
      const folder = makeTaskFolder(plan);
      const outcome = await runAutomaticChecklistReconciliationV1(
        folder,
        ["src/commands/reconcilePlanChecklist.ts", "src/test/reconcilePlanChecklist.test.ts"],
        [
          {
            kind: "patchFile",
            path: "src/commands/reconcilePlanChecklist.ts",
            contentExcerpt: "// wire the completeness gate into the reconciliation pass",
          },
          {
            kind: "createFile",
            path: "src/test/reconcilePlanChecklist.test.ts",
            contentExcerpt: "void it('covers the missing test case', () => {});",
          },
        ]
      );
      assert.equal(outcome.kind, "candidatesFound");
      if (outcome.kind !== "candidatesFound") return;
      assert.deepEqual(outcome.reviewVerifiedItems, []);
      assert.deepEqual(
        outcome.pendingOperationEvidenceItems.map((c) => c.item),
        [
          "Wire the completeness gate in `src/commands/reconcilePlanChecklist.ts`",
          "Add the missing test in `src/test/reconcilePlanChecklist.test.ts`",
        ]
      );
      assert.deepEqual(outcome.unresolvedOverlap, []);

      const plainPlan = nodeFs.readFileSync(nodePath.join(folder.fsPath, "plan-final.md"), "utf8");
      assert.ok(
        plainPlan.includes(
          "- [ ] Wire the completeness gate in `src/commands/reconcilePlanChecklist.ts`"
        )
      );
      assert.ok(
        plainPlan.includes("- [ ] Add the missing test in `src/test/reconcilePlanChecklist.test.ts`")
      );

      const latched = computeSyntheticRoundChecklistLatchV1({
        planChecklistPresent: true,
        roundMayHaveChangedFiles: true,
        summaryIsSynthetic: true,
        summaryIssuePresent: false,
        checklistClaimedButUnmerged: false,
      });
      assert.equal(latched, true);
    });

    // SIXTH review round finding: the review's own literal illustrative
    // example — a decoy string manufactured purely to plant the item's
    // tokens (`const note = 'resolver export pending';`) — is now caught by
    // the widened incompleteness-marker list (`pending` was added).
    void it("does not surface a candidate from a receipt whose only matching content sits on a line naming the work as pending", async () => {
      const resolverPlan = [
        "# Final Plan",
        "",
        "<!-- ensemble:implementation-checklist -->",
        "",
        "- [ ] Add the resolver export in `src/resolver.ts`",
        "",
      ].join("\n");
      const folder = makeTaskFolder(resolverPlan);
      const outcome = await runAutomaticChecklistReconciliationV1(
        folder,
        ["src/resolver.ts"],
        [
          {
            kind: "createFile",
            path: "src/resolver.ts",
            contentExcerpt: "const note = 'resolver export pending';",
          },
        ]
      );
      assert.equal(outcome.kind, "unavailable");
      if (outcome.kind !== "unavailable") return;
      assert.match(outcome.reason, /Add the resolver export/);
    });

    void it("surfaces each round's own tier-2 candidate independently, never touching plan-final.md across rounds", async () => {
      const twoItemPlan = [
        "# Final Plan",
        "",
        "<!-- ensemble:implementation-checklist -->",
        "",
        "- [ ] Wire the completeness gate in `src/commands/reconcilePlanChecklist.ts`",
        "- [ ] Add the missing test in `src/test/reconcilePlanChecklist.test.ts`",
        "",
      ].join("\n");
      const folder = makeTaskFolder(twoItemPlan);
      const firstRound = await runAutomaticChecklistReconciliationV1(
        folder,
        ["src/commands/reconcilePlanChecklist.ts"],
        [
          {
            kind: "patchFile",
            path: "src/commands/reconcilePlanChecklist.ts",
            contentExcerpt: "// wire the completeness gate into the reconciliation pass",
          },
        ]
      );
      assert.equal(firstRound.kind, "candidatesFound");
      if (firstRound.kind !== "candidatesFound") return;
      assert.deepEqual(firstRound.pendingOperationEvidenceItems.map((c) => c.item), [
        "Wire the completeness gate in `src/commands/reconcilePlanChecklist.ts`",
      ]);
      const planAfterFirstRound = nodeFs.readFileSync(nodePath.join(folder.fsPath, "plan-final.md"), "utf8");
      assert.equal(planAfterFirstRound, twoItemPlan);

      const secondRound = await runAutomaticChecklistReconciliationV1(
        folder,
        ["src/test/reconcilePlanChecklist.test.ts"],
        [
          {
            kind: "createFile",
            path: "src/test/reconcilePlanChecklist.test.ts",
            contentExcerpt: "void it('covers the missing test case', () => {});",
          },
        ]
      );
      assert.equal(secondRound.kind, "candidatesFound");
      if (secondRound.kind !== "candidatesFound") return;
      assert.deepEqual(secondRound.pendingOperationEvidenceItems.map((c) => c.item), [
        "Add the missing test in `src/test/reconcilePlanChecklist.test.ts`",
      ]);
    });

    void it("does not surface a candidate when the covering operation's content has nothing to do with what the item describes (content-corroboration guard)", async () => {
      const folder = makeTaskFolder(plan);
      const outcome = await runAutomaticChecklistReconciliationV1(
        folder,
        ["src/commands/reconcilePlanChecklist.ts", "src/test/reconcilePlanChecklist.test.ts"],
        [
          {
            kind: "patchFile",
            path: "src/commands/reconcilePlanChecklist.ts",
            contentExcerpt: "// totally unrelated bookkeeping change, nothing to do with this item",
          },
          {
            kind: "createFile",
            path: "src/test/reconcilePlanChecklist.test.ts",
            contentExcerpt: "// placeholder file, empty scaffold",
          },
        ]
      );
      assert.equal(outcome.kind, "unavailable");
      if (outcome.kind !== "unavailable") return;
      assert.match(outcome.reason, /Wire the completeness gate/);
      assert.match(outcome.reason, /Add the missing test/);
    });

    void it("does not surface a candidate when the covering operation carries no content excerpt at all", async () => {
      const folder = makeTaskFolder(plan);
      const outcome = await runAutomaticChecklistReconciliationV1(
        folder,
        ["src/commands/reconcilePlanChecklist.ts", "src/test/reconcilePlanChecklist.test.ts"],
        [
          { kind: "patchFile", path: "src/commands/reconcilePlanChecklist.ts" },
          { kind: "createFile", path: "src/test/reconcilePlanChecklist.test.ts" },
        ]
      );
      assert.equal(outcome.kind, "unavailable");
      if (outcome.kind !== "unavailable") return;
      assert.match(outcome.reason, /Wire the completeness gate/);
    });

    void it("does not surface a candidate from a receipt whose content contains the item's token only as a substring of a longer word", async () => {
      const resolverPlan = [
        "# Final Plan",
        "",
        "<!-- ensemble:implementation-checklist -->",
        "",
        "- [ ] Add the resolver export in `src/resolver.ts`",
        "",
      ].join("\n");
      const folder = makeTaskFolder(resolverPlan);
      const outcome = await runAutomaticChecklistReconciliationV1(
        folder,
        ["src/resolver.ts"],
        [
          {
            kind: "createFile",
            path: "src/resolver.ts",
            contentExcerpt: 'const resolverStatus = "pending";',
          },
        ]
      );
      assert.equal(outcome.kind, "unavailable");
      if (outcome.kind !== "unavailable") return;
      assert.match(outcome.reason, /Add the resolver export/);
    });

    void it("does not surface a candidate from a receipt that names the identifier but omits the requirement word describing what must happen to it", async () => {
      const resolverPlan = [
        "# Final Plan",
        "",
        "<!-- ensemble:implementation-checklist -->",
        "",
        "- [ ] Add the resolver export in `src/resolver.ts`",
        "",
      ].join("\n");
      const folder = makeTaskFolder(resolverPlan);
      const outcome = await runAutomaticChecklistReconciliationV1(
        folder,
        ["src/resolver.ts"],
        [
          {
            kind: "createFile",
            path: "src/resolver.ts",
            contentExcerpt: "function resolver() {\n  // TODO: not exported yet\n}",
          },
        ]
      );
      assert.equal(outcome.kind, "unavailable");
      if (outcome.kind !== "unavailable") return;
      assert.match(outcome.reason, /Add the resolver export/);
    });

    void it("does not surface a candidate from a receipt whose only matching content sits on a line declaring the work not yet done", async () => {
      const resolverPlan = [
        "# Final Plan",
        "",
        "<!-- ensemble:implementation-checklist -->",
        "",
        "- [ ] Add the resolver export in `src/resolver.ts`",
        "",
      ].join("\n");
      const folder = makeTaskFolder(resolverPlan);
      const outcome = await runAutomaticChecklistReconciliationV1(
        folder,
        ["src/resolver.ts"],
        [
          {
            kind: "createFile",
            path: "src/resolver.ts",
            contentExcerpt: "// TODO: export resolver after migration",
          },
        ]
      );
      assert.equal(outcome.kind, "unavailable");
      if (outcome.kind !== "unavailable") return;
      assert.match(outcome.reason, /Add the resolver export/);
    });

    void it("does not surface a candidate from a receipt whose only matching content sits on a FIXME or not-implemented line", async () => {
      const resolverPlan = [
        "# Final Plan",
        "",
        "<!-- ensemble:implementation-checklist -->",
        "",
        "- [ ] Add the resolver export in `src/resolver.ts`",
        "",
      ].join("\n");
      const folder = makeTaskFolder(resolverPlan);
      const outcome = await runAutomaticChecklistReconciliationV1(
        folder,
        ["src/resolver.ts"],
        [
          {
            kind: "createFile",
            path: "src/resolver.ts",
            contentExcerpt: "// FIXME: resolver export not implemented",
          },
        ]
      );
      assert.equal(outcome.kind, "unavailable");
      if (outcome.kind !== "unavailable") return;
      assert.match(outcome.reason, /Add the resolver export/);
    });

    // Partial coverage must never qualify: the item below references two
    // files, and only one is touched by an applied operation this round, so
    // tier 2 cannot claim full coverage. It stays unresolved — reported via
    // the "unavailable" reason, still enriched with the operation kind that
    // DID overlap.
    void it("does not surface a candidate for an item whose referenced files are only partially covered by applied operations", async () => {
      const partialPlan = [
        "# Final Plan",
        "",
        "<!-- ensemble:implementation-checklist -->",
        "",
        "- [ ] Wire the completeness gate in `src/commands/reconcilePlanChecklist.ts` and `src/other/thing.ts`",
        "",
      ].join("\n");
      const folder = makeTaskFolder(partialPlan);
      const outcome = await runAutomaticChecklistReconciliationV1(
        folder,
        ["src/commands/reconcilePlanChecklist.ts"],
        [{ kind: "patchFile", path: "src/commands/reconcilePlanChecklist.ts" }]
      );
      assert.equal(outcome.kind, "unavailable");
      if (outcome.kind !== "unavailable") return;
      assert.match(outcome.reason, /Wire the completeness gate.*\(patchFile this round\)/);
    });

    // A pathless item is never eligible for a tier-2 candidate, even when
    // applied-operation evidence exists for OTHER files this round touched —
    // there is nothing in the item's own text to confirm the operations are
    // about IT, so it stays unresolved rather than surfaced.
    void it("never surfaces a pathless item as a candidate from applied-operation evidence alone", async () => {
      const folder = makeTaskFolder(CHECKLIST_PLAN);
      const outcome = await runAutomaticChecklistReconciliationV1(folder, ["src/anything.ts"], [
        { kind: "patchFile", path: "src/anything.ts" },
      ]);
      assert.equal(outcome.kind, "unavailable");
      if (outcome.kind !== "unavailable") return;
      assert.match(outcome.reason, /Wire the completeness gate/);
    });

    // 2026-08-21 SECOND review round finding (Part 4 architectural blocker,
    // persisting even with full-path coverage required): a single receipt at
    // a path named by TWO unticked items cannot tell which one it actually
    // satisfied — both items here name the exact same file, so neither
    // qualifies for tier 2; the round stays unresolved for both, reported
    // via "unavailable".
    void it("does not surface either of two unticked items that share the same referenced file as a candidate (exclusivity guard)", async () => {
      const sharedFilePlan = [
        "# Final Plan",
        "",
        "<!-- ensemble:implementation-checklist -->",
        "",
        "- [ ] Add the resolver export in `src/commands/reconcilePlanChecklist.ts`",
        "- [ ] Fix the decoder bug in `src/commands/reconcilePlanChecklist.ts`",
        "",
      ].join("\n");
      const folder = makeTaskFolder(sharedFilePlan);
      const outcome = await runAutomaticChecklistReconciliationV1(
        folder,
        ["src/commands/reconcilePlanChecklist.ts"],
        [{ kind: "patchFile", path: "src/commands/reconcilePlanChecklist.ts" }]
      );
      assert.equal(outcome.kind, "unavailable");
      if (outcome.kind !== "unavailable") return;
      assert.match(outcome.reason, /Add the resolver export/);
      assert.match(outcome.reason, /Fix the decoder bug/);
    });

    void it("does not surface a non-deletion item covered only by a deleteFile operation as a candidate (kind-vs-intent guard)", async () => {
      const addPlan = [
        "# Final Plan",
        "",
        "<!-- ensemble:implementation-checklist -->",
        "",
        "- [ ] Add the resolver export in `src/commands/reconcilePlanChecklist.ts`",
        "",
      ].join("\n");
      const folder = makeTaskFolder(addPlan);
      const outcome = await runAutomaticChecklistReconciliationV1(
        folder,
        ["src/commands/reconcilePlanChecklist.ts"],
        [{ kind: "deleteFile", path: "src/commands/reconcilePlanChecklist.ts" }]
      );
      assert.equal(outcome.kind, "unavailable");
      if (outcome.kind !== "unavailable") return;
      assert.match(outcome.reason, /Add the resolver export/);
    });

    // The same deleteFile-only evidence DOES qualify as a candidate when the
    // item's own text reads as a removal — the guard is about kind-vs-intent
    // mismatch, not about excluding deleteFile evidence altogether.
    void it("surfaces a deletion item covered only by a deleteFile operation as a pending candidate", async () => {
      const removePlan = [
        "# Final Plan",
        "",
        "<!-- ensemble:implementation-checklist -->",
        "",
        "- [ ] Remove the obsolete helper in `src/commands/reconcilePlanChecklist.ts`",
        "",
      ].join("\n");
      const folder = makeTaskFolder(removePlan);
      const outcome = await runAutomaticChecklistReconciliationV1(
        folder,
        ["src/commands/reconcilePlanChecklist.ts"],
        [{ kind: "deleteFile", path: "src/commands/reconcilePlanChecklist.ts" }]
      );
      assert.equal(outcome.kind, "candidatesFound");
      if (outcome.kind !== "candidatesFound") return;
      assert.deepEqual(outcome.pendingOperationEvidenceItems.map((c) => c.item), [
        "Remove the obsolete helper in `src/commands/reconcilePlanChecklist.ts`",
      ]);
    });

    // Both tiers can surface a candidate in the same pass, on different
    // items: one because a review already verified it (tier 1), the other
    // only because this round's own applied operations fully covered it
    // (tier 2). Neither is ticked; both ride together in `candidatesFound`.
    void it("surfaces a tier-1 candidate and a tier-2 candidate for different items in the same pass", async () => {
      const folder = makeTaskFolder(plan, {
        "impl-high-review.md": verifiedCompleteReview([
          "Wire the completeness gate in `src/commands/reconcilePlanChecklist.ts`",
        ]),
      });
      const outcome = await runAutomaticChecklistReconciliationV1(
        folder,
        ["src/commands/reconcilePlanChecklist.ts", "src/test/reconcilePlanChecklist.test.ts"],
        [
          {
            kind: "createFile",
            path: "src/test/reconcilePlanChecklist.test.ts",
            contentExcerpt: "void it('covers the missing test case', () => {});",
          },
        ]
      );
      assert.equal(outcome.kind, "candidatesFound");
      if (outcome.kind !== "candidatesFound") return;
      assert.deepEqual(outcome.reviewVerifiedItems, [
        "Wire the completeness gate in `src/commands/reconcilePlanChecklist.ts`",
      ]);
      assert.deepEqual(outcome.pendingOperationEvidenceItems.map((c) => c.item), [
        "Add the missing test in `src/test/reconcilePlanChecklist.test.ts`",
      ]);
      // Both items are covered by SOME tier, so neither shows up as
      // unresolved overlap — that bucket is only for items neither tier
      // covers.
      assert.deepEqual(outcome.unresolvedOverlap, []);

      const plainPlan = nodeFs.readFileSync(nodePath.join(folder.fsPath, "plan-final.md"), "utf8");
      assert.equal(plainPlan, plan, "neither candidate is written");

      const latched = computeSyntheticRoundChecklistLatchV1({
        planChecklistPresent: true,
        roundMayHaveChangedFiles: true,
        summaryIsSynthetic: true,
        summaryIssuePresent: false,
        checklistClaimedButUnmerged: false,
      });
      assert.equal(latched, true, "candidates alone never clear the latch — only explicit human attestation does");
    });

    void it("omits the operation-kind annotation when no operation evidence is supplied (back-compat, unchanged outcome)", async () => {
      const folder = makeTaskFolder(plan);
      const outcome = await runAutomaticChecklistReconciliationV1(folder, [
        "src/commands/reconcilePlanChecklist.ts",
        "src/test/reconcilePlanChecklist.test.ts",
      ]);
      assert.equal(outcome.kind, "unavailable");
      if (outcome.kind !== "unavailable") return;
      assert.doesNotMatch(outcome.reason, /this round\)/);
    });

    void it("reports every item as a tier-1 candidate once a later review also covers the previously-overlapped item, still latched", async () => {
      const folder = makeTaskFolder(plan, {
        "impl-high-review.md": verifiedCompleteReview([
          "Wire the completeness gate in `src/commands/reconcilePlanChecklist.ts`",
          "Add the missing test in `src/test/reconcilePlanChecklist.test.ts`",
        ]),
      });

      const outcome = await runAutomaticChecklistReconciliationV1(folder, [
        "src/commands/reconcilePlanChecklist.ts",
        "src/test/reconcilePlanChecklist.test.ts",
      ]);

      assert.equal(outcome.kind, "candidatesFound");
      if (outcome.kind !== "candidatesFound") return;
      assert.deepEqual(outcome.unresolvedOverlap, []);

      // NINTH review round: unlike the earlier auto-tick design, full tier-1
      // coverage no longer clears the latch by itself — only explicit human
      // attestation does (`reconcilePlanChecklistConfirmedV1`).
      const latched = computeSyntheticRoundChecklistLatchV1({
        planChecklistPresent: true,
        roundMayHaveChangedFiles: true,
        summaryIsSynthetic: true,
        summaryIssuePresent: false,
        checklistClaimedButUnmerged: false,
      });
      assert.equal(latched, true);
    });
  });
});
