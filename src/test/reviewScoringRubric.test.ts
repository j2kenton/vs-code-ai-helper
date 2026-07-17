import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import * as vscode from "vscode";
import { renderPromptTemplate } from "../utils/promptTemplates";
import { meetsAutoAdvanceThreshold, parseReadiness } from "../utils/reviewReadiness";

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
  });

  void describe("parseReadiness display bands", () => {
    void it("maps every score 0-10 to the expected band", () => {
      for (let score = 0; score <= 10; score++) {
        const result = parseReadiness(`Readiness: ${score}/10\nBody`);
        assert.strictEqual(result.score, score);
        assert.strictEqual(result.label, `${score}/10`);
        if (score >= 8) {
          assert.strictEqual(result.icon, "check");
          assert.strictEqual(result.colorKey, "charts.green");
        } else if (score >= 5) {
          assert.strictEqual(result.icon, "arrow-right");
          assert.strictEqual(result.colorKey, "charts.yellow");
        } else {
          assert.strictEqual(result.icon, "arrow-down");
          assert.strictEqual(result.colorKey, "charts.red");
        }
      }
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
