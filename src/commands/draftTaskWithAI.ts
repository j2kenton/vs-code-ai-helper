import * as vscode from "vscode";
import { TASK_DESCRIPTION_FILENAME, TASK_FILENAME } from "../types/taskProgress";
import { resolveFreshModelForStage } from "../utils/modelSelection";
import {
  checkRunnerAvailabilityForModel,
  resolveRunnerForModel,
} from "../runners/runnerRegistry";
import { renderPromptTemplate } from "../utils/promptTemplates";
import { writeRunLog } from "../utils/runLog";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { ensureAiConsent } from "../utils/aiConsent";
import { checkAndConfirmPromptSize } from "../utils/promptSizeGuard";
import { NotificationRouter } from "../utils/notificationRouter";
import { safeOpenTextDocument } from "../utils/fileUtils";
import { ChatViewProvider } from "../views/chatView";

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

  // Build the prompt and check its size BEFORE launching or writing artifacts.
  const prompt = await renderPromptTemplate(
    context.extensionUri,
    "draft-task-with-ai.md",
    {
      taskDescription: `${sourceDescription}\n\nNote: this may be voice-transcribed input; resolve obvious transcription errors from context rather than treating them as requirements.`,
    }
  );

  // ── Prompt-size gate ─────────────────────────────────────────────────────
  const sizeCheck = await checkAndConfirmPromptSize(prompt, providerLabel);
  if (sizeCheck === "abort" || sizeCheck === "declined") {
    return;
  }

  let aiOutput: { draftWithAI: string; openQuestions: string } | undefined;

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

        interface DraftAttemptResult {
          status: "completed" | "cancelled" | "failed";
          parsed?: { draftWithAI: string; openQuestions: string };
          errorMessage?: string;
        }
        const runAttempt = async (attemptPrompt: string): Promise<DraftAttemptResult> => {
          await deleteDraftTmpFile(taskFolderUri);
          const result = await runner.run(
            {
              taskFolderUri: taskFolderUri,
              workspaceUri: workspaceFolder.uri,
              stage: "desc",
              prompt: attemptPrompt,
              outputFile: tmpUri,
              modelId: nativeModelId,
            },
            linked.token
          );
          const draftLogUri = await writeRunLog(
            taskFolderUri,
            runner.id,
            "desc",
            `# Prompt\n\n${attemptPrompt}\n\n# Result\n\nStatus: ${result.status}\n\n${
              result.summary ?? result.errorMessage ?? ""
            }`
          );
          op.setResultTargetUri(draftLogUri);
          if (result.status !== "completed") {
            return {
              status: result.status === "cancelled" ? "cancelled" : "failed",
              errorMessage: result.errorMessage,
            };
          }
          // Prefer the real temp output file over the runner summary.
          const tmpContent = await readDraftTmpFile(taskFolderUri);
          const outputText = tmpContent ?? result.summary ?? "";
          return { status: "completed", parsed: parseAIResponse(outputText) };
        };

        try {
          const first = await runAttempt(prompt);
          if (first.status === "cancelled") {
            NotificationRouter.showInformation("Draft with AI cancelled.");
            return;
          }
          if (first.status === "failed") {
            NotificationRouter.showError(
              `Draft with AI failed: ${first.errorMessage ?? "unknown error"}`
            );
            return;
          }
          if (!first.parsed) {
            NotificationRouter.showError(
              "AI returned a malformed response (missing, duplicate, or unrecognized sections). task.md was not changed."
            );
            return;
          }
          const validation = validateDraftStructure(first.parsed.draftWithAI);
          if (validation.valid) {
            aiOutput = first.parsed;
            return;
          }
          // One repair retry naming the missing/empty subsections, then fall
          // back to accepting the draft filed under the explicit
          // `Draft (unstructured)` heading rather than discarding it.
          progress.report({ message: `Repairing draft structure with ${providerLabel}...` });
          const repairPrompt =
            `${prompt}\n\n---\n\nYour previous response was missing (or had empty) required subsection(s) under "## Draft with AI": ` +
            `${validation.missing.join(", ")}. Return the complete response again in the same two-section format, `
            + `this time with all three subsections (### Behavior change, ### Affected areas, ### Actionable changes) under "## Draft with AI", each with substantive content.`;
          const second = await runAttempt(repairPrompt);
          if (second.status === "cancelled") {
            NotificationRouter.showInformation("Draft with AI cancelled.");
            return;
          }
          if (second.status === "completed" && second.parsed) {
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
          } else {
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
            NotificationRouter.showWarning(
              "The draft is missing required subsections (Behavior change / Affected areas / Actionable changes) and the repair attempt did not return a usable response; the first draft was saved under a 'Draft (unstructured)' heading for manual review."
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
        `task.md updated with Draft with AI (${providerLabel}).`
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
      `task.md updated with Draft with AI (${providerLabel}).`
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
    const title = aiOutput.draftWithAI
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("#"));
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
    await chatViewProvider.ask(
      {
        canonicalId: resolvedTask.canonicalId,
        taskFolderPath: resolvedTask.taskFolderPath,
        stage: "desc",
        question:
          `Draft with AI raised open questions that need your input before this task can proceed:\n\n${aiOutput.openQuestions}`,
      },
      true
    );
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
