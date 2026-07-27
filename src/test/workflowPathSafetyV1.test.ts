/**
 * Coverage for the §1.8 path-safety layer: locator validation, root
 * classification, containment, and the reparse-component walk that mutation
 * revalidates immediately before touching the filesystem.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  checkNoReparseComponentsV1,
  classifyWorkflowRootV1,
  resolveWorkflowFsPathV1,
  validateWorkflowRelativePathV1,
  WorkflowRootV1,
} from "../services/workflowPathSafetyV1";

function makeRoot(fsPath: string): WorkflowRootV1 {
  return { rootId: "test-root", fsPath, trustedForMutation: true };
}

void describe("workflowPathSafetyV1", () => {
  void it("classifies absolute local roots as supported", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-path-safety-"));
    try {
      assert.equal(classifyWorkflowRootV1(tmp).ok, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  void it("rejects relative, empty, and UNC roots", () => {
    assert.equal(classifyWorkflowRootV1("").ok, false);
    assert.equal(classifyWorkflowRootV1("relative/dir").ok, false);
    assert.equal(classifyWorkflowRootV1("\\\\server\\share").ok, false);
    assert.equal(classifyWorkflowRootV1("//server/share").ok, false);
  });

  void it("accepts well-formed forward-slash locators", () => {
    const ok = validateWorkflowRelativePathV1("a/b/c-file.json");
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.deepEqual([...ok.segments], ["a", "b", "c-file.json"]);
    }
    assert.equal(validateWorkflowRelativePathV1("file with spaces.md").ok, true);
  });

  void it("rejects traversal, absolute, backslash, and malformed locators", () => {
    const rejected = [
      "",
      "/leading-slash",
      "trailing-slash/",
      "a//doubled",
      "..",
      "a/../b",
      "./a",
      "a/./b",
      "a\\b",
      "c:/windows-drive",
      "a:b",
      "a/b./trailing-dot./x",
      "ends-with-dot.",
      "ends-with-space ",
      "a/".repeat(600) + "deep",
    ];
    for (const candidate of rejected) {
      assert.equal(
        validateWorkflowRelativePathV1(candidate).ok,
        false,
        `expected rejection: ${JSON.stringify(candidate)}`
      );
    }
  });

  void it("rejects reserved Windows device names in any segment", () => {
    for (const candidate of ["CON", "con", "nul.txt", "a/COM1", "a/lpt9.log/b", "PRN.md"]) {
      assert.equal(
        validateWorkflowRelativePathV1(candidate).ok,
        false,
        `expected rejection: ${JSON.stringify(candidate)}`
      );
    }
    // Similar-looking but NOT reserved.
    for (const candidate of ["CONSOLE.md", "com10.txt", "nullable.ts", "printer"]) {
      assert.equal(
        validateWorkflowRelativePathV1(candidate).ok,
        true,
        `expected acceptance: ${JSON.stringify(candidate)}`
      );
    }
  });

  void it("resolves contained paths and refuses escapes", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-path-safety-"));
    try {
      const root = makeRoot(tmp);
      const resolved = resolveWorkflowFsPathV1(root, "sub/file.txt");
      assert.equal(resolved.ok, true);
      if (resolved.ok) {
        assert.equal(resolved.fsPath, path.join(tmp, "sub", "file.txt"));
      }
      assert.equal(resolveWorkflowFsPathV1(root, "../outside.txt").ok, false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  void it("passes plain directories and missing tails, rejects link components", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-path-safety-"));
    try {
      const root = makeRoot(tmp);
      fs.mkdirSync(path.join(tmp, "real"));
      assert.deepEqual(await checkNoReparseComponentsV1(root, ["real"]), { safe: true });
      // Missing tail: creation targets do not exist yet.
      assert.deepEqual(
        await checkNoReparseComponentsV1(root, ["real", "not-yet", "created.txt"]),
        { safe: true }
      );

      // A junction (Windows, no admin needed) or symlink (elsewhere) in the
      // chain must be rejected.
      const linkPath = path.join(tmp, "linked");
      const linkType = process.platform === "win32" ? "junction" : "dir";
      fs.symlinkSync(path.join(tmp, "real"), linkPath, linkType);
      const viaLink = await checkNoReparseComponentsV1(root, ["linked"]);
      assert.equal(viaLink.safe, false);
      const belowLink = await checkNoReparseComponentsV1(root, ["linked", "file.txt"]);
      assert.equal(belowLink.safe, false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
