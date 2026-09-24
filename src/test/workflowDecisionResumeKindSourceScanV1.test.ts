import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Pre-1.0.0 fixes register, Part 3 (items 14/22), Step 2's own requirement:
 * "A source-scan test finding every `optionId:` literal in non-test `src/`
 * files ... and failing when `resumeKind` is missing." `resumeKind` is
 * REQUIRED on `WorkflowDecisionOptionV1` (`src/types/workflowDecisionV1.ts`),
 * so the compiler already rejects a typed literal that omits it — this scan
 * is the independent, structural belt-and-suspenders check the plan asks
 * for, so a future option builder cannot escape classification by
 * constructing its literal through an untyped or `any`-typed path.
 *
 * Finds every real DECISION-OPTION object literal — one that assigns
 * `optionId: <string-literal>` AND itself carries an `effect:` property (the
 * one field every `WorkflowDecisionOptionV1` has that a mere reference to an
 * option id never does: `WorkflowDecisionRecommendationV1`'s
 * `{ kind: "option", optionId: "...", reasoning: "..." }` shape, and the
 * `optionIds` id-collecting maps in `hostDecisionMirrorV1.ts`/
 * `reviewEscalation.ts`, both read `optionId` but declare no `effect`) — and
 * asserts each one's own object body also contains `resumeKind:`.
 *
 * Excludes `src/test/` and `*.test.ts`, and needs no allowlist: every
 * production option-object literal in the tree, as of this scan's writing,
 * already carries `resumeKind` (see Part 3 Step 2's inventory in the task's
 * approved plan). A future literal that omits it fails this test directly at
 * the offending file/line, without needing a maintained exception list.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SRC_ROOT = path.join(REPO_ROOT, "src");

function listSourceFiles(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "test") {
        continue;
      }
      listSourceFiles(full, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
}

interface OptionIdHit {
  readonly relPath: string;
  readonly line: number;
  readonly objectSource: string;
}

/**
 * Given the full file text and the character offset of an `optionId:`
 * match, finds the innermost enclosing `{ ... }` object literal (walking
 * backward for the opening brace, then forward with depth tracking for the
 * matching close) and returns its source text, or undefined if the nearest
 * enclosing brace isn't a plain object-literal opener adjacent to this match
 * (should not happen for well-formed TS, but fails closed rather than
 * mis-scoping).
 */
function enclosingObjectLiteral(text: string, matchOffset: number): string | undefined {
  let depth = 0;
  let openIdx = -1;
  for (let i = matchOffset; i >= 0; i--) {
    const ch = text[i];
    if (ch === "}") {
      depth++;
    } else if (ch === "{") {
      if (depth === 0) {
        openIdx = i;
        break;
      }
      depth--;
    }
  }
  if (openIdx === -1) {
    return undefined;
  }
  depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(openIdx, i + 1);
      }
    }
  }
  return undefined;
}

function findOptionLiteralsMissingResumeKind(filePath: string): OptionIdHit[] {
  const text = fs.readFileSync(filePath, "utf8");
  const relPath = path.relative(SRC_ROOT, filePath).split(path.sep).join("/");
  const hits: OptionIdHit[] = [];
  // A real literal assignment: optionId: "...", optionId: '...', or
  // optionId: `...` (handoffChecksV1.ts's per-check template literal id).
  // Excludes `optionId: string` (type fields) and `optionId: option.optionId`
  // / `optionId: raw.optionId` (property-access reads), none of which start
  // with a quote character after the colon.
  const pattern = /optionId:\s*["'`]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const objectSource = enclosingObjectLiteral(text, match.index);
    if (objectSource === undefined) {
      continue;
    }
    // Only a genuine WorkflowDecisionOptionV1 literal carries `effect:` in
    // its own body — a recommendation reference or an id-collecting map
    // entry never does. Skip anything that isn't one.
    if (!/\beffect\s*:/.test(objectSource)) {
      continue;
    }
    if (!/\bresumeKind\s*:/.test(objectSource)) {
      const line = text.slice(0, match.index).split("\n").length;
      hits.push({ relPath, line, objectSource: objectSource.slice(0, 120) });
    }
  }
  return hits;
}

void describe("every production decision-option literal states its resumeKind (pre-1.0.0 fixes register, Part 3 Step 2)", () => {
  void it("finds no WorkflowDecisionOptionV1-shaped literal missing resumeKind in non-test src/", () => {
    const files: string[] = [];
    listSourceFiles(SRC_ROOT, files);
    const allHits: OptionIdHit[] = [];
    for (const file of files) {
      allHits.push(...findOptionLiteralsMissingResumeKind(file));
    }
    assert.deepEqual(
      allHits,
      [],
      `every optionId: literal that also declares effect: must state resumeKind: ${JSON.stringify(allHits, null, 2)}`
    );
  });

  void it("sanity: the scan actually finds real option literals (does not silently match nothing)", () => {
    const files: string[] = [];
    listSourceFiles(SRC_ROOT, files);
    let totalOptionLiterals = 0;
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      const pattern = /optionId:\s*["'`]/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const objectSource = enclosingObjectLiteral(text, match.index);
        if (objectSource !== undefined && /\beffect\s*:/.test(objectSource)) {
          totalOptionLiterals++;
        }
      }
    }
    assert.ok(totalOptionLiterals > 40, `expected many real option literals, found ${totalOptionLiterals}`);
  });
});
