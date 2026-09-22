import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

interface ManifestEntry {
  command: string;
  title?: string;
  key?: string;
  when?: string;
  group?: string;
}

interface Manifest {
  contributes: {
    commands: ManifestEntry[];
    keybindings: ManifestEntry[];
    menus: Record<string, ManifestEntry[]>;
  };
}

function readManifest(): Manifest {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")) as Manifest;
}

const COMMIT_PUSH = "vs-code-ai-helper.commitAndPushTask";
const COMMIT_PUSH_INLINE = "vs-code-ai-helper.commitAndPushTaskInline";

void describe("Commit and Push tooltip — package.json manifest", () => {
  void it("titles the command exactly 'Commit and Push', with no bracketed shortcut", () => {
    const { commands } = readManifest().contributes;
    const main = commands.find((c) => c.command === COMMIT_PUSH);
    assert.equal(main?.title, "Commit and Push");
    assert.ok(!main?.title?.includes("["));
    assert.equal(commands.find((c) => c.command === COMMIT_PUSH_INLINE)?.title, "Commit and Push");
  });

  void it("points the Publish row's inline button at the keybinding-free alias", () => {
    const inline = readManifest().contributes.menus["view/item/context"]!.filter(
      (entry) => entry.group === "inline@50" && (entry.when ?? "").includes("stage-publish-current")
    );
    assert.equal(inline.length, 1);
    assert.equal(inline[0]!.command, COMMIT_PUSH_INLINE);
  });

  void it("keeps ctrl+shift+alt+p on commitAndPushTask and gives the alias no keybinding", () => {
    const { keybindings } = readManifest().contributes;
    const shortcut = keybindings.find((k) => k.key === "ctrl+shift+alt+p");
    assert.equal(shortcut?.command, COMMIT_PUSH);
    assert.ok(!keybindings.some((k) => k.command === COMMIT_PUSH_INLINE));
  });

  void it("hides the alias from the Command Palette so only one 'Commit and Push' entry appears", () => {
    const palette = readManifest().contributes.menus["commandPalette"]!;
    const hidden = palette.find((entry) => entry.command === COMMIT_PUSH_INLINE);
    assert.equal(hidden?.when, "false");
  });
});
