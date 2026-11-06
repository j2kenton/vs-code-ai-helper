/**
 * review1 Step 50: "I ran it — record the result". A `needs-toolchain` or owner-evidence blocker asks for a command
 * the stage cannot run (a Docker drill, a full integration run); the owner runs it outside the task. This records
 * what happened — the command, the exit code, when, and the tail of the output — under `## Owner evidence` in
 * task.md, bound to the blocker's lineage id and attributed to the owner, then re-runs the stage's review so it
 * reads the record. A reviewer may still disagree, but it has to cite the record.
 *
 * The inputs are a chat form (`ownerRunFormV1`): choosing the option posts it, and submitting it comes back to this
 * command with the typed values. The chat settles the form (chatView), so no input box opens outside the chat.
 */
import * as vscode from "vscode";
import { randomBytes } from "crypto";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import { TaskStage } from "../types/taskProgress";
import { WorkflowDecisionCommandResultV1 } from "../types/workflowDecisionV1";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { LOCAL_ONLY_INTERACTION_ACTION_KEY_V1 } from "../utils/chatHistoryStore";
import { RECORD_OWNER_RUN_COMMAND_V1, redactSecretsFromCommandOutputV1 } from "../utils/ownerEvidenceCommandAllowlistV1";
import { buildOwnerRunFormV1 } from "../utils/ownerRunFormV1";
import { normalizePath } from "../utils/taskRoot";
import type { ChatViewProvider } from "../views/chatView";
import { recordOwnerTestRunV1 } from "./recordOwnerTestRunV1";
import { resumeAndRerunReviewV1 } from "./resumeTask";

/** The longest output tail kept in task.md; the rest is cut with a note. */
export const OWNER_RUN_OUTPUT_TAIL_LIMIT_CHARS_V1 = 4_000;

export interface RecordOwnerRunArgV1 {
  readonly taskFolderPath: string;
  readonly stage: TaskStage;
  /** The blocker text the run answers. */
  readonly blocker: string;
  /** The blocker's lineage id (`blockerOwnerIdentityV1`), the key the record is bound to. */
  readonly blockerLineageId: string;
  /** Filled in by the chat form when it is submitted; all absent on the first call, which posts the form. */
  readonly command?: string;
  readonly exitCode?: string | number;
  readonly outputTail?: string;
}

export interface RecordOwnerRunDepsV1 {
  /** Posts the chat form asking for the command, exit code and output tail. */
  readonly postForm: (arg: RecordOwnerRunArgV1, suggestedCommand: string | undefined) => Promise<void>;
  readonly record: typeof recordOwnerTestRunV1;
  /** Resumes the task and re-runs the stage's review; resolves true only when the review was dispatched. */
  readonly rerunReview: (taskFolderPath: string) => Promise<boolean>;
}

function isValidArg(arg: RecordOwnerRunArgV1 | undefined): arg is RecordOwnerRunArgV1 {
  return (
    !!arg &&
    typeof arg.taskFolderPath === "string" &&
    arg.taskFolderPath !== "" &&
    typeof arg.blocker === "string" &&
    arg.blocker.trim() !== "" &&
    typeof arg.blockerLineageId === "string" &&
    arg.blockerLineageId.trim() !== ""
  );
}

/** The first command the blocker quotes in backticks, shown in the form as a hint. Never run. */
export function findQuotedCommandInTextV1(text: string): string | undefined {
  for (const match of text.matchAll(/`([^`\n]{3,300})`/g)) {
    const command = match[1]!.trim();
    if (/^(?:npm|npx|pnpm|yarn|node|docker|make|cargo|go|pytest|python|git|bash|sh)\b/.test(command)) return command;
  }
  return undefined;
}

/** A whole number, as typed ("0", " 1 "); anything else is undefined. */
export function parseExitCodeInputV1(text: string | number | undefined): number | undefined {
  const trimmed = String(text ?? "").trim();
  return /^-?\d{1,4}$/.test(trimmed) ? Number(trimmed) : undefined;
}

/** The output tail as it is kept: secrets removed, bounded to the end of the output. */
export function prepareOutputTailV1(raw: string): string {
  const redacted = redactSecretsFromCommandOutputV1(raw).trim();
  return redacted.length <= OWNER_RUN_OUTPUT_TAIL_LIMIT_CHARS_V1
    ? redacted
    : `[earlier output cut; last ${OWNER_RUN_OUTPUT_TAIL_LIMIT_CHARS_V1} characters kept]\n${redacted.slice(-OWNER_RUN_OUTPUT_TAIL_LIMIT_CHARS_V1)}`;
}

export async function recordOwnerRunCommandV1(
  arg: RecordOwnerRunArgV1 | undefined,
  deps: RecordOwnerRunDepsV1
): Promise<WorkflowDecisionCommandResultV1 | boolean> {
  if (!isValidArg(arg)) return false;
  // First call (the option was chosen): ask in the chat. The form comes back here with the typed values.
  if (arg.command === undefined && arg.exitCode === undefined && arg.outputTail === undefined) {
    await deps.postForm(arg, findQuotedCommandInTextV1(arg.blocker));
    return { outcome: "done", message: "Asked in the chat for the command you ran, its exit code and the end of its output." };
  }
  const command = (arg.command ?? "").trim();
  if (!command) return { outcome: "refused", message: "Nothing was recorded: no command was given." };
  const exitCode = parseExitCodeInputV1(arg.exitCode);
  if (exitCode === undefined) {
    return { outcome: "refused", message: "Nothing was recorded: the exit code has to be a whole number (0 means it passed)." };
  }
  const tailInput = arg.outputTail ?? "";
  const recorded = await deps.record({
    taskFolderPath: arg.taskFolderPath,
    formId: randomBytes(16).toString("hex"),
    command,
    exitCode,
    summary: "Recorded by the owner from a needs-toolchain or owner-evidence card: the owner ran it outside the task.",
    itemTexts: [],
    blockerLineageId: arg.blockerLineageId,
    blockerText: arg.blocker,
    ...(tailInput.trim().length > 0 ? { outputTail: prepareOutputTailV1(tailInput) } : {}),
  });
  if (!recorded.ok) return { outcome: "refused", message: recorded.reason };
  const started = await deps.rerunReview(arg.taskFolderPath);
  return {
    outcome: "done",
    message: started
      ? `${recorded.message} Re-running the review now.`
      : `${recorded.message} The review could not be started; run it from the stage action when ready.`,
  };
}

function newInteractionIdV1(): string {
  return allocateHex128IdV1();
}

export function registerRecordOwnerRunCommandV1(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  chatViewProvider: Pick<ChatViewProvider, "askInteraction">
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(RECORD_OWNER_RUN_COMMAND_V1, (arg?: RecordOwnerRunArgV1) =>
      recordOwnerRunCommandV1(arg, {
        postForm: async (formArg, suggestedCommand) => {
          const form = buildOwnerRunFormV1(
            {
              taskFolderPath: formArg.taskFolderPath,
              stage: formArg.stage,
              blocker: formArg.blocker,
              blockerLineageId: formArg.blockerLineageId,
            },
            RECORD_OWNER_RUN_COMMAND_V1,
            suggestedCommand
          );
          await chatViewProvider.askInteraction(
            {
              canonicalId: normalizePath(formArg.taskFolderPath),
              taskFolderPath: formArg.taskFolderPath,
              stage: formArg.stage as TaskStage,
              interactionId: newInteractionIdV1(),
              operationId: newInteractionIdV1(),
              actionKey: LOCAL_ONLY_INTERACTION_ACTION_KEY_V1,
              sourceAttemptId: newInteractionIdV1(),
              questions: form.questions,
              optionEffects: form.optionEffects,
            },
            true,
            { blocking: false }
          );
        },
        record: recordOwnerTestRunV1,
        rerunReview: (taskFolderPath) =>
          resumeAndRerunReviewV1(inventory, currentTaskStore, { taskFolderPath }, { skipUnchangedTreeGuardV1: true }),
      })
    )
  );
}
