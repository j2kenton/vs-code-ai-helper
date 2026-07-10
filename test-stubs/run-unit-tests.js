"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function discoverUnitTests(root = path.join(__dirname, "..", "out", "test")) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory()
      ? discoverUnitTests(path.join(root, entry.name))
      : entry.isFile() && entry.name.endsWith(".test.js") ? [path.join(root, entry.name)] : [])
    .sort((a, b) => a.localeCompare(b));
}

if (require.main === module) {
  const result = spawnSync(process.execPath, ["--require", "./test-stubs/register.js", "--test", ...discoverUnitTests()], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

module.exports = { discoverUnitTests };
