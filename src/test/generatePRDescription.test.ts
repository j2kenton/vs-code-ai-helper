/**
 * Coverage for generatePRDescription's two Testing-section sources:
 *
 *  - The run-owned region of the implementation summary (## Testing, else
 *    ## Verification) passes through UNLABELLED — that text is the run
 *    reporting what it actually verified.
 *  - The low-level plan's own `## Testing` fallback is labelled as PLANNED
 *    testing. The plan predates every run, so presenting its text under the
 *    PR's "Testing" heading unadorned described planned work as delivered —
 *    the same failure shape that retired the PR overview extraction.
 *
 * The run-owned case asserts the full PR text byte-for-byte, pinning the
 * "byte-identical to before the label existed" acceptance criterion.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  generatePRDescription,
  PR_TESTING_PLANNED_FALLBACK_LABEL_V1,
} from "../commands/commitAndPushTask";
import { safeRemoveDir } from "./testFsUtils";

const ROOT = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ensemble-pr-desc-"));
after(() => {
  safeRemoveDir(ROOT);
});

/** Back the stub's notImplemented workspace.fs.readFile with the real fs. */
function installReadFileStub(): () => void {
  const fsRecord = vscode.workspace.fs as unknown as Record<string, unknown>;
  const original = fsRecord.readFile;
  fsRecord.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    nodeFs.promises.readFile(uri.fsPath) as Promise<Uint8Array>;
  return (): void => {
    fsRecord.readFile = original;
  };
}

const TASK_MD = [
  "# My Task",
  "",
  "## Task Description",
  "",
  "Build the thing.",
  "",
].join("\n");

function makeTaskFolder(name: string, files: Record<string, string>): string {
  const folder = nodePath.join(ROOT, name);
  nodeFs.mkdirSync(folder, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    nodeFs.writeFileSync(nodePath.join(folder, file), content, "utf8");
  }
  return folder;
}


void describe("generatePRDescription — Testing section provenance", () => {
  void it("passes a run-owned testing section through unlabelled (byte-identical to pre-label output)", async () => {
    const folder = makeTaskFolder("run-owned", {
      "task.md": TASK_MD,
      "impl-summary.md": [
        "<!-- ensemble:implementation-checklist -->",
        "",
        "- [x] Item one",
        "",
        "## Files Changed",
        "",
        "- src/foo.ts",
        "",
        "## Verification",
        "",
        "Ran pnpm test:unit — all green.",
        "",
      ].join("\n"),
      "plan-low.md": [
        "# Low-level plan",
        "",
        "## Testing",
        "",
        "This planned section must not be used.",
        "",
      ].join("\n"),
    });
    const restore = installReadFileStub();
    try {
      const pr = await generatePRDescription(folder, "run-owned", ["src/foo.ts"]);
      assert.strictEqual(
        pr,
        [
          "# My Task",
          "",
          "## Summary",
          "",
          "Build the thing.",
          "",
          "## Implementation",
          "",
          "- src/foo.ts",
          "",
          "## Testing",
          "",
          "Ran pnpm test:unit — all green.",
          "",
          "## Changed Files",
          "",
          "- src/foo.ts",
          "",
        ].join("\n")
      );
      assert.ok(
        !pr.includes(PR_TESTING_PLANNED_FALLBACK_LABEL_V1),
        "run-owned testing text must never carry the planned-testing label"
      );
      assert.ok(
        !pr.includes("This planned section must not be used."),
        "the plan's own Testing section must not leak into a run-owned PR"
      );
    } finally {
      restore();
    }
  });

  void it("labels the low-level plan's Testing fallback as planned, not verified", async () => {
    const folder = makeTaskFolder("planned-fallback", {
      "task.md": TASK_MD,
      "plan-low.md": [
        "# Low-level plan",
        "",
        "## Testing",
        "",
        "Run the full suite before merging.",
        "",
      ].join("\n"),
    });
    const restore = installReadFileStub();
    try {
      const pr = await generatePRDescription(folder, "planned-fallback", ["src/foo.ts"]);
      assert.strictEqual(
        pr,
        [
          "# My Task",
          "",
          "## Summary",
          "",
          "Build the thing.",
          "",
          "## Implementation",
          "",
          "Implementation summary not available.",
          "",
          "## Testing",
          "",
          PR_TESTING_PLANNED_FALLBACK_LABEL_V1,
          "Run the full suite before merging.",
          "",
          "## Changed Files",
          "",
          "- src/foo.ts",
          "",
        ].join("\n")
      );
    } finally {
      restore();
    }
  });

  void it("labels the fallback even when an echo-only summary left no run-owned region", async () => {
    // An echo-only response (no `## Files Changed` boundary) splits to an
    // empty run-owned region, so the plan fallback fires — the echoed plan
    // checklist must not read as the run's own verification.
    const folder = makeTaskFolder("echo-only", {
      "task.md": TASK_MD,
      "impl-summary.md": [
        "<!-- ensemble:implementation-checklist -->",
        "",
        "- [x] Item one",
        "",
      ].join("\n"),
      "plan-low.md": [
        "# Low-level plan",
        "",
        "## Testing",
        "",
        "Run the full suite before merging.",
        "",
      ].join("\n"),
    });
    const restore = installReadFileStub();
    try {
      const pr = await generatePRDescription(folder, "echo-only", []);
      assert.ok(
        pr.includes(`${PR_TESTING_PLANNED_FALLBACK_LABEL_V1}\nRun the full suite before merging.`),
        "the plan fallback must be labelled as planned testing"
      );
    } finally {
      restore();
    }
  });
});

