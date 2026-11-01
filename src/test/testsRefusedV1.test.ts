/**
 * bugs4 Step 21 / item 16: a refused test command is its own result ("tests could not run"),
 * distinct from tests that ran and failed, and its remedy never edits permissions.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectTestsRefusedV1,
  formatTestsRefusedRemedyV1,
  formatTestsRefusedSectionV1,
} from "../utils/testsRefusedV1";

const FORM = "node --require ./test-stubs/register.js --test-timeout=20000 --test out/test/x.test.js";

void describe("detectTestsRefusedV1", () => {
  void it("reads the canonical statement the prompts ask for", () => {
    const refused = detectTestsRefusedV1(
      `## Verification\n- tests could not run: the provider refused the command \`${FORM}\`.\n- \`npx tsc\` passed.`
    );
    assert.deepEqual(refused?.commands, [FORM]);
  });

  void it("collects several refused commands once each, in the order stated", () => {
    const refused = detectTestsRefusedV1(
      [
        "- Tests could not run: the provider refused the command `node test-stubs/run-unit-tests.js a.test.ts`",
        "- tests could not run: the provider refused the command `node --test out/test/b.js`",
        "- tests could not run: the provider refused the command `node test-stubs/run-unit-tests.js a.test.ts`",
      ].join("\n")
    );
    assert.deepEqual(refused?.commands, [
      "node test-stubs/run-unit-tests.js a.test.ts",
      "node --test out/test/b.js",
    ]);
  });

  void it("recognises a loose approval-refused line only when the command is a test command", () => {
    const refused = detectTestsRefusedV1(
      "The `node --test out/test/x.js` approval was refused. The `npx eslint src` call requires approval too."
    );
    assert.deepEqual(refused?.commands, ["node --test out/test/x.js"]);
  });

  void it("tests that ran and failed are not a refusal", () => {
    assert.equal(
      detectTestsRefusedV1("- `pnpm run test:unit -- src/test/a.test.ts` — 10 passed, 2 failed; post-edit source state: tree."),
      undefined
    );
  });

  void it("a summary that reports no refusal gives undefined", () => {
    assert.equal(detectTestsRefusedV1("## Verification\n- all green"), undefined);
    assert.equal(detectTestsRefusedV1(""), undefined);
  });

  void it("a refusal statement with no command still reports the refusal", () => {
    const refused = detectTestsRefusedV1("tests could not run: the provider refused");
    assert.deepEqual(refused?.commands, ["(command not named)"]);
  });
});

void describe("refusal wording", () => {
  const refused = { commands: [FORM] };

  void it("names the cause and the three remedies, and says it is not a test failure", () => {
    const text = formatTestsRefusedRemedyV1(refused, { template: "pnpm run test:unit -- <test files>", allowedByProjectRules: true });
    assert.match(text, /refused the test command/);
    assert.match(text, /not a test failure/);
    assert.match(text, /pnpm run test:unit -- <test files>/);
    assert.match(text, /allow rule/);
    assert.match(text, /provider that can run it/);
    assert.match(text, /never edits permissions/);
  });

  void it("without a project script it still names the allow-rule and provider remedies", () => {
    const text = formatTestsRefusedRemedyV1(refused);
    assert.doesNotMatch(text, /targeted form/);
    assert.match(text, /allow rule/);
  });

  void it("the run-log section is its own heading, separate from failures", () => {
    const section = formatTestsRefusedSectionV1(refused);
    assert.match(section, /## Tests could not run \(testsRefused\)/);
    assert.match(section, /separately from tests that ran and failed/);
    assert.ok(section.includes(FORM));
  });
});
