/**
 * bugs3 Step 6: the chat offer to revert edits a provider made after it never
 * received its prompt, and the command behind it.
 *
 * The offer is a chat decision (never a pop-up). Declining writes nothing. The
 * command reverts only the paths that were clean before the round and still
 * match what the offer fingerprinted; see `undeliveredPromptEditsRevertV1.ts`.
 */
import * as vscode from "vscode";
import type { ChatTarget } from "../views/chatView";
import type { WorkflowDecisionCommandResultV1 } from "../types/workflowDecisionV1";
import { postWorkflowDecisionV1 } from "../utils/workflowDecisionDispatchV1";
import {
  captureRevertBaselineHeadV1,
  describeUndeliveredRevertOutcomeV1,
  findOpenUndeliveredPromptEditsRecordV1,
  fingerprintRevertTargetsV1,
  recordUndeliveredPromptEditsV1,
  revertUndeliveredPromptEditsV1,
  settleUndeliveredPromptEditsRecordV1,
  type UndeliveredEditScopeV1,
  type UndeliveredRevertTargetV1,
} from "../utils/undeliveredPromptEditsRevertV1";

export const REVERT_UNDELIVERED_PROMPT_EDITS_COMMAND_V1 = "vs-code-ai-helper.revertUndeliveredPromptEditsConfirmed";
export const UNDELIVERED_PROMPT_EDITS_DECISION_KEY_V1 = "revertUndeliveredPromptEdits";

export interface RevertUndeliveredPromptEditsArgsV1 {
  readonly cwd: string;
  readonly targets: readonly UndeliveredRevertTargetV1[];
  /** "revert" (default) restores the files; "keep" only settles the durable record. */
  readonly action?: "revert" | "keep";
  /** The task folder holding the durable record this offer was written to. */
  readonly taskFolderPath?: string;
  readonly recordId?: string;
  /** HEAD when the offer was made; the revert is refused once it moves. */
  readonly baselineHead?: string;
}

/**
 * Post the revert offer for a round whose provider never got its prompt.
 * Resolves true when a card was posted; nothing is posted when no changed
 * file was clean before the round.
 */
export async function offerUndeliveredPromptEditsRevertInChatV1(
  target: ChatTarget,
  providerLabel: string,
  scope: UndeliveredEditScopeV1
): Promise<boolean> {
  // Prefer what the runner read at the round boundary; only a scope without it
  // (an older caller) falls back to reading now.
  const targets = scope.targets ?? (await fingerprintRevertTargetsV1(scope.cwd, scope.revertable));
  const baselineHead = scope.baselineHead ?? (await captureRevertBaselineHeadV1(scope.cwd));
  if (targets.length === 0) {
    // Nothing to offer (every changed file was already modified before the round, or
    // none could be read back), but the delivery failure and what was observed are
    // still kept apart from ordinary quarantined edits, as an already-settled record.
    if (scope.revertable.length > 0 || scope.keptApart.length > 0) {
      const at = new Date().toISOString();
      const record = recordUndeliveredPromptEditsV1(target.taskFolderPath, {
        at,
        providerLabel,
        cwd: scope.cwd,
        ...(baselineHead !== undefined ? { baselineHead } : {}),
        revertable: [],
        keptApart: scope.keptApart,
      });
      settleUndeliveredPromptEditsRecordV1(target.taskFolderPath, record.id, "kept", at);
    }
    return false;
  }
  const record = recordUndeliveredPromptEditsV1(target.taskFolderPath, {
    at: new Date().toISOString(),
    providerLabel,
    cwd: scope.cwd,
    ...(baselineHead !== undefined ? { baselineHead } : {}),
    revertable: targets,
    keptApart: scope.keptApart,
  });
  const args: RevertUndeliveredPromptEditsArgsV1 = {
    cwd: scope.cwd,
    targets,
    action: "revert",
    taskFolderPath: target.taskFolderPath,
    recordId: record.id,
    ...(baselineHead !== undefined ? { baselineHead } : {}),
  };
  const keepArgs: RevertUndeliveredPromptEditsArgsV1 = { ...args, action: "keep" };
  const count = targets.length;
  const posted = await postWorkflowDecisionV1(
    {
      decisionKey: UNDELIVERED_PROMPT_EDITS_DECISION_KEY_V1,
      taskCanonicalId: target.canonicalId,
      stage: target.stage,
      whatHappened:
        `${providerLabel} never received the prompt for this round, yet changed ${count} file(s) that were unmodified before it began. ` +
        "Those changes were not asked for.",
      whyUserNeeded:
        "Reverting discards file content, so Ensemble will not do it without your say-so. Only these files are offered; " +
        "anything that was already modified before the round is left alone.",
      options: [
        {
          optionId: "revertUndeliveredEdits",
          resumeKind: "unpause",
          label: `Revert the ${count} file(s) the round changed`,
          destructive: true,
          consequence:
            "Restores each tracked file from your last commit and deletes each file the round created. A file you have edited since " +
            "this offer was made is left alone. This cannot be undone from within the extension. It does not run anything else.",
          effect: { kind: "command", command: REVERT_UNDELIVERED_PROMPT_EDITS_COMMAND_V1, args: [args] },
        },
        {
          optionId: "keepUndeliveredEdits",
          resumeKind: "unpause",
          label: "Keep them and review by hand",
          consequence:
            "Changes no file. The files stay as the round left them, outside the round's reviewed changes, and the offer is recorded as kept.",
          effect: { kind: "command", command: REVERT_UNDELIVERED_PROMPT_EDITS_COMMAND_V1, args: [keepArgs] },
        },
      ],
      recommendation: {
        kind: "none",
        reasoning: "Whether any of these edits is worth keeping is your call; none was asked for.",
      },
      gating: {
        holdsTaskPaused: false,
        unblocksProgress: false,
        detail: "This does not pause or resume the task. Re-run the round once the provider receives its prompt.",
      },
    },
    target
  );
  return posted !== undefined;
}

/** Whether the task folder already holds an offer the owner has not answered. */
export function hasOpenUndeliveredPromptEditsOfferV1(taskFolderPath: string): boolean {
  return findOpenUndeliveredPromptEditsRecordV1(taskFolderPath) !== undefined;
}

function isRevertArgsV1(value: unknown): value is RevertUndeliveredPromptEditsArgsV1 {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as {
    cwd?: unknown;
    targets?: unknown;
    action?: unknown;
    taskFolderPath?: unknown;
    recordId?: unknown;
    baselineHead?: unknown;
  };
  return (
    typeof candidate.cwd === "string" &&
    (candidate.action === undefined || candidate.action === "revert" || candidate.action === "keep") &&
    (candidate.taskFolderPath === undefined || typeof candidate.taskFolderPath === "string") &&
    (candidate.recordId === undefined || typeof candidate.recordId === "string") &&
    (candidate.baselineHead === undefined || typeof candidate.baselineHead === "string") &&
    Array.isArray(candidate.targets) &&
    candidate.targets.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { path?: unknown }).path === "string" &&
        typeof (entry as { fingerprint?: unknown }).fingerprint === "string"
    )
  );
}

/** The command behind the revert option: runs only when the owner chose it. */
export async function revertUndeliveredPromptEditsConfirmedV1(args: unknown): Promise<WorkflowDecisionCommandResultV1> {
  if (!isRevertArgsV1(args)) {
    return { outcome: "refused", message: "The revert offer carried no usable list of files, so nothing was reverted." };
  }
  const durable =
    args.taskFolderPath !== undefined && args.recordId !== undefined
      ? { folder: args.taskFolderPath, id: args.recordId }
      : undefined;
  if (durable !== undefined) {
    // An offer already answered (or replaced by a newer round's) cannot be acted on twice.
    const open = findOpenUndeliveredPromptEditsRecordV1(durable.folder);
    if (open === undefined || open.id !== durable.id) {
      return {
        outcome: "refused",
        message: "This offer was already answered or replaced by a newer one, so nothing was reverted.",
      };
    }
  }
  if (args.action === "keep") {
    if (durable !== undefined) {
      settleUndeliveredPromptEditsRecordV1(durable.folder, durable.id, "kept");
    }
    return { outcome: "done", message: "Kept: the files stay as the round left them." };
  }
  const outcome = await revertUndeliveredPromptEditsV1(
    args.cwd,
    args.targets,
    undefined,
    args.baselineHead
  );
  const message = describeUndeliveredRevertOutcomeV1(outcome);
  if (outcome.restored.length + outcome.deleted.length === 0) {
    return { outcome: "refused", message };
  }
  if (durable !== undefined) {
    settleUndeliveredPromptEditsRecordV1(durable.folder, durable.id, "reverted");
  }
  return { outcome: "done", message };
}

export function registerUndeliveredPromptEditsCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(REVERT_UNDELIVERED_PROMPT_EDITS_COMMAND_V1, (args: unknown) =>
      revertUndeliveredPromptEditsConfirmedV1(args)
    )
  );
}
