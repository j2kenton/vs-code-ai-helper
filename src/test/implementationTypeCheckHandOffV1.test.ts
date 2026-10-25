import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildImplementationTypeCheckFailedDecisionInputV1,
  buildImplementationTypeCheckPromptNoticeV1,
  formatImplementationTypeCheckErrorsV1,
  prioritizeImplementationTypeCheckDiagnosticsV1,
} from "../utils/implementationTypeCheckHandOffV1";

void describe("Implementation type-check chat hand-off", () => {
  void it("keeps the first file, line, and message errors concise for the chat card", () => {
    const output = [
      "src/a.ts(12,4): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/b.ts(8,1): error TS2304: Cannot find name 'Thing'.",
      ...Array.from({ length: 20 }, (_, index) => `later error ${index}`),
    ].join("\n");
    const excerpt = formatImplementationTypeCheckErrorsV1(output);
    assert.match(excerpt, /src\/a\.ts\(12,4\): error TS2322/);
    assert.match(excerpt, /src\/b\.ts\(8,1\): error TS2304/);
    assert.doesNotMatch(excerpt, /later error 19/);
    assert.match(buildImplementationTypeCheckPromptNoticeV1(excerpt), /previous Implementation round/);
    assert.match(buildImplementationTypeCheckPromptNoticeV1(excerpt), /src\/a\.ts\(12,4\)/);
  });

  void it("provides a useful card excerpt when the checker emitted no text", () => {
    assert.equal(
      formatImplementationTypeCheckErrorsV1("  \n"),
      "The type-check command failed without reporting error text."
    );
  });

  void it("selects the first compiler errors after check and package output", () => {
    const output = [
      "> ensemble@1.0.0 check-types",
      "tsc --noEmit",
      "Found 0 errors in the root project.",
      ...Array.from({ length: 12 }, (_, index) => `package setup output ${index}`),
      "packages/first/src/a.ts(12,4): error TS2322: Type 'string' is not assignable to type 'number'.",
      "packages/first/src/b.ts(8,1): error TS2304: Cannot find name 'Thing'.",
      "packages/second/src/c.ts(3,2): error TS7006: Parameter 'value' implicitly has an 'any' type.",
      "Found 3 errors in packages.",
    ].join("\n");

    const excerpt = formatImplementationTypeCheckErrorsV1(output, 2);
    assert.match(excerpt, /packages\/first\/src\/a\.ts\(12,4\): error TS2322/);
    assert.match(excerpt, /packages\/first\/src\/b\.ts\(8,1\): error TS2304/);
    assert.doesNotMatch(excerpt, /package setup output/);
    assert.doesNotMatch(excerpt, /packages\/second/);
  });

  void it("preserves compiler errors that occur after output exceeds the runner cap", () => {
    const output = [
      ...Array.from({ length: 500 }, (_, index) => `package setup output ${index} ${"x".repeat(30)}`),
      "packages/first/src/a.ts(12,4): error TS2322: Type 'string' is not assignable to type 'number'.",
      "packages/first/src/b.ts(8,1): error TS2304: Cannot find name 'Thing'.",
      ...Array.from({ length: 100 }, (_, index) => `later output ${index} ${"y".repeat(30)}`),
    ].join("\n");

    const captured = prioritizeImplementationTypeCheckDiagnosticsV1(output, 4000);
    const excerpt = formatImplementationTypeCheckErrorsV1(captured);
    assert.ok(captured.length <= 4000);
    assert.match(excerpt, /packages\/first\/src\/a\.ts\(12,4\): error TS2322/);
    assert.match(excerpt, /packages\/first\/src\/b\.ts\(8,1\): error TS2304/);
    assert.doesNotMatch(excerpt, /package setup output/);
  });

  void it("builds the implementationTypeCheckFailed decision with the resume-and-dispatch option and manual fallback", () => {
    const decision = buildImplementationTypeCheckFailedDecisionInputV1({
      taskCanonicalId: "/tmp/task",
      taskFolderPath: "/tmp/task",
      stage: "impl-high-review",
      errors: "src/a.ts(12,4): error TS2322: Type 'string' is not assignable to type 'number'.",
      logFilePath: "/tmp/task/runs/impl.log",
    });
    assert.equal(decision.decisionKey, "implementationTypeCheckFailed");
    assert.equal(decision.options[0]?.optionId, "runImplementationFix");
    assert.equal(decision.options[0]?.resumeKind, "continue");
    assert.deepEqual(decision.options[0]?.effect, {
      kind: "command",
      command: "vs-code-ai-helper.resumeAndDispatchImplementation",
      args: [
        {
          taskFolderPath: "/tmp/task",
          implementationTypeCheckErrorsV1:
            "src/a.ts(12,4): error TS2322: Type 'string' is not assignable to type 'number'.",
        },
      ],
    });
    assert.equal(decision.options[1]?.optionId, "fixBuildManually");
    assert.equal(decision.options[1]?.resumeKind, "unpause");
    assert.deepEqual(decision.options[1]?.effect, { kind: "doNothing" });
  });
});
