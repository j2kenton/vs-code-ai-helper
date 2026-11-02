/**
 * bugs5 Step 16: the plain-words failure line for a Publish Checks run that did not pass.
 *
 * It names what failed (the failing tests per package, or the failing checks when no test was
 * recognised) and points at the fix round. It does not suggest Publish Anyway: that stays
 * reachable from Commit & Push, as an alternative that is not recommended.
 */
import type { FailingTestSummaryV1 } from "./failingTestsV1";
import { FAILING_TEST_INDEX_MARKER_V1, splitFailingTestIndexV1 } from "./failingTestsV1";
import type { PublishChecksOutcomeV1 } from "./publishChecksOutcomeV1";

export const PUBLISH_CHECKS_FIX_ACTION_LABEL_V1 = "Fix Linting & Code Errors";

/** Both a fresh result (with `failingTests`) and the persisted `lintPayload` (output only) fit. */
interface FailedCheckV1 {
  readonly command: string;
  readonly output?: string;
  readonly failingTests?: FailingTestSummaryV1;
}

const INDEX_FILE_LINE_RE = /^- (\S+\.(?:[cm]?[jt]sx?)): /;

/**
 * The persisted payload drops `failingTests` but keeps the failing-test index at the top of each
 * check's stored output; read the total and the per-file lines back from it.
 */
function failingTestsOfV1(check: FailedCheckV1): FailingTestSummaryV1 | undefined {
  if (check.failingTests !== undefined) {
    return check.failingTests;
  }
  const { index } = splitFailingTestIndexV1(check.output ?? "");
  if (index === "") {
    return undefined;
  }
  const total = Number(new RegExp(`^${FAILING_TEST_INDEX_MARKER_V1.replace("(", "\\(")}(\\d+)\\)`).exec(index)?.[1]);
  const tests = index
    .split(/\r?\n/)
    .filter((line) => line.startsWith("- ") && !line.startsWith("- …"))
    .map((line) => {
      const file = INDEX_FILE_LINE_RE.exec(line)?.[1];
      return { ...(file !== undefined ? { file } : {}), title: line.slice(2) };
    });
  return { total: Number.isFinite(total) && total >= tests.length ? total : tests.length, tests };
}

/** `packages/<name>/...` names its package; any other test file belongs to the root project. */
function packageLabelForTestFileV1(file: string | undefined): string | undefined {
  if (file === undefined) {
    return undefined;
  }
  const match = /(?:^|[\\/])packages[\\/]([^\\/]+)[\\/]/.exec(file.replace(/^\.[\\/]/, ""));
  return match ? match[1] : "unit tests";
}

/** A short, owner-readable name for a check command ("pnpm run lint" becomes "lint"). */
function shortCheckNameV1(command: string): string {
  const trimmed = command.trim();
  const stripped = trimmed.replace(/^(?:pnpm|npm|yarn)\s+(?:--[^\s]+\s+(?:'[^']*'|"[^"]*"|\S+)\s+)*(?:run\s+)?/, "");
  return stripped.length > 0 ? stripped : trimmed;
}

/** Failing-test counts per package for one failed check, in first-seen order. */
function countFailingTestsByPackageV1(check: FailedCheckV1): Map<string, number> {
  const counts = new Map<string, number>();
  const summary = failingTestsOfV1(check);
  if (summary === undefined || summary.total <= 0) {
    return counts;
  }
  for (const test of summary.tests) {
    const label = packageLabelForTestFileV1(test.file) ?? shortCheckNameV1(check.command);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const listed = summary.tests.length;
  if (summary.total > listed) {
    const label = shortCheckNameV1(check.command);
    counts.set(label, (counts.get(label) ?? 0) + (summary.total - listed));
  }
  return counts;
}

/**
 * "Publish Checks failed: 6 tests (5 in unit tests, 1 in ensemble-core). Recommended: Fix Linting &
 * Code Errors." Checks that failed without a recognised failing test are named after the tests,
 * for example "Publish Checks failed: lint, check-types."
 */
export function describePublishChecksFailureV1(
  lintPayload: { readonly failedChecks?: readonly FailedCheckV1[] } | undefined,
  options?: { readonly recommendation?: boolean }
): string {
  const failed = lintPayload?.failedChecks ?? [];
  const perPackage = new Map<string, number>();
  const otherChecks: string[] = [];
  for (const check of failed) {
    const counts = countFailingTestsByPackageV1(check);
    if (counts.size === 0) {
      const name = shortCheckNameV1(check.command);
      if (!otherChecks.includes(name)) {
        otherChecks.push(name);
      }
      continue;
    }
    for (const [label, count] of counts) {
      perPackage.set(label, (perPackage.get(label) ?? 0) + count);
    }
  }
  const parts: string[] = [];
  const testTotal = [...perPackage.values()].reduce((sum, count) => sum + count, 0);
  if (testTotal > 0) {
    const breakdown = [...perPackage.entries()].map(([label, count]) => `${count} in ${label}`).join(", ");
    parts.push(`${testTotal} ${testTotal === 1 ? "test" : "tests"} (${breakdown})`);
  }
  if (otherChecks.length > 0) {
    parts.push(otherChecks.join(", "));
  }
  const what = parts.length > 0 ? `: ${parts.join("; ")}` : "";
  const recommendation =
    options?.recommendation === false ? "" : ` Recommended: ${PUBLISH_CHECKS_FIX_ACTION_LABEL_V1}.`;
  return `Publish Checks failed${what}.${recommendation}`;
}

function clockV1(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * Why Fix Linting & Code Errors has no saved checks report to work from, in plain words. "Have not
 * run yet" is said only when no run has happened at all; once a run has happened, the line says
 * what became of it.
 */
export function describeNoUsableChecksResultV1(record: PublishChecksOutcomeV1 | undefined): string {
  if (record === undefined) {
    return "Publish Checks have not run yet. Run them first.";
  }
  const earlier =
    record.outcome === "cancelled" || record.outcome === "interrupted" || record.outcome === "running"
      ? record.lastCompleted
      : undefined;
  const earlierNote =
    earlier === undefined
      ? ""
      : `, and the earlier run (${earlier.outcome} at ${clockV1(earlier.at)}) has no report saved for this code`;
  switch (record.outcome) {
    case "running":
      return `Publish Checks are still running (started ${clockV1(record.at)}). Fix Linting & Code Errors works from their result, so wait for them to finish.`;
    case "cancelled":
      return `The last Publish Checks run was cancelled at ${clockV1(record.at)} (${record.cause})${earlierNote}. Run Publish Checks again.`;
    case "interrupted":
      return `The last Publish Checks run was interrupted at ${clockV1(record.at)} before it finished${earlierNote}. Run Publish Checks again.`;
    case "failed":
      return `Publish Checks failed at ${clockV1(record.at)}, but the failure report is no longer saved for this task. Run Publish Checks again.`;
    case "passed":
      return `Publish Checks passed at ${clockV1(record.at)}, so there is nothing to fix.`;
  }
}

/**
 * bugs5 Step 17: why the Publish review cannot start when the freshness stamp is missing but a
 * run record exists. "Have not been run yet" is the caller's wording for NO record only; here the run
 * happened, and the line says what became of it, including the files that changed while it ran.
 * `undefined` when there is no record (the caller keeps its "never ran" wording).
 */
export function describeChecksNotCountedForReviewV1(record: PublishChecksOutcomeV1 | undefined): string | undefined {
  if (record === undefined) {
    return undefined;
  }
  const again = "Run Publish Checks again before requesting a Publish review.";
  switch (record.outcome) {
    case "passed": {
      const changed = record.changedDuringRun ?? [];
      if (changed.length > 0) {
        const shown = changed.slice(0, 5).join(", ");
        const more = changed.length > 5 ? ` and ${changed.length - 5} more` : "";
        return (
          `Publish Checks passed at ${clockV1(record.at)}, but these files changed while they ran: ${shown}${more}. ` +
          `The pass does not cover the change. ${again}`
        );
      }
      return (
        `Publish Checks passed at ${clockV1(record.at)}, but the run could not be tied to one unchanged commit and tree ` +
        `(the commit or the files moved while it ran), so the pass does not count. ${again}`
      );
    }
    case "failed":
      return `Publish Checks failed at ${clockV1(record.at)}, so there is no passing run to review. Fix Linting & Code Errors, then run the checks again.`;
    case "running":
      return `Publish Checks are still running (started ${clockV1(record.at)}). The Publish review can start once they pass.`;
    case "cancelled":
      return `The last Publish Checks run was cancelled at ${clockV1(record.at)} (${record.cause}) and no earlier pass is recorded for this code. ${again}`;
    case "interrupted":
      return `The last Publish Checks run was interrupted at ${clockV1(record.at)} before it finished and no earlier pass is recorded for this code. ${again}`;
  }
}
