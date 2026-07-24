import * as vscode from "vscode";
import * as path from "path";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { STAGE_DISPLAY_NAMES, TaskStage, RUNS_DIRNAME } from "../types/taskProgress";
import { IncompleteTask } from "../utils/taskProgressUtils";
import { resolveFreshModelForStage } from "../utils/modelSelection";
import {
  checkRunnerAvailabilityForModel,
  resolveRunnerForModel,
} from "../runners/runnerRegistry";
import { generateContextPack } from "../utils/contextPack";
import { ensureAiConsent } from "../utils/aiConsent";
import { checkAndConfirmPromptSize } from "../utils/promptSizeGuard";
import { ChatViewProvider } from "../views/chatView";
import { NotificationRouter } from "../utils/notificationRouter";
import { runTrackedOperation } from "../utils/taskOperations";
import { safeOpenTextDocument, stripAttributionHeaders, writeTextFile } from "../utils/fileUtils";
import { executeProposedAction } from "../utils/globalAssistantActions";
import { PendingOperationsStore } from "../state/pendingOperationsStore";
import { CurrentTaskStore } from "../utils/currentTaskStore";

type ChatWithStageArg =
  | { task?: IncompleteTask; stage?: TaskStage; message?: string }
  | { canonicalId?: string; taskFolderPath?: string; stage?: TaskStage; message?: string };

function normalizeArg(node: ChatWithStageArg | undefined): {
  resolverArg: { canonicalId?: string; taskFolderPath?: string } | undefined;
  stage: TaskStage | undefined; message: string | undefined;
} {
  if (!node) return { resolverArg: undefined, stage: undefined, message: undefined };
  if ("task" in node && node.task) {
    return { resolverArg: { taskFolderPath: node.task.folderUri.fsPath }, stage: node.stage, message: node.message };
  }
  const value = node as { canonicalId?: string; taskFolderPath?: string; stage?: TaskStage; message?: string };
  return {
    resolverArg: value.canonicalId || value.taskFolderPath
      ? { canonicalId: value.canonicalId, taskFolderPath: value.taskFolderPath }
      : undefined,
    stage: value.stage,
    message: value.message,
  };
}

/** Chat never invokes tools or edits code — the runner is the same text-only
 * planning/review runner used to answer questions (CLI providers run in
 * `mode: "text"`, native edit permissions withheld). Two extension-mediated
 * exceptions exist:
 *  - markdown: a response may propose the full replacement content of a
 *    single `.md` file that lives inside this task's own folder (its
 *    description, plan, or a review artifact), which this command applies
 *    directly. Anything outside that folder, or any non-markdown file, is
 *    never written. See docs/design/c4-chat-edit-spike-decision.md for why
 *    this envelope was chosen over enabling a provider's native edit mode.
 *  - stage actions: a response may propose exactly one of the four pinned
 *    stage actions for THIS task (see STAGE_CHAT_ACTIONS) via the shared
 *    typed `[[ACTION:<id>]]` envelope (legacy `[[STAGE_ACTION:<id>]]` is
 *    still accepted). The proposal is executed through the same typed action
 *    executor the global assistant uses (executeProposedAction), so the
 *    confirmation gate, state-accurate outcome verification, and audit
 *    logging are identical — the model never executes anything itself, and
 *    unlisted ids are rejected. */

/** One of the four pinned stage actions the stage chat may propose (the
 * approved catalog: complete stage, set this task's stage, trigger this
 * task's AI action, complete task). Each id IS a global-assistant operation
 * id: execution flows through the shared typed executor with the chat's own
 * task pinned as the payload target, so the chat path reuses exactly the
 * same confirmation, guards, and outcome verification as the global
 * assistant (which in turn delegates to the UI buttons' commands).
 * Task-lifecycle actions beyond the stage itself (pause, archive, pin,
 * reviews across tasks, …) belong to the global assistant, not stage chat. */
export interface StageChatActionDefinition {
  /** Global-assistant operation id this action executes as. */
  readonly id: string;
  /** Human label used in the outcome note. */
  readonly label: string;
  /** Shown to the model in the prompt so it knows what it may propose. */
  readonly description: string;
  /**
   * Payload keys the chat may pass through from the proposal envelope to the
   * operation (e.g. setTaskStage's target "stage"). Everything else in the
   * proposal payload is dropped, and the target task is ALWAYS the chat's
   * own task — the model can never retarget another task from stage chat.
   */
  readonly allowedPayloadKeys?: readonly string[];
}

const STAGE_ID_LIST = Object.keys(STAGE_DISPLAY_NAMES).join(", ");

export const STAGE_CHAT_ACTIONS: readonly StageChatActionDefinition[] = [
  {
    id: "completeStage",
    label: "Complete Stage & Move On",
    description: "complete the current stage and advance the task to its next stage",
  },
  {
    id: "setTaskStage",
    label: "Set Task Stage",
    description:
      `move this task to a specific stage — the envelope must carry the target stage, e.g. [[ACTION:setTaskStage {"stage": "<stage id>"}]] with a stage id from: ${STAGE_ID_LIST}`,
    allowedPayloadKeys: ["stage"],
  },
  {
    id: "triggerStageAI",
    label: "Apply Current Stage Action",
    description:
      "run the primary AI action for this task's current stage (uses provider quota)",
  },
  {
    id: "completeTask",
    label: "Complete Task",
    description: "mark this Publish-stage task as completed",
  },
];

export function getStageChatAction(
  id: string
): StageChatActionDefinition | undefined {
  return STAGE_CHAT_ACTIONS.find((action) => action.id === id);
}

/** A stage-chat action proposal extracted from a response envelope. The
 * payload (when present and valid JSON) is filtered later against the
 * action's `allowedPayloadKeys`; the target task is always pinned to the
 * chat's own task regardless of what the payload claims. */
export interface StageChatActionProposal {
  id: string;
  payload?: unknown;
}

/** Extracts every action envelope and returns the remaining text with all
 * envelopes removed — no envelope may survive into the displayed response,
 * whether or not it is executed. The stage chat shares the global
 * assistant's typed action protocol (`[[ACTION:<id> <optional json>]]`) and
 * still accepts the legacy `[[STAGE_ACTION:<id>]]` form. A JSON payload is
 * captured so actions that need one (setTaskStage's target stage) can use
 * it; unparseable payloads yield undefined and the operation's own
 * validation rejects them with a useful message. Pure and VS-Code-free so
 * the allowlist boundary is unit-testable without a host. */
export function splitStageActionEnvelopes(
  text: string
): { text: string; actions: StageChatActionProposal[] } {
  const actions: StageChatActionProposal[] = [];
  const remaining = text
    .replace(
      /\[\[(?:STAGE_)?ACTION:([A-Za-z0-9_-]+)(?:\s+([\s\S]*?))?\]\]/gi,
      (_whole, id: string, rawPayload: string | undefined) => {
        let payload: unknown;
        if (rawPayload && rawPayload.trim().length > 0) {
          try {
            payload = JSON.parse(rawPayload);
          } catch {
            payload = undefined;
          }
        }
        actions.push({ id, payload });
        return "";
      }
    )
    .trim();
  return { text: remaining, actions };
}

/**
 * Build the payload the shared typed executor receives for a stage-chat
 * action: the chat's own task is ALWAYS the target (pinned last so a
 * proposal can never override it), and only the action's allowlisted keys
 * are copied through from the proposal payload. Pure for unit testing.
 */
export function buildStageActionPayload(
  action: StageChatActionDefinition,
  taskFolderPath: string,
  proposalPayload: unknown
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (
    proposalPayload &&
    typeof proposalPayload === "object" &&
    action.allowedPayloadKeys
  ) {
    for (const key of action.allowedPayloadKeys) {
      const value = (proposalPayload as Record<string, unknown>)[key];
      if (value !== undefined) {
        payload[key] = value;
      }
    }
  }
  payload.taskFolder = taskFolderPath;
  return payload;
}

function describeStageActionsForPrompt(): string {
  return STAGE_CHAT_ACTIONS.map(
    (action) => `${action.id} — ${action.description}`
  ).join("; ");
}

/**
 * The markdown-update paragraph explicitly disclaims "any read-only or
 * plan-mode restriction" — worded that way specifically for opencode's
 * `plan` agent (see providers.ts's buildArgs comment), which stage chat
 * always selects via `mode: "text"`. That agent's plan-mode refusal is baked
 * into its own system prompt, not just its tool permissions, so a model can
 * decline the `[[UPDATE_FILE:...]]` envelope in read-only/plan-mode terms
 * even though the envelope invokes no tool at all. Live-verified against
 * opencode 1.18.4: this wording took a free model
 * (opencode/north-mini-code-free) that refused 100% of the time under the
 * prior wording ("you may do so directly") to roughly 2 of 3 attempts
 * emitting a valid envelope — a real improvement, NOT a guaranteed fix (the
 * same model still refused outright on one of three identical retries).
 * Models that already complied under the old wording (opencode/mimo-v2.5-free,
 * opencode/ling-3.0-flash-free) kept complying. See
 * isLikelyOpencodePlanModeRefusal below for the fallback when a refusal gets
 * through anyway.
 */
export function buildStageResponsePrompt(
  stageName: string, taskName: string, _artifactPath: string, contextPack: string, message: string, conversation = ""
): string {
  return `You are answering a user question about the ${stageName} stage for task ${taskName}.\n\nDo not invoke tools or propose that code changes were applied. If the user asks you to make a code change, tell them to use the stage action that applies it explicitly instead. However, the user may ask you to update this task's own markdown files (its task description, plan, or a review file) — this is not a file-edit action and uses no edit or write tool, so it is unaffected by any read-only or plan-mode restriction on your tool use: you are only composing text in your reply, and a separate already-trusted process outside this conversation reads that text and applies it on your behalf, the same as if you were dictating a paragraph for someone else to type. To draft an update, put the file's full new content, and nothing else, wrapped in \`[[UPDATE_FILE:relative-filename.md]]\`...\`[[/UPDATE_FILE]]\`, using a path relative to this task's own folder. Only one file may be drafted per response, only \`.md\` files inside this task's folder may be targeted this way, and you must never target a source code file. You may also run this task's own stage actions when the user asks for one: end your response with a single \`[[ACTION:<actionId>]]\` envelope (the same typed action protocol the global assistant uses; the legacy \`[[STAGE_ACTION:<actionId>]]\` form is also accepted) and the extension will confirm with the user and run it. Available action ids: ${describeStageActionsForPrompt()}. Propose at most one action per response, only when the user clearly asked for it — never speculatively. For other task-lifecycle requests (pausing, archiving, pinning, renaming, running or fast-forwarding reviews, …), point the user at the Global Assistant chat, which can run those. Give a concise, useful answer alongside any update or action. If you need clarification before the task can proceed, end with a single \`[[QUESTION]]your question[[/QUESTION]]\` envelope. Do not put task output in that envelope.\n\nConversation so far:\n${conversation.slice(-12000)}\n\nTask context:\n${contextPack.slice(0, 30000)}\n\nUser message:\n${message}`;
}

function splitQuestionEnvelope(text: string): { answer: string; question?: string } {
  const match = /\[\[QUESTION\]\]([\s\S]*?)\[\[\/QUESTION\]\]/i.exec(text);
  if (!match) return { answer: text };
  const question = (match[1] ?? "").trim();
  return { answer: text.replace(match[0], "").trim(), question: question || undefined };
}

export interface FileUpdateEnvelope {
  relPath: string;
  content: string;
}

/** Extracts every `[[UPDATE_FILE:path]]...[[/UPDATE_FILE]]` envelope and
 * returns the remaining text with all envelopes removed — no envelope may
 * survive into the displayed response, whether or not it is applied. Pure and
 * VS-Code-free so it's unit-testable without a host. */
export function splitFileUpdateEnvelopes(
  text: string
): { text: string; updates: FileUpdateEnvelope[] } {
  const updates: FileUpdateEnvelope[] = [];
  const remaining = text
    .replace(
      /\[\[UPDATE_FILE:([^\]\r\n]+)\]\]([\s\S]*?)\[\[\/UPDATE_FILE\]\]/gi,
      (_whole, relPath: string, content: string) => {
        updates.push({
          relPath: relPath.trim(),
          content: content.replace(/^\r?\n/, "").replace(/\r?\n$/, ""),
        });
        return "";
      }
    )
    .trim();
  return { text: remaining, updates };
}

export type ChatFileUpdatePlan =
  | { action: "none" }
  | { action: "reject"; note: string }
  | { action: "write"; relPath: string; targetPath: string; content: string };

/**
 * All-or-nothing validation of the chat-edit envelopes in one response.
 * The chat-edit contract allows exactly one markdown file per response, so a
 * response carrying several envelopes is rejected whole — zero writes — and
 * a single envelope is written only when its target passes
 * `resolveMarkdownUpdateTarget`. Pure so the zero-write policy is directly
 * unit-testable.
 */
export function planFileUpdate(
  taskFolderPath: string,
  updates: readonly FileUpdateEnvelope[]
): ChatFileUpdatePlan {
  if (updates.length === 0) return { action: "none" };
  if (updates.length > 1) {
    return {
      action: "reject",
      note:
        `_The response proposed updating ${updates.length} files at once; ` +
        `chat may update only one markdown file per response, so none were written. ` +
        `Ask for one file at a time._`,
    };
  }
  const update = updates[0];
  if (!update) return { action: "none" };
  const targetPath = resolveMarkdownUpdateTarget(taskFolderPath, update.relPath);
  if (!targetPath) {
    return {
      action: "reject",
      note: `_Could not update \`${update.relPath}\`: only markdown files inside this task's folder can be edited from chat._`,
    };
  }
  return { action: "write", relPath: update.relPath, targetPath, content: update.content };
}

/**
 * Resolve a chat-proposed relative path to an absolute file path, but only
 * when it is a `.md` file that stays inside `taskFolderPath` — this is the
 * entire enforcement boundary for the C4 chat-edit capability (no code
 * files, no escaping the active task's own folder via `..` or an absolute
 * path). Returns `undefined` for anything that fails that check.
 */
export function resolveMarkdownUpdateTarget(
  taskFolderPath: string,
  relPath: string
): string | undefined {
  const trimmed = relPath.trim().replace(/\\/g, "/");
  if (!trimmed || path.isAbsolute(trimmed) || !/\.md$/i.test(trimmed)) {
    return undefined;
  }
  const resolved = path.resolve(taskFolderPath, trimmed);
  const rel = path.relative(taskFolderPath, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return undefined;
  }
  return resolved;
}

/**
 * Recognizes opencode's own `plan`-agent refusal language (READ-ONLY phase /
 * plan mode / its `.opencode/plans/*.md` permission grant) surviving into a
 * chat response with no `[[UPDATE_FILE:...]]` envelope. buildStageResponsePrompt's
 * reframing (see its own doc comment) reduces how often this happens but does
 * not eliminate it, since the refusal is baked into that agent's own system
 * prompt rather than gated by our envelope's wording. Matching it lets the
 * chat append a clarifying note instead of leaving opencode's confusing,
 * extension-unaware "I can only edit .opencode/plans/*.md" framing as the
 * user's entire answer. Deliberately narrow (three opencode-specific phrases)
 * so it never fires on an ordinary answer that happens to mention read-only
 * concepts for unrelated reasons.
 */
export function isLikelyOpencodePlanModeRefusal(responseText: string): boolean {
  return /\.opencode[\\/]plans|\bplan mode\b|read-only phase/i.test(responseText);
}

export const OPENCODE_PLAN_MODE_REFUSAL_NOTE =
  "_That refusal is opencode's own read-only \"plan\" mode declining to draft the update in its own terms — " +
  "not a real limitation here. This chat never uses opencode's native edit tool for `.md` updates; it only " +
  "reads the drafted text back and applies it itself. Try asking again, or switch this stage to a different " +
  "model in AI Models if opencode keeps declining._";

export async function chatWithStage(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  chatViewProvider: ChatViewProvider,
  explicitArg?: ChatWithStageArg,
  currentTaskStore?: CurrentTaskStore
): Promise<void> {
  const { resolverArg, stage, message } = normalizeArg(explicitArg);
  const task = await resolveTaskContext(inventory, resolverArg, { allowPaused: true });
  if (!task) {
    NotificationRouter.showWarning("No task found. Please select a task first.");
    return;
  }
  const targetStage = stage ?? task.progress.currentStage;
  if (!message?.trim()) {
    await chatViewProvider.open({
      canonicalId: task.canonicalId,
      taskFolderPath: task.taskFolderPath,
      stage: targetStage,
      // Chat labels always show the associated task: the display name when
      // set, otherwise the view falls back to the folder's date/task-ID code.
      taskName: task.progress.displayName,
    });
    return;
  }
  if (!(await ensureAiConsent(context))) return;

  const lockKey = task.taskFolderPath;
  // Set inside the tracked operation, executed AFTER it ends: the proposed
  // command claims the task's own operation lock (exclusively for reviews and
  // stage transitions), so running it while the chat operation is still live
  // would contend with it.
  let proposedAction: StageChatActionProposal | undefined;
  try {
    // Tracked, cancellable chat-response operation (taxonomy: terminal entry
    // only on failure/cancel — a successful turn's answer in the chat panel is
    // its own confirmation, so no per-turn success notification is emitted).
    await runTrackedOperation(lockKey, {
      label: "Chat",
      stage: targetStage,
      taskName: task.folderName,
      exclusive: false,
      kind: "chat-send",
      cancellable: true,
    }, async (op) => {
    const taskFolderUri = vscode.Uri.file(task.taskFolderPath);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(taskFolderUri);
    if (!workspaceFolder) throw new Error("The task is not inside an open workspace.");
    const { modelId } = await resolveFreshModelForStage(taskFolderUri, targetStage);
    if (!modelId) {
      NotificationRouter.showWarning(
        "No model is configured for this stage. Open Ensemble Settings and choose a primary model before continuing.",
        undefined,
        undefined,
        undefined,
        { command: "vs-code-ai-helper.openSettings", title: "Open Settings" }
      );
      return;
    }
    const { runner, nativeModelId, provider } = resolveRunnerForModel(modelId, targetStage, taskFolderUri);
    const { availability: available, providerLabel } = await checkRunnerAvailabilityForModel(modelId, targetStage);
    if (!available.available) throw new Error(available.reason ?? `${providerLabel} is unavailable.`);
    // Stage-scoped: each stage has a fully separate conversation, so the
    // prompt context never mixes in another stage's messages.
    const conversation = (await chatViewProvider.transcript(task.taskFolderPath, task.canonicalId, targetStage))
      .slice(-20)
      .map(entry => `${entry.role.toUpperCase()}: ${entry.text}`)
      .join("\n");
    const prompt = buildStageResponsePrompt(STAGE_DISPLAY_NAMES[targetStage], task.folderName, "",
      await generateContextPack(taskFolderUri, workspaceFolder.uri), message, conversation);
    const sizeCheck = await checkAndConfirmPromptSize(prompt, providerLabel);
    if (sizeCheck === "abort" || sizeCheck === "declined") return;

    const runsUri = vscode.Uri.joinPath(taskFolderUri, RUNS_DIRNAME);
    await vscode.workspace.fs.createDirectory(runsUri);
    const outputFile = vscode.Uri.joinPath(runsUri, `chat-${Date.now()}.md`);
    // The operation's own token guards the provider process, so the
    // Notifications-row cancel button aborts the real run.
    const result = await runner.run({ taskFolderUri, workspaceUri: workspaceFolder.uri, stage: targetStage, prompt, outputFile, modelId: nativeModelId }, op.token!);
    if (result.status === "cancelled") {
      await chatViewProvider.append("assistant", "Stage chat was cancelled.", targetStage, { canonicalId: task.canonicalId, taskFolderPath: task.taskFolderPath });
      return;
    }
    if (result.status !== "completed") throw new Error(result.errorMessage ?? "Stage chat did not complete.");
    const rawResponse = stripAttributionHeaders(new TextDecoder().decode(await vscode.workspace.fs.readFile(outputFile)).trim());
    const { text: withoutActions, actions } = splitStageActionEnvelopes(rawResponse);
    let actionNote = "";
    if (actions.length > 1) {
      actionNote =
        `\n\n_The response proposed ${actions.length} stage actions at once; ` +
        `chat may propose only one action per response, so none were run._`;
    } else if (actions.length === 1) {
      const proposal = actions[0]!;
      if (getStageChatAction(proposal.id)) {
        proposedAction = proposal;
      } else {
        actionNote = `\n\n_The response proposed an action ("${proposal.id}") that is not in the allowlisted stage-action registry; it was rejected and nothing was executed._`;
      }
    }
    const { text: withoutUpdate, updates } = splitFileUpdateEnvelopes(withoutActions);
    const plan = planFileUpdate(task.taskFolderPath, updates);
    let updateNote = "";
    if (plan.action === "write") {
      await writeTextFile(vscode.Uri.file(plan.targetPath), plan.content);
      updateNote = `\n\n_Updated \`${plan.relPath}\`._`;
      NotificationRouter.showInformation(`Chat AI updated ${plan.relPath} for ${task.folderName}.`, plan.targetPath);
      await safeOpenTextDocument(vscode.Uri.file(plan.targetPath), plan.relPath);
    } else if (plan.action === "reject") {
      updateNote = `\n\n${plan.note}`;
    } else if (provider === "opencode-cli" && isLikelyOpencodePlanModeRefusal(withoutUpdate)) {
      // No envelope was found ("none"), and the leftover text reads like
      // opencode's own plan-mode agent declining in its own permission
      // terms — see isLikelyOpencodePlanModeRefusal's doc comment.
      updateNote = `\n\n${OPENCODE_PLAN_MODE_REFUSAL_NOTE}`;
    }
    const response = splitQuestionEnvelope(`${withoutUpdate}${updateNote}${actionNote}`.trim());
    if (response.answer) await chatViewProvider.append("assistant", response.answer, targetStage, { canonicalId: task.canonicalId, taskFolderPath: task.taskFolderPath });
    if (response.question) {
      // Non-blocking: this chat exchange has already completed (the AI's
      // reply just happens to end in a question) — work elsewhere can still
      // proceed without an answer. ask()'s default `notify` (a warning, not
      // an error) reflects that; it also raises the internal Notifications
      // entry, so no separate call is needed here.
      await chatViewProvider.ask({ canonicalId: task.canonicalId, taskFolderPath: task.taskFolderPath, stage: targetStage, question: response.question });
    }
    if (!response.answer && !response.question) await chatViewProvider.append("assistant", "The stage AI did not return an answer.", targetStage, { canonicalId: task.canonicalId, taskFolderPath: task.taskFolderPath });
    });
  } catch (error) {
    // Rethrown out of the tracked operation so its terminal state is
    // `failed` (or `cancelled` when the token fired); reported here.
    const text = error instanceof Error ? error.message : String(error);
    await chatViewProvider.append("assistant", `Unable to respond: ${text}`, targetStage, { canonicalId: task.canonicalId, taskFolderPath: task.taskFolderPath });
    // The operation-notification bridge owns terminal operation entries.
    // Keep the failure in the chat transcript, but do not add a second
    // Notifications entry (or a native toast) beside the bridge-backed one.
    return;
  }

  // Runs after the chat's tracked operation has ended and released its slot:
  // the executed operation's underlying command claims the task's own
  // operation lock itself (and its eligibility guards run exactly as if the
  // UI button had been clicked). Execution goes through the SAME typed
  // action executor as the global assistant — confirmation gate, verified
  // (state-accurate) outcome, and audit logging included — with the chat's
  // own task pinned as the payload.
  if (proposedAction) {
    const action = getStageChatAction(proposedAction.id);
    if (!action) return;
    const chatTarget = { canonicalId: task.canonicalId, taskFolderPath: task.taskFolderPath };
    if (!currentTaskStore) {
      await chatViewProvider.append(
        "assistant",
        `_The proposed "${action.label}" action could not be executed in this context._`,
        targetStage,
        chatTarget
      );
      return;
    }
    const outcome = await executeProposedAction(
      {
        inventory,
        currentTaskStore,
        // Stage-chat action audits live in the task's own folder.
        assistantFolderUri: vscode.Uri.file(task.taskFolderPath),
        pendingOperations: new PendingOperationsStore(context.workspaceState),
      },
      {
        operationId: action.id,
        // The chat's own task is pinned as the target; only the action's
        // allowlisted payload keys (e.g. setTaskStage's "stage") pass
        // through from the proposal.
        payload: buildStageActionPayload(action, task.taskFolderPath, proposedAction.payload),
      }
    );
    await chatViewProvider.append("assistant", outcome, targetStage, chatTarget);
  }
}

export function registerChatWithStageCommand(context: vscode.ExtensionContext, inventory: TaskInventory, chatViewProvider: ChatViewProvider, currentTaskStore?: CurrentTaskStore): void {
  context.subscriptions.push(vscode.commands.registerCommand(
    "vs-code-ai-helper.chatWithStage", (arg?: ChatWithStageArg) => chatWithStage(context, inventory, chatViewProvider, arg, currentTaskStore)
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    "vs-code-ai-helper.postStageQuestion",
    // This command IS the notification's own "Open Chat" action — the user
    // already saw the "waiting for feedback" notification that led them
    // here, so re-invoking ask() must not raise another one.
    (question: import("../views/chatView").StageChatQuestion) => chatViewProvider.ask(question, false, false)
  ));
}
