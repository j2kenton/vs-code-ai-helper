import { STAGE_DISPLAY_NAMES, type TaskStage } from "../types/taskProgress";
import type { WorkflowDecisionOptionV1 } from "../types/workflowDecisionV1";
import type { PostWorkflowDecisionInputV1 } from "./workflowDecisionDispatchV1";
import { TEST_EVIDENCE_SATISFYING_COMMAND_HINT_V1 } from "./implementationChecklist";
import { normalizePath } from "./taskRoot";

/**
 * review1 Step 34 / Step 53: the card for plan items a review verified but whose test report does not count, so
 * their tick is withheld. Another editing round cannot produce a report that counts (it may be refused the test
 * command and tends to make edits), so every option here is deterministic: Ensemble runs Publish Checks once and
 * records the items whose test files the passing output names, the owner records a run they did, or the owner ticks.
 * Nothing on this card dispatches an Apply Review or Implementation round.
 */

export const RUN_CHECKS_FOR_WITHHELD_ITEMS_COMMAND_V1 = "vs-code-ai-helper.runChecksForWithheldTestItems";
export const TICK_WITHHELD_TEST_ITEMS_COMMAND_V1 = "vs-code-ai-helper.tickWithheldTestItems";
export const WITHHELD_TEST_EVIDENCE_DECISION_KEY_V1 = "withheldTestEvidence";

export interface WithheldTestEvidenceCardFactsV1 {
  readonly taskFolderPath: string;
  readonly stage: TaskStage;
  readonly taskLabel: string;
  /** Plan items the review named as verified complete that stay unticked for a missing test report. */
  readonly items: readonly string[];
  /** Why an item is held (the derivation's reason for it), when known. */
  readonly reasonFor?: (itemText: string) => string | undefined;
}

function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function buildWithheldTestEvidenceCardInputV1(
  facts: WithheldTestEvidenceCardFactsV1
): Omit<PostWorkflowDecisionInputV1, "createdAt"> {
  const stageName = STAGE_DISPLAY_NAMES[facts.stage] ?? facts.stage;
  const count = facts.items.length;
  const taskArg = { taskFolderPath: facts.taskFolderPath };
  const itemArgs = { ...taskArg, stage: facts.stage, itemTexts: facts.items };
  const lines = [
    `${stageName}: the review named ${count} plan item${count === 1 ? "" : "s"} as verified complete, but no tick was applied for ${count === 1 ? "it" : "them"} because no passing test report counts for ${count === 1 ? "it" : "each"}:`,
    ...facts.items.slice(0, 8).map((item) => {
      const reason = facts.reasonFor?.(item);
      return `  - ${shorten(item, 140)}${reason ? ` — ${reason}` : ""}`;
    }),
    count > 8 ? `  - …and ${count - 8} more` : undefined,
    TEST_EVIDENCE_SATISFYING_COMMAND_HINT_V1,
    "No editing round is offered for this: another round cannot produce a test report that counts.",
  ].filter((line): line is string => line !== undefined);
  const options: WorkflowDecisionOptionV1[] = [
    {
      optionId: "runChecks",
      label: "Run Publish Checks now",
      consequence:
        "Runs the project's Publish Checks once, in this window (no model round, nothing written to the Publish report). If they pass and their output names an item's test file, a passing report is recorded for that item and the review's tick is applied at once. Items it cannot match stay as they are and are listed.",
      resumeKind: "continue",
      effect: { kind: "command", command: RUN_CHECKS_FOR_WITHHELD_ITEMS_COMMAND_V1, args: [{ ...itemArgs, displayName: facts.taskLabel }] },
      recordedNext: "Publish Checks run",
    },
    {
      optionId: "recordRun",
      label: "Record a run I did",
      consequence:
        "Opens the form for a test run you did yourself (the command, whether it passed). A passing run counts as test evidence for the items you choose, and the review's tick for them is applied at once.",
      resumeKind: "continue",
      effect: { kind: "command", command: "vs-code-ai-helper.postOwnerTestRunCard", args: [itemArgs] },
      recordedNext: "the test-run form is open",
    },
    {
      optionId: "tickThese",
      label: count === 1 ? "Tick this item myself" : `Tick these ${count} items myself`,
      consequence: `Ticks ${count === 1 ? "the item" : "the items"} in plan-final.md and records the tick as yours, accepting the review's verification without a test report. Use it when you know the tests pass.`,
      resumeKind: "continue",
      effect: { kind: "command", command: TICK_WITHHELD_TEST_ITEMS_COMMAND_V1, args: [{ ...taskArg, itemTexts: facts.items }] },
      recordedNext: "your ticks are recorded",
    },
    {
      optionId: "notNow",
      label: "Not now",
      consequence: "Does nothing. The items stay provisional and the checklist is unchanged.",
      resumeKind: "unpause",
      effect: { kind: "doNothing" },
    },
  ];
  return {
    decisionKey: WITHHELD_TEST_EVIDENCE_DECISION_KEY_V1,
    taskCanonicalId: normalizePath(facts.taskFolderPath),
    stage: facts.stage,
    whatHappened: lines.join("\n"),
    whyUserNeeded:
      "Only test evidence is missing for these items. Ensemble can run the project's checks once for it; whether to accept them without a report is your call.",
    options,
    recommendation: {
      kind: "option",
      optionId: "runChecks",
      reasoning:
        "Publish Checks run without a model round and settle every item whose test file their output names, so it is the one step that can clear this without your judgement.",
    },
    gating: { holdsTaskPaused: false, unblocksProgress: false, detail: "Optional: the items stay provisional until settled." },
    suppressNotification: true,
  } as Omit<PostWorkflowDecisionInputV1, "createdAt">;
}
