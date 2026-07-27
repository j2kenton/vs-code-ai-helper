/**
 * Positive fixture for the path-consumer extractor
 * (scripts/generateWorkflowPathConsumers.mjs self-test): must be detected
 * with signals ["import:child_process", "import:fs", "workspace.fs"].
 * Not compiled by any tsconfig — parsed only by the extractor's TS AST walk.
 */
import * as fs from "fs";
import { spawn } from "node:child_process";

declare const vscode: { workspace: { fs: { readFile(uri: unknown): Thenable<Uint8Array> } } };

export function fixtureConsumer(p: string): void {
  fs.existsSync(p);
  spawn("git", ["status"]);
  void vscode.workspace.fs.readFile(p);
}
