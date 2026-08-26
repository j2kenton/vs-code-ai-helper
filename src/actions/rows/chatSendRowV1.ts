/**
 * `chatSend.v1` registry row (plan §6.5, "Migrate remaining text actions").
 *
 * Target: task-local Chat (`<task-folder>/chat-v1.json`).
 * Completed-content type: `chat-message.v1`.
 * Provider mode: `text`.
 */
import * as path from "path";
import {
  ProviderTaskActionRowV1,
  TaskActionExecutionContextV1,
  TaskActionInputValidationResultV1,
  TaskActionPromotionCodeV1,
} from "../taskActionRegistryV1";
import { maxResponseBytesCeilingForModeV1 } from "../../types/agentExecutionV1";
import { CompletedContentV1 } from "../../types/aiResultEnvelope";

import { appendChatMessageV1, describeWorkflowStoreFailureV1 } from "../../utils/chatHistoryStore";
import { PLAN_FILENAME, PLAN_REVIEW_STAGES, STAGE_ARTIFACT_FILENAMES, TaskStage } from "../../types/taskProgress";
import {
  FileUpdateEnvelope,
  planFileUpdate,
  splitFileUpdateEnvelopes,
  splitResolvesBlockerMarkerV1,
} from "../../utils/chatFileUpdateEnvelope";
import {
  planStageAction,
  splitStageActionEnvelopes,
} from "../../utils/chatStageActionEnvelope";
import { parseReviewBlockers } from "../../utils/reviewReadiness";
import {
  ensureWorkflowTaskFolderRootV1,
  getWorkflowFileStoreV1,
} from "../../services/workflowRuntimeServicesV1";
import { WorkflowFileLocatorV1 } from "../../services/workflowFileStoreV1";

/** Generous bound for reading a review artifact just to count its recorded
 * blockers — reviews are prose documents, never anywhere near this size. */
const MAX_REVIEW_READ_BYTES_V1 = 4 * 1024 * 1024;

export const CHAT_SEND_ACTION_KEY_V1 = "chatSend.v1";

export interface ChatSendActionInputV1 {
  readonly prompt: string;
  readonly taskFolderPath?: string;
  readonly canonicalId?: string;
}

const MAX_PROMPT_LENGTH_V1 = 8 * 1024 * 1024;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** @internal exported for testing */
export function validateChatSendInputV1(
  rawInput: unknown
): TaskActionInputValidationResultV1 {
  if (typeof rawInput !== "object" || rawInput === null) {
    return { ok: false, reason: "input is not an object" };
  }
  const raw = rawInput as Record<string, unknown>;
  if (!isNonEmptyString(raw.prompt)) {
    return { ok: false, reason: "input is missing a non-empty \"prompt\" string" };
  }
  if (Buffer.byteLength(raw.prompt, "utf8") > MAX_PROMPT_LENGTH_V1) {
    return { ok: false, reason: "input \"prompt\" exceeds the maximum length" };
  }
  if (raw.taskFolderPath !== undefined && !isNonEmptyString(raw.taskFolderPath)) {
    return { ok: false, reason: "input \"taskFolderPath\" must be a non-empty string when present" };
  }
  if (raw.canonicalId !== undefined && !isNonEmptyString(raw.canonicalId)) {
    return { ok: false, reason: "input \"canonicalId\" must be a non-empty string when present" };
  }
  const allowedKeys = new Set(["prompt", "taskFolderPath", "canonicalId"]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, reason: `input has an unknown field: ${key}` };
    }
  }
  const validated: ChatSendActionInputV1 = {
    prompt: raw.prompt,
    ...(raw.taskFolderPath !== undefined ? { taskFolderPath: raw.taskFolderPath } : {}),
    ...(raw.canonicalId !== undefined ? { canonicalId: raw.canonicalId } : {}),
  };
  return { ok: true, input: validated };
}

function isChatMessageV1(
  content: CompletedContentV1
): content is Extract<CompletedContentV1, { contentType: "chat-message.v1" }> {
  return content.contentType === "chat-message.v1";
}

class ChatSendPromotionErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatSendPromotionErrorV1";
  }
}

/** Actually writes a validated markdown update to disk — split out of
 * {@link applyChatFileUpdateEnvelopesV1} so the blocker-supersession path
 * can plan the same write without performing it (it defers to a user
 * confirmation instead — see {@link detectBlockerSupersessionCandidateV1}).
 * Exported so `chatWithStage.ts` can perform the SAME write, with the SAME
 * revision-checked semantics, once the user confirms a proposed edit. */
export async function writeMarkdownUpdateV1(
  taskFolderPath: string,
  relPath: string,
  targetPath: string,
  content: string
): Promise<string> {
  const rootId = ensureWorkflowTaskFolderRootV1(taskFolderPath);
  const relativePath = path.relative(taskFolderPath, targetPath).split(path.sep).join("/");
  const locator: WorkflowFileLocatorV1 = { rootId, relativePath };
  const fileStore = getWorkflowFileStoreV1();
  const bytes = Buffer.from(content, "utf8");

  const stat = await fileStore.stat(locator);
  if (stat.kind !== "ok") {
    return `_Could not update \`${relPath}\`: ${describeWorkflowStoreFailureV1(stat)}._`;
  }
  if (stat.value.kind === "directory") {
    return `_Could not update \`${relPath}\`: the target is a directory, not a file._`;
  }
  const result =
    stat.value.kind === "file" && stat.value.revision !== undefined
      ? await fileStore.replaceFileExact(locator, bytes, stat.value.revision)
      : await fileStore.createFileExclusive(locator, bytes);
  if (result.kind !== "ok") {
    return `_Could not update \`${relPath}\`: ${describeWorkflowStoreFailureV1(result)}._`;
  }
  return `_Updated \`${relPath}\`._`;
}

/**
 * Applies the C4 chat-edit envelope (item 21, 2026-08-17..19 workflow-defects
 * batch): a response may propose the full replacement content of exactly one
 * markdown file inside this task's own folder. Returns an italic outcome
 * note to append to the displayed reply — file written, or why it was
 * refused — or `undefined` when the response carried no envelope at all.
 * Never throws: a write failure is a soft, chat-visible refusal, not a
 * promotion error, since the assistant's own text answer is still valid on
 * its own regardless of whether the file update landed.
 *
 * wf10 item 19: when {@link detectBlockerSupersessionCandidateV1} recognizes
 * this as a candidate blocker-resolving edit, the write is NOT performed here
 * — the `proposedEdit` field is returned instead, for the caller to persist
 * on the message and defer to a user confirmation, mirroring how a
 * `proposedStageAction` defers execution needing `vscode.window`.
 */
async function applyChatFileUpdateEnvelopesV1(
  taskFolderPath: string,
  stage: TaskStage,
  updates: readonly FileUpdateEnvelope[],
  resolvesBlocker: boolean
): Promise<{
  note: string | undefined;
  proposedEdit?: { relPath: string; content: string; blockerDescription: string; reviewStage: TaskStage };
}> {
  const plan = planFileUpdate(taskFolderPath, updates);
  if (plan.action === "none") return { note: undefined };
  if (plan.action === "reject") return { note: plan.note };

  const blockerDescription = await detectBlockerSupersessionCandidateV1(
    taskFolderPath,
    stage,
    { relPath: plan.relPath, content: plan.content },
    resolvesBlocker
  );
  if (blockerDescription !== undefined) {
    return {
      note: `_Drafted an update to \`${plan.relPath}\` that would resolve the blocker below — confirm to apply it._`,
      proposedEdit: { relPath: plan.relPath, content: plan.content, blockerDescription, reviewStage: stage },
    };
  }

  return { note: await writeMarkdownUpdateV1(taskFolderPath, plan.relPath, plan.targetPath, plan.content) };
}

/**
 * wf10 item 19: a chat edit to `plan.md` drafted while the chat's own stage
 * is a plan-review stage with exactly one recorded blocker, AND accompanied
 * by an explicit `[[RESOLVES_BLOCKER]]` marker from the model, is treated as
 * a candidate blocker-supersession edit rather than an ordinary chat file
 * update — see `ChatMessage.proposedBlockerSupersessionEdit`'s doc comment
 * for why this must be proposed and confirmed rather than auto-applied.
 *
 * The single-blocker cardinality guard stays: with two or more blockers on
 * record, "this resolves it" is genuinely ambiguous about which one, so this
 * returns `undefined` (ordinary auto-apply) even when the marker is present.
 * Only plan-review stages are covered — impl-review's plan-of-record is the
 * checklist file, ticked by a different, already-guarded mechanism
 * (applyReviewerVerifiedTicks.ts), not a free-text rewrite.
 *
 * Review-narrowed three times (2026-08-25, blocker `fc82d17d-…-3`): earlier
 * revisions tried to infer "does this edit resolve the blocker" from the
 * edit's own text — keyword overlap with the blocker's description, gated by
 * an ever-growing denylist of "still open" / "future promise" / single-word
 * negative-state phrasings. Each review round produced a new counterexample
 * sharing the blocker's vocabulary while describing it as unresolved, because
 * no fixed phrase list can enumerate every way natural language says "not
 * yet" — the review's own verdict was that this is unsound resolution
 * inference, not stage chat semantically concluding the blocker is resolved.
 *
 * The marker (`splitResolvesBlockerMarkerV1`,
 * `utils/chatFileUpdateEnvelope.ts`) replaces all of that with the one signal
 * that is actually reliable: the model's own judgement, made explicit instead
 * of re-derived from its prose. The model is instructed
 * (`buildStageResponsePrompt`, `chatWithStage.ts`) to include the marker
 * exactly when it has concluded, in the same turn, that the draft resolves
 * the stage's recorded blocker — the same judgement it already demonstrated
 * correctly in the original bug report. Its absence falls through to the
 * ordinary auto-apply path, exactly as an edit that failed the old lexical
 * check did — an unrelated wording fix or a typo, with no marker, is never
 * misread as a resolution. Nothing is written to `plan.md` for a candidate
 * edit until the user explicitly confirms it in a dialog naming the blocker
 * text (`ChatMessage.proposedBlockerSupersessionEdit`), which is the real
 * safety net either way and, unlike a heuristic, cannot be defeated by
 * phrasing.
 */
async function detectBlockerSupersessionCandidateV1(
  taskFolderPath: string,
  stage: TaskStage,
  update: FileUpdateEnvelope,
  resolvesBlocker: boolean
): Promise<string | undefined> {
  if (!resolvesBlocker) {
    return undefined;
  }
  if (!PLAN_REVIEW_STAGES.includes(stage)) {
    return undefined;
  }
  const normalizedRelPath = update.relPath.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalizedRelPath.toLowerCase() !== PLAN_FILENAME.toLowerCase()) {
    return undefined;
  }
  const reviewFilename = STAGE_ARTIFACT_FILENAMES[stage];
  if (!reviewFilename) {
    return undefined;
  }
  const rootId = ensureWorkflowTaskFolderRootV1(taskFolderPath);
  const fileStore = getWorkflowFileStoreV1();
  const read = await fileStore.readFileBounded({ rootId, relativePath: reviewFilename }, MAX_REVIEW_READ_BYTES_V1);
  if (read.kind !== "ok") {
    return undefined;
  }
  const blockers = parseReviewBlockers(read.value.bytes.toString("utf8"));
  if (blockers.length !== 1) {
    return undefined;
  }
  return blockers[0]!.description;
}

async function promoteChatSendContentV1(
  content: CompletedContentV1,
  context: TaskActionExecutionContextV1
): Promise<TaskActionPromotionCodeV1> {
  if (!isChatMessageV1(content)) {
    throw new ChatSendPromotionErrorV1("chatSend.v1 received a non-chat-message completed content");
  }
  const input = context.validatedInput as ChatSendActionInputV1;
  // None of the three bracket markers may survive into the displayed/
  // persisted text, whether or not each is acted on — strip all of them
  // unconditionally before anything else touches content.text.
  const { text: fileStrippedText, updates } = splitFileUpdateEnvelopes(content.text);
  const { text: markerStrippedText, resolvesBlocker } = splitResolvesBlockerMarkerV1(fileStrippedText);
  const { text: strippedText, actions } = splitStageActionEnvelopes(markerStrippedText);
  // Execution needs vscode.window (a confirmation dialog), unavailable
  // inside this pure promotion path, so a single recognized proposal is
  // carried on the persisted message for chatWithStage.ts to execute once
  // this promotion returns. Zero, multiple, or unrecognized proposals are
  // decided right here by planStageAction, since that verdict needs no UI.
  const stagePlan = planStageAction(actions);
  const proposedStageAction = stagePlan.action === "propose" ? stagePlan.proposal : undefined;
  const actionOutcomeNote = stagePlan.action === "reject" ? stagePlan.note : undefined;
  if (input.taskFolderPath) {
    let finalText = strippedText;
    const stage = (context.stage as TaskStage) ?? "desc";
    const fileOutcome = await applyChatFileUpdateEnvelopesV1(input.taskFolderPath, stage, updates, resolvesBlocker);
    for (const note of [fileOutcome.note, actionOutcomeNote]) {
      if (note) {
        finalText = finalText.length > 0 ? `${finalText}\n\n${note}` : note;
      }
    }
    const canonicalId = input.canonicalId ?? input.taskFolderPath;
    // Review-flagged (2026-08-23): a caller-computed read-then-full-write
    // (readChatHistory + writeChatHistory) silently discards any message a
    // concurrent writer (e.g. the scheduling-intent auto-start announcement)
    // appends in between. `appendChatMessageV1` re-reads and appends onto
    // the CURRENT document inside the shared per-document queue instead.
    await appendChatMessageV1(input.taskFolderPath, {
      role: "assistant",
      text: finalText,
      stage,
      at: new Date().toISOString(),
      ...(proposedStageAction ? { proposedStageAction } : {}),
      ...(fileOutcome.proposedEdit ? { proposedBlockerSupersessionEdit: fileOutcome.proposedEdit } : {}),
    }, canonicalId);
  }
  return "completed";
}

export function createChatSendRowV1(): ProviderTaskActionRowV1 {
  return {
    kind: "provider",
    actionKey: CHAT_SEND_ACTION_KEY_V1,
    routes: ["vs-code-ai-helper.chatWithStage"],
    eligibility: { statuses: ["active", "paused"], stages: "anyStage" },
    requiresTaskOperationLease: true,
    progressLabel: "Responding to AI…",
    validateInput: validateChatSendInputV1,
    loggingPolicy: { channel: "action.chatSend", includeResultMetrics: true },
    providerMode: "text",
    maxResponseBytes: maxResponseBytesCeilingForModeV1("text"),
    permittedResultKinds: ["completed", "questions", "cancelled", "failed"],
    completedContentType: "chat-message.v1",
    resumeSemantics: "sameOperation",
    buildPrompt: (context: TaskActionExecutionContextV1): string =>
      (context.validatedInput as ChatSendActionInputV1).prompt,
    promoteCompletedContent: promoteChatSendContentV1,
  };
}
