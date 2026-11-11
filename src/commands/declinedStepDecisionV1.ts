/**
 * bugs6 item 46: a plan step that rounds decline twice for a reason no round can change on its own (it needs the full
 * suite, which rounds don't run; it is too large for one round) comes back every cycle with no one asked. This raises
 * one card for it, naming the step and quoting the reason, with three ways on:
 *
 * - "Build it; Publish Checks run the full suite": the next Apply Review prompt says, for this step, that the full suite
 *   is Publish Checks' job. No new round kind and no wider shell access.
 * - "Split the step": same-task sub-items under the step in the plan of record, without changing the frozen count.
 * - "Defer it to an owner check": the step's open items become excluded owner hand-offs in this task's checklist.
 */
import * as vscode from "vscode";
import type { TaskStage } from "../types/taskProgress";
import type { WorkflowDecisionCommandResultV1, WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import { normalizePath } from "../utils/taskRoot";
import { hasLiveWorkAdmissionBestEffortV1 } from "../state/workAdmissionV1";
import { withTaskLock } from "../state/taskStateStore";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { appendChatMessageV1 } from "../utils/chatHistoryStore";
import { readTextIfExists } from "../utils/fileUtils";
import { getCanonicalImplementationUri } from "../utils/implementationArtifactResolver";
import { addNestedChecklistItemsV1, listUnsettledPlanItemsV1, settleChecklistItemV1 } from "../utils/implementationChecklist";
import {
  findRepeatedlyDeclinedStepV1,
  type DeclinedStepV1,
  type RepeatedlyDeclinedStepV1,
} from "../utils/roundEarlyStopV1";
import { postWorkflowDecisionV1, type PostWorkflowDecisionInputV1 } from "../utils/workflowDecisionDispatchV1";

export const RESOLVE_DECLINED_STEP_COMMAND_V1 = "vs-code-ai-helper.resolveDeclinedStepV1";
const DECISION_KEY_PREFIX_V1 = "declinedStepTwice:";
/** The task-folder file that holds the owner's "build it" answers, read by the next Apply Review prompt. */
export const DECLINED_STEP_GUIDANCE_FILE_V1 = "declined-step-guidance-v1.json";

export interface ResolveDeclinedStepArgV1 {
  readonly taskFolderPath: string;
  readonly stage: TaskStage;
  readonly step: string;
  readonly action: "build" | "split" | "defer";
  readonly reason: string;
}

export function buildDeclinedStepDecisionInputV1(input: {
  readonly taskFolderPath: string;
  readonly stage: TaskStage;
  readonly found: RepeatedlyDeclinedStepV1;
}): PostWorkflowDecisionInputV1 {
  const { taskFolderPath, stage, found } = input;
  const arg = (action: ResolveDeclinedStepArgV1["action"]): ResolveDeclinedStepArgV1 => ({
    taskFolderPath,
    stage,
    step: found.step,
    action,
    reason: found.reason,
  });
  const why =
    found.kind === "full-suite"
      ? "it needs a full-suite run, which an editing round does not run (Publish Checks do)"
      : "it is too large for one round";
  const option = (
    optionId: string,
    label: string,
    consequence: string,
    action: ResolveDeclinedStepArgV1["action"]
  ): PostWorkflowDecisionInputV1["options"][number] => ({
    optionId,
    label,
    consequence,
    resumeKind: "unpause",
    effect: { kind: "command", command: RESOLVE_DECLINED_STEP_COMMAND_V1, args: [arg(action)] },
  });
  return {
    decisionKey: `${DECISION_KEY_PREFIX_V1}${normalizePath(taskFolderPath)}:${found.step}`,
    taskCanonicalId: normalizePath(taskFolderPath),
    stage,
    whatHappened:
      `${found.rounds} rounds in a row declined ${found.step} because ${why}. The reason the last round gave: “${found.reason}”`,
    whyUserNeeded:
      `Another round would decline ${found.step} again for the same reason, so nothing moves on it until you choose. ` +
      "None of these choices starts a round: Apply Review is still your click.",
    options: [
      option(
        "buildFullSuiteIsPublishChecks",
        "Build it; Publish Checks run the full suite",
        `The next Apply Review prompt tells the round that for ${found.step} the full suite is Publish Checks' job, so being unable to run it is not a reason to decline. No new kind of round and no wider shell access.`,
        "build"
      ),
      option(
        "splitStep",
        "Split the step",
        `Adds two same-task sub-items under ${found.step} in the plan of record, so each can be built in its own round. The plan's item count does not change; an open sub-item keeps the step open.`,
        "split"
      ),
      option(
        "deferToOwnerCheck",
        "Defer it to an owner check",
        `Marks the open items of ${found.step} as excluded owner hand-offs in this task's checklist: they count as settled for the build, and stay listed for you to check later.`,
        "defer"
      ),
      {
        optionId: "notNow",
        label: "Not now",
        consequence: "Does nothing. The step stays open and the next round may decline it again.",
        resumeKind: "unpause",
        effect: { kind: "doNothing" },
      },
    ],
    recommendation:
      found.kind === "full-suite"
        ? {
            kind: "option",
            optionId: "buildFullSuiteIsPublishChecks",
            reasoning: `${found.step} was declined only because rounds don't run the full suite; Publish Checks do, so the step can be built without it.`,
          }
        : {
            kind: "option",
            optionId: "splitStep",
            reasoning: `${found.step} is too large for one round; two smaller slices can each be built and reviewed.`,
          },
    gating: { holdsTaskPaused: false, unblocksProgress: true, detail: `${found.step} cannot move until you choose` },
  };
}

/**
 * After a round ends: when the task's rounds have now declined one step twice for a reason no round can change, raises
 * the card once for that step. Returns the posted card, or `undefined` when nothing repeated (or it was raised before).
 */
export async function raiseDeclinedStepCardIfRepeatedV1(
  taskFolderPath: string,
  stage: TaskStage
): Promise<WorkflowDecisionV1 | undefined> {
  const read = await readTaskProgressStrictV1(vscode.Uri.file(taskFolderPath));
  if (!read.ok) return undefined;
  const rows = (read.decoded.progress.roundLedger ?? []).flatMap((row) =>
    row.outcome?.declinedSteps !== undefined
      ? [{ declinedSteps: row.outcome.declinedSteps as readonly DeclinedStepV1[] }]
      : []
  );
  const raised = new Set(
    read.decoded.progress.roundLedger === undefined ? [] : await alreadyRaisedStepsV1(taskFolderPath)
  );
  const found = findRepeatedlyDeclinedStepV1(rows, raised);
  if (found === undefined) return undefined;
  await rememberRaisedStepV1(taskFolderPath, found.step);
  return postWorkflowDecisionV1(buildDeclinedStepDecisionInputV1({ taskFolderPath, stage, found }), {
    canonicalId: normalizePath(taskFolderPath),
    taskFolderPath,
    stage,
  });
}

interface GuidanceFileV1 {
  readonly raised?: readonly string[];
  readonly buildNotes?: readonly { readonly step: string; readonly at: string }[];
}

async function readGuidanceFileV1(taskFolderPath: string): Promise<GuidanceFileV1> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(vscode.Uri.file(taskFolderPath), DECLINED_STEP_GUIDANCE_FILE_V1));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as GuidanceFileV1;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

async function writeGuidanceFileV1(taskFolderPath: string, file: GuidanceFileV1): Promise<void> {
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(vscode.Uri.file(taskFolderPath), DECLINED_STEP_GUIDANCE_FILE_V1),
    new TextEncoder().encode(`${JSON.stringify(file, null, 2)}\n`)
  );
}

async function alreadyRaisedStepsV1(taskFolderPath: string): Promise<readonly string[]> {
  return (await readGuidanceFileV1(taskFolderPath)).raised ?? [];
}

async function rememberRaisedStepV1(taskFolderPath: string, step: string): Promise<void> {
  const file = await readGuidanceFileV1(taskFolderPath);
  if ((file.raised ?? []).includes(step)) return;
  await writeGuidanceFileV1(taskFolderPath, { ...file, raised: [...(file.raised ?? []), step] }).catch(() => undefined);
}

/** The sentence the next Apply Review prompt carries for the steps the owner answered "Build it" on; empty if none. */
export async function readDeclinedStepGuidanceV1(taskFolderPath: string): Promise<string> {
  const notes = (await readGuidanceFileV1(taskFolderPath)).buildNotes ?? [];
  if (notes.length === 0) return "";
  const steps = notes.map((note) => note.step).join(", ");
  return (
    `Owner decision: for ${steps}, the full suite is Publish Checks' job, not this round's. ` +
    "Being unable to run it is not a reason to decline: build the step, write its tests, and list the run you could not do under `## Verification`."
  );
}

const stepItemRe = (step: string): RegExp =>
  new RegExp(`^(?:\\[item:[0-9a-f]{16}\\]\\s*)?${step.replace(/\s+/g, "\\s+")}(?!\\d)`, "i");

/** The open top-level plan items of one step (`Step 12` also covers `Step 12 (guard): …`). */
export function openItemsOfStepV1(planOfRecord: string, step: string): string[] {
  const re = stepItemRe(step);
  return listUnsettledPlanItemsV1(planOfRecord)
    .filter((item) => !item.nested && re.test(item.text.trim()))
    .map((item) => item.text);
}

async function applyResolutionV1(arg: ResolveDeclinedStepArgV1): Promise<{ done: boolean; message: string }> {
  const folderUri = vscode.Uri.file(arg.taskFolderPath);
  if (arg.action === "build") {
    const file = await readGuidanceFileV1(arg.taskFolderPath);
    await writeGuidanceFileV1(arg.taskFolderPath, {
      ...file,
      buildNotes: [...(file.buildNotes ?? []).filter((n) => n.step !== arg.step), { step: arg.step, at: new Date().toISOString() }],
    });
    return {
      done: true,
      message: `Recorded: ${arg.step} will be built without a full-suite run (Publish Checks run it). The next Apply Review prompt says so. Click Apply Review when you are ready.`,
    };
  }
  const planUri = getCanonicalImplementationUri(folderUri);
  const plan = await readTextIfExists(planUri);
  if (plan === undefined) return { done: false, message: "The plan of record could not be read, so nothing was changed." };
  const items = openItemsOfStepV1(plan, arg.step);
  if (items.length === 0) {
    return { done: true, message: `${arg.step} has no open items left in the plan of record, so nothing was changed.` };
  }
  let next = plan;
  let changed = 0;
  if (arg.action === "split") {
    const parent = items[0]!;
    const result = addNestedChecklistItemsV1(next, parent, [
      `${arg.step}, slice 1: build the part that needs no full-suite run, with its tests, and record it`,
      `${arg.step}, slice 2: build the remaining part after slice 1`,
    ]);
    next = result.content;
    changed = result.added;
  } else {
    for (const item of items) {
      const settled = settleChecklistItemV1(next, item, "exclude", `deferred to an owner check after rounds declined it twice (${arg.reason.slice(0, 120)})`);
      if (settled.settledItemText !== undefined) {
        next = settled.content;
        changed += 1;
      }
    }
  }
  if (next === plan || changed === 0) return { done: false, message: `${arg.step} could not be changed in the plan of record.` };
  await vscode.workspace.fs.writeFile(planUri, new TextEncoder().encode(next));
  return {
    done: true,
    message:
      arg.action === "split"
        ? `Recorded: ${arg.step} now has two sub-items in the plan of record. The plan's item count is unchanged.`
        : `Recorded: ${changed} open item${changed === 1 ? "" : "s"} of ${arg.step} deferred to an owner check; they stay listed as excluded hand-offs.`,
  };
}

/** Command handler for the card's options. Refuses (and reopens the card) while a round holds the task. */
export async function resolveDeclinedStepV1(arg: ResolveDeclinedStepArgV1): Promise<WorkflowDecisionCommandResultV1> {
  if (arg.action !== "build" && hasLiveWorkAdmissionBestEffortV1(arg.taskFolderPath)) {
    return {
      outcome: "refused",
      reopenCard: true,
      message: "A round is running for this task, and the plan of record cannot be edited while it runs. The card is offered again when it ends.",
    };
  }
  const result = await withTaskLock(arg.taskFolderPath, () => applyResolutionV1(arg));
  await appendChatMessageV1(arg.taskFolderPath, {
    role: "assistant",
    text: result.message,
    stage: arg.stage,
    at: new Date().toISOString(),
  }).catch(() => undefined);
  return { outcome: result.done ? "done" : "refused", message: result.message };
}

export function registerDeclinedStepDecisionCommandV1(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(RESOLVE_DECLINED_STEP_COMMAND_V1, (arg: ResolveDeclinedStepArgV1) => resolveDeclinedStepV1(arg))
  );
}
