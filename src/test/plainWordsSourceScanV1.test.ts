/**
 * run1 plain words (Steps 3, 5 and 6), as a source scan: no user-facing sentence in the product code builds its
 * own "usage limit" / "quota" wording, says "continuation budget", or names an internal identifier. Those words
 * come from `roundStopCauseV1.ts` (`describeRoundStopV1`, `describeStopLeadV1`, `describeProviderLimitPhraseV1`),
 * which decides from the provider's own text whether a limit may be named.
 *
 * The scan reads every string and template literal of two or more words in the non-test sources (comments and
 * regular expressions are skipped) and fails on a banned phrase outside the files that legitimately hold provider
 * match markers or the shared wording itself.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const SRC_ROOT = path.resolve(__dirname, "..", "..", "src");

/** Words that must not appear in a user-facing sentence anywhere in the product code. */
const BANNED_EVERYWHERE: readonly RegExp[] = [
  /continuation budget/i,
  /\bquarantined\b/i,
  /\bpendingImplReviewFiles\b/,
  /\bexternallyTerminated\b/,
];

/**
 * Text that is not a card, notification or chat line, so the owner never reads it as one: the run log (which may
 * keep identifiers), the prompt written for the model, internal diagnostics for a corrupt state file, and two
 * other features that happen to use the word "quarantined" (unreadable chat files, known test flakes in Publish
 * Checks). Each entry names its reason.
 */
const NOT_OWNER_FACING: readonly { readonly file: string; readonly literal: RegExp; readonly why: string }[] = [
  { file: "commands/implementationRecoveryV1.ts", literal: /quarantined/i, why: "the continuation prompt for the model" },
  { file: "commands/reconcilePlanChecklist.ts", literal: /pendingImplReviewFiles/, why: "evidence handed to the reconcile model" },
  {
    file: "commands/reviewActions.ts",
    literal: /Recovery record:|Its workspace delta was quarantined into|recovery\.capReached/,
    why: "the run log's recovery section",
  },
  { file: "commands/reviewActions.ts", literal: /Out-of-boundary changes \(inspect-and-complete\)/, why: "the run log's boundary section" },
  { file: "services/taskProgressDecoderV1.ts", literal: /pendingImplReviewFiles/, why: "decoder diagnostics for a corrupt progress file" },
  { file: "services/taskProgressFieldPolicyV1.ts", literal: /quarantined/i, why: "a write-policy description in code" },
  { file: "utils/chatHistoryStore.ts", literal: /quarantined/i, why: "a different feature: unreadable chat files" },
  { file: "utils/completionLint.ts", literal: /quarantined/i, why: "a different feature: known test flakes in Publish Checks" },
];

function isNotOwnerFacing(relativeFile: string, literal: string): boolean {
  return NOT_OWNER_FACING.some((entry) => entry.file === relativeFile && entry.literal.test(literal));
}

/** Limit wording: only the shared formatter may build it; elsewhere it may only be matched, not said. */
const LIMIT_WORDS = /usage limit|quota or rate limit|hit a quota|hit its quota|quota (?:is )?exhausted/i;

/**
 * The shared wording itself, and the provider-output parser (`quota.ts`: its marker lists, and the sentence it
 * builds only from a provider's own explicit usage-limit line).
 */
const LIMIT_WORDS_ALLOWED: ReadonlySet<string> = new Set(["utils/roundStopCauseV1.ts", "utils/quota.ts"]);

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "test" || entry.name === "node_modules") continue;
      listSourceFiles(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** The text of every quoted or template literal in `source`, skipping comments and regex literals. */
function stringLiterals(source: string): string[] {
  const found: string[] = [];
  let i = 0;
  let prevSignificant = "";
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (ch === "/" && /[=(,:;!&|?{}[\n]/.test(prevSignificant || "\n")) {
      // A regular expression literal.
      i++;
      let inClass = false;
      while (i < source.length) {
        const c = source[i]!;
        if (c === "\\") i += 2;
        else if (c === "[") (inClass = true), i++;
        else if (c === "]") (inClass = false), i++;
        else if (c === "/" && !inClass) {
          i++;
          break;
        } else i++;
      }
      prevSignificant = ")";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let text = "";
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") {
          text += source[i + 1] ?? "";
          i += 2;
          continue;
        }
        text += source[i];
        i++;
      }
      i++;
      found.push(text);
      prevSignificant = quote;
      continue;
    }
    if (!/\s/.test(ch)) prevSignificant = ch;
    i++;
  }
  return found.filter((text) => /\S+\s+\S+/.test(text));
}

void describe("plain words, scanned in the product code (run1 Steps 3, 5, 6)", () => {
  const files = listSourceFiles(SRC_ROOT);

  void it("the scan reads the product sources", () => {
    assert.ok(files.length > 100);
    assert.ok(files.some((file) => file.endsWith(path.join("utils", "roundStopCauseV1.ts"))));
  });

  void it("no sentence says 'continuation budget', 'quarantined' or an internal identifier", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const relative = path.relative(SRC_ROOT, file).split(path.sep).join("/");
      for (const literal of stringLiterals(fs.readFileSync(file, "utf8"))) {
        if (isNotOwnerFacing(relative, literal)) continue;
        for (const banned of BANNED_EVERYWHERE) {
          if (banned.test(literal)) offenders.push(`${relative}: ${literal.slice(0, 120)}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  void it("limit wording is built only by the shared formatter, never by a card's own sentence", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const relative = path.relative(SRC_ROOT, file).split(path.sep).join("/");
      if (LIMIT_WORDS_ALLOWED.has(relative)) continue;
      for (const literal of stringLiterals(fs.readFileSync(file, "utf8"))) {
        if (LIMIT_WORDS.test(literal)) offenders.push(`${relative}: ${literal.slice(0, 120)}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});
