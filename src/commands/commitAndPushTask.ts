import * as vscode from "vscode";
import * as path from "path";
import { spawn } from "child_process";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { TASK_FILENAME, STAGE_DISPLAY_NAMES } from "../types/taskProgress";
import { resolveImplementationArtifact } from "../utils/implementationArtifactResolver";
import { getLowLevelPlanUri } from "../utils/lowLevelPlanArtifactResolver";
import { IncompleteTask, patchTaskProgress } from "../utils/taskProgressUtils";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { advanceStage } from "../utils/stageTransition";
import { selectNextTask } from "./markTaskDone";
import { NotificationRouter } from "../utils/notificationRouter";
import {
  CompletionLintResult,
  runCompletionLint,
  upsertCompletionChecksInPublishReview,
} from "../utils/completionLint";
import { runLintingFixes } from "./runLintingFixes";
import { resolveFreshModelForStage } from "../utils/modelSelection";
import { parseCopilotModelSelection, parseModelSelection } from "../runners/providers";
import {
  runTrackedOperation,
  TaskOperationHandle,
} from "../utils/taskOperations";
import { CHAT_HISTORY_FILENAME, CHAT_HISTORY_CORRUPT_FILENAME } from "../utils/chatHistoryConstants";

/**
 * Accepted argument shapes for commitAndPushTask.
 * - Tree-view task node passes { task: IncompleteTask }
 * - Resolver-aware callers pass { canonicalId?, taskFolderPath? }
 */
type CommitAndPushTaskArg =
  | { task?: IncompleteTask }
  | { canonicalId?: string; taskFolderPath?: string };

/**
 * Normalize a command argument into the shape resolveTaskContext expects.
 */
function normalizeArg(node: CommitAndPushTaskArg | undefined): {
  canonicalId?: string;
  taskFolderPath?: string;
} | undefined {
  if (!node) {
    return undefined;
  }

  if ("task" in node && node.task) {
    return { taskFolderPath: node.task.folderUri.fsPath };
  }

  const n = node as { canonicalId?: string; taskFolderPath?: string };
  const hasExplicit = !!(n.canonicalId || n.taskFolderPath);
  return hasExplicit
    ? { canonicalId: n.canonicalId, taskFolderPath: n.taskFolderPath }
    : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Lazily-created singleton output channel used for the full file-list debug
 * surface in the commit-and-push flow. Cleared before each use.
 *
 * Name is pinned: "Ensemble: Commit Preview"
 */
let commitPreviewChannel: vscode.OutputChannel | undefined;
function getCommitPreviewChannel(): vscode.OutputChannel {
  if (!commitPreviewChannel) {
    commitPreviewChannel = vscode.window.createOutputChannel(
      "Ensemble: Commit Preview"
    );
  }
  return commitPreviewChannel;
}

/**
 * Render a repo-relative path for display in modal dialogs and the output
 * channel. Uses JSON string-escaping so quotes, backslashes, tabs, and
 * newlines render losslessly and reversibly.
 *
 * e.g.  src/foo.ts  →  src/foo.ts
 *       a "b".ts    →  "a \"b\".ts"
 */
function renderPath(repoRelativePath: string): string {
  // JSON.stringify adds surrounding quotes and escapes special chars.
  // We only want the escaping, not the outer quotes, unless there are
  // characters that need escaping.
  const json = JSON.stringify(repoRelativePath);
  // If the path contains any character that JSON needed to escape,
  // keep the quoted form; otherwise return the bare path.
  if (json === `"${repoRelativePath}"`) {
    return repoRelativePath;
  }
  return json;
}

/**
 * Check if a file path is inside a folder.
 * Uses proper path boundary checking to avoid false positives.
 * Case normalization is applied on Windows only for drive-letter compatibility.
 */
function isFileInFolder(filePath: string, folderPath: string): boolean {
  // Normalize separators first
  const normalizedFilePath = filePath.replace(/\\/g, "/");
  const normalizedFolderPath = folderPath.replace(/\\/g, "/");

  // Apply case normalization on Windows only
  const isCaseSensitive = process.platform !== "win32";
  const compareFilePath = isCaseSensitive
    ? normalizedFilePath
    : normalizedFilePath.toLowerCase();
  const compareFolderPath = isCaseSensitive
    ? normalizedFolderPath
    : normalizedFolderPath.toLowerCase();

  // Ensure folder path ends with separator for boundary-safe comparison
  const folderPathWithSeparator = compareFolderPath.endsWith("/")
    ? compareFolderPath
    : compareFolderPath + "/";

  return compareFilePath.startsWith(folderPathWithSeparator) ||
         compareFilePath === compareFolderPath;
}

/**
 * Run a git command with safe argument passing (no shell interpolation).
 */
async function runGitCommand(
  cwd: string,
  command: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const gitProcess = spawn("git", [command, ...args], { cwd, shell: false });

    let stdout = "";
    let stderr = "";

    gitProcess.stdout?.on("data", (data: Buffer | string) => {
      stdout += typeof data === "string" ? data : data.toString("utf8");
    });

    gitProcess.stderr?.on("data", (data: Buffer | string) => {
      stderr += typeof data === "string" ? data : data.toString("utf8");
    });

    gitProcess.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(new Error("Git is not installed or not on PATH"));
      } else {
        reject(error);
      }
    });

    gitProcess.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`git ${command} failed with code ${code}\n${stderr}`));
      }
    });
  });
}

/**
 * Generate a suggested structured commit message. Only Copilot-hosted models can
 * service a one-off chat completion like this (CLI providers are agentic
 * file-editing runners with no simple text-completion surface), so this
 * honors the model actually configured for the Publish stage rather than
 * picking whichever Copilot model happens to be first — falling back to a
 * deterministic subject when the configured model can't service the request
 * (a CLI provider is configured, or none is). The caller always shows this
 * suggestion to the user for review/edit/accept before it is ever committed.
 */
async function buildCommitMessage(
  repoRoot: string,
  taskFolderUri: vscode.Uri,
  taskName: string,
  files: string[]
): Promise<string> {
  const diff = await runGitCommand(repoRoot, "diff", ["--cached", "--no-color", "--", ...files]);
  const changed = files.length > 0 ? files.slice(0, 3).map((file) => path.basename(file)).join(", ") : "workspace changes";
  const suffix = files.length > 3 ? ` and ${files.length - 3} more files` : "";
  const fallback = `Ensemble: update ${taskName}\n\nChanges:\n- Updated ${changed}${suffix}\n\nFiles: ${files.length}`;

  const { modelId } = await resolveFreshModelForStage(taskFolderUri, "publish");
  const parsedProvider = parseModelSelection(modelId);
  if (parsedProvider.provider !== "copilot") {
    // Configured stage model is a subscription CLI provider — no chat
    // completion surface is available for it here.
    return fallback;
  }
  const parsedCopilot = parseCopilotModelSelection(parsedProvider.model);

  const cts = new vscode.CancellationTokenSource();
  try {
    const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
    const model = parsedCopilot.model
      ? models.find((m) => m.id === parsedCopilot.model)
      : models.find((m) => m.id.toLowerCase() === "auto" || m.name.toLowerCase() === "auto") ?? models[0];
    if (model) {
      const response = await model.sendRequest([
        vscode.LanguageModelChatMessage.User(`Write an informative git commit message for task ${taskName}. Use a short imperative subject (under 72 characters), then a blank line, then sections named Changes, Added, Removed, and Tests. Include only sections supported by the diff. Return only the commit message.\n\n${diff.stdout.slice(0, 12000)}`)
      ], {}, cts.token);
      let subject = "";
      for await (const part of response.text) subject += part;
      subject = subject.replace(/^['"`]|['"`]$/g, "").trim();
      const subjectLine = subject.split(/\r?\n/, 1)[0] ?? "";
      if (subject && subjectLine.length <= 72) return subject;
    }
  } catch { /* Provider unavailable: retain a deterministic safe fallback. */ } finally {
    cts.cancel();
    cts.dispose();
  }
  return fallback;
}

/**
 * Resolve the git repository root for a given path.
 */
async function resolveGitRepo(
  folderPath: string
): Promise<string | undefined> {
  try {
    const { stdout } = await runGitCommand(folderPath, "rev-parse", [
      "--show-toplevel",
    ]);
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/**
 * Check if there are any changes to commit (optionally scoped to a folder).
 */
async function hasChangesToCommit(
  repoRoot: string,
  scopePath?: string
): Promise<boolean> {
  try {
    const args = ["--porcelain"];
    if (scopePath) {
      args.push("--", scopePath);
    }
    const { stdout } = await runGitCommand(repoRoot, "status", args);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** A single change record from `git status --porcelain=v2 -z`. */
interface PorcelainV2Entry {
  status: string;
  /** Current (destination) path. For renames/copies this is the new path. */
  path: string;
  /** Original path, present only for rename/copy entries. */
  origPath?: string;
}

/**
 * Parse git status --porcelain=v2 -z --untracked-files=all output.
 *
 * Porcelain v2 reports rename/copy changes as a single atomic record
 * (`2 ...`) carrying both the destination path and, as the following
 * NUL-delimited field, the original path — unlike v1, which reports the two
 * endpoints as independent tokens with no structural link between them. That
 * distinction matters here: callers decide inclusion (task-folder scoping,
 * run-artifact exclusion) per record, and a rename must be kept as one unit
 * so both endpoints are staged together rather than a rename being silently
 * split into an orphaned delete on one side of a scope boundary.
 *
 * Record shapes (fields are space-separated; the -z format still uses NUL
 * only to separate whole records, and — for renames only — to separate the
 * trailing origPath from its record):
 *   1 XY sub mH mI mW hH hI path                  (ordinary changed entry)
 *   2 XY sub mH mI mW hH hI X score path\0origPath (rename or copy)
 *   u XY sub m1 m2 m3 mW h1 h2 h3 path             (unmerged)
 *   ? path                                        (untracked)
 *   ! path                                         (ignored)
 */
export function parsePorcelainV2Z(output: string): PorcelainV2Entry[] {
  const tokens = output.split("\0").filter((t) => t.length > 0);
  const results: PorcelainV2Entry[] = [];

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    i++;

    if (token.startsWith("1 ")) {
      const fields = token.split(" ");
      const status = fields[1] ?? "";
      const filePath = fields.slice(8).join(" ");
      if (filePath) results.push({ status, path: filePath });
    } else if (token.startsWith("2 ")) {
      const fields = token.split(" ");
      const status = fields[1] ?? "";
      const filePath = fields.slice(9).join(" ");
      const origPath = i < tokens.length ? tokens[i] : undefined;
      if (origPath !== undefined) i++;
      if (filePath) results.push({ status, path: filePath, origPath });
    } else if (token.startsWith("u ")) {
      const fields = token.split(" ");
      const status = fields[1] ?? "";
      const filePath = fields.slice(10).join(" ");
      if (filePath) results.push({ status, path: filePath });
    } else if (token.startsWith("? ")) {
      results.push({ status: "??", path: token.slice(2) });
    } else if (token.startsWith("! ")) {
      results.push({ status: "!!", path: token.slice(2) });
    }
  }

  return results;
}

/**
 * Chat-transcript basenames (chatHistoryStore.ts). Under the transcript
 * staging policy (Option A — never-stage, non-overridable), these must never
 * be staged by Commit and Push through any path: they are plaintext
 * prompt/response content, unlike run artifacts which can be opted back in.
 */
const SENSITIVE_TASK_FILE_BASENAMES = new Set([
  CHAT_HISTORY_FILENAME,
  CHAT_HISTORY_CORRUPT_FILENAME,
]);

/**
 * Repo-relative path of the task ROOT (the parent directory holding every
 * task folder, e.g. "plans"), not just the current task's own folder. Chat
 * transcripts must be excluded for every task under this root — not only
 * the current one — since default-mode staging would otherwise sweep a
 * sibling task's transcript in as an ordinary "source change" outside this
 * task's own folder. Returns undefined when the task root can't be
 * expressed as a repo-relative path (e.g. configured outside the repo), in
 * which case no entry can match it and sensitivity filtering is a no-op.
 */
function taskRootRelativeFor(repoRoot: string, taskFolderPath: string): string | undefined {
  const taskRoot = path.resolve(taskFolderPath, "..");
  const relative = path.relative(repoRoot, taskRoot).replace(/\\/g, "/");
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative;
}

function isUnderTaskRoot(entryPath: string, taskRootRelative: string): boolean {
  return (
    taskRootRelative === "" ||
    entryPath === taskRootRelative ||
    entryPath.startsWith(taskRootRelative + "/")
  );
}

/**
 * True when `entryPath` is a chat-transcript file (or its quarantine copy)
 * for some task under `taskRootRelative`. Scoped to the task root so a file
 * that happens to share a transcript's basename elsewhere in the repo is
 * never matched.
 */
function isSensitiveTaskFile(entryPath: string, taskRootRelative: string | undefined): boolean {
  if (taskRootRelative === undefined) return false;
  if (!isUnderTaskRoot(entryPath, taskRootRelative)) return false;
  return SENSITIVE_TASK_FILE_BASENAMES.has(path.basename(entryPath));
}

/**
 * Final gate: strips chat-transcript files — this task's or any sibling
 * task's — from a staging list immediately before it is shown to the user
 * or staged with `git add`. Re-applied here regardless of which path above
 * built `scopedFiles`, catching any entry whose OWN path matches a
 * transcript basename.
 *
 * This is necessarily a basename check over a flat path list, so it cannot
 * by itself catch a transcript renamed to an innocuous destination path
 * (the rename's origin information isn't in this list — it was already
 * discarded when `scopedFiles` was flattened). That case is caught earlier,
 * in `getChangedFiles`, which still has each rename/copy record's origin
 * path available and treats the whole record as sensitive if either
 * endpoint is: see the "destSensitive || origSensitive" check there. Both
 * layers are needed; this one alone is not sufficient for renames.
 */
export function stripSensitiveTaskFiles(
  scopedFiles: string[],
  repoRoot: string,
  taskFolderPath: string
): string[] {
  const taskRootRelative = taskRootRelativeFor(repoRoot, taskFolderPath);
  if (taskRootRelative === undefined) return scopedFiles;
  return scopedFiles.filter((f) => !isSensitiveTaskFile(f, taskRootRelative));
}

/**
 * Get the list of changed files scoped to the implemented source changes
 * (default mode: everything OUTSIDE the task folder) or the entire repo,
 * task folder included (include-task-folder mode).
 *
 * Returns:
 *  - scopedFiles: files to be staged and shown in the preview
 *  - repoFiles:   all changed files in the repo (for display of what's excluded)
 *  - runArtifactPaths: run-artifact files under the task folder, excluded by
 *    default but eligible for the "Include Run Artifacts" override
 *  - sensitiveFilePaths: chat-transcript files, excluded in EVERY mode
 *    (including includeTaskFolder) — never eligible for that override. A
 *    rename/copy record is classified here using BOTH its endpoints (see the
 *    "destSensitive || origSensitive" check below), since this is the one
 *    place where a rename's origin path is still available; the later
 *    `stripSensitiveTaskFiles` gate only sees a flattened path list.
 */
export async function getChangedFiles(
  repoRoot: string,
  taskFolderPath: string,
  includeTaskFolder: boolean
): Promise<{
  scopedFiles: string[];
  repoFiles: string[];
  runArtifactPaths: string[];
  sensitiveFilePaths: string[];
}> {
  try {
    const { stdout } = await runGitCommand(repoRoot, "status", [
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
    ]);

    const allEntries = parsePorcelainV2Z(stdout);

    // Compute the task folder relative to the repo root
    const taskRelative = path
      .relative(repoRoot, taskFolderPath)
      .replace(/\\/g, "/");
    const taskRootRelative = taskRootRelativeFor(repoRoot, taskFolderPath);

    // Identify run-artifact paths (runs/ and context-pack.md under the task folder)
    const runArtifactPaths: string[] = [];
    const sensitiveFilePaths: string[] = [];
    const scopedFiles: string[] = [];
    const repoFiles: string[] = [];

    for (const entry of allEntries) {
      // A rename/copy is one logical change with two path endpoints. Scope
      // and count it as a single unit anchored on the destination path so it
      // can never be split across the task-folder boundary — e.g. only the
      // deletion half staged while the addition half is excluded (or vice
      // versa), which would corrupt the rename into an orphaned add/delete.
      repoFiles.push(entry.path);

      // Chat transcripts are excluded in every mode, for every task under
      // the task root — never included by includeTaskFolder, and never
      // eligible for the run-artifact override below. Checked against BOTH
      // endpoints of a rename/copy: content survives a `git mv` to an
      // innocuous-looking destination path (e.g. moving chat-v1.json out of
      // the task root, or to a non-transcript basename inside it), so
      // checking only entry.path would let transcript content reach staging
      // under a new name. Either endpoint being sensitive taints the whole
      // record — neither endpoint may enter scopedFiles/runArtifactPaths.
      if (
        isSensitiveTaskFile(entry.path, taskRootRelative) ||
        (entry.origPath !== undefined && isSensitiveTaskFile(entry.origPath, taskRootRelative))
      ) {
        sensitiveFilePaths.push(entry.path);
        if (entry.origPath !== undefined && entry.origPath !== entry.path) {
          sensitiveFilePaths.push(entry.origPath);
        }
        continue;
      }

      // Determine if this file is inside the task folder
      const isInTaskFolder =
        entry.path === taskRelative ||
        entry.path.startsWith(taskRelative + "/");

      // Default mode stages the implemented source — everything OUTSIDE the
      // task folder. The task folder holds planning metadata, not the code
      // changes, so it is excluded unless the caller opts in.
      if (!includeTaskFolder && isInTaskFolder) {
        continue;
      }

      // Check for run artifacts (runs/ directory and context-pack.md)
      const isRunArtifact =
        entry.path.startsWith(taskRelative + "/runs/") ||
        entry.path === taskRelative + "/context-pack.md" ||
        entry.path === taskRelative + "/pr-description.md";

      if (isRunArtifact) {
        runArtifactPaths.push(entry.path);
        // Run artifacts are always excluded from the staged set here. The
        // "Include Run Artifacts" flow opts in separately by re-fetching and
        // filtering, rather than via this function.
        continue;
      }

      scopedFiles.push(entry.path);
      // Stage both rename endpoints together: `git add` on the destination
      // alone would record only an addition, leaving the vacated origPath
      // untracked-removed rather than committed as part of the same rename.
      if (entry.origPath) {
        scopedFiles.push(entry.origPath);
      }
    }

    return {
      scopedFiles: scopedFiles.filter((f) => f.length > 0),
      repoFiles: repoFiles.filter((f) => f.length > 0),
      runArtifactPaths,
      sensitiveFilePaths,
    };
  } catch {
    return { scopedFiles: [], repoFiles: [], runArtifactPaths: [], sensitiveFilePaths: [] };
  }
}

/**
 * Extract first H1 from markdown content
 */
function extractFirstH1(content: string): string | undefined {
  const match = /^# (.+)$/m.exec(content);
  return match?.[1]?.trim();
}

/**
 * Extract first non-empty paragraph from a section
 */
function extractFirstParagraph(content: string): string | undefined {
  const lines = content.split(/\r?\n/);
  let paragraph = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0 && !trimmed.startsWith("#")) {
      paragraph += (paragraph ? " " : "") + trimmed;
    } else if (paragraph.length > 0) {
      break;
    }
  }
  return paragraph.length > 0 ? paragraph : undefined;
}

/**
 * Extract section body from markdown content
 */
function extractSectionBody(
  content: string,
  sectionHeader: string
): string | undefined {
  const headerIndex = content.indexOf(sectionHeader);
  if (headerIndex === -1) {
    return undefined;
  }

  const afterHeader = content.slice(headerIndex + sectionHeader.length);
  const nextHeaderMatch = /^## /m.exec(afterHeader);
  const sectionEnd = nextHeaderMatch
    ? headerIndex + sectionHeader.length + nextHeaderMatch.index
    : content.length;

  return content
    .slice(headerIndex + sectionHeader.length, sectionEnd)
    .trim();
}

/**
 * Generate PR description from task artifacts
 */
async function generatePRDescription(
  taskFolderPath: string,
  folderName: string,
  changedFiles: string[]
): Promise<string> {
  const taskFileUri = vscode.Uri.file(path.join(taskFolderPath, TASK_FILENAME));
  const taskFolderUri = vscode.Uri.file(taskFolderPath);
  const implementationArtifact = await resolveImplementationArtifact(
    taskFolderUri
  );
  const lowLevelPlanUri = getLowLevelPlanUri(taskFolderUri);

  // Read task.md
  let taskTitle = folderName;
  let summary = "No summary provided.";
  try {
    const taskBytes = await vscode.workspace.fs.readFile(taskFileUri);
    const taskContent = new TextDecoder().decode(taskBytes);
    taskTitle = extractFirstH1(taskContent) ?? folderName;

    const taskDescBody =
      extractSectionBody(taskContent, "## Task Description");
    if (taskDescBody) {
      summary = extractFirstParagraph(taskDescBody) ?? summary;
    } else {
      const draftBody = extractSectionBody(taskContent, "## Draft with AI");
      if (draftBody) {
        summary = extractFirstParagraph(draftBody) ?? summary;
      }
    }
  } catch {
    // ignore
  }

  // Implementation summary
  let implementationSummary = "Implementation summary not available.";
  try {
    const implBytes = await vscode.workspace.fs.readFile(
      implementationArtifact.uri
    );
    const implContent = new TextDecoder().decode(implBytes);
    const implSection = extractSectionBody(
      implContent,
      "## Implementation"
    );
    if (implSection) {
      implementationSummary = extractFirstParagraph(implSection) ?? implSection;
    } else {
      implementationSummary =
        extractFirstParagraph(implContent) ?? implementationSummary;
    }
  } catch {
    // ignore
  }

  // Testing summary
  let testingSummary = "Testing summary not available.";
  try {
    const implBytes = await vscode.workspace.fs.readFile(
      implementationArtifact.uri
    );
    const implContent = new TextDecoder().decode(implBytes);
    const testingSection = extractSectionBody(implContent, "## Testing");
    if (testingSection) {
      testingSummary = extractFirstParagraph(testingSection) ?? testingSection;
    }
  } catch {
    try {
      const lowLevelBytes = await vscode.workspace.fs.readFile(lowLevelPlanUri);
      const lowLevelContent = new TextDecoder().decode(lowLevelBytes);
      const testingSection = extractSectionBody(
        lowLevelContent,
        "## Testing"
      );
      if (testingSection) {
        testingSummary =
          extractFirstParagraph(testingSection) ?? testingSection;
      }
    } catch {
      // ignore
    }
  }

  const parts: string[] = [];
  parts.push(`# ${taskTitle}`);
  parts.push("");
  parts.push("## Summary");
  parts.push("");
  parts.push(summary);
  parts.push("");
  parts.push("## Implementation");
  parts.push("");
  parts.push(implementationSummary);
  parts.push("");
  parts.push("## Testing");
  parts.push("");
  parts.push(testingSummary);
  parts.push("");
  parts.push("## Changed Files");
  parts.push("");
  if (changedFiles.length > 0) {
    for (const file of changedFiles) {
      parts.push(`- ${file}`);
    }
  } else {
    parts.push("- (no changes)");
  }
  parts.push("");

  return parts.join("\n");
}

/**
 * Save relevant dirty documents before git operations.
 * In default (source-only) mode, only saves documents outside the task
 * folder plus the always-relevant task/plan artifacts. In
 * include-task-folder mode, saves any dirty document in the repo.
 */
async function saveDirtyDocuments(
  taskFolderPath: string,
  repoRoot: string,
  includeTaskFolder: boolean
): Promise<boolean> {
  const taskFileUri = vscode.Uri.file(path.join(taskFolderPath, TASK_FILENAME));
  const taskFolderUri = vscode.Uri.file(taskFolderPath);
  const implementationArtifact = await resolveImplementationArtifact(
    taskFolderUri
  );
  const lowLevelPlanUri = getLowLevelPlanUri(taskFolderUri);

  const relevantPaths = new Set([
    taskFileUri.fsPath,
    implementationArtifact.uri.fsPath,
    lowLevelPlanUri.fsPath,
  ]);

  const dirtyDocs = vscode.workspace.textDocuments.filter((doc) => {
    if (!doc.isDirty) {
      return false;
    }
    if (relevantPaths.has(doc.uri.fsPath)) {
      return true;
    }
    // In default (source-only) mode: only save files outside the task folder
    if (!includeTaskFolder) {
      return (
        isFileInFolder(doc.uri.fsPath, repoRoot) &&
        !isFileInFolder(doc.uri.fsPath, taskFolderPath)
      );
    }
    // In include-task-folder mode: save any dirty file in the repo
    return isFileInFolder(doc.uri.fsPath, repoRoot);
  });

  for (const doc of dirtyDocs) {
    const saved = await doc.save();
    if (!saved || doc.isDirty) {
      void vscode.window.showErrorMessage(
        `Could not save ${path.basename(doc.uri.fsPath)}. Please save all files before committing.`
      );
      return false;
    }
  }

  return true;
}

/**
 * Determine the push destination string for display in the confirm dialog.
 */
async function describePushDestination(
  repoRoot: string,
  currentBranch: string
): Promise<{ description: string; hasUpstream: boolean; singleRemote?: string }> {
  // Try to find upstream
  try {
    const { stdout } = await runGitCommand(repoRoot, "rev-parse", [
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]);
    const upstream = stdout.trim();
    if (upstream) {
      return { description: upstream, hasUpstream: true };
    }
  } catch {
    // No upstream
  }

  // Try single remote
  try {
    const { stdout } = await runGitCommand(repoRoot, "remote", []);
    const remotes = stdout.trim().split("\n").filter((r) => r.length > 0);
    if (remotes.length === 1) {
      return {
        description: `${remotes[0]}/${currentBranch} (first push — will set upstream)`,
        hasUpstream: false,
        singleRemote: remotes[0],
      };
    }
    if (remotes.length > 1) {
      return {
        description: `(multiple remotes: ${remotes.join(", ")} — cannot auto-push)`,
        hasUpstream: false,
      };
    }
  } catch {
    // ignore
  }

  return { description: "(no remote configured)", hasUpstream: false };
}

/**
 * Commit and push the current task.
 *
 * ⚠️ RISK NOTICE (IMPORTANT — READ BEFORE MODIFYING):
 *
 * Default mode: stages the implemented source changes — every changed file
 * OUTSIDE the task folder. The task folder holds planning metadata
 * (task.md, plan.md, run logs), not the code changes being shipped, so it
 * is excluded from the default staged set.
 * Include-task-folder mode: also stages changes inside the task folder
 * (requires explicit opt-in), still excluding run artifacts unless the
 * user separately opts into those too.
 *
 * Run artifacts (runs/, context-pack.md) contain full AI prompts and
 * file contents. They are excluded from the default staged set.
 *
 * This command does NOT roll back local commits if push fails.
 * If push fails, the local commit is kept and the user is shown how to undo.
 *
 * See DISCLAIMER.md §4 for the full risk disclosure.
 */
export async function commitAndPushTask(
  inventory: TaskInventory,
  explicitArg?: CommitAndPushTaskArg,
  currentTaskStore?: CurrentTaskStore,
  parentOperation?: TaskOperationHandle,
  extensionContext?: vscode.ExtensionContext
): Promise<void> {
  const resolverArg = normalizeArg(explicitArg);

  // Resolution order (matches resolveTaskContext contract):
  //   1. explicit task arg (tree node, canonical ID, folder path) — highest precedence
  //   2. persisted current-task canonical ID from CurrentTaskStore
  // Malformed explicit args are hard failures (no redirect to unrelated tasks).
  const resolvedTask = await resolveTaskContext(inventory, resolverArg, {
    allowPaused: true,
  }, currentTaskStore);

  if (!resolvedTask) {
    // If an explicit arg was supplied but resolution failed, the task is gone;
    // a clear error was already shown by resolveTaskContext. If no arg and no
    // persisted task, guide the user.
    if (resolverArg) {
      void vscode.window.showErrorMessage(
        "The task could not be found. It may have been deleted or moved. " +
          "Please refresh the Tasks panel and try again."
      );
    } else {
      NotificationRouter.showInformation(
        "Select a completed task in the Tasks panel to commit and push, " +
          "or invoke this command from that task's completed row."
      );
    }
    return;
  }

  // Allow committing from completed stage only
  if (resolvedTask.progress.currentStage !== "publish") {
    NotificationRouter.showWarning(
      `Task is at stage "${STAGE_DISPLAY_NAMES[resolvedTask.progress.currentStage]}" — must be completed before committing and pushing.`
    );
    return;
  }

  // Acquire the exclusive task-operation guard BEFORE any lint, prompts,
  // staging, commit, or push work starts. A duplicate invocation (e.g. a
  // fast double-click) must be refused here, not partway through — lint runs
  // and the lint-failure modal below are not idempotent-safe against a
  // second concurrent invocation on the same task. When invoked as part of
  // the Complete/Commit/Push composite, this registers as a child of that
  // root (C1 nesting) instead of contending for the lock the root holds.
  const lockKey = resolvedTask.taskFolderPath;
  try {
  await runTrackedOperation(
    lockKey,
    { label: "Commit and Push", taskName: resolvedTask.folderName, kind: "commit-push", parent: parentOperation },
    async (op) => {
    // Always run fresh checks immediately before a commit. Persisted payloads
    // are informational and may be stale after files were edited. Registered
    // as a child (C1 publish model) so the Publish stage row spins while the
    // pre-commit checks run. Every run — passing, failing, or a post-fix
    // rerun — is also recorded in publish-review.md's managed Completion
    // Checks section by runCompletionLint itself (completionLint.ts), so the
    // artifact always reflects the latest result whatever the user decides
    // below; the Publish Anyway branch only layers the override annotation on
    // top of that record.
    const runChecks = async (): Promise<CompletionLintResult> =>
      (await runTrackedOperation(
        lockKey,
        { parent: op, label: "Completion checks", stage: "publish", kind: "completion-checks" },
        () => runCompletionLint(vscode.Uri.file(resolvedTask.taskFolderPath), resolvedTask.progress.implReviewFiles)
      ))!;
    let lintPayload = await runChecks();
    // Failing checks surface a three-way decision (C3): Publish Anyway,
    // Fix with AI, or Cancel (the modal's dismiss affordance). Fix with AI
    // runs the linting-fixes flow — editor autofixes plus the configured
    // Publish-stage agent fed the failing lint/test output — nested under
    // this operation, then checks re-run before publishing can continue, so
    // a fix pass that didn't resolve everything re-surfaces this decision.
    while (!lintPayload.passed) {
      const summary = lintPayload.summary ? ` (${lintPayload.summary})` : "";
      const choice = await vscode.window.showWarningMessage(
        `Completion checks failed for "${resolvedTask.folderName}"${summary}.\n\n` +
          "Publish Anyway records the failing checks in the Publish review. " +
          "Fix with AI applies automatic and AI fixes using the failing check output, then re-runs the checks.",
        { modal: true },
        "Publish Anyway",
        "Fix with AI"
      );
      if (choice === "Publish Anyway") {
        // The override lives here, in the publish flow (C3): task completion
        // is ungated and never records overrides — publishing over failing
        // checks is the decision worth an audit trail in publish-review.md.
        await upsertCompletionChecksInPublishReview(
          vscode.Uri.file(resolvedTask.taskFolderPath),
          lintPayload,
          { reason: "user chose Publish Anyway despite failing checks" }
        );
        break;
      }
      if (choice !== "Fix with AI") {
        NotificationRouter.showInformation("Commit and push cancelled.");
        return;
      }
      if (!extensionContext) {
        // Programmatic invocation without an ExtensionContext: the fix flow
        // needs prompt templates and the AI-consent state, so point at the
        // standalone command instead of failing partway through.
        NotificationRouter.showWarning(
          'Fix with AI is unavailable here — run "Linting Fixes" from the task\'s Publish actions, then retry Commit and Push.'
        );
        return;
      }
      await runLintingFixes(
        inventory,
        extensionContext.extensionUri,
        { taskFolderPath: resolvedTask.taskFolderPath },
        extensionContext,
        op
      );
      lintPayload = await runChecks();
    }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: `Committing and pushing ${resolvedTask.folderName}...`,
      cancellable: false,
    },
    async (progress) => {
      NotificationRouter.emitProgressSummary(`Committing and pushing ${resolvedTask.folderName}...`);
      try {
        // Resolve repository
        progress.report({ message: "Resolving git repository..." });
        const repoRoot = await resolveGitRepo(resolvedTask.taskFolderPath);
        if (!repoRoot) {
          throw new Error(
            "Could not find git repository. Make sure the task is inside a git repository."
          );
        }

        // Handle pre-existing staged changes. When EVERYTHING that changed
        // is already staged, commit/push proceeds without raising an error
        // (the staged files are part of the porcelain status and flow into
        // the preview and commit). When only SOME changes are staged, the
        // user chooses: commit everything together, or cancel and handle
        // the existing staged changes manually.
        const { stdout: stagedOutput } = await runGitCommand(
          repoRoot,
          "diff",
          ["--cached", "--name-only"]
        );
        const preStagedFiles = stagedOutput.trim().split(/\r?\n/).filter(Boolean);
        if (preStagedFiles.length > 0) {
          const { stdout: unstagedOutput } = await runGitCommand(
            repoRoot,
            "diff",
            ["--name-only"]
          );
          const { stdout: untrackedOutput } = await runGitCommand(
            repoRoot,
            "ls-files",
            ["--others", "--exclude-standard"]
          );
          const hasUnstagedChanges =
            unstagedOutput.trim().length > 0 || untrackedOutput.trim().length > 0;
          if (hasUnstagedChanges) {
            const choice = await vscode.window.showWarningMessage(
              `This repository already has ${preStagedFiles.length} staged change(s) alongside unstaged changes.\n\n` +
                "Commit everything together (staged and unstaged changes in one commit), " +
                "or cancel to handle the existing staged changes manually first.",
              { modal: true },
              "Commit Everything Together"
            );
            if (choice !== "Commit Everything Together") {
              NotificationRouter.showInformation(
                "Commit and push cancelled — handle the existing staged changes manually, then retry."
              );
              throw new vscode.CancellationError();
            }
          }
        }

        // Determine staging scope: default to the implemented source changes
        // (everything OUTSIDE the task folder), since that's what "commit
        // and push" is meant to ship. The task folder holds planning
        // metadata (task.md, plan.md, run logs), not the code changes.
        progress.report({ message: "Collecting changed files..." });
        let includeTaskFolder = false;
        let { scopedFiles, repoFiles, runArtifactPaths, sensitiveFilePaths } = await getChangedFiles(
          repoRoot,
          resolvedTask.taskFolderPath,
          includeTaskFolder
        );

        if (scopedFiles.length === 0) {
          // No source changes — everything that changed lives inside the
          // task folder. Offer to include it, or bail out if nothing changed.
          const hasRepoChanges = await hasChangesToCommit(repoRoot);
          if (!hasRepoChanges) {
            NotificationRouter.showInformation(
              "No changes to commit — the repository is clean."
            );
            return;
          }

          const choice = await vscode.window.showInformationMessage(
            "No source code changes found outside the task folder.\n\n" +
              "Only the task's planning files (in the task folder) have changed. " +
              "Include the task folder in this commit instead?",
            { modal: true },
            "Include Task Folder Changes",
          );
          if (choice !== "Include Task Folder Changes") {
            NotificationRouter.showInformation("Commit and push cancelled.");
            return;
          }
          includeTaskFolder = true;
          ({ scopedFiles, repoFiles, runArtifactPaths, sensitiveFilePaths } = await getChangedFiles(
            repoRoot,
            resolvedTask.taskFolderPath,
            includeTaskFolder
          ));

          if (scopedFiles.length === 0) {
            // All task-folder changes were run artifacts
            const artifactChoice = await vscode.window.showWarningMessage(
              "The only changes in the task folder are run artifacts " +
                "(runs/, context-pack.md). " +
                "These are excluded from the default staged set because they " +
                "contain AI prompts and file contents.\n\n" +
                "Include run artifacts in this commit?",
              { modal: true },
              "Include Run Artifacts",
            );
            if (artifactChoice === "Include Run Artifacts") {
              const taskRelative = path
                .relative(repoRoot, resolvedTask.taskFolderPath)
                .replace(/\\/g, "/");
              // Chat transcripts are never eligible for this override — even
              // though they live under the task folder like run artifacts,
              // the transcript staging policy (Option A) never stages them.
              // Filtered against `sensitiveFilePaths` (this same
              // getChangedFiles call's classification), not a basename
              // re-check: a transcript renamed to an innocuous basename still
              // inside the task folder carries a destination path that
              // getChangedFiles has already tagged as sensitive because its
              // rename origin was a transcript, but whose own basename would
              // pass a plain SENSITIVE_TASK_FILE_BASENAMES check.
              const sensitivePathSet = new Set(sensitiveFilePaths);
              scopedFiles.push(...repoFiles.filter((f) => {
                if (!(f === taskRelative || f.startsWith(taskRelative + "/"))) return false;
                return !sensitivePathSet.has(f);
              }));
            } else {
              NotificationRouter.showInformation("Commit and push cancelled.");
              return;
            }
          }
        }

        // Get current branch and push destination for the confirm dialog
        let currentBranch = "(unknown)";
        try {
          const { stdout: branchOut } = await runGitCommand(repoRoot, "rev-parse", [
            "--abbrev-ref",
            "HEAD",
          ]);
          currentBranch = branchOut.trim();
        } catch {
          // ignore
        }

        if (currentBranch === "HEAD") {
          throw new Error(
            "Repository is in detached HEAD state. Check out a branch before committing."
          );
        }

        const { description: pushDestination, hasUpstream, singleRemote } =
          await describePushDestination(repoRoot, currentBranch);

        if (!hasUpstream && !singleRemote) {
          // Multiple remotes or no remote — cannot auto-push
          throw new Error(
            `Push target is ambiguous: ${pushDestination}. ` +
              `Set an upstream manually with: git push -u <remote> ${currentBranch}`
          );
        }

        // Final gate (the invariant): re-applied here regardless of which
        // path above built `scopedFiles` — default fetch, include-task-folder
        // re-fetch, or the run-artifact override re-add — so no chat
        // transcript can reach the preview the user is about to confirm.
        scopedFiles = stripSensitiveTaskFiles(scopedFiles, repoRoot, resolvedTask.taskFolderPath);

        // ----------------------------------------------------------------
        // ⚠️  CONFIRMATION DIALOG with file preview and push destination
        //
        // This is the critical safety gate. Staging and pushing are NOT
        // reversible once changes reach a shared remote.
        // ----------------------------------------------------------------
        const MAX_PREVIEW_FILES = 15;
        const previewFiles = scopedFiles.slice(0, MAX_PREVIEW_FILES);
        const remaining = scopedFiles.length - previewFiles.length;

        const scopeLabel = includeTaskFolder
          ? "all repository changes, including the task folder"
          : "source changes only (task folder excluded by default)";

        const fileList = previewFiles
          .map((f) => {
            const isRunArtifact = runArtifactPaths.includes(f);
            const marker = isRunArtifact ? " ⚠ (run artifact — contains AI prompts)" : "";
            return `  • ${renderPath(f)}${marker}`;
          })
          .join("\n");
        const moreNote =
          remaining > 0 ? `\n  … and ${remaining} more file(s)` : "";

        const notStagedCount = repoFiles.length - scopedFiles.length;
        const repoExtra =
          !includeTaskFolder && notStagedCount > 0
            ? `\n\n(${notStagedCount} file(s) changed in the task folder — not staged by default)`
            : "";
        const sensitiveExtra =
          sensitiveFilePaths.length > 0
            ? `\n\n(${sensitiveFilePaths.length} chat transcript file(s) excluded — plaintext prompt/response content, never staged by this command)`
            : "";

        const confirmMessage =
          `⚠️ Commit and push — please review carefully\n\n` +
          `Scope: ${scopeLabel}\n` +
          `Branch: ${currentBranch}\n` +
          `Destination: ${pushDestination}\n\n` +
          `Files to be staged (${scopedFiles.length} total):\n` +
          fileList +
          moreNote +
          repoExtra +
          sensitiveExtra +
          `\n\nPushing is outward-facing and largely irreversible.\n` +
          `Run artifacts (runs/, context-pack.md) contain AI prompts and file contents.\n` +
          `See DISCLAIMER.md §4-5 for full risk details.\n\n` +
          `Proceed?`;

        const confirmed = await vscode.window.showWarningMessage(
          confirmMessage,
          { modal: true },
          "Commit & Push",
          "View Full List"
        );

        if (confirmed === "View Full List") {
          // Show the full file list in the output channel and return —
          // the user can re-invoke the command after reviewing.
          const channel = getCommitPreviewChannel();
          channel.clear();
          channel.appendLine("=== Ensemble: Commit Preview — Full File List ===");
          channel.appendLine("");
          channel.appendLine(`Scope: ${scopeLabel}`);
          channel.appendLine(`Branch: ${currentBranch}`);
          channel.appendLine(`Destination: ${pushDestination}`);
          channel.appendLine("");
          channel.appendLine(`Files to be staged (${scopedFiles.length} total):`);
          for (const f of scopedFiles) {
            const isRunArtifact = runArtifactPaths.includes(f);
            const marker = isRunArtifact
              ? "  [run artifact — contains AI prompts and file contents]"
              : "";
            channel.appendLine(`  ${renderPath(f)}${marker}`);
          }
          if (!includeTaskFolder && notStagedCount > 0) {
            channel.appendLine("");
            channel.appendLine("Not staged (inside task folder, excluded by default):");
            const taskRelative = path
              .relative(repoRoot, resolvedTask.taskFolderPath)
              .replace(/\\/g, "/");
            for (const f of repoFiles) {
              const inTaskFolder = f === taskRelative || f.startsWith(taskRelative + "/");
              if (inTaskFolder) {
                channel.appendLine(`  ${renderPath(f)}`);
              }
            }
          }
          if (sensitiveFilePaths.length > 0) {
            channel.appendLine("");
            channel.appendLine("Excluded — chat transcripts (plaintext prompt/response content, never staged by this command):");
            for (const f of sensitiveFilePaths) {
              channel.appendLine(`  ${renderPath(f)}`);
            }
          }
          channel.appendLine("");
          channel.appendLine("Run the command again to proceed after reviewing.");
          channel.show(true);
          NotificationRouter.showInformation(
            "Full file list shown in 'Ensemble: Commit Preview'. Re-run the command to proceed."
          );
          // End the tracked operation as cancelled, not succeeded — nothing
          // was committed or pushed, so a "completed" terminal entry here
          // would falsely report success. Swallowed at the outer call.
          throw new vscode.CancellationError();
        }

        if (confirmed !== "Commit & Push") {
          NotificationRouter.showInformation(
            "Commit and push cancelled."
          );
          return;
        }

        // Save dirty documents (scoped to source files, or entire repo)
        progress.report({ message: "Saving open files..." });
        const saved = await saveDirtyDocuments(
          resolvedTask.taskFolderPath,
          repoRoot,
          includeTaskFolder
        );
        if (!saved) {
          return;
        }

        // Generate PR description
        progress.report({ message: "Generating PR description..." });
        const prDescription = await generatePRDescription(
          resolvedTask.taskFolderPath,
          resolvedTask.folderName,
          scopedFiles
        );
        const prDescPath = path.join(
          resolvedTask.taskFolderPath,
          "pr-description.md"
        );
        const prDescUri = vscode.Uri.file(prDescPath);

        // Write PR description atomically
        const tempPath = prDescPath + ".tmp";
        const tempUri = vscode.Uri.file(tempPath);
        await vscode.workspace.fs.writeFile(
          tempUri,
          new TextEncoder().encode(prDescription)
        );
        await vscode.workspace.fs.rename(tempUri, prDescUri, {
          overwrite: true,
        });

        try {
          // Final gate, reapplied immediately before the actual `git add` —
          // the true invariant point. Nothing rebuilds scopedFiles between
          // the confirmation preview and here today, but this call is what
          // makes that a property of the code rather than an assumption.
          scopedFiles = stripSensitiveTaskFiles(scopedFiles, repoRoot, resolvedTask.taskFolderPath);

          // Stage changes — always exactly the scopedFiles list the user
          // just confirmed in the preview dialog above (never a bare `-A`,
          // which would silently stage excluded run artifacts too).
          progress.report({ message: "Staging changes..." });
          if (scopedFiles.length > 0) {
            await runGitCommand(repoRoot, "add", [
              "--",
              ...scopedFiles,
            ]);
          }

          // Commit message — generated from the configured Publish-stage
          // model when possible, always shown to the user to review, edit,
          // or accept before anything is committed.
          progress.report({ message: "Generating commit message..." });
          const suggestedMessage = await buildCommitMessage(
            repoRoot,
            vscode.Uri.file(resolvedTask.taskFolderPath),
            resolvedTask.folderName,
            scopedFiles
          );
          const commitMessage = await vscode.window.showInputBox({
            title: "Commit Message — review before committing",
            prompt: "Edit the commit message if needed, then press Enter to commit and push.",
            value: suggestedMessage,
            valueSelection: [0, suggestedMessage.length],
            ignoreFocusOut: true,
          });
          if (!commitMessage || commitMessage.trim().length === 0) {
            // Undo the staging performed above. Nothing else was staged
            // before this run started (verified earlier in this function),
            // so a plain reset cleanly restores the pre-run state.
            await runGitCommand(repoRoot, "reset", []);
            NotificationRouter.showInformation("Commit and push cancelled.");
            return;
          }

          // Commit
          progress.report({ message: "Creating commit..." });
          await runGitCommand(repoRoot, "commit", ["-m", commitMessage]);

          // Push with explicit destination
          progress.report({ message: "Pushing to remote..." });
          if (hasUpstream) {
            // Upstream exists — push explicitly to avoid ambiguity
            await runGitCommand(repoRoot, "push", []);
          } else if (singleRemote) {
            // First push — set upstream
            await runGitCommand(repoRoot, "push", [
              "-u",
              singleRemote,
              currentBranch,
            ]);
          }

          NotificationRouter.showInformation(
            `Successfully committed and pushed ${resolvedTask.folderName} to ${pushDestination}`
          );
        } catch (error: unknown) {
          // Push failed after commit was created — keep the local commit.
          // Do NOT automatically roll back: this mutates user's git history
          // without their explicit instruction. Instead, tell them how to
          // undo manually if they want to.
          const errMsg = getErrorMessage(error);
          void vscode.window.showErrorMessage(
            `Push failed. Your local commit was kept — it has NOT been rolled back automatically.\n\n` +
            `To undo the commit manually: git reset --mixed HEAD~1\n\n` +
            `Error: ${errMsg}`
          );
        }
      } catch (error: unknown) {
        if (error instanceof vscode.CancellationError) {
          // "View Full List" (and genuine cancellations) end the tracked
          // operation as cancelled instead of falsely reporting success.
          throw error;
        }
        void vscode.window.showErrorMessage(
          `Commit and push failed: ${getErrorMessage(error)}`
        );
      }
    }
  );
    }
  );
  } catch (error) {
    if (!(error instanceof vscode.CancellationError)) {
      throw error;
    }
  }
}

/**
 * Combined complete + commit + push command.
 * Marks the task completed, selects the next task, and commits/pushes the completed task.
 */
export async function completeCommitAndPushTask(
  inventory: TaskInventory,
  explicitArg?: CommitAndPushTaskArg,
  currentTaskStore?: CurrentTaskStore,
  extensionContext?: vscode.ExtensionContext
): Promise<void> {
  const resolverArg = normalizeArg(explicitArg);
  const resolvedTask = await resolveTaskContext(inventory, resolverArg, {
    allowPaused: false,
  }, currentTaskStore);

  if (!resolvedTask) {
    if (resolverArg) {
      void vscode.window.showErrorMessage(
        "The task could not be found. It may have been deleted or moved. " +
          "Please refresh the Tasks panel and try again."
      );
    } else {
      NotificationRouter.showInformation(
        "No active task found to complete, commit, and push."
      );
    }
    return;
  }

  // Check stage eligibility: must be at final review stage (impl-low-review) or completed
  if (resolvedTask.progress.currentStage !== "impl-low-review") {
    if (resolvedTask.progress.currentStage === "publish") {
      // If already completed, fall back directly to commit & push
      return commitAndPushTask(inventory, explicitArg, currentTaskStore, undefined, extensionContext);
    }
    NotificationRouter.showWarning(
      `"Complete, Commit and Push" is only available when the task is at the final review stage (Implementation: Low-Level Review) or completed.`
    );
    return;
  }

  // One root operation guards the ENTIRE composite — lint, advance, complete,
  // next-task selection, and the commit/push itself (registered below as a
  // child of this root, so it never contends for the lock this root holds).
  // This closes the former race window where the lock was released before
  // commitAndPushTask reacquired it and a second invocation could slip in.
  const lockKey = resolvedTask.taskFolderPath;
  await runTrackedOperation(
    lockKey,
    { label: "Complete, Commit and Push", taskName: resolvedTask.folderName, kind: "complete-commit-push" },
    async (op) => {
    // 1. Transition stage to "publish". Completion itself is ungated (C3):
    // no checks run here — commitAndPushTask below runs fresh checks and owns
    // the failing-checks prompt/override flow, so the completion step can
    // never be blocked by lint/test state.
    const taskFolderUri = vscode.Uri.file(resolvedTask.taskFolderPath);
    let transitionResult: Awaited<ReturnType<typeof advanceStage>>;
    try {
      transitionResult = await advanceStage(
        taskFolderUri,
        resolvedTask.progress.currentStage,
        "publish",
        false,
        "complete-and-move-on",
        false
      );
    } catch (error) {
      // advanceStage throws (rather than resolving falsy) when its
      // compare-and-set is rejected — e.g. a concurrent transition already
      // moved this task's stage under the lock. Report it like any other
      // failed transition instead of an unhandled rejection.
      const message = error instanceof Error ? error.message : String(error);
      NotificationRouter.showWarning(
        `Could not persist completion for ${resolvedTask.folderName}: ${message}`
      );
      return;
    }

    if (!transitionResult?.persisted) {
      void vscode.window.showErrorMessage(
        `Could not persist completion for ${resolvedTask.folderName}. Please try again.`
      );
      return;
    }

    // Completing this command is a lifecycle transition, not merely reaching
    // Publish. Persist completion before selecting another task so the one
    // active-task invariant remains true across refreshes and reloads.
    await patchTaskProgress(taskFolderUri, (current) => ({
      ...current,
      status: "completed",
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    // 2. Refresh inventory
    await inventory.refresh();

    // 3. Select next active task deterministically
    if (currentTaskStore) {
      const nextCanonicalId = selectNextTask(inventory, resolvedTask.canonicalId);
      if (nextCanonicalId) {
        await currentTaskStore.set(nextCanonicalId);
      } else {
        await currentTaskStore.clear();
      }
    }

    // 4. Run commit & push as a child of this composite's root operation —
    // still under the same exclusive lock, so no second invocation can start
    // between completion and the commit/push handoff.
    const completedTask: IncompleteTask = {
      folderUri: vscode.Uri.file(resolvedTask.taskFolderPath),
      folderName: resolvedTask.folderName,
      progress: {
        ...resolvedTask.progress,
        currentStage: "publish", // Since it was just advanced
      },
      canonicalId: resolvedTask.canonicalId,
    };
    await commitAndPushTask(inventory, { task: completedTask }, currentTaskStore, op, extensionContext);
    }
  );
}

/**
 * Register the commitAndPushTask command.
 */
export function registerCommitAndPushTaskCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore?: CurrentTaskStore
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.commitAndPushTask",
    (arg?: CommitAndPushTaskArg) =>
      commitAndPushTask(inventory, arg, currentTaskStore, undefined, context)
  );
  const completeDisposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.completeCommitAndPushTask",
    (arg?: CommitAndPushTaskArg) =>
      completeCommitAndPushTask(inventory, arg, currentTaskStore, context)
  );
  context.subscriptions.push(disposable, completeDisposable);
}
