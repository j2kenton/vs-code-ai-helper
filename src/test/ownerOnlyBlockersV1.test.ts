/**
 * review1 Steps 37, 38 and 42 (Part 7): one card per owner-only blocker, only options that can work at the
 * stage, and "None" sections that raise nothing.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import { describe, it } from "node:test";
import {
  isNoneItemTextV1,
  parseOwnerDecisionsNeededV1,
  parsePlanDeviationsV1,
  planDeviationsNoneNoteV1,
} from "../utils/reviewReadiness";
import {
  attributeBlockersToDecisionBlocksV1,
  postOwnerOnlyBlockersCardV1,
  postOwnerPlanDecisionCardV1,
  raiseOwnerDecisionCardsFromReviewV1,
  raisePlanDeviationCardsV1,
} from "../commands/ownerPlanDecisionCommandV1";
import { listPendingWorkflowDecisionsForTaskV1 } from "../utils/workflowDecisionDispatchV1";
import { ownerBlockerIdentityV1 } from "../utils/ownerCardCoverageV1";
import { escalateStandingAlongsideWorkV1, standingOnlyBlockerDescriptionsV1 } from "../commands/reviewActions";
import { buildEscalationDecisionV1 } from "../utils/reviewEscalation";
import { optionAppliesAtStageV1, planFileNameForStageV1 } from "../utils/optionAppliesAtStageV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
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

const PLAN = [
  "## Part 4",
  "",
  "- [ ] Step 18: Make the post-review dispatch single.",
  "- [ ] Step 19: Let Ensemble sort the blockers.",
].join("\n");

void describe("review1 Step 42: None sections raise nothing", () => {
  void it("skips every 'None' wording in plan deviations", () => {
    const texts = [
      "None. This round carries out the owner's 2026-11-03 decision.",
      "None beyond the alternate mechanisms in Verified Complete (holder filled in the lease store).",
      "**None** — the plan was followed.",
      "_None._",
      "- Nothing to report.",
      "No deviations.",
      "No plan deviation this round.",
      "N/A",
    ];
    for (const text of texts) {
      assert.deepEqual(parsePlanDeviationsV1(`## Plan deviations\n\n${text}\n`), [], text);
    }
  });

  void it("keeps the text after 'None beyond …' for the summary line, never a card", () => {
    const content = "## Plan deviations\n\nNone beyond the helper-based Step 19 coverage.\n";
    assert.deepEqual(parsePlanDeviationsV1(content), []);
    assert.equal(planDeviationsNoneNoteV1(content), "beyond the helper-based Step 19 coverage.");
    assert.equal(planDeviationsNoneNoteV1("## Plan deviations\n\nStep 18 used a helper.\n"), undefined);
  });

  void it("a real departure raises one card that names the step, the round and what Reject does", () => {
    const content = "## Plan deviations\n\n- Step 18 renders the apply template through the shared helper instead of inline.\n";
    const cards = parsePlanDeviationsV1(content, { roundName: "Apply Review", planOfRecord: PLAN });
    assert.equal(cards.length, 1);
    assert.equal(cards[0]!.planPurpose, "Apply Review built Step 18 differently from the plan");
    assert.match(cards[0]!.problem, /shared helper/);
    const reject = cards[0]!.options.find((o) => o.rejects);
    assert.match(reject?.consequence ?? "", /kept/);
  });

  void it("a step the plan does not have is not named", () => {
    const content = "## Plan deviations\n\n- Step 99 was built another way.\n";
    const [card] = parsePlanDeviationsV1(content, { roundName: "Implementation", planOfRecord: PLAN });
    assert.equal(card?.planPurpose, "Implementation reports a departure from the plan");
  });

  void it("skips 'None' owner-decision blocks, with or without a heading", () => {
    const bare = "## Owner decisions needed\n\nNone. The remaining wording fix is task-fixable under the existing plan.\n";
    assert.deepEqual(parseOwnerDecisionsNeededV1(bare), []);
    const headed = "## Owner decisions needed\n\n### nothing-to-decide\nNone — the excluded owner checks remain owed.\n";
    assert.deepEqual(parseOwnerDecisionsNeededV1(headed), []);
  });

  void it("does not skip a real owner decision whose text merely contains the word", () => {
    const real = [
      "## Owner decisions needed",
      "",
      "### keep-pop-ups",
      "- id: keep-pop-ups",
      "- what is undecided or went wrong: None of the six categories says whether to keep pop-ups.",
      "- options:",
      "  - Keep them — stays as written",
      "  - Remove them — changes the rule",
    ].join("\n");
    assert.equal(parseOwnerDecisionsNeededV1(real).length, 1);
    assert.equal(isNoneItemTextV1("Nonexistent file"), false);
    assert.equal(isNoneItemTextV1("None."), true);
  });
});

void describe("review1 Step 38: only options that can work at this stage", () => {
  void it("filters the checklist options before plan-final.md exists and publish-over-it before there is code", () => {
    assert.equal(optionAppliesAtStageV1("settleChecklistItem", "plan-low-review"), false);
    assert.equal(optionAppliesAtStageV1("settleChecklistItem", "impl-high-review"), true);
    assert.equal(optionAppliesAtStageV1("publishAnyway", "plan-low-review"), false);
    assert.equal(optionAppliesAtStageV1("publishAnyway", "impl"), false);
    assert.equal(optionAppliesAtStageV1("publishAnyway", "impl-low-review"), false);
    assert.equal(optionAppliesAtStageV1("publishAnyway", "impl-high-review"), false);
    assert.equal(optionAppliesAtStageV1("publishAnyway", "publish"), true);
    assert.equal(planFileNameForStageV1("plan-high-review"), "plan.md");
    assert.equal(planFileNameForStageV1("impl-high-review"), "plan-final.md");
  });

  void it("review1 item 3 replay: the owner-only card at the Plan stage offers no Tick/Exclude and recommends a forward option", async () => {
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    const folder = nodePath.join("/tmp", ".ensemble", "plan-stage-owner-only");
    const card = await postOwnerOnlyBlockersCardV1({
      taskFolderPath: folder,
      stage: "plan-low-review",
      blockerDescriptions: ["Narrowing needs an owner decision: the no-pop-ups rule is only partially delivered"],
    });
    assert.ok(card);
    const ids = card.options.map((o) => o.optionId);
    assert.deepEqual(ids, ["changePlan", "notNow"]);
    assert.equal(card.recommendation?.kind === "option" ? card.recommendation.optionId : undefined, "changePlan");
    const change = card.options[0]!;
    assert.match(change.consequence, /plan\.md/);
    assert.doesNotMatch(change.consequence, /plan-final\.md/);
  });

  void it("the plateau card at a plan stage opens plan.md, offers no publish override and does not recommend staying paused", () => {
    const description = "Narrowing needs an owner decision: scope of the no-pop-ups rule";
    const decision = buildEscalationDecisionV1(
      "plateau",
      "plan-low-review",
      "plateau",
      { canonicalId: "c", taskFolderPath: "/t" },
      {
        blockersCount: 1,
        primaryBlockerDescription: description,
        allBlockerDescriptions: [description],
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
        allBlockersNeedOwnerDecision: true,
      }
    );
    const ids = decision.options.map((o) => o.optionId);
    assert.ok(!ids.includes("publishAnyway"));
    const reconsider = decision.options.find((o) => o.optionId === "reconsiderRequirement");
    assert.ok(reconsider);
    assert.doesNotMatch(reconsider.consequence, /plan-final\.md/);
    assert.match(reconsider.consequence, /plan\.md/);
    assert.equal(reconsider.effect.kind === "command" ? (reconsider.effect.args?.[0] as { stage?: string }).stage : "", "plan-low-review");
    // The recommendation never points at an option that was filtered out.
    const recommended = decision.recommendation.kind === "option" ? decision.recommendation.optionId : undefined;
    assert.ok(ids.includes(recommended ?? ""));
  });

  void it("the same card at a code-review stage no longer offers the publish override (owner decision 2026-11-04)", () => {
    const description = "The authoritative server test run fails before collecting all suites";
    const build = (stage: "impl-high-review" | "impl-low-review" | "publish") => buildEscalationDecisionV1(
      "plateau",
      stage,
      "plateau",
      { canonicalId: "c", taskFolderPath: "/t" },
      {
        blockersCount: 1,
        primaryBlockerDescription: description,
        allBlockerDescriptions: [description],
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
      }
    );
    for (const stage of ["impl-high-review", "impl-low-review"] as const) {
      const decision = build(stage);
      assert.ok(!decision.options.some((o) => o.optionId === "publishAnyway"), stage);
      const recommended = decision.recommendation.kind === "option" ? decision.recommendation.optionId : undefined;
      assert.ok(decision.options.some((o) => o.optionId === recommended), "recommendation points at an offered option");
    }
    assert.ok(build("publish").options.some((o) => o.optionId === "publishAnyway"));
  });
});

void describe("review1 Step 39: standing blockers go to the owner, not to another round", () => {
  const withBlockers = (...lines: string[]): string =>
    ["Readiness: 7/10", "", "<!-- blockers:start -->", ...lines, "<!-- blockers:end -->"].join("\n");

  const folderUri = (name: string): vscode.Uri => vscode.Uri.file(nodePath.join("/tmp", "ensemble-step39", name));

  void it("returns the descriptions when every blocker is one a round cannot clear", async () => {
    const review = withBlockers(
      "- [completion] [environmental] The authoritative server test run fails before collecting all 86 suites",
      "- [completion] [task-fixable] Owner evidence needed: the effective publishVerificationCommands"
    );
    const found = await standingOnlyBlockerDescriptionsV1({
      folderUri: folderUri("all-standing"),
      stage: "impl-high-review",
      reviewText: review,
    });
    assert.equal(found?.length, 2);
    assert.match(found?.[0] ?? "", /86 suites/);
  });

  void it("returns nothing when any blocker is still a round's work, or there are none", async () => {
    const mixed = withBlockers(
      "- [completion] [environmental] The authoritative server test run fails before collecting all 86 suites",
      "- [architectural] [task-fixable] src/utils/saveGuard.ts lets a stale save overwrite a newer one"
    );
    assert.equal(
      await standingOnlyBlockerDescriptionsV1({ folderUri: folderUri("mixed"), stage: "impl-high-review", reviewText: mixed }),
      undefined
    );
    assert.equal(
      await standingOnlyBlockerDescriptionsV1({ folderUri: folderUri("none"), stage: "impl-high-review", reviewText: withBlockers() }),
      undefined
    );
  });

  void it("a declined blocker next to real work goes to the owner once while the run carries on", async () => {
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    // Card posting resolves the task from a path under `.ensemble/`, like the other tests in this file.
    const ensembleRoot = nodePath.join(os.tmpdir(), ".ensemble");
    await fs.mkdir(ensembleRoot, { recursive: true });
    const taskFolder = await fs.mkdtemp(nodePath.join(ensembleRoot, "step39-mixed-"));
    const declinedText = "The worker pool size cannot be raised without the owner's budget approval";
    await fs.writeFile(
      nodePath.join(taskFolder, "impl-summary.md"),
      ["## Remaining Blockers", `- ${declinedText} — declined: needs a human decision — it changes cost, not code`, ""].join("\n"),
      "utf8"
    );
    const review = withBlockers(
      `- [architectural] [task-fixable] ${declinedText}`,
      "- [architectural] [task-fixable] src/utils/saveGuard.ts lets a stale save overwrite a newer one"
    );
    const input = { folderUri: vscode.Uri.file(taskFolder), stage: "impl-high-review" as const, reviewText: review };
    const escalated = new Set<string>();

    // The vscode stub's workspace.fs is unimplemented; back reads with real disk for this test only.
    const fsTarget = vscode.workspace.fs as unknown as Record<string, unknown>;
    const originalRead = fsTarget.readFile;
    fsTarget.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
      fs.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
    try {
      // Not an all-standing set, so the stop path returns nothing...
      assert.equal(await standingOnlyBlockerDescriptionsV1(input), undefined);
      // ...but the declined blocker is still handed to the owner, by itself.
      const first = await escalateStandingAlongsideWorkV1(input, escalated);
      assert.equal(first.length, 1);
      assert.match(first[0]!.description, /worker pool/);

      const store = new WorkflowDecisionStoreV1(context.workspaceState);
      const pending = store
        .listPending(normalizePath(taskFolder))
        .filter((d) => d.decisionKey.startsWith("ownerOnlyBlockers:"));
      assert.equal(pending.length, 1);
      assert.doesNotMatch(pending[0]!.whatHappened, /Fast Forward stopped/);
      assert.match(pending[0]!.whatHappened, /carries on/);
      assert.doesNotMatch(pending[0]!.whyUserNeeded, /saveGuard/);

      // Raised once: a later review with the same blocker in the same run posts nothing new.
      assert.equal((await escalateStandingAlongsideWorkV1(input, escalated)).length, 0);
      assert.equal(
        store.listPending(normalizePath(taskFolder)).filter((d) => d.decisionKey.startsWith("ownerOnlyBlockers:")).length,
        1
      );
    } finally {
      fsTarget.readFile = originalRead;
    }
  });

  void it("escalates nothing alongside work when no blocker is standing or declined", async () => {
    __extensionContextV1TestOnly.set(makeExtensionContext());
    const review = withBlockers(
      "- [architectural] [task-fixable] src/utils/saveGuard.ts lets a stale save overwrite a newer one",
      "- [completion] [environmental] The authoritative server test run fails before collecting all 86 suites"
    );
    const found = await escalateStandingAlongsideWorkV1(
      { folderUri: folderUri("no-standing"), stage: "impl-high-review", reviewText: review },
      new Set()
    );
    // The environmental blocker has its own route (Step 48); Step 39 only takes standing and declined ones.
    assert.equal(found.length, 0);
  });
});

void describe("review1 Step 37: one card per owner-only blocker", () => {
  const REVIEW = [
    "Readiness: 6/10",
    "",
    "## Owner decisions needed",
    "",
    "### step-6-admission",
    "- id: step-6-admission",
    "- what this part of the plan is for: Token hand-off.",
    "- what is undecided or went wrong: Simpler design built instead.",
    "- options:",
    "  - Approve the design — records it",
    "  - Reject — build as planned",
    "- recommendation: Approve the design",
  ].join("\n");

  void it("posts no second 'every blocker needs you' card while the owner-decision card is waiting", async () => {
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    const folder = nodePath.join("/tmp", ".ensemble", "one-card-task");
    const block = parseOwnerDecisionsNeededV1(REVIEW)[0]!;
    const first = await postOwnerPlanDecisionCardV1({ taskFolderPath: folder, stage: "impl-high-review", block });
    assert.ok(first);

    const covering = await postOwnerOnlyBlockersCardV1({
      taskFolderPath: folder,
      stage: "impl-high-review",
      blockerDescriptions: ["Step 6 owner decision: token hand-off versus the simpler design"],
    });
    assert.equal(covering?.decisionId, first.decisionId);

    const store = new WorkflowDecisionStoreV1(context.workspaceState);
    const pending = store.listPending(normalizePath(folder));
    assert.equal(pending.filter((d) => d.decisionKey.startsWith("ownerOnlyBlockers:")).length, 0);
    assert.equal(pending.length, 1);
  });

  void it("an owner-decision card about one blocker does not hide the stop card for a different blocker", async () => {
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    const folder = nodePath.join("/tmp", ".ensemble", "per-blocker-task");
    const block = parseOwnerDecisionsNeededV1(REVIEW)[0]!;
    const asked = ownerBlockerIdentityV1("Step 6 owner decision: token hand-off versus the simpler design", "lineage-a");
    const first = await postOwnerPlanDecisionCardV1({
      taskFolderPath: folder,
      stage: "impl-high-review",
      block,
      blockerIdentities: [asked],
    });
    assert.ok(first);

    const covered = await postOwnerOnlyBlockersCardV1({
      taskFolderPath: folder,
      stage: "impl-high-review",
      blockerDescriptions: ["Reworded: the token hand-off question"],
      blockerLineageIds: ["lineage-a"],
    });
    assert.equal(covered?.decisionId, first.decisionId, "the same lineage id is the same blocker, reworded");

    const other = await postOwnerOnlyBlockersCardV1({
      taskFolderPath: folder,
      stage: "impl-high-review",
      blockerDescriptions: ["Owner evidence needed: a laptop file"],
      blockerLineageIds: ["lineage-b"],
    });
    assert.notEqual(other?.decisionId, first.decisionId, "a different owner-only blocker is not hidden");
    assert.ok(other?.decisionKey.startsWith("ownerOnlyBlockers:"));
  });

  void it("a plan-deviation card never counts as an owner-decision card for blockers", async () => {
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    const folder = nodePath.join("/tmp", ".ensemble", "deviation-not-blocker-task");
    const deviations = parsePlanDeviationsV1("## Plan deviations\n\n- Step 4: built with a queue instead of a lock.\n");
    assert.equal(deviations.length, 1);
    const deviationCard = await postOwnerPlanDecisionCardV1({
      taskFolderPath: folder,
      stage: "impl-high-review",
      block: deviations[0]!,
    });
    assert.ok(deviationCard);
    const stop = await postOwnerOnlyBlockersCardV1({
      taskFolderPath: folder,
      stage: "impl-high-review",
      blockerDescriptions: ["Owner evidence needed: a laptop file"],
    });
    assert.ok(stop?.decisionKey.startsWith("ownerOnlyBlockers:"), "the deviation card does not answer the blocker");
  });

  void it("attributes blockers to decision blocks by name, then pairs the unnamed ones in order", () => {
    const blocks = [
      { id: "alpha", planPurpose: "Alpha purpose" },
      { id: "beta", planPurpose: "Beta purpose" },
    ] as unknown as Parameters<typeof attributeBlockersToDecisionBlocksV1>[1];
    const blocker = (description: string, resolver = "owner-decision", lineage?: { kind: "same"; refId: string }) =>
      ({ category: "completion", resolver, description, ...(lineage ? { lineage } : {}) }) as unknown as Parameters<
        typeof attributeBlockersToDecisionBlocksV1
      >[0][number];
    const result = attributeBlockersToDecisionBlocksV1(
      [
        blocker("Beta purpose is unsettled", "owner-decision", { kind: "same", refId: "L1" }),
        blocker("Something nobody named"),
        blocker("A second thing nobody named"),
        blocker("A task-fixable defect", "task-fixable"),
      ],
      blocks
    );
    assert.deepEqual(result.get("beta"), [ownerBlockerIdentityV1("", "L1")]);
    assert.deepEqual(result.get("alpha"), [ownerBlockerIdentityV1("Something nobody named")]);
    assert.equal(
      [...result.values()].flat().includes(ownerBlockerIdentityV1("A second thing nobody named")),
      false,
      "an extra blocker stays unattributed so it gets its own card"
    );
  });

  void it("still posts the stop card when nothing else asks the owner at that stage", async () => {
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    const folder = nodePath.join("/tmp", ".ensemble", "stop-card-task");
    const card = await postOwnerOnlyBlockersCardV1({
      taskFolderPath: folder,
      stage: "impl-high-review",
      blockerDescriptions: ["Owner evidence needed: a laptop file"],
    });
    assert.ok(card?.decisionKey.startsWith("ownerOnlyBlockers:"));
  });

  void it("a pending stop card covers the blockers it asks about, and not a different one at the same stage", async () => {
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    const folder = nodePath.join("/tmp", ".ensemble", "lineage-task");
    const first = await postOwnerOnlyBlockersCardV1({
      taskFolderPath: folder,
      stage: "impl-high-review",
      blockerDescriptions: ["Owner evidence needed: a laptop file"],
    });
    assert.ok(first);
    assert.deepEqual(first.blockerIdentities?.length, 1);

    const same = await postOwnerOnlyBlockersCardV1({
      taskFolderPath: folder,
      stage: "impl-high-review",
      blockerDescriptions: ["Owner evidence needed:   a LAPTOP file"],
    });
    assert.equal(same?.decisionId, first.decisionId, "the same blocker (whitespace and case aside) reuses the card");

    const other = await postOwnerOnlyBlockersCardV1({
      taskFolderPath: folder,
      stage: "impl-high-review",
      blockerDescriptions: ["Owner decision needed: keep the pop-ups"],
    });
    assert.notEqual(other?.decisionId, first.decisionId, "a different owner-only blocker gets its own card");
  });
});

void describe("review1 Step 42: one card per top-level deviation (bugs6 item 17 replay)", () => {
  // The shape of runs/020-claude-cli-impl.md's "## Plan deviations": two real deviations (the first with three
  // sub-bullets) followed by three status notes.
  const RUN_020 = [
    "## Plan deviations",
    "",
    "- **Step 34 runs the checks through `collectCompletionLintPreview`, not `runPublishChecks`.**",
    "  - Why: `runPublishChecks` refuses any stage but Publish.",
    "  - What changed: it runs the same deterministic verification commands with no model call.",
    "  - Trade-off: no Publish freshness stamp is produced by this run.",
    "- **A recorded test report does not clear an item by itself.** A recorded report unlocks verification.",
    "- Backup retries: the earlier \"owner-clicked, no gate\" deviation is withdrawn.",
    "- Step 34's recorded `passed` value counts test files, not tests. This was already noted.",
    "- The plan's own deviations still stand.",
    "",
    "## Remaining Blockers",
    "",
    "- Steps 37-61 are unbuilt.",
  ].join("\n");

  void it("raises 2 cards, not 8: sub-bullets are the card's body and status notes raise nothing", () => {
    const cards = parsePlanDeviationsV1(RUN_020, { roundName: "Apply Review" });
    assert.equal(cards.length, 2);
    assert.match(cards[0]!.problem, /Why:/);
    assert.match(cards[0]!.problem, /Trade-off:/);
    assert.match(cards[0]!.planPurpose, /^Apply Review (built Step 34 differently from the plan|reports a departure)/);
  });

  void it("a section of only status notes raises no card", () => {
    const section = "## Plan deviations\n\n- The earlier deviation is withdrawn.\n- The plan's own deviations still stand.\n";
    assert.equal(parsePlanDeviationsV1(section).length, 0);
  });

  const SUMMARY_STEP_34 = [
    "## Plan deviations",
    "",
    "- **Step 34 runs the checks through `collectCompletionLintPreview`.**",
    "  - Why: `runPublishChecks` refuses any stage but Publish.",
  ].join("\n");
  const REVIEW_STEP_34 = [
    "Readiness: 7/10",
    "",
    "## Owner decisions needed",
    "",
    "### Step 34 checks runner",
    "- id: step-34-checks-runner",
    "- what this part of the plan is for: Step 34 runs Publish Checks once for the evidence gap.",
    "- what is undecided or went wrong: Step 34 uses the completion-lint preview, not the Publish Checks runner.",
    "- options:",
    "  - accept: Accept the direct checks (Recommended) — trade-off: no freshness stamp.",
    "  - keep: Keep the plan as written — trade-off: overlaps publish1.",
    "- recommendation: accept — simpler.",
  ].join("\n");

  void it("a review decision about the same step carries the options and folds the round's deviation card into it", async () => {
    __extensionContextV1TestOnly.set(makeExtensionContext());
    const folder = nodePath.join("/tmp", ".ensemble", "fold-review-first");
    const canonicalId = normalizePath(folder);
    // The round reports its deviation first: one card.
    const fromRound = await raisePlanDeviationCardsV1(folder, "impl-high-review", SUMMARY_STEP_34, { roundName: "Apply Review" });
    assert.equal(fromRound.length, 1);
    // The review then raises a decision about Step 34: the round's card is withdrawn, the review's card stays.
    const fromReview = await raiseOwnerDecisionCardsFromReviewV1(folder, "impl-high-review", REVIEW_STEP_34);
    assert.equal(fromReview.length, 1);
    const pending = listPendingWorkflowDecisionsForTaskV1(canonicalId).filter((card) =>
      card.decisionKey.startsWith("ownerPlanDecision:")
    );
    assert.deepEqual(pending.map((card) => card.decisionKey), ["ownerPlanDecision:step-34-checks-runner"]);
  });

  void it("a deviation card is withdrawn when a later round no longer reports it", async () => {
    __extensionContextV1TestOnly.set(makeExtensionContext());
    const folder = nodePath.join("/tmp", ".ensemble", "withdraw-no-longer-reported");
    const canonicalId = normalizePath(folder);
    const raised = await raisePlanDeviationCardsV1(folder, "impl-high-review", SUMMARY_STEP_34, { roundName: "Apply Review" });
    assert.equal(raised.length, 1);
    assert.equal(listPendingWorkflowDecisionsForTaskV1(canonicalId).length, 1);
    const next = await raisePlanDeviationCardsV1(folder, "impl-high-review", "## Plan deviations\n\nNone.\n", {
      roundName: "Apply Review",
    });
    assert.equal(next.length, 0);
    assert.equal(listPendingWorkflowDecisionsForTaskV1(canonicalId).length, 0, "the stale card is gone");
  });

  void it("a round's deviation about a step a pending review decision already covers raises no second card", async () => {
    __extensionContextV1TestOnly.set(makeExtensionContext());
    const folder = nodePath.join("/tmp", ".ensemble", "fold-deviation-second");
    const canonicalId = normalizePath(folder);
    await raiseOwnerDecisionCardsFromReviewV1(folder, "impl-high-review", REVIEW_STEP_34);
    const fromRound = await raisePlanDeviationCardsV1(folder, "impl-high-review", SUMMARY_STEP_34, { roundName: "Apply Review" });
    assert.equal(fromRound.length, 0, "the review's card about Step 34 already asks");
    const pending = listPendingWorkflowDecisionsForTaskV1(canonicalId).filter((card) =>
      card.decisionKey.startsWith("ownerPlanDecision:")
    );
    assert.equal(pending.length, 1);
  });
});
