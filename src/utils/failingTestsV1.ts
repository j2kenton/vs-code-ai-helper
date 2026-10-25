/**
 * Failing-test identities for a failed check, extracted from the COMPLETE
 * output before any truncation (post-1.0 fixes, item 13).
 *
 * Why: `pnpm run verify` printed 39 failing tests, but the report embeds only
 * the head and tail of a long output ("… truncated 4036 characters …"), so
 * only the last two failures were visible and both the fix model and the owner
 * took them for the whole problem. The list below is built from the untruncated
 * text, carried at the top of the stored output, and rendered in full wherever
 * the output is shown (publish-review.md, the fix prompt).
 *
 * Understands the `node --test` spec and TAP reporters, the two this project's
 * suite emits. Nothing else is guessed at: output with no recognised failing
 * test yields an empty summary and the caller keeps today's behaviour.
 */

export interface FailingTestV1 {
  /** Test file as the runner printed it (e.g. `out/test/foo.test.js`), when known. */
  readonly file?: string;
  readonly title: string;
}

export interface FailingTestSummaryV1 {
  /** The runner's own failure count when it printed one and it exceeds the list, else the list length. */
  readonly total: number;
  readonly tests: readonly FailingTestV1[];
}

/** First line of the index block; `splitFailingTestIndexV1` keys on it. */
export const FAILING_TEST_INDEX_MARKER_V1 = "Failing tests (";
/** Last line of the index block, so the raw output after it can be split off again. */
export const FAILING_TEST_INDEX_END_V1 = "--- raw output (truncated; the list above was extracted from the complete output) ---";

/**
 * Upper bound for the rendered list. The list is stored in `task-progress.json`
 * (which is re-read on every stage transition), so it cannot be unbounded; this
 * is room for a few hundred failures, and a list that still does not fit says
 * how many entries were left out.
 */
export const FAILING_TEST_INDEX_MAX_CHARS_V1 = 24_000;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;
const SPEC_FAIL_LINE_RE = /^(\s*)✖\s+(.+?)(?:\s+\((?:\d+(?:\.\d+)?)ms\))?\s*$/;
const SPEC_ANY_TEST_LINE_RE = /^(\s*)[✔✖▶ℹ﹣✓✗]\s+/;
const SPEC_FAILING_SECTION_RE = /^\s*✖\s+failing tests:\s*$/;
const SPEC_TEST_AT_RE = /^\s*test at\s+(.+?):(\d+):(\d+)\s*$/;
const SUMMARY_FAIL_RE = /^(?:ℹ|#)\s+fail\s+(\d+)\s*$/;
const TAP_NOT_OK_RE = /^(\s*)not ok\s+\d+\s+-\s+(.+?)\s*$/;

function cleanFile(raw: string): string {
  return raw.replace(/^file:\/\//, "").trim();
}

function dedupe(tests: FailingTestV1[]): FailingTestV1[] {
  const seen = new Set<string>();
  const result: FailingTestV1[] = [];
  for (const test of tests) {
    const key = `${test.file ?? ""}\u0000${test.title}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(test);
    }
  }
  return result;
}

function extractFromSpecFailingSection(lines: readonly string[], sectionStart: number): FailingTestV1[] {
  const tests: FailingTestV1[] = [];
  let pendingFile: string | undefined;
  for (let index = sectionStart + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }
    const at = SPEC_TEST_AT_RE.exec(line);
    if (at && at[1]) {
      pendingFile = cleanFile(at[1]);
      continue;
    }
    const fail = SPEC_FAIL_LINE_RE.exec(line);
    // The section's own entries start at the left margin; the error text
    // below each one is indented.
    if (fail && fail[1] !== undefined && fail[1].length === 0 && fail[2]) {
      tests.push({ ...(pendingFile ? { file: pendingFile } : {}), title: fail[2] });
      pendingFile = undefined;
    }
  }
  return tests;
}

function extractFromSpecStream(lines: readonly string[]): FailingTestV1[] {
  interface Entry {
    readonly indent: number;
    readonly title: string;
    readonly parent: boolean;
  }
  const entries: Entry[] = [];
  // For each ✖ line, the ✖ entries printed since the last test-like line at
  // the same or a shallower indent are its children — it is a suite whose
  // failure only reports that a child failed, not a failing test of its own.
  let childrenSinceShallowLine: Array<{ indent: number }> = [];
  for (const line of lines) {
    if (SPEC_FAILING_SECTION_RE.test(line)) {
      break;
    }
    const any = SPEC_ANY_TEST_LINE_RE.exec(line);
    if (!any || !any[1]) {
      continue;
    }
    const indent = any[1].length;
    const fail = SPEC_FAIL_LINE_RE.exec(line);
    const hasFailingChild = childrenSinceShallowLine.some((child) => child.indent > indent);
    childrenSinceShallowLine = childrenSinceShallowLine.filter((child) => child.indent > indent);
    if (fail && fail[2]) {
      entries.push({ indent, title: fail[2], parent: hasFailingChild });
      childrenSinceShallowLine.push({ indent });
    }
  }
  return entries.filter((entry) => !entry.parent).map((entry) => ({ title: entry.title }));
}

function extractFromTap(lines: readonly string[]): FailingTestV1[] {
  const tests: FailingTestV1[] = [];
  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index];
    if (rawLine === undefined) {
      continue;
    }
    const match = TAP_NOT_OK_RE.exec(rawLine);
    if (!match || !match[2]) {
      continue;
    }
    const title = match[2];
    if (/\s#\s+(?:SKIP|TODO)\b/i.test(title)) {
      continue;
    }
    let file: string | undefined;
    let parentSuite = false;
    for (let next = index + 1; next < lines.length; next++) {
      const yamlLine = lines[next];
      if (yamlLine === undefined) {
        continue;
      }
      if (/^\s*(?:not ok|ok)\s+\d+\s/.test(yamlLine) || /^\s*# Subtest:/.test(yamlLine)) {
        break;
      }
      const location = /^\s*location:\s*'?(.+?):(\d+):(\d+)'?\s*$/.exec(yamlLine);
      if (location && location[1]) {
        file = cleanFile(location[1]);
      }
      if (/failureType:\s*'?subtestsFailed'?/.test(yamlLine)) {
        parentSuite = true;
      }
    }
    if (!parentSuite) {
      tests.push({ ...(file ? { file } : {}), title });
    }
  }
  return tests;
}

/** Every failing test named in `output`, plus the total the runner reported. */
export function extractFailingTestsV1(output: string): FailingTestSummaryV1 {
  const lines = output.replace(ANSI_RE, "").split(/\r?\n/);
  const sectionStart = lines.findIndex((line) => SPEC_FAILING_SECTION_RE.test(line));
  let tests: FailingTestV1[];
  if (sectionStart >= 0) {
    tests = extractFromSpecFailingSection(lines, sectionStart);
  } else {
    tests = lines.some((line) => TAP_NOT_OK_RE.test(line)) ? extractFromTap(lines) : extractFromSpecStream(lines);
  }
  tests = dedupe(tests);
  let reported = 0;
  for (const line of lines) {
    const summary = SUMMARY_FAIL_RE.exec(line.trim());
    if (summary) {
      reported = Number(summary[1]);
    }
  }
  return { total: tests.length === 0 ? 0 : Math.max(tests.length, reported), tests };
}

/**
 * The index block: the total, then one line per failing test (file and title),
 * ending with {@link FAILING_TEST_INDEX_END_V1}. Empty string for no failures.
 */
export function renderFailingTestIndexV1(
  summary: FailingTestSummaryV1,
  options?: { readonly maxChars?: number; readonly rawReportLocation?: string }
): string {
  if (summary.tests.length === 0) {
    return "";
  }
  const maxChars = options?.maxChars;
  const rawLocation = options?.rawReportLocation ?? "runs/raw-check-output.log";
  const header =
    `${FAILING_TEST_INDEX_MARKER_V1}${summary.total}): every failing test named in the complete run output, ` +
    `listed before the output below is truncated (raw report located ${rawLocation}). Run these test files to reproduce and re-check them.`;
  const lines = [header];
  let used = header.length + FAILING_TEST_INDEX_END_V1.length + 80;
  let listed = 0;
  for (const test of summary.tests) {
    const line = `- ${test.file ? `${test.file}: ` : ""}${test.title}`;
    if (maxChars !== undefined && used + line.length + 1 > maxChars) {
      break;
    }
    lines.push(line);
    used += line.length + 1;
    listed++;
  }
  if (listed < summary.total) {
    lines.push(`- … and ${summary.total - listed} more not listed here (the total above is the runner's count).`);
  }
  lines.push(FAILING_TEST_INDEX_END_V1);
  return lines.join("\n");
}

/**
 * Splits stored output into its failing-test index (if it starts with one) and
 * the raw remainder, so a renderer can keep the whole index while it truncates
 * only the remainder.
 */
export function splitFailingTestIndexV1(output: string): { readonly index: string; readonly rest: string } {
  if (!output.startsWith(FAILING_TEST_INDEX_MARKER_V1)) {
    return { index: "", rest: output };
  }
  const endAt = output.indexOf(FAILING_TEST_INDEX_END_V1);
  if (endAt < 0) {
    return { index: "", rest: output };
  }
  const end = endAt + FAILING_TEST_INDEX_END_V1.length;
  return { index: output.slice(0, end), rest: output.slice(end).replace(/^\r?\n/, "") };
}

/**
 * Stored form of a failed check's output: the failing-test index (extracted
 * from the complete text) followed by the head-and-tail truncation of the raw
 * output. Output with no recognised failing test is truncated exactly as before.
 */
export function composeCheckFailureOutputV1(
  output: string,
  maxChars: number,
  truncate: (text: string, max: number) => string,
  options?: { readonly rawReportLocation?: string }
): string {
  const index = renderFailingTestIndexV1(extractFailingTestsV1(output), options);
  if (index === "") {
    return truncate(output, maxChars);
  }
  return `${index}\n${truncate(output, maxChars)}`;
}

/**
 * Display form: the index in full, then the raw remainder cut to `maxChars`.
 * Output without an index is truncated as before.
 */
export function truncateKeepingFailingTestIndexV1(
  output: string,
  maxChars: number,
  truncate: (text: string, max: number) => string
): string {
  const { index, rest } = splitFailingTestIndexV1(output);
  if (index === "") {
    return truncate(output, maxChars);
  }
  return `${index}\n${truncate(rest, maxChars)}`;
}
