/**
 * Regression coverage for the host tool-name charset (§7.2).
 *
 * GitHub Copilot Chat does not reject a tool name it dislikes — it silently
 * rewrites it, `name.replace(/[^a-zA-Z0-9_-]/gu, "_")`, on the way to the
 * model. The tools shipped as `ensemble.readFile` and friends, so the model
 * was offered `ensemble_readFile`, called it back under that name, and
 * `handleToolCall` — matching the inbound name against the DOTTED roster —
 * sent every single call down the `unknownTool` branch. No Copilot tool
 * session could read a file, and nothing in our own logs showed the
 * mismatch, because the name we recorded was always the one we declared.
 *
 * These assertions exist so the charset is a test failure rather than a
 * silent renaming the next time a tool is added.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EDIT_TOOL_NAMES_V1,
  READ_TOOL_NAMES_V1,
  editToolDescriptorsV1,
  readToolDescriptorsV1,
} from "../types/workflowToolProtocolV1";

/** The host's own accepted charset, copied from Copilot Chat's validator. */
const HOST_CHARSET = /^[a-zA-Z0-9_-]+$/u;
/** The host's own rewrite, copied from Copilot Chat's sanitizer. */
const hostRewrite = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/gu, "_");

void describe("LM tool names survive the host boundary unchanged", () => {
  void it("declares every read and edit tool in the host charset", () => {
    for (const name of [...READ_TOOL_NAMES_V1, ...EDIT_TOOL_NAMES_V1]) {
      assert.ok(HOST_CHARSET.test(name), `tool name "${name}" is outside the host charset`);
    }
  });

  void it("is unchanged by the host's own rewrite", () => {
    // The property that actually matters: declared name === returned name.
    for (const descriptor of [...readToolDescriptorsV1(), ...editToolDescriptorsV1()]) {
      assert.equal(
        hostRewrite(descriptor.name),
        descriptor.name,
        `the host would rewrite "${descriptor.name}" to "${hostRewrite(descriptor.name)}"`
      );
    }
  });

  void it("keeps the roster and the descriptors naming the same tools", () => {
    // A rename that touched only one of the two would resurrect the same
    // class of bug: a roster the handler matches against that no longer
    // corresponds to what the model was offered.
    assert.deepEqual(
      readToolDescriptorsV1().map((d) => d.name),
      [...READ_TOOL_NAMES_V1]
    );
    assert.deepEqual(
      editToolDescriptorsV1().map((d) => d.name),
      [...EDIT_TOOL_NAMES_V1]
    );
  });
});
