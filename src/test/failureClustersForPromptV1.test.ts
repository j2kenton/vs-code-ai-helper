/**
 * bugs3 Step 15: the fix prompt groups failing tests by file and carries one
 * complete assertion per group, largest group first, so the cause shared by
 * most failures (38 of 68 in one file) is visible rather than a cut-off name
 * list. Reported 2026-10-27 (bugs2, Publish).
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFailureClustersForPromptV1 } from "../commands/runLintingFixes";
import { extractFailingTestsV1, selectFailureClustersForPromptV1, type FailingTestClusterV1 } from "../utils/failingTestsV1";

function specOutput(entries: { file: string; title: string; message: string }[]): string {
  const lines = entries.map((entry) => `  ✖ ${entry.title} (3ms)`);
  lines.push("✖ failing tests:", "");
  for (const entry of entries) {
    lines.push(
      `test at ${entry.file}:10:5`,
      `✖ ${entry.title} (3ms)`,
      `  ${entry.message}`,
      "      at TestContext.<anonymous> (file.js:1:1)",
      "      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)",
      ""
    );
  }
  lines.push(`ℹ tests ${entries.length + 5}`, "ℹ pass 5", `ℹ fail ${entries.length}`);
  return lines.join("\n");
}

const CAUSE = "AssertionError [ERR_ASSERTION]: report is missing the '## Plan Item Checklist' section";

void describe("failing tests grouped by file with one assertion each (bugs3 Step 15)", () => {
  const entries = [
    ...Array.from({ length: 6 }, (_, index) => ({ file: "out/test/deferredRoundRecovery.test.js", title: `fixture ${index}`, message: CAUSE })),
    { file: "out/test/a.test.js", title: "wording", message: "AssertionError: expected 'x' to match /y/" },
    { file: "out/test/a.test.js", title: "wording two", message: "AssertionError: other" },
    { file: "out/test/b.test.js", title: "scan", message: "AssertionError: scan" },
  ];

  void it("groups by test file, largest first, with the group's own assertion and no stack", () => {
    const summary = extractFailingTestsV1(specOutput(entries));
    const clusters = summary.clusters ?? [];
    assert.deepEqual(
      clusters.map((cluster) => [cluster.file, cluster.count]),
      [
        ["out/test/deferredRoundRecovery.test.js", 6],
        ["out/test/a.test.js", 2],
        ["out/test/b.test.js", 1],
      ]
    );
    assert.equal(clusters[0]?.assertion, CAUSE);
    assert.doesNotMatch(clusters[0]?.assertion ?? "", /TestContext|at process/);
    assert.equal(clusters[0]?.titles.length, 3, "a few example titles, not the whole list");
    assert.equal(clusters[1]?.assertion, "AssertionError: expected 'x' to match /y/", "the first assertion of the group");
  });

  void it("a many-line assertion is never cut silently at a line count: only the character cap cuts it, with a marker", () => {
    const manyLines = Array.from({ length: 250 }, (_, index) => `    ln ${index}`).join("\n  ");
    const whole = extractFailingTestsV1(specOutput([{ file: "out/test/m.test.js", title: "m", message: `AssertionError: diff\n  ${manyLines}` }]));
    const text = whole.clusters?.[0]?.assertion ?? "";
    assert.match(text, /ln 249/, "the last line of a 250-line message under the character cap is kept, not dropped at 160 lines");
    assert.doesNotMatch(text, /assertion cut/);
    const huge = Array.from({ length: 6000 }, (_, index) => `    row ${index} of the diff`).join("\n  ");
    const cut = extractFailingTestsV1(specOutput([{ file: "out/test/m.test.js", title: "m", message: `AssertionError:\n  ${huge}` }]));
    assert.match(cut.clusters?.[0]?.assertion ?? "", /assertion cut at 70000 characters/);
  });

  void it("shows a sibling's whole message when the group's first failure carries an over-long one", () => {
    const longMessage = `AssertionError: diff\n${"- expected line\n+ actual line\n".repeat(2600)}`;
    const summary = extractFailingTestsV1(
      specOutput([
        { file: "out/test/big.test.js", title: "first with a huge diff", message: longMessage },
        { file: "out/test/big.test.js", title: "second", message: CAUSE },
        { file: "out/test/big.test.js", title: "third", message: CAUSE },
      ])
    );
    const assertion = summary.clusters?.[0]?.assertion ?? "";
    assert.equal(assertion, CAUSE, "a complete message is preferred over a cut one");
    assert.doesNotMatch(assertion, /assertion cut at/);
  });

  void it("cuts the shortest message with a marker only when every message in the group is too long", () => {
    const longMessage = (lines: number): string => `AssertionError: diff\n${"- expected line\n+ actual line\n".repeat(lines)}`;
    const summary = extractFailingTestsV1(
      specOutput([
        { file: "out/test/big.test.js", title: "a", message: longMessage(2700) },
        { file: "out/test/big.test.js", title: "b", message: longMessage(2400) },
      ])
    );
    const assertion = summary.clusters?.[0]?.assertion ?? "";
    assert.match(assertion, /assertion cut at 70000 characters/);
    assert.ok(assertion.startsWith("AssertionError: diff"));
  });

  void it("keeps a long assertion bounded, and omits the field when the output carries none", () => {
    const long = extractFailingTestsV1(specOutput([{ file: "out/test/l.test.js", title: "long", message: `AssertionError: ${"z".repeat(90_000)}` }]));
    const largest = long.clusters?.[0]?.assertion?.length ?? 0;
    assert.ok(largest > 6200 && largest <= 70_200, "an assertion longer than the whole prompt budget is bounded by the single per-group cap");
    assert.match(long.clusters?.[0]?.assertion ?? "", /assertion cut at 70000 characters/, "a cut assertion says it was cut");
    const fits = extractFailingTestsV1(specOutput([{ file: "out/test/l.test.js", title: "fits", message: `AssertionError: ${"z".repeat(40_000)}` }]));
    assert.equal(
      fits.clusters?.[0]?.assertion,
      `AssertionError: ${"z".repeat(40_000)}`,
      "a lone 40,000-character assertion fits the 70,000-character prompt budget, so it is kept whole"
    );
    const mid = extractFailingTestsV1(specOutput([{ file: "out/test/l.test.js", title: "mid", message: `AssertionError: ${"z".repeat(20_000)}` }]));
    assert.doesNotMatch(mid.clusters?.[0]?.assertion ?? "", /assertion cut/, "a 20,000-character assertion in the largest group is kept whole");
    const two = extractFailingTestsV1(
      specOutput([
        { file: "out/test/big.test.js", title: "a", message: "AssertionError: big" },
        { file: "out/test/big.test.js", title: "b", message: "AssertionError: big" },
        { file: "out/test/small.test.js", title: "c", message: `AssertionError: ${"y".repeat(9000)}` },
      ])
    );
    assert.equal(two.clusters?.[0]?.file, "out/test/big.test.js");
    const second = two.clusters?.[1]?.assertion ?? "";
    assert.equal(second.length, `AssertionError: ${"y".repeat(9000)}`.length, "a second group's 9,000-character assertion is kept whole, not cut at a rank cap");
    assert.doesNotMatch(second, /assertion cut/);
    const tail = extractFailingTestsV1(
      specOutput(
        Array.from({ length: 12 }, (_, group) => ({
          file: `out/test/g${String(group).padStart(2, "0")}.test.js`,
          title: `t${group}`,
          message: `AssertionError: ${"w".repeat(5000)}`,
        }))
      )
    );
    const last = tail.clusters?.[11]?.assertion ?? "";
    assert.equal(last, `AssertionError: ${"w".repeat(5000)}`, "a tail group's 5,000-character assertion is kept whole too; the prompt budget decides how many groups are included");
    const multiline = extractFailingTestsV1(
      specOutput([
        {
          file: "out/test/m.test.js",
          title: "diff",
          message: ["AssertionError: Expected values to be strictly equal:", ...Array.from({ length: 80 }, (_, i) => `  line ${i}`)].join("\n"),
        },
      ])
    );
    assert.match(multiline.clusters?.[0]?.assertion ?? "", /line 79/, "an 80-line assertion is not cut at 40 lines");
    const bare = extractFailingTestsV1(["▶ s", "  ✖ lone failure (1ms)", "ℹ tests 2", "ℹ pass 1", "ℹ fail 1"].join("\n"));
    assert.equal(bare.clusters?.[0]?.assertion, undefined);
    assert.equal(bare.clusters?.[0]?.file, "(test file not reported)");
  });

  void it("always keeps the largest group within the budget and says how many were left out", () => {
    const clusters: FailingTestClusterV1[] = Array.from({ length: 5 }, (_, index) => ({
      file: `out/test/f${index}.test.js`,
      count: 10 - index,
      titles: ["t"],
      assertion: "x".repeat(400),
    }));
    const tight = selectFailureClustersForPromptV1(clusters, 100);
    assert.equal(tight.clusters.length, 1);
    assert.equal(tight.clusters[0]?.file, "out/test/f0.test.js");
    assert.equal(tight.omitted, 4);
    const roomy = selectFailureClustersForPromptV1(clusters, 100_000);
    assert.equal(roomy.omitted, 0);
  });

  void it("charges the largest group its real size and never cuts a later group's assertion to make it fit", () => {
    const big: FailingTestClusterV1 = { file: "out/test/big.test.js", count: 9, titles: ["t"], assertion: "b".repeat(1000) };
    const medium: FailingTestClusterV1 = { file: "out/test/medium.test.js", count: 5, titles: ["t"], assertion: "m".repeat(1000) };
    const small: FailingTestClusterV1 = { file: "out/test/small.test.js", count: 2, titles: ["t"], assertion: "s".repeat(100) };
    // Room for the largest and the small group, but not the medium one in between.
    const selected = selectFailureClustersForPromptV1([big, medium, small], 1300);
    assert.deepEqual(
      selected.clusters.map((cluster) => cluster.file),
      ["out/test/big.test.js", "out/test/small.test.js"],
      "a group that does not fit whole is left out; a smaller one after it still fits"
    );
    assert.equal(selected.omitted, 1);
    for (const cluster of selected.clusters) {
      assert.ok(!(cluster.assertion ?? "").includes("assertion cut"), "included assertions are whole");
    }
    // The second group's 9,000 characters fit a roomy budget whole.
    const nine: FailingTestClusterV1 = { ...medium, assertion: "n".repeat(9000) };
    assert.equal(selectFailureClustersForPromptV1([big, nine], 20_000).clusters[1]?.assertion?.length, 9000);
  });

  void it("builds the prompt's clusters across checks, biggest first, naming the command", () => {
    const built = buildFailureClustersForPromptV1([
      { command: "pnpm run lint", failingTests: extractFailingTestsV1(specOutput(entries.slice(6))) },
      { command: "pnpm run verify", failingTests: extractFailingTestsV1(specOutput(entries)) },
    ]);
    assert.equal(built[0]?.file, "out/test/deferredRoundRecovery.test.js");
    assert.equal(built[0]?.command, "pnpm run verify");
    assert.equal(built[0]?.failingTests, 6);
    assert.equal(built[0]?.assertion, CAUSE);
  });

  void it("builds nothing when no check listed failing tests", () => {
    assert.deepEqual(buildFailureClustersForPromptV1([{ command: "pnpm run lint" }]), []);
  });
});
