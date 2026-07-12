import * as vscode from "vscode";
import * as nodePath from "path";
import * as nodeFs from "fs";
import { deletePath, readTextIfExists, writeTextFile } from "../utils/fileUtils";
import { AgentAvailability } from "../types/agentRunner";
import { parseCopilotModelSelection } from "./providers";
import { sanitizeRelativePath } from "../utils/pathSafety";
import { classifyFailure } from "../utils/quota";
import {
  IMPLEMENTATION_FILENAME,
  LEGACY_IMPLEMENTATION_FILENAME,
} from "../types/taskProgress";
import { looksLikeGeneratedImplementationSummary } from "../utils/implementationArtifactResolver";
import { getMaxImplementationIterations } from "../config/settings";

/**
 * Reserved artifact filenames the implementation stage writes inside a task
 * folder. The implementation prompt asks the model to "produce
 * plan-final.md" as its final summary; a model can misread that as a
 * write_file call for "./plan-final.md" at the workspace root instead of
 * returning the summary as its final text response. A write to one of these
 * names at the root is only rejected when its content actually matches the
 * generated-summary shape (see looksLikeGeneratedImplementationSummary) —
 * filename and location alone can't tell that apart from a workspace's own
 * unrelated file of the same name.
 */
const RESERVED_ROOT_ARTIFACT_NAMES: ReadonlySet<string> = new Set([
  IMPLEMENTATION_FILENAME,
  LEGACY_IMPLEMENTATION_FILENAME,
]);

/**
 * Maximum number of tool-call rounds before aborting to prevent runaway loops.
 */
/**
 * Tools exposed to the language model for reading and writing workspace files.
 */
const IMPLEMENTATION_TOOLS: vscode.LanguageModelChatTool[] = [
  {
    name: "read_file",
    description:
      "Read the full content of a file in the workspace by its workspace-relative path.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Workspace-relative file path using forward slashes, e.g. 'src/utils/foo.ts'",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Create a new file or completely overwrite an existing file. " +
      "Always provide the COMPLETE file content — partial content will truncate the file. " +
      "Parent directories are created automatically.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file path using forward slashes.",
        },
        content: {
          type: "string",
          description: "The full content of the file.",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_files",
    description:
      "List the immediate children (files and sub-directories) of a workspace-relative directory. " +
      "Directory entries are shown with a trailing '/'. Use '.' to list the workspace root.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Workspace-relative directory path using forward slashes. Use '.' for the root.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "delete_file",
    description:
      "Delete a file or directory (recursively) at a workspace-relative path. " +
      "Use this to remove obsolete files, or as the second step of a rename/move " +
      "(first write_file the new path with the old file's content, then delete_file the old path).",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file or directory path using forward slashes.",
        },
      },
      required: ["path"],
    },
  },
];

/**
 * True when candidate is basePath itself or a descendant of it, comparing
 * whole path segments (not a bare string prefix) so that a sibling like
 * "/basePath-evil" does not falsely match "/basePath". Handles basePath
 * already ending in a separator (e.g. a filesystem-root workspace).
 */
function isSameOrDescendantPath(candidate: string, basePath: string): boolean {
  if (candidate === basePath) {
    return true;
  }
  const baseWithSep = /[/\\]$/.test(basePath) ? basePath : basePath + "/";
  const baseWithSepNative = /[/\\]$/.test(basePath)
    ? basePath
    : basePath + nodePath.sep;
  return (
    candidate.startsWith(baseWithSep) || candidate.startsWith(baseWithSepNative)
  );
}

/**
 * Resolve the real, symlink-free path of the nearest existing ancestor of
 * fsPath. Used to detect a symlink/junction inside the workspace that would
 * otherwise let a syntactically-valid relative path resolve outside it.
 */
function realpathOfNearestExistingAncestor(fsPath: string): string {
  let current = fsPath;
  for (;;) {
    try {
      return nodeFs.realpathSync.native(current);
    } catch {
      const parent = nodePath.dirname(current);
      if (parent === current) {
        return current;
      }
      current = parent;
    }
  }
}

/**
 * Resolve a workspace-relative path to an absolute URI, rejecting anything
 * that would escape the workspace root (path traversal prevention).
 *
 * Returns undefined when the path is unsafe.
 */
function safeResolve(
  workspaceUri: vscode.Uri,
  relativePath: string
): vscode.Uri | undefined {
  const normalized = sanitizeRelativePath(relativePath);
  if (normalized === undefined) {
    return undefined;
  }

  const resolved =
    normalized === ""
      ? workspaceUri
      : vscode.Uri.joinPath(workspaceUri, normalized);

  // Defence-in-depth: verify the resolved absolute path is still inside the
  // workspace (catches encoded traversal that slipped past the string check).
  // Only strip a trailing separator when the workspace path isn't itself a
  // filesystem root ("/" on POSIX, "C:\" on Windows) — stripping the
  // separator from a drive root turns it into a drive-RELATIVE path (e.g.
  // "C:"), which Node resolves against that drive's current directory
  // instead of the drive's root.
  const wsFsRaw = workspaceUri.fsPath;
  const wsFs =
    nodePath.parse(wsFsRaw).root === wsFsRaw
      ? wsFsRaw
      : wsFsRaw.replace(/[/\\]+$/, "");
  const resolvedFs = resolved.fsPath;
  if (!isSameOrDescendantPath(resolvedFs, wsFs)) {
    return undefined;
  }

  // Defence-in-depth: a symlink or junction inside the workspace (e.g.
  // "linked-dir" pointing outside it) would pass the string-prefix check
  // above while workspace.fs still follows the link on disk. Resolve the
  // real path of the nearest existing ancestor and re-check the boundary.
  const wsRealFs = nodeFs.realpathSync.native(wsFs);
  const resolvedRealFs = realpathOfNearestExistingAncestor(resolvedFs);
  if (!isSameOrDescendantPath(resolvedRealFs, wsRealFs)) {
    return undefined;
  }

  return resolved;
}

/**
 * Execute a single tool call from the language model and return the result
 * as a string. All file-system operations are sandboxed to workspaceUri.
 * filesChanged is mutated to track paths written by the model.
 */
async function executeToolCall(
  call: vscode.LanguageModelToolCallPart,
  workspaceUri: vscode.Uri,
  filesChanged: Set<string>
): Promise<string> {
  const input = call.input as Record<string, unknown>;

  switch (call.name) {
    case "read_file": {
      const relPath = String(input["path"] ?? "");
      const fileUri = safeResolve(workspaceUri, relPath);
      if (!fileUri) {
        return `Error: Path "${relPath}" is invalid or outside the workspace.`;
      }
      const content = await readTextIfExists(fileUri);
      if (content === undefined) {
        return `Error: File not found: "${relPath}"`;
      }
      return content;
    }

    case "write_file": {
      const relPath = String(input["path"] ?? "");
      const content = String(input["content"] ?? "");
      const fileUri = safeResolve(workspaceUri, relPath);
      if (!fileUri) {
        return `Error: Path "${relPath}" is invalid or outside the workspace.`;
      }
      try {
        // safeResolve already validated the path; reuse the sanitised form
        // so parent-directory creation uses the same normalised path.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const normalizedPath = sanitizeRelativePath(relPath)!;
        if (
          RESERVED_ROOT_ARTIFACT_NAMES.has(normalizedPath) &&
          looksLikeGeneratedImplementationSummary(content)
        ) {
          return (
            `Error: Do not write the implementation summary to "${normalizedPath}" ` +
            "at the workspace root — return it as your final text response instead."
          );
        }
        const slashIdx = normalizedPath.lastIndexOf("/");
        if (slashIdx > 0) {
          const parentPath = normalizedPath.substring(0, slashIdx);
          const parentUri = vscode.Uri.joinPath(workspaceUri, parentPath);
          await vscode.workspace.fs.createDirectory(parentUri);
        }
        await writeTextFile(fileUri, content);
        filesChanged.add(normalizedPath || relPath);
        return `OK: wrote "${relPath}" (${content.length} chars)`;
      } catch (e) {
        return `Error writing "${relPath}": ${
          e instanceof Error ? e.message : String(e)
        }`;
      }
    }

    case "list_files": {
      const relPath = String(input["path"] ?? ".");
      const dirUri = safeResolve(workspaceUri, relPath);
      if (!dirUri) {
        return `Error: Path "${relPath}" is invalid or outside the workspace.`;
      }
      try {
        const entries = await vscode.workspace.fs.readDirectory(dirUri);
        if (entries.length === 0) {
          return "(empty directory)";
        }
        return entries
          .map(([name, type]) =>
            type === vscode.FileType.Directory ? `${name}/` : name
          )
          .join("\n");
      } catch {
        return `Error: Directory not found: "${relPath}"`;
      }
    }

    case "delete_file": {
      const relPath = String(input["path"] ?? "");
      const targetUri = safeResolve(workspaceUri, relPath);
      if (!targetUri) {
        return `Error: Path "${relPath}" is invalid or outside the workspace.`;
      }
      const normalizedPath = sanitizeRelativePath(relPath);
      if (!normalizedPath) {
        return `Error: Refusing to delete the workspace root.`;
      }
      try {
        await deletePath(targetUri);
        filesChanged.add(normalizedPath);
        return `OK: deleted "${relPath}"`;
      } catch (e) {
        return `Error deleting "${relPath}": ${
          e instanceof Error ? e.message : String(e)
        }`;
      }
    }

    default:
      return `Error: Unknown tool "${call.name}"`;
  }
}

interface ImplementationRoundResult {
  /** Total tool-call rounds consumed so far (across all "Continue" resumes). */
  iteration: number;
  completedCleanly: boolean;
  cancelled: boolean;
  finalSummary: string;
  /** Set when the round loop must stop with a hard failure. */
  failure?: ImplementationRunResult;
}

/**
 * Run tool-call rounds against an already-initialized conversation, starting
 * at `startIteration` and stopping once `maxIterations` is reached. Mutates
 * `messages` and `filesChanged` in place so a caller can invoke this again
 * with a higher `maxIterations` (the "Continue working?" path) and resume the
 * exact same conversation instead of starting over from the original prompt.
 */
async function runImplementationRounds(
  model: vscode.LanguageModelChat,
  messages: vscode.LanguageModelChatMessage[],
  requestOptions: vscode.LanguageModelChatRequestOptions,
  workspaceUri: vscode.Uri,
  filesChanged: Set<string>,
  token: vscode.CancellationToken,
  onProgress: (message: string) => void,
  startIteration: number,
  maxIterations: number
): Promise<ImplementationRoundResult> {
  let iteration = startIteration;

  while (iteration < maxIterations) {
    if (token.isCancellationRequested) {
      return { iteration, completedCleanly: false, cancelled: true, finalSummary: "" };
    }

    iteration++;
    onProgress(`Waiting for Copilot (round ${iteration})...`);

    let response: vscode.LanguageModelChatResponse;
    try {
      response = await model.sendRequest(
        messages,
        { ...requestOptions, tools: IMPLEMENTATION_TOOLS },
        token
      );
    } catch (e) {
      if (token.isCancellationRequested) {
        return { iteration, completedCleanly: false, cancelled: true, finalSummary: "" };
      }
      return {
        iteration,
        completedCleanly: false,
        cancelled: false,
        finalSummary: "",
        failure: classifyFailure<ImplementationRunResult>({
          status: "failed",
          filesChanged: [...filesChanged],
          errorMessage: `Model request failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        }),
      };
    }

    // Collect all response parts
    const textParts: string[] = [];
    const toolCalls: vscode.LanguageModelToolCallPart[] = [];

    try {
      for await (const part of response.stream) {
        if (token.isCancellationRequested) {
          return { iteration, completedCleanly: false, cancelled: true, finalSummary: "" };
        }
        if (part instanceof vscode.LanguageModelTextPart) {
          textParts.push(part.value);
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push(part);
        }
      }
    } catch (e) {
      if (token.isCancellationRequested) {
        return { iteration, completedCleanly: false, cancelled: true, finalSummary: "" };
      }
      return {
        iteration,
        completedCleanly: false,
        cancelled: false,
        finalSummary: "",
        failure: classifyFailure<ImplementationRunResult>({
          status: "failed",
          filesChanged: [...filesChanged],
          errorMessage: `Stream error: ${
            e instanceof Error ? e.message : String(e)
          }`,
        }),
      };
    }

    const assistantText = textParts.join("");

    // Record the assistant turn (text + tool calls)
    const assistantContent: (
      | vscode.LanguageModelTextPart
      | vscode.LanguageModelToolCallPart
    )[] = [];
    if (assistantText) {
      assistantContent.push(new vscode.LanguageModelTextPart(assistantText));
    }
    assistantContent.push(...toolCalls);
    if (assistantContent.length > 0) {
      messages.push(vscode.LanguageModelChatMessage.Assistant(assistantContent));
    }

    if (toolCalls.length === 0) {
      // Model is done — final text is the implementation summary
      return { iteration, completedCleanly: true, cancelled: false, finalSummary: assistantText };
    }

    // Execute each tool call and collect results
    const toolResults: vscode.LanguageModelToolResultPart[] = [];
    for (const call of toolCalls) {
      if (token.isCancellationRequested) {
        return { iteration, completedCleanly: false, cancelled: true, finalSummary: "" };
      }
      onProgress(`Tool: ${call.name}("${String((call.input as Record<string, unknown>)["path"] ?? "")}")`);
      const result = await executeToolCall(call, workspaceUri, filesChanged);
      toolResults.push(
        new vscode.LanguageModelToolResultPart(call.callId, [
          new vscode.LanguageModelTextPart(result),
        ])
      );
    }

    // Send tool results back as a User message
    messages.push(vscode.LanguageModelChatMessage.User(toolResults));
  }

  return { iteration, completedCleanly: false, cancelled: false, finalSummary: "" };
}

export interface ImplementationRunResult {
  status: "completed" | "failed" | "cancelled";
  /** Workspace-relative paths written by the model */
  filesChanged: string[];
  /**
   * True when filesChanged could not be reliably determined (e.g. a CLI
   * provider ran outside a git repository, so there was no way to diff
   * changes). Callers must treat this the same as "manual implementation"
   * and fall back to open-editor review scope instead of trusting an
   * empty filesChanged as "nothing changed".
   */
  filesChangedUnknown?: boolean;
  /** Markdown summary text returned for logs/user feedback after a completed run */
  summary?: string;
  errorMessage?: string;
  /** Stable provider-neutral failure classification; set on failed results only. */
  failureKind?: "quota" | "generic";
}

/**
 * Run the implementation loop: send the prompt to the language model,
 * execute tool calls (file reads/writes) until the model stops calling
 * tools, then return the final text output as the implementation summary.
 */
export async function runImplementationWithCopilot(options: {
  prompt: string;
  modelId?: string;
  workspaceUri: vscode.Uri;
  token: vscode.CancellationToken;
  onProgress: (message: string) => void;
}): Promise<ImplementationRunResult> {
  const { prompt, modelId, workspaceUri, token, onProgress } = options;

  const filesChanged = new Set<string>();

  // Select model
  let models: vscode.LanguageModelChat[];
  try {
    models = await vscode.lm.selectChatModels({ vendor: "copilot" });
  } catch (e) {
    return classifyFailure<ImplementationRunResult>({
      status: "failed",
      filesChanged: [],
      errorMessage: `Failed to select a Copilot model: ${
        e instanceof Error ? e.message : String(e)
      }`,
    });
  }
  if (models.length === 0) {
    return classifyFailure<ImplementationRunResult>({
      status: "failed",
      filesChanged: [],
      errorMessage:
        "No Copilot language models are available. Sign in to GitHub Copilot in VS Code.",
    });
  }

  const parsedModel = parseCopilotModelSelection(modelId);
  let model: vscode.LanguageModelChat | undefined;

  if (parsedModel.model) {
    // A specific model was requested — use it or fail explicitly.
    // Silently falling back to `auto` when the configured model is
    // unavailable contradicts the "no implicit/default coding agent"
    // requirement: the user must always know which model is being used.
    model = models.find((m) => m.id === parsedModel.model);
    if (!model) {
      return classifyFailure<ImplementationRunResult>({
        status: "failed",
        filesChanged: [],
        errorMessage:
          `The configured Copilot model "${parsedModel.model}" is not available. ` +
          "Select an available model in Settings, or sign in to GitHub Copilot.",
      });
    }
  } else {
    // No specific model configured — use the auto model as the default.
    model = models.find(
      (m) => m.id.toLowerCase() === "auto" || m.name.toLowerCase() === "auto"
    );
    if (!model) {
      return classifyFailure<ImplementationRunResult>({
        status: "failed",
        filesChanged: [],
        errorMessage: "The configured Copilot model is unavailable. Select an available model in Settings.",
      });
    }
  }

  onProgress(`Using model: ${model.name}`);

  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(prompt),
  ];
  const modelOptions: Record<string, unknown> = {};
  if (parsedModel.reasoningEffort) {
    modelOptions.model_reasoning_effort = parsedModel.reasoningEffort;
  }
  if (parsedModel.contextWindow) {
    modelOptions.model_context_window = parsedModel.contextWindow;
  }
  const requestOptions: vscode.LanguageModelChatRequestOptions =
    Object.keys(modelOptions).length > 0 ? { modelOptions } : {};

  let iteration = 0;
  let maxIterations = getMaxImplementationIterations();

  // Loops across "Continue working?" resumes. `messages` and `filesChanged`
  // are shared across iterations of this loop (runImplementationRounds
  // mutates them in place), so resuming after the round limit continues the
  // same conversation and tool-call history instead of restarting the
  // implementation from the original prompt.
  for (;;) {
    const round = await runImplementationRounds(
      model,
      messages,
      requestOptions,
      workspaceUri,
      filesChanged,
      token,
      onProgress,
      iteration,
      maxIterations
    );
    iteration = round.iteration;

    if (round.cancelled) {
      return { status: "cancelled", filesChanged: [...filesChanged] };
    }
    if (round.failure) {
      return round.failure;
    }
    if (round.completedCleanly) {
      return {
        status: "completed",
        filesChanged: [...filesChanged],
        summary: round.finalSummary || undefined,
      };
    }

    // Hit the round limit without finishing.
    if (maxIterations >= 200) {
      return classifyFailure<ImplementationRunResult>({
        status: "failed",
        filesChanged: [...filesChanged],
        errorMessage: `Reached the configured maximum of ${maxIterations} tool-call rounds without finishing. The implementation may be incomplete.`,
      });
    }
    const choice = await vscode.window.showWarningMessage(
      `The implementation reached its ${maxIterations}-round limit. Continue working?`,
      "Continue", "Cancel"
    );
    if (choice !== "Continue") {
      return classifyFailure<ImplementationRunResult>({
        status: "failed",
        filesChanged: [...filesChanged],
        errorMessage: `Reached the configured maximum of ${maxIterations} tool-call rounds without finishing. The implementation may be incomplete.`,
      });
    }
    maxIterations = Math.min(200, maxIterations + getMaxImplementationIterations());
  }
}

/**
 * Check whether Copilot LM is available for implementation runs.
 */
export async function checkImplementationAvailability(): Promise<AgentAvailability> {
  try {
    const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
    if (models.length === 0) {
      return {
        available: false,
        reason:
          "No Copilot language models are available. Sign in to GitHub Copilot in VS Code.",
      };
    }
    return { available: true };
  } catch (e) {
    return {
      available: false,
      reason: `Copilot language models are unavailable: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
}
