import * as vscode from "vscode";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import {
  IMPLEMENTATION_FILENAME,
  PLAN_FILENAME,
  PUBLISH_CHECKS_FILENAME,
  STAGE_ARTIFACT_FILENAMES,
  TaskProgress,
} from "../types/taskProgress";
import { DEFAULT_TASK_ROOT } from "./taskRoot";
import {
  resolveStageResponseScope,
  snapshotStageResponseState,
} from "./stageResponseScope";
import {
  invalidatePublishChecksFreshnessStamp,
  withPublishChecksReportLockV1,
  writeFileAtomicV1,
} from "./publishChecksFreshness";

/**
 * Report-only Publish-stage check: which files this task actually changed
 * (its tracked implementation-run change set) does its plan never mention.
 *
 * Deliberately has NO `passed` field — Publish must never gate on this, and
 * omitting the field (rather than always returning `true`) is what stops a
 * future caller from growing gating logic on top of it.
 */
export interface PublishScopeCheckResult {
  /** Repo-relative, forward-slash-normalized files this task changed that
   * the plan does not appear to mention. Never includes `.ensemble/`
   * task-artifact paths — those are reported separately in
   * `ensembleArtifacts`. */
  unplannedFiles: string[];
  /** `.ensemble/` task-artifact paths this task changed. Every task writes
   * its own plan/review files, so these are expected noise and are kept out
   * of `unplannedFiles`. */
  ensembleArtifacts: string[];
  /** ISO timestamp of the run that produced this result.
   *
   * Rendered into the section so the report can never present two runs as one.
   * The Completion Checks section has always stamped its own `Last run`; this
   * one did not, and the two are refreshed by different call paths — Commit and
   * Push re-runs the lint alone — so the undated half was the half that went
   * stale, with nothing on the page to say so. */
  runAt: string;
  /** True when there is no basis to compute a diff at all — git is
   * unavailable, or this task has no tracked implementation-run changed-file
   * set (`implReviewFiles` is `undefined`, not merely empty). When true, the
   * arrays above are meaningless and must never be rendered as "nothing
   * unexpected". */
  basisUnavailable: boolean;
}

// ---------------------------------------------------------------------------
// Expectation side: extract path-like tokens from a plan document.
// ---------------------------------------------------------------------------

/** Repo top-level directories common enough that a bare mention (no file
 * extension, e.g. a directory reference) is still worth treating as a path. */
const KNOWN_PATH_PREFIXES = [
  "src/",
  "test/",
  "tests/",
  "scripts/",
  "docs/",
  "workflow-inventories/",
  `${DEFAULT_TASK_ROOT}/`,
  "out/",
  "dist/",
  "lib/",
];

const TRAILING_PUNCTUATION_RE = /[.,;:!?)\]}'"]+$/;
const LEADING_PUNCTUATION_RE = /^[([{'"]+/;

function stripSurroundingPunctuation(value: string): string {
  return value.replace(LEADING_PUNCTUATION_RE, "").replace(TRAILING_PUNCTUATION_RE, "");
}

function normalizePlanPathToken(value: string): string {
  return stripSurroundingPunctuation(value)
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/[#?].*$/, "")
    .replace(/\/+$/, "");
}

/**
 * Fuzzy path-token filter, deliberately conservative in what it accepts: a
 * token with a "/" and a real file extension or a known repo directory
 * prefix, or a bare (no-slash) filename with a real extension. This is what
 * keeps ordinary prose ("and/or", "pass/fail", `resolveRunnerForModel`) from
 * being misread as a file path — see the module doc comment on why this is
 * fuzzy by design rather than an exact parser.
 */
function looksLikePathToken(candidate: string): boolean {
  if (!candidate || /\s/.test(candidate)) {
    return false;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    return false; // URL scheme (http://, https://, mailto:, etc.)
  }
  if (candidate.startsWith("#") || candidate === "." || candidate === "..") {
    return false;
  }
  const lastSegment = candidate.slice(candidate.lastIndexOf("/") + 1);
  const hasExtension = /\.[A-Za-z0-9]{1,10}$/.test(lastSegment);
  const hasSlash = candidate.includes("/");
  if (!hasSlash) {
    return hasExtension && candidate.length > 3 && !/^(e\.g\.|i\.e\.|etc\.)$/i.test(candidate);
  }
  const hasKnownPrefix = KNOWN_PATH_PREFIXES.some((prefix) => candidate.startsWith(prefix));
  return hasExtension || hasKnownPrefix;
}

const BACKTICK_RE = /`([^`\n]+)`/g;
const MARKDOWN_LINK_RE = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const BARE_PATH_RE = /\b[\w.-]+(?:\/[\w.-]+)+\b/g;
/** Blanked out before the bare-path scan so a URL's own path segment (e.g.
 * "example.com/readme.md" inside "https://example.com/readme.md") is never
 * misread as a repo-relative file path — backticked/linked URLs are already
 * excluded individually by `looksLikePathToken`'s scheme check, but a bare
 * URL in prose has no such per-candidate guard around its interior slashes. */
const URL_RE = /[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/**
 * Extract path-like tokens mentioned anywhere in a plan document — backticked
 * spans, markdown link targets, and bare `src/...`-style strings. Scans the
 * whole document rather than depending on a "Files Changed" heading (this
 * repo's plans tend to use one, but the contract can't assume every plan
 * does). Fuzzy by nature: a plan can mention a file it never changed, and a
 * rename reads as unaccounted — see the module doc comment.
 */
export function extractPlanMentionedPaths(planMarkdown: string): string[] {
  const found = new Set<string>();
  const consider = (raw: string): void => {
    const normalized = normalizePlanPathToken(raw);
    if (looksLikePathToken(normalized)) {
      found.add(normalized);
    }
  };

  for (const match of planMarkdown.matchAll(BACKTICK_RE)) {
    consider(match[1] ?? "");
  }
  for (const match of planMarkdown.matchAll(MARKDOWN_LINK_RE)) {
    consider(match[1] ?? "");
  }
  const bareScanText = planMarkdown.replace(URL_RE, (match) => " ".repeat(match.length));
  for (const match of bareScanText.matchAll(BARE_PATH_RE)) {
    consider(match[0]);
  }

  return [...found].sort();
}

// ---------------------------------------------------------------------------
// Actual side + diff: compare implReviewFiles against the extracted set.
// ---------------------------------------------------------------------------

function isEnsembleArtifactPath(file: string): boolean {
  return file === DEFAULT_TASK_ROOT || file.startsWith(`${DEFAULT_TASK_ROOT}/`);
}

/** A changed file is "mentioned" when it exactly matches a plan-mentioned
 * path, or a plan-mentioned path is a suffix of it on a path-segment
 * boundary (the plan named a shorter/relative form of the same file). */
function isMentioned(file: string, mentioned: ReadonlySet<string>): boolean {
  if (mentioned.has(file)) {
    return true;
  }
  for (const candidate of mentioned) {
    if (file === candidate || file.endsWith(`/${candidate}`)) {
      return true;
    }
  }
  return false;
}

/**
 * Diff actually-changed files against the plan-mentioned set. Pure and
 * synchronous so it can be tested without any filesystem/git access.
 *
 * @internal exported for testing
 */
export function computeScopeCheckDiff(
  changedFiles: readonly string[],
  planMentionedPaths: readonly string[]
): Pick<PublishScopeCheckResult, "unplannedFiles" | "ensembleArtifacts"> {
  const mentioned = new Set(planMentionedPaths.map(normalizePlanPathToken));
  const unplannedFiles: string[] = [];
  const ensembleArtifacts: string[] = [];
  for (const rawFile of changedFiles) {
    const file = rawFile.replace(/\\/g, "/");
    if (isEnsembleArtifactPath(file)) {
      ensembleArtifacts.push(file);
      continue;
    }
    if (!isMentioned(file, mentioned)) {
      unplannedFiles.push(file);
    }
  }
  return { unplannedFiles: unplannedFiles.sort(), ensembleArtifacts: ensembleArtifacts.sort() };
}

/** Read the task's plan document for path extraction: `plan-final.md` (the
 * task's final, implemented plan) when present, otherwise `plan.md`. */
function readPlanMarkdown(taskFolderUri: vscode.Uri): string | undefined {
  for (const filename of [IMPLEMENTATION_FILENAME, PLAN_FILENAME]) {
    try {
      return nodeFs.readFileSync(nodePath.join(taskFolderUri.fsPath, filename), "utf8");
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

/**
 * Compute the Publish Scope Check for a task: files it actually changed
 * (`progress.implReviewFiles`, the content-fingerprinted change set already
 * tracked across implementation runs) that its plan document never mentions.
 *
 * Deliberately does NOT hand-roll a new git diff for the "actual" side —
 * `implReviewFiles` already IS one. `snapshotStageResponseState` (the same
 * machinery "Respond to AI" uses to fingerprint git state) is reused only to
 * probe whether git is available right now, at Publish time — the basis for
 * this check existing at all, not a second source of changed files.
 */
export async function computePublishScopeCheck(
  taskFolderUri: vscode.Uri,
  progress: Pick<TaskProgress, "implReviewFiles">
): Promise<PublishScopeCheckResult> {
  const runAt = new Date().toISOString();
  const workspaceUri = vscode.workspace.getWorkspaceFolder(taskFolderUri)?.uri ?? taskFolderUri;
  const scope = await resolveStageResponseScope(workspaceUri, taskFolderUri, "publish");
  const gitSnapshot = await snapshotStageResponseState(scope);
  const gitUnavailable = gitSnapshot === undefined;
  const changedFiles = progress.implReviewFiles;
  const filesUnknown = changedFiles === undefined;

  if (gitUnavailable || filesUnknown) {
    return { runAt, unplannedFiles: [], ensembleArtifacts: [], basisUnavailable: true };
  }

  const planMarkdown = readPlanMarkdown(taskFolderUri);
  const planMentionedPaths = extractPlanMentionedPaths(planMarkdown ?? "");
  return { runAt, ...computeScopeCheckDiff(changedFiles, planMentionedPaths), basisUnavailable: false };
}

// ---------------------------------------------------------------------------
// Report integration — mirrors completionLint.ts's managed-section pattern
// exactly, as its own separate section.
// ---------------------------------------------------------------------------

const SCOPE_CHECK_SECTION_START = "<!-- scope-check:start -->";
const SCOPE_CHECK_SECTION_END = "<!-- scope-check:end -->";

/**
 * Render the "Scope Check" section written into publish-review.md.
 *
 * @internal exported for testing
 */
export function renderScopeCheckSection(result: PublishScopeCheckResult): string {
  const lines: string[] = [SCOPE_CHECK_SECTION_START, "## Scope Check", ""];
  lines.push(`- Last run: ${result.runAt}`, "");
  lines.push(
    "_Report-only — this never blocks Publish, the same as a failing check elsewhere on this " +
      "page: it is reported, and you decide. Compares the files this task actually changed " +
      "against the files its plan document mentions. The changed-file side reflects this " +
      "task's tracked implementation-run change set (`implReviewFiles`), which can be stale — " +
      "if an earlier run's own change detection failed, its previously tracked value is left " +
      "in place rather than cleared. Treat findings as a fuzzy signal, not proof: a plan can " +
      "mention a file under a different form (e.g. a rename) and read as unaccounted here._"
  );
  if (result.basisUnavailable) {
    lines.push(
      "",
      "**No basis for this check.** Git is unavailable, or this task has no tracked " +
        "implementation-run change set yet. The absence of findings below does not mean " +
        "nothing unexpected changed — it means this check could not run."
    );
    lines.push(SCOPE_CHECK_SECTION_END);
    return lines.join("\n");
  }
  if (result.unplannedFiles.length === 0) {
    lines.push("", "No files the plan doesn't mention.");
  } else {
    lines.push("", "### Files the plan doesn't mention", "");
    for (const file of result.unplannedFiles) {
      lines.push(`- \`${file}\``);
    }
  }
  if (result.ensembleArtifacts.length > 0) {
    lines.push(
      "",
      `_Also changed ${result.ensembleArtifacts.length} \`${DEFAULT_TASK_ROOT}/\` task-artifact ` +
        "file(s), excluded from the list above — every task writes its own plan/review files, " +
        "so they are expected._"
    );
  }
  lines.push(SCOPE_CHECK_SECTION_END);
  return lines.join("\n");
}

/**
 * Merge a rendered "Scope Check" section into whatever publish-review.md
 * content already exists, replacing a previous run of the managed section in
 * place — mirrors `mergeCompletionChecksSection` exactly, as a separate
 * section with its own markers.
 *
 * @internal exported for testing
 */
export function mergeScopeCheckSection(existing: string, section: string): string {
  const startIdx = existing.indexOf(SCOPE_CHECK_SECTION_START);
  const endIdx = existing.indexOf(SCOPE_CHECK_SECTION_END);
  return startIdx !== -1 && endIdx !== -1 && endIdx > startIdx
    ? existing.slice(0, startIdx) + section + existing.slice(endIdx + SCOPE_CHECK_SECTION_END.length)
    : existing.trim().length > 0
      ? `${existing.trimEnd()}\n\n${section}\n`
      : `${section}\n`;
}

/**
 * Remove this module's managed section from `publish-review.md`, where it used
 * to live before the split. Mirrors
 * `stripCompletionChecksFromReviewArtifactV1` exactly — subtractive only, and
 * only over the markers this module owns. See PUBLISH_CHECKS_FILENAME for why
 * the reviewer's verdict and these checks must not share a document.
 */
async function stripScopeCheckFromReviewArtifactV1(
  taskFolderUri: vscode.Uri
): Promise<void> {
  const legacyName = STAGE_ARTIFACT_FILENAMES.publish;
  if (!legacyName) {
    return;
  }
  const legacyPath = nodePath.join(taskFolderUri.fsPath, legacyName);

  let existing: string;
  try {
    existing = await nodeFs.promises.readFile(legacyPath, "utf8");
  } catch {
    return;
  }

  const startIdx = existing.indexOf(SCOPE_CHECK_SECTION_START);
  const endIdx = existing.indexOf(SCOPE_CHECK_SECTION_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return;
  }

  const stripped =
    existing.slice(0, startIdx).trimEnd() +
    "\n" +
    existing.slice(endIdx + SCOPE_CHECK_SECTION_END.length).trimStart();
  await nodeFs.promises.writeFile(legacyPath, `${stripped.trimEnd()}\n`, "utf8");
}

/**
 * Upsert a "Scope Check" section into publish-checks.md, alongside (and
 * independent of) the "Completion Checks" section `completionLint.ts`
 * manages. Uses plain `node:fs` for the same reason
 * `upsertCompletionChecksReportV1` does — always a plain file inside
 * the task folder, never a virtual FS scheme.
 */
export async function upsertScopeCheckReportV1(
  taskFolderUri: vscode.Uri,
  result: PublishScopeCheckResult
): Promise<void> {
  const targetPath = nodePath.join(taskFolderUri.fsPath, PUBLISH_CHECKS_FILENAME);

  // See the matching comment in completionLint.ts's upsertCompletionChecksReportV1:
  // one locked read-modify-write, merging the section and invalidating any
  // freshness stamp against the same snapshot, landing in a single atomic
  // write. runPublishChecks.ts writes a fresh valid stamp itself once both
  // sections have completed against one unchanged commit.
  await withPublishChecksReportLockV1(taskFolderUri, async () => {
    let existing = "";
    try {
      existing = await nodeFs.promises.readFile(targetPath, "utf8");
    } catch {
      existing = "";
    }

    const section = renderScopeCheckSection(result);
    const merged = mergeScopeCheckSection(existing, section);
    await writeFileAtomicV1(targetPath, invalidatePublishChecksFreshnessStamp(merged));
  });
  await stripScopeCheckFromReviewArtifactV1(taskFolderUri);
}

/**
 * Compute the Publish Scope Check and upsert its section into
 * publish-review.md in one call — the entry point Publish command wiring
 * uses (`runPublishChecks.ts`, `runLintingFixes.ts`), mirroring how
 * `runCompletionLint` bundles computing and persisting the Completion Checks
 * section.
 */
export async function runPublishScopeCheck(
  taskFolderUri: vscode.Uri,
  progress: Pick<TaskProgress, "implReviewFiles">
): Promise<PublishScopeCheckResult> {
  const result = await computePublishScopeCheck(taskFolderUri, progress);
  await upsertScopeCheckReportV1(taskFolderUri, result);
  return result;
}
