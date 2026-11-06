/**
 * review1 Steps 48 and 49: the card for a failure no in-plan round can clear, and the read-only diagnostic round
 * behind "Investigate it for me".
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { describe, it } from "node:test";

import {
  describeBrokenCheckLeadV1,
  extractEnvironmentalFailureEvidenceV1,
  formatEnvironmentReportV1,
} from "../utils/environmentalFailureEvidenceV1";
import {
  clearInvestigationRequestV1,
  collectProtectedFilesV1,
  formatProtectedFilesV1,
  investigationTemplateVariablesV1,
  nextDiagnosisPathV1,
  parseDiagnosisFilesToChangeV1,
  peekInvestigationRequestV1,
  setInvestigationRequestV1,
} from "../utils/investigateFailureV1";
import { buildEnvironmentalFailureDecisionV1 } from "../utils/reviewEscalation";
import { decideReviewRoute } from "../utils/reviewRouting";
import type { ReviewBlocker } from "../utils/reviewReadiness";

const TARGET = { canonicalId: "task-x", taskFolderPath: "/ws/.ensemble/task-x", taskName: "chat" };

// The jester-shaped blocker: the authoritative test run dies before collecting any suite.
const JESTER_BLOCKERS = [
  {
    resolver: "environmental-fixable",
    description: "The authoritative server test run still fails before collecting all 86 suites",
  },
  {
    resolver: "environmental-fixable",
    origin: "mechanical" as const,
    description:
      "`pnpm --filter server test` failed (exit 1) — generated mechanically from Verified Checks — output:\n```\n" +
      "RUN  v2.1.8 /ws/apps/server\n" +
      "stdout | integration/orders.integration.test.ts\n" +
      "Error: connect ECONNREFUSED 127.0.0.1:5432\n" +
      "Test Files  0 collected\n" +
      "```",
  },
];
const ENVIRONMENT = {
  cwd: "C:/ws/apps/server",
  packageManager: "pnpm 9.1.0",
  envVarNames: ["PATH", "DATABASE_URL", "ELECTRON_RUN_AS_NODE"],
};

void describe("review1 Step 48: the evidence an unfixable-failure card shows", () => {
  void it("takes the failing command, exit code, where it stopped and the output tail from the mechanical blocker", () => {
    const evidence = extractEnvironmentalFailureEvidenceV1({ blockers: JESTER_BLOCKERS, environment: ENVIRONMENT });
    assert.equal(evidence.failingCommand, "pnpm --filter server test");
    assert.equal(evidence.exitCode, 1);
    assert.match(evidence.stoppedAt ?? "", /ECONNREFUSED/);
    assert.match(evidence.outputTail ?? "", /Test Files {2}0 collected/);
    assert.equal(evidence.fixable, true);
    assert.equal(evidence.environmentalDescriptions.length, 2);
  });

  void it("prefers the recorded Verified Checks failure, which carries the full output", () => {
    const evidence = extractEnvironmentalFailureEvidenceV1({
      blockers: JESTER_BLOCKERS,
      failedChecks: [{ command: "pnpm test", exitCode: 2, output: `${"x\n".repeat(2000)}Error: boom` }],
    });
    assert.equal(evidence.failingCommand, "pnpm test");
    assert.equal(evidence.exitCode, 2);
    assert.ok((evidence.outputTail ?? "").length <= 805);
    assert.match(evidence.outputTail ?? "", /boom$/);
  });

  void it("reports Ensemble's environment by variable NAME and cwd, never a value", () => {
    const report = formatEnvironmentReportV1(ENVIRONMENT);
    assert.match(report, /Working directory as spawned: C:\/ws\/apps\/server/);
    assert.match(report, /`DATABASE_URL`/);
    assert.doesNotMatch(report, /postgres:\/\//);
    assert.match(formatEnvironmentReportV1(undefined), /did not record the environment/);
  });

  void it("leads a notification with the broken check, and has no lead when nothing is environmental", () => {
    const lead = describeBrokenCheckLeadV1(extractEnvironmentalFailureEvidenceV1({ blockers: JESTER_BLOCKERS }));
    assert.match(lead ?? "", /^A check is failing outside the plan's own work: `pnpm --filter server test`/);
    assert.equal(
      describeBrokenCheckLeadV1(extractEnvironmentalFailureEvidenceV1({ blockers: [{ resolver: "task-fixable", description: "x" }] })),
      undefined
    );
  });

  void it("the first review whose only blockers are environmental escalates at once, with no plateau", () => {
    const blockers: ReviewBlocker[] = [
      { category: "completion", resolver: "environmental-fixable", description: "The server test run dies before collecting any suite" },
    ];
    const route = decideReviewRoute({ score: 7, threshold: 9, blockers, plateaued: false, secondOpinionTriedThisPlateau: false });
    assert.equal(route.route, "escalate");
  });
});

void describe("review1 Step 48: the environmental-failure card", () => {
  const evidence = extractEnvironmentalFailureEvidenceV1({ blockers: JESTER_BLOCKERS, environment: ENVIRONMENT });

  void it("offers Investigate, look myself and accept; recommends Investigate when the failure is fixable", () => {
    const card = buildEnvironmentalFailureDecisionV1({
      stage: "impl-high-review",
      reason: "Every remaining blocker is outside automation's control",
      target: TARGET,
      evidence,
    });
    assert.deepEqual(
      card.options.map((o) => o.label),
      ["Investigate it for me", "I'll look at it myself", "Accept it as environmental and continue"]
    );
    assert.equal(card.recommendation.kind, "option");
    assert.equal(card.recommendation.kind === "option" ? card.recommendation.optionId : undefined, "investigateFailure");
    // The failing check and Ensemble's environment are on the card.
    const shown = (card.evidence ?? []).map((e) => e.detail).join("\n");
    assert.match(shown, /pnpm --filter server test/);
    assert.match(shown, /ECONNREFUSED/);
    assert.match(shown, /`DATABASE_URL`/);
    assert.match(shown, /C:\/ws\/apps\/server/);
  });

  void it("Investigate dispatches the diagnostic round with the failure and the environment, and never offers a stage move that is not the accept option", () => {
    const card = buildEnvironmentalFailureDecisionV1({
      stage: "impl-high-review",
      reason: "r",
      target: TARGET,
      evidence,
    });
    const investigate = card.options.find((o) => o.optionId === "investigateFailure")!;
    assert.equal(investigate.effect.kind, "command");
    if (investigate.effect.kind === "command") {
      assert.equal(investigate.effect.command, "vs-code-ai-helper.resumeAndApplyCurrentStageAction");
      const arg = investigate.effect.args?.[0] as { taskFolderPath: string; investigate: { failure: string; environmentReport: string } };
      assert.equal(arg.taskFolderPath, TARGET.taskFolderPath);
      assert.match(arg.investigate.failure, /pnpm --filter server test/);
      assert.match(arg.investigate.environmentReport, /DATABASE_URL/);
    }
    assert.match(investigate.consequence, /enforced read-only mode, so it cannot change any of your files/);
    assert.match(investigate.consequence, /cannot run tests itself/);
    assert.ok(!investigate.disabled);
    const accept = card.options.find((o) => o.label.startsWith("Accept it as environmental"))!;
    assert.match(accept.consequence, /will gate Publish/);
  });

  void it("says why Investigate is unavailable when no model in the chain can run read-only, and never recommends it", () => {
    const card = buildEnvironmentalFailureDecisionV1({
      stage: "impl-high-review",
      reason: "r",
      target: TARGET,
      evidence,
      investigateUnavailableReason: "none of the models in Implementation's chain (Cline) can run in a mode that stops the provider editing files",
    });
    const investigate = card.options.find((o) => o.optionId === "investigateFailure")!;
    assert.equal(investigate.disabled, true);
    assert.match(investigate.consequence, /^Not available: none of the models in Implementation's chain \(Cline\)/);
    assert.notEqual(card.recommendation.kind === "option" ? card.recommendation.optionId : undefined, "investigateFailure");
  });

  void it("recommends nothing over the owner's judgement when no code change resolves it", () => {
    const unfixable = extractEnvironmentalFailureEvidenceV1({
      blockers: [{ resolver: "environmental", description: "The provider quota is exhausted until tomorrow" }],
    });
    const card = buildEnvironmentalFailureDecisionV1({ stage: "impl-high-review", reason: "r", target: TARGET, evidence: unfixable });
    assert.equal(card.recommendation.kind, "none");
  });

  void it("offers no investigation at a stage that has no Apply Review to run it", () => {
    const card = buildEnvironmentalFailureDecisionV1({ stage: "plan-high-review", reason: "r", target: TARGET, evidence });
    assert.ok(!card.options.some((o) => o.optionId === "investigateFailure"));
    // A recommendation never points at an option that is not on the card.
    if (card.recommendation.kind === "option") {
      const recommendedId = card.recommendation.optionId;
      assert.ok(card.options.some((o) => o.optionId === recommendedId));
    }
  });
});

void describe("review1 Step 49: the diagnostic round", () => {
  const PROMPT = nodeFs.readFileSync(nodePath.resolve(__dirname, "../../resources/prompts/investigate-failure.md"), "utf8");
  const render = (variables: Record<string, string>): string => {
    let out = PROMPT;
    for (const [key, value] of Object.entries(variables)) out = out.split(`{{${key}}}`).join(value);
    return out;
  };

  void it("the prompt lists the task's own files, runs read-only, and asks for the diagnosis as the answer", () => {
    const protectedFiles = collectProtectedFilesV1(
      ["src/whatsapp-copy.ts", "src\\processor.ts", ".ensemble/t/plan.md", "src/whatsapp-copy.ts"],
      ["./src/a.test.ts"]
    );
    assert.deepEqual(protectedFiles, ["src/a.test.ts", "src/processor.ts", "src/whatsapp-copy.ts"]);
    const rendered = render(
      investigationTemplateVariablesV1({
        failure: "Failing command: `pnpm test` (exit 1)",
        environmentReport: formatEnvironmentReportV1(ENVIRONMENT),
        protectedFiles,
        diagnosisPath: "evidence/diagnosis-1.md",
      })
    );
    assert.doesNotMatch(rendered, /\{\{/);
    for (const file of protectedFiles) assert.ok(rendered.includes(`- \`${file}\``), file);
    assert.match(rendered, /not "unrelated pre-existing changes"/);
    assert.match(rendered, /runs in a read-only mode: you cannot edit, create or delete files/);
    assert.match(rendered, /Ensemble saves your final answer as the diagnosis file; you do not write it/);
    assert.match(rendered, /Your final answer \*\*is\*\* the diagnosis/);
    assert.doesNotMatch(rendered, /read-only by instruction/);
    assert.match(rendered, /Do not apply the fix/);
    assert.match(rendered, /`DATABASE_URL`/);
  });

  void it("with no recorded files the prompt still protects every modified file", () => {
    assert.match(formatProtectedFilesV1([]), /treat every modified file `git status` shows as protected/);
  });

  void it("numbers diagnosis files one past the highest on disk", () => {
    assert.equal(nextDiagnosisPathV1([]), "evidence/diagnosis-1.md");
    assert.equal(nextDiagnosisPathV1(["diagnosis-1.md", "diagnosis-3.md", "notes.md"]), "evidence/diagnosis-4.md");
  });

  void it("reads the files a diagnosis says to change, for the card that follows", () => {
    assert.deepEqual(
      parseDiagnosisFilesToChangeV1("## Suggested fix\n\nAdd the exclusion.\n\nFiles to change:\n- `apps/server/vitest.config.ts`\n- scripts/run.sh\n\n## Confidence\nhigh"),
      ["apps/server/vitest.config.ts", "scripts/run.sh"]
    );
    assert.deepEqual(parseDiagnosisFilesToChangeV1("Files to change: none\nThe owner has to restart Docker."), []);
    assert.deepEqual(parseDiagnosisFilesToChangeV1("No such line."), []);
  });

  void it("holds the request for the dispatching call only", () => {
    const request = { failure: "f", environmentReport: "e", protectedFiles: ["a.ts"], diagnosisPath: "evidence/diagnosis-1.md" };
    setInvestigationRequestV1("/ws/.ensemble/t/", request);
    assert.equal(peekInvestigationRequestV1("/ws/.ensemble/t"), request);
    clearInvestigationRequestV1("/ws/.ensemble/t");
    assert.equal(peekInvestigationRequestV1("/ws/.ensemble/t"), undefined);
  });

  void it("the apply prompt tells a round with only unfixable blockers to say 'nothing I can fix' and why", () => {
    const apply = nodeFs.readFileSync(nodePath.resolve(__dirname, "../../resources/prompts/apply-impl-review-code.md"), "utf8");
    assert.match(apply, /say "nothing I can fix", then name the failing check first/);
  });
});
