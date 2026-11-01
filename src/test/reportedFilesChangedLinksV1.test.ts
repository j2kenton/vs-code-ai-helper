/**
 * bugs4 item 1: `## Files Changed` entries written as Markdown links.
 *
 * The 2026-10-28 bugs3 Implementation round reported three changed source
 * files as clickable links; the parser returned the whole `[label](dest:line)`
 * token, nothing matched a repository-relative snapshot path, and all three
 * real edits were labelled unreported hand edits. These tests pin the link
 * forms, the boundary rejections, and the replay of that captured report.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  attributeImplementationRoundFilesV1,
  describeUnattributedWorkspaceChangesSectionV1,
  describeUnparsedFilesChangedReportV1,
  parseReportedFilesChangedV1,
  resolveCompletedRoundAttributionV1,
} from "../utils/implementationArtifactResolver";
import { normalizeRepositoryRelativePathV1 } from "../utils/roundGitStateV1";
import { resolveImplementationReviewScopeV1, type ImplReviewLedgerRowV1 } from "../utils/implReviewFileSelection";
import { updateImplReviewFiles } from "../utils/taskProgressTransforms";
import type { TaskProgress } from "../types/taskProgress";

const ROOT = "/workspace/vs-code-ai-helper";

function report(...entries: string[]): string {
  return ["## Files Changed", "", ...entries.map((entry) => `- ${entry}`), "", "## Verification", "", "- ok"].join("\n");
}

function parsed(entry: string, workspaceRoot: string = ROOT): { paths: string[]; rejected: string[] } {
  const result = parseReportedFilesChangedV1(report(entry), { workspaceRoot });
  assert.ok(result, "the section must parse");
  return { paths: result.paths, rejected: result.rejected.map((item) => item.reason) };
}

void describe("parseReportedFilesChangedV1 — Markdown links", () => {
  void it("keeps plain and backticked entries working", () => {
    const result = parseReportedFilesChangedV1(report("`src/a.ts` — x", "src/b.ts — y", "./src/c.ts"), { workspaceRoot: ROOT });
    assert.deepEqual(result?.paths, ["src/a.ts", "src/b.ts", "src/c.ts"]);
    assert.deepEqual(result?.rejected, []);
  });

  void it("resolves an absolute link destination with a :line suffix to the repository-relative identity", () => {
    assert.deepEqual(parsed(`[gitIndexLockV1.ts](${ROOT}/src/utils/gitIndexLockV1.ts:1) — captures lock state.`).paths, [
      "src/utils/gitIndexLockV1.ts",
    ]);
  });

  void it("strips :line:col and #Lnn / #Lnn-Lmm annotations", () => {
    assert.deepEqual(parsed(`[a](${ROOT}/src/a.ts:12:5)`).paths, ["src/a.ts"]);
    assert.deepEqual(parsed(`[a](${ROOT}/src/a.ts#L12)`).paths, ["src/a.ts"]);
    assert.deepEqual(parsed(`[a](${ROOT}/src/a.ts#L12-L20)`).paths, ["src/a.ts"]);
    assert.deepEqual(parsed("[a](src/a.ts#L3C4)").paths, ["src/a.ts"]);
  });

  void it("accepts relative destinations", () => {
    assert.deepEqual(parsed("[a](src/a.ts:3)").paths, ["src/a.ts"]);
    assert.deepEqual(parsed("[a](./src/a.ts)").paths, ["src/a.ts"]);
  });

  void it("handles spaces: angle-bracket form, bare spaces and %20", () => {
    assert.deepEqual(parsed("[a](<src/my file.ts>)").paths, ["src/my file.ts"]);
    assert.deepEqual(parsed("[a](src/my file.ts:4)").paths, ["src/my file.ts"]);
    assert.deepEqual(parsed("[a](src/my%20file.ts)").paths, ["src/my file.ts"]);
  });

  void it("decodes percent-encoding and unescapes Markdown backslash escapes", () => {
    assert.deepEqual(parsed("[a](src/%5Bid%5D/page.ts)").paths, ["src/[id]/page.ts"]);
    assert.deepEqual(parsed("[a](src/\\[id\\]/page.ts)").paths, ["src/[id]/page.ts"]);
    assert.deepEqual(parsed("[a](src/a%23b.ts)").paths, ["src/a#b.ts"]);
  });

  void it("never matches on the display label or basename: same-named files stay distinct", () => {
    const result = parseReportedFilesChangedV1(
      report(`[index.ts](${ROOT}/packages/a/index.ts)`, `[index.ts](${ROOT}/packages/b/index.ts)`),
      { workspaceRoot: ROOT }
    );
    assert.deepEqual(result?.paths, ["packages/a/index.ts", "packages/b/index.ts"]);
    const split = attributeImplementationRoundFilesV1(
      ["packages/a/index.ts", "packages/c/index.ts"],
      result?.paths
    );
    assert.deepEqual(split.attributed, ["packages/a/index.ts"]);
    assert.deepEqual(split.unattributed, ["packages/c/index.ts"]);
  });

  void it("a misleading label does not decide the path", () => {
    assert.deepEqual(parsed(`[src/other.ts](${ROOT}/src/real.ts)`).paths, ["src/real.ts"]);
  });

  void it("accepts file:// destinations", () => {
    assert.deepEqual(parsed(`[a](file://${ROOT}/src/a.ts:2)`).paths, ["src/a.ts"]);
    assert.deepEqual(parsed(`[a](file://localhost${ROOT}/src/a.ts)`).paths, ["src/a.ts"]);
    assert.deepEqual(parsed(`[a](file://${ROOT}/src/my%20file.ts)`).paths, ["src/my file.ts"]);
  });

  void it("rejects external URLs and other schemes", () => {
    for (const dest of ["https://example.com/src/a.ts", "http://x/y.ts", "vscode://file/src/a.ts", "mailto:a@b.c", "javascript:alert(1)"]) {
      const result = parsed(`[a](${dest})`);
      assert.deepEqual(result.paths, [], dest);
      assert.equal(result.rejected.length, 1, dest);
    }
  });

  void it("rejects destinations outside the workspace, traversal, network and foreign-host forms", () => {
    for (const dest of [
      "/etc/passwd",
      `${ROOT}-other/src/a.ts`,
      "../outside.ts",
      "src/../../outside.ts",
      `${ROOT}/src/../../x.ts`,
      "//server/share/a.ts",
      "file://server/share/a.ts",
    ]) {
      const result = parsed(`[a](${dest})`);
      assert.deepEqual(result.paths, [], dest);
      assert.equal(result.rejected.length, 1, dest);
    }
  });

  void it("rejects malformed, ambiguous and empty links with a reason", () => {
    for (const entry of [
      "[a](src/a.ts",
      "[a]",
      "[a]()",
      "[a](<src/a.ts)",
      "[a](src/a.ts#section)",
      "[a](src/a.ts?plain=1)",
      "[a](src/a%ZZ.ts)",
      "[a](src/a.ts) [b](src/b.ts) — two destinations",
      "[a](src/a.ts) `src/b.ts`",
    ]) {
      const result = parsed(entry);
      assert.deepEqual(result.paths, [], entry);
      assert.equal(result.rejected.length, 1, entry);
    }
  });

  void it("a second link after the description separator is description, not a destination", () => {
    assert.deepEqual(parsed("[a](src/a.ts) — see [docs](https://example.com)").paths, ["src/a.ts"]);
  });

  void it("an absolute destination without a known workspace root is rejected, not guessed", () => {
    const result = parseReportedFilesChangedV1(report(`[a](${ROOT}/src/a.ts)`));
    assert.deepEqual(result?.paths, []);
    assert.equal(result?.rejected.length, 1);
  });

  void describe("Windows forms", () => {
    const WIN = "C:\\Users\\dev\\proj";
    void it("resolves drive-letter destinations with either separator, case-insensitively", () => {
      assert.deepEqual(parsed("[a](C:\\Users\\dev\\proj\\src\\a.ts:3)", WIN).paths, ["src/a.ts"]);
      assert.deepEqual(parsed("[a](C:/Users/dev/proj/src/a.ts)", WIN).paths, ["src/a.ts"]);
      assert.deepEqual(parsed("[a](c:/users/dev/proj/src/a.ts)", WIN).paths, ["src/a.ts"]);
      assert.deepEqual(parsed("[a](/c:/Users/dev/proj/src/a.ts)", WIN).paths, ["src/a.ts"]);
      assert.deepEqual(parsed("[a](file:///c:/Users/dev/proj/src/my%20file.ts)", WIN).paths, ["src/my file.ts"]);
    });

    void it("rejects another drive, a POSIX path against a drive root, and a drive path against a POSIX root", () => {
      assert.deepEqual(parsed("[a](D:/Users/dev/proj/src/a.ts)", WIN).paths, []);
      assert.deepEqual(parsed("[a](/etc/passwd)", WIN).paths, []);
      assert.deepEqual(parsed("[a](C:/Users/dev/proj/src/a.ts)", ROOT).paths, []);
    });

    void it("normalizes backslash relative paths", () => {
      assert.deepEqual(parsed("[a](src\\utils\\a.ts)", WIN).paths, ["src/utils/a.ts"]);
    });
  });

  void it("a bare file.ts:12 token is a file with a line annotation, not a URL", () => {
    assert.deepEqual(parsed("src/a.ts:12 — x").paths, ["src/a.ts"]);
  });
});

void describe("normalizeRepositoryRelativePathV1", () => {
  void it("normalizes safe paths and refuses unsafe ones", () => {
    assert.equal(normalizeRepositoryRelativePathV1("./src//a/./b.ts"), "src/a/b.ts");
    assert.equal(normalizeRepositoryRelativePathV1("src\\a.ts"), "src/a.ts");
    for (const bad of ["", "/abs", "C:/x", "C:\\x", "a/../b", "..", "a\u0000b"]) {
      assert.equal(normalizeRepositoryRelativePathV1(bad), undefined, JSON.stringify(bad));
    }
  });
});

void describe("checklist-echo isolation", () => {
  void it("files named only inside the echoed checklist are never read as the round's changes", () => {
    const echoed = [
      "<!-- ensemble:implementation-checklist -->",
      "",
      "## Files Changed",
      "",
      "- [src/in-the-plan.ts](src/in-the-plan.ts:1) — a plan item that merely quotes a heading",
      "- [ ] Fix `src/also-plan.ts`",
      "",
      "## Plan Item Checklist",
      "",
      "- [x] done",
    ].join("\n");
    const result = parseReportedFilesChangedV1(echoed, {
      planChecklist: "<!-- ensemble:implementation-checklist -->\n\n- [ ] Fix `src/also-plan.ts`\n",
      workspaceRoot: ROOT,
    });
    assert.ok(result === undefined || result.paths.length === 0);
  });
});

void describe("captured bugs3 round (2026-10-28) replay", () => {
  const fixture = fs.readFileSync(
    path.join(__dirname, "..", "..", "src", "test", "fixtures", "review-scope-2026-10-28", "impl-report.md"),
    "utf8"
  );
  const SNAPSHOT = [
    "src/test/gitIndexLockV1.test.ts",
    "src/utils/gitIndexLockV1.ts",
    "src/utils/roundGitStateV1.ts",
    "src/utils/someConcurrentHandEdit.ts",
  ];

  void it("attributes all three reported source paths; the progress file, reported-only and snapshot-only files are not adopted", () => {
    const reported = parseReportedFilesChangedV1(fixture, { workspaceRoot: ROOT });
    assert.ok(reported);
    assert.equal(reported.entryCount, 4);
    assert.deepEqual(reported.rejected, []);
    const split = attributeImplementationRoundFilesV1(SNAPSHOT, reported.paths);
    assert.deepEqual(split.attributed.sort(), [
      "src/test/gitIndexLockV1.test.ts",
      "src/utils/gitIndexLockV1.ts",
      "src/utils/roundGitStateV1.ts",
    ]);
    // Only the genuinely concurrent edit stays unattributed; the progress file
    // is reported-only (the snapshot never saw it change) and is dropped.
    assert.deepEqual(split.unattributed, ["src/utils/someConcurrentHandEdit.ts"]);
    assert.equal(describeUnparsedFilesChangedReportV1(reported, SNAPSHOT), undefined);
  });

  void it("without the fix's understanding (an unparseable report) the outcome is a named report problem, never 'absent from the report'", () => {
    const garbled = report("[gitIndexLockV1.ts](https://example.com/gitIndexLockV1.ts) — x", "[broken](src/a.ts");
    const reported = parseReportedFilesChangedV1(garbled, { workspaceRoot: ROOT });
    assert.ok(reported);
    assert.deepEqual(reported.paths, []);
    assert.equal(reported.entryCount, 2);
    const issue = describeUnparsedFilesChangedReportV1(reported, SNAPSHOT);
    assert.ok(issue, "all entries unparseable while files changed must be a report problem");
    assert.match(issue, /could not be understood/);
    assert.match(issue, /gitIndexLockV1\.ts/);
    const section = describeUnattributedWorkspaceChangesSectionV1(SNAPSHOT, reported);
    assert.match(section, /reported-but-not-understood/);
    assert.doesNotMatch(section, /not in the round's own `## Files Changed` report/);
  });

  void it("a report naming only unchanged files is a legitimate empty intersection, not a report problem", () => {
    const reported = parseReportedFilesChangedV1(report("`src/unchanged.ts`"), { workspaceRoot: ROOT });
    assert.equal(describeUnparsedFilesChangedReportV1(reported, SNAPSHOT), undefined);
    const split = attributeImplementationRoundFilesV1(SNAPSHOT, reported?.paths);
    assert.deepEqual(split.attributed, []);
  });

  void it("with no Files Changed section the section text says so instead of claiming absence", () => {
    const section = describeUnattributedWorkspaceChangesSectionV1(SNAPSHOT, undefined);
    assert.match(section, /no parseable `## Files Changed` section/);
  });
});

void describe("captured round hand-off composition (bugs4 item 1 → item 2)", () => {
  void it("the attributed set banked by the hand-off becomes the next review's established scope, with and without a Plan row", () => {
    const fixture = fs.readFileSync(
      path.join(__dirname, "..", "..", "src", "test", "fixtures", "review-scope-2026-10-28", "impl-report.md"),
      "utf8"
    );
    const snapshot = [
      "src/test/gitIndexLockV1.test.ts",
      "src/utils/gitIndexLockV1.ts",
      "src/utils/roundGitStateV1.ts",
      "src/utils/someConcurrentHandEdit.ts",
    ];
    const reported = parseReportedFilesChangedV1(fixture, { workspaceRoot: ROOT });
    const { attributed } = attributeImplementationRoundFilesV1(snapshot, reported?.paths);
    // The hand-off's two writes: the tracked set and the ledger row's change list.
    const progress = updateImplReviewFiles({ implReviewFiles: [] } as unknown as TaskProgress, attributed);
    const ledger: ImplReviewLedgerRowV1[] = [
      { roundId: "d51eb029", stage: "plan", mode: "implementation", state: "completed" },
      { roundId: "9422f594", stage: "impl", mode: "implementation", state: "completed", outcome: { filesChanged: attributed } },
    ];
    for (const tracked of [progress.implReviewFiles ?? [], []]) {
      const scope = resolveImplementationReviewScopeV1(tracked, ledger, 50);
      assert.equal(scope.kind, "established");
      if (scope.kind === "established") {
        assert.deepEqual([...scope.files].sort(), [
          "src/test/gitIndexLockV1.test.ts",
          "src/utils/gitIndexLockV1.ts",
          "src/utils/roundGitStateV1.ts",
        ]);
      }
    }
  });
});

void describe("completed-Implementation hand-off (resolveCompletedRoundAttributionV1, the function reviewActions runs)", () => {
  const fixture = fs.readFileSync(
    path.join(__dirname, "..", "..", "src", "test", "fixtures", "review-scope-2026-10-28", "impl-report.md"),
    "utf8"
  );
  const SNAPSHOT = [
    "src/test/gitIndexLockV1.test.ts",
    "src/utils/gitIndexLockV1.ts",
    "src/utils/roundGitStateV1.ts",
    "src/utils/someConcurrentHandEdit.ts",
  ];
  const THREE = ["src/test/gitIndexLockV1.test.ts", "src/utils/gitIndexLockV1.ts", "src/utils/roundGitStateV1.ts"];

  void it("the captured report banks the three source paths; the next review receives exactly that set", () => {
    // Concurrent hand edit in the snapshot: never banked into the tracked set.
    const withConcurrent = resolveCompletedRoundAttributionV1({
      summary: fixture,
      workspaceRoot: ROOT,
      filesChanged: SNAPSHOT,
    });
    assert.deepEqual([...withConcurrent.attributed].sort(), THREE);
    assert.deepEqual(withConcurrent.unattributed, ["src/utils/someConcurrentHandEdit.ts"]);
    // The captured incident's snapshot held exactly the three source files.
    const handOff = resolveCompletedRoundAttributionV1({ summary: fixture, workspaceRoot: ROOT, filesChanged: THREE });
    assert.deepEqual([...handOff.attributed].sort(), THREE);
    assert.deepEqual(handOff.unattributed, []);
    // The hand-off's writes: tracked set (`implReviewFiles`) and the ledger row's change list.
    const progress = updateImplReviewFiles({ implReviewFiles: [] } as unknown as TaskProgress, handOff.attributed);
    const ledger: ImplReviewLedgerRowV1[] = [
      { roundId: "d51eb029", stage: "plan", mode: "implementation", state: "completed" },
      { roundId: "9422f594", stage: "impl", mode: "implementation", state: "completed", outcome: { filesChanged: THREE } },
    ];
    const scope = resolveImplementationReviewScopeV1(progress.implReviewFiles ?? [], ledger, 50);
    assert.equal(scope.kind, "established");
    if (scope.kind === "established") {
      assert.deepEqual([...scope.files].sort(), THREE);
    }
  });

  void it("with the plan checklist supplied, files named only in the echoed checklist are not adopted", () => {
    const withEcho = `${fixture}\n\n## Plan Item Checklist\n\n- Edit src/utils/someConcurrentHandEdit.ts — done\n`;
    const handOff = resolveCompletedRoundAttributionV1({
      summary: withEcho,
      planChecklist: "- [ ] Edit src/utils/someConcurrentHandEdit.ts",
      workspaceRoot: ROOT,
      filesChanged: SNAPSHOT,
    });
    assert.deepEqual([...handOff.attributed].sort(), THREE);
  });

  void it("a synthetic or unknown-change round banks the snapshot as-is and parses no report", () => {
    const synthetic = resolveCompletedRoundAttributionV1({
      summary: "no files section",
      workspaceRoot: ROOT,
      filesChanged: SNAPSHOT,
      summaryIsSynthetic: true,
    });
    assert.deepEqual(synthetic.attributed, SNAPSHOT);
    assert.equal(synthetic.reported, undefined);
    const unknown = resolveCompletedRoundAttributionV1({
      summary: fixture,
      workspaceRoot: ROOT,
      filesChanged: [],
      filesChangedUnknown: true,
    });
    assert.deepEqual(unknown.attributed, []);
  });

  void it("a model-authored report with no parseable section attributes nothing (fail closed)", () => {
    const handOff = resolveCompletedRoundAttributionV1({
      summary: "I did some work.",
      workspaceRoot: ROOT,
      filesChanged: SNAPSHOT,
    });
    assert.deepEqual(handOff.attributed, []);
    assert.deepEqual(handOff.unattributed, SNAPSHOT);
  });
});

void describe("one path identity across the run log, the ledger and the tracked scope (bugs4 item 1)", () => {
  void it("banks the snapshot's repository-relative spelling, never the report's spelling", () => {
    const snapshot = ["src/utils/gitIndexLockV1.ts", "src/test/gitIndexLockV1.test.ts"];
    const report = [
      "## Files Changed",
      "",
      "- [gitIndexLockV1.ts](" + ROOT + "/SRC/Utils/gitIndexLockV1.ts:1) — captures lock state.",
      "- `./src/test/gitIndexLockV1.test.ts` — test.",
    ].join("\n");
    const parsed = parseReportedFilesChangedV1(report, { workspaceRoot: ROOT });
    const { attributed, unattributed } = attributeImplementationRoundFilesV1(snapshot, parsed?.paths);
    // The same strings feed the chat/ledger change list (the snapshot) and
    // `implReviewFiles` (the attributed subset), so the three agree.
    assert.deepEqual([...attributed].sort(), [...snapshot].sort());
    assert.deepEqual(unattributed, []);
    const progress = updateImplReviewFiles({ implReviewFiles: [] } as unknown as TaskProgress, attributed);
    assert.deepEqual([...(progress.implReviewFiles ?? [])].sort(), [...snapshot].sort());
  });
});
