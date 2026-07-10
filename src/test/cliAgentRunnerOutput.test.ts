import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { __testOnly } from "../runners/cliAgentRunner";
import { getCliProvider } from "../runners/providers";

void describe("CLI output normalization", () => {
  void it("extracts Kiro's final review text from a streamed transcript", () => {
    const transcript = [
      "\u001b[38;5;141m>\u001b[0m",
      "",
      "I'll analyze the implementation against the plan requirements.",
      "Batch fs_read operation with 3 operations",
      "Successfully read package.json",
      "I will run the following command: pnpm run test:unit",
      "",
      "Based on my analysis of the implementation files, here's my low-level review:",
      "",
      "## Summary Verdict",
      "",
      "Ready to complete.",
    ].join("\n");

    assert.strictEqual(
      __testOnly.extractKiroFinalOutput(transcript),
      [
        "Based on my analysis of the implementation files, here's my low-level review:",
        "",
        "## Summary Verdict",
        "",
        "Ready to complete.",
      ].join("\n")
    );
  });

  void it("loads Kiro's linked markdown artifact when stdout points to a file URI", () => {
    const tempFile = path.join(
      "/tmp",
      `vs-code-ai-helper-kiro-output-${Date.now()}.md`
    );
    fs.writeFileSync(tempFile, "# Review\n\nOn Track\n", "utf8");

    try {
      const stdout = [
        "I have completed a high-level review of the implementation.",
        "",
        `Please refer to the generated [high_level_review.md](${pathToFileURL(tempFile).toString()}) artifact for the full evaluation.`,
      ].join("\n");

      assert.strictEqual(
        __testOnly.extractKiroFinalOutput(stdout),
        "# Review\n\nOn Track"
      );
    } finally {
      fs.unlinkSync(tempFile);
    }
  });

  void it("normalizes Kiro output via provider-specific extraction", () => {
    const kiro = getCliProvider("kiro-cli");
    assert.ok(kiro, "expected kiro-cli provider definition");

    const output = __testOnly.normalizeCliOutput(
      kiro,
      "\u001b[0m## Summary Verdict\u001b[0m\n\nNeeds changes.\n",
      undefined
    );

    assert.strictEqual(output, "## Summary Verdict\n\nNeeds changes.");
  });

  void it("fails CLI implementation runs that report completion without file changes", () => {
    const codex = getCliProvider("codex-cli");
    assert.ok(codex, "expected codex-cli provider definition");

    const result = __testOnly.toCliImplementationRunResult(
      codex,
      {
        status: "completed",
        output: "Implemented the requested changes.",
      },
      [],
      false
    );

    assert.strictEqual(result.status, "failed");
    assert.match(result.errorMessage ?? "", /did not modify any workspace files/);
    assert.match(result.errorMessage ?? "", /Provider output:/);
  });
});
