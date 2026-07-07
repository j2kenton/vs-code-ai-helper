import * as vscode from "vscode";
import * as path from "path";
import { TASK_FILENAME } from "../types/taskProgress";
import { resolveModelForStage } from "../utils/modelSelection";
import { resolveRunnerForModel } from "../runners/runnerRegistry";
import { renderPromptTemplate } from "../utils/promptTemplates";
import { writeRunLog } from "../utils/runLog";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";

const INTRO_TEXT = `Briefly describe what changes you want to be made, and then use AI to help you clarify the plan.`;
const SHORTCUT_NOTE = `Shortcut: Apply Current Stage Action (Windows/Linux: Ctrl+Shift+Alt+I, macOS: Cmd+Shift+Alt+I).`;

/**
 * Section headers that are canonically managed by this command.
 */
const MANAGED_HEADERS = ["## Task Description", "## Draft with AI", "## Open Questions"];

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
      if (bodyText.length > 0) taskDescBodies.push(bodyText);
    } else if (section.header === "## Draft with AI") {
      if (bodyText.length > 0) draftBodies.push(bodyText);
    } else if (section.header === "## Open Questions") {
      if (bodyText.length > 0) questionsBodies.push(bodyText);
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
 * Parse the AI response for Draft with AI.
 * Expects exactly one `## Draft with AI` section and one `## Open Questions` section.
 * Returns undefined if malformed.
 */
export function parseAIResponse(
  response: string
): { draftWithAI: string; openQuestions: string } | undefined {
  // Find the two required headers
  const draftIdx = response.indexOf("## Draft with AI");
  const questionsIdx = response.indexOf("## Open Questions");

  if (draftIdx === -1 || questionsIdx === -1) {
    return undefined;
  }
  if (draftIdx > questionsIdx) {
    return undefined;
  }

  // Check for duplicates
  const secondDraft = response.indexOf("## Draft with AI", draftIdx + 1);
  const secondQuestions = response.indexOf("## Open Questions", questionsIdx + 1);
  if (secondDraft !== -1 || secondQuestions !== -1) {
    return undefined;
  }

  const draftBody = response
    .slice(draftIdx + "## Draft with AI".length, questionsIdx)
    .trim();
  const questionsBody = response
    .slice(questionsIdx + "## Open Questions".length)
    .trim();

  return {
    draftWithAI: draftBody,
    openQuestions: questionsBody,
  };
}

/**
 * Detect the line ending style of a string.
 */
function detectEOL(content: string): string {
  if (content.includes("\r\n")) return "\r\n";
  return "\n";
}


/**
 * Draft the task description with AI. Reads from the live open document
 * buffer if task.md is open (to capture unsaved edits), writes back only
 * to `## Draft with AI` and `## Open Questions`.
 */
export async function draftTaskWithAI(
  inventory: TaskInventory,
  extensionUri: vscode.Uri,
  explicitArg?: { canonicalId?: string }
): Promise<void> {
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

  let aiOutput: { draftWithAI: string; openQuestions: string } | undefined;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Drafting task with ${providerLabel}...`,
      cancellable: true,
    },
    async (progress, token) => {
      const prompt = await renderPromptTemplate(
        extensionUri,
        "draft-task-with-ai.md",
        { taskDescription: parsed.taskDescription }
      );

      progress.report({ message: `Waiting for ${providerLabel} response...` });

      const result = await runner.run(
        {
          taskFolderUri: taskFolderUri,
          workspaceUri: vscode.workspace.workspaceFolders?.[0]?.uri ?? taskFolderUri,
          stage: "task-description",
          prompt,
          outputFile: vscode.Uri.joinPath(taskFolderUri, "_draft-ai-output.tmp"),
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
        const outputText = result.summary ?? "";
        aiOutput = parseAIResponse(outputText);
        if (!aiOutput) {
          void vscode.window.showErrorMessage(
            "AI returned a malformed response (missing or duplicate sections). task.md was not changed."
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

  // Clean up temp file if created
  try {
    const tmpUri = vscode.Uri.joinPath(taskFolderUri, "_draft-ai-output.tmp");
    await vscode.workspace.fs.delete(tmpUri);
  } catch {
    // ignore
  }

  if (!aiOutput) return;

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
      draftTaskWithAI(inventory, context.extensionUri, explicitArg)
  );
  context.subscriptions.push(disposable);
}
