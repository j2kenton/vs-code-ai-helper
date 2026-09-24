import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Pre-1.0.0 fixes register, Part 1 (item 15) — the "one door" proof.
 *
 * `enterStageV1` (`src/utils/stageTransition.ts`) is meant to be the ONLY
 * production path that ever changes a task's `currentStage`. This scan is
 * the source-level check that backs that claim: it enumerates every raw
 * `currentStage:` progress-shaped write and every call to one of the four
 * stage-mutating transforms in non-test `src/`, and fails unless each
 * offending occurrence sits at an explicitly allowlisted EXACT LINE, with a
 * reason.
 *
 * This reads the TypeScript SOURCES, not the compiled output — see
 * `operationCoverage.test.ts`'s identical rationale (it runs from
 * `out/test/`, so the repo root is two levels up).
 *
 * Line-exact, not file-level: a prior revision of this scan allowlisted
 * whole FILES, which meant a brand-new bare `currentStage:` write or a new
 * standalone transform call landing anywhere in an already-allowlisted file
 * (for example a second, unreviewed write added to `reviewActions.ts`) was
 * invisible to it. Every entry below instead names the one line it covers,
 * the same drift-prone-but-explicit convention `scripts/toastAllowlistV1.json`
 * already uses for toast call sites: a legitimate refactor that shifts an
 * allowlisted line is expected to surface as a mismatch here on the next
 * run — update the line number, do not delete or broaden the entry, unless
 * the write/call itself was removed. A match at any OTHER line — allowlisted
 * file or not — is a violation. The runtime backstop in `advanceStageLocked`
 * (a transition landing on "impl" with no entry work and no existing
 * artifact is refused) and the human-hand-off checks recorded in
 * `plan-final.md` remain the defense in depth for whatever this scan cannot
 * see (for example a write reached only through indirection this regex
 * cannot follow).
 *
 * Keyed by path RELATIVE TO `src/`, not by basename: `src/services/` and
 * `src/types/` both happen to contain a `taskProgressFieldPolicyV1.ts` (the
 * implementation and its documentation-only type mirror), so a basename key
 * would silently conflate the two — an allowlist entry meant for one would
 * spuriously flag the other as "stale" and could equally spuriously
 * whitelist an unreviewed match in the other.
 *
 * Matching runs against the WHOLE file (comment/string-aware, see
 * `stripCommentsPreservingLines` below), not line-by-line: a per-line pass
 * missed two real shapes reported by review. First, a write or call whose
 * tokens are split across lines — `currentStage\n  : "impl"` or
 * `applyReopenPolicyV1\n  (current, opts)` — never matched, because each
 * half sat on its own line and neither half alone satisfies the pattern.
 * Second, a naive `line.indexOf("//")` comment-stripper treated a `//`
 * INSIDE a string literal (for example a URL, `"see http://x"`) as a
 * comment start and discarded everything after it on that line, including a
 * real write that followed on the same line. `stripCommentsPreservingLines`
 * tracks string/template-literal state character by character so a `//`
 * inside a string is never mistaken for a comment, and runs the match
 * regexes over the full (newline-preserving) text so `\s*` naturally spans
 * a token split across lines. Line numbers are then recovered from the
 * match's character offset.
 *
 * A later review pass found the raw-write finder still recognized only the
 * bare, unquoted colon-form key (`currentStage: value`). Three further
 * ordinary TypeScript spellings of the same write were invisible to it: a
 * quoted object-literal key (`{ "currentStage": "impl" }`), a computed
 * object-literal key (`{ ["currentStage"]: "impl" }`), and a direct property
 * assignment (`progress.currentStage = "impl"`, including the bracketed form
 * `progress["currentStage"] = "impl"`). `findRawCurrentStageWriteLines` now
 * runs four patterns — the original bare-colon form plus these three — over
 * the same stripped, offset-tracked text and merges their hits into one
 * deduplicated, sorted line list. The computed-key-write pattern excludes a
 * `[` immediately preceded by an identifier character, which is what
 * distinguishes an object-literal computed key (preceded by `{`, `,`, or
 * whitespace) from a bracketed MEMBER READ followed by an unrelated colon,
 * e.g. a ternary's `cond ? obj["currentStage"] : fallback` — the bracketed
 * counterpart of the `(?<!\.)` guard already used for the dotted-read case.
 * The assignment patterns require a literal `=` not immediately followed by
 * another `=`, so `===`, `==` and `!==` comparisons are never mistaken for a
 * write.
 */
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SRC_DIR = path.join(REPO_ROOT, "src");

/**
 * Matches a `currentStage:` (or `currentStage?:`) token together with the
 * single whitespace-delimited token immediately following it, so a caller
 * can tell a type/interface field declaration (`currentStage: TaskStage`,
 * `currentStage?: string`) or a shorthand property read from an actual VALUE
 * write (`currentStage: "impl"`, `currentStage: next`). A capture group
 * (rather than a negative lookahead sitting after a greedy `\s*`) is used
 * deliberately: a lookahead there is defeated by backtracking, since the
 * engine can shrink `\s*` to width zero and let the trailing single-char
 * class consume the whitespace instead of ever testing the lookahead against
 * the real following token.
 *
 * `(?<!\.)` excludes a PROPERTY READ (`progress.currentStage`) immediately
 * followed by an unrelated colon later in the same expression — most often a
 * ternary's branch separator (`cond ? x.currentStage : fallback`), which
 * otherwise reads identically to an object-literal key/value pair.
 */
const RAW_CURRENT_STAGE_TOKEN = /(?<!\.)\bcurrentStage\??\s*:\s*(\S+)/g;

/** Same shape as {@link RAW_CURRENT_STAGE_TOKEN}, for a QUOTED object-literal key: `"currentStage": value` or `'currentStage': value`. */
const RAW_CURRENT_STAGE_TOKEN_QUOTED = /(?<!\.)["']currentStage["']\s*:\s*(\S+)/g;

/**
 * A COMPUTED object-literal key: `["currentStage"]: value`. The `(?<![\w$])`
 * guard requires the `[` not be immediately preceded by an identifier
 * character — an object-literal computed key is preceded by `{`, `,`, or
 * whitespace, whereas a bracketed MEMBER READ (`obj["currentStage"]`) is
 * preceded by the identifier it reads from. Without the guard, a ternary
 * like `cond ? obj["currentStage"] : fallback` would misread as a write, the
 * bracketed counterpart of the dotted-read exclusion above.
 */
const RAW_CURRENT_STAGE_COMPUTED_KEY = /(?<![\w$])\[\s*["']currentStage["']\s*\]\s*:\s*(\S+)/g;

/**
 * A direct property ASSIGNMENT: `x.currentStage = value` or the bracketed
 * form `x["currentStage"] = value`. `=(?!=)` requires a literal `=` not
 * immediately followed by another `=`, so `===`, `==` and `!==` comparisons
 * (which read `currentStage` but never write it) are never matched.
 */
const RAW_CURRENT_STAGE_DOT_ASSIGNMENT = /\.currentStage\s*=(?!=)\s*(\S+)/g;
const RAW_CURRENT_STAGE_BRACKET_ASSIGNMENT = /\[\s*["']currentStage["']\s*\]\s*=(?!=)\s*(\S+)/g;

/** True when `token` is a type position, not a value — e.g. `TaskStage`, `string`, or a nested type/doc map's opening `{`. */
function isNonValueToken(token: string): boolean {
  return token.startsWith("TaskStage") || token.startsWith("string") || token === "{";
}

/**
 * Strips `//` line comments and `/* *\/` block comments from `content`,
 * character by character, while tracking string/template-literal state so a
 * `//` or `/*` INSIDE a string (for example a URL) is never mistaken for a
 * comment start. Every removed comment character is replaced with a space
 * (newlines are always preserved as `\n`, whether inside a comment, a
 * string, or plain code), so the character offset of every surviving token
 * — and therefore the line number recovered from it via `lineForOffset` —
 * is identical to its position in the original file.
 *
 * This is still a lexer, not a parser: it does not distinguish a `/` that
 * starts a regex literal from a division operator, so a regex literal
 * containing `//` or `/*` could in principle confuse it. That residual gap
 * is the same class of "indirection this scan cannot follow" the runtime
 * backstop in `advanceStageLocked` and the human hand-off checks exist for
 * — it is not the multiline-token or string-content gap this scan closes.
 */
function stripCommentsPreservingLines(content: string): string {
  let result = "";
  let stringChar: '"' | "'" | "`" | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    const next = i + 1 < content.length ? content[i + 1] : "";

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        result += "\n";
      } else {
        result += " ";
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        result += "  ";
        i++;
      } else {
        result += ch === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (stringChar !== null) {
      result += ch;
      if (ch === "\\" && next !== "") {
        // Preserve the escaped character verbatim (e.g. `\"` inside a
        // double-quoted string) so it can never be mistaken for the
        // string's closing quote.
        result += next;
        i++;
        continue;
      }
      if (ch === stringChar) {
        stringChar = null;
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      result += "  ";
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      result += "  ";
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      stringChar = ch;
      result += ch;
      continue;
    }
    result += ch;
  }
  return result;
}

/** 1-based line start offsets into `content` (offsets[0] === 0 is always line 1). */
function buildLineStartOffsets(content: string): number[] {
  const offsets = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      offsets.push(i + 1);
    }
  }
  return offsets;
}

/** Binary search: the 1-based line number containing character offset `index`. */
function lineForOffset(lineStartOffsets: number[], index: number): number {
  let lo = 0;
  let hi = lineStartOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStartOffsets[mid]! <= index) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo + 1;
}

/**
 * Every pattern that can spell a VALUE write to `currentStage`: the bare
 * colon-form key, a quoted key, a computed key, and a direct (dotted or
 * bracketed) property assignment. Each is independent — a real write matches
 * exactly one of them — but the same character offset could in principle be
 * reported by more than one, so `findRawCurrentStageWriteLines` dedupes by
 * line before returning.
 */
const RAW_WRITE_PATTERNS: readonly RegExp[] = [
  RAW_CURRENT_STAGE_TOKEN,
  RAW_CURRENT_STAGE_TOKEN_QUOTED,
  RAW_CURRENT_STAGE_COMPUTED_KEY,
  RAW_CURRENT_STAGE_DOT_ASSIGNMENT,
  RAW_CURRENT_STAGE_BRACKET_ASSIGNMENT,
];

/** Line numbers (1-based, ascending, deduplicated) of every VALUE write to `currentStage` in `content`, wherever its tokens fall across lines. */
function findRawCurrentStageWriteLines(content: string): number[] {
  const stripped = stripCommentsPreservingLines(content);
  const lineStartOffsets = buildLineStartOffsets(stripped);
  const lines = new Set<number>();
  for (const pattern of RAW_WRITE_PATTERNS) {
    for (const match of stripped.matchAll(pattern)) {
      const token = match[1]!;
      if (isNonValueToken(token)) {
        continue;
      }
      lines.add(lineForOffset(lineStartOffsets, match.index));
    }
  }
  return Array.from(lines).sort((a, b) => a - b);
}

/** True when `content` assigns a VALUE (not a type) to `currentStage:` somewhere — used only by the self-test below. */
function hasRawCurrentStageWrite(content: string): boolean {
  return findRawCurrentStageWriteLines(content).length > 0;
}

/** Calls to the four functions that may assign `currentStage` (non-global, for the self-test's `.test()` use). */
const STAGE_TRANSFORM_CALL =
  /\b(updateTaskProgressStage|applyNextStagePolicyV1|applyReopenPolicyV1|applyPlanRevisionPolicyV1)\s*\(/;

/** Same pattern, global, for enumerating every call site's line number. */
const STAGE_TRANSFORM_CALL_GLOBAL =
  /\b(updateTaskProgressStage|applyNextStagePolicyV1|applyReopenPolicyV1|applyPlanRevisionPolicyV1)\s*\(/g;

/** Line numbers (1-based) of every call to a stage-mutating transform in `content`, wherever its tokens fall across lines. */
function findStageTransformCallLines(content: string): number[] {
  const stripped = stripCommentsPreservingLines(content);
  const lineStartOffsets = buildLineStartOffsets(stripped);
  const lines: number[] = [];
  for (const match of stripped.matchAll(STAGE_TRANSFORM_CALL_GLOBAL)) {
    lines.push(lineForOffset(lineStartOffsets, match.index));
  }
  return lines;
}

interface AllowlistEntry {
  readonly line: number;
  readonly reason: string;
}

/**
 * Every line allowed to contain a raw `currentStage:` VALUE write, and why.
 * Keyed by path relative to `src/`, using forward slashes (see the header
 * comment on why basename alone is not a safe key).
 */
const RAW_WRITE_ALLOWLIST: ReadonlyMap<string, readonly AllowlistEntry[]> = new Map([
  [
    "utils/taskProgressTransforms.ts",
    [{ line: 117, reason: "updateTaskProgressStage's own write — the default enterStageV1 transform" }],
  ],
  [
    "services/taskProgressFieldPolicyV1.ts",
    [
      { line: 525, reason: "applyNextStagePolicyV1's target-stage write" },
      {
        line: 619,
        reason:
          "applyMarkTaskDonePolicyV1 — stage-preserving, carries currentStage forward unchanged " +
          "(registered as stage-preserving, not stage-mutating)",
      },
      { line: 741, reason: "applyReopenPolicyV1's target-stage write" },
      { line: 863, reason: "applyPlanRevisionPolicyV1's target-stage write (back to 'plan')" },
    ],
  ],
  [
    "services/taskProgressWriterV1.ts",
    [{ line: 328, reason: "createTaskProgressV1 — task birth, the one legitimate raw seed" }],
  ],
  [
    "services/taskProgressDecoderV1.ts",
    [
      {
        line: 2115,
        reason:
          "the strict decoder's in-memory draft reconstruction while deserializing a persisted " +
          "workspace-legacy-v0 'completed' stage into 'publish' — a read-path decode of bytes " +
          "already on disk, never a live stage transition",
      },
      {
        line: 2125,
        reason:
          "the strict decoder's in-memory draft reconstruction assigning the resolved stage while " +
          "deserializing persisted progress — same read-path decode as line 2115, not a transition",
      },
    ],
  ],
  [
    "commands/commitAndPushTask.ts",
    [
      {
        line: 3354,
        reason:
          "an in-memory IncompleteTask display/dispatch-argument literal ('Since it was just " +
          "advanced') — not a task-progress.json write; the real advance already happened",
      },
    ],
  ],
  [
    "commands/reviewActions.ts",
    [
      {
        line: 1232,
        reason:
          "normalizeReviewArg's minimal IncompleteTask reconstruction — progress is always " +
          "re-read from disk by resolveTask, never trusted from this literal",
      },
      {
        line: 9490,
        reason:
          "the auto-review dispatch after Complete & Move On — an automation-chain dispatch " +
          "arg's routing hint that resolveTask never trusts for anything but that hint",
      },
    ],
  ],
]);

/**
 * Every line allowed to CALL one of the four stage-mutating transforms, and
 * why. Each of the row/command files calls its transform only as the
 * `transform` closure it hands to `enterStageV1` — never as a standalone
 * progress write of its own. Keyed by path relative to `src/`, same as
 * `RAW_WRITE_ALLOWLIST`.
 */
const TRANSFORM_CALL_ALLOWLIST: ReadonlyMap<string, readonly AllowlistEntry[]> = new Map([
  [
    "utils/stageTransition.ts",
    [{ line: 386, reason: "advanceStageLocked's own default-transform call inside enterStageV1's machinery" }],
  ],
  ["utils/taskProgressTransforms.ts", [{ line: 43, reason: "updateTaskProgressStage's own definition" }]],
  [
    "services/taskProgressFieldPolicyV1.ts",
    [
      { line: 469, reason: "applyNextStagePolicyV1's own definition" },
      { line: 685, reason: "applyReopenPolicyV1's own definition" },
      { line: 814, reason: "applyPlanRevisionPolicyV1's own definition" },
    ],
  ],
  [
    "actions/rows/nextStageRowV1.ts",
    [
      { line: 233, reason: "builds applyNextStagePolicyV1 as enterStageV1's transform (baseResult pass)" },
      { line: 241, reason: "builds applyNextStagePolicyV1 as enterStageV1's transform (finalResult pass)" },
    ],
  ],
  [
    "actions/rows/resumeTaskRowV1.ts",
    [{ line: 191, reason: "builds applyReopenPolicyV1 as enterStageV1's transform for kind reopen" }],
  ],
  [
    "commands/planRevisionV1.ts",
    [{ line: 238, reason: "builds applyPlanRevisionPolicyV1 as enterStageV1's transform for kind plan-revision" }],
  ],
  [
    "commands/generatePlanWithAI.ts",
    [{ line: 670, reason: "builds updateTaskProgressStage as enterStageV1's transform for kind generate-plan" }],
  ],
]);

/**
 * Part 1 transform registry: beside the exact-line write/call allowlists
 * above, every EXPORTED FUNCTION in the two files that define a
 * stage-mutating transform (`taskProgressTransforms.ts`,
 * `taskProgressFieldPolicyV1.ts`) whose body contains a `currentStage:`
 * VALUE write must be registered here as `"mutating"` (it changes the
 * stage) or `"stage-preserving"` (it writes the field back unchanged, e.g.
 * `applyMarkTaskDonePolicyV1` carrying `currentStage` forward as-is). This
 * is function-level, not line-level: a FIFTH transform added to either file
 * later — with its own write on its own (necessarily unallowlisted) line —
 * is already caught by the exact-line scan above, but this registry is the
 * plan's second, independent rule: it fails on the function's NAME being
 * unregistered, which reads clearly even before anyone works out which line
 * to allowlist.
 */
type StageLiteralClassification = "mutating" | "stage-preserving";

const STAGE_LITERAL_REGISTRY: ReadonlyMap<string, ReadonlyMap<string, StageLiteralClassification>> = new Map([
  ["utils/taskProgressTransforms.ts", new Map([["updateTaskProgressStage", "mutating"]])],
  [
    "services/taskProgressFieldPolicyV1.ts",
    new Map([
      ["applyNextStagePolicyV1", "mutating"],
      ["applyMarkTaskDonePolicyV1", "stage-preserving"],
      ["applyReopenPolicyV1", "mutating"],
      ["applyPlanRevisionPolicyV1", "mutating"],
    ]),
  ],
]);

/** Matches a top-level `export function NAME(` declaration, capturing NAME. */
const EXPORTED_FUNCTION_DECL = /^export function\s+(\w+)\s*\(/gm;

/** Every top-level exported function's name and 1-based declaration line, in ascending line order. */
function collectExportedFunctionStarts(content: string): { name: string; line: number }[] {
  const stripped = stripCommentsPreservingLines(content);
  const lineStartOffsets = buildLineStartOffsets(stripped);
  const results: { name: string; line: number }[] = [];
  for (const match of stripped.matchAll(EXPORTED_FUNCTION_DECL)) {
    results.push({ name: match[1]!, line: lineForOffset(lineStartOffsets, match.index) });
  }
  return results.sort((a, b) => a.line - b.line);
}

/**
 * The name of the top-level exported function that `line` falls inside,
 * found as the nearest preceding declaration in `functions` (sorted
 * ascending). These two source files declare only flat, non-nested top-level
 * `export function` bodies (arrow-function helpers inside them never match
 * {@link EXPORTED_FUNCTION_DECL}), so "nearest preceding declaration" is
 * exactly "the enclosing function" without needing a full brace parse.
 */
function ownerFunctionForLine(functions: { name: string; line: number }[], line: number): string | undefined {
  let owner: string | undefined;
  for (const fn of functions) {
    if (fn.line > line) {
      break;
    }
    owner = fn.name;
  }
  return owner;
}

function collectSourceFiles(dir: string, fileList: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "test" || entry.name === "test-host") {
        continue;
      }
      collectSourceFiles(filePath, fileList);
    } else if (entry.name.endsWith(".ts")) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

/**
 * Compares the actual (file, line) hits a finder produces against an
 * exact-line allowlist, in both directions: a hit at an unlisted line is a
 * violation ("new/moved write"), and a listed line with no matching hit is
 * also a violation ("stale entry — the allowlist itself has drifted and must
 * be updated, per this file's header comment").
 */
function diffAgainstLineAllowlist(
  finder: (content: string) => number[],
  allowlist: ReadonlyMap<string, readonly AllowlistEntry[]>
): { newOrMoved: string[]; stale: string[] } {
  const newOrMoved: string[] = [];
  const stale: string[] = [];
  const seenAllowlistKeys = new Set<string>();
  for (const file of collectSourceFiles(SRC_DIR)) {
    // Forward slashes always, so the map keys above are platform-independent.
    const srcRelativeKey = path.relative(SRC_DIR, file).split(path.sep).join("/");
    const content = fs.readFileSync(file, "utf8");
    const actualLines = new Set(finder(content));
    const allowed = allowlist.get(srcRelativeKey) ?? [];
    if (allowlist.has(srcRelativeKey)) {
      seenAllowlistKeys.add(srcRelativeKey);
    }
    const allowedLines = new Set(allowed.map((entry) => entry.line));
    for (const line of actualLines) {
      if (!allowedLines.has(line)) {
        newOrMoved.push(`${path.relative(REPO_ROOT, file)}:${line}`);
      }
    }
    for (const entry of allowed) {
      if (!actualLines.has(entry.line)) {
        stale.push(`${path.relative(REPO_ROOT, file)}:${entry.line} ("${entry.reason}")`);
      }
    }
  }
  // An allowlist key that never matched any real file (e.g. a rename/move
  // that also changes the file's path, not just a line within it) is its own
  // kind of staleness — the entries under it were never checked above.
  for (const key of allowlist.keys()) {
    if (!seenAllowlistKeys.has(key)) {
      stale.push(`${key} (no file found at this src/-relative path — the allowlist key itself is stale)`);
    }
  }
  return { newOrMoved, stale };
}

void describe("stage-mutator source scan (Part 1, item 15 — the one-door proof)", () => {
  void it("scans the real TypeScript sources", () => {
    assert.ok(fs.existsSync(SRC_DIR), `Expected source directory at ${SRC_DIR}`);
    assert.ok(
      collectSourceFiles(SRC_DIR).length > 20,
      "Expected to discover the extension's source files; the scan root is wrong."
    );
  });

  void it("self-test: the matchers can actually fail", () => {
    assert.ok(hasRawCurrentStageWrite('currentStage: "impl",'));
    assert.ok(hasRawCurrentStageWrite("currentStage: newStage,"));
    assert.ok(!hasRawCurrentStageWrite("readonly currentStage: TaskStage;"));
    assert.ok(!hasRawCurrentStageWrite("currentStage?: TaskStage;"));
    assert.ok(!hasRawCurrentStageWrite("currentStage?: string;"));
    assert.ok(!hasRawCurrentStageWrite("x.currentStage"));
    assert.ok(!hasRawCurrentStageWrite('cond ? a.currentStage : "fallback"'));
    assert.ok(!hasRawCurrentStageWrite("currentStage: {\n  nextStage: 'x',\n},"));
    assert.ok(STAGE_TRANSFORM_CALL.test("updateTaskProgressStage(current, next, actor)"));
    assert.ok(!STAGE_TRANSFORM_CALL.test("// updateTaskProgressStage advances the stage"));

    // A second, unreviewed write landing on a NEW line of an already-allowlisted
    // file must be detectable — this is the exact gap a file-level allowlist has.
    const injectedSecondWrite =
      'function reconstruct() {\n  return { currentStage: "desc" as TaskStage };\n}\n\n' +
      'function sneaky() {\n  return { currentStage: "impl" };\n}\n';
    const lines = findRawCurrentStageWriteLines(injectedSecondWrite);
    assert.deepStrictEqual(lines, [2, 6]);

    // A second, unreviewed transform call landing on a NEW line of an
    // already-allowlisted caller file must likewise be detectable.
    const injectedSecondCall =
      "const a = applyReopenPolicyV1(current, opts);\nconst b = applyReopenPolicyV1(other, opts2);\n";
    assert.deepStrictEqual(findStageTransformCallLines(injectedSecondCall), [1, 2]);

    // Review-reported gap 1: a write whose `currentStage:` and its value sit
    // on different lines must still be caught, at the line the key starts on.
    const multilineWrite =
      "function reconstruct() {\n" + '  return { currentStage\n' + '    : "desc" as TaskStage };\n' + "}\n";
    assert.deepStrictEqual(findRawCurrentStageWriteLines(multilineWrite), [2]);

    // Review-reported gap 1, transform-call variant: the call name and its
    // opening paren split across lines must still be caught.
    const multilineCall = "const a = applyReopenPolicyV1\n  (current, opts);\n";
    assert.deepStrictEqual(findStageTransformCallLines(multilineCall), [1]);

    // Review-reported gap 2: a `//` that is part of a STRING (e.g. a URL)
    // earlier on the same line must not be treated as a comment start that
    // discards a real write appearing later on that same line.
    const writeAfterUrlInString = 'return { note: "see http://x", currentStage: "impl" };';
    assert.deepStrictEqual(findRawCurrentStageWriteLines(writeAfterUrlInString), [1]);

    // Same gap, transform-call variant.
    const callAfterUrlInString = 'log("see http://x"); applyReopenPolicyV1(current, opts);';
    assert.deepStrictEqual(findStageTransformCallLines(callAfterUrlInString), [1]);

    // A REAL `//` comment must still correctly hide a write/call that only
    // appears in prose after it (the false-positive case this scan must
    // keep avoiding).
    const writeOnlyInRealComment = '// see currentStage: "impl" below\nconst x = 1;';
    assert.deepStrictEqual(findRawCurrentStageWriteLines(writeOnlyInRealComment), []);
    const callOnlyInBlockComment = "/* applyReopenPolicyV1(current, opts) is called elsewhere */\nconst y = 2;";
    assert.deepStrictEqual(findStageTransformCallLines(callOnlyInBlockComment), []);

    // Review-reported gap 3: a QUOTED object-literal key must be caught, the
    // same as the bare unquoted form already was.
    const quotedKeyWrite = 'return { "currentStage": "impl" };';
    assert.deepStrictEqual(findRawCurrentStageWriteLines(quotedKeyWrite), [1]);
    const singleQuotedKeyWrite = "return { 'currentStage': next };";
    assert.deepStrictEqual(findRawCurrentStageWriteLines(singleQuotedKeyWrite), [1]);

    // Review-reported gap 3, computed-key variant: `["currentStage"]: value`
    // inside an object literal must be caught.
    const computedKeyWrite = 'return { ["currentStage"]: "impl" };';
    assert.deepStrictEqual(findRawCurrentStageWriteLines(computedKeyWrite), [1]);

    // A bracketed MEMBER READ followed by an unrelated colon (the bracketed
    // counterpart of the dotted-read ternary case above) must NOT be mistaken
    // for a computed-key write — `obj["currentStage"]` here is preceded by an
    // identifier, not by `{`, `,`, or whitespace.
    const bracketReadInTernary = 'cond ? obj["currentStage"] : "fallback"';
    assert.deepStrictEqual(findRawCurrentStageWriteLines(bracketReadInTernary), []);

    // Review-reported gap 3, direct-assignment variant: `x.currentStage =
    // value` and its bracketed form must both be caught, at the line the
    // property token starts on.
    const dotAssignment = 'draft.currentStage = "publish";';
    assert.deepStrictEqual(findRawCurrentStageWriteLines(dotAssignment), [1]);
    const bracketAssignment = 'draft["currentStage"] = stage;';
    assert.deepStrictEqual(findRawCurrentStageWriteLines(bracketAssignment), [1]);

    // A comparison against `currentStage` (`===`, `==`, `!==`) reads the
    // field and must never be mistaken for a write, whichever spelling reads
    // it.
    assert.deepStrictEqual(findRawCurrentStageWriteLines('if (x.currentStage === "impl") {}'), []);
    assert.deepStrictEqual(findRawCurrentStageWriteLines('if (x.currentStage == "impl") {}'), []);
    assert.deepStrictEqual(findRawCurrentStageWriteLines('if (x.currentStage !== "impl") {}'), []);

    // The three new forms must also be caught when their tokens are split
    // across lines, the same whole-file offset-based guarantee the original
    // colon form already has.
    const multilineQuotedKey = 'return {\n  "currentStage"\n    : "impl",\n};';
    assert.deepStrictEqual(findRawCurrentStageWriteLines(multilineQuotedKey), [2]);
    const multilineDotAssignment = "draft\n  .currentStage\n  = stage;";
    assert.deepStrictEqual(findRawCurrentStageWriteLines(multilineDotAssignment), [2]);

    // A `//` inside a string preceding one of the three new forms on the
    // same line must not swallow the real write that follows it (the same
    // gap 2 protection, proven for the new patterns too).
    const quotedWriteAfterUrlInString = 'return { note: "see http://x", "currentStage": "impl" };';
    assert.deepStrictEqual(findRawCurrentStageWriteLines(quotedWriteAfterUrlInString), [1]);
  });

  void it("every raw currentStage: write sits at an allowlisted exact line", () => {
    const { newOrMoved, stale } = diffAgainstLineAllowlist(findRawCurrentStageWriteLines, RAW_WRITE_ALLOWLIST);

    assert.deepStrictEqual(
      newOrMoved,
      [],
      "These currentStage writes are not on the exact-line allowlist (new, moved, or an " +
        "unreviewed second write in an already-allowlisted file) — route through enterStageV1 " +
        "or add a reviewed entry: " +
        newOrMoved.join(", ")
    );
    assert.deepStrictEqual(
      stale,
      [],
      "These RAW_WRITE_ALLOWLIST entries no longer match anything at their recorded line — the " +
        "write moved or was removed; update the line number (do not delete the entry unless the " +
        "write itself is gone): " +
        stale.join(", ")
    );
  });

  void it(
    "every exported function in the transform files that writes a currentStage literal is registered " +
      "as mutating or stage-preserving",
    () => {
      const unregistered: string[] = [];
      const staleRegistryEntries: string[] = [];
      for (const [relPath, registry] of STAGE_LITERAL_REGISTRY) {
        const filePath = path.join(SRC_DIR, ...relPath.split("/"));
        const content = fs.readFileSync(filePath, "utf8");
        const functions = collectExportedFunctionStarts(content);
        const writeLines = findRawCurrentStageWriteLines(content);
        const functionsWithWrites = new Set<string>();
        for (const line of writeLines) {
          const owner = ownerFunctionForLine(functions, line);
          if (owner !== undefined) {
            functionsWithWrites.add(owner);
          }
        }
        for (const name of functionsWithWrites) {
          if (!registry.has(name)) {
            unregistered.push(`${relPath}: ${name} (line-level allowlist entry exists, but not in STAGE_LITERAL_REGISTRY)`);
          }
        }
        for (const name of registry.keys()) {
          if (!functionsWithWrites.has(name)) {
            staleRegistryEntries.push(`${relPath}: ${name}`);
          }
        }
      }
      assert.deepStrictEqual(
        unregistered,
        [],
        "These functions write a currentStage literal but are not classified in STAGE_LITERAL_REGISTRY " +
          "as 'mutating' or 'stage-preserving': " +
          unregistered.join(", ")
      );
      assert.deepStrictEqual(
        staleRegistryEntries,
        [],
        "These STAGE_LITERAL_REGISTRY entries no longer match any function that writes a currentStage " +
          "literal — the function moved, was renamed, or no longer writes the field; update or remove the entry: " +
          staleRegistryEntries.join(", ")
      );
    }
  );

  void it("every call to a stage-mutating transform sits at an allowlisted exact line", () => {
    const { newOrMoved, stale } = diffAgainstLineAllowlist(findStageTransformCallLines, TRANSFORM_CALL_ALLOWLIST);

    assert.deepStrictEqual(
      newOrMoved,
      [],
      "These stage-transform calls are not on the exact-line allowlist (new, moved, or an " +
        "unreviewed second call in an already-allowlisted file) — route through enterStageV1's " +
        "own transform-closure pattern or add a reviewed entry: " +
        newOrMoved.join(", ")
    );
    assert.deepStrictEqual(
      stale,
      [],
      "These TRANSFORM_CALL_ALLOWLIST entries no longer match anything at their recorded line — " +
        "the call moved or was removed; update the line number (do not delete the entry unless " +
        "the call itself is gone): " +
        stale.join(", ")
    );
  });

  void it("preparePlanPromotion has no production caller outside stageTransition.ts", () => {
    const violations = collectSourceFiles(SRC_DIR)
      .filter((file) => path.basename(file) !== "implementationArtifactResolver.ts")
      .filter((file) => path.basename(file) !== "stageTransition.ts")
      .filter((file) => /\bpreparePlanPromotion\s*\(/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(REPO_ROOT, file));

    assert.deepStrictEqual(
      violations,
      [],
      "preparePlanPromotion must be called only from stageTransition.ts's prepareStageEntryV1: " +
        violations.join(", ")
    );
  });
});
