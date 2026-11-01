import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  diagnoseApplicablePassingTestReportForItemV1,
  formatUncountedTestReportClaimsSectionV1,
  getApplicablePassingTestReportForItemV1,
  listUncountedTestReportClaimsV1,
  listProvisionalTestDependentChecklistItemsV1,
  POST_EDIT_STATEMENT_V1,
  reportCommandCoversTestIdentityV1,
} from "../utils/implementationChecklist";

// bugs4 item 21: test reports parse in the forms rounds actually write, and a
// report that does not count says why instead of silently counting nothing.

const GIT_LOCK_ITEM = "Add tests for the git index lock capture (gitIndexLockV1).";
const CRON_ITEM = "Add tests for the cron scheduler config.";
const PLAN = [
  "<!-- ensemble:implementation-checklist -->",
  `- [x] ${GIT_LOCK_ITEM}`,
  `- [x] ${CRON_ITEM}`,
].join("\n");

function report(checklist: string[], verification: string[]): string {
  return [
    "## Files Changed",
    "- src/utils/gitIndexLockV1.ts",
    "## Plan Item Checklist",
    ...checklist,
    "## Verification",
    ...verification,
  ].join("\n");
}

void describe("a parsed report passes the apply-time gate too (bugs4 item 21, 28)", () => {
  // Apply Reviewer-Verified Ticks re-checks a stored report's source statement and command. It
  // must accept exactly what the parser accepted, or a populated Verified Complete block still
  // verifies nothing ("applied 0 of 28").
  const stored = (summary: string, itemText: string) => {
    const found = getApplicablePassingTestReportForItemV1(PLAN, itemText, summary);
    assert.ok(found, "the parser must accept this form");
    return found;
  };

  void it("'on the final source' report: its statement and command are accepted at apply time", () => {
    const found = stored(
      report(
        [`- ${GIT_LOCK_ITEM} — done — test: gitIndexLockV1.test.ts`],
        ["- `pnpm run test:unit -- src/test/gitIndexLockV1.test.ts` — 12 passed, 0 failed, on the final source."]
      ),
      GIT_LOCK_ITEM
    );
    assert.ok(POST_EDIT_STATEMENT_V1.test(found.sourceState), found.sourceState);
    assert.ok(reportCommandCoversTestIdentityV1(found.command, found.testIdentity));
  });

  void it("prose evidence over a compiled .js command is accepted at apply time", () => {
    const found = stored(
      report(
        [`- ${GIT_LOCK_ITEM} — done — \`gitIndexLockV1.test.ts\`, \`gitIndexLockRoundWrapperV1.test.ts\` (52 pass)`],
        [
          "- `node --require ./test-stubs/register.js --test out/test/gitIndexLockV1.test.js out/test/gitIndexLockRoundWrapperV1.test.js` — 52 passed, 0 failed.",
          "- Final post-edit run of the touched test files.",
        ]
      ),
      GIT_LOCK_ITEM
    );
    assert.ok(POST_EDIT_STATEMENT_V1.test(found.sourceState));
    assert.ok(reportCommandCoversTestIdentityV1(found.command, found.testIdentity));
  });

  void it("a vitest directory command stored against the item's evidence is accepted at apply time", () => {
    const found = stored(
      report(
        [`- ${CRON_ITEM} — done — apps/server/src/cron/__tests__/scheduler.test.ts passed in the server command under Verification`],
        [
          "- `cd apps/server && npx vitest run --config vitest.cron.config.ts apps/server/src/cron/__tests__/` — 15 files, 324 passed, 0 failed.",
          "- Tree fingerprint 5f4e71fc…, 0 files changed after the run.",
        ]
      ),
      CRON_ITEM
    );
    assert.ok(POST_EDIT_STATEMENT_V1.test(found.sourceState));
    assert.ok(reportCommandCoversTestIdentityV1(found.command, found.testIdentity));
  });

  void it("a bare test file is covered by its compiled counterpart or a directory, and by nothing else", () => {
    assert.ok(reportCommandCoversTestIdentityV1("node --test out/test/a.test.js", "a.test.ts"));
    assert.ok(reportCommandCoversTestIdentityV1("vitest run src/__tests__/", "src/__tests__/a.test.ts"));
    assert.ok(reportCommandCoversTestIdentityV1("node --test src/test/a.test.ts", "src/test/a.test.ts"));
    assert.equal(reportCommandCoversTestIdentityV1("node --test out/test/b.test.js", "a.test.ts"), false);
    assert.equal(reportCommandCoversTestIdentityV1("pnpm test", "a.test.ts"), false);
  });

  void it("the statement gate still refuses a report with no post-edit statement (control)", () => {
    assert.equal(POST_EDIT_STATEMENT_V1.test("ran before the edits, 12 passed"), false);
  });
});

void describe("test report forms (bugs4 item 21)", () => {
  void it("one command over several listed .js files, with evidence naming the .ts sources and a 'post-edit run'", () => {
    const summary = report(
      [
        `- ${GIT_LOCK_ITEM} — done — \`gitIndexLockV1.test.ts\`, \`gitIndexLockRoundWrapperV1.test.ts\` and the wrapper suite (52 pass)`,
      ],
      [
        "- `node --require ./test-stubs/register.js --test out/test/gitIndexLockV1.test.js out/test/gitIndexLockRoundWrapperV1.test.js` — 52 passed, 0 failed.",
        "- Final post-edit run of the touched test files.",
      ]
    );
    const found = getApplicablePassingTestReportForItemV1(PLAN, GIT_LOCK_ITEM, summary);
    assert.ok(found, "the real 476-pass form must yield a test report");
    assert.equal(found.passed, 52);
    assert.equal(found.failed, 0);
    assert.deepEqual(listProvisionalTestDependentChecklistItemsV1(PLAN, summary), [CRON_ITEM]);
  });

  void it("files listed as sub-bullets under one template command are covered by it", () => {
    const summary = report(
      [`- ${GIT_LOCK_ITEM} — done — test: gitIndexLockV1.test.ts`],
      [
        "- `node --test out/test/<each file>.js` — 476 passed, 0 failed; post-edit source state: working tree after this round.",
        "  - out/test/gitIndexLockV1.test.js",
        "  - out/test/other.test.js",
      ]
    );
    assert.ok(getApplicablePassingTestReportForItemV1(PLAN, GIT_LOCK_ITEM, summary));
  });

  void it("a listed file the round says it did not run is not covered", () => {
    const summary = report(
      [`- ${GIT_LOCK_ITEM} — done — test: gitIndexLockV1.test.ts`],
      [
        "- `node --test out/test/other.test.js` — 4 passed, 0 failed; post-edit source state: working tree.",
        "  - gitIndexLockV1.test.ts was not run (refused)",
      ]
    );
    assert.equal(getApplicablePassingTestReportForItemV1(PLAN, GIT_LOCK_ITEM, summary), undefined);
  });

  void it("vitest over directories and a config covers the tests under them (item 21's server-suite form)", () => {
    const summary = report(
      [`- ${CRON_ITEM} — done — apps/server/src/cron/__tests__/scheduler.test.ts passed in the server command under Verification`],
      [
        "- `cd apps/server && npx vitest run --config vitest.cron.config.ts apps/server/src/cron/__tests__/` — 15 files, 324 passed, 0 failed.",
        "- Tree fingerprint 5f4e71fc…, 0 files changed after the run.",
      ]
    );
    const found = getApplicablePassingTestReportForItemV1(PLAN, CRON_ITEM, summary);
    assert.ok(found);
    assert.equal(found.passed, 324);
  });

  void it("'final source' counts as a post-edit statement", () => {
    const summary = report(
      [`- ${GIT_LOCK_ITEM} — done — test: gitIndexLockV1.test.ts`],
      ["- `pnpm run test:unit -- src/test/gitIndexLockV1.test.ts` — 12 passed, 0 failed, on the final source."]
    );
    assert.ok(getApplicablePassingTestReportForItemV1(PLAN, GIT_LOCK_ITEM, summary));
  });

  void it("node's own summary form (pass N / fail 0) counts", () => {
    const summary = report(
      [`- ${GIT_LOCK_ITEM} — done — test: gitIndexLockV1.test.ts`],
      ["- `pnpm run test:unit -- src/test/gitIndexLockV1.test.ts` — ℹ pass 12, ℹ fail 0; post-edit source state: working tree."]
    );
    assert.ok(getApplicablePassingTestReportForItemV1(PLAN, GIT_LOCK_ITEM, summary));
  });

  void it("evidence that points at a command listed under Verification counts", () => {
    const summary = report(
      [`- ${GIT_LOCK_ITEM} — done — passed under \`pnpm run test:unit -- src/test/gitIndexLockV1.test.ts\``],
      ["- `pnpm run test:unit -- src/test/gitIndexLockV1.test.ts` — 12 passed, 0 failed; post-edit source state: working tree."]
    );
    assert.ok(getApplicablePassingTestReportForItemV1(PLAN, GIT_LOCK_ITEM, summary));
  });

  void it("evidence naming several files needs every one of them covered", () => {
    const summary = report(
      [`- ${GIT_LOCK_ITEM} — done — \`gitIndexLockV1.test.ts\` and \`missingSuiteV1.test.ts\` (all pass)`],
      ["- `pnpm run test:unit -- src/test/gitIndexLockV1.test.ts` — 12 passed, 0 failed; post-edit source state: working tree."]
    );
    assert.equal(getApplicablePassingTestReportForItemV1(PLAN, GIT_LOCK_ITEM, summary), undefined);
    const diagnosis = diagnoseApplicablePassingTestReportForItemV1(PLAN, GIT_LOCK_ITEM, summary);
    assert.equal(diagnosis.kind, "not-applicable");
    assert.match(diagnosis.kind === "not-applicable" ? diagnosis.reason : "", /missingsuitev1\.test\.ts/);
  });

  void it("controls: a failing run, a bare 'test' word, and a command naming other tests never count", () => {
    const failing = report(
      [`- ${GIT_LOCK_ITEM} — done — test: gitIndexLockV1.test.ts`],
      ["- `pnpm run test:unit -- src/test/gitIndexLockV1.test.ts` — 11 passed, 1 failed; post-edit source state: working tree."]
    );
    assert.equal(getApplicablePassingTestReportForItemV1(PLAN, GIT_LOCK_ITEM, failing), undefined);
    const bareSuite = report(
      [`- ${GIT_LOCK_ITEM} — done — test: gitIndexLockV1.test.ts`],
      ["- `pnpm test` — 99 passed, 0 failed; post-edit source state: working tree."]
    );
    assert.equal(getApplicablePassingTestReportForItemV1(PLAN, GIT_LOCK_ITEM, bareSuite), undefined, "a whole-suite command names none of the item's tests");
    const otherTests = report(
      [`- ${GIT_LOCK_ITEM} — done — test: gitIndexLockV1.test.ts`],
      ["- `pnpm run test:unit -- src/test/other.test.ts` — 4 passed, 0 failed; post-edit source state: working tree."]
    );
    assert.equal(getApplicablePassingTestReportForItemV1(PLAN, GIT_LOCK_ITEM, otherTests), undefined);
  });
});

void describe("a report that does not count says why (bugs4 item 21, never silently zero)", () => {
  const reasonOf = (summary: string, item = GIT_LOCK_ITEM): string => {
    const diagnosis = diagnoseApplicablePassingTestReportForItemV1(PLAN, item, summary);
    assert.equal(diagnosis.kind, "not-applicable");
    return diagnosis.kind === "not-applicable" ? diagnosis.reason : "";
  };

  void it("names a missing post-edit statement", () => {
    const summary = report(
      [`- ${GIT_LOCK_ITEM} — done — test: gitIndexLockV1.test.ts`],
      ["- `pnpm run test:unit -- src/test/gitIndexLockV1.test.ts` — 12 passed, 0 failed."]
    );
    assert.match(reasonOf(summary), /post-edit tree/);
  });

  void it("names an item the round did not claim", () => {
    const summary = report(
      [`- ${CRON_ITEM} — done — test: scheduler.test.ts`],
      ["- `pnpm run test:unit -- src/test/scheduler.test.ts` — 12 passed, 0 failed; post-edit source state: tree."]
    );
    assert.match(reasonOf(summary), /did not claim this item done/);
  });

  void it("names a command whose counts are missing", () => {
    const summary = report(
      [`- ${GIT_LOCK_ITEM} — done — test: gitIndexLockV1.test.ts`],
      ["- `pnpm run test:unit -- src/test/gitIndexLockV1.test.ts` — ran; post-edit source state: tree."]
    );
    assert.match(reasonOf(summary), /did not report “N passed” with 0 failed/);
  });

  void it("names evidence with no test file or command, and a missing Verification section", () => {
    assert.match(
      reasonOf(report([`- ${GIT_LOCK_ITEM} — done — implemented in the helper`], ["- nothing"])),
      /names no test file, test name or command/
    );
    assert.match(
      reasonOf(
        ["## Files Changed", "- a.ts", "## Plan Item Checklist", `- ${GIT_LOCK_ITEM} — done — test: gitIndexLockV1.test.ts`].join("\n")
      ),
      /no `## Verification` section/
    );
  });

  void it("lists claimed-but-uncounted items with their reasons for the run log, and nothing for unclaimed or counted ones", () => {
    const summary = report(
      [
        `- ${GIT_LOCK_ITEM} — done — test: gitIndexLockV1.test.ts`,
        `- ${CRON_ITEM} — done — test: scheduler.test.ts`,
      ],
      [
        "- `pnpm run test:unit -- src/test/gitIndexLockV1.test.ts` — 12 passed, 0 failed; post-edit source state: tree.",
        "- `pnpm run test:unit -- src/test/other.test.ts` — 3 passed, 0 failed.",
      ]
    );
    const uncounted = listUncountedTestReportClaimsV1(PLAN, summary);
    assert.deepEqual(uncounted.map((entry) => entry.itemText), [CRON_ITEM]);
    assert.match(uncounted[0]!.reason, /scheduler\.test\.ts/);
    const section = formatUncountedTestReportClaimsSectionV1(uncounted);
    assert.match(section, /^\n\n## Test reports that did not count/);
    assert.ok(section.includes(`- ${CRON_ITEM} — `));
    assert.equal(formatUncountedTestReportClaimsSectionV1([]), "");
    const unclaimed = report([], ["- `pnpm test -- x.test.ts` — 1 passed, 0 failed; post-edit source state: tree."]);
    assert.deepEqual(listUncountedTestReportClaimsV1(PLAN, unclaimed), []);
  });

  void it("a non-test item is reported as such rather than as a gap", () => {
    const item = "Rename the helper.";
    const plan = `<!-- ensemble:implementation-checklist -->\n- [x] ${item}`;
    const diagnosis = diagnoseApplicablePassingTestReportForItemV1(plan, item, "## Plan Item Checklist\n");
    assert.deepEqual(diagnosis, { kind: "not-applicable", reason: "the item is not test-dependent" });
  });
});
