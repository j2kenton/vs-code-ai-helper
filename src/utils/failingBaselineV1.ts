/**
 * bugs3 Step 15: the last failing check run, kept so Fix Linting & Code Errors
 * does not spend a full run reproducing it.
 *
 * Reported 2026-10-27 (bugs2, Publish): the deterministic autofix changed no
 * file and the tree matched the failing Publish Checks run from half an hour
 * earlier, yet a full `pnpm run verify` ran before the AI pass and printed the
 * same 76 failures. A recorded failing result is reusable only when everything
 * that could change the outcome is provably the same: the commit, the
 * verification-relevant working-tree fingerprint, the verification scope and
 * the effective command identity. Anything missing or different, including a
 * record written before one of those existed, means a fresh run, with the
 * reason said.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { CompletionLintResult } from "./completionLint";
import { computeCommandIdentityV1 } from "./publishChecksFreshness";

export const FAILING_BASELINE_FILENAME_V1 = "last-failing-checks-v1.json";
const FORMAT_VERSION = 1 as const;
/** Per-check output kept in the record: the head and tail are what a fix round reads. */
const RECORDED_OUTPUT_MAX_CHARS = 24_000;

export interface FailingBaselineRecordV1 {
  readonly formatVersion: 1;
  readonly recordedAt: string;
  readonly headCommit: string;
  readonly treeFingerprint: string;
  readonly scopeId: string;
  /** Digest of the ordered commands the failing run executed. */
  readonly commandIdentity: string;
  readonly commandsRun: readonly string[];
  /** The explicit Publish verification commands setting when the run happened (empty: default selection). */
  readonly configuredCommands: readonly string[];
  readonly summary: string;
  readonly issueCount: number;
  readonly verifiedFolder?: string;
  readonly rawReportLocation?: string;
  readonly failedChecks: CompletionLintResult["failedChecks"];
}

function baselinePath(taskFolderPath: string): string {
  return path.join(taskFolderPath, "runs", FAILING_BASELINE_FILENAME_V1);
}

function clipOutput(output: string): string {
  if (output.length <= RECORDED_OUTPUT_MAX_CHARS) {
    return output;
  }
  const half = Math.floor(RECORDED_OUTPUT_MAX_CHARS / 2);
  return `${output.slice(0, half)}\n… ${output.length - RECORDED_OUTPUT_MAX_CHARS} characters left out …\n${output.slice(output.length - half)}`;
}

/**
 * The record for a failing run, or undefined when the run cannot support one: it
 * passed, it listed no executed commands (no identity), or any of commit,
 * fingerprint and scope is unknown or changed while the run was in progress.
 */
export function buildFailingBaselineRecordV1(input: {
  readonly result: CompletionLintResult;
  readonly headBefore: string | undefined;
  readonly headAfter: string | undefined;
  readonly fingerprintBefore: string | undefined;
  readonly fingerprintAfter: string | undefined;
  readonly scopeId: string;
  readonly configuredCommands: readonly string[];
  readonly now?: () => Date;
}): FailingBaselineRecordV1 | undefined {
  const { result } = input;
  if (result.passed || result.failedChecks.length === 0) {
    return undefined;
  }
  const commandIdentity = computeCommandIdentityV1(result.commandsRun);
  if (
    commandIdentity === undefined ||
    !input.headBefore ||
    input.headBefore !== input.headAfter ||
    !input.fingerprintBefore ||
    input.fingerprintBefore !== input.fingerprintAfter
  ) {
    return undefined;
  }
  return {
    formatVersion: FORMAT_VERSION,
    recordedAt: (input.now?.() ?? new Date()).toISOString(),
    headCommit: input.headBefore,
    treeFingerprint: input.fingerprintBefore,
    scopeId: input.scopeId,
    commandIdentity,
    commandsRun: [...(result.commandsRun ?? [])],
    configuredCommands: [...input.configuredCommands],
    summary: result.summary,
    issueCount: result.issueCount,
    ...(result.verifiedFolder !== undefined ? { verifiedFolder: result.verifiedFolder } : {}),
    ...(result.rawReportLocation !== undefined ? { rawReportLocation: result.rawReportLocation } : {}),
    failedChecks: result.failedChecks.map((check) => ({ ...check, output: clipOutput(check.output) })),
  };
}

export async function writeFailingBaselineV1(taskFolderPath: string, record: FailingBaselineRecordV1): Promise<void> {
  const target = baselinePath(taskFolderPath);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.promises.writeFile(temporary, JSON.stringify(record), "utf8");
  await fs.promises.rename(temporary, target);
}

export async function clearFailingBaselineV1(taskFolderPath: string): Promise<void> {
  await fs.promises.rm(baselinePath(taskFolderPath), { force: true });
}

/** The recorded baseline, or undefined when absent, unreadable or of another format. */
export async function readFailingBaselineV1(taskFolderPath: string): Promise<FailingBaselineRecordV1 | undefined> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(baselinePath(taskFolderPath), "utf8")) as Partial<FailingBaselineRecordV1>;
    if (
      parsed.formatVersion !== FORMAT_VERSION ||
      typeof parsed.headCommit !== "string" ||
      typeof parsed.treeFingerprint !== "string" ||
      typeof parsed.scopeId !== "string" ||
      !Array.isArray(parsed.failedChecks) ||
      !Array.isArray(parsed.commandsRun)
    ) {
      return undefined;
    }
    return parsed as FailingBaselineRecordV1;
  } catch {
    return undefined;
  }
}

export type FailingBaselineReuseV1 =
  | { readonly reuse: true; readonly record: FailingBaselineRecordV1 }
  | { readonly reuse: false; readonly reason: string };

/**
 * May the recorded failing run stand in for a fresh one before the AI pass?
 * `current` is read at this moment; every field must match the record's. The
 * deterministic autofix must also have saved no file (a changed tree would
 * fail the fingerprint anyway; this is the explicit second guard).
 */
export function decideFailingBaselineReuseV1(input: {
  readonly record: FailingBaselineRecordV1 | undefined;
  readonly current: {
    readonly headCommit: string | undefined;
    readonly treeFingerprint: string | undefined;
    readonly scopeId: string;
    /** The explicit Publish verification commands setting right now. */
    readonly configuredCommands: readonly string[];
  };
  readonly deterministicEdits: number;
}): FailingBaselineReuseV1 {
  const { record, current } = input;
  if (record === undefined) {
    return { reuse: false, reason: "no failing check result was recorded for this task, so the checks run fresh" };
  }
  if (input.deterministicEdits > 0) {
    return { reuse: false, reason: "the automatic fixes changed files, so the earlier failing result no longer describes the tree" };
  }
  if (!current.headCommit || current.headCommit !== record.headCommit) {
    return { reuse: false, reason: "the commit changed since the failing run" };
  }
  if (!current.treeFingerprint || current.treeFingerprint !== record.treeFingerprint) {
    return { reuse: false, reason: "files changed since the failing run" };
  }
  if (current.scopeId !== record.scopeId) {
    return { reuse: false, reason: "the verification scope is different from the failing run's" };
  }
  // A record written before the configured commands were kept has no setting to
  // compare, so it cannot show the command set is unchanged (a legacy record).
  const recordedConfigured: readonly string[] | undefined = Array.isArray(record.configuredCommands)
    ? record.configuredCommands
    : undefined;
  if (recordedConfigured === undefined) {
    return { reuse: false, reason: "the recorded failing run predates command identity, so the commands it ran cannot be confirmed" };
  }
  if (
    computeCommandIdentityV1(recordedConfigured) !== computeCommandIdentityV1(current.configuredCommands) ||
    recordedConfigured.length !== current.configuredCommands.length
  ) {
    return { reuse: false, reason: "the Publish verification commands setting differs from the failing run's" };
  }
  if (computeCommandIdentityV1(record.commandsRun) !== record.commandIdentity) {
    return { reuse: false, reason: "the recorded command identity does not match the commands it lists" };
  }
  return { reuse: true, record };
}

/** A completion-lint result standing in for the fresh run the record replaces. */
export function completionLintResultFromBaselineV1(record: FailingBaselineRecordV1): CompletionLintResult {
  return {
    runAt: record.recordedAt,
    passed: false,
    summary: `${record.summary} (recorded ${record.recordedAt}; the tree is unchanged since, so the checks were not run again)`,
    issueCount: record.issueCount,
    failedChecks: record.failedChecks.map((check) => ({ ...check })),
    missingScripts: [],
    commandsRun: [...record.commandsRun],
    ...(record.verifiedFolder !== undefined ? { verifiedFolder: record.verifiedFolder } : {}),
    ...(record.rawReportLocation !== undefined ? { rawReportLocation: record.rawReportLocation } : {}),
  } as CompletionLintResult;
}
