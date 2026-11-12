/**
 * bugs7 item 1 / Step 8: one resolver for "this item's test files", used by the claim matcher and the evidence-gap
 * matcher. A report that names its test files by module name counts when those files ran and passed; a same-named file
 * in another folder does not stand in for it; the whole evidence sentence is never a path.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { parseRunRecordRoundFilesV1, readRoundChangedTestFilesV1, scanKnownTestFilesV1 } from "../commands/itemTestFilesContextV1";
import { identifyItemTestFilesDetailV1, matchPassedOutputToItemsV1 } from "../utils/evidenceGapV1";
import {
  diagnoseApplicablePassingTestReportForItemV1,
  reportCommandCoversTestIdentityV1,
} from "../utils/implementationChecklist";
import {
  commandCoversTestFileV1,
  resolveItemTestFilesV1,
  testPathKeyV1,
  type ItemTestFilesContextV1,
} from "../utils/itemTestFilesV1";

const ITEM = "Step 11: Add tests for the stopped-before-any-round line";
const PLAN = ["<!-- ensemble:implementation-checklist -->", `- [x] ${ITEM}`].join("\n");

const KNOWN = [
  "src/test/rerunReviewViewerRelayV1.test.ts",
  "src/test/fastForwardStoppedBeforeAnyRoundV1.test.ts",
  "src/test/partialScopeFastForwardContinueV1.test.ts",
  "src/test/modelsAndStageLabelsV1.test.ts",
  "src/test/x.test.ts",
  "src/test/other.test.ts",
];
const CONTEXT: ItemTestFilesContextV1 = { knownTestFiles: KNOWN };

function report(evidence: string, command: string): string {
  return [
    "## Files Changed",
    "- src/utils/x.ts",
    "## Plan Item Checklist",
    `- ${ITEM} — done — ${evidence}`,
    "## Verification",
    `- \`${command}\` — **12 passed, 0 failed**, on the working tree after all edits`,
  ].join("\n");
}

const diagnose = (evidence: string, command: string, context: ItemTestFilesContextV1 | undefined = CONTEXT) =>
  diagnoseApplicablePassingTestReportForItemV1(PLAN, ITEM, report(evidence, command), context);

void describe("the claim matcher counts a report that names its tests by module name (bugs7 item 1)", () => {
  void it("the 2026-11-11 round: three bare backticked names, run by one command with `.test.ts` paths", () => {
    const command =
      "pnpm run test:unit -- src/test/rerunReviewViewerRelayV1.test.ts src/test/fastForwardStoppedBeforeAnyRoundV1.test.ts src/test/partialScopeFastForwardContinueV1.test.ts src/test/modelsAndStageLabelsV1.test.ts";
    const out = diagnose(
      "`fastForwardStoppedBeforeAnyRoundV1`, `rerunReviewViewerRelayV1` and `partialScopeFastForwardContinueV1` tests pass",
      command
    );
    assert.equal(out.kind, "applicable", out.kind === "not-applicable" ? out.reason : "");
  });

  const spellings: ReadonlyArray<readonly [string, string]> = [
    ["a path with the suffix", "`src/test/x.test.ts` passes"],
    ["the file name with the suffix", "`x.test.ts` passes"],
    ["the bare name", "`x` passes"],
    ["a sentence", "the x tests pass"],
  ];
  for (const [label, evidence] of spellings) {
    void it(`counts ${label} when x ran and passed, and not when it did not`, () => {
      const ran = diagnose(evidence, "pnpm run test:unit -- src/test/x.test.ts");
      assert.equal(ran.kind, "applicable", ran.kind === "not-applicable" ? ran.reason : "");
      const notRan = diagnose(evidence, "pnpm run test:unit -- src/test/other.test.ts");
      assert.equal(notRan.kind, "not-applicable");
    });
  }

  void it("never reads the whole evidence sentence as a test path", () => {
    const out = diagnose("the new behaviour is covered and green", "pnpm run test:unit -- src/test/x.test.ts");
    assert.equal(out.kind, "not-applicable");
    assert.match(out.kind === "not-applicable" ? out.reason : "", /no test file could be identified|names no test file/);
  });

  void it("an item whose plan text only describes its tests takes the files its round changed", () => {
    const context: ItemTestFilesContextV1 = { knownTestFiles: KNOWN, roundChangedTestFiles: ["src/test/x.test.ts"] };
    const out = diagnose("covered by the new unit tests, all green", "pnpm run test:unit -- src/test/x.test.ts", context);
    assert.equal(out.kind, "applicable", out.kind === "not-applicable" ? out.reason : "");
  });
});

void describe("file identity, not stem (bugs7 item 1, review fix)", () => {
  const known = ["packages/a/x.test.ts", "packages/b/x.test.ts", "src/test/other.test.ts"];

  void it("a passing run of packages/a/x.test.ts does not settle an item that names packages/b/x.test.ts", () => {
    assert.equal(commandCoversTestFileV1(["packages/a/x.test.ts"], "packages/b/x.test.ts", { knownTestFiles: known }), false);
    assert.equal(commandCoversTestFileV1(["packages/a/x.test.ts"], "packages/b/x.test.ts"), false);
    assert.equal(commandCoversTestFileV1(["packages/b/x.test.ts"], "packages/b/x.test.ts", { knownTestFiles: known }), true);
  });

  void it("an item naming only `x` is ambiguous and stays provisional unless exactly one candidate is among its round's files", () => {
    const ambiguous = resolveItemTestFilesV1({ itemText: "Add tests for `x`", context: { knownTestFiles: known } });
    assert.deepEqual(ambiguous.files, []);
    assert.equal(ambiguous.ambiguous[0]?.name, "x");
    assert.deepEqual([...(ambiguous.ambiguous[0]?.candidates ?? [])].sort(), ["packages/a/x.test.ts", "packages/b/x.test.ts"]);
    const matched = matchPassedOutputToItemsV1(
      [{ itemText: "Add tests for `x`", testFiles: ambiguous.files, ambiguous: ambiguous.ambiguous }],
      ["packages/a/x.test.ts"],
      { knownTestFiles: known }
    );
    assert.equal(matched.recordable.length, 0);
    assert.match(matched.unidentified[0]!.reason, /could be more than one test file/);
    const tied = resolveItemTestFilesV1({
      itemText: "Add tests for `x`",
      context: { knownTestFiles: known, roundChangedTestFiles: ["packages/b/x.test.ts"] },
    });
    assert.deepEqual(tied.files, ["packages/b/x.test.ts"]);
  });

  void it("`out/test/x.test.js` settles an item naming `src/test/x.test.ts`", () => {
    assert.equal(testPathKeyV1("out/test/x.test.js"), testPathKeyV1("src/test/x.test.ts"));
    assert.equal(commandCoversTestFileV1(["out/test/x.test.js"], "src/test/x.test.ts", CONTEXT), true);
    assert.equal(commandCoversTestFileV1(["out/test/x.test.js"], "src/test/x.test.ts"), true);
    assert.equal(reportCommandCoversTestIdentityV1("node --test out/test/x.test.js", "src/test/x.test.ts"), true);
  });

  void it("a bare token run in packages/b resolves to the file under packages/b", () => {
    const context: ItemTestFilesContextV1 = { knownTestFiles: known };
    assert.equal(commandCoversTestFileV1(["x"], "packages/b/x.test.ts", context, { baseDir: "packages/b" }), true);
    assert.equal(commandCoversTestFileV1(["x"], "packages/a/x.test.ts", context, { baseDir: "packages/b" }), false);
    assert.equal(commandCoversTestFileV1(["x"], "packages/b/x.test.ts", context), false);
  });

  void it("a source file name and a bare word do not name a test file", () => {
    assert.deepEqual(resolveItemTestFilesV1({ itemText: "Change `other.ts` and `test`", context: CONTEXT }).files, []);
    assert.equal(commandCoversTestFileV1(["test", "run"], "src/test/x.test.ts", CONTEXT), false);
  });

  void it("a directory the runner was pointed at covers the tests under it", () => {
    assert.equal(commandCoversTestFileV1(["src/test/"], "src/test/x.test.ts", CONTEXT), true);
    assert.equal(commandCoversTestFileV1(["src/other/"], "src/test/x.test.ts", CONTEXT), false);
  });
});

void describe("a full-suite run settles the items whose files came from their rounds (bugs7 item 1, additional occurrence)", () => {
  void it("the item's text describes its tests; the round that built it added the files", () => {
    const known = ["src/test/roundClockAndEarlyStopV1.test.ts", "src/test/roundShellAllowlistV1.test.ts", "src/test/unrelatedV1.test.ts"];
    const resolved = identifyItemTestFilesDetailV1("Add unit tests for the round clock and shell rule", [], {
      knownTestFiles: known,
      roundChangedTestFiles: ["src/test/roundClockAndEarlyStopV1.test.ts", "src/test/roundShellAllowlistV1.test.ts"],
    });
    assert.equal(resolved.source, "round");
    const matched = matchPassedOutputToItemsV1(
      [{ itemText: "Step 16", testFiles: resolved.files }],
      ["out/test/roundClockAndEarlyStopV1.test.js", "out/test/roundShellAllowlistV1.test.js"],
      { knownTestFiles: known }
    );
    assert.equal(matched.recordable.length, 1);
    const partial = matchPassedOutputToItemsV1([{ itemText: "Step 16", testFiles: resolved.files }], ["out/test/roundClockAndEarlyStopV1.test.js"], {
      knownTestFiles: known,
    });
    assert.equal(partial.recordable.length, 0);
  });
});

void describe("the host-side context reads real folders (bugs7 item 1, Step 2)", () => {
  void it("scans known test files, skipping node_modules and out, and reads the rounds' changed test files from run records", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "item-test-files-"));
    try {
      fs.mkdirSync(path.join(root, "src/test"), { recursive: true });
      fs.mkdirSync(path.join(root, "node_modules/pkg"), { recursive: true });
      fs.mkdirSync(path.join(root, "out/test"), { recursive: true });
      fs.writeFileSync(path.join(root, "src/test/a.test.ts"), "");
      fs.writeFileSync(path.join(root, "node_modules/pkg/skip.test.ts"), "");
      fs.writeFileSync(path.join(root, "out/test/a.test.js"), "");
      const scan = await scanKnownTestFilesV1(root);
      assert.deepEqual(scan.files, ["src/test/a.test.ts"]);
      assert.equal(scan.capped, false);
      assert.equal((await scanKnownTestFilesV1(root, 0)).capped, true);

      const taskFolder = path.join(root, ".ensemble/t1");
      fs.mkdirSync(path.join(taskFolder, "runs"), { recursive: true });
      const record = "# Implementation Run\n\nRound ID: AAA-1\nPrompt Round ID: bbb2\n\nStatus: completed\n\nFiles changed:\n- src/x.ts\n- src/test/a.test.ts\n\nSummary";
      fs.writeFileSync(path.join(taskFolder, "runs", "005-impl.md"), record);
      assert.deepEqual(parseRunRecordRoundFilesV1(record).files, ["src/x.ts", "src/test/a.test.ts"]);
      assert.deepEqual(await readRoundChangedTestFilesV1(taskFolder, ["aaa-1"]), ["src/test/a.test.ts"]);
      assert.deepEqual(await readRoundChangedTestFilesV1(taskFolder, ["other"]), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
