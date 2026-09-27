#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32", ...options });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
  }
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: process.platform === "win32", ...options });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${command} ${args.join(" ")} exited ${result.status}`);
  }
  return result.stdout.trim();
}

function commandExists(command) {
  const probe = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(probe, [command], { stdio: "ignore" });
  return result.status === 0;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: node scripts/install-local.mjs");
  console.log("Packages the current working tree as a VSIX and installs it with code --install-extension --force.");
  process.exit(0);
}

const repoRoot = capture("git", ["rev-parse", "--show-toplevel"]);
process.chdir(repoRoot);

if (!commandExists("code")) {
  throw new Error("The 'code' CLI is not on PATH. In VS Code run: Shell Command: Install 'code' command in PATH.");
}

const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const name = String(packageJson.name ?? "");
const version = String(packageJson.version ?? "");
if (!name || !version) {
  throw new Error("package.json is missing 'name' or 'version'.");
}
const vsixPath = path.join(repoRoot, `${name}-${version}.vsix`);

const dirty = capture("git", ["status", "--porcelain"]);
if (dirty) {
  const count = dirty.split(/\r?\n/).filter(Boolean).length;
  console.log(`Packaging working tree with ${count} uncommitted change(s) - that is the point of this script.`);
}

console.log("");
console.log(`Packaging ${name} ${version} ...`);
console.log("(runs check-types, lint, esbuild --production and verify:workflow-safety)");
run("npm", ["run", "vsix"]);

if (!fs.existsSync(vsixPath)) {
  throw new Error(`Packaging reported success but ${vsixPath} was not produced.`);
}

const sizeMb = Math.round((fs.statSync(vsixPath).size / 1024 / 1024) * 100) / 100;
console.log("");
console.log(`Installing ${path.basename(vsixPath)} (${sizeMb} MB) ...`);
run("code", ["--install-extension", vsixPath, "--force"]);

console.log("");
console.log(`Installed ${name} ${version} from the local working tree.`);
console.log("Reload the window for it to take effect: Developer: Reload Window.");