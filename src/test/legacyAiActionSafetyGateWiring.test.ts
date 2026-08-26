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
import { MIGRATED_ACTION_KEYS_V0 } from "../services/legacyAiActionSafetyGateV0";

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
    // Edit-capable sibling of the migrated "applyReview.v1" text route (plan
    // §7.8 step 16, not yet landed): gated under its own, always-disabled
    // route id so enabling "applyReview.v1" for plan-review stages never
    // implicitly reaches this uncoordinated editing path.
    file: "src/commands/reviewActions.ts",
    functionSignature: "async function applyImplementationReviewWithAI(",
    routeId: "applyReviewEdit.v1",
    // The plan-final/plan reads (previously inline here, including
    // materializeCanonicalIfNeeded(folderUri)) were extracted into
    // buildApplyReviewPromptPartsV1 (item 17b — shared with a review-driven
    // continuation's re-render) so this route's first read is now performed
    // by calling that helper, not by an inline read of its own.
    laterMarker: "buildApplyReviewPromptPartsV1(",
  },
  {
    // A prior "bootstrap" exemption let this route skip the throwing gate
    // (calling the non-throwing isLegacyAiRouteDisabledV0 query instead),
    // leaving a live, edit-capable AI route with no read-only preflight in
    // front of it. It now gates identically to every other unmigrated route
    // and stays disabled until plan §7/§7.8 step 16 lands its replacement.
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

  void it('chatView.ts :: the webview Send route gates on "chatSend.v1"/"globalAssistantSend.v1" before mutating the transcript or dispatching', () => {
    const filePath = path.join(REPO_ROOT, "src/views/chatView.ts");
    const content = fs.readFileSync(filePath, "utf8");

    // Stage branch: the gate must precede the chatWithStage dispatch (the
    // meaningful invariant — chatWithStage itself persists the user message,
    // so there is no separate append call in this branch to anchor on).
    const stageGateCall = 'assertLegacyAiRouteAllowedV0("chatSend.v1")';
    const stageGateIndex = content.indexOf(stageGateCall);
    assert.ok(stageGateIndex >= 0, "chatView.ts webview Send route does not call the chatSend.v1 gate");

    const stageDispatchIndex = content.indexOf('"vs-code-ai-helper.chatWithStage"', stageGateIndex);
    assert.ok(
      stageDispatchIndex > stageGateIndex,
      "the chatSend.v1 gate must precede the chatWithStage dispatch in chatView.ts"
    );

    // Global-assistant branch: this one DOES append the user message itself
    // (globalAssistantSend does not persist it), so the gate must precede
    // both that append and the dispatch — a disabled route must reject
    // before the transcript is mutated, exactly like the stage branch above.
    const globalGateCall = 'assertLegacyAiRouteAllowedV0("globalAssistantSend.v1")';
    const globalGateIndex = content.indexOf(globalGateCall);
    assert.ok(globalGateIndex >= 0, "chatView.ts webview Send route does not call the globalAssistantSend.v1 gate");
    assert.ok(
      globalGateIndex > stageGateIndex,
      "the globalAssistantSend.v1 gate must be a distinct call from the stage branch's chatSend.v1 gate"
    );

    const globalAppendIndex = content.indexOf('await this.append("user", text', globalGateIndex);
    assert.ok(
      globalAppendIndex > globalGateIndex,
      "the globalAssistantSend.v1 gate must precede the user-message transcript append for the global target"
    );

    const globalDispatchIndex = content.indexOf('"vs-code-ai-helper.globalAssistantSend"', globalGateIndex);
    assert.ok(
      globalDispatchIndex > globalAppendIndex,
      "the globalAssistantSend.v1 gate must precede the globalAssistantSend dispatch"
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

  void it(
    "runImplementationWithAI's first-run checklist branch reaches the coordinator, not an " +
      "uncorrelated legacy runner invocation (regression: the legacy runAiToFile helper used " +
      "to be called directly here, so its runner.run call carried no V1 correlation and was " +
      "rejected by runnerRegistry.ts's assertNoUnauthorizedV1CorrelationV0 backstop once " +
      "LEGACY_UNCORRELATED_RUNNER_INVOCATION_REJECTED_V0 was enabled, even though " +
      '"implementation.v1"\'s own route gate passed)',
    () => {
      const filePath = path.join(REPO_ROOT, "src/commands/reviewActions.ts");
      const content = fs.readFileSync(filePath, "utf8");

      // The legacy uncorrelated helper is deleted outright, not merely
      // unreferenced, so it cannot be silently re-wired to a new call site.
      assert.ok(
        !content.includes("function runAiToFile("),
        "the legacy runAiToFile helper must stay deleted from reviewActions.ts"
      );

      const runImplSigIndex = content.indexOf("export async function runImplementationWithAI(");
      assert.ok(runImplSigIndex >= 0, "could not find runImplementationWithAI in reviewActions.ts");

      const needsChecklistIndex = content.indexOf("if (needsChecklist)", runImplSigIndex);
      assert.ok(needsChecklistIndex > runImplSigIndex, "could not find the needsChecklist branch");

      // The branch's own closing brace: the next top-level "planFinalContent ="
      // reassignment after the branch marks its end (mirrors the source shape
      // asserted elsewhere in this suite rather than a brittle brace-counter).
      const branchEndMarker = "planFinalContent = (await readNonEmptyText(canonicalUri)) ?? planFinalContent;";
      const branchEndIndex = content.indexOf(branchEndMarker, needsChecklistIndex);
      assert.ok(branchEndIndex > needsChecklistIndex, "could not find the end of the needsChecklist branch");

      const branchBody = content.slice(needsChecklistIndex, branchEndIndex);
      assert.ok(
        branchBody.includes("invokeGenerateImplementationActionV1("),
        "runImplementationWithAI's checklist branch must invoke the shared " +
          "invokeGenerateImplementationActionV1 coordinator helper, not a legacy runner"
      );
      assert.ok(
        !branchBody.includes("runAiToFile("),
        "runImplementationWithAI's checklist branch must not call the deleted runAiToFile helper " +
          "(a historical mention in an explanatory comment is fine — an actual call is not)"
      );

      // invokeGenerateImplementationActionV1 itself must route through
      // coordinator.executeAction with the migrated "generateImplementation.v1"
      // action key, so the checklist step's provider invocation carries real
      // V1 correlation and is authorized at the runner/provider boundary.
      const helperSigIndex = content.indexOf("async function invokeGenerateImplementationActionV1(");
      assert.ok(helperSigIndex >= 0, "could not find invokeGenerateImplementationActionV1 in reviewActions.ts");
      const helperEndIndex = content.indexOf(
        "export async function generateImplementationWithAI(",
        helperSigIndex
      );
      assert.ok(helperEndIndex > helperSigIndex, "could not find the end of invokeGenerateImplementationActionV1");
      const helperBody = content.slice(helperSigIndex, helperEndIndex);
      assert.ok(
        helperBody.includes("coordinator.executeAction({") &&
          helperBody.includes("actionKey: GENERATE_IMPLEMENTATION_ACTION_KEY_V1,"),
        "invokeGenerateImplementationActionV1 must call coordinator.executeAction with " +
          "actionKey: GENERATE_IMPLEMENTATION_ACTION_KEY_V1"
      );

      assert.equal(
        MIGRATED_ACTION_KEYS_V0.has("generateImplementation.v1"),
        true,
        '"generateImplementation.v1" must be a migrated action key so this checklist-step ' +
          "invocation is authorized at the runner/provider boundary"
      );
    }
  );

  void it("the runner/provider boundary in runnerRegistry.ts calls the V1 correlation backstop", () => {
    const filePath = path.join(REPO_ROOT, "src/runners/runnerRegistry.ts");
    const content = fs.readFileSync(filePath, "utf8");
    assert.ok(
      content.includes('from "../services/legacyAiActionSafetyGateV0"'),
      "runnerRegistry.ts does not import assertNoUnauthorizedV1CorrelationV0"
    );
    const occurrences = content.split("assertNoUnauthorizedV1CorrelationV0(").length - 1;
    // The four call sites: resolveRunnerForModel's no-backup wrapper
    // (withQuotaObservation), its backup-capable wrapper,
    // runImplementationForModel, and — closing a review finding that the
    // stage-less branch returned the raw runner untouched, bypassing this
    // assertion entirely rather than merely being subject to it —
    // resolveRunnerForModel's stage-less wrapper (withUnauthorizedV1CorrelationBackstop).
    // (The import itself uses named-import syntax with no trailing "(", so it
    // does not add to this count.)
    assert.ok(
      occurrences >= 4,
      `expected assertNoUnauthorizedV1CorrelationV0 to be called at least 4 times, found ${occurrences}`
    );
  });
});
