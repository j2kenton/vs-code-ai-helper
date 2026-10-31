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
import { createHash } from "node:crypto";

export interface FailingTestV1 {
  /** Test file as the runner printed it (e.g. `out/test/foo.test.js`), when known. */
  readonly file?: string;
  readonly title: string;
}

export interface FailingTestSummaryV1 {
  /** The runner's own failure count when it printed one and it exceeds the list, else the list length. */
  readonly total: number;
  readonly tests: readonly FailingTestV1[];
  /**
   * True only when the output ended with the runner's own closing summary
   * (`tests`, `pass` and `fail` counts, nothing cancelled), so every test it
   * started was executed. Output cut short by a crash, timeout or abort can
   * still list the failures printed so far, but the tests after that point
   * never ran: absence from such a list is not a pass. Absent means unknown.
   */
  readonly runCompleted?: boolean;
  /**
   * How many runner closing summaries the output held (an aggregate command such
   * as `verify` prints one per test runner it reached), and the tests they
   * counted in all. `runCompleted` says some runner finished; these say how many
   * did and how much they ran, so a re-run that stopped before a later runner, or
   * ran a reduced test script under the same command, is not read as having fixed
   * the tests it never executed. Absent when the output held no closing summary.
   */
  readonly closingSummaries?: number;
  readonly testsExecuted?: number;
  /**
   * A fingerprint of WHICH tests the output shows as executed (every passing and
   * failing test title, not their results; skipped tests did not execute). Equal counts do not show
   * that the same tests ran; equal fingerprints do. Absent when the output held no
   * recognisable test lines, or from an older record.
   */
  readonly executedDigest?: string;
  /**
   * The failures grouped by test file, largest group first, each with one full
   * assertion message, extracted from the complete output so the fix prompt can
   * show the cause of the biggest cluster. Absent when no test was recognised.
   */
  readonly clusters?: readonly FailingTestClusterV1[];
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
const SUMMARY_COUNT_RE = /^(?:ℹ|#)\s+(tests|pass|fail|cancelled)\s+(\d+)\s*$/;
const TAP_NOT_OK_RE = /^(\s*)not ok\s+\d+\s+-\s+(.+?)\s*$/;

const TAP_SUBTEST_RE = /^(\s*)#\s+Subtest:\s+(.+?)\s*$/;
const SPEC_SUITE_OPEN_RE = /^(\s*)▶\s+(.+?)\s*$/;
const SPEC_EXECUTED_LINE_RE = /^\s*[✔✖﹣✓✗]\s+(.+?)(?:\s+\((?:\d+(?:\.\d+)?)ms\))?(?:\s+#\s+(?:SKIP|TODO).*)?\s*$/;
const TAP_EXECUTED_LINE_RE = /^\s*(?:not ok|ok)\s+\d+\s+-\s+(.+?)(?:\s+#\s+(?:SKIP|TODO).*)?\s*$/;

/**
 * Fingerprint of the set of test titles the output reports as executed, ignoring
 * results and durations so a test that now passes still counts as the same test.
 * Titles are compared as a sorted multiset because an aggregate runs several
 * runners whose order is not significant. Only the runs' own streams count: each
 * runner's repeated "failing tests:" section is skipped (not everything after
 * the first one, which would drop every later runner), and a skipped or todo test
 * is not counted, since a test that was skipped did not execute.
 */
function executedTestsDigest(lines: readonly string[]): string | undefined {
  const keys: string[] = [];
  let inFailingSection = false;
  // A section entry is introduced by its `test at` line; a left-margin ✖ without
  // one is the next runner's stream, not the section's.
  let entryAllowed = false;
  // A test's identity is its runner (the count of closing summaries before it),
  // its enclosing suites and its title, so a different test that happens to print
  // the same title elsewhere does not stand in for it. The output carries no
  // file for a passing test, so two same-titled tests in one suite of one runner
  // remain indistinguishable; the multiset still counts both.
  let runner = 0;
  let suites: Array<{ indent: number; title: string }> = [];
  for (const line of lines) {
    if (SPEC_FAILING_SECTION_RE.test(line)) {
      inFailingSection = true;
      entryAllowed = true;
      continue;
    }
    if (inFailingSection) {
      if (SPEC_TEST_AT_RE.test(line)) {
        entryAllowed = true;
        continue;
      }
      const entry = SPEC_FAIL_LINE_RE.exec(line);
      if (entry && entry[1] !== undefined && entry[1].length === 0 && entryAllowed) {
        entryAllowed = false;
        continue;
      }
      // The next runner's stream may be spec lines or TAP lines; either ends the section.
      if (!SPEC_ANY_TEST_LINE_RE.test(line) && !TAP_EXECUTED_LINE_RE.test(line) && !TAP_SUBTEST_RE.test(line)) {
        continue;
      }
      inFailingSection = false;
      suites = [];
    }
    const summary = SUMMARY_COUNT_RE.exec(line.trim());
    if (summary?.[1] === "tests") {
      runner += 1;
      suites = [];
      continue;
    }
    const subtest = TAP_SUBTEST_RE.exec(line);
    const opener = subtest ? undefined : SPEC_SUITE_OPEN_RE.exec(line);
    const suiteLine = subtest ?? opener;
    if (suiteLine?.[1] !== undefined && suiteLine[2]) {
      const indent = suiteLine[1].length;
      suites = suites.filter((suite) => suite.indent < indent);
      suites.push({ indent, title: suiteLine[2] });
      continue;
    }
    if (/^\s*﹣/.test(line) || /\s#\s+(?:SKIP|TODO)\b/i.test(line)) {
      continue;
    }
    const match = SPEC_EXECUTED_LINE_RE.exec(line) ?? TAP_EXECUTED_LINE_RE.exec(line);
    if (match?.[1]) {
      const indent = /^\s*/.exec(line)?.[0].length ?? 0;
      suites = suites.filter((suite) => suite.indent < indent);
      keys.push(`${runner}\u0000${suites.map((suite) => suite.title).join("\u0001")}\u0000${match[1]}`);
    }
  }
  if (keys.length === 0) {
    return undefined;
  }
  keys.sort();
  return createHash("sha256").update(keys.join("\n")).digest("hex").slice(0, 24);
}

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
  // One closing-summary block per runner invocation, opened by its `tests` line:
  // an aggregate command that runs several runners prints one for each. A run
  // counts as completed only when EVERY block it opened has its `pass` and `fail`
  // counts and cancelled nothing, so a later runner cut off after printing
  // `tests` is not hidden behind an earlier runner's complete block.
  const blocks: Array<{ tests: number; pass?: number; fail?: number; cancelled: number }> = [];
  for (const line of lines) {
    const summary = SUMMARY_FAIL_RE.exec(line.trim());
    if (summary) {
      reported = Number(summary[1]);
    }
    const count = SUMMARY_COUNT_RE.exec(line.trim());
    if (count && count[1] && count[2]) {
      const value = Number(count[2]);
      if (count[1] === "tests") {
        blocks.push({ tests: value, cancelled: 0 });
        continue;
      }
      const block = blocks[blocks.length - 1];
      if (block === undefined) {
        continue;
      }
      if (count[1] === "pass") {
        block.pass = value;
      } else if (count[1] === "fail") {
        block.fail = value;
      } else {
        block.cancelled += value;
      }
    }
  }
  const closingSummaries = blocks.length;
  const testsExecuted = blocks.reduce((sum, block) => sum + block.tests, 0);
  const runCompleted =
    blocks.length > 0 && blocks.every((block) => block.pass !== undefined && block.fail !== undefined && block.cancelled === 0);
  const executedDigest = executedTestsDigest(lines);
  const clusters =
    tests.length === 0
      ? []
      : clusterFailingTestsV1(tests, sectionStart >= 0 ? extractSpecAssertionMessages(lines, sectionStart) : new Map());
  return {
    total: tests.length === 0 ? 0 : Math.max(tests.length, reported),
    tests,
    ...(runCompleted ? { runCompleted: true } : {}),
    ...(closingSummaries > 0 ? { closingSummaries, testsExecuted } : {}),
    ...(executedDigest !== undefined ? { executedDigest } : {}),
    ...(clusters.length > 0 ? { clusters } : {}),
  };
}

/** One group of failing tests sharing a test file, with one complete assertion. */
export interface FailingTestClusterV1 {
  readonly file: string;
  readonly count: number;
  /** The first few failing test titles in the group. */
  readonly titles: readonly string[];
  /** One full assertion message from the group (bounded), when the output carried one. */
  readonly assertion?: string;
}

/**
 * Room in the fix prompt for the failing tests grouped by file, with their
 * assertions ({@link selectFailureClustersForPromptV1}'s budget).
 */
export const FAILURE_CLUSTER_PROMPT_MAX_CHARS_V1 = 70_000;
/**
 * Longest assertion kept per group: the whole prompt budget, so a group's cause is
 * kept whole whenever it can fit the prompt at all, whatever the group's rank. The
 * budget then decides how many groups are included. A message longer than the
 * prompt could ever carry is cut with a marker saying so. Clusters are in-memory
 * only; RETAINED_ASSERTION_TOTAL_MAX_CHARS bounds what one run keeps.
 */
const CLUSTER_ASSERTION_MAX_CHARS = FAILURE_CLUSTER_PROMPT_MAX_CHARS_V1;
/** Memory bound across every failing test's collected message in one run. */
const RETAINED_ASSERTION_TOTAL_MAX_CHARS = 8_000_000;
const CLUSTER_MAX_COUNT = 40;
/** How much of one assertion is read from the output: more than the cap, so a cut is always marked. */
const ASSERTION_COLLECTION_MAX_CHARS = CLUSTER_ASSERTION_MAX_CHARS + 2000;
const CLUSTER_TITLES_PER_GROUP = 3;
/** How many group members' messages are considered when choosing the one to show whole. */
const CLUSTER_ASSERTION_CANDIDATES = 25;
const UNKNOWN_FILE_LABEL = "(test file not reported)";

/**
 * The assertion message printed under each entry of the spec reporter's
 * `failing tests:` section, keyed like {@link dedupe}. Collected up to the first
 * stack frame, so the message is whole but the stack is not.
 */
function extractSpecAssertionMessages(lines: readonly string[], sectionStart: number): Map<string, string> {
  const messages = new Map<string, string>();
  let pendingFile: string | undefined;
  let key: string | undefined;
  let collected: string[] = [];
  let collectedChars = 0;
  let retainedChars = 0;
  let inStack = false;
  const flush = (): void => {
    if (key !== undefined && collected.length > 0 && !messages.has(key) && retainedChars < RETAINED_ASSERTION_TOTAL_MAX_CHARS) {
      const message = collected.join("\n").trim();
      retainedChars += message.length;
      messages.set(key, message);
    }
    key = undefined;
    collected = [];
    collectedChars = 0;
    inStack = false;
  };
  for (let index = sectionStart + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }
    const at = SPEC_TEST_AT_RE.exec(line);
    if (at && at[1]) {
      flush();
      pendingFile = cleanFile(at[1]);
      continue;
    }
    const fail = SPEC_FAIL_LINE_RE.exec(line);
    if (fail && fail[1] !== undefined && fail[1].length === 0 && fail[2]) {
      flush();
      key = `${pendingFile ?? ""}\u0000${fail[2]}`;
      pendingFile = undefined;
      continue;
    }
    if (key === undefined || /^\s*ℹ\s/.test(line)) {
      continue;
    }
    if (/^\s+at\s/.test(line)) {
      inStack = true;
    }
    // Bounded by characters, not lines (a line cap cut a long assertion silently,
    // mid-diff): collection runs past the largest per-group cap, so any message
    // that exceeds the cap it is given is cut by `bound`, with its marker.
    if (!inStack && collectedChars < ASSERTION_COLLECTION_MAX_CHARS) {
      const text = line.replace(/^ {1,2}/, "");
      collected.push(text);
      collectedChars += text.length + 1;
    }
  }
  flush();
  return messages;
}

/**
 * Groups failing tests by file, largest group first, each with one complete
 * assertion message. Fifty failures with one cause read as one group with its
 * cause, instead of a name list that never shows it.
 */
function clusterFailingTestsV1(tests: readonly FailingTestV1[], messages: ReadonlyMap<string, string>): FailingTestClusterV1[] {
  const groups = new Map<string, { titles: string[]; count: number; assertions: string[] }>();
  for (const test of tests) {
    const file = test.file ?? UNKNOWN_FILE_LABEL;
    const group = groups.get(file) ?? { titles: [], count: 0, assertions: [] };
    group.count++;
    if (group.titles.length < CLUSTER_TITLES_PER_GROUP) {
      group.titles.push(test.title);
    }
    const message = messages.get(`${test.file ?? ""}\u0000${test.title}`);
    if (message !== undefined && message.length > 0 && group.assertions.length < CLUSTER_ASSERTION_CANDIDATES) {
      group.assertions.push(message);
    }
    groups.set(file, group);
  }
  // A cut assertion says so, rather than ending mid-line as if it were whole.
  const bound = (text: string, max: number): string =>
    text.length > max ? `${text.slice(0, max)}\n… (assertion cut at ${max} characters; the full message is in the raw check output)` : text;
  // The representative assertion is the first member of the group that fits the
  // group's cap WHOLE; only when every candidate is longer is the shortest one cut
  // (and marked). A group whose first failure happens to carry a long diff still
  // shows a complete message when a sibling's is short enough.
  const representative = (candidates: readonly string[], max: number): string | undefined => {
    if (candidates.length === 0) {
      return undefined;
    }
    const whole = candidates.find((candidate) => candidate.length <= max);
    if (whole !== undefined) {
      return whole;
    }
    const shortest = candidates.reduce((best, candidate) => (candidate.length < best.length ? candidate : best));
    return bound(shortest, max);
  };
  return [...groups.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, CLUSTER_MAX_COUNT)
    .map(([file, group]) => {
      const assertion = representative(group.assertions, CLUSTER_ASSERTION_MAX_CHARS);
      return {
        file,
        count: group.count,
        titles: group.titles,
        ...(assertion !== undefined ? { assertion } : {}),
      };
    });
}

/** What one group costs in the fix prompt: its file, titles and its whole assertion. */
function clusterPromptSize(cluster: FailingTestClusterV1): number {
  return cluster.file.length + (cluster.assertion?.length ?? 0) + cluster.titles.join("").length + 60;
}

/**
 * The groups to put in a fix prompt within `maxChars`. The largest group is
 * always kept (its cause explains the most failures), charged at its real size.
 * Every other group is kept only when it fits whole in what remains, so each
 * included group carries its complete assertion and the total stays within the
 * budget (the largest group alone can exceed it). A group that does not fit is
 * left out, a smaller one after it may still fit, and `omitted` counts them.
 */
export function selectFailureClustersForPromptV1(
  clusters: readonly FailingTestClusterV1[],
  maxChars: number
): { readonly clusters: readonly FailingTestClusterV1[]; readonly omitted: number } {
  const chosen: FailingTestClusterV1[] = [];
  let used = 0;
  for (const cluster of clusters) {
    const size = clusterPromptSize(cluster);
    if (chosen.length > 0 && used + size > maxChars) {
      continue;
    }
    chosen.push(cluster);
    used += size;
  }
  return { clusters: chosen, omitted: clusters.length - chosen.length };
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
