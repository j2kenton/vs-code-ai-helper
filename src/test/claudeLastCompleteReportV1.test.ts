/**
 * bugs4 item 23 / Step 22: a complete summary followed by a short reply to a background-task
 * notification is still the round's report. A stream with no summary at all is unchanged.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { __testOnly } from "../runners/cliAgentRunner";

const { extractClaudeCliFinalOutput } = __testOnly;

const SUMMARY = [
  "Covered the three items.",
  "",
  "## Files Changed",
  "",
  "- none",
  "",
  "## Verification",
  "",
  "- `pnpm run test:unit -- src/test/a.test.ts`: 3 passed, 0 failed",
].join("\n");

function assistant(text: string): string {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
}

void describe("Claude Code report selection (bugs4 item 23)", () => {
  void it("keeps the full summary when a short notification reply follows it", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init" }),
      assistant("Running the tests now."),
      assistant(SUMMARY),
      assistant("That last notification is the monitor for the test run I already reported. The summary above is final."),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ].join("\n");
    assert.equal(extractClaudeCliFinalOutput(stdout), SUMMARY);
  });

  void it("takes the last message when it is itself the complete summary", () => {
    const stdout = [assistant(SUMMARY), assistant(`${SUMMARY}\n\nAddendum.`)].join("\n");
    assert.ok(extractClaudeCliFinalOutput(stdout).endsWith("Addendum."));
  });

  void it("with no complete summary anywhere, the final message still wins (cut short stays cut short)", () => {
    const stdout = [assistant("Working on it."), assistant("Stopping here.")].join("\n");
    assert.equal(extractClaudeCliFinalOutput(stdout), "Stopping here.");
  });

  void it("a message that only mentions the headings in prose is not a summary", () => {
    const stdout = [assistant(SUMMARY), assistant("I will write ## Files Changed and ## Verification later.")].join("\n");
    assert.equal(extractClaudeCliFinalOutput(stdout), SUMMARY);
  });
});
