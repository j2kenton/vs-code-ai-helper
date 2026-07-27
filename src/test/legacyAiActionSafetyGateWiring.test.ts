/**
 * Static wiring proof for the fail-closed AI action safety gate (plan §1.3):
 * every baseline AI route's real handler must call
 * assertLegacyAiRouteAllowedV0 with its registered route id as the FIRST
 * statement inside the function body — strictly before any other read,
 * consent check, or provider-selection call in that same function.
 *
 * A full runtime proof would require constructing the real TaskInventory /
 * ExtensionContext / ChatViewProvider dependency graph for each of these
 * (some 1000+ line) command modules just to reach the first statement, which
 * is out of scope for this check. Source-order inspection instead directly
 * verifies the property plan §1.3 actually requires ("before argument
 * normalization... reads... provider/model selection... prompt
 * construction"): that the gate call's source position precedes the first
 * other meaningful statement inside the same function body.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

interface WiringCase {
  readonly file: string;
  readonly functionSignature: string;
  readonly routeId: string;
  /** Text known to appear later in the same function body, after the gate call. */
  readonly laterMarker: string;
}

const CASES: readonly WiringCase[] = [
  {
    file: "src/commands/draftTaskWithAI.ts",
    functionSignature: "export async function draftTaskWithAI(",
    routeId: "draft.v1",
    laterMarker: "ensureAiConsent(context)",
  },
  {
    file: "src/commands/generatePlanWithAI.ts",
    functionSignature: "export async function generatePlanWithAI(",
    routeId: "generatePlan.v1",
    laterMarker: "ensureAiConsent(context)",
  },
  {
    file: "src/commands/applyCurrentStageAction.ts",
    functionSignature: "export async function applyCurrentStageAction(",
    routeId: "applyCurrentStage.v1",
    laterMarker: "resolveTaskContext(",
  },
  {
    file: "src/commands/runLintingFixes.ts",
    functionSignature: "export async function runLintingFixes(",
    routeId: "lint.v1",
    laterMarker: "normalizeArg(explicitArg)",
  },
  {
    file: "src/commands/chatWithStage.ts",
    functionSignature: "export async function chatWithStage(",
    routeId: "chatSend.v1",
    laterMarker: "normalizeArg(explicitArg)",
  },
  // commitAndPushTask.ts / "commitPushMetadata.v1" is covered by its own
  // dedicated test below rather than this table: Commit/Push is a composite
  // flow whose AI sub-step uses the non-throwing isLegacyAiRouteDisabledV0
  // query (disabled → deterministic fallback subject) instead of the
  // throwing assert, so the whole non-AI commit flow is not taken down by
  // the staged-migration kill switch.
  {
    file: "src/commands/reviewActions.ts",
    functionSignature: "export async function runReviewWithAI(",
    routeId: "review.v1",
    laterMarker: "workspace.workspaceFolders",
  },
  {
    file: "src/commands/reviewActions.ts",
    functionSignature: "export async function applyReviewWithAI(",
    routeId: "applyReview.v1",
    laterMarker: "workspace.workspaceFolders",
  },
  {
    file: "src/commands/reviewActions.ts",
    functionSignature: "export async function fastForwardReviewWithAI(",
    routeId: "fastForward.v1",
    laterMarker: "workspace.workspaceFolders",
  },
  {
    file: "src/commands/reviewActions.ts",
    functionSignature: "export async function generateImplementationWithAI(",
    routeId: "generateImplementation.v1",
    laterMarker: "workspace.workspaceFolders",
  },
  {
    file: "src/commands/reviewActions.ts",
    functionSignature: "export async function runImplementationWithAI(",
    routeId: "implementation.v1",
    laterMarker: "workspace.workspaceFolders",
  },
  // Concrete alias/wrapper routes: these read task state themselves before
  // delegating to the gated family handler, so each must gate first (plan
  // §1.3: every command, alias, scheduler, tree, or webview route).
  {
    file: "src/commands/reviewCurrentTask.ts",
    functionSignature: "export async function reviewCurrentTask(",
    routeId: "review.v1",
    laterMarker: "resolveTaskContext(",
  },
  {
    file: "src/commands/fastForwardCurrentTaskReview.ts",
    functionSignature: "export async function fastForwardCurrentTaskReview(",
    routeId: "fastForward.v1",
    laterMarker: "resolveTaskContext(",
  },
  {
    file: "src/commands/applyHighLevelReviewChanges.ts",
    functionSignature: "export async function applyHighLevelReviewChanges(",
    routeId: "applyReview.v1",
    laterMarker: "resolveTaskContext(",
  },
  {
    file: "src/commands/applyLowLevelReviewChanges.ts",
    functionSignature: "export async function applyLowLevelReviewChanges(",
    routeId: "applyReview.v1",
    laterMarker: "resolveTaskContext(",
  },
];

void describe("LegacyAiActionSafetyGateV0 wiring", () => {
  for (const testCase of CASES) {
    void it(`${testCase.file} :: ${testCase.functionSignature.replace(/\(.*/, "()")} gates on "${testCase.routeId}" before its first read`, () => {
      const filePath = path.join(REPO_ROOT, testCase.file);
      const content = fs.readFileSync(filePath, "utf8");

      const sigIndex = content.indexOf(testCase.functionSignature);
      assert.ok(sigIndex >= 0, `could not find function signature in ${testCase.file}`);

      const gateCall = `assertLegacyAiRouteAllowedV0("${testCase.routeId}")`;
      const gateIndex = content.indexOf(gateCall, sigIndex);
      assert.ok(
        gateIndex > sigIndex,
        `expected ${gateCall} to appear after the function signature in ${testCase.file}`
      );

      const markerIndex = content.indexOf(testCase.laterMarker, sigIndex);
      assert.ok(
        markerIndex > sigIndex,
        `could not find later marker "${testCase.laterMarker}" in ${testCase.file}`
      );

      assert.ok(
        gateIndex < markerIndex,
        `${gateCall} must precede "${testCase.laterMarker}" in ${testCase.file} ` +
          `(gate at ${gateIndex}, marker at ${markerIndex})`
      );

      // Also confirm the module actually imports the gate function, so the
      // call above cannot be a stale/dead reference to an unresolved symbol.
      assert.ok(
        content.includes('from "../services/legacyAiActionSafetyGateV0"') ||
          content.includes("from '../services/legacyAiActionSafetyGateV0'"),
        `${testCase.file} calls assertLegacyAiRouteAllowedV0 but does not import it`
      );
    });
  }

  void it('chatView.ts :: the webview Send route gates on "chatSend.v1" before appending the user message', () => {
    const filePath = path.join(REPO_ROOT, "src/views/chatView.ts");
    const content = fs.readFileSync(filePath, "utf8");

    const gateCall = 'assertLegacyAiRouteAllowedV0("chatSend.v1")';
    const gateIndex = content.indexOf(gateCall);
    assert.ok(gateIndex >= 0, "chatView.ts webview Send route does not call the chatSend.v1 gate");

    const appendIndex = content.indexOf('await this.append("user", text', gateIndex);
    assert.ok(
      appendIndex > gateIndex,
      "the chatSend.v1 gate must precede the user-message transcript append in chatView.ts"
    );

    assert.ok(
      content.includes('from "../services/legacyAiActionSafetyGateV0"'),
      "chatView.ts calls assertLegacyAiRouteAllowedV0 but does not import it"
    );
  });

  void it('commitAndPushTask.ts :: buildCommitMessage() consults the "commitPushMetadata.v1" kill switch before its first read', () => {
    const filePath = path.join(REPO_ROOT, "src/commands/commitAndPushTask.ts");
    const content = fs.readFileSync(filePath, "utf8");

    const sigIndex = content.indexOf("async function buildCommitMessage(");
    assert.ok(sigIndex >= 0, "could not find buildCommitMessage in commitAndPushTask.ts");

    const gateCall = 'isLegacyAiRouteDisabledV0("commitPushMetadata.v1")';
    const gateIndex = content.indexOf(gateCall, sigIndex);
    assert.ok(gateIndex > sigIndex, `expected ${gateCall} inside buildCommitMessage`);

    const markerIndex = content.indexOf("runGitCommand(repoRoot", sigIndex);
    assert.ok(markerIndex > sigIndex, "could not find runGitCommand(repoRoot in buildCommitMessage");

    assert.ok(
      gateIndex < markerIndex,
      `${gateCall} must precede the first workspace read in buildCommitMessage ` +
        `(gate at ${gateIndex}, read at ${markerIndex})`
    );

    assert.ok(
      content.includes('from "../services/legacyAiActionSafetyGateV0"'),
      "commitAndPushTask.ts calls isLegacyAiRouteDisabledV0 but does not import it"
    );
  });

  void it("the runner/provider boundary in runnerRegistry.ts calls the V1 correlation backstop", () => {
    const filePath = path.join(REPO_ROOT, "src/runners/runnerRegistry.ts");
    const content = fs.readFileSync(filePath, "utf8");
    assert.ok(
      content.includes('from "../services/legacyAiActionSafetyGateV0"'),
      "runnerRegistry.ts does not import assertNoUnauthorizedV1CorrelationV0"
    );
    const occurrences = content.split("assertNoUnauthorizedV1CorrelationV0(").length - 1;
    // The three call sites this round wired: resolveRunnerForModel's
    // no-backup wrapper (withQuotaObservation), its backup-capable wrapper,
    // and runImplementationForModel. (The import itself uses named-import
    // syntax with no trailing "(", so it does not add to this count.)
    assert.ok(
      occurrences >= 3,
      `expected assertNoUnauthorizedV1CorrelationV0 to be called at least 3 times, found ${occurrences}`
    );
  });
});
