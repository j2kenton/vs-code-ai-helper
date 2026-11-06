/**
 * review1 Step 49 (owner decision 2026-11-05): the diagnostic round runs in the provider's enforced read-only mode, so
 * there is no snapshot or put-back. These tests cover which models can run it, how its answer becomes the diagnosis,
 * and the card that follows.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { buildDiagnosisFollowUpDecisionV1, extractDiagnosisCauseV1 } from "../utils/diagnosisFollowUpCardV1";
import { assessDiagnosticRoundCompletionV1, formatDiagnosticRunLogV1 } from "../utils/diagnosticRoundCompletionV1";
import {
  describeOutOfPlanApprovalV1,
  formatApprovedFixBlockV1,
  sanitizeApprovedFixFilesV1,
} from "../utils/investigateFailureV1";
import { resolveReadOnlyDiagnosisAvailabilityV1 } from "../utils/readOnlyDiagnosisAvailabilityV1";
import { createImplContinuationReportRowV1 } from "../actions/rows/implContinuationReportRowV1";

const TARGET = { canonicalId: "task-x", taskFolderPath: "/ws/.ensemble/task-x", taskName: "chat" };

const DIAGNOSIS = [
  "## Cause",
  "The server vitest config sweeps up nine `*.integration.test.ts` files. They self-skip without DATABASE_URL, but",
  "the extension host exports it, so they cold-start the postgres driver during collection.",
  "",
  "## Evidence",
  "`pnpm --filter server test` exits 1 under the host environment and 0 in a terminal.",
  "",
  "## Suggested fix",
  "Exclude the integration files from the main config, as vitest.cron.config.ts already does.",
  "",
  "Files to change:",
  "- `apps/server/vitest.config.ts`",
  "",
  "## Confidence",
  "high",
].join("\n");

function installModelSettings(raw: Record<string, unknown>): { restore: () => void } {
  const original = (vscode.workspace as unknown as Record<string, unknown>).getConfiguration;
  (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = (): {
    get: (key: string, defaultValue?: unknown) => unknown;
    inspect: () => undefined;
  } => ({
    get: (key: string, defaultValue?: unknown): unknown => (key === "modelSettings" ? raw : defaultValue),
    inspect: () => undefined,
  });
  return {
    restore: (): void => {
      (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = original;
    },
  };
}

void describe("review1 Step 49: which models can run the diagnostic round", () => {
  void it("uses the next model in the chain that can enforce read-only, skipping Cline and Antigravity", () => {
    const stub = installModelSettings({
      impl: { primary: "cline-cli:pass", backups: ["antigravity-cli:flash", "claude-cli:sonnet"], strategy: "switch-to-backup" },
    });
    try {
      const result = resolveReadOnlyDiagnosisAvailabilityV1();
      assert.equal(result.available, true);
      if (result.available) assert.equal(result.modelId, "claude-cli:sonnet");
    } finally {
      stub.restore();
    }
  });

  void it("says why it is unavailable when every model in the chain can write", () => {
    const stub = installModelSettings({
      impl: { primary: "cline-cli:pass", backups: ["antigravity-cli:flash"], strategy: "switch-to-backup" },
    });
    try {
      const result = resolveReadOnlyDiagnosisAvailabilityV1();
      assert.equal(result.available, false);
      if (!result.available) {
        assert.match(result.reason, /none of the models in Implementation's chain/);
        assert.match(result.reason, /stops the provider editing files/);
      }
    } finally {
      stub.restore();
    }
  });
});

void describe("review1 Step 49: the round is dispatched read-only and the by-instruction machinery is gone", () => {
  const read = (relative: string): string => nodeFs.readFileSync(nodePath.resolve(__dirname, "../..", relative), "utf8");

  void it("dispatches in the provider's read-only text mode and saves the answer as the diagnosis", () => {
    const actions = read("src/commands/reviewActions.ts");
    assert.match(actions, /peekInvestigationRequestV1\(folderUri\.fsPath\);\s*if \(diagnosticRequestForDispatch !== undefined\)/);
    assert.match(actions, /diagnosticReadOnly: true/);
    assert.match(actions, /resolveReadOnlyDiagnosisAvailabilityV1\(\)/);
    assert.match(actions, /const answer = result\.summary\?\.trim\(\)/);
    const dispatch = read("src/commands/implContinuationTextDispatchV1.ts");
    assert.match(dispatch, /diagnosticReadOnly === true\s*\? \{ requireReadOnlyText: true \}/);
  });

  void it("the row the round runs through attaches the read-only workspace session, so Copilot can open the failing files", () => {
    // Copilot cannot read the workspace by itself; the coordinator attaches the read-only tools only for a
    // `readsWorkspaceFiles` text row whose reserved provider does not read natively (a CLI is unaffected).
    const row = createImplContinuationReportRowV1();
    assert.equal(row.providerMode, "text");
    assert.equal(row.readsWorkspaceFiles, true);
    const coordinator = read("src/actions/taskActionCoordinatorV1.ts");
    assert.match(coordinator, /row\.readsWorkspaceFiles && reserved\.providerReadsWorkspaceNatively === false/);
  });

  void it("the snapshot, quarantine and put-back machinery and its call sites are removed", () => {
    for (const removed of [
      "src/utils/diagnosticRoundGuardV1.ts",
      "src/utils/diagnosticQuarantineV1.ts",
      "src/commands/diagnosisFilesCommandV1.ts",
      "src/utils/ownerSaveTrackerV1.ts",
      "src/test/diagnosticFilesPutBackV1.test.ts",
    ]) {
      assert.equal(nodeFs.existsSync(nodePath.resolve(__dirname, "../..", removed)), false, removed);
    }
    for (const file of ["src/commands/reviewActions.ts", "src/extension.ts", "src/utils/diagnosisFollowUpCardV1.ts"]) {
      assert.doesNotMatch(read(file), /diagnosticRoundGuardV1|diagnosticQuarantineV1|diagnosisFilesCommandV1|putBackDiagnostic|keepDiagnostic|trackOwnerSavesV1/, file);
    }
  });
});

void describe("review1 Step 49: the diagnosis comes from the round's answer", () => {
  void it("a compliant diagnosis completes without the editing report contract", () => {
    assert.deepEqual(assessDiagnosticRoundCompletionV1("evidence/diagnosis-1.md", DIAGNOSIS), { ok: true });
    const missing = assessDiagnosticRoundCompletionV1("evidence/diagnosis-1.md", undefined);
    assert.equal(missing.ok, false);
    assert.match(missing.ok ? "" : missing.reason, /returned no diagnosis to save as evidence\/diagnosis-1\.md/);
    const tiny = assessDiagnosticRoundCompletionV1("evidence/diagnosis-1.md", "ok");
    assert.equal(tiny.ok, false);
    const log = formatDiagnosticRunLogV1({
      roundId: "r1",
      promptRoundId: "p1",
      status: "completed",
      providerLine: "",
      diagnosisPath: "evidence/diagnosis-1.md",
      completion: { ok: true },
      summary: "Cause: the config sweeps up the integration files.",
    });
    assert.match(log, /Mode: diagnose/);
    assert.doesNotMatch(log, /## Files Changed|## Verification/);
  });
});

void describe("review1 Step 49: the card that follows a diagnosis", () => {
  void it("offers Apply (outside the plan: <files>), take it from here and accept directly; recommends Apply", () => {
    const card = buildDiagnosisFollowUpDecisionV1({
      stage: "impl-high-review",
      target: TARGET,
      diagnosisPath: "evidence/diagnosis-1.md",
      diagnosis: DIAGNOSIS,
      failure: "Failing command: `pnpm --filter server test` (exit 1)",
    });
    assert.deepEqual(
      card.options.map((o) => o.label),
      [
        "Apply the suggested fix (outside the plan: apps/server/vitest.config.ts)",
        "I'll take it from here",
        "Accept as environmental",
      ]
    );
    // No put-back or keep-files step: the round was read-only, so it changed nothing to settle first.
    assert.ok(!card.options.some((o) => /put back|keep the/i.test(o.label)));
    assert.equal(card.recommendation.kind === "option" ? card.recommendation.optionId : undefined, "applyDiagnosisFix");
    const apply = card.options[0]!;
    assert.match(apply.consequence, /owner-approved out-of-plan change limited to apps\/server\/vitest\.config\.ts/);
    assert.match(apply.consequence, /may edit only those files/);
    assert.match(card.whyUserNeeded, /read-only mode/);
    const evidence = (card.evidence ?? []).map((e) => e.detail).join("\n");
    assert.match(evidence, /cold-start the postgres driver/);
    assert.match(evidence, /apps\/server\/vitest\.config\.ts/);
    if (apply.effect.kind === "command") {
      const arg = apply.effect.args?.[0] as { applyDiagnosisFix: { files: string[]; diagnosisPath: string } };
      assert.deepEqual(arg.applyDiagnosisFix.files, ["apps/server/vitest.config.ts"]);
      assert.equal(arg.applyDiagnosisFix.diagnosisPath, "evidence/diagnosis-1.md");
    }
  });

  void it("offers no apply when the diagnosis names no file, too many files, or was not written", () => {
    const base = { stage: "impl-high-review" as const, target: TARGET, diagnosisPath: "evidence/diagnosis-2.md", failure: "f" };
    for (const diagnosis of [
      "## Cause\nDocker is not running.\n\nFiles to change: none\n",
      `Files to change:\n${Array.from({ length: 6 }, (_, i) => `- src/f${i}.ts`).join("\n")}\n`,
      undefined,
    ]) {
      const card = buildDiagnosisFollowUpDecisionV1({ ...base, diagnosis });
      assert.ok(!card.options.some((o) => o.optionId === "applyDiagnosisFix"), String(diagnosis).slice(0, 30));
      assert.equal(card.recommendation.kind, "none");
    }
  });

  void it("approval covers only workspace-relative files, never an outside path, Git internals or task artifacts", () => {
    assert.deepEqual(
      sanitizeApprovedFixFilesV1(["apps/a.ts", "../outside.ts", "/etc/passwd", "C:/x.ts", ".git/config", ".ensemble/t/task.md", "~/x", "apps/a.ts", "./b.ts"]),
      ["apps/a.ts", "b.ts"]
    );
  });

  void it("the approved-fix round is limited to the named files and ticks nothing", () => {
    const request = { diagnosisPath: "evidence/diagnosis-1.md", files: ["apps/server/vitest.config.ts"], failure: "Failing command: `x`" };
    const block = formatApprovedFixBlockV1(request);
    assert.match(block, /You may edit ONLY these files:\n- `apps\/server\/vitest\.config\.ts`/);
    assert.match(block, /do not tick plan items/);
    assert.match(block, /do not widen/);
    assert.match(describeOutOfPlanApprovalV1(request), /Approved one out-of-plan change, limited to `apps\/server\/vitest\.config\.ts`/);
  });

  void it("takes the Cause section for the card", () => {
    assert.match(extractDiagnosisCauseV1(DIAGNOSIS), /^The server vitest config sweeps up nine/);
    assert.doesNotMatch(extractDiagnosisCauseV1(DIAGNOSIS), /Suggested fix/);
  });
});
