/**
 * bugs7 item 1 (review fixes): no acceptance path bypasses the resolved files, and the building round's test files
 * stay with the item when a later round re-claims it without touching its tests.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { buildItemTestFilesContextV1 } from "../commands/itemTestFilesContextV1";
import {
  diagnoseApplicablePassingTestReportForItemV1,
  normalizeChecklistItemTextV1,
  reportBaseDirV1,
  reportCommandCoversTestIdentityV1,
} from "../utils/implementationChecklist";
import { resolveItemTestFilesV1 } from "../utils/itemTestFilesV1";

void describe("acceptance never bypasses the resolved files (bugs7 item 1, review fix)", () => {
  const known = ["packages/a/x.test.ts", "packages/b/x.test.ts", "src/test/other.test.ts"];
  const itemB = "Step 12: Add tests in `packages/b/x.test.ts`";
  const planB = ["<!-- ensemble:implementation-checklist -->", `- [x] ${itemB}`].join("\n");
  const reportQuoting = (item: string, quoted: string, command: string): string =>
    [
      "## Files Changed", "- src/utils/x.ts", "## Plan Item Checklist",
      `- ${item} — done — \`${quoted}\``,
      "## Verification",
      `- \`${command}\` — **9 passed, 0 failed**, on the working tree after all edits`,
    ].join("\n");

  void it("evidence that quotes a passing command for packages/a/x.test.ts does not count for an item needing packages/b/x.test.ts", () => {
    const command = "pnpm run test:unit -- packages/a/x.test.ts";
    const wrong = diagnoseApplicablePassingTestReportForItemV1(planB, itemB, reportQuoting(itemB, command, command), { knownTestFiles: known });
    assert.equal(wrong.kind, "not-applicable");
    const rightCommand = "pnpm run test:unit -- packages/b/x.test.ts";
    const right = diagnoseApplicablePassingTestReportForItemV1(planB, itemB, reportQuoting(itemB, rightCommand, rightCommand), {
      knownTestFiles: known,
    });
    assert.equal(right.kind, "applicable", right.kind === "not-applicable" ? right.reason : "");
  });

  void it("an item whose test name is ambiguous settles nothing by quoting a command", () => {
    const item = "Step 13: Add tests for `x`";
    const plan = ["<!-- ensemble:implementation-checklist -->", `- [x] ${item}`].join("\n");
    const command = "pnpm run test:unit";
    const out = diagnoseApplicablePassingTestReportForItemV1(plan, item, reportQuoting(item, command, command), { knownTestFiles: known });
    assert.equal(out.kind, "not-applicable", "a bare runner command names none of the candidate files");
    // Naming the path in the evidence is what disambiguates it.
    const named = "pnpm run test:unit -- packages/a/x.test.ts";
    const resolved = diagnoseApplicablePassingTestReportForItemV1(plan, item, reportQuoting(item, named, named), { knownTestFiles: known });
    assert.equal(resolved.kind, "applicable", resolved.kind === "not-applicable" ? resolved.reason : "");
  });

  void it("a command-shaped identity stored with a report is re-checked against the report's own command", () => {
    assert.equal(
      reportCommandCoversTestIdentityV1("pnpm run test:unit -- packages/a/x.test.ts", "pnpm run test:unit -- packages/b/x.test.ts"),
      false
    );
    assert.equal(
      reportCommandCoversTestIdentityV1("pnpm run test:unit -- packages/a/x.test.ts", "pnpm run test:unit -- packages/a/x.test.ts"),
      true
    );
    assert.equal(reportCommandCoversTestIdentityV1("pnpm run test:unit -- packages/a/x.test.ts", "packages/a/x.test.ts, packages/b/x.test.ts"), false);
    assert.equal(
      reportCommandCoversTestIdentityV1("pnpm run test:unit -- packages/a/x.test.ts packages/b/x.test.ts", "packages/a/x.test.ts, packages/b/x.test.ts"),
      true
    );
  });

  void it("a package-local name in a command run from that package's folder covers that package's file, and the other package's file stays uncovered", () => {
    const command = "cd packages/b && pnpm vitest run x.test.ts";
    const forB = diagnoseApplicablePassingTestReportForItemV1(planB, itemB, reportQuoting(itemB, "x.test.ts", command), { knownTestFiles: known });
    assert.equal(forB.kind, "applicable", forB.kind === "not-applicable" ? forB.reason : "");
    const itemA = "Step 12: Add tests in `packages/a/x.test.ts`";
    const planA = ["<!-- ensemble:implementation-checklist -->", `- [x] ${itemA}`].join("\n");
    const forA = diagnoseApplicablePassingTestReportForItemV1(planA, itemA, reportQuoting(itemA, "x.test.ts", command), { knownTestFiles: known });
    assert.equal(forA.kind, "not-applicable");
  });

  void it("an item that resolves to no test file is never accepted by quoting a passing command (the empty file set covers nothing)", () => {
    const item = "Step 15: Add unit tests for the clock";
    const plan = ["<!-- ensemble:implementation-checklist -->", `- [x] ${item}`].join("\n");
    const command = "pnpm run test:unit";
    const out = diagnoseApplicablePassingTestReportForItemV1(plan, item, reportQuoting(item, command, command), { knownTestFiles: known });
    assert.equal(out.kind, "not-applicable");
    assert.match(out.kind === "not-applicable" ? out.reason : "", /no test file could be identified/);
    // The same without a context at all: still nothing identifies a file.
    const bare = diagnoseApplicablePassingTestReportForItemV1(plan, item, reportQuoting(item, command, command));
    assert.equal(bare.kind, "not-applicable");
  });

  void it("a stored file-list identity is covered from the report's own working directory", () => {
    const context = { knownTestFiles: known };
    assert.equal(reportCommandCoversTestIdentityV1("pnpm vitest run x.test.ts", "packages/b/x.test.ts", context, "packages/b"), true);
    assert.equal(reportCommandCoversTestIdentityV1("pnpm vitest run x.test.ts", "packages/b/x.test.ts", context, "packages/a"), false);
    assert.equal(reportBaseDirV1("pnpm vitest run x.test.ts", "packages/b"), "packages/b");
    assert.equal(reportBaseDirV1("cd packages/a && pnpm vitest run x.test.ts"), "packages/a");
    assert.equal(reportBaseDirV1("pnpm run test:unit"), undefined);
  });

  void it("the apply-time gate threads the round ledger and each report's working directory, and refuses an item with no resolved file", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../../src/commands/applyReviewerVerifiedTicks.ts"), "utf8");
    assert.match(source, /resolveItemFilesForGateV1\(itemText, itemRows, workspaceRoot, taskFolderPath, roundLedger\)/);
    assert.match(source, /progressRead\.decoded\.progress\.roundLedger/);
    assert.match(source, /reportBaseDirForGateV1\(report, workspaceRoot\)/);
    assert.match(source, /if \(resolved\.ambiguous \|\| resolved\.files\.length === 0\) return false;/);
    assert.doesNotMatch(source, /if \(resolved\.files\.length === 0\) return true;/);
  });

  void it("a path written in the item that matches no known test file resolves to nothing", () => {
    const out = resolveItemTestFilesV1({ itemText: "Add tests in `src/test/nope.test.ts`", context: { knownTestFiles: known } });
    assert.deepEqual(out.files, []);
  });

  void it("a claim with no evidence text still counts when the round-changed files resolve and a command covers them", () => {
    const item = "Step 14: Add the round clock tests";
    const plan = ["<!-- ensemble:implementation-checklist -->", `- [x] ${item}`].join("\n");
    const summary = [
      "## Files Changed", "- src/utils/x.ts", "## Plan Item Checklist",
      `- ${item} — done — all green`,
      "## Verification",
      "- `pnpm run test:unit -- src/test/other.test.ts` — **3 passed, 0 failed**, on the working tree after all edits",
    ].join("\n");
    const out = diagnoseApplicablePassingTestReportForItemV1(plan, item, summary, {
      knownTestFiles: known,
      roundChangedTestFiles: ["src/test/other.test.ts"],
    });
    assert.equal(out.kind, "applicable", out.kind === "not-applicable" ? out.reason : "");
  });
});

void describe("the building round's test files stay with the item (bugs7 item 1, review fix)", () => {
  void it("a later round that re-claims the item without touching its tests keeps the building round's files; a ledger alias reaches a record", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "item-test-files-rounds-"));
    try {
      fs.mkdirSync(path.join(root, "src/test"), { recursive: true });
      fs.writeFileSync(path.join(root, "src/test/a.test.ts"), "");
      fs.writeFileSync(path.join(root, "src/test/b.test.ts"), "");
      const taskFolder = path.join(root, ".ensemble/t1");
      fs.mkdirSync(path.join(taskFolder, "runs"), { recursive: true });
      fs.writeFileSync(path.join(taskFolder, "runs", "001-impl.md"), "Round ID: op-9\n\nFiles changed:\n- src/x.ts\n- src/test/a.test.ts\n\nSummary");
      fs.writeFileSync(path.join(taskFolder, "runs", "002-apply.md"), "Round ID: round-2\n\nFiles changed:\n- src/y.ts\n\nSummary");
      const itemText = "Step 20: Add unit tests for the round clock";
      const itemKey = normalizeChecklistItemTextV1(itemText);
      const context = await buildItemTestFilesContextV1({
        workspaceRoot: root,
        taskFolderPath: taskFolder,
        // The row names the ledger row id of the building round and the id of the later one; the building round's
        // record prints its operation id.
        planItemEvidence: [{ itemKey, claims: [{ roundId: "ledger-9" }, { roundId: "round-2" }] }],
        roundLedger: [{ roundId: "ledger-9", operationId: "op-9", attemptIds: [] }],
      });
      assert.deepEqual(context.roundChangedTestFilesByItemKey?.[itemKey], ["src/test/a.test.ts"]);
      assert.deepEqual(context.roundChangedTestFiles, [], "the current round changed no test file");
      const plan = ["<!-- ensemble:implementation-checklist -->", `- [x] ${itemText}`].join("\n");
      const summary = [
        "## Files Changed", "- src/utils/x.ts", "## Plan Item Checklist",
        `- ${itemText} — done — new tests, all green`,
        "## Verification",
        "- `pnpm run test:unit -- src/test/a.test.ts` — **4 passed, 0 failed**, on the working tree after all edits",
      ].join("\n");
      const counted = diagnoseApplicablePassingTestReportForItemV1(plan, itemText, summary, context);
      assert.equal(counted.kind, "applicable", counted.kind === "not-applicable" ? counted.reason : "");
      const otherRun = summary.replace("src/test/a.test.ts", "src/test/b.test.ts");
      assert.equal(diagnoseApplicablePassingTestReportForItemV1(plan, itemText, otherRun, context).kind, "not-applicable");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
