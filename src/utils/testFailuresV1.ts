/**
 * review1 Step 51: "Run Publish Checks now" on the stop card for a blocker about failing tests. The run's failing
 * tests (name, assertion, file and line) are parsed from the complete output and given to the next round as
 * `{{testFailures}}`, so a round fixes the tests it can see failing instead of guessing at them.
 *
 * Reuses the failing-test extraction the Publish fix prompt already uses (`failingTestsV1.ts`) and adds the line a
 * failure points at. Pure parsing and formatting plus a small file helper; no `vscode`.
 */
import * as fs from "fs/promises";
import * as path from "path";
import { extractFailingTestsV1, type FailingTestSummaryV1 } from "./failingTestsV1";

export const RUN_PUBLISH_CHECKS_NOW_COMMAND_V1 = "vs-code-ai-helper.runPublishChecksNowV1";
/** Task-folder-relative file the latest failures are saved to; the apply prompt reads it. */
export const TEST_FAILURES_FILE_V1 = "evidence/test-failures.md";
export const TEST_FAILURES_MAX_LISTED_V1 = 30;
const ASSERTION_MAX_CHARS = 300;

export interface TestFailureV1 {
  readonly name: string;
  readonly file?: string;
  readonly line?: number;
  readonly assertion?: string;
  /**
   * bugs7 review: the failure's complete message and the stack frames printed around it, before the shortened
   * `assertion` is cut. Used only to tell which of the task's changed files a failure names; never shown or saved.
   */
  readonly detail?: string;
}

const DETAIL_WINDOW_CHARS = 3000;

/** The raw output from where the test (by title, else by file) first appears: its full message and stack. */
function failureDetailWindow(
  rawOutput: string,
  title: string,
  file: string | undefined,
  fullAssertion: string | undefined,
  otherTitles: readonly string[]
): string | undefined {
  let at = title !== "" ? rawOutput.indexOf(title) : -1;
  if (at < 0 && file) at = rawOutput.indexOf(path.basename(file.replace(/\\/g, "/")));
  let end = at >= 0 ? at + DETAIL_WINDOW_CHARS : 0;
  // The window stops where another failing test starts, so one test is never charged with its neighbour's stack.
  for (const other of otherTitles) {
    if (other === "" || other === title || at < 0) continue;
    const next = rawOutput.indexOf(other, at + title.length);
    if (next >= 0 && next < end) end = next;
  }
  const window = at >= 0 ? rawOutput.slice(at, end) : "";
  const detail = [fullAssertion ?? "", window].filter((part) => part !== "").join("\n");
  return detail === "" ? undefined : detail;
}

/** A blocker about tests that fail (not about tests missing, not run, or not yet written). */
export function isFailingTestsBlockerV1(description: string): boolean {
  const text = description.replace(/\s+/g, " ");
  if (/\b(?:no|missing|not yet written|never ran|not run)\b[^.]{0,30}\btests?\b/i.test(text) && !/\bfail/i.test(text)) return false;
  return (
    /\b(?:tests?|test suites?|suites?|specs?|assertions?)\b[^.;]{0,80}\b(?:fail(?:s|ed|ing|ure|ures)?|red|broken|do(?:es)? not pass|don't pass)\b/i.test(text) ||
    /\b(?:fail(?:s|ed|ing|ure|ures)?|broken)\b[^.;]{0,40}\b(?:tests?|test suites?|specs?)\b/i.test(text)
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The first `file:line` the output prints for a test file (basename match, since runners print it variously). */
function lineForFile(file: string, rawOutput: string): number | undefined {
  const base = path.basename(file.replace(/\\/g, "/"));
  const match = new RegExp(`${escapeRegExp(base)}:(\\d+)(?::\\d+)?`).exec(rawOutput);
  return match ? Number(match[1]) : undefined;
}

/** Failing tests from one failed check's complete output: name, assertion (per file), file and line. */
export function buildTestFailuresV1(
  rawOutput: string,
  summary: FailingTestSummaryV1 = extractFailingTestsV1(rawOutput),
  max = TEST_FAILURES_MAX_LISTED_V1
): TestFailureV1[] {
  const assertionByFile = new Map<string, string>();
  const fullAssertionByFile = new Map<string, string>();
  for (const cluster of summary.clusters ?? []) {
    if (cluster.assertion) {
      const flat = cluster.assertion.replace(/\s+/g, " ").trim();
      assertionByFile.set(cluster.file, flat.slice(0, ASSERTION_MAX_CHARS));
      fullAssertionByFile.set(cluster.file, flat);
    }
  }
  const failures: TestFailureV1[] = [];
  const seen = new Set<string>();
  for (const test of summary.tests) {
    const key = `${test.file ?? ""}\u0000${test.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const line = test.file ? lineForFile(test.file, rawOutput) : undefined;
    const assertion = test.file ? assertionByFile.get(test.file) : undefined;
    const detail = failureDetailWindow(rawOutput, test.title, test.file, test.file ? fullAssertionByFile.get(test.file) : undefined, summary.tests.map((t) => t.title));
    failures.push({
      name: test.title,
      ...(test.file ? { file: test.file } : {}),
      ...(line !== undefined ? { line } : {}),
      ...(assertion ? { assertion } : {}),
      ...(detail !== undefined ? { detail } : {}),
    });
    if (failures.length >= max) break;
  }
  return failures;
}

/** The block `{{testFailures}}` is filled with: what ran, when, and each failure. */
export function formatTestFailuresV1(
  failures: readonly TestFailureV1[],
  context: { readonly runAt: string; readonly command?: string; readonly total?: number }
): string {
  if (failures.length === 0) return "";
  const total = Math.max(context.total ?? failures.length, failures.length);
  const lines = [
    `Failing tests from the Publish Checks run at ${context.runAt}${context.command ? ` (\`${context.command}\`)` : ""}: ${total} failing. ` +
      "They were read from the run's complete output and may be out of date for any file edited since.",
    ...failures.map((failure) => {
      const where = failure.file ? ` — ${failure.file}${failure.line !== undefined ? `:${failure.line}` : ""}` : "";
      const assertion = failure.assertion ? `\n  assertion: ${failure.assertion}` : "";
      return `- ${failure.name}${where}${assertion}`;
    }),
  ];
  if (total > failures.length) lines.push(`- … and ${total - failures.length} more not listed here.`);
  return lines.join("\n");
}

/** Saves the formatted failures for the next round, or removes the file when the run had none. */
export async function writeTestFailuresFileV1(taskFolderPath: string, formatted: string): Promise<void> {
  const target = path.join(taskFolderPath, ...TEST_FAILURES_FILE_V1.split("/"));
  if (formatted.trim().length === 0) {
    await fs.rm(target, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${formatted}\n`);
}

/**
 * What the apply prompt's `{{testFailures}}` holds: the saved failures under a heading, or an empty string when
 * no Publish Checks run has recorded any (the prompt then carries nothing for it).
 */
export async function readTestFailuresForPromptV1(taskFolderPath: string): Promise<string> {
  try {
    const text = (await fs.readFile(path.join(taskFolderPath, ...TEST_FAILURES_FILE_V1.split("/")), "utf8")).trim();
    return text.length > 0 ? `## Failing tests (from Publish Checks)\n\n${text}\n` : "";
  } catch {
    return "";
  }
}
