/**
 * bugs3 Step 17: what actually stopped a Commit & Push, so a confirmation that
 * timed out, was dropped by a reload or was dismissed is never reported as the
 * owner cancelling.
 *
 * Reported 2026-10-27 (bugs2, Publish): the confirmation card was withdrawn
 * unanswered after exactly 10 minutes and the run ended "Commit and push
 * cancelled." The owner had cancelled nothing, the message named no reason, and
 * the next attempt re-ran the 12-minute checks.
 *
 * The confirmation step records the cause here; the terminal presentation reads
 * it once. The note about the checks is only made when this attempt reused a
 * recorded passing result, because only then does the next attempt skip them.
 */

export const COMMIT_PUSH_CONFIRMATION_TIMEOUT_MINUTES_V1 = 10;

export type CommitPushStopKindV1 = "timedOut" | "interrupted" | "dismissed";

interface RecordedStopV1 {
  readonly kind: CommitPushStopKindV1;
  readonly step: string;
}

const stops = new Map<string, RecordedStopV1>();
const reusedChecks = new Set<string>();

/** The confirmation the owner was asked, in plain words. */
const STEP_WORDS_V1: Readonly<Record<string, string>> = {
  commitPushCompletionChecksFailed: "the failing-checks question",
  commitPushRunChecksNow: "the question about running the checks now",
  commitPushExistingStagedChanges: "the question about changes already staged",
  commitPushIncludeTaskFolder: "the question about the task folder's files",
  commitPushIncludeRunArtifacts: "the question about run artifacts",
  commitPushFinalScopeConfirmation: "the confirmation of what will be committed and where it goes",
  commitPushReviewMessage: "the commit message confirmation",
};

export function describeCommitPushStepV1(decisionKey: string): string {
  return STEP_WORDS_V1[decisionKey] ?? "a confirmation";
}

export function recordCommitPushStopV1(taskFolderPath: string, kind: CommitPushStopKindV1, decisionKey: string): void {
  stops.set(taskFolderPath, { kind, step: describeCommitPushStepV1(decisionKey) });
}

/** Called when this attempt used a recorded passing result instead of running the checks. */
export function noteCommitPushChecksReusedV1(taskFolderPath: string, reused: boolean): void {
  if (reused) {
    reusedChecks.add(taskFolderPath);
  } else {
    reusedChecks.delete(taskFolderPath);
  }
}

/** Whether this attempt skipped the checks on the strength of a recorded pass. */
export function commitPushChecksWereReusedV1(taskFolderPath: string): boolean {
  return reusedChecks.has(taskFolderPath);
}

export function describeCommitPushStopV1(stop: RecordedStopV1, checksReused: boolean): string {
  const again = checksReused
    ? "choose Commit & Push again — the checks will not re-run, because nothing has changed since they passed."
    : "choose Commit & Push again — the checks will run again.";
  switch (stop.kind) {
    case "timedOut":
      return (
        `Commit & Push was not confirmed within ${COMMIT_PUSH_CONFIRMATION_TIMEOUT_MINUTES_V1} minutes ` +
        `(it was waiting at ${stop.step}), so nothing was committed or pushed; ${again}`
      );
    case "interrupted":
      return (
        `Commit & Push was interrupted before ${stop.step} was answered (a reload or the window closing ended it), ` +
        `so nothing was committed or pushed; ${again}`
      );
    case "dismissed":
      return `${stop.step.charAt(0).toUpperCase()}${stop.step.slice(1)} was dismissed, so Commit & Push stopped and nothing was committed or pushed; ${again}`;
  }
}

/**
 * The notice for the cause recorded for this task, consumed so it is read once;
 * undefined when the run was not stopped by one of these causes.
 */
export function takeCommitPushStopTextV1(
  taskFolderPath: string,
  /**
   * What the recorded result shows NOW. The earlier "this attempt reused it" flag
   * says what was true when the checks were skipped, not whether the next attempt
   * will skip them; pass false when the result no longer matches the tree.
   */
  options?: { readonly checksStillReusable?: boolean }
): string | undefined {
  const stop = stops.get(taskFolderPath);
  const reused = reusedChecks.has(taskFolderPath) && options?.checksStillReusable !== false;
  stops.delete(taskFolderPath);
  reusedChecks.delete(taskFolderPath);
  return stop === undefined ? undefined : describeCommitPushStopV1(stop, reused);
}

/**
 * What a passing check result covered: the commit and the working-tree
 * fingerprint it was taken at. Kept for this attempt only, so the step that
 * stages files can confirm nothing moved since — whether the attempt ran the
 * checks itself or reused a recorded pass.
 */
export interface CommitPushCheckedTreeV1 {
  readonly scopeFolder: string;
  readonly headCommitSha: string | undefined;
  readonly treeFingerprint: string | undefined;
  /**
   * Identity of the command set the checks ran (or the recorded pass covered),
   * so a verification setting or script changed while the confirmation waited is
   * caught at the last gate. Undefined when no command set could be resolved.
   */
  readonly commandIdentity?: string | undefined;
}

const checkedTrees = new Map<string, CommitPushCheckedTreeV1>();

/** Called when this attempt's checks passed (ran fresh or reused), with the tree they covered. */
export function noteCommitPushCheckedTreeV1(taskFolderPath: string, tree: CommitPushCheckedTreeV1 | undefined): void {
  if (tree === undefined) {
    checkedTrees.delete(taskFolderPath);
  } else {
    checkedTrees.set(taskFolderPath, tree);
  }
}

/** The tree this attempt's passing checks covered; undefined when the owner published over failing checks. */
export function commitPushCheckedTreeV1(taskFolderPath: string): CommitPushCheckedTreeV1 | undefined {
  return checkedTrees.get(taskFolderPath);
}

/** Forget anything left from an earlier attempt, before a new one starts. */
export function clearCommitPushStopStateV1(taskFolderPath: string): void {
  stops.delete(taskFolderPath);
  reusedChecks.delete(taskFolderPath);
  checkedTrees.delete(taskFolderPath);
}
