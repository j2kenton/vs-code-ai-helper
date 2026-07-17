import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@vscode/test-cli";

// A real (empty) folder to open as the workspace: the extension's activation
// path expects a workspace folder to scan for tasks, and the host suite
// asserts activation succeeds rather than merely not crashing.
const workspaceFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".vscode-test",
  "host-workspace"
);
mkdirSync(workspaceFolder, { recursive: true });

export default defineConfig({
  label: "hostSmoke",
  // Compiled by tsconfig.test.json alongside the unit tests, but into a
  // sibling directory the stub-based unit runner (test-stubs/
  // run-unit-tests.js, which scans only out/test) never picks up — these
  // files import the REAL vscode API provided by the extension host.
  files: "out/test-host/**/*.test.js",
  workspaceFolder,
  mocha: { timeout: 60000 },
});
