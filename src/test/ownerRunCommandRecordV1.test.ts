/**
 * review1 Step 50: "I ran it — record the result". An owner-run command is recorded against the blocker's lineage
 * id, attributed to the owner, and the review prompts tell a reviewer how to treat it.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { describe, it } from "node:test";

import {
  findQuotedCommandInTextV1,
  parseExitCodeInputV1,
  prepareOutputTailV1,
  recordOwnerRunCommandV1,
  OWNER_RUN_OUTPUT_TAIL_LIMIT_CHARS_V1,
} from "../commands/recordOwnerRunCommandV1";
import { recordOwnerTestRunV1 } from "../commands/recordOwnerTestRunV1";
import { blockerOwnerIdentityV1 } from "../utils/ownerCardCoverageV1";
import { OWNER_RUN_COMMAND_HEADING_V1, formatOwnerRunCommandAnswerV1 } from "../utils/ownerEvidenceV1";
import { buildOwnerEvidenceActionsOfferV1, buildEscalationDecisionV1 } from "../utils/reviewEscalation";
import { RECORD_OWNER_RUN_COMMAND_V1 } from "../utils/ownerEvidenceCommandAllowlistV1";
import {
  OWNER_RUN_FORM_COMMAND_QUESTION_ID_V1,
  OWNER_RUN_FORM_EXIT_CODE_QUESTION_ID_V1,
  OWNER_RUN_FORM_OUTPUT_QUESTION_ID_V1,
  buildOwnerRunFormV1,
  isOwnerRunFormV1,
  mergeOwnerRunFormValuesIntoEffectV1,
  readOwnerRunFormValuesV1,
} from "../utils/ownerRunFormV1";

const BLOCKER =
  "Owner evidence needed: the integration run `npm run test:integration` cannot run in this stage; run it and report the result";

function taskFolderWithTaskMd(): string {
  const folder = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "owner-run-"));
  nodeFs.writeFileSync(nodePath.join(folder, "task.md"), "# Task\n\n## Task Description\n\nDo the thing.\n");
  return folder;
}

void describe("review1 Step 50: recording a command the owner ran", () => {
  void it("writes the run under Owner evidence with attribution and the blocker's lineage id, covering no plan item", async () => {
    const folder = taskFolderWithTaskMd();
    try {
      const lineage = blockerOwnerIdentityV1({ description: BLOCKER });
      const result = await recordOwnerTestRunV1({
        taskFolderPath: folder,
        formId: "f1",
        command: "npm run test:integration",
        exitCode: 0,
        summary: "owner ran it",
        itemTexts: [],
        blockerLineageId: lineage,
        blockerText: BLOCKER,
        outputTail: "62 tests passed\nexit 0",
      });
      assert.equal(result.ok, true);
      const taskMd = nodeFs.readFileSync(nodePath.join(folder, "task.md"), "utf8");
      assert.match(taskMd, /^## Owner evidence/m);
      assert.ok(taskMd.includes(OWNER_RUN_COMMAND_HEADING_V1));
      assert.ok(taskMd.includes(`Blocker lineage id: ${lineage}`));
      assert.match(taskMd, /Command: npm run test:integration/);
      assert.match(taskMd, /Exit code: 0 \(passed\)/);
      assert.match(taskMd, /Recorded by the owner at: \d{4}-\d{2}-\d{2}T/);
      assert.match(taskMd, /62 tests passed/);
      // The blocker it answers is quoted, as every Owner evidence entry does.
      assert.match(taskMd, /Blocker answered:\n> Owner evidence needed: the integration run/);
    } finally {
      nodeFs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("still requires a plan item when no blocker is named, and a blocker text when a lineage id is", async () => {
    const folder = taskFolderWithTaskMd();
    try {
      const noItems = await recordOwnerTestRunV1({ taskFolderPath: folder, formId: "f", command: "x", exitCode: 0, summary: "", itemTexts: [] });
      assert.equal(noItems.ok, false);
      const noText = await recordOwnerTestRunV1({
        taskFolderPath: folder, formId: "f", command: "x", exitCode: 0, summary: "", itemTexts: [], blockerLineageId: "abc",
      });
      assert.equal(noText.ok, false);
      assert.doesNotMatch(nodeFs.readFileSync(nodePath.join(folder, "task.md"), "utf8"), /Owner evidence/);
    } finally {
      nodeFs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("the option posts the chat form; the form's values record the run and re-run the review; a blank or invalid form records nothing", async () => {
    const folder = taskFolderWithTaskMd();
    try {
      const forms: Array<string | undefined> = [];
      let reruns = 0;
      const deps = {
        postForm: (_arg: unknown, suggestedCommand: string | undefined) => {
          forms.push(suggestedCommand);
          return Promise.resolve();
        },
        record: recordOwnerTestRunV1,
        rerunReview: () => {
          reruns += 1;
          return Promise.resolve(true);
        },
      };
      const arg = { taskFolderPath: folder, stage: "impl-high-review" as const, blocker: BLOCKER, blockerLineageId: "lineage-1" };

      // First call: no values yet, so the chat form is posted (with the command the blocker quotes) and nothing is recorded.
      const asked = await recordOwnerRunCommandV1(arg, deps);
      assert.equal((asked as { outcome: string }).outcome, "done");
      assert.deepEqual(forms, ["npm run test:integration"]);
      assert.equal(reruns, 0);

      const blank = await recordOwnerRunCommandV1({ ...arg, command: "  ", exitCode: "0" }, deps);
      assert.deepEqual(blank, { outcome: "refused", message: "Nothing was recorded: no command was given." });
      const badExit = await recordOwnerRunCommandV1({ ...arg, command: "npm run test:integration", exitCode: "banana" }, deps);
      assert.equal((badExit as { outcome: string }).outcome, "refused");
      assert.equal(reruns, 0);
      assert.doesNotMatch(nodeFs.readFileSync(nodePath.join(folder, "task.md"), "utf8"), /Owner-run command/);

      const done = await recordOwnerRunCommandV1(
        { ...arg, command: "npm run test:integration", exitCode: "1", outputTail: "FAIL orders\nexit 1" },
        deps
      );
      assert.equal((done as { outcome: string }).outcome, "done");
      assert.equal(reruns, 1);
      const taskMd = nodeFs.readFileSync(nodePath.join(folder, "task.md"), "utf8");
      assert.match(taskMd, /Exit code: 1 \(failed\)/);
      assert.match(taskMd, /Blocker lineage id: lineage-1/);
    } finally {
      nodeFs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("the chat form carries the blocker's identity and merges the typed values into the record effect", () => {
    const form = buildOwnerRunFormV1(
      { taskFolderPath: "/ws/.ensemble/t", stage: "impl-high-review", blocker: BLOCKER, blockerLineageId: "lineage:abc" },
      RECORD_OWNER_RUN_COMMAND_V1,
      "npm run test:integration"
    );
    assert.equal(isOwnerRunFormV1(form.questions), true);
    assert.deepEqual(form.questions.map((q) => q.kind), ["text", "text", "text", "singleChoice"]);
    const choice = form.questions[3]!;
    assert.equal(choice.kind, "singleChoice");
    const optionId = choice.kind === "singleChoice" ? choice.options[0]!.optionId : "";
    const merged = mergeOwnerRunFormValuesIntoEffectV1(
      form.optionEffects[optionId]!,
      readOwnerRunFormValuesV1([
        { questionId: OWNER_RUN_FORM_COMMAND_QUESTION_ID_V1, kind: "text", state: "answered", value: " npm run test:integration " },
        { questionId: OWNER_RUN_FORM_EXIT_CODE_QUESTION_ID_V1, kind: "text", state: "answered", value: "0" },
        { questionId: OWNER_RUN_FORM_OUTPUT_QUESTION_ID_V1, kind: "text", state: "answered", value: "   " },
      ] as never)
    );
    assert.equal(merged.kind, "command");
    if (merged.kind === "command") {
      const arg = merged.args?.[0] as Record<string, unknown>;
      assert.equal(arg.blockerLineageId, "lineage:abc");
      assert.equal(arg.command, "npm run test:integration");
      assert.equal(arg.exitCode, "0");
      assert.equal("outputTail" in arg, false);
    }
    assert.equal(isOwnerRunFormV1([{ questionId: "other", kind: "text", prompt: "x", required: false } as never]), false);
  });

  void it("a reviewer-declared lineage id reaches both option paths, so a reworded re-raise still finds the record", () => {
    const lineage = blockerOwnerIdentityV1({ description: BLOCKER, lineage: { kind: "same", refId: "11111111-1111" } as never });
    assert.equal(lineage, "lineage:11111111-1111");
    assert.notEqual(lineage, blockerOwnerIdentityV1({ description: BLOCKER }));

    const offer = buildOwnerEvidenceActionsOfferV1("/ws/.ensemble/t", "impl-high-review", BLOCKER, lineage);
    const first = offer.question.kind === "singleChoice" ? offer.question.options[0]! : undefined;
    const evidenceEffect = offer.optionEffects[first!.optionId]!;
    assert.equal(
      evidenceEffect.kind === "command" ? (evidenceEffect.args?.[0] as { blockerLineageId: string }).blockerLineageId : undefined,
      lineage
    );

    const target = { canonicalId: "t", taskFolderPath: "/ws/.ensemble/t" };
    const card = buildEscalationDecisionV1("plateau", "impl-high-review", "r", target, {
      blockersCount: 1,
      primaryBlockerDescription: BLOCKER,
      allBlockerDescriptions: [BLOCKER],
      needsToolchainBlockers: [BLOCKER],
      needsToolchainBlockerIdentities: [lineage],
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
    } as never);
    const plateauEffect = card.options.find((o) => o.optionId === "recordOwnerRun")?.effect;
    assert.equal(
      plateauEffect?.kind === "command" ? (plateauEffect.args?.[0] as { blockerLineageId: string }).blockerLineageId : undefined,
      lineage
    );
  });

  void it("helpers: exit code parsing, quoted command, bounded redacted output tail", () => {
    assert.equal(parseExitCodeInputV1(" 0 "), 0);
    assert.equal(parseExitCodeInputV1("-1"), -1);
    assert.equal(parseExitCodeInputV1("1.5"), undefined);
    assert.equal(parseExitCodeInputV1(undefined), undefined);
    assert.equal(findQuotedCommandInTextV1(BLOCKER), "npm run test:integration");
    assert.equal(findQuotedCommandInTextV1("see `README`"), undefined);
    const long = prepareOutputTailV1("x".repeat(OWNER_RUN_OUTPUT_TAIL_LIMIT_CHARS_V1 + 500));
    assert.match(long, /^\[earlier output cut/);
    assert.ok(long.length < OWNER_RUN_OUTPUT_TAIL_LIMIT_CHARS_V1 + 200);
    assert.ok(formatOwnerRunCommandAnswerV1({ command: "c", exitCode: 0, recordedAt: "2026-11-04T10:00:00.000Z" }).startsWith(OWNER_RUN_COMMAND_HEADING_V1));
  });
});

void describe("review1 Step 50: where the option is offered, and what a review is told", () => {
  void it("an owner-evidence request always offers 'I ran it — record the result', beside 'Run it for me' when a command is allowlisted", () => {
    const plain = buildOwnerEvidenceActionsOfferV1("/ws/.ensemble/t", "impl-high-review", BLOCKER);
    assert.equal(plain.question.kind, "singleChoice");
    const plainLabels = plain.question.kind === "singleChoice" ? plain.question.options.map((o) => o.label) : [];
    assert.deepEqual(plainLabels, ["I ran it — record the result", "I'll paste it myself"]);
    const record = plain.question.kind === "singleChoice" ? plain.question.options[0]! : undefined;
    const effect = plain.optionEffects[record!.optionId]!;
    assert.equal(effect.kind, "command");
    if (effect.kind === "command") {
      assert.equal(effect.command, RECORD_OWNER_RUN_COMMAND_V1);
      const arg = effect.args?.[0] as { blockerLineageId: string; blocker: string };
      assert.equal(arg.blockerLineageId, blockerOwnerIdentityV1({ description: BLOCKER }));
      assert.equal(arg.blocker, BLOCKER);
    }

    const allowlisted = buildOwnerEvidenceActionsOfferV1(
      "/ws/.ensemble/t",
      "impl-high-review",
      "Owner evidence needed: run `claude --version` and report the version"
    );
    const labels = allowlisted.question.kind === "singleChoice" ? allowlisted.question.options.map((o) => o.label) : [];
    assert.equal(labels.length, 3);
    assert.match(labels[0]!, /^Run it for me/);
    assert.equal(labels[1], "I ran it — record the result");
    assert.equal(labels[2], "I'll paste it myself");
  });

  void it("the plateau card offers it for a needs-toolchain blocker and not otherwise", () => {
    const context = (needsToolchainBlockers: string[]) => ({
      blockersCount: 1,
      primaryBlockerDescription: needsToolchainBlockers[0] ?? "x",
      allBlockerDescriptions: needsToolchainBlockers.length ? needsToolchainBlockers : ["x"],
      needsToolchainBlockers,
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
    });
    const target = { canonicalId: "t", taskFolderPath: "/ws/.ensemble/t" };
    const withIt = buildEscalationDecisionV1("plateau", "impl-high-review", "r", target, context(["Run `npm run test:integration`; the stage cannot run it"]));
    const option = withIt.options.find((o) => o.optionId === "recordOwnerRun");
    assert.ok(option);
    assert.equal(option.label, "I ran it — record the result");
    assert.equal(option.effect.kind === "command" ? option.effect.command : undefined, RECORD_OWNER_RUN_COMMAND_V1);
    const without = buildEscalationDecisionV1("plateau", "impl-high-review", "r", target, context([]));
    assert.ok(!without.options.some((o) => o.optionId.startsWith("recordOwnerRun")));
  });

  void it("the shared rubric tells every review how to read an owner-run record, and a re-raise must cite it", () => {
    const rubric = nodeFs.readFileSync(nodePath.resolve(__dirname, "../../resources/prompts/review-scoring-rubric.md"), "utf8");
    assert.ok(rubric.includes(OWNER_RUN_COMMAND_HEADING_V1));
    assert.match(rubric, /Blocker lineage id/);
    assert.match(rubric, /it is a disagreement: say so in the blocker text, cite the record \(command, exit code, time\)/);
    for (const prompt of ["review-impl-high.md", "review-impl-low.md", "review-plan-high.md"]) {
      const text = nodeFs.readFileSync(nodePath.resolve(__dirname, "../../resources/prompts", prompt), "utf8");
      assert.ok(text.includes("{{reviewScoringRubric}}"), prompt);
    }
  });
});
