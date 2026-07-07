import * as vscode from "vscode";
import * as nodePath from "path";
import * as nodeFs from "fs";
import { CONTEXT_PACK_FILENAME, TASK_FILENAME } from "../types/taskProgress";
import {
  applyContentCaps,
  IMPL_REVIEW_MAX_CHARS_PER_FILE,
  IMPL_REVIEW_MAX_TOTAL_CHARS,
} from "./implReviewFileSelection";
import { sanitizeRelativePath } from "./pathSafety";
import {
  CONTEXT_PER_FILE_MAX_BYTES,
  CONTEXT_MAX_FILES,
  CONTEXT_TOTAL_MAX_BYTES,
  isDenylisted,
} from "./contextEligibility";

/**
 * Resolve the real, symlink-free path of the nearest existing ancestor of
 * fsPath. Used to detect symlinks/junctions inside the workspace that resolve
 * outside it. Mirrors the same helper in copilotImplementationRunner.ts.
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
 * Read a text file, returning undefined if it does not exist or is empty.
 */
async function readTextFileIfExists(
  fileUri: vscode.Uri
): Promise<string | undefined> {
  try {
    const content = await vscode.workspace.fs.readFile(fileUri);
    const text = new TextDecoder().decode(content).trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True if fileUri is located inside workspaceUri (lexical check).
 * Used as the first guard; realpath containment follows for existing files.
 */
function isInsideWorkspace(
  fileUri: vscode.Uri,
  workspaceUri: vscode.Uri
): boolean {
  const workspacePath = workspaceUri.fsPath.replace(/[/\\]+$/, "");
  const filePath = fileUri.fsPath;
  return (
    filePath === workspacePath ||
    filePath.startsWith(workspacePath + "/") ||
    filePath.startsWith(workspacePath + "\\")
  );
}

/**
 * Return the basename of a path string (last component).
 */
function basename(fsPath: string): string {
  return nodePath.basename(fsPath);
}

/**
 * True when the document should be excluded from provider-bound context packs.
 *
 * Excluded when:
 *  - scheme is not "file"
 *  - out-of-workspace (lexical check; realpath check follows for existing files)
 *  - basename or resolved-target basename matches the secret denylist
 *  - realpath resolves outside the workspace (symlink escape)
 *  - realpath resolution fails for a reason other than "file doesn't exist yet"
 *  - lstatSync fails for any reason other than ENOENT (e.g. EPERM) — fail closed
 *
 * Included when:
 *  - file scheme, lexically inside workspace, basename not denylisted
 *  - AND (file exists on disk with realpath inside workspace,
 *         OR file doesn't exist on disk yet — new unsaved buffer, ENOENT only)
 *
 * NOTE: untitled: documents are ALWAYS excluded (scheme !== "file").
 *
 * IMPORTANT: The "new unsaved file" branch is reached ONLY when lstatSync
 * throws with ENOENT. Any other lstatSync error (EPERM, EACCES, etc.) causes
 * the file to be excluded — fail closed. An existing symlink is NOT treated
 * as a new unsaved file — it goes through the realpath containment check so
 * the resolved-target basename denylist is always applied to existing files
 * including symlinked ones.
 */
function isEligibleDocument(
  doc: vscode.TextDocument,
  workspaceUri: vscode.Uri,
  wsRealFs: string
): boolean {
  if (doc.uri.scheme !== "file") {
    return false;
  }

  if (!isInsideWorkspace(doc.uri, workspaceUri)) {
    return false;
  }

  // Denylist check on the literal basename
  if (isDenylisted(basename(doc.uri.fsPath))) {
    return false;
  }

  // Determine whether the file exists on disk right now.
  // We use lstatSync (not statSync) so that a symlink is detected as
  // "existing" even if its target doesn't exist, which is the right
  // check: if lstat succeeds, the path is a real filesystem entry and
  // must be treated as "existing" for realpath purposes.
  //
  // IMPORTANT: Only treat ENOENT as "file doesn't exist yet" (new unsaved
  // buffer). Any other lstatSync error (EPERM, EACCES, etc.) means we
  // cannot determine the file's status — fail closed and exclude.
  let fileExistsOnDisk: boolean;
  try {
    nodeFs.lstatSync(doc.uri.fsPath);
    fileExistsOnDisk = true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // File genuinely does not exist on disk yet (new unsaved buffer).
      fileExistsOnDisk = false;
    } else {
      // Permission error, I/O error, or other unexpected condition.
      // Fail closed — we cannot safely determine the file's nature.
      return false;
    }
  }

  if (!fileExistsOnDisk) {
    // New unsaved file-backed document (doesn't exist on disk yet).
    // Lexical containment already passed above; use the nearest existing
    // ancestor realpath to verify the containing directory isn't a
    // symlink/junction that escapes the workspace.
    const realAncestor = realpathOfNearestExistingAncestor(doc.uri.fsPath);
    const realAncestorInWorkspace =
      realAncestor === wsRealFs ||
      realAncestor.startsWith(wsRealFs + "/") ||
      realAncestor.startsWith(wsRealFs + nodePath.sep);
    return realAncestorInWorkspace;
  }

  // File exists on disk — resolve its realpath and check it is inside the
  // workspace. This branch handles normal files AND symlinks correctly:
  // realpathSync.native follows the symlink chain to the final target,
  // so a symlink whose target is outside the workspace is excluded here.
  try {
    const realFilePath = nodeFs.realpathSync.native(doc.uri.fsPath);
    // Denylist check on the resolved target basename too (catches symlinks
    // where the link name is innocuous but the target name is secret-like,
    // e.g. a symlink "notes.txt" → ".env").
    if (isDenylisted(nodePath.basename(realFilePath))) {
      return false;
    }
    const realInWorkspace =
      realFilePath === wsRealFs ||
      realFilePath.startsWith(wsRealFs + "/") ||
      realFilePath.startsWith(wsRealFs + nodePath.sep);
    return realInWorkspace;
  } catch {
    // realpath failed for a reason other than ENOENT (e.g. EPERM, broken
    // symlink target). Fail closed — exclude.
    return false;
  }
}

/**
 * Generate context-pack.md for a task folder: the user request from
 * task.md, the workspace root, and the list of currently open editors
 * that belong to this workspace. This is an explicit, reviewable
 * selection of context, not a full repository dump.
 *
 * Eligibility rules (see isEligibleDocument):
 *  - file: scheme only (no untitled:, virtual, notebook, diff)
 *  - lexically and via realpath inside the workspace
 *  - basename not in the secret-filename denylist
 *  - symlink escapes are caught via realpath containment
 *  - lstatSync errors other than ENOENT cause the file to be excluded (fail closed)
 *
 * When `includeFileContents` is true (used by implementation reviews, which
 * must assess actual code), each open editor's content is embedded in a
 * fenced block, capped per file and in total.
 */
export async function generateContextPack(
  taskFolderUri: vscode.Uri,
  workspaceUri: vscode.Uri,
  includeFileContents = false
): Promise<string> {
  const taskFileUri = vscode.Uri.joinPath(taskFolderUri, TASK_FILENAME);
  const taskContent = await readTextFileIfExists(taskFileUri);

  // Resolve workspace realpath once for eligibility checks.
  const wsFsRaw = workspaceUri.fsPath.replace(/[/\\]+$/, "");
  let wsRealFs: string;
  try {
    wsRealFs = nodeFs.realpathSync.native(wsFsRaw);
  } catch {
    // If workspace realpath fails, fall back to the lexical path.
    wsRealFs = wsFsRaw;
  }

  // Build the eligible, deduplicated document list.
  // Retention order: active editor first, then visible editors, then tabs.
  const allDocs = vscode.workspace.textDocuments;

  const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
  const visibleUriSet = new Set(
    vscode.window.visibleTextEditors.map((e) => e.document.uri.toString())
  );

  // Build the tab-order URI list for the third retention tier.
  // window.tabGroups gives the actual tab order the user sees.
  const tabOrderUris: string[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (
        input !== null &&
        typeof input === "object" &&
        "uri" in input &&
        input.uri instanceof vscode.Uri
      ) {
        tabOrderUris.push(input.uri.toString());
      }
    }
  }

  // Assign a sort key to each document:
  //   0 = active editor
  //   1 = visible (but not active)
  //   2 = tab (but not visible/active), in tab order
  //   3 = other (ambient document not in any visible/tab set)
  const tabOrderIndex = new Map<string, number>(
    tabOrderUris.map((uri, i) => [uri, i])
  );

  const sorted = [...allDocs].sort((a, b) => {
    const aUri = a.uri.toString();
    const bUri = b.uri.toString();

    const tier = (uri: string): number => {
      if (uri === activeUri) { return 0; }
      if (visibleUriSet.has(uri)) { return 1; }
      if (tabOrderIndex.has(uri)) { return 2; }
      return 3;
    };

    const aTier = tier(aUri);
    const bTier = tier(bUri);
    if (aTier !== bTier) { return aTier - bTier; }

    // Within the tab tier, preserve the tab group/tab order.
    if (aTier === 2) {
      return (tabOrderIndex.get(aUri) ?? 0) - (tabOrderIndex.get(bUri) ?? 0);
    }
    return 0;
  });

  const seenUris = new Set<string>();
  const orderedDocs: vscode.TextDocument[] = [];

  let excludedCount = 0;
  for (const doc of sorted) {
    const uriKey = doc.uri.toString();
    if (seenUris.has(uriKey)) {
      continue;
    }
    seenUris.add(uriKey);

    if (!isEligibleDocument(doc, workspaceUri, wsRealFs)) {
      excludedCount++;
      continue;
    }

    if (orderedDocs.length >= CONTEXT_MAX_FILES) {
      excludedCount++;
      continue;
    }

    orderedDocs.push(doc);
  }

  const lines: string[] = [];
  lines.push("# Context Pack");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Workspace Root");
  lines.push("");
  lines.push(vscode.workspace.asRelativePath(workspaceUri, false) || ".");
  lines.push("");
  lines.push("## User Request");
  lines.push("");
  lines.push(taskContent ?? "_No task.md content found._");
  lines.push("");
  lines.push("## Open Editors");
  lines.push("");
  if (orderedDocs.length > 0) {
    for (const doc of orderedDocs) {
      lines.push(`- ${vscode.workspace.asRelativePath(doc.uri, false)}`);
    }
  } else {
    lines.push("_No eligible open editors._");
  }
  if (excludedCount > 0) {
    lines.push(`_${excludedCount} editor(s) excluded for safety (out-of-workspace, denylist, or symlink escape)._`);
  }
  lines.push("");

  if (includeFileContents && orderedDocs.length > 0) {
    lines.push("## Open Editor Contents");
    lines.push("");
    let totalBytes = 0;
    for (const doc of orderedDocs) {
      if (totalBytes >= CONTEXT_TOTAL_MAX_BYTES) {
        lines.push(
          "_Further open files omitted: total content size limit reached._"
        );
        lines.push("");
        break;
      }
      const relPath = vscode.workspace.asRelativePath(doc.uri, false);
      let text = doc.getText();
      let truncated = false;

      // Per-file byte cap
      const textBytes = Buffer.byteLength(text, "utf8");
      if (textBytes > CONTEXT_PER_FILE_MAX_BYTES) {
        // Truncate by character count approximation (bytes ≈ chars for ASCII)
        const ratio = CONTEXT_PER_FILE_MAX_BYTES / textBytes;
        text = text.slice(0, Math.floor(text.length * ratio));
        truncated = true;
      }

      // Total byte cap
      const currentBytes = Buffer.byteLength(text, "utf8");
      if (totalBytes + currentBytes > CONTEXT_TOTAL_MAX_BYTES) {
        const remaining = CONTEXT_TOTAL_MAX_BYTES - totalBytes;
        const ratio = remaining / currentBytes;
        text = text.slice(0, Math.floor(text.length * ratio));
        truncated = true;
      }
      totalBytes += Buffer.byteLength(text, "utf8");

      const truncMarker = truncated ? ` [truncated at ${Math.round(CONTEXT_PER_FILE_MAX_BYTES / 1024)} KB]` : "";
      lines.push(`### ${relPath}${truncMarker}`);
      lines.push("");
      lines.push("```");
      lines.push(text);
      lines.push("```");
      lines.push("");
    }
  }

  lines.push("## Constraints");
  lines.push("");
  lines.push("- Do not refactor unrelated files.");
  lines.push("- Keep changes scoped to the request above.");
  lines.push("");

  return lines.join("\n");
}

/**
 * Write pre-generated context-pack content to disk and return its URI.
 *
 * Callers that have already called `generateContextPack` should use this
 * function to persist the exact same bytes that were assembled in memory —
 * avoiding a second generation pass that could produce a different result
 * if open buffers change between the two calls.
 */
export async function writeContextPackContent(
  taskFolderUri: vscode.Uri,
  content: string
): Promise<vscode.Uri> {
  const contextPackUri = vscode.Uri.joinPath(
    taskFolderUri,
    CONTEXT_PACK_FILENAME
  );
  await vscode.workspace.fs.writeFile(
    contextPackUri,
    new TextEncoder().encode(content)
  );
  return contextPackUri;
}

/**
 * Write context-pack.md to the task folder and return its URI.
 *
 * NOTE: Prefer `writeContextPackContent` when you have already called
 * `generateContextPack` — that avoids a redundant second generation which
 * could differ if open buffers change between calls.
 */
export async function writeContextPack(
  taskFolderUri: vscode.Uri,
  workspaceUri: vscode.Uri,
  includeFileContents = false
): Promise<vscode.Uri> {
  const content = await generateContextPack(
    taskFolderUri,
    workspaceUri,
    includeFileContents
  );
  return writeContextPackContent(taskFolderUri, content);
}

// ---------------------------------------------------------------------------
// Implementation-review context pack
// ---------------------------------------------------------------------------

/**
 * Get the content of a workspace file, preferring an open editor buffer over
 * the on-disk copy so that unsaved changes are captured.
 * Returns undefined when the file is neither open in an editor nor on disk.
 */
async function getFileContentForReview(
  fileUri: vscode.Uri
): Promise<string | undefined> {
  const openDoc = vscode.workspace.textDocuments.find(
    (doc) => doc.uri.toString() === fileUri.toString()
  );
  if (openDoc) {
    return openDoc.getText();
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(fileUri);
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Build the body of context-pack.md for an implementation review.
 *
 * **Tracked / no-change mode** (when `implReviewFiles` is an array, even
 * empty): the review is scoped to the files recorded by the AI
 * implementation run, which may be zero. If a tracked file is open in
 * the editor, the unsaved buffer is used in place of the on-disk copy.
 * `isFallback` is `false` in this mode.
 *
 * A zero-length tracked list is expected to be rare in practice: callers
 * accumulate `implReviewFiles` across a task's implementation runs (see
 * `updateImplReviewFiles` in taskProgressUtils.ts) rather than overwriting it
 * per run, so an empty list here means the task genuinely has no AI-authored
 * changes recorded yet, not that a later no-op run clobbered an earlier
 * run's files.
 *
 * **Fallback mode** (when `implReviewFiles` is `undefined`): the task was
 * implemented manually, or was created before file tracking was
 * introduced. All open editors that belong to this workspace are used
 * instead, and the pack contains an explicit warning. `isFallback` is
 * `true` in this mode.
 *
 * Every tracked path is validated against the workspace boundary before
 * any file is read; paths that fail validation are listed in the pack as
 * rejected rather than silently skipped.
 *
 * In both modes the per-file and total size caps are applied and any
 * truncation, omission, or missing-on-disk condition is noted in the pack.
 */
export async function generateImplReviewContextPack(
  taskFolderUri: vscode.Uri,
  workspaceUri: vscode.Uri,
  implReviewFiles: string[] | undefined
): Promise<{ content: string; isFallback: boolean }> {
  const taskFileUri = vscode.Uri.joinPath(taskFolderUri, TASK_FILENAME);
  const taskContent = await readTextFileIfExists(taskFileUri);

  const lines: string[] = [];
  lines.push("# Context Pack");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Workspace Root");
  lines.push("");
  lines.push(vscode.workspace.asRelativePath(workspaceUri, false) || ".");
  lines.push("");
  lines.push("## User Request");
  lines.push("");
  lines.push(taskContent ?? "_No task.md content found._");
  lines.push("");

  // isTracked distinguishes an AI run (even one that changed zero files)
  // from a manually-implemented task or a pre-tracking task.
  // implReviewFiles === undefined  → no tracking info  → fallback mode
  // implReviewFiles === []         → tracked, no files changed → tracked mode
  // implReviewFiles has entries    → tracked, normal case
  const isTracked = implReviewFiles !== undefined;

  if (isTracked) {
    // ------------------------------------------------------------------ //
    // Tracked mode (AI implementation run, possibly zero files changed)  //
    // ------------------------------------------------------------------ //
    lines.push("## Implementation Review Files");
    lines.push("");

    if (implReviewFiles.length === 0) {
      // No AI implementation run for this task has changed any workspace
      // files yet — nothing to embed.
      lines.push(
        "_No AI implementation run for this task has changed any workspace " +
        "files yet. There are no implementation files to review._"
      );
      lines.push("");
      lines.push("## Constraints");
      lines.push("");
      lines.push("- Do not refactor unrelated files.");
      lines.push("- Keep changes scoped to the request above.");
      lines.push("");
      return { content: lines.join("\n"), isFallback: false };
    }

    lines.push(
      "_Tracked changed files accumulated across this task's AI implementation " +
      "runs. For files also open in the editor, the unsaved buffer is used in " +
      "place of the on-disk copy._"
    );
    lines.push("");

    // Validate and resolve every tracked path before reading anything.
    // task-progress.json is a plain workspace file that can be edited
    // manually or committed from another machine, so its paths are treated
    // as untrusted input.
    const wsFsRaw = workspaceUri.fsPath;
    const wsFs =
      nodePath.parse(wsFsRaw).root === wsFsRaw
        ? wsFsRaw
        : wsFsRaw.replace(/[/\\]+$/, "");
    // Compute the real (symlink-resolved) workspace root once for the loop.
    const wsRealFs = nodeFs.realpathSync.native(wsFs);

    const fileInputs: Array<{ relPath: string; content: string | undefined }> = [];
    const rejectedPaths: string[] = [];

    for (const rawPath of implReviewFiles) {
      // Reject paths that contain traversal or other suspicious patterns.
      const normalized = sanitizeRelativePath(rawPath);
      if (normalized === undefined || normalized === "") {
        // undefined = traversal/invalid; "" = workspace root (not a file)
        rejectedPaths.push(rawPath);
        continue;
      }

      // Denylist check on the tracked path's basename
      if (isDenylisted(nodePath.basename(normalized))) {
        rejectedPaths.push(rawPath);
        continue;
      }

      // Defence-in-depth: verify the resolved absolute path stays inside
      // the workspace, e.g. to catch encoded traversal that slipped past
      // the string check.
      const resolved = vscode.Uri.joinPath(workspaceUri, normalized);
      const resolvedFs = resolved.fsPath;
      const inWorkspace =
        resolvedFs === wsFs ||
        resolvedFs.startsWith(wsFs + "/") ||
        resolvedFs.startsWith(wsFs + nodePath.sep);
      if (!inWorkspace) {
        rejectedPaths.push(rawPath);
        continue;
      }

      // Defence-in-depth: a symlink or junction inside the workspace
      // (e.g. "linked-dir" pointing outside it) passes the string-prefix
      // check above while workspace.fs still follows the link on disk.
      // Resolve the real path of the nearest existing ancestor and re-check.
      const resolvedRealFs = realpathOfNearestExistingAncestor(resolvedFs);
      const realInWorkspace =
        resolvedRealFs === wsRealFs ||
        resolvedRealFs.startsWith(wsRealFs + "/") ||
        resolvedRealFs.startsWith(wsRealFs + nodePath.sep);
      if (!realInWorkspace) {
        rejectedPaths.push(rawPath);
        continue;
      }

      const content = await getFileContentForReview(resolved);
      fileInputs.push({ relPath: normalized, content });
    }

    if (rejectedPaths.length > 0) {
      lines.push(
        `⚠ ${rejectedPaths.length} tracked path(s) rejected (unsafe, denylisted, or outside workspace):`
      );
      lines.push("");
      for (const p of rejectedPaths) {
        lines.push(`- \`${p}\``);
      }
      lines.push("");
    }

    for (const { relPath, content } of fileInputs) {
      const note = content === undefined ? " ⚠ (missing on disk)" : "";
      lines.push(`- ${relPath}${note}`);
    }
    lines.push("");

    lines.push("## Implementation Review File Contents");
    lines.push("");

    const results = applyContentCaps(
      fileInputs,
      IMPL_REVIEW_MAX_CHARS_PER_FILE,
      IMPL_REVIEW_MAX_TOTAL_CHARS
    );

    const included = results.filter(
      (r): r is (typeof r) & { content: string | undefined } => r.content !== null
    );
    const omitted = results.filter((r) => r.content === null);

    for (const result of included) {
      if (result.content === undefined) {
        lines.push(`### ${result.relPath} (missing on disk)`);
        lines.push("");
        lines.push("_File was tracked as changed but no longer exists on disk._");
        lines.push("");
      } else {
        const label = result.truncated ? " (truncated)" : "";
        lines.push(`### ${result.relPath}${label}`);
        lines.push("");
        lines.push("```");
        lines.push(result.content);
        lines.push("```");
        lines.push("");
      }
    }

    if (omitted.length > 0) {
      lines.push(
        `_${omitted.length} further tracked file(s) omitted: total content size limit reached._`
      );
      lines.push("");
      for (const o of omitted) {
        lines.push(`- ${o.relPath}`);
      }
      lines.push("");
    }

    lines.push("## Constraints");
    lines.push("");
    lines.push("- Do not refactor unrelated files.");
    lines.push("- Keep changes scoped to the request above.");
    lines.push("");

    return { content: lines.join("\n"), isFallback: false };
  }

  // ---------------------------------------------------------------------- //
  // Fallback mode — no tracked file set (manual impl or pre-tracking task)  //
  // ---------------------------------------------------------------------- //
  lines.push(
    "⚠ **Fallback mode**: This task has no tracked implementation file set " +
    "(the implementation was done manually, or predates file tracking). " +
    "The files below are the editors currently open in VS Code — they may not " +
    "represent all changed files."
  );
  lines.push("");

  // Resolve workspace realpath for eligibility checks.
  const wsFsRawFallback = workspaceUri.fsPath.replace(/[/\\]+$/, "");
  let wsRealFsFallback: string;
  try {
    wsRealFsFallback = nodeFs.realpathSync.native(wsFsRawFallback);
  } catch {
    wsRealFsFallback = wsFsRawFallback;
  }

  const openDocs = vscode.workspace.textDocuments.filter(
    (doc) => isEligibleDocument(doc, workspaceUri, wsRealFsFallback)
  );
  const seenPaths = new Set<string>();
  const uniqueDocs = openDocs.filter((doc) => {
    const relPath = vscode.workspace.asRelativePath(doc.uri, false);
    if (seenPaths.has(relPath)) {
      return false;
    }
    seenPaths.add(relPath);
    return true;
  });

  lines.push("## Open Editors (Fallback)");
  lines.push("");
  if (uniqueDocs.length > 0) {
    for (const doc of uniqueDocs) {
      lines.push(`- ${vscode.workspace.asRelativePath(doc.uri, false)}`);
    }
  } else {
    lines.push("_No eligible open editors._");
  }
  lines.push("");

  if (uniqueDocs.length > 0) {
    lines.push("## Open Editor Contents (Fallback)");
    lines.push("");

    const fileInputs = uniqueDocs.map((doc) => ({
      relPath: vscode.workspace.asRelativePath(doc.uri, false),
      content: doc.getText() as string | undefined,
    }));

    const results = applyContentCaps(
      fileInputs,
      IMPL_REVIEW_MAX_CHARS_PER_FILE,
      IMPL_REVIEW_MAX_TOTAL_CHARS
    );

    const included = results.filter(
      (r): r is (typeof r) & { content: string | undefined } => r.content !== null
    );
    const omitted = results.filter((r) => r.content === null);

    for (const result of included) {
      if (result.content !== undefined) {
        const label = result.truncated ? " (truncated)" : "";
        lines.push(`### ${result.relPath}${label}`);
        lines.push("");
        lines.push("```");
        lines.push(result.content);
        lines.push("```");
        lines.push("");
      }
    }

    if (omitted.length > 0) {
      lines.push(
        `_${omitted.length} further open file(s) omitted: total content size limit reached._`
      );
      lines.push("");
      for (const o of omitted) {
        lines.push(`- ${o.relPath}`);
      }
      lines.push("");
    }
  }

  lines.push("## Constraints");
  lines.push("");
  lines.push("- Do not refactor unrelated files.");
  lines.push("- Keep changes scoped to the request above.");
  lines.push("");

  return { content: lines.join("\n"), isFallback: true };
}

/**
 * Write context-pack.md for an implementation review and return its URI
 * together with a flag indicating whether fallback (open-editor) mode was used.
 */
export async function writeImplReviewContextPack(
  taskFolderUri: vscode.Uri,
  workspaceUri: vscode.Uri,
  implReviewFiles: string[] | undefined
): Promise<{ contextPackUri: vscode.Uri; isFallback: boolean }> {
  const { content, isFallback } = await generateImplReviewContextPack(
    taskFolderUri,
    workspaceUri,
    implReviewFiles
  );
  const contextPackUri = await writeContextPackContent(taskFolderUri, content);
  return { contextPackUri, isFallback };
}
