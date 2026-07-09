import * as vscode from "vscode";
import { TASK_FILENAME } from "../types/taskProgress";
import { resolveModelForStage } from "../utils/modelSelection";
import { resolveRunnerForModel } from "../runners/runnerRegistry";
import { renderPromptTemplate } from "../utils/promptTemplates";
import { writeRunLog } from "../utils/runLog";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { ensureAiConsent } from "../utils/aiConsent";
import { checkAndConfirmPromptSize } from "../utils/promptSizeGuard";

const INTRO_TEXT = `Briefly describe what changes you want to be made, and then use AI to help you clarify the plan.`;
const SHORTCUT_NOTE = `Shortcut: Apply Current Stage Action (Windows/Linux: Ctrl+Shift+Alt+I, macOS: Cmd+Shift+Alt+I).`;

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
  const otherOccurrences = headings.filter(
    (h) =>
      h.normalizedTitle !== "draft with ai" &&
      h.normalizedTitle !== "open questions"
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
  explicitArg?: { canonicalId?: string }
): Promise<void> {
  // ── Workspace guard (must come before consent) ──────────────────────────
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    void vscode.window.showErrorMessage(
      "No workspace folder open. Please open a folder first."
    );
    return;
  }

  // ── Consent gate ─────────────────────────────────────────────────────────
  const consented = await ensureAiConsent(context);
  if (!consented) {
    return;
  }

  const resolvedTask = await resolveTaskContext(inventory, explicitArg, {
    allowPaused: false,
  });

  if (!resolvedTask) {
    void vscode.window.showInformationMessage(
      "No active task found at the Task Description stage."
    );
    return;
  }

  if (resolvedTask.progress.currentStage !== "task-description") {
    void vscode.window.showInformationMessage(
      "Task is not at the Task Description stage."
    );
    return;
  }

  const taskFolderUri = vscode.Uri.file(resolvedTask.taskFolderPath);
  const taskFileUri = vscode.Uri.joinPath(taskFolderUri, TASK_FILENAME);
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

  if (!parsed.taskDescription.trim()) {
    void vscode.window.showWarningMessage(
      "Please enter a task description before using Draft with AI."
    );
    return;
  }

  const model = await resolveModelForStage(taskFolderUri, "task-description");
  const { runner, providerLabel, nativeModelId } = await resolveRunnerForModel(
    model.modelId
  );
  const availability = await runner.isAvailable();
  if (!availability.available) {
    void vscode.window.showWarningMessage(
      `${providerLabel} is unavailable: ${availability.reason ?? "unknown reason"}.`
    );
    return;
  }

  // Build the prompt and check its size BEFORE launching or writing artifacts.
  const prompt = await renderPromptTemplate(
    context.extensionUri,
    "draft-task-with-ai.md",
    { taskDescription: parsed.taskDescription }
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
        location: vscode.ProgressLocation.Notification,
        title: `Drafting task with ${providerLabel} (uses your ${providerLabel} quota)...`,
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ message: `Waiting for ${providerLabel} response...` });

        const result = await runner.run(
          {
            taskFolderUri: taskFolderUri,
            workspaceUri: workspaceFolder.uri,
            stage: "task-description",
            prompt,
            outputFile: tmpUri,
            modelId: nativeModelId,
          },
          token
        );

        await writeRunLog(
          taskFolderUri,
          runner.id,
          "task-description",
          `# Prompt\n\n${prompt}\n\n# Result\n\nStatus: ${result.status}\n\n${
            result.summary ?? result.errorMessage ?? ""
          }`
        );

        if (result.status === "completed") {
          // Prefer the real temp output file over the runner summary.
          const tmpContent = await readDraftTmpFile(taskFolderUri);
          const outputText = tmpContent ?? result.summary ?? "";
          const parsed = parseAIResponse(outputText);
          if (parsed) {
            aiOutput = parsed;
          } else {
            void vscode.window.showErrorMessage(
              "AI returned a malformed response (missing, duplicate, or unrecognized sections). task.md was not changed."
            );
          }
        } else if (result.status === "cancelled") {
          void vscode.window.showInformationMessage("Draft with AI cancelled.");
        } else {
          void vscode.window.showErrorMessage(
            `Draft with AI failed: ${result.errorMessage ?? "unknown error"}`
          );
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
    const fullRange = new vscode.Range(
      openDoc.positionAt(0),
      openDoc.positionAt(openDoc.getText().length)
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(taskFileUri, fullRange, newContent);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      void vscode.window.showErrorMessage(
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
      void vscode.window.showErrorMessage(
        "Draft with AI completed but task.md could not be saved. The updated content is shown in the editor."
      );
    } else {
      void vscode.window.showInformationMessage(
        `task.md updated with Draft with AI (${providerLabel}).`
      );
    }
  } else {
    await vscode.workspace.fs.writeFile(
      taskFileUri,
      new TextEncoder().encode(newContent)
    );
    // Open the file
    const doc = await vscode.workspace.openTextDocument(taskFileUri);
    await vscode.window.showTextDocument(doc);
    void vscode.window.showInformationMessage(
      `task.md updated with Draft with AI (${providerLabel}).`
    );
  }
}

/**
 * Register the draftTaskWithAI command.
 */
export function registerDraftTaskWithAICommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.draftTaskWithAI",
    (explicitArg?: { canonicalId?: string }) =>
      draftTaskWithAI(inventory, context, explicitArg)
  );
  context.subscriptions.push(disposable);
}
