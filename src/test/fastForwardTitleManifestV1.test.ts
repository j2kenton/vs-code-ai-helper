import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

interface ManifestEntry {
  command: string;
  title?: string;
  key?: string;
}

interface Manifest {
  contributes: {
    commands: ManifestEntry[];
    keybindings: ManifestEntry[];
  };
}

const ROOT = path.join(__dirname, "..", "..");
const OLD_NAME = "Fast Forward " + "Fixes";

function readManifestText(): string {
  return fs.readFileSync(path.join(ROOT, "package.json"), "utf8");
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "test") {
        out.push(...listSourceFiles(full));
      }
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

void describe("Fast Forward title — package.json manifest (RC4 item 2)", () => {
  void it("titles the button exactly, with no bracketed shortcut", () => {
    const manifest = JSON.parse(readManifestText()) as Manifest;
    const button = manifest.contributes.commands.find(
      (c) => c.command === "vs-code-ai-helper.fastForwardReviewWithAI"
    );
    assert.equal(button?.title, "Fast Forward (iteratively fix and review until done)");
    assert.ok(!button?.title?.includes("["));
  });

  void it("keeps the keybinding on fastForwardCurrentTaskReview", () => {
    const manifest = JSON.parse(readManifestText()) as Manifest;
    const binding = manifest.contributes.keybindings.find((k) => k.key === "ctrl+shift+alt+f");
    assert.equal(binding?.command, "vs-code-ai-helper.fastForwardCurrentTaskReview");
  });

  void it("has no remaining user-facing 'Fast Forward Fixes' text", () => {
    assert.ok(!readManifestText().includes(OLD_NAME));
    const offenders = listSourceFiles(path.join(ROOT, "src")).filter((file) =>
      fs.readFileSync(file, "utf8").includes(OLD_NAME)
    );
    assert.deepEqual(offenders, []);
  });
});
