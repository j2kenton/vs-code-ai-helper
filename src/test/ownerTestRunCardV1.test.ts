/**
 * bugs4 item 21 / Step 19: the owner records a test run through a chat card (no input boxes).
 * Pure content only; the recorder's storage and the gate are covered in ownerTestRunEvidenceV1.test.ts.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RECORD_OWNER_TEST_RUN_COMMAND_V1,
  buildOwnerTestRunCardInputV1,
  extractNamedTestCommandsV1,
  partitionItemsByNamedCommandV1,
  postOwnerTestRunCardV1,
  recordOwnerTestRunFromCardV1,
} from "../commands/ownerTestRunCardV1";
import { buildOpenPlanItemsNeedDecisionCardInputV1 } from "../commands/decideOpenPlanItemsV1";
import { normalizeChecklistItemTextV1 } from "../utils/implementationChecklist";

const DOCKER_ITEM = "Run `npm run resilience:test:portable -- --synthetic --require-postgres16` and record the result.";
const PLAIN_TEST_ITEM = "Add an inventory guard test that fails when a table has no eraser.";

const base = {
  taskFolderPath: "/tmp/task",
  taskCanonicalId: "/tmp/task",
  stage: "impl-high-review" as const,
  displayName: "Strengthen Backup Integrity",
  createdAt: "2026-11-01T00:00:00.000Z",
};

void describe("owner test-run card (bugs4 Step 19)", () => {
  void it("extracts only run commands named in backticks, once each, in order", () => {
    const commands = extractNamedTestCommandsV1([
      DOCKER_ITEM,
      "Check `src/foo.ts` and `pnpm run test:unit -- src/test/a.test.ts`.",
      "Run `npm run resilience:test:portable -- --synthetic --require-postgres16` again.",
      "Open `README.md`.",
    ]);
    assert.deepEqual(commands, [
      "npm run resilience:test:portable -- --synthetic --require-postgres16",
      "pnpm run test:unit -- src/test/a.test.ts",
    ]);
  });

  void it("offers one passed option per named command, a failed option and Not now, with no input boxes", () => {
    const card = buildOwnerTestRunCardInputV1({ ...base, itemTexts: [DOCKER_ITEM] });
    assert.deepEqual(card.options.map((option) => option.optionId), ["passed1", "failed", "notNow"]);
    const passed = card.options[0]!;
    assert.equal(passed.effect.kind, "command");
    if (passed.effect.kind !== "command") return;
    assert.equal(passed.effect.command, RECORD_OWNER_TEST_RUN_COMMAND_V1);
    const arg = passed.effect.args![0] as { outcome: string; command: string; itemTexts: string[] };
    assert.equal(arg.outcome, "passed");
    assert.equal(arg.command, "npm run resilience:test:portable -- --synthetic --require-postgres16");
    assert.deepEqual(arg.itemTexts, [DOCKER_ITEM]);
    assert.match(passed.consequence, /marked as yours/);
    assert.match(passed.consequence, /not a reviewer verification/);
    assert.equal(card.options[2]!.effect.kind, "doNothing");
  });

  void it("the failed option carries no invented exit code and stores nothing", async () => {
    const card = buildOwnerTestRunCardInputV1({ ...base, itemTexts: [DOCKER_ITEM] });
    const failed = card.options.find((option) => option.optionId === "failed")!;
    assert.equal(failed.effect.kind, "command");
    if (failed.effect.kind !== "command") return;
    const arg = failed.effect.args![0] as { outcome: string; exitCode?: number };
    assert.equal(arg.outcome, "failed");
    assert.equal("exitCode" in arg, false, "the card never states an exit code the owner did not give");
    assert.match(failed.consequence, /Nothing is stored/);
    // Handling it posts a note and writes nothing (no task folder is touched).
    const result = await recordOwnerTestRunFromCardV1(failed.effect.args![0] as never);
    assert.ok(typeof result === "object" && result.outcome === "done");
    assert.match(result.message ?? "", /noted that `npm run resilience:test:portable[^`]*` failed\. Nothing was recorded/);
  });

  void it("an item naming no command is never given a placeholder command: it is named on the card as not covered", () => {
    const card = buildOwnerTestRunCardInputV1({ ...base, itemTexts: [DOCKER_ITEM, PLAIN_TEST_ITEM] });
    const commands = card.options.flatMap((option) =>
      option.effect.kind === "command" ? [(option.effect.args![0] as { command: string; itemTexts: string[] })] : []
    );
    assert.ok(commands.length > 0);
    for (const arg of commands) {
      assert.ok(!arg.itemTexts.includes(PLAIN_TEST_ITEM), "no recorded run covers the unnamed item");
      assert.doesNotMatch(arg.command, /not stated/);
    }
    assert.match(card.whatHappened, /1 plan item names no command, so no run can be recorded for it here/);
    assert.deepEqual(partitionItemsByNamedCommandV1([PLAIN_TEST_ITEM]).unnamed, [PLAIN_TEST_ITEM]);
  });

  void it("when no item names a command no record is offered at all", async () => {
    const result = await postOwnerTestRunCardV1({
      taskFolderPath: "/tmp/task",
      stage: "impl-high-review",
      itemTexts: [PLAIN_TEST_ITEM],
    });
    assert.ok(typeof result === "object" && result.outcome === "refused");
    assert.match(result.message ?? "", /names the command that would satisfy it/);
  });

  void it("is a notice-free decision with a real choice: at least two options including Not now", () => {
    const card = buildOwnerTestRunCardInputV1({ ...base, itemTexts: [DOCKER_ITEM] });
    assert.ok(card.options.length >= 2);
    assert.ok(card.options.some((option) => option.optionId === "notNow"));
    assert.equal(card.gating?.holdsTaskPaused, false);
  });

  void it("a chosen command covers only the items that name it, never every awaiting item", () => {
    const unit = "Run `pnpm run test:unit -- src/test/a.test.ts` for the parser.";
    const docker = DOCKER_ITEM;
    const card = buildOwnerTestRunCardInputV1({ ...base, itemTexts: [unit, docker, PLAIN_TEST_ITEM] });
    const recorded = new Map<string, { outcome: string; itemTexts: string[] }>();
    for (const option of card.options) {
      if (option.effect.kind !== "command") continue;
      const arg = option.effect.args![0] as { command: string; outcome: string; itemTexts: string[] };
      recorded.set(`${option.optionId}:${arg.command}`, arg);
    }
    assert.deepEqual(recorded.get("passed1:pnpm run test:unit -- src/test/a.test.ts")!.itemTexts, [unit]);
    assert.deepEqual(
      recorded.get("passed2:npm run resilience:test:portable -- --synthetic --require-postgres16")!.itemTexts,
      [docker]
    );
    // The item naming no command is covered by no option (no placeholder command is invented).
    assert.equal([...recorded.keys()].some((key) => key.startsWith("passed3:")), false);
    // Failed runs are per command too, with the same narrow coverage.
    assert.deepEqual(recorded.get("failed1:pnpm run test:unit -- src/test/a.test.ts")!.itemTexts, [unit]);
    assert.equal(recorded.get("failed2:npm run resilience:test:portable -- --synthetic --require-postgres16")!.outcome, "failed");
    for (const arg of recorded.values()) assert.ok(!arg.itemTexts.includes(PLAIN_TEST_ITEM), "no option covers the unnamed item");
  });

  void it("an item naming several commands is covered by no single-command run and is named on the card", () => {
    const both =
      "Run `pnpm run test:unit -- src/test/a.test.ts` and `npm run resilience:test:portable -- --synthetic` and record both.";
    const single = "Run `pnpm run test:unit -- src/test/a.test.ts` for the parser.";
    const partition = partitionItemsByNamedCommandV1([both, single]);
    assert.deepEqual(partition.multiCommand, [both]);
    assert.deepEqual(partition.groups.map((group) => group.itemTexts), [[single]]);
    const card = buildOwnerTestRunCardInputV1({ ...base, itemTexts: [both, single] });
    for (const option of card.options) {
      if (option.effect.kind !== "command") continue;
      const arg = option.effect.args![0] as { itemTexts: string[] };
      assert.ok(!arg.itemTexts.includes(both), `option ${option.optionId} must not cover the multi-command item`);
    }
    assert.match(card.whatHappened, /1 plan item names several commands, so no single run covers it/);
  });

  void it("when every item names several commands no record is offered at all", async () => {
    const both = "Run `pnpm run test:unit -- a` and `npm run test:b` and record both.";
    const result = await postOwnerTestRunCardV1({
      taskFolderPath: "/tmp/task",
      stage: "impl-high-review",
      itemTexts: [both],
    });
    assert.ok(typeof result === "object" && result.outcome === "refused");
    assert.match(result.message ?? "", /names? several run commands/);
  });

  void it("items whose only command is beyond the option cap are named as not covered", () => {
    const items = ["a", "b", "c", "d"].map((letter) => `Run \`npm run test:${letter}\` and record it.`);
    const card = buildOwnerTestRunCardInputV1({ ...base, itemTexts: items });
    assert.equal(card.options.filter((option) => option.optionId.startsWith("passed")).length, 3);
    assert.match(card.whatHappened, /1 plan item names a command not offered here/);
  });

  void it("the open-items card offers 'I ran the tests myself' only when a waiting item names a run command", () => {
    const waiting = buildOpenPlanItemsNeedDecisionCardInputV1({
      ...base,
      items: [{ itemText: DOCKER_ITEM, reason: "" }],
      builtClaimedKeys: new Set([normalizeChecklistItemTextV1(DOCKER_ITEM)]),
    });
    const own = waiting.options.find((option) => option.optionId === "ownerRanTests");
    assert.ok(own, "the owner-run option is offered");
    assert.equal(own.effect.kind, "command");
    const notReached = buildOpenPlanItemsNeedDecisionCardInputV1({
      ...base,
      items: [{ itemText: DOCKER_ITEM, reason: "" }],
    });
    assert.equal(notReached.options.some((option) => option.optionId === "ownerRanTests"), false);
    // A waiting item that names no command cannot be recorded against, so the option is not offered for it.
    const unnamed = buildOpenPlanItemsNeedDecisionCardInputV1({
      ...base,
      items: [{ itemText: PLAIN_TEST_ITEM, reason: "" }],
      builtClaimedKeys: new Set([normalizeChecklistItemTextV1(PLAIN_TEST_ITEM)]),
    });
    assert.equal(unnamed.options.some((option) => option.optionId === "ownerRanTests"), false);
  });
});
