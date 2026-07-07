import * as vscode from "vscode";
import * as path from "path";
import { spawn } from "child_process";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { TASK_FILENAME } from "../types/taskProgress";
import { resolveImplementationArtifact } from "../utils/implementationArtifactResolver";
import { getLowLevelPlanUri } from "../utils/lowLevelPlanArtifactResolver";

/**
 * Run a git command with safe argument passing
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

    gitProcess.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    gitProcess.stderr?.on("data", (data) => {
      stderr += data.toString();
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
 * Resolve the git repository root for a given path
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
 * Check if there are any changes to commit
 */
async function hasChangesToCommit(repoRoot: string): Promise<boolean> {
  try {
    const { stdout } = await runGitCommand(repoRoot, "status", [
      "--porcelain",
    ]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Get the list of changed files before pr-description.md is created.
 * Handles porcelain -z format correctly, including renames and copies.
 */
async function getChangedFiles(repoRoot: string): Promise<string[]> {
  try {
    const { stdout } = await runGitCommand(repoRoot, "status", [
      "--porcelain",
      "-z",
      "--untracked-files=all",
    ]);

    const files: string[] = [];
    const entries = stdout.split("\0").filter((s) => s.length > 0);

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const statusCode = entry.substring(0, 2);
      const filePath = entry.substring(3);

      // Renamed/copied files have two path tokens in -z format
      // Check both status columns for R or C
      if (statusCode[0] === "R" || statusCode[0] === "C" || statusCode[1] === "R" || statusCode[1] === "C") {
        // Current entry is "XY oldpath", next entry is "newpath"
        files.push(filePath);
        if (i + 1 < entries.length) {
          const newPath = entries[i + 1]!;
          files.push(newPath);
          i++; // Skip the next entry since we just consumed it
        }
      } else {
        files.push(filePath);
      }
    }

    return files.filter((f) => f.length > 0);
  } catch {
    return [];
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
  if (headerIndex === -1) return undefined;

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
 * Save all relevant dirty documents before git operations
 */
async function saveDirtyDocuments(
  taskFolderPath: string,
  repoRoot: string
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
    if (!doc.isDirty) return false;
    if (relevantPaths.has(doc.uri.fsPath)) return true;
    // Also include any dirty file inside the repo
    if (doc.uri.fsPath.startsWith(repoRoot)) return true;
    return false;
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
 * Commit and push the current task
 */
export async function commitAndPushTask(
  inventory: TaskInventory,
  explicitArg?: { canonicalId?: string; taskFolderPath?: string }
): Promise<void> {
  const resolvedTask = await resolveTaskContext(inventory, explicitArg, {
    allowPaused: false,
  });

  if (!resolvedTask) {
    void vscode.window.showInformationMessage(
      "No completed tasks to commit and push."
    );
    return;
  }

  if (resolvedTask.progress.currentStage !== "completed") {
    void vscode.window.showInformationMessage(
      "Task must be completed before committing and pushing."
    );
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Committing and pushing ${resolvedTask.folderName}...`,
      cancellable: false,
    },
    async (progress) => {
      try {
        // Resolve repository
        progress.report({ message: "Resolving git repository..." });
        const repoRoot = await resolveGitRepo(resolvedTask.taskFolderPath);
        if (!repoRoot) {
          throw new Error(
            "Could not find git repository. Make sure the task is inside a git repository."
          );
        }

        // Check for changes
        progress.report({ message: "Checking for changes..." });
        const hasChanges = await hasChangesToCommit(repoRoot);
        if (!hasChanges) {
          throw new Error("No changes to commit.");
        }

        // Check for existing staged changes
        const { stdout: stagedOutput } = await runGitCommand(
          repoRoot,
          "diff",
          ["--cached", "--name-only"]
        );
        if (stagedOutput.trim().length > 0) {
          throw new Error(
            "There are already staged changes. Please commit or unstage them first."
          );
        }

        // Save dirty documents
        progress.report({ message: "Saving open files..." });
        const saved = await saveDirtyDocuments(
          resolvedTask.taskFolderPath,
          repoRoot
        );
        if (!saved) {
          return;
        }

        // Get changed files before creating pr-description.md
        progress.report({ message: "Collecting changed files..." });
        const changedFiles = await getChangedFiles(repoRoot);

        // Generate PR description
        progress.report({ message: "Generating PR description..." });
        const prDescription = await generatePRDescription(
          resolvedTask.taskFolderPath,
          resolvedTask.folderName,
          changedFiles
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

        let commitCreated = false;
        let newCommitHash: string | undefined;

        try {
          // Stage all changes
          progress.report({ message: "Staging changes..." });
          await runGitCommand(repoRoot, "add", ["-A", "--", "."]);

          // Commit
          progress.report({ message: "Creating commit..." });
          const commitMessage = `AI Helper: ${resolvedTask.folderName}`;
          await runGitCommand(repoRoot, "commit", ["-m", commitMessage]);
          commitCreated = true;

          // Get the commit hash
          const { stdout: hashOutput } = await runGitCommand(
            repoRoot,
            "rev-parse",
            ["HEAD"]
          );
          newCommitHash = hashOutput.trim();

          // Check for upstream
          progress.report({ message: "Checking remote configuration..." });
          let hasUpstream = false;
          try {
            await runGitCommand(repoRoot, "rev-parse", [
              "--abbrev-ref",
              "@{upstream}",
            ]);
            hasUpstream = true;
          } catch {
            // No upstream
          }

          // Get current branch
          const { stdout: branchOutput } = await runGitCommand(
            repoRoot,
            "rev-parse",
            ["--abbrev-ref", "HEAD"]
          );
          const currentBranch = branchOutput.trim();

          if (!hasUpstream) {
            // First push - check for single remote
            const { stdout: remotesOutput } = await runGitCommand(
              repoRoot,
              "remote",
              []
            );
            const remotes = remotesOutput
              .trim()
              .split("\n")
              .filter((r) => r.length > 0);
            if (remotes.length === 0) {
              throw new Error(
                "No git remotes configured. Add a remote before pushing."
              );
            }
            if (remotes.length > 1) {
              throw new Error(
                `Multiple remotes found (${remotes.join(", ")}). Please set up tracking manually with: git push -u <remote> ${currentBranch}`
              );
            }
            progress.report({ message: "Pushing to remote (first push)..." });
            await runGitCommand(repoRoot, "push", [
              "-u",
              remotes[0]!,
              currentBranch,
            ]);
          } else {
            // Normal push
            progress.report({ message: "Pushing to remote..." });
            await runGitCommand(repoRoot, "push", []);
          }

          void vscode.window.showInformationMessage(
            `Successfully committed and pushed ${resolvedTask.folderName}`
          );
        } catch (error: any) {
          if (commitCreated && newCommitHash) {
            // Rollback if commit was created but push failed
            try {
              const { stdout: currentHash } = await runGitCommand(
                repoRoot,
                "rev-parse",
                ["HEAD"]
              );
              if (currentHash.trim() === newCommitHash) {
                await runGitCommand(repoRoot, "reset", ["--mixed", "HEAD~1"]);
                void vscode.window.showErrorMessage(
                  `Push failed, commit rolled back: ${error.message}`
                );
              } else {
                void vscode.window.showErrorMessage(
                  `Push failed. Local commit remains (HEAD changed since commit): ${error.message}`
                );
              }
            } catch (rollbackError: any) {
              void vscode.window.showErrorMessage(
                `Push failed and rollback failed. Local commit remains: ${error.message}. Rollback error: ${rollbackError.message}`
              );
            }
          } else {
            // Pre-commit failure - cleanup staged changes
            try {
              await runGitCommand(repoRoot, "reset", ["--mixed", "HEAD"]);
            } catch {
              // ignore cleanup failure
            }
            throw error;
          }
        }
      } catch (error: any) {
        void vscode.window.showErrorMessage(
          `Commit and push failed: ${error.message}`
        );
      }
    }
  );
}

/**
 * Register the commitAndPushTask command.
 */
export function registerCommitAndPushTaskCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.commitAndPushTask",
    (arg?: { canonicalId?: string; taskFolderPath?: string }) =>
      commitAndPushTask(inventory, arg)
  );
  context.subscriptions.push(disposable);
}
