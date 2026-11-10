/**
 * bugs5 Step 27 (item 15): the card and command for a review whose scope is known to miss changed files.
 *
 * - "Add the M missing files and review again": adds them to the task's tracked review scope, then runs the
 *   stage's review again.
 * - "Accept the partial scope": records that the owner accepts this exact gap for this stage, then runs the
 *   review again so its score can count.
 */
import * as vscode from "vscode";
import { STAGE_ARTIFACT_FILENAMES, STAGE_DISPLAY_NAMES, type TaskStage } from "../types/taskProgress";
import { resolveConfiguredReviewStages } from "../utils/modelSelection";
import { computeNextStage } from "../utils/stageTransition";
import type { WorkflowDecisionCommandResultV1, WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import { normalizePath } from "../utils/taskRoot";
import { hasLiveWorkAdmissionBestEffortV1 } from "../state/workAdmissionV1";
import { armDeferredOptionRunV1 } from "../utils/deferredOptionRunV1";
import { taskOperations } from "../utils/taskOperations";
import { withTaskLock } from "../state/taskStateStore";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { updateImplReviewFiles } from "../utils/taskProgressTransforms";
import { appendChatMessageV1 } from "../utils/chatHistoryStore";
import { readFilesReadEarlierV1 } from "./reviewCoverageRecordV1";
import {
  listPendingWorkflowDecisionsForTaskV1,
  postWorkflowDecisionV1,
  PostWorkflowDecisionInputV1,
  withdrawWorkflowDecisionsByKeyV1,
} from "../utils/workflowDecisionDispatchV1";
import {
  PARTIAL_SCOPE_ACCEPTANCE_FILE_V1,
  PARTIAL_SCOPE_GAP_FILE_V1,
  PARTIAL_SCOPE_NO_GAP_RECORD_LINE_V1,
  PartialReviewScopeV1,
  PartialScopeAcceptanceV1,
  PartialScopeGapRecordV1,
  REVIEW_PARTIAL_SCOPE_MARKER_RE,
  acceptPartialLabelV1,
  addAndRereviewLabelV1,
  separatePassLabelV1,
  classifyScopeFilesV1,
  countedV1,
  describeAcceptedScopeChatLineV1,
  describePartialScopeNextClickV1,
  describeScopeFilesV1,
  recommendScopeOptionV1,
  isPartialScopeAcceptedV1,
  parsePartialScopeAcceptanceV1,
  parsePartialScopeGapRecordV1,
  partialScopeHoldReasonV1,
  qualifyReviewForPartialScopeV1,
} from "../utils/reviewPartialScopeV1";

export const RESOLVE_PARTIAL_REVIEW_SCOPE_COMMAND_V1 = "vs-code-ai-helper.resolvePartialReviewScopeV1";

export interface ResolvePartialReviewScopeArgV1 {
  readonly taskFolderPath: string;
  readonly stage: TaskStage;
  readonly action: "addAndRereview" | "accept" | "separatePass";
  readonly missingFiles: readonly string[];
  readonly hash: string;
}

/** The owner's stored acceptance of a partial scope, or `undefined` when there is none. */
export async function readPartialScopeAcceptanceV1(
  taskFolderPath: string
): Promise<PartialScopeAcceptanceV1 | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(vscode.Uri.file(taskFolderPath), PARTIAL_SCOPE_ACCEPTANCE_FILE_V1)
    );
    return parsePartialScopeAcceptanceV1(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return undefined;
  }
}

/** Keeps the gap a review ran with, so a later stop for it can put the card back (review2 Step 14). */
export async function rememberPartialScopeGapV1(
  taskFolderPath: string,
  record: Omit<PartialScopeGapRecordV1, "recordedAt">
): Promise<void> {
  const full: PartialScopeGapRecordV1 = { ...record, recordedAt: new Date().toISOString() };
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(vscode.Uri.file(taskFolderPath), PARTIAL_SCOPE_GAP_FILE_V1),
    new TextEncoder().encode(JSON.stringify(full, null, 2))
  );
}

/** The gap the stage's latest review ran with, or `undefined` when none was kept. */
export async function readPartialScopeGapV1(
  taskFolderPath: string,
  stage: TaskStage
): Promise<PartialScopeGapRecordV1 | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(vscode.Uri.file(taskFolderPath), PARTIAL_SCOPE_GAP_FILE_V1)
    );
    const record = parsePartialScopeGapRecordV1(JSON.parse(new TextDecoder().decode(bytes)));
    return record !== undefined && record.stage === stage ? record : undefined;
  } catch {
    return undefined;
  }
}

/**
 * review2 Step 14: a Fast Forward stop for a partial scope points at "the card that follows". When the owner answered
 * "Not now" (or the card was withdrawn) there is none, so this puts it back, or says plainly what to click instead.
 * Returns what it did, for tests and the stop line.
 */
export async function ensurePartialScopeCardOpenV1(options: {
  taskFolderPath: string;
  stage: TaskStage;
}): Promise<"already-open" | "re-posted" | "accepted" | "no-record"> {
  const canonicalId = normalizePath(options.taskFolderPath);
  const gap = await readPartialScopeGapV1(options.taskFolderPath, options.stage);
  if (gap === undefined) {
    await appendChatMessageV1(options.taskFolderPath, {
      role: "assistant",
      text: PARTIAL_SCOPE_NO_GAP_RECORD_LINE_V1,
      stage: options.stage,
      at: new Date().toISOString(),
    }).catch(() => undefined);
    return "no-record";
  }
  if (isPartialScopeAcceptedV1(await readPartialScopeAcceptanceV1(options.taskFolderPath), options.stage, gap.scope.hash)) {
    return "accepted";
  }
  const key = `partialReviewScope:${options.stage}:${gap.scope.hash}`;
  const open = listPendingWorkflowDecisionsForTaskV1(canonicalId).some((decision) => decision.decisionKey === key);
  if (open) {
    return "already-open";
  }
  await postPartialScopeDecisionV1({
    taskFolderPath: options.taskFolderPath,
    stage: options.stage,
    scope: gap.scope,
    score: gap.score,
    threshold: gap.threshold,
    scoreClears: gap.scoreClears,
    readEarlier: await readFilesReadEarlierV1(vscode.Uri.file(options.taskFolderPath), gap.scope.files),
  }).catch(() => undefined);
  await appendChatMessageV1(options.taskFolderPath, {
    role: "assistant",
    text:
      `The scope card for ${countedV1(gap.scope.missingCount, "file")} was no longer open, so it is back in the chat. ` +
      `${describePartialScopeNextClickV1(gap.scope)} Or choose Not now.`,
    stage: options.stage,
    at: new Date().toISOString(),
  }).catch(() => undefined);
  return "re-posted";
}

/** What follows the owner's answer: the review again, the stage advance, or nothing more. */
type ResolutionFollowUpV1 = "rereview" | "separate-pass" | "advance" | "none";

/** The stage's review artifact (plain text on disk), or `undefined` when there is none. */
async function readStageReviewTextV1(taskFolderPath: string, stage: TaskStage): Promise<{ uri: vscode.Uri; text: string } | undefined> {
  const filename = STAGE_ARTIFACT_FILENAMES[stage];
  if (!filename) return undefined;
  const uri = vscode.Uri.joinPath(vscode.Uri.file(taskFolderPath), filename);
  try {
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    return text.length > 0 ? { uri, text } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * review2 Step 25: the one hold both ways out of a review stage use. Reads the stage's review, the gap it recorded and
 * the owner's acceptance record. `undefined` means nothing holds; a string is the reason (with the next click).
 * `reviewContent` is passed when the caller already holds the text (Fast Forward reads it fresh from disk).
 */
export async function readPartialScopeHoldV1(
  taskFolderPath: string,
  stage: TaskStage,
  reviewContent?: string
): Promise<string | undefined> {
  const text = reviewContent ?? (await readStageReviewTextV1(taskFolderPath, stage))?.text;
  if (text === undefined || !REVIEW_PARTIAL_SCOPE_MARKER_RE.test(text)) return undefined;
  return partialScopeHoldReasonV1({
    reviewContent: text,
    stage,
    gap: await readPartialScopeGapV1(taskFolderPath, stage),
    acceptance: await readPartialScopeAcceptanceV1(taskFolderPath),
  });
}

async function carryOutResolutionLockedV1(arg: ResolvePartialReviewScopeArgV1): Promise<ResolutionFollowUpV1> {
  const folderUri = vscode.Uri.file(arg.taskFolderPath);
  const nowIso = new Date().toISOString();
  let followUp: ResolutionFollowUpV1 = "rereview";
  let acceptedLine: string | undefined;
  if (arg.action === "separatePass") {
    // review2 Step 23: nothing is recorded. The files the last review had no room for are carried to the front of the
    // next pack (`mergeCarriedOmittedFirstV1`), and the review's own coverage moved, so it is not an unchanged re-run.
    followUp = "separate-pass";
  } else if (arg.action === "addAndRereview") {
    await patchTaskProgressStrictV1(folderUri, (progress) => updateImplReviewFiles(progress, [...arg.missingFiles]), {
      skipLock: true,
    });
  } else {
    const record: PartialScopeAcceptanceV1 = {
      stage: arg.stage,
      hash: arg.hash,
      missingCount: arg.missingFiles.length,
      acceptedAt: nowIso,
    };
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(folderUri, PARTIAL_SCOPE_ACCEPTANCE_FILE_V1),
      new TextEncoder().encode(JSON.stringify(record, null, 2) + "\n")
    );
    // review2 Step 24: the acceptance applies to the review that is already there. Its note is rewritten now, and a
    // review that otherwise clears the stage moves it on with no new review (a re-run of an unchanged tree is refused
    // as "nothing has changed" anyway, and a re-run could score differently).
    const gap = await readPartialScopeGapV1(arg.taskFolderPath, arg.stage);
    const review = await readStageReviewTextV1(arg.taskFolderPath, arg.stage);
    if (gap !== undefined && gap.scope.hash === arg.hash && review !== undefined) {
      const qualified = qualifyReviewForPartialScopeV1(review.text, gap.scope, true);
      if (qualified !== review.text) {
        await vscode.workspace.fs.writeFile(review.uri, new TextEncoder().encode(qualified));
      }
      followUp = gap.scoreClears ? "advance" : "none";
      let nextName: string | undefined;
      try {
        const next = computeNextStage(arg.stage, await resolveConfiguredReviewStages(folderUri));
        nextName = next ? STAGE_DISPLAY_NAMES[next] : undefined;
      } catch {
        nextName = undefined;
      }
      acceptedLine = describeAcceptedScopeChatLineV1(
        arg.missingFiles,
        followUp === "advance" ? "moved-on" : "kept-stage",
        nextName
      );
    } else {
      acceptedLine = describeAcceptedScopeChatLineV1(arg.missingFiles, "rerun");
    }
  }
  await appendChatMessageV1(arg.taskFolderPath, {
    role: "assistant",
    text:
      arg.action === "separatePass"
        ? `Reviewing ${countedV1(arg.missingFiles.length, "file")} in a separate pass: the files the last review had no room for are read first.`
        : arg.action === "addAndRereview"
          ? `Added ${arg.missingFiles.length} changed file(s) to this review's scope. Running the review again.`
          : (acceptedLine ?? ""),
    stage: arg.stage,
    at: nowIso,
  }).catch(() => undefined);
  return followUp;
}

/** Command handler: record the owner's answer, then run what follows (the review again, or the stage advance). */
export async function resolvePartialReviewScopeV1(
  arg: ResolvePartialReviewScopeArgV1
): Promise<WorkflowDecisionCommandResultV1> {
  const followUp = async (what: ResolutionFollowUpV1): Promise<void> => {
    if (what === "advance") {
      await vscode.commands.executeCommand("vs-code-ai-helper.nextStage", { taskFolderPath: arg.taskFolderPath });
    } else if (what === "rereview") {
      await vscode.commands.executeCommand("vs-code-ai-helper.runReviewWithAI", { taskFolderPath: arg.taskFolderPath });
    } else if (what === "separate-pass") {
      await vscode.commands.executeCommand("vs-code-ai-helper.runReviewWithAI", {
        taskFolderPath: arg.taskFolderPath,
        skipUnchangedTreeGuardV1: true,
      });
    }
  };
  if (hasLiveWorkAdmissionBestEffortV1(arg.taskFolderPath)) {
    // A round is open: a write to the task folder now would be a foreign write to it. Carry the answer out as
    // soon as the task is free.
    armDeferredOptionRunV1({
      key: `partial-scope:${normalizePath(arg.taskFolderPath)}:${arg.stage}`,
      isTaskBusy: () => hasLiveWorkAdmissionBestEffortV1(arg.taskFolderPath),
      subscribeToTaskFree: (listener) => taskOperations.onDidEnd(() => listener()),
      carryOut: async () => {
        const what = await withTaskLock(arg.taskFolderPath, () => carryOutResolutionLockedV1(arg));
        await followUp(what);
        return { kind: "done" };
      },
      report: () => Promise.resolve(),
    });
    await appendChatMessageV1(arg.taskFolderPath, {
      role: "assistant",
      text:
        arg.action === "accept"
          ? "Your answer on the partial review scope is recorded. It is applied to the current review as soon as the running round ends, and the stage moves on if that review otherwise clears it."
          : "Your answer on the partial review scope is recorded. It is applied, and the review run again, as soon as the running round ends.",
      stage: arg.stage,
      at: new Date().toISOString(),
    }).catch(() => undefined);
    return { outcome: "done" };
  }
  const what = await withTaskLock(arg.taskFolderPath, () => carryOutResolutionLockedV1(arg));
  await followUp(what);
  return { outcome: "done" };
}

export function registerPartialScopeDecisionCommandV1(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      RESOLVE_PARTIAL_REVIEW_SCOPE_COMMAND_V1,
      async (arg: ResolvePartialReviewScopeArgV1) => resolvePartialReviewScopeV1(arg)
    )
  );
}

/**
 * Build the card input for a partial scope. Exported separately from the post so it can be tested without a
 * running extension.
 */
export function buildPartialScopeDecisionInputV1(options: {
  taskFolderPath: string;
  stage: TaskStage;
  scope: PartialReviewScopeV1;
  score: number | null;
  threshold: number;
  /** Whether the score would clear the stage if the whole change had been reviewed. Defaults to true. */
  scoreClears?: boolean;
  /** Files whose current content an earlier review read (the coverage record); the card says so per file. */
  readEarlier?: ReadonlySet<string>;
}): PostWorkflowDecisionInputV1 {
  const { taskFolderPath, stage, scope, score, threshold } = options;
  const scoreClears = options.scoreClears !== false;
  const canonicalId = normalizePath(taskFolderPath);
  const arg = (
    action: ResolvePartialReviewScopeArgV1["action"],
    missingFiles: readonly string[] = scope.files
  ): ResolvePartialReviewScopeArgV1 => ({
    taskFolderPath,
    stage,
    action,
    missingFiles,
    hash: scope.hash,
  });
  const causes = classifyScopeFilesV1(scope);
  const { notInList, sizeLimit } = causes;
  const total = scope.files.length;
  const whatHappenedCause =
    sizeLimit.length > 0
      ? `${countedV1(sizeLimit.length, "file")} ${sizeLimit.length === 1 ? "is" : "are"} in the review list, but this review had no room for ` +
        `${sizeLimit.length === 1 ? "it" : "them"} (size limit)` +
        (notInList.length > 0 ? `; ${notInList.length} ${notInList.length === 1 ? "is" : "are"} not in the list. ` : ". ")
      : "";
  const options_: PostWorkflowDecisionInputV1["options"] = [
    ...(notInList.length > 0
      ? [
          {
            optionId: "addAndRereview",
            label: addAndRereviewLabelV1(notInList.length),
            consequence:
              `Adds the ${countedV1(notInList.length, "file")} that ${notInList.length === 1 ? "is" : "are"} missing from the list to this review's scope and runs the review again.` +
              (sizeLimit.length > 0
                ? ` The ${countedV1(sizeLimit.length, "file")} cut by the size limit ${sizeLimit.length === 1 ? "is" : "are"} already in the list, so adding cannot change that.`
                : " Its score then covers the whole change."),
            resumeKind: "continue" as const,
            effect: {
              kind: "command" as const,
              command: RESOLVE_PARTIAL_REVIEW_SCOPE_COMMAND_V1,
              args: [arg("addAndRereview", notInList)],
            },
          },
        ]
      : []),
    ...(sizeLimit.length > 0
      ? [
          {
            optionId: "separatePass",
            label: separatePassLabelV1(sizeLimit.length),
            consequence:
              `Runs the review again with the ${countedV1(sizeLimit.length, "file")} this review had no room for first, so ` +
              `${sizeLimit.length === 1 ? "its" : "their"} code is read before anything else. Nothing is accepted and nothing is added to the list.`,
            resumeKind: "continue" as const,
            effect: {
              kind: "command" as const,
              command: RESOLVE_PARTIAL_REVIEW_SCOPE_COMMAND_V1,
              args: [arg("separatePass", sizeLimit)],
            },
          },
        ]
      : []),
    {
      optionId: "acceptPartial",
      label: acceptPartialLabelV1(total),
      consequence:
        `Records that you accept leaving ${total === 1 ? "this file" : `these ${total} files`} unreviewed and applies that to this review at once: ` +
        "its score now counts, and the stage moves on if the review otherwise clears it (no new review). " +
        "This holds for this stage only, and only for this exact set of files; a later review cut at a different set asks again.",
      resumeKind: "continue" as const,
      effect: { kind: "command" as const, command: RESOLVE_PARTIAL_REVIEW_SCOPE_COMMAND_V1, args: [arg("accept")] },
    },
    {
      optionId: "notNow",
      label: "Not now",
      consequence: "Does nothing. The stage stays where it is until you choose.",
      resumeKind: "unpause" as const,
      effect: { kind: "doNothing" as const },
    },
  ];
  return {
    decisionKey: `partialReviewScope:${stage}:${scope.hash}`,
    taskCanonicalId: canonicalId,
    stage,
    whatHappened:
      `This review scored ${score ?? "unscored"}/10 (threshold ${threshold}), but it was not shown the whole change. ` +
      `${scope.summary}. ` +
      whatHappenedCause +
      (scoreClears
        ? "The stage was not advanced."
        : "Whatever the score, it says nothing about the files it was not shown, so the stage cannot clear until they are reviewed or accepted."),
    whyUserNeeded:
      `${countedV1(total, "changed file")} ${total === 1 ? "was" : "were"} not shown to this review, so a high score says nothing about ` +
      `${total === 1 ? "it" : "them"}. Either ${total === 1 ? "it" : "they"} should be reviewed, or you accept that ${total === 1 ? "it is" : "they are"} not.`,
    evidence: [{ label: "Details", detail: describeScopeFilesV1(scope, options.readEarlier) }],
    options: options_,
    recommendation: recommendScopeOptionV1(causes),
    gating: {
      holdsTaskPaused: false,
      unblocksProgress: true,
      detail: "the stage advance",
    },
  };
}

export async function postPartialScopeDecisionV1(options: {
  taskFolderPath: string;
  stage: TaskStage;
  scope: PartialReviewScopeV1;
  score: number | null;
  threshold: number;
  scoreClears?: boolean;
  readEarlier?: ReadonlySet<string>;
}): Promise<WorkflowDecisionV1 | undefined> {
  const canonicalId = normalizePath(options.taskFolderPath);
  // review2 Step 22: one open scope card per stage. A newer review's card replaces the stage's earlier ones (each has
  // its own key, since the key carries the gap's hash).
  const newKey = `partialReviewScope:${options.stage}:${options.scope.hash}`;
  const target = { taskFolderPath: options.taskFolderPath, canonicalId };
  for (const earlier of listPendingWorkflowDecisionsForTaskV1(canonicalId)) {
    if (earlier.decisionKey.startsWith(`partialReviewScope:${options.stage}:`) && earlier.decisionKey !== newKey) {
      await withdrawWorkflowDecisionsByKeyV1(
        target,
        earlier.decisionKey,
        "a newer review of this stage raised its own scope card, which replaces this one"
      ).catch(() => undefined);
    }
  }
  return postWorkflowDecisionV1(buildPartialScopeDecisionInputV1(options), {
    canonicalId,
    taskFolderPath: options.taskFolderPath,
    stage: options.stage,
  });
}
