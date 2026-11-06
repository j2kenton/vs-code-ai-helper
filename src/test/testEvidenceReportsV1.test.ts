/**
 * review1 Steps 12-16 (bugs6 item 11, review1 item 1): passing test reports count wherever the round put its
 * sections and however it wrote the post-edit statement; every rejection reason is true; a report is carried
 * across rounds while its own files are unchanged; and a clean review's suggestions are left alone.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, describe, it } from "node:test";

import type { PlanItemTestReportV1, TaskProgress } from "../types/taskProgress";
import { buildSuggestionsGuidanceV1, LEAVE_SUGGESTIONS_ALONE_GUIDANCE_V1 } from "../utils/fastForwardSuggestionsGuidanceV1";
import {
  diagnoseApplicablePassingTestReportForItemV1,
  listUncountedTestReportClaimsV1,
  mergeChecklistProgressV1,
  splitSummaryAtEchoV1,
} from "../utils/implementationChecklist";
import {
  computeTestDependencyStatesV1,
  MAX_TEST_DEPENDENCY_STATES_V1,
  isTestRunConfigFileV1,
  testDependencyStatesStillCurrentV1,
} from "../utils/testDependencyStateV1";
import { invalidatePlanItemEvidenceForChangedFilesV1, recordPlanItemTestReportV1 } from "../utils/taskProgressTransforms";

const STEP_7 = "**Step 7: Write the tests for Part 1.**";
const STEP_17 = "**Step 17: Write the tests for Part 2.**";
const STEP_22 = "**Step 22: Write the tests for Part 3.**";

const PLAN = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  `- [x] ${STEP_7}`,
  `- [x] ${STEP_17}`,
  `- [x] ${STEP_22}`,
  "",
].join("\n");

const CLAIMS = [
  `- ${STEP_7} — done — test: planItemIdentityV1.test.ts (179 passed)`,
  `- ${STEP_17} — done — test: planItemCountsV1.test.ts (84 passed)`,
  `- ${STEP_22} — done — test: testEvidenceReportsV1.test.ts (139 passed)`,
];

const COMMANDS = [
  "- `pnpm run test:unit -- src/test/planItemIdentityV1.test.ts` — 179 passed, 0 failed.",
  "- `pnpm run test:unit -- src/test/planItemCountsV1.test.ts` — 84 passed, 0 failed.",
  "- `pnpm run test:unit -- src/test/testEvidenceReportsV1.test.ts` — 139 passed, 0 failed.",
];

/** The shape of chat1's runs/029: Verification says the runs were on the working tree after the edit. */
const RUN_029 = [
  "## Files Changed",
  "",
  "- src/utils/implementationChecklist.ts",
  "",
  "## Plan Item Checklist",
  "",
  ...CLAIMS,
  "",
  "## Verification",
  "",
  ...COMMANDS,
  "",
  "Both test runs were on the working tree after the edit.",
].join("\n");

/** runs/033: no files changed; "the current working tree, with no source edits between runs and none made this round". */
const RUN_033 = [
  "## Files Changed",
  "",
  "None.",
  "",
  "## Plan Item Checklist",
  "",
  ...CLAIMS,
  "",
  "## Verification",
  "",
  ...COMMANDS,
  "",
  "All three commands ran on the current working tree, with no source edits between runs and none made this round.",
].join("\n");

/** runs/037: `## Plan Item Checklist` and `## Verification` come BEFORE `## Files Changed` (line 17 vs 38). */
const RUN_037 = [
  "# Summary",
  "",
  "Re-ran the three test sets.",
  "",
  "## Plan Item Checklist",
  "",
  ...CLAIMS,
  "",
  "## Verification",
  "",
  ...COMMANDS,
  "",
  "**Source state tested:** the working tree at HEAD `0b14378…`; each run tested the same final source.",
  "",
  "## Files Changed",
  "",
  "None.",
].join("\n");

function diagnose(report: string, item: string) {
  return diagnoseApplicablePassingTestReportForItemV1(PLAN, item, report);
}

void describe("chat1's rejected reports count (bugs6 item 11 replay)", () => {
  for (const [name, run] of [["runs/029", RUN_029], ["runs/033", RUN_033], ["runs/037", RUN_037]] as const) {
    void it(`${name}: Steps 7, 17 and 22 all count as passing test reports`, () => {
      for (const item of [STEP_7, STEP_17, STEP_22]) {
        const diagnosis = diagnose(run, item);
        assert.equal(diagnosis.kind, "applicable", diagnosis.kind === "not-applicable" ? diagnosis.reason : "");
      }
      assert.deepEqual(listUncountedTestReportClaimsV1(PLAN, run), []);
    });
  }

  void it("runs/037's two sections before `## Files Changed` are the round's own text, not echo", () => {
    const { echo, own } = splitSummaryAtEchoV1(RUN_037);
    assert.equal(echo, "");
    assert.match(own, /## Plan Item Checklist/);
    assert.match(own, /## Verification/);
  });

  void it("an echoed plan followed by the round's own sections: the echo ends at the reproduced checklist (review1 Step 12)", () => {
    const response = [
      "<!-- ensemble:implementation-checklist -->",
      `- [x] ${STEP_7}`,
      "",
      "## Plan Item Checklist",
      "",
      CLAIMS[0],
      "",
      "## Verification",
      "",
      COMMANDS[0],
      "",
      "Both runs were on the working tree after the edit.",
      "",
      "## Files Changed",
      "",
      "- src/a.ts",
    ].join("\n");
    const { echo, own } = splitSummaryAtEchoV1(response);
    assert.match(echo, /^<!-- ensemble:implementation-checklist -->/);
    assert.doesNotMatch(echo, /## Plan Item Checklist/);
    assert.match(own, /## Plan Item Checklist/);
    assert.match(own, /## Verification/);
    assert.ok(own.includes("## Files Changed"));
    assert.equal(diagnose(response, STEP_7).kind, "applicable");
  });

  void it("a Verification heading the echoed plan already carried starts the round's own text", () => {
    const response = [
      "<!-- ensemble:implementation-checklist -->",
      `- [x] ${STEP_7}`,
      "",
      "## Verification",
      "",
      "- [ ] The plan's own verification",
      "",
      "## Verification",
      "",
      COMMANDS[0],
      "",
      "## Files Changed",
      "",
      "- src/a.ts",
    ].join("\n");
    const { echo, own } = splitSummaryAtEchoV1(response);
    assert.match(echo, /The plan's own verification/);
    assert.doesNotMatch(echo, /test:unit/);
    assert.match(own, /test:unit/);
  });

  void it("a plan with no Verification heading: the round's Verification before its Plan Item Checklist is its own text (review1 Step 12)", () => {
    const response = [
      "<!-- ensemble:implementation-checklist -->",
      `- [x] ${STEP_7}`,
      `- [x] ${STEP_17}`,
      `- [x] ${STEP_22}`,
      "",
      "## Verification",
      "",
      ...COMMANDS,
      "",
      "Ran on the edited tree.",
      "",
      "## Plan Item Checklist",
      "",
      ...CLAIMS,
      "",
      "## Files Changed",
      "",
      "- src/a.ts",
    ].join("\n");
    const split = splitSummaryAtEchoV1(response, PLAN);
    assert.doesNotMatch(split.echo, /test:unit/);
    assert.match(split.own, /test:unit/);
    for (const item of [STEP_7, STEP_17, STEP_22]) {
      const diagnosis = diagnose(response, item);
      assert.equal(diagnosis.kind, "applicable", diagnosis.kind === "not-applicable" ? diagnosis.reason : "");
    }
  });

  void it("a heading the plan itself repeats does not end the echo (review1 Step 12)", () => {
    const planWithRepeats = [
      "<!-- ensemble:implementation-checklist -->",
      "## Notes",
      `- [x] ${STEP_7}`,
      "## Notes",
      `- [x] ${STEP_17}`,
      "## Verification",
      `- [ ] The plan's own verification`,
    ].join("\n");
    const response = [planWithRepeats, "", "## Verification", "", "ran", "", "## Files Changed", "", "- a.ts"].join("\n");
    const withPlan = splitSummaryAtEchoV1(response, planWithRepeats);
    assert.match(withPlan.echo, /## Notes[\s\S]*## Notes/);
    assert.match(withPlan.own, /^## Verification\n\nran/m);
    const withoutPlan = splitSummaryAtEchoV1(response);
    assert.match(withoutPlan.echo, /## Notes[\s\S]*## Notes/);
  });

  void it("a section order of Verification, Plan Item Checklist, Files Changed works too", () => {
    const reordered = ["## Verification", "", ...COMMANDS, "", "Ran on the edited tree.", "", "## Plan Item Checklist", "", ...CLAIMS, "", "## Files Changed", "", "- src/a.ts"].join("\n");
    assert.equal(diagnose(reordered, STEP_7).kind, "applicable");
  });

  void it("the merge reads a claim from a section above Files Changed", () => {
    const plan = PLAN.replace(/- \[x\]/g, "- [ ]");
    const merged = mergeChecklistProgressV1(plan, RUN_037);
    assert.equal(merged.kind, "merged");
  });
});

void describe("a report that does not count says a true reason (bugs6 item 11, review1 Step 14)", () => {
  void it("a failing run is still rejected, naming the missing counts", () => {
    const failing = RUN_029.replace("179 passed, 0 failed", "178 passed, 1 failed");
    const diagnosis = diagnose(failing, STEP_7);
    assert.equal(diagnosis.kind, "not-applicable");
    if (diagnosis.kind === "not-applicable") assert.match(diagnosis.reason, /did not report “N passed” and “0 failed”/);
  });

  void it("a report that says the tests ran before the edits is rejected, quoting the line", () => {
    const stale = RUN_029.replace("Both test runs were on the working tree after the edit.", "These ran before the edits, so re-run them.");
    const diagnosis = diagnose(stale, STEP_7);
    assert.equal(diagnosis.kind, "not-applicable");
    if (diagnosis.kind === "not-applicable") assert.match(diagnosis.reason, /ran before this round's edits/);
  });

  void it("a section that is really missing is reported as missing, with what to add", () => {
    const noVerification = ["## Files Changed", "", "- src/a.ts", "", "## Plan Item Checklist", "", ...CLAIMS].join("\n");
    const diagnosis = diagnose(noVerification, STEP_7);
    assert.equal(diagnosis.kind, "not-applicable");
    if (diagnosis.kind === "not-applicable") {
      assert.match(diagnosis.reason, /has no `## Verification` section \(add one/);
    }
  });
});

const ROOT = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ensemble-test-evidence-"));
after(() => {
  nodeFs.rmSync(ROOT, { recursive: true, force: true });
});

function write(relative: string, content: string): void {
  const absolute = nodePath.join(ROOT, relative);
  nodeFs.mkdirSync(nodePath.dirname(absolute), { recursive: true });
  nodeFs.writeFileSync(absolute, content, "utf8");
}

void describe("a passing report is carried forward while its own files are unchanged (Step 15)", () => {
  write("package.json", "{}");
  write("pnpm-lock.yaml", "lockfileVersion: 9\n");
  write("tsconfig.json", "{}");
  write("src/unrelated.ts", "export const unrelated = 1;\n");
  write("src/helper.ts", "export const helper = 1;\n");
  write("src/test/feature.test.ts", "import { helper } from \"../helper\";\nexport const used = helper;\n");

  async function recordedReport(): Promise<{ progress: TaskProgress; report: PlanItemTestReportV1 }> {
    const states = await computeTestDependencyStatesV1(ROOT, ["src/test/feature.test.ts", "pnpm run test:unit -- src/test/feature.test.ts"]);
    const report: PlanItemTestReportV1 = {
      at: "2026-11-03T06:00:00.000Z",
      roundId: "round-1",
      testIdentity: "src/test/feature.test.ts",
      command: "pnpm run test:unit -- src/test/feature.test.ts",
      passed: 3,
      failed: 0,
      sourceState: "post-edit source state",
      sourceFiles: ["src/unrelated.ts", "src/helper.ts"],
      testDependencyStates: states,
    };
    const progress = recordPlanItemTestReportV1({} as TaskProgress, {
      planRevision: "r".repeat(64),
      itemText: "Write the tests for the feature",
      report,
    });
    return { progress, report };
  }

  void it("records the test file, its direct imports, and the config files", async () => {
    const { report } = await recordedReport();
    const paths = (report.testDependencyStates ?? []).map((state) => state.path).sort();
    assert.deepEqual(paths, ["package.json", "pnpm-lock.yaml", "src/helper.ts", "src/test/feature.test.ts", "tsconfig.json"]);
    assert.equal(await testDependencyStatesStillCurrentV1(report.testDependencyStates ?? [], ROOT), true);
  });

  void it("survives an edit to an unrelated file", async () => {
    const { progress } = await recordedReport();
    write("src/unrelated.ts", "export const unrelated = 2;\n");
    const after = invalidatePlanItemEvidenceForChangedFilesV1(progress, { changedFiles: ["src/unrelated.ts"] });
    assert.equal(after.planItemEvidence?.[0]?.testReports?.length, 1, "the carried report stays");
    assert.equal(await testDependencyStatesStillCurrentV1(after.planItemEvidence?.[0]?.testReports?.[0]?.testDependencyStates ?? [], ROOT), true);
  });

  for (const [what, file, edit] of [
    ["its test file", "src/test/feature.test.ts", "// edited\nimport { helper } from \"../helper\";\nexport const used = helper;\n"],
    ["a file it imports", "src/helper.ts", "export const helper = 2;\n"],
    ["the lockfile", "pnpm-lock.yaml", "lockfileVersion: 10\n"],
  ] as const) {
    void it(`drops after an edit to ${what}`, async () => {
      const original = nodeFs.readFileSync(nodePath.join(ROOT, file), "utf8");
      const { progress, report } = await recordedReport();
      write(file, edit);
      try {
        const after = invalidatePlanItemEvidenceForChangedFilesV1(progress, { changedFiles: [file] });
        assert.deepEqual(after.planItemEvidence?.[0]?.testReports, [], `${what} changed, so the report is dropped`);
        assert.equal(await testDependencyStatesStillCurrentV1(report.testDependencyStates ?? [], ROOT), false);
      } finally {
        write(file, original);
      }
    });
  }

  void it("drops after a test-runner config file is added after the report was recorded", async () => {
    const { progress, report } = await recordedReport();
    const added = "jest.config.js";
    write(added, "module.exports = {};\n");
    try {
      const after = invalidatePlanItemEvidenceForChangedFilesV1(progress, { changedFiles: [added] });
      assert.equal(await testDependencyStatesStillCurrentV1(report.testDependencyStates ?? [], ROOT), false);
      assert.ok(after.planItemEvidence);
    } finally {
      nodeFs.rmSync(nodePath.join(ROOT, added), { force: true });
    }
    assert.equal(await testDependencyStatesStillCurrentV1(report.testDependencyStates ?? [], ROOT), true);
  });

  void it("fails closed when the dependency set exceeds the recorded-state cap", async () => {
    const imports: string[] = [];
    for (let i = 0; i < MAX_TEST_DEPENDENCY_STATES_V1 + 5; i += 1) {
      write(`src/many/dep${i}.ts`, `export const dep${i} = ${i};\n`);
      imports.push(`import "../many/dep${i}";`);
    }
    write("src/test/many.test.ts", `${imports.join("\n")}\n`);
    try {
      const states = await computeTestDependencyStatesV1(ROOT, ["src/test/many.test.ts"]);
      assert.deepEqual(states, [], "a truncated snapshot is never returned");
      assert.equal(await testDependencyStatesStillCurrentV1(states, ROOT), false, "so the report cannot be carried");
    } finally {
      nodeFs.rmSync(nodePath.join(ROOT, "src/many"), { recursive: true, force: true });
      nodeFs.rmSync(nodePath.join(ROOT, "src/test/many.test.ts"), { force: true });
    }
  });

  void it("tracks the TypeScript source a `.js` import names, even when a literal .js file also exists", async () => {
    write("src/dual/helper.ts", "export const dual = 1;\n");
    write("src/dual/helper.js", "exports.dual = 1;\n");
    write("src/test/dual.test.ts", "import { dual } from \"../dual/helper.js\";\nexport const used = dual;\n");
    try {
      const states = await computeTestDependencyStatesV1(ROOT, ["src/test/dual.test.ts"]);
      const paths = states.map((state) => state.path);
      assert.ok(paths.includes("src/dual/helper.ts"), "the .ts source is tracked");
      assert.ok(paths.includes("src/dual/helper.js"), "the literal .js file is tracked too");
      assert.equal(await testDependencyStatesStillCurrentV1(states, ROOT), true);
      write("src/dual/helper.ts", "export const dual = 2;\n");
      assert.equal(await testDependencyStatesStillCurrentV1(states, ROOT), false, "an edit to the .ts source drops the report");
    } finally {
      nodeFs.rmSync(nodePath.join(ROOT, "src/dual"), { recursive: true, force: true });
      nodeFs.rmSync(nodePath.join(ROOT, "src/test/dual.test.ts"), { force: true });
    }
  });

  void it("recognises the project files that drop every carried report", () => {
    for (const file of ["package.json", "pnpm-lock.yaml", "package-lock.json", "tsconfig.json", "tsconfig.test.json", "vitest.config.ts", "jest.config.js"]) {
      assert.equal(isTestRunConfigFileV1(file), true, file);
    }
    for (const file of ["src/package.json", "README.md", "src/vitest.config.ts"]) {
      assert.equal(isTestRunConfigFileV1(file), false, file);
    }
  });

  void it("a report that named no findable test file keeps the stricter older rule", async () => {
    const states = await computeTestDependencyStatesV1(ROOT, ["pnpm test"]);
    assert.deepEqual(states, []);
  });
});

void describe("the apply prompt leaves suggestions alone once the score is good enough (Step 16)", () => {
  const base = { fastForwardActive: true, score: 8, stopLevel: 8, actOnSuggestions: false };

  void it("carries the guidance at the stop level under Fast Forward", () => {
    assert.equal(buildSuggestionsGuidanceV1(base), LEAVE_SUGGESTIONS_ALONE_GUIDANCE_V1);
    assert.match(LEAVE_SUGGESTIONS_ALONE_GUIDANCE_V1, /Leave its non-blocking suggestions alone/);
  });

  void it("does not when ensemble.fastForwardActOnSuggestions is on", () => {
    assert.equal(buildSuggestionsGuidanceV1({ ...base, actOnSuggestions: true }), "");
  });

  void it("the apply template carries the variable, and the setting is contributed off by default", () => {
    const root = nodePath.join(__dirname, "..", "..");
    const template = nodeFs.readFileSync(nodePath.join(root, "resources", "prompts", "apply-impl-review-code.md"), "utf8");
    assert.ok(template.includes("{{suggestionsGuidance}}"));
    const manifest = JSON.parse(nodeFs.readFileSync(nodePath.join(root, "package.json"), "utf8")) as {
      contributes: { configuration: { properties: Record<string, { default: unknown }> } };
    };
    assert.equal(manifest.contributes.configuration.properties["ensemble.fastForwardActOnSuggestions"]?.default, false);
  });

  void it("does not below the stop level or outside a Fast Forward run", () => {
    assert.equal(buildSuggestionsGuidanceV1({ ...base, score: 7 }), "");
    assert.equal(buildSuggestionsGuidanceV1({ ...base, fastForwardActive: false }), "");
    assert.equal(buildSuggestionsGuidanceV1({ ...base, score: null }), "");
  });
});

/**
 * review1 Step 17: the actual historical inputs. These are chat1's real run logs `runs/029`, `runs/033` and
 * `runs/037` (copied byte for byte into `src/test/fixtures/chat1-review1/`) and chat1's real `plan-final.md`.
 * Each run log is the model's own summary followed by sections Ensemble appended afterwards (dispatch chain,
 * "Test reports that did not count"); only the model's summary is the round's report, so the appended part is cut.
 */
const CHAT1_FIXTURE_DIR = nodePath.join(__dirname, "..", "..", "src", "test", "fixtures", "chat1-review1");

function readChat1Fixture(name: string): string {
  return nodeFs.readFileSync(nodePath.join(CHAT1_FIXTURE_DIR, name), "utf8");
}

/** The model's own summary inside an Ensemble run log: after the "Files changed:" list, before the appended chain. */
function modelSummaryOfRunLog(runLog: string): string {
  const lines = runLog.split(/\r?\n/);
  const filesChanged = lines.findIndex((line) => line.startsWith("Files changed:"));
  assert.ok(filesChanged >= 0, "the run log has a Files changed header");
  let start = filesChanged + 1;
  while (start < lines.length && lines[start]!.trim() !== "") start += 1;
  const end = lines.findIndex((line) => line.startsWith("## Dispatch-time model chain"));
  assert.ok(end > start, "the run log has Ensemble's appended sections after the model's summary");
  return lines.slice(start + 1, end).join("\n").trim();
}

const CHAT1_ITEMS = [
  "Step 7: Write the tests for Part 1 (rounds don't run them; Publish Checks do).",
  "Step 17: Write the tests for Part 2 (rounds don't run them; Publish Checks do).",
  "Step 22: Write the tests for Part 3 (rounds don't run them; Publish Checks do).",
] as const;

void describe("chat1's real runs/029, runs/033 and runs/037 (historical fixtures)", () => {
  const plan = readChat1Fixture("plan-final.md");

  void it("the fixture plan really holds Steps 7, 17 and 22 as ticked test items", () => {
    for (const item of CHAT1_ITEMS) {
      assert.ok(plan.includes(`- [x] ${item}`), `plan-final.md carries "${item}" ticked`);
    }
  });

  for (const run of ["029", "033", "037"] as const) {
    void it(`runs/${run}: Steps 7, 17 and 22 each count as a passing test report`, () => {
      const summary = modelSummaryOfRunLog(readChat1Fixture(`${run}-claude-cli-impl.md`));
      for (const item of CHAT1_ITEMS) {
        const diagnosis = diagnoseApplicablePassingTestReportForItemV1(plan, item, summary);
        assert.equal(diagnosis.kind, "applicable", diagnosis.kind === "not-applicable" ? diagnosis.reason : "");
      }
      assert.deepEqual(listUncountedTestReportClaimsV1(plan, summary), []);
    });
  }

  void it("runs/037 keeps `## Plan Item Checklist` above `## Files Changed`, and it is the round's own text", () => {
    const runLog = readChat1Fixture("037-claude-cli-impl.md");
    const lines = runLog.split(/\r?\n/);
    const checklist = lines.findIndex((line) => line === "## Plan Item Checklist");
    const filesChanged = lines.findIndex((line) => line === "## Files Changed");
    assert.ok(checklist >= 0 && filesChanged > checklist);
    const { own } = splitSummaryAtEchoV1(modelSummaryOfRunLog(runLog), plan);
    assert.match(own, /## Plan Item Checklist/);
  });

  void it("the same real report with its tests failing is still rejected, with a reason that is true", () => {
    const summary = modelSummaryOfRunLog(readChat1Fixture("037-claude-cli-impl.md")).replace(
      "— 179 passed, 0 failed.",
      "— 170 passed, 9 failed."
    );
    assert.ok(summary.includes("9 failed"));
    const diagnosis = diagnoseApplicablePassingTestReportForItemV1(plan, CHAT1_ITEMS[0], summary);
    assert.equal(diagnosis.kind, "not-applicable");
    if (diagnosis.kind === "not-applicable") {
      assert.doesNotMatch(diagnosis.reason, /has no `## Plan Item Checklist` section/, "the section exists, so the reason must not say it is missing");
    }
    // The other two steps in the same report still count: only the failing command's item is rejected.
    assert.equal(diagnoseApplicablePassingTestReportForItemV1(plan, CHAT1_ITEMS[1], summary).kind, "applicable");
  });
});
