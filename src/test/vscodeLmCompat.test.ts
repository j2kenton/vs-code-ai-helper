import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  attachLmToolsV1,
  createLmTextPartV1,
  createLmToolResultPartV1,
  isLmTextPartV1,
  isLmToolCallPartV1,
  iterateLmResponsePartsV1,
  probeLmToolCallingHostCapabilityV1,
  toNeutralToolCallV1,
} from "../services/vscodeLmCompat";

/**
 * Typed view of the tool-calling classes the stub `vscode` module provides at
 * runtime. The pinned `@types/vscode@1.93.0` declarations do not contain
 * these members (that's the point of the compatibility boundary under test),
 * so the test names them through this cast instead of `vscode.X` directly.
 * Property reads go through the ESM-interop getters, so they observe
 * `withoutVscodeProperty`'s raw-module mutations live.
 */
const lmClasses = vscode as unknown as {
  LanguageModelTextPart: new (value: string) => { value: string };
  LanguageModelToolCallPart: new (
    callId: string,
    name: string,
    input: Record<string, unknown>
  ) => { callId: string; name: string; input: Record<string, unknown> };
  LanguageModelToolResultPart: new (
    callId: string,
    content: readonly unknown[]
  ) => { callId: string; content: readonly unknown[] };
};

/**
 * Temporarily deletes an own property of the stub `vscode` module and
 * restores it after `fn`. Must mutate the raw `require("vscode")` module
 * object, not the `import * as vscode` binding: TypeScript's ESM interop
 * re-exposes each named export as a non-configurable getter delegating to
 * the raw module, so deleting through the `import` binding throws — but the
 * getter reads the raw module live, so mutating it there is visible through
 * `vscode.X` immediately.
 */
async function withoutVscodeProperty<T>(
  propertyName: "LanguageModelTextPart" | "LanguageModelToolCallPart" | "LanguageModelToolResultPart",
  fn: () => Promise<T> | T
): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rawVscode = require("vscode") as Record<string, unknown>;
  const original = rawVscode[propertyName];
  delete rawVscode[propertyName];
  try {
    return await fn();
  } finally {
    rawVscode[propertyName] = original;
  }
}

void describe("vscodeLmCompat", () => {
  void it("reports the host as supported when every constructor and lm.selectChatModels is present", () => {
    const result = probeLmToolCallingHostCapabilityV1(vscode);
    assert.deepEqual(result, { supported: true });
  });

  void it("fails closed, naming what's missing, when LanguageModelToolCallPart is absent", async () => {
    await withoutVscodeProperty("LanguageModelToolCallPart", () => {
      const result = probeLmToolCallingHostCapabilityV1(vscode);
      assert.equal(result.supported, false);
      if (!result.supported) {
        assert.match(result.reason, /LanguageModelToolCallPart/);
      }
    });
  });

  void it("fails closed, naming what's missing, when LanguageModelTextPart is absent", async () => {
    await withoutVscodeProperty("LanguageModelTextPart", () => {
      const result = probeLmToolCallingHostCapabilityV1(vscode);
      assert.equal(result.supported, false);
      if (!result.supported) {
        assert.match(result.reason, /LanguageModelTextPart/);
      }
    });
  });

  void it("fails closed, naming what's missing, when LanguageModelToolResultPart is absent", async () => {
    await withoutVscodeProperty("LanguageModelToolResultPart", () => {
      const result = probeLmToolCallingHostCapabilityV1(vscode);
      assert.equal(result.supported, false);
      if (!result.supported) {
        assert.match(result.reason, /LanguageModelToolResultPart/);
      }
    });
  });

  void it("reports every missing constructor at once", async () => {
    await withoutVscodeProperty("LanguageModelTextPart", async () => {
      await withoutVscodeProperty("LanguageModelToolCallPart", () => {
        const result = probeLmToolCallingHostCapabilityV1(vscode);
        assert.equal(result.supported, false);
        if (!result.supported) {
          assert.match(result.reason, /LanguageModelTextPart/);
          assert.match(result.reason, /LanguageModelToolCallPart/);
        }
      });
    });
  });

  void it("isLmTextPartV1 recognizes a real LanguageModelTextPart instance", () => {
    const part = new lmClasses.LanguageModelTextPart("hello");
    assert.equal(isLmTextPartV1(vscode, part), true);
    assert.equal(isLmToolCallPartV1(vscode, part), false);
  });

  void it("isLmTextPartV1 never throws when the constructor is absent, and returns false", async () => {
    await withoutVscodeProperty("LanguageModelTextPart", () => {
      assert.doesNotThrow(() => isLmTextPartV1(vscode, { value: "hello" }));
      assert.equal(isLmTextPartV1(vscode, { value: "hello" }), false);
    });
  });

  void it("isLmToolCallPartV1 recognizes a real LanguageModelToolCallPart instance", () => {
    const part = new lmClasses.LanguageModelToolCallPart("call-1", "read_file", { path: "a.ts" });
    assert.equal(isLmToolCallPartV1(vscode, part), true);
    assert.equal(isLmTextPartV1(vscode, part), false);
  });

  void it("isLmToolCallPartV1 never throws when the constructor is absent, and returns false", async () => {
    await withoutVscodeProperty("LanguageModelToolCallPart", () => {
      const fakePart = { callId: "call-1", name: "read_file", input: {} };
      assert.doesNotThrow(() => isLmToolCallPartV1(vscode, fakePart));
      assert.equal(isLmToolCallPartV1(vscode, fakePart), false);
    });
  });

  void it("toNeutralToolCallV1 extracts callId/name/input from a real tool-call part", () => {
    const part = new lmClasses.LanguageModelToolCallPart("call-42", "write_file", {
      path: "a.ts",
      content: "x",
    });
    const neutral = toNeutralToolCallV1(part);
    assert.deepEqual(neutral, {
      kind: "toolCall",
      callId: "call-42",
      name: "write_file",
      input: { path: "a.ts", content: "x" },
    });
  });

  void it("toNeutralToolCallV1 degrades safely instead of throwing on a malformed value", () => {
    const neutral = toNeutralToolCallV1({});
    assert.deepEqual(neutral, { kind: "toolCall", callId: "", name: "", input: {} });
  });

  void it("createLmTextPartV1 builds a real LanguageModelTextPart with the given value", () => {
    const part = createLmTextPartV1(vscode, "some text");
    assert.ok(part instanceof lmClasses.LanguageModelTextPart);
    assert.equal(part.value, "some text");
  });

  void it("createLmToolResultPartV1 builds a real LanguageModelToolResultPart wrapping the text", () => {
    const part = createLmToolResultPartV1(vscode, "call-7", "the result");
    assert.ok(part instanceof lmClasses.LanguageModelToolResultPart);
    assert.equal(part.callId, "call-7");
    assert.equal(part.content.length, 1);
    const [content] = part.content;
    assert.ok(content instanceof lmClasses.LanguageModelTextPart);
    assert.equal(content.value, "the result");
  });

  void it("attachLmToolsV1 attaches tools to a neutral request-options object without dropping modelOptions", () => {
    const attached = attachLmToolsV1(
      { modelOptions: { model_reasoning_effort: "high" } },
      [{ name: "read_file", description: "reads a file" }]
    );
    assert.deepEqual(attached, {
      modelOptions: { model_reasoning_effort: "high" },
      tools: [{ name: "read_file", description: "reads a file" }],
    });
  });

  void it("iterateLmResponsePartsV1 yields neutral text and tool-call parts, alongside the raw instance", async () => {
    const textPart = new lmClasses.LanguageModelTextPart("hello ");
    const toolCallPart = new lmClasses.LanguageModelToolCallPart("call-1", "read_file", { path: "a.ts" });
    async function* stream() {
      await Promise.resolve();
      yield textPart;
      yield toolCallPart;
    }
    const parts: unknown[] = [];
    const raws: unknown[] = [];
    for await (const { part, raw } of iterateLmResponsePartsV1(vscode, { stream: stream() })) {
      parts.push(part);
      raws.push(raw);
    }
    assert.deepEqual(parts, [
      { kind: "text", value: "hello " },
      { kind: "toolCall", callId: "call-1", name: "read_file", input: { path: "a.ts" } },
    ]);
    assert.equal(raws[0], textPart);
    assert.equal(raws[1], toolCallPart);
  });

  void it("iterateLmResponsePartsV1 silently skips a stream part that is neither a recognized text nor tool-call part", async () => {
    async function* stream() {
      await Promise.resolve();
      yield { unrecognized: true };
    }
    const parts: unknown[] = [];
    for await (const { part } of iterateLmResponsePartsV1(vscode, { stream: stream() })) {
      parts.push(part);
    }
    assert.deepEqual(parts, []);
  });
});
