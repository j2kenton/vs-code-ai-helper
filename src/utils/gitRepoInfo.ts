import { spawn } from "child_process";
import { createHash } from "crypto";
import { promises as fsPromises } from "fs";
import * as path from "path";
import { classifyWorkflowPathV1 } from "../services/workflowPrivacyClassifierV1";

/**
 * Run a git command with safe argument passing (no shell interpolation).
 * Shared by commitAndPushTask.ts (which needs the raw stdout for staging/
 * diffing/committing/pushing) and publishPreflight.ts's read-only git
 * readiness check (which only ever reads, never stages/commits/pushes).
 */
export async function runGitCommand(
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

/** Resolve the git repository root containing `folderPath`, or undefined if none. */
export async function resolveGitRepo(folderPath: string): Promise<string | undefined> {
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
 * Resolve the current HEAD commit SHA for the repo containing `folderPath`,
 * or undefined when there is no repo (or git itself is unavailable). Used to
 * stamp review artifacts with the commit they actually assessed (2i), so a
 * later re-review can tell how stale the "previous review" it's told to
 * reconcile against is.
 */
export async function resolveHeadCommitSha(folderPath: string): Promise<string | undefined> {
  const repoRoot = await resolveGitRepo(folderPath);
  if (!repoRoot) {
    return undefined;
  }
  try {
    const { stdout } = await runGitCommand(repoRoot, "rev-parse", ["HEAD"]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** One `git status --porcelain=v2 -z` change record, repo-root-relative paths. */
interface WorkingTreeStatusEntryV1 {
  readonly status: string;
  readonly path: string;
  readonly origPath?: string;
}

/**
 * Parse `git status --porcelain=v2 -z` output. NUL-delimited, so no path
 * quoting edge case needs handling; a rename/copy record's original path is
 * the NUL-separated field that follows it (porcelain v2's own convention —
 * see `git status` docs, "Porcelain Format Version 2").
 */
function parseWorkingTreeStatusV2Z(output: string): WorkingTreeStatusEntryV1[] {
  const tokens = output.split("\0").filter((token) => token.length > 0);
  const entries: WorkingTreeStatusEntryV1[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    i++;
    if (token.startsWith("1 ")) {
      const fields = token.split(" ");
      const filePath = fields.slice(8).join(" ");
      if (filePath) {
        entries.push({ status: fields[1] ?? "", path: filePath });
      }
    } else if (token.startsWith("2 ")) {
      const fields = token.split(" ");
      const filePath = fields.slice(9).join(" ");
      const origPath = i < tokens.length ? tokens[i] : undefined;
      if (origPath !== undefined) {
        i++;
      }
      if (filePath) {
        entries.push({ status: fields[1] ?? "", path: filePath, origPath });
      }
    } else if (token.startsWith("u ")) {
      const fields = token.split(" ");
      const filePath = fields.slice(10).join(" ");
      if (filePath) {
        entries.push({ status: fields[1] ?? "", path: filePath });
      }
    } else if (token.startsWith("? ")) {
      entries.push({ status: "??", path: token.slice(2) });
    }
    // "! " (ignored) entries never appear here: called without `--ignored`.
  }
  return entries;
}

/**
 * Fingerprint the UNCOMMITTED working tree: `git status --porcelain=v2` (which
 * non-workflow-control paths changed, and how) plus the diff content of every
 * tracked path it lists and the raw content of every untracked path. Two
 * calls return the same digest iff the non-workflow-control working tree is
 * byte-identical — independent of git HEAD, which never moves while a task's
 * edits stay uncommitted.
 *
 * Exists because `resolveHeadCommitSha` alone cannot see this case (RC1 item
 * 3): a task's work is uncommitted for its whole lifetime, so a review-dispatch
 * guard that only compares HEAD SHAs reads a workspace that changed twenty
 * times since the last review as "unchanged" every time.
 *
 * Reuses `classifyWorkflowPathV1` — the same exclusion every other
 * change-set consumer applies (`sanitizeChangeSetV1`) — so Ensemble's own
 * bookkeeping (locks, round-progress.md, journals) can never move the
 * fingerprint on its own.
 *
 * `options.excludeAbsolutePaths` additionally drops specific files a caller
 * knows are OUTPUTS of the very thing being fingerprinted, not inputs to it —
 * e.g. a review guard must exclude the review artifact it is about to write,
 * or every dispatch would see its own previous write as "the tree changed"
 * and could never report "unchanged" even when nothing else did.
 *
 * Returns undefined when there is no repo, or git/the filesystem is
 * unavailable (fail-open, the same convention `resolveHeadCommitSha` uses):
 * callers must treat undefined as "cannot determine," never as "unchanged."
 */
export async function computeWorkingTreeFingerprintV1(
  folderPath: string,
  options: { readonly excludeAbsolutePaths?: readonly string[] } = {}
): Promise<string | undefined> {
  const repoRoot = await resolveGitRepo(folderPath);
  if (!repoRoot) {
    return undefined;
  }
  try {
    const { stdout: statusOut } = await runGitCommand(repoRoot, "status", [
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
    ]);
    const excludedRelative = new Set(
      (options.excludeAbsolutePaths ?? []).map((absPath) =>
        path.relative(repoRoot, absPath).replace(/\\/g, "/")
      )
    );
    const entries = parseWorkingTreeStatusV2Z(statusOut)
      .filter(
        (entry) =>
          classifyWorkflowPathV1(entry.path) !== "workflowControl" &&
          !excludedRelative.has(entry.path) &&
          (entry.origPath === undefined ||
            (classifyWorkflowPathV1(entry.origPath) !== "workflowControl" &&
              !excludedRelative.has(entry.origPath)))
      )
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path));

    const hash = createHash("sha256");
    hash.update(
      entries.map((entry) => `${entry.status} ${entry.origPath ?? ""} -> ${entry.path}`).join("\n")
    );

    for (const entry of entries) {
      if (entry.status === "??") {
        hash.update(`\n--untracked:${entry.path}--\n`);
        try {
          hash.update(await fsPromises.readFile(path.join(repoRoot, entry.path)));
        } catch {
          // Deleted/unreadable between status and read: the status line
          // above already moved the digest, nothing further to fold in.
        }
      } else {
        hash.update(`\n--diff:${entry.path}--\n`);
        try {
          const { stdout: diffOut } = await runGitCommand(repoRoot, "diff", [
            "HEAD",
            "--",
            entry.path,
          ]);
          hash.update(diffOut);
        } catch {
          // No HEAD yet (fresh repo), or a path git diff can't resolve: the
          // status line above already recorded the change.
        }
      }
    }
    return hash.digest("hex");
  } catch {
    return undefined;
  }
}

/**
 * Count commits reachable from HEAD but not from `fromSha` — how far HEAD has
 * moved since a review recorded against `fromSha`. Returns undefined when the
 * repo cannot be resolved, or `fromSha` itself cannot be resolved (e.g. it
 * was rewritten away by a rebase) — callers must treat that as "staleness
 * cannot be determined", never as zero, so an unresolvable SHA falls back to
 * the conservative default (reconcile as usual) rather than silently
 * suppressing reconciliation.
 */
export async function countCommitsSinceSha(
  folderPath: string,
  fromSha: string
): Promise<number | undefined> {
  const repoRoot = await resolveGitRepo(folderPath);
  if (!repoRoot) {
    return undefined;
  }
  try {
    const { stdout } = await runGitCommand(repoRoot, "rev-list", [
      "--count",
      `${fromSha}..HEAD`,
    ]);
    const count = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(count) ? count : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Determine the push destination string for display in the confirm dialog
 * (and for the preflight readiness check below).
 */
export async function describePushDestination(
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

/** Read-only result of `checkGitPublishReadiness`. Never stages, commits, or pushes. */
export type GitPublishReadiness =
  | {
      ok: true;
      repoRoot: string;
      currentBranch: string;
      pushDestination: string;
      hasUpstream: boolean;
      singleRemote?: string;
    }
  | { ok: false; reason: string };

/**
 * Read-only git readiness check shared by the automatic Publish-entry
 * preflight (publishPreflight.ts, which must decide whether to schedule
 * auto-publish before any lint/dispatch side effects) and the manual
 * "Commit and Push" flow (commitAndPushTask.ts, which re-derives the same
 * repoRoot/branch/push-destination values it needs for the confirm dialog).
 * Runs only read-only git commands (rev-parse, remote) — never stages,
 * commits, or pushes — so it is safe to call speculatively before deciding
 * whether to schedule publishing at all.
 */
export async function checkGitPublishReadiness(
  folderPath: string
): Promise<GitPublishReadiness> {
  const repoRoot = await resolveGitRepo(folderPath);
  if (!repoRoot) {
    return {
      ok: false,
      reason: "Could not find git repository. Make sure the task is inside a git repository.",
    };
  }

  let currentBranch = "(unknown)";
  try {
    const { stdout: branchOut } = await runGitCommand(repoRoot, "rev-parse", [
      "--abbrev-ref",
      "HEAD",
    ]);
    currentBranch = branchOut.trim();
  } catch {
    // ignore — falls through to the detached-HEAD/push-destination checks
    // below with the "(unknown)" placeholder, matching the manual flow.
  }

  if (currentBranch === "HEAD") {
    return {
      ok: false,
      reason: "Repository is in detached HEAD state. Check out a branch before committing.",
    };
  }

  const { description: pushDestination, hasUpstream, singleRemote } =
    await describePushDestination(repoRoot, currentBranch);

  if (!hasUpstream && !singleRemote) {
    return {
      ok: false,
      reason:
        `Push target is ambiguous: ${pushDestination}. ` +
        `Set an upstream manually with: git push -u <remote> ${currentBranch}`,
    };
  }

  return { ok: true, repoRoot, currentBranch, pushDestination, hasUpstream, singleRemote };
}

/**
 * RC3 item 10 (Step 6): changed files since a task's implementation baseline
 * commit, for rebuilding `TaskProgress.implReviewFiles` at Publish when the
 * round ledger cannot establish the set on its own (see
 * `taskImplementationBaselineV1.ts` for where `baselineSha` comes from).
 *
 * Combines `git diff --name-only <baselineSha>` (committed and uncommitted
 * tracked changes since the baseline) with `git ls-files --others
 * --exclude-standard` (untracked files) — the same two calls
 * `commitAndPushTask.ts` already issues to characterize the working tree.
 * Git reports paths relative to `repoRoot`; each is resolved to a real path
 * and kept only when it falls inside the real `workspaceRoot` (the same
 * containment check `contextPack.ts` applies to tracked paths) — a workspace
 * opened as a subdirectory of a larger repository must never pull a sibling
 * package's files into this task's review scope. Returned paths are
 * workspace-relative, forward-slashed, and de-duplicated; `droppedCount` is
 * how many resolved paths were outside the workspace and therefore excluded,
 * so a caller can log why the returned set may be smaller than the raw diff.
 */
export async function listChangedFilesSinceShaV1(
  repoRoot: string,
  baselineSha: string,
  workspaceRoot: string
): Promise<{ files: string[]; droppedCount: number }> {
  const [diffResult, untrackedResult] = await Promise.all([
    runGitCommand(repoRoot, "diff", ["--name-only", baselineSha]),
    runGitCommand(repoRoot, "ls-files", ["--others", "--exclude-standard"]),
  ]);
  const rawPaths = [
    ...diffResult.stdout.trim().split(/\r?\n/).filter(Boolean),
    ...untrackedResult.stdout.trim().split(/\r?\n/).filter(Boolean),
  ];

  const realWorkspaceRoot = await fsPromises.realpath(workspaceRoot).catch(() => workspaceRoot);
  const seen = new Set<string>();
  const files: string[] = [];
  let droppedCount = 0;

  for (const rawPath of rawPaths) {
    const absolute = path.join(repoRoot, rawPath);
    const real = await fsPromises.realpath(absolute).catch(() => absolute);
    const relativeToWorkspace = path.relative(realWorkspaceRoot, real);
    const isInsideWorkspace =
      relativeToWorkspace !== "" &&
      !relativeToWorkspace.startsWith("..") &&
      !path.isAbsolute(relativeToWorkspace);
    if (!isInsideWorkspace) {
      droppedCount += 1;
      continue;
    }
    const workspaceRelative = relativeToWorkspace.split(path.sep).join("/");
    if (!seen.has(workspaceRelative)) {
      seen.add(workspaceRelative);
      files.push(workspaceRelative);
    }
  }

  return { files, droppedCount };
}
