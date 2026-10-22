import * as fs from "node:fs";
import * as path from "node:path";

/** Give integration tests an extension root containing the real shipped prompts. */
export function copyPromptResources(extensionRoot: string): void {
  let repoRoot = __dirname;
  while (!fs.existsSync(path.join(repoRoot, "resources", "prompts"))) {
    const parent = path.dirname(repoRoot);
    if (parent === repoRoot) {
      throw new Error("Could not locate resources/prompts for test fixture");
    }
    repoRoot = parent;
  }
  fs.cpSync(path.join(repoRoot, "resources", "prompts"), path.join(extensionRoot, "resources", "prompts"), {
    recursive: true,
  });
}
