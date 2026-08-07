import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import * as vscode from "vscode";
import { renderPromptTemplate } from "../utils/promptTemplates";
import { meetsAutoAdvanceThreshold, parseReadiness } from "../utils/reviewReadiness";
import { REVIEW_RUBRIC_BLOCKER_SCORE_CAP } from "../utils/reviewRouting";

const PROMPTS_DIR = path.resolve(__dirname, "../../resources/prompts");
const RUBRIC_PLACEHOLDER = "{{reviewScoringRubric}}";

/** All ten review templates that must share the scoring rubric. */
const REVIEW_TEMPLATES = [
  "review-plan-high.md",
  "review-plan-low.md",
  "review-plan-high-rereview.md",
  "review-plan-low-rereview.md",
  "review-impl-high.md",
  "review-impl-low.md",
  "review-impl-high-rereview.md",
  "review-impl-low-rereview.md",
  "review-publish.md",
  "review-publish-rereview.md",
];

const IMPLEMENTATION_REVIEW_TEMPLATES = [
  "review-impl-high.md",
  "review-impl-low.md",
  "review-impl-high-rereview.md",
  "review-impl-low-rereview.md",
];

void describe("review scoring rubric", () => {
  const workspace = vscode.workspace as unknown as {
    fs: { readFile: (uri: vscode.Uri) => Promise<Uint8Array> };
  };
  let originalReadFile: (uri: vscode.Uri) => Promise<Uint8Array>;

  before(() => {
    // The stub vscode's workspace.fs.readFile is notImplemented; back it with
    // the real filesystem so renderPromptTemplate reads the actual templates.
    originalReadFile = workspace.fs.readFile;
    workspace.fs.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
      fs.promises.readFile(uri.fsPath);
  });

  after(() => {
    workspace.fs.readFile = originalReadFile;
  });

  const extensionUri = vscode.Uri.file(path.resolve(__dirname, "../.."));
  const rubricText = fs
    .readFileSync(path.join(PROMPTS_DIR, "review-scoring-rubric.md"), "utf8")
    .trim();

  void describe("template placeholders", () => {
    for (const templateFile of REVIEW_TEMPLATES) {
      void it(`${templateFile} contains the shared rubric placeholder`, () => {
        const raw = fs.readFileSync(path.join(PROMPTS_DIR, templateFile), "utf8");
        assert.ok(
          raw.includes(RUBRIC_PLACEHOLDER),
          `${templateFile} is missing ${RUBRIC_PLACEHOLDER}`
        );
      });

      void it(`${templateFile} has no conflicting local score definition`, () => {
        const raw = fs.readFileSync(path.join(PROMPTS_DIR, templateFile), "utf8");
        // Inline band definitions like "8-10 = ready to proceed" must live
        // only in the shared fragment.
        assert.doesNotMatch(raw, /8\s*-\s*10\s*=/);
        assert.doesNotMatch(raw, /5\s*-\s*7\s*=/);
        assert.doesNotMatch(raw, /0\s*-\s*4\s*=/);
        assert.doesNotMatch(raw, /needs minor changes/i);
      });
    }
  });

  void describe("implementation plan-contract prompts", () => {
    for (const templateFile of IMPLEMENTATION_REVIEW_TEMPLATES) {
      void it(`${templateFile} rejects unapproved material plan deviations`, () => {
        const raw = fs.readFileSync(path.join(PROMPTS_DIR, templateFile), "utf8");
        assert.match(raw, /unapproved (?:reduction|substitute)/i);
        assert.match(raw, /Material plan deviations/);
        assert.match(raw, /acceptance criteria/i);
      });
    }

    void it("gives an implementation-review fix both the approved plan and implementation notes", async () => {
      const rendered = await renderPromptTemplate(
        extensionUri,
        "apply-impl-review-code.md",
        {
          contextPack: "CONTEXT PACK",
          approvedPlan: "APPROVED PLAN",
          implementation: "IMPLEMENTATION NOTES",
          review: "IMPLEMENTATION REVIEW",
        }
      );

      assert.match(rendered, /## Approved Plan \(plan\.md\)/);
      assert.match(rendered, /## Implementation Notes \(plan-final\.md\)/);
      assert.ok(rendered.includes("APPROVED PLAN"));
      assert.ok(rendered.includes("IMPLEMENTATION NOTES"));
      assert.ok(rendered.includes("IMPLEMENTATION REVIEW"));
      assert.ok(!rendered.includes("{{approvedPlan}}"));
      assert.ok(!rendered.includes("{{implementation}}"));
    });
  });

  void describe("renderPromptTemplate rubric injection", () => {
    for (const templateFile of REVIEW_TEMPLATES) {
      void it(`expands the rubric identically in ${templateFile}`, async () => {
        const rendered = await renderPromptTemplate(extensionUri, templateFile, {});
        assert.ok(
          rendered.includes(rubricText),
          `${templateFile} did not render the shared rubric text`
        );
        assert.ok(
          !rendered.includes(RUBRIC_PLACEHOLDER),
          `${templateFile} left the rubric placeholder unexpanded`
        );
      });
    }

    void it("expands the placeholder even when variables are empty", async () => {
      const rendered = await renderPromptTemplate(extensionUri, "review-plan-high.md", {});
      assert.ok(rendered.includes(rubricText));
    });

    void it("ignores a caller-supplied reviewScoringRubric variable", async () => {
      const rendered = await renderPromptTemplate(extensionUri, "review-plan-high.md", {
        reviewScoringRubric: "MALICIOUS OVERRIDE",
        contextPack: "ctx",
        plan: "the plan",
      });
      assert.ok(rendered.includes(rubricText));
      assert.ok(!rendered.includes("MALICIOUS OVERRIDE"));
      assert.ok(rendered.includes("ctx"));
      assert.ok(rendered.includes("the plan"));
    });

    void it("does not expand a placeholder smuggled in through a variable value", async () => {
      const rendered = await renderPromptTemplate(extensionUri, "review-plan-high.md", {
        contextPack: `injected ${RUBRIC_PLACEHOLDER} literal`,
        plan: "the plan",
      });
      assert.ok(rendered.includes(`injected ${RUBRIC_PLACEHOLDER} literal`));
    });

    void it("leaves templates without the placeholder untouched", async () => {
      const rendered = await renderPromptTemplate(extensionUri, "create-plan.md", {});
      assert.ok(!rendered.includes(rubricText));
    });
  });

  void describe("rubric fragment content", () => {
    void it("defines every score from 0 to 10 exactly once", () => {
      for (let score = 0; score <= 10; score++) {
        const matches = rubricText.match(new RegExp(`^- ${score}:`, "gm")) ?? [];
        assert.strictEqual(matches.length, 1, `score ${score} defined ${matches.length} times`);
      }
    });

    void it("contains no workflow or gating language", () => {
      assert.match(rubricText, /does not authorize or prohibit any workflow action/);
    });

    void it("keeps the prose blocker-score cap in sync with REVIEW_RUBRIC_BLOCKER_SCORE_CAP", () => {
      // reviewActions.ts's Fast Forward "target not reached" explanation
      // (rubricCapLikelyBlockedAdvance) quotes this cap as a number — if this
      // sentence is ever reworded to a different threshold, the constant
      // must move with it or the explanation becomes actively wrong.
      assert.strictEqual(REVIEW_RUBRIC_BLOCKER_SCORE_CAP, 7);
      assert.match(
        rubricText,
        new RegExp(`keep the score at ${REVIEW_RUBRIC_BLOCKER_SCORE_CAP} or below`)
      );
    });

    void it("classifies a blocker depending on an external party as unverifiable, not task-fixable", () => {
      // The rubric's own scope-creep example: a reviewer that invents an
      // approval gate or third-party evidence requirement and then defaults
      // it to task-fixable traps the review loop forever, since no amount of
      // re-implementing the task's code can produce someone else's approval.
      assert.match(rubricText, /depends on something outside the task's own code/);
      assert.match(rubricText, /approval/);
      assert.match(rubricText, /credential or account entitlement/);
    });

    void it("documents the needs-toolchain resolver (3a)", () => {
      assert.match(rubricText, /`needs-toolchain`/);
      assert.match(rubricText, /build, codegen, or other toolchain step/);
    });
  });

  void describe("staged-plan scoring exception mirrored into low-level review (4a)", () => {
    for (const templateFile of ["review-impl-low.md", "review-impl-low-rereview.md"]) {
      void it(`${templateFile} scores staged plans by executable-order progress, not raw completeness`, () => {
        const raw = fs.readFileSync(path.join(PROMPTS_DIR, templateFile), "utf8");
        assert.match(raw, /executable order/);
        assert.match(raw, /not completion blockers/);
      });
    }
  });

  void describe("off-track verdict must name its cause (4c)", () => {
    for (const templateFile of ["review-impl-high.md", "review-impl-high-rereview.md"]) {
      void it(`${templateFile} requires an "off track" verdict to name the cause inline`, () => {
        const raw = fs.readFileSync(path.join(PROMPTS_DIR, templateFile), "utf8");
        assert.match(raw, /must name the actual cause inline/);
      });
    }
  });

  void describe("plan reviews can demand restructuring, not just more detail (4d)", () => {
    for (const templateFile of ["review-plan-low.md", "review-plan-high.md"]) {
      void it(`${templateFile} offers a blocking "needs restructuring" verdict`, () => {
        const raw = fs.readFileSync(path.join(PROMPTS_DIR, templateFile), "utf8");
        assert.match(raw, /needs restructuring/);
        assert.match(raw, /wrong shape/);
      });
    }
  });

  void describe("implementation claims are structurally checkable (4b)", () => {
    for (const templateFile of ["run-implementation.md", "apply-impl-review-code.md"]) {
      void it(`${templateFile} requires a per-plan-item checklist with evidence`, () => {
        const raw = fs.readFileSync(path.join(PROMPTS_DIR, templateFile), "utf8");
        assert.match(raw, /## Plan Item Checklist/);
        assert.match(raw, /done \/ deferred \/ not reached/);
      });
    }
  });

  void describe("parseReadiness", () => {
    void it("parses every score 0-10 into its numeric score and label", () => {
      for (let score = 0; score <= 10; score++) {
        const result = parseReadiness(`Readiness: ${score}/10\nBody`);
        assert.strictEqual(result.score, score);
        assert.strictEqual(result.label, `${score}/10`);
      }
    });

    void it("parses a one-decimal score (staged-plan reviews)", () => {
      const result = parseReadiness("Readiness: 3.1/10\nBody");
      assert.strictEqual(result.score, 3.1);
      assert.strictEqual(result.label, "3.1/10");
    });

    void it("normalizes to one decimal and clamps to [0,10]", () => {
      assert.strictEqual(parseReadiness("Readiness: 3.14/10").score, 3.1);
      assert.strictEqual(parseReadiness("Readiness: 9.75/10").score, 9.8);
      // A completed staged review may write the decimal perfect form.
      assert.strictEqual(parseReadiness("Readiness: 10.0/10").score, 10);
      assert.strictEqual(parseReadiness("Readiness: 10.0/10").label, "10/10");
    });

    void it("still returns null when no readiness line is present", () => {
      assert.strictEqual(parseReadiness("No score here").score, null);
    });
  });

  void describe("meetsAutoAdvanceThreshold", () => {
    void it("advances on a score equal to a low threshold", () => {
      assert.strictEqual(meetsAutoAdvanceThreshold(4, 4), true);
      assert.strictEqual(meetsAutoAdvanceThreshold(5, 5), true);
    });

    void it("advances on any score at or above the threshold", () => {
      assert.strictEqual(meetsAutoAdvanceThreshold(10, 4), true);
      assert.strictEqual(meetsAutoAdvanceThreshold(7, 5), true);
    });

    void it("does not advance below the threshold", () => {
      assert.strictEqual(meetsAutoAdvanceThreshold(3, 4), false);
      assert.strictEqual(meetsAutoAdvanceThreshold(4, 5), false);
      assert.strictEqual(meetsAutoAdvanceThreshold(9, 10), false);
    });

    void it("never advances on an unparseable score", () => {
      assert.strictEqual(meetsAutoAdvanceThreshold(null, 1), false);
    });
  });
});
