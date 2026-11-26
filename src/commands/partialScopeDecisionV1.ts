/**
 * bugs5 Step 27 (item 15): the card and command for a review whose scope is known to miss changed files.
 *
 * - "Add the M missing files and review again": adds them to the task's tracked review scope, then runs the
 *   stage's review again.
 * - "Accept the partial scope": records that the owner accepts this exact gap for this stage, then runs the
 *   review again so its score can count.
 */
import * as vscode from "vscode";
import type { TaskStage } from "../types/taskProgress";
import type { WorkflowDecisionCommandResultV1, WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import { normalizePath } from "../utils/taskRoot";
import { hasLiveWorkAdmissionBestEffortV1 } from "../state/workAdmissionV1";
import { armDeferredOptionRunV1 } from "../utils/deferredOptionRunV1";
import { taskOperations } from "../utils/taskOperations";
import { withTaskLock } from "../state/taskStateStore";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { updateImplReviewFiles } from "../utils/taskProgressTransforms";
import { appendChatMessageV1 } from "../utils/chatHistoryStore";
import { postWorkflowDecisionV1, PostWorkflowDecisionInputV1 } from "../utils/workflowDecisionDispatchV1";
import {
  PARTIAL_SCOPE_ACCEPTANCE_FILE_V1,
  PartialReviewScopeV1,
  PartialScopeAcceptanceV1,
  parsePartialScopeAcceptanceV1,
} from "../utils/reviewPartialScopeV1";

export const RESOLVE_PARTIAL_REVIEW_SCOPE_COMMAND_V1 = "vs-code-ai-helper.resolvePartialReviewScopeV1";

export interface ResolvePartialReviewScopeArgV1 {
  readonly taskFolderPath: string;
  readonly stage: TaskStage;
  readonly action: "addAndRereview" | "accept";
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

async function carryOutResolutionLockedV1(arg: ResolvePartialReviewScopeArgV1): Promise<void> {
  const folderUri = vscode.Uri.file(arg.taskFolderPath);
  const nowIso = new Date().toISOString();
  if (arg.action === "addAndRereview") {
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
  }
  await appendChatMessageV1(arg.taskFolderPath, {
    role: "assistant",
    text:
      arg.action === "addAndRereview"
        ? `Added ${arg.missingFiles.length} changed file(s) to this review's scope. Running the review again.`
        : `Accepted the partial scope (${arg.missingFiles.length} changed file(s) not reviewed). Running the review again so its score can count.`,
    stage: arg.stage,
    at: nowIso,
  }).catch(() => undefined);
}

/** Command handler: record the owner's answer, then run the stage's review again. */
export async function resolvePartialReviewScopeV1(
  arg: ResolvePartialReviewScopeArgV1
): Promise<WorkflowDecisionCommandResultV1> {
  const rereview = async (): Promise<void> => {
    await vscode.commands.executeCommand("vs-code-ai-helper.runReviewWithAI", { taskFolderPath: arg.taskFolderPath });
  };
  if (hasLiveWorkAdmissionBestEffortV1(arg.taskFolderPath)) {
    // A round is open: a write to the task folder now would be a foreign write to it. Carry the answer out as
    // soon as the task is free.
    armDeferredOptionRunV1({
      key: `partial-scope:${normalizePath(arg.taskFolderPath)}:${arg.stage}`,
      isTaskBusy: () => hasLiveWorkAdmissionBestEffortV1(arg.taskFolderPath),
      subscribeToTaskFree: (listener) => taskOperations.onDidEnd(() => listener()),
      carryOut: async () => {
        await withTaskLock(arg.taskFolderPath, () => carryOutResolutionLockedV1(arg));
        await rereview();
        return { kind: "done" };
      },
      report: () => Promise.resolve(),
    });
    await appendChatMessageV1(arg.taskFolderPath, {
      role: "assistant",
      text: "Your answer on the partial review scope is recorded. It is applied, and the review run again, as soon as the running round ends.",
      stage: arg.stage,
      at: new Date().toISOString(),
    }).catch(() => undefined);
    return { outcome: "done" };
  }
  await withTaskLock(arg.taskFolderPath, () => carryOutResolutionLockedV1(arg));
  await rereview();
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
}): PostWorkflowDecisionInputV1 {
  const { taskFolderPath, stage, scope, score, threshold } = options;
  const canonicalId = normalizePath(taskFolderPath);
  const arg = (action: ResolvePartialReviewScopeArgV1["action"]): ResolvePartialReviewScopeArgV1 => ({
    taskFolderPath,
    stage,
    action,
    missingFiles: scope.files,
    hash: scope.hash,
  });
  return {
    decisionKey: `partialReviewScope:${stage}:${scope.hash}`,
    taskCanonicalId: canonicalId,
    stage,
    whatHappened:
      `This review scored ${score ?? "unscored"}/10 (threshold ${threshold}), but it was not shown the whole change. ` +
      `${scope.summary}. The stage was not advanced.`,
    whyUserNeeded:
      `${scope.missingCount} changed file(s) were never part of the review, so a high score says nothing about them. ` +
      "Either they should be reviewed, or you accept that they are not.",
    evidence: [{ label: "Details", detail: scope.files.slice(0, 40).join("\n") + (scope.files.length > 40 ? `\n… and ${scope.files.length - 40} more` : "") }],
    options: [
      {
        optionId: "addAndRereview",
        label: `Add the ${scope.missingCount} missing files and review again (Recommended)`,
        consequence:
          `Adds the ${scope.missingCount} files to this review's scope and runs the review again, so its score covers the whole change.`,
        resumeKind: "continue",
        effect: { kind: "command", command: RESOLVE_PARTIAL_REVIEW_SCOPE_COMMAND_V1, args: [arg("addAndRereview")] },
      },
      {
        optionId: "acceptPartial",
        label: `Accept the partial scope (${scope.missingCount} files not reviewed)`,
        consequence:
          `Records that you accept leaving these ${scope.missingCount} files unreviewed, then runs the review again so its score can count. ` +
          "Nothing is asked again for this exact set of files.",
        resumeKind: "continue",
        effect: { kind: "command", command: RESOLVE_PARTIAL_REVIEW_SCOPE_COMMAND_V1, args: [arg("accept")] },
      },
      {
        optionId: "notNow",
        label: "Not now",
        consequence: "Does nothing. The stage stays where it is until you choose.",
        resumeKind: "unpause",
        effect: { kind: "doNothing" },
      },
    ],
    recommendation: {
      kind: "option",
      optionId: "addAndRereview",
      reasoning: "A review of part of the change can only vouch for that part; reviewing all of it is the only way the score means the task.",
    },
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
}): Promise<WorkflowDecisionV1 | undefined> {
  const canonicalId = normalizePath(options.taskFolderPath);
  return postWorkflowDecisionV1(buildPartialScopeDecisionInputV1(options), {
    canonicalId,
    taskFolderPath: options.taskFolderPath,
    stage: options.stage,
  });
}
