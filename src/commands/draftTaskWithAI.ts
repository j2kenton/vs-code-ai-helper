import * as vscode from "vscode";
import { TASK_DESCRIPTION_FILENAME, TASK_FILENAME } from "../types/taskProgress";
import { resolveFreshModelForStage } from "../utils/modelSelection";
import {
  backupModelsForStage,
  checkRunnerAvailabilityForModel,
  resolveRunnerForModel,
} from "../runners/runnerRegistry";
import { renderPromptTemplate } from "../utils/promptTemplates";
import { writeRunLog } from "../utils/runLog";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { ensureAiConsent } from "../utils/aiConsent";
import { checkAndConfirmPromptSize } from "../utils/promptSizeGuard";
import { getQuotaObservation, recordQuotaObservation } from "../utils/quota";
import {
  getCliProvider,
  normalizeQualifiedModelId,
  qualifiedRanModelId,
} from "../runners/providers";
import { NotificationRouter } from "../utils/notificationRouter";
import { safeOpenTextDocument } from "../utils/fileUtils";
import { ChatViewProvider } from "../views/chatView";
import type { AgentRunResult } from "../types/agentRunner";

import { shortcutHint } from "../utils/shortcutHints";
import { backupArtifactBeforeWrite, backupArtifactContents } from "../utils/artifactBackups";
import { patchTaskProgress, IncompleteTask } from "../utils/taskProgressUtils";
import {
  linkCancellationTokens,
  runTrackedOperation,
  taskOperations,
} from "../utils/taskOperations";

// Must match the placeholder paragraph in resources/prompts/task-template.md
// verbatim (including its line breaks) so it strips cleanly out of a fresh,
// undrafted task's pre-header content instead of leaking into
// taskDescription — where it would otherwise be treated as the user's own
// description (fed to the AI as such, and used to derive a task name).
const INTRO_TEXT = `Describe the work you want to do here in as much detail as is useful. When\nyou're ready, use **Draft with AI** to turn these notes into a structured task\ndescription. Questions from the stage AI appear in the **Chat With AI** panel.`;
const SHORTCUT_NOTE = `Shortcut: Apply Current Stage Action${shortcutHint("vs-code-ai-helper.applyCurrentStageAction")}.`;

/** Filename for the temporary AI output file used during draft-task runs. */
const DRAFT_TMP_FILENAME = "_draft-ai-output.tmp";

interface ParsedTaskDocument {
  introText: string;
  taskDescription: string;
  draftWithAI: string;
  openQuestions: string;
}

/**
 * Parse and normalize a task.md document into canonical sections.
 * Only exact top-level `## ` headers at line start, outside fenced code blocks,
 * are treated as canonical section delimiters.
 */
export function parseTaskDocument(content: string): ParsedTaskDocument {
  const lines = content.split(/\r?\n/);
  let inFencedBlock = false;

  interface Section {
    header: string | null; // null = pre-header content
    body: string[];
  }

  const sections: Section[] = [{ header: null, body: [] }];
  let currentSection = sections[0]!;

  for (const line of lines) {
    // Track fenced code blocks
    if (/^```/.test(line)) {
      inFencedBlock = !inFencedBlock;
      currentSection.body.push(line);
      continue;
    }

    if (!inFencedBlock && /^## /.test(line)) {
      const header = line.trim();
      currentSection = { header, body: [] };
      sections.push(currentSection);
    } else {
      currentSection.body.push(line);
    }
  }

  // Collect bodies for each canonical section (merging duplicates)
  const taskDescBodies: string[] = [];
  const draftBodies: string[] = [];
  const questionsBodies: string[] = [];
  let introText = "";
  let shortcutNote = "";

  for (const section of sections) {
    const bodyText = section.body.join("\n").trim();

    if (section.header === null) {
      // Pre-header content: check if it contains our known intro text
      const withoutIntro = bodyText
        .replace(INTRO_TEXT, "")
        .replace(SHORTCUT_NOTE, "")
        .trim();

      if (bodyText.includes(INTRO_TEXT)) {
        introText = INTRO_TEXT;
      }
      if (bodyText.includes(SHORTCUT_NOTE)) {
        shortcutNote = SHORTCUT_NOTE;
      }
      // Any remaining pre-header content goes into Task Description
      if (withoutIntro.length > 0) {
        taskDescBodies.push(withoutIntro);
      }
    } else if (section.header === "## Task Description") {
      if (bodyText.length > 0) {
        taskDescBodies.push(bodyText);
      }
    } else if (section.header === "## Draft with AI") {
      if (bodyText.length > 0) {
        draftBodies.push(bodyText);
      }
    } else if (section.header === "## Open Questions") {
      if (bodyText.length > 0) {
        questionsBodies.push(bodyText);
      }
    } else {
      // Non-canonical top-level headers: move body into Task Description
      const combined = section.header + "\n" + bodyText;
      taskDescBodies.push(combined);
    }
  }

  // Normalize intro: always use canonical values
  if (!introText) {
    introText = INTRO_TEXT;
  }
  if (!shortcutNote) {
    shortcutNote = SHORTCUT_NOTE;
  }

  return {
    introText: introText + "\n\n" + shortcutNote,
    taskDescription: taskDescBodies.join("\n\n").trim(),
    draftWithAI: draftBodies.join("\n\n").trim(),
    openQuestions: questionsBodies.join("\n\n").trim(),
  };
}

/**
 * Rebuild canonical task.md content from parsed sections.
 */
export function buildTaskDocument(parsed: ParsedTaskDocument): string {
  const parts: string[] = [];

  parts.push(parsed.introText);
  parts.push("");
  parts.push("## Task Description");
  parts.push("");
  if (parsed.taskDescription) {
    parts.push(parsed.taskDescription);
    parts.push("");
  }
  parts.push("## Draft with AI");
  parts.push("");
  if (parsed.draftWithAI) {
    parts.push(parsed.draftWithAI);
    parts.push("");
  }
  parts.push("## Open Questions");
  parts.push("");
  if (parsed.openQuestions) {
    parts.push(parsed.openQuestions);
    parts.push("");
  }

  return parts.join("\n");
}

/**
 * The fixed subsection contract for the AI draft: the `## Draft with AI`
 * body must contain these three headed subsections so the draft states
 * concrete work rather than abstract planning language. Enforced by
 * `validateDraftStructure` with one repair retry; a response that still
 * lacks them is accepted unstructured (fallback) with a notice rather than
 * discarded.
 */
export const DRAFT_REQUIRED_SUBSECTIONS = [
  "Behavior change",
  "Affected areas",
  "Actionable changes",
] as const;

/**
 * Check the draft body for the three required subsections (any heading
 * level, case-insensitive) AND a non-empty body under each — a response
 * with the right headings but empty sections is exactly the non-actionable
 * output the contract exists to prevent. Returns the missing/empty titles
 * so a repair prompt can name them precisely.
 */
export function validateDraftStructure(
  draftBody: string
): { valid: boolean; missing: string[] } {
  const lines = draftBody.split(/\r?\n/);
  interface Heading {
    lineIndex: number;
    title: string;
  }
  const headings: Heading[] = [];
  lines.forEach((line, lineIndex) => {
    const match = /^#{1,6}\s*(.*?)\s*$/.exec(line);
    if (match) {
      headings.push({ lineIndex, title: match[1]!.toLowerCase() });
    }
  });
  const missing = DRAFT_REQUIRED_SUBSECTIONS.filter((title) => {
    const at = headings.findIndex((h) => h.title === title.toLowerCase());
    if (at === -1) {
      return true;
    }
    const bodyStart = headings[at]!.lineIndex + 1;
    const bodyEnd =
      at + 1 < headings.length ? headings[at + 1]!.lineIndex : lines.length;
    return lines.slice(bodyStart, bodyEnd).join("\n").trim().length === 0;
  });
  return { valid: missing.length === 0, missing };
}

/**
 * Heading a structurally invalid draft is filed under when it is accepted
 * as a fallback (after the repair retry also failed), so the task document
 * makes the unstructured state explicit instead of silently presenting the
 * malformed draft as a finished one.
 */
export const DRAFT_UNSTRUCTURED_HEADING = "### Draft (unstructured)";

/**
 * Wrap a draft body that failed structure validation under the
 * `Draft (unstructured)` heading with a notice naming the missing/empty
 * subsections, so the fallback is visibly marked in task.md.
 */
export function wrapUnstructuredDraft(
  draftBody: string,
  missing: readonly string[]
): string {
  return [
    DRAFT_UNSTRUCTURED_HEADING,
    "",
    `> The AI response was missing (or had empty) required subsection(s) — ${missing.join(", ")} — even after a repair attempt. Review this draft and structure it manually, or run Draft with AI again.`,
    "",
    draftBody,
  ].join("\n");
}

/**
 * Normalize a heading line for robust matching:
 * - Strip leading `#` characters and whitespace (tolerate heading levels 1-6)
 * - Trim trailing whitespace
 * - Lowercase for case-insensitive comparison
 */
function normalizeHeading(line: string): string {
  return line.replace(/^#+\s*/, "").trim().toLowerCase();
}

/**
 * Parse the AI response for Draft with AI.
 *
 * Expects exactly one section matching "Draft with AI" and one matching
 * "Open Questions", identified by heading text (case-insensitive, any
 * heading level `#`–`######`, leading/trailing whitespace trimmed).
 * CRLF line endings are normalized to LF before parsing.
 *
 * Fails (returns undefined) if:
 *   - Either required section is missing
 *   - Either required section appears more than once
 *   - "Draft with AI" appears after "Open Questions"
 *   - Any unrecognized top-level heading is present
 *
 * Tolerates:
 *   - Heading level differences (# vs ##)
 *   - Heading case differences (DRAFT WITH AI vs Draft with AI)
 *   - Trailing heading whitespace
 *   - Extra blank lines between sections
 *   - CRLF vs LF line endings
 */
export function parseAIResponse(
  response: string
): { draftWithAI: string; openQuestions: string } | undefined {
  // Normalize CRLF -> LF
  const normalized = response.replace(/\r\n/g, "\n");

  // Split into lines and find heading positions
  const lines = normalized.split("\n");

  interface HeadingOccurrence {
    lineIndex: number;
    normalizedTitle: string;
  }

  const headings: HeadingOccurrence[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^#+\s/.test(line) || /^#+$/.test(line)) {
      headings.push({ lineIndex: i, normalizedTitle: normalizeHeading(line) });
    }
  }

  // Find occurrences of each required section by normalized title
  const draftOccurrences = headings.filter(
    (h) => h.normalizedTitle === "draft with ai"
  );
  const questionsOccurrences = headings.filter(
    (h) => h.normalizedTitle === "open questions"
  );
  // The draft body's own required subsections (see DRAFT_REQUIRED_SUBSECTIONS)
  // are body content, not unknown top-level sections — they must not make the
  // whole response "unrecognized".
  const knownSubsectionTitles = new Set<string>(
    DRAFT_REQUIRED_SUBSECTIONS.map((title) => title.toLowerCase())
  );
  const otherOccurrences = headings.filter(
    (h) =>
      h.normalizedTitle !== "draft with ai" &&
      h.normalizedTitle !== "open questions" &&
      !knownSubsectionTitles.has(h.normalizedTitle)
  );

  // Missing sections
  if (draftOccurrences.length === 0 || questionsOccurrences.length === 0) {
    return undefined;
  }

  // Duplicate sections
  if (draftOccurrences.length > 1 || questionsOccurrences.length > 1) {
    return undefined;
  }

  // Unrecognized sections
  if (otherOccurrences.length > 0) {
    return undefined;
  }

  const draftHeading = draftOccurrences[0]!;
  const questionsHeading = questionsOccurrences[0]!;

  // Wrong order
  if (draftHeading.lineIndex > questionsHeading.lineIndex) {
    return undefined;
  }

  // Extract body content between headings
  const draftBodyLines = lines.slice(
    draftHeading.lineIndex + 1,
    questionsHeading.lineIndex
  );
  const questionsBodyLines = lines.slice(questionsHeading.lineIndex + 1);

  const draftBody = draftBodyLines.join("\n").trim();
  const questionsBody = questionsBodyLines.join("\n").trim();

  return {
    draftWithAI: draftBody,
    openQuestions: questionsBody,
  };
}

/**
 * Detect the line ending style of a string.
 */
function detectEOL(content: string): string {
  if (content.includes("\r\n")) {
    return "\r\n";
  }
  return "\n";
}

/**
 * Attempt to delete the draft temp file, silently ignoring any error.
 * This is safe to call even if the file doesn't exist.
 */
async function deleteDraftTmpFile(taskFolderUri: vscode.Uri): Promise<void> {
  try {
    const tmpUri = vscode.Uri.joinPath(taskFolderUri, DRAFT_TMP_FILENAME);
    await vscode.workspace.fs.delete(tmpUri);
  } catch {
    // Ignore: file may not exist (runner didn't create it, or already cleaned up)
  }
}

/**
 * Read the draft temp file if it exists and is non-empty.
 * Returns the file content as a string, or undefined if unavailable.
 */
async function readDraftTmpFile(
  taskFolderUri: vscode.Uri
): Promise<string | undefined> {
  try {
    const tmpUri = vscode.Uri.joinPath(taskFolderUri, DRAFT_TMP_FILENAME);
    const bytes = await vscode.workspace.fs.readFile(tmpUri);
    const text = new TextDecoder().decode(bytes).trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Accepted argument shapes for draftTaskWithAI. Mirrors generatePlanWithAI's
 * GeneratePlanArg so the command works both from the tree stage-row inline
 * button (which passes the StageNode itself, i.e. `.task: IncompleteTask`)
 * and from the keyboard shortcut router (`{ canonicalId }`).
 */
type DraftTaskArg =
  | { canonicalId?: string; taskFolderPath?: string }
  | { task?: IncompleteTask };

/**
 * Normalize a DraftTaskArg into the `{ canonicalId?, taskFolderPath? }` shape
 * resolveTaskContext accepts.
 *
 * @internal exported for testing
 */
export function normalizeDraftTaskArg(
  arg?: DraftTaskArg
): { canonicalId?: string; taskFolderPath?: string } | undefined {
  if (!arg) {
    return undefined;
  }
  if ("task" in arg && arg.task) {
    return {
      canonicalId: arg.task.canonicalId,
      taskFolderPath: arg.task.folderUri.fsPath,
    };
  }
  if ("canonicalId" in arg && (arg.canonicalId || arg.taskFolderPath)) {
    return { canonicalId: arg.canonicalId, taskFolderPath: arg.taskFolderPath };
  }
  return undefined;
}

/**
 * Draft the task description with AI. Reads from the live open document
 * buffer if task.md is open (to capture unsaved edits), writes back only
 * to `## Draft with AI` and `## Open Questions`.
 *
 * Parse source preference:
 *   1. `_draft-ai-output.tmp` when it exists and is non-empty (real model output)
 *   2. `result.summary` from the runner (fallback when temp file unavailable)
 *
 * The temp file is removed on every terminal path:
 *   - success
 *   - malformed output
 *   - runner failure
 *   - cancellation
 *   - thrown exception
 *   - stale pre-existing temp file before a failed run
 *
 * Requires first-use consent (ensureAiConsent) before any provider is
 * launched or any file is written.
 */
export async function draftTaskWithAI(
  inventory: TaskInventory,
  context: vscode.ExtensionContext,
  chatViewProvider: ChatViewProvider,
  explicitArg?: DraftTaskArg
): Promise<boolean | undefined> {
  // ── Workspace guard (must come before consent) ──────────────────────────
  // ── Consent gate ─────────────────────────────────────────────────────────
  const consented = await ensureAiConsent(context);
  if (!consented) {
    return;
  }

  const resolvedTask = await resolveTaskContext(inventory, normalizeDraftTaskArg(explicitArg), {
    allowPaused: false,
  });

  if (!resolvedTask) {
    NotificationRouter.showInformation(
      "No active task found at the Task Description stage."
    );
    return;
  }

  const lockKey = resolvedTask.taskFolderPath;
  return await runTrackedOperation(
    lockKey,
    { label: "Draft Task with AI", stage: "desc", taskName: resolvedTask.folderName, kind: "draft-task", cancellable: true },
    async (op) => {

  // resolveTaskContext already computed the owning workspace folder (with a
  // fallback for tasks that predate the `ownership` field), so reuse it
  // instead of re-deriving it from ownership.workspaceRoot directly — that
  // duplicate check had no fallback and always failed for ownership-less
  // tasks even when the correct (and only) workspace folder was open.
  const workspaceFolder = resolvedTask.workspaceFolder
    ? vscode.workspace.getWorkspaceFolder(resolvedTask.workspaceFolder)
    : undefined;
  if (!workspaceFolder) {
    NotificationRouter.showError("Could not determine the owning workspace for this task.");
    return;
  }

  if (resolvedTask.progress.currentStage !== "desc") {
    NotificationRouter.showInformation(
      "Task is not at the Task Description stage."
    );
    return;
  }

  const taskFolderUri = vscode.Uri.file(resolvedTask.taskFolderPath);
  const taskFileUri = vscode.Uri.joinPath(taskFolderUri, TASK_FILENAME);
  const descriptionFileUri = vscode.Uri.joinPath(taskFolderUri, TASK_DESCRIPTION_FILENAME);
  const tmpUri = vscode.Uri.joinPath(taskFolderUri, DRAFT_TMP_FILENAME);

  // ── Pre-run cleanup: remove any stale temp file from a prior failed run ──
  await deleteDraftTmpFile(taskFolderUri);

  // Prefer live document buffer over stale disk content
  const openDoc = vscode.workspace.textDocuments.find(
    (doc) => doc.uri.toString() === taskFileUri.toString()
  );
  let rawContent: string;
  if (openDoc) {
    rawContent = openDoc.getText();
  } else {
    try {
      const bytes = await vscode.workspace.fs.readFile(taskFileUri);
      rawContent = new TextDecoder().decode(bytes);
    } catch {
      rawContent = "";
    }
  }

  const eol = detectEOL(rawContent);
  const parsed = parseTaskDocument(rawContent);

  // New tasks keep narration in task-description.md. Fall back to legacy
  // embedded descriptions so existing tasks remain fully compatible.
  let sourceDescription = parsed.taskDescription;
  try {
    const description = new TextDecoder().decode(await vscode.workspace.fs.readFile(descriptionFileUri)).trim();
    if (description) sourceDescription = description;
  } catch {
    // Optional file.
  }

  if (!sourceDescription.trim()) {
    NotificationRouter.showWarning(
      "Please enter a task description before using Draft with AI."
    );
    return;
  }

  const model = await resolveFreshModelForStage(taskFolderUri, "desc");
  if (!model.modelId) {
    NotificationRouter.showWarning(
      "No model is configured for the Description stage. Open Ensemble Settings and choose a primary model before continuing.",
      undefined,
      undefined,
      undefined,
      { command: "vs-code-ai-helper.openSettings", title: "Open Settings" }
    );
    return;
  }
  // Captured as a non-optional string here: TypeScript does not preserve the
  // `model.modelId` narrowing into the nested withProgress callback below.
  const primaryModelId: string = model.modelId;
  const { runner, nativeModelId } = resolveRunnerForModel(
    model.modelId, "desc", taskFolderUri
  );
  const { availability, providerLabel } = await checkRunnerAvailabilityForModel(
    model.modelId,
    "desc"
  );
  if (!availability.available) {
    NotificationRouter.showWarning(
      `${providerLabel} is unavailable: ${availability.reason ?? "unknown reason"}.`
    );
    return;
  }

  // The stage's configured backup models (empty unless the "desc" stage uses
  // the "switch-to-backup" strategy), already normalized, de-duplicated, and
  // with the primary and any disabled-provider entries removed. Draft with AI
  // is a single interactive command, so — unlike the plan/review stages routed
  // through reviewActions — it never had a content-level fallback: a primary
  // that exits cleanly with an UNUSABLE draft (opencode's free-tier models
  // routinely burn the run on tool calls and return no final text, or a
  // truncated non-answer — see the desc-stage reproduction in cliAgentRunner's
  // opencode notes) left task.md unchanged with a "malformed response" error
  // even when a working backup was configured. Snapshotted here so a settings
  // edit mid-run cannot change the fan-out that the size gate discloses below.
  const configuredBackupModels = backupModelsForStage("desc", model.modelId);

  // Build the prompt and check its size BEFORE launching or writing artifacts.
  const prompt = await renderPromptTemplate(
    context.extensionUri,
    "draft-task-with-ai.md",
    {
      taskDescription: `${sourceDescription}\n\nNote: this may be voice-transcribed input; resolve obvious transcription errors from context rather than treating them as requirements.`,
    }
  );

  // ── Prompt-size gate ─────────────────────────────────────────────────────
  const sizeCheck = await checkAndConfirmPromptSize(
    prompt,
    providerLabel,
    configuredBackupModels.length
  );
  if (sizeCheck === "abort" || sizeCheck === "declined") {
    return;
  }

  let aiOutput: { draftWithAI: string; openQuestions: string } | undefined;
  // The provider whose response was actually accepted — the primary unless a
  // backup produced the draft after the primary returned nothing usable. Used
  // for the success toast so it names the model that really ran.
  let acceptedProviderLabel = providerLabel;

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: `Drafting task with ${providerLabel} (uses your ${providerLabel} quota)...`,
        cancellable: true,
      },
      async (progress, token) => {
        NotificationRouter.emitProgressSummary(
          `Drafting task with ${providerLabel}...`,
          taskOperations.rootOperationIdFor(taskFolderUri.fsPath)
        );
        progress.report({ message: `Waiting for ${providerLabel} response...` });

        // Cancellable from either surface: the native progress toast and the
        // Notifications-row cancel button both abort the same provider run.
        const linked = linkCancellationTokens(token, op.token);

        // A single candidate's runnable context: the primary reuses the
        // runner/model already resolved and availability-checked above; each
        // backup is resolved lazily inside the loop below.
        interface RunnerContext {
          runner: ReturnType<typeof resolveRunnerForModel>["runner"];
          nativeModelId: string | undefined;
          providerLabel: string;
        }
        interface DraftAttemptResult {
          status: "completed" | "cancelled" | "failed";
          parsed?: { draftWithAI: string; openQuestions: string };
          errorMessage?: string;
          /** Provider-neutral failure classification, for quota telemetry. */
          failureKind?: AgentRunResult["failureKind"];
          /**
           * The stored model id the run actually executed with — may differ
           * from the requested one when the stage-wrapped primary's OWN
           * quota/unavailable cascade substituted a backup. Used to dedupe the
           * external cascade and to attribute the draft to the real provider.
           */
          ranModelId?: string;
          /** Display label of the provider that actually ran, when derivable. */
          ranProviderLabel?: string;
        }
        const runAttempt = async (
          attemptPrompt: string,
          ctx: RunnerContext
        ): Promise<DraftAttemptResult> => {
          await deleteDraftTmpFile(taskFolderUri);
          const result = await ctx.runner.run(
            {
              taskFolderUri: taskFolderUri,
              workspaceUri: workspaceFolder.uri,
              stage: "desc",
              prompt: attemptPrompt,
              outputFile: tmpUri,
              modelId: ctx.nativeModelId,
            },
            linked.token
          );
          // Best-effort: writeRunLog is real I/O (a transient file-lock can
          // reject) and must never discard an already-obtained run result — a
          // logging hiccup should not lose a valid draft or abort the cascade.
          try {
            const draftLogUri = await writeRunLog(
              taskFolderUri,
              result.runnerId ?? ctx.runner.id,
              "desc",
              `# Prompt\n\n${attemptPrompt}\n\n# Result\n\nStatus: ${result.status}\n\n${
                result.summary ?? result.errorMessage ?? ""
              }`
            );
            op.setResultTargetUri(draftLogUri);
          } catch {
            // Ignore — the run itself succeeded/failed on its own terms.
          }
          // The provider that actually ran (result.runnerId is the substituted
          // one when the primary's internal cascade swapped in a backup); fall
          // back to the requested candidate's label when it isn't a CLI runner.
          const ranModelId = result.runnerId
            ? qualifiedRanModelId({ runnerId: result.runnerId, modelId: result.modelId })
            : undefined;
          const ranProviderLabel =
            (result.runnerId ? getCliProvider(result.runnerId)?.label : undefined) ??
            ctx.providerLabel;
          if (result.status !== "completed") {
            return {
              status: result.status === "cancelled" ? "cancelled" : "failed",
              errorMessage: result.errorMessage,
              failureKind: result.failureKind,
              ranModelId,
              ranProviderLabel,
            };
          }
          // Prefer the real temp output file over the runner summary.
          const tmpContent = await readDraftTmpFile(taskFolderUri);
          const outputText = tmpContent ?? result.summary ?? "";
          return {
            status: "completed",
            parsed: parseAIResponse(outputText),
            ranModelId,
            ranProviderLabel,
          };
        };

        // The result of driving one candidate model. Distinguishes a HARD
        // runner failure (`failed`) from a clean exit that produced no usable
        // draft (`unusable-content`); the caller treats a primary hard failure
        // as terminal (its stage wrapper already cascaded) but continues past a
        // backup's — matching reviewActions.runAiToFile. `ranModelId` /
        // `failureKind` carry the bookkeeping the caller needs (dedupe, quota
        // observation).
        interface CandidateOutcome {
          status: "usable" | "cancelled" | "failed" | "unusable-content";
          failureMessage?: string;
          ranModelId?: string;
          failureKind?: AgentRunResult["failureKind"];
        }
        // Run one candidate model end-to-end (initial attempt + at most one
        // structure-repair retry ON THE SAME MODEL) and, on success, commit
        // its draft to `aiOutput`. Returns "usable" once a PARSEABLE response
        // was obtained (so the cascade stops — repair/unstructured-wrap is a
        // quality pass, not a reason to spend another provider's quota),
        // "cancelled" if the user aborted, "failed" on a hard runner failure,
        // or "unusable-content" when the run exited cleanly with no parseable
        // draft. Never emits a user-facing failure toast itself — the caller
        // decides that once every candidate is exhausted.
        const runCandidate = async (
          ctx: RunnerContext
        ): Promise<CandidateOutcome> => {
          const first = await runAttempt(prompt, ctx);
          if (first.status === "cancelled") {
            return { status: "cancelled" };
          }
          if (first.status === "failed") {
            return {
              status: "failed",
              failureMessage: first.errorMessage ?? "unknown error",
              ranModelId: first.ranModelId,
              failureKind: first.failureKind,
            };
          }
          if (!first.parsed) {
            // A clean exit whose output had no parseable "## Draft with AI" /
            // "## Open Questions" sections (including opencode's "no text
            // reply" placeholder) — no usable draft; fall back to the next.
            return {
              status: "unusable-content",
              failureMessage:
                "the response was malformed or empty (missing, duplicate, or unrecognized sections)",
              ranModelId: first.ranModelId,
              failureKind: first.failureKind,
            };
          }
          const validation = validateDraftStructure(first.parsed.draftWithAI);
          if (validation.valid) {
            aiOutput = first.parsed;
            // Attribute to the provider that ACTUALLY ran — the stage-wrapped
            // primary may have substituted a backup internally, so
            // ctx.providerLabel (the requested one) can be wrong here.
            acceptedProviderLabel = first.ranProviderLabel ?? ctx.providerLabel;
            return { status: "usable", ranModelId: first.ranModelId };
          }
          // One repair retry naming the missing/empty subsections, then fall
          // back to accepting the draft filed under the explicit
          // `Draft (unstructured)` heading rather than discarding it.
          progress.report({ message: `Repairing draft structure with ${ctx.providerLabel}...` });
          const repairPrompt =
            `${prompt}\n\n---\n\nYour previous response was missing (or had empty) required subsection(s) under "## Draft with AI": ` +
            `${validation.missing.join(", ")}. Return the complete response again in the same two-section format, `
            + `this time with all three subsections (### Behavior change, ### Affected areas, ### Actionable changes) under "## Draft with AI", each with substantive content.`;
          const second = await runAttempt(repairPrompt, ctx);
          if (second.status === "cancelled") {
            return { status: "cancelled" };
          }
          if (second.status === "completed" && second.parsed) {
            // The repair attempt is what commits here — attribute the draft (and
            // its dedupe/ran-model id) to whoever produced THIS attempt, which
            // may differ from the first attempt's provider.
            const secondValidation = validateDraftStructure(second.parsed.draftWithAI);
            if (secondValidation.valid) {
              aiOutput = second.parsed;
            } else {
              aiOutput = {
                draftWithAI: wrapUnstructuredDraft(
                  second.parsed.draftWithAI,
                  secondValidation.missing
                ),
                openQuestions: second.parsed.openQuestions,
              };
              NotificationRouter.showWarning(
                "The draft is still missing required subsections (Behavior change / Affected areas / Actionable changes) after a repair attempt; it was saved under a 'Draft (unstructured)' heading for manual review."
              );
            }
            acceptedProviderLabel = second.ranProviderLabel ?? ctx.providerLabel;
            return { status: "usable", ranModelId: second.ranModelId };
          }
          // Repair pass failed or came back malformed — keep the first
          // (parseable, unstructured) draft instead of losing it, filed
          // under the explicit unstructured heading.
          aiOutput = {
            draftWithAI: wrapUnstructuredDraft(
              first.parsed.draftWithAI,
              validation.missing
            ),
            openQuestions: first.parsed.openQuestions,
          };
          acceptedProviderLabel = first.ranProviderLabel ?? ctx.providerLabel;
          NotificationRouter.showWarning(
            "The draft is missing required subsections (Behavior change / Affected areas / Actionable changes) and the repair attempt did not return a usable response; the first draft was saved under a 'Draft (unstructured)' heading for manual review."
          );
          return { status: "usable", ranModelId: first.ranModelId };
        };

        try {
          // Mirror reviewActions.runAiToFile. The primary is resolved WITH the
          // "desc" stage (line above), so whenever backups exist at all (same
          // backupModelsForStage gate) it is already wrapped in
          // resolveRunnerForModel's own quota/temporarily-unavailable cascade
          // AND its auth-terminal policy. Therefore:
          //  - A primary HARD failure is terminal here: its wrapper already
          //    cascaded through the stage's backups (or ruled the error
          //    terminal — auth/config), so there is nothing more to retry, and
          //    re-running the backups would double-spend / hide the real error.
          //  - This external cascade exists only for the case the wrapper
          //    cannot see: a run that exits cleanly with an UNUSABLE draft
          //    (opencode's free-tier "no text reply" / truncated non-answer).
          //    Backups are then tried one at a time and, like reviewActions,
          //    a non-completed backup is simply skipped (its failure is
          //    recorded, then the next backup runs).
          const candidateModelIds = [primaryModelId, ...configuredBackupModels];
          // Models already run — including whichever one the PRIMARY's own
          // internal cascade actually executed (its wrapper may have swapped in
          // a backup) — so this loop never re-charges a provider that already
          // ran. Seeded with the configured primary; grown from each result's
          // real ran-model id.
          const triedModelIds = new Set<string>([
            normalizeQualifiedModelId(primaryModelId),
          ]);
          let lastFailureMessage: string | undefined;
          // Captured immediately before the primary run so the backup
          // quota-observation skip below can tell "this backup was burned by
          // the primary's OWN internal cascade during this very call" (a fresh
          // observation) from a stale one left over from earlier in the session
          // (whose quota window may since have reset).
          const primaryRunStartedAt = Date.now();
          for (let index = 0; index < candidateModelIds.length; index++) {
            if (linked.token.isCancellationRequested) {
              NotificationRouter.showInformation("Draft with AI cancelled.");
              return;
            }
            const candidateModelId = candidateModelIds[index]!;
            let ctx: RunnerContext;
            if (index === 0) {
              ctx = { runner, nativeModelId, providerLabel };
            } else {
              if (triedModelIds.has(normalizeQualifiedModelId(candidateModelId))) {
                // Already run — by an earlier iteration or by the primary's own
                // internal cascade. Skip rather than double-charge it.
                continue;
              }
              // The primary's OWN stage cascade may have just burned this same
              // backup (recording an exhausted/unavailable observation) before
              // returning a different, content-unusable result. Skip it rather
              // than launch a second full agentic run against quota it already
              // exhausted moments ago — gated on the observation being fresh
              // (>= this call's start), not a stale one from earlier this
              // session. Mirrors reviewActions' identical guard.
              const observation = getQuotaObservation("desc", candidateModelId);
              if (
                observation &&
                new Date(observation.observedAt).getTime() >= primaryRunStartedAt &&
                (observation.state === "exhausted" || observation.state === "unavailable")
              ) {
                continue;
              }
              // Resolve the backup WITHOUT a stage argument so it is not
              // re-wrapped in its own quota/backup cascade (mirrors
              // reviewActions' content-retry), and skip it if it cannot run.
              let resolved: ReturnType<typeof resolveRunnerForModel>;
              try {
                resolved = resolveRunnerForModel(
                  candidateModelId,
                  undefined,
                  taskFolderUri
                );
                const backupAvailability = await resolved.runner.isAvailable();
                if (!backupAvailability.available) {
                  continue;
                }
              } catch {
                // A flaky candidate (resolve/isAvailable throwing) must not
                // abort the whole sequence — try the next backup.
                continue;
              }
              triedModelIds.add(normalizeQualifiedModelId(candidateModelId));
              ctx = {
                runner: resolved.runner,
                nativeModelId: resolved.nativeModelId,
                providerLabel: resolved.providerLabel,
              };
              progress.report({
                message: `Retrying draft with ${ctx.providerLabel} (backup, uses your ${ctx.providerLabel} quota)...`,
              });
              NotificationRouter.emitProgressSummary(
                `Drafting task with ${ctx.providerLabel} (backup)...`,
                taskOperations.rootOperationIdFor(taskFolderUri.fsPath)
              );
            }

            let outcome: CandidateOutcome;
            try {
              outcome = await runCandidate(ctx);
            } catch (err) {
              if (index === 0) {
                // Primary run/log threw — its stage wrapper owns error handling;
                // propagate (matches reviewActions, whose primary run() is not
                // wrapped) rather than silently swallowing.
                throw err;
              }
              // A backup's run()/log threw instead of returning a status — do
              // not abort the whole cascade; record the reason and try the next
              // backup (reviewActions wraps backup run() the same way).
              lastFailureMessage =
                err instanceof Error ? err.message : "backup run failed";
              continue;
            }
            if (outcome.ranModelId) {
              triedModelIds.add(normalizeQualifiedModelId(outcome.ranModelId));
            }
            // A cancellation never actually observed the provider's quota state,
            // so it must be checked BEFORE recordQuotaObservation — recording
            // an "ok" for a cancelled run would clobber a genuine recent
            // exhausted/unavailable observation for this backup (matches
            // reviewActions, which breaks on cancelled before recording).
            if (outcome.status === "cancelled") {
              NotificationRouter.showInformation("Draft with AI cancelled.");
              return;
            }
            // Record what this run revealed about the candidate's quota state
            // for the settings telemetry — backups (resolved without a stage)
            // are not withQuotaObservation-instrumented, so unlike the primary
            // they'd otherwise leave no trace (matches reviewActions, which
            // records after every backup run).
            if (index > 0) {
              recordQuotaObservation(
                "desc",
                candidateModelId,
                outcome.failureKind,
                outcome.failureMessage
              );
            }
            if (outcome.status === "usable") {
              return;
            }
            if (outcome.status === "failed" && index === 0) {
              // The stage-wrapped primary already cascaded through its backups
              // (or ruled the error terminal — auth/config) before returning
              // this. Report it as-is; never re-spend backups on it.
              NotificationRouter.showError(
                `Draft with AI failed: ${outcome.failureMessage ?? "unknown error"}. task.md was not changed.`
              );
              return;
            }
            // A backup that hard-failed or a clean-but-unusable draft (from the
            // primary or a backup): record the reason and fall through to the
            // next configured model, exactly like reviewActions' content-retry.
            lastFailureMessage = outcome.failureMessage ?? "unknown error";
          }

          // Every configured candidate returned nothing usable.
          if (configuredBackupModels.length > 0) {
            NotificationRouter.showError(
              `Draft with AI failed: ${providerLabel} and all ${configuredBackupModels.length} configured backup model(s) returned no usable draft (last: ${lastFailureMessage ?? "unknown error"}). task.md was not changed.`
            );
          } else {
            // Single configured model, clean-but-unusable output — the original
            // pre-cascade wording.
            NotificationRouter.showError(
              "AI returned a malformed response (missing, duplicate, or unrecognized sections). task.md was not changed."
            );
          }
        } finally {
          linked.dispose();
        }
      }
    );
  } finally {
    // ── Cleanup on all terminal paths ──────────────────────────────────────
    // success, malformed, runner failure, cancellation, exception
    await deleteDraftTmpFile(taskFolderUri);
  }

  if (!aiOutput) {
    return;
  }

  // Build updated document, preserving EOL style
  const updatedParsed: ParsedTaskDocument = {
    ...parsed,
    draftWithAI: aiOutput.draftWithAI,
    openQuestions: aiOutput.openQuestions,
  };
  let newContent = buildTaskDocument(updatedParsed);

  // Normalize EOL if the source used CRLF
  if (eol === "\r\n") {
    newContent = newContent.replace(/\r?\n/g, "\r\n");
  }

  // Write back to the open document buffer if available, otherwise to disk
  if (openDoc) {
    // Snapshot only immediately before a successful write. This avoids
    // creating a misleading backup for cancelled or failed draft attempts,
    // and captures unsaved edits from the active editor.
    await backupArtifactContents(taskFileUri, new TextEncoder().encode(rawContent));
    const fullRange = new vscode.Range(
      openDoc.positionAt(0),
      openDoc.positionAt(openDoc.getText().length)
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(taskFileUri, fullRange, newContent);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      NotificationRouter.showError(
        `Failed to update task.md in the editor. The file was not changed.`
      );
      return;
    }
    // Try to save
    const docToSave =
      vscode.workspace.textDocuments.find(
        (d) => d.uri.toString() === taskFileUri.toString()
      ) ?? openDoc;
    const saved = await docToSave.save();
    if (!saved) {
      NotificationRouter.showError(
        "Draft with AI completed but task.md could not be saved. The updated content is shown in the editor."
      );
    } else {
      NotificationRouter.showInformation(
        `task.md updated with Draft with AI (${acceptedProviderLabel}).`
      );
    }
  } else {
    await backupArtifactBeforeWrite(taskFileUri);
    await vscode.workspace.fs.writeFile(
      taskFileUri,
      new TextEncoder().encode(newContent)
    );
    await safeOpenTextDocument(taskFileUri, "task.md");
    NotificationRouter.showInformation(
      `task.md updated with Draft with AI (${acceptedProviderLabel}).`
    );
  }

  // Keep folder IDs stable, but replace the generated label when it has not
  // been manually renamed. A draft heading is the best concise summary we
  // have without spending another model request.
  if (resolvedTask.progress.nameIsDefault !== false) {
    // The draft-task-with-ai prompt never emits an H1 — it opens "## Draft
    // with AI" with a one-sentence goal line, then ### subsections. That
    // opening line is the best concise summary already produced without an
    // extra model request, so it (not a nonexistent H1) is the task name.
    // Skip `>` lines too: an unstructured-fallback draft (wrapUnstructuredDraft)
    // opens with the "### Draft (unstructured)" heading followed by a
    // "> The AI response was missing..." blockquote — neither is real draft
    // content, so the title must fall through to the draft body beneath them.
    const title = aiOutput.draftWithAI
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith(">"));
    if (title) {
      await patchTaskProgress(taskFolderUri, (current) => ({
        ...current,
        displayName: title.slice(0, 120),
        // An AI-derived summary replaces the generated folder-name label.
        // Treat it as established so later drafts cannot silently overwrite
        // a title the user has accepted.
        nameIsDefault: false,
      }));
    }
  }

  if (hasBlockingOpenQuestions(aiOutput.openQuestions)) {
    // The drafted task can't proceed until these are answered — open Chat
    // With AI on this task's Description stage and pose them directly rather
    // than leaving them sitting unread in task.md's Open Questions section.
    const question = {
      canonicalId: resolvedTask.canonicalId,
      taskFolderPath: resolvedTask.taskFolderPath,
      stage: "desc" as const,
      question:
        `Draft with AI raised open questions that need your input before this task can proceed:\n\n${aiOutput.openQuestions}`,
    };
    // Genuinely blocking — the task cannot advance past Description until
    // these are answered — so ask() raises an error, not a warning, per the
    // "can't proceed without user feedback" contract.
    await chatViewProvider.ask(question, true, {
      blocking: true,
      blockedReason: "Draft with AI raised open questions.",
    });
  }
  return true;
    }
  );
}

/**
 * Whether a drafted task's Open Questions section actually blocks progress
 * (as opposed to the AI's explicit "nothing is unclear" sentinel — see the
 * draft-task-with-ai prompt's "write exactly: - None." instruction).
 */
function hasBlockingOpenQuestions(openQuestions: string): boolean {
  const normalized = openQuestions.trim().toLowerCase();
  return normalized.length > 0 && normalized !== "- none." && normalized !== "none.";
}

/**
 * Register the draftTaskWithAI command.
 */
export function registerDraftTaskWithAICommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  chatViewProvider: ChatViewProvider
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.draftTaskWithAI",
    (explicitArg?: Parameters<typeof draftTaskWithAI>[3]) =>
      draftTaskWithAI(inventory, context, chatViewProvider, explicitArg)
  );
  context.subscriptions.push(disposable);
}
