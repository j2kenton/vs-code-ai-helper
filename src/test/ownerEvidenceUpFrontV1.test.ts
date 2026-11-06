/**
 * review1 Step 44: owner evidence gathered before Implementation, and the "Ensemble facts" section the context
 * pack carries so reviews do not file owner evidence for what Ensemble already knows.
 */
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { describe, it } from "node:test";
import {
  buildOwnerEvidenceUpFrontQuestionsV1,
  collectOwnerEvidenceFormAnswersV1,
  isOwnerEvidenceUpFrontFormV1,
  listOwnerEvidenceStepsV1,
  listUnansweredOwnerEvidenceStepsAfterV1,
  listUnansweredOwnerEvidenceStepsV1,
} from "../utils/ownerEvidenceUpFrontV1";
import { validateStructuredAnswersV1, type StructuredAnswerV1 } from "../types/structuredQuestionV1";
import { formatEnsembleFactsSectionV1, buildEnsembleFactsSectionV1, type EnsembleFactsV1 } from "../utils/ensembleFactsV1";
import { initReviewEscalationChat, postOwnerEvidenceUpFrontQuestionV1 } from "../utils/reviewEscalation";

const PLAN = [
  "## Part 1",
  "",
  "Owner evidence: this paragraph only explains the rule and is not a plan item.",
  "",
  "- [ ] Step 1: Probe the provider. Owner evidence: run `claude --model x -p ok` and paste the result",
  "- [ ] Step 2: Build the thing.",
  "  - Owner evidence: the exact name of your Azure region",
  "- [x] Step 3: Already done. Owner evidence: the account id",
  "- [ ] Step 4: Excluded hand-off. Owner evidence: a screenshot <!-- ensemble:excluded -->",
].join("\n");

void describe("review1 Step 44: owner evidence steps in the plan", () => {
  void it("lists only open items that ask for owner evidence, on their own line or nested", () => {
    const steps = listOwnerEvidenceStepsV1(PLAN);
    assert.deepEqual(
      steps.map((step) => step.evidence),
      ["run claude --model x -p ok and paste the result", "the exact name of your Azure region"]
    );
    assert.match(steps[0]!.itemText, /^Step 1:/);
    assert.match(steps[1]!.itemText, /^Step 2:/);
  });

  void it("an answer quoted under ## Owner evidence in task.md settles that step only", () => {
    const taskMd = [
      "# Task",
      "",
      "## Owner evidence",
      "",
      "### 2026-11-04",
      "",
      "Blocker answered:",
      "> run `claude --model x -p ok` and paste the result",
      "",
      "```",
      "ok",
      "```",
      "",
      "## Draft with AI",
    ].join("\n");
    const left = listUnansweredOwnerEvidenceStepsV1(PLAN, taskMd);
    assert.equal(left.length, 1);
    assert.match(left[0]!.evidence, /Azure region/);
    assert.equal(listUnansweredOwnerEvidenceStepsV1(PLAN, "# Task\n").length, 2);
  });

  void it("the form has one optional text field for each step, and carries the evidence text task.md will quote", () => {
    const questions = buildOwnerEvidenceUpFrontQuestionsV1(listOwnerEvidenceStepsV1(PLAN));
    assert.equal(questions.length, 2, "a field for each step");
    assert.ok(isOwnerEvidenceUpFrontFormV1(questions));
    assert.ok(questions.every((q) => q.kind === "text" && !q.required));
    assert.match(questions[0]!.prompt, /^Step 1:/);
    assert.match(questions[1]!.prompt, /^Step 2:/);
    assert.match(questions[0]!.helpText ?? "", /^run claude .* and paste the result$/);
    assert.equal(questions[1]!.helpText, "the exact name of your Azure region");
  });

  void it("answered fields become owner-evidence entries for their own step; skipped and blank fields are left for later", () => {
    const questions = buildOwnerEvidenceUpFrontQuestionsV1(listOwnerEvidenceStepsV1(PLAN));
    const answers: StructuredAnswerV1[] = [
      { questionId: questions[0]!.questionId, kind: "text", state: "answered", value: "  ok  " },
      { questionId: questions[1]!.questionId, kind: "text", state: "skipped" },
    ];
    assert.ok(validateStructuredAnswersV1(questions, answers).ok, "an optional field may be skipped");
    const collected = collectOwnerEvidenceFormAnswersV1(questions, answers);
    assert.equal(collected.length, 1);
    assert.equal(collected[0]!.answer, "ok");
    assert.equal(collected[0]!.blocker, questions[0]!.helpText);
    const blank: StructuredAnswerV1[] = [
      { questionId: questions[0]!.questionId, kind: "text", state: "answered", value: "   " },
      { questionId: questions[1]!.questionId, kind: "text", state: "answered", value: "westeurope" },
    ];
    assert.deepEqual(
      collectOwnerEvidenceFormAnswersV1(questions, blank).map((entry) => entry.blocker),
      ["the exact name of your Azure region"]
    );
  });

  void it("a form never holds more than the question limit; the rest are asked once these are answered", () => {
    const many = Array.from({ length: 20 }, (_, i) => `- [ ] Step ${i + 1}: Probe. Owner evidence: fact number ${i + 1}`).join("\n");
    assert.equal(buildOwnerEvidenceUpFrontQuestionsV1(listOwnerEvidenceStepsV1(many)).length, 16);
  });

  void it("the continuation asks the steps after the last field shown, and never re-asks a skipped one", () => {
    const many = Array.from({ length: 20 }, (_, i) => `- [ ] Step ${i + 1}: Probe. Owner evidence: fact number ${i + 1}`).join("\n");
    const firstForm = buildOwnerEvidenceUpFrontQuestionsV1(listOwnerEvidenceStepsV1(many));
    const lastShown = firstForm[firstForm.length - 1]!.helpText!;
    assert.equal(lastShown, "fact number 16");
    // The owner answered nothing in the first form: fields 1-16 are still unanswered, but only 17-20 follow.
    const rest = listUnansweredOwnerEvidenceStepsAfterV1(many, "", lastShown);
    assert.deepEqual(rest.map((step) => step.evidence), ["fact number 17", "fact number 18", "fact number 19", "fact number 20"]);
    // Answered steps are left out of the continuation too.
    const taskMd = "## Owner evidence\n\n- fact number 18: ok\n";
    assert.deepEqual(
      listUnansweredOwnerEvidenceStepsAfterV1(many, taskMd, lastShown).map((step) => step.evidence),
      ["fact number 17", "fact number 19", "fact number 20"]
    );
    assert.deepEqual(listUnansweredOwnerEvidenceStepsAfterV1(many, "", "fact number 20"), []);
  });
});

void describe("review1 Step 44: the up-front question is posted once, without blocking", () => {
  void it("posts one non-blocking question per distinct set of steps, and nothing once answered", async () => {
    const asked: Array<{ fields: number; blocking: boolean | undefined }> = [];
    const target: Parameters<typeof initReviewEscalationChat>[0] = {
      askInteraction: (
        question: { questions: readonly unknown[] },
        _forceOpen?: boolean,
        notify?: { blocking?: boolean }
      ) => {
        asked.push({ fields: question.questions.length, blocking: notify?.blocking });
        return Promise.resolve();
      },
    } as unknown as Parameters<typeof initReviewEscalationChat>[0];
    initReviewEscalationChat(target);
    const store = new Map<string, unknown>();
    const memento = {
      get: <T>(key: string) => store.get(key) as T | undefined,
      update: (key: string, value: unknown) => {
        store.set(key, value);
        return Promise.resolve();
      },
    };
    const options = {
      folderUri: vscode.Uri.file("/tmp/.ensemble/up-front-task"),
      stage: "impl" as const,
      planText: PLAN,
      taskMd: "# Task\n",
      memento,
    };
    assert.equal(await postOwnerEvidenceUpFrontQuestionV1(options), true);
    assert.equal(asked.length, 1);
    assert.equal(asked[0]!.fields, 2, "one field for each unanswered step");
    assert.equal(asked[0]!.blocking, false, "Implementation does not wait for the answer");
    assert.equal(await postOwnerEvidenceUpFrontQuestionV1(options), false, "the same steps are asked once");
    assert.equal(await postOwnerEvidenceUpFrontQuestionV1({ ...options, planText: "- [ ] Step 1: Nothing needed" }), false);
    assert.equal(asked.length, 1);
  });
});

void describe("review1 Step 44: the Ensemble facts section", () => {
  const facts: EnsembleFactsV1 = {
    publishCommands: { values: [], source: "no value in the workspace-folder, workspace or user settings" },
    autoDetectedPublishCommands: ["pnpm run verify"],
    windowKind: "single-folder",
    folderCount: 1,
    ensembleVersion: "1.18.0",
    providerCliMajors: { claude: 2, codex: 0 },
  };

  void it("states every fact and tells the reviewer not to file owner evidence for them", () => {
    const text = formatEnsembleFactsSectionV1(facts).join("\n");
    assert.match(text, /^## Ensemble facts/);
    assert.match(text, /not set .*auto-detect/);
    assert.match(text, /auto-detection would select: `pnpm run verify`/);
    assert.match(text, /Window: single folder/);
    assert.match(text, /Ensemble version: 1\.18\.0/);
    assert.match(text, /claude 2, codex 0/);
    assert.match(text, /Do not file an owner-evidence or owner-decision blocker/);
  });

  void it("names where a configured value came from and which commands take precedence", () => {
    const text = formatEnsembleFactsSectionV1({
      ...facts,
      publishCommands: { values: ["npm test"], source: "the workspace settings" },
      windowKind: "multi-root",
      folderCount: 2,
    }).join("\n");
    assert.match(text, /effective, from the workspace settings\): `npm test`/);
    assert.match(text, /the configured commands above take precedence/);
    assert.match(text, /multi-root \(2 folders\)/);
  });

  void it("builds for a live workspace without throwing", () => {
    const lines = buildEnsembleFactsSectionV1(vscode.Uri.file("/tmp"));
    assert.ok(lines.length === 0 || lines[0] === "## Ensemble facts");
  });
});
