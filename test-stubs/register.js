"use strict";
// Preload hook for `node --test -r ./test-stubs/register.js`: makes
// require("vscode") resolve to the stub in test-stubs/vscode, so files that
// import vscode can be loaded under plain Node (outside the extension host)
// by test:unit. See test-stubs/vscode/index.js for what's implemented.

const path = require("node:path");
const Module = require("node:module");

const stubPath = path.join(__dirname, "vscode", "index.js");
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") {
    return stubPath;
  }
  return originalResolveFilename.call(this, request, ...rest);
};
