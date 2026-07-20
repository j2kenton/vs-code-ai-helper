import { spawn } from "child_process";

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
