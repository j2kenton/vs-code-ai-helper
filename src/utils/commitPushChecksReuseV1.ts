/**
 * bugs3 Step 17: may Commit & Push use the passing Publish Checks result that is
 * already recorded, instead of running the full checks again?
 *
 * Reported 2026-10-27 (bugs2, Publish): the checks passed at 18:29 and the
 * owner chose Commit & Push at 18:30:49 on a tree unchanged since; Commit & Push
 * ran the whole `pnpm run verify` again (12 minutes) before it asked for
 * confirmation. A recorded pass is reusable only when everything that could
 * change its outcome is provably the same: the commit, the working-tree
 * fingerprint, the verification scope and the effective command set. Anything
 * missing, failing, stale, different or recorded before command identity
 * existed runs fresh, and the reason is said in plain words.
 */
import type * as vscode from "vscode";
import type { CompletionLintResult } from "./completionLint";
import { parseRecordedCompletionChecksEvidenceV1 } from "./completionLint";
import {
  checkPublishChecksReuseEligibilityV1,
  computeCommandIdentityV1,
  type PublishChecksReuseEligibilityResultV1,
} from "./publishChecksFreshness";

export type CommitPushChecksReuseV1 =
  | { readonly reuse: true; readonly result: CompletionLintResult; readonly message: string }
  | { readonly reuse: false; readonly reason: string };

export interface CommitPushChecksReuseInputV1 {
  readonly taskFolderUri: vscode.Uri;
  readonly scopeFolder: string;
  readonly headCommitSha: string | undefined;
  /** The commands a fresh run would execute now, or null when they cannot be determined. */
  readonly currentCommands: readonly string[] | null;
  /** Replaceable in tests; the real freshness and fingerprint check by default. */
  readonly checkEligibility?: typeof checkPublishChecksReuseEligibilityV1;
}

/** The recorded Completion Checks must exist and show a pass. */
function passingRecordOrUndefined(content: string): CompletionLintResult | undefined {
  const recorded = parseRecordedCompletionChecksEvidenceV1(content);
  return recorded !== undefined && recorded.passed === true && (recorded.failedChecks?.length ?? 0) === 0 ? recorded : undefined;
}

/** Plain words for why the recorded result cannot be used. */
export function describeReuseRefusalV1(eligibility: PublishChecksReuseEligibilityResultV1): string {
  const reason = eligibility.reason ?? "";
  const freshness = /^Freshness check failed: (\w+)/.exec(reason)?.[1];
  if (freshness === "missing") {
    return "no passing Publish Checks result is recorded for this task";
  }
  if (freshness === "unreadableHead") {
    return "the current commit could not be read, so a recorded result cannot be matched to it";
  }
  if (freshness === "staleCommit") {
    return "the commit changed since the Publish Checks passed";
  }
  if (freshness === "scopeMismatch") {
    return "the Publish Checks passed for a different verification scope";
  }
  if (/fingerprint has changed/i.test(reason)) {
    return "files changed since the Publish Checks passed";
  }
  if (/does not contain a tree fingerprint/i.test(reason)) {
    return "the recorded Publish Checks result does not say which files it covered";
  }
  if (/predate command identity|legacy/i.test(reason)) {
    return "the recorded Publish Checks result was written before the commands it ran were kept, so they cannot be confirmed";
  }
  if (/different command set/i.test(reason)) {
    return "the checks that would run now are not the ones that passed";
  }
  if (/evidence is missing, failed, or unreadable/i.test(reason)) {
    return "the recorded Completion Checks do not show a pass";
  }
  if (/stale/i.test(reason)) {
    return "the recorded Publish Checks result is stale";
  }
  return reason.length > 0 ? reason : "the recorded Publish Checks result could not be confirmed";
}

export async function decideCommitPushChecksReuseV1(input: CommitPushChecksReuseInputV1): Promise<CommitPushChecksReuseV1> {
  const expectedIdentity = input.currentCommands ? computeCommandIdentityV1(input.currentCommands) : undefined;
  if (expectedIdentity === undefined) {
    return { reuse: false, reason: "the commands the checks would run could not be determined, so a recorded result cannot be matched to them" };
  }
  const check = input.checkEligibility ?? checkPublishChecksReuseEligibilityV1;
  let eligibility: PublishChecksReuseEligibilityResultV1;
  let recorded: CompletionLintResult | undefined;
  try {
    eligibility = await check(
      input.taskFolderUri,
      input.scopeFolder,
      input.headCommitSha,
      (content) => {
        recorded = passingRecordOrUndefined(content);
        return recorded !== undefined;
      },
      expectedIdentity
    );
  } catch {
    return { reuse: false, reason: "the recorded Publish Checks result could not be read" };
  }
  if (!eligibility.eligible) {
    return { reuse: false, reason: describeReuseRefusalV1(eligibility) };
  }
  if (recorded === undefined) {
    return { reuse: false, reason: "the recorded Completion Checks do not show a pass" };
  }
  const completedAt = eligibility.stamp?.completedAt;
  return {
    reuse: true,
    result: recorded,
    message:
      `Using the Publish Checks result that passed${completedAt ? ` at ${completedAt}` : ""}: the commit, files, scope ` +
      "and commands are unchanged since, so the checks were not run again.",
  };
}
