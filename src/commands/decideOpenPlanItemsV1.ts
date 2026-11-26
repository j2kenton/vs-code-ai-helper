import * as vscode from "vscode";
import { STAGE_DISPLAY_NAMES, TaskStage } from "../types/taskProgress";
import {
  CreateWorkflowDecisionInputV1,
  WorkflowDecisionCommandResultV1,
  WorkflowDecisionOptionV1,
  WorkflowDecisionRecommendationV1,
} from "../types/workflowDecisionV1";
import { getCanonicalImplementationUri } from "../utils/implementationArtifactResolver";
import { readTextIfExists, writeTextFileIfUnchangedV1 } from "../utils/fileUtils";
import { createHash, randomBytes } from "crypto";
import {
  appendOpenPlanItemsFormV1,
  closeOpenPlanItemsFormsV1,
  OpenPlanItemsFormItemV1,
  readOpenPlanItemsFormsV1,
  setOpenPlanItemsFormStateV1,
} from "../utils/chatHistoryStore";
import {
  applyOpenPlanItemsFormV1,
  countChecklistEvidenceProgressV1,
  describeChecklistGateGapV1,
  getPlanRevisionV1,
  listOpenPlanItemRecordsV1,
  normalizeChecklistItemTextV1,
  OpenPlanItemsFormAnswerV1,
  truncateChecklistItemTextV1,
} from "../utils/implementationChecklist";
import {
  classifyOpenPlanItemsV1,
  formatClassifiedOpenPlanItemsV1,
  onlyMissingTestEvidenceV1,
} from "../utils/openPlanItemClassificationV1";
import { NotificationRouter } from "../utils/notificationRouter";
import { formatNotificationTaskLabelV1 } from "../utils/notificationTaskContextV1";
import { FastForwardRunStateV1 } from "../utils/activeFastForwardRunsV1";
import { computeNextStage } from "../utils/stageTransition";
import { resolveConfiguredReviewStages } from "../utils/modelSelection";
import { postWorkflowDecisionV1 } from "../utils/workflowDecisionDispatchV1";
import { ChatTarget } from "../views/chatView";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { recordPlanItemOwnerDecisionV1 } from "../utils/taskProgressTransforms";
import { withTaskLock } from "../state/taskStateStore";
import { clearFormPlanWriteMarkerV1, markFormPlanWriteV1 } from "../utils/formPlanWriteMarkerV1";
import { POST_OWNER_TEST_RUN_CARD_COMMAND_V1, partitionItemsByNamedCommandV1 } from "./ownerTestRunCardV1";
import { formatTestsRefusedRemedyV1, type TestsRefusedV1 } from "../utils/testsRefusedV1";
import type { AllowedTestCommandV1 } from "../utils/allowedTestCommandV1";
import { clearStageActionRefusalReasonV1, takeStageActionRefusalReasonV1 } from "../utils/stageActionRefusalV1";

const COMMAND = "vs-code-ai-helper.decideOpenPlanItems";
const TICK_ALL_COMMAND = "vs-code-ai-helper.tickAllVerifiedOpenPlanItems";

/** The note written beside each item the owner settles with "Tick all N". */
export const TICK_ALL_VERIFIED_NOTE_V1 = "settled by your decision; no test report recorded";

/** One open plan item as the "nothing more to build" card knows it: its text and the round's own reason (empty = none given). */
export interface OpenPlanItemReasonForDecisionV1 {
  readonly itemText: string;
  readonly reason: string;
}

export interface DecideOpenPlanItemsArgV1 {
  readonly taskFolderPath: string;
  readonly displayName?: string;
  readonly items: readonly OpenPlanItemReasonForDecisionV1[];
  /** The stage this card was raised against — needed to arrange the stage's
   * continuing action, or the follow-up Advance card, once decisions are
   * applied. */
  readonly stage: TaskStage;
  /**
   * RC2 item 13, Step 52: captured at card-build time (see
   * `buildOpenPlanItemsNeedDecisionCardInputV1`'s doc comment) — when set,
   * applying the owner's decisions resumes Fast Forward from Apply Review
   * with these live counters; otherwise it arranges the stage's own ordinary
   * continuing action.
   */
  readonly resumeFastForwardV1?: FastForwardRunStateV1;
}

/**
 * RC3 item 5, Step 10: the "Decide item by item" option's effect. It posts a
 * form into the task's chat (the `openPlanItemsFormV1` entry) — every open
 * item with its reason, Exclude / "I did it — tick it" / Leave open, and a
 * note field — and returns; nothing waits on a pop-up. The answers are
 * applied by {@link applyOpenPlanItemsFormSubmissionV1} when the owner
 * presses Apply in the chat.
 */
export async function decideOpenPlanItemsV1(
  arg?: DecideOpenPlanItemsArgV1
): Promise<WorkflowDecisionCommandResultV1 | boolean> {
  if (!arg?.taskFolderPath || arg.items.length === 0) {
    return false;
  }
  const taskName = formatNotificationTaskLabelV1(arg.displayName, arg.taskFolderPath);
  const planUri = getCanonicalImplementationUri(vscode.Uri.file(arg.taskFolderPath));
  const plan = await readTextIfExists(planUri);
  if (plan === undefined) {
    NotificationRouter.showWarning(`${taskName}: plan-final.md could not be read, so no form was posted.`);
    return false;
  }
  const formItems = resolveOpenFormItemsV1(plan, arg.items);
  if (formItems.length === 0) {
    NotificationRouter.showInformation(`${taskName}: none of these items is still open in the plan.`);
    return { outcome: "done" };
  }
  const posted = await withTaskLock(arg.taskFolderPath, async () => {
    const progress = await readTaskProgressStrictV1(vscode.Uri.file(arg.taskFolderPath));
    if (!progress.ok || progress.decoded.progress.currentStage !== arg.stage) return false;
    await appendOpenPlanItemsFormV1(arg.taskFolderPath, arg.taskFolderPath, {
      formId: randomBytes(16).toString("hex"),
      stage: arg.stage,
      items: formItems,
      planFingerprint: fingerprintPlanV1(plan),
      ...(arg.resumeFastForwardV1
        ? {
            resumeFastForwardV1: {
              attemptNumber: arg.resumeFastForwardV1.attemptNumber,
              maxAttempts: arg.resumeFastForwardV1.maxAttempts,
            },
          }
        : {}),
    });
    return true;
  });
  if (!posted) {
    NotificationRouter.showWarning(`${taskName}: the stage changed or could not be verified, so no form was posted.`);
    return false;
  }
  return { outcome: "done" };
}

/**
 * Resolve each item the round named to the plan's own occurrence-aware record, so two items with
 * identical text get distinct ids. Items no longer open in the plan are dropped.
 */
function resolveOpenFormItemsV1(
  plan: string,
  items: readonly OpenPlanItemReasonForDecisionV1[]
): OpenPlanItemsFormItemV1[] {
  const records = listOpenPlanItemRecordsV1(plan);
  const used = new Set<string>();
  const formItems: OpenPlanItemsFormItemV1[] = [];
  for (const item of items) {
    const key = normalizeChecklistItemTextV1(item.itemText);
    const record = records.find(
      (r) => !r.settled && !used.has(r.itemId) && normalizeChecklistItemTextV1(r.itemText) === key
    );
    if (!record) {
      continue;
    }
    used.add(record.itemId);
    formItems.push({
      itemId: record.itemId,
      itemText: record.itemText,
      occurrence: record.occurrence,
      reason: item.reason,
    });
  }
  return formItems;
}

/**
 * bugs4 item 27 / Step 20: "Tick all N: the review verified them built". Opens the same open-items
 * form the item-by-item path uses and applies it at once with every row set to tick, so the ticks
 * go through the one apply path: one plan write, owner provenance in the gate, and one chat
 * outcome (including the follow-up). It is not a reviewer verification and invents no test
 * report: the note says the items were settled by the owner's decision.
 */
export async function tickAllVerifiedOpenPlanItemsV1(
  arg?: DecideOpenPlanItemsArgV1
): Promise<WorkflowDecisionCommandResultV1 | boolean> {
  if (!arg?.taskFolderPath || arg.items.length === 0) {
    return false;
  }
  const taskName = formatNotificationTaskLabelV1(arg.displayName, arg.taskFolderPath);
  const plan = await readTextIfExists(getCanonicalImplementationUri(vscode.Uri.file(arg.taskFolderPath)));
  if (plan === undefined) {
    return { outcome: "refused", message: `${taskName}: plan-final.md could not be read, so nothing was ticked.` };
  }
  const formItems = resolveOpenFormItemsV1(plan, arg.items);
  if (formItems.length === 0) {
    return { outcome: "done", message: `${taskName}: none of these items is still open in the plan, so nothing was ticked.` };
  }
  const formId = randomBytes(16).toString("hex");
  const opened = await withTaskLock(arg.taskFolderPath, async () => {
    const progress = await readTaskProgressStrictV1(vscode.Uri.file(arg.taskFolderPath));
    if (!progress.ok || progress.decoded.progress.currentStage !== arg.stage) return false;
    await appendOpenPlanItemsFormV1(arg.taskFolderPath, arg.taskFolderPath, {
      formId,
      stage: arg.stage,
      items: formItems,
      planFingerprint: fingerprintPlanV1(plan),
      ...(arg.resumeFastForwardV1
        ? {
            resumeFastForwardV1: {
              attemptNumber: arg.resumeFastForwardV1.attemptNumber,
              maxAttempts: arg.resumeFastForwardV1.maxAttempts,
            },
          }
        : {}),
    });
    return true;
  });
  if (!opened) {
    return { outcome: "refused", message: `${taskName}: the stage changed or could not be verified, so nothing was ticked.` };
  }
  const result = await applyOpenPlanItemsFormSubmissionV1({
    taskFolderPath: arg.taskFolderPath,
    canonicalId: arg.taskFolderPath,
    ...(arg.displayName ? { displayName: arg.displayName } : {}),
    formId,
    answers: formItems.map((item) => ({ itemId: item.itemId, choice: "tick", note: TICK_ALL_VERIFIED_NOTE_V1 })),
  });
  return { outcome: result.kind === "applied" ? "done" : "refused", message: result.message };
}

function fingerprintPlanV1(plan: string): string {
  return createHash("sha256").update(plan, "utf8").digest("hex");
}

export type OpenPlanItemsFormSubmissionResultV1 =
  /** Validation or write failure: the form stays open and the webview keeps every selection. */
  | { readonly kind: "rejected"; readonly message: string }
  /** The form was already applied (or is gone): a repeat submit is a no-op. */
  | { readonly kind: "ignored"; readonly message: string }
  | { readonly kind: "applied"; readonly message: string };

function decodeFormAnswersV1(raw: unknown): OpenPlanItemsFormAnswerV1[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const answers: OpenPlanItemsFormAnswerV1[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      return undefined;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.itemId !== "string" || typeof e.choice !== "string") {
      return undefined;
    }
    if (e.note !== undefined && typeof e.note !== "string") {
      return undefined;
    }
    answers.push({
      itemId: e.itemId,
      choice: e.choice as OpenPlanItemsFormAnswerV1["choice"],
      ...(typeof e.note === "string" ? { note: e.note } : {}),
    });
  }
  return answers;
}

/**
 * RC3 item 5, Step 10: applies one submission of an in-chat open-items form.
 * Answers already given are never lost — an item left as "Leave open" stays
 * open and the rest are written in ONE atomic plan write. A rejected
 * submission (validation or a plan that changed under the write) leaves the
 * form `open`, so the owner can press Apply again.
 */
export async function applyOpenPlanItemsFormSubmissionV1(input: {
  readonly taskFolderPath: string;
  readonly canonicalId: string;
  readonly displayName?: string;
  readonly formId: string;
  readonly answers: unknown;
}): Promise<OpenPlanItemsFormSubmissionResultV1> {
  const result = await withTaskLock(input.taskFolderPath, async () => applyOpenPlanItemsFormLockedV1(input));
  if (result.continuation) {
    // bugs4 item 6: the follow-up's outcome is part of the ONE chat line the
    // form ends with. It is never a pop-up on its own.
    let followUp: string;
    try {
      followUp = await continueAfterOpenPlanItemDecisionsV1(
        result.continuation,
        formatNotificationTaskLabelV1(input.displayName, input.taskFolderPath)
      );
    } finally {
      clearFormPlanWriteMarkerV1(input.taskFolderPath);
    }
    return { ...result.result, message: `${result.result.message} ${followUp}` };
  }
  return result.result;
}

async function applyOpenPlanItemsFormLockedV1(input: {
  readonly taskFolderPath: string; readonly canonicalId: string; readonly displayName?: string;
  readonly formId: string; readonly answers: unknown;
}): Promise<{ result: OpenPlanItemsFormSubmissionResultV1; continuation?: DecideOpenPlanItemsArgV1 }> {
  const forms = await readOpenPlanItemsFormsV1(input.taskFolderPath, input.canonicalId);
  const form = forms.find((f) => f.formId === input.formId);
  if (!form) {
    return { result: { kind: "ignored", message: "This form is no longer available." } };
  }
  if (form.state !== "open") {
    return { result: { kind: "ignored", message: `This form is no longer open (${form.closedReason ?? form.state}); your answers were not applied.` } };
  }
  const progress = await readTaskProgressStrictV1(vscode.Uri.file(input.taskFolderPath));
  if (!progress.ok || progress.decoded.progress.currentStage !== form.stage) {
    return { result: { kind: "ignored", message: "This form's stage is no longer current, or could not be verified; your answers were not applied." } };
  }
  const answers = decodeFormAnswersV1(input.answers);
  if (!answers) {
    return { result: { kind: "rejected", message: "Could not apply: the submitted answers were malformed." } };
  }
  const taskName = formatNotificationTaskLabelV1(input.displayName, input.taskFolderPath);
  const planUri = getCanonicalImplementationUri(vscode.Uri.file(input.taskFolderPath));
  const plan = await readTextIfExists(planUri);
  if (plan === undefined) {
    return { result: { kind: "rejected", message: "plan-final.md could not be read, so nothing was applied. Try Apply again." } };
  }
  const applied = applyOpenPlanItemsFormV1(
    plan,
    new Set(form.items.map((item) => item.itemId)),
    answers,
    new Date().toISOString().slice(0, 10)
  );
  if (!applied.ok) {
    return { result: { kind: "rejected", message: applied.rejectionReason } };
  }
  const changed = applied.ticked.length + applied.excluded.length > 0;
  if (changed && !(await writeTextFileIfUnchangedV1(planUri, plan, applied.content))) {
    return { result: { kind: "rejected", message: "plan changed, try Apply again." } };
  }
  if (changed) {
    markFormPlanWriteV1(input.taskFolderPath, planUri.fsPath, applied.content);
  }
  let provenanceNote = "";
  if (changed) {
    // bugs4 item 7: a form tick is an explicit owner decision. Record it with
    // owner provenance so the gate settles the item, apart from any reviewer
    // verification. The task lock is already held by the caller.
    const recorded = await recordOwnerDecisionsV1(input.taskFolderPath, form.formId, plan, applied);
    provenanceNote = recorded
      ? ` ${recorded}`
      : " The completeness gate could not record these as your decisions, so it may still count them as unverified.";
  }
  await setOpenPlanItemsFormStateV1(input.taskFolderPath, input.canonicalId, form.formId, "applied");
  const textById = new Map(form.items.map((item) => [item.itemId, item.itemText]));
  const parts: string[] = [];
  if (applied.ticked.length > 0) {
    parts.push(`ticked ${applied.ticked.length}`);
  }
  if (applied.excluded.length > 0) {
    parts.push(`excluded ${applied.excluded.length}`);
  }
  const skippedLines = applied.skipped.map(
    (s) => `"${truncateChecklistItemTextV1(textById.get(s.itemId) ?? s.itemText, 60)}" — ${s.reason}`
  );
  const summary =
    (parts.length > 0 ? `${parts.join(", ")} in plan-final.md.` : "No items were changed. Nothing will run; the items stay open. Fix what blocks them, then use Fast Forward or Apply Review.") +
    (skippedLines.length > 0 ? ` ${skippedLines.join("; ")}.` : "") +
    provenanceNote;
  NotificationRouter.showInformation(`${taskName}: ${summary}`);
  return { result: { kind: "applied", message: summary }, ...(changed ? { continuation: {
    taskFolderPath: input.taskFolderPath, displayName: input.displayName, items: [], stage: form.stage,
    ...(form.resumeFastForwardV1 ? { resumeFastForwardV1: form.resumeFastForwardV1 } : {}),
  } } : {}) };
}

/**
 * Writes owner-provenance evidence for the form's ticks and exclusions and
 * returns the gate's explanation of the result, or `undefined` when the
 * evidence could not be written. Runs under the caller's task lock.
 */
async function recordOwnerDecisionsV1(
  taskFolderPath: string,
  formId: string,
  priorContent: string,
  applied: {
    readonly content: string;
    readonly tickedWritten: readonly string[];
    readonly excludedWritten: readonly string[];
  }
): Promise<string | undefined> {
  const planRevision = getPlanRevisionV1(applied.content);
  const priorRevision = getPlanRevisionV1(priorContent);
  const at = new Date().toISOString();
  try {
    const patched = await patchTaskProgressStrictV1(
      vscode.Uri.file(taskFolderPath),
      (progress) => {
        let next = progress;
        // The write above can change the plan revision (a note on a tick, an
        // exclusion), and decisions are only read for the current revision.
        // Carry the owner's decisions from the revision this write started
        // from over to the new one so a later form does not undo them. An item
        // whose own line this write changed no longer matches by key, so it is
        // simply not counted until it is decided again.
        if (priorRevision !== planRevision) {
          for (const record of progress.planItemOwnerDecisions ?? []) {
            if (record.planRevision !== priorRevision) continue;
            next = recordPlanItemOwnerDecisionV1(next, {
              planRevision, itemText: record.itemText, at: record.at, formId: record.formId, decision: record.decision,
            });
          }
        }
        // Keyed by the text as written: a note appended to a ticked line changes
        // the key the gate looks the item up by.
        for (const itemText of applied.tickedWritten) {
          next = recordPlanItemOwnerDecisionV1(next, { planRevision, itemText, at, formId, decision: "tick" });
        }
        for (const itemText of applied.excludedWritten) {
          next = recordPlanItemOwnerDecisionV1(next, { planRevision, itemText, at, formId, decision: "exclude" });
        }
        return next;
      },
      { skipLock: true }
    );
    if (!patched) return undefined;
    const gate = countChecklistEvidenceProgressV1(applied.content, patched.planItemEvidence ?? [], patched.planItemOwnerDecisions ?? []);
    if (!gate) return undefined;
    return `Gate: ${describeChecklistGateGapV1(gate)}; ${gate.gate.settled} of ${gate.gate.total} settled.`;
  } catch {
    return undefined;
  }
}

/** Dismissal shares the task lease with submission and stage transitions. */
export async function dismissOpenPlanItemsFormV1(taskFolderPath: string, canonicalId: string, formId: string, by: string) {
  return withTaskLock(taskFolderPath, async () => (await closeOpenPlanItemsFormsV1(
    taskFolderPath, canonicalId, { formId }, { state: "dismissed", reason: "dismissed by the owner, not answered", by }
  ))[0]);
}

/**
 * RC2 item 13, Step 52's continuation: arrange whatever comes next for a task
 * whose open-item decisions were just written to plan-final.md. Never throws
 * on a downstream refusal — the plan write above already succeeded and is
 * reported; a failure to arrange the next step is a `NotificationRouter`
 * warning, not a reason to make this command's own outcome look failed.
 */
/** @internal exported for testing */
export async function continueAfterOpenPlanItemDecisionsV1(
  arg: DecideOpenPlanItemsArgV1,
  taskName: string
): Promise<string> {
  try {
    return await continueAfterOpenPlanItemDecisionsInnerV1(arg, taskName);
  } catch (error) {
    return (
      "Your decisions were written to plan-final.md, but arranging what runs next failed: " +
      `${error instanceof Error ? error.message : String(error)}. ${NOTHING_RUNS_NEXT_V1}`
    );
  }
}

const NOTHING_RUNS_NEXT_V1 = "Nothing else will run now; use Fast Forward or Apply Current Stage Action to continue.";

async function continueAfterOpenPlanItemDecisionsInnerV1(
  arg: DecideOpenPlanItemsArgV1,
  taskName: string
): Promise<string> {
  const planUri = getCanonicalImplementationUri(vscode.Uri.file(arg.taskFolderPath));
  const freshPlan = await readTextIfExists(planUri);
  const taskFolder = vscode.Uri.file(arg.taskFolderPath);
  const progressRead = await readTaskProgressStrictV1(taskFolder);
  if (!progressRead.ok) {
    return `Nothing was started: ${taskName}'s task-progress.json could not be read, so the task's state is unknown. ${NOTHING_RUNS_NEXT_V1}`;
  }
  if (progressRead.decoded.progress.currentStage !== arg.stage) {
    return `Nothing was started: ${taskName} is no longer on ${STAGE_DISPLAY_NAMES[arg.stage]}, so these decisions do not trigger its current stage.`;
  }
  const evidenceProgress =
    freshPlan === undefined
      ? undefined
      : countChecklistEvidenceProgressV1(freshPlan, progressRead.decoded.progress.planItemEvidence ?? [], progressRead.decoded.progress.planItemOwnerDecisions ?? []);
  const remaining = evidenceProgress?.gate.remaining;
  if (evidenceProgress === undefined || remaining === undefined) {
    return (
      "Nothing was started: the completeness gate could not be read " +
      (freshPlan === undefined
        ? "(plan-final.md is missing or unreadable)"
        : "(plan-final.md has no checklist the gate can count)") +
      `. ${NOTHING_RUNS_NEXT_V1}`
    );
  }
  if (remaining > 0) {
    const display = evidenceProgress.display;
    const unticked = display.total - display.checked - display.closedWithoutDoing;
    if (unticked <= 0) {
      // The owner just settled every box, yet the gate still counts items
      // open: say so rather than dispatch a round to "build" ticked items.
      return (
        `Nothing was started. Every item is ticked or excluded in plan-final.md (${display.checked} ticked), but the completeness gate still counts ` +
        `${remaining} of ${display.total} as not yet verified: ${evidenceProgress.verified} verified by review, ${evidenceProgress.provisional} ticked without review verification. ` +
        "Building them again would only repeat finished work. Run a review to verify them, or move the task on yourself."
      );
    }
    // The dispatched command holds its own admission for its whole run
    // (resumeThenDispatchV1), so the form takes none: it would only race the
    // command it is about to start. A refusal that command records is read
    // here and reported in the form's one chat line.
    clearStageActionRefusalReasonV1(arg.taskFolderPath);
    await vscode.commands.executeCommand("vs-code-ai-helper.resumeAndApplyCurrentStageAction", {
      taskFolderPath: arg.taskFolderPath,
      displayName: arg.displayName,
      ...(arg.resumeFastForwardV1 ? { resumeFastForwardV1: arg.resumeFastForwardV1 } : {}),
    });
    const refusal = takeStageActionRefusalReasonV1(arg.taskFolderPath);
    if (refusal !== undefined) {
      return `The next step was not started: ${refusal.replace(/[.\s]+$/, "")}. ${remaining} item(s) are still open. ${NOTHING_RUNS_NEXT_V1}`;
    }
    return `${remaining} item(s) are still open, so ${taskName}'s stage action was dispatched to build them; its progress and outcome follow in this chat.`;
  }
  const configuredStages = await resolveConfiguredReviewStages(vscode.Uri.file(arg.taskFolderPath));
  const nextStage = computeNextStage(arg.stage, configuredStages);
  if (!nextStage) {
    return "Every plan item is now settled, and there is no further stage to advance to.";
  }
  const target: ChatTarget = {
    canonicalId: arg.taskFolderPath,
    taskFolderPath: arg.taskFolderPath,
    stage: arg.stage,
    taskName: arg.displayName,
  };
  const resumeFastForward = arg.resumeFastForwardV1 !== undefined;
  const nextStageName = STAGE_DISPLAY_NAMES[nextStage];
  const posted = await postWorkflowDecisionV1(
    {
      decisionKey: "openPlanItemsSettledOfferAdvance",
      taskCanonicalId: arg.taskFolderPath,
      stage: arg.stage,
      whatHappened: "Every plan checklist item is now settled — none are left open.",
      whyUserNeeded: "Advancing the stage is your call, not something Ensemble decides on its own.",
      options: [
        {
          optionId: "advance",
          label: `Advance to ${nextStageName}`,
          resumeKind: "continue",
          consequence:
            (resumeFastForward
              ? `Moves the task to ${nextStageName} and continues fast-forwarding there.`
              : `Moves the task to ${nextStageName} and dispatches its own next action there — starting its ` +
                "review, or applying an existing review's findings — unless that stage's next step is yours.") +
            " The plan checklist has nothing open, so nothing will be left unbuilt.",
          effect: {
            kind: "command",
            command: "vs-code-ai-helper.resumeAndSetTaskStage",
            args: [
              {
                taskFolderPath: arg.taskFolderPath,
                stage: nextStage,
                resumeFastForward,
                expectedSourceStage: arg.stage,
              },
            ],
          },
        },
        {
          optionId: "notNow",
          label: "Not now",
          resumeKind: "unpause",
          consequence: "Does nothing. Advance to the next stage yourself whenever you are ready.",
          effect: { kind: "doNothing" },
        },
      ],
      recommendation: {
        kind: "option",
        optionId: "advance",
        reasoning: "Nothing is left open at this stage, so there is nothing more for another round here to build.",
      },
      gating: {
        holdsTaskPaused: false,
        unblocksProgress: true,
        detail: "This card does not pause the task; choosing Advance is what moves it forward.",
      },
    },
    target
  );
  return posted
    ? `Every plan item is now settled; the Advance to ${nextStageName} card is in this chat.`
    : `Every plan item is now settled. Advance to ${nextStageName} when you are ready.`;
}

export function registerDecideOpenPlanItemsCommandV1(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND, (arg?: DecideOpenPlanItemsArgV1) => decideOpenPlanItemsV1(arg)),
    vscode.commands.registerCommand(TICK_ALL_COMMAND, (arg?: DecideOpenPlanItemsArgV1) => tickAllVerifiedOpenPlanItemsV1(arg))
  );
}

/**
 * RC2 item 13, Steps 50–51: the "nothing more to build" decision card's pure
 * content — built independently of WHERE it gets raised so its contract
 * (options, recommendation, gating) is directly testable. Wiring this into
 * the zero-file round-routing branch in `reviewActions.ts` (Step 50's other
 * half — an accepted report, no files changed, `remaining > 0`) is tracked
 * separately in plan-final.md and not done by this function.
 *
 * Per the requirement: three options, no bulk-exclude, "Decide item by item"
 * recommended, and `gating.holdsTaskPaused: false` — the card does not pause
 * the task.
 */
export function buildOpenPlanItemsNeedDecisionCardInputV1(input: {
  readonly taskFolderPath: string;
  readonly taskCanonicalId: string;
  readonly stage: TaskStage;
  readonly displayName?: string;
  readonly items: readonly OpenPlanItemReasonForDecisionV1[];
  readonly createdAt: string;
  /**
   * RC2 item 13, Step 52: captured NOW, at card-build time — see this
   * module's `decideOpenPlanItemsV1` doc comment for why the same "capture
   * now" rule `buildAdvanceOptionV1`/`buildPlateauKeepIteratingOptionV1` use
   * applies here too. Baked into the "Decide item by item" option's own args
   * so applying the owner's decisions later knows, without guessing, whether
   * to resume Fast Forward or arrange an ordinary continuing action.
   */
  readonly resumeFastForwardV1?: FastForwardRunStateV1;
  /**
   * bugs4 items 5 and 27: normalized keys of the items the latest review
   * verified complete, so they read "verified built by the review" instead of
   * "no reason given".
   */
  readonly reviewVerifiedKeys?: ReadonlySet<string>;
  /** Normalized keys of items the round durably claimed built (the classifier's built signal). */
  readonly builtClaimedKeys?: ReadonlySet<string>;
  /** bugs4 item 30: the plan's "N open, of which M are owner hand-offs" line. */
  readonly openSummary?: string;
  /**
   * bugs4 Step 20: the test commands the last editing round's summary says the provider refused.
   * Another round would be refused the same way, so the card points at the permission or tool setup.
   */
  readonly testsRefused?: TestsRefusedV1;
  readonly allowedTestCommand?: AllowedTestCommandV1;
}): Omit<CreateWorkflowDecisionInputV1, "decisionId"> {
  const { taskFolderPath, taskCanonicalId, stage, displayName, createdAt, resumeFastForwardV1 } = input;
  // bugs4 items 5 and 27: say why each item is open, from what the system knows.
  const classified = classifyOpenPlanItemsV1(input.items, input.reviewVerifiedKeys, input.builtClaimedKeys);
  const items: readonly OpenPlanItemReasonForDecisionV1[] = classified.map((item) => ({
    itemText: item.itemText,
    reason: item.reason,
  }));
  const count = items.length;
  const plural = count === 1 ? "item" : "items";
  const evidenceLines = formatClassifiedOpenPlanItemsV1(classified);
  const testEvidenceOnly = onlyMissingTestEvidenceV1(classified);
  const refusedCount = classified.filter((item) => item.category === "refused-by-round").length;
  const decideOption: WorkflowDecisionOptionV1 = {
    optionId: "decideItemByItem",
    label: "Decide item by item",
    resumeKind: "unpause",
    consequence:
      "Shows a form in this chat with every open item — exclude it with a reason, tick it because you already " +
      "did it, or leave it open — and writes your choices to plan-final.md in one pass when you press Apply, " +
      "with a dated Accepted Non-Goals entry for anything excluded. Items you leave open stay open. If " +
      "you change at least one item, it then builds whatever is still open, or offers Advance once nothing " +
      "is. If you leave every item open, nothing runs and the task waits until you fix what blocks them and " +
      "use Fast Forward or Apply Review.",
    effect: {
      kind: "command",
      command: "vs-code-ai-helper.decideOpenPlanItems",
      args: [
        {
          taskFolderPath,
          displayName,
          items,
          stage,
          ...(resumeFastForwardV1 ? { resumeFastForwardV1 } : {}),
        },
      ],
    },
  };
  const openPlanOption: WorkflowDecisionOptionV1 = {
    optionId: "openPlanFinal",
    label: "Open plan-final.md",
    resumeKind: "unpause",
    consequence: "Opens plan-final.md so you can review or edit the open items yourself. Nothing is applied for you.",
    effect: {
      kind: "command",
      command: "vs-code-ai-helper.openPlanNonGoals",
      args: [{ taskFolderPath }],
    },
  };
  const runTestingRoundOption: WorkflowDecisionOptionV1 = {
    optionId: "runTestingRound",
    label: "Run Implementation to run the tests",
    resumeKind: "continue",
    consequence:
      "Starts one ordinary Implementation round for this task. If it runs the tests these items need and reports " +
      "the passing command, the existing evidence rule can then settle them. Nothing is ticked for you, and the " +
      "round is not told to run any particular test.",
    effect: { kind: "command", command: "vs-code-ai-helper.runImplementationWithAI", args: [{ taskFolderPath }] },
  };
  // bugs4 Step 19: the owner ran the tests themselves (a Docker drill, a full suite) and records that.
  const awaitingReportTexts = classified
    .filter((item) => item.category === "awaiting-test-report" || (item.category === "verified-by-review-no-report" && item.testDependent))
    .map((item) => item.itemText);
  const ownerRanTestsOption: WorkflowDecisionOptionV1 = {
    optionId: "ownerRanTests",
    label: "I ran the tests myself",
    resumeKind: "unpause",
    consequence:
      "Shows a card in this chat where you pick the command you ran and whether it passed. A passing run is recorded " +
      `as your test report for the ${awaitingReportTexts.length} item(s) waiting only for one, marked as yours; nothing is ticked for you.`,
    effect: {
      kind: "command",
      command: POST_OWNER_TEST_RUN_CARD_COMMAND_V1,
      args: [{ taskFolderPath, displayName, stage, itemTexts: awaitingReportTexts }],
    },
  };
  const leaveOption: WorkflowDecisionOptionV1 = {
    optionId: "leaveOpen",
    label: "Leave them open",
    resumeKind: "unpause",
    consequence: "No change. This card does not pause the task, so it can keep working on anything else it still can.",
    effect: { kind: "doNothing" },
  };
  // bugs4 item 27: when the latest review verified every listed item built, settling them all is
  // one click. It is the owner's decision (owner provenance, as the form ticks); the card says so.
  const allReviewVerified = count > 0 && classified.every((item) => item.category === "verified-by-review-no-report");
  const tickAllOption: WorkflowDecisionOptionV1 = {
    optionId: "tickAllVerified",
    label: `Tick all ${count}: the review verified them built`,
    resumeKind: "unpause",
    consequence:
      `Ticks all ${count} ${plural} in plan-final.md in one pass and records them as your decision, ${TICK_ALL_VERIFIED_NOTE_V1}. ` +
      (classified.some((item) => item.testDependent)
        ? "Items that need a test report count as settled by you, not as test-verified; the report is still missing. "
        : "") +
      "It then builds whatever is still open, or offers Advance once nothing is.",
    effect: {
      kind: "command",
      command: TICK_ALL_COMMAND,
      args: [{ taskFolderPath, displayName, items, stage, ...(resumeFastForwardV1 ? { resumeFastForwardV1 } : {}) }],
    },
  };
  // bugs4 Step 20: the last editing round's test commands were refused. Another round is refused
  // the same way, so the recommendation is the setup or the owner's own run, never "run it again".
  const testsRefused = input.testsRefused;
  const refusedRemedy = testsRefused ? formatTestsRefusedRemedyV1(testsRefused, input.allowedTestCommand) : "";
  // The owner-run card can only record a run of a command a waiting item names; Ensemble never invents one.
  const ownerRunOffered = partitionItemsByNamedCommandV1(awaitingReportTexts).groups.length > 0;
  const baseOptions = testEvidenceOnly
    ? [runTestingRoundOption, ...(ownerRunOffered ? [ownerRanTestsOption] : []), decideOption, openPlanOption, leaveOption]
    : [decideOption, openPlanOption, leaveOption];
  const refusedRecommendation: WorkflowDecisionRecommendationV1 | undefined =
    testEvidenceOnly && testsRefused
      ? ownerRunOffered
        ? { kind: "option", optionId: "ownerRanTests", reasoning: `${refusedRemedy} Re-running the same round would be refused the same way.` }
        : { kind: "option", optionId: "decideItemByItem", reasoning: `${refusedRemedy} Re-running the same round would be refused the same way.` }
      : undefined;
  return {
    decisionKey: "openPlanItemsNeedDecision",
    taskCanonicalId,
    stage,
    whatHappened:
      `This round changed no files. The plan checklist still has ${count} open ${plural}` +
      (input.openSummary ? ` (plan-wide: ${input.openSummary})` : "") +
      `:\n\n${evidenceLines}`,
    whyUserNeeded: allReviewVerified
      ? "The latest review verified every open item built. They stay open only because the boxes are unticked or " +
        "no passing test report is recorded; ticking them is your decision to make." +
        (refusedRemedy ? ` ${refusedRemedy}` : "")
      : testEvidenceOnly
        ? "Every open item is waiting only for a passing test report. " +
          (testsRefused
            ? refusedRemedy
            : "An Implementation round that runs the named tests can produce it; you can still settle the items yourself.")
        : refusedCount === count
          ? "None of the open items look buildable by another round right now — each needs your decision: excluded, " +
            "already done, or genuinely still open."
          : "Some of these items need your decision; others are waiting on evidence a round can produce. Each item " +
            "above says which.",
    options: allReviewVerified ? [tickAllOption, ...baseOptions] : baseOptions,
    recommendation: allReviewVerified
      ? {
          kind: "option",
          optionId: "tickAllVerified",
          reasoning:
            `The latest review verified all ${count} ${plural} built. Ticking them is one click and is recorded as ` +
            "your decision, not as a test report or a review verification.",
        }
      : refusedRecommendation
        ? refusedRecommendation
        : testEvidenceOnly
      ? {
          kind: "option",
          optionId: "runTestingRound",
          reasoning:
            "The work is in the tree and only the passing test report is missing. A round that runs the tests " +
            "produces it, and the evidence rule then settles the items without you ticking them by hand.",
        }
      : {
          kind: "option",
          optionId: "decideItemByItem",
          reasoning:
            "Settling the items that need your decision is the way forward here instead of re-running the same " +
            "empty round.",
        },
    gating: {
      holdsTaskPaused: false,
      unblocksProgress: false,
      detail: "This card does not pause the task and dispatches nothing on its own; only its options act.",
    },
    createdAt,
  };
}
