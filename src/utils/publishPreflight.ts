import * as vscode from "vscode";
import { runCompletionLint, collectCompletionLintPreview, CompletionLintResult } from "./completionLint";
import { checkGitPublishReadiness } from "./gitRepoInfo";

/**
 * Result of `checkPublishPreflight`. `ok: false` carries a human-readable
 * `reason` so callers can surface why auto-publish was skipped instead of
 * silently doing nothing (or, worse, silently proceeding to commit/push
 * despite failing checks).
 */
export type PublishPreflightResult =
  | { ok: true; lintPayload: CompletionLintResult }
  | { ok: false; reason: string; lintPayload?: CompletionLintResult };

/**
 * Shared preflight check for landing a task on the Publish stage, used by
 * both the manual "Set Task Stage" entry path (setTaskStage.ts) and the
 * "Complete Stage & Move On" / auto-advance entry path (reviewActions.ts
 * nextStage) before either schedules the `auto-publish` automation chain.
 *
 * Previously each entry path ran `runCompletionLint` unconditionally before
 * scheduling `auto-publish` — the lint result was collected (and persisted)
 * but never actually consulted before deciding whether to dispatch. That let
 * a task with failing completion checks auto-publish anyway (commitAndPushTask's
 * own gate still stops it there with a modal, but the auto-dispatch itself
 * was already a false promise of "checks passed, so we're publishing").
 *
 * The review-owned vs. entry-owned dispatch decision itself (including
 * "auto-advance into Publish with a configured follow-up Publish review" vs.
 * without) lives in reviewActions.ts (nextStage's Step 3/3b, and the
 * auto-advance tail inside runReviewForFolder), which consult this helper's
 * result before choosing an owner. This function first runs a read-only git
 * readiness check (repo/branch/remote — checkGitPublishReadiness never
 * stages, commits, or pushes) so a task that cannot possibly publish (no
 * repo, detached HEAD, ambiguous remote) is declined with a structured
 * reason *before* anything with side effects runs. Only once git is ready
 * does it compute the completion lint result.
 *
 * By default this is entirely side-effect-free: it computes the lint result
 * via `collectCompletionLintPreview(..., { allowScopePrompt: false })` and
 * never writes task-progress.json or publish-review.md, and never opens a
 * QuickPick to re-pick a stale Publish scope (a stale scope is instead
 * reported as an ordinary `ok: false` failure reason). This is what every
 * scheduling-decision call site uses (setTaskStage.ts, reviewActions.ts) —
 * deciding *whether* to schedule `auto-publish` must not itself mutate
 * persisted task state or show blocking UI.
 *
 * Pass `{ persist: true }` only from the site that is actually executing a
 * Publish attempt (commitAndPushTask.ts's pre-commit checks) — that recheck
 * uses `runCompletionLint` instead, which computes the same result and
 * additionally persists it into task-progress.json and publish-review.md's
 * managed Completion Checks section, so the artifact reflects what the
 * publish attempt actually saw.
 */
export async function checkPublishPreflight(
  taskFolderUri: vscode.Uri,
  relevantFiles?: readonly string[],
  options?: { persist?: boolean }
): Promise<PublishPreflightResult> {
  const gitReadiness = await checkGitPublishReadiness(taskFolderUri.fsPath);
  if (!gitReadiness.ok) {
    return { ok: false, reason: gitReadiness.reason };
  }
  try {
    const lintPayload = options?.persist
      ? await runCompletionLint(taskFolderUri, relevantFiles)
      : await collectCompletionLintPreview(taskFolderUri, relevantFiles, { allowScopePrompt: false });
    if (!lintPayload.passed) {
      const summary = lintPayload.summary ? `: ${lintPayload.summary}` : ".";
      return {
        ok: false,
        reason: `Completion checks did not pass${summary}`,
        lintPayload,
      };
    }
    return { ok: true, lintPayload };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
